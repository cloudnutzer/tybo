/**
 * Issue #128, Aufgabe 3: checkEngine("opencode") prüft `opencode --version`
 * (nur V1) und `opencode auth list`. Prozessstart, Timer und Signale sind
 * Attrappen (tests/opencode-fixture.ts, beide Befehle aus der
 * Warteschlange); kein echtes opencode, keine echten Signale.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { checkEngine as checkEngineFromIndex } from "../src/lib/engines";
import {
  checkEngine,
  ENGINE_CHECK_CACHE_MS,
  ENGINE_CHECK_TIMEOUT_MS,
  forgetEngineCheck,
  inspectEngine,
  openCodeProviderKeysIn,
  parseOpenCodeAuthList,
  resetEngineCheckCacheForTests,
} from "../src/lib/engines/check";
import { OPENCODE_KILL_GRACE_MS, OPENCODE_NOT_INSTALLED, OPENCODE_NOT_LOGGED_IN } from "../src/lib/engines/opencode";
import { OPENCODE_PROVIDER_KEYS, setMcpReaderForTests } from "../src/lib/subprocess-env";
import { until } from "./codex-fixture";
import { installOpenCodeFake, type OpenCodeFake } from "./opencode-fixture";

let fake: OpenCodeFake;
const KEYS = ["OPENCODE_PATH", "XDG_DATA_HOME", "TYBO_SUBPROCESS_ENV_ALLOW", "TELEGRAM_BOT_TOKEN", "WEB_PASSWORD", ...OPENCODE_PROVIDER_KEYS];
const saved: Record<string, string | undefined> = {};

beforeAll(() => setMcpReaderForTests(() => new Set()));
afterAll(() => setMcpReaderForTests(null));
beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetEngineCheckCacheForTests();
  fake = installOpenCodeFake({ version: null });
});
afterEach(() => {
  fake.restore();
  resetEngineCheckCacheForTests();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const E = "\x1b";
const VERSION_OK = { stdout: "1.18.33\n", exitCode: 0 };
/** Ausgabe wie von @clack/prompts, ohne Farben */
const AUTH_OPENROUTER = {
  stdout: "\n┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  OpenRouter api\n│\n└  1 credentials\n",
  exitCode: 0,
};
/** Mit Farben (ANSI), zwei Anmeldungen und dem Abschnitt Environment */
const AUTH_ANSI = {
  stdout:
    `\n${E}[90m┌${E}[39m  Credentials ${E}[90m~/.local/share/opencode/auth.json${E}[39m\n${E}[90m│${E}[39m\n` +
    `${E}[34m●${E}[39m  OpenRouter ${E}[90mapi${E}[39m\n${E}[90m│${E}[39m\n` +
    `${E}[34m●${E}[39m  OpenAI ${E}[90moauth${E}[39m\n${E}[90m│${E}[39m\n` +
    `${E}[90m└${E}[39m  2 credentials\n\n` +
    `┌  Environment\n│\n●  Anthropic ANTHROPIC_API_KEY\n│\n└  1 environment variable\n`,
  exitCode: 0,
};
const AUTH_EMPTY = { stdout: "\n┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n", exitCode: 0 };
/** Keine Anmeldung, aber OpenCode sieht einen Schlüssel in seiner Umgebung: zählt nicht, tybo prüft selbst */
const AUTH_EMPTY_WITH_ENV = {
  stdout: AUTH_EMPTY.stdout + "\n┌  Environment\n│\n●  OpenRouter OPENROUTER_API_KEY\n│\n└  1 environment variable\n",
  exitCode: 0,
};

describe("parseOpenCodeAuthList", () => {
  test("zählt Anmeldungen und liest Anbieter, auch mit Farben", () => {
    expect(parseOpenCodeAuthList(AUTH_OPENROUTER.stdout)).toEqual({ count: 1, providers: ["OpenRouter"] });
    expect(parseOpenCodeAuthList(AUTH_ANSI.stdout)).toEqual({ count: 2, providers: ["OpenRouter", "OpenAI"] });
    expect(parseOpenCodeAuthList(AUTH_EMPTY.stdout)).toEqual({ count: 0, providers: [] });
    expect(parseOpenCodeAuthList(AUTH_EMPTY_WITH_ENV.stdout)).toEqual({ count: 0, providers: [] });
  });

  test("ohne Schlusszeile: null", () => {
    expect(parseOpenCodeAuthList("")).toBeNull();
    expect(parseOpenCodeAuthList("Error: unknown command auth\n")).toBeNull();
    expect(parseOpenCodeAuthList("┌  Credentials ~/x\n│\n●  OpenRouter api\n")).toBeNull();
  });

  test("seltsame Namen fallen weg, die Zahl bleibt", () => {
    const out = "┌  Credentials ~/x\n●  sk-or-v1-abc=:$geheim api\n●  GitHub Copilot oauth\n└  2 credentials\n";
    expect(parseOpenCodeAuthList(out)).toEqual({ count: 2, providers: ["GitHub Copilot"] });
  });
});

describe("checkEngine(\"opencode\")", () => {
  test("installiert und bei OpenRouter angemeldet: Version, Anbieter, zwei Befehle ohne Projektargumente", async () => {
    fake.next(VERSION_OK);
    fake.next(AUTH_OPENROUTER);
    const status = await checkEngine("opencode");
    expect(status).toEqual({ engine: "opencode", checked: true, installed: true, loggedIn: true, version: "1.18.33", providers: ["OpenRouter"] });
    expect(fake.spawns.map((s) => s.cmd)).toEqual([["opencode", "--version"], ["opencode", "auth", "list"]]);
    for (const call of fake.spawns) {
      expect(call.env?.TYBO_SUBPROCESS).toBe("1");
      expect(call.env?.PWD).toBe(call.cwd!);
    }
  });

  test("Farben (ANSI) und mehrere Anmeldungen", async () => {
    fake.next(VERSION_OK);
    fake.next(AUTH_ANSI);
    expect(await checkEngine("opencode")).toMatchObject({ loggedIn: true, providers: ["OpenRouter", "OpenAI"] });
  });

  test("Akzeptanz: leere auth list ohne Anbieter-Schlüssel ergibt „nicht angemeldet“ (Exit 0)", async () => {
    fake.next(VERSION_OK);
    fake.next(AUTH_EMPTY);
    const status = await checkEngine("opencode");
    expect(status).toEqual({
      engine: "opencode",
      checked: true,
      installed: true,
      loggedIn: false,
      version: "1.18.33",
      message: OPENCODE_NOT_LOGGED_IN,
    });
    expect(status.message).toBe("OpenCode ist nicht angemeldet: im Terminal `opencode auth login -p openrouter` ausführen");
  });

  test("Schlüssel nur im Elternprozess täuscht keine Anmeldung vor", async () => {
    process.env.OPENROUTER_API_KEY = "erfunden-openrouter";
    fake.next(VERSION_OK);
    fake.next(AUTH_EMPTY_WITH_ENV);
    const status = await checkEngine("opencode");
    expect(status).toMatchObject({ loggedIn: false, message: OPENCODE_NOT_LOGGED_IN });
    expect(fake.spawns[1]!.env?.OPENROUTER_API_KEY).toBeUndefined();
  });

  test("freigegebener Anbieter-Schlüssel zählt als Anmeldung, auch bei leerer auth list", async () => {
    process.env.OPENROUTER_API_KEY = "erfunden-openrouter";
    process.env.TYBO_SUBPROCESS_ENV_ALLOW = "OPENROUTER_API_KEY";
    fake.next(VERSION_OK);
    fake.next(AUTH_EMPTY_WITH_ENV);
    const status = await checkEngine("opencode");
    expect(status).toEqual({ engine: "opencode", checked: true, installed: true, loggedIn: true, version: "1.18.33" });
    expect(JSON.stringify(status)).not.toContain("erfunden");
  });

  test("leerer Schlüssel zählt nicht; nur die festgelegten Namen zählen", () => {
    expect(openCodeProviderKeysIn({ OPENROUTER_API_KEY: "", OPENAI_API_KEY: "  " })).toEqual([]);
    expect(openCodeProviderKeysIn({ OPENROUTER_API_KEY: "x", EIGENER_API_KEY: "y" })).toEqual(["OPENROUTER_API_KEY"]);
  });

  test("auth list mit Fehler: installiert, Anmeldung nicht prüfbar, keine rohe Ausgabe", async () => {
    fake.next(VERSION_OK);
    fake.next({ stdout: "Error: sk-or-v1-geheim kaputt\n", stderr: "boom", exitCode: 1 });
    const status = await checkEngine("opencode");
    expect(status).toEqual({
      engine: "opencode",
      checked: true,
      installed: true,
      loggedIn: false,
      loginUnknown: true,
      version: "1.18.33",
      message: "OpenCode-Anmeldung nicht prüfbar: opencode auth list endete mit Exit-Code 1",
    });
    expect(JSON.stringify(status)).not.toContain("geheim");
  });

  test("auth list unlesbar (Exit 0) oder lässt sich nicht starten: nicht prüfbar", async () => {
    fake.next(VERSION_OK);
    fake.next({ stdout: "irgendwas\n", exitCode: 0 });
    expect(await checkEngine("opencode")).toMatchObject({
      installed: true,
      loggedIn: false,
      loginUnknown: true,
      message: "OpenCode-Anmeldung nicht prüfbar: Ausgabe von opencode auth list nicht erkennbar",
    });
    forgetEngineCheck();
    fake.next(VERSION_OK);
    fake.next({ throws: "ENOENT" });
    expect((await checkEngine("opencode")).message).toBe("OpenCode-Anmeldung nicht prüfbar: opencode auth list ließ sich nicht starten");
  });

  test("Akzeptanz: Version 2 ergibt „nicht unterstützt“ ohne zweiten Befehl", async () => {
    fake.next({ stdout: "2.0.4\n", exitCode: 0 });
    const status = await checkEngine("opencode");
    expect(status).toMatchObject({ engine: "opencode", checked: true, installed: false, loggedIn: false, version: "2.0.4" });
    expect(status.message).toContain("OpenCode 2 wird noch nicht unterstützt");
    expect(status.message).toContain("npm i -g opencode-ai@1");
    expect(fake.spawns).toHaveLength(1);
  });

  test("unbekannte Version: nicht bereit, ohne zweiten Befehl", async () => {
    fake.next({ stdout: "opencode dev\n", exitCode: 0 });
    const status = await checkEngine("opencode");
    expect(status).toMatchObject({ installed: false, loggedIn: false, message: "Version von OpenCode nicht erkennbar (opencode --version)" });
    expect(fake.spawns).toHaveLength(1);
  });

  test("fehlende CLI: Start scheitert oder Exit 127 ergibt „nicht installiert“", async () => {
    fake.next({ throws: "ENOENT" });
    expect(await checkEngine("opencode")).toEqual({
      engine: "opencode",
      checked: true,
      installed: false,
      loggedIn: false,
      message: OPENCODE_NOT_INSTALLED,
    });
    forgetEngineCheck();
    fake.next({ stdout: "", exitCode: 127 });
    expect((await checkEngine("opencode")).message).toBe(OPENCODE_NOT_INSTALLED);
    forgetEngineCheck();
    fake.next({ stdout: "", exitCode: 3 });
    expect((await checkEngine("opencode")).message).toBe("OpenCode startet nicht: opencode --version endete mit Exit-Code 3");
    expect(fake.spawns).toHaveLength(2);
  });

  test("OPENCODE_PATH wird verwendet", async () => {
    process.env.OPENCODE_PATH = "/opt/oc/bin/opencode";
    fake.next(VERSION_OK);
    fake.next(AUTH_OPENROUTER);
    await checkEngine("opencode");
    expect(fake.spawns.map((s) => s.cmd[0])).toEqual(["/opt/oc/bin/opencode", "/opt/oc/bin/opencode"]);
  });

  test("Umgebung der Prüfbefehle ohne Telegram-Token und WEB_PASSWORD", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "erfunden-telegram";
    process.env.WEB_PASSWORD = "erfunden-web";
    fake.next(VERSION_OK);
    fake.next(AUTH_OPENROUTER);
    await checkEngine("opencode");
    for (const call of fake.spawns) {
      expect(call.env?.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(call.env?.WEB_PASSWORD).toBeUndefined();
    }
  });
});

describe("Zeitlimit 5 s", () => {
  test("--version hängt: nach 5 s beendet (SIGINT, dann SIGKILL), Meldung", async () => {
    fake.next({ hang: true, ignoreSigint: true });
    const pending = checkEngine("opencode");
    fake.advance(ENGINE_CHECK_TIMEOUT_MS - 1);
    expect(fake.signals).toEqual([]);
    fake.advance(1);
    const status = await pending;
    expect(status).toMatchObject({ installed: false, loggedIn: false });
    expect(status.message).toBe("OpenCode antwortet nicht: opencode --version brauchte länger als 5 s");
    expect(fake.signals).toEqual(["SIGINT"]);
    fake.advance(OPENCODE_KILL_GRACE_MS);
    expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
    expect(fake.timerCount()).toBe(0);
  });

  test("auth list hängt: installiert, nicht prüfbar, Prozess beendet", async () => {
    fake.next(VERSION_OK);
    fake.next({ hang: true });
    const pending = checkEngine("opencode");
    await until(() => fake.spawns.length === 2);
    fake.advance(ENGINE_CHECK_TIMEOUT_MS);
    const status = await pending;
    expect(status).toMatchObject({ installed: true, loggedIn: false, loginUnknown: true, version: "1.18.33" });
    expect(status.message).toBe("OpenCode-Anmeldung nicht prüfbar: opencode auth list brauchte länger als 5 s");
    expect(fake.signals).toEqual(["SIGINT"]);
  });

  test("schnelle Antwort räumt den Zeitgeber ab", async () => {
    fake.next(VERSION_OK);
    fake.next(AUTH_OPENROUTER);
    await checkEngine("opencode");
    expect(fake.timerCount()).toBe(0);
    expect(fake.signals).toEqual([]);
  });
});

describe("Zwischenspeicher 60 s", () => {
  test("gleiches Ergebnis innerhalb von 60 s, danach neue Prüfung", async () => {
    fake.next(VERSION_OK);
    fake.next(AUTH_EMPTY);
    expect((await checkEngine("opencode")).loggedIn).toBe(false);
    fake.advance(ENGINE_CHECK_CACHE_MS - 1);
    expect((await checkEngine("opencode")).loggedIn).toBe(false);
    expect(fake.spawns).toHaveLength(2);

    fake.advance(1);
    fake.next(VERSION_OK);
    fake.next(AUTH_OPENROUTER);
    expect((await checkEngine("opencode")).loggedIn).toBe(true);
    expect(fake.spawns).toHaveLength(4);
  });

  test("auch ein Erfolg gilt nur 60 s: danach wird Version 2 erkannt", async () => {
    fake.next(VERSION_OK);
    fake.next(AUTH_OPENROUTER);
    expect((await checkEngine("opencode")).loggedIn).toBe(true);
    fake.advance(ENGINE_CHECK_CACHE_MS);
    fake.next({ stdout: "2.1.0\n", exitCode: 0 });
    expect(await checkEngine("opencode")).toMatchObject({ installed: false, version: "2.1.0" });
  });

  test("forgetEngineCheck verwirft das Ergebnis sofort", async () => {
    fake.next(VERSION_OK);
    fake.next(AUTH_OPENROUTER);
    expect((await checkEngine("opencode")).loggedIn).toBe(true);
    forgetEngineCheck();
    fake.next(VERSION_OK);
    fake.next(AUTH_EMPTY);
    expect(await checkEngine("opencode")).toMatchObject({ loggedIn: false, message: OPENCODE_NOT_LOGGED_IN });
    expect(fake.spawns).toHaveLength(4);
  });

  test("gleichzeitige Anfragen teilen sich eine Prüfung; inspectEngine nutzt dieselbe", async () => {
    fake.next(VERSION_OK);
    fake.next(AUTH_OPENROUTER);
    const [a, b, c] = await Promise.all([checkEngine("opencode"), checkEngineFromIndex("opencode"), inspectEngine("opencode")]);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(fake.spawns).toHaveLength(2);
  });

  test("anderer OPENCODE_PATH prüft neu", async () => {
    fake.next(VERSION_OK);
    fake.next(AUTH_OPENROUTER);
    await checkEngine("opencode");
    process.env.OPENCODE_PATH = "/opt/anders/opencode";
    fake.next({ throws: "ENOENT" });
    expect((await checkEngine("opencode")).installed).toBe(false);
  });
});
