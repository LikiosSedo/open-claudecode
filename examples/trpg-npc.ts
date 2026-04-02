/**
 * TRPG NPC — 用 Agent SDK 做一个跑团风格的酒馆 NPC
 * 
 * 运行: npx tsx examples/trpg-npc.ts
 */

import { Agent } from '../src/engine.js'
import { z } from 'zod'
import type { Tool } from '../src/tools/types.js'
import * as readline from 'node:readline'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const config = JSON.parse(readFileSync(join(homedir(), '.occ', 'config.json'), 'utf-8'))

// --- 游戏世界状态 ---
const world = {
  location: '破晓酒馆',
  time: '黄昏',
  weather: '暴雨',
  npcMood: 'neutral' as string,
  playerGold: 50,
  playerItems: ['生锈的短剑', '旅行者斗篷', '半块干面包'],
  npcInventory: ['麦酒', '烈酒', '炖肉', '面包', '神秘地图', '治愈药水'],
  knownSecrets: [] as string[],
  trustLevel: 0, // -5 到 +5
}

// --- 工具定义 ---

const SpeakTool: Tool = {
  name: 'Speak',
  description: '以 NPC 身份说话。必须用这个工具来和玩家对话。',
  inputSchema: z.object({
    text: z.string().describe('要说的话（第一人称，NPC 视角）'),
    emotion: z.enum(['neutral', 'happy', 'angry', 'scared', 'mysterious', 'drunk', 'whispering']),
    action: z.string().optional().describe('伴随的动作描述，如"擦着酒杯"、"压低声音"'),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input: any) {
    world.npcMood = input.emotion
    const emotionMap: Record<string, string> = {
      neutral: '😐', happy: '😊', angry: '😠', scared: '😰',
      mysterious: '🤫', drunk: '🍺', whispering: '👂',
    }
    const emoji = emotionMap[input.emotion] || '😐'
    const action = input.action ? `\n  *${input.action}*` : ''
    console.log(`\n${emoji} 老板格雷格: "${input.text}"${action}\n`)
    return { output: `Said: "${input.text}" [${input.emotion}]` }
  },
}

const CheckWorldTool: Tool = {
  name: 'CheckWorld',
  description: '查看当前世界状态：地点、时间、天气、玩家物品、信任度等',
  inputSchema: z.object({}),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute() {
    return {
      output: JSON.stringify({
        location: world.location,
        time: world.time,
        weather: world.weather,
        npcMood: world.npcMood,
        playerGold: world.playerGold,
        playerItems: world.playerItems,
        trustLevel: world.trustLevel,
        knownSecrets: world.knownSecrets,
      }, null, 2)
    }
  },
}

const SellItemTool: Tool = {
  name: 'SellItem',
  description: '卖东西给玩家。从 NPC 库存中取出物品，扣除玩家金币。',
  inputSchema: z.object({
    item: z.string().describe('物品名称'),
    price: z.number().describe('价格（金币）'),
  }),
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input: any) {
    if (!world.npcInventory.includes(input.item)) {
      return { output: `失败：没有 "${input.item}"`, isError: true }
    }
    if (world.playerGold < input.price) {
      return { output: `失败：玩家金币不足（有 ${world.playerGold}，需要 ${input.price}）`, isError: true }
    }
    world.npcInventory.splice(world.npcInventory.indexOf(input.item), 1)
    world.playerItems.push(input.item)
    world.playerGold -= input.price
    return { output: `交易成功：${input.item} → 玩家（-${input.price}金币，剩余${world.playerGold}）` }
  },
}

const RevealSecretTool: Tool = {
  name: 'RevealSecret',
  description: '向玩家透露一个秘密。只有信任度 >= 2 时才能使用。',
  inputSchema: z.object({
    secret: z.string().describe('秘密内容'),
    trustRequired: z.number().describe('需要的信任度'),
  }),
  isConcurrencySafe: false,
  isReadOnly: false,
  validateInput: async (input: any) => {
    if (world.trustLevel < input.trustRequired) {
      return { valid: false, error: `信任度不足（当前${world.trustLevel}，需要${input.trustRequired}）` }
    }
    return { valid: true }
  },
  async execute(input: any) {
    world.knownSecrets.push(input.secret)
    console.log(`\n🗝️  [秘密解锁] ${input.secret}\n`)
    return { output: `秘密已透露：${input.secret}` }
  },
}

const AdjustTrustTool: Tool = {
  name: 'AdjustTrust',
  description: '根据玩家行为调整信任度（-2到+2）。礼貌/帮助 +1，粗鲁/威胁 -1。',
  inputSchema: z.object({
    delta: z.number().describe('信任度变化量（-2到+2）'),
    reason: z.string().describe('原因'),
  }),
  isConcurrencySafe: false,
  isReadOnly: false,
  async execute(input: any) {
    const clamped = Math.max(-2, Math.min(2, input.delta))
    world.trustLevel = Math.max(-5, Math.min(5, world.trustLevel + clamped))
    const arrow = clamped > 0 ? '↑' : clamped < 0 ? '↓' : '→'
    console.log(`  [信任度 ${arrow} ${world.trustLevel}] ${input.reason}`)
    return { output: `信任度: ${world.trustLevel} (${clamped > 0 ? '+' : ''}${clamped}: ${input.reason})` }
  },
}

const RollDiceTool: Tool = {
  name: 'RollDice',
  description: '掷骰子决定结果。用于不确定的事件（如说服、察觉、战斗）。',
  inputSchema: z.object({
    dice: z.string().describe('骰子类型，如 "1d20", "2d6"'),
    dc: z.number().describe('难度等级（Difficulty Class）'),
    skill: z.string().describe('检定类型，如 "说服", "察觉", "力量"'),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input: any) {
    const match = input.dice.match(/(\d+)d(\d+)/)
    if (!match) return { output: '无效骰子格式', isError: true }
    const [, count, sides] = match.map(Number)
    let total = 0
    const rolls: number[] = []
    for (let i = 0; i < count; i++) {
      const roll = Math.floor(Math.random() * sides) + 1
      rolls.push(roll)
      total += roll
    }
    const success = total >= input.dc
    const emoji = total === count * sides ? '💥暴击！' : total === count ? '💀大失败！' : success ? '✅成功' : '❌失败'
    console.log(`\n🎲 [${input.skill}检定] ${input.dice} → ${rolls.join('+')} = ${total} vs DC${input.dc} ${emoji}\n`)
    return { output: `${input.skill}检定: ${rolls.join('+')}=${total} vs DC${input.dc} → ${success ? '成功' : '失败'}${total === count * sides ? '(暴击)' : total === count ? '(大失败)' : ''}` }
  },
}

// --- NPC Agent ---

const npc = new Agent({
  provider: {
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    type: 'openai',
  },
  tools: [SpeakTool, CheckWorldTool, SellItemTool, RevealSecretTool, AdjustTrustTool, RollDiceTool],
  systemPrompt: `你是"破晓酒馆"的老板格雷格（Greg），一个粗犷但有故事的中年人。

## 你的性格
- 表面粗犷直爽，实际心思细腻
- 对常客友善，对陌生人警惕
- 喝多了会吹嘘当年冒险的故事（大部分是真的）
- 知道很多镇上的秘密，但只告诉信得过的人

## 你知道的秘密（按信任度解锁）
- 信任度 1: 镇长最近行为古怪，半夜常出门
- 信任度 2: 地下室有一条通往矿洞的密道
- 信任度 3: 你年轻时是"银月佣兵团"的成员，知道上古遗迹的位置
- 信任度 4: 镇长和暗影教派有联系，正在策划什么

## 行为规则
1. 每次回复必须用 Speak 工具说话（不要直接输出文本）
2. 根据玩家态度用 AdjustTrust 调整信任度
3. 卖东西时像真正的商人一样讨价还价
4. 不确定的事件用 RollDice 掷骰子
5. 先 CheckWorld 了解当前状态再回应
6. 保持角色扮演，不要跳出角色
7. 回复要有沉浸感，描述环境和动作

## 价目表
- 麦酒: 3金币
- 烈酒: 8金币
- 炖肉: 5金币  
- 面包: 2金币
- 神秘地图: 25金币（需要信任度>=2）
- 治愈药水: 15金币

当前场景：暴雨之夜，酒馆里只有你和一个刚推门进来的陌生冒险者。`,
  maxTurns: 10,
})

// --- 交互循环 ---

console.log('═'.repeat(60))
console.log('  🏰 破晓酒馆 — TRPG NPC 互动演示')
console.log('  使用 open-claude-cli Agent SDK + Kimi-K2.5')
console.log('═'.repeat(60))
console.log()
console.log(`📍 ${world.location} | 🕐 ${world.time} | 🌧️ ${world.weather}`)
console.log(`💰 ${world.playerGold} 金币 | 🎒 ${world.playerItems.join(', ')}`)
console.log()
console.log('暴风雨在窗外肆虐。你推开沉重的木门，走进一间昏暗的酒馆。')
console.log('柜台后面，一个壮实的中年男人正在擦拭酒杯。他抬头看了你一眼。')
console.log()
console.log('（输入你的行动，/quit 退出，/status 查看状态）')
console.log()

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

// 第一次 NPC 主动打招呼
let firstTurn = true

function prompt() {
  rl.question('🗡️  冒险者> ', async (input) => {
    if (input.trim() === '/quit') {
      console.log('\n你推开门，消失在暴风雨中...\n')
      rl.close()
      return
    }
    if (input.trim() === '/status') {
      console.log(`\n📊 状态: 💰${world.playerGold}金 | 信任度:${world.trustLevel} | 🎒${world.playerItems.join(', ')}`)
      if (world.knownSecrets.length > 0) console.log(`🗝️  已知秘密: ${world.knownSecrets.join('; ')}`)
      console.log()
      prompt()
      return
    }

    const message = firstTurn
      ? `一个陌生的冒险者推门走进酒馆。${input.trim() ? `冒险者: "${input}"` : '他浑身湿透，看起来又冷又饿。'}`
      : `冒险者: "${input}"`
    firstTurn = false

    try {
      for await (const event of npc.run(message)) {
        // Events are handled by tool execute (console.log inside tools)
        if (event.type === 'text_delta') {
          // NPC shouldn't output raw text (should use Speak tool), but just in case
          process.stdout.write(event.text)
        }
      }
    } catch (err) {
      console.log(`\n[系统错误: ${(err as Error).message}]\n`)
    }

    prompt()
  })
}

prompt()
