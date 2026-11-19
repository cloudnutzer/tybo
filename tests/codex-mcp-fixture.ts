/** Erfundenes MCP-Angebot, echte Planung, ausschließlich ersetzte Dateileser. */
import { setCodexMcpInputsForTests, setCodexMcpReaderForTests } from "../src/lib/engines/codex-mcp";
import type { CodexMcpSettings } from "../src/lib/settings";

export const MCP_MARK = "mcp-markierung-alpha";
export const MCP_TEAM = "mcp-markierung-team";
export const MCP_FILE = "mcp-markierung-datei";
export const MCP_CWD = "/test-mcp-lauf";
export const MCP_ROOT = "/test-mcp-projekt";

export function installMcpSources(options: { settings?: () => CodexMcpSettings; token?: () => string } = {}): void {
  setCodexMcpInputsForTests({ parentEnv: () => ({}), projectRoot: () => MCP_ROOT,
    settings: options.settings ?? (() => ({})), lookup: () => undefined, secrets: () => [] });
  setCodexMcpReaderForTests(path => {
    if (path === `${MCP_ROOT}/config/mcp-servers.json`) return JSON.stringify({ servers: {
      suche: { type: "http", url: "https://suche.example/mcp",
        headers: { Authorization: `Bearer ${options.token?.() ?? MCP_MARK}`, "X-Team": MCP_TEAM } },
      dateien: { command: "bun", args: ["run", "/beispiel/dateien.ts"], env: { DATEIEN_WERT: MCP_FILE } },
    } });
    if (path.endsWith("/.claude.json")) return JSON.stringify({ mcpServers: {
      stimme: { type: "http", url: "https://stimme.example/mcp" },
      alt: { type: "sse", url: "https://alt.example/sse" },
    } });
    if (path.endsWith("/.codex/config.toml")) return '[mcp_servers.eigen]\ncommand="eigener-server"';
    throw Object.assign(new Error("Testdatei fehlt"), { code: "ENOENT" });
  });
}
