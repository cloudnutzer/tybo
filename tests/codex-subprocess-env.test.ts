/**
 * Issue #124, Aufgabe 2: Umgebung für Codex-Subprozesse. MCP-Verweise kommen
 * aus der config.toml von Codex (CODEX_HOME vor ~/.codex), Geheimnisse
 * bleiben draußen. Alle Konfigurationen liegen in Temp-Verzeichnissen; die
 * echte ~/.codex/config.toml und ~/.claude.json werden nie gelesen.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { codexEnv, createCodexEngine } from "../src/lib/engines/codex";
import { setSettingsPath } from "../src/lib/settings";
import {
  codexHomeDir,
  codexMcpReferencedVars,
  filterSubprocessEnv,
  logSubprocessEnvFilter,
  setMcpReaderForTests,
  setSubprocessEnvLoggerForTests,
} from "../src/lib/subprocess-env";
import { ev, installCodexFake } from "./codex-fixture";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tybo-codexenv-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  setMcpReaderForTests(null);
});

let home: string;
let project: string;
beforeEach(() => {
  setMcpReaderForTests(null);
  home = tmp();
  project = tmp();
});

const BOT_ENV: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/test",
  LANG: "de_DE.UTF-8",
  TELEGRAM_BOT_TOKEN: "123:geheim-telegram",
  TELEGRAM_BOT_TOKEN_RESEARCH: "456:geheim-research",
  TELEGRAM_USER_ID: "4711",
  SUPABASE_SERVICE_ROLE_KEY: "geheim-supabase",
  WEB_PASSWORD: "geheim-web",
  OPENAI_API_KEY: "geheim-openai",
  CODEX_API_KEY: "geheim-codex",
  ANTHROPIC_API_KEY: "geheim-anthropic",
  NOTION_TOKEN: "geheim-notion",
  LINEAR_API_KEY: "geheim-linear",
  GITHUB_PAT_TOKEN: "geheim-github",
  CLAUDECODE: "1",
};

/** Schreibt config.toml mit eindeutiger Änderungszeit (Zwischenspeicher nach mtime und Größe) */
let tick = 1_000;
function writeToml(dir: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.toml");
  writeFileSync(file, content);
  tick += 10;
  utimesSync(file, tick, tick);
}

const CONFIG = `
model = "gpt-5.5-codex"

[mcp_servers.notion]
command = "bunx"
args = ["notion-mcp"]
env_vars = ["NOTION_TOKEN", "kein gültiger Name"]

[mcp_servers.linear]
command = "linear-mcp"
env = { LINEAR = "\${LINEAR_API_KEY}", MODUS = "fest" }

[mcp_servers.github]
url = "https://mcp.example.test/github"
bearer_token_env_var = "GITHUB_PAT_TOKEN"

[mcp_servers.gefaehrlich]
command = "x"
env_vars = ["OPENAI_API_KEY", "CODEX_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_RESEARCH", "WEB_PASSWORD"]
`;

function codex(env: Record<string, string>, extra: Partial<Parameters<typeof filterSubprocessEnv>[0]> = {}) {
  return filterSubprocessEnv({ env, cwd: project, home, engine: "codex", ...extra });
}

describe("config.toml von Codex", () => {
  test("liest env_vars, ${VAR} in env, bearer_token_env_var und env_http_headers", () => {
    const dir = join(home, ".codex");
    writeToml(dir, CONFIG + `
[mcp_servers.http]
url = "https://mcp.example.test/x"
env_http_headers = { "X-Api-Key" = "HTTP_HEADER_KEY" }
`);
    expect([...codexMcpReferencedVars(dir)].sort()).toEqual([
      "CODEX_API_KEY", "GITHUB_PAT_TOKEN", "HTTP_HEADER_KEY", "LINEAR_API_KEY", "NOTION_TOKEN", "OPENAI_API_KEY",
      "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_RESEARCH", "WEB_PASSWORD",
    ]);
  });

  test("feste env-Werte, Befehl, Argumente und andere Abschnitte zählen nicht", () => {
    const dir = join(home, ".codex");
    writeToml(dir, `
command_var = "$SONST_TOKEN"
[mcp_servers.a]
command = "$BEFEHL_TOKEN"
args = ["\${ARG_TOKEN}"]
env = { WERT = "FEST_TOKEN" }
[profiles.x]
env_vars = ["PROFIL_TOKEN"]
`);
    expect([...codexMcpReferencedVars(dir)]).toEqual([]);
  });

  test("fehlende, leere und defekte Datei tragen nichts bei, ohne Fehler", () => {
    expect([...codexMcpReferencedVars(join(home, "gibt-es-nicht"))]).toEqual([]);
    expect([...codexMcpReferencedVars("")]).toEqual([]);
    const dir = join(home, ".codex");
    writeToml(dir, "");
    expect([...codexMcpReferencedVars(dir)]).toEqual([]);
    writeToml(dir, "[mcp_servers.kaputt\ncommand = ");
    expect([...codexMcpReferencedVars(dir)]).toEqual([]);
    writeToml(dir, 'mcp_servers = "kein Abschnitt"');
    expect([...codexMcpReferencedVars(dir)]).toEqual([]);
    const { env } = codex(BOT_ENV);
    expect(env.NOTION_TOKEN).toBeUndefined();
  });

  test("CODEX_HOME hat Vorrang vor ~/.codex", () => {
    writeToml(join(home, ".codex"), '[mcp_servers.a]\nenv_vars = ["NOTION_TOKEN"]');
    const own = tmp();
    writeToml(own, '[mcp_servers.b]\nenv_vars = ["LINEAR_API_KEY"]');
    expect(codexHomeDir({ CODEX_HOME: own }, home)).toBe(own);
    expect(codexHomeDir({}, home)).toBe(join(home, ".codex"));
    expect(codexHomeDir({}, "")).toBe("");

    const withHome = codex({ ...BOT_ENV, CODEX_HOME: own }).env;
    expect(withHome.LINEAR_API_KEY).toBe("geheim-linear");
    expect(withHome.NOTION_TOKEN).toBeUndefined();
    expect(withHome.CODEX_HOME).toBe(own);

    const without = codex(BOT_ENV).env;
    expect(without.NOTION_TOKEN).toBe("geheim-notion");
    expect(without.LINEAR_API_KEY).toBeUndefined();
  });
});

describe("Filter für Codex", () => {
  beforeEach(() => writeToml(join(home, ".codex"), CONFIG));

  test("Akzeptanz: TELEGRAM_BOT_TOKEN und WEB_PASSWORD fehlen, env_vars-Variable ist da", () => {
    const { env, removed } = codex(BOT_ENV);
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.WEB_PASSWORD).toBeUndefined();
    expect(removed).toEqual(expect.arrayContaining(["TELEGRAM_BOT_TOKEN", "WEB_PASSWORD"]));
    expect(env.NOTION_TOKEN).toBe("geheim-notion");
    expect(env.LINEAR_API_KEY).toBe("geheim-linear");
    expect(env.GITHUB_PAT_TOKEN).toBe("geheim-github");
    expect(env.TYBO_SUBPROCESS).toBe("1");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  test("OpenAI-Schlüssel und Telegram-Bot-Tokens nie über MCP-Verweise", () => {
    const { env } = codex(BOT_ENV);
    for (const n of ["OPENAI_API_KEY", "CODEX_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_RESEARCH", "WEB_PASSWORD",
      "SUPABASE_SERVICE_ROLE_KEY", "TELEGRAM_USER_ID"]) {
      expect(env[n]).toBeUndefined();
    }
    expect(Object.values(env).filter(v => v.includes("geheim")).sort()).toEqual(["geheim-github", "geheim-linear", "geheim-notion"]);
  });

  test("über die Freigabeliste kommen sie durch, WEB_PASSWORD nie", () => {
    const { env } = codex({
      ...BOT_ENV,
      TYBO_SUBPROCESS_ENV_ALLOW: "OPENAI_API_KEY,CODEX_API_KEY,TELEGRAM_BOT_TOKEN,WEB_PASSWORD",
    });
    expect(env.OPENAI_API_KEY).toBe("geheim-openai");
    expect(env.CODEX_API_KEY).toBe("geheim-codex");
    expect(env.TELEGRAM_BOT_TOKEN).toBe("123:geheim-telegram");
    expect(env.WEB_PASSWORD).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN_RESEARCH).toBeUndefined();
  });

  test("ANTHROPIC_API_KEY bleibt bei Codex nicht von selbst", () => {
    expect(codex(BOT_ENV).env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(codex({ ...BOT_ENV, TYBO_SUBPROCESS_ENV_ALLOW: "ANTHROPIC_API_KEY" }).env.ANTHROPIC_API_KEY).toBe("geheim-anthropic");
  });

  test("Claude-Dateien zählen für Codex nicht", () => {
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { x: { env: { A: "${SUPABASE_SERVICE_ROLE_KEY}" } } } }));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { y: { env: { B: "$GATEWAY_SECRET" } } } }));
    const { env } = codex({ ...BOT_ENV, GATEWAY_SECRET: "geheim-gateway" });
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(env.GATEWAY_SECRET).toBeUndefined();
  });

  test("Gespräch des Aufrufs wird gesetzt", () => {
    const { env } = codex(BOT_ENV, { conversationKey: "topic:-1001:5" });
    expect([env.TYBO_CHAT_ID, env.TYBO_TOPIC_ID]).toEqual(["-1001", "5"]);
  });
});

describe("Claude unverändert", () => {
  test("config.toml von Codex zählt für Claude nicht, ANTHROPIC_API_KEY bleibt, MCP-Referenz gibt OPENAI_API_KEY frei", () => {
    writeToml(join(home, ".codex"), CONFIG);
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { x: { env: { K: "${OPENAI_API_KEY}" } } } }));
    const claude = filterSubprocessEnv({ env: BOT_ENV, cwd: project, home });
    expect(claude.env.NOTION_TOKEN).toBeUndefined();
    expect(claude.env.ANTHROPIC_API_KEY).toBe("geheim-anthropic");
    expect(claude.env.OPENAI_API_KEY).toBe("geheim-openai");
    expect(claude).toEqual(filterSubprocessEnv({ env: BOT_ENV, cwd: project, home, engine: "claude" }));
  });
});

describe("Log", () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    setSubprocessEnvLoggerForTests(line => lines.push(line));
  });
  afterEach(() => setSubprocessEnvLoggerForTests(null));

  test("einmal pro Motor, nur Namen", () => {
    const env = { PATH: "/bin", TELEGRAM_BOT_TOKEN: "123:geheim" };
    logSubprocessEnvFilter({ env, cwd: project, home });
    logSubprocessEnvFilter({ env, cwd: project, home, engine: "codex" });
    logSubprocessEnvFilter({ env, cwd: project, home, engine: "codex" });
    logSubprocessEnvFilter({ env, cwd: project, home });
    expect(lines).toEqual([
      "[subprocess-env] Claude-Subprozesse erben 1 Geheimnis-Variablen nicht: TELEGRAM_BOT_TOKEN (Freigabe: TYBO_SUBPROCESS_ENV_ALLOW)",
      "[subprocess-env] Codex-Subprozesse erben 1 Geheimnis-Variablen nicht: TELEGRAM_BOT_TOKEN (Freigabe: TYBO_SUBPROCESS_ENV_ALLOW)",
    ]);
  });
});

describe("Codex-Prozess bekommt diese Umgebung", () => {
  const keys = ["CODEX_HOME", "TELEGRAM_BOT_TOKEN", "WEB_PASSWORD", "NOTION_TOKEN", "OPENAI_API_KEY", "TYBO_SUBPROCESS_ENV_ALLOW"] as const;
  const saved: Partial<Record<(typeof keys)[number], string | undefined>> = {};
  let errSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    setSettingsPath(join(project, "fehlt", "settings.json"));
    errSpy = spyOn(console, "error").mockImplementation(() => {});
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setSettingsPath();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  test("Spawn-Umgebung: Geheimnisse fehlen, env_vars aus $CODEX_HOME/config.toml und CODEX_HOME sind da", async () => {
    const own = tmp();
    writeToml(own, '[mcp_servers.notion]\ncommand = "x"\nenv_vars = ["NOTION_TOKEN", "OPENAI_API_KEY"]');
    process.env.CODEX_HOME = own;
    delete process.env.TYBO_SUBPROCESS_ENV_ALLOW;
    process.env.TELEGRAM_BOT_TOKEN = "123:geheim-telegram";
    process.env.WEB_PASSWORD = "geheim-web";
    process.env.NOTION_TOKEN = "geheim-notion";
    process.env.OPENAI_API_KEY = "geheim-openai";

    const fake = installCodexFake();
    try {
      fake.next({ events: [ev.completed()] });
      await createCodexEngine().run({ prompt: "Hallo", streaming: false, timeoutMs: 60_000, cwd: project });
      const env = fake.spawns[0]!.env!;
      expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(env.WEB_PASSWORD).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.NOTION_TOKEN).toBe("geheim-notion");
      expect(env.CODEX_HOME).toBe(own);
      expect(env.TYBO_SUBPROCESS).toBe("1");
      expect(env).toEqual(codexEnv(project));
    } finally {
      fake.restore();
    }
  });
});
