/**
 * Agent Loop + Streaming Tool Executor
 * Simplified from Claude Code's query.ts + StreamingToolExecutor.ts.
 *
 * Key designs preserved from Claude Code:
 * 1. Tools start executing AS the model streams (addTool on tool_use_stop)
 * 2. Concurrency control: read-only tools parallel, mutations exclusive
 * 3. Bash error propagation: bash failure aborts siblings; others don't
 * 4. Async generator pattern: backpressure + cancellation via .return()
 */

import type {
  Provider,
  Message,
  AssistantMessage,
  UserMessage,
  AssistantContent,
  UserContent,
  StopReason,
  TokenUsage,
} from './providers/types.js'
import type {
  Tool,
  ToolRegistry,
  ToolContext,
  ToolResult,
  PermissionDecision,
} from './tools/types.js'
import type { TraceCallback } from './trace.js'
import {
  normalizeMessages,
  ensureToolResultPairing,
  isPromptTooLong,
} from './messages.js'
import type { HookManager } from './hooks.js'
import { FileReadCache } from './file-cache.js'
import { RateLimiter } from './providers/retry.js'

// -- AgentEvent: unified event stream yielded by agentLoop() --

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_start'; name: string; id: string }
  | { type: 'tool_progress'; name: string; id: string; output: string }
  | { type: 'tool_result'; name: string; id: string; result: string; isError: boolean }
  | { type: 'plan_complete'; plan: string }
  | { type: 'turn_complete'; stopReason: StopReason; usage: TokenUsage }
  | { type: 'message_complete'; messages: Message[]; totalUsage: TokenUsage }

// -- StreamingToolExecutor: concurrent tool execution with ordering guarantees --

const BASH_TOOL_NAME = 'Bash'

type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded'

type TrackedTool = {
  id: string
  name: string
  input: Record<string, unknown>
  tool: Tool | undefined
  status: ToolStatus
  isConcurrencySafe: boolean
  promise?: Promise<void>
  result?: { output: string; isError: boolean }
  /** Buffered progress chunks from onProgress callback, drained by getResults(). */
  pendingProgress: string[]
}

export class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private hasErrored = false
  private erroredToolDesc = ''
  private aborted = false

  // Wake signal: resolves when a tool completes (cf. Claude Code progressAvailableResolve)
  private wakeResolve?: () => void

  constructor(
    private readonly registry: ToolRegistry,
    private readonly toolContext: ToolContext,
    private readonly abortSignal?: AbortSignal,
  ) {
    // Listen for external abort to cancel all pending tools.
    abortSignal?.addEventListener('abort', () => {
      this.aborted = true
      this.wake()
    }, { once: true })
  }

  /** Add a tool that was denied by permission check. Immediately completed with error. */
  addDeniedTool(id: string, name: string, reason: string): void {
    this.tools.push({
      id, name, input: {}, tool: undefined,
      status: 'completed',
      isConcurrencySafe: true,
      result: { output: reason, isError: true },
      pendingProgress: [],
    })
    this.wake()
  }

  /** Add tool to queue. Called on tool_use_stop while model still streams. */
  addTool(id: string, name: string, input: Record<string, unknown>): void {
    const tool = this.registry.get(name)

    // Unknown tool → immediately completed with error, same as Claude Code
    if (!tool) {
      this.tools.push({
        id, name, input, tool: undefined,
        status: 'completed',
        isConcurrencySafe: true,
        result: { output: `Error: No such tool: ${name}`, isError: true },
        pendingProgress: [],
      })
      this.wake()
      return
    }

    this.tools.push({
      id, name, input, tool,
      status: 'queued',
      isConcurrencySafe: tool.isConcurrencySafe,
      pendingProgress: [],
    })

    void this.processQueue()
  }

  /** Abort all pending tools. Consumer should still drain getResults(). */
  abort(): void {
    this.aborted = true
    this.wake()
  }

  /** Yield results and progress in submission order. Promise.race waits for completions or progress.
   *  Non-concurrent tools block yielding of later tools. (cf. getRemainingResults) */
  async *getResults(): AsyncGenerator<
    | { type: 'result'; name: string; id: string; result: string; isError: boolean }
    | { type: 'progress'; name: string; id: string; output: string }
  > {
    while (this.hasUnfinished()) {
      await this.processQueue()

      // Drain any pending progress before yielding completed results
      yield* this.drainProgress()

      // Yield completed results in order
      for (const yielded of this.yieldCompleted()) {
        yield { type: 'result', ...yielded }
      }

      // If still executing, wait for any tool to complete (or progress to arrive)
      if (this.hasExecuting() && !this.hasCompleted()) {
        const executingPromises = this.tools
          .filter(t => t.status === 'executing' && t.promise)
          .map(t => t.promise!)

        const wakePromise = new Promise<void>(resolve => {
          this.wakeResolve = resolve
        })

        if (executingPromises.length > 0) {
          await Promise.race([...executingPromises, wakePromise])
        }

        // After waking, drain any progress that arrived
        yield* this.drainProgress()
      }
    }

    // Final sweep — catch anything completed in the last iteration
    yield* this.drainProgress()
    for (const yielded of this.yieldCompleted()) {
      yield { type: 'result', ...yielded }
    }
  }

  /** Drain all pending progress chunks from all tools. */
  private *drainProgress(): Generator<{ type: 'progress'; name: string; id: string; output: string }> {
    for (const tool of this.tools) {
      if (tool.pendingProgress.length > 0) {
        const output = tool.pendingProgress.splice(0).join('')
        yield { type: 'progress', name: tool.name, id: tool.id, output }
      }
    }
  }

  // -- Internal scheduling --

  /** Can run if: nothing executing, or both this and all running are concurrent-safe */
  private canExecute(isConcurrencySafe: boolean): boolean {
    const executing = this.tools.filter(t => t.status === 'executing')
    return (
      executing.length === 0 ||
      (isConcurrencySafe && executing.every(t => t.isConcurrencySafe))
    )
  }

  /** Start queued tools when concurrency allows. Non-concurrent tools block the queue. */
  private async processQueue(): Promise<void> {
    for (const tool of this.tools) {
      if (tool.status !== 'queued') continue

      if (this.canExecute(tool.isConcurrencySafe)) {
        await this.executeTool(tool)
      } else if (!tool.isConcurrencySafe) {
        // Non-concurrent tool can't start yet; block the rest of the queue.
        break
      }
    }
  }

  private async executeTool(tracked: TrackedTool): Promise<void> {
    tracked.status = 'executing'

    const run = async () => {
      // If already aborted or a bash sibling errored, produce synthetic error
      if (this.aborted || this.hasErrored) {
        tracked.result = {
          output: this.hasErrored
            ? `Cancelled: parallel tool call ${this.erroredToolDesc} errored`
            : 'Interrupted by user',
          isError: true,
        }
        tracked.status = 'completed'
        return
      }

      try {
        // Build per-tool context with onProgress callback for real-time streaming
        const toolContextWithProgress: ToolContext = {
          ...this.toolContext,
          onProgress: (data) => {
            tracked.pendingProgress.push(data.output)
            this.wake()
          },
        }

        const toolResult: ToolResult = await tracked.tool!.execute(
          tracked.input,
          toolContextWithProgress,
        )

        tracked.result = {
          output: toolResult.output,
          isError: toolResult.isError ?? false,
        }

        // Bash errors cancel siblings; other tools are independent
        if (toolResult.isError && tracked.name === BASH_TOOL_NAME) {
          this.hasErrored = true
          const desc = this.getToolDescription(tracked)
          this.erroredToolDesc = desc
          this.aborted = true
        }
      } catch (err) {
        tracked.result = {
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        }

        if (tracked.name === BASH_TOOL_NAME) {
          this.hasErrored = true
          this.erroredToolDesc = this.getToolDescription(tracked)
          this.aborted = true
        }
      }

      tracked.status = 'completed'
    }

    const promise = run()
    tracked.promise = promise

    void promise.finally(() => {
      this.wake()
      void this.processQueue()
    })
  }

  private getToolDescription(tracked: TrackedTool): string {
    const input = tracked.input
    const summary = input.command ?? input.file_path ?? input.pattern ?? ''
    if (typeof summary === 'string' && summary.length > 0) {
      const truncated = summary.length > 40 ? summary.slice(0, 40) + '…' : summary
      return `${tracked.name}(${truncated})`
    }
    return tracked.name
  }

  /** Yield completed results in order; non-concurrent executing tools block later ones. */
  private *yieldCompleted(): Generator<{
    name: string; id: string; result: string; isError: boolean
  }> {
    for (const tool of this.tools) {
      if (tool.status === 'yielded') continue

      if (tool.status === 'completed' && tool.result) {
        tool.status = 'yielded'
        yield {
          name: tool.name,
          id: tool.id,
          result: tool.result.output,
          isError: tool.result.isError,
        }
      } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
        // Non-concurrent tool still running — block yielding of later tools
        break
      }
    }
  }

  private hasUnfinished(): boolean {
    return this.tools.some(t => t.status !== 'yielded')
  }

  private hasExecuting(): boolean {
    return this.tools.some(t => t.status === 'executing')
  }

  private hasCompleted(): boolean {
    return this.tools.some(t => t.status === 'completed')
  }

  private wake(): void {
    if (this.wakeResolve) {
      this.wakeResolve()
      this.wakeResolve = undefined
    }
  }
}

// -- Tool Result Collapsing (cf. Claude Code classifyForCollapse.ts) --

const COLLAPSE_THRESHOLD = 4000  // chars, ~1000 tokens
const PRESERVE_RECENT_TURNS = 2  // keep the most recent 2 tool turns intact

/**
 * Collapse large tool results from older turns to save context.
 * Mutates messages in-place. Only collapses tool_result blocks in user messages.
 * Preserves the most recent PRESERVE_RECENT_TURNS tool turns untouched.
 */
function collapseOldToolResults(messages: Message[]): void {
  // Find the index before which we collapse: walk backwards counting tool turns
  let turnsFromEnd = 0
  let preserveFromIndex = messages.length

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role === 'user' && msg.content.some(c => c.type === 'tool_result')) {
      turnsFromEnd++
      if (turnsFromEnd >= PRESERVE_RECENT_TURNS) {
        preserveFromIndex = i
        break
      }
    }
  }

  // Collapse large tool_result blocks before preserveFromIndex
  for (let i = 0; i < preserveFromIndex; i++) {
    const msg = messages[i]!
    if (msg.role !== 'user') continue

    msg.content = msg.content.map(block => {
      if (block.type !== 'tool_result') return block
      if (block.content.length <= COLLAPSE_THRESHOLD) return block

      const preview = block.content.slice(0, 200)
      const lines = block.content.split('\n').length
      const chars = block.content.length
      return {
        ...block,
        content: `[Collapsed: ${lines} lines, ${chars} chars. Preview: ${preview}...]`,
      }
    })
  }
}

// -- agentLoop: core agent loop (simplified from Claude Code's query.ts) --

function addUsage(a: TokenUsage, b?: TokenUsage): TokenUsage {
  if (!b) return { ...a }
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  }
}

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

// -- Tool Result Budgeting (cf. Claude Code DEFAULT_MAX_RESULT_SIZE_CHARS in toolLimits.ts) --
const TOOL_RESULT_MAX_CHARS = 50_000

/**
 * Truncate tool result content that exceeds the per-result budget.
 * Keeps the first portion and appends a truncation notice with original size.
 */
function applyToolResultBudget(content: string): string {
  if (content.length <= TOOL_RESULT_MAX_CHARS) return content
  const truncated = content.slice(0, TOOL_RESULT_MAX_CHARS)
  return `${truncated}\n\n[Truncated: original was ${content.length} chars, showing first ${TOOL_RESULT_MAX_CHARS}]`
}

export interface AgentLoopOptions {
  provider: Provider
  tools: ToolRegistry
  systemPrompt: string | string[]
  messages: Message[]
  model: string
  maxTurns?: number
  maxTokens?: number
  temperature?: number
  abortSignal?: AbortSignal
  /** Tool execution context (cwd, etc.) */
  toolContext?: ToolContext
  /** Context compaction callback. Implementation is external (cf. Claude Code autocompact).
   *  When force is true, compaction must bypass threshold/circuit-breaker (reactive compact). */
  onCompact?: (messages: Message[], options?: { force?: boolean }) => Promise<Message[]>
  /**
   * Permission check callback. Called before each tool execution.
   * If absent, all tools are allowed (backward-compatible).
   * The callback handles ask/deny logic internally (may prompt user).
   */
  permissionCheck?: (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision>
  /** Hook manager for lifecycle hooks (PreToolUse, PostToolUse, etc.) */
  hookManager?: HookManager
  /** Extended thinking configuration */
  thinking?:
    | { type: 'disabled' }
    | { type: 'adaptive' }
    | { type: 'enabled'; budgetTokens: number }
  /** Observability trace callback. Called at LLM, tool, permission, and compaction boundaries. */
  onTrace?: TraceCallback
  /** Minimum interval between API calls in ms. Prevents rate limit / circuit breaker on 3rd-party APIs. Default: 0 (no throttle). */
  apiThrottleMs?: number
  /**
   * Plan-before-execute mode. When enabled, the first turn forces the model to
   * output a step-by-step plan (no tool calls). A 'plan_complete' event is yielded
   * with the plan text, then "Proceed with the plan." is injected to start execution.
   * Inspired by CrewAI's planning pattern + Claude Code's Plan mode.
   */
  planFirst?: boolean
}

/**
 * Core agent loop. Async generator yielding AgentEvents.
 * Loop: stream response → execute tools → build messages → repeat if tool_use.
 */
export async function* agentLoop(
  options: AgentLoopOptions,
): AsyncGenerator<AgentEvent> {
  const {
    provider,
    tools,
    model,
    maxTurns = 30,
    maxTokens,
    temperature,
    abortSignal,
    permissionCheck,
    hookManager,
    thinking,
    onTrace,
  } = options

  const systemPrompt = options.systemPrompt

  // Build ToolContext with sub-agent support fields.
  // AgentTool.execute() reads these to create child agentLoop instances.
  const baseContext = options.toolContext ?? { cwd: process.cwd() }
  const toolContext: ToolContext = {
    ...baseContext,
    provider: baseContext.provider ?? provider,
    tools: baseContext.tools ?? tools,
    systemPrompt: baseContext.systemPrompt ?? systemPrompt,
    model: baseContext.model ?? model,
    permissionCheck: baseContext.permissionCheck ?? permissionCheck,
    agentDepth: baseContext.agentDepth ?? 0,
    readFileState: baseContext.readFileState ?? new Map(),
    fileCache: baseContext.fileCache ?? new FileReadCache(),
  }

  // Copy so the caller's array isn't mutated
  const messages: Message[] = [...options.messages]
  let totalUsage: TokenUsage = { ...EMPTY_USAGE }
  let reactiveCompactAttempts = 0
  const MAX_REACTIVE_COMPACT_ATTEMPTS = 2
  let streamRetryAttempted = false // one-shot retry on general stream errors
  const rateLimiter = options.apiThrottleMs ? new RateLimiter(options.apiThrottleMs) : null
  let planningDone = !options.planFirst // skip planning phase if not enabled

  // Continuation diminishing returns tracking (cf. Claude Code tokenBudget.ts)
  let continuationCount = 0
  const MAX_CONTINUATIONS = 5
  const MIN_CONTINUATION_TOKENS = 200

  // Planning phase: inject instruction into the last user message to force plan output
  if (options.planFirst && messages.length > 0) {
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role === 'user') {
      const textBlocks = lastMsg.content.filter(b => b.type === 'text')
      if (textBlocks.length > 0) {
        const lastText = textBlocks[textBlocks.length - 1] as { type: 'text'; text: string }
        lastText.text += '\n\nIMPORTANT: Before taking any action, first output a detailed step-by-step plan. Do NOT call any tools yet. Just describe what you will do and why.'
      }
    }
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    const turnStart = Date.now()
    let turnToolCalls = 0

    // Normalize messages before every API call: fix tool pairing + enforce alternation
    const normalizedMessages = normalizeMessages(ensureToolResultPairing(messages))

    // Recompute schemas each turn: discover() may have added deferred tools
    // Planning turn: send empty tools to prevent tool calls (model plans in text only)
    const toolSchemas = !planningDone ? [] : tools.availableSchemas()

    onTrace?.({ type: 'llm_start', turn, model })

    // Rate limit: ensure minimum interval between API calls (prevents 3rd-party circuit breakers)
    if (rateLimiter) await rateLimiter.throttle()

    let stream: AsyncIterable<import('./providers/types.js').StreamEvent>
    const llmStart = Date.now()
    try {
      stream = provider.stream(normalizedMessages, toolSchemas, { model, maxTokens, systemPrompt, temperature, thinking })
    } catch (err) {
      // Synchronous errors from provider.stream() (e.g. pre-flight validation)
      if (
        isPromptTooLong(err) &&
        options.onCompact &&
        reactiveCompactAttempts < MAX_REACTIVE_COMPACT_ATTEMPTS
      ) {
        reactiveCompactAttempts++
        const compacted = await options.onCompact(messages, { force: true })
        messages.length = 0
        messages.push(...compacted)
        continue // retry the turn with compacted messages
      }
      throw err
    }

    const contentBlocks: AssistantContent[] = []
    let currentText = '', currentThinking = ''
    let stopReason: StopReason = 'end_turn'
    let turnUsage: TokenUsage = { ...EMPTY_USAGE }
    const pendingToolBlocks = new Map<string, { name: string; partialJson: string }>()
    let hasToolUse = false
    // New executor per turn (Claude Code: query.ts:562)
    const executor = new StreamingToolExecutor(tools, toolContext, abortSignal)
    const toolStartTimes = new Map<string, number>()

    // Reactive compact: prompt-too-long errors surface during stream iteration
    // (the API rejects with 400/413 on first chunk fetch). Catch, compact, retry.
    let streamErrored = false
    try {

    for await (const event of stream) {
      if (abortSignal?.aborted) break

      switch (event.type) {
        case 'text_delta': {
          currentText += event.text
          yield { type: 'text_delta', text: event.text }
          break
        }

        case 'thinking_delta': {
          currentThinking += event.thinking
          yield { type: 'thinking_delta', thinking: event.thinking }
          break
        }

        case 'thinking_stop': {
          // Flush thinking with signature from provider
          if (currentThinking) {
            contentBlocks.push({
              type: 'thinking',
              thinking: currentThinking,
              signature: event.signature,
            })
            currentThinking = ''
          }
          break
        }

        case 'tool_use_start': {
          // Flush accumulated text/thinking before the tool_use block
          if (currentText) {
            contentBlocks.push({ type: 'text', text: currentText })
            currentText = ''
          }
          if (currentThinking) {
            // Fallback: thinking_stop should have flushed this already.
            // If we get here, signature was never received (e.g. interrupted stream).
            contentBlocks.push({ type: 'thinking', thinking: currentThinking, signature: '' })
            currentThinking = ''
          }
          pendingToolBlocks.set(event.id, { name: event.name, partialJson: '' })
          hasToolUse = true
          break
        }

        case 'tool_use_delta': {
          const pending = pendingToolBlocks.get(event.id)
          if (pending) {
            pending.partialJson += event.partialJson
          }
          break
        }

        case 'tool_use_stop': {
          let input = event.input as Record<string, unknown>
          const toolName = pendingToolBlocks.get(event.id)?.name ?? 'unknown'
          pendingToolBlocks.delete(event.id)

          // PreToolUse hooks: may deny or modify input before permission check
          if (hookManager) {
            const hookResult = await hookManager.execute('PreToolUse', {
              toolName, toolInput: input,
            })
            if (hookResult.decision === 'deny') {
              contentBlocks.push({ type: 'tool_use', id: event.id, name: toolName, input })
              executor.addDeniedTool(event.id, toolName, hookResult.reason ?? 'Denied by hook')
              yield { type: 'tool_start', name: toolName, id: event.id }
              break
            }
            if (hookResult.updatedInput) {
              input = hookResult.updatedInput
            }
          }

          contentBlocks.push({ type: 'tool_use', id: event.id, name: toolName, input })

          // Semantic validation (Tool.validateInput) — before permission check
          const toolDef = tools.get(toolName)
          if (toolDef?.validateInput) {
            const validation = await toolDef.validateInput(input, toolContext)
            if (!validation.valid) {
              executor.addDeniedTool(event.id, toolName, `Validation failed: ${validation.error ?? 'invalid input'}`)
              yield { type: 'tool_start', name: toolName, id: event.id }
              break
            }
          }

          // Permission check before execution (async — may prompt user)
          if (permissionCheck) {
            const permStart = Date.now()
            const decision = await permissionCheck(toolName, input)
            const permDecision = decision.behavior === 'deny' ? 'deny' as const : 'allow' as const
            onTrace?.({ type: 'permission', turn, tool: toolName, decision: permDecision, durationMs: Date.now() - permStart })
            if (decision.behavior === 'deny') {
              // Feed a pre-denied result into executor
              executor.addDeniedTool(event.id, toolName, `Permission denied: ${decision.reason}`)
              yield { type: 'tool_start', name: toolName, id: event.id }
              break
            }
            // 'allow' falls through to normal execution
          }

          turnToolCalls++
          toolStartTimes.set(event.id, Date.now())
          onTrace?.({ type: 'tool_start', turn, name: toolName, id: event.id, input })
          executor.addTool(event.id, toolName, input)
          yield { type: 'tool_start', name: toolName, id: event.id }
          break
        }

        case 'message_stop': {
          stopReason = event.stopReason
          if (event.usage) {
            turnUsage = addUsage(turnUsage, event.usage)
          }
          break
        }

        case 'message_start': {
          if (event.usage) {
            turnUsage = addUsage(turnUsage, event.usage)
          }
          break
        }
      }
    }

    } catch (streamErr) {
      // Reactive compact: if prompt-too-long, compact and retry the turn
      if (
        isPromptTooLong(streamErr) &&
        options.onCompact &&
        reactiveCompactAttempts < MAX_REACTIVE_COMPACT_ATTEMPTS
      ) {
        reactiveCompactAttempts++
        const compacted = await options.onCompact(messages, { force: true })
        messages.length = 0
        messages.push(...compacted)
        streamErrored = true
        // Fall through to continue — don't process the failed turn's results
      } else if (!streamRetryAttempted) {
        // General streaming fallback: discard partial content, abort executor, retry once.
        // cf. Claude Code query.ts withheld error / recovery pattern
        streamRetryAttempted = true
        executor.abort()
        streamErrored = true
      } else {
        throw streamErr
      }
    }

    if (streamErrored) continue // retry the turn after reactive compact

    onTrace?.({ type: 'llm_end', turn, durationMs: Date.now() - llmStart, usage: turnUsage, stopReason })

    // Flush trailing text/thinking
    if (currentText) {
      contentBlocks.push({ type: 'text', text: currentText })
    }
    if (currentThinking) {
      // Fallback: thinking_stop should have flushed this already.
      // If we get here, the stream was interrupted before thinking_stop arrived.
      contentBlocks.push({ type: 'thinking', thinking: currentThinking, signature: '' })
    }

    // -- 2. Build assistant message --
    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: contentBlocks,
    }
    messages.push(assistantMessage)

    // -- 3. Collect tool results --
    if (hasToolUse) {
      if (abortSignal?.aborted) {
        executor.abort()
      }

      const toolResultContents: UserContent[] = []
      // Drain all results + progress (cf. Claude Code getRemainingResults, query.ts:1380)
      for await (const event of executor.getResults()) {
        if (event.type === 'progress') {
          yield { type: 'tool_progress', name: event.name, id: event.id, output: event.output }
          continue
        }

        yield {
          type: 'tool_result',
          name: event.name,
          id: event.id,
          result: event.result,
          isError: event.isError,
        }

        const toolElapsed = Date.now() - (toolStartTimes.get(event.id) ?? Date.now())
        onTrace?.({ type: 'tool_end', turn, name: event.name, id: event.id, durationMs: toolElapsed, isError: event.isError, outputSize: event.result.length })

        // PostToolUse hooks: fire-and-forget observation after each tool result
        if (hookManager) {
          await hookManager.execute('PostToolUse', {
            toolName: event.name,
            toolResult: event.result,
            isError: event.isError,
          })
        }

        // Cap tool result size before adding to messages (cf. Claude Code applyToolResultBudget)
        const budgetedResult = applyToolResultBudget(event.result)

        toolResultContents.push({
          type: 'tool_result',
          toolUseId: event.id,
          content: budgetedResult,
          isError: event.isError || undefined,
        })
      }

      // API requires tool_result in a user message after the tool_use assistant message
      if (toolResultContents.length > 0) {
        const userMessage: UserMessage = {
          role: 'user',
          content: toolResultContents,
        }
        messages.push(userMessage)
      }
    }

    totalUsage = addUsage(totalUsage, turnUsage)
    reactiveCompactAttempts = 0 // reset on successful turn
    streamRetryAttempted = false // reset retry flag on successful turn
    onTrace?.({ type: 'turn_summary', turn, toolCalls: turnToolCalls, stopReason, usage: turnUsage, durationMs: Date.now() - turnStart })
    yield { type: 'turn_complete', stopReason, usage: turnUsage }

    // -- Plan-before-execute: after planning turn, yield plan and inject "proceed"
    if (!planningDone) {
      // Collect plan text from the assistant message we just built
      const planText = contentBlocks
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('\n')
      yield { type: 'plan_complete', plan: planText }
      // Inject continuation message to start execution
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: 'Good plan. Now execute it step by step. Use tools as needed.' }],
      })
      planningDone = true
      continue // next turn will have tools enabled
    }

    // -- 4. Check if we should continue --
    if (abortSignal?.aborted) {
      break
    }

    if (stopReason === 'tool_use' && hasToolUse) {
      // Tool loop continues — reset continuation counter, collapse old results
      continuationCount = 0
      collapseOldToolResults(messages)
    } else if (stopReason === 'max_tokens' && turn < maxTurns - 1) {
      // Auto-continue with diminishing returns detection
      continuationCount++

      const outputTokens = turnUsage.outputTokens
      if (continuationCount > 1 && outputTokens > 0 && outputTokens < MIN_CONTINUATION_TOKENS) {
        yield { type: 'text_delta', text: '\n...stopped (diminishing output)\n' }
        break
      }
      if (continuationCount >= MAX_CONTINUATIONS) {
        yield { type: 'text_delta', text: '\n...stopped (max continuations reached)\n' }
        break
      }

      yield { type: 'text_delta', text: '\n...continuing...\n' }
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: 'Please continue exactly where you left off.' }],
      })
    } else {
      // end_turn, stop_sequence, or budget exhausted — stop the loop
      break
    }

    // -- 5. Context compaction hook (cf. Claude Code autocompact) --
    if (options.onCompact) {
      const beforeCount = messages.length
      const compacted = await options.onCompact(messages)
      if (compacted !== messages) {
        messages.length = 0
        messages.push(...compacted)
        onTrace?.({ type: 'compact', turn, beforeMessages: beforeCount, afterMessages: messages.length })
      }
    }
  }

  yield { type: 'message_complete', messages, totalUsage }
}
