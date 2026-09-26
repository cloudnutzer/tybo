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
  aux?: { judge?: string; distill?: string; review?: string };
  fallback?: { openrouterModel?: string; ollamaModel?: string; offlineOnly?: boolean };
}

export const AUX_PURPOSES = ["judge", "distill", "review"] as const;
export type AuxPurpose = (typeof AUX_PURPOSES)[number];

/** Was an den Aufrufstellen tatsächlich gilt, mit Quelle */
export interface EffectiveSettings {
  /** effort null: kein Effort, die Claude CLI entscheidet */
  agents: Record<string, { model: Sourced<string>; effort: Sourced<string | null> }>;
  /** Format <claude|openrouter|ollama>:<modell> */
  aux: Record<AuxPurpose, Sourced<string>>;
  fallback: { openrouterModel: Sourced<string>; ollamaModel: Sourced<string>; offlineOnly: Sourced<boolean> };
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
  /** Wirksame Werte für genau diesen Stand */
  effective(settings: SettingsData): EffectiveSettings;
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
  function leaf(target: Record<string, unknown>, key: string, raw: unknown, kind: "string" | "boolean", path: string) {
    if (raw === undefined) return;
    if (isRemoval(raw)) {
      delete target[key];
    } else if (kind === "string" && typeof raw === "string") {
      target[key] = raw.trim();
    } else if (kind === "boolean" && typeof raw === "boolean") {
      target[key] = raw;
    } else {
      throw new PatchError(`Falscher Typ: ${path}`);
    }
    changed.push(path);
  }

  /** Abschnitt mit festen Blättern; null entfernt den ganzen Abschnitt */
  function section(name: string, raw: unknown, fields: Record<string, "string" | "boolean">, parent: Record<string, any>, path: string) {
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
      if (!["defaults", "agents", "aux", "fallback"].includes(key)) throw new PatchError(`Unbekanntes Feld: ${safeName(key)}`);
    }
    section("defaults", patch.defaults, MODEL_EFFORT, next, "defaults");
    section("aux", patch.aux, { judge: "string", distill: "string", review: "string" }, next, "aux");
    section("fallback", patch.fallback, { openrouterModel: "string", ollamaModel: "string", offlineOnly: "boolean" }, next, "fallback");
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
  for (const key of ["defaults", "agents", "aux", "fallback"]) {
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
  return { defaults: { model: defaultsFor("model"), effort: defaultsFor("effort") }, aux, fallback };
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
