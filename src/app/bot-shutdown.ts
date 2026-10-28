/**
 * Closer des Bot-Prozesses (Issue #342) in fester Reihenfolge. src/bot.ts gibt
 * nur die Teile hinein; was noch nicht gestartet ist (Teilinitialisierung,
 * etwa ein Absturz beim Start), liefert null und wird übersprungen.
 *
 * Reihenfolge: laufende Motor-Aufrufe und Ausführungen abbrechen (das Flag
 * isShuttingDown steht da schon, abgebrochene Turns melden sich deshalb mit
 * dem Text fürs Beenden), Routinen-Prüfung und Fäden-Erinnerungen anhalten,
 * Erinnerungsplaner anhalten (ein begonnener Versand darf mit seiner
 * Schonfrist fertig werden, abgewartet erst weiter unten), Telegram stoppen,
 * WebUI schließen (abgebrochene Turns speichern ihre Meldung), MCP schließen,
 * letzte Session speichern, auf den Planer warten. Die Sperre gibt der
 * Lebenszyklus danach selbst frei.
 */
import type { Lifecycle } from "./lifecycle";

/** Wie lange die WebUI abgebrochenen Turns zum Speichern ihrer Meldung gibt */
export const WEB_STOP_GRACE_MS = 1500;

interface Stoppable {
  stop(): void;
}

export interface BotShutdownParts {
  abortRunning(): void;
  routineWatch(): Stoppable | null;
  threadReminders(): Stoppable | null;
  /** hält den Planer an; true, wenn ein begonnener Versand rechtzeitig fertig wurde */
  stopReminders(): Promise<boolean> | null;
  /** ohne Telegram ein Stopp, der nichts tut */
  telegram: Stoppable;
  web(): { stop(options: { graceMs: number; abortText: string }): Promise<void> } | null;
  webAbortText: string;
  mcp: { shutdown(): Promise<void> };
  saveSession(): Promise<void>;
  log?: (line: string) => void;
}

export function registerBotShutdown(lifecycle: Pick<Lifecycle, "onShutdown">, parts: BotShutdownParts): void {
  const log = parts.log ?? (line => console.log(line));
  let remindersSettled: Promise<boolean> | null = null;

  lifecycle.onShutdown("Motor-Aufrufe", () => parts.abortRunning());
  lifecycle.onShutdown("Routinen-Prüfung", () => parts.routineWatch()?.stop());
  lifecycle.onShutdown("Fäden-Erinnerungen", () => parts.threadReminders()?.stop());
  // Nicht abwarten: der Versand läuft parallel zum restlichen Beenden weiter
  lifecycle.onShutdown("Erinnerungsplaner", () => {
    remindersSettled = parts.stopReminders();
  });
  lifecycle.onShutdown("Telegram", () => parts.telegram.stop());
  lifecycle.onShutdown("WebUI", () => parts.web()?.stop({ graceMs: WEB_STOP_GRACE_MS, abortText: parts.webAbortText }));
  lifecycle.onShutdown("MCP", () => parts.mcp.shutdown());
  lifecycle.onShutdown("letzte Session", () => parts.saveSession());
  lifecycle.onShutdown("Erinnerungsversand", async () => {
    if (remindersSettled && !(await remindersSettled)) {
      log("[erinnerung] Versand beim Beenden nicht abgeschlossen, Ausgang beim nächsten Start unbekannt");
    }
  });
}
