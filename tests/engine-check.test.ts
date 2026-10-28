/**
 * Issue #124, Aufgabe 3: checkEngine("codex") prüft `codex --version` und
 * `codex login status`. Prozessstart, Timer und Signale sind Attrappen
 * (tests/codex-fixture.ts); kein echtes codex, keine echten Signale.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CLAUDE_LOGIN_UNKNOWN,
  CLAUDE_NOT_INSTALLED,
  CLAUDE_NOT_LOGGED_IN,
  inspectEngine,
  parseClaudeLogin,
  CODEX_NOT_INSTALLED,
  CODEX_NOT_LOGGED_IN,
  ENGINE_CHECK_CACHE_MS,
  ENGINE_CHECK_TIMEOUT_MS,
  checkEngine,
  parseCodexVersion,
  resetEngineCheckCacheForTests,
} from "../src/lib/engines/check";
import { CODEX_KILL_GRACE_MS } from "../src/lib/engines/codex";
import { checkEngine as checkEngineFromIndex } from "../src/lib/engines";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { installCodexFake, until, type CodexFake } from "./codex-fixture";

let fake: CodexFake;
const KEYS = ["CLAUDE_PATH", "CODEX_PATH", "CODEX_HOME", "TELEGRAM_BOT_TOKEN", "WEB_PASSWORD", "TYBO_SUBPROCESS_ENV_ALLOW"] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeAll(() => setMcpReaderForTests(() => new Set()));
afterAll(() => setMcpReaderForTests(null));
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.CODEX_PATH;
  delete process.env.CLAUDE_PATH;
  delete process.env.TYBO_SUBPROCESS_ENV_ALLOW;
  resetEngineCheckCacheForTests();
  fake = installCodexFake();
});
afterEach(() => {
  fake.restore();
  resetEngineCheckCacheForTests();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const VERSION_OK = { stdout: "codex-cli 0.155.1\n", exitCode: 0 };
/** Ausgabe mit Konto- und Schlüsselangaben: darf nirgends ankommen */
const LOGIN_OK = { stdout: "Logged in using ChatGPT (alex@example.test) sk-test-abcdefghijklmnop\n", exitCode: 0 };
const LOGIN_MISSING = { stdout: "Not logged in (Konto alex@example.test)\n", exitCode: 1 };

describe("checkEngine(\"codex\")", () => {
  test("installiert und angemeldet: Version, zwei Befehle ohne Projekt- und Sandbox-Argumente", async () => {
    fake.next(VERSION_OK);
    fake.next(LOGIN_OK);
    const status = await checkEngine("codex");
    expect(status).toEqual({ engine: "codex", checked: true, installed: true, loggedIn: true, version: "0.155.1" });
    expect(fake.spawns.map((s) => s.cmd)).toEqual([["codex", "--version"], ["codex", "login", "status"]]);
    expect(JSON.stringify(status)).not.toContain("alex");
  });

  test("Akzeptanz: login status mit Exit 1 ergibt „nicht angemeldet“, ohne rohe Ausgabe", async () => {
    fake.next(VERSION_OK);
    fake.next(LOGIN_MISSING);
    const status = await checkEngine("codex");
    expect(status).toEqual({
      engine: "codex",
      checked: true,
      installed: true,
      loggedIn: false,
      version: "0.155.1",
      message: CODEX_NOT_LOGGED_IN,
    });
    expect(status.message).toBe("Codex ist nicht angemeldet: im Terminal `codex login` ausführen");
    expect(JSON.stringify(status)).not.toContain("alex");
  });

  test("Akzeptanz: Start scheitert, ergibt „nicht installiert“ ohne zweiten Befehl", async () => {
    fake.next({ throws: "ENOENT: no such file or directory, posix_spawn 'codex'" });
    const status = await checkEngine("codex");
    expect(status).toEqual({ engine: "codex", checked: true, installed: false, loggedIn: false, message: CODEX_NOT_INSTALLED });
    expect(status.message).toContain("nicht installiert");
    expect(fake.spawns).toHaveLength(0);
  });

  test("Exit 127 bei --version heißt nicht installiert, anderer Fehler nennt den Exit-Code", async () => {
    fake.next({ exitCode: 127 });
    expect((await checkEngine("codex")).message).toBe(CODEX_NOT_INSTALLED);
    resetEngineCheckCacheForTests();
    fake.next({ exitCode: 2, stdout: "panic: geheim-xyz" });
    const status = await checkEngine("codex");
    expect(status).toMatchObject({ installed: false, loggedIn: false });
    expect(status.message).toBe("Codex startet nicht: codex --version endete mit Exit-Code 2");
  });

  test("Version ohne erkennbare Nummer: installiert, ohne version", async () => {
    fake.next({ stdout: "codex-cli dev\n", exitCode: 0 });
    fake.next(LOGIN_OK);
    const status = await checkEngine("codex");
    expect(status).toEqual({ engine: "codex", checked: true, installed: true, loggedIn: true });
  });

  test("CODEX_PATH ersetzt codex, Umgebung wie beim Motor (Geheimnisse draußen, CODEX_HOME da)", async () => {
    process.env.CODEX_PATH = "/opt/codex/bin/codex";
    process.env.CODEX_HOME = "/tmp/tybo-codex-home";
    process.env.TELEGRAM_BOT_TOKEN = "123:geheim-telegram";
    process.env.WEB_PASSWORD = "geheim-web";
    fake.next(VERSION_OK);
    fake.next(LOGIN_OK);
    await checkEngine("codex");
    expect(fake.spawns.map((s) => s.cmd[0])).toEqual(["/opt/codex/bin/codex", "/opt/codex/bin/codex"]);
    for (const call of fake.spawns) {
      expect(call.env?.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(call.env?.WEB_PASSWORD).toBeUndefined();
      expect(call.env?.CODEX_HOME).toBe("/tmp/tybo-codex-home");
      expect(call.env?.TYBO_SUBPROCESS).toBe("1");
    }
  });
});

describe("Zeitlimit 5 s", () => {
  test("--version hängt: nach 5 s beendet (SIGINT, dann SIGKILL), Meldung", async () => {
    fake.next({ hang: true, ignoreSigint: true });
    const pending = checkEngine("codex");
    fake.advance(ENGINE_CHECK_TIMEOUT_MS - 1);
    expect(fake.signals).toEqual([]);
    fake.advance(1);
    const status = await pending;
    expect(status).toMatchObject({ installed: false, loggedIn: false });
    expect(status.message).toBe("Codex antwortet nicht: codex --version brauchte länger als 5 s");
    expect(fake.signals).toEqual(["SIGINT"]);
    fake.advance(CODEX_KILL_GRACE_MS);
    expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
    expect(fake.timerCount()).toBe(0);
  });

  test("login status hängt: installiert, nicht angemeldet, Prozess beendet", async () => {
    fake.next(VERSION_OK);
    fake.next({ hang: true });
    const pending = checkEngine("codex");
    await until(() => fake.spawns.length === 2);
    fake.advance(ENGINE_CHECK_TIMEOUT_MS);
    const status = await pending;
    expect(status).toMatchObject({ installed: true, loggedIn: false, version: "0.155.1" });
    expect(status.message).toBe("Codex-Anmeldung nicht prüfbar: codex login status brauchte länger als 5 s");
    expect(fake.signals).toEqual(["SIGINT"]);
  });

  test("schnelle Antwort räumt den Zeitgeber ab", async () => {
    fake.next(VERSION_OK);
    fake.next(LOGIN_OK);
    await checkEngine("codex");
    expect(fake.timerCount()).toBe(0);
    expect(fake.signals).toEqual([]);
  });
});

describe("Zwischenspeicher 60 s", () => {
  test("gleiches Ergebnis innerhalb von 60 s, danach neue Prüfung", async () => {
    fake.next(VERSION_OK);
    fake.next(LOGIN_MISSING);
    expect((await checkEngine("codex")).loggedIn).toBe(false);
    fake.advance(ENGINE_CHECK_CACHE_MS - 1);
    expect((await checkEngine("codex")).loggedIn).toBe(false);
    expect(fake.spawns).toHaveLength(2);

    fake.advance(1);
    fake.next(VERSION_OK);
    fake.next(LOGIN_OK);
    expect((await checkEngine("codex")).loggedIn).toBe(true);
    expect(fake.spawns).toHaveLength(4);
  });

  test("gleichzeitige Anfragen teilen sich eine Prüfung", async () => {
    fake.next(VERSION_OK);
    fake.next(LOGIN_OK);
    const [a, b] = await Promise.all([checkEngine("codex"), checkEngineFromIndex("codex")]);
    expect(a).toEqual(b);
    expect(fake.spawns).toHaveLength(2);
  });

  test("anderer CODEX_PATH prüft neu", async () => {
    fake.next(VERSION_OK);
    fake.next(LOGIN_OK);
    await checkEngine("codex");
    process.env.CODEX_PATH = "/opt/anders/codex";
    fake.next({ throws: "ENOENT" });
    expect((await checkEngine("codex")).installed).toBe(false);
  });
});

describe("andere Motoren", () => {
  test("Claude Code wird hier nicht geprüft; keine Prozesse (OpenCode: tests/opencode-engine-check.test.ts)", async () => {
    expect(await checkEngine("claude")).toEqual({ engine: "claude", checked: false, installed: true, loggedIn: true });
    expect(fake.spawns).toHaveLength(0);
  });
});

describe("parseCodexVersion", () => {
  test("liest die Nummer, sonst undefined", () => {
    expect(parseCodexVersion("codex-cli 0.155.1\n")).toBe("0.155.1");
    expect(parseCodexVersion("codex-cli 1.2.0-alpha.3")).toBe("1.2.0-alpha.3");
    expect(parseCodexVersion("codex 2.1")).toBe("2.1");
    expect(parseCodexVersion("")).toBeUndefined();
  });
});

describe("inspectEngine (Issue #126): Anzeige für Einstellungen und Status", () => {
  /** Ausgabe von `claude auth status --json` mit Konto-Angaben, die nie ankommen dürfen */
  const AUTH = (loggedIn: boolean) =>
    JSON.stringify({ loggedIn, authMethod: "claude.ai", email: "alex@example.test", orgName: "Beispiel GmbH", orgId: "org-geheim" });
  const CLAUDE_VERSION = { stdout: "2.1.281 (Claude Code)\n", exitCode: 0 };

  test("Claude angemeldet: zwei Befehle, Version, nur loggedIn gelesen", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:geheim";
    fake.next(CLAUDE_VERSION);
    fake.next({ stdout: AUTH(true), exitCode: 0 });
    const status = await inspectEngine("claude");
    expect(status).toEqual({ engine: "claude", checked: true, installed: true, loggedIn: true, version: "2.1.281" });
    expect(fake.spawns.map((s) => s.cmd)).toEqual([["claude", "--version"], ["claude", "auth", "status", "--json"]]);
    expect(JSON.stringify(status)).not.toMatch(/alex|Beispiel|org-geheim/);
    // Geheimnisse aus der Umgebung erbt die Prüfung nicht
    expect(fake.spawns[0].env?.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(fake.spawns[1].env?.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  test("Claude nicht angemeldet (Exit 1 mit loggedIn false): Hinweis zum Anmelden", async () => {
    fake.next(CLAUDE_VERSION);
    fake.next({ stdout: AUTH(false), exitCode: 1 });
    expect(await inspectEngine("claude")).toEqual({
      engine: "claude",
      checked: true,
      installed: true,
      loggedIn: false,
      version: "2.1.281",
      message: CLAUDE_NOT_LOGGED_IN,
    });
  });

  test("ungeprüft heißt nie angemeldet: unbekannte Ausgabe, Zeitlimit", async () => {
    fake.next(CLAUDE_VERSION);
    fake.next({ stdout: "error: unknown command 'auth'\n", exitCode: 1 });
    expect(await inspectEngine("claude")).toEqual({
      engine: "claude",
      checked: true,
      installed: true,
      loggedIn: false,
      loginUnknown: true,
      version: "2.1.281",
      message: CLAUDE_LOGIN_UNKNOWN,
    });
    resetEngineCheckCacheForTests();
    fake.next(CLAUDE_VERSION);
    fake.next({ hang: true });
    const pending = inspectEngine("claude");
    await until(() => fake.spawns.length === 4);
    fake.advance(ENGINE_CHECK_TIMEOUT_MS);
    const status = await pending;
    expect(status.loggedIn).toBe(false);
    expect(status.loginUnknown).toBe(true);
  });

  test("Claude nicht installiert: Startfehler oder Exit 127, CLAUDE_PATH wird verwendet", async () => {
    process.env.CLAUDE_PATH = "/opt/claude/bin/claude";
    fake.next({ throws: "ENOENT" });
    expect(await inspectEngine("claude")).toEqual({ engine: "claude", checked: true, installed: false, loggedIn: false, message: CLAUDE_NOT_INSTALLED });
    resetEngineCheckCacheForTests();
    fake.next({ stdout: "", exitCode: 127 });
    expect((await inspectEngine("claude")).message).toBe(CLAUDE_NOT_INSTALLED);
    expect(fake.spawns.map((s) => s.cmd)).toEqual([["/opt/claude/bin/claude", "--version"]]);
  });

  test("Ergebnis gilt 60 s; checkEngine(\"claude\") startet weiter nichts (Motor-Wahl unverändert)", async () => {
    fake.next(CLAUDE_VERSION);
    fake.next({ stdout: AUTH(true), exitCode: 0 });
    await inspectEngine("claude");
    await inspectEngine("claude");
    expect(fake.spawns).toHaveLength(2);
    expect(await checkEngine("claude")).toEqual({ engine: "claude", checked: false, installed: true, loggedIn: true });
    expect(fake.spawns).toHaveLength(2);
    fake.advance(ENGINE_CHECK_CACHE_MS);
    fake.next(CLAUDE_VERSION);
    fake.next({ stdout: AUTH(false), exitCode: 1 });
    expect((await inspectEngine("claude")).loggedIn).toBe(false);
  });

  test("Codex: wie checkEngine", async () => {
    fake.next(VERSION_OK);
    fake.next(LOGIN_MISSING);
    expect(await inspectEngine("codex")).toEqual({
      engine: "codex",
      checked: true,
      installed: true,
      loggedIn: false,
      version: "0.155.1",
      message: CODEX_NOT_LOGGED_IN,
    });
  });

  test("parseClaudeLogin: nur ein boolesches loggedIn zählt", () => {
    expect(parseClaudeLogin(AUTH(true))).toBe(true);
    expect(parseClaudeLogin(AUTH(false))).toBe(false);
    expect(parseClaudeLogin('{"loggedIn":"yes"}')).toBeUndefined();
    expect(parseClaudeLogin("Logged in")).toBeUndefined();
    expect(parseClaudeLogin("")).toBeUndefined();
  });
});
