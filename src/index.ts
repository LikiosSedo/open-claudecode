#!/usr/bin/env node
/**
 * open-claude-code (occ) — The essence of Claude Code
 *
 * CLI entry point + REPL. Integrates all modules:
 * - Provider (Anthropic / OpenAI) for LLM streaming
 * - AgentLoop for tool-calling conversation loop
 * - ToolRegistry with 6 core tools
 * - ContextManager for auto-compaction
 * - System prompt with layered caching
 */

import * as readline from 'node:readline'
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import chalk from 'chalk'
import { AnthropicProvider } from './providers/anthropic.js'
import { OpenAIProvider } from './providers/openai.js'
import type { Provider, Message, TokenUsage } from './providers/types.js'
import { ToolRegistry } from './tools/types.js'
import { BashTool } from './tools/bash.js'
import { ReadTool } from './tools/read.js'
import { WriteTool } from './tools/write.js'
import { EditTool } from './tools/edit.js'
import { GlobTool } from './tools/glob.js'
import { GrepTool } from './tools/grep.js'
import { AgentTool } from './tools/agent.js'
import { createToolSearchTool } from './tools/tool-search.js'
import { agentLoop } from './agent.js'
import { buildSystemPrompt, getGitContext } from './prompt.js'
import { ContextManager } from './context.js'
import { MCPManager, loadMCPConfig } from './mcp.js'
import { PermissionManager, type PermissionMode } from './permissions.js'
import { MemoryManager, loadClaudeMdFiles } from './memory.js'
import { MemoryTool, setMemoryManager } from './tools/memory-tool.js'
import { SessionManager } from './session.js'
import { renderMarkdown, renderInline } from './render.js'
import { runDiagnostics, formatDiagnostics } from './doctor.js'

// --- Input History Persistence ---

const HISTORY_FILE = join(homedir(), '.occ', 'input_history')
const MAX_HISTORY = 500

function loadInputHistory(): string[] {
  try {
    if (!existsSync(HISTORY_FILE)) return []
    const lines = readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean)
    return lines.slice(-MAX_HISTORY).reverse() // readline expects newest-first
  } catch { return [] }
}

function appendInputHistory(input: string): void {
  try {
    // Deduplicate: read last line and skip if identical
    if (existsSync(HISTORY_FILE)) {
      const content = readFileSync(HISTORY_FILE, 'utf-8')
      const lines = content.split('\n').filter(Boolean)
      if (lines.length > 0 && lines[lines.length - 1] === input) return
    }
    mkdirSync(join(homedir(), '.occ'), { recursive: true })
    appendFileSync(HISTORY_FILE, input + '\n')
  } catch { /* best-effort */ }
}

// --- Loading Spinner ---

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

class Spinner {
  private interval: NodeJS.Timeout | null = null
  private frame = 0
  private startTime = 0

  start(message = 'thinking'): void {
    this.startTime = Date.now()
    this.frame = 0
    this.interval = setInterval(() => {
      const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1)
      const f = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]!
      process.stderr.write(`\r${chalk.cyan(f)} ${chalk.dim(message)}${chalk.dim(` ${elapsed}s`)}`)
      this.frame++
    }, 80)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
      process.stderr.write('\r' + ' '.repeat(40) + '\r') // clear spinner line
    }
  }
}

// --- Terminal Notification ---

function notifyCompletion(message: string): void {
  // Terminal bell (most widely supported)
  process.stderr.write('\x07')
  // OSC 9 notification (iTerm2, Kitty, Ghostty)
  process.stderr.write(`\x1b]9;${message}\x1b\\`)
  // OSC 777 notification (rxvt-unicode)
  process.stderr.write(`\x1b]777;notify;occ;${message}\x1b\\`)
}

// --- Provider Selection ---

function createProvider(): { provider: Provider; defaultModel: string } {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: new AnthropicProvider(), defaultModel: 'claude-sonnet-4-20250514' }
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: new OpenAIProvider(), defaultModel: 'gpt-4o' }
  }
  console.error(chalk.red(
    'No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.',
  ))
  process.exit(1)
}

// --- Tool Registration ---

function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(BashTool)
  registry.register(ReadTool)
  registry.register(WriteTool)
  registry.register(EditTool)
  registry.register(GlobTool)
  registry.register(GrepTool)
  registry.register(AgentTool)
  registry.register(MemoryTool)
  return registry
}

// --- Token Tracking ---

const totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

function accumulateUsage(u?: TokenUsage): void {
  if (!u) return
  totalUsage.inputTokens += u.inputTokens
  totalUsage.outputTokens += u.outputTokens
  totalUsage.cacheReadTokens += u.cacheReadTokens ?? 0
  totalUsage.cacheWriteTokens += u.cacheWriteTokens ?? 0
}

function formatUsage(): string {
  const p = totalUsage
  const parts = [`in: ${p.inputTokens.toLocaleString()}`, `out: ${p.outputTokens.toLocaleString()}`]
  if (p.cacheReadTokens > 0) parts.push(`cache-read: ${p.cacheReadTokens.toLocaleString()}`)
  if (p.cacheWriteTokens > 0) parts.push(`cache-write: ${p.cacheWriteTokens.toLocaleString()}`)
  return parts.join(' | ')
}

// --- USD Cost Calculation ---

/** Pricing per million tokens */
const MODEL_COSTS: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  // Claude Sonnet 4
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // Claude Opus 4
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4-20250514': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  // Claude Haiku 3.5
  'claude-haiku-4-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // Claude 3.5 Sonnet
  'claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
  'o3-mini': { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 },
}

/** Find best matching model cost by prefix. E.g. "claude-sonnet-4-20250514" matches "claude-sonnet-4". */
function findModelCosts(model: string): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  // Exact match first
  if (MODEL_COSTS[model]) return MODEL_COSTS[model]
  // Prefix match: find the longest matching key
  let bestMatch: string | null = null
  for (const key of Object.keys(MODEL_COSTS)) {
    if (model.startsWith(key) && (!bestMatch || key.length > bestMatch.length)) {
      bestMatch = key
    }
  }
  return bestMatch ? MODEL_COSTS[bestMatch]! : null
}

function calculateCostUSD(model: string, usage: typeof totalUsage): number {
  const costs = findModelCosts(model)
  if (!costs) return 0
  return (
    (usage.inputTokens / 1_000_000) * costs.input +
    (usage.outputTokens / 1_000_000) * costs.output +
    (usage.cacheReadTokens / 1_000_000) * costs.cacheRead +
    (usage.cacheWriteTokens / 1_000_000) * costs.cacheWrite
  )
}

// --- Main ---

// --- Permission Prompt ---

/** Prompt user for permission confirmation via readline. Returns 'y' | 'a' | 'n'. */
function createPermissionPrompter(rl: readline.Interface) {
  return async (toolName: string, input: Record<string, unknown>, message: string): Promise<'y' | 'a' | 'n'> => {
    // Format a concise summary of what the tool wants to do
    let detail = ''
    if (toolName === 'Bash' && typeof input.command === 'string') {
      const cmd = input.command.length > 120 ? input.command.slice(0, 120) + '...' : input.command
      detail = `  command: ${cmd}`
    } else if (typeof input.file_path === 'string') {
      detail = `  path: ${input.file_path}`
    }

    console.log()
    console.log(chalk.yellow(`  Permission required: ${toolName}`))
    if (detail) console.log(chalk.yellow(detail))
    console.log(chalk.dim(`  reason: ${message}`))

    return new Promise<'y' | 'a' | 'n'>((resolve) => {
      rl.question(chalk.yellow('  Allow? [y/a(lways)/N] '), (answer) => {
        const a = answer.trim().toLowerCase()
        if (a === 'a') {
          console.log(chalk.green('  always allowed (saved).'))
          resolve('a')
        } else if (a === 'y') {
          resolve('y')
        } else {
          console.log(chalk.red('  denied.'))
          resolve('n')
        }
      })
    })
  }
}

async function main() {
  const { provider, defaultModel } = createProvider()
  let model = process.env.OCC_MODEL ?? defaultModel
  const cwd = process.cwd()
  const tools = createToolRegistry()
  const contextManager = new ContextManager()

  // --- Permission Mode ---
  const args = process.argv.slice(2)
  let permissionMode: PermissionMode = 'auto'
  if (args.includes('--bypass-permissions')) {
    permissionMode = 'bypass'
  } else if (args.includes('--ask-permissions')) {
    permissionMode = 'ask'
  }

  // --- Session Manager ---
  const sessionManager = new SessionManager()
  let resumeSessionId: string | undefined
  const resumeIdx = args.indexOf('--resume')
  if (resumeIdx !== -1) {
    // --resume <id> or --resume (interactive picker)
    const nextArg = args[resumeIdx + 1]
    if (nextArg && !nextArg.startsWith('--')) {
      resumeSessionId = nextArg
    } else {
      resumeSessionId = '' // empty string = interactive picker
    }
  }

  // --- MCP Integration ---
  let mcpManager: MCPManager | null = null
  const mcpConfigs = loadMCPConfig()
  if (mcpConfigs.length > 0) {
    mcpManager = new MCPManager()
    await mcpManager.connect(mcpConfigs)
    for (const tool of mcpManager.getTools()) {
      tools.register(tool)
    }
    // Cleanup on exit
    process.on('beforeExit', () => mcpManager?.disconnect())
  }

  // --- ToolSearch (register after MCP so it can search all deferred tools) ---
  const deferredCount = tools.deferredTools().length
  if (deferredCount > 0) {
    tools.register(createToolSearchTool(tools))
  }

  // --- Memory System ---
  const memoryManager = new MemoryManager({ projectDir: cwd })
  setMemoryManager(memoryManager)
  await memoryManager.ensureDir()

  // Pre-fetch session context in parallel (git, memory index, CLAUDE.md)
  const [gitContext, memoryIndex, claudeMd] = await Promise.all([
    getGitContext(cwd),
    memoryManager.loadMemoryIndex(),
    loadClaudeMdFiles(cwd),
  ])

  // --- Non-interactive --print mode ---
  const printIdx = args.indexOf('--print')
  if (printIdx !== -1) {
    let prompt = args[printIdx + 1]
    if (!prompt || prompt.startsWith('--')) {
      // Read from stdin
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      prompt = Buffer.concat(chunks).toString('utf-8').trim()
    }
    if (!prompt) {
      console.error('No prompt provided')
      process.exit(1)
    }

    const deferredToolNames = tools.deferredTools().map(t => t.name)
    const systemPrompt = buildSystemPrompt({ cwd, gitContext, claudeMd, memoryIndex, deferredToolNames })
    const printMessages: Message[] = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]

    for await (const event of agentLoop({
      provider,
      model,
      messages: printMessages,
      tools,
      systemPrompt,
      toolContext: { cwd },
      // --print mode: tools execute without confirmation (like --bypass-permissions).
      // Only use in trusted contexts (local dev, CI with sandboxed env).
      permissionCheck: undefined,
    })) {
      if (event.type === 'text_delta') process.stdout.write(event.text)
    }
    process.stdout.write('\n')
    process.exit(0)
  }

  let messages: Message[] = []

  // --- Session Resume or Create ---
  let savedMessageCount = 0
  if (resumeSessionId !== undefined) {
    if (resumeSessionId === '') {
      // Interactive picker: list sessions and let user choose
      const sessions = await sessionManager.listSessions()
      if (sessions.length === 0) {
        console.log(chalk.yellow('  No sessions found to resume.'))
      } else {
        console.log(chalk.yellow('  Recent sessions:'))
        for (let i = 0; i < sessions.length; i++) {
          const s = sessions[i]!
          const date = new Date(s.createdAt).toLocaleString()
          const preview = s.lastInput ? chalk.dim(` "${s.lastInput}"`) : ''
          console.log(chalk.cyan(`  [${i + 1}]`) + ` ${s.id}` + chalk.dim(` (${date}, ${s.messageCount} msgs)`) + preview)
        }
        console.log(chalk.dim('\n  Usage: --resume <session-id>'))
        process.exit(0)
      }
    } else {
      // Resume a specific session
      try {
        const { messages: restored, metadata } = await sessionManager.loadSession(resumeSessionId)
        messages = restored
        savedMessageCount = messages.length
        sessionManager.setCurrentSession(resumeSessionId)
        console.log(chalk.yellow(`  Resumed session ${resumeSessionId} (${messages.length} messages from ${new Date(metadata.createdAt).toLocaleString()})`))
      } catch (err) {
        console.error(chalk.red(`  Failed to resume session ${resumeSessionId}: ${(err as Error).message}`))
        process.exit(1)
      }
    }
  }

  // Create new session if not resuming
  if (!sessionManager.currentSessionId) {
    await sessionManager.createSession(cwd, model)
  }

  // Welcome
  const mcpStatus = mcpManager?.getStatus() ?? []
  const mcpToolCount = mcpStatus.reduce((sum, s) => sum + s.toolCount, 0)
  console.log()
  console.log(chalk.bold('  open-claude-code') + chalk.dim(' — the essence of Claude Code'))
  console.log(chalk.dim(`  provider: ${provider.name} | model: ${model}`))
  console.log(chalk.dim(`  cwd: ${cwd}`))
  console.log(chalk.dim(`  session: ${sessionManager.currentSessionId}`))
  const activeToolNames = tools.activeTools().map(t => t.name).join(', ')
  console.log(chalk.dim(`  tools: ${activeToolNames}`))
  if (deferredCount > 0) {
    console.log(chalk.dim(`  deferred: ${deferredCount} tool(s) (discoverable via ToolSearch)`))
  }
  if (mcpToolCount > 0) {
    console.log(chalk.dim(`  mcp: ${mcpStatus.length} server(s), ${mcpToolCount} tool(s)`))
  }
  const modeLabel = permissionMode === 'bypass' ? chalk.red(permissionMode) : chalk.green(permissionMode)
  console.log(chalk.dim('  permissions: ') + modeLabel)
  console.log(chalk.dim(`  memory: ${memoryManager.memoryPath}`))
  if (claudeMd) console.log(chalk.dim('  CLAUDE.md: loaded'))
  console.log(chalk.dim('  type /help for commands'))
  console.log()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('occ> '),
    history: loadInputHistory(),
    historySize: MAX_HISTORY,
  })

  /** Update prompt with cost and context usage indicators. */
  function updatePrompt(): void {
    const statusParts: string[] = []
    const cost = calculateCostUSD(model, totalUsage)
    if (cost > 0) statusParts.push(`$${cost.toFixed(2)}`)
    if (messages.length > 0) {
      const ctxPercent = contextManager.getUsagePercent(messages)
      if (ctxPercent > 0) {
        let ctxStr = `ctx:${ctxPercent}%`
        if (ctxPercent >= 95) {
          ctxStr = chalk.red(ctxStr)
        } else if (ctxPercent >= 80) {
          ctxStr = chalk.yellow(ctxStr)
        }
        statusParts.push(ctxStr)
      }
    }
    const status = statusParts.length > 0 ? chalk.dim(` [${statusParts.join(' | ')}]`) : ''
    rl.setPrompt(chalk.cyan('occ> ') + status + ' ')
  }

  /** Update prompt indicators and show prompt. */
  function prompt(): void {
    updatePrompt()
    rl.prompt()
  }

  // --- Permission Manager (needs rl for interactive prompts) ---
  const permissionManager = new PermissionManager({
    mode: permissionMode,
    askUser: createPermissionPrompter(rl),
  })

  prompt()

  let abortController: AbortController | null = null

  // Ctrl+C: abort current request, don't exit
  rl.on('SIGINT', () => {
    if (abortController) {
      abortController.abort()
      abortController = null
      console.log(chalk.yellow('\n  (interrupted)'))
      prompt()
    } else {
      console.log(chalk.dim('\n  (use /exit to quit)'))
      prompt()
    }
  })

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) { prompt(); return }

    // --- Slash commands ---
    if (input === '/exit' || input === '/quit') {
      await sessionManager.flush()
      console.log(chalk.dim('  bye.'))
      process.exit(0)
    }
    if (input === '/clear') {
      messages = []
      savedMessageCount = 0
      // Start a fresh session
      await sessionManager.createSession(cwd, model)
      console.log(chalk.yellow(`  conversation cleared. new session: ${sessionManager.currentSessionId}`))
      prompt()
      return
    }
    if (input === '/cost') {
      console.log(chalk.yellow(`  ${formatUsage()}`))
      const cost = calculateCostUSD(model, totalUsage)
      if (cost > 0) {
        console.log(chalk.yellow(`  cost: $${cost.toFixed(2)}`))
      }
      prompt()
      return
    }
    if (input.startsWith('/model')) {
      const newModel = input.slice('/model'.length).trim()
      if (newModel) {
        model = newModel
        console.log(chalk.yellow(`  model → ${model}`))
      } else {
        console.log(chalk.yellow(`  current model: ${model}`))
      }
      prompt()
      return
    }
    if (input === '/mcp') {
      const status = mcpManager?.getStatus() ?? []
      if (status.length === 0) {
        console.log(chalk.yellow('  No MCP servers connected.'))
        console.log(chalk.dim('  Configure servers in ~/.occ/mcp.json or set OCC_MCP_CONFIG'))
      } else {
        for (const server of status) {
          console.log(chalk.cyan(`  ${server.name}`) + chalk.dim(` (${server.toolCount} tools)`))
          for (const toolName of server.tools) {
            console.log(chalk.dim(`    - ${toolName}`))
          }
        }
      }
      prompt()
      return
    }
    if (input.startsWith('/permissions')) {
      const newMode = input.slice('/permissions'.length).trim()
      if (newMode === 'auto' || newMode === 'ask' || newMode === 'bypass') {
        permissionManager.setMode(newMode)
        const label = newMode === 'bypass' ? chalk.red(newMode) : chalk.green(newMode)
        console.log(chalk.yellow(`  permissions → `) + label)
      } else if (newMode === 'rules') {
        const rules = permissionManager.getRules()
        if (rules.length === 0) {
          console.log(chalk.yellow('  No persistent permission rules.'))
        } else {
          console.log(chalk.yellow(`  ${rules.length} persistent rule(s):`))
          for (const r of rules) {
            const pat = r.pattern ? ` "${r.pattern}"` : ''
            const beh = r.behavior === 'allow' ? chalk.green(r.behavior) : chalk.red(r.behavior)
            console.log(chalk.dim(`    ${r.toolName}${pat} → `) + beh)
          }
        }
        console.log(chalk.dim('  File: ~/.occ/permissions.json'))
      } else if (newMode) {
        console.log(chalk.red(`  Unknown mode: ${newMode}. Use auto, ask, bypass, or rules.`))
      } else {
        const currentMode = permissionManager.getMode()
        const label = currentMode === 'bypass' ? chalk.red(currentMode) : chalk.green(currentMode)
        console.log(chalk.yellow('  permissions: ') + label)
        console.log(chalk.dim('  modes: auto (smart per-tool), ask (confirm all), bypass (allow all)'))
        console.log(chalk.dim('  /permissions rules — show persistent always-allow rules'))
      }
      prompt()
      return
    }
    if (input === '/memory') {
      const memories = await memoryManager.scanMemories()
      if (memories.length === 0) {
        console.log(chalk.yellow('  No memories saved yet.'))
        console.log(chalk.dim(`  Memory directory: ${memoryManager.memoryPath}`))
      } else {
        console.log(chalk.yellow(`  ${memories.length} memories:`))
        for (const m of memories) {
          console.log(chalk.cyan(`  [${m.type}]`) + ` ${m.name}` + chalk.dim(` — ${m.description}`))
        }
        console.log(chalk.dim(`  Directory: ${memoryManager.memoryPath}`))
      }
      prompt()
      return
    }
    if (input === '/session') {
      console.log(chalk.yellow(`  session: ${sessionManager.currentSessionId}`))
      prompt()
      return
    }
    if (input === '/resume' || input.startsWith('/resume ')) {
      const arg = input.slice('/resume'.length).trim()
      if (arg) {
        try {
          const { messages: restored, metadata } = await sessionManager.loadSession(arg)
          messages = restored
          savedMessageCount = messages.length
          sessionManager.setCurrentSession(arg)
          console.log(chalk.yellow(`  Resumed session ${arg} (${messages.length} messages from ${new Date(metadata.createdAt).toLocaleString()})`))
        } catch (err) {
          console.log(chalk.red(`  Failed to resume: ${(err as Error).message}`))
        }
      } else {
        const sessions = await sessionManager.listSessions()
        if (sessions.length === 0) {
          console.log(chalk.yellow('  No sessions found.'))
        } else {
          console.log(chalk.yellow('  Recent sessions:'))
          for (const s of sessions) {
            const date = new Date(s.createdAt).toLocaleString()
            const current = s.id === sessionManager.currentSessionId ? chalk.green(' (current)') : ''
            const preview = s.lastInput ? chalk.dim(` "${s.lastInput}"`) : ''
            console.log(chalk.cyan(`  ${s.id}`) + chalk.dim(` (${date}, ${s.messageCount} msgs)`) + current + preview)
          }
          console.log(chalk.dim('  Usage: /resume <session-id>'))
        }
      }
      prompt()
      return
    }
    if (input === '/compact' || input.startsWith('/compact ')) {
      if (messages.length === 0) {
        console.log(chalk.yellow('  nothing to compact.'))
        prompt()
        return
      }
      console.log(chalk.yellow('  compacting conversation...'))
      const result = await contextManager.compact(messages, provider, model)
      if (result.compacted) {
        messages = result.messages
        const percent = contextManager.getUsagePercent(messages)
        console.log(chalk.green(`  compacted. context: ${percent}%`))
        if (result.summary) {
          console.log(chalk.dim(`  summary: ${result.summary.slice(0, 200)}...`))
        }
      } else {
        console.log(chalk.yellow('  nothing to compact.'))
      }
      prompt()
      return
    }
    if (input === '/doctor') {
      const results = await runDiagnostics({ cwd, provider: provider.name, model })
      console.log(chalk.bold('\n  System Diagnostics\n'))
      console.log(formatDiagnostics(results))
      console.log()
      prompt()
      return
    }
    if (input === '/help') {
      console.log(chalk.dim('  /exit        quit'))
      console.log(chalk.dim('  /clear       clear conversation'))
      console.log(chalk.dim('  /compact     compact conversation context'))
      console.log(chalk.dim('  /cost        show token usage & USD cost'))
      console.log(chalk.dim('  /doctor      run system diagnostics'))
      console.log(chalk.dim('  /memory      list saved memories'))
      console.log(chalk.dim('  /mcp         show MCP servers and tools'))
      console.log(chalk.dim('  /model       show or switch model'))
      console.log(chalk.dim('  /permissions show or switch permission mode'))
      console.log(chalk.dim('  /resume      list/resume sessions'))
      console.log(chalk.dim('  /session     show current session ID'))
      prompt()
      return
    }

    // --- Agent turn ---
    // Persist input history (skip slash commands and empty lines)
    if (!input.startsWith('/') && input.length > 0) {
      appendInputHistory(input)
    }

    rl.pause()
    abortController = new AbortController()
    const turnStartTime = Date.now()

    // Context compaction before next turn
    if (contextManager.needsCompaction(messages)) {
      console.log(chalk.yellow('  (compacting context...)'))
      const result = await contextManager.compact(messages, provider, model)
      if (result.compacted) {
        messages = result.messages
      }
    }

    // Push user message into conversation history
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: input }],
    })

    // Build system prompt: blocks[0]=static (cached), blocks[1]=dynamic
    const deferredToolNames = tools.deferredTools().map(t => t.name)
    const systemPrompt = buildSystemPrompt({ cwd, gitContext, claudeMd, memoryIndex, deferredToolNames })

    // Start spinner just before API call
    const spinner = new Spinner()
    let spinnerStopped = false
    spinner.start()

    try {
      const stream = agentLoop({
        provider,
        model,
        messages,
        tools,
        systemPrompt,
        abortSignal: abortController.signal,
        toolContext: { cwd },
        permissionCheck: (toolName, toolInput) => permissionManager.check(toolName, toolInput),
        onCompact: async (msgs) => {
          const result = await contextManager.compact(msgs, provider, model)
          if (result.compacted) {
            console.log(chalk.yellow('  (context compacted)'))
            return result.messages
          }
          return msgs
        },
      })

      let lastWasText = false

      for await (const event of stream) {
        switch (event.type) {
          case 'text_delta':
            if (!spinnerStopped) { spinner.stop(); spinnerStopped = true }
            process.stdout.write(renderInline(event.text))
            lastWasText = true
            break

          case 'thinking_delta':
            if (!spinnerStopped) { spinner.stop(); spinnerStopped = true }
            // Optionally show thinking (dimmed)
            process.stdout.write(chalk.dim(event.thinking))
            lastWasText = true
            break

          case 'tool_start':
            if (!spinnerStopped) { spinner.stop(); spinnerStopped = true }
            if (lastWasText) { console.log(); lastWasText = false }
            console.log(chalk.dim('  ') + chalk.cyan.bold(event.name) + chalk.dim(` [${event.id.slice(0, 8)}]`))
            break

          case 'tool_progress':
            process.stdout.write(chalk.dim(event.output))
            break

          case 'tool_result':
            if (event.isError) {
              console.log(chalk.red(`    \u2717 ${event.result.slice(0, 200)}`))
            } else {
              const lines = event.result.split('\n')
              // Detect diff output (contains - and + lines) and colorize
              const hasDiff = lines.some(l => l.startsWith('- ')) && lines.some(l => l.startsWith('+ '))
              if (hasDiff) {
                const preview = lines.slice(0, 8).map(l => {
                  if (l.startsWith('- ')) return chalk.red(`    ${l}`)
                  if (l.startsWith('+ ')) return chalk.green(`    ${l}`)
                  if (l.startsWith('--- ') || l.startsWith('+++ ')) return chalk.dim(`    ${l}`)
                  return chalk.dim(`    ${l}`)
                }).join('\n')
                console.log(preview + (lines.length > 8 ? chalk.dim(`\n    ... (${lines.length} lines)`) : ''))
              } else {
                const preview = lines.slice(0, 3).map(l => `    ${l}`).join('\n')
                console.log(chalk.dim(preview + (lines.length > 3 ? `\n    ... (${lines.length} lines)` : '')))
              }
            }
            break

          case 'turn_complete':
            accumulateUsage(event.usage)
            break

          case 'message_complete': {
            if (!spinnerStopped) { spinner.stop(); spinnerStopped = true }
            if (lastWasText) console.log()
            accumulateUsage(event.totalUsage)
            // Sync messages back (agent loop may have added assistant + tool_result messages)
            messages = event.messages
            // Persist new messages to session file (incremental append)
            if (sessionManager.currentSessionId) {
              const newMessages = messages.slice(savedMessageCount)
              if (newMessages.length > 0) {
                sessionManager.appendMessages(sessionManager.currentSessionId, newMessages)
                  .catch(err => console.error(chalk.red(`  Session save error: ${(err as Error).message}`)))
                savedMessageCount = messages.length
              }
            }
            // Notify if turn took > 10 seconds
            const turnElapsed = Date.now() - turnStartTime
            if (turnElapsed > 10_000) {
              notifyCompletion(`Done (${(turnElapsed / 1000).toFixed(0)}s)`)
            }
            break
          }
        }
      }
    } catch (err) {
      if (!spinnerStopped) { spinner.stop(); spinnerStopped = true }
      if ((err as Error).name !== 'AbortError') {
        console.error(chalk.red(`\n  Error: ${(err as Error).message ?? err}`))
      }
    }

    abortController = null
    console.log()
    rl.resume()
    prompt()
  })

  rl.on('close', async () => {
    await sessionManager.flush()
    console.log(chalk.dim('\n  bye.'))
    process.exit(0)
  })
}

main()
