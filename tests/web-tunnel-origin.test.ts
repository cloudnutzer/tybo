/**
 * Issue #98, Schritt 1: requestOrigin entscheidet an einer Stelle, ob eine
 * Anfrage über den Cloudflare Tunnel kommt, ob sie echt lokal ist und welche
 * Besucher-IP für Login-Bremse und Log gilt. Dazu die neue Einstellung
 * WEB_PUBLIC_ORIGIN.
 */
import { describe, expect, test } from "bun:test";
import { requestOrigin, TUNNEL_UNKNOWN_CLIENT } from "../src/web/auth";
import { loadWebConfig, parsePublicOrigin } from "../src/web/config";

const PUBLIC = "https://app.tybo.ai";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3100/api/me", { headers });
}

describe("requestOrigin", () => {
  test("Loopback ohne Kopfzeile: lokal, nicht getunnelt, IP aus der Verbindung", () => {
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(requestOrigin(req(), peer, PUBLIC)).toEqual({ tunneled: false, via: null, local: true, clientIp: peer });
      expect(requestOrigin(req(), peer, null)).toEqual({ tunneled: false, via: null, local: true, clientIp: peer });
    }
  });

  test("Loopback mit CF-Connecting-IP: getunnelt, Besucher-IP aus der Kopfzeile", () => {
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(requestOrigin(req({ "CF-Connecting-IP": "203.0.113.7" }), peer, PUBLIC)).toEqual({
        tunneled: true,
        via: "cloudflare",
        local: false,
        clientIp: "203.0.113.7",
      });
    }
    expect(requestOrigin(req({ "cf-connecting-ip": " 2001:DB8::1 " }), "127.0.0.1", PUBLIC).clientIp).toBe("2001:db8::1");
  });

  test("fremde IP mit CF-Connecting-IP: Kopfzeile wird ignoriert", () => {
    for (const peer of ["192.168.1.20", "10.0.0.5", "fe80::1", "127.0.0.2"]) {
      expect(requestOrigin(req({ "CF-Connecting-IP": "127.0.0.1" }), peer, PUBLIC)).toEqual({
        tunneled: false,
        via: null,
        local: false,
        clientIp: peer,
      });
    }
  });

  // Seit Issue #231: eine weitergeleitete Anfrage ist auch ohne WEB_PUBLIC_ORIGIN nie
  // lokal (etwa `tailscale serve`, eingerichtet, bevor tybo neu gestartet ist)
  test("ohne WEB_PUBLIC_ORIGIN: nie getunnelt, IP aus der Verbindung, mit Weiterleitungs-Kopfzeile nicht lokal", () => {
    for (const origin of [null, undefined, ""]) {
      expect(requestOrigin(req({ "CF-Connecting-IP": "203.0.113.7" }), "127.0.0.1", origin)).toEqual({
        tunneled: false,
        via: null,
        local: false,
        clientIp: "127.0.0.1",
      });
      expect(requestOrigin(req(), "127.0.0.1", origin).local).toBe(true);
    }
  });

  test("leere, ungültige oder mehrfache Werte: getunnelt, fester Platzhalter statt Text, nie lokal", () => {
    const bad = ["", "   ", "kein-ip", "203.0.113.7, 198.51.100.2", "203.0.113.7 x", "999.1.1.1", "<script>"];
    for (const value of bad) {
      expect(requestOrigin(req({ "CF-Connecting-IP": value }), "127.0.0.1", PUBLIC)).toEqual({
        tunneled: true,
        via: "cloudflare",
        local: false,
        clientIp: TUNNEL_UNKNOWN_CLIENT,
      });
    }
    // Zweimal gesetzte Kopfzeile kommt zusammengefügt an und gilt ebenfalls als ungültig
    const h = new Headers();
    h.append("CF-Connecting-IP", "203.0.113.7");
    h.append("CF-Connecting-IP", "198.51.100.2");
    const twice = new Request("http://127.0.0.1:3100/", { headers: h });
    expect(requestOrigin(twice, "127.0.0.1", PUBLIC).clientIp).toBe(TUNNEL_UNKNOWN_CLIENT);
  });

  test("Besucher-IP 127.0.0.1 in der Kopfzeile macht die Anfrage nicht lokal", () => {
    const r = requestOrigin(req({ "CF-Connecting-IP": "127.0.0.1" }), "127.0.0.1", PUBLIC);
    expect(r).toEqual({ tunneled: true, via: "cloudflare", local: false, clientIp: "127.0.0.1" });
  });
});

describe("WEB_PUBLIC_ORIGIN", () => {
  const base = { WEB_ENABLED: "true", WEB_PASSWORD: "richtig-langes-pw" };

  test("fehlt: publicOrigin null, sonst unverändert", () => {
    const r = loadWebConfig(base);
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.config.publicOrigin).toBeNull();
  });

  test("gültig: https-Origin, klein geschrieben, ohne abschließenden Schrägstrich", () => {
    for (const value of ["https://app.tybo.ai", " https://App.Tybo.AI/ "]) {
      const r = loadWebConfig({ ...base, WEB_PUBLIC_ORIGIN: value });
      expect(r.status).toBe("ok");
      if (r.status === "ok") expect(r.config.publicOrigin).toBe(PUBLIC);
    }
  });

  test("ungültig: kein Start, Grund nennt die Einstellung", () => {
    const bad = [
      "http://app.tybo.ai",
      "app.tybo.ai",
      "https://app.tybo.ai:8443",
      "https://app.tybo.ai/pfad",
      "https://app.tybo.ai?x=1",
      "https://user:pw@app.tybo.ai",
      "https://localhost",
      "https://127.0.0.1",
      "https://app..tybo.ai",
      "https://",
      "ftp://app.tybo.ai",
    ];
    for (const WEB_PUBLIC_ORIGIN of bad) {
      const r = loadWebConfig({ ...base, WEB_PUBLIC_ORIGIN });
      expect(r.status).toBe("invalid");
      if (r.status === "invalid") expect(r.reason).toContain("WEB_PUBLIC_ORIGIN");
      expect(parsePublicOrigin(WEB_PUBLIC_ORIGIN)).toBeNull();
    }
  });
});
