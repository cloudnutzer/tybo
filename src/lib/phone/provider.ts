/**
 * Anbieter für Telefonanrufe (Issue #366, Entscheidung E9).
 *
 * Ein PhoneCaller kann zweierlei: einen Anruf beim Nutzer auslösen (dial)
 * und das Protokoll eines Anrufs abfragen (transcript). Heute gibt es einen
 * Anbieter: ElevenLabs Conversational AI, das über eine bei ElevenLabs
 * hinterlegte Twilio-Nummer wählt. Die Umgebungsvariablen bleiben die alten
 * (ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID,
 * USER_PHONE_NUMBER).
 *
 * Das Protokoll kennt drei Zustände, die der Aufrufer unterscheiden muss:
 * - "pending": das Gespräch läuft noch oder wird noch verarbeitet, oder die
 *   Abfrage scheiterte vorübergehend (Zeitablauf, 5xx, 429, 404 kurz nach
 *   dem Wählen). Später noch einmal fragen.
 * - "done": abgeschlossen; lines kann leer sein (nicht angenommen, sofort
 *   aufgelegt).
 * - "error": dauerhaft gescheitert (andere 4xx, Anruf mit Status failed).
 *
 * Ins Log kommen nie Schlüssel, Rufnummern oder Gesprächsinhalte.
 */

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const ELEVENLABS_API = "https://api.elevenlabs.io/v1/convai";
/** Längste Gesprächsdauer, die ElevenLabs zulässt, bevor es auflegt */
export const MAX_CALL_SECONDS = 300;
/** Frist je HTTP-Anfrage an den Anbieter */
export const PROVIDER_TIMEOUT_MS = 20_000;

export interface DialRequest {
  /** Eigene Kennung des Anrufs; geht als dynamische Variable tybo_call_ref mit */
  ref: string;
  /** Erster Satz, den der Sprachagent sagt */
  greeting: string;
  /** Weitere dynamische Variablen für den Sprachagenten */
  variables: Record<string, string>;
}

export type DialResult =
  | { ok: true; conversationId: string | null }
  | { ok: false; error: string };

export interface TranscriptLine {
  speaker: "agent" | "user";
  text: string;
}

export type TranscriptResult =
  | { state: "pending"; reason: string }
  | { state: "done"; lines: TranscriptLine[] }
  | { state: "error"; error: string };

export interface PhoneCaller {
  /** Fehlende Einstellungen, leer heißt einsatzbereit */
  missing(): string[];
  dial(request: DialRequest): Promise<DialResult>;
  transcript(conversationId: string): Promise<TranscriptResult>;
}

const REQUIRED_ENV = ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "ELEVENLABS_PHONE_NUMBER_ID", "USER_PHONE_NUMBER"] as const;

/**
 * Ob Anrufe eingerichtet sind (alle vier Variablen gesetzt). Hier statt in
 * index.ts, damit Werkzeug, Check-in und Briefing es ohne den Bot-Einstieg
 * laden; dieselbe Prüfung wie missing() des Anbieters.
 */
export function phoneConfigured(env: Env = process.env): boolean {
  return createElevenLabsCaller({ env }).missing().length === 0;
}

/** Statuswerte, bei denen das Gespräch noch nicht fertig ist */
const RUNNING_STATES = new Set(["initiated", "in-progress", "processing"]);

/** Vorübergehende HTTP-Fehler: später erneut abfragen */
function isTransient(status: number): boolean {
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" || err.name === "AbortError" ? "Zeitablauf" : err.name;
  return "Fehler";
}

/** Fehlertext einer abgelehnten Anfrage: Status und höchstens 200 Zeichen der Antwort */
async function rejection(response: Response): Promise<string> {
  const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
  return body ? `HTTP ${response.status}: ${body}` : `HTTP ${response.status}`;
}

export interface ElevenLabsCallerOptions {
  env?: Env;
  fetch?: Fetch;
  timeoutMs?: number;
}

/** ElevenLabs Conversational AI mit Twilio-Nummer */
export function createElevenLabsCaller(options: ElevenLabsCallerOptions = {}): PhoneCaller {
  const env = options.env ?? process.env;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const value = (name: (typeof REQUIRED_ENV)[number]) => env[name]?.trim() ?? "";

  return {
    missing: () => REQUIRED_ENV.filter(name => !value(name)),

    async dial(request) {
      const absent = REQUIRED_ENV.filter(name => !value(name));
      if (absent.length > 0) return { ok: false, error: `nicht eingerichtet (${absent.join(", ")})` };
      let response: Response;
      try {
        response = await doFetch(`${ELEVENLABS_API}/twilio/outbound-call`, {
          method: "POST",
          headers: { "xi-api-key": value("ELEVENLABS_API_KEY"), "Content-Type": "application/json" },
          body: JSON.stringify({
            agent_id: value("ELEVENLABS_AGENT_ID"),
            agent_phone_number_id: value("ELEVENLABS_PHONE_NUMBER_ID"),
            to_number: value("USER_PHONE_NUMBER"),
            max_duration_seconds: MAX_CALL_SECONDS,
            first_message: request.greeting,
            conversation_initiation_client_data: {
              dynamic_variables: { ...request.variables, tybo_call_ref: request.ref },
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return { ok: false, error: errorText(err) };
      }
      if (!response.ok) return { ok: false, error: await rejection(response) };
      const data = (await response.json().catch(() => null)) as { success?: boolean; message?: string; conversation_id?: string } | null;
      if (!data || data.success === false) return { ok: false, error: data?.message?.slice(0, 200) || "Antwort ohne Erfolg" };
      return { ok: true, conversationId: typeof data.conversation_id === "string" && data.conversation_id ? data.conversation_id : null };
    },

    async transcript(conversationId) {
      let response: Response;
      try {
        response = await doFetch(`${ELEVENLABS_API}/conversations/${encodeURIComponent(conversationId)}`, {
          method: "GET",
          headers: { "xi-api-key": value("ELEVENLABS_API_KEY") },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        return { state: "pending", reason: errorText(err) };
      }
      if (!response.ok) {
        const text = await rejection(response);
        return isTransient(response.status) ? { state: "pending", reason: text } : { state: "error", error: text };
      }
      const data = (await response.json().catch(() => null)) as { status?: string; transcript?: { role?: string; message?: string | null }[] } | null;
      if (!data) return { state: "pending", reason: "unlesbare Antwort" };
      if (data.status === "failed") return { state: "error", error: "Anruf beim Anbieter gescheitert" };
      if (data.status !== "done") return { state: "pending", reason: RUNNING_STATES.has(data.status ?? "") ? `Status ${data.status}` : "unbekannter Status" };
      return { state: "done", lines: linesFromTurns(data.transcript ?? []) };
    },
  };
}

/** Beiträge des Anbieters (Abfrage und Webhook) als Zeilen; leere Beiträge fallen weg */
export function linesFromTurns(turns: readonly { role?: unknown; message?: unknown }[]): TranscriptLine[] {
  return turns
    .filter(turn => typeof turn.message === "string" && turn.message.trim() !== "")
    .map(turn => ({ speaker: turn.role === "agent" ? "agent" : "user", text: (turn.message as string).trim() }));
}

/** Protokoll als Text, eine Zeile je Beitrag */
export function transcriptText(lines: TranscriptLine[], names: { agent: string; user: string }): string {
  return lines.map(line => `${line.speaker === "agent" ? names.agent : names.user}: ${line.text}`).join("\n");
}
