/**
 * Issue #37: GET /api/status und POST /api/restart über den Server. Der
 * Neustart-Marker liegt immer in einem temporären Ordner, der Supervisor ist
 * eine Attrappe; nie data/restart-requested, nie launchctl.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRestartRequest, requestRestart } from "../src/lib/restart-request";
import type { EngineId, EngineStatus } from "../src/lib/engines";
import { CLAUDE_LOGIN_UNKNOWN, CODEX_NOT_LOGGED_IN } from "../src/lib/engines/check";
import { API_KEY_MISSING } from "../src/lib/engines/api";
import { createBotStatus, type BotStatusDeps } from "../src/web/bot-status";
import type { WebServer } from "../src/web/server";
import { RESTART_NOTE, STATUS_TEXT, type Supervisor } from "../src/web/status";
import { topicServer } from "./topic-fixture";

// Werkzeug-Vertrag: feste Texte und Mengen ohne Kopie im Browser (M14-15).
import { createDemoStatus, DEMO_STATUS_ENGINES } from "../src/web/demo";
import { createStatusApi, statusEngine, type StatusEngineAvailability } from "../src/web/status";
import { TOOL_GAP_IDS, TOOL_GAP_TEXT, toolGapsResponse, type ToolGaps, type ToolInventory } from "../src/web/tool-parity-types";
import { createToolParitySnapshot, safeSkillName, setToolParityReadersForTests, type ToolParityInput, type ToolParitySnapshot } from "../src/lib/engines/tool-parity";
import { safeMcpName, setCodexMcpInputsForTests } from "../src/lib/engines/codex-mcp";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const root = await mkdtemp(join(tmpdir(), "bot-status-api-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

const SECRET = "sk-ant-test-Status-Api-9f8e7d6c";
let counter = 0;

async function setup(supervisor: Supervisor | null | "throws", overrides: Partial<BotStatusDeps> = {}) {
  const marker = join(root, `case-${++counter}`, "data", "restart-requested");
  const status = createBotStatus(
    // Seit Issue #324 gilt Supabase wie in der Store-Auswahl nur mit Adresse und Schlüssel
    { ANTHROPIC_API_KEY: SECRET, SUPABASE_URL: "https://test-status-api.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test-status-api-1a2b3c" },
    {
      gitHead: async () => "0fe4c19",
      readPackageJson: () => '{"version":"2.12.0"}',
      startedAt: Date.now() - 3_000,
      detectSupervisor: async () => {
        if (supervisor === "throws") throw new Error("launchctl hängt");
        return supervisor;
      },
      listSessions: async () => [],
      sessionMode: () => true,
      activeExecutions: () => 1,
      activeClaudeCalls: () => 1,
      restartMarker: marker,
      requestRestart: note => requestRestart(note, marker),
      toolParity: () => { throw new Error("Test ohne Werkzeug-Quelle"); },
      // Nie ein echtes claude oder codex (Issue #126): Prüf-Attrappe
      inspectEngine: async (id: EngineId): Promise<EngineStatus> => ({ engine: id, checked: true, installed: true, loggedIn: true, version: "1.0.0" }),
      ...overrides,
    }
  );
  const ctx = await topicServer(root, servers, null, { status });
  return { ...ctx, marker };
}

describe("GET /api/status", () => {
  test("liefert alle Felder, Schlüssel nur als set, kein Wert in der ganzen HTTP-Antwort", async () => {
    const ctx = await setup("launchd");
    const res = await ctx.api("/api/status");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("test-status-api");
    for (const [, v] of res.headers) expect(v).not.toContain(SECRET);
    const body = JSON.parse(raw);
    expect(Object.keys(body).sort()).toEqual(
      ["engines", "keys", "restartRequested", "running", "semanticSearch", "sessions", "startedAt", "storage", "supervisor", "telegramIntake", "uptimeSeconds", "version"].sort()
    );
    expect(body.version).toEqual({ app: "2.12.0", commit: "0fe4c19" });
    expect(body.supervisor).toBe("launchd");
    expect(body.storage).toBe("supabase");
    expect(body.sessions).toEqual({ mode: "resume", stored: 0, resumable: 0 });
    expect(body.running).toEqual({ executions: 1, claudeCalls: 1 });
    expect(body.restartRequested).toBe(false);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(3);
    expect(body.keys.find((k: any) => k.name === "ANTHROPIC_API_KEY")).toEqual({ name: "ANTHROPIC_API_KEY", group: "Anthropic", set: true });
    expect(body.keys.find((k: any) => k.name === "OPENAI_API_KEY").set).toBe(false);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("ohne Anmeldung 401", async () => {
    const ctx = await setup("launchd");
    const res = await fetch(`${ctx.origin}/api/status`);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SECRET);
  });

  test("falsche Methode 405", async () => {
    const ctx = await setup("launchd");
    const res = await ctx.api("/api/status", "POST", {});
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(await readRestartRequest(ctx.marker)).toBeNull();
  });

  test("ohne Status-Quelle 503", async () => {
    const ctx = await topicServer(root, servers, null, {});
    expect((await ctx.api("/api/status")).status).toBe(503);
    const res = await ctx.api("/api/restart", "POST");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(STATUS_TEXT.notConfigured);
  });
});

describe("POST /api/restart", () => {
  test("mit Supervisor: 202, Marker mit Notiz WebUI, Hinweis auf Neustart nach der Antwort", async () => {
    const ctx = await setup("launchd");
    const res = await ctx.api("/api/restart", "POST");
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ requested: true, supervisor: "launchd", message: STATUS_TEXT.requested });
    expect(body.message).toContain("nach der laufenden Antwort");
    expect(await readRestartRequest(ctx.marker)).toBe(RESTART_NOTE);
    expect((await (await ctx.api("/api/status")).json()).restartRequested).toBe(true);
    expect(ctx.logs.some(l => l.includes("Neustart angefordert"))).toBe(true);
  });

  test("PM2 zählt ebenfalls als Supervisor", async () => {
    const ctx = await setup("pm2");
    expect((await ctx.api("/api/restart", "POST")).status).toBe(202);
    expect(await readRestartRequest(ctx.marker)).toBe("WebUI");
  });

  test("ohne Supervisor: 409 mit Hinweis auf manuellen Neustart, kein Marker", async () => {
    const ctx = await setup(null);
    const res = await ctx.api("/api/restart", "POST");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe(STATUS_TEXT.noSupervisor);
    expect(body.error).toContain("manuell");
    expect(await readRestartRequest(ctx.marker)).toBeNull();
  });

  test("Supervisor-Erkennung scheitert: vorsichtig 409, kein Marker", async () => {
    const ctx = await setup("throws");
    expect((await ctx.api("/api/restart", "POST")).status).toBe(409);
    expect(await readRestartRequest(ctx.marker)).toBeNull();
  });

  test("Schreibfehler: 500, kein Erfolg gemeldet", async () => {
    // Elternordner ist eine Datei: mkdir und writeFile scheitern
    const blocker = join(root, `blocker-${++counter}`);
    await writeFile(blocker, "");
    const marker = join(blocker, "restart-requested");
    const ctx = await setup("launchd", { requestRestart: note => requestRestart(note, marker) });
    const res = await ctx.api("/api/restart", "POST");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.requested).toBeUndefined();
    expect(body.error).toBe(STATUS_TEXT.notSaved);
    expect(await readRestartRequest(marker)).toBeNull();
    expect(ctx.logs.some(l => l.includes("Neustart-Marker nicht geschrieben"))).toBe(true);
  });

  test("ohne Anmeldung 401, kein Marker", async () => {
    const ctx = await setup("launchd");
    const res = await fetch(`${ctx.origin}/api/restart`, { method: "POST", headers: { origin: ctx.origin } });
    expect(res.status).toBe(401);
    expect(await readRestartRequest(ctx.marker)).toBeNull();
  });

  test("ohne Origin oder mit fremdem Origin 403, kein Marker", async () => {
    const ctx = await setup("launchd");
    const none = await fetch(`${ctx.origin}/api/restart`, { method: "POST", headers: { cookie: ctx.cookie } });
    expect(none.status).toBe(403);
    const foreign = await ctx.api("/api/restart", "POST", undefined, { origin: "http://evil.example" });
    expect(foreign.status).toBe(403);
    expect(await readRestartRequest(ctx.marker)).toBeNull();
  });

  test("falsche Methode 405, kein Marker", async () => {
    const ctx = await setup("launchd");
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await ctx.api("/api/restart", method);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
    expect(await readRestartRequest(ctx.marker)).toBeNull();
  });
});

describe("Motoren auf der Statusseite (Issue #126)", () => {
  test("Akzeptanz: „nicht angemeldet\" aus der Prüf-Attrappe, je Motor installiert, angemeldet, Version", async () => {
    const asked: EngineId[] = [];
    const ctx = await setup("launchd", {
      inspectEngine: async (id): Promise<EngineStatus> => {
        asked.push(id);
        if (id === "opencode") return { engine: "opencode", checked: true, installed: true, loggedIn: true, version: "1.18.33" };
        if (id === "api") return { engine: "api", checked: true, installed: true, loggedIn: false, message: API_KEY_MISSING };
        return id === "codex"
          ? { engine: "codex", checked: true, installed: true, loggedIn: false, version: "0.155.1", message: CODEX_NOT_LOGGED_IN }
          : { engine: "claude", checked: true, installed: true, loggedIn: true, version: "2.1.281" };
      },
    });
    const body = await (await ctx.api("/api/status")).json();
    expect(asked.sort()).toEqual(["api", "claude", "codex", "opencode"]);
    expect(body.engines.map(({ tools, ...availability }: any) => { expect(tools).toBeNull(); return availability; })).toEqual([
      { engine: "claude", label: "Claude Code", installed: true, loggedIn: true, version: "2.1.281" },
      { engine: "codex", label: "Codex", installed: true, loggedIn: false, version: "0.155.1", message: CODEX_NOT_LOGGED_IN },
      { engine: "opencode", label: "OpenCode", installed: true, loggedIn: true, version: "1.18.33" },
      { engine: "api", label: "Anthropic API", installed: true, loggedIn: false, message: API_KEY_MISSING },
    ]);
  });

  test("nicht feststellbare Anmeldung ist null, nie „angemeldet\"; nicht installiert ohne Version; Fehler je Motor", async () => {
    const ctx = await setup("launchd", {
      inspectEngine: async (id): Promise<EngineStatus> => {
        if (id === "codex") throw new Error("kaputt");
        if (id === "opencode") return { engine: "opencode", checked: true, installed: false, loggedIn: false, message: "OpenCode ist nicht installiert" };
        if (id === "api") return { engine: "api", checked: true, installed: true, loggedIn: true };
        return { engine: "claude", checked: true, installed: true, loggedIn: false, loginUnknown: true, version: "2.1.281", message: CLAUDE_LOGIN_UNKNOWN };
      },
    });
    const body = await (await ctx.api("/api/status")).json();
    expect(body.engines.map(({ tools, ...availability }: any) => { expect(tools).toBeNull(); return availability; })).toEqual([
      { engine: "claude", label: "Claude Code", installed: true, loggedIn: null, version: "2.1.281", message: CLAUDE_LOGIN_UNKNOWN },
      { engine: "codex", label: "Codex", installed: false, loggedIn: false, message: "Codex ließ sich nicht prüfen" },
      { engine: "opencode", label: "OpenCode", installed: false, loggedIn: false, message: "OpenCode ist nicht installiert" },
      { engine: "api", label: "Anthropic API", installed: true, loggedIn: true },
    ]);
  });

  test("Port ohne engines: null", async () => {
    const status = createBotStatus({}, { gitHead: async () => "0fe4c19", readPackageJson: () => "{}", detectSupervisor: async () => null, listSessions: async () => [] });
    const { engines: _engines, ...withoutEngines } = status;
    const ctx = await topicServer(root, servers, null, { status: withoutEngines });
    expect((await (await ctx.api("/api/status")).json()).engines).toBeNull();
  });
});

const exampleInventory = (): ToolInventory => ({ mcp: [{ name: "dateien", origin: "tybo" }],
  skills: [{ name: "gruss", origin: "engine" }], notes: "passed", state: "ok" });
const exampleGaps = (): ToolGaps => ({ mcp: [{ name: safeMcpName("mein server"), reason: "invalid_name" }],
  hints: [{ name: "nurtybo", reason: "secret_in_url" }],
  skills: [{ name: safeSkillName("mein skill"), reason: "name" }], notes: false, plugins: 2, fixed: ["connectors", "plugins"] });
const exampleSnapshot = (): ToolParitySnapshot => ({ inventory: exampleInventory, gaps: exampleGaps });

describe("Werkzeuge in GET /api/status", () => {
  test("je Motor geprüfte Form, Texte je Eintrag und feste Lücken als Objekte; ein Snapshot je Abruf", async () => {
    let reads = 0;
    const ctx = await setup("launchd", { toolParity: () => { reads++; return exampleSnapshot(); } });
    const body = await (await ctx.api("/api/status")).json();
    expect(reads).toBe(1);
    expect(body.engines).toHaveLength(4);
    for (const engine of body.engines) {
      const tools = engine.tools;
      expect(tools.inventory).toEqual(exampleInventory());
      expect(tools.gaps).toEqual(toolGapsResponse(exampleGaps()));
      for (const list of [tools.gaps.mcp, tools.gaps.hints, tools.gaps.skills]) for (const entry of list) {
        expect(Object.keys(entry).sort()).toEqual(["name", "reason", "text"]);
        expect(entry.text).toBe(TOOL_GAP_TEXT[entry.reason as keyof typeof TOOL_GAP_TEXT]);
      }
      for (const entry of tools.gaps.fixed) {
        expect(Object.keys(entry).sort()).toEqual(["id", "text"]);
        expect(TOOL_GAP_IDS).toContain(entry.id);
        expect(entry.text).toBe(TOOL_GAP_TEXT[entry.id as keyof typeof TOOL_GAP_TEXT]);
      }
    }
    expect(exampleGaps().fixed).toEqual(["connectors", "plugins"]);
  });

  test("Fehler je Motor macht nur dessen tools null; Verfügbarkeit und übriger Status bleiben", async () => {
    const ctx = await setup("launchd", { toolParity: () => ({ ...exampleSnapshot(), inventory: engine => {
      if (engine === "codex") throw new Error("ERFUNDENE_PRIVATE_FEHLERMELDUNG");
      return exampleInventory();
    } }) });
    const body = await (await ctx.api("/api/status")).json();
    expect(body.running).toEqual({ executions: 1, claudeCalls: 1 });
    expect(body.version).toEqual({ app: "2.12.0", commit: "0fe4c19" });
    for (const engine of body.engines) {
      expect(engine.installed).toBe(true); expect(engine.loggedIn).toBe(true);
      if (engine.engine === "codex") expect(engine.tools).toBeNull(); else expect(engine.tools).not.toBeNull();
    }
    expect(JSON.stringify(body)).not.toContain("ERFUNDENE_PRIVATE_FEHLERMELDUNG");
  });

  test("Einträge außerhalb der Mengen und fremde Texte entfallen einzeln, Zusatzfelder verlassen die Antwort nicht", async () => {
    const tools: any = { inventory: exampleInventory(), gaps: toolGapsResponse(exampleGaps()), secret: SECRET };
    for (const field of ["mcp", "skills"]) tools.inventory[field].push(
      { name: "https://privat.invalid", origin: "engine" }, { name: "falsche-herkunft", origin: "extern" },
      { name: "zeilenende\n", origin: "engine" }, { name: "x".repeat(65), origin: "engine" });
    for (const field of ["mcp", "hints", "skills"]) {
      const valid = tools.gaps[field][0];
      tools.gaps[field].push({ ...valid, reason: "fremd" }, { ...valid, text: SECRET }, { ...valid, name: "mein name" },
        { ...valid, reason: field === "skills" ? "invalid_name" : "head", text: field === "skills" ? TOOL_GAP_TEXT.invalid_name : TOOL_GAP_TEXT.head });
      valid.env = { ERFUNDENE_VARIABLE: SECRET };
      valid.path = "/privater/pfad";
    }
    tools.gaps.fixed.push("connectors", { id: "fremd", text: SECRET }, { id: "hooks", text: SECRET });
    tools.gaps.fixed[0].secret = SECRET;
    const rawEngine = { engine: "codex", label: "Codex", installed: true, loggedIn: true, tools };
    const demo = createDemoStatus();
    const ctx = await topicServer(root, servers, null, { status: { ...demo, engines: async () => [rawEngine] } });
    const body = await (await ctx.api("/api/status")).json();
    expect(body.engines[0].tools).toEqual({ inventory: exampleInventory(), gaps: toolGapsResponse(exampleGaps()) });
    for (const marker of [SECRET, "ERFUNDENE_VARIABLE", "https://", "/privater/pfad"]) expect(JSON.stringify(body)).not.toContain(marker);
  });

  test("höchstens 100 gültige Einträge je Liste, Zahlen ganzzahlig; ungültiger Gesamtzustand wird null", () => {
    const tools: any = { inventory: exampleInventory(), gaps: toolGapsResponse(exampleGaps()) };
    for (const field of ["mcp", "skills"]) tools.inventory[field] = Array.from({ length: 105 }, (_, i) => ({ name: `skill-${i}`, origin: "engine" }));
    for (const field of ["mcp", "hints", "skills"]) tools.gaps[field] = Array.from({ length: 105 }, (_, i) => ({ ...tools.gaps[field][0], name: `name-${i}` }));
    tools.gaps.fixed = Array.from({ length: 105 }, () => ({ id: "hooks", text: TOOL_GAP_TEXT.hooks }));
    const engine: StatusEngineAvailability = { engine: "codex", label: "Codex", installed: true, loggedIn: true, tools };
    const clean = statusEngine(engine).tools!;
    for (const list of [clean.inventory.mcp, clean.inventory.skills, clean.gaps.mcp, clean.gaps.hints, clean.gaps.skills, clean.gaps.fixed]) expect(list).toHaveLength(100);
    for (const value of [1.2, -1, Infinity, NaN, "2", Number.MAX_SAFE_INTEGER + 1]) {
      tools.gaps.plugins = value; expect(statusEngine(engine).tools!.gaps.plugins).toBeNull();
    }
    for (const [field, value] of [["notes", "fremd"], ["state", "fremd"]]) {
      const original = tools.inventory[field!]; tools.inventory[field!] = value;
      expect(statusEngine(engine).tools).toBeNull(); tools.inventory[field!] = original;
    }
    tools.gaps.notes = "ja"; expect(statusEngine(engine).tools).toBeNull();
  });

  test("Demo-Antwort besteht dieselbe Prüfung unverändert und hat Codex-Hinweise und OpenCode-Lücken", async () => {
    const api = createStatusApi(createDemoStatus(), () => {});
    const response = await api.get();
    expect(response.body.engines).toEqual(DEMO_STATUS_ENGINES);
    for (const engine of DEMO_STATUS_ENGINES) expect(statusEngine(engine)).toEqual(engine);
    const codex = DEMO_STATUS_ENGINES.find(s => s.engine === "codex")!.tools!;
    expect(codex.gaps.mcp.length).toBeGreaterThan(0); expect(codex.gaps.hints.length).toBeGreaterThan(0);
    expect(codex.gaps.fixed.length).toBeGreaterThanOrEqual(2);
    expect(DEMO_STATUS_ENGINES.find(s => s.engine === "opencode")!.tools!.gaps.mcp.length).toBeGreaterThan(0);
  });

  test("Echte temporäre Quellen über die Status-Verdrahtung: Ersatznamen bleiben, keine Geheimnisse aus irgendeiner Quelle", async () => {
    const base = resolve(root, `werkzeuge-${++counter}`), project = join(base, "projekt"), home = join(base, "heim"), codexHome = join(base, "codex");
    const markers = ["ERFUNDEN_ENV_STATUS", "ERFUNDEN_HEADER_STATUS", "ERFUNDEN_URL_STATUS", "ERFUNDEN_ARG_STATUS", "ERFUNDENE_VARIABLE_STATUS", "ERFUNDEN_KOPF_STATUS"];
    const secret = { command: "bun", args: ["--token", markers[3]], env: { [markers[4]!]: markers[0] },
      headers: { "X-Beispiel": markers[1] }, url: `https://privat.invalid/${markers[2]}` };
    const file = (path: string, value: unknown) => {
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    };
    const input: ToolParityInput = { skills: { root: project, home, codexHome, enabled: true }, opencodeConfig: join(base, "opencode"),
      extraFile: join(base, "extra.json"), claudeNotes: true, opencodeClaudeSkills: true,
      mcpInput: () => ({ cwd: project, sandbox: "full", baseEnv: { HOME: home } }) };
    file(join(home, ".claude.json"), { mcpServers: { benutzer: secret, "mein server": secret },
      projects: { [project]: { mcpServers: { projekt: secret }, enabledMcpjsonServers: ["geteilt"] } } });
    file(join(project, ".mcp.json"), { mcpServers: { geteilt: secret } });
    file(join(project, "config", "mcp-servers.json"), { servers: { tybo: secret } });
    file(input.extraFile!, { servers: { extra: secret } });
    file(join(project, ".claude", "settings.json"), { mcpServers: { einstellung: secret } });
    file(join(input.opencodeConfig, "opencode.json"), { mcp: { offen: secret } });
    file(join(codexHome, "config.toml"), `[mcp_servers.eigen]\ncommand="bun"\nargs=["${markers[3]}"]\n[mcp_servers.eigen.env]\n${markers[4]}="${markers[0]}"`);
    file(join(home, ".claude", "skills", "mein skill", "SKILL.md"), `---\nname: ${markers[5]}\ndescription: Erfunden.\n---\n`);
    setCodexMcpInputsForTests({ parentEnv: () => ({ HOME: home, CODEX_HOME: codexHome, MCP_CONFIG_PATH: input.extraFile }),
      projectRoot: () => project, settings: () => ({}), lookup: () => undefined, secrets: () => [] });
    setToolParityReadersForTests({ text: path => {
      if (!path.startsWith(base + sep)) throw Object.assign(new Error("fehlt"), { code: "ENOENT" });
      return readFileSync(path, "utf8");
    } });
    try {
      const snapshot = createToolParitySnapshot(input);
      const internal = snapshot.gaps("codex");
      const ctx = await setup("launchd", { toolParity: () => snapshot });
      const body = await (await ctx.api("/api/status")).json();
      const codex = body.engines.find((s: any) => s.engine === "codex").tools;
      expect(codex.gaps.mcp).toContainEqual({ name: safeMcpName("mein server"), reason: "invalid_name", text: TOOL_GAP_TEXT.invalid_name });
      expect(codex.gaps.skills).toContainEqual({ name: safeSkillName("mein skill"), reason: "name", text: TOOL_GAP_TEXT.name });
      expect(internal.fixed.every(id => typeof id === "string")).toBe(true);
      const visible = JSON.stringify(body.engines);
      for (const marker of [...markers, "https://", base, "X-Beispiel", "mein server", "mein skill"]) expect(visible).not.toContain(marker);
    } finally { setToolParityReadersForTests(null); setCodexMcpInputsForTests(null); }
  });
});
