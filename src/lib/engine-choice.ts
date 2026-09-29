/**
 * Welcher Motor ein Gespräch bekommt (Entscheidung 0018, Issue #125).
 *
 * Vorrang: Ausnahme des Gesprächs (engine.topics in config/settings.json,
 * gesetzt mit /motor), dann engine.default, dann TYBO_ENGINE aus .env, dann
 * Claude Code. Ein Motor, der laut checkEngine nicht installiert oder nicht
 * angemeldet ist, wird übersprungen: dann antwortet Claude Code, mit einer
 * Log-Zeile bei jedem Turn und einer Meldung im Gespräch, einmal, bis der
 * Motor wieder bereit ist oder /motor neu gesetzt wird. Wurde der Ausfall
 * erst beim Lauf erkannt, zählt als bereit nur ein gelungener Lauf, nicht
 * schon eine positive Vorprüfung.
 *
 * Modell und Effort: für Claude pro Agent wie bisher (resolveAgentModel,
 * resolveAgentEffort), für Codex aus engine.codex, für OpenCode aus
 * engine.opencode (Variante als Effort, Issue #129); leer heißt, der Motor
 * nimmt seine eigene Konfiguration. Agenten-Modelle gehen nie an Codex oder
 * OpenCode.
 *
 * Nur für Chat-Turns (Chat-Kern, Rückfragen). Hintergrund-Jobs, Check-in,
 * Aux-Modelle, WhatsApp und VPS-Modus bleiben bei Claude.
 */

import { checkEngine, type EngineId, type EngineStatus } from "./engines";
import {
  getSettings,
  updateSettings,
  SELECTABLE_ENGINES,
  type SelectableEngine,
  type Settings,
} from "./settings";
import { resolveAgentModel, resolveAgentEffort, type AgentResolveDeps } from "../agents/base";
import type { EngineCommandServices } from "./commands/types";

export { SELECTABLE_ENGINES, type SelectableEngine };

/** Anzeigename eines Motors in Meldungen und unter der Antwort */
export const ENGINE_LABELS: Record<EngineId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export function engineLabel(id: EngineId): string {
  return ENGINE_LABELS[id] ?? id;
}

/** Woher der Motor eines Gesprächs kommt */
export type EngineSource = "topic" | "settings" | "env" | "code";

export interface EngineChoiceDeps {
  getSettings: () => Settings;
  env: () => Record<string, string | undefined>;
  checkEngine: (id: EngineId) => Promise<EngineStatus>;
  log: (line: string) => void;
}

const defaultDeps: EngineChoiceDeps = {
  getSettings,
  env: () => process.env,
  checkEngine,
  log: (line) => console.warn(line),
};

function resolveDeps(deps?: Partial<EngineChoiceDeps>): EngineChoiceDeps {
  return deps ? { ...defaultDeps, ...deps } : defaultDeps;
}

export function isSelectableEngine(value: unknown): value is SelectableEngine {
  return typeof value === "string" && (SELECTABLE_ENGINES as readonly string[]).includes(value);
}

let warnedEnv: string | undefined;

/** TYBO_ENGINE aus .env; ein unbekannter Wert wird einmal geloggt und ignoriert */
function envEngine(d: EngineChoiceDeps): SelectableEngine | undefined {
  const raw = d.env().TYBO_ENGINE?.trim().toLowerCase();
  if (!raw) return undefined;
  if (isSelectableEngine(raw)) return raw;
  if (warnedEnv !== raw) {
    warnedEnv = raw;
    d.log(`[Motor] TYBO_ENGINE="${raw.slice(0, 20)}" ist kein bekannter Motor (${SELECTABLE_ENGINES.join(", ")}), gilt Claude Code`);
  }
  return undefined;
}

/** Standard-Motor ohne Ausnahme: Einstellungsdatei, .env, Claude Code */
export function defaultEngineSetting(deps?: Partial<EngineChoiceDeps>): { engine: SelectableEngine; source: Exclude<EngineSource, "topic"> } {
  const d = resolveDeps(deps);
  const fromSettings = d.getSettings().engine?.default;
  if (fromSettings) return { engine: fromSettings, source: "settings" };
  const fromEnv = envEngine(d);
  if (fromEnv) return { engine: fromEnv, source: "env" };
  return { engine: "claude", source: "code" };
}

/** Eingestellter Motor eines Gesprächs, ohne Verfügbarkeitsprüfung */
export function configuredEngine(sessionKey: string, deps?: Partial<EngineChoiceDeps>): { engine: SelectableEngine; source: EngineSource } {
  const d = resolveDeps(deps);
  const fromTopic = d.getSettings().engine?.topics?.[sessionKey];
  if (fromTopic) return { engine: fromTopic, source: "topic" };
  return defaultEngineSetting(d);
}

/** Ausnahme des Gesprächs (/motor), sonst undefined */
export function topicEngine(sessionKey: string, deps?: Partial<EngineChoiceDeps>): SelectableEngine | undefined {
  return resolveDeps(deps).getSettings().engine?.topics?.[sessionKey];
}

/** Woher eine Nichtverfügbarkeit bekannt ist: Vorprüfung (checkEngine) oder Lauf des Motors */
export type UnavailableOrigin = "check" | "run";

// Gespräche, die die Meldung „nicht verfügbar" für einen Motor schon bekommen haben, mit Herkunft
const notified = new Map<string, UnavailableOrigin>();

/**
 * true genau beim ersten Mal je Gespräch und Motor: dann gehört die Meldung
 * ins Gespräch. Ein beim Lauf erkannter Ausfall ("run") hält die Sperre auch
 * über positive Vorprüfungen hinweg, bis ein Lauf des Motors wieder gelingt
 * (markEngineRecovered). Eine Sperre aus der Vorprüfung hebt schon die
 * nächste positive Prüfung auf. /motor setzt alles zurück (resetEngineNotice).
 */
export function shouldNotifyUnavailable(sessionKey: string, engine: EngineId, origin: UnavailableOrigin = "check"): boolean {
  const key = `${sessionKey}\0${engine}`;
  const known = notified.get(key);
  if (known === undefined) {
    notified.set(key, origin);
    return true;
  }
  if (origin === "run") notified.set(key, "run");
  return false;
}

/** Positive Vorprüfung: behebt nur eine Nichtverfügbarkeit aus der Vorprüfung, nie einen Ausfall beim Lauf */
function markCheckReady(sessionKey: string, engine: EngineId): void {
  const key = `${sessionKey}\0${engine}`;
  if (notified.get(key) === "check") notified.delete(key);
}

/** Ein Lauf des Motors hat geantwortet: wieder bereit, ein späterer Ausfall wird erneut gemeldet */
export function markEngineRecovered(sessionKey: string, engine: EngineId): void {
  notified.delete(`${sessionKey}\0${engine}`);
}

/** Nach /motor: die nächste Nichtverfügbarkeit wird wieder gemeldet */
export function resetEngineNotice(sessionKey: string): void {
  for (const key of [...notified.keys()]) if (key.startsWith(`${sessionKey}\0`)) notified.delete(key);
}

/** Nur für Tests: alle Meldungs-Sperren und die TYBO_ENGINE-Warnung zurücksetzen */
export function resetEngineChoiceForTests(): void {
  notified.clear();
  warnedEnv = undefined;
}

/** Meldung im Gespräch, wenn ein Motor übersprungen wird */
export function unavailableNotice(engine: EngineId, reason?: string): string {
  const base = `${engineLabel(engine)} ist nicht verfügbar, ich antworte mit ${engineLabel("claude")}.`;
  return reason ? `${base} ${reason}` : base;
}

export interface ResolvedEngine {
  /** Motor, mit dem der Turn läuft */
  engine: EngineId;
  /** Eingestellter Motor; weicht ab, wenn er nicht bereit war */
  requested: SelectableEngine;
  source: EngineSource;
  /** Nur beim ersten Überspringen im Gespräch: Meldung für das Gespräch */
  notice?: string;
}

/**
 * Motor für den nächsten Turn eines Gesprächs. Claude wird nicht geprüft
 * (checkEngine meldet es als bereit), andere Motoren über checkEngine;
 * nicht installiert oder nicht angemeldet heißt Claude Code.
 */
export async function resolveEngine(sessionKey: string, deps?: Partial<EngineChoiceDeps>): Promise<ResolvedEngine> {
  const d = resolveDeps(deps);
  const { engine: requested, source } = configuredEngine(sessionKey, d);
  if (requested === "claude") return { engine: "claude", requested, source };
  let status: EngineStatus;
  try {
    status = await d.checkEngine(requested);
  } catch {
    status = { engine: requested, checked: true, installed: false, loggedIn: false };
  }
  if (status.installed && status.loggedIn) {
    markCheckReady(sessionKey, requested);
    return { engine: requested, requested, source };
  }
  d.log(`[Motor] ${engineLabel(requested)} für ${sessionKey} nicht bereit (${status.message ?? "nicht installiert oder nicht angemeldet"}), antworte mit Claude Code`);
  const notice = shouldNotifyUnavailable(sessionKey, requested) ? unavailableNotice(requested, status.message) : undefined;
  return { engine: "claude", requested, source, ...(notice ? { notice } : {}) };
}

/**
 * Modell und Effort eines Turns je Motor. Claude: pro Agent (Einstellungen,
 * CLAUDE_EFFORT, Agenten-Datei). Codex: engine.codex, OpenCode:
 * engine.opencode (model, variant als Effort); fehlt ein Wert, entscheidet
 * die Konfiguration des Motors (kein Modell erfunden).
 */
export function engineModelAndEffort(
  engine: EngineId,
  agentName: string,
  deps: Partial<AgentResolveDeps> = {}
): { model?: string; effort?: string } {
  const getS = deps.getSettings ?? getSettings;
  if (engine === "claude") {
    const effort = resolveAgentEffort(agentName, deps);
    return { model: resolveAgentModel(agentName, deps), ...(effort ? { effort } : {}) };
  }
  if (engine === "codex") {
    const codex = getS().engine?.codex;
    return { ...(codex?.model ? { model: codex.model } : {}), ...(codex?.effort ? { effort: codex.effort } : {}) };
  }
  if (engine === "opencode") {
    const opencode = getS().engine?.opencode;
    return { ...(opencode?.model ? { model: opencode.model } : {}), ...(opencode?.variant ? { effort: opencode.variant } : {}) };
  }
  return {};
}

/**
 * Modell, unter dem eine Session gespeichert wird (BotSession.model ist ein
 * Pflichtfeld): das Modell selbst oder "" für den Standard des Motors.
 */
export function sessionModel(model: string | undefined): string {
  return model ?? "";
}

/** Ausnahme für ein Gespräch setzen (engine) oder entfernen (null), in der Schreibkette der Einstellungen */
export async function setTopicEngine(sessionKey: string, engine: SelectableEngine | null): Promise<void> {
  await updateSettings((current) => {
    const section = { ...(current.engine ?? {}) };
    const topics = { ...(section.topics ?? {}) };
    if (engine) topics[sessionKey] = engine;
    else delete topics[sessionKey];
    if (Object.keys(topics).length) section.topics = topics;
    else delete section.topics;
    const next = { ...current };
    if (Object.keys(section).length) next.engine = section;
    else delete next.engine;
    return next;
  });
  resetEngineNotice(sessionKey);
}

/** /motor in allen Kanälen (CommandServices.engines, Issue #125); Tests reichen eine Prüf-Attrappe herein */
export function createEngineCommandServices(deps?: Partial<Pick<EngineChoiceDeps, "checkEngine" | "getSettings" | "env">>): EngineCommandServices {
  const d = resolveDeps(deps);
  return {
    configured: (sessionKey) => configuredEngine(sessionKey, d),
    standard: () => defaultEngineSetting(d),
    async available() {
      return Promise.all(
        SELECTABLE_ENGINES.map(async (engine) => {
          let status: EngineStatus;
          try {
            status = await d.checkEngine(engine);
          } catch {
            status = { engine, checked: true, installed: false, loggedIn: false };
          }
          const ready = status.installed && status.loggedIn;
          return { engine, label: engineLabel(engine), ready, ...(!ready && status.message ? { message: status.message } : {}) };
        })
      );
    },
    async setTopic(sessionKey, engine) {
      if (engine !== null && !isSelectableEngine(engine)) throw new Error("Unbekannter Motor");
      await setTopicEngine(sessionKey, engine);
    },
  };
}

export const engineCommandServices: EngineCommandServices = createEngineCommandServices();
