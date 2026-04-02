/**
 * Game NPC — Tavern keeper "Bob" who converses with an adventurer.
 *
 * Demonstrates: custom tools, interactive readline loop, system prompt persona.
 * Run: npx tsx examples/game-npc.ts
 */

import { Agent } from '../src/engine.js'
import { z } from 'zod'
import type { Tool } from '../src/tools/types.js'
import * as readline from 'node:readline'

// -- Tools --

const SpeakTool: Tool = {
  name: 'Speak',
  description: 'Say something to the player with an emotion',
  inputSchema: z.object({
    text: z.string().describe('What to say'),
    emotion: z.enum(['happy', 'angry', 'sad', 'neutral', 'mysterious']),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input) {
    const tag = (input as { emotion: string }).emotion.toUpperCase()
    const text = (input as { text: string }).text
    console.log(`\n  [${tag}] Bob: "${text}"\n`)
    return { output: `Said: "${text}" with ${tag}` }
  },
}

const MoveTool: Tool = {
  name: 'Move',
  description: 'Move to a location in the tavern',
  inputSchema: z.object({
    location: z.enum(['bar', 'kitchen', 'cellar', 'entrance']).describe('Where to go'),
  }),
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input) {
    const loc = (input as { location: string }).location
    console.log(`  * Bob walks to the ${loc} *`)
    return { output: `Moved to ${loc}` }
  },
}

const CheckInventoryTool: Tool = {
  name: 'CheckInventory',
  description: 'Check what items are available in the tavern',
  inputSchema: z.object({}),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute() {
    const items = ['Ale (2 gold)', 'Bread & Stew (3 gold)', 'Healing Potion (10 gold)', 'Room for the night (5 gold)']
    return { output: `Available: ${items.join(', ')}` }
  },
}

const GiveItemTool: Tool = {
  name: 'GiveItem',
  description: 'Give an item to the player',
  inputSchema: z.object({
    item: z.string().describe('The item to give'),
  }),
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input) {
    const item = (input as { item: string }).item
    console.log(`  * Bob hands you: ${item} *`)
    return { output: `Gave "${item}" to the player` }
  },
}

// -- Main --

async function main() {
  const agent = new Agent({
    tools: [SpeakTool, MoveTool, CheckInventoryTool, GiveItemTool],
    systemPrompt: [
      'You are Bob, a friendly tavern keeper in a fantasy RPG.',
      'You speak in a hearty, medieval style. You always use the Speak tool to talk.',
      'You can move around the tavern, check your inventory, and give items to the player.',
      'Keep responses short and in-character. Never break character.',
    ].join(' '),
    maxTurns: 5,
  })

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve))

  console.log('=== The Rusty Flagon Tavern ===')
  console.log('You push open the heavy oak door and step inside...\n')

  // Initial greeting
  for await (const event of agent.run('A weary adventurer just walked into your tavern. Greet them.')) {
    // Events are consumed; tool outputs print to console via execute()
  }

  // Interactive loop
  while (true) {
    const input = await ask('You > ')
    if (!input || input.toLowerCase() === 'quit') {
      console.log('\nYou leave the tavern. Safe travels!')
      break
    }
    for await (const event of agent.run(input)) {
      // Consume events
    }
  }

  rl.close()
}

main().catch(console.error)
