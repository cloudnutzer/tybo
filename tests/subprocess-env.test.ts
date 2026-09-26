/**
 * Issue #54, Aufgabe 1: subprocessEnv() entfernt Geheimnisse aus der
 * Umgebung von Claude-Subprozessen. MCP-Konfigurationen liegen nur in
 * temporären Verzeichnissen; die echte ~/.claude.json wird nie gelesen
 * (HOME zeigt immer auf ein Temp-Verzeichnis).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  filterSubprocessEnv,
  isSecretName,
  mcpReferencedVars,
  logSubprocessEnvFilter,
  setMcpReaderForTests,
  setSubprocessEnvLoggerForTests,
  subprocessEnv,
} from "../src/lib/subprocess-env";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tybo-subenv-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Leeres HOME und leeres Projekt: keine MCP-Referenzen */
let home: string;
let project: string;
beforeEach(() => {
  setMcpReaderForTests(null);
  home = tmp();
  project = tmp();
});

const BOT_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/test",
  LANG: "de_DE.UTF-8",
  SESSION_MODE: "resume",
  TELEGRAM_BOT_TOKEN: "123:geheim-telegram",
  TELEGRAM_USER_ID: "4711",
  TELEGRAM_BOT_TOKEN_RESEARCH: "456:geheim-research",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "geheim-supabase",
  WEB_PASSWORD: "geheim-web",
  WEB_PORT: "3100",
  OPENROUTER_API_KEY: "geheim-openrouter",
  OPENAI_API_KEY: "geheim-openai",
  GOOGLE_CLIENT_SECRET: "geheim-google",
  SMTP_PASS: "geheim-smtp",
  DB_PASSWORD_FILE: "/x",
  GATEWAY_SECRET: "geheim-gateway",
  CLAUDECODE: "1",
  TYBO_CHAT_ID: "-100999",
  TYBO_TOPIC_ID: "77",
};

function filter(env: Record<string, string>, extra: Partial<Parameters<typeof filterSubprocessEnv>[0]> = {}) {
  return filterSubprocessEnv({ env, cwd: project, home, ...extra });
}

describe("Namensmuster", () => {
  test("Geheimnisse werden erkannt", () => {
    for (const n of ["TELEGRAM_BOT_TOKEN", "GH_TOKEN", "OPENAI_API_KEY", "GOOGLE_CLIENT_SECRET", "WEB_PASSWORD",
      "MY_PASSWORD_X", "SMTP_PASS", "SUPABASE_URL", "TELEGRAM_USER_ID", "anthropic_api_key"]) {
      expect(isSecretName(n)).toBe(true);
    }
  });
  test("gewöhnliche Variablen bleiben", () => {
    for (const n of ["PATH", "HOME", "LANG", "TYBO_SUBPROCESS", "USER_TIMEZONE", "WEB_PORT", "KEYCHAIN", "PASSPORT"]) {
      expect(isSecretName(n)).toBe(false);
    }
  });
});

describe("filterSubprocessEnv", () => {
  test("Akzeptanz: Geheimnisse fehlen, PATH/HOME/TYBO_SUBPROCESS sind da", () => {
    const { env, removed } = filter(BOT_ENV);
    for (const n of ["TELEGRAM_BOT_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "WEB_PASSWORD", "OPENROUTER_API_KEY",
      "OPENAI_API_KEY", "GOOGLE_CLIENT_SECRET", "SMTP_PASS", "DB_PASSWORD_FILE", "SUPABASE_URL",
      "TELEGRAM_USER_ID", "TELEGRAM_BOT_TOKEN_RESEARCH", "GATEWAY_SECRET"]) {
      expect(env[n]).toBeUndefined();
      expect(removed).toContain(n);
    }
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.LANG).toBe("de_DE.UTF-8");
    expect(env.SESSION_MODE).toBe("resume");
    expect(env.WEB_PORT).toBe("3100");
    expect(env.TYBO_SUBPROCESS).toBe("1");
  });

  test("kein Wert eines Geheimnisses in der Umgebung", () => {
    const { env } = filter(BOT_ENV);
    expect(Object.values(env).some(v => v.includes("geheim"))).toBe(false);
  });

  test("CLAUDECODE und vererbte Gesprächsziele fehlen, Ziel des Aufrufs wird gesetzt", () => {
    expect(filter(BOT_ENV).env.CLAUDECODE).toBeUndefined();
    expect(filter(BOT_ENV).env.TYBO_CHAT_ID).toBeUndefined();
    expect(filter(BOT_ENV).env.TYBO_TOPIC_ID).toBeUndefined();
    const t = filter(BOT_ENV, { conversationKey: "topic:-1001:5" }).env;
    expect(t.TYBO_CHAT_ID).toBe("-1001");
    expect(t.TYBO_TOPIC_ID).toBe("5");
  });

  test("ANTHROPIC_API_KEY bleibt, wenn gesetzt; leer wird er entfernt", () => {
    expect(filter({ ...BOT_ENV, ANTHROPIC_API_KEY: "sk-ant-test" }).env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(filter({ ...BOT_ENV, ANTHROPIC_API_KEY: "" }).env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(filter(BOT_ENV).env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("geerbte CLAUDE_CODE_OAUTH_TOKEN und ANTHROPIC_AUTH_TOKEN fehlen ohne Freigabe", () => {
    const tokens = { CLAUDE_CODE_OAUTH_TOKEN: "oauth-x", ANTHROPIC_AUTH_TOKEN: "auth-x" };
    const { env, removed } = filter({ ...BOT_ENV, ...tokens });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(removed).toEqual(expect.arrayContaining(["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]));
    const allowed = filter({ ...BOT_ENV, ...tokens, TYBO_SUBPROCESS_ENV_ALLOW: "CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_AUTH_TOKEN" }).env;
    expect(allowed.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-x");
    expect(allowed.ANTHROPIC_AUTH_TOKEN).toBe("auth-x");
  });

  test("Freigabeliste wirkt, kommagetrennt mit Leerzeichen", () => {
    const { env, removed } = filter({ ...BOT_ENV, TYBO_SUBPROCESS_ENV_ALLOW: " OPENAI_API_KEY , GH_TOKEN,", GH_TOKEN: "gh-x" });
    expect(env.OPENAI_API_KEY).toBe("geheim-openai");
    expect(env.GH_TOKEN).toBe("gh-x");
    expect(removed).not.toContain("OPENAI_API_KEY");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  test("Freigaben hebeln die festen Regeln nicht aus", () => {
    const { env } = filter({ ...BOT_ENV, TYBO_SUBPROCESS_ENV_ALLOW: "CLAUDECODE,TYBO_CHAT_ID,TYBO_TOPIC_ID,WEB_PASSWORD" });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.TYBO_CHAT_ID).toBeUndefined();
    expect(env.TYBO_TOPIC_ID).toBeUndefined();
    expect(env.WEB_PASSWORD).toBeUndefined();
  });

  test("Issue #141: vererbte Gesprächsvariablen fehlen, Marker nur TYBO_SUBPROCESS", () => {
    const inherited = { ...BOT_ENV, TYBO_CHAT_ID: "-100888", TYBO_TOPIC_ID: "66" };
    const { env } = filter(inherited, { conversationKey: undefined });
    expect(env.TYBO_CHAT_ID).toBeUndefined();
    expect(env.TYBO_TOPIC_ID).toBeUndefined();
    expect(env.TYBO_SUBPROCESS).toBe("1");
    const allowed = filter({ ...inherited, TYBO_SUBPROCESS_ENV_ALLOW: "TYBO_CHAT_ID,TYBO_TOPIC_ID" }).env;
    expect(allowed.TYBO_CHAT_ID).toBeUndefined();
    expect(allowed.TYBO_TOPIC_ID).toBeUndefined();
    const topic = filter(inherited, { conversationKey: "topic:-1001:5" }).env;
    expect([topic.TYBO_CHAT_ID, topic.TYBO_TOPIC_ID]).toEqual(["-1001", "5"]);
  });

  test("Issue #141: erzeugt werden nur TYBO_SUBPROCESS und das Gespräch des Aufrufs", () => {
    const { env } = filter({ PATH: "/usr/bin" }, { conversationKey: "topic:-1001:5" });
    expect(env).toEqual({ PATH: "/usr/bin", TYBO_SUBPROCESS: "1", TYBO_CHAT_ID: "-1001", TYBO_TOPIC_ID: "5" });
  });

  test("leere Freigabeliste gibt nichts frei", () => {
    const empty = filter({ ...BOT_ENV, GH_TOKEN: "gh-x", TYBO_SUBPROCESS_ENV_ALLOW: "" }).env;
    expect(empty.GH_TOKEN).toBeUndefined();
  });

  test("process.env bleibt unverändert", () => {
    const before = { ...process.env };
    process.env.ISSUE54_TEST_TOKEN = "x";
    subprocessEnv({ cwd: project, home });
    expect(process.env.ISSUE54_TEST_TOKEN).toBe("x");
    delete process.env.ISSUE54_TEST_TOKEN;
    expect({ ...process.env }).toEqual(before);
  });
});

describe("MCP-Referenzen", () => {
  function write(path: string, data: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  }

  test("${VAR} und $VAR aus ~/.claude.json (global und passendes Projekt) bleiben", () => {
    write(join(home, ".claude.json"), {
      mcpServers: { notion: { command: "bun", args: ["x"], env: { NOTION_TOKEN: "${NOTION_TOKEN}" } } },
      projects: {
        [project]: { mcpServers: { mail: { command: "bun", env: { K: "$MAIL_API_KEY" } } } },
        "/fremdes/projekt": { mcpServers: { x: { env: { K: "${FOREIGN_API_KEY}" } } } },
      },
      hooks: { Stop: [{ command: "echo $HOOK_TOKEN" }] },
    });
    const refs = mcpReferencedVars(project, home);
    expect(refs.has("NOTION_TOKEN")).toBe(true);
    expect(refs.has("MAIL_API_KEY")).toBe(true);
    expect(refs.has("FOREIGN_API_KEY")).toBe(false);
    expect(refs.has("HOOK_TOKEN")).toBe(false);

    const { env } = filter({ ...BOT_ENV, NOTION_TOKEN: "n", MAIL_API_KEY: "m", FOREIGN_API_KEY: "f", HOOK_TOKEN: "h" });
    expect(env.NOTION_TOKEN).toBe("n");
    expect(env.MAIL_API_KEY).toBe("m");
    expect(env.FOREIGN_API_KEY).toBeUndefined();
    expect(env.HOOK_TOKEN).toBeUndefined();
  });

  test(".mcp.json und .claude/settings*.json im Projekt, nur Bereich mcpServers", () => {
    write(join(project, ".mcp.json"), { mcpServers: { a: { type: "http", url: "https://x/?k=${A_KEY:-leer}", headers: { Authorization: "Bearer ${A_TOKEN}" } } } });
    write(join(project, ".claude", "settings.json"), { mcpServers: { b: { env: { X: "$B_SECRET" } } }, permissions: { allow: ["Bash(echo $PERM_TOKEN)"] } });
    write(join(project, ".claude", "settings.local.json"), { mcpServers: { c: { args: ["--pass", "${C_PASS}"] } } });
    write(join(home, ".claude", "settings.json"), { mcpServers: { d: { env: { X: "${D_TOKEN}" } } } });
    const refs = mcpReferencedVars(project, home);
    expect([...refs].sort()).toEqual(["A_KEY", "A_TOKEN", "B_SECRET", "C_PASS", "D_TOKEN"]);
  });

  test("defekte oder fehlende Dateien: keine Freigaben, Filter greift trotzdem", () => {
    write(join(home, ".claude.json"), "{ kaputt");
    write(join(project, ".mcp.json"), "[1,2");
    write(join(project, ".claude", "settings.json"), { mcpServers: "kein Objekt" });
    expect(mcpReferencedVars(project, home).size).toBe(0);
    const { env } = filter(BOT_ENV);
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  test("werfender Leser: Filter greift trotzdem", () => {
    setMcpReaderForTests(() => { throw new Error("kaputt"); });
    const { env } = filter(BOT_ENV);
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.TYBO_SUBPROCESS).toBe("1");
  });

  test("Änderung der Datei wird beim nächsten Aufruf gelesen", () => {
    write(join(project, ".mcp.json"), { mcpServers: { a: { env: { X: "${ONE_TOKEN}" } } } });
    expect(mcpReferencedVars(project, home).has("ONE_TOKEN")).toBe(true);
    write(join(project, ".mcp.json"), { mcpServers: { a: { env: { X: "${TWO_TOKEN_LONGER}" } } } });
    const refs = mcpReferencedVars(project, home);
    expect(refs.has("TWO_TOKEN_LONGER")).toBe(true);
    expect(refs.has("ONE_TOKEN")).toBe(false);
  });
});

describe("Start-Log", () => {
  const lines: string[] = [];
  const saved: Record<string, string | undefined> = {};
  const LOG_ENV: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: "123:geheim-telegram",
    WEB_PASSWORD: "geheim-web",
    OPENROUTER_API_KEY: "geheim-openrouter",
    SUPABASE_SERVICE_ROLE_KEY: "geheim-supabase",
    SAFE_TOKEN: "geheim-freigegeben",
    TYBO_SUBPROCESS_ENV_ALLOW: "SAFE_TOKEN",
  };
  beforeEach(() => {
    lines.length = 0;
    setSubprocessEnvLoggerForTests(line => lines.push(line));
    for (const k of Object.keys(LOG_ENV)) saved[k] = process.env[k];
    Object.assign(process.env, LOG_ENV);
  });
  afterEach(() => {
    setSubprocessEnvLoggerForTests(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("genau ein Log über Start und mehrere Aufrufe, nur Namen", () => {
    logSubprocessEnvFilter({ cwd: project, home });
    for (let i = 0; i < 3; i++) subprocessEnv({ cwd: project, home });
    logSubprocessEnvFilter({ cwd: project, home });
    expect(lines).toHaveLength(1);
    const line = lines[0];
    for (const n of ["TELEGRAM_BOT_TOKEN", "WEB_PASSWORD", "OPENROUTER_API_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
      expect(line).toContain(n);
    }
    expect(line).not.toContain("SAFE_TOKEN");
    expect(line).not.toContain("geheim");
    for (const v of Object.values(LOG_ENV)) expect(line).not.toContain(v);
  });

  test("ohne Start-Aufruf loggt der erste Subprozess einmal", () => {
    subprocessEnv({ cwd: project, home });
    subprocessEnv({ cwd: project, home });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("TELEGRAM_BOT_TOKEN");
    expect(lines[0]).not.toContain("geheim");
  });
});
