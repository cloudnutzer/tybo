/** Fortsetzen mit derselben Session: Sperren, Vorbedingungen und verspätete Wächter. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectDir } from "../src/lib/engines/claude-notes";
import { runJobCli, type JobCliOptions } from "../src/lib/jobs/cli";
import { formatJobList, jobLog, recoverJobs } from "../src/lib/jobs/control";
import { composeNotice, jobDuration } from "../src/lib/jobs/notice";
import { resumeJob, resumeMessage } from "../src/lib/jobs/resume";
import { claudeCommand, JOB_RULES, runWatcher } from "../src/lib/jobs/runner";
import { claimOutcome, claimResume, jobDir, jobFile, readStatus, writeStatus, type JobStatus } from "../src/lib/jobs/store";
import { fakeChild, fakeDeps, tempRoot, type FakeDeps } from "./jobs-fixture";

let root: string, cleanup: () => void, deps: FakeDeps;
const id = "20261118-120000-000623";
const sessionId = "12345678-1234-4234-8234-123456789abc";
const now = new Date("2026-11-18T12:00:00Z");
const sessionFile = () => join(claudeProjectDir(root, root), `${sessionId}.jsonl`);
beforeEach(() => {
  ({ root, cleanup } = tempRoot("jobs-resume-"));
  deps = fakeDeps(root, { now: () => now });
  deps.claudeEnv = status => ({ HOME: root, TYBO_JOB_ID: status.id });
});
afterEach(() => cleanup());

async function prepare(over: Partial<JobStatus> = {}): Promise<JobStatus> {
  const status: JobStatus = {
    version: 1, id, title: "Fortsetzen testen", createdAt: "2026-11-17T10:00:00Z",
    run: 1, runCreatedAt: "2026-11-17T10:00:00Z", startedAt: "2026-11-17T10:00:01Z",
    endedAt: "2026-11-17T12:00:00Z", phase: "ended", outcome: "aborted",
    engine: "claude", model: "claude-test", effort: "high", maxHours: 2, fullAccess: false,
    allowedTools: ["WebSearch"], deniedTools: ["Edit(./config/**)"], sessionId,
    target: { chatId: "-100200", topicId: 443 }, watcher: { pid: 60001, identity: "alt" },
    claude: { pid: 60002, identity: "alt" }, termination: { state: "done", result: "gone" },
    notice: { state: "sent", attempts: 1 }, exitCode: null, signal: "SIGTERM", detail: "Abbruch",
    leftovers: [{ pid: 60003, command: "alter Prozess" }], ...over,
  };
  await writeStatus(root, status);
  await Bun.write(jobFile(root, id, "brief"), "Auftrag wie vorher.");
  await Bun.write(jobFile(root, id, "log"), "alter Lauf\n");
  await Bun.write(jobFile(root, id, "report"), "alter Bericht");
  mkdirSync(claudeProjectDir(root, root), { recursive: true });
  writeFileSync(sessionFile(), "{}\n");
  return status;
}

function fakeWatcher(report?: string, code = 0) {
  let watching: Promise<number> = Promise.resolve(0);
  let starts = 0;
  deps.spawnClaude = spec => {
    deps.spawned.push(spec);
    const pid = deps.procs.spawn(60004);
    return fakeChild(pid, Promise.resolve({ code, signal: null }), () => {
      if (report !== undefined) writeFileSync(jobFile(root, id, "report"), report);
    });
  };
  deps.spawnWatcher = (id, run) => {
    starts++;
    watching = runWatcher(id, deps, run);
    return { pid: process.pid };
  };
  return { finished: () => watching, starts: () => starts };
}

function waitingWatcher() {
  let starts = 0;
  deps.startConfirmMs = 0;
  deps.spawnWatcher = () => { starts++; return { pid: deps.procs.spawn(60005) }; };
  return () => starts;
}

test.each([false, true])("gleiche Session, Rechte, Modell, Effort und Ziel; fullAccess=%s", async fullAccess => {
  const old = await prepare({ fullAccess, returnToChat: true, jobChain: 2 });
  const watch = fakeWatcher("neuer Bericht");
  const result = await resumeJob(id, deps);
  expect(result.ok).toBe(true);
  await watch.finished();
  const status = (await readStatus(root, id))!;
  expect(status).toMatchObject({ run: 2, sessionId, model: old.model, effort: old.effort, fullAccess,
    maxHours: 2, target: old.target, allowedTools: old.allowedTools, deniedTools: old.deniedTools, returnToChat: true, jobChain: 2,
    outcome: "success", notice: { state: "sent", attempts: 1 }, startedAt: now.toISOString() });
  expect(watch.starts()).toBe(1);
  const spec = deps.spawned[0];
  const first = claudeCommand({ claudePath: "claude", model: old.model!, effort: old.effort, fullAccess,
    sessionId, platform: "linux", allowedTools: old.allowedTools, deniedTools: old.deniedTools });
  expect(spec.cmd).toEqual(first.map(arg => arg === "--session-id" ? "--resume" : arg));
  expect(spec.prompt).toContain("Du wurdest unterbrochen (Wächter abgebrochen)");
  expect(spec.prompt).toContain(`data/jobs/${id}/report.md`);
  expect(spec.prompt).toContain("volle Zeitlimit von 2 Std");
  expect(spec.prompt).toContain(JOB_RULES);
  expect(spec.prompt).not.toContain(sessionId);
  expect(deps.sent).toHaveLength(1);
  expect(deps.sent[0]).toMatchObject({ ...old.target, text: expect.stringContaining("neuer Bericht") });
  expect(readFileSync(join(jobDir(root, id), "report-run-1.md"), "utf8")).toBe("alter Bericht");
  expect(await formatJobList(deps)).toContain("Lauf 2");
  expect(await formatJobList(deps)).not.toContain(sessionId);
  expect(JSON.stringify(deps.sent) + deps.logs.join()).not.toContain(sessionId);
});

test("zwei gleichzeitige Fortsetzungen starten genau einen Wächter", async () => {
  await prepare();
  const starts = waitingWatcher();
  const results = await Promise.all([resumeJob(id, deps), resumeJob(id, deps)]);
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(starts()).toBe(1);
  expect(results.find(r => !r.ok)).toMatchObject({ error: expect.stringContaining("läuft schon") });
  expect(await readStatus(root, id)).toMatchObject({ phase: "starting", run: 2 });
});

test("Status-Sperre gewinnt auch unabhängig von start.lock nur einmal; alte Felder sind weg", async () => {
  const before = await prepare();
  const results = await Promise.all([claimResume(root, id, 1, () => now), claimResume(root, id, 1, () => now)]);
  expect(results.filter(r => r.changed)).toHaveLength(1);
  const status = (await readStatus(root, id))!;
  expect(status).toMatchObject({ run: 2, phase: "starting", resumeReason: "aborted", runCreatedAt: now.toISOString(), createdAt: before.createdAt });
  for (const field of ["watcher", "claude", "termination", "notice", "outcome", "startedAt", "endedAt", "exitCode", "signal", "detail", "leftovers"]) expect(status).not.toHaveProperty(field);
  expect(jobDuration(status, new Date(now.getTime() + 120000))).toBe("2 Min");
  expect(existsSync(jobFile(root, id, "report"))).toBe(false);
  expect(readFileSync(join(jobDir(root, id), "job-run-1.log"), "utf8")).toBe("alter Lauf\n");
});

test.each(["stopped", "success", "failed", "no_report", "start_failed"] as const)("Ausgang %s darf keinen neuen Lauf eröffnen", async outcome => {
  await prepare({ outcome });
  const starts = waitingWatcher();
  expect(await resumeJob(id, deps)).toMatchObject({ ok: false, error: expect.stringContaining("Nur abgebrochene") });
  expect((await claimResume(root, id, 1)).changed).toBe(false);
  expect(starts()).toBe(0);
});

test.each([
  { engine: "codex" }, { workDir: "/entwurf" }, { sessionId: undefined }, { sessionId: "../../fremd" },
  { claude: undefined }, { startedAt: undefined }, { termination: undefined },
  { termination: { state: "pending" } },
  { termination: { state: "done", result: "survived" } },
  { termination: { state: "done", result: "unverified" } },
  { notice: undefined }, { notice: { state: "pending", attempts: 0 } }, { notice: { state: "sending", attempts: 1 } },
] as Partial<JobStatus>[])("Vorbedingung verhindert Fortsetzen: %j", async over => {
  await prepare(over);
  const starts = waitingWatcher();
  expect(await resumeJob(id, deps)).toMatchObject({ ok: false });
  expect((await claimResume(root, id, 1)).changed).toBe(false);
  expect(starts()).toBe(0);
  expect(existsSync(jobFile(root, id, "report"))).toBe(true);
});

test("foreign und endgültig fehlgeschlagener Versand erlauben Fortsetzen nach Timeout", async () => {
  await prepare({ outcome: "timeout", termination: { state: "done", result: "foreign" }, notice: { state: "failed", attempts: 6 } });
  const watch = fakeWatcher();
  expect((await resumeJob(id, deps)).ok).toBe(true);
  await watch.finished();
  expect(deps.spawned[0].prompt).toContain("Zeit überschritten");
  expect(await readStatus(root, id)).toMatchObject({ outcome: "no_report", run: 2 });
  expect(deps.sent[0].text).not.toContain("alter Bericht");
});

test("laufender Wächter wird abgelehnt; toter Wächter verlangt erst recoverJobs", async () => {
  await prepare({ phase: "running", watcher: { pid: deps.procs.spawn(60001), identity: "start-60001" } });
  expect(await resumeJob(id, deps)).toMatchObject({ ok: false, error: expect.stringContaining("läuft schon") });
  deps.procs.living.delete(60001);
  expect(await resumeJob(id, deps)).toMatchObject({ ok: false, error: expect.stringContaining("recoverJobs") });
  expect((await recoverJobs(deps)).aborted).toEqual([id]);
  const starts = waitingWatcher();
  expect((await resumeJob(id, deps)).ok).toBe(true);
  expect(starts()).toBe(1);
});

test("fehlende Session oder falsches HOME: keine neue Session, kein Wächter", async () => {
  await prepare();
  const starts = waitingWatcher();
  deps.claudeEnv = () => ({ HOME: join(root, "anderes-home") });
  expect(await resumeJob(id, deps)).toMatchObject({ ok: false, error: expect.stringContaining("Session fehlt") });
  deps.claudeEnv = () => ({ HOME: root });
  unlinkSync(sessionFile());
  expect(await resumeJob(id, deps)).toMatchObject({ ok: false, error: expect.stringContaining("Session fehlt") });
  expect(starts()).toBe(0);
  expect(await readStatus(root, id)).toMatchObject({ run: 1, phase: "ended" });
  expect(() => claudeCommand({ claudePath: "claude", model: "m", fullAccess: false, platform: "linux", resume: true })).toThrow("ohne gespeicherte");
});

test("Session verschwindet vor dem Wächter: fehlgeschlagen ohne frischen Claude-Start", async () => {
  await prepare();
  await claimResume(root, id, 1, () => now);
  unlinkSync(sessionFile());
  await runWatcher(id, deps, 2);
  expect(deps.spawned).toHaveLength(0);
  expect(await readStatus(root, id)).toMatchObject({ run: 2, outcome: "failed", detail: expect.stringContaining("Session fehlt") });
});

test("CLI lehnt vorhandene Session ab: Lauf fehlgeschlagen, kein Rückfall auf einen frischen Start", async () => {
  await prepare();
  const watch = fakeWatcher(undefined, 1);
  await resumeJob(id, deps);
  await watch.finished();
  expect(await readStatus(root, id)).toMatchObject({ run: 2, outcome: "failed", notice: { state: "sent" } });
  expect(deps.spawned).toHaveLength(1);
  expect(deps.spawned[0].cmd).toContain("--resume");
  expect(deps.spawned[0].cmd).not.toContain("--session-id");
});

test.each(["title", "brief"])("ein nachträglich gestarteter gleicher Auftrag (%s) verhindert Fortsetzen", async same => {
  const old = await prepare();
  const twin = "20261118-130000-000624";
  await writeStatus(root, { ...old, id: twin, phase: "running", title: same === "title" ? old.title.toUpperCase() : "Anderer Titel" });
  await Bun.write(jobFile(root, twin, "brief"), same === "brief" ? "Auftrag wie vorher." : "Anderer Auftrag");
  const starts = waitingWatcher();
  expect(await resumeJob(id, deps)).toMatchObject({ ok: false, duplicateOf: twin });
  expect(starts()).toBe(0);
});

test("neuer Lauf hat eigene Schonfrist; verspätete Wächter und Abschlüsse des alten Laufs wirken nicht", async () => {
  await prepare();
  await claimResume(root, id, 1, () => now);
  expect((await recoverJobs(deps)).deferred).toEqual([id]);
  expect((await claimOutcome(root, id, "failed", { pid: 60001, identity: "alt" }, { expectedRun: 1 })).claimed).toBe(false);
  await runWatcher(id, deps, 1);
  expect(deps.spawned).toHaveLength(0);
  expect(await readStatus(root, id)).toMatchObject({ run: 2, phase: "starting" });
});

test("CLI resume validiert die ID, zeigt Lauf 2 und nutzt das ursprüngliche Ziel", async () => {
  await prepare();
  waitingWatcher();
  const out: string[] = [], err: string[] = [];
  const options: JobCliOptions = { cwd: root, callerEnv: { TYBO_CHAT_ID: "anderes-ziel" }, out: t => out.push(t), err: t => err.push(t),
    deps, outbox: {}, defaultModel: "anderes-modell", defaultEffort: () => "low" };
  expect(await runJobCli(["resume", "../fremd"], options)).toBe(2);
  expect(await runJobCli(["resume", id], options)).toBe(0);
  expect(out.join()).toContain("Lauf 2 startet");
  expect(await readStatus(root, id)).toMatchObject({ target: { chatId: "-100200", topicId: 443 }, model: "claude-test", effort: "high" });
  expect(await runJobCli(["resume", id], options)).toBe(1);
  expect(err.join()).toContain("läuft schon");
  expect(resumeMessage({ ok: false, error: "Grund" })).toBe("Grund");
});

test("Session-ID bleibt auch bei Ausgabe durch Claude aus Meldung, Liste und Log-Ausgabe verborgen", async () => {
  const status = await prepare({ title: `Titel ${sessionId}` });
  writeFileSync(jobFile(root, id, "log"), `Keine Session ${sessionId}`);
  expect(await composeNotice(root, status, [], now)).not.toContain(sessionId);
  expect(await formatJobList(deps)).not.toContain(sessionId);
  expect(await jobLog(id, deps)).not.toContain(sessionId);
});
