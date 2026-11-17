#!/usr/bin/env -S bun --no-env-file
/**
 * Einstieg für den Befehl `tybo` (Issues #59, #60, #100 und #142,
 * Entscheidungen 0010 und 0015). Einziger Befehl, kein Alias.
 *
 *   tybo                   Chat im Terminal über den laufenden Bot, im zuletzt
 *                          genutzten Gespräch (sonst im Direktchat)
 *   tybo --topic <x>       direkt in ein Gespräch: Name, topic-<n>, <n> oder dm
 *   tybo --dev             gegen `bun run web:dev` (Port 3199, eigener
 *                          Schlüssel data/web-dev/cli-token, liest keine .env)
 *   tybo setup             Einrichtung im Terminal (Issue #65, src/setup/terminal.ts);
 *                          tybo setup <schritt> und tybo setup --liste
 *   tybo setup --web       Einrichtung im Browser (Issue #66, src/setup/web-mode.ts)
 *   tybo job …             Hintergrund-Jobs (Issue #103), wie `bun run job …`
 *   tybo datenbank …       Supabase auf diesem Rechner: start, stop, status,
 *                          sichern (Issue #165, src/setup/local-supabase.ts)
 *   tybo suche …           Embeddings nach Anbieterwechsel neu berechnen,
 *                          Stand, Abschnitte langer Nachrichten
 *                          (Issue #168, src/setup/search-reindex.ts)
 *   tybo routinen …        Liste wie /routinen; einbinden/ausbinden <label>
 *                          setzt bzw. entfernt den Wrapper (Issue #286,
 *                          src/lib/routines/einbinden.ts)
 *   tybo dienste [<dienst>|all]
 *                          tybo-Dienste einrichten (launchd; Linux: PM2 und
 *                          systemd-Timer, Issue #370), ohne Angabe alle
 *                          (Issue #369, src/setup/services/command.ts);
 *                          bun run setup:launchd und setup:services rufen
 *                          denselben Befehl
 *   tybo pruefen           Prüfbericht mit Exit-Code: alle Einrichtungsschritte,
 *                          Kanäle und Spezialprüfungen (Issue #371,
 *                          src/setup/checks/command.ts); bun run setup:verify
 *                          ruft denselben Befehl
 *   tybo deinstallieren    Hintergrunddienste entfernen (launchd, systemd,
 *                          cron, PM2), Rückfrage zu models/speech/ (Issue #373,
 *                          src/setup/services/uninstall.ts); bun run uninstall
 *                          ruft denselben Befehl
 *   tybo wartung [--dry-run]
 *                          sichere Posten aufräumen (Test-Simulatoren, Caches,
 *                          eigene Logs) und melden; --dry-run zeigt nur
 *                          (Issue #485, src/lib/maintenance/run.ts)
 *   tybo erinnerungen importieren [datei]
 *   tybo gedaechtnis ziele-nachholen
 *   tybo gedaechtnis bereinigen --datei <Pfad> | archiv | zurueckholen <Kennung> ...
 *   tybo gedaechtnis geheimnisse [--alle]
 *                          offene Einträge der alten config/reminders.json
 *                          genau einmal übernehmen (Issue #323,
 *                          src/lib/schedule/legacy-import.ts)
 *   tybo help              Kurzhilfe
 *
 * Startet nie selbst einen Bot: läuft keiner, sagt tybo das und nennt den
 * Startbefehl. Projektordner, Schlüsseldatei und WEB_PORT kommen aus dem
 * Ordner dieses Skripts (oder TYBO_ROOT, für Tests), nie aus dem aktuellen
 * Arbeitsverzeichnis. Werte aus <Projekt>/.env gehen vor, wie im Bot.
 * --no-env-file (Shebang und package.json): Bun lädt sonst die .env des
 * aktuellen Arbeitsverzeichnisses, etwa WEB_PORT eines fremden Projekts.
 * Global verfügbar machen: `bun link` im Projektordner (docs/webui/README.md).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BRAND } from "../src/brand";
import type { SetupContext } from "../src/setup/context";
import type { Prompter } from "../src/setup/prompt";
import type { WrapCommandDeps } from "../src/lib/routines/einbinden";
import type { LaunchdDeps } from "../src/setup/services/launchd";
import { parseEnvContent } from "../src/lib/env-file";
import { BOT_SERVICE, launchdLabel } from "../src/lib/service-names";
import { ApiClient, ApiError, tokenFromFile } from "../src/terminal/api";
import { runChatApp, terminalModes, type TerminalInput, type TerminalOutput } from "../src/terminal/app";
import { selectConversation } from "../src/terminal/select";
import { loadState, saveState, stateFile } from "../src/terminal/state";
import { defaultCliTokenFile, readCliToken } from "../src/web/cli-token";
import { loadWebConfig } from "../src/web/config";

type Env = Record<string, string | undefined>;

export interface TyboOptions {
  args: string[];
  env: Env;
  /** Projektordner; Standard: TYBO_ROOT oder der Ordner über scripts/ */
  root?: string;
  out?(line: string): void;
  err?(line: string): void;
  platform?: NodeJS.Platform;
  home?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Terminal für den Chat; Standard process.stdin/process.stdout */
  stdin?: TerminalInput;
  stdout?: TerminalOutput;
  /** Nur für Tests: Einrichtung mit Attrappen statt echter Befehle und Anbieter */
  setup?: {
    ctx?: SetupContext;
    prompter?: Prompter;
    /** Strg+C (bei tybo datenbank auch SIGTERM); gibt die Abmeldung zurück */
    onInterrupt?(handler: (signal?: NodeJS.Signals) => void): () => void;
    /** Schonfrist nach Strg+C (Standard: RUN_GRACE_MS) */
    runGraceMs?: number;
    /** tybo setup --web: fester Code, Port 0, Strg+C-Attrappe, Meldung beim Start, Schonfrist */
    web?: Pick<import("../src/setup/web-mode").SetupModeOptions, "code" | "port" | "onInterrupt" | "onReady" | "graceMs" | "runGraceMs">;
  };
  /** Nur für Tests: tybo routinen mit Attrappen statt launchctl, plutil und Dateien */
  routines?: Partial<WrapCommandDeps>;
  /** Nur für Tests: tybo gedaechtnis mit Attrappen statt Bot-API und Versand */
  goalBackfill?: Pick<import("../src/lib/memory/goal-backfill-command").GoalBackfillCommandOptions, "createApi" | "send">;
  factCleanup?: Pick<import("../src/lib/memory/fact-cleanup-command").FactCleanupCommandOptions, "createApi" | "send">;
  secretReview?: Pick<import("../src/lib/memory/secret-review-command").SecretCommandOptions, "createApi" | "send">;
  /** Nur für Tests: tybo dienste mit Attrappen statt launchctl und Dateien */
  services?: Partial<LaunchdDeps>;
  /** Nur für Tests: tybo pruefen mit eigenen Spezialprüfungen und Zeitlimit (Kontext über setup.ctx) */
  checks?: Pick<import("../src/setup/checks/command").CheckCommandOptions, "specials" | "timeoutMs">;
  /** Nur für Tests: tybo dienste unter Linux mit Attrappen statt systemctl, crontab und PM2 */
  linuxServices?: { timers?: Partial<import("../src/setup/services/linux").LinuxDeps>; pm2?: Partial<import("../src/setup/services/pm2").Pm2Deps> };
  /**
   * Nur für Tests: tybo wartung mit Attrappen statt xcrun, notify und echtem
   * Home; services ergänzt die echten Dienstzugriffe, env kommt immer aus
   * Umgebung und Projekt-.env
   */
  maintenance?: Partial<Omit<import("../src/lib/maintenance/items").MaintenanceDeps, "services">> & {
    services?: Partial<Omit<import("../src/lib/maintenance/services").ServiceDeps, "env">>;
  };
  /** Nur für Tests: tybo deinstallieren mit Attrappen statt launchctl, systemctl, crontab, PM2 und Dateien */
  uninstall?: Partial<import("../src/setup/services/uninstall").UninstallDeps>;
}

/** Port von web:dev (bewusst nicht 3100, dort läuft die echte WebUI) */
export const DEV_PORT = 3199;

/** Dienstdatei des Bots (Issue #101) */
const SERVICE_PLIST = join("Library", "LaunchAgents", `${launchdLabel(BOT_SERVICE)}.plist`);
/** Adressen, unter denen der Server auch über Loopback erreichbar ist */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1", "::"]);

export function projectRoot(env: Env): string {
  return env.TYBO_ROOT?.trim() || resolve(import.meta.dir, "..");
}

/** .env wie src/lib/env.ts, derselbe Parser (Anführungszeichen seit Issue #62) */
export function parseEnvFile(content: string): Env {
  return parseEnvContent(content);
}

function usage(): string {
  return [
    `${BRAND.name} im Terminal`,
    "",
    `  ${BRAND.cli}                  Chat mit dem laufenden Bot (zuletzt genutztes Gespräch, sonst Direktchat)`,
    `  ${BRAND.cli} --topic <Name>   direkt in ein Topic (auch topic-<n>, <n> oder dm)`,
    `  ${BRAND.cli} --dev            gegen bun run web:dev auf Port ${DEV_PORT}`,
    `  ${BRAND.cli} setup            Einrichtung: Übersicht, dann die offenen Schritte`,
    `  ${BRAND.cli} setup <Schritt>  nur ein Schritt (etwa telegram); --liste nur die Übersicht`,
    `  ${BRAND.cli} setup --web      Einrichtung im Browser (nur dieser Rechner, mit Einmal-Code)`,
    `  ${BRAND.cli} job <start|list|stop|log>  Hintergrund-Jobs (${BRAND.cli} job help)`,
    `  ${BRAND.cli} datenbank <start|stop|status|sichern>  Supabase auf diesem Rechner (${BRAND.cli} datenbank help)`,
    `  ${BRAND.cli} suche <neu-berechnen|status|abschnitte>  Suche nach Anbieterwechsel neu berechnen, Abschnitte langer Nachrichten (${BRAND.cli} suche help)`,
    `  ${BRAND.cli} routinen         Routinen wie /routinen; einbinden|ausbinden <Label> (${BRAND.cli} routinen help)`,
    `  ${BRAND.cli} dienste [Dienst]  Dienste einrichten (launchd, unter Linux PM2 und systemd-Timer), ohne Angabe alle (${BRAND.cli} dienste help)`,
    `  ${BRAND.cli} pruefen          Prüfbericht über die ganze Einrichtung, Exit-Code 1 bei Fehlern (${BRAND.cli} pruefen help)`,
    `  ${BRAND.cli} deinstallieren   Hintergrunddienste entfernen; Projektordner, .env und Daten bleiben (${BRAND.cli} deinstallieren help)`,
    `  ${BRAND.cli} wartung          sichere Posten aufräumen, veraltete Dienste neu starten, melden; --dry-run zeigt nur (${BRAND.cli} wartung help)`,
    `  ${BRAND.cli} erinnerungen importieren [Datei]  alte config/reminders.json einmal übernehmen (${BRAND.cli} erinnerungen help)`,
    `  ${BRAND.cli} gedaechtnis ziele-nachholen  [GOAL:]-Tags aus alten Antworten als Vorschläge vorlegen (${BRAND.cli} gedaechtnis help)`,
    `  ${BRAND.cli} gedaechtnis bereinigen --datei <Pfad>  Fakten per Knöpfen archivieren oder umschreiben; archiv, zurueckholen (${BRAND.cli} gedaechtnis help)`,
    `  ${BRAND.cli} gedaechtnis geheimnisse  Fakten mit Passwort oder Schlüssel maskiert zeigen, per Knopf behalten oder archivieren`,
    `  ${BRAND.cli} help             Diese Hilfe`,
    "",
    "Im Chat: Enter sendet, Alt+Enter oder \\ am Zeilenende für eine neue Zeile,",
    "Pfeil hoch/runter für frühere Eingaben, Strg+C stoppt die Antwort, zweimal beendet, /help.",
  ].join("\n");
}

/**
 * Konkreter Startbefehl: der launchd-Dienst ai.tybo.telegram-relay, wenn er
 * eingerichtet ist, sonst bun run start im Projekt
 */
export function startHint(root: string, platform: NodeJS.Platform, home: string): string {
  if (platform === "darwin") {
    const plist = join(home, SERVICE_PLIST);
    if (existsSync(plist)) return `launchctl load ${plist}`;
  }
  return `cd ${root} && bun run start`;
}

/**
 * Läuft laut bot.lock ein Bot-Prozess? Gleiches Urteil wie beim Start des
 * Bots (Issue #564): PID und Startzeit, alte Sperren über die Befehlszeile;
 * im Zweifel ja.
 */
async function botProcessRunning(root: string): Promise<boolean> {
  const { botLockHeld } = await import("../src/app/lifecycle");
  return botLockHeld(root);
}

/** Wohin tybo sich verbindet: laufender Bot oder web:dev */
interface Target {
  base: string;
  tokenFile: string;
  dev: boolean;
}

/** Adresse und Schlüsseldatei des laufenden Bots aus seiner .env; sonst Exit-Code mit Meldung */
function botTarget(root: string, env: Env, err: (line: string) => void): Target | number {
  const result = loadWebConfig(env);
  if (result.status === "disabled") {
    err(`${BRAND.cli} braucht die WebUI, sie ist aus (WEB_ENABLED ist nicht true in ${join(root, ".env")}).`);
    err("WEB_ENABLED=true und WEB_PASSWORD in die .env eintragen und den Bot neu starten.");
    return 1;
  }
  if (result.status === "invalid") {
    err(`${BRAND.cli} kann die WebUI nicht erreichen: ${result.reason} (${join(root, ".env")}).`);
    return 1;
  }
  const { host, port } = result.config;
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    err(`Die WebUI lauscht nur auf ${host} (WEB_HOST). ${BRAND.cli} verbindet sich über 127.0.0.1.`);
    err("WEB_HOST=0.0.0.0 (Heimnetz und dieser Rechner) oder 127.0.0.1 setzen und den Bot neu starten.");
    return 1;
  }
  const base = host === "::1" ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`;
  return { base, tokenFile: defaultCliTokenFile(root), dev: false };
}

/**
 * web:dev (Issue #60, Demo und Ausprobieren): Port 3199 (TYBO_DEV_PORT aus
 * der Umgebung, nicht aus der .env), Schlüssel aus data/web-dev/cli-token.
 * Liest weder die .env noch data/cli-token des Bots.
 */
function devTarget(root: string, env: Env): Target | number {
  const port = Number(env.TYBO_DEV_PORT ?? DEV_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 2;
  return { base: `http://127.0.0.1:${port}`, tokenFile: join(root, "data", "web-dev", "cli-token"), dev: true };
}

/** Prüft Erreichbarkeit und Anmeldung; null, wenn beides klappt, sonst der Exit-Code */
async function checkLogin(options: TyboOptions, root: string, target: Target): Promise<number | null> {
  const err = options.err ?? console.error;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? options.env.HOME ?? homedir();
  const { base, tokenFile } = target;
  const token = await readCliToken(tokenFile);

  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(`${base}/api/me`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
      redirect: "manual",
    });
  } catch {
    if (target.dev) {
      err(`web:dev läuft nicht unter ${base}. Starten mit: WEB_ENABLED=true WEB_PORT=${new URL(base).port} WEB_PASSWORD=<Passwort> bun run web:dev`);
      return 1;
    }
    if (await botProcessRunning(root)) {
      err(`Der Bot läuft, aber die WebUI antwortet nicht unter ${base}.`);
      err(`Im Log (${join(root, "logs", "telegram-relay.log")}) nach „[web] WebUI startet nicht" suchen.`);
      return 1;
    }
    err(`${BRAND.name} läuft nicht. Starten mit: ${startHint(root, platform, home)}`);
    return 1;
  }
  await res.body?.cancel().catch(() => {});

  if (res.status === 200) return null;
  if (res.status === 401 && !token) {
    err(`${BRAND.name} läuft unter ${base}, aber es gibt keinen lokalen Schlüssel (${tokenFile}).`);
    err(`Er entsteht beim Start des Bots in dessen Projektordner. Läuft der Bot aus einem anderen Ordner als ${root}?`);
    return 1;
  }
  if (res.status === 401) {
    err(`Der lokale Schlüssel in ${tokenFile} gilt nicht (mehr).`);
    err(`Läuft der Bot aus einem anderen Ordner als ${root}? Sonst den Bot neu starten, dann entsteht ein neuer.`);
    return 1;
  }
  err(`Unter ${base} antwortet etwas anderes als ${BRAND.name} (Status ${res.status}). WEB_PORT in ${join(root, ".env")} prüfen.`);
  return 1;
}

export interface ChatArgs {
  topic?: string;
  dev: boolean;
}

/** --topic <x>, --topic=<x>, --dev; null bei allem anderen */
export function parseChatArgs(args: string[]): ChatArgs | null {
  const result: ChatArgs = { dev: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dev") result.dev = true;
    else if (arg === "--topic" && i + 1 < args.length && result.topic === undefined) result.topic = args[++i];
    else if (arg.startsWith("--topic=") && result.topic === undefined) result.topic = arg.slice("--topic=".length);
    else return null;
  }
  return result;
}

/** Chat im Terminal: anmelden, Gespräch wählen und merken, dann die Anzeige starten */
async function chat(options: TyboOptions, root: string, env: Env, args: ChatArgs): Promise<number> {
  const err = options.err ?? console.error;
  const target = args.dev ? devTarget(root, options.env) : botTarget(root, env, err);
  if (typeof target === "number") {
    if (args.dev) err("TYBO_DEV_PORT ist keine gültige Portnummer.");
    return target;
  }
  const failed = await checkLogin(options, root, target);
  if (failed !== null) return failed;

  const client = new ApiClient({ base: target.base, getToken: tokenFromFile(target.tokenFile), fetch: options.fetch });
  let list;
  try {
    list = await client.listConversations();
  } catch (e) {
    err(`Gespräche nicht lesbar: ${e instanceof ApiError ? e.message : "unbekannter Fehler"}`);
    return 1;
  }
  const home = options.home ?? options.env.HOME ?? homedir();
  const file = stateFile(home, target.dev);
  const saved = await loadState(file);
  const selection = selectConversation(list, { topic: args.topic, savedId: saved.conversationId });
  if (!selection.ok) {
    err(selection.error);
    return 1;
  }
  await saveState(file, { conversationId: selection.conversation.id });
  return runChatApp({
    client,
    conversation: selection.conversation,
    note: selection.note,
    stdin: options.stdin ?? process.stdin,
    stdout: options.stdout ?? process.stdout,
    env: options.env,
    // /wechsel und /neu (Issue #61): beim nächsten Start dort weiter
    onSwitch: conversation => saveState(file, { conversationId: conversation.id }),
  });
}

/**
 * tybo setup (Issue #65). Erst hier geladen: die Einrichtung zieht
 * setup/configure-*.ts nach, die der Chat nicht braucht. Die .env liest der
 * Kern selbst aus dem Projektordner.
 */
async function setup(options: TyboOptions, root: string, args: string[]): Promise<number> {
  const err = options.err ?? console.error;
  const { parseSetupArgs, runSetup, setupUsage } = await import("../src/setup/terminal");
  const parsed = parseSetupArgs(args);
  if (!parsed) {
    err(`Unbekannter Aufruf: ${BRAND.cli} setup ${args.join(" ")}`);
    err(setupUsage());
    return 2;
  }
  const { createSetupContext } = await import("../src/setup/context");
  const ctx = options.setup?.ctx ?? createSetupContext({ root });
  if (parsed.mode === "web") return setupWeb(options, root, ctx);
  const { createTerminalPrompter } = await import("../src/setup/prompt");
  const prompter = options.setup?.prompter ?? createTerminalPrompter(options.stdin ?? process.stdin, options.stdout ?? process.stdout);
  return runSetup(parsed, {
    ctx,
    prompter,
    out: options.out ?? console.log,
    onInterrupt:
      options.setup?.onInterrupt ??
      (handler => {
        process.on("SIGINT", handler);
        return () => process.off("SIGINT", handler);
      }),
    runGraceMs: options.setup?.runGraceMs,
  });
}

/**
 * tybo setup --web (Issue #66): Einrichtungsmodus im Browser aus diesem
 * Prozess. Läuft schon ein Bot (bot.lock), startet nichts: der Bot hat die
 * WebUI auf demselben Port, und zwei Einrichtungen gleichzeitig will niemand.
 * Kehrt erst nach „Fertig“ oder Strg+C zurück. tybo läuft nie unter launchd
 * oder PM2, „Fertig“ startet also den Autostart oder nennt den Startbefehl.
 */
async function setupWeb(options: TyboOptions, root: string, ctx: SetupContext): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  if (await botProcessRunning(root)) {
    err(`${BRAND.name} läuft schon. Einrichtung im Terminal mit: ${BRAND.cli} setup`);
    return 1;
  }
  const dotenv = parseEnvFile(await readFile(join(root, ".env"), "utf8").catch(() => ""));
  const { chooseStartMode } = await import("../src/setup/start-mode");
  const { runSetupMode } = await import("../src/setup/web-mode");
  const startMode = chooseStartMode({ ...options.env, ...dotenv }, { forceSetup: true });
  if (startMode.mode !== "setup") return 1;
  return runSetupMode({
    root,
    env: { ...options.env, ...dotenv },
    startMode,
    supervisor: async () => null,
    ctx,
    log: out,
    ...options.setup?.web,
  });
}

/**
 * tybo job … (Issue #103): derselbe Befehl wie `bun run job …`, als eigener
 * Prozess (scripts/job.ts neben diesem Skript) mit dem Projektordner aus
 * TYBO_ROOT. Arbeitsverzeichnis bleibt das des Aufrufers (für --brief),
 * die Umgebung auch (TYBO_CHAT_ID/TYBO_TOPIC_ID, für die Rückmeldung).
 */
async function job(options: TyboOptions, root: string, args: string[]): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  const proc = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", join(import.meta.dir, "job.ts"), ...args],
    cwd: process.cwd(),
    env: { ...options.env, TYBO_ROOT: root } as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (stdout.trim()) out(stdout.replace(/\n$/, ""));
  if (stderr.trim()) err(stderr.replace(/\n$/, ""));
  return code;
}

/**
 * tybo datenbank … (Issue #165): Supabase auf diesem Rechner starten,
 * anhalten, Zustand zeigen, sichern. Läuft auch unter launchd bzw. PM2
 * (Dienst ai.tybo.supabase / tybo-supabase ruft `datenbank start` auf);
 * die Ausgabe landet dann in logs/supabase.log und enthält nur feste Sätze.
 * Strg+C (SIGINT) wie auch SIGTERM (pm2 stop, launchd, Weitergabe durch die
 * Hülle run-once-and-stay) bricht Warten, Start und Sicherung ab; der Befehl
 * endet erst nach Bereinigung und Schutzprüfung bzw. Schutz-Stopp, mit 130
 * nach SIGINT und 143 nach SIGTERM.
 */
async function datenbank(options: TyboOptions, root: string, env: Env, args: string[]): Promise<number> {
  const { EXIT_ABORTED, runDatabaseCommand } = await import("../src/setup/local-supabase");
  const { createSetupContext } = await import("../src/setup/context");
  const ctx = options.setup?.ctx ?? createSetupContext({ root });
  const controller = new AbortController();
  let received: NodeJS.Signals | undefined;
  const onInterrupt =
    options.setup?.onInterrupt ??
    ((handler: (signal: NodeJS.Signals) => void) => {
      const onInt = () => handler("SIGINT");
      const onTerm = () => handler("SIGTERM");
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
      return () => {
        process.off("SIGINT", onInt);
        process.off("SIGTERM", onTerm);
      };
    });
  const release = onInterrupt(signal => {
    received ??= signal;
    controller.abort();
  });
  try {
    const code = await runDatabaseCommand(args, {
      ctx,
      env,
      out: options.out ?? console.log,
      err: options.err ?? console.error,
      signal: controller.signal,
    });
    return code === EXIT_ABORTED && received === "SIGTERM" ? 143 : code;
  } finally {
    release();
  }
}

/**
 * tybo suche … (Issue #168): Neuberechnung der Embeddings nach einem
 * Anbieterwechsel. Strg+C und SIGTERM brechen nach dem laufenden Eintrag ab;
 * der Stand bis zum letzten bestätigten Stapel bleibt, derselbe Befehl setzt fort.
 */
async function suche(options: TyboOptions, root: string, env: Env, args: string[]): Promise<number> {
  const { runSearchCommand } = await import("../src/setup/search-reindex");
  const controller = new AbortController();
  const onInterrupt =
    options.setup?.onInterrupt ??
    ((handler: (signal: NodeJS.Signals) => void) => {
      const onInt = () => handler("SIGINT");
      const onTerm = () => handler("SIGTERM");
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
      return () => {
        process.off("SIGINT", onInt);
        process.off("SIGTERM", onTerm);
      };
    });
  const release = onInterrupt(() => controller.abort());
  try {
    return await runSearchCommand(args, { root, env, out: options.out ?? console.log, err: options.err ?? console.error, signal: controller.signal });
  } finally {
    release();
  }
}

export function routinesUsage(): string {
  return [
    `${BRAND.cli} routinen                       alle Routinen wie /routinen`,
    `${BRAND.cli} routinen einbinden <Label>     Verlauf einschalten: Wrapper vor den Befehl der Plist setzen (mit Sicherung)`,
    `${BRAND.cli} routinen ausbinden <Label>     Wrapper wieder entfernen (mit Sicherung)`,
    "",
    "--ja überspringt die Rückfrage. Nur macOS, nur ai.tybo.* und Dienste aus config/routines.json,",
    "nie der Bot-Dienst oder Dauerdienste. Sicherungen: data/launchd-backup/.",
  ].join("\n");
}

/** einbinden|ausbinden <label> [--ja]; null bei allem anderen */
export function parseWrapArgs(args: string[]): { label: string; yes: boolean } | null {
  const yes = args.includes("--ja");
  const rest = args.filter(a => a !== "--ja");
  if (rest.length !== 1 || !rest[0] || rest[0].startsWith("-")) return null;
  return { label: rest[0], yes };
}

/**
 * tybo routinen … (Issue #286): ohne Unterbefehl dieselbe Liste wie
 * /routinen, mit einbinden/ausbinden der Wrapper für genau einen Dienst.
 * Nur im Terminal, nie als Chat-Befehl. Pfade aus dem Projektordner, nie
 * aus dem Arbeitsverzeichnis.
 */
async function routinen(options: TyboOptions, root: string, env: Env, args: string[]): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  const { changeRoutineWrapper, defaultWrapCommandDeps } = await import("../src/lib/routines/einbinden");
  const deps: WrapCommandDeps = { ...defaultWrapCommandDeps(root, env), out, err, ...options.routines };
  const [sub, ...rest] = args;
  if (sub === undefined) {
    const { listRoutines } = await import("../src/lib/routines/catalog");
    const { formatRoutineList } = await import("../src/lib/routines/format");
    out(formatRoutineList(await listRoutines(deps)));
    return 0;
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    out(routinesUsage());
    return 0;
  }
  if (sub === "einbinden" || sub === "ausbinden") {
    const parsed = parseWrapArgs(rest);
    if (parsed) return changeRoutineWrapper(sub, parsed.label, deps, { yes: parsed.yes });
  }
  err(`Unbekannter Aufruf: ${BRAND.cli} routinen ${args.join(" ")}`);
  err(routinesUsage());
  return 2;
}

export function remindersUsage(): string {
  return [
    `${BRAND.cli} erinnerungen importieren [Datei]   offene Einträge der alten Datei übernehmen (Standard: config/reminders.json)`,
    "",
    "Übernimmt nur ungesendete Einträge (sent false, kein sent_at), Ortszeit aus USER_TIMEZONE, ohne Uhrzeit 9 Uhr,",
    "in den Direktchat. Jeder Eintrag kommt genau einmal an, auch bei wiederholtem Aufruf.",
    "Vorher den alten Dienst entladen, der die Datei verschickt hat.",
  ].join("\n");
}

/**
 * tybo erinnerungen importieren (Issue #323): einmaliger Import aus der
 * alten Datei in die Ablage des Bots (Supabase oder data/reminders.json).
 * Pfade aus dem Projektordner, nie aus dem Arbeitsverzeichnis. Exit-Code 1,
 * wenn die Datei fehlt, unlesbar ist oder ein Eintrag nicht angelegt wurde.
 */
async function erinnerungen(options: TyboOptions, root: string, env: Env, args: string[]): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    out(remindersUsage());
    return 0;
  }
  if (sub !== "importieren" || rest.length > 1 || rest[0]?.startsWith("-")) {
    err(`Unbekannter Aufruf: ${BRAND.cli} erinnerungen ${args.join(" ")}`);
    err(remindersUsage());
    return 2;
  }
  const file = resolve(root, rest[0] ?? join("config", "reminders.json"));
  const { importLegacyReminders, parseLegacyFile } = await import("../src/lib/schedule/legacy-import");
  const { scheduleStoreFor } = await import("../src/lib/schedule/store");
  const { dmChatId } = await import("../src/lib/channels");
  const { shortStamp } = await import("../src/lib/schedule/planner");
  const { effectiveTimeZone } = await import("../src/lib/when");
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    err(`Datei nicht gefunden: ${file}`);
    return 1;
  }
  let entries: unknown[];
  try {
    entries = parseLegacyFile(content);
  } catch (e) {
    err(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const zone = effectiveTimeZone(env.USER_TIMEZONE);
  const store = scheduleStoreFor(env, root);
  const report = await importLegacyReminders(store, entries, { chatId: dmChatId(env), timeZone: zone });
  out(`Ablage: ${store.backend === "supabase" ? "Supabase" : "data/reminders.json"}, Zeitzone ${zone}`);
  for (const a of report.added) out(`  neu: ${shortStamp(Date.parse(a.dueAt), zone)} · ${a.text}${a.overdue ? " (überfällig, kommt gleich nach dem Start des Bots)" : ""}`);
  for (const x of report.invalid) out(`  nicht übernommen: Eintrag ${x.position} (${x.reason})`);
  out(`Neu: ${report.added.length} · schon übernommen: ${report.existing} · schon zugestellt: ${report.sent} · ungültig: ${report.invalid.length} · fehlgeschlagen: ${report.failed}`);
  if (report.failed > 0) {
    err("Nicht alle Einträge wurden angelegt. Derselbe Befehl kann gefahrlos wiederholt werden.");
    return 1;
  }
  return 0;
}

/**
 * tybo gedaechtnis ziele-nachholen (Issue #518), bereinigen, archiv und
 * zurueckholen (Issue #520), geheimnisse (Issue #524). Store und Outbox lesen process.env, darum samt
 * Projekt-.env; Ablagen unter dem Projektordner, auch die lokale der Fakten
 */
async function gedaechtnis(options: TyboOptions, root: string, env: Env, args: string[]): Promise<number> {
  const { goalBackfillUsage, runGoalBackfillCommand } = await import("../src/lib/memory/goal-backfill-command");
  const { FACT_CLEANUP_COMMANDS, factCleanupUsage, runFactCleanupCommand } = await import("../src/lib/memory/fact-cleanup-command");
  const { SECRET_COMMAND, secretCommandUsage, runSecretCommand } = await import("../src/lib/memory/secret-review-command");
  if (options.env === process.env) {
    Object.assign(process.env, env);
    process.env.GO_PROJECT_ROOT ||= root;
  }
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  const [sub] = args;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    out(`${goalBackfillUsage()}\n\n${factCleanupUsage()}\n\n${secretCommandUsage()}`);
    return 0;
  }
  if (sub === SECRET_COMMAND) return runSecretCommand(args, { root, env, out, err, ...options.secretReview });
  if (FACT_CLEANUP_COMMANDS.includes(sub)) return runFactCleanupCommand(args, { root, env, out, err, ...options.factCleanup });
  return runGoalBackfillCommand(args, { root, env, out, err, ...options.goalBackfill });
}

/** tybo dienste … (Issue #369): Projektordner und Home vom Aufrufer, nie vom Arbeitsverzeichnis */
async function dienste(options: TyboOptions, root: string, args: string[]): Promise<number> {
  const { runServicesCommand } = await import("../src/setup/services/command");
  const { realLaunchdDeps } = await import("../src/setup/services/launchd");
  const { realLinuxDeps } = await import("../src/setup/services/linux");
  const { realPm2Deps } = await import("../src/setup/services/pm2");
  const out = options.out ?? console.log;
  const home = options.home ?? options.env.HOME ?? homedir();
  const deps: LaunchdDeps = { ...realLaunchdDeps(root, home), log: out, ...options.services };
  const linux = {
    timers: { ...realLinuxDeps(root, home, out), ...options.linuxServices?.timers },
    pm2: { ...realPm2Deps(root, out), ...options.linuxServices?.pm2 },
  };
  return runServicesCommand(args, { root, platform: options.platform ?? process.platform, deps, linux, out, err: options.err ?? console.error });
}

/** tybo pruefen … (Issue #371): Kontext aus dem Projektordner, wie tybo setup */
async function pruefen(options: TyboOptions, root: string, args: string[]): Promise<number> {
  const { runCheckCommand } = await import("../src/setup/checks/command");
  const { createSetupContext } = await import("../src/setup/context");
  const ctx = options.setup?.ctx ?? createSetupContext({ root });
  return runCheckCommand(args, { ctx, out: options.out ?? console.log, err: options.err ?? console.error, ...options.checks });
}

/** tybo deinstallieren (Issue #373): Projektordner und Home vom Aufrufer, nie vom Arbeitsverzeichnis */
async function deinstallieren(options: TyboOptions, root: string, args: string[]): Promise<number> {
  const { realUninstallDeps, runUninstallCommand } = await import("../src/setup/services/uninstall");
  const home = options.home ?? options.env.HOME ?? homedir();
  const deps = { ...realUninstallDeps(root, home), platform: options.platform ?? process.platform, out: options.out ?? console.log, err: options.err ?? console.error, ...options.uninstall };
  return runUninstallCommand(args, deps);
}

/**
 * tybo wartung … (Issue #485): Projektordner und Home vom Aufrufer, nie vom
 * Arbeitsverzeichnis. env samt Projekt-.env, damit der Bot-Schutz der
 * Dienste (Issue #486) eigene Namen aus TYBO_LAUNCHD_LABEL und
 * TYBO_SYSTEMD_UNIT kennt
 */
async function wartung(options: TyboOptions, root: string, env: Env, args: string[]): Promise<number> {
  const { runMaintenanceCommand } = await import("../src/lib/maintenance/run");
  const { realMaintenanceDeps } = await import("../src/maintenance");
  const home = options.home ?? options.env.HOME ?? homedir();
  const real = realMaintenanceDeps(root, home, env);
  const { services, ...overrides } = options.maintenance ?? {};
  const deps = { ...real, ...(options.platform && { platform: options.platform }), ...overrides, services: { ...real.services!, ...services, env } };
  return runMaintenanceCommand(args, { deps, out: options.out ?? console.log, err: options.err ?? console.error });
}

/** Verteilt die Unterbefehle; gibt den Exit-Code zurück */
export async function runTybo(options: TyboOptions): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  const root = options.root ?? projectRoot(options.env);
  const dotenv = parseEnvFile(await readFile(join(root, ".env"), "utf8").catch(() => ""));
  const env: Env = { ...options.env, ...dotenv };
  const [command, ...rest] = options.args;

  if (command === "help" || command === "--help" || command === "-h") {
    out(usage());
    return 0;
  }
  if (command === "setup") return setup(options, root, rest);
  if (command === "job") return job(options, root, rest);
  if (command === "datenbank") return datenbank(options, root, env, rest);
  if (command === "suche") return suche(options, root, env, rest);
  if (command === "routinen") return routinen(options, root, env, rest);
  if (command === "dienste") return dienste(options, root, rest);
  if (command === "pruefen") return pruefen(options, root, rest);
  if (command === "deinstallieren") return deinstallieren(options, root, rest);
  if (command === "wartung") return wartung(options, root, env, rest);
  if (command === "erinnerungen") return erinnerungen(options, root, env, rest);
  if (command === "gedaechtnis") return gedaechtnis(options, root, env, rest);
  if (command === undefined || command.startsWith("--")) {
    const args = parseChatArgs(options.args);
    if (args) return chat(options, root, env, args);
  }
  err(`Unbekannter Befehl: ${[command, ...rest].join(" ")}`);
  err(usage());
  return 2;
}

/**
 * Aufruf als Befehl: Terminal aufräumen, Unterbefehl ausführen, beenden.
 * testing: nur für Tests (Kindprozess mit Attrappen, echtes process.exit)
 */
export async function main(testing: Pick<TyboOptions, "setup"> = {}): Promise<never> {
  // Auch bei einem Absturz: Terminal nicht im Raw-Modus zurücklassen. Nur
  // zurückstellen, was der Chat selbst eingeschaltet hat (NO_COLOR, TERM=dumb
  // und Pipes bekommen so nie eine Escape-Sequenz)
  process.on("exit", () => {
    try {
      if (terminalModes.bracketedPaste) process.stdout.write("\u001b[?2004l");
      if (terminalModes.rawMode) process.stdin.setRawMode(false);
    } catch {
      // Terminal schon weg
    }
  });
  process.exit(await runTybo({ args: process.argv.slice(2), env: process.env, ...testing }));
}

if (import.meta.main) await main();
