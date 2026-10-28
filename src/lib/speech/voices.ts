/**
 * Eigene Stimmen (Issue #253, Entscheidung 0023): Ablage der Referenz zum
 * Klonen, nur lokal unter data/speech/voices/<id>/, nie in Telegram, nie in
 * Git (data/ ist ignoriert).
 *
 * Je Stimme ein Ordner (Rechte 0700) mit vier Dateien (Rechte 0600):
 * - reference.wav: die Aufnahme, vom Server neu geschrieben (PCM16 mono,
 *   nur Kopf und Abtastwerte, keine Metadaten des Browsers)
 * - text.txt: der vorgelesene Text (fest, VOICE_READING_TEXT)
 * - consent.json: Einwilligung mit Wortlaut, Zeitpunkt und Gerät
 * - meta.json: Name, Anlage, Dauer
 *
 * Regeln:
 * - Ohne ausdrückliche Einwilligung (consent === true) wird nichts angelegt,
 *   auch kein Ordner. Die Kennung erzeugt der Server.
 * - get() liefert eine Stimme nur mit gültiger Einwilligung, Referenz und
 *   Text; fehlt etwas, gilt sie als nicht vorhanden (kein Vorlesen damit).
 * - remove() löscht den ganzen Ordner: Referenz, Text, Einwilligung und
 *   alles, was ein Anbieter dort abgeleitet hat.
 * - Logs nennen nie Namen oder Inhalte (diese Datei loggt gar nicht).
 */

import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BRAND } from "../../brand";

/** Kennung einer Stimme: 16 Hex-Zeichen, vom Server erzeugt */
export const VOICE_ID_PATTERN = /^[a-f0-9]{16}$/;

/** Wortlaut des Pflicht-Häkchens; steht so in consent.json */
export const VOICE_CONSENT_TEXT = "Das ist meine eigene Stimme, oder die Person hat mir ausdrücklich erlaubt, ihre Stimme zu klonen.";

/** Vorgegebener Text zum Vorlesen, etwa 15 Sekunden */
export const VOICE_READING_TEXT =
  "Heute ist ein ruhiger Morgen. Ich koche mir einen Kaffee, öffne das Fenster und höre den Vögeln zu. " +
  "Später gehe ich zum Bäcker, kaufe frische Brötchen und plaudere kurz über das Wetter. " +
  "Am Abend lese ich ein Buch und freue mich auf das Wochenende.";

/** Testsatz der Probe */
export const VOICE_PROBE_TEXT = `Hallo, so klingt meine KI-Stimme in ${BRAND.name}. Das ist eine Probe.`;

/** Anzeige einer geklonten Stimme in der Oberfläche */
export function clonedVoiceLabel(name: string): string {
  return `${name} (KI-Stimme)`;
}

export const VOICE_MIN_SECONDS = 5;
export const VOICE_MAX_SECONDS = 30;
/** 30 Sekunden PCM16 mono mit 48 kHz sind 2,88 MB */
export const VOICE_MAX_BYTES = 3 * 1_048_576;
export const VOICE_MIN_RATE = 16_000;
export const VOICE_MAX_RATE = 48_000;
export const VOICE_NAME_MAX = 40;
export const MAX_VOICES = 10;

/** Buchstaben, Ziffern, Leerzeichen, Punkt, Bindestrich, Apostroph */
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u;

export type VoiceRefusal = "einwilligung" | "name" | "format" | "leer" | "zu-kurz" | "zu-lang" | "zu-gross" | "zu-viele";

export interface VoiceConsent {
  version: 1;
  text: string;
  confirmedAt: string;
  device: string;
}

export interface VoiceMeta {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  seconds: number;
  sampleRate: number;
}

export interface VoiceRecord {
  id: string;
  name: string;
  label: string;
  createdAt: string;
  seconds: number;
  sampleRate: number;
  /** Absoluter Pfad der Referenz (für die Anbieter, nie an den Browser) */
  referencePath: string;
  /** Vorgelesener Text der Referenz */
  text: string;
  consent: { confirmedAt: string; device: string };
}

export function voicesDir(cwd: string): string {
  return join(cwd, "data", "speech", "voices");
}

/** Pfad der Referenz zu einer geprüften Kennung (für den Wächter von Pocket TTS gleich gebildet) */
export function referencePath(dir: string, id: string): string {
  return join(dir, id, "reference.wav");
}

// ---------------------------------------------------------------------------
// WAV prüfen und neu schreiben
// ---------------------------------------------------------------------------

export type ReferenceCheck = { ok: true; pcm: Buffer; sampleRate: number; seconds: number } | { ok: false; reason: "format" | "leer" | "zu-kurz" | "zu-lang" | "zu-gross" };

function tag(b: Buffer, o: number): string {
  return o + 4 <= b.length ? b.toString("latin1", o, o + 4) : "";
}

/**
 * Prüft eine Aufnahme: nur WAV mit PCM 16 Bit, mono, 16 bis 48 kHz, ein
 * data-Block, Dauer 5 bis 30 Sekunden. Zurück kommen nur die Abtastwerte;
 * alle anderen Blöcke (Metadaten) bleiben zurück.
 */
export function checkReferenceWav(wav: Buffer): ReferenceCheck {
  if (!wav.length) return { ok: false, reason: "leer" };
  if (wav.length > VOICE_MAX_BYTES) return { ok: false, reason: "zu-gross" };
  if (wav.length < 12 || tag(wav, 0) !== "RIFF" || tag(wav, 8) !== "WAVE") return { ok: false, reason: "format" };
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  let pos = 12;
  while (pos + 8 <= wav.length) {
    const id = tag(wav, pos);
    const size = wav.readUInt32LE(pos + 4);
    if (pos + 8 + size > wav.length) return { ok: false, reason: "format" };
    if (id === "fmt ") {
      if (fmt || size < 16) return { ok: false, reason: "format" };
      fmt = { format: wav.readUInt16LE(pos + 8), channels: wav.readUInt16LE(pos + 10), rate: wav.readUInt32LE(pos + 12), bits: wav.readUInt16LE(pos + 22) };
    } else if (id === "data") {
      if (data || !fmt) return { ok: false, reason: "format" };
      data = wav.subarray(pos + 8, pos + 8 + size);
    }
    pos = pos + 8 + size + (size & 1);
  }
  if (!fmt || !data) return { ok: false, reason: "format" };
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16 || fmt.rate < VOICE_MIN_RATE || fmt.rate > VOICE_MAX_RATE) return { ok: false, reason: "format" };
  if (data.length % 2) return { ok: false, reason: "format" };
  if (!data.length) return { ok: false, reason: "leer" };
  const seconds = data.length / 2 / fmt.rate;
  if (seconds < VOICE_MIN_SECONDS) return { ok: false, reason: "zu-kurz" };
  if (seconds > VOICE_MAX_SECONDS) return { ok: false, reason: "zu-lang" };
  return { ok: true, pcm: Buffer.from(data), sampleRate: fmt.rate, seconds };
}

/** WAV aus 16-Bit-Abtastwerten (mono), nur Kopf, fmt und data */
export function pcm16Wav(pcm: Buffer, sampleRate: number): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVE", 8, "latin1");
  head.write("fmt ", 12, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/** Name prüfen und bereinigen; null, wenn er nicht taugt */
export function cleanVoiceName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name || [...name].length > VOICE_NAME_MAX || !NAME_PATTERN.test(name)) return null;
  return name;
}

/**
 * Gerät für die Einwilligung, grob aus dem User-Agent (Browser und System),
 * nicht die ganze Kennung: „Safari auf iPhone", „Chrome auf macOS".
 */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /(Chrome|CriOS)\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const system = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  if (!browser && !system) return "unbekanntes Gerät";
  return [browser ?? "Browser", system ? `auf ${system}` : ""].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Ablage
// ---------------------------------------------------------------------------

export interface VoiceStoreOptions {
  dir: string;
  now?: () => Date;
  newId?: () => string;
}

export interface CreateVoiceInput {
  name: unknown;
  /** Nur true zählt; alles andere ist keine Einwilligung */
  consent: unknown;
  device: string;
  audio: Buffer;
}

export type CreateVoiceResult = { ok: true; voice: VoiceRecord } | { ok: false; reason: VoiceRefusal };

export type VoiceStore = ReturnType<typeof createVoiceStore>;

async function isPlainFile(path: string): Promise<boolean> {
  try {
    const s = await lstat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    if (!(await isPlainFile(path))) return null;
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function createVoiceStore(o: VoiceStoreOptions) {
  const now = o.now ?? (() => new Date());
  const newId = o.newId ?? (() => randomBytes(8).toString("hex"));

  async function ids(): Promise<string[]> {
    try {
      return (await readdir(o.dir)).filter(n => VOICE_ID_PATTERN.test(n)).sort();
    } catch {
      return [];
    }
  }

  /** Stimme mit gültiger Einwilligung, Referenz und Text; sonst null */
  async function get(id: string): Promise<VoiceRecord | null> {
    if (typeof id !== "string" || !VOICE_ID_PATTERN.test(id)) return null;
    const dir = join(o.dir, id);
    try {
      if (!(await lstat(dir)).isDirectory()) return null;
    } catch {
      return null;
    }
    const meta = await readJson<VoiceMeta>(join(dir, "meta.json"));
    const consent = await readJson<VoiceConsent>(join(dir, "consent.json"));
    if (!meta || meta.version !== 1 || meta.id !== id || typeof meta.name !== "string") return null;
    if (!consent || consent.version !== 1 || consent.text !== VOICE_CONSENT_TEXT || typeof consent.confirmedAt !== "string" || !consent.confirmedAt) return null;
    const ref = referencePath(o.dir, id);
    if (!(await isPlainFile(ref))) return null;
    let text: string;
    try {
      if (!(await isPlainFile(join(dir, "text.txt")))) return null;
      text = (await readFile(join(dir, "text.txt"), "utf8")).trim();
    } catch {
      return null;
    }
    if (!text) return null;
    return {
      id,
      name: meta.name,
      label: clonedVoiceLabel(meta.name),
      createdAt: meta.createdAt,
      seconds: meta.seconds,
      sampleRate: meta.sampleRate,
      referencePath: ref,
      text,
      consent: { confirmedAt: consent.confirmedAt, device: typeof consent.device === "string" ? consent.device : "" },
    };
  }

  async function list(): Promise<VoiceRecord[]> {
    const out: VoiceRecord[] = [];
    for (const id of await ids()) {
      const v = await get(id);
      if (v) out.push(v);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Legt eine Stimme an. Die Einwilligung wird zuerst geprüft: ohne sie
   * entsteht nichts auf der Platte. Geschrieben wird in einen Temp-Ordner
   * und erst vollständig an den Zielort umbenannt.
   */
  async function create(input: CreateVoiceInput): Promise<CreateVoiceResult> {
    if (input.consent !== true) return { ok: false, reason: "einwilligung" };
    const name = cleanVoiceName(input.name);
    if (!name) return { ok: false, reason: "name" };
    const check = checkReferenceWav(input.audio);
    if (!check.ok) return { ok: false, reason: check.reason };
    if ((await ids()).length >= MAX_VOICES) return { ok: false, reason: "zu-viele" };
    const id = newId();
    if (!VOICE_ID_PATTERN.test(id)) throw new Error("ungültige Kennung");
    const at = now().toISOString();
    await mkdir(o.dir, { recursive: true, mode: 0o700 });
    const tmp = join(o.dir, `.tmp-${id}`);
    const target = join(o.dir, id);
    const consent: VoiceConsent = { version: 1, text: VOICE_CONSENT_TEXT, confirmedAt: at, device: input.device.slice(0, 80) };
    const meta: VoiceMeta = { version: 1, id, name, createdAt: at, seconds: Math.round(check.seconds * 100) / 100, sampleRate: check.sampleRate };
    try {
      await mkdir(tmp, { mode: 0o700 });
      await writeFile(join(tmp, "consent.json"), JSON.stringify(consent, null, 2) + "\n", { mode: 0o600 });
      await writeFile(join(tmp, "reference.wav"), pcm16Wav(check.pcm, check.sampleRate), { mode: 0o600 });
      await writeFile(join(tmp, "text.txt"), VOICE_READING_TEXT + "\n", { mode: 0o600 });
      await writeFile(join(tmp, "meta.json"), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, target);
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    const voice = await get(id);
    if (!voice) throw new Error("Stimme nach dem Anlegen nicht lesbar");
    return { ok: true, voice };
  }

  /** Löscht die Stimme samt Referenz, Text, Einwilligung und Abgeleitetem; true, wenn es sie gab */
  async function remove(id: string): Promise<boolean> {
    if (typeof id !== "string" || !VOICE_ID_PATTERN.test(id)) return false;
    const dir = join(o.dir, id);
    let existed = false;
    try {
      await lstat(dir);
      existed = true;
    } catch {
      // gibt es nicht
    }
    await rm(dir, { recursive: true, force: true });
    return existed;
  }

  return { dir: o.dir, get, list, create, remove };
}
