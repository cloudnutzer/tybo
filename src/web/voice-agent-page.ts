/**
 * Web-Gespräch je Rezept (Issue #494): Pfade, Texte, Hosts und Schnittstelle,
 * ohne Importe aus src/lib. So lädt der Web-Server (server.ts) zur Laufzeit
 * nichts außerhalb von src/web; die Umsetzung steht in
 * ./bot-voice-agent-session.ts und kommt über die Abhängigkeit
 * voiceAgentSessions herein.
 */

/** Pfad der Gesprächsseite; die Kennung prüft isValidKennung */
export const VOICE_AGENT_PAGE_PATH = /^\/sa\/([^/]+)$/;
/** Selbst gehostetes SDK (scripts/vendor-elevenlabs.ts); web:dev ersetzt es durch eine Attrappe */
export const VOICE_AGENT_SDK_PATH = "/vendor/elevenlabs/lib.iife.js";
/** API-Routen eines Rezepts */
export const VOICE_AGENT_API_PATH = /^\/api\/voice-agents\/([^/]+)(\/session(?:\/end)?)?$/;
export const VOICE_AGENT_PROVIDER_TIMEOUT_MS = 10_000;

/**
 * Hosts, die der Browser für das Gespräch braucht (aus dem Paketcode von
 * @elevenlabs/client, Issue #244). Nur auf der Gesprächsseite in connect-src.
 */
export const VOICE_AGENT_CONNECT_HOSTS = [
  "https://api.elevenlabs.io",
  "wss://api.elevenlabs.io",
  "wss://livekit.rtc.elevenlabs.io",
  "https://livekit.rtc.elevenlabs.io",
] as const;

export const VOICE_AGENT_SESSION_TEXT = {
  notConfigured: "Web-Gespräche mit Sprachagenten gibt es in diesem Prozess nicht.",
  unknown: "Diesen Sprachagenten gibt es nicht.",
  broken: "Das Rezept dieses Sprachagenten ist beschädigt.",
  noWeb: "Dieser Sprachagent hat keinen Web-Zugang (zugang.web.link ist aus).",
  locked: "Dieser Sprachagent ist nicht freigeschaltet. Erst müssen die Tests der aktuellen Fassung bestehen, oder du schaltest ihn trotzdem frei.",
  notSynced: "Die aktuelle Fassung ist beim Anbieter noch nicht abgeglichen. Erst nach dem Abgleich gibt es ein Gespräch.",
  noProvider: "Der Anbieter ist nicht eingerichtet: ELEVENLABS_API_KEY fehlt.",
  noBridge: "Die Sprach-Brücke ist nicht eingerichtet: VOICE_BRIDGE_TOKEN fehlt.",
  running: "Mit diesem Sprachagenten läuft schon ein Gespräch, oder ElevenLabs hat das Ende des letzten noch nicht bestätigt. Erst auflegen, dann neu starten.",
  tooMany: "Zu viele Gesprächsstarts in kurzer Zeit. Bitte etwas warten.",
  budget: "Das Minutenbudget dieses Sprachagenten für diesen Monat ist aufgebraucht.",
  provider: "Der Anbieter hat kein Gesprächs-Token ausgegeben. Bitte später noch einmal versuchen.",
  tokenExpiry: "Das Gesprächs-Token des Anbieters nennt keinen lesbaren Ablauf oder einen über 60 Minuten. Es wurde deshalb nicht weitergegeben; Details im Log.",
  storage: "Die Ablage der Web-Gespräche ist nicht lesbar. Details im Log.",
  noCall: "Es läuft kein Gespräch, das sich beenden ließe.",
  cancelled: "Das Gespräch wurde beendet, bevor es zustande kam.",
  changed: "Der Sprachagent hat sich während des Starts geändert. Bitte noch einmal starten.",
  endPending: "Aufgelegt. ElevenLabs meldet das Gespräch noch als aktiv; bis es das Ende bestätigt, bleiben der Platz belegt und die volle Gesprächsdauer gebucht.",
  endUnknown: "Aufgelegt. ElevenLabs ist gerade nicht erreichbar oder antwortet unklar; bis es das Ende bestätigt, bleiben der Platz belegt und die volle Gesprächsdauer gebucht.",
  revokeFailed: "Die Freigabe des Gesprächs ließ sich nicht löschen. Bitte noch einmal auflegen; Details im Log.",
  invalid: "Ungültige Anfrage.",
  browserOnly: "Gespräche mit Sprachagenten gibt es nur im Browser.",
} as const;

export interface VoiceAgentSessionResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export type VoiceAgentPageOutcome = "ok" | "unbekannt" | "kein_web";

export interface VoiceAgentSessionPort {
  /** Gibt es eine Gesprächsseite? Nur für bekannte Rezepte mit Web-Zugang. */
  page(kennung: string): Promise<VoiceAgentPageOutcome>;
  info(kennung: string): Promise<VoiceAgentSessionResult>;
  start(kennung: string): Promise<VoiceAgentSessionResult>;
  /** Endemeldung ({ conversationId }); der Server fragt beim Anbieter nach */
  end(kennung: string, body: string): Promise<VoiceAgentSessionResult>;
}
