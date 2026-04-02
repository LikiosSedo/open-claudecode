/**
 * OpenAI-Compatible Provider
 *
 * Works with: OpenAI, Ollama, Together, Groq, LM Studio, vLLM, etc.
 * Maps OpenAI's streaming format to our normalized StreamEvent.
 */

import OpenAI from 'openai'
import type {
  Provider, ProviderOptions, Message, ToolSchema,
  StreamEvent, StopReason,
} from './types.js'
import { buildToolPrompt, parseTextToolCalls, isToolsNotSupportedError } from './types.js'
import { isRetryableError, getBackoffDelay, MAX_RETRIES } from './retry.js'

export class OpenAIProvider implements Provider {
  readonly name: string
  private client: OpenAI

  constructor(options?: { apiKey?: string; baseURL?: string; name?: string }) {
    this.name = options?.name ?? 'openai'
    this.client = new OpenAI({
      apiKey: options?.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: options?.baseURL ?? process.env.OPENAI_BASE_URL,
    })
  }

  async *stream(
    messages: Message[],
    tools: ToolSchema[],
    options: ProviderOptions,
  ): AsyncIterable<StreamEvent> {
    const openaiTools: OpenAI.ChatCompletionTool[] = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))

    // Track whether native tools are supported by this model
    let toolsSupported = true

    // Build params (reused for streaming, non-streaming, and tool-less retries)
    const buildParams = (useTools: boolean) => {
      const systemPrompt = useTools
        ? options.systemPrompt
        : this.injectToolPrompt(options.systemPrompt, tools)
      const openaiMessages = this.convertMessages(messages, systemPrompt)
      return {
        model: options.model,
        max_tokens: options.maxTokens ?? 16384,
        messages: openaiMessages,
        tools: useTools && openaiTools.length > 0 ? openaiTools : undefined,
        ...(options.outputSchema ? {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: options.outputSchema.name,
              schema: options.outputSchema.schema,
              strict: true,
            },
          },
        } : {}),
      }
    }

    // Retry loop
    let lastError: unknown
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = getBackoffDelay(attempt, lastError)
        console.error(`[${this.name}] Retry ${attempt}/${MAX_RETRIES} after ${Math.round(delay)}ms`)
        await new Promise(r => setTimeout(r, delay))
      }

      const params = buildParams(toolsSupported)

      let stream
      try {
        stream = await this.client.chat.completions.create({
          ...params,
          stream: true,
          stream_options: { include_usage: true },
        })
      } catch (err) {
        // Detect models that don't support function calling
        if (isToolsNotSupportedError(err) && toolsSupported && tools.length > 0) {
          console.error(`[${this.name}] Model does not support tools — falling back to prompt-based tool calling`)
          toolsSupported = false
          lastError = err
          continue
        }
        lastError = err
        if (!isRetryableError(err) || attempt >= MAX_RETRIES) {
          yield* this.nonStreamingFallback(params, toolsSupported, tools)
          return
        }
        continue
      }

      // Consume the stream
      try {
        yield* this.consumeStream(stream, toolsSupported, tools)
        return
      } catch (streamErr) {
        lastError = streamErr
        if (!isRetryableError(streamErr) || attempt >= MAX_RETRIES) {
          console.error(`[${this.name}] Stream failed, falling back to non-streaming`)
          yield* this.nonStreamingFallback(params, toolsSupported, tools)
          return
        }
      }
    }
  }

  /**
   * Consume an OpenAI streaming response and yield normalized StreamEvents.
   */
  private async *consumeStream(
    stream: AsyncIterable<OpenAI.ChatCompletionChunk>,
    toolsSupported: boolean,
    tools: ToolSchema[],
  ): AsyncIterable<StreamEvent> {
    const toolCalls = new Map<number, { id: string; name: string; args: string }>()
    let lastToolIndex = -1
    let fullText = ''

    yield { type: 'message_start', messageId: '' }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      if (delta.content) {
        fullText += delta.content
        yield { type: 'text_delta', text: delta.content }
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          if (!toolCalls.has(idx) && idx > lastToolIndex && lastToolIndex >= 0) {
            const prev = toolCalls.get(lastToolIndex)
            if (prev) {
              let input: unknown
              try { input = JSON.parse(prev.args || '{}') } catch { input = {} }
              yield { type: 'tool_use_stop', id: prev.id, input }
            }
          }
          if (!toolCalls.has(idx)) {
            const id = tc.id ?? `call_${idx}`
            const name = tc.function?.name ?? ''
            toolCalls.set(idx, { id, name, args: '' })
            lastToolIndex = idx
            yield { type: 'tool_use_start', id, name }
          }
          const tracked = toolCalls.get(idx)!
          if (tc.function?.arguments) {
            tracked.args += tc.function.arguments
            yield { type: 'tool_use_delta', id: tracked.id, partialJson: tc.function.arguments }
          }
        }
      }

      const finishReason = chunk.choices[0]?.finish_reason
      if (finishReason) {
        if (lastToolIndex >= 0 && toolCalls.has(lastToolIndex)) {
          const last = toolCalls.get(lastToolIndex)!
          let input: unknown
          try { input = JSON.parse(last.args || '{}') } catch { input = {} }
          yield { type: 'tool_use_stop', id: last.id, input }
          toolCalls.delete(lastToolIndex)
        }

        // Parse text-based tool calls if native tools not supported
        if (!toolsSupported && tools.length > 0) {
          yield* this.emitTextToolCalls(fullText)
        }

        const usage = chunk.usage
        yield {
          type: 'message_stop',
          stopReason: this.mapFinishReason(finishReason),
          usage: usage ? {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
          } : undefined,
        }
      }
    }
  }

  /**
   * Non-streaming fallback: called after streaming retries are exhausted.
   */
  private async *nonStreamingFallback(
    params: Record<string, unknown>,
    toolsSupported: boolean,
    tools: ToolSchema[],
  ): AsyncIterable<StreamEvent> {
    console.error(`[${this.name}] Attempting non-streaming fallback`)
    const response = await this.client.chat.completions.create({
      ...params,
      stream: false,
    } as OpenAI.ChatCompletionCreateParamsNonStreaming) as OpenAI.ChatCompletion

    yield { type: 'message_start', messageId: response.id }

    const choice = response.choices[0]
    if (!choice) {
      yield { type: 'message_stop', stopReason: 'end_turn' }
      return
    }

    // Emit text content
    let fullText = ''
    if (choice.message.content) {
      fullText = choice.message.content
      yield { type: 'text_delta', text: choice.message.content }
    }

    // Emit native tool calls
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        const id = tc.id
        const name = tc.function.name
        let input: unknown
        try { input = JSON.parse(tc.function.arguments || '{}') } catch { input = {} }
        yield { type: 'tool_use_start', id, name }
        yield { type: 'tool_use_stop', id, input }
      }
    }

    // Parse text-based tool calls if native tools not supported
    if (!toolsSupported && tools.length > 0) {
      yield* this.emitTextToolCalls(fullText)
    }

    yield {
      type: 'message_stop',
      stopReason: this.mapFinishReason(choice.finish_reason ?? 'stop'),
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      } : undefined,
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

  /**
   * Inject tool descriptions into system prompt for models without function calling.
   */
  private injectToolPrompt(
    systemPrompt: string | string[] | undefined,
    tools: ToolSchema[],
  ): string | string[] | undefined {
    const toolPrompt = buildToolPrompt(tools)
    if (!toolPrompt) return systemPrompt
    if (!systemPrompt) return toolPrompt
    if (Array.isArray(systemPrompt)) return [...systemPrompt, toolPrompt]
    return systemPrompt + '\n\n' + toolPrompt
  }

  estimateTokens(messages: Message[]): number {
    return Math.ceil(JSON.stringify(messages).length / 4)
  }

  private convertMessages(
    messages: Message[],
    systemPrompt?: string | string[],
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = []

    if (systemPrompt) {
      const text = Array.isArray(systemPrompt) ? systemPrompt.join('\n\n') : systemPrompt
      result.push({ role: 'system', content: text })
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        // Check if it contains tool results
        const toolResults = msg.content.filter(c => c.type === 'tool_result')
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            if (tr.type === 'tool_result') {
              result.push({
                role: 'tool',
                tool_call_id: tr.toolUseId,
                content: tr.content,
              })
            }
          }
        } else {
          const text = msg.content
            .filter(c => c.type === 'text')
            .map(c => (c as { text: string }).text)
            .join('\n')
          result.push({ role: 'user', content: text })
        }
      } else {
        const content = msg.content
          .filter(c => c.type === 'text')
          .map(c => (c as { text: string }).text)
          .join('')
        const toolCalls = msg.content
          .filter(c => c.type === 'tool_use')
          .map(c => {
            const tu = c as { id: string; name: string; input: unknown }
            return {
              id: tu.id,
              type: 'function' as const,
              function: { name: tu.name, arguments: JSON.stringify(tu.input) },
            }
          })
        result.push({
          role: 'assistant',
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        })
      }
    }
    return result
  }

  private mapFinishReason(reason: string): StopReason {
    switch (reason) {
      case 'tool_calls': return 'tool_use'
      case 'length': return 'max_tokens'
      case 'stop': return 'end_turn'
      default: return 'end_turn'
    }
  }
}
