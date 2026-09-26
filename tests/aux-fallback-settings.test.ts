import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setSettingsPath, type Settings } from "../src/lib/settings";
import { resolveAux, resolveAuxTarget, callAux } from "../src/lib/aux-model";
import * as claudeModule from "../src/lib/claude";
import { remainingBudget } from "../src/lib/daily-budget";
import {
  OPENROUTER_MODEL,
  OLLAMA_MODEL,
  FALLBACK_OFFLINE_ONLY,
  callFallbackLLMWithSource,
} from "../src/lib/fallback-llm";

// Vorrang: config/settings.json vor .env vor Standard. Einstellungen aus
// temporären Dateien, HTTP gefälscht, kein Claude-Aufruf. Das Tagesbudget
// liegt pro Test in einer frischen temporären Datei mit festen Werten, damit
// die echte data/api-budget.sqlite weder gelesen noch belastet wird.

const ENV_KEYS = [
  "AUX_MODEL_JUDGE",
  "AUX_MODEL_DISTILL",
  "AUX_MODEL_REVIEW",
  "OPENROUTER_MODEL",
  "OLLAMA_MODEL",
  "FALLBACK_OFFLINE_ONLY",
  "OPENROUTER_API_KEY",
  "FALLBACK_K3",
  "BUDGET_DB_PATH",
  "DAILY_API_BUDGET",
  "FALLBACK_REQUEST_RESERVATION_USD",
] as const;
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

let dir: string;
let file: string;
let tick = 9_000;
let logSpies: ReturnType<typeof spyOn>[] = [];

function putSettings(s: Settings | string) {
  writeFileSync(file, typeof s === "string" ? s : JSON.stringify(s));
  tick += 10;
  utimesSync(file, tick, tick);
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "tybo-aux-settings-"));
  file = join(dir, "settings.json");
  setSettingsPath(file);
  process.env.BUDGET_DB_PATH = join(dir, "budget.sqlite");
  process.env.DAILY_API_BUDGET = "5";
  process.env.FALLBACK_REQUEST_RESERVATION_USD = "1";
  logSpies = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = realFetch;
  for (const s of logSpies) s.mockRestore();
  setSettingsPath();
  rmSync(dir, { recursive: true, force: true });
});

/** Fängt HTTP-Aufrufe ab und antwortet im OpenAI-Format. */
function fakeFetch(reply = "antwort") {
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

/**
 * Wie fakeFetch, aber die HTTP-Antwort bleibt offen, bis release() aufgerufen
 * wird. started löst auf, sobald die Anfrage abgeschickt ist.
 */
function pendingFetch(reply = "antwort") {
  const calls: { url: string; body: any }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let onStart!: () => void;
  const started = new Promise<void>((r) => (onStart = r));
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    onStart();
    await gate;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, started, release };
}

/** Erfolgszeilen der Fallback-Kette aus dem console.log-Spy. */
function successLogs(): string[] {
  return logSpies[0].mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith("✅"));
}

describe("Aux-Modelle", () => {
  test("Einstellungsdatei vor AUX_MODEL_* vor Default", () => {
    expect(resolveAux("judge")).toEqual({ kind: "claude", model: "claude-opus-5" });
    process.env.AUX_MODEL_JUDGE = "openrouter:env/modell";
    expect(resolveAux("judge")).toEqual({ kind: "openrouter", model: "env/modell" });
    putSettings({ aux: { judge: "claude:claude-sonnet-5" } });
    expect(resolveAux("judge")).toEqual({ kind: "claude", model: "claude-sonnet-5" });
    // andere Zwecke unberührt
    expect(resolveAux("review")).toEqual({ kind: "claude", model: "claude-haiku-4-5-20251001" });
  });

  test("trennt am ersten Doppelpunkt: ollama:qwen3:8b", () => {
    putSettings({ aux: { distill: "ollama:qwen3:8b" } });
    expect(resolveAux("distill")).toEqual({ kind: "ollama", model: "qwen3:8b" });
    process.env.AUX_MODEL_REVIEW = "ollama:qwen3:8b";
    expect(resolveAux("review")).toEqual({ kind: "ollama", model: "qwen3:8b" });
  });

  test("Resume erzwingt weiter Claude, auch bei Nicht-Claude-Eintrag in der Datei", () => {
    putSettings({ aux: { distill: "ollama:qwen3:8b", judge: "openrouter:x/y", review: "claude:claude-sonnet-5" } });
    expect(resolveAuxTarget("distill", true)).toEqual({ kind: "claude", model: "claude-haiku-4-5-20251001" });
    expect(resolveAuxTarget("judge", true)).toEqual({ kind: "claude", model: "claude-opus-5" });
    expect(resolveAuxTarget("review", true)).toEqual({ kind: "claude", model: "claude-sonnet-5" });
    expect(resolveAuxTarget("distill", false)).toEqual({ kind: "ollama", model: "qwen3:8b" });
  });

  test("Dateiänderung wirkt beim nächsten Aufruf, ungültige Datei ändert nichts", async () => {
    const calls = fakeFetch("ok");
    putSettings({ aux: { review: "ollama:qwen3:8b" } });
    expect(await callAux("review", "p")).toEqual({ text: "ok", isError: false });
    putSettings({ aux: { review: "ollama:llama4:70b" } });
    await callAux("review", "p");
    putSettings({ aux: { review: "kaputt" } });
    await callAux("review", "p");
    expect(calls.map((c) => c.body.model)).toEqual(["qwen3:8b", "llama4:70b", "llama4:70b"]);
    expect(calls.every((c) => c.url.startsWith("http://localhost:11434/"))).toBe(true);
  });
});

describe("Fallback-Kette", () => {
  test("OpenRouter-Modell: Datei vor .env vor Standard", () => {
    expect(OPENROUTER_MODEL()).toBe("minimax/minimax-m2.7");
    process.env.OPENROUTER_MODEL = "env/modell";
    expect(OPENROUTER_MODEL()).toBe("env/modell");
    putSettings({ fallback: { openrouterModel: "datei/modell" } });
    expect(OPENROUTER_MODEL()).toBe("datei/modell");
  });

  test("Ollama-Modell: Datei vor .env vor Standard", () => {
    expect(OLLAMA_MODEL()).toBe("qwen3:8b");
    process.env.OLLAMA_MODEL = "env-modell";
    expect(OLLAMA_MODEL()).toBe("env-modell");
    putSettings({ fallback: { ollamaModel: "datei-modell" } });
    expect(OLLAMA_MODEL()).toBe("datei-modell");
  });

  test("offlineOnly: false in der Datei schlägt FALLBACK_OFFLINE_ONLY=true", () => {
    expect(FALLBACK_OFFLINE_ONLY()).toBe(false);
    process.env.FALLBACK_OFFLINE_ONLY = "true";
    expect(FALLBACK_OFFLINE_ONLY()).toBe(true);
    putSettings({ fallback: { offlineOnly: false } });
    expect(FALLBACK_OFFLINE_ONLY()).toBe(false);
    delete process.env.FALLBACK_OFFLINE_ONLY;
    putSettings({ fallback: { offlineOnly: true } });
    expect(FALLBACK_OFFLINE_ONLY()).toBe(true);
  });

  test("ungültige Datei: letzte gültige Fassung bleibt", () => {
    putSettings({ fallback: { ollamaModel: "gut" } });
    expect(OLLAMA_MODEL()).toBe("gut");
    putSettings({ fallback: { ollamaModel: "" } });
    expect(OLLAMA_MODEL()).toBe("gut");
  });

  test("Kette nutzt die Datei ohne Neustart: offlineOnly überspringt Cloud, Ollama-Modell aus der Datei", async () => {
    // Schlüssel gesetzt: ohne offlineOnly würde die Kette zuerst Kimi K3 über OpenRouter fragen
    process.env.OPENROUTER_API_KEY = "test-key-nicht-echt";
    const calls = fakeFetch("lokal");
    putSettings({ fallback: { offlineOnly: true, ollamaModel: "datei-ollama" } });
    expect(await callFallbackLLMWithSource("Frage")).toEqual({ text: "lokal", source: "ollama", model: "datei-ollama" });
    putSettings({ fallback: { offlineOnly: true, ollamaModel: "zweites-modell" } });
    expect((await callFallbackLLMWithSource("Frage")).model).toBe("zweites-modell");
    expect(calls.map((c) => c.body.model)).toEqual(["datei-ollama", "zweites-modell"]);
    expect(calls.every((c) => c.url.startsWith("http://localhost:11434/"))).toBe(true);
  });

  test("Ollama: Dateiwechsel während der Anfrage ändert die Herkunft der laufenden Antwort nicht", async () => {
    putSettings({ fallback: { offlineOnly: true, ollamaModel: "modell-a" } });
    const first = pendingFetch("von a");
    const running = callFallbackLLMWithSource("Frage");
    await first.started;
    putSettings({ fallback: { offlineOnly: true, ollamaModel: "modell-b" } });
    first.release();
    expect(await running).toEqual({ text: "von a", source: "ollama", model: "modell-a" });
    expect(first.calls.map((c) => c.body.model)).toEqual(["modell-a"]);
    expect(successLogs()).toEqual(["✅ Ollama responded (modell-a)"]);

    const calls = fakeFetch("von b");
    expect(await callFallbackLLMWithSource("Frage")).toEqual({ text: "von b", source: "ollama", model: "modell-b" });
    expect(calls.map((c) => c.body.model)).toEqual(["modell-b"]);
  });

  test("OpenRouter: Dateiwechsel während der Anfrage ändert die Herkunft der laufenden Antwort nicht", async () => {
    // Kimi K3 aus, Claude-CLI-Stufe scheitert ohne Prozess: die Kette landet bei OpenRouter
    process.env.OPENROUTER_API_KEY = "test-key-nicht-echt";
    process.env.FALLBACK_K3 = "false";
    const claudeSpy = spyOn(claudeModule, "callClaude").mockResolvedValue({ text: "", isError: true } as any);
    try {
      putSettings({ fallback: { openrouterModel: "anbieter/modell-a" } });
      const first = pendingFetch("von a");
      const running = callFallbackLLMWithSource("Frage");
      await first.started;
      putSettings({ fallback: { openrouterModel: "anbieter/modell-b" } });
      first.release();
      expect(await running).toEqual({ text: "von a", source: "openrouter", model: "anbieter/modell-a" });
      expect(first.calls.map((c) => c.body.model)).toEqual(["anbieter/modell-a"]);
      expect(first.calls.every((c) => c.url.startsWith("https://openrouter.ai/"))).toBe(true);
      expect(successLogs()).toEqual(["✅ OpenRouter responded (anbieter/modell-a)"]);

      const calls = fakeFetch("von b");
      expect(await callFallbackLLMWithSource("Frage")).toEqual({
        text: "von b",
        source: "openrouter",
        model: "anbieter/modell-b",
      });
      expect(calls.map((c) => c.body.model)).toEqual(["anbieter/modell-b"]);
      expect(claudeSpy).toHaveBeenCalledTimes(2);
      // beide Aufrufe ohne usage.cost: je 1 USD Reservierung, verbucht im temporären Budget
      expect(remainingBudget()).toBe(3);
    } finally {
      claudeSpy.mockRestore();
    }
  });
});
