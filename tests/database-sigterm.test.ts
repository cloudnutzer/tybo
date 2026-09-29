/**
 * Issue #165, Prüfrunde 3: SIGTERM während `tybo datenbank start` (pm2 stop,
 * launchd, Weitergabe durch die Hülle scripts/run-once-and-stay.ts). Echte
 * Kindprozesse: die Hülle startet tests/local-supabase-abort-child.ts, das
 * main() aus scripts/tybo.ts mit den echten Signal-Handlern und echtem
 * process.exit ausführt; docker und die Supabase-CLI sind Attrappen. Der
 * Prozess darf erst enden, wenn der abgebrochene Start bereinigt und der
 * Schutz-Stopp nachgeprüft ist.
 *
 * Dazu die Eskalation von launchd beim Entladen: SIGTERM, nach ExitTimeOut
 * aus der gerenderten Plist SIGKILL. Zeitlich verkleinert um SCALE: die
 * langsamen Attrappen-Schritte dauern zusammen ABORT_WORST_CASE_MS / SCALE,
 * die Frist ExitTimeOut / SCALE. launchctl kommt nicht vor.
 */

import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureService } from "../setup/configure-launchd";
import { PROJECT_ROOT } from "../src/setup/context";
import { guardText, LOCAL_SUPABASE_URL } from "../src/setup/local-supabase";
import { ABORT_WORST_CASE_MS } from "./abort-worst-case";

const CHILD = resolve(import.meta.dir, "local-supabase-abort-child.ts");
const WRAPPER = resolve(import.meta.dir, "..", "scripts", "run-once-and-stay.ts");
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Nach dem Abbruch: Prüfung, Schutz-Stopp, Nachprüfung, erst dann Prozessende */
const GUARD_AFTER_START = ["start", "ps-anfang", "ps-ende", "stop-anfang", "stop-ende", "ps-anfang", "ps-ende"];

/** killAfterMs: wie ein Dienstmanager nach dieser Frist SIGKILL schicken */
async function sigtermDuringStart(viaWrapper: boolean, childEnv: Record<string, string> = {}, killAfterMs?: number) {
  const root = await mkdtemp(join(tmpdir(), "tybo-sigterm-"));
  dirs.push(root);
  const stateFile = join(root, "data", "supabase-start.json");
  const inner = [CHILD, root, "datenbank", "start"];
  const cmd = viaWrapper
    ? [process.execPath, "--no-env-file", WRAPPER, "--state", stateFile, ...inner]
    : [process.execPath, "--no-env-file", ...inner];
  const proc = Bun.spawn(cmd, {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), NO_COLOR: "1", SUPABASE_URL: LOCAL_SUPABASE_URL, ...childEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout as ReadableStream).text();
  const stderr = new Response(proc.stderr as ReadableStream).text();
  const trailText = () => readFile(join(root, "trail.log"), "utf8").catch(() => "");
  let sent = false;
  let escalation: Timer | undefined;
  for (let i = 0; i < 400 && !sent; i++) {
    if ((await trailText()).includes(" start\n")) {
      proc.kill("SIGTERM");
      sent = true;
      if (killAfterMs !== undefined) escalation = setTimeout(() => proc.kill("SIGKILL"), killAfterMs);
    } else await Bun.sleep(25);
  }
  const code = await proc.exited;
  clearTimeout(escalation);
  const events = (await trailText())
    .trim()
    .split("\n")
    .map(l => l.slice(l.indexOf(" ") + 1));
  const state = await readFile(stateFile, "utf8").catch(() => null);
  return { root, sent, code, signal: proc.signalCode, events, text: `${await stdout}\n${await stderr}`, state: state && JSON.parse(state), pid: proc.pid };
}

test("über die Hülle: SIGTERM geht an tybo datenbank start, Schutz-Stopp und Nachprüfung vor dem Ende, Exit 143, Zustandsdatei mit Ergebnis", async () => {
  const r = await sigtermDuringStart(true);
  expect(r.sent).toBe(true);
  expect(r.code).toBe(143);
  // Ende des inneren Befehls erst nach der Nachprüfung, mit 143
  const from = r.events.indexOf("start");
  expect(r.events.slice(from)).toEqual([...GUARD_AFTER_START, "exit 143"]);
  expect(r.text).toContain("Abgebrochen.");
  expect(r.text).toContain("der Assistent hat sie wieder gestoppt");
  // Hülle hat den Start als beendet mit 143 vermerkt, keine Wiederholung
  expect(r.state).toEqual({ pid: r.pid, state: "beendet", exitCode: 143 });
  expect(r.events.filter(e => e === "start")).toEqual(["start"]);
}, 30_000);

test("über die Hülle, Schutz-Stopp scheitert: Warnung zum Anhalten von Hand vor dem Ende, Exit 143", async () => {
  const r = await sigtermDuringStart(true, { CHILD_STOP: "fehler" });
  expect(r.code).toBe(143);
  expect(r.events.slice(r.events.indexOf("start"))).toEqual([...GUARD_AFTER_START, "exit 143"]);
  expect(r.text).toContain(guardText({ state: "stopp-gescheitert" }, r.root));
}, 30_000);

test("direkt (launchd stoppt ai.tybo.supabase): SIGTERM bricht den Start kontrolliert ab, Exit 143 erst nach dem Schutz-Stopp", async () => {
  const r = await sigtermDuringStart(false, { CHILD_SLOW: "0" });
  expect(r.sent).toBe(true);
  expect(r.code).toBe(143);
  expect(r.events.slice(r.events.indexOf("start"))).toEqual([...GUARD_AFTER_START, "exit 143"]);
  expect(r.text).toContain("der Assistent hat sie wieder gestoppt");
}, 30_000);

// ---------------------------------------------------------------------------
// launchd: Entladen mitten im Start, Eskalation nach ExitTimeOut
// ---------------------------------------------------------------------------

const SCALE = 100;
/** Vier langsame Schritte: Bereinigung, docker ps, Schutz-Stopp, Nachprüfung */
const LAUNCHD_CHILD = { CHILD_CLEANUP: "1", CHILD_SLOW_MS: String(Math.ceil(ABORT_WORST_CASE_MS / SCALE / 4)) };
const CLEANUP_AND_GUARD = ["start", "start-abbruch", "start-bereinigt", "ps-anfang", "ps-ende", "stop-anfang", "stop-ende", "ps-anfang", "ps-ende"];
/** launchd ohne ExitTimeOut-Schlüssel */
const LAUNCHD_DEFAULT_EXIT_TIMEOUT_S = 20;

/** ExitTimeOut aus der Plist, wie configureService sie schreibt (Attrappen statt launchctl) */
async function renderedExitTimeout(): Promise<number> {
  const root = await mkdtemp(join(tmpdir(), "tybo-plist-"));
  dirs.push(root);
  const files = new Map<string, string>();
  const ok = await configureService("supabase", {
    projectRoot: PROJECT_ROOT,
    launchAgentsDir: join(root, "LaunchAgents"),
    home: join(root, "home"),
    run: async cmd => (cmd[0] === "which" ? { ok: true, stdout: `/opt/tools/bin/${cmd[1]}`, stderr: "" } : { ok: cmd[0] === "launchctl", stdout: "", stderr: "" }),
    exists: path => files.has(path) || path.startsWith(PROJECT_ROOT),
    readFile: path => files.get(path) ?? readFileSync(path, "utf8"),
    writeFile: (path, content) => void files.set(path, content),
    mkdir: () => {},
    log: () => {},
  });
  expect(ok).toBe(true);
  const plist = files.get(join(root, "LaunchAgents", "ai.tybo.supabase.plist"))!;
  return Number(plist.match(/<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/)![1]);
}

test("launchd entlädt mitten im Start: langsame Bereinigung, Schutz-Stopp und Nachprüfung vor Ablauf von ExitTimeOut, kein SIGKILL", async () => {
  const exitTimeoutS = await renderedExitTimeout();
  expect(exitTimeoutS * 1000).toBeGreaterThan(ABORT_WORST_CASE_MS);
  const r = await sigtermDuringStart(false, LAUNCHD_CHILD, (exitTimeoutS * 1000) / SCALE);
  expect(r.sent).toBe(true);
  expect(r.signal).toBeNull();
  expect(r.code).toBe(143);
  expect(r.events.slice(r.events.indexOf("start"))).toEqual([...CLEANUP_AND_GUARD, "exit 143"]);
  expect(r.text).toContain("der Assistent hat sie wieder gestoppt");
}, 30_000);

test("launchd entlädt mitten im Start, Schutz-Stopp scheitert: Warnung steht im Protokoll, bevor ExitTimeOut abläuft", async () => {
  const exitTimeoutS = await renderedExitTimeout();
  const r = await sigtermDuringStart(false, { ...LAUNCHD_CHILD, CHILD_STOP: "fehler" }, (exitTimeoutS * 1000) / SCALE);
  expect(r.signal).toBeNull();
  expect(r.code).toBe(143);
  expect(r.events.slice(r.events.indexOf("start"))).toEqual([...CLEANUP_AND_GUARD, "exit 143"]);
  expect(r.text).toContain(guardText({ state: "stopp-gescheitert" }, r.root));
}, 30_000);

test("Gegenprobe: mit der Standardfrist von launchd (20 Sekunden) kommt SIGKILL vor Schutz-Stopp und Nachprüfung", async () => {
  const r = await sigtermDuringStart(false, LAUNCHD_CHILD, (LAUNCHD_DEFAULT_EXIT_TIMEOUT_S * 1000) / SCALE);
  expect(r.signal).toBe("SIGKILL");
  expect(r.events).not.toContain("stop-ende");
  expect(r.events.some(e => e.startsWith("exit"))).toBe(false);
}, 30_000);
