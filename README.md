# open-claude-code

> The essence of Claude Code in ~4000 lines of TypeScript.

The Claude Code source leaked on 2025-03-31 — 512K lines of production code. This project distills the **8 core architectural innovations** into a hackable, readable, multi-provider CLI agent.

Read the code in an afternoon. Extend it in an evening.

## Why This Exists

- **512K lines is too much to read.** The leaked Claude Code source is a production monolith — MDM, OAuth, telemetry, Ink UI, bundled plugins. The actual agent architecture is buried.
- **Existing frameworks miss what makes Claude Code special.** LangChain, CrewAI, and friends don't implement streaming tool execution, concurrent-safe scheduling, or layered prompt caching.
- **This project extracts the innovations.** ~4000 lines. Every file fits on a screen. No framework magic, no abstractions-for-abstractions'-sake.

## Key Innovations (from Claude Code)

### 1. Streaming Tool Execution
The model is still generating tokens, but tools are already running. When the LLM emits a `tool_use_stop` event, the executor fires immediately — no waiting for the full response.

### 2. Concurrent-Safe Scheduling
Each tool declares `isConcurrencySafe`. Read-only tools (Read, Glob, Grep) run in parallel. Mutating tools (Bash, Write, Edit) run serially. Bash errors cancel sibling tools; other tool failures are independent.

### 3. Layered System Prompt
Static instructions go in the first block with `cache_control: ephemeral`. Dynamic context (cwd, git status, CLAUDE.md, memory) goes in subsequent blocks. The expensive static block gets cached by the API.

### 4. Context Compaction
Token-budget-aware progressive compression: truncation → LLM summarization → circuit breaker (3 failures). Recent messages stay verbatim; older ones get compacted.

### 5. Multi-Provider Architecture
One `Provider` interface. Anthropic (raw streaming + prompt caching), OpenAI, and anything OpenAI-compatible (Ollama, Together, Groq, LM Studio, vLLM).

### 6. Permission System
Three modes: `auto` (smart per-tool analysis), `ask` (confirm all writes), `bypass`. Bash commands go through safe/dangerous command lists + pattern matching. MCP tools default to `ask`.

### 7. Sub-Agents
LLM can spawn child agents to handle sub-tasks. Isolated context (fresh conversation), linked abort (parent cancel → child cancel), depth limit (max 3), shared provider and permission policy.

### 8. Deferred Tool Loading
Core tools are sent immediately. MCP and workflow tools are deferred — discoverable via `ToolSearch`. Saves ~40% prompt tokens when many tools are registered.

## Quick Start

```bash
npm install -g open-claudecode
occ
```

Or install from source:

```bash
git clone https://github.com/LikiosSedo/open-claudecode.git
cd open-claude-code
npm install

# Run
npm start
```

Set your API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...
```

### Optional Configuration

```bash
# Override the model
export OCC_MODEL=claude-opus-4-20250514

# Use Ollama / LM Studio / any OpenAI-compatible endpoint
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_API_KEY=ollama
export OCC_MODEL=llama3

# Permission modes
occ --bypass-permissions   # auto-approve everything
occ --ask-permissions      # confirm every write operation
```

### Configuration File

Create `~/.occ/config.json` for persistent settings:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "permissions": "auto",
  "anthropicApiKey": "sk-ant-...",
  "openaiApiKey": "sk-...",
  "openaiBaseUrl": "http://localhost:11434/v1"
}
```

Environment variables override config file values. All fields are optional.

### MCP Server Configuration

Create `~/.occ/mcp.json` (or set `OCC_MCP_CONFIG` env var):

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    }
  ]
}
```

MCP tools are automatically deferred and discoverable via ToolSearch.

### REPL Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/model <name>` | Switch model mid-session |
| `/cost` | Show cumulative token usage |
| `/clear` | Clear conversation history |
| `/memory` | List saved memories |
| `/mcp` | Show MCP servers and tools |
| `/permissions [mode]` | Show or switch permission mode |
| `/exit` | Quit |
| `Ctrl+C` | Interrupt current request (won't exit) |

## Use as SDK

open-claude-cli is also a general-purpose agent engine. Import the `Agent` class to build any kind of agent:

```typescript
import { Agent } from 'open-claude-cli/engine'

const agent = new Agent({
  provider: { model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY },
  tools: [MyCustomTool],
  systemPrompt: 'You are a helpful assistant.',
})

for await (const event of agent.run('Hello!')) {
  if (event.type === 'text_delta') process.stdout.write(event.text)
}
```

Or use the `query()` one-liner:

```typescript
import { query } from 'open-claude-cli/engine'

for await (const event of query({
  prompt: 'What files are here?',
  tools: 'coding',  // preset: Bash, Read, Write, Edit, Glob, Grep
})) {
  if (event.type === 'text_delta') process.stdout.write(event.text)
}
```

## Build Any Agent

The engine is model- and domain-agnostic. Here are three examples:

**Game NPC** — dialogue agent with inventory awareness:

```typescript
const npc = new Agent({
  provider: { model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY },
  tools: [InventoryTool, DialogueTool, QuestLogTool],
  systemPrompt: 'You are Elara, a merchant in the village square.',
})
for await (const ev of npc.run('What potions do you have?')) { /* ... */ }
```

**SRE Bot** — incident responder with runbook tools:

```typescript
const sre = new Agent({
  provider: { model: 'claude-sonnet-4-20250514' },
  tools: [KubectlTool, GrafanaTool, PagerDutyTool],
  systemPrompt: 'You are an SRE on-call bot. Diagnose and mitigate incidents.',
})
for await (const ev of sre.run('Pod crash-looping in prod-us-east')) { /* ... */ }
```

**Data Analyst** — SQL + charting agent:

```typescript
const analyst = new Agent({
  provider: { model: 'llama3', baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama' },
  tools: [SQLQueryTool, ChartTool, ExportCSVTool],
  systemPrompt: 'You are a data analyst. Query the warehouse and visualize results.',
})
for await (const ev of analyst.run('Monthly revenue trend for Q1')) { /* ... */ }
```

See [`examples/`](./examples/) for full runnable code.

## vs Claude Agent SDK

| | Claude Agent SDK | open-claude-cli |
|---|---|---|
| Models | Claude only | Any (OpenAI, Ollama, Groq, LM Studio, etc.) |
| Custom tools | Limited (Claude-defined) | Full (bring your own `Tool` interface) |
| MCP support | Yes | Yes (stdio transport) |
| Streaming | Yes | Yes (per-tool streaming + concurrent execution) |
| Sub-agents | Yes | Yes (depth-limited fork) |
| Permission system | N/A | auto / ask / bypass + hooks |
| Session persistence | Managed by Anthropic | Local (self-hosted) |
| Context compaction | N/A | Built-in (truncate + LLM summary) |
| License | Commercial | MIT |
| Runs locally | No (API-only) | Yes |

## Architecture

```
  Your App                     open-claude-cli
  (game/SRE/data)             (coding agent)
        \                          /
         +------ Agent Engine ----+
         | agentLoop + StreamingToolExecutor |
         | Providers (Anthropic/OpenAI/any)  |
         | Permissions · Hooks · Memory      |
         | Context · Session · MCP           |
         +----------------------------------+
```

### Internal Architecture

```
                    +-----------+
                    |   REPL    |  src/index.ts
                    | (readline)|
                    +-----+-----+
                          |
    +-----------+   +-----+------+   +--------------+
    | Provider  |<--+ AgentLoop  +-->| ToolRegistry |
    |(streaming)|   | (turns +   |   | (active +    |
    +-----+-----+  | streaming  |   |  deferred)   |
          |         |  executor) |   +------+-------+
          v         +-----+------+          |
    +-----------+         |           +-----+------+
    | Anthropic |   +-----+------+    | Bash |Read |
    | OpenAI    |   | Permissions|    | Write|Edit |
    | Ollama    |   | (auto/ask/ |    | Glob |Grep |
    |  ...      |   |  bypass)   |    | Agent|Mem  |
    +-----------+   +------------+    | MCP  |Srch |
                                      +------+-----+
```

## Project Structure

```
src/
  index.ts              CLI entry + REPL (404 lines)
  agent.ts              Agent loop + StreamingToolExecutor (536 lines)
  prompt.ts             Layered system prompt builder (156 lines)
  context.ts            Context compaction (199 lines)
  permissions.ts        Permission system (246 lines)
  memory.ts             Cross-session memory (365 lines)
  mcp.ts                MCP server integration (270 lines)
  providers/
    types.ts            Provider interface, StreamEvent, Message types
    anthropic.ts        Anthropic (raw stream, prompt caching)
    openai.ts           OpenAI-compatible (per-tool streaming)
  tools/
    types.ts            Tool interface, ToolRegistry, deferred loading
    bash.ts             Shell execution with timeout + abort
    read.ts             File reading (binary detection, offset/limit)
    write.ts            File creation (overwrite detection, auto-mkdir)
    edit.ts             String replacement (uniqueness check, diff output)
    glob.ts             File pattern matching (sorted by mtime)
    grep.ts             Content search (ripgrep with grep fallback)
    agent.ts            Sub-agent spawning (depth-limited, isolated)
    memory-tool.ts      Save/list/delete memories
    tool-search.ts      Deferred tool discovery (keyword scoring)
```

## Extending

### Add a Custom Tool

```typescript
import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from './types.js'

export const MyTool: Tool<{ query: string }> = {
  name: 'MyTool',
  description: 'What this tool does (the LLM reads this).',
  inputSchema: z.object({ query: z.string() }),
  isConcurrencySafe: true,
  isReadOnly: true,
  // shouldDefer: true,  // uncomment to make it discoverable via ToolSearch
  async execute(input, context): Promise<ToolResult> {
    return { output: `Result for: ${input.query}` }
  },
}
```

### Add an MCP Server

Just add it to `~/.occ/mcp.json`. Tools are automatically wrapped, deferred, and discoverable.

### Modify the System Prompt

Edit `src/prompt.ts`. Block 0 = static (cached). Block 1 = dynamic (git, memory, CLAUDE.md).

## Comparison with Claude Code

| Feature | Claude Code (512K LOC) | open-claude-code (~4K LOC) |
|---------|----------------------|---------------------------|
| Streaming tool execution | Yes | Yes |
| Concurrent-safe scheduling | Yes | Yes |
| Layered prompt caching | Yes | Yes |
| Context compaction | 4-layer cascade | 2-layer (truncate + LLM summary) |
| Multi-provider | Anthropic + Bedrock + Vertex | Anthropic + OpenAI + any compatible |
| Tools | 40+ | 10 (Bash, Read, Write, Edit, Glob, Grep, Agent, Memory, ToolSearch, MCP) |
| Permission system | Rules + Hooks + Classifier | auto/ask/bypass + bash analysis |
| MCP support | Full (stdio + SSE) | stdio transport |
| Sub-agents | Full (teams, worktrees) | Single-level fork (depth-limited) |
| Deferred tool loading | Yes | Yes |
| Memory system | 4-type taxonomy + LLM relevance | 4-type taxonomy + MEMORY.md index |
| CLAUDE.md | Full discovery | Project + home directory |
| UI | Ink (React terminal) | readline |
| Lines of code | ~512,000 | ~4,000 |
| Time to read | Weeks | Afternoon |

## License

MIT

## Credits

Architecture distilled from Anthropic's Claude Code production codebase.
