/**
 * Fehler-Auswertung der Claude-CLI (Issue #325). Maßgeblich ist das Signal
 * der CLI im result-Ereignis bzw. JSON-Objekt (is_error, subtype,
 * api_error_status). Ohne diese Felder entscheidet ein Textmuster. Ein
 * Erfolgssignal wird nur bei rejected zusammen mit leerem Text oder einem
 * belegten Limit-Meldungsanfang zum Fehler (Issue #652).
 *
 * So löst eine echte Antwort, die zufällig „billing" oder „usage limit"
 * enthält, keinen Fallback auf ein anderes Modell aus.
 */

import type { EngineErrorKind, EngineRateLimit } from "../engines/types";

/** Die drei Felder, mit denen die CLI selbst einen Fehler meldet */
export interface CliErrorSignal {
  is_error?: unknown;
  subtype?: unknown;
  api_error_status?: unknown;
}

const present = (v: unknown) => v !== undefined && v !== null;

/** Liegt wenigstens eines der drei CLI-Felder vor? */
export function hasCliSignal(fields: CliErrorSignal | null | undefined): boolean {
  if (!fields || typeof fields !== "object") return false;
  return present(fields.is_error) || present(fields.subtype) || present(fields.api_error_status);
}

/**
 * Meldet die CLI einen Fehler? Jedes Feld reicht für sich: is_error true, ein
 * subtype außer "success", ein api_error_status.
 */
export function isCliResultError(fields: CliErrorSignal | null | undefined): boolean {
  if (!fields || typeof fields !== "object") return false;
  if (fields.is_error === true) return true;
  if (typeof fields.subtype === "string" && fields.subtype !== "success") return true;
  return present(fields.api_error_status);
}

/** Immer ein Fehler, egal wie lang die Antwort ist */
const HARD_MARKERS = [
  "authentication_error", "api error: 401", "api error: 403", "api error: 429",
  "oauth token has expired", "failed to authenticate", "invalid_api_key",
  "overloaded_error", "rate_limit_error", "insufficient_quota", "payment_required",
];

/**
 * Nur in kurzen Antworten ein Fehler: in Recherchen und Finanzthemen kommen
 * diese Wörter ganz normal vor.
 */
const SHORT_REPLY_MARKERS = [
  "credit balance", "add funds", "billing", "hit your limit", "usage limit",
  "usage cap", "message limit", "reached your limit", "out of messages",
  "no messages remaining", "upgrade to", "exceeds your plan", "plan limit",
  "token limit reached", "conversation limit",
];

/** Unterhalb dieser Länge gelten auch die weichen Marker */
const SHORT_REPLY_CHARS = 500;

type ClaudeLimitKind = Extract<EngineErrorKind, "usage_limit" | "quota">;
type ClaudeLimitSignal = Pick<EngineRateLimit, "status" | "errorCode">;

/** Belegte Limit-Meldungen: nur kurze Texte, nur der Anfang, ohne führenden Leerraum. */
export function claudeLimitText(text: string): ClaudeLimitKind | undefined {
  const message = text.trimStart();
  if (message.length >= SHORT_REPLY_CHARS) return undefined;
  if (/^you['’]re out of usage credits\b/i.test(message)) return "quota";
  if (/^you['’]ve (?:hit|reached) your\b/i.test(message)) return "usage_limit";
  return undefined;
}

/** Fehlerart eines bereits als Fehler beurteilten Laufs; Kontingent geht vor Nutzungsgrenze. */
export function claudeLimitError(text: string, rateLimit?: ClaudeLimitSignal): ClaudeLimitKind | undefined {
  const fromText = claudeLimitText(text);
  if (rateLimit?.errorCode === "credits_required" || fromText === "quota") return "quota";
  if (rateLimit?.status === "rejected" || fromText === "usage_limit") return "usage_limit";
  return undefined;
}

/** Textmuster für Anmelde-, API- und Kontingentfehler; nur Rückfall ohne CLI-Signal */
export function isClaudeErrorResponse(text: string): boolean {
  const haystack = text.toLowerCase();
  const hit = (markers: string[]) => markers.some((m) => haystack.includes(m));
  return hit(HARD_MARKERS) || (text.length < SHORT_REPLY_CHARS && hit(SHORT_REPLY_MARKERS));
}

/**
 * Bedeutet ein Fehler wirklich, dass das Abo-Kontingent erschöpft ist? Der
 * Credit-Guard lernt daraus die Obergrenze des Plans; ein Fehlalarm
 * (Überlast, Netz, 5xx) würde eine falsche Grenze festschreiben. Darum nur
 * ausdrückliche Formulierungen.
 */
const CREDIT_LIMIT_MARKERS = [
  "usage limit reached", "hit your limit", "reached your limit", "credit balance",
  "out of messages", "no messages remaining", "insufficient_quota",
];

export function isCreditLimitError(text: string): boolean {
  const haystack = String(text ?? "").toLowerCase();
  return CREDIT_LIMIT_MARKERS.some((m) => haystack.includes(m));
}

/**
 * Gesamturteil: CLI-Fehler gelten immer. Gegen ein Erfolgssignal braucht es
 * rejected und leeren Text oder eine Limit-Meldung; ohne Signal reicht der Text.
 */
export function judgeClaudeResult(
  fields: CliErrorSignal | null | undefined,
  text: string,
  rateLimit?: ClaudeLimitSignal
): boolean {
  const limitText = claudeLimitText(text) !== undefined;
  const rejected = rateLimit?.status === "rejected";
  const empty = text.trim() === "";
  if (hasCliSignal(fields)) return isCliResultError(fields) || (rejected && (empty || limitText));
  return isClaudeErrorResponse(text) || limitText || (rejected && empty);
}
