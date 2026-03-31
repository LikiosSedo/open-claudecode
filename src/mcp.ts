/**
 * MCP (Model Context Protocol) Integration
 *
 * Connects to MCP servers via stdio transport, wraps their tools
 * as native Tool objects for the ToolRegistry.
 *
 * Tool naming follows Claude Code convention: mcp__{serverName}__{toolName}
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Tool, ToolContext, ToolResult } from './tools/types.js'

// --- Configuration ---

export interface MCPServerConfig {
  /** Server name (used as tool name prefix: mcp__{name}__{toolName}) */
  name: string
  /** Command to launch the server */
  command: string
  /** Command arguments */
  args?: string[]
  /** Environment variables */
  env?: Record<string, string>
}

interface MCPConfigFile {
  servers: MCPServerConfig[]
}

// --- Connected Server State ---

interface ConnectedServer {
  config: MCPServerConfig
  client: Client
  transport: StdioClientTransport
  tools: MCPToolInfo[]
}

interface MCPToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// --- Name Normalization ---

/**
 * Normalize a name for use in MCP tool naming.
 * Replaces non-alphanumeric characters with underscores.
 * Matches Claude Code's normalization convention.
 */
function normalizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_')
}

/**
 * Build a fully qualified MCP tool name: mcp__{serverName}__{toolName}
 */
function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeName(serverName)}__${normalizeName(toolName)}`
}

// --- MCP Manager ---

export class MCPManager {
  private servers: ConnectedServer[] = []

  /**
   * Connect to all configured MCP servers.
   * Each server connects independently — one failure doesn't block others.
   */
  async connect(configs: MCPServerConfig[]): Promise<void> {
    const results = await Promise.allSettled(
      configs.map(config => this.connectServer(config)),
    )

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'rejected') {
        console.warn(
          `  [mcp] Failed to connect to "${configs[i].name}": ${result.reason}`,
        )
      }
    }
  }

  private async connectServer(config: MCPServerConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...process.env,
        ...config.env,
      } as Record<string, string>,
    })

    const client = new Client({
      name: 'open-claude-code',
      version: '0.1.0',
    })

    await client.connect(transport)

    // Fetch available tools from the server
    const response = await client.listTools()
    const tools: MCPToolInfo[] = (response.tools ?? []).map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
    }))

    this.servers.push({ config, client, transport, tools })
  }

  /**
   * Get all MCP tools wrapped as native Tool objects.
   */
  getTools(): Tool[] {
    const result: Tool[] = []

    for (const server of this.servers) {
      for (const mcpTool of server.tools) {
        result.push(this.wrapTool(server, mcpTool))
      }
    }

    return result
  }

  /**
   * Get summary of connected servers and their tools.
   */
  getStatus(): { name: string; toolCount: number; tools: string[] }[] {
    return this.servers.map(s => ({
      name: s.config.name,
      toolCount: s.tools.length,
      tools: s.tools.map(t => t.name),
    }))
  }

  /**
   * Disconnect all servers.
   */
  async disconnect(): Promise<void> {
    const results = await Promise.allSettled(
      this.servers.map(async s => {
        await s.client.close()
      }),
    )

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'rejected') {
        console.warn(
          `  [mcp] Error disconnecting "${this.servers[i].config.name}": ${result.reason}`,
        )
      }
    }

    this.servers = []
  }

  /**
   * Wrap an MCP tool as a native Tool object.
   *
   * Key design decisions:
   * - Uses z.object({}).passthrough() as the Zod schema (accepts any object)
   * - Stores the real JSON Schema in rawJsonSchema for ToolRegistry.toSchemas()
   * - isConcurrencySafe: true (MCP tools are typically stateless queries)
   * - isReadOnly: true (conservative default)
   */
  private wrapTool(server: ConnectedServer, mcpTool: MCPToolInfo): Tool {
    const qualifiedName = buildMcpToolName(server.config.name, mcpTool.name)
    const client = server.client
    const originalToolName = mcpTool.name

    return {
      name: qualifiedName,
      description: mcpTool.description,
      inputSchema: z.object({}).passthrough(),
      rawJsonSchema: mcpTool.inputSchema,
      isConcurrencySafe: true,
      isReadOnly: true,

      async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
        const result = await client.callTool({
          name: originalToolName,
          arguments: input as Record<string, unknown>,
        })

        // MCP callTool returns { content: Array<{ type, text? }>, isError? }
        const content = result.content as Array<{ type: string; text?: string }> | undefined
        const text = (content ?? [])
          .filter(c => c.type === 'text' && c.text)
          .map(c => c.text)
          .join('\n')

        return {
          output: text || '(no output)',
          isError: result.isError === true,
        }
      },
    }
  }
}

// --- Config Loading ---

/**
 * Load MCP server configurations from:
 * 1. OCC_MCP_CONFIG env var (path to config file)
 * 2. ~/.occ/mcp.json (default location)
 *
 * Returns empty array if no config found (MCP is optional).
 */
export function loadMCPConfig(): MCPServerConfig[] {
  const configPath = process.env.OCC_MCP_CONFIG
    ?? resolve(homedir(), '.occ', 'mcp.json')

  if (!existsSync(configPath)) {
    return []
  }

  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as MCPConfigFile

    if (!parsed.servers || !Array.isArray(parsed.servers)) {
      console.warn(`  [mcp] Invalid config: "servers" must be an array in ${configPath}`)
      return []
    }

    // Validate each server config
    const valid: MCPServerConfig[] = []
    for (const server of parsed.servers) {
      if (!server.name || typeof server.name !== 'string') {
        console.warn('  [mcp] Skipping server with missing "name"')
        continue
      }
      if (!server.command || typeof server.command !== 'string') {
        console.warn(`  [mcp] Skipping server "${server.name}": missing "command"`)
        continue
      }
      valid.push({
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env,
      })
    }

    return valid
  } catch (err) {
    console.warn(`  [mcp] Failed to load config from ${configPath}: ${(err as Error).message}`)
    return []
  }
}
