/**
 * Wartung als Routine (Issue #485): räumt sichere Posten auf (Test-
 * Simulatoren, nicht verfügbare Simulatoren, Caches aus einer Positivliste,
 * eigene Logs), meldet das Ergebnis und hält es in data/wartung.json fest.
 * Ablauf und Regeln: src/lib/maintenance/run.ts, Posten:
 * src/lib/maintenance/items.ts.
 *
 *   bun run src/maintenance.ts [--dry-run]     wie tybo wartung [--dry-run]
 *
 * Läuft auf Wunsch wöchentlich sonntags 03:15 als Dienst ai.tybo.wartung
 * (tybo dienste wartung; nicht in „all“), unter Linux als systemd-Timer bzw.
 * cron-Zeile. Projektordner ist immer der Ordner über src/, nie der
 * Arbeitsordner des Aufrufers.
 */

import { statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandResult, MaintenanceDeps } from "./lib/maintenance/items";
import { MAINTENANCE_SOURCE, runMaintenanceCommand } from "./lib/maintenance/run";
import { realServiceDeps } from "./lib/maintenance/service-deps";

const COMMAND_TIMEOUT_MS = 10 * 60_000;

async function run(cmd: string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<CommandResult> {
  try {
    const proc = Bun.spawn({ cmd, cwd: options.cwd, env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: COMMAND_TIMEOUT_MS });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { ok: code === 0, code, stdout, stderr };
  } catch (error) {
    // Programm fehlt (etwa xcrun unter Linux)
    return { ok: false, code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

/** Echte Zugriffe für den Projektordner root; env samt Projekt-.env für den Bot-Schutz der Dienste */
export function realMaintenanceDeps(root: string, home = homedir(), env: Record<string, string | undefined> = process.env): MaintenanceDeps {
  return {
    platform: process.platform,
    home,
    root,
    now: () => Date.now(),
    run: cmd => run(cmd),
    services: realServiceDeps(root, env),
    async freeBytes() {
      const s = await statfs(root);
      return s.bavail * s.bsize;
    },
    async notify(text) {
      // Wie bun run notify, aber mit festem Pfad: der Aufrufer kann in einem fremden Ordner stehen
      const r = await run([process.execPath, "run", join(root, "scripts", "notify.ts"), "--source", MAINTENANCE_SOURCE, "--plain", "--text", text], { cwd: root, env: { ...process.env, GO_PROJECT_ROOT: root } });
      if (!r.ok) throw new Error(`notify endete mit Exit ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").at(-1)}` : ""}`);
    },
  };
}

export const MAINTENANCE_ROOT = resolve(import.meta.dir, "..");

if (import.meta.main) {
  process.exit(await runMaintenanceCommand(process.argv.slice(2), { deps: realMaintenanceDeps(MAINTENANCE_ROOT), out: console.log, err: console.error }));
}
