import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebServer, type WebServer } from "../src/web/server";

const PASSWORD = "test-passwort-lang";
const SECRET_MARKER = "GEHEIM-AUSSERHALB-PUBLIC";

const dir = await mkdtemp(join(tmpdir(), "tybo-web-server-"));
const publicDir = join(dir, "public");
await mkdir(join(publicDir, "sub"), { recursive: true });
await writeFile(join(publicDir, "index.html"), "<p>angemeldet</p>");
await writeFile(join(publicDir, "login.html"), "<p>login-seite</p>");
await writeFile(join(publicDir, "login.js"), "// login");
await writeFile(join(publicDir, "style.css"), "body{}");
await writeFile(join(publicDir, "app.js"), "// app");
await writeFile(join(publicDir, ".hidden"), SECRET_MARKER);
await writeFile(join(dir, "package.json"), SECRET_MARKER);
await symlink(join(dir, "package.json"), join(publicDir, "link.json"));

let now = 1_800_000_000_000;
const logs: string[] = [];
let server: WebServer;
let origin: string;

async function start(sessionFile: string): Promise<WebServer> {
  return createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    { sessionFile, publicDir, dataDir: join(dir, "data", "web"), now: () => now, log: m => logs.push(m) }
  );
}

beforeAll(async () => {
  server = await start(join(dir, "data", "web-sessions.json"));
  origin = server.url;
});
afterAll(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

function login(password: string, extra: RequestInit = {}) {
  return fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
    redirect: "manual",
    ...extra,
  });
}

async function loginCookie(): Promise<string> {
  const res = await login(PASSWORD);
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

/**
 * Rohe HTTP-Anfrage, damit der Pfad nicht von fetch normalisiert wird (wie curl --path-as-is).
 * Bun schließt die Verbindung trotz "Connection: close" nicht immer, deshalb endet
 * das Lesen, sobald Kopf und Body (laut Content-Length) da sind.
 */
function rawRequest(path: string, host: string, cookie = ""): Promise<string> {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n${cookie ? `Cookie: ${cookie}\r\n` : ""}Connection: close\r\n\r\n`);
    });
    let data = "";
    const done = () => { socket.destroy(); resolve(data); };
    socket.on("data", d => {
      data += d.toString();
      const end = data.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/content-length: *(\d+)/i.exec(data.slice(0, end))?.[1] ?? 0);
      if (Buffer.byteLength(data.slice(end + 4)) >= length) done();
    });
    socket.on("end", done);
    socket.on("error", reject);
  });
}

function expectSecurityHeaders(res: Response) {
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toContain("unsafe-inline");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
}

function expectApiHeaders(res: Response) {
  expectSecurityHeaders(res);
  expect(res.headers.get("cache-control")).toBe("no-store");
}

/** Body als Stream: fetch sendet ihn chunked, also ohne Content-Length. */
function chunkedBody(bytes: number): ReadableStream<Uint8Array> {
  const chunk = 16 * 1024;
  let left = bytes;
  return new ReadableStream({
    pull(c) {
      if (left <= 0) return c.close();
      const n = Math.min(chunk, left);
      left -= n;
      c.enqueue(new Uint8Array(n).fill(120));
    },
  });
}

describe("Anmeldung", () => {
  test("/api/me ohne Cookie 401, mit Sicherheits-Kopfzeilen und no-store", async () => {
    const res = await fetch(`${origin}/api/me`);
    expect(res.status).toBe(401);
    expectSecurityHeaders(res);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("falsches Passwort 401", async () => {
    const res = await login("falsches-passwort-xyz");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expectSecurityHeaders(res);
  });

  test("richtiges Passwort setzt Cookie mit allen Attributen, danach /api/me 200", async () => {
    const res = await login(PASSWORD);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^tybo_web=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    const cookie = setCookie.split(";")[0];
    const me = await fetch(`${origin}/api/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ authenticated: true });
    expect(me.headers.get("cache-control")).toBe("no-store");
    expectSecurityHeaders(me);
  });

  test("Login ohne oder mit fremdem Origin 403", async () => {
    for (const o of [undefined, "null", "http://evil.example"]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (o) headers.origin = o;
      const res = await fetch(`${origin}/api/login`, {
        method: "POST", headers, body: JSON.stringify({ password: PASSWORD }),
      });
      expect(res.status).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
      expectSecurityHeaders(res);
    }
  });

  test("kaputter Body 400", async () => {
    const res = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin }, body: "{kein json" });
    expect(res.status).toBe(400);
    const res2 = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin }, body: '{"password":5}' });
    expect(res2.status).toBe(400);
  });

  test("Body über 64 KiB 413, auch ohne Content-Length", async () => {
    const big = JSON.stringify({ password: "x".repeat(70_000) });
    const res = await login("", { body: big });
    expect(res.status).toBe(413);
    expectSecurityHeaders(res);
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode("x".repeat(10_000)));
        c.close();
      },
    });
    const chunked = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin }, body: stream });
    expect(chunked.status).toBe(413);
  });

  test("Abmelden mit übergroßem Body 413, Session bleibt gültig; Grenze 65536/65537 Byte", async () => {
    const cookie = await loginCookie();
    for (const makeBody of [chunkedBody, (n: number) => "x".repeat(n)]) {
      const res = await fetch(`${origin}/api/logout`, {
        method: "POST", headers: { cookie, origin }, body: makeBody(65_537),
      });
      expect(res.status).toBe(413);
      expect(res.headers.get("set-cookie")).toBeNull();
      expectApiHeaders(res);
      expect((await fetch(`${origin}/api/me`, { headers: { cookie } })).status).toBe(200);
    }
    for (const makeBody of [chunkedBody, (n: number) => "x".repeat(n)]) {
      const fresh = await loginCookie();
      const res = await fetch(`${origin}/api/logout`, {
        method: "POST", headers: { cookie: fresh, origin }, body: makeBody(65_536),
      });
      expect(res.status).toBe(200);
      expect((await fetch(`${origin}/api/me`, { headers: { cookie: fresh } })).status).toBe(401);
    }
  });

  test("Body über 1 MiB 413 mit allen Kopfzeilen, mit und ohne Content-Length", async () => {
    const cookie = await loginCookie();
    const size = 2 * 1024 * 1024;
    for (const makeBody of [chunkedBody, (n: number) => "x".repeat(n)]) {
      for (const path of ["/api/logout", "/api/login"]) {
        const res = await fetch(`${origin}${path}`, {
          method: "POST", headers: { cookie, origin }, body: makeBody(size),
        });
        expect(res.status).toBe(413);
        expectApiHeaders(res);
      }
    }
    expect((await fetch(`${origin}/api/me`, { headers: { cookie } })).status).toBe(200);
  });

  test("Abmelden mit fremdem Origin 403, mit eigenem wirkt dauerhaft", async () => {
    const cookie = await loginCookie();
    const foreign = await fetch(`${origin}/api/logout`, {
      method: "POST", headers: { cookie, origin: "http://evil.example" },
    });
    expect(foreign.status).toBe(403);
    expectSecurityHeaders(foreign);
    const noOrigin = await fetch(`${origin}/api/logout`, { method: "POST", headers: { cookie } });
    expect(noOrigin.status).toBe(403);
    expect((await fetch(`${origin}/api/me`, { headers: { cookie } })).status).toBe(200);

    const out = await fetch(`${origin}/api/logout`, { method: "POST", headers: { cookie, origin } });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await fetch(`${origin}/api/me`, { headers: { cookie } })).status).toBe(401);

    // nach Neustart bleibt die Abmeldung bestehen
    const restarted = await start(join(dir, "data", "web-sessions.json"));
    try {
      expect((await fetch(`${restarted.url}/api/me`, { headers: { cookie } })).status).toBe(401);
    } finally {
      await restarted.stop();
    }
  });
});

describe("Sessions über Neustarts", () => {
  test("gespeicherte Session gilt nach Neustart, Datei 0600 nur mit Hashes, Ablauf nach 30 Tagen", async () => {
    const file = join(dir, "restart", "web-sessions.json");
    const first = await start(file);
    const res = await fetch(`${first.url}/api/login`, {
      method: "POST", headers: { origin: first.url }, body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    const token = cookie.split("=")[1];
    await first.stop();

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(PASSWORD);

    const second = await start(file);
    try {
      expect((await fetch(`${second.url}/api/me`, { headers: { cookie } })).status).toBe(200);
      const saved = now;
      now += 30 * 24 * 60 * 60 * 1000;
      try {
        expect((await fetch(`${second.url}/api/me`, { headers: { cookie } })).status).toBe(401);
      } finally {
        now = saved;
      }
    } finally {
      await second.stop();
    }
  });
});

describe("Login-Bremse", () => {
  test("11. Fehlversuch 429, auch mit richtigem Passwort; nach 15 Minuten wieder frei", async () => {
    const file = join(dir, "limit", "web-sessions.json");
    const s = await start(file);
    const attempt = (password: string) =>
      fetch(`${s.url}/api/login`, { method: "POST", headers: { origin: s.url }, body: JSON.stringify({ password }) });
    try {
      for (let i = 0; i < 10; i++) expect((await attempt(`falsch-${i}-xxxxxxxx`)).status).toBe(401);
      const blocked = await attempt("falsch-11-xxxxxxx");
      expect(blocked.status).toBe(429);
      expectSecurityHeaders(blocked);
      expect((await attempt(PASSWORD)).status).toBe(429);
      now += 15 * 60 * 1000;
      expect((await attempt(PASSWORD)).status).toBe(200);
    } finally {
      await s.stop();
    }
  });
});

describe("Host und Seiten", () => {
  test("fremder Host 421, mit Sicherheits-Kopfzeilen", async () => {
    const { port } = new URL(origin);
    for (const host of ["evil.example", `evil.example:${port}`, "localhost:1"]) {
      const raw = await rawRequest("/api/me", host);
      expect(raw).toMatch(/^HTTP\/1\.1 421/);
      expect(raw.toLowerCase()).toContain("content-security-policy: default-src 'self'");
    }
  });

  test("localhost mit richtigem Port ist erlaubt", async () => {
    const { port } = new URL(origin);
    const res = await fetch(`http://localhost:${port}/api/me`);
    expect(res.status).toBe(401);
  });

  test("Seiten ohne Session leiten auf /login um, Login-Seite und Assets sind öffentlich", async () => {
    const res = await fetch(`${origin}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expectSecurityHeaders(res);
    expect((await fetch(`${origin}/app.js`, { redirect: "manual" })).status).toBe(302);

    const page = await fetch(`${origin}/login`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("login-seite");
    expectSecurityHeaders(page);
    expect((await fetch(`${origin}/login.js`)).status).toBe(200);
    expect((await fetch(`${origin}/style.css`)).headers.get("content-type")).toContain("text/css");
  });

  test("mit Session: / liefert index.html, /login leitet auf / um", async () => {
    const cookie = await loginCookie();
    const res = await fetch(`${origin}/`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("angemeldet");
    const loginPage = await fetch(`${origin}/login`, { headers: { cookie }, redirect: "manual" });
    expect(loginPage.status).toBe(302);
    expect(loginPage.headers.get("location")).toBe("/");
    expect((await fetch(`${origin}/app.js`, { headers: { cookie } })).status).toBe(200);
  });

  test("kein Pfad-Traversal, auch nicht roh oder kodiert und mit gültiger Session", async () => {
    const cookie = await loginCookie();
    for (const path of [
      "/../package.json",
      "/sub/../../package.json",
      "/%2e%2e/package.json",
      "/%2E%2E/package.json",
      "/..%2fpackage.json",
      "/%2e%2e%2fpackage.json",
      "/..%5cpackage.json",
      "/%252e%252e/package.json",
      "/.hidden",
      "/%2ehidden",
      "/link.json",
      "//etc/passwd",
      "/%00index.html",
    ]) {
      const { host } = new URL(origin);
      const raw = await rawRequest(path, host, cookie);
      expect(raw).not.toContain(SECRET_MARKER);
      expect(raw).not.toMatch(/^HTTP\/1\.1 200/);
    }
  });

  test("unbekannte API 404, falsche Methode 405", async () => {
    const cookie = await loginCookie();
    expect((await fetch(`${origin}/api/gibtsnicht`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${origin}/api/login`)).status).toBe(405);
    expect((await fetch(`${origin}/api/me`, { method: "POST", headers: { cookie, origin } })).status).toBe(405);
  });

  test("kein Passwort und kein Token im Log", () => {
    const all = logs.join("\n");
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });
});
