#!/usr/bin/env bun
/**
 * Technischer Nachweis zu Issue #561 auf echtem systemd: überlebt ein
 * Hintergrund-Job, der aus dem Dienst des Bots gestartet wurde, beide Wege
 * des Neustarts (`bun run restart:request` und `systemctl --user restart`),
 * und enden die Motor-Prozesse des Bots trotzdem mit ihm?
 *
 * Abgeschottet: Der Dienst heißt wie der echte (tybo-telegram-relay.service,
 * sonst ließe sich ensureKillMode nicht prüfen), seine Datei liegt aber im
 * flüchtigen Ordner $XDG_RUNTIME_DIR/systemd/user, und der Projektordner ist
 * ein Temp-Ordner. Gibt es auf dem Rechner schon einen Dienst dieses Namens,
 * bricht der Nachweis ab, bevor er etwas anlegt: Er gehört auf einen Rechner
 * ohne eingerichteten Bot (VM oder Container mit systemd). Hauptprozess des
 * Diensts ist nie src/bot.ts, sondern der Ersatz-Bot
 * scripts/systemd-job-proof-bot.ts, der dieselben Teile verdrahtet
 * (Lebenszyklus, registerBotShutdown, Neustart nach Antwort, recoverJobs).
 * Die Dienstdatei kommt aus renderSystemdUnit, nur die Zeile ExecStart ist
 * ersetzt. Der Job startet über die echte Job-CLI mit echtem Wächter; statt
 * der Claude CLI läuft eine Attrappe, die wartet und den Bericht schreibt.
 * Kein Telegram, kein Modell, kein Netz, kein sudo.
 *
 * Fall A (neue Dienstdatei, KillMode=process): Job aus dem Dienst; Bot,
 *   Wächter und Job-Claude in derselben Kontrollgruppe; Neustart über
 *   restart:request und über systemctl restart, je mit neuer PID des Bots;
 *   Wächter und Job-Claude mit derselben PID und Startzeit; ein
 *   Motor-Prozess, der SIGINT übergeht, ist nach dem Neustart weg; der Job
 *   endet mit success und Bericht. Die Abschlussmeldung selbst prüft der
 *   Nachweis nicht: Ohne Telegram und ohne Datenbank hat sie kein Ziel.
 * Fall B (Gegenprobe, Dienstdatei wie vor #561 ohne die Zeile): Neustart
 *   über restart:request; Wächter und Job-Claude enden mit dem Bot, der
 *   neue Bot meldet den Job als verloren und nennt den Neustart des Bots.
 * Fall C (Nachziehen): ensureKillMode trägt die Zeile in die alte Datei des
 *   laufenden Diensts ein, ohne ihn neu zu starten; danach überlebt ein Job
 *   den Neustart.
 *
 * Aufruf: bun scripts/systemd-job-proof.ts   (--keep lässt den Temp-Ordner stehen)
 * Dauer rund drei Minuten. Räumt Dienst, Dienstdatei, Prozesse und Temp-Ordner
 * am Ende immer weg. Exit 0 nur, wenn alle Erwartungen stimmen; Exit 2, wenn
 * der Rechner nicht passt.
 */

import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
  ensureKillMode,
  KILL_MODE,
  KILL_MODE_LINE,
  killModeOutdated,
  parseShow,
  renderSystemdUnit,
  replaceFileAtomic,
  SYSTEMD_UNIT_FILE,
  SYSTEMD_USER_DIR,
  systemdUnitPath,
  systemdUnitState,
  type SystemdDeps,
} from "../setup/configure-systemd";
import { LOST_WATCHER_DETAIL } from "../src/lib/jobs/control";

/** Diese Datei im Projektordner weist ihn als Ordner des Nachweises aus */
export const PROOF_MARKER = ".systemd-job-proof";
/** Aufträge an den Ersatz-Bot und seine Antworten, unter dem Projektordner */
export const PROOF_DIR = join("data", "proof");

// ---------------------------------------------------------------------------
// Reine Teile (tests/systemd-job-proof.test.ts)
// ---------------------------------------------------------------------------

/** Hauptprozess in der echten Dienstdatei */
const REAL_EXEC = /^ExecStart=(\S+) run src\/bot\.ts$/m;

export interface ProofUnitInput {
  /** Ausgabe von renderSystemdUnit für den Temp-Ordner */
  rendered: string;
  /** Voller Pfad des Ersatz-Bots */
  standIn: string;
  root: string;
  /** Attrappe der Claude CLI */
  claudePath: string;
  /** false: Dienstdatei wie vor Issue #561, ohne die KillMode-Zeile samt Kommentar */
  killMode: boolean;
}

/**
 * Dienstdatei des Nachweises: die echte, nur startet sie den Ersatz-Bot im
 * Temp-Ordner. Wirft, statt eine Datei zu liefern, die src/bot.ts starten
 * könnte.
 */
export function proofUnit(input: ProofUnitInput): string {
  const exec = input.rendered.match(REAL_EXEC);
  if (!exec) throw new Error("Dienstdatei ohne die erwartete Zeile „ExecStart=<bun> run src/bot.ts“");
  const replaced = input.rendered.replace(
    REAL_EXEC,
    [`ExecStart=${exec[1]} run ${input.standIn}`, `Environment=GO_PROJECT_ROOT=${input.root}`, `Environment=CLAUDE_PATH=${input.claudePath}`].join("\n"),
  );
  const lines = replaced.split("\n");
  const at = lines.indexOf(KILL_MODE_LINE);
  if (at < 0 || lines.lastIndexOf(KILL_MODE_LINE) !== at) throw new Error(`Dienstdatei ohne genau eine Zeile ${KILL_MODE_LINE}`);
  if (!input.killMode) {
    const comment = lines[at - 1]?.startsWith("#") ? 1 : 0;
    lines.splice(at - comment, 1 + comment);
  }
  const unit = lines.join("\n");
  if (unit.includes("src/bot.ts")) throw new Error("Dienstdatei des Nachweises nennt src/bot.ts");
  return unit;
}

/** Startzeit eines Prozesses in Takten seit dem Hochfahren: Feld 22 aus /proc/<pid>/stat */
export function parseStartTicks(stat: string): string | null {
  // Der Name (Feld 2) steht in Klammern und darf Leerzeichen und Klammern enthalten
  const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  const ticks = rest[19];
  return ticks && /^\d+$/.test(ticks) ? ticks : null;
}

/** Kontrollgruppe aus /proc/<pid>/cgroup: cgroup v2 („0::<pfad>“), sonst die Hierarchie von systemd */
export function parseCgroup(text: string): string | null {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const pick = lines.find(l => l.startsWith("0::")) ?? lines.find(l => /^\d+:name=systemd:/.test(l));
  if (!pick) return null;
  const path = pick.slice(pick.indexOf(":", pick.indexOf(":") + 1) + 1);
  return path.startsWith("/") ? path : null;
}

export interface ProcSnapshot {
  pid: number;
  alive: boolean;
  startTicks: string | null;
  cgroup: string | null;
}

/** Derselbe Prozess wie vorher: lebt, gleiche PID, gleiche belegte Startzeit */
export function sameProcess(before: ProcSnapshot, after: ProcSnapshot): boolean {
  return before.alive && after.alive && before.pid === after.pid && before.startTicks !== null && before.startTicks === after.startTicks;
}

/** Gehört der Prozess zur Kontrollgruppe des Diensts? */
export function inUnitCgroup(snapshot: ProcSnapshot, unit: string): boolean {
  return snapshot.cgroup !== null && snapshot.cgroup.endsWith(`/${unit}`);
}

/** Kennung aus der Ausgabe von `job start` („Job <id> läuft: …“) */
export function parseJobId(stdout: string): string | null {
  return stdout.match(/^Job (\d{8}-\d{6}-[0-9a-f]+) (?:läuft|startet)/m)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Ablauf (nur Linux mit systemd)
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dir, "..");
const STAND_IN = join(ROOT, "scripts", "systemd-job-proof-bot.ts");
const REQUEST_SCRIPT = join(ROOT, "scripts", "request-restart.ts");
const BUN = process.execPath;
const UNIT = SYSTEMD_UNIT_FILE;
const EXIT_UNFIT = 2;

/** Attrappe der Claude CLI: nimmt den Auftrag von stdin, wartet, schreibt den Bericht (Arbeitsordner ist der Projektordner) */
const FAKE_CLAUDE = `#!/bin/sh
cat > /dev/null
sleep "$(cat ${PROOF_DIR}/job-seconds)"
printf 'fertig\\n' > "data/jobs/$TYBO_JOB_ID/report.md"
echo "Attrappe: Bericht geschrieben"
`;

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function run(cmd: string[], options: { env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<RunResult> {
  const proc = Bun.spawn({ cmd, cwd: options.cwd, env: (options.env ?? process.env) as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, stdout, stderr };
}

/** Führt einen Befehl aus und zeigt ihn samt vollständiger Ausgabe */
async function show(command: string, options: { env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<string> {
  console.log(`$ ${command}`);
  const r = await run(["/bin/sh", "-c", command], options);
  const text = `${r.stdout}${r.stderr}`.trimEnd();
  if (text) console.log(text);
  return r.stdout;
}

let expectations = 0;
let failed = 0;
function expectEq(label: string, actual: unknown, expected: unknown): void {
  expectations++;
  const a = JSON.stringify(actual);
  const ok = a === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FEHL"} ${label}: ${a}${ok ? "" : ` (erwartet ${JSON.stringify(expected)})`}`);
}

function header(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string })?.code === "EPERM";
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string })?.code === "EPERM";
  }
}

function snapshot(pid: number): ProcSnapshot {
  const read = (file: string) => {
    try {
      return readFileSync(`/proc/${pid}/${file}`, "utf8");
    } catch {
      return null;
    }
  };
  const stat = read("stat");
  const cgroup = read("cgroup");
  return { pid, alive: alive(pid) && stat !== null, startTicks: stat === null ? null : parseStartTicks(stat), cgroup: cgroup === null ? null : parseCgroup(cgroup) };
}

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | null> | T | null): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > end) throw new Error(`Zeitlimit (${Math.round(timeoutMs / 1000)} s): ${what}`);
    await sleep(200);
  }
}

interface JobRun {
  id: string;
  watcher: ProcSnapshot;
  claude: ProcSnapshot;
}

interface JobStatusView {
  phase?: string;
  outcome?: string;
  exitCode?: number | null;
  detail?: string;
  endedAt?: string;
  watcher?: { pid: number };
  claude?: { pid: number };
  notice?: { state?: string };
}

/** Ein Temp-Ordner mit Dienstdatei, Ersatz-Bot und allem, was ein Fall braucht */
async function openSession(unitDir: string) {
  const unitPath = systemdUnitPath(unitDir);
  const root = await mkdtemp(join(tmpdir(), "tybo-systemd-proof-"));
  const proofDir = join(root, PROOF_DIR);
  const claudePath = join(root, "bin", "claude");
  const env = { ...process.env, GO_PROJECT_ROOT: root, TYBO_ROOT: root };
  const botLog = join(root, "logs", "telegram-relay.log");
  /** Prozesse, die der Nachweis gestartet hat, mit Startzeit: nur die räumt er am Ende ab */
  const started: ProcSnapshot[] = [];
  const since = Math.floor(Date.now() / 1000);

  await mkdir(proofDir, { recursive: true });
  await mkdir(join(root, "logs"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, PROOF_MARKER), "");
  await writeFile(claudePath, FAKE_CLAUDE);
  await chmod(claudePath, 0o755);

  const systemdDeps: SystemdDeps = {
    projectRoot: root,
    home: homedir(),
    unitDir,
    runDir: "/run/systemd/system",
    user: userInfo().username,
    run: async cmd => run(cmd),
    exists: existsSync,
    readFile: path => readFileSync(path, "utf8"),
    writeFile: () => {
      throw new Error("Der Nachweis legt die Dienstdatei selbst an");
    },
    replaceFile: (path, content) => replaceFileAtomic(path, content),
    mkdir: () => {},
  };

  const property = async (name: string) => parseShow((await run(["systemctl", "--user", "show", UNIT, `--property=${name}`])).stdout)[name] ?? "";
  const showState = () => show(`systemctl --user show ${UNIT} -p KillMode -p Restart -p ActiveState -p MainPID`);
  const mainPid = async () => Number(await property("MainPID"));
  const answer = async <T>(name: string): Promise<T | null> => {
    try {
      return JSON.parse(await readFile(join(proofDir, name), "utf8")) as T;
    } catch {
      return null;
    }
  };

  /** Wartet, bis systemd einen anderen Hauptprozess nennt als notPid und der Ersatz-Bot unter dieser PID bereit ist */
  const waitBot = (notPid: number) =>
    until("Ersatz-Bot bereit", 120_000, async () => {
      const pid = await mainPid();
      if (!pid || pid === notPid) return null;
      const r = await answer<{ pid: number; underSystemd: boolean }>("ready");
      return r && r.pid === pid ? r : null;
    });

  const readStatus = async (id: string): Promise<JobStatusView | null> => {
    try {
      return JSON.parse(await readFile(join(root, "data", "jobs", id, "status.json"), "utf8"));
    } catch {
      return null;
    }
  };

  const showProcs = (...pids: number[]) => show(`ps -ww -o pid,ppid,pgid,sid,lstart,args -p ${pids.join(",")}`);

  return {
    root,
    unitPath,
    botLog,
    proofDir,
    systemdDeps,
    property,
    showState,
    mainPid,
    readStatus,

    /** Protokoll des Ersatz-Bots und, soweit lesbar, die Zeilen von systemd zu diesem Dienst */
    async showLogs() {
      await show(`cat ${botLog}`);
      await show(`journalctl --user -u ${UNIT} --since @${since} --no-pager -o cat 2>&1 | tail -n 60`);
    },

    /** Schreibt die Dienstdatei (mit oder ohne KillMode-Zeile) und startet den Dienst */
    async start(killMode: boolean) {
      const rendered = renderSystemdUnit({ projectRoot: root, home: homedir(), bunPath: BUN });
      if (!rendered) throw new Error("renderSystemdUnit lehnt die Pfade ab");
      await mkdir(unitDir, { recursive: true });
      await writeFile(unitPath, proofUnit({ rendered, standIn: STAND_IN, root, claudePath, killMode }), { mode: 0o644 });
      await show("systemctl --user daemon-reload");
      await show(`sed -n '/^\\[Service\\]/,/^$/p' ${unitPath}`);
      await show(`systemctl --user start ${UNIT}`);
      const bot = await waitBot(0);
      await showState();
      return bot;
    },

    /** Der Ersatz-Bot startet den Job über die echte Job-CLI */
    async startJob(title: string, seconds: number): Promise<JobRun> {
      await writeFile(join(proofDir, "job-seconds"), `${seconds}\n`);
      await rm(join(proofDir, "job.result"), { force: true });
      await writeFile(join(proofDir, "job.request"), JSON.stringify({ title, text: `Warte ${seconds} Sekunden und schreibe dann „fertig“ in deinen Bericht.` }));
      const result = await until("Antwort der Job-CLI", 60_000, () => answer<{ code: number; stdout: string; stderr: string }>("job.result"));
      console.log(`Ersatz-Bot ruft auf: bun --no-env-file scripts/job.ts start --title "${title}" --text=…\n${`${result.stdout}${result.stderr}`.trimEnd()}`);
      expectEq(`${title}: job start aus dem Dienst, Exit-Code`, result.code, 0);
      const id = parseJobId(result.stdout);
      if (!id) throw new Error("Keine Job-Kennung in der Ausgabe von job start");
      const status = await until("Job läuft mit Wächter und Claude", 60_000, async () => {
        const s = await readStatus(id);
        return s?.phase === "running" && s.watcher && s.claude ? s : null;
      });
      const job: JobRun = { id, watcher: snapshot(status.watcher!.pid), claude: snapshot(status.claude!.pid) };
      started.push(job.watcher, job.claude);
      return job;
    },

    /** Meldet beim Ersatz-Bot einen Motor-Prozess an, der SIGINT samt Kind übergeht (beendet wie Codex: SIGINT, nach 3 Sekunden SIGKILL) */
    async startEngine(): Promise<ProcSnapshot> {
      await rm(join(proofDir, "engine.result"), { force: true });
      await writeFile(join(proofDir, "engine.request"), "");
      const engine = await until("Motor-Prozess gestartet", 30_000, () => answer<{ pid: number }>("engine.result"));
      // Kurz warten, bis die Shell ihr Kind gestartet hat
      await sleep(500);
      const before = snapshot(engine.pid);
      started.push(before);
      return before;
    },

    /** Bot, Wächter und Job-Claude in der Kontrollgruppe des Diensts */
    async expectSameCgroup(label: string, bot: number, job: JobRun) {
      await showProcs(bot, job.watcher.pid, job.claude.pid);
      await show([bot, job.watcher.pid, job.claude.pid].map(pid => `cat /proc/${pid}/cgroup`).join("; "));
      await show(`systemctl --user status ${UNIT} --no-pager --lines=0 | sed -n '/CGroup/,$p'`);
      const snaps = [snapshot(bot), job.watcher, job.claude];
      expectEq(`${label}: Bot, Wächter und Job-Claude in der Kontrollgruppe von ${UNIT}`, snaps.map(s => inUnitCgroup(s, UNIT)), [true, true, true]);
      expectEq(`${label}: Zahl verschiedener Kontrollgruppen der drei`, new Set(snaps.map(s => s.cgroup)).size, 1);
    },

    /** Nach einem Neustart: neue PID des Bots, alter Prozess weg, Wächter und Job-Claude unverändert (oder beide weg) */
    async expectAfterRestart(label: string, before: number, after: number, job: JobRun, survives: boolean) {
      console.log(`Bot vorher PID ${before}, nachher PID ${after}`);
      await showState();
      await showProcs(job.watcher.pid, job.claude.pid);
      expectEq(`${label}: PID des Bots gewechselt`, after !== before && after > 0, true);
      expectEq(`${label}: alter Bot-Prozess lebt noch`, alive(before), false);
      const now = [snapshot(job.watcher.pid), snapshot(job.claude.pid)];
      if (survives) {
        console.log(`Startzeit in Takten (Feld 22 aus /proc/<pid>/stat), vorher und nachher: Wächter ${job.watcher.startTicks} und ${now[0].startTicks}, Job-Claude ${job.claude.startTicks} und ${now[1].startTicks}`);
        expectEq(`${label}: Wächter und Job-Claude mit derselben PID und Startzeit`, [sameProcess(job.watcher, now[0]), sameProcess(job.claude, now[1])], [true, true]);
        expectEq(`${label}: beide weiter in der Kontrollgruppe von ${UNIT}`, now.map(s => inUnitCgroup(s, UNIT)), [true, true]);
      } else {
        expectEq(`${label}: Wächter und Job-Claude leben noch`, now.map(s => s.alive), [false, false]);
      }
    },

    async expectSuccess(label: string, job: JobRun) {
      const status = await until(`${label}: Job beendet`, 240_000, async () => {
        const s = await readStatus(job.id);
        return s?.phase === "ended" ? s : null;
      });
      await show(`cat data/jobs/${job.id}/status.json; echo; cat data/jobs/${job.id}/report.md`, { cwd: root });
      expectEq(`${label}: Abschluss (phase, outcome, exitCode)`, [status.phase, status.outcome, status.exitCode], ["ended", "success", 0]);
      expectEq(`${label}: Bericht`, (await readFile(join(root, "data", "jobs", job.id, "report.md"), "utf8").catch(() => "")).trim(), "fertig");
      // Der Wächter lebt hier weiter: Ohne Telegram und ohne Datenbank hat die Abschlussmeldung kein Ziel, er wiederholt den Versand
      expectEq(`${label}: Job-Claude lebt nach dem Abschluss noch`, alive(job.claude.pid), false);
    },

    /** Neustart nach Antwort mit dem echten Skript hinter `bun run restart:request`; der Marker liegt im Temp-Ordner */
    async requestRestart(note: string, from: number) {
      await show(`GO_PROJECT_ROOT=${root} ${BUN} ${REQUEST_SCRIPT} "${note}"`, { env, cwd: root });
      return (await waitBot(from)).pid;
    },

    async systemctlRestart(from: number) {
      await show(`systemctl --user restart ${UNIT}`);
      return (await waitBot(from)).pid;
    },

    /**
     * Dienst anhalten, übrige eigene Prozesse beenden, Dienstdatei und
     * Temp-Ordner entfernen. Beendet wird nur, was der Nachweis selbst
     * gestartet hat und was noch dieselbe Startzeit trägt. Kein `job stop`:
     * Dessen Abschlussmeldung hat hier kein Ziel und würde lange wiederholt.
     */
    async close(keep: boolean) {
      await run(["systemctl", "--user", "stop", UNIT]);
      for (const proc of started) {
        if (!sameProcess(proc, snapshot(proc.pid))) continue;
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          // schon weg
        }
      }
      await sleep(300);
      await rm(unitPath, { force: true });
      await run(["systemctl", "--user", "daemon-reload"]);
      await run(["systemctl", "--user", "reset-failed", UNIT]);
      expectEq("Aufräumen: übrige Prozesse des Nachweises", started.filter(proc => sameProcess(proc, snapshot(proc.pid))).map(proc => proc.pid), []);
      expectEq("Aufräumen: Dienst wieder unbekannt", await until("Dienst entladen", 15_000, async () => ((await property("LoadState")) === "not-found" ? "not-found" : null)).catch(() => property("LoadState")), "not-found");
      if (keep) console.log(`Temp-Ordner bleibt stehen: ${root}`);
      else await rm(root, { recursive: true, force: true });
    },
  };
}

type Session = Awaited<ReturnType<typeof openSession>>;

/** Fall A: neue Dienstdatei, beide Wege des Neustarts, Motor-Prozess, Abschluss */
async function caseNewUnit(s: Session): Promise<void> {
  header("A. Neue Dienstdatei mit KillMode=process");
  const a0 = await s.start(true);
  expectEq("A0: wirksamer KillMode", await s.property("KillMode"), KILL_MODE);
  expectEq("A0: der Ersatz-Bot erkennt systemd (runsUnderSystemd)", a0.underSystemd, true);

  header("A1/A2. Job aus dem Dienst, gemeinsame Kontrollgruppe");
  const job = await s.startJob("Probe 561", 100);
  await s.expectSameCgroup("A2", a0.pid, job);

  header("A3. Neustart über restart:request");
  const a1 = await s.requestRestart("Probe 561", a0.pid);
  await s.expectAfterRestart("A3", a0.pid, a1, job, true);
  await show(`grep -F "[Restart]" ${s.botLog}`);
  expectEq("A3: der Neustart lief über systemd", (await readFile(s.botLog, "utf8")).includes("[Restart] Neustart via systemd"), true);

  header("A4. Neustart über systemctl --user restart, mit laufendem Motor-Prozess");
  const engine = await s.startEngine();
  await show(`pgrep -g ${engine.pid} -a`);
  expectEq("A4: Motor-Gruppe lebt vor dem Neustart, in der Kontrollgruppe des Diensts", [groupAlive(engine.pid), inUnitCgroup(engine, UNIT)], [true, true]);
  const a2 = await s.systemctlRestart(a1);
  await show(`pgrep -g ${engine.pid} -a || echo "kein Prozess mehr in der Motor-Gruppe ${engine.pid}"`);
  expectEq("A4: Motor-Gruppe lebt nach dem Neustart noch", groupAlive(engine.pid), false);
  await s.expectAfterRestart("A4", a1, a2, job, true);

  header("A5. Abschluss des Jobs");
  await s.expectSuccess("A5", job);
  await show(`grep -F "[job] Beim Start" ${join(s.proofDir, "events.log")}`);
}

/** Fall B und C: Dienstdatei wie vor #561, erst die Gegenprobe, dann das Nachziehen im laufenden Dienst */
async function caseOldUnit(s: Session): Promise<void> {
  header("B. Gegenprobe: Dienstdatei wie vor #561, ohne KillMode-Zeile");
  const b0 = await s.start(false);
  expectEq("B0: wirksamer KillMode", await s.property("KillMode"), "control-group");
  expectEq("B0: tybo erkennt die Datei als veraltet (killModeOutdated)", killModeOutdated(await systemdUnitState(s.systemdDeps)), true);
  const jobB = await s.startJob("Gegenprobe 561", 100);
  await s.expectSameCgroup("B1", b0.pid, jobB);
  const b1 = await s.requestRestart("Gegenprobe 561", b0.pid);
  await s.expectAfterRestart("B2", b0.pid, b1, jobB, false);
  const lost = await until("Gegenprobe: Job als verloren gemeldet", 120_000, async () => {
    const status = await s.readStatus(jobB.id);
    return status?.phase === "ended" ? status : null;
  });
  await show(`cat data/jobs/${jobB.id}/status.json; echo`, { cwd: s.root });
  expectEq("B3: Abschluss (phase, outcome)", [lost.phase, lost.outcome], ["ended", "aborted"]);
  expectEq("B3: die Verlustmeldung nennt den Neustart des Bots", lost.detail, LOST_WATCHER_DETAIL);
  expectEq("B3: Bericht vorhanden", existsSync(join(s.root, "data", "jobs", jobB.id, "report.md")), false);

  header("C. Alte Dienstdatei nachziehen, ohne Neustart");
  const jobC = await s.startJob("Nachziehen 561", 60);
  await s.showState();
  const fixed = await ensureKillMode(s.systemdDeps);
  console.log(`ensureKillMode: ${JSON.stringify(fixed)}`);
  await show(`sed -n '/^\\[Service\\]/,/^Type=/p' ${s.unitPath}`);
  await s.showState();
  expectEq("C1: ensureKillMode", fixed.kind, "fixed");
  expectEq("C1: wirksamer KillMode ohne Neustart", await s.property("KillMode"), KILL_MODE);
  expectEq("C1: Bot nicht neu gestartet (MainPID, Prozess lebt)", [await s.mainPid(), alive(b1)], [b1, true]);
  expectEq("C1: zweiter Lauf von ensureKillMode", (await ensureKillMode(s.systemdDeps)).kind, "already");
  expectEq("C1: Datei noch veraltet (killModeOutdated)", killModeOutdated(await systemdUnitState(s.systemdDeps)), false);
  const c1 = await s.systemctlRestart(b1);
  await s.expectAfterRestart("C2", b1, c1, jobC, true);
  await s.expectSuccess("C3", jobC);
}

async function main(): Promise<number> {
  const keep = process.argv.includes("--keep");
  const runtime = process.env.XDG_RUNTIME_DIR?.trim();
  if (process.platform !== "linux" || !runtime) {
    console.error("Der Nachweis braucht Linux mit systemd und eine Anmeldung mit XDG_RUNTIME_DIR (kein sudo, kein su).");
    return EXIT_UNFIT;
  }
  const unitDir = join(runtime, "systemd", "user");
  const known = await run(["systemctl", "--user", "show", UNIT, "--property=LoadState"]);
  if (!known.ok) {
    console.error("Der Benutzer-Manager von systemd antwortet nicht (systemctl --user).");
    return EXIT_UNFIT;
  }
  if (parseShow(known.stdout).LoadState !== "not-found" || existsSync(systemdUnitPath(unitDir)) || existsSync(systemdUnitPath(SYSTEMD_USER_DIR))) {
    console.error(`Auf diesem Rechner gibt es schon einen Dienst ${UNIT}. Der Nachweis läuft nur auf einem Rechner ohne eingerichteten Bot (VM oder Container mit systemd).`);
    return EXIT_UNFIT;
  }
  await show("uname -sr; systemctl --version | head -1; stat -fc %T /sys/fs/cgroup");

  // Je Fall ein eigener Temp-Ordner: Meldungen ohne Ziel aus einem Fall halten das Aufräumen des nächsten nicht auf
  for (const runCase of [caseNewUnit, caseOldUnit]) {
    const session = await openSession(unitDir);
    try {
      await runCase(session);
      header("Protokoll des Ersatz-Bots und Journal von systemd");
      await session.showLogs();
    } catch (e) {
      failed++;
      console.log(`FEHL Abbruch: ${e instanceof Error ? e.message : String(e)}`);
      if (existsSync(session.botLog)) await show(`tail -n 40 ${session.botLog}`);
    } finally {
      await session.close(keep);
    }
  }

  console.log(`\nErgebnis: ${expectations} Erwartungen geprüft, ${failed} verfehlt.`);
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
