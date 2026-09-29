/**
 * Wie viele Agenten-Ausführungen gleichzeitig laufen dürfen (Issue #208).
 *
 * Ohne MAX_AGENT_PROCESSES richtet sich die Grenze nach dem Arbeitsspeicher
 * (os.totalmem, gerechnet in GiB, also 1024³ Byte, wie free -g und os es
 * melden): unter 3 GiB 1 Platz, unter 6 GiB 2 Plätze, sonst 3. Ein Pi mit
 * 4 GB meldet etwa 3,8 GiB und bekommt 2, einer mit 8 GB (7,8 GiB) und jeder
 * Mac oder Server bleibt beim bisherigen Standard 3. Ein gültiges
 * MAX_AGENT_PROCESSES gewinnt immer; gültig ist nur eine ganze Zahl ab 1.
 */

export const DEFAULT_AGENT_CAPACITY = 3;
export const GIB = 1024 ** 3;
/** Unter so viel Arbeitsspeicher (GiB) nur 1 Platz */
export const ONE_SLOT_BELOW_GIB = 3;
/** Unter so viel Arbeitsspeicher (GiB) nur 2 Plätze */
export const TWO_SLOTS_BELOW_GIB = 6;

export interface AgentCapacity {
  limit: number;
  /** Grund für die Log-Zeile, z.B. „Standard", „3,8 GiB Arbeitsspeicher", „MAX_AGENT_PROCESSES" */
  reason: string;
}

/** Ganze Zahl ab 1, sonst undefined (leer, Text, 0, negativ, gebrochen, unendlich) */
export function parseAgentProcesses(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

/** Standard nach Arbeitsspeicher in Byte */
export function capacityForMemory(totalBytes: number): number {
  const gib = totalBytes / GIB;
  if (gib < ONE_SLOT_BELOW_GIB) return 1;
  if (gib < TWO_SLOTS_BELOW_GIB) return 2;
  return DEFAULT_AGENT_CAPACITY;
}

function formatGib(totalBytes: number): string {
  return `${(totalBytes / GIB).toFixed(1).replace(".", ",")} GiB`;
}

export function resolveAgentCapacity(env: Record<string, string | undefined>, totalBytes: number): AgentCapacity {
  const raw = env.MAX_AGENT_PROCESSES;
  const explicit = parseAgentProcesses(raw);
  if (explicit !== undefined) return { limit: explicit, reason: "MAX_AGENT_PROCESSES" };
  const limit = capacityForMemory(totalBytes);
  const base = limit === DEFAULT_AGENT_CAPACITY ? "Standard" : `${formatGib(totalBytes)} Arbeitsspeicher`;
  // Ein unbrauchbarer Wert wird nicht still übergangen
  const reason = raw !== undefined && raw.trim() !== "" ? `${base}, MAX_AGENT_PROCESSES ungültig` : base;
  return { limit, reason };
}

export function capacityLogLine(capacity: AgentCapacity): string {
  return `[agents] Gleichzeitige Aufträge: ${capacity.limit}, ${capacity.reason}`;
}
