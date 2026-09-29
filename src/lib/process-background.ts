/**
 * Auftrag über /process (Hybrid-Modus: der VPS reicht eine Nachricht weiter),
 * aus src/bot.ts herausgelöst (Issue #190), damit Tests Download, Claude und
 * Versand ersetzen können.
 *
 * Der ganze angenommene Auftrag läuft in einem runCancelable-Bereich:
 * Download, Asset, Claude-Aufruf und Antwortversand zählen als beschäftigt,
 * ein Neustart wartet also, bis die Antwort zugestellt ist. Ist die Annahme
 * schon gesperrt, lehnt runCancelable sofort ab (RestartPendingError) und der
 * Nutzer bekommt die Meldung „startet gerade neu", bevor irgendetwas
 * heruntergeladen wird.
 */

import { isRestartPendingError, RESTART_PENDING_REPLY, runCancelable } from "./execution-context";

export interface ProcessRequest {
  text?: string;
  chatId?: string;
  threadId?: number;
  photoFileId?: string;
}

export interface ProcessBackgroundDeps {
  /** Session-Schlüssel des Gesprächs (sessionKeyFor) */
  sessionKey(chatId: string, threadId?: number): string;
  send(chatId: string, text: string, threadId?: number): Promise<void>;
  typing(chatId: string): Promise<void>;
  /** Foto aus Telegram laden und ablegen; null: nicht ladbar */
  downloadPhoto(photoFileId: string): Promise<string | null>;
  uploadAsset(localPath: string, caption: string | undefined, photoFileId: string): Promise<{ id: string } | null>;
  callClaude(prompt: string, chatId: string, threadId?: number): Promise<string>;
  /** Beschreibung des Assets aus der Antwort nachziehen, gibt die bereinigte Antwort zurück */
  finishAsset(assetId: string | null, response: string): string;
  typingIntervalMs?: number;
  log?(message: string): void;
}

export const PROCESS_TEXT = {
  photoFailed: "Could not download the photo from Telegram.",
  failed: "Sorry, something went wrong processing your message on the local machine.",
};

export async function processInBackground(req: ProcessRequest, deps: ProcessBackgroundDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const chatId = req.chatId || "";
  if (!chatId) {
    log("/process background: no chatId provided");
    return;
  }
  const { text, threadId, photoFileId } = req;
  let typingInterval: ReturnType<typeof setInterval> | undefined;

  try {
    // runCancelable prüft die Annahmesperre und registriert den Auftrag, bevor
    // das erste await läuft
    await runCancelable(deps.sessionKey(chatId, threadId), async () => {
      await deps.typing(chatId).catch(() => {});
      typingInterval = setInterval(() => void deps.typing(chatId).catch(() => {}), deps.typingIntervalMs ?? 4000);

      let response: string;
      if (photoFileId) {
        const localPath = await deps.downloadPhoto(photoFileId);
        if (!localPath) {
          await deps.send(chatId, PROCESS_TEXT.photoFailed, threadId);
          return;
        }
        const asset = await deps.uploadAsset(localPath, text || undefined, photoFileId);
        const caption = text || "User sent a photo. Describe and respond to it.";
        const assetNote = asset ? `\n(asset: ${asset.id})` : "";
        response = await deps.callClaude(`[Image attached: ${localPath}]${assetNote}\n\nUser says: ${caption}`, chatId, threadId);
        response = deps.finishAsset(asset?.id ?? null, response);
      } else {
        response = await deps.callClaude(text || "", chatId, threadId);
      }

      // Versand noch im Bereich: ein Neustart unterbricht ihn nicht
      await deps.send(chatId, response, threadId);
      log(`/process completed for chat ${chatId} (${response.length} chars)`);
    });
  } catch (err) {
    const restart = isRestartPendingError(err);
    if (!restart) log(`/process background processing error (${err instanceof Error ? err.name : "Fehler"})`);
    await deps.send(chatId, restart ? RESTART_PENDING_REPLY : PROCESS_TEXT.failed, threadId).catch(() => {});
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }
}
