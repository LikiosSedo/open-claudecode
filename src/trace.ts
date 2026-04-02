/**
 * Observability Tracing
 *
 * Lightweight trace events emitted by agentLoop at key instrumentation points.
 * SDK users provide an onTrace callback to observe LLM calls, tool executions,
 * permission decisions, compaction, and turn summaries.
 */

import type { StopReason, TokenUsage } from './providers/types.js'

export type TraceEvent =
  | { type: 'llm_start'; turn: number; model: string }
  | { type: 'llm_end'; turn: number; durationMs: number; usage: TokenUsage; stopReason: StopReason }
  | { type: 'tool_start'; turn: number; name: string; id: string; input: Record<string, unknown> }
  | { type: 'tool_end'; turn: number; name: string; id: string; durationMs: number; isError: boolean; outputSize: number }
  | { type: 'compact'; turn: number; beforeMessages: number; afterMessages: number }
  | { type: 'permission'; turn: number; tool: string; decision: 'allow' | 'deny'; durationMs: number }
  | { type: 'turn_summary'; turn: number; toolCalls: number; stopReason: StopReason; usage: TokenUsage; durationMs: number }

export type TraceCallback = (event: TraceEvent) => void

/** Simple console tracer for development/debugging. */
export function consoleTracer(event: TraceEvent): void {
  const ts = new Date().toISOString()
  switch (event.type) {
    case 'llm_start':
      console.log(`[trace ${ts}] llm_start turn=${event.turn} model=${event.model}`)
      break
    case 'llm_end':
      console.log(`[trace ${ts}] llm_end turn=${event.turn} ${event.durationMs}ms tokens_in=${event.usage.inputTokens} tokens_out=${event.usage.outputTokens} stop=${event.stopReason}`)
      break
    case 'tool_start':
      console.log(`[trace ${ts}] tool_start turn=${event.turn} ${event.name}(${event.id})`)
      break
    case 'tool_end':
      console.log(`[trace ${ts}] tool_end turn=${event.turn} ${event.name}(${event.id}) ${event.durationMs}ms error=${event.isError} size=${event.outputSize}`)
      break
    case 'compact':
      console.log(`[trace ${ts}] compact turn=${event.turn} messages ${event.beforeMessages} -> ${event.afterMessages}`)
      break
    case 'permission':
      console.log(`[trace ${ts}] permission turn=${event.turn} ${event.tool} ${event.decision} ${event.durationMs}ms`)
      break
    case 'turn_summary':
      console.log(`[trace ${ts}] turn_summary turn=${event.turn} tools=${event.toolCalls} stop=${event.stopReason} ${event.durationMs}ms`)
      break
  }
}
