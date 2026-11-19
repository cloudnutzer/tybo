/**
 * Issue #567: `tybo pruefen` prüft den Standard-Motor (installiert,
 * angemeldet, mit dem PATH aus der Dienstdatei) und meldet einen geladenen,
 * aber nicht laufenden Bot unter macOS als Fehler.
 *
 * Alles Äußere sind Attrappen: Befehle über ctx.run (kein echtes claude,
 * codex, opencode, launchctl oder systemctl), kein Netz, kein Modell.
 * src/bot.ts wird weder importiert noch gestartet.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { runTybo } from "../scripts/tybo";
import { claudeLoginUnknown, engineCheckPath, engineFindings, plistPath, servicePath, unitPath } from "../src/setup/checks/engine";
import { defaultSpecials } from "../src/setup/checks/specials";
import type { CommandResult, RunOptions, SetupContext } from "../src/setup/context";
import { API_KEY_ABSENT, CODEX_LOGGED_OUT, CODEX_MISSING, createProviders, OPENCODE_LOGGED_OUT } from "../src/setup/providers";
import { CLAUDE_INSTALL } from "../src/setup/steps/prerequisites";
import { CLAUDE_NOT_INSTALLED, CLAUDE_NOT_LOGGED_IN } from "../src/lib/engines/check";
import { CLAUDE_API_KEY_MISSING } from "../src/lib/engines/claude-auth";
import { writePlist } from "../src/lib/services/plist";
import type { CallModelDeps } from "../src/lib/voice-brain/call-model";
import { cleanup, FULL_ENV, leakedSecrets, makeCtx } from "./setup-fixture";
import { engineToolChecks, engineToolFindings, parseCodexSkillNames, TOOL_COMPARE_TIMEOUT_MS, type EngineToolDeps } from "../src/setup/checks/engine-tools";
import { collectReport, formatReport, reportExitCode } from "../src/setup/checks/report";
import { applyCodexMcpEnv, planCodexMcp, setCodexMcpReaderForTests, type CodexMcpPlan } from "../src/lib/engines/codex-mcp";
import { codexSandbox } from "../src/lib/engines/codex";
import { inspectCodexSkillLinks, syncCodexSkillLinks } from "../src/lib/engines/codex-skills";
import { CODEX_JOB_TOOL_ARGS, parseCodexMcpNames } from "../src/lib/jobs/codex-tools";
import { setToolParityReadersForTests } from "../src/lib/engines/tool-parity";
import type { EngineTools } from "../src/web/tool-parity-types";

afterAll(cleanup);

/** PATH aus der Dienstdatei; die Shell dieses Tests hat einen anderen */
const SERVICE_PATH = "/dienst/bin:/usr/bin:/bin";
const SHELL_PATH = "/shell/bin:/usr/bin";
const PROFILE = "# Profil\nName: Alex\nZeitzone: Europe/Berlin\n";
const AUTH = (loggedIn: boolean) => JSON.stringify({ loggedIn, email: "alex@example.test", orgName: "Beispiel GmbH" });

let savedPath: string | undefined;
let savedKey: string | undefined;
beforeEach(() => {
  savedPath = process.env.PATH;
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.PATH = SHELL_PATH;
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  process.env.PATH = savedPath;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

async function writeBotPlist(ctx: SetupContext, path: string | null = SERVICE_PATH): Promise<void> {
  await mkdir(ctx.launchAgentsDir, { recursive: true });
  const env = path === null ? { HOME: ctx.home } : { PATH: path, HOME: ctx.home };
  await writeFile(join(ctx.launchAgentsDir, "ai.tybo.telegram-relay.plist"), writePlist({ Label: "ai.tybo.telegram-relay", KeepAlive: true, EnvironmentVariables: env }));
}

/** Programme, die es unter einem bestimmten PATH gibt: Befehl → Antwort */
type Programs = Record<string, Partial<CommandResult>>;

interface Seen {
  cmd: string[];
  options?: RunOptions;
}

/**
 * Befehls-Attrappe: Antworten gelten nur, wenn der PATH des Aufrufs genau
 * pathFor ist (wie Bun.spawn, das den Befehl im PATH der Umgebung sucht);
 * sonst „nicht gefunden“. launchctl list liefert listing.
 */
function installRun(ctx: SetupContext, programs: Programs, options: { pathFor?: string; listing?: string; anywhere?: string[] } = {}): Seen[] {
  const seen: Seen[] = [];
  const inner = ctx.run;
  const pathFor = options.pathFor ?? SERVICE_PATH;
  ctx.run = Object.assign(
    async (cmd: string[], o?: RunOptions): Promise<CommandResult> => {
      seen.push({ cmd, options: o });
      const joined = cmd.join(" ");
      if (joined === "launchctl list") return { code: 0, stdout: options.listing ?? "", stderr: "" };
      if (joined === "which bun") return { code: 0, stdout: "/dienst/bin/bun", stderr: "" };
      if (joined in programs) {
        if (o?.env?.PATH !== pathFor && !options.anywhere?.includes(cmd[0])) return { code: -1, stdout: "", stderr: "Befehl nicht gefunden", spawnError: "ENOENT" };
        return { code: 0, stdout: "", stderr: "", ...programs[joined] };
      }
      return inner(cmd, o);
    },
    { calls: (inner as { calls: string[][] }).calls }
  ) as SetupContext["run"];
  return seen;
}

const CLAUDE_READY: Programs = {
  "claude --version": { stdout: "2.1.300 (Claude Code)\n" },
  "claude auth status --json": { stdout: AUTH(true) },
};

/** ctx mit echten Anbietern (engineCheck läuft über ctx.run), Netz gesperrt */
async function engineCtx(options: { env?: string; settings?: string } = {}) {
  const ctx = await makeCtx({ env: options.env ?? FULL_ENV, profile: PROFILE, ...(options.settings ? { settings: options.settings } : {}) });
  return ctx;
}

function useRealProviders(ctx: SetupContext): void {
  const fetch = async (): Promise<Response> => {
    throw new Error("Kein Netz in Tests");
  };
  ctx.providers = createProviders({ run: (cmd, o) => ctx.run(cmd, o), fetch });
}

describe("PATH aus der Dienstdatei", () => {
  test("Plist: EnvironmentVariables.PATH, XML-Maskierung aufgelöst", () => {
    const xml = writePlist({ Label: "x", ProgramArguments: ["/a"], EnvironmentVariables: { HOME: "/h", PATH: "/a&b/bin:/usr/bin" } });
    expect(plistPath(xml)).toBe("/a&b/bin:/usr/bin");
    expect(plistPath(writePlist({ Label: "x", EnvironmentVariables: { HOME: "/h" } }))).toBeNull();
    expect(plistPath("bplist00 binär")).toBeNull();
  });

  test("systemd: Environment=PATH=…, auch in Anführungszeichen, die letzte Angabe gilt", () => {
    expect(unitPath("[Service]\nEnvironment=PATH=/a:/b\nEnvironment=X=1\n")).toBe("/a:/b");
    expect(unitPath('[Service]\nEnvironment="PATH=/c:/d"\n')).toBe("/c:/d");
    expect(unitPath("[Service]\nEnvironment=PATH=/a\nEnvironment=PATH=/z\n")).toBe("/z");
    expect(unitPath("[Service]\nExecStart=/bin/true\n")).toBeNull();
  });

  test("macOS, Linux, fehlende, unlesbare und PATH-lose Dienstdatei, andere Plattform", async () => {
    const base = { platform: "darwin" as NodeJS.Platform, launchAgentsDir: "/la", systemdUserDir: "/sd" };
    const files: Record<string, string | Error> = {
      "/la/ai.tybo.telegram-relay.plist": writePlist({ EnvironmentVariables: { PATH: "/p" } }),
      "/sd/tybo-telegram-relay.service": "Environment=PATH=/q\n",
    };
    const fs = (map: Record<string, string | Error>) => ({
      readFile: async (p: string) => {
        const v = map[p];
        if (v === undefined) throw Object.assign(new Error("fehlt"), { code: "ENOENT" });
        if (v instanceof Error) throw v;
        return v;
      },
    });
    expect(await servicePath(base, fs(files))).toEqual({ source: "launchd", file: "/la/ai.tybo.telegram-relay.plist", path: "/p" });
    expect(await servicePath({ ...base, platform: "linux" }, fs(files))).toEqual({ source: "systemd", file: "/sd/tybo-telegram-relay.service", path: "/q" });
    expect(await servicePath(base, fs({}))).toEqual({ source: "shell", reason: "missing" });
    const denied = Object.assign(new Error("verboten"), { code: "EACCES" });
    expect(await servicePath(base, fs({ "/la/ai.tybo.telegram-relay.plist": denied }))).toEqual({ source: "shell", reason: "unreadable", file: "/la/ai.tybo.telegram-relay.plist" });
    expect(await servicePath(base, fs({ "/la/ai.tybo.telegram-relay.plist": "<plist/>" }))).toEqual({ source: "shell", reason: "no-path", file: "/la/ai.tybo.telegram-relay.plist" });
    expect(await servicePath({ ...base, platform: "win32" }, fs(files))).toEqual({ source: "shell", reason: "missing" });
    // Für den ganzen Bericht: der PATH des Diensts, sonst undefined (PATH dieser Shell)
    expect(await engineCheckPath(base, fs(files))).toBe("/p");
    expect(await engineCheckPath(base, fs({}))).toBeUndefined();
  });
});

describe("Abschnitt Motor: Claude Code", () => {
  test("bereit: geprüft mit dem PATH der Plist, im Projektordner, ohne Modellaufruf", async () => {
    const ctx = await engineCtx();
    await writeBotPlist(ctx);
    const seen = installRun(ctx, CLAUDE_READY);
    const found = await engineFindings(ctx, {});
    expect(found).toEqual([
      { label: "Standard-Motor Claude Code (ohne Einstellung)", status: "pass", detail: "Claude Code 2.1.300 ist angemeldet" },
      { label: "PATH", status: "pass", detail: "geprüft mit dem PATH aus ai.tybo.telegram-relay.plist" },
    ]);
    const claude = seen.filter(s => s.cmd[0] === "claude");
    expect(claude.map(s => s.cmd)).toEqual([["claude", "--version"], ["claude", "auth", "status", "--json"]]);
    for (const s of claude) {
      expect(s.options?.env?.PATH).toBe(SERVICE_PATH);
      expect(s.options?.cwd).toBe(ctx.root);
      expect(s.options?.env?.TYBO_SUBPROCESS).toBe("1");
    }
    expect(seen.some(s => s.cmd.includes("-p"))).toBe(false);
    expect(JSON.stringify(found)).not.toMatch(/alex@example|Beispiel GmbH/);
  });

  test("in der Shell da, im PATH des Diensts nicht: nicht installiert, mit Abhilfe", async () => {
    const ctx = await engineCtx();
    await writeBotPlist(ctx);
    installRun(ctx, CLAUDE_READY, { pathFor: SHELL_PATH });
    const [line] = await engineFindings(ctx, {});
    expect(line).toEqual({ label: "Standard-Motor Claude Code (ohne Einstellung)", status: "fail", detail: `${CLAUDE_NOT_INSTALLED}. Abhilfe: ${CLAUDE_INSTALL}` });
  });

  test("ohne Dienstdatei gilt der PATH der Shell, und die Zeile PATH sagt das", async () => {
    const ctx = await engineCtx();
    const seen = installRun(ctx, CLAUDE_READY, { pathFor: SHELL_PATH });
    const found = await engineFindings(ctx, {});
    expect(found[0].status).toBe("pass");
    expect(found[1]).toEqual({ label: "PATH", status: "skip", detail: "keine Dienstdatei des Bots (launchd, systemd), geprüft mit dem PATH dieser Shell" });
    expect(seen.find(s => s.cmd[0] === "claude")?.options?.env?.PATH).toBe(SHELL_PATH);
  });

  test("Dienstdatei ohne PATH: Warnung, geprüft mit dem PATH der Shell", async () => {
    const ctx = await engineCtx();
    await writeBotPlist(ctx, null);
    installRun(ctx, CLAUDE_READY, { pathFor: SHELL_PATH });
    const found = await engineFindings(ctx, {});
    expect(found[0].status).toBe("pass");
    expect(found[1]).toEqual({ label: "PATH", status: "warn", detail: "ai.tybo.telegram-relay.plist nennt keinen PATH, geprüft mit dem PATH dieser Shell. Neu schreiben: tybo setup autostart" });
  });

  test("nicht angemeldet: Fehler mit /login", async () => {
    const ctx = await engineCtx();
    await writeBotPlist(ctx);
    installRun(ctx, { ...CLAUDE_READY, "claude auth status --json": { code: 1, stdout: AUTH(false) } });
    const [line] = await engineFindings(ctx, {});
    expect(line).toEqual({ label: "Standard-Motor Claude Code (ohne Einstellung)", status: "fail", detail: CLAUDE_NOT_LOGGED_IN });
    expect(line.detail).toContain("/login");
  });

  test("Zeitlimit oder unlesbare Ausgabe: nicht prüfbar, Fehler mit Abhilfe, weder angemeldet noch abgemeldet", async () => {
    const cases = [
      { answer: { code: -1, stdout: "", timedOut: true }, timedOut: true },
      { answer: { code: 1, stdout: "error: unknown command 'auth'" }, timedOut: false },
    ];
    for (const { answer, timedOut } of cases) {
      const ctx = await engineCtx();
      await writeBotPlist(ctx);
      installRun(ctx, { ...CLAUDE_READY, "claude auth status --json": answer });
      const [line] = await engineFindings(ctx, {});
      expect(line).toEqual({ label: "Standard-Motor Claude Code (ohne Einstellung)", status: "fail", detail: claudeLoginUnknown("Claude Code 2.1.300", timedOut) });
      expect(line.detail).toContain("nicht prüfbar");
      expect(line.detail).toContain("Abhilfe:");
      expect(line.detail).toContain(timedOut ? "länger als 5 s" : "keine lesbare Antwort");
      expect(line.detail).not.toContain(CLAUDE_NOT_LOGGED_IN);
    }
  });

  test("CLAUDE_AUTH=apiKey ohne Schlüssel in der .env: Fehler ohne Anmeldefrage", async () => {
    const env = `${FULL_ENV}CLAUDE_AUTH=apiKey\n`;
    const ctx = await engineCtx({ env });
    await writeBotPlist(ctx);
    const seen = installRun(ctx, CLAUDE_READY);
    const [line] = await engineFindings(ctx, { CLAUDE_AUTH: "apiKey" });
    expect(line).toMatchObject({ status: "fail", detail: CLAUDE_API_KEY_MISSING });
    expect(seen.some(s => s.cmd.join(" ") === "claude auth status --json")).toBe(false);
  });
});

describe("Abschnitt Motor: Codex, OpenCode, Anthropic API", () => {
  const CODEX: Programs = { "codex --version": { stdout: "codex-cli 0.155.1" }, "codex login status": { code: 0 } };
  const OPENCODE: Programs = {
    "opencode --version": { stdout: "1.2.3" },
    "opencode auth list": { stdout: "Credentials ~/.local/share/opencode/auth.json\n● OpenRouter api\n1 credentials\n" },
  };

  async function codexCtx(programs: Programs, pathFor?: string) {
    const ctx = await engineCtx({ settings: JSON.stringify({ engine: { default: "codex" } }) });
    await writeBotPlist(ctx);
    const seen = installRun(ctx, programs, pathFor ? { pathFor } : {});
    useRealProviders(ctx);
    return { ctx, seen };
  }

  test("Codex bereit (aus config/settings.json): geprüft mit dem PATH des Diensts, Claude wird nicht gefragt", async () => {
    const { ctx, seen } = await codexCtx(CODEX);
    const [line] = await engineFindings(ctx, {});
    expect(line).toEqual({ label: "Standard-Motor Codex (aus config/settings.json)", status: "pass", detail: "Codex 0.155.1 ist angemeldet." });
    expect(seen.filter(s => s.cmd[0] === "codex").every(s => s.options?.env?.PATH === SERVICE_PATH)).toBe(true);
    expect(seen.some(s => s.cmd[0] === "claude")).toBe(false);
  });

  test("Codex nur in der Shell: nicht installiert, Fehler mit Abhilfe", async () => {
    const { ctx } = await codexCtx(CODEX, SHELL_PATH);
    const [line] = await engineFindings(ctx, {});
    expect(line).toMatchObject({ status: "fail", detail: CODEX_MISSING });
  });

  test("Codex abgemeldet: Fehler mit codex login", async () => {
    const { ctx } = await codexCtx({ ...CODEX, "codex login status": { code: 1 } });
    const [line] = await engineFindings(ctx, {});
    expect(line.status).toBe("fail");
    expect(line.detail.startsWith(CODEX_LOGGED_OUT)).toBe(true);
  });

  test("OpenCode über TYBO_ENGINE: bereit, nicht installiert, nicht angemeldet", async () => {
    const make = async (programs: Programs, pathFor?: string) => {
      const ctx = await engineCtx({ env: `${FULL_ENV}TYBO_ENGINE=opencode\n` });
      await writeBotPlist(ctx);
      installRun(ctx, programs, pathFor ? { pathFor } : {});
      useRealProviders(ctx);
      return (await engineFindings(ctx, {}))[0];
    };
    expect(await make(OPENCODE)).toEqual({ label: "Standard-Motor OpenCode (aus TYBO_ENGINE in der .env)", status: "pass", detail: "OpenCode 1.2.3 ist angemeldet." });
    expect((await make(OPENCODE, SHELL_PATH)).status).toBe("fail");
    const loggedOut = await make({ ...OPENCODE, "opencode auth list": { stdout: "Credentials ~/x\n0 credentials\n" } });
    expect(loggedOut).toMatchObject({ status: "fail", detail: OPENCODE_LOGGED_OUT });
  });

  test("Anthropic API: Schlüssel da oder fehlt, keine CLI", async () => {
    const make = async (env: string) => {
      const ctx = await engineCtx({ env, settings: JSON.stringify({ engine: { default: "api" } }) });
      const seen = installRun(ctx, {});
      useRealProviders(ctx);
      const [line] = await engineFindings(ctx, {});
      expect(seen.filter(s => s.cmd[0] !== "launchctl")).toEqual([]);
      return line;
    };
    expect(await make(FULL_ENV)).toMatchObject({ status: "fail", detail: `${API_KEY_ABSENT} Abhilfe: ANTHROPIC_API_KEY in der .env eintragen` });
    const key = "sk-ant-test-geheim-4242";
    const ready = await make(`${FULL_ENV}ANTHROPIC_API_KEY=${key}\n`);
    expect(ready).toMatchObject({ status: "pass" });
    expect(JSON.stringify(ready)).not.toContain(key);
  });
});

describe("tybo pruefen: jeder Störfall einzeln bei sonst gesunder Einrichtung (Issue #567)", () => {
  /** Telefonhörer ohne Modell und ohne Ollama: kein echter Befehl */
  const CALL: Partial<CallModelDeps> = { cliFlags: async () => ({ missing: [] }), ollamaCheck: async () => "Ollama läuft nicht" };
  const RUNNING = "4711\t0\tai.tybo.telegram-relay\n";

  async function pruefen(options: { programs?: Programs; listing?: string; settings?: string; pathFor?: string; anywhere?: string[] } = {}) {
    const ctx = await makeCtx({ env: FULL_ENV, profile: PROFILE, ...(options.settings ? { settings: options.settings } : {}) });
    await writeBotPlist(ctx);
    const seen = installRun(ctx, options.programs ?? CLAUDE_READY, {
      listing: options.listing ?? RUNNING,
      ...(options.pathFor ? { pathFor: options.pathFor } : {}),
      ...(options.anywhere ? { anywhere: options.anywhere } : {}),
    });
    // Motoren und Claude CLI echt prüfen (über die Befehls-Attrappe); alle übrigen Anbieter bleiben Attrappen ohne Netz
    const real = createProviders({ run: (cmd, o) => ctx.run(cmd, o), fetch: async () => { throw new Error("Kein Netz in Tests"); } });
    ctx.providers.engineCheck = real.engineCheck;
    ctx.providers.claudeVersion = real.claudeVersion;
    const out: string[] = [];
    const code = await runTybo({
      args: ["pruefen"],
      env: {},
      root: ctx.root,
      out: l => out.push(l),
      err: l => out.push(l),
      setup: { ctx },
      checks: { specials: defaultSpecials({ callModel: CALL }) },
    });
    return { code, out, ctx, seen };
  }

  function noEffects(r: Awaited<ReturnType<typeof pruefen>>): void {
    const methods = r.ctx.providers.calls.map(c => c.method);
    expect(methods).not.toContain("claudeProbe");
    expect(methods).not.toContain("telegramSendTest");
    expect(methods).not.toContain("supabaseWriteProbe");
    // Kein Modellaufruf: claude nur mit --version, auth status und --help
    for (const s of r.seen.filter(s => s.cmd[0] === "claude")) expect(["--version", "auth", "--help"]).toContain(s.cmd[1]);
    expect(r.seen.filter(s => s.cmd[0] === "launchctl").every(s => s.cmd[1] === "list")).toBe(true);
    expect(leakedSecrets(r.out)).toEqual([]);
  }

  test("gesund, Claude Code nur im PATH des Diensts: Voraussetzungen und Motor ✓, kein ✗, Exit 0", async () => {
    // Die Shell dieses Tests (SHELL_PATH) findet claude nicht; der Bericht prüft überall mit dem PATH der Plist
    const r = await pruefen();
    expect(r.out.filter(l => l.startsWith("  ✗"))).toEqual([]);
    expect(r.out).toContain("Motor");
    expect(r.out).toContain("  ✓ Voraussetzungen: Bun, Claude CLI und Git sind da.");
    expect(r.out).toContain("  ✓ Standard-Motor Claude Code (ohne Einstellung): Claude Code 2.1.300 ist angemeldet");
    expect(r.out).toContain("  ✓ telegram-relay: Läuft (PID: 4711)");
    const versions = r.seen.filter(s => s.cmd.join(" ") === "claude --version");
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions.every(s => s.options?.env?.PATH === SERVICE_PATH)).toBe(true);
    expect(r.code).toBe(0);
    noEffects(r);
  });

  test("gesund, Codex und Claude Code nur im PATH des Diensts: Voraussetzungen und Motor ✓, Exit 0", async () => {
    const CODEX: Programs = { "codex --version": { stdout: "codex-cli 0.155.1" }, "codex login status": { code: 0 } };
    const r = await pruefen({ settings: JSON.stringify({ engine: { default: "codex" } }), programs: { ...CLAUDE_READY, ...CODEX } });
    expect(r.out.filter(l => l.startsWith("  ✗"))).toEqual([]);
    expect(r.out.find(l => l.includes(" Voraussetzungen:"))).toStartWith("  ✓ Voraussetzungen: Bun, Codex und Git sind da.");
    expect(r.out).toContain("  ✓ Standard-Motor Codex (aus config/settings.json): Codex 0.155.1 ist angemeldet.");
    expect(r.seen.filter(s => s.cmd[0] === "codex" || s.cmd[0] === "claude").every(s => s.options?.env?.PATH === SERVICE_PATH)).toBe(true);
    expect(r.code).toBe(0);
    noEffects(r);
  });

  test("Claude-Anmeldung nicht prüfbar (Zeitlimit, unlesbare Ausgabe): ✗ mit Abhilfe, Exit 1, nie „in Ordnung“", async () => {
    const cases = [
      { answer: { code: -1, stdout: "", timedOut: true }, timedOut: true },
      { answer: { code: 0, stdout: "kein JSON" }, timedOut: false },
    ];
    for (const { answer, timedOut } of cases) {
      const r = await pruefen({ programs: { ...CLAUDE_READY, "claude auth status --json": answer } });
      expect(r.out).toContain(`  ✗ Standard-Motor Claude Code (ohne Einstellung): ${claudeLoginUnknown("Claude Code 2.1.300", timedOut)}`);
      expect(r.out.filter(l => l.startsWith("  ✗"))).toHaveLength(1);
      expect(r.out.join("\n")).not.toContain("Alles Nötige ist in Ordnung");
      expect(r.out.join("\n")).not.toContain("Alles in Ordnung");
      expect(r.code).toBe(1);
      noEffects(r);
    }
  });

  test("Fall 1: gewählter Motor Codex nur in der Shell, nicht im PATH des Diensts: ✗ mit Abhilfe, Exit 1", async () => {
    const CODEX: Programs = { "codex --version": { stdout: "codex-cli 0.155.1" }, "codex login status": { code: 0 } };
    const settings = JSON.stringify({ engine: { default: "codex" } });
    const healthy = await pruefen({ settings, programs: { ...CLAUDE_READY, ...CODEX }, anywhere: ["codex", "claude"] });
    expect(healthy.out).toContain("  ✓ Standard-Motor Codex (aus config/settings.json): Codex 0.155.1 ist angemeldet.");
    expect(healthy.code).toBe(0);
    const r = await pruefen({ settings, programs: { ...CLAUDE_READY, ...CODEX }, pathFor: SHELL_PATH, anywhere: ["claude"] });
    // Die Meldung nennt den Installationsbefehl schon, keine doppelte Abhilfe
    expect(r.out).toContain(`  ✗ Standard-Motor Codex (aus config/settings.json): ${CODEX_MISSING}`);
    // Voraussetzungen prüft mit demselben PATH und widerspricht nicht
    expect(r.out.find(l => l.includes(" Voraussetzungen:"))).toStartWith("  ✗ Voraussetzungen: Fehlt oder zu alt: Codex.");
    expect(r.out.filter(l => l.startsWith("  ✗"))).toHaveLength(2);
    expect(r.code).toBe(1);
    noEffects(r);
  });

  test("Fall 1b: Codex abgemeldet: ✗ im Abschnitt Motor, Exit 1", async () => {
    const CODEX: Programs = { "codex --version": { stdout: "codex-cli 0.155.1" }, "codex login status": { code: 1 } };
    const r = await pruefen({ settings: JSON.stringify({ engine: { default: "codex" } }), programs: { ...CLAUDE_READY, ...CODEX }, anywhere: ["codex", "claude"] });
    expect(r.out.find(l => l.includes("Standard-Motor Codex"))).toStartWith(`  ✗ Standard-Motor Codex (aus config/settings.json): ${CODEX_LOGGED_OUT}`);
    expect(r.code).toBe(1);
    noEffects(r);
  });

  test("Fall 2: Claude Code nicht angemeldet: ✗ mit /login, Exit 1, kein Probeaufruf", async () => {
    const r = await pruefen({ programs: { ...CLAUDE_READY, "claude auth status --json": { code: 1, stdout: AUTH(false) } } });
    expect(r.out).toContain(`  ✗ Standard-Motor Claude Code (ohne Einstellung): ${CLAUDE_NOT_LOGGED_IN}`);
    expect(r.out.filter(l => l.startsWith("  ✗"))).toHaveLength(1);
    expect(r.out.join("\n")).not.toContain("Alles in Ordnung");
    expect(r.code).toBe(1);
    noEffects(r);
  });

  test("Fall 3: Bot unter macOS geladen, aber ohne Prozess (Exit 0 und ungleich 0): ✗, Exit 1", async () => {
    for (const exit of ["0", "1", "-9"]) {
      const r = await pruefen({ listing: `-\t${exit}\tai.tybo.telegram-relay\n` });
      const line = r.out.find(l => l.includes(" telegram-relay:"));
      expect(line).toStartWith("  ✗ telegram-relay: Geladen, läuft aber nicht");
      expect(line).toContain(`letzter Exit-Code ${exit}`);
      expect(line).toContain("logs/telegram-relay.error.log");
      expect(r.out.filter(l => l.startsWith("  ✗"))).toHaveLength(1);
      expect(r.code).toBe(1);
      noEffects(r);
    }
  });
});

/** Die echte CLI-Probe ist als gekürzter, rein künstlicher Ausschnitt festgehalten. */
const SKILL_FIXTURE = readFileSync(join(import.meta.dir, "fixtures/codex-prompt-input-skills.json"), "utf8");
const skillOutput = (root: string) => SKILL_FIXTURE.replaceAll("/project", realpathSync(root));
const emptyInspection = () => ({ expected: [], linked: [], foreign: [], skipped: [] });
const toolData = (): EngineTools => ({
  inventory: { mcp: [{ name: "mail", origin: "tybo" }], skills: [], notes: "passed", state: "ok" },
  gaps: { mcp: [{ name: "oauth", reason: "auth_unknown" }], skills: [], hints: [], notes: false, plugins: null, fixed: ["connectors", "hooks", "builtin"] },
});
const mcpPlan = (): CodexMcpPlan => ({ passed: [{ name: "mail", kind: "stdio", source: "tybo" }], own: [], skipped: [],
  args: ["-c", 'mcp_servers.mail.command="bun"'], env: {}, secretValues: [] });
function toolDeps(extra: Partial<EngineToolDeps> = {}): Partial<EngineToolDeps> {
  return { ready: async () => true, snapshot: () => ({ inventory: () => toolData().inventory, gaps: () => toolData().gaps }),
    plan: () => mcpPlan(), mcpServers: async () => ["mail"], inspectSkills: emptyInspection,
    prompt: async () => { throw new Error("Unerwarteter CLI-Aufruf"); }, ...extra };
}

describe("Werkzeuge im Prüfbericht (Issue #666)", () => {
  let logs: ReturnType<typeof spyOn>[];
  let spawn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    spawn = spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Kein echtes Programm im Test"); });
    logs = ["log", "error", "warn"].map(method => spyOn(console, method as "log").mockImplementation(() => {}));
  });
  afterEach(() => {
    expect(spawn).not.toHaveBeenCalled(); spawn.mockRestore();
    logs.forEach(log => log.mockRestore());
  });
  test("Lücken bleiben pass, nur bereite Ersatzmotoren; ein Snapshot für den ganzen Bericht", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    let snapshots = 0;
    const checks = engineToolChecks(toolDeps({ ready: async engine => engine !== "opencode", snapshot: () => {
      snapshots++; return { inventory: () => toolData().inventory, gaps: () => toolData().gaps };
    } }));
    const report = await collectReport({ ctx, steps: [], specials: checks });
    expect(report.lines.filter(l => l.section === "Motor").map(l => [l.label, l.status])).toEqual([["Werkzeuge Codex", "pass"], ["Werkzeuge Anthropic API", "pass"]]);
    expect(formatReport(report).join("\n")).toContain("Fehlt: 1 MCP-Server");
    expect(reportExitCode(report)).toBe(0);
    expect(snapshots).toBe(1);
    await collectReport({ ctx, steps: [], specials: checks });
    expect(snapshots).toBe(2);
  });
  test("MCP: genau die Planargumente, angewandte Umgebung und Rechte aus codexSandbox", async () => {
    const ctx = await makeCtx({ env: "CODEX_PATH=codex-test\n", settings: JSON.stringify({ engine: { codex: { sandbox: "read-only" } } }) });
    ctx.enginePath = SERVICE_PATH;
    const plan = mcpPlan(); const base = { HOME: ctx.home, PATH: SERVICE_PATH }; const applied = { ...base, EXTRA: "erfunden" };
    let sandboxCalls = 0, planCalls = 0, applyCalls = 0, reads = 0;
    const [line] = await engineToolFindings(ctx, "codex", toolDeps({
      codexEnv: (root, key, options) => { expect(root).toBe(ctx.root); expect(key).toBeUndefined(); expect(options).toMatchObject({ quiet: true, home: ctx.home, env: { PATH: SERVICE_PATH } }); return base; },
      codexSandbox: settings => { sandboxCalls++; return codexSandbox(settings); },
      plan: input => { planCalls++; expect(input.baseEnv).toBe(base); expect(input.sandbox).toBe("read-only"); expect(input.cwd).toBe(ctx.root); return plan; },
      applyEnv: (env, p) => { applyCalls++; expect(env).toBe(base); expect(p).toBe(plan); return applied; },
      mcpServers: async options => { reads++; expect(options.args).toBe(plan.args); expect(options.env).toBe(applied); expect(options.root).toBe(ctx.root); expect(options.codexPath).toBe("codex-test"); expect(options.signal).toBeInstanceOf(AbortSignal); return []; },
    }));
    expect([sandboxCalls, planCalls, applyCalls, reads]).toEqual([1, 1, 1, 1]);
    expect(line).toMatchObject({ status: "warn" }); expect(line!.detail).toContain("MCP nicht angekommen: mail");
    expect(reportExitCode({ lines: [{ ...line!, section: "Motor" }] })).toBe(0);
  });
  test("echter HTTP-Plan mit Kopfzeilen kommt durch applyCodexMcpEnv bis zum Leser", async () => {
    const ctx = await makeCtx(); let read = false;
    const [line] = await engineToolFindings(ctx, "codex", toolDeps({ plan: input => planCodexMcp({
      sources: [{ name: "mail", source: "tybo", config: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer erfundene-kopfzeile", "X-Team": "erfundenes-team" } } }],
      own: { names: new Set(), readable: true }, settings: {}, sandbox: input.sandbox, baseEnv: input.baseEnv,
      parentEnv: {}, lookup: () => undefined, knownSecrets: [],
    }), applyEnv: applyCodexMcpEnv, mcpServers: async options => {
      read = true;
      expect(options.env.TYBO_MCP_MAIL_BEARER_TOKEN).toBe("erfundene-kopfzeile");
      expect(options.env.TYBO_MCP_MAIL_HEADER_X_TEAM_TOKEN).toBe("erfundenes-team");
      expect(options.args!.join(" ")).toContain("env_http_headers");
      return ["mail"];
    } }));
    expect(read).toBe(true); expect(line!.status).toBe("pass"); expect(line!.detail).not.toContain("nicht geprüft");
    expect(JSON.stringify(line)).not.toContain("TYBO_MCP_");
    expect(JSON.stringify(line)).not.toContain("erfundene-kopfzeile");
  });
  test("leerer Plan und leere expected fragen keine CLI und erzeugen keinen Vergleichsvermerk", async () => {
    const ctx = await makeCtx(); let calls = 0;
    const [line] = await engineToolFindings(ctx, "codex", toolDeps({ plan: () => ({ ...mcpPlan(), passed: [] }),
      mcpServers: async () => { calls++; return []; }, prompt: async () => { calls++; throw new Error(); } }));
    expect(calls).toBe(0); expect(line!.status).toBe("pass");
    expect(line!.detail).not.toContain("nicht geprüft"); expect(line!.detail).not.toContain("nicht angekommen");
  });
  test.each(["plan", "applyEnv"] as const)("Wurf in %s: MCP nicht geprüft, kein Leser und pass", async key => {
    const ctx = await makeCtx(); let reads = 0;
    const [line] = await engineToolFindings(ctx, "codex", toolDeps({ [key]: () => { throw new Error("PRIVAT_MARKER"); }, mcpServers: async () => { reads++; return []; } }));
    expect(reads).toBe(0); expect(line).toMatchObject({ status: "pass" }); expect(line!.detail).toContain("MCP: nicht geprüft");
    expect(JSON.stringify(line)).not.toContain("PRIVAT");
  });
  test("Skills: expected ist maßgeblich, abweichender Kopfname funktioniert, linked und foreign werden nicht verlangt", async () => {
    const ctx = await makeCtx(); let prompts = 0;
    const [line] = await engineToolFindings(ctx, "codex", toolDeps({ inspectSkills: () => ({ expected: ["folder_probe", "geloescht"], linked: ["nur_linked"], foreign: ["nur_foreign"], skipped: [] }),
      prompt: async (cmd, options) => {
        prompts++; expect(cmd.slice(0, 4)).toEqual(["codex", "debug", "prompt-input", "hallo"]);
        expect(cmd.slice(4, 4 + CODEX_JOB_TOOL_ARGS.length)).toEqual([...CODEX_JOB_TOOL_ARGS]);
        expect(cmd.at(-1)).toBe('mcp_servers={"mail"={enabled=false}}');
        expect(options).toMatchObject({ cwd: ctx.root, timeoutMs: 15_000 });
        expect(options!.signal).toBeInstanceOf(AbortSignal);
        return { code: 0, stdout: skillOutput(ctx.root), stderr: "PRIVAT_STDERR" };
      } }));
    expect(prompts).toBe(1); expect(line!.status).toBe("warn"); expect(line!.detail).toContain("Skills nicht angekommen: geloescht");
    for (const name of ["folder_probe", "header-probe", "nur_linked", "nur_foreign", "PRIVAT_STDERR"]) expect(line!.detail).not.toContain(name);
  });
  test("gelöschter echter Link und CODEX_HOME-Kollision: inspect statt Bestand; CLI über ctx.run", async () => {
    const ctx = await makeCtx({ env: "CODEX_HOME=codex-eigen\n", settings: '{"engine":{"codex":{"skills":true}}}' });
    const dir = join(ctx.root, ".claude", "skills", "folder_probe");
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, "SKILL.md"), "---\nname: header-probe\ndescription: Beispiel\n---\n");
    const input = { root: ctx.root, home: ctx.home, enabled: true, codexHome: join(ctx.root, "codex-eigen") };
    syncCodexSkillLinks(input);
    await unlink(join(ctx.root, ".agents", "skills", "folder_probe"));
    let calls = 0;
    ctx.run = Object.assign(async () => { calls++; return { code: 0, stdout: skillOutput(ctx.root).replaceAll("folder_probe/SKILL.md", "anderer/SKILL.md"), stderr: "" }; }, { calls: [] });
    const deps = toolDeps({ inspectSkills: (actual, onError) => { expect(actual).toEqual(input); return inspectCodexSkillLinks(actual, onError); } });
    delete deps.prompt;
    const [line] = await engineToolFindings(ctx, "codex", deps);
    expect(line!.detail).toContain("Skills nicht angekommen: folder_probe"); expect(calls).toBe(1);
    const own = join(input.codexHome, "skills", "kollision"); await mkdir(own, { recursive: true });
    await writeFile(join(own, "SKILL.md"), "---\nname: header-probe\ndescription: Beispiel\n---\n");
    await engineToolFindings(ctx, "codex", deps); expect(calls).toBe(1);
  });
  for (const kind of ["Wurf", "Zeitlimit", "unlesbar", "CLI-Timeout"] as const) {
    test(`beide Vergleiche: ${kind} wird nicht geprüft und bleibt pass`, async () => {
      const ctx = await makeCtx(); const aborted: string[] = [];
      const hang = (signal: AbortSignal, label: string) => new Promise<never>(() => { signal.addEventListener("abort", () => aborted.push(label)); });
      const [line] = await engineToolFindings(ctx, "codex", toolDeps({ timeoutMs: 15, inspectSkills: () => ({ ...emptyInspection(), expected: ["folder_probe"] }),
        mcpServers: async options => {
          if (kind === "Zeitlimit") return hang(options.signal!, "mcp");
          if (kind === "unlesbar") return parseCodexMcpNames({ secret: "PRIVAT" });
          throw new Error("PRIVAT");
        }, prompt: async (_, options) => {
          if (kind === "Zeitlimit") return hang(options!.signal!, "skills");
          if (kind === "Wurf") throw new Error("PRIVAT");
          return { code: 0, stdout: kind === "unlesbar" ? "PRIVAT" : skillOutput(ctx.root), stderr: "", timedOut: kind === "CLI-Timeout" };
        } }));
      expect(line!.status).toBe("pass"); expect(line!.detail).toContain("MCP: nicht geprüft"); expect(line!.detail).toContain("Skills: nicht geprüft");
      if (kind === "Zeitlimit") expect(aborted.sort()).toEqual(["mcp", "skills"]);
    });
  }
  test("Abbruch erreicht beide Vergleiche, ihr Zeitbudget ist parallel und vom Motor getrennt", async () => {
    const ctx = await makeCtx(); const controller = new AbortController(); const aborted: string[] = [];
    let started = 0;
    const hang = (signal: AbortSignal, label: string) => new Promise<never>(() => {
      signal.addEventListener("abort", () => aborted.push(label));
      if (++started === 2) controller.abort();
    });
    const [line] = await engineToolFindings(ctx, "codex", toolDeps({ inspectSkills: () => ({ ...emptyInspection(), expected: ["x"] }),
      mcpServers: o => hang(o.signal!, "mcp"), prompt: (_, o) => hang(o!.signal!, "skills") }), controller.signal);
    expect(aborted.sort()).toEqual(["mcp", "skills"]); expect(line!.status).toBe("pass");
    expect(TOOL_COMPARE_TIMEOUT_MS).toBe(15_000);
    expect(defaultSpecials().filter(c => c.section === "Motor").map(c => c.id)).toEqual(["motor", "werkzeuge-codex", "werkzeuge-opencode", "werkzeuge-api"]);
  });
  test("unvollständiger Bestand oder Ersatzname startet keine Skill-CLI", async () => {
    const ctx = await makeCtx();
    for (const inventory of [{ ...toolData().inventory, state: "unknown" as const }, { ...toolData().inventory, mcp: [{ name: "unzulaessig-12345678", origin: "engine" as const }] }]) {
      let calls = 0;
      const [line] = await engineToolFindings(ctx, "codex", toolDeps({ snapshot: () => ({ inventory: () => inventory, gaps: () => toolData().gaps }), inspectSkills: () => ({ ...emptyInspection(), expected: ["x"] }),
        prompt: async () => { calls++; throw new Error(); } }));
      expect(calls).toBe(0); expect(line!.detail).toContain("Skills: nicht geprüft"); expect(line!.status).toBe("pass");
      if (inventory.state === "unknown") expect(line!.detail).toStartWith("Bestand unvollständig lesbar.");
    }
  });
  test("Berichtsgrenze bewahrt beide Vergleichsergebnisse und zählt weitere Namen", async () => {
    const ctx = await makeCtx();
    const plan = mcpPlan(); plan.passed = Array.from({ length: 20 }, (_, i) => ({ name: `server_mit_langem_namen_${i}`, kind: "stdio", source: "tybo" }));
    const [line] = await engineToolFindings(ctx, "codex", toolDeps({ plan: () => plan, mcpServers: async () => [],
      inspectSkills: () => ({ ...emptyInspection(), expected: plan.passed.map(s => s.name) }), prompt: async () => ({ code: 0, stdout: skillOutput(ctx.root), stderr: "" }) }));
    expect(line!.detail.length).toBeLessThanOrEqual(300); expect(line!.detail).toContain("MCP nicht angekommen"); expect(line!.detail).toContain("Skills nicht angekommen"); expect(line!.detail).toContain("(+17)");
  });
  test("CLI-Inhalte, Planargumente und Umgebungswerte bleiben aus Bericht und Log", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const plan = mcpPlan(); plan.args.push("-c", 'mcp_servers.mail.args=["PRIVAT_ARGS"]'); plan.env = { BEISPIEL_TOKEN: "PRIVAT_ENV" }; plan.secretValues = ["PRIVAT_SECRET"];
    const report = await collectReport({ ctx, steps: [], specials: engineToolChecks(toolDeps({ plan: () => plan,
      mcpServers: async () => parseCodexMcpNames({ mcp_servers: { mail: { url: "https://PRIVAT.invalid", env: { BEISPIEL_TOKEN: "PRIVAT_ANTWORT" } } } }),
      inspectSkills: () => ({ ...emptyInspection(), expected: ["folder_probe"] }),
      prompt: async () => ({ code: 0, stdout: skillOutput(ctx.root).replace("Public test description.", "PRIVAT_SKILL BEISPIEL_TOKEN"), stderr: "PRIVAT_STDERR" }),
    })) });
    const text = formatReport(report).join("\n") + JSON.stringify(logs.map(log => log.mock.calls));
    for (const forbidden of ["PRIVAT", "-c mcp_servers", "TYBO_MCP_", "BEISPIEL_TOKEN", ctx.home]) expect(text).not.toContain(forbidden);
    expect(reportExitCode(report)).toBe(0);
  });
  test("TYBO_ROOT aus fremdem Arbeitsordner: dieselben Quellen, Einstellungen und Umgebung wie im Projekt", async () => {
    const ctx = await makeCtx({ profile: PROFILE, env: `${FULL_ENV}MCP_CONFIG_PATH=config/extra-mcp.json\nCODEX_HOME=codex-eigen\nCODEX_PATH=codex-test\nQUELLE_TOKEN=ERFUNDENER_KONTEXT\n`, settings: '{"engine":{"codex":{"sandbox":"full","skills":false}}}' });
    ctx.enginePath = SERVICE_PATH;
    await writeBotPlist(ctx);
    await writeFile(join(ctx.root, "config", "extra-mcp.json"), JSON.stringify({ servers: { quelle: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${QUELLE_TOKEN}" } } } }));
    const read = (path: string) => {
      if (!path.startsWith(ctx.root + "/")) throw Object.assign(new Error("fehlt"), { code: "ENOENT" });
      return readFileSync(path, "utf8");
    };
    setCodexMcpReaderForTests(read);
    setToolParityReadersForTests({ text: read, children: path => readdirSync(path), stat: path => statSync(path), inspectSkills: inspectCodexSkillLinks });
    const calls: string[] = [];
    const specials = engineToolChecks({ ready: async id => id === "codex", mcpServers: async o => {
      expect(o.root).toBe(ctx.root); expect(o.codexPath).toBe("codex-test"); expect(o.env.PATH).toBe(SERVICE_PATH);
      expect(o.env.TYBO_MCP_QUELLE_BEARER_TOKEN).toBe("ERFUNDENER_KONTEXT"); calls.push("read"); return ["quelle"];
    } });
    const run = async () => {
      const out: string[] = [];
      const code = await runTybo({ args: ["pruefen"], env: { TYBO_ROOT: ctx.root }, out: text => out.push(text), err: text => out.push(text), setup: { ctx }, checks: { specials } });
      expect([0, 1]).toContain(code);
      return out.filter(text => text.includes("Werkzeuge Codex"));
    };
    const cwd = process.cwd();
    try {
      process.chdir(ctx.root); const inside = await run();
      process.chdir(ctx.home); const outside = await run();
      expect(outside).toEqual(inside); expect(outside.join("\n")).toContain("1 MCP-Server"); expect(calls).toHaveLength(2);
      expect(outside.join("\n")).not.toContain("ERFUNDENER_KONTEXT");
    } finally { process.chdir(cwd); }
  });
  test("Parser lehnt fehlende, gekürzte und unbekannte Listen ab", () => {
    expect(parseCodexSkillNames(SKILL_FIXTURE, "/project")).toEqual(["folder_probe"]);
    for (const output of ["kaputt", "{}", "[]", SKILL_FIXTURE.replace("### Available skills", "### Skills"), SKILL_FIXTURE.replace("Public test description. (file: r1/folder_probe/SKILL.md)", "…"), SKILL_FIXTURE.replace("</skills_instructions>", "")]) {
      expect(() => parseCodexSkillNames(output, "/project")).toThrow();
    }
  });
});
