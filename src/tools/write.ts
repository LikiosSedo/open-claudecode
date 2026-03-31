/**
 * Write Tool — Create or overwrite files
 *
 * Design from Claude Code:
 * - NOT concurrency-safe (writes are mutations)
 * - Creates parent directories automatically
 */

import { z } from 'zod'
import { writeFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import type { Tool, ToolContext, ToolResult } from './types.js'

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to write'),
  content: z.string().describe('The content to write'),
})

type Input = z.infer<typeof inputSchema>

export const WriteTool: Tool<Input> = {
  name: 'Write',
  description: `Write content to a file. Creates the file if it doesn't exist, overwrites if it does.
Parent directories are created automatically.`,
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const filePath = resolve(context.cwd, input.file_path)
    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, input.content, 'utf-8')
      const lines = input.content.split('\n').length
      return { output: `File written: ${filePath} (${lines} lines)` }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `Error writing file: ${msg}`, isError: true }
    }
  },
}
