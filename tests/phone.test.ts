/**
 * Anruf-Modul (Issue #366): Anbieter mit fetch-Attrappe, dauerhafte
 * Anrufliste, Abholen über Neustart hinweg, Zusammenfassung im richtigen
 * Gespräch und Auftrag erst nach Zustimmung. Uhr, Aux-Modell (summarize,
 * findTask), Zustellung und Ausführen sind ersetzt; das Rückfragen-Register
 * ist das echte in einem Testordner.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createChoice,
  decideChoice,
  expireChoice,
  getChoice,
  listChoices,
  onChoiceDecided,
  setChoicesFileForTests,
  type ChoiceConversation,
  type CreateChoiceInput,
} from "../src/lib/choices";
import { CALL_SUMMARY_DISABLED_TEXT, extractTaskFromTranscript, summarizeTranscriptStrict } from "../src/lib/call-summary";
import { resetClaudeAvailabilityForTests, setClaudeAvailability } from "../src/lib/claude-availability";
import { callIdsFrom, callNote } from "../src/lib/phone/bridge-note";
import { callVariables } from "../src/lib/phone/context";
import { historyRecorder } from "../src/lib/phone";
import { createPhoneLedger, KEEP_FINISHED_MS, type CallRecord, type PhoneLedger } from "../src/lib/phone/ledger";
import { createElevenLabsCaller, ELEVENLABS_API } from "../src/lib/phone/provider";
import {
  CALL_OPTION,
  callGreetingFor,
  createPhoneService,
  MAX_SEND_ATTEMPTS,
  PHONE_TEXT,
  RECORD_RETRY_MAX_MS,
  RECORD_RETRY_MS,
  type DeliveryOutcome,
  type PhoneService,
} from "../src/lib/phone/service";

const ENV = {
  ELEVENLABS_API_KEY: "test-key",
  ELEVENLABS_AGENT_ID: "agent-1",
  ELEVENLABS_PHONE_NUMBER_ID: "number-1",
  USER_PHONE_NUMBER: "+49 151 0000000",
};

const TOPIC: ChoiceConversation = { type: "telegram", chatId: "4711", topicId: 42 };

type Reply = Response | Error | (() => Response | Promise<Response>);

/** fetch-Attrappe: Antworten je Weg (outbound-call bzw. conversations) in Reihenfolge, die letzte bleibt stehen */
function fakeFetch(routes: { dial?: Reply[]; poll?: Reply[] }) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const take = (list: Reply[] | undefined): Reply => {
    if (!list || list.length === 0) throw new Error("keine Antwort vorgesehen");
    return list.length > 1 ? list.shift()! : list[0];
  };
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : null });
    const reply = take(url.endsWith("/twilio/outbound-call") ? routes.dial : routes.poll);
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply() : reply.clone();
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const DIALED = json({ success: true, message: "ok", conversation_id: "conv-1", callSid: "CA1" });
const RUNNING = json({ status: "in-progress", transcript: [] });
const DONE = json({
  status: "done",
  transcript: [
    { role: "agent", message: "Hallo Alex, hier ist Mia." },
    { role: "user", message: "Bitte bereite die Folien für Freitag vor." },
    { role: "agent", message: null },
  ],
});
const DONE_EMPTY = json({ status: "done", transcript: [] });

let dir: string;
let ledgerPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phone-"));
  ledgerPath = join(dir, "data", "phone-calls.json");
  setChoicesFileForTests(join(dir, "data", "choices.json"));
});
afterEach(() => {
  setChoicesFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  service: PhoneService;
  ledger: PhoneLedger;
  clock: { t: number };
  notes: { conversation: ChoiceConversation; text: string; format: string }[];
  summaries: string[];
  tasks: { conversation: ChoiceConversation; task: string }[];
  asked: CreateChoiceInput[];
  recorded: { ref: string; transcript: string; summary: string }[];
  calls: { url: string; body: any }[];
  /** Geplante Zeitgeber (Nachholen der Ablage), ausgelöst per Hand */
  timers: { run: () => void; ms: number }[];
}

function harness(
  routes: { dial?: Reply[]; poll?: Reply[] },
  opts: {
    task?: string | null;
    clock?: { t: number };
    onSleep?: (h: Harness) => void;
    deliver?: (text: string) => DeliveryOutcome;
    /** Ergebnis der Ablage im Verlauf je Versuch (der letzte bleibt stehen); Standard true */
    store?: (boolean | Error)[];
    /** Eigene Zusammenfassung und Auftragssuche statt der festen Attrappen */
    summarize?: (transcript: string) => Promise<string>;
    findTask?: (transcript: string, summary: string) => Promise<string | null>;
    /** Logzeilen des Dienstes */
    logs?: string[];
  } = {},
): Harness {
  const net = fakeFetch(routes);
  const clock = opts.clock ?? { t: 1_000_000 };
  const ledger = createPhoneLedger(ledgerPath, () => clock.t);
  const h = { ledger, clock, notes: [], summaries: [], tasks: [], asked: [], recorded: [], calls: net.calls, timers: [] } as unknown as Harness;
  const store = opts.store ?? [true];
  let refs = 0;
  h.service = createPhoneService({
    caller: createElevenLabsCaller({ env: ENV, fetch: net.fetch }),
    ledger,
    summarize: async transcript => {
      h.summaries.push(transcript);
      return opts.summarize ? opts.summarize(transcript) : "Folien für Freitag besprochen.";
    },
    findTask: async (transcript, summary) =>
      opts.findTask ? opts.findTask(transcript, summary) : opts.task === undefined ? "Folien für Freitag vorbereiten" : opts.task,
    notify: async (conversation, text, format) => {
      h.notes.push({ conversation, text, format });
      return opts.deliver ? opts.deliver(text) : "delivered";
    },
    ask: async input => {
      h.asked.push(input);
      return createChoice(input);
    },
    runTask: async (conversation, task) => {
      h.tasks.push({ conversation, task });
    },
    record: async (call, transcript, summary) => {
      h.recorded.push({ ref: call.ref, transcript, summary });
      const result = store.length > 1 ? store.shift()! : store[0];
      if (result instanceof Error) throw result;
      return result;
    },
    setTimer: (run, ms) => {
      const timer = { run, ms };
      h.timers.push(timer);
      return timer;
    },
    clearTimer: handle => {
      h.timers = h.timers.filter(t => t !== handle);
    },
    agentName: () => "Mia",
    now: () => clock.t,
    sleep: async ms => {
      clock.t += ms;
      opts.onSleep?.(h);
    },
    pollMs: 10_000,
    waitMs: 60_000,
    newRef: () => `ref${++refs}${Math.random().toString(36).slice(2, 6)}`,
    log: line => void opts.logs?.push(line),
  });
  return h;
}

// ---------------------------------------------------------------------------
// Anbieter
// ---------------------------------------------------------------------------

describe("ElevenLabs-Anbieter", () => {
  test("ohne Einstellungen: fehlende Namen, kein HTTP-Aufruf", async () => {
    const net = fakeFetch({ dial: [DIALED] });
    const caller = createElevenLabsCaller({ env: { ...ENV, USER_PHONE_NUMBER: "" }, fetch: net.fetch });
    expect(caller.missing()).toEqual(["USER_PHONE_NUMBER"]);
    const result = await caller.dial({ ref: "r1", greeting: "Hallo", variables: {} });
    expect(result.ok).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  test("Anwahl schickt Agent, Nummer, ersten Satz und die eigene Kennung", async () => {
    const net = fakeFetch({ dial: [DIALED] });
    const caller = createElevenLabsCaller({ env: ENV, fetch: net.fetch });
    const result = await caller.dial({ ref: "r1", greeting: "Hallo Alex", variables: { call_reason: "Folien" } });
    expect(result).toEqual({ ok: true, conversationId: "conv-1" });
    expect(net.calls[0].url).toBe(`${ELEVENLABS_API}/twilio/outbound-call`);
    expect((net.calls[0].init.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    expect(net.calls[0].body).toMatchObject({
      agent_id: "agent-1",
      agent_phone_number_id: "number-1",
      to_number: "+49 151 0000000",
      first_message: "Hallo Alex",
      conversation_initiation_client_data: { dynamic_variables: { call_reason: "Folien", tybo_call_ref: "r1" } },
    });
  });

  test("HTTP 400 bei der Anwahl: Fehler mit Status, kein Anruf", async () => {
    const net = fakeFetch({ dial: [json({ detail: "invalid number" }, 400)] });
    const result = await createElevenLabsCaller({ env: ENV, fetch: net.fetch }).dial({ ref: "r1", greeting: "Hallo", variables: {} });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("HTTP 400");
  });

  test("Zeitablauf bei der Anwahl: echte Frist bricht ab", async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
    const result = await createElevenLabsCaller({ env: ENV, fetch: hang, timeoutMs: 20 }).dial({ ref: "r1", greeting: "Hallo", variables: {} });
    expect(result).toEqual({ ok: false, error: "Zeitablauf" });
  });

  test("Protokoll: laufend, vorübergehende und dauerhafte Fehler, leer, fertig", async () => {
    const ask = async (reply: Reply) => createElevenLabsCaller({ env: ENV, fetch: fakeFetch({ poll: [reply] }).fetch }).transcript("conv-1");
    expect((await ask(RUNNING)).state).toBe("pending");
    expect((await ask(json({}, 404))).state).toBe("pending");
    expect((await ask(json({}, 503))).state).toBe("pending");
    expect((await ask(json({}, 429))).state).toBe("pending");
    expect((await ask(Object.assign(new Error("t"), { name: "TimeoutError" })))).toEqual({ state: "pending", reason: "Zeitablauf" });
    const bad = await ask(json({ detail: "bad id" }, 400));
    expect(bad.state).toBe("error");
    expect(bad.state === "error" && bad.error).toContain("HTTP 400");
    expect((await ask(json({ status: "failed" }))).state).toBe("error");
    expect(await ask(DONE_EMPTY)).toEqual({ state: "done", lines: [] });
    expect(await ask(DONE)).toEqual({
      state: "done",
      lines: [
        { speaker: "agent", text: "Hallo Alex, hier ist Mia." },
        { speaker: "user", text: "Bitte bereite die Folien für Freitag vor." },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Anrufliste
// ---------------------------------------------------------------------------

describe("Anrufliste", () => {
  const record = (ref: string, stage: CallRecord["stage"], at = 0): CallRecord => ({
    ref, reason: "Folien", conversation: TOPIC, userName: "Alex", createdAt: at, deadline: at + 60_000, stage, updatedAt: at,
  });

  test("bedingter Übergang: nur aus erlaubtem Stand, über zwei Instanzen hinweg", () => {
    const a = createPhoneLedger(ledgerPath);
    a.add(record("r1", "waiting"));
    const b = createPhoneLedger(ledgerPath);
    expect(b.advance("r1", ["waiting"], "summarized", { summary: "S" })?.stage).toBe("summarized");
    expect(a.advance("r1", ["waiting"], "failed")).toBeNull();
    expect(a.get("r1")?.summary).toBe("S");
    expect(b.advance("r1", ["summarized"], "reported", { summary: undefined })?.summary).toBeUndefined();
  });

  test("claim: je Kennung beim Anbieter ein Eintrag, über zwei Instanzen hinweg", () => {
    const a = createPhoneLedger(ledgerPath);
    const b = createPhoneLedger(ledgerPath);
    const first = a.claim({ ...record("r1", "received"), conversationId: "conv-x" });
    const second = b.claim({ ...record("r2", "received"), conversationId: "conv-x" });
    expect(first.created).toBe(true);
    expect(second).toEqual({ call: expect.objectContaining({ ref: "r1" }), created: false });
    expect(a.get("r2")).toBeUndefined();
    expect(b.claim({ ...record("r3", "received"), conversationId: "conv-y" }).created).toBe(true);
  });

  test("doppelte Kennung wird abgelehnt, alte fertige Einträge fallen weg", () => {
    let t = 0;
    const ledger = createPhoneLedger(ledgerPath, () => t);
    ledger.add(record("alt", "closed", 0));
    ledger.add(record("offen", "waiting", 0));
    expect(() => ledger.add(record("alt", "waiting"))).toThrow();
    t = 8 * 24 * 3_600_000;
    expect(ledger.get("alt")).toBeUndefined();
    expect(ledger.open().map(c => c.ref)).toEqual(["offen"]);
  });
});

// ---------------------------------------------------------------------------
// Anlass für die Sprach-Brücke
// ---------------------------------------------------------------------------

describe("Anlass für die Sprach-Brücke", () => {
  test("steht in der Anrufliste, bevor der Anbieter wählt", async () => {
    let seenAtDial: string | null = null;
    const h = harness({
      dial: [
        () => {
          const ref = h.calls[0].body.conversation_initiation_client_data.dynamic_variables.tybo_call_ref;
          seenAtDial = callNote(h.ledger, { ref });
          return DIALED.clone();
        },
      ],
      poll: [DONE_EMPTY],
    });
    await h.service.startCall({ reason: "Folien für Freitag", conversation: TOPIC, userName: "Alex" });
    await h.service.idle();
    expect(seenAtDial).toContain("Folien für Freitag");
  });

  test("über die Kennung beim Anbieter; Platzhalter und Unbekanntes ergeben nichts", async () => {
    const h = harness({ dial: [DIALED], poll: [RUNNING] });
    h.service.stop();
    await h.service.startCall({ reason: "", conversation: TOPIC });
    expect(callNote(h.ledger, { conversationId: "conv-1" })).toContain("ohne besonderen Anlass");
    expect(callNote(h.ledger, { conversationId: "conv-x" })).toBeNull();
    const ids = callIdsFrom(new Headers({ "x-voice-call-ref": "{{tybo_call_ref}}", "x-voice-conversation-id": "conv-1" }));
    expect(ids).toEqual({ conversationId: "conv-1" });
  });
});

// ---------------------------------------------------------------------------
// Anrufen und Abholen
// ---------------------------------------------------------------------------

describe("Anrufen und Abholen", () => {
  test("Ablauf: Anlass im ersten Satz, Zusammenfassung im Topic, Auftrag als Rückfrage", async () => {
    const h = harness({ dial: [DIALED], poll: [RUNNING, json({}, 503), DONE] });
    const result = await h.service.startCall({ reason: "Folien für Freitag", conversation: TOPIC, userName: "Alex" });
    expect(result).toMatchObject({ ok: true, message: PHONE_TEXT.calling });
    await h.service.idle();

    expect(h.calls[0].body.first_message).toBe(callGreetingFor("Alex", "Mia", "Folien für Freitag"));
    expect(h.calls.filter(c => c.url.includes("/conversations/conv-1"))).toHaveLength(3);
    expect(h.summaries).toEqual(["Mia: Hallo Alex, hier ist Mia.\nAlex: Bitte bereite die Folien für Freitag vor."]);
    expect(h.notes).toEqual([{ conversation: TOPIC, text: PHONE_TEXT.summary("Folien für Freitag besprochen."), format: "markdown" }]);
    expect(h.recorded).toHaveLength(1);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({ kind: "call", conversation: TOPIC, ref: result.ref });
    expect(h.tasks).toEqual([]);
    const call = h.ledger.get(result.ref!)!;
    expect(call.stage).toBe("asked");
    expect(call.transcript).toBeUndefined();
    expect(call.choiceId).toBeDefined();
  });

  test("HTTP 400 bei der Anwahl: Meldung an den Aufrufer, Eintrag gescheitert, kein Abholen", async () => {
    const h = harness({ dial: [json({ detail: "invalid" }, 400)] });
    const result = await h.service.startCall({ reason: "Test", conversation: TOPIC });
    await h.service.idle();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("HTTP 400");
    expect(h.ledger.get(result.ref!)?.stage).toBe("failed");
    expect(h.calls).toHaveLength(1);
    expect(h.notes).toEqual([]);
  });

  test("nicht eingerichtet: kein Eintrag, kein Aufruf", async () => {
    const net = fakeFetch({});
    const ledger = createPhoneLedger(ledgerPath);
    const service = createPhoneService({
      caller: createElevenLabsCaller({ env: {}, fetch: net.fetch }),
      ledger, summarize: async () => "", findTask: async () => null, notify: async () => "delivered", ask: createChoice, runTask: async () => {},
    });
    expect(await service.startCall({ reason: "x", conversation: TOPIC })).toEqual({ ok: false, message: PHONE_TEXT.notConfigured });
    expect(ledger.open()).toEqual([]);
    expect(net.calls).toHaveLength(0);
  });

  test("Zeitablauf: Protokoll kommt nicht, eine Meldung, keine Zusammenfassung", async () => {
    const h = harness({ dial: [DIALED], poll: [RUNNING] });
    const result = await h.service.startCall({ reason: "Test", conversation: TOPIC });
    await h.service.idle();
    expect(h.ledger.get(result.ref!)?.stage).toBe("failed");
    expect(h.notes.map(n => n.text)).toEqual([PHONE_TEXT.timeout]);
    expect(h.summaries).toEqual([]);
    // 60 s Frist bei 10 s Abstand: endlich viele Abfragen
    expect(h.calls.filter(c => c.url.includes("/conversations/")).length).toBeLessThanOrEqual(7);
  });

  test("dauerhafter Fehler beim Abholen (HTTP 400): eigene Meldung", async () => {
    const h = harness({ dial: [DIALED], poll: [RUNNING, json({ detail: "bad" }, 400)] });
    const result = await h.service.startCall({ reason: "Test", conversation: TOPIC });
    await h.service.idle();
    expect(h.ledger.get(result.ref!)?.stage).toBe("failed");
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].text).toContain("HTTP 400");
  });

  test("abgeschlossen, aber leer: eigene Meldung, kein Aux-Aufruf", async () => {
    const h = harness({ dial: [DIALED], poll: [DONE_EMPTY] });
    const result = await h.service.startCall({ reason: "Test", conversation: TOPIC });
    await h.service.idle();
    expect(h.ledger.get(result.ref!)?.stage).toBe("closed");
    expect(h.notes.map(n => n.text)).toEqual([PHONE_TEXT.empty]);
    expect(h.summaries).toEqual([]);
    expect(h.asked).toEqual([]);
  });

  test("ohne Auftrag: Zusammenfassung, keine Rückfrage", async () => {
    const h = harness({ dial: [DIALED], poll: [DONE] }, { task: null });
    const result = await h.service.startCall({ reason: "Test", conversation: TOPIC });
    await h.service.idle();
    expect(h.notes).toHaveLength(1);
    expect(h.asked).toEqual([]);
    expect(h.ledger.get(result.ref!)?.stage).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Ohne Claude (Issue #566)
// ---------------------------------------------------------------------------

describe("Zusammenfassung abgeschaltet (Claude fehlt, Issue #566)", () => {
  const savedPath = process.env.CLAUDE_PATH;
  const savedAux = process.env.AUX_MODEL_CALL_SUMMARY;
  beforeEach(() => {
    // Ein Aufruf der Claude CLI landete hier und scheiterte ohne disabled
    process.env.CLAUDE_PATH = join(dir, "gibt-es-nicht", "claude");
    delete process.env.AUX_MODEL_CALL_SUMMARY;
    setClaudeAvailability({ state: "missing", reason: "Claude CLI nicht installiert" });
  });
  afterEach(() => {
    resetClaudeAvailabilityForTests();
    if (savedPath === undefined) delete process.env.CLAUDE_PATH;
    else process.env.CLAUDE_PATH = savedPath;
    if (savedAux === undefined) delete process.env.AUX_MODEL_CALL_SUMMARY;
    else process.env.AUX_MODEL_CALL_SUMMARY = savedAux;
  });

  test("echte call-summary: ein Versuch, Anfang des Protokolls mit Grund, auch mit vorgespulter Uhr und Neustart keine Wiederholung und kein Fehlerlog", async () => {
    const clock = { t: 1_000_000 };
    const logs: string[] = [];
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const h = harness({ dial: [DIALED], poll: [DONE] }, { clock, logs, summarize: summarizeTranscriptStrict, findTask: extractTaskFromTranscript });
      const result = await h.service.startCall({ reason: "Folien", conversation: TOPIC, userName: "Alex" });
      await h.service.idle();
      const call = h.ledger.get(result.ref!);
      expect(call).toMatchObject({ stage: "closed", note: "Zusammenfassung abgeschaltet" });
      expect(h.summaries).toHaveLength(1);
      expect(h.notes).toHaveLength(1);
      expect(h.notes[0].conversation).toEqual(TOPIC);
      expect(h.notes[0].text).toContain("Alex: Bitte bereite die Folien für Freitag vor.");
      expect(h.notes[0].text).toContain(CALL_SUMMARY_DISABLED_TEXT);
      expect(h.asked).toEqual([]);

      // Weit über Frist und Wiederholungsabstand vorspulen, dann ein Neustart: nichts mehr
      clock.t += 24 * 60 * 60 * 1000;
      const again = harness({ poll: [DONE] }, { clock, logs, summarize: summarizeTranscriptStrict, findTask: extractTaskFromTranscript });
      again.service.resume();
      await again.service.idle();
      expect(again.summaries).toEqual([]);
      expect(again.notes).toEqual([]);

      expect(logs.filter(l => /gescheitert|neuer Versuch|unterbrochen/.test(l))).toEqual([]);
      expect(logs.filter(l => l.includes("Zusammenfassung abgeschaltet (Claude fehlt)"))).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      console.error = realError;
    }
  });
});

// ---------------------------------------------------------------------------
// Neustart
// ---------------------------------------------------------------------------

describe("Neustart", () => {
  test("während des Abholens: neue Instanz holt fertig ab, ohne erneut zu wählen", async () => {
    const clock = { t: 1_000_000 };
    const first = harness({ dial: [DIALED], poll: [RUNNING] }, { clock, onSleep: h => h.service.stop() });
    const result = await first.service.startCall({ reason: "Folien", conversation: TOPIC, userName: "Alex" });
    await first.service.idle();
    expect(first.ledger.get(result.ref!)?.stage).toBe("waiting");
    expect(first.notes).toEqual([]);

    const second = harness({ poll: [RUNNING, DONE] }, { clock });
    second.service.resume();
    await second.service.idle();
    expect(second.calls.some(c => c.url.endsWith("/twilio/outbound-call"))).toBe(false);
    expect(second.notes.map(n => n.conversation)).toEqual([TOPIC]);
    expect(second.asked).toHaveLength(1);
    expect(second.ledger.get(result.ref!)?.stage).toBe("asked");

    // Dritter Start: nichts mehr zu tun, keine doppelte Zusammenfassung oder Rückfrage
    const third = harness({ poll: [DONE] }, { clock });
    third.service.resume();
    await third.service.idle();
    expect(third.calls).toHaveLength(0);
    expect(third.notes).toEqual([]);
    expect(third.asked).toEqual([]);
  });

  test("Frist zählt ab dem Wählen weiter, auch über den Neustart", async () => {
    const clock = { t: 1_000_000 };
    const first = harness({ dial: [DIALED], poll: [RUNNING] }, { clock, onSleep: h => h.service.stop() });
    const result = await first.service.startCall({ reason: "Folien", conversation: TOPIC });
    await first.service.idle();
    clock.t += 120_000;
    const second = harness({ poll: [DONE] }, { clock });
    second.service.resume();
    await second.service.idle();
    expect(second.calls).toHaveLength(0);
    expect(second.notes.map(n => n.text)).toEqual([PHONE_TEXT.timeout]);
    expect(second.ledger.get(result.ref!)?.stage).toBe("failed");
  });

  test("beim Wählen unterbrochen: nie erneut wählen, Hinweis einmal", async () => {
    const ledger = createPhoneLedger(ledgerPath);
    ledger.add({ ref: "r-dial", reason: "x", conversation: TOPIC, userName: "Alex", createdAt: 1, deadline: 2, stage: "dialing", updatedAt: 1 });
    const h = harness({ dial: [DIALED], poll: [DONE] });
    h.service.resume();
    await h.service.idle();
    h.service.resume();
    await h.service.idle();
    expect(h.calls).toHaveLength(0);
    expect(h.notes.map(n => n.text)).toEqual([PHONE_TEXT.unknownAfterRestart]);
    expect(h.ledger.get("r-dial")?.stage).toBe("failed");
  });

  test("Zusammenfassung schon gespeichert: nur noch zustellen, kein zweiter Aux-Aufruf", async () => {
    const ledger = createPhoneLedger(ledgerPath);
    ledger.add({ ref: "r-sum", reason: "x", conversation: TOPIC, userName: "Alex", createdAt: 1, deadline: 2, stage: "summarized", updatedAt: 1, transcript: "Alex: Hallo", summary: "Kurz" });
    const h = harness({}, { task: null });
    h.service.resume();
    await h.service.idle();
    expect(h.summaries).toEqual([]);
    expect(h.notes.map(n => n.text)).toEqual([PHONE_TEXT.summary("Kurz")]);
  });

  test("beim Zustellen unterbrochen: Zusammenfassung nicht doppelt, Auftragssuche läuft weiter", async () => {
    const ledger = createPhoneLedger(ledgerPath);
    ledger.add({ ref: "r-rep", reason: "x", conversation: TOPIC, userName: "Alex", createdAt: 1, deadline: 2, stage: "reporting", updatedAt: 1, transcript: "Alex: Hallo", summary: "Kurz" });
    const h = harness({});
    h.service.resume();
    await h.service.idle();
    expect(h.notes).toEqual([]);
    expect(h.asked.map(a => a.ref)).toEqual(["r-rep"]);
  });

  /** Eintrag beim Rückfragen, wie ihn ein Neustart hinterlässt */
  const asking = (ref: string) =>
    createPhoneLedger(ledgerPath).add({ ref, reason: "x", conversation: TOPIC, userName: "Alex", createdAt: 1, deadline: 2, stage: "asking", updatedAt: 1, task: "Folien" });

  test("vor dem Anlegen der Rückfrage unterbrochen: genau eine wird nachgeholt, Zustimmung führt aus", async () => {
    asking("r-ask");
    const h = harness({});
    const off = onChoiceDecided("call", h.service.handler);
    try {
      h.service.resume();
      await h.service.idle();
      h.service.resume();
      await h.service.idle();
      expect(h.asked.map(a => a.ref)).toEqual(["r-ask"]);
      const call = h.ledger.get("r-ask")!;
      expect(call.stage).toBe("asked");
      expect((await listChoices()).filter(c => c.ref === "r-ask")).toHaveLength(1);

      // Dritter Start mit neuer Instanz: nichts Neues
      const again = harness({});
      again.service.resume();
      await again.service.idle();
      expect(again.asked).toEqual([]);

      expect((await decideChoice(call.choiceId!, CALL_OPTION.run.key, "telegram")).status).toBe("decided");
      expect(h.tasks).toEqual([{ conversation: TOPIC, task: "Folien" }]);
    } finally {
      off();
    }
  });

  test("nach dem Anlegen, vor dem Speichern unterbrochen: die sichtbare Frage gilt, keine zweite, Zustimmung führt aus", async () => {
    asking("r-ask");
    const visible = await createChoice({ kind: "call", conversation: TOPIC, text: PHONE_TEXT.question("Folien"), options: [CALL_OPTION.run, CALL_OPTION.skip], ref: "r-ask" });
    const h = harness({});
    const off = onChoiceDecided("call", h.service.handler);
    try {
      h.service.resume();
      await h.service.idle();
      expect(h.asked).toEqual([]);
      expect(h.ledger.get("r-ask")).toMatchObject({ stage: "asked", choiceId: visible.id });
      expect((await getChoice(visible.id))?.state).toBe("open");

      expect((await decideChoice(visible.id, CALL_OPTION.run.key, "web")).status).toBe("decided");
      expect(h.tasks).toEqual([{ conversation: TOPIC, task: "Folien" }]);
      expect(h.notes.at(-1)?.text).toBe(PHONE_TEXT.starting("Folien"));
      expect(h.ledger.get("r-ask")?.stage).toBe("closed");
    } finally {
      off();
    }
  });

  test("Rückfrage schon abgelaufen: Eintrag geschlossen, keine neue Frage", async () => {
    asking("r-ask");
    const old = await createChoice({ kind: "call", conversation: TOPIC, text: "?", options: [CALL_OPTION.run, CALL_OPTION.skip], ref: "r-ask" });
    await expireChoice(old.id);
    const h = harness({});
    h.service.resume();
    await h.service.idle();
    expect(h.asked).toEqual([]);
    expect(h.ledger.get("r-ask")?.stage).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Zustellung der Zusammenfassung
// ---------------------------------------------------------------------------

describe("Zustellung der Zusammenfassung", () => {
  const summarized = () =>
    createPhoneLedger(ledgerPath).add({
      ref: "r-sum", reason: "x", conversation: TOPIC, userName: "Alex", createdAt: 1, deadline: 2, stage: "summarized", updatedAt: 1, transcript: "Alex: Hallo", summary: "Kurz",
    });

  test("abgelehnt: bleibt ausstehend, neue Instanz stellt zu, Protokoll nur einmal im Verlauf", async () => {
    summarized();
    const clock = { t: 1_000_000 };
    const first = harness({}, { clock, deliver: () => "rejected", onSleep: h => h.service.stop() });
    first.service.resume();
    await first.service.idle();
    expect(first.notes.map(n => n.text)).toEqual([PHONE_TEXT.summary("Kurz")]);
    expect(first.recorded).toHaveLength(1);
    expect(first.asked).toEqual([]);
    expect(first.ledger.get("r-sum")).toMatchObject({ stage: "summarized", sendAttempts: 1, summary: "Kurz" });

    // Neustart vor dem Termin des nächsten Versuchs: wartet, dann zugestellt
    const second = harness({}, { clock });
    second.service.resume();
    await second.service.idle();
    expect(second.notes.map(n => n.text)).toEqual([PHONE_TEXT.summary("Kurz")]);
    expect(second.recorded).toEqual([]);
    expect(second.asked.map(a => a.ref)).toEqual(["r-sum"]);
    const call = second.ledger.get("r-sum")!;
    expect(call.stage).toBe("asked");
    expect(call.sendAttempts).toBeUndefined();
  });

  test("unklarer Ausgang: gilt als zugestellt, nicht wiederholt", async () => {
    summarized();
    const h = harness({}, { deliver: () => "unclear", task: null });
    h.service.resume();
    await h.service.idle();
    expect(h.notes).toHaveLength(1);
    expect(h.ledger.get("r-sum")?.stage).toBe("closed");
  });

  test("wirft notify: unklar, nicht wiederholt", async () => {
    summarized();
    const h = harness({}, { deliver: () => { throw new Error("Netz weg"); }, task: null });
    h.service.resume();
    await h.service.idle();
    expect(h.notes).toHaveLength(1);
    expect(h.ledger.get("r-sum")?.stage).toBe("closed");
  });

  test("immer abgelehnt: nach MAX_SEND_ATTEMPTS Versuchen gescheitert, keine Rückfrage", async () => {
    summarized();
    const h = harness({}, { deliver: () => "rejected" });
    h.service.resume();
    await h.service.idle();
    expect(h.notes).toHaveLength(MAX_SEND_ATTEMPTS);
    expect(h.asked).toEqual([]);
    expect(h.ledger.get("r-sum")).toMatchObject({ stage: "failed", note: "Zusammenfassung nicht zugestellt" });
    expect(h.ledger.get("r-sum")?.transcript).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rückfrage zum Auftrag
// ---------------------------------------------------------------------------

describe("Auftrag als Rückfrage", () => {
  async function asked(): Promise<{ h: Harness; choiceId: string; off: () => void }> {
    const h = harness({ dial: [DIALED], poll: [DONE] });
    const off = onChoiceDecided("call", h.service.handler);
    const result = await h.service.startCall({ reason: "Folien", conversation: TOPIC });
    await h.service.idle();
    const choiceId = h.ledger.get(result.ref!)!.choiceId!;
    const choice = await getChoice(choiceId);
    expect(choice?.options.map(o => o.key)).toEqual([CALL_OPTION.run.key, CALL_OPTION.skip.key]);
    expect(choice?.text).toBe(PHONE_TEXT.question("Folien für Freitag vorbereiten"));
    return { h, choiceId, off };
  }

  test("startet erst nach Zustimmung, im Gespräch des Anrufs, bei Doppelklick einmal", async () => {
    const { h, choiceId, off } = await asked();
    try {
      expect(h.tasks).toEqual([]);
      const [a, b] = await Promise.all([decideChoice(choiceId, "run", "telegram"), decideChoice(choiceId, "run", "web")]);
      expect([a.status, b.status].sort()).toEqual(["already", "decided"]);
      expect(h.tasks).toEqual([{ conversation: TOPIC, task: "Folien für Freitag vorbereiten" }]);
      expect(h.notes.at(-1)?.text).toBe(PHONE_TEXT.starting("Folien für Freitag vorbereiten"));
      // Auch ein erneuter Handler-Aufruf (etwa aus einem zweiten Prozess) tut nichts
      await h.service.handler((await getChoice(choiceId))!);
      expect(h.tasks).toHaveLength(1);
    } finally {
      off();
    }
  });

  test("Ablehnung: nie ausgeführt", async () => {
    const { h, choiceId, off } = await asked();
    try {
      await decideChoice(choiceId, "skip", "web");
      await decideChoice(choiceId, "run", "telegram");
      expect(h.tasks).toEqual([]);
      expect(h.notes.at(-1)?.text).toBe(PHONE_TEXT.skipped);
      expect(h.ledger.get((await getChoice(choiceId))!.ref!)?.stage).toBe("closed");
    } finally {
      off();
    }
  });
});

describe("Variablen für den Sprachagenten", () => {
  test("Namen bleiben, Platzhalter bei leerem oder scheiterndem Speicher", async () => {
    const vars = await callVariables(
      { reason: "", userName: "Alex", conversation: TOPIC },
      { memory: async () => { throw new Error("weg"); }, recent: async () => [{ role: "user", content: "Hallo" }], timeZone: "Europe/Berlin", now: () => new Date(0) },
    );
    expect(Object.keys(vars).sort()).toEqual(["call_reason", "current_time", "memory", "recent_telegram", "user_name"]);
    expect(vars.call_reason).toBe("general check-in");
    expect(vars.recent_telegram).toBe("Alex: Hallo");
    expect(vars.memory).toContain("No stored memory");
  });
});

describe("Wege des Bots (phoneDelivery)", () => {
  test("Meldung ins Topic mit Absender anruf; zugestellt, sicher abgelehnt und unklar getrennt", async () => {
    const { phoneDelivery, PHONE_SOURCE } = await import("../src/lib/phone");
    const sent: any[] = [];
    let result: any = { sent: true, recorded: true };
    const d = phoneDelivery(
      { send: async input => { sent.push(input); return result; }, sendChoice: async () => ({ sent: true }), runTask: async () => {} },
      () => {},
    );
    expect(await d.notify(TOPIC, "Hallo", "markdown")).toBe("delivered");
    expect(sent[0]).toEqual({ chatId: "4711", topicId: 42, text: "Hallo", source: PHONE_SOURCE, format: "markdown" });
    result = { sent: false, recorded: false, error: { kind: "send", message: "weg", rejected: true } };
    expect(await d.notify(TOPIC, "Hallo", "plain")).toBe("rejected");
    result = { sent: false, recorded: false, error: { kind: "send", message: "Zeitablauf" } };
    expect(await d.notify(TOPIC, "Hallo", "plain")).toBe("unclear");
  });

  test("Rückfrage steht im Register, auch wenn die Zustellung scheitert; Auftrag im Chat samt Topic", async () => {
    const { phoneDelivery } = await import("../src/lib/phone");
    const runs: unknown[] = [];
    const logs: string[] = [];
    const d = phoneDelivery(
      { send: async () => ({ sent: true }) as any, sendChoice: async () => { throw new Error("Telegram weg"); }, runTask: async (...args) => { runs.push(args); } },
      line => logs.push(line),
    );
    const choice = await d.ask({ kind: "call", conversation: TOPIC, text: "Soll ich?", options: [{ key: "run", label: "Ja" }], ref: "r1" });
    expect((await getChoice(choice.id))?.state).toBe("open");
    expect(logs[0]).toContain("nicht zugestellt");
    await d.runTask(TOPIC, "Folien");
    expect(runs).toEqual([["4711", "Folien", 42]]);
    // Reines Web-Gespräch: kein Turn, kein Fehler (Issue #367, tests/phone-web-task.test.ts)
    await d.runTask({ type: "web", conversationId: "w1" }, "Folien");
    expect(runs).toHaveLength(1);
  });
});

describe("Einstiege im Bot", () => {
  test("chatConversation: Topic nur, wenn es eins gibt", async () => {
    const { chatConversation } = await import("../src/lib/phone");
    expect(chatConversation("4711", 42)).toEqual(TOPIC);
    expect(chatConversation("4711")).toEqual({ type: "telegram", chatId: "4711" });
  });

  test("proactiveCall: Meldung als Anlass, Ziel Direktchat, Ergebnis im Format des Knopfs", async () => {
    const { proactiveCall } = await import("../src/lib/phone");
    const inputs: unknown[] = [];
    const call = proactiveCall(
      { startCall: async input => { inputs.push(input); return { ok: false, message: PHONE_TEXT.notConfigured }; } },
      { TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_USER_ID: "999" },
    );
    expect(await call("Briefing")).toEqual({ success: false, message: PHONE_TEXT.notConfigured });
    expect(inputs).toEqual([{ reason: "Briefing", conversation: { type: "telegram", chatId: "999" } }]);
  });
});

// ---------------------------------------------------------------------------
// Ablage im Verlauf (eingerichteter Speicher vorübergehend nicht erreichbar)
// ---------------------------------------------------------------------------

/** Wartet, bis ein vom Zeitgeber gestarteter Versuch durch ist */
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

describe("Ablage im Verlauf", () => {
  test("Adapter: false und Fehler von save kommen an, Web-Gespräch braucht keinen Verlauf", async () => {
    const call = { ref: "r1", conversation: TOPIC, conversationId: "conv-1" } as CallRecord;
    const saved: any[] = [];
    expect(await historyRecorder(async m => (saved.push(m), true))(call, "Alex: Hallo", "Kurz")).toBe(true);
    expect(saved[0]).toMatchObject({ chat_id: "4711", role: "assistant", metadata: { type: "call_transcript", callRef: "r1", topicId: 42 } });
    expect(await historyRecorder(async () => false)(call, "t", "s")).toBe(false);
    await expect(historyRecorder(async () => Promise.reject(new Error("Speicher weg")))(call, "t", "s")).rejects.toThrow("Speicher weg");
    let asked = false;
    const web = { ...call, conversation: { type: "web", conversationId: "w1" } } as unknown as CallRecord;
    expect(await historyRecorder(async () => ((asked = true), false))(web, "t", "s")).toBe(true);
    expect(asked).toBe(false);
  });

  test("save meldet false: Protokoll bleibt, Ablauf läuft weiter, neue Instanz holt nach, kein Duplikat", async () => {
    const clock = { t: 1_000_000 };
    const first = harness({ dial: [DIALED], poll: [DONE] }, { clock, store: [false] });
    const { ref } = await first.service.startCall({ reason: "Folien", conversation: TOPIC, userName: "Alex" });
    await first.service.idle();

    // Zusammenfassung und Rückfrage trotzdem, das Protokoll bleibt im Eintrag
    expect(first.notes.map(n => n.text)).toEqual([PHONE_TEXT.summary("Folien für Freitag besprochen.")]);
    expect(first.asked).toHaveLength(1);
    expect(first.recorded).toHaveLength(1);
    const pending = first.ledger.get(ref!)!;
    expect(pending).toMatchObject({ stage: "asked", recordPending: true, recordAttempts: 1 });
    expect(pending.recorded).toBeUndefined();
    expect(pending.transcript).toContain("Bitte bereite die Folien für Freitag vor.");
    expect(first.timers.map(t => t.ms)).toEqual([RECORD_RETRY_MS]);

    // Entschieden und lange vorbei: das Protokoll bleibt trotzdem stehen
    await first.service.handler({ id: pending.choiceId!, ref, result: { key: CALL_OPTION.skip.key } } as any);
    expect(first.ledger.get(ref!)).toMatchObject({ stage: "closed", recordPending: true });
    expect(first.ledger.get(ref!)!.transcript).toBeDefined();
    first.service.stop();
    expect(first.timers).toEqual([]);
    clock.t += KEEP_FINISHED_MS + RECORD_RETRY_MS;
    expect(first.ledger.get(ref!)?.transcript).toBeDefined();

    // Neustart: neue Instanz plant die Ablage ein und holt sie genau einmal nach
    const second = harness({}, { clock, store: [true] });
    second.service.resume();
    expect(second.timers.map(t => t.ms)).toEqual([0]);
    second.timers.shift()!.run();
    await settle();
    expect(second.recorded).toEqual([{ ref: ref!, transcript: pending.transcript!, summary: "Folien für Freitag besprochen." }]);
    const done = second.ledger.get(ref!)!;
    expect(done).toMatchObject({ stage: "closed", recorded: true });
    expect(done.recordPending).toBeUndefined();
    expect(done.recordAttempts).toBeUndefined();
    expect(done.transcript).toBeUndefined();
    expect(second.notes).toEqual([]);
    expect(second.asked).toEqual([]);

    // Kein Duplikat: weder ein zweiter Start noch eine weitere Instanz legen noch einmal ab
    second.service.resume();
    const third = harness({}, { clock });
    third.service.resume();
    await third.service.idle();
    expect(second.timers).toEqual([]);
    expect(third.timers).toEqual([]);
    expect(third.recorded).toEqual([]);
  });

  test("Ausnahme beim Speichern: Versuche mit wachsendem Abstand, dann Erfolg genau einmal", async () => {
    const clock = { t: 1_000_000 };
    const h = harness({ dial: [DIALED], poll: [DONE] }, { clock, store: [new Error("Speicher weg"), new Error("Speicher weg"), true] });
    const { ref } = await h.service.startCall({ reason: "Folien", conversation: TOPIC });
    await h.service.idle();
    expect(h.ledger.get(ref!)).toMatchObject({ stage: "asked", recordPending: true, recordAttempts: 1 });
    expect(h.notes).toHaveLength(1);

    clock.t += RECORD_RETRY_MS;
    h.timers.shift()!.run();
    await settle();
    expect(h.ledger.get(ref!)).toMatchObject({ recordPending: true, recordAttempts: 2, recordRetryAt: clock.t + 2 * RECORD_RETRY_MS });
    expect(h.timers.map(t => t.ms)).toEqual([2 * RECORD_RETRY_MS]);

    clock.t += 2 * RECORD_RETRY_MS;
    h.timers.shift()!.run();
    await settle();
    expect(h.recorded).toHaveLength(3);
    expect(h.timers).toEqual([]);
    const call = h.ledger.get(ref!)!;
    expect(call).toMatchObject({ stage: "asked", recorded: true });
    expect(call.recordPending).toBeUndefined();
    expect(call.transcript).toBeUndefined();

    // Danach keine weitere Ablage, auch nicht nach einem Neustart
    h.service.resume();
    expect(h.timers).toEqual([]);
    expect(h.recorded).toHaveLength(3);
  });

  test("Abstand wächst bis höchstens RECORD_RETRY_MAX_MS, ohne Obergrenze an Versuchen", async () => {
    const clock = { t: 1_000_000 };
    const h = harness({ dial: [DIALED], poll: [DONE] }, { clock, store: [false] });
    const { ref } = await h.service.startCall({ reason: "Folien", conversation: TOPIC });
    await h.service.idle();
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      const timer = h.timers.shift()!;
      waits.push(timer.ms);
      clock.t += timer.ms;
      timer.run();
      await settle();
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60].map(m => Math.min(m * RECORD_RETRY_MS, RECORD_RETRY_MAX_MS)));
    expect(h.ledger.get(ref!)).toMatchObject({ recordPending: true, recordAttempts: 10 });
    expect(h.ledger.get(ref!)!.transcript).toBeDefined();
    h.service.stop();
  });
});
