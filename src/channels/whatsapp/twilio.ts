/**
 * Twilio-Anbindung des WhatsApp-Kanals (Issue #345): Signatur der Webhooks
 * prüfen, Formulardaten lesen, Antworten über die REST-Schnittstelle senden.
 *
 * Der Import tut nichts; Zugangsdaten und fetch kommen als Parameter, damit
 * die Tests ohne Netz und ohne Serverstart auskommen.
 */
import { createHmac, timingSafeEqual } from "crypto";

/** Höchstlänge einer WhatsApp-Nachricht */
export const WHATSAPP_TEXT_LIMIT = 4096;

/** Telefonnummer ohne Präfix "whatsapp:" und ohne Leerraum am Rand */
export function bareNumber(address: string): string {
  return address.trim().replace(/^whatsapp:/, "").trim();
}

/** Adresse für Twilio: immer mit Präfix "whatsapp:" */
export function whatsAppAddress(number: string): string {
  return number.startsWith("whatsapp:") ? number : `whatsapp:${number}`;
}

/**
 * Signatur, die Twilio für eine Anfrage bildet: HMAC-SHA1 über die Adresse
 * und alle Felder, nach Namen sortiert, jeweils Name und Wert ohne Trenner.
 */
export function twilioSignatureFor(authToken: string, url: string, fields: Record<string, string>): string {
  const signed = Object.keys(fields)
    .sort()
    .reduce((acc, name) => acc + name + fields[name], url);
  return createHmac("sha1", authToken).update(signed, "utf-8").digest("base64");
}

/** Stimmt die mitgeschickte Signatur? Vergleich in konstanter Zeit */
export function hasValidTwilioSignature(
  authToken: string,
  url: string,
  fields: Record<string, string>,
  signature: string
): boolean {
  const expected = Buffer.from(twilioSignatureFor(authToken, url, fields));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Formulardaten (application/x-www-form-urlencoded) als Feld-Objekt; doppelte Felder: das letzte gilt */
export function readTwilioForm(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

/**
 * Teilt eine Antwort für WhatsApp: erst an Absätzen (Leerzeile), ein Absatz
 * über der Grenze wird hart geschnitten. Kurze Texte bleiben ein Stück.
 */
export function splitWhatsAppText(text: string, limit = WHATSAPP_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const pieces: string[] = [];
  let open = "";
  const flush = () => {
    if (open) pieces.push(open);
    open = "";
  };
  for (const block of text.split("\n\n")) {
    const joined = open ? `${open}\n\n${block}` : block;
    if (joined.length <= limit) {
      open = joined;
      continue;
    }
    flush();
    open = block;
  }
  flush();
  return pieces.flatMap(piece => {
    if (piece.length <= limit) return [piece];
    const cut: string[] = [];
    for (let at = 0; at < piece.length; at += limit) cut.push(piece.slice(at, at + limit));
    return cut;
  });
}

export interface TwilioSenderOptions {
  accountSid: string;
  authToken: string;
  /** Absendernummer ohne Präfix (Sandbox oder freigegebene Nummer) */
  from: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  warn?: (line: string) => void;
}

export interface WhatsAppSender {
  /** eine Nachricht; true, wenn Twilio sie angenommen hat. Wirft nie */
  sendOne(to: string, text: string): Promise<boolean>;
  /** eine Antwort, bei Bedarf in mehreren Nachrichten nacheinander */
  send(to: string, text: string): Promise<void>;
}

export function createTwilioSender(options: TwilioSenderOptions): WhatsAppSender {
  const post = options.fetch ?? ((url, init) => fetch(url, init));
  const warn = options.warn ?? (line => console.error(line));
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${options.accountSid}/Messages.json`;
  const credentials = Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64");

  const sendOne = async (to: string, text: string): Promise<boolean> => {
    const form = new URLSearchParams();
    form.set("From", whatsAppAddress(options.from));
    form.set("To", whatsAppAddress(to));
    form.set("Body", text);
    try {
      const answer = await post(endpoint, {
        method: "POST",
        headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (answer.ok) return true;
      // Nur der Status ins Log: der Fehlertext von Twilio kann Nummern enthalten
      warn(`[WhatsApp] Twilio lehnt den Versand ab (HTTP ${answer.status})`);
      return false;
    } catch (err) {
      warn(`[WhatsApp] Twilio nicht erreichbar (${err instanceof Error ? err.name : "Fehler"})`);
      return false;
    }
  };

  return {
    sendOne,
    async send(to, text) {
      for (const piece of splitWhatsAppText(text)) await sendOne(to, piece);
    },
  };
}
