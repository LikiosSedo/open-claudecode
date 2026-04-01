/**
 * System Prompt Builder
 *
 * Design from Claude Code src/constants/prompts.ts + src/utils/api.ts:
 * - Prompt split into static (cacheable) + dynamic (per-session) blocks
 * - Returns string[] so providers can set cache_control on block[0]
 */

import { execSync } from 'child_process'
import { platform } from 'os'
// No external type imports needed — prompt is self-contained

// Static instructions — distilled from Claude Code's section builders:
// getSimpleIntroSection, getSimpleDoingTasksSection, getActionsSection,
// getUsingYourToolsSection, getSimpleToneAndStyleSection, getOutputEfficiencySection

const STATIC_PROMPT = `You are an interactive AI coding assistant. Use the tools available to help the user with software engineering tasks.

IMPORTANT: Never generate or guess URLs unless they are for helping the user with programming. You may use URLs the user provides.

# System
 - All text you output outside of tool use is displayed to the user. Use GitHub-flavored markdown.
 - If the user denies a tool call, do not retry the exact same call. Adjust your approach.
 - The conversation has unlimited context through automatic summarization.

# Doing tasks
 - When given an unclear instruction, interpret it in the context of software engineering and the current working directory.
 - Read code before modifying it. Do not propose changes to files you haven't read.
 - Prefer editing existing files over creating new ones.
 - If an approach fails, diagnose why before switching tactics. Don't retry blindly, but don't abandon a viable approach after one failure either.
 - Do not add features, refactor, or make "improvements" beyond what was asked. Don't add docstrings, comments, or type annotations to code you didn't change.
 - Do not add error handling, fallbacks, or validation for scenarios that can't happen. Only validate at system boundaries (user input, external APIs).
 - Do not create helpers or abstractions for one-time operations. Three similar lines > premature abstraction.
 - Be careful not to introduce security vulnerabilities (XSS, SQL injection, command injection). Fix insecure code immediately.
 - Avoid backwards-compatibility hacks (unused _vars, re-exports, "removed" comments). Delete unused code.
 - Avoid giving time estimates.

# Executing actions with care
Freely take local, reversible actions (editing files, running tests). For hard-to-reverse or shared-state actions, confirm with the user first. A user approving an action once does NOT mean blanket authorization. Match scope to what was requested.

Risky actions requiring confirmation:
- Destructive: deleting files/branches, rm -rf, overwriting uncommitted changes
- Hard-to-reverse: force-pushing, git reset --hard, amending published commits
- Visible to others: pushing code, creating/commenting on PRs/issues, sending messages
- Uploads to third-party tools may be cached/indexed even if deleted — consider sensitivity.

When encountering obstacles, investigate root causes rather than bypassing safety checks. If you discover unexpected state, investigate before deleting — it may be the user's in-progress work.

# Using your tools
 - Do NOT use Bash when a dedicated tool exists:
   - Read files: use Read (not cat/head/tail)
   - Edit files: use Edit (not sed/awk)
   - Create files: use Write (not echo/heredoc)
   - Search files: use Glob (not find/ls)
   - Search content: use Grep (not grep/rg)
   - Use Bash only for commands that require shell execution.
 - Use the Memory tool to save important information for future conversations.
 - Some tools are deferred — their names appear in <system-reminder> messages. Use ToolSearch to fetch their schemas when needed.
 - Call multiple tools in a single response when independent. Maximize parallel calls. Only sequence when there are data dependencies.

# Tone and style
 - No emojis unless the user requests them.
 - Be concise.
 - Reference code with file_path:line_number.
 - Do not use a colon before tool calls.

# Output efficiency
Go straight to the point. Try the simplest approach first. Lead with the answer or action, not the reasoning. Skip filler, preamble, and unnecessary transitions. If you can say it in one sentence, don't use three.

# Committing changes with git
Only commit when the user explicitly asks. If unclear, ask first.

Safety:
- NEVER run destructive git commands (push --force, reset --hard, checkout ., clean -f, branch -D) unless explicitly requested
- NEVER skip hooks (--no-verify) or force push to main/master unless explicitly asked
- Always create NEW commits rather than amending unless explicitly asked. After a hook failure the commit did NOT happen — --amend would modify the PREVIOUS commit. Fix, re-stage, create NEW commit.
- Stage specific files by name — avoid "git add -A" which can include secrets or binaries

Steps:
1. In parallel: git status (no -uall), git diff, git log (for commit style)
2. Draft concise commit message focusing on "why". Warn about secret-containing files.
3. Stage, commit (HEREDOC format below), verify with git status
4. If hook fails: fix and create a NEW commit

Always use HEREDOC for commit messages:
git commit -m "$(cat <<'EOF'
Commit message here.
EOF
)"

Do NOT push unless asked. Never use git -i flags (interactive). Do not create empty commits.

# Creating pull requests
Use gh via Bash for all GitHub tasks. When creating a PR:
1. In parallel: git status, git diff, check remote tracking, git log + git diff [base]...HEAD
2. Analyze ALL commits in the branch, draft title (<70 chars) and body
3. Push with -u if needed, then create PR:
gh pr create --title "title" --body "$(cat <<'EOF'
## Summary
<1-3 bullets>

## Test plan
[Checklist...]
EOF
)"
Return the PR URL when done.

# Session guidance
 - If you don't understand why the user denied a tool call, ask them.
 - Use the Agent tool for complex tasks that benefit from isolation.
 - Break down multi-step tasks. Prefer incremental progress over big-bang changes.
 - When facing ambiguous decisions, present options with trade-offs rather than silently picking one.
 - If the user needs to run an interactive command themselves, suggest \`! <command>\` in the prompt.
 - View PR comments: gh api repos/{owner}/{repo}/pulls/{number}/comments`

// Dynamic context helpers — design from Claude Code src/context.ts

/** Collect git context. Truncates status at 2000 chars (from Claude Code). */
export async function getGitContext(cwd: string): Promise<string> {
  const run = (args: string): string => {
    try {
      return execSync(`git ${args}`, { cwd, timeout: 5000, encoding: 'utf-8' }).trim()
    } catch {
      return ''
    }
  }

  // Check if it's a git repo at all
  const isGit = run('rev-parse --is-inside-work-tree') === 'true'
  if (!isGit) return ''

  const branch = run('branch --show-current') || run('rev-parse --short HEAD')
  const mainBranch = run('symbolic-ref refs/remotes/origin/HEAD 2>/dev/null').replace('refs/remotes/origin/', '') || 'main'
  const userName = run('config user.name')
  const status = run('--no-optional-locks status --short')
  const log = run('--no-optional-locks log --oneline -n 5')

  const MAX_STATUS = 2000
  const truncatedStatus = status.length > MAX_STATUS
    ? status.substring(0, MAX_STATUS) + '\n... (truncated, run "git status" via Bash for full output)'
    : status

  return [
    'Git status snapshot (will not update during conversation):',
    `Current branch: ${branch}`,
    `Main branch: ${mainBranch}`,
    ...(userName ? [`Git user: ${userName}`] : []),
    `Status:\n${truncatedStatus || '(clean)'}`,
    `Recent commits:\n${log || '(none)'}`,
  ].join('\n')
}

/** Environment context. Design from Claude Code computeSimpleEnvInfo(). */
export function getEnvironmentContext(cwd: string): string {
  const shell = process.env.SHELL || process.env.COMSPEC || 'unknown'
  const date = new Date().toISOString().split('T')[0]
  const osVersion = (() => {
    try { return execSync('uname -sr', { encoding: 'utf-8' }).trim() } catch { return platform() }
  })()

  return [
    `Working directory: ${cwd}`,
    `Platform: ${platform()}`,
    `Shell: ${shell}`,
    `OS: ${osVersion}`,
    `Date: ${date}`,
  ].join('\n')
}

/** Build system prompt. blocks[0]=static (cacheable), blocks[1]=dynamic. */
export function buildSystemPrompt(options: {
  cwd: string
  gitContext?: string           // Pre-fetched via getGitContext()
  customInstructions?: string   // User's CLAUDE.md content
  claudeMd?: string             // Discovered CLAUDE.md content
  memoryIndex?: string          // MEMORY.md index content
  deferredToolNames?: string[]  // Names of deferred tools (for ToolSearch discovery)
}): string[] {
  const { cwd, gitContext, customInstructions, claudeMd, memoryIndex, deferredToolNames } = options

  // Block 0: static (cacheable)
  const staticBlock = STATIC_PROMPT

  // Block 1: dynamic (per-session)
  const dynamicParts: string[] = []

  dynamicParts.push(`# Environment\n<env>\n${getEnvironmentContext(cwd)}\n</env>`)

  if (gitContext) {
    dynamicParts.push(`# Git\n${gitContext}`)
  }

  if (claudeMd?.trim()) {
    dynamicParts.push(`# claudeMd\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n${claudeMd.trim()}`)
  }

  if (customInstructions?.trim()) {
    dynamicParts.push(`# User Instructions\n${customInstructions.trim()}`)
  }

  if (memoryIndex?.trim()) {
    dynamicParts.push(`# Memory\n${memoryIndex.trim()}`)
  }

  // Deferred tools list — lets the LLM know what's available via ToolSearch
  if (deferredToolNames && deferredToolNames.length > 0) {
    const toolList = deferredToolNames.sort().join('\n')
    dynamicParts.push(`<available-deferred-tools>\n${toolList}\n</available-deferred-tools>`)
  }

  return [staticBlock, dynamicParts.join('\n\n')]
}
