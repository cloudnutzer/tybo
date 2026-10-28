/**
 * Log-Zeilen der Routinen-Aktionen (Issue #288): nur Routinen-ID, Aktion und
 * Kanal, auf Erfolgs- wie auf Fehlerwegen. Aktion ist pause, resume, run oder
 * menu (Menü bzw. Rückfrage zeigen). Keine Frage-IDs, Auswahlen, Ergebnisse,
 * Fehlernamen oder Texte. Ohne Importe, damit auch die Befehle sie nutzen.
 */

export type RoutineLogAction = "pause" | "resume" | "run" | "menu";
export type RoutineLogChannel = "telegram" | "web" | "terminal";

export function routineLogLine(id: string, action: RoutineLogAction, channel: RoutineLogChannel): string {
  return `[routinen] ${id} ${action} (${channel})`;
}
