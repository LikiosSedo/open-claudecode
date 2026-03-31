import { describe, it, expect } from 'vitest'
import { StreamingToolExecutor } from '../agent.js'
import type { Tool, ToolRegistry, ToolContext, ToolResult } from '../tools/types.js'

function makeTool(name: string, concurrencySafe: boolean, handler?: (input: any) => Promise<ToolResult>): Tool {
  return {
    name,
    description: '',
    inputSchema: {} as any,
    isConcurrencySafe: concurrencySafe,
    isReadOnly: concurrencySafe,
    async execute(input: any, _ctx: ToolContext): Promise<ToolResult> {
      if (handler) return handler(input)
      return { output: `${name} done` }
    },
  }
}

function makeRegistry(tools: Tool[]): ToolRegistry {
  const map = new Map<string, Tool>()
  for (const t of tools) map.set(t.name, t)
  return { get: (name: string) => map.get(name) } as ToolRegistry
}

const ctx: ToolContext = { cwd: '/tmp' }

async function collectResults(executor: StreamingToolExecutor) {
  const results: Array<{ name: string; id: string; result: string; isError: boolean }> = []
  for await (const r of executor.getResults()) {
    results.push(r)
  }
  return results
}

describe('StreamingToolExecutor', () => {
  it('executes concurrent-safe tools in parallel', async () => {
    const order: string[] = []
    const readTool = makeTool('Read', true, async () => {
      order.push('read-start')
      await new Promise(r => setTimeout(r, 20))
      order.push('read-end')
      return { output: 'read ok' }
    })
    const grepTool = makeTool('Grep', true, async () => {
      order.push('grep-start')
      await new Promise(r => setTimeout(r, 20))
      order.push('grep-end')
      return { output: 'grep ok' }
    })

    const registry = makeRegistry([readTool, grepTool])
    const executor = new StreamingToolExecutor(registry, ctx)

    executor.addTool('1', 'Read', {})
    executor.addTool('2', 'Grep', {})

    const results = await collectResults(executor)
    expect(results).toHaveLength(2)
    // Both started before either ended (parallel execution)
    expect(order.indexOf('grep-start')).toBeLessThan(order.indexOf('read-end'))
  })

  it('executes non-concurrent tools sequentially', async () => {
    const order: string[] = []
    const bashTool = makeTool('Bash', false, async () => {
      order.push('bash-start')
      await new Promise(r => setTimeout(r, 10))
      order.push('bash-end')
      return { output: 'bash ok' }
    })
    const writeTool = makeTool('Write', false, async () => {
      order.push('write-start')
      await new Promise(r => setTimeout(r, 10))
      order.push('write-end')
      return { output: 'write ok' }
    })

    const registry = makeRegistry([bashTool, writeTool])
    const executor = new StreamingToolExecutor(registry, ctx)

    executor.addTool('1', 'Bash', {})
    executor.addTool('2', 'Write', {})

    const results = await collectResults(executor)
    expect(results).toHaveLength(2)
    // First must finish before second starts
    expect(order.indexOf('bash-end')).toBeLessThan(order.indexOf('write-start'))
  })

  it('bash error cancels siblings', async () => {
    const bashTool = makeTool('Bash', false, async () => {
      return { output: 'command failed', isError: true }
    })
    const writeTool = makeTool('Write', false, async () => {
      return { output: 'write ok' }
    })

    const registry = makeRegistry([bashTool, writeTool])
    const executor = new StreamingToolExecutor(registry, ctx)

    executor.addTool('1', 'Bash', { command: 'exit 1' })
    executor.addTool('2', 'Write', { file_path: '/tmp/x' })

    const results = await collectResults(executor)
    expect(results).toHaveLength(2)
    expect(results[0]!.isError).toBe(true)
    // Second tool should be cancelled
    expect(results[1]!.isError).toBe(true)
    expect(results[1]!.result).toContain('Cancelled')
  })

  it('non-bash error does not cancel siblings', async () => {
    const readTool = makeTool('Read', true, async () => {
      return { output: 'file not found', isError: true }
    })
    const grepTool = makeTool('Grep', true, async () => {
      await new Promise(r => setTimeout(r, 10))
      return { output: 'grep ok' }
    })

    const registry = makeRegistry([readTool, grepTool])
    const executor = new StreamingToolExecutor(registry, ctx)

    executor.addTool('1', 'Read', {})
    executor.addTool('2', 'Grep', {})

    const results = await collectResults(executor)
    expect(results).toHaveLength(2)
    expect(results[0]!.isError).toBe(true)
    expect(results[1]!.isError).toBe(false)
    expect(results[1]!.result).toBe('grep ok')
  })

  it('non-concurrent executing tool blocks yielding of later results', async () => {
    // Bash (non-concurrent) submitted first, Read submitted second.
    // Even if Read completes first, it should NOT be yielded until Bash finishes
    // because yieldCompleted breaks on non-concurrent executing tools.
    const bashTool = makeTool('Bash', false, async () => {
      await new Promise(r => setTimeout(r, 40))
      return { output: 'bash ok' }
    })
    const readTool = makeTool('Read', true, async () => {
      return { output: 'read ok' }
    })

    const registry = makeRegistry([bashTool, readTool])
    const executor = new StreamingToolExecutor(registry, ctx)

    // Bash is non-concurrent, so Read won't even start until Bash finishes.
    // Results must come back in submission order: Bash first, Read second.
    executor.addTool('1', 'Bash', {})
    executor.addTool('2', 'Read', {})

    const results = await collectResults(executor)
    expect(results[0]!.name).toBe('Bash')
    expect(results[1]!.name).toBe('Read')
  })

  it('handles unknown tool gracefully', async () => {
    const registry = makeRegistry([])
    const executor = new StreamingToolExecutor(registry, ctx)

    executor.addTool('1', 'NoSuchTool', {})

    const results = await collectResults(executor)
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(true)
    expect(results[0]!.result).toContain('No such tool')
  })
})
