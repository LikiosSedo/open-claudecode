/**
 * Session Persistence — JSONL-based incremental session storage
 *
 * Design inspired by Claude Code's sessionStorage.ts:
 * - Each session is a .jsonl file (one JSON object per line)
 * - First line: metadata (project dir, model, timestamps)
 * - Subsequent lines: conversation messages (user + assistant)
 * - Append-only: new messages are appended, never rewriting the file
 * - Session ID: Date.now() in base36 for short, sortable IDs
 */

import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import type { Message } from './providers/types.js'

export interface SessionMetadata {
  type: 'metadata'
  projectDir: string
  model: string
  createdAt: string
}

export interface SessionMessageEntry {
  type: 'message'
  role: 'user' | 'assistant'
  content: unknown[]
}

export interface SessionInfo {
  id: string
  projectDir: string
  createdAt: string
  messageCount: number
  lastInput: string // preview of last user message
}

export class SessionManager {
  private sessionDir: string
  private _currentSessionId: string | null = null

  constructor(options?: { sessionDir?: string }) {
    this.sessionDir = options?.sessionDir ?? join(homedir(), '.occ', 'sessions')
  }

  get currentSessionId(): string | null {
    return this._currentSessionId
  }

  /** Ensure sessions directory exists. */
  async ensureDir(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true })
  }

  /** Create a new session and return its ID. */
  async createSession(projectDir: string, model: string): Promise<string> {
    const id = Date.now().toString(36)
    this._currentSessionId = id

    await this.ensureDir()
    const metadata: SessionMetadata = {
      type: 'metadata',
      projectDir,
      model,
      createdAt: new Date().toISOString(),
    }
    const filePath = join(this.sessionDir, `${id}.jsonl`)
    await writeFile(filePath, JSON.stringify(metadata) + '\n', { mode: 0o600 })
    return id
  }

  /** Resume an existing session. */
  setCurrentSession(sessionId: string): void {
    this._currentSessionId = sessionId
  }

  /** Append new messages to the current session file (incremental JSONL). */
  async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    if (messages.length === 0) return

    const filePath = join(this.sessionDir, `${sessionId}.jsonl`)
    const lines = messages.map(msg => {
      const entry: SessionMessageEntry = {
        type: 'message',
        role: msg.role,
        content: msg.content,
      }
      return JSON.stringify(entry)
    })
    await appendFile(filePath, lines.join('\n') + '\n', { mode: 0o600 })
  }

  /** Load all messages from a session file. */
  async loadSession(sessionId: string): Promise<{ messages: Message[]; metadata: SessionMetadata }> {
    const filePath = join(this.sessionDir, `${sessionId}.jsonl`)
    const raw = await readFile(filePath, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim())

    let metadata: SessionMetadata | null = null
    const messages: Message[] = []

    for (const line of lines) {
      const entry = JSON.parse(line) as SessionMetadata | SessionMessageEntry
      if (entry.type === 'metadata') {
        metadata = entry as SessionMetadata
      } else if (entry.type === 'message') {
        messages.push({ role: entry.role, content: entry.content } as Message)
      }
    }

    if (!metadata) {
      throw new Error(`Session ${sessionId} has no metadata`)
    }

    return { messages, metadata }
  }

  /** List recent sessions, newest first. */
  async listSessions(limit = 20): Promise<SessionInfo[]> {
    await this.ensureDir()

    let files: string[]
    try {
      const entries = await readdir(this.sessionDir)
      files = entries.filter(f => f.endsWith('.jsonl'))
    } catch {
      return []
    }

    // Sort by filename (which is timestamp-based) descending
    files.sort((a, b) => b.localeCompare(a))
    files = files.slice(0, limit)

    const results: SessionInfo[] = []
    for (const file of files) {
      try {
        const info = await this.readSessionInfo(file)
        if (info) results.push(info)
      } catch {
        // Skip corrupted session files
      }
    }

    return results
  }

  /** Read session info from a .jsonl file (metadata + last user message preview). */
  private async readSessionInfo(filename: string): Promise<SessionInfo | null> {
    const id = basename(filename, '.jsonl')
    const filePath = join(this.sessionDir, filename)
    const raw = await readFile(filePath, 'utf-8')
    const lines = raw.split('\n').filter(l => l.trim())

    if (lines.length === 0) return null

    const first = JSON.parse(lines[0]!) as SessionMetadata
    if (first.type !== 'metadata') return null

    // Count messages and find last user input
    let messageCount = 0
    let lastInput = ''
    for (let i = 1; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]!) as SessionMessageEntry
      if (entry.type === 'message') {
        messageCount++
        if (entry.role === 'user') {
          // Extract text from content blocks
          const textBlock = (entry.content as Array<{ type: string; text?: string }>)
            .find(c => c.type === 'text')
          if (textBlock?.text) {
            lastInput = textBlock.text.slice(0, 80)
          }
        }
      }
    }

    return {
      id,
      projectDir: first.projectDir,
      createdAt: first.createdAt,
      messageCount,
      lastInput,
    }
  }
}
