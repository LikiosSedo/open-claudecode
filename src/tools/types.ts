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
      inputSchema: this.zodToJsonSchema(t.inputSchema),
    }))
  }

  /** Convert Zod schema to JSON Schema (synchronous, cached) */
  zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
    // Manual conversion for common Zod types — avoids ESM dynamic import issues
    // For full coverage, install zod-to-json-schema and replace this method
    return this.zodToJsonSchemaSimple(schema)
  }

  private zodToJsonSchemaSimple(schema: z.ZodType): Record<string, unknown> {
    const def = (schema as { _def?: Record<string, unknown> })._def
    if (!def) return { type: 'object' }

    const typeName = def.typeName as string

    if (typeName === 'ZodObject') {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape
      const properties: Record<string, unknown> = {}
      const required: string[] = []

      for (const [key, value] of Object.entries(shape)) {
        const fieldSchema = value as z.ZodType
        const fieldDef = (fieldSchema as { _def?: Record<string, unknown> })._def
        const isOptional = (fieldDef?.typeName as string) === 'ZodOptional'
        const innerSchema = isOptional ? (fieldDef?.innerType as z.ZodType) : fieldSchema
        properties[key] = this.zodToJsonSchemaSimple(innerSchema)

        // Add description from .describe()
        const desc = (fieldDef?.description ?? (innerSchema as { _def?: Record<string, unknown> })._def?.description) as string | undefined
        if (desc && typeof properties[key] === 'object') {
          (properties[key] as Record<string, unknown>).description = desc
        }

        if (!isOptional) required.push(key)
      }

      return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
    }

    if (typeName === 'ZodString') return { type: 'string' }
    if (typeName === 'ZodNumber') return { type: 'number' }
    if (typeName === 'ZodBoolean') return { type: 'boolean' }
    if (typeName === 'ZodOptional') return this.zodToJsonSchemaSimple(def.innerType as z.ZodType)

    return { type: 'object' }
  }
}
