/**
 * Dauerhafte Liste der Telefonanrufe (Issue #366).
 *
 * Je Anruf ein Eintrag mit eigener Kennung (ref), Anlass, Zielgespräch
 * (Telegram-Chat samt Topic oder Web-Direktchat), Zeitpunkt, Frist für das
 * Protokoll und Bearbeitungsstand. Bot und Sprach-Brücke sind getrennte
 * Prozesse: die Brücke liest hier den Anlass, der Bot schreibt und
 * verarbeitet. Gespeichert über updateJsonState (SQLite neben
 * data/phone-calls.json, eine Transaktion je Änderung), also über Prozesse
 * hinweg atomar und nach einem Neustart wieder da.
 *
 * Stände und ihre Reihenfolge:
 *   dialing    Eintrag steht, der Anbieter wählt gerade
 *   waiting    Anruf ausgelöst, Protokoll wird abgeholt
 *   received   Protokoll steht im Eintrag (abgefragt oder per Webhook),
 *              Zusammenfassung steht aus; weder Frist noch Anbieterfehler
 *              beenden den Eintrag jetzt noch
 *   summarized Protokoll und Zusammenfassung stehen im Eintrag, Versand
 *              ausstehend (nach einer Ablehnung mit Versuchen und Termin)
 *   reporting  Zusammenfassung wird zugestellt
 *   reported   Zusammenfassung ist raus, Auftragssuche steht an
 *   asking     Rückfrage zum Auftrag wird angelegt
 *   asked      Rückfrage steht, wartet auf die Entscheidung
 *   closed     fertig (auch: entschieden, kein Auftrag, leeres Protokoll)
 *   failed     gescheitert (Anwahl, Zeitablauf, Anbieterfehler); nach
 *              gescheiterter Abholung (lateTranscript) nimmt ein später
 *              per Webhook geliefertes Protokoll den Eintrag wieder auf
 *              (failed nach received, einmalig)
 * Jeder Übergang ist bedingt (advance mit erlaubten Ausgangsständen): wer
 * einen Stand nicht mehr vorfindet, tut nichts. So entsteht nach einem
 * Neustart weder eine zweite Anwahl noch eine zweite Zusammenfassung oder
 * Rückfrage; "reporting" gilt nach einem Abbruch als erledigt (höchstens
 * einmal statt doppelt), "asking" wird mit dem Rückfragen-Register
 * abgeglichen (service.ts).
 *
 * Anrufe, die tybo nicht selbst gewählt hat, legt claim beim ersten
 * gelieferten Protokoll an: Suche nach der Kennung beim Anbieter und Anlegen
 * in einer Transaktion, also je Kennung höchstens ein Eintrag, auch über
 * Prozesse und Neustarts hinweg.
 *
 * Das Protokoll (transcript) bleibt nur so lange im Eintrag, wie es jemand
 * braucht: bis zur Auftragssuche, und darüber hinaus, solange die Ablage im
 * Verlauf aussteht (recordPending: eingerichteter Speicher vorübergehend
 * nicht erreichbar). Solche Einträge räumt auch die Aufräumfrist nicht weg;
 * erst nach der Ablage fällt das Protokoll heraus.
 */

import { join } from "path";
import type { ChoiceConversation } from "../choices";
import { updateJsonState } from "../json-state";

export const CALL_STAGES = ["dialing", "waiting", "received", "summarized", "reporting", "reported", "asking", "asked", "closed", "failed"] as const;
export type CallStage = (typeof CALL_STAGES)[number];

/** Stände, in denen nichts mehr passiert */
export const FINAL_STAGES: readonly CallStage[] = ["closed", "failed"];

/** Ab diesen Ständen braucht niemand mehr das Protokoll, außer die Ablage im Verlauf steht aus */
const TRANSCRIPT_DONE_STAGES: readonly CallStage[] = ["asking", "asked", "closed", "failed"];

/** Abgeschlossene Einträge bleiben so lange stehen (Anlass für späte Brücken-Turns, Fehlersuche) */
export const KEEP_FINISHED_MS = 7 * 24 * 3_600_000;

export interface CallRecord {
  ref: string;
  reason: string;
  conversation: ChoiceConversation;
  /** Name des Nutzers für das Protokoll */
  userName: string;
  createdAt: number;
  /** Bis hierhin wird das Protokoll abgeholt; ab received: so lange versucht es das Modell */
  deadline: number;
  stage: CallStage;
  updatedAt: number;
  /** Kennung beim Anbieter (ElevenLabs conversation_id) */
  conversationId?: string;
  /** Anruf kam nicht von tybo, angelegt beim gelieferten Protokoll */
  inbound?: true;
  /** Ab received bis zur Auftragssuche, länger nur bei ausstehender Ablage (recordPending) */
  transcript?: string;
  summary?: string;
  task?: string;
  choiceId?: string;
  /** Protokoll steht im Verlauf (record), nie ein zweites Mal */
  recorded?: true;
  /** Ablage im Verlauf gescheitert, wird nachgeholt; bis dahin bleibt das Protokoll */
  recordPending?: true;
  /** Gescheiterte Versuche der Ablage */
  recordAttempts?: number;
  /** Nächster Versuch der Ablage nicht vor diesem Zeitpunkt */
  recordRetryAt?: number;
  /** Abgelehnte Versuche der Zusammenfassung */
  sendAttempts?: number;
  /** Nächster Versuch der Zusammenfassung nicht vor diesem Zeitpunkt */
  retryAt?: number;
  /** Abholung gescheitert (Frist, Anbieterfehler), noch kein Protokoll: ein spät geliefertes wird übernommen */
  lateTranscript?: true;
  /** Kurzer Grund bei failed oder einem Sonderfall, nie Gesprächsinhalt */
  note?: string;
}

interface LedgerFile {
  calls: Record<string, CallRecord>;
}

export function phoneLedgerPath(root: string = process.env.GO_PROJECT_ROOT || process.cwd()): string {
  return join(root, "data", "phone-calls.json");
}

export interface PhoneLedger {
  add(record: CallRecord): void;
  get(ref: string): CallRecord | undefined;
  /** Eintrag zur Kennung beim Anbieter */
  byConversationId(conversationId: string): CallRecord | undefined;
  /**
   * Eintrag zur Kennung beim Anbieter oder, wenn es keinen gibt, record
   * anlegen; in einer Transaktion. created: true nur für den, der anlegte
   */
  claim(record: CallRecord & { conversationId: string }): { call: CallRecord; created: boolean };
  /** Alle Einträge, die noch nicht fertig sind */
  open(): CallRecord[];
  /** Alle Einträge mit ausstehender Ablage im Verlauf, auch fertige */
  recordsPending(): CallRecord[];
  /**
   * Bedingter Übergang: nur wenn der Eintrag in einem der Stände from steht
   * und when (falls angegeben) ihn zulässt, in derselben Transaktion geprüft.
   * Felder mit undefined in patch werden entfernt. Gibt den neuen Eintrag
   * zurück oder null (fehlt, anderer Stand bzw. when lehnt ab).
   */
  advance(
    ref: string,
    from: readonly CallStage[],
    to: CallStage,
    patch?: Partial<CallRecord>,
    when?: (call: CallRecord) => boolean,
  ): CallRecord | null;
  /**
   * Felder ändern, ohne den Stand: patch bekommt den aktuellen Eintrag und
   * gibt die Änderung zurück (null: nichts tun). Gibt den neuen Eintrag zurück
   * oder null.
   */
  patch(ref: string, patch: (call: CallRecord) => Partial<CallRecord> | null): CallRecord | null;
}

/** Änderung anwenden: undefined entfernt ein Feld, ein nicht mehr gebrauchtes Protokoll fällt heraus */
function applyPatch(call: CallRecord, patch: Partial<CallRecord>, stage: CallStage, at: number): CallRecord {
  const next: Record<string, unknown> = { ...call, ...patch, stage, updatedAt: at };
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
  if (!next.recordPending && TRANSCRIPT_DONE_STAGES.includes(stage)) delete next.transcript;
  return next as unknown as CallRecord;
}

export function createPhoneLedger(path: string, now: () => number = Date.now): PhoneLedger {
  const update = <R>(fn: (file: LedgerFile) => R): R =>
    updateJsonState<LedgerFile, R>(path, () => ({ calls: {} }), file => {
      if (!file.calls || typeof file.calls !== "object") file.calls = {};
      const cutoff = now() - KEEP_FINISHED_MS;
      for (const [ref, call] of Object.entries(file.calls)) {
        if (FINAL_STAGES.includes(call.stage) && !call.recordPending && call.updatedAt < cutoff) delete file.calls[ref];
      }
      return fn(file);
    });
  const copy = (record: CallRecord | undefined) => (record ? { ...record } : undefined);

  return {
    add(record) {
      update(file => {
        if (file.calls[record.ref]) throw new Error("Anruf-Kennung schon vergeben");
        file.calls[record.ref] = { ...record };
      });
    },
    get: ref => update(file => copy(file.calls[ref])),
    byConversationId: conversationId =>
      update(file => copy(Object.values(file.calls).find(call => call.conversationId === conversationId))),
    claim(record) {
      return update(file => {
        const existing = Object.values(file.calls).find(call => call.conversationId === record.conversationId);
        if (existing) return { call: { ...existing }, created: false };
        if (file.calls[record.ref]) throw new Error("Anruf-Kennung schon vergeben");
        file.calls[record.ref] = { ...record };
        return { call: { ...record }, created: true };
      });
    },
    open: () => update(file => Object.values(file.calls).filter(call => !FINAL_STAGES.includes(call.stage)).map(call => ({ ...call }))),
    recordsPending: () => update(file => Object.values(file.calls).filter(call => call.recordPending).map(call => ({ ...call }))),
    advance(ref, from, to, patch = {}, when) {
      return update(file => {
        const call = file.calls[ref];
        if (!call || !from.includes(call.stage) || (when && !when({ ...call }))) return null;
        const next = applyPatch(call, patch, to, now());
        file.calls[ref] = next;
        return { ...next };
      });
    },
    patch(ref, patch) {
      return update(file => {
        const call = file.calls[ref];
        const change = call ? patch({ ...call }) : null;
        if (!call || !change) return null;
        const next = applyPatch(call, change, call.stage, now());
        file.calls[ref] = next;
        return { ...next };
      });
    },
  };
}
