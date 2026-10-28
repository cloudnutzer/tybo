/**
 * Supabase-Adapter für Erinnerungen (Issue #321): Tabelle scheduled_tasks
 * aus db/migrations/20261017_scheduled_tasks.sql, die Spalten der Übernahme
 * (lease_owner, lease_until, send_started_at) aus 20261018_scheduled_tasks_lease.sql (#322).
 * updateIf ist eine einzige bedingte UPDATE-Anweisung: Postgres prüft die
 * Bedingung beim Schreiben der Zeile erneut, von zwei gleichzeitigen
 * Übernahmen trifft also nur eine. Tabellen- und
 * Spaltennamen sind Schnittstelle zur Datenbank. Die Vorgaben (id, status
 * pending, attempts 0, Zeitstempel) setzt die Datenbank; updated_at setzt
 * bei Änderungen der Adapter.
 *
 * Fehler und Ausnahmen ergeben null, false bzw. leere Listen; ohne Client
 * ebenso. Ausnahme ist listAll (Issue #323): es liest Seite für Seite, bis
 * eine leere kommt (PostgREST liefert je Antwort höchstens max_rows Zeilen,
 * supabase/config.toml), und meldet einen Fehler auf irgendeiner Seite als
 * null statt als leere Liste. Die Seiten folgen der ID, nicht der
 * Fälligkeit: Jede Seite beginnt hinter der letzten ID der vorigen. Die ID
 * ändert sich nie, also kommt jeder Eintrag, der während des ganzen Lesens
 * passt, genau einmal, auch wenn der Planer zwischen zwei Seiten eine Serie
 * fortschreibt (due_at neu) oder einen anderen Eintrag zustellt. Ein Versatz
 * (offset) würde in beiden Fällen verrutschen. Sortiert nach Fälligkeit
 * wird erst am Ende.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClientSource } from "../store/supabase/messages";
import { byDue, changeRow, FIXED_ID_PATTERN, newRow, validCondition, type ScheduledTask, type ScheduleKind, type ScheduleStatus, type ScheduleStore } from "./contract";

const TABLE = "scheduled_tasks";

/** Zeile, wie PostgREST sie liefert */
interface Row {
  id: string;
  chat_id: string;
  topic_id: number | string | null;
  kind: ScheduleKind;
  text: string;
  due_at: string;
  recurrence: string | null;
  status: ScheduleStatus;
  attempts: number;
  last_error: string | null;
  /** Fehlen vor der Migration 20261018 */
  lease_owner?: string | null;
  lease_until?: string | null;
  send_started_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface Answer {
  data: unknown;
  error: unknown;
}

/** Führt die Abfrage aus; Ausnahme oder Fehler der Datenbank ergeben null */
async function answered(run: () => PromiseLike<Answer>): Promise<Answer | null> {
  try {
    const result = await run();
    return result.error ? null : result;
  } catch {
    return null;
  }
}

/** Zeitpunkt der Datenbank (etwa +00:00) in der Form des Vertrags */
const iso = (value: string) => new Date(value).toISOString();

function toTask(row: Row): ScheduledTask {
  return {
    id: String(row.id),
    chatId: row.chat_id,
    topicId: row.topic_id === null || row.topic_id === undefined ? null : Number(row.topic_id),
    kind: row.kind,
    text: row.text,
    dueAt: iso(row.due_at),
    recurrence: row.recurrence ?? null,
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error ?? null,
    leaseOwner: row.lease_owner ?? null,
    leaseUntil: row.lease_until ? iso(row.lease_until) : null,
    sendStartedAt: row.send_started_at ? iso(row.send_started_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function rows(result: Answer | null): ScheduledTask[] {
  return result && Array.isArray(result.data) ? (result.data as Row[]).map(toTask) : [];
}

const stampNow = () => new Date(Date.now()).toISOString();

/** Zeilen je Seite in listAll; liefert die Datenbank weniger, geht es trotzdem weiter */
export const LIST_PAGE_SIZE = 1000;

const UUID_LOW = "00000000-0000-0000-0000-000000000000";
const UUID_HIGH = "ffffffff-ffff-ffff-ffff-ffffffffffff";

/**
 * Bereich der UUIDs mit diesem Anfang, für die Spalte id (Typ uuid, LIKE
 * geht dort nicht). Postgres vergleicht UUIDs byteweise, also wie ihre
 * Hex-Schreibweise. null, wenn der Anfang zu keiner UUID passen kann.
 */
export function uuidPrefixRange(prefix: string): { low: string; high: string } | null {
  const p = prefix.toLowerCase();
  if (p.length > UUID_LOW.length) return null;
  for (let i = 0; i < p.length; i++) {
    const ok = UUID_LOW[i] === "-" ? p[i] === "-" : /[0-9a-f]/.test(p[i]);
    if (!ok) return null;
  }
  return { low: p + UUID_LOW.slice(p.length), high: p + UUID_HIGH.slice(p.length) };
}

/** Erinnerungen über Supabase; der Client kommt bei jedem Aufruf frisch aus clientSource */
export function supabaseScheduleStore(clientSource: ClientSource): ScheduleStore {
  const withClient = async <T>(fallback: T, fn: (client: SupabaseClient) => Promise<T>): Promise<T> => {
    try {
      const client = clientSource();
      return client ? await fn(client) : fallback;
    } catch {
      return fallback;
    }
  };

  return {
    add: input => {
      const row = newRow(input);
      if (!row) return Promise.resolve(null);
      return withClient(null, async client => {
        const [task] = rows(await answered(() => client.from(TABLE).insert(row).select()));
        if (!task) console.error("[schedule] Erinnerung nicht angelegt");
        return task ?? null;
      });
    },
    addOnce: (id, input) => {
      const row = newRow(input);
      if (!row || !FIXED_ID_PATTERN.test(id)) return Promise.resolve("failed" as const);
      // ON CONFLICT (id) DO NOTHING: die Datenbank entscheidet beim Schreiben, zurück kommt nur eine neue Zeile
      return withClient("failed" as const, async client => {
        const result = await answered(() => client.from(TABLE).upsert({ id, ...row }, { onConflict: "id", ignoreDuplicates: true }).select("id"));
        if (!result || !Array.isArray(result.data)) return "failed" as const;
        return result.data.length > 0 ? ("added" as const) : ("exists" as const);
      });
    },
    byId: id =>
      withClient(null, async client => rows(await answered(() => client.from(TABLE).select("*").eq("id", id)))[0] ?? null),
    list: (filter = {}) =>
      withClient<ScheduledTask[]>([], async client => {
        let query = client.from(TABLE).select("*");
        if (filter.chatId !== undefined) query = query.eq("chat_id", filter.chatId);
        if (filter.topicId === null) query = query.is("topic_id", null);
        else if (filter.topicId !== undefined) query = query.eq("topic_id", filter.topicId);
        if (filter.status) query = query.in("status", filter.status);
        return rows(await answered(() => query.order("due_at", { ascending: true }).order("created_at", { ascending: true })));
      }),
    listAll: (filter = {}) =>
      withClient<ScheduledTask[] | null>(null, async client => {
        const range = filter.idPrefix !== undefined ? uuidPrefixRange(filter.idPrefix) : undefined;
        if (range === null) return [];
        const all: ScheduledTask[] = [];
        for (let after: string | null = null; ; ) {
          let query = client.from(TABLE).select("*");
          if (filter.chatId !== undefined) query = query.eq("chat_id", filter.chatId);
          if (filter.topicId === null) query = query.is("topic_id", null);
          else if (filter.topicId !== undefined) query = query.eq("topic_id", filter.topicId);
          if (filter.status) query = query.in("status", filter.status);
          if (range) query = query.gte("id", range.low).lte("id", range.high);
          if (after !== null) query = query.gt("id", after);
          const page = query.order("id", { ascending: true }).limit(LIST_PAGE_SIZE);
          const result = await answered(() => page);
          if (!result || !Array.isArray(result.data)) return null;
          if (result.data.length === 0) return all.sort((a, b) => byDue(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          all.push(...rows(result));
          after = String((result.data as Row[])[result.data.length - 1].id);
        }
      }),
    due: (now, limit, kind) =>
      withClient<ScheduledTask[]>([], async client => {
        if (!Number.isFinite(now.getTime()) || !(limit > 0)) return [];
        let query = client.from(TABLE).select("*").eq("status", "pending").lte("due_at", now.toISOString());
        if (kind !== undefined) query = query.eq("kind", kind);
        return rows(
          await answered(() =>
            query
              .order("due_at", { ascending: true })
              .order("created_at", { ascending: true })
              .limit(Math.floor(limit)),
          ),
        );
      }),
    update: (id, changes) => {
      const row = changeRow(changes);
      if (!row) return Promise.resolve(null);
      return withClient(null, async client => {
        const [task] = rows(await answered(() => client.from(TABLE).update({ ...row, updated_at: stampNow() }).eq("id", id).select()));
        return task ?? null;
      });
    },
    updateIf: (id, condition, changes) => {
      const row = changeRow(changes);
      if (!row || !validCondition(condition)) return Promise.resolve(null);
      return withClient(null, async client => {
        let query = client.from(TABLE).update({ ...row, updated_at: stampNow() }).eq("id", id);
        if (condition.status !== undefined) query = query.eq("status", condition.status);
        if (condition.dueAt !== undefined) query = query.eq("due_at", condition.dueAt.toISOString());
        if (condition.dueBy !== undefined) query = query.lte("due_at", condition.dueBy.toISOString());
        if (condition.leaseOwner === null) query = query.is("lease_owner", null);
        else if (condition.leaseOwner !== undefined) query = query.eq("lease_owner", condition.leaseOwner);
        if (condition.leaseUntilBefore !== undefined) query = query.lt("lease_until", condition.leaseUntilBefore.toISOString());
        if (condition.notSending === true) query = query.is("send_started_at", null);
        else if (condition.notSending === false) query = query.not("send_started_at", "is", null);
        const [task] = rows(await answered(() => query.select()));
        return task ?? null;
      });
    },
    cancel: id =>
      withClient(false, async client => {
        const result = await answered(() =>
          client.from(TABLE).update({ status: "cancelled", updated_at: stampNow() }).eq("id", id).eq("status", "pending").select("id"),
        );
        return Array.isArray(result?.data) && result.data.length > 0;
      }),
  };
}
