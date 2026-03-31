/**
 * API retry utilities — shared between providers.
 * Design from Claude Code src/services/api/withRetry.ts
 */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529])
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 30_000
const JITTER_FACTOR = 0.25

export function isRetryableError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    return RETRYABLE_STATUS.has((err as { status: number }).status)
  }
  if (err instanceof Error) {
    const msg = err.message
    return msg.includes('ECONNRESET') || msg.includes('EPIPE') || msg.includes('fetch failed')
  }
  return false
}

export function getRetryAfterMs(err: unknown): number | null {
  if (err && typeof err === 'object' && 'headers' in err) {
    const headers = (err as { headers?: { get?: (k: string) => string | null } }).headers
    const value = headers?.get?.('retry-after')
    if (value) {
      const seconds = parseInt(value, 10)
      if (!isNaN(seconds)) return seconds * 1000
    }
  }
  return null
}

export function getBackoffDelay(attempt: number, lastError?: unknown): number {
  const retryAfter = lastError ? getRetryAfterMs(lastError) : null
  if (retryAfter !== null) return Math.min(retryAfter, MAX_DELAY_MS)
  const base = BASE_DELAY_MS * Math.pow(2, attempt - 1)
  const jitter = Math.random() * JITTER_FACTOR * base
  return Math.min(base + jitter, MAX_DELAY_MS)
}

export const MAX_RETRIES = 3
