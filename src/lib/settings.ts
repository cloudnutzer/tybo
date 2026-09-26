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
