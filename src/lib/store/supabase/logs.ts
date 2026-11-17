/**
 * Supabase-Adapter für das Protokoll und den Verbindungstest (Issue #312).
 *
 * Die Tabelle logs (db/schema.sql) kennt keine Spalte service, verlangt
 * aber event: der Dienstname aus LogStore.write landet deshalb in event.
 * Eine Logzeile darf nie einen Ablauf stören, Fehler bleiben still.
 *
 * Meldung und Metadaten gehen ohne Telegram-Bot-Token in die Tabelle
 * (Issue #526), etwa der Absturzbericht samt Stack aus bot.ts.
 *
 * ping() liest eine id aus messages, der Tabelle, ohne die tybo nicht
 * arbeitet; auch eine leere Tabelle gilt als erreichbar. Es wirft nie.
 */
import type { LogStore } from "../ports";
import type { PingResult } from "../types";
import type { ClientSource } from "./messages";
import { maskDeep, maskTelegramTokens, telegramTokensFromEnv } from "../../telegram-token-mask";

const LOGS = "logs";
const PROBE_TABLE = "messages";

const NOT_CONFIGURED: PingResult = {
  ok: false,
  message: "Supabase nicht eingerichtet (SUPABASE_URL oder SUPABASE_SERVICE_ROLE_KEY fehlt).",
};

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function supabaseLogs(clientSource: ClientSource): LogStore {
  return {
    async write(level, service, message, metadata) {
      try {
        const client = clientSource();
        if (!client) return;
        const tokens = telegramTokensFromEnv(process.env);
        await client.from(LOGS).insert({
          level,
          event: service,
          message: maskTelegramTokens(message, tokens),
          metadata: metadata === undefined ? undefined : maskDeep(metadata, tokens),
        });
      } catch {
        // Protokoll ist Beiwerk: lieber eine Zeile verlieren als den Aufrufer stören
      }
    },
    async ping() {
      try {
        const client = clientSource();
        if (!client) return { ...NOT_CONFIGURED };
        const { error } = await client.from(PROBE_TABLE).select("id").limit(1);
        if (error) return { ok: false, message: `Supabase antwortet mit Fehler: ${error.message}` };
        return { ok: true, message: "Supabase-Verbindung steht." };
      } catch (err) {
        return { ok: false, message: `Supabase nicht erreichbar: ${reason(err)}` };
      }
    },
  };
}
