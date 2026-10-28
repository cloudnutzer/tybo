/**
 * Echte Abhängigkeiten des Sprechmodus (Issue #249) für src/bot.ts: Hören
 * und Sprechen über die Sprach-Schnittstelle (src/lib/speech), die
 * Beschäftigt-Prüfung und die Vormerkung des Sprech-Turns in der gemeinsamen
 * Warteschlange des Gesprächs (Ausführungsschlüssel und Agent). Wie
 * bot-settings.ts bindet nur src/bot.ts diese Datei ein; Tests nutzen sie
 * mit Anbieter-Attrappen (setSpeechForTests).
 */

import { isExecutionActive, reserveExecution } from "../lib/execution-context";
import { getSpeech, type Speech } from "../lib/speech";
import { conversationSessionKey, resolveTelegramTarget, type TelegramChatDeps } from "./bot-turn";
import { parseTelegramConversationId } from "./telegram";
import type { SpeechPort, SpeechReservation } from "./speech";

export interface BotSpeechDeps extends Pick<TelegramChatDeps, "userId" | "groupId" | "agentForTopic"> {
  /** Standard: getSpeech() bei jedem Aufruf */
  speech?: () => Speech;
  /** Standard: isExecutionActive aus src/lib/execution-context.ts */
  isExecutionActive?: (sessionKey: string) => boolean;
  /** Standard: reserveExecution aus src/lib/execution-context.ts */
  reserveExecution?: (sessionKey: string, agent: string) => SpeechReservation | null;
}

export function createBotSpeech(deps: BotSpeechDeps): SpeechPort {
  const speech = deps.speech ?? getSpeech;
  const active = deps.isExecutionActive ?? isExecutionActive;
  const reserve = deps.reserveExecution ?? reserveExecution;
  return {
    recognize: (audio, mime, opts) =>
      speech().recognize(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength), mime, { timeoutMs: opts.timeoutMs }),
    async synthesize(text, opts) {
      const result = await speech().synthesizeSpeech(text, opts);
      // Auch reason voice (Stimme beim Anbieter nicht freigegeben, Issue #252) geht an die Route: 400
      return result;
    },
    /**
     * Derselbe Schlüssel wie beim Schreiben (topic:…, group:…, dm:…, web:…):
     * zählt jeden Turn des Gesprächs, auch aus Telegram, /goal und Befehle.
     * Ohne ermittelbaren Schlüssel nicht beschäftigt: der Turn meldet dann selbst, dass das Gespräch nicht erreichbar ist.
     */
    isBusy(conversationId) {
      const key = conversationSessionKey(conversationId, deps);
      return key !== null && active(key);
    },
    /**
     * Prüfen und Reservieren in einem Schritt, mit Schlüssel und Agent wie im
     * Turn selbst (createTelegramChat bzw. createBotChat): ein Turn aus
     * Telegram, der danach beginnt, wartet in der Session-Warteschlange
     * hinter dem Sprech-Turn, und einer, der davor begann, ergibt hier null
     * (409). Ohne ermittelbaren Schlüssel nichts vorzumerken, wie bei isBusy.
     */
    reserve(conversationId, agent) {
      // Telegram-Gespräch: der Agent des Topics, wie ihn der Turn selbst bestimmt
      const target = parseTelegramConversationId(conversationId) ? resolveTelegramTarget(conversationId, deps) : null;
      const key = target ? target.sessionKey : conversationSessionKey(conversationId, deps);
      return key === null ? { release() {} } : reserve(key, target ? target.agent : agent);
    },
  };
}
