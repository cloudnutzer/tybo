/**
 * Kosten aller Motoren (Issue #346): die eine Buchungsstelle für jeden
 * Motorlauf, der Abo-Zähler des Claude-Abos und dessen Meldungen.
 *
 * Jeder Lauf landet in `engine_runs` (spend/engine-runs.ts), immer, auch mit
 * CREDIT_GUARD=off und mit eigenem ANTHROPIC_API_KEY. Den Abo-Zähler
 * (spend/subscription.ts) erreichen nur Läufe mit Motor `claude`, und nur
 * bei aktiver Messung: CREDIT_GUARD nicht aus und Claude Code über das Abo
 * angemeldet (CLAUDE_AUTH, src/lib/engines/claude-auth.ts; Issue #349). Mit
 * CLAUDE_AUTH=subscription misst er also auch bei gesetztem
 * ANTHROPIC_API_KEY, mit apiKey nie. Codex, OpenCode und OpenRouter zählen nie
 * dort hinein; das Tagesbudget (`costs`) berührt dieses Modul nicht.
 *
 * Gelerntes Limit: endet ein Claude-Lauf mit einem Limit-Fehler, wird erst
 * dessen Kostenanteil gebucht und danach der Stand als Limit des Zyklus
 * festgehalten (nur der erste Wert je Zyklus). Erst danach wird die
 * Warnschwelle geprüft, mit dem dann gültigen Limit.
 *
 * Fail-open: keine Funktion hier wirft; Speicher- und Versandfehler landen
 * im Log, der Turn läuft weiter.
 */
import { BRAND } from "../../brand";
import { isCreditLimitError } from "../claude/result";
import { claudeUsesSubscription } from "../engines/claude-auth";
import type { EngineUsage } from "../engines/types";
import { engineTallies, storeEngineRun, type EngineRun, type EngineTally, type RunEngine, type RunOrigin } from "./engine-runs";
import { addCycleSpend, cycleStartUtc, markCycleWarned, readCycle, setObservedCeiling, type CycleSpend } from "./subscription";

/** Ein Lauf samt Ausgang; isError und text dienen nur der Limit-Erkennung */
export interface FinishedRun extends EngineRun {
  isError?: boolean;
  text?: string;
}

// ---------------------------------------------------------------------------
// Einstellungen (bei jedem Aufruf frisch aus der Umgebung)
// ---------------------------------------------------------------------------

export interface CreditSettings {
  /** CREDIT_GUARD nicht off/false/0/no */
  guardOn: boolean;
  /** Claude Code mit eigenem API-Schlüssel angemeldet (CLAUDE_AUTH): kein Abo-Guthaben */
  apiKey: boolean;
  /** CREDIT_RESET_DAY, Standard 1 */
  resetDay: number;
  /** CREDIT_CEILING_USD; null, wenn nicht gesetzt oder ungültig */
  ceilingUsd: number | null;
  /** CREDIT_WARN_PCT als Anteil, Standard 0,8 */
  warnShare: number;
  plan?: string;
}

const OFF_WORDS = ["off", "false", "0", "no"];

export function creditSettings(env: Record<string, string | undefined> = process.env): CreditSettings {
  const ceiling = env.CREDIT_CEILING_USD ? Number(env.CREDIT_CEILING_USD) : NaN;
  const share = env.CREDIT_WARN_PCT ? Number(env.CREDIT_WARN_PCT) : NaN;
  return {
    guardOn: !OFF_WORDS.includes((env.CREDIT_GUARD ?? "on").trim().toLowerCase()),
    apiKey: !claudeUsesSubscription(env),
    resetDay: Number(env.CREDIT_RESET_DAY || 1),
    ceilingUsd: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : null,
    warnShare: Number.isFinite(share) && share > 0 ? share : 0.8,
    ...(env.CREDIT_PLAN ? { plan: env.CREDIT_PLAN } : {}),
  };
}

/** Abo-Zähler und Warnung aktiv: Messung an und Claude Code über das Abo */
export function subscriptionMetering(settings: CreditSettings = creditSettings()): boolean {
  return settings.guardOn && !settings.apiKey;
}

/** Limit, dem der Zähler folgt: gelernt vor eingestellt, sonst keins */
export function cycleCeiling(cycle: CycleSpend | null, settings: CreditSettings): number | null {
  const learned = cycle?.observedCeilingUsd;
  if (learned != null && learned > 0) return learned;
  return settings.ceilingUsd;
}

// ---------------------------------------------------------------------------
// Versand
// ---------------------------------------------------------------------------

type Notifier = (text: string) => unknown;
let notifier: Notifier | null = null;

/** Versandweg für Warnung und Planhinweis (im Bot notices.plain aus user-notify); null nimmt ihn weg */
export function setCreditNotifier(send: Notifier | null): void {
  notifier = send;
}

async function deliver(text: string): Promise<void> {
  if (!notifier) return;
  try {
    await notifier(text);
  } catch (problem) {
    console.warn(`[spend] Guthaben-Meldung nicht zugestellt: ${problem instanceof Error ? problem.message : String(problem)}`);
  }
}

// ---------------------------------------------------------------------------
// Texte
// ---------------------------------------------------------------------------

const decimal = (value: number, digits: number): string =>
  value.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Betrag mit Cent: 16,40 $ */
export const dollars = (value: number): string => `${decimal(value, 2)} $`;

/** Limit: ganze Beträge ohne Cent (20 $), sonst mit (10,50 $) */
export const limitDollars = (value: number): string =>
  Number.isInteger(value) ? `${decimal(value, 0)} $` : dollars(value);

export function warningText(spendUsd: number, ceilingUsd: number): string {
  const percent = Math.round((100 * spendUsd) / ceilingUsd);
  return `💳 Du hast ${percent} % deines Claude-Guthabens verbraucht (${dollars(spendUsd)} von ${limitDollars(ceilingUsd)} in diesem Zyklus). Mehr mit /credit.`;
}

export function planChangedText(spendUsd: number, configuredUsd: number): string {
  return (
    `💳 Dein Claude-Guthaben war bei etwa ${dollars(spendUsd)} aufgebraucht, unter den eingestellten ${limitDollars(configuredUsd)}. ` +
    `Dein Plan hat sich offenbar geändert; ${BRAND.name} rechnet in diesem Zyklus mit dem gemessenen Wert. Mehr mit /plan.`
  );
}

// ---------------------------------------------------------------------------
// Buchung
// ---------------------------------------------------------------------------

const positive = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/**
 * Hält bei einem Limit-Fehler den Stand als Limit fest. Gibt den Zyklus mit
 * gelerntem Limit zurück und, nur für den Setzer, den Planhinweis.
 */
function learnCeiling(cycle: CycleSpend, settings: CreditSettings): { cycle: CycleSpend; note?: string } {
  const spend = cycle.cycleSpendUsd;
  if (!(spend > 0) || cycle.observedCeilingUsd != null) return { cycle };
  if (!setObservedCeiling(settings.resetDay, spend)) return { cycle };
  const learned = { ...cycle, observedCeilingUsd: spend };
  const configured = settings.ceilingUsd;
  if (configured != null && spend < configured * 0.75) return { cycle: learned, note: planChangedText(spend, configured) };
  return { cycle: learned };
}

/**
 * Warnung ab der Schwelle, einmal je Zyklus: markCycleWarned setzt den
 * Status atomar, nur der Setzer meldet (parallele Buchungen). Der Status
 * bleibt gesetzt, auch wenn der Versand danach scheitert.
 */
function warningDue(cycle: CycleSpend, settings: CreditSettings): string | undefined {
  const ceiling = cycleCeiling(cycle, settings);
  if (ceiling == null || cycle.warnedThisCycle) return undefined;
  if (cycle.cycleSpendUsd < ceiling * settings.warnShare) return undefined;
  if (!markCycleWarned(settings.resetDay)) return undefined;
  return warningText(cycle.cycleSpendUsd, ceiling);
}

/** Bucht einen Claude-Lauf in den Abo-Zähler; zurück kommen die zu versendenden Meldungen */
function meterClaudeRun(run: FinishedRun, settings: CreditSettings): string[] {
  const cost = positive(run.costUsd);
  // Ohne Kosten (oder mit 0 $) zählt der vorhandene Stand, damit Lernen und Warnung trotzdem greifen
  let cycle = cost !== null ? addCycleSpend(cost, settings.resetDay, settings.plan) : readCycle(settings.resetDay);
  if (!cycle) return [];
  const notes: string[] = [];
  if (run.isError && isCreditLimitError(run.text ?? "")) {
    const learned = learnCeiling(cycle, settings);
    cycle = learned.cycle;
    if (learned.note) notes.push(learned.note);
  }
  const warning = warningDue(cycle, settings);
  if (warning) notes.push(warning);
  return notes;
}

/**
 * Bucht einen Motorlauf: immer in `engine_runs`, bei Claude und aktiver
 * Messung zusätzlich in den Abo-Zähler samt Limit-Lernen und Warnung. Die
 * Speicherarbeit geschieht vor dem ersten await, also schon, wenn ein
 * Aufrufer das Promise nicht abwartet. Wirft nie.
 */
export async function bookEngineRun(run: FinishedRun): Promise<void> {
  let notes: string[] = [];
  try {
    storeEngineRun(run);
    const settings = creditSettings();
    if (run.engine === "claude" && subscriptionMetering(settings)) notes = meterClaudeRun(run, settings);
  } catch (problem) {
    console.warn(`[spend] Buchung gescheitert: ${problem instanceof Error ? problem.message : String(problem)}`);
  }
  for (const text of notes) await deliver(text);
}

const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Tokens aus dem usage eines Claude-result (Agent SDK, CLI-Strom) als
 * EngineUsage. Eingabe zählt wie bei Codex samt Cache (input_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens), cachedInputTokens
 * ist der Cache-Lesezugriff. Ohne verwertbare Zahl: undefined (nicht gemeldet).
 */
export function claudeUsage(raw: unknown): EngineUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const input = tokenCount(source.input_tokens);
  const created = tokenCount(source.cache_creation_input_tokens);
  const cached = tokenCount(source.cache_read_input_tokens);
  const output = tokenCount(source.output_tokens);
  const usage: EngineUsage = {};
  if (input !== undefined || created !== undefined || cached !== undefined) {
    usage.inputTokens = (input ?? 0) + (created ?? 0) + (cached ?? 0);
  }
  if (cached !== undefined) usage.cachedInputTokens = cached;
  if (output !== undefined) usage.outputTokens = output;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Ergebnis eines Laufs, wie es Motoren und callClaude liefern */
export interface RunOutcome {
  isError: boolean;
  text?: string;
  costUsd?: number;
  usage?: EngineUsage;
}

/** bookEngineRun für ein Motor- oder callClaude-Ergebnis; model wie übergeben, fehlt es: leer */
export function bookRunOutcome(origin: RunOrigin, engine: RunEngine, model: string | undefined, outcome: RunOutcome): Promise<void> {
  return bookEngineRun({
    engine,
    origin,
    ...(model ? { model } : {}),
    ...(outcome.usage ? { usage: outcome.usage } : {}),
    ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
    isError: outcome.isError,
    text: outcome.text ?? "",
  });
}

// ---------------------------------------------------------------------------
// /credit und /plan
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

const ENGINE_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  api: "Anthropic API",
  openrouter: "OpenRouter (Agent SDK)",
};

const counted = (n: number, one: string, many: string): string => `${decimal(n, 0)} ${n === 1 ? one : many}`;

const dateOf = (ms: number): string =>
  new Date(ms).toLocaleDateString("de-DE", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });

/** Tage bis zum nächsten Zyklusbeginn (aufgerundet) */
function daysUntilNextCycle(startMs: number, nowMs: number): number {
  const start = new Date(startMs);
  const next = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate());
  return Math.max(0, Math.ceil((next - nowMs) / DAY_MS));
}

function subscriptionLines(settings: CreditSettings, nowMs: number): string[] {
  if (settings.apiKey) return ["Eigener API-Schlüssel (ANTHROPIC_API_KEY): kein Abo-Guthaben zu beobachten."];
  if (!settings.guardOn) {
    return ["Messung ist aus (CREDIT_GUARD). Deine echten Limits siehst du auf claude.ai → Settings → Usage."];
  }
  const start = cycleStartUtc(settings.resetDay, nowMs);
  if (!Number.isFinite(start)) return ["Kein gültiger Reset-Tag (CREDIT_RESET_DAY), darum kein Zyklus. Mehr mit /plan."];
  const cycle = readCycle(settings.resetDay, nowMs);
  if (!cycle) return ["Stand gerade nicht lesbar."];
  const spend = cycle.cycleSpendUsd;
  const left = `Noch ${counted(daysUntilNextCycle(start, nowMs), "Tag", "Tage")} bis zum Reset.`;
  const ceiling = cycleCeiling(cycle, settings);
  if (ceiling == null) {
    return [
      `${dollars(spend)} in diesem Zyklus. ${left}`,
      "Kein Limit eingestellt, darum keine Warnung. Wie du es setzt, steht unter /plan; sonst messe ich es, sobald das Guthaben einmal aufgebraucht ist.",
    ];
  }
  const learned = cycle.observedCeilingUsd != null && cycle.observedCeilingUsd > 0;
  const percent = Math.round((100 * spend) / ceiling);
  return [`${dollars(spend)} von ${limitDollars(ceiling)} (${percent} %)${learned ? ", Limit in diesem Zyklus gemessen" : ""}. ${left}`];
}

function tokenText(tally: EngineTally): string {
  if (tally.inputTokens === null && tally.outputTokens === null) return "Tokens nicht gemeldet";
  const input = tally.inputTokens ?? 0;
  const output = tally.outputTokens ?? 0;
  return `${counted(input + output, "Token", "Tokens")} (${decimal(input, 0)} ein, ${decimal(output, 0)} aus)`;
}

/** Gemeldete 0 $ bleiben 0 $; ohne jede Meldung nie 0 $, sondern „Kosten nicht gemeldet" */
function costText(tally: EngineTally): string {
  if (tally.pricedRuns === 0) return "Kosten nicht gemeldet";
  const unpriced = tally.runs - tally.pricedRuns;
  const sum = dollars(tally.reportedUsd);
  return unpriced > 0 ? `${sum} (${counted(unpriced, "Lauf", "Läufe")} ohne Kostenmeldung)` : sum;
}

function engineLines(settings: CreditSettings, nowMs: number): { since: number; lines: string[] } {
  const start = cycleStartUtc(settings.resetDay, nowMs);
  // Ohne gültigen Reset-Tag zählt der Kalendermonat
  const since = Number.isFinite(start) ? start : cycleStartUtc(1, nowMs);
  const tallies = engineTallies(since);
  if (tallies === null) return { since, lines: ["Läufe gerade nicht lesbar."] };
  if (tallies.length === 0) return { since, lines: ["Noch keine Läufe in diesem Zyklus."] };
  return {
    since,
    lines: tallies.map(
      (tally) => `- ${ENGINE_NAMES[tally.engine] ?? tally.engine}: ${counted(tally.runs, "Lauf", "Läufe")}, ${tokenText(tally)}, ${costText(tally)}`,
    ),
  };
}

/** Text für /credit: Claude-Abo und Motoren im laufenden Zyklus (Markdown). Wirft nie. */
export function creditReport(nowMs: number = Date.now()): string {
  const settings = creditSettings();
  const engines = engineLines(settings, nowMs);
  return [
    "💳 **Claude-Abo**",
    ...subscriptionLines(settings, nowMs),
    "",
    `⚙️ **Motoren seit ${dateOf(engines.since)}**`,
    ...engines.lines,
  ].join("\n");
}

/** Text für /plan: Limit, gemessenes Limit, Reset-Tag und wie man sie setzt (Markdown). Wirft nie. */
export function planReport(nowMs: number = Date.now()): string {
  const settings = creditSettings();
  const title = "💳 **Claude-Abo: Limit und Zyklus**";
  if (settings.apiKey) {
    return `${title}\nDu nutzt einen eigenen API-Schlüssel (ANTHROPIC_API_KEY). Es gibt kein Abo-Guthaben, also nichts einzustellen.`;
  }
  const start = cycleStartUtc(settings.resetDay, nowMs);
  const cycle = Number.isFinite(start) ? readCycle(settings.resetDay, nowMs) : null;
  const learned = cycle?.observedCeilingUsd;
  const lines = [
    title,
    `Eingestelltes Limit: ${settings.ceilingUsd != null ? `${limitDollars(settings.ceilingUsd)} (CREDIT_CEILING_USD)` : "keins (CREDIT_CEILING_USD nicht gesetzt)"}`,
    ...(learned != null && learned > 0 ? [`Gemessenes Limit in diesem Zyklus: ${dollars(learned)} (gilt vor dem eingestellten)`] : []),
    Number.isFinite(start)
      ? `Reset-Tag: ${new Date(start).getUTCDate()}. des Monats (CREDIT_RESET_DAY)`
      : "Reset-Tag: ungültig (CREDIT_RESET_DAY), darum kein Zyklus",
    ...(settings.guardOn ? [] : ["Messung ist aus (CREDIT_GUARD): kein Abo-Zähler, keine Warnung."]),
    "",
    `So stellst du es ein: CREDIT_CEILING_USD (monatliches Guthaben deines Plans in Dollar) und CREDIT_RESET_DAY (Tag 1 bis 28, an dem dein Abrechnungszyklus beginnt) in die .env schreiben, dann ${BRAND.name} neu starten. Richtwerte: Pro 20 $, Max 5x 100 $, Max 20x 200 $.`,
    `Ist das Guthaben einmal aufgebraucht, merke ich mir den Stand als Limit für diesen Zyklus. Die Warnung kommt ab ${Math.round(settings.warnShare * 100)} %.`,
  ];
  return lines.join("\n");
}
