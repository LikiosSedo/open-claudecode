/**
 * Message Normalization
 *
 * Ensures messages are API-compliant before submission.
 * Design from Claude Code src/utils/messages.ts (ensureToolResultPairing + normalizeMessagesForAPI).
 *
 * Two main concerns:
 * 1. Every tool_use block must have a matching tool_result (API returns 400 otherwise)
 * 2. Messages must alternate user/assistant, start with user, have no empty content
 */

import type {
  Message,
  UserMessage,
  AssistantMessage,
  UserContent,
  AssistantContent,
} from './providers/types.js'

const SYNTHETIC_TOOL_RESULT =
  '[Tool result missing due to internal error]'

// ---------------------------------------------------------------------------
// ensureToolResultPairing
// ---------------------------------------------------------------------------

/**
 * Ensure every tool_use has a matching tool_result.
 *
 * Walks the conversation pairing assistant tool_use blocks with user tool_result
 * blocks in the following message. Three repair cases:
 *
 * 1. Assistant has tool_use IDs not present in the next user's tool_results
 *    -> inject synthetic tool_result blocks into that user message
 * 2. Last message is assistant with tool_use (model was interrupted)
 *    -> append a new user message with synthetic tool_results
 * 3. User has tool_result IDs not matching any preceding tool_use
 *    -> strip those orphaned tool_result blocks
 */
export function ensureToolResultPairing(messages: Message[]): Message[] {
  if (messages.length === 0) return messages

  const result: Message[] = []

  // Track all tool_use IDs we've seen globally (detect duplicates across messages)
  const globalToolUseIds = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!

    if (msg.role === 'user') {
      // Strip orphaned tool_results at position 0 or after another user message
      const prev = result.at(-1)
      if (!prev || prev.role === 'user') {
        const stripped = msg.content.filter(b => b.type !== 'tool_result')
        if (stripped.length !== msg.content.length) {
          // Some tool_results removed; keep the message if anything remains
          if (stripped.length > 0) {
            result.push({ role: 'user', content: stripped })
          } else if (result.length === 0) {
            // First message must be user — keep a placeholder
            result.push({
              role: 'user',
              content: [{ type: 'text', text: '[Orphaned tool result removed]' }],
            })
          }
          // else: drop the empty message entirely
          continue
        }
      }

      result.push(msg)
      continue
    }

    // Assistant message: collect tool_use IDs, dedupe
    const toolUseIds: string[] = []
    const dedupedContent: AssistantContent[] = []

    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        if (globalToolUseIds.has(block.id)) {
          continue // duplicate tool_use across messages — skip
        }
        globalToolUseIds.add(block.id)
        toolUseIds.push(block.id)
      }
      dedupedContent.push(block)
    }

    // If deduplication emptied the content, insert placeholder text
    if (dedupedContent.length === 0) {
      dedupedContent.push({ type: 'text', text: '[Tool use interrupted]' })
    }

    const assistantMsg: AssistantMessage =
      dedupedContent.length !== msg.content.length
        ? { role: 'assistant', content: dedupedContent }
        : msg

    result.push(assistantMsg)

    if (toolUseIds.length === 0) continue

    // Check next message for tool_results
    const nextMsg = messages[i + 1]
    const toolUseIdSet = new Set(toolUseIds)

    if (nextMsg?.role === 'user') {
      const existingResultIds = new Set<string>()
      for (const block of nextMsg.content) {
        if (block.type === 'tool_result') {
          existingResultIds.add(block.toolUseId)
        }
      }

      const missingIds = toolUseIds.filter(id => !existingResultIds.has(id))
      const orphanedIds = [...existingResultIds].filter(id => !toolUseIdSet.has(id))

      if (missingIds.length === 0 && orphanedIds.length === 0) continue

      // Patch the next user message
      const syntheticBlocks: UserContent[] = missingIds.map(id => ({
        type: 'tool_result',
        toolUseId: id,
        content: SYNTHETIC_TOOL_RESULT,
        isError: true,
      }))

      // Filter out orphaned tool_results
      let existingContent = nextMsg.content
      if (orphanedIds.length > 0) {
        const orphanSet = new Set(orphanedIds)
        existingContent = existingContent.filter(
          b => !(b.type === 'tool_result' && orphanSet.has(b.toolUseId)),
        )
      }

      const patchedContent = [...syntheticBlocks, ...existingContent]
      result.push({ role: 'user', content: patchedContent })
      i++ // skip the next message, we already handled it
    } else {
      // No user message follows — model was interrupted. Inject synthetic user message.
      const syntheticBlocks: UserContent[] = toolUseIds.map(id => ({
        type: 'tool_result',
        toolUseId: id,
        content: SYNTHETIC_TOOL_RESULT,
        isError: true,
      }))
      result.push({ role: 'user', content: syntheticBlocks })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// normalizeMessages
// ---------------------------------------------------------------------------

/**
 * Normalize messages for API submission (idempotent):
 * 1. Filter out messages with empty content
 * 2. Merge adjacent same-role messages (concatenate content arrays)
 * 3. Ensure first message is from user
 * 4. Ensure strict user/assistant alternation
 */
export function normalizeMessages(messages: Message[]): Message[] {
  // Step 1: filter empty content
  const nonEmpty = messages.filter(m => m.content.length > 0)
  if (nonEmpty.length === 0) return []

  // Step 2+4: merge adjacent same-role and enforce alternation
  const merged: Message[] = []
  for (const msg of nonEmpty) {
    const prev = merged.at(-1)
    if (prev && prev.role === msg.role) {
      // Merge into previous: concatenate content arrays
      if (prev.role === 'user') {
        (prev as UserMessage).content = [
          ...(prev as UserMessage).content,
          ...(msg as UserMessage).content,
        ]
      } else {
        (prev as AssistantMessage).content = [
          ...(prev as AssistantMessage).content,
          ...(msg as AssistantMessage).content,
        ]
      }
    } else {
      merged.push({ ...msg, content: [...msg.content] })
    }
  }

  // Step 3: ensure first message is user
  if (merged.length > 0 && merged[0]!.role === 'assistant') {
    merged.unshift({
      role: 'user',
      content: [{ type: 'text', text: '' }],
    })
  }

  return merged
}

// ---------------------------------------------------------------------------
// isPromptTooLong — detect API errors that warrant reactive compact
// ---------------------------------------------------------------------------

/**
 * Detect prompt-too-long or payload-too-large errors from the API.
 * Covers Anthropic 400 (prompt is too long) and generic 413 (payload too large).
 */
export function isPromptTooLong(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const status = (err as { status?: number }).status
  if (status === 413) return true
  const message = (err as { message?: string }).message ?? ''
  if (status === 400 && message.toLowerCase().includes('too long')) return true
  return false
}
