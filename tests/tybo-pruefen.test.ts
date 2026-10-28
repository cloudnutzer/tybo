/**
 * Issue #371: tybo pruefen (und der Alias bun run setup:verify). Alles
 * Äußere sind Attrappen aus setup-fixture: kein Netz, kein launchctl, kein
 * Modell, src/bot.ts wird weder importiert noch gestartet.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTybo } from "../scripts/tybo";
import { SYSTEMD_UNIT_FILE } from "../setup/configure-systemd";
import { collectReport, formatReport, reportExitCode, stepLine, type SpecialCheck } from "../src/setup/checks/report";
import { callCheck, databaseCheck, defaultSpecials, extrasCheck, servicesCheck, telegramCheck } from "../src/setup/checks/specials";
import type { CommandResult, RunOptions } from "../src/setup/context";
import { LOCAL_SUPABASE_URL } from "../src/setup/local-supabase";
import { createProviders } from "../src/setup/providers";
import { prerequisitesStep } from "../src/setup/steps/prerequisites";
import type { SetupStep, StepId, StepStatus } from "../src/setup/model";
import { CLI_REQUIRED_FLAGS } from "../src/lib/voice-brain/backends/claude-cli";
import type { CallModelDeps } from "../src/lib/voice-brain/call-model";
import { cleanup, FAKE, fakeRun, FULL_ENV, leakedSecrets, makeCtx } from "./setup-fixture";

afterAll(cleanup);

const REPO = resolve(import.meta.dir, "..");
const WEB_ONLY = `WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\nSUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\n`;
const AGENT = "987654321:AAFakeAgentTokenForTests_zyxwvutsrqpon";

/** Telefonhörer ohne Claude Code und Ollama: nie ein echter Befehl */
const NO_CALL_WAYS: Partial<CallModelDeps> = {
  inspectClaude: async () => ({ engine: "claude", checked: true, installed: false, loggedIn: false, message: "nicht installiert" }),
  cliFlags: async () => ({ missing: [] }),
  ollamaCheck: async () => "Ollama läuft nicht",
};

/** Schritt-Attrappe mit Aufrufzählern; test und apply dürfen nie laufen */
function fakeStep(id: StepId, optional: boolean, status: StepStatus | (() => Promise<StepStatus>)) {
  const calls = { status: 0, test: 0, apply: 0 };
  const step: SetupStep = {
    id,
    title: `Schritt ${id}`,
    description: "",
    optional,
    fields: [],
    async status() {
      calls.status++;
      return typeof status === "function" ? status() : status;
    },
    async test() {
      calls.test++;
      return { ok: true, message: "" };
    },
    async apply() {
      calls.apply++;
      return { ok: true, message: "", changed: [] };
    },
  };
  return { step, calls };
}

const done = (detail = "erledigt"): StepStatus => ({ state: "erledigt", detail, fields: [] });
const missing = (detail = "fehlt"): StepStatus => ({ state: "fehlt", detail, fields: [] });
const partial = (detail = "halb"): StepStatus => ({ state: "teilweise", detail, fields: [] });

describe("Zeilen aus Schritt-Zuständen", () => {
  test("erledigt ist bestanden, optional offen übersprungen, optional halb Warnung, Pflicht offen Fehler", () => {
    expect(stepLine({ title: "A", optional: false }, done()).status).toBe("pass");
    expect(stepLine({ title: "B", optional: true }, missing("nicht da")).status).toBe("skip");
    expect(stepLine({ title: "B", optional: true }, missing("nicht da")).detail).toBe("Übersprungen: nicht da");
    expect(stepLine({ title: "C", optional: true }, partial()).status).toBe("warn");
    expect(stepLine({ title: "D", optional: false }, missing()).status).toBe("fail");
    expect(stepLine({ title: "D", optional: false }, partial()).status).toBe("fail");
  });
});

describe("Rahmen", () => {
  test("Exit 0 mit Warnungen und übersprungenen optionalen Schritten", async () => {
    const ctx = await makeCtx({ env: WEB_ONLY });
    const steps = [fakeStep("datenbank", false, done()).step, fakeStep("telegram", true, missing()).step, fakeStep("google", true, partial()).step];
    const report = await collectReport({ ctx, steps, specials: [] });
    expect(report.lines.map(l => l.status)).toEqual(["pass", "skip", "warn", "pass"]);
    expect(reportExitCode(report)).toBe(0);
  });

  test("Exit 1, wenn ein Pflichtschritt fehlt", async () => {
    const ctx = await makeCtx({ env: WEB_ONLY });
    const report = await collectReport({ ctx, steps: [fakeStep("profil", false, missing("kein Profil")).step], specials: [] });
    expect(report.lines[0]).toEqual({ section: "Einrichtung", label: "Schritt profil", status: "fail", detail: "kein Profil" });
    expect(reportExitCode(report)).toBe(1);
  });

  test("kein Kanal ist ein Fehler", async () => {
    const ctx = await makeCtx({ env: "" });
    const report = await collectReport({ ctx, steps: [], specials: [] });
    expect(report.lines).toEqual([{ section: "Einrichtung", label: "Kanal", status: "fail", detail: "Richte Telegram oder die WebUI ein, sonst erreicht dich tybo nirgends." }]);
    expect(reportExitCode(report)).toBe(1);
  });

  test("jeder Schritt genau einmal, der Sammelschritt pruefung nie, test und apply nie", async () => {
    const ctx = await makeCtx({ env: WEB_ONLY });
    const a = fakeStep("datenbank", false, done());
    const b = fakeStep("telegram", true, missing());
    const aggregate = fakeStep("pruefung", false, done());
    await collectReport({ ctx, steps: [a.step, b.step, aggregate.step], specials: [] });
    expect(a.calls).toEqual({ status: 1, test: 0, apply: 0 });
    expect(b.calls).toEqual({ status: 1, test: 0, apply: 0 });
    expect(aggregate.calls).toEqual({ status: 0, test: 0, apply: 0 });
  });

  test("Ausnahme und Zeitüberschreitung verhindern den übrigen Bericht nicht", async () => {
    const ctx = await makeCtx({ env: WEB_ONLY });
    const throwing = fakeStep("google", true, async () => {
      throw new Error("kaputt");
    });
    const hanging: SpecialCheck = { id: "haengt", section: "Test", run: () => new Promise(() => {}) };
    const failing: SpecialCheck = { id: "wirft", section: "Test", run: async () => { throw new Error("Absturz"); } };
    const fine: SpecialCheck = { id: "gut", section: "Test", run: async () => [{ label: "Gut", status: "pass", detail: "ja" }] };
    const report = await collectReport({ ctx, steps: [throwing.step, fakeStep("datenbank", false, done()).step], specials: [hanging, failing, fine], timeoutMs: 30 });
    expect(report.lines.map(l => [l.label, l.status, l.detail])).toEqual([
      ["Schritt google", "fail", "Zustand nicht ermittelbar: kaputt"],
      ["Schritt datenbank", "pass", "erledigt"],
      ["Kanal", "pass", "WebUI eingerichtet, Telegram nicht."],
      ["haengt", "fail", "Prüfung gescheitert: keine Antwort nach 0 s"],
      ["wirft", "fail", "Prüfung gescheitert: Absturz"],
      ["Gut", "pass", "ja"],
    ]);
    expect(reportExitCode(report)).toBe(1);
  });

  test("Anbieter mit Wirkung sind gesperrt: keine Testnachricht, keine Schreibprobe, kein Modell", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const sneaky: SpecialCheck = {
      id: "wirkung",
      section: "Test",
      async run({ ctx }) {
        await ctx.providers.telegramSendTest(FAKE.token, FAKE.userId, "hallo");
        return [];
      },
    };
    const write: SpecialCheck = { id: "schreiben", section: "Test", run: async ({ ctx }) => (await ctx.providers.supabaseWriteProbe("u", "k"), []) };
    const model: SpecialCheck = { id: "modell", section: "Test", run: async ({ ctx }) => (await ctx.providers.claudeProbe("claude"), []) };
    const seen: boolean[] = [];
    const flag: SpecialCheck = { id: "flag", section: "Test", run: async ({ ctx }) => (seen.push(!!ctx.noModelCalls), []) };
    const report = await collectReport({ ctx, steps: [], specials: [sneaky, write, model, flag] });
    expect(report.lines.filter(l => l.section === "Test").map(l => l.detail)).toEqual([
      "Prüfung gescheitert: telegramSendTest ist im Prüfbericht gesperrt",
      "Prüfung gescheitert: supabaseWriteProbe ist im Prüfbericht gesperrt",
      "Prüfung gescheitert: claudeProbe ist im Prüfbericht gesperrt",
    ]);
    expect(seen).toEqual([true]);
    expect(ctx.providers.calls.map(c => c.method)).toEqual([]);
  });

  test("Geheimnisse aus der .env erscheinen nie im Bericht", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const leaky = fakeStep("google", true, partial(`Fehler bei https://api.telegram.org/bot${FAKE.token}/getMe mit ${FAKE.serviceKey}`));
    const leakySpecial: SpecialCheck = { id: "x", section: "Test", run: async () => [{ label: "x", status: "warn", detail: `Antwort: ${FAKE.webPassword} \x1b[2m(grau)\x1b[0m` }] };
    const report = await collectReport({ ctx, steps: [leaky.step], specials: [leakySpecial] });
    expect(leakedSecrets(report)).toEqual([]);
    expect(leakedSecrets(formatReport(report))).toEqual([]);
    expect(report.lines[0].detail).toBe("Fehler bei https://api.telegram.org/bot***/getMe mit ***");
    expect(report.lines.at(-1)?.detail).toBe("Antwort: *** (grau)");
  });

  test("Textform: Abschnitte, Bilanz und Schlusssatz", async () => {
    const lines = formatReport({
      lines: [
        { section: "Einrichtung", label: "Datenbank", status: "pass", detail: "ok" },
        { section: "Telegram", label: "Verbindung", status: "fail", detail: "Token abgelehnt" },
        { section: "Einrichtung", label: "Google", status: "skip", detail: "Übersprungen: nein" },
      ],
    });
    expect(lines).toEqual([
      "tybo: Prüfbericht",
      "",
      "Einrichtung",
      "  ✓ Datenbank: ok",
      "  - Google: Übersprungen: nein",
      "",
      "Telegram",
      "  ✗ Verbindung: Token abgelehnt",
      "",
      "Ergebnis: 1 bestanden, 1 fehlgeschlagen, 1 übersprungen",
      "Nicht alles in Ordnung: erst die Zeilen mit ✗ beheben.",
    ]);
  });
});

describe("Spezialprüfungen ohne Doppelprüfung", () => {
  test("nur WebUI: keine einzige Anfrage an Telegram", async () => {
    const ctx = await makeCtx({ env: `${WEB_ONLY}TELEGRAM_BOT_TOKEN_RESEARCH=${AGENT}\n` });
    const report = await collectReport({ ctx, steps: [], specials: [telegramCheck] });
    expect(ctx.providers.calls.filter(c => c.method.startsWith("telegram"))).toEqual([]);
    expect(report.lines.find(l => l.section === "Telegram")).toEqual({ section: "Telegram", label: "Verbindung", status: "skip", detail: "Übersprungen: Telegram ist nicht eingerichtet" });
    expect(reportExitCode(report)).toBe(0);
  });

  test("halbes Telegram: Kanal-Fehler, Exit 1, kein getMe", async () => {
    const ctx = await makeCtx({ env: `${WEB_ONLY}TELEGRAM_BOT_TOKEN=${FAKE.token}\n` });
    const report = await collectReport({ ctx, steps: [], specials: [telegramCheck] });
    expect(report.lines.find(l => l.label === "Kanal")?.status).toBe("fail");
    expect(ctx.providers.calls).toEqual([]);
    expect(reportExitCode(report)).toBe(1);
  });

  test("Telegram: getMe einmal je Token, auch wenn ein Agent denselben Token nutzt", async () => {
    const ctx = await makeCtx({ env: `${FULL_ENV}TELEGRAM_BOT_TOKEN_GENERAL=${FAKE.token}\nTELEGRAM_BOT_TOKEN_PROJEKT_PLANER=${AGENT}\nTELEGRAM_BOT_TOKEN_CRITIC=your_token_here\n` });
    const report = await collectReport({ ctx, steps: [], specials: [telegramCheck] });
    const getMe = ctx.providers.calls.filter(c => c.method === "telegramGetMe").map(c => c.args[0]);
    expect(getMe).toEqual([FAKE.token, AGENT]);
    expect(report.lines.filter(l => l.section === "Telegram").map(l => l.label)).toEqual(["Verbindung", "Agenten-Bot general", "Agenten-Bot projekt-planer"]);
    expect(ctx.providers.calls.some(c => c.method === "telegramSendTest")).toBe(false);
  });

  test("Telegram lehnt den Token ab: Fehler, Exit 1", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    ctx.providers.results.telegramGetMe = { ok: false, message: "Telegram lehnt das Token ab." };
    const report = await collectReport({ ctx, steps: [], specials: [telegramCheck] });
    expect(report.lines.find(l => l.section === "Telegram")?.status).toBe("fail");
    expect(reportExitCode(report)).toBe(1);
  });

  test("lokale Supabase: messages wird einmal gelesen, Schritt und Spezialprüfung teilen das Ergebnis", async () => {
    const env = `WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\nSUPABASE_URL=${LOCAL_SUPABASE_URL}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\n`;
    const urls: string[] = [];
    const ctx = await makeCtx({
      env,
      overrides: { fetch: async url => (urls.push(url), new Response("[]", { status: 200 })) },
    });
    const { databaseStep } = await import("../src/setup/steps/database");
    const report = await collectReport({ ctx, steps: [databaseStep], specials: [databaseCheck] });
    expect(ctx.providers.calls.filter(c => c.method === "supabaseQuery")).toHaveLength(1);
    expect(ctx.providers.calls.some(c => c.method === "supabaseWriteProbe")).toBe(false);
    expect(urls).toEqual([`${LOCAL_SUPABASE_URL}/rest/v1/memory?select=id&limit=1`]);
    expect(report.lines.filter(l => l.section === "Datenbank").map(l => [l.label, l.status])).toEqual([
      ["Verbindung", "pass"],
      ["Tabelle memory", "pass"],
    ]);
  });

  test("Datenbank nicht erreichbar: Fehler, memory wird dann nicht gelesen", async () => {
    const urls: string[] = [];
    const ctx = await makeCtx({ env: WEB_ONLY, overrides: { fetch: async url => (urls.push(url), new Response("", { status: 200 })) } });
    ctx.providers.results.supabaseQuery = { ok: false, message: "Supabase ist nicht erreichbar." };
    const report = await collectReport({ ctx, steps: [], specials: [databaseCheck] });
    expect(report.lines.find(l => l.section === "Datenbank")).toEqual({ section: "Datenbank", label: "Verbindung", status: "fail", detail: "Supabase ist nicht erreichbar." });
    expect(urls).toEqual([]);
    expect(reportExitCode(report)).toBe(1);
  });

  test("fehlende Tabelle memory ist eine Warnung, kein Fehler", async () => {
    const ctx = await makeCtx({ env: WEB_ONLY, overrides: { fetch: async () => new Response("", { status: 404 }) } });
    const report = await collectReport({ ctx, steps: [], specials: [databaseCheck] });
    expect(report.lines.find(l => l.label === "Tabelle memory")?.status).toBe("warn");
    expect(reportExitCode(report)).toBe(0);
  });

  test("Zusatzfunktionen: nur ob der Schlüssel gesetzt ist", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const report = await collectReport({ ctx, steps: [], specials: [extrasCheck] });
    expect(report.lines.filter(l => l.section === "Zusatzfunktionen").map(l => [l.label, l.status])).toEqual([
      ["ElevenLabs (Stimme)", "skip"],
      ["Gemini (Transkription)", "skip"],
      ["OpenRouter (Ersatzmodell)", "pass"],
    ]);
  });

  test("Telefonhörer ohne bereiten Weg: übersprungen, kein Modell", async () => {
    const ctx = await makeCtx({ env: WEB_ONLY });
    const report = await collectReport({ ctx, steps: [], specials: [callCheck(NO_CALL_WAYS)] });
    expect(report.lines.find(l => l.label === "Telefonhörer")?.status).toBe("skip");
  });
});

describe("Dienste: nur ein installiertes PM2, nie npx", () => {
  const PM2_LIST = { stdout: JSON.stringify([{ name: "tybo-telegram-relay", pid: 11, pm2_env: { status: "online" } }]) };
  const SYSTEMD = {
    "systemctl --user show": { stdout: "ActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=7" },
    "loginctl show-user": { stdout: "yes" },
  };

  async function services(env: string, answers: Record<string, Partial<CommandResult>>, options: { systemd?: boolean } = {}) {
    const ctx = await makeCtx({ env, overrides: { platform: "linux", run: fakeRun(answers) } });
    if (options.systemd) {
      await mkdir(ctx.systemdUserDir, { recursive: true });
      await writeFile(join(ctx.systemdUserDir, SYSTEMD_UNIT_FILE), "");
    }
    const report = await collectReport({ ctx, steps: [], specials: [servicesCheck] });
    const count = (prefix: string) => ctx.run.calls.filter(c => c.join(" ").startsWith(prefix)).length;
    return { lines: report.lines.filter(l => l.section === "Dienste"), calls: ctx.run.calls, count };
  }

  test("Linux ohne systemd mit PM2: genau ein pm2 jlist", async () => {
    const r = await services(WEB_ONLY, { "pm2 jlist": PM2_LIST });
    expect(r.calls).toEqual([["pm2", "jlist"]]);
    expect(r.lines.find(l => l.label === "telegram-relay")?.status).toBe("pass");
  });

  test("Linux ohne systemd und ohne PM2: gemeldet, nichts nachinstalliert", async () => {
    const r = await services(WEB_ONLY, {});
    expect(r.calls).toEqual([["pm2", "jlist"]]);
    expect(r.lines.find(l => l.label === "PM2")).toMatchObject({ status: "skip", detail: "PM2 nicht installiert (npm install -g pm2)" });
  });

  test("Linux mit systemd: Bot über systemd, die übrigen Dienste über das installierte PM2", async () => {
    const r = await services(WEB_ONLY, { ...SYSTEMD, "pm2 --version": { stdout: "6.0.0" }, "pm2 jlist": PM2_LIST }, { systemd: true });
    expect([r.count("systemctl"), r.count("loginctl"), r.count("pm2 --version"), r.count("pm2 jlist"), r.count("npx")]).toEqual([1, 1, 1, 1, 0]);
    expect(r.calls.length).toBe(4);
  });

  test("Linux mit systemd ohne PM2: kein jlist, kein npx", async () => {
    const r = await services(WEB_ONLY, SYSTEMD, { systemd: true });
    expect([r.count("pm2 --version"), r.count("pm2 jlist"), r.count("npx")]).toEqual([1, 0, 0]);
    expect(r.lines.find(l => l.label === "smart-checkin")).toMatchObject({ status: "skip", detail: "Nicht eingerichtet (PM2 nicht installiert)" });
  });

  const LOCAL_DB = `WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\nSUPABASE_URL=${LOCAL_SUPABASE_URL}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\n`;

  test("lokale Supabase unter Linux: Autostart über das installierte PM2", async () => {
    const r = await services(LOCAL_DB, { "pm2 jlist": PM2_LIST, "docker ps": { stdout: "supabase_db_tybo" } });
    expect([r.count("pm2 jlist"), r.count("docker ps"), r.count("npx")]).toEqual([2, 1, 0]);
    expect(r.calls.length).toBe(3);
    expect(r.lines.find(l => l.label === "supabase (Datenbank)")?.status).toBe("pass");
  });

  test("lokale Supabase unter Linux ohne PM2: gemeldet, nichts nachinstalliert", async () => {
    const r = await services(LOCAL_DB, { "docker ps": { stdout: "supabase_db_tybo" } });
    expect([r.count("pm2 jlist"), r.count("docker ps"), r.count("npx")]).toEqual([2, 1, 0]);
    expect(r.lines.find(l => l.label === "supabase (Autostart)")).toMatchObject({ status: "skip" });
    expect(r.lines.find(l => l.label === "supabase (Autostart)")?.detail).toContain("PM2 nicht gefunden");
  });
});

describe("Telefonhörer mit der Umgebung des Projekts", () => {
  const NO_OLLAMA: Partial<CallModelDeps> = { ollamaCheck: async () => "Ollama läuft nicht" };

  test("Claude Code aus CLAUDE_PATH der .env, nicht aus der Shell; im Projektordner, ohne Schlüssel der Shell", async () => {
    const saved = { path: process.env.CLAUDE_PATH, key: process.env.ANTHROPIC_API_KEY };
    process.env.CLAUDE_PATH = "/shell/bin/claude";
    process.env.ANTHROPIC_API_KEY = "sk-ant-shell-test-geheim-1111";
    try {
      const ctx = await makeCtx({ env: `${WEB_ONLY}CLAUDE_PATH=/projekt/bin/claude\n` });
      const inner = fakeRun({
        "/projekt/bin/claude auth status": { stdout: '{"loggedIn":true}' },
        "/projekt/bin/claude --help": { stdout: CLI_REQUIRED_FLAGS.join("\n") },
      });
      const seen: Array<{ cmd: string[]; options?: RunOptions }> = [];
      ctx.run = Object.assign(async (cmd: string[], options?: RunOptions) => (seen.push({ cmd, options }), inner(cmd, options)), { calls: inner.calls });
      const report = await collectReport({ ctx, steps: [], specials: [callCheck(NO_OLLAMA)] });
      expect(report.lines.find(l => l.label === "Telefonhörer")).toMatchObject({
        status: "pass",
        detail: "bereit über cli mit claude-sonnet-5-5, zählt gegen das Guthaben des Abos",
      });
      expect(ctx.providers.calls.filter(c => c.method === "claudeVersion").map(c => c.args[0])).toEqual(["/projekt/bin/claude"]);
      expect(seen.map(s => s.cmd)).toEqual([
        ["/projekt/bin/claude", "auth", "status", "--json"],
        ["/projekt/bin/claude", "--help"],
      ]);
      expect(seen.every(s => s.options?.cwd === ctx.root && s.options?.env?.ANTHROPIC_API_KEY === undefined)).toBe(true);
    } finally {
      for (const [name, value] of [["CLAUDE_PATH", saved.path], ["ANTHROPIC_API_KEY", saved.key]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("echte Anbieter, anderes Arbeitsverzeichnis, relativer CLAUDE_PATH: --version, auth status und --help im Projektkontext, --version einmal", async () => {
    const saved = { cwd: process.cwd(), path: process.env.CLAUDE_PATH, key: process.env.ANTHROPIC_API_KEY };
    const shellKey = "sk-ant-shell-test-geheim-2222";
    const elsewhere = await mkdtemp(join(tmpdir(), "tybo-pruefen-cwd-"));
    process.env.CLAUDE_PATH = "/shell/bin/claude";
    process.env.ANTHROPIC_API_KEY = shellKey;
    process.chdir(elsewhere);
    try {
      const ctx = await makeCtx({ env: `${WEB_ONLY}CLAUDE_PATH=./bin/claude\n` });
      const answers: Record<string, string> = {
        "--version": "2.1.300 (Claude Code)",
        "auth status --json": '{"loggedIn":true}',
        "--help": CLI_REQUIRED_FLAGS.join("\n"),
      };
      const seen: Array<{ cmd: string[]; options?: RunOptions }> = [];
      // Wie spawn: ./bin/claude gibt es nur vom Projektordner aus
      const run = async (cmd: string[], options?: RunOptions): Promise<CommandResult> => {
        if (cmd[0] === "git") return { code: 0, stdout: "git version 2.50.0", stderr: "" };
        seen.push({ cmd, options });
        const answer = answers[cmd.slice(1).join(" ")];
        if (cmd[0] !== "./bin/claude" || options?.cwd !== ctx.root || answer === undefined) return { code: -1, stdout: "", stderr: "", spawnError: "ENOENT" };
        return { code: 0, stdout: answer, stderr: "" };
      };
      const fetch = async (): Promise<Response> => {
        throw new Error("Kein Netz in Tests");
      };
      Object.assign(ctx, { run, fetch, providers: createProviders({ run, fetch }) });
      const report = await collectReport({ ctx, steps: [prerequisitesStep], specials: [callCheck({ ollamaCheck: async () => "Ollama läuft nicht" })] });
      expect(report.lines.find(l => l.label === "Voraussetzungen")).toMatchObject({ status: "pass", detail: "Bun, Claude CLI und Git sind da." });
      expect(report.lines.find(l => l.label === "Telefonhörer")).toMatchObject({ status: "pass" });
      expect(seen.map(s => s.cmd)).toEqual([
        ["./bin/claude", "--version"],
        ["./bin/claude", "auth", "status", "--json"],
        ["./bin/claude", "--help"],
      ]);
      for (const { options } of seen) {
        expect(options?.cwd).toBe(ctx.root);
        expect(options?.env?.TYBO_SUBPROCESS).toBe("1");
        expect(options?.env?.ANTHROPIC_API_KEY).toBeUndefined();
        expect(Object.values(options?.env ?? {})).not.toContain(shellKey);
      }
    } finally {
      process.chdir(saved.cwd);
      await rm(elsewhere, { recursive: true, force: true });
      for (const [name, value] of [["CLAUDE_PATH", saved.path], ["ANTHROPIC_API_KEY", saved.key]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("Schlüssel in einem ungültigen SPEECH_CALL_MODEL erscheint weder im Bericht noch auf stdout oder stderr", async () => {
    const key = "sk-ant-voice-test-geheim-8888";
    const ctx = await makeCtx({ env: `${WEB_ONLY}VOICE_ANTHROPIC_API_KEY=${key}\nSPEECH_CALL_MODEL=${key}\n` });
    const printed: string[] = [];
    const grab = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
    const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug, out: process.stdout.write, err: process.stderr.write };
    console.log = console.warn = console.error = console.info = console.debug = grab;
    process.stdout.write = ((chunk: unknown) => (printed.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => (printed.push(String(chunk)), true)) as typeof process.stderr.write;
    let code: number;
    try {
      code = await runTybo({
        args: ["pruefen"],
        env: {},
        root: ctx.root,
        out: grab,
        err: grab,
        setup: { ctx },
        checks: { specials: defaultSpecials({ callModel: NO_OLLAMA }) },
      });
    } finally {
      Object.assign(console, { log: saved.log, warn: saved.warn, error: saved.error, info: saved.info, debug: saved.debug });
      process.stdout.write = saved.out;
      process.stderr.write = saved.err;
    }
    const text = printed.join("\n");
    // Die Warnung kam an, also hat das Mitschneiden gegriffen
    expect(text).toContain("SPEECH_CALL_MODEL ungültig");
    expect(text).toContain("Telefonhörer: bereit über api");
    expect(text).not.toContain(key);
    expect([0, 1]).toContain(code!);
  });
});

describe("tybo pruefen", () => {
  async function pruefen(env: string, args: string[] = ["pruefen"], extra: Record<string, string> = {}) {
    const ctx = await makeCtx({ env });
    // launchctl list liefert ein leeres Ergebnis; jeder andere launchctl-Aufruf wäre ein Fehler im Test
    const fakeRun = ctx.run;
    const commands: string[][] = [];
    ctx.run = Object.assign(async (cmd: string[], o?: any) => {
      commands.push(cmd);
      if (cmd[0] === "launchctl" && cmd[1] === "list") return { code: 0, stdout: "", stderr: "" };
      return fakeRun(cmd, o);
    }, { calls: fakeRun.calls });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runTybo({
      args,
      env: extra,
      root: ctx.root,
      out: l => out.push(l),
      err: l => err.push(l),
      setup: { ctx },
      checks: { specials: defaultSpecials({ callModel: NO_CALL_WAYS }) },
    });
    return { code, out, err, ctx, commands };
  }

  test("ganzer Bericht mit den echten Schritten: Exit-Code wie der Bericht, keine Wirkung nach außen", async () => {
    const r = await pruefen(FULL_ENV);
    const text = r.out.join("\n");
    expect(r.out[0]).toBe("tybo: Prüfbericht");
    for (const section of ["Einrichtung", "Telegram", "Datenbank", "Dienste", "Zusatzfunktionen", "Sprache"]) expect(r.out).toContain(section);
    expect(r.out.some(l => l.includes(" Kanal: "))).toBe(true);
    expect(text).not.toContain("Gesamtprüfung");
    expect(r.code).toBe(text.includes("✗") ? 1 : 0);
    const methods = r.ctx.providers.calls.map(c => c.method);
    expect(methods.filter(m => m === "telegramGetMe")).toHaveLength(1);
    expect(methods.filter(m => m === "supabaseQuery")).toHaveLength(1);
    expect(methods).not.toContain("telegramSendTest");
    expect(methods).not.toContain("supabaseWriteProbe");
    expect(methods).not.toContain("claudeProbe");
    expect(r.commands.filter(c => c[0] === "launchctl").every(c => c[1] === "list")).toBe(true);
    expect(leakedSecrets(r.out)).toEqual([]);
  });

  test("Pflichtschritt fehlt: Exit 1", async () => {
    const r = await pruefen(`WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\n`);
    expect(r.code).toBe(1);
    expect(r.out.some(l => l.startsWith("  ✗ Datenbank"))).toBe(true);
  });

  test("Umgebung des Aufrufers zählt nicht, nur die .env des Projekts", async () => {
    const r = await pruefen(`WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\n`, ["pruefen"], { TELEGRAM_BOT_TOKEN: FAKE.token, TELEGRAM_USER_ID: FAKE.userId });
    expect(r.ctx.providers.calls.filter(c => c.method === "telegramGetMe")).toEqual([]);
  });

  test("help und unbekannte Argumente", async () => {
    const help = await pruefen(FULL_ENV, ["pruefen", "help"]);
    expect(help.code).toBe(0);
    expect(help.out.join("\n")).toContain("bun run setup:verify");
    expect(help.ctx.providers.calls).toEqual([]);
    const wrong = await pruefen(FULL_ENV, ["pruefen", "--quatsch"]);
    expect(wrong.code).toBe(2);
    expect(wrong.err[0]).toBe("Unbekannter Aufruf: tybo pruefen --quatsch");
  });

  test("Kurzhilfe nennt den Befehl", async () => {
    const out: string[] = [];
    await runTybo({ args: ["help"], env: {}, root: (await makeCtx({ env: "" })).root, out: l => out.push(l) });
    expect(out.join("\n")).toContain("tybo pruefen");
  });

  test("setup:verify ist ein Alias für denselben Einstieg", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(pkg.scripts["setup:verify"]).toBe("bun --no-env-file scripts/tybo.ts pruefen");
  });
});
