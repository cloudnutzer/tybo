/**
 * Meldungen der Routinen-Zentrale (Issue #287, Entscheidung 0025):
 * fehlgeschlagene Läufe meldet der Wrapper (src/routine-run.ts), ausgebliebene
 * der Bot (watch.ts). Beide teilen den Zustand in data/routines/alerts.json.
 *
 * Eine Meldung je Serie: Eine Serie beginnt mit dem ersten Fehlschlag oder
 * dem ersten ausgebliebenen Termin und endet mit dem nächsten erfolgreichen
 * Lauf; nur wenn zu ihr eine Meldung zugestellt wurde, folgt eine kurze
 * Entwarnung. Scheitert ein Lauf während einer Serie „ausgeblieben", wird sie
 * zur Serie „fehlgeschlagen"; gemeldet wird das nur, wenn zu ihr noch keine
 * Meldung zugestellt ist und keine unterwegs ist (Entscheidung 0025: die
 * nächste Warnung erst nach einem erfolgreichen Lauf). Während einer Serie
 * „fehlgeschlagen" meldet der Bot keine ausgebliebenen Termine.
 *
 * Zustellung: wie outboxDelivered (Telegram angenommen oder, ohne Telegram,
 * in der WebUI festgehalten). Scheitert sie, bleibt die Serie offen, aber
 * ungemeldet: der nächste Fehlschlag bzw. die nächste Prüfung versucht es
 * noch einmal. Wer gerade sendet, trägt einen Anspruch (claim) ein, damit
 * parallel laufende Wrapper und der Bot nicht doppelt melden; ein Anspruch
 * älter als CLAIM_MS gilt als verwaist. Endet eine Serie mit einem Erfolg,
 * während ihre Meldung noch unterwegs ist, fällt die Serie weg und nur ihr
 * Anspruch bleibt unter closing stehen; wer ihn trägt, schickt nach dem
 * Versand die Entwarnung, wenn die Meldung zugestellt wurde und der Erfolg
 * nicht bei abgeschalteten Meldungen kam (silent). Ein neuer Fehlschlag
 * danach beginnt eine eigene Serie mit eigener Meldung.
 *
 * Geheimnisse: jede Meldung (Fehler, ausgeblieben, Entwarnung) geht durch
 * maskSecrets mit den Werten aus der .env. Ist die .env nicht lesbar, stehen
 * weder Name noch Log-Pfad noch Ausgabe in der Meldung.
 *
 * Laufender Lauf: jeder Wrapper trägt sich vor dem Start in running ein
 * (pid, Beginn) und nach dem Ende nur sich selbst wieder aus; solange einer
 * dieser Prozesse lebt, gilt die Routine nie als ausgeblieben (watch.ts).
 *
 * Datei: { "routines": { "<id>": { seenAt?, startedAt?, running?, series?, closing? } },
 * "heartbeat"?: { awakeSince, lastBeat } }. Geschrieben unter Sperre
 * (file-lock.ts) und atomar (atomic-file.ts) wie das Lauf-Protokoll; die
 * Sperre hält nur Lesen, Ändern und Schreiben, nie den Versand.
 *
 * ROUTINE_ALERTS=off schaltet beide Meldungsarten ab: Der Bot prüft nicht,
 * der Wrapper schickt nichts. Er gleicht alerts.json aber weiter mit den
 * Läufen ab (Beginn, Ende, ein Erfolg beendet die Serie still), damit nach dem
 * Wiedereinschalten keine alte Serie neue Fehler verschluckt. Die Übersicht
 * und das Protokoll bleiben.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../atomic-file";
import { acquireFileLock, releaseFileLock, type FileLockOptions } from "../file-lock";
import { maskSecrets, type SecretValue } from "../jobs/mask";
import { LAUNCHD_PREFIX } from "../service-names";
import { durationText, runFailed, tildePath } from "./format";
import { parseRuns, RUNS_DIR, type RoutineRun } from "./runs";
import type { RunCommand } from "./types";

/** Kann nie ein Protokoll sein: routineIdAllowed lehnt die id „alerts" ab */
export const ALERTS_FILE = join(RUNS_DIR, "alerts.json");
/** Absender in der Outbox */
export const ALERT_SOURCE = "routine";
/** Länge der Fehlerzeile in der Meldung, in Zeichen */
export const ERROR_LINE_MAX = 300;
/** Ein Versand-Anspruch, der älter ist, gilt als verwaist */
export const CLAIM_MS = 5 * 60_000;

export interface AlertClaim {
  pid: number;
  at: string;
  /**
   * Nur vorgemerkt (Bot, Ausgeblieben-Meldung): der Versand hat noch nicht
   * begonnen. Ein Laufbeginn oder ein Lauf-Ende verdrängt die Vormerkung,
   * renewClaim macht daraus einen Anspruch ohne reserved.
   */
  reserved?: true;
}

export interface AlertSeries {
  kind: "failed" | "missed";
  /** Beginn der Serie (ISO) */
  since: string;
  /** Meldung zugestellt (ISO); fehlt, solange nicht gemeldet */
  alertedAt?: string;
  /** Ausgeblieben: der fällige Termin (ISO), den die Meldung nennt */
  due?: string;
  claim?: AlertClaim;
}

/** Meldung einer durch einen Erfolg beendeten Serie, die noch unterwegs ist */
export interface ClosingAlert {
  claim: AlertClaim;
  /** Der Erfolg kam bei abgeschalteten Meldungen: keine Entwarnung */
  silent?: boolean;
}

export interface RunningRun {
  /** Prozess des Wrappers */
  pid: number;
  startedAt: string;
}

export interface RoutineAlertState {
  /** Erstmals vom Bot geprüft (ISO); Ersatz für den letzten Beginn, solange es keinen Lauf gibt */
  seenAt?: string;
  /** Beginn des letzten Laufs laut Wrapper (ISO), schon während er läuft */
  startedAt?: string;
  /** Läufe, die gerade laufen (je Wrapper-Prozess); fehlt, wenn keiner läuft */
  running?: RunningRun[];
  series?: AlertSeries;
  /** Meldungen beendeter Serien, deren Versand noch läuft */
  closing?: ClosingAlert[];
}

export interface Heartbeat {
  /** Seit wann der Bot ohne Lücke läuft (ISO) */
  awakeSince: string;
  lastBeat: string;
}

export interface AlertsState {
  routines: Record<string, RoutineAlertState>;
  heartbeat?: Heartbeat;
}

/** Ist ROUTINE_ALERTS eingeschaltet? Nur off (auch aus, false, 0, no) schaltet ab */
export function alertsEnabled(env: Record<string, string | undefined>): boolean {
  const value = (env.ROUTINE_ALERTS ?? "").trim().toLowerCase();
  return !["off", "aus", "false", "0", "no"].includes(value);
}

function iso(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function parseSeries(value: unknown): AlertSeries | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if ((v.kind !== "failed" && v.kind !== "missed") || !iso(v.since)) return undefined;
  const series: AlertSeries = { kind: v.kind, since: v.since as string };
  if (iso(v.alertedAt)) series.alertedAt = v.alertedAt as string;
  if (iso(v.due)) series.due = v.due as string;
  const c = v.claim as Record<string, unknown> | undefined;
  const claim = parseClaim(v.claim);
  if (claim) series.claim = claim;
  return series;
}

function parseClaim(value: unknown): AlertClaim | undefined {
  const c = value as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object" || typeof c.pid !== "number" || !iso(c.at)) return undefined;
  return c.reserved === true ? { pid: c.pid, at: c.at as string, reserved: true } : { pid: c.pid, at: c.at as string };
}

function parseRunning(value: unknown): RunningRun | undefined {
  const run = value as Record<string, unknown> | undefined;
  if (!run || typeof run !== "object" || typeof run.pid !== "number" || !Number.isInteger(run.pid) || run.pid <= 0 || !iso(run.startedAt)) return undefined;
  return { pid: run.pid, startedAt: run.startedAt as string };
}

/** Zustand aus dem Dateiinhalt; ungültiges JSON oder ungültige Einträge heißen leer */
export function parseAlerts(content: string | null): AlertsState {
  const state: AlertsState = { routines: {} };
  if (!content) return state;
  let data: any;
  try {
    data = JSON.parse(content);
  } catch {
    return state;
  }
  const routines = data?.routines;
  if (routines && typeof routines === "object" && !Array.isArray(routines)) {
    for (const [id, raw] of Object.entries(routines as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const entry: RoutineAlertState = {};
      if (iso(r.seenAt)) entry.seenAt = r.seenAt as string;
      if (iso(r.startedAt)) entry.startedAt = r.startedAt as string;
      // Früher ein einzelner Eintrag, jetzt eine Liste
      const running = (Array.isArray(r.running) ? r.running : [r.running]).map(parseRunning).filter((x): x is RunningRun => !!x);
      if (running.length) entry.running = running;
      const series = parseSeries(r.series);
      if (series) entry.series = series;
      const closing = (Array.isArray(r.closing) ? r.closing : [])
        .map((c: any): ClosingAlert | null => {
          const claim = parseClaim(c?.claim);
          return claim ? (c.silent === true ? { claim, silent: true } : { claim }) : null;
        })
        .filter((c): c is ClosingAlert => !!c);
      if (closing.length) entry.closing = closing;
      state.routines[id] = entry;
    }
  }
  const hb = data?.heartbeat;
  if (hb && iso(hb.awakeSince) && iso(hb.lastBeat)) state.heartbeat = { awakeSince: hb.awakeSince, lastBeat: hb.lastBeat };
  return state;
}

export interface AlertsStore {
  read(): Promise<AlertsState>;
  /** Liest, ändert (fn darf den Zustand verändern) und schreibt unter Sperre */
  update<T>(fn: (state: AlertsState) => T): Promise<T>;
}

export function alertsFile(projectRoot: string): string {
  return join(projectRoot, ALERTS_FILE);
}

async function readOrNull(path: string): Promise<string | null> {
  return readFile(path, "utf-8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
}

/** alerts.json eines Projektordners, unter Sperre und atomar geschrieben */
export function fileAlertsStore(projectRoot: string, lock: FileLockOptions = {}): AlertsStore {
  const file = alertsFile(projectRoot);
  const lockPath = `${file}.lock`;
  return {
    read: async () => parseAlerts(await readOrNull(file)),
    async update(fn) {
      await mkdir(dirname(file), { recursive: true });
      const me = await acquireFileLock(lockPath, { waitMs: 10_000, ...lock });
      try {
        const state = parseAlerts(await readOrNull(file));
        const result = fn(state);
        await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
        return result;
      } finally {
        await releaseFileLock(lockPath, me);
      }
    },
  };
}

/** Lebt der Anspruch noch (jünger als CLAIM_MS)? */
export function claimFresh(claim: AlertClaim | undefined, now: number): boolean {
  if (!claim) return false;
  const at = Date.parse(claim.at);
  return Number.isFinite(at) && now - at < CLAIM_MS;
}

function sameClaim(a: AlertClaim | undefined, b: AlertClaim): boolean {
  return !!a && a.pid === b.pid && a.at === b.at;
}

/** Nimmt den Eintrag mit diesem Anspruch aus closing; null, wenn es keinen gibt */
function takeClosing(r: RoutineAlertState, claim: AlertClaim): ClosingAlert | null {
  const i = r.closing?.findIndex(c => sameClaim(c.claim, claim)) ?? -1;
  if (i < 0) return null;
  const [entry] = r.closing!.splice(i, 1);
  if (!r.closing!.length) delete r.closing;
  return entry;
}

/**
 * Erfolg während einer Serie, deren Meldung unterwegs ist: die Serie fällt
 * weg, ihr Anspruch wandert nach closing (verwaiste Einträge fallen dabei
 * heraus). silent: Meldungen sind abgeschaltet, der Sender entwarnt nicht.
 */
export function closeSeries(r: RoutineAlertState, claim: AlertClaim, silent: boolean, now: number): void {
  const kept = (r.closing ?? []).filter(c => claimFresh(c.claim, now));
  kept.push(silent ? { claim, silent: true } : { claim });
  r.closing = kept;
  delete r.series;
}

/**
 * Unmittelbar vor dem Versand: trägt die Serie noch diesen Anspruch, wird er
 * auf jetzt erneuert und zurückgegeben. Sonst null, dann nicht senden: ein
 * anderer hat übernommen, oder ein Erfolg beendete die Serie schon (der
 * Eintrag in closing fällt dann weg, es gibt weder Meldung noch Entwarnung).
 * Eine Vormerkung (reserved), die ein Laufbeginn oder ein Lauf-Ende
 * verdrängt hat, steht nicht mehr an der Serie: auch dann null.
 *
 * hold (unter derselben Sperre): liefert es true, etwa weil der Rechner
 * seit der Prüfung schlief, wird nicht gesendet; die Vormerkung fällt von
 * der Serie, sie bleibt ungemeldet offen, und das Ergebnis ist "held".
 */
export async function renewClaim(store: AlertsStore, id: string, claim: AlertClaim, now: number, hold?: (s: AlertsState) => boolean): Promise<AlertClaim | "held" | null> {
  return store.update(s => {
    const r = s.routines[id];
    if (!r) return null;
    if (r.series && sameClaim(r.series.claim, claim)) {
      if (hold?.(s)) {
        delete r.series.claim;
        return "held";
      }
      const renewed: AlertClaim = { pid: claim.pid, at: new Date(now).toISOString() };
      r.series.claim = renewed;
      return renewed;
    }
    takeClosing(r, claim);
    return null;
  });
}

/**
 * Nach dem Versand: Anspruch lösen, bei Zustellung alertedAt setzen. Wurde die
 * Serie inzwischen durch einen Erfolg beendet (Anspruch unter closing), fällt
 * der Eintrag weg; true heißt dann: die Meldung kam an und der Erfolg kam
 * nicht still, jetzt folgt die Entwarnung. Eine neue Serie bleibt unberührt.
 */
export async function finishClaim(store: AlertsStore, id: string, claim: AlertClaim, ok: boolean, now: number): Promise<boolean> {
  return store.update(s => {
    const r = s.routines[id];
    if (!r) return false;
    const series = r.series;
    if (series && sameClaim(series.claim, claim)) {
      delete series.claim;
      if (ok) series.alertedAt = new Date(now).toISOString();
      return false;
    }
    const closing = takeClosing(r, claim);
    return !!closing && ok && !closing.silent;
  });
}

/** Name in Meldungen: Label ohne ai.tybo., fremde Labels ganz (wie die Übersicht) */
export function alertName(id: string): string {
  return id.startsWith(LAUNCHD_PREFIX) ? id.slice(LAUNCHD_PREFIX.length) : id;
}

// ---------------------------------------------------------------------------
// Texte
// ---------------------------------------------------------------------------

export const ALERT_TEXT = {
  noOutput: "Keine Ausgabe festgehalten.",
  withheld: "Ausgabe nicht übernommen: .env nicht lesbar, Masken unvollständig.",
  noLog: "Log: kein Log-Pfad im Plist",
  /** Statt Name bzw. Log-Pfad, wenn die .env nicht lesbar ist */
  hiddenName: "(Name verborgen)",
  hiddenLog: "Log: verborgen, .env nicht lesbar",
  log: (path: string) => `Log: ${path}`,
  history: (name: string) => `Verlauf: /routinen ${name}`,
  historyAll: "Verlauf: /routinen",
  recovered: (name: string) => `✅ Routine ${name} läuft wieder`,
} as const;

/** Kürzt auf höchstens max Zeichen (mit „…"), nie mitten in einem Zeichen */
export function truncateChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** Letzte nicht leere Zeile, bevorzugt aus stderr; null, wenn es keine gibt */
export function pickErrorLine(stderrTail: readonly string[], tail: readonly string[]): string | null {
  const last = (lines: readonly string[]) => [...lines].reverse().find(l => l.trim() !== "") ?? null;
  return last(stderrTail) ?? last(tail);
}

export interface FailureTextInput {
  name: string;
  run: Pick<RoutineRun, "exitCode" | "signal" | "durationMs">;
  /** Fehlerzeile (schon aus dem maskierten Protokoll); null: keine Ausgabe */
  errorLine: string | null;
  logPath: string | null;
  home: string;
  /** null: .env nicht lesbar, keine Ausgabe in die Meldung */
  secrets: readonly SecretValue[] | null;
}

/** Erst maskieren, dann ~: ein Geheimnis, das den Home-Ordner einschließt, wäre nach ~ nicht mehr zu erkennen */
function logLine(path: string | null, home: string, secrets: readonly SecretValue[]): string {
  return path ? ALERT_TEXT.log(tildePath(maskSecrets(path, secrets), home)) : ALERT_TEXT.noLog;
}

/** Name, Log- und Verlaufszeile; ohne lesbare .env (secrets null) ohne Name und Pfad */
function parts(name: string, logPath: string | null, home: string, secrets: readonly SecretValue[] | null): { name: string; log: string; history: string } {
  if (secrets === null) return { name: ALERT_TEXT.hiddenName, log: ALERT_TEXT.hiddenLog, history: ALERT_TEXT.historyAll };
  return { name, log: logLine(logPath, home, secrets), history: ALERT_TEXT.history(name) };
}

/**
 * „⚠️ Routine <name> fehlgeschlagen (Exit <code>, <dauer>)", darunter die
 * Fehlerzeile (maskiert, dann gekürzt), der Log-Pfad mit ~ und der Hinweis
 * auf den Verlauf. Zuletzt wird die ganze Meldung noch einmal maskiert.
 */
export function failureText(o: FailureTextInput): string {
  const reason = o.run.signal ? `Exit ${o.run.exitCode}, abgebrochen durch ${o.run.signal}` : `Exit ${o.run.exitCode}`;
  const secrets = o.secrets ?? [];
  const p = parts(o.name, o.logPath, o.home, o.secrets);
  let detail: string;
  if (o.secrets === null) detail = ALERT_TEXT.withheld;
  else if (o.errorLine === null) detail = ALERT_TEXT.noOutput;
  else detail = truncateChars(tildePath(maskSecrets(o.errorLine, secrets), o.home), ERROR_LINE_MAX);
  const text = [`⚠️ Routine ${p.name} fehlgeschlagen (${reason}, ${durationText(o.run.durationMs)})`, detail, p.log, p.history].join("\n");
  return maskSecrets(text, secrets);
}

/** „⏰ Routine <name> ist nicht gelaufen (fällig <zeit>)", Log-Pfad, Verlauf; maskiert wie failureText */
export function missedText(o: { name: string; dueText: string; logPath: string | null; home: string; secrets: readonly SecretValue[] | null }): string {
  const p = parts(o.name, o.logPath, o.home, o.secrets);
  const text = [`⏰ Routine ${p.name} ist nicht gelaufen (fällig ${o.dueText})`, p.log, p.history].join("\n");
  return maskSecrets(text, o.secrets ?? []);
}

/** „✅ Routine <name> läuft wieder", maskiert; ohne lesbare .env ohne Name */
export function recoveredText(name: string, secrets: readonly SecretValue[] | null): string {
  return maskSecrets(ALERT_TEXT.recovered(secrets === null ? ALERT_TEXT.hiddenName : name), secrets ?? []);
}

// ---------------------------------------------------------------------------
// Versand
// ---------------------------------------------------------------------------

/** Ergebnis wie sendAndRecord; wirft der Sender, gilt das als nicht zugestellt */
export interface AlertSendResult {
  sent: boolean;
  recorded?: boolean;
  error?: unknown;
}

/**
 * Wozu eine Meldung gehört (Issue #288): Routine und Art. Damit hängt der
 * Bot bzw. der Wrapper an Fehler- und Ausgeblieben-Meldungen die Knöpfe
 * „Jetzt testen" und „Pausieren" (routine-choices.ts menuAlertSender).
 */
export interface AlertMeta {
  id: string;
  kind: "failed" | "missed" | "recovered";
}

export type AlertSender = (text: string, meta?: AlertMeta) => Promise<AlertSendResult>;

/** Wie outboxDelivered (channels.ts), ohne dessen Abhängigkeiten zu laden */
export function delivered(result: AlertSendResult): boolean {
  return result.sent || (result.recorded === true && !result.error);
}

async function trySend(send: AlertSender, text: string, meta: AlertMeta): Promise<boolean> {
  try {
    return delivered(await send(text, meta));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wrapper: Beginn und Ende eines Laufs
// ---------------------------------------------------------------------------

/** Nur vorgemerkt, Versand noch nicht begonnen: ein Lauf darf die Vormerkung verdrängen */
function reservedOnly(series: AlertSeries | undefined): boolean {
  return !!series && !series.alertedAt && !!series.claim?.reserved;
}

/**
 * Hält Beginn und Prozess eines Laufs fest, damit ein laufender Lauf nie als
 * ausgeblieben gilt. Eine nur vorgemerkte Ausgeblieben-Meldung ist damit
 * überholt: die Serie fällt weg, der Bot sendet sie nicht mehr (renewClaim).
 */
export async function markRunStart(store: AlertsStore, id: string, startedAt: number, pid: number): Promise<void> {
  await store.update(s => {
    const r = (s.routines[id] ??= {});
    if (reservedOnly(r.series)) delete r.series;
    r.startedAt = new Date(startedAt).toISOString();
    r.running = [...(r.running ?? []).filter(x => x.pid !== pid), { pid, startedAt: r.startedAt }];
  });
}

export interface RunAlertDeps {
  store: AlertsStore;
  send: AlertSender;
  now(): number;
  pid: number;
  home: string;
  /** Log-Pfad aus dem Plist (StandardErrorPath, sonst StandardOutPath); null ohne */
  logPath(id: string): Promise<string | null>;
  /** ROUTINE_ALERTS; false: nichts senden, nur den Zustand mit dem Lauf abgleichen */
  enabled?: boolean;
}

export interface RunAlertInput {
  id: string;
  run: RoutineRun;
  /** Letzte Zeilen nur aus stderr (maskiert) */
  stderrTail: readonly string[];
  secrets: readonly SecretValue[] | null;
}

export type RunAlertOutcome = "alerted" | "recovered" | "silent" | "undelivered";

/**
 * Nach einem Lauf: Fehlschlag am Anfang einer Serie melden, Erfolg nach einer
 * gemeldeten Serie entwarnen, sonst still. Ohne enabled nur abgleichen: der
 * laufende Lauf fällt weg, ein Erfolg beendet die Serie, nichts wird gesendet.
 * Wirft nur, wenn alerts.json nicht lesbar oder schreibbar ist; der Aufrufer
 * lässt den Exit-Code davon unberührt.
 */
export async function alertAfterRun(input: RunAlertInput, deps: RunAlertDeps): Promise<RunAlertOutcome> {
  const { id, run } = input;
  const name = alertName(id);
  const enabled = deps.enabled !== false;
  // Nur den eigenen Eintrag entfernen: andere Wrapper derselben Routine laufen vielleicht noch
  const endRunning = (r: RoutineAlertState) => {
    if (!r.running) return;
    r.running = r.running.filter(x => x.pid !== deps.pid);
    if (!r.running.length) delete r.running;
  };
  if (!runFailed(run)) {
    const recover = await deps.store.update(s => {
      const r = s.routines[id];
      if (!r) return false;
      endRunning(r);
      const series = r.series;
      if (!series) return false;
      // Meldung noch unterwegs: wer sie sendet, entwarnt (außer bei abgeschalteten Meldungen);
      // eine bloße Vormerkung fällt mit der Serie still weg
      if (!series.alertedAt && series.claim && !series.claim.reserved && claimFresh(series.claim, deps.now())) {
        closeSeries(r, series.claim, !enabled, deps.now());
        return false;
      }
      delete r.series;
      return !!series.alertedAt;
    });
    if (!recover || !enabled) return "silent";
    return (await trySend(deps.send, recoveredText(name, input.secrets), { id, kind: "recovered" })) ? "recovered" : "undelivered";
  }

  const claim: AlertClaim = { pid: deps.pid, at: new Date(deps.now()).toISOString() };
  const mine = await deps.store.update(s => {
    const r = (s.routines[id] ??= {});
    endRunning(r);
    if (!enabled) return false;
    const series = r.series;
    // Gemeldet oder Meldung unterwegs (auch „ausgeblieben"): dieselbe Serie, keine zweite Warnung.
    // Nur vorgemerkt: der Wrapper übernimmt, der Bot sendet die veraltete Meldung nicht mehr
    if (series && !reservedOnly(series) && (claimFresh(series.claim, deps.now()) || series.alertedAt)) {
      series.kind = "failed";
      return false;
    }
    r.series = { kind: "failed", since: series ? series.since : run.startedAt, claim };
    return true;
  });
  if (!mine) return "silent";

  const text = failureText({
    name,
    run,
    errorLine: input.secrets === null ? null : pickErrorLine(input.stderrTail, run.tail),
    logPath: await deps.logPath(id).catch(() => null),
    home: deps.home,
    secrets: input.secrets,
  });
  const ok = await trySend(deps.send, text, { id, kind: "failed" });
  if (await finishClaim(deps.store, id, claim, ok, deps.now())) await trySend(deps.send, recoveredText(name, input.secrets), { id, kind: "recovered" });
  return ok ? "alerted" : "undelivered";
}

// ---------------------------------------------------------------------------
// Log-Pfad aus dem Plist
// ---------------------------------------------------------------------------

/**
 * StandardErrorPath, sonst StandardOutPath aus ~/Library/LaunchAgents/<id>.plist
 * (plutil, nur lesend); null ohne Plist, ohne Pfad oder außerhalb von macOS.
 */
export async function plistLogPath(id: string, o: { home: string; platform: NodeJS.Platform; run: RunCommand }): Promise<string | null> {
  if (o.platform !== "darwin") return null;
  const file = join(o.home, "Library", "LaunchAgents", `${id}.plist`);
  if (!existsSync(file)) return null;
  const result = await o.run(["plutil", "-convert", "json", "-o", "-", file]).catch(() => null);
  if (!result?.ok) return null;
  try {
    const plist = JSON.parse(result.stdout) as Record<string, unknown>;
    for (const key of ["StandardErrorPath", "StandardOutPath"]) {
      const value = plist[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  } catch {
    // kein lesbares JSON
  }
  return null;
}

// ---------------------------------------------------------------------------
// Nachtcheck
// ---------------------------------------------------------------------------

export interface RoutinesSummary {
  /** Es gibt mindestens ein Protokoll unter data/routines/ */
  any: boolean;
  /** Namen der Routinen, deren letzter Lauf fehlschlug */
  failed: string[];
  /** Namen der Routinen mit gemeldetem oder offenem ausgebliebenem Termin (ohne Fehler, ohne späteren Lauf) */
  missed: string[];
}

/**
 * Stand aller Routinen aus data/routines/ für den Nachtcheck: letzter Lauf
 * je Protokoll, dazu ausgebliebene aus alerts.json. Eine ausgebliebene
 * Serie, nach deren Beginn das Protokoll einen Lauf zeigt, ist überholt und
 * zählt nicht. Nur lesend, keine Meldung; unlesbare Dateien zählen nicht.
 */
export function readRoutinesSummary(projectRoot: string): RoutinesSummary {
  const dir = join(projectRoot, RUNS_DIR);
  const summary: RoutinesSummary = { any: false, failed: [], missed: [] };
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return summary;
  }
  const read = (file: string): string | null => {
    try {
      return readFileSync(join(dir, file), "utf-8");
    } catch {
      return null;
    }
  };
  const lastStart = new Map<string, number>();
  for (const file of files.sort()) {
    if (!file.endsWith(".json") || file === "alerts.json") continue;
    const runs = parseRuns(read(file));
    if (!runs.length) continue;
    summary.any = true;
    const id = file.slice(0, -".json".length);
    const last = runs[runs.length - 1];
    lastStart.set(id, Date.parse(last.startedAt));
    if (runFailed(last)) summary.failed.push(alertName(id));
  }
  const state = parseAlerts(read("alerts.json"));
  for (const [id, r] of Object.entries(state.routines).sort(([a], [b]) => a.localeCompare(b))) {
    const name = alertName(id);
    if (r.series?.kind !== "missed" || summary.failed.includes(name)) continue;
    const ran = lastStart.get(id);
    if (ran !== undefined && ran >= Date.parse(r.series.since)) continue;
    summary.missed.push(name);
  }
  return summary;
}
