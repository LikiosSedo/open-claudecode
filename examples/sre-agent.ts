/**
 * SRE Diagnostic Agent — diagnoses a crashing Kubernetes pod.
 *
 * Demonstrates: permission hooks (ask mode), single-shot diagnostic prompt, mock infra tools.
 * Run: npx tsx examples/sre-agent.ts
 */

import { Agent } from '../src/engine.js'
import { z } from 'zod'
import type { Tool } from '../src/tools/types.js'

// -- Mock data --

const KUBECTL_RESPONSES: Record<string, string> = {
  'get pods': [
    'NAME            READY   STATUS             RESTARTS   AGE',
    'nginx-abc123    1/1     Running            0          2d',
    'api-def456      0/1     CrashLoopBackOff   5          1h',
    'redis-ghi789    1/1     Running            0          5d',
  ].join('\n'),
  'describe pod api-def456': [
    'Name:         api-def456',
    'Status:       CrashLoopBackOff',
    'Restart Count: 5',
    'Last State:   Terminated (Exit Code 137 — OOMKilled)',
    'Limits:       memory=256Mi, cpu=200m',
    'Requests:     memory=128Mi, cpu=100m',
  ].join('\n'),
  'logs api-def456': [
    '[2026-04-02T10:00:01Z] INFO  Starting api-server v2.3.1',
    '[2026-04-02T10:00:02Z] INFO  Loading config from /etc/api/config.yaml',
    '[2026-04-02T10:00:03Z] INFO  Connected to redis-ghi789:6379',
    '[2026-04-02T10:00:05Z] WARN  Memory usage at 80% of limit',
    '[2026-04-02T10:00:08Z] ERROR Memory usage at 95% — approaching OOM',
    '[2026-04-02T10:00:09Z] FATAL OOMKilled by kernel',
  ].join('\n'),
}

const METRICS_DATA: Record<string, string> = {
  'memory': 'api-def456 memory usage: 128Mi → 245Mi over last hour (limit: 256Mi). Spike correlates with v2.3.1 deploy at 09:45.',
  'cpu': 'api-def456 CPU usage: steady at 80m (well within 200m limit).',
  'restarts': 'api-def456 restart count: 0 → 5 in last hour. First restart at 09:55, ~10min after deploy.',
}

// -- Tools --

const KubectlTool: Tool = {
  name: 'Kubectl',
  description: 'Run a kubectl command (read-only). Supported: get pods, describe pod <name>, logs <name>',
  inputSchema: z.object({
    command: z.string().describe('The kubectl command to run'),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input) {
    const cmd = (input as { command: string }).command
    const output = KUBECTL_RESPONSES[cmd]
    if (!output) return { output: `Error: unknown command "kubectl ${cmd}"`, isError: true }
    console.log(`  $ kubectl ${cmd}`)
    return { output }
  },
}

const QueryMetricsTool: Tool = {
  name: 'QueryMetrics',
  description: 'Query Prometheus metrics for a pod. Metric types: memory, cpu, restarts',
  inputSchema: z.object({
    pod: z.string().describe('Pod name'),
    metric: z.enum(['memory', 'cpu', 'restarts']).describe('Metric type'),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input) {
    const metric = (input as { metric: string }).metric
    const output = METRICS_DATA[metric]
    if (!output) return { output: `No data for metric "${metric}"`, isError: true }
    console.log(`  📊 Querying ${metric} metrics...`)
    return { output }
  },
}

const SearchLogsTool: Tool = {
  name: 'SearchLogs',
  description: 'Search centralized logs (Loki) by query string',
  inputSchema: z.object({
    query: z.string().describe('Search query'),
    timeRange: z.string().optional().describe('Time range, e.g. "1h"'),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input) {
    const query = (input as { query: string }).query
    console.log(`  🔍 Searching logs for "${query}"...`)
    if (query.toLowerCase().includes('oom') || query.toLowerCase().includes('memory')) {
      return {
        output: [
          '[api-def456] 10:00:05 WARN  Memory usage at 80% of limit',
          '[api-def456] 10:00:08 ERROR Memory usage at 95%',
          '[api-def456] 10:00:09 FATAL OOMKilled by kernel',
          '[api-def456] 09:55:09 FATAL OOMKilled by kernel  (previous instance)',
          'Found 12 OOM-related entries in the last hour, all from api-def456.',
        ].join('\n'),
      }
    }
    return { output: `No results matching "${query}" in the last hour.` }
  },
}

// -- Main --

async function main() {
  console.log('=== SRE Diagnostic Agent ===')
  console.log('Prompt: "Pod api-def456 is in CrashLoopBackOff. Diagnose the root cause."\n')

  const agent = new Agent({
    tools: [KubectlTool, QueryMetricsTool, SearchLogsTool],
    systemPrompt: [
      'You are an SRE diagnostic agent. Your job is to investigate infrastructure issues methodically.',
      'Always start by gathering data: check pod status, then logs, then metrics.',
      'After gathering evidence, provide a clear root cause analysis and recommended fix.',
      'Be concise and structured. Use bullet points for findings.',
    ].join(' '),
    maxTurns: 10,
    hooks: {
      async preToolUse(toolName, input) {
        console.log(`  [permission] Tool "${toolName}" — auto-approved (read-only)`)
        return { allow: true }
      },
    },
  })

  for await (const event of agent.run('Pod api-def456 is in CrashLoopBackOff. Diagnose the root cause and recommend a fix.')) {
    if (event.type === 'text_delta') {
      process.stdout.write(event.text)
    }
  }

  console.log('\n\n=== Diagnosis complete ===')
}

main().catch(console.error)
