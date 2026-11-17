/**
 * Issue #561: Beim Beenden wartet der Bot auf das Ende seiner Motor-Prozesse
 * (waitForEngineExit), denn unter systemd mit KillMode=process räumt nach
 * ihm niemand mehr auf. Hintergrund-Jobs stehen nicht im Register und
 * bleiben stehen. Erst mit Attrappen, dann einmal mit echten Prozessen
 * (sh und sleep), ohne src/bot.ts. Dazu die Prüfprozesse der Motoren
 * (`codex --version`, `opencode models`): Sie gehören zu keinem Auftrag,
 * werden beim Beenden trotzdem samt Kindern beendet, und danach startet
 * keine Prüfung mehr einen Prozess. Ebenso `claude --help` des
 * Telefonhörers. Außerhalb von systemd bleibt der bisherige Ablauf: laufende
 * Prüfungen bleiben unberührt, neue starten weiter.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLifecycle } from "../src/app/lifecycle";
import { registerBotShutdown, type BotShutdownParts } from "../src/app/bot-shutdown";
import { abortAllEngineCalls, abortEngineCalls, engineShutdownStarted, registerEngineCall, registeredEngineCallCount, terminatingEngineProcCount, trackEngineProcess, trackEngineTermination, trackedEngineProcCount, unregisterEngineCall, waitForEngineExit, type EngineProc } from "../src/lib/engines/calls";
import { checkEngine, resetEngineCheckCacheForTests } from "../src/lib/engines/check";
import { CODEX_KILL_GRACE_MS, createCodexEngine, setCodexRuntimeForTests } from "../src/lib/engines/codex";
import { createOpenCodeEngine, forgetOpenCodeVersion, listOpenCodeModels, OPENCODE_MODELS_TEXT, setOpenCodeRuntimeForTests } from "../src/lib/engines/opencode";
import { CLAUDE_STOP_PLAN, stopTree } from "../src/lib/engines/platform";
import { checkCliFlags } from "../src/lib/voice-brain/backends/claude-cli";
import { terminateProcessTree } from "../src/lib/process-tree";

function fakePlatform(aliveUntil: Record<number, number>, clock: { t: number }) {
  const signals: string[] = [];
  return {
    signals,
    platform: {
      os: "linux" as NodeJS.Platform,
      groupAlive: (pgid: number) => clock.t < (aliveUntil[pgid] ?? 0),
      signalGroup: (pgid: number, signal: string) => void signals.push(`${pgid} ${signal}`),
      taskkill: () => {},
    },
  };
}

const proc = (pid: number): EngineProc => ({ pid, kill: () => {} });

describe("waitForEngineExit mit Attrappe", () => {
  test("wartet, bis alle Gruppen leer sind; kein SIGKILL", async () => {
    const clock = { t: 0 };
    const { platform, signals } = fakePlatform({ 100: 1_000, 200: 2_500 }, clock);
    const late = await waitForEngineExit([proc(100), proc(200)], 5_000, { platform, now: () => clock.t, sleep: async ms => void (clock.t += ms) });
    expect(late).toBe(0);
    expect(clock.t).toBeGreaterThanOrEqual(2_500);
    expect(clock.t).toBeLessThan(5_000);
    expect(signals).toEqual([]);
  });

  test("Nachzügler nach Ablauf bekommen SIGKILL an die Gruppe", async () => {
    const clock = { t: 0 };
    const { platform, signals } = fakePlatform({ 100: 1_000, 300: 60_000 }, clock);
    const late = await waitForEngineExit([proc(100), proc(300)], 5_000, { platform, now: () => clock.t, sleep: async ms => void (clock.t += ms) });
    expect(late).toBe(1);
    expect(signals).toEqual(["300 SIGKILL"]);
  });

  test("nichts zu tun: ohne Warten zurück; PID 0 und 1 bekommen nie etwas", async () => {
    const clock = { t: 0 };
    const { platform, signals } = fakePlatform({ 0: 60_000, 1: 60_000 }, clock);
    expect(await waitForEngineExit([proc(0), proc(1)], 5_000, { platform, now: () => clock.t, sleep: async ms => void (clock.t += ms) })).toBe(0);
    expect(clock.t).toBe(0);
    expect(signals).toEqual([]);
  });
});

describe("Beenden mit echten Prozessen", () => {
  const spawned: number[] = [];
  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  });

  const groupAlive = (pgid: number) => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (err) {
      return (err as { code?: string }).code === "EPERM";
    }
  };

  test.skipIf(process.platform === "win32")("Motor-Prozess, der SIGTERM übergeht, ist vor dem Exit weg; ein Job läuft weiter", async () => {
    // Motor: eigene Gruppe, übergeht SIGTERM samt Kind, endet erst mit dem SIGKILL nach 1,5 s
    const engine = Bun.spawn(["sh", "-c", "trap '' TERM; sleep 30 & wait"], { detached: true, stdout: "ignore", stderr: "ignore" });
    // Hintergrund-Job: eigene Gruppe, nicht im Register (wie der Wächter aus src/lib/jobs/default-deps.ts)
    const job = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
    spawned.push(engine.pid, job.pid);
    await Bun.sleep(100);
    const entry = registerEngineCall("test-561", engine, p => stopTree(p as typeof engine, CLAUDE_STOP_PLAN));
    void engine.exited.then(() => unregisterEngineCall("test-561", entry));

    let atExit: { engine: boolean; job: boolean } | undefined;
    const lifecycle = createLifecycle({
      lock: { touch: async () => {}, release: async () => {} },
      exit: () => void (atExit = { engine: groupAlive(engine.pid), job: groupAlive(job.pid) }),
      settleMs: 0,
      log: () => {},
      warn: () => {},
    });
    const parts: BotShutdownParts = {
      abortRunning: abortAllEngineCalls,
      underSystemd: () => true,
      routineWatch: () => null,
      threadReminders: () => null,
      stopReminders: () => null,
      telegram: { stop: () => {} },
      web: () => null,
      webAbortText: "",
      mcp: { shutdown: async () => {} },
      saveSession: async () => {},
      log: () => {},
    };
    registerBotShutdown(lifecycle, parts);
    await lifecycle.shutdown("SIGTERM");
    expect(atExit).toEqual({ engine: false, job: true });
    expect(registeredEngineCallCount()).toBe(0);
  }, 15_000);

  test.skipIf(process.platform === "win32")("Issue #561: Beenden während einer Versionsprüfung von OpenCode, die SIGINT übergeht; Prüfung vor dem Exit weg, Job läuft weiter", async () => {
    // Echte Versionsprüfung (Standard-Laufzeit) gegen ein Skript als OPENCODE_PATH:
    // übergeht SIGINT samt Kind, endet erst mit dem SIGKILL nach OPENCODE_KILL_GRACE_MS
    const dir = mkdtempSync(join(tmpdir(), "tybo-561-"));
    const pidFile = join(dir, "version.pid");
    const script = join(dir, "opencode");
    writeFileSync(script, `#!/bin/sh\ntrap '' INT\necho $$ > '${pidFile}'\nsleep 30 &\nwait\n`);
    chmodSync(script, 0o755);
    const before = process.env.OPENCODE_PATH;
    process.env.OPENCODE_PATH = script;
    setOpenCodeRuntimeForTests(null);
    const job = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
    spawned.push(job.pid);
    try {
      const run = createOpenCodeEngine().run({ prompt: "Hallo", streaming: false, timeoutMs: 60_000, abortKey: "test-561-version", cwd: dir });
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(20);
      await Bun.sleep(50);
      const probe = Number(readFileSync(pidFile, "utf8").trim());
      expect(probe).toBeGreaterThan(1);
      spawned.push(probe);
      expect(groupAlive(probe)).toBe(true);

      let atExit: { probe: boolean; job: boolean } | undefined;
      const lifecycle = createLifecycle({
        lock: { touch: async () => {}, release: async () => {} },
        exit: () => void (atExit = { probe: groupAlive(probe), job: groupAlive(job.pid) }),
        settleMs: 0,
        log: () => {},
        warn: () => {},
      });
      registerBotShutdown(lifecycle, {
        abortRunning: abortAllEngineCalls,
        underSystemd: () => true,
        routineWatch: () => null,
        threadReminders: () => null,
        stopReminders: () => null,
        telegram: { stop: () => {} },
        web: () => null,
        webAbortText: "",
        mcp: { shutdown: async () => {} },
        saveSession: async () => {},
        log: () => {},
      });
      await lifecycle.shutdown("SIGTERM");
      expect(atExit).toEqual({ probe: false, job: true });
      expect((await run).aborted).toBe(true);
      expect(registeredEngineCallCount()).toBe(0);
    } finally {
      if (before === undefined) delete process.env.OPENCODE_PATH;
      else process.env.OPENCODE_PATH = before;
      forgetOpenCodeVersion();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test.skipIf(process.platform === "win32")("Issue #561: Codex kurz vor dem Beenden abgebrochen, Aufruf schon abgemeldet, Kind übergeht SIGINT; Gruppe vor dem Exit weg, Job läuft weiter", async () => {
    // Echter Codex-Lauf (Standard-Laufzeit) gegen ein Skript als CODEX_PATH: der
    // Hauptprozess endet mit SIGINT, das Kind (Hintergrund, SIGINT ignoriert)
    // lebt ohne die Ausgabeströme weiter, bis das SIGKILL des Nachlaufs kommt
    const dir = mkdtempSync(join(tmpdir(), "tybo-561-codex-"));
    const groupFile = join(dir, "codex.pgid");
    const script = join(dir, "codex");
    writeFileSync(script, `#!/bin/sh\nsleep 30 </dev/null >/dev/null 2>&1 &\nps -o pgid= -p $$ | tr -d ' ' > '${groupFile}'\nwait\n`);
    chmodSync(script, 0o755);
    const before = process.env.CODEX_PATH;
    process.env.CODEX_PATH = script;
    // Unter Last (voller Lauf) vergingen zwischen Abbruch und Prüfung schon
    // mehr als CODEX_KILL_GRACE_MS: das SIGKILL des Nachlaufs kam vor der
    // Prüfung, die Gruppe war schon weg. Deshalb wartet es, bis der Test die
    // lebende Gruppe gesehen hat; danach kommt es wie sonst
    let observed = false;
    let deferredKill: (() => void) | null = null;
    setCodexRuntimeForTests({
      setTimeout: (fn, ms) => setTimeout(ms === CODEX_KILL_GRACE_MS ? () => (observed ? fn() : (deferredKill = fn)) : fn, ms),
    });
    const job = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
    spawned.push(job.pid);
    try {
      const run = createCodexEngine().run({ prompt: "Hallo", streaming: false, timeoutMs: 60_000, abortKey: "test-561-codex", cwd: dir });
      // Unter Last startet das Skript erst nach Sekunden; bis zu 10 Sekunden warten
      for (let i = 0; i < 500 && !(existsSync(groupFile) && readFileSync(groupFile, "utf8").trim()); i++) await Bun.sleep(20);
      const group = Number(readFileSync(groupFile, "utf8").trim());
      expect(group).toBeGreaterThan(1);
      spawned.push(group);

      // /stop kurz vor dem Beenden: der Lauf endet, der Aufruf meldet sich ab
      expect(abortEngineCalls("test-561-codex")).toBe(1);
      const result = await run;
      expect(result.aborted).toBe(true);
      expect(registeredEngineCallCount()).toBe(0);
      expect(groupAlive(group)).toBe(true);
      expect(terminatingEngineProcCount()).toBe(1);
      observed = true;

      let atExit: { group: boolean; job: boolean } | undefined;
      const lifecycle = createLifecycle({
        lock: { touch: async () => {}, release: async () => {} },
        exit: () => void (atExit = { group: groupAlive(group), job: groupAlive(job.pid) }),
        settleMs: 0,
        log: () => {},
        warn: () => {},
      });
      registerBotShutdown(lifecycle, {
        abortRunning: abortAllEngineCalls,
        underSystemd: () => true,
        routineWatch: () => null,
        threadReminders: () => null,
        stopReminders: () => null,
        telegram: { stop: () => {} },
        web: () => null,
        webAbortText: "",
        mcp: { shutdown: async () => {} },
        saveSession: async () => {},
        log: () => {},
      });
      const shutdown = lifecycle.shutdown("SIGTERM");
      // Schon fällig gewesen: kommt jetzt, während das Beenden auf die Gruppe wartet
      (deferredKill as (() => void) | null)?.();
      await shutdown;
      expect(atExit).toEqual({ group: false, job: true });
      // Nach dem SIGKILL des Nachlaufs ist der Prozess nicht mehr verfolgt
      expect(terminatingEngineProcCount()).toBe(0);
    } finally {
      setCodexRuntimeForTests(null);
      if (before === undefined) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = before;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test.skipIf(process.platform === "win32")("Issue #561: Claude kurz vor dem Beenden abgebrochen, Aufruf schon abgemeldet, Kind übergeht SIGTERM; Gruppe vor dem Exit weg, Job läuft weiter", async () => {
    // Hauptprozess endet mit SIGTERM, das Kind (ohne Ausgabeströme) erbt das Übergehen
    // Bereit-Datei statt fester Pause: unter Last wäre das Kind nach 150 ms noch nicht gestartet
    const dir = mkdtempSync(join(tmpdir(), "tybo-561-claude-"));
    const ready = join(dir, "ready");
    const engine = Bun.spawn(["sh", "-c", `trap '' TERM; sleep 30 </dev/null >/dev/null 2>&1 & trap - TERM; echo ok > '${ready}'; wait`], { detached: true, stdout: "ignore", stderr: "ignore" });
    const job = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
    spawned.push(engine.pid, job.pid);
    await waitForFile(ready);
    rmSync(dir, { recursive: true, force: true });
    const entry = registerEngineCall("test-561-claude", engine, p => terminateProcessTree(p as typeof engine));
    expect(abortEngineCalls("test-561-claude")).toBe(1);
    await engine.exited;
    unregisterEngineCall("test-561-claude", entry);
    expect(registeredEngineCallCount()).toBe(0);
    expect(groupAlive(engine.pid)).toBe(true);

    let atExit: { engine: boolean; job: boolean } | undefined;
    const lifecycle = createLifecycle({
      lock: { touch: async () => {}, release: async () => {} },
      exit: () => void (atExit = { engine: groupAlive(engine.pid), job: groupAlive(job.pid) }),
      settleMs: 0,
      log: () => {},
      warn: () => {},
    });
    registerBotShutdown(lifecycle, {
      abortRunning: abortAllEngineCalls,
      underSystemd: () => true,
      routineWatch: () => null,
      threadReminders: () => null,
      stopReminders: () => null,
      telegram: { stop: () => {} },
      web: () => null,
      webAbortText: "",
      mcp: { shutdown: async () => {} },
      saveSession: async () => {},
      log: () => {},
    });
    await lifecycle.shutdown("SIGTERM");
    expect(atExit).toEqual({ engine: false, job: true });
  }, 15_000);
  /** Lebenszyklus wie im Bot unter systemd; exit hält fest, welche Gruppen beim Exit noch leben */
  function shutdownWith(snapshot: () => Record<string, boolean>, underSystemd = true) {
    let atExit: Record<string, boolean> | undefined;
    const lifecycle = createLifecycle({
      lock: { touch: async () => {}, release: async () => {} },
      exit: () => void (atExit = snapshot()),
      settleMs: 0,
      log: () => {},
      warn: () => {},
    });
    registerBotShutdown(lifecycle, {
      abortRunning: abortAllEngineCalls,
      underSystemd: () => underSystemd,
      routineWatch: () => null,
      threadReminders: () => null,
      stopReminders: () => null,
      telegram: { stop: () => {} },
      web: () => null,
      webAbortText: "",
      mcp: { shutdown: async () => {} },
      saveSession: async () => {},
      log: () => {},
    });
    return { run: () => lifecycle.shutdown("SIGTERM"), atExit: () => atExit };
  }

  async function waitForFile(path: string): Promise<number> {
    for (let i = 0; i < 150 && !(existsSync(path) && readFileSync(path, "utf8").trim()); i++) await Bun.sleep(20);
    return Number(readFileSync(path, "utf8").trim());
  }

  const restoreRoot = (value: string | undefined) => {
    if (value === undefined) delete process.env.GO_PROJECT_ROOT;
    else process.env.GO_PROJECT_ROOT = value;
  };

  const calls = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);

  test.skipIf(process.platform === "win32")("Issue #561: Beenden während codex --version (Motor-Prüfung); Prüfprozess samt Kind vor dem Exit weg, Job läuft weiter, login status startet nicht mehr", async () => {
    // Echte Prüfung (checkEngine, Standard-Laufzeit) gegen ein Skript als CODEX_PATH:
    // --version hängt, bis SIGINT kommt, und meldet dann doch noch eine gültige
    // Version mit Exit 0. Ohne Sperre käme danach `codex login status`. Das Kind
    // (Hintergrund, SIGINT übergangen) lebt bis zum SIGKILL des Nachlaufs.
    const dir = mkdtempSync(join(tmpdir(), "tybo-561-check-"));
    const log = join(dir, "calls.log");
    const groupFile = join(dir, "probe.pgid");
    const script = join(dir, "codex");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        `echo "$*" >> '${log}'`,
        'if [ "$1" = "--version" ]; then',
        "  trap 'echo codex-cli 1.2.3; exit 0' INT",
        "  sleep 30 </dev/null >/dev/null 2>&1 &",
        `  ps -o pgid= -p $$ | tr -d ' ' > '${groupFile}'`,
        "  wait",
        "fi",
        "exit 0",
        "",
      ].join("\n")
    );
    chmodSync(script, 0o755);
    const before = process.env.CODEX_PATH;
    const beforeRoot = process.env.GO_PROJECT_ROOT;
    process.env.CODEX_PATH = script;
    // Arbeitsordner der Prüfung: ein vorhandener Ordner, egal was frühere Testdateien stehen ließen
    process.env.GO_PROJECT_ROOT = dir;
    resetEngineCheckCacheForTests();
    const job = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
    spawned.push(job.pid);
    try {
      const check = checkEngine("codex");
      const group = await waitForFile(groupFile);
      expect(group).toBeGreaterThan(1);
      spawned.push(group);
      expect(groupAlive(group)).toBe(true);
      expect(trackedEngineProcCount()).toBe(1);

      const shutdown = shutdownWith(() => ({ probe: groupAlive(group), job: groupAlive(job.pid) }));
      await shutdown.run();
      expect(shutdown.atExit()).toEqual({ probe: false, job: true });
      const status = await check;
      expect(status).toMatchObject({ engine: "codex", loggedIn: false, message: "Codex ließ sich nicht prüfen" });
      // Nach dem Abbruch keine weitere Prüfphase: nur --version lief
      expect(calls(log)).toEqual(["--version"]);
      expect(trackedEngineProcCount()).toBe(0);
    } finally {
      if (before === undefined) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = before;
      restoreRoot(beforeRoot);
      resetEngineCheckCacheForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test.skipIf(process.platform === "win32")("Issue #561: Beenden während opencode models (Modell-Liste), das SIGINT übergeht; Abfrage samt Kind vor dem Exit weg, Job läuft weiter, danach startet keine Abfrage und keine Prüfung mehr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-561-models-"));
    const log = join(dir, "calls.log");
    const pidFile = join(dir, "models.pid");
    const script = join(dir, "opencode");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        `echo "$*" >> '${log}'`,
        "trap '' INT",
        "sleep 30 </dev/null >/dev/null 2>&1 &",
        `echo $$ > '${pidFile}'`,
        "wait",
        "",
      ].join("\n")
    );
    chmodSync(script, 0o755);
    const before = process.env.OPENCODE_PATH;
    const beforeRoot = process.env.GO_PROJECT_ROOT;
    process.env.OPENCODE_PATH = script;
    process.env.GO_PROJECT_ROOT = dir;
    setOpenCodeRuntimeForTests(null);
    resetEngineCheckCacheForTests();
    const job = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
    spawned.push(job.pid);
    try {
      const models = listOpenCodeModels();
      const probe = await waitForFile(pidFile);
      expect(probe).toBeGreaterThan(1);
      spawned.push(probe);
      expect(groupAlive(probe)).toBe(true);
      expect(trackedEngineProcCount()).toBe(1);

      const shutdown = shutdownWith(() => ({ probe: groupAlive(probe), job: groupAlive(job.pid) }));
      await shutdown.run();
      expect(shutdown.atExit()).toEqual({ probe: false, job: true });
      expect((await models).ok).toBe(false);

      // Nach dem Abbruch startet nichts mehr: weder die Modell-Liste noch die Prüfung von OpenCode
      expect(await listOpenCodeModels()).toEqual({ ok: false, error: OPENCODE_MODELS_TEXT.shutdown });
      expect(await checkEngine("opencode")).toMatchObject({ engine: "opencode", installed: false, message: "OpenCode ließ sich nicht prüfen" });
      expect(calls(log)).toEqual(["models"]);
      expect(trackedEngineProcCount()).toBe(0);
    } finally {
      if (before === undefined) delete process.env.OPENCODE_PATH;
      else process.env.OPENCODE_PATH = before;
      restoreRoot(beforeRoot);
      resetEngineCheckCacheForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  /** Skript für `claude --help`: übergeht SIGTERM samt Kind, schreibt "pid pgid" */
  function claudeHelpScript(dir: string) {
    const log = join(dir, "calls.log");
    const idFile = join(dir, "help.ids");
    const script = join(dir, "claude");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        `echo "$*" >> '${log}'`,
        "trap '' TERM",
        "sleep 30 </dev/null >/dev/null 2>&1 &",
        `echo "$$ $(ps -o pgid= -p $$ | tr -d ' ')" > '${idFile}'`,
        "wait",
        "",
      ].join("\n")
    );
    chmodSync(script, 0o755);
    return { log, idFile, script };
  }

  async function waitForIds(path: string): Promise<[number, number]> {
    for (let i = 0; i < 150 && !(existsSync(path) && readFileSync(path, "utf8").trim().split(/\s+/).length === 2); i++) await Bun.sleep(20);
    const [pid, pgid] = readFileSync(path, "utf8").trim().split(/\s+/).map(Number);
    return [pid, pgid];
  }

  test.skipIf(process.platform === "win32")("Issue #561: Beenden während claude --help (Telefonhörer); eigene Gruppe, Prüfung samt Kind vor dem Exit weg, Job läuft weiter, danach keine Prüfung mehr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-561-help-"));
    const { log, idFile, script } = claudeHelpScript(dir);
    const before = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = script;
    const job = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
    spawned.push(job.pid);
    try {
      const flags = checkCliFlags();
      const [pid, pgid] = await waitForIds(idFile);
      expect(pid).toBeGreaterThan(1);
      // Eigene Prozessgruppe: sonst fände waitForEngineExit die Kinder nicht
      expect(pgid).toBe(pid);
      spawned.push(pid);
      expect(groupAlive(pid)).toBe(true);
      expect(trackedEngineProcCount()).toBe(1);

      const shutdown = shutdownWith(() => ({ probe: groupAlive(pid), job: groupAlive(job.pid) }));
      await shutdown.run();
      expect(shutdown.atExit()).toEqual({ probe: false, job: true });
      expect(await flags).toBeNull();
      expect(trackedEngineProcCount()).toBe(0);

      // Nach dem Beenden startet keine Prüfung mehr, auch nicht aus dem Zwischenspeicher
      expect(engineShutdownStarted()).toBe(true);
      expect(await checkCliFlags()).toBeNull();
      expect(calls(log)).toEqual(["--help"]);
      expect(trackedEngineProcCount()).toBe(0);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_PATH;
      else process.env.CLAUDE_PATH = before;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test.skipIf(process.platform === "win32")("Issue #561: claude --help nach dem Beenden unter systemd startet nicht; ein Job läuft weiter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-561-help-after-"));
    const { log, script } = claudeHelpScript(dir);
    const before = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = script;
    const job = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
    spawned.push(job.pid);
    try {
      const shutdown = shutdownWith(() => ({ job: groupAlive(job.pid) }));
      await shutdown.run();
      expect(shutdown.atExit()).toEqual({ job: true });
      expect(await checkCliFlags()).toBeNull();
      await Bun.sleep(100);
      expect(calls(log)).toEqual([]);
      expect(trackedEngineProcCount()).toBe(0);
      expect(groupAlive(job.pid)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_PATH;
      else process.env.CLAUDE_PATH = before;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  const pidAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  for (const systemd of [true, false]) {
    test.skipIf(process.platform === "win32")(`Issue #561 Regression: eigenes Zeitlimit von claude --help, Hauptprozess beendet, Kind lebt; ${systemd ? "systemd wartet auf die Gruppe" : "PM2 und launchd lassen sie unverändert"}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "tybo-561-help-timeout-"));
      const { script, idFile, log } = claudeHelpScript(dir);
      // Nur das Kind erbt das Übergehen von SIGTERM. Der Hauptprozess endet
      // durch das unveränderte eigene 5-Sekunden-Zeitlimit der echten Prüfung.
      writeFileSync(script, readFileSync(script, "utf8").replace("\nwait\n", "\ntrap - TERM\nwait\n"));
      const before = process.env.CLAUDE_PATH;
      process.env.CLAUDE_PATH = script;
      const job = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
      spawned.push(job.pid);
      try {
        const started = Date.now();
        const flags = checkCliFlags();
        const [pid, pgid] = await waitForIds(idFile);
        spawned.push(pid);
        expect(pgid).toBe(pid);
        expect(await flags).toBeNull();
        expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
        expect(pidAlive(pid)).toBe(false);
        expect(groupAlive(pgid)).toBe(true);
        expect(registeredEngineCallCount()).toBe(0);
        expect(terminatingEngineProcCount()).toBe(0);

        const shutdown = shutdownWith(() => ({ probe: groupAlive(pgid), job: groupAlive(job.pid) }), systemd);
        await shutdown.run();
        expect(shutdown.atExit()).toEqual({ probe: !systemd, job: true });
        expect(engineShutdownStarted()).toBe(systemd);
        if (systemd) {
          expect(trackedEngineProcCount()).toBe(0);
          expect(await checkCliFlags()).toBeNull();
          expect(calls(log)).toEqual(["--help"]);
        } else {
          // Auch kein nachträgliches SIGKILL durch den Shutdown unter PM2/launchd.
          await Bun.sleep(1_700);
          expect(groupAlive(pgid)).toBe(true);
        }
      } finally {
        if (before === undefined) delete process.env.CLAUDE_PATH;
        else process.env.CLAUDE_PATH = before;
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);
  }

  for (const source of ["Prüfung erfolgreich", "Aufruf abgemeldet", "SIGKILL-Nachlauf abgeschlossen"] as const) {
    test.skipIf(process.platform === "win32")(`Issue #561 Regression: ${source} gibt eine noch lebende Gruppe nicht frei`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "tybo-561-ownership-"));
      const ready = join(dir, "ready");
      // Hauptprozess endet erfolgreich, sein Kind lebt ohne Ausgabeströme weiter.
      const engine = Bun.spawn(["sh", "-c", `trap '' TERM INT; sleep 30 </dev/null >/dev/null 2>&1 & echo ok > '${ready}'; exit 0`], { detached: true, stdout: "ignore", stderr: "ignore" });
      const job = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
      spawned.push(engine.pid, job.pid);
      let aborts = 0;
      const entry = source === "Aufruf abgemeldet" ? registerEngineCall("test-561-ownership", engine, () => void aborts++) : undefined;
      const finishKill = source === "SIGKILL-Nachlauf abgeschlossen" ? trackEngineTermination(engine) : undefined;
      if (source === "Prüfung erfolgreich") trackEngineProcess(engine, () => void aborts++);
      try {
        await waitForFile(ready);
        expect(await engine.exited).toBe(0);
        if (entry) unregisterEngineCall("test-561-ownership", entry);
        // Ein gesendetes Signal ist kein Nachweis, dass die Gruppe bereits leer ist.
        finishKill?.();
        await Bun.sleep(100);
        expect(pidAlive(engine.pid)).toBe(false);
        expect(groupAlive(engine.pid)).toBe(true);
        expect(registeredEngineCallCount()).toBe(0);
        expect(terminatingEngineProcCount()).toBe(0);

        const shutdown = shutdownWith(() => ({ engine: groupAlive(engine.pid), job: groupAlive(job.pid) }));
        await shutdown.run();
        expect(shutdown.atExit()).toEqual({ engine: false, job: true });
        expect(aborts).toBe(0);
        expect(trackedEngineProcCount()).toBe(0);
      } finally {
        unregisterEngineCall("test-561-ownership", entry);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);
  }

  test.skipIf(process.platform === "win32")("Issue #561: außerhalb von systemd (PM2, launchd) bleibt der bisherige Ablauf: echtes abortAllEngineCalls lässt eine laufende Prüfung stehen, kein Warten, neue Prüfungen starten weiter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-561-pm2-"));
    const log = join(dir, "calls.log");
    const pidFile = join(dir, "models.pid");
    const script = join(dir, "opencode");
    writeFileSync(script, ["#!/bin/sh", `echo "$*" >> '${log}'`, "sleep 30 </dev/null >/dev/null 2>&1 &", `echo $$ > '${pidFile}'`, "wait", ""].join("\n"));
    chmodSync(script, 0o755);
    const before = process.env.OPENCODE_PATH;
    const beforeRoot = process.env.GO_PROJECT_ROOT;
    process.env.OPENCODE_PATH = script;
    process.env.GO_PROJECT_ROOT = dir;
    setOpenCodeRuntimeForTests(null);
    try {
      void listOpenCodeModels();
      const first = await waitForFile(pidFile);
      expect(first).toBeGreaterThan(1);
      spawned.push(first);
      expect(trackedEngineProcCount()).toBe(1);

      const started = Date.now();
      const shutdown = shutdownWith(() => ({ probe: groupAlive(first) }), false);
      await shutdown.run();
      // Kein Abbruch der Prüfung, kein Warten auf sie (das SIGKILL käme erst nach 3 s)
      expect(shutdown.atExit()).toEqual({ probe: true });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(engineShutdownStarted()).toBe(false);
      expect(trackedEngineProcCount()).toBe(1);
      await Bun.sleep(OPENCODE_GRACE_CHECK_MS);
      expect(groupAlive(first)).toBe(true);

      // Neue Prüfungen starten weiter wie vorher
      rmSync(pidFile, { force: true });
      void listOpenCodeModels();
      const second = await waitForFile(pidFile);
      spawned.push(second);
      expect(second).not.toBe(first);
      expect(calls(log)).toEqual(["models", "models"]);
      expect(trackedEngineProcCount()).toBe(2);
    } finally {
      if (before === undefined) delete process.env.OPENCODE_PATH;
      else process.env.OPENCODE_PATH = before;
      restoreRoot(beforeRoot);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

/** Länger als OPENCODE_KILL_GRACE_MS (3 s): käme ein SIGKILL des Nachlaufs, wäre die Gruppe danach weg */
const OPENCODE_GRACE_CHECK_MS = 3_300;
