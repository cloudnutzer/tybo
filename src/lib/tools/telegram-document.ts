/**
 * Telegram Built-in — Datei als Dokument an den Owner schicken.
 *
 * Empfaenger ist immer der Owner: ohne topic_id sein Direktchat
 * (TELEGRAM_USER_ID), mit topic_id ausschliesslich ein Topic der
 * konfigurierten Forum-Gruppe (1 = General). Kein frei waehlbarer Chat:
 * damit ist der Versand eine Inward-Aktion und braucht kein HITL-Gate.
 * Ungueltige topic_id oder fehlende Gruppe ergeben einen Fehler, nie eine
 * Umleitung in den Direktchat. Versand ueber sendAndRecord (Quelle datei,
 * Entscheidung 0006), damit die Datei auch in der WebUI erscheint.
 * Bot-API-Limit fuer Uploads: 50 MB.
 */

import { existsSync, statSync } from "fs";
import { basename, isAbsolute } from "path";
import { optionalCredential } from "../credentials";
import { GENERAL_TOPIC_ID, MAX_CAPTION_CHARS, MAX_FILE_BYTES, defaultOutboxDeps, sendAndRecord, type OutboxDeps } from "../outbox";
import { registerBuiltinTool } from "./registry";

function botToken(): string {
  return optionalCredential("TELEGRAM_BOT_TOKEN");
}

function ownerChatId(): string {
  return optionalCredential("TELEGRAM_USER_ID");
}

/** Outbox-Abhaengigkeiten mit Token und Owner aus der Credential Registry */
function documentOutboxDeps(): OutboxDeps {
  return { ...defaultOutboxDeps(), botToken: botToken(), userId: ownerChatId() };
}

/** topic_id als positive ganze Zahl (auch als Ziffernfolge), sonst null */
function parseTopicId(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 1 ? value : null;
  if (typeof value === "string" && /^[1-9]\d{0,9}$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * Fuehrt telegram_send_document aus. Eingabefehler kommen als JSON mit
 * error zurueck, ohne Versand; lehnt Telegram ab, wird geworfen (die
 * Registry meldet das als isError).
 */
export async function sendDocumentTool(args: Record<string, unknown>, deps: OutboxDeps = documentOutboxDeps()): Promise<string> {
  const filePath = String(args.file_path || "");
  if (!isAbsolute(filePath)) {
    return JSON.stringify({ error: "file_path muss absolut sein" });
  }
  if (!existsSync(filePath)) {
    return JSON.stringify({ error: `Datei nicht gefunden: ${filePath}` });
  }
  const size = statSync(filePath).size;
  if (size === 0) {
    return JSON.stringify({ error: "Datei ist leer" });
  }
  if (size > MAX_FILE_BYTES) {
    return JSON.stringify({
      error: `Datei zu gross (${(size / 1e6).toFixed(1)} MB, Telegram-Limit 50 MB)`,
    });
  }

  let topicId: number | undefined;
  if (args.topic_id !== undefined && args.topic_id !== null) {
    const parsed = parseTopicId(args.topic_id);
    if (parsed === null) return JSON.stringify({ error: "topic_id muss eine positive ganze Zahl sein" });
    if (!deps.groupId) {
      return JSON.stringify({ error: "Keine Forum-Gruppe eingerichtet, topic_id nicht moeglich" });
    }
    topicId = parsed;
  }

  const caption = args.caption ? String(args.caption).substring(0, MAX_CAPTION_CHARS) : undefined;
  const result = await sendAndRecord({ file: filePath, caption, topicId, source: "datei" }, deps);
  if (result.error?.kind === "send") throw new Error(`Telegram: ${result.error.message}`);
  if (result.error) return JSON.stringify({ error: result.error.message });

  return JSON.stringify({
    success: true,
    file: basename(filePath),
    bytes: size,
    sent_to: topicId === undefined ? "owner DM" : topicId === GENERAL_TOPIC_ID ? "General" : `topic ${topicId}`,
  });
}

registerBuiltinTool({
  name: "telegram_send_document",
  description:
    "Send a local file (PDF, HTML, CSV, image, any document) to the user's Telegram chat as a downloadable document. Use whenever you generated or found a file the user should receive. Without topic_id it goes to the user's direct chat; with topic_id to that topic of the user's forum group.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file on this machine",
      },
      caption: {
        type: "string",
        description: "Optional caption shown under the document (max 1024 chars)",
      },
      topic_id: {
        type: "integer",
        description: "Optional forum topic ID in the user's group (1 = General). Omit for the direct chat.",
      },
    },
    required: ["file_path"],
  },
  isAvailable: () => !!botToken() && !!ownerChatId(),
  handler: args => sendDocumentTool(args),
});
