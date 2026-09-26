/**
 * Issue #67: frischer Rechner bis zur ersten Antwort, als Test.
 *
 * Einzeln: bun test tests/setup-fresh.test.ts
 *
 * Ablauf je Durchlauf:
 * 1. Frische Kopie: die Dateien aus `git ls-files` in einem Temp-Ordner, ohne
 *    .env, config/profile.md, config/settings.json, data/ und ohne lokale
 *    Konfigurationen (aus config/ nur *.example.*). node_modules ist ein
 *    Symlink auf das vorhandene Verzeichnis, kein bun install. `git ls-files
 *    -z` ist der einzige echte Befehl, und nur zur Vorbereitung (liest nur).
 * 2. Einrichtung über runTybo(["setup"]) mit simulierten Eingaben. Alle
 *    Befehle (git, pm2, launchctl, which) und alle Anbieter (Telegram,
 *    Datenbank, Claude CLI, OpenRouter, Ollama) sind Attrappen; home,
 *    LaunchAgents und dump.pm2 liegen im Temp-Ordner.
 * 3. Startübergang: die geschriebene .env ergibt chooseStartMode = normal.
 *    Das belegt nur die Moduswahl, nicht Polling oder Handler in src/bot.ts
 *    (der ist in Tests tabu: er würde mit dem echten Telegram-Token pollen).
 * 4. Erste Antwort: eine Nutzernachricht im Direktchat läuft durch den
 *    Chat-Kern (runStreamingTurn) mit Claude-Attrappe; die Antwort geht an
 *    eine Telegram-Attrappe, adressiert mit Token und Nutzer-ID aus der .env.
 *
 * Isolation: process.env bleibt gleich, globales fetch ist eine Attrappe, die
 * jeden Aufruf zählt und scheitert, und Stichproben außerhalb des
 * Temp-Ordners bleiben unverändert. Vergleiche laufen über Prüfsummen und
 * Variablennamen, damit ein Fehlschlag keine echten Werte ausgibt.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runTybo } from "../scripts/tybo";
import { runStreamingTurn, type ChatTurnDeps } from "../src/lib/chat-turn";
import type { ClaudeResult, ClaudeStreamOptions } from "../src/lib/claude";
import { readEnvFile } from "../src/lib/env-file";
import { settingsSchema, type Settings } from "../src/lib/settings";
import { createSetupContext, type CommandResult, type CommandRunner, type SetupContext } from "../src/setup/context";
import { chooseStartMode } from "../src/setup/start-mode";
import { checkStep, setupOverview } from "../src/setup/steps";
import { cleanup, FAKE, fakeProviders, leakedSecrets, root as testRoot, type FakeProviders } from "./setup-fixture";
import { scripted } from "./setup-terminal-fixture";

const REPO = resolve(import.meta.dir, "..");

afterAll(cleanup);

// ---------------------------------------------------------------------------
// Frische Kopie
// ---------------------------------------------------------------------------

/** Getrackte Dateien, die ein frischer Rechner nicht hätte */
function isLocalOnly(path: string): boolean {
  if (path === ".env" || path.startsWith("data/")) return true;
  if (path.startsWith("config/")) return !/\.example\./.test(path.slice("config/".length));
  return false;
}

/** Dateiliste aus git: der einzige echte Befehl, nur lesend und nur zur Vorbereitung */
function trackedFiles(): string[] {
  const proc = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error("git ls-files ist fehlgeschlagen");
  return new TextDecoder().decode(proc.stdout).split("\0").filter(Boolean);
}

let copies = 0;

async function freshCopy(): Promise<{ dir: string; project: string; home: string }> {
  const dir = join(testRoot, `frisch-${++copies}`);
  const project = join(dir, "projekt");
  const home = join(dir, "home");
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  for (const file of trackedFiles()) {
    if (isLocalOnly(file)) continue;
    const from = join(REPO, file);
    if (!existsSync(from)) continue;
    const to = join(project, file);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { verbatimSymlinks: true });
  }
  await symlink(join(REPO, "node_modules"), join(project, "node_modules"));
  return { dir, project, home };
}

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Prüfsumme einer Datei oder eines Ordners (nur Namen und Inhalte der Dateien) */
async function fingerprint(path: string): Promise<string> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return "fehlt";
  }
  if (!info.isDirectory()) return hash(await readFile(path, "utf8").catch(() => `unlesbar:${info.mtimeMs}`));
  const names = (await readdir(path)).sort();
  const parts: string[] = [];
  for (const name of names) parts.push(`${name}=${await fingerprint(join(path, name))}`);
  return hash(parts.join("\n"));
}

/** Stichproben außerhalb des Temp-Ordners */
const OUTSIDE = [
  join(REPO, ".env"),
  join(REPO, "config"),
  join(REPO, "data", "backups"),
  join(homedir(), "Library", "LaunchAgents"),
  join(process.env.PM2_HOME || join(homedir(), ".pm2"), "dump.pm2"),
];

async function outsideState(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of OUTSIDE) out[p] = await fingerprint(p);
  return out;
}

/** Namen der Variablen, die sich geändert haben; nie die Werte */
function envChanges(before: Record<string, string | undefined>): string[] {
  const now = process.env;
  const names = new Set([...Object.keys(before), ...Object.keys(now)]);
  return [...names].filter(n => before[n] !== now[n]).sort();
}

interface Guarded<T> {
  result: T;
  fetchCalls: number;
  envChanged: string[];
  outsideChanged: string[];
}

/** Führt fn aus mit fetch-Attrappe; misst process.env und die Stichproben davor und danach */
async function isolated<T>(fn: () => Promise<T>): Promise<Guarded<T>> {
  const env = { ...process.env };
  const outside = await outsideState();
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("Netz ist in diesem Test verboten");
  }) as unknown as typeof fetch;
  let result: T;
  try {
    result = await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  const after = await outsideState();
  return {
    result,
    fetchCalls,
    envChanged: envChanges(env),
    outsideChanged: OUTSIDE.filter(p => outside[p] !== after[p]),
  };
}

// ---------------------------------------------------------------------------
// Befehls-Attrappen mit Zustand
// ---------------------------------------------------------------------------

type Recorder = CommandRunner & { calls: string[][] };

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const missing: CommandResult = { code: -1, stdout: "", stderr: "Befehl nicht gefunden" };

/** Linux: PM2 merkt sich den Start, pm2 save schreibt dump.pm2 in den Temp-Ordner */
function linuxRun(pm2DumpPath: string): Recorder {
  const calls: string[][] = [];
  let started = false;
  const run = (async (cmd: string[]) => {
    calls.push(cmd);
    const line = cmd.join(" ");
    if (line === "git --version") return ok("git version 2.50.0");
    if (line === "pm2 --version") return ok("6.0.0");
    if (line === "pm2 jlist") return ok(JSON.stringify(started ? [{ name: "tybo-telegram-relay" }] : []));
    if (line === "pm2 delete tybo-telegram-relay") return { code: 1, stdout: "", stderr: "not found" };
    if (line.startsWith("pm2 start bun")) {
      started = true;
      return ok();
    }
    if (line === "pm2 save") {
      await mkdir(dirname(pm2DumpPath), { recursive: true });
      await Bun.write(pm2DumpPath, JSON.stringify([{ name: "tybo-telegram-relay" }]));
      return ok();
    }
    return missing;
  }) as Recorder;
  run.calls = calls;
  return run;
}

/** macOS: launchctl load merkt sich den Dienst, launchctl list zeigt ihn danach */
function macRun(): Recorder {
  const calls: string[][] = [];
  let loaded = false;
  const run = (async (cmd: string[]) => {
    calls.push(cmd);
    const line = cmd.join(" ");
    if (line === "git --version") return ok("git version 2.50.0");
    if (line === "which bun") return ok("/opt/test/bun/bin/bun");
    if (line === "which claude") return ok("/opt/test/claude/bin/claude");
    if (line.startsWith("launchctl load ")) {
      loaded = true;
      return ok();
    }
    if (line === "launchctl list") return ok(`PID\tStatus\tLabel\n1\t0\tcom.apple.test${loaded ? "\n4711\t0\tai.tybo.telegram-relay" : ""}`);
    return missing;
  }) as Recorder;
  run.calls = calls;
  return run;
}

// ---------------------------------------------------------------------------
// Durchlauf
// ---------------------------------------------------------------------------

interface Fresh {
  project: string;
  ctx: SetupContext & { run: Recorder; providers: FakeProviders };
  code: number;
  out: string;
  asked: string[];
  left: number;
}

async function runFresh(platform: NodeJS.Platform, answers: string[]): Promise<Fresh> {
  const { dir, project, home } = await freshCopy();
  const pm2DumpPath = join(home, ".pm2", "dump.pm2");
  const run = platform === "darwin" ? macRun() : linuxRun(pm2DumpPath);
  const providers = fakeProviders();
  const ctx = createSetupContext({
    root: project,
    home,
    platform,
    bunVersion: "1.3.12",
    launchAgentsDir: join(home, "Library", "LaunchAgents"),
    pm2DumpPath,
    run,
    providers,
    now: () => new Date("2026-09-25T10:00:00Z"),
  }) as Fresh["ctx"];
  // Alle Pfade des Kontexts liegen in der Kopie bzw. im Temp-Ordner
  for (const p of [ctx.envPath, ctx.backupDir, ctx.profilePath, ctx.settingsPath, ctx.launchAgentsDir, ctx.pm2DumpPath]) {
    expect(p.startsWith(`${dir}/`)).toBe(true);
  }

  const prompter = scripted(answers);
  const lines: string[] = [];
  const code = await runTybo({
    args: ["setup"],
    root: project,
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    out: l => lines.push(l),
    err: l => lines.push(l),
    setup: { ctx, prompter, onInterrupt: () => () => {} },
  });
  return { project, ctx, code, out: lines.join("\n"), asked: prompter.asked.map(a => a.question), left: prompter.left() };
}

/** Einstellungen aus der Kopie; fester Effort, damit CLAUDE_EFFORT der Shell nichts ändert */
async function copySettings(ctx: SetupContext): Promise<Settings> {
  const raw = await readFile(ctx.settingsPath, "utf8").catch(() => null);
  const saved = raw === null ? {} : settingsSchema.parse(JSON.parse(raw));
  return { ...saved, defaults: { effort: "high", ...saved.defaults } };
}

const REPLY = "Hallo Testperson, ich bin bereit. Womit fange ich an?";
const USER_MESSAGE = "Hallo, bist du da?";

/**
 * Erste Nachricht nach dem Start: Direktchat, Agent general, Chat-Kern mit
 * Attrappen. Nur die Antwort des Kerns geht an die Telegram-Attrappe.
 */
async function firstReply(ctx: SetupContext) {
  const env = await readEnvFile(ctx.envPath);
  const settings = await copySettings(ctx);
  const claudeCalls: ClaudeStreamOptions[] = [];
  const promptCalls: unknown[] = [];
  const fallbackCalls: unknown[] = [];
  const sent: Array<{ token: string; chatId: string; text: string }> = [];
  const telegram = {
    async sendMessage(token: string, chatId: string, text: string) {
      sent.push({ token, chatId, text });
    },
  };
  const fakeClaude = async (o: ClaudeStreamOptions): Promise<ClaudeResult> => {
    claudeCalls.push(o);
    return { text: REPLY, isError: false, sessionId: "sitzung-1" };
  };
  const deps: Partial<ChatTurnDeps> = {
    callClaude: fakeClaude,
    callClaudeStreaming: fakeClaude,
    callFallbackLLMWithSource: async (...args) => {
      fallbackCalls.push(args);
      return { text: "fallback", source: "none" };
    },
    buildPromptContext: async args => {
      promptCalls.push(args);
      return { fullPrompt: "voller-prompt", fallbackContext: "fallback-kontext" };
    },
    buildResumePrompt: async () => "resume-prompt",
    isSessionModeEnabled: () => false,
    getResumableSession: async () => undefined,
    takeExpiredSession: async () => undefined,
    recordSessionTurn: async () => {},
    getSessionsForKey: async () => [],
    resetSession: async () => 0,
    shouldDistill: () => false,
    distillSession: async () => {},
    log: async () => {},
    getAgentConfig: () => ({ model: "agent-modell", effort: "low", allowedTools: ["WebSearch"] }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    getSettings: () => settings,
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 0,
  };

  const chatId = env.TELEGRAM_USER_ID;
  const reply = await runStreamingTurn({
    userMessage: USER_MESSAGE,
    chatId,
    agentName: "general",
    sink: { progress: () => {}, notice: () => {} },
    deps,
  });
  await telegram.sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);
  return { env, reply, sent, claudeCalls, promptCalls, fallbackCalls };
}

/** Programme, die der Einrichtungslauf aufrufen darf (alle nur als Attrappe) */
const ALLOWED_PROGRAMS = new Set(["git", "pm2", "launchctl", "which"]);

function methods(p: FakeProviders): string[] {
  return p.calls.map(c => c.method);
}

// ---------------------------------------------------------------------------
// Durchlauf A: Linux/PM2, Convex, optionale Schritte übersprungen
// ---------------------------------------------------------------------------

const RUN_A = [
  "", // Auswahl nach der Übersicht: nur offene Schritte
  FAKE.token,
  FAKE.userId,
  "", // Speichern? Standard Ja
  "n", // Forum-Gruppe: Jetzt einrichten? Nein
  "4", // Datenbank: Convex (seit Issue #164 an vierter Stelle)
  FAKE.convexUrl,
  FAKE.convexToken,
  "",
  "Testperson",
  "Europe/Berlin",
  "", // Beruf leer
  "",
  "n", // Modelle: Nein
  "n", // WebUI: Nein
  "j", // Autostart jetzt einrichten?
];

// ---------------------------------------------------------------------------
// Durchlauf B: macOS/launchd, Supabase, Gruppe, Modelle und WebUI
// ---------------------------------------------------------------------------

const RUN_B = [
  "",
  FAKE.token,
  FAKE.userId,
  "",
  "j", // Forum-Gruppe: Jetzt einrichten?
  FAKE.groupId,
  "",
  "3", // Datenbank: Supabase, Zugangsdaten selbst eintragen (seit Issue #164 an dritter Stelle)
  FAKE.supabaseUrl,
  FAKE.serviceKey,
  FAKE.anonKey,
  "",
  "Testperson",
  "Europe/Berlin",
  "Gärtnerei",
  "",
  "j", // Modelle: Jetzt einrichten?
  "test-standardmodell",
  "2", // Effort: medium
  FAKE.openrouterKey,
  "anbieter/test-modell",
  "qwen3:8b",
  "n", // Nur lokal zurückfallen: Nein
  "",
  "j", // WebUI: Jetzt einrichten?
  "j", // WebUI einschalten
  FAKE.webPassword,
  "1", // Nur dieser Rechner
  "", // Port: Standard
  "",
  "j", // Autostart jetzt einrichten?
];

describe("frischer Rechner: tybo setup bis zur ersten Antwort", () => {
  test("die Kopie ist frisch: keine .env, kein Profil, keine Einstellungen, keine lokalen Konfigurationen", async () => {
    const { project } = await freshCopy();
    expect(existsSync(join(project, ".env"))).toBe(false);
    expect(existsSync(join(project, ".env.example"))).toBe(true);
    expect(existsSync(join(project, "config", "profile.md"))).toBe(false);
    expect(existsSync(join(project, "config", "settings.json"))).toBe(false);
    expect(existsSync(join(project, "data"))).toBe(false);
    const config = await readdir(join(project, "config"));
    expect(config.length).toBeGreaterThan(0);
    expect(config.filter(f => !/\.example\./.test(f))).toEqual([]);
    expect(existsSync(join(project, "launchd", "ai.tybo.telegram-relay.plist.template"))).toBe(true);
    expect(isLocalOnly("config/topics.json")).toBe(true);
    expect(isLocalOnly("config/topics.example.json")).toBe(false);
  });

  test("A: Linux mit PM2, Convex, optionale Schritte übersprungen", async () => {
    const guarded = await isolated(async () => {
      const fresh = await runFresh("linux", RUN_A);
      const overview = await setupOverview(fresh.ctx);
      const check = await checkStep.test!({}, fresh.ctx);
      const first = await firstReply(fresh.ctx);
      return { fresh, overview, check, first };
    });
    expect(guarded.fetchCalls).toBe(0);
    expect(guarded.envChanged).toEqual([]);
    expect(guarded.outsideChanged).toEqual([]);
    const { fresh, overview, check, first } = guarded.result;
    const { ctx } = fresh;

    // Einrichtung: alle Antworten verbraucht, Pflichtschritte erledigt, Verbindungstest der Gesamtprüfung bestanden
    expect(fresh.code).toBe(0);
    expect(fresh.left).toBe(0);
    expect(overview.complete).toBe(true);
    expect(overview.missing).toEqual([]);
    expect(check.ok).toBe(true);
    expect(fresh.out).toContain("Alles eingerichtet und erreichbar.");
    expect(fresh.out).toContain("Alle Pflichtschritte sind erledigt.");
    expect(fresh.out).toContain("Übersprungen: Forum-Gruppe, Modelle und Fallback, WebUI");

    // .env der Kopie: genau die eingegebenen Werte, Rechte 0600
    expect(await readEnvFile(ctx.envPath)).toEqual({
      TELEGRAM_BOT_TOKEN: FAKE.token,
      TELEGRAM_USER_ID: FAKE.userId,
      CONVEX_URL: FAKE.convexUrl,
      CONVEX_AUTH_TOKEN: FAKE.convexToken,
      USER_NAME: "Testperson",
      USER_TIMEZONE: "Europe/Berlin",
    });
    expect((await stat(ctx.envPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(ctx.profilePath, "utf8")).toBe(
      "# Testperson\n\n## Über mich\n- Zeitzone: Europe/Berlin\n\n## Kommunikation\n- Kurz und direkt antworten\n",
    );
    expect(existsSync(ctx.settingsPath)).toBe(false);

    // Anbieter: getMe, Testnachricht an die Nutzer-ID, Convex-Abfrage, Claude-Version und -Probe
    const m = methods(ctx.providers);
    for (const name of ["telegramGetMe", "telegramSendTest", "convexQuery", "claudeVersion", "claudeProbe"]) expect(m).toContain(name);
    for (const name of ["supabaseQuery", "telegramCheckGroup", "openrouterKey", "ollamaTags"]) expect(m).not.toContain(name);
    const sendTest = ctx.providers.calls.find(c => c.method === "telegramSendTest")!;
    expect(sendTest.args[1]).toBe(FAKE.userId);

    // Befehle: nur Attrappen, Autostart über PM2 mit dem Projekt der Kopie, dump.pm2 im Temp-Ordner
    expect(ctx.run.calls.every(c => ALLOWED_PROGRAMS.has(c[0]))).toBe(true);
    expect(ctx.run.calls.some(c => c[0] === "launchctl")).toBe(false);
    const start = ctx.run.calls.find(c => c.join(" ").startsWith("pm2 start bun"))!;
    expect(start).toBeDefined();
    expect(start.join(" ")).toContain(join(fresh.project, "src", "bot.ts"));
    expect(ctx.run.calls.some(c => c.join(" ") === "pm2 save")).toBe(true);
    expect(JSON.parse(await readFile(ctx.pm2DumpPath, "utf8"))).toEqual([{ name: "tybo-telegram-relay" }]);
    expect(existsSync(ctx.launchAgentsDir)).toBe(false);

    // Keine Geheimnisse in Ausgabe und Fragen
    expect(leakedSecrets(fresh.out)).toEqual([]);
    expect(leakedSecrets(fresh.asked)).toEqual([]);

    // Startübergang: die geschriebene .env ergibt den normalen Start
    expect(chooseStartMode(first.env)).toEqual({ mode: "normal" });

    // Erste Antwort: genau eine, an die Nutzer-ID aus der .env, mit dem Token aus der .env
    expect(first.sent).toEqual([{ token: FAKE.token, chatId: FAKE.userId, text: REPLY }]);
    expect(first.reply).toBe(REPLY);
    expect(first.fallbackCalls).toEqual([]);
    expect(first.claudeCalls).toHaveLength(1);
    expect(first.claudeCalls[0]).toMatchObject({ prompt: "voller-prompt", model: "agent-modell", effort: "high" });
    expect(first.promptCalls).toEqual([{ userMessage: USER_MESSAGE, chatId: FAKE.userId, agentName: "general", topicId: undefined }]);
    // Die Testnachricht der Einrichtung ist nicht die erste Antwort
    expect(sendTest.args[2]).not.toBe(REPLY);
  }, 30_000);

  test("B: macOS mit launchd, Supabase, Forum-Gruppe, Modelle und WebUI", async () => {
    const guarded = await isolated(async () => {
      const fresh = await runFresh("darwin", RUN_B);
      const overview = await setupOverview(fresh.ctx);
      const check = await checkStep.test!({}, fresh.ctx);
      const first = await firstReply(fresh.ctx);
      return { fresh, overview, check, first };
    });
    expect(guarded.fetchCalls).toBe(0);
    expect(guarded.envChanged).toEqual([]);
    expect(guarded.outsideChanged).toEqual([]);
    const { fresh, overview, check, first } = guarded.result;
    const { ctx } = fresh;

    expect(fresh.code).toBe(0);
    expect(fresh.left).toBe(0);
    expect(overview.complete).toBe(true);
    expect(overview.open).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.items?.map(i => i.label)).toEqual([
      "Voraussetzungen",
      "Telegram",
      "Forum-Gruppe",
      "Datenbank",
      "Modelle und Fallback",
      "Autostart",
    ]);
    expect(fresh.out).toContain("Alles eingerichtet und erreichbar.");
    expect(fresh.out).toContain("Gespeichert: Telegram, Forum-Gruppe, Datenbank, Profil, Modelle und Fallback, WebUI, Autostart");
    expect(fresh.out).toContain("tybo läuft über den Autostart");

    // .env: Telegram, Gruppe, Supabase, Profil, OpenRouter-Schlüssel, WebUI; Modelle stehen nicht hier
    expect(await readEnvFile(ctx.envPath)).toEqual({
      TELEGRAM_BOT_TOKEN: FAKE.token,
      TELEGRAM_USER_ID: FAKE.userId,
      TELEGRAM_GROUP_ID: FAKE.groupId,
      SUPABASE_URL: FAKE.supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: FAKE.serviceKey,
      SUPABASE_ANON_KEY: FAKE.anonKey,
      USER_NAME: "Testperson",
      USER_TIMEZONE: "Europe/Berlin",
      OPENROUTER_API_KEY: FAKE.openrouterKey,
      WEB_ENABLED: "true",
      WEB_PASSWORD: FAKE.webPassword,
      WEB_HOST: "127.0.0.1",
    });
    expect((await stat(ctx.envPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(ctx.profilePath, "utf8")).toBe(
      "# Testperson\n\n## Über mich\n- Beruf: Gärtnerei\n- Zeitzone: Europe/Berlin\n\n## Kommunikation\n- Kurz und direkt antworten\n",
    );

    // config/settings.json: Standardmodell, Effort und Fallback, ohne Schlüssel
    const settingsText = await readFile(ctx.settingsPath, "utf8");
    expect(JSON.parse(settingsText)).toEqual({
      defaults: { model: "test-standardmodell", effort: "medium" },
      fallback: { openrouterModel: "anbieter/test-modell", ollamaModel: "qwen3:8b", offlineOnly: false },
    });
    expect(leakedSecrets(settingsText)).toEqual([]);

    // Anbieter: Telegram samt Gruppe, Supabase, Claude, OpenRouter, Ollama
    const m = methods(ctx.providers);
    for (const name of ["telegramGetMe", "telegramSendTest", "telegramCheckGroup", "supabaseQuery", "claudeVersion", "claudeProbe", "openrouterKey", "ollamaTags"]) {
      expect(m).toContain(name);
    }
    expect(m).not.toContain("convexQuery");
    const sendTest = ctx.providers.calls.find(c => c.method === "telegramSendTest")!;
    expect(sendTest.args[1]).toBe(FAKE.userId);

    // Autostart: Plist nur im Temp-LaunchAgents, geladen über die Attrappe, kein PM2
    expect(ctx.run.calls.every(c => ALLOWED_PROGRAMS.has(c[0]))).toBe(true);
    expect(ctx.run.calls.some(c => c[0] === "pm2")).toBe(false);
    const plist = join(ctx.launchAgentsDir, "ai.tybo.telegram-relay.plist");
    expect(await readdir(ctx.launchAgentsDir)).toEqual(["ai.tybo.telegram-relay.plist"]);
    expect(ctx.run.calls.filter(c => c[0] === "launchctl" && c[1] === "load")).toEqual([["launchctl", "load", plist]]);
    const plistText = await readFile(plist, "utf8");
    expect(plistText).toContain(`<string>${fresh.project}</string>`);
    expect(plistText).toContain("/opt/test/bun/bin/bun");
    expect(leakedSecrets(plistText)).toEqual([]);
    expect(existsSync(ctx.pm2DumpPath)).toBe(false);

    expect(leakedSecrets(fresh.out)).toEqual([]);
    expect(leakedSecrets(fresh.asked)).toEqual([]);

    expect(chooseStartMode(first.env)).toEqual({ mode: "normal" });

    // Erste Antwort mit Modell und Effort aus der geschriebenen settings.json
    expect(first.sent).toEqual([{ token: FAKE.token, chatId: FAKE.userId, text: REPLY }]);
    expect(first.fallbackCalls).toEqual([]);
    expect(first.claudeCalls).toHaveLength(1);
    expect(first.claudeCalls[0]).toMatchObject({ model: "test-standardmodell", effort: "medium" });
    expect(sendTest.args[2]).not.toBe(REPLY);
  }, 30_000);
});
