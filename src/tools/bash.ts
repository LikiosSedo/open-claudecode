/**
 * Bash Tool — Shell command execution
 *
 * Design from Claude Code:
 * - NOT concurrency-safe (commands may have implicit dependencies)
 * - Supports timeout and background execution
 * - If bash errors, StreamingToolExecutor cancels sibling tools
 */

import { z } from 'zod'
import { spawn } from 'child_process'
import { platform, homedir } from 'node:os'
import type { Tool, ToolContext, ToolResult } from './types.js'

/**
 * macOS seatbelt profile for sandbox-exec.
 * - Allow read everywhere
 * - Allow write only to cwd, /tmp, /private/tmp, and ~/.occ/
 * - Allow network access
 * - Allow process execution
 */
function seatbeltProfile(cwd: string): string {
  const home = homedir()
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write*
  (subpath "${cwd}")
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath "${home}/.occ")
  (subpath "/dev")
)`
}

/** Wrap a command with sandbox-exec on macOS when sandbox mode is active. */
function wrapWithSandbox(command: string, cwd: string, dangerouslyDisable?: boolean): string {
  if (dangerouslyDisable) return command
  if (platform() !== 'darwin') {
    console.error('[sandbox] Warning: sandbox mode is macOS-only, running without sandbox')
    return command
  }
  const profile = seatbeltProfile(cwd)
  // Escape single quotes in profile for shell embedding
  const escaped = profile.replace(/'/g, "'\\''")
  return `sandbox-exec -p '${escaped}' bash -c ${shellQuote(command)}`
}

/** Shell-quote a string for embedding in a single-quoted context. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

const inputSchema = z.object({
  command: z.string().describe('The shell command to execute'),
  timeout: z.number().optional().describe('Timeout in milliseconds (default: 120000)'),
  dangerouslyDisableSandbox: z.boolean().optional().describe('Skip sandbox wrapping even if sandbox mode is on'),
})

type Input = z.infer<typeof inputSchema>

export const BashTool: Tool<Input> = {
  name: 'Bash',
  description: `Execute a shell command and return its output.
Use this for system commands, git operations, running tests, installing packages, etc.
Prefer dedicated tools (Read, Write, Edit, Glob, Grep) over bash for file operations.`,
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,

  toolPrompt: () => `# Bash Tool Usage
- Quote file paths with spaces in double quotes
- Use absolute paths when possible
- For git: never use -i (interactive) flags, never skip hooks (--no-verify)
- Prefer specific file staging over "git add -A"
- Background: use run_in_background for long commands`,

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const timeout = input.timeout ?? 120_000
    const command = context.sandbox
      ? wrapWithSandbox(input.command, context.cwd, input.dangerouslyDisableSandbox)
      : input.command

    return new Promise((resolve) => {
      const proc = spawn('bash', ['-c', command], {
        cwd: context.cwd,
        env: { ...process.env, TERM: 'dumb' },
        timeout,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString()
        stdout += chunk
        context.onProgress?.({ output: chunk, isPartial: true })
      })

      proc.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString()
        stderr += chunk
        context.onProgress?.({ output: chunk, isPartial: true })
      })

      context.abortSignal?.addEventListener('abort', () => proc.kill('SIGTERM'))

      proc.on('close', (code) => {
        const output = stdout + (stderr ? `\n${stderr}` : '')
        // Truncate very long output
        const maxLen = 100_000
        const truncated = output.length > maxLen
          ? output.slice(0, maxLen) + `\n... (truncated, ${output.length} total chars)`
          : output
        resolve({
          output: truncated || '(no output)',
          isError: code !== 0,
        })
      })

      proc.on('error', (err) => {
        resolve({ output: `Error: ${err.message}`, isError: true })
      })
    })
  },
}
