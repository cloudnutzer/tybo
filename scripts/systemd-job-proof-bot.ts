#!/usr/bin/env bun
/**
 * Ersatz-Bot für den Nachweis scripts/systemd-job-proof.ts (Issue #561).
 *
 * src/bot.ts darf für einen Nachweis nie starten (Telegram, Modelle, echte
 * Daten). Dieser Prozess nimmt deshalb seinen Platz als Hauptprozess des
 * systemd-Diensts ein und verdrahtet dieselben Teile, in derselben
 * Reihenfolge wie src/bot.ts, soweit Issue #561 sie berührt:
 *
 *   Sperre und Lebenszyklus   createProcessLock, createLifecycle
 *   Beenden                   registerBotShutdown mit abortAllEngineCalls
 *   Signale                   installSignalHandlers
 *   Neustart nach Antwort     createBotRestart mit detectSupervisor
 *   Aufräumen beim Start      recoverJobsUntilSettled
 *
 * Alles andere fehlt: kein Telegram, keine WebUI, kein Modell, kein Netz.
 * Was im Bot ein Claude-Subprozess anstößt, stößt hier eine Auftragsdatei an
 * (PROOF_DIR): „job“ startet einen Hintergrund-Job über die echte Job-CLI
 * (scripts/job.ts start), „engine“ meldet einen Motor-Prozess an, der
 * SIGINT samt Kind übergeht und wie ein Codex-Lauf beendet wird (SIGINT,
 * nach 3 Sekunden SIGKILL): Ohne das Warten beim Beenden unter systemd wäre
 * der Bot vor dem SIGKILL weg und die Gruppe bliebe stehen. Der Neustart
 * nach Antwort prüft hier jede Sekunde statt alle 30 Sekunden.
 *
 * Läuft nur in einem Ordner, den das Nachweis-Skript angelegt hat (Datei
 * PROOF_MARKER), nie in einem echten Projektordner.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerBotShutdown, runsUnderSystemd } from "../src/app/bot-shutdown";
import { createBotRestart } from "../src/app/bot-restart";
import { acquireLockOrExit, createLifecycle, createProcessLock, installSignalHandlers } from "../src/app/lifecycle";
import { abortAllEngineCalls, activeEngineCallCount, registerEngineCall, unregisterEngineCall } from "../src/lib/engines/calls";
import { terminateCodexProcess } from "../src/lib/engines/codex";
import { closeIntake } from "../src/lib/execution-context";
import { recoverJobsUntilSettled } from "../src/lib/jobs/control";
import { createJobDeps } from "../src/lib/jobs/default-deps";
import { clearRestartRequest, detectSupervisor, readRestartRequest } from "../src/lib/restart-request";
import { PROOF_DIR, PROOF_MARKER } from "./systemd-job-proof";

/** Exit-Code, wenn der Ordner nicht vom Nachweis-Skript stammt */
export const EXIT_NOT_A_PROOF_ROOT = 2;

const JOB_SCRIPT = resolve(import.meta.dir, "job.ts");
/** Motor-Attrappe: übergeht SIGINT und SIGTERM, ihr Kind auch; nur SIGKILL beendet die Gruppe */
const STUBBORN_ENGINE = 'trap "" INT TERM; (trap "" INT TERM; sleep 600) & wait';

export interface ProofJobRequest {
  title: string;
  text: string;
}

async function main(): Promise<void> {
  const root = process.env.GO_PROJECT_ROOT?.trim() ?? "";
  if (!root || !existsSync(join(root, PROOF_MARKER))) {
    console.error(`Kein Ordner des Nachweises (GO_PROJECT_ROOT mit ${PROOF_MARKER} fehlt). Start nur über scripts/systemd-job-proof.ts.`);
    process.exit(EXIT_NOT_A_PROOF_ROOT);
  }
  const proofDir = join(root, PROOF_DIR);
  const env = { ...process.env, TYBO_ROOT: root };
  const say = (line: string) => {
    console.log(line);
    appendFileSync(join(proofDir, "events.log"), `${new Date().toISOString()} ${process.pid} ${line}\n`);
  };
  /** Erst vollständig schreiben, dann umbenennen: das Nachweis-Skript liest nie eine halbe Antwort */
  const answer = (name: string, value: unknown) => {
    const file = join(proofDir, name);
    writeFileSync(`${file}.tmp`, JSON.stringify(value));
    renameSync(`${file}.tmp`, file);
  };

  // Wie src/bot.ts: Sperre, Lebenszyklus, Closer, Signale
  const lockPath = join(root, "bot.lock");
  const lock = createProcessLock({ path: lockPath, pid: process.pid, root });
  await acquireLockOrExit(lock, { path: lockPath, exit: code => process.exit(code) });
  const lifecycle = createLifecycle({ lock, exit: code => process.exit(code), log: say, warn: say });
  lifecycle.startHeartbeat();
  registerBotShutdown(lifecycle, {
    abortRunning: abortAllEngineCalls,
    routineWatch: () => null,
    threadReminders: () => null,
    stopReminders: () => null,
    telegram: { stop() {} },
    web: () => null,
    webAbortText: "",
    mcp: { shutdown: async () => {} },
    saveSession: async () => {},
    log: say,
  });
  installSignalHandlers(lifecycle, { on: (event, handler) => void process.on(event, handler) });

  // Wie src/bot.ts: Neustart nach Antwort, sobald nichts mehr läuft
  const restart = createBotRestart({
    readRequest: () => readRestartRequest(),
    clearRequest: () => clearRestartRequest(),
    busy: [activeEngineCallCount],
    farewell: () => {},
    detectSupervisor: () => detectSupervisor(),
    closeIntake,
    send: async text => say(`[Meldung] ${text}`),
    shutdown: reason => lifecycle.shutdown(reason),
    isShuttingDown: () => lifecycle.isShuttingDown(),
  });
  lifecycle.every(1_000, () => void restart.maybeRestart("idle"));

  // Wie src/app/bot-start.ts: verwaiste Jobs beim Start melden
  void recoverJobsUntilSettled(createJobDeps({ root, env, log: say }))
    .then(r => say(`[job] Beim Start: ${r.aborted.length} verwaiste Jobs gemeldet, ${r.resent.length} Meldungen nachgeholt`))
    .catch(e => say(`[job] Aufräumen beim Start gescheitert (${e instanceof Error ? e.name : "Fehler"})`));

  /** Nimmt eine Auftragsdatei genau einmal an; null, wenn keine da ist */
  const take = (name: string): string | null => {
    const file = join(proofDir, name);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    unlinkSync(file);
    return text;
  };

  const startJob = async (request: ProofJobRequest) => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", JOB_SCRIPT, "start", "--title", request.title, `--text=${request.text}`],
      cwd: root,
      env: env as Record<string, string>,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    answer("job.result", { code, stdout, stderr });
  };

  const startEngine = () => {
    const proc = Bun.spawn({ cmd: ["/bin/sh", "-c", STUBBORN_ENGINE], cwd: root, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const entry = registerEngineCall("proof", proc, terminateCodexProcess);
    void proc.exited.then(() => unregisterEngineCall("proof", entry));
    answer("engine.result", { pid: proc.pid });
  };

  lifecycle.every(200, () => {
    if (lifecycle.isShuttingDown()) return;
    const job = take("job.request");
    if (job !== null) void startJob(JSON.parse(job) as ProofJobRequest);
    if (take("engine.request") !== null) startEngine();
  });

  answer("ready", { pid: process.pid, underSystemd: runsUnderSystemd() });
  say(`Ersatz-Bot bereit (PID ${process.pid}, unter systemd: ${runsUnderSystemd() ? "ja" : "nein"})`);
}

if (import.meta.main) await main();
