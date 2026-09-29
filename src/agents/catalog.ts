/**
 * Agenten-Katalog (Issue #49, Entscheidung 0007): welche Agenten es gibt.
 *
 * - Mitgeliefert sind die Agenten aus src/agents/<name>.ts. Die Dateien
 *   bleiben unveraendert und dienen als Standard und Vorlage.
 * - Darueber liegt config/agents.json:
 *     prompts  geaenderter System-Prompt je mitgeliefertem Agenten (Vorrang vor dem Code)
 *     custom   eigene Agenten: name, description, systemPrompt, optional board
 *     deleted  geloeschte mitgelieferte Agenten (wiederherstellbar)
 *     board    Board-Schalter je Agent (Vorrang vor custom[].board und dem Standard)
 * - Lesen wie config/settings.json: neu gelesen wird, sobald sich mtime,
 *   Groesse oder Inode aendern. Ungueltige Datei: eine Log-Zeile, die letzte
 *   gueltige Fassung bleibt aktiv; beim Start ist das der reine Code-Stand.
 * - Schreiben laeuft ueber eine Schreibkette: Lesen, Aendern, Pruefen, die
 *   vorige Fassung nach data/backups/agents-<zeit>.json sichern, dann atomar
 *   ersetzen (0600). Eine kaputte Datei wird nie ueberschrieben, eine
 *   fehlgeschlagene Sicherung bricht das Schreiben ab. Ohne vorige Datei gibt
 *   es nichts zu sichern.
 *
 * Die mitgelieferten Agenten werden erst beim Zugriff per require geladen:
 * sie importieren BASE_CONTEXT aus base.ts, und base.ts importiert diesen
 * Katalog (wie zuvor der switch in getAgentConfig).
 */

import { BRAND } from "../brand";
import { readFileSync, statSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import type { AgentConfig } from "./base";
import { AGENT_ALIASES, AGENT_ID_PATTERN } from "./names";
import { atomicWriteFile } from "../lib/atomic-file";
import { readTopicsStrict, reassignTopicMappings, TOPICS_CONFIG_PATH, type TopicRef } from "../lib/topic-setup";

export type { TopicRef } from "../lib/topic-setup";

/** Mitgelieferte Agenten mit Kurzbeschreibung, General zuerst */
export const BUILTIN_AGENTS: Record<string, string> = {
  general: "General Agent - Default assistant, cross-agent orchestration",
  research: "Research Agent - Research with sources: products, technology, markets, news (ReAct reasoning)",
  content: "Content Agent (CMO) - Posts, emails, presentations, audience and tone (RoT reasoning)",
  finance: "Finance Agent (CFO) - Costs, budgets, money decisions, unit economics; no investment or tax advice (CoT reasoning)",
  strategy: "Strategy Agent (CEO) - Major decisions, options, long-term consequences (ToT reasoning)",
  critic: "Critic Agent - Devil's advocate, pre-mortem, stress-testing (internal, not topic-bound)",
  cto: `CTO Agent (Tech & Learning) - Technology, learning, projects with AI, self-hosting, ${BRAND.name} itself (Systematic reasoning)`,
  coo: "COO Agent (Operations) - Tasks, schedules, processes, organization (Process/Systems reasoning)",
};

const BUILTIN_LOADERS: Record<string, () => AgentConfig> = {
  general: () => require("./general").default,
  research: () => require("./research").default,
  content: () => require("./content").default,
  finance: () => require("./finance").default,
  strategy: () => require("./strategy").default,
  critic: () => require("./critic").default,
  cto: () => require("./cto").default,
  coo: () => require("./coo").default,
};

/** Bisherige /board-Reihenfolge der mitgelieferten Agenten; General moderiert und ist nie Teilnehmer */
const BUILTIN_BOARD_ORDER = ["research", "content", "finance", "strategy", "cto", "coo", "critic"];

/** Eigene Agenten duerfen diese mitgelieferten fragen (Issue #49) */
const CUSTOM_MAY_INVOKE = ["critic", "research"];

/**
 * Weitere Namen, die keine Kennung werden duerfen: Aliasse, die nur /agent in
 * bot.ts kennt. Mit AGENT_ALIASES aus names.ts zusammen alle bekannten Aliasse.
 */
const EXTRA_RESERVED = ["outreach", "tech"];

export const DESCRIPTION_MAX = 200;
export const PROMPT_MAX = 20_000;

export class AgentCatalogError extends Error {}
/** Kein aktiver Agent (bzw. kein geloeschter mitgelieferter beim Wiederherstellen) unter diesem Namen */
export class AgentCatalogNotFound extends AgentCatalogError {}
/** Kennung ist schon Agent, Alias oder geloeschter mitgelieferter Agent */
export class AgentCatalogNameTaken extends AgentCatalogError {}
/** config/topics.json vor dem Loeschen unlesbar: nichts geaendert */
export class AgentCatalogTopicsInvalid extends AgentCatalogError {
  constructor() {
    super("config/topics.json ist nicht lesbar oder ungültig; nichts gelöscht");
  }
}
/**
 * Loeschen halb gelungen: der Agent ist aus dem Katalog entfernt, seine
 * Topics wurden aber nicht auf General umgestellt (sie antworten zur
 * Laufzeit trotzdem ueber General).
 */
export class AgentCatalogTopicsNotMoved extends AgentCatalogError {
  constructor() {
    super("Agent gelöscht, aber config/topics.json nicht umgestellt");
  }
}
/** config/agents.json ist unlesbar oder ungueltig; Schreiben verweigert, damit nichts verloren geht */
export class AgentCatalogFileInvalid extends AgentCatalogError {
  constructor() {
    super("config/agents.json ist ungültig; bitte zuerst reparieren oder aus data/backups wiederherstellen");
  }
}

const promptText = z
  .string()
  .max(PROMPT_MAX, `System-Prompt höchstens ${PROMPT_MAX} Zeichen`)
  .refine(v => v.trim().length > 0, "System-Prompt darf nicht leer sein");
const descriptionText = z
  .string()
  .refine(v => v.trim().length > 0, "Beschreibung darf nicht leer sein")
  .refine(v => v.trim().length <= DESCRIPTION_MAX, `Beschreibung höchstens ${DESCRIPTION_MAX} Zeichen`)
  .refine(v => !/[\u0000-\u001f\u007f]/.test(v), "Beschreibung ist eine Zeile ohne Steuerzeichen");

const customAgent = z
  .object({
    name: z.string().regex(AGENT_ID_PATTERN, "Kennung: a-z, 0-9 und -, 2 bis 30 Zeichen, beginnt mit Buchstabe"),
    description: descriptionText,
    systemPrompt: promptText,
    board: z.boolean().optional(),
  })
  .strict();

const catalogSchema = z
  .object({
    prompts: z.record(z.string(), promptText).optional(),
    custom: z.array(customAgent).optional(),
    deleted: z.array(z.string()).optional(),
    board: z.record(z.string(), z.boolean()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [i, agent] of (value.custom ?? []).entries()) {
      if (isReservedName(agent.name) || seen.has(agent.name)) {
        ctx.addIssue({ code: "custom", path: ["custom", i, "name"], message: `Kennung vergeben: ${agent.name}` });
      }
      seen.add(agent.name);
    }
    for (const [i, name] of (value.deleted ?? []).entries()) {
      if (!(name in BUILTIN_AGENTS) || name === "general") {
        ctx.addIssue({ code: "custom", path: ["deleted", i], message: `nicht löschbar: ${name}` });
      }
    }
    for (const name of Object.keys(value.prompts ?? {})) {
      if (!(name in BUILTIN_AGENTS)) ctx.addIssue({ code: "custom", path: ["prompts", name], message: "kein mitgelieferter Agent" });
    }
  });

export type CatalogFile = z.infer<typeof catalogSchema>;

export interface CatalogAgent {
  /** Kennung, z.B. "research" oder "projekt-planer" */
  name: string;
  /** Anzeigename: bei mitgelieferten AgentConfig.name, bei eigenen die Kennung */
  displayName: string;
  description: string;
  origin: "builtin" | "custom";
  /** "code": Prompt aus src/agents/<name>.ts; "custom": aus config/agents.json */
  promptSource: "code" | "custom";
  /** Prompt, wie er gespeichert ist (bei mitgelieferten inklusive BASE_CONTEXT aus dem Code) */
  systemPrompt: string;
  board: boolean;
}

const DEFAULT_FILE = join(process.cwd(), "config", "agents.json");
const DEFAULT_BACKUP_DIR = join(process.cwd(), "data", "backups");

let paths = { file: DEFAULT_FILE, backupDir: DEFAULT_BACKUP_DIR, topicsFile: TOPICS_CONFIG_PATH };
const EMPTY: CatalogFile = Object.freeze({}) as CatalogFile;
let cache: { version: string | null; data: CatalogFile } = { version: null, data: EMPTY };
let lastValid: CatalogFile = EMPTY;

/**
 * Nur fuer Tests und web:dev: andere Dateien verwenden (ohne Argument die
 * echten Pfade config/agents.json, data/backups, config/topics.json). Setzt
 * den Lesezustand zurueck.
 */
export function setAgentCatalogPaths(p: { file?: string; backupDir?: string; topicsFile?: string } = {}): void {
  paths = {
    file: p.file ?? DEFAULT_FILE,
    backupDir: p.backupDir ?? DEFAULT_BACKUP_DIR,
    topicsFile: p.topicsFile ?? TOPICS_CONFIG_PATH,
  };
  cache = { version: null, data: EMPTY };
  lastValid = EMPTY;
}

export function getAgentCatalogPaths(): Readonly<typeof paths> {
  return paths;
}

/** Pfadteile, die ins Log duerfen: Feldnamen des Schemas und mitgelieferte Agenten */
const LOG_PATH_PARTS = new Set<string>([
  "prompts", "custom", "deleted", "board", "name", "description", "systemPrompt",
  ...Object.keys(BUILTIN_AGENTS),
]);

/** Feste Texte je Fehlerart; i.message kann Werte oder Schluessel der Datei enthalten */
const ISSUE_TEXT: Partial<Record<z.ZodIssueCode, string>> = {
  invalid_type: "falscher Typ",
  unrecognized_keys: "unbekanntes Feld",
  too_big: "zu lang",
  too_small: "zu kurz",
  invalid_string: "ungültiges Format",
  custom: "ungültiger Wert",
};

/**
 * Meldungen ohne Inhalte der Datei (Issue #50: nie Prompt-Texte ins Log):
 * nur feste Texte je Fehlerart und freigegebene Strukturpfade, alles
 * andere wird zu "?"
 */
function issuesText(error: z.ZodError): string {
  const part = (p: PropertyKey) => (typeof p === "number" || LOG_PATH_PARTS.has(String(p)) ? String(p) : "?");
  return error.issues.map(i => `${i.path.map(part).join(".") || "(Wurzel)"}: ${ISSUE_TEXT[i.code] ?? "ungültig"}`).join("; ");
}

/** Aktueller Stand der Datei; liest nur neu, wenn sie sich geaendert hat */
function load(): CatalogFile {
  let version: string;
  try {
    const st = statSync(paths.file);
    version = `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      cache = { version: null, data: EMPTY };
      lastValid = EMPTY;
      return EMPTY;
    }
    console.error(`[AgentCatalog] ${paths.file} nicht lesbar (${err?.code ?? err}), letzte gültige Fassung bleibt`);
    return lastValid;
  }
  if (cache.version === version) return cache.data;
  let data: CatalogFile;
  // Nie die Meldung des JSON-Parsers ins Log: sie kann Ausschnitte der Datei (Prompts) enthalten
  let reason: string | null = null;
  try {
    const parsed = catalogSchema.safeParse(JSON.parse(readFileSync(paths.file, "utf-8")));
    if (parsed.success) {
      data = parsed.data;
      lastValid = data;
    } else {
      reason = issuesText(parsed.error);
      data = lastValid;
    }
  } catch (err: any) {
    reason = err instanceof SyntaxError ? "kein gültiges JSON" : `nicht lesbar (${err?.code ?? (err instanceof Error ? err.name : typeof err)})`;
    data = lastValid;
  }
  if (reason !== null) console.error(`[AgentCatalog] ${paths.file} ungültig, letzte gültige Fassung bleibt: ${reason}`);
  cache = { version, data };
  return data;
}

function isReservedName(name: string): boolean {
  return name in BUILTIN_AGENTS || name in AGENT_ALIASES || EXTRA_RESERVED.includes(name);
}

function builtinConfig(name: string): AgentConfig {
  return BUILTIN_LOADERS[name]();
}

function effectiveBoard(data: CatalogFile, name: string, fallback: boolean): boolean {
  return data.board?.[name] ?? fallback;
}

function describe(data: CatalogFile, name: string): CatalogAgent | undefined {
  if (name in BUILTIN_AGENTS) {
    if (data.deleted?.includes(name)) return undefined;
    const override = data.prompts?.[name];
    return {
      name,
      displayName: builtinConfig(name).name,
      description: BUILTIN_AGENTS[name],
      origin: "builtin",
      promptSource: override !== undefined ? "custom" : "code",
      systemPrompt: override ?? builtinConfig(name).systemPrompt,
      board: name !== "general" && effectiveBoard(data, name, true),
    };
  }
  const custom = data.custom?.find(a => a.name === name);
  if (!custom) return undefined;
  return {
    name,
    displayName: name,
    description: custom.description.trim(),
    origin: "custom",
    promptSource: "custom",
    systemPrompt: custom.systemPrompt,
    board: effectiveBoard(data, name, custom.board ?? false),
  };
}

function activeNames(data: CatalogFile): string[] {
  const builtins = Object.keys(BUILTIN_AGENTS).filter(n => !data.deleted?.includes(n));
  return [...builtins, ...(data.custom ?? []).map(a => a.name)];
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

/** Aktive Agenten: mitgelieferte (ohne geloeschte) in fester Reihenfolge, dann eigene */
export function listAgents(): CatalogAgent[] {
  const data = load();
  return activeNames(data).map(n => describe(data, n)!);
}

/** Nur die Kennungen der aktiven Agenten, General zuerst */
export function listAgentNames(): string[] {
  return activeNames(load());
}

/** true, wenn die Kennung (kein Alias) ein aktiver Agent ist */
export function isActiveAgent(name: string): boolean {
  return activeNames(load()).includes(name);
}

/**
 * System-Prompt aus src/agents/<name>.ts, unveraendert (Standard und
 * Vorlage zum Bearbeiten, Issue #50); auch fuer geloeschte mitgelieferte.
 * Anders als getCatalogAgentConfig ohne Laufzeit-Zusaetze.
 */
export function getBuiltinCodePrompt(name: string): string | undefined {
  return name in BUILTIN_AGENTS ? builtinConfig(name).systemPrompt : undefined;
}

/** true, wenn die Kennung schon vergeben ist: Agent (auch geloeschter mitgelieferter), Alias oder eigener Agent */
export function isAgentNameTaken(name: string): boolean {
  return isReservedName(name) || (load().custom ?? []).some(a => a.name === name);
}

/** Topic mit seiner Zuordnung aus config/topics.json; agent als Kennung (Aliasse aufgeloest) */
export interface TopicUsage extends TopicRef {
  agent: string;
}

/**
 * Alle Zuordnungen aus config/topics.json (alle Chat-IDs und "*"), Aliasse
 * aufgeloest wie beim Loeschen. Wirft, wenn die Datei unlesbar ist.
 */
export async function listTopicUsage(): Promise<TopicUsage[]> {
  const config = await readTopicsStrict(paths.topicsFile);
  const out: TopicUsage[] = [];
  for (const [chatId, chat] of Object.entries(config)) {
    if (!chat || typeof chat !== "object" || Array.isArray(chat)) continue;
    for (const [topicKey, agent] of Object.entries(chat as Record<string, unknown>)) {
      if (typeof agent !== "string") continue;
      const lower = agent.toLowerCase();
      out.push({ chatId, topicId: Number(topicKey), agent: AGENT_ALIASES[lower] ?? lower });
    }
  }
  return out;
}

/** Geloeschte mitgelieferte Agenten (wiederherstellbar) */
export function listDeletedBuiltins(): string[] {
  const deleted = load().deleted ?? [];
  return Object.keys(BUILTIN_AGENTS).filter(n => deleted.includes(n));
}

/**
 * Kennung zu einem Namen oder Alias ("CFO" wird "finance"), nur wenn der
 * Agent aktiv ist; sonst undefined.
 */
export function resolveAgentName(raw: string): string | undefined {
  const lower = raw.trim().toLowerCase();
  const name = AGENT_ALIASES[lower] ?? lower;
  return activeNames(load()).includes(name) ? name : undefined;
}

/** Aktiver Agent zu Name oder Alias, sonst undefined */
export function getAgent(raw: string): CatalogAgent | undefined {
  const name = resolveAgentName(raw);
  return name ? describe(load(), name) : undefined;
}

/**
 * AgentConfig fuer Claude-Aufrufe. Mitgelieferte: Datei aus src/agents mit
 * dem Prompt aus config/agents.json, falls geaendert. Eigene: BASE_CONTEXT
 * plus eigener Prompt, Modell und Effort wie General im Code (Einstellungen
 * aus config/settings.json gehen an den Aufrufstellen vor). General und
 * eigene Agenten bekommen einen Hinweis, wen sie per [INVOKE:] fragen koennen.
 */
export function getCatalogAgentConfig(raw: string): AgentConfig | undefined {
  const data = load();
  const name = resolveAgentName(raw);
  if (!name) return undefined;
  const agent = describe(data, name)!;
  if (agent.origin === "builtin") {
    const config = builtinConfig(name);
    let systemPrompt = withLongTaskRules(agent.systemPrompt);
    if (name === "general") systemPrompt += customInvokeHint(data);
    return systemPrompt === config.systemPrompt ? config : { ...config, systemPrompt };
  }
  const general = builtinConfig("general");
  const { BASE_CONTEXT } = require("./base") as typeof import("./base");
  const targets = CUSTOM_MAY_INVOKE.filter(t => activeNames(data).includes(t));
  const invoke = targets.length
    ? `\n\n## CROSS-AGENT CONSULTATION (VISIBLE)\nWhen you need another agent's perspective, use [INVOKE:agent|Your question]. Available: ${targets.join(", ")}.\n`
    : "";
  return {
    name,
    systemPrompt: `${BASE_CONTEXT}\n\n${agent.systemPrompt}${invoke}`,
    model: general.model,
    ...(general.effort ? { effort: general.effort } : {}),
  };
}

/**
 * Ein gespeicherter Prompt (config/agents.json) ersetzt den Code-Prompt ganz,
 * also auch BASE_CONTEXT. Fehlt ihm der Block LONG TASKS (Issue #180), wird er
 * beim Aufruf angehaengt; die Datei bleibt unveraendert. Die Ueberschrift
 * allein reicht nicht: eine aus dem Code uebernommene Fassung mit alten
 * Minuten wird im Laufzeit-Prompt durch die aktuelle ersetzt, jede andere
 * Fassung (unvollstaendig, umformuliert) bleibt stehen und die aktuelle
 * kommt dahinter.
 */
function withLongTaskRules(prompt: string): string {
  const { LONG_TASK_RULES } = require("./base") as typeof import("./base");
  if (prompt.includes(LONG_TASK_RULES)) return prompt;
  const stale = staleLongTaskRules(LONG_TASK_RULES);
  if (stale.test(prompt)) return prompt.replace(stale, () => LONG_TASK_RULES);
  return `${prompt}\n\n${LONG_TASK_RULES}\n`;
}

/** Erkennt den Block aus dem Code mit beliebigen Minutenwerten */
function staleLongTaskRules(rules: string): RegExp {
  const escaped = rules.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/\d+/g, "\\d+(?:\\.\\d+)?"));
}

/** Zusatz fuer General: eigene Agenten, die er fragen kann (leer ohne eigene Agenten) */
function customInvokeHint(data: CatalogFile): string {
  const custom = data.custom ?? [];
  if (custom.length === 0) return "";
  const lines = custom.map(a => `- **${a.name}** — ${a.description.trim()}`).join("\n");
  return `\n\n## ADDITIONAL AGENTS (user-defined)\nYou can also invoke these with [INVOKE:agent|question]:\n${lines}\n`;
}

/**
 * Darf source per [INVOKE:] target fragen? Geloeschte oder unbekannte Ziele
 * nie. Mitgelieferte nach AGENT_INVOCATION_MAP, General zusaetzlich alle
 * eigenen Agenten, eigene Agenten nur critic und research.
 */
export function canInvokeInCatalog(source: string, target: string, builtinMap: Record<string, string[]>): boolean {
  const data = load();
  const active = activeNames(data);
  const lowerTarget = target.toLowerCase();
  const to = AGENT_ALIASES[lowerTarget] ?? lowerTarget;
  if (!active.includes(to)) return false;
  const lowerSource = source.toLowerCase();
  const from = AGENT_ALIASES[lowerSource] ?? lowerSource;
  const isCustom = (n: string) => (data.custom ?? []).some(a => a.name === n);
  if (isCustom(from)) return CUSTOM_MAY_INVOKE.includes(to);
  if (from === "general" && isCustom(to)) return true;
  return (builtinMap[from] ?? []).includes(to);
}

/**
 * /board-Teilnehmer: mitgelieferte in bisheriger Reihenfolge (sofern nicht
 * geloescht und nicht ausgeschaltet), eigene mit Board-Schalter an. Critic
 * bleibt als Gegenstimme am Ende.
 */
export function boardAgentNames(): string[] {
  const agents = listAgents().filter(a => a.board);
  const builtin = BUILTIN_BOARD_ORDER.filter(n => agents.some(a => a.name === n));
  const custom = agents.filter(a => a.origin === "custom").map(a => a.name);
  const critic = builtin.includes("critic") ? ["critic"] : [];
  return [...builtin.filter(n => n !== "critic"), ...custom, ...critic];
}

// ---------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.catch(() => {}).then(fn);
  writeChain = run;
  return run;
}

async function readForWrite(): Promise<{ raw: string | null; data: CatalogFile }> {
  let raw: string;
  try {
    raw = await readFile(paths.file, "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return { raw: null, data: {} };
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AgentCatalogFileInvalid();
  }
  const parsed = catalogSchema.safeParse(json);
  if (!parsed.success) throw new AgentCatalogFileInvalid();
  return { raw, data: structuredClone(parsed.data) };
}

/** Sichert die vorige Fassung unter eindeutigem Namen (flag wx); jeder Fehler bricht das Schreiben ab */
async function backup(raw: string): Promise<string> {
  await mkdir(paths.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const target = join(paths.backupDir, `agents-${stamp}${suffix}.json`);
    try {
      await writeFile(target, raw, { mode: 0o600, flag: "wx" });
      return target;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
  }
  throw new AgentCatalogError("Sicherung von config/agents.json fehlgeschlagen");
}

/** Leere Abschnitte entfernen, damit die Datei lesbar bleibt */
function tidy(data: CatalogFile): CatalogFile {
  const out: CatalogFile = {};
  if (data.prompts && Object.keys(data.prompts).length) out.prompts = data.prompts;
  if (data.custom?.length) out.custom = data.custom;
  if (data.deleted?.length) out.deleted = data.deleted;
  if (data.board && Object.keys(data.board).length) out.board = data.board;
  return out;
}

/**
 * Prueft den neuen Stand, sichert die vorige Fassung (falls es eine gab) und
 * ersetzt atomar. Nur innerhalb von serialize() aufrufen. Gibt den Pfad der
 * Sicherung zurueck, ohne vorige Datei null.
 */
async function writeCatalog(raw: string | null, data: CatalogFile, before?: () => Promise<void>): Promise<string | null> {
  const parsed = catalogSchema.safeParse(data);
  if (!parsed.success) throw new AgentCatalogError(issuesText(parsed.error));
  if (before) await before();
  const saved = raw !== null ? await backup(raw) : null;
  await atomicWriteFile(paths.file, JSON.stringify(parsed.data, null, 2) + "\n");
  // Der geschriebene Stand ist gueltig; wird die Datei danach beschaedigt, gilt er weiter
  lastValid = parsed.data;
  cache = { version: null, data: EMPTY };
  return saved;
}

/**
 * Ein Schreibvorgang in der Kette: aendern, pruefen, sichern, atomar ersetzen.
 * `before` laeuft nach dem Pruefen und vor dem Schreiben (Vorpruefung der Topics).
 */
function mutate<T>(change: (data: CatalogFile) => T, before?: () => Promise<void>): Promise<T> {
  return serialize(async () => {
    const { raw, data } = await readForWrite();
    const result = change(data);
    await writeCatalog(raw, tidy(data), before);
    return result;
  });
}

export type SkipReason = "eigener Eintrag" | "gelöscht";

export interface AddPromptsResult {
  /** Agenten, deren Prompt ergaenzt wurde (bei dryRun: ergaenzt wuerde) */
  added: string[];
  skipped: { name: string; reason: SkipReason }[];
  /** true, wenn config/agents.json geschrieben wurde */
  written: boolean;
  /** Pfad der Sicherung der vorigen Fassung; null ohne Schreiben oder ohne vorige Datei */
  backup: string | null;
}

/**
 * Ergaenzt prompts[name] fuer mitgelieferte Agenten ohne eigenen Eintrag
 * (Issue #136: eigene Prompts vor dem Umbau der Code-Prompts sichern).
 * Vorhandene prompts, custom, deleted und board bleiben unveraendert, auch
 * leere Abschnitte; geloeschte Agenten werden uebersprungen und bleiben
 * geloescht. Ein ungueltiger Prompt oder ein unbekannter Name bricht alles ab,
 * bevor die Datei gelesen wird. Ein einziger Schreibvorgang in der Kette; ohne
 * Ergaenzung oder mit dryRun wird weder geschrieben noch gesichert.
 */
export async function addMissingBuiltinPrompts(
  prompts: Record<string, string>,
  opts: { dryRun?: boolean } = {}
): Promise<AddPromptsResult> {
  const checked: Record<string, string> = {};
  for (const [name, prompt] of Object.entries(prompts)) {
    if (!(name in BUILTIN_AGENTS)) throw new AgentCatalogNotFound(`Kein mitgelieferter Agent: ${name.slice(0, 40)}`);
    checked[name] = checkPrompt(prompt);
  }
  return serialize(async () => {
    const { raw, data } = await readForWrite();
    const result: AddPromptsResult = { added: [], skipped: [], written: false, backup: null };
    const additions: Record<string, string> = {};
    for (const name of Object.keys(BUILTIN_AGENTS)) {
      if (!(name in checked)) continue;
      if (data.deleted?.includes(name)) result.skipped.push({ name, reason: "gelöscht" });
      else if (data.prompts?.[name] !== undefined) result.skipped.push({ name, reason: "eigener Eintrag" });
      else {
        additions[name] = checked[name];
        result.added.push(name);
      }
    }
    if (opts.dryRun || result.added.length === 0) return result;
    // Ohne tidy(): vorhandene (auch leere) Abschnitte bleiben, wie sie sind
    result.backup = await writeCatalog(raw, { ...data, prompts: { ...data.prompts, ...additions } });
    result.written = true;
    return result;
  });
}

function requireActive(data: CatalogFile, raw: string): string {
  const lower = raw.trim().toLowerCase();
  const name = AGENT_ALIASES[lower] ?? lower;
  if (!activeNames(data).includes(name)) throw new AgentCatalogNotFound(`Unbekannter Agent: ${lower.slice(0, 40)}`);
  return name;
}

function checkPrompt(prompt: unknown): string {
  const parsed = promptText.safeParse(prompt);
  if (!parsed.success) throw new AgentCatalogError(parsed.error.issues[0].message);
  return parsed.data;
}

/** Aendert den System-Prompt; bei mitgelieferten Agenten Vorrang vor dem Code */
export async function setPrompt(name: string, prompt: string): Promise<void> {
  const text = checkPrompt(prompt);
  return mutate(data => {
    const id = requireActive(data, name);
    const custom = data.custom?.find(a => a.name === id);
    if (custom) custom.systemPrompt = text;
    else data.prompts = { ...data.prompts, [id]: text };
  });
}

/** Stellt den Prompt aus src/agents/<name>.ts wieder her; eigene Agenten haben keinen Standard */
export async function resetPrompt(name: string): Promise<void> {
  return mutate(data => {
    const id = requireActive(data, name);
    if (!(id in BUILTIN_AGENTS)) throw new AgentCatalogError("Eigene Agenten haben keinen Standard-Prompt");
    if (data.prompts) delete data.prompts[id];
  });
}

export interface NewAgent {
  name: string;
  description: string;
  systemPrompt: string;
  board?: boolean;
}

/** Legt einen eigenen Agenten an; Kennung darf weder Agent noch Alias noch geloeschter Agent sein */
export async function createAgent(input: NewAgent): Promise<CatalogAgent> {
  const name = typeof input?.name === "string" ? input.name : "";
  if (!AGENT_ID_PATTERN.test(name)) {
    throw new AgentCatalogError("Kennung: a-z, 0-9 und -, 2 bis 30 Zeichen, beginnt mit Buchstabe");
  }
  if (isReservedName(name)) throw new AgentCatalogNameTaken(`Kennung vergeben: ${name}`);
  const description = descriptionText.safeParse(input.description);
  if (!description.success) throw new AgentCatalogError(description.error.issues[0].message);
  const systemPrompt = checkPrompt(input.systemPrompt);
  if (input.board !== undefined && typeof input.board !== "boolean") throw new AgentCatalogError("board muss true oder false sein");
  return mutate(data => {
    if ((data.custom ?? []).some(a => a.name === name)) throw new AgentCatalogNameTaken(`Kennung vergeben: ${name}`);
    data.custom = [
      ...(data.custom ?? []),
      { name, description: description.data.trim(), systemPrompt, ...(input.board !== undefined ? { board: input.board } : {}) },
    ];
    if (data.board) delete data.board[name];
    return describe(data, name)!;
  });
}

/**
 * Loescht einen Agenten (General nie). Mitgelieferte landen in deleted und
 * verlieren geaenderten Prompt und Board-Schalter; eigene sind endgueltig
 * weg. Danach zeigen Topics, die ihn nutzen (auch ueber Aliasse und den
 * Schluessel "*"), auf General; die umgestellten Topics kommen zurueck.
 *
 * Reihenfolge: config/topics.json wird vorab gelesen (kaputt: Abbruch ohne
 * Aenderung), dann der Katalog geschrieben, dann die Topics umgestellt.
 * Scheitert nur der letzte Schritt, ist der Agent geloescht und seine Topics
 * werden zur Laufzeit von General beantwortet; dann kommt
 * AgentCatalogTopicsNotMoved (Issue #50), eine kaputte topics.json vorab
 * ergibt AgentCatalogTopicsInvalid.
 */
export async function deleteAgent(raw: string): Promise<{ topics: TopicRef[] }> {
  let id = "";
  await mutate(
    data => {
      id = requireActive(data, raw);
      if (id === "general") throw new AgentCatalogError("General lässt sich nicht löschen");
      if (id in BUILTIN_AGENTS) {
        data.deleted = [...(data.deleted ?? []), id];
        if (data.prompts) delete data.prompts[id];
      } else {
        data.custom = (data.custom ?? []).filter(a => a.name !== id);
      }
      if (data.board) delete data.board[id];
    },
    async () => {
      try {
        await readTopicsStrict(paths.topicsFile);
      } catch {
        throw new AgentCatalogTopicsInvalid();
      }
    }
  );
  const matches = (agent: string) => {
    const lower = agent.toLowerCase();
    return (AGENT_ALIASES[lower] ?? lower) === id;
  };
  try {
    return { topics: await reassignTopicMappings(matches, "general", paths.topicsFile) };
  } catch {
    throw new AgentCatalogTopicsNotMoved();
  }
}

/** Holt einen geloeschten mitgelieferten Agenten zurueck, mit dem Stand aus dem Code */
export async function restoreBuiltin(name: string): Promise<CatalogAgent> {
  const id = name.trim().toLowerCase();
  return mutate(data => {
    if (!(data.deleted ?? []).includes(id)) throw new AgentCatalogNotFound(`Kein gelöschter mitgelieferter Agent: ${id.slice(0, 40)}`);
    data.deleted = data.deleted!.filter(n => n !== id);
    return describe(data, id)!;
  });
}

/** Board-Schalter; bei eigenen Agenten in custom[].board, bei mitgelieferten in board */
export async function setBoard(name: string, on: boolean): Promise<void> {
  if (typeof on !== "boolean") throw new AgentCatalogError("board muss true oder false sein");
  return mutate(data => {
    const id = requireActive(data, name);
    if (id === "general") throw new AgentCatalogError("General leitet das Board und nimmt nicht teil");
    const custom = data.custom?.find(a => a.name === id);
    if (custom) {
      custom.board = on;
      if (data.board) delete data.board[id];
    } else {
      data.board = { ...data.board, [id]: on };
    }
  });
}
