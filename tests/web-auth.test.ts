import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LoginLimiter,
  SESSION_TTL_MS,
  SessionStore,
  hashToken,
  isAllowedHost,
  isSameOrigin,
  passwordMatches,
} from "../src/web/auth";

const dir = await mkdtemp(join(tmpdir(), "tybo-web-auth-"));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("passwordMatches", () => {
  test("vergleicht exakt, auch bei unterschiedlicher Länge", () => {
    expect(passwordMatches("richtig-langes-pw", "richtig-langes-pw")).toBe(true);
    expect(passwordMatches("richtig-langes-p", "richtig-langes-pw")).toBe(false);
    expect(passwordMatches("richtig-langes-pw-x", "richtig-langes-pw")).toBe(false);
    expect(passwordMatches("", "richtig-langes-pw")).toBe(false);
    expect(passwordMatches(undefined, "richtig-langes-pw")).toBe(false);
    expect(passwordMatches(123, "richtig-langes-pw")).toBe(false);
    expect(passwordMatches("", "")).toBe(false);
  });
});

describe("SessionStore", () => {
  test("Token ist 32 Byte zufällig, auf der Platte liegt nur der Hash, Datei 0600", async () => {
    const file = join(dir, "a", "web-sessions.json");
    const store = new SessionStore({ file });
    const token = await store.create();
    expect(Buffer.from(token, "base64url").length).toBe(32);
    expect(await store.create()).not.toBe(token);
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).toContain(hashToken(token));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(store.isValid(token)).toBe(true);
    expect(store.isValid("x".repeat(43))).toBe(false);
    expect(store.isValid(hashToken(token))).toBe(false);
    expect(store.isValid(null)).toBe(false);
  });

  test("gespeicherte Session gilt nach dem Neuladen noch", async () => {
    const file = join(dir, "b.json");
    const token = await new SessionStore({ file }).create();
    const reloaded = new SessionStore({ file });
    await reloaded.load();
    expect(reloaded.isValid(token)).toBe(true);
  });

  test("Session läuft nach 30 Tagen ab, auch nach dem Neuladen", async () => {
    const file = join(dir, "c.json");
    let now = 1_000_000;
    const store = new SessionStore({ file, now: () => now });
    const token = await store.create();
    now += SESSION_TTL_MS - 1;
    expect(store.isValid(token)).toBe(true);
    const reloaded = new SessionStore({ file, now: () => now });
    await reloaded.load();
    expect(reloaded.isValid(token)).toBe(true);
    now += 1;
    expect(store.isValid(token)).toBe(false);
    await reloaded.load();
    expect(reloaded.isValid(token)).toBe(false);
  });

  test("Abmelden wirkt im Speicher und in der Datei", async () => {
    const file = join(dir, "d.json");
    const store = new SessionStore({ file });
    const keep = await store.create();
    const gone = await store.create();
    await store.revoke(gone);
    expect(store.isValid(gone)).toBe(false);
    const reloaded = new SessionStore({ file });
    await reloaded.load();
    expect(reloaded.isValid(gone)).toBe(false);
    expect(reloaded.isValid(keep)).toBe(true);
    expect(await readFile(file, "utf8")).not.toContain(hashToken(gone));
  });

  test("parallele Schreibvorgänge verlieren keine Session", async () => {
    const file = join(dir, "e.json");
    const store = new SessionStore({ file });
    const tokens = await Promise.all(Array.from({ length: 20 }, () => store.create()));
    const reloaded = new SessionStore({ file });
    await reloaded.load();
    expect(tokens.every(t => reloaded.isValid(t))).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("kaputte oder fehlende Datei ermöglicht keine Anmeldung", async () => {
    const missing = new SessionStore({ file: join(dir, "fehlt.json") });
    await missing.load();
    expect(missing.size).toBe(0);

    const file = join(dir, "kaputt.json");
    const token = "A".repeat(43);
    for (const content of [
      "{nicht json",
      "null",
      JSON.stringify({ sessions: "x" }),
      JSON.stringify({ sessions: [{ hash: token, expires: Date.now() + 1e9 }] }),
      JSON.stringify({ sessions: [{ hash: hashToken(token), expires: "morgen" }] }),
      JSON.stringify({ sessions: [{ hash: hashToken(token), expires: Date.now() - 1 }] }),
    ]) {
      await writeFile(file, content);
      const store = new SessionStore({ file });
      await store.load();
      expect(store.isValid(token)).toBe(false);
    }
  });
});

describe("LoginLimiter", () => {
  test("nach 10 Fehlversuchen gesperrt, nach 15 Minuten wieder frei, pro IP", () => {
    let now = 0;
    const limiter = new LoginLimiter({ now: () => now });
    for (let i = 0; i < 10; i++) {
      expect(limiter.isBlocked("10.0.0.1")).toBe(false);
      limiter.recordFailure("10.0.0.1");
      now += 1000;
    }
    expect(limiter.isBlocked("10.0.0.1")).toBe(true);
    expect(limiter.isBlocked("10.0.0.2")).toBe(false);
    // erster Fehlversuch bei t=0 fällt bei t=15min aus dem Fenster
    now = 15 * 60 * 1000;
    expect(limiter.isBlocked("10.0.0.1")).toBe(false);
    limiter.recordFailure("10.0.0.1");
    expect(limiter.isBlocked("10.0.0.1")).toBe(true);
  });
});

describe("isAllowedHost", () => {
  const config = { port: 3100, allowedHosts: ["mac.local", "[fd00::5]"] };
  const ifaces = ["192.168.1.20", "fe80::1"];

  test("erlaubt lokale Namen, eigene IPs und Einträge, jeweils mit Port", () => {
    for (const host of [
      "localhost:3100", "LOCALHOST:3100", "127.0.0.1:3100", "[::1]:3100",
      "192.168.1.20:3100", "[fe80::1]:3100", "mac.local:3100", "Mac.Local:3100", "[fd00::5]:3100",
    ]) expect(isAllowedHost(host, config, ifaces)).toBe(true);
  });

  test("lehnt fremde Namen, falsche Ports und Unsinn ab", () => {
    for (const host of [
      null, "", "evil.example:3100", "localhost", "localhost:80", "localhost:3101",
      "127.0.0.1:3100.evil", "localhost.:3100", "192.168.1.21:3100", "mac.local.evil.example:3100",
      "localhost:3100@evil", "user@localhost:3100", "[::1:3100",
    ]) expect(isAllowedHost(host, config, ifaces)).toBe(false);
  });

  test("ohne Port nur, wenn der Server auf Port 80 läuft", () => {
    expect(isAllowedHost("localhost", { port: 80, allowedHosts: [] }, [])).toBe(true);
  });
});

describe("isSameOrigin", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://localhost:3100/api/logout", { method: "POST", headers });

  test("gleicher Origin passt", () => {
    expect(isSameOrigin(req({ host: "localhost:3100", origin: "http://localhost:3100" }))).toBe(true);
    expect(isSameOrigin(req({ host: "192.168.1.20:3100", origin: "http://192.168.1.20:3100" }))).toBe(true);
  });

  test("fremder, fehlender oder null-Origin wird abgelehnt", () => {
    for (const origin of [
      undefined, "null", "http://evil.example", "http://localhost:3101", "https://localhost:3100",
      "http://127.0.0.1:3100", "http://localhost:3100/", "kein-url",
    ]) {
      const headers: Record<string, string> = { host: "localhost:3100" };
      if (origin !== undefined) headers.origin = origin;
      expect(isSameOrigin(req(headers))).toBe(false);
    }
  });
});
