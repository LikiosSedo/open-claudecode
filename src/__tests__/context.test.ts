import { describe, it, expect } from 'vitest'
import { ContextManager } from '../context.js'
import type { Message } from '../providers/types.js'

function textMsg(role: 'user' | 'assistant', text: string): Message {
  if (role === 'user') {
    return { role: 'user', content: [{ type: 'text', text }] }
  }
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

describe('ContextManager', () => {
  it('estimateTokens returns reasonable estimate', () => {
    const cm = new ContextManager()
    // "hello" is 5 chars => ~2 tokens + 4 overhead = 6
    const tokens = cm.estimateTokens([textMsg('user', 'hello')])
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(20)
  })

  it('needsCompaction returns false for empty messages', () => {
    const cm = new ContextManager()
    expect(cm.needsCompaction([])).toBe(false)
  })

  it('needsCompaction returns true when over threshold', () => {
    // budget = 200k - 20k = 180k, threshold 85% = 153k tokens
    // 153k tokens ~= 612k chars. Use a big message.
    const cm = new ContextManager({ maxTokens: 1000, reservedOutputTokens: 0, compactThreshold: 0.5 })
    // budget = 1000, threshold 50% = 500 tokens. 500 tokens ~= 2000 chars
    const bigText = 'x'.repeat(2100)
    expect(cm.needsCompaction([textMsg('user', bigText)])).toBe(true)
  })

  it('compact truncates old messages', async () => {
    const cm = new ContextManager({ maxTokens: 200, reservedOutputTokens: 0, compactThreshold: 0.3 })
    // Create enough messages to exceed threshold (200 * 0.3 = 60 tokens)
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      messages.push(textMsg('user', `Message number ${i} with some padding text here`))
    }

    const result = await cm.compact(messages)
    expect(result.compacted).toBe(true)
    // Should have fewer messages than original
    expect(result.messages.length).toBeLessThan(messages.length)
    // First message should be the truncation note
    const firstContent = result.messages[0]!.content[0]!
    expect(firstContent.type).toBe('text')
    expect((firstContent as { type: 'text'; text: string }).text).toContain('truncated')
  })

  it('circuit breaker stops after 3 failures', async () => {
    const cm = new ContextManager({ maxTokens: 100, reservedOutputTokens: 0, compactThreshold: 0.1 })
    const bigMessages: Message[] = Array.from({ length: 30 }, (_, i) =>
      textMsg('user', `padding text message ${i} ${'x'.repeat(50)}`),
    )

    // Simulate failures by providing a provider that throws
    const failProvider = {
      stream: () => { throw new Error('fail') },
    } as any

    // Compact 3 times with provider that fails (triggers circuit breaker internally)
    // Each call that can't drop enough will try LLM summarization and fail
    for (let i = 0; i < 3; i++) {
      await cm.compact(bigMessages, failProvider, 'model')
    }

    // After 3 failures, circuit breaker should prevent further compaction attempts
    expect(cm.needsCompaction(bigMessages)).toBe(false)
  })
})
