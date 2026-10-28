/**
 * Erkennen im Telefonhörer mit Rückfall (Issue #279, Checkbox 3,
 * ./src/web/call-stt.ts): Rückfall auf Parakeet für genau diese Äußerung,
 * Hinweis, nach zwei Fehlern bei Parakeet, Rücksetzen nur bei
 * Scribe-Erfolg, Abbruch ohne Rückfall und ohne Zählen (auch während des
 * Rückfalls), Wirkung erst bei Übernahme (adopt), leeres Ergebnis,
 * fehlender oder scheiternder Rückfall, Schlüssel nachträglich weg, eigenes
 * Zeitlimit für Scribe und frisches Signal für Parakeet, Log ohne Text.
 */

import { describe, expect, test } from "bun:test";
import { SpeechError } from "../src/lib/speech/types";
import { CALL_STT_MAX_FAILURES, createCallRecognizer, type CallSttRunner } from "../src/web/call-stt";

const PCM = new Uint8Array([1, 0, 2, 0]);
const SECRET_TEXT = "Schokoeis mit Sahne";

type Step = string | Error | "hang";

/** Erkenner, der der Reihe nach die Schritte liefert; merkt sich die Signale */
function runner(id: string, name: string, steps: Step[], timeoutMs = 4000): CallSttRunner & { calls: AbortSignal[]; seen: Uint8Array[] } {
  const calls: AbortSignal[] = [];
  const seen: Uint8Array[] = [];
  return {
    id,
    name,
    timeoutMs,
    calls,
    seen,
    run: (pcm, signal) => {
      calls.push(signal);
      seen.push(pcm);
      const step = steps.shift() ?? new SpeechError("exit", 1);
      if (step === "hang") {
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new SpeechError("timeout")), { once: true });
        });
      }
      return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
    },
  };
}

/** Zeitlimits, die der Test von Hand auslöst */
function timers() {
  const made: { ms: number; ctrl: AbortController }[] = [];
  return {
    made,
    timeoutSignal: (ms: number) => {
      const ctrl = new AbortController();
      made.push({ ms, ctrl });
      return ctrl.signal;
    },
  };
}

function setup(scribe: Step[], parakeet: Step[] | null) {
  const log: string[] = [];
  const t = timers();
  const primary = runner("elevenlabs", "ElevenLabs Scribe", scribe);
  const fallback = parakeet ? runner("parakeet", "Parakeet", parakeet, 30_000) : null;
  const rec = createCallRecognizer({ primary, fallback, log: l => log.push(l), now: () => 0, timeoutSignal: t.timeoutSignal });
  return { rec, primary, fallback, log, t };
}

const live = () => new AbortController().signal;

const SINGLE = "ElevenLabs Scribe ist nicht erreichbar, Parakeet erkennt diese Äußerung.";
const STAY = "ElevenLabs Scribe ist nicht erreichbar, das Gespräch bleibt bei Parakeet.";

/** Erkennen und übernehmen wie die Sitzung bei utterance_end */
async function take(rec: ReturnType<typeof setup>["rec"], signal = live()) {
  const result = await rec.recognize(PCM, signal);
  return { result, notice: rec.adopt(result) };
}

describe("Erkennen mit Rückfall", () => {
  test("Scribe erkennt: Text ohne Hinweis, Parakeet bleibt unberührt", async () => {
    const { rec, fallback, log } = setup(["Wie wird das Wetter morgen in Berlin?"], []);
    expect(await take(rec)).toEqual({ result: { ok: true, text: "Wie wird das Wetter morgen in Berlin?", provider: "elevenlabs" }, notice: undefined });
    expect(fallback!.calls).toHaveLength(0);
    expect(log).toEqual(["Hören elevenlabs: ok, 0 ms"]);
  });

  test("Scribe scheitert (401, 429, Netz): Parakeet erkennt genau diese Äußerung, mit Hinweis", async () => {
    for (const err of [new SpeechError("http", 401), new SpeechError("http", 429), new SpeechError("network")]) {
      const { rec, fallback } = setup([err], ["Schokoeis"]);
      expect(await take(rec)).toEqual({ result: { ok: true, text: "Schokoeis", provider: "parakeet" }, notice: SINGLE });
      expect(fallback!.seen).toEqual([PCM]);
      expect(rec.failures).toBe(1);
      expect(rec.stuck).toBe(false);
    }
  });

  test("nach zwei Fehlern in Folge bleibt das Gespräch bei Parakeet, Hinweis einmal", async () => {
    const { rec, primary, fallback } = setup([new SpeechError("http", 429), new SpeechError("http", 429), "nie"], ["eins", "zwei", "drei", "vier"]);
    expect((await take(rec)).notice).toBe(SINGLE);
    expect(CALL_STT_MAX_FAILURES).toBe(2);
    expect(await take(rec)).toEqual({ result: { ok: true, text: "zwei", provider: "parakeet" }, notice: STAY });
    expect(rec.stuck).toBe(true);
    expect(await take(rec)).toEqual({ result: { ok: true, text: "drei", provider: "parakeet" }, notice: undefined });
    expect(await take(rec)).toEqual({ result: { ok: true, text: "vier", provider: "parakeet" }, notice: undefined });
    expect(primary.calls).toHaveLength(2);
    expect(fallback!.calls).toHaveLength(4);
  });

  test("Zähler: Scribe-Erfolg setzt zurück, ein erfolgreicher Rückfall nicht", async () => {
    const { rec } = setup([new SpeechError("network"), "gut", new SpeechError("network"), new SpeechError("network")], ["a", "b", "c"]);
    await take(rec);
    expect(rec.failures).toBe(1);
    await take(rec);
    expect(rec.failures).toBe(0);
    await take(rec);
    expect(rec.failures).toBe(1);
    expect(rec.stuck).toBe(false);
    await take(rec);
    expect(rec.stuck).toBe(true);
  });

  test("recognize allein ändert nichts: erst die Übernahme zählt, und nur einmal je Ergebnis", async () => {
    const { rec } = setup([new SpeechError("http", 429), new SpeechError("http", 429), new SpeechError("http", 429), "gut"], ["a", "b", "c"]);
    // Zwei fertige Rückfälle, die die Sitzung verwirft (veraltete Pausen-Erkennungen)
    await rec.recognize(PCM, live());
    await rec.recognize(PCM, live());
    expect(rec.failures).toBe(0);
    expect(rec.stuck).toBe(false);
    // Der dritte wird übernommen: erster Fehler, Hinweis nur für diese Äußerung
    const third = await rec.recognize(PCM, live());
    expect(rec.adopt(third)).toBe(SINGLE);
    expect(rec.adopt(third)).toBeUndefined();
    expect(rec.failures).toBe(1);
    // Ein verworfener Scribe-Erfolg setzt nicht zurück
    await rec.recognize(PCM, live());
    expect(rec.failures).toBe(1);
  });

  test("Abbruch der Äußerung: kein Rückfall, kein Hinweis, zählt nicht", async () => {
    const { rec, fallback, log } = setup(["hang"], ["nie"]);
    const ctrl = new AbortController();
    const p = take(rec, ctrl.signal);
    ctrl.abort();
    expect(await p).toEqual({ result: { ok: false, reason: "failed" }, notice: undefined });
    expect(fallback!.calls).toHaveLength(0);
    expect(rec.failures).toBe(0);
    expect(log).toEqual(["Hören elevenlabs: abgebrochen, 0 ms"]);
    // Schon abgebrochen: gar kein Aufruf
    const before = log.length;
    expect(await rec.recognize(PCM, ctrl.signal)).toEqual({ ok: false, reason: "failed" });
    expect(log).toHaveLength(before);
  });

  test("Abbruch während des Rückfalls: zählt nicht, kein Hinweis, auch wenn das Ergebnis übernommen würde", async () => {
    const { rec, fallback } = setup([new SpeechError("http", 401)], ["hang"]);
    const ctrl = new AbortController();
    const p = take(rec, ctrl.signal);
    await Bun.sleep(0);
    ctrl.abort();
    const { result, notice } = await p;
    expect(result.ok).toBe(false);
    expect(notice).toBeUndefined();
    expect(fallback!.calls).toHaveLength(1);
    expect(rec.failures).toBe(0);
    expect(rec.stuck).toBe(false);
  });

  test("zwei Abbrüche während des Rückfalls hintereinander: kein Bleiben, die nächste Äußerung geht wieder an Scribe", async () => {
    const { rec, primary, fallback } = setup([new SpeechError("http", 429), new SpeechError("http", 429), "wieder da"], ["hang", "hang"]);
    for (let i = 0; i < 2; i++) {
      const ctrl = new AbortController();
      const p = take(rec, ctrl.signal);
      await Bun.sleep(0);
      ctrl.abort();
      expect((await p).notice).toBeUndefined();
    }
    expect(fallback!.calls).toHaveLength(2);
    expect(rec.failures).toBe(0);
    expect(rec.stuck).toBe(false);
    expect(await take(rec)).toEqual({ result: { ok: true, text: "wieder da", provider: "elevenlabs" }, notice: undefined });
    expect(primary.calls).toHaveLength(3);
  });

  test("eigenes Zeitlimit für Scribe; Parakeet bekommt ein frisches, nicht abgelaufenes Signal", async () => {
    const { rec, primary, fallback, t, log } = setup(["hang"], ["Schokoeis"]);
    const p = rec.recognize(PCM, live());
    await Bun.sleep(0);
    expect(t.made.map(x => x.ms)).toEqual([4000]);
    t.made[0]!.ctrl.abort();
    const r = await p;
    expect(r).toMatchObject({ ok: true, text: "Schokoeis", provider: "parakeet" });
    expect(primary.calls[0]!.aborted).toBe(true);
    expect(fallback!.calls[0]!.aborted).toBe(false);
    expect(t.made.map(x => x.ms)).toEqual([4000, 30_000]);
    expect(log).toContain("Hören elevenlabs: Fehler (Zeitlimit), 0 ms");
  });

  test("leeres Ergebnis heißt nichts gehört: kein Rückfall, Zähler unverändert", async () => {
    const { rec, fallback } = setup([new SpeechError("http", 500), new SpeechError("empty"), "  "], ["x"]);
    await take(rec);
    expect(rec.failures).toBe(1);
    expect(await take(rec)).toEqual({ result: { ok: false, reason: "empty" }, notice: undefined });
    expect(await take(rec)).toEqual({ result: { ok: false, reason: "empty" }, notice: undefined });
    expect(rec.failures).toBe(1);
    expect(fallback!.calls).toHaveLength(1);
  });

  test("Rückfall scheitert auch: failed mit Hinweis (die Sitzung sagt den Fehlersatz)", async () => {
    const { rec } = setup([new SpeechError("http", 401)], [new SpeechError("exit", 1)]);
    expect(await take(rec)).toEqual({ result: { ok: false, reason: "failed" }, notice: SINGLE });
  });

  test("Rückfall hört nichts: empty mit Hinweis", async () => {
    const { rec } = setup([new SpeechError("http", 401)], [new SpeechError("empty")]);
    expect(await take(rec)).toEqual({ result: { ok: false, reason: "empty" }, notice: SINGLE });
  });

  test("Parakeet nicht eingerichtet: Scribe-Fehler ergibt failed ohne Hinweis und ohne Bleiben", async () => {
    const { rec } = setup([new SpeechError("http", 429), new SpeechError("http", 429), "geht wieder"], null);
    expect(await take(rec)).toEqual({ result: { ok: false, reason: "failed" }, notice: undefined });
    expect(await take(rec)).toEqual({ result: { ok: false, reason: "failed" }, notice: undefined });
    expect(rec.stuck).toBe(false);
    expect((await take(rec)).result).toEqual({ ok: true, text: "geht wieder", provider: "elevenlabs" });
  });

  test("Schlüssel nachträglich weg (unavailable): sofort und dauerhaft Parakeet", async () => {
    const { rec, primary } = setup([new SpeechError("unavailable")], ["eins", "zwei"]);
    expect((await take(rec)).notice).toBe(STAY);
    expect(rec.stuck).toBe(true);
    await take(rec);
    expect(primary.calls).toHaveLength(1);
  });

  test("ohne Rückfall (lokaler Erkenner): Fehler ergibt failed, nie ein Hinweis", async () => {
    const log: string[] = [];
    const local = runner("parakeet", "Parakeet", [new SpeechError("timeout"), "ja"], 30_000);
    const rec = createCallRecognizer({ primary: { ...local, logSuffix: () => " (geladen)" }, log: l => log.push(l), now: () => 0, timeoutSignal: timers().timeoutSignal });
    const first = await rec.recognize(PCM, live());
    expect(first).toEqual({ ok: false, reason: "failed" });
    expect(rec.adopt(first)).toBeUndefined();
    expect(await rec.recognize(PCM, live())).toEqual({ ok: true, text: "ja", provider: "parakeet" });
    expect(log).toEqual(["Hören parakeet (geladen): Fehler (Zeitlimit), 0 ms", "Hören parakeet (geladen): ok, 0 ms"]);
  });

  test("das Log nennt Anbieter, Dauer und Status, nie den erkannten Text oder Fehlertexte", async () => {
    const { rec, log } = setup([new Error(`Antwort: ${SECRET_TEXT}`), SECRET_TEXT], [SECRET_TEXT]);
    await take(rec);
    await take(rec);
    expect(log.join("\n")).not.toContain("Schokoeis");
    expect(log).toEqual([
      "Hören elevenlabs: Fehler (Error), 0 ms",
      "Hören elevenlabs: Rückfall parakeet für diese Äußerung",
      "Hören parakeet: ok, 0 ms",
      "Hören elevenlabs: ok, 0 ms",
    ]);
  });
});
