/**
 * Beenden des WhatsApp-Gateways (Issue #345) über den gemeinsamen
 * Lebenszyklus (createLifecycle, installSignalHandlers in src/app/lifecycle.ts).
 *
 * Das Gateway hält keine Prozesssperre: bot.lock gehört dem Bot, das Gateway
 * läuft daneben. Reihenfolge der Closer: laufende Motor-Aufrufe und
 * Ausführungen abbrechen (der Besitzer bekommt dann die Meldung fürs Beenden,
 * die Wartezeit des Lebenszyklus lässt sie noch rausgehen), dann den
 * Webhook-Server schließen.
 */
import { createLifecycle, type Lifecycle, type LifecycleOptions, type ProcessLock } from "../../app/lifecycle";

/** Platzhalter statt bot.lock: kein Herzschlag, nichts freizugeben */
export const NO_PROCESS_LOCK: Pick<ProcessLock, "touch" | "release"> = {
  touch: async () => {},
  release: async () => {},
};

export interface GatewayShutdownParts {
  /** abortAllEngineCalls aus src/lib/engines/calls.ts */
  abortRunning(): void;
  /** Webhook-Server schließen; null, solange er nicht läuft */
  server(): { stop(): unknown } | null;
}

export type GatewayLifecycleOptions = Omit<LifecycleOptions, "lock"> & { parts: GatewayShutdownParts };

export function createGatewayLifecycle(options: GatewayLifecycleOptions): Lifecycle {
  const { parts, ...rest } = options;
  const lifecycle = createLifecycle({ ...rest, lock: NO_PROCESS_LOCK });
  lifecycle.onShutdown("Motor-Aufrufe", () => parts.abortRunning());
  lifecycle.onShutdown("Webhook-Server", () => parts.server()?.stop());
  return lifecycle;
}
