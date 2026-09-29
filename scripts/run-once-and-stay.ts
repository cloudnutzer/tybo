#!/usr/bin/env bun
/**
 * Einmal ausführen, dann bleiben (Issue #165): PM2-Hülle für tybo-supabase.
 *
 * PM2 stellt beim Hochfahren (pm2 resurrect aus dump.pm2) nur Prozesse
 * wieder her, die beim letzten „pm2 save“ liefen; ein als „stopped“
 * gespeicherter Eintrag wird wieder eingetragen, aber nicht ausgeführt
 * (God.prepare in PM2). Ein Einmalaufruf, der endet, fiele darum nach dem
 * nächsten pm2 save aus dem Autostart. Diese Hülle führt den Befehl genau
 * einmal aus, schreibt den Exit-Code ins Protokoll und bleibt danach ohne
 * Arbeit stehen (wie RemainAfterExit bei systemd). So bleibt der Eintrag
 * „online“, und jedes Hochfahren startet ihn genau einmal. PM2 startet ihn
 * mit --no-autorestart: endet die Hülle doch, wiederholt PM2 nichts.
 *
 * Weil der Eintrag auch nach einem gescheiterten Start „online“ bleibt,
 * schreibt die Hülle mit --state <datei> Startzustand und Ergebnis als JSON
 * (OnceState: PID der Hülle, „läuft“ bzw. „beendet“ mit Exit-Code). Die
 * Gesamtprüfung (setup/verify.ts) liest daraus, ob der letzte Start gelang.
 *
 * Aufruf: bun --no-env-file scripts/run-once-and-stay.ts [--state <datei>] <skript> [argumente …]
 * Der Befehl läuft als <bun> --no-env-file <skript> [argumente …].
 * Strg+C bzw. pm2 stop (SIGINT, SIGTERM) geht an den laufenden Befehl weiter;
 * die Hülle endet, sobald er beendet ist (130 bzw. 143).
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Inhalt der Zustandsdatei; pid ist die PID der Hülle (wie pm2 jlist sie nennt) */
export type OnceState = { pid: number; state: "läuft" } | { pid: number; state: "beendet"; exitCode: number };

export interface OnceDeps {
  /** Startet den Befehl; exited liefert den Exit-Code */
  spawn(cmd: string[]): { exited: Promise<number>; kill(signal: NodeJS.Signals): void };
  log(line: string): void;
  /** Hält den Prozess ohne Arbeit am Leben */
  stay(): void;
  /** Meldet SIGINT/SIGTERM */
  onSignal(handler: (signal: NodeJS.Signals) => void): void;
  exit(code: number): void;
  /** Schreibt den Zustand in die Datei aus --state */
  writeState?(file: string, state: OnceState): void;
  pid?: number;
}

/** Führt <skript> genau einmal aus und bleibt danach stehen; Rückgabe: Exit-Code des Befehls, null ohne Skript */
export async function runOnceAndStay(args: string[], bun: string, deps: OnceDeps): Promise<number | null> {
  const withState = args[0] === "--state";
  const stateFile = withState ? (args[1] ?? "") : null;
  const [script, ...rest] = withState ? args.slice(2) : args;
  if (!script || stateFile === "") {
    deps.log("Aufruf: bun scripts/run-once-and-stay.ts [--state <datei>] <skript> [argumente …]");
    deps.exit(2);
    return null;
  }
  const pid = deps.pid ?? process.pid;
  const record = (state: OnceState) => {
    if (!stateFile) return;
    try {
      deps.writeState?.(stateFile, state);
    } catch {
      deps.log(`Zustandsdatei ${stateFile} ließ sich nicht schreiben.`);
    }
  };
  record({ pid, state: "läuft" });
  const child = deps.spawn([bun, "--no-env-file", script, ...rest]);
  let stopping: NodeJS.Signals | null = null;
  let done = false;
  const exitCode = (signal: NodeJS.Signals) => (signal === "SIGINT" ? 130 : 143);
  deps.onSignal(signal => {
    // Nach dem Befehl: einfach enden (pm2 stop, pm2 delete)
    if (done) return deps.exit(exitCode(signal));
    if (stopping) return;
    stopping = signal;
    child.kill(signal);
  });
  const code = await child.exited;
  done = true;
  record({ pid, state: "beendet", exitCode: code });
  if (stopping) {
    deps.exit(exitCode(stopping));
    return code;
  }
  deps.log(`Einmaliger Start beendet (Exit ${code}). Der Prozess bleibt ohne Arbeit stehen, damit PM2 ihn beim nächsten Hochfahren wieder einmal startet.`);
  deps.stay();
  return code;
}

/** Schreibt erst eine Nebendatei und benennt sie um: nie halb geschrieben */
export function writeStateFile(file: string, state: OnceState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

if (import.meta.main) {
  await runOnceAndStay(process.argv.slice(2), process.execPath, {
    spawn: cmd => {
      const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
      return { exited: proc.exited, kill: signal => proc.kill(signal) };
    },
    log: line => console.log(line),
    // Ein Timer hält die Ereignisschleife offen; sonst endete bun hier
    stay: () => void setInterval(() => {}, 2 ** 30),
    onSignal: handler => {
      process.on("SIGINT", () => handler("SIGINT"));
      process.on("SIGTERM", () => handler("SIGTERM"));
    },
    exit: code => process.exit(code),
    writeState: writeStateFile,
  });
}
