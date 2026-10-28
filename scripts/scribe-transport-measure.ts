/**
 * ElevenLabs Scribe im Takt des Telefonhörers: Batch gegen Realtime (Issue
 * #279, Aufgabe 1). Von Hand gestartet, kein automatischer Test, startet und
 * importiert nie src/bot.ts.
 *
 * Aufruf (Beispiel):
 *   bun run scripts/scribe-transport-measure.ts --wav wetter.wav --wav schoko.wav \
 *     --runs 5 --env-file <.env> [--language de]
 *
 * Beide Wege bekommen dieselbe Aufnahme im selben Takt wie im Telefonhörer
 * (scripts/call-measure.ts, src/web/public/call.js mit Sprechpause normal):
 * die Äußerung in Stücken zu 20 ms in Echtzeit, danach kein Ton mehr
 * (außerhalb von Sprache schickt der Browser nichts), nach 300 ms Stille
 * utterance_pause, nach weiteren 500 ms utterance_end.
 *
 * - Batch: POST /v1/speech-to-text mit scribe_v2, die Äußerung als WAV
 *   (PCM16 mono 16 kHz), language_code, tag_audio_events=false,
 *   timestamps_granularity=none. Upload bei utterance_pause, wie es die
 *   Sitzung bei einem Batch-Erkenner täte.
 * - Realtime: der Weg des Telefonhörers (openScribeStream aus
 *   src/lib/speech/scribe.ts, scribe_v2_realtime). Die Verbindung steht
 *   schon vor der Äußerung, wie im Telefonhörer, der sie beim Öffnen
 *   aufbaut; ihr Aufbau zählt nicht. Jedes Stück geht beim Sprechen hinaus,
 *   bei utterance_pause erkennt transcribe (Commit und Warten auf den
 *   Text).
 *
 * Gemessen je Lauf, ab dem Ende der Äußerung (letztes Stück):
 * - „ab Pause“: von utterance_pause bis zum Text (Dauer beim Anbieter)
 * - „Rest ab Ende“: was nach utterance_end noch bis zum Text zu warten ist
 *   (0, wenn der Text vorher da war). Das ist der Teil, der im Telefonhörer
 *   zur Zeit bis zum ersten Ton dazukommt; Modell und Stimme danach sind
 *   für beide Wege gleich.
 * Die Wege wechseln sich je Lauf ab, damit Netzschwankungen beide treffen.
 * ELEVENLABS_API_KEY nur aus --env-file, nie ausgegeben. Ausgegeben wird der
 * erkannte Text (der Testsätze), nie Ton.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { pcmToWav, wavToPcm } from "../src/lib/speech/pcm";
import { openScribeStream } from "../src/lib/speech/scribe";

const { values } = parseArgs({
  options: {
    wav: { type: "string", multiple: true },
    runs: { type: "string", default: "5" },
    "env-file": { type: "string" },
    language: { type: "string", default: "de" },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

if (!values.wav?.length || !values["env-file"]) fail("--wav und --env-file sind nötig (siehe Kopf der Datei)");
let key = "";
for (const line of (await readFile(values["env-file"]!, "utf8")).split("\n")) {
  const m = /^\s*ELEVENLABS_API_KEY\s*=\s*(.*)\s*$/.exec(line);
  if (m) key = m[1]!.replace(/^["']|["']$/g, "");
}
if (!key) fail("ELEVENLABS_API_KEY fehlt in --env-file");
const runs = Math.max(1, Number(values.runs) || 5);
const language = values.language!;

const FRAME_BYTES = 640; // 20 ms bei 16 kHz PCM16 mono
const PAUSE_MS = 300;
const END_MS = 500;

/** Äußerung in Echtzeit abspielen; onFrame bekommt jedes Stück, Ergebnis ist der Zeitpunkt nach dem letzten */
async function play(pcm: Buffer, onFrame: (frame: Buffer) => void): Promise<number> {
  const t0 = performance.now();
  for (let i = 0, n = 0; i < pcm.length; i += FRAME_BYTES, n++) {
    const wait = t0 + n * 20 - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    onFrame(pcm.subarray(i, Math.min(i + FRAME_BYTES, pcm.length)));
  }
  return performance.now();
}

interface Run {
  text: string;
  fromPause: number;
  restAfterEnd: number;
}

async function batch(pcm: Buffer): Promise<Run> {
  const speechEnd = await play(pcm, () => {});
  await Bun.sleep(Math.max(0, speechEnd + PAUSE_MS - performance.now()));
  const pauseAt = performance.now();
  const endAt = pauseAt + END_MS;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(pcmToWav(pcm, 16_000))], { type: "audio/wav" }), "audio.wav");
  form.append("model_id", "scribe_v2");
  form.append("language_code", language);
  form.append("tag_audio_events", "false");
  form.append("timestamps_granularity", "none");
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: form, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Batch: HTTP ${res.status}`);
  const text = String(((await res.json()) as { text?: unknown }).text ?? "").trim();
  const doneAt = performance.now();
  return { text, fromPause: doneAt - pauseAt, restAfterEnd: Math.max(0, doneAt - endAt) };
}

async function realtime(pcm: Buffer): Promise<Run> {
  const stream = openScribeStream({ key, language });
  try {
    stream.warm();
    // Wie im Telefonhörer: die Verbindung steht, bevor der Nutzer spricht
    await Bun.sleep(1000);
    stream.newUtterance();
    const speechEnd = await play(pcm, f => stream.push(f));
    await Bun.sleep(Math.max(0, speechEnd + PAUSE_MS - performance.now()));
    const pauseAt = performance.now();
    const endAt = pauseAt + END_MS;
    const text = await stream.transcribe(AbortSignal.timeout(10_000));
    const doneAt = performance.now();
    return { text, fromPause: doneAt - pauseAt, restAfterEnd: Math.max(0, doneAt - endAt) };
  } finally {
    stream.close();
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

const all: Record<"batch" | "realtime", Run[]> = { batch: [], realtime: [] };
console.log("| Aufnahme | Lauf | Weg | ab Pause | Rest ab Ende | erkannt |");
console.log("|---|---|---|---|---|---|");
for (const file of values.wav!) {
  const { sampleRate, pcm } = wavToPcm(await readFile(file));
  if (sampleRate !== 16_000) fail(`${file}: ${sampleRate} Hz, erwartet 16 kHz mono PCM16`);
  const name = basename(file).replace(/\.wav$/, "");
  for (let i = 1; i <= runs; i++) {
    // Reihenfolge je Lauf wechseln
    const order: ("batch" | "realtime")[] = i % 2 ? ["batch", "realtime"] : ["realtime", "batch"];
    for (const way of order) {
      try {
        const r = way === "batch" ? await batch(pcm) : await realtime(pcm);
        all[way].push(r);
        console.log(`| ${name} | ${i} | ${way} | ${sec(r.fromPause)} | ${sec(r.restAfterEnd)} | ${r.text} |`);
      } catch (e) {
        console.log(`| ${name} | ${i} | ${way} | Fehler: ${(e as Error).message} | | |`);
      }
      await Bun.sleep(500);
    }
  }
}
console.log("");
for (const way of ["batch", "realtime"] as const) {
  const rs = all[way];
  if (!rs.length) continue;
  console.log(
    `${way}: ${rs.length} Läufe, ab Pause Median ${sec(median(rs.map(r => r.fromPause)))} (${sec(Math.min(...rs.map(r => r.fromPause)))} bis ${sec(Math.max(...rs.map(r => r.fromPause)))}), Rest ab Ende Median ${sec(median(rs.map(r => r.restAfterEnd)))} (höchstens ${sec(Math.max(...rs.map(r => r.restAfterEnd)))})`,
  );
}
