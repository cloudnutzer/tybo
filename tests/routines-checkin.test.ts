/**
 * Check-in als Routine (Issue #364): Regeln im Code vor dem Modell,
 * Entscheidung über das Aux-Modell mit JSON, Versand über den Kern der
 * proaktiven Meldungen mit Knöpfen aus dem Rückfragen-Register.
 *
 * Echter Kern-Zustand und echtes Register in Temp-Dateien; Uhr, Verlauf,
 * Ziele, Modell und Versand sind Attrappen. Der Block „Echter Speicher"
 * liest über den echten Store mit einer fetch-Attrappe statt Supabase. Kein
 * Netz, kein Modell, kein launchd, src/bot.ts wird weder gestartet noch
 * importiert.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { attachChoiceTelegram, expireChoice, setChoicesFileForTests } from "../src/lib/choices";
import type { SendAndRecordInput } from "../src/lib/outbox";
import { openProactiveChoice } from "../src/lib/proactive/choices";
import type { ProactiveChoiceRegister } from "../src/lib/proactive/deliver";
import { legacyPaths } from "../src/lib/proactive/migrate";
import { readProactiveState, snoozeKind } from "../src/lib/proactive/state";
import type { Source } from "../src/lib/sources/types";
import { resetStore } from "../src/lib/store";
import type { BoardRow } from "../src/lib/store/types";
import { resetSupabaseClient } from "../src/lib/supabase";
import {
  ACTIVE_MINUTES,
  CALL_OFFER_PREFIX,
  checkinPrompt,
  MAX_MESSAGE_CHARS,
  messageFor,
  parseCheckinArgs,
  readDecision,
  runCheckin,
  CHECKIN_DISABLED_REASON,
  type CheckinFacts,
  type CheckinRunDeps,
} from "../src/routines/checkin";

const USER = "4711";
const ENV = { USER_TIMEZONE: "Europe/Berlin", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_USER_ID: USER };
const MIN = 60_000;
// 12:00 UTC = 14:00 in Berlin: im Zeitfenster des Check-ins (10 bis 19 Uhr), außerhalb der Ruhezeit
const NOON = Date.parse("2026-10-19T12:00:00.000Z");
// 21:30 UTC = 23:30 in Berlin: Ruhezeit
const NIGHT = Date.parse("2026-10-19T21:30:00.000Z");
const LONG_AGO = new Date(NOON - 6 * 60 * MIN).toISOString();

const base = mkdtempSync(join(tmpdir(), "tybo-routine-checkin-"));
let counter = 0;
let dir = "";
let statePath = "";
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let lines: string[] = [];

beforeEach(() => {
  dir = join(base, `case-${++counter}`);
  statePath = join(dir, "data", "proactive-state.json");
  setChoicesFileForTests(join(dir, "data", "choices.json"));
  lines = [];
  logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

/** Echtes Register wie in deliver.ts; Anrufen-Knopf nur mit eingerichteten Anrufen */
const registerFor = (callAvailable: boolean): ProactiveChoiceRegister => ({
  create: (kind, text) => openProactiveChoice(kind, text, { env: ENV, callAvailable }),
  attach: attachChoiceTelegram,
  expire: expireChoice,
  refresh: async () => {},
});

function outbox(mode: "telegram" | "web" | "fail" = "telegram") {
  const sent: SendAndRecordInput[] = [];
  let id = 900;
  const send = async (input: SendAndRecordInput) => {
    sent.push(input);
    if (mode === "fail") return { sent: false, recorded: false, error: { kind: "send" as const, message: "weg", rejected: true as const } };
    if (mode === "web") return { sent: false, recorded: true };
    return { sent: true, recorded: true, messages: [{ chatId: USER, messageId: ++id, part: "text" as const, buttons: true }] };
  };
  return { sent, send };
}

const goalsOk: Source = {
  id: "goals",
  label: "Ziele",
  ready: () => true,
  collect: async () => ({ items: [{ text: "Steuererklärung abgeben", due: "2026-10-20" }] }),
};

/** Attrappen eines Laufs; zählt Modell- und Verlaufsaufrufe */
function rig(o: {
  answer?: string | (() => Promise<{ text: string; isError: boolean }>);
  last?: string | null | (() => Promise<string | null>);
  mode?: "telegram" | "web" | "fail";
  callAvailable?: boolean;
  clock?: number;
  goals?: Source;
  recent?: BoardRow[];
} = {}) {
  const box = outbox(o.mode);
  const prompts: string[] = [];
  let historyReads = 0;
  const callAvailable = o.callAvailable ?? false;
  const answer = o.answer ?? '{"action": "text", "message": "Wie weit ist die Steuererklärung?"}';
  const deps: CheckinRunDeps = {
    now: () => new Date(o.clock ?? NOON),
    env: ENV,
    settings: {},
    statePath,
    legacy: null,
    renewMs: 0,
    choices: registerFor(callAvailable),
    send: box.send,
    wait: async () => {},
    lastUserMessageAt: async () => {
      historyReads++;
      const last = o.last === undefined ? LONG_AGO : o.last;
      return typeof last === "function" ? last() : last;
    },
    recentRows: async () => o.recent ?? [],
    goals: o.goals ?? goalsOk,
    profile: async () => "",
    callAvailable: () => callAvailable,
    aux: async prompt => {
      prompts.push(prompt);
      return typeof answer === "function" ? answer() : { text: answer, isError: false };
    },
  };
  return { deps, box, prompts, historyReads: () => historyReads };
}

async function lastSentAt(): Promise<string | undefined> {
  return (await readProactiveState(statePath)).checkin.lastSentAt;
}

function writeState(checkin: Record<string, unknown>) {
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ briefing: {}, checkin: { pendingItems: [], ...checkin }, imported: {} }));
}

describe("Regeln vor dem Modell", () => {
  test("Ruhezeit: kein Modellaufruf, kein Verlauf, nichts gesendet, Exit 0", async () => {
    const r = rig({ clock: NIGHT });
    expect(await runCheckin(r.deps)).toBe(0);
    expect(r.prompts).toEqual([]);
    expect(r.historyReads()).toBe(0);
    expect(r.box.sent).toEqual([]);
    expect(lines).toContain("[checkin] skipped (quiet)");
  });

  test("Abstand: 30 Minuten nach dem letzten Check-in kein Modellaufruf, nach 90 Minuten wieder", async () => {
    writeState({ lastSentAt: new Date(NOON - 30 * MIN).toISOString(), lastDate: "2026-10-19" });
    const early = rig();
    expect(await runCheckin(early.deps)).toBe(0);
    expect(early.prompts).toEqual([]);
    expect(early.box.sent).toEqual([]);
    expect(lines).toContain("[checkin] skipped (gap)");

    const later = rig({ clock: NOON + 60 * MIN });
    expect(await runCheckin(later.deps)).toBe(0);
    expect(later.prompts).toHaveLength(1);
    expect(later.box.sent).toHaveLength(1);
  });

  test("Snooze: kein Modellaufruf bis zum Ende, danach wieder", async () => {
    await snoozeKind(statePath, "checkin", new Date(NOON + 30 * MIN));
    const snoozed = rig();
    expect(await runCheckin(snoozed.deps)).toBe(0);
    expect(snoozed.prompts).toEqual([]);
    expect(snoozed.box.sent).toEqual([]);
    expect(lines).toContain("[checkin] skipped (snoozed)");

    const after = rig({ clock: NOON + 30 * MIN });
    expect(await runCheckin(after.deps)).toBe(0);
    expect(after.box.sent).toHaveLength(1);
  });

  test("Snooze während der Modellauswertung: nichts gesendet, keine Versandzeit, Exit 0", async () => {
    const r = rig({
      answer: async () => {
        await snoozeKind(statePath, "checkin", new Date(NOON + 30 * MIN));
        return { text: '{"action": "text", "message": "Hallo"}', isError: false };
      },
    });
    expect(await runCheckin(r.deps)).toBe(0);
    expect(r.prompts).toHaveLength(1);
    expect(r.box.sent).toEqual([]);
    expect(await lastSentAt()).toBeUndefined();
    expect((await readProactiveState(statePath)).checkin.claim).toBeUndefined();
  });

  test("abgeschaltet in den Einstellungen: kein Modellaufruf", async () => {
    const r = rig();
    expect(await runCheckin({ ...r.deps, settings: { proactive: { checkin: { enabled: false } } } })).toBe(0);
    expect(r.prompts).toEqual([]);
    expect(r.historyReads()).toBe(0);
  });

  test(`Nutzer schreibt gerade (jünger als ${ACTIVE_MINUTES} Minuten): kein Modellaufruf, keine Versandzeit`, async () => {
    const r = rig({ last: new Date(NOON - 10 * MIN).toISOString() });
    expect(await runCheckin(r.deps)).toBe(0);
    expect(r.prompts).toEqual([]);
    expect(r.box.sent).toEqual([]);
    expect(await lastSentAt()).toBeUndefined();
    expect(lines).toContain("[checkin] keine Meldung (Nutzer aktiv)");
    expect(lines).toContain("[checkin] skipped (nothing)");
  });

  test("genau an der Grenze zählt der Nutzer nicht mehr als aktiv", async () => {
    const r = rig({ last: new Date(NOON - ACTIVE_MINUTES * MIN).toISOString() });
    expect(await runCheckin(r.deps)).toBe(0);
    expect(r.prompts).toHaveLength(1);
  });

  test("zwei gleichzeitige Läufe: ein Modellaufruf, eine Meldung", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const first = rig({
      answer: async () => {
        await gate;
        return { text: '{"action": "text", "message": "Hallo"}', isError: false };
      },
    });
    const second = rig();
    const running = runCheckin(first.deps);
    // Warten, bis der erste Lauf reserviert hat und beim Modell ist
    while (first.prompts.length === 0) await Bun.sleep(5);
    expect(await runCheckin(second.deps)).toBe(0);
    expect(second.prompts).toEqual([]);
    expect(lines).toContain("[checkin] skipped (busy)");
    release();
    expect(await running).toBe(0);
    expect(first.box.sent.length + second.box.sent.length).toBe(1);
  });
});

describe("Letzte Nutzernachricht", () => {
  test("Abruffehler: kein Modellaufruf, nichts gesendet, Exit 1", async () => {
    const r = rig({ last: async () => { throw new Error("Datenbank weg"); } });
    expect(await runCheckin(r.deps)).toBe(1);
    expect(r.prompts).toEqual([]);
    expect(r.box.sent).toEqual([]);
    expect(await lastSentAt()).toBeUndefined();
    expect(lines.some(l => l.includes("[checkin] history: Verlauf nicht lesbar"))).toBe(true);
    // Fehlertext des Speichers kommt nicht ins Log
    expect(lines.some(l => l.includes("Datenbank weg"))).toBe(false);
  });

  test("ungültige Zeit: kein Modellaufruf, Exit 1, keine Ersatzzeit", async () => {
    const r = rig({ last: "gestern irgendwann" });
    expect(await runCheckin(r.deps)).toBe(1);
    expect(r.prompts).toEqual([]);
    expect(r.box.sent).toEqual([]);
  });

  test("noch nie geschrieben (kein Verlauf): Modell erfährt „noch keine“", async () => {
    const r = rig({ last: null });
    expect(await runCheckin(r.deps)).toBe(0);
    expect(r.prompts[0]).toContain("Letzte Nachricht des Nutzers: noch keine");
  });

  test("echte Zeit geht ins Modell, alte Zeitstempel der früheren Zustandsdatei nicht", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "checkin-state.json"), JSON.stringify({ lastMessageTime: "2026-04-01T08:00:00.000Z", pendingItems: [] }));
    const r = rig({ last: new Date(NOON - 3 * 60 * MIN).toISOString() });
    expect(await runCheckin({ ...r.deps, legacy: { ...legacyPaths(dir), settings: join(dir, "config", "settings.json") } })).toBe(0);
    expect((await readProactiveState(statePath)).imported.checkinState).toBeString();
    expect(r.prompts[0]).toContain("Letzte Nachricht des Nutzers: vor 3 Stunden");
  });

  test("Ziele nicht lesbar: kein Modellaufruf, Exit 1", async () => {
    const broken: Source = { ...goalsOk, collect: async () => { throw new Error("weg"); } };
    const r = rig({ goals: broken });
    expect(await runCheckin(r.deps)).toBe(1);
    expect(r.prompts).toEqual([]);
    expect(r.box.sent).toEqual([]);
  });

  test("Beiträge nicht lesbar: kein Modellaufruf, Exit 1", async () => {
    const r = rig();
    r.deps.recentRows = async () => { throw new Error("weg"); };
    expect(await runCheckin(r.deps)).toBe(1);
    expect(r.prompts).toEqual([]);
  });
});

describe("Echter Speicher (Supabase per fetch-Attrappe)", () => {
  const URL_BASE = "http://supabase.test";
  const VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MEMORY_FILE_PATH", "GO_PROJECT_ROOT", "CONVEX_URL"];
  let savedVars: Record<string, string | undefined> = {};
  let realFetch: typeof fetch;
  let failing: "board" | "goals" | "none" = "board";
  let requests: string[] = [];

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const dbError = () => reply({ code: "XX000", message: "Datenbank weg", details: null, hint: null }, 500);

  beforeEach(() => {
    savedVars = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
    for (const k of VARS) delete process.env[k];
    process.env.SUPABASE_URL = URL_BASE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_attrappe123";
    process.env.GO_PROJECT_ROOT = dir;
    resetSupabaseClient();
    resetStore();
    requests = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== URL_BASE) return new Response("kein Netz im Test", { status: 599 });
      const select = url.searchParams.get("select") ?? "";
      if (url.pathname === "/rest/v1/messages" && select === "created_at") {
        requests.push("last");
        return reply([{ created_at: LONG_AGO }]);
      }
      if (url.pathname === "/rest/v1/messages") {
        requests.push("board");
        return failing === "board" ? dbError() : reply([]);
      }
      if (url.pathname === "/rest/v1/memory") {
        requests.push("goals");
        return failing === "goals" ? dbError() : reply([]);
      }
      return reply([]);
    }, { preconnect: realFetch.preconnect }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of VARS) {
      if (savedVars[k] === undefined) delete process.env[k];
      else process.env[k] = savedVars[k];
    }
    resetSupabaseClient();
    resetStore();
  });

  /** rig mit den Standard-Lesern des Speichers statt der Attrappen */
  function storeRig() {
    const r = rig();
    delete r.deps.lastUserMessageAt;
    delete r.deps.recentRows;
    delete r.deps.goals;
    return r;
  }

  test("Beitragsabfrage mit Datenbankfehler nach gelesener Nutzernachricht: Exit 1, kein Modell, kein Versand, Versandzeit bleibt", async () => {
    failing = "board";
    const before = new Date(NOON - 5 * 60 * MIN).toISOString();
    writeState({ lastSentAt: before, lastDate: "2026-10-19" });
    const r = storeRig();
    expect(await runCheckin(r.deps)).toBe(1);
    expect(requests).toEqual(["last", "goals", "board"]);
    expect(r.prompts).toEqual([]);
    expect(r.box.sent).toEqual([]);
    expect(await lastSentAt()).toBe(before);
    expect(lines.some(l => l.includes("[checkin] history: Beiträge nicht lesbar"))).toBe(true);
  });

  test("Supabase-Ziele scheitern, alte lokale Ziele vorhanden: kein Rückfall, Exit 1, kein Modell, kein Versand", async () => {
    failing = "goals";
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "memory.json");
    writeFileSync(file, JSON.stringify({ facts: [], goals: [{ text: "Altes Ziel", createdAt: "2026-01-01T08:00:00.000Z" }], completedGoals: [] }));
    process.env.MEMORY_FILE_PATH = file;
    const r = storeRig();
    expect(await runCheckin(r.deps)).toBe(1);
    expect(requests).toEqual(["last", "goals"]);
    expect(r.prompts).toEqual([]);
    expect(r.box.sent).toEqual([]);
    expect(await lastSentAt()).toBeUndefined();
    expect(lines.some(l => l.includes("[checkin] goals: Ziele nicht lesbar"))).toBe(true);
  });

  test("Gegenprobe: beide Abfragen gelingen, dann entscheidet das Modell", async () => {
    failing = "none";
    const r = storeRig();
    expect(await runCheckin(r.deps)).toBe(0);
    expect(requests).toEqual(["last", "goals", "board"]);
    expect(r.prompts).toHaveLength(1);
    expect(r.box.sent).toHaveLength(1);
  });
});

describe("Entscheidung des Aux-Modells", () => {
  const broken: [string, string | (() => Promise<{ text: string; isError: boolean }>)][] = [
    ["kein JSON", "Ich würde mich melden."],
    ["abgeschnittenes JSON", '{"action": "text", "message": "Hal'],
    ["unbekannte Aktion", '{"action": "mail", "message": "Hallo"}'],
    ["Aktion in Großbuchstaben", '{"action": "TEXT", "message": "Hallo"}'],
    ["leere Nachricht", '{"action": "text", "message": "   "}'],
    ["Nachricht kein Text", '{"action": "text", "message": 42}'],
    ["Anruf ohne Nachricht", '{"action": "call"}'],
    ["zu lange Nachricht", JSON.stringify({ action: "text", message: "a".repeat(MAX_MESSAGE_CHARS + 1) })],
    ["Modellfehler", async () => ({ text: "", isError: true })],
    ["Zeitlimit", async () => ({ text: "", isError: true })],
  ];
  test("Nebenaufgabe abgeschaltet (Issue #566, Claude fehlt): nichts gesendet, Exit 0, keine Fehlerzeile", async () => {
    const r = rig({ answer: async () => ({ text: "", isError: true, disabled: true }) as { text: string; isError: boolean } });
    expect(await runCheckin(r.deps)).toBe(0);
    expect(r.box.sent).toEqual([]);
    expect(r.prompts.length).toBe(1);
    expect(lines).toContain(`[checkin] keine Meldung (${CHECKIN_DISABLED_REASON})`);
    expect(lines.some(l => l.includes("failed"))).toBe(false);
  });

  for (const [name, answer] of broken) {
    test(`${name}: nichts gesendet, keine Versandzeit, Exit 1, nächster Lauf nicht blockiert`, async () => {
      const r = rig({ answer });
      expect(await runCheckin(r.deps)).toBe(1);
      expect(r.box.sent).toEqual([]);
      expect(await lastSentAt()).toBeUndefined();
      expect((await readProactiveState(statePath)).checkin.claim).toBeUndefined();
      expect(lines).toContain("[checkin] failed (compose)");
      const next = rig();
      expect(await runCheckin(next.deps)).toBe(0);
      expect(next.box.sent).toHaveLength(1);
    });
  }

  test("none: nichts gesendet, keine Versandzeit, Exit 0", async () => {
    const r = rig({ answer: '{"action": "none", "message": ""}' });
    expect(await runCheckin(r.deps)).toBe(0);
    expect(r.box.sent).toEqual([]);
    expect(await lastSentAt()).toBeUndefined();
    expect(lines).toContain("[checkin] skipped (nothing)");
  });

  test("text: Meldung mit Quelle checkin und den Knöpfen Erledigt und 30 Minuten später, Versandzeit gesetzt", async () => {
    const r = rig({ answer: '```json\n{"action": "text", "message": "  Wie weit ist die Steuererklärung?  ", "reason": "Frist morgen"}\n```' });
    expect(await runCheckin(r.deps)).toBe(0);
    expect(r.box.sent).toHaveLength(1);
    const [input] = r.box.sent;
    expect(input.text).toBe("Wie weit ist die Steuererklärung?");
    expect(input.source).toBe("checkin");
    expect(input.choiceId).toBeString();
    expect(input.buttons![0].map(b => b.text)).toEqual(["Erledigt", "30 Minuten später"]);
    expect(await lastSentAt()).toBe(new Date(NOON).toISOString());
    // Ins Log kommt die Aktion, nie der Text
    expect(lines).toContain("[checkin] Entscheidung des Modells: text");
    expect(lines.some(l => l.includes("Steuererklärung"))).toBe(false);
  });

  test("call ohne eingerichtete Anrufe: gewöhnliche Meldung ohne Anrufen-Knopf", async () => {
    const r = rig({ answer: '{"action": "call", "message": "Die Frist ist heute."}', callAvailable: false });
    expect(await runCheckin(r.deps)).toBe(0);
    expect(r.box.sent[0].text).toBe("Die Frist ist heute.");
    expect(r.box.sent[0].buttons![0].map(b => b.text)).toEqual(["Erledigt", "30 Minuten später"]);
  });

  test("call mit eingerichteten Anrufen: Meldung bietet den Anruf an, angerufen wird erst per Knopf", async () => {
    const r = rig({ answer: '{"action": "call", "message": "Die Frist ist heute."}', callAvailable: true });
    expect(await runCheckin(r.deps)).toBe(0);
    expect(r.box.sent[0].text).toBe(`${CALL_OFFER_PREFIX}Die Frist ist heute.`);
    expect(r.box.sent[0].buttons![0].map(b => b.text)).toEqual(["Erledigt", "30 Minuten später", "Anrufen"]);
  });

  test("Prompt: Zeit, Ziele, Beiträge, Anruf nur angeboten, wenn eingerichtet", async () => {
    const recent: BoardRow[] = [
      { role: "assistant", content: "Antwort B", metadata: null, created_at: "2026-10-19T08:00:00Z" },
      { role: "user", content: "Frage A", metadata: null, created_at: "2026-10-19T07:59:00Z" },
    ];
    const without = rig({ recent });
    await runCheckin(without.deps);
    const prompt = without.prompts[0];
    expect(prompt).toContain("Jetzt: Montag, 19. Oktober um 14:00");
    expect(prompt).toContain("- Steuererklärung abgeben (bis 2026-10-20)");
    expect(prompt).toContain("- Nutzer: Frage A\n- tybo: Antwort B");
    expect(prompt).toContain("Letzter Check-in: noch keiner");
    expect(prompt).toContain("Anrufe sind nicht eingerichtet");
    expect(prompt).not.toContain('"call" (Anruf anbieten');
  });
});

describe("Versand", () => {
  test("nur WebUI (ohne Telegram festgehalten): zugestellt, Exit 0, Versandzeit gesetzt", async () => {
    const r = rig({ mode: "web" });
    expect(await runCheckin(r.deps)).toBe(0);
    expect(r.box.sent).toHaveLength(1);
    expect(await lastSentAt()).toBe(new Date(NOON).toISOString());
  });

  test("Sendefehler: Exit 1, Versandzeit bleibt", async () => {
    writeState({ lastSentAt: LONG_AGO });
    const r = rig({ mode: "fail" });
    expect(await runCheckin(r.deps)).toBe(1);
    expect(await lastSentAt()).toBe(LONG_AGO);
    expect(lines).toContain("[checkin] failed (undelivered)");
  });

  test("Sender wirft: Exit 1, Versandzeit bleibt", async () => {
    const r = rig();
    r.deps.send = async () => { throw new Error("Netz weg"); };
    expect(await runCheckin(r.deps)).toBe(1);
    expect(await lastSentAt()).toBeUndefined();
  });
});

describe("Vorschau --dry-run", () => {
  test("entscheidet und zeigt, sendet nichts und schreibt keinen Zustand", async () => {
    const r = rig();
    const printed: string[] = [];
    expect(await runCheckin({ ...r.deps, dryRun: true, print: t => void printed.push(t) })).toBe(0);
    expect(r.box.sent).toEqual([]);
    expect(existsSync(statePath)).toBe(false);
    expect(printed).toEqual(["Würde senden (text):\n\nWie weit ist die Steuererklärung?"]);
  });

  test("Ruhezeit: kein Modellaufruf; Fehler im Verlauf: Exit 1", async () => {
    const quiet = rig({ clock: NIGHT });
    const printed: string[] = [];
    expect(await runCheckin({ ...quiet.deps, dryRun: true, print: t => void printed.push(t) })).toBe(0);
    expect(quiet.prompts).toEqual([]);
    expect(printed).toEqual(["Kein Check-in jetzt (quiet), kein Modellaufruf."]);

    const broken = rig({ last: "kaputt" });
    expect(await runCheckin({ ...broken.deps, dryRun: true, print: () => {} })).toBe(1);
  });
});

describe("reine Bausteine", () => {
  test("readDecision: none ohne Nachricht, Felder getrimmt, zusätzliche Felder egal", () => {
    expect(readDecision('{"action": "none"}')).toEqual({ ok: true, decision: { action: "none", message: "" } });
    expect(readDecision('Antwort: {"action": "text", "message": " Hi ", "reason": "x"} Ende')).toEqual({ ok: true, decision: { action: "text", message: "Hi" } });
    expect(readDecision("{kaputt")).toEqual({ ok: false, problem: "no-json" });
    expect(readDecision('{"action": 1}')).toEqual({ ok: false, problem: "action" });
    expect(readDecision('{"action": "text"}')).toEqual({ ok: false, problem: "empty" });
    expect(readDecision(JSON.stringify({ action: "text", message: "a".repeat(MAX_MESSAGE_CHARS) }))).toMatchObject({ ok: true });
    expect(readDecision(JSON.stringify({ action: "text", message: "a".repeat(MAX_MESSAGE_CHARS + 1) }))).toEqual({ ok: false, problem: "too-long" });
  });

  test("messageFor: none ergibt null, immer mit Knöpfen", () => {
    expect(messageFor({ action: "none", message: "" }, true)).toBeNull();
    expect(messageFor({ action: "text", message: "Hi" }, true)).toEqual({ text: "Hi", ask: true });
    expect(messageFor({ action: "call", message: "Hi" }, false)).toEqual({ text: "Hi", ask: true });
    expect(messageFor({ action: "call", message: "Hi" }, true)).toEqual({ text: `${CALL_OFFER_PREFIX}Hi`, ask: true });
  });

  test("checkinPrompt: Zeitangaben in Minuten, Stunden und Tagen", () => {
    const facts: CheckinFacts = {
      now: new Date(NOON),
      zone: "Europe/Berlin",
      lastUserMessage: new Date(NOON - 45 * MIN),
      lastCheckin: new Date(NOON - 3 * 24 * 60 * MIN),
      goals: [],
      pendingItems: ["PENDING_CALL: Frist"],
      recent: [],
      profile: "# Alex",
      callAvailable: true,
    };
    const prompt = checkinPrompt(facts);
    expect(prompt).toContain("Letzte Nachricht des Nutzers: vor 45 Minuten");
    expect(prompt).toContain("Letzter Check-in: vor 3 Tagen");
    expect(prompt).toContain("- PENDING_CALL: Frist");
    expect(prompt).toContain("Profil des Nutzers:\n# Alex");
    expect(prompt).toContain('"call" (Anruf anbieten');
  });

  test("parseCheckinArgs: nur --dry-run", () => {
    expect(parseCheckinArgs([])).toEqual({ dryRun: false });
    expect(parseCheckinArgs(["--dry-run"])).toEqual({ dryRun: true });
    expect(parseCheckinArgs(["--jetzt"])).toBeNull();
  });
});

test("Zustandsdatei bleibt lesbares JSON", async () => {
  const r = rig();
  await runCheckin(r.deps);
  expect(() => JSON.parse(readFileSync(statePath, "utf-8"))).not.toThrow();
});
