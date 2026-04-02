/**
 * API retry utilities — shared between providers.
 * Design from Claude Code src/services/api/withRetry.ts
 */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529])
const CIRCUIT_BREAKER_WAIT_MS = 30_000
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 30_000
const JITTER_FACTOR = 0.25

/**
 * Classify error for retry strategy:
 * - 'retry': transient, worth retrying (429, 5xx, network)
 * - 'circuit_breaker': server is overloaded, stop all requests and wait
 * - 'fatal': permanent error, don't retry (400, 401, 403, 404)
 */
export function classifyError(err: unknown): 'retry' | 'circuit_breaker' | 'fatal' {
  if (err && typeof err === 'object') {
    const status = 'status' in err ? (err as { status: number }).status : 0
    const message = 'message' in err ? String((err as { message: string }).message) : ''

    // Circuit breaker: server explicitly says stop
    if (message.includes('circuit breaker')) return 'circuit_breaker'

    // Retryable status codes
    if (RETRYABLE_STATUS.has(status)) return 'retry'

    // 4xx = fatal (except 429 which is in RETRYABLE_STATUS)
    if (status >= 400 && status < 500) return 'fatal'
  }

  // Network errors are retryable
  if (err instanceof Error) {
    const msg = err.message
    if (msg.includes('ECONNRESET') || msg.includes('EPIPE') || msg.includes('fetch failed')) return 'retry'
  }

  return 'fatal'
}

/** Backward-compatible: returns true for 'retry' errors only. */
export function isRetryableError(err: unknown): boolean {
  return classifyError(err) === 'retry'
}

/** Is this a circuit breaker error? Caller should wait, not retry. */
export function isCircuitBreakerError(err: unknown): boolean {
  return classifyError(err) === 'circuit_breaker'
}

/** How long to wait for circuit breaker recovery. */
export function getCircuitBreakerWaitMs(): number {
  return CIRCUIT_BREAKER_WAIT_MS
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

// --- Rate Limiter: enforce minimum interval between API calls ---

export class RateLimiter {
  private lastCallTime = 0
  private readonly minIntervalMs: number

  constructor(minIntervalMs: number = 500) {
    this.minIntervalMs = minIntervalMs
  }

  /** Wait if needed to respect the minimum interval. */
  async throttle(): Promise<void> {
    const now = Date.now()
    const elapsed = now - this.lastCallTime
    if (elapsed < this.minIntervalMs) {
      await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed))
    }
    this.lastCallTime = Date.now()
  }
}
