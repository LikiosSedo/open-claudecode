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
