import { checkAborted, currentExecution } from "./execution-context";
/**
 * MCPManager — Model-Agnostic Tool Access (MCP + Built-ins)
 *
 * Boots MCP servers at startup, collects tool schemas, and provides
 * tools in both Anthropic and OpenAI formats. This enables MCP tool
 * access with ANY LLM — not just Claude Code.
 *
 * Since Tool-Gateway Phase 2 the format adapters also merge tybo's built-in
 * tools (src/lib/tools/): in-process REST tools (Firecrawl backup,
 * Apify, Telegram document/voice, Cloudflare read-only). On a name
 * collision the MCP tool wins and the built-in acts as backup when the
 * MCP server is down.
 *
 * Config sources are MERGED (Tool-Gateway Phase 1), earlier source wins on
 * name collision:
 * 1. config/mcp-servers.json (tybo-specific, supports type: "http")
 * 2. MCP_CONFIG_PATH env var
 * 3. ~/.claude.json (auto-discovery: stdio only if bun-based,
 *    http entries pass through)
 *
 * ${VAR} placeholders in env/headers/url are resolved via the
 * Credential Registry (.env first, migration fallbacks after).
 *
 * Only bun-based stdio servers are auto-discovered to avoid zombie
 * processes from npx-spawned servers (learned 2026-02-23). Explicitly
 * configured servers in config/mcp-servers.json may use any command.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { optionalCredential } from "./credentials";
import {
  getAvailableBuiltinTools,
  callBuiltinTool,
  getBuiltinTool,
  authorizeTool,
  type BuiltinTool,
} from "./tools";

/** Name, unter dem sich tybo bei einem MCP-Server meldet */
export function mcpClientName(server: string): string {
  return `tybo-${server}`;
}

// ============================================================
// TYPES
// ============================================================

/** Lokaler MCP-Server, wird als Subprozess gestartet. */
interface StdioServerConfig {
  type?: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Remote MCP-Server (Streamable HTTP), kein lokaler Prozess noetig. */
interface HttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

type ServerConfig = StdioServerConfig | HttpServerConfig;

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: MCPToolDef[];
}

interface MCPToolDef {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

// ============================================================
// MCP MANAGER
// ============================================================

class MCPManager {
  private servers: Map<string, ConnectedServer> = new Map();
  private allTools: MCPToolDef[] = [];
  private toolToServer: Map<string, string> = new Map();
  private initialized = false;
  private cleanupRegistered = false;

  /**
   * Initialize — read config, start servers, collect tools.
   * Safe to call multiple times (idempotent).
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const configs = this.loadConfigs();
    if (Object.keys(configs).length === 0) {
      console.log("[MCPManager] No MCP servers configured");
      this.initialized = true;
      this.logBuiltins();
      return;
    }

    console.log(
      `[MCPManager] Starting ${Object.keys(configs).length} MCP servers...`
    );

    // Start all servers concurrently
    const entries = Object.entries(configs);
    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.startServer(name, config))
    );

    // Report results
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.error(
          `[MCPManager] ❌ ${entries[i][0]}: ${(results[i] as PromiseRejectedResult).reason}`
        );
      }
    }

    console.log(
      `[MCPManager] ✅ ${this.servers.size}/${entries.length} servers, ${this.allTools.length} tools available`
    );

    this.initialized = true;
    this.logBuiltins();

    // Register cleanup once
    if (!this.cleanupRegistered) {
      this.cleanupRegistered = true;
      const cleanup = () => this.shutdown();
      process.on("exit", cleanup);
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
    }
  }

  /**
   * Start a single MCP server and collect its tools.
   */
  private async startServer(
    name: string,
    config: ServerConfig
  ): Promise<void> {
    let transport: StdioClientTransport | StreamableHTTPClientTransport;

    if (config.type === "http") {
      // Remote MCP (Streamable HTTP) — kein lokaler Prozess, kein Zombie-Risiko
      const url = this.interpolate(config.url);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(config.headers || {})) {
        headers[k] = this.interpolate(v);
      }
      transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers },
      });
    } else {
      const resolvedEnv = this.resolveEnv(config.env || {});
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, ...resolvedEnv } as Record<string, string>,
      });
    }

    const client = new Client({
      name: mcpClientName(name),
      version: "1.0.0",
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let tools: MCPToolDef[];
    try {
      tools = await Promise.race([
        (async () => {
          await client.connect(transport);
          const result = await client.listTools();
          return result.tools.map(t => ({ serverName: name, name: t.name,
            description: t.description || "", inputSchema: t.inputSchema }));
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("MCP startup timeout")), 10_000); }),
      ]);
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
    } finally { clearTimeout(timer); }

    // Register server and its tools
    this.servers.set(name, { name, client, transport, tools });
    for (const tool of tools) {
      if (this.toolToServer.has(tool.name)) {
        console.warn(`[MCPManager] Duplicate tool rejected: ${tool.name}`);
        continue;
      }
      this.allTools.push(tool);
      this.toolToServer.set(tool.name, name);
    }

    console.log(
      `[MCPManager] ✅ ${name}: ${tools.length} tools (${tools.map((t) => t.name).join(", ")})`
    );
  }

  /**
   * Built-ins, die gerade aktiv sind: verfuegbar (Credentials da) und
   * nicht von einem gleichnamigen MCP-Tool ueberdeckt (MCP gewinnt,
   * Lokale Tools haben Vorrang. Faellt ein MCP-Server aus, springt das Built-in
   * automatisch als Backup ein.
   */
  private activeBuiltins(): BuiltinTool[] {
    return getAvailableBuiltinTools();
  }

  /** Einmalige Boot-Diagnose fuer Built-ins (aktiv vs. ueberdeckt). */
  private logBuiltins(): void {
    const available = getAvailableBuiltinTools();
    const shadowed = available.filter((t) => this.toolToServer.has(t.name));
    const active = available.filter((t) => !this.toolToServer.has(t.name));
    if (shadowed.length > 0) {
      console.log(
        `[MCPManager] Built-ins von MCP ueberdeckt (Backup bei Ausfall): ${shadowed.map((t) => t.name).join(", ")}`
      );
    }
    if (active.length > 0) {
      console.log(
        `[MCPManager] ✅ ${active.length} Built-in-Tools aktiv: ${active.map((t) => t.name).join(", ")}`
      );
    }
  }

  /**
   * Call a tool by name. Routes to the correct MCP server, or to the
   * built-in registry when no server claims the name.
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean }> {
    checkAborted();
    // A remote server cannot replace a local tool's implementation or policy.
    if (getBuiltinTool(toolName)) return callBuiltinTool(toolName, args);
    const serverName = this.toolToServer.get(toolName);
    if (!serverName) {
      return callBuiltinTool(toolName, args);
    }

    const server = this.servers.get(serverName);
    if (!server) {
      return {
        content: JSON.stringify({
          error: `Server ${serverName} not connected`,
        }),
        isError: true,
      };
    }

    const definition = this.allTools.find(t => t.name === toolName && t.serverName === serverName);
    const readOnly = (process.env.MCP_READ_ONLY_TOOLS || "").split(",").includes(`${serverName}/${toolName}`);
    const denied = await authorizeTool({ name: toolName, description: `MCP ${serverName}: ${definition?.description || toolName}`,
      inputSchema: { type: "object", properties: {} }, requiresApproval: !readOnly,
      isAvailable: () => true, handler: async () => "" }, args);
    if (denied) return denied;
    checkAborted();
    try {
      console.log(`[MCPManager] Calling ${serverName}/${toolName}`);

      const result = await server.client.callTool({
        name: toolName,
        arguments: args,
      }, undefined, { signal: currentExecution()?.controller.signal, timeout: 60_000 });

      // Flatten content blocks to string
      const text =
        (result.content as any[])
          ?.map((c: any) => c.text || JSON.stringify(c))
          .join("\n") || "OK";

      return { content: text, isError: !!result.isError };
    } catch (err: any) {
      console.error(`[MCPManager] Tool ${toolName} error:`, err.message);
      return {
        content: JSON.stringify({ error: err.message }),
        isError: true,
      };
    }
  }

  /**
   * Get all tools (MCP + active built-ins) in Anthropic Tool format.
   */
  getAnthropicTools(): Anthropic.Tool[] {
    const mcp = this.allTools.filter(t => !getBuiltinTool(t.name)).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object" as const,
        ...(t.inputSchema as any),
      },
    }));
    const builtins = this.activeBuiltins().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: "object" as const,
        ...(t.inputSchema as any),
      },
    }));
    return [...mcp, ...builtins];
  }

  /**
   * Get all tools (MCP + active built-ins) in OpenAI function calling format.
   */
  getOpenAITools(): OpenAITool[] {
    const toOpenAI = (t: {
      name: string;
      description: string;
      inputSchema: Record<string, any>;
    }): OpenAITool => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: "object",
          ...(t.inputSchema as any),
        },
      },
    });
    return [...this.allTools.filter(t => !getBuiltinTool(t.name)).map(toOpenAI), ...this.activeBuiltins().map(toOpenAI)];
  }

  /**
   * Check if a tool name is known (MCP server or active built-in).
   */
  hasTool(name: string): boolean {
    return (
      this.toolToServer.has(name) ||
      this.activeBuiltins().some((t) => t.name === name)
    );
  }

  /**
   * Number of available tools (MCP + active built-ins).
   */
  get toolCount(): number {
    return this.allTools.length + this.activeBuiltins().length;
  }

  /**
   * Whether MCPManager has been initialized.
   */
  get isReady(): boolean {
    return this.initialized;
  }

  /**
   * Status summary for logging/diagnostics.
   */
  getStatus(): string {
    if (!this.initialized) return "not initialized";
    const builtinCount = this.activeBuiltins().length;
    if (this.servers.size === 0) {
      return builtinCount > 0
        ? `no servers, ${builtinCount} built-in tools`
        : "no servers";
    }
    const serverList = Array.from(this.servers.entries())
      .map(([name, s]) => `${name}(${s.tools.length})`)
      .join(", ");
    return `${this.servers.size} servers, ${this.allTools.length} MCP tools + ${builtinCount} built-ins: ${serverList}`;
  }

  /**
   * Shut down all MCP server connections and kill processes.
   */
  shutdown(): void {
    if (this.servers.size === 0) return;
    console.log(`[MCPManager] Shutting down ${this.servers.size} servers...`);

    this.servers.forEach((server, name) => {
      try {
        server.client.close();
      } catch {
        // Ignore cleanup errors
      }
    });

    this.servers.clear();
    this.allTools = [];
    this.toolToServer.clear();
    this.initialized = false;
  }

  // ============================================================
  // CONFIG LOADING
  // ============================================================

  private loadConfigs(): Record<string, ServerConfig> {
    // Merge all sources; earlier entries win on name collision.
    const merged: Record<string, ServerConfig> = {};
    const seen = new Set<string>();
    const addSource = (
      label: string,
      servers: Record<string, ServerConfig>
    ) => {
      let added = 0;
      for (const [name, cfg] of Object.entries(servers)) {
        if (seen.has(name)) continue;
        seen.add(name);
        merged[name] = cfg;
        added++;
      }
      if (added > 0) console.log(`[MCPManager] Config: ${label} (+${added} server)`);
    };

    // Priority 1: tybo-specific config (supports stdio + http)
    const projectConfig = resolve(process.cwd(), "config", "mcp-servers.json");
    if (existsSync(projectConfig)) {
      try {
        const raw = JSON.parse(readFileSync(projectConfig, "utf-8"));
        addSource(projectConfig, raw.servers || {});
      } catch (err: any) {
        console.error(
          `[MCPManager] Bad config ${projectConfig}: ${err.message}`
        );
      }
    }

    // Priority 2: MCP_CONFIG_PATH env var
    const envPath = process.env.MCP_CONFIG_PATH;
    if (envPath && existsSync(envPath)) {
      try {
        const raw = JSON.parse(readFileSync(envPath, "utf-8"));
        addSource(envPath, raw.servers || raw.mcpServers || {});
      } catch (err: any) {
        console.error(`[MCPManager] Bad config ${envPath}: ${err.message}`);
      }
    }

    // Priority 3: ~/.claude.json auto-discovery — stdio only if bun-based
    // (npx = zombie risk), http entries pass through.
    const claudeConfig = resolve(
      process.env.HOME || "/root",
      ".claude.json"
    );
    if (existsSync(claudeConfig)) {
      try {
        const raw = JSON.parse(readFileSync(claudeConfig, "utf-8"));
        const mcpServers = raw.mcpServers || {};
        const discovered: Record<string, ServerConfig> = {};

        for (const [name, config] of Object.entries(mcpServers) as [
          string,
          any,
        ][]) {
          if (config.type === "http" || config.type === "sse") {
            if (config.url) {
              discovered[name] = {
                type: "http",
                url: config.url,
                headers: config.headers || {},
              };
            }
            continue;
          }
          if (config.command?.includes("bun")) {
            discovered[name] = {
              command: config.command,
              args: config.args || [],
              env: config.env || {},
            };
          }
        }

        addSource(claudeConfig, discovered);
      } catch (err: any) {
        console.error(
          `[MCPManager] Bad config ${claudeConfig}: ${err.message}`
        );
      }
    }

    return merged;
  }

  /**
   * Resolve placeholder values: ${VAR_NAME} goes through the
   * Credential Registry (.env first, migration fallbacks after).
   * Handles embedded placeholders too ("Bearer ${VAR}").
   * Never logs values. Unresolvable vars pass through unchanged.
   */
  private interpolate(value: string): string {
    if (!value.includes("${")) return value;
    return value.replace(/\$\{([^}]+)\}/g, (original, varName) => {
      const resolved = optionalCredential(varName);
      return resolved || original;
    });
  }

  /**
   * Resolve env var references like ${VAR_NAME} via the Credential Registry.
   */
  private resolveEnv(env: Record<string, string>): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      resolved[key] = this.interpolate(value);
    }
    return resolved;
  }
}

// ============================================================
// SINGLETON
// ============================================================

export const mcpManager = new MCPManager();
