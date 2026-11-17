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
 * letzte Session speichern, auf den Planer warten. Nur unter systemd
 * (runsUnderSystemd) beendet das Abbrechen auch die Prüfprozesse der Motoren
 * und sperrt neue, und zuletzt folgt das Warten auf das Ende der
 * abgebrochenen Motor-Prozesse samt SIGKILL für Nachzügler (Issue #561: mit
 * KillMode=process räumt sie sonst niemand ab). Unter PM2, launchd und ohne
 * Dienst bleibt der Ablauf wie vorher. Die Sperre gibt der Lebenszyklus
 * danach selbst frei.
 */
import { waitForEngineExit as waitForEngineExitDefault, type EngineAbortOptions, type EngineProc } from "../lib/engines/calls";
import { SYSTEMD_UNIT_ENV } from "../lib/restart-request";
import type { Lifecycle } from "./lifecycle";

/** Wie lange die WebUI abgebrochenen Turns zum Speichern ihrer Meldung gibt */
export const WEB_STOP_GRACE_MS = 1500;

/**
 * Läuft der Bot als systemd-Dienst von tybo? Wie detectSupervisor, aber ohne
 * systemctl-Abfrage (das Beenden fragt niemanden): Linux, nicht unter PM2,
 * INVOCATION_ID von systemd und TYBO_SYSTEMD_UNIT aus der Dienstdatei von
 * `tybo setup autostart`.
 */
export function runsUnderSystemd(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "linux" || env.pm_id !== undefined) return false;
  return !!env.INVOCATION_ID?.trim() && !!env[SYSTEMD_UNIT_ENV]?.trim();
}

interface Stoppable {
  stop(): void;
}

export interface BotShutdownParts {
  /**
   * bricht alles ab (abortAllEngineCalls); liefert die Motor-Prozesse, auf
   * deren Ende gewartet wird. Nur unter systemd mit probes: true, dann
   * auch die Prüfprozesse samt Startsperre
   */
  abortRunning(options?: EngineAbortOptions): EngineProc[] | void;
  /** wartet auf deren Ende, Standard: waitForEngineExit; liefert die Zahl der Nachzügler */
  waitForEngineExit?: (procs: readonly EngineProc[]) => Promise<number>;
  /** nur dann wird auf die Motor-Prozesse gewartet, Standard: runsUnderSystemd() */
  underSystemd?: () => boolean;
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
  let aborted: EngineProc[] = [];
  // Issue #561: Prüfprozesse abbrechen, Startsperre und Warten nur unter systemd
  const systemd = (parts.underSystemd ?? runsUnderSystemd)();

  lifecycle.onShutdown("Motor-Aufrufe", () => {
    aborted = (systemd ? parts.abortRunning({ probes: true }) : parts.abortRunning()) ?? [];
  });
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
  // Issue #561: nur unter systemd; PM2 und launchd behalten ihren bisherigen Ablauf
  if (!systemd) return;
  lifecycle.onShutdown("Motor-Prozesse", async () => {
    if (!aborted.length) return;
    const late = await (parts.waitForEngineExit ?? waitForEngineExitDefault)(aborted);
    if (late) log(`[shutdown] ${late} Motor-Prozess(e) endeten nicht rechtzeitig und bekamen SIGKILL`);
  });
}
