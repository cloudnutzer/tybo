/**
 * Einstellungen des WhatsApp-Gateways aus der Umgebung (Issue #345).
 * Namen der Variablen: .env.example, Abschnitt WhatsApp.
 */
import { bareNumber } from "./twilio";

/** Sandbox-Nummer von Twilio, wenn TWILIO_SANDBOX_NUMBER fehlt */
export const TWILIO_SANDBOX_DEFAULT = "+14155238886";

export interface WhatsAppConfig {
  accountSid: string;
  authToken: string;
  /** Absendernummer für Antworten */
  from: string;
  /** Besitzer (WHATSAPP_USER_NUMBER) und WHATSAPP_ALLOWED_NUMBERS, ohne Präfix */
  allowed: Set<string>;
  host: string;
  port: number;
  /** WHATSAPP_WEBHOOK_URL, leer: Adresse der Anfrage */
  publicUrl: string;
}

const REQUIRED = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "WHATSAPP_USER_NUMBER"] as const;

/** Wirft mit dem Namen der ersten fehlenden Pflichtvariable */
export function readWhatsAppConfig(env: Record<string, string | undefined>): WhatsAppConfig {
  const missing = REQUIRED.find(name => !env[name]);
  if (missing) throw new Error(`Missing required environment variable: ${missing}`);
  const numbers = [env.WHATSAPP_USER_NUMBER!, ...(env.WHATSAPP_ALLOWED_NUMBERS ?? "").split(",")];
  return {
    accountSid: env.TWILIO_ACCOUNT_SID!,
    authToken: env.TWILIO_AUTH_TOKEN!,
    // Wie bisher gewinnt immer die Sandbox-Nummer (eigene oder Standard), TWILIO_WHATSAPP_NUMBER greift nicht
    from: env.TWILIO_SANDBOX_NUMBER || TWILIO_SANDBOX_DEFAULT,
    allowed: new Set(numbers.map(bareNumber).filter(Boolean)),
    host: env.WHATSAPP_HOST || "127.0.0.1",
    port: Number.parseInt(env.PORT_WHATSAPP || "3001", 10),
    publicUrl: env.WHATSAPP_WEBHOOK_URL || "",
  };
}
