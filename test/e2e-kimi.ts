/**
 * E2E harness test — calls real Kimi-K2.5 API via the Agent SDK.
 * Verifies agent loop, tool execution, and tracing instrumentation.
 *
 * Run: npx tsx test/e2e-kimi.ts
 */

import { Agent, type TraceEvent, type AgentEvent } from '../src/engine.js'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { strict as assert } from 'assert'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config = JSON.parse(
  readFileSync(join(homedir(), '.occ', 'config.json'), 'utf-8'),
)

const TEST_TIMEOUT_MS = 30_000
const PROJECT_ROOT = join(import.meta.dirname!, '..')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
let totalTraceEvents = 0

async function runTest(name: string, fn: () => Promise<void>) {
  const start = Date.now()
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), TEST_TIMEOUT_MS),
      ),
    ])
    const elapsed = Date.now() - start
    console.log(`  \u2713 ${name} (${elapsed}ms)`)
    passed++
  } catch (err) {
    const elapsed = Date.now() - start
    console.log(`  \u2717 ${name} (${elapsed}ms): ${(err as Error).message}`)
    failed++
  }
}

/** Collect full text output from an agent run. */
async function collectText(gen: AsyncGenerator<AgentEvent>): Promise<string> {
  let text = ''
  for await (const e of gen) {
    if (e.type === 'text_delta') text += e.text
  }
  return text
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nE2E Kimi-K2.5 harness test`)
  console.log(`  model:   ${config.model}`)
  console.log(`  baseUrl: ${config.baseUrl}\n`)

  // Shared trace collector — reset per test
  let traces: TraceEvent[] = []

  function makeAgent(): Agent {
    return new Agent({
      provider: {
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        type: 'openai',
      },
      tools: 'coding',
      systemPrompt: 'You are a helpful assistant. Be concise. When asked to use tools, use them without asking for confirmation.',
      cwd: PROJECT_ROOT,
      maxTurns: 10,
      onTrace: (e) => traces.push(e),
    })
  }

  // -- Test 1: Basic text response -----------------------------------------

  await runTest('Basic text response', async () => {
    traces = []
    const agent = makeAgent()
    const text = await collectText(agent.run('Say exactly: hello world'))

    assert(
      text.toLowerCase().includes('hello world'),
      `Expected "hello world" in response, got: "${text.slice(0, 200)}"`,
    )

    // Trace checks
    assert(traces.some(t => t.type === 'llm_start'), 'Missing llm_start trace')
    assert(traces.some(t => t.type === 'llm_end'), 'Missing llm_end trace')
    assert(traces.some(t => t.type === 'turn_summary'), 'Missing turn_summary trace')

    // llm_end should have usage object (some providers report 0 tokens in streaming)
    const llmEnd = traces.find(t => t.type === 'llm_end')!
    assert(llmEnd.type === 'llm_end' && llmEnd.usage != null, 'llm_end should have usage object')
    assert(llmEnd.type === 'llm_end' && llmEnd.durationMs > 0, 'llm_end should have positive durationMs')

    totalTraceEvents += traces.length
  })

  // -- Test 2: Tool use — Read file ----------------------------------------

  await runTest('Tool use: Read file', async () => {
    traces = []
    const agent = makeAgent()

    let sawToolStart = false
    let sawToolResult = false
    let resultText = ''

    for await (const e of agent.run(`Read the file at ${PROJECT_ROOT}/package.json and tell me the package name.`)) {
      if (e.type === 'tool_start' && e.name === 'Read') sawToolStart = true
      if (e.type === 'tool_result' && e.name === 'Read') sawToolResult = true
      if (e.type === 'text_delta') resultText += e.text
    }

    assert(sawToolStart, 'Expected tool_start event for Read')
    assert(sawToolResult, 'Expected tool_result event for Read')
    assert(
      resultText.includes('open-claude-cli'),
      `Expected package name "open-claude-cli" in response, got: "${resultText.slice(0, 200)}"`,
    )

    // Trace: should have tool_start and tool_end
    assert(traces.some(t => t.type === 'tool_start' && t.name === 'Read'), 'Missing trace tool_start for Read')
    assert(traces.some(t => t.type === 'tool_end' && t.name === 'Read'), 'Missing trace tool_end for Read')

    totalTraceEvents += traces.length
  })

  // -- Test 3: Multi-tool — Glob + Read ------------------------------------

  await runTest('Multi-tool: Glob + Read', async () => {
    traces = []
    const agent = makeAgent()

    const toolNames = new Set<string>()
    let resultText = ''

    for await (const e of agent.run(
      `Use the Glob tool to find *.json files in ${PROJECT_ROOT} (not recursive), then Read the tsconfig.json file and tell me the target.`,
    )) {
      if (e.type === 'tool_start') toolNames.add(e.name)
      if (e.type === 'text_delta') resultText += e.text
    }

    assert(toolNames.has('Glob'), 'Expected Glob tool to be called')
    assert(toolNames.has('Read'), 'Expected Read tool to be called')
    assert(
      resultText.includes('ES2022'),
      `Expected "ES2022" in response, got: "${resultText.slice(0, 200)}"`,
    )

    // Trace: multiple tool_start/tool_end pairs
    const traceToolStarts = traces.filter(t => t.type === 'tool_start')
    const traceToolEnds = traces.filter(t => t.type === 'tool_end')
    assert(traceToolStarts.length >= 2, `Expected >= 2 tool_start traces, got ${traceToolStarts.length}`)
    assert(traceToolEnds.length >= 2, `Expected >= 2 tool_end traces, got ${traceToolEnds.length}`)

    totalTraceEvents += traces.length
  })

  // -- Test 4: Trace completeness ------------------------------------------

  await runTest('Trace completeness: every turn has summary', async () => {
    traces = []
    const agent = makeAgent()

    // Prompt that should trigger at least one tool call (multi-turn)
    for await (const _ of agent.run(
      `Use the Glob tool to list .ts files in ${PROJECT_ROOT}/src, then tell me how many there are.`,
    )) {
      // drain
    }

    const summaries = traces.filter(t => t.type === 'turn_summary')
    const llmStarts = traces.filter(t => t.type === 'llm_start')
    const llmEnds = traces.filter(t => t.type === 'llm_end')

    // Every turn that started should have ended and have a summary
    assert(llmStarts.length > 0, 'Expected at least one llm_start')
    assert(
      llmStarts.length === llmEnds.length,
      `llm_start (${llmStarts.length}) !== llm_end (${llmEnds.length})`,
    )
    assert(
      summaries.length === llmStarts.length,
      `turn_summary count (${summaries.length}) !== llm_start count (${llmStarts.length})`,
    )

    // Every tool_start should have a matching tool_end
    const toolStarts = traces.filter(t => t.type === 'tool_start')
    const toolEnds = traces.filter(t => t.type === 'tool_end')
    assert(
      toolStarts.length === toolEnds.length,
      `tool_start (${toolStarts.length}) !== tool_end (${toolEnds.length})`,
    )

    // Check turn numbers are monotonically non-decreasing
    const turns = traces.map(t => t.turn)
    for (let i = 1; i < turns.length; i++) {
      assert(turns[i]! >= turns[i - 1]!, `Trace turn numbers not monotonic at index ${i}: ${turns[i - 1]} -> ${turns[i]}`)
    }

    totalTraceEvents += traces.length
  })

  // -- Test 5: Session continuity (same agent, two prompts) ----------------

  await runTest('Session continuity: multi-turn memory', async () => {
    traces = []
    const agent = makeAgent()

    // Turn 1: establish a fact
    await collectText(agent.run('Remember this number: 42. Just confirm you noted it.'))

    // Turn 2: recall
    const recall = await collectText(agent.run('What number did I ask you to remember?'))

    assert(
      recall.includes('42'),
      `Expected "42" in recall response, got: "${recall.slice(0, 200)}"`,
    )

    // Should have traces from both turns
    const llmStarts = traces.filter(t => t.type === 'llm_start')
    assert(llmStarts.length >= 2, `Expected >= 2 llm_start traces for multi-turn, got ${llmStarts.length}`)

    totalTraceEvents += traces.length
  })

  // -- Summary -------------------------------------------------------------

  console.log(`\n${'='.repeat(50)}`)
  console.log(`  Results: ${passed}/${passed + failed} passed`)
  console.log(`  Total trace events collected: ${totalTraceEvents}`)
  console.log(`${'='.repeat(50)}\n`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(2)
})
