/**
 * Engine — SDK entry point for programmatic agent usage
 *
 * Wraps agentLoop + providers + tools into a simple Agent class.
 * One class, async generator pattern: agent.run(prompt) yields AgentEvents.
 */

import { agentLoop, type AgentEvent } from './agent.js'
import type { TraceCallback } from './trace.js'
import type { Provider, Message } from './providers/types.js'
import { AnthropicProvider } from './providers/anthropic.js'
import { OpenAIProvider } from './providers/openai.js'
import { ToolRegistry } from './tools/types.js'
import type { Tool, ToolResult, ToolContext } from './tools/types.js'
import { ContextManager } from './context.js'
import { SessionManager } from './session.js'
import { MCPManager } from './mcp.js'
import { buildSystemPrompt } from './prompt.js'
import { BashTool } from './tools/bash.js'
import { ReadTool } from './tools/read.js'
import { WriteTool } from './tools/write.js'
import { EditTool } from './tools/edit.js'
import { GlobTool } from './tools/glob.js'
import { GrepTool } from './tools/grep.js'

// -- Re-exports --

export type { AgentEvent } from './agent.js'
export type { TraceEvent, TraceCallback } from './trace.js'
export { consoleTracer } from './trace.js'
export type { Tool, ToolResult, ToolContext } from './tools/types.js'
export type { Provider, Message } from './providers/types.js'
export { AgentGraph, agentNode, END } from './graph.js'
export type { GraphState, GraphEvent, NodeFunction, EdgeCondition } from './graph.js'

// -- Coding preset --

const CODING_TOOLS: Tool[] = [BashTool, ReadTool, WriteTool, EditTool, GlobTool, GrepTool]

// -- Provider helpers --

function isProviderInstance(p: unknown): p is Provider {
  return typeof p === 'object' && p !== null && 'stream' in p && 'name' in p
}

function createProvider(config: {
  model: string; apiKey?: string; baseUrl?: string; type?: 'anthropic' | 'openai'
}): Provider {
  const type = config.type ?? (config.model.startsWith('claude-') ? 'anthropic' : 'openai')
  if (type === 'anthropic') {
    return new AnthropicProvider({ apiKey: config.apiKey, baseURL: config.baseUrl })
  }
  return new OpenAIProvider({ apiKey: config.apiKey, baseURL: config.baseUrl })
}

// -- Options --

export interface AgentOptions {
  /** Provider instance or config to auto-create one */
  provider?: Provider | {
    model: string
    apiKey?: string
    baseUrl?: string
    type?: 'anthropic' | 'openai'
  }
  /** Tool[] or 'coding' preset (Bash/Read/Write/Edit/Glob/Grep). Default: 'coding' */
  tools?: Tool[] | 'coding'
  /** Custom system prompt. If omitted, uses built-in coding agent prompt */
  systemPrompt?: string
  /** Model ID. Inferred from provider config if not set. Default: claude-sonnet-4-20250514 */
  model?: string
  /** Max agent loop turns. Default: 30 */
  maxTurns?: number
  /** Max output tokens per LLM call */
  maxTokens?: number
  /** Context window management */
  context?: { maxTokens?: number }
  /** Enable session persistence */
  session?: boolean | { dir: string }
  /** MCP servers to connect on first run */
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
  /** Lifecycle hooks for tool execution */
  hooks?: {
    preToolUse?: (toolName: string, input: unknown) => Promise<{ allow: boolean; reason?: string }>
    postToolUse?: (toolName: string, result: string, isError: boolean) => Promise<void>
  }
  /** Working directory. Default: process.cwd() */
  cwd?: string
  /** Observability trace callback. Receives TraceEvents for LLM calls, tools, permissions, compaction. */
  onTrace?: TraceCallback
  /** Plan-before-execute: first turn outputs a plan (no tools), then executes. */
  planFirst?: boolean
  /** Minimum ms between API calls. Prevents rate limit on 3rd-party APIs. Default: 0. */
  apiThrottleMs?: number
}

// -- Agent class --

/**
 * Event handler types for reactive agents.
 * - Full control: `on('event', async (data, agent) => { for await (const e of agent.run(...)) ... })`
 * - Auto-trigger: `onTrigger('event', (data) => \`prompt: ${data}\`)`
 */
export type AgentEventHandler = (data: unknown, agent: Agent) => void | Promise<void>

export class Agent {
  private provider: Provider
  private tools: ToolRegistry
  private model: string
  private systemPromptBlocks: string[]
  private contextManager: ContextManager
  private sessionManager?: SessionManager
  private mcpManager?: MCPManager
  private maxTurns: number
  private maxTokens?: number
  private cwd: string
  private messages: Message[] = []
  private hooks?: AgentOptions['hooks']
  private onTrace?: TraceCallback
  private planFirst: boolean
  private apiThrottleMs: number
  private _sessionId?: string
  private _mcpConfigs?: AgentOptions['mcpServers']
  private _initialized = false
  private _eventHandlers = new Map<string, AgentEventHandler[]>()

  constructor(options: AgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd()
    this.maxTurns = options.maxTurns ?? 30
    this.maxTokens = options.maxTokens
    this.hooks = options.hooks
    this.onTrace = options.onTrace
    this.planFirst = options.planFirst ?? false
    this.apiThrottleMs = options.apiThrottleMs ?? 0
    this._mcpConfigs = options.mcpServers

    // Resolve model: explicit > provider config > default
    this.model = options.model
      ?? (options.provider && !isProviderInstance(options.provider) ? options.provider.model : null)
      ?? 'claude-sonnet-4-20250514'

    // Resolve provider: instance > config > auto-create from model
    this.provider = options.provider && isProviderInstance(options.provider)
      ? options.provider
      : createProvider(
          options.provider && !isProviderInstance(options.provider)
            ? options.provider
            : { model: this.model },
        )

    // Register tools
    this.tools = new ToolRegistry()
    const toolList = options.tools === 'coding' || !options.tools ? CODING_TOOLS : options.tools
    for (const tool of toolList) this.tools.register(tool)

    // System prompt
    this.systemPromptBlocks = options.systemPrompt
      ? [options.systemPrompt]
      : buildSystemPrompt({ cwd: this.cwd })

    // Context + session managers (model-aware: auto-sets window from model name)
    this.contextManager = new ContextManager({ ...options.context, model: this.model })
    if (options.session) {
      const dir = typeof options.session === 'object' ? options.session.dir : undefined
      this.sessionManager = new SessionManager(dir ? { sessionDir: dir } : undefined)
    }
  }

  /** Lazy init: connect MCP servers on first run */
  private async init(): Promise<void> {
    if (this._initialized) return
    this._initialized = true
    if (!this._mcpConfigs) return
    if (!this.mcpManager) this.mcpManager = new MCPManager()
    const configs = Object.entries(this._mcpConfigs).map(([name, c]) => ({ name, ...c }))
    await this.mcpManager.connect(configs)
    for (const tool of this.mcpManager.getTools()) this.tools.register(tool)
  }

  /** Run agent with a prompt. Returns async generator of events. */
  async *run(prompt: string, options?: { abortSignal?: AbortSignal }): AsyncGenerator<AgentEvent> {
    await this.init()
    const messagesBefore = this.messages.length

    this.messages.push({ role: 'user', content: [{ type: 'text', text: prompt }] })

    if (this.sessionManager && !this._sessionId) {
      this._sessionId = await this.sessionManager.createSession(this.cwd, this.model)
    }

    // Map preToolUse hook → agentLoop permissionCheck
    const permissionCheck = this.hooks?.preToolUse
      ? async (toolName: string, input: Record<string, unknown>) => {
          const r = await this.hooks!.preToolUse!(toolName, input)
          return r.allow
            ? { behavior: 'allow' as const }
            : { behavior: 'deny' as const, reason: r.reason ?? 'Denied by hook' }
        }
      : undefined

    const loop = agentLoop({
      provider: this.provider,
      tools: this.tools,
      systemPrompt: this.systemPromptBlocks,
      messages: this.messages,
      model: this.model,
      maxTurns: this.maxTurns,
      maxTokens: this.maxTokens,
      abortSignal: options?.abortSignal,
      toolContext: { cwd: this.cwd },
      permissionCheck,
      onTrace: this.onTrace,
      planFirst: this.planFirst,
      apiThrottleMs: this.apiThrottleMs,
      onCompact: async (msgs, opts) => {
        const r = opts?.force
          ? await this.contextManager.forceCompact(msgs, this.provider, this.model)
          : await this.contextManager.compact(msgs, this.provider, this.model)
        return r.messages
      },
    })

    for await (const event of loop) {
      // Fire postToolUse hook on tool completion
      if (event.type === 'tool_result' && this.hooks?.postToolUse) {
        await this.hooks.postToolUse(event.name, event.result, event.isError)
      }
      yield event

      // Sync messages from completed loop
      if (event.type === 'message_complete') {
        this.messages = event.messages
        if (this.sessionManager && this._sessionId) {
          await this.sessionManager.appendMessages(
            this._sessionId,
            event.messages.slice(messagesBefore),
          )
        }
      }
    }
  }

  /** Resume a previous session with a new prompt */
  async *resume(sessionId: string, prompt: string): AsyncGenerator<AgentEvent> {
    if (!this.sessionManager) throw new Error('Session not enabled')
    const { messages } = await this.sessionManager.loadSession(sessionId)
    this.messages = messages
    this._sessionId = sessionId
    this.sessionManager.setCurrentSession(sessionId)
    yield* this.run(prompt)
  }

  /** Add a tool at runtime */
  addTool(tool: Tool): void {
    this.tools.register(tool)
  }

  /** Connect an MCP server at runtime */
  async addMCPServer(
    name: string,
    config: { command: string; args?: string[]; env?: Record<string, string> },
  ): Promise<void> {
    if (!this.mcpManager) this.mcpManager = new MCPManager()
    await this.mcpManager.connect([{ name, ...config }])
    for (const tool of this.mcpManager.getTools()) this.tools.register(tool)
  }

  /** Get conversation history */
  getMessages(): Message[] {
    return [...this.messages]
  }

  /** Get current session ID */
  getSessionId(): string | undefined {
    return this._sessionId
  }

  // -- Event system: reactive agent support --

  /** Register handler for a custom event. Handler receives event data + this agent. */
  on(event: string, handler: AgentEventHandler): this {
    const handlers = this._eventHandlers.get(event) ?? []
    handlers.push(handler)
    this._eventHandlers.set(event, handlers)
    return this
  }

  /** Remove a specific handler. */
  off(event: string, handler: AgentEventHandler): this {
    const handlers = this._eventHandlers.get(event)
    if (handlers) {
      const idx = handlers.indexOf(handler)
      if (idx >= 0) handlers.splice(idx, 1)
    }
    return this
  }

  /**
   * Convenience: auto-run agent when event fires.
   * The promptFn converts event data into a prompt string.
   * Returns an async generator of AgentEvents from the triggered run.
   *
   * Usage:
   *   agent.onTrigger('alert', (data) => `Investigate: ${data.message}`)
   *   const events = agent.emit('alert', { message: 'Pod crashing' })
   *   for await (const e of events) { ... }
   */
  onTrigger(event: string, promptFn: (data: unknown) => string): this {
    this.on(event, async (data, agent) => {
      // Auto-trigger run is fire-and-forget from handler perspective.
      // To consume events, use emit() which returns the generator.
    })
    // Store promptFn separately for emit() to use
    const key = `__trigger__${event}`
    ;(this as Record<string, unknown>)[key] = promptFn
    return this
  }

  /**
   * Emit an event. Calls all registered handlers, then if an onTrigger
   * exists for this event, returns an async generator from agent.run().
   */
  async *emit(event: string, data?: unknown): AsyncGenerator<AgentEvent> {
    // Fire regular handlers (fire-and-forget)
    const handlers = this._eventHandlers.get(event) ?? []
    for (const handler of handlers) {
      await handler(data, this)
    }

    // Check for onTrigger auto-run
    const triggerKey = `__trigger__${event}`
    const promptFn = (this as Record<string, unknown>)[triggerKey] as ((data: unknown) => string) | undefined
    if (promptFn) {
      const prompt = promptFn(data)
      yield* this.run(prompt)
    }
  }
}

// -- Convenience function --

/** One-shot query. Creates an Agent, runs the prompt, yields events. */
export async function* query(
  options: AgentOptions & { prompt: string },
): AsyncGenerator<AgentEvent> {
  const { prompt, ...agentOpts } = options
  const agent = new Agent(agentOpts)
  yield* agent.run(prompt)
}
