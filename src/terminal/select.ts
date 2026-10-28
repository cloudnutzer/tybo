/**
 * Gesprächswahl beim Start von tybo (Issue #60).
 *
 * Reihenfolge: --topic vor dem zuletzt genutzten Gespräch (state.json) vor
 * dem Direktchat. Gibt es keinen Direktchat (TELEGRAM_USER_ID fehlt), gilt
 * General (topic-1), sonst das erste Gespräch der Liste.
 *
 * --topic akzeptiert dm, topic-<n>, eine bloße Nummer <n>, die ID eines
 * älteren Web-Gesprächs oder den Namen (Groß- und Kleinschreibung egal,
 * genau so geschrieben, kein Teilwort). Mehrere Gespräche mit diesem Namen
 * sind ein Fehler mit den IDs zur Auswahl; tybo rät nicht.
 */

import { BRAND } from "../brand";
import type { ConversationSummary } from "./api";
import { sanitizeLine } from "./sanitize";

export type Selection =
  | { ok: true; conversation: ConversationSummary; note?: string }
  | { ok: false; error: string };

function normalizeName(value: string): string {
  return sanitizeLine(value).toLocaleLowerCase("de");
}

function describe(c: ConversationSummary): string {
  return `${sanitizeLine(c.title)} (${c.id})`;
}

function defaultConversation(list: ConversationSummary[]): ConversationSummary | null {
  return list.find(c => c.kind === "dm") ?? list.find(c => c.id === "topic-1") ?? list[0] ?? null;
}

/** Findet das Gespräch zu --topic; null-Treffer und doppelte Namen sind Fehler */
export function findConversation(list: ConversationSummary[], wanted: string): Selection {
  const value = wanted.trim();
  if (!value) return { ok: false, error: "--topic braucht einen Namen oder eine ID." };
  const byId = (id: string) => list.find(c => c.id === id);
  const lower = value.toLowerCase();
  const idCandidate = /^[1-9][0-9]{0,9}$/.test(value) ? `topic-${value}` : lower === "direktchat" ? "dm" : value;
  const exact = byId(idCandidate) ?? byId(lower);
  if (exact) return { ok: true, conversation: exact };

  const name = normalizeName(value);
  const matches = list.filter(c => normalizeName(c.title) === name);
  if (matches.length === 1) return { ok: true, conversation: matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      error: `Mehrere Gespräche heißen „${sanitizeLine(value)}": ${matches.map(describe).join(", ")}. Mit --topic <ID> genau eins wählen.`,
    };
  }
  const known = list.map(describe).join(", ") || "keine";
  return { ok: false, error: `Kein Gespräch „${sanitizeLine(value)}" gefunden. Vorhanden: ${known}.` };
}

export function selectConversation(list: ConversationSummary[], options: { topic?: string; savedId?: string | null }): Selection {
  if (options.topic !== undefined) return findConversation(list, options.topic);
  const fallback = defaultConversation(list);
  if (options.savedId) {
    const saved = list.find(c => c.id === options.savedId);
    if (saved && !saved.closed) return { ok: true, conversation: saved };
    if (!fallback) return { ok: false, error: `Es gibt kein Gespräch, in das ${BRAND.name} schreiben könnte.` };
    const target = fallback.kind === "dm" ? "im Direktchat" : `in ${sanitizeLine(fallback.title)}`;
    const note = saved
      ? `Das zuletzt genutzte Gespräch ${describe(saved)} ist geschlossen, weiter ${target}.`
      : `Das zuletzt genutzte Gespräch gibt es nicht mehr, weiter ${target}.`;
    return { ok: true, conversation: fallback, note };
  }
  if (!fallback) return { ok: false, error: `Es gibt kein Gespräch, in das ${BRAND.name} schreiben könnte.` };
  return { ok: true, conversation: fallback };
}
