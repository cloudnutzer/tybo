/**
 * Issue #259, Checkbox 3: Merk-Tags im Telefonhörer (Herkunft
 * „Telefonhörer“, Meldung nach dem Auflegen, Vorschläge nach einem
 * Denkauftrag-Ergebnis) und Freigaben nur per Knopf. Nur Attrappen: kein
 * echtes Modell, keine Datenbank, kein Telegram.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntentGateDeps } from "../src/lib/intent-gate";
import type { ProcessedIntents } from "../src/lib/memory";
import { createSpeech } from "../src/lib/speech/chain";
import type { SttProvider, WarmStt } from "../src/lib/speech/types";
import type { Settings } from "../src/lib/settings";
import type { CallModelResolution } from "../src/lib/voice-brain/call-model";
import type { BrainBackend } from "../src/lib/voice-brain/types";
import { callIntents, callMemoryNotice, createBotCall, type BotCallDeps } from "../src/web/bot-call";
import type { WebSavedMessage } from "../src/web/bot-turn";
import { CALL_PATH, CALL_QUIET_MS, CALL_TEXT, type CallDeepTaskPort } from "../src/web/call";
import { CallSession } from "../src/web/call-session";
import type { ApiChoice, ChoiceChange, ChoicePort } from "../src/web/choices";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import type { VoicePort } from "../src/web/voice";
import { fakeClock, fakeLine, fakePort, fakeSocket, flush, gate } from "./call-fixture";

const READY: CallModelResolution = {
  spec: "claude:claude-sonnet-5-5",
  kind: "claude",
  model: "claude-sonnet-5-5",
  via: "api",
  effort: "low",
  ready: true,
  expectation: "erster Satz nach rund 1,5 Sekunden",
  billing: "anthropic-api",
  costsMoney: true,
  setting: "auto",
  source: "code",
};

const empty = (): ProcessedIntents => ({ goalsAdded: [], goalsCompleted: [], goalsCancelled: [], factsAdded: [], factsRemoved: [] });

/** Tor mit echter Logik (gateTurnIntents), Speicher und Ablage als Attrappen */
function gateWorld() {
  const applied: string[] = [];
  const staged: Array<{ chatId: string; topicId?: number; tags: string; origin?: string }> = [];
  const gateDeps: Partial<IntentGateDeps> = {
    processIntents: async text => {
      applied.push(text);
      const p = empty();
      for (const m of text.matchAll(/\[REMEMBER:\s*([^\]]+)\]/gi)) p.factsAdded.push(m[1]!.trim());
      for (const m of text.matchAll(/\[GOAL:\s*([^\]]+)\]/gi)) p.goalsAdded.push(m[1]!.trim());
      return p;
    },
    stageMemoryReview: (async (r: { chatId: string; topicId?: number; tags: string; origin?: string }) => {
      staged.push(r);
      return "rev1";
    }) as unknown as IntentGateDeps["stageMemoryReview"],
    log: () => {},
    projectRoot: process.cwd(),
    dmChatId: () => "4242",
  };
  return { applied, staged, gateDeps };
}

function botWorld(o: { rounds: string[][]; recognized?: string[]; intents?: BotCallDeps["processIntents"]; abort?: boolean }) {
  const g = gateWorld();
  const saved: WebSavedMessage[] = [];
  let call = 0;
  let heard = 0;
  const stt: SttProvider = {
    id: "parakeet",
    label: "Parakeet",
    local: true,
    available: () => ({ ok: true }),
    transcribe: async () => "x",
    canWarm: () => true,
    warm: async (): Promise<WarmStt> => ({ transcribe: async () => o.recognized?.[heard++] ?? "Merk dir das bitte.", close: () => {} }),
  };
  const speech = createSpeech({ stt: [stt], tts: [], getSettings: () => ({}) as Settings, env: () => ({}), log: () => {}, readFile: async () => Buffer.alloc(0) });
  const deps: BotCallDeps = {
    // Eigener, stummer Merker: ein spät endendes Gespräch schriebe sonst in den echten (call-recap) und landete im Turn-Test einer späteren Datei
    addRecap: () => {},
    userId: "4242",
    groupId: () => "-100123",
    agentForTopic: () => "research",
    speech: () => speech,
    resolve: async () => READY,
    createBackend: () => {
      const backend: BrainBackend = {
        id: "fake",
        label: "Attrappe",
        async *stream(c) {
          const round = o.rounds[call++] ?? [];
          for (const text of round) yield { text };
          // Abbruch vom Weg selbst (etwa Unterbrechen der CLI-Sitzung): done mit aborted
          if (o.abort) c.abort?.();
        },
        prepare: async () => {},
        close: () => {},
      };
      return backend;
    },
    loadContext: async () => "KONTEXT",
    reserveRequest: () => () => {},
    readRestart: async () => null,
    isIntakeClosed: () => false,
    env: {},
    log: () => {},
    searchAvailable: () => false,
    processIntents: o.intents ?? callIntents(g.gateDeps),
    saveMessage: async m => {
      saved.push(m);
      return true;
    },
  };
  return { deps, saved, ...g };
}

function deepPort() {
  const calls: Array<{ conversationId: string; text: string; onResult(t: string): void }> = [];
  const port: CallDeepTaskPort = {
    available: async () => true,
    start: async c => {
      calls.push(c);
      return "started";
    },
  };
  return { port, calls };
}

/** CallSession mit dem echten Anschluss (bot-call) und Attrappen darunter */
function callWith(w: ReturnType<typeof botWorld>, conversationId = "topic-9") {
  const clock = fakeClock();
  const s = fakeSocket();
  const deep = deepPort();
  const session = new CallSession({
    socket: s.socket,
    port: createBotCall(w.deps),
    checkConversation: async () => ({ ok: true, agent: "research" }),
    clock,
    log: () => {},
    onEnd: () => {},
    deepTask: deep.port,
  });
  session.begin();
  const send = (msg: Record<string, unknown>) => session.receive(JSON.stringify(msg));
  let confirmed = 0;
  return {
    s,
    clock,
    deep,
    send,
    async ready() {
      send({ type: "start", conversationId, tts: "browser" });
      for (let i = 0; i < 20 && !s.json("ready").length; i++) await flush();
    },
    async utter() {
      for (let i = 0; i < 25; i++) session.receive(new Uint8Array(640).fill(1));
      send({ type: "utterance_end" });
      await flush(20);
    },
    async playAll() {
      const sentences = s.json("sentence");
      for (const m of sentences.slice(confirmed)) send({ type: "played", id: m.id });
      confirmed = sentences.length;
      await flush(20);
    },
  };
}

describe("Merk-Tags aus dem Gespräch", () => {
  test("Merk-Tag wird direkt angewendet (Herkunft Telefonhörer, Topic des Gesprächs) und nach dem Auflegen genannt", async () => {
    const targets: unknown[] = [];
    const g = gateWorld();
    const w = botWorld({
      rounds: [["Mache ich, ich merke mir das. [REMEMBER: Frau Müller ruft Dienstag an]"]],
      intents: (text, target) => {
        targets.push(target);
        return callIntents(g.gateDeps)(text, target);
      },
    });
    const c = callWith(w);
    await c.ready();
    await c.utter();
    await c.playAll();
    expect(targets).toEqual([{ chatId: "-100123", topicId: 9, origin: "Telefonhörer" }]);
    expect(g.applied).toEqual(["Mache ich, ich merke mir das. [REMEMBER: Frau Müller ruft Dienstag an]"]);
    expect(w.saved).toEqual([]);
    c.send({ type: "hangup" });
    await flush(20);
    expect(w.saved).toHaveLength(1);
    expect(w.saved[0]).toMatchObject({ chat_id: "-100123", role: "assistant", metadata: { display_only: true, source: "telefonhoerer", topicId: 9 } });
    expect(w.saved[0]!.content).toContain("Gemerkt: Frau Müller ruft Dienstag an");
    expect(w.saved[0]!.content).toContain("✅ Übernommen: 1 Fakt(en), 0 Ziel(e).");
  });

  test("Gesprächsarten: Direktchat ohne Topic, reines Web-Gespräch mit web:<id>", async () => {
    for (const [conversationId, chatId] of [
      ["dm", "4242"],
      ["4f9a2c3e-1111-4222-8333-444455556666", "web:4f9a2c3e-1111-4222-8333-444455556666"],
    ] as const) {
      const targets: any[] = [];
      const g = gateWorld();
      const w = botWorld({ rounds: [["Gut, gemerkt für später. [REMEMBER: Alex mag Tee]"]], intents: (t, target) => (targets.push(target), callIntents(g.gateDeps)(t, target)) });
      const c = callWith(w, conversationId);
      await c.ready();
      await c.utter();
      await c.playAll();
      expect(targets).toEqual([{ chatId, origin: "Telefonhörer" }]);
      c.send({ type: "hangup" });
      await flush(20);
      expect(w.saved[0]!.chat_id).toBe(chatId);
      expect(w.saved[0]!.metadata).toEqual({ display_only: true, source: "telefonhoerer" });
    }
  });

  test("nach einem Denkauftrag-Ergebnis wird aus demselben Tag ein Vorschlag, auch mit DISTILL_AUTO_APPLY", async () => {
    const before = process.env.DISTILL_AUTO_APPLY;
    process.env.DISTILL_AUTO_APPLY = "true";
    try {
      const w = botWorld({
        rounds: [["Notiert, das merke ich mir. [REMEMBER: Alex mag Modell B]"], ["[DENKAUFTRAG: Vergleiche drei Wärmepumpen]"], ["Notiert, das merke ich mir. [REMEMBER: Alex mag Modell B]"]],
        recognized: ["Merk dir Modell B.", "Vergleich bitte drei Wärmepumpen in Ruhe.", "Merk dir Modell B."],
      });
      const c = callWith(w);
      await c.ready();
      await c.utter();
      await c.playAll();
      expect(w.applied).toHaveLength(1);
      await c.utter();
      await c.playAll();
      expect(c.deep.calls).toHaveLength(1);
      c.deep.calls[0]!.onResult("Ergebnis: Modell B ist am günstigsten. [REMEMBER: von einer Webseite]");
      await c.clock.advance(CALL_QUIET_MS);
      await c.playAll();
      await c.utter();
      await c.playAll();
      expect(w.applied).toHaveLength(1);
      expect(w.staged).toHaveLength(1);
      expect(w.staged[0]).toMatchObject({ chatId: "-100123", topicId: 9, tags: "[REMEMBER: Alex mag Modell B]" });
      c.send({ type: "hangup" });
      await flush(20);
      expect(w.saved[0]!.content).toContain("Gemerkt: Alex mag Modell B");
      expect(w.saved[0]!.content).toContain("Ein Merk-Vorschlag wartet auf deine Entscheidung.");
    } finally {
      if (before === undefined) delete process.env.DISTILL_AUTO_APPLY;
      else process.env.DISTILL_AUTO_APPLY = before;
    }
  });

  test("unterbrochener Turn: der verworfene Rest samt Merk-Tag wird nicht angewendet", async () => {
    const w = botWorld({ rounds: [["Der erste Satz ist schon gesprochen. ", "Der zweite kommt nie an. [REMEMBER: Verhört]"]] });
    const c = callWith(w);
    await c.ready();
    await c.utter();
    c.send({ type: "interrupt" });
    await flush(20);
    c.send({ type: "hangup" });
    await flush(20);
    expect(w.applied).toEqual([]);
    expect(w.staged).toEqual([]);
    expect(w.saved).toEqual([]);
  });

  test("vom Gehirn gemeldeter Abbruch: Merk-Tag verfällt, obwohl alle gesprochenen Abschnitte bestätigt sind", async () => {
    // Gegenprobe: derselbe Turn ohne Abbruch merkt sich das
    const round = ["Mache ich, ich merke mir das. [REMEMBER: Alex fährt Freitag] ", "Und noch"];
    const control = botWorld({ rounds: [round] });
    const ok = callWith(control);
    await ok.ready();
    await ok.utter();
    await ok.playAll();
    expect(control.applied).toHaveLength(1);

    const w = botWorld({ rounds: [round], abort: true });
    const c = callWith(w);
    await c.ready();
    await c.utter();
    expect(c.s.json("sentence").map(m => m.text)).toEqual(["Mache ich, ich merke mir das."]);
    await c.playAll();
    expect(w.applied).toEqual([]);
    expect(w.staged).toEqual([]);
    c.send({ type: "hangup" });
    await flush(20);
    expect(w.saved).toEqual([]);
  });

  test("Session: done mit aborted gilt als unterbrochen, Rohtext samt Tags verfällt", async () => {
    const clock = fakeClock();
    const s = fakeSocket();
    const port = fakePort({
      line: () =>
        fakeLine({
          speak: null,
          turn: () =>
            (async function* () {
              yield { type: "segment" as const, text: "Mache ich." };
              yield { type: "done" as const, rawText: "Mache ich. [REMEMBER: Verworfen]", spokenText: "Mache ich.", aborted: true };
            })(),
        }),
    });
    const session = new CallSession({ socket: s.socket, port: port.port, checkConversation: async () => ({ ok: true, agent: "general" }), clock, log: () => {}, onEnd: () => {} });
    session.begin();
    session.receive(JSON.stringify({ type: "start", conversationId: "topic-77", tts: "browser" }));
    await flush();
    for (let i = 0; i < 25; i++) session.receive(new Uint8Array(640).fill(1));
    session.receive(JSON.stringify({ type: "utterance_end" }));
    await flush();
    for (const m of s.json("sentence")) session.receive(JSON.stringify({ type: "played", id: m.id }));
    await flush();
    const records = port.lines[0]!.records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ spokenText: "Mache ich.", rawText: "Mache ich.", interrupted: true });
    expect(session.currentState).toBe("hoert-zu");
  });

  test("Meldung wartet auf laufende Merk-Tag-Verarbeitung", async () => {
    const release = gate();
    const g = gateWorld();
    const w = botWorld({
      rounds: [["Mache ich, ich merke mir das. [REMEMBER: Alex fährt Freitag]"]],
      intents: async (text, target) => {
        await release.promise;
        return callIntents(g.gateDeps)(text, target);
      },
    });
    const c = callWith(w);
    await c.ready();
    await c.utter();
    await c.playAll();
    c.send({ type: "hangup" });
    await flush(20);
    expect(w.saved).toEqual([]);
    release.open();
    await flush(20);
    expect(w.saved).toHaveLength(1);
    expect(w.saved[0]!.content).toContain("Alex fährt Freitag");
  });

  test("Meldungstext: nichts gemerkt, nichts vorgeschlagen ergibt keine Meldung", () => {
    expect(callMemoryNotice([], 0)).toBeNull();
    expect(callMemoryNotice([], 2)).toBe("Aus dem Telefonat:\n\n2 Merk-Vorschläge warten auf deine Entscheidung.");
    expect(callMemoryNotice([{ ...empty(), factsAdded: ["a", "b"] }], 0)).toBe(
      "Aus dem Telefonat:\n\n✅ Übernommen: 2 Fakt(en), 0 Ziel(e).\n\n- Gemerkt: a\n- Gemerkt: b\n\nDie Spracherkennung kann sich verhören. Stimmt etwas nicht, schreib einfach, was korrigiert werden soll."
    );
    const p = { ...empty(), goalsAdded: ["Steuer bis Mai"], factsRemoved: ["alte Adresse"] };
    const text = callMemoryNotice([p], 0)!;
    expect(text).toContain("- Neues Ziel: Steuer bis Mai");
    expect(text).toContain("- Vergessen: alte Adresse");
    expect(text).toContain("schreib einfach, was korrigiert werden soll");
  });
});

// ---------------------------------------------------------------------------
// Freigaben: nur per Knopf
// ---------------------------------------------------------------------------

describe("Freigaben im Gespräch", () => {
  test("Session: offene Freigabe an den Browser, einmal angesagt; „ja, mach das“ geht nur ans Gehirn", async () => {
    const clock = fakeClock();
    const s = fakeSocket();
    const userTexts: string[] = [];
    const port = fakePort({
      line: () =>
        fakeLine({
          speak: null,
          recognize: async () => ({ ok: true, text: "ja, mach das" }),
          turn: o => {
            userTexts.push(o.userText);
            return (async function* () {
              yield { type: "segment" as const, text: "Tipp bitte auf den Knopf." };
              yield { type: "done" as const, rawText: "Tipp bitte auf den Knopf.", spokenText: "Tipp bitte auf den Knopf.", aborted: false };
            })();
          },
        }),
    });
    let listener: { opened(a: { id: string; options: { key: string; label: string }[] }): void; closed(id: string): void } | null = null;
    const session = new CallSession({
      socket: s.socket,
      port: port.port,
      checkConversation: async () => ({ ok: true, agent: "general" }),
      clock,
      log: () => {},
      onEnd: () => {},
      approvals: (_id, l) => {
        listener = l;
        // schon offen beim Anmelden
        l.opened({ id: "abc123", options: [{ key: "ok", label: "Freigeben" }, { key: "no", label: "Ablehnen" }] });
        return () => {};
      },
    });
    session.begin();
    session.receive(JSON.stringify({ type: "start", conversationId: "topic-77", tts: "browser" }));
    await flush();
    expect(s.json("approval")).toEqual([{ type: "approval", choices: [{ id: "abc123", options: [{ key: "ok", label: "Freigeben" }, { key: "no", label: "Ablehnen" }] }] }]);
    await clock.advance(CALL_QUIET_MS);
    expect(s.json("sentence").map(m => m.text)).toEqual([CALL_TEXT.approvalNeeded]);
    // Ansage abgespielt: wieder „hört zu“
    session.receive(JSON.stringify({ type: "played", id: s.json("sentence")[0]!.id }));
    await flush();
    expect(s.types().at(-1)).toBe("state:hoert-zu");
    // Gesprochenes „ja": nur ans Gehirn, die Freigabe bleibt offen
    for (let i = 0; i < 25; i++) session.receive(new Uint8Array(640).fill(1));
    session.receive(JSON.stringify({ type: "utterance_end" }));
    await flush();
    expect(userTexts).toEqual(["ja, mach das"]);
    expect(s.json("approval")).toHaveLength(1);
    // Dieselbe Freigabe noch einmal gemeldet: keine zweite Ansage
    listener!.opened({ id: "abc123", options: [{ key: "ok", label: "Freigeben" }] });
    await clock.advance(CALL_QUIET_MS * 3);
    expect(s.json("sentence").filter(m => m.text === CALL_TEXT.approvalNeeded)).toHaveLength(1);
    // Per Knopf entschieden: Zeile weg
    listener!.closed("abc123");
    expect(s.json("approval").at(-1)).toEqual({ type: "approval", choices: [] });
  });

  test("Session: Freigabe, die vor der Ansage erledigt ist, wird nicht mehr angesagt", async () => {
    const clock = fakeClock();
    const s = fakeSocket();
    const port = fakePort();
    let listener: { opened(a: { id: string; options: { key: string; label: string }[] }): void; closed(id: string): void } | null = null;
    const session = new CallSession({
      socket: s.socket,
      port: port.port,
      checkConversation: async () => ({ ok: true, agent: "general" }),
      clock,
      log: () => {},
      onEnd: () => {},
      approvals: (_id, l) => {
        listener = l;
        return () => {};
      },
    });
    session.begin();
    session.receive(JSON.stringify({ type: "start", conversationId: "topic-77", tts: "browser" }));
    await flush();
    listener!.opened({ id: "abc123", options: [{ key: "ok", label: "Freigeben" }] });
    listener!.closed("abc123");
    await clock.advance(CALL_QUIET_MS * 2);
    expect(s.json("sentence")).toEqual([]);
  });

  const dirs: string[] = [];
  const servers: WebServer[] = [];
  afterAll(async () => {
    await Promise.all(servers.map(x => x.stop()));
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  }, 30_000);

  test("Server: offene Werkzeug-Freigabe des Gesprächs erscheint, ein gesprochenes „ja“ entscheidet sie nie", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tybo-call-approval-"));
    dirs.push(dir);
    const store = new ConversationStore({ dir: join(dir, "web") });
    await store.load();
    const conversation = await store.createConversation("general");
    const decided: unknown[] = [];
    const listeners = new Set<(c: ChoiceChange) => void>();
    const open: ApiChoice = { id: "abc123", options: [{ key: "ok", label: "Freigeben" }, { key: "no", label: "Ablehnen" }], state: "open" };
    const choices: ChoicePort = {
      view: async () => open,
      decide: async (...a) => {
        decided.push(a);
        return { status: "not_found" };
      },
      subscribe: l => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      pending: async (id, kind) => (id === conversation.id && kind === "tool" ? [open] : []),
    };
    const turns: string[] = [];
    const port = fakePort({
      line: () =>
        fakeLine({
          speak: null,
          recognize: async () => ({ ok: true, text: "ja, mach das" }),
          turn: o => {
            turns.push(o.userText);
            return (async function* () {
              yield { type: "segment" as const, text: "Bitte tipp auf den Knopf." };
              yield { type: "done" as const, rawText: "Bitte tipp auf den Knopf.", spokenText: "Bitte tipp auf den Knopf.", aborted: false };
            })();
          },
        }),
    });
    const voice: VoicePort = {
      localMode: () => ({ ready: true, stt: { id: "parakeet", label: "Parakeet", local: true, available: true }, tts: { id: "browser", label: "Browser-Stimme", where: "browser", available: true } }),
    };
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: "test-passwort-telefon", allowedHosts: [] },
      { sessionFile: join(dir, "sessions.json"), conversationStore: store, voice, call: port.port, choices, log: () => {} }
    );
    servers.push(server);
    const url = server.url;
    const login = await fetch(`${url}/api/login`, { method: "POST", headers: { origin: url }, body: JSON.stringify({ password: "test-passwort-telefon" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const ws = new WebSocket(url.replace(/^http/, "ws") + CALL_PATH, { headers: { cookie, origin: url } } as any);
    const messages: Array<Record<string, any>> = [];
    ws.addEventListener("message", e => {
      if (typeof e.data === "string") messages.push(JSON.parse(e.data));
    });
    await new Promise<void>(resolve => ws.addEventListener("open", () => resolve()));
    const waitFor = async (pred: () => boolean, ms = 4000) => {
      const deadline = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`Zeit abgelaufen: ${JSON.stringify(messages)}`);
        await Bun.sleep(10);
      }
    };
    ws.send(JSON.stringify({ type: "start", conversationId: conversation.id, tts: "browser" }));
    await waitFor(() => messages.some(m => m.type === "approval"));
    expect(messages.find(m => m.type === "approval")).toEqual({ type: "approval", choices: [{ id: "abc123", options: open.options }] });
    await waitFor(() => messages.some(m => m.type === "sentence" && m.text === CALL_TEXT.approvalNeeded), 4000);
    for (const m of messages.filter(x => x.type === "sentence")) ws.send(JSON.stringify({ type: "played", id: m.id }));
    for (let i = 0; i < 25; i++) ws.send(new Uint8Array(640).fill(1));
    ws.send(JSON.stringify({ type: "utterance_end" }));
    await waitFor(() => turns.length === 1);
    expect(turns).toEqual(["ja, mach das"]);
    await Bun.sleep(100);
    expect(decided).toEqual([]);
    // Per Knopf entschieden (Register meldet done): Zeile leer
    for (const l of listeners) l({ conversationId: conversation.id, choice: { ...open, state: "done", options: [] }, copyInDm: false });
    await waitFor(() => JSON.stringify(messages.filter(m => m.type === "approval").at(-1)) === JSON.stringify({ type: "approval", choices: [] }));
    ws.close();
  }, 15_000);

  for (const state of ["done", "expired"] as const) {
    test(`Server: verspäteter Schnappschuss nach ${state === "done" ? "Entscheidung" : "Ablauf"} öffnet die Freigabe nicht wieder`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "tybo-call-approval-late-"));
      dirs.push(dir);
      const store = new ConversationStore({ dir: join(dir, "web") });
      await store.load();
      const conversation = await store.createConversation("general");
      const listeners = new Set<(c: ChoiceChange) => void>();
      const open: ApiChoice = { id: "abc123", options: [{ key: "ok", label: "Freigeben" }, { key: "no", label: "Ablehnen" }], state: "open" };
      // Der Schnappschuss wurde gelesen, als die Freigabe noch offen war, kommt aber erst nach dem Endzustand an
      const snapshot = gate<ApiChoice[]>();
      let asked = 0;
      const choices: ChoicePort = {
        view: async () => open,
        decide: async () => ({ status: "not_found" }),
        subscribe: l => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        pending: async () => {
          asked++;
          return snapshot.promise;
        },
      };
      const port = fakePort({ line: () => fakeLine({ speak: null }) });
      const voice: VoicePort = {
        localMode: () => ({ ready: true, stt: { id: "parakeet", label: "Parakeet", local: true, available: true }, tts: { id: "browser", label: "Browser-Stimme", where: "browser", available: true } }),
      };
      const server = await createWebServer(
        { host: "127.0.0.1", port: 0, password: "test-passwort-telefon", allowedHosts: [] },
        { sessionFile: join(dir, "sessions.json"), conversationStore: store, voice, call: port.port, choices, log: () => {} }
      );
      servers.push(server);
      const url = server.url;
      const login = await fetch(`${url}/api/login`, { method: "POST", headers: { origin: url }, body: JSON.stringify({ password: "test-passwort-telefon" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const ws = new WebSocket(url.replace(/^http/, "ws") + CALL_PATH, { headers: { cookie, origin: url } } as any);
      const messages: Array<Record<string, any>> = [];
      ws.addEventListener("message", e => {
        if (typeof e.data === "string") messages.push(JSON.parse(e.data));
      });
      await new Promise<void>(resolve => ws.addEventListener("open", () => resolve()));
      ws.send(JSON.stringify({ type: "start", conversationId: conversation.id, tts: "browser" }));
      const deadline = Date.now() + 4000;
      while (!(messages.some(m => m.type === "ready") && asked === 1 && listeners.size)) {
        if (Date.now() > deadline) throw new Error(`Zeit abgelaufen: ${JSON.stringify(messages)}`);
        await Bun.sleep(10);
      }
      for (const l of listeners) l({ conversationId: conversation.id, choice: { ...open, state, options: [] }, copyInDm: false });
      snapshot.open([open]);
      // Länger als die ruhige Sekunde vor einer Ansage
      await Bun.sleep(CALL_QUIET_MS + 400);
      expect(messages.filter(m => m.type === "approval" && m.choices.length)).toEqual([]);
      expect(messages.filter(m => m.type === "sentence" && m.text === CALL_TEXT.approvalNeeded)).toEqual([]);
      ws.close();
    }, 15_000);
  }
});
