/**
 * Agent Tool — Sub-agent delegation
 *
 * Design from Claude Code's AgentTool + forkedAgent:
 * - Child gets its own messages array (starts from scratch, no context leakage)
 * - Shares parent's provider, tools, and permission policy (no new connections)
 * - Independent AbortController linked to parent (parent abort → child abort)
 * - Depth counter prevents infinite recursion (hard limit: 3 levels)
 * - Token usage from child is reported back so the parent can track total cost
 * - Only final text output is returned; intermediate tool_start/tool_result are hidden
 *
 * cf. Claude Code:
 *   src/tools/AgentTool/AgentTool.tsx — entry point + schema
 *   src/utils/forkedAgent.ts — createSubagentContext(), runForkedAgent()
 */

import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from './types.js'
import type { Message, TokenUsage } from '../providers/types.js'
import { agentLoop } from '../agent.js'

// -- Constants --

/** Maximum nesting depth for sub-agents. Claude Code uses a similar limit. */
const MAX_AGENT_DEPTH = 3

/** Maximum turns a sub-agent can take before forced stop (prevents runaway loops). */
const DEFAULT_MAX_TURNS = 15

/** Truncate sub-agent output at this length to keep parent context manageable. */
const MAX_RESULT_CHARS = 100_000

// -- Input Schema --

const inputSchema = z.object({
  prompt: z.string().describe('The task for the sub-agent to perform'),
  description: z.string().describe('Short (3-5 word) description of the task'),
  model: z.enum(['sonnet', 'opus', 'haiku']).optional()
    .describe('Optional model override for the sub-agent'),
})

type Input = z.infer<typeof inputSchema>

// -- Model Resolution --

/**
 * Resolve a shorthand model name ('sonnet', 'opus', 'haiku') to a full model ID.
 * Falls back to parent model if not specified.
 */
function resolveModel(shorthand: string | undefined, parentModel: string): string {
  if (!shorthand) return parentModel

  // Map shorthands to the latest model IDs
  const MODEL_MAP: Record<string, string> = {
    haiku: 'claude-haiku-4-20250414',
    sonnet: 'claude-sonnet-4-20250514',
    opus: 'claude-opus-4-20250514',
  }

  return MODEL_MAP[shorthand] ?? parentModel
}

// -- Sub-agent System Prompt --

/**
 * Build sub-agent system prompt by wrapping the parent's prompt with
 * sub-agent-specific instructions. The child sees the same tools and
 * capabilities but with explicit scope constraints.
 */
function buildSubagentSystemPrompt(parentPrompt: string | string[]): string[] {
  const parentBlocks = Array.isArray(parentPrompt) ? parentPrompt : [parentPrompt]

  const subagentPreamble = `You are a sub-agent executing a specific task delegated by a parent agent.

RULES:
1. Focus exclusively on the task described in the user message.
2. Do NOT spawn further sub-agents unless absolutely necessary.
3. Be thorough but concise in your final response.
4. If you modify files, describe what you changed.
5. If the task is unclear, do your best with the information given — you cannot ask follow-up questions.
6. Complete the task, then report your findings/results in your final message.`

  // Prepend the sub-agent preamble to the first block (static / cacheable)
  return [subagentPreamble + '\n\n' + parentBlocks[0], ...parentBlocks.slice(1)]
}

// -- Linked Abort Controller --

/**
 * Create an AbortController that automatically aborts when the parent signal fires.
 * Design from Claude Code: createChildAbortController() in abortController.ts.
 */
function createLinkedAbortController(parentSignal?: AbortSignal): AbortController {
  const child = new AbortController()

  if (parentSignal) {
    if (parentSignal.aborted) {
      child.abort(parentSignal.reason)
    } else {
      parentSignal.addEventListener('abort', () => {
        child.abort(parentSignal.reason)
      }, { once: true })
    }
  }

  return child
}

// -- Usage Formatting --

function formatUsage(usage: TokenUsage): string {
  const parts = [`in: ${usage.inputTokens.toLocaleString()}`, `out: ${usage.outputTokens.toLocaleString()}`]
  if (usage.cacheReadTokens && usage.cacheReadTokens > 0) {
    parts.push(`cache-read: ${usage.cacheReadTokens.toLocaleString()}`)
  }
  return parts.join(' | ')
}

// -- Agent Tool --

export const AgentTool: Tool<Input> = {
  name: 'Agent',

  description: `Launch a sub-agent to handle a specific task independently.
The sub-agent has access to the same tools (Bash, Read, Write, Edit, Glob, Grep, etc.) and runs autonomously.
Use this for:
- Tasks that require multiple steps but are self-contained
- Parallel investigation of different aspects of a problem
- Operations that benefit from a fresh, focused context
The sub-agent cannot see the parent conversation — provide all necessary context in the prompt.`,

  inputSchema,
  isConcurrencySafe: true,  // Sub-agents are isolated (own messages, own abort) — safe to run in parallel
  isReadOnly: false,

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    // -- 1. Validate prerequisites --

    // The agentLoop populates these fields on ToolContext; if missing, we can't run.
    if (!context.provider || !context.tools || !context.systemPrompt || !context.model) {
      return {
        output: 'Error: Sub-agent cannot be created — missing provider/tools/systemPrompt/model in context. '
          + 'This is an internal error; the Agent tool requires these fields to be populated by agentLoop.',
        isError: true,
      }
    }

    // -- 2. Depth check (cf. Claude Code queryTracking.depth) --
    const currentDepth = context.agentDepth ?? 0
    if (currentDepth >= MAX_AGENT_DEPTH) {
      return {
        output: `Error: Maximum sub-agent nesting depth (${MAX_AGENT_DEPTH}) reached. `
          + `Current depth: ${currentDepth}. Cannot create further sub-agents.`,
        isError: true,
      }
    }

    // -- 3. Resolve model --
    const model = resolveModel(input.model, context.model)

    // -- 4. Build sub-agent's own conversation (isolated, fresh start) --
    //
    // Design: child starts with an empty conversation — only the system prompt
    // and the delegated task. This is intentional:
    // - Prevents context pollution between parent and child
    // - Keeps the child's context window focused on its specific task
    // - Matches Claude Code's subagent design where the child gets a prompt, not history
    const childMessages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: input.prompt }],
      },
    ]

    // -- 5. Build sub-agent system prompt --
    const childSystemPrompt = buildSubagentSystemPrompt(context.systemPrompt)

    // -- 6. Create linked abort controller --
    const childAbortController = createLinkedAbortController(context.abortSignal)

    // -- 7. Build child ToolContext (depth incremented, new abort signal) --
    const childToolContext: ToolContext = {
      cwd: context.cwd,
      abortSignal: childAbortController.signal,
      provider: context.provider,
      tools: context.tools,
      systemPrompt: childSystemPrompt,
      model,
      permissionCheck: context.permissionCheck,
      agentDepth: currentDepth + 1,
    }

    // -- 8. Run sub-agent loop --
    const textParts: string[] = []
    let childTotalUsage: TokenUsage = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    let turnCount = 0
    let errorOccurred = false
    let errorMessage = ''

    try {
      const stream = agentLoop({
        provider: context.provider,
        tools: context.tools,
        systemPrompt: childSystemPrompt,
        messages: childMessages,
        model,
        maxTurns: DEFAULT_MAX_TURNS,
        abortSignal: childAbortController.signal,
        toolContext: childToolContext,
        permissionCheck: context.permissionCheck,
      })

      for await (const event of stream) {
        switch (event.type) {
          case 'text_delta':
            // Collect text output — this is the sub-agent's visible response
            textParts.push(event.text)
            break

          case 'turn_complete':
            turnCount++
            break

          case 'message_complete':
            // Accumulate total usage from the child
            childTotalUsage = event.totalUsage
            break

          // Deliberately ignore: thinking_delta, tool_start, tool_result
          // These are internal to the sub-agent's execution. The parent only
          // sees the final text output (design: clean result boundary).
        }
      }
    } catch (err) {
      errorOccurred = true
      if (err instanceof Error && err.name === 'AbortError') {
        errorMessage = 'Sub-agent was aborted (parent interrupted).'
      } else {
        errorMessage = err instanceof Error ? err.message : String(err)
      }
    }

    // -- 9. Build result --
    const resultText = textParts.join('')

    if (errorOccurred && !resultText) {
      return {
        output: `Sub-agent "${input.description}" failed: ${errorMessage}`,
        isError: true,
      }
    }

    // Truncate if needed (same as Claude Code maxResultSizeChars)
    const truncatedText = resultText.length > MAX_RESULT_CHARS
      ? resultText.slice(0, MAX_RESULT_CHARS) + '\n\n[Output truncated — exceeded ' + MAX_RESULT_CHARS.toLocaleString() + ' characters]'
      : resultText

    // Build summary with usage stats
    const summary = [
      truncatedText,
      '',
      `--- Sub-agent "${input.description}" completed ---`,
      `Turns: ${turnCount} | Model: ${model} | Depth: ${currentDepth + 1}/${MAX_AGENT_DEPTH}`,
      `Tokens: ${formatUsage(childTotalUsage)}`,
    ]

    if (errorOccurred) {
      summary.push(`Warning: Sub-agent encountered an error but produced partial output: ${errorMessage}`)
    }

    return {
      output: summary.join('\n'),
      isError: false,
    }
  },
}
