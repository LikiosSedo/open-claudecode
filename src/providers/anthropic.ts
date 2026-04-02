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
import { buildToolPrompt, parseTextToolCalls, isToolsNotSupportedError } from './types.js'
import { isRetryableError, getBackoffDelay, MAX_RETRIES } from './retry.js'

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

    // Build base params (reused for streaming, non-streaming, and tool-less retries)
    const buildParams = (useTools: boolean): Record<string, unknown> => {
      const params: Record<string, unknown> = {
        model: options.model,
        max_tokens: options.maxTokens ?? 16384,
        system: useTools ? systemBlocks : this.buildSystemBlocksWithTools(systemBlocks, tools),
        messages: anthropicMessages as Anthropic.MessageParam[],
        tools: useTools && anthropicTools.length > 0 ? anthropicTools : undefined,
      }
      if (options.outputSchema) {
        params.output_config = {
          format: { type: 'json_schema', name: options.outputSchema.name, schema: options.outputSchema.schema },
        }
        params.betas = ['structured-outputs-2025-12-15']
      }
      if (options.thinking) {
        if (options.thinking.type === 'enabled') {
          params.thinking = { type: 'enabled', budget_tokens: options.thinking.budgetTokens }
          params.max_tokens = Math.max(params.max_tokens as number, options.thinking.budgetTokens + 8192)
        } else if (options.thinking.type === 'adaptive') {
          params.thinking = { type: 'enabled', budget_tokens: 10000 }
          params.max_tokens = Math.max(params.max_tokens as number, 10000 + 8192)
        }
      }
      return params
    }

    // Track whether we need to strip native tools on retry (model doesn't support them)
    let toolsSupported = true

    // Retry loop: retry on transient errors before consuming the stream
    let lastError: unknown
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = getBackoffDelay(attempt, lastError)
        console.error(`[anthropic] Retry ${attempt}/${MAX_RETRIES} after ${Math.round(delay)}ms`)
        await new Promise(r => setTimeout(r, delay))
      }

      const params = buildParams(toolsSupported && true)

      let response
      try {
        response = await this.client.messages.create({
          ...params,
          stream: true,
        } as unknown as Anthropic.MessageCreateParamsStreaming)
      } catch (err) {
        // Detect models that don't support tool_use — retry without tools
        if (isToolsNotSupportedError(err) && toolsSupported && tools.length > 0) {
          console.error('[anthropic] Model does not support tools — falling back to prompt-based tool calling')
          toolsSupported = false
          lastError = err
          continue
        }
        lastError = err
        if (!isRetryableError(err) || attempt >= MAX_RETRIES) {
          // All streaming retries exhausted — try non-streaming fallback
          yield* this.nonStreamingFallback(params, toolsSupported, tools)
          return
        }
        continue
      }

      // Consume the stream
      try {
        yield* this.consumeStream(response, toolsSupported, tools)
        return  // Stream consumed successfully
      } catch (streamErr) {
        lastError = streamErr
        if (!isRetryableError(streamErr) || attempt >= MAX_RETRIES) {
          // Stream broke mid-way and retries exhausted — try non-streaming
          console.error('[anthropic] Stream failed, falling back to non-streaming')
          yield* this.nonStreamingFallback(params, toolsSupported, tools)
          return
        }
      }
    }
  }

  /**
   * Consume an Anthropic streaming response and yield normalized StreamEvents.
   */
  private async *consumeStream(
    response: AsyncIterable<Anthropic.MessageStreamEvent>,
    toolsSupported: boolean,
    tools: ToolSchema[],
  ): AsyncIterable<StreamEvent> {
    const partialBlocks = new Map<number, { type: string; id?: string; name?: string; text: string; input: string; thinking: string; signature?: string }>()
    let fullText = ''

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
              cacheReadTokens: (usage as unknown as Record<string, number>).cache_read_input_tokens,
              cacheWriteTokens: (usage as unknown as Record<string, number>).cache_creation_input_tokens,
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
          const delta = event.delta as unknown as Record<string, string>

          if (delta.type === 'text_delta') {
            partial.text += delta.text
            fullText += delta.text
            yield { type: 'text_delta', text: delta.text }
          } else if (delta.type === 'input_json_delta') {
            partial.input += delta.partial_json
            yield { type: 'tool_use_delta', id: partial.id!, partialJson: delta.partial_json }
          } else if (delta.type === 'thinking_delta') {
            partial.thinking += delta.thinking
            yield { type: 'thinking_delta', thinking: delta.thinking }
          } else if (delta.type === 'signature_delta') {
            if (partial) partial.signature = delta.signature
          }
          break
        }

        case 'content_block_stop': {
          const partial = partialBlocks.get(event.index)
          if (!partial) break

          if (partial.type === 'thinking' && partial.signature) {
            yield { type: 'thinking_stop', signature: partial.signature }
          } else if (partial.type === 'tool_use' && partial.id) {
            let input: unknown
            try { input = JSON.parse(partial.input || '{}') } catch { input = {} }
            yield { type: 'tool_use_stop', id: partial.id, input }
          }
          partialBlocks.delete(event.index)
          break
        }

        case 'message_delta': {
          // If tools aren't natively supported, parse text-based tool calls before message_stop
          if (!toolsSupported && tools.length > 0) {
            yield* this.emitTextToolCalls(fullText)
          }

          const delta = event.delta as unknown as Record<string, string>
          const usage = (event as unknown as Record<string, unknown>).usage as Record<string, number> | undefined
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

  /**
   * Non-streaming fallback: called after streaming retries are exhausted.
   * Makes a single non-streaming API call and converts the response to StreamEvents.
   */
  private async *nonStreamingFallback(
    params: Record<string, unknown>,
    toolsSupported: boolean,
    tools: ToolSchema[],
  ): AsyncIterable<StreamEvent> {
    console.error('[anthropic] Attempting non-streaming fallback')
    const response = await this.client.messages.create({
      ...params,
      stream: false,
    } as unknown as Anthropic.MessageCreateParamsNonStreaming) as Anthropic.Message

    // Emit message_start
    yield {
      type: 'message_start',
      messageId: response.id,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: (response.usage as unknown as Record<string, number>).cache_read_input_tokens,
        cacheWriteTokens: (response.usage as unknown as Record<string, number>).cache_creation_input_tokens,
      },
    }

    // Emit content blocks
    let fullText = ''
    for (const block of response.content) {
      if (block.type === 'text') {
        fullText += block.text
        yield { type: 'text_delta', text: block.text }
      } else if (block.type === 'tool_use') {
        yield { type: 'tool_use_start', id: block.id, name: block.name }
        yield { type: 'tool_use_stop', id: block.id, input: block.input }
      } else if (block.type === 'thinking') {
        const tb = block as unknown as { thinking: string; signature?: string }
        yield { type: 'thinking_delta', thinking: tb.thinking }
        if (tb.signature) yield { type: 'thinking_stop', signature: tb.signature }
      }
    }

    // Parse text-based tool calls if native tools not supported
    if (!toolsSupported && tools.length > 0) {
      yield* this.emitTextToolCalls(fullText)
    }

    // Emit message_stop
    yield {
      type: 'message_stop',
      stopReason: (response.stop_reason ?? 'end_turn') as StopReason,
    }
  }

  /**
   * Parse <tool_call> tags from model text and emit tool_use events.
   */
  private *emitTextToolCalls(text: string): Iterable<StreamEvent> {
    const { toolCalls } = parseTextToolCalls(text)
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      const id = `text_tool_${Date.now()}_${i}`
      yield { type: 'tool_use_start', id, name: tc.name }
      yield { type: 'tool_use_stop', id, input: tc.input }
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

  /**
   * Build system blocks with tool descriptions injected for models without native tool_use.
   */
  private buildSystemBlocksWithTools(
    baseBlocks: Anthropic.TextBlockParam[],
    tools: ToolSchema[],
  ): Anthropic.TextBlockParam[] {
    const toolPrompt = buildToolPrompt(tools)
    if (!toolPrompt) return baseBlocks
    return [
      ...baseBlocks,
      { type: 'text' as const, text: toolPrompt },
    ]
  }
}
