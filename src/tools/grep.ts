/**
 * Grep Tool — Content search via ripgrep or native
 *
 * Design from Claude Code:
 * - Concurrency-safe (pure read)
 * - Tries ripgrep first (fast), falls back to native grep
 * - Supports regex, file type filtering, context lines
 */

import { z } from 'zod'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolve } from 'path'
import type { Tool, ToolContext, ToolResult } from './types.js'

const execFileAsync = promisify(execFile)

const inputSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  path: z.string().optional().describe('File or directory to search (default: cwd)'),
  glob: z.string().optional().describe('File glob filter (e.g. "*.ts")'),
  context: z.number().optional().describe('Lines of context around matches'),
  case_insensitive: z.boolean().optional().describe('Case insensitive search'),
})

type Input = z.infer<typeof inputSchema>

export const GrepTool: Tool<Input> = {
  name: 'Grep',
  description: `Search file contents using regex. Powered by ripgrep when available.
Use this instead of \`grep\` or \`rg\` commands in bash.`,
  inputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const searchPath = input.path ? resolve(context.cwd, input.path) : context.cwd

    // Build ripgrep args
    const args: string[] = ['--line-number', '--no-heading', '--color', 'never']
    if (input.case_insensitive) args.push('-i')
    if (input.context) args.push('-C', String(input.context))
    if (input.glob) args.push('--glob', input.glob)
    args.push('--', input.pattern, searchPath)

    try {
      // Try ripgrep first
      const { stdout } = await execFileAsync('rg', args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      })
      const output = stdout.trim()
      if (output.length > 50_000) {
        return { output: output.slice(0, 50_000) + '\n... (truncated)' }
      }
      return { output: output || 'No matches found.' }
    } catch (err: unknown) {
      // ripgrep exit code 1 = no matches
      if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 1) {
        return { output: 'No matches found.' }
      }
      // ripgrep not available, fall back to grep
      try {
        const grepArgs = ['-rn']
        if (input.case_insensitive) grepArgs.push('-i')
        if (input.context) grepArgs.push('-C', String(input.context))
        if (input.glob) grepArgs.push('--include', input.glob)
        grepArgs.push('--', input.pattern, searchPath)
        const { stdout } = await execFileAsync('grep', grepArgs, {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
        })
        return { output: stdout.trim() || 'No matches found.' }
      } catch {
        return { output: 'No matches found.' }
      }
    }
  },
}
