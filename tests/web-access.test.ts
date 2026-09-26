/**
 * Issue #99, Schritt 1 (Sicherheitstests): Cloudflare-Access-Nachweis prüfen
 * und Konfiguration WEB_ACCESS_TEAM / WEB_ACCESS_AUD. Test-Schlüsselpaare,
 * der Schlüsselabruf ist eine Attrappe (kein Netz).
 */
import { describe, expect, test } from "bun:test";
import {
  accessCertsUrl,
  ACCESS_CACHE_MS,
  ACCESS_MAX_STALE_MS,
  ACCESS_MIN_REFRESH_MS,
  ACCESS_REASON_TEXT,
  createAccessVerifier,
  parseCerts,
  type FetchCerts,
} from "../src/web/access";
import { loadWebConfig, parseAccessConfig } from "../src/web/config";
import { ACCESS, AUD, claims, FakeCerts, KEY_A, KEY_B, makeKey, signJwt, TEAM, validJwt } from "./access-fixture";

const T0 = 1_800_000_000_000;

function setup(certs = new FakeCerts(), start = T0) {
  let now = start;
  const logs: string[] = [];
  const verifier = createAccessVerifier({ access: ACCESS, fetchCerts: certs.fetch, now: () => now, log: m => logs.push(m) });
  return {
    certs,
    logs,
    verify: (t: string | null) => verifier.verify(t),
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

describe("Konfiguration", () => {
  const PW = { WEB_ENABLED: "true", WEB_PASSWORD: "richtig-langes-pw" };

  test("ohne beide Werte kein Access", () => {
    expect(parseAccessConfig({})).toEqual({ status: "ok", access: null });
    const r = loadWebConfig(PW);
    expect(r.status === "ok" && r.config.access).toBeNull();
  });

  test("beide gesetzt: Team klein, auch als ganze Adresse", () => {
    for (const WEB_ACCESS_TEAM of ["meinteam", " MeinTeam ", "meinteam.cloudflareaccess.com", "https://meinteam.cloudflareaccess.com/"]) {
      expect(parseAccessConfig({ WEB_ACCESS_TEAM, WEB_ACCESS_AUD: AUD })).toEqual({ status: "ok", access: { team: TEAM, aud: AUD } });
    }
    const r = loadWebConfig({ ...PW, WEB_ACCESS_TEAM: TEAM, WEB_ACCESS_AUD: AUD });
    expect(r.status === "ok" && r.config.access).toEqual({ team: TEAM, aud: AUD });
  });

  test("nur eins gesetzt: WebUI startet nicht", () => {
    for (const env of [{ WEB_ACCESS_TEAM: TEAM }, { WEB_ACCESS_AUD: AUD }, { WEB_ACCESS_TEAM: " ", WEB_ACCESS_AUD: AUD }]) {
      const r = loadWebConfig({ ...PW, ...env });
      expect(r.status).toBe("invalid");
      if (r.status === "invalid") expect(r.reason).toContain("gehören zusammen");
    }
  });

  test("ungültiger Team-Name: kein Subdomain-Teil", () => {
    for (const WEB_ACCESS_TEAM of ["mein.team", "-team", "team-", "mein_team", "evil.example/x", "a".repeat(64), "team@x", "meinteam.cloudflareaccess.com.evil"]) {
      const r = loadWebConfig({ ...PW, WEB_ACCESS_TEAM, WEB_ACCESS_AUD: AUD });
      expect(r.status).toBe("invalid");
      if (r.status === "invalid") expect(r.reason).toContain("WEB_ACCESS_TEAM");
    }
  });

  test("ungültiger AUD", () => {
    for (const WEB_ACCESS_AUD of ["kurz", "mit leerzeichen 1234567890", "x".repeat(129), "ä".repeat(20)]) {
      const r = loadWebConfig({ ...PW, WEB_ACCESS_TEAM: TEAM, WEB_ACCESS_AUD });
      expect(r.status).toBe("invalid");
      if (r.status === "invalid") expect(r.reason).not.toContain(WEB_ACCESS_AUD);
    }
  });

  test("certs-Adresse aus dem Team", () => {
    expect(accessCertsUrl(TEAM)).toBe("https://meinteam.cloudflareaccess.com/cdn-cgi/access/certs");
  });
});

describe("Nachweis prüfen", () => {
  test("gültig", async () => {
    const s = setup();
    expect(await s.verify(validJwt(T0))).toEqual({ ok: true });
    expect(s.certs.calls).toEqual([accessCertsUrl(TEAM)]);
  });

  test("aud als einzelner Text oder unter mehreren", async () => {
    const s = setup();
    expect(await s.verify(signJwt(claims(T0, { aud: AUD })))).toEqual({ ok: true });
    expect(await s.verify(signJwt(claims(T0, { aud: ["andere", AUD] })))).toEqual({ ok: true });
  });

  test("fehlt oder leer", async () => {
    const s = setup();
    for (const t of [null, "", "   "]) expect(await s.verify(t)).toEqual({ ok: false, reason: "fehlt" });
    expect(s.certs.calls).toEqual([]);
  });

  test("kaputt: Aufbau, base64url, JSON", async () => {
    const s = setup();
    const good = validJwt(T0);
    const [h, p, sig] = good.split(".");
    const bad = [
      "abc",
      "a.b",
      `${h}.${p}`,
      `${h}.${p}.${sig}.x`,
      `${h}.${p}.`,
      `${h}..${sig}`,
      `${h}.${p}.${sig}=`,
      `${h}.@@@.${sig}`,
      `${Buffer.from("kein json").toString("base64url")}.${p}.${sig}`,
      `${Buffer.from("[1]").toString("base64url")}.${p}.${sig}`,
      `${h}.${Buffer.from("null").toString("base64url")}.${sig}`,
      "x".repeat(20_000),
      signJwt(claims(T0), KEY_A, { alg: "RS256" }),
      signJwt(claims(T0), KEY_A, { alg: "RS256", kid: 5 }),
    ];
    for (const t of bad) expect(await s.verify(t)).toEqual({ ok: false, reason: "format" });
    expect(s.certs.calls).toEqual([]);
  });

  test("falscher Algorithmus, auch none und HS256", async () => {
    const s = setup();
    for (const alg of ["none", "HS256", "RS512", "ES256", "rs256", undefined]) {
      const t = signJwt(claims(T0), KEY_A, { alg, kid: KEY_A.kid });
      expect(await s.verify(t)).toEqual({ ok: false, reason: "algorithmus" });
    }
  });

  test("falsche aud", async () => {
    const s = setup();
    for (const aud of ["andere-anwendung", ["x", "y"], [], undefined, 5, [AUD.toUpperCase()]]) {
      expect(await s.verify(signJwt(claims(T0, { aud })))).toEqual({ ok: false, reason: "aud" });
    }
  });

  test("falscher Aussteller", async () => {
    const s = setup();
    for (const iss of ["https://anderes.cloudflareaccess.com", "https://meinteam.cloudflareaccess.com/", "http://meinteam.cloudflareaccess.com", undefined]) {
      expect(await s.verify(signJwt(claims(T0, { iss })))).toEqual({ ok: false, reason: "iss" });
    }
  });

  test("abgelaufen, mit 30 Sekunden Spielraum", async () => {
    const s = setup();
    const exp = Math.floor(T0 / 1000) - 31;
    expect(await s.verify(signJwt(claims(T0, { exp })))).toEqual({ ok: false, reason: "abgelaufen" });
    expect(await s.verify(signJwt(claims(T0, { exp: exp + 2 })))).toEqual({ ok: true });
    // Ein gültiges Token läuft mit der Zeit ab
    const t = validJwt(T0);
    s.advance(3600_000 + 30_000);
    expect(await s.verify(t)).toEqual({ ok: false, reason: "abgelaufen" });
  });

  test("nbf in der Zukunft", async () => {
    const s = setup();
    const nbf = Math.floor(T0 / 1000) + 120;
    expect(await s.verify(signJwt(claims(T0, { nbf })))).toEqual({ ok: false, reason: "noch-nicht-gueltig" });
    s.advance(91_000);
    expect(await s.verify(signJwt(claims(T0, { nbf })))).toEqual({ ok: true });
  });

  test("fehlende oder ungültige Zeitangaben", async () => {
    const s = setup();
    const cases: Record<string, unknown>[] = [
      { exp: undefined },
      { exp: "9999999999" },
      { exp: null },
      { exp: -1 },
      { nbf: "0" },
      { nbf: null },
      { iat: "gestern" },
      { iat: {} },
    ];
    for (const extra of cases) {
      expect(await s.verify(signJwt(claims(T0, extra)))).toEqual({ ok: false, reason: "zeitangaben" });
    }
  });

  test("falsche Signatur: fremder Schlüssel mit bekannter kid, veränderter Inhalt", async () => {
    const s = setup();
    const forged = makeKey(KEY_A.kid);
    expect(await s.verify(signJwt(claims(T0), forged))).toEqual({ ok: false, reason: "signatur" });
    const [h, , sig] = validJwt(T0).split(".");
    const payload = Buffer.from(JSON.stringify(claims(T0, { email: "boese@example.org" }))).toString("base64url");
    expect(await s.verify(`${h}.${payload}.${sig}`)).toEqual({ ok: false, reason: "signatur" });
    expect(await s.verify(`${h}.${validJwt(T0).split(".")[1]}.AAAA`)).toEqual({ ok: false, reason: "signatur" });
  });

  test("Log und Gründe enthalten nie das Token", async () => {
    const s = setup();
    const t = signJwt(claims(T0, { aud: "x" }));
    await s.verify(t);
    for (const text of [...s.logs, ...Object.values(ACCESS_REASON_TEXT)]) expect(text).not.toContain(t.split(".")[2]);
  });
});

describe("Schlüssel abrufen", () => {
  test("zwischengespeichert: bekannter kid ohne neuen Abruf, nach einer Stunde neu", async () => {
    const s = setup();
    await s.verify(validJwt(T0));
    await s.verify(validJwt(T0));
    expect(s.certs.calls.length).toBe(1);
    s.advance(ACCESS_CACHE_MS);
    expect(await s.verify(validJwt(s.now()))).toEqual({ ok: true });
    expect(s.certs.calls.length).toBe(2);
  });

  test("unbekannte kid lädt neu und findet den neuen Schlüssel (Schlüsselwechsel)", async () => {
    const s = setup(new FakeCerts([KEY_A]));
    expect(await s.verify(validJwt(T0))).toEqual({ ok: true });
    s.certs.keys = [KEY_A, KEY_B];
    // Innerhalb der Minute nach dem letzten Abruf kein neuer Abruf
    expect(await s.verify(signJwt(claims(T0), KEY_B))).toEqual({ ok: false, reason: "schluessel-unbekannt" });
    expect(s.certs.calls.length).toBe(1);
    s.advance(ACCESS_MIN_REFRESH_MS);
    expect(await s.verify(signJwt(claims(T0), KEY_B))).toEqual({ ok: true });
    expect(s.certs.calls.length).toBe(2);
    expect(await s.verify(validJwt(T0))).toEqual({ ok: true });
  });

  test("dauerhaft unbekannte kid: abgelehnt, höchstens ein Abruf pro Minute, auch bei wechselnden kids", async () => {
    const s = setup();
    await s.verify(validJwt(T0));
    s.advance(ACCESS_MIN_REFRESH_MS);
    for (let i = 0; i < 20; i++) {
      const stranger = makeKey(`fremd-${i}`, 2048);
      expect(await s.verify(signJwt(claims(T0), stranger))).toEqual({ ok: false, reason: "schluessel-unbekannt" });
    }
    expect(s.certs.calls.length).toBe(2);
    s.advance(ACCESS_MIN_REFRESH_MS);
    expect(await s.verify(signJwt(claims(T0), makeKey("fremd-x")))).toEqual({ ok: false, reason: "schluessel-unbekannt" });
    expect(s.certs.calls.length).toBe(3);
    // Bekannte Schlüssel gelten weiter
    expect(await s.verify(validJwt(s.now()))).toEqual({ ok: true });
  });

  test("gleichzeitige Anfragen teilen sich einen Abruf", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const certs = new FakeCerts();
    let calls = 0;
    const slow: FetchCerts = async (url, signal) => {
      calls++;
      await gate;
      return certs.fetch(url, signal);
    };
    const verifier = createAccessVerifier({ access: ACCESS, fetchCerts: slow, now: () => T0 });
    const pending = Array.from({ length: 10 }, () => verifier.verify(validJwt(T0)));
    release();
    expect(await Promise.all(pending)).toEqual(Array(10).fill({ ok: true }));
    expect(calls).toBe(1);
  });

  test("Abruf fehlgeschlagen: abgelehnt mit eigenem Grund, gebremst, später wieder gut", async () => {
    const certs = new FakeCerts();
    certs.fail = true;
    const s = setup(certs);
    expect(await s.verify(validJwt(T0))).toEqual({ ok: false, reason: "schluesselabruf" });
    expect(await s.verify(validJwt(T0))).toEqual({ ok: false, reason: "schluesselabruf" });
    expect(certs.calls.length).toBe(1);
    expect(s.logs).toEqual(["Access: Schlüsselabruf fehlgeschlagen (Error)"]);
    certs.fail = false;
    s.advance(ACCESS_MIN_REFRESH_MS);
    expect(await s.verify(validJwt(s.now()))).toEqual({ ok: true });
  });

  test("Abruf mit Unsinn oder ohne gültige Schlüssel zählt als fehlgeschlagen", async () => {
    for (const body of [null, "text", { keys: "x" }, { keys: [] }, { keys: [{ kid: "kid-a", kty: "EC" }, { kid: "k", kty: "RSA", n: "xx", e: "AQAB" }] }]) {
      const verifier = createAccessVerifier({ access: ACCESS, fetchCerts: async () => body, now: () => T0 });
      expect(await verifier.verify(validJwt(T0))).toEqual({ ok: false, reason: "schluesselabruf" });
    }
  });

  test("Schlüssel unter 2048 Bit werden nicht angenommen", () => {
    const small = makeKey("klein", 1024);
    expect([...parseCerts({ keys: [small.jwk, KEY_A.jwk] }).keys()]).toEqual([KEY_A.kid]);
  });

  test("veraltete Schlüssel gelten bei Abruffehlern noch bis zu einem Tag", async () => {
    const s = setup();
    await s.verify(validJwt(T0));
    s.certs.fail = true;
    s.advance(ACCESS_CACHE_MS + 1000);
    expect(await s.verify(validJwt(s.now()))).toEqual({ ok: true });
    s.advance(ACCESS_MAX_STALE_MS);
    expect(await s.verify(validJwt(s.now()))).toEqual({ ok: false, reason: "schluesselabruf" });
  });

  test("Abruf mit Zeitlimit: hängender Abruf wird abgebrochen", async () => {
    let aborted = false;
    const hanging: FetchCerts = (_url, signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => ((aborted = true), reject(new Error("abgebrochen")))));
    const verifier = createAccessVerifier({ access: ACCESS, fetchCerts: hanging, timeoutMs: 20 });
    expect(await verifier.verify(validJwt())).toEqual({ ok: false, reason: "schluesselabruf" });
    expect(aborted).toBe(true);
  });
});
