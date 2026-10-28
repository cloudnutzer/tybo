/**
 * Einstellungen-API der WebUI (Issue #36): GET und PATCH /api/settings.
 *
 * Die Datei config/settings.json, ihr Schema und die Resolver leben in
 * src/lib und src/agents; diese Datei importiert nichts davon. src/bot.ts
 * übergibt sie als SettingsPort (src/web/bot-settings.ts), Tests reichen
 * Attrappen oder temporäre Dateien herein.
 *
 * PATCH ist eine Teiländerung:
 * - Fehlende Felder bleiben, verschachtelte Angaben werden zusammengeführt.
 * - null oder leerer Text entfernt einen Eintrag; dann gilt wieder die
 *   nächste Stufe (Standard aus der Datei, .env oder Code). false ist bei
 *   offlineOnly ein Wert, kein Löschen.
 * - Unbekannte Felder und Agenten ergeben 400. Geprüft wird zuletzt das
 *   ganze Ergebnis mit demselben Schema wie beim Laden; ist etwas ungültig,
 *   wird nichts gespeichert.
 * - Lesen, Zusammenführen und Schreiben laufen am Stück, gleichzeitige
 *   Änderungen verlieren keine Einträge.
 *
 * Motor (Issues #126/#129): engine.default, engine.codex (model, effort,
 * sandbox) und engine.opencode (model, variant, permission) lassen sich
 * ändern, leer oder null entfernt den Wert. engine
 * selbst ist nie null, und engine.topics (Ausnahmen mit /motor) ändert PATCH
 * nie: die stehen unverändert weiter in der Datei, entfernt werden sie
 * einzeln über POST /api/engines/reset (./engines.ts).
 *
 * Hören und Sprechen (Issue #248): speech.stt, speech.tts und speech.language
 * als Text, null oder leer entfernt das Feld (dann gilt SPEECH_STT/SPEECH_TTS
 * aus .env bzw. auto), null entfernt den ganzen Abschnitt. Die
 * Anbieterlisten mit Verfügbarkeit stehen als speechOptions in beiden
 * Antworten; den Status des Sprechmodus liefert GET /api/voice (./voice.ts).
 * speech.model und speech.effort (Issue #249): Modell für gesprochene Fragen,
 * null oder leer entfernt das Feld (dann antwortet das Modell des Gesprächs
 * bzw. gilt die Stufe medium).
 * speech.call (Issue #256): Telefonhörer mit model (auto oder
 * <kind>:<modell>), effort und claudeVia (api, cli); verschachtelt wie
 * engine.codex: einzelne Felder ändern oder mit null bzw. leer entfernen,
 * speech.call null entfernt den Unterabschnitt, die übrigen Sprach- und
 * Klon-Einstellungen bleiben. Seit Issue #276 dazu tts (auto, pocket, piper,
 * elevenlabs, browser), elevenlabsVoice und elevenlabsModel; der Schlüssel
 * kommt nie hierher. Seit Issue #279 dazu stt (auto, parakeet, whisper-cpp,
 * elevenlabs).
 *
 * Offene Fäden (Issue #293): threads.enabled (true/false), threads.remindDays
 * (Zahl) und threads.quietHours ({ from, to } als Ganzes), null entfernt ein
 * Feld bzw. den Abschnitt (dann gilt .env, sonst der Standard). aux.threads
 * wie die anderen Nebenmodelle, ebenso aux["call-summary"] (Issue #306).
 *
 * Beide Antworten enthalten neben effective auch inherited: je Agent Modell
 * und Effort samt Quelle, die gälten, wenn nur dieses Feld auf „Standard"
 * gesetzt würde (Issue #38), und inheritedModels mit denselben Angaben für
 * Standardmodell, Standard-Effort, Aux und Fallback (Issue #39).
 */

import { createRevisionClock, type RevisionClock } from "./revision";

export type ValueSource = "settings" | "env" | "code";

export interface Sourced<T> {
  value: T;
  source: ValueSource;
}

export interface ModelAndEffort {
  model?: string;
  effort?: string;
}

/** Form von config/settings.json (Settings in src/lib/settings.ts) */
export interface SettingsData {
  defaults?: ModelAndEffort;
  agents?: Record<string, ModelAndEffort>;
  aux?: { judge?: string; distill?: string; review?: string; threads?: string; "call-summary"?: string };
  fallback?: { openrouterModel?: string; ollamaModel?: string; offlineOnly?: boolean };
  /** Motor (Entscheidungen 0018/0019): Standard, Ausnahmen je Session-Schlüssel, Codex- und OpenCode-Einstellungen */
  engine?: {
    default?: string;
    topics?: Record<string, string>;
    codex?: { model?: string; effort?: string; sandbox?: string };
    opencode?: { model?: string; variant?: string; permission?: string };
  };
  /**
   * Hören und Sprechen (Issue #248): auto oder eine Anbieter-Kennung, Sprache auto oder zwei Kleinbuchstaben.
   * model und effort (Issue #249): Modell für gesprochene Fragen, leer = wie das Gespräch
   */
  speech?: {
    stt?: string;
    tts?: string;
    language?: string;
    model?: string;
    effort?: string;
    /** Telefonhörer (Issue #256), Stimme dazu seit Issue #276, Erkenner seit Issue #279 */
    call?: { model?: string; effort?: string; claudeVia?: string; tts?: string; stt?: string; elevenlabsVoice?: string; elevenlabsModel?: string };
  };
  /** Offene Fäden (Issue #293): an/aus, Erinnerung nach Tagen (1 bis 14), Ruhezeit in vollen Stunden Ortszeit */
  threads?: { enabled?: boolean; remindDays?: number; quietHours?: { from: number; to: number } };
}

export const SPEECH_FIELDS = ["stt", "tts", "language"] as const;
export type SpeechField = (typeof SPEECH_FIELDS)[number];

export const AUX_PURPOSES = ["judge", "distill", "review", "threads", "call-summary"] as const;
export type AuxPurpose = (typeof AUX_PURPOSES)[number];

/** Was an den Aufrufstellen tatsächlich gilt, mit Quelle */
export interface EffectiveSettings {
  /** effort null: kein Effort, die Claude CLI entscheidet */
  agents: Record<string, { model: Sourced<string>; effort: Sourced<string | null> }>;
  /** Format <claude|openrouter|ollama>:<modell> */
  aux: Record<AuxPurpose, Sourced<string>>;
  fallback: { openrouterModel: Sourced<string>; ollamaModel: Sourced<string>; offlineOnly: Sourced<boolean> };
  /** Standard-Motor wie defaultEngineSetting (Issue #126); fehlt bei Ports ohne Motor-Wahl */
  engine?: { default: Sourced<string> };
  /** Hören und Sprechen (Issue #248): Datei, SPEECH_STT/SPEECH_TTS, auto; fehlt bei Ports ohne Sprach-Schnittstelle */
  speech?: Record<SpeechField, Sourced<string>>;
  /** Offene Fäden (Issue #293): Datei, THREADS/THREADS_REMIND_DAYS/THREADS_QUIET_HOURS, Standard; fehlt bei Ports ohne Fäden */
  threads?: ThreadsEffective;
}

export const THREADS_FIELDS = ["enabled", "remindDays", "quietHours"] as const;
export type ThreadsField = (typeof THREADS_FIELDS)[number];

export interface ThreadsEffective {
  enabled: Sourced<boolean>;
  remindDays: Sourced<number>;
  quietHours: Sourced<{ from: number; to: number }>;
}

export interface SettingsIssue {
  /** Feldpfad wie agents.research.effort, nie der Wert */
  path: string;
  message: string;
}

export type ValidateResult = { ok: true; value: SettingsData } | { ok: false; issues: SettingsIssue[] };

/** readForWrite: Die Datei ist kein gültiges JSON oder verletzt das Schema */
export class SettingsFileInvalid extends Error {
  constructor() {
    super("config/settings.json ist ungültig");
    this.name = "SettingsFileInvalid";
  }
}

/** Auswahl für den Abschnitt Motor der Einstellungsseite */
export interface EngineOptions {
  engines: readonly { id: string; label: string }[];
  codexEffortLevels: readonly string[];
  codexSandboxLevels: readonly string[];
  codexDefaultSandbox: string;
  /** Rechte von OpenCode (auto, ask-deny) und ihr Standard */
  opencodePermissionLevels: readonly string[];
  opencodeDefaultPermission: string;
}

/** Ein Anbieter für Hören oder Sprechen mit Verfügbarkeit; reason nur, wenn nicht verfügbar */
export interface SpeechProviderOption {
  id: string;
  label: string;
  local: boolean;
  available: boolean;
  reason?: string;
}

/** Anbieterlisten für den Reiter „Sprechen" (Issue #248) */
export interface SpeechOptions {
  stt: SpeechProviderOption[];
  /** note: Namensnennung bzw. Lizenz (Pocket TTS, Piper, Issue #252) */
  tts: (SpeechProviderOption & { where: "server" | "browser"; note?: string })[];
  /** Sprachen zur Auswahl neben Automatisch */
  languages: string[];
}

export interface SettingsPort {
  /** Kanonische Agentennamen, für die Einstellungen erlaubt sind */
  agents: readonly string[];
  effortLevels: readonly string[];
  /** Gültiger Stand wie an den Aufrufstellen (bei ungültiger Datei die letzte gültige Fassung) */
  current(): SettingsData;
  /** Stand frisch aus der Datei; fehlt sie, leer. Wirft SettingsFileInvalid, wenn sie ungültig ist */
  readForWrite(): Promise<SettingsData>;
  /** Dasselbe Schema wie beim Laden; Meldungen ohne Werte */
  validate(value: unknown): ValidateResult;
  write(value: SettingsData): Promise<void>;
  /** Gemeinsame Schreibkette mit anderen Schreibern der Datei (withSettingsLock); fehlt: nur innerhalb dieser API */
  lock?<T>(fn: () => Promise<T>): Promise<T>;
  /** Wirksame Werte für genau diesen Stand */
  effective(settings: SettingsData): EffectiveSettings;
  /** Motor (Issues #126/#129): wählbare Motoren, Stufen und Rechte von Codex und OpenCode */
  engineOptions?: EngineOptions;
  /** Hören und Sprechen (Issue #248): Anbieter mit aktueller Verfügbarkeit, deshalb eine Funktion */
  speechOptions?(): SpeechOptions;
}

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

export const SETTINGS_TEXT = {
  notConfigured: "Einstellungen sind nicht eingerichtet",
  invalidRequest: "Ungültige Anfrage",
  fileInvalid: "config/settings.json ist ungültig. Bitte die Datei reparieren oder löschen, dann erneut speichern.",
  notSaved: "Einstellungen konnten nicht gespeichert werden",
  unknownAgent: "Unbekannter Agent",
} as const;

/** Feldnamen nur zurückgeben, wenn sie harmlos aussehen */
function safeName(key: string): string {
  return /^[A-Za-z0-9_-]{1,40}$/.test(key) ? key : "?";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

class PatchError extends Error {}

type LeafKind = "string" | "boolean" | "number" | "hours";

/**
 * Wechsel von speech.tts (Issue #253), derselbe Übergang für „Verwenden" der
 * eigenen Stimme (bot-voice-clone.ts) und PATCH /api/settings: Wer zur
 * eigenen Stimme wechselt, merkt die bisherige Wahl als telegramTts (war schon
 * clone gewählt, bleibt die gemerkte; ohne bisherige Wahl fehlt sie). Wer
 * davon weg wechselt, braucht keine gemerkte Wahl mehr. tts undefined
 * entfernt das Feld.
 */
export function withTtsChoice<T extends { tts?: string; telegramTts?: string }>(speech: T, tts: string | undefined): T {
  const { tts: before, telegramTts: kept, ...rest } = speech;
  const telegram = tts !== "clone" ? undefined : before === "clone" ? kept : before;
  return { ...rest, ...(tts !== undefined ? { tts } : {}), ...(telegram !== undefined ? { telegramTts: telegram } : {}) } as T;
}

function isRemoval(raw: unknown): boolean {
  return raw === null || (typeof raw === "string" && raw.trim() === "");
}

/**
 * Wendet eine Teiländerung auf eine Kopie an. Prüft nur Form und Namen; das
 * Schema prüft der Aufrufer danach am ganzen Ergebnis.
 */
export function applySettingsPatch(
  current: SettingsData,
  patch: unknown,
  agentNames: readonly string[]
): { ok: true; value: SettingsData; changed: string[] } | { ok: false; error: string } {
  if (!isPlainObject(patch)) return { ok: false, error: SETTINGS_TEXT.invalidRequest };
  const next: Record<string, any> = structuredClone(current ?? {});
  const changed: string[] = [];

  /** Ein Blatt setzen oder entfernen */
  function leaf(target: Record<string, unknown>, key: string, raw: unknown, kind: LeafKind, path: string) {
    if (raw === undefined) return;
    if (isRemoval(raw)) {
      delete target[key];
    } else if (kind === "string" && typeof raw === "string") {
      target[key] = raw.trim();
    } else if (kind === "boolean" && typeof raw === "boolean") {
      target[key] = raw;
    } else if (kind === "number" && typeof raw === "number" && Number.isFinite(raw)) {
      target[key] = raw;
    } else if (kind === "hours" && isPlainObject(raw) && Object.keys(raw).every(k => k === "from" || k === "to") && typeof raw.from === "number" && typeof raw.to === "number") {
      // Ruhezeit nur als Ganzes; Bereich und „verschieden" prüft das Schema
      target[key] = { from: raw.from, to: raw.to };
    } else {
      throw new PatchError(`Falscher Typ: ${path}`);
    }
    changed.push(path);
  }

  /** Abschnitt mit festen Blättern; null entfernt den ganzen Abschnitt */
  function section(name: string, raw: unknown, fields: Record<string, LeafKind>, parent: Record<string, any>, path: string) {
    if (raw === undefined) return;
    if (raw === null) {
      delete parent[name];
      changed.push(path);
      return;
    }
    if (!isPlainObject(raw)) throw new PatchError(`Falscher Typ: ${path}`);
    for (const key of Object.keys(raw)) {
      if (!(key in fields)) throw new PatchError(`Unbekanntes Feld: ${path}.${safeName(key)}`);
    }
    const target: Record<string, unknown> = isPlainObject(parent[name]) ? parent[name] : {};
    for (const [key, kind] of Object.entries(fields)) leaf(target, key, raw[key], kind, `${path}.${key}`);
    parent[name] = target;
  }

  const MODEL_EFFORT = { model: "string", effort: "string" } as const;
  try {
    for (const key of Object.keys(patch)) {
      if (!["defaults", "agents", "aux", "fallback", "engine", "speech", "threads"].includes(key)) throw new PatchError(`Unbekanntes Feld: ${safeName(key)}`);
    }
    section("defaults", patch.defaults, MODEL_EFFORT, next, "defaults");
    section("aux", patch.aux, { judge: "string", distill: "string", review: "string", threads: "string", "call-summary": "string" }, next, "aux");
    section("threads", patch.threads, { enabled: "boolean", remindDays: "number", quietHours: "hours" }, next, "threads");
    section("fallback", patch.fallback, { openrouterModel: "string", ollamaModel: "string", offlineOnly: "boolean" }, next, "fallback");
    // speech.call ist verschachtelt (Issue #256): erst die flachen Felder, dann der Unterabschnitt
    const speechPatch = isPlainObject(patch.speech) ? Object.fromEntries(Object.entries(patch.speech).filter(([k]) => k !== "call")) : patch.speech;
    section("speech", speechPatch, { stt: "string", tts: "string", language: "string", model: "string", effort: "string" }, next, "speech");
    if (isPlainObject(patch.speech) && patch.speech.call !== undefined) {
      const target: Record<string, any> = isPlainObject(next.speech) ? next.speech : {};
      section("call", patch.speech.call, { model: "string", effort: "string", claudeVia: "string", tts: "string", stt: "string", elevenlabsVoice: "string", elevenlabsModel: "string" }, target, "speech.call");
      if (isPlainObject(target.call) && Object.keys(target.call).length === 0) delete target.call;
      next.speech = target;
    }
    // Sprechen gewechselt: Telegram-Wahl wie bei „Verwenden" der eigenen Stimme (Issue #253)
    if (isPlainObject(patch.speech) && patch.speech.tts !== undefined && isPlainObject(next.speech)) {
      next.speech = withTtsChoice({ ...next.speech, tts: current?.speech?.tts }, next.speech.tts as string | undefined);
    }
    const agents = patch.agents;
    if (agents === null) {
      delete next.agents;
      changed.push("agents");
    } else if (agents !== undefined) {
      if (!isPlainObject(agents)) throw new PatchError("Falscher Typ: agents");
      // Erst alle Namen prüfen, dann ändern
      for (const name of Object.keys(agents)) {
        if (!agentNames.includes(name)) throw new PatchError(`${SETTINGS_TEXT.unknownAgent}: ${safeName(name)}`);
      }
      const target: Record<string, any> = isPlainObject(next.agents) ? next.agents : {};
      for (const name of Object.keys(agents)) section(name, agents[name], MODEL_EFFORT, target, `agents.${name}`);
      next.agents = target;
    }
    // Motor (Issues #126/#129): nie als Ganzes entfernen, topics bleiben unberührt
    const engine = patch.engine;
    if (engine !== undefined) {
      if (!isPlainObject(engine)) throw new PatchError("Falscher Typ: engine");
      for (const key of Object.keys(engine)) {
        if (key !== "default" && key !== "codex" && key !== "opencode") throw new PatchError(`Unbekanntes Feld: engine.${safeName(key)}`);
      }
      const target: Record<string, any> = isPlainObject(next.engine) ? next.engine : {};
      leaf(target, "default", engine.default, "string", "engine.default");
      section("codex", engine.codex, { model: "string", effort: "string", sandbox: "string" }, target, "engine.codex");
      section("opencode", engine.opencode, { model: "string", variant: "string", permission: "string" }, target, "engine.opencode");
      for (const name of ["codex", "opencode"]) {
        if (isPlainObject(target[name]) && Object.keys(target[name]).length === 0) delete target[name];
      }
      next.engine = target;
    }
  } catch (e) {
    if (e instanceof PatchError) return { ok: false, error: e.message };
    throw e;
  }

  // Leere Objekte entfernen, damit die Datei aufgeräumt bleibt
  if (isPlainObject(next.agents)) {
    for (const [name, entry] of Object.entries(next.agents)) {
      if (isPlainObject(entry) && Object.keys(entry).length === 0) delete next.agents[name];
    }
  }
  for (const key of ["defaults", "agents", "aux", "fallback", "engine", "speech", "threads"]) {
    if (isPlainObject(next[key]) && Object.keys(next[key]).length === 0) delete next[key];
  }
  return { ok: true, value: next as SettingsData, changed };
}

/** Was für einen Agenten gälte, wenn er keinen eigenen Eintrag hätte */
export type InheritedAgentValues = Record<string, Pick<EffectiveSettings["agents"][string], "model" | "effort">>;

/**
 * Geerbte Werte je Agent für „Standard (…)" in der WebUI (Issue #38), je Feld:
 * der wirksame Wert nach genau der Teiländerung, die „Standard" im Browser
 * sendet ({ model: null } oder { effort: null }), über applySettingsPatch und
 * dieselben Resolver (port.effective). Das andere eigene Feld bleibt dabei
 * stehen: Der Standard-Effort hängt vom Modell ab (defaultEffort), deshalb
 * gilt er für das gespeicherte eigene Modell. So verspricht die Auswahl nie
 * einen anderen Wert als den, der nach dem Speichern gilt, und niemand
 * dupliziert die Voreinstellungen, weder hier noch im Browser.
 */
export function inheritedAgentValues(
  port: Pick<SettingsPort, "agents" | "effective">,
  settings: SettingsData,
  effective: EffectiveSettings = port.effective(settings)
): InheritedAgentValues {
  const out: InheritedAgentValues = {};
  const afterReset = (name: string, field: keyof ModelAndEffort) => {
    const own = settings.agents && isPlainObject(settings.agents[name]) ? settings.agents[name] : undefined;
    if (!own || own[field] === undefined) return effective.agents[name];
    const reset = applySettingsPatch(settings, { agents: { [name]: { [field]: null } } }, port.agents);
    return reset.ok ? port.effective(reset.value).agents[name] : undefined;
  };
  for (const name of port.agents) {
    const model = afterReset(name, "model")?.model;
    const effort = afterReset(name, "effort")?.effort;
    if (model && effort) out[name] = { model, effort };
  }
  return out;
}

/**
 * Geerbte Werte für den Reiter „Modelle" (Issue #39). null beim Standard
 * heißt: Ohne Standardwert gilt je Agent etwas anderes (Agenten-Dateien).
 */
export interface InheritedGlobalValues {
  defaults: { model: Sourced<string> | null; effort: Sourced<string | null> | null };
  aux: Record<AuxPurpose, Sourced<string>>;
  fallback: EffectiveSettings["fallback"];
  /** Standard-Motor ohne eigenen Wert in der Datei (TYBO_ENGINE oder Claude Code), Issue #126 */
  engine?: { default: Sourced<string> };
  /** Hören und Sprechen ohne eigenen Wert in der Datei (SPEECH_STT/SPEECH_TTS oder auto), Issue #248 */
  speech?: Record<SpeechField, Sourced<string>>;
  /** Offene Fäden ohne eigenen Wert in der Datei (.env oder Standard), Issue #293 */
  threads?: ThreadsEffective;
}

/** Ein Wert, wenn alle gleich sind (gleicher Wert und gleiche Quelle), sonst null */
function common<T>(list: Sourced<T>[]): Sourced<T> | null {
  if (!list.length) return null;
  const [first] = list;
  return list.every(e => e.value === first.value && e.source === first.source) ? first : null;
}

/**
 * Wie inheritedAgentValues, für Standard, Aux und Fallback (Issue #39): je
 * Feld der wirksame Wert nach genau der Teiländerung, die „Standard" im
 * Browser sendet ({ aux: { judge: null } } usw.), über applySettingsPatch und
 * port.effective. Beim Standardmodell und Standard-Effort zählt, was ein
 * Agent ohne eigenen Wert bekäme; dafür werden die Agenten-Einträge dabei
 * weggelassen. Unterscheidet sich das je Agent, ist der Wert null. Der
 * Standard-Effort gilt, wie bei den Agenten, für das gespeicherte
 * Standardmodell. Eigene Werte an anderer Stelle bleiben stehen; Voreinstellungen
 * aus .env und Code baut hier niemand nach.
 */
export function inheritedGlobalValues(
  port: Pick<SettingsPort, "agents" | "effective">,
  settings: SettingsData,
  effective: EffectiveSettings = port.effective(settings)
): InheritedGlobalValues {
  const after = (patch: Record<string, unknown>, own: unknown): EffectiveSettings | null => {
    if (own === undefined && !("agents" in patch)) return effective;
    const reset = applySettingsPatch(settings, patch, port.agents);
    return reset.ok ? port.effective(reset.value) : null;
  };
  const defaultsFor = (field: keyof ModelAndEffort) => {
    const eff = after({ defaults: { [field]: null }, agents: null }, settings.defaults?.[field]);
    return eff ? common(port.agents.map(name => eff.agents[name]?.[field]).filter(Boolean) as Sourced<any>[]) : null;
  };
  const aux = {} as InheritedGlobalValues["aux"];
  for (const purpose of AUX_PURPOSES) {
    const eff = after({ aux: { [purpose]: null } }, settings.aux?.[purpose]);
    aux[purpose] = (eff ?? effective).aux[purpose];
  }
  const fallback = {} as InheritedGlobalValues["fallback"];
  for (const key of ["openrouterModel", "ollamaModel", "offlineOnly"] as const) {
    const eff = after({ fallback: { [key]: null } }, settings.fallback?.[key]);
    (fallback as Record<string, unknown>)[key] = (eff ?? effective).fallback[key];
  }
  const out: InheritedGlobalValues = { defaults: { model: defaultsFor("model"), effort: defaultsFor("effort") }, aux, fallback };
  const engineDefault = (after({ engine: { default: null } }, settings.engine?.default) ?? effective).engine?.default;
  if (engineDefault) out.engine = { default: engineDefault };
  if (effective.speech) {
    const speech = {} as Record<SpeechField, Sourced<string>>;
    for (const key of SPEECH_FIELDS) {
      const value = (after({ speech: { [key]: null } }, settings.speech?.[key]) ?? effective).speech?.[key];
      if (value) speech[key] = value;
    }
    if (SPEECH_FIELDS.every(key => speech[key])) out.speech = speech;
  }
  if (effective.threads) {
    const threads = {} as Record<ThreadsField, unknown>;
    for (const key of THREADS_FIELDS) {
      threads[key] = (after({ threads: { [key]: null } }, settings.threads?.[key]) ?? effective).threads?.[key];
    }
    if (THREADS_FIELDS.every(key => threads[key])) out.threads = threads as unknown as ThreadsEffective;
  }
  return out;
}

export interface SettingsApi {
  get(): Promise<ApiResult>;
  patch(body: string): Promise<ApiResult>;
}

export function createSettingsApi(
  port: SettingsPort,
  log: (message: string) => void,
  clock: RevisionClock = createRevisionClock()
): SettingsApi {
  // Schreibkette: Lesen, Zusammenführen und Schreiben am Stück. Auch GET läuft
  // durch die Kette, damit ein Stand nie mitten aus einem Schreibvorgang kommt
  // und die Versionen in der Reihenfolge der Stände vergeben werden.
  let chain: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    // Mit port.lock dieselbe Schreibkette wie /motor (Issue #125)
    if (port.lock) return port.lock(fn);
    const run = chain.catch(() => {}).then(fn);
    chain = run;
    return run;
  }

  /**
   * Antwort zu einem Stand. revision versioniert den Inhalt samt fileInvalid
   * (revision.ts): Auch eine Änderung von Hand oder eine inzwischen ungültige
   * Datei ergibt eine neue Nummer, eine verspätete ältere Antwort erkennt der
   * Browser daran (Codex-Befunde Runde 5 bis 7 zu PR #43).
   */
  function view(settings: SettingsData, fileInvalid: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const effective = port.effective(settings);
    return {
      settings,
      effective,
      inherited: inheritedAgentValues(port, settings, effective),
      inheritedModels: inheritedGlobalValues(port, settings, effective),
      agents: port.agents,
      effortLevels: port.effortLevels,
      ...(port.engineOptions ? { engineOptions: port.engineOptions } : {}),
      ...(port.speechOptions ? { speechOptions: port.speechOptions() } : {}),
      fileInvalid,
      revision: clock.stamp("settings", { settings, fileInvalid }),
      ...extra,
    };
  }

  return {
    get() {
      return serialize(async () => {
        try {
          const settings = await port.readForWrite();
          return { status: 200, body: view(settings, false) };
        } catch (e) {
          if (!(e instanceof SettingsFileInvalid)) throw e;
          // An den Aufrufstellen gilt dann die letzte gültige Fassung
          return { status: 200, body: view(port.current(), true) };
        }
      });
    },

    patch(body) {
      let patch: unknown;
      try {
        patch = JSON.parse(body);
      } catch {
        return Promise.resolve({ status: 400, body: { error: SETTINGS_TEXT.invalidRequest } });
      }
      return serialize(async () => {
        let current: SettingsData;
        try {
          current = await port.readForWrite();
        } catch (e) {
          if (e instanceof SettingsFileInvalid) return { status: 409, body: { error: SETTINGS_TEXT.fileInvalid } };
          throw e;
        }
        const merged = applySettingsPatch(current, patch, port.agents);
        if (!merged.ok) return { status: 400, body: { error: merged.error } };
        const checked = port.validate(merged.value);
        if (!checked.ok) {
          const detail = checked.issues.map(i => `${i.path} (${i.message})`).join(", ");
          return { status: 400, body: { error: `Ungültige Einstellungen: ${detail}`, issues: checked.issues } };
        }
        try {
          await port.write(checked.value);
        } catch (e) {
          log(`Einstellungen nicht gespeichert (${e instanceof Error ? e.name : typeof e})`);
          return { status: 500, body: { error: SETTINGS_TEXT.notSaved } };
        }
        // Nur Feldnamen ins Log, nie Werte
        if (merged.changed.length) log(`Einstellungen geändert: ${merged.changed.join(", ")}`);
        // Alle Werte dieses Meilensteins greifen ohne Neustart (Hot-Reload an den Aufrufstellen)
        return { status: 200, body: view(checked.value, false, { restartRequired: false }) };
      });
    },
  };
}
