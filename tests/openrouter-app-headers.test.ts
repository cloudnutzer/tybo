/**
 * Issue #134, Schritt 3: OpenRouter-Aufrufe kennzeichnen die App mit der
 * eigenen Domain, an allen Stellen über eine gemeinsame Konstante. aux-model
 * und resilient-client werden als Text gelesen; die Fallback-Kette wird seit
 * Issue #331 am Verhalten geprüft (gesendete Kopfzeilen mit Fake-fetch).
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENROUTER_APP_HEADERS } from "../src/brand";
import { runFallbackChain } from "../src/lib/fallback/chain";
import { setSettingsPath } from "../src/lib/settings";

const root = join(import.meta.dir, "..");

test("Referer ist https://tybo.ai, Titel der Produktname", () => {
  expect(OPENROUTER_APP_HEADERS).toEqual({ "HTTP-Referer": "https://tybo.ai", "X-Title": "tybo" });
});

test("aux-model und resilient-client nutzen die Konstante, kein fester Referer außerhalb von src/brand.ts", () => {
  const callers = ["src/lib/aux-model.ts", "src/lib/resilient-client.ts"];
  const uses = callers.map(f => (readFileSync(join(root, f), "utf8").match(/OPENROUTER_APP_HEADERS/g) ?? []).length - 1);
  // je ein Import plus ein Aufruf
  expect(uses).toEqual([1, 1]);
  const grep = Bun.spawnSync(["git", "grep", "-l", "HTTP-Referer", "--", "src"], { cwd: root, stdout: "pipe" });
  expect(grep.stdout.toString().trim().split("\n")).toEqual(["src/brand.ts"]);
});

test("Fallback-Kette: K3 und OpenRouter senden OPENROUTER_APP_HEADERS, Ollama nicht", async () => {
  const keys = ["OPENROUTER_API_KEY", "FALLBACK_K3", "FALLBACK_OFFLINE_ONLY"] as const;
  const saved = keys.map(k => process.env[k]);
  process.env.OPENROUTER_API_KEY = "test-schluessel-nicht-echt";
  delete process.env.FALLBACK_K3;
  delete process.env.FALLBACK_OFFLINE_ONLY;
  setSettingsPath(join(tmpdir(), `tybo-headers-${process.pid}-keine-datei.json`));
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const errors = console.error;
  console.error = () => {};
  try {
    await runFallbackChain(
      { question: "Frage", context: "## MEMORY\nTest" },
      {
        tools: () => undefined,
        callClaude: async () => ({ text: "", isError: true }),
        loop: {
          fetch: (async (url: unknown, init?: RequestInit) => {
            sent.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
            return new Response("nein", { status: 500 });
          }) as typeof fetch,
          callTool: async () => ({ content: "", isError: false }),
          reserve: () => "r",
          settle: () => {},
        },
      }
    );
  } finally {
    console.error = errors;
    setSettingsPath();
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
  expect(sent.map(s => s.url)).toEqual([
    "https://openrouter.ai/api/v1/chat/completions",
    "https://openrouter.ai/api/v1/chat/completions",
    "http://localhost:11434/v1/chat/completions",
  ]);
  expect(sent[0].headers).toMatchObject(OPENROUTER_APP_HEADERS);
  expect(sent[1].headers).toMatchObject(OPENROUTER_APP_HEADERS);
  expect(sent[2].headers["HTTP-Referer"]).toBeUndefined();
  expect(sent[2].headers["X-Title"]).toBeUndefined();
});
