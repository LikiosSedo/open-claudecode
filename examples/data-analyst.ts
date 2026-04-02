/**
 * Data Analyst Agent — analyzes mock sales data to find top products.
 *
 * Demonstrates: multiple data-source tools, structured analysis, single-shot prompt.
 * Run: npx tsx examples/data-analyst.ts
 */

import { Agent } from '../src/engine.js'
import { z } from 'zod'
import type { Tool } from '../src/tools/types.js'

// -- Mock data --

const SALES_DB: Record<string, string> = {
  'SELECT product, SUM(quantity) as total_qty, SUM(revenue) as total_rev FROM sales GROUP BY product ORDER BY total_rev DESC': [
    'product        | total_qty | total_rev',
    '---------------|-----------|----------',
    'Widget Pro     |     1,245 |  $124,500',
    'Gadget Max     |       832 |   $99,840',
    'Sensor Kit     |       567 |   $85,050',
    'Cable Pack     |     2,100 |   $42,000',
    'Mount Basic    |     1,890 |   $37,800',
    '(5 rows)',
  ].join('\n'),
  'SELECT month, product, SUM(revenue) as rev FROM sales GROUP BY month, product ORDER BY month, rev DESC': [
    'month   | product    | rev',
    '--------|------------|--------',
    'Jan     | Widget Pro | $28,000',
    'Jan     | Gadget Max | $22,100',
    'Feb     | Widget Pro | $31,500',
    'Feb     | Gadget Max | $25,200',
    'Mar     | Widget Pro | $35,000',
    'Mar     | Sensor Kit | $30,750',
    'Mar     | Gadget Max | $27,540',
    '(7 rows)',
  ].join('\n'),
}

const CSV_FILES: Record<string, string> = {
  'data/products.csv': [
    'id,name,category,unit_price',
    '1,Widget Pro,Hardware,$100',
    '2,Gadget Max,Hardware,$120',
    '3,Sensor Kit,Electronics,$150',
    '4,Cable Pack,Accessories,$20',
    '5,Mount Basic,Accessories,$20',
  ].join('\n'),
  'data/regions.csv': [
    'product,region,revenue',
    'Widget Pro,North,$52000',
    'Widget Pro,South,$42500',
    'Widget Pro,West,$30000',
    'Gadget Max,North,$45000',
    'Gadget Max,South,$34840',
    'Gadget Max,West,$20000',
    'Sensor Kit,North,$50050',
    'Sensor Kit,South,$35000',
  ].join('\n'),
}

// -- Tools --

const QuerySQLTool: Tool = {
  name: 'QuerySQL',
  description: 'Execute a read-only SQL query against the sales database. Tables: sales (id, product, quantity, revenue, month, region)',
  inputSchema: z.object({
    query: z.string().describe('SQL SELECT query'),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input) {
    const query = (input as { query: string }).query
    console.log(`  > SQL: ${query}`)
    // Match against known queries by checking key parts
    for (const [key, result] of Object.entries(SALES_DB)) {
      if (query.replace(/\s+/g, ' ').trim().toUpperCase().includes('GROUP BY PRODUCT')
        && query.toUpperCase().includes('ORDER BY') && !query.toUpperCase().includes('MONTH')) {
        return { output: SALES_DB[Object.keys(SALES_DB)[0]] }
      }
      if (query.toUpperCase().includes('MONTH') && query.toUpperCase().includes('GROUP BY')) {
        return { output: SALES_DB[Object.keys(SALES_DB)[1]] }
      }
    }
    return { output: 'Query executed. 0 rows returned.' }
  },
}

const ReadCSVTool: Tool = {
  name: 'ReadCSV',
  description: 'Read a CSV file. Available files: data/products.csv, data/regions.csv',
  inputSchema: z.object({
    path: z.string().describe('Path to CSV file'),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input) {
    const path = (input as { path: string }).path
    const content = CSV_FILES[path]
    if (!content) return { output: `File not found: ${path}`, isError: true }
    console.log(`  > Reading ${path}`)
    return { output: content }
  },
}

const CreateChartTool: Tool = {
  name: 'CreateChart',
  description: 'Create a text-based chart for the analysis report',
  inputSchema: z.object({
    title: z.string().describe('Chart title'),
    type: z.enum(['bar', 'table']).describe('Chart type'),
    data: z.string().describe('Data to visualize (formatted text)'),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input) {
    const { title, data } = input as { title: string; type: string; data: string }
    const chart = `\n📊 ${title}\n${'─'.repeat(40)}\n${data}\n${'─'.repeat(40)}`
    console.log(chart)
    return { output: `Chart "${title}" created and displayed.` }
  },
}

// -- Main --

async function main() {
  console.log('=== Data Analyst Agent ===')
  console.log('Prompt: "Analyze the sales data and find the top 3 products by revenue."\n')

  const agent = new Agent({
    tools: [QuerySQLTool, ReadCSVTool, CreateChartTool],
    systemPrompt: [
      'You are a data analyst agent. You have access to a sales database and CSV files.',
      'When analyzing data: 1) Query the database for aggregate numbers, 2) Cross-reference with CSV files for context,',
      '3) Create charts to visualize findings, 4) Provide a clear summary with actionable insights.',
      'Be precise with numbers. Always cite the data source for each finding.',
    ].join(' '),
    maxTurns: 10,
  })

  for await (const event of agent.run('Analyze the sales data and find the top 3 products by revenue. Include monthly trends and regional breakdown. Provide actionable recommendations.')) {
    if (event.type === 'text_delta') {
      process.stdout.write(event.text)
    }
  }

  console.log('\n\n=== Analysis complete ===')
}

main().catch(console.error)
