/**
 * HTTP-Seite des WhatsApp-Gateways (Issue #345): Zustandsabfrage und der
 * Twilio-Webhook. Nur der Handler, kein Server: das Gateway übergibt ihn an
 * Bun.serve, die Tests rufen ihn direkt mit Request-Objekten auf.
 *
 * Der Webhook antwortet sofort mit leerem TwiML, die Antwort an den Nutzer
 * geht später über die REST-Schnittstelle; so wiederholt Twilio nichts.
 * Unbekannte Absender und Nachrichten ohne Text werden still quittiert.
 */
import { bareNumber, hasValidTwilioSignature, readTwilioForm } from "./twilio";

export const WEBHOOK_PATH = "/webhook/whatsapp";
export const HEALTH_PATH = "/health";

/** Leere TwiML-Antwort: Twilio sendet selbst nichts */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export interface WhatsAppWebhookOptions {
  authToken: string;
  /** Öffentliche Adresse, mit der Twilio signiert (WHATSAPP_WEBHOOK_URL); leer: Adresse der Anfrage */
  publicUrl?: string;
  /** Besitzer, freigegebene Nummern und Mitglieder einer Gruppe */
  isAllowed(number: string): boolean;
  /** Verarbeitung im Hintergrund; Fehler landen nur im Log */
  handle(from: string, body: string): Promise<void>;
  /** Felder der Zustandsabfrage zusätzlich zu status und service */
  health(): Record<string, unknown>;
  log?(line: string): void;
}

const twiml = () => new Response(EMPTY_TWIML, { headers: { "Content-Type": "application/xml" } });

export function createWhatsAppWebhook(options: WhatsAppWebhookOptions): (req: Request) => Promise<Response> {
  const log = options.log ?? (line => console.log(line));

  async function inbound(req: Request): Promise<Response> {
    const fields = readTwilioForm(await req.text());
    const signedUrl = options.publicUrl || req.url;
    if (!hasValidTwilioSignature(options.authToken, signedUrl, fields, req.headers.get("X-Twilio-Signature") ?? "")) {
      log("[WhatsApp] Anfrage mit falscher Twilio-Signatur abgewiesen");
      return new Response("Forbidden", { status: 403 });
    }
    const from = fields.From ?? "";
    const text = (fields.Body ?? "").trim();
    if (!options.isAllowed(bareNumber(from))) {
      log("[WhatsApp] Nachricht eines nicht freigegebenen Absenders ignoriert");
      return twiml();
    }
    // Nur Medien, kein Text: quittieren, nichts tun
    if (!text) return twiml();
    void options.handle(from, text).catch(err => {
      log(`[WhatsApp] Verarbeitung im Hintergrund gescheitert (${err instanceof Error ? err.name : "Fehler"})`);
    });
    return twiml();
  }

  return async req => {
    const { pathname } = new URL(req.url);
    if (pathname === HEALTH_PATH && req.method === "GET") {
      return Response.json({ status: "ok", service: "tybo-whatsapp-gateway", ...options.health() });
    }
    if (pathname === WEBHOOK_PATH && req.method === "POST") return inbound(req);
    return new Response("Not Found", { status: 404 });
  };
}
