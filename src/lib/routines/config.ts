/**
 * Eigene Dienste in der Routinen-Zentrale (Issue #284, Entscheidung 0025):
 * config/routines.json nennt Labels und Präfixe von launchd-Diensten, die
 * nicht ai.tybo.* heißen. Nur was dort steht, erscheint; im Code steht nie
 * ein fremdes Label. Vorlage: config/routines.example.json.
 */

import { join } from "node:path";

export const ROUTINES_CONFIG_FILE = join("config", "routines.json");

export interface RoutinesConfig {
  labels: string[];
  prefixes: string[];
}

export const EMPTY_ROUTINES_CONFIG: RoutinesConfig = { labels: [], prefixes: [] };

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string").map(v => v.trim()).filter(v => v !== ""))];
}

/**
 * Liest config/routines.json bei jedem Aufruf neu. Fehlt die Datei, gilt
 * eine leere Liste; ist sie ungültig, ebenso, mit einem Hinweis. Leere
 * Präfixe und Einträge, die keine Zeichenketten sind, fallen weg (ein leerer
 * Präfix würde sonst jeden Dienst des Rechners aufnehmen).
 */
export function parseRoutinesConfig(content: string | null): { config: RoutinesConfig; note: string | null } {
  if (content === null) return { config: EMPTY_ROUTINES_CONFIG, note: null };
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return { config: EMPTY_ROUTINES_CONFIG, note: "config/routines.json ist kein gültiges JSON und wird ignoriert." };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { config: EMPTY_ROUTINES_CONFIG, note: 'config/routines.json muss ein Objekt { "labels": [...], "prefixes": [...] } sein und wird ignoriert.' };
  }
  const record = data as Record<string, unknown>;
  return { config: { labels: strings(record.labels), prefixes: strings(record.prefixes) }, note: null };
}

/** Gehört das Label in die Übersicht? */
export function matchesRoutine(label: string, ownPrefix: string, config: RoutinesConfig): boolean {
  return label.startsWith(ownPrefix) || config.labels.includes(label) || config.prefixes.some(p => label.startsWith(p));
}
