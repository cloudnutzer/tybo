#!/usr/bin/env bun
/**
 * Technischer Nachweis zu Issue #165: startet PM2 tybo-supabase nach dem
 * Hochfahren genau einmal, auch wenn „pm2 save“ erst nach dem Ende des
 * Supabase-Starts lief?
 *
 * Völlig abgeschottet: eigenes PM2_HOME im Temp-Ordner (nie ~/.pm2), eigener
 * PM2-Daemon in fester Version (PM2_VERSION, über bunx), statt
 * `tybo datenbank start` ein Zielskript, das nur eine Zeile in eine Zähldatei
 * schreibt und mit Exit 0 endet. Kein Docker, kein Supabase, kein Bot, kein
 * pm2 startup. „Hochfahren“ ist pm2 kill (der Daemon endet wie beim
 * Herunterfahren) und danach pm2 resurrect, genau das, was der von
 * pm2 startup eingerichtete Systemdienst beim Start ausführt.
 *
 * Fall A (so richtet tybo es ein): Hülle scripts/run-once-and-stay.ts mit
 *   --no-autorestart. Erwartet: nach resurrect genau ein weiterer Start,
 *   danach keine Wiederholung; nach dem Beenden der Hülle kein Neustart.
 * Fall B (Gegenprobe, erste Fassung von #196): Zielskript direkt mit
 *   --no-autorestart. Erwartet: nach Ende „stopped“, nach save und resurrect
 *   kein Start.
 *
 * Aufruf: bun scripts/pm2-autostart-proof.ts   (PM2_VERSION=… für eine andere Version)
 * Braucht Netz für den ersten bunx-Aufruf. Räumt den Temp-Ordner und den
 * Daemon am Ende immer weg. Exit 0 nur, wenn alle Erwartungen stimmen.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PM2_VERSION = process.env.PM2_VERSION ?? "7.0.4";
const ROOT = resolve(import.meta.dir, "..");
const WRAPPER = join(ROOT, "scripts", "run-once-and-stay.ts");
const BUN = process.execPath;

const dir = await mkdtemp(join(tmpdir(), "tybo-pm2-proof-"));
const env = { ...process.env, PM2_HOME: join(dir, "pm2-home") };
delete (env as Record<string, string | undefined>).PM2_PUBLIC_KEY;

async function pm2(...args: string[]): Promise<string> {
  const proc = Bun.spawn([BUN, "x", `pm2@${PM2_VERSION}`, ...args], { env, cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`pm2 ${args.join(" ")}: Exit ${code}\n${err}`);
  return out;
}

async function status(name: string): Promise<string> {
  const list = JSON.parse(await pm2("jlist")) as Array<{ name: string; pid: number; pm2_env: { status: string } }>;
  const p = list.find(x => x.name === name);
  return p ? p.pm2_env.status : "fehlt";
}

async function pid(name: string): Promise<number> {
  const list = JSON.parse(await pm2("jlist")) as Array<{ name: string; pid: number }>;
  return list.find(x => x.name === name)?.pid ?? 0;
}

async function count(file: string): Promise<number> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(what: string, check: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Zeitüberschreitung: ${what}`);
}

let failed = 0;
function expectEq(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FEHL"} ${label}: ${String(actual)}${ok ? "" : ` (erwartet ${String(expected)})`}`);
}

/** Hochfahren nachstellen: Daemon beenden, dann resurrect wie der Startdienst */
async function reboot() {
  await pm2("kill");
  await pm2("resurrect");
}

try {
  const target = join(dir, "ziel.ts");
  // Wie tybo datenbank start: arbeitet kurz, schreibt eine Zeile, endet mit Exit 0
  await writeFile(target, `import { appendFileSync } from "node:fs";\nawait Bun.sleep(500);\nappendFileSync(process.argv[2], new Date().toISOString() + "\\n");\n`);
  const countA = join(dir, "starts-a.txt");
  const countB = join(dir, "starts-b.txt");

  console.log(`PM2 ${(await pm2("--version")).trim()} (fest: ${PM2_VERSION}), Bun ${Bun.version}, PM2_HOME im Temp-Ordner`);

  // Fall A: Hülle, wie configurePM2Service("supabase") sie startet
  console.log("\nFall A: Hülle run-once-and-stay, --no-autorestart");
  await pm2("start", "bun", "--name", "tybo-supabase", "--no-autorestart", "--", "--no-env-file", WRAPPER, target, countA);
  await waitFor("erster Start A", async () => (await count(countA)) === 1);
  await sleep(2_000);
  expectEq("Starts nach pm2 start", await count(countA), 1);
  expectEq("Status nach Ende des Starts", await status("tybo-supabase"), "online");

  // Fall B: Zielskript direkt (Gegenprobe)
  console.log("\nFall B: Zielskript direkt, --no-autorestart (Gegenprobe)");
  await pm2("start", "bun", "--name", "einmal-direkt", "--no-autorestart", "--", "--no-env-file", target, countB);
  await waitFor("erster Start B", async () => (await count(countB)) === 1);
  await waitFor("B beendet", async () => (await status("einmal-direkt")) === "stopped");
  expectEq("Status nach Ende des Starts", await status("einmal-direkt"), "stopped");

  // pm2 save erst nach dem Ende beider Starts, dann Hochfahren
  await pm2("save");
  const dump = JSON.parse(await readFile(join(env.PM2_HOME, "dump.pm2"), "utf8")) as Array<{ name: string; status: string }>;
  console.log(`\ndump.pm2 nach save: ${dump.map(p => `${p.name}=${p.status}`).join(", ")}`);
  await reboot();
  console.log("Hochfahren nachgestellt: pm2 kill, pm2 resurrect");
  await sleep(6_000);

  console.log("\nFall A nach dem Hochfahren");
  expectEq("Starts insgesamt (1 + genau 1)", await count(countA), 2);
  expectEq("Status", await status("tybo-supabase"), "online");
  await sleep(4_000);
  expectEq("Starts nach weiteren 4 s (keine Wiederholung)", await count(countA), 2);

  // Zweites Hochfahren nach erneutem save: wieder genau ein Start
  await pm2("save");
  await reboot();
  await sleep(6_000);
  expectEq("Starts nach zweitem Hochfahren (2 + genau 1)", await count(countA), 3);

  // Endet die Hülle (hier hart beendet): PM2 startet nichts neu
  process.kill(await pid("tybo-supabase"), "SIGKILL");
  await waitFor("Hülle beendet", async () => (await status("tybo-supabase")) === "stopped");
  await sleep(4_000);
  expectEq("Starts nach Ende der Hülle (kein Neustart)", await count(countA), 3);
  expectEq("Status nach Ende der Hülle", await status("tybo-supabase"), "stopped");

  console.log("\nFall B nach dem Hochfahren (Gegenprobe)");
  expectEq("Starts insgesamt (kein Start)", await count(countB), 1);
  expectEq("Status", await status("einmal-direkt"), "stopped");
} catch (e) {
  failed++;
  console.log(`FEHL ${(e as Error).message}`);
} finally {
  await pm2("kill").catch(() => {});
  await rm(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} Erwartung(en) nicht erfüllt.` : "\nAlle Erwartungen erfüllt.");
process.exit(failed ? 1 : 0);
