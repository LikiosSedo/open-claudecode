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
import { agentLoop } from './agent.js'
import { buildSystemPrompt, getGitContext } from './prompt.js'
import { ContextManager } from './context.js'

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

// --- Main ---

async function main() {
  const { provider, defaultModel } = createProvider()
  let model = process.env.OCC_MODEL ?? defaultModel
  const cwd = process.cwd()
  const tools = createToolRegistry()
  const contextManager = new ContextManager()

  // Pre-fetch git context once per session (design from Claude Code: memoized per session)
  const gitContext = await getGitContext(cwd)

  let messages: Message[] = []

  // Welcome
  console.log()
  console.log(chalk.bold('  open-claude-code') + chalk.dim(' — the essence of Claude Code'))
  console.log(chalk.dim(`  provider: ${provider.name} | model: ${model}`))
  console.log(chalk.dim(`  cwd: ${cwd}`))
  console.log(chalk.dim(`  tools: ${tools.all().map(t => t.name).join(', ')}`))
  console.log(chalk.dim('  type /help for commands'))
  console.log()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('occ> '),
  })

  rl.prompt()

  let abortController: AbortController | null = null

  // Ctrl+C: abort current request, don't exit
  rl.on('SIGINT', () => {
    if (abortController) {
      abortController.abort()
      abortController = null
      console.log(chalk.yellow('\n  (interrupted)'))
      rl.prompt()
    } else {
      console.log(chalk.dim('\n  (use /exit to quit)'))
      rl.prompt()
    }
  })

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) { rl.prompt(); return }

    // --- Slash commands ---
    if (input === '/exit' || input === '/quit') {
      console.log(chalk.dim('  bye.'))
      process.exit(0)
    }
    if (input === '/clear') {
      messages = []
      console.log(chalk.yellow('  conversation cleared.'))
      rl.prompt()
      return
    }
    if (input === '/cost') {
      console.log(chalk.yellow(`  ${formatUsage()}`))
      rl.prompt()
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
      rl.prompt()
      return
    }
    if (input === '/help') {
      console.log(chalk.dim('  /exit     quit'))
      console.log(chalk.dim('  /clear    clear conversation'))
      console.log(chalk.dim('  /model    show or switch model'))
      console.log(chalk.dim('  /cost     show token usage'))
      rl.prompt()
      return
    }

    // --- Agent turn ---
    abortController = new AbortController()

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
    const systemPrompt = buildSystemPrompt({ cwd, gitContext })

    try {
      const stream = agentLoop({
        provider,
        model,
        messages,
        tools,
        systemPrompt,
        abortSignal: abortController.signal,
        toolContext: { cwd },
      })

      let lastWasText = false

      for await (const event of stream) {
        switch (event.type) {
          case 'text_delta':
            process.stdout.write(event.text)
            lastWasText = true
            break

          case 'thinking_delta':
            // Optionally show thinking (dimmed)
            process.stdout.write(chalk.dim(event.thinking))
            lastWasText = true
            break

          case 'tool_start':
            if (lastWasText) { console.log(); lastWasText = false }
            console.log(chalk.dim('  ') + chalk.cyan.bold(event.name) + chalk.dim(` [${event.id.slice(0, 8)}]`))
            break

          case 'tool_result':
            if (event.isError) {
              console.log(chalk.red(`    ✗ ${event.result.slice(0, 200)}`))
            } else {
              const lines = event.result.split('\n')
              const preview = lines.slice(0, 3).map(l => `    ${l}`).join('\n')
              console.log(chalk.dim(preview + (lines.length > 3 ? `\n    ... (${lines.length} lines)` : '')))
            }
            break

          case 'turn_complete':
            accumulateUsage(event.usage)
            break

          case 'message_complete':
            if (lastWasText) console.log()
            accumulateUsage(event.totalUsage)
            // Sync messages back (agent loop may have added assistant + tool_result messages)
            messages = event.messages
            break
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error(chalk.red(`\n  Error: ${(err as Error).message ?? err}`))
      }
    }

    abortController = null
    console.log()
    rl.prompt()
  })

  rl.on('close', () => {
    console.log(chalk.dim('\n  bye.'))
    process.exit(0)
  })
}

main()
