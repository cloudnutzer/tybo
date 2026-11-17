/**
 * Issue #486, Prüferpunkt: Zeitlimit im echten Befehlsadapter
 * (realServiceDeps). Nur harmlose Testprozesse über sh, kein echter
 * Dienstbefehl, kein restart:request.
 *
 * Das Zeitlimit läuft hier nicht nach fester Zeit ab, sondern sobald der
 * Testprozess seine PID-Datei geschrieben hat, also nachweislich SIGTERM
 * übergeht bzw. schläft. Unter Last kann eine Shell länger als jede feste
 * Frist bis dahin brauchen; dann fehlte die PID-Datei oder die Ausgabe.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRunner, realServiceDeps, type CommandExpiry } from "../src/lib/maintenance/service-deps";
import type { WatchedService } from "../src/lib/maintenance/config";
import { checkServices, type ServiceDeps } from "../src/lib/maintenance/services";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tybo-service-deps-"));
  dirs.push(root);
  return root;
}

/** Übergeht SIGTERM (bleibt über exec erhalten); schreibt zuerst extra, dann seine PID nach pidFile */
const stubborn = (pidFile: string, extra = "") => ["sh", "-c", `trap '' TERM; ${extra}echo $$ > '${pidFile}'; exec sleep 30`];

/** Längste Wartezeit auf die PID-Datei; danach läuft das Zeitlimit trotzdem ab und der Test scheitert an der Datei */
const READY_MAX_MS = 20_000;

/**
 * Zeitlimit, das abläuft, sobald pidFile existiert (und eine Runde der
 * Ereignisschleife später, damit vorher Geschriebenes gelesen ist).
 * firedAt: Zeitpunkt des Ablaufs, für die Dauer bis zur Rückkehr.
 */
function whenReady(pidFile: string): { expiry: CommandExpiry; firedAt: () => number } {
  let fired = 0;
  const expiry: CommandExpiry = () => {
    let stop = false;
    const expired = (async () => {
      for (const until = Date.now() + READY_MAX_MS; !stop && !existsSync(pidFile) && Date.now() < until; ) await Bun.sleep(10);
      await Bun.sleep(20);
      fired = Date.now();
    })();
    return { expired, cancel: () => (stop = true) };
  };
  return { expiry, firedAt: () => fired };
}

const pidIn = (pidFile: string) => Number(readFileSync(pidFile, "utf8"));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wartet, bis der Prozess weg ist, höchstens 10 s */
async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 500 && alive(pid); i++) await Bun.sleep(20);
  return !alive(pid);
}

/** Rückkehr kurz nach dem Ablauf, nicht erst nach den 30 s des schlafenden Prozesses */
const RETURN_MAX_MS = 10_000;

describe("realServiceDeps.run", () => {
  test("normaler Befehl: Exit-Code und Ausgabe", async () => {
    const deps = realServiceDeps(tempRoot(), {});
    const r = await deps.run(["sh", "-c", "echo 1.2.3; echo hinweis >&2"], 5_000);
    expect(r).toEqual({ code: 0, stdout: "1.2.3\n", stderr: "hinweis\n" });
  });

  test("fehlendes Programm: 127", async () => {
    const deps = realServiceDeps(tempRoot(), {});
    expect((await deps.run(["tybo-gibt-es-nicht-4711"], 5_000)).code).toBe(127);
  });

  test("Prozess übergeht SIGTERM: Rückkehr beim Zeitablauf, Fehler, Prozess beendet, Ausgabe erhalten", async () => {
    const pidFile = join(tempRoot(), "pid");
    const t = whenReady(pidFile);
    const r = await commandRunner(t.expiry)(stubborn(pidFile, "echo teil; "), 300);
    expect(Date.now() - t.firedAt()).toBeLessThan(RETURN_MAX_MS);
    expect(r.code).toBe(-1);
    expect(r.stderr).toContain("Zeitlimit überschritten");
    expect(r.stdout).toBe("teil\n");
    expect(await waitDead(pidIn(pidFile))).toBe(true);
  });

  test("Kindprozess hält die Ausgabe offen: Rückkehr beim Zeitablauf", async () => {
    const pidFile = join(tempRoot(), "pid");
    const t = whenReady(pidFile);
    // Der Enkel erbt stdout und stderr und lebt nach dem SIGKILL der Shell weiter
    const r = await commandRunner(t.expiry)(["sh", "-c", `sh -c 'trap "" TERM; echo $$ > "${pidFile}"; exec sleep 30' & wait`], 300);
    expect(Date.now() - t.firedAt()).toBeLessThan(RETURN_MAX_MS);
    expect(r.code).toBe(-1);
    const grandchild = pidIn(pidFile);
    process.kill(grandchild, "SIGKILL");
    expect(await waitDead(grandchild)).toBe(true);
  });

  test("Prozess würde auf SIGTERM mit 0 enden: zählt trotzdem als Zeitablauf", async () => {
    const pidFile = join(tempRoot(), "pid");
    const t = whenReady(pidFile);
    const r = await commandRunner(t.expiry)(["sh", "-c", `trap 'exit 0' TERM; sleep 30 & echo $! > '${pidFile}'; wait`], 300);
    // der schlafende Hintergrundprozess überlebt die Shell: nicht 30 s weiterlaufen lassen
    const sleeper = pidIn(pidFile);
    process.kill(sleeper, "SIGKILL");
    expect(await waitDead(sleeper)).toBe(true);
    expect(r.code).toBe(-1);
    expect(r.stderr).toContain("Zeitlimit überschritten");
  });

  test("langsamer Start wie unter Last: Zeitablauf erst, wenn der Prozess bereit ist", async () => {
    // Eine Sekunde bis zum trap: mehr als das alte feste Limit von 300 ms
    const pidFile = join(tempRoot(), "pid");
    const t = whenReady(pidFile);
    const r = await commandRunner(t.expiry)(["sh", "-c", `sleep 1; trap '' TERM; echo teil; echo $$ > '${pidFile}'; exec sleep 30`], 300);
    expect(r.code).toBe(-1);
    expect(r.stdout).toBe("teil\n");
    expect(await waitDead(pidIn(pidFile))).toBe(true);
  });

  test("Standard-Zeitlimit: kehrt nach timeoutMs zurück, ohne auf den Prozess zu warten", async () => {
    const deps = realServiceDeps(tempRoot(), {});
    const started = Date.now();
    const r = await deps.run(["sh", "-c", "trap '' TERM; exec sleep 30"], 300);
    expect(Date.now() - started).toBeLessThan(RETURN_MAX_MS);
    expect(r.code).toBe(-1);
    expect(r.stderr).toContain("Zeitlimit überschritten");
  });
});

describe("checkServices über den echten Adapter", () => {
  test("Versionsbefehl hängt: begrenzte Rückkehr, Fehlerresultat, Sperre frei", async () => {
    const root = tempRoot();
    const pidFile = join(root, "pid");
    const real = realServiceDeps(root, {});
    // Echter Befehlsadapter, nur läuft das Zeitlimit ab, sobald der Versionsbefehl hängt; nichts sonst wird aufgerufen
    const calls: string[][] = [];
    const t = whenReady(pidFile);
    const runner = commandRunner(t.expiry);
    const deps: ServiceDeps = { ...real, run: (cmd, timeoutMs) => (calls.push(cmd), runner(cmd, timeoutMs)) };
    const service: WatchedService = { name: "Testdienst", manager: "launchd", target: "ai.tybo.testdienst", versionCommand: stubborn(pidFile), running: { kind: "metric", url: "http://127.0.0.1:9/metrics", metric: "build_info", label: "version" }, waitMs: 1_000 };
    const run = await checkServices([service], deps, "neustart");
    expect(Date.now() - t.firedAt()).toBeLessThan(RETURN_MAX_MS);
    expect(run.services).toHaveLength(1);
    expect(run.services[0].outcome).toBe("unbekannt");
    expect(run.services[0].detail).toContain("Zeitlimit überschritten");
    expect(calls).toEqual([service.versionCommand]);
    expect(existsSync(real.lockPath)).toBe(false);
    expect(await waitDead(pidIn(pidFile))).toBe(true);
  });
});
