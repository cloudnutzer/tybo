/**
 * Firecrawl Built-ins — direkter REST-Zugriff auf api.firecrawl.dev/v2.
 *
 * Absichtlich dieselben Tool-Namen wie der Firecrawl-Remote-MCP
 * (config/mcp-servers.json): solange der MCP-Server laeuft, gewinnt er
 * (Kollisionsregel), diese REST-Varianten sind das Backup, wenn
 * mcp.firecrawl.dev nicht bootet.
 */

import { optionalCredential } from "../credentials";
import { executionSignal } from "../execution-context";
import { registerBuiltinTool } from "./registry";

const API = "https://api.firecrawl.dev/v2";

function key(): string {
  return optionalCredential("FIRECRAWL_API_KEY");
}

async function fcPost(path: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    // /stop und Stopp-Knopf brechen den Abruf ab (z. B. /learn)
    signal: executionSignal(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Firecrawl HTTP ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

registerBuiltinTool({
  name: "firecrawl_scrape",
  description:
    "Scrape a single web page and return its main content as markdown. Use for reading a specific URL the user mentioned.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to scrape" },
    },
    required: ["url"],
  },
  isAvailable: () => !!key(),
  handler: async (args) => {
    const data = await fcPost("/scrape", {
      url: args.url,
      onlyMainContent: true,
      formats: ["markdown"],
    });
    const md = data?.data?.markdown ?? data?.markdown ?? "";
    const title = data?.data?.metadata?.title;
    if (!md) return JSON.stringify({ error: "No content returned", url: args.url });
    return (title ? `# ${title}\n\n` : "") + md;
  },
});

registerBuiltinTool({
  name: "firecrawl_search",
  description:
    "Search the web and return results with title, URL and snippet. Use when you need current information or don't know the exact URL.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      limit: {
        type: "number",
        description: "Max results (default 5)",
      },
    },
    required: ["query"],
  },
  isAvailable: () => !!key(),
  handler: async (args) => {
    const data = await fcPost("/search", {
      query: args.query,
      limit: Math.min(Number(args.limit) || 5, 10),
    });
    // v2 liefert data.web[], aeltere Shapes ein flaches Array
    const results = data?.data?.web ?? data?.data ?? [];
    if (!Array.isArray(results) || results.length === 0) {
      return JSON.stringify({ results: [], message: "No results" });
    }
    return JSON.stringify(
      results.map((r: any) => ({
        title: r.title,
        url: r.url,
        description: r.description,
      }))
    );
  },
});

registerBuiltinTool({
  name: "firecrawl_map",
  description:
    "Discover the URLs of a website (sitemap-style). Returns a list of links found on the site. Use before scraping to find the right subpage.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The site URL to map" },
      limit: {
        type: "number",
        description: "Max URLs to return (default 50)",
      },
    },
    required: ["url"],
  },
  isAvailable: () => !!key(),
  handler: async (args) => {
    const limit = Math.min(Number(args.limit) || 50, 200);
    const data = await fcPost("/map", { url: args.url, limit });
    const links = data?.data?.links ?? data?.links ?? [];
    const urls = (Array.isArray(links) ? links : [])
      .map((l: any) => (typeof l === "string" ? l : l?.url))
      .filter(Boolean)
      .slice(0, limit);
    return JSON.stringify({ count: urls.length, urls });
  },
});
