/**
 * Echter Durchlauf des Telefonhörers (Issue #257, Checkbox 4), von Hand
 * gestartet, kein automatischer Test. Startet nie src/bot.ts und importiert
 * ihn nicht: ein eigener Web-Server mit temporären Daten auf einem freien
 * Port, der echte Anschluss ./src/web/bot-call.ts mit echtem Modellweg,
 * Erkenner und Stimme, dazu ein WebSocket-Client, der eine WAV-Datei wie der
 * Browser schickt.
 *
 * Aufruf (Beispiel):
 *   bun run scripts/call-measure.ts --wav probe.wav --via api --runs 3 \
 *     --sherpa <Ordner sherpa-onnx-v1.13.8-…> --model <Ordner parakeet-…> \
 *     [--pocket <models/speech/pocket>] [--env-file <.env>] \
 *     [--voice pocket|elevenlabs|browser] [--eleven-voice <Kennung>] [--eleven-model <Modell>] \
 *     [--stt parakeet|elevenlabs]
 *   --wav darf mehrfach stehen: alle Aufnahmen nacheinander im selben Gespräch,
 *   je Aufnahme --runs Läufe.
 *
 * - WAV: PCM16 mono 16 kHz (sonst vorher: ffmpeg -i in.wav -ar 16000 -ac 1 -c:a pcm_s16le out.wav).
 *   Der WAV-Kopf wird entfernt, das PCM geht in Stücken zu 20 ms in Echtzeit hinaus.
 * - Danach wie der Browser: 300 ms Stille, utterance_pause, weitere 500 ms,
 *   utterance_end (Sprechpause 0,8 s wie im Sprechmodus).
 * - Messbeginn ist das Ende der Äußerung (letztes Stück gesendet), wie in
 *   der Messung vom 30.09.2026. Gemessen: Pause (fest), Erkennen (bis
 *   transcript), erster Abschnitt (bis sentence), erster Ton (bis zum ersten
 *   Binärstück), dazu die Gesamtzeit.
 * - Der erste Lauf nach dem Öffnen ist der erste Turn (bei der CLI die erste
 *   Äußerung in der Sitzung); „Öffnen“ misst Erkenner laden, Stimme
 *   vorwärmen und Sitzung starten.
 * - --via api nimmt VOICE_ANTHROPIC_API_KEY aus --env-file (nie ausgegeben),
 *   --via cli die offene Claude-Code-Sitzung (Abo, wenn ANTHROPIC_API_KEY fehlt).
 * - Kein Budget-Eintrag (Reservierung als Attrappe), kein Neustart-Marker.
 * - Stimme (Issue #276): --voice wählt speech.call.tts. Standard pocket, wenn
 *   --pocket angegeben ist, sonst browser. elevenlabs nimmt ELEVENLABS_API_KEY
 *   aus --env-file (nie ausgegeben), die Stimme aus --eleven-voice (Standard
 *   wie speech.call.elevenlabsVoice) und das Modell aus --eleven-model; mit
 *   --pocket ist Pocket TTS der Rückfall. Die Tabelle nennt je Lauf, wer
 *   gesprochen hat (Hinweis oder speak_browser heißt Rückfall), am Ende die
 *   Mediane. „Erster Ton“ ist das erste Binärstück am WebSocket, nicht der
 *   hörbare Ton am Lautsprecher (der Browser puffert dazu 60 ms).
 * - Erkenner (Issue #279): --stt wählt speech.call.stt. Standard parakeet
 *   (geladen); elevenlabs erkennt mit ElevenLabs Scribe (echter Anbieter aus
 *   providers.ts, ELEVENLABS_API_KEY aus --env-file, nie ausgegeben),
 *   Parakeet ist geladen und der Rückfall. Die Tabelle trennt „Anbieter“
 *   (Dauer des Erkenners laut Log, auch wenn er schon bei utterance_pause
 *   begann) und „Rest ab Ende“ (was nach utterance_end noch zu warten war,
 *   bis transcript kam). „Wer“ nennt, wer erkannt hat, „Rückfall“ markiert
 *   Läufe, in denen Parakeet für Scribe einsprang. Ein Hinweis vor
 *   transcript bricht die Messung nicht ab, nur „nichts verstanden“.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { getAgentConfigOrGeneral } from "../src/agents/base";
import { createSpeech } from "../src/lib/speech/chain";
import { CALL_ELEVENLABS_DEFAULT_VOICE, isCallTtsChoice } from "../src/lib/speech/ids";
import { createSttProviders, createTtsProviders, type ProviderDeps } from "../src/lib/speech/providers";
import { PARAKEET_MODEL, RUNTIME_TARGET, type ParakeetPaths } from "../src/lib/speech/parakeet";
import { startParakeetWarm } from "../src/lib/speech/parakeet-warm";
import { createPocketServer, pocketPaths, POCKET_DEFAULT_VOICE, POCKET_SAMPLE_RATE, realPocketServerDeps } from "../src/lib/speech/pocket";
import { wavToPcm } from "../src/lib/speech/pcm";
import type { SttProvider, TtsProvider } from "../src/lib/speech/types";
import type { Settings } from "../src/lib/settings";
import { resolveCallModel } from "../src/lib/voice-brain/call-model";
import { createBotCall } from "../src/web/bot-call";
import { CALL_PATH } from "../src/web/call";
import { createWebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";

const { values } = parseArgs({
  options: {
    wav: { type: "string", multiple: true },
    via: { type: "string", default: "api" },
    runs: { type: "string", default: "3" },
    sherpa: { type: "string" },
    model: { type: "string" },
    pocket: { type: "string" },
    "env-file": { type: "string" },
    voice: { type: "string" },
    "eleven-voice": { type: "string" },
    "eleven-model": { type: "string" },
    stt: { type: "string", default: "parakeet" },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

if (!values.wav?.length || !values.sherpa || !values.model) fail("--wav, --sherpa und --model sind nötig (siehe Kopf der Datei)");
const via = values.via === "cli" ? "cli" : "api";
const runs = Math.max(1, Number(values.runs) || 3);
const voiceChoice = values.voice ?? (values.pocket ? "pocket" : "browser");
if (!isCallTtsChoice(voiceChoice) || voiceChoice === "auto" || voiceChoice === "piper") fail("--voice: pocket, elevenlabs oder browser");
if (voiceChoice === "pocket" && !values.pocket) fail("--voice pocket braucht --pocket");
const serverVoice = voiceChoice !== "browser";
const sttChoice = values.stt;
if (sttChoice !== "parakeet" && sttChoice !== "elevenlabs") fail("--stt: parakeet oder elevenlabs");

/** .env lesen, ohne Werte auszugeben; nur die nötigen Namen */
async function loadEnv(file: string | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!file) return out;
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const m = /^\s*(VOICE_ANTHROPIC_API_KEY|USER_TIMEZONE|ELEVENLABS_API_KEY)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

const fileEnv = await loadEnv(values["env-file"]);
if (voiceChoice === "elevenlabs" && !fileEnv.ELEVENLABS_API_KEY) fail("--voice elevenlabs braucht ELEVENLABS_API_KEY in --env-file");
if (sttChoice === "elevenlabs" && !fileEnv.ELEVENLABS_API_KEY) fail("--stt elevenlabs braucht ELEVENLABS_API_KEY in --env-file");
const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME, ...fileEnv };

// Erkenner: Parakeet aus den angegebenen Ordnern, immer geladen (warm)
const runtimeDir = values.sherpa!;
const modelDir = values.model!;
const paths: ParakeetPaths = {
  dir: join(runtimeDir, ".."),
  runtimeDir,
  program: join(runtimeDir, "bin", "sherpa-onnx-vad-with-offline-asr"),
  libDir: join(runtimeDir, "lib"),
  libs: [join(runtimeDir, "lib", "libonnxruntime.dylib")],
  modelDir,
  tokens: join(modelDir, "tokens.txt"),
  encoder: join(modelDir, "encoder.int8.onnx"),
  decoder: join(modelDir, "decoder.int8.onnx"),
  joiner: join(modelDir, "joiner.int8.onnx"),
  vad: "",
  proof: "",
};
void RUNTIME_TARGET;
void PARAKEET_MODEL;
const parakeet: SttProvider = {
  id: "parakeet",
  label: "Parakeet",
  local: true,
  available: () => ({ ok: true }),
  transcribe: async () => {
    throw new Error("nur geladen");
  },
  canWarm: () => true,
  warm: () => startParakeetWarm({ paths, key: "osx-arm64", threads: 4, env }),
};

// Stimme: Pocket aus dem angegebenen Ordner (sonst Browser-Stimme)
const ttsList: TtsProvider[] = [
  { id: "browser", label: "Browser", local: true, where: "browser", available: () => ({ ok: true }), synthesize: async () => ({ audio: Buffer.alloc(0), mime: "audio/wav" }) },
];
if (values.pocket) {
  const server = createPocketServer({ paths: pocketPaths(join(values.pocket, "..")), env: () => env, deps: realPocketServerDeps });
  process.once("exit", () => server.stop());
  ttsList.push({
    id: "pocket",
    label: "Pocket",
    local: true,
    where: "server",
    available: () => ({ ok: true }),
    synthesize: async (text, opts) => ({ audio: await server.synthesize(text, POCKET_DEFAULT_VOICE, opts.signal), mime: "audio/wav" }),
    streamSampleRate: POCKET_SAMPLE_RATE,
    synthesizeStream: (text, opts) => server.synthesizeStream(text, POCKET_DEFAULT_VOICE, opts.signal),
    voiceName: () => "Jürgen",
    warm: async () => server.warmUp(POCKET_DEFAULT_VOICE),
  });
}
// ElevenLabs (Issues #276, #279): die echten Anbieter aus providers.ts, nur mit Schlüssel und fetch
const realDeps: ProviderDeps = {
  env: () => env,
  run: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }),
  fetch: (url, init) => fetch(url, init),
  exists: () => false,
  which: () => null,
  readFile: p => readFile(p),
  writeFile: async () => {},
  unlink: async () => {},
  mkdir: async () => {},
  cwd: () => process.cwd(),
  tmpDir: tmpdir(),
  unique: () => crypto.randomUUID(),
};
if (voiceChoice === "elevenlabs") ttsList.push(createTtsProviders(realDeps).find(p => p.id === "elevenlabs")!);
const sttList: SttProvider[] = [parakeet];
if (sttChoice === "elevenlabs") sttList.push(createSttProviders(realDeps).find(p => p.id === "elevenlabs")!);
const settings = {
  speech: {
    stt: "parakeet",
    tts: values.pocket ? "pocket" : "browser",
    language: "de",
    call: {
      claudeVia: via,
      tts: voiceChoice,
      stt: sttChoice,
      ...(voiceChoice === "elevenlabs" ? { elevenlabsVoice: values["eleven-voice"] ?? CALL_ELEVENLABS_DEFAULT_VOICE, ...(values["eleven-model"] ? { elevenlabsModel: values["eleven-model"] } : {}) } : {}),
    },
  },
} as Settings;
const speech = createSpeech({ stt: sttList, tts: ttsList, getSettings: () => settings, env: () => env, log: () => {}, readFile: p => readFile(p) });

/** Log des Anschlusses mit Zeit, für die Dauer des Erkenners je Lauf (nie Text) */
const botLog: { at: number; line: string }[] = [];
const call = createBotCall({
  userId: "1",
  groupId: () => null,
  agentForTopic: () => "general",
  speech: () => speech,
  resolve: () => resolveCallModel({ settings, env }),
  // Kontext ohne Datenbank: der Agent-Prompt von General
  loadContext: async () => getAgentConfigOrGeneral("general")?.systemPrompt ?? "",
  reserveRequest: () => () => {},
  readRestart: async () => null,
  isIntakeClosed: () => false,
  env,
  log: line => {
    botLog.push({ at: performance.now(), line });
    console.log(`  [bot-call] ${line}`);
  },
});

// Server mit temporären Daten
const dir = await mkdtemp(join(tmpdir(), "tybo-call-measure-"));
const store = new ConversationStore({ dir: join(dir, "web") });
await store.load();
const conversation = await store.createConversation("general");
const password = `messung-${crypto.randomUUID()}`;
const server = await createWebServer(
  { host: "127.0.0.1", port: 0, password, allowedHosts: [] },
  {
    sessionFile: join(dir, "sessions.json"),
    conversationStore: store,
    call,
    voice: { localMode: () => ({ ready: false, stt: null, tts: { id: "browser", label: "Browser", where: "browser", available: true } }) },
    log: line => console.log(`  [web] ${line}`),
  },
);
const login = await fetch(`${server.url}/api/login`, { method: "POST", headers: { origin: server.url }, body: JSON.stringify({ password }) });
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

// Alle Aufnahmen vorab lesen und prüfen
const recordings: { name: string; pcm: Uint8Array }[] = [];
for (const file of values.wav!) {
  const { sampleRate, pcm } = wavToPcm(Buffer.from(await readFile(file)));
  if (sampleRate !== 16_000) fail(`WAV hat ${sampleRate} Hz, nötig sind 16 kHz mono (ffmpeg -ar 16000 -ac 1)`);
  recordings.push({ name: file.split("/").pop()!, pcm });
}
const FRAME = 640;

const ws = new WebSocket(server.url.replace(/^http/, "ws") + CALL_PATH, { headers: { cookie, origin: server.url } } as any);
ws.binaryType = "arraybuffer";
type Msg = Record<string, any> & { at: number };
const inbox: Msg[] = [];
let firstBinaryAt: number | null = null;
ws.addEventListener("message", e => {
  const at = performance.now();
  if (typeof e.data === "string") inbox.push({ ...JSON.parse(e.data), at });
  else if (firstBinaryAt === null) firstBinaryAt = at;
});
await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve());
  ws.addEventListener("error", () => reject(new Error("WebSocket ließ sich nicht öffnen")));
});

async function waitFor(pred: (m: Msg) => boolean, from: number, timeoutMs = 60_000): Promise<Msg> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const m = inbox.slice(from).find(pred);
    if (m) return m;
    const ended = inbox.slice(from).find(x => x.type === "ended" || x.type === "error");
    if (ended) fail(`Abbruch: ${JSON.stringify(ended)}`);
    if (performance.now() > deadline) fail("Zeitlimit beim Warten");
    await Bun.sleep(2);
  }
}

const tOpen = performance.now();
ws.send(JSON.stringify({ type: "start", conversationId: conversation.id, tts: serverVoice ? "server" : "browser" }));
const ready = await waitFor(m => m.type === "ready", 0, 120_000);
const status = await call.status();
console.log(`\nÖffnen bis ready: ${Math.round(ready.at - tOpen)} ms (${ready.via}, ${ready.model}, Stimme ${ready.tts}: ${status.tts.id}${status.tts.model ? ` ${status.tts.model}` : ""}${status.tts.voiceName ? ` „${status.tts.voiceName}“` : ""}${status.tts.fallback ? `, Rückfall ${status.tts.fallback}` : ""})\n`);

interface Row {
  recording: string;
  run: number;
  pause: number;
  /** Dauer des Erkenners laut Log (Anbieterzeit), null wenn nicht im Log */
  provider: number | null;
  /** Wer erkannt hat (aus dem Log) */
  who: string;
  /** Parakeet sprang für Scribe ein */
  sttFallback: boolean;
  /** Rest ab utterance_end bis transcript */
  recognize: number;
  firstSentence: number;
  firstAudio: number | null;
  total: number | null;
  transcript: string;
  /** Wer sprach: die gewählte Stimme oder Rückfall (Hinweis bzw. speak_browser in diesem Lauf) */
  voice: string;
}
const rows: Row[] = [];
const HEARD = /^Hören (\S+)(?: \(geladen\))?: ok, (\d+) ms$/;
for (const rec of recordings) {
const pcm = rec.pcm;
for (let run = 1; run <= runs; run++) {
  const from = inbox.length;
  const logFrom = botLog.length;
  firstBinaryAt = null;
  // Äußerung in Echtzeit, 20 ms je Stück
  const t0 = performance.now();
  for (let off = 0, i = 0; off < pcm.length; off += FRAME, i++) {
    ws.send(pcm.subarray(off, Math.min(pcm.length, off + FRAME)));
    const due = t0 + (i + 1) * 20;
    const wait = due - performance.now();
    if (wait > 0) await Bun.sleep(wait);
  }
  const tEnd = performance.now();
  await Bun.sleep(300);
  ws.send(JSON.stringify({ type: "utterance_pause" }));
  await Bun.sleep(500);
  const tUtteranceEnd = performance.now();
  ws.send(JSON.stringify({ type: "utterance_end" }));
  // Hinweise (etwa der Rückfall auf Parakeet) sind kein Abbruch, nur „nichts verstanden“
  const transcript = await waitFor(m => m.type === "transcript" || (m.type === "notice" && m.text === "nichts verstanden"), from);
  if (transcript.type === "notice") fail(`nicht verstanden: ${transcript.text}`);
  const sentence = await waitFor(m => m.type === "sentence", from);
  if (serverVoice) await waitFor(m => m.type === "audio_end" || m.type === "speak_browser", from);
  const notices = inbox.slice(from).filter(m => m.type === "notice").map(m => String(m.text));
  const sttFallback = notices.some(t => t.includes("Scribe"));
  const fellBack = inbox.slice(from).some(m => m.type === "speak_browser") || notices.some(t => t.includes("nicht erreichbar") && !t.includes("Scribe"));
  const heard = botLog.slice(logFrom).filter(l => l.at <= transcript.at).map(l => HEARD.exec(l.line)).filter((m): m is RegExpExecArray => !!m).at(-1);
  rows.push({
    recording: rec.name,
    run,
    pause: Math.round(tUtteranceEnd - tEnd),
    provider: heard ? Number(heard[2]) : null,
    who: heard ? heard[1]! : "?",
    sttFallback,
    recognize: Math.round(transcript.at - tUtteranceEnd),
    firstSentence: Math.round(sentence.at - transcript.at),
    firstAudio: firstBinaryAt === null ? null : Math.round(firstBinaryAt - sentence.at),
    total: firstBinaryAt === null ? null : Math.round(firstBinaryAt - tEnd),
    transcript: String(transcript.text),
    voice: serverVoice ? (fellBack ? `${voiceChoice} mit Rückfall` : voiceChoice) : "browser",
  });
  // Wiedergabe bestätigen, sobald alles da ist, dann auf „hört zu“ warten
  let confirmed = 0;
  for (;;) {
    const sentences = inbox.slice(from).filter(m => m.type === "sentence");
    const ends = new Set(inbox.slice(from).filter(m => m.type === "audio_end" || m.type === "speak_browser").map(m => m.id));
    for (const s of sentences.slice(confirmed)) {
      if (serverVoice && !ends.has(s.id)) break;
      ws.send(JSON.stringify({ type: "played", id: s.id }));
      confirmed++;
    }
    if (inbox.slice(from).some(m => m.type === "state" && m.state === "hoert-zu")) break;
    await Bun.sleep(20);
  }
  await Bun.sleep(500);
}
}

ws.send(JSON.stringify({ type: "hangup" }));
await Bun.sleep(300);

const fmt = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(2)} s`);
console.log(`Erkenner: ${sttChoice === "elevenlabs" ? "ElevenLabs Scribe (Rückfall Parakeet)" : "Parakeet (geladen)"}\n`);
console.log("| Aufnahme | Lauf | Wer | Anbieter | Rest ab Ende | erster Abschnitt | erster Ton | Ende der Äußerung bis erster Ton | Stimme | erkannt |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.recording} | ${r.run} | ${r.who}${r.sttFallback ? " (Rückfall)" : ""} | ${fmt(r.provider)} | ${fmt(r.recognize)} | ${fmt(r.firstSentence)} | ${fmt(r.firstAudio)} | ${fmt(r.total)} | ${r.voice} | ${r.transcript} |`);
const median = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
};
console.log("");
for (const rec of recordings) {
  const rs = rows.filter(r => r.recording === rec.name);
  console.log(`Median ${rec.name}: Anbieter ${fmt(median(rs.map(r => r.provider)))}, Rest ab Ende ${fmt(median(rs.map(r => r.recognize)))}, Ende der Äußerung bis erster Ton ${fmt(median(rs.map(r => r.total)))}${rs.some(r => r.sttFallback) ? `, Rückfälle ${rs.filter(r => r.sttFallback).length}` : ""}`);
}
console.log(`Median gesamt: Ende der Äußerung bis erster Ton ${fmt(median(rows.map(r => r.total)))}`);

await server.stop();
await rm(dir, { recursive: true, force: true });
process.exit(0);
