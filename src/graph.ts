/**
 * AgentGraph — Stateful workflow graph for multi-step agent orchestration.
 *
 * Inspired by LangGraph's StateGraph, adapted for our Agent SDK.
 * Sits ON TOP of agentLoop — each graph node can call agent.run() internally.
 *
 * Key design decisions:
 * - State is immutable: nodes return new state objects, never mutate
 * - Checkpoints at node boundaries (not mid-stream)
 * - maxIterations prevents infinite loops in conditional edges
 * - Nodes are plain async functions — agent.run(), API calls, or pure logic
 */

import type { AgentEvent } from './agent.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// -- Types --

/** Graph state: plain JSON-serializable object flowing between nodes. */
export interface GraphState {
  [key: string]: unknown
}

/** Node function: receives state, returns updated state. */
export type NodeFunction = (state: GraphState) => Promise<GraphState>

/** Condition function: receives state, returns next node name. */
export type EdgeCondition = (state: GraphState) => string | Promise<string>

/** Special node name indicating the graph should stop. */
export const END = '__END__'

export type GraphEvent =
  | { type: 'node_start'; node: string; state: GraphState }
  | { type: 'node_end'; node: string; state: GraphState; durationMs: number }
  | { type: 'edge'; from: string; to: string }
  | { type: 'checkpoint'; id: string; node: string }
  | { type: 'graph_complete'; state: GraphState; iterations: number }

// -- Checkpoint persistence --

const CHECKPOINT_DIR = join(homedir(), '.occ', 'checkpoints')

function saveCheckpoint(graphName: string, nodeId: string, state: GraphState): string {
  const dir = join(CHECKPOINT_DIR, graphName)
  mkdirSync(dir, { recursive: true })
  const id = `${Date.now().toString(36)}-${nodeId}`
  const path = join(dir, `${id}.json`)
  writeFileSync(path, JSON.stringify({ id, node: nodeId, state, timestamp: Date.now() }))
  return id
}

function loadCheckpoint(graphName: string, checkpointId: string): { node: string; state: GraphState } | null {
  const path = join(CHECKPOINT_DIR, graphName, `${checkpointId}.json`)
  try {
    if (!existsSync(path)) return null
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    return { node: data.node, state: data.state }
  } catch { return null }
}

function listCheckpoints(graphName: string): string[] {
  const dir = join(CHECKPOINT_DIR, graphName)
  try {
    return readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
  } catch { return [] }
}

// -- AgentGraph class --

export class AgentGraph {
  private name: string
  private nodes = new Map<string, NodeFunction>()
  private edges = new Map<string, string | EdgeCondition>()
  private entryNode?: string
  private maxIterations: number
  private checkpointEnabled: boolean

  constructor(name: string, options?: { maxIterations?: number; checkpoint?: boolean }) {
    this.name = name
    this.maxIterations = options?.maxIterations ?? 20
    this.checkpointEnabled = options?.checkpoint ?? true
  }

  /** Add a named node. First node added becomes the entry point. */
  addNode(name: string, fn: NodeFunction): this {
    if (name === END) throw new Error(`Cannot use reserved name "${END}"`)
    this.nodes.set(name, fn)
    if (!this.entryNode) this.entryNode = name
    return this
  }

  /** Add an unconditional edge from → to. */
  addEdge(from: string, to: string): this {
    this.edges.set(from, to)
    return this
  }

  /** Add a conditional edge: condition returns the next node name. */
  addConditionalEdge(from: string, condition: EdgeCondition): this {
    this.edges.set(from, condition)
    return this
  }

  /** Set a specific entry node (overrides first-added default). */
  setEntry(name: string): this {
    this.entryNode = name
    return this
  }

  /** Run the graph from the entry node. */
  async *run(initialState: GraphState = {}): AsyncGenerator<GraphEvent> {
    yield* this.execute(this.entryNode!, { ...initialState, _nodeHistory: [] })
  }

  /** Resume from a checkpoint. */
  async *resume(checkpointId: string): AsyncGenerator<GraphEvent> {
    const cp = loadCheckpoint(this.name, checkpointId)
    if (!cp) throw new Error(`Checkpoint not found: ${checkpointId}`)
    // Find the NEXT node after the checkpointed one
    const nextNode = await this.resolveEdge(cp.node, cp.state)
    if (!nextNode || nextNode === END) {
      yield { type: 'graph_complete', state: cp.state, iterations: 0 }
      return
    }
    yield* this.execute(nextNode, cp.state)
  }

  /** List available checkpoints for this graph. */
  getCheckpoints(): string[] {
    return listCheckpoints(this.name)
  }

  // -- Internal execution --

  private async *execute(startNode: string, state: GraphState): AsyncGenerator<GraphEvent> {
    let currentNode: string | undefined = startNode
    let currentState = { ...state }
    let iterations = 0

    while (currentNode && currentNode !== END) {
      if (iterations >= this.maxIterations) {
        throw new Error(`Graph "${this.name}" exceeded maxIterations (${this.maxIterations}). Possible infinite loop at node "${currentNode}".`)
      }

      const nodeFn = this.nodes.get(currentNode)
      if (!nodeFn) throw new Error(`Node "${currentNode}" not found in graph "${this.name}"`)

      // Track history (immutable)
      const history = [...(currentState._nodeHistory as string[] ?? []), currentNode]

      yield { type: 'node_start', node: currentNode, state: currentState }
      const start = Date.now()

      // Execute node — returns NEW state (immutability enforced)
      const newState = await nodeFn({ ...currentState, _nodeHistory: history })
      currentState = { ...newState, _nodeHistory: history }

      yield { type: 'node_end', node: currentNode, state: currentState, durationMs: Date.now() - start }

      // Checkpoint after each node
      if (this.checkpointEnabled) {
        const cpId = saveCheckpoint(this.name, currentNode, currentState)
        yield { type: 'checkpoint', id: cpId, node: currentNode }
      }

      // Resolve next node
      const nextNode = await this.resolveEdge(currentNode, currentState)
      if (nextNode && nextNode !== END) {
        yield { type: 'edge', from: currentNode, to: nextNode }
      }

      currentNode = nextNode
      iterations++
    }

    yield { type: 'graph_complete', state: currentState, iterations }
  }

  private async resolveEdge(from: string, state: GraphState): Promise<string | undefined> {
    const edge = this.edges.get(from)
    if (!edge) return undefined  // no edge = implicit END
    if (typeof edge === 'string') return edge
    return await edge(state)  // conditional edge
  }
}

// -- Helper: create a node that runs an Agent --

import type { Agent } from './engine.js'

/**
 * Convenience: wrap an Agent.run() call as a graph node.
 * The promptFn builds a prompt from current graph state.
 * The agent's text output is stored in state.lastResult.
 */
export function agentNode(
  agent: Agent,
  promptFn: (state: GraphState) => string,
  options?: { resultKey?: string },
): NodeFunction {
  const key = options?.resultKey ?? 'lastResult'
  return async (state: GraphState): Promise<GraphState> => {
    let result = ''
    for await (const event of agent.run(promptFn(state))) {
      if (event.type === 'text_delta') result += event.text
    }
    return { ...state, [key]: result }
  }
}
