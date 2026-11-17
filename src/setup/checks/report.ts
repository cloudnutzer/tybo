/**
 * Rahmen von `tybo pruefen` (Issue #371, Entscheidung E12): ein Bericht aus
 * den Zuständen aller Einrichtungsschritte, der Kanalregel und den
 * Spezialprüfungen, dazu der Exit-Code.
 *
 * Grundsätze:
 * - Jeder Schritt wird genau einmal nach seinem Zustand gefragt; der
 *   zusammenfassende Schritt „pruefung“ nie, er würde alle Schritte ein
 *   zweites Mal abfragen. test() und apply() laufen nie: der Bericht
 *   schickt keine Testnachricht, schreibt keine Probe und richtet nichts ein.
 * - Lesende Anfragen der Anbieter (getMe, messages lesen, ...) laufen über
 *   einen Zwischenspeicher je Argument. Fragt der Schritt Datenbank die
 *   lokale Supabase schon ab, liest die Spezialprüfung das Ergebnis mit,
 *   statt messages ein zweites Mal zu lesen. Anbieter mit Wirkung
 *   (Testnachricht, Schreibprobe, Modellaufruf) sind gesperrt.
 * - Eine Prüfung, die wirft oder zu lange braucht, wird zu einer
 *   Fehlerzeile; der übrige Bericht entsteht trotzdem.
 * - Alle Texte laufen durch redact() mit den Werten geheimer Variablen der
 *   .env, bevor sie im Bericht landen.
 * - Motoren (Claude CLI, Codex, OpenCode) prüft der ganze Bericht mit dem
 *   PATH, mit dem der Bot als Dienst läuft (Issue #567, servicePath in
 *   ./engine.ts), der Schritt „voraussetzungen“ also genauso wie der
 *   Abschnitt „Motor“. Ohne lesbaren PATH aus der Dienstdatei gilt der PATH
 *   dieser Shell.
 *
 * Exit-Code: 1, sobald eine Zeile „fail“ ist (Pflichtschritt fehlt, kein
 * Kanal, Prüfung gescheitert); Warnungen und übersprungene optionale
 * Schritte lassen ihn bei 0.
 */

import { BRAND } from "../../brand";
import { resolveClaudeAuth, withClaudeAuth } from "../../lib/engines/claude-auth";
import { filterSubprocessEnv, isSecretName, SUBPROCESS_MARKER } from "../../lib/subprocess-env";
import { overallChannels } from "../channels";
import { readSetupEnv, type SetupContext } from "../context";
import { presentValue, redact, type SetupStep, type StepId, type StepStatus } from "../model";
import type { ClaudeRunContext, Providers } from "../providers";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

/** Eine Zeile des Berichts; detail ist schon von Geheimnissen befreit */
export interface CheckLine {
  section: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export type Finding = Omit<CheckLine, "section">;
type Env = Record<string, string>;

/** Was eine Spezialprüfung sieht: Kontext, .env und die schon ermittelten Schritt-Zustände */
export interface CheckInput {
  ctx: SetupContext;
  env: Env;
  statuses: ReadonlyMap<StepId, StepStatus>;
  signal: AbortSignal;
}

export interface SpecialCheck {
  id: string;
  section: string;
  run(input: CheckInput): Promise<Finding[]>;
}

export interface Report {
  lines: CheckLine[];
}

export interface CollectOptions {
  ctx: SetupContext;
  steps: readonly SetupStep[];
  specials: readonly SpecialCheck[];
  /** Zeitlimit je Schritt bzw. Spezialprüfung (Standard 30 s) */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const SETUP_SECTION = "Einrichtung";
/** Schritt, der selbst alle anderen abfragt */
const AGGREGATE_STEP: StepId = "pruefung";

/** Lesende Anbieter: dieselben Argumente, dieselbe Antwort, nur eine Anfrage */
const CACHED: ReadonlyArray<keyof Providers> = ["telegramGetMe", "telegramCheckGroup", "supabaseQuery", "claudeVersion", "engineCheck", "openrouterKey", "ollamaTags"];
/** Anbieter mit Wirkung nach außen: im Bericht nie */
const BLOCKED: ReadonlyArray<keyof Providers> = ["telegramSendTest", "supabaseWriteProbe", "claudeProbe"];

export class BlockedInReportError extends Error {
  constructor(method: string) {
    super(`${method} ist im Prüfbericht gesperrt`);
    this.name = "BlockedInReportError";
  }
}

class TimeoutReached extends Error {
  name = "TimeoutReached";
}

/**
 * Anmeldung von Claude Code laut .env des Projekts (Issue #349): CLAUDE_AUTH
 * und ANTHROPIC_API_KEY kommen gemeinsam von dort, nie aus der Shell;
 * Platzhalter zählen als nicht gesetzt.
 */
export function projectClaudeAuth(env: Env): Record<string, string | undefined> {
  return { CLAUDE_AUTH: presentValue(env, "CLAUDE_AUTH"), ANTHROPIC_API_KEY: presentValue(env, "ANTHROPIC_API_KEY") };
}

/**
 * Claude Code im Bericht und in der Einrichtungsprobe: im Projektordner (ein
 * relativer CLAUDE_PATH gilt von dort), mit der gefilterten Umgebung und der
 * Anmeldung allein aus der .env des Projekts (projectClaudeAuth). CLAUDE_AUTH
 * steht dort als gültiger Modus, damit claudeAuthProblem(env) dieselbe
 * Antwort gibt. Im Bericht mit ctx.enginePath als PATH (Issue #567).
 */
export function claudeRunContext(ctx: SetupContext, env: Env): Required<ClaudeRunContext> {
  const auth = projectClaudeAuth(env);
  const filtered: Record<string, string> = { ...filterSubprocessEnv({ cwd: ctx.root, home: ctx.home }).env, ...SUBPROCESS_MARKER };
  const runEnv = withClaudeAuth(filtered, auth);
  runEnv.CLAUDE_AUTH = resolveClaudeAuth(auth).mode;
  if (ctx.enginePath !== undefined) runEnv.PATH = ctx.enginePath;
  return { cwd: ctx.root, env: runEnv };
}

/**
 * Anbieter für den Bericht: lesende mit Zwischenspeicher, wirkende gesperrt.
 * claudeVersion läuft immer mit claude (Ordner und Umgebung des Berichts,
 * ein mitgegebener Kontext zählt nicht) und wird nur nach dem Pfad
 * zwischengespeichert, egal wer fragt.
 */
export function reportProviders(inner: Providers, claude?: ClaudeRunContext): Providers {
  const wrapped = { ...inner } as Record<keyof Providers, (...args: unknown[]) => Promise<unknown>>;
  const bound: Partial<Record<keyof Providers, (...args: unknown[]) => Promise<unknown>>> = {
    claudeVersion: (path: unknown) => inner.claudeVersion(path as string, claude),
  };
  for (const name of CACHED) {
    const original = bound[name] ?? (inner[name] as (...args: unknown[]) => Promise<unknown>);
    const memo = new Map<string, Promise<unknown>>();
    wrapped[name] = (...args: unknown[]) => {
      const key = JSON.stringify(name === "claudeVersion" ? args.slice(0, 1) : args);
      let hit = memo.get(key);
      if (!hit) {
        hit = original.apply(inner, args);
        memo.set(key, hit);
      }
      return hit;
    };
  }
  for (const name of BLOCKED) {
    wrapped[name] = async () => {
      throw new BlockedInReportError(name);
    };
  }
  return wrapped as unknown as Providers;
}

/**
 * Kontext für den Bericht: nie ein Modellaufruf, Anbieter wie
 * reportProviders, Claude Code mit der .env env. enginePath: PATH des
 * Bot-Diensts für alle Motor-Prüfungen, undefined heißt PATH dieser Shell.
 */
export function reportContext(ctx: SetupContext, env: Env, enginePath?: string): SetupContext {
  const report: SetupContext = { ...ctx, noModelCalls: true, enginePath };
  return { ...report, providers: reportProviders(ctx.providers, claudeRunContext(report, env)) };
}

/** Werte geheimer Variablen (…_TOKEN, …_KEY, Passwörter) aus der .env */
export function secretValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => !!value && isSecretName(name))
    .map(([, value]) => value!.trim())
    .filter(value => value.length >= 4);
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Läuft fn länger als ms, gilt sie als gescheitert; das Signal sagt ihr Bescheid */
async function bounded<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutReached());
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function failureText(e: unknown, ms: number): string {
  if (e instanceof TimeoutReached) return `keine Antwort nach ${Math.round(ms / 1000)} s`;
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

/** Zustand eines Schritts als Zeile: optional und offen ist übersprungen, Pflicht und offen ein Fehler */
export function stepLine(step: Pick<SetupStep, "title" | "optional">, status: StepStatus): CheckLine {
  const base = { section: SETUP_SECTION, label: step.title };
  if (status.state === "erledigt") return { ...base, status: "pass", detail: status.detail };
  if (status.advisory && status.state === "teilweise") return { ...base, status: "warn", detail: status.detail };
  if (step.optional) {
    return status.state === "fehlt"
      ? { ...base, status: "skip", detail: `Übersprungen: ${status.detail}` }
      : { ...base, status: "warn", detail: status.detail };
  }
  return { ...base, status: "fail", detail: status.detail };
}

/** Sammelt alle Zeilen; wirft nie, auch wenn einzelne Prüfungen scheitern */
export async function collectReport(options: CollectOptions): Promise<Report> {
  const ms = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = await readSetupEnv(options.ctx).catch(() => ({}) as Env);
  // Erst zur Laufzeit geladen: ./engine.ts braucht selbst claudeRunContext von hier
  const { engineCheckPath } = await import("./engine");
  const ctx = reportContext(options.ctx, env, await engineCheckPath(options.ctx));
  const lines: CheckLine[] = [];
  const statuses = new Map<StepId, StepStatus>();

  for (const step of options.steps) {
    if (step.id === AGGREGATE_STEP) continue;
    try {
      const status = await bounded(ms, () => step.status(ctx));
      statuses.set(step.id, status);
      lines.push(stepLine(step, status));
    } catch (e) {
      lines.push({ section: SETUP_SECTION, label: step.title, status: "fail", detail: `Zustand nicht ermittelbar: ${failureText(e, ms)}` });
    }
  }

  const channels = overallChannels(env);
  lines.push({ section: SETUP_SECTION, label: "Kanal", status: channels.ready ? "pass" : "fail", detail: channels.message });

  for (const special of options.specials) {
    try {
      const found = await bounded(ms, signal => special.run({ ctx, env, statuses, signal }));
      for (const f of found) lines.push({ section: special.section, ...f });
    } catch (e) {
      lines.push({ section: special.section, label: special.id, status: "fail", detail: `Prüfung gescheitert: ${failureText(e, ms)}` });
    }
  }

  const secrets = secretValues(env);
  return { lines: lines.map(l => ({ ...l, detail: redact(l.detail.replace(ANSI, ""), secrets, 300) })) };
}

/** 1, sobald eine Zeile fehlgeschlagen ist, sonst 0 */
export function reportExitCode(report: Report): 0 | 1 {
  return report.lines.some(l => l.status === "fail") ? 1 : 0;
}

const MARK: Record<CheckStatus, string> = { pass: "✓", fail: "✗", warn: "~", skip: "-" };

/** Bericht als Textzeilen, nach Abschnitten in der Reihenfolge ihres ersten Auftretens */
export function formatReport(report: Report): string[] {
  const out: string[] = [`${BRAND.name}: Prüfbericht`, ""];
  const sections = [...new Set(report.lines.map(l => l.section))];
  for (const section of sections) {
    out.push(section);
    for (const l of report.lines.filter(x => x.section === section)) out.push(`  ${MARK[l.status]} ${l.label}: ${l.detail}`);
    out.push("");
  }
  const count = (s: CheckStatus) => report.lines.filter(l => l.status === s).length;
  const parts = [`${count("pass")} bestanden`];
  if (count("fail")) parts.push(`${count("fail")} fehlgeschlagen`);
  if (count("warn")) parts.push(`${count("warn")} Warnungen`);
  if (count("skip")) parts.push(`${count("skip")} übersprungen`);
  out.push(`Ergebnis: ${parts.join(", ")}`);
  if (count("fail")) out.push("Nicht alles in Ordnung: erst die Zeilen mit ✗ beheben.");
  else if (count("warn")) out.push("Alles Nötige ist in Ordnung, die Zeilen mit ~ bitte ansehen.");
  else out.push(`Alles in Ordnung, ${BRAND.name} kann starten.`);
  return out;
}
