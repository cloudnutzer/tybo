/**
 * Zustand der SIP-Vermittlung (Issue #511, deploy/sip-vermittlung/).
 *
 * tybo fragt die Vermittlung per SSH ab. Auf dem Server steht der Schlüssel
 * als erzwungener Befehl in authorized_keys (command="…/zustand.sh",restrict),
 * er kann also nur das Zustandsskript ausführen. Antwort: Zeilen name=wert
 * (version, zeit, status, letzte_registrierung, gespraeche).
 *
 * Einstellungen in der .env von tybo:
 * - SIP_VERMITTLUNG_SSH: Ziel wie konto@server; ohne Wert "nicht eingerichtet"
 * - SIP_VERMITTLUNG_SSH_KEY: privater Schlüssel (optional, ~ erlaubt)
 *
 * Zustände:
 * - "nicht-eingerichtet": kein Ziel gesetzt, es wird nichts abgefragt
 * - "registriert": status=Registered
 * - "nicht-registriert": Antwort da, aber nicht registriert (auch gestoppt)
 * - "unerreichbar": SSH scheitert, Zeitlimit oder unlesbare Antwort
 *
 * "Letzte Registrierung" ist der Zeitpunkt der letzten Abfrage, bei der die
 * Vermittlung registriert war (vom Server, UTC). Ins Log kommen weder Ziel
 * noch Schlüsselpfad, nur der Zustand.
 */
import { homedir } from "node:os";

type Env = Record<string, string | undefined>;

/** Zeitlimit der ganzen Abfrage; SSH selbst bekommt ConnectTimeout 8 */
export const STATUS_TIMEOUT_MS = 15_000;

export type RelayState = "nicht-eingerichtet" | "registriert" | "nicht-registriert" | "unerreichbar";

export interface RelayStatus {
  state: RelayState;
  /** Zustand der Registrierung wie auf dem Server gemeldet (Registered, Rejected, gestoppt …) */
  registration?: string;
  /** ISO-Zeitpunkt der letzten Abfrage mit Registrierung, null wenn nie gesehen */
  lastRegistered?: string | null;
  /** laufende Gespräche, null wenn unbekannt */
  calls?: number | null;
  /** kurzer Grund bei unerreichbar */
  reason?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  timedOut: boolean;
}

export type CommandRunner = (cmd: string[], timeoutMs: number) => Promise<RunResult>;

export interface RelayConfig {
  target: string;
  keyPath: string | null;
}

/** Ziel und Schlüssel aus der .env; null heißt nicht eingerichtet */
export function relayConfig(env: Env): RelayConfig | null {
  const target = env.SIP_VERMITTLUNG_SSH?.trim();
  if (!target) return null;
  const key = env.SIP_VERMITTLUNG_SSH_KEY?.trim();
  return { target, keyPath: key ? key.replace(/^~(?=\/|$)/, homedir()) : null };
}

/** SSH-Aufruf: nur Schlüssel, kein Terminal, kein Nachfragen; der Server bestimmt den Befehl */
export function sshCommand(cfg: RelayConfig): string[] {
  const cmd = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes"];
  if (cfg.keyPath) cmd.push("-i", cfg.keyPath, "-o", "IdentitiesOnly=yes");
  // "--" trennt das Ziel von Optionen; ein Ziel mit führendem "-" wäre sonst eine Option
  cmd.push("--", cfg.target, "zustand");
  return cmd;
}

/** Antwort von zustand.sh lesen; null bei unbekanntem Format */
export function parseStatusOutput(text: string): Omit<RelayStatus, "reason"> | null {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (fields.version !== "1" || !fields.status) return null;
  const last = fields.letzte_registrierung && !Number.isNaN(Date.parse(fields.letzte_registrierung)) ? fields.letzte_registrierung : null;
  const calls = /^[0-9]+$/.test(fields.gespraeche ?? "") ? Number(fields.gespraeche) : null;
  return {
    state: fields.status === "Registered" ? "registriert" : "nicht-registriert",
    registration: fields.status.slice(0, 40),
    lastRegistered: last,
    calls,
  };
}

export const defaultRunner: CommandRunner = async (cmd, timeoutMs) => {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { code, stdout, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

/** Zustand abfragen; wirft nie */
export async function fetchRelayStatus(env: Env, run: CommandRunner = defaultRunner, timeoutMs = STATUS_TIMEOUT_MS): Promise<RelayStatus> {
  const cfg = relayConfig(env);
  if (!cfg) return { state: "nicht-eingerichtet" };
  let result: RunResult;
  try {
    result = await run(sshCommand(cfg), timeoutMs);
  } catch {
    return { state: "unerreichbar", reason: "SSH nicht ausführbar" };
  }
  if (result.timedOut) return { state: "unerreichbar", reason: `keine Antwort nach ${Math.round(timeoutMs / 1000)} s` };
  if (result.code !== 0) return { state: "unerreichbar", reason: `SSH endete mit ${result.code}` };
  return parseStatusOutput(result.stdout) ?? { state: "unerreichbar", reason: "Antwort im falschen Format" };
}

/** Eine Zeile für Berichte */
export function describeStatus(status: RelayStatus, now: number = Date.now()): string {
  const since = (iso: string | null | undefined) => {
    if (!iso) return "noch nie registriert gesehen";
    const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
    return `zuletzt registriert ${iso.replace("T", " ").replace(/:\d\dZ$/, " UTC").replace(/Z$/, " UTC")} (vor ${minutes} min)`;
  };
  switch (status.state) {
    case "nicht-eingerichtet":
      return "nicht eingerichtet (SIP_VERMITTLUNG_SSH fehlt)";
    case "registriert":
      return `bei easybell registriert${status.calls != null ? `, ${status.calls} Gespräch(e)` : ""}`;
    case "nicht-registriert":
      return `nicht registriert (${status.registration ?? "unbekannt"}), ${since(status.lastRegistered)}`;
    case "unerreichbar":
      return `nicht erreichbar (${status.reason ?? "unbekannt"})`;
  }
}
