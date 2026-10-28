/**
 * Status der Sprechmodi für GET /api/voice (Issue #248, Entscheidung 0023).
 *
 * modes.local: Sprechmodus ohne Abo (Hören → Motor → Sprechen). Die WebUI
 * zeigt nur Auswahl und Status; Audio im Browser kommt mit #249/#250.
 * modes.agent (eigener ElevenLabs-Agent) ergänzt #244 neben modes.local,
 * ohne dessen Form zu ändern.
 * modes.call (Telefonhörer, Issue #257): nur mit eingerichtetem CallPort;
 * ready heißt Erkenner verfügbar und Modellweg bereit, eine fehlende
 * Server-Stimme hindert nicht (dann spricht der Browser).
 *
 * Wie ./settings.ts importiert diese Datei nichts aus src/lib: src/bot.ts
 * reicht den Port aus ./bot-settings.ts herein, Demo und Tests Attrappen.
 */

export interface LocalModeStatus {
  ready: boolean;
  /** Nur bei ready: false, kurzer deutscher Satz mit Anbieter und Grund */
  reason?: string;
  /** Bei fester Wahl der gewählte Anbieter (auch nicht verfügbar), bei auto der erste verfügbare, sonst null */
  stt: { id: string; label: string; local: boolean; available: boolean } | null;
  tts: { id: string; label: string; where: "server" | "browser"; available: boolean };
}

export interface VoicePort {
  localMode(): LocalModeStatus;
}

import type { CallModeStatus, CallPort } from "./call-protocol";

export const VOICE_TEXT = {
  notConfigured: "Sprach-Status ist nicht eingerichtet",
} as const;

export interface VoiceStatusBody {
  modes: { local: LocalModeStatus; call?: CallModeStatus };
}

/** Ein Fehler beim Prüfen des Telefonhörers macht nur ihn unbereit, nie die ganze Antwort */
export async function voiceStatusBody(port: VoicePort, call?: Pick<CallPort, "status">): Promise<VoiceStatusBody> {
  const local = port.localMode();
  if (!call) return { modes: { local } };
  let status: CallModeStatus;
  try {
    status = await call.status();
  } catch {
    status = {
      ready: false,
      reason: "Status des Telefonhörers ließ sich nicht prüfen",
      model: null,
      via: null,
      expectation: "",
      stt: { id: null, local: false, warm: false },
      tts: { id: "browser", where: "browser", stream: false },
    };
  }
  return { modes: { local, call: status } };
}
