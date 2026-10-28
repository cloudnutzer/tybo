/**
 * Einstellungsdatei config/settings.json (WebUI M3).
 *
 * Was spaeter im Browser eingestellt wird, liegt hier und ueberschreibt .env
 * und die Standards im Code. Vorrang an den Aufrufstellen: Datei vor .env vor
 * Code (resolveAgentModel/resolveAgentEffort in src/agents/base.ts, resolveAux
 * in aux-model.ts, die Getter in fallback/chain.ts).
 *
 * - Fehlt die Datei: leere Einstellungen, es gilt alles wie bisher.
 * - Neu gelesen wird, sobald sich mtime, Groesse oder Inode aendern (wie
 *   config/topics.json), also beim naechsten Aufruf ohne Neustart.
 * - Ungueltige Datei (kein JSON, Schema verletzt): eine Log-Zeile, die letzte
 *   gueltige Fassung bleibt aktiv; beim Start sind das leere Einstellungen.
 * - Schreiben prueft zuerst das Schema und ersetzt die Datei dann atomar mit
 *   Rechten 0600.
 */

import { mkdirSync, statSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { z } from "zod";
import { AGENT_ID_PATTERN } from "../agents/names";
import { atomicWriteFile } from "./atomic-file";
import { acquireFileLock, releaseFileLock } from "./file-lock";
import { CLOCK_TIME_PATTERN } from "./proactive/clock";
import { CALL_STT_CHOICES, CALL_TTS_CHOICES, CLONE_ENGINE_IDS, CLONE_VOICE_ID_PATTERN, ELEVENLABS_MODELS, SPEECH_LANGUAGE_PATTERN, STT_IDS, TELEGRAM_TTS_CHOICES, TTS_IDS } from "./speech/ids";
import { VOICE_PATTERN } from "./speech/types";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export type AuxKind = "claude" | "openrouter" | "ollama";

/** "<kind>:<model>", getrennt am ersten Doppelpunkt (ollama:qwen3:8b). null bei ungueltigem Format. */
export function parseAuxSpec(raw: string): { kind: AuxKind; model: string } | null {
  const value = raw.trim();
  const sep = value.indexOf(":");
  if (sep <= 0) return null;
  const kind = value.slice(0, sep).toLowerCase();
  const model = value.slice(sep + 1).trim();
  if ((kind !== "claude" && kind !== "openrouter" && kind !== "ollama") || !model) return null;
  return { kind, model };
}

const modelName = z.string().trim().min(1, "Modellname darf nicht leer sein");
const effort = z.enum(EFFORT_LEVELS);
const auxSpec = z
  .string()
  .refine((v) => parseAuxSpec(v) !== null, "Format <claude|openrouter|ollama>:<modell>");
const hourOfDay = z.number().int("volle Stunde").min(0, "0 bis 23").max(23, "0 bis 23");
const modelAndEffort = z.object({ model: modelName.optional(), effort: effort.optional() });
const clockTime = z.string().regex(CLOCK_TIME_PATTERN, "Uhrzeit als HH:MM");
const clockSpan = z
  .object({ from: clockTime, to: clockTime })
  .refine((s) => s.from !== s.to, "Beginn und Ende müssen verschieden sein");

/**
 * Rechte-Stufen von Codex (Entscheidung 0018, Issue #124): full = alles ohne
 * Sandbox (Standard), workspace-write = Schreiben im Projekt mit Netz,
 * read-only = nur lesen.
 */
export const CODEX_SANDBOX_LEVELS = ["read-only", "workspace-write", "full"] as const;
export type CodexSandbox = (typeof CODEX_SANDBOX_LEVELS)[number];
export const DEFAULT_CODEX_SANDBOX: CodexSandbox = "full";

/**
 * Rechte von OpenCode (Entscheidung 0019, Issue #128): auto = `--auto`,
 * Fragen werden bestätigt, was die OpenCode-Konfiguration ausdrücklich
 * verbietet (deny), bleibt verboten (Standard); ask-deny = ohne `--auto`,
 * jede Frage wird abgelehnt.
 */
export const OPENCODE_PERMISSION_LEVELS = ["ask-deny", "auto"] as const;
export type OpenCodePermission = (typeof OPENCODE_PERMISSION_LEVELS)[number];
export const DEFAULT_OPENCODE_PERMISSION: OpenCodePermission = "auto";

/**
 * Wählbare Motoren (Issue #125, OpenCode seit #129, Anthropic API seit #347). Hier und nicht aus
 * engines/, weil engines/codex.ts und engines/opencode.ts diese Datei
 * importieren.
 */
export const SELECTABLE_ENGINES = ["claude", "codex", "opencode", "api"] as const;
export type SelectableEngine = (typeof SELECTABLE_ENGINES)[number];

/** Effort für Codex: dieselben Stufen wie Claude, zusätzlich max */
export const CODEX_EFFORT_LEVELS = [...EFFORT_LEVELS, "max"] as const;

/** Wie MODEL in engines/codex.ts: was dort als -m durchgeht */
const codexModelName = modelName.regex(/^[A-Za-z0-9][\w.:/-]*$/, "ungültiger Modellname");

/**
 * OpenCode-Modell als <anbieter>/<modell>, auch mit weiteren Schrägstrichen
 * (openrouter/anthropic/claude-opus-5.5); wie MODEL in engines/opencode.ts.
 */
export const OPENCODE_MODEL_PATTERN = /^[A-Za-z0-9][\w.:/@-]*$/;
/**
 * Variante (Effort) von OpenCode, anbieterabhängig und deshalb frei: 1 bis 20
 * Zeichen aus Kleinbuchstaben, Ziffern und Bindestrich, auch mit Bindestrich
 * vorn. Der Motor übergibt den Wert deshalb nur als `--variant=<wert>` (ein
 * Argument), nie als eigenes Argument, das OpenCode als Option lesen könnte.
 * Wie EFFORT in engines/opencode.ts.
 */
export const OPENCODE_VARIANT_PATTERN = /^[a-z0-9-]{1,20}$/;
const opencodeModelName = modelName.regex(OPENCODE_MODEL_PATTERN, "ungültiger Modellname");
const opencodeVariant = z.string().regex(OPENCODE_VARIANT_PATTERN, "1 bis 20 Zeichen aus a-z, 0-9 und -");

/**
 * Modell für gesprochene Fragen (speech.model, Issue #249): ein Modellname
 * eines der Motoren, also alles, was deren Muster erlauben (Claude-Namen
 * auch mit „[1m]"), nie mit „-" am Anfang (der Wert geht als Argument an
 * ein Programm).
 */
export const SPEECH_MODEL_PATTERN = /^[A-Za-z0-9][\w.:/@[\]-]*$/;

/**
 * Session-Schlüssel eines Gesprächs (sessionKeyFor in supabase.ts):
 * topic:<chat>:<topic>, group:<chat>, dm:<chat>, web:<id>
 */
/**
 * Modell des Telefonhörers (speech.call.model, Issue #256): auto oder
 * <claude|openrouter|ollama>:<modell>; der Modellteil geht als Argument an
 * die CLI bzw. in eine Anfrage und darf nie mit „-" beginnen.
 */
export function isCallModelSetting(raw: string): boolean {
  if (raw === "auto") return true;
  const spec = parseAuxSpec(raw);
  return spec !== null && spec.model.length <= 100 && SPEECH_MODEL_PATTERN.test(spec.model);
}

/** Weg für claude:-Modelle im Telefonhörer: api (VOICE_ANTHROPIC_API_KEY) oder cli (offene Claude-Code-Sitzung) */
export const CALL_CLAUDE_VIA = ["api", "cli"] as const;

export const CONVERSATION_KEY_PATTERN = /^(topic:-?\d{1,20}:\d{1,12}|group:-\d{1,20}|dm:(?:-?\d{1,20}|web)|web:[A-Za-z0-9-]{1,64})$/;

export const settingsSchema = z.object({
  defaults: modelAndEffort.optional(),
  // Schluessel: jede gueltige Kennung (Issue #49). Welche Agenten aktiv sind,
  // prueft die WebUI beim Aendern (applySettingsPatch); Eintraege zu
  // geloeschten Agenten bleiben stehen und werden ignoriert, kein Fehler.
  // So haengt das Lesen der Datei nicht vom Agenten-Katalog ab.
  agents: z.record(z.string().regex(AGENT_ID_PATTERN, "ungültige Agenten-Kennung"), modelAndEffort).optional(),
  aux: z
    .object({
      judge: auxSpec.optional(),
      distill: auxSpec.optional(),
      review: auxSpec.optional(),
      threads: auxSpec.optional(),
      "call-summary": auxSpec.optional(),
      checkin: auxSpec.optional(),
    })
    .optional(),
  fallback: z
    .object({
      openrouterModel: modelName.optional(),
      ollamaModel: modelName.optional(),
      offlineOnly: z.boolean().optional(),
    })
    .optional(),
  // Motoren (Entscheidungen 0018/0019, Issues #124/#125/#129): Standard,
  // Ausnahmen pro Gespräch (Session-Schlüssel), Modell/Effort/Rechte für
  // Codex, Modell/Variante/Rechte für OpenCode (leer = OpenCode-Konfiguration)
  engine: z
    .object({
      default: z.enum(SELECTABLE_ENGINES).optional(),
      topics: z.record(z.string().regex(CONVERSATION_KEY_PATTERN, "ungültiger Gesprächsschlüssel"), z.enum(SELECTABLE_ENGINES)).optional(),
      codex: z
        .object({
          model: codexModelName.optional(),
          effort: z.enum(CODEX_EFFORT_LEVELS).optional(),
          sandbox: z.enum(CODEX_SANDBOX_LEVELS).optional(),
        })
        .optional(),
      opencode: z
        .object({
          model: opencodeModelName.optional(),
          variant: opencodeVariant.optional(),
          permission: z.enum(OPENCODE_PERMISSION_LEVELS).optional(),
        })
        .optional(),
    })
    .optional(),
  // Hören und Sprechen (Issue #248, Entscheidung 0023): auto oder eine
  // Anbieter-Kennung, Sprache auto oder zwei Kleinbuchstaben. Fehlt ein Feld,
  // gilt SPEECH_STT/SPEECH_TTS aus .env, sonst auto (src/lib/speech/chain.ts).
  // model und effort (Issue #249): Modell nur für gesprochene Fragen, leer =
  // wie das Gespräch; effort gilt nur mit model und nur beim Motor Claude
  // (Standard medium, src/lib/speech/spoken-turn.ts)
  // cloneVoice und cloneEngine (Issue #253): gewählte eigene Stimme (Kennung
  // unter data/speech/voices/) und Klon-Engine; nur über die eigenen Routen
  // der WebUI bzw. tybo setup sprache gesetzt, nie über PATCH /api/settings.
  // telegramTts: die Telegram-Wahl von vor „Verwenden"; gilt nur, solange
  // tts = clone (die eigene Stimme spricht nie in Telegram), fehlt sie, gilt
  // SPEECH_TTS bzw. auto
  speech: z
    .object({
      stt: z.enum(["auto", ...STT_IDS]).optional(),
      tts: z.enum(["auto", ...TTS_IDS]).optional(),
      language: z.string().regex(SPEECH_LANGUAGE_PATTERN, "auto oder zwei Kleinbuchstaben").optional(),
      model: modelName.max(100, "höchstens 100 Zeichen").regex(SPEECH_MODEL_PATTERN, "ungültiger Modellname").optional(),
      effort: effort.optional(),
      cloneVoice: z.string().regex(CLONE_VOICE_ID_PATTERN, "ungültige Kennung").optional(),
      cloneEngine: z.enum(CLONE_ENGINE_IDS).optional(),
      telegramTts: z.enum(TELEGRAM_TTS_CHOICES).optional(),
      // Telefonhörer (Issue #256, src/lib/voice-brain/call-model.ts): Modell
      // auto oder <kind>:<modell> (vor SPEECH_CALL_MODEL, sonst auto),
      // Effort (Standard low), claudeVia erzwingt api oder cli für claude:
      // tts, elevenlabsVoice, elevenlabsModel (Issue #276): Stimme des
      // Telefonhörers, bei ElevenLabs Stimmen-Kennung und Modell; der
      // Schlüssel steht nur in .env (ELEVENLABS_API_KEY), nie hier.
      // stt (Issue #279): Erkenner des Telefonhörers, elevenlabs ist
      // ElevenLabs Scribe mit Parakeet als Rückfall
      call: z
        .object({
          model: z.string().trim().refine(isCallModelSetting, "auto oder <claude|openrouter|ollama>:<modell>").optional(),
          effort: effort.optional(),
          claudeVia: z.enum(CALL_CLAUDE_VIA).optional(),
          tts: z.enum(CALL_TTS_CHOICES).optional(),
          stt: z.enum(CALL_STT_CHOICES).optional(),
          elevenlabsVoice: z.string().regex(VOICE_PATTERN, "ungültige Stimmen-Kennung").optional(),
          elevenlabsModel: z.enum(ELEVENLABS_MODELS).optional(),
        })
        .optional(),
    })
    .optional(),
  // Offene Fäden (Issue #293, Entscheidung 0025): an/aus, Erinnerung nach
  // ganzen Tagen (1 bis 14), Ruhezeit in vollen Stunden Ortszeit (von
  // einschließlich, bis ausschließlich, über Mitternacht erlaubt). Fehlt ein
  // Feld, gilt THREADS, THREADS_REMIND_DAYS bzw. THREADS_QUIET_HOURS aus .env,
  // sonst an, 3 Tage, 21-8 (src/lib/threads/config.ts)
  threads: z
    .object({
      enabled: z.boolean().optional(),
      remindDays: z.number().int("ganze Tage").min(1, "1 bis 14 Tage").max(14, "1 bis 14 Tage").optional(),
      quietHours: z
        .object({ from: hourOfDay, to: hourOfDay })
        .refine((q) => q.from !== q.to, "Beginn und Ende der Ruhezeit müssen verschieden sein")
        .optional(),
    })
    .optional(),
  // Proaktive Meldungen (Issue #361, src/lib/proactive/config.ts): Ruhezeit
  // für alle Arten, je Art an/aus und Zeitfenster als "HH:MM" (von
  // einschließlich, bis ausschließlich, über Mitternacht erlaubt), beim
  // Check-in dazu Startzeiten des Dienstes (leere Liste: keine Termine) und
  // Mindestabstand in Minuten. Fehlt ein Feld, gilt der Standard im Code.
  proactive: z
    .object({
      quietHours: clockSpan.optional(),
      briefing: z.object({ enabled: z.boolean().optional(), window: clockSpan.optional() }).optional(),
      checkin: z
        .object({
          enabled: z.boolean().optional(),
          window: clockSpan.optional(),
          times: z
            .array(clockTime)
            .max(1440, "höchstens 1440 Startzeiten")
            .refine((t) => new Set(t).size === t.length, "Startzeiten doppelt")
            .optional(),
          minGapMinutes: z.number().int("ganze Minuten").min(0, "0 bis 1440").max(1440, "0 bis 1440").optional(),
        })
        .optional(),
    })
    .optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

const EMPTY: Settings = Object.freeze({}) as Settings;

const DEFAULT_PATH = join(process.cwd(), "config", "settings.json");
let settingsPath = DEFAULT_PATH;

// version: mtime, Groesse und Inode der zuletzt gelesenen Datei (null = fehlt)
let cache: { version: string | null; settings: Settings } = { version: null, settings: EMPTY };
let lastValid: Settings = EMPTY;

/** Nur fuer Tests: andere Datei verwenden (ohne Argument: config/settings.json). Setzt den Zustand zurueck. */
export function setSettingsPath(path?: string): void {
  settingsPath = path ?? DEFAULT_PATH;
  cache = { version: null, settings: EMPTY };
  lastValid = EMPTY;
}

export function getSettingsPath(): string {
  return settingsPath;
}

/** Aktuelle Einstellungen; liest die Datei nur neu, wenn sie sich geaendert hat. */
export function getSettings(): Settings {
  let version: string;
  try {
    const st = statSync(settingsPath);
    version = `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      // Geloescht oder nie angelegt: Standards aus .env und Code
      cache = { version: null, settings: EMPTY };
      lastValid = EMPTY;
      return EMPTY;
    }
    console.error(`[Settings] ${settingsPath} nicht lesbar (${err?.code ?? err}), letzte gueltige Fassung bleibt`);
    return lastValid;
  }
  if (cache.version === version) return cache.settings;

  let settings: Settings;
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(settingsPath, "utf-8")));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(Wurzel)"}: ${i.message}`);
      throw new Error(issues.join("; "));
    }
    settings = parsed.data;
    lastValid = settings;
  } catch (err) {
    console.error(
      `[Settings] ${settingsPath} ungueltig, letzte gueltige Fassung bleibt: ${err instanceof Error ? err.message : err}`
    );
    settings = lastValid;
  }
  cache = { version, settings };
  return settings;
}

/**
 * Prueft und schreibt die Einstellungen atomar (0600). Wirft bei ungueltigem
 * Inhalt, dann bleibt die Datei unberuehrt; ebenso bei Schreibfehlern.
 */
export async function writeSettings(settings: Settings, path: string = settingsPath): Promise<void> {
  const parsed = settingsSchema.parse(settings);
  await atomicWriteFile(path, JSON.stringify(parsed, null, 2) + "\n");
}

/** Die Datei ist ungültig: updateSettings schreibt dann nichts */
export class SettingsFileInvalidError extends Error {
  constructor(path: string = settingsPath) {
    super(`${path} ist ungültig`);
    this.name = "SettingsFileInvalidError";
  }
}

let lockChain: Promise<unknown> = Promise.resolve();

/** Wie lange ein Schreiber auf die Sperre eines anderen Prozesses wartet */
const SETTINGS_LOCK_WAIT_MS = 15_000;

/**
 * Eine Schreibkette für alle Änderungen an der Einstellungsdatei (Issue
 * #125): /motor und die Einstellungsseite lesen und schreiben nacheinander,
 * keiner überschreibt die Änderung des anderen.
 *
 * Über Prozesse (Issue #361): Bot, Routinen (Übernahme in
 * proactive/migrate.ts) und Einrichtung schreiben dieselbe Datei. Innerhalb
 * der Kette hält fn zusätzlich die Sperre <datei>.lock (file-lock.ts), so
 * liest und schreibt immer nur ein Prozess zugleich. path: die Datei, die fn
 * ändert (Standard: die aktive).
 */
export function withSettingsLock<T>(fn: () => Promise<T>, path: string = settingsPath): Promise<T> {
  const run = lockChain.catch(() => {}).then(async () => {
    const lockPath = `${path}.lock`;
    mkdirSync(dirname(path), { recursive: true });
    const owner = await acquireFileLock(lockPath, { waitMs: SETTINGS_LOCK_WAIT_MS });
    try {
      return await fn();
    } finally {
      await releaseFileLock(lockPath, owner);
    }
  });
  lockChain = run;
  return run;
}

/**
 * Liest die Datei frisch, wendet mutate auf eine Kopie an und schreibt das
 * Ergebnis, alles in der Schreibkette. Eine ungültige Datei wird nicht
 * überschrieben (SettingsFileInvalidError); fehlt sie, gilt {}.
 *
 * options.path (Issue #251): eine bestimmte Datei statt der aktiven, etwa die
 * des Einrichtungsassistenten (ctx.settingsPath), unabhängig vom
 * Arbeitsverzeichnis. Dieselbe Schreibkette.
 */
export function updateSettings(mutate: (current: Settings) => Settings, options: { path?: string } = {}): Promise<Settings> {
  const path = options.path ?? settingsPath;
  return withSettingsLock(async () => {
    let raw: string | undefined;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
    let current: Settings = {};
    if (raw !== undefined) {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new SettingsFileInvalidError(path);
      }
      const parsed = settingsSchema.safeParse(json);
      if (!parsed.success) throw new SettingsFileInvalidError(path);
      current = parsed.data;
    }
    const next = settingsSchema.parse(mutate(structuredClone(current)));
    await writeSettings(next, path);
    return next;
  }, path);
}
