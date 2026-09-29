/**
 * Verfügbarkeit eines Motors (Entscheidung 0018, Issue #124).
 *
 * checkEngine("codex") prüft mit `codex --version`, ob Codex installiert ist,
 * und mit `codex login status` (Exit 0 = angemeldet), ob es angemeldet ist.
 * Jeder Befehl hat 5 s, danach wird er beendet. Das Ergebnis gilt 60 s;
 * gleichzeitige Anfragen teilen sich eine Prüfung. Beide Befehle laufen mit
 * derselben Umgebung wie der Motor (codexEnv, CODEX_PATH, CODEX_HOME), ohne
 * Projekt- oder Sandbox-Argumente. Ausgaben von `codex login status` gehen
 * nirgends hin, von `codex --version` nur die Versionsnummer.
 *
 * checkEngine("opencode") (Issue #128) prüft `opencode --version` (nur
 * Hauptversion 1, Entscheidung 0019) und `opencode auth list`: angemeldet
 * ist OpenCode mit mindestens einer gespeicherten Anmeldung oder einem
 * Anbieter-Schlüssel (OPENCODE_PROVIDER_KEYS) in der Umgebung, die OpenCode
 * wirklich bekommt (opencodeEnv, also gefiltert). Ob die Zugangsdaten
 * gelten, zeigt erst ein Lauf; meldet er „nicht angemeldet", verwirft
 * chat-turn.ts das Ergebnis (forgetEngineCheck). Zeitlimit und
 * Zwischenspeicher wie bei Codex; von `auth list` werden nur die Zahl und
 * die Namen der Anbieter gelesen.
 *
 * Angebunden wird die Prüfung mit der Motor-Wahl (#125) und der
 * Einstellungsseite (#126); die Claude-Prüfung beim Einrichten bleibt in
 * src/setup/steps/prerequisites.ts.
 *
 * inspectEngine (Issue #126) ist die Anzeige für Einstellungs- und
 * Statusseite: wie checkEngine, prüft aber auch Claude Code wirklich, mit
 * `claude --version` und `claude auth status --json`. Von der Anmeldung wird
 * nur das Feld loggedIn gelesen, Konto und E-Mail gehen nirgends hin. Die
 * Motor-Wahl nutzt weiter checkEngine: Claude Code bleibt der Motor, auf den
 * tybo zurückfällt, und wird dort nicht übersprungen.
 */

import { OPENCODE_PROVIDER_KEYS, subprocessEnv } from "../subprocess-env";
import { codexEnv, codexPath, codexRuntime, terminateCodexProcess } from "./codex";
import {
  forgetOpenCodeVersion,
  OPENCODE_NOT_INSTALLED,
  OPENCODE_NOT_LOGGED_IN,
  OPENCODE_VERSION_UNKNOWN,
  openCodeUnsupported,
  opencodeEnv,
  opencodePath,
  opencodeRuntime,
  parseOpenCodeVersion,
  terminateOpenCodeProcess,
} from "./opencode";
import type { EngineId } from "./types";

const IS_WINDOWS = process.platform === "win32";

/** Zeitlimit je Prüfbefehl */
export const ENGINE_CHECK_TIMEOUT_MS = 5_000;
/** So lange gilt ein Prüfergebnis */
export const ENGINE_CHECK_CACHE_MS = 60_000;

export interface EngineStatus {
  engine: EngineId;
  /** false: nicht geprüft (Claude Code, siehe checkEngine) */
  checked: boolean;
  installed: boolean;
  loggedIn: boolean;
  /** Versionsnummer, etwa „0.155.1" */
  version?: string;
  /** Verständliche Meldung, wenn der Motor nicht bereit ist */
  message?: string;
  /** Installiert, aber ob angemeldet, ließ sich nicht feststellen (loggedIn ist dann false); Claude nur in inspectEngine */
  loginUnknown?: true;
  /** Nur OpenCode: Anbieter mit gespeicherter Anmeldung laut `opencode auth list` (etwa „OpenRouter") */
  providers?: string[];
}

export const CODEX_NOT_INSTALLED =
  "Codex ist nicht installiert: der Befehl codex wurde nicht gefunden (anderer Pfad über CODEX_PATH in .env)";
export const CODEX_NOT_LOGGED_IN = "Codex ist nicht angemeldet: im Terminal `codex login` ausführen";

type Probe = { kind: "exit"; code: number | null; stdout: string } | { kind: "start_failed" } | { kind: "timeout" };

type ProbeCommand = "codex" | "claude" | "opencode";

/** Arbeitsverzeichnis der Prüfbefehle */
function checkCwd(): string {
  return process.env.GO_PROJECT_ROOT || process.cwd();
}

function commandPath(command: ProbeCommand): string {
  return command === "codex" ? codexPath() : command === "opencode" ? opencodePath() : claudePath();
}

function commandEnv(command: ProbeCommand, cwd: string): Record<string, string> {
  return command === "codex" ? codexEnv(cwd) : command === "opencode" ? opencodeEnv(cwd) : claudeCheckEnv(cwd);
}

/** Ein Prüfbefehl: Exit-Code und stdout, Startfehler oder Zeitlimit (dann beendet) */
async function probe(args: string[], command: ProbeCommand = "codex"): Promise<Probe> {
  const rt = command === "opencode" ? opencodeRuntime() : codexRuntime();
  const terminate = command === "opencode" ? terminateOpenCodeProcess : terminateCodexProcess;
  const cwd = checkCwd();
  let proc: ReturnType<typeof rt.spawn>;
  try {
    proc = rt.spawn({
      cmd: [commandPath(command), ...args],
      cwd,
      env: commandEnv(command, cwd),
      detached: !IS_WINDOWS,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { kind: "start_failed" };
  }
  // stderr lesen, damit eine volle Pipe nicht blockiert; der Inhalt wird verworfen
  void new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");
  const done = Promise.all([new Response(proc.stdout as ReadableStream<Uint8Array>).text().catch(() => ""), proc.exited.catch(() => null)]).then(
    ([stdout, code]): Probe => ({ kind: "exit", code, stdout })
  );
  let timer: unknown;
  const timeout = new Promise<Probe>((resolve) => {
    timer = rt.setTimeout(() => resolve({ kind: "timeout" }), ENGINE_CHECK_TIMEOUT_MS);
  });
  const result = await Promise.race([done, timeout]);
  rt.clearTimeout(timer);
  if (result.kind === "timeout") terminate(proc, rt);
  return result;
}

/** Versionsnummer aus `codex --version` (etwa „codex-cli 0.155.1"), sonst undefined */
export function parseCodexVersion(stdout: string): string | undefined {
  return /\b(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)\b/.exec(stdout.slice(0, 200))?.[1];
}

async function checkCodex(): Promise<EngineStatus> {
  const base = { engine: "codex" as const, checked: true };
  const version = await probe(["--version"]);
  if (version.kind === "start_failed") return { ...base, installed: false, loggedIn: false, message: CODEX_NOT_INSTALLED };
  if (version.kind === "timeout") {
    return {
      ...base,
      installed: false,
      loggedIn: false,
      message: `Codex antwortet nicht: codex --version brauchte länger als ${ENGINE_CHECK_TIMEOUT_MS / 1000} s`,
    };
  }
  if (version.code !== 0) {
    return {
      ...base,
      installed: false,
      loggedIn: false,
      message: version.code === 127 ? CODEX_NOT_INSTALLED : `Codex startet nicht: codex --version endete mit Exit-Code ${version.code}`,
    };
  }
  const v = parseCodexVersion(version.stdout);
  const installed = { ...base, installed: true, ...(v ? { version: v } : {}) };

  const login = await probe(["login", "status"]);
  if (login.kind === "exit" && login.code === 0) return { ...installed, loggedIn: true };
  if (login.kind === "exit") return { ...installed, loggedIn: false, message: CODEX_NOT_LOGGED_IN };
  return {
    ...installed,
    loggedIn: false,
    message:
      login.kind === "timeout"
        ? `Codex-Anmeldung nicht prüfbar: codex login status brauchte länger als ${ENGINE_CHECK_TIMEOUT_MS / 1000} s`
        : "Codex-Anmeldung nicht prüfbar: codex login status ließ sich nicht starten",
  };
}

// ---------------------------------------------------------------------------
// OpenCode (Issue #128)
// ---------------------------------------------------------------------------

/** Farben und Steuerzeichen aus Terminal-Ausgaben (ANSI CSI und OSC) */
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
/** Rahmen- und Aufzählungszeichen von @clack/prompts */
const FRAME = /^[\s│┌└├●◆◇○◒◐◓◑▲■□✔✖⚠•*|-]+/u;
/** Art einer Anmeldung am Zeilenende von `auth list` */
const AUTH_TYPE = /\s+(api|oauth|wellknown)\s*$/i;
/** Anzeigename eines Anbieters: nur harmlose Zeichen */
const PROVIDER_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .()_\/-]{0,59}$/u;

export interface OpenCodeAuthList {
  /** Zahl der gespeicherten Anmeldungen (Schlusszeile „N credentials") */
  count: number;
  /** Anbieter der gespeicherten Anmeldungen, ohne Art (api, oauth) */
  providers: string[];
}

/**
 * Liest die Ausgabe von `opencode auth list` (V1): Kopfzeile
 * „Credentials <pfad>", je Anmeldung „<Anbieter> <art>", Schlusszeile
 * „N credentials". Der Abschnitt „Environment" danach zählt nicht (tybo
 * prüft die Umgebung selbst). Farben und Rahmenzeichen werden entfernt.
 * null, wenn keine Schlusszeile erkennbar ist.
 */
export function parseOpenCodeAuthList(stdout: string): OpenCodeAuthList | null {
  const lines = stdout
    .slice(0, 20_000)
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((l) => l.replace(FRAME, "").trim());
  const start = lines.findIndex((l) => /^credentials\b/i.test(l));
  const endRel = lines.slice(start + 1).findIndex((l) => /^\d+\s+credentials?\b/i.test(l));
  if (endRel < 0) return null;
  const end = start + 1 + endRel;
  const count = Number(/^(\d+)/.exec(lines[end])![1]);
  const providers: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    if (!AUTH_TYPE.test(line)) continue;
    const name = line.replace(AUTH_TYPE, "").trim();
    if (PROVIDER_NAME.test(name) && !providers.includes(name) && providers.length < 20) providers.push(name);
  }
  return { count, providers };
}

/** Anbieter-Schlüssel, die OpenCode in seiner (gefilterten) Umgebung wirklich bekommt */
export function openCodeProviderKeysIn(env: Record<string, string>): string[] {
  return OPENCODE_PROVIDER_KEYS.filter((k) => (env[k] ?? "").trim() !== "");
}

const OPENCODE_TIMEOUT_TEXT = `länger als ${ENGINE_CHECK_TIMEOUT_MS / 1000} s`;

async function checkOpenCode(): Promise<EngineStatus> {
  const base = { engine: "opencode" as const, checked: true };
  const version = await probe(["--version"], "opencode");
  if (version.kind === "start_failed" || (version.kind === "exit" && version.code === 127)) {
    return { ...base, installed: false, loggedIn: false, message: OPENCODE_NOT_INSTALLED };
  }
  if (version.kind === "timeout") {
    return { ...base, installed: false, loggedIn: false, message: `OpenCode antwortet nicht: opencode --version brauchte ${OPENCODE_TIMEOUT_TEXT}` };
  }
  if (version.code !== 0) {
    return { ...base, installed: false, loggedIn: false, message: `OpenCode startet nicht: opencode --version endete mit Exit-Code ${version.code}` };
  }
  const parsed = parseOpenCodeVersion(version.stdout.slice(0, 200));
  if (!parsed) return { ...base, installed: false, loggedIn: false, message: OPENCODE_VERSION_UNKNOWN };
  if (parsed.major !== 1) {
    return { ...base, installed: false, loggedIn: false, version: parsed.version, message: openCodeUnsupported(parsed) };
  }
  const installed = { ...base, installed: true, version: parsed.version };

  const envKeys = openCodeProviderKeysIn(opencodeEnv(checkCwd()));
  const login = await probe(["auth", "list"], "opencode");
  const list = login.kind === "exit" && login.code === 0 ? parseOpenCodeAuthList(login.stdout) : null;
  const providers = list && list.providers.length ? { providers: list.providers } : {};
  if ((list && list.count > 0) || envKeys.length > 0) return { ...installed, loggedIn: true, ...providers };
  if (list) return { ...installed, loggedIn: false, message: OPENCODE_NOT_LOGGED_IN };
  const why =
    login.kind === "timeout"
      ? `opencode auth list brauchte ${OPENCODE_TIMEOUT_TEXT}`
      : login.kind === "start_failed"
        ? "opencode auth list ließ sich nicht starten"
        : login.code !== 0
          ? `opencode auth list endete mit Exit-Code ${login.code}`
          : "Ausgabe von opencode auth list nicht erkennbar";
  return { ...installed, loggedIn: false, loginUnknown: true, message: `OpenCode-Anmeldung nicht prüfbar: ${why}` };
}

let cache: { key: string; at: number; result: Promise<EngineStatus> } | undefined;
let claudeCache: { key: string; at: number; result: Promise<EngineStatus> } | undefined;
let opencodeCache: { key: string; at: number; result: Promise<EngineStatus> } | undefined;

/** Nur für Tests: Zwischenspeicher leeren */
export function resetEngineCheckCacheForTests(): void {
  cache = undefined;
  claudeCache = undefined;
  opencodeCache = undefined;
}

/**
 * Prüfergebnis verwerfen (Issue #125): ein Lauf hat „nicht angemeldet" oder
 * „nicht installiert" gemeldet, obwohl die letzte Prüfung bereit sagte. Die
 * nächste Anfrage prüft neu statt 60 s dem alten Ergebnis zu glauben. Gilt
 * für Codex und OpenCode, bei OpenCode auch für die Versionsprüfung vor dem
 * Lauf.
 */
export function forgetEngineCheck(): void {
  cache = undefined;
  opencodeCache = undefined;
  forgetOpenCodeVersion();
}

/**
 * Ist der Motor installiert und angemeldet? Codex und OpenCode werden
 * geprüft (siehe oben). Claude Code wird hier nicht geprüft (checked: false)
 * und gilt als bereit: es ist der Motor, auf den tybo zurückfällt.
 */
export async function checkEngine(id: EngineId): Promise<EngineStatus> {
  if (id === "claude") return { engine: "claude", checked: false, installed: true, loggedIn: true };
  if (id === "opencode") {
    const now = opencodeRuntime().now();
    const key = `${opencodePath()}\0${process.env.XDG_DATA_HOME ?? ""}\0${process.env.TYBO_SUBPROCESS_ENV_ALLOW ?? ""}`;
    if (opencodeCache && opencodeCache.key === key && now - opencodeCache.at < ENGINE_CHECK_CACHE_MS) return opencodeCache.result;
    const result = checkOpenCode().catch(
      (): EngineStatus => ({ engine: "opencode", checked: true, installed: false, loggedIn: false, message: "OpenCode ließ sich nicht prüfen" })
    );
    opencodeCache = { key, at: now, result };
    return result;
  }
  const now = codexRuntime().now();
  const key = `${codexPath()}\0${process.env.CODEX_HOME ?? ""}`;
  if (cache && cache.key === key && now - cache.at < ENGINE_CHECK_CACHE_MS) return cache.result;
  const result = checkCodex().catch(
    (): EngineStatus => ({ engine: "codex", checked: true, installed: false, loggedIn: false, message: "Codex ließ sich nicht prüfen" })
  );
  cache = { key, at: now, result };
  return result;
}

// ---------------------------------------------------------------------------
// Anzeige für Einstellungen und Status (Issue #126)
// ---------------------------------------------------------------------------

export const CLAUDE_NOT_INSTALLED =
  "Claude Code ist nicht installiert: der Befehl claude wurde nicht gefunden (anderer Pfad über CLAUDE_PATH in .env)";
export const CLAUDE_NOT_LOGGED_IN = "Claude Code ist nicht angemeldet: im Terminal `claude` starten und /login ausführen";
export const CLAUDE_LOGIN_UNKNOWN = "Ob Claude Code angemeldet ist, ließ sich nicht feststellen (im Terminal `claude auth status`)";

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";

/** Wie CLAUDE_PATH in src/lib/claude.ts */
function claudePath(): string {
  return process.env.CLAUDE_PATH || "claude";
}

/** Umgebung wie beim Claude-Aufruf in src/lib/claude.ts: gefiltert, dazu HOME, PATH und ein API-Schlüssel */
function claudeCheckEnv(cwd: string): Record<string, string> {
  return {
    ...subprocessEnv({ cwd, home: HOME_DIR }),
    HOME: HOME_DIR,
    PATH: process.env.PATH || "",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  };
}

/**
 * loggedIn aus `claude auth status --json`; alle anderen Felder (Konto,
 * E-Mail, Organisation) werden nicht gelesen. undefined, wenn die Ausgabe
 * kein JSON mit loggedIn ist.
 */
export function parseClaudeLogin(stdout: string): boolean | undefined {
  try {
    const value = JSON.parse(stdout.slice(0, 20_000))?.loggedIn;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function checkClaude(): Promise<EngineStatus> {
  const base = { engine: "claude" as const, checked: true };
  const version = await probe(["--version"], "claude");
  if (version.kind === "start_failed" || (version.kind === "exit" && version.code === 127)) {
    return { ...base, installed: false, loggedIn: false, message: CLAUDE_NOT_INSTALLED };
  }
  if (version.kind === "timeout") {
    return {
      ...base,
      installed: false,
      loggedIn: false,
      message: `Claude Code antwortet nicht: claude --version brauchte länger als ${ENGINE_CHECK_TIMEOUT_MS / 1000} s`,
    };
  }
  if (version.code !== 0) {
    return { ...base, installed: false, loggedIn: false, message: `Claude Code startet nicht: claude --version endete mit Exit-Code ${version.code}` };
  }
  const v = parseCodexVersion(version.stdout);
  const installed = { ...base, installed: true, ...(v ? { version: v } : {}) };

  const login = await probe(["auth", "status", "--json"], "claude");
  const loggedIn = login.kind === "exit" ? parseClaudeLogin(login.stdout) : undefined;
  if (loggedIn === true) return { ...installed, loggedIn: true };
  if (loggedIn === false) return { ...installed, loggedIn: false, message: CLAUDE_NOT_LOGGED_IN };
  return { ...installed, loggedIn: false, loginUnknown: true, message: CLAUDE_LOGIN_UNKNOWN };
}

/**
 * Verfügbarkeit für die Anzeige (Einstellungs- und Statusseite): Claude Code
 * wird wirklich geprüft (siehe oben, 5 s je Befehl, Ergebnis gilt 60 s),
 * die übrigen Motoren wie checkEngine.
 */
export async function inspectEngine(id: EngineId): Promise<EngineStatus> {
  if (id !== "claude") return checkEngine(id);
  const now = codexRuntime().now();
  const key = claudePath();
  if (claudeCache && claudeCache.key === key && now - claudeCache.at < ENGINE_CHECK_CACHE_MS) return claudeCache.result;
  const result = checkClaude().catch(
    (): EngineStatus => ({ engine: "claude", checked: true, installed: false, loggedIn: false, message: "Claude Code ließ sich nicht prüfen" })
  );
  claudeCache = { key, at: now, result };
  return result;
}
