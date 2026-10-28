#!/usr/bin/env bun
/**
 * Browser-Durchlauf des Telefonhörers (Issue #258) mit Headless-Chrome über
 * das DevTools-Protokoll. Kein Teil von `bun run check` (braucht Chrome),
 * wird von Hand gestartet:
 *
 *   bun run scripts/web-telefonhoerer-check.ts
 *   bun run scripts/web-telefonhoerer-check.ts --screenshots   # zusätzlich nach docs/webui/screenshots/
 *   bun run scripts/web-telefonhoerer-check.ts --echt --via api --env-file <.env>
 *   bun run scripts/web-telefonhoerer-check.ts --echt --via cli
 *   bun run scripts/web-telefonhoerer-check.ts --echt --werkzeuge --via api --env-file <.env>
 *   (--modelle <Ordner>: Checkout, unter dessen models/speech/ Parakeet und Pocket liegen; Standard dieser)
 *
 * Eigener Web-Server auf freiem Port mit den echten Sicherheitsköpfen (CSP),
 * Gesprächsspeicher in einem temporären Verzeichnis, keine .env des
 * Checkouts, src/bot.ts wird weder gestartet noch importiert, nichts pollt
 * Telegram. Die Seite spricht über den echten WebSocket /api/call mit der
 * echten Gesprächs-Zustandsmaschine des Servers (call-session.ts); die
 * Worklets laufen echt im Browser.
 *
 * Ohne --echt ist nur der Anschluss (CallPort) eine Attrappe: Erkennen
 * liefert einen festen Satz, das Modell zwei Abschnitte, die Stimme einen
 * erzeugten Ton (24 kHz). Damit lassen sich alle Zustände anhalten und
 * fotografieren: Knopf, Verbindet, Hört zu, Hinweis, Stumm, Denkt, Spricht,
 * Aufgelegt, Fehler.
 *
 * Mit --echt ist der Anschluss echt (createBotCall wie in
 * scripts/call-measure.ts): Hören mit Parakeet, Sprechen mit Pocket TTS
 * (beide lokal, eingerichtet mit `tybo setup sprache` unter models/speech/),
 * Modell über die Messages API (--via api, Schlüssel VOICE_ANTHROPIC_API_KEY
 * aus --env-file, nie ausgegeben) oder die offene Claude-Code-Sitzung
 * (--via cli, Abo, wenn ANTHROPIC_API_KEY fehlt). Gemessen wird im Browser.
 * Nullpunkt ist das tatsächliche Ende der Sprache: das letzte gesendete
 * Tonstück mit Pegel über einem Zehntel des lautesten (nicht das letzte
 * Stück, das noch bis zu 300 ms Endstille trägt). Ende ist der technische
 * Wiedergabebeginn: die Meldung begin des Spieler-Worklets beim ersten
 * ausgegebenen Wert. Kommt sie nicht, ist das ein Fehler.
 *
 * Verlauf und Einstellungen (Issue #260): Ohne --echt prüft der Durchlauf
 * außerdem den Verlauf nach einem Gespräch (Äußerung „am Telefon gesagt“,
 * Antwort „Telefonhörer · Modell“, Meldung zum Ende; nichts an das
 * Gedächtnis-Attrappe vorbei nach Telegram) und den Abschnitt „Telefonhörer“
 * im Reiter „Sprechen“: bereit mit Wegen, Probe mit Ergebnis, nicht bereit mit
 * Grund und nächstem Schritt.
 *
 * Werkzeuge (Issue #259): Ohne --echt kommen drei weitere Zustände dazu:
 * „schaut nach …“ während einer Suche, die Freigabe-Zeile mit Knöpfen
 * (Rückfragen-Port als Attrappe, Klick per POST) und die Meldung nach dem
 * Telefonat im Verlauf. Mit --echt --werkzeuge spricht das Mikrofon drei
 * Fragen (Suche, Rechnen, Denkauftrag) mit langen Pausen dazwischen; das
 * Modell ist echt, die Suche im Verlauf eine Attrappe mit festem Ergebnis
 * (keine Datenbank), der Denkauftrag läuft in die Chat-Kern-Attrappe des
 * Prüfservers. Gemessen wird je Frage vom Sprachende bis zum Werkzeug, bis
 * zur Ansage und bis zur Antwort (Wiedergabebeginn im Spieler-Worklet).
 *
 * Mikrofon: Chromes Attrappe spielt eine WAV-Datei ab (12 s Stille, mit
 * --screenshots 20 s, damit die Bilder vor dem Satz fertig sind, ein
 * deutscher Satz von `say`, Stille; mit --echt 15 s Stille, weil Parakeet und
 * Pocket beim Öffnen laden). Jedes neue Öffnen des Mikrofons spielt
 * die Datei von vorn.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import { CallOpenError, type CallLine, type CallModeStatus, type CallPort, type CallTtsMode, type CallTurnEvent } from "../src/web/call-protocol";
import { createDemoAgents, createDemoCommands, createDemoEngines, createDemoInstructions, createDemoKeys, createDemoModels, createDemoStatus } from "../src/web/demo";
import { createWebServer } from "../src/web/server";
import { pcmToWav } from "../src/lib/speech/pcm";
import { ConversationStore } from "../src/web/store";
import { UploadStore } from "../src/web/uploads";
import type { VoicePort } from "../src/web/voice";
import type { ApiChoice, ChoiceChange, ChoicePort } from "../src/web/choices";

const { values } = parseArgs({
  options: {
    screenshots: { type: "boolean", default: false },
    echt: { type: "boolean", default: false },
    via: { type: "string", default: "api" },
    "env-file": { type: "string" },
    modelle: { type: "string" },
    werkzeuge: { type: "boolean", default: false },
  },
});

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSWORD = "browser-check-passwort";
const SHOTS = values.screenshots === true;
const REAL = values.echt === true;
const VIA = values.via === "cli" ? "cli" : "api";
const OUT = join(import.meta.dir, "..", "docs", "webui", "screenshots");
const ROOT = join(import.meta.dir, "..");
const SENTENCE = "Wie wird das Wetter morgen in Hamburg";
const TRANSCRIPT = "Wie wird das Wetter morgen in Hamburg?";
const SEGMENTS = ["Morgen wird es in Hamburg überwiegend sonnig bei achtzehn Grad.", "Am Abend wird es frisch, nimm eine Jacke mit."];
const TOOLS = REAL && values.werkzeuge === true;
/** Drei Fragen für --echt --werkzeuge (Issue #259): Suche, Rechnen, Denkauftrag */
const TOOL_QUESTIONS = [
  { kind: "suche", text: "Welche Farbe hatten wir für die neue Küchenfront ausgesucht" },
  { kind: "rechne", text: "Wie viel sind achtzehn Prozent von zweitausendvierhundertfünfzig Euro" },
  { kind: "denkauftrag", text: "Recherchiere bitte im Internet die drei besten Wärmepumpen für ein Einfamilienhaus und vergleiche ihre Preise" },
] as const;
/** Pause zwischen den Fragen: Antwort samt Ton muss vorher fertig sein */
const TOOL_GAP_SECONDS = 25;
/** Ergebnis der Such-Attrappe im echten Lauf */
const SEARCH_RESULT = "Gespräch vom 3. September 2026: Für die neue Küchenfront habt ihr Salbeigrün matt ausgesucht, die Griffe in Messing.";
/** So lange Stille vor dem Satz: Zeit für die Aufnahmen von „Hört zu“, Hinweis und „Stumm“ */
/** Echt: Parakeet und Pocket laden beim Öffnen einige Sekunden; der Satz muss danach kommen */
const LEAD_SECONDS = REAL ? 15 : SHOTS ? 20 : 12;

function abort(text: string): never {
  console.error(text);
  process.exit(1);
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  return { promise, resolve };
}

// --- Ton für Chromes Mikrofon-Attrappe --------------------------------------------

function wav(rate: number, samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true);
  return bytes;
}

/** PCM16 mono aus einer WAV-Datei von `say` (mit beliebigen Blöcken vor data) */
function pcmOf(bytes: Uint8Array): { rate: number; samples: Int16Array } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt ") {
      channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
    } else if (tag(at) === "data") {
      if (bits !== 16 || channels !== 1 || !rate) return null;
      const count = Math.floor(Math.min(size, bytes.length - at - 8) / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(at + 8 + i * 2, true);
      return { rate, samples };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/** Ton mit der Lautstärke von Silben, wenn `say` fehlt */
function toneBursts(rate: number, seconds: number): Int16Array {
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const syllable = Math.min(1, 3 * Math.max(0, Math.sin(2 * Math.PI * 2.5 * t)));
    const voice = Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t) + 0.25 * Math.sin(2 * Math.PI * 720 * t);
    out[i] = Math.round(((0.5 * syllable * voice) / 1.75) * 32767);
  }
  return out;
}

async function microphoneFile(dir: string): Promise<{ path: string; source: string }> {
  const rate = 48000;
  let speech: Int16Array | null = null;
  let source = "Tonfolge";
  const say = Bun.which("say");
  if (say) {
    const list = Bun.spawnSync([say, "-v", "?"]).stdout.toString();
    const german = list.split("\n").map(l => /^(.+?)\s+de_DE\b/.exec(l)?.[1]?.trim()).filter(Boolean) as string[];
    const voice = german.includes("Anna") ? "Anna" : german[0];
    const spoken = async (text: string, i: number): Promise<Int16Array | null> => {
      const raw = join(dir, `satz-${i}.wav`);
      const made = Bun.spawnSync([say, ...(voice ? ["-v", voice] : []), "-o", raw, `--data-format=LEI16@${rate}`, text]);
      const pcm = made.exitCode === 0 && existsSync(raw) ? pcmOf(new Uint8Array(await Bun.file(raw).arrayBuffer())) : null;
      return pcm && pcm.rate === rate && pcm.samples.length > rate / 2 ? pcm.samples : null;
    };
    const texts = TOOLS ? TOOL_QUESTIONS.map(q => q.text) : [SENTENCE];
    const parts: Int16Array[] = [];
    for (const [i, text] of texts.entries()) {
      const pcm = await spoken(text, i);
      if (!pcm) break;
      parts.push(pcm);
    }
    if (parts.length === texts.length) {
      // Mehrere Fragen: lange Stille dazwischen, damit jede Antwort fertig ist
      const gap = new Int16Array(rate * TOOL_GAP_SECONDS);
      const total = parts.reduce((n, p) => n + p.length, 0) + gap.length * (parts.length - 1);
      speech = new Int16Array(total);
      let at = 0;
      for (const [i, p] of parts.entries()) {
        speech.set(p, at);
        at += p.length + (i < parts.length - 1 ? gap.length : 0);
      }
      source = `say${voice ? ` (Stimme ${voice})` : ""}: ${texts.map(t => `„${t}"`).join(", ")}`;
    }
  }
  if (!speech) {
    if (REAL) abort("--echt braucht einen gesprochenen Satz: `say` fehlt oder liefert keine WAV-Datei.");
    speech = toneBursts(rate, 2.2);
  }
  const lead = Math.round(rate * LEAD_SECONDS);
  const tail = Math.round(rate * 4);
  const all = new Int16Array(lead + speech.length + tail);
  all.set(speech, lead);
  const path = join(dir, "mikrofon.wav");
  await Bun.write(path, wav(rate, all));
  return { path, source };
}

if (!existsSync(CHROME)) abort(`Chrome nicht gefunden: ${CHROME} (CHROME_PATH setzen).`);
const dir = await mkdtemp(join(tmpdir(), "tybo-telefonhoerer-"));
const mic = await microphoneFile(dir);
console.log(`Mikrofon-Attrappe: ${mic.source}, ${LEAD_SECONDS} s Stille davor`);

// --- Anschluss: Attrappe oder echt --------------------------------------------------

const ctl = {
  openGate: null as Deferred | null,
  failOpen: false,
  turnGate: null as Deferred | null,
  budget: false,
  /** Turn mit Suche: tool start, dann warten (Issue #259) */
  search: false,
  searchGate: null as Deferred | null,
  /** Offene Werkzeug-Freigabe im Gespräch (Rückfragen-Port-Attrappe) */
  approval: false,
  decided: [] as string[],
  /** Länge des Tons je Abschnitt */
  speakSeconds: 0.8,
  opened: 0,
  closed: 0,
  recognized: [] as number[],
  interrupts: 0,
  records: [] as { spokenText: string; interrupted: boolean }[],
  /** Issue #260: Status nicht bereit (kein Erkenner, kein Weg) */
  notReady: false,
  probes: 0,
  /** Issue #276: Hörprobe der Stimme scheitert mit Grund */
  voiceProbeFail: false,
  voiceProbes: 0,
  /** Issue #260: was ins gemeinsame Gedächtnis ginge */
  remembered: [] as string[],
};

/** Ton als „Stimme“: PCM16 24 kHz, leiser Sinus mit weichen Rändern */
function voiceChunk(from: number, count: number, total: number, hz: number): Uint8Array {
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const n = from + i;
    const fade = Math.min(1, n / 600, (total - n) / 600);
    out[i] = Math.round(Math.sin((2 * Math.PI * hz * n) / 24000) * 0.2 * fade * 32767);
  }
  return new Uint8Array(out.buffer);
}

const WAYS: NonNullable<CallModeStatus["ways"]> = [
  { id: "api", model: "claude:claude-sonnet-5-5", claudeVia: "api", label: "Claude Sonnet 5.5 über deinen API-Schlüssel", ready: true, expectation: "erster Satz nach rund 1,5 Sekunden, gleichmäßig (Messung vom 30.09.2026 auf einem Mac mit Apple M4)", billing: "anthropic-api" },
  { id: "cli", model: "claude:claude-sonnet-5-5", claudeVia: "cli", label: "Claude Sonnet 5.5 über dein Claude-Abo", ready: true, expectation: "erster Satz nach rund 1,5 Sekunden, bei Überlegfragen bis 5 Sekunden (Messung vom 30.09.2026 auf einem Mac mit Apple M4)", billing: "subscription" },
  { id: "openrouter", model: "openrouter:anthropic/claude-sonnet-5.5", label: "OpenRouter: anthropic/claude-sonnet-5.5", ready: false, reason: "OPENROUTER_API_KEY fehlt", expectation: "", billing: null },
  { id: "ollama", model: "ollama:qwen3:8b", label: "Ollama: qwen3:8b", ready: false, reason: "Ollama läuft nicht (ollama serve starten)", expectation: "", billing: null },
];
const FAKE_STATUS: CallModeStatus = {
  ready: true,
  model: "claude-sonnet-5-5",
  via: "api",
  expectation: "erster Satz nach rund 1,5 Sekunden",
  // Issue #279: Erkenner zur Wahl wie aus callSttOptions (Scribe mit Schlüssel, whisper.cpp nicht eingerichtet)
  stt: {
    id: "parakeet",
    local: true,
    warm: true,
    setting: "auto",
    options: [
      { id: "auto", label: "Automatisch", available: true },
      { id: "parakeet", label: "Parakeet", available: true },
      { id: "whisper-cpp", label: "whisper.cpp", available: false, reason: "Modelldatei fehlt" },
      { id: "elevenlabs", label: "ElevenLabs Scribe", available: true },
    ],
  },
  // Issue #276: Stimmen zur Wahl wie aus callTtsOptions (ElevenLabs mit Schlüssel, Piper nicht eingerichtet)
  tts: {
    id: "pocket",
    where: "server",
    stream: true,
    setting: "auto",
    voice: "beispielStimme01",
    options: [
      { id: "auto", label: "Automatisch", available: true },
      { id: "pocket", label: "Pocket TTS", available: true },
      { id: "piper", label: "Piper", available: false, reason: "Piper ist nicht installiert" },
      { id: "elevenlabs", label: "ElevenLabs", available: true },
      { id: "browser", label: "Browser-Stimme", available: true },
    ],
    models: [
      { id: "eleven_flash_v2_5", label: "Flash v2.5" },
      { id: "eleven_turbo_v2_5", label: "Turbo v2.5" },
      { id: "eleven_multilingual_v2", label: "Multilingual v2" },
    ],
  },
  billing: "anthropic-api",
  setting: "auto",
  settingSource: "code",
  ways: WAYS,
  probe: true,
  voiceProbe: true,
};
const NOT_READY_STATUS: CallModeStatus = {
  ready: false,
  reason: "Hören: kein lokaler Erkenner; Kein Weg für den Telefonhörer bereit: kein VOICE_ANTHROPIC_API_KEY; Claude Code ist nicht angemeldet; kein OPENROUTER_API_KEY",
  model: null,
  via: null,
  expectation: "kein Telefonhörer: es ist kein passender Weg eingerichtet",
  stt: { id: null, local: false, warm: false },
  tts: { id: "browser", where: "browser", stream: false },
  billing: null,
  setting: "auto",
  settingSource: "code",
  ways: WAYS.map(w => ({ ...w, ready: false, reason: w.reason ?? (w.id === "api" ? "VOICE_ANTHROPIC_API_KEY fehlt (claudeVia api ist eingestellt)" : "Claude Code ist nicht angemeldet") })),
  probe: true,
};

function fakeLine(tts: CallTtsMode): CallLine {
  let hz = 330;
  return {
    info: { model: "claude-sonnet-5-5", via: "api", stt: "parakeet", tts, sampleRate: 24000, sttWarm: true },
    async recognize(pcm) {
      ctl.recognized.push(pcm.byteLength);
      await Bun.sleep(120);
      return { ok: true, text: TRANSCRIPT };
    },
    async *turn({ signal }): AsyncGenerator<CallTurnEvent> {
      if (ctl.search) {
        yield { type: "tool", name: "suche", phase: "start" };
        if (ctl.searchGate) await ctl.searchGate.promise;
        yield { type: "segment", text: "Ihr habt Salbeigrün matt ausgesucht." };
        yield { type: "done", rawText: "[SUCHE: Küchenfront Farbe]Ihr habt Salbeigrün matt ausgesucht.", spokenText: "Ihr habt Salbeigrün matt ausgesucht.", aborted: false };
        return;
      }
      if (ctl.turnGate) await ctl.turnGate.promise;
      if (ctl.budget) {
        yield { type: "error", reason: "budget", message: "Tagesbudget erschöpft", rawText: "", spokenText: "" };
        return;
      }
      for (const text of SEGMENTS) {
        if (signal.aborted) return;
        yield { type: "segment", text };
        await Bun.sleep(80);
      }
      yield { type: "done", rawText: SEGMENTS.join(" "), spokenText: SEGMENTS.join(" "), aborted: false };
    },
    async interrupt() {
      ctl.interrupts++;
    },
    ...(tts === "server"
      ? {
          async *speak(_text: string, signal: AbortSignal) {
            const total = Math.round(24000 * ctl.speakSeconds);
            hz = hz === 330 ? 440 : 330;
            for (let at = 0; at < total && !signal.aborted; at += 4800) {
              yield voiceChunk(at, Math.min(4800, total - at), total, hz);
              await Bun.sleep(40);
            }
          },
        }
      : {}),
    onTurn(record) {
      ctl.records.push({ spokenText: record.spokenText, interrupted: record.interrupted });
    },
    close() {
      ctl.closed++;
    },
  };
}

const fakePort: CallPort = {
  status: async () => (ctl.notReady ? NOT_READY_STATUS : FAKE_STATUS),
  // Issue #260: Probe mit festen Messwerten (kein Modell)
  async probe() {
    ctl.probes++;
    await Bun.sleep(300);
    return { ok: true, medianMs: 1_380, minMs: 1_120, maxMs: 1_710, measured: 3, count: 3, rating: "fluessig", text: "Antwort beginnt nach 1,4 s (3 Proben: 1,1 bis 1,7 s), flüssig", model: "claude-sonnet-5-5", via: "api" };
  },
  // Issue #276: Hörprobe der Stimme, 0,6 s Ton der Attrappe oder ein Fehler mit Grund (keine echte Stimme)
  async voiceProbe() {
    ctl.voiceProbes++;
    await Bun.sleep(200);
    if (ctl.voiceProbeFail) return { ok: false, reason: "ElevenLabs ist nicht verfügbar (ELEVENLABS_API_KEY fehlt)." };
    return { ok: true, audio: pcmToWav(voiceChunk(0, 14_400, 14_400, 440), 24_000), provider: "elevenlabs", firstMs: 140 };
  },
  restartPending: () => false,
  turnBegin: () => () => {},
  onRestart: () => () => {},
  async open({ tts }) {
    ctl.opened++;
    if (ctl.openGate) await ctl.openGate.promise;
    if (ctl.failOpen) throw new CallOpenError("nicht-bereit", "Der Telefonhörer ist gerade nicht bereit: kein Modell erreichbar.");
    return fakeLine(tts);
  },
};

/** .env lesen, ohne Werte auszugeben; nur die nötigen Namen */
async function loadEnv(file: string | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!file) return out;
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const m = /^\s*(VOICE_ANTHROPIC_API_KEY)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

async function realPort(): Promise<CallPort> {
  const models = values.modelle ? resolve(values.modelle) : ROOT;
  for (const proof of ["parakeet.ok.json", "pocket.ok.json"]) {
    if (!existsSync(join(models, "models", "speech", proof))) abort(`--echt braucht Parakeet und Pocket TTS: ${join(models, "models", "speech", proof)} fehlt (tybo setup sprache, oder --modelle <Checkout>).`);
  }
  if (VIA === "api" && !values["env-file"]) abort("--echt --via api braucht --env-file mit VOICE_ANTHROPIC_API_KEY.");
  const fileEnv = await loadEnv(values["env-file"]);
  if (VIA === "api" && !fileEnv.VOICE_ANTHROPIC_API_KEY) abort("--env-file enthält keinen VOICE_ANTHROPIC_API_KEY.");
  // Ohne ANTHROPIC_API_KEY: die CLI läuft im Abo
  const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME, ...fileEnv };
  const { createDevSpeech } = await import("./web-dev-speech");
  const { createBotCall } = await import("../src/web/bot-call");
  const { resolveCallModel } = await import("../src/lib/voice-brain/call-model");
  const { getAgentConfigOrGeneral } = await import("../src/agents/base");
  const settings = { speech: { stt: "parakeet", tts: "pocket", language: "de", call: { claudeVia: VIA } } } as any;
  const dev = createDevSpeech({ settings: () => settings, env: () => env, cwd: () => models, log: () => {} });
  return createBotCall({
    userId: "1",
    groupId: () => null,
    agentForTopic: () => "general",
    speech: () => dev.speech,
    resolve: () => resolveCallModel({ settings, env }),
    loadContext: async () => getAgentConfigOrGeneral("general")?.systemPrompt ?? "",
    reserveRequest: () => () => {},
    readRestart: async () => null,
    isIntakeClosed: () => false,
    env,
    log: line => console.log(`  [bot-call] ${line}`),
    // Werkzeuge (Issue #259): Suche im Verlauf als Attrappe mit festem Ergebnis, keine Datenbank;
    // Merk-Tags und die Meldung nach dem Auflegen nur ins Log, nie in einen Speicher
    searchAvailable: () => true,
    searchHistory: async query => {
      console.log(`  [Suche] Anfrage: ${query}`);
      await Bun.sleep(150);
      return SEARCH_RESULT;
    },
    processIntents: async () => ({ outcome: "none" }),
    saveMessage: async () => true,
  });
}

const port = REAL ? await realPort() : fakePort;

// --- Web-Server ------------------------------------------------------------------------

const store = new ConversationStore({ dir: join(dir, "web") });
await store.load();
const talk = await store.createConversation("general");
await store.renameConversation(talk.id, "Wochenplanung");
await store.appendMessage(talk.id, { role: "user", text: "Was steht diese Woche an?" });
await store.appendMessage(talk.id, { role: "assistant", text: "Am Mittwoch der Zahnarzt um 9 Uhr, am Freitag das Abendessen mit Alex und Mia." });
const other = await store.createConversation("research");
await store.renameConversation(other.id, "Bahnpreise");

const deepTasks: string[] = [];
const chat: WebChat = {
  async runTurn({ agent, text, noTelegram }: RunTurnOptions) {
    if (text.startsWith("Denkauftrag aus dem Telefongespräch:")) {
      deepTasks.push(`${noTelegram ? "ohne Telegram" : "MIT Telegram"}: ${text.split("\n")[0]}`);
      await Bun.sleep(1500);
      return { text: "Ergebnis der Attrappe: Modell B ist am günstigsten.", info: { agent, model: "attrappe", durationMs: 1500 } };
    }
    return { text: "Attrappe.", info: { agent, model: "attrappe", durationMs: 1 } };
  },
  stop() {},
};
// Rückfragen-Port als Attrappe (Issue #259): eine offene Werkzeug-Freigabe im Gespräch, Entscheiden per POST
const choiceListeners = new Set<(c: ChoiceChange) => void>();
const APPROVAL: ApiChoice = { id: "frg1", options: [{ key: "ok", label: "Freigeben" }, { key: "no", label: "Ablehnen" }], state: "open" };
const choices: ChoicePort = {
  view: async () => (ctl.approval ? APPROVAL : { id: APPROVAL.id, options: [], state: "expired" }),
  decide: async (conversationId, choiceId, option) => {
    if (!ctl.approval || choiceId !== APPROVAL.id) return { status: "not_found" };
    ctl.approval = false;
    ctl.decided.push(option);
    const done: ApiChoice = { id: APPROVAL.id, options: [], state: "done", result: { key: option, label: option === "ok" ? "Freigeben" : "Ablehnen", via: "web", at: new Date().toISOString() } };
    for (const l of choiceListeners) l({ conversationId, choice: done, copyInDm: false });
    return { status: "decided", choice: done };
  },
  subscribe: l => {
    choiceListeners.add(l);
    return () => choiceListeners.delete(l);
  },
  pending: async (conversationId, kind) => (ctl.approval && conversationId === talk.id && kind === "tool" ? [APPROVAL] : []),
};
const voice: VoicePort = {
  localMode: () => ({ ready: true, stt: { id: "whisper-cpp", label: "Attrappe", local: true, available: true }, tts: { id: "browser", label: "Browser-Stimme", where: "browser", available: true } }),
};
const demo = createDemoAgents({ seed: false });
const serverLog: string[] = [];
/** Uhr des Telefonhörers im Prüfserver; nur zwischen zwei Gesprächen vorgestellt (Startgrenze 6 in 10 Minuten) */
let callClockSkew = 0;
const callClock = {
  now: () => Date.now() + callClockSkew,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
};
const server = await createWebServer(
  { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
  {
    sessionFile: join(dir, "sessions.json"),
    dataDir: join(dir, "web"),
    conversationStore: store,
    chat,
    uploads: new UploadStore({ dir: join(dir, "uploads") }),
    cliTokenFile: join(dir, "cli-token"),
    voice,
    call: port,
    callClock,
    // Issue #260: Gedächtnis als Attrappe; Web-Gespräche stehen im Gesprächsspeicher dieses Prüfservers
    callMemory: {
      save: async (_id, entry) => (ctl.remembered.push(`${entry.role}: ${entry.text}`), true),
      notice: async () => true,
    },
    choices,
    settings: demo.settings,
    engines: createDemoEngines(demo.settings),
    agentCatalog: demo.catalog,
    instructions: createDemoInstructions(),
    models: createDemoModels(),
    status: createDemoStatus(),
    commands: createDemoCommands(),
    keys: createDemoKeys(),
    log: line => serverLog.push(line),
  }
);
const front = server.url.replace(/\/$/, "");

// --- Chrome ------------------------------------------------------------------------
const debugPort = 9990 + Math.floor(Math.random() * 9);
const chrome = Bun.spawn(
  [CHROME, "--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(dir, "chrome")}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${mic.path}%noloop`,
    "--disable-features=AudioServiceSandbox",
    "--autoplay-policy=no-user-gesture-required", "about:blank"],
  { stdout: "ignore", stderr: "ignore" }
);

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`${pass ? "OK  " : "FEHL"} ${name}${detail ? `  (${detail})` : ""}`);
}

async function pageSocketUrl(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as any[];
      const page = targets.find(t => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome startet noch
    }
    await Bun.sleep(100);
  }
  throw new Error("Chrome nicht erreichbar");
}

const ws = new WebSocket(await pageSocketUrl());
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();
const problems: string[] = [];
ws.addEventListener("message", event => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "Ausnahme");
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") problems.push(msg.params.entry.text);
});
function cdp(method: string, params: object = {}): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(id, msg => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)))
  );
}
async function js<T = any>(expression: string): Promise<T> {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(`JS-Fehler: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text} in ${expression.slice(0, 120)}`);
  return r.result.value;
}
async function waitFor(expression: string, timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await js<boolean>(`!!(${expression})`)) return true;
    } catch {
      // Seite lädt gerade
    }
    await Bun.sleep(40);
  }
  return false;
}
async function goto(url: string) {
  await cdp("Page.navigate", { url });
  await Bun.sleep(150);
  await waitFor(`document.readyState === "complete"`);
}
async function viewport(width: number, height = width < 600 ? 844 : 800) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 1000 });
}
async function scheme(value: "light" | "dark") {
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
}
const noHorizontalScroll = (width: number) => js<boolean>(`document.documentElement.scrollWidth <= ${width} && document.body.scrollWidth <= ${width}`);

async function shoot(name: string) {
  await Bun.sleep(120);
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`Bild ${name}.png`);
}
/** 1280 und 390 px, hell und dunkel, im gerade stehenden Zustand; ohne --screenshots nur die Breitenprüfung */
async function shootAll(name: string) {
  for (const width of [1280, 390]) {
    for (const s of ["light", "dark"] as const) {
      if (!SHOTS && s === "dark") continue;
      await viewport(width);
      await scheme(s);
      await Bun.sleep(60);
      check(`${name} ${width} px ${s === "dark" ? "dunkel" : "hell"}: kein seitliches Scrollen`, await noHorizontalScroll(width));
      if (SHOTS) await shoot(`${name}-${width}${s === "dark" ? "-dunkel" : ""}`);
    }
  }
  await scheme("light");
  await viewport(1280);
}

/**
 * In jeder Seite vor ihren Skripten: Browser-Stimme als Attrappe (Headless
 * hat keine), Mitschrift von Mikrofon, AudioContext, Worklets, Spieler-
 * Meldungen, WebSocket (gesendet und empfangen) und Zuständen.
 */
const PAGE_HOOKS = `(() => {
  const spoken = [];
  class Utterance {
    constructor(text) { this.text = text; this.volume = 1; this.rate = 1; this.lang = ""; this.voice = null; this.onstart = null; this.onend = null; this.onerror = null; }
  }
  const realTimeout = window.setTimeout.bind(window);
  let current = null;
  const synth = {
    getVoices: () => [{ voiceURI: "Anna", name: "Anna", lang: "de-DE", localService: true, default: true }],
    speak(u) {
      if (u.volume === 0) return;
      spoken.push({ text: u.text, at: performance.now() });
      current = u;
      realTimeout(() => { if (current === u && u.onstart) u.onstart({}); }, 50);
      realTimeout(() => { if (current === u) { current = null; if (u.onend) u.onend({}); } }, 400);
    },
    cancel() { current = null; },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = Utterance;
  window.__spoken = spoken;

  window.__streams = [];
  const devices = navigator.mediaDevices;
  if (devices && devices.getUserMedia) {
    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async constraints => { const stream = await original(constraints); window.__streams.push(stream); return stream; };
  }
  window.__modules = [];
  if (window.AudioWorklet) {
    const addModule = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function (url, ...rest) { window.__modules.push(String(url)); return addModule.call(this, url, ...rest); };
  }
  window.__contexts = [];
  // Issue #280: Wert der Audio-Sitzung, als AudioContext und Mikrofon angefragt wurden
  window.__sessionAt = [];
  const sessionType = () => (navigator.audioSession ? navigator.audioSession.type : null);
  if (window.AudioContext) {
    const Original = window.AudioContext;
    window.AudioContext = class extends Original { constructor(...args) { window.__sessionAt.push({ what: "context", type: sessionType() }); super(...args); window.__contexts.push(this); } };
  }
  if (devices && devices.getUserMedia) {
    const counted = devices.getUserMedia;
    devices.getUserMedia = constraints => { window.__sessionAt.push({ what: "mic", type: sessionType() }); return counted(constraints); };
  }
  // <audio>-Elemente mit MediaStream (Wiedergabeweg mit Audio-Sitzung)
  window.__streamAudios = [];
  const srcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
  if (srcObject && srcObject.set) {
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      get() { return srcObject.get.call(this); },
      set(value) { if (value instanceof MediaStream && !window.__streamAudios.includes(this)) window.__streamAudios.push(this); srcObject.set.call(this, value); },
    });
  }
  window.__player = [];
  window.__playerPosted = [];
  if (window.AudioWorkletNode) {
    const Node = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Node {
      constructor(context, name, options) {
        super(context, name, options);
        if (name === "call-player") {
          this.port.addEventListener("message", e => window.__player.push({ ...e.data, at: performance.now() }));
          const post = this.port.postMessage.bind(this.port);
          this.port.postMessage = (m, t) => { window.__playerPosted.push({ type: m && m.type, at: performance.now() }); return post(m, t); };
        }
      }
    };
  }
  window.__sockets = [];
  window.__sent = [];
  window.__recv = [];
  const Socket = window.WebSocket;
  window.WebSocket = class extends Socket {
    constructor(...args) {
      super(...args);
      window.__sockets.push(this);
      this.addEventListener("message", e => {
        let type = "pcm";
        let extra = {};
        if (typeof e.data === "string") { const m = JSON.parse(e.data); type = m.type + (m.state ? ":" + m.state : "") + (m.reason ? ":" + m.reason : ""); extra = { id: m.id, text: m.text, name: m.name }; }
        window.__recv.push({ type, at: performance.now(), ...extra });
      });
      this.addEventListener("close", e => window.__recv.push({ type: "close:" + e.code, at: performance.now() }));
    }
    send(data) {
      let rms = 0;
      if (typeof data !== "string") { const pcm = new Int16Array(data); let sum = 0; for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 32768) ** 2; rms = pcm.length ? Math.sqrt(sum / pcm.length) : 0; }
      window.__sent.push({ type: typeof data === "string" ? JSON.parse(data).type : "pcm", bytes: typeof data === "string" ? 0 : data.byteLength, rms, at: performance.now() });
      return super.send(data);
    }
  };
  window.__phases = [];
  document.addEventListener("DOMContentLoaded", () => {
    const state = document.getElementById("call-state");
    if (state) new MutationObserver(() => { const last = window.__phases[window.__phases.length - 1]; if (!last || last.text !== state.textContent) window.__phases.push({ text: state.textContent, at: performance.now() }); }).observe(state, { childList: true, characterData: true, subtree: true });
  });
})()`;

const stateText = `document.getElementById("call-state").textContent`;
const panelShown = `!document.getElementById("call-panel").hidden`;
const inState = (text: string) => `${panelShown} && ${stateText} === ${JSON.stringify(text)}`;
const noteText = () => js<string>(`(n => (n.hidden ? "" : n.textContent))(document.getElementById("call-note"))`);
const click = (id: string) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
const tracksEnded = () => js<boolean>(`window.__streams.length > 0 && window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended"))`);
const contextsClosed = () => js<boolean>(`window.__contexts.length > 0 && window.__contexts.every(c => c.state === "closed")`);
const sent = () => js<{ type: string; bytes: number; rms: number; at: number }[]>(`window.__sent`);
const pcmSent = async () => (await sent()).filter(m => m.type === "pcm").length;
/** Mitschriften für das nächste Gespräch leeren */
const resetLogs = () => js(`window.__sent.length = 0; window.__recv.length = 0; window.__player.length = 0; window.__playerPosted.length = 0; window.__phases.length = 0; window.__spoken.length = 0;`);

async function openTalkConversation() {
  await waitFor(`document.querySelector('.conversation[data-id="${talk.id}"]')`);
  await js(`document.querySelector('.conversation[data-id="${talk.id}"]').click()`);
  await waitFor(`document.querySelectorAll("#chat-log .msg").length >= 2`);
}

async function hangUp(label: string) {
  await click("call-hangup");
  const closed = await waitFor(`document.getElementById("call-panel").hidden && !document.getElementById("composer-box").hidden`);
  check(`${label}: Auflegen gibt alles frei (Spuren beendet, AudioContext zu, hangup, Verbindung zu)`,
    closed && (await tracksEnded()) && (await contextsClosed()) && (await waitFor(`window.__sockets.every(s => s.readyState === 3)`)) && (await sent()).some(m => m.type === "hangup"));
}

try {
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await cdp("Page.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HOOKS });
  await viewport(1280);
  await scheme("light");

  await goto(`${front}/login`);
  await waitFor(`document.getElementById("password")`);
  await js(`document.getElementById("password").value = ${JSON.stringify(PASSWORD)}`);
  await js(`document.getElementById("login-form").requestSubmit()`);
  check("Anmeldung führt zum Chat", await waitFor(`location.pathname === "/" && document.getElementById("input")`, 10000));
  await openTalkConversation();

  // --- Knopf ------------------------------------------------------------------------
  check("Knopf „Telefonhörer“ sichtbar und frei", await waitFor(`(b => b && !b.hidden && !b.disabled && b.getClientRects().length > 0)(document.getElementById("call"))`));
  const button = await js<any>(`(b => ({ label: b.getAttribute("aria-label"), svg: !!b.querySelector("svg"), stroke: getComputedStyle(b.querySelector("svg")).strokeWidth, prev: b.previousElementSibling && b.previousElementSibling.id, next: b.nextElementSibling && b.nextElementSibling.id }))(document.getElementById("call"))`);
  check("Knopf: Name für Screenreader, inline SVG mit Kontur 1.8, neben „Sprechen“ vor Senden", /^Mit .+ telefonieren$/.test(button.label) && button.svg && button.stroke === "1.8px" && button.prev === "talk" && button.next === "send", JSON.stringify(button));
  check("vor dem Tipp kein Mikrofon, keine Verbindung", (await js<number>(`window.__streams.length + window.__sockets.length`)) === 0);
  await viewport(390);
  const size = await js<number>(`document.getElementById("call").getBoundingClientRect().width`);
  check("Knopf am Handy 2.75rem", size >= 44, `${size}px`);
  await viewport(1280);
  await shootAll("telefonhoerer-knopf");

  if (!REAL) {
    // --- 1. Gespräch: Verbindet … ---------------------------------------------------
    ctl.openGate = deferred();
    await click("call");
    check("Tipp: die Ansicht ersetzt die Eingabebox, „Verbindet …“, Fokus in der Ansicht",
      (await waitFor(inState("Verbindet …"))) && (await js<boolean>(`document.getElementById("composer-box").hidden && document.activeElement === document.getElementById("call-panel")`)));
    check("start mit dem offenen Gespräch über den WebSocket (CSP connect-src 'self')",
      (await waitFor(`window.__sent.some(m => m.type === "start")`)) && (await js<string>(`window.__sockets[0].url`)).startsWith(front.replace(/^http/, "ws")),
      await js<string>(`window.__sockets[0] && window.__sockets[0].url`));
    check("Erwartung steht unter „Verbindet …“", (await js<string>(`document.getElementById("call-expect").textContent`)) === "Erster Satz nach rund 1,5 Sekunden");
    check("AudioContext im Tipp gestartet, beide Worklets aus eigenen Dateien",
      await waitFor(`window.__contexts.length === 1 && window.__contexts[0].state === "running" && window.__modules.join() === "/speech-worklet.js,/call-player-worklet.js"`),
      await js<string>(`window.__modules.join() + ", " + (window.__contexts[0] && window.__contexts[0].state)`));
    await shootAll("telefonhoerer-verbindet");
    await hangUp("Verbindet");
    ctl.openGate.resolve();
    ctl.openGate = null;
    await Bun.sleep(300);

    // --- 2. Gespräch: Hört zu, Hinweis, Stumm, Denkt, Spricht, Unterbrechen -----------
    await resetLogs();
    ctl.turnGate = deferred();
    ctl.speakSeconds = 8;
    await click("call");
    check("„Hört zu“ nach ready, roter Punkt", (await waitFor(inState("Hört zu"))) && (await js<boolean>(`document.getElementById("call-dot").getAttribute("data-mic") === "open"`)));
    check("Kopfhörer-Hinweis einmal pro Gerät", await js<boolean>(`!document.getElementById("call-hint").hidden`), await js<string>(`document.getElementById("call-hint-text").textContent`));
    await shootAll("telefonhoerer-hinweis");
    check("bei Stille verlässt kein Ton den Browser", (await pcmSent()) === 0, `${await pcmSent()} Stücke`);
    await click("call-hint-ok");
    check("„Verstanden“ blendet den Hinweis aus", await js<boolean>(`document.getElementById("call-hint").hidden`));
    await shootAll("telefonhoerer-hoert-zu");
    await click("call-mute");
    check("Stumm: Zustand „Stumm“, Spur aus, Strom offen, mute an den Server",
      (await waitFor(inState("Stumm"))) && (await js<boolean>(`!window.__streams.at(-1).getAudioTracks()[0].enabled && window.__streams.at(-1).getAudioTracks()[0].readyState === "live"`)) && (await sent()).some(m => m.type === "mute"));
    await shootAll("telefonhoerer-stumm");
    await click("call-mute");
    check("wieder „Hört zu“", await waitFor(inState("Hört zu")));
    check("Satz erkannt: Stücke, utterance_pause, utterance_end; „Denkt …“", await waitFor(inState("Denkt …"), 25000), (await js<any[]>(`window.__phases.map(p => p.text)`)).join(" → "));
    const types = (await sent()).map(m => m.type);
    const firstPcm = types.indexOf("pcm");
    check("Reihenfolge: Ton nur zwischen Beginn und Pause, dann utterance_pause und utterance_end",
      firstPcm > 0 && types.lastIndexOf("pcm") < types.indexOf("utterance_end") && types.includes("utterance_pause") && (await sent()).filter(m => m.type === "pcm").every(m => m.bytes === 640),
      `${types.filter(t => t === "pcm").length} Stücke zu 640 Bytes, dann ${types.filter(t => t !== "pcm").slice(-2).join(", ")}`);
    check("Server hat die Äußerung erkannt", ctl.recognized.length >= 1, ctl.recognized.map(b => `${(b / 32000).toFixed(2)} s`).join(", "));
    await shootAll("telefonhoerer-denkt");
    ctl.turnGate.resolve();
    ctl.turnGate = null;
    check("„Spricht“: Ton im Spieler, Satz erst mit dem Beginn der Wiedergabe", (await waitFor(inState("Spricht"), 8000)) && (await waitFor(`window.__player.some(m => m.type === "begin")`, 5000)));
    check("Zeilen: „Du: …“ und der erste Satz", await waitFor(`[...document.querySelectorAll("#call-lines .talk-line")].map(p => p.textContent).join("|").includes(${JSON.stringify(SEGMENTS[0]!)})`),
      await js<string>(`[...document.querySelectorAll("#call-lines .talk-line")].map(p => p.textContent).join(" | ")`));
    check("Mikrofon offen, während tybo spricht", await js<boolean>(`window.__streams.at(-1).getAudioTracks()[0].enabled && document.getElementById("call-dot").getAttribute("data-mic") === "open"`));
    await shootAll("telefonhoerer-spricht");
    const beforeTap = await js<number>(`window.__playerPosted.filter(m => m.type === "flush").length`);
    await js(`document.getElementById("call-panel").dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    check("Antippen: Wiedergabe sofort leer (flush), interrupt an den Server, „Hört zu“",
      (await waitFor(inState("Hört zu"))) && (await js<number>(`window.__playerPosted.filter(m => m.type === "flush").length`)) > beforeTap && (await sent()).some(m => m.type === "interrupt"));
    check("Server: Turn unterbrochen, nur Bestätigtes zählt", await (async () => {
      for (let i = 0; i < 50 && !ctl.records.length; i++) await Bun.sleep(40);
      return ctl.interrupts >= 1 && ctl.records.at(-1)?.interrupted === true;
    })(), JSON.stringify(ctl.records.at(-1)));
    await Bun.sleep(400);
    const afterTap = await js<any[]>(`(() => { const tap = window.__sent.find(m => m.type === "interrupt").at; return window.__player.filter(m => m.at > tap + 50); })()`);
    check("nach dem Unterbrechen kein Satz und kein Ton aus dem alten Turn", afterTap.length === 0 && !(await js<boolean>(`[...document.querySelectorAll("#call-lines .talk-line")].some(p => p.textContent.includes(${JSON.stringify(SEGMENTS[1]!)}))`)), JSON.stringify(afterTap));
    await hangUp("Gespräch");

    // --- Werkzeuge (Issue #259): „schaut nach …“ ---------------------------------------
    await resetLogs();
    ctl.search = true;
    ctl.searchGate = deferred();
    ctl.speakSeconds = 0.6;
    await click("call");
    check("Suche: erst „Moment, ich schaue nach.“, dann „schaut nach …“, solange das Werkzeug läuft",
      (await waitFor(`document.getElementById("call-step").textContent === "schaut nach …"`, 30000)) &&
        (await js<boolean>(`window.__recv.some(m => m.type === "sentence" && m.text === "Moment, ich schaue nach.")`)),
      (await js<any[]>(`window.__recv.filter(m => m.type !== "pcm").map(m => m.type + (m.name ? "(" + m.name + ")" : ""))`)).join(" → "));
    await shootAll("telefonhoerer-schaut-nach");
    ctl.searchGate.resolve();
    ctl.searchGate = null;
    check("Antwort nach der Suche", await waitFor(`[...document.querySelectorAll("#call-lines .talk-line")].some(p => p.textContent.includes("Salbeigrün"))`, 8000));
    check("nach der Antwort wieder „Hört zu“", await waitFor(inState("Hört zu"), 8000));
    ctl.search = false;

    // --- Werkzeuge: Freigabe-Zeile (im selben Gespräch; die Startbremse erlaubt 6 Anrufe in 10 Minuten) ---
    // Der Denkauftrag fragt per Werkzeug-Freigabe nach: neue Rückfrage im Gespräch, wie aus dem Register
    ctl.approval = true;
    for (const l of choiceListeners) l({ conversationId: talk.id, choice: APPROVAL, copyInDm: false, created: true, kind: "tool" });
    check("Freigabe-Zeile: Text und dieselben Knöpfe wie im Verlauf",
      await waitFor(`!document.getElementById("call-approval").hidden && document.querySelectorAll("#call-approval-choices .choice-button").length === 2`, 10000),
      await js<string>(`document.getElementById("call-approval").textContent.replace(/\\s+/g, " ").trim()`));
    check("tybo sagt einmal „Dafür brauche ich deine Freigabe …“",
      await waitFor(`window.__recv.filter(m => m.type === "sentence" && m.text === "Dafür brauche ich deine Freigabe, tipp bitte auf den Knopf.").length === 1`, 6000));
    await shootAll("telefonhoerer-freigabe");
    await js(`document.querySelector("#call-approval-choices .choice-button.primary").click()`);
    check("Knopf entscheidet per POST, die Zeile verschwindet", (await waitFor(`document.getElementById("call-approval").hidden`, 5000)) && ctl.decided.join() === "ok", ctl.decided.join());
    check("über den WebSocket ging für die Freigabe nichts hinaus", (await sent()).every(m => ["start", "pcm", "utterance_pause", "utterance_end", "played", "mute", "interrupt", "hangup"].includes(m.type)));
    await hangUp("Suche und Freigabe");

    // --- Verlauf nach einem Gespräch (Issue #260) -----------------------------------------
    await goto(`${front}/`);
    await openTalkConversation();
    check("Verlauf: Äußerung „am Telefon gesagt“, Antwort „Telefonhörer · claude-sonnet-5-5“, Meldung zum Ende",
      await waitFor(`(() => {
        const msgs = [...document.querySelectorAll("#chat-log .msg")];
        const said = msgs.filter(m => m.classList.contains("msg-user") && m.textContent.includes("am Telefon gesagt"));
        const replies = msgs.filter(m => m.classList.contains("msg-assistant") && m.textContent.includes("Telefonhörer · claude-sonnet-5-5"));
        const ended = msgs.filter(m => m.classList.contains("msg-notice") && /Telefongespräch, [0-9]+ (Sek|Min)[.]/.test(m.textContent));
        // Zwei Gespräche mit Äußerung; die Antwort im ersten wurde vor jeder Wiedergabe unterbrochen und fehlt deshalb
        return said.length >= 2 && replies.length >= 1 && ended.length >= 2;
      })()`, 8000),
      (await store.getMessages(talk.id)).map(m => `${m.role}${m.kind ? "/" + m.kind : ""}${m.call ? "/call" : ""}: ${m.text.slice(0, 50)}`).join(" | "));
    check("vor der Wiedergabe unterbrochene Antwort steht nicht im Verlauf (nur Gesprochenes)", (await store.getMessages(talk.id)).filter(m => m.call && m.role === "assistant").length === 1);
    check("ins Gedächtnis (Attrappe) gingen Äußerungen und Antworten", ctl.remembered.some(r => r.startsWith("user: ")) && ctl.remembered.some(r => r.startsWith("assistant: ")), `${ctl.remembered.length} Einträge`);
    await js(`(l => l.scrollTop = l.scrollHeight)(document.getElementById("chat-log"))`);
    await shootAll("telefonhoerer-verlauf");

    // --- Werkzeuge: Meldung nach dem Telefonat im Verlauf ---------------------------------
    const { callMemoryNotice } = await import("../src/web/bot-call");
    const notice = callMemoryNotice([{ goalsAdded: [], goalsCompleted: [], goalsCancelled: [], factsAdded: ["Frau Müller ruft am Dienstag zurück"], factsRemoved: [] }], 1)!;
    await store.appendMessage(talk.id, { role: "assistant", kind: "notice", source: "telefonhoerer", text: notice });
    await goto(`${front}/`);
    await openTalkConversation();
    check("Meldung „gemerkt“ im Verlauf mit Absender „Telefonhörer“",
      await waitFor(`[...document.querySelectorAll("#chat-log .msg")].some(m => m.textContent.includes("Gemerkt: Frau Müller ruft am Dienstag zurück") && m.textContent.includes("Telefonhörer"))`));
    await js(`(l => l.scrollTop = l.scrollHeight)(document.getElementById("chat-log"))`);
    await shootAll("telefonhoerer-gemerkt");

    // --- 3. Gespräch: Aufgelegt vom Server (Tagesbudget) ------------------------------
    await resetLogs();
    ctl.budget = true;
    ctl.speakSeconds = 0.6;
    await click("call");
    check("Aufgelegt mit Grund und Dauer", (await waitFor(inState("Aufgelegt"), 30000)) && (await noteText()) === "Das Tagesbudget für Sprache ist aufgebraucht.",
      `${await noteText()} ${await js<string>(`document.getElementById("call-time").textContent`)}`);
    check("nach dem Ende alles frei, „Noch einmal“ und „Schließen“",
      (await tracksEnded()) && (await contextsClosed()) && (await js<boolean>(`!document.getElementById("call-again").hidden && !document.getElementById("call-close").hidden && document.getElementById("call-hangup").hidden`)));
    await shootAll("telefonhoerer-aufgelegt");
    await click("call-close");
    check("Schließen bringt die Eingabebox zurück", await waitFor(`document.getElementById("call-panel").hidden && !document.getElementById("composer-box").hidden`));
    ctl.budget = false;

    // --- 4. Gespräch: Fehler beim Start, Noch einmal ----------------------------------
    await resetLogs();
    ctl.failOpen = true;
    await click("call");
    check("Fehler: Satz des Servers in Rot, „Noch einmal“", (await waitFor(inState("Fehler"))) && (await noteText()).startsWith("Der Telefonhörer ist gerade nicht bereit"), await noteText());
    await shootAll("telefonhoerer-fehler");
    ctl.failOpen = false;
    await click("call-again");
    check("„Noch einmal“ ruft erneut an", await waitFor(inState("Hört zu"), 8000));
    await hangUp("Noch einmal");

    // --- 5. Gespräch: Audio-Sitzung (Issue #280) ---------------------------------------
    // Chrome hat navigator.audioSession nicht: alle Gespräche oben liefen ohne Sitzung und ohne <audio>
    check("Chrome ohne Audio-Sitzung: alle Gespräche bisher ohne MediaStream-<audio>, kein Wert gesetzt",
      (await js<boolean>(`!("audioSession" in navigator) && window.__streamAudios.length === 0 && window.__sessionAt.every(e => e.type === null)`)),
      await js<string>(`("audioSession" in navigator) + ", " + window.__streamAudios.length + " <audio>, " + JSON.stringify(window.__sessionAt.slice(0, 2))`));
    await resetLogs();
    // Sechs Starts sind schon verbraucht: die Uhr des Prüfservers springt über das Zeitfenster
    callClockSkew += 11 * 60_000;
    await js(`window.__sessionAt.length = 0;
      window.__fakeSession = { sets: [], current: "auto", get type() { return this.current; }, set type(v) { this.sets.push(v); this.current = v; } };
      Object.defineProperty(navigator, "audioSession", { value: window.__fakeSession, configurable: true });`);
    await click("call");
    check("Attrappe navigator.audioSession: Tipp setzt play-and-record vor AudioContext und Mikrofon",
      (await waitFor(inState("Hört zu"), 10000)) && (await js<boolean>(`window.__fakeSession.type === "play-and-record" && window.__sessionAt.length === 2 && window.__sessionAt.every(e => e.type === "play-and-record")`)),
      `${await js<string>(`JSON.stringify(window.__sessionAt) + " " + window.__fakeSession.type`)} ${await noteText()}`);
    check("mit Audio-Sitzung: Ton über MediaStream in ein spielendes <audio>-Element",
      await js<boolean>(`window.__streamAudios.length === 1 && !window.__streamAudios[0].paused`));
    check("mit Audio-Sitzung: ganzer Turn, die Antwort läuft über diesen Weg bis played",
      (await waitFor(inState("Spricht"), 30000)) && (await waitFor(`window.__player.some(m => m.type === "played") && window.__sent.some(m => m.type === "played")`, 10000)),
      (await js<any[]>(`window.__phases.map(p => p.text)`)).join(" → "));
    await hangUp("Audio-Sitzung");
    check("Auflegen setzt die Sitzung auf den vorigen Wert zurück und hält <audio> an",
      await js<boolean>(`window.__fakeSession.type === "auto" && JSON.stringify(window.__fakeSession.sets) === '["play-and-record","auto"]' && window.__streamAudios[0].paused && window.__streamAudios[0].srcObject === null`),
      await js<string>(`JSON.stringify(window.__fakeSession.sets)`));
    await js(`delete navigator.audioSession; window.__streamAudios.length = 0;`);

    // --- Reiter „Sprechen“: Abschnitt pro Gerät ---------------------------------------
    await js(`location.hash = "#/einstellungen/sprechen"`);
    check("Reiter „Sprechen“: „Telefonhörer auf diesem Gerät“ mit „Ins Wort fallen“",
      await waitFor(`[...document.querySelectorAll(".settings-label")].some(n => n.textContent === "Telefonhörer auf diesem Gerät") && document.querySelector('[data-focus-key="call-device-barge:voice"]')`));
    await js(`document.querySelector('[data-focus-key="call-device-barge:tap"]').click()`);
    check("Umschalten speichert nur in localStorage", await waitFor(`JSON.parse(localStorage.getItem("tybo-call-device") || "{}").bargeIn === "tap"`));
    await js(`document.querySelector('[data-focus-key="call-device-barge:voice"]').click()`);

    // --- Reiter „Sprechen“: Abschnitt „Telefonhörer“ (Issue #260) --------------------------
    check("Abschnitt „Telefonhörer“: bereit mit Weg, Erwartung, Kosten, Auswahl mit Klartext",
      await waitFor(`(() => {
        const s = document.querySelector('section[aria-labelledby="settings-g-title-call"]');
        if (!s) return false;
        const t = s.textContent;
        const options = [...document.querySelectorAll("#settings-call-model option")].map(o => o.textContent);
        return t.includes("Telefonhörer bereit: Claude Sonnet 5.5 über deinen API-Schlüssel.") && t.includes("Kostet nach Verbrauch.") && options.includes("Claude Sonnet 5.5 über dein Claude-Abo") && options.includes("OpenRouter: anthropic/claude-sonnet-5.5 (nicht bereit)");
      })()`),
      await js<string>(`(s => s ? s.textContent.replace(/\s+/g, " ").slice(0, 300) : "kein Abschnitt")(document.querySelector('section[aria-labelledby="settings-g-title-call"]'))`));
    await js(`document.querySelector('section[aria-labelledby="settings-g-title-call"]').scrollIntoView()`);
    await shootAll("telefonhoerer-reiter-bereit");
    await js(`document.querySelector('[data-focus-key="call-probe"]').click()`);
    check("Probe: Median und Spanne mit Einordnung", await waitFor(`document.querySelector('section[aria-labelledby="settings-g-title-call"]').textContent.includes("Antwort beginnt nach 1,4 s (3 Proben: 1,1 bis 1,7 s), flüssig.")`, 5000) && ctl.probes === 1);
    await js(`document.querySelector('[data-focus-key="call-probe"]').scrollIntoView({ block: "center" })`);
    await shootAll("telefonhoerer-probe");

    // --- Reiter „Sprechen“: Erkennen im Gespräch, ElevenLabs Scribe (Issue #279) ---------------
    const callSection = `document.querySelector('section[aria-labelledby="settings-g-title-call"]')`;
    const pickStt = (value: string) => js(`(s => { s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); })(document.getElementById("settings-call-stt"))`);
    check("Erkennen im Gespräch: whisper.cpp nicht wählbar mit Grund, ElevenLabs Scribe wählbar",
      await waitFor(`(() => {
        const o = [...document.querySelectorAll("#settings-call-stt option")].map(x => x.textContent + (x.disabled ? ":aus" : ""));
        return o.length === 4 && o.some(t => t.startsWith("whisper.cpp") && t.endsWith(":aus")) && o.includes("ElevenLabs Scribe") && ${callSection}.textContent.includes("whisper.cpp: Modelldatei fehlt");
      })()`),
      (await js<string[]>(`[...document.querySelectorAll("#settings-call-stt option")].map(x => x.textContent + (x.disabled ? ":aus" : ""))`)).join(", "));
    await pickStt("elevenlabs");
    check("Scribe gewählt: vier Hinweise (Daten, Kosten, Schlüssel, Rückfall auf Parakeet), Speichern bereit",
      await waitFor(`document.querySelectorAll(".settings-call-scribe").length === 4 && ${callSection}.textContent.includes("Jede Äußerung im Gespräch geht als Aufnahme an ElevenLabs.") && ${callSection}.textContent.includes("erkennt Parakeet dieselbe Äußerung")`),
      await js<string>(`[...document.querySelectorAll(".settings-call-scribe")].map(n => n.textContent).join(" | ")`));
    await js(`document.getElementById("settings-call-stt").scrollIntoView({ block: "start" })`);
    await shootAll("telefonhoerer-erkennen-scribe");
    await pickStt("auto");
    check("zurück auf Automatisch: keine Scribe-Hinweise", await waitFor(`document.querySelectorAll(".settings-call-scribe").length === 0`));

    // --- Reiter „Sprechen“: Stimme im Gespräch, ElevenLabs und Hörprobe (Issue #276) ---------
    const pickTts = (value: string) => js(`(s => { s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); })(document.getElementById("settings-call-tts"))`);
    check("Stimme im Gespräch: Piper nicht wählbar mit Grund, ElevenLabs wählbar",
      await waitFor(`(() => {
        const o = [...document.querySelectorAll("#settings-call-tts option")].map(x => x.textContent + (x.disabled ? ":aus" : ""));
        return o.length === 5 && o.some(t => t.startsWith("Piper") && t.endsWith(":aus")) && o.includes("ElevenLabs") && ${callSection}.textContent.includes("Piper: Piper ist nicht installiert");
      })()`),
      (await js<string[]>(`[...document.querySelectorAll("#settings-call-tts option")].map(x => x.textContent + (x.disabled ? ":aus" : ""))`)).join(", "));
    await pickTts("elevenlabs");
    check("ElevenLabs gewählt: vier Hinweise (Kosten, Daten, Schlüssel, Rückfall), Stimmen-Kennung mit Vorschlag, Modell",
      await waitFor(`document.querySelectorAll(".settings-call-eleven").length === 4 && document.getElementById("settings-call-voice")?.placeholder === "beispielStimme01" && document.querySelectorAll("#settings-call-voice-model option").length === 4`),
      await js<string>(`[...document.querySelectorAll(".settings-call-eleven")].map(n => n.textContent).join(" | ")`));
    await js(`document.getElementById("settings-call-tts").scrollIntoView({ block: "start" })`);
    await shootAll("telefonhoerer-stimme-elevenlabs");
    await js(`document.querySelector('[data-focus-key="call-listen"]').click()`);
    check("Hörprobe: Abspielfeld mit dem Ton, kein Fehler",
      await waitFor(`!!document.querySelector(".settings-call-listen-audio") && !${callSection}.querySelector('[role="alert"]')`, 5000) && ctl.voiceProbes === 1);
    await js(`document.querySelector('[data-focus-key="call-listen"]').scrollIntoView({ block: "center" })`);
    await shootAll("telefonhoerer-hoerprobe");
    ctl.voiceProbeFail = true;
    await js(`document.querySelector('[data-focus-key="call-listen"]').click()`);
    check("Hörprobe ohne Rückfall: Fehler mit Grund statt Ersatzstimme",
      await waitFor(`[...${callSection}.querySelectorAll('[role="alert"]')].some(n => n.textContent === "ElevenLabs ist nicht verfügbar (ELEVENLABS_API_KEY fehlt).") && !document.querySelector(".settings-call-listen-audio")`, 5000) && ctl.voiceProbes === 2);
    await js(`document.querySelector('[data-focus-key="call-listen"]').scrollIntoView({ block: "center" })`);
    await shootAll("telefonhoerer-hoerprobe-fehler");
    ctl.voiceProbeFail = false;
    await pickTts("auto");
    check("zurück auf Automatisch: keine ElevenLabs-Felder", await waitFor(`!document.getElementById("settings-call-voice") && document.querySelectorAll(".settings-call-eleven").length === 0`));
    ctl.notReady = true;
    await js(`location.hash = ""`);
    await waitFor(`!location.hash`);
    await js(`location.hash = "#/einstellungen/sprechen"`);
    check("nicht bereit: Grund und nächster Schritt „tybo setup sprache“",
      await waitFor(`(s => !!s && s.textContent.includes("Telefonhörer nicht bereit: Hören: kein lokaler Erkenner") && s.textContent.includes("Nächster Schritt: im Terminal tybo setup sprache ausführen."))(document.querySelector('section[aria-labelledby="settings-g-title-call"]'))`, 8000));
    await js(`document.querySelector('section[aria-labelledby="settings-g-title-call"]').scrollIntoView()`);
    await shootAll("telefonhoerer-reiter-nicht-bereit");
    ctl.notReady = false;
    await js(`location.hash = ""`);
  } else if (TOOLS) {
    // --- Echtes Gespräch mit drei Werkzeug-Fragen (Issue #259) ---------------------------
    await resetLogs();
    const t0 = Date.now();
    await click("call");
    const listening = await waitFor(inState("Hört zu"), 120_000);
    const readyAfter = (Date.now() - t0) / 1000;
    check("„Hört zu“ nach ready (echter Anschluss), bevor die erste Frage beginnt", listening && readyAfter < LEAD_SECONDS - 1, `${readyAfter.toFixed(1)} s bis bereit, erste Frage ab ${LEAD_SECONDS} s`);
    const RESULT_READY = "Das Ergebnis vom Denkauftrag steht jetzt im Gespräch.";
    check("drei Fragen beantwortet, Ergebnis des Denkauftrags angesagt",
      await waitFor(`window.__recv.some(m => m.type === "sentence" && m.text === ${JSON.stringify(RESULT_READY)})`, 180_000),
      (await js<string[]>(`window.__recv.filter(m => m.type !== "pcm").map(m => m.type + (m.name ? "(" + m.name + ")" : ""))`)).join(" → "));
    const ACKS = ["Moment, ich schaue nach.", "Das arbeite ich in Ruhe aus und schreibe es dir ins Gespräch."];
    const turns = await js<any[]>(`(() => {
      const ACKS = ${JSON.stringify(ACKS)};
      const ends = window.__sent.filter(m => m.type === "utterance_end");
      const pcmAll = window.__sent.filter(m => m.type === "pcm");
      const ms = (a, b) => (a && b ? Math.round(b.at - a.at) : null);
      return ends.map((end, i) => {
        const prev = i ? ends[i - 1].at : 0;
        const next = ends[i + 1] ? ends[i + 1].at : Infinity;
        const pcm = pcmAll.filter(m => m.at > prev && m.at < end.at);
        const peak = Math.max(0, ...pcm.map(m => m.rms));
        const lastVoiced = [...pcm].reverse().find(m => m.rms >= peak / 10);
        const inTurn = m => m.at > end.at && m.at < next;
        const tool = window.__recv.find(m => m.type === "tool" && inTurn(m));
        const sentences = window.__recv.filter(m => m.type === "sentence" && inTurn(m) && m.text !== ${JSON.stringify(RESULT_READY)});
        const ack = sentences.find(s => ACKS.includes(s.text));
        const answer = sentences.find(s => !ACKS.includes(s.text));
        const begin = s => (s ? window.__player.find(p => p.type === "begin" && p.id === s.id) : null);
        return {
          tool: tool ? tool.name : null,
          transcript: (window.__recv.find(m => m.type === "transcript" && inTurn(m)) || {}).text || null,
          sentences: sentences.map(s => s.text),
          speechEndToToolMs: ms(lastVoiced, tool),
          speechEndToAckMs: ms(lastVoiced, begin(ack)),
          speechEndToAnswerMs: ms(lastVoiced, begin(answer)),
        };
      });
    })()`);
    const s = (v: number | null) => (v === null ? "–" : `${(v / 1000).toFixed(2)} s`);
    console.log(`\nMessung Werkzeuge (${VIA}):`);
    console.log("| Frage | Werkzeug | Sprachende bis Werkzeug-Beginn | Sprachende bis Ansage (Wiedergabe) | Sprachende bis Antwort (Wiedergabe) |");
    for (const [i, t] of turns.entries()) console.log(`| ${TOOL_QUESTIONS[i]?.kind ?? i + 1} | ${t.tool ?? "keins"} | ${s(t.speechEndToToolMs)} | ${s(t.speechEndToAckMs)} | ${s(t.speechEndToAnswerMs)} |`);
    for (const [i, t] of turns.entries()) console.log(`  Frage ${i + 1}: erkannt „${t.transcript}“; gesprochen: ${t.sentences.map((x: string) => `„${x}“`).join(" ")}`);
    console.log(`  Denkaufträge an den Chat-Kern: ${deepTasks.join(" | ") || "keiner"}`);
    for (const [i, kind] of TOOL_QUESTIONS.map(q => q.kind).entries()) check(`Frage ${i + 1}: Werkzeug ${kind}`, turns[i]?.tool === kind, turns[i]?.tool ?? "keins");
    check("Denkauftrag ging in das Gespräch des Telefonats, ohne Telegram", deepTasks.length === 1 && deepTasks[0]!.startsWith("ohne Telegram"), deepTasks.join(" | "));
    await waitFor(inState("Hört zu"), 30_000);
    await hangUp("Echtes Gespräch mit Werkzeugen");
  } else {
    // --- Echtes Gespräch ---------------------------------------------------------------
    await resetLogs();
    const t0 = Date.now();
    await click("call");
    const listening = await waitFor(inState("Hört zu"), 120_000);
    const readyAfter = (Date.now() - t0) / 1000;
    check("„Hört zu“ nach ready (echter Anschluss), bevor der Satz im Mikrofon beginnt", listening && readyAfter < LEAD_SECONDS - 1, `${readyAfter.toFixed(1)} s bis bereit, Satz ab ${LEAD_SECONDS} s`);
    const ready = await js<string>(`window.__recv.filter(m => m.type === "ready").length + " ready"`);
    console.log(`  ${ready}`);
    check("Äußerung erkannt und beantwortet", await waitFor(`window.__recv.some(m => m.type === "sentence")`, 90_000), (await js<string[]>(`window.__recv.map(m => m.type).filter(t => t !== "pcm")`)).join(" → "));
    const begun = await waitFor(`window.__player.some(m => m.type === "begin")`, 30_000);
    check("Wiedergabebeginn im Spieler-Worklet gemessen (Pocket TTS über den Server)", begun, begun ? "" : "keine Meldung begin binnen 30 s");
    const timing = await js<any>(`(() => {
      const end = window.__sent.find(m => m.type === "utterance_end");
      const pcm = window.__sent.filter(m => m.type === "pcm" && (!end || m.at < end.at));
      const peak = Math.max(0, ...pcm.map(m => m.rms));
      // Tatsächliches Sprachende: letztes Stück mit Pegel über einem Zehntel des lautesten
      const lastVoiced = [...pcm].reverse().find(m => m.rms >= peak / 10);
      const lastPcm = pcm[pcm.length - 1];
      const transcript = window.__recv.find(m => m.type === "transcript");
      const sentence = window.__recv.find(m => m.type === "sentence");
      const audio = window.__recv.find(m => m.type === "pcm" && end && m.at > end.at);
      const begin = window.__player.find(m => m.type === "begin");
      const context = window.__contexts[window.__contexts.length - 1];
      const ms = (a, b) => (a && b ? Math.round(b.at - a.at) : null);
      return {
        trailingSilenceMs: ms(lastVoiced, lastPcm),
        speechEndToUtteranceEndMs: ms(lastVoiced, end),
        recognizeMs: ms(end, transcript),
        speechEndToSentenceMs: ms(lastVoiced, sentence),
        speechEndToAudioMs: ms(lastVoiced, audio),
        speechEndToPlaybackMs: ms(lastVoiced, begin),
        outputLatencyMs: context ? Math.round(((context.baseLatency || 0) + (context.outputLatency || 0)) * 1000) : null,
      };
    })()`);
    console.log(`\nMessung (${VIA}): ${JSON.stringify(timing)}`);
    console.log("| Weg | Endstille im letzten Stück | Sprachende bis utterance_end | utterance_end bis transcript | Sprachende bis erster Satz | Sprachende bis erster Ton empfangen | Sprachende bis Wiedergabebeginn |");
    const s = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(2)} s`);
    console.log(`| ${VIA} | ${s(timing.trailingSilenceMs)} | ${s(timing.speechEndToUtteranceEndMs)} | ${s(timing.recognizeMs)} | ${s(timing.speechEndToSentenceMs)} | ${s(timing.speechEndToAudioMs)} | ${s(timing.speechEndToPlaybackMs)} |`);
    console.log(`Ausgabelatenz des AudioContext (baseLatency + outputLatency, nach dem Wiedergabebeginn): ${s(timing.outputLatencyMs)}`);
    check("Zeiten vollständig", timing.speechEndToPlaybackMs !== null && timing.speechEndToPlaybackMs > 0 && timing.recognizeMs !== null, JSON.stringify(timing));
    await waitFor(inState("Hört zu"), 30_000);
    await hangUp("Echtes Gespräch");
  }

  // --- Abschluss ------------------------------------------------------------------------
  const csp = problems.filter(p => /Content Security Policy|Refused/i.test(p));
  check("keine CSP-Verstöße (WebSocket, beide Worklets)", csp.length === 0, csp.join(" | "));
  const errors = problems.filter(p => !/Failed to load resource|Content Security Policy|Refused/i.test(p));
  check("keine Skriptfehler", errors.length === 0, errors.join(" | "));
} catch (e) {
  failures++;
  console.log(`FEHL Abbruch: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  ws.close();
  chrome.kill();
  await chrome.exited;
  ctl.openGate?.resolve();
  ctl.turnGate?.resolve();
  await server.stop({ graceMs: 200 });
  await rm(dir, { recursive: true, force: true });
}

const callLog = serverLog.filter(l => l.startsWith("Telefonhörer"));
if (callLog.length) console.log(`\nServer-Log (Telefonhörer):\n  ${callLog.join("\n  ")}`);
console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : "\nAlle Prüfungen bestanden");
process.exit(failures ? 1 : 0);
