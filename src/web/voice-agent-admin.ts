/**
 * Bereich „Sprachagenten“ der WebUI (Issue #495): Pfade, Texte und
 * Schnittstelle der Verwaltung, ohne Importe aus src/lib. Wie bei
 * ./voice-agent-page.ts lädt der Web-Server (server.ts) so zur Laufzeit nichts
 * außerhalb von src/web; die Umsetzung steht in ./bot-voice-agent-admin.ts
 * (über den Manager von /sprachagent) und kommt über die Abhängigkeit
 * voiceAgentAdmin herein, in web:dev als Attrappe (./demo-voice-agents.ts).
 */

/** Seite mit Liste und Detail */
export const VOICE_AGENTS_PAGE = "/sprachagenten";
/**
 * Verwaltungsrouten: GET /api/voice-agents (Liste),
 * GET …/<kennung>/rezept[?version=n] (Detail), POST …/<kennung>/test,
 * POST …/<kennung>/link, POST …/<kennung>/loeschen ({ bestaetigt: true }).
 * Die Gesprächsrouten (…/<kennung> und …/session) stehen in ./voice-agent-page.ts.
 */
export const VOICE_AGENT_ADMIN_PATH = /^\/api\/voice-agents(?:\/([^/]+)\/(rezept|test|link|loeschen))?$/;

export const VOICE_AGENT_ADMIN_TEXT = {
  notConfigured: "Die Verwaltung der Sprachagenten gibt es in diesem Prozess nicht.",
  unknown: "Diesen Sprachagenten gibt es nicht.",
  broken: "Das Rezept dieses Sprachagenten ist beschädigt.",
  noVersion: "Diese Version gibt es nicht.",
  browserOnly: "Sprachagenten verwaltest du nur im Browser.",
  confirm: "Löschen nur mit Bestätigung.",
  noProvider: "Der Anbieter ist nicht eingerichtet: ELEVENLABS_API_KEY fehlt.",
  notDeployed: "Der Sprachagent ist beim Anbieter noch nicht angelegt. Erst nach dem Abgleich gibt es Tests.",
  testRunning: "Für diesen Sprachagenten läuft schon ein Testlauf.",
  testStarted: "Testlauf gestartet. Das Ergebnis erscheint hier und im Direktchat.",
  noWeb: "Dieser Sprachagent hat keinen Web-Zugang (zugang.web.link ist aus).",
  locked: "Dieser Sprachagent ist nicht freigeschaltet. Erst müssen die Tests der aktuellen Fassung bestehen.",
  noWebUi: "Die WebUI hat keine Adresse für einen Link.",
  failed: "Das ist fehlgeschlagen, Details im Log.",
} as const;

export interface VoiceAgentAdminResult {
  status: number;
  body: Record<string, unknown>;
}

/** Was die Umsetzung braucht; jede Methode liefert Status und JSON */
export interface VoiceAgentAdminPort {
  list(): Promise<VoiceAgentAdminResult>;
  /** version: eine ältere Fassung aus versionen/; ohne die aktuelle */
  detail(kennung: string, version: number | null): Promise<VoiceAgentAdminResult>;
  test(kennung: string): Promise<VoiceAgentAdminResult>;
  link(kennung: string): Promise<VoiceAgentAdminResult>;
  /** Erst nach der Rückfrage im Browser; der Server prüft { bestaetigt: true } */
  remove(kennung: string): Promise<VoiceAgentAdminResult>;
}

/** Versionsnummer aus ?version=; null ohne, NaN bei Unsinn */
export function parseVersionParam(value: string | null): number | null {
  if (value === null || value === "") return null;
  return /^[1-9][0-9]{0,5}$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
}
