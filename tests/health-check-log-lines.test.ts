/**
 * Issue #568: Die Zeile „Fehler im Log (24h)“ zählt, was der Bot wirklich
 * schreibt. Die Ersatzmodell-Zeilen erzeugt hier die echte Ersatzkette
 * (runFallbackChain mit Attrappen für Claude-CLI und HTTP, kein Netz), die
 * Edge-Zeile die echte Warnung; beide landen in einem Bot-Log im
 * Temp-Ordner, und die Berichtsprüfung checkErrorLog zählt sie samt der
 * Grenze aus dem Stand vor 24 Stunden.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkErrorLog, type HealthState } from "../src/health-check";
import { runFallbackChain } from "../src/lib/fallback/chain";
import { setSettingsPath } from "../src/lib/settings";
import { reportEdgeFallback, resetEdgeFallbackWarning } from "../src/lib/store/supabase/edge-warning";

const H = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-14T02:30:00.000Z");
const ENV_KEYS = ["OPENROUTER_API_KEY", "FALLBACK_OFFLINE_ONLY", "FALLBACK_K3", "FALLBACK_CLAUDE_MODEL", "OLLAMA_MODEL", "OPENROUTER_MODEL"] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "tybo-nachtcheck-log-"));
  mkdirSync(join(dir, "logs"));
  setSettingsPath(join(dir, "settings.json"));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setSettingsPath();
  rmSync(dir, { recursive: true, force: true });
});

/** Zeilen, die console.log bzw. console.error während fn schreiben, wie im Bot-Log */
async function captured(fn: () => Promise<unknown> | unknown): Promise<string[]> {
  const lines: string[] = [];
  const spies = (["log", "warn", "error"] as const).map(level =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(" ")))
  );
  try {
    await fn();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return lines;
}

/** Ein Lauf der echten Ersatzkette: Claude-CLI scheitert, Ollama antwortet (beides Attrappen) */
async function fallbackRunLines(): Promise<string[]> {
  return captured(() =>
    runFallbackChain(
      { question: "Wie wird das Wetter?", context: "## MEMORY\nAlex mag Regen." },
      {
        callClaude: async () => ({ text: "", isError: true }) as never,
        tools: () => undefined,
        loop: {
          fetch: (async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Sonne" } }] }), { status: 200 })) as never,
          callTool: async () => ({ content: "", isError: false }),
          reserve: () => "r1",
          settle: () => {},
        },
      }
    )
  );
}

const BOT_LOG = () => join(dir, "logs", "telegram-relay.log");
const ERROR_LOG = () => join(dir, "logs", "telegram-relay.error.log");

describe("Fehler im Log (24h) mit echten Zeilen", () => {
  test("eine heutige Ersatzmodell-Zeile zählt, ältere vor der 24-Stunden-Grenze nicht", async () => {
    // Gestern (vor dem Stand von vor 25 Stunden): schon ein Ersatzmodell-Lauf
    const old = await fallbackRunLines();
    expect(old.filter(l => l.includes("Fallback: versuche"))).toEqual(["🔄 Fallback: versuche Claude-CLI (claude-opus-5[1m])", "🔄 Fallback: versuche Ollama (qwen3:8b)"]);
    writeFileSync(BOT_LOG(), old.join("\n") + "\n");
    writeFileSync(ERROR_LOG(), "");
    const baseline = statSync(BOT_LOG()).size;
    const state: HealthState = {
      logs: {
        "logs/telegram-relay.log": [{ at: NOW - 25 * H, size: baseline }],
        "logs/telegram-relay.error.log": [{ at: NOW - 25 * H, size: 0 }],
      },
    };

    // Heute: ein weiterer Lauf, nur Ollama springt ein (Claude-CLI ist wieder Teil der Kette)
    const today = await fallbackRunLines();
    appendFileSync(BOT_LOG(), today.join("\n") + "\n");
    resetEdgeFallbackWarning();
    const edge = await captured(() => reportEdgeFallback(401, undefined, NOW));
    appendFileSync(ERROR_LOG(), edge.join("\n") + "\n");

    const next: HealthState = { logs: { ...state.logs } };
    const result = await checkErrorLog(NOW, state, next, dir);
    expect(result.name).toBe("Fehler im Log (24h)");
    expect(result.status).toBe("warn");
    // Nur die Zeilen nach dem Stand von vor 25 Stunden: je ein Versuch, nicht zwei
    expect(result.detail).toBe("1x Ersatzmodell Claude-CLI, 1x Ersatzmodell Ollama, 1x saveMessage ohne Embedding");
    // Neuer Stand für den nächsten Lauf
    expect(next.logs["logs/telegram-relay.log"].at(-1)).toEqual({ at: NOW, size: statSync(BOT_LOG()).size });
  });

  test("ein Stand von vor einer Stunde ist keine Grenze: gezählt wird ab dem Stand vor mindestens 24 Stunden", async () => {
    writeFileSync(BOT_LOG(), "");
    const today = await fallbackRunLines();
    appendFileSync(BOT_LOG(), today.join("\n") + "\n");
    const size = statSync(BOT_LOG()).size;
    const state: HealthState = { logs: { "logs/telegram-relay.log": [{ at: NOW - 30 * H, size: 0 }, { at: NOW - H, size }] } };
    const result = await checkErrorLog(NOW, state, { logs: {} }, dir);
    expect(result.detail).toBe("1x Ersatzmodell Claude-CLI, 1x Ersatzmodell Ollama");
  });

  test("erster Lauf ohne Stand: ganzes Log, so gekennzeichnet", async () => {
    writeFileSync(BOT_LOG(), (await fallbackRunLines()).join("\n") + "\n");
    const result = await checkErrorLog(NOW, { logs: {} }, { logs: {} }, dir);
    expect(result.status).toBe("warn");
    expect(result.detail).toBe("1x Ersatzmodell Claude-CLI, 1x Ersatzmodell Ollama (ganzes Log, erster Lauf)");
  });

  test("ohne Ersatzmodell seit gestern: keine Auffälligkeiten", async () => {
    writeFileSync(BOT_LOG(), (await fallbackRunLines()).join("\n") + "\n");
    const size = statSync(BOT_LOG()).size;
    appendFileSync(BOT_LOG(), "[web] Anfrage beantwortet\n");
    const result = await checkErrorLog(NOW, { logs: { "logs/telegram-relay.log": [{ at: NOW - 24 * H, size }] } }, { logs: {} }, dir);
    expect(result).toEqual({ name: "Fehler im Log (24h)", status: "ok", detail: "keine Auffälligkeiten" });
  });
});
