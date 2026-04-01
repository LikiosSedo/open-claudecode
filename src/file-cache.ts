/**
 * File Read Cache — mtime-based LRU invalidation
 *
 * Design from Claude Code (utils/fileReadCache.ts):
 * - Caches file contents keyed by path
 * - Validates via stat().mtimeMs — stale entries are re-read automatically
 * - LRU eviction when cache exceeds max size
 * - Explicit invalidate() for after Write/Edit mutations
 */

import { stat } from 'fs/promises'
import { readFile } from 'fs/promises'

interface CachedEntry {
  content: string
  mtimeMs: number
}

export class FileReadCache {
  private cache = new Map<string, CachedEntry>()

  constructor(private readonly maxSize = 100) {}

  /**
   * Get cached file content if mtime still matches.
   * Returns null on miss or stale entry (caller should readFile and call set).
   */
  async get(filePath: string): Promise<string | null> {
    const entry = this.cache.get(filePath)
    if (!entry) return null

    try {
      const st = await stat(filePath)
      if (st.mtimeMs === entry.mtimeMs) {
        // Move to end for LRU ordering
        this.cache.delete(filePath)
        this.cache.set(filePath, entry)
        return entry.content
      }
    } catch {
      // File deleted — drop stale entry
      this.cache.delete(filePath)
    }
    return null
  }

  /**
   * Store file content with its current mtime.
   */
  set(filePath: string, content: string, mtimeMs: number): void {
    // Delete first so re-insertion moves to end (LRU)
    this.cache.delete(filePath)
    this.cache.set(filePath, { content, mtimeMs })

    // Evict oldest (first) entry if over capacity
    if (this.cache.size > this.maxSize) {
      const oldest = this.cache.keys().next().value
      if (oldest) this.cache.delete(oldest)
    }
  }

  /**
   * Remove a path from cache. Call after Write/Edit mutations.
   */
  invalidate(filePath: string): void {
    this.cache.delete(filePath)
  }

  /**
   * Read a file, using the cache when possible.
   * This is the primary entry point — handles get/set internally.
   */
  async readFile(filePath: string): Promise<string> {
    const cached = await this.get(filePath)
    if (cached !== null) return cached

    const content = await readFile(filePath, 'utf-8')
    const st = await stat(filePath)
    this.set(filePath, content, st.mtimeMs)
    return content
  }
}
