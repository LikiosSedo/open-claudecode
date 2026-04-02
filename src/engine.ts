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
}

// -- Agent class --

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
  private _sessionId?: string
  private _mcpConfigs?: AgentOptions['mcpServers']
  private _initialized = false

  constructor(options: AgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd()
    this.maxTurns = options.maxTurns ?? 30
    this.maxTokens = options.maxTokens
    this.hooks = options.hooks
    this.onTrace = options.onTrace
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
