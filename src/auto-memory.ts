/**
 * Auto-Extract Memories from Conversation
 *
 * Design from Claude Code src/services/extractMemories/:
 * - Runs asynchronously at end of turn (fire-and-forget, non-blocking)
 * - Uses same provider to extract structured memories from recent messages
 * - Deduplicates against existing memories before saving
 * - Triggered every N turns (configurable) to avoid excessive API calls
 *
 * Differences from Claude Code:
 * - Simplified: no forked-agent pattern (uses direct provider.stream call)
 * - No canUseTool sandboxing (extraction agent has no tool access)
 * - JSON-only extraction (no file read/write by the extraction agent)
 */

import type { Message, Provider } from './providers/types.js'
import type { MemoryManager } from './memory.js'
import { MEMORY_TYPES, type MemoryType } from './memory.js'

// --- Extraction Prompt ---

const EXTRACT_PROMPT = `Review this conversation and extract any information worth remembering for future sessions. Focus on:

1. **User preferences**: How they like to work, communication style, coding standards
2. **Feedback**: Corrections they gave ("don't do X", "always do Y"), approaches that worked well
3. **Project context**: Decisions, deadlines, architecture choices not obvious from code
4. **References**: External resources, tools, URLs mentioned

For each memory, output JSON:
{"memories": [{"name": "...", "description": "one-line summary", "type": "user|feedback|project|reference", "content": "detailed content", "fileName": "kebab-case-name.md"}]}

If nothing is worth remembering, output: {"memories": []}
Only extract non-obvious information that can't be derived from code or git history.`

// --- Types ---

interface ExtractedMemory {
  name: string
  description: string
  type: string
  content: string
  fileName: string
}

// --- Helpers ---

/** Get the most recent user/assistant messages (up to limit). */
function getRecentMessages(messages: Message[], limit: number): Message[] {
  const recent: Message[] = []
  for (let i = messages.length - 1; i >= 0 && recent.length < limit; i--) {
    const msg = messages[i]!
    // Only include user text and assistant text (skip tool_result-only messages)
    const hasText = msg.content.some(
      b => b.type === 'text' && ('text' in b ? b.text.trim().length > 0 : false),
    )
    if (hasText) {
      recent.unshift(msg)
    }
  }
  return recent
}

/** Parse JSON from LLM response, tolerant of markdown fences. */
function parseExtractResponse(raw: string): ExtractedMemory[] {
  // Strip markdown code fences if present
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }

  const parsed = JSON.parse(cleaned)
  if (!parsed || !Array.isArray(parsed.memories)) return []
  return parsed.memories
}

/** Validate a single extracted memory has all required fields. */
function isValidMemory(mem: ExtractedMemory): boolean {
  return (
    typeof mem.name === 'string' && mem.name.length > 0 &&
    typeof mem.description === 'string' && mem.description.length > 0 &&
    typeof mem.type === 'string' && (MEMORY_TYPES as readonly string[]).includes(mem.type) &&
    typeof mem.content === 'string' && mem.content.length > 0 &&
    typeof mem.fileName === 'string' && mem.fileName.endsWith('.md')
  )
}

// --- Main Export ---

/**
 * Extract memories from recent conversation.
 * Runs asynchronously — does NOT block the REPL.
 *
 * @returns Number of new memories saved.
 */
export async function extractMemories(
  messages: Message[],
  provider: Provider,
  model: string,
  memoryManager: MemoryManager,
): Promise<number> {
  const recentMessages = getRecentMessages(messages, 10)
  if (recentMessages.length < 4) return 0 // too few to analyze

  // Build extraction request: recent conversation + extraction prompt
  const extractMessages: Message[] = [
    ...recentMessages,
    { role: 'user', content: [{ type: 'text', text: EXTRACT_PROMPT }] },
  ]

  // Call provider to extract memories
  let response = ''
  for await (const event of provider.stream(extractMessages, [], {
    model,
    maxTokens: 2000,
    systemPrompt: 'You extract structured information from conversations. Respond with JSON only.',
  })) {
    if (event.type === 'text_delta') response += event.text
  }

  // Parse and deduplicate
  const memories = parseExtractResponse(response)
  if (memories.length === 0) return 0

  const existing = await memoryManager.scanMemories()
  let saved = 0

  for (const mem of memories) {
    if (!isValidMemory(mem)) continue

    // Check for duplicates by name or fileName
    const duplicate = existing.find(
      e => e.name === mem.name || e.path.endsWith(mem.fileName),
    )
    if (duplicate) continue

    await memoryManager.saveMemory({
      name: mem.name,
      description: mem.description,
      type: mem.type as MemoryType,
      content: mem.content,
      fileName: mem.fileName,
    })
    saved++
  }

  return saved
}
