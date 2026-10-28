/**
 * Issue #314: Absicherung, bevor die Aufrufer von der Fassade auf den Store
 * wechseln. Hält fest, was ein Aufrufer sieht: genau ein Ereignis je
 * gespeicherter Nachricht mit msgId und Zeitpunkt, getrennte Topics, keine
 * Meldungen im Kontext, Leerwerte ohne Datenbank je Gruppe, Ziel- und
 * Faktenliste im Wortlaut und Fristen aus Worten.
 *
 * Alle Aufrufe laufen über CALLER; die Tabelle zeigt, welchen Weg ein
 * Aufrufer nimmt. Geschrieben gegen die Fassade convex.ts, seit deren
 * Löschung gegen den Store (dieselben Erwartungen). Kein Netz: supabase-js
 * gegen die Fetch-Attrappe.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBoardContext, formatConversationContext, loadBoardContext } from "../src/lib/conversation-context";
import { memoryContext, memoryDelta } from "../src/lib/memory/context";
import { factsList, goalsList } from "../src/lib/memory/format";
import { getStore, resetStore, storeOr } from "../src/lib/store";
import { parseDeadline } from "../src/lib/when";
import { resetSupabaseClient } from "../src/lib/supabase";
import { resetEdgeFallbackWarning } from "../src/lib/store/supabase/edge-warning";
import deadlineReference from "./fixtures/deadline-reference.json";
import { onMessageSaved, type SavedMessageEvent } from "../src/lib/store/events";
import type { Message, MemoryItem } from "../src/lib/store/types";
import { useFakeSupabase, type FakeRequest } from "./supabase-fixture";

/** Was ein Aufrufer an Speicher-Wegen benutzt (seit der Umstellung: Store, storeOr und Formatierer) */
const CALLER = {
  save: (m: Message) => storeOr(false, store => store.messages.save(m)),
  saveDisplayOnly: (m: Message) => storeOr(false, store => store.messages.saveDisplayOnly(m)),
  recent: (chatId: string, limit: number, topicId?: number | null) => storeOr([], store => store.messages.recent(chatId, limit, topicId)),
  context: async (chatId: string, limit: number, topicId?: number | null) =>
    formatConversationContext(await CALLER.recent(chatId, limit, topicId)),
  board: (days: number) => loadBoardContext(getStore().backend === "supabase" ? getStore().messages : null, days),
  search: (chatId: string, query: string, limit: number) => storeOr([], store => store.messages.search(chatId, query, limit)),
  history: (chatId: string, topicId: number | null) => storeOr([], store => store.messages.history(chatId, topicId, { limit: 20 })),
  topicActivity: (chatId: string) => storeOr([], store => store.messages.topicActivity(chatId, 7)),
  displayOnlyPage: (chatIds: string[]) => storeOr([], store => store.messages.displayOnlyPage(chatIds, { limit: 10 })),
  latestDisplayOnlyAt: (chatIds: string[]) => storeOr(null, store => store.messages.latestDisplayOnlyAt(chatIds)),
  findDisplayOnlyFile: (fileId: string, chatIds: string[]) => storeOr(null, store => store.messages.findDisplayOnlyFile(fileId, chatIds)),
  addFact: (content: string) => storeOr(false, store => store.memory.addFact(content)),
  facts: () => storeOr([], store => store.memory.facts()),
  deleteFact: (text: string) => storeOr(false, store => store.memory.deleteFact(text)),
  addGoal: (content: string, deadline?: string) =>
    storeOr(false, store => store.memory.addGoal(content, deadline ? parseDeadline(deadline) : undefined)),
  activeGoals: () => storeOr([], store => store.memory.activeGoals()),
  completeGoal: (text: string) => storeOr(false, store => store.memory.completeGoal(text)),
  cancelGoal: (text: string) => storeOr(false, store => store.memory.cancelGoal(text)),
  memoryUpdatesSince: async (sinceMs: number) => memoryDelta(await storeOr([], store => store.memory.changedSince(new Date(sinceMs)))),
  memoryContext: (message?: string) => storeOr("", store => memoryContext(store.memory, message)),
  log: () => storeOr(undefined, store => store.logs.write("info", "test", "Zeile")),
  ping: async () => (await storeOr(null, store => store.logs.ping()))?.ok ?? false,
  createTask: () => storeOr(null, store => store.tasks.create("4711", "Auftrag")),
  updateTask: () => storeOr(false, store => store.tasks.update("t-1", { status: "completed" })),
  taskById: () => storeOr(null, store => store.tasks.byId("t-1")),
  pendingTasks: () => storeOr([], store => store.tasks.pending("4711")),
  runningTasks: () => storeOr([], store => store.tasks.running("4711")),
  staleTasks: () => storeOr([], store => store.tasks.stale(2 * 60 * 60 * 1000)),
  heartbeat: () => storeOr(false, store => store.tasks.heartbeat("mac")),
  nodeStatus: () => storeOr({ online: false, lastHeartbeat: null }, store => store.tasks.nodeStatus("mac", 90_000)),
  goalsList: (goals: MemoryItem[]) => goalsList(goals),
  factsList: (facts: MemoryItem[]) => factsList(facts),
  /** Die Fristen von früher: parseRelativeDate, aufgenommen in tests/fixtures/deadline-reference.json */
  deadline: (text: string) => referenceDeadline(text),
};

/**
 * Frist, wie parseRelativeDate (bis Issue #382 in src/lib/supabase.ts) sie
 * für diese Eingabe las, in der Prozess-Zeitzone TZ zum Zeitpunkt now. Die
 * Werte stammen aus tests/fixtures/deadline-reference.json; fehlt eine
 * Kombination dort, scheitert der Test, statt zu raten. Eine Ausnahme des
 * alten Parsers wird mit Name und Meldung erneut geworfen.
 */
function referenceDeadline(input: string, zone = process.env.TZ ?? "", now = Date.now()): string | undefined {
  const index = deadlineReference.inputs.indexOf(input);
  const byNow = (deadlineReference.values as Record<string, Record<string, unknown[]>>)[zone];
  const recorded = index < 0 ? undefined : byNow?.[new Date(now).toISOString()]?.[index];
  if (recorded === undefined) throw new Error(`Keine Referenz für ${JSON.stringify(input)} in ${zone} um ${new Date(now).toISOString()}`);
  if (recorded === null) return undefined;
  if (typeof recorded === "string") return recorded;
  const { error, message } = recorded as { error: string; message: string };
  const failure = new Error(message);
  failure.name = error;
  throw failure;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DM = "4711";
const GROUP = "-1001234567890";
const TABLE_PATH = "/rest/v1/messages";
const DB_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "CONVEX_URL", "USER_TIMEZONE", "TZ"];

const cleanups: (() => void)[] = [];
let events: SavedMessageEvent[] = [];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(DB_ENV.map(name => [name, process.env[name]]));
  events = [];
  resetEdgeFallbackWarning();
  cleanups.push(onMessageSaved(e => void events.push(e)));
  const e = spyOn(console, "error").mockImplementation(() => {});
  const w = spyOn(console, "warn").mockImplementation(() => {});
  cleanups.push(() => e.mockRestore(), () => w.mockRestore());
});

afterEach(() => {
  setSystemTime();
  while (cleanups.length) cleanups.pop()!();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetSupabaseClient();
  resetStore();
});

function fake(options: Parameters<typeof useFakeSupabase>[0] = { edge: () => [] }) {
  const f = useFakeSupabase(options);
  cleanups.push(() => f.restore());
  return f;
}

/** Ohne jede Datenbank-Angabe in der Umgebung */
function withoutDatabase(): void {
  for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "CONVEX_URL"]) delete process.env[name];
  resetSupabaseClient();
  resetStore();
}

const messageReads = (requests: FakeRequest[]) => requests.filter(r => r.method === "GET" && r.url.pathname === TABLE_PATH);

describe("Nachrichten speichern, wie ein Aufrufer es sieht", () => {
  test("genau ein Ereignis je Nachricht, msgId als UUID, dieselbe wie im Request", async () => {
    const f = fake();
    expect(await CALLER.save({ chat_id: GROUP, role: "user", content: "Hallo", metadata: { topicId: 12 } })).toBe(true);
    expect(await CALLER.save({ chat_id: GROUP, role: "assistant", content: "Antwort", metadata: { topicId: 12 } })).toBe(true);
    expect(events.map(e => e.content)).toEqual(["Hallo", "Antwort"]);
    const sent = f.requests.map(r => JSON.parse(r.body).metadata.msgId);
    expect(events.map(e => e.metadata.msgId)).toEqual(sent);
    for (const id of sent) expect(id).toMatch(UUID);
  });

  test("Meldung: genau ein Ereignis, eigene msgId", async () => {
    fake();
    expect(await CALLER.saveDisplayOnly({ chat_id: DM, role: "assistant", content: "Briefing", metadata: { display_only: true } })).toBe(true);
    expect(events).toHaveLength(1);
    expect(String(events[0].metadata.msgId)).toMatch(UUID);
  });

  test("gescheitertes Speichern: false und kein Ereignis", async () => {
    fake({ respond: r => (r.method === "POST" ? Response.json({ message: "nein" }, { status: 500 }) : undefined) });
    expect(await CALLER.save({ chat_id: DM, role: "user", content: "x" })).toBe(false);
    expect(events).toHaveLength(0);
  });

  test("Zeitpunkt: gültiger vergangener bleibt, zukünftiger fällt weg", async () => {
    setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
    const f = fake({});
    await CALLER.save({ chat_id: DM, role: "user", content: "alt", created_at: "2026-10-16T11:59:00.000Z" });
    await CALLER.save({ chat_id: DM, role: "user", content: "später", created_at: "2026-10-16T13:00:00.000Z" });
    const rows = f.requests.filter(r => r.method === "POST" && r.url.pathname === TABLE_PATH).map(r => JSON.parse(r.body));
    expect(rows[0].created_at).toBe("2026-10-16T11:59:00.000Z");
    expect(rows[1]).not.toHaveProperty("created_at");
    expect(events[0].createdAt).toBe("2026-10-16T11:59:00.000Z");
    expect(events[1].createdAt).toBe("2026-10-16T12:00:00.000Z");
  });
});

describe("Kontext lesen, wie ein Aufrufer es sieht", () => {
  test("Topic-Isolation: je Topic ein eigener Session-Schlüssel in der Abfrage", async () => {
    const f = fake({ rows: () => [] });
    await CALLER.recent(GROUP, 10, 12);
    await CALLER.recent(GROUP, 10, null);
    await CALLER.recent(DM, 10, null);
    const keys = messageReads(f.requests).map(r => r.url.searchParams.get("session_key"));
    expect(keys).toEqual([`eq.topic:${GROUP}:12`, `eq.group:${GROUP}`, `eq.dm:${DM}`]);
  });

  test("Display-only-Filter: in der Abfrage und als Sicherung danach", async () => {
    const rows = [
      { id: "2", chat_id: DM, role: "assistant", content: "Meldung", metadata: { display_only: true }, created_at: "2026-10-16T11:00:00Z" },
      { id: "1", chat_id: DM, role: "user", content: "echt", metadata: {}, created_at: "2026-10-16T10:00:00Z" },
    ];
    const f = fake({ rows: () => rows });
    const found = await CALLER.recent(DM, 10, null);
    expect(found.map(m => m.content)).toEqual(["echt"]);
    expect(messageReads(f.requests)[0].url.searchParams.get("or")).toBe(
      "(metadata->>display_only.is.null,metadata->>display_only.neq.true)",
    );
    setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
    expect(await CALLER.context(DM, 10, null)).toBe("[2 hours ago] User: echt");
  });
});

describe("Leerwerte ohne Datenbank", () => {
  beforeEach(withoutDatabase);

  test("Nachrichten", async () => {
    expect(await CALLER.save({ chat_id: DM, role: "user", content: "x" })).toBe(false);
    expect(await CALLER.saveDisplayOnly({ chat_id: DM, role: "assistant", content: "x", metadata: { display_only: true } })).toBe(false);
    expect(events).toHaveLength(0);
    expect(await CALLER.recent(DM, 10, null)).toEqual([]);
    expect(await CALLER.context(DM, 10, null)).toBe("");
    expect(await CALLER.board(7)).toBe("\n\nNo conversation data available.");
    expect(await CALLER.search(DM, "frage", 5)).toEqual([]);
    expect(await CALLER.history(DM, null)).toEqual([]);
    expect(await CALLER.topicActivity(DM)).toEqual([]);
    expect(await CALLER.displayOnlyPage([DM])).toEqual([]);
    expect(await CALLER.latestDisplayOnlyAt([DM])).toBeNull();
    expect(await CALLER.findDisplayOnlyFile("f-1", [DM])).toBeNull();
  });

  test("Fakten und Ziele: seit #316 in der Datei, leer am Anfang", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-leer-"));
    const saved = process.env.MEMORY_FILE_PATH;
    process.env.MEMORY_FILE_PATH = join(dir, "memory.json");
    cleanups.push(() => {
      process.env.MEMORY_FILE_PATH = saved;
      rmSync(dir, { recursive: true, force: true });
    });
    resetStore();
    expect(getStore().backend).toBe("file");
    expect(await CALLER.facts()).toEqual([]);
    expect(await CALLER.activeGoals()).toEqual([]);
    expect(await CALLER.memoryUpdatesSince(0)).toBe("");
    expect(await CALLER.memoryContext("Frage")).toBe("");
    expect(await CALLER.deleteFact("Fakt")).toBe(false);
    expect(await CALLER.completeGoal("Ziel")).toBe(false);
    expect(await CALLER.cancelGoal("Ziel")).toBe(false);
    expect(await CALLER.addFact("Fakt")).toBe(true);
    expect(await CALLER.addGoal("Ziel", "tomorrow")).toBe(true);
    expect((await CALLER.facts()).map(f => f.content)).toEqual(["Fakt"]);
    expect((await CALLER.activeGoals()).map(g => g.content)).toEqual(["Ziel"]);
  });

  test("Aufträge und Lebenszeichen", async () => {
    expect(await CALLER.createTask()).toBeNull();
    expect(await CALLER.updateTask()).toBe(false);
    expect(await CALLER.taskById()).toBeNull();
    expect(await CALLER.pendingTasks()).toEqual([]);
    expect(await CALLER.runningTasks()).toEqual([]);
    expect(await CALLER.staleTasks()).toEqual([]);
    expect(await CALLER.heartbeat()).toBe(false);
    expect(await CALLER.nodeStatus()).toEqual({ online: false, lastHeartbeat: null });
  });

  test("Protokoll und Verbindungstest", async () => {
    expect(await CALLER.log()).toBeUndefined();
    expect(await CALLER.ping()).toBe(false);
  });
});

describe("Ziel- und Faktenliste im Wortlaut", () => {
  const goals: MemoryItem[] = [
    { type: "goal", content: "Steuer abgeben", deadline: "2026-11-01T22:59:59.000Z" },
    { type: "goal", content: "Laufen gehen" },
  ];
  const facts: MemoryItem[] = [
    { type: "fact", content: "Wohnt in Kiel" },
    { type: "fact", content: "Mag Tee" },
  ];

  test("leere Listen", () => {
    expect(CALLER.goalsList([])).toBe("No active goals.");
    expect(CALLER.factsList([])).toBe("No stored facts.");
  });

  test("Ziele nummeriert, Frist als Datum des Systems", () => {
    const due = new Date("2026-11-01T22:59:59.000Z").toLocaleDateString();
    expect(CALLER.goalsList(goals)).toBe(`1. Steuer abgeben (due: ${due})\n2. Laufen gehen`);
  });

  test("Fakten als Spiegelstriche", () => {
    expect(CALLER.factsList(facts)).toBe("- Wohnt in Kiel\n- Mag Tee");
  });
});

/**
 * Fristen aus Worten, wie parseRelativeDate sie las, bei fester Uhr
 * (Freitag, 16.10.2026, 14:00 in Berlin, Prozess und Nutzer in Berlin).
 */
const DEADLINE_CASES: [input: string, before: string][] = [
  ["today", "2026-10-16T21:59:59.000Z"],
  ["  Tomorrow ", "2026-10-17T21:59:59.000Z"],
  ["in 1 day", "2026-10-17T21:59:59.000Z"],
  ["in 3  days", "2026-10-19T21:59:59.000Z"],
  ["in 2 weeks", "2026-10-30T22:59:59.000Z"],
  ["in 1 week", "2026-10-23T21:59:59.000Z"],
  ["in 2 hours", "2026-10-16T14:00:00.000Z"],
  ["in 1 hour", "2026-10-16T13:00:00.000Z"],
  ["17:30", "2026-10-16T15:30:00.000Z"],
  ["9:15", "2026-10-17T07:15:00.000Z"],
  ["17", "2026-10-16T15:00:00.000Z"],
  ["9", "2026-10-17T07:00:00.000Z"],
  ["14", "2026-10-16T12:00:00.000Z"],
  ["14:00", "2026-10-16T12:00:00.000Z"],
  ["2pm", "2026-10-16T12:00:00.000Z"],
  ["5pm", "2026-10-16T15:00:00.000Z"],
  ["5 PM", "2026-10-16T15:00:00.000Z"],
  ["5:30pm", "2026-10-16T15:30:00.000Z"],
  ["11am", "2026-10-17T09:00:00.000Z"],
  ["12am", "2026-10-16T22:00:00.000Z"],
  ["12pm", "2026-10-17T10:00:00.000Z"],
  ["13pm", "2026-10-17T11:00:00.000Z"],
  ["0am", "2026-10-16T22:00:00.000Z"],
  ["25", "2026-10-16T23:00:00.000Z"],
  ["2026-11-01T09:00", "2026-11-01T08:00:00.000Z"],
  ["2026-11-01T09:00:00Z", "2026-11-01T09:00:00.000Z"],
  ["2026-11-01T09:00:00.000Z", "2026-11-01T09:00:00.000Z"],
  ["2026-11-01T09:00+05:00", "2026-11-01T04:00:00.000Z"],
  ["2026-11-01", "2026-11-01T00:00:00.000Z"],
  ["Nov 1, 2026", "2026-10-31T23:00:00.000Z"],
  ["November 1 2026", "2026-10-31T23:00:00.000Z"],
  ["December 24, 2026", "2026-12-23T23:00:00.000Z"],
  ["12/24/2026", "2026-12-23T23:00:00.000Z"],
];

/** Fester Bezugspunkt: Freitag, 16.10.2026, 14:00 in Berlin */
const DEADLINE_NOW = new Date("2026-10-16T12:00:00.000Z");

/**
 * Bezugspunkte für den Vergleich mit parseRelativeDate: gewöhnlicher Tag,
 * eine halbe Stunde vor dem Ende der Sommerzeit in Europa (25.10.2026,
 * 03:00 Sommerzeit wird 02:00) und in New York (1.11.2026), kurz vor ihrem
 * Beginn in Europa (29.3.2026) und eine volle Stunde (exakt erreichte Uhrzeit).
 */
const DEADLINE_NOWS = [
  DEADLINE_NOW,
  new Date("2026-10-25T00:30:00.000Z"),
  new Date("2026-11-01T05:30:00.000Z"),
  new Date("2026-03-29T00:30:00.000Z"),
  new Date("2026-10-16T15:00:00.000Z"),
];

/** Eingaben für den Vergleich: alle Fälle oben und Uhrzeiten, die an einem Bezugspunkt genau erreicht sind */
const DEADLINE_INPUTS = [
  ...DEADLINE_CASES.map(([input]) => input),
  "in 5 hours", "in 30 hours", "11", "1", "2", "1am", "2am", "3am", "17:00", "11:00", "5:00 pm", "17:75",
  "2026-03-29", "2026-10-25", "2026-10-25T02:30", "Oct 25, 2026", "3/29/2026", "irgendwann", "", "13:5",
];

/** Zeitzonen von Prozess (TZ) und Nutzer (USER_TIMEZONE, undefined: nicht gesetzt) */
const ZONE_PAIRS: [processZone: string, userZone: string | undefined][] = [
  ["Europe/Berlin", undefined],
  ["Europe/Berlin", "Europe/Berlin"],
  ["UTC", undefined],
  ["UTC", "Europe/Berlin"],
  ["Europe/Berlin", "America/New_York"],
  ["America/New_York", undefined],
  ["America/New_York", "Asia/Kolkata"],
  ["Asia/Kolkata", "UTC"],
];

function useZones(processZone: string, userZone: string | undefined): void {
  process.env.TZ = processZone;
  if (userZone === undefined) delete process.env.USER_TIMEZONE;
  else process.env.USER_TIMEZONE = userZone;
}

describe("Fristen aus Worten (Stand vor der Umstellung, parseRelativeDate)", () => {
  for (const [input, before] of DEADLINE_CASES) {
    test(JSON.stringify(input), () => {
      useZones("Europe/Berlin", "Europe/Berlin");
      setSystemTime(DEADLINE_NOW);
      expect(CALLER.deadline(input)).toBe(before);
    });
  }

  test("ohne Text keine Frist", () => {
    useZones("Europe/Berlin", "Europe/Berlin");
    setSystemTime(DEADLINE_NOW);
    expect(CALLER.deadline("")).toBeUndefined();
    expect(CALLER.deadline("irgendwann")).toBeUndefined();
  });

  test("Nachweise des Prüfers: reines Datum unter UTC, Stunden über das Ende der Sommerzeit", () => {
    useZones("UTC", undefined);
    setSystemTime(DEADLINE_NOW);
    expect(CALLER.deadline("2026-11-01")).toBe("2026-11-01T00:00:00.000Z");
    useZones("Europe/Berlin", undefined);
    setSystemTime(new Date("2026-10-25T00:30:00.000Z"));
    expect(CALLER.deadline("in 2 hours")).toBe("2026-10-25T03:30:00.000Z");
  });
});

/** Frist, die memory.addGoal über Supabase in den Insert schreibt */
async function deadlineViaSupabase(input: string): Promise<string | undefined> {
  const f = fake({});
  const { addGoal } = await import("../src/lib/memory");
  expect(await addGoal("Ziel", input)).toBe(true);
  const insert = f.requests.find(r => r.method === "POST" && r.url.pathname === "/rest/v1/memory");
  return JSON.parse(insert!.body).deadline;
}

/**
 * Fristen über die lokale Datei, in einem eigenen Prozess mit MEMORY_FILE_PATH
 * und den Zeitzonen aus der Umgebung. Je Bezugspunkt und Eingabe: [neu, alt].
 */
function deadlinesViaLocalFile(processZone: string, userZone: string | undefined, nows: Date[], inputs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "tybo-fristen-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "memory.json");
  const script = `import { setSystemTime } from "bun:test";
const { addGoal } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/memory/index.ts"))});
for (const now of ${JSON.stringify(nows.map(n => n.toISOString()))}) {
  setSystemTime(new Date(now));
  for (const input of ${JSON.stringify(inputs)}) await addGoal("Ziel " + input, input);
}
const { Database } = await import("bun:sqlite");
const row = new Database(${JSON.stringify(file + ".sqlite")}).query("SELECT value FROM state").get();
const { goals } = JSON.parse(row.value);
process.stdout.write(JSON.stringify(goals.map(g => g.deadline ?? null)));`;
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: dir, MEMORY_FILE_PATH: file, TZ: processZone };
  if (userZone !== undefined) env.USER_TIMEZONE = userZone;
  const proc = Bun.spawnSync(["bun", "-e", script], { cwd: dir, env });
  expect(proc.stderr.toString()).toBe("");
  const after = JSON.parse(proc.stdout.toString()) as (string | null)[];
  const before = nows.flatMap(now => inputs.map(input => referenceDeadline(input, processZone, now.getTime()) ?? null));
  return after.map((value, i) => [value, before[i]] as [after: string | null, before: string | null]);
}

/**
 * Fristen über Supabase in einem eigenen Prozess, der mit TZ und
 * USER_TIMEZONE aus der Umgebung startet; je Bezugspunkt und Eingabe die
 * Frist im Insert, null ohne Frist. Ein eigener Prozess, weil sich die
 * Zeitzone im Testprozess nicht verlässlich umstellen lässt: Unter bun 1.3
 * (CI) bleibt sie nach einem `delete process.env.TZ`, etwa im afterEach
 * dieser oder einer früheren Testdatei, für den Rest des Prozesses stehen.
 */
function deadlinesViaSupabase(processZone: string, userZone: string | undefined, nows: Date[], inputs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "tybo-fristen-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = `import { setSystemTime } from "bun:test";
const { useFakeSupabase } = await import(${JSON.stringify(join(import.meta.dir, "supabase-fixture.ts"))});
const { addGoal } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/memory/index.ts"))});
const deadlines = [];
for (const now of ${JSON.stringify(nows.map(n => n.toISOString()))}) {
  setSystemTime(new Date(now));
  for (const input of ${JSON.stringify(inputs)}) {
    const f = useFakeSupabase({});
    const saved = await addGoal("Ziel", input);
    const insert = f.requests.find(r => r.method === "POST" && r.url.pathname === "/rest/v1/memory");
    f.restore();
    if (saved !== true || !insert) throw new Error("kein Insert für " + JSON.stringify(input));
    deadlines.push(JSON.parse(insert.body).deadline ?? null);
  }
}
process.stdout.write(JSON.stringify(deadlines));`;
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: dir, MEMORY_FILE_PATH: join(dir, "memory.json"), TZ: processZone };
  if (userZone !== undefined) env.USER_TIMEZONE = userZone;
  const proc = Bun.spawnSync(["bun", "-e", script], { cwd: dir, env });
  expect(proc.stderr.toString()).toBe("");
  return JSON.parse(proc.stdout.toString()) as (string | null)[];
}

/** Relative Fristen, die kein gültiges Datum ergeben: parseRelativeDate warf (toISOString) */
const HUGE_DEADLINES = ["in 99999999999 days", "in 99999999999 hours", "in 99999999999 weeks"];

/** Fehler als vergleichbarer Wert */
const errorOf = (e: unknown) => ({ name: (e as Error).name, message: (e as Error).message });

function thrown(run: () => unknown): { name: string; message: string } | null {
  try {
    run();
    return null;
  } catch (e) {
    return errorOf(e);
  }
}

describe("Fristen über memory.addGoal wie parseRelativeDate (Issue #314)", () => {
  beforeEach(() => useZones("Europe/Berlin", "Europe/Berlin"));

  test("Supabase, Prozess und Nutzer in Berlin: die Fristen der Tabelle oben", () => {
    const stored = deadlinesViaSupabase("Europe/Berlin", "Europe/Berlin", [DEADLINE_NOW], DEADLINE_CASES.map(([input]) => input));
    expect(DEADLINE_CASES.map(([input], i) => [input, stored[i]])).toEqual(DEADLINE_CASES);
  });

  test("Supabase, Nachweise des Prüfers: reines Datum unter UTC, Stunden über das Ende der Sommerzeit", () => {
    expect(deadlinesViaSupabase("UTC", "UTC", [DEADLINE_NOW], ["2026-11-01"])).toEqual(["2026-11-01T00:00:00.000Z"]);
    const shift = new Date("2026-10-25T00:30:00.000Z");
    expect(deadlinesViaSupabase("Europe/Berlin", "Europe/Berlin", [shift], ["in 2 hours"])).toEqual(["2026-10-25T03:30:00.000Z"]);
  });

  for (const [processZone, userZone] of ZONE_PAIRS) {
    test(`Supabase gleich parseRelativeDate: Prozess ${processZone}, Nutzer ${userZone ?? "nicht gesetzt"}`, () => {
      // ohne Text ruft addGoal keine Frist ab, siehe unten
      const inputs = DEADLINE_INPUTS.filter(Boolean);
      const stored = deadlinesViaSupabase(processZone, userZone, DEADLINE_NOWS, inputs);
      const cases = DEADLINE_NOWS.flatMap(now => inputs.map(input => ({ now: now.toISOString(), input })));
      expect(cases.map((c, i) => ({ ...c, after: stored[i] }))).toEqual(
        cases.map(c => ({ ...c, after: referenceDeadline(c.input, processZone, Date.parse(c.now)) ?? null })),
      );
    });
  }

  test("unlesbare oder leere Frist: Ziel ohne Frist", async () => {
    expect(await deadlineViaSupabase("irgendwann")).toBeUndefined();
    expect(await deadlineViaSupabase("")).toBeUndefined();
  });

  test("übergroße Frist, Supabase: wirft wie parseRelativeDate, kein Insert", async () => {
    setSystemTime(DEADLINE_NOW);
    const { addGoal } = await import("../src/lib/memory");
    for (const input of HUGE_DEADLINES) {
      const f = fake({});
      const before = thrown(() => referenceDeadline(input));
      expect(before).toEqual({ name: "RangeError", message: expect.any(String) });
      expect({ input, after: await addGoal("Ziel", input).then(() => null, errorOf) }).toEqual({ input, after: before });
      expect(f.requests.filter(r => r.url.pathname === "/rest/v1/memory")).toEqual([]);
    }
  });

  test("übergroße Frist, lokale Datei: wirft wie parseRelativeDate, kein Ziel gespeichert", () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-fristen-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "memory.json");
    const script = `const { addGoal } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/memory/index.ts"))});
const thrown = e => ({ name: e.name, message: e.message });
await addGoal("Vorher");
const results = [];
for (const input of ${JSON.stringify(HUGE_DEADLINES)}) {
  const after = await addGoal("Ziel " + input, input).then(() => null, thrown);
  results.push(after);
}
const { Database } = await import("bun:sqlite");
const row = new Database(${JSON.stringify(file + ".sqlite")}).query("SELECT value FROM state").get();
process.stdout.write(JSON.stringify({ results, goals: JSON.parse(row.value).goals.map(g => g.text) }));`;
    const env = { PATH: process.env.PATH ?? "", HOME: dir, MEMORY_FILE_PATH: file, TZ: "Europe/Berlin", USER_TIMEZONE: "Europe/Berlin" };
    const proc = Bun.spawnSync(["bun", "-e", script], { cwd: dir, env });
    expect(proc.stderr.toString()).toBe("");
    const { results, goals } = JSON.parse(proc.stdout.toString());
    expect(results).toHaveLength(HUGE_DEADLINES.length);
    // Der alte Parser warf bei diesen Eingaben unabhängig vom Zeitpunkt
    HUGE_DEADLINES.forEach((input, i) => {
      const before = thrown(() => referenceDeadline(input, "Europe/Berlin", DEADLINE_NOW.getTime()));
      expect(before).toEqual({ name: "RangeError", message: expect.any(String) });
      expect(results[i]).toEqual(before);
    });
    expect(goals).toEqual(["Vorher"]);
  });

  test("deutsche Frist, die parseRelativeDate nicht las: parseWhen in der Zeitzone des Nutzers", async () => {
    useZones("UTC", "Europe/Berlin");
    setSystemTime(DEADLINE_NOW);
    expect(referenceDeadline("morgen", "UTC")).toBeUndefined();
    expect(await deadlineViaSupabase("morgen")).toBe("2026-10-17T21:59:59.000Z");
  });

  test("lokale Datei, Prozess und Nutzer in Berlin: dieselben Fristen wie oben", () => {
    const stored = deadlinesViaLocalFile("Europe/Berlin", "Europe/Berlin", [DEADLINE_NOW], DEADLINE_CASES.map(([input]) => input));
    expect(stored.map(([after]) => after)).toEqual(DEADLINE_CASES.map(([, before]) => before));
  });

  for (const [processZone, userZone] of ZONE_PAIRS) {
    test(`lokale Datei gleich parseRelativeDate: Prozess ${processZone}, Nutzer ${userZone ?? "nicht gesetzt"}`, () => {
      const inputs = DEADLINE_INPUTS.filter(Boolean);
      const stored = deadlinesViaLocalFile(processZone, userZone, DEADLINE_NOWS, inputs);
      expect(stored).toHaveLength(DEADLINE_NOWS.length * inputs.length);
      for (const [after, before] of stored) expect(after).toBe(before);
    });
  }
});

describe("/board-Kontext (loadBoardContext, Gateway)", () => {
  test("ohne Datenbank: fester Hinweis", async () => {
    expect(await loadBoardContext(null, 7)).toBe("\n\nNo conversation data available.");
  });

  test("Laden wirft: eigener Hinweis statt Fehler", async () => {
    const failing = { boardRows: async () => Promise.reject(new Error("weg")) };
    expect(await loadBoardContext(failing, 7)).toBe("\n\nFailed to load conversation context.");
  });

  test("Zeilen: dasselbe Format wie formatBoardContext", async () => {
    const rows = [{ role: "user" as const, content: "Frage", metadata: null, created_at: "2026-10-16T10:00:00Z" }];
    expect(await loadBoardContext({ boardRows: async () => rows }, 7)).toBe(formatBoardContext(rows, 7));
  });
});

describe("CONVEX_URL neben gültigem Supabase (Entscheidung E1)", () => {
  test("Speichern und Lesen gehen an Supabase, nicht an Convex", async () => {
    const f = fake();
    process.env.CONVEX_URL = "https://beispiel.convex.cloud";
    resetStore();
    expect(getStore().backend).toBe("supabase");
    expect(await CALLER.save({ chat_id: DM, role: "user", content: "Hallo" })).toBe(true);
    await CALLER.recent(DM, 5, null);
    expect(events).toHaveLength(1);
    expect(f.requests.every(r => r.url.origin === "http://supabase.test")).toBe(true);
    expect(f.requests.map(r => r.url.pathname)).toEqual(["/functions/v1/store-telegram-message", TABLE_PATH]);
  });
});
