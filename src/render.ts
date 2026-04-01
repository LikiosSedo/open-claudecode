/**
 * Terminal Markdown Renderer
 *
 * Lightweight markdown-to-terminal renderer. No external dependencies
 * beyond chalk. Handles the most common markdown elements that LLMs produce:
 * code blocks (with keyword highlighting), inline code, headers, bold, lists.
 *
 * Two modes:
 * - renderMarkdown(text): full rendering for complete text (tool_result previews)
 * - renderInline(text): inline-only rendering for streaming text_delta
 */

import chalk from 'chalk'

// --- Keyword-based syntax highlighting ---

const KEYWORDS = new Set([
  // JS/TS
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'from',
  'return', 'if', 'else', 'for', 'while', 'async', 'await', 'try', 'catch',
  'throw', 'new', 'type', 'interface', 'enum', 'extends', 'implements',
  'default', 'switch', 'case', 'break', 'continue', 'typeof', 'instanceof',
  'void', 'null', 'undefined', 'true', 'false', 'yield', 'of', 'in',
  // Python
  'def', 'class', 'import', 'from', 'return', 'if', 'elif', 'else',
  'for', 'while', 'try', 'except', 'raise', 'with', 'as', 'lambda',
  'None', 'True', 'False', 'pass', 'yield', 'async', 'await',
  // Go
  'func', 'package', 'import', 'return', 'if', 'else', 'for', 'range',
  'switch', 'case', 'default', 'struct', 'interface', 'map', 'chan',
  'go', 'defer', 'select', 'var', 'const', 'type', 'nil',
  // Rust
  'fn', 'pub', 'mod', 'use', 'struct', 'impl', 'enum', 'trait',
  'let', 'mut', 'match', 'loop', 'self', 'Self', 'crate', 'super',
  'where', 'move', 'ref', 'static', 'unsafe',
])

function highlightCode(line: string, _lang: string): string {
  let result = ''
  let i = 0
  const len = line.length

  while (i < len) {
    // String literals: '...', "...", `...`
    if (line[i] === '"' || line[i] === "'" || line[i] === '`') {
      const quote = line[i]!
      let j = i + 1
      while (j < len && line[j] !== quote) {
        if (line[j] === '\\') j++ // skip escaped char
        j++
      }
      result += chalk.green(line.slice(i, j + 1))
      i = j + 1
      continue
    }

    // Line comments: // or #
    if ((line[i] === '/' && line[i + 1] === '/') || (line[i] === '#' && (i === 0 || line[i - 1] === ' '))) {
      result += chalk.dim(line.slice(i))
      break
    }

    // Words: keywords or numbers
    if (/[a-zA-Z_]/.test(line[i]!)) {
      let j = i
      while (j < len && /[a-zA-Z0-9_]/.test(line[j]!)) j++
      const word = line.slice(i, j)
      result += KEYWORDS.has(word) ? chalk.blue(word) : word
      i = j
      continue
    }

    // Numbers
    if (/[0-9]/.test(line[i]!)) {
      let j = i
      while (j < len && /[0-9.xXa-fA-F_]/.test(line[j]!)) j++
      result += chalk.yellow(line.slice(i, j))
      i = j
      continue
    }

    result += line[i]
    i++
  }

  return result
}

// --- Full markdown rendering ---

/**
 * Render markdown text for terminal output.
 * Handles: code blocks (``` with lang), inline code (`),
 * headers (#), bold (**), links, lists.
 */
export function renderMarkdown(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let codeLang = ''

  for (const line of lines) {
    // Code block fence
    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeLang = line.trimStart().slice(3).trim()
        const label = codeLang || 'code'
        result.push(chalk.dim(`  \u250c\u2500 ${label} ${'\u2500'.repeat(Math.max(0, 40 - label.length))}`))
      } else {
        inCodeBlock = false
        codeLang = ''
        result.push(chalk.dim(`  \u2514${'\u2500'.repeat(44)}`))
      }
      continue
    }

    if (inCodeBlock) {
      result.push('  ' + highlightCode(line, codeLang))
      continue
    }

    // Headers
    const headerMatch = line.match(/^(#{1,3}) (.+)/)
    if (headerMatch) {
      result.push(chalk.bold.underline(headerMatch[2]!))
      continue
    }

    // Inline formatting
    result.push(renderInline(line))
  }

  return result.join('\n')
}

// --- Inline-only rendering (safe for streaming) ---

/**
 * Render inline markdown formatting only.
 * Safe to call on partial/streaming text: bold, inline code, list bullets.
 */
export function renderInline(text: string): string {
  let result = text

  // Bold **text**
  result = result.replace(/\*\*(.+?)\*\*/g, (_, t) => chalk.bold(t))

  // Inline code `text`
  result = result.replace(/`([^`]+)`/g, (_, t) => chalk.cyan(t))

  // List items (- or *)
  result = result.replace(/^(\s*)[-*] /, '$1\u2022 ')

  return result
}
