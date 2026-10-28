/**
 * Issue #345: Twilio-Anbindung und Webhook des WhatsApp-Gateways ohne
 * Serverstart und ohne Netz. Signatur, Formulardaten, Aufteilen langer
 * Antworten, Versand, Freigabe der Absender und Einstellungen wie bisher.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "crypto";
import { readWhatsAppConfig, TWILIO_SANDBOX_DEFAULT } from "../src/channels/whatsapp/config";
import {
  bareNumber,
  createTwilioSender,
  hasValidTwilioSignature,
  readTwilioForm,
  splitWhatsAppText,
  twilioSignatureFor,
  whatsAppAddress,
  WHATSAPP_TEXT_LIMIT,
} from "../src/channels/whatsapp/twilio";
import { createWhatsAppWebhook, EMPTY_TWIML } from "../src/channels/whatsapp/webhook";

const TOKEN = "test-auth-token";
const URL_ = "https://beispiel.invalid/webhook/whatsapp";

describe("Twilio-Signatur", () => {
  test("entspricht dem Verfahren aus der Twilio-Doku (sortierte Felder, HMAC-SHA1, Base64)", () => {
    const fields = { To: "whatsapp:+1", Body: "Hi", From: "whatsapp:+2" };
    const expected = createHmac("sha1", TOKEN).update(`${URL_}BodyHiFromwhatsapp:+2Towhatsapp:+1`).digest("base64");
    expect(twilioSignatureFor(TOKEN, URL_, fields)).toBe(expected);
    expect(hasValidTwilioSignature(TOKEN, URL_, fields, expected)).toBe(true);
    expect(hasValidTwilioSignature(TOKEN, URL_, fields, "falsch")).toBe(false);
    expect(hasValidTwilioSignature(TOKEN, `${URL_}x`, fields, expected)).toBe(false);
  });
});

describe("Formulardaten und Nummern", () => {
  test("Plus wird Leerzeichen, Prozent-Kodierung aufgelöst", () => {
    expect(readTwilioForm("Body=Hallo+Welt%21&From=whatsapp%3A%2B491")).toEqual({ Body: "Hallo Welt!", From: "whatsapp:+491" });
  });
  test("Präfix whatsapp: weg bzw. dazu", () => {
    expect(bareNumber(" whatsapp:+491 ")).toBe("+491");
    expect(whatsAppAddress("+491")).toBe("whatsapp:+491");
    expect(whatsAppAddress("whatsapp:+491")).toBe("whatsapp:+491");
  });
});

describe("Aufteilen langer Antworten", () => {
  test("kurz: ein Stück", () => {
    expect(splitWhatsAppText("kurz")).toEqual(["kurz"]);
  });
  test("an Absätzen, dann hart geschnitten", () => {
    const a = "a".repeat(6);
    const b = "b".repeat(6);
    expect(splitWhatsAppText(`${a}\n\n${b}`, 10)).toEqual([a, b]);
    expect(splitWhatsAppText(`ab\n\ncd\n\n${"x".repeat(25)}`, 10)).toEqual(["ab\n\ncd", "x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    expect(WHATSAPP_TEXT_LIMIT).toBe(4096);
  });
});

describe("Versand", () => {
  test("Formular an die REST-Schnittstelle mit Basic-Auth, lange Texte in mehreren Nachrichten", async () => {
    const posts: { url: string; init: RequestInit }[] = [];
    const sender = createTwilioSender({
      accountSid: "AC123",
      authToken: TOKEN,
      from: "+1000",
      fetch: async (url, init) => {
        posts.push({ url, init });
        return new Response("{}", { status: 201 });
      },
    });
    expect(await sender.sendOne("+491", "Hallo")).toBe(true);
    expect(posts[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    const headers = posts[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`AC123:${TOKEN}`).toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(String(posts[0].init.body)))).toEqual({ From: "whatsapp:+1000", To: "whatsapp:+491", Body: "Hallo" });
    await sender.send("+491", "y".repeat(WHATSAPP_TEXT_LIMIT + 1));
    expect(posts).toHaveLength(3);
  });

  test("Fehler von Twilio oder Netz: false, nichts wirft, kein Antworttext im Log", async () => {
    const lines: string[] = [];
    const rejecting = createTwilioSender({ accountSid: "A", authToken: TOKEN, from: "+1", fetch: async () => new Response("geheim +491", { status: 400 }), warn: l => void lines.push(l) });
    expect(await rejecting.sendOne("+491", "x")).toBe(false);
    const offline = createTwilioSender({ accountSid: "A", authToken: TOKEN, from: "+1", fetch: async () => { throw new TypeError("offline"); }, warn: l => void lines.push(l) });
    expect(await offline.sendOne("+491", "x")).toBe(false);
    expect(lines.join("\n")).not.toContain("+491");
  });
});

describe("Webhook", () => {
  function webhook(opts: { allowed?: string[]; publicUrl?: string } = {}) {
    const handled: [string, string][] = [];
    const fetch = createWhatsAppWebhook({
      authToken: TOKEN,
      publicUrl: opts.publicUrl,
      isAllowed: n => (opts.allowed ?? ["+491"]).includes(n),
      handle: async (from, body) => void handled.push([from, body]),
      health: () => ({ pid: 1 }),
      log: () => {},
    });
    return { fetch, handled };
  }
  const post = (url: string, fields: Record<string, string>, signature = twilioSignatureFor(TOKEN, url, fields)) =>
    new Request(url, { method: "POST", headers: { "X-Twilio-Signature": signature }, body: new URLSearchParams(fields).toString() });

  test("gültige Nachricht: sofort leeres TwiML, Verarbeitung mit getrimmtem Text", async () => {
    const w = webhook();
    const res = await w.fetch(post("http://127.0.0.1:3001/webhook/whatsapp", { From: "whatsapp:+491", Body: "  Hallo  ", MessageSid: "SM1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/xml");
    expect(await res.text()).toBe(EMPTY_TWIML);
    expect(w.handled).toEqual([["whatsapp:+491", "Hallo"]]);
  });

  test("falsche Signatur: 403", async () => {
    const w = webhook();
    const res = await w.fetch(post("http://127.0.0.1:3001/webhook/whatsapp", { From: "whatsapp:+491", Body: "x" }, "falsch"));
    expect(res.status).toBe(403);
    expect(w.handled).toEqual([]);
  });

  test("Signatur über WHATSAPP_WEBHOOK_URL statt der lokalen Adresse", async () => {
    const w = webhook({ publicUrl: URL_ });
    const fields = { From: "whatsapp:+491", Body: "x" };
    const res = await w.fetch(post("http://127.0.0.1:3001/webhook/whatsapp", fields, twilioSignatureFor(TOKEN, URL_, fields)));
    expect(res.status).toBe(200);
    expect(w.handled).toHaveLength(1);
  });

  test("nicht freigegebener Absender und Nachricht ohne Text: still quittiert", async () => {
    const w = webhook();
    expect(await (await w.fetch(post("http://h/webhook/whatsapp", { From: "whatsapp:+499", Body: "x" }))).text()).toBe(EMPTY_TWIML);
    expect(await (await w.fetch(post("http://h/webhook/whatsapp", { From: "whatsapp:+491", Body: "   ", NumMedia: "1" }))).text()).toBe(EMPTY_TWIML);
    expect(w.handled).toEqual([]);
  });

  test("Zustand und unbekannte Pfade", async () => {
    const w = webhook();
    const health = await w.fetch(new Request("http://h/health"));
    expect(await health.json()).toEqual({ status: "ok", service: "tybo-whatsapp-gateway", pid: 1 });
    expect((await w.fetch(new Request("http://h/sonstwo"))).status).toBe(404);
    expect((await w.fetch(new Request("http://h/webhook/whatsapp"))).status).toBe(404);
  });
});

describe("Einstellungen", () => {
  const base = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: TOKEN, WHATSAPP_USER_NUMBER: "whatsapp:+491" };
  test("Pflichtvariablen", () => {
    expect(() => readWhatsAppConfig({ ...base, TWILIO_AUTH_TOKEN: "" })).toThrow("TWILIO_AUTH_TOKEN");
  });
  test("Standardwerte und Freigabeliste", () => {
    const c = readWhatsAppConfig({ ...base, WHATSAPP_ALLOWED_NUMBERS: " +492, ,whatsapp:+493" });
    expect([...c.allowed]).toEqual(["+491", "+492", "+493"]);
    expect(c).toMatchObject({ host: "127.0.0.1", port: 3001, publicUrl: "", from: TWILIO_SANDBOX_DEFAULT });
  });
  test("Absender wie bisher: Sandbox-Nummer gewinnt", () => {
    expect(readWhatsAppConfig({ ...base, TWILIO_WHATSAPP_NUMBER: "+4900" }).from).toBe(TWILIO_SANDBOX_DEFAULT);
    expect(readWhatsAppConfig({ ...base, TWILIO_SANDBOX_NUMBER: "+1555" }).from).toBe("+1555");
  });
});
