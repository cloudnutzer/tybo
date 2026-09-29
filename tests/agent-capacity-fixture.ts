/**
 * Feste Zahl gleichzeitiger Aufträge für Tests, die Plätze füllen (Issue #208).
 * Setzt MAX_AGENT_PROCESSES für die Dauer der Datei selbst und stellt danach
 * den vorherigen Wert wieder her; so zählt weder eine vom Bot geerbte Variable
 * (auch ohne Preload, etwa bei `bun test tests/queue-notice.test.ts`) noch der
 * Arbeitsspeicher des Rechners. resetAgentCapacity sorgt dafür, dass der Wert
 * greift, auch wenn execution-context längst geladen ist.
 */
import { afterAll, beforeAll } from "bun:test";
import { resetAgentCapacity } from "../src/lib/execution-context";

export function useAgentCapacity(limit: number): void {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.MAX_AGENT_PROCESSES;
    process.env.MAX_AGENT_PROCESSES = String(limit);
    resetAgentCapacity();
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.MAX_AGENT_PROCESSES;
    else process.env.MAX_AGENT_PROCESSES = previous;
    resetAgentCapacity();
  });
}
