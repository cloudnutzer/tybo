/**
 * Issue #103, Checkbox 2: der Wächter meldet jeden Ausgang genau einmal im
 * gespeicherten Gespräch. Claude ist eine Attrappe (Status-Attrappe oder
 * ein echtes `sh`), Versand eine Liste. Nie echtes claude, nie Telegram.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createJobDeps, jobCodexEnv } from "../src/lib/jobs/default-deps";
import { descendantsOf, parseProcessList, realProcessOps, type ProcInfo } from "../src/lib/jobs/process";
import { JOB_RULES, jobPrompt, runWatcher, type ClaudeSpawnSpec, type SpawnedClaude } from "../src/lib/jobs/runner";
import { sendAndRecord, type OutboxDeps, type SendAndRecordInput } from "../src/lib/outbox";
import { jobFile, readStatus, writeStatus, type JobStatus, type JobTarget } from "../src/lib/jobs/store";
import { fakeChild, fakeDeps, tempRoot, type FakeChild, type FakeDeps, type FakeOptions } from "./jobs-fixture";
import { notesFixture } from "./claude-notes-fixture";
import { setSettingsPath } from "../src/lib/settings";

const repo = resolve(import.meta.dir, "..");
const { root, cleanup } = tempRoot();
afterAll(cleanup);

let counter = 0;

/** Job im Zustand „startet“, wie ihn startJob hinterlässt */
async function prepareJob(over: Partial<JobStatus> = {}, target: JobTarget = { chatId: "-100200", topicId: 443 }): Promise<string> {
  const id = `20260925-130000-${(counter++).toString(16).padStart(6, "0")}`;
  const status: JobStatus = {
    version: 1,
    id,
    title: "Anbieter vergleichen",
    createdAt: new Date(Date.now() - 125 * 60_000).toISOString(),
    phase: "starting",
    maxHours: 6,
    model: "claude-test",
    fullAccess: false,
    target,
    ...over,
  };
  await Bun.write(jobFile(root, id, "brief"), "Vergleiche drei Anbieter.");
  await Bun.write(jobFile(root, id, "log"), "");
  await writeStatus(root, status);
  return id;
}

interface ClaudeBehavior {
  code: number | null;
  signal?: string;
  report?: string;
  logLines?: string[];
}

/** Claude-Attrappe: schreibt Log und ggf. Bericht und endet sofort */
function fakeClaude(behavior: ClaudeBehavior): NonNullable<FakeOptions["spawnClaude"]> {
  return spec => {
    if (behavior.logLines) appendFileSync(spec.logPath, behavior.logLines.join("\n") + "\n");
    if (behavior.report !== undefined) writeFileSync(jobFile(root, spec.id, "report"), behavior.report);
    return fakeChild(55_555, Promise.resolve({ code: behavior.code, signal: behavior.signal ?? null }));
  };
}

async function watch(id: string, o: FakeOptions = {}): Promise<{ deps: FakeDeps; status: JobStatus }> {
  const deps = fakeDeps(root, o);
  expect(await runWatcher(id, deps)).toBe(0);
  return { deps, status: (await readStatus(root, id))! };
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `Zeile ${i + 1}`);

describe("Claude-Notizen für Codex-Jobs (Issue #664)", () => {
  const home = join(root, "notizen-home");
  const settings = join(root, "notizen-settings.json");
  beforeEach(() => { writeFileSync(settings, "{}"); setSettingsPath(settings); });
  afterEach(() => setSettingsPath());
  function withNotes() {
    const notes = notesFixture(home, root);
    const real = createJobDeps({ root, env: { HOME: home, PATH: "/bin" } });
    const deps = fakeDeps(root, { spawnClaude: fakeClaude({ code: 0, report: "fertig" }) });
    deps.codexEnv = real.codexEnv;
    deps.claudeNotes = real.claudeNotes;
    return { notes, deps };
  }
  const oldPrompt = (id: string) => `Vergleiche drei Anbieter.\n\n---\nSchreibe am Ende einen kurzen Bericht nach data/jobs/${id}/report.md (voller Pfad: ${jobFile(root, id, "report")}).\n\n${JOB_RULES}\n`;

  test("voller Codex-Job: Projekt und HOME des Jobs, gleicher Abschnitt zwischen Auftrag und Bericht, nur stdin", async () => {
    const id = await prepareJob({ engine: "codex", fullAccess: true });
    const { notes, deps } = withNotes();
    await runWatcher(id, deps);
    const spec = deps.spawned[0];
    expect(spec.env.HOME).toBe(home);
    expect(spec.prompt).toBe(oldPrompt(id).replace("\n\n---\n", `\n\n${notes.section}\n\n---\n`));
    expect(spec.prompt).toContain(`Notes folder: ${notes.dir}`);
    for (const arg of spec.cmd) {
      expect(arg).not.toContain(notes.index);
      expect(arg).not.toContain("CLAUDE CODE NOTES");
    }
    expect(readFileSync(jobFile(root, id, "brief"), "utf8")).toBe("Vergleiche drei Anbieter.");
    expect(await readStatus(root, id)).toMatchObject({ outcome: "success" });
  });
  test.each([{ engine: "codex", fullAccess: false }, { engine: "claude", fullAccess: false }, { engine: "claude", fullAccess: true }] as const)(
    "$engine, fullAccess=$fullAccess: Quelle nie gelesen und Auftrag bytegleich zu #618", async options => {
      const id = await prepareJob(options);
      const { deps } = withNotes();
      let reads = 0;
      deps.claudeNotes = () => { reads++; throw new Error("Nicht lesen"); };
      await runWatcher(id, deps);
      expect(reads).toBe(0);
      expect(deps.spawned[0].prompt).toBe(oldPrompt(id));
      expect(jobPrompt(root, id, "Vergleiche drei Anbieter.\n", undefined, "")).toBe(oldPrompt(id));
    });
  test("Quelle wirft: Job gelingt ohne Abschnitt, feste Log-Zeile ohne Fehlerinhalt", async () => {
    const id = await prepareJob({ engine: "codex", fullAccess: true });
    const { deps } = withNotes();
    deps.claudeNotes = () => { throw new Error("privater-notizinhalt"); };
    await runWatcher(id, deps);
    expect(deps.spawned[0].prompt).toBe(oldPrompt(id));
    expect(deps.logs).toContain("[job] Claude-Notizen nicht lesbar; Lauf ohne Notizen.");
    expect(deps.logs.join()).not.toContain("privater-notizinhalt");
    expect(await readStatus(root, id)).toMatchObject({ outcome: "success" });
  });
  test("Notizen maskieren die zusammengeführten Werte erst nach dem MCP-Plan, true bleibt", async () => {
    const id = await prepareJob({ engine: "codex", fullAccess: true });
    const { notes, deps } = withNotes();
    const order: string[] = [];
    deps.secrets = () => ["basis-geheimnis-664", "true"];
    deps.codexMcpPlan = () => {
      order.push("mcp");
      return { passed: [], own: [], skipped: [], args: [], env: {}, secretValues: ["mcp-geheimnis-664"] };
    };
    const read = deps.claudeNotes;
    deps.claudeNotes = opts => { order.push("notes"); return read(opts); };
    writeFileSync(join(notes.dir, "MEMORY.md"), "basis-geheimnis-664 mcp-geheimnis-664 true");
    await runWatcher(id, deps);
    expect(order).toEqual(["mcp", "notes"]);
    expect(deps.spawned[0].prompt).toContain("Index (MEMORY.md):\n[verborgen] [verborgen] true");
    expect(deps.spawned[0].prompt).not.toContain("geheimnis-664");
  });
  test("MCP-Plan scheitert: Notizen gehen trotzdem mit", async () => {
    const id = await prepareJob({ engine: "codex", fullAccess: true });
    const { notes, deps } = withNotes();
    deps.codexMcpPlan = () => { throw new Error("MCP nicht lesbar"); };
    await runWatcher(id, deps);
    expect(deps.spawned[0].prompt).toContain(notes.section);
    expect(await readStatus(root, id)).toMatchObject({ outcome: "success" });
  });
  test("Einstellung aus und wieder an wirkt auf dieselbe Abhängigkeit ohne Neustart", async () => {
    const { notes, deps } = withNotes();
    let tick = 2000;
    for (const claudeNotes of [false, true]) {
      writeFileSync(settings, JSON.stringify({ engine: { codex: { claudeNotes } } }));
      utimesSync(settings, ++tick, tick);
      const id = await prepareJob({ engine: "codex", fullAccess: true });
      await runWatcher(id, deps);
      expect(deps.spawned.at(-1)!.prompt.includes(notes.section)).toBe(claudeNotes);
    }
  });
  test("eine Wiedergabe des Auftrags landet nur maskiert im Job-Log mit Rechten 0600", async () => {
    const id = await prepareJob({ engine: "codex", fullAccess: true });
    // Hier legt die echte spawn-Abhängigkeit das Log an; der normale Starter nutzt ebenfalls 0600.
    unlinkSync(jobFile(root, id, "log"));
    const { notes, deps } = withNotes();
    writeFileSync(join(notes.dir, "MEMORY.md"), notes.index + " true");
    const real = createJobDeps({ root, env: { HOME: home, BEISPIEL_SECRET: "true" } });
    let child: SpawnedClaude | undefined;
    deps.secrets = real.secrets;
    deps.proc = { ...realProcessOps, listProcesses: () => [] };
    deps.spawnClaude = spec => (child = real.spawnClaude({ ...spec,
      cmd: [process.execPath, "--no-env-file", "-e", "process.stdout.write(await Bun.stdin.text())"],
    }));
    deps.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    await runWatcher(id, deps);
    await child!.drained;
    const log = readFileSync(jobFile(root, id, "log"), "utf8");
    expect(log).toContain(notes.index + " [verborgen]");
    expect(log).not.toContain(" true");
    expect(statSync(jobFile(root, id, "log")).mode & 0o777).toBe(0o600);
  });
});

describe("Wächter: Ausgänge", () => {
  test("Erfolg: Exit 0 und Bericht, eine Meldung mit Titel und Bericht im gespeicherten Gespräch", async () => {
    const id = await prepareJob();
    const { deps, status } = await watch(id, { spawnClaude: fakeClaude({ code: 0, report: "## Ergebnis\nAnbieter A ist am günstigsten." }) });
    expect(status).toMatchObject({ phase: "ended", outcome: "success", exitCode: 0, notice: { state: "sent", attempts: 1, recorded: true } });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]).toMatchObject({ source: "job", chatId: "-100200", topicId: 443 });
    expect(deps.sent[0].text).toContain("Job fertig: Anbieter vergleichen");
    expect(deps.sent[0].text).toContain("Anbieter A ist am günstigsten.");
    // Claude bekam den Auftrag samt Berichtsanweisung über stdin, im Projektordner
    expect(deps.spawned[0].prompt).toContain("Vergleiche drei Anbieter.");
    expect(deps.spawned[0].prompt).toContain(`data/jobs/${id}/report.md`);
    expect(deps.spawned[0].cwd).toBe(root);
    expect(deps.spawned[0].cmd).toContain("acceptEdits");
    expect(status.engine).toBeUndefined();
    expect(deps.sent[0].text).toContain("(claude,");
    expect(deps.logs).toContain(`[job] ${id}: läuft (claude, claude-test)`);
  });

  test.each([
    { code: 0, report: "Codex-Bericht", outcome: "success", label: "Job fertig" },
    { code: 0, report: undefined, outcome: "no_report", label: "Job ohne Bericht" },
    { code: 7, report: undefined, outcome: "failed", label: "Job fehlgeschlagen" },
  ])("Codex: $outcome meldet genau einmal im gespeicherten Gespräch", async ({ code, report, outcome, label }) => {
    const id = await prepareJob({ engine: "codex", model: "gpt-6-astra", effort: "high" });
    const deps = fakeDeps(root, { spawnClaude: fakeClaude({ code, report, logLines: ["Codex-Ausgabe"] }) });
    let checked = false;
    deps.checkCodex = async () => { checked = true; };
    deps.claudeEnv = () => { throw new Error("Claude-Umgebung darf hier nicht aufgerufen werden"); };
    deps.codexEnv = status => ({ TYBO_SUBPROCESS: "1", TYBO_JOB_ID: status.id });
    let mcpChecked = false;
    deps.codexMcpServers = async env => {
      expect(env).toEqual({ TYBO_SUBPROCESS: "1", TYBO_JOB_ID: id });
      mcpChecked = true;
      return ["konto.mail", "lokal"];
    };
    expect(await runWatcher(id, deps)).toBe(0);
    expect(checked).toBe(true);
    expect(mcpChecked).toBe(true);
    expect(await readStatus(root, id)).toMatchObject({ engine: "codex", phase: "ended", outcome, exitCode: code, notice: { state: "sent", attempts: 1 } });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]).toMatchObject({ source: "job", chatId: "-100200", topicId: 443 });
    expect(deps.sent[0].text).toContain(label);
    expect(deps.sent[0].text).toContain("(codex,");
    if (report) expect(deps.sent[0].text).toContain(report);
    else expect(deps.sent[0].text).toContain("Codex-Ausgabe");
    if (code !== 0) expect(deps.sent[0].text).toContain(`Exit-Code ${code}`);
    if (outcome === "no_report") expect(deps.sent[0].text).toContain("Codex hat aufgehört");
    const spec = deps.spawned[0];
    expect(spec.cmd.slice(0, 4)).toEqual(["codex", "exec", "-C", root]);
    expect(spec.cmd).toContain("shell_tool");
    expect(spec.cmd).toContain('mcp_servers={"konto.mail"={enabled=false},"lokal"={enabled=false}}');
    expect(spec.cwd).toBe(root);
    expect(spec.prompt).toContain(`data/jobs/${id}/report.md`);
    expect(spec.env).toEqual({ TYBO_SUBPROCESS: "1", TYBO_JOB_ID: id });
    expect(deps.logs).toContain(`[job] ${id}: läuft (codex, gpt-6-astra, high)`);
  });

  test.each(["Codex ist nicht installiert", "Codex ist nicht angemeldet"])("Codex-Bereitschaft: %s, kein Prozess und eine Meldung", async reason => {
    const id = await prepareJob({ engine: "codex", model: undefined });
    const deps = fakeDeps(root);
    deps.checkCodex = async () => { throw new Error(reason); };
    expect(await runWatcher(id, deps)).toBe(0);
    expect(deps.spawned).toEqual([]);
    expect(await readStatus(root, id)).toMatchObject({ outcome: "start_failed", detail: `Codex ließ sich nicht starten (${reason}).` });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0].text).toContain(reason);
  });

  test("unprüfbare MCP-Konfiguration verhindert den eingeschränkten Codex-Start", async () => {
    const id = await prepareJob({ engine: "codex" });
    const deps = fakeDeps(root);
    deps.codexMcpServers = async () => { throw new Error("MCP-Konfiguration ist nicht prüfbar"); };
    expect(await runWatcher(id, deps)).toBe(0);
    expect(deps.spawned).toEqual([]);
    expect(await readStatus(root, id)).toMatchObject({ outcome: "start_failed" });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0].text).toContain("MCP-Konfiguration ist nicht prüfbar");
  });

  test.each(["claude", "codex"] as const)("%s mit voller Stufe braucht keine MCP-Prüfung", async engine => {
    const id = await prepareJob({ engine, fullAccess: true });
    const deps = fakeDeps(root, { spawnClaude: fakeClaude({ code: 0, report: "fertig" }) });
    deps.codexMcpServers = async () => { throw new Error("Darf nicht aufgerufen werden"); };
    expect(await runWatcher(id, deps)).toBe(0);
    expect(await readStatus(root, id)).toMatchObject({ outcome: "success" });
    expect(deps.spawned[0].cmd).not.toContain("--disable");
  });

  test("Codex-Umgebung: keine Claude-Anmeldung, Geheimnisse gefiltert, nur das gespeicherte Ziel", async () => {
    const id = await prepareJob({ engine: "codex" });
    const status = (await readStatus(root, id))!;
    const env = {
      HOME: root, CODEX_HOME: join(root, "codex-konfiguration"), PATH: "/bin",
      CLAUDE_AUTH: "apiKey", OPENAI_API_KEY: "nicht-vererben", TELEGRAM_BOT_TOKEN: "auch-nicht", SUPABASE_SERVICE_ROLE_KEY: "geheim",
      TYBO_CHAT_ID: "alt", TYBO_TOPIC_ID: "999", TYBO_CONVERSATION_ID: "web:alt", TYBO_JOB_ID: "alter-job",
    };
    expect(jobCodexEnv(root, env, status)).toMatchObject({ HOME: root, CODEX_HOME: env.CODEX_HOME, PATH: "/bin", TYBO_SUBPROCESS: "1", TYBO_CHAT_ID: "-100200", TYBO_TOPIC_ID: "443", TYBO_JOB_ID: id });
    const sub = jobCodexEnv(root, { ...env, ANTHROPIC_API_KEY: "claude-schluessel" }, status);
    for (const key of ["OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "TYBO_CONVERSATION_ID", "BASH_MAX_TIMEOUT_MS", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"]) expect(sub[key]).toBeUndefined();
    const conversation = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const web = jobCodexEnv(root, env, { ...status, target: { chatId: `web:${conversation}` } });
    expect(web.TYBO_CONVERSATION_ID).toBe(conversation);
    expect(web.TYBO_CHAT_ID).toBeUndefined();
    expect(web.TYBO_TOPIC_ID).toBeUndefined();
  });

  test("Werkzeugregeln aus dem Status (Issue #493): erlaubte und gesperrte Werkzeuge gehen an Claude, acceptEdits bleibt", async () => {
    const id = await prepareJob({ allowedTools: ["WebSearch", "WebFetch"], deniedTools: ["Edit(./config/**)"] });
    const { deps } = await watch(id, { spawnClaude: fakeClaude({ code: 0, report: "ok" }) });
    const cmd = deps.spawned[0].cmd;
    expect(cmd).toContain("acceptEdits");
    expect(cmd[cmd.indexOf("--allowedTools") + 1]).toBe("WebSearch,WebFetch");
    expect(cmd[cmd.indexOf("--disallowedTools") + 1]).toBe("Monitor,ScheduleWakeup,CronCreate,Edit(./config/**)");
  });

  test("eigener Arbeitsordner (Issue #493): Claude startet dort eingeschränkt, ohne MCP und Befehle; der Bericht kommt aus dem Arbeitsordner", async () => {
    const work = join(root, "arbeit-1");
    mkdirSync(work);
    const id = await prepareJob({ allowedTools: ["WebSearch", "WebFetch"], deniedTools: ["Bash"], workDir: work });
    const spawnClaude: NonNullable<FakeOptions["spawnClaude"]> = spec => {
      // Claude schreibt den Bericht in seinen Arbeitsordner, nicht in data/jobs
      writeFileSync(join(spec.cwd, "bericht.md"), "Entwurf geschrieben.");
      return fakeChild(55_556, Promise.resolve({ code: 0, signal: null }));
    };
    const { deps, status } = await watch(id, { spawnClaude });
    const spec = deps.spawned[0];
    expect(spec.cwd).toBe(work);
    expect(spec.cmd).toContain("--restricted");
    expect(spec.cmd).toContain("--strict-mcp-config");
    expect(spec.cmd[spec.cmd.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(spec.cmd[spec.cmd.indexOf("--tools") + 1]).toBe("Read,Write,Edit,Glob,Grep,WebSearch,WebFetch");
    expect(spec.cmd).not.toContain("bypassPermissions");
    expect(spec.prompt).toContain(join(work, "bericht.md"));
    expect(spec.prompt).not.toContain(`data/jobs/${id}/report.md`);
    expect(status.outcome).toBe("success");
    expect(readFileSync(jobFile(root, id, "report"), "utf8")).toBe("Entwurf geschrieben.");
  });

  test("eigener Arbeitsordner: ein Link statt Bericht wird nicht übernommen", async () => {
    const work = join(root, "arbeit-2");
    mkdirSync(work);
    writeFileSync(join(root, "fremd.txt"), "fremder Inhalt");
    const id = await prepareJob({ workDir: work });
    const spawnClaude: NonNullable<FakeOptions["spawnClaude"]> = spec => {
      symlinkSync(join(root, "fremd.txt"), join(spec.cwd, "bericht.md"));
      return fakeChild(55_557, Promise.resolve({ code: 0, signal: null }));
    };
    const { status } = await watch(id, { spawnClaude });
    expect(status.outcome).toBe("no_report");
    expect(existsSync(jobFile(root, id, "report"))).toBe(false);
  });

  test("Absturz ohne Bericht: Exit-Code und genau die letzten 20 Log-Zeilen", async () => {
    const id = await prepareJob({}, { topicId: 7 });
    const { deps, status } = await watch(id, { spawnClaude: fakeClaude({ code: 3, logLines: lines(30) }) });
    expect(status).toMatchObject({ outcome: "failed", exitCode: 3 });
    expect(deps.sent).toHaveLength(1);
    const text = deps.sent[0].text!;
    expect(deps.sent[0].topicId).toBe(7);
    expect(deps.sent[0].chatId).toBeUndefined();
    expect(text).toContain("Job fehlgeschlagen");
    expect(text).toContain("Exit-Code 3");
    for (let i = 11; i <= 30; i++) expect(text).toContain(`Zeile ${i}\n`);
    expect(text).not.toContain("Zeile 10\n");
  });

  test("Absturz trotz Bericht (Exit ungleich 0) gilt als Fehlschlag", async () => {
    const id = await prepareJob();
    const { status, deps } = await watch(id, { spawnClaude: fakeClaude({ code: 1, report: "halb fertig", logLines: ["Fehler"] }) });
    expect(status.outcome).toBe("failed");
    expect(deps.sent).toHaveLength(1);
  });

  test("durch Signal beendet: Signal statt Exit-Code", async () => {
    const id = await prepareJob();
    const { status, deps } = await watch(id, { spawnClaude: fakeClaude({ code: null, signal: "SIGKILL", logLines: ["weg"] }) });
    expect(status).toMatchObject({ outcome: "failed", exitCode: null, signal: "SIGKILL" });
    expect(deps.sent[0].text).toContain("beendet durch Signal SIGKILL");
  });

  test("fehlender Bericht: Exit 0, aber kein (oder leerer) report.md", async () => {
    for (const report of [undefined, "  \n"]) {
      const id = await prepareJob();
      const { status, deps } = await watch(id, { spawnClaude: fakeClaude({ code: 0, report, logLines: ["fertig ohne Bericht"] }) });
      expect(status.outcome).toBe("no_report");
      expect(deps.sent).toHaveLength(1);
      expect(deps.sent[0].text).toContain("Job ohne Bericht");
      expect(deps.sent[0].text).toContain("fertig ohne Bericht");
    }
  });

  test("Direktchat, wenn kein Ziel gespeichert ist", async () => {
    const id = await prepareJob({}, {});
    const { deps } = await watch(id, { spawnClaude: fakeClaude({ code: 0, report: "ok" }) });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0].chatId).toBeUndefined();
    expect(deps.sent[0].topicId).toBeUndefined();
  });

  test("langer Bericht wird gekürzt, damit die Meldung eine Nachricht bleibt", async () => {
    const id = await prepareJob();
    const { deps } = await watch(id, { spawnClaude: fakeClaude({ code: 0, report: "x".repeat(10_000) }) });
    expect(deps.sent[0].text!.length).toBeLessThan(3_200);
    expect(deps.sent[0].text).toContain(`data/jobs/${id}/report.md`);
  });

  test("Claude lässt sich nicht starten: Meldung „nicht gestartet“", async () => {
    const id = await prepareJob();
    const { status, deps } = await watch(id, {
      spawnClaude: () => {
        throw new Error("spawn claude ENOENT");
      },
    });
    expect(status).toMatchObject({ outcome: "start_failed" });
    expect(status.detail).toContain("Claude ließ sich nicht starten");
    expect(deps.sent).toHaveLength(1);
  });

  test("schon beendet (vor dem Start gestoppt): Wächter startet nichts und meldet nichts", async () => {
    const id = await prepareJob({ phase: "ended", outcome: "stopped", notice: { state: "sent", attempts: 1 } });
    const { deps } = await watch(id);
    expect(deps.spawned).toEqual([]);
    expect(deps.sent).toEqual([]);
  });

  test.each(["claude", "codex"] as const)("%s: Stopp zwischen Prozessstart und Eintrag, keine Freigabe und keine zweite Meldung", async engine => {
    const id = await prepareJob({ engine });
    let killed: number[] = [];
    let child!: FakeChild;
    const deps = fakeDeps(root, {
      spawnClaude: spec => {
        // stop gewinnt, während Claude gerade startet
        const current = JSON.parse(require("node:fs").readFileSync(jobFile(root, spec.id, "status"), "utf8"));
        writeFileSync(jobFile(root, spec.id, "status"), JSON.stringify({ ...current, phase: "ended", outcome: "stopped", notice: { state: "sent", attempts: 1 } }));
        const pid = deps.procs.spawn(56_000);
        child = fakeChild(pid, new Promise(r => setTimeout(() => r({ code: null, signal: "SIGTERM" }), 5)));
        return child;
      },
    });
    expect(await runWatcher(id, deps)).toBe(0);
    killed = deps.procs.signals.map(s => s.pgid);
    expect(killed).toContain(56_000);
    // Startsperre bleibt zu: Claude selbst startet gar nicht erst
    expect(child.cancelled).toBe(true);
    expect(child.released).toBe(false);
    expect(deps.sent).toEqual([]);
    expect((await readStatus(root, id))!.outcome).toBe("stopped");
  });
});

describe("Wächter: Startsperre und Prozessidentität", () => {
  test.each(["claude", "codex"] as const)("%s startet erst, wenn PID und Startzeit im Status stehen", async engine => {
    const id = await prepareJob({ engine });
    let seen: JobStatus | null = null;
    let child!: FakeChild;
    const { status } = await watch(id, {
      spawnClaude: () => {
        child = fakeChild(57_000, Promise.resolve({ code: 0, signal: null }), () => {
          seen = JSON.parse(readFileSync(jobFile(root, id, "status"), "utf8"));
        });
        return child;
      },
    });
    expect(child.released).toBe(true);
    expect(seen).toMatchObject({ phase: "running", claude: { pid: 57_000, identity: "start-57000" } });
    expect(status.outcome).toBe("no_report");
  });

  test("Startzeit von Claude nicht ermittelbar: Claude startet nicht, Meldung „nicht gestartet“, kein Signal", async () => {
    const id = await prepareJob();
    let child!: FakeChild;
    const deps = fakeDeps(root, {
      spawnClaude: () => (child = fakeChild(57_100, Promise.resolve({ code: 0, signal: null }))),
    });
    const identity = deps.procs.identity.bind(deps.procs);
    deps.procs.identity = pid => (pid === 57_100 ? null : identity(pid));
    expect(await runWatcher(id, deps)).toBe(0);
    const status = (await readStatus(root, id))!;
    expect(status).toMatchObject({ outcome: "start_failed", detail: expect.stringContaining("Prozessidentität") });
    expect(status.claude).toBeUndefined();
    expect(child.cancelled).toBe(true);
    expect(child.released).toBe(false);
    expect(deps.procs.signals).toEqual([]);
    expect(deps.sent).toHaveLength(1);
  });

  test("Wächter stirbt nach dem Start des Startprozesses, vor dem Eintrag: Claude startet nie (echter sh-Prozess)", async () => {
    const marker = join(root, "gestartet.txt");
    const id = await prepareJob();
    const script = join(root, "absturz-waechter.ts");
    writeFileSync(
      script,
      [
        `import { createJobDeps } from ${JSON.stringify(join(repo, "src/lib/jobs/default-deps.ts"))};`,
        `const deps = createJobDeps({ root: ${JSON.stringify(root)}, env: { PATH: process.env.PATH }, log: () => {} });`,
        `const child = deps.spawnClaude({ id: ${JSON.stringify(id)}, cmd: ["sh", "-c", "echo ja > ${marker}; sleep 30"], cwd: ${JSON.stringify(root)}, env: { PATH: process.env.PATH ?? "" }, prompt: "Auftrag", logPath: ${JSON.stringify(jobFile(root, id, "log"))} });`,
        // Absturz genau hier: weder Status-Eintrag noch release
        `console.log(child.pid);`,
        `process.exit(0);`,
      ].join("\n"),
    );
    const p = Bun.spawn({ cmd: [process.execPath, "--no-env-file", script], cwd: root, stdout: "pipe", stderr: "inherit" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(1);
    for (let i = 0; i < 100 && realProcessOps.groupAlive(pid); i++) await Bun.sleep(50);
    expect(realProcessOps.groupAlive(pid)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    // Der Status kennt keinen Claude, es gibt auch keinen
    expect((await readStatus(root, id))!.claude).toBeUndefined();
  }, 20_000);
});

describe("Wächter: Zeitüberschreitung mit echtem Prozessbaum (sh als Attrappe)", () => {
  test.each(["claude", "codex"] as const)("%s: beendet die ganze Prozessgruppe und meldet genau einmal", async engine => {
    const id = await prepareJob({ engine, maxHours: 0.001 });
    const real = createJobDeps({ root, env: { PATH: process.env.PATH } });
    const pids: number[] = [];
    const deps = fakeDeps(root);
    deps.proc = realProcessOps;
    deps.timeoutMsFor = () => 300;
    deps.spawnClaude = (spec: ClaudeSpawnSpec): SpawnedClaude => {
      // Kind im Hintergrund plus Vordergrund, beide müssen sterben
      const child = real.spawnClaude({ ...spec, cmd: ["sh", "-c", "echo gestartet; sleep 30 & echo $! > kind.pid; sleep 30; wait"], cwd: root, env: { PATH: process.env.PATH ?? "" } });
      pids.push(child.pid);
      return child;
    };
    const started = Date.now();
    expect(await runWatcher(id, deps)).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    const status = (await readStatus(root, id))!;
    expect(status).toMatchObject({ outcome: "timeout", notice: { state: "sent" } });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0].text).toContain("Zeit überschritten");
    expect(deps.sent[0].text).toContain(`(${engine},`);
    expect(deps.sent[0].text).toContain("gestartet");
    const childPid = Number(await Bun.file(`${root}/kind.pid`).text());
    for (const pid of [pids[0], childPid]) expect(realProcessOps.alive(pid)).toBe(false);
    expect(realProcessOps.groupAlive(pids[0])).toBe(false);
  }, 20_000);
});

describe("Zustellung", () => {
  /** Echtes sendAndRecord, HTTP abgefangen: jede sendMessage mit Text und Antwortstatus */
  function realOutbox(statuses: number[]) {
    const calls: { method: string; text: string; status: number }[] = [];
    const deps: OutboxDeps = {
      botToken: "synth-bot-token",
      userId: "4242",
      groupId: "-100200",
      outboxDir: join(root, "outbox"),
      fetch: async (url, init) => {
        const method = url.split("/").pop()!;
        const status = statuses[calls.length] ?? 200;
        calls.push({ method, text: JSON.parse(String(init.body)).text, status });
        return new Response(JSON.stringify({ ok: status === 200 }), { status });
      },
      record: async () => true,
      log: () => {},
      newId: () => crypto.randomUUID(),
    };
    return { calls, notify: (input: SendAndRecordInput) => sendAndRecord(input, deps) };
  }

  const heavy = "&<>".repeat(1_000);

  for (const [name, behavior] of [
    ["Bericht", { code: 0, report: `Ergebnis\n${heavy}` }],
    ["Log-Auszug", { code: 1, logLines: Array.from({ length: 20 }, () => "&".repeat(299)) }],
  ] as const) {
    test(`stark maskierender ${name} (&, <, >): genau ein erfolgreicher sendMessage-Aufruf, innerhalb des Limits`, async () => {
      const id = await prepareJob();
      const outbox = realOutbox([]);
      const { status } = await watch(id, { spawnClaude: fakeClaude(behavior), notify: outbox.notify });
      expect(status.notice).toMatchObject({ state: "sent", attempts: 1 });
      expect(outbox.calls).toHaveLength(1);
      expect(outbox.calls[0]).toMatchObject({ method: "sendMessage", status: 200 });
      expect(outbox.calls[0].text.length).toBeLessThanOrEqual(4_096);
      expect(outbox.calls[0].text).toContain("&amp;");
    });
  }

  test("Versandfehler und Wiederholung: jeder Versuch ist die ganze Meldung in einem Stück, am Ende genau eine erfolgreiche", async () => {
    const id = await prepareJob();
    const outbox = realOutbox([500, 502, 200]);
    const { status } = await watch(id, { spawnClaude: fakeClaude({ code: 0, report: heavy }), notify: outbox.notify });
    expect(status.notice).toMatchObject({ state: "sent", attempts: 3 });
    expect(outbox.calls.map(c => c.status)).toEqual([500, 502, 200]);
    expect(outbox.calls.every(c => c.method === "sendMessage" && c.text.length <= 4_096)).toBe(true);
    // Kein Teilversand: alle Versuche schicken denselben vollständigen Text
    expect(new Set(outbox.calls.map(c => c.text)).size).toBe(1);
    expect(outbox.calls.filter(c => c.status === 200)).toHaveLength(1);
  });

  test("Versandfehler: Wiederholung, am Ende genau eine Meldung", async () => {
    const id = await prepareJob();
    const { deps, status } = await watch(id, {
      spawnClaude: fakeClaude({ code: 0, report: "ok" }),
      notify: async (_input, attempt) => (attempt < 3 ? { sent: false, recorded: false, error: { kind: "send", message: "Telegram hat den Text nicht angenommen" } } : { sent: true, recorded: true }),
    });
    expect(deps.sent).toHaveLength(1);
    expect(status.notice).toMatchObject({ state: "sent", attempts: 3 });
  });

  test("Versand scheitert dreimal: Zustand „Meldung nicht zugestellt“, keine weitere", async () => {
    const id = await prepareJob();
    let calls = 0;
    const { deps, status } = await watch(id, {
      spawnClaude: fakeClaude({ code: 0, report: "ok" }),
      notify: async () => {
        calls++;
        return { sent: false, recorded: false, error: { kind: "send", message: "Netz weg" } };
      },
    });
    expect(calls).toBe(3);
    expect(deps.sent).toEqual([]);
    expect(status.notice).toMatchObject({ state: "failed", attempts: 3, error: "Netz weg" });
  });

  test("abgelehnt (invalid): keine Wiederholung", async () => {
    const id = await prepareJob();
    let calls = 0;
    const { status } = await watch(id, {
      spawnClaude: fakeClaude({ code: 0, report: "ok" }),
      notify: async () => {
        calls++;
        return { sent: false, recorded: false, error: { kind: "invalid", message: "Keine Forum-Gruppe eingerichtet" } };
      },
    });
    expect(calls).toBe(1);
    expect(status.notice?.state).toBe("failed");
  });

  test("gesendet, aber nicht festgehalten: nicht wiederholen (sonst doppelt in Telegram), Hinweis im Log", async () => {
    const id = await prepareJob();
    let calls = 0;
    const { deps, status } = await watch(id, {
      spawnClaude: fakeClaude({ code: 0, report: "ok" }),
      notify: async () => {
        calls++;
        return { sent: true, recorded: false };
      },
    });
    expect(calls).toBe(1);
    expect(status.notice).toMatchObject({ state: "sent", recorded: false });
    expect(deps.logs.join("\n")).toContain("nicht für die WebUI festgehalten");
  });

  test("Versand wirft: zählt wie ein Versandfehler", async () => {
    const id = await prepareJob();
    const { deps, status } = await watch(id, {
      spawnClaude: fakeClaude({ code: 0, report: "ok" }),
      notify: async (_i, attempt) => {
        if (attempt === 1) throw new TypeError("fetch failed");
        return { sent: true, recorded: true };
      },
    });
    expect(deps.sent).toHaveLength(1);
    expect(status.notice?.attempts).toBe(2);
  });
});

describe("Wächter: Prozesse, die Claude überleben (1.10.2026)", () => {
  /**
   * Claude endet, nachdem der Wächter die Prozessliste einmal gelesen hat. Nach
   * fester Wanduhr konnte Claude schon fertig sein, bevor der Wächter nach seinen
   * Statusschreibvorgängen je nachsah; er kannte die Kinder dann nicht.
   */
  function claudeEndsAfterFirstLook() {
    let done = false;
    let looked = false;
    let end: (exit: { code: number | null; signal: string | null }) => void = () => {};
    const exited = new Promise<{ code: number | null; signal: string | null }>(r => (end = r));
    return {
      exited,
      done: () => done,
      look() {
        if (looked) return;
        looked = true;
        setTimeout(() => {
          done = true;
          end({ code: 0, signal: null });
        }, 0);
      },
    };
  }

  /** Claude (55_555) startet einen Testlauf (60_001) und eine Shell (60_002), die vor Claude endet */
  function scenario(survives: boolean) {
    const claude = claudeEndsAfterFirstLook();
    const table = (): ProcInfo[] => {
      const claudeDone = claude.done();
      const list: ProcInfo[] = [{ pid: 55_555, ppid: 40_000, identity: "start-55555", command: "claude -p" }];
      if (!claudeDone) list.push({ pid: 60_002, ppid: 55_555, identity: "s2", command: "/bin/zsh -c sleep 1" });
      // Verwaist: nach Claudes Ende hängt der Testlauf an launchd (PID 1)
      if (survives || !claudeDone) list.push({ pid: 60_001, ppid: claudeDone ? 1 : 55_555, identity: "s1", command: "bun run test   --timeout 9" });
      claude.look();
      return claudeDone ? list.slice(1) : list;
    };
    const spawnClaude: NonNullable<FakeOptions["spawnClaude"]> = spec => {
      appendFileSync(spec.logPath, "Der Testlauf läuft im Hintergrund, ich melde mich.\n");
      return fakeChild(55_555, claude.exited);
    };
    return { table, spawnClaude };
  }

  test("ein mit & gestarteter Testlauf steht mit PID und Befehl in Status und Meldung", async () => {
    const id = await prepareJob();
    const { table, spawnClaude } = scenario(true);
    const deps = fakeDeps(root, { spawnClaude });
    deps.procs.listProcesses = table;
    deps.trackIntervalMs = 5;
    expect(await runWatcher(id, deps)).toBe(0);
    const status = (await readStatus(root, id))!;
    expect(status.outcome).toBe("no_report");
    // Die Shell lebt nicht mehr und fehlt; Claude selbst zählt nie
    expect(status.leftovers).toEqual([{ pid: 60_001, command: "bun run test --timeout 9" }]);
    const text = deps.sent[0].text!;
    expect(text).toContain("Job ohne Bericht");
    expect(text).toContain("kommt nichts mehr nach");
    expect(text).toContain("PID 60001: `bun run test --timeout 9`");
    expect(text.indexOf("PID 60001")).toBeLessThan(text.indexOf("Letzte Log-Zeilen"));
  });

  test("nichts überlebt: keine Liste, Meldung wie bisher", async () => {
    const id = await prepareJob();
    const { table, spawnClaude } = scenario(false);
    const deps = fakeDeps(root, { spawnClaude });
    deps.procs.listProcesses = table;
    deps.trackIntervalMs = 5;
    await runWatcher(id, deps);
    const status = (await readStatus(root, id))!;
    expect(status.leftovers).toBeUndefined();
    expect(deps.sent[0].text).not.toContain("Nach dem Job-Ende liefen noch");
  });

  test("Befehle mit Werten aus .env erscheinen maskiert", async () => {
    const id = await prepareJob();
    const claude = claudeEndsAfterFirstLook();
    const spawnClaude: NonNullable<FakeOptions["spawnClaude"]> = spec => {
      appendFileSync(spec.logPath, "Der Testlauf läuft im Hintergrund, ich melde mich.\n");
      return fakeChild(55_555, claude.exited);
    };
    const deps = fakeDeps(root, { spawnClaude, secrets: ["geheim-123"] });
    deps.procs.listProcesses = () => {
      const done = claude.done();
      claude.look();
      return [
        ...(done ? [] : [{ pid: 55_555, ppid: 1, identity: "start-55555", command: "claude" }]),
        { pid: 61_000, ppid: done ? 1 : 55_555, identity: "x", command: "curl -H token=geheim-123 https://example.org" },
      ];
    };
    deps.trackIntervalMs = 5;
    await runWatcher(id, deps);
    const status = (await readStatus(root, id))!;
    expect(status.leftovers?.[0].command).toBe("curl -H token=[verborgen] https://example.org");
    expect(JSON.stringify(status)).not.toContain("geheim-123");
    expect(deps.sent[0].text).not.toContain("geheim-123");
  });
});

describe("Prozessliste", () => {
  test("ps-Zeilen mit lstart (doppeltes Leerzeichen bei einstelligem Tag) und Nachfahren", () => {
    const list = parseProcessList(
      [
        "    1     0 Wed Sep 30 21:09:54 2026     /sbin/launchd",
        "  500     1 Thu Oct  1 06:35:20 2026     caffeinate -i claude -p",
        "  501   500 Thu Oct  1 06:35:21 2026     claude -p --model m",
        "  502   501 Thu Oct  1 06:36:00 2026     /bin/zsh -c bun run test",
        "  503   502 Thu Oct  1 06:36:01 2026     bun test",
        "  600     1 Thu Oct  1 06:00:00 2026     fremd",
        "kaputte Zeile",
      ].join("\n"),
    );
    expect(list).toHaveLength(6);
    expect(list[1]).toEqual({ pid: 500, ppid: 1, identity: "Thu Oct  1 06:35:20 2026", command: "caffeinate -i claude -p" });
    expect(descendantsOf(500, list).map(p => p.pid)).toEqual([501, 502, 503]);
    expect(descendantsOf(600, list)).toEqual([]);
  });
});
