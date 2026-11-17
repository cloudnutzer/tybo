/**
 * Issue #103, Checkbox 1: Job-Ordner, Status mit Sperre, Start mit
 * Attrappe für den Prozessstart. Kein echtes claude, kein Telegram.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseStartArgs, resolveJobTarget, runJobCli, type JobCliOptions } from "../src/lib/jobs/cli";
import { claudeCommand, jobPrompt, startJob, type StartInput } from "../src/lib/jobs/runner";
import { claimOutcome, jobDir, newJobId, readAllStatuses, readStatus, updateStatus } from "../src/lib/jobs/store";
import { fakeDeps, tempRoot } from "./jobs-fixture";

const { root, cleanup } = tempRoot();
afterAll(cleanup);

let inputs = 0;
/** Jeder Aufruf ein eigener Titel und Auftrag: laufende Jobs im gemeinsamen Ordner sind sonst Doppel */
const input = (over: Partial<StartInput> = {}): StartInput => ({
  title: `Recherche Wärmepumpen ${++inputs}`,
  brief: `Finde drei Anbieter (${inputs}).`,
  target: { topicId: 443 },
  maxHours: 6,
  model: "claude-test",
  fullAccess: false,
  ...over,
});

/** Wächter-Attrappe: trägt den Job nach kurzer Zeit als laufend ein, wie der echte Wächter */
function runningWatcher(deps: ReturnType<typeof fakeDeps>) {
  return (id: string) => {
    const pid = deps.procs.spawn(41_000);
    setTimeout(() => {
      void updateStatus(root, id, s => ({ ...s, phase: "running", watcher: { pid, identity: `start-${pid}` }, startedAt: new Date().toISOString() }));
    }, 20);
    return { pid };
  };
}

describe("startJob: keine Doppel (30.9.2026)", () => {
  const { root: own, cleanup: clean } = tempRoot("jobs-dup-");
  afterAll(clean);
  const twin = (over: Partial<StartInput> = {}): StartInput => ({ ...input(), title: "Streaming-Wächter (Fortsetzung)", brief: "Mach weiter.", ...over });
  const ownDeps = () => {
    const deps = fakeDeps(own);
    deps.spawnWatcher = (id: string) => {
      const pid = deps.procs.spawn(41_500);
      setTimeout(() => void updateStatus(own, id, s => ({ ...s, phase: "running", watcher: { pid, identity: `start-${pid}` }, startedAt: new Date().toISOString() })), 20);
      return { pid };
    };
    return deps;
  };

  test("gleicher Titel (Groß/klein, Leerzeichen egal) oder gleicher Auftrag: nicht gestartet, nichts angelegt", async () => {
    const first = await startJob(twin(), ownDeps());
    expect(first.ok).toBe(true);
    const before = (await readAllStatuses(own)).length;
    for (const over of [{ title: "  streaming-wächter   (FORTSETZUNG) " }, { title: "Ganz anders", brief: "  Mach weiter.\n" }]) {
      const again = await startJob(twin(over), ownDeps());
      expect(again).toMatchObject({ ok: false, duplicateOf: first.ok ? first.id : "" });
      if (!again.ok) expect(again.error).toContain("--allow-duplicate");
    }
    expect((await readAllStatuses(own)).length).toBe(before);
  });

  test("--allow-duplicate startet trotzdem; ein beendeter Job zählt nicht", async () => {
    const forced = await startJob(twin({ allowDuplicate: true }), ownDeps());
    expect(forced.ok).toBe(true);
    for (const s of await readAllStatuses(own)) await updateStatus(own, s.id, x => ({ ...x, phase: "ended", outcome: "success" }));
    expect((await startJob(twin(), ownDeps())).ok).toBe(true);
  });

  test("zwei gleichzeitige Starts: genau einer läuft", async () => {
    for (const s of await readAllStatuses(own)) await updateStatus(own, s.id, x => ({ ...x, phase: "ended", outcome: "success" }));
    const results = await Promise.all([startJob(twin({ title: "Parallel" }), ownDeps()), startJob(twin({ title: "Parallel" }), ownDeps())]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
  });

  test("CLI: Exit 2 mit Hinweis, --allow-duplicate wird erkannt", () => {
    expect(parseStartArgs(["--title", "T", "--text", "a", "--allow-duplicate"])).toMatchObject({ allowDuplicate: true });
    expect(parseStartArgs(["--title", "T", "--text", "a"])).not.toHaveProperty("allowDuplicate");
  });
});

describe("Job-IDs und Ordner", () => {
  test("ID aus Startzeit und Zufall; nur gültige IDs ergeben einen Ordner unter data/jobs", () => {
    expect(newJobId(new Date("2026-09-25T14:30:12Z"), () => "a1b2c3")).toBe("20260925-143012-a1b2c3");
    expect(jobDir(root, "20260925-143012-a1b2c3")).toBe(join(root, "data", "jobs", "20260925-143012-a1b2c3"));
    for (const bad of ["../x", "20260925-143012-a1b2c3/..", "", "abc", "20260925-143012-A1B2C3"]) {
      expect(() => jobDir(root, bad)).toThrow();
    }
  });
});

describe("startJob", () => {
  test("legt brief.md, job.log und status.json an und wartet, bis der Wächter läuft", async () => {
    const deps = fakeDeps(root);
    deps.spawnWatcher = runningWatcher(deps);
    const given = input();
    const result = await startJob(given, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.confirmed).toBe(true);
    const dir = jobDir(root, result.id);
    expect(readFileSync(join(dir, "brief.md"), "utf8")).toBe(given.brief);
    expect(readFileSync(join(dir, "job.log"), "utf8")).toBe("");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const status = (await readStatus(root, result.id))!;
    expect(status).toMatchObject({ version: 1, title: given.title, phase: "running", target: { topicId: 443 }, maxHours: 6, model: "claude-test", fullAccess: false });
    expect(status.watcher?.pid).toBe(41_000);
    expect(deps.sent).toEqual([]);
  });

  test("Werkzeugregeln (Issue #493) stehen im Status; ohne Angabe fehlen sie", async () => {
    const deps = fakeDeps(root);
    deps.spawnWatcher = runningWatcher(deps);
    const result = await startJob(input({ allowedTools: ["WebSearch"], deniedTools: ["Edit(./config/**)"] }), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await readStatus(root, result.id)).toMatchObject({ allowedTools: ["WebSearch"], deniedTools: ["Edit(./config/**)"], fullAccess: false });
    const plain = await startJob(input(), deps);
    if (!plain.ok) throw new Error("nicht gestartet");
    const status = (await readStatus(root, plain.id))!;
    expect("allowedTools" in status || "deniedTools" in status).toBe(false);
  });

  test("eigener Arbeitsordner (Issue #493): steht im Status; fehlt er, ist er relativ oder kommt --full-access dazu, startet nichts", async () => {
    const deps = fakeDeps(root);
    deps.spawnWatcher = runningWatcher(deps);
    const work = join(root, "arbeitsordner");
    mkdirSync(work, { recursive: true });
    const result = await startJob(input({ workDir: work }), deps);
    if (!result.ok) throw new Error("nicht gestartet");
    expect(await readStatus(root, result.id)).toMatchObject({ workDir: work, fullAccess: false });
    expect(await startJob(input({ workDir: join(root, "fehlt") }), deps)).toMatchObject({ ok: false });
    expect(await startJob(input({ workDir: "relativ" }), deps)).toMatchObject({ ok: false });
    expect(await startJob(input({ workDir: work, fullAccess: true }), deps)).toMatchObject({ ok: false, error: expect.stringContaining("nie mit --full-access") });
  });

  test("Wächter lässt sich nicht starten: Status „nicht gestartet“ und genau eine Meldung im Zielgespräch", async () => {
    const deps = fakeDeps(root);
    deps.spawnWatcher = () => {
      throw new Error("ENOENT");
    };
    const result = await startJob(input(), deps);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Wächter ließ sich nicht starten") });
    const status = (await readStatus(root, result.id!))!;
    expect(status).toMatchObject({ phase: "ended", outcome: "start_failed", notice: { state: "sent", attempts: 1 } });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]).toMatchObject({ source: "job", topicId: 443, text: expect.stringContaining("Job nicht gestartet") });
  });

  test("Wächter stirbt vor dem Eintrag: Start gescheitert, eine Meldung", async () => {
    const deps = fakeDeps(root);
    deps.spawnWatcher = () => ({ pid: 999_999 }); // lebt nie
    const result = await startJob(input({ target: {} }), deps);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("beim Start beendet") });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0].topicId).toBeUndefined();
    expect(deps.sent[0].chatId).toBeUndefined();
  });

  test("Wächter lebt, trägt sich aber nicht rechtzeitig ein: gilt als startend, keine Meldung", async () => {
    const deps = fakeDeps(root);
    deps.startConfirmMs = 50;
    deps.sleep = ms => new Promise(r => setTimeout(r, Math.min(ms, 10)));
    const result = await startJob(input(), deps);
    expect(result).toMatchObject({ ok: true, confirmed: false });
    expect(deps.sent).toEqual([]);
  });
});

describe("Statusübergänge", () => {
  test("claimOutcome: bei gleichzeitigen Abschlüssen gewinnt genau einer", async () => {
    const deps = fakeDeps(root);
    deps.spawnWatcher = runningWatcher(deps);
    const started = await startJob(input(), deps);
    if (!started.ok) throw new Error("Start");
    const me = { pid: process.pid, identity: null };
    const outcomes = ["stopped", "timeout", "failed", "success", "aborted"] as const;
    const claims = await Promise.all(outcomes.map(o => claimOutcome(root, started.id, o, me)));
    expect(claims.filter(c => c.claimed)).toHaveLength(1);
    const winner = outcomes[claims.findIndex(c => c.claimed)];
    const status = (await readStatus(root, started.id))!;
    expect(status.outcome).toBe(winner);
    expect(status.notice?.state).toBe("pending");
    // Danach gewinnt niemand mehr
    expect((await claimOutcome(root, started.id, "failed", me)).claimed).toBe(false);
  });
});

describe("Claude-Aufruf", () => {
  test("Auftrag über stdin mit Berichtsanweisung; bypassPermissions nur mit fullAccess", () => {
    const id = "20260925-143012-a1b2c3";
    const prompt = jobPrompt("/proj", id, "Tu etwas.\n");
    expect(prompt).toStartWith("Tu etwas.\n\n---\n");
    expect(prompt).toContain(`Schreibe am Ende einen kurzen Bericht nach data/jobs/${id}/report.md`);
    expect(prompt).toContain(`/proj/data/jobs/${id}/report.md`);
    // Jobs endeten ohne Bericht, weil Claude auf Hintergrund-Befehle „wartete" (28.9., 30.9., 1.10.2026)
    expect(prompt).toContain("Führe deshalb jeden Befehl im Vordergrund bis zum Ende aus");

    const base = { claudePath: "claude", model: "m", platform: "linux" as const };
    const noWaiting = ["--disallowedTools", "Monitor,ScheduleWakeup,CronCreate"];
    expect(claudeCommand({ ...base, fullAccess: false })).toEqual([
      "claude", "-p", "--output-format", "text", "--model", "m", "--permission-mode", "acceptEdits", ...noWaiting,
    ]);
    expect(claudeCommand({ ...base, fullAccess: true, effort: "high" })).toEqual([
      "claude", "-p", "--output-format", "text", "--model", "m", "--effort", "high", "--permission-mode", "bypassPermissions", ...noWaiting,
    ]);
    expect(claudeCommand({ ...base, fullAccess: false, platform: "darwin" }).slice(0, 3)).toEqual(["/usr/bin/caffeinate", "-i", "claude"]);
  });
});

describe("job start: Aufruf und Rückmeldeziel", () => {
  test("Argumente", () => {
    expect(parseStartArgs(["--title", "T", "--text", "Auftrag"])).toEqual({ title: "T", text: "Auftrag", maxHours: 6, fullAccess: false });
    expect(parseStartArgs(["--title", "T", "--brief", "b.md", "--topic", "5", "--max-hours", "0.5", "--model", "claude-x", "--effort", "high", "--full-access"])).toEqual({
      title: "T", briefFile: "b.md", topicId: 5, maxHours: 0.5, model: "claude-x", effort: "high", fullAccess: true,
    });
    expect(parseStartArgs(["--text", "x"])).toEqual({ error: "--title fehlt" });
    expect(parseStartArgs(["--title", "T"])).toMatchObject({ error: expect.stringContaining("--brief oder --text") });
    expect(parseStartArgs(["--title", "T", "--text", "a", "--brief", "b"])).toMatchObject({ error: expect.stringContaining("--brief oder --text") });
    expect(parseStartArgs(["--title", "T", "--text", "a", "--max-hours", "0"])).toMatchObject({ error: expect.stringContaining("--max-hours") });
    expect(parseStartArgs(["--title", "T", "--text", "a", "--max-hours", "100"])).toMatchObject({ error: expect.stringContaining("--max-hours") });
    expect(parseStartArgs(["--title", "T", "--text", "a", "--effort", "ultra"])).toMatchObject({ error: expect.stringContaining("--effort") });
    expect(parseStartArgs(["--title", "T", "--text", "a", "--model", "x y"])).toMatchObject({ error: expect.stringContaining("--model") });
    expect(parseStartArgs(["--title", "T", "--text", "a", "--topic", "0"])).toMatchObject({ error: expect.stringContaining("--topic") });
    expect(parseStartArgs(["--title", "T", "--text=--x"])).toMatchObject({ text: "--x" });
  });

  test("Ziel wie notify: --topic vor Umgebung, Umgebung vor Direktchat, ungültige Umgebung ist ein Fehler", () => {
    expect(resolveJobTarget(7, { TYBO_TOPIC_ID: "9", TYBO_CHAT_ID: "-100" })).toEqual({ topicId: 7 });
    expect(resolveJobTarget(undefined, { TYBO_TOPIC_ID: "9", TYBO_CHAT_ID: "-100" })).toEqual({ topicId: 9, chatId: "-100" });
    expect(resolveJobTarget(undefined, { TYBO_CHAT_ID: "123" })).toEqual({ chatId: "123" });
    expect(resolveJobTarget(undefined, {})).toEqual({});
    expect(resolveJobTarget(undefined, { TYBO_TOPIC_ID: "abc" })).toMatchObject({ error: expect.stringContaining("TYBO_TOPIC_ID") });
    expect(resolveJobTarget(undefined, { TYBO_CHAT_ID: "" })).toMatchObject({ error: expect.stringContaining("TYBO_CHAT_ID") });
  });

  function cli(env: Record<string, string>, outbox = { groupId: "-100200", userId: "4242" }) {
    const deps = fakeDeps(root);
    deps.spawnWatcher = runningWatcher(deps);
    const out: string[] = [];
    const err: string[] = [];
    const options: JobCliOptions = {
      cwd: root,
      callerEnv: env,
      out: l => out.push(l),
      err: l => err.push(l),
      deps,
      outbox,
      defaultModel: "claude-default",
      defaultEffort: m => (m === "claude-default" ? "high" : undefined),
    };
    return { options, out, err, deps };
  }

  test("Start aus einem Gespräch: Ziel aus TYBO_*, Standardmodell und -effort, Ausgabe mit ID", async () => {
    const { options, out, err } = cli({ TYBO_CHAT_ID: "-100200", TYBO_TOPIC_ID: "443" });
    const code = await runJobCli(["start", "--title", "Bericht", "--text", "Schreib etwas"], options);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    const id = /Job (\S+) läuft/.exec(out[0])![1];
    expect(await readStatus(root, id)).toMatchObject({ target: { chatId: "-100200", topicId: 443 }, model: "claude-default", effort: "high" });
  });

  test("Auftrag aus Datei, relativ zum Ordner des Aufrufers", async () => {
    const { options, out } = cli({});
    await Bun.write(join(root, "auftrag.md"), "# Auftrag\nLang und ausführlich.");
    expect(await runJobCli(["start", "--title", "Datei", "--brief", "auftrag.md"], options)).toBe(0);
    const id = /Job (\S+) läuft/.exec(out[0])![1];
    expect(readFileSync(join(jobDir(root, id), "brief.md"), "utf8")).toBe("# Auftrag\nLang und ausführlich.");
  });

  test("unzustellbares oder ungültiges Ziel: Exit 2, kein Job angelegt", async () => {
    const before = existsSync(join(root, "data", "jobs")) ? (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: join(root, "data", "jobs"), onlyFiles: false }))).length : 0;
    const count = async () => (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: join(root, "data", "jobs"), onlyFiles: false }))).length;

    const noGroup = cli({}, { groupId: null as any, userId: "4242" });
    expect(await runJobCli(["start", "--title", "T", "--text", "x", "--topic", "5"], noGroup.options)).toBe(2);
    expect(noGroup.err[0]).toContain("Keine Forum-Gruppe");

    const badEnv = cli({ TYBO_TOPIC_ID: "x" });
    expect(await runJobCli(["start", "--title", "T", "--text", "x"], badEnv.options)).toBe(2);
    expect(badEnv.err[0]).toContain("TYBO_TOPIC_ID");

    const foreign = cli({ TYBO_CHAT_ID: "999" });
    expect(await runJobCli(["start", "--title", "T", "--text", "x"], foreign.options)).toBe(2);

    const missing = cli({});
    expect(await runJobCli(["start", "--title", "T", "--brief", "gibt-es-nicht.md"], missing.options)).toBe(2);

    expect(await count()).toBe(before);
  });
});
