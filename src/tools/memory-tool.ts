/**
 * Memory Tool — Lets the LLM save, list, and delete persistent memories
 *
 * Design from Claude Code memdir system:
 * - Memories are typed (user/feedback/project/reference)
 * - Each memory is a .md file with frontmatter
 * - MEMORY.md is the index (auto-maintained)
 * - Not concurrency-safe (writes files)
 */

import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from './types.js'
import { MemoryManager, MEMORY_TYPES } from '../memory.js'

const inputSchema = z.object({
  action: z.enum(['save', 'list', 'delete']).describe('Memory operation to perform'),
  name: z.string().optional().describe('Memory name (for save)'),
  description: z.string().optional().describe('One-line description (for save)'),
  type: z.enum(MEMORY_TYPES).optional().describe('Memory type: user, feedback, project, or reference (for save)'),
  content: z.string().optional().describe('Memory content in markdown (for save)'),
  fileName: z.string().optional().describe('File name, e.g. user-role.md (for save/delete)'),
})

type Input = z.infer<typeof inputSchema>

// Singleton — set by index.ts at startup
let _manager: MemoryManager | null = null

export function setMemoryManager(manager: MemoryManager): void {
  _manager = manager
}

export const MemoryTool: Tool<Input> = {
  name: 'Memory',
  description: `Manage persistent cross-session memories. Memories survive between conversations.

Actions:
- save: Save a new memory (requires name, description, type, content, fileName)
- list: List all saved memories
- delete: Delete a memory by fileName`,
  inputSchema,
  isConcurrencySafe: false,
  isReadOnly: false,

  async execute(input: Input, _context: ToolContext): Promise<ToolResult> {
    if (!_manager) {
      return { output: 'Memory system not initialized.', isError: true }
    }

    switch (input.action) {
      case 'save': {
        if (!input.name || !input.description || !input.type || !input.content || !input.fileName) {
          return {
            output: 'save requires: name, description, type, content, fileName',
            isError: true,
          }
        }
        if (!input.fileName.endsWith('.md')) {
          return { output: 'fileName must end with .md', isError: true }
        }
        await _manager.saveMemory({
          name: input.name,
          description: input.description,
          type: input.type,
          content: input.content,
          fileName: input.fileName,
        })
        return { output: `Memory saved: ${input.fileName} (${input.type})` }
      }

      case 'list': {
        const memories = await _manager.scanMemories()
        if (memories.length === 0) {
          return { output: 'No memories saved yet.' }
        }
        const lines = memories.map(
          m => `- [${m.type}] ${m.name}: ${m.description} (${basename(m.path)})`,
        )
        return { output: `${memories.length} memories:\n${lines.join('\n')}` }
      }

      case 'delete': {
        if (!input.fileName) {
          return { output: 'delete requires: fileName', isError: true }
        }
        await _manager.deleteMemory(input.fileName)
        return { output: `Memory deleted: ${input.fileName}` }
      }

      default:
        return { output: `Unknown action: ${input.action}`, isError: true }
    }
  },
}

function basename(path: string): string {
  return path.split('/').pop() || path
}
