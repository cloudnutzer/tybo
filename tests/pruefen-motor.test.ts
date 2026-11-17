/**
 * Issue #567: `tybo pruefen` prüft den Standard-Motor (installiert,
 * angemeldet, mit dem PATH aus der Dienstdatei) und meldet einen geladenen,
 * aber nicht laufenden Bot unter macOS als Fehler.
 *
 * Alles Äußere sind Attrappen: Befehle über ctx.run (kein echtes claude,
 * codex, opencode, launchctl oder systemctl), kein Netz, kein Modell.
 * src/bot.ts wird weder importiert noch gestartet.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
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
