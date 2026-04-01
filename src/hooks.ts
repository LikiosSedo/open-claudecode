/**
 * Hooks System — user-defined lifecycle callbacks
 *
 * Simplified from Claude Code src/utils/hooks.ts.
 * Hooks are user-defined shell commands executed at specific lifecycle events.
 * They can observe, allow, deny, or modify tool invocations via JSON stdout.
 *
 * Configuration: ~/.occ/hooks.json
 */

import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// -- Types --

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'SessionEnd'

export interface HookConfig {
  event: HookEvent
  /** Shell command to execute */
  command: string
  /** Tool name glob match (e.g. "Bash", "mcp__*"). Only for PreToolUse/PostToolUse. */
  match?: string
  /** Timeout in ms. Default: 10000. */
  timeout?: number
}

export interface HookResult {
  /** Whether any hook modified behavior (denied, updated input, etc.) */
  modified: boolean
  /** PreToolUse decision: allow or deny */
  decision?: 'allow' | 'deny'
  /** Reason for denial */
  reason?: string
  /** Modified tool input (PreToolUse only) */
  updatedInput?: Record<string, unknown>
  /** Combined stdout from all executed hooks */
  output?: string
}

interface HookJsonOutput {
  decision?: 'allow' | 'deny'
  reason?: string
  input?: Record<string, unknown>
}

interface HooksFile {
  hooks: HookConfig[]
}

// -- Glob Matching --

/** Simple glob match: `*` matches any sequence of non-separator characters. */
function globMatch(pattern: string, text: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  )
  return regex.test(text)
}

// -- HookManager --

const DEFAULT_TIMEOUT_MS = 10_000
const CONFIG_PATH = join(homedir(), '.occ', 'hooks.json')

export class HookManager {
  private hooks: HookConfig[] = []

  constructor() {
    this.loadConfig()
  }

  /** Reload config from disk. Call after user edits hooks.json. */
  reload(): void {
    this.loadConfig()
  }

  /** Get all configured hooks (for display). */
  getHooks(): readonly HookConfig[] {
    return this.hooks
  }

  /**
   * Execute all matching hooks for an event, serially.
   *
   * For PreToolUse: first "deny" short-circuits. Input can be mutated by hooks.
   * For PostToolUse / SessionStart / SessionEnd: all hooks run; result is informational.
   *
   * Context is passed to hooks via:
   *   - stdin: JSON object with event details
   *   - env vars: HOOK_EVENT, HOOK_TOOL_NAME, HOOK_INPUT
   */
  async execute(
    event: HookEvent,
    context: {
      toolName?: string
      toolInput?: Record<string, unknown>
      toolResult?: string
      isError?: boolean
    },
  ): Promise<HookResult> {
    const matching = this.findMatchingHooks(event, context.toolName)
    if (matching.length === 0) {
      return { modified: false }
    }

    const outputs: string[] = []
    let currentInput = context.toolInput

    for (const hook of matching) {
      const stdinPayload = JSON.stringify({
        event,
        tool_name: context.toolName,
        tool_input: currentInput,
        tool_result: context.toolResult,
        is_error: context.isError,
      })

      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        HOOK_EVENT: event,
      }
      if (context.toolName) env.HOOK_TOOL_NAME = context.toolName
      if (currentInput) env.HOOK_INPUT = JSON.stringify(currentInput)

      const timeout = hook.timeout ?? DEFAULT_TIMEOUT_MS

      let result: { stdout: string; stderr: string; exitCode: number }
      try {
        result = await execHookCommand(hook.command, stdinPayload, env, timeout)
      } catch (err) {
        // Timeout or spawn failure — treat as non-blocking error, continue
        const msg = err instanceof Error ? err.message : String(err)
        outputs.push(`[hook error: ${msg}]`)
        continue
      }

      if (result.stdout.trim()) {
        outputs.push(result.stdout)
      }
      if (result.stderr.trim()) {
        outputs.push(`[stderr] ${result.stderr}`)
      }

      // Try to parse JSON output from stdout
      const parsed = parseHookOutput(result.stdout)
      if (parsed) {
        // PreToolUse: handle deny/allow/input modification
        if (event === 'PreToolUse') {
          if (parsed.decision === 'deny') {
            return {
              modified: true,
              decision: 'deny',
              reason: parsed.reason ?? `Denied by hook: ${hook.command}`,
              output: outputs.join('\n'),
            }
          }
          if (parsed.decision === 'allow') {
            // Explicit allow — continue to next hook
          }
          if (parsed.input && typeof parsed.input === 'object') {
            currentInput = parsed.input
          }
        }
      }

      // Non-zero exit code on PreToolUse → treat as deny (exit code 2 = blocking error in Claude Code)
      if (event === 'PreToolUse' && result.exitCode !== 0) {
        const reason = result.stderr.trim() || result.stdout.trim() || `Hook exited with code ${result.exitCode}`
        return {
          modified: true,
          decision: 'deny',
          reason,
          output: outputs.join('\n'),
        }
      }
    }

    // If input was modified by any hook, return the updated input
    const inputModified = currentInput !== context.toolInput
    return {
      modified: inputModified,
      decision: event === 'PreToolUse' ? 'allow' : undefined,
      updatedInput: inputModified ? currentInput : undefined,
      output: outputs.length > 0 ? outputs.join('\n') : undefined,
    }
  }

  // -- Private --

  private loadConfig(): void {
    this.hooks = []
    if (!existsSync(CONFIG_PATH)) return

    try {
      const raw = readFileSync(CONFIG_PATH, 'utf-8')
      const parsed = JSON.parse(raw) as HooksFile
      if (Array.isArray(parsed.hooks)) {
        this.hooks = parsed.hooks.filter(
          (h): h is HookConfig =>
            typeof h.event === 'string' &&
            typeof h.command === 'string' &&
            ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd'].includes(h.event),
        )
      }
    } catch {
      // Invalid JSON or read error — no hooks
    }
  }

  private findMatchingHooks(event: HookEvent, toolName?: string): HookConfig[] {
    return this.hooks.filter(hook => {
      if (hook.event !== event) return false
      // If hook has a match pattern and we have a tool name, check glob match
      if (hook.match && toolName) {
        return globMatch(hook.match, toolName)
      }
      // If hook has a match pattern but no tool name (e.g. SessionStart), skip
      if (hook.match && !toolName) return false
      return true
    })
  }
}

/**
 * Execute a shell command with stdin input, environment, and timeout.
 * Uses AbortController + spawn signal for clean timeout handling.
 */
function execHookCommand(
  command: string,
  stdin: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const ac = new AbortController()
    const timer = setTimeout(() => {
      ac.abort()
      reject(new Error(`Hook timed out after ${timeoutMs}ms: ${command}`))
    }, timeoutMs)

    const child = spawn('bash', ['-c', command], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: ac.signal,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    // Write context to stdin and close
    child.stdin.write(stdin)
    child.stdin.end()

    child.on('error', (err) => {
      clearTimeout(timer)
      if (err.name === 'AbortError') {
        reject(new Error(`Hook timed out after ${timeoutMs}ms: ${command}`))
      } else {
        reject(err)
      }
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })
  })
}

/**
 * Parse hook stdout as JSON. Returns null if not JSON or parse fails.
 */
function parseHookOutput(stdout: string): HookJsonOutput | null {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) return null

  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as HookJsonOutput
  } catch {
    return null
  }
}
