/**
 * Unified Provider Interface
 *
 * Design from Claude Code: decouple the agent loop from any specific LLM API.
 * The provider emits a normalized stream of events, so the agent loop
 * doesn't care whether it's talking to Anthropic, OpenAI, or Ollama.
 */

// --- Stream Events (normalized across providers) ---

export type StreamEvent =
  | { type: 'message_start'; messageId: string; usage?: TokenUsage }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; partialJson: string }
  | { type: 'tool_use_stop'; id: string; input: unknown }
  | { type: 'thinking_stop'; signature: string }
  | { type: 'message_stop'; stopReason: StopReason; usage?: TokenUsage }

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

// --- Message Types (conversation history) ---

export type Message = UserMessage | AssistantMessage

export interface UserMessage {
  role: 'user'
  content: UserContent[]
}

export interface AssistantMessage {
  role: 'assistant'
  content: AssistantContent[]
}

export type UserContent =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export type AssistantContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

// --- Tool Schema (for provider API) ---

export interface ToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown> // JSON Schema
}

// --- Provider Interface ---

export interface ProviderOptions {
  model: string
  maxTokens?: number
  systemPrompt?: string | string[]
  temperature?: number
  /** Extended thinking configuration */
  thinking?:
    | { type: 'disabled' }
    | { type: 'adaptive' }
    | { type: 'enabled'; budgetTokens: number }
  /** Structured output: force the model to respond with JSON matching this schema */
  outputSchema?: { name: string; schema: Record<string, unknown> }
}

export interface Provider {
  readonly name: string

  /**
   * Stream a response from the LLM.
   *
   * Key design: returns an async iterable of normalized StreamEvents.
   * This enables the StreamingToolExecutor to start executing tools
   * while the model is still generating.
   */
  stream(
    messages: Message[],
    tools: ToolSchema[],
    options: ProviderOptions,
  ): AsyncIterable<StreamEvent>

  /** Estimate token count for messages (for context management) */
  estimateTokens(messages: Message[]): number
}

// --- Tool-use graceful degradation helpers ---

/**
 * Build a text description of tools for injection into system prompt
 * when the model doesn't support native function calling.
 */
export function buildToolPrompt(tools: ToolSchema[]): string {
  if (tools.length === 0) return ''
  const descriptions = tools.map(t =>
    `- ${t.name}: ${t.description}\n  Input schema: ${JSON.stringify(t.inputSchema)}`
  ).join('\n')
  return [
    'You have access to the following tools. To call a tool, output EXACTLY this format (one per call):',
    '<tool_call>{"name": "tool_name", "input": {...}}</tool_call>',
    '',
    'Available tools:',
    descriptions,
  ].join('\n')
}

/**
 * Parse text-based tool calls from model output.
 * Models without native function calling are instructed to output:
 *   <tool_call>{"name":"...", "input":{...}}</tool_call>
 *
 * Returns the text with tool_call tags removed, plus parsed tool calls.
 */
export function parseTextToolCalls(text: string): {
  cleanText: string
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>
} {
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = []
  const cleanText = text.replace(
    /<tool_call>([\s\S]*?)<\/tool_call>/g,
    (_match, json: string) => {
      try {
        const parsed = JSON.parse(json.trim())
        if (parsed.name && typeof parsed.name === 'string') {
          toolCalls.push({
            name: parsed.name,
            input: parsed.input ?? {},
          })
        }
      } catch {
        // Malformed tool call — leave in text so user/agent can see it
        return _match
      }
      return ''
    },
  )
  return { cleanText: cleanText.trim(), toolCalls }
}

/**
 * Detect if an API error indicates the model doesn't support tool_use.
 */
export function isToolsNotSupportedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const status = 'status' in err ? (err as { status: number }).status : 0
  if (status !== 400 && status !== 404) return false
  const message = 'message' in err ? String((err as { message: string }).message) : ''
  const body = 'body' in err ? JSON.stringify((err as { body: unknown }).body) : ''
  const combined = (message + ' ' + body).toLowerCase()
  return combined.includes('tools') || combined.includes('function') || combined.includes('not supported')
}
