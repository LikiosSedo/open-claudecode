/**
 * Memory System — Cross-session persistent memory
 *
 * Design from Claude Code src/memdir/:
 * - MEMORY.md is an index file (max 200 lines / 25KB), each line points to a memory file
 * - Memory files have frontmatter (name, description, type: user/feedback/project/reference)
 * - Memory directory: ~/.occ/projects/{projectDirHash}/memory/
 * - What NOT to save: code patterns, git history, debug solutions (derivable from project state)
 */

import { readdir, readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join, basename } from 'path'

// --- Types ---

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export interface MemoryFile {
  path: string
  name: string
  description: string
  type: MemoryType
  content: string
}

// --- Constants ---

const ENTRYPOINT_NAME = 'MEMORY.md'
const MAX_ENTRYPOINT_LINES = 200
const MAX_ENTRYPOINT_BYTES = 25_000
const OCC_CONFIG_DIR = '.occ'

// --- Frontmatter Parsing ---

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Simple regex-based parser — no external dependency.
 * Handles the `---\n...\n---` block at the top of the file.
 */
function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>
  content: string
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, content: raw }
  }

  const frontmatter: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key && value) {
      frontmatter[key] = value
    }
  }

  return { frontmatter, content: match[2] }
}

/**
 * Build frontmatter string for a memory file.
 */
function buildFrontmatter(meta: {
  name: string
  description: string
  type: MemoryType
}): string {
  return [
    '---',
    `name: ${meta.name}`,
    `description: ${meta.description}`,
    `type: ${meta.type}`,
    '---',
    '',
  ].join('\n')
}

// --- Path Utilities ---

/**
 * Sanitize a path for use as a directory name.
 * Replaces non-alphanumeric characters with hyphens, truncates, and appends a hash.
 * Compatible with Claude Code's sanitizePath().
 */
function sanitizePath(name: string): string {
  const MAX_LEN = 80
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_LEN) {
    return sanitized
  }
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${sanitized.slice(0, MAX_LEN)}-${hash}`
}

/**
 * Get the default OCC config home directory.
 */
function getOccConfigHome(): string {
  return join(homedir(), OCC_CONFIG_DIR)
}

// --- Truncation ---

export interface EntrypointTruncation {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

/**
 * Truncate MEMORY.md content to line AND byte caps.
 * Line-truncates first, then byte-truncates at last newline.
 * Design from Claude Code truncateEntrypointContent().
 */
function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split('\n')
  const lineCount = contentLines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated }
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${byteCount} bytes (limit: ${MAX_ENTRYPOINT_BYTES})`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
        : `${lineCount} lines and ${byteCount} bytes`

  return {
    content:
      truncated +
      `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries concise.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

// --- MemoryManager ---

export class MemoryManager {
  private _memoryPath: string

  constructor(options: { projectDir: string; memoryDir?: string }) {
    if (process.env.OCC_MEMORY_DIR) {
      this._memoryPath = process.env.OCC_MEMORY_DIR
    } else if (options.memoryDir) {
      this._memoryPath = options.memoryDir
    } else {
      const projectsDir = join(getOccConfigHome(), 'projects')
      this._memoryPath = join(projectsDir, sanitizePath(options.projectDir), 'memory')
    }
  }

  /** Absolute path to the memory directory. */
  get memoryPath(): string {
    return this._memoryPath
  }

  /** Ensure the memory directory exists. */
  async ensureDir(): Promise<void> {
    await mkdir(this._memoryPath, { recursive: true })
  }

  /**
   * Load MEMORY.md index content, truncated to 200 lines / 25KB.
   * Returns empty string if no MEMORY.md exists yet.
   */
  async loadMemoryIndex(): Promise<string> {
    const entrypoint = join(this._memoryPath, ENTRYPOINT_NAME)
    try {
      const raw = await readFile(entrypoint, 'utf-8')
      if (!raw.trim()) return ''
      const t = truncateEntrypointContent(raw)
      return t.content
    } catch {
      return ''
    }
  }

  /**
   * Scan all .md files in the memory directory, parse frontmatter.
   * Excludes MEMORY.md itself. Returns memory files sorted by name.
   */
  async scanMemories(): Promise<MemoryFile[]> {
    try {
      const entries = await readdir(this._memoryPath)
      const mdFiles = entries.filter(
        f => f.endsWith('.md') && f !== ENTRYPOINT_NAME,
      )

      const results = await Promise.allSettled(
        mdFiles.map(async (filename): Promise<MemoryFile> => {
          const filePath = join(this._memoryPath, filename)
          const raw = await readFile(filePath, 'utf-8')
          const { frontmatter, content } = parseFrontmatter(raw)
          return {
            path: filePath,
            name: frontmatter.name || filename.replace('.md', ''),
            description: frontmatter.description || '',
            type: (MEMORY_TYPES.includes(frontmatter.type as MemoryType)
              ? frontmatter.type
              : 'project') as MemoryType,
            content: content.trim(),
          }
        }),
      )

      return results
        .filter((r): r is PromiseFulfilledResult<MemoryFile> => r.status === 'fulfilled')
        .map(r => r.value)
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return []
    }
  }

  /**
   * Save a new memory file and update the MEMORY.md index.
   * Creates the memory directory if it doesn't exist.
   */
  async saveMemory(memory: {
    name: string
    description: string
    type: MemoryType
    content: string
    fileName: string
  }): Promise<void> {
    await this.ensureDir()

    // Write the memory file with frontmatter
    const filePath = join(this._memoryPath, memory.fileName)
    const fileContent =
      buildFrontmatter({ name: memory.name, description: memory.description, type: memory.type }) +
      memory.content

    await writeFile(filePath, fileContent, 'utf-8')

    // Update MEMORY.md index
    await this.updateIndex(memory.fileName, memory.description)
  }

  /**
   * Delete a memory file and remove its entry from MEMORY.md.
   */
  async deleteMemory(fileName: string): Promise<void> {
    const filePath = join(this._memoryPath, fileName)
    try {
      await unlink(filePath)
    } catch {
      // File may not exist — that's fine
    }
    await this.removeFromIndex(fileName)
  }

  // --- Private helpers ---

  /**
   * Add or update an entry in MEMORY.md.
   * Each entry is: `- [fileName](fileName) — description`
   */
  private async updateIndex(fileName: string, description: string): Promise<void> {
    const entrypoint = join(this._memoryPath, ENTRYPOINT_NAME)
    let lines: string[] = []

    try {
      const raw = await readFile(entrypoint, 'utf-8')
      lines = raw.split('\n')
    } catch {
      lines = ['# Memory Index', '']
    }

    // Remove existing entry for this file (if updating)
    const entryPattern = `[${fileName}]`
    lines = lines.filter(l => !l.includes(entryPattern))

    // Ensure header exists
    if (!lines.some(l => l.startsWith('# '))) {
      lines.unshift('# Memory Index', '')
    }

    // Append new entry
    const entry = `- [${fileName}](${fileName}) — ${description}`
    lines.push(entry)

    // Remove trailing empty lines, add one
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop()
    }
    lines.push('')

    await writeFile(entrypoint, lines.join('\n'), 'utf-8')
  }

  /**
   * Remove an entry from MEMORY.md.
   */
  private async removeFromIndex(fileName: string): Promise<void> {
    const entrypoint = join(this._memoryPath, ENTRYPOINT_NAME)
    try {
      const raw = await readFile(entrypoint, 'utf-8')
      const entryPattern = `[${fileName}]`
      const lines = raw.split('\n').filter(l => !l.includes(entryPattern))
      await writeFile(entrypoint, lines.join('\n'), 'utf-8')
    } catch {
      // No index file — nothing to remove from
    }
  }
}

// --- CLAUDE.md Discovery ---

/**
 * Discover and load CLAUDE.md files.
 * Resolution order (lower priority first, higher priority last):
 *   1. ~/.claude/CLAUDE.md — User's private global instructions
 *   2. {cwd}/CLAUDE.md — Project instructions (checked into codebase)
 *
 * Files closer to the user have higher priority (loaded later in the prompt).
 */
export async function loadClaudeMdFiles(cwd: string): Promise<string> {
  const files: Array<{ path: string; label: string }> = [
    { path: join(homedir(), '.claude', 'CLAUDE.md'), label: "user's private global instructions" },
    { path: join(cwd, 'CLAUDE.md'), label: 'project instructions, checked into the codebase' },
  ]

  const sections: string[] = []

  for (const file of files) {
    try {
      const content = await readFile(file.path, 'utf-8')
      if (content.trim()) {
        sections.push(`Contents of ${file.path} (${file.label}):\n\n${content.trim()}`)
      }
    } catch {
      // File doesn't exist — skip silently
    }
  }

  return sections.join('\n\n')
}
