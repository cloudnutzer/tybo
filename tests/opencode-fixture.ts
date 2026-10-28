/**
 * Attrappe für den OpenCode-Motor (Issue #127): dieselbe Prozess-Attrappe wie
 * für Codex (tests/codex-fixture.ts), eingesetzt über
 * setOpenCodeRuntimeForTests. Kein echtes opencode, keine echten Signale
 * (pid 0, Signale nur gezählt). SIGINT beendet den Lauf mit Exit 1.
 *
 * `opencode --version` beantwortet die Attrappe selbst mit `version`
 * (Standard 1.18.33), ohne die Warteschlange zu verbrauchen; mit
 * `version: null` kommt auch die Versionsprüfung aus der Warteschlange.
 */
import { setOpenCodeRuntimeForTests } from "../src/lib/engines/opencode";
import { installCodexFake, type CodexFake, type FakeRun } from "./codex-fixture";

export interface OpenCodeFake extends CodexFake {
  /** Antwort auf `opencode --version`; null: aus der Warteschlange */
  version: string | null;
  /** Befehle der Läufe (ohne Versionsprüfung und caffeinate-Vorsatz) */
  runCommands(): string[][];
  /** Letzter Lauf-Befehl */
  runCommand(): string[];
  /** Zahl der Versionsprüfungen */
  versionChecks(): number;
}

const isVersion = (cmd: string[]) => cmd.at(-1) === "--version";

export function installOpenCodeFake(opts: { realTimers?: boolean; version?: string | null } = {}): OpenCodeFake {
  const holder = { version: opts.version === undefined ? "1.18.33" : opts.version };
  const fake = installCodexFake({
    realTimers: opts.realTimers,
    install: setOpenCodeRuntimeForTests,
    auto: (cmd): FakeRun | undefined => (isVersion(cmd) && holder.version !== null ? { stdout: `${holder.version}\n` } : undefined),
  });
  const strip = (cmd: string[]) => (cmd[0] === "/usr/bin/caffeinate" ? cmd.slice(2) : cmd);
  const runCommands = () => fake.spawns.map((s) => strip(s.cmd)).filter((c) => !isVersion(c));
  // Zugriff auf version als echte Eigenschaft (Object.assign kopierte nur den Wert)
  Object.defineProperty(fake, "version", {
    get: () => holder.version,
    set: (v: string | null) => void (holder.version = v),
  });
  return Object.assign(fake as OpenCodeFake, {
    runCommands,
    runCommand: () => runCommands().at(-1)!,
    versionChecks: () => fake.spawns.filter((s) => isVersion(s.cmd)).length,
  });
}

const SID = (sessionId: string) => ({ timestamp: 1790000000000, sessionID: sessionId });

/** Kleine Helfer für Ereignisse im Format von `opencode run --format json` (V1) */
export const oc = {
  stepStart: (sessionId: string) => ({ type: "step_start", ...SID(sessionId), part: { id: "prt_s", sessionID: sessionId, type: "step-start" } }),
  text: (sessionId: string, id: string, text: string) => ({
    type: "text",
    ...SID(sessionId),
    part: { id, sessionID: sessionId, type: "text", text, time: { start: 1, end: 2 } },
  }),
  tool: (sessionId: string, callID: string, tool: string, input: object = {}) => ({
    type: "tool_use",
    ...SID(sessionId),
    part: {
      id: `prt_${callID}`,
      sessionID: sessionId,
      type: "tool",
      callID,
      tool,
      state: { status: "completed", input, output: "", title: "", metadata: {}, time: { start: 1, end: 2 } },
    },
  }),
  stepFinish: (sessionId: string, cost = 0.001) => ({
    type: "step_finish",
    ...SID(sessionId),
    part: {
      id: "prt_f",
      sessionID: sessionId,
      type: "step-finish",
      reason: "stop",
      cost,
      tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 4, write: 0 } },
    },
  }),
  error: (sessionId: string, name: string, data: object) => ({ type: "error", ...SID(sessionId), error: { name, data } }),
  /** Ein vollständiger Schritt mit Text */
  reply: (sessionId: string, text: string) => [oc.stepStart(sessionId), oc.text(sessionId, "prt_t", text), oc.stepFinish(sessionId)],
};
