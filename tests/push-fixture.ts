/**
 * Empfänger-Seite für Push-Tests (Issue #226): ein Abo mit den Schlüsseln aus
 * RFC 8291 Anhang A und eine Entschlüsselung wie im Browser. Damit lässt
 * sich prüfen, was wirklich in der verschlüsselten Nutzlast steht.
 */
import { fromBase64Url, toBase64Url } from "../src/web/push";

const b = (s: string) => fromBase64Url(s)!;
const u = (bytes: Uint8Array) => toBase64Url(bytes);

export const RECEIVER = {
  p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  privateKey: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};

export function receiverSubscription(n: number | string) {
  return { endpoint: `https://fcm.googleapis.com/fcm/send/geheim-${n}`, keys: { p256dh: RECEIVER.p256dh, auth: RECEIVER.auth } };
}

/** Entschlüsselt einen aes128gcm-Body (RFC 8291) mit dem Empfänger-Schlüssel */
export async function decryptPush(body: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 86);
  const uaPublic = b(RECEIVER.p256dh);
  const jwk: JsonWebKey = {
    kty: "EC", crv: "P-256", d: RECEIVER.privateKey,
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
  const ikm = await hmac(await hmac(b(RECEIVER.auth), secret), cat(enc.encode("WebPush: info\0"), uaPublic, asPublic, one));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), one))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), one))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(86)));
  return new TextDecoder().decode(plain.slice(0, -1));
}
