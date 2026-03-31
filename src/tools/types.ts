/**
 * Tool System
 *
 * Design from Claude Code:
 * - Each tool is self-describing (schema + description for the LLM)
 * - Declares its own safety properties (readOnly, concurrencySafe)
 * - Permission checking is per-tool, not global
 * - buildTool() provides fail-closed defaults
 */

import { z } from 'zod'
import { zodToJsonSchema as zodToJson } from 'zod-to-json-schema'
import type { Provider } from '../providers/types.js'

// --- Core Tool Interface ---

export interface Tool<TInput = unknown> {
  /** Unique name (matches what the LLM calls) */
  readonly name: string

  /** Human-readable description for the LLM */
  readonly description: string

  /** Zod schema for input validation */
  readonly inputSchema: z.ZodType<TInput>

  /** Execute the tool. Returns a string result for the LLM. */
  execute(input: TInput, context: ToolContext): Promise<ToolResult>

  /**
   * Can this tool run in parallel with other concurrent-safe tools?
   * Default: false (fail-closed, same as Claude Code)
   *
   * true  → Read, Glob, Grep (pure reads, no side effects)
   * false → Bash, Write, Edit (mutations, ordering matters)
   */
  isConcurrencySafe: boolean

  /** Does this tool only read, never write? */
  isReadOnly: boolean

  /** Pre-computed JSON Schema (used by MCP tools that already have JSON Schema) */
  rawJsonSchema?: Record<string, unknown>

  /**
   * If true, this tool's schema is deferred — not sent to LLM initially.
   * Discoverable via ToolSearch. Design from Claude Code.
   */
  shouldDefer?: boolean

  /** Keywords for ToolSearch matching (3-10 words) */
  searchHint?: string
}

export interface ToolContext {
  cwd: string
  abortSignal?: AbortSignal
  // --- Sub-agent support (populated by agentLoop for AgentTool) ---
  /** Provider instance for sub-agent to reuse (same connection, no extra init) */
  provider?: Provider
  /** Tool registry for sub-agent to reuse (same tools available) */
  tools?: ToolRegistry
  /** System prompt blocks for sub-agent (same static+dynamic split) */
  systemPrompt?: string | string[]
  /** Model identifier for sub-agent (inherits parent's model by default) */
  model?: string
  /** Permission check callback for sub-agent (inherits parent's security policy) */
  permissionCheck?: (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision>
  /** Current nesting depth. 0 = root agent. Used to enforce max recursion depth. */
  agentDepth?: number
}

export interface ToolResult {
  output: string
  isError?: boolean
}

// --- Permission ---

export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'ask'; message: string }
  | { behavior: 'deny'; reason: string }

export type PermissionChecker = (
  toolName: string,
  input: unknown,
) => Promise<PermissionDecision>

// --- Tool Schema (as sent to the LLM) ---

export interface ToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// --- Tool Registry ---

export class ToolRegistry {
  private tools = new Map<string, Tool>()
  private discoveredNames = new Set<string>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  all(): Tool[] {
    return Array.from(this.tools.values())
  }

  /** Get only non-deferred tools (for initial API call) */
  activeTools(): Tool[] {
    return this.all().filter(t => !t.shouldDefer)
  }

  /** Get only deferred tools (for ToolSearch to search) */
  deferredTools(): Tool[] {
    return this.all().filter(t => t.shouldDefer)
  }

  /**
   * Mark tools as discovered — they'll be included in subsequent API calls.
   * Effect persists until session ends (no need to re-search).
   */
  discover(toolNames: string[]): void {
    for (const name of toolNames) {
      if (this.tools.has(name)) {
        this.discoveredNames.add(name)
      }
    }
  }

  /**
   * Get schemas for active + discovered tools (sent to the LLM each turn).
   * Deferred tools not yet discovered are excluded — saves tokens.
   */
  availableSchemas(): ToolSchema[] {
    return this.all()
      .filter(t => !t.shouldDefer || this.discoveredNames.has(t.name))
      .map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.rawJsonSchema ?? this.zodToJsonSchema(t.inputSchema),
      }))
  }

  /** All schemas (including deferred). Used by toSchemas() for backward compat. */
  toSchemas(): ToolSchema[] {
    return this.all().map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.rawJsonSchema ?? this.zodToJsonSchema(t.inputSchema),
    }))
  }

  /** Convert Zod schema to JSON Schema */
  zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
    const result = zodToJson(schema, { target: 'openApi3' })
    // Remove top-level $schema and $ref wrappers if present
    const { $schema, ...rest } = result as Record<string, unknown>
    return rest
  }
}
