/**
 * Pfad „Telefonhörer“ im Schritt „sprache“ (Issue #260, Entscheidung 0024):
 * prüft die Voraussetzungen, erklärt die Modellwege, misst auf diesem Gerät
 * und speichert den gewählten Weg.
 *
 * 1. Voraussetzungen aus dem Pfad „Sprechmodus lokal“: ein lokaler Erkenner
 *    (Parakeet mit bestandener Probe oder whisper.cpp). Fehlt er, verweist
 *    der Lauf dorthin und misst nichts. Stimme: Pocket TTS empfohlen, ohne
 *    sie spricht der Browser.
 * 2. Modellweg: das Feld SPRACHE_TELEFON_WEG wählt ihn vor der Probe
 *    (automatisch, API-Schlüssel, Claude-Abo, OpenRouter, Ollama). Plan und
 *    Ergebnis erklären Kosten und Wartezeit je Weg. Ohne bereiten Weg: klare
 *    Absage, es bleibt beim Sprechmodus, nichts wird gespeichert.
 * 3. Geräteprobe durch die ganze Kette, genau über den gewählten Weg: die
 *    Probe-Aufnahme aus setup/assets/ erkennen (Parakeet bzw. whisper.cpp),
 *    der erkannte Text geht als Frage ans Gehirn, der erste Abschnitt der
 *    Antwort an Pocket TTS; gemessen wird je Stufe (Erkennen, Antwort
 *    beginnt, erster Ton) nach dem Laden wie beim Abheben. Ohne Pocket
 *    spricht der Browser, der erste Ton ist dann nicht messbar.
 *    Danach drei Testfragen ans Gehirn (Antwort beginnt nach …, Median und
 *    Spanne, Einordnung wie im Reiter „Sprechen“).
 * 4. Speichern: speech.call.model (und claudeVia) für genau diesen Weg über
 *    updateSettings() mit dem Pfad des Assistenten; „Automatisch“ lässt einen
 *    leeren Wert leer, außer SPEECH_CALL_MODEL in der .env wählt einen festen
 *    Weg: dann wird auto ausdrücklich gespeichert (die Datei geht vor), damit
 *    gilt, was gemessen wurde. Hinweis auf HTTPS fürs Handy (tybo setup zugang).
 *
 * Alles läuft über SetupContext: Umgebung aus der .env des Assistenten,
 * Einstellungen aus ctx.settingsPath; Wege, Probe und Erkennen lassen sich
 * über ctx.callSetup ersetzen (Tests, Browser-Durchlauf). Logs und
 * Ergebnistexte nennen nie Schlüssel.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { BRAND } from "../brand";
import { settingsSchema, SettingsFileInvalidError, updateSettings, type Settings } from "../lib/settings";
import type { PocketServer } from "../lib/speech/pocket";
import type { WarmStt } from "../lib/speech/types";
import type { CallWay, CallWayId } from "../lib/voice-brain/call-model";
import { CALL_PROBE_RUNS, summarizeProbe, type CallProbeResult } from "../web/call-probe";
import { readSetupEnv, type SetupContext } from "./context";
import type { ApplyResult, RunReport, SetupField, SetupValues } from "./model";
import { PROBE_WAV } from "./parakeet-probe";

export const CALL_WAY_FIELD = "SPRACHE_TELEFON_WEG";
/** Nur intern (existingFieldValues): Wege und Voraussetzungen für den Plan */
export const CALL_INVENTORY = "SPRACHE_TELEFON_BESTAND";

export type CallWayChoice = "auto" | CallWayId;
export const CALL_WAY_CHOICES: readonly CallWayChoice[] = ["auto", "api", "cli", "openrouter", "ollama"];

export const CALL_WAY_LABELS: Record<CallWayChoice, string> = {
  auto: "Automatisch: der erste bereite Weg (API-Schlüssel, dann Claude-Abo, dann OpenRouter)",
  api: "Claude Sonnet 5.5 über VOICE_ANTHROPIC_API_KEY: gleichmäßig, kostet pro Turn",
  cli: "Claude Sonnet 5.5 über dein Claude-Abo (Claude Code): keine Zusatzkosten außer Guthaben, einzelne Antworten langsamer",
  openrouter: "OpenRouter: kostet pro Turn, nur mit wenig Vordenken flüssig",
  ollama: "Ollama auf diesem Rechner: kostenlos, aber zäh",
};

/** Erklärung je Weg für Plan und Ergebnis (aus der Messung vom 30.09.2026) */
export const CALL_WAY_NOTES: Record<CallWayId, string> = {
  api: "API-Schlüssel (VOICE_ANTHROPIC_API_KEY): am gleichmäßigsten, rund 1,5 s bis zum ersten Satz, kostet pro Turn (gemessen rund 0,02 $ ohne Zwischenspeicher).",
  cli: "Claude-Abo über Claude Code: keine Zusatzkosten außer dem Agent-SDK-Guthaben des Abos, meist rund 1,5 s, bei Überlegfragen 3 bis 5 s.",
  openrouter: "OpenRouter: kostet pro Turn, mit wenig Vordenken rund 1,6 s, ohne deutlich langsamer.",
  ollama: "Ollama: läuft auf diesem Rechner und kostet nichts, ist aber zäh (rund 3 s, mit Denkphase unbrauchbar).",
};

/** Sprechpause, nach der der Telefonhörer eine Äußerung als beendet nimmt */
const CALL_PAUSE_MS = 800;

export const CALL_SPEECH_STAYS = "Es bleibt beim Sprechmodus: jede Frage ist ein voller Turn mit allen Werkzeugen, nur langsamer.";
export const CALL_HTTPS_HINT = `Fürs Handy braucht der Telefonhörer HTTPS (Mikrofon im Browser): ${BRAND.cli} setup zugang.`;

export function isCallWayChoice(v: unknown): v is CallWayChoice {
  return typeof v === "string" && (CALL_WAY_CHOICES as readonly string[]).includes(v);
}

const isCallPath = (v: SetupValues) => v.SPRACHE_WEG === "telefon";

export function callFields(): SetupField[] {
  return [
    {
      name: CALL_WAY_FIELD,
      label: "Modellweg für den Telefonhörer",
      kind: "choice",
      default: "auto",
      choices: CALL_WAY_CHOICES.map(value => ({ value, label: CALL_WAY_LABELS[value] })),
      help: "Über welchen Weg das Gehirn im Gespräch antwortet. Die Probe misst genau diesen Weg, danach wird er gespeichert. Ein Weg, der nicht bereit ist, wird nicht gespeichert.",
      visible: isCallPath,
      validate: value => (isCallWayChoice(value) ? null : "Unbekannte Auswahl."),
    },
  ];
}

// ---------------------------------------------------------------------------
// Bestandsaufnahme
// ---------------------------------------------------------------------------

export interface CallSetupInventory {
  /** Lokaler Erkenner bereit: Parakeet (Probe bestanden) oder whisper.cpp */
  stt: "parakeet" | "whisper" | null;
  /** Pocket TTS eingerichtet */
  pocket: boolean;
  /** Eingestellt: speech.call.model und claudeVia */
  setting: { model: string | null; claudeVia: "api" | "cli" | null };
  /** Gültiges SPEECH_CALL_MODEL aus der .env (gilt, wenn die Datei kein Modell nennt) */
  envModel?: string | null;
  settingsValid: boolean;
  ways: CallWay[];
}

/**
 * Stufen der Geräteprobe (runDeviceProbe). Jede Stufe wirft bei Fehlern;
 * Meldungen nennen nie Texte oder Schlüssel.
 */
export interface DeviceProbePorts {
  /** Laden wie beim Abheben (Erkenner, Stimme), nicht in den Stufenzeiten */
  prepare?(signal: AbortSignal): Promise<void>;
  /** Probe-Aufnahme erkennen: der erkannte Text */
  recognize(signal: AbortSignal): Promise<string>;
  /** Der erkannte Text als Frage über genau den gewählten Weg: erster sprechbarer Abschnitt der Antwort */
  answer(text: string, signal: AbortSignal): Promise<string>;
  /** Abschnitt mit der lokalen Stimme; erfüllt, sobald der erste Ton da ist. Fehlt: Browser-Stimme */
  speak?(text: string, signal: AbortSignal): Promise<void>;
  /** Prozesse und Ströme beenden; immer am Ende */
  close(): void;
}

export type DeviceStage = "laden" | "erkennen" | "antwort" | "stimme";

export type DeviceProbeResult =
  | { ok: true; prepareMs: number; recognizeMs: number; answerMs: number; toneMs: number | null }
  | { ok: false; stage: DeviceStage; message: string; recognizeMs?: number; answerMs?: number };

/** Ersetzbare Teile (Tests, Browser-Durchlauf); fehlen sie, die echten aus src/lib */
export interface CallSetupDeps {
  ways(o: { env: Record<string, string | undefined>; settings: Settings }): Promise<CallWay[]>;
  /** Drei Testfragen über genau diesen Weg (runs 1) */
  probe(o: { way: CallWay; env: Record<string, string | undefined>; settings: Settings; signal: AbortSignal }): Promise<CallProbeResult>;
  /** Stufen der Geräteprobe für genau diesen Weg, Erkenner und (mit pocket) die lokale Stimme */
  device(o: { ctx: SetupContext; way: CallWay; env: Record<string, string | undefined>; settings: Settings; stt: "parakeet" | "whisper"; pocket: boolean }): DeviceProbePorts;
  /** Uhr der Stufenzeiten in Millisekunden (Standard performance.now) */
  now?: () => number;
}

function readSettings(path: string): { ok: true; settings: Settings } | { ok: false } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: true, settings: {} };
  }
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { ok: true, settings: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Kurzer, neutraler Kontext für die Probe: keine echten Daten, Sprechstil wie im Gespräch */
async function probeSystem(): Promise<string> {
  const { voiceStyle } = await import("../lib/voice-brain/style");
  const { voiceAgentName } = await import("../lib/voice-agent-name");
  const intro = `Du bist ${BRAND.name}, ein persönlicher Assistent. Das ist eine Probe der Einrichtung, der Nutzer hört zu.`;
  return [intro, voiceStyle({ agentName: voiceAgentName(), channel: "call" })].join("\n\n");
}

/** Einstellungen, in denen genau dieser Weg eingestellt ist */
function settingsForWay(settings: Settings, way: CallWay): Settings {
  const call = { ...(settings.speech?.call ?? {}), model: way.model, ...(way.claudeVia ? { claudeVia: way.claudeVia } : {}) };
  if (!way.claudeVia) delete (call as { claudeVia?: string }).claudeVia;
  return { ...settings, speech: { ...(settings.speech ?? {}), call } };
}

/** Fehler einer Stufe der Geräteprobe mit einer Meldung, die ins Ergebnis darf (nie Inhalte) */
export class DeviceProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceProbeError";
  }
}

/** Kurzform eines Fehlers fürs Ergebnis: nie Inhalte */
function errorText(e: unknown): string {
  if (e instanceof DeviceProbeError) return e.message;
  if (e instanceof Error && e.name === "BrainError") return e.message;
  if (e instanceof Error && e.name === "SpeechError") return e.message;
  return e instanceof Error ? e.name : "Fehler";
}

/**
/** Auflösung und Weg für die Antwort-Stufe der Geräteprobe */
export interface DeviceBrain {
  resolve: typeof import("../lib/voice-brain/call-model").resolveCallModel;
  createBackend: typeof import("../lib/voice-brain/call-model").createCallBackend;
}

/** Schon abgebrochen: die Stufe endet, bevor etwas gebaut oder gefragt wird */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DeviceProbeError("abgebrochen");
}

/**
 * Echte Stufen der Geräteprobe: Anbieter aus src/lib/speech mit Umgebung und
 * Projektordner des Assistenten, Gehirn über createCallBackend und
 * runVoiceTurn wie im Gespräch. Pocket und Parakeet werden in prepare
 * geladen (wie beim Abheben), close beendet ihre Prozesse.
 *
 * brain ersetzt Auflösung und Weg (Tests); Standard aus call-model.ts.
 */
export function realDevice(
  o: { ctx: SetupContext; way: CallWay; env: Record<string, string | undefined>; settings: Settings; stt: "parakeet" | "whisper"; pocket: boolean },
  brain?: DeviceBrain,
): DeviceProbePorts {
  const pocketServers: PocketServer[] = [];
  let warmStt: WarmStt | null = null;
  const closers: Array<() => void> = [];
  const providerDeps = async () => {
    const { realProviderDeps } = await import("../lib/speech");
    return { ...realProviderDeps, env: () => o.env, cwd: () => o.ctx.root, onPocketServer: (s: PocketServer) => void pocketServers.push(s) };
  };
  const sttProvider = async () => {
    const { createSttProviders } = await import("../lib/speech/providers");
    const p = createSttProviders(await providerDeps()).find(x => x.id === (o.stt === "parakeet" ? "parakeet" : "whisper-cpp"));
    if (!p) throw new DeviceProbeError("Erkenner fehlt");
    return p;
  };
  const pocketProvider = async () => {
    const { createTtsProviders } = await import("../lib/speech/providers");
    const p = createTtsProviders(await providerDeps()).find(x => x.id === "pocket");
    if (!p?.synthesizeStream) throw new DeviceProbeError("Pocket TTS fehlt");
    return p;
  };
  let tts: Awaited<ReturnType<typeof pocketProvider>> | null = null;
  return {
    async prepare(signal) {
      const stt = await sttProvider();
      if (stt.warm && stt.canWarm?.()) warmStt = await stt.warm();
      if (o.pocket) {
        tts = await pocketProvider();
        await tts.warm?.({ signal });
      }
    },
    async recognize(signal) {
      const audio = await readFile(PROBE_WAV);
      const opts = { language: "de", signal };
      return warmStt ? warmStt.transcribe(audio, "audio/wav", opts) : (await sttProvider()).transcribe(audio, "audio/wav", opts);
    },
    async answer(text, signal) {
      throwIfAborted(signal);
      let use: DeviceBrain;
      if (brain) use = brain;
      else {
        const m = await import("../lib/voice-brain/call-model");
        use = { resolve: m.resolveCallModel, createBackend: m.createCallBackend };
      }
      const { resolve, createBackend } = use;
      const { runVoiceTurn } = await import("../lib/voice-brain/turn");
      const resolution = await resolve({ env: o.env, settings: settingsForWay(o.settings, o.way) });
      // Abbruch während der Auflösung oder des Kontexts: kein Weg wird gebaut, keine Frage gestellt
      throwIfAborted(signal);
      if (!resolution.ready) throw new DeviceProbeError(resolution.reason ?? "Weg nicht bereit");
      const system = await probeSystem();
      throwIfAborted(signal);
      // Nach dem ersten Abschnitt endet der Turn: mehr braucht die Stimme nicht.
      // Das Signal ist gekoppelt, bevor der Weg gebaut wird
      const turn = new AbortController();
      const onAbort = () => turn.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) turn.abort();
      const backend = createBackend(resolution, { env: o.env });
      closers.push(() => backend.close?.());
      try {
        for await (const event of runVoiceTurn({ backend, system, history: [], userText: text, signal: turn.signal })) {
          if (event.type === "segment" && event.text.trim()) {
            turn.abort();
            return event.text;
          }
          if (event.type === "error") throw new DeviceProbeError(event.message);
        }
        throw new DeviceProbeError("keine Antwort");
      } finally {
        signal.removeEventListener("abort", onAbort);
        backend.close?.();
      }
    },
    ...(o.pocket
      ? {
          async speak(text: string, signal: AbortSignal) {
            tts ??= await pocketProvider();
            const stream = new AbortController();
            const onAbort = () => stream.abort();
            signal.addEventListener("abort", onAbort, { once: true });
            try {
              // Erster Ton: das erste Stück PCM, danach endet die Ausgabe
              for await (const chunk of tts.synthesizeStream!(text, { language: "de", signal: stream.signal })) {
                if (chunk.byteLength) return;
              }
              throw new DeviceProbeError("kein Ton");
            } finally {
              stream.abort();
              signal.removeEventListener("abort", onAbort);
            }
          },
        }
      : {}),
    close() {
      for (const c of closers) {
        try {
          c();
        } catch {}
      }
      try {
        warmStt?.close();
      } catch {}
      for (const s of pocketServers) s.stop();
    },
  };
}

/**
 * Geräteprobe: Laden, dann die Probe-Aufnahme erkennen, den erkannten Text
 * als Frage über den Weg, den ersten Abschnitt der Antwort mit der Stimme.
 * Zeiten je Stufe; wirft nie, close() immer.
 */
export async function runDeviceProbe(ports: DeviceProbePorts, signal: AbortSignal, now: () => number = () => performance.now()): Promise<DeviceProbeResult> {
  let stage: DeviceStage = "laden";
  let recognizeMs: number | undefined;
  let answerMs: number | undefined;
  try {
    const t0 = now();
    await ports.prepare?.(signal);
    const prepareMs = now() - t0;
    if (signal.aborted) return { ok: false, stage, message: "abgebrochen" };
    stage = "erkennen";
    const t1 = now();
    const heard = (await ports.recognize(signal)).trim();
    recognizeMs = now() - t1;
    if (signal.aborted) return { ok: false, stage, message: "abgebrochen" };
    if (!heard) return { ok: false, stage, message: "nichts erkannt", recognizeMs };
    stage = "antwort";
    const t2 = now();
    const first = (await ports.answer(heard, signal)).trim();
    answerMs = now() - t2;
    if (signal.aborted) return { ok: false, stage, message: "abgebrochen", recognizeMs };
    if (!first) return { ok: false, stage, message: "keine Antwort", recognizeMs };
    if (!ports.speak) return { ok: true, prepareMs, recognizeMs, answerMs, toneMs: null };
    stage = "stimme";
    const t3 = now();
    await ports.speak(first, signal);
    const toneMs = now() - t3;
    if (signal.aborted) return { ok: false, stage, message: "abgebrochen", recognizeMs, answerMs };
    return { ok: true, prepareMs, recognizeMs, answerMs, toneMs };
  } catch (e) {
    return {
      ok: false,
      stage,
      message: signal.aborted ? "abgebrochen" : errorText(e),
      ...(recognizeMs !== undefined ? { recognizeMs } : {}),
      ...(answerMs !== undefined ? { answerMs } : {}),
    };
  } finally {
    try {
      ports.close();
    } catch {}
  }
}

/** Echte Wege und Probe: src/lib/voice-brain/call-model.ts mit Umgebung und Einstellungen des Assistenten */
export const realCallSetup: CallSetupDeps = {
  async ways({ env, settings }) {
    const { callWays } = await import("../lib/voice-brain/call-model");
    return callWays({ env, settings });
  },
  async probe({ way, env, settings, signal }) {
    const { probeCallModel, resolveCallModel } = await import("../lib/voice-brain/call-model");
    const resolution = await resolveCallModel({ env, settings: settingsForWay(settings, way) });
    if (!resolution.ready) return { ok: false, reason: resolution.reason ?? "Weg nicht bereit" };
    try {
      // Abbruch der Einrichtung beendet die laufende Testfrage und schließt den Weg
      const result = await probeCallModel({ resolution, runs: CALL_PROBE_RUNS, system: await probeSystem(), backendOptions: { env }, signal });
      return summarizeProbe(result);
    } catch (e) {
      if (signal.aborted) return { ok: false, reason: "abgebrochen" };
      return { ok: false, reason: e instanceof Error && e.name === "BrainError" ? e.message : "Die Probe ist gescheitert." };
    }
  },
  device: realDevice,
};

export async function callSetupInventory(ctx: SetupContext, deps: CallSetupDeps = ctx.callSetup ?? realCallSetup): Promise<CallSetupInventory> {
  const env = await readSetupEnv(ctx);
  const { speechInventory } = await import("./steps/speech");
  const speech = await speechInventory(ctx);
  const read = readSettings(ctx.settingsPath);
  const settings = read.ok ? read.settings : {};
  const c = settings.speech?.call;
  const { callModelSetting } = await import("../lib/voice-brain/call-model");
  const fromEnv = callModelSetting({}, env);
  let ways: CallWay[] = [];
  try {
    ways = await deps.ways({ env, settings });
  } catch {
    ways = [];
  }
  return {
    stt: speech.proof.ok ? "parakeet" : speech.whisper ? "whisper" : null,
    pocket: speech.voice.pocket.ok,
    setting: { model: c?.model ?? null, claudeVia: c?.claudeVia ?? null },
    envModel: fromEnv.source === "env" ? fromEnv.setting : null,
    settingsValid: read.ok,
    ways,
  };
}

/** SPEECH_CALL_MODEL wählt einen festen Weg und die Datei nennt kein Modell: dann gilt die .env */
function envDecides(inv: CallSetupInventory): boolean {
  return !inv.setting.model && !!inv.envModel && inv.envModel !== "auto";
}

/** Vorauswahl im Feld: der wirksame Weg (Datei, sonst SPEECH_CALL_MODEL), sonst automatisch */
export function callWayPreselect(inv: CallSetupInventory): CallWayChoice {
  const { claudeVia } = inv.setting;
  const model = inv.setting.model ?? inv.envModel ?? null;
  if (!model || model === "auto") return "auto";
  const way = inv.ways.find(w => w.model === model && (!w.claudeVia || w.claudeVia === claudeVia));
  return way ? way.id : "auto";
}

/** Gewählter Weg: bei automatisch der erste bereite in der Reihenfolge API, Abo, OpenRouter (nie Ollama) */
export function chosenWay(inv: CallSetupInventory, choice: CallWayChoice): CallWay | null {
  if (choice === "auto") return inv.ways.find(w => w.ready && w.id !== "ollama") ?? null;
  return inv.ways.find(w => w.id === choice) ?? null;
}

export function parseCallInventory(values: SetupValues): CallSetupInventory | null {
  try {
    return values[CALL_INVENTORY] ? (JSON.parse(values[CALL_INVENTORY]) as CallSetupInventory) : null;
  } catch {
    return null;
  }
}

function sttText(inv: CallSetupInventory): string {
  if (inv.stt === "parakeet") return "Hören: Parakeet ist eingerichtet.";
  if (inv.stt === "whisper") return "Hören: whisper.cpp ist da (Parakeet wäre schneller).";
  return `Hören: kein lokaler Erkenner. Erst den Weg „Sprechmodus lokal“ in ${BRAND.cli} setup sprache ausführen, dann diesen.`;
}

function voiceText(inv: CallSetupInventory): string {
  return inv.pocket
    ? "Stimme: Pocket TTS ist eingerichtet und spricht im Gespräch, Satz für Satz."
    : "Stimme: Pocket TTS empfohlen (Weg „Sprechmodus lokal“, Stimme Pocket TTS). Ohne sie spricht der Browser, ins Wort fallen geht dann nur per Antippen.";
}

/** Plan vor dem Lauf: Voraussetzungen, Wege mit Bereitschaft, was gemessen und gespeichert wird */
export function callPlan(values: SetupValues): string[] {
  const inv = parseCallInventory(values);
  if (!inv) return ["Bestandsaufnahme für den Telefonhörer nicht möglich."];
  const choice = isCallWayChoice(values[CALL_WAY_FIELD]) ? (values[CALL_WAY_FIELD] as CallWayChoice) : callWayPreselect(inv);
  const out = [sttText(inv), voiceText(inv)];
  for (const w of inv.ways) out.push(`${w.ready ? "Bereit" : "Nicht bereit"}: ${w.label}${w.ready ? "" : ` (${w.reason ?? "nicht bereit"})`}. ${CALL_WAY_NOTES[w.id]}`);
  if (!inv.stt) {
    out.push("Ohne lokalen Erkenner wird nichts gemessen und nichts gespeichert.");
    return out;
  }
  const way = chosenWay(inv, choice);
  if (!way || !way.ready) {
    out.push(choice === "auto" ? `Kein Weg ist bereit. ${CALL_SPEECH_STAYS}` : `Der gewählte Weg ist nicht bereit${way?.reason ? `: ${way.reason}` : ""}. ${CALL_SPEECH_STAYS}`);
    return out;
  }
  const chain = `${inv.stt === "parakeet" ? "Parakeet" : "whisper.cpp"}, das Modell${inv.pocket ? " und Pocket TTS" : ""}`;
  out.push(`Gemessen wird ${way.label}: die Probe-Aufnahme geht durch ${chain} (Zeit je Stufe), dann drei Testfragen ans Modell${way.billing === "anthropic-api" || way.billing === "openrouter" ? " (kostet ein paar Cent)" : way.billing === "subscription" ? " (zählt gegen das Guthaben des Abos)" : ""}, danach wird der Weg gespeichert.`);
  out.push(CALL_HTTPS_HINT);
  return out;
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

function secondsText(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toFixed(1).replace(".", ",")} s`;
}

const STAGE_TEXT: Record<DeviceStage, string> = { laden: "Laden", erkennen: "Erkennen", antwort: "Antwort", stimme: "Stimme" };

/** Ergebnis der Geräteprobe in einem Satz: Stufenzeiten bzw. die Stufe, an der es scheiterte */
function deviceText(d: DeviceProbeResult, sttName: string): string {
  if (!d.ok) {
    const done = [d.recognizeMs !== undefined ? `Erkennen ${secondsText(d.recognizeMs)}` : null, d.answerMs !== undefined ? `Antwort beginnt nach ${secondsText(d.answerMs)}` : null].filter(Boolean);
    return `Geräteprobe gescheitert bei „${STAGE_TEXT[d.stage]}“ (${d.message})${done.length ? `, gemessen: ${done.join(", ")}` : ""}.`;
  }
  const tone = d.toneMs !== null ? `, erster Ton nach ${secondsText(d.toneMs)} (Pocket TTS)` : ", erster Ton: die Browser-Stimme spricht, auf dem Server nicht messbar";
  const sum = d.recognizeMs + d.answerMs + (d.toneMs ?? 0);
  const total = `Vom Ende deiner Äußerung bis zum ${d.toneMs !== null ? "ersten Ton" : "ersten Abschnitt"}: ${secondsText(sum + CALL_PAUSE_MS)} (${secondsText(CALL_PAUSE_MS)} Sprechpause plus die gemessenen Stufen).`;
  return `Geräteprobe auf diesem Gerät mit der Probe-Aufnahme: Erkennen ${secondsText(d.recognizeMs)} (${sttName}), Antwort beginnt nach ${secondsText(d.answerMs)}${tone}; geladen in ${secondsText(d.prepareMs)} wie beim Abheben. ${total}`;
}

/** Ablauf „Telefonhörer“; wirft nie */
export async function runCallSetup(values: SetupValues, ctx: SetupContext, report: RunReport, signal: AbortSignal): Promise<ApplyResult> {
  const deps = ctx.callSetup ?? realCallSetup;
  const inv = await callSetupInventory(ctx, deps);
  const changed: string[] = [];
  if (signal.aborted) return { ok: false, message: "Abgebrochen. Nichts wurde geändert.", changed };
  if (!inv.stt) {
    return { ok: false, message: `Der Telefonhörer braucht einen lokalen Erkenner. Erst den Weg „Sprechmodus lokal“ in ${BRAND.cli} setup sprache ausführen. Es wurde nichts gemessen und nichts gespeichert.`, changed };
  }
  const choice = isCallWayChoice(values[CALL_WAY_FIELD]) ? (values[CALL_WAY_FIELD] as CallWayChoice) : callWayPreselect(inv);
  const way = chosenWay(inv, choice);
  if (!way || !way.ready) {
    const why = !way ? "Kein Weg für den Telefonhörer ist bereit" : `${way.label} ist nicht bereit${way.reason ? ` (${way.reason})` : ""}`;
    return { ok: false, message: `${why}. ${CALL_SPEECH_STAYS} Nichts wurde gespeichert.`, changed };
  }

  const env = await readSetupEnv(ctx);
  const read = readSettings(ctx.settingsPath);
  if (!read.ok) return { ok: false, message: "config/settings.json ist ungültig. Bitte erst reparieren oder in der WebUI neu speichern; nichts wurde gemessen.", changed };
  const total = 3;
  let at = 0;
  const lines: string[] = [];
  const now = deps.now ?? (() => performance.now());

  // Stufe 1: Geräteprobe durch die ganze Kette (Erkennen, Modell, Stimme)
  const sttName = inv.stt === "parakeet" ? "Parakeet" : "whisper.cpp";
  report({ at: ++at, total, label: `Probe: Probe-Aufnahme durch ${sttName}, ${way.label}${inv.pocket ? " und Pocket TTS" : ""}` });
  const device = await runDeviceProbe(deps.device({ ctx, way, env, settings: read.settings, stt: inv.stt, pocket: inv.pocket }), signal, now);
  if (signal.aborted) return { ok: false, message: "Abgebrochen. Nichts wurde gespeichert.", changed };
  lines.push(deviceText(device, sttName));

  // Stufe 2: drei Testfragen über genau diesen Weg
  report({ at: ++at, total, label: `Probe: drei Testfragen über ${way.label}` });
  let probe: CallProbeResult;
  try {
    probe = await deps.probe({ way, env, settings: read.settings, signal });
  } catch {
    probe = { ok: false, reason: "Die Probe ist gescheitert." };
  }
  if (signal.aborted) return { ok: false, message: "Abgebrochen. Nichts wurde gespeichert.", changed };
  if (!probe.ok) {
    return { ok: false, message: `${lines.join(" ")} Probe über ${way.label}: ${probe.reason} Ohne Messwert wird nichts gespeichert. ${CALL_SPEECH_STAYS}`, changed };
  }
  lines.push(`Drei Testfragen: ${probe.text}. Kein Advanced Voice Mode.`);

  // Speichern: genau dieser Weg. Automatisch lässt einen leeren Wert leer, außer
  // SPEECH_CALL_MODEL wählt einen festen Weg: dann auto ausdrücklich, sonst gälte die .env statt der Messung
  report({ at: ++at, total, label: "Einstellung für den Telefonhörer" });
  if (signal.aborted) return { ok: false, message: `${lines.join(" ")} Abgebrochen. Nichts wurde gespeichert.`, changed };
  let saved: string;
  const next =
    choice === "auto"
      ? { model: inv.setting.model === null && !envDecides(inv) ? null : "auto", claudeVia: null }
      : { model: way.model, claudeVia: way.claudeVia ?? null };
  if (next.model === inv.setting.model && next.claudeVia === inv.setting.claudeVia) {
    saved = choice === "auto" ? "Der Telefonhörer wählt den Weg weiter automatisch." : `Der Telefonhörer nutzt schon ${way.label}.`;
  } else {
    try {
      await updateSettings(
        s => {
          const { claudeVia: _v, model: _m, ...rest } = s.speech?.call ?? {};
          const call = { ...rest, ...(next.model ? { model: next.model } : {}), ...(next.claudeVia ? { claudeVia: next.claudeVia } : {}) };
          const { call: _c, ...speech } = s.speech ?? {};
          return { ...s, speech: { ...speech, ...(Object.keys(call).length ? { call } : {}) } };
        },
        { path: ctx.settingsPath },
      );
      changed.push(ctx.settingsPath);
      saved =
        choice === "auto"
          ? `Der Telefonhörer wählt den Weg jetzt automatisch${envDecides(inv) ? " (gespeichert als auto, SPEECH_CALL_MODEL in der .env gilt damit nicht mehr)" : ""}.`
          : `Der Telefonhörer nutzt jetzt ${way.label}; der Bot liest das beim nächsten Anruf, ohne Neustart.`;
    } catch (e) {
      const why = e instanceof SettingsFileInvalidError ? "config/settings.json ist ungültig" : "config/settings.json ließ sich nicht schreiben";
      return { ok: false, message: `${lines.join(" ")} ${why}; der Weg ist nicht gespeichert.`, changed };
    }
  }
  const billing = way.billing === "subscription" ? " Zählt gegen das Agent-SDK-Guthaben deines Abos." : way.billing === "anthropic-api" || way.billing === "openrouter" ? " Kostet pro Turn." : "";
  return { ok: true, message: [...lines, `${saved}${billing}`, CALL_HTTPS_HINT].join(" "), changed };
}
