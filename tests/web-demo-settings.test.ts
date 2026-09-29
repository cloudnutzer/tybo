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

// --- Motor in der Demo (Issue #126) ------------------------------------------

test("Demo-Motoren, Codex-Stufen und Rechte stimmen mit src/lib/settings.ts überein", async () => {
  const { DEMO_ENGINE_OPTIONS } = await import("../src/web/demo");
  const { botSettings } = await import("../src/web/bot-settings");
  expect(JSON.parse(JSON.stringify(DEMO_ENGINE_OPTIONS))).toEqual(JSON.parse(JSON.stringify(botSettings.engineOptions)));
});

test("Demo mit OpenCode (Issue #129): verfügbar, Modell-Liste aus der Attrappe, Topic Finanzen mit OpenCode-Antwort", async () => {
  const { DEMO_ENGINE_AVAILABILITY, DEMO_OPENCODE_MODELS, DEMO_OPENCODE_TOPIC, DEMO_SETTINGS, createDemoModels, createDemoTelegram, demoSessionKey } = await import("../src/web/demo");
  expect(DEMO_ENGINE_AVAILABILITY.find(a => a.engine === "opencode")).toEqual({ engine: "opencode", label: "OpenCode", installed: true, loggedIn: true, version: "1.18.33" });
  const lists = await createDemoModels().list();
  expect(lists.opencode).toEqual({ models: [...DEMO_OPENCODE_MODELS] });
  expect(DEMO_OPENCODE_MODELS.every(m => /^[A-Za-z0-9][\w.:/@-]*$/.test(m) && m.includes("/"))).toBe(true);
  expect(DEMO_SETTINGS.engine?.topics?.[demoSessionKey(DEMO_OPENCODE_TOPIC)!]).toBe("opencode");
  const history = await createDemoTelegram(Date.now()).history(DEMO_OPENCODE_TOPIC);
  const reply = history!.messages.find((m: any) => m.role === "assistant") as any;
  expect(reply).toMatchObject({ engine: "opencode", model: "openrouter/anthropic/claude-opus-5.5" });
});

test("Demo-Session-Schlüssel wie conversationSessionKey im Bot", async () => {
  const { DEMO_DM_SESSION_KEY, DEMO_GROUP_ID, demoSessionKey } = await import("../src/web/demo");
  const { conversationSessionKey } = await import("../src/web/bot-turn");
  const deps = { userId: DEMO_DM_SESSION_KEY.slice("dm:".length), groupId: () => DEMO_GROUP_ID, agentForTopic: () => "general" };
  for (const id of ["dm", "topic-1", "topic-443", "5f0c3a1e-demo-web"]) expect(demoSessionKey(id)).toBe(conversationSessionKey(id, deps));
});

test("Demo-Einstellungen prüfen den Motor grob wie das Schema, Demo-Motor entfernt genau einen Eintrag", async () => {
  const { createDemoEngines, DEMO_SETTINGS } = await import("../src/web/demo");
  const settings = createDemoSettings(DEMO_SETTINGS);
  expect(settings.validate({ engine: { codex: { sandbox: "alles" } } })).toEqual({
    ok: false,
    issues: [{ path: "engine.codex.sandbox", message: "erlaubt: read-only, workspace-write, full" }],
  });
  expect(settings.validate({ engine: { default: "gemini" } }).ok).toBe(false);
  expect(settings.validate({ engine: { default: "opencode", opencode: { model: "openrouter/anthropic/claude-opus-5.5", variant: "high", permission: "ask-deny" } } }).ok).toBe(true);
  for (const variant of ["-x", "-", "--auto", "a", "a".repeat(20)]) {
    expect(settings.validate({ engine: { opencode: { variant } } }).ok).toBe(true);
  }
  for (const opencode of [{ variant: "" }, { variant: "a_b" }, { variant: "a".repeat(21) }, { model: "a b" }, { permission: "full" }]) {
    expect(settings.validate({ engine: { opencode } }).ok).toBe(false);
  }
  expect(settings.validate({ engine: { default: "codex", codex: { model: "gpt-5.6-sol", effort: "max", sandbox: "read-only" } } }).ok).toBe(true);
  const engines = createDemoEngines(settings);
  expect(engines.standard()).toEqual({ engine: "claude", source: "code" });
  expect(Object.values(engines.overrides())).toEqual(["codex", "opencode"]);
  const [key, opencodeKey] = Object.keys(engines.overrides());
  expect(await engines.removeOverride(key)).toBe(true);
  expect(await engines.removeOverride(key)).toBe(false);
  expect(Object.values(engines.overrides())).toEqual(["opencode"]);
  expect(await engines.removeOverride(opencodeKey)).toBe(true);
  expect(settings.data().engine).toBeUndefined();
  expect(settings.data().agents).toEqual(DEMO_SETTINGS.agents);
});
