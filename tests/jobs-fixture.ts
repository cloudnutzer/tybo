/**
 * Attrappen für die Hintergrund-Jobs (Issue #103): Temp-Projektordner,
 * Prozesse als Menge lebender PIDs, Versand in eine Liste. Kein echtes
 * claude, kein Telegram.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendAndRecordInput, SendAndRecordResult } from "../src/lib/outbox";
import type { ControlDeps } from "../src/lib/jobs/control";
import type { SecretValue } from "../src/lib/jobs/mask";
import type { ProcessOps } from "../src/lib/jobs/process";
import type { ClaudeSpawnSpec, JobDeps, SpawnedClaude } from "../src/lib/jobs/runner";

export function tempRoot(prefix = "jobs-"): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Prozesse als Menge: lebt, wer drin ist; Startzeit „start-<pid>" */
export class FakeProcesses implements ProcessOps {
  living = new Set<number>([process.pid]);
  identities = new Map<number, string>();
  signals: { pgid: number; signal: string }[] = [];
  /** Reagiert eine Gruppe auf SIGTERM? Standard ja */
  ignoresTerm = new Set<number>();

  spawn(pid: number): number {
    this.living.add(pid);
    return pid;
  }
  identity(pid: number): string | null {
    return this.living.has(pid) ? (this.identities.get(pid) ?? `start-${pid}`) : null;
  }
  alive(pid: number): boolean {
    return this.living.has(pid);
  }
  signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
    this.signals.push({ pgid, signal });
    if (!this.living.has(pgid)) return false;
    if (signal === "SIGKILL" || !this.ignoresTerm.has(pgid)) this.living.delete(pgid);
    return true;
  }
  groupAlive(pgid: number): boolean {
    return this.living.has(pgid);
  }
  async sleep(): Promise<void> {
    await Promise.resolve();
  }
}

export interface FakeDeps extends JobDeps, ControlDeps {
  sent: SendAndRecordInput[];
  procs: FakeProcesses;
  spawned: ClaudeSpawnSpec[];
  logs: string[];
}

export interface FakeOptions {
  /** Antwort des Versands; Standard: gesendet und festgehalten */
  notify?(input: SendAndRecordInput, attempt: number): Promise<SendAndRecordResult>;
  spawnWatcher?(id: string): { pid: number };
  spawnClaude?(spec: ClaudeSpawnSpec): SpawnedClaude;
  secrets?: SecretValue[];
  now?: () => Date;
}

let nextId = 0;

export interface FakeChild extends SpawnedClaude {
  released: boolean;
  cancelled: boolean;
}

/** Claude-Attrappe hinter der Startsperre: merkt sich release und cancel */
export function fakeChild(pid: number, exited: SpawnedClaude["exited"], onRelease?: () => void): FakeChild {
  const child: FakeChild = {
    pid,
    exited,
    released: false,
    cancelled: false,
    release() {
      child.released = true;
      onRelease?.();
    },
    cancel() {
      child.cancelled = true;
    },
  };
  return child;
}

export function fakeDeps(root: string, o: FakeOptions = {}): FakeDeps {
  const procs = new FakeProcesses();
  const sent: SendAndRecordInput[] = [];
  const spawned: ClaudeSpawnSpec[] = [];
  const logs: string[] = [];
  let attempts = 0;
  return {
    root,
    proc: procs,
    procs,
    sent,
    spawned,
    logs,
    async notify(input) {
      attempts++;
      const result = o.notify ? await o.notify(input, attempts) : { sent: true, recorded: true };
      if (result.sent) sent.push(input);
      return result;
    },
    secrets: () => o.secrets ?? [],
    now: o.now ?? (() => new Date()),
    sleep: async () => {},
    log: line => logs.push(line),
    retryDelaysMs: [0, 0],
    newId: () => `20260925-120000-${(nextId++).toString(16).padStart(6, "0")}`,
    claudePath: "claude",
    platform: "linux",
    claudeEnv: status => ({ TYBO_JOB_ID: status.id }),
    startConfirmMs: 2_000,
    spawnWatcher: o.spawnWatcher ?? (() => ({ pid: procs.spawn(40_000 + nextId) })),
    spawnClaude(spec) {
      spawned.push(spec);
      if (o.spawnClaude) {
        // Die Attrappe lebt ab dem Start (mit Startzeit), sonst gälte ihre Identität als unbekannt
        const child = o.spawnClaude(spec);
        procs.spawn(child.pid);
        return child;
      }
      const pid = procs.spawn(50_000 + spawned.length);
      return fakeChild(pid, new Promise(() => {}));
    },
  };
}
