/**
 * Issue #103, Checkbox 1: Job-Ordner, Status mit Sperre, Start mit
 * Attrappe für den Prozessstart. Kein echtes claude, kein Telegram.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStartArgs, resolveJobTarget, runJobCli, type JobCliOptions } from "../src/lib/jobs/cli";
import { claudeCommand, codexCommand, jobPrompt, startJob, type StartInput } from "../src/lib/jobs/runner";
import { CODEX_EFFORT_LEVELS, EFFORT_LEVELS, getSettings, getSettingsPath, setSettingsPath } from "../src/lib/settings";
import { claimOutcome, jobDir, newJobId, readAllStatuses, readStatus, updateStatus } from "../src/lib/jobs/store";
import { fakeDeps, tempRoot } from "./jobs-fixture";
import { DEFAULT_CLAUDE_MODEL } from "../src/lib/default-model";
import { jobClaudeEnv, jobCodexEnv } from "../src/lib/jobs/default-deps";
import { filterSubprocessEnv, isProtectedSubprocessVar } from "../src/lib/subprocess-env";

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
    expect(status).toMatchObject({ version: 1, title: given.title, phase: "running", target: { topicId: 443 }, maxHours: 6, engine: "claude", model: "claude-test", fullAccess: false });
    expect(status.watcher?.pid).toBe(41_000);
    expect(status.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deps.sent).toEqual([]);
  });

  test("speichert das aufgelöste Claude-Modell und für jeden Job eine eigene Session", async () => {
    const deps = fakeDeps(root);
    deps.spawnWatcher = runningWatcher(deps);
    const first = await startJob(input({ model: undefined }), deps);
    const second = await startJob(input({ model: undefined }), deps);
    if (!first.ok || !second.ok) throw new Error("Start gescheitert");
    expect(first.status.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(second.status.sessionId).not.toBe(first.status.sessionId);
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

  test("Codex steht im Status, ohne Modell bleibt dessen Konfiguration; eigener Arbeitsordner wird vor dem Anlegen abgelehnt", async () => {
    const deps = fakeDeps(root);
    deps.spawnWatcher = runningWatcher(deps);
    const result = await startJob(input({ engine: "codex", model: undefined }), deps);
    if (!result.ok) throw new Error(result.error);
    const status = (await readStatus(root, result.id))!;
    expect(status.engine).toBe("codex");
    expect(status).not.toHaveProperty("model");
    expect(status).not.toHaveProperty("sessionId");
    const before = (await readAllStatuses(root)).length;
    for (const fullAccess of [false, true]) {
      expect(await startJob(input({ engine: "codex", workDir: root, fullAccess }), deps)).toMatchObject({
        ok: false, error: expect.stringContaining("nur mit Claude"),
      });
    }
    expect((await readAllStatuses(root)).length).toBe(before);
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

    const base = { claudePath: "claude", model: "m", platform: "linux" as const, sessionId: "12345678-1234-4234-8234-123456789abc" };
    const noWaiting = ["--disallowedTools", "Monitor,ScheduleWakeup,CronCreate"];
    expect(claudeCommand({ ...base, fullAccess: false })).toEqual([
      "claude", "-p", "--output-format", "text", "--model", "m", "--session-id", base.sessionId, "--permission-mode", "acceptEdits", ...noWaiting,
    ]);
    expect(claudeCommand({ ...base, fullAccess: true, effort: "high" })).toEqual([
      "claude", "-p", "--output-format", "text", "--model", "m", "--session-id", base.sessionId, "--effort", "high", "--permission-mode", "bypassPermissions", ...noWaiting,
    ]);
    expect(claudeCommand({ ...base, fullAccess: false, platform: "darwin" }).slice(0, 3)).toEqual(["/usr/bin/caffeinate", "-i", "claude"]);
  });
});

describe("Codex-Aufruf", () => {
  const base = { codexPath: "/bin/codex", root: "/projekt", platform: "linux" as const };

  test.each([false, true])("Modell und Effort nur bei Angabe, Auftrag über stdin, fullAccess=%s", fullAccess => {
    const cmd = codexCommand({ ...base, fullAccess, model: "gpt-6-astra", effort: "high" });
    expect(cmd.slice(0, 4)).toEqual(["/bin/codex", "exec", "-C", "/projekt"]);
    expect(cmd.at(-1)).toBe("-");
    expect(cmd[cmd.indexOf("-m") + 1]).toBe("gpt-6-astra");
    expect(cmd).toContain("model_reasoning_effort=high");
    expect(cmd).toContain('approval_policy="never"');
    expect(cmd).toContain('project_doc_fallback_filenames=["CLAUDE.md"]');
    const plain = codexCommand({ ...base, fullAccess });
    expect(plain).not.toContain("-m");
    expect(plain.some(arg => arg.startsWith("model_reasoning_effort="))).toBe(false);
    expect(codexCommand({ ...base, fullAccess, platform: "darwin" }).slice(0, 3)).toEqual(["/usr/bin/caffeinate", "-i", "/bin/codex"]);
    if (fullAccess) {
      expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(cmd).not.toContain("--sandbox");
      expect(cmd).not.toContain("shell_tool");
      expect(cmd).not.toContain("--disable");
      expect(plain).toEqual([
        "/bin/codex", "exec", "-C", "/projekt",
        "-c", 'project_doc_fallback_filenames=["CLAUDE.md"]', "-c", "project_doc_max_bytes=65536",
        "--dangerously-bypass-approvals-and-sandbox", "-c", 'approval_policy="never"', "-",
      ]);
    } else {
      expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(cmd[cmd.indexOf("--sandbox") + 1]).toBe("workspace-write");
      // Der letzte -c-Wert überschreibt die Chat-Stufe mit Netz.
      expect(cmd.filter(arg => arg.startsWith("sandbox_workspace_write.network_access=")).at(-1)).toBe("sandbox_workspace_write.network_access=false");
      expect(cmd).toContain("sandbox_workspace_write.writable_roots=[]");
      expect(cmd).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true");
      expect(cmd).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
      expect(cmd[cmd.indexOf("--disable") + 1]).toBe("shell_tool");
      const disabled = cmd.flatMap((arg, i) => arg === "--disable" ? [cmd[i + 1]] : []);
      for (const feature of [
        "shell_tool", "unified_exec", "code_mode_host", "code_mode_only",
        "apps", "plugins", "remote_plugin", "skill_mcp_dependency_install", "tool_suggest",
        "browser_use", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser", "computer_use",
        "image_generation", "view_image", "multi_agent", "multi_agent_v2", "agent_message_board", "agent_message_board_mcp",
        "hooks", "shell_snapshot", "goals", "sleep_tool",
      ]) expect(disabled).toContain(feature);
      for (const config of [
        'web_search="disabled"', "agents.enabled=false", "notify=[]",
        "tools.experimental_request_user_input.enabled=false", "tools.update_plan.enabled=false",
        "features.code_mode.enabled=false",
        'features.code_mode.direct_only_tool_namespaces=["functions"]',
        'features.code_mode.excluded_tool_namespaces=["clock"]',
      ]) expect(cmd).toContain(config);
    }
  });

  test("MCP-Server einzeln sperren, Namen mit Punkten bleiben ein TOML-Schlüssel; volle Stufe unverändert", () => {
    const mcpServers = ["mail", 'lokal.mit"Zitat', "mail"];
    const cmd = codexCommand({ ...base, fullAccess: false, mcpServers });
    const configs = cmd.filter(arg => arg.startsWith("mcp_servers="));
    expect(configs).toHaveLength(1);
    expect(Bun.TOML.parse(configs.join("\n"))).toEqual({ mcp_servers: { mail: { enabled: false }, 'lokal.mit"Zitat': { enabled: false } } });
    expect(cmd).not.toContain("mcp_servers={}");
    expect(codexCommand({ ...base, fullAccess: true, mcpServers })).toEqual(codexCommand({ ...base, fullAccess: true }));
  });
});

describe("job start: Aufruf und Rückmeldeziel", () => {
  test("Argumente", () => {
    expect(parseStartArgs(["--title", "T", "--text", "Auftrag"])).toEqual({ title: "T", text: "Auftrag", engine: "claude", maxHours: 6, fullAccess: false });
    expect(parseStartArgs(["--title", "T", "--brief", "b.md", "--topic", "5", "--max-hours", "0.5", "--model", "claude-x", "--effort", "high", "--full-access"])).toEqual({
      title: "T", briefFile: "b.md", topicId: 5, engine: "claude", maxHours: 0.5, model: "claude-x", effort: "high", fullAccess: true,
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

  test("Motor gültig oder ungültig, Effort aus der Liste des Motors", () => {
    const args = ["--title", "T", "--text", "Auftrag"];
    for (const engine of ["claude", "codex"] as const) {
      expect(parseStartArgs([...args, "--engine", engine])).toMatchObject({ engine });
      for (const effort of engine === "codex" ? CODEX_EFFORT_LEVELS : EFFORT_LEVELS) {
        expect(parseStartArgs([...args, `--engine=${engine}`, "--effort", effort])).toMatchObject({ engine, effort });
      }
      expect(parseStartArgs([...args, "--engine", engine, "--effort", "ultra"])).toMatchObject({ error: expect.stringContaining("--effort") });
    }
    for (const extra of [["--engine", "api"], ["--engine="], ["--engine"], ["--engine", "codex", "--engine", "claude"]]) {
      expect(parseStartArgs([...args, ...extra])).toMatchObject({ error: expect.stringContaining("--engine") });
    }
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

  test("--zurueck zählt drei Jobs, der vierte und ungültige Zähler starten keinen Wächter", async () => {
    for (const engine of ["claude", "codex"]) {
      for (const inherited of [undefined, "1", "2", "3", "-1", "abc", "1.5", "99999999999999999999"]) {
        const { options, out, deps } = cli(inherited === undefined ? {} : { TYBO_JOB_CHAIN: inherited });
        const title = `Rückgabe ${engine} ${inherited}`;
        const before = (await readAllStatuses(root)).length;
        const code = await runJobCli(["start", "--title", title, "--text", title, "--engine", engine, "--zurueck"], options);
        if (inherited === undefined || inherited === "1" || inherited === "2") {
          expect(code).toBe(0);
          const status = (await readStatus(root, /Job (\S+) läuft/.exec(out[0])![1]))!;
          expect(status).toMatchObject({ returnToChat: true, jobChain: Number(inherited ?? 0) + 1, target: {} });
          for (const buildEnv of [jobClaudeEnv, jobCodexEnv]) {
            expect(buildEnv(root, { HOME: root, TYBO_JOB_CHAIN: "99" }, status).TYBO_JOB_CHAIN).toBe(String(status.jobChain));
          }
        } else {
          expect(code).toBe(2);
          expect(await readAllStatuses(root)).toHaveLength(before);
          expect(deps.procs.living.size).toBe(1);
        }
      }
    }
  });

  test("ohne --zurueck unverändert, geerbte Kette bleibt für weitere Kind-Jobs erhalten", async () => {
    for (const inherited of [undefined, "3"]) {
      const { options, out } = cli(inherited === undefined ? {} : { TYBO_JOB_CHAIN: inherited });
      const title = `Ohne Rückgabe ${inherited}`;
      expect(await runJobCli(["start", "--title", title, "--text", title], options)).toBe(0);
      const status = (await readStatus(root, /Job (\S+) läuft/.exec(out[0])![1]))!;
      expect(status.returnToChat).toBeUndefined();
      expect(status.jobChain).toBe(inherited === undefined ? undefined : 3);
      expect(jobClaudeEnv(root, { HOME: root, TYBO_JOB_CHAIN: "99" }, status).TYBO_JOB_CHAIN).toBe(inherited);
    }
    for (const engine of ["claude", "codex", "opencode"] as const) {
      expect(filterSubprocessEnv({ engine, cwd: root, home: root, env: { TYBO_JOB_CHAIN: "3", TYBO_SUBPROCESS_ENV_ALLOW: "TYBO_JOB_CHAIN" } }).env.TYBO_JOB_CHAIN).toBeUndefined();
      expect(isProtectedSubprocessVar("TYBO_JOB_CHAIN", engine)).toBe(true);
    }
  });

  test("Start aus einem Gespräch: Ziel aus TYBO_*, Standardmodell und -effort, Ausgabe mit ID", async () => {
    const { options, out, err } = cli({ TYBO_CHAT_ID: "-100200", TYBO_TOPIC_ID: "443" });
    const code = await runJobCli(["start", "--title", "Bericht", "--text", "Schreib etwas"], options);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    const id = /Job (\S+) läuft/.exec(out[0])![1];
    expect(await readStatus(root, id)).toMatchObject({ target: { chatId: "-100200", topicId: 443 }, model: "claude-default", effort: "high" });
    expect(out[0]).toContain("(claude, claude-default, high)");
  });

  test("Modell und Effort aus den Einstellungen je Motor, Optionen gehen einzeln vor", async () => {
    const previous = getSettingsPath();
    const file = join(root, "config", "settings.json");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(file, JSON.stringify({ defaults: { model: "claude-einstellung", effort: "medium" }, engine: { default: "codex", codex: { model: "gpt-6-astra", effort: "max" } } }));
    setSettingsPath(file);
    try {
      for (const engine of ["claude", "codex"] as const) {
        for (const extra of [[], ["--model", "anderes-modell"], ["--effort", "low"], ["--model", "anderes-modell", "--effort", "high"]]) {
          const { options, out } = cli({});
          options.settings = getSettings();
          const title = `Einstellungen ${engine} ${extra.join(" ")}`;
          expect(await runJobCli(["start", "--title", title, "--text", title, ...(engine === "codex" ? ["--engine", engine] : []), ...extra], options)).toBe(0);
          const id = /Job (\S+) läuft/.exec(out[0])![1];
          const model = extra.includes("--model") ? "anderes-modell" : engine === "codex" ? "gpt-6-astra" : "claude-einstellung";
          const effort = extra.includes("--effort") ? extra[extra.indexOf("--effort") + 1] : engine === "codex" ? "max" : "medium";
          expect(await readStatus(root, id)).toMatchObject({ engine, model, effort });
          expect(out[0]).toContain(`(${engine}, ${model}, ${effort})`);
        }
      }
    } finally { setSettingsPath(previous); }
  });

  test("ohne Einstellungen: Codex übernimmt keine Claude-Werte, Claude-Effort hängt vom gewählten Modell ab", async () => {
    for (const engine of ["claude", "codex"] as const) {
      const { options, out } = cli({});
      const title = `Ohne Einstellungen ${engine}`;
      const extra = engine === "claude" ? ["--model", "claude-anderes"] : [];
      expect(await runJobCli(["start", "--engine", engine, "--title", title, "--text", title, ...extra], options)).toBe(0);
      const status = (await readStatus(root, /Job (\S+) läuft/.exec(out[0])![1]))!;
      expect(status.effort).toBeUndefined();
      expect(status.model).toBe(engine === "codex" ? undefined : "claude-anderes");
    }
  });

  test("nur Modell in den Einstellungen: Claude-Effort wird für dieses Modell aufgelöst", async () => {
    const { options, out } = cli({});
    options.settings = { defaults: { model: "claude-nur-einstellung" } };
    options.defaultEffort = model => model === "claude-nur-einstellung" ? "xhigh" : undefined;
    expect(await runJobCli(["start", "--title", "Nur Modell", "--text", "Nur Modell aus den Einstellungen"], options)).toBe(0);
    const id = /Job (\S+) läuft/.exec(out[0])![1];
    expect(await readStatus(root, id)).toMatchObject({ model: "claude-nur-einstellung", effort: "xhigh" });
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

    const badEngine = cli({});
    expect(await runJobCli(["start", "--title", "T", "--text", "x", "--engine", "api"], badEngine.options)).toBe(2);
    expect(badEngine.err[0]).toContain("--engine muss claude oder codex sein");

    expect(await count()).toBe(before);
  });
});
