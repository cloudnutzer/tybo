/**
 * Hintergrund-Jobs starten und bewachen (Issue #103, Entscheidung 0016).
 *
 * startJob legt data/jobs/<id>/ an und startet losgelöst (eigene
 * Prozess-Session, stdin /dev/null) den Wächter `scripts/job.ts __watch <id>`.
 * Der Wächter startet Claude in einer eigenen Prozessgruppe, gibt ihm den
 * Auftrag über stdin, wartet auf das Ende und meldet sich immer: Erfolg mit
 * dem Bericht, sonst mit Exit-Code und Log-Auszug. Nach --max-hours beendet
 * er Claudes Prozessgruppe und meldet die Zeitüberschreitung.
 *
 * Startsperre: Der Prozess, den spawnClaude startet, wartet, bis der Wächter
 * PID und Startzeit im Status eingetragen hat (release), und startet erst
 * dann Claude. Stirbt der Wächter vorher, endet er, ohne Claude zu starten.
 * So läuft nie ein Claude, den der Status nicht kennt.
 *
 * Wer meldet, entscheidet claimOutcome (./store): Stop, Zeitüberschreitung,
 * Prozessende und das Aufräumen beim Bot-Start können sich überschneiden,
 * gemeldet wird trotzdem nur einmal.
 *
 * Werkzeugrechte (Entscheidung 0016): bypassPermissions nur mit
 * fullAccess (--full-access), also nur für Aufträge, die tybo selbst
 * formuliert hat. Sonst acceptEdits: Dateien im Projekt schreiben (auch den
 * Bericht) ja, Befehle ohne Rückfrage nein.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock, releaseFileLock, type LockOwner } from "../file-lock";
import type { SendAndRecordInput, SendAndRecordResult } from "../outbox";
import { maskSecrets } from "./mask";
import { deliverNotice, logSafe, settleAndDeliver, type NoticeDeps } from "./notice";
import { descendantsOf, ownProcessRef, processGone, terminateGroup, type ProcInfo, type ProcessOps } from "./process";
import { PRINT_MODE_DISALLOWED_TOOLS } from "../subprocess-env";
import {
  claimOutcome,
  jobDir,
  jobFile,
  jobsDir,
  readAllStatuses,
  readStatus,
  updateStatus,
  writeStatus,
  type ClaimExtra,
  type JobOutcome,
  type JobLeftover,
  type JobStatus,
  type JobTarget,
  type ProcRef,
} from "./store";

type Env = Record<string, string | undefined>;

export const DEFAULT_MAX_HOURS = 6;
export const MAX_MAX_HOURS = 72;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]{0,79}$/;
/** Bis dahin muss der Wächter den Job als laufend eingetragen haben */
export const START_CONFIRM_MS = 15_000;
/** Ein Job ohne Wächter-Eintrag gilt erst danach als verwaist (Starter könnte noch dabei sein) */
export const STARTING_GRACE_MS = 60_000;

export function reportInstruction(root: string, id: string): string {
  return `Schreibe am Ende einen kurzen Bericht nach data/jobs/${id}/report.md (voller Pfad: ${jobFile(root, id, "report")}).`;
}

/**
 * Regeln für jeden Job: `claude -p` endet mit dem letzten Turn, danach
 * passiert nichts mehr. Wer „ich warte auf die Meldung" schreibt, beendet
 * den Job (28.9., 30.9., 1.10.2026: drei Jobs ohne Bericht).
 */
export const JOB_RULES =
  "Regeln für diesen Job: Er endet, sobald du deinen Turn beendest; Meldungen über fertige Befehle kommen danach nicht mehr an. " +
  "Führe deshalb jeden Befehl im Vordergrund bis zum Ende aus, bei langen Befehlen mit großem timeout (bis 3600000 ms), " +
  "und starte nichts mit & oder nohup, auf dessen Ergebnis du wartest. Beende den Turn erst, wenn die Arbeit getan und der Bericht geschrieben ist.";

/** Auftrag, wie Claude ihn über stdin bekommt */
export function jobPrompt(root: string, id: string, brief: string): string {
  return `${brief.trimEnd()}\n\n---\n${reportInstruction(root, id)}\n\n${JOB_RULES}\n`;
}

export interface ClaudeCommandOptions {
  claudePath: string;
  model: string;
  effort?: string;
  fullAccess: boolean;
  platform: NodeJS.Platform;
}

export function claudeCommand(o: ClaudeCommandOptions): string[] {
  const args = ["-p", "--output-format", "text", "--model", o.model];
  if (o.effort) args.push("--effort", o.effort);
  args.push("--permission-mode", o.fullAccess ? "bypassPermissions" : "acceptEdits");
  // Monitor und Co. lassen claude -p nur warten (PRINT_MODE_DISALLOWED_TOOLS)
  args.push("--disallowedTools", PRINT_MODE_DISALLOWED_TOOLS.join(","));
  // Wie der Bot: auf macOS kein Ruhezustand, solange der Job läuft
  return o.platform === "darwin" ? ["/usr/bin/caffeinate", "-i", o.claudePath, ...args] : [o.claudePath, ...args];
}

export interface ClaudeSpawnSpec {
  id: string;
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  /** Geht über stdin, danach wird stdin geschlossen */
  prompt: string;
  /** stdout und stderr hängen hier an */
  logPath: string;
}

export interface SpawnedClaude {
  /** PID des Startprozesses; er wird per exec zu Claude, PID und Startzeit bleiben */
  pid: number;
  /** Exit-Code oder, bei Signal, code null und der Signalname */
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** Startsperre lösen: erst jetzt startet Claude und bekommt den Auftrag */
  release(): void;
  /** Startsperre schließen, ohne Claude zu starten; der Startprozess endet */
  cancel(): void;
  /** Alles aus stdout/stderr ist (maskiert) im Log; fehlt bei Attrappen, die direkt schreiben */
  drained?: Promise<void>;
}

export interface JobDeps extends NoticeDeps {
  /** Wächter losgelöst starten (eigene Session, stdin /dev/null) */
  spawnWatcher(id: string): { pid: number };
  /** Claude in eigener Prozessgruppe starten, hinter der Startsperre (release) */
  spawnClaude(spec: ClaudeSpawnSpec): SpawnedClaude;
  /** Umgebung für Claude (subprocessEnv, ohne Geheimnisse) */
  claudeEnv(status: JobStatus): Record<string, string>;
  claudePath: string;
  platform: NodeJS.Platform;
  newId(): string;
  startConfirmMs?: number;
  /** Nur für Tests: Zeitüberschreitung in ms statt maxHours */
  timeoutMsFor?(status: JobStatus): number;
  /** Nur für Tests: Takt der Prozess-Momentaufnahmen statt TRACK_INTERVAL_MS */
  trackIntervalMs?: number;
}

export interface StartInput {
  title: string;
  brief: string;
  target: JobTarget;
  maxHours: number;
  model: string;
  effort?: string;
  fullAccess: boolean;
  /** Auch starten, wenn ein Job mit gleichem Titel oder Auftrag läuft */
  allowDuplicate?: boolean;
}

export type StartResult =
  | { ok: true; id: string; status: JobStatus; confirmed: boolean }
  | { ok: false; id?: string; error: string; duplicateOf?: string };

const normTitle = (title: string) => title.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Läuft schon ein Job mit demselben Titel oder demselben Auftrag? Nach dem
 * Mac-Neustart am 30.9.2026 starteten zwei Sessions dieselben Fortsetzungen
 * je zweimal, parallel im selben Arbeitsbaum.
 */
export async function findDuplicate(root: string, title: string, brief: string): Promise<JobStatus | null> {
  const running = (await readAllStatuses(root)).filter(s => s.phase !== "ended");
  const wanted = normTitle(title);
  for (const status of running) {
    if (normTitle(status.title) === wanted) return status;
    const other = await readFile(jobFile(root, status.id, "brief"), "utf8").catch(() => null);
    if (other !== null && other.trim() === brief.trim()) return status;
  }
  return null;
}

/** Nach so langer Zeit wird nicht mehr auf den Rest der Ausgabe gewartet (Kinder mit offenem stdout) */
const DRAIN_WAIT_MS = 5_000;
/** So oft hält der Wächter fest, welche Prozesse Claude gestartet hat */
export const TRACK_INTERVAL_MS = 10_000;
/** So viele zurückgebliebene Prozesse stehen im Status (und in der Meldung) */
export const MAX_LEFTOVERS = 8;
const LEFTOVER_COMMAND_MAX = 160;
const LEFTOVER_SETTLE_MS = 3_000;

/**
 * Merkt sich die Prozesse unter Claude, solange sie leben. Nach Claudes Ende
 * hängen verwaiste Prozesse nicht mehr unter Claude (neue Eltern-PID 1),
 * deshalb zählt, was vorher unter Claude gesehen wurde und noch lebt.
 */
export class ProcessTracker {
  private tracked = new Map<number, ProcInfo>();

  constructor(private readonly root: number, private readonly ops: ProcessOps, private readonly ignore: ReadonlySet<number>) {}

  /** Neue Momentaufnahme; ohne Prozessliste (ps scheitert, Attrappe) bleibt alles, wie es ist */
  track(): void {
    const list = this.ops.listProcesses?.();
    if (!list) return;
    const alive = new Set(list.map(p => `${p.pid}|${p.identity}`));
    for (const [pid, p] of this.tracked) if (!alive.has(`${pid}|${p.identity}`)) this.tracked.delete(pid);
    for (const p of descendantsOf(this.root, list)) if (!this.ignore.has(p.pid)) this.tracked.set(p.pid, p);
  }

  /** Was davon jetzt noch lebt (gleiche PID und Startzeit) */
  survivors(): ProcInfo[] {
    const list = this.ops.listProcesses?.();
    if (!list) return [];
    const alive = new Set(list.map(p => `${p.pid}|${p.identity}`));
    return [...this.tracked.values()].filter(p => alive.has(`${p.pid}|${p.identity}`));
  }
}

/** Für Status und Meldung: Befehl maskiert und gekürzt, höchstens MAX_LEFTOVERS */
export function leftoverList(procs: readonly ProcInfo[], deps: Pick<JobDeps, "secrets">): JobLeftover[] {
  return procs.slice(0, MAX_LEFTOVERS).map(p => {
    const command = maskSecrets(p.command.replace(/\s+/g, " ").trim(), deps.secrets());
    return { pid: p.pid, command: command.length > LEFTOVER_COMMAND_MAX ? `${command.slice(0, LEFTOVER_COMMAND_MAX - 1)}…` : command };
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "Fehler";
}

async function finish(id: string, outcome: JobOutcome, extra: ClaimExtra, deps: JobDeps): Promise<boolean> {
  const me = ownProcessRef(deps.proc);
  // Der Grund landet in status.json: ohne Werte aus .env (Fehlertexte können sie enthalten)
  if (extra.detail !== undefined) extra = { ...extra, detail: maskSecrets(extra.detail, deps.secrets()) };
  const claim = await claimOutcome(deps.root, id, outcome, me, extra, deps.now);
  if (!claim.claimed) return false;
  await deliverNotice(id, claim.token!, deps);
  return true;
}

/**
 * Legt den Job an und startet den Wächter. Wartet bis zu startConfirmMs,
 * bis der Wächter Claude gestartet hat. Stirbt der Wächter vorher, gilt
 * der Start als gescheitert (mit Meldung).
 */
export async function startJob(input: StartInput, deps: JobDeps): Promise<StartResult> {
  const id = deps.newId();
  const dir = jobDir(deps.root, id);
  const status: JobStatus = {
    version: 1,
    id,
    title: input.title,
    createdAt: deps.now().toISOString(),
    phase: "starting",
    maxHours: input.maxHours,
    model: input.model,
    ...(input.effort ? { effort: input.effort } : {}),
    fullAccess: input.fullAccess,
    target: input.target,
  };
  // Prüfen und Anlegen unter einer Sperre: zwei gleichzeitige Starts sehen einander
  const startLock = join(jobsDir(deps.root), "start.lock");
  let lock: LockOwner | undefined;
  try {
    await mkdir(jobsDir(deps.root), { recursive: true, mode: 0o700 });
    lock = await acquireFileLock(startLock, { waitMs: 15_000 });
    if (!input.allowDuplicate) {
      const twin = await findDuplicate(deps.root, input.title, input.brief);
      if (twin) {
        const since = new Date(twin.startedAt ?? twin.createdAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
        const error = `Job ${twin.id} („${twin.title}") mit demselben Titel oder Auftrag läuft schon seit ${since}. Absichtlich doppelt: --allow-duplicate`;
        return { ok: false, error: maskSecrets(error, deps.secrets()), duplicateOf: twin.id };
      }
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(jobFile(deps.root, id, "brief"), input.brief, { mode: 0o600, flag: "wx" });
    await writeFile(jobFile(deps.root, id, "log"), "", { mode: 0o600, flag: "wx" });
    await writeStatus(deps.root, status);
  } catch (e) {
    return { ok: false, id, error: maskSecrets(`Job-Ordner nicht anlegbar (${errorText(e)})`, deps.secrets()) };
  } finally {
    if (lock !== undefined) await releaseFileLock(startLock, lock).catch(() => {});
  }

  let watcher: ProcRef | undefined;
  let watcherPid: number;
  try {
    const { pid } = deps.spawnWatcher(id);
    watcherPid = pid;
    const identity = deps.proc.identity(pid);
    // Ohne Startzeit kein Eintrag: der Wächter trägt sich dann selbst ein (oder die Frist läuft ab)
    if (identity !== null) watcher = { pid, identity };
  } catch (e) {
    const detail = maskSecrets(`Der Wächter ließ sich nicht starten (${errorText(e)}).`, deps.secrets());
    await finish(id, "start_failed", { detail }, deps);
    return { ok: false, id, error: detail };
  }
  // Der Wächter trägt sich selbst ein; hier nur, falls er es noch nicht getan hat
  if (watcher) {
    const ref = watcher;
    await updateStatus(deps.root, id, s => (s.phase === "starting" && !s.watcher ? { ...s, watcher: ref } : null));
  }

  const until = Date.now() + (deps.startConfirmMs ?? START_CONFIRM_MS);
  for (;;) {
    const current = await readStatus(deps.root, id);
    if (!current) return { ok: false, id, error: "Status verschwunden" };
    if (current.phase === "running") return { ok: true, id, status: current, confirmed: true };
    if (current.phase === "ended") {
      if (current.outcome === "start_failed") return { ok: false, id, error: current.detail ?? "Start gescheitert" };
      return { ok: true, id, status: current, confirmed: true };
    }
    // Gescheitert nur, wenn der Wächter sicher weg ist; ohne Startzeit zählt, ob die PID noch lebt
    const ref = current.watcher ?? watcher;
    if (ref ? processGone(ref, deps.proc) : !deps.proc.alive(watcherPid)) {
      const detail = "Der Wächter hat sich beim Start beendet (siehe watcher.log im Job-Ordner).";
      if (await finish(id, "start_failed", { detail }, deps)) return { ok: false, id, error: detail };
      continue;
    }
    if (Date.now() >= until) return { ok: true, id, status: current, confirmed: false };
    await deps.sleep(100);
  }
}

async function reportPresent(root: string, id: string): Promise<boolean> {
  try {
    const info = await stat(jobFile(root, id, "report"));
    if (!info.isFile() || info.size === 0) return false;
    return (await readFile(jobFile(root, id, "report"), "utf8")).trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Der Wächter (läuft als eigener Prozess). Gibt den Exit-Code des
 * Wächters zurück: 0, wenn er seine Arbeit getan hat (auch wenn der Job
 * scheiterte), 1 bei unbrauchbarem Job-Ordner.
 */
export async function runWatcher(id: string, deps: JobDeps): Promise<number> {
  const me = ownProcessRef(deps.proc);
  if (me.identity === null) {
    // Ohne eigene Startzeit hielte das Aufräumen beim Bot-Start den Wächter für tot
    const current = await readStatus(deps.root, id);
    if (!current) return 1;
    if (current.phase === "starting") await finish(id, "start_failed", { detail: "Der Wächter konnte seine Prozessidentität nicht ermitteln." }, deps);
    return 0;
  }
  const entered = await updateStatus(deps.root, id, s => (s.phase === "starting" ? { ...s, watcher: me } : null));
  if (!entered.status) {
    logSafe(deps, `[job] ${id}: kein Status, Wächter endet`);
    return 1;
  }
  if (!entered.changed) {
    // Schon beendet (etwa vor dem Start gestoppt) oder schon bewacht
    logSafe(deps, `[job] ${id}: Job ist ${entered.status.phase}, Wächter endet`);
    return 0;
  }
  const status = entered.status;

  let brief: string;
  try {
    brief = await readFile(jobFile(deps.root, id, "brief"), "utf8");
  } catch {
    await finish(id, "start_failed", { detail: "Der Auftrag (brief.md) ist nicht lesbar." }, deps);
    return 0;
  }

  const cmd = claudeCommand({ claudePath: deps.claudePath, model: status.model, effort: status.effort, fullAccess: status.fullAccess, platform: deps.platform });
  let child: SpawnedClaude;
  try {
    child = deps.spawnClaude({
      id,
      cmd,
      cwd: deps.root,
      env: deps.claudeEnv(status),
      prompt: jobPrompt(deps.root, id, brief),
      logPath: jobFile(deps.root, id, "log"),
    });
  } catch (e) {
    await finish(id, "start_failed", { detail: `Claude ließ sich nicht starten (${errorText(e)}).` }, deps);
    return 0;
  }
  const identity = deps.proc.identity(child.pid);
  if (identity === null) {
    // Ohne Startzeit ließe sich Claude später nicht sicher beenden: gar nicht erst starten
    child.cancel();
    await child.exited;
    await finish(id, "start_failed", { detail: "Die Prozessidentität des Claude-Prozesses war nicht ermittelbar, Claude wurde nicht gestartet." }, deps);
    return 0;
  }
  const claude: ProcRef = { pid: child.pid, identity };

  const running = await updateStatus(deps.root, id, s =>
    s.phase === "starting" ? { ...s, phase: "running", startedAt: deps.now().toISOString(), claude } : null,
  );
  if (!running.changed) {
    // In der Zwischenzeit gestoppt: Claude gar nicht erst starten, gemeldet hat der Stopp
    logSafe(deps, `[job] ${id}: vor dem Start beendet, Claude startet nicht`);
    child.cancel();
    await terminateGroup(claude, deps.proc);
    await child.exited;
    return 0;
  }
  // Erst jetzt, da PID und Startzeit im Status stehen, startet Claude
  child.release();
  // Wer nach Claudes Ende noch läuft, kommt in die Meldung (etwa ein mit & gestarteter Testlauf)
  const tracker = new ProcessTracker(claude.pid, deps.proc, new Set([process.pid, claude.pid]));
  const tracking = setInterval(() => tracker.track(), deps.trackIntervalMs ?? TRACK_INTERVAL_MS);
  tracking.unref?.();

  const timeoutMs = deps.timeoutMsFor?.(status) ?? status.maxHours * 3_600_000;
  let timedOut: Promise<void> | null = null;
  const timer = setTimeout(() => {
    timedOut = (async () => {
      const claim = await claimOutcome(deps.root, id, "timeout", me, { detail: `Nach ${status.maxHours} Std beendet.`, terminate: true }, deps.now);
      if (claim.claimed) {
        await settleAndDeliver(id, claim.token!, deps);
        return;
      }
      // Ein anderer Abschluss (stop) war schneller; beenden schadet trotzdem nicht
      const result = await terminateGroup(claude, deps.proc);
      if (result !== "gone") logSafe(deps, `[job] ${id}: Prozessgruppe nach Zeitüberschreitung: ${result}`);
    })().catch(e => logSafe(deps, `[job] ${id}: Zeitüberschreitung: ${errorText(e)}`));
  }, timeoutMs);

  const exit = await child.exited;
  clearInterval(tracking);
  clearTimeout(timer);
  if (timedOut) await timedOut;
  // Was Claude an Kindern hinterlassen hat (MCP-Server, Shells), mit beenden
  await terminateGroup(claude, deps.proc, { graceMs: 2_000 }).catch(() => {});
  // Rest der Ausgabe ins Log, damit der Log-Auszug vollständig ist
  if (child.drained) await Promise.race([child.drained, deps.sleep(DRAIN_WAIT_MS)]);

  const outcome: JobOutcome =
    exit.code === 0 ? ((await reportPresent(deps.root, id)) ? "success" : "no_report") : "failed";
  // MCP-Server und Shells brauchen nach Claudes Ende einen Moment; nur wer danach noch lebt, zählt
  let survivors = tracker.survivors();
  if (survivors.length) {
    await deps.sleep(LEFTOVER_SETTLE_MS);
    survivors = tracker.survivors();
  }
  const leftovers = leftoverList(survivors, deps);
  if (leftovers.length) logSafe(deps, `[job] ${id}: nach Claudes Ende laufen noch ${leftovers.map(p => p.pid).join(", ")}`);
  await finish(id, outcome, { exitCode: exit.code, signal: exit.signal, ...(leftovers.length ? { leftovers } : {}) }, deps);
  return 0;
}

export type { SendAndRecordInput, SendAndRecordResult, Env };
