/**
 * Codex-Motor, Prozess (Issue #123): Kommandozeile für neu und fortsetzen,
 * Prompt über stdin, Zeitlimits, Abbruch mit SIGINT und SIGKILL, Fehler.
 * Prozessstart, Timer und Signale sind Attrappen (tests/codex-fixture.ts);
 * kein Test startet ein echtes codex oder sendet echte Signale.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { abortEngineCalls, activeEngineCallCount, type EngineRequest } from "../src/lib/engines";
import { CODEX_KILL_GRACE_MS, codexArgs, createCodexEngine, redactCodexDiagnostic } from "../src/lib/engines/codex";
import { setSettingsPath } from "../src/lib/settings";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { classifyTurnTools } from "../src/lib/turn-tools";
import { ev, installCodexFake, until, type CodexFake } from "./codex-fixture";

const CWD = "/tmp/tybo-projekt";
let fake: CodexFake;

// Keine Einstellungsdatei: Rechte-Stufe full (Standard)
beforeAll(() => {
  setMcpReaderForTests(() => new Set());
  setSettingsPath("/tmp/tybo-codex-engine-test/fehlt/settings.json");
});
afterAll(() => {
  setMcpReaderForTests(null);
  setSettingsPath();
});
/** Projekt-Kontext und Rechte (Issue #124), Standard full */
const DOC = ["-c", 'project_doc_fallback_filenames=["CLAUDE.md"]', "-c", "project_doc_max_bytes=65536"];
const FULL_NEW = ["--dangerously-bypass-approvals-and-sandbox", "-c", 'approval_policy="never"'];
const FULL_RESUME = ["-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"'];
beforeEach(() => void (fake = installCodexFake()));
afterEach(() => fake.restore());

const request = (extra: Partial<EngineRequest> = {}): EngineRequest => ({
  prompt: "Wie spät ist es?",
  streaming: true,
  timeoutMs: 60_000,
  cwd: CWD,
  ...extra,
});

const run = (extra: Partial<EngineRequest> = {}) => createCodexEngine().run(request(extra));

describe("Kommandozeile", () => {
  test("neuer Lauf: exec --json -C <projekt> --skip-git-repo-check -, Prompt über stdin, eigene Prozessgruppe", async () => {
    fake.next({ events: [ev.started("t-1"), ev.message("m", "Zehn Uhr"), ev.completed()] });
    const r = await run();
    expect(r).toMatchObject({ engine: "codex", text: "Zehn Uhr", sessionId: "t-1", isError: false });
    expect(fake.command()).toEqual(["codex", "exec", "--json", ...DOC, ...FULL_NEW, "-C", CWD, "--skip-git-repo-check", "-"]);
    const call = fake.spawns[0]!;
    expect(call.stdin).toBe("Wie spät ist es?");
    expect(call.cwd).toBe(CWD);
    expect(call.detached).toBe(process.platform !== "win32");
    expect(call.env?.TYBO_SUBPROCESS).toBe("1");
    if (process.platform === "darwin") expect(call.cmd.slice(0, 2)).toEqual(["/usr/bin/caffeinate", "-i"]);
  });

  test("Modell und Effort nur, wenn angegeben", async () => {
    fake.next({ events: [ev.completed()] });
    await run({ model: "gpt-5.5-codex", effort: "xhigh" });
    expect(fake.command()).toEqual([
      "codex", "exec", "--json", "-m", "gpt-5.5-codex", "-c", 'model_reasoning_effort="xhigh"',
      ...DOC, ...FULL_NEW, "-C", CWD, "--skip-git-repo-check", "-",
    ]);
  });

  test("thread.started ergibt die Session-ID, die Folgeanfrage ruft codex exec resume --json … <id> -", async () => {
    fake.next({ events: [ev.started("0199a213-81c0-7800-8aa1-bbab2a035a53"), ev.message("m", "Erste"), ev.completed()] });
    const first = await run();
    expect(first.sessionId).toBe("0199a213-81c0-7800-8aa1-bbab2a035a53");
    fake.next({ events: [ev.started(first.sessionId!), ev.message("m", "Zweite"), ev.completed()] });
    const second = await run({ resumeSessionId: first.sessionId, model: "gpt-5.5-codex" });
    expect(second).toMatchObject({ text: "Zweite", sessionId: first.sessionId, isError: false });
    const cmd = fake.command(1);
    expect(cmd.slice(0, 3)).toEqual(["codex", "exec", "resume"]);
    expect(cmd).toContain("--json");
    expect(cmd.slice(-2)).toEqual([first.sessionId!, "-"]);
    // resume kennt kein -C: das Arbeitsverzeichnis kommt aus dem cwd des Prozesses
    expect(cmd).not.toContain("-C");
    expect(fake.spawns[1]!.cwd).toBe(CWD);
    expect(cmd).toEqual([
      "codex", "exec", "resume", "--json", "-m", "gpt-5.5-codex", ...DOC, ...FULL_RESUME,
      "--skip-git-repo-check", first.sessionId!, "-",
    ]);
  });

  test("CODEX_PATH ersetzt codex", async () => {
    const before = process.env.CODEX_PATH;
    process.env.CODEX_PATH = "/opt/codex/bin/codex";
    try {
      fake.next({ events: [ev.completed()] });
      await run();
      expect(fake.command()[0]).toBe("/opt/codex/bin/codex");
    } finally {
      if (before === undefined) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = before;
    }
  });

  test("ungültige Angaben werden nie als Option durchgereicht", async () => {
    expect(() => codexArgs({ cwd: CWD, effort: 'high" -c sandbox_mode="danger' })).toThrow("Ungültige Effort-Stufe");
    expect(() => codexArgs({ cwd: CWD, model: "--dangerously-bypass-approvals-and-sandbox" })).toThrow("Ungültiges Codex-Modell");
    expect(() => codexArgs({ cwd: CWD, resumeSessionId: "--last" })).toThrow("Ungültige Codex-Session");
    const r = await run({ resumeSessionId: "--last" });
    expect(r).toMatchObject({ engine: "codex", isError: true });
    expect(fake.spawns).toHaveLength(0);
  });
});

describe("Ergebnis", () => {
  test("Nutzung und Werkzeuge; Mail-MCP macht den Turn fremd", async () => {
    fake.next({ events: [ev.started("t"), ev.mcp("i1", "gmail", "search_threads"), ev.message("m", "Drei neue Mails."), ev.completed()] });
    const r = await run();
    expect(r.usage).toEqual({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, reasoningOutputTokens: 1 });
    expect(r.tools?.uses).toEqual([{ name: "mcp__gmail__search_threads" }]);
    expect(r.tools?.cwd).toBe(CWD);
    expect(classifyTurnTools(r.tools, CWD).status).toBe("foreign");
    expect(r.costUsd).toBeUndefined();
  });

  test("„You’ve hit your usage limit“ ergibt isError mit Art usage_limit", async () => {
    fake.next({ events: [ev.started("t"), ev.failed("You’ve hit your usage limit. Upgrade to Pro or try again at 8:00 PM.")], exitCode: 1 });
    const r = await run();
    expect(r).toMatchObject({ engine: "codex", isError: true, errorKind: "usage_limit", sessionId: "t" });
    expect(r.aborted).toBeFalsy();
    expect(r.timedOut).toBeFalsy();
  });

  test("ohne turn.completed und mit Exit 1: Fehler, obwohl Text da ist", async () => {
    fake.next({ events: [ev.started("t"), ev.message("m", "Zwischenstand, ich mache weiter")], exitCode: 1 });
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.text).not.toBe("Zwischenstand, ich mache weiter");
  });

  test("nur stderr und Exit 1 (nicht angemeldet): Fehler mit Meldung, stderr wird gelesen", async () => {
    fake.next({ stderr: "Error: Not logged in. Please run `codex login`.\n", exitCode: 1 });
    const r = await run();
    expect(r).toMatchObject({ isError: true, errorKind: "auth" });
    expect(r.text).toContain("Not logged in");
  });

  test("Start wirft: Fehler not_installed, nichts im Register", async () => {
    fake.next({ throws: "ENOENT: codex" });
    const r = await run();
    expect(r).toMatchObject({ engine: "codex", isError: true, errorKind: "not_installed" });
    expect(activeEngineCallCount()).toBe(0);
  });

  test("JSON-Modus (streaming false): gleiches Ergebnis, keine Rückrufe", async () => {
    const tools: string[] = [];
    fake.next({ events: [ev.started("t"), ev.webSearch("w", "Wetter"), ev.message("m", "Es regnet heute den ganzen Tag lang."), ev.completed()] });
    const r = await run({ streaming: false, onToolStart: (n) => tools.push(n), onFirstText: (s) => tools.push(s) });
    expect(r).toMatchObject({ text: "Es regnet heute den ganzen Tag lang.", sessionId: "t", isError: false });
    expect(r.tools?.uses.map((u) => u.name)).toEqual(["WebSearch"]);
    expect(tools).toEqual([]);
  });
});

describe("Fortschritt", () => {
  test("onToolStart mit Anzeigenamen höchstens alle 5 s, Werkzeugliste trotzdem vollständig", async () => {
    fake.next({ events: [ev.started("t")], hang: true });
    const tools: string[] = [];
    const running = run({ onToolStart: (n) => tools.push(n) });
    await until(() => activeEngineCallCount() === 1);
    fake.emit(ev.webSearch("a", "eins"));
    fake.emit(ev.command("b", "ls"));
    await until(() => tools.length === 1);
    fake.advance(5_000);
    fake.emit(ev.mcp("c", "gmail", "read"));
    await until(() => tools.length === 2);
    fake.emit(ev.message("m", "fertig"));
    fake.emit(ev.completed());
    fake.finish(0);
    const r = await running;
    expect(r.isError).toBe(false);
    expect(tools).toEqual(["Searching the web", "Using gmail"]);
    expect(r.tools?.uses.map((u) => u.name)).toEqual(["WebSearch", "Bash", "mcp__gmail__read"]);
    expect(fake.signals).toEqual([]);
  });
});

describe("Abbruch", () => {
  test("abortEngineCalls schickt zuerst SIGINT, nach 3 s SIGKILL; aborted, Register leer", async () => {
    fake.next({ events: [ev.started("t")], hang: true });
    const running = run({ abortKey: "topic:codex" });
    await until(() => activeEngineCallCount() === 1);
    expect(abortEngineCalls("topic:codex")).toBe(1);
    expect(fake.signals).toEqual(["SIGINT"]);
    const r = await running;
    expect(r).toMatchObject({ engine: "codex", aborted: true, isError: true });
    expect(r.timedOut).toBeFalsy();
    expect(activeEngineCallCount()).toBe(0);
    fake.advance(CODEX_KILL_GRACE_MS - 1);
    expect(fake.signals).toEqual(["SIGINT"]);
    fake.advance(1);
    expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  test("mehrfacher Abbruch sendet nichts doppelt", async () => {
    fake.next({ events: [], hang: true });
    const running = run({ abortKey: "topic:zweimal" });
    await until(() => activeEngineCallCount() === 1);
    abortEngineCalls("topic:zweimal");
    abortEngineCalls("topic:zweimal");
    const r = await running;
    expect(r.aborted).toBe(true);
    expect(abortEngineCalls("topic:zweimal")).toBe(0);
    fake.advance(CODEX_KILL_GRACE_MS * 3);
    expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  test("Rückrufe nach dem Abbruch bleiben aus", async () => {
    fake.next({ events: [ev.started("t")], hang: true });
    const tools: string[] = [];
    const running = run({ abortKey: "topic:still", onToolStart: (n) => tools.push(n) });
    await until(() => activeEngineCallCount() === 1);
    fake.emit(ev.webSearch("a", "x"));
    await until(() => tools.length === 1);
    abortEngineCalls("topic:still");
    await running;
    expect(tools).toEqual(["Searching the web"]);
  });
});

describe("Zeitlimit", () => {
  test("Gesamtzeit im Streaming: timedOut total, Session bleibt, Angaben für den Bericht, SIGINT", async () => {
    fake.next({ events: [ev.started("t-lang"), ev.message("m", "Ich lese jetzt alle Dateien durch."), ev.command("c", "grep -r foo .")], hang: true });
    const running = run({ timeoutMs: 10_000 });
    await until(() => activeEngineCallCount() === 1);
    await new Promise((r) => setTimeout(r, 5));
    fake.advance(10_000);
    const r = await running;
    expect(r).toMatchObject({
      engine: "codex",
      isError: true,
      timedOut: true,
      timeoutKind: "total",
      sessionId: "t-lang",
      steps: [{ name: "Bash", input: "grep -r foo ." }],
      lastText: "Ich lese jetzt alle Dateien durch.",
      stoppedAfterMs: 10_000,
    });
    expect(r.aborted).toBeFalsy();
    expect(r.tools?.uses).toEqual([{ name: "Bash", command: "grep -r foo ." }]);
    expect(fake.signals).toEqual(["SIGINT"]);
    expect(activeEngineCallCount()).toBe(0);
  });

  test("Leerlauf im Streaming: timeoutKind idle, idleForMs gemessen", async () => {
    fake.next({ events: [ev.started("t-still")], hang: true });
    const running = run({ timeoutMs: 600_000, idleTimeoutMs: 1_000 });
    await until(() => activeEngineCallCount() === 1);
    await new Promise((r) => setTimeout(r, 5));
    fake.advance(1_000);
    const r = await running;
    expect(r).toMatchObject({ timedOut: true, timeoutKind: "idle", sessionId: "t-still", idleForMs: 1_000 });
  });

  test("JSON-Modus: nur Gesamtzeit, Ergebnis wie bei Claude ohne Bericht", async () => {
    fake.next({ events: [ev.started("t")], hang: true });
    const running = run({ streaming: false, timeoutMs: 2_000, idleTimeoutMs: 10 });
    await until(() => activeEngineCallCount() === 1);
    fake.advance(1_999);
    expect(fake.signals).toEqual([]);
    fake.advance(1);
    const r = await running;
    expect(r).toEqual({ engine: "codex", text: "", isError: true, timedOut: true });
  });

  test("Abbruch nach dem Zeitlimit bleibt ein Zeitlimit, kein zweites SIGINT", async () => {
    fake.next({ events: [], hang: true });
    const running = run({ timeoutMs: 100, abortKey: "topic:beides" });
    await until(() => activeEngineCallCount() === 1);
    fake.advance(100);
    abortEngineCalls("topic:beides");
    const r = await running;
    expect(r.timedOut).toBe(true);
    expect(fake.signals).toEqual(["SIGINT"]);
  });
});

describe("Prompt über stdin scheitert", () => {
  let errors: ReturnType<typeof spyOn>;
  beforeEach(() => void (errors = spyOn(console, "error").mockImplementation(() => {})));
  afterEach(() => errors.mockRestore());

  test("write wirft: Prozess mit SIGINT beendet, Ende abgewartet, Register leer, isError, keine Zeitlimits", async () => {
    fake.next({ events: [ev.started("t")], hang: true, stdinWriteThrows: "EPIPE: broken pipe, write" });
    const r = await run({ abortKey: "topic:epipe" });
    expect(r).toMatchObject({ engine: "codex", isError: true, errorKind: "other" });
    expect(r.text).toContain("EPIPE");
    expect(r.aborted).toBeFalsy();
    expect(r.timedOut).toBeFalsy();
    expect(fake.signals).toEqual(["SIGINT"]);
    expect(activeEngineCallCount()).toBe(0);
    expect(abortEngineCalls("topic:epipe")).toBe(0);
    // Nur noch das SIGKILL der Nachfrist, kein Zeitlimit mehr
    fake.advance(60_000 * 2);
    expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  test("end lehnt ab (EPIPE): dasselbe, Fallback bekommt ein normales Fehlerergebnis", async () => {
    fake.next({ events: [], hang: true, stdinEndRejects: "EPIPE: broken pipe" });
    const r = await run({ abortKey: "topic:epipe-end", idleTimeoutMs: 1_000 });
    expect(r).toMatchObject({ engine: "codex", isError: true, errorKind: "other" });
    expect(r.text).toContain("EPIPE");
    expect(fake.signals).toEqual(["SIGINT"]);
    expect(activeEngineCallCount()).toBe(0);
    fake.advance(60_000 * 2);
    expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  test("stdin.end bleibt hängen: Gesamtzeit greift, Prozess beendet, Register und Timer leer", async () => {
    fake.next({ events: [ev.started("t-stau")], hang: true, stdinEndPending: true });
    const running = run({ abortKey: "topic:stau", timeoutMs: 10_000 });
    await until(() => activeEngineCallCount() === 1);
    await new Promise((r) => setTimeout(r, 5));
    fake.advance(10_000);
    const r = await running;
    expect(r).toMatchObject({ engine: "codex", isError: true, timedOut: true, timeoutKind: "total", sessionId: "t-stau" });
    expect(r.aborted).toBeFalsy();
    expect(fake.signals).toEqual(["SIGINT"]);
    expect(activeEngineCallCount()).toBe(0);
    expect(abortEngineCalls("topic:stau")).toBe(0);
    // Timer bereinigt: nur noch das SIGKILL der Nachfrist, kein zweites Zeitlimit
    fake.advance(60_000 * 2);
    expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  test("write liefert eine Promise, die später ablehnt: isError, geregelt beendet, Ende abgewartet, Register leer", async () => {
    fake.next({ events: [ev.started("t")], hang: true, ignoreSigint: true, stdinWriteRejectsLater: "EPIPE: broken pipe, write" });
    let settled = false;
    const running = run({ abortKey: "topic:epipe-spaet" }).finally(() => void (settled = true));
    await until(() => fake.signals.length === 1);
    expect(fake.signals).toEqual(["SIGINT"]);
    // Der Prozess ignoriert SIGINT: das Ergebnis wartet auf sein Ende
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    expect(activeEngineCallCount()).toBe(1);
    fake.advance(CODEX_KILL_GRACE_MS);
    expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
    const r = await running;
    expect(r).toMatchObject({ engine: "codex", isError: true, errorKind: "other" });
    expect(r.text).toContain("EPIPE");
    expect(r.aborted).toBeFalsy();
    expect(r.timedOut).toBeFalsy();
    expect(activeEngineCallCount()).toBe(0);
    expect(abortEngineCalls("topic:epipe-spaet")).toBe(0);
    fake.advance(60_000 * 2);
    expect(fake.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  for (const step of ["write", "end"] as const) {
    test(`${step} lehnt erst nach Prozessende ab: Ergebnis unverändert, keine Signale, Timer, Diagnosen`, async () => {
      fake.next({ events: [], stderr: "Error: Not logged in. Run codex login.", exitCode: 1, stdinHeld: step });
      const r = await run({ abortKey: `topic:spaet-${step}`, idleTimeoutMs: 1_000 });
      expect(r).toMatchObject({ engine: "codex", isError: true });
      const before = JSON.stringify(r);
      expect(activeEngineCallCount()).toBe(0);
      expect(fake.timerCount()).toBe(0);
      const logged = errors.mock.calls.length;

      fake.rejectStdin("EPIPE: broken pipe");
      await new Promise((res) => setTimeout(res, 10));
      fake.advance(60_000 * 2);

      expect(JSON.stringify(r)).toBe(before);
      expect(fake.signals).toEqual([]);
      expect(fake.timerCount()).toBe(0);
      expect(activeEngineCallCount()).toBe(0);
      expect(abortEngineCalls(`topic:spaet-${step}`)).toBe(0);
      expect(errors.mock.calls.length).toBe(logged);
    });
  }
});

describe("Diagnosen ohne Zugangsdaten", () => {
  // Ausschließlich erfundene Werte
  const ENV_NAME = "CODEX_TEST_ERFUNDEN_API_KEY";
  const ENV_VALUE = "mia-erfundener-wert";
  const SECRETS = [
    "sk-proj-ERFUNDEN0000testwert1111abcd",
    "erfundenesTraegerzeichen42xyz",
    "erfundenesPasswort9",
    "Qx7erfundenOhneVorsatz0123456789abcdefGH",
    ENV_VALUE,
  ];
  const leaky =
    `Fehler: Anfrage mit sk-proj-ERFUNDEN0000testwert1111abcd abgelehnt\n` +
    `Authorization: Bearer erfundenesTraegerzeichen42xyz\n` +
    `Proxy https://alex:erfundenesPasswort9@proxy.example.test\n` +
    `refresh_token=Qx7erfundenOhneVorsatz0123456789abcdefGH, Wert ${ENV_VALUE}\n` +
    `unauthorized`;

  let errors: ReturnType<typeof spyOn>;
  beforeEach(() => {
    process.env[ENV_NAME] = ENV_VALUE;
    errors = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
    delete process.env[ENV_NAME];
  });

  const logged = () => errors.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
  const expectClean = (text: string) => {
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  };

  test("redactCodexDiagnostic ersetzt alle erfundenen Werte, lässt den Rest stehen", () => {
    const out = redactCodexDiagnostic(leaky);
    expectClean(out);
    expect(out).toContain("[verborgen]");
    expect(out).toContain("unauthorized");
  });

  test("stderr: weder Log noch Fehlertext enthalten die Werte, Fehlerart bleibt", async () => {
    fake.next({ stderr: leaky, exitCode: 1 });
    const r = await run();
    expect(r).toMatchObject({ isError: true, errorKind: "auth" });
    expectClean(r.text);
    expect(logged()).toContain("[Codex] stderr:");
    expectClean(logged());
  });

  test("turn.failed und error-Ereignis: Fehlertext ohne die Werte", async () => {
    fake.next({ events: [ev.started("t"), ev.failed(leaky)], exitCode: 1 });
    const failed = await run();
    expect(failed).toMatchObject({ isError: true, errorKind: "auth" });
    expectClean(failed.text);

    fake.next({ events: [ev.started("t"), { type: "error", message: leaky }], exitCode: 1 });
    const errored = await run();
    expect(errored.isError).toBe(true);
    expectClean(errored.text);
    expectClean(logged());
  });

  test("Startfehler: weder Log noch Fehlertext enthalten die Werte", async () => {
    fake.next({ throws: leaky });
    const r = await run();
    expect(r).toMatchObject({ isError: true, errorKind: "not_installed" });
    expectClean(r.text);
    expect(logged()).toContain("[Codex] Start fehlgeschlagen");
    expectClean(logged());
  });

  test("Schreibfehler auf stdin: weder Log noch Fehlertext enthalten die Werte", async () => {
    fake.next({ events: [], hang: true, stdinEndRejects: leaky });
    const r = await run();
    expect(r.isError).toBe(true);
    expectClean(r.text);
    expectClean(logged());
  });

  test("ungültige Angaben mit Geheimnissen: weder Log noch Fehlertext enthalten die Werte", async () => {
    const bad = [
      { model: "--x sk-proj-ERFUNDEN0000testwert1111abcd" },
      { effort: "high erfundenesPasswort9" },
      { resumeSessionId: `-${ENV_VALUE}` },
    ];
    for (const extra of bad) {
      const r = await run(extra);
      expect(r).toMatchObject({ engine: "codex", isError: true, errorKind: "other" });
      expectClean(r.text);
    }
    expect(fake.spawns).toHaveLength(0);
    expectClean(logged());
  });

  test("Lesefehler auf stdout: weder Log noch Fehlertext enthalten die Werte", async () => {
    fake.next({ events: [ev.started("t")], stdoutError: leaky, exitCode: 1 });
    const r = await run();
    expect(r.isError).toBe(true);
    expectClean(r.text);
    expect(logged()).toContain("[Codex] Lesefehler");
    expectClean(logged());
    expect(activeEngineCallCount()).toBe(0);
  });

  test("Rückruf wirft: weder Log noch Fehlertext enthalten die Werte", async () => {
    fake.next({ events: [ev.started("t"), ev.webSearch("w", "x"), ev.message("m", "fertig"), ev.completed()] });
    const r = await run({
      onToolStart: () => {
        throw new Error(leaky);
      },
    });
    expect(r.isError).toBe(true);
    expectClean(r.text);
    expect(logged()).toContain("[Codex] Lesefehler");
    expectClean(logged());
  });
});
