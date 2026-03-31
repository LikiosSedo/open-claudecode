# open-claude-code

> The essence of Claude Code in ~3000 lines of TypeScript.

The Claude Code source leaked on 2025-03-31 — 512K lines of production code. This project distills the **5 core architectural innovations** into a hackable, readable, multi-provider CLI agent.

Read the code in an afternoon. Extend it in an evening.

## Why This Exists

- **512K lines is too much to read.** The leaked Claude Code source is a production monolith — MDM, OAuth, telemetry, Ink UI, bundled plugins. The actual agent architecture is buried.
- **Existing frameworks miss what makes Claude Code special.** LangChain, CrewAI, and friends don't implement streaming tool execution, concurrent-safe scheduling, or layered prompt caching.
- **This project extracts the innovations.** ~3000 lines. Every file fits on a screen. No framework magic, no abstractions-for-abstractions'-sake.

## Key Innovations (from Claude Code)

### 1. Streaming Tool Execution
The model is still generating tokens, but tools are already running. When the LLM emits a `tool_use_stop` event, the executor fires immediately — no waiting for the full response to finish.

### 2. Concurrent-Safe Scheduling
Each tool declares `isConcurrencySafe`. Read-only tools (Read, Glob, Grep) run in parallel. Mutating tools (Bash, Write, Edit) run serially. The scheduler enforces this automatically — same design as Claude Code's production executor.

### 3. Layered System Prompt
Static instructions go in the first block with `cache_control: ephemeral`. Dynamic context (cwd, git status) goes in subsequent blocks. Result: the expensive static block gets cached by the API, saving tokens on every turn.

### 4. Context Compaction
When the conversation gets too long, instead of hard-truncating, the context manager asks the LLM to summarize earlier turns. Progressive compression: recent messages stay verbatim, older ones get compacted.

### 5. Multi-Provider Architecture
One `Provider` interface, three implementations. Anthropic, OpenAI, and anything OpenAI-compatible (Ollama, Together, Groq, LM Studio, vLLM). The agent loop doesn't know or care which LLM it's talking to.

## Quick Start

```bash
# Install
git clone https://github.com/LikiosSedo/open-claude-code.git
cd open-claude-code
npm install

# Set your API key (pick one)
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...

# Run
npx tsx src/index.ts

# Or use the shortcut
npm start
```

### Optional Configuration

```bash
# Override the model
export OCC_MODEL=claude-opus-4-20250514

# Use a custom endpoint (Ollama, LM Studio, etc.)
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_API_KEY=ollama
export OCC_MODEL=llama3
```

### REPL Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/model <name>` | Switch model mid-session |
| `/cost` | Show cumulative token usage |
| `/clear` | Clear conversation history |
| `/exit` | Quit |
| `Ctrl+C` | Interrupt current request (won't exit) |

## Architecture

```
                     +-----------+
                     |   REPL    |  src/index.ts
                     | (readline)|
                     +-----+-----+
                           |
                           | user message
                           v
  +------------+    +------+------+    +--------------+
  |  Provider  |<---+  AgentLoop  +--->| ToolRegistry |
  | (streaming)|    | (turn mgmt)|    |  (6 tools)   |
  +-----+------+    +------+------+    +------+-------+
        |                  |                  |
        |  StreamEvent     |  AgentEvent      |  ToolResult
        v                  v                  v
  +-----------+    +-------+--------+   +-----+------+
  | Anthropic |    |  StreamingTool |   | Bash |Read |
  | OpenAI    |    |  Executor      |   | Write|Edit |
  | Ollama    |    | (concurrent    |   | Glob |Grep |
  |  ...      |    |  scheduling)   |   +------+-----+
  +-----------+    +----------------+
```

**Data flow:** User input -> AgentLoop -> Provider.stream() -> StreamEvents -> StreamingToolExecutor -> ToolResults -> next turn (if tool_use) or display (if end_turn).

## Project Structure

```
src/
  index.ts              CLI entry point + REPL loop (~200 lines)
  agent.ts              Agent loop: turn management, tool dispatch
  prompt.ts             System prompt builder (layered caching)
  context.ts            Context window management + compaction
  providers/
    types.ts            Provider interface, StreamEvent, Message types
    anthropic.ts        Anthropic API (raw streaming, prompt caching)
    openai.ts           OpenAI-compatible (works with Ollama, etc.)
  tools/
    types.ts            Tool interface, ToolRegistry, permissions
    bash.ts             Shell execution with timeout + abort
    read.ts             File reading with offset/limit
    write.ts            File creation with auto-mkdir
    edit.ts             Surgical string replacement
    glob.ts             File pattern matching (sorted by mtime)
    grep.ts             Content search (ripgrep with grep fallback)
```

## Extending

### Add a Custom Tool

```typescript
// src/tools/my-tool.ts
import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from './types.js'

export const MyTool: Tool<{ query: string }> = {
  name: 'MyTool',
  description: 'What this tool does (the LLM reads this).',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
  }),
  isConcurrencySafe: true,   // true if read-only
  isReadOnly: true,

  async execute(input, context): Promise<ToolResult> {
    return { output: `Result for: ${input.query}` }
  },
}
```

Then register it in `index.ts`:
```typescript
import { MyTool } from './tools/my-tool.js'
registry.register(MyTool)
```

### Add a New Provider

Implement the `Provider` interface from `src/providers/types.ts`:

```typescript
export class MyProvider implements Provider {
  readonly name = 'my-provider'

  async *stream(messages, tools, options): AsyncIterable<StreamEvent> {
    // Emit normalized StreamEvents from your API
  }

  estimateTokens(messages): number {
    return Math.ceil(JSON.stringify(messages).length / 4)
  }
}
```

### Modify the System Prompt

Edit `src/prompt.ts`. The first element of the returned array is cached (static instructions). Append dynamic context as additional elements.

## Comparison with Claude Code

| Feature | Claude Code (512K LOC) | open-claude-code (~3K LOC) |
|---------|----------------------|---------------------------|
| Streaming tool execution | Yes | Yes |
| Concurrent-safe scheduling | Yes | Yes |
| Layered prompt caching | Yes | Yes |
| Context compaction | Yes | Yes |
| Multi-provider | Anthropic + Bedrock + Vertex | Anthropic + OpenAI + any compatible |
| Tools | 20+ (Agent, Notebook, MCP...) | 6 core (Bash, Read, Write, Edit, Glob, Grep) |
| Permission system | Per-tool + policy limits | Per-tool (extensible) |
| MCP support | Full | Not yet (PRs welcome) |
| UI | Ink (React terminal) | readline (simple, hackable) |
| Config | MDM + remote settings + JSON | Environment variables |
| Auth | OAuth + keychain + org SSO | API key |
| Telemetry | GrowthBook + analytics | None |
| Lines of code | ~512,000 | ~3,000 |
| Time to read | Weeks | Afternoon |

## What's NOT Included (by design)

These are deliberately omitted to keep the codebase small and focused:

- **Ink/React UI** — readline is simpler and more hackable
- **MCP protocol** — important but orthogonal to the core architecture
- **Agent swarms / sub-agents** — add complexity, not core insight
- **OAuth / SSO / MDM** — enterprise features
- **Telemetry / analytics** — not needed for an open-source tool
- **Plugin system** — tools are directly registered, no indirection

## Contributing

The goal is to stay under ~3000 lines while covering all core patterns. PRs that add essential patterns from Claude Code are welcome. PRs that add framework abstractions are not.

## License

MIT

## Credits

Inspired by the Claude Code source (2025-03-31). Architecture distilled from Anthropic's production codebase.
