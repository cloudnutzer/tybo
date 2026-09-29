/**
 * Einstellungsdatei config/settings.json (WebUI M3).
 *
 * Was spaeter im Browser eingestellt wird, liegt hier und ueberschreibt .env
 * und die Standards im Code. Vorrang an den Aufrufstellen: Datei vor .env vor
 * Code (resolveAgentModel/resolveAgentEffort in src/agents/base.ts, resolveAux
 * in aux-model.ts, die Getter in fallback-llm.ts).
 *
 * - Fehlt die Datei: leere Einstellungen, es gilt alles wie bisher.
 * - Neu gelesen wird, sobald sich mtime, Groesse oder Inode aendern (wie
 *   config/topics.json), also beim naechsten Aufruf ohne Neustart.
 * - Ungueltige Datei (kein JSON, Schema verletzt): eine Log-Zeile, die letzte
 *   gueltige Fassung bleibt aktiv; beim Start sind das leere Einstellungen.
 * - Schreiben prueft zuerst das Schema und ersetzt die Datei dann atomar mit
 *   Rechten 0600.
 */

import { statSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { AGENT_ID_PATTERN } from "../agents/names";
import { atomicWriteFile } from "./atomic-file";

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
const modelAndEffort = z.object({ model: modelName.optional(), effort: effort.optional() });

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
 * Wählbare Motoren (Issue #125, OpenCode seit #129). Hier und nicht aus
 * engines/, weil engines/codex.ts und engines/opencode.ts diese Datei
 * importieren.
 */
export const SELECTABLE_ENGINES = ["claude", "codex", "opencode"] as const;
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
 * Session-Schlüssel eines Gesprächs (sessionKeyFor in supabase.ts):
 * topic:<chat>:<topic>, group:<chat>, dm:<chat>, web:<id>
 */
export const CONVERSATION_KEY_PATTERN = /^(topic:-?\d{1,20}:\d{1,12}|group:-\d{1,20}|dm:-?\d{1,20}|web:[A-Za-z0-9-]{1,64})$/;

export const settingsSchema = z.object({
  defaults: modelAndEffort.optional(),
  // Schluessel: jede gueltige Kennung (Issue #49). Welche Agenten aktiv sind,
  // prueft die WebUI beim Aendern (applySettingsPatch); Eintraege zu
  // geloeschten Agenten bleiben stehen und werden ignoriert, kein Fehler.
  // So haengt das Lesen der Datei nicht vom Agenten-Katalog ab.
  agents: z.record(z.string().regex(AGENT_ID_PATTERN, "ungültige Agenten-Kennung"), modelAndEffort).optional(),
  aux: z
    .object({ judge: auxSpec.optional(), distill: auxSpec.optional(), review: auxSpec.optional() })
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
export async function writeSettings(settings: Settings): Promise<void> {
  const parsed = settingsSchema.parse(settings);
  await atomicWriteFile(settingsPath, JSON.stringify(parsed, null, 2) + "\n");
}

/** Die Datei ist ungültig: updateSettings schreibt dann nichts */
export class SettingsFileInvalidError extends Error {
  constructor() {
    super(`${settingsPath} ist ungültig`);
    this.name = "SettingsFileInvalidError";
  }
}

let lockChain: Promise<unknown> = Promise.resolve();

/**
 * Eine Schreibkette für alle Änderungen an der Einstellungsdatei (Issue
 * #125): /motor und die Einstellungsseite lesen und schreiben nacheinander,
 * keiner überschreibt die Änderung des anderen.
 */
export function withSettingsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockChain.catch(() => {}).then(fn);
  lockChain = run;
  return run;
}

/**
 * Liest die Datei frisch, wendet mutate auf eine Kopie an und schreibt das
 * Ergebnis, alles in der Schreibkette. Eine ungültige Datei wird nicht
 * überschrieben (SettingsFileInvalidError); fehlt sie, gilt {}.
 */
export function updateSettings(mutate: (current: Settings) => Settings): Promise<Settings> {
  return withSettingsLock(async () => {
    let raw: string | undefined;
    try {
      raw = readFileSync(settingsPath, "utf-8");
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
    let current: Settings = {};
    if (raw !== undefined) {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new SettingsFileInvalidError();
      }
      const parsed = settingsSchema.safeParse(json);
      if (!parsed.success) throw new SettingsFileInvalidError();
      current = parsed.data;
    }
    const next = settingsSchema.parse(mutate(structuredClone(current)));
    await writeSettings(next);
    return next;
  });
}
