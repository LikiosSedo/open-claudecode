/**
 * ToolSearchTool — Lets the LLM discover and load deferred tool schemas on demand.
 *
 * Design from Claude Code's ToolSearchTool:
 * - Tools with shouldDefer=true are not sent in the initial prompt (saves tokens)
 * - The LLM calls ToolSearch to find tools by name or keywords
 * - Discovered tools are persisted for the rest of the session
 *
 * Query formats:
 *   "select:Read,Edit,Grep"  — exact name match (comma-separated)
 *   "+slack send"            — require "slack", rank by "send"
 *   "notebook jupyter"       — keyword search, return top N
 */

import { z } from 'zod'
import type { Tool, ToolContext, ToolResult, ToolRegistry } from './types.js'

export const TOOL_SEARCH_NAME = 'ToolSearch'

const inputSchema = z.object({
  query: z.string().describe(
    'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search, "+slack send" requires term',
  ),
  max_results: z.number().optional().describe('Maximum number of results to return (default: 5)'),
})

// --- Tool name parsing (from Claude Code) ---

interface ParsedToolName {
  parts: string[]
  full: string
  isMcp: boolean
}

function parseToolName(name: string): ParsedToolName {
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.replace(/^mcp__/, '').toLowerCase()
    const parts = withoutPrefix.split('__').flatMap(p => p.split('_'))
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, ' ').replace(/_/g, ' '),
      isMcp: true,
    }
  }

  // Regular tool — split CamelCase and underscores
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  return { parts, full: parts.join(' '), isMcp: false }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// --- Search logic ---

/** Handle "select:name1,name2" queries — exact tool name lookup */
function handleSelectQuery(
  requested: string[],
  registry: ToolRegistry,
): string[] {
  const deferredTools = registry.deferredTools()
  const allTools = registry.all()
  const found: string[] = []

  for (const name of requested) {
    const nameLower = name.toLowerCase()
    // Check deferred first, then all (selecting an already-loaded tool is a harmless no-op)
    const tool =
      deferredTools.find(t => t.name.toLowerCase() === nameLower) ??
      allTools.find(t => t.name.toLowerCase() === nameLower)
    if (tool && !found.includes(tool.name)) {
      found.push(tool.name)
    }
  }

  return found
}

/** Keyword search over deferred tool names, searchHints, and descriptions */
function searchToolsWithKeywords(
  query: string,
  registry: ToolRegistry,
  maxResults: number,
): string[] {
  const deferredTools = registry.deferredTools()
  const queryLower = query.toLowerCase().trim()

  // Fast path: exact name match
  const exactMatch =
    deferredTools.find(t => t.name.toLowerCase() === queryLower) ??
    registry.all().find(t => t.name.toLowerCase() === queryLower)
  if (exactMatch) return [exactMatch.name]

  // MCP prefix match: "mcp__server" matches all tools from that server
  if (queryLower.startsWith('mcp__') && queryLower.length > 5) {
    const prefixMatches = deferredTools
      .filter(t => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map(t => t.name)
    if (prefixMatches.length > 0) return prefixMatches
  }

  // Parse query into required (+prefixed) and optional terms
  const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 0)
  const requiredTerms: string[] = []
  const optionalTerms: string[] = []
  for (const term of queryTerms) {
    if (term.startsWith('+') && term.length > 1) {
      requiredTerms.push(term.slice(1))
    } else {
      optionalTerms.push(term)
    }
  }

  const allScoringTerms = requiredTerms.length > 0
    ? [...requiredTerms, ...optionalTerms]
    : queryTerms

  // Pre-compile word-boundary regexes
  const termPatterns = new Map<string, RegExp>()
  for (const term of allScoringTerms) {
    if (!termPatterns.has(term)) {
      termPatterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`))
    }
  }

  // Pre-filter: if required terms exist, only keep tools matching ALL of them
  let candidates = deferredTools
  if (requiredTerms.length > 0) {
    candidates = deferredTools.filter(tool => {
      const parsed = parseToolName(tool.name)
      const descLower = tool.description.toLowerCase()
      const hintLower = tool.searchHint?.toLowerCase() ?? ''

      return requiredTerms.every(term => {
        const pattern = termPatterns.get(term)!
        return (
          parsed.parts.includes(term) ||
          parsed.parts.some(part => part.includes(term)) ||
          pattern.test(descLower) ||
          (hintLower && pattern.test(hintLower))
        )
      })
    })
  }

  // Score each candidate
  const scored = candidates.map(tool => {
    const parsed = parseToolName(tool.name)
    const descLower = tool.description.toLowerCase()
    const hintLower = tool.searchHint?.toLowerCase() ?? ''

    let score = 0
    for (const term of allScoringTerms) {
      const pattern = termPatterns.get(term)!

      // Name part match (highest signal)
      if (parsed.parts.includes(term)) {
        score += parsed.isMcp ? 12 : 10
      } else if (parsed.parts.some(part => part.includes(term))) {
        score += parsed.isMcp ? 6 : 5
      }

      // Full name fallback
      if (parsed.full.includes(term) && score === 0) {
        score += 3
      }

      // searchHint match (curated keywords, higher than description)
      if (hintLower && pattern.test(hintLower)) {
        score += 4
      }

      // Description match (word-boundary to avoid false positives)
      if (pattern.test(descLower)) {
        score += 2
      }
    }

    return { name: tool.name, score }
  })

  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(item => item.name)
}

// --- Format tool schemas for LLM consumption ---

function formatToolSchemas(toolNames: string[], registry: ToolRegistry): string {
  const schemas: string[] = []
  for (const name of toolNames) {
    const tool = registry.get(name)
    if (!tool) continue

    const jsonSchema = tool.rawJsonSchema ?? registry.zodToJsonSchema(tool.inputSchema)
    const entry = JSON.stringify({
      description: tool.description,
      name: tool.name,
      parameters: jsonSchema,
    })
    schemas.push(`<function>${entry}</function>`)
  }

  if (schemas.length === 0) {
    return 'No matching deferred tools found.'
  }

  return `<functions>\n${schemas.join('\n')}\n</functions>`
}

// --- ToolSearchTool ---

export function createToolSearchTool(registry: ToolRegistry): Tool {
  return {
    name: TOOL_SEARCH_NAME,
    description: `Fetches full schema definitions for deferred tools so they can be called.

Deferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`,

    inputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    shouldDefer: false, // ToolSearch itself must never be deferred

    async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
      const parsed = inputSchema.parse(input)
      const { query, max_results = 5 } = parsed

      const deferredTools = registry.deferredTools()

      // No deferred tools → nothing to search
      if (deferredTools.length === 0) {
        return { output: 'No deferred tools available. All tools are already loaded.' }
      }

      let matchedNames: string[]

      // Check for "select:" prefix — direct tool selection
      const selectMatch = query.match(/^select:(.+)$/i)
      if (selectMatch) {
        const requested = selectMatch[1]!
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
        matchedNames = handleSelectQuery(requested, registry)
      } else {
        // Keyword search
        matchedNames = searchToolsWithKeywords(query, registry, max_results)
      }

      // Persist discovery — these tools will appear in subsequent API calls
      if (matchedNames.length > 0) {
        registry.discover(matchedNames)
      }

      const output = formatToolSchemas(matchedNames, registry)
      return { output }
    },
  }
}
