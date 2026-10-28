/**
 * Issue #259, Checkbox 2: Werkzeuge im Telefonhörer-Gespräch. Ansagen in der
 * CallSession, Denkauftrag als Turn im selben Gespräch (ChatHub mit
 * Warteschlange, nichts nach Telegram), Meldung bei fertigem Denkauftrag,
 * Suche über die Registry im Anschluss (bot-call). Nur Attrappen: kein echtes
 * Modell, keine Datenbank, kein Telegram.
 */
import { describe, expect, test } from "bun:test";
import { createSpeech } from "../src/lib/speech/chain";
import type { SttProvider, WarmStt } from "../src/lib/speech/types";
import type { Settings } from "../src/lib/settings";
import type { CallModelResolution } from "../src/lib/voice-brain/call-model";
import type { BrainBackend, BrainCall } from "../src/lib/voice-brain/types";
import { createBotCall, type BotCallDeps } from "../src/web/bot-call";
import { createTelegramChat, type TelegramChatDeps } from "../src/web/bot-turn";
import { CALL_QUIET_MS, CALL_TEXT, CALL_TOOL_TEXT, type CallDeepTaskPort, type CallTurnEvent } from "../src/web/call";
import { CallSession, PLAYED_GRACE_MS } from "../src/web/call-session";
import { ChatHub, type RunTurnOptions, type TurnResult } from "../src/web/chat";
import { createTelegramMessageLog } from "../src/web/telegram";
import { fakeClock, fakeLine, fakePort, fakeSocket, flush, gate, type FakeLineOptions } from "./call-fixture";

// ---------------------------------------------------------------------------
// CallSession
// ---------------------------------------------------------------------------

interface DeepCall {
  conversationId: string;
  text: string;
  onResult(text: string): void;
}

function fakeDeepTask(o: { available?: boolean; status?: "started" | "queued" | "unavailable" } = {}) {
  const calls: DeepCall[] = [];
  const port: CallDeepTaskPort = {
    available: async () => o.available !== false,
    start: async c => {
      calls.push(c);
      return o.status ?? "started";
    },
  };
  return { port, calls };
}

function setup(o: { line?: FakeLineOptions; deep?: ReturnType<typeof fakeDeepTask> | null; tts?: "server" | "browser" } = {}) {
  const clock = fakeClock();
  const s = fakeSocket();
  const port = fakePort({ line: () => fakeLine(o.line) });
  const deep = o.deep === undefined ? fakeDeepTask() : o.deep;
  const approvalListeners: Array<{ opened(a: { id: string; options: { key: string; label: string }[] }): void; closed(id: string): void }> = [];
  let unwatched = 0;
  const session = new CallSession({
    socket: s.socket,
    port: port.port,
    checkConversation: async () => ({ ok: true, agent: "general" }),
    clock,
    log: () => {},
    onEnd: () => {},
    ...(deep ? { deepTask: deep.port } : {}),
    approvals: (_id, listener) => {
      approvalListeners.push(listener);
      return () => void unwatched++;
    },
  });
  session.begin();
  const send = (msg: Record<string, unknown>) => session.receive(JSON.stringify(msg));
  const ready = async () => {
    send({ type: "start", conversationId: "topic-77", tts: o.tts ?? "browser" });
    await flush();
  };
  const utter = async () => {
    for (let i = 0; i < 25; i++) session.receive(new Uint8Array(640).fill(1));
    send({ type: "utterance_end" });
    await flush();
  };
  /** Alle gesendeten Abschnitte bestätigen (Browser-Stimme) */
  const playAll = async () => {
    for (const m of s.json("sentence")) send({ type: "played", id: m.id });
    await flush();
  };
  return { clock, s, port, session, send, ready, utter, playAll, deep, approvalListeners, unwatched: () => unwatched, line: () => port.lines[0]! };
}

describe("Ansagen der Werkzeuge", () => {
  test("Suche: tool an den Browser, „Moment, ich schaue nach.“ vor der Antwort, danach wieder „denkt“ mit Werkzeug", async () => {
    const result = gate();
    const t = setup({
      line: {
        turn: async function* (): AsyncGenerator<CallTurnEvent> {
          yield { type: "tool", name: "suche", phase: "start" };
          await result.promise;
          yield { type: "segment", text: "Die Küchenfront ist salbeigrün." };
          yield { type: "done", rawText: "[SUCHE: Küche]Die Küchenfront ist salbeigrün.", spokenText: "Die Küchenfront ist salbeigrün.", aborted: false };
        },
      },
    });
    await t.ready();
    await t.utter();
    expect(t.s.json("tool")).toEqual([
      { type: "tool", name: "suche" },
      // Satz gesprochen, Suche läuft noch: Ansicht wieder bei „denkt“ mit „schaut nach …“
      { type: "tool", name: "suche" },
    ]);
    expect(t.s.json("sentence").map(m => m.text)).toEqual([CALL_TOOL_TEXT.searchAck]);
    expect(t.s.types().at(-1)).toBe("tool");
    expect(t.s.types().at(-2)).toBe("state:denkt");
    result.open();
    await flush();
    expect(t.s.json("sentence").map(m => m.text)).toEqual([CALL_TOOL_TEXT.searchAck, "Die Küchenfront ist salbeigrün."]);
    await t.playAll();
    expect(t.line().records).toHaveLength(1);
    expect(t.line().records[0]).toMatchObject({ spokenText: `${CALL_TOOL_TEXT.searchAck} Die Küchenfront ist salbeigrün.`, interrupted: false });
  });

  test("Verlauf: nach einem vollständigen Turn mit Suche stehen Tag und Ergebnis zwischen Frage und Antwort", async () => {
    const histories: unknown[][] = [];
    let n = 0;
    const t = setup({
      line: {
        turn: async function* (): AsyncGenerator<CallTurnEvent> {
          n++;
          if (n === 1) {
            yield { type: "tool", name: "suche", phase: "start" };
            yield { type: "segment", text: "Salbeigrün." };
            yield {
              type: "done",
              rawText: "[SUCHE: Küche]Salbeigrün.",
              spokenText: "Salbeigrün.",
              aborted: false,
              toolMessages: [
                { role: "assistant", content: "[SUCHE: Küche]" },
                { role: "user", content: "[Suchergebnis, nicht vom Nutzer gesprochen]\nKüche: salbeigrün" },
              ],
            };
            return;
          }
          yield { type: "segment", text: "Gern." };
          yield { type: "done", rawText: "Gern.", spokenText: "Gern.", aborted: false };
        },
      },
    });
    await t.ready();
    const line = t.line().line;
    const original = line.turn;
    line.turn = o => {
      histories.push(o.history.map(m => ({ ...m })));
      return original(o);
    };
    await t.utter();
    await t.playAll();
    await t.utter();
    expect(histories[1]).toEqual([
      { role: "user", content: "Wie geht es dir heute?" },
      { role: "assistant", content: "[SUCHE: Küche]" },
      { role: "user", content: "[Suchergebnis, nicht vom Nutzer gesprochen]\nKüche: salbeigrün" },
      { role: "assistant", content: `${CALL_TOOL_TEXT.searchAck} Salbeigrün.` },
    ]);
  });

  test("Rechnen: tool an den Browser, aber kein fester Satz", async () => {
    const t = setup({
      line: {
        turn: async function* (): AsyncGenerator<CallTurnEvent> {
          yield { type: "tool", name: "rechne", phase: "start" };
          yield { type: "segment", text: "Das sind 441 Euro." };
          yield { type: "done", rawText: "[RECHNE: 18 % von 2.450]Das sind 441 Euro.", spokenText: "Das sind 441 Euro.", aborted: false };
        },
      },
    });
    await t.ready();
    await t.utter();
    expect(t.s.json("tool")).toEqual([{ type: "tool", name: "rechne" }]);
    expect(t.s.json("sentence").map(m => m.text)).toEqual(["Das sind 441 Euro."]);
  });
});

function deepTurn(task = "Vergleiche drei Wärmepumpen"): FakeLineOptions["turn"] {
  return async function* (): AsyncGenerator<CallTurnEvent> {
    yield { type: "tool", name: "denkauftrag", phase: "start" };
    yield { type: "tool", name: "denkauftrag", phase: "call", task };
    yield { type: "done", rawText: `[DENKAUFTRAG: ${task}]`, spokenText: "", aborted: false };
  };
}

describe("Denkauftrag", () => {
  test("Ansage, Auftrag im Gespräch des Telefonats mit vollständigem Text, Sitzung bietet ihn beim Öffnen an", async () => {
    const t = setup({ line: { turn: deepTurn() } });
    await t.ready();
    await t.utter();
    expect(t.s.json("sentence").map(m => m.text)).toEqual([CALL_TOOL_TEXT.deepAck]);
    expect(t.deep!.calls).toHaveLength(1);
    expect(t.deep!.calls[0]!.conversationId).toBe("topic-77");
    expect(t.deep!.calls[0]!.text).toBe("Denkauftrag aus dem Telefongespräch: Vergleiche drei Wärmepumpen\n\nAntworte hier im Gespräch.");
  });

  test("fertige Antwort: in der nächsten ruhigen Sekunde genau einmal angesagt, nächster Turn bekommt 1.500 Zeichen als Block, ab dann fremde Inhalte", async () => {
    const userTexts: string[] = [];
    let first = true;
    const t = setup({
      line: {
        turn: o => {
          userTexts.push(o.context ? `${o.context}\n\n${o.userText}` : o.userText);
          if (first) {
            first = false;
            return deepTurn()();
          }
          return (async function* (): AsyncGenerator<CallTurnEvent> {
            yield { type: "segment", text: "Kurz: Modell B ist am günstigsten." };
            yield { type: "done", rawText: "Kurz: Modell B ist am günstigsten. [REMEMBER: Alex will Modell B]", spokenText: "Kurz: Modell B ist am günstigsten.", aborted: false };
          })();
        },
      },
    });
    await t.ready();
    await t.utter();
    await t.playAll();
    expect(t.line().records[0]!.foreignInput).toBeUndefined();
    const answer = "Ergebnis: " + "x".repeat(3000);
    t.deep!.calls[0]!.onResult(answer);
    // Ein zweites Ergebnis desselben Auftrags zählt nicht
    t.deep!.calls[0]!.onResult(answer);
    const before = t.s.json("sentence").length;
    await t.clock.advance(CALL_QUIET_MS - 1);
    expect(t.s.json("sentence").length).toBe(before);
    await t.clock.advance(1);
    const said = t.s.json("sentence").slice(before).map(m => m.text);
    expect(said).toEqual([CALL_TEXT.deepResultReady]);
    await t.clock.advance(10 * CALL_QUIET_MS);
    expect(t.s.json("sentence").slice(before).map(m => m.text)).toEqual([CALL_TEXT.deepResultReady]);
    // „Fass es mir kurz zusammen“
    await t.utter();
    expect(userTexts[1]!.startsWith(`${CALL_TOOL_TEXT.deepResultLabel}\n${answer.slice(0, 1500)}\n${CALL_TOOL_TEXT.deepResultEnd}\n\n`)).toBe(true);
    expect(userTexts[1]).not.toContain(answer.slice(0, 1501));
    await t.playAll();
    expect(t.line().records[1]).toMatchObject({ userText: "Wie geht es dir heute?", foreignInput: CALL_TOOL_TEXT.foreignReason });
    // Der Block kommt nur einmal, fremde Inhalte gelten bis zum Auflegen
    await t.utter();
    expect(userTexts[2]).toBe("Wie geht es dir heute?");
    await t.playAll();
    expect(t.line().records[2]!.foreignInput).toBe(CALL_TOOL_TEXT.foreignReason);
  });

  test("Ansage wartet, solange tybo spricht oder der Nutzer redet", async () => {
    const t = setup({ line: { turn: deepTurn() } });
    await t.ready();
    await t.utter();
    // Ansage des Denkauftrags noch nicht bestätigt: Turn läuft
    t.deep!.calls[0]!.onResult("Fertig.");
    const before = t.s.json("sentence").length;
    await t.clock.advance(CALL_QUIET_MS * 2);
    expect(t.s.json("sentence").length).toBe(before);
    await t.playAll();
    // Nutzer beginnt zu sprechen: noch keine Ansage
    for (let i = 0; i < 5; i++) t.session.receive(new Uint8Array(640).fill(1));
    await t.clock.advance(CALL_QUIET_MS * 2);
    expect(t.s.json("sentence").length).toBe(before);
  });

  test("Antwort nach dem Auflegen: keine Ansage, nichts mehr", async () => {
    const t = setup({ line: { turn: deepTurn() } });
    await t.ready();
    await t.utter();
    await t.playAll();
    t.send({ type: "hangup" });
    await flush();
    const count = t.s.events.length;
    t.deep!.calls[0]!.onResult("Spät, aber fertig.");
    await t.clock.advance(CALL_QUIET_MS * 3);
    expect(t.s.events.length).toBe(count);
    expect(t.unwatched()).toBe(1);
  });

  test("Chat-Kern nicht bereit: kein Angebot beim Öffnen und kein Auftrag; gescheiterter Start wird ehrlich angesagt", async () => {
    const off = setup({ deep: fakeDeepTask({ available: false }), line: { turn: deepTurn() } });
    await off.ready();
    await off.utter();
    expect(off.deep!.calls).toHaveLength(0);
    await off.playAll();
    await off.clock.advance(CALL_QUIET_MS);
    expect(off.s.json("sentence").map(m => m.text)).toEqual([CALL_TOOL_TEXT.deepAck, CALL_TOOL_TEXT.deepUnavailable]);

    const failed = setup({ deep: fakeDeepTask({ status: "unavailable" }), line: { turn: deepTurn() } });
    await failed.ready();
    await failed.utter();
    await failed.playAll();
    await failed.clock.advance(CALL_QUIET_MS);
    expect(failed.s.json("sentence").map(m => m.text)).toEqual([CALL_TOOL_TEXT.deepAck, CALL_TOOL_TEXT.deepUnavailable]);
  });

  test("Sitzung reicht die Bereitschaft an Öffnen und Turn weiter", async () => {
    const seen: Array<boolean | undefined> = [];
    const t = setup({
      line: {
        turn: o => {
          seen.push(o.deepTask);
          return deepTurn()();
        },
      },
    });
    let opened: boolean | undefined;
    const open = t.port.port.open;
    t.port.port.open = async args => {
      opened = args.deepTask;
      return open(args);
    };
    await t.ready();
    await t.utter();
    expect(opened).toBe(true);
    expect(seen).toEqual([true]);
  });
});

describe("Ansagen im Wiedergabe-Ablauf", () => {
  /** Denkauftrag gesprochen und bestätigt, dann ist sein Ergebnis da: die Ansage steht an */
  async function announcing(tts: "browser" | "server") {
    const t = setup({ tts, line: { turn: deepTurn(), ...(tts === "browser" ? { speak: null } : {}) } });
    await t.ready();
    await t.utter();
    await t.playAll();
    expect(t.session.currentState).toBe("hoert-zu");
    t.deep!.calls[0]!.onResult("Fertig.");
    await t.clock.advance(CALL_QUIET_MS);
    const ann = t.s.json("sentence").at(-1)!;
    expect(ann.text).toBe(CALL_TEXT.deepResultReady);
    const types = t.s.types();
    expect(types[types.lastIndexOf("sentence") - 1]).toBe("state:spricht");
    return { t, ann };
  }

  /** Sprache während der Ansage: der Server nimmt nichts an, erkennt nichts */
  async function talkDuring(t: ReturnType<typeof setup>) {
    const before = t.line().recognized.length;
    for (let i = 0; i < 25; i++) t.session.receive(new Uint8Array(640).fill(1));
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.line().recognized.length).toBe(before);
    expect(t.session.currentState).toBe("spricht");
  }

  for (const tts of ["browser", "server"] as const) {
    test(`${tts === "browser" ? "Browser" : "Server"}-Stimme: „spricht“, Aufnahme gesperrt, erst played gibt „hört zu“ zurück`, async () => {
      const { t, ann } = await announcing(tts);
      if (tts === "server") {
        expect(t.s.json("audio_begin").at(-1)).toEqual({ type: "audio_begin", id: ann.id });
        expect(t.s.json("audio_end").at(-1)).toEqual({ type: "audio_end", id: ann.id });
      }
      await talkDuring(t);
      t.send({ type: "played", id: ann.id });
      await flush();
      expect(t.session.currentState).toBe("hoert-zu");
      expect(t.s.types().at(-1)).toBe("state:hoert-zu");
      const before = t.line().recognized.length;
      await t.utter();
      expect(t.line().recognized.length).toBe(before + 1);
    });

    test(`${tts === "browser" ? "Browser" : "Server"}-Stimme: ohne played erst nach Tondauer plus Zuschlag wieder „hört zu“`, async () => {
      const { t } = await announcing(tts);
      // Server: 1.920 Bytes bei 24 kHz sind 40 ms; Browser: 80 ms je Zeichen
      const ms = tts === "server" ? 40 : CALL_TEXT.deepResultReady.length * 80;
      await t.clock.advance(ms + PLAYED_GRACE_MS - 1);
      expect(t.session.currentState).toBe("spricht");
      await t.clock.advance(1);
      expect(t.session.currentState).toBe("hoert-zu");
    });

    test(`${tts === "browser" ? "Browser" : "Server"}-Stimme: interrupt bricht die Ansage ab, danach wird zugehört`, async () => {
      const { t, ann } = await announcing(tts);
      const sentBefore = t.s.events.length;
      t.send({ type: "interrupt" });
      await flush();
      expect(t.s.types().slice(sentBefore)).toEqual(["state:hoert-zu"]);
      // Späte Bestätigung der abgebrochenen Ansage ändert nichts
      t.send({ type: "played", id: ann.id });
      await t.clock.advance(PLAYED_GRACE_MS * 3);
      expect(t.s.json("sentence").filter(m => m.text === CALL_TEXT.deepResultReady)).toHaveLength(1);
      const before = t.line().recognized.length;
      await t.utter();
      expect(t.line().recognized.length).toBe(before + 1);
    });
  }
});

describe("Freigaben: verspätete Meldung", () => {
  test("geschlossene Freigabe wird durch ein späteres opened nicht wieder offen und nicht angesagt", async () => {
    const t = setup();
    await t.ready();
    const l = t.approvalListeners[0]!;
    l.closed("abc123");
    l.opened({ id: "abc123", options: [{ key: "allow", label: "Erlauben" }] });
    await t.clock.advance(CALL_QUIET_MS * 3);
    expect(t.s.json("approval")).toEqual([]);
    expect(t.s.json("sentence")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ChatHub: Warteschlange, Rückmeldung genau dieses Auftrags, kein Telegram
// ---------------------------------------------------------------------------

describe("ChatHub.sendQueued", () => {
  function hubWith(runTurn: (opts: RunTurnOptions) => Promise<TurnResult>, answer?: (...a: unknown[]) => boolean) {
    const seen: RunTurnOptions[] = [];
    const hub = new ChatHub({
      store: createTelegramMessageLog(),
      chat: {
        runTurn: opts => {
          seen.push(opts);
          return runTurn(opts);
        },
        stop() {},
        ...(answer ? { answer } : {}),
      },
    });
    return { hub, seen };
  }

  test("freies Gespräch: startet sofort, ohne Telegram, Rückmeldung mit der Antwort", async () => {
    const { hub, seen } = hubWith(async () => ({ text: "Ausgearbeitet." }));
    const results: string[] = [];
    const r = await hub.sendQueued({ id: "topic-77", agent: "general" }, "Denkauftrag aus dem Telefongespräch: x", { onReply: t => results.push(t) });
    expect(r).toEqual({ status: "started", queued: false });
    await hub.idle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ conversationId: "topic-77", noTelegram: true, text: "Denkauftrag aus dem Telefongespräch: x" });
    expect(results).toEqual(["Ausgearbeitet."]);
  });

  test("belegtes Gespräch reiht ein; die andere Antwort löst keine Rückmeldung aus", async () => {
    const first = gate<TurnResult>();
    const { hub, seen } = hubWith(opts => (opts.text === "getippt" ? first.promise : Promise.resolve({ text: "Antwort auf den Auftrag" })));
    const typed = await hub.send({ id: "topic-77", agent: "general" }, "getippt");
    expect(typed.status).toBe("started");
    await flush();
    const results: string[] = [];
    let status: unknown = null;
    void hub.sendQueued({ id: "topic-77", agent: "general" }, "Auftrag", { onReply: t => results.push(t) }).then(r => (status = r));
    await flush();
    expect(status).toBeNull();
    expect(seen.map(s => s.text)).toEqual(["getippt"]);
    first.open({ text: "Antwort auf das Getippte" });
    await flush();
    await hub.idle();
    expect(status).toEqual({ status: "started", queued: true });
    expect(seen.map(s => s.text)).toEqual(["getippt", "Auftrag"]);
    expect(results).toEqual(["Antwort auf den Auftrag"]);
  });

  test("wartende Rückfrage: der Auftrag ist nie die Antwort darauf, er wartet", async () => {
    const asked = gate();
    const release = gate<TurnResult>();
    const answers: unknown[] = [];
    const { hub, seen } = hubWith(
      async opts => {
        if (opts.text !== "getippt") return { text: "Auftrag erledigt" };
        await opts.ask!("Darf ich die Datei löschen?", "c-0123456789ab");
        asked.open();
        return release.promise;
      },
      (...a) => {
        answers.push(a);
        return true;
      }
    );
    await hub.send({ id: "topic-77", agent: "general" }, "getippt");
    await asked.promise;
    expect(hub.isAwaiting("topic-77")).toBe(true);
    void hub.sendQueued({ id: "topic-77", agent: "general" }, "ja, mach das");
    await flush();
    expect(answers).toEqual([]);
    expect(hub.isAwaiting("topic-77")).toBe(true);
    expect(seen).toHaveLength(1);
    release.open({ text: "fertig" });
    await hub.idle();
    await flush();
    await hub.idle();
    expect(seen.map(s => s.text)).toEqual(["getippt", "ja, mach das"]);
    expect(answers).toEqual([]);
  });

  test("Fehler oder Abbruch: keine Rückmeldung; ohne Chat-Kern unavailable", async () => {
    const { hub } = hubWith(async () => ({ text: "kaputt", failed: true }));
    const results: string[] = [];
    await hub.sendQueued({ id: "topic-77", agent: "general" }, "x", { onReply: t => results.push(t) });
    await hub.idle();
    expect(results).toEqual([]);
    const none = new ChatHub({ store: createTelegramMessageLog() });
    expect(await none.sendQueued({ id: "topic-77", agent: "general" }, "x")).toEqual({ status: "unavailable" });
  });
});

describe("Denkauftrag mit [INVOKE:]-Nacharbeit", () => {
  const RESEARCH = "Research: Modell B kostet 1.200 Euro und ist am leisesten.";

  /** Hauptantwort mit [INVOKE:] und einer Nacharbeit, die auf Freigabe und Arbeit wartet */
  function invokeTurn(o: { fail?: boolean; noAnswer?: boolean } = {}) {
    const approval = gate();
    const work = gate();
    const asked = gate();
    const runTurn = async (opts: RunTurnOptions): Promise<TurnResult> => {
      if (!opts.text.startsWith("Denkauftrag")) return { text: "anderes" };
      return {
        // Lang genug, dass sie allein den gekürzten Sprachkontext füllen würde
        text: `Ich frage Research. [INVOKE:research|Preise?] ${"y".repeat(2000)}`,
        followUp: async out => {
          await out.notice("Research denkt nach …");
          await out.ask!("Freigabe: Datei lesen?", "c-aaaaaaaaaaaa", { record: false });
          asked.open();
          await approval.promise;
          out.endAsk!("c-aaaaaaaaaaaa");
          await work.promise;
          if (out.signal.aborted) return;
          if (o.fail) throw new Error("Befragung gescheitert");
          if (!o.noAnswer) await out.answer(RESEARCH);
        },
      };
    };
    return { runTurn, approval, work, asked };
  }

  function hubPort(runTurn: (opts: RunTurnOptions) => Promise<TurnResult>) {
    const hub = new ChatHub({ store: createTelegramMessageLog(), chat: { runTurn, stop() {} } });
    const calls: DeepCall[] = [];
    // Wie callDeepTask in server.ts
    const port: CallDeepTaskPort = {
      available: async () => true,
      async start(c) {
        calls.push(c);
        const r = await hub.sendQueued({ id: c.conversationId, agent: "general" }, c.text, { onReply: c.onResult });
        if (r.status !== "started") return "unavailable";
        return r.queued ? "queued" : "started";
      },
    };
    return { hub, deep: { port, calls } };
  }

  test("keine Fertigmeldung, solange der befragte Agent arbeitet oder auf Freigabe wartet; danach genau eine, Kontext mit seinem Ergebnis", async () => {
    const inv = invokeTurn();
    const { hub, deep } = hubPort(inv.runTurn);
    const userTexts: string[] = [];
    let first = true;
    const t = setup({
      deep,
      line: {
        turn: o => {
          userTexts.push(o.context ? `${o.context}\n\n${o.userText}` : o.userText);
          if (first) {
            first = false;
            return deepTurn()();
          }
          return (async function* (): AsyncGenerator<CallTurnEvent> {
            yield { type: "segment", text: "Modell B." };
            yield { type: "done", rawText: "Modell B.", spokenText: "Modell B.", aborted: false };
          })();
        },
      },
    });
    await t.ready();
    await t.utter();
    await t.playAll();
    await inv.asked.promise;
    await flush();
    // Hauptantwort gespeichert, Freigabe offen: noch keine Meldung
    expect(hub.isAwaiting("topic-77")).toBe(true);
    const before = t.s.json("sentence").length;
    await t.clock.advance(10 * CALL_QUIET_MS);
    expect(t.s.json("sentence").slice(before).map(m => m.text)).toEqual([]);
    // Freigegeben, Agent arbeitet noch: weiter keine Meldung
    inv.approval.open();
    await flush();
    expect(hub.isAwaiting("topic-77")).toBe(false);
    await t.clock.advance(10 * CALL_QUIET_MS);
    expect(t.s.json("sentence").slice(before).map(m => m.text)).toEqual([]);
    // Fertig: genau eine Meldung
    inv.work.open();
    await hub.idle();
    await t.clock.advance(CALL_QUIET_MS);
    await t.clock.advance(10 * CALL_QUIET_MS);
    expect(t.s.json("sentence").slice(before).map(m => m.text)).toEqual([CALL_TEXT.deepResultReady]);
    // Der nächste Turn sieht das Ergebnis des befragten Agenten im gekürzten Block
    await t.utter();
    expect(userTexts[1]!.startsWith(`${CALL_TOOL_TEXT.deepResultLabel}\n${RESEARCH}\n\nIch frage Research.`)).toBe(true);
  });

  for (const c of [
    { name: "Fehler der Nacharbeit", inv: { fail: true } },
    { name: "keine Antwort des befragten Agenten", inv: { noAnswer: true } },
  ]) {
    test(`${c.name}: keine Rückmeldung`, async () => {
      const inv = invokeTurn(c.inv);
      const { hub } = hubPort(inv.runTurn);
      const results: string[] = [];
      await hub.sendQueued({ id: "topic-77", agent: "general" }, "Denkauftrag aus dem Telefongespräch: x", { onReply: r => results.push(r) });
      await inv.asked.promise;
      inv.approval.open();
      inv.work.open();
      await hub.idle();
      expect(results).toEqual([]);
    });
  }

  test("Stopp während der Nacharbeit: keine Rückmeldung", async () => {
    const inv = invokeTurn();
    const { hub } = hubPort(inv.runTurn);
    const results: string[] = [];
    await hub.sendQueued({ id: "topic-77", agent: "general" }, "Denkauftrag aus dem Telefongespräch: x", { onReply: r => results.push(r) });
    await inv.asked.promise;
    inv.approval.open();
    await flush();
    expect(hub.stop("topic-77")).toBe(true);
    inv.work.open();
    await hub.idle();
    expect(results).toEqual([]);
  });

  test("Gegenprobe: dieselbe Nacharbeit mit Antwort meldet genau einmal, Ergebnis vorn", async () => {
    const inv = invokeTurn();
    const { hub } = hubPort(inv.runTurn);
    const results: string[] = [];
    await hub.sendQueued({ id: "topic-77", agent: "general" }, "Denkauftrag aus dem Telefongespräch: x", { onReply: r => results.push(r) });
    await inv.asked.promise;
    expect(results).toEqual([]);
    inv.approval.open();
    await flush();
    expect(results).toEqual([]);
    inv.work.open();
    await hub.idle();
    expect(results).toHaveLength(1);
    expect(results[0]!.startsWith(`${RESEARCH}\n\nIch frage Research.`)).toBe(true);
  });
});

describe("Denkauftrag geht nicht nach Telegram", () => {
  function telegramDeps(): { deps: TelegramChatDeps; plain: unknown[]; asAgent: unknown[]; saved: any[] } {
    const plain: unknown[] = [];
    const asAgent: unknown[] = [];
    const saved: any[] = [];
    const deps: TelegramChatDeps = {
      runStreamingTurn: async () => "Ausgearbeitet: Modell B.",
      saveMessage: async m => {
        saved.push(m);
        return true;
      },
      processIntents: async () => {},
      abortEngineCalls: () => 0,
      isShuttingDown: () => false,
      scheduleRestartCheck: () => {},
      log: () => {},
      userId: "4242",
      groupId: () => "-100123",
      agentForTopic: () => "research",
      sendPlain: async (...a: unknown[]) => void plain.push(a),
      sendAsAgent: async (...a: unknown[]) => void asAgent.push(a),
    } as TelegramChatDeps;
    return { deps, plain, asAgent, saved };
  }
  const sink = { progress() {}, notice() {} };

  for (const conversationId of ["topic-9", "dm"]) {
    test(`${conversationId}: mit noTelegram weder Spiegel noch Antwort in Telegram, aber im Speicher des Gesprächs`, async () => {
      const w = telegramDeps();
      const chat = createTelegramChat(w.deps);
      const result = await chat.runTurn({ conversationId, agent: "research", text: "Denkauftrag aus dem Telefongespräch: x", sink, noTelegram: true });
      expect(result.text).toBe("Ausgearbeitet: Modell B.");
      expect(w.plain).toEqual([]);
      expect(w.asAgent).toEqual([]);
      expect(w.saved.map(m => m.role)).toEqual(["user", "assistant"]);
      expect(w.saved[0].chat_id).toBe(conversationId === "dm" ? "4242" : "-100123");
    });

    test(`${conversationId}: ohne noTelegram wie bisher gespiegelt (Gegenprobe)`, async () => {
      const w = telegramDeps();
      const chat = createTelegramChat(w.deps);
      await chat.runTurn({ conversationId, agent: "research", text: "getippt", sink });
      expect(w.plain).toHaveLength(1);
      expect(w.asAgent).toHaveLength(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Anschluss: Suche über die Registry, Sprechstil nach Bereitschaft
// ---------------------------------------------------------------------------

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

function botWorld(o: { rounds: string[][]; search?: (q: string) => Promise<string>; searchAvailable?: boolean }) {
  const calls: BrainCall[] = [];
  const prepared: string[] = [];
  const searches: string[] = [];
  const stt: SttProvider = {
    id: "parakeet",
    label: "Parakeet",
    local: true,
    available: () => ({ ok: true }),
    transcribe: async () => "x",
    canWarm: () => true,
    warm: async (): Promise<WarmStt> => ({ transcribe: async () => "Welche Farbe hat die Küche?", close: () => {} }),
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
        async *stream(call) {
          const round = o.rounds[calls.length] ?? [];
          calls.push({ ...call, messages: call.messages.map(m => ({ ...m })) });
          for (const text of round) yield { text };
        },
        prepare: async system => void prepared.push(system),
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
    searchAvailable: () => o.searchAvailable !== false,
    searchHistory: async q => {
      searches.push(q);
      return o.search ? o.search(q) : "Küche: salbeigrün";
    },
    saveMessage: async () => true,
    processIntents: async () => ({ outcome: "none" as const }),
  } as BotCallDeps;
  return { deps, calls, prepared, searches };
}

async function events(it: AsyncIterable<CallTurnEvent>): Promise<CallTurnEvent[]> {
  const out: CallTurnEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("Anschluss bot-call", () => {
  test("[SUCHE:] ruft genau einmal die Suche aus der Registry, Ergebnis geht gekennzeichnet zurück", async () => {
    const w = botWorld({ rounds: [["[SUCHE: Küche Farbe] egal"], ["Salbeigrün."]] });
    const line = await createBotCall(w.deps).open({ conversationId: "topic-9", agent: "research", tts: "browser", signal: new AbortController().signal, deepTask: true });
    const list = await events(line.turn({ userText: "Welche Farbe hat die Küche?", history: [], signal: new AbortController().signal, deepTask: true }));
    expect(w.searches).toEqual(["Küche Farbe"]);
    expect(list[0]).toEqual({ type: "tool", name: "suche", phase: "start" });
    expect(w.calls[1]!.messages.at(-1)!.content).toBe("[Suchergebnis, nicht vom Nutzer gesprochen]\nKüche: salbeigrün");
    line.close();
  });

  test("Sprechstil nennt nur bereite Werkzeuge", async () => {
    const all = botWorld({ rounds: [] });
    (await createBotCall(all.deps).open({ conversationId: "topic-9", agent: "research", tts: "browser", signal: new AbortController().signal, deepTask: true })).close();
    expect(all.prepared[0]).toContain("[SUCHE:");
    expect(all.prepared[0]).toContain("[DENKAUFTRAG:");
    const none = botWorld({ rounds: [], searchAvailable: false });
    (await createBotCall(none.deps).open({ conversationId: "topic-9", agent: "research", tts: "browser", signal: new AbortController().signal })).close();
    expect(none.prepared[0]).not.toContain("[SUCHE:");
    expect(none.prepared[0]).not.toContain("[DENKAUFTRAG:");
    expect(none.prepared[0]).toContain("[RECHNE:");
  });

  test("ohne Denkauftrag beim Öffnen: [DENKAUFTRAG:] wird nicht ausgeführt, auch wenn der Turn es erlaubt", async () => {
    const w = botWorld({ rounds: [["[DENKAUFTRAG: x] Das geht gerade nicht."]] });
    const line = await createBotCall(w.deps).open({ conversationId: "topic-9", agent: "research", tts: "browser", signal: new AbortController().signal, deepTask: false });
    const list = await events(line.turn({ userText: "Arbeite das aus", history: [], signal: new AbortController().signal, deepTask: true }));
    expect(list.some(e => e.type === "tool")).toBe(false);
    line.close();
  });
});
