/**
 * POST /relay am Health-Port des eigenen Rechners (Issue #353, Profil peer).
 * Der Server reicht hier ein unverändertes Telegram-Update weiter; der
 * Rechner speist es in denselben grammY-Bot ein wie beim Polling.
 *
 * Vertrag (Body { updateId, update }, updateId gleich update.update_id):
 * - 202 { accepted: true }: angenommen, läuft im Hintergrund
 * - 200 { duplicate: true }: diese updateId ist schon angenommen
 * - 400 Body ungültig, 401 Geheimnis fehlt oder falsch, 403 Chat nicht
 *   freigegeben, 413 zu groß, 429 voll, 503 Herunterfahren, Neustart steht
 *   an oder der Bot ist noch nicht angemeldet
 * Alles außer 202 und 200 heißt: das Update wurde nicht ausgeführt. Jede
 * Antwort trägt den Kopf X-Tybo-Relay, damit der Server sie von Fehlern
 * eines Proxys oder Tunnels unterscheiden kann.
 *
 * Doppelte Zustellung: die updateId wird vor dem ersten await reserviert,
 * zwei gleichzeitige Anfragen ergeben also genau eine Annahme. Gemerkt wird
 * jede tatsächlich angenommene Kennung für die ganze Laufzeit des Prozesses,
 * ohne Untergrenze: eine verspätete kleinere Kennung, die nie angenommen
 * wurde, gilt nicht als doppelt. Nach einem Neustart ist die Liste leer.
 *
 * Die Grenze für 429 zählt Updates, die gerade in die Handler gehen. Die
 * Handler starten Turns im Hintergrund, deren Zahl begrenzt die
 * Ausführungsschicht (src/lib/execution-context.ts), nicht dieser Zähler.
 */
import type { Update } from "grammy/types";
import { authorizeBearer } from "../http-security";

export const RELAY_PATH = "/relay";
export const RELAY_HEADER = "X-Tybo-Relay";
/** Wie am Webhook-Listener: Updates sind wenige Kilobyte groß */
export const RELAY_BODY_LIMIT = 1024 * 1024;
const DEFAULT_CAPACITY = 32;

export interface RelayEndpointDeps {
  secret(): string;
  allowChat(chatId: string): boolean;
  /** Herunterfahren begonnen oder Neustart angefordert */
  closing(): boolean;
  /** Eingang des Bots; null, solange er nicht angemeldet ist */
  intake(): ((update: Update) => Promise<void>) | null;
  capacity?: number;
  log?: (line: string) => void;
}

const marked = (response: Response): Response => {
  response.headers.set(RELAY_HEADER, "1");
  return response;
};
const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  marked(body === undefined ? new Response(null, { status, headers }) : Response.json(body, { status, headers }));

/** Chat eines weitergereichten Updates; null bei Arten, die der Vertrag nicht kennt */
export function relayChatOf(update: Update): string | null {
  const message = update.message ?? update.edited_message;
  if (message) return String(message.chat.id);
  const query = update.callback_query;
  if (query) return String(query.message?.chat.id ?? query.from.id);
  return null;
}

function parseBody(raw: string): { updateId: number; update: Update } | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const { updateId, update } = body as { updateId?: unknown; update?: unknown };
  if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) return null;
  if (!update || typeof update !== "object" || (update as Update).update_id !== updateId) return null;
  return { updateId, update: update as Update };
}

export function createRelayEndpoint(deps: RelayEndpointDeps): (request: Request) => Promise<Response> {
  const log = deps.log ?? (line => console.error(line));
  const capacity = deps.capacity ?? DEFAULT_CAPACITY;
  // Nur angenommene Kennungen; abgelehnte (403, 429, 503) darf der Server erneut schicken
  const accepted = new Set<number>();
  let pending = 0;

  return async request => {
    if (request.method !== "POST") return reply(405, undefined, { Allow: "POST" });
    const denied = authorizeBearer(request, deps.secret());
    if (denied) return marked(denied);
    if (deps.closing()) return reply(503, { error: "shutting down" });
    const intake = deps.intake();
    if (!intake) return reply(503, { error: "not ready" });

    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return reply(400, { error: "invalid body" });
    }
    if (Buffer.byteLength(raw) > RELAY_BODY_LIMIT) return reply(413, { error: "too large" });
    const body = parseBody(raw);
    if (!body) return reply(400, { error: "invalid body" });
    const chatId = relayChatOf(body.update);
    if (chatId === null) return reply(400, { error: "unsupported update" });
    if (!deps.allowChat(chatId)) return reply(403, { error: "forbidden chat" });

    // Ab hier kein await bis zur Reservierung: gleiche Kennungen zur selben Zeit ergeben eine Annahme
    if (accepted.has(body.updateId)) return reply(200, { duplicate: true });
    // Während des Lesens kann das Herunterfahren begonnen haben
    if (deps.closing()) return reply(503, { error: "shutting down" });
    if (pending >= capacity) return reply(429, { error: "busy" }, { "Retry-After": "5" });
    accepted.add(body.updateId);
    pending++;
    Promise.resolve()
      .then(() => intake(body.update))
      .catch(error => log(`[hybrid] Update ${body.updateId} aus /relay gescheitert (${error instanceof Error ? error.message : String(error)})`))
      .finally(() => {
        pending--;
      });
    return reply(202, { accepted: true });
  };
}
