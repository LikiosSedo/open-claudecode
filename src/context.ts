/**
 * Context Window Manager
 *
 * Design from Claude Code src/services/compact/:
 * - Circuit breaker after 3 failures (autoCompact.ts)
 * - Cheapest strategy first: truncate, then LLM summarize (compact.ts)
 * - Reserve 20k output tokens (p99.99 of summary output, autoCompact.ts)
 * - <analysis> drafting scratchpad for better summaries (prompt.ts)
 */

import type { Message, Provider } from './providers/types.js'

// Compact prompt — from Claude Code src/services/compact/prompt.ts
const COMPACT_PROMPT = `Create a detailed summary of the conversation so far. This summary replaces the original messages, so capture everything needed to continue the work.

Before your summary, wrap analysis in <analysis> tags:
1. Chronologically trace each exchange — requests, approach, decisions, code changes
2. Note specific file names, code snippets, function signatures, file edits
3. Record all errors and how they were fixed
4. Pay special attention to user feedback

Then produce a <summary> with these sections:
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections (with snippets)
4. Errors and Fixes
5. Problem Solving
6. All User Messages (non-tool-result)
7. Pending Tasks
8. Current Work (what was happening right before this summary)
9. Optional Next Step (only if directly in line with user's last request)

Respond with text only. Do NOT call any tools.`

// Token estimation — chars/4 approximation (Claude Code uses roughTokenCountEstimation)
function estimateTokensForContent(content: string): number {
  return Math.ceil(content.length / 4)
}

function messageTokens(msg: Message): number {
  let total = 4 // per-message overhead (role, separators)
  for (const block of msg.content) {
    if (block.type === 'text' || block.type === 'thinking') {
      total += estimateTokensForContent(block.type === 'text' ? block.text : block.thinking)
    } else if (block.type === 'tool_result') {
      total += estimateTokensForContent(block.content)
    } else if (block.type === 'tool_use') {
      total += estimateTokensForContent(JSON.stringify(block.input)) + estimateTokensForContent(block.name)
    }
  }
  return total
}

/** Strip <analysis> scratchpad, extract <summary>. From Claude Code formatCompactSummary(). */
function formatCompactSummary(raw: string): string {
  let text = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, '')
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/)
  if (match) {
    text = `Summary:\n${match[1]!.trim()}`
  }
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

const MAX_CONSECUTIVE_FAILURES = 3 // from Claude Code autoCompact.ts
const MIN_RECENT_MESSAGES = 2      // absolute minimum preserved after truncation
const RECENT_TOKEN_RATIO = 0.3     // preserve tail messages up to 30% of budget

export class ContextManager {
  private maxTokens: number
  private reservedOutputTokens: number
  private compactThreshold: number
  private consecutiveFailures = 0

  constructor(options?: {
    maxTokens?: number              // default 200_000 (Claude's context window)
    reservedOutputTokens?: number   // default 20_000
    compactThreshold?: number       // default 0.85
  }) {
    this.maxTokens = options?.maxTokens ?? 200_000
    this.reservedOutputTokens = options?.reservedOutputTokens ?? 20_000
    this.compactThreshold = options?.compactThreshold ?? 0.85
  }

  private get budget(): number {
    return this.maxTokens - this.reservedOutputTokens
  }

  estimateTokens(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + messageTokens(m), 0)
  }

  /** Return context usage as a percentage (0–100). */
  getUsagePercent(messages: Message[]): number {
    const tokens = this.estimateTokens(messages)
    return Math.min(100, Math.round((tokens / this.budget) * 100))
  }

  needsCompaction(messages: Message[]): boolean {
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false
    return this.estimateTokens(messages) >= this.budget * this.compactThreshold
  }

  /**
   * Force compact — bypass needsCompaction() threshold and circuit breaker.
   * Used by reactive compact (413 recovery) where the API already rejected.
   */
  async forceCompact(
    messages: Message[],
    provider?: Provider,
    model?: string,
  ): Promise<{ messages: Message[]; compacted: boolean; summary?: string }> {
    return this.compactInternal(messages, provider, model)
  }

  /**
   * Compact conversation. Strategy ladder (cheapest first):
   * 1. Truncation — drop old messages, keep recent N
   * 2. LLM summary — summarize dropped messages via provider
   * 3. Circuit breaker — stop after 3 consecutive failures
   */
  async compact(
    messages: Message[],
    provider?: Provider,
    model?: string,
  ): Promise<{ messages: Message[]; compacted: boolean; summary?: string }> {
    if (!this.needsCompaction(messages)) {
      return { messages, compacted: false }
    }
    return this.compactInternal(messages, provider, model)
  }

  private async compactInternal(
    messages: Message[],
    provider?: Provider,
    model?: string,
  ): Promise<{ messages: Message[]; compacted: boolean; summary?: string }> {

    // Strategy 1: Truncation — keep recent messages based on token budget
    const recentTokenBudget = this.budget * RECENT_TOKEN_RATIO
    let recentCount = 0
    let recentTokens = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = messageTokens(messages[i]!)
      if (recentCount >= MIN_RECENT_MESSAGES && recentTokens + tokens > recentTokenBudget) break
      recentTokens += tokens
      recentCount++
    }
    recentCount = Math.max(recentCount, MIN_RECENT_MESSAGES)

    const kept = messages.slice(-recentCount)
    const dropped = messages.slice(0, -recentCount)

    if (dropped.length === 0) {
      // Nothing to drop — messages are all recent
      return { messages, compacted: false }
    }

    // If truncation alone brings us under threshold, use it
    if (this.estimateTokens(kept) < this.budget * this.compactThreshold) {
      this.consecutiveFailures = 0
      // Prepend a summary note about truncation
      const note: Message = {
        role: 'user',
        content: [{ type: 'text', text: `[Earlier conversation truncated — ${dropped.length} messages removed to free context. Recent messages preserved.]` }],
      }
      return { messages: [note, ...kept], compacted: true }
    }

    // Strategy 2: LLM summarization of dropped messages
    if (provider && model) {
      try {
        const summaryText = await this.summarizeMessages(dropped, provider, model)
        this.consecutiveFailures = 0

        const formatted = formatCompactSummary(summaryText)
        const summaryMsg: Message = {
          role: 'user',
          content: [{
            type: 'text',
            text: `This session is continued from an earlier conversation that was summarized:\n\n${formatted}\n\nResume directly — do not acknowledge the summary or recap what was happening.`,
          }],
        }
        return { messages: [summaryMsg, ...kept], compacted: true, summary: formatted }
      } catch {
        this.consecutiveFailures++
        // Fall through to truncation-only
      }
    }

    // Fallback: truncation without summary (lossy but keeps the session alive)
    const note: Message = {
      role: 'user',
      content: [{ type: 'text', text: `[Context compacted — ${dropped.length} older messages removed. Recent messages preserved.]` }],
    }
    return { messages: [note, ...kept], compacted: true }
  }

  /** LLM summarization — simplified from Claude Code's forked-agent pattern. */
  private async summarizeMessages(
    messages: Message[],
    provider: Provider,
    model: string,
  ): Promise<string> {
    const summaryMessages: Message[] = [
      ...messages,
      { role: 'user', content: [{ type: 'text', text: COMPACT_PROMPT }] },
    ]

    let result = ''
    for await (const event of provider.stream(summaryMessages, [], {
      model,
      maxTokens: Math.min(this.reservedOutputTokens, 16_000),
      systemPrompt: 'You are a conversation summarizer. Respond with text only. Do NOT call any tools.',
    })) {
      if (event.type === 'text_delta') {
        result += event.text
      }
    }

    if (!result.trim()) {
      throw new Error('Empty summary from LLM')
    }
    return result
  }
}
