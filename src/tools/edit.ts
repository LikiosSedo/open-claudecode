/**
 * Edit Tool — Surgical string replacement in files
 *
 * Design from Claude Code:
 * - Uses exact string matching (old_string → new_string), not line numbers
 * - Why? Line numbers shift as edits accumulate. String matching is stable.
 * - Fails if old_string is not unique (forces LLM to include more context)
 * - NOT concurrency-safe
 */

import { z } from 'zod'
import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'
import type { Tool, ToolContext, ToolResult } from './types.js'

const inputSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to edit'),
  old_string: z.string().describe('The exact text to find and replace'),
  new_string: z.string().describe('The replacement text'),
  replace_all: z.boolean().optional().describe('Replace all occurrences (default: false)'),
})

type Input = z.infer<typeof inputSchema>

export const EditTool: Tool<Input> = {
  name: 'Edit',
  description: `Replace exact string occurrences in a file. The old_string must match exactly
(including whitespace/indentation). If old_string appears multiple times,
the edit fails unless replace_all is true — provide more surrounding context to make it unique.`,
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const filePath = resolve(context.cwd, input.file_path)
    try {
      const content = await readFile(filePath, 'utf-8')
      const occurrences = content.split(input.old_string).length - 1

      if (occurrences === 0) {
        return {
          output: `Error: old_string not found in ${filePath}. Make sure it matches exactly including whitespace.`,
          isError: true,
        }
      }

      if (occurrences > 1 && !input.replace_all) {
        return {
          output: `Error: old_string found ${occurrences} times in ${filePath}. Provide more context to make it unique, or set replace_all: true.`,
          isError: true,
        }
      }

      const newContent = input.replace_all
        ? content.replaceAll(input.old_string, input.new_string)
        : content.replace(input.old_string, input.new_string)

      await writeFile(filePath, newContent, 'utf-8')

      const replaced = input.replace_all ? occurrences : 1

      // Build a simple diff showing the change in context
      const oldLines = input.old_string.split('\n')
      const newLines = input.new_string.split('\n')
      const diff = [
        `Edited ${filePath}: replaced ${replaced} occurrence(s)`,
        '',
        '--- before',
        ...oldLines.map(l => `- ${l}`),
        '+++ after',
        ...newLines.map(l => `+ ${l}`),
      ].join('\n')

      return { output: diff }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: `Error editing file: ${msg}`, isError: true }
    }
  },
}
