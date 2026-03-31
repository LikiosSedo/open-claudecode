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
}

export interface ToolContext {
  cwd: string
  abortSignal?: AbortSignal
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

// --- Tool Registry ---

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  all(): Tool[] {
    return Array.from(this.tools.values())
  }

  toSchemas(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
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
