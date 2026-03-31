/**
 * Read Tool — File reading with offset/limit support
 *
 * Design from Claude Code:
 * - Concurrency-safe (pure read, no side effects)
 * - Supports partial reads via offset + limit (critical for large files)
 * - Line numbers in output (cat -n style) for LLM to reference
 */

import { z } from 'zod'
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import type { Tool, ToolContext, ToolResult } from './types.js'

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to read'),
  offset: z.number().optional().describe('Line number to start reading from (0-based)'),
  limit: z.number().optional().describe('Max number of lines to read (default: 2000)'),
})

type Input = z.infer<typeof inputSchema>

export const ReadTool: Tool<Input> = {
  name: 'Read',
  description: `Read a file from the filesystem. Returns contents with line numbers.
Use offset and limit for large files. Supports text files, not binary.`,
  inputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const filePath = resolve(context.cwd, input.file_path)
    try {
      const content = await readFile(filePath, 'utf-8')
      const lines = content.split('\n')
      const offset = input.offset ?? 0
      const limit = input.limit ?? 2000
      const slice = lines.slice(offset, offset + limit)

      const numbered = slice
        .map((line, i) => `${offset + i + 1}\t${line}`)
        .join('\n')

      let output = numbered
      if (offset + limit < lines.length) {
        output += `\n... (${lines.length - offset - limit} more lines)`
      }
      return { output: output || '(empty file)' }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `Error reading file: ${msg}`, isError: true }
    }
  },
}
