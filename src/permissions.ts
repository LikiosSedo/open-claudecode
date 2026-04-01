/**
 * Permission System
 *
 * Simplified from Claude Code's multi-layer permission architecture.
 * Three modes:
 *   - bypass: all operations allowed (like --dangerously-skip-permissions)
 *   - ask: all non-read-only operations require confirmation
 *   - auto (default): smart per-tool policy with bash command analysis
 *
 * Persistent rules: "always allow" rules are stored in ~/.occ/permissions.json
 * so users don't re-approve the same operations every session.
 */

import type { PermissionDecision } from './tools/types.js'
import { validateBashCommand } from './bash-security.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

// -- Persistent Permission Rules --

export interface PermissionRule {
  toolName: string       // "Bash" or "mcp__github__search"
  pattern?: string       // optional glob pattern, e.g. "git *" or "npm *"
  behavior: 'allow' | 'deny'
}

interface PermissionRulesFile {
  rules: PermissionRule[]
}

const RULES_PATH = join(homedir(), '.occ', 'permissions.json')

/** Simple glob match: `*` matches any sequence of characters. */
function globMatch(pattern: string, text: string): boolean {
  // Escape regex special chars except *, then convert * to .*
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  )
  return regex.test(text)
}

// -- Permission Modes --

export type PermissionMode = 'auto' | 'ask' | 'bypass'

// -- Bash Command Safety Analysis --

/** Commands that are safe to run without confirmation */
const SAFE_COMMANDS = new Set([
  // filesystem reads
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq',
  'file', 'stat', 'du', 'df', 'readlink', 'realpath', 'basename', 'dirname',
  // search
  'grep', 'rg', 'fd', 'find', 'which', 'type', 'whereis',
  // text processing (read-only)
  'echo', 'printf', 'diff', 'comm', 'tr', 'cut', 'paste', 'column',
  'sed', 'awk', // typically used for reading; destructive use requires -i which is rare in agent context
  // git (read + safe writes)
  'git',
  // dev tools
  'node', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno',
  'python', 'python3', 'pip', 'pip3',
  'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha',
  'cargo', 'go', 'make', 'cmake', 'rustc', 'gcc', 'g++', 'javac', 'java',
  // network reads
  'curl', 'wget',
  // data tools
  'jq', 'yq', 'xargs',
  // system info
  'date', 'env', 'printenv', 'uname', 'hostname', 'whoami', 'id',
  'ps', 'top', 'htop', 'free', 'uptime',
  // misc safe
  'true', 'false', 'test', '[', 'seq', 'yes', 'timeout', 'time',
])

/** Commands that always require confirmation */
const DANGEROUS_COMMANDS = new Set([
  // destructive filesystem
  'rm', 'rmdir', 'shred',
  // move/rename (can overwrite)
  'mv',
  // privilege escalation
  'sudo', 'su', 'doas',
  // permissions
  'chmod', 'chown', 'chgrp',
  // process control
  'kill', 'killall', 'pkill',
  // system
  'reboot', 'shutdown', 'halt', 'poweroff', 'systemctl',
  // disk
  'dd', 'mkfs', 'fdisk', 'mount', 'umount', 'parted',
  // containers (side effects)
  'docker', 'podman', 'kubectl', 'helm',
  // remote
  'ssh', 'scp', 'rsync',
  // package managers that install globally
  'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'brew',
])

/** Patterns that indicate dangerous operations regardless of base command */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: />\s*\//, reason: 'redirect to absolute path' },
  { pattern: /rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*\//, reason: 'rm on absolute path' },
  { pattern: /sudo\s/, reason: 'sudo command' },
  { pattern: /\|\s*sh\b/, reason: 'pipe to sh' },
  { pattern: /\|\s*bash\b/, reason: 'pipe to bash' },
  { pattern: /\|\s*zsh\b/, reason: 'pipe to zsh' },
  { pattern: /curl\s.*\|\s*(sh|bash|zsh)/, reason: 'curl piped to shell' },
  { pattern: /wget\s.*\|\s*(sh|bash|zsh)/, reason: 'wget piped to shell' },
  { pattern: /eval\s/, reason: 'eval command' },
  { pattern: /\bexec\s/, reason: 'exec command' },
  { pattern: />\s*\/dev\//, reason: 'write to /dev/' },
  { pattern: /:\s*>\s*\S/, reason: 'truncate file' },
]

/** Operators that chain multiple commands — we can't guarantee safety of each part */
const COMPOUND_OPERATORS = /[|&;]|&&|\|\|/

/**
 * Analyze a bash command and decide if it needs permission.
 * Returns allow if safe, ask with reason if not.
 *
 * Security analysis runs FIRST (before command categorization) to catch
 * injection vectors like control characters, command substitution, IFS
 * manipulation, etc. regardless of whether the base command is "safe".
 */
function analyzeBashCommand(command: string): PermissionDecision {
  const trimmed = command.trim()

  // SECURITY: Run deep security analysis BEFORE command categorization.
  // These checks catch injection vectors that bypass allowlist/denylist:
  // control chars, unicode whitespace, $(), ``, IFS, brace expansion, etc.
  const securityResult = validateBashCommand(trimmed)
  if (!securityResult.safe) {
    return { behavior: 'ask', message: securityResult.reason! }
  }

  // Check dangerous patterns (highest priority after security analysis)
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { behavior: 'ask', message: `Dangerous pattern detected: ${reason}` }
    }
  }

  // Check for compound commands — can't verify safety of each part
  if (COMPOUND_OPERATORS.test(trimmed)) {
    const parts = trimmed.split(/[|&;]+/).map(s => s.trim()).filter(Boolean)
    for (const part of parts) {
      const baseCmd = extractBaseCommand(part)
      if (baseCmd && DANGEROUS_COMMANDS.has(baseCmd)) {
        return { behavior: 'ask', message: `Compound command contains dangerous command: ${baseCmd}` }
      }
    }
    const allSafe = parts.every(part => {
      const baseCmd = extractBaseCommand(part)
      return baseCmd !== null && SAFE_COMMANDS.has(baseCmd)
    })
    if (allSafe) {
      return { behavior: 'allow' }
    }
    return { behavior: 'ask', message: 'Compound command — cannot verify safety of all parts' }
  }

  // Simple command — check base command
  const baseCmd = extractBaseCommand(trimmed)
  if (baseCmd === null) {
    return { behavior: 'ask', message: 'Could not determine base command' }
  }

  if (DANGEROUS_COMMANDS.has(baseCmd)) {
    return { behavior: 'ask', message: `Dangerous command: ${baseCmd}` }
  }

  if (SAFE_COMMANDS.has(baseCmd)) {
    return { behavior: 'allow' }
  }

  // Unknown command — ask to be safe
  return { behavior: 'ask', message: `Unknown command: ${baseCmd}` }
}

/**
 * Extract the base command name from a command string.
 * Handles env vars prefixes (FOO=bar cmd), path prefixes (/usr/bin/cmd), etc.
 */
function extractBaseCommand(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null

  // Skip leading environment variable assignments (KEY=VALUE ...)
  const withoutEnvVars = trimmed.replace(/^(\w+=\S*\s+)+/, '')

  // Get the first word
  const match = withoutEnvVars.match(/^(\S+)/)
  if (!match) return null

  const fullCmd = match[1]
  // Strip path prefix: /usr/bin/git → git
  const baseName = fullCmd.includes('/') ? fullCmd.split('/').pop()! : fullCmd
  return baseName || null
}

// -- Permission Manager --

export interface PermissionManagerOptions {
  mode: PermissionMode
  /** Callback to ask user for confirmation. Returns 'y' | 'a' | 'n' */
  askUser: (toolName: string, input: Record<string, unknown>, message: string) => Promise<'y' | 'a' | 'n'>
}

export class PermissionManager {
  private mode: PermissionMode
  private askUser: PermissionManagerOptions['askUser']
  private rules: PermissionRule[] = []

  constructor(options: PermissionManagerOptions) {
    this.mode = options.mode
    this.askUser = options.askUser
    this.rules = this.loadRules()
  }

  getMode(): PermissionMode {
    return this.mode
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  // -- Persistent rules --

  loadRules(): PermissionRule[] {
    try {
      const data = readFileSync(RULES_PATH, 'utf-8')
      const parsed = JSON.parse(data) as PermissionRulesFile
      return Array.isArray(parsed.rules) ? parsed.rules : []
    } catch {
      return []
    }
  }

  addRule(rule: PermissionRule): void {
    // Avoid duplicates
    const exists = this.rules.some(
      r => r.toolName === rule.toolName && r.pattern === rule.pattern && r.behavior === rule.behavior,
    )
    if (!exists) {
      this.rules.push(rule)
      this.saveRules()
    }
  }

  getRules(): PermissionRule[] {
    return [...this.rules]
  }

  private saveRules(): void {
    const dir = join(homedir(), '.occ')
    mkdirSync(dir, { recursive: true })
    const data: PermissionRulesFile = { rules: this.rules }
    writeFileSync(RULES_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  }

  /** Match a persistent rule against a tool invocation. */
  matchRule(toolName: string, input: Record<string, unknown>): PermissionRule | null {
    for (const rule of this.rules) {
      if (rule.toolName !== toolName) continue
      if (!rule.pattern) {
        // No pattern = matches all invocations of this tool
        return rule
      }
      // For Bash, match against the command
      if (toolName === 'Bash' && typeof input.command === 'string') {
        if (globMatch(rule.pattern, input.command)) return rule
      }
      // For file-based tools, match against file_path
      if (typeof input.file_path === 'string') {
        if (globMatch(rule.pattern, input.file_path)) return rule
      }
    }
    return null
  }

  /** Build a pattern string for the "always allow" rule from a tool invocation. */
  buildPattern(toolName: string, input: Record<string, unknown>): string | undefined {
    if (toolName === 'Bash' && typeof input.command === 'string') {
      // Use the first word (base command) + " *" as pattern
      const firstWord = input.command.trim().split(/\s+/)[0]
      return firstWord ? `${firstWord} *` : undefined
    }
    return undefined
  }

  /**
   * Check if a tool invocation should be allowed.
   * Checks persistent rules first, then falls back to askUser.
   */
  async check(toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> {
    // Check persistent rules before the built-in policy
    const matchedRule = this.matchRule(toolName, input)
    if (matchedRule) {
      if (matchedRule.behavior === 'allow') return { behavior: 'allow' }
      if (matchedRule.behavior === 'deny') return { behavior: 'deny', reason: `Denied by persistent rule` }
    }

    const decision = this.decide(toolName, input)

    if (decision.behavior !== 'ask') {
      return decision
    }

    // Ask user: y=once, a=always, n=deny
    const answer = await this.askUser(toolName, input, decision.message)
    if (answer === 'a') {
      const pattern = this.buildPattern(toolName, input)
      this.addRule({ toolName, pattern, behavior: 'allow' })
      return { behavior: 'allow' }
    }
    if (answer === 'y') {
      return { behavior: 'allow' }
    }
    return { behavior: 'deny', reason: `User denied: ${toolName}` }
  }

  /** Pure decision logic (no side effects). Visible for testing. */
  decide(toolName: string, input: Record<string, unknown>): PermissionDecision {
    // Bypass mode: everything allowed
    if (this.mode === 'bypass') {
      return { behavior: 'allow' }
    }

    // Read-only tools are always allowed
    const readOnlyTools = new Set(['Read', 'Glob', 'Grep'])
    if (readOnlyTools.has(toolName)) {
      return { behavior: 'allow' }
    }

    // Ask mode: all non-read-only tools need confirmation
    if (this.mode === 'ask') {
      return { behavior: 'ask', message: `${toolName} requires confirmation in ask mode` }
    }

    // Auto mode: per-tool policy
    switch (toolName) {
      case 'Write':
      case 'Edit':
        // File writes are relatively safe (no system-level side effects)
        return { behavior: 'allow' }

      case 'Bash': {
        const command = input.command
        if (typeof command !== 'string') {
          return { behavior: 'ask', message: 'Bash command is not a string' }
        }
        return analyzeBashCommand(command)
      }

      case 'Agent':
        return { behavior: 'allow' }  // Sub-agents inherit parent's permission policy

      case 'Memory':
        return { behavior: 'allow' }  // Memory save/list/delete are user-visible

      case 'ToolSearch':
        return { behavior: 'allow' }  // Read-only: just fetches tool schemas

      default: {
        // MCP tools: ask with descriptive message
        if (toolName.startsWith('mcp__')) {
          return { behavior: 'ask', message: `MCP tool: ${toolName}` }
        }
        // Unknown tool — ask to be safe
        return { behavior: 'ask', message: `Unknown tool: ${toolName}` }
      }
    }
  }
}
