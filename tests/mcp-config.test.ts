/**
 * Issue #332: Konfiguration der MCP-Server (src/lib/mcp/config.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandPlaceholders, loadServerSpecs, resolveSpec, type SpecSources } from "../src/lib/mcp/config";

let dir = "";
let sources: SpecSources;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-mcp-config-"));
  sources = { projectFile: join(dir, "project.json"), extraFile: join(dir, "extra.json"), claudeFile: join(dir, "claude.json") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (path: string, data: unknown) => writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));

describe("Quellen", () => {
  test("ohne Dateien keine Server", () => {
    expect(loadServerSpecs(sources).size).toBe(0);
  });

  test("Projekt vor MCP_CONFIG_PATH vor ~/.claude.json, Reihenfolge bleibt", () => {
    write(sources.projectFile, { servers: { a: { command: "npx", args: ["-y", "a"] }, shared: { command: "projekt" } } });
    write(sources.extraFile!, { mcpServers: { shared: { command: "extra" }, b: { command: "python3", args: ["b.py"] } } });
    write(sources.claudeFile, { mcpServers: { shared: { command: "bun" }, c: { command: "/x/bun", args: ["run", "c.ts"], env: { K: "v" } } } });
    const specs = loadServerSpecs(sources);
    expect([...specs.keys()]).toEqual(["a", "shared", "b", "c"]);
    expect(specs.get("shared")).toEqual({ kind: "stdio", command: "projekt", args: [], env: {} });
    expect(specs.get("a")).toEqual({ kind: "stdio", command: "npx", args: ["-y", "a"], env: {} });
    expect(specs.get("b")).toEqual({ kind: "stdio", command: "python3", args: ["b.py"], env: {} });
    expect(specs.get("c")).toEqual({ kind: "stdio", command: "/x/bun", args: ["run", "c.ts"], env: { K: "v" } });
  });

  test("MCP_CONFIG_PATH liest auch den Schlüssel servers", () => {
    write(sources.extraFile!, { servers: { x: { type: "http", url: "https://x.example/mcp" } } });
    expect(loadServerSpecs(sources).get("x")).toEqual({ kind: "http", url: "https://x.example/mcp", headers: {} });
  });

  test("Projektdatei kennt type http mit Kopfzeilen", () => {
    write(sources.projectFile, { servers: { fc: { type: "http", url: "https://fc.example/${KEY}/mcp", headers: { Authorization: "Bearer ${TOKEN}" } } } });
    expect(loadServerSpecs(sources).get("fc")).toEqual({
      kind: "http",
      url: "https://fc.example/${KEY}/mcp",
      headers: { Authorization: "Bearer ${TOKEN}" },
    });
  });

  test("~/.claude.json: lokal nur mit bun, http und sse als entfernte Server", () => {
    write(sources.claudeFile, {
      mcpServers: {
        npxServer: { command: "npx", args: ["-y", "firecrawl-mcp"] },
        bunServer: { command: "bun", args: ["run", "s.ts"] },
        remote: { type: "http", url: "https://r.example/mcp", headers: { H: "1" } },
        stream: { type: "sse", url: "https://s.example/sse" },
        noUrl: { type: "http" },
      },
    });
    const specs = loadServerSpecs(sources);
    expect([...specs.keys()]).toEqual(["bunServer", "remote", "stream"]);
    expect(specs.get("remote")).toEqual({ kind: "http", url: "https://r.example/mcp", headers: { H: "1" } });
    expect(specs.get("stream")).toEqual({ kind: "http", url: "https://s.example/sse", headers: {} });
  });

  test("kaputte Datei überspringt nur diese Quelle", () => {
    write(sources.projectFile, "{ kaputt");
    write(sources.claudeFile, { mcpServers: { ok: { command: "bun" } } });
    expect([...loadServerSpecs(sources).keys()]).toEqual(["ok"]);
  });

  test("ohne MCP_CONFIG_PATH bleibt die Quelle leer", () => {
    write(sources.extraFile!, { servers: { x: { command: "x" } } });
    expect(loadServerSpecs({ ...sources, extraFile: undefined }).size).toBe(0);
  });

  test("Beispieldatei config/mcp-servers.example.json ist gültig und zeigt beide Arten", () => {
    const example = join(import.meta.dir, "..", "config", "mcp-servers.example.json");
    const specs = loadServerSpecs({ projectFile: example, claudeFile: join(dir, "fehlt.json") });
    const kinds = [...specs.values()].map((s) => s.kind);
    expect(kinds).toContain("stdio");
    expect(kinds).toContain("http");
  });
});

describe("Platzhalter", () => {
  const lookup = (name: string) => ({ TOKEN: "geheim", KEY: "k1" } as Record<string, string>)[name];

  test("ersetzt auch mitten im Text, Unbekanntes bleibt stehen", () => {
    expect(expandPlaceholders("Bearer ${TOKEN}", lookup)).toBe("Bearer geheim");
    expect(expandPlaceholders("${KEY}-${TOKEN}", lookup)).toBe("k1-geheim");
    expect(expandPlaceholders("${FEHLT}", lookup)).toBe("${FEHLT}");
    expect(expandPlaceholders("ohne", lookup)).toBe("ohne");
  });

  test("resolveSpec löst url, headers und env auf, ohne das Original zu ändern", () => {
    const http = { kind: "http" as const, url: "https://x/${KEY}", headers: { A: "Bearer ${TOKEN}" } };
    expect(resolveSpec(http, lookup)).toEqual({ kind: "http", url: "https://x/k1", headers: { A: "Bearer geheim" } });
    expect(http.headers.A).toBe("Bearer ${TOKEN}");
    const local = { kind: "stdio" as const, command: "bun", args: ["${KEY}"], env: { T: "${TOKEN}" } };
    expect(resolveSpec(local, lookup)).toEqual({ kind: "stdio", command: "bun", args: ["${KEY}"], env: { T: "geheim" } });
    expect(local.env.T).toBe("${TOKEN}");
  });
});
