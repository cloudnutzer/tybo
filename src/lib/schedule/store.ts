/**
 * Ablage für Erinnerungen und geplante Aufträge (Issue #321, Entscheidung
 * E2). Eigenständig neben dem Store aus src/lib/store (wie die Ausgaben in
 * src/lib/spend), mit demselben Adapter wie dieser: Supabase, wenn URL und
 * Service-Role-Key gesetzt sind (Tabelle scheduled_tasks), sonst die Datei
 * data/reminders.json (siehe file.ts).
 *
 * Vertrag, für beide Adapter gleich:
 * - kind: "reminder" (Text an den Nutzer) oder "action" (Anweisung an tybo),
 *   Standard "reminder".
 * - status: "pending" (wartet), "running" (wird verschickt), "done",
 *   "failed", "cancelled". Neu angelegt ist ein Eintrag "pending".
 * - chatId ist Text (Telegram-Chat oder Gespräch der WebUI), topicId eine
 *   ganze Zahl oder null (kein Topic).
 * - Zeitpunkte gehen als Date hinein und kommen als ISO-Text in UTC mit
 *   Millisekunden heraus (dueAt, createdAt, updatedAt).
 * - recurrence: null (einmalig) oder eine Regel im Format von recurrence.ts;
 *   gespeichert wird ihre kanonische Form ("Daily 8:05" als "daily 08:05").
 * - Ungültige Eingaben und Fehler der Ablage ergeben null, false bzw. eine
 *   leere Liste, nie eine Ausnahme.
 * - Listen sind nach dueAt sortiert, bei Gleichstand nach createdAt.
 *
 * Fällige lesen (due) und den Status setzen (update) sind zwei Schritte.
 * Atomar ist nur updateIf (Issue #322): die Bedingung wird beim Schreiben
 * geprüft. Damit übernimmt der Planer (planner.ts) eine fällige Zeile mit
 * leaseOwner und leaseUntil und schließt sie nur ab, solange er noch der
 * Besitzer ist. leaseOwner und leaseUntil sind sonst null.
 */
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { selectBackend, type Backend } from "../store";
import { getSupabase } from "../supabase";
import type { ScheduleStore } from "./contract";
import { fileScheduleStore } from "./file";
import { supabaseScheduleStore } from "./supabase";

export * from "./contract";

// ---------------------------------------------------------------------------
// Wahl des Adapters
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

/** Ort der Datei: data/reminders.json im Projektordner (GO_PROJECT_ROOT, sonst Arbeitsordner) */
export function scheduleFilePath(env: Env = process.env): string {
  return join(env.GO_PROJECT_ROOT || process.cwd(), "data", "reminders.json");
}

export type ChosenScheduleStore = ScheduleStore & { readonly backend: Backend };

let chosen: ChosenScheduleStore | null = null;

/** Die Ablage dieses Prozesses; gewählt beim ersten Aufruf, danach immer dieselbe */
export function getScheduleStore(): ChosenScheduleStore {
  if (!chosen) {
    const backend = selectBackend();
    const path = scheduleFilePath();
    const store = backend === "supabase" ? supabaseScheduleStore(getSupabase) : fileScheduleStore(() => path);
    chosen = Object.freeze({ ...store, backend });
  }
  return chosen;
}

/**
 * Ablage für einen Aufruf außerhalb des Bots (tybo erinnerungen, Issue
 * #323): dieselbe Wahl wie getScheduleStore, aber aus env und dem
 * Projektordner root statt aus process.env und dem Arbeitsordner.
 */
export function scheduleStoreFor(env: Env, root: string): ChosenScheduleStore {
  const backend = selectBackend(env);
  if (backend === "supabase") {
    let client: SupabaseClient | null = null;
    const source = () => (client ??= createClient(env.SUPABASE_URL!.trim(), env.SUPABASE_SERVICE_ROLE_KEY!.trim()));
    return Object.freeze({ ...supabaseScheduleStore(source), backend });
  }
  const path = scheduleFilePath({ GO_PROJECT_ROOT: root });
  return Object.freeze({ ...fileScheduleStore(() => path), backend });
}

/** Vergisst die Wahl (für Tests) */
export function resetScheduleStore(): void {
  chosen = null;
}
