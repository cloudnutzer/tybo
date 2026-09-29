#!/usr/bin/env bun
/**
 * Technischer Nachweis zu Issue #165: lässt PM2 tybo-supabase beim Beenden
 * (pm2 stop, pm2 delete) mitten im Start genug Zeit, damit der abgebrochene
 * Start bereinigt, auf offene Ports geprüft, nötigenfalls angehalten und
 * nachgeprüft ist und die Warnung im Protokoll steht, bevor der Prozess endet?
 *
 * Völlig abgeschottet: eigenes PM2_HOME im Temp-Ordner (nie ~/.pm2), eigener
 * PM2-Daemon in fester Version (PM2_VERSION, über bunx). PM2 startet die
 * Hülle scripts/run-once-and-stay.ts mit den Optionen aus
 * SUPABASE_PM2_OPTIONS (setup/configure-services.ts), die Hülle das echte
 * `tybo datenbank start` (main() aus scripts/tybo.ts, echte Signal-Handler)
 * über tests/local-supabase-abort-child.ts. docker und die Supabase-CLI sind
 * Attrappen: jeder Schritt (Bereinigung des abgebrochenen supabase start,
 * docker ps, supabase stop) dauert SLOW_MS, also jeder für sich länger als
 * PM2s Standardfrist von 1,6 Sekunden. Kein Docker, kein Supabase, kein Bot.
 *
 * Fall A: pm2 stop mitten im Start, Schutz-Stopp gelingt.
 * Fall B: pm2 delete mitten im Start, Schutz-Stopp scheitert: Warnung.
 *   Erwartet in beiden: Bereinigung, docker ps, supabase stop, docker ps,
 *   Meldung im Protokoll, erst dann Prozessende; pm2 kehrt erst danach zurück;
 *   genau ein Start, auch Sekunden später kein weiterer.
 * Fall C (Gegenprobe ohne --kill-timeout): PM2 schickt nach 1,6 Sekunden
 *   SIGKILL, Nachprüfung und Meldung fehlen.
 *
 * Aufruf: bun scripts/pm2-stop-proof.ts   (PM2_VERSION=… für eine andere Version)
 * Braucht Netz für den ersten bunx-Aufruf. Räumt Temp-Ordner und Daemon am
 * Ende immer weg. Exit 0 nur, wenn alle Erwartungen stimmen.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SUPABASE_PM2_OPTIONS } from "../setup/configure-services";
import { guardText, LOCAL_SUPABASE_URL } from "../src/setup/local-supabase";

const PM2_VERSION = process.env.PM2_VERSION ?? "7.0.4";
const ROOT = resolve(import.meta.dir, "..");
const WRAPPER = join(ROOT, "scripts", "run-once-and-stay.ts");
const CHILD = join(ROOT, "tests", "local-supabase-abort-child.ts");
const BUN = process.execPath;
/** Dauer jedes Attrappen-Schritts: länger als PM2s Standardfrist (1,6 s) */
const SLOW_MS = 2_500;
const PM2_DEFAULT_KILL_MS = 1_600;

const dir = await mkdtemp(join(tmpdir(), "tybo-pm2-stop-"));
const pm2Env: Record<string, string | undefined> = { ...process.env, PM2_HOME: join(dir, "pm2-home") };
delete pm2Env.PM2_PUBLIC_KEY;

async function pm2(args: string[], env: Record<string, string | undefined> = pm2Env): Promise<string> {
  const proc = Bun.spawn([BUN, "x", `pm2@${PM2_VERSION}`, ...args], { env, cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`pm2 ${args.join(" ")}: Exit ${code}\n${err}`);
  return out;
}

async function status(name: string): Promise<string> {
  const list = JSON.parse(await pm2(["jlist"])) as Array<{ name: string; pm2_env: { status: string } }>;
  return list.find(x => x.name === name)?.pm2_env.status ?? "fehlt";
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let failed = 0;
function expectEq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const ok = a === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FEHL"} ${label}: ${a}${ok ? "" : ` (erwartet ${JSON.stringify(expected)})`}`);
}

/** Ereignisse der Attrappen ohne Zeitstempel */
async function trail(root: string): Promise<{ events: string[]; times: number[] }> {
  const lines = (await readFile(join(root, "trail.log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { events: lines.map(l => l.slice(l.indexOf(" ") + 1)), times: lines.map(l => Number(l.slice(0, l.indexOf(" ")))) };
}

/**
 * Startet tybo-supabase wie configurePM2Service (Hülle, --state, Protokoll),
 * beendet ihn mitten im Start mit pm2 <how> und liefert, was geschah
 */
async function stopDuringStart(name: string, how: "stop" | "delete", options: string[], childEnv: Record<string, string>) {
  const root = join(dir, name);
  await mkdir(join(root, "home"), { recursive: true });
  const log = join(root, "supabase.log");
  const stateFile = join(root, "data", "supabase-start.json");
  // Umgebung des Prozesses: PM2 gibt die Umgebung des Aufrufs weiter
  const env = { ...pm2Env, TYBO_ROOT: root, NO_COLOR: "1", SUPABASE_URL: LOCAL_SUPABASE_URL, CHILD_SLOW_MS: String(SLOW_MS), CHILD_CLEANUP: "1", ...childEnv };
  await pm2(
    ["start", "bun", "--name", name, ...options, "--output", log, "--error", log, "--merge-logs", "--", "--no-env-file", WRAPPER, "--state", stateFile, CHILD, root, "datenbank", "start"],
    env,
  );
  for (let i = 0; i < 400 && !(await trail(root)).events.includes("start"); i++) await sleep(50);
  const sentAt = Date.now();
  await pm2([how, name]);
  const returnedAt = Date.now();
  // Später: kein erneuter Start
  await sleep(4_000);
  const t = await trail(root);
  const text = await readFile(log, "utf8").catch(() => "");
  const state = await readFile(stateFile, "utf8").then(JSON.parse, () => null);
  const exitAt = t.times[t.events.findIndex(e => e.startsWith("exit"))] ?? 0;
  return { root, events: t.events, text, state, sentAt, returnedAt, exitAt, status: await status(name) };
}

/** Nach dem Abbruch: Bereinigung, Prüfung, Schutz-Stopp, Nachprüfung (davor prüft der Start einmal docker ps) */
const GUARD = ["start", "start-abbruch", "start-bereinigt", "ps-anfang", "ps-ende", "stop-anfang", "stop-ende", "ps-anfang", "ps-ende"];

try {
  console.log(`PM2 ${(await pm2(["--version"])).trim()} (fest: ${PM2_VERSION}), Bun ${Bun.version}, PM2_HOME im Temp-Ordner`);
  console.log(`Optionen für tybo-supabase: ${SUPABASE_PM2_OPTIONS.join(" ")}; jeder Attrappen-Schritt ${SLOW_MS} ms`);

  console.log("\nFall A: pm2 stop mitten im Start, Schutz-Stopp gelingt");
  const a = await stopDuringStart("tybo-supabase", "stop", SUPABASE_PM2_OPTIONS, {});
  expectEq("Ablauf ab dem Start bis Prozessende (PM2 schickt SIGINT)", a.events.slice(a.events.indexOf("start")), [...GUARD, "exit 130"]);
  expectEq("Meldung zum Schutz-Stopp im Protokoll", a.text.includes("der Assistent hat sie wieder gestoppt"), true);
  expectEq("Zustandsdatei der Hülle", a.state?.state === "beendet" && a.state?.exitCode, 130);
  expectEq("pm2 stop kehrt erst nach dem Prozessende zurück", a.returnedAt >= a.exitAt, true);
  expectEq(`Prozessende später als ${PM2_DEFAULT_KILL_MS} ms nach pm2 stop`, a.exitAt - a.sentAt > PM2_DEFAULT_KILL_MS, true);
  console.log(`     (Prozessende ${a.exitAt - a.sentAt} ms nach pm2 stop)`);
  expectEq("Starts (kein erneuter Start)", a.events.filter(e => e === "start").length, 1);
  expectEq("Status", a.status, "stopped");

  console.log("\nFall B: pm2 delete mitten im Start, Schutz-Stopp scheitert");
  const b = await stopDuringStart("tybo-supabase-b", "delete", SUPABASE_PM2_OPTIONS, { CHILD_STOP: "fehler" });
  expectEq("Ablauf ab dem Start bis Prozessende", b.events.slice(b.events.indexOf("start")), [...GUARD, "exit 130"]);
  expectEq("Warnung zum Anhalten von Hand im Protokoll", b.text.includes(guardText({ state: "stopp-gescheitert" }, b.root)), true);
  expectEq("pm2 delete kehrt erst nach dem Prozessende zurück", b.returnedAt >= b.exitAt, true);
  expectEq("Starts (kein erneuter Start)", b.events.filter(e => e === "start").length, 1);
  expectEq("Status", b.status, "fehlt");

  console.log("\nFall C: ohne --kill-timeout (Gegenprobe)");
  const c = await stopDuringStart("ohne-frist", "stop", ["--no-autorestart"], {});
  expectEq("Nachprüfung erreicht", c.events.filter(e => e === "ps-ende").length === 2, false);
  expectEq("Prozessende vermerkt (exit)", c.events.some(e => e.startsWith("exit")), false);
  expectEq("Meldung im Protokoll", c.text.includes("der Assistent hat sie wieder gestoppt"), false);
  console.log(`     (Ablauf: ${c.events.join(", ")})`);
  expectEq("Starts (kein erneuter Start)", c.events.filter(e => e === "start").length, 1);
} catch (e) {
  failed++;
  console.log(`FEHL ${(e as Error).message}`);
} finally {
  await pm2(["kill"]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} Erwartung(en) nicht erfüllt.` : "\nAlle Erwartungen erfüllt.");
process.exit(failed ? 1 : 0);
