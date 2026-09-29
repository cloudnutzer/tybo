/**
 * OpenCode-Motor, Prozess (Issue #127): Kommandozeile für neu und fortsetzen,
 * Prompt über stdin, PWD, Versionsprüfung, Zeitlimits, Abbruch mit SIGINT
 * und SIGKILL, Fehler, Umgebung. Prozessstart, Timer und Signale sind
 * Attrappen (tests/opencode-fixture.ts); kein Test startet ein echtes
 * opencode oder sendet echte Signale.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { abortEngineCalls, activeEngineCallCount, type EngineRequest } from "../src/lib/engines";
import {
  createOpenCodeEngine,
  OPENCODE_KILL_GRACE_MS,
  OPENCODE_NOT_INSTALLED,
  OPENCODE_NOT_LOGGED_IN,
  OPENCODE_VERSION_TIMEOUT_MS,
  opencodeArgs,
} from "../src/lib/engines/opencode";
import { tmpdir } from "os";
import { join } from "path";
import { setSettingsPath } from "../src/lib/settings";
import { filterSubprocessEnv, setMcpReaderForTests } from "../src/lib/subprocess-env";
import { classifyTurnTools } from "../src/lib/turn-tools";
import { until } from "./codex-fixture";
import { installOpenCodeFake, oc, type OpenCodeFake } from "./opencode-fixture";

const CWD = "/tmp/tybo-projekt";
const S = "ses_7c1d2e3f4a5bQwErTy";
let fake: OpenCodeFake;

beforeAll(() => {
  setMcpReaderForTests(() => new Set());
  // Keine echte config/settings.json: es gilt der Standard auto (--auto)
  setSettingsPath(join(tmpdir(), "tybo-opencode-engine-keine-einstellungen.json"));
});
afterAll(() => {
  setMcpReaderForTests(null);
  setSettingsPath();
});
beforeEach(() => void (fake = installOpenCodeFake()));
afterEach(() => fake.restore());

const request = (extra: Partial<EngineRequest> = {}): EngineRequest => ({
  prompt: "Wie spät ist es?",
  streaming: true,
  timeoutMs: 60_000,
  cwd: CWD,
  ...extra,
});

const run = (extra: Partial<EngineRequest> = {}) => createOpenCodeEngine().run(request(extra));

/** Wartet, bis der Lauf (nach der Versionsprüfung) gestartet und angemeldet ist */
const running = () => until(() => fake.runCommands().length > 0 && activeEngineCallCount() === 1);

describe("Kommandozeile", () => {
  test("neuer Lauf: run --format json --auto --dir <projekt>, Prompt über stdin, kein Positionsargument, eigene Prozessgruppe", async () => {
    fake.next({ events: oc.reply(S, "Zehn Uhr") });
    const r = await run();
    expect(r).toMatchObject({ engine: "opencode", text: "Zehn Uhr", sessionId: S, isError: false });
    expect(fake.runCommand()).toEqual(["opencode", "run", "--format", "json", "--auto", "--dir", CWD]);
    const call = fake.spawns.at(-1)!;
    // Der Prompt steht nur auf stdin; OpenCode nimmt stdin als Nachricht, wenn keine angegeben ist
    expect(call.stdin).toBe("Wie spät ist es?");
    expect(call.cmd).not.toContain("");
    expect(call.cmd).not.toContain("Wie spät ist es?");
    expect(call.cwd).toBe(CWD);
    expect(call.env?.PWD).toBe(CWD);
    expect(call.env?.TYBO_SUBPROCESS).toBe("1");
    expect(call.detached).toBe(process.platform !== "win32");
    if (process.platform === "darwin") expect(call.cmd.slice(0, 2)).toEqual(["/usr/bin/caffeinate", "-i"]);
  });

  test("Modell und Variante nur, wenn angegeben", async () => {
    fake.next({ events: oc.reply(S, "ok") });
    await run({ model: "openrouter/anthropic/claude-opus-5.5", effort: "high" });
    expect(fake.runCommand()).toEqual([
      "opencode", "run", "--format", "json", "--model", "openrouter/anthropic/claude-opus-5.5", "--variant=high", "--auto", "--dir", CWD,
    ]);
  });

  test("die Folgeanfrage ruft opencode run --format json … --session <id>", async () => {
    fake.next({ events: oc.reply(S, "Erste") });
    const first = await run();
    expect(first.sessionId).toBe(S);
    fake.next({ events: oc.reply(S, "Zweite") });
    const second = await run({ resumeSessionId: first.sessionId });
    expect(second).toMatchObject({ text: "Zweite", sessionId: S, isError: false });
    const cmd = fake.runCommand();
    expect(cmd.slice(0, 4)).toEqual(["opencode", "run", "--format", "json"]);
    expect(cmd.slice(-2)).toEqual(["--session", S]);
    expect(fake.spawns.at(-1)!.stdin).toBe("Wie spät ist es?");
  });

  test("OPENCODE_PATH ersetzt opencode, auch bei der Versionsprüfung", async () => {
    const before = process.env.OPENCODE_PATH;
    process.env.OPENCODE_PATH = "/opt/oc/bin/opencode";
    try {
      fake.next({ events: oc.reply(S, "ok") });
      await run();
      const cmds = fake.spawns.map((s) => (s.cmd[0] === "/usr/bin/caffeinate" ? s.cmd.slice(2) : s.cmd));
      expect(cmds[0]).toEqual(["/opt/oc/bin/opencode", "--version"]);
      expect(cmds[1]![0]).toBe("/opt/oc/bin/opencode");
    } finally {
      if (before === undefined) delete process.env.OPENCODE_PATH;
      else process.env.OPENCODE_PATH = before;
    }
  });

  test("ungültige Angaben werden nie als Option durchgereicht, kein Prozess", async () => {
    for (const extra of [{ model: "--dangerous" }, { effort: "HIGH; rm" }, { resumeSessionId: "-x" }] as Partial<EngineRequest>[]) {
      const r = await run(extra);
      expect(r).toMatchObject({ engine: "opencode", isError: true, errorKind: "other" });
    }
    expect(() => opencodeArgs({ cwd: CWD, model: "a b" })).toThrow("Ungültiges OpenCode-Modell");
    expect(fake.spawns).toHaveLength(0);
  });

  test("leerer Prompt: abgelehnt, bevor ein Prozess startet", async () => {
    const r = await run({ prompt: "  \n" });
    expect(r).toMatchObject({ isError: true, errorKind: "other" });
    expect(fake.spawns).toHaveLength(0);
  });
});

describe("Versionsprüfung", () => {
  test("vor dem ersten Lauf opencode --version, danach nicht mehr", async () => {
    fake.next({ events: oc.reply(S, "eins") });
    fake.next({ events: oc.reply(S, "zwei") });
    await run();
    await run();
    expect(fake.versionChecks()).toBe(1);
    expect(fake.command(0)).toEqual(["opencode", "--version"]);
  });

  test("Version 2.0.16 wird mit klarer Meldung abgelehnt, kein Lauf", async () => {
    fake.version = "2.0.16";
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await run();
      expect(r).toMatchObject({ engine: "opencode", isError: true, errorKind: "not_installed" });
      expect(r.text).toContain("OpenCode 2 wird noch nicht unterstützt");
      expect(r.text).toContain("2.0.16");
      expect(fake.runCommands()).toHaveLength(0);
    } finally {
      errors.mockRestore();
    }
  });

  test("Ablehnung wird nicht gemerkt: nach dem Wechsel auf V1 läuft der nächste Auftrag", async () => {
    fake.version = "2.0.16";
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await run();
      fake.version = "1.18.33";
      fake.next({ events: oc.reply(S, "wieder da") });
      expect(await run()).toMatchObject({ text: "wieder da", isError: false });
      expect(fake.versionChecks()).toBe(2);
    } finally {
      errors.mockRestore();
    }
  });

  test("fehlende oder unlesbare Version: Fehler other, kein Lauf", async () => {
    fake.version = null;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      fake.next({ stdout: "" });
      expect(await run()).toMatchObject({ isError: true, errorKind: "other" });
      fake.next({ stdout: "opencode unbekannt\n" });
      const r = await run();
      expect(r).toMatchObject({ isError: true, errorKind: "other" });
      expect(r.text).toContain("nicht erkennbar");
      expect(fake.runCommands()).toHaveLength(0);
    } finally {
      errors.mockRestore();
    }
  });

  test("opencode fehlt: Start wirft oder Exit 127 ergibt not_installed", async () => {
    fake.version = null;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      fake.next({ throws: "ENOENT: no such file or directory, posix_spawn 'opencode'" });
      expect(await run()).toMatchObject({ isError: true, errorKind: "not_installed", text: OPENCODE_NOT_INSTALLED });
      fake.next({ exitCode: 127, stderr: "opencode: command not found" });
      expect(await run()).toMatchObject({ isError: true, errorKind: "not_installed" });
      expect(activeEngineCallCount()).toBe(0);
    } finally {
      errors.mockRestore();
    }
  });

  test("hängt die Versionsprüfung, greift ihr Zeitlimit: timedOut ohne Fehlerart (kein Fallback), Prozess beendet, kein Lauf", async () => {
    fake.version = null;
    fake.next({ hang: true });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = run();
      await until(() => fake.spawns.length === 1);
      fake.advance(OPENCODE_VERSION_TIMEOUT_MS);
      const r = await pending;
      expect(r).toMatchObject({ engine: "opencode", isError: true, timedOut: true, timeoutKind: "total" });
      expect(r.errorKind).toBeUndefined();
      expect(r.aborted).toBeFalsy();
      expect(fake.signals[0]).toBe("SIGINT");
      expect(fake.runCommands()).toHaveLength(0);
      expect(activeEngineCallCount()).toBe(0);
    } finally {
      errors.mockRestore();
    }
  });

  test("Gesamtzeit läuft schon in der Versionsprüfung ab: timedOut ohne Fehlerart, kein Lauf", async () => {
    fake.version = null;
    fake.next({ hang: true });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = run({ streaming: false, timeoutMs: 2_000 });
      await until(() => fake.spawns.length === 1);
      fake.advance(2_000);
      expect(await pending).toEqual({ engine: "opencode", text: "", isError: true, timedOut: true });
      expect(fake.signals[0]).toBe("SIGINT");
      expect(fake.runCommands()).toHaveLength(0);
      expect(activeEngineCallCount()).toBe(0);
    } finally {
      errors.mockRestore();
    }
  });

  test("Abbruch während der Versionsprüfung (ohne Ausführung): zuerst SIGINT, danach startet kein Lauf", async () => {
    fake.version = null;
    // Die Versionsantwort wird zurückgehalten und SIGINT ignoriert, damit sie nach dem Abbruch noch kommt
    fake.next({ hang: true, ignoreSigint: true });
    const pending = run({ abortKey: "topic:-100:9" });
    await until(() => fake.spawns.length === 1 && activeEngineCallCount() === 1);
    expect(abortEngineCalls("topic:-100:9")).toBe(1);
    expect(fake.signals).toEqual(["SIGINT"]);
    // Version 1 erst nach dem Abbruch liefern
    fake.emit({ version: "1.18.33" });
    fake.finish(0);
    const r = await pending;
    expect(r).toMatchObject({ engine: "opencode", isError: true, aborted: true });
    expect(r.timedOut).toBeFalsy();
    expect(r.errorKind).toBeUndefined();
    // Auch eine Version 1 nach dem Abbruch startet keinen Lauf und wird nicht gemerkt
    expect(fake.runCommands()).toHaveLength(0);
    expect(activeEngineCallCount()).toBe(0);
    fake.version = "1.18.33";
    fake.next({ events: oc.reply(S, "danach") });
    expect(await run()).toMatchObject({ text: "danach", isError: false });
    expect(fake.versionChecks()).toBe(2);
  });
});

describe("Ergebnis und Fehler", () => {
  test("Werkzeuge, Nutzung und Kosten; webfetch macht den Turn fremd", async () => {
    fake.next({
      events: [oc.stepStart(S), oc.tool(S, "c1", "webfetch", { url: "https://example.org" }), oc.stepFinish(S, 0.5), ...oc.reply(S, "Gelesen")],
    });
    const r = await run();
    expect(r).toMatchObject({ isError: false, text: "Gelesen" });
    expect(r.costUsd).toBeCloseTo(0.501, 10);
    expect(r.usage).toEqual({ inputTokens: 28, cachedInputTokens: 8, outputTokens: 6, reasoningOutputTokens: 2 });
    expect(r.tools?.uses).toEqual([{ name: "WebFetch" }]);
    const verdict = classifyTurnTools(r.tools, CWD);
    expect(verdict).toEqual({ status: "foreign", reasons: ["WebFetch"] });
  });

  test("ProviderAuthError: isError, errorKind auth, Anmelde-Hinweis", async () => {
    fake.next({
      events: [oc.stepStart(S), oc.error(S, "ProviderAuthError", { providerID: "openrouter", message: "No API key" })],
      exitCode: 1,
    });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await run();
      expect(r).toMatchObject({ engine: "opencode", isError: true, errorKind: "auth", text: OPENCODE_NOT_LOGGED_IN });
      expect(r.aborted).toBeFalsy();
      expect(r.timedOut).toBeFalsy();
    } finally {
      errors.mockRestore();
    }
  });

  test("APIError 429: errorKind rate_limit", async () => {
    fake.next({ events: [oc.error(S, "APIError", { message: "Too Many Requests", statusCode: 429, isRetryable: true })], exitCode: 1 });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await run()).toMatchObject({ isError: true, errorKind: "rate_limit" });
    } finally {
      errors.mockRestore();
    }
  });

  test("Exit 1 nach Text: Fehler", async () => {
    fake.next({ events: oc.reply(S, "Halbe Antwort"), exitCode: 1 });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await run()).toMatchObject({ isError: true, errorKind: "other", sessionId: S });
    } finally {
      errors.mockRestore();
    }
  });

  test("Start des Laufs wirft: not_installed, nichts im Register", async () => {
    fake.next({ throws: "ENOENT" });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await run()).toMatchObject({ isError: true, errorKind: "not_installed" });
      expect(activeEngineCallCount()).toBe(0);
    } finally {
      errors.mockRestore();
    }
  });

  test("JSON-Modus (streaming false): gleiches Ergebnis, keine Rückrufe", async () => {
    fake.next({ events: [oc.stepStart(S), oc.tool(S, "c1", "websearch", { query: "x" }), ...oc.reply(S, "Eine ausreichend lange Antwort für den Rückruf.")] });
    const tools: string[] = [];
    const texts: string[] = [];
    const r = await run({ streaming: false, onToolStart: (n) => tools.push(n), onFirstText: (s) => texts.push(s) });
    expect(r).toMatchObject({ isError: false, text: "Eine ausreichend lange Antwort für den Rückruf." });
    expect(tools).toEqual([]);
    expect(texts).toEqual([]);
  });

  test("onToolStart mit Anzeigenamen höchstens alle 5 s, Werkzeugliste trotzdem vollständig", async () => {
    fake.next({ events: [oc.stepStart(S), oc.tool(S, "c1", "read", { filePath: `${CWD}/a.md` })], hang: true });
    const tools: string[] = [];
    const pending = run({ onToolStart: (n) => tools.push(n) });
    await running();
    await until(() => tools.length === 1);
    fake.emit(oc.tool(S, "c2", "bash", { command: "ls" }));
    // Die Zeile muss gelesen sein, bevor die Uhr weiterläuft
    await new Promise((r) => setTimeout(r, 5));
    fake.advance(5_000);
    fake.emit(oc.tool(S, "c3", "webfetch", { url: "https://example.org" }));
    for (const e of oc.reply(S, "fertig")) fake.emit(e);
    await new Promise((r) => setTimeout(r, 5));
    fake.finish(0);
    const r = await pending;
    expect(tools).toEqual(["Reading file", "Fetching page"]);
    expect(r.tools?.uses.map((u) => u.name)).toEqual(["Read", "Bash", "WebFetch"]);
  });
});

describe("Abbruch und Zeitlimits", () => {
  test("abortEngineCalls schickt zuerst SIGINT, nach 3 s SIGKILL; aborted, Register leer", async () => {
    fake.next({ events: [oc.stepStart(S)], hang: true, ignoreSigint: true });
    const pending = run({ abortKey: "topic:-100:7" });
    await running();
    expect(abortEngineCalls("topic:-100:7")).toBe(1);
    expect(fake.signals).toEqual(["SIGINT"]);
    fake.advance(OPENCODE_KILL_GRACE_MS - 1);
    expect(fake.signals).toEqual(["SIGINT"]);
    fake.advance(1);
    expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
    const r = await pending;
    expect(r).toMatchObject({ engine: "opencode", aborted: true, isError: true });
    expect(r.timedOut).toBeFalsy();
    expect(r.errorKind).toBeUndefined();
    expect(activeEngineCallCount()).toBe(0);
    expect(fake.timerCount()).toBe(0);
  });

  test("mehrfacher Abbruch sendet nichts doppelt", async () => {
    fake.next({ hang: true, ignoreSigint: true });
    const pending = run({ abortKey: "k" });
    await running();
    abortEngineCalls("k");
    abortEngineCalls("k");
    fake.advance(OPENCODE_KILL_GRACE_MS);
    abortEngineCalls("k");
    fake.advance(OPENCODE_KILL_GRACE_MS);
    expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
    expect((await pending).aborted).toBe(true);
  });

  test("Gesamtzeit im Streaming: timedOut total, Session bleibt, Bericht, SIGINT, kein Fallback-Fehler", async () => {
    fake.next({ events: [oc.stepStart(S), oc.tool(S, "c1", "bash", { command: "sleep 100" }), oc.text(S, "t1", "Ich warte noch")], hang: true });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = run({ timeoutMs: 30_000 });
      await running();
      fake.advance(30_000);
      const r = await pending;
      expect(r).toMatchObject({ engine: "opencode", isError: true, timedOut: true, timeoutKind: "total", sessionId: S, lastText: "Ich warte noch" });
      expect(r.aborted).toBeFalsy();
      expect(r.errorKind).toBeUndefined();
      expect(r.steps).toEqual([{ name: "Bash", input: "sleep 100" }]);
      expect(r.stoppedAfterMs).toBe(30_000);
      expect(fake.signals[0]).toBe("SIGINT");
      expect(activeEngineCallCount()).toBe(0);
    } finally {
      errors.mockRestore();
    }
  });

  test("Leerlauf im Streaming: timeoutKind idle", async () => {
    fake.next({ events: [oc.stepStart(S)], hang: true });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = run({ idleTimeoutMs: 10_000 });
      await running();
      fake.advance(10_000);
      const r = await pending;
      expect(r).toMatchObject({ timedOut: true, timeoutKind: "idle", sessionId: S });
      expect(r.idleForMs).toBe(10_000);
    } finally {
      errors.mockRestore();
    }
  });

  test("JSON-Modus: nur Gesamtzeit, Ergebnis ohne Bericht", async () => {
    fake.next({ events: [oc.stepStart(S)], hang: true });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = run({ streaming: false, timeoutMs: 20_000, idleTimeoutMs: 1_000 });
      await running();
      fake.advance(1_000);
      expect(activeEngineCallCount()).toBe(1);
      fake.advance(19_000);
      expect(await pending).toEqual({ engine: "opencode", text: "", isError: true, timedOut: true });
    } finally {
      errors.mockRestore();
    }
  });

  test("Abbruch nach dem Zeitlimit bleibt ein Zeitlimit, kein zweites SIGINT", async () => {
    fake.next({ hang: true, ignoreSigint: true });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = run({ timeoutMs: 1_000, abortKey: "k2" });
      await running();
      fake.advance(1_000);
      abortEngineCalls("k2");
      fake.advance(OPENCODE_KILL_GRACE_MS);
      const r = await pending;
      expect(r.timedOut).toBe(true);
      expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
    } finally {
      errors.mockRestore();
    }
  });

  test("Prompt lässt sich nicht übergeben: Prozess beendet, isError, Register leer", async () => {
    fake.next({ hang: true, stdinEndRejects: "EPIPE" });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await run();
      expect(r).toMatchObject({ isError: true, errorKind: "other" });
      expect(r.text).toContain("nicht angenommen");
      expect(fake.signals[0]).toBe("SIGINT");
      expect(activeEngineCallCount()).toBe(0);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("Umgebung und Diagnosen", () => {
  const SECRET = "sk-or-v1-test-abcdef0123456789abcdef012345";

  test("Geheimnisse nur über TYBO_SUBPROCESS_ENV_ALLOW, auch ANTHROPIC_API_KEY nicht; PWD ist das Projekt", async () => {
    const saved = { ...process.env };
    process.env.OPENROUTER_API_KEY = SECRET;
    process.env.ANTHROPIC_API_KEY = "sk-ant-erfunden-0123456789";
    process.env.EIGENER_TOKEN = "erfunden";
    process.env.TYBO_SUBPROCESS_ENV_ALLOW = "EIGENER_TOKEN";
    process.env.PWD = "/irgendwo/anders";
    try {
      fake.next({ events: oc.reply(S, "ok") });
      await run();
      const env = fake.spawns.at(-1)!.env!;
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.EIGENER_TOKEN).toBe("erfunden");
      expect(env.PWD).toBe(CWD);
      // Auch die Versionsprüfung bekommt keine Geheimnisse
      expect(fake.spawns[0]!.env?.OPENROUTER_API_KEY).toBeUndefined();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  test("MCP-Verweise geben bei OpenCode Geheimnisse frei, Anbieter-Schlüssel nie (#128)", () => {
    setMcpReaderForTests(() => new Set(["NOTION_TOKEN", "ANTHROPIC_API_KEY"]));
    try {
      const env = { HOME: "/home/alex", NOTION_TOKEN: "erfunden", ANTHROPIC_API_KEY: "erfunden" };
      const opencode = filterSubprocessEnv({ env, engine: "opencode" });
      expect(opencode.env.NOTION_TOKEN).toBe("erfunden");
      expect(opencode.removed).toEqual(["ANTHROPIC_API_KEY"]);
      // Zum Vergleich: Claude behält beide
      expect(filterSubprocessEnv({ env, engine: "claude" }).removed).toEqual([]);
    } finally {
      setMcpReaderForTests(() => new Set());
    }
  });

  test("stderr und Fehlermeldungen: weder Log noch Fehlertext enthalten Zugangsdaten", async () => {
    fake.next({ events: [oc.error(S, "APIError", { message: `bad key ${SECRET}`, statusCode: 400 })], stderr: `Authorization: Bearer ${SECRET}`, exitCode: 1 });
    const lines: string[] = [];
    const errors = spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    try {
      const r = await run();
      expect(r.isError).toBe(true);
      expect(r.text).not.toContain(SECRET);
      expect(lines.join("\n")).not.toContain(SECRET);
      expect(lines.join("\n")).toContain("[OpenCode] stderr:");
    } finally {
      errors.mockRestore();
    }
  });
});
