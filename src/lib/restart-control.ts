/**
 * Neustart nach Antwort, Entscheidung (Issue #190). Aus src/bot.ts
 * herausgelöst, damit Tests Supervisor, Versand und Shutdown ersetzen können.
 *
 * Ablauf: Marker lesen, auf Ruhe prüfen, Supervisor ermitteln (await). Danach
 * ohne await dazwischen erneut auf Ruhe prüfen und die Annahme sperren: kam
 * während der Supervisor-Abfrage ein Turn dazu, wird verschoben und der Marker
 * bleibt. Erst dann Marker löschen, Meldung senden und shutdown() aufrufen.
 * Turns, die ab der Sperre eintreffen, bekommen RestartPendingError und damit
 * die Meldung „startet gerade neu" statt eines stillen Abbruchs.
 */

import type { Supervisor } from "./restart-request";

export interface RestartControlDeps {
  readRequest(): Promise<string | null>;
  clearRequest(): Promise<void>;
  /** Laufende und wartende Verarbeitungen: Claude-Aufrufe, Ausführungen, Ziel-Schleifen */
  busyCount(): number;
  detectSupervisor(): Promise<Supervisor | null>;
  /** Annahmesperre (closeIntake aus execution-context); gibt die Freigabe zurück */
  closeIntake(): () => void;
  /** Meldung an den Nutzer; chatId fehlt: Direktchat */
  send(text: string, chatId?: string, topicId?: number): Promise<void>;
  /** Beendet den Prozess; kehrt im Bot nicht zurück */
  shutdown(reason: string): Promise<void>;
  isShuttingDown(): boolean;
  log?(message: string): void;
}

export const RESTART_TEXT = {
  noSupervisor:
    "🔄 Neustart angefordert, aber der Bot laeuft nicht unter launchd, PM2 oder systemd. Bitte manuell neu starten (docs/troubleshooting.md, Abschnitt Restart).",
  restarting: (note: string) => `🔄 Neustart mit neuem Code${note ? ` (${note})` : ""}, bin in ein paar Sekunden wieder da.`,
};

export type RestartOutcome = "none" | "busy" | "deferred" | "no-supervisor" | "restarting" | "failed" | "skipped";

export function createRestartControl(deps: RestartControlDeps) {
  const log = deps.log ?? ((m: string) => console.log(m));
  let running = false;

  async function maybeRestart(trigger: string, chatId?: string, topicId?: number): Promise<RestartOutcome> {
    if (deps.isShuttingDown() || running) return "skipped";
    running = true;
    let reopen: (() => void) | null = null;
    try {
      const note = await deps.readRequest();
      if (note === null) return "none";

      const busy = deps.busyCount();
      if (busy > 0) {
        log(`[Restart] angefordert (${trigger}), warte: ${busy} Verarbeitung(en) aktiv`);
        return "busy";
      }

      const supervisor = await deps.detectSupervisor();
      if (!supervisor) {
        // Ohne Supervisor bliebe der Bot nach dem Exit tot: ablehnen
        await deps.clearRequest();
        log("[Restart] angefordert, aber kein launchd, PM2 oder systemd erkannt: kein Exit, bitte manuell neu starten");
        await deps.send(RESTART_TEXT.noSupervisor, chatId, topicId).catch(() => {});
        return "no-supervisor";
      }

      // Erneut prüfen und sperren, ohne await dazwischen
      const late = deps.busyCount();
      if (late > 0) {
        log(`[Restart] verschoben (${trigger}): ${late} Verarbeitung(en) kamen während der Supervisor-Abfrage dazu`);
        return "deferred";
      }
      reopen = deps.closeIntake();

      await deps.clearRequest();
      log(`[Restart] Neustart via ${supervisor} (${trigger}${note ? `: ${note}` : ""})`);
      await deps.send(RESTART_TEXT.restarting(note), chatId, topicId).catch(() => {});
      await deps.shutdown("restart-requested");
      return "restarting";
    } catch (err) {
      // Keine dauerhafte Sperre nach einem Fehler
      reopen?.();
      log(`[Restart] Prüfung gescheitert (${err instanceof Error ? err.name : "Fehler"})`);
      return "failed";
    } finally {
      running = false;
    }
  }

  return { maybeRestart };
}
