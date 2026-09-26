// Demo und web:dev mit Einstellungen (Issue #38): Einstellungen, Anweisungen
// und Modell-Listen kommen aus Attrappen im Speicher. Kein Netzabruf, kein
// config/settings.json und kein config/agent-overrides.json des Checkouts.
import { afterAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDemoInstructions, createDemoModels, createDemoSettings, startDemoServer } from "../src/web/demo";
import { CLAUDE_MODELS } from "../src/web/models";
import { applySettingsPatch, inheritedAgentValues } from "../src/web/settings";

const root = resolve(import.meta.dir, "..");
const demo = await startDemoServer({ host: "127.0.0.1", port: 0, password: "test-passwort-lang", allowedHosts: [] }, { log: () => {} });
afterAll(() => demo.stop());
const origin = demo.server.url;

async function api(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function fileOrNull(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

test("GET /api/settings: Beispielstand mit geerbten Werten; PATCH wirkt nur im Speicher", async () => {
  const before = await fileOrNull(resolve(root, "config", "settings.json"));
  const { status, body } = await api("/api/settings");
  expect(status).toBe(200);
  expect(body.fileInvalid).toBe(false);
  expect(body.settings.agents.research).toEqual({ model: "claude-sonnet-5" });
  expect(body.effective.agents.research.model).toEqual({ value: "claude-sonnet-5", source: "settings" });
  expect(body.inherited.research.model).toEqual({ value: "claude-opus-5-5", source: "code" });
  expect(body.effortLevels).toEqual(["low", "medium", "high", "xhigh"]);

  const patched = await api("/api/settings", "PATCH", { agents: { research: { model: null }, general: { effort: "low" } } });
  expect(patched.status).toBe(200);
  expect(patched.body.restartRequired).toBe(false);
  expect(patched.body.settings.agents.research).toBeUndefined();
  expect(patched.body.effective.agents.general.effort).toEqual({ value: "low", source: "settings" });
  expect((await api("/api/settings", "PATCH", { agents: { general: { effort: "turbo" } } })).status).toBe(400);
  expect(await fileOrNull(resolve(root, "config", "settings.json"))).toBe(before);
});

test("Anweisungen: hinzufügen, letzte und alle entfernen, nur im Speicher", async () => {
  const before = await fileOrNull(resolve(root, "config", "agent-overrides.json"));
  expect((await api("/api/agents/research/instructions")).body.instructions).toEqual(["Antworte kürzer und nenne immer die Quelle."]);
  expect((await api("/api/agents/research/instructions", "POST", { text: "Zweite" })).body.instructions).toHaveLength(2);
  expect((await api("/api/agents/research/instructions/last", "DELETE")).body.instructions).toHaveLength(1);
  expect((await api("/api/agents/research/instructions", "DELETE")).body.instructions).toEqual([]);
  expect(await fileOrNull(resolve(root, "config", "agent-overrides.json"))).toBe(before);
});

test("Modell-Listen ohne Netzabruf", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const models = createDemoModels();
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    throw new Error("kein Netz");
  }) as any;
  try {
    const list = await models.list();
    expect(list.claude.models).toEqual([...CLAUDE_MODELS]);
    expect(list.openrouter.error).toBeUndefined();
    expect(calls).toEqual([]);
  } finally {
    globalThis.fetch = realFetch;
  }
  expect((await api("/api/models")).body.claude.models).toEqual([...CLAUDE_MODELS]);
});

test("Attrappen einzeln: Einstellungen prüfen grob wie das Schema, geerbte Werte über effective", async () => {
  const port = createDemoSettings({ defaults: { model: "claude-haiku-4-5-20251001" }, agents: { critic: { model: "x", effort: "low" } } });
  // Wie das echte Schema seit Issue #49: jede gültige Kennung, aktive Agenten prüft applySettingsPatch (Issue #50)
  expect(port.validate({ agents: { nobody: {} } }).ok).toBe(true);
  expect(port.validate({ agents: { No_Body: {} } }).ok).toBe(false);
  expect(applySettingsPatch({}, { agents: { nobody: { effort: "low" } } }, port.agents).ok).toBe(false);
  expect(port.validate({ agents: { critic: { model: "a\u0007b" } } }).ok).toBe(false);
  expect(port.validate({ defaults: { effort: "xhigh" } }).ok).toBe(true);
  const inherited = inheritedAgentValues(port, port.current());
  expect(inherited.critic.model).toEqual({ value: "claude-haiku-4-5-20251001", source: "settings" });
  expect(inherited.critic.effort).toEqual({ value: "high", source: "code" });

  const inst = createDemoInstructions({});
  expect(await inst.removeLast("general")).toBeUndefined();
  expect(await inst.add("general", "a")).toBe(1);
  expect(await inst.clear("general")).toBe(1);
  expect(inst.list("general")).toEqual([]);
});
