/**
 * Web Push (Issue #225), Teil src/web/push.ts: Verschlüsselung gegen die
 * Testvektoren aus RFC 8291 (Abschnitt 5 und Anhang A), VAPID-JWT nach
 * RFC 8292 (Signatur, aud, exp), Zielprüfung und Versand gegen eine
 * fetch-Attrappe (Kopfzeilen, Ergebnis je Status, Zeitlimit, Weiterleitung).
 */
import { describe, expect, test } from "bun:test";
import {
  encryptPushPayload,
  fromBase64Url,
  generateVapidKeys,
  parsePushEndpoint,
  sendPush,
  toBase64Url,
  validateVapidKeys,
  validPushKeys,
  validPushKeysStrict,
  validPushSubject,
  vapidJwt,
  VAPID_TTL_SECONDS,
  type EncryptTrace,
  type PushTarget,
} from "../src/web/push";

const b = (s: string) => fromBase64Url(s.replace(/\s+/g, ""))!;
const u = (bytes: Uint8Array) => toBase64Url(bytes);

// RFC 8291, Abschnitt 5 und Anhang A
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  header: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
           mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`,
  body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
         pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";

describe("Verschlüsselung nach RFC 8291", () => {
  test("ergibt mit festem Salt und Sender-Schlüssel genau den Body aus Abschnitt 5 und die Zwischenwerte aus Anhang A", async () => {
    let trace: EncryptTrace | null = null;
    const body = await encryptPushPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, b(RFC.plaintext), {
      senderKeys: { publicKey: RFC.asPublic, privateKey: RFC.asPrivate },
      salt: b(RFC.salt),
      trace: t => (trace = t),
    });
    expect(u(body)).toBe(u(b(RFC.body)));
    // Kopf 86 + Text 41 + Trennbyte 1 + Tag 16; die „Content-Length: 145" im RFC-Beispiel ist verzählt
    expect(body.length).toBe(144);
    const t = trace as unknown as EncryptTrace;
    expect(u(t.ecdhSecret)).toBe(RFC.ecdhSecret);
    expect(u(t.ikm)).toBe(RFC.ikm);
    expect(u(t.cek)).toBe(RFC.cek);
    expect(u(t.nonce)).toBe(RFC.nonce);
    expect(u(t.header)).toBe(u(b(RFC.header)));
    expect(t.header.length).toBe(86);
  });

  test("der Empfänger (privater Schlüssel aus Anhang A) entschlüsselt eine Nachricht mit frischem Schlüssel und Salt", async () => {
    const keys = { p256dh: RFC.uaPublic, auth: RFC.auth };
    const text = new TextEncoder().encode(JSON.stringify({ title: "Hallo" }));
    const one = await encryptPushPayload(keys, text);
    const two = await encryptPushPayload(keys, text);
    // Salt und Sender-Schlüssel pro Nachricht neu
    expect(u(one.slice(0, 16))).not.toBe(u(two.slice(0, 16)));
    expect(u(one.slice(21, 86))).not.toBe(u(two.slice(21, 86)));
    expect(await decrypt(one)).toBe(JSON.stringify({ title: "Hallo" }));
  });

  test("lehnt kaputte Abo-Schlüssel und zu große Nachrichten ab", async () => {
    await expect(encryptPushPayload({ p256dh: "AAAA", auth: RFC.auth }, new Uint8Array(1))).rejects.toThrow();
    await expect(encryptPushPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, new Uint8Array(4000))).rejects.toThrow();
  });
});

/** Entschlüsselt wie ein Browser mit dem Empfänger-Schlüssel aus Anhang A */
async function decrypt(body: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 86);
  const uaPublic = b(RFC.uaPublic);
  const jwk: JsonWebKey = {
    kty: "EC", crv: "P-256", d: RFC.uaPrivate,
    x: u(uaPublic.slice(1, 33)), y: u(uaPublic.slice(33, 65)),
  };
  const priv = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pub = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
  const hmac = async (key: Uint8Array, data: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data));
  const enc = new TextEncoder();
  const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  const one = new Uint8Array([1]);
  const ikm = await hmac(await hmac(b(RFC.auth), secret), cat(enc.encode("WebPush: info\0"), uaPublic, asPublic, one));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), one))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), one))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(86)));
  expect(plain[plain.length - 1]).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

describe("VAPID-Schlüssel und JWT nach RFC 8292", () => {
  test("erzeugte Schlüssel haben 65 und 32 Bytes und gehören zusammen", async () => {
    const keys = await generateVapidKeys();
    expect(b(keys.publicKey).length).toBe(65);
    expect(b(keys.publicKey)[0]).toBe(4);
    expect(b(keys.privateKey).length).toBe(32);
    expect(await validateVapidKeys(keys)).toBe(true);
  });

  test("unvollständige, kaputte oder nicht zusammengehörige Paare gelten als ungültig", async () => {
    const a = await generateVapidKeys();
    const other = await generateVapidKeys();
    expect(await validateVapidKeys({ publicKey: a.publicKey })).toBe(false);
    expect(await validateVapidKeys({ privateKey: a.privateKey })).toBe(false);
    expect(await validateVapidKeys({ publicKey: a.publicKey, privateKey: "kaputt!" })).toBe(false);
    expect(await validateVapidKeys({ publicKey: a.publicKey, privateKey: other.privateKey })).toBe(false);
  });

  test("JWT: ES256, aud ist der Ursprung des Endpunkts, exp höchstens 12 Stunden, Signatur prüfbar", async () => {
    const keys = await generateVapidKeys();
    const now = Date.UTC(2026, 8, 28, 12);
    const jwt = await vapidJwt(`${ENDPOINT}?x=1`, "https://tybo.example", keys, now);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("https://tybo.example");
    expect(claims.exp).toBe(now / 1000 + VAPID_TTL_SECONDS);
    expect(VAPID_TTL_SECONDS).toBeLessThanOrEqual(12 * 3600);
    const pub = await crypto.subtle.importKey("raw", b(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b(s), new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
    expect(b(s).length).toBe(64);
  });

  test("Kontakt nur mailto: oder https:", () => {
    expect(validPushSubject("https://tybo.ai")).toBe(true);
    expect(validPushSubject("mailto:alex@example.org")).toBe(true);
    expect(validPushSubject("http://tybo.ai")).toBe(false);
    expect(validPushSubject("alex@example.org")).toBe(false);
    expect(validPushSubject("")).toBe(false);
  });
});

describe("Ziele nur bei bekannten Push-Diensten", () => {
  test.each([
    "https://web.push.apple.com/QGu",
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ])("erlaubt %s", endpoint => {
    expect(parsePushEndpoint(endpoint)).not.toBeNull();
  });

  test.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://user:pw@fcm.googleapis.com/fcm/send/abc",
    "https://evilpush.apple.com/x",
    "https://push.apple.com/x",
    "https://push.apple.com.evil.example/x",
    "https://fcm.googleapis.com.evil.example/x",
    "https://evil.example/fcm.googleapis.com",
    "https://127.0.0.1/x",
    "https://localhost/x",
    "https://fcm.googleapis.com/x#frag",
    "javascript:alert(1)",
    "https://fcm.googleapis.com/" + "a".repeat(3000),
  ])("lehnt %s ab", endpoint => {
    expect(parsePushEndpoint(endpoint)).toBeNull();
  });

  test("Abo-Schlüssel: p256dh 65 Bytes mit 0x04, auth 16 Bytes", () => {
    expect(validPushKeys({ p256dh: RFC.uaPublic, auth: RFC.auth })).toBe(true);
    expect(validPushKeys({ p256dh: RFC.uaPublic.slice(0, 40), auth: RFC.auth })).toBe(false);
    expect(validPushKeys({ p256dh: RFC.uaPublic, auth: "AAAA" })).toBe(false);
    expect(validPushKeys({ p256dh: RFC.uaPublic, auth: RFC.auth + "x".repeat(100) })).toBe(false);
    expect(validPushKeys(null)).toBe(false);
  });

  test("Abo-Schlüssel streng: 0x04 mit 64 Nullbytes hat die Länge, ist aber kein Punkt auf P-256", async () => {
    const zeroPoint = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url");
    expect(validPushKeys({ p256dh: zeroPoint, auth: RFC.auth })).toBe(true);
    expect(await validPushKeysStrict({ p256dh: zeroPoint, auth: RFC.auth })).toBe(false);
    expect(await validPushKeysStrict({ p256dh: RFC.uaPublic, auth: RFC.auth })).toBe(true);
    expect(await validPushKeysStrict({ p256dh: RFC.uaPublic, auth: "AAAA" })).toBe(false);
  });
});

describe("Versand mit fetch-Attrappe", () => {
  const target: PushTarget = { endpoint: ENDPOINT, keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };

  function fakeFetch(status: number, seen: { url?: string; init?: RequestInit }[] = []) {
    return (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
  }

  test("setzt Authorization: vapid t=…, k=…, Content-Encoding aes128gcm, TTL, Urgency, Topic und keine Weiterleitung", async () => {
    const keys = await generateVapidKeys();
    const seen: { url?: string; init?: RequestInit }[] = [];
    const result = await sendPush(target, { title: "Test" }, {
      keys, subject: "https://tybo.example", ttl: 60, urgency: "high", topic: "gespraech-1", fetch: fakeFetch(201, seen),
    });
    expect(result).toEqual({ status: "ok", code: 201 });
    const { url, init } = seen[0];
    expect(url).toBe(ENDPOINT);
    expect(init!.method).toBe("POST");
    expect(init!.redirect).toBe("manual");
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe("60");
    expect(headers.Urgency).toBe("high");
    expect(headers.Topic).toBe("gespraech-1");
    const body = init!.body as Uint8Array;
    expect(await decrypt(body)).toBe(JSON.stringify({ title: "Test" }));
  });

  test("Topic mit ungültigen Zeichen fällt weg, Standard-TTL ist ein Tag", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    await sendPush(target, { title: "x" }, { keys: await generateVapidKeys(), subject: "https://t.example", topic: "a b", fetch: fakeFetch(201, seen) });
    const headers = seen[0].init!.headers as Record<string, string>;
    expect(headers.Topic).toBeUndefined();
    expect(headers.TTL).toBe("86400");
    expect(headers.Urgency).toBe("normal");
  });

  test.each([
    [410, "gone"], [404, "gone"],
    [429, "retry"], [413, "retry"], [500, "retry"], [503, "retry"],
    [301, "error"], [302, "error"], [400, "error"], [403, "error"],
  ] as const)("Antwort %d ergibt %s", async (status, expected) => {
    const result = await sendPush(target, { title: "x" }, { keys: await generateVapidKeys(), subject: "https://t.example", fetch: fakeFetch(status) });
    expect(result.status).toBe(expected);
  });

  test("fremder Host wird ohne Anfrage abgelehnt, auch beim Versand", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const result = await sendPush({ ...target, endpoint: "https://evil.example/push" }, { title: "x" }, {
      keys: await generateVapidKeys(), subject: "https://t.example", fetch: fakeFetch(201, seen),
    });
    expect(result.status).toBe("rejected");
    expect(seen.length).toBe(0);
  });

  test("Zeitlimit bricht ab und meldet error", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const started = Date.now();
    const result = await sendPush(target, { title: "x" }, { keys: await generateVapidKeys(), subject: "https://t.example", fetch: hang, timeoutMs: 50 });
    expect(result).toEqual({ status: "error", reason: "Zeitlimit" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("Netzfehler meldet error ohne Endpunkt im Grund", async () => {
    const fail = (async () => { throw new TypeError(`fetch failed ${ENDPOINT}`); }) as unknown as typeof fetch;
    const result = await sendPush(target, { title: "x" }, { keys: await generateVapidKeys(), subject: "https://t.example", fetch: fail });
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("abc123");
  });
});
