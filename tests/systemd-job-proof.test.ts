/**
 * Issue #561: der Nachweis auf echtem systemd (scripts/systemd-job-proof.ts)
 * und sein Ersatz-Bot (scripts/systemd-job-proof-bot.ts). Der Nachweis selbst
 * läuft nie in der Testsuite: Er ruft das echte systemctl auf. Geprüft werden
 * hier seine reinen Teile (Dienstdatei, Auswertung) und, mit echten Prozessen
 * ohne systemd, dass der Ersatz-Bot einen Job über die Job-CLI startet, bei
 * SIGTERM endet und der Job weiterläuft. Kein Test ruft systemctl auf.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KILL_MODE_LINE, renderSystemdUnit } from "../setup/configure-systemd";
import { EXIT_NOT_A_PROOF_ROOT } from "../scripts/systemd-job-proof-bot";
import { inUnitCgroup, parseCgroup, parseJobId, parseStartTicks, PROOF_DIR, PROOF_MARKER, proofUnit, sameProcess, type ProcSnapshot } from "../scripts/systemd-job-proof";

const REPO = resolve(import.meta.dir, "..");
const STAND_IN = join(REPO, "scripts", "systemd-job-proof-bot.ts");
const PROOF = join(REPO, "scripts", "systemd-job-proof.ts");
const UNIT = "tybo-telegram-relay.service";

const temps: string[] = [];
const procs: { kill(signal?: number | NodeJS.Signals): void }[] = [];
const groups: number[] = [];

afterAll(() => {
  for (const proc of procs) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // schon beendet
    }
  }
  for (const pgid of groups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // schon beendet
    }
  }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "tybo-proof-test-"));
  temps.push(dir);
  return dir;
}

const rendered = () => renderSystemdUnit({ projectRoot: "/tmp/probe", home: "/home/alex", bunPath: "/home/alex/.bun/bin/bun" })!;
const input = (killMode: boolean) => ({ rendered: rendered(), standIn: "/repo/scripts/systemd-job-proof-bot.ts", root: "/tmp/probe", claudePath: "/tmp/probe/bin/claude", killMode });

describe("Dienstdatei des Nachweises", () => {
  test("ist die echte Dienstdatei, nur mit dem Ersatz-Bot als Hauptprozess", () => {
    const real = rendered().split("\n");
    const proof = proofUnit(input(true)).split("\n");
    expect(proof.filter(line => !real.includes(line))).toEqual([
      "ExecStart=/home/alex/.bun/bin/bun run /repo/scripts/systemd-job-proof-bot.ts",
      "Environment=GO_PROJECT_ROOT=/tmp/probe",
      "Environment=CLAUDE_PATH=/tmp/probe/bin/claude",
    ]);
    expect(real.filter(line => !proof.includes(line))).toEqual(["ExecStart=/home/alex/.bun/bin/bun run src/bot.ts"]);
    expect(proof.filter(line => line === KILL_MODE_LINE)).toHaveLength(1);
    expect(proof).toContain("Restart=always");
    expect(proof).toContain(`Environment=TYBO_SYSTEMD_UNIT=${UNIT}`);
  });

  test("startet nie src/bot.ts", () => {
    expect(proofUnit(input(true))).not.toContain("src/bot.ts");
    expect(proofUnit(input(false))).not.toContain("src/bot.ts");
    // Ändert sich die Zeile in renderSystemdUnit, gibt es keine Dienstdatei statt einer mit dem echten Bot
    expect(() => proofUnit({ ...input(true), rendered: rendered().replace("run src/bot.ts", "src/bot.ts") })).toThrow("ExecStart");
  });

  test("Gegenprobe: wie vor Issue #561, nur die KillMode-Zeile samt Kommentar fehlt", () => {
    const now = proofUnit(input(true)).split("\n");
    const before = proofUnit(input(false)).split("\n");
    expect(before.some(line => line.includes("KillMode"))).toBe(false);
    const missing = now.filter(line => !before.includes(line));
    expect(missing).toHaveLength(2);
    expect(missing[0].startsWith("#")).toBe(true);
    expect(missing[1]).toBe(KILL_MODE_LINE);
    expect(before.filter(line => !now.includes(line))).toEqual([]);
  });

  test("ohne die Zeile KillMode=process in renderSystemdUnit gibt es keinen Nachweis", () => {
    const without = rendered().split("\n").filter(line => line !== KILL_MODE_LINE).join("\n");
    expect(() => proofUnit({ ...input(true), rendered: without })).toThrow(KILL_MODE_LINE);
    expect(() => proofUnit({ ...input(false), rendered: without })).toThrow(KILL_MODE_LINE);
  });
});

describe("Auswertung des Nachweises", () => {
  const snap = (over: Partial<ProcSnapshot> = {}): ProcSnapshot => ({ pid: 4711, alive: true, startTicks: "41104", cgroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${UNIT}`, ...over });

  test("Startzeit aus /proc/<pid>/stat, auch mit Leerzeichen und Klammern im Namen", () => {
    const tail = "S 1 4711 4711 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 41104 1000000 200 18446744073709551615 0 0 0";
    expect(parseStartTicks(`4711 (bun) ${tail}`)).toBe("41104");
    expect(parseStartTicks(`4711 (ein) name (x)) ${tail}`)).toBe("41104");
    expect(parseStartTicks("4711 (bun) S 1")).toBeNull();
    expect(parseStartTicks("")).toBeNull();
  });

  test("Kontrollgruppe aus /proc/<pid>/cgroup: cgroup v2 und die systemd-Hierarchie von v1", () => {
    expect(parseCgroup(`0::/user.slice/user-1000.slice/user@1000.service/app.slice/${UNIT}\n`)).toBe(`/user.slice/user-1000.slice/user@1000.service/app.slice/${UNIT}`);
    expect(parseCgroup(`12:pids:/user.slice\n1:name=systemd:/user.slice/user-1000.slice/user@1000.service/${UNIT}\n`)).toBe(`/user.slice/user-1000.slice/user@1000.service/${UNIT}`);
    expect(parseCgroup("12:pids:/user.slice\n")).toBeNull();
    expect(parseCgroup("")).toBeNull();
  });

  test("derselbe Prozess nur mit gleicher PID, belegter gleicher Startzeit und lebend", () => {
    expect(sameProcess(snap(), snap())).toBe(true);
    // PID wiederverwendet: gleiche Nummer, andere Startzeit
    expect(sameProcess(snap(), snap({ startTicks: "99999" }))).toBe(false);
    expect(sameProcess(snap(), snap({ alive: false, startTicks: null, cgroup: null }))).toBe(false);
    expect(sameProcess(snap(), snap({ pid: 4712 }))).toBe(false);
    // Ohne belegte Startzeit zählt die PID allein nicht
    expect(sameProcess(snap({ startTicks: null }), snap({ startTicks: null }))).toBe(false);
  });

  test("Kontrollgruppe des Diensts: nur genau dieser Dienst", () => {
    expect(inUnitCgroup(snap(), UNIT)).toBe(true);
    expect(inUnitCgroup(snap({ cgroup: "/user.slice/user-1000.slice/session-3.scope" }), UNIT)).toBe(false);
    expect(inUnitCgroup(snap({ cgroup: `/user.slice/x-${UNIT}` }), UNIT)).toBe(false);
    expect(inUnitCgroup(snap({ cgroup: null }), UNIT)).toBe(false);
  });

  test("Job-Kennung aus der Ausgabe von job start", () => {
    expect(parseJobId("Job 20261112-050951-c1e251 läuft: Probe 561\nRückmeldung kommt automatisch.")).toBe("20261112-050951-c1e251");
    expect(parseJobId("Job 20261112-050951-c1e251 startet: Probe 561")).toBe("20261112-050951-c1e251");
    expect(parseJobId("Job nicht gestartet: Fehler")).toBeNull();
  });
});

describe("Abschottung", () => {
  test("keines der beiden Skripte importiert src/bot.ts", () => {
    for (const file of [STAND_IN, PROOF]) {
      const imports = [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].map(m => m[1]);
      expect(imports.length).toBeGreaterThan(3);
      expect(imports.filter(path => /(^|\/)bot(\.ts)?$/.test(path))).toEqual([]);
    }
  });

  test("der Nachweis bricht ohne XDG_RUNTIME_DIR ab, bevor er systemctl aufruft oder etwas anlegt", async () => {
    const bin = tempRoot();
    const calls = join(bin, "calls.log");
    // Stünde ein Aufruf an, landete er bei dieser Attrappe, nie beim echten systemctl
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> ${calls}\nexit 1\n`);
    chmodSync(join(bin, "systemctl"), 0o755);
    const proc = Bun.spawn({ cmd: [process.execPath, PROOF], cwd: bin, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, TMPDIR: bin }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    procs.push(proc);
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(2);
    expect(stderr).toContain("braucht Linux mit systemd");
    expect(existsSync(calls)).toBe(false);
  }, 60_000);

  test("der Ersatz-Bot startet nur in einem Ordner des Nachweises", async () => {
    const root = tempRoot();
    const proc = Bun.spawn({ cmd: [process.execPath, STAND_IN], cwd: root, env: { PATH: process.env.PATH ?? "", HOME: root, GO_PROJECT_ROOT: root }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    procs.push(proc);
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(EXIT_NOT_A_PROOF_ROOT);
    expect(stderr).toContain(PROOF_MARKER);
    // Nichts angelegt: weder Sperre noch Daten
    expect(existsSync(join(root, "bot.lock"))).toBe(false);
    expect(existsSync(join(root, "data"))).toBe(false);
  }, 60_000);
});

describe("Ersatz-Bot mit echten Prozessen, ohne systemd", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function until<T>(what: string, probe: () => T | null | undefined): Promise<T> {
    const end = Date.now() + 60_000;
    for (;;) {
      const value = probe();
      if (value !== null && value !== undefined) return value;
      if (Date.now() > end) throw new Error(`Zeitlimit: ${what}`);
      await new Promise(done => setTimeout(done, 50));
    }
  }
  const json = <T>(file: string): T | null => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  };

  test("startet einen Job über die Job-CLI, endet bei SIGTERM, der Job läuft weiter und endet mit success", async () => {
    const root = tempRoot();
    const proofDir = join(root, PROOF_DIR);
    mkdirSync(proofDir, { recursive: true });
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, PROOF_MARKER), "");
    // Attrappe der Claude CLI: wartet auf die Freigabe, schreibt dann den Bericht
    writeFileSync(join(root, "bin", "claude"), `#!/bin/sh\ncat > /dev/null\nwhile [ ! -e ${PROOF_DIR}/finish ]; do sleep 0.1; done\nprintf 'fertig\\n' > "data/jobs/$TYBO_JOB_ID/report.md"\n`);
    chmodSync(join(root, "bin", "claude"), 0o755);

    const bot = Bun.spawn({
      cmd: [process.execPath, STAND_IN],
      cwd: root,
      // Feste Umgebung: nichts aus einer .env, keine Variablen eines Dienstverwalters
      env: { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root, GO_PROJECT_ROOT: root, CLAUDE_PATH: join(root, "bin", "claude") },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    procs.push(bot);
    const ready = await until("Ersatz-Bot bereit", () => json<{ pid: number; underSystemd: boolean }>(join(proofDir, "ready")));
    expect(ready).toEqual({ pid: bot.pid, underSystemd: false });

    writeFileSync(join(proofDir, "job.request"), JSON.stringify({ title: "Probe", text: "Schreibe fertig in deinen Bericht." }));
    const started = await until("Antwort der Job-CLI", () => json<{ code: number; stdout: string }>(join(proofDir, "job.result")));
    expect(started.code).toBe(0);
    const id = parseJobId(started.stdout)!;
    expect(id).toBeTruthy();
    const statusFile = join(root, "data", "jobs", id, "status.json");
    type Status = { phase: string; outcome?: string; exitCode?: number; watcher?: { pid: number }; claude?: { pid: number } };
    const running = await until("Job läuft", () => {
      const s = json<Status>(statusFile);
      return s?.phase === "running" && s.watcher && s.claude ? s : null;
    });
    const watcher = running.watcher!.pid;
    const claude = running.claude!.pid;
    groups.push(watcher, claude);

    bot.kill("SIGTERM");
    expect(await bot.exited).toBe(0);
    // Der Bot ist weg, sein Job nicht: Wächter und Job-Claude gehören nicht zu den Motor-Aufrufen
    expect([alive(watcher), alive(claude)]).toEqual([true, true]);
    expect(existsSync(join(root, "bot.lock"))).toBe(false);

    writeFileSync(join(proofDir, "finish"), "");
    const ended = await until("Job beendet", () => {
      const s = json<Status>(statusFile);
      return s?.phase === "ended" ? s : null;
    });
    expect([ended.outcome, ended.exitCode]).toEqual(["success", 0]);
    expect(readFileSync(join(root, "data", "jobs", id, "report.md"), "utf8").trim()).toBe("fertig");
  }, 120_000);
});
