/**
 * Issue #207, Prüferhinweis: Passen ExecStart der erzeugten Dienstdatei,
 * die PID des gestarteten Prozesses und detectSupervisor() zusammen?
 *
 * systemd nennt als MainPID die PID des Prozesses, den es aus ExecStart
 * startet. detectSupervisor() erkennt systemd nur, wenn diese PID die eigene
 * ist. Startete `bun run src/bot.ts` den Bot in einem Kindprozess, liefe der
 * Neustart nach Antwort ins Leere (Supervisor null).
 *
 * Nachweis ohne echten Bot und ohne echten Dienst: Die Dienstdatei wird für
 * einen Temp-Ordner erzeugt, dort liegt unter src/bot.ts eine harmlose
 * Stellvertreter-Datei (nicht der Bot aus diesem Repo). Gestartet wird genau
 * der ExecStart-Befehl mit WorkingDirectory und Environment aus der Datei,
 * dazu INVOCATION_ID wie unter systemd. systemctl ist ein Skript im PATH, das
 * als MainPID die PID meldet, die der Test beim Start bekommen hat. Shutdown
 * ist ersetzt: er schreibt nur das Ergebnis und beendet den Stellvertreter.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderSystemdUnit } from "../setup/configure-systemd";

const REPO = resolve(import.meta.dir, "..");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "tybo-execstart-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Stellvertreter für src/bot.ts: echte Erkennung und Neustart-Steuerung, ersetzter Shutdown */
const STAND_IN = `// Stellvertreter aus tests/systemd-execstart-pid.test.ts, kein Bot
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { detectSupervisor } from ${JSON.stringify(join(REPO, "src/lib/restart-request.ts"))};
import { createRestartControl } from ${JSON.stringify(join(REPO, "src/lib/restart-control.ts"))};

const out = process.env.FAKE_RESULT_FILE!;
// Warten, bis der Test die gestartete PID für systemctl hinterlegt hat
for (let i = 0; i < 200 && !existsSync(process.env.FAKE_MAINPID_FILE!); i++) await Bun.sleep(25);

let supervisor: string | null = null;
const control = createRestartControl({
  readRequest: async () => "Nachweis",
  clearRequest: async () => {},
  busyCount: () => 0,
  // Echtes detectSupervisor() mit echtem Aufruf von systemctl (hier die Attrappe im PATH);
  // nur die Plattform ist fest, damit der Nachweis auch auf macOS läuft
  detectSupervisor: async () => (supervisor = await detectSupervisor(process.pid, { platform: "linux" })),
  closeIntake: () => () => {},
  send: async () => {},
  shutdown: async reason => {
    writeFileSync(out, JSON.stringify({ pid: process.pid, supervisor, reason }));
    process.exit(0);
  },
  isShuttingDown: () => false,
  log: () => {},
});
const outcome = await control.maybeRestart("nachweis");
writeFileSync(out, JSON.stringify({ pid: process.pid, supervisor, outcome }));
`;

/** systemctl-Attrappe: meldet MainPID aus der Datei und Restart=always, merkt sich den Aufruf */
const FAKE_SYSTEMCTL = `#!/bin/sh
echo "$*" >> "$FAKE_SYSTEMCTL_LOG"
echo "MainPID=$(cat "$FAKE_MAINPID_FILE")"
echo "Restart=always"
`;

function unitLines(unit: string, key: string): string[] {
  return unit
    .split("\n")
    .filter(l => l.startsWith(`${key}=`))
    .map(l => l.slice(key.length + 1));
}

async function startLikeSystemd(name: string, reportPid: (pid: number) => number) {
  const root = join(tmp, name);
  mkdirSync(join(root, "src"), { recursive: true });
  const botFile = join(root, "src", "bot.ts");
  writeFileSync(botFile, STAND_IN);
  // Nie den echten Bot starten: der Pfad liegt im Temp-Ordner, der Inhalt ist der Stellvertreter
  expect(botFile.startsWith(tmp)).toBe(true);
  expect(readFileSync(botFile, "utf8")).toBe(STAND_IN);

  const bin = join(root, "fake-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), FAKE_SYSTEMCTL);
  chmodSync(join(bin, "systemctl"), 0o755);

  const unit = renderSystemdUnit({ projectRoot: root, home: root, bunPath: process.execPath });
  expect(unit).not.toBeNull();
  const [execStart] = unitLines(unit!, "ExecStart");
  const [workDir] = unitLines(unit!, "WorkingDirectory");
  const unitEnv = Object.fromEntries(
    unitLines(unit!, "Environment").map(e => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]),
  );
  expect(execStart).toBe(`${process.execPath} run src/bot.ts`);
  expect(workDir).toBe(root);

  const files = { FAKE_MAINPID_FILE: join(root, "mainpid"), FAKE_RESULT_FILE: join(root, "result.json"), FAKE_SYSTEMCTL_LOG: join(root, "systemctl.log") };
  const proc = Bun.spawn(execStart.split(" "), {
    cwd: workDir,
    // Umgebung wie unter systemd: nur, was die Dienstdatei setzt, plus INVOCATION_ID
    env: { ...unitEnv, PATH: `${bin}:${unitEnv.PATH}`, HOME: root, INVOCATION_ID: "0123456789abcdef", ...files },
    stdout: "pipe",
    stderr: "pipe",
  });
  // systemd merkt sich die PID des aus ExecStart gestarteten Prozesses als MainPID
  writeFileSync(files.FAKE_MAINPID_FILE, String(reportPid(proc.pid)));
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(stderr).toBe("");
  const result = JSON.parse(readFileSync(files.FAKE_RESULT_FILE, "utf8"));
  const systemctl = existsSync(files.FAKE_SYSTEMCTL_LOG) ? readFileSync(files.FAKE_SYSTEMCTL_LOG, "utf8") : "";
  return { code, spawnedPid: proc.pid, result, systemctl, unitEnv };
}

describe.skipIf(process.platform === "win32")("ExecStart, PID und detectSupervisor", () => {
  test("bun run src/bot.ts läuft im gestarteten Prozess: MainPID = eigene PID, systemd erkannt, Shutdown ausgelöst", async () => {
    const r = await startLikeSystemd("gleiche-pid", pid => pid);
    expect(r.result.pid).toBe(r.spawnedPid);
    expect(r.result.supervisor).toBe("systemd");
    expect(r.result.reason).toBe("restart-requested");
    expect(r.code).toBe(0);
    expect(r.systemctl.trim()).toBe(`--user show ${r.unitEnv.TYBO_SYSTEMD_UNIT} --property=MainPID,Restart`);
  }, 30_000);

  test("Gegenprobe: meldet systemd eine andere MainPID, kein systemd, kein Shutdown", async () => {
    const r = await startLikeSystemd("andere-pid", pid => pid + 100_000);
    expect(r.result.supervisor).toBeNull();
    expect(r.result.outcome).toBe("no-supervisor");
    expect(r.result.reason).toBeUndefined();
  }, 30_000);
});
