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
    const openaiMessages = this.convertMessages(messages, options.systemPrompt)

    const openaiTools: OpenAI.ChatCompletionTool[] = tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))

    const stream = await this.client.chat.completions.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 16384,
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      stream: true,
    })

    // Track tool call accumulation (OpenAI streams tool calls differently)
    const toolCalls = new Map<number, { id: string; name: string; args: string }>()

    yield { type: 'message_start', messageId: '' }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      // Text content
      if (delta.content) {
        yield { type: 'text_delta', text: delta.content }
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          if (!toolCalls.has(idx)) {
            const id = tc.id ?? `call_${idx}`
            const name = tc.function?.name ?? ''
            toolCalls.set(idx, { id, name, args: '' })
            yield { type: 'tool_use_start', id, name }
          }
          const tracked = toolCalls.get(idx)!
          if (tc.function?.arguments) {
            tracked.args += tc.function.arguments
            yield { type: 'tool_use_delta', id: tracked.id, partialJson: tc.function.arguments }
          }
        }
      }

      // Finish
      const finishReason = chunk.choices[0]?.finish_reason
      if (finishReason) {
        // Emit completed tool_use_stop for all tracked tools
        for (const [, tc] of toolCalls) {
          let input: unknown
          try { input = JSON.parse(tc.args || '{}') } catch { input = {} }
          yield { type: 'tool_use_stop', id: tc.id, input }
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
