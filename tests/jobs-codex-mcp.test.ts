/** MCP für volle Codex-Jobs: echte Planung und Log-Pumpe, niemals echte Motoren oder MCP-Server. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentCodexMcpPlan } from "../src/lib/engines/codex-mcp";
import { createJobDeps } from "../src/lib/jobs/default-deps";
import { MASK } from "../src/lib/jobs/mask";
import { realProcessOps } from "../src/lib/jobs/process";
import { claudeCommand, codexCommand, runWatcher, type ClaudeSpawnSpec, type SpawnedClaude } from "../src/lib/jobs/runner";
import { jobDir, jobFile, readStatus, writeStatus, type JobStatus } from "../src/lib/jobs/store";
import { setSettingsPath } from "../src/lib/settings";
import { fakeChild, fakeDeps, tempRoot } from "./jobs-fixture";
import { installMcpSources, MCP_FILE, MCP_MARK, MCP_TEAM } from "./codex-mcp-fixture";

let root: string, cleanup: () => void;
const id = "20261117-120000-000662";
const baseEnv = () => ({ HOME: root, PATH: process.env.PATH ?? "", TYBO_SUBPROCESS: "1", TYBO_JOB_ID: id, TYBO_CHAT_ID: "-100200", TYBO_TOPIC_ID: "443" });
async function prepare(over: Partial<JobStatus> = {}) {
  await Bun.write(jobFile(root, id, "brief"), "Schreibe einen Bericht.");
  await Bun.write(jobFile(root, id, "log"), "");
  await writeStatus(root, { version: 1, id, title: "MCP-Probe", createdAt: new Date().toISOString(), phase: "starting",
    maxHours: 1, engine: "codex", fullAccess: true, target: { chatId: "-100200", topicId: 443 }, ...over });
}
function depsWithPlan() {
  const deps = fakeDeps(root, { spawnClaude: () => fakeChild(55_555, Promise.resolve({ code: 0, signal: null })) });
  deps.codexEnv = baseEnv;
  deps.codexMcpPlan = env => currentCodexMcpPlan({ cwd: root, baseEnv: env, sandbox: "full" });
  return deps;
}
function expectNoStoredValues() {
  for (const file of readdirSync(jobDir(root, id))) {
    if (!file.endsWith(".json") && !file.endsWith(".log") && !file.endsWith(".md")) continue;
    const text = readFileSync(join(jobDir(root, id), file), "utf8");
    for (const value of [MCP_MARK, MCP_TEAM, MCP_FILE]) expect(text).not.toContain(value);
  }
}
beforeEach(() => {
  ({ root, cleanup } = tempRoot("jobs-codex-mcp-"));
  installMcpSources();
});
afterEach(() => { cleanup(); setSettingsPath(); });

test("volle Jobs: Plan direkt vor stdin, echte HTTP-Ausnahme, Basis nur einmal gelesen", async () => {
  await prepare();
  const deps = depsWithPlan();
  const env = baseEnv();
  let envCalls = 0, planCalls = 0;
  deps.codexEnv = () => { envCalls++; return env; };
  deps.codexMcpPlan = seen => {
    expect(seen).toBe(env); planCalls++;
    return currentCodexMcpPlan({ cwd: root, baseEnv: seen, sandbox: "full" });
  };
  const plan = deps.codexMcpPlan(env); planCalls = 0;
  expect(await runWatcher(id, deps)).toBe(0);
  expect(envCalls).toBe(1); expect(planCalls).toBe(1);
  const spec = deps.spawned[0];
  expect(spec.cmd.slice(-plan.args.length - 1)).toEqual([...plan.args, "-"]);
  expect(spec.env).toEqual({ ...env, ...plan.env });
  expect(spec.env).toMatchObject({ TYBO_MCP_SUCHE_BEARER_TOKEN: MCP_MARK, TYBO_MCP_SUCHE_HEADER_X_TEAM_TOKEN: MCP_TEAM, DATEIEN_WERT: MCP_FILE });
  for (const value of plan.secretValues) expect(spec.cmd.join()).not.toContain(value);
  expect(spec.secrets).toContain(MCP_MARK);
  expect(deps.logs.join()).not.toContain("MCP-Plan fehlgeschlagen");
  expectNoStoredValues();
});

test("echte Job-Abhängigkeit nimmt full auch bei Chat-Stufe read-only", () => {
  const settings = join(root, "settings.json");
  writeFileSync(settings, JSON.stringify({ engine: { codex: { sandbox: "read-only" } } }));
  setSettingsPath(settings);
  const deps = createJobDeps({ root, env: {} });
  expect(deps.codexMcpPlan(baseEnv()).passed.map(s => s.name)).toEqual(["suche", "dateien"]);
});

test.each(["plan", "env"])("%s wirft: Job startet mit bisherigem Aufruf und meldet den festen Rückfall", async failure => {
  await prepare();
  const deps = depsWithPlan();
  deps.codexMcpPlan = env => {
    if (failure === "plan") throw new Error(MCP_MARK);
    const plan = currentCodexMcpPlan({ cwd: root, baseEnv: env, sandbox: "full" });
    return { ...plan, env: { ...plan.env, HOME: MCP_MARK } };
  };
  expect(await runWatcher(id, deps)).toBe(0);
  expect(await readStatus(root, id)).toMatchObject({ outcome: "no_report" });
  expect(deps.spawned[0].cmd).toEqual(codexCommand({ codexPath: "codex", root, fullAccess: true, platform: "linux" }));
  expect(deps.spawned[0].env).toEqual(baseEnv());
  expect(deps.logs).toContain("[job] MCP-Plan fehlgeschlagen; Lauf ohne MCP-Server von tybo.");
  expect(deps.logs.join()).not.toContain(MCP_MARK);
  expectNoStoredValues();
});

test.each([false, true])("Claude fullAccess=%s: kein Plan, Aufruf und Umgebung unverändert", async fullAccess => {
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  await prepare({ engine: "claude", model: "claude-test", fullAccess, sessionId });
  const deps = depsWithPlan();
  let calls = 0;
  deps.codexMcpPlan = () => { calls++; throw new Error("Darf nicht aufgerufen werden"); };
  await runWatcher(id, deps);
  expect(calls).toBe(0);
  expect(deps.spawned[0].cmd).toEqual(claudeCommand({ claudePath: "claude", model: "claude-test", fullAccess, platform: "linux", sessionId }));
  expect(deps.spawned[0].env).toEqual({ TYBO_JOB_ID: id });
  expect(deps.spawned[0].secrets).toEqual([sessionId]);
});

test("eingeschränkt: kein Plan, alle Abschaltungen aus #618 bleiben; auch übergebene mcpArgs werden ignoriert", async () => {
  await prepare({ fullAccess: false });
  const deps = depsWithPlan();
  let calls = 0;
  deps.codexMcpPlan = () => { calls++; throw new Error("Darf nicht aufgerufen werden"); };
  deps.codexMcpServers = async () => ["eigen", "konto.mail"];
  await runWatcher(id, deps);
  expect(calls).toBe(0);
  const options = { codexPath: "codex", root, fullAccess: false, platform: "linux" as const, mcpServers: ["eigen", "konto.mail"] };
  expect(deps.spawned[0].cmd).toEqual(codexCommand(options));
  expect(codexCommand({ ...options, mcpArgs: ["-c", 'mcp_servers.fremd.command="bun"'] })).toEqual(codexCommand(options));
  expect(deps.spawned[0].cmd).toContain("shell_tool");
  expect(deps.spawned[0].cmd).toContain('mcp_servers={"eigen"={enabled=false},"konto.mail"={enabled=false}}');
  expect(deps.spawned[0].env).toEqual(baseEnv());
  expect(deps.spawned[0].secrets).toBeUndefined();
});

test("Startfehler: Werte aus dem Plan fehlen auch im gespeicherten detail und in der Meldung", async () => {
  await prepare();
  const deps = depsWithPlan();
  deps.spawnClaude = () => { throw new Error(`Startfehler ${MCP_MARK}`); };
  await runWatcher(id, deps);
  expect(await readStatus(root, id)).toMatchObject({ outcome: "start_failed", detail: `Codex ließ sich nicht starten (Startfehler ${MASK}).` });
  expect(deps.sent[0].text).toContain(MASK);
  expect(deps.sent[0].text).not.toContain(MCP_MARK);
  expectNoStoredValues();
});

test("echtes spawnClaude maskiert stdout/stderr vor job.log; gescheiterter Job meldet ohne MCP- und Basiswerte", async () => {
  await prepare();
  const deps = depsWithPlan();
  const real = createJobDeps({ root, env: { BASIS_KEY: "basis-markierung" } });
  deps.secrets = real.secrets;
  let child: SpawnedClaude | undefined;
  deps.spawnClaude = (spec: ClaudeSpawnSpec) => {
    deps.spawned.push(spec);
    // Harmloser Ausgabeschreiber: keine CLI und kein MCP-Server, auch keine .env laden.
    child = real.spawnClaude({ ...spec, cmd: [process.execPath, "--no-env-file", "-e", `
      const value = process.env.TYBO_MCP_SUCHE_BEARER_TOKEN;
      process.stdout.write("Fehler " + value.slice(0, 7));
      await Bun.sleep(20);
      process.stderr.write(value.slice(7) + " ");
      process.stderr.write(process.env.TYBO_MCP_SUCHE_HEADER_X_TEAM_TOKEN + " basis-markierung\\n");
      process.exit(7);
    `] });
    return child;
  };
  deps.proc = { ...realProcessOps, listProcesses: () => [] };
  deps.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  expect(await runWatcher(id, deps)).toBe(0);
  await child!.drained;
  expect(await readStatus(root, id)).toMatchObject({ outcome: "failed", exitCode: 7 });
  expect(readFileSync(jobFile(root, id, "log"), "utf8")).toBe(`Fehler ${MASK} ${MASK} ${MASK}\n`);
  for (const text of [deps.sent[0].text!, deps.logs.join()]) {
    for (const value of [MCP_MARK, MCP_TEAM, "basis-markierung"]) expect(text).not.toContain(value);
  }
  expect(deps.sent[0].text).toContain("Job fehlgeschlagen");
  expect(deps.sent[0].text).toContain(MASK);
  expectNoStoredValues();
});

test("kurzer Wert und Leerraum: Log und Meldung behalten lesbare Wörter und Abstände", async () => {
  await prepare();
  const deps = depsWithPlan();
  const original = deps.codexMcpPlan;
  deps.codexMcpPlan = env => ({ ...original(env), secretValues: ["1", " ", ""] });
  const real = createJobDeps({ root, env: {} });
  let child: SpawnedClaude | undefined;
  deps.proc = { ...realProcessOps, listProcesses: () => [] };
  deps.spawnClaude = spec => (child = real.spawnClaude({ ...spec, cmd: [process.execPath, "--no-env-file", "-e", 'console.log("Schritt 1 gescheitert"); process.exit(7)'] }));
  deps.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  await runWatcher(id, deps); await child!.drained;
  expect(readFileSync(jobFile(root, id, "log"), "utf8")).toBe(`Schritt ${MASK} gescheitert\n`);
  expect(deps.sent[0].text).toContain(`Schritt ${MASK} gescheitert`);
  expect(deps.sent[0].text).toContain("Job fehlgeschlagen");
});

test("Bericht, Zustellfehler und Prozessreste verwenden die erweiterte Liste", async () => {
  await prepare();
  const deps = depsWithPlan();
  let finish!: (exit: { code: number; signal: null }) => void;
  let done = false;
  const exited = new Promise<{ code: number; signal: null }>(resolve => { finish = resolve; });
  deps.spawnClaude = () => {
    deps.procs.spawn(55_555);
    return fakeChild(55_555, exited);
  };
  deps.proc.listProcesses = () => {
    const wasDone = done;
    if (!done) { done = true; finish({ code: 0, signal: null }); }
    return [{ pid: 60_001, ppid: wasDone ? 1 : 55_555, identity: "fester-start", command: `rest ${MCP_MARK}` }];
  };
  deps.trackIntervalMs = 1;
  writeFileSync(jobFile(root, id, "report"), `Bericht ${MCP_MARK}`);
  let attempts = 0;
  deps.notify = async input => {
    if (++attempts === 1) return { sent: false, recorded: false, error: { kind: "send", message: `Versand ${MCP_MARK}` } };
    deps.sent.push(input); return { sent: true, recorded: true };
  };
  await runWatcher(id, deps);
  expect(attempts).toBe(2);
  expect(deps.sent[0].text).toContain(`Bericht ${MASK}`);
  expect(deps.sent[0].text).not.toContain(MCP_MARK);
  expect(deps.logs.join()).toContain(`Versand ${MASK}`);
  expect(await readStatus(root, id)).toMatchObject({ leftovers: [{ pid: 60_001, command: `rest ${MASK}` }] });
  expect(JSON.stringify(await readStatus(root, id))).not.toContain(MCP_MARK);
});
