/**
 * Issue #250, Checkbox 4: Vorlesen im Sprechmodus (src/web/public/speech.js)
 * ohne Browser, mit Attrappen für speechSynthesis, fetch und Audio
 * (tests/speech-mode-fixture.ts): welche Antwort vorgelesen wird,
 * Browser-Stimme satzweise mit Wächter, Server-Stimme mit Vorladen und
 * Freigabe der Blob-URLs, Unterbrechen per Tipp und per Stimme (Kopfhörer).
 */
import { describe, expect, test } from "bun:test";
import { ALL_RELEASED, speechHarness, type HarnessOptions } from "./speech-mode-fixture";

const FAILED = "Vorlesen fehlgeschlagen. Die Antwort steht im Verlauf.";

/** Bis „Spricht": Äußerung angenommen, eigene Nachricht und Antwort im Verlauf */
async function speaking(options: HarnessOptions = {}, segments = ["Erster Satz der Antwort.", "Zweiter Satz der Antwort.", "Dritter Satz der Antwort."]) {
  const h = speechHarness(options);
  await h.toThinking("m-1");
  await h.add(h.reply("a-1", segments));
  h.mode.status(false, false);
  await h.flush();
  return h;
}

describe("welche Antwort vorgelesen wird", () => {
  test("genau einmal: als Ereignis und noch einmal über den Abgleich geliefert, nie doppelt", async () => {
    const h = await speaking({}, ["Nur ein Satz."]);
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Nur ein Satz."]);
    // Dieselbe Nachricht kommt noch einmal (Abgleich nach dem Ereignis)
    h.mode.messagesChanged();
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.synth.spoken).toHaveLength(1);
    h.synth.spoken[0]!.onend!();
    await h.flush();
    expect(h.view().phase).toBe("listening");
    // Auch beim Zuhören danach nicht
    h.mode.messagesChanged();
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.synth.spoken).toHaveLength(1);
  });

  test("historische Antworten bleiben stumm: nur was hinter der eigenen Nachricht steht", async () => {
    const h = speechHarness();
    h.list.push({ id: "alt-u", role: "user", text: "Frage von gestern", source: "speech", createdAt: "2026-09-29T10:00:00.000Z" });
    h.list.push({ ...h.reply("alt-a", ["Antwort von gestern."]), createdAt: "2026-09-29T10:00:05.000Z" });
    await h.toThinking("m-1");
    h.mode.synced(true, h.mode.mark());
    await h.flush();
    expect(h.view().phase).toBe("thinking");
    expect(h.synth.spoken).toEqual([]);
    await h.add(h.reply("a-1", ["Antwort von heute."]));
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Antwort von heute."]);
  });

  test("nach einem Neuverbinden kommt die Antwort über den Abgleich: einmal vorgelesen, das spätere Ereignis schweigt", async () => {
    const h = speechHarness();
    await h.toThinking("m-1");
    // Verbindung weg, der Turn endet in der Lücke; der Abgleich bringt die Antwort
    h.list.push(h.reply("a-1", ["Aus dem Abgleich."]));
    h.mode.status(false, false);
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Aus dem Abgleich."]);
    h.mode.messagesChanged();
    await h.flush();
    expect(h.synth.spoken).toHaveLength(1);
  });

  test("eigener Turn gescheitert, fremde Sprech-Antwort in der Verbindungslücke: bleibt stumm", async () => {
    // Web-Gespräch: die Fehlermeldung des eigenen Turns steht im Verlauf
    const web = speechHarness();
    await web.toThinking("m-1");
    web.list.push({ id: "e-1", role: "error", text: "Der Turn ist fehlgeschlagen.", createdAt: "2026-09-30T10:00:02.000Z" });
    web.list.push({ id: "u-fremd", role: "user", text: "Frage aus dem anderen Browser", source: "speech", createdAt: "2026-09-30T10:00:03.000Z" });
    web.list.push({ ...web.reply("a-fremd", ["Antwort für den anderen."]), createdAt: "2026-09-30T10:00:08.000Z" });
    web.mode.status(false, false);
    web.mode.synced(false, web.mode.mark());
    await web.flush();
    expect(web.synth.spoken).toEqual([]);
    expect(web.view()).toMatchObject({ phase: "listening", note: "Keine Antwort zum Vorlesen. Siehe Verlauf." });

    // Telegram-Gespräch: die Fehlermeldung gab es nur live und fehlt nach der Lücke
    const topic = speechHarness();
    await topic.toThinking("web-1");
    topic.list.push({ id: "web-2", role: "user", text: "Frage aus dem anderen Browser", source: "speech", createdAt: "2026-09-30T10:00:03.000Z" });
    topic.list.push({ ...topic.reply("web-3", ["Antwort für den anderen."]), createdAt: "2026-09-30T10:00:08.000Z" });
    topic.mode.status(false, false);
    topic.mode.synced(false, topic.mode.mark());
    await topic.flush();
    expect(topic.synth.spoken).toEqual([]);
    expect(topic.view()).toMatchObject({ phase: "listening", note: "Keine Antwort zum Vorlesen. Siehe Verlauf." });
  });

  test("fremde Äußerung läuft noch: die eigene bleibt ohne Antwort, danach wartet der Modus auf das Ende des fremden Turns", async () => {
    const h = speechHarness();
    await h.toThinking("m-1");
    h.list.push({ id: "u-fremd", role: "user", text: "Frage aus dem anderen Browser", source: "speech", createdAt: "2026-09-30T10:00:03.000Z" });
    h.mode.status(true, false);
    h.mode.synced(true, h.mode.mark());
    await h.flush();
    // Solange etwas läuft, steht „Denkt"; die fremde Antwort wird nicht vorgelesen
    expect(h.view().phase).toBe("thinking");
    await h.add({ ...h.reply("a-fremd", ["Antwort für den anderen."]), createdAt: "2026-09-30T10:00:08.000Z" });
    expect(h.synth.spoken).toEqual([]);
    h.mode.status(false, false);
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "Keine Antwort zum Vorlesen. Siehe Verlauf." });
    expect(h.synth.spoken).toEqual([]);
  });

  test("eine schon vorgelesene Antwort wird auch in einer späteren Sitzung nie wieder vorgelesen", async () => {
    const h = await speaking({}, ["Einmal reicht."]);
    h.mode.hangUp();
    await h.start();
    await h.say();
    await h.accept("m-2");
    // Fehlerhafter Verlauf: dieselbe Antwort steht hinter der neuen Äußerung
    h.list.length = 0;
    h.list.push(h.own("m-2"), h.reply("a-1", ["Einmal reicht."]));
    h.mode.status(false, false);
    h.mode.synced(false, h.mode.mark());
    await h.flush();
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Einmal reicht."]);
    expect(h.view()).toMatchObject({ phase: "listening", note: "Keine Antwort zum Vorlesen. Siehe Verlauf." });
  });

  test("Antwort ohne speakSegments: die vorlesbare Fassung als ein Stück; Meldungen und Antworten ohne speakable zählen nicht", async () => {
    const h = speechHarness();
    await h.toThinking("m-1");
    await h.add({ id: "n-1", role: "assistant", kind: "notice", text: "Pipeline fertig", speakable: "Pipeline fertig", createdAt: "2026-09-30T10:00:02.000Z" });
    await h.add({ id: "x-1", role: "assistant", text: "Zwischenfrage", createdAt: "2026-09-30T10:00:03.000Z" });
    await h.add({ id: "x-2", role: "assistant", text: "Leer", speakable: "  ", createdAt: "2026-09-30T10:00:03.500Z" });
    expect(h.view().phase).toBe("thinking");
    await h.add({ id: "a-1", role: "assistant", text: "**Ganz** kurz.", speakable: "Ganz kurz.", createdAt: "2026-09-30T10:00:04.000Z" });
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Ganz kurz."]);
  });

  test("der Anfang der Antwort steht im Bereich, lange Antworten gekürzt", async () => {
    const long = "Wort ".repeat(60).trim() + ".";
    const h = await speaking({}, [long]);
    expect([...h.view().reply].length).toBe(162);
    expect(h.view().reply.endsWith(" …")).toBe(true);
    expect(h.view().heard).toBe("Wie wird das Wetter?");
  });
});

describe("Browser-Stimme", () => {
  test("satzweise: ein SpeechSynthesisUtterance je Segment, in Reihenfolge, mit Stimme, Sprache und Tempo des Geräts", async () => {
    const h = await speaking({
      device: { voice: "Petra", rate: 1.2 },
      voices: [
        { voiceURI: "Online", lang: "de-DE", localService: false },
        { voiceURI: "Anna", lang: "de-DE", localService: true },
        { voiceURI: "Petra", lang: "de-AT", localService: true },
        { voiceURI: "Samantha", lang: "en-US", localService: true },
      ],
    });
    expect(h.view().phase).toBe("speaking");
    // Immer nur das laufende Segment liegt bei der Stimme
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Erster Satz der Antwort."]);
    const first = h.synth.spoken[0]!;
    expect(first.voice.voiceURI).toBe("Petra");
    expect(first.lang).toBe("de-AT");
    expect(first.rate).toBe(1.2);
    first.onend!();
    await h.flush();
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Erster Satz der Antwort.", "Zweiter Satz der Antwort."]);
    // Ein Fehler der Stimme überspringt das Segment
    h.synth.spoken[1]!.onerror!({ error: "synthesis-failed" });
    await h.flush();
    expect(h.synth.spoken).toHaveLength(3);
    expect(h.view().phase).toBe("speaking");
    h.synth.spoken[2]!.onend!();
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "" });
    expect(h.synth.spoken).toHaveLength(3);
  });

  test("der Tipp auf „Sprechen“ schaltet die Ausgabe frei (stummes Stück), bevor das Mikrofon gefragt wird", async () => {
    const h = speechHarness({ microphone: "manual" });
    h.mode.start(h.CONVERSATION, h.status);
    expect(h.synth.unlocks).toHaveLength(1);
    expect(h.synth.unlocks[0]!.volume).toBe(0);
    expect(h.synth.spoken).toEqual([]);
  });

  test("Wächter: kommt weder end noch error, abbrechen und weiter mit dem nächsten Segment", async () => {
    const h = await speaking();
    const guard = h.api.speechGuardMs("Erster Satz der Antwort.", 1);
    const cancelled = h.synth.cancelled;
    await h.advance(guard - 1);
    expect(h.synth.spoken).toHaveLength(1);
    await h.advance(1);
    expect(h.synth.cancelled).toBe(cancelled + 1);
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Erster Satz der Antwort.", "Zweiter Satz der Antwort."]);
    // Das abgebrochene Segment meldet sich doch noch: kein Sprung über das nächste
    h.synth.spoken[0]!.onerror!({ error: "canceled" });
    h.synth.spoken[0]!.onend!();
    await h.flush();
    expect(h.synth.spoken).toHaveLength(2);
    // Ein Segment, das rechtzeitig endet, löst den Wächter nicht mehr aus
    h.synth.spoken[1]!.onend!();
    await h.flush();
    expect(h.synth.spoken).toHaveLength(3);
    const before = h.synth.cancelled;
    h.synth.spoken[2]!.onend!();
    await h.flush();
    await h.advance(120_000 - 1);
    expect(h.synth.cancelled).toBe(before + 1);
    // Länger braucht ein langsames Tempo, und lange Segmente bekommen mehr Zeit
    expect(h.api.speechGuardMs("x".repeat(600), 0.8)).toBeGreaterThan(h.api.speechGuardMs("x".repeat(600), 1.4));
    expect(h.api.speechGuardMs("x".repeat(600), 1)).toBeGreaterThan(60_000);
  });

  test("spät geladene Stimmen (voiceschanged): jedes Segment liest die Liste frisch", async () => {
    const h = await speaking({ voices: [] });
    const first = h.synth.spoken[0]!;
    expect(first.voice).toBeNull();
    expect(first.lang).toBe("de-DE");
    h.synth.voices = [{ voiceURI: "Anna", lang: "de-DE", localService: true }];
    first.onend!();
    await h.flush();
    expect(h.synth.spoken[1]!.voice.voiceURI).toBe("Anna");
  });

  test("keine deutsche Stimme: gesprochen wird mit lang de-DE; eine gewählte Stimme aus allen gilt", async () => {
    const voices = [{ voiceURI: "Samantha", lang: "en-US", localService: true }, { voiceURI: "Thomas", lang: "fr-FR", localService: true }];
    const none = await speaking({ voices });
    expect(none.synth.spoken[0]!.voice).toBeNull();
    expect(none.synth.spoken[0]!.lang).toBe("de-DE");
    const picked = await speaking({ voices, device: { voice: "Thomas" } });
    expect(picked.synth.spoken[0]!.voice.voiceURI).toBe("Thomas");
    expect(picked.synth.spoken[0]!.lang).toBe("de-DE");
  });

  test("Auswahl der Stimmen: deutsche, lokale vor Online-Stimmen; fehlt die gespeicherte, gilt die Vorauswahl", () => {
    const h = speechHarness({
      voices: [
        { voiceURI: "Google Deutsch", lang: "de-DE", localService: false },
        { voiceURI: "Samantha", lang: "en-US", localService: true },
        { voiceURI: "Anna", lang: "de_DE", localService: true },
        { voiceURI: "Markus", lang: "de", localService: true },
      ],
    });
    const voices = h.api.speechModeVoices(h.win);
    expect(voices.german).toBe(true);
    expect(voices.list.map((v: any) => v.voiceURI)).toEqual(["Anna", "Markus", "Google Deutsch"]);
    expect(h.api.speechModeVoice(voices, "Markus").voiceURI).toBe("Markus");
    expect(h.api.speechModeVoice(voices, "Gelöscht").voiceURI).toBe("Anna");
    expect(h.api.speechModeVoice(voices, "").voiceURI).toBe("Anna");
    // Eine englische Stimme lässt sich nicht wählen, solange es deutsche gibt
    expect(h.api.speechModeVoice(voices, "Samantha").voiceURI).toBe("Anna");

    h.synth.voices = [{ voiceURI: "Samantha", lang: "en-US", localService: false }, { voiceURI: "Thomas", lang: "fr-FR", localService: true }];
    const foreign = h.api.speechModeVoices(h.win);
    expect(foreign.german).toBe(false);
    expect(foreign.list.map((v: any) => v.voiceURI)).toEqual(["Thomas", "Samantha"]);
    expect(h.api.speechModeVoice(foreign, "")).toBeNull();
    expect(h.api.speechModeVoice(foreign, "Samantha").voiceURI).toBe("Samantha");

    // Ohne speechSynthesis und bei einem Fehler: leer, kein Absturz
    expect(h.api.speechModeVoices({})).toEqual({ list: [], german: false });
    expect(h.api.speechModeVoices({ speechSynthesis: { getVoices() { throw new Error("kaputt"); } } })).toEqual({ list: [], german: false });
  });

  test("blockiert (not-allowed): Hinweis, der nächste Tipp spielt dasselbe Segment", async () => {
    const h = await speaking();
    h.synth.spoken[0]!.onerror!({ error: "not-allowed" });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "speaking", blocked: true, note: "Tippe, um die Antwort zu hören." });
    expect(h.synth.spoken).toHaveLength(1);
    h.mode.tap();
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "speaking", blocked: false, note: "" });
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Erster Satz der Antwort.", "Erster Satz der Antwort."]);
  });

  test("ohne speechSynthesis: Hinweis statt Absturz", async () => {
    const h = speechHarness({ synth: false });
    await h.toThinking("m-1");
    h.mode.status(false, false);
    await h.add(h.reply("a-1"));
    expect(h.view()).toMatchObject({ phase: "listening", note: FAILED });
  });
});

describe("Server-Stimme", () => {
  const blob = (n: number) => new Blob([`ton-${n}`], { type: "audio/wav" });

  test("ein Audio-Element, beim Tipp angelegt und freigeschaltet, für alle Segmente wiederverwendet", async () => {
    const h = speechHarness({ tts: "server", microphone: "manual" });
    h.mode.start(h.CONVERSATION, h.status);
    // Noch im Tipp: Element da, spielt kurze Stille aus einer blob:-Adresse
    expect(h.audios).toHaveLength(1);
    expect(h.audios[0].plays).toBe(1);
    expect(h.urls.created).toHaveLength(1);
    expect(h.urls.blobs.get(h.urls.created[0]!)!.type).toBe("audio/wav");
    h.audios[0].onended();
    expect(h.urls.live.size).toBe(0);
  });

  test("Segmente in Reihenfolge, höchstens eines vorgeladen, Blob-URLs nach dem Abspielen frei", async () => {
    const h = await speaking({ tts: "server", device: { rate: 1.3 } });
    const audio = h.audios[0];
    expect(h.audios).toHaveLength(1);
    expect(h.view().phase).toBe("speaking");
    // Erst nur das erste Segment
    expect(h.ttsCalls().map(c => JSON.parse(c.body))).toEqual([{ text: "Erster Satz der Antwort." }]);
    expect(h.ttsCalls()[0]!.headers["Content-Type"]).toBe("application/json");
    const playsBefore = audio.plays;
    h.ttsCalls()[0]!.respond(200, undefined, blob(1));
    await h.flush();
    // Das erste läuft, genau das zweite wird vorgeladen, das dritte noch nicht
    expect(audio.plays).toBe(playsBefore + 1);
    expect(audio.playbackRate).toBe(1.3);
    expect(h.ttsCalls().map(c => JSON.parse(c.body).text)).toEqual(["Erster Satz der Antwort.", "Zweiter Satz der Antwort."]);
    const firstUrl = audio.src;
    expect(await h.urls.blobs.get(firstUrl)!.text()).toBe("ton-1");
    expect(h.urls.live.has(firstUrl)).toBe(true);
    h.ttsCalls()[1]!.respond(200, undefined, blob(2));
    await h.flush();
    // Vorgeladen heißt geholt, nicht gespielt; und kein drittes Segment unterwegs
    expect(audio.plays).toBe(playsBefore + 1);
    expect(h.ttsCalls()).toHaveLength(2);

    audio.onended();
    await h.flush();
    expect(h.urls.live.has(firstUrl)).toBe(false);
    expect(audio.plays).toBe(playsBefore + 2);
    expect(await h.urls.blobs.get(audio.src)!.text()).toBe("ton-2");
    expect(h.ttsCalls().map(c => JSON.parse(c.body).text)).toEqual(["Erster Satz der Antwort.", "Zweiter Satz der Antwort.", "Dritter Satz der Antwort."]);
    // Das dritte ist noch nicht da, wenn das zweite endet: gespielt wird, sobald es kommt
    const secondUrl = audio.src;
    audio.onended();
    await h.flush();
    expect(h.urls.live.has(secondUrl)).toBe(false);
    expect(audio.plays).toBe(playsBefore + 2);
    h.ttsCalls()[2]!.respond(200, undefined, blob(3));
    await h.flush();
    expect(audio.plays).toBe(playsBefore + 3);
    expect(await h.urls.blobs.get(audio.src)!.text()).toBe("ton-3");
    audio.onended();
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "" });
    expect(h.urls.live.size).toBe(0);
    expect(h.ttsCalls()).toHaveLength(3);
    expect(h.calls.filter(c => !c.settled)).toEqual([]);
    // Die Browser-Stimme hat nichts gesprochen
    expect(h.synth.spoken).toEqual([]);
    // Alle gespielten Adressen sind blob:-Adressen
    expect(audio.played.every((u: string) => u.startsWith("blob:"))).toBe(true);
  });

  test("Stopp per Tipp: Ausgabe sofort aus, Vorladen verworfen, keine offene Anfrage, keine Blob-URL", async () => {
    const h = await speaking({ tts: "server" });
    const audio = h.audios[0];
    h.ttsCalls()[0]!.respond(200, undefined, blob(1));
    await h.flush();
    expect(audio.paused).toBe(false);
    const preload = h.ttsCalls()[1]!;
    expect(preload.settled).toBe(false);
    h.mode.tap();
    await h.flush();
    expect(h.view().phase).toBe("listening");
    expect(audio.paused).toBe(true);
    expect(preload.aborted).toBe(true);
    expect(h.calls.filter(c => !c.settled)).toEqual([]);
    expect(h.urls.live.size).toBe(0);
    expect(h.tracks()[0]!.enabled).toBe(true);
    // Späte Ergebnisse: das alte ended und ein doch noch geliefertes Segment starten nichts
    const plays = audio.plays;
    const created = h.urls.created.length;
    audio.onended?.();
    preload.respond(200, undefined, blob(2));
    await h.flush();
    expect(audio.plays).toBe(plays);
    expect(h.urls.created.length).toBe(created);
    expect(h.ttsCalls()).toHaveLength(2);
  });

  test("Stopp, während das erste Segment noch geholt wird: die Antwort des Servers wird nie zur Adresse", async () => {
    const h = await speaking({ tts: "server" });
    const created = h.urls.created.length;
    const plays = h.audios[0].plays;
    h.mode.tap();
    await h.flush();
    expect(h.ttsCalls()[0]!.aborted).toBe(true);
    expect(h.urls.created.length).toBe(created);
    expect(h.audios[0].plays).toBe(plays);
    expect(h.urls.live.size).toBe(0);
  });

  test("409 browser (Einstellung inzwischen geändert): weiter mit der Browser-Stimme ab diesem Segment", async () => {
    const h = await speaking({ tts: "server" });
    h.ttsCalls()[0]!.respond(409, { error: "Gewählt ist die Browser-Stimme", reason: "browser" });
    await h.flush();
    expect(h.view().phase).toBe("speaking");
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Erster Satz der Antwort."]);
    h.synth.spoken[0]!.onend!();
    await h.flush();
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Erster Satz der Antwort.", "Zweiter Satz der Antwort."]);
    // Der Server wird für diese Antwort nicht weiter gefragt
    expect(h.ttsCalls()).toHaveLength(1);
  });

  test("429, 502, 503 und Netzfehler: kein stiller Wechsel der Stimme, Hinweis und wieder zuhören", async () => {
    for (const fail of [429, 502, 503, 0]) {
      const h = await speaking({ tts: "server" });
      if (fail) h.ttsCalls()[0]!.respond(fail, { error: "geht nicht", reason: "x" });
      else h.ttsCalls()[0]!.fail();
      await h.flush();
      expect(h.view()).toMatchObject({ phase: "listening", note: FAILED });
      expect(h.synth.spoken).toEqual([]);
      expect(h.urls.live.size).toBe(0);
      expect(h.calls.filter(c => !c.settled)).toEqual([]);
      expect(h.tracks()[0]!.enabled).toBe(true);
    }
  });

  test("scheitert das vorgeladene Segment, spielt das laufende zu Ende; danach der Hinweis", async () => {
    const h = await speaking({ tts: "server" });
    const audio = h.audios[0];
    h.ttsCalls()[0]!.respond(200, undefined, blob(1));
    await h.flush();
    h.ttsCalls()[1]!.respond(502, { error: "Die Sprachausgabe ist fehlgeschlagen", reason: "fehlgeschlagen" });
    await h.flush();
    expect(h.view().phase).toBe("speaking");
    expect(audio.paused).toBe(false);
    audio.onended();
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: FAILED });
    expect(h.urls.live.size).toBe(0);
    expect(h.synth.spoken).toEqual([]);
  });

  test("blockiertes play(): „Tippe, um die Antwort zu hören.“, der nächste Tipp spielt das Segment", async () => {
    const h = await speaking({ tts: "server" });
    const audio = h.audios[0];
    h.playMode.value = "blocked";
    h.ttsCalls()[0]!.respond(200, undefined, blob(1));
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "speaking", blocked: true, note: "Tippe, um die Antwort zu hören." });
    const url = audio.src;
    expect(h.urls.live.has(url)).toBe(true);
    const plays = audio.plays;
    h.playMode.value = "ok";
    h.mode.tap();
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "speaking", blocked: false, note: "" });
    expect(audio.plays).toBe(plays + 1);
    expect(audio.src).toBe(url);
    expect(audio.paused).toBe(false);
    // Danach unterbricht der Tipp wieder
    h.mode.tap();
    expect(h.view().phase).toBe("listening");
  });

  test("Audio lässt sich nicht abspielen (kaputte Datei, error-Ereignis): Hinweis, Adresse frei", async () => {
    const broken = await speaking({ tts: "server" });
    broken.playMode.value = "broken";
    broken.ttsCalls()[0]!.respond(200, undefined, blob(1));
    await broken.flush();
    expect(broken.view()).toMatchObject({ phase: "listening", note: FAILED });
    expect(broken.urls.live.size).toBe(0);

    const event = await speaking({ tts: "server" });
    event.ttsCalls()[0]!.respond(200, undefined, blob(1));
    await event.flush();
    event.audios[0].onerror();
    await event.flush();
    expect(event.view()).toMatchObject({ phase: "listening", note: FAILED });
    expect(event.urls.live.size).toBe(0);
    expect(event.calls.filter(c => !c.settled)).toEqual([]);
  });

  test("abgelaufene Anmeldung beim Vorlesen (401): alles frei, zurück zur Anmeldung", async () => {
    const h = await speaking({ tts: "server" });
    h.ttsCalls()[0]!.respond(401, { error: "Nicht angemeldet" });
    await h.flush();
    expect(h.view().phase).toBe("off");
    expect(h.seen.unauthorized).toBe(1);
    expect(h.released()).toEqual(ALL_RELEASED);
  });

  test("Auflegen und Pause während des Vorlesens: Ausgabe aus, Anfragen abgebrochen, Adressen frei", async () => {
    for (const end of ["hangUp", "pause"] as const) {
      const h = await speaking({ tts: "server" });
      h.ttsCalls()[0]!.respond(200, undefined, blob(1));
      await h.flush();
      const audio = h.audios[0];
      h.mode[end]();
      await h.flush();
      expect(audio.paused).toBe(true);
      expect(h.released()).toEqual(ALL_RELEASED);
      expect(h.view().phase).toBe(end === "hangUp" ? "off" : "paused");
      const plays = audio.plays;
      audio.onended?.();
      await h.flush();
      expect(audio.plays).toBe(plays);
      expect(h.ttsCalls()).toHaveLength(2);
    }
  });

  test("„Weiter“ nach der Pause schaltet dasselbe Audio-Element wieder frei", async () => {
    const h = speechHarness({ tts: "server" });
    await h.start();
    h.mode.pause();
    const plays = h.audios[0].plays;
    h.mode.resume();
    await h.flush();
    expect(h.audios).toHaveLength(1);
    expect(h.audios[0].plays).toBe(plays + 1);
    h.audios[0].onended();
    expect(h.urls.live.size).toBe(0);
  });
});

describe("Unterbrechen", () => {
  test("Tipp während „Spricht“ (Browser-Stimme): Ausgabe sofort aus, wieder zuhören; das abgebrochene Segment startet kein weiteres", async () => {
    const h = await speaking();
    const cancelled = h.synth.cancelled;
    h.mode.tap();
    expect(h.synth.cancelled).toBe(cancelled + 1);
    expect(h.view()).toMatchObject({ phase: "listening", micOpen: true });
    expect(h.tracks()[0]!.enabled).toBe(true);
    expect(h.vad()).toMatchObject({ active: true, startMs: 150 });
    // Späte Ergebnisse der Stimme und des Wächters
    h.synth.spoken[0]!.onerror!({ error: "interrupted" });
    h.synth.spoken[0]!.onend!();
    await h.advance(120_000 - 1);
    expect(h.synth.spoken).toHaveLength(1);
  });

  test("ohne Kopfhörer-Einstellung ist das Mikrofon während „Spricht“ stumm: kein Selbstgespräch über Lautsprecher", async () => {
    const h = await speaking();
    expect(h.view()).toMatchObject({ phase: "speaking", micOpen: false });
    expect(h.tracks()[0]!.enabled).toBe(false);
    expect(h.vad().active).toBe(false);
    // Selbst wenn das Worklet etwas meldet (alter Abschnitt oder Fehler): keine Unterbrechung, kein Upload
    await h.emit({ type: "start" });
    await h.emit({ type: "utterance", samples: new Int16Array(16000) });
    expect(h.view().phase).toBe("speaking");
    expect(h.uploads()).toHaveLength(1);
    expect(h.synth.spoken).toHaveLength(1);
  });

  test("mit Kopfhörer-Einstellung: erkannte Sprache stoppt die Ausgabe sofort, und genau diese Äußerung wird gesendet", async () => {
    const h = await speaking({ device: { headphones: true } });
    expect(h.view()).toMatchObject({ phase: "speaking", micOpen: true });
    expect(h.tracks()[0]!.enabled).toBe(true);
    // Strenger Sprechbeginn: 300 ms über der Schwelle
    expect(h.vad()).toMatchObject({ active: true, startMs: 300 });
    const epoch = h.vad().epoch;
    await h.emit({ type: "level", level: 0.3, speaking: false });
    expect(h.view().level).toBe(0.3);

    const cancelled = h.synth.cancelled;
    await h.emit({ type: "start" });
    expect(h.synth.cancelled).toBe(cancelled + 1);
    expect(h.view()).toMatchObject({ phase: "listening", voiceActive: true, micOpen: true });
    // Derselbe Abschnitt läuft weiter (Vorlauf und Anfang bleiben), nur der Sprechbeginn ist wieder normal
    expect(h.vad()).toMatchObject({ active: true, startMs: 150, epoch });
    expect(h.uploads()).toHaveLength(1);

    const spoken = new Int16Array(24000).fill(900);
    await h.emit({ type: "utterance", samples: spoken, limit: false });
    expect(h.view().phase).toBe("understanding");
    expect(h.uploads()).toHaveLength(2);
    // Genau diese Äußerung: 1,5 Sekunden samt Vorlauf
    expect(h.lastUpload().body.byteLength).toBe(44 + 24000 * 2);
    expect(new DataView(h.lastUpload().body.buffer).getInt16(44, true)).toBe(900);
    // Die abgebrochene Ausgabe spricht nicht weiter
    h.synth.spoken[0]!.onend!();
    await h.flush();
    expect(h.synth.spoken).toHaveLength(1);
    // Beim Verstehen, Denken und Warten bleibt das Mikrofon auch mit dieser Einstellung stumm
    expect(h.tracks()[0]!.enabled).toBe(false);
    expect(h.vad().active).toBe(false);
    await h.accept("m-2");
    expect(h.tracks()[0]!.enabled).toBe(false);
    expect(h.vad().active).toBe(false);
    expect(h.view().micOpen).toBe(false);
  });

  test("mit Kopfhörer-Einstellung und Server-Stimme: Sprache stoppt das Audio und verwirft das Vorladen", async () => {
    const h = await speaking({ device: { headphones: true }, tts: "server" });
    h.ttsCalls()[0]!.respond(200, undefined, new Blob(["ton"], { type: "audio/wav" }));
    await h.flush();
    const audio = h.audios[0];
    expect(audio.paused).toBe(false);
    await h.emit({ type: "start" });
    expect(audio.paused).toBe(true);
    expect(h.ttsCalls()[1]!.aborted).toBe(true);
    expect(h.urls.live.size).toBe(0);
    expect(h.view().phase).toBe("listening");
    await h.emit({ type: "utterance", samples: new Int16Array(16000), limit: false });
    expect(h.uploads()).toHaveLength(2);
  });

  test("mit Kopfhörer-Einstellung: ein Husten während der Antwort (verworfen) sendet nichts", async () => {
    const h = await speaking({ device: { headphones: true } });
    await h.emit({ type: "start" });
    await h.emit({ type: "dropped" });
    expect(h.view()).toMatchObject({ phase: "listening", voiceActive: false });
    expect(h.uploads()).toHaveLength(1);
  });

  test("Auflegen während „Spricht“: alles frei, späte Ergebnisse der Stimme bleiben ohne Wirkung", async () => {
    const h = await speaking();
    h.mode.hangUp();
    expect(h.released()).toEqual(ALL_RELEASED);
    h.synth.spoken[0]!.onend!();
    await h.advance(600_000);
    expect(h.synth.spoken).toHaveLength(1);
    expect(h.view().phase).toBe("off");
  });

  test("neue Ausgabe nach dem Unterbrechen: eine späte Meldung der alten Stimme nimmt der neuen nicht den Wächter", async () => {
    const h = await speaking({}, ["Antwort A."]);
    const old = h.synth.spoken[0]!;
    h.mode.tap();
    expect(h.view().phase).toBe("listening");
    // Zweite Runde: Antwort B wird gesprochen
    await h.say();
    await h.accept("m-2");
    h.mode.status(true, false);
    await h.add(h.own("m-2"));
    await h.add(h.reply("a-2", ["Antwort B."]));
    h.mode.status(false, false);
    await h.flush();
    expect(h.view().phase).toBe("speaking");
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Antwort A.", "Antwort B."]);
    // Genau ein Zeitgeber läuft: der Wächter von B. Die späten Meldungen von A lassen ihn stehen
    expect(h.timerCount()).toBe(1);
    old.onerror!({ error: "interrupted" });
    old.onend!();
    await h.flush();
    expect(h.timerCount()).toBe(1);
    expect(h.view().phase).toBe("speaking");
    expect(h.synth.spoken).toHaveLength(2);
    // B liefert nie ein Abschlussereignis: der Wächter beendet „Spricht"
    const guard = h.api.speechGuardMs("Antwort B.", 1);
    await h.advance(guard - 1);
    expect(h.view().phase).toBe("speaking");
    await h.advance(1);
    expect(h.view()).toMatchObject({ phase: "listening", note: "" });
    expect(h.synth.spoken).toHaveLength(2);
  });

  test("neue Ausgabe nach dem Auflegen: eine späte Meldung aus der alten Sitzung nimmt der neuen nicht den Wächter", async () => {
    const h = await speaking({}, ["Antwort A."]);
    const old = h.synth.spoken[0]!;
    h.mode.hangUp();
    expect(h.released()).toEqual(ALL_RELEASED);
    // Neue Sitzung im selben Gespräch, Antwort B wird gesprochen
    await h.start();
    await h.say();
    await h.accept("m-2");
    h.mode.status(true, false);
    await h.add(h.own("m-2"));
    await h.add(h.reply("a-2", ["Antwort B."]));
    h.mode.status(false, false);
    await h.flush();
    expect(h.view().phase).toBe("speaking");
    expect(h.synth.spoken.map(u => u.text)).toEqual(["Antwort A.", "Antwort B."]);
    expect(h.timerCount()).toBe(1);
    old.onerror!({ error: "canceled" });
    old.onend!();
    await h.flush();
    expect(h.timerCount()).toBe(1);
    expect(h.synth.spoken).toHaveLength(2);
    await h.advance(h.api.speechGuardMs("Antwort B.", 1));
    expect(h.view()).toMatchObject({ phase: "listening", note: "" });
    // B selbst meldet sich danach auch noch: keine Wirkung
    h.synth.spoken[1]!.onend!();
    await h.flush();
    expect(h.synth.spoken).toHaveLength(2);
    expect(h.view().phase).toBe("listening");
  });

  test("läuft nach dem Vorlesen noch Nacharbeit des Turns: kurz warten, dann ohne Hinweis zuhören", async () => {
    const h = speechHarness();
    await h.toThinking("m-1");
    // Die Antwort ist da, der Turn arbeitet noch nach (running bleibt true)
    await h.add(h.reply("a-1", ["Kurz."]));
    expect(h.view().phase).toBe("speaking");
    h.synth.spoken[0]!.onend!();
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "waiting", micOpen: false });
    expect(h.polls()).toHaveLength(1);
    h.polls()[0]!.respond(200, { busy: true });
    await h.flush();
    h.mode.status(false, false);
    await h.flush();
    h.polls().at(-1)!.respond(200, { busy: false });
    await h.flush();
    expect(h.view()).toMatchObject({ phase: "listening", note: "" });
  });
});

describe("Einstellungen dieses Geräts", () => {
  test("Standardwerte ohne localStorage, bei kaputtem Inhalt und bei ungültigen Werten", () => {
    const h = speechHarness();
    const { readSpeechDevice, writeSpeechDevice, SPEECH_DEVICE_KEY } = h.api;
    const defaults = { pause: "normal", voice: "", rate: 1, headphones: false };
    expect(readSpeechDevice(null)).toEqual(defaults);
    expect(readSpeechDevice(h.storage)).toEqual(defaults);
    h.stored.set(SPEECH_DEVICE_KEY, "{kaputt");
    expect(readSpeechDevice(h.storage)).toEqual(defaults);
    h.stored.set(SPEECH_DEVICE_KEY, JSON.stringify({ pause: "ewig", voice: 7, rate: 9, headphones: "ja" }));
    expect(readSpeechDevice(h.storage)).toEqual({ ...defaults, rate: 1.4 });
    h.stored.set(SPEECH_DEVICE_KEY, JSON.stringify({ pause: "short", voice: "Anna", rate: 0.1, headphones: true }));
    expect(readSpeechDevice(h.storage)).toEqual({ pause: "short", voice: "Anna", rate: 0.8, headphones: true });
    expect(readSpeechDevice({ getItem() { throw new Error("gesperrt"); } })).toEqual(defaults);

    expect(writeSpeechDevice(null, defaults)).toBe(false);
    expect(writeSpeechDevice({ setItem() { throw new Error("voll"); } }, defaults)).toBe(false);
    expect(writeSpeechDevice(h.storage, { pause: "long", voice: "Petra", rate: 1.25, headphones: true })).toBe(true);
    expect(JSON.parse(h.stored.get(SPEECH_DEVICE_KEY)!)).toEqual({ pause: "long", voice: "Petra", rate: 1.25, headphones: true });
    expect(SPEECH_DEVICE_KEY).toBe("tybo-speech-device");
  });

  test("ohne localStorage läuft der Modus mit den Standardwerten", async () => {
    const h = await speaking({ storage: false });
    expect(h.vad().active).toBe(false);
    expect(h.synth.spoken[0]!.rate).toBe(1);
    expect(h.nodes[0].port.posted.find((m: any) => m.type === "config")).toMatchObject({ pauseMs: 800 });
  });
});
