/** M14-11: nur Planung und Dateileser, keine CLI, keine MCP-Prozesse, keine privaten Dateien. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCredentialCacheForTests } from "../src/lib/credentials";
import { secretShaped } from "../src/lib/engines/codex";
import { setSettingsPath } from "../src/lib/settings";
import { isProtectedSubprocessVar } from "../src/lib/subprocess-env";
import { applyCodexMcpEnv, codexMcpHeaderVar, currentCodexMcpPlan, planCodexMcp,
  readCodexMcpSources, readCodexOwnMcpNames, safeMcpName, setCodexMcpInputsForTests, setCodexMcpReaderForTests,
  type CodexMcpEntry, type CodexMcpInput, type CodexMcpPlan, type CodexMcpSkipReason, type CodexMcpSource } from "../src/lib/engines/codex-mcp";

const BASE = { TYBO_SUBPROCESS: "1", TYBO_CHAT_ID: "-1001", TYBO_TOPIC_ID: "5", HOME: "/beispiel/heim", PATH: "/bin" };
const EXAMPLE: CodexMcpEntry[] = [
  { name: "suche", source: "tybo", config: { type: "http", url: "https://mcp.suche.example/v2/mcp",
    headers: { Authorization: "Bearer ${BEISPIEL_SUCHE_KEY}", "X-Team": "werkstatt" } } },
  { name: "dateien", source: "claude-user", config: { type: "stdio", command: "bun", args: ["run", "/opt/beispiel/mcp-dateien.ts"],
    env: { BEISPIEL_DATEIEN_KEY: "${BEISPIEL_DATEIEN_KEY}", BEISPIEL_MODUS: "lesen" } } },
  { name: "stimme", source: "claude-user", config: { type: "http", url: "https://mcp.stimme.example/mcp" } },
  { name: "alt", source: "claude-user", config: { type: "sse", url: "https://mcp.alt.example/sse" } },
  { name: "wetter", source: "claude-user", config: { command: "npx", args: ["-y", "wetter-mcp", "--api-key", "abc123beispiel"] } },
];
const EXAMPLE_ENV = {
  TYBO_MCP_SUCHE_BEARER_TOKEN: "such-wert-0001", TYBO_MCP_SUCHE_HEADER_X_TEAM_TOKEN: "werkstatt",
  BEISPIEL_DATEIEN_KEY: "datei-wert-0002", BEISPIEL_MODUS: "lesen",
};
const LOOKUP: Record<string, string> = { BEISPIEL_SUCHE_KEY: "such-wert-0001", BEISPIEL_DATEIEN_KEY: "datei-wert-0002" };
const PROTECTED = ["WEB_PASSWORD", "WEB_PUSH_PRIVATE_KEY", "TYBO_CHAT_ID", "TYBO_TOPIC_ID", "TYBO_CONVERSATION_ID",
  "TYBO_SUBPROCESS", "CLAUDECODE", "HOME", "PATH", "CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY", "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN_ARBEIT", "NODE_OPTIONS", "BUN_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
  "BASH_ENV", "ENV", "TYBO_JOB_ID", "OPENAI_BASE_URL", "TYBO_SUBPROCESS_ENV_ALLOW"];
function input(overrides: Partial<CodexMcpInput> = {}): CodexMcpInput {
  return { sources: EXAMPLE, own: { names: new Set(), readable: true }, settings: {}, sandbox: "full",
    baseEnv: BASE, parentEnv: {}, lookup: name => LOOKUP[name], knownSecrets: [], ...overrides };
}
function local(name: string, env: Record<string, string> = {}): CodexMcpEntry {
  return { name, source: "tybo", config: { command: "npx", args: ["beispiel-mcp"], env } };
}
function http(name: string, headers: Record<string, string> = {}): CodexMcpEntry {
  return { name, source: "tybo", config: { type: "http", url: "https://mcp.example/mcp", headers } };
}
function files(contents: Record<string, unknown>): string[] {
  const reads: string[] = [];
  setCodexMcpReaderForTests(path => {
    reads.push(path);
    if (!Object.hasOwn(contents, path)) throw Object.assign(new Error("fehlt"), { code: "ENOENT" });
    const value = contents[path];
    if (value instanceof Error) throw value;
    return typeof value === "string" ? value : JSON.stringify(value);
  });
  return reads;
}
beforeEach(() => {
  files({});
  const unexpected = (): never => { throw new Error("Echte Eingaben im Test nicht erlaubt"); };
  setCodexMcpInputsForTests({ parentEnv: unexpected, projectRoot: unexpected, settings: unexpected, lookup: unexpected, secrets: unexpected });
});
afterEach(() => {
  setCodexMcpReaderForTests(null);
  setCodexMcpInputsForTests(null);
});

describe("Hilfen ohne Änderung der bestehenden Filter und Maskierung", () => {
  test("geschützte Variablen, Codex-Ausnahme und MCP-Präfix bleiben getrennt", () => {
    for (const name of PROTECTED) expect(isProtectedSubprocessVar(name, "codex")).toBe(true);
    for (const name of ["LANG", "EXAMPLE_KEY", "TYBO_MCP_X"]) expect(isProtectedSubprocessVar(name, "codex")).toBe(false);
    expect(isProtectedSubprocessVar("OPENAI_API_KEY", "claude")).toBe(false);
    expect(isProtectedSubprocessVar("WEB_PASSWORD", "claude")).toBe(true);
  });

  test("Geheimnismuster sind bei wiederholten Aufrufen unabhängig von lastIndex", () => {
    for (const text of ["https://nutzer:passwort@example.test", "Bearer erfundener-wert", "api_key=erfundener-wert",
      "eyJtest.abc.def", "sk-erfunden123456", "ghp_erfunden123456", "a".repeat(31) + "1"]) {
      expect(secretShaped(text)).toBe(true);
      expect(secretShaped(text)).toBe(true);
    }
    expect(secretShaped("run /opt/beispiel/mcp-dateien.ts")).toBe(false);
  });
});

describe("Beispiel aus dem Issue", () => {
  test("liefert exakt Kategorien, TOML-Parameter, Umgebung und Maskierungswerte", () => {
    const plan = planCodexMcp(input());
    expect(plan).toEqual({
      passed: [{ name: "suche", kind: "http", source: "tybo" }, { name: "dateien", kind: "stdio", source: "claude-user" }],
      own: [],
      skipped: [{ name: "stimme", source: "claude-user", reason: "auth_unknown" },
        { name: "alt", source: "claude-user", reason: "transport" }, { name: "wetter", source: "claude-user", reason: "secret_in_command" }],
      args: [
        "-c", 'mcp_servers.suche.url="https://mcp.suche.example/v2/mcp"',
        "-c", 'mcp_servers.suche.bearer_token_env_var="TYBO_MCP_SUCHE_BEARER_TOKEN"',
        "-c", 'mcp_servers.suche.env_http_headers={"X-Team"="TYBO_MCP_SUCHE_HEADER_X_TEAM_TOKEN"}',
        "-c", 'mcp_servers.suche.default_tools_approval_mode="approve"',
        "-c", 'mcp_servers.dateien.command="bun"',
        "-c", 'mcp_servers.dateien.args=["run","/opt/beispiel/mcp-dateien.ts"]',
        "-c", 'mcp_servers.dateien.env_vars=["BEISPIEL_DATEIEN_KEY","BEISPIEL_MODUS"]',
        "-c", 'mcp_servers.dateien.default_tools_approval_mode="approve"',
      ],
      env: EXAMPLE_ENV, secretValues: Object.values(EXAMPLE_ENV),
    });
    for (const marker of Object.values(EXAMPLE_ENV)) expect(plan.args.join("\n")).not.toContain(marker);
    expect(applyCodexMcpEnv(BASE, plan)).toEqual({ ...BASE, ...EXAMPLE_ENV });
  });

  test("public nimmt stimme ohne Kopfzeilen und ohne zusätzliche Variable mit", () => {
    const plan = planCodexMcp(input({ settings: { public: ["stimme"] } }));
    const original = planCodexMcp(input());
    expect(plan).toEqual({ ...original,
      passed: [...original.passed, { name: "stimme", kind: "http", source: "claude-user" }],
      skipped: original.skipped.slice(1),
      args: [...original.args, "-c", 'mcp_servers.stimme.url="https://mcp.stimme.example/mcp"',
        "-c", 'mcp_servers.stimme.default_tools_approval_mode="approve"'],
    });
  });

  test("eingeschränkte Stufen schlagen alle serverbezogenen Gründe", () => {
    for (const sandbox of ["workspace-write", "read-only"] as const) {
      expect(planCodexMcp(input({ sandbox }))).toEqual({ passed: [], own: [], args: [], env: {}, secretValues: [],
        skipped: EXAMPLE.map(({ name, source }) => ({ name, source, reason: "sandbox" })),
      });
    }
  });
});

test("laufende Eingaben: tybo-Projekt getrennt vom Laufordner, CODEX_HOME und Geheimnisse ersetzbar", () => {
  const reads = files({
    "/tybo/config/mcp-servers.json": { servers: { werkzeug: { command: "npx", env: { EXAMPLE_KEY: "${MARKER}" } } } },
    "/lauf/.mcp.json": { mcpServers: { projekt: { command: "node" } } },
    "/beispiel/heim/.claude.json": { projects: { "/lauf": { enabledMcpjsonServers: ["projekt"] } } },
    "/codex-eigen/config.toml": '[profiles.arbeit.mcp_servers.werkzeug]\ncommand="eigen"',
  });
  const parentEnv = { HOME: BASE.HOME, CODEX_HOME: "/codex-eigen" };
  setCodexMcpInputsForTests({ parentEnv: () => parentEnv, projectRoot: () => "/tybo", settings: () => ({}),
    lookup: () => "testmarkierung-123", secrets: (root, env) => {
      expect(root).toBe("/tybo"); expect(env).toBe(parentEnv); return [];
    } });
  const plan = currentCodexMcpPlan({ cwd: "/lauf", baseEnv: BASE, sandbox: "full" });
  expect(plan.own).toEqual(["werkzeug"]);
  expect(plan.passed).toEqual([{ name: "projekt", kind: "stdio", source: "mcp-json" }]);
  expect(reads).toContain("/tybo/config/mcp-servers.json");
  expect(reads).toContain("/lauf/.codex/config.toml");
  expect(reads).not.toContain("/beispiel/heim/.codex/config.toml");
});

test("Standardleser nutzen GO_PROJECT_ROOT, Einstellungen, Credentials und ausschließlich die Test-.env", () => {
  const root = mkdtempSync(join(tmpdir(), "tybo-codex-mcp-"));
  const keys = ["GO_PROJECT_ROOT", "CODEX_HOME", "MCP_CONFIG_PATH", "CODEX_MCP_TEST_KEY"];
  const saved = Object.fromEntries(keys.map(name => [name, process.env[name]]));
  try {
    process.env.GO_PROJECT_ROOT = root;
    process.env.CODEX_HOME = "/codex-test";
    process.env.MCP_CONFIG_PATH = "/extra-test.json";
    process.env.CODEX_MCP_TEST_KEY = "lookup-testmarkierung-123";
    resetCredentialCacheForTests();
    const settingsPath = join(root, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ engine: { codex: { sandbox: "read-only", mcp: { skip: ["aus"], public: ["offen"] } } } }));
    writeFileSync(join(root, ".env"), "EXAMPLE_KEY=dotenv-testmarkierung-123\n");
    setSettingsPath(settingsPath);
    files({ [join(root, "config/mcp-servers.json")]: { servers: {
      lokal: { command: "node", env: { WERKZEUG_KEY: "${CODEX_MCP_TEST_KEY}" } },
      aus: { command: "node" }, eigen: { command: "node" },
    } }, "/extra-test.json": { servers: { geheim: { command: "/opt/dotenv-testmarkierung-123/node" } } },
    "/codex-test/config.toml": '[mcp_servers.eigen]\ncommand="eigen"',
    [join(BASE.HOME, ".claude.json")]: { mcpServers: { offen: { type: "http", url: "https://mcp.example/mcp" } } } });
    setCodexMcpInputsForTests(null);
    const plan = currentCodexMcpPlan({ cwd: "/lauf", baseEnv: BASE, sandbox: "full" });
    expect(plan.passed.map(s => s.name)).toEqual(["lokal", "offen"]);
    expect(plan.own).toEqual(["eigen"]);
    expect(plan.skipped).toEqual([{ name: "aus", source: "tybo", reason: "user_skip" },
      { name: "geheim", source: "extra", reason: "secret_in_command" }]);
    expect(plan.env).toEqual({ WERKZEUG_KEY: "lookup-testmarkierung-123" });
    expect(plan.args.join("\n")).not.toContain("lookup-testmarkierung-123");
  } finally {
    for (const name of keys) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
    resetCredentialCacheForTests(); setSettingsPath();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TOML: defekt sperrt alle Quellen, fehlende Dateien sperren nicht", () => {
  const sources = (["tybo", "extra", "claude-project", "mcp-json", "claude-user"] as const)
    .map(source => ({ ...local(source, { BEISPIEL_KEY: "testmarkierung-123" }), source }));
  // Bun 1.3.10 nimmt abgeschnittene Tabellenköpfe an; diese Syntaxfehler lehnt auch die Mindestversion ab.
  for (const text of ['[mcp_servers.kaputt]\ncommand =', '[mcp_servers.kaputt]\ncommand = "nicht geschlossen']) {
    expect(() => Bun.TOML.parse(text)).toThrow();
    files({ "/codex/config.toml": text });
    const own = readCodexOwnMcpNames("/codex", "/lauf");
    expect(own.readable).toBe(false);
    expect(planCodexMcp(input({ own, sources }))).toEqual({ passed: [], own: [], args: [], env: {}, secretValues: [],
      skipped: sources.map(({ name, source }) => ({ name, source, reason: "codex_config_unreadable" })),
    });
  }
  expect(readCodexOwnMcpNames("/fehlt", "/lauf").readable).toBe(true);
});

const PATHS = { projectFile: "/tybo/config/mcp-servers.json", extraFile: "/extra.json", cwd: "/arbeit/projekt", home: "/heim" };

describe("Quellen und Vorrang", () => {
  test("jede der fünf Quellen gewinnt vor allen nachfolgenden, auch ohne bun", () => {
    const order: CodexMcpSource[] = ["tybo", "extra", "claude-project", "mcp-json", "claude-user"];
    for (let start = 0; start < order.length; start++) {
      const servers = (at: number) => at < start ? {} : { gemeinsam: { command: `befehl-${at}` }, [`eigen-${at}`]: { command: "node" } };
      files({
        [PATHS.projectFile]: { servers: servers(0) },
        [PATHS.extraFile]: { mcpServers: servers(1) },
        "/heim/.claude.json": { projects: { [PATHS.cwd]: { mcpServers: servers(2), enabledMcpjsonServers: ["gemeinsam", "eigen-3"] },
          "/fremd": { mcpServers: { falsch: { command: "falsch" } } } }, mcpServers: servers(4) },
        "/arbeit/projekt/.mcp.json": { mcpServers: servers(3) },
      });
      const sources = readCodexMcpSources(PATHS);
      const plan = planCodexMcp(input({ sources }));
      expect(sources.filter(s => s.name === "gemeinsam")).toHaveLength(1);
      expect(plan.passed).toEqual([{ name: "gemeinsam", kind: "stdio", source: order[start] },
        ...order.slice(start).map((source, i) => ({ name: `eigen-${i + start}`, kind: "stdio", source }))]);
      expect(plan.args).toContain(`mcp_servers.gemeinsam.command="befehl-${start}"`);
      expect(plan.skipped).toEqual([]);
    }
  });

  test("extra akzeptiert servers, frühere ungültige Einträge fallen nicht auf spätere zurück", () => {
    files({ [PATHS.projectFile]: { servers: { doppelt: { args: [8080] } } },
      [PATHS.extraFile]: { servers: { doppelt: { command: "node" }, extra: { command: "python" } } } });
    const plan = planCodexMcp(input({ sources: readCodexMcpSources(PATHS) }));
    expect(plan.skipped).toEqual([{ name: "doppelt", source: "tybo", reason: "invalid_value" }]);
    expect(plan.passed).toEqual([{ name: "extra", source: "extra", kind: "stdio" }]);
  });

  test("Claude-Abschaltung gilt für alle drei Claude-Quellen, Zustimmung nur für mcp-json", () => {
    const local = { command: "node" };
    files({ [PATHS.projectFile]: { servers: { tybo: local } }, [PATHS.extraFile]: { servers: { extra: local } },
      "/heim/.claude.json": { projects: { [PATHS.cwd]: {
        mcpServers: { projekt: local }, disabledMcpServers: ["tybo", "extra", "projekt", "json-aus", "global"],
        enabledMcpjsonServers: ["json-aus", "ja", "widerspruch"], disabledMcpjsonServers: ["widerspruch"],
      } }, mcpServers: { global: local, projekt: local } },
      "/arbeit/projekt/.mcp.json": { mcpServers: { "json-aus": local, ja: local, nein: local, widerspruch: local } },
    });
    const plan = planCodexMcp(input({ sources: readCodexMcpSources(PATHS) }));
    expect(plan.passed.map(s => s.name)).toEqual(["tybo", "extra", "ja"]);
    expect(plan.skipped).toEqual([
      { name: "projekt", source: "claude-project", reason: "claude_disabled" },
      { name: "json-aus", source: "mcp-json", reason: "claude_disabled" },
      { name: "nein", source: "mcp-json", reason: "not_approved" },
      { name: "widerspruch", source: "mcp-json", reason: "not_approved" },
      { name: "global", source: "claude-user", reason: "claude_disabled" },
    ]);
  });

  test("die drei Einstellungsdateien liefern nur Namen, keine doppelten Einträge", () => {
    const invalidName = "https://privat.example/konto";
    const marker = "datei-testmarkierung-123";
    files({ [PATHS.projectFile]: { servers: { echt: { command: "node" } } },
      "/arbeit/projekt/.claude/settings.json": { mcpServers: { echt: { command: marker }, nurprojekt: { command: marker }, [invalidName]: {} } },
      "/arbeit/projekt/.claude/settings.local.json": { mcpServers: { nurlokal: { env: { SECRET: marker } } } },
      "/heim/.claude/settings.json": { mcpServers: { nurheim: { command: marker }, nurprojekt: {} } },
      "/arbeit/projekt/.mcp.json": { mcpServers: { ohnezustimmung: { command: "node" } } },
    });
    const sources = readCodexMcpSources(PATHS);
    expect(sources.filter(s => s.source === "claude-settings").every(s => s.config === undefined)).toBe(true);
    expect(JSON.stringify(sources)).not.toContain(marker);
    const plan = planCodexMcp(input({ sources }));
    expect(plan.passed.map(s => s.name)).toEqual(["echt"]);
    expect(plan.skipped).toEqual([
      { name: "ohnezustimmung", source: "mcp-json", reason: "not_approved" },
      ...["nurprojekt", safeMcpName(invalidName), "nurlokal", "nurheim"].map(name => ({ name, source: "claude-settings", reason: "unsupported_source" })),
    ]);
  });

  test("kaputte und fehlende JSON-Dateien geben keine Inhalte oder Parserfehler aus", () => {
    files({ [PATHS.projectFile]: '{"servers": datei-markierung-geheim', [PATHS.extraFile]: null,
      "/heim/.claude.json": Object.assign(new Error("private-markierung"), { code: "EACCES" }) });
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(readCodexMcpSources(PATHS)).toEqual([]);
      expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); error.mockRestore(); }
  });

  test("Codex-Namen aus Profilen, Laufordner, Eltern und Wurzel; jeder Pfad nur einmal", () => {
    const reads = files({
      "/arbeit/.codex/config.toml": '[mcp_servers.eltern]\ncommand="node"\n[profiles.privat.mcp_servers.profil]\ncommand="node"',
      "/arbeit/projekt/.codex/config.toml": '[mcp_servers.projekt]\nenabled=false\n[profiles.x.mcp_servers.projektprofil]\ncommand="node"',
      "/.codex/config.toml": '[mcp_servers.wurzel]\ncommand="node"',
    });
    const own = readCodexOwnMcpNames("/arbeit/.codex", PATHS.cwd);
    expect(own.readable).toBe(true);
    expect([...own.names]).toEqual(["eltern", "profil", "projekt", "projektprofil", "wurzel"]);
    expect(reads.filter(p => p === "/arbeit/.codex/config.toml")).toHaveLength(1);
    const plan = planCodexMcp(input({ own, sources: [...own.names].map(name => local(name)) }));
    expect(plan.own).toEqual([...own.names]);
    expect(plan.args).toEqual([]); expect(plan.env).toEqual({}); expect(plan.skipped).toEqual([]);
  });

  test("nur ENOENT gilt als fehlend; Lesefehler und ungültige Servertabellen sperren", () => {
    for (const value of [Object.assign(new Error("private-markierung"), { code: "EACCES" }),
      Object.assign(new Error("private-markierung"), { code: "ENOTDIR" }), 'mcp_servers = "keine Tabelle"', '[kaputt]\nwert = "nicht geschlossen']) {
      files({ "/arbeit/.codex/config.toml": value });
      const own = readCodexOwnMcpNames("/leer", PATHS.cwd);
      expect(own.readable).toBe(false);
      expect(planCodexMcp(input({ own })).args).toEqual([]);
    }
  });
});

function expectSkipped(config: unknown, reason: CodexMcpSkipReason, overrides: Partial<CodexMcpInput> = {}): CodexMcpPlan {
  const plan = planCodexMcp(input({ sources: [{ name: "probe", source: "tybo", config }], ...overrides }));
  expect(plan.skipped).toEqual([{ name: "probe", source: "tybo", reason }]);
  expect(plan.passed).toEqual([]); expect(plan.args).toEqual([]); expect(plan.env).toEqual({}); expect(plan.secretValues).toEqual([]);
  return plan;
}

describe("Einstellungen und feste Reihenfolge der Gründe", () => {
  test("disabled vor sandbox vor unlesbar vor own, own vor skip", () => {
    const sources = [local("eigen"), ...EXAMPLE];
    const own = { names: new Set(["eigen"]), readable: false };
    const cases: [Partial<CodexMcpInput>, string][] = [
      [{ settings: { enabled: false }, sandbox: "read-only", own }, "disabled"],
      [{ sandbox: "workspace-write", own }, "sandbox"], [{ own }, "codex_config_unreadable"],
    ];
    for (const [opts, reason] of cases) {
      const plan = planCodexMcp(input({ sources, ...opts }));
      expect(plan.own).toEqual([]); expect(plan.passed).toEqual([]); expect(plan.args).toEqual([]);
      expect(plan.skipped).toEqual(sources.map(({ name, source }) => ({ name, source, reason })));
    }
    const plan = planCodexMcp(input({ sources, own: { ...own, readable: true }, settings: { skip: ["eigen", "suche"] } }));
    expect(plan.own).toEqual(["eigen"]);
    expect(plan.skipped[0]).toEqual({ name: "suche", source: "tybo", reason: "user_skip" });
    expect(plan.skipped.some(s => s.name === "eigen")).toBe(false);
    expect(plan.args.join("\n")).not.toContain("mcp_servers.eigen.");
  });

  test("Name und Freigaben vor Transport, Struktur vor Geheimnisschutz", () => {
    const bad = { type: "sse", args: [8080] };
    const cases: [CodexMcpEntry, CodexMcpInput["settings"], CodexMcpSkipReason][] = [
      [{ name: "a b", source: "claude-user", config: bad }, { skip: ["a b"] }, "user_skip"],
      [{ name: "a b", source: "claude-user", config: bad, claudeDisabled: true }, {}, "invalid_name"],
      [{ name: "probe", source: "mcp-json", config: bad, claudeDisabled: true }, {}, "claude_disabled"],
      [{ name: "probe", source: "mcp-json", config: bad }, {}, "not_approved"],
      [{ name: "probe", source: "tybo", config: bad }, {}, "transport"],
      [local("probe", { WEB_PASSWORD: "mit\numbruch" }), {}, "invalid_value"],
    ];
    for (const [entry, settings, reason] of cases) {
      expect(planCodexMcp(input({ sources: [entry], settings })).skipped).toEqual([{ name: safeMcpName(entry.name), source: entry.source, reason }]);
    }
    expectSkipped({ command: "node", args: ["${KEY}"], env: { KEY: "${WEB_PASSWORD}" } }, "reserved_env");
    expectSkipped({ command: "node", args: ["${KEY}"], env: { KEY: "${UNBEKANNT}" } }, "secret_in_command");
    expectSkipped({ command: "node", env: { KEY: "${UNBEKANNT}" } }, "placeholder_unresolved", { baseEnv: { KEY: "anders" } });
  });

  test("öffentliche HTTP-Server: tybo/extra immer, alle Claude-Quellen nur ausdrücklich", () => {
    for (const source of ["tybo", "extra", "claude-project", "mcp-json", "claude-user"] as const) {
      const entry = { ...http("probe"), source, mcpJsonApproved: true };
      const plan = planCodexMcp(input({ sources: [entry] }));
      expect(plan.passed.length).toBe(source === "tybo" || source === "extra" ? 1 : 0);
      if (!plan.passed.length) expect(plan.skipped[0].reason).toBe("auth_unknown");
      expect(planCodexMcp(input({ sources: [entry], settings: { public: ["probe"] } })).passed).toHaveLength(1);
      expect(planCodexMcp(input({ sources: [entry], settings: { public: ["probe"], skip: ["probe"] } })).skipped[0].reason).toBe("user_skip");
    }
  });
});

describe("Geheimnisse und geschützte Umgebung", () => {
  test("Markierungen aus env, Kopfzeilen und lookup stehen ausschließlich in der Umgebung", () => {
    const markers = ["direkt-wert-0001", "lookup-wert-0002", "bearer-wert-0003", "kopf-wert-0004"];
    const plan = planCodexMcp(input({ sources: [local("lokal", { Z_KEY: markers[0], A_KEY: "${LOOKUP_KEY}" }),
      http("fern", { aUtHoRiZaTiOn: `bEaReR ${markers[2]}`, "X-Beispiel": markers[3] })], lookup: () => markers[1] }));
    expect(plan.passed).toHaveLength(2);
    expect(plan.args).toContain('mcp_servers.lokal.env_vars=["A_KEY","Z_KEY"]');
    expect(plan.secretValues).toEqual(markers);
    for (const marker of markers) expect(plan.args.join("\n")).not.toContain(marker);
    expect(plan.args.some(arg => /\.(env|http_headers)=/.test(arg))).toBe(false);
  });

  test("Befehl und Argumente: Platzhalter, bekannte Werte, Formen und Zugangsschalter", () => {
    const marker = "bekannter-wert-123";
    for (const config of [
      { command: "${BEFEHL}" }, { command: "$BEFEHL" }, { command: `/opt/${marker}/node` },
      ...["${KEY}", "$KEY", "${KEY:-ersatz}", "sk-erfundeneMarkierung123"].map(arg => ({ command: "node", args: [arg] })),
      ...["--token", "--api-key", "-auth", "--PASSWORD", "--credential-file", "--cookie"].map(flag => ({ command: "node", args: [flag, "kurz"] })),
    ]) expectSkipped(config, "secret_in_command", { knownSecrets: [marker] });
    expectSkipped({ command: "abcdefgh" }, "secret_in_command", { knownSecrets: ["abcdefgh"] });
    expect(planCodexMcp(input({ sources: [{ ...local("probe"), config: { command: "abcdefg" } }], knownSecrets: ["abcdefg"] })).passed).toHaveLength(1);
  });

  test("HTTP-Adressen: Platzhalter, Benutzerinfo und Schlüssel im Pfad", () => {
    for (const url of ["${ADRESSE}", "https://mcp.example/${KEY}", "https://mcp.example/$KEY", "https://name:passwort@mcp.example/mcp",
      "https://name@mcp.example/mcp", "https://mcp.example/geheim-im-pfad", "https://mcp.example/sk-erfundeneMarkierung123"]) {
      expectSkipped({ type: "http", url }, "secret_in_url", { knownSecrets: ["geheim-im-pfad"] });
    }
    for (const url of ["ftp://mcp.example/mcp", "file:///tmp/mcp", "keine Adresse", "", "https://", "https:mcp.example", " https://mcp.example"]) {
      expectSkipped({ type: "http", url }, "invalid_value");
    }
  });

  test("jeder geschützte Name und das gesamte MCP-Präfix sind für eingelesenes env gesperrt", () => {
    for (const name of [...PROTECTED, "TYBO_MCP_X", "TYBO_MCP_SUCHE_BEARER_TOKEN"]) {
      const marker = "datei-testmarkierung-123";
      const plan = expectSkipped({ command: "node", env: { [name]: marker } }, "reserved_env");
      expect(JSON.stringify(plan)).not.toContain(marker);
    }
  });

  test("geschützte Referenzen werden vor unbekannten Platzhaltern abgelehnt und nie nachgeschlagen", () => {
    const lookup = (): never => { throw new Error("Geschützter Name darf nicht nachgeschlagen werden"); };
    for (const value of ["${WEB_PASSWORD}", "${TELEGRAM_BOT_TOKEN}", "${WEB_PUSH_PRIVATE_KEY}", "${TYBO_CHAT_ID}",
      "${CLAUDECODE}", "${CODEX_API_KEY}", "${OPENAI_API_KEY}", "${TELEGRAM_BOT_TOKEN_ARBEIT}", "${WEB_PASSWORD:-ersatz}", "$WEB_PASSWORD"]) {
      expectSkipped({ type: "http", url: "https://mcp.example/mcp", headers: { Authorization: `Bearer ${value}` } }, "reserved_env", { lookup });
      expectSkipped({ command: "node", env: { ALIAS: value } }, "reserved_env", { lookup });
      expectSkipped({ type: "http", url: `https://mcp.example/${value}` }, "reserved_env", { lookup });
    }
  });

  test("Bot-Geheimnisse unter anderem Namen, auch Authorization ohne Bearer-Anfang verglichen", () => {
    const marker = "bot-testmarkierung-123";
    for (const name of ["WEB_PASSWORD", "WEB_PUSH_PRIVATE_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_ARBEIT"]) {
      const opts = { parentEnv: { [name]: marker }, lookup: () => marker };
      expectSkipped({ command: "node", env: { ALIAS: marker } }, "reserved_env", opts);
      expectSkipped({ command: "node", env: { ALIAS: "${ALIAS_KEY}" } }, "reserved_env", opts);
      for (const value of [marker, `Bearer ${marker}`, "Bearer ${ALIAS_KEY}"]) {
        expectSkipped({ type: "http", url: "https://mcp.example/mcp", headers: { Authorization: value } }, "reserved_env", opts);
      }
    }
  });

  test("CLAUDECODE=1, Gesprächsnummer und HOME sind keine Geheimniswerte", () => {
    const plan = planCodexMcp(input({ sources: [local("probe", { DEBUG: "1", PORT: "5", ORDNER: "/beispiel/heim", LEER: "" })],
      parentEnv: { CLAUDECODE: "1", TYBO_TOPIC_ID: "5", HOME: "/beispiel/heim", WEB_PASSWORD: "" } }));
    expect(plan.passed).toHaveLength(1); expect(plan.skipped).toEqual([]);
  });

  test("unbekannte und Claude-Standardplatzhalter bleiben ungelöst", () => {
    for (const value of ["${UNBEKANNT}", "${NAME:-ersatz}", "${}", "${OFFEN"]) {
      expectSkipped({ command: "node", env: { EXAMPLE_KEY: value } }, "placeholder_unresolved");
      expectSkipped({ type: "http", url: "https://mcp.example/mcp", headers: { "X-Key": value } }, "placeholder_unresolved");
    }
    expectSkipped({ command: "node", env: { EXAMPLE_KEY: "${NAME:-ersatz}" } }, "placeholder_unresolved", { lookup: () => "niemals-standard-auflösen" });
    expectSkipped({ command: "node", env: { EXAMPLE_KEY: "${NAME}" } }, "placeholder_unresolved", { lookup: () => "${NOCH_EINER}" });
  });
});

describe("Werte, Namen und Konflikte", () => {
  test("fehlerhafte Typen und Steuerzeichen werden vollständig abgelehnt", () => {
    for (const config of [null, [], "text", {}, { type: "unbekannt", command: "node" }, { command: "" }, { command: " " },
      { type: "http" }, { command: 1 }, { command: "node", args: ["--port", 8080] }, { command: "node", args: "argument" },
      { command: "node", env: { MODUS: 5 } }, { command: "node", env: [] }, { command: "node", env: null },
      { command: "node", env: { "KEIN-NAME": "x" } }, { command: "node", env: { "1_NAME": "x" } },
      { type: "http", url: "https://mcp.example", headers: { "X-Key": 7 } },
      { type: "http", url: "https://mcp.example", headers: { Authorization: "Bearer " } }]) expectSkipped(config, "invalid_value");
    for (const control of ["\u0000", "\t", "\n", "\r", "\u001f", "\u007f"]) {
      for (const config of [{ command: `no${control}de` }, { command: "node", args: [`arg${control}`] },
        { command: "node", env: { EXAMPLE_KEY: `wert${control}` } }, { command: "node", env: { [`NAME${control}`]: "wert" } },
        { type: "http", url: `https://mcp.example/${control}` },
        { type: "http", url: "https://mcp.example", headers: { [`X-${control}Name`]: "wert" } },
        { type: "http", url: "https://mcp.example", headers: { "X-Key": `wert${control}` } }]) expectSkipped(config, "invalid_value");
      expectSkipped({ command: "node", env: { KEY: "${KEY}" } }, "invalid_value", { lookup: () => `wert${control}` });
    }
  });

  test("Anführungszeichen, Rückstriche, Unicode und Kopfzeilentabellen sind gültiges TOML", () => {
    const command = 'C:\\werkzeuge\\suche"neu';
    const args = ['Zitat "ja"', 'Rueck\\strich', "Grüße"];
    const header = 'X-"Ort\\Test';
    const plan = planCodexMcp(input({ sources: [{ ...local("probe"), config: { command, args } }, http("fern", { [header]: "testmarkierung-123" })] }));
    expect(plan.passed).toHaveLength(2);
    const values = new Map(plan.args.filter((_, i) => i % 2 === 1).map(arg => {
      const at = arg.indexOf("=");
      return [arg.slice(0, at), (Bun.TOML.parse(`v = ${arg.slice(at + 1)}`) as { v: unknown }).v];
    }));
    expect(values.get("mcp_servers.probe.command")).toBe(command);
    expect(values.get("mcp_servers.probe.args")).toEqual(args);
    expect(values.get("mcp_servers.fern.env_http_headers")).toEqual({ [header]: codexMcpHeaderVar("fern", header) });
    expect(applyCodexMcpEnv(BASE, plan)[codexMcpHeaderVar("fern", header)]).toBe("testmarkierung-123");
  });

  test("unzulässige Namen sind bei jedem Grund und in own stabil ersetzt", () => {
    const names = ["mit abstand", "mit\numbruch", "https://privat.example/konto", "x".repeat(65), "punkt.name", "abschluss\n"];
    const hashes = new Set<string>();
    for (const name of names) {
      const safe = safeMcpName(name);
      expect(safe).toMatch(/^unzulaessig-[a-f0-9]{8}$/); hashes.add(safe);
      const entry = local(name);
      const plans = [planCodexMcp(input({ sources: [entry] })), planCodexMcp(input({ sources: [entry] })),
        planCodexMcp(input({ sources: [entry], settings: { enabled: false } })),
        planCodexMcp(input({ sources: [entry], sandbox: "read-only" })),
        planCodexMcp(input({ sources: [entry], own: { names: new Set(), readable: false } })),
        planCodexMcp(input({ sources: [entry], settings: { skip: [name] } })),
        planCodexMcp(input({ sources: [{ name, source: "claude-settings" }] })),
        planCodexMcp(input({ sources: [entry], own: { names: new Set([name]), readable: true } })),
      ];
      for (const plan of plans) {
        expect(JSON.stringify(plan)).not.toContain(JSON.stringify(name).slice(1, -1));
        expect([...plan.own, ...plan.skipped.map(s => s.name)]).toEqual([safe]);
      }
      expect(plans[0].skipped[0].reason).toBe("invalid_name"); expect(plans[0]).toEqual(plans[1]);
      expect(plans.at(-1)!.skipped).toEqual([]);
    }
    expect(hashes.size).toBe(names.length);
    expect(safeMcpName("mit abstand")).toBe("unzulaessig-1517364b");
    for (const name of ["suche", "A-b_1", "x".repeat(64)]) expect(safeMcpName(name)).toBe(name);
  });

  test("eigener unzulässiger TOML-Name wird vor der Maskierung abgeglichen", () => {
    const name = "adresse mit abstand";
    files({ "/codex/config.toml": `[mcp_servers.${JSON.stringify(name)}]\ncommand="node"` });
    const own = readCodexOwnMcpNames("/codex", "/lauf");
    expect(own.names.has(name)).toBe(true);
    const plan = planCodexMcp(input({ own, sources: [local(name)] }));
    expect(plan.own).toEqual([safeMcpName(name)]); expect(plan.skipped).toEqual([]); expect(plan.args).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(name);
  });

  test("geteiltes lokales env: gleiche Werte erlaubt, andere Werte verwerfen den ganzen späteren Server", () => {
    const first = local("eins", { SHARED: "testmarkierung-123" });
    const second = local("zwei", { NEU: "darf-nicht-bleiben", SHARED: "anders-456" });
    const plan = planCodexMcp(input({ sources: [first, second] }));
    expect(plan.passed.map(s => s.name)).toEqual(["eins"]);
    expect(plan.skipped).toEqual([{ name: "zwei", source: "tybo", reason: "env_conflict" }]);
    expect(plan.env).toEqual({ SHARED: "testmarkierung-123" }); expect(plan.args.join("\n")).not.toContain("mcp_servers.zwei");
    expect(planCodexMcp(input({ sources: [first, local("zwei", { SHARED: "testmarkierung-123" })] })).passed).toHaveLength(2);
    expect(planCodexMcp(input({ sources: [first], baseEnv: { SHARED: "testmarkierung-123" } })).passed).toHaveLength(1);
    expect(planCodexMcp(input({ sources: [first], baseEnv: { SHARED: "anders" } })).skipped[0].reason).toBe("env_conflict");
  });

  test("gebildete Kopfzeilen-Variablen: Kollisionen zwischen und innerhalb von Servern, auch bei gleichen Werten", () => {
    for (const secondValue of ["testmarkierung-123", "anders-456"]) {
      const plan = planCodexMcp(input({ sources: [http("a-b", { Authorization: "Bearer testmarkierung-123" }),
        http("a_b", { Authorization: `Bearer ${secondValue}` })] }));
      expect(plan.passed.map(s => s.name)).toEqual(["a-b"]);
      expect(plan.skipped).toEqual([{ name: "a_b", source: "tybo", reason: "env_conflict" }]);
      expectSkipped({ type: "http", url: "https://mcp.example", headers: { "X-Team": "testmarkierung-123", X_Team: secondValue } }, "env_conflict");
    }
    const variable = codexMcpHeaderVar("probe");
    const sources = [http("probe", { Authorization: "Bearer testmarkierung-123" })];
    const plan = planCodexMcp(input({ sources, baseEnv: { [variable]: "anders-456" } }));
    expect(plan.skipped[0].reason).toBe("env_conflict"); expect(plan.env).toEqual({});
    const equal = planCodexMcp(input({ sources, baseEnv: { [variable]: "testmarkierung-123" } }));
    expect(equal.passed).toHaveLength(1);
    expect(applyCodexMcpEnv({ [variable]: "testmarkierung-123" }, equal)[variable]).toBe("testmarkierung-123");
  });
});

describe("zweite Prüfung beim Anwenden", () => {
  function hand(env: Record<string, string>, args: string[] = [], passed: CodexMcpPlan["passed"] = []): CodexMcpPlan {
    return { passed, own: [], skipped: [], args, env, secretValues: Object.values(env) };
  }
  function rejects(plan: CodexMcpPlan, base = BASE): void {
    let error: unknown;
    try { applyCodexMcpEnv(base, plan); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Ungültige MCP-Umgebung");
    for (const [name, value] of Object.entries(plan.env)) {
      expect((error as Error).message).not.toContain(name);
      expect((error as Error).message).not.toContain(value);
    }
  }
  const passed: CodexMcpPlan["passed"] = [{ name: "suche", kind: "http", source: "tybo" }];

  test("geschützte Namen und abweichende Basiswerte lassen auch handgebaute Pläne scheitern", () => {
    for (const name of PROTECTED) rejects(hand({ [name]: "testmarkierung-123" }));
    rejects(hand({ PATH: "/falscher-pfad" }));
    rejects(hand({ TYBO_CHAT_ID: "falsches-ziel" }));
    rejects(hand({ EIGEN: "testmarkierung-123" }), { ...BASE, EIGEN: "vorher" });
    const base = { ...BASE, TYBO_CONVERSATION_ID: "gespraech" };
    const plan = planCodexMcp(input({ baseEnv: base }));
    const result = applyCodexMcpEnv(base, plan);
    for (const [name, value] of Object.entries(base)) expect(result[name]).toBe(value);
    expect(base).toEqual({ ...BASE, TYBO_CONVERSATION_ID: "gespraech" });
  });

  test("Authorization ohne Bearer nutzt ausschließlich die geprüfte Kopfzeilen-Tabelle", () => {
    const plan = planCodexMcp(input({ sources: [http("suche", { Authorization: "Basic erfundeneMarkierung" })] }));
    const variable = codexMcpHeaderVar("suche", "Authorization");
    expect(plan.passed).toEqual(passed);
    expect(plan.args).toContain(`mcp_servers.suche.env_http_headers={"Authorization"="${variable}"}`);
    expect(applyCodexMcpEnv(BASE, plan)[variable]).toBe("Basic erfundeneMarkierung");
  });

  test("Grenzen der Präfix-Ausnahme: fehlender Verweis, fremder oder lokaler Server, falsche Namen", () => {
    const value = "testmarkierung-123";
    rejects(hand({ TYBO_MCP_X: value }));
    const bearer = codexMcpHeaderVar("suche");
    rejects(hand({ [bearer]: value }, ["-c", `mcp_servers.suche.bearer_token_env_var="${bearer}"`]));
    rejects(hand({ [bearer]: value }, ["-c", `mcp_servers.suche.env_vars=["${bearer}"]`], [{ ...passed[0], kind: "stdio" }]));
    rejects(hand({ [bearer]: value }, ["-c", `mcp_servers.suche.bearer_token_env_var="${bearer}"`], [{ ...passed[0], kind: "stdio" }]));
    const other = codexMcpHeaderVar("anderer");
    rejects(hand({ [other]: value }, ["-c", `mcp_servers.suche.bearer_token_env_var="${other}"`], passed));
    const wrongHeader = codexMcpHeaderVar("suche", "X-Anderer");
    rejects(hand({ [wrongHeader]: value }, ["-c", `mcp_servers.suche.env_http_headers={"X-Team"="${wrongHeader}"}`], passed));
    rejects(hand({ [bearer]: value }, ["-c", `mcp_servers.suche.env_vars=["${bearer}"]`], passed));
  });

  test("nur gültige -c-Paare belegen die Ausnahme; spätere Zuweisungen ersetzen frühere", () => {
    const variable = codexMcpHeaderVar("suche");
    const valid = `mcp_servers.suche.bearer_token_env_var="${variable}"`;
    for (const args of [[valid], ["-c", valid + " ungueltiges TOML"], ["-c", valid + '\nweiter="inhalt"'],
      ["-c", `mcp_servers.suche.bearer_token_env_var\n="${variable}"`],
      ["-c", valid, "-c", 'mcp_servers.suche.bearer_token_env_var="anderer"']]) {
      rejects(hand({ [variable]: "testmarkierung-123" }, args, passed));
    }
  });
});

test("Planung ist deterministisch und verändert weder Quellen noch Umgebungen", () => {
  const original = input();
  const before = JSON.stringify(original);
  const first = planCodexMcp(original);
  expect(planCodexMcp(original)).toEqual(first);
  expect(JSON.stringify(original)).toBe(before);
});

test("Quellenleser kann seinen Textleser je Abruf erhalten, ohne globale Änderung", () => {
  const sources = readCodexMcpSources({ projectFile: "/beispiel/mcp.json", cwd: "/beispiel", home: "" }, {
    text: path => {
      if (path === "/beispiel/mcp.json") return '{"servers":{"beispiel":{"command":"bun"}}}';
      throw Object.assign(new Error("fehlt"), { code: "ENOENT" });
    },
  });
  expect(sources).toEqual([{ name: "beispiel", source: "tybo", config: { command: "bun" } }]);
});
