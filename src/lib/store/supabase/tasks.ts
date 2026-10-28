/**
 * Supabase-Adapter für Aufträge mit Rückfrage und das Lebenszeichen der
 * Rechner (Issue #312). Ein Auftrag (Tabelle async_tasks) beginnt als
 * running; stellt tybo eine Rückfrage per Knopf, steht er auf needs_input,
 * bis der Nutzer tippt. Wer zu lange nicht antwortet, wird einmal erinnert
 * (reminder_sent). node_heartbeat hält je Rechner den letzten Zeitpunkt,
 * an dem er sich gemeldet hat; eine eigene Schleife dafür gibt es hier nicht.
 *
 * Änderungen gehen als JSON an PostgREST: ein Feld mit undefined fehlt im
 * Body und bleibt in der Datenbank, wie es ist (nie null). Tabellen- und
 * Spaltennamen sind Schnittstelle zur Datenbank. Fehler und Ausnahmen
 * ergeben null, false bzw. leere Listen; ohne Client ebenso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaskStore } from "../ports";
import type { AsyncTask, NodeStatus, TaskStatus } from "../types";
import type { ClientSource } from "./messages";

const TASKS = "async_tasks";
const NODES = "node_heartbeat";

const OFFLINE: NodeStatus = { online: false, lastHeartbeat: null };

/** Ergebnis einer PostgREST-Abfrage, soweit es hier gebraucht wird */
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

function asTasks(result: Answer | null): AsyncTask[] {
  return result && Array.isArray(result.data) ? (result.data as AsyncTask[]) : [];
}

function asTask(result: Answer | null): AsyncTask | null {
  const row = result?.data;
  return row && typeof row === "object" && !Array.isArray(row) ? (row as AsyncTask) : null;
}

/** Jetzt als ISO-Zeitpunkt (Date.now(), damit Tests die Uhr stellen können) */
const stampNow = () => new Date(Date.now()).toISOString();

/**
 * Aufträge und Lebenszeichen über Supabase. Der Client kommt bei jedem
 * Aufruf frisch aus clientSource.
 */
export function supabaseTasks(clientSource: ClientSource): TaskStore {
  const withClient = <T>(fallback: T, fn: (client: SupabaseClient) => Promise<T>): Promise<T> => {
    const client = clientSource();
    return client ? fn(client) : Promise.resolve(fallback);
  };

  /** Aufträge eines Chats in einem Zustand, neueste zuerst */
  const inState = (chatId: string, status: TaskStatus) =>
    withClient<AsyncTask[]>([], async client =>
      asTasks(
        await answered(() =>
          client.from(TASKS).select("*").eq("chat_id", chatId).eq("status", status).order("created_at", { ascending: false }),
        ),
      ),
    );

  return {
    create: (chatId, originalPrompt, threadId, processedBy) =>
      withClient(null, async client => {
        const row = { chat_id: chatId, original_prompt: originalPrompt, status: "running", thread_id: threadId, processed_by: processedBy };
        const result = await answered(() => client.from(TASKS).insert(row).select().single());
        if (!result) console.error("[store] Auftrag nicht angelegt");
        return asTask(result);
      }),
    update: (taskId, changes) =>
      withClient(false, async client => {
        const result = await answered(() => client.from(TASKS).update({ ...changes, updated_at: stampNow() }).eq("id", taskId));
        if (!result) console.error(`[store] Auftrag ${taskId} nicht geändert`);
        return result !== null;
      }),
    byId: taskId =>
      withClient(null, async client => asTask(await answered(() => client.from(TASKS).select("*").eq("id", taskId).maybeSingle()))),
    pending: chatId => inState(chatId, "needs_input"),
    running: chatId => inState(chatId, "running"),
    stale: olderThanMs =>
      withClient<AsyncTask[]>([], async client => {
        const before = new Date(Date.now() - olderThanMs).toISOString();
        return asTasks(
          await answered(() =>
            client.from(TASKS).select("*").eq("status", "needs_input").eq("reminder_sent", false).lt("updated_at", before),
          ),
        );
      }),
    heartbeat: (nodeId, metadata) =>
      withClient(false, async client => {
        const row = { node_id: nodeId, last_heartbeat: stampNow(), metadata: metadata ?? {} };
        const result = await answered(() => client.from(NODES).upsert(row, { onConflict: "node_id" }));
        if (!result) console.error(`[store] Lebenszeichen für ${nodeId} nicht gespeichert`);
        return result !== null;
      }),
    nodeStatus: (nodeId, maxAgeMs) =>
      withClient(OFFLINE, async client => {
        const result = await answered(() => client.from(NODES).select("last_heartbeat").eq("node_id", nodeId).maybeSingle());
        const last = (result?.data as { last_heartbeat?: unknown } | null)?.last_heartbeat;
        if (typeof last !== "string") return { ...OFFLINE };
        const age = Date.now() - Date.parse(last);
        return { online: age < maxAgeMs, lastHeartbeat: last };
      }),
  };
}
