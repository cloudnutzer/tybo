/**
 * Issue #348, Checkbox 2: Werkzeugschleife des Motors "api" mit Freigaben.
 * Abruf bei Anthropic als Attrappe (tests/api-fixture.ts), Werkzeuge über
 * einen echten McpManager mit Attrappen-Transport (tests/mcp-fixture.ts) und
 * echte Built-ins der Registry; Freigaben über das echte Rückfragen-Register
 * (createChoiceToolApproval) mit eigener Datei. Kein Netz, kein Bot-Import.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideChoice, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { abortEngineCalls, activeEngineCallCount, createApiEngine, type EngineRequest, type EngineResult } from "../src/lib/engines";
import { managerToolHost, type ApiToolHost } from "../src/lib/engines/api-tools";
import { runExecution } from "../src/lib/execution-context";
import { processTurnIntents } from "../src/lib/intent-gate";
import { McpManager } from "../src/lib/mcp/manager";
import { createChoiceToolApproval, type ChoiceToolApproval } from "../src/lib/tool-approval";
import { registerBuiltinTool, setToolApprovalHandler } from "../src/lib/tools/registry";
import { classifyTurnTools } from "../src/lib/turn-tools";
import { installApiFake, sse, textReply, toolReply, until, type ApiFake } from "./api-fixture";
import { fakeFactory, localSpecs } from "./mcp-fixture";

const KEY = "topic:-100200300:5";
const base = mkdtempSync(join(tmpdir(), "tybo-348-tools-"));
let counter = 0;

// Echte Built-ins: zählen ihre Ausführungen
const reads: Record<string, unknown>[] = [];
const writes: Record<string, unknown>[] = [];
registerBuiltinTool({
  name: "t348_lesen",
  description: "Liest etwas (Test #348)",
  inputSchema: { type: "object", properties: { n: { type: "number" } } },
  isAvailable: () => true,
  handler: async (args) => {
    reads.push(args);
    return `gelesen ${args.n ?? ""}`.trim();
  },
});
registerBuiltinTool({
  name: "t348_schreiben",
  description: "Schreibt etwas (Test #348)",
  inputSchema: { type: "object", properties: {} },
  requiresApproval: true,
  isAvailable: () => true,
  handler: async (args) => {
    writes.push(args);
    return "geschrieben";
  },
});
registerBuiltinTool({
  name: "t348_kaputt",
  description: "Scheitert immer (Test #348)",
  inputSchema: { type: "object", properties: {} },
  isAvailable: () => true,
  handler: async () => {
    throw new Error("Platte voll");
  },
});
registerBuiltinTool({
  name: "t348_weg",
  description: "Nicht verfügbar (Test #348)",
  inputSchema: { type: "object", properties: {} },
  isAvailable: () => false,
  handler: async () => "nie",
});

let fake: ApiFake;
let manager: McpManager;
let mcp: ReturnType<typeof fakeFactory>;
let approval: ChoiceToolApproval;
let asked: Choice[];
let spies: { mockRestore(): void }[];
const savedReadOnly = process.env.MCP_READ_ONLY_TOOLS;

function useApproval(timeoutMs = 60_000) {
  approval?.dispose();
  approval = createChoiceToolApproval({
    sendChoice: async (choice) => {
      asked.push(choice);
      return { sent: true };
    },
    timeoutMs,
    log: () => {},
  });
  setToolApprovalHandler(approval.handler);
}

beforeEach(async () => {
  reads.length = 0;
  writes.length = 0;
  asked = [];
  setChoicesFileForTests(join(base, `choices-${++counter}.json`));
  spies = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})];
  mcp = fakeFactory({ notizen: { tools: [{ name: "notiz_lesen", description: "Liest Notizen" }, { name: "ask_user", description: "Fremdes ask_user" }] } });
  manager = new McpManager({ specs: localSpecs("notizen"), resolve: (s) => s, transports: mcp.factory });
  await manager.init();
  fake = installApiFake({ tools: managerToolHost(manager) });
  useApproval();
});

afterEach(async () => {
  fake.restore();
  approval.dispose();
  setToolApprovalHandler(null);
  setChoicesFileForTests(null);
  await manager.shutdown();
  for (const s of spies) s.mockRestore();
  if (savedReadOnly === undefined) delete process.env.MCP_READ_ONLY_TOOLS;
  else process.env.MCP_READ_ONLY_TOOLS = savedReadOnly;
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const request = (extra: Partial<EngineRequest> = {}): EngineRequest => ({
  prompt: "Bitte erledigen",
  streaming: false,
  timeoutMs: 60_000,
  cwd: process.cwd(),
  abortKey: KEY,
  // Wie ein Turn mit Rückfragen-Register (Chat-Kern mit onQuestion)
  questions: true,
  ...extra,
});

/** Lauf im Gespräch des Topics, wie ein Turn im Chat-Kern */
const run = (extra: Partial<EngineRequest> = {}): Promise<EngineResult> => runExecution(KEY, "general", () => createApiEngine().run(request(extra)));

/** Letzte Nutzernachricht einer Anfrage */
const lastUser = (body: any) => body.messages.at(-1);

describe("Werkzeugschleife", () => {
  test("zwei Runden mit je zwei Werkzeugaufrufen: jede tool_result-ID passt, Reihenfolge der Blöcke", async () => {
    fake.respond(toolReply([{ id: "a1", name: "t348_lesen", input: { n: 1 } }, { id: "a2", name: "t348_lesen", input: { n: 2 } }]));
    fake.respond(toolReply([{ id: "b1", name: "t348_lesen", input: { n: 3 } }, { id: "b2", name: "t348_lesen", input: { n: 4 } }]));
    fake.respond(textReply("fertig"));
    const r = await run();
    expect(r).toMatchObject({ engine: "api", isError: false, text: "fertig" });
    expect(reads.map((a) => a.n)).toEqual([1, 2, 3, 4]);
    const bodies = fake.bodies();
    expect(bodies).toHaveLength(3);
    expect(bodies[1].messages.at(-2)).toEqual({
      role: "assistant",
      content: [
        { type: "tool_use", id: "a1", name: "t348_lesen", input: { n: 1 } },
        { type: "tool_use", id: "a2", name: "t348_lesen", input: { n: 2 } },
      ],
    });
    expect(lastUser(bodies[1])).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a1", content: "gelesen 1" },
        { type: "tool_result", tool_use_id: "a2", content: "gelesen 2" },
      ],
    });
    expect(lastUser(bodies[2]).content.map((b: any) => b.tool_use_id)).toEqual(["b1", "b2"]);
    expect(r.tools?.uses).toEqual(Array(4).fill({ name: "t348_lesen", external: true }));
    expect(activeEngineCallCount()).toBe(0);
  });

  test("unbekanntes Werkzeug und Werkzeugfehler: tool_result mit is_error, Schleife läuft weiter", async () => {
    fake.respond(toolReply([{ id: "u1", name: "gibt_es_nicht" }, { id: "k1", name: "t348_kaputt" }, { id: "l1", name: "t348_lesen" }]));
    fake.respond(textReply("trotzdem fertig"));
    const r = await run();
    expect(r).toMatchObject({ isError: false, text: "trotzdem fertig" });
    const results = lastUser(fake.bodies()[1]).content;
    expect(results.map((b: any) => [b.tool_use_id, b.is_error === true])).toEqual([
      ["u1", true],
      ["k1", true],
      ["l1", false],
    ]);
    expect(results[0].content).toContain("gibt_es_nicht");
    expect(results[1].content).toContain("Platte voll");
  });

  test("nicht verfügbare Built-ins fehlen im Angebot, MCP-Werkzeuge sind dabei, eigene Namen reserviert", async () => {
    fake.respond(textReply("ok"));
    await run();
    const names: string[] = fake.lastBody().tools.map((t: any) => t.name);
    expect(names).toContain("t348_lesen");
    expect(names).toContain("notiz_lesen");
    expect(names).not.toContain("t348_weg");
    // ask_user des Servers ist verdeckt: genau einmal, als eigenes Werkzeug am Ende
    expect(names.filter((n) => n === "ask_user")).toHaveLength(1);
    expect(names.at(-1)).toBe("ask_user");
    expect(names).toEqual(expect.arrayContaining(["schedule_task", "list_scheduled_tasks", "cancel_scheduled_task"]));
  });

  test("allowedTools filtert Angebot und Ausführung, ask_user bleibt", async () => {
    fake.respond(toolReply([{ id: "w1", name: "t348_schreiben" }, { id: "l1", name: "t348_lesen", input: { n: 7 } }]));
    fake.respond(textReply("ok"));
    const r = await run({ allowedTools: ["t348_lesen"] });
    expect(fake.bodies()[0].tools.map((t: any) => t.name)).toEqual(["t348_lesen", "ask_user"]);
    const results = lastUser(fake.bodies()[1]).content;
    expect(results[0]).toMatchObject({ tool_use_id: "w1", is_error: true });
    expect(writes).toHaveLength(0);
    expect(asked).toHaveLength(0);
    expect(reads).toEqual([{ n: 7 }]);
    expect(r.isError).toBe(false);
  });

  test("Agent mit Namen der Claude-CLI: keine Registry-Werkzeuge, nur ask_user", async () => {
    fake.respond(textReply("ok"));
    await run({ allowedTools: ["Read", "WebSearch"] });
    expect(fake.lastBody().tools.map((t: any) => t.name)).toEqual(["ask_user"]);
  });

  test("MCP-Werkzeug läuft über mcpManager.callTool (lesend freigegeben), tools mit mcp__server__name", async () => {
    process.env.MCP_READ_ONLY_TOOLS = "notizen/notiz_lesen";
    fake.respond(toolReply([{ id: "m1", name: "notiz_lesen", input: { q: "x" } }]));
    fake.respond(textReply("ok"));
    const r = await run();
    expect(mcp.transports.notizen[0].calls).toEqual([{ name: "notiz_lesen", args: { q: "x" } }]);
    expect(lastUser(fake.bodies()[1]).content[0]).toEqual({ type: "tool_result", tool_use_id: "m1", content: "ok:notiz_lesen" });
    expect(r.tools?.uses).toEqual([{ name: "mcp__notizen__notiz_lesen", external: true }]);
  });

  test("Rundengrenze: Hinweis statt Fehler, Sitzung gespeichert, Verlauf mit Ergebnissen gültig", async () => {
    fake.respond(toolReply([{ id: "r1", name: "t348_lesen", input: { n: 1 } }]));
    fake.respond(toolReply([{ id: "r2", name: "t348_lesen", input: { n: 2 } }], { text: "Noch eins." }));
    const r = await run({ maxTurns: 2 });
    expect(fake.calls()).toBe(2);
    expect(r).toMatchObject({ isError: false });
    expect(r.text).toContain("Noch eins.");
    expect(r.text).toContain("2 Werkzeugrunden");
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // Das Werkzeug der letzten Runde lief nicht mehr
    expect(reads).toEqual([{ n: 1 }]);
    // Folgeturn: der Verlauf enthält das Ergebnis für r2, die neue Nachricht hängt an derselben Nutzernachricht
    fake.respond(textReply("weiter gehts"));
    await run({ prompt: "weiter", resumeSessionId: r.sessionId });
    const last = lastUser(fake.lastBody());
    expect(last.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "r2", is_error: true });
    expect(last.content.at(-1)).toEqual({ type: "text", text: "weiter" });
  });

  test("onToolStart nur bei streaming, mit Anzeigename", async () => {
    process.env.MCP_READ_ONLY_TOOLS = "notizen/notiz_lesen";
    const labels: string[] = [];
    fake.respond(toolReply([{ id: "a", name: "t348_lesen" }, { id: "b", name: "notiz_lesen" }]));
    fake.respond(textReply("ok"));
    await run({ streaming: true, onToolStart: (l) => labels.push(l) });
    expect(labels).toEqual(["Werkzeug: t348_lesen", "Werkzeug: notizen"]);
    labels.length = 0;
    fake.respond(toolReply([{ id: "c", name: "t348_lesen" }]));
    fake.respond(textReply("ok"));
    await run({ streaming: false, onToolStart: (l) => labels.push(l) });
    expect(labels).toEqual([]);
  });
});

describe("Freigaben", () => {
  const writeRound = () => {
    fake.respond(toolReply([{ id: "w1", name: "t348_schreiben", input: { was: "Datei" } }]));
    fake.respond(textReply("nach der Freigabe"));
  };

  test("erlaubt: Werkzeug läuft einmal, Frage im Gespräch des Turns", async () => {
    writeRound();
    const running = run();
    await until(() => asked.length === 1);
    expect(asked[0].conversation).toEqual({ type: "telegram", chatId: "-100200300", topicId: 5 });
    expect((await decideChoice(asked[0].id, "allow", "telegram")).status).toBe("decided");
    const r = await running;
    expect(writes).toEqual([{ was: "Datei" }]);
    expect(lastUser(fake.bodies()[1]).content[0]).toEqual({ type: "tool_result", tool_use_id: "w1", content: "geschrieben" });
    expect(r).toMatchObject({ isError: false, text: "nach der Freigabe" });
  });

  test("abgelehnt: kein Werkzeug, is_error, die Schleife läuft weiter", async () => {
    writeRound();
    const running = run();
    await until(() => asked.length === 1);
    await decideChoice(asked[0].id, "deny", "web");
    const r = await running;
    expect(writes).toHaveLength(0);
    expect(lastUser(fake.bodies()[1]).content[0]).toMatchObject({ tool_use_id: "w1", is_error: true });
    expect(r).toMatchObject({ isError: false, text: "nach der Freigabe" });
  });

  test("Frist abgelaufen: abgelehnt, kein Werkzeug", async () => {
    useApproval(30);
    writeRound();
    const r = await run();
    expect(asked).toHaveLength(1);
    expect(writes).toHaveLength(0);
    expect(lastUser(fake.bodies()[1]).content[0]).toMatchObject({ tool_use_id: "w1", is_error: true });
    expect(r.isError).toBe(false);
  });

  test("/stop während der Freigabe: aborted, kein weiterer Abruf, später erlaubt läuft trotzdem nichts", async () => {
    fake.respond(toolReply([{ id: "w1", name: "t348_schreiben" }, { id: "l1", name: "t348_lesen" }]));
    const running = run().catch((e) => ({ thrown: e }));
    await until(() => asked.length === 1);
    abortEngineCalls(KEY);
    const r = (await running) as EngineResult | { thrown: unknown };
    // runExecution meldet den Abbruch als AbortError oder der Motor als aborted
    if ("engine" in r) expect(r).toMatchObject({ aborted: true, isError: true });
    else expect((r.thrown as Error).name).toBe("AbortError");
    expect(fake.calls()).toBe(1);
    await decideChoice(asked[0].id, "allow", "telegram");
    await new Promise((res) => setTimeout(res, 20));
    expect(writes).toHaveLength(0);
    expect(reads).toHaveLength(0);
    expect(activeEngineCallCount()).toBe(0);
  });

  test("Zeitlimit während der Freigabe: timedOut, die Freigabe endet, danach läuft kein Werkzeug", async () => {
    // Langsame Antwort wie auf einer ausgelasteten Maschine: länger als jede feste kurze Frist
    fake.respondSlow(toolReply([{ id: "w1", name: "t348_schreiben" }, { id: "l1", name: "t348_lesen" }]), 100);
    // Uhr der Zeitlimits in der Hand des Tests: das Gesamtlimit feuert genau, während die Freigabe wartet,
    // nicht nach einer festen Wartezeit (unter Last kam es sonst vor der Freigabe)
    const timers: { fn: () => void; ms: number }[] = [];
    fake.use({ setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimeout: () => {} });
    const running = runExecution(KEY, "general", () => createApiEngine().run(request({ timeoutMs: 45_000 })));
    await until(() => asked.length === 1);
    const total = timers.filter((t) => t.ms === 45_000);
    expect(total).toHaveLength(1);
    total[0].fn();
    const r = await running;
    expect(r).toMatchObject({ timedOut: true, isError: true });
    expect(asked).toHaveLength(1);
    await until(() => approval.pendingCount() === 0);
    expect((await decideChoice(asked[0].id, "allow", "telegram")).status).not.toBe("decided");
    await new Promise((res) => setTimeout(res, 20));
    expect(writes).toHaveLength(0);
    expect(reads).toHaveLength(0);
    expect(fake.calls()).toBe(1);
  });
});

describe("Kosten und Verbrauch über alle Runden", () => {
  const usage1 = { start: { input_tokens: 1000, output_tokens: 1 }, end: { output_tokens: 100 } };
  const usage2 = { start: { input_tokens: 2000, cache_read_input_tokens: 500 }, end: { output_tokens: 50 } };

  test("zwei Runden: Verbrauch und Kosten summiert", async () => {
    fake.respond(toolReply([{ id: "a", name: "t348_lesen" }], { usage: usage1 }));
    fake.respond(textReply("ok", [], usage2));
    const r = await run({ model: "claude-opus-5-5" });
    expect(r.usage).toEqual({ inputTokens: 3500, cachedInputTokens: 500, outputTokens: 150 });
    // (1000*4 + 100*20) + (2000*4 + 50*20 + 500*0.4) = 6000 + 9200
    expect(r.costUsd).toBeCloseTo(0.0152, 10);
  });

  test("zweite Runde abgelehnt (HTTP 529): Kosten und Verbrauch der ersten bleiben, Werkzeug steht in tools", async () => {
    fake.respond(toolReply([{ id: "a", name: "t348_lesen" }], { usage: usage1 }));
    fake.respondStatus(529, JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } }));
    const r = await run({ model: "claude-opus-5-5" });
    expect(r).toMatchObject({ isError: true, errorKind: "capacity" });
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 100 });
    expect(r.costUsd).toBeCloseTo(0.006, 10);
    expect(r.tools?.uses).toEqual([{ name: "t348_lesen", external: true }]);
    expect(r.sessionId).toBeUndefined();
  });

  test("zweite Runde mit Fehler im Strom: Verbrauch summiert, Kosten unbekannt", async () => {
    fake.respond(toolReply([{ id: "a", name: "t348_lesen" }], { usage: usage1 }));
    fake.respond(sse({ type: "message_start", message: { usage: { input_tokens: 300 } } }) + sse({ type: "error", error: { type: "api_error", message: "kaputt" } }));
    const r = await run({ model: "claude-opus-5-5" });
    expect(r).toMatchObject({ isError: true });
    expect(r.usage).toEqual({ inputTokens: 1300, outputTokens: 100 });
    expect(r.costUsd).toBeUndefined();
  });

  test("Abbruch in der zweiten Runde: Verbrauch der ersten im Ergebnis", async () => {
    fake.respond(toolReply([{ id: "a", name: "t348_lesen" }], { usage: usage1 }));
    fake.hangAfter(sse({ type: "message_start", message: { usage: { input_tokens: 10 } } }));
    const running = createApiEngine().run(request({ model: "claude-opus-5-5" }));
    await until(() => fake.reading());
    abortEngineCalls(KEY);
    const r = await running;
    expect(r).toMatchObject({ aborted: true });
    expect(r.usage).toEqual({ inputTokens: 1010, outputTokens: 100 });
    expect(r.costUsd).toBeUndefined();
    expect(r.tools?.uses).toHaveLength(1);
  });
});

describe("Fremde Inhalte (Issue #53)", () => {
  const scrapeHost: ApiToolHost = {
    offered: () => [{ name: "firecrawl_scrape", description: "Seite holen", input_schema: { type: "object", properties: {} } }],
    call: async () => ({ content: "Seiteninhalt", isError: false }),
    serverOf: () => undefined,
  };

  test("firecrawl_scrape: classifyTurnTools meldet foreign, Merk-Tags landen im Review statt direkt", async () => {
    fake.use({ tools: scrapeHost });
    fake.respond(toolReply([{ id: "s1", name: "firecrawl_scrape", input: { url: "https://example.org" } }]));
    fake.respond(textReply("Gelesen. [REMEMBER: Die Seite sagt X]"));
    const r = await run();
    expect(classifyTurnTools(r.tools, process.cwd()).status).toBe("foreign");
    const staged: unknown[] = [];
    const applied: string[] = [];
    const outcome = await processTurnIntents(r.text, r.tools, { chatId: "-100200300", topicId: 5, origin: "Test" }, {
      stageMemoryReview: (async (input: unknown) => (staged.push(input), "rev-1")) as any,
      processIntents: async (text) => void applied.push(text),
      log: () => {},
    });
    expect(outcome).toBe("staged");
    expect(staged).toHaveLength(1);
    expect(applied).toEqual([]);
  });

  test("nur eigene Werkzeuge (list_scheduled_tasks): own, Merk-Tags direkt", async () => {
    fake.use({
      schedule: {
        store: () => ({ listAll: async () => [] }) as any,
        now: () => Date.now(),
        timeZone: () => "Europe/Berlin",
        conversation: () => ({ type: "telegram", chatId: "-100200300", topicId: 5 }),
        authorize: async () => null,
      },
    });
    fake.respond(toolReply([{ id: "p1", name: "list_scheduled_tasks" }]));
    fake.respond(textReply("Nichts geplant. [REMEMBER: Mag Ordnung]"));
    const r = await run();
    expect(r.tools?.uses).toEqual([{ name: "list_scheduled_tasks" }]);
    expect(classifyTurnTools(r.tools, process.cwd()).status).toBe("own");
    const applied: string[] = [];
    const outcome = await processTurnIntents(r.text, r.tools, { chatId: "-100200300", topicId: 5, origin: "Test" }, {
      stageMemoryReview: (async () => "nie") as any,
      processIntents: async (text) => void applied.push(text),
      log: () => {},
    });
    expect(outcome).toBe("applied");
    expect(applied).toHaveLength(1);
  });
});
