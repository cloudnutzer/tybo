/**
 * Issue #258, Prüferrunde 2: call.js (Browser) an einer echten CallSession
 * (Server), verbunden über eine Brücke statt eines Sockets. Nachrichten vom
 * Server an den Browser stehen in einer Warteschlange, bis deliver() sie
 * zustellt; so lässt sich prüfen, was passiert, wenn der Browser unterbricht,
 * bevor er die Antwort des Servers gesehen hat. Erkenner, Gehirn und Stimme
 * sind Attrappen (tests/call-fixture.ts).
 */
import { describe, expect, test } from "bun:test";
import { CallSession, type CallSocket } from "../src/web/call-session";
import { fakeClock, fakeLine, fakePort, flush } from "./call-fixture";
import { CALL_STATUS, callHarness } from "./call-mode-fixture";

function bridged() {
  const h = callHarness();
  const clock = fakeClock();
  const port = fakePort({ line: () => fakeLine() });
  /** Vom Server an den Browser, noch nicht zugestellt */
  const queue: (string | Uint8Array)[] = [];
  /** Alles vom Server, in Reihenfolge */
  const fromServer: string[] = [];
  const socket: CallSocket = {
    send: data => {
      queue.push(typeof data === "string" ? data : new Uint8Array(data));
      fromServer.push(typeof data === "string" ? (JSON.parse(data).type === "state" ? `state:${JSON.parse(data).state}` : JSON.parse(data).type) : "audio");
      return 1;
    },
    bufferedAmount: () => 0,
    close: () => {},
    ping: () => {},
    isAuthorized: () => true,
  };
  const session = new CallSession({
    socket,
    port: port.port,
    checkConversation: async () => ({ ok: true, agent: "general" }),
    clock,
    log: () => {},
    onEnd: () => {},
  });
  session.begin();

  async function deliver() {
    while (queue.length) {
      const data = queue.shift()!;
      const ws = h.ws();
      if (typeof data === "string") ws.onmessage?.({ data });
      else ws.onmessage?.({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
      await h.flush();
    }
  }

  return {
    h,
    port,
    session,
    queue,
    fromServer,
    deliver,
    line: () => port.lines[0]!,
    /** Tipp auf „Telefonhörer“, Brücke steht, ready und „hört zu“ zugestellt */
    async connect() {
      h.mode.start(h.CONVERSATION, CALL_STATUS, "General");
      await h.flush();
      const ws = h.ws();
      const send = ws.send.bind(ws);
      // Was der Browser sendet, kommt in derselben Reihenfolge beim Server an
      ws.send = (data: string | ArrayBuffer) => {
        send(data);
        session.receive(typeof data === "string" ? data : new Uint8Array(data));
      };
      ws.open();
      await flush();
      await deliver();
    },
  };
}

describe("Browser und echte CallSession", () => {
  test("utterance_end ohne Ton: der Server bestätigt „hört zu“, der Browser bleibt nicht bei „Versteht …“", async () => {
    const b = bridged();
    await b.connect();
    expect(b.h.view()).toMatchObject({ phase: "listening", micOpen: true });
    // Sprechbeginn erkannt, aber kein Stück ging hinaus (etwa zu leise nach dem Beginn)
    await b.h.emit({ type: "speechstart" });
    await b.h.emit({ type: "speechend", limit: false });
    expect(b.h.view().phase).toBe("understanding");
    await flush();
    await b.deliver();
    expect(b.h.view()).toMatchObject({ phase: "listening", label: "Hört zu" });
    expect(b.h.vad()).toMatchObject({ active: true, strict: false });
  });

  test("Unterbrechen, ohne dass auf dem Server etwas lief: kein Turn geht verloren, danach wird die nächste Frage beantwortet und die Aufnahme ist wieder aktiv", async () => {
    const b = bridged();
    await b.connect();
    // Der im Pull Request beschriebene Fall: der Server hat ein utterance_end ohne Ton verworfen und hört schon zu
    await b.h.emit({ type: "speechstart" });
    await b.h.emit({ type: "speechend", limit: false });
    await flush();
    expect(b.h.view().phase).toBe("understanding");
    // Antippen, bevor die Antwort des Servers da ist: interrupt, obwohl dort nichts läuft
    b.h.mode.tap();
    await flush();
    expect(b.h.ws().json().map(m => m.type)).toEqual(["start", "utterance_end", "interrupt"]);
    expect(b.line().interrupts).toBe(0);
    // Der Server bestätigt beides mit „hört zu“
    expect(b.fromServer.slice(-2)).toEqual(["state:hoert-zu", "state:hoert-zu"]);
    await b.deliver();
    expect(b.h.mode.state.discarding).toBe(false);
    expect(b.h.view()).toMatchObject({ phase: "listening" });

    // Die nächste Frage
    await b.h.utter();
    await flush();
    expect(b.line().recognized).toHaveLength(1);
    await b.deliver();
    expect(b.h.view()).toMatchObject({ phase: "speaking", label: "Spricht" });
    expect(b.h.view().lines[0]).toEqual({ who: "user", text: "Wie geht es dir heute?" });
    const sentences = b.fromServer.filter(t => t === "sentence").length;
    expect(sentences).toBe(2);
    // Der Ton beider Abschnitte ist beim Spieler angekommen
    const audio = b.h.player().filter(m => m.type === "audio");
    expect(audio.length).toBe(4);
    const ids = b.h.player().filter(m => m.type === "begin").map(m => m.id as number);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      await b.h.played("begin", id);
      await b.h.played("played", id);
    }
    await flush();
    expect(b.line().records).toEqual([{ userText: "Wie geht es dir heute?", spokenText: "Mir geht es gut, danke. Und dir?", rawText: "Mir geht es gut, danke. Und dir?", interrupted: false }]);
    await b.deliver();
    expect(b.h.view()).toMatchObject({ phase: "listening", label: "Hört zu", micOpen: true });
    expect(b.h.view().lines.at(-1)).toEqual({ who: "tybo", text: "Mir geht es gut, danke. Und dir?" });
    // Aufnahme wieder aktiv: die nächste Äußerung geht hinaus
    expect(b.h.vad()).toMatchObject({ active: true, strict: false });
    const before = b.line().recognized.length;
    await b.h.utter();
    await flush();
    expect(b.line().recognized.length).toBe(before + 1);
  });

  test("Unterbrechen, als der Turn schon fertig war: die Bestätigung kommt trotzdem, nichts bleibt gesperrt", async () => {
    const b = bridged();
    await b.connect();
    await b.h.utter();
    await flush();
    await b.deliver();
    expect(b.h.view().phase).toBe("speaking");
    const ids = b.h.player().filter(m => m.type === "begin").map(m => m.id as number);
    for (const id of ids) {
      await b.h.played("begin", id);
      await b.h.played("played", id);
    }
    await flush();
    // Der Server ist fertig und hört zu; der Browser hat das noch nicht gesehen und tippt
    b.h.mode.tap();
    await flush();
    expect(b.line().interrupts).toBe(0);
    await b.deliver();
    expect(b.h.mode.state.discarding).toBe(false);
    expect(b.h.view()).toMatchObject({ phase: "listening" });
    await b.h.utter();
    await flush();
    await b.deliver();
    expect(b.h.view().phase).toBe("speaking");
    expect(b.line().recognized).toHaveLength(2);
  });
});
