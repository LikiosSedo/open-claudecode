/**
 * /doctor — System Diagnostics
 *
 * Comprehensive health check for open-claude-code:
 * API keys, runtime deps, config files, provider/model.
 */

import chalk from 'chalk'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface DiagResult {
  name: string
  status: 'ok' | 'warn' | 'error'
  message: string
}

export async function runDiagnostics(options: {
  cwd: string
  provider: string
  model: string
}): Promise<DiagResult[]> {
  const results: DiagResult[] = []

  // 1. API Key
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY
  if (anthropicKey) {
    results.push({
      name: 'Anthropic API Key',
      status: 'ok',
      message: `Set (...${anthropicKey.slice(-4)})`,
    })
  } else if (openaiKey) {
    results.push({
      name: 'OpenAI API Key',
      status: 'ok',
      message: `Set (...${openaiKey.slice(-4)})`,
    })
  } else {
    results.push({
      name: 'API Key',
      status: 'error',
      message: 'No ANTHROPIC_API_KEY or OPENAI_API_KEY set',
    })
  }

  // 2. Node.js version
  const nodeVersion = process.version
  const major = parseInt(nodeVersion.slice(1))
  results.push({
    name: 'Node.js',
    status: major >= 20 ? 'ok' : 'error',
    message: `${nodeVersion}${major < 20 ? ' (requires >=20)' : ''}`,
  })

  // 3. Git
  try {
    const gitVersion = execSync('git --version', { encoding: 'utf-8', timeout: 5000 }).trim()
    results.push({ name: 'Git', status: 'ok', message: gitVersion })
  } catch {
    results.push({ name: 'Git', status: 'warn', message: 'Not found' })
  }

  // 4. ripgrep (Grep tool dependency)
  try {
    const rgVersion = execSync('rg --version', { encoding: 'utf-8', timeout: 5000 }).split('\n')[0]!.trim()
    results.push({ name: 'ripgrep', status: 'ok', message: rgVersion })
  } catch {
    results.push({ name: 'ripgrep', status: 'warn', message: 'Not found (Grep tool will fall back to grep)' })
  }

  // 5. MCP config
  const mcpPath = process.env.OCC_MCP_CONFIG ?? join(homedir(), '.occ', 'mcp.json')
  if (existsSync(mcpPath)) {
    try {
      const config = JSON.parse(readFileSync(mcpPath, 'utf-8'))
      const servers = config.servers
      if (Array.isArray(servers)) {
        results.push({ name: 'MCP Config', status: 'ok', message: `${servers.length} server(s) at ${mcpPath}` })
      } else {
        results.push({ name: 'MCP Config', status: 'error', message: `"servers" is not an array in ${mcpPath}` })
      }
    } catch {
      results.push({ name: 'MCP Config', status: 'error', message: `Invalid JSON at ${mcpPath}` })
    }
  } else {
    results.push({ name: 'MCP Config', status: 'ok', message: 'Not configured (optional)' })
  }

  // 6. Permissions
  const permPath = join(homedir(), '.occ', 'permissions.json')
  if (existsSync(permPath)) {
    try {
      const perms = JSON.parse(readFileSync(permPath, 'utf-8'))
      const count = Array.isArray(perms.rules) ? perms.rules.length : 0
      results.push({ name: 'Permissions', status: 'ok', message: `${count} saved rule(s)` })
    } catch {
      results.push({ name: 'Permissions', status: 'error', message: `Invalid JSON at ${permPath}` })
    }
  } else {
    results.push({ name: 'Permissions', status: 'ok', message: 'No saved rules' })
  }

  // 7. Memory directory
  const memPath = join(homedir(), '.occ', 'projects')
  results.push({
    name: 'Memory',
    status: 'ok',
    message: existsSync(memPath) ? memPath : 'Not yet created (created on first save)',
  })

  // 8. CLAUDE.md files
  const claudeMdPaths = [
    join(options.cwd, 'CLAUDE.md'),
    join(homedir(), '.claude', 'CLAUDE.md'),
    join(homedir(), 'CLAUDE.md'),
  ]
  const found = claudeMdPaths.filter(p => existsSync(p))
  results.push({
    name: 'CLAUDE.md',
    status: 'ok',
    message: found.length > 0 ? found.join(', ') : 'None found (optional)',
  })

  // 9. Provider + model
  results.push({ name: 'Provider', status: 'ok', message: options.provider })
  results.push({ name: 'Model', status: 'ok', message: options.model })

  // 10. Working directory
  results.push({
    name: 'Working Dir',
    status: existsSync(options.cwd) ? 'ok' : 'error',
    message: options.cwd,
  })

  return results
}

export function formatDiagnostics(results: DiagResult[]): string {
  const icons = { ok: chalk.green('\u2713'), warn: chalk.yellow('\u26a0'), error: chalk.red('\u2717') }
  return results.map(r =>
    `  ${icons[r.status]} ${chalk.bold(r.name)}: ${r.message}`,
  ).join('\n')
}
