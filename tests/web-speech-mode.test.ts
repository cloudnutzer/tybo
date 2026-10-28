/**
 * Issue #250, Checkbox 3: Zustandsmaschine des Sprechmodus
 * (src/web/public/speech.js) ohne Browser. Attrappen für Mikrofon,
 * AudioContext und Worklet, POST und GET …/speech, Ereignisse des Gesprächs
 * und die Uhr (tests/speech-mode-fixture.ts).
 */
import { describe, expect, test } from "bun:test";
import { prepareSpeechAudio } from "../src/web/audio-duration";
import { ALL_RELEASED, FakeStream, speechHarness } from "./speech-mode-fixture";

const T = speechHarness().api.SPEECH_MODE_TEXT;

describe("kompletter Durchlauf", () => {
  test("Tipp, Äußerung, Verstehen, Denken, Sprechen, wieder Zuhören", async () => {
    const h = speechHarness();
    expect(h.view()).toMatchObject({ phase: "off", active: false });
    h.mode.start(h.CONVERSATION, h.status);
    // Mikrofon erst nach dem Tipp, mit Echo- und Rauschunterdrückung
    expect(h.view().phase).toBe("starting");
    expect(h.mic.calls).toEqual([{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }]);
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", label: "Hört zu", micOpen: true, canPause: true });
    expect(h.contexts).toHaveLength(1);
    expect(h.contexts[0].modulePaths).toEqual(["/speech-worklet.js"]);
    expect(h.node().name).toBe("speech-vad");
    expect(h.vad()).toMatchObject({ type: "config", active: true, pauseMs: 800, startMs: 150 });
    expect(h.tracks()[0]!.enabled).toBe(true);
    expect(h.wake.requests).toBe(1);

    // Sprechbeginn: der Bereich zeigt es
    await h.emit({ type: "start" });
    expect(h.view().voiceActive).toBe(true);
    await h.emit({ type: "level", level: 0.2, speaking: true });
    expect(h.view().level).toBe(0.2);
    expect(h.seen.levels).toBe(1);

    // Äußerung fertig: genau ein Upload als WAV, Mikrofon stumm, Erkennung aus
    const samples = new Int16Array(16000).fill(1200);
    const listeningEpoch = h.vad().epoch;
    await h.emit({ type: "utterance", samples, limit: false });
    expect(h.view()).toMatchObject({ phase: "understanding", label: "Verstehe …", micOpen: false });
    expect(h.uploads()).toHaveLength(1);
    const upload = h.lastUpload();
    expect(upload.path).toBe(`/api/conversations/${h.CONVERSATION}/speech`);
    expect(upload.headers["Content-Type"]).toBe("audio/wav");
    const prepared = prepareSpeechAudio(upload.body, "audio/wav")!;
    expect(prepared.seconds).toBe(1);
    expect(new DataView(upload.body.buffer).getUint32(24, true)).toBe(16000);
    expect(new DataView(upload.body.buffer).getUint16(22, true)).toBe(1);
    expect(h.tracks()[0]!.enabled).toBe(false);
    expect(h.vad()).toMatchObject({ active: false });
    expect(h.vad().epoch).toBeGreaterThan(listeningEpoch);

    // Angenommen: Denken, der erkannte Text steht im Bereich, der Verlauf wird nachgeladen
    await h.accept("m-1", "Wie wird das Wetter?");
    expect(h.view()).toMatchObject({ phase: "thinking", label: "Denkt …", heard: "Wie wird das Wetter?" });
    expect(h.seen.accepted).toBe(1);
    h.mode.status(true, false);
    h.mode.progress("Sucht im Web");
    expect(h.view().step).toBe("Sucht im Web");
    await h.add(h.own("m-1"));
    expect(h.view().phase).toBe("thinking");

    // Antwort: vorlesen, Mikrofon bleibt stumm
    await h.add(h.reply("a-1", ["Morgen wird es sonnig."]));
    h.mode.status(false, false);
    expect(h.view()).toMatchObject({ phase: "speaking", label: "Spricht", reply: "Morgen wird es sonnig.", micOpen: false });
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Morgen wird es sonnig."]);
    expect(h.tracks()[0]!.enabled).toBe(false);
    expect(h.vad().active).toBe(false);

    // Fertig gesprochen: wieder Zuhören, mit neuem Abschnitt der Erkennung
    h.synth.spoken[0]!.onend!();
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", micOpen: true });
    expect(h.tracks()[0]!.enabled).toBe(true);
    expect(h.vad()).toMatchObject({ active: true, startMs: 150 });

    // Zweite Runde im selben Gespräch
    await h.say();
    expect(h.uploads()).toHaveLength(2);
    await h.accept("m-2", "Und übermorgen?");
    await h.add(h.own("m-2"));
    await h.add(h.reply("a-2", ["Übermorgen regnet es."]));
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Morgen wird es sonnig.", "Übermorgen regnet es."]);

    h.mode.hangUp();
    expect(h.view()).toMatchObject({ phase: "off", active: false });
    expect(h.released()).toEqual(ALL_RELEASED);
  });

  test("Schritt, der schon während „Verstehe …“ ankommt, steht ab „Denkt …“ im Bereich", async () => {
    const h = speechHarness();
    h.mode.start(h.CONVERSATION, h.status);
    await h.flush();
    await h.emit({ type: "utterance", samples: new Int16Array(16000).fill(1200), limit: false });
    expect(h.view().phase).toBe("understanding");
    // Die Live-Verbindung ist schneller als die Antwort auf den Upload
    h.mode.status(true, false);
    h.mode.progress("WebSearch");
    expect(h.view().step).toBe("");
    await h.accept("m-1", "Wie wird das Wetter?");
    expect(h.view()).toMatchObject({ phase: "thinking", step: "WebSearch" });
    h.mode.progress("Liest eine Seite");
    expect(h.view().step).toBe("Liest eine Seite");
  });

  test("die Pause dieses Geräts geht an die Erkennung", async () => {
    const h = speechHarness({ device: { pause: "long" } });
    await h.start();
    expect(h.vad()).toMatchObject({ pauseMs: 1300 });
    const short = speechHarness({ device: { pause: "short" } });
    await short.start();
    expect(short.vad()).toMatchObject({ pauseMs: 500 });
  });

  test("Grenze erreicht: gesendet wird trotzdem, mit Hinweis", async () => {
    const h = speechHarness();
    await h.start();
    await h.say(new Int16Array(928000), { limit: true });
    expect(h.view()).toMatchObject({ phase: "understanding", note: "Längste Äußerung erreicht, gesendet." });
    expect(prepareSpeechAudio(h.lastUpload().body, "audio/wav")!.seconds).toBe(58);
    await h.accept();
    expect(h.view().note).toBe("Längste Äußerung erreicht, gesendet.");
  });

  test("Meldungen des Worklets aus einem früheren Abschnitt zählen nicht", async () => {
    const h = speechHarness();
    await h.start();
    const old = h.vad().epoch;
    await h.say();
    expect(h.uploads()).toHaveLength(1);
    // Während „Verstehe" trifft noch eine Äußerung mit alter Laufnummer ein
    await h.emit({ type: "utterance", samples: new Int16Array(8000), epoch: old });
    await h.emit({ type: "utterance", samples: new Int16Array(8000) });
    expect(h.uploads()).toHaveLength(1);
  });

  test("läuft beim Tipp schon ein Turn: erst warten, dann zuhören", async () => {
    const h = speechHarness();
    h.page.running = true;
    await h.start();
    expect(h.view()).toMatchObject({ phase: "waiting", label: "Wartet" });
    expect(h.vad().active).toBe(false);
    expect(h.polls()).toHaveLength(1);
    h.polls()[0]!.respond(200, { busy: false });
    await h.flush();
    // Nichts wurde verworfen: kein „Sprich noch einmal"
    expect(h.view()).toMatchObject({ phase: "listening", note: "" });
  });
});

describe("nichts verstanden", () => {
  test("422: kurz anzeigen, dann wieder zuhören; zählt nicht als Fehler", async () => {
    const h = speechHarness();
    await h.start();
    for (let i = 0; i < 4; i++) {
      await h.say();
      await h.answerUpload(422, { error: "Nichts verstanden", reason: "nichts-verstanden" });
      expect(h.view()).toMatchObject({ phase: "nothing", label: "Nichts verstanden", micOpen: false });
      expect(h.vad().active).toBe(false);
      await h.advance(1499);
      expect(h.view().phase).toBe("nothing");
      await h.advance(1);
      expect(h.view()).toMatchObject({ phase: "listening", note: "" });
    }
    expect(h.uploads()).toHaveLength(4);
  });
});

describe("Fehlerklassen", () => {
  test("vorübergehend (413, 502, 504): Hinweis und weiter zuhören", async () => {
    const cases: [number, Record<string, string>][] = [
      [413, { error: "Aufnahme zu lang: höchstens 60 Sekunden", reason: "zu-lang" }],
      [502, { error: "Die Erkennung ist fehlgeschlagen", reason: "erkennung-fehlgeschlagen" }],
      [504, { error: "Die Erkennung hat zu lange gedauert", reason: "zeitlimit" }],
    ];
    for (const [status, body] of cases) {
      const h = speechHarness();
      await h.start();
      await h.say();
      await h.answerUpload(status, body);
      expect(h.view()).toMatchObject({ phase: "listening", note: `${body.error}. Sprich noch einmal.` });
      expect(h.tracks()[0]!.stopped).toBe(false);
      expect(h.uploads()).toHaveLength(1);
    }
  });

  test("drei vorübergehende Fehler in Folge beenden den Modus; ein Erfolg dazwischen zählt neu", async () => {
    const h = speechHarness();
    await h.start();
    const failOnce = async () => {
      await h.say();
      await h.answerUpload(502, { error: "Die Erkennung ist fehlgeschlagen", reason: "erkennung-fehlgeschlagen" });
    };
    await failOnce();
    await failOnce();
    expect(h.view().phase).toBe("listening");
    // Erfolg: der Zähler beginnt neu
    await h.say();
    await h.accept("m-1");
    await h.add(h.own("m-1"));
    await h.add(h.reply("a-1", ["Gut."]));
    h.synth.spoken.at(-1)!.onend!();
    await h.flush();
    expect(h.view().phase).toBe("listening");
    await failOnce();
    await failOnce();
    expect(h.view().phase).toBe("listening");
    await failOnce();
    expect(h.view()).toMatchObject({ phase: "error", label: "Fehler", ended: true, canPause: false });
    expect(h.view().note).toContain("Drei Fehler in Folge");
    expect(h.released()).toEqual(ALL_RELEASED);
    // Schließen räumt den Bereich weg
    h.mode.close();
    expect(h.view().phase).toBe("off");
  });

  test("endgültig: 404, 415, 400, 503 kein-anbieter, 503 ohne reason; der Modus endet und gibt alles frei", async () => {
    const cases: [number, Record<string, unknown> | undefined, string][] = [
      [404, { error: "Gespräch nicht gefunden" }, "Dieses Gespräch gibt es nicht mehr."],
      [415, { error: "Format nicht erlaubt.", reason: "format" }, "Format nicht erlaubt."],
      [400, { error: "Die Aufnahme ist leer", reason: "leer" }, "Die Aufnahme ist leer"],
      [400, { error: "Die Dauer der Aufnahme lässt sich nicht bestimmen.", reason: "dauer-unbekannt" }, "Die Dauer der Aufnahme lässt sich nicht bestimmen."],
      [503, { error: "Kein Anbieter fürs Hören verfügbar", reason: "kein-anbieter" }, "Kein Anbieter fürs Hören verfügbar"],
      [503, { error: "Die WebUI wird gerade beendet" }, "Die WebUI wird gerade beendet"],
      [503, undefined, "Der Sprechmodus ist gerade nicht verfügbar."],
      [403, { error: "Fremder Origin" }, "Fremder Origin"],
    ];
    for (const [status, body, text] of cases) {
      const h = speechHarness();
      await h.start();
      await h.say();
      await h.answerUpload(status, body);
      expect(h.view()).toMatchObject({ phase: "error", note: text });
      expect(h.released()).toEqual(ALL_RELEASED);
      expect(h.uploads()).toHaveLength(1);
      expect(h.polls()).toHaveLength(0);
    }
  });

  test("409 mit closed (geschlossenes Topic) wartet nicht: Fehler mit dem Text des Chats, das Gespräch wird gesperrt", async () => {
    const h = speechHarness();
    await h.start("topic-444");
    await h.say();
    await h.answerUpload(409, { error: "Dieses Topic ist geschlossen.", closed: true });
    expect(h.view()).toMatchObject({ phase: "error", note: "Dieses Topic ist geschlossen." });
    expect(h.seen.closed).toEqual([["topic-444", "Dieses Topic ist geschlossen."]]);
    expect(h.released()).toEqual(ALL_RELEASED);
    await h.advance(10_000);
    expect(h.polls()).toHaveLength(0);
  });

  test("Netzfehler beim Upload: nie erneut senden, warten bis das Gespräch frei ist", async () => {
    const h = speechHarness();
    await h.start();
    await h.say();
    h.lastUpload().fail();
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "waiting" });
    expect(h.view().note).toContain("Nichts wird erneut gesendet");
    await h.advance(2000);
    expect(h.polls()).toHaveLength(1);
    h.polls()[0]!.respond(200, { busy: false });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "Wieder frei. Sprich noch einmal." });
    expect(h.uploads()).toHaveLength(1);
  });

  test("abgelaufene Anmeldung (401): alles frei, zurück zur Anmeldung", async () => {
    const h = speechHarness();
    await h.start();
    await h.say();
    await h.answerUpload(401, { error: "Nicht angemeldet" });
    expect(h.view().phase).toBe("off");
    expect(h.seen.unauthorized).toBe(1);
    expect(h.released()).toEqual(ALL_RELEASED);

    // Auch aus der Beschäftigt-Abfrage
    const w = speechHarness();
    await w.start();
    await w.say();
    await w.answerUpload(409, { error: "In diesem Gespräch läuft schon eine Antwort", reason: "beschaeftigt" });
    await w.advance(2000);
    w.polls()[0]!.respond(401, { error: "Nicht angemeldet" });
    await w.flush();
    expect(w.view().phase).toBe("off");
    expect(w.seen.unauthorized).toBe(1);
    expect(w.released()).toEqual(ALL_RELEASED);
  });

  test("Mikrofon verweigert oder nicht da: Fehler mit dem Text aus der Aufnahme, nichts bleibt offen", async () => {
    const denied = speechHarness({ microphone: "deny" });
    await denied.start();
    expect(denied.view()).toMatchObject({ phase: "error", note: "Mikrofon: NotAllowedError" });
    expect(denied.released()).toEqual(ALL_RELEASED);
    const missing = speechHarness({ microphone: "missing" });
    await missing.start();
    expect(missing.view()).toMatchObject({ phase: "error", note: "Mikrofon: NotFoundError" });
    // Worklet lädt nicht
    const broken = speechHarness({ module: "fail" });
    await broken.start();
    expect(broken.view().phase).toBe("error");
    expect(broken.released()).toEqual(ALL_RELEASED);
    // Aus dem Fehler heraus geht ein neuer Versuch
    broken.moduleMode.value = "ok";
    await broken.start();
    expect(broken.view().phase).toBe("listening");
  });

  test("Mikrofon fällt im Betrieb weg: Fehler, alles frei", async () => {
    const h = speechHarness();
    await h.start();
    h.tracks()[0]!.onended!();
    expect(h.view()).toMatchObject({ phase: "error", note: "Das Mikrofon ist nicht mehr verfügbar." });
    expect(h.released()).toEqual(ALL_RELEASED);
  });
});

describe("Wartet (409 beschaeftigt)", () => {
  const busy = { error: "In diesem Gespräch läuft schon eine Antwort", reason: "beschaeftigt" };

  async function waiting() {
    const h = speechHarness();
    await h.start();
    await h.say();
    await h.answerUpload(409, busy);
    return h;
  }

  test("die Aufnahme ist verworfen: kein zweiter Upload, die Abfrage alle 2 Sekunden beendet das Warten", async () => {
    const h = await waiting();
    expect(h.view()).toMatchObject({ phase: "waiting", label: "Wartet", note: "In diesem Gespräch läuft schon eine Antwort. Nichts gesendet.", micOpen: false });
    expect(h.tracks()[0]!.enabled).toBe(false);
    expect(h.vad().active).toBe(false);
    expect(h.polls()).toHaveLength(0);
    await h.advance(1999);
    expect(h.polls()).toHaveLength(0);
    await h.advance(1);
    expect(h.polls()).toHaveLength(1);
    expect(h.polls()[0]!.path).toBe(`/api/conversations/${h.CONVERSATION}/speech`);
    h.polls()[0]!.respond(200, { busy: true });
    await h.flush();
    expect(h.view().phase).toBe("waiting");
    await h.advance(2000);
    expect(h.polls()).toHaveLength(2);
    h.polls()[1]!.respond(200, { busy: false });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "Wieder frei. Sprich noch einmal.", micOpen: true });
    expect(h.tracks()[0]!.enabled).toBe(true);
    // Dieselbe Aufnahme geht nie ein zweites Mal hinaus
    expect(h.uploads()).toHaveLength(1);
    await h.advance(10_000);
    expect(h.polls()).toHaveLength(2);
    expect(h.uploads()).toHaveLength(1);
  });

  test("status mit running false fragt sofort nach", async () => {
    const h = await waiting();
    await h.advance(500);
    h.mode.status(false, false);
    await h.flush();
    expect(h.polls()).toHaveLength(1);
    h.polls()[0]!.respond(200, { busy: false });
    await h.flush();
    expect(h.view().phase).toBe("listening");
  });

  test("ohne Abschlussereignis und bei Netzfehlern: weiter versuchen, bis die Abfrage frei meldet", async () => {
    const h = await waiting();
    // Verbindung weg: jede Abfrage scheitert, kein Ereignis kommt an
    for (let i = 0; i < 5; i++) {
      await h.advance(2000);
      expect(h.polls()).toHaveLength(i + 1);
      h.polls()[i]!.fail();
      await h.flush();
      expect(h.view().phase).toBe("waiting");
    }
    // Wieder da, fremde Erkennung oder Telegram-Turn zu Ende: kein Ereignis, nur die Abfrage
    await h.advance(2000);
    h.polls()[5]!.respond(200, { busy: false });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "Wieder frei. Sprich noch einmal." });
  });

  test("nach 2 Minuten ohne frei: Pausiert mit Satz, alles frei", async () => {
    const h = await waiting();
    for (let t = 0; t < 120_000; t += 2000) {
      await h.advance(2000);
      const open = h.polls().filter(c => !c.settled);
      for (const c of open) c.respond(200, { busy: true });
      await h.flush();
    }
    expect(h.view()).toMatchObject({ phase: "paused", label: "Pausiert", canResume: true });
    expect(h.view().note).toContain("seit zwei Minuten beschäftigt");
    expect(h.released()).toEqual(ALL_RELEASED);
    const polls = h.polls().length;
    await h.advance(60_000);
    expect(h.polls()).toHaveLength(polls);
  });

  test("404 und 409 closed aus der Abfrage: Fehler; 503: Fehler", async () => {
    const gone = await waiting();
    await gone.advance(2000);
    gone.polls()[0]!.respond(404, { error: "Gespräch nicht gefunden" });
    await gone.flush();
    expect(gone.view()).toMatchObject({ phase: "error", note: "Dieses Gespräch gibt es nicht mehr." });
    expect(gone.released()).toEqual(ALL_RELEASED);

    const closed = await waiting();
    await closed.advance(2000);
    closed.polls()[0]!.respond(409, { error: "Dieses Topic ist geschlossen.", closed: true });
    await closed.flush();
    expect(closed.view()).toMatchObject({ phase: "error", note: "Dieses Topic ist geschlossen." });
    expect(closed.seen.closed).toHaveLength(1);

    const off = await waiting();
    await off.advance(2000);
    off.polls()[0]!.respond(503, { error: "Der Sprechmodus ist nicht eingerichtet" });
    await off.flush();
    expect(off.view()).toMatchObject({ phase: "error", note: "Der Sprechmodus ist nicht eingerichtet" });
  });

  test("eine Antwort, die während des Wartens eintrifft, wird nicht vorgelesen", async () => {
    const h = await waiting();
    await h.add({ id: "fremd-1", role: "user", text: "Frage von nebenan", source: "speech", createdAt: "2026-09-30T10:00:00.000Z" });
    await h.add(h.reply("fremd-a"));
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.synth.spoken).toEqual([]);
    expect(h.ttsCalls()).toEqual([]);
  });

  test("beginnt beim Zuhören ein anderer Turn (getippte Nachricht): Wartet, danach ohne „Sprich noch einmal“", async () => {
    const h = speechHarness();
    await h.start();
    await h.emit({ type: "start" });
    h.mode.status(true, false);
    expect(h.view()).toMatchObject({ phase: "waiting", note: "In diesem Gespräch läuft gerade eine Antwort.", micOpen: false });
    expect(h.vad().active).toBe(false);
    // Eine Äußerung, die das Worklet noch nachreicht, wird nicht gesendet
    await h.emit({ type: "utterance", samples: new Int16Array(8000) });
    expect(h.uploads()).toHaveLength(0);
    h.mode.status(false, false);
    await h.flush();
    h.polls()[0]!.respond(200, { busy: false });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "" });
  });
});

describe("Denken", () => {
  test("Tipp fragt „Antwort abbrechen?“; Nein lässt den Turn laufen, Ja ruft stop", async () => {
    const h = speechHarness();
    await h.toThinking();
    h.mode.tap();
    expect(h.view()).toMatchObject({ phase: "thinking", confirm: true, note: "Antwort abbrechen?" });
    h.mode.confirmStop(false);
    await h.flush();
    expect(h.view().confirm).toBe(false);
    expect(h.stops()).toHaveLength(0);

    h.mode.tap();
    h.mode.confirmStop(true);
    await h.flush();
    expect(h.stops()).toHaveLength(1);
    expect(h.stops()[0]).toMatchObject({ method: "POST", path: `/api/conversations/${h.CONVERSATION}/stop` });
    h.stops()[0]!.respond(200, { stopping: true });
    expect(h.view()).toMatchObject({ phase: "thinking", confirm: false, note: "Wird abgebrochen …" });
    // Der Turn endet mit „Abgebrochen.": keine Antwort zum Vorlesen
    await h.add({ id: "e-1", role: "error", text: "Abgebrochen.", createdAt: "2026-09-30T10:00:03.000Z" });
    expect(h.view().phase).toBe("thinking");
    h.mode.status(false, false);
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "Keine Antwort zum Vorlesen. Siehe Verlauf." });
    expect(h.synth.spoken).toEqual([]);
  });

  test("Abbruch bestätigt, die Antwort kommt trotzdem als Ereignis: sie wird nicht vorgelesen", async () => {
    const h = speechHarness();
    await h.toThinking();
    h.mode.tap();
    h.mode.confirmStop(true);
    await h.flush();
    expect(h.stops()).toHaveLength(1);
    // Die Antwort überholt den Abbruch (POST …/stop ist noch unterwegs)
    await h.add(h.reply("a-1", ["Zu spät abgebrochen."]));
    expect(h.synth.spoken).toEqual([]);
    expect(h.view()).toMatchObject({ phase: "thinking", note: "Wird abgebrochen …" });
    h.stops()[0]!.respond(200, { stopping: true });
    h.mode.status(false, false);
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "Keine Antwort zum Vorlesen. Siehe Verlauf." });
    // Dieselbe Antwort noch einmal (Abgleich, doppeltes Ereignis): bleibt stumm
    h.mode.messagesChanged();
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.synth.spoken).toEqual([]);

    // Die nächste Äußerung wird wieder ganz normal beantwortet und vorgelesen
    await h.say();
    await h.accept("m-2");
    await h.add(h.own("m-2"));
    await h.add(h.reply("a-2", ["Neue Antwort."]));
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Neue Antwort."]);
  });

  test("Abbruch bestätigt, die Antwort kommt über den Verlaufsabgleich: sie wird nicht vorgelesen, auch wenn der Abbruch nie ankommt", async () => {
    const h = speechHarness();
    await h.toThinking();
    h.mode.tap();
    h.mode.confirmStop(true);
    await h.flush();
    // POST …/stop geht im Netz verloren, der Turn läuft zu Ende
    h.stops()[0]!.fail();
    await h.flush();
    // Verbindung weg, der Abgleich bringt die Antwort und das Ende des Turns
    h.list.push(h.reply("a-1", ["Aus dem Abgleich."]));
    h.mode.status(false, false);
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.synth.spoken).toEqual([]);
    expect(h.view()).toMatchObject({ phase: "listening", note: "Keine Antwort zum Vorlesen. Siehe Verlauf." });
    // Auch in einer späteren Sitzung nie
    h.mode.hangUp();
    await h.start();
    h.mode.messagesChanged();
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.synth.spoken).toEqual([]);
  });

  test("Nein auf „Antwort abbrechen?“ entwertet nichts: die Antwort wird vorgelesen", async () => {
    const h = speechHarness();
    await h.toThinking();
    h.mode.tap();
    h.mode.confirmStop(false);
    await h.add(h.reply("a-1", ["Doch gewollt."]));
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Doch gewollt."]);
  });

  test("wartet der Turn auf eine Rückfrage: Hinweis, der Zustand bleibt Denken", async () => {
    const h = speechHarness();
    await h.toThinking();
    h.mode.status(true, true);
    expect(h.view().phase).toBe("thinking");
    expect(h.view().note).toBe(`${h.win.TYBO_BRAND.name} fragt nach. Entscheide im Verlauf.`);
    // Frage und getippte Antwort im Verlauf beenden die Suche nicht
    await h.add({ id: "q-1", role: "assistant", text: "Darf ich suchen?", choiceId: "abc", createdAt: "2026-09-30T10:00:02.000Z" });
    await h.add({ id: "u-2", role: "user", text: "ja", createdAt: "2026-09-30T10:00:03.000Z" });
    h.mode.status(true, false);
    expect(h.view()).toMatchObject({ phase: "thinking", note: "" });
    await h.add(h.reply("a-1", ["Gefunden."]));
    expect(h.view().phase).toBe("speaking");
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Gefunden."]);
  });

  test("ehrliche Wartezeit: nach 8 Sekunden einmal der Hinweis", async () => {
    const h = speechHarness();
    await h.toThinking();
    await h.advance(7999);
    expect(h.view().note).toBe("");
    await h.advance(1);
    expect(h.view().note).toBe("Das kann je nach Motor dauern.");
    await h.advance(60_000);
    expect(h.view()).toMatchObject({ phase: "thinking", note: "Das kann je nach Motor dauern." });
  });

  test("Turn endet ohne Antwort: erst nach erfolgreichem Abgleich gilt „keine Antwort“", async () => {
    const h = speechHarness();
    await h.toThinking();
    const syncs = h.seen.syncs;
    h.mode.status(false, false);
    // running false allein entscheidet nichts: erst den Verlauf abgleichen
    expect(h.view().phase).toBe("thinking");
    expect(h.seen.syncs).toBe(syncs + 1);
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "Keine Antwort zum Vorlesen. Siehe Verlauf." });
  });

  test("der Abgleich bringt die Antwort doch noch: sie wird vorgelesen", async () => {
    const h = speechHarness();
    await h.toThinking();
    h.mode.status(false, false);
    h.list.push(h.reply("a-1", ["Da bin ich."]));
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.view().phase).toBe("speaking");
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Da bin ich."]);
  });

  test("Fehler-Ereignis des Turns: keine Antwort zum Vorlesen, sobald der Turn zu Ende ist", async () => {
    const h = speechHarness();
    await h.toThinking();
    await h.add({ id: "e-1", role: "error", text: "Der Turn ist fehlgeschlagen.", createdAt: "2026-09-30T10:00:03.000Z" });
    h.mode.turnError();
    expect(h.view().phase).toBe("thinking");
    h.mode.status(false, false);
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "Keine Antwort zum Vorlesen. Siehe Verlauf." });

    // Fehler ohne Kennung (nur Text): Abgleich anfordern, danach entscheiden
    const t = speechHarness();
    await t.toThinking();
    const syncs = t.seen.syncs;
    t.mode.turnError();
    expect(t.seen.syncs).toBe(syncs + 1);
    expect(t.view().phase).toBe("thinking");
    t.mode.status(false, false);
    t.mode.synced(false, t.mode.mark());
    await t.flush();
    expect(t.view().note).toBe("Keine Antwort zum Vorlesen. Siehe Verlauf.");
  });

  test("ein Abriss der Live-Verbindung ist kein Turn-Fehler: der Zustand bleibt, der Abgleich nach dem Neuverbinden entscheidet", async () => {
    const h = speechHarness();
    await h.toThinking();
    // Transportfehler von EventSource: die Seite meldet nichts an den Modus
    await h.advance(30_000);
    expect(h.view().phase).toBe("thinking");
    // Neu verbunden: der Status kommt vor dem Abgleich und läuft noch
    h.mode.status(true, false);
    h.mode.synced(true, h.mode.mark());
    await h.flush();
    expect(h.view().phase).toBe("thinking");
    // Später fertig, die Antwort kam in der Lücke: über den Abgleich
    h.mode.status(false, false);
    h.list.push(h.reply("a-1", ["Fertig."]));
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Fertig."]);
  });

  test("Antwort und Abschluss treffen vor der 202 ein (reines Web-Gespräch ohne Nutzer-Ereignis): der Abgleich nach der 202 findet sie", async () => {
    const h = speechHarness();
    await h.start();
    await h.say();
    // Der Turn ist schneller als die Antwort auf den Upload
    h.mode.status(true, false);
    await h.add(h.reply("a-1", ["Schnelle Antwort."]));
    h.mode.status(false, false);
    h.mode.turnError();
    expect(h.view().phase).toBe("understanding");
    expect(h.synth.spoken).toEqual([]);
    const mark = h.mode.mark();
    // Ein Abgleich, der vor der Annahme begann, kennt die Äußerung nicht und entscheidet nichts
    await h.accept("m-1");
    expect(h.view().phase).toBe("thinking");
    expect(h.seen.accepted).toBe(1);
    h.mode.synced(false, mark);
    await h.flush();
    expect(h.view().phase).toBe("thinking");
    // Der Abgleich nach der Annahme bringt die eigene Nachricht, einsortiert vor der Antwort
    h.list.unshift(h.own("m-1"));
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.view().phase).toBe("speaking");
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Schnelle Antwort."]);
  });

  test("Telegram-Gespräch: eigene Nachricht und Antwort kamen schon als Ereignis, die 202 startet das Vorlesen sofort", async () => {
    const h = speechHarness();
    await h.start("topic-443");
    await h.say();
    await h.add(h.own("web-1"));
    await h.add(h.reply("web-2", ["Sofort."]));
    h.mode.status(false, false);
    await h.accept("web-1");
    expect(h.view().phase).toBe("speaking");
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Sofort."]);
  });
});

describe("Pausieren und Weiter", () => {
  test("nach 2 Minuten ohne Sprache: Pausiert, Spuren gestoppt, AudioContext zu, Wake Lock frei", async () => {
    const h = speechHarness();
    await h.start();
    await h.advance(119_999);
    expect(h.view().phase).toBe("listening");
    await h.advance(1);
    expect(h.view()).toMatchObject({ phase: "paused", label: "Pausiert", canResume: true, canPause: false, micOpen: false });
    expect(h.view().note).toContain("Zwei Minuten nichts gehört");
    expect(h.released()).toEqual(ALL_RELEASED);
    // Im Zustand Pausiert holt visibilitychange den Wake Lock nicht zurück
    h.mode.visibility(true);
    await h.flush();
    expect(h.wake.requests).toBe(1);
  });

  test("Sprache hält den Modus wach: die zwei Minuten zählen ab dem letzten Zuhören ohne Sprache", async () => {
    const h = speechHarness();
    await h.start();
    await h.advance(100_000);
    await h.emit({ type: "start" });
    // Während gesprochen wird, läuft die Frist nicht
    await h.advance(200_000);
    expect(h.view().phase).toBe("listening");
    // Verworfen (Husten): die Frist beginnt neu
    await h.emit({ type: "dropped" });
    expect(h.view().voiceActive).toBe(false);
    await h.advance(119_999);
    expect(h.view().phase).toBe("listening");
    await h.advance(1);
    expect(h.view().phase).toBe("paused");
  });

  test("„Weiter“ holt das Mikrofon neu und schaltet die Ausgabe wieder frei", async () => {
    const h = speechHarness();
    await h.start();
    const first = h.tracks()[0]!;
    h.mode.pause();
    expect(h.view()).toMatchObject({ phase: "paused", note: "Das Mikrofon ist aus." });
    expect(first.stopped).toBe(true);
    expect(h.contexts[0].closed).toBe(true);
    expect(h.wake.sentinels[0].released).toBe(true);
    const unlocks = h.synth.unlocks.length;

    h.mode.resume();
    expect(h.view().phase).toBe("starting");
    expect(h.synth.unlocks.length).toBe(unlocks + 1);
    await h.flush();
    expect(h.view().phase).toBe("listening");
    expect(h.mic.calls).toHaveLength(2);
    expect(h.mic.streams).toHaveLength(2);
    expect(h.contexts).toHaveLength(2);
    expect(h.contexts[1].closed).toBe(false);
    expect(h.tracks()[1]!.stopped).toBe(false);
    expect(h.wake.requests).toBe(2);
    expect(h.vad()).toMatchObject({ active: true });
    // Das alte Worklet wirkt nicht mehr
    await h.emit({ type: "utterance", samples: new Int16Array(8000) }, h.nodes[0]);
    expect(h.uploads()).toHaveLength(0);
    // Das neue schon
    await h.say();
    expect(h.uploads()).toHaveLength(1);
  });

  test("„Weiter“ mit verweigertem Mikrofon: Fehler mit dem Mikrofon-Text", async () => {
    const h = speechHarness();
    await h.start();
    h.mode.pause();
    h.mic.mode = "deny";
    h.mode.resume();
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "error", note: "Mikrofon: NotAllowedError" });
    expect(h.released()).toEqual(ALL_RELEASED);
  });

  test("Pause beim Verstehen: der Upload wird abgebrochen, ein spätes Ergebnis wirkt nicht, nichts wird erneut gesendet", async () => {
    const h = speechHarness();
    await h.start();
    await h.say();
    const upload = h.lastUpload();
    h.mode.pause();
    await h.flush();
    expect(upload.aborted).toBe(true);
    expect(h.view().phase).toBe("paused");
    expect(h.released()).toEqual(ALL_RELEASED);
    // „Weiter": frisch zuhören; die Antwort des alten Turns (er könnte laufen) bleibt stumm
    h.mode.resume();
    await h.flush();
    await h.add(h.own("m-1"));
    await h.add(h.reply("a-1"));
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.view().phase).toBe("listening");
    expect(h.synth.spoken).toEqual([]);
    expect(h.uploads()).toHaveLength(1);
  });

  test("Pause beim Denken: die Antwort kommt in den Verlauf, wird aber nicht vorgelesen", async () => {
    const h = speechHarness();
    await h.toThinking();
    h.mode.pause();
    expect(h.released()).toEqual(ALL_RELEASED);
    await h.add(h.reply("a-1"));
    h.mode.status(false, false);
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.view().phase).toBe("paused");
    expect(h.synth.spoken).toEqual([]);
    expect(h.stops()).toHaveLength(0);
    // Auch nach „Weiter" nicht: die Antwort gehört zu einer alten Äußerung
    h.mode.resume();
    await h.flush();
    h.mode.messagesChanged();
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.view().phase).toBe("listening");
    expect(h.synth.spoken).toEqual([]);
  });

  test("ein Wake Lock, der erst nach der Pause zugesagt wird, ist sofort wieder frei", async () => {
    const h = speechHarness({ wakeAuto: false });
    await h.start();
    expect(h.wake.pending).toHaveLength(1);
    h.mode.pause();
    const late = h.wake.sentinel();
    h.wake.pending[0]!.resolve(late);
    await h.flush();
    expect(late.released).toBe(true);
    h.mode.visibility(true);
    await h.flush();
    expect(h.wake.requests).toBe(1);
  });
});

describe("Wake Lock", () => {
  test("nach visibilitychange neu holen, solange der Modus läuft; ohne Wake Lock im Browser geht alles weiter", async () => {
    const h = speechHarness();
    await h.start();
    expect(h.wake.requests).toBe(1);
    // Sichtbar, Lock noch da: nichts Neues
    h.mode.visibility(true);
    await h.flush();
    expect(h.wake.requests).toBe(1);
    // Der Browser gibt ihn im Hintergrund frei
    h.wake.sentinels[0].lose();
    h.mode.visibility(false);
    await h.flush();
    expect(h.wake.requests).toBe(1);
    h.mode.visibility(true);
    await h.flush();
    expect(h.wake.requests).toBe(2);
    h.mode.hangUp();
    expect(h.wake.sentinels.every((w: any) => w.released)).toBe(true);
    h.mode.visibility(true);
    await h.flush();
    expect(h.wake.requests).toBe(2);

    const none = speechHarness({ wakeLock: false });
    await none.start();
    expect(none.view().phase).toBe("listening");
  });
});

describe("Auflegen und späte Ergebnisse", () => {
  test("Auflegen gibt alles frei: Spuren, AudioContext, Worklet, Zeitgeber, Upload, Wake Lock", async () => {
    const h = speechHarness();
    await h.start();
    await h.say();
    const upload = h.lastUpload();
    const node = h.node();
    h.mode.hangUp();
    expect(h.view().phase).toBe("off");
    expect(h.tracks().every(t => t.stopped)).toBe(true);
    expect(h.contexts[0].closed).toBe(true);
    expect(node.port.posted.at(-1)).toEqual({ type: "close" });
    expect(node.port.onmessage).toBeNull();
    expect(node.disconnected).toBe(1);
    expect(upload.aborted).toBe(true);
    expect(h.wake.sentinels[0].released).toBe(true);
    expect(h.timerCount()).toBe(0);
    expect(h.released()).toEqual(ALL_RELEASED);
    // Ein laufender Turn wird nicht abgebrochen
    expect(h.stops()).toHaveLength(0);
  });

  test("ein Mikrofon-Stream, der erst nach dem Auflegen eintrifft, wird sofort gestoppt", async () => {
    const h = speechHarness({ microphone: "manual" });
    h.mode.start(h.CONVERSATION, h.status);
    await h.flush();
    expect(h.view().phase).toBe("starting");
    h.mode.hangUp();
    const late = new FakeStream();
    h.mic.pending[0]!.resolve(late);
    await h.flush();
    expect(late.tracks[0]!.stopped).toBe(true);
    expect(h.view().phase).toBe("off");
    expect(h.nodes).toHaveLength(0);
    expect(h.released()).toEqual(ALL_RELEASED);
  });

  test("ein Stream aus einer früheren Sitzung startet keine Aufnahme in der neuen", async () => {
    const h = speechHarness({ microphone: "manual" });
    h.mode.start(h.CONVERSATION, h.status);
    await h.flush();
    h.mode.hangUp();
    h.mode.start(h.CONVERSATION, h.status);
    await h.flush();
    expect(h.mic.pending).toHaveLength(2);
    // Der alte Stream kommt zuerst: gestoppt, die neue Sitzung wartet weiter auf ihren
    const old = new FakeStream();
    h.mic.pending[0]!.resolve(old);
    await h.flush();
    expect(old.tracks[0]!.stopped).toBe(true);
    expect(h.view().phase).toBe("starting");
    const fresh = new FakeStream();
    h.mic.pending[1]!.resolve(fresh);
    await h.flush();
    expect(h.view().phase).toBe("listening");
    expect(fresh.tracks[0]!.stopped).toBe(false);
    expect(h.nodes).toHaveLength(1);
  });

  test("addModule, das erst nach dem Auflegen fertig wird, schließt nichts an", async () => {
    const h = speechHarness({ module: "manual" });
    h.mode.start(h.CONVERSATION, h.status);
    await h.flush();
    expect(h.view().phase).toBe("starting");
    h.mode.hangUp();
    h.modules[0]!.resolve();
    await h.flush();
    expect(h.nodes).toHaveLength(0);
    expect(h.view().phase).toBe("off");
    expect(h.released()).toEqual(ALL_RELEASED);
  });

  test("eine 202, die nach dem Auflegen eintrifft, startet weder Denken noch Vorlesen", async () => {
    const h = speechHarness();
    await h.start();
    await h.say();
    const upload = h.lastUpload();
    h.mode.hangUp();
    // Der Abbruch hat die Anfrage schon beendet; auch eine doch noch gelieferte Antwort wirkt nicht
    upload.respond(202, { transcript: "zu spät", messageId: "m-1" });
    await h.flush();
    await h.add(h.own("m-1"));
    await h.add(h.reply("a-1"));
    h.mode.status(false, false);
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.view().phase).toBe("off");
    expect(h.seen.accepted).toBe(0);
    expect(h.synth.spoken).toEqual([]);
  });

  test("Ereignisse, Worklet-Meldungen und Zeitgeber nach dem Auflegen bleiben ohne Wirkung", async () => {
    const h = speechHarness();
    await h.toThinking();
    const node = h.node();
    h.mode.hangUp();
    const changes = h.seen.changes;
    await h.add(h.reply("a-1"));
    h.mode.status(false, false);
    h.mode.synced(false, h.mode.mark());
    h.mode.turnError();
    h.mode.progress("Schritt");
    h.mode.tap();
    h.mode.confirmStop(true);
    h.mode.resume();
    node.port.onmessage?.({ data: { type: "utterance", epoch: 99, samples: new Int16Array(100) } });
    await h.advance(600_000);
    expect(h.view().phase).toBe("off");
    expect(h.seen.changes).toBe(changes);
    expect(h.synth.spoken).toEqual([]);
    expect(h.mic.calls).toHaveLength(1);
    expect(h.uploads()).toHaveLength(1);
    expect(h.stops()).toHaveLength(0);
    expect(h.polls()).toHaveLength(0);
  });

  test("eine Abfrage, die nach dem Auflegen antwortet, startet keine Aufnahme", async () => {
    const h = speechHarness();
    await h.start();
    await h.say();
    await h.answerUpload(409, { error: "läuft", reason: "beschaeftigt" });
    await h.advance(2000);
    const poll = h.polls()[0]!;
    h.mode.hangUp();
    expect(poll.aborted).toBe(true);
    poll.respond(200, { busy: false });
    await h.flush();
    expect(h.view().phase).toBe("off");
    expect(h.released()).toEqual(ALL_RELEASED);
  });

  test("ein Wake Lock, der erst nach dem Auflegen zugesagt wird, ist sofort wieder frei", async () => {
    const h = speechHarness({ wakeAuto: false });
    await h.start();
    h.mode.hangUp();
    const late = h.wake.sentinel();
    h.wake.pending[0]!.resolve(late);
    await h.flush();
    expect(late.released).toBe(true);
  });

  test("nach dem Auflegen geht eine neue Sitzung im selben Fenster", async () => {
    const h = speechHarness();
    await h.start();
    h.mode.hangUp();
    await h.start();
    expect(h.view().phase).toBe("listening");
    expect(h.mic.streams).toHaveLength(2);
    expect(h.mic.streams[0]!.tracks[0]!.stopped).toBe(true);
    expect(h.mic.streams[1]!.tracks[0]!.stopped).toBe(false);
  });
});

describe("Voraussetzungen und Modi", () => {
  test("speechModeSupported: sicherer Kontext, Mikrofon, AudioContext mit audioWorklet; MediaRecorder ist nicht nötig", () => {
    const h = speechHarness();
    const ok = h.api.speechModeSupported;
    expect(h.win.MediaRecorder).toBeUndefined();
    expect(ok(h.win, h.status)).toBe(true);
    expect(ok({ ...h.win, isSecureContext: false }, h.status)).toBe(false);
    expect(ok({ ...h.win, navigator: {} }, h.status)).toBe(false);
    expect(ok({ ...h.win, AudioContext: undefined }, h.status)).toBe(false);
    expect(ok({ ...h.win, AudioContext: class {} }, h.status)).toBe(false);
    expect(ok({ ...h.win, AudioWorkletNode: undefined }, h.status)).toBe(false);
    // Browser-Stimme braucht speechSynthesis, die Server-Stimme ein Audio-Element
    expect(ok({ ...h.win, speechSynthesis: undefined }, h.status)).toBe(false);
    const server = { ...h.status, tts: { ...h.status.tts, where: "server" } };
    expect(ok({ ...h.win, speechSynthesis: undefined }, server)).toBe(true);
    expect(ok({ ...h.win, Audio: undefined }, server)).toBe(false);
    expect(ok(null, h.status)).toBe(false);
    expect(ok({ get isSecureContext() { throw new Error("kaputt"); } }, h.status)).toBe(false);
  });

  test("readySpeechModes: die bereiten Modi als Liste, heute nur local", () => {
    const { readySpeechModes } = speechHarness().api;
    expect(readySpeechModes(null)).toEqual([]);
    expect(readySpeechModes({})).toEqual([]);
    expect(readySpeechModes({ modes: { local: { ready: false, reason: "kein Anbieter" } } })).toEqual([]);
    const local = { ready: true, tts: { where: "browser" } };
    expect(readySpeechModes({ modes: { local } })).toEqual([{ id: "local", status: local }]);
    // Ein Modus, den diese Fassung nicht kennt, wird nicht gestartet
    expect(readySpeechModes({ modes: { agent: { ready: true }, local } }).map((m: any) => m.id)).toEqual(["local"]);
  });

  test("Texte der Zustände", () => {
    expect(T.busy).toBe("In diesem Gespräch läuft schon eine Antwort. Nichts gesendet.");
    expect(T.free).toBe("Wieder frei. Sprich noch einmal.");
    expect(T.limit).toBe("Längste Äußerung erreicht, gesendet.");
    expect(T.noAnswer).toBe("Keine Antwort zum Vorlesen. Siehe Verlauf.");
    expect(T.slow).toBe("Das kann je nach Motor dauern.");
    expect(T.button).toBe(`Mit ${speechHarness().win.TYBO_BRAND.name} sprechen`);
    // Keine Gedankenstriche in Oberflächentexten
    for (const [key, value] of Object.entries(Object.getOwnPropertyDescriptors(T))) {
      const text = typeof value.value === "string" ? value.value : "";
      if (text.includes("—")) throw new Error(`Gedankenstrich in ${key}`);
    }
  });
});
