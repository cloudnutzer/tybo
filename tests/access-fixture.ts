/**
 * Test-Schlüsselpaare und signierte Access-Nachweise (Issue #99), ohne Netz:
 * der Schlüsselabruf ist eine Attrappe, die ein certs-Dokument wie bei
 * Cloudflare liefert.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { AccessConfig } from "../src/web/config";
import { accessIssuer, type FetchCerts } from "../src/web/access";

export const TEAM = "meinteam";
export const AUD = "a".repeat(40) + "0123456789abcdef0123456789";
export const ACCESS: AccessConfig = { team: TEAM, aud: AUD };

export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

export function makeKey(kid: string, bits = 2048): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

export const KEY_A = makeKey("kid-a");
export const KEY_B = makeKey("kid-b");

function part(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Gültige Angaben für jetzt; alles lässt sich überschreiben (undefined entfernt ein Feld) */
export function claims(nowMs = Date.now(), extra: Record<string, unknown> = {}): Record<string, unknown> {
  const s = Math.floor(nowMs / 1000);
  const base: Record<string, unknown> = {
    aud: [AUD],
    email: "alex@example.org",
    exp: s + 3600,
    iat: s,
    nbf: s,
    iss: accessIssuer(TEAM),
    type: "app",
    sub: "abc",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

export function signJwt(
  payload: Record<string, unknown>,
  key: TestKey = KEY_A,
  header: Record<string, unknown> = { alg: "RS256", kid: key.kid, typ: "JWT" }
): string {
  const data = `${part(header)}.${part(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(data), key.privateKey).toString("base64url");
  return `${data}.${signature}`;
}

/** Gültiger Nachweis für jetzt mit KEY_A */
export function validJwt(nowMs = Date.now()): string {
  return signJwt(claims(nowMs));
}

/** Attrappe für den Schlüsselabruf: zählt Aufrufe, Schlüssel und Fehler umschaltbar */
export class FakeCerts {
  calls: string[] = [];
  keys: TestKey[];
  fail = false;
  constructor(keys: TestKey[] = [KEY_A]) {
    this.keys = keys;
  }
  fetch: FetchCerts = async url => {
    this.calls.push(url);
    if (this.fail) throw new Error("netz aus");
    return { keys: this.keys.map(k => k.jwk), public_cert: { kid: "x", cert: "-" } };
  };
}
