/**
 * Permission System
 *
 * Simplified from Claude Code's multi-layer permission architecture.
 * Three modes:
 *   - bypass: all operations allowed (like --dangerously-skip-permissions)
 *   - ask: all non-read-only operations require confirmation
 *   - auto (default): smart per-tool policy with bash command analysis
 */

import type { PermissionDecision } from './tools/types.js'
import { analyzeCommand } from './bash-security.js'

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
 */
function analyzeBashCommand(command: string): PermissionDecision {
  const trimmed = command.trim()

  // Check dangerous patterns first (highest priority)
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { behavior: 'ask', message: `Dangerous pattern detected: ${reason}` }
    }
  }

  // Check for compound commands — can't verify safety of each part
  if (COMPOUND_OPERATORS.test(trimmed)) {
    // Extract all base commands from the compound expression
    const parts = trimmed.split(/[|&;]+/).map(s => s.trim()).filter(Boolean)
    for (const part of parts) {
      const baseCmd = extractBaseCommand(part)
      if (baseCmd && DANGEROUS_COMMANDS.has(baseCmd)) {
        return { behavior: 'ask', message: `Compound command contains dangerous command: ${baseCmd}` }
      }
    }
    // If all parts are safe commands, run deep security analysis before allowing
    const allSafe = parts.every(part => {
      const baseCmd = extractBaseCommand(part)
      return baseCmd !== null && SAFE_COMMANDS.has(baseCmd)
    })
    if (allSafe) {
      return deepSecurityAnalysis(trimmed)
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
    return deepSecurityAnalysis(trimmed)
  }

  // Unknown command — ask to be safe
  return { behavior: 'ask', message: `Unknown command: ${baseCmd}` }
}

/**
 * Deep security analysis — runs after the fast allowlist/denylist checks.
 * Catches injection vectors that simple command-name checks miss
 * (command substitution, process substitution, IFS injection, etc.).
 */
function deepSecurityAnalysis(command: string): PermissionDecision {
  const result = analyzeCommand(command)
  if (!result.safe) {
    return { behavior: 'ask', message: result.reason! }
  }
  return { behavior: 'allow' }
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
  /** Callback to ask user for confirmation. Returns true=allow, false=deny */
  askUser: (toolName: string, input: Record<string, unknown>, message: string) => Promise<boolean>
}

export class PermissionManager {
  private mode: PermissionMode
  private askUser: PermissionManagerOptions['askUser']

  constructor(options: PermissionManagerOptions) {
    this.mode = options.mode
    this.askUser = options.askUser
  }

  getMode(): PermissionMode {
    return this.mode
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  /**
   * Check if a tool invocation should be allowed.
   * For 'ask' decisions, prompts the user via the askUser callback.
   */
  async check(toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> {
    const decision = this.decide(toolName, input)

    if (decision.behavior !== 'ask') {
      return decision
    }

    // Ask user
    const allowed = await this.askUser(toolName, input, decision.message)
    if (allowed) {
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
