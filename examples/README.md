# Examples

Three self-contained examples demonstrating the Agent engine with custom tools.

## Game NPC — Tavern Keeper

Interactive RPG tavern keeper with Speak, Move, CheckInventory, and GiveItem tools.
Features a readline loop for back-and-forth conversation.

```bash
npx tsx examples/game-npc.ts
```

## SRE Diagnostic Agent

Investigates a crashing Kubernetes pod using mock Kubectl, QueryMetrics, and SearchLogs tools.
Demonstrates permission hooks and single-shot diagnostic prompt.

```bash
npx tsx examples/sre-agent.ts
```

## Data Analyst

Analyzes mock sales data using QuerySQL, ReadCSV, and CreateChart tools.
Finds top products by revenue with monthly trends and regional breakdown.

```bash
npx tsx examples/data-analyst.ts
```

## Notes

- All tools use mock data — no real infrastructure or databases required.
- Each example needs a valid API key for the LLM provider (defaults to Anthropic Claude).
  Set `ANTHROPIC_API_KEY` in your environment before running.
- Adjust `maxTurns` in each example to control how many agent loop iterations are allowed.
