/** M14-25: Vorschau der ganzen Liste, ausschließlich mit Prüf-Attrappen. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotEngines } from "../src/web/bot-engines";
import { ENGINE_PREVIEW_WAIT_MS, type EnginePort } from "../src/web/engines";
import { createDemoAgents, createDemoEngines, DEMO_SETTINGS } from "../src/web/demo";
import { resetEngineChoiceForTests, resolveEngine, shouldNotifyUnavailable } from "../src/lib/engine-choice";
import { readSwitchState, readSwitchHint, rememberSwitchHint, settleSwitchStateForTests, setSwitchStateFileForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import { CLAUDE_NOT_LOGGED_IN } from "../src/lib/engines/check";
import type { EngineId, EngineStatus } from "../src/lib/engines";
import type { Settings } from "../src/lib/settings";
import type { SwitchBlock, SwitchUsage } from "../src/lib/engine-switch";
import type { WebServer } from "../src/web/server";
import { topicServer } from "./topic-fixture";

const now = Date.parse("2026-11-18T12:00:00Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const block = (changes: Partial<SwitchBlock> = {}): SwitchBlock => ({ engine: "claude", cause: "threshold", window: "weekly_all", since: at(-5), until: at(60), resetKnown: true, percent: 96, ...changes }) as SwitchBlock;
let root: string;
let settings: Settings;
let statuses: Partial<Record<EngineId, Partial<EngineStatus>>>;
let counts: { settings: number; usage: number; state: number; checks: string[]; writes: number };
const servers: WebServer[] = [];
const usage: SwitchUsage = { claude: [], codex: [], opencode: [], api: [] };
const telegram = {
  listConversations: async () => ({ dm: { id: "dm", title: "Direktchat", agent: "research", lastActivity: null },
    topics: [{ id: "topic-1", title: "General", agent: "research", lastActivity: null },
      { id: "topic-443", title: "Recherche", agent: "general", lastActivity: null }] }),
  getConversation: async () => null, history: async () => null,
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "web-preview-"));
  setSwitchStateFileForTests(join(root, "engine-switch.json"));
  resetEngineChoiceForTests();
  settings = { agents: { general: { model: "claude-fable-5-2" }, research: { model: "claude-sonnet-5-5" } },
    engine: { backups: [{ engine: "claude", model: "claude-opus-5-5" }, { engine: "codex" }, { engine: "opencode" }], codex: { model: "gpt-6-astra" } } };
  statuses = {};
  counts = { settings: 0, usage: 0, state: 0, checks: [], writes: 0 };
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  setSwitchStateFileForTests(null);
  rmSync(root, { recursive: true, force: true });
});
function port(gate?: Promise<void>): EnginePort {
  return { ...createBotEngines({ userId: "668", groupId: () => "-10042", agentForTopic: () => "research",
    choice: { getSettings: () => { counts.settings++; return settings; }, env: () => ({ USER_TIMEZONE: "Europe/Berlin" }) },
    now: () => now, readUsage: async () => { counts.usage++; return usage; },
    readState: () => { counts.state++; return readSwitchState(); },
    updateState: async mutate => { counts.writes++; return updateSwitchState(mutate); },
    inspect: async engine => { counts.checks.push(engine); await gate; return { engine, checked: true, installed: true, loggedIn: true, ...statuses[engine] }; },
  }), subscribe: undefined };
}
async function list(p = port()) {
  const ctx = await topicServer(root, servers, null, { engines: p, telegram });
  const response = await ctx.api("/api/conversations");
  expect(response.status).toBe(200);
  return { ctx, body: await response.json() };
}
for (const scenario of ["first", "threshold-reset", "threshold-pause", "limit-reset", "limit-pause", "outage", "not_ready", "not_ready-ohne", "not_ready-fremd", "not_ready-lang", "manual", "none", "none-ohne", "claude-backup"] as const) {
  test(`API: ${scenario}, nur Anzeigefelder und kein Schreiben`, async () => {
    let blocks: SwitchBlock[] = [];
    if (scenario.startsWith("threshold") || scenario.startsWith("limit")) blocks = [block({ cause: scenario.startsWith("limit") ? "limit" : "threshold", resetKnown: scenario.endsWith("reset") })];
    if (scenario === "outage") blocks = [block({ cause: "outage", resetKnown: false })];
    if (scenario.startsWith("not_ready")) statuses.claude = { loggedIn: false, ...(scenario === "not_ready" ? { message: CLAUDE_NOT_LOGGED_IN }
      : scenario === "not_ready-lang" ? { message: `Claude Code startet nicht: claude --version endete mit Exit-Code ${"9".repeat(301)}` }
      : scenario === "not_ready-fremd" ? { message: "Fehler /privater/pfad TOKEN=geheimer-testwert" } : {}) };
    if (scenario === "manual") settings.engine!.topics = { "dm:668": "api" };
    if (scenario === "none") blocks = [block(), block({ engine: "codex", until: at(20) }), block({ engine: "opencode", cause: "outage", window: undefined, resetKnown: false, until: at(10) })];
    if (scenario === "none-ohne") for (const engine of ["claude", "codex", "opencode"] as const) statuses[engine] = { installed: false };
    if (scenario === "claude-backup") blocks = [block({ window: "weekly_scoped:fable" })];
    await updateSwitchState(s => ({ ...s, blocks, auto: { enabled: true, threshold: 95, returnBelow: 80 } }));
    rememberSwitchHint("topic:-10042:443", { stage: "codex", at: at(0) });
    await settleSwitchStateForTests();
    const before = readFileSync(join(root, "engine-switch.json"), "utf8");
    const { body } = await list();
    const stage = body.telegram.dm.engineStage;
    const choices = body.telegram.dm.engineChoices;
    expect(choices.map((c: any) => c.engine)).toEqual(["claude", "codex", "opencode", "api"]);
    const claude = choices[0];
    if (scenario.startsWith("not_ready")) {
      expect(claude).toMatchObject({ state: "not_ready", installed: true });
      if (scenario === "not_ready") expect(claude.message).toBe(CLAUDE_NOT_LOGGED_IN);
      if (scenario === "not_ready-fremd" || scenario === "not_ready-lang") expect(claude.message).toBe("Motor ist nicht angemeldet");
      expect(JSON.stringify(choices)).not.toContain("geheimer-testwert");
    }
    if (scenario.includes("pause") || scenario === "outage") expect(claude.resetKnown).toBe(false);
    if (scenario === "claude-backup") {
      expect(claude).toMatchObject({ model: "claude-fable-5-2", state: "blocked", window: "weekly_scoped:fable", blockedUntil: at(60), resetKnown: true });
      expect(choices.some((c: any) => c.state === "answering")).toBe(false);
    }
    const role = scenario === "first" || scenario === "manual" ? scenario : scenario.startsWith("none") ? "none" : "backup";
    expect(stage.role).toBe(role);
    expect(body.engine).toEqual({ default: "claude", timeZone: "Europe/Berlin" });
    expect(stage.engine).toBe(role === "none" ? null : scenario === "manual" ? "api" : scenario === "first" || scenario === "claude-backup" ? "claude" : "codex");
    if (role === "none") { expect(stage.label).toBeNull(); expect(stage).not.toHaveProperty("model"); }
    if (scenario === "none") expect(stage.until).toBe(at(10));
    if (scenario === "none-ohne") expect(stage).not.toHaveProperty("until");
    if (scenario === "claude-backup") expect(stage.label).toBe("Claude Code (claude-opus-5-5)");
    if (scenario.includes("reset") || scenario.includes("pause") || scenario === "outage") {
      expect(stage.reason).toEqual({ label: "Claude Code", kind: scenario.split("-")[0], window: "weekly_all", percent: 96, until: at(60), resetKnown: scenario.endsWith("reset") });
    }
    if (scenario === "not_ready") expect(stage.reason.message).toBe(CLAUDE_NOT_LOGGED_IN);
    if (scenario === "not_ready-ohne") expect(stage.reason).not.toHaveProperty("message");
    if (scenario === "not_ready-fremd" || scenario === "not_ready-lang") expect(stage.reason.message).toBe("Motor ist nicht angemeldet");
    for (const key of ["stages", "windows", "id", "available", "configured", "blockedUntil"]) {
      expect(stage).not.toHaveProperty(key);
      if (stage.reason) expect(stage.reason).not.toHaveProperty(key);
    }
    expect(readFileSync(join(root, "engine-switch.json"), "utf8")).toBe(before);
    expect(readSwitchHint("topic:-10042:443")).toEqual({ stage: "codex", at: at(0) });
    expect(shouldNotifyUnavailable("dm:668", "claude")).toBe(true);
    expect(counts).toEqual({ settings: 1, usage: 1, state: 1, checks: ["claude", "codex", "opencode", "api"], writes: 0 });
  });
}
test("50 Gespräche: einmal Einstellungen, Dateien und je Motor prüfen; richtiger Agent je Schlüssel", async () => {
  const ctx = await topicServer(root, servers, null, { engines: port(), telegram });
  for (let n = 0; n < 47; n++) await ctx.store.createConversation("research");
  const body = await (await ctx.api("/api/conversations")).json();
  expect(body.conversations).toHaveLength(47);
  for (const c of [body.telegram.dm, ...body.telegram.topics, ...body.conversations]) {
    expect(c.engineChoices.map((e: any) => e.engine)).toEqual(["claude", "codex", "opencode", "api"]);
  }
  expect(body.telegram.dm.engineStage.model).toBe("claude-fable-5-2");
  expect(body.telegram.topics[0].engineStage.model).toBe("claude-fable-5-2");
  expect(body.telegram.topics[1].engineStage.model).toBe("claude-sonnet-5-5");
  expect(body.conversations.every((c: any) => c.engineStage.model === "claude-sonnet-5-5")).toBe(true);
  expect(counts).toEqual({ settings: 1, usage: 1, state: 1, checks: ["claude", "codex", "opencode", "api"], writes: 0 });
});
for (const kind of ["first", "manual", "backup"] as const) test(`ohne Ersatzstufen: ${kind}, keine Datei, kein verbrauchter Hinweis`, async () => {
  settings.engine = kind === "first" ? {} : { topics: { "dm:668": "codex" } };
  statuses.codex = { loggedIn: kind !== "backup" };
  const { body } = await list();
  expect(body.telegram.dm.engineStage.role).toBe(kind);
  expect(counts.usage + counts.state + counts.writes).toBe(0);
  expect([...counts.checks].sort()).toEqual(["api", "claude", "codex", "opencode"]);
  if (kind === "backup") {
    const next = await resolveEngine("dm:668", { getSettings: () => settings, env: () => ({}), log: () => {},
      checkEngine: async engine => ({ engine, checked: true, installed: true, loggedIn: false }) }, { agentName: "general" });
    expect(next.kind === "stage" && next.notice).toContain("nicht verfügbar");
  }
});
for (const kind of ["throw", "reject", "old"] as const) test(`Vorschau ${kind}: Liste und alter Motor bleiben`, async () => {
  const p = port();
  const original = p.conversationSnapshot!;
  p.conversationSnapshot = kind === "old" ? undefined : kind === "throw" ? () => { throw new Error("Ausfall"); }
    : list => ({ ...original(list), stages: Promise.reject(new Error("Ausfall")) });
  const { body } = await list(p);
  expect(body.telegram.dm.engine).toBe("claude");
  expect(body.telegram.dm).not.toHaveProperty("engineStage");
});
test("kalter Cache: begrenztes Warten, danach engine-Ereignis und frische Liste", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const p = port(gate);
  const ctx = await topicServer(root, servers, null, { engines: p, telegram });
  const controller = new AbortController();
  const stream = await fetch(ctx.origin + "/api/telegram/events", { headers: { cookie: ctx.cookie }, signal: controller.signal });
  const reader = stream.body!.getReader();
  await reader.read();
  try {
    const started = performance.now();
    const body = await (await ctx.api("/api/conversations")).json();
    expect(performance.now() - started).toBeLessThan(ENGINE_PREVIEW_WAIT_MS + 500);
    expect(body.telegram.dm).not.toHaveProperty("engineStage");
    expect(body.telegram.dm).not.toHaveProperty("engineChoices");
    release();
    const event = await reader.read();
    expect(new TextDecoder().decode(event.value)).toContain("event: engine");
    expect((await (await ctx.api("/api/conversations")).json()).telegram.dm.engineStage.role).toBe("first");
  } finally { release(); controller.abort(); await reader.cancel().catch(() => {}); }
});
test("Demo: dieselben Sperren in Chat und Modellen, zusätzlich Beispiel ohne freie Stufe", async () => {
  const demo = createDemoAgents({ settings: structuredClone(DEMO_SETTINGS) });
  const p = createDemoEngines(demo.settings);
  const first = p.conversationSnapshot!([{ id: "dm", agent: "general" }]);
  expect((await first.stages).dm).toMatchObject({ engine: "codex", role: "backup", reason: { kind: "threshold", resetKnown: true, percent: 96 } });
  const modelView = await p.switchStatus(await p.availability());
  expect(modelView.order.find(s => s.state === "answering")?.engine).toBe("codex");
  const data = await demo.settings.readForWrite();
  data.engine!.backups = [{ engine: "claude", model: "claude-opus-5-5" }, { engine: "opencode" }];
  await demo.settings.write(data);
  expect((await p.conversationSnapshot!([{ id: "dm", agent: "general" }]).stages).dm).toMatchObject({ engine: null, label: null, role: "none" });
  expect((await p.switchStatus(await p.availability())).order.some(s => s.state === "answering")).toBe(false);
});

for (const window of ["weekly_scoped:fable", "weekly_all"] as const) test(`Auswahl je Gespräch mit ${window}: General/Fable und Research/Opus`, async () => {
  settings.agents!.research.model = "claude-opus-5-5";
  await updateSwitchState(s => ({ ...s, blocks: [block({ window })], auto: { enabled: true, threshold: 95, returnBelow: 80 } }));
  const { body } = await list();
  expect(body.telegram.dm.engineChoices[0]).toMatchObject({ engine: "claude", model: "claude-fable-5-2", state: "blocked", window, blockedUntil: at(60), resetKnown: true });
  expect(body.telegram.topics[1].engineChoices[0]).toMatchObject({ engine: "claude", model: "claude-opus-5-5", state: window === "weekly_all" ? "blocked" : "answering" });
});

test("ohne Ersatzstufen ignorieren auch die Wahlmöglichkeiten alte Sperren und Messwerte", async () => {
  settings.engine!.backups = [];
  await updateSwitchState(s => ({ ...s, blocks: [block()] }));
  statuses.opencode = { installed: false, loggedIn: false, message: "OpenCode ist nicht installiert" };
  const { body } = await list();
  expect(body.telegram.dm.engineChoices).toContainEqual({ engine: "claude", label: "Claude Code", model: "claude-fable-5-2", state: "answering" });
  expect(body.telegram.dm.engineChoices).toContainEqual({ engine: "opencode", label: "OpenCode", state: "not_ready", installed: false, message: "OpenCode ist nicht installiert" });
  expect(body.telegram.dm.engineChoices.some((c: any) => c.state === "blocked")).toBe(false);
  expect(counts.state + counts.usage + counts.writes).toBe(0);
});

test("nur Auswahlberechnung fehlgeschlagen: Liste und engineStage bleiben", async () => {
  const p = port();
  const original = p.conversationSnapshot!;
  p.conversationSnapshot = list => {
    const snapshot = original(list);
    return { ...snapshot, choices: snapshot.choices!.then(() => { throw new Error("Auswahl fehlgeschlagen"); }) };
  };
  const { body } = await list(p);
  expect(body.telegram.dm.engineStage).toMatchObject({ engine: "claude", role: "first" });
  expect(body.telegram.dm).not.toHaveProperty("engineChoices");
});

test("unklare Anmeldung: Claude bereit, Codex mit gefiltertem Grund nicht bereit", async () => {
  statuses.claude = { loggedIn: false, loginUnknown: true };
  statuses.codex = { loggedIn: false, loginUnknown: true, message: "Fremde Ausgabe /privat/test" };
  const { body } = await list();
  expect(body.telegram.dm.engineChoices[0].state).toBe("answering");
  expect(body.telegram.dm.engineChoices[1]).toMatchObject({ state: "not_ready", installed: true, message: "Anmeldung ließ sich nicht prüfen" });
});

test("Demo-Auswahl: gesperrt, pausiert, nicht bereit und verschiedener Stand je Gespräch", async () => {
  const demo = createDemoAgents({ settings: structuredClone(DEMO_SETTINGS) });
  const snapshot = createDemoEngines(demo.settings).conversationSnapshot!([
    { id: "dm", agent: "general" }, { id: "topic-443", agent: "research" }, { id: "opus", agent: "cto" },
  ]);
  const choices = await snapshot.choices!;
  expect(choices.dm[0]).toMatchObject({ state: "blocked", resetKnown: true });
  expect(choices["topic-443"][0].state).toBe("free");
  expect(choices.opus[0]).toMatchObject({ state: "blocked", resetKnown: false });
  expect(choices.dm[2]).toMatchObject({ state: "not_ready", installed: false });
  expect(choices.dm.map(c => c.engine)).toEqual(["claude", "codex", "opencode", "api"]);
});

// Die Telegram-Zuordnung ist maßgeblich, auch wenn die gespeicherte Liste einen alten Agenten nennt.
test("Gespräch und Vorschau nehmen den Motor des zugeordneten Agenten", async () => {
  settings.agents!.research!.engine = "codex";
  const { ctx, body } = await list();
  expect(body.telegram.dm.engine).toBe("claude");
  expect(body.telegram.topics.find((c: any) => c.id === "topic-443")).toMatchObject({ engine: "codex",
    engineStage: { engine: "codex", role: "first" } });
  settings.engine!.topics = { "topic:-10042:443": "api" };
  const changed = await (await ctx.api("/api/conversations")).json();
  expect(changed.telegram.topics.find((c: any) => c.id === "topic-443")).toMatchObject({ engine: "api",
    engineStage: { engine: "api", role: "manual" } });
});

test("Demo: Gespräch vor Agent vor Standard, API nur als Wunsch", async () => {
  const agents = createDemoAgents({ settings: { engine: { default: "api", backups: [{ engine: "claude" }] },
    agents: { research: { engine: "codex", model: "claude-sonnet-5-5" } } } });
  const p = createDemoEngines(agents.settings);
  let snapshot = p.conversationSnapshot!([{ id: "web-agent", agent: "research" }]);
  expect(snapshot.engines["web-agent"]).toBe("codex");
  expect((await snapshot.stages)["web-agent"]).toMatchObject({ engine: "codex", role: "first" });
  expect(p.agentEngines()).toEqual({ research: "codex" });
  await agents.settings.write({ ...agents.settings.data(), engine: { topics: { "web:web-agent": "api" } } });
  snapshot = p.conversationSnapshot!([{ id: "web-agent", agent: "research" }]);
  expect(snapshot.engines["web-agent"]).toBe("api");
  expect((await snapshot.stages)["web-agent"]).toMatchObject({ engine: "api", role: "manual" });
});
