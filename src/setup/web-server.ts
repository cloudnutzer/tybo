/**
 * Server des Einrichtungsmodus (Issue #66, Entscheidung 0011): der Assistent
 * aus src/setup/steps.ts im Browser.
 *
 * Schutzregeln:
 * - Lauscht immer nur auf 127.0.0.1, egal was in WEB_HOST steht. Der
 *   Host-Header muss 127.0.0.1 oder localhost mit genau diesem Port sein,
 *   sonst 421 (Schutz gegen DNS-Rebinding). Andere Namen des Rechners, ::1
 *   und WEB_ALLOWED_HOSTS gelten hier bewusst nicht.
 * - Nie über den Cloudflare Tunnel (Issue #99, Entscheidung 0014): Anfragen
 *   mit Tunnel-Kopfzeilen (hasTunnelHeaders) enden vor allem anderen mit 403,
 *   auch mit lokalem Host-Header, gültigem Code oder Cookie und unabhängig
 *   davon, ob WEB_PUBLIC_ORIGIN gesetzt ist. cloudflared verbindet sich von
 *   127.0.0.1, die Verbindungsadresse allein unterscheidet also nicht.
 * - Zugang mit einem Einmal-Code (8 Zeichen, src/setup/web-mode.ts). Nach
 *   richtiger Eingabe ein eigenes Sitzungs-Cookie (HttpOnly, SameSite=Strict,
 *   nur für diese Browsersitzung). Falsche Codes bremst dieselbe Sperre wie
 *   beim Login (10 Fehlversuche in 15 Minuten, dann 429).
 * - Schreibende Anfragen brauchen denselben Origin wie der Host, sonst 403.
 * - Nach „Fertig“ gelten weder der Code noch bestehende Sitzungen.
 * - Werte gehen nie zurück an die Oberfläche: Schritte liefern nur „gesetzt“
 *   oder „nicht gesetzt“, Meldungen laufen zusätzlich durch redactKnown() mit
 *   allen eingetragenen Werten (geheim oder Text, bei Adressen auch der
 *   Hostname), ohne Mindestlänge: auch ein Modellname wie „phi“ bleibt draußen.
 * - Angenommen werden nur die Felder des jeweiligen Schritts. Darüber dürfen
 *   hier TELEGRAM_* und WEB_* gesetzt werden (Ausnahme zu M6); die normale
 *   Schlüssel-API der WebUI sperrt sie weiter (src/web/key-catalog.ts).
 * - Kein Claude-Aufruf: der Probeaufruf der Claude CLI ist ersetzt
 *   (ctx.noModelCalls, noModelProviders). Autostart schreibt nicht über „Speichern“, sondern
 *   erst bei „Fertig“, wenn dieser Server schon zu ist (web-mode.ts).
 *
 * Abläufe und geladene Auswahlen (Issue #161), gleiche Schutzregeln:
 * - POST /api/setup/steps/<id>/choices/<feld> lädt eine Auswahl vom Anbieter.
 *   Der Server merkt sie sich je Sitzung, Schritt und Feld, gebunden an einen
 *   Hash der wirksamen Werte davor (choicesKey, eingegeben oder gespeichert);
 *   ein neuer Ladeversuch verwirft die alte Liste, eine verspätete Antwort
 *   ersetzt keine neuere. Test, Speichern und Ablauf prüfen eine Auswahl
 *   gegen diese Liste, auch eine schon gespeicherte.
 * - POST /api/setup/steps/<id>/view: Sichtbarkeit, Modus und Plan aus einem
 *   aufgelösten Feldstand; geheime und transiente Felder schickt die
 *   Oberfläche nur als Namen in present („eingegeben“), nie als Wert.
 * - POST /api/setup/steps/<id>/run startet den Ablauf im Hintergrund (202
 *   mit runId); der Server prüft Modus (runWhen) und Eingaben dabei selbst
 *   noch einmal. Nur einer zur Zeit (sonst 409). Geprüft und reserviert wird
 *   in der Warteschlange, damit Speichern und „Fertig“ davor oder danach
 *   liegen, nie mittendrin; der Ablauf selbst läuft außerhalb, nur sein
 *   Schreiben (writeEnv über ctx.writeLock) geht durch die Warteschlange.
 * - GET /api/setup/runs/<id> liefert Zustand, Fortschritt und Ergebnis,
 *   geschwärzt schon beim Speichern (Meldung, Fortschritt und geänderte
 *   Namen); POST /api/setup/runs/<id>/abbrechen löst
 *   das signal aus. Solange ein Ablauf läuft, lehnen Speichern und „Fertig“
 *   mit 409 ab. Transiente Werte leben nur im laufenden Aufruf von run().
 *
 * Importiert src/bot.ts nicht.
 */

import { BRAND_SCRIPT_PATH, brandHtmlResponse, brandScriptResponse } from "../web/brand-asset";
import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BRAND } from "../brand";
import { supervisorName, type Supervisor } from "../lib/restart-request";
import { hashToken, hasTunnelHeaders, isSameOrigin, LoginLimiter, parseHostHeader, passwordMatches } from "../web/auth";
import { MAX_ENV_VALUE_LENGTH } from "../web/env-rules";
import { SECURITY_HEADERS } from "../web/server";
import { readSetupEnv, type SetupContext } from "./context";
import {
  choicesKey,
  containsValue,
  enteredValues,
  maskStandalone,
  presentValue,
  registerTransientFields,
  resolveValues,
  runsAsFlow,
  validateValues,
  valuesBefore,
  type ApplyResult,
  type FieldChoice,
  type LoadedChoices,
  type RunEvent,
  type SetupField,
  type SetupStep,
  type SetupValues,
  type StepId,
} from "./model";
import type { Providers } from "./providers";
import { existingFieldValues, SETUP_STEPS } from "./steps";
import { waitForEnvWrites } from "./steps/common";
import { AUTOSTART_MANAGERS, autostartPlan, autostartStep, MANAGER_LABEL, type AutostartManager } from "./steps/autostart";
import { CLAUDE_LOGIN_NOT_CHECKED } from "./steps/prerequisites";

export const SETUP_COOKIE = "tybo_setup";
export const SETUP_HOST = "127.0.0.1";
export const SETUP_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
export const SETUP_TUNNEL_TEXT = "Die Einrichtung geht nur direkt an diesem Rechner, nicht über den Tunnel.";

export const SETUP_PUBLIC_DIR = join(import.meta.dir, "public");
const WEB_PUBLIC_DIR = join(import.meta.dir, "..", "web", "public");

/** Gut abtippbar: ohne 0/O, 1/I/L (31 Zeichen, knapp 40 Bit bei 8 Stellen) */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;

/** Neuer Einmal-Code, 8 Zeichen aus CODE_ALPHABET, ohne Verzerrung (Bytes ab 248 verworfen) */
export function generateSetupCode(): string {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const b of randomBytes(16)) {
      if (b < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

/** Zum Anzeigen: ABCD-EFGH */
export function formatSetupCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Eingabe vergleichbar machen: Groß, ohne Leerzeichen und Bindestriche */
export function normalizeSetupCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

/** Nur 127.0.0.1 oder localhost, und nur mit dem Port dieses Servers */
export function isSetupHost(host: string | null | undefined, port: number): boolean {
  if (!host) return false;
  const parsed = parseHostHeader(host);
  if (!parsed) return false;
  if ((parsed.port ?? 80) !== port) return false;
  return parsed.name === "127.0.0.1" || parsed.name === "localhost";
}

/**
 * „Kein Claude-Aufruf“ im Einrichtungsmodus: ctx.noModelCalls lässt den
 * Probeaufruf in „voraussetzungen“ (und damit in der Gesamtprüfung) weg.
 * Zur Sicherheit ist der Probeaufruf zusätzlich ersetzt; käme er doch, gälte
 * er als nicht bestanden, nie als angemeldet.
 */
export function noModelProviders(providers: Providers): Providers {
  return { ...providers, claudeProbe: async () => ({ ok: false, message: CLAUDE_LOGIN_NOT_CHECKED }) };
}

/** Was nach „Fertig“ passiert */
export type FinishPlan =
  | { kind: "restart"; supervisor: Supervisor; message: string }
  | { kind: "autostart"; message: string; manager?: AutostartManager }
  | { kind: "manual"; command: string; message: string };

export interface SetupServerOptions {
  ctx: SetupContext;
  /** Einmal-Code, unformatiert (8 Zeichen) */
  code: string;
  /** Standard 3100 aus WEB_PORT; 0 in Tests (freier Port) */
  port: number;
  /** Läuft dieser Prozess unter launchd, PM2 oder systemd? (bot.ts: detectSupervisor, tybo: nie) */
  supervisor(): Promise<Supervisor | null>;
  /** Startbefehl ohne Supervisor */
  startCommand: string;
  log?(line: string): void;
  now?(): number;
  limiter?: LoginLimiter;
  publicDir?: string;
  webPublicDir?: string;
  /** Nur für Tests: eigener Schrittkatalog (Standard: SETUP_STEPS) */
  steps?: readonly SetupStep[];
}

export type RunState = "laeuft" | "fertig" | "fehler" | "abgebrochen";

/** Höchstens so viele Fortschrittszeilen je Ablauf (die ältesten fallen weg) */
const MAX_RUN_EVENTS = 200;
/** Beendete Abläufe, die sich noch abfragen lassen */
const MAX_KEPT_RUNS = 20;

export interface SetupServer {
  url: string;
  port: number;
  /** Erfüllt, sobald „Fertig“ angenommen ist (Antwort ist dann schon unterwegs) */
  finished: Promise<FinishPlan>;
  isFinished(): boolean;
  /** Nur für Tests: Anfragen in der Warteschlange (laufend und wartend) */
  queued(): number;
  /**
   * Bricht einen laufenden Ablauf ab und wartet höchstens graceMs auf sein
   * Ende (web-mode.ts bei Strg+C). "frist": er hat nicht aufgehört.
   */
  cancelRuns(graceMs: number): Promise<"keiner" | "beendet" | "frist">;
  /** Schritt des laufenden Ablaufs oder null */
  runningStep(): StepId | null;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Antworten
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Feste Liste statt Verzeichnis: Pfad → [Ordner, Datei] */
function assetTable(setupDir: string, webDir: string): Record<string, [string, string]> {
  return {
    "/code": [setupDir, "setup-code.html"],
    "/setup-code.js": [setupDir, "setup-code.js"],
    "/setup.js": [setupDir, "setup.js"],
    "/style.css": [webDir, "style.css"],
    "/theme.js": [webDir, "theme.js"],
    "/favicon.svg": [webDir, "favicon.svg"],
    "/apple-touch-icon.png": [webDir, "apple-touch-icon.png"],
  };
}

async function serveFrom(dir: string, name: string): Promise<Response> {
  const root = await realpath(dir).catch(() => null);
  const file = root ? await realpath(resolve(root, name)).catch(() => null) : null;
  if (!root || !file || !file.startsWith(root + sep) || !(await stat(file).catch(() => null))?.isFile()) {
    return text("Nicht gefunden", 404);
  }
  // Name aus src/brand.ts in Titel und Wortmarke (Issue #100)
  if (extname(file) === ".html") return brandHtmlResponse(file);
  return new Response(Bun.file(file), { headers: { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" } });
}

class BodyTooLarge extends Error {}

async function readLimitedText(req: Request): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size <= MAX_BODY_BYTES) chunks.push(value);
  }
  if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
  return Buffer.concat(chunks).toString("utf8");
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function sessionCookie(token: string, clear = false): string {
  // Ohne Max-Age: gilt nur, solange der Browser offen ist
  return `${SETUP_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${clear ? "; Max-Age=0" : ""}`;
}

// ---------------------------------------------------------------------------
// Schritte als JSON (nur Metadaten, nie Werte)
// ---------------------------------------------------------------------------

const HIDDEN_STEP_FIELDS = new Set(["visible", "validate", "choicesFrom"]);

/** Merker für „eingegeben, aber geheim“: nur für visible, runWhen und plan in view */
const SET_MARK = "\u0000gesetzt";

/** Vorhandene Werte des Schritts (nur intern), wie im Terminal */
const visibilityBase = existingFieldValues;

function fieldJson(field: SetupField, visible: boolean, set: boolean) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field)) if (!HIDDEN_STEP_FIELDS.has(k)) out[k] = v;
  if (field.choicesFrom) out.loadChoices = true;
  // Transiente Felder gelten nie als gesetzt
  return { ...out, visible, set: set && !field.transient };
}

/**
 * Eingaben für view: Auswahl, Ja/Nein und Text; geheime und transiente nur
 * als „eingegeben“ (die Oberfläche schickt dafür nur den Namen in present,
 * nie den Wert)
 */
function viewInputs(step: SetupStep, values: SetupValues, present: Set<string>): SetupValues {
  const entered = enteredValues(values);
  const out: SetupValues = {};
  for (const f of step.fields) {
    const hidden = f.kind === "secret" || !!f.transient;
    if (hidden) {
      if (entered[f.name] !== undefined || present.has(f.name)) out[f.name] = SET_MARK;
    } else if (entered[f.name] !== undefined) out[f.name] = entered[f.name];
  }
  return out;
}

/** present aus dem Rumpf von view: Namen geheimer oder transienter Felder mit Eingabe */
function parsePresent(step: SetupStep, body: string): Set<string> {
  const out = new Set<string>();
  let raw: unknown;
  try {
    raw = body ? (JSON.parse(body) as Record<string, unknown>).present : undefined;
  } catch {
    return out;
  }
  if (!Array.isArray(raw)) return out;
  for (const name of raw) {
    const f = step.fields.find(x => x.name === name);
    if (f && (f.kind === "secret" || f.transient)) out.add(f.name);
  }
  return out;
}

/** Rohe Eingaben plus Standardwerte (die Eingaben selbst bleiben unverändert) */
function withDefaults(step: SetupStep, values: SetupValues, base: SetupValues): SetupValues {
  const resolved = resolveValues(step.fields, values, base);
  const out: SetupValues = { ...values };
  for (const [k, v] of Object.entries(resolved)) if (!out[k]?.trim()) out[k] = v;
  return out;
}

/**
 * Felder, Modus und Plan zu einem Eingabestand. Sichtbarkeit, Standardwerte,
 * runWhen und plan werten denselben aufgelösten Stand aus: vorhandene Werte,
 * überlagert von Auswahl, Ja/Nein, Text und „eingegeben“ bei geheimen und
 * transienten Feldern, dazu Standardwerte. Der Server prüft den Modus beim
 * Start noch einmal mit allen Eingaben.
 */
async function viewJson(step: SetupStep, ctx: SetupContext, setNames: Set<string>, inputs: SetupValues, clean: (s: string) => string, present = new Set<string>()) {
  const base = await visibilityBase(step, ctx);
  const merged = { ...base, ...resolveValues(step.fields, viewInputs(step, inputs, present), base) };
  const fields = step.fields.map(f => fieldJson(f, f.visible ? f.visible(merged) : true, setNames.has(f.name)));
  const flow = runsAsFlow(step, merged);
  return {
    fields,
    mode: flow ? ("ablauf" as const) : ("felder" as const),
    plan: flow ? (step.plan?.(merged) ?? []).map(clean) : [],
  };
}

/** Ein Wert und, bei http(s)-Adressen, auch Origin und Hostname (Fehlertexte nennen oft nur diese) */
function valueForms(value: string): string[] {
  const out = [value];
  const trimmed = value.trim();
  if (trimmed !== value) out.push(trimmed);
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") out.push(url.href, url.origin, url.host, url.hostname);
  } catch {
    // keine Adresse
  }
  return out;
}

/**
 * Alle eingetragenen Werte (gespeichert oder eingegeben), die in einer Meldung
 * nie vorkommen dürfen: geheime und freie Textfelder. Auswahl- und
 * Ja/Nein-Felder stammen aus festen Listen und bleiben lesbar. Gespeichert
 * heißt .env und, wo ein Schritt woanders speichert (config/settings.json),
 * auch dort.
 */
async function knownValues(ctx: SetupContext, step: SetupStep, entered: SetupValues, catalog: readonly SetupStep[] = SETUP_STEPS): Promise<string[]> {
  const env = await readSetupEnv(ctx);
  const out: string[] = [];
  // Transiente Werte zählen wie geheime, auch bei Auswahlfeldern (Issue #161)
  const redacted = (f: SetupField) => f.kind === "secret" || f.kind === "text" || !!f.transient;
  // Ein Wert gleich dem Standard aus dem Code ist nichts Eingetragenes (sonst verschwände etwa „tybo“ aus jedem Befehl)
  const own = (f: SetupField, v: string | undefined) => !!v && !(f.kind === "text" && f.default !== undefined && v.trim() === f.default);
  for (const s of catalog) {
    const elsewhere = s.savedValues ? await s.savedValues(ctx).catch(() => ({}) as SetupValues) : {};
    for (const f of s.fields) {
      if (!redacted(f)) continue;
      for (const saved of [presentValue(env, f.name), elsewhere[f.name]]) if (own(f, saved)) out.push(...valueForms(saved!));
    }
  }
  for (const f of step.fields) if (redacted(f) && own(f, entered[f.name])) out.push(...valueForms(entered[f.name]));
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

export const REDACTED_MESSAGE = "Meldung ausgeblendet, sie enthielt einen eingetragenen Wert.";
export const REDACTED_NAME = "(Name ausgeblendet, er enthielt einen eingetragenen Wert)";

/**
 * Wie redact() aus model.ts, aber ohne dessen Mindestlänge von vier Zeichen
 * (maskValues: kurze Werte nur, wo sie für sich stehen). Steckt danach noch
 * einer irgendwo im Text, gilt die ganze Meldung als wertführend und wird
 * durch einen festen Text ersetzt. Gekürzt wird erst danach, damit kein
 * Wertanfang am Schnitt stehen bleibt.
 */
export function redactKnown(text: string, values: string[], max = 600): string {
  let out = maskStandalone(text, values);
  if (containsValue(out, values)) return REDACTED_MESSAGE;
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** Wie redactKnown() für geänderte Namen und Pfade eines Ablaufs */
function cleanName(name: string, values: string[]): string {
  const out = redactKnown(name, values, 200);
  return out === REDACTED_MESSAGE ? REDACTED_NAME : out;
}

const STEP_PATH = /^\/api\/setup\/steps\/([a-z]+)(?:\/(view|test|apply|run)|\/choices\/([A-Za-z0-9_]{1,64}))?$/;
const RUN_PATH = /^\/api\/setup\/runs\/([A-Za-z0-9_-]{1,64})(?:\/(abbrechen))?$/;

export const RUN_ACTIVE_TEXT = "Ein Ablauf läuft noch";

type ParsedValues = { ok: true; values: SetupValues } | { ok: false; error: string };

/** {values: {...}}: nur Felder dieses Schritts, nur Text */
function parseValues(step: SetupStep, body: string): ParsedValues {
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    return { ok: false, error: "Ungültige Anfrage" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: "Ungültige Anfrage" };
  const raw = (parsed as Record<string, unknown>).values ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Ungültige Anfrage" };
  const names = new Set(step.fields.map(f => f.name));
  const values: SetupValues = {};
  for (const [name, value] of Object.entries(raw)) {
    // Nie den Namen oder Wert zurückgeben: nur „unbekannt“
    if (!names.has(name)) return { ok: false, error: "Unbekanntes Feld für diesen Schritt" };
    if (typeof value !== "string") return { ok: false, error: "Werte müssen Text sein" };
    if (value.length > MAX_ENV_VALUE_LENGTH) return { ok: false, error: `Ein Wert ist länger als ${MAX_ENV_VALUE_LENGTH} Zeichen` };
    values[name] = value;
  }
  return { ok: true, values };
}

interface RunRecord {
  id: string;
  stepId: StepId;
  state: RunState;
  /** Schon geschwärzt */
  events: RunEvent[];
  result?: { ok: boolean; message: string; changed: string[] };
  controller: AbortController;
  done: Promise<void>;
}

interface LoadedList {
  key: string;
  choices: FieldChoice[];
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function createSetupServer(options: SetupServerOptions): Promise<SetupServer> {
  const ctx: SetupContext = { ...options.ctx, noModelCalls: true, providers: noModelProviders(options.ctx.providers) };
  const log = options.log ?? ((line: string) => console.log(`[setup] ${line}`));
  const now = options.now ?? Date.now;
  const limiter = options.limiter ?? new LoginLimiter({ now });
  const assets = assetTable(options.publicDir ?? SETUP_PUBLIC_DIR, options.webPublicDir ?? WEB_PUBLIC_DIR);
  const setupDir = options.publicDir ?? SETUP_PUBLIC_DIR;
  const code = normalizeSetupCode(options.code);
  if (code.length !== CODE_LENGTH) throw new Error("Einmal-Code hat nicht 8 Zeichen");

  const catalog = options.steps ?? SETUP_STEPS;
  registerTransientFields(catalog);
  const findStep = (id: string) => catalog.find(s => s.id === id);
  /** Pflichtschritte, die vor „Fertig“ erledigt sein müssen (Autostart kommt bei Fertig) */
  const FINISH_REQUIRED = catalog.filter(s => !s.optional && s.id !== "pruefung" && s.id !== "autostart");

  const sessions = new Map<string, number>();
  /** Geladene Auswahlen: Sitzung, Schritt, Feld → Liste mit Eingabe-Hash */
  const loadedLists = new Map<string, LoadedList>();
  /** Jüngster Ladeversuch je Sitzung, Schritt, Feld; ältere Antworten werden nicht gespeichert */
  const loadSeq = new Map<string, number>();
  let seqCounter = 0;
  const runs = new Map<string, RunRecord>();
  let activeRun: RunRecord | null = null;
  let finishedPlan: FinishPlan | null = null;
  let resolveFinished!: (plan: FinishPlan) => void;
  const finished = new Promise<FinishPlan>(r => (resolveFinished = r));
  let port = options.port;

  // Test, Speichern und Fertig nacheinander, nie gleichzeitig
  let chain: Promise<unknown> = Promise.resolve();
  let queued = 0;
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    queued++;
    const next = chain.then(fn, fn).finally(() => queued--);
    chain = next.catch(() => {});
    return next;
  }

  /** Hash der gültigen Sitzung oder null */
  function validSession(token: string | null): string | null {
    if (finishedPlan || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = hashToken(token);
    const expires = sessions.get(hash);
    if (expires === undefined) return null;
    if (expires <= now()) {
      sessions.delete(hash);
      return null;
    }
    return hash;
  }

  const listKey = (session: string, step: SetupStep, field: string) => `${session}\0${step.id}\0${field}`;

  /**
   * Geladene Listen, die zu den wirksamen Werten passen (vorhandene plus
   * Eingaben und Standards); veraltete zählen als nicht geladen, auch nach
   * einem gespeicherten Tokenwechsel
   */
  function loadedFor(session: string, step: SetupStep, effective: SetupValues): LoadedChoices {
    const out: LoadedChoices = {};
    for (const f of step.fields) {
      if (!f.choicesFrom) continue;
      const entry = loadedLists.get(listKey(session, step, f.name));
      if (entry && entry.key === choicesKey(step.fields, f.name, effective)) out[f.name] = entry.choices;
    }
    return out;
  }

  /** Fehler nur der Felder mit geladener Auswahl (Test und Speichern prüfen den Rest wie bisher selbst) */
  function choiceErrors(session: string, step: SetupStep, values: SetupValues, base: SetupValues): string | null {
    if (!step.fields.some(f => f.choicesFrom)) return null;
    const effective = { ...base, ...resolveValues(step.fields, values, base) };
    const errors = validateValues(step.fields, values, base, loadedFor(session, step, effective));
    const list = step.fields.filter(f => f.choicesFrom && errors[f.name]).map(f => errors[f.name]);
    return list.length ? list.join("; ") : null;
  }

  /** Dateipfade relativ zum Projekt; Variablennamen bleiben, wie sie sind */
  function relativePath(p: string): string {
    if (!isAbsolute(p)) return p;
    const rel = relative(ctx.root, p);
    return rel && !rel.startsWith("..") ? rel : p;
  }

  /**
   * Weg des Autostarts für „Fertig“ (Issue #207), solange er fehlt: wählbare
   * Wege mit Standard (null: nur ausdrücklich), dazu ein Hinweis, warum
   * systemd fehlt oder nichts geht. null, wenn es nichts zu wählen gibt.
   */
  async function autostartChoice(state: string | undefined) {
    if (state === "erledigt") return null;
    const plan = await autostartPlan(ctx);
    return {
      choices: plan.managers.map(m => ({ value: m, label: MANAGER_LABEL[m] })),
      default: plan.default,
      note: plan.blocked ?? plan.note ?? null,
    };
  }

  async function overview() {
    const supervisor = await options.supervisor();
    const steps = [];
    const states: Partial<Record<StepId, string>> = {};
    for (const step of catalog) {
      if (step.id === "pruefung") continue;
      const status = await step.status(ctx);
      states[step.id] = status.state;
      steps.push({ id: step.id, title: step.title, optional: step.optional, state: status.state, detail: status.detail });
    }
    const missing = FINISH_REQUIRED.filter(s => states[s.id] !== "erledigt");
    const check = findStep("pruefung")!;
    steps.push({
      id: check.id,
      title: check.title,
      optional: false,
      state: missing.length ? "fehlt" : "erledigt",
      detail: missing.length ? `Es fehlt noch: ${missing.map(s => s.title).join(", ")}.` : "Bereit für „Fertig“.",
    });
    return {
      steps,
      ready: missing.length === 0,
      missing: missing.map(s => s.title),
      autostart: states.autostart ?? "fehlt",
      autostartChoice: supervisor ? null : await autostartChoice(states.autostart),
      supervisor,
      startCommand: options.startCommand,
      running: activeRun ? { runId: activeRun.id, step: activeRun.stepId } : null,
    };
  }

  /**
   * Gesamtprüfung im Browser: Autostart kommt erst bei „Fertig“, optionale
   * Schritte sind kein Fehler. Deshalb eigene Zusammenfassung statt der des
   * Terminals, die Autostart als fehlend zählt.
   */
  async function checkSummary() {
    const ov = await overview();
    const items = ov.steps
      .filter(s => s.id !== "pruefung")
      .map(s => {
        const done = s.state === "erledigt";
        const later = s.id === "autostart" && !done;
        return {
          label: s.title,
          ok: done,
          // Offen, aber kein Fehler: optionale Schritte und der Autostart vor „Fertig“
          optional: !done && (s.optional || later),
          detail: later ? `${s.detail} Kann bei „Fertig“ eingerichtet werden.` : s.detail,
        };
      });
    const detail = ov.ready ? "Alle Pflichtangaben sind da. „Fertig“ schließt die Einrichtung ab." : `Vor „Fertig“ fehlt noch: ${ov.missing.join(", ")}.`;
    return { ready: ov.ready, missing: ov.missing, items, detail };
  }

  async function stepJson(step: SetupStep) {
    if (step.id === "pruefung") {
      const summary = await checkSummary();
      return {
        id: step.id,
        title: step.title,
        description: step.description,
        optional: false,
        state: summary.ready ? "erledigt" : "fehlt",
        detail: summary.detail,
        items: summary.items,
        fields: [],
        canTest: true,
        canApply: false,
        applyAtFinish: false,
      };
    }
    const status = await step.status(ctx);
    const setNames = new Set(status.fields.filter(f => f.set).map(f => f.name));
    const known = await knownValues(ctx, step, {}, catalog);
    const view = await viewJson(step, ctx, setNames, {}, s => redactKnown(s, known));
    const out: Record<string, unknown> = {
      id: step.id,
      title: step.title,
      description: step.description,
      optional: step.optional,
      state: status.state,
      detail: status.detail,
      items: status.items ?? [],
      fields: view.fields,
      canTest: !!step.test,
      canApply: !!step.apply && step.id !== "autostart",
      applyAtFinish: step.id === "autostart",
    };
    // Nur bei Schritten mit Ablauf, damit die bisherigen Antworten gleich bleiben
    if (step.run) Object.assign(out, { canRun: true, mode: view.mode, plan: view.plan });
    return out;
  }

  async function stepRoute(id: string, action: string | undefined, choiceField: string | undefined, method: string, body: string, session: string): Promise<Response> {
    const step = findStep(id);
    if (!step) return json({ error: "Unbekannter Schritt" }, 404);
    if (choiceField) action = "choices";
    if (!action) {
      if (method !== "GET") return json({ error: "Methode nicht erlaubt" }, 405, { Allow: "GET" });
      return json(await stepJson(step));
    }
    if (method !== "POST") return json({ error: "Methode nicht erlaubt" }, 405, { Allow: "POST" });
    const parsed = parseValues(step, body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const values = parsed.values;

    if (action === "view") {
      const status = await step.status(ctx);
      const setNames = new Set(status.fields.filter(f => f.set).map(f => f.name));
      const known = await knownValues(ctx, step, enteredValues(values), catalog);
      const view = await viewJson(step, ctx, setNames, values, s => redactKnown(s, known), parsePresent(step, body));
      // mode und plan nur bei Schritten mit Ablauf, sonst Antwort wie bisher
      return json(step.run ? view : { fields: view.fields });
    }

    if (action === "choices") return loadChoices(step, choiceField!, values, session);
    if (action === "run") return startRun(step, values, session);

    if (action === "test" && !step.test) return json({ error: "Dieser Schritt hat keinen Test" }, 409);
    if (action === "apply" && step.id === "autostart") {
      return json({ error: "Autostart wird bei „Fertig“ eingerichtet, erst wenn die Einrichtung zu ist." }, 409);
    }
    if (action === "apply" && !step.apply) return json({ error: "Dieser Schritt speichert nichts" }, 409);

    const closed = () => json({ error: "Die Einrichtung ist abgeschlossen", finished: true }, 401);
    /**
     * Alles, was von vorhandenen Werten abhängt, erst in der Warteschlange
     * unmittelbar vor test/apply: ein Speichern davor (etwa ein neues Token)
     * ändert Modus, Standardwerte und die Gültigkeit geladener Listen.
     * Filterliste vor und nach dem Lauf: dieser Lauf kann selbst Werte ersetzen.
     */
    const inQueue = async <T>(run: (input: SetupValues) => Promise<T>) => {
      const base = await visibilityBase(step, ctx);
      if (step.run && runsAsFlow(step, { ...base, ...resolveValues(step.fields, values, base) })) {
        return { refused: json({ error: "Dieser Schritt richtet sich mit diesen Eingaben über „Einrichten“ ein." }, 409) };
      }
      const choiceProblem = choiceErrors(session, step, values, base);
      if (choiceProblem) return { refused: json({ error: choiceProblem }, 422) };
      const input = withDefaults(step, values, base);
      const before = await knownValues(ctx, step, enteredValues(values), catalog);
      const result = await run(input);
      const after = await knownValues(ctx, step, enteredValues(values), catalog);
      const known = [...new Set([...before, ...after])].sort((a, b) => b.length - a.length);
      return { result, known, clean: (s: string) => redactKnown(s, known) };
    };
    if (action === "test") {
      // Erst in der Warteschlange prüfen: ein „Fertig“ davor kann inzwischen durch sein
      const outcome = await serial(async () => (finishedPlan ? null : await inQueue(input => step.test!(input, ctx))));
      if (!outcome) return closed();
      if ("refused" in outcome) return outcome.refused!;
      const { clean } = outcome;
      let result = outcome.result;
      if (step.id === "pruefung") {
        // Wie checkSummary: Autostart fehlt vor „Fertig“ nicht
        const { ready, missing } = await checkSummary();
        const failed = (result.items ?? []).filter(i => !i.ok);
        const parts: string[] = [];
        if (!ready) parts.push(`Vor „Fertig“ fehlt noch: ${missing.join(", ")}.`);
        if (failed.length) parts.push(`Fehlgeschlagen: ${failed.map(i => i.label).join(", ")}.`);
        const ok = ready && failed.length === 0;
        result = { ...result, ok, message: ok ? "Alles Eingerichtete ist erreichbar." : parts.join(" ") };
      }
      return json({
        ok: result.ok,
        message: clean(result.message),
        items: (result.items ?? []).map(i => ({ label: i.label, ok: i.ok, detail: clean(i.detail), fix: i.fix ? clean(i.fix) : undefined })),
      });
    }
    // action === "apply"
    const outcome = await serial(async () => {
      if (finishedPlan) return null;
      // Erst in der Warteschlange: ein Ablauf kann davor reserviert worden sein
      if (activeRun) return "laeuft" as const;
      return inQueue(input => step.apply!(input, ctx));
    });
    if (!outcome) return closed();
    if (outcome === "laeuft") return json({ error: RUN_ACTIVE_TEXT }, 409);
    if ("refused" in outcome) return outcome.refused!;
    const { result, known, clean } = outcome;
    // Wie im Ablauf: ein Schritt könnte einen Wert in einen Dateinamen bauen
    const changed = (result.changed ?? []).map(c => cleanName(relativePath(String(c)), known));
    if (changed.length) log(`Schritt ${step.id} gespeichert: ${changed.join(", ")}`);
    return json({ ok: result.ok, message: clean(result.message), changed }, result.ok ? 200 : 422);
  }

  /** Auswahl vom Anbieter laden und an Sitzung, Schritt, Feld und Eingaben davor binden */
  async function loadChoices(step: SetupStep, fieldName: string, values: SetupValues, session: string): Promise<Response> {
    const field = step.fields.find(f => f.name === fieldName);
    if (!field) return json({ error: "Unbekanntes Feld für diesen Schritt" }, 404);
    if (!field.choicesFrom) return json({ error: "Dieses Feld hat keine Auswahl vom Anbieter" }, 409);
    if (finishedPlan) return json({ error: "Die Einrichtung ist abgeschlossen", finished: true }, 401);
    const key = listKey(session, step, fieldName);
    const seq = ++seqCounter;
    loadSeq.set(key, seq);
    // Ein neuer Versuch verwirft die alte Liste sofort (etwa nach Tokenwechsel)
    loadedLists.delete(key);
    const base = await visibilityBase(step, ctx);
    const resolved = resolveValues(step.fields, values, base);
    const known = await knownValues(ctx, step, enteredValues(values), catalog);
    const clean = (s: string) => redactKnown(s, known);
    let result: Awaited<ReturnType<NonNullable<SetupField["choicesFrom"]>>>;
    try {
      result = await field.choicesFrom(valuesBefore(step.fields, fieldName, resolved), ctx);
    } catch (e) {
      log(`Auswahl für ${step.id}/${fieldName} nicht geladen (${e instanceof Error ? e.name : typeof e})`);
      result = { error: "Die Auswahl ließ sich nicht laden." };
    }
    const latest = loadSeq.get(key) === seq;
    if ("error" in result) return json({ error: clean(result.error) }, 422);
    if (!Array.isArray(result.choices) || result.choices.length === 0) return json({ error: "Der Anbieter hat keine Auswahl geliefert." }, 422);
    const choices = result.choices.map(c => ({ value: String(c.value), label: clean(String(c.label)) }));
    // Verspätete Antwort: nicht speichern, eine neuere hat Vorrang
    if (latest && !finishedPlan) loadedLists.set(key, { key: choicesKey(step.fields, fieldName, { ...base, ...resolved }), choices });
    return json({ choices, stale: latest ? undefined : true });
  }

  /**
   * Ablauf reservieren (in der Warteschlange) und im Hintergrund starten.
   * Modus und Eingaben prüft er erst in der Warteschlange, mit den dann
   * vorhandenen Werten: ein Speichern davor (etwa ein neues Token) gilt so
   * schon für die Prüfung, eines danach wartet auf die Reservierung.
   */
  async function startRun(step: SetupStep, values: SetupValues, session: string): Promise<Response> {
    if (!step.run) return json({ error: "Dieser Schritt hat keinen Ablauf" }, 409);
    const reserved = await serial(async () => {
      if (finishedPlan) return "fertig" as const;
      if (activeRun) return "laeuft" as const;
      const base = await visibilityBase(step, ctx);
      const effective = { ...base, ...resolveValues(step.fields, values, base) };
      if (!runsAsFlow(step, effective)) return "keinAblauf" as const;
      const errors = validateValues(step.fields, values, base, loadedFor(session, step, effective));
      if (Object.keys(errors).length) {
        const known = await knownValues(ctx, step, enteredValues(values), catalog);
        return { error: redactKnown(Object.values(errors).join("; "), known) };
      }
      const input = withDefaults(step, values, base);
      const controller = new AbortController();
      let markDone!: () => void;
      const rec: RunRecord = {
        id: randomBytes(12).toString("base64url"),
        stepId: step.id,
        state: "laeuft",
        events: [],
        controller,
        done: new Promise<void>(r => (markDone = r)),
      };
      activeRun = rec;
      runs.set(rec.id, rec);
      while (runs.size > MAX_KEPT_RUNS) {
        const oldest = [...runs.values()].find(r => r.state !== "laeuft");
        if (!oldest) break;
        runs.delete(oldest.id);
      }
      return { rec, markDone, input };
    });
    if (reserved === "fertig") return json({ error: "Die Einrichtung ist abgeschlossen", finished: true }, 401);
    if (reserved === "laeuft") return json({ error: RUN_ACTIVE_TEXT }, 409);
    if (reserved === "keinAblauf") return json({ error: "Mit diesen Eingaben gibt es keinen Ablauf; bitte testen und speichern." }, 409);
    if ("error" in reserved) return json({ error: reserved.error }, 422);
    void executeRun(step, reserved.input, reserved.rec).finally(reserved.markDone);
    return json({ runId: reserved.rec.id }, 202);
  }

  /** Führt run() aus; setzt immer einen Endzustand und gibt die Sperre frei */
  async function executeRun(step: SetupStep, input: SetupValues, rec: RunRecord): Promise<void> {
    log(`Ablauf ${step.id} gestartet`);
    let known: string[] = [];
    const entered = enteredValues(input);
    // Bekannte Werte bleiben über den ganzen Ablauf: ein ersetztes Token darf noch in Meldungen stehen
    const refresh = async () => {
      const fresh = await knownValues(ctx, step, entered, catalog).catch(() => [] as string[]);
      known = [...new Set([...known, ...fresh])].sort((a, b) => b.length - a.length);
    };
    try {
      await refresh();
      const clean = (s: string) => redactKnown(s, known);
      const runCtx: SetupContext = {
        ...ctx,
        // Nur das Schreiben geht durch die Warteschlange; danach neu gespeicherte Werte mitschwärzen
        writeLock: fn =>
          serial(async () => {
            try {
              return await fn();
            } finally {
              await refresh();
            }
          }),
      };
      const report = (e: RunEvent) => {
        if (rec.state !== "laeuft") return;
        rec.events.push({
          at: Number(e.at) || 0,
          total: Number(e.total) || 0,
          label: clean(String(e.label ?? "")),
          ...(e.detail ? { detail: clean(String(e.detail)) } : {}),
          ...(typeof e.waitedMs === "number" ? { waitedMs: e.waitedMs } : {}),
        });
        if (rec.events.length > MAX_RUN_EVENTS) rec.events.splice(0, rec.events.length - MAX_RUN_EVENTS);
      };
      let result: ApplyResult;
      try {
        result = await step.run!(input, runCtx, report, rec.controller.signal);
      } catch (e) {
        // Nur der Fehlername: Meldungen könnten Eingaben enthalten
        result = { ok: false, message: `Der Ablauf ist mit einem internen Fehler stehen geblieben (${e instanceof Error ? e.name : typeof e}).`, changed: [] };
      }
      await refresh();
      // Auch Namen und Pfade: ein Schritt könnte einen Wert hineinbauen (etwa in einen Dateinamen)
      const changed = (result.changed ?? []).map(c => cleanName(relativePath(String(c)), known));
      rec.result = { ok: !!result.ok, message: clean(String(result.message ?? "")), changed };
      rec.state = result.ok ? "fertig" : rec.controller.signal.aborted ? "abgebrochen" : "fehler";
    } catch (e) {
      rec.result = { ok: false, message: "Der Ablauf ist mit einem internen Fehler stehen geblieben.", changed: [] };
      rec.state = "fehler";
      log(`Ablauf ${step.id}: interner Fehler (${e instanceof Error ? e.name : typeof e})`);
    } finally {
      if (rec.state === "laeuft") rec.state = "fehler";
      if (activeRun === rec) activeRun = null;
      log(`Ablauf ${step.id} beendet: ${rec.state}${rec.result?.changed.length ? ` (geändert: ${rec.result.changed.join(", ")})` : ""}`);
    }
  }

  function runRoute(id: string, action: string | undefined, method: string): Response {
    const rec = runs.get(id);
    if (!rec) return json({ error: "Unbekannter Ablauf" }, 404);
    if (!action) {
      if (method !== "GET") return json({ error: "Methode nicht erlaubt" }, 405, { Allow: "GET" });
      return json({ state: rec.state, step: rec.stepId, events: rec.events, result: rec.result });
    }
    if (method !== "POST") return json({ error: "Methode nicht erlaubt" }, 405, { Allow: "POST" });
    if (rec.state !== "laeuft") return json({ error: "Der Ablauf ist schon beendet", state: rec.state }, 409);
    if (!rec.controller.signal.aborted) log(`Ablauf ${rec.stepId}: Abbruch angefordert`);
    rec.controller.abort();
    return json({ ok: true, state: rec.state });
  }

  async function finish(body: string): Promise<Response> {
    let wantAutostart = false;
    let manager: AutostartManager | undefined;
    try {
      const parsed = body ? JSON.parse(body) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      if (parsed.autostart !== undefined && typeof parsed.autostart !== "boolean") throw new Error();
      // Weg des Autostarts (Issue #207); fehlt er, gilt der Standard
      if (parsed.manager !== undefined && !AUTOSTART_MANAGERS.includes(parsed.manager)) throw new Error();
      wantAutostart = parsed.autostart === true;
      manager = parsed.manager;
    } catch {
      return json({ error: "Ungültige Anfrage" }, 400);
    }
    return serial(async () => {
      if (finishedPlan) return json({ error: "Die Einrichtung ist schon abgeschlossen" }, 409);
      if (activeRun) return json({ error: RUN_ACTIVE_TEXT }, 409);
      const missing: string[] = [];
      for (const step of FINISH_REQUIRED) {
        if ((await step.status(ctx)).state !== "erledigt") missing.push(step.title);
      }
      if (missing.length) {
        return json({ error: `Vor „Fertig“ fehlt noch: ${missing.join(", ")}.`, missing }, 409);
      }
      const supervisor = await options.supervisor();
      let plan: FinishPlan;
      if (supervisor) {
        plan = {
          kind: "restart",
          supervisor,
          message: `${BRAND.name} startet jetzt neu (${supervisorName(supervisor)}) und ist in wenigen Sekunden in Telegram erreichbar.`,
        };
      } else if (wantAutostart && (await autostartStep.status(ctx)).state !== "erledigt") {
        const check = await autostartStep.test!(manager ? { manager } : {}, ctx);
        if (!check.ok) return json({ error: `Autostart lässt sich nicht einrichten: ${check.message}` }, 409);
        const how = manager && manager !== "launchd" ? ` (${MANAGER_LABEL[manager]})` : "";
        plan = {
          kind: "autostart",
          message: `Die Einrichtung schließt jetzt, dann richtet ${BRAND.name} den Autostart${how} ein und startet. Ob es geklappt hat, steht im Terminal; danach meldet sich der Bot in Telegram.`,
          ...(manager ? { manager } : {}),
        };
      } else {
        plan = {
          kind: "manual",
          command: options.startCommand,
          message: `Alles gespeichert. ${BRAND.name} jetzt im Terminal starten:`,
        };
      }
      // Ab hier gelten weder Code noch Sitzungen
      finishedPlan = plan;
      sessions.clear();
      log(`Einrichtung abgeschlossen (${plan.kind}); Einmal-Code und Sitzungen sind ungültig`);
      // Erst nach dem Absenden der Antwort melden: danach schließt web-mode.ts den Server
      setTimeout(() => resolveFinished(plan), 0);
      return json({ ok: true, plan: plan.kind, message: plan.message, command: plan.kind === "manual" ? plan.command : undefined }, 200, {
        "Set-Cookie": sessionCookie("", true),
      });
    });
  }

  async function route(req: Request, peerIp: string): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    // Vor Host, Code und Cookie: der Einrichtungsmodus ist ein lokales Sonderrecht
    if (hasTunnelHeaders(req)) {
      log("Einrichtung über den Tunnel abgelehnt");
      return path.startsWith("/api/") ? json({ error: SETUP_TUNNEL_TEXT }, 403) : text(SETUP_TUNNEL_TEXT, 403);
    }
    if (!isSetupHost(req.headers.get("host"), port)) return text("Misdirected Request", 421);
    if (method !== "GET" && method !== "HEAD" && !isSameOrigin(req)) return json({ error: "Fremder Origin" }, 403);

    let body: string;
    try {
      body = await readLimitedText(req);
    } catch (e) {
      if (e instanceof BodyTooLarge) return json({ error: "Anfrage zu groß" }, 413);
      throw e;
    }

    const loggedIn = validSession(readCookie(req, SETUP_COOKIE));

    if (path === "/api/setup/code") {
      if (method !== "POST") return json({ error: "Methode nicht erlaubt" }, 405, { Allow: "POST" });
      if (limiter.isBlocked(peerIp)) {
        log(`Einmal-Code gesperrt für ${peerIp} (zu viele Fehlversuche)`);
        return json({ error: "Zu viele Fehlversuche, bitte später erneut versuchen" }, 429, { "Retry-After": "900" });
      }
      let input: unknown;
      try {
        input = JSON.parse(body)?.code;
      } catch {
        return json({ error: "Ungültige Anfrage" }, 400);
      }
      if (typeof input !== "string") return json({ error: "Ungültige Anfrage" }, 400);
      if (finishedPlan) return json({ error: "Die Einrichtung ist abgeschlossen, der Code gilt nicht mehr", finished: true }, 401);
      if (!passwordMatches(normalizeSetupCode(input), code)) {
        limiter.recordFailure(peerIp);
        log(`Falscher Einmal-Code von ${peerIp}`);
        return json({ error: "Falscher Code" }, 401);
      }
      const token = randomBytes(32).toString("base64url");
      sessions.set(hashToken(token), now() + SETUP_SESSION_TTL_MS);
      log(`Einrichtung im Browser geöffnet von ${peerIp}`);
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
    }

    if (path === "/api" || path.startsWith("/api/")) {
      if (!loggedIn) {
        return finishedPlan
          ? json({ error: "Die Einrichtung ist abgeschlossen", finished: true }, 401)
          : json({ error: "Nicht angemeldet" }, 401);
      }
      if (path === "/api/setup/overview") {
        if (method !== "GET") return json({ error: "Methode nicht erlaubt" }, 405, { Allow: "GET" });
        return json(await overview());
      }
      if (path === "/api/setup/finish") {
        if (method !== "POST") return json({ error: "Methode nicht erlaubt" }, 405, { Allow: "POST" });
        return finish(body);
      }
      const m = STEP_PATH.exec(path);
      if (m) return stepRoute(m[1], m[2], m[3], method, body, loggedIn);
      const r = RUN_PATH.exec(path);
      if (r) return runRoute(r[1], r[2], method);
      return json({ error: "Nicht gefunden" }, 404);
    }

    if (method !== "GET" && method !== "HEAD") return text("Methode nicht erlaubt", 405);
    if (path === "/") return loggedIn ? serveFrom(setupDir, "setup.html") : redirect("/code");
    if (path === "/code" && loggedIn) return redirect("/");
    if (path === BRAND_SCRIPT_PATH) return brandScriptResponse();
    const asset = assets[path];
    if (asset) return serveFrom(asset[0], asset[1]);
    return text("Nicht gefunden", 404);
  }

  function finalize(res: Response, path: string): Response {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    res.headers.set("Cache-Control", path.startsWith("/api/") || res.status >= 300 ? "no-store" : "no-cache");
    return res;
  }

  const server = Bun.serve({
    // Immer nur dieser Rechner, unabhängig von WEB_HOST
    hostname: SETUP_HOST,
    port: options.port,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    async fetch(req, srv) {
      let path = "/";
      try {
        path = new URL(req.url).pathname;
        return finalize(await route(req, srv.requestIP(req)?.address ?? "unbekannt"), path);
      } catch (e) {
        // Nur der Fehlername: Meldungen könnten Eingaben enthalten
        log(`Fehler bei ${req.method} ${path} (${e instanceof Error ? e.name : typeof e})`);
        return finalize(text("Interner Fehler", 500), path);
      }
    },
    error() {
      return finalize(text("Interner Fehler", 500), "/");
    },
  });
  port = server.port!;

  return {
    url: `http://${SETUP_HOST}:${port}`,
    port,
    finished,
    isFinished: () => finishedPlan !== null,
    queued: () => queued,
    runningStep: () => activeRun?.stepId ?? null,
    async cancelRuns(graceMs) {
      const rec = activeRun;
      if (!rec) return "keiner";
      rec.controller.abort();
      const graceEnd = new AbortController();
      const outcome = await Promise.race([
        rec.done.then(() => "beendet" as const),
        options.ctx.sleep(graceMs, graceEnd.signal).then(() => "frist" as const),
      ]);
      graceEnd.abort();
      // Ein angefangenes Schreiben der .env läuft immer zu Ende
      await waitForEnvWrites();
      return outcome;
    },
    async stop() {
      // Schließt auch ruhende Keep-alive-Verbindungen, sonst bliebe der Server
      // über sie erreichbar. Die Antwort auf „Fertig“ ist dann schon raus
      // (finished erst nach der Antwort, web-mode.ts wartet zusätzlich).
      await server.stop(true);
    },
  };
}
