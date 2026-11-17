/**
 * Abschnitt „Motor“ von `tybo pruefen` (Issue #567): Ist der Standard-Motor
 * installiert und angemeldet, und zwar mit dem PATH, mit dem der Bot als
 * Dienst wirklich läuft?
 *
 * Welcher Motor: wie zur Laufzeit engine.default in config/settings.json,
 * dann TYBO_ENGINE aus der .env des Projekts, dann Claude Code (setupEngine
 * in ../engine.ts). Nur dieser Motor wird geprüft; fehlt Claude Code bei
 * einem bereiten anderen Motor, bleibt das ein Hinweis im Schritt
 * „voraussetzungen“ (Issue #566), kein Fehler hier.
 *
 * Wie geprüft wird, ohne Modellaufruf und ohne etwas zu senden:
 * - Claude Code: `claude --version` und `claude auth status --json` über
 *   ctx.run, im Projektordner, mit der Umgebung aus claudeRunContext
 *   (CLAUDE_AUTH und ANTHROPIC_API_KEY allein aus der .env des Projekts).
 *   Von der Anmeldung zählt nur das Feld loggedIn. Zeitlimit oder unlesbare
 *   Ausgabe heißt „nicht prüfbar“: ein Fehler mit Abhilfe, denn ob der Bot
 *   antwortet, ist dann offen. Die Meldung behauptet weder „angemeldet“
 *   noch „abgemeldet“.
 * - Codex, OpenCode, Anthropic API: engineItem aus ../engine.ts (wie im
 *   Schritt „voraussetzungen“), mit CODEX_PATH bzw. OPENCODE_PATH aus der
 *   .env. Der Zwischenspeicher des Berichts unterscheidet nach Umgebung,
 *   eine Prüfung mit anderem PATH fragt also neu.
 *
 * PATH: aus der Dienstdatei des Bots, unter macOS
 * ~/Library/LaunchAgents/ai.tybo.telegram-relay.plist
 * (EnvironmentVariables.PATH), unter Linux die systemd-Benutzerdienstdatei
 * (Environment=PATH=…). Gibt es keine Dienstdatei (etwa PM2 oder Start von
 * Hand), gilt der PATH dieser Shell, die Zeile „PATH“ sagt das. Ist die
 * Datei da, aber nicht lesbar oder ohne PATH, ebenfalls der PATH dieser
 * Shell, mit Warnung. Der PATH selbst steht nie im Bericht. Denselben PATH
 * nimmt der ganze Bericht für Motor-Prüfungen (engineCheckPath, genutzt in
 * collectReport), damit „Voraussetzungen“ und „Motor“ sich nie widersprechen.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BRAND } from "../../brand";
import { BOT_SERVICE, launchdLabel, systemdUnitFile } from "../../lib/service-names";
import type { SetupContext } from "../context";
import { engineItem, SETUP_ENGINE_LABELS, setupEngine } from "../engine";
import { presentValue } from "../model";
import { CLAUDE_INSTALL, CLAUDE_INSTALL_WINDOWS } from "../steps/prerequisites";
import { claudeRunContext, type Finding, type SpecialCheck } from "./report";

type Env = Record<string, string>;

/** Zeitlimit je Claude-Befehl (wie checkEngine) */
const CLAUDE_TIMEOUT_MS = 5_000;
const LABEL = "Standard-Motor";
const PATH_LABEL = "PATH";

/** Woher der PATH der Prüfung kommt */
export type ServicePath =
  | { source: "launchd" | "systemd"; file: string; path: string }
  | { source: "shell"; reason: "missing" | "unreadable" | "no-path"; file?: string };

export interface ServicePathDeps {
  readFile(path: string): Promise<string>;
}

const realFs: ServicePathDeps = { readFile: path => readFile(path, "utf8") };

function unescapeXml(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

/**
 * PATH aus einer Plist im XML-Format, wie src/lib/services/plist.ts sie
 * schreibt: im Wörterbuch EnvironmentVariables der Text nach <key>PATH</key>.
 * null, wenn er fehlt (auch bei einer binären Plist).
 */
export function plistPath(xml: string): string | null {
  const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml);
  if (!env) return null;
  const path = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(env[1]);
  return path ? unescapeXml(path[1]) : null;
}

/** PATH aus einer systemd-Dienstdatei (Environment=PATH=… oder Environment="PATH=…"); die letzte Angabe gilt */
export function unitPath(text: string): string | null {
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*Environment\s*=\s*"?PATH=([^"\s]*)"?\s*$/.exec(line);
    if (m) found = m[1];
  }
  return found;
}

/** PATH des Bot-Diensts auf dieser Plattform, sonst der Grund, warum der PATH der Shell gilt */
export async function servicePath(ctx: Pick<SetupContext, "platform" | "launchAgentsDir" | "systemdUserDir">, fs: ServicePathDeps = realFs): Promise<ServicePath> {
  const kind = ctx.platform === "darwin" ? "launchd" : ctx.platform === "linux" ? "systemd" : null;
  if (!kind) return { source: "shell", reason: "missing" };
  const file = kind === "launchd" ? join(ctx.launchAgentsDir, `${launchdLabel(BOT_SERVICE)}.plist`) : join(ctx.systemdUserDir, systemdUnitFile(BOT_SERVICE));
  let text: string;
  try {
    text = await fs.readFile(file);
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { source: "shell", reason: "missing" } : { source: "shell", reason: "unreadable", file };
  }
  const path = kind === "launchd" ? plistPath(text) : unitPath(text);
  return path ? { source: kind, file, path } : { source: "shell", reason: "no-path", file };
}

/** PATH für alle Motor-Prüfungen des Berichts: der des Bot-Diensts, undefined heißt PATH dieser Shell */
export async function engineCheckPath(ctx: Pick<SetupContext, "platform" | "launchAgentsDir" | "systemdUserDir">, fs?: ServicePathDeps): Promise<string | undefined> {
  const sp = await servicePath(ctx, fs);
  return sp.source === "shell" ? undefined : sp.path;
}

function pathFinding(sp: ServicePath): Finding {
  const name = sp.file ? sp.file.split("/").pop() : undefined;
  if (sp.source !== "shell") return { label: PATH_LABEL, status: "pass", detail: `geprüft mit dem PATH aus ${name}` };
  if (sp.reason === "missing") return { label: PATH_LABEL, status: "skip", detail: "keine Dienstdatei des Bots (launchd, systemd), geprüft mit dem PATH dieser Shell" };
  const why = sp.reason === "unreadable" ? "ist nicht lesbar" : "nennt keinen PATH";
  return { label: PATH_LABEL, status: "warn", detail: `${name} ${why}, geprüft mit dem PATH dieser Shell. Neu schreiben: ${BRAND.cli} setup autostart` };
}

const SOURCE_TEXT = { settings: "aus config/settings.json", env: "aus TYBO_ENGINE in der .env", code: "ohne Einstellung" } as const;

/** Claude Code mit dem gegebenen PATH; Meldungen wie checkEngine("claude") */
async function claudeFinding(ctx: SetupContext, env: Env, path: string): Promise<Omit<Finding, "label">> {
  const check = await import("../../lib/engines/check");
  const { claudeAuthProblem } = await import("../../lib/engines/claude-auth");
  const claudePath = presentValue(env, "CLAUDE_PATH") ?? "claude";
  const run = claudeRunContext(ctx, env);
  const options = { cwd: run.cwd, env: { ...run.env, PATH: path }, timeoutMs: CLAUDE_TIMEOUT_MS };
  const install = ctx.platform === "win32" ? CLAUDE_INSTALL_WINDOWS : CLAUDE_INSTALL;

  const version = await ctx.run([claudePath, "--version"], options);
  if ((version.code === -1 && (version.spawnError === "ENOENT" || version.spawnError === "ENOTDIR")) || version.code === 127) {
    return { status: "fail", detail: `${check.CLAUDE_NOT_INSTALLED}. Abhilfe: ${install}` };
  }
  if (version.timedOut) return { status: "fail", detail: `Claude Code antwortet nicht: claude --version brauchte länger als ${CLAUDE_TIMEOUT_MS / 1000} s` };
  if (version.code === -1) return { status: "fail", detail: check.claudeStartFailedMessage(version.spawnError) };
  if (version.code !== 0) return { status: "fail", detail: `Claude Code startet nicht: claude --version endete mit Exit-Code ${version.code}. Abhilfe: ${install}` };
  const v = check.parseCodexVersion(version.stdout);
  const name = v ? `Claude Code ${v}` : "Claude Code";

  const authProblem = claudeAuthProblem(run.env);
  if (authProblem) return { status: "fail", detail: authProblem };
  const login = await ctx.run([claudePath, "auth", "status", "--json"], options);
  const loggedIn = login.timedOut ? undefined : check.parseClaudeLogin(login.stdout);
  if (loggedIn === true) return { status: "pass", detail: `${name} ist angemeldet` };
  if (loggedIn === false) return { status: "fail", detail: check.CLAUDE_NOT_LOGGED_IN };
  return { status: "fail", detail: claudeLoginUnknown(name, !!login.timedOut) };
}

/**
 * Anmeldung nicht prüfbar (Zeitlimit, unlesbare Ausgabe): Fehler, weil offen
 * ist, ob der Bot antwortet. Sagt, was passiert ist, ohne eine Abmeldung zu
 * behaupten, und was zu tun ist.
 */
export function claudeLoginUnknown(name: string, timedOut: boolean): string {
  const what = timedOut ? `brauchte länger als ${CLAUDE_TIMEOUT_MS / 1000} s` : "lieferte keine lesbare Antwort";
  // Kurz genug für die 300 Zeichen einer Berichtszeile
  return `${name}: Anmeldung nicht prüfbar, claude auth status --json ${what} (heißt nicht abgemeldet). Abhilfe: im Terminal \`claude auth status\`, ohne Anmeldung \`claude\` und /login, bei alter CLI \`claude update\``;
}

/** Zeilen des Abschnitts „Motor“: der Standard-Motor und woher der PATH kam */
export async function engineFindings(ctx: SetupContext, env: Env, fs?: ServicePathDeps): Promise<Finding[]> {
  const { engine, source } = await setupEngine(ctx);
  const sp = await servicePath(ctx, fs);
  const path = sp.source === "shell" ? (process.env.PATH ?? "") : sp.path;
  const label = `${LABEL} ${SETUP_ENGINE_LABELS[engine]} (${SOURCE_TEXT[source]})`;
  let line: Finding;
  if (engine === "claude") {
    line = { label, ...(await claudeFinding(ctx, env, path)) };
  } else {
    const item = await engineItem(ctx, engine, path);
    // Abhilfe anhängen, außer die Meldung nennt den Befehl schon (etwa „Installieren: npm install -g @openai/codex“)
    const fix = item.fix && !item.detail.includes(item.fix.split("  ")[0]) ? ` Abhilfe: ${item.fix}` : "";
    line = { label, status: item.ok ? "pass" : "fail", detail: item.ok ? item.detail : `${item.detail}${fix}` };
  }
  return [line, pathFinding(sp)];
}

export const engineCheck: SpecialCheck = {
  id: "motor",
  section: "Motor",
  run: ({ ctx, env }) => engineFindings(ctx, env),
};
