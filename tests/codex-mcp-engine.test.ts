/** MCP-Anbindung ohne echte CLI, MCP-Prozesse, Credentials oder private Dateien. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { CODEX_KILL_GRACE_MS, CodexTurn, codexArgs, codexEnv, createCodexEngine, redactCodexDiagnostic, setCodexRuntimeForTests } from "../src/lib/engines/codex";
import { currentCodexMcpPlan } from "../src/lib/engines/codex-mcp";
import { abortEngineCalls } from "../src/lib/engines/calls";
import type { EngineRequest } from "../src/lib/engines/types";
import { runExecution } from "../src/lib/execution-context";
import { setSettingsPath } from "../src/lib/settings";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { ev, installCodexFake, until, type CodexFake, type FakeRun } from "./codex-fixture";
import { installMcpSources, MCP_CWD, MCP_FILE, MCP_MARK, MCP_TEAM } from "./codex-mcp-fixture";

let fake: CodexFake;
let lines: string[];
let log: ReturnType<typeof spyOn>, error: ReturnType<typeof spyOn>;
const request = (extra: Partial<EngineRequest> = {}): EngineRequest => ({
  prompt: "Bitte suchen", cwd: MCP_CWD, streaming: true, timeoutMs: 60_000, ...extra,
});
const run = (extra: Partial<EngineRequest> = {}) => createCodexEngine().run(request(extra));
const reply = () => fake.next({ events: [ev.started("probe-session"), ev.message("m", "Antwort"), ev.completed()] });
const mcpLines = () => lines.filter(line => line.startsWith("[Codex] MCP-Server:"));

beforeEach(() => {
  setSettingsPath("/test-mcp-settings-fehlen/settings.json");
  setMcpReaderForTests(() => new Set());
  fake = installCodexFake();
  installMcpSources();
  lines = [];
  log = spyOn(console, "log").mockImplementation((...args) => { lines.push(args.join(" ")); });
  error = spyOn(console, "error").mockImplementation((...args) => { lines.push(args.join(" ")); });
});
afterEach(() => {
  fake.restore();
  setSettingsPath();
  setMcpReaderForTests(null);
  log.mockRestore(); error.mockRestore();
});

test("neuer Lauf und Fortsetzen: unveränderte Planparameter, HTTP-Kopfzeilen und Gesprächsumgebung", async () => {
  const key = "topic:-100200:443";
  const baseEnv = codexEnv(MCP_CWD, key);
  const plan = currentCodexMcpPlan({ cwd: MCP_CWD, baseEnv, sandbox: "full" });
  expect(plan.passed.map(s => s.name)).toEqual(["suche", "dateien"]);
  for (const resumeSessionId of [undefined, "probe-session"]) {
    reply();
    const result = await runExecution(key, "general", () => run({ resumeSessionId }));
    expect(result).toMatchObject({ text: "Antwort", isError: false });
    expect(fake.command()).toEqual(["codex", ...codexArgs({ cwd: MCP_CWD, resumeSessionId, mcpArgs: plan.args })]);
    expect(fake.spawns.at(-1)!.env).toEqual({ ...baseEnv, ...plan.env });
    expect(fake.spawns.at(-1)!.env).toMatchObject({ TYBO_SUBPROCESS: "1", TYBO_CHAT_ID: "-100200", TYBO_TOPIC_ID: "443",
      HOME: baseEnv.HOME, PATH: baseEnv.PATH, DATEIEN_WERT: MCP_FILE,
      TYBO_MCP_SUCHE_BEARER_TOKEN: MCP_MARK, TYBO_MCP_SUCHE_HEADER_X_TEAM_TOKEN: MCP_TEAM });
    expect(fake.command()).toContain('mcp_servers.suche.bearer_token_env_var="TYBO_MCP_SUCHE_BEARER_TOKEN"');
    expect(fake.command()).toContain('mcp_servers.suche.env_http_headers={"X-Team"="TYBO_MCP_SUCHE_HEADER_X_TEAM_TOKEN"}');
    const rights = resumeSessionId ? 'sandbox_mode="danger-full-access"' : "--dangerously-bypass-approvals-and-sandbox";
    expect(fake.command().indexOf(plan.args[1])).toBeGreaterThan(fake.command().indexOf(rights));
    for (const value of [MCP_MARK, MCP_TEAM, MCP_FILE]) expect(fake.command().join(" ")).not.toContain(value);
  }
  expect(lines.join("\n")).not.toContain("MCP-Plan fehlgeschlagen");
  expect(mcpLines()).toEqual(["[Codex] MCP-Server: mitgegeben suche, dateien; in Codex selbst: eigen; übersprungen stimme (auth_unknown), alt (transport)"]);
  for (const forbidden of [MCP_MARK, MCP_TEAM, MCP_FILE, "https://", "TYBO_MCP_", "DATEIEN_WERT"]) expect(mcpLines().join()).not.toContain(forbidden);
});

test("geänderte Quelle wirkt im nächsten Turn und schreibt eine neue Übersicht, gleiche Quelle nur einmal", async () => {
  let token = MCP_MARK;
  let skip: string[] = [];
  installMcpSources({ token: () => token, settings: () => ({ skip }) });
  reply(); await run();
  reply(); await run();
  expect(mcpLines()).toHaveLength(1);
  token = "mcp-neue-markierung";
  reply(); await run({ resumeSessionId: "probe-session" });
  expect(fake.spawns.at(-1)!.env!.TYBO_MCP_SUCHE_BEARER_TOKEN).toBe(token);
  expect(mcpLines()).toHaveLength(2);
  skip = ["suche"];
  reply(); await run();
  expect(fake.command().join()).not.toContain("mcp_servers.suche");
  expect(mcpLines()).toHaveLength(3);
  expect(mcpLines().at(-1)).toContain("suche (user_skip)");
});

test.each(["plan", "env"])("Rückfall bei %s-Fehler: alter Aufruf, alte Umgebung, Antwort kommt", async failure => {
  fake.restore();
  fake = installCodexFake({ install: rt => setCodexRuntimeForTests(rt && { ...rt, mcpPlan: input => {
    if (failure === "plan") throw new Error(MCP_MARK);
    const plan = currentCodexMcpPlan(input);
    return { ...plan, env: { ...plan.env, HOME: MCP_MARK } };
  } }) });
  reply();
  expect(await run()).toMatchObject({ text: "Antwort", isError: false });
  expect(fake.command()).toEqual(["codex", ...codexArgs({ cwd: MCP_CWD })]);
  expect(fake.spawns[0].env).toEqual(codexEnv(MCP_CWD));
  expect(lines.filter(l => l.includes("MCP-Plan fehlgeschlagen"))).toEqual(["[Codex] MCP-Plan fehlgeschlagen; Lauf ohne MCP-Server von tybo."]);
  expect(lines.join()).not.toContain(MCP_MARK);
});

test("Plan und Anwendung benutzen genau die Basis des Starts", async () => {
  const baseEnv = codexEnv(MCP_CWD);
  fake.restore();
  fake = installCodexFake({ install: rt => setCodexRuntimeForTests(rt && { ...rt, mcpPlan: input => {
    expect(input.baseEnv).toEqual(baseEnv);
    // Die Anwendung darf nicht noch einmal codexEnv aufrufen.
    process.env.MCP_TEST_BASIS = "erst-nach-plan";
    return currentCodexMcpPlan(input);
  } }) });
  try {
    reply(); await run();
    expect(fake.spawns[0].env!.MCP_TEST_BASIS).toBeUndefined();
  } finally { delete process.env.MCP_TEST_BASIS; }
});

test.each([undefined, "probe-session"])("enabled=false: exakt bisherige Argumente und Umgebung (%s)", async resumeSessionId => {
  installMcpSources({ settings: () => ({ enabled: false }) });
  reply(); await run({ resumeSessionId });
  expect(fake.command()).toEqual(["codex", ...codexArgs({ cwd: MCP_CWD, resumeSessionId })]);
  expect(fake.spawns[0].env).toEqual(codexEnv(MCP_CWD));
});

test.each([
  ["Start", { throws: `Start gescheitert: ${MCP_MARK}` }],
  ["Prompt", { stdinWriteThrows: `EPIPE ${MCP_MARK}`, hang: true }],
  ["turn.failed", { events: [ev.failed(`Fehler ${MCP_MARK}`)], exitCode: 1 }],
  ["error ohne Abschluss", { events: [{ type: "error", message: `Fehler ${MCP_MARK}` }], exitCode: 1 }],
  ["stderr", { stderr: `Erste Zeile\nFehler ${MCP_MARK}\nLetzte Zeile`, exitCode: 1 }],
] satisfies [string, FakeRun][])("nur MCP-Quelle: %s maskiert Ergebnis und beide Konsolen", async (_name, failure) => {
  expect(process.env.DATEIEN_WERT).toBeUndefined();
  expect(process.env.TYBO_MCP_SUCHE_BEARER_TOKEN).toBeUndefined();
  fake.next(failure);
  const result = await run();
  expect(result.isError).toBe(true);
  expect(result.text).not.toContain(MCP_MARK);
  expect(result.text).toContain("[verborgen]");
  expect(lines.join("\n")).not.toContain(MCP_MARK);
});

test("die Modellantwort bleibt unverändert, obwohl der Wert im Plan steht", async () => {
  fake.next({ events: [ev.message("m", MCP_MARK), ev.completed()] });
  expect((await run()).text).toBe(MCP_MARK);
  expect(lines.join()).not.toContain(MCP_MARK);
});

test("kurze Maskierungswerte verändern die Fehlerart von stderr nicht, reiner Leerraum entfällt", () => {
  const turn = new CodexTurn();
  const result = turn.result({ cwd: MCP_CWD, exitCode: 1, stderr: "You've hit your usage limit", secretValues: ["usage", " ", ""] });
  expect(result).toMatchObject({ isError: true, errorKind: "usage_limit", text: "You've hit your [verborgen] limit" });
  expect(redactCodexDiagnostic("Fehler 1 bleibt lesbar", ["1", " ", ""])).toBe("Fehler [verborgen] bleibt lesbar");
  expect(redactCodexDiagnostic(`Fehler ${MCP_MARK}`, [` ${MCP_MARK} `])).not.toContain(MCP_MARK);
});

test.each(["stop", "timeout"])("MCP-Lauf bei %s: SIGINT und SIGKILL bleiben an die Laufgruppe gebunden", async cause => {
  fake.next({ events: [ev.started("probe-session"), ev.mcp("werkzeug", "dateien", "lesen")], hang: true, ignoreSigint: true });
  const pending = run({ abortKey: "mcp-abbruch", timeoutMs: 10_000 });
  await until(() => fake.spawns.length === 1);
  expect(fake.spawns[0].env!.DATEIEN_WERT).toBe(MCP_FILE);
  if (cause === "stop") expect(abortEngineCalls("mcp-abbruch")).toBe(1);
  else fake.advance(10_000);
  expect(fake.signals).toEqual(["SIGINT"]);
  fake.advance(CODEX_KILL_GRACE_MS);
  expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
  expect(await pending).toMatchObject(cause === "stop" ? { aborted: true } : { timedOut: true });
});
