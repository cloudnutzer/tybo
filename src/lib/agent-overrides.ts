import { atomicWriteFile } from "./atomic-file";
/**
 * Agent-Overrides — Agenten per Telegram anpassen (/agent).
 *
 * Statt die src/agents/*.ts-Dateien anzufassen (Syntaxfehler wuerden den Bot
 * killen), liegen User-Anpassungen als Anweisungs-Liste pro Agent in
 * config/agent-overrides.json und werden beim Prompt-Bau an den System-Prompt
 * angehaengt. Hot-Reload via mtime (gleiches Muster wie config/topics.json).
 *
 * In laufenden Resume-Sessions greifen Aenderungen erst mit der naechsten
 * frischen Session (/new erzwingt das sofort) — der System-Prompt wird nur
 * beim Session-Start gesendet.
 */

import { readFileSync, statSync } from "fs";
import { mkdir, readFile } from "fs/promises";
import { dirname, join } from "path";

const DEFAULT_PATH = join(process.cwd(), "config", "agent-overrides.json");
let OVERRIDES_PATH = DEFAULT_PATH;

type OverridesConfig = Record<string, string[]>;

let cache: { config: OverridesConfig; mtimeMs: number } | null = null;

/** Nur fuer Tests und web:dev: andere Datei verwenden (ohne Argument: config/agent-overrides.json). */
export function setAgentOverridesPath(path?: string): void {
  OVERRIDES_PATH = path ?? DEFAULT_PATH;
  cache = null;
}

/**
 * Schreibkette (WebUI, Issue #36): Lesen, Aendern und Schreiben laufen am
 * Stueck, damit /agent aus Telegram und die WebUI gleichzeitig keine
 * Anweisungen verlieren.
 */
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.catch(() => {}).then(fn);
  writeChain = run;
  return run;
}

function loadOverrides(): OverridesConfig {
  try {
    const mtimeMs = statSync(OVERRIDES_PATH).mtimeMs;
    if (cache?.mtimeMs !== mtimeMs) {
      const parsed = JSON.parse(readFileSync(OVERRIDES_PATH, "utf-8"));
      cache = { config: parsed && typeof parsed === "object" ? parsed : {}, mtimeMs };
    }
    return cache!.config;
  } catch {
    return {};
  }
}

/** Anweisungen fuer einen Agenten (leeres Array wenn keine). */
export function getAgentOverrides(agentName: string): string[] {
  const list = loadOverrides()[agentName.toLowerCase()];
  return Array.isArray(list) ? list.filter((s) => typeof s === "string" && s.trim()) : [];
}

/**
 * Prompt-Sektion fuer den System-Prompt ("" wenn keine Overrides).
 * Die Anweisungen des Users haben Vorrang vor dem Standard-Verhalten.
 */
export function formatOverridesSection(agentName: string): string {
  const overrides = getAgentOverrides(agentName);
  if (overrides.length === 0) return "";
  return `## USER-ANPASSUNGEN (via /agent — haben Vorrang vor allem oben)\n${overrides
    .map((o) => `- ${o}`)
    .join("\n")}`;
}

async function persist(config: OverridesConfig): Promise<void> {
  await mkdir(dirname(OVERRIDES_PATH), { recursive: true });
  await atomicWriteFile(OVERRIDES_PATH, JSON.stringify(config, null, 2) + "\n");
  cache = null; // next read reloads
}

async function loadForWrite(): Promise<OverridesConfig> {
  try {
    const parsed = JSON.parse(await readFile(OVERRIDES_PATH, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Verbindlicher Schreibbeginn (Befehle aus Browser und Terminal, Issue #74):
 * laeuft innerhalb der Schreibkette vor dem Lesen. Wirft er, bleibt die Datei
 * unberuehrt; kehrt er zurueck, gilt die Aenderung als begonnen.
 */
export type WriteStart = () => void;

/** Anweisung hinzufuegen. Liefert die neue Anzahl fuer den Agenten. */
export function addAgentOverride(
  agentName: string,
  instruction: string,
  onWriteStart?: WriteStart
): Promise<number> {
  return serialize(async () => {
    onWriteStart?.();
    const config = await loadForWrite();
    const key = agentName.toLowerCase();
    const list = Array.isArray(config[key]) ? config[key] : [];
    list.push(instruction.trim());
    config[key] = list;
    await persist(config);
    return list.length;
  });
}

/** Die Liste hat sich seit der Anzeige geaendert; nichts geschrieben (WebUI, PR #43) */
export class AgentOverridesChanged extends Error {
  constructor() {
    super("Agent-Overrides inzwischen geaendert");
    this.name = "AgentOverridesChanged";
  }
}

/**
 * Mit unchanged (nur WebUI): innerhalb der Schreibkette pruefen, ob die Liste
 * noch so aussieht wie angezeigt (gleiche Sicht wie getAgentOverrides).
 * Sonst AgentOverridesChanged. Telegram (/agent) uebergibt nichts.
 */
export type UnchangedCheck = (list: readonly string[]) => boolean;

function assertUnchanged(config: OverridesConfig, key: string, unchanged?: UnchangedCheck): void {
  if (!unchanged) return;
  const raw = config[key];
  const list = Array.isArray(raw) ? raw.filter((s) => typeof s === "string" && s.trim()) : [];
  if (!unchanged(list)) throw new AgentOverridesChanged();
}

/** Alle Anweisungen eines Agenten loeschen. Liefert wie viele es waren. */
export function clearAgentOverrides(
  agentName: string,
  unchanged?: UnchangedCheck,
  onWriteStart?: WriteStart
): Promise<number> {
  return serialize(async () => {
    onWriteStart?.();
    const config = await loadForWrite();
    const key = agentName.toLowerCase();
    assertUnchanged(config, key, unchanged);
    const count = Array.isArray(config[key]) ? config[key].length : 0;
    delete config[key];
    await persist(config);
    return count;
  });
}

/** Die letzte Anweisung eines Agenten entfernen (undo). */
export function removeLastAgentOverride(
  agentName: string,
  unchanged?: UnchangedCheck,
  onWriteStart?: WriteStart
): Promise<string | undefined> {
  return serialize(async () => {
    onWriteStart?.();
    const config = await loadForWrite();
    const key = agentName.toLowerCase();
    assertUnchanged(config, key, unchanged);
    const list = Array.isArray(config[key]) ? config[key] : [];
    const removed = list.pop();
    if (removed === undefined) return undefined;
    if (list.length === 0) delete config[key];
    else config[key] = list;
    await persist(config);
    return removed;
  });
}

/**
 * Uebersicht aller Agenten mit Overrides (fuer /agent ohne Argumente).
 * Mit isActive nur Agenten, die es im Katalog noch gibt (Issue #49).
 */
export function listAllOverrides(isActive?: (agent: string) => boolean): Record<string, string[]> {
  const config = loadOverrides();
  const result: Record<string, string[]> = {};
  for (const [agent, list] of Object.entries(config)) {
    if (isActive && !isActive(agent)) continue;
    if (Array.isArray(list) && list.length > 0) result[agent] = list;
  }
  return result;
}
