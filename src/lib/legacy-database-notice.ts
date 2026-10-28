/**
 * Hinweis auf eine Convex-Konfiguration aus früheren Versionen (Issue #324,
 * Entscheidung E1). Convex wird nicht mehr unterstützt: der Store
 * (src/lib/store) liest CONVEX_URL nicht. Ohne Supabase bleiben nur Fakten
 * und Ziele lokal (memory.json); für den Telegram-Verlauf gibt es dann keinen
 * Speicher. Die Gespräche der WebUI liegen unabhängig davon unter data/web/.
 * Steht CONVEX_URL noch in der
 * Umgebung, sagt der Bot das einmal beim Start und nennt den Umzugsweg.
 *
 * Der Hinweis nennt nur den Namen der Variable, nie ihren Wert, und auch
 * keine anderen Werte aus der Umgebung.
 */

import { BRAND } from "../brand";

type Env = Record<string, string | undefined>;

/** Name der alten Variable; ihr Wert erscheint nirgends */
export const RETIRED_DATABASE_VARIABLE = "CONVEX_URL";

/** Wo der Umzug beschrieben ist */
export const MIGRATION_GUIDE = "docs/einrichtung.md, Abschnitt „Umzug von Convex“";

function filled(env: Env, name: string): boolean {
  return (env[name] ?? "").trim() !== "";
}

/** Text des Hinweises, null wenn keine alte Convex-Adresse gesetzt ist */
export function legacyDatabaseNotice(env: Env): string | null {
  if (!filled(env, RETIRED_DATABASE_VARIABLE)) return null;
  const head = `${RETIRED_DATABASE_VARIABLE} ist gesetzt, aber Convex wird nicht mehr unterstützt; ${BRAND.name} liest dort nichts mehr.`;
  const supabase = filled(env, "SUPABASE_URL") && filled(env, "SUPABASE_SERVICE_ROLE_KEY");
  const tail = supabase
    ? `Gespeichert wird in Supabase. Ist der Umzug fertig, ${RETIRED_DATABASE_VARIABLE} aus der .env entfernen (${MIGRATION_GUIDE}).`
    : `Ohne Supabase speichert ${BRAND.name} nur Fakten und Ziele, lokal in memory.json; den Telegram-Verlauf speichert es nicht (Gespräche der WebUI liegen getrennt unter data/web/). Umzug nach Supabase: ${BRAND.cli} setup datenbank (${MIGRATION_GUIDE}).`;
  return `${head} ${tail}`;
}

/** Einmal beim Start: Hinweis ins Log, wenn nötig. true, wenn etwas geschrieben wurde */
export function logLegacyDatabaseNotice(env: Env = process.env, log: (line: string) => void = console.warn): boolean {
  const notice = legacyDatabaseNotice(env);
  if (!notice) return false;
  log(`[datenbank] ${notice}`);
  return true;
}
