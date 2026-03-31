/**
 * Anthropic Provider
 *
 * Design from Claude Code:
 * - Uses RAW stream (not SDK's MessageStream) to avoid O(n²) partialParse
 * - Accumulates tool input JSON manually, yields only complete blocks
 * - Supports prompt caching via cache_control blocks
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  Provider, ProviderOptions, Message, ToolSchema,
  StreamEvent, TokenUsage, StopReason,
} from './types.js'

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic'
  private client: Anthropic

  constructor(options?: { apiKey?: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: options?.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL: options?.baseURL ?? process.env.ANTHROPIC_BASE_URL,
    })
  }

  async *stream(
    messages: Message[],
    tools: ToolSchema[],
    options: ProviderOptions,
  ): AsyncIterable<StreamEvent> {
    // Convert our messages to Anthropic format
    const anthropicMessages = messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content.map(c => {
        switch (c.type) {
          case 'text': return { type: 'text' as const, text: c.text }
          case 'thinking': return { type: 'thinking' as const, thinking: c.thinking, signature: c.signature ?? '' }
          case 'tool_use': return { type: 'tool_use' as const, id: c.id, name: c.name, input: c.input }
          case 'tool_result': return {
            type: 'tool_result' as const,
            tool_use_id: c.toolUseId,
            content: c.content,
            is_error: c.isError,
          }
          default: return c
        }
      }),
    }))

    // Build system prompt with cache control
    const systemBlocks = this.buildSystemBlocks(options.systemPrompt)

    const anthropicTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }))

    // Use raw stream to avoid SDK's O(n²) partialParse overhead
    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 16384,
      system: systemBlocks,
      messages: anthropicMessages as Anthropic.MessageParam[],
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      stream: true,
    })

    // Track partial state for accumulation
    const partialBlocks = new Map<number, { type: string; id?: string; name?: string; text: string; input: string; thinking: string; signature?: string }>()

    for await (const event of response) {
      switch (event.type) {
        case 'message_start': {
          const usage = event.message.usage
          yield {
            type: 'message_start',
            messageId: event.message.id,
            usage: {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cacheReadTokens: (usage as Record<string, number>).cache_read_input_tokens,
              cacheWriteTokens: (usage as Record<string, number>).cache_creation_input_tokens,
            },
          }
          break
        }

        case 'content_block_start': {
          const block = event.content_block
          partialBlocks.set(event.index, {
            type: block.type,
            id: 'id' in block ? (block as { id: string }).id : undefined,
            name: 'name' in block ? (block as { name: string }).name : undefined,
            text: '', input: '', thinking: '',
          })

          if (block.type === 'thinking') {
            const thinkingBlock = block as { type: string; signature?: string }
            if (thinkingBlock.signature) {
              const partial = partialBlocks.get(event.index)
              if (partial) partial.signature = thinkingBlock.signature
            }
          }

          if (block.type === 'tool_use') {
            yield {
              type: 'tool_use_start',
              id: (block as { id: string }).id,
              name: (block as { name: string }).name,
            }
          }
          break
        }

        case 'content_block_delta': {
          const partial = partialBlocks.get(event.index)
          if (!partial) break
          const delta = event.delta as Record<string, string>

          if (delta.type === 'text_delta') {
            partial.text += delta.text
            yield { type: 'text_delta', text: delta.text }
          } else if (delta.type === 'input_json_delta') {
            partial.input += delta.partial_json
            yield { type: 'tool_use_delta', id: partial.id!, partialJson: delta.partial_json }
          } else if (delta.type === 'thinking_delta') {
            partial.thinking += delta.thinking
            yield { type: 'thinking_delta', thinking: delta.thinking }
          }
          break
        }

        case 'content_block_stop': {
          const partial = partialBlocks.get(event.index)
          if (!partial) break

          if (partial.type === 'tool_use' && partial.id) {
            let input: unknown
            try { input = JSON.parse(partial.input || '{}') } catch { input = {} }
            yield { type: 'tool_use_stop', id: partial.id, input }
          }
          partialBlocks.delete(event.index)
          break
        }

        case 'message_delta': {
          const delta = event.delta as Record<string, string>
          const usage = (event as Record<string, unknown>).usage as Record<string, number> | undefined
          yield {
            type: 'message_stop',
            stopReason: (delta.stop_reason ?? 'end_turn') as StopReason,
            usage: usage ? {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
            } : undefined,
          }
          break
        }
      }
    }
  }

  estimateTokens(messages: Message[]): number {
    // Rough estimate: ~4 chars per token
    const text = JSON.stringify(messages)
    return Math.ceil(text.length / 4)
  }

  private buildSystemBlocks(
    prompt?: string | string[],
  ): Anthropic.TextBlockParam[] {
    if (!prompt) return []
    const parts = Array.isArray(prompt) ? prompt : [prompt]
    return parts.map((text, i) => ({
      type: 'text' as const,
      text,
      // Cache the first block (static instructions) — design from Claude Code
      ...(i === 0 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }))
  }
}
