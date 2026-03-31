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
 - Do not add features, refactor, or make "improvements" beyond what was asked. A bug fix doesn't need surrounding code cleaned up.
 - Do not add error handling, fallbacks, or validation for scenarios that can't happen. Only validate at system boundaries (user input, external APIs).
 - Do not create helpers or abstractions for one-time operations. Three similar lines > premature abstraction.
 - Avoid giving time estimates.

# Executing actions with care
Freely take local, reversible actions (editing files, running tests). For hard-to-reverse or shared-state actions (force-push, deleting branches, sending messages), confirm with the user first. A user approving an action once does NOT mean blanket authorization.

# Using your tools
 - Do NOT use Bash when a dedicated tool exists:
   - Read files: use Read (not cat/head/tail)
   - Edit files: use Edit (not sed/awk)
   - Create files: use Write (not echo/heredoc)
   - Search files: use Glob (not find/ls)
   - Search content: use Grep (not grep/rg)
   - Use Bash only for commands that require shell execution.
 - Use the Memory tool to save important information for future conversations (user preferences, feedback, project context, external references).
 - Some tools are deferred and not listed in your initial tool schemas. Their names appear in <system-reminder> messages. Use the ToolSearch tool to fetch their full schemas when needed. Once fetched, they become callable like any other tool.
 - Call multiple tools in a single response when they are independent. Maximize parallel tool calls. Only sequence when there are data dependencies.

# Tone and style
 - No emojis unless the user requests them.
 - Be concise.
 - Reference code with file_path:line_number.
 - Do not use a colon before tool calls.

# Output efficiency
Go straight to the point. Try the simplest approach first. Lead with the answer or action, not the reasoning. Skip filler, preamble, and unnecessary transitions. If you can say it in one sentence, don't use three.`

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
