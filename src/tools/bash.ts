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
import type { Tool, ToolContext, ToolResult } from './types.js'

const inputSchema = z.object({
  command: z.string().describe('The shell command to execute'),
  timeout: z.number().optional().describe('Timeout in milliseconds (default: 120000)'),
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

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const timeout = input.timeout ?? 120_000

    return new Promise((resolve) => {
      const proc = spawn('bash', ['-c', input.command], {
        cwd: context.cwd,
        env: { ...process.env, TERM: 'dumb' },
        timeout,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString() })
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString() })

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
