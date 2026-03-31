/**
 * Glob Tool — File pattern matching
 *
 * Design from Claude Code:
 * - Concurrency-safe (pure read)
 * - Returns sorted by modification time (most recent first)
 * - Preferred over `find` or `ls` in bash
 */

import { z } from 'zod'
import { glob } from 'glob'
import { stat } from 'fs/promises'
import { resolve } from 'path'
import type { Tool, ToolContext, ToolResult } from './types.js'

const inputSchema = z.object({
  pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")'),
  path: z.string().optional().describe('Directory to search in (default: cwd)'),
})

type Input = z.infer<typeof inputSchema>

export const GlobTool: Tool<Input> = {
  name: 'Glob',
  description: `Find files matching a glob pattern. Returns paths sorted by modification time.
Use this instead of \`find\` or \`ls\` commands.`,
  inputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const searchPath = input.path ? resolve(context.cwd, input.path) : context.cwd
    try {
      const files = await glob(input.pattern, {
        cwd: searchPath,
        nodir: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
      })

      if (files.length === 0) {
        return { output: 'No files matched the pattern.' }
      }

      // Sort by mtime (most recent first)
      const withStats = await Promise.all(
        files.slice(0, 500).map(async (f) => {
          try {
            const s = await stat(resolve(searchPath, f))
            return { path: f, mtime: s.mtimeMs }
          } catch {
            return { path: f, mtime: 0 }
          }
        }),
      )
      withStats.sort((a, b) => b.mtime - a.mtime)

      let output = withStats.map(f => f.path).join('\n')
      if (files.length > 500) {
        output += `\n... (${files.length - 500} more files)`
      }
      return { output }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `Error: ${msg}`, isError: true }
    }
  },
}
