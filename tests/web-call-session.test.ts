/**
 * Telefonhörer-Gespräch als Zustandsmaschine (Issue #257, Checkbox 2) mit
 * Attrappen für Erkenner, Gehirn und Stimme, Socket und Uhr. Kein echtes
 * Modell, kein sherpa-onnx, keine Stimme.
 */
import { describe, expect, test } from "bun:test";
import { CALL_LIMITS, CALL_TEXT, CallOpenError, createCallManager, type CallTurnEvent } from "../src/web/call";
import { CallSession } from "../src/web/call-session";
import { fakeClock, fakeLine, fakePort, fakeSocket, flush, gate, pcmFrame, type FakeLineOptions } from "./call-fixture";

function setup(o: { line?: FakeLineOptions; tts?: "server" | "browser"; check?: boolean } = {}) {
  const clock = fakeClock();
  const s = fakeSocket();
  const port = fakePort({ line: () => fakeLine(o.line) });
  let ended = 0;
  const logs: string[] = [];
  const session = new CallSession({
    socket: s.socket,
    port: port.port,
    checkConversation: async id => (o.check === false || id === "fehlt" ? { ok: false, reason: "gespraech", message: "Gespräch nicht gefunden" } : { ok: true, agent: "research" }),
    clock,
    log: l => logs.push(l),
    onEnd: () => ended++,
  });
  session.begin();
  const send = (msg: Record<string, unknown>) => session.receive(JSON.stringify(msg));
  const ready = async () => {
    send({ type: "start", conversationId: "abc", tts: o.tts ?? "server" });
    await flush();
  };
  const speak = async (frames = 25, value = 1000) => {
    for (let i = 0; i < frames; i++) session.receive(pcmFrame(value));
    await flush();
  };
  const line = () => port.lines[0]!;
  return { clock, s, port, session, send, ready, speak, line, logs, ended: () => ended };
}

describe("Turn", () => {
  test("kompletter Turn: Nachrichten in der richtigen Reihenfolge, onTurn nach Bestätigung", async () => {
    const t = setup();
    await t.ready();
    expect(t.port.opened).toEqual([{ conversationId: "abc", agent: "research", tts: "server" }]);
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.types()).toEqual([
      "ready",
      "state:hoert-zu",
      "state:versteht",
      "transcript",
      "state:denkt",
      "sentence",
      "state:spricht",
      "audio_begin",
      "audio",
      "audio",
      "audio_end",
      "sentence",
      "audio_begin",
      "audio",
      "audio",
      "audio_end",
    ]);
    const sentences = t.s.json("sentence");
    expect(sentences.map(m => m.text)).toEqual(["Mir geht es gut, danke.", "Und dir?"]);
    expect(t.s.json("audio_begin").map(m => m.id)).toEqual(sentences.map(m => m.id));
    expect(t.s.json("transcript")[0]!.text).toBe("Wie geht es dir heute?");
    // 25 Frames zu 20 ms gingen an die Erkennung
    expect(t.line().recognized[0]!.length).toBe(25 * 640);
    // Noch nicht bestätigt: kein onTurn, der Turn zählt für den Neustart
    expect(t.line().records).toEqual([]);
    expect(t.port.turnsActive).toBe(1);
    t.send({ type: "played", id: sentences[0]!.id });
    t.send({ type: "played", id: sentences[0]!.id });
    expect(t.line().records).toEqual([]);
    t.send({ type: "played", id: sentences[1]!.id });
    expect(t.line().records).toEqual([{ userText: "Wie geht es dir heute?", spokenText: "Mir geht es gut, danke. Und dir?", rawText: "Mir geht es gut, danke. Und dir?", interrupted: false }]);
    expect(t.port.turnsActive).toBe(0);
    expect(t.s.types().at(-1)).toBe("state:hoert-zu");
  });

  test("der erste Ton geht hinaus, bevor die Antwort des Modells fertig ist", async () => {
    const rest = gate();
    const t = setup({
      line: {
        turn: async function* () {
          yield { type: "segment", text: "Erster Satz kommt sofort." };
          await rest.promise;
          yield { type: "segment", text: "Zweiter Satz später." };
          yield { type: "done", rawText: "x", spokenText: "x", aborted: false };
        },
      },
    });
    await t.ready();
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.types().filter(x => x === "audio").length).toBe(2);
    expect(t.s.json("audio_end").length).toBe(1);
    rest.open();
    await flush();
    expect(t.s.json("sentence").length).toBe(2);
  });

  test("Folgeturn bekommt den flüchtigen Verlauf mit dem gesprochenen Text", async () => {
    const histories: unknown[] = [];
    const t = setup({ tts: "browser", line: { speak: null } });
    // Turn-Attrappe, die den Verlauf festhält
    const line = () => t.line();
    await t.ready();
    const original = line().line.turn;
    line().line.turn = o => {
      histories.push(JSON.parse(JSON.stringify((o as any).history)));
      return original(o);
    };
    for (let round = 0; round < 2; round++) {
      await t.speak();
      t.send({ type: "utterance_end" });
      await flush();
      for (const m of t.s.json("sentence").slice(-2)) t.send({ type: "played", id: m.id });
      await flush();
    }
    expect(histories[0]).toEqual([]);
    expect(histories[1]).toEqual([
      { role: "user", content: "Wie geht es dir heute?" },
      { role: "assistant", content: "Mir geht es gut, danke. Und dir?" },
    ]);
  });

  test("Browser-Stimme: nur sentence, kein Ton; played schließt den Turn ab", async () => {
    const t = setup({ tts: "browser", line: { speak: null } });
    await t.ready();
    expect(t.s.json("ready")[0]).toMatchObject({ tts: "browser" });
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.types()).not.toContain("audio");
    expect(t.s.types()).not.toContain("audio_begin");
    for (const m of t.s.json("sentence")) t.send({ type: "played", id: m.id });
    expect(t.line().records[0]).toMatchObject({ spokenText: "Mir geht es gut, danke. Und dir?", interrupted: false });
  });

  test("fehlende Bestätigung: nach der Frist gilt nur Bestätigtes, späte played zählen nicht", async () => {
    const t = setup();
    await t.ready();
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    const [first, second] = t.s.json("sentence");
    t.send({ type: "played", id: first!.id });
    // Ton je Abschnitt: 1920 Byte = 40 ms; Frist = Tondauer + 3 s
    await t.clock.advance(3_100);
    expect(t.line().records).toEqual([{ userText: "Wie geht es dir heute?", spokenText: "Mir geht es gut, danke.", rawText: "Mir geht es gut, danke.", interrupted: true }]);
    t.send({ type: "played", id: second!.id });
    t.send({ type: "played", id: 999 });
    expect(t.line().records.length).toBe(1);
    expect(t.s.types().at(-1)).toBe("state:hoert-zu");
  });
});

describe("Erkennen", () => {
  test("„äh“ startet keinen Turn", async () => {
    const t = setup({ line: { recognize: async () => ({ ok: true, text: "äh" }) } });
    await t.ready();
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.json("notice").map(n => n.text)).toContain(CALL_TEXT.nothingUnderstood);
    expect(t.line().turnSignals).toEqual([]);
    expect(t.s.types()).not.toContain("transcript");
    expect(t.s.types().at(-1)).toBe("state:hoert-zu");
  });

  test("leere Erkennung: nichts verstanden, kein Fehler", async () => {
    const t = setup({ line: { recognize: async () => ({ ok: false, reason: "empty" }) } });
    await t.ready();
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.json("notice").map(n => n.text)).toContain(CALL_TEXT.nothingUnderstood);
    expect(t.s.json("error")).toEqual([]);
  });

  test("utterance_pause mit nachfolgender Sprache verwirft die frühe Erkennung", async () => {
    const t = setup({ line: { recognize: async pcm => ({ ok: true, text: pcm.length === 10 * 640 ? "Frühes Ergebnis ohne Rest" : "Ganzer Satz mit Rest" }) } });
    await t.ready();
    await t.speak(10);
    t.send({ type: "utterance_pause" });
    await flush();
    expect(t.line().recognized.map(r => r.length)).toEqual([10 * 640]);
    await t.speak(5);
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.line().recognized.map(r => r.length)).toEqual([10 * 640, 15 * 640]);
    expect(t.s.json("transcript").map(m => m.text)).toEqual(["Ganzer Satz mit Rest"]);
  });

  test("utterance_pause ohne weitere Sprache: Ergebnis aus der Pause, keine zweite Erkennung", async () => {
    const t = setup();
    await t.ready();
    await t.speak(10);
    t.send({ type: "utterance_pause" });
    t.send({ type: "utterance_pause" });
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.line().recognized.length).toBe(1);
    expect(t.s.json("transcript").length).toBe(1);
  });

  test("höchstens eine Erkennung in der Pause zur Zeit; der Schnappschuss ändert sich nicht", async () => {
    const hold = gate();
    let calls = 0;
    const t = setup({
      line: {
        recognize: async () => {
          calls++;
          if (calls === 1) await hold.promise;
          return { ok: true, text: "Hallo zusammen" };
        },
      },
    });
    await t.ready();
    await t.speak(4);
    t.send({ type: "utterance_pause" });
    t.send({ type: "utterance_pause" });
    await flush();
    expect(calls).toBe(1);
    const snapshot = t.line().recognized[0]!;
    expect(snapshot.length).toBe(4 * 640);
    hold.open();
    await flush();
    expect(snapshot.length).toBe(4 * 640);
  });

  test("weitere Sprache bricht die laufende Pausen-Erkennung sofort ab; die nächste Pause erkennt neu (Issue #279)", async () => {
    const hold = gate();
    const signals: AbortSignal[] = [];
    const t = setup({
      line: {
        recognize: async (_pcm: Uint8Array, sig: AbortSignal) => {
          signals.push(sig);
          if (signals.length === 1) {
            await hold.promise;
            return { ok: true, text: "veraltet" };
          }
          return { ok: true, text: "Hallo zusammen" };
        },
        adopt: r => (r.ok ? `Hinweis zu ${r.text}` : undefined),
      },
    });
    await t.ready();
    await t.speak(4);
    t.send({ type: "utterance_pause" });
    await flush();
    expect(signals[0]!.aborted).toBe(false);
    await t.speak(4);
    expect(signals[0]!.aborted).toBe(true);
    t.send({ type: "utterance_pause" });
    await flush();
    expect(signals).toHaveLength(2);
    expect(t.line().recognized.map(r => r.length)).toEqual([4 * 640, 8 * 640]);
    hold.open();
    await flush();
    // Vor utterance_end ist nichts übernommen, also auch kein Hinweis
    expect(t.line().adopted).toEqual([]);
    expect(t.s.json("notice")).toEqual([]);
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.json("transcript").map(m => m.text)).toEqual(["Hallo zusammen"]);
    // Übernommen wird nur die benutzte Erkennung, ihr Hinweis kommt genau einmal
    expect(t.line().adopted).toEqual([{ ok: true, text: "Hallo zusammen" }]);
    expect(t.s.json("notice").map(m => m.text)).toEqual(["Hinweis zu Hallo zusammen"]);
  });

  test("schon fertige Pausen-Erkennung, dann weitere Sprache: nie übernommen, kein Hinweis (Issue #279)", async () => {
    let calls = 0;
    const t = setup({
      line: {
        recognize: async () => {
          calls++;
          return calls === 1 ? { ok: false, reason: "failed" } : { ok: true, text: "Ich hätte gern ein Schokoeis mit Sahne." };
        },
        adopt: r => (r.ok ? undefined : "Hinweis der verworfenen Erkennung"),
      },
    });
    await t.ready();
    await t.speak(4);
    t.send({ type: "utterance_pause" });
    await flush();
    expect(calls).toBe(1);
    // Die Pausen-Erkennung ist fertig (gescheitert); jetzt spricht der Nutzer weiter
    await t.speak(4);
    t.send({ type: "utterance_end" });
    await flush();
    expect(calls).toBe(2);
    expect(t.line().adopted).toEqual([{ ok: true, text: "Ich hätte gern ein Schokoeis mit Sahne." }]);
    expect(t.s.json("notice")).toEqual([]);
    expect(t.s.json("error")).toEqual([]);
    expect(t.s.json("transcript").map(m => m.text)).toEqual(["Ich hätte gern ein Schokoeis mit Sahne."]);
  });

  test("Hinweis der Erkennung bei utterance_end ohne Pause, nicht bei Abbruch (Issue #279)", async () => {
    const hold = gate();
    let calls = 0;
    const t = setup({
      line: {
        recognize: async () => {
          calls++;
          if (calls === 1) {
            await hold.promise;
            return { ok: false, reason: "failed" };
          }
          return { ok: true, text: "Wie wird das Wetter morgen in Berlin?" };
        },
        adopt: r => (r.ok ? "Hinweis zwei" : "abgebrochener Hinweis"),
      },
    });
    await t.ready();
    await t.speak(4);
    t.send({ type: "utterance_end" });
    await flush();
    // Unterbrechen während des Erkennens: der Versuch ist abgebrochen, er wird nie übernommen
    t.send({ type: "interrupt" });
    hold.open();
    await flush();
    expect(t.line().adopted).toEqual([]);
    expect(t.s.json("notice")).toEqual([]);
    await t.speak(4);
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.json("notice").map(m => m.text)).toEqual(["Hinweis zwei"]);
  });

  test("stumm: Ton wird verworfen, kein Erkennen", async () => {
    const t = setup();
    await t.ready();
    t.send({ type: "mute", on: true });
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.line().recognized).toEqual([]);
    t.send({ type: "mute", on: false });
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.line().recognized.length).toBe(1);
  });
});

describe("Unterbrechen", () => {
  test("interrupt mitten im zweiten Abschnitt: kein weiterer Ton, onTurn nur mit dem bestätigten ersten", async () => {
    const second = gate();
    let calls = 0;
    const t = setup({
      line: {
        speak: async function* (_text, signal) {
          calls++;
          yield new Uint8Array(960).fill(calls);
          if (calls === 2) {
            await second.promise;
            if (signal.aborted) return;
            yield new Uint8Array(960).fill(9);
          }
        },
      },
    });
    await t.ready();
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    const [first] = t.s.json("sentence");
    t.send({ type: "played", id: first!.id });
    const before = t.s.events.length;
    expect(t.s.types().filter(x => x === "audio").length).toBe(2);
    t.send({ type: "interrupt" });
    second.open();
    await flush();
    const after = t.s.events.slice(before);
    expect(after.some(e => e.binary)).toBe(false);
    expect(after.some(e => e.json?.type === "audio_end" || e.json?.type === "sentence")).toBe(false);
    expect(t.line().interrupts).toBe(1);
    expect(t.line().turnSignals[0]!.aborted).toBe(true);
    expect(t.line().records).toEqual([{ userText: "Wie geht es dir heute?", spokenText: "Mir geht es gut, danke.", rawText: "Mir geht es gut, danke.", interrupted: true }]);
    expect(t.port.turnsActive).toBe(0);
    expect(t.s.types().at(-1)).toBe("state:hoert-zu");
    // Weiter zuhören: neue Äußerung, neuer Turn
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.line().turnSignals.length).toBe(2);
  });

  test("interrupt beim Erkennen: Ergebnis verworfen, zurück zum Zuhören", async () => {
    const hold = gate<{ ok: true; text: string }>();
    const t = setup({ line: { recognize: () => hold.promise } });
    await t.ready();
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    t.send({ type: "interrupt" });
    hold.open({ ok: true, text: "Zu spät erkannt" });
    await flush();
    expect(t.s.json("transcript")).toEqual([]);
    expect(t.line().turnSignals).toEqual([]);
    expect(t.s.types().at(-1)).toBe("state:hoert-zu");
  });

  test("interrupt ohne laufenden Turn: der Server bestätigt trotzdem mit „hört zu“, die Aufnahme danach bleibt", async () => {
    const t = setup();
    await t.ready();
    const before = t.s.types().length;
    t.send({ type: "interrupt" });
    await flush();
    expect(t.s.types().slice(before)).toEqual(["state:hoert-zu"]);
    expect(t.line().interrupts).toBe(0);
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.json("transcript").map(m => m.text)).toEqual(["Wie geht es dir heute?"]);
  });

  test("utterance_end ohne Ton: keine Erkennung, aber „hört zu“ als Antwort", async () => {
    const t = setup();
    await t.ready();
    const before = t.s.types().length;
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.types().slice(before)).toEqual(["state:hoert-zu"]);
    expect(t.line().recognized).toEqual([]);
  });

  test("interrupt stoppt den Fehlersatz; sein spätes Ende verwirft die neue Aufnahme nicht", async () => {
    const slow = gate();
    let calls = 0;
    const t = setup({
      line: {
        recognize: async () => (++calls === 1 ? { ok: false, reason: "failed" } : { ok: true, text: "Neue Frage" }),
        speak: async function* (_text, signal) {
          yield new Uint8Array(960).fill(1);
          await slow.promise;
          // Die Stimme achtet nicht auf das Signal: der Server muss selbst aufhören
          void signal;
          yield new Uint8Array(960).fill(2);
        },
      },
    });
    await t.ready();
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.json("sentence").map(m => m.text)).toEqual([CALL_TEXT.errorSentence]);
    const audioBefore = t.s.types().filter(x => x === "audio").length;
    t.send({ type: "interrupt" });
    await flush();
    expect(t.s.types().at(-1)).toBe("state:hoert-zu");
    // Neue Aufnahme beginnt, dann endet der verzögerte Fehlersatz
    await t.speak(25, 2000);
    slow.open();
    await flush();
    expect(t.s.types().filter(x => x === "audio").length).toBe(audioBefore);
    expect(t.s.json("audio_end")).toEqual([]);
    expect(t.s.types().at(-1)).toBe("state:hoert-zu");
    t.send({ type: "utterance_end" });
    await flush();
    // Die ganze neue Aufnahme ging an die Erkennung, nichts davon wurde verworfen
    expect(t.line().recognized[1]!.length).toBe(25 * 640);
    expect(t.s.json("transcript").map(m => m.text)).toEqual(["Neue Frage"]);
  });

  test("Verbindungsabbruch mitten im Turn: onTurn genau einmal, alles geschlossen", async () => {
    const rest = gate();
    const t = setup({
      line: {
        turn: async function* () {
          yield { type: "segment", text: "Ein angefangener Satz." };
          await rest.promise;
          yield { type: "done", rawText: "x", spokenText: "x", aborted: false };
        },
      },
    });
    await t.ready();
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    t.session.socketClosed();
    rest.open();
    await flush();
    expect(t.line().records).toEqual([{ userText: "Wie geht es dir heute?", spokenText: "", rawText: "", interrupted: true }]);
    expect(t.line().closed).toBe(1);
    expect(t.port.turnsActive).toBe(0);
    expect(t.ended()).toBe(1);
  });
});

describe("Fristen", () => {
  test("2 Minuten ohne Sprache legen auf, Sprache setzt die Frist zurück", async () => {
    const t = setup();
    await t.ready();
    await t.clock.advance(CALL_LIMITS.silenceMs - 1_000);
    expect(t.s.state.closed).toBeNull();
    // Turn mit Bestätigung: danach beginnt die Frist neu
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    for (const m of t.s.json("sentence")) t.send({ type: "played", id: m.id });
    await t.clock.advance(CALL_LIMITS.silenceMs - 1_000);
    expect(t.s.state.closed).toBeNull();
    await t.clock.advance(1_000);
    expect(t.s.json("ended")[0]).toMatchObject({ reason: "stille" });
    expect(t.line().closed).toBe(1);
  });

  test("PCM ohne utterance_end: 2 Minuten nach dem letzten Ton aufgelegt", async () => {
    const t = setup();
    await t.ready();
    await t.clock.advance(60_000);
    await t.speak(10);
    await t.clock.advance(CALL_LIMITS.silenceMs - 1_000);
    expect(t.s.state.closed).toBeNull();
    await t.clock.advance(1_000);
    expect(t.s.json("notice").map(m => m.text)).toContain(CALL_TEXT.silence);
    expect(t.s.json("ended")[0]).toMatchObject({ reason: "stille" });
    expect(t.line().turnSignals).toEqual([]);
  });

  test("PCM, dann stumm, dann 2 Minuten Stille: aufgelegt", async () => {
    const t = setup();
    await t.ready();
    await t.speak(10);
    t.send({ type: "mute", on: true });
    // Stumm verworfener Ton zählt nicht als Sprache
    await t.clock.advance(60_000);
    await t.speak(10);
    await t.clock.advance(CALL_LIMITS.silenceMs - 60_000 - 1);
    expect(t.s.state.closed).toBeNull();
    await t.clock.advance(1);
    expect(t.s.json("ended")[0]).toMatchObject({ reason: "stille" });
  });

  test("60 Minuten Höchstdauer, auch wenn gesprochen wird", async () => {
    const t = setup({ line: { recognize: async () => ({ ok: true, text: "hm" }) } });
    await t.ready();
    for (let minute = 0; minute < 59; minute++) {
      await t.speak(5);
      t.send({ type: "utterance_end" });
      await flush();
      await t.clock.advance(60_000);
    }
    expect(t.s.state.closed).toBeNull();
    await t.clock.advance(60_000);
    expect(t.s.json("ended")[0]).toMatchObject({ reason: "dauer", seconds: 3600 });
  }, 30_000);
});

describe("Neustart, Fehler, Start", () => {
  test("Neustart-Wunsch legt im Zustand hört zu mit Abschiedssatz auf", async () => {
    const t = setup();
    await t.ready();
    t.port.restart = true;
    await t.clock.advance(2_000);
    await flush();
    expect(t.s.json("sentence").map(m => m.text)).toEqual([CALL_TEXT.restartBye]);
    expect(t.s.json("ended")[0]).toMatchObject({ reason: "neustart" });
    expect(t.port.turnsActive).toBe(0);
  });

  test("Neustart-Wunsch während eines Turns: erst der Turn, dann der Abschied", async () => {
    const t = setup();
    await t.ready();
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    t.port.restart = true;
    await t.clock.advance(2_000);
    expect(t.s.json("ended")).toEqual([]);
    for (const m of t.s.json("sentence")) t.send({ type: "played", id: m.id });
    await flush();
    expect(t.s.json("sentence").at(-1)!.text).toBe(CALL_TEXT.restartBye);
    expect(t.s.json("ended")[0]).toMatchObject({ reason: "neustart" });
    expect(t.line().records.length).toBe(1);
  });

  test("Start bei angefordertem Neustart: abgelehnt, nichts geöffnet", async () => {
    const t = setup();
    t.port.restart = true;
    await t.ready();
    expect(t.s.json("error")[0]).toMatchObject({ reason: "neustart" });
    expect(t.port.opened).toEqual([]);
    expect(t.ended()).toBe(1);
  });

  test("Fehler der Erkennung: Satz, beim zweiten in Folge Ende", async () => {
    const t = setup({ line: { recognize: async () => ({ ok: false, reason: "failed" }) } });
    await t.ready();
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.json("error")).toEqual([{ type: "error", reason: "erkennung" }]);
    expect(t.s.json("sentence").map(m => m.text)).toEqual([CALL_TEXT.errorSentence]);
    expect(t.s.state.closed).toBeNull();
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.json("ended")[0]).toMatchObject({ reason: "fehler" });
  });

  test("Modellfehler, dann Erfolg: Zählung beginnt neu", async () => {
    let n = 0;
    const t = setup({
      tts: "browser",
      line: {
        speak: null,
        turn: async function* (): AsyncGenerator<CallTurnEvent> {
          n++;
          if (n % 2 === 1) {
            yield { type: "error", reason: "api", message: "500", rawText: "", spokenText: "" };
            return;
          }
          yield { type: "segment", text: "Jetzt klappt es wieder." };
          yield { type: "done", rawText: "Jetzt klappt es wieder.", spokenText: "", aborted: false };
        },
      },
    });
    await t.ready();
    for (let i = 0; i < 4; i++) {
      await t.speak();
      t.send({ type: "utterance_end" });
      await flush();
      for (const m of t.s.json("sentence")) t.send({ type: "played", id: m.id });
      await flush();
    }
    expect(t.s.json("error").length).toBe(2);
    expect(t.s.state.closed).toBeNull();
  });

  test("Stimme fällt aus: Rest nur als Text, Fehler gezählt", async () => {
    const t = setup({
      line: {
        speak: async function* () {
          throw new Error("pocket weg");
        },
      },
    });
    await t.ready();
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.json("sentence").length).toBeGreaterThanOrEqual(2);
    expect(t.s.types()).not.toContain("audio");
  });

  test("Budget erschöpft: Satz und Ende", async () => {
    const t = setup({
      line: {
        turn: async function* (): AsyncGenerator<CallTurnEvent> {
          yield { type: "error", reason: "budget", message: "leer", rawText: "", spokenText: "" };
        },
      },
    });
    await t.ready();
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.json("sentence").map(m => m.text)).toEqual([CALL_TEXT.budgetSentence]);
    expect(t.s.json("ended")[0]).toMatchObject({ reason: "budget" });
  });

  test("Startfehler: error mit Grund, Platz frei, nichts offen", async () => {
    const clock = fakeClock();
    const port = fakePort({
      open: async () => {
        throw new CallOpenError("nicht-bereit", "Kein Weg für den Telefonhörer bereit");
      },
    });
    const manager = createCallManager({ port: port.port, checkConversation: async () => ({ ok: true, agent: "general" }), log: () => {}, clock });
    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const raw = () => {
      const s = fakeSocket();
      sockets.push(s);
      return { data: { session: "h", isAuthorized: () => true }, send: s.socket.send, close: s.socket.close, ping: s.socket.ping, getBufferedAmount: () => 0 } as any;
    };
    const ws = raw();
    manager.open(ws);
    manager.message(ws, JSON.stringify({ type: "start", conversationId: "abc", tts: "server" }));
    await flush();
    expect(sockets[0]!.json("error")[0]).toMatchObject({ reason: "nicht-bereit", message: "Kein Weg für den Telefonhörer bereit" });
    expect(manager.activeCount()).toBe(0);
    // Der Platz ist frei: das nächste Gespräch ist nicht besetzt
    const ws2 = raw();
    manager.open(ws2);
    expect(sockets[1]!.state.closed).toBeNull();
  });

  test("Verbindung weg, während geöffnet wird: die Leitung wird sofort wieder geschlossen", async () => {
    const opening = gate();
    const t = setup();
    const line = fakeLine();
    t.port.port.open = async () => {
      await opening.promise;
      return line.line;
    };
    t.send({ type: "start", conversationId: "abc", tts: "server" });
    await flush();
    t.session.socketClosed();
    opening.open();
    await flush();
    expect(line.closed).toBe(1);
    expect(t.ended()).toBe(1);
  });

  test("unbekanntes Gespräch: error, kein open", async () => {
    const t = setup({ check: false });
    await t.ready();
    expect(t.s.json("error")[0]).toMatchObject({ reason: "gespraech" });
    expect(t.port.opened).toEqual([]);
  });

  test("Nachrichten vor start und ungerade Binärlänge schließen", async () => {
    const t = setup();
    t.send({ type: "utterance_end" });
    expect(t.s.state.closed?.reason).toBe("protokoll");
    const t2 = setup();
    await t2.ready();
    t2.session.receive(new Uint8Array(641));
    expect(t2.s.state.closed?.reason).toBe("protokoll");
  });

  test("Äußerung über 60 s schließt", async () => {
    const t = setup();
    await t.ready();
    await t.speak(3000);
    expect(t.s.state.closed).toBeNull();
    t.session.receive(pcmFrame());
    expect(t.s.state.closed?.reason).toBe("zu-gross");
  });
});

describe("Langsamer Empfänger", () => {
  test("voller Ausgabepuffer: Ton wartet, nach 10 s ohne Abholen Ende", async () => {
    const t = setup();
    await t.ready();
    t.s.state.buffered = 2 * CALL_LIMITS.maxBufferedBytes;
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    expect(t.s.types()).toContain("audio_begin");
    expect(t.s.types()).not.toContain("audio");
    await t.clock.advance(CALL_LIMITS.drainTimeoutMs + 500);
    await flush();
    expect(t.s.types()).not.toContain("audio");
    expect(t.s.json("ended")[0]).toMatchObject({ reason: "verbindung" });
    expect(t.line().records.length).toBe(1);
  });

  test("Puffer leert sich (drain): Ton geht weiter", async () => {
    const t = setup();
    await t.ready();
    t.s.state.buffered = 2 * CALL_LIMITS.maxBufferedBytes;
    await t.speak();
    t.send({ type: "utterance_end" });
    await flush();
    t.s.state.buffered = 0;
    t.session.drained();
    await flush();
    expect(t.s.types().filter(x => x === "audio").length).toBe(4);
  });
});
