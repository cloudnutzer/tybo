/**
 * Issue #111, Schritt 1: Oberflächen-Version. Gleiche Dateien ergeben
 * dieselbe Version (auch nach einem Neustart), jede Änderung an Inhalt,
 * Namen, Bestand oder Markenangaben eine neue. Die Seite bekommt die Version
 * im ausgelieferten index.html, /api/version nennt die des Servers, nur nach
 * Anmeldung und über den Tunnel nur mit Access-Nachweis.
 * Nur lokale Testserver auf temporären Ordnern.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/brand";
import { renderBrandHtml } from "../src/web/brand-asset";
import { createWebServer, DEFAULT_PUBLIC_DIR, type WebServer } from "../src/web/server";
import { computeUiVersion, isUiVersion, UI_VERSION_PATH } from "../src/web/ui-version";
import { ACCESS, FakeCerts, validJwt } from "./access-fixture";

const PASSWORD = "test-passwort-lang";
const PUBLIC = "https://app.tybo.ai";
const root = await mkdtemp(join(tmpdir(), "tybo-ui-version-"));
let counter = 0;
const servers: WebServer[] = [];

afterAll(async () => {
  for (const s of servers.splice(0)) await s.stop();
  await rm(root, { recursive: true, force: true });
});

/** Kleines publicDir mit index.html, Skript und Unterordner */
async function makePublic(): Promise<string> {
  const dir = join(root, `public-${++counter}`);
  await mkdir(join(dir, "icons"), { recursive: true });
  await writeFile(join(dir, "index.html"), '<meta id="ui-version" content="{{ui.version}}"><title>{{brand.name}}</title>');
  await writeFile(join(dir, "app.js"), "console.log('a');\n");
  await writeFile(join(dir, "icons", "a.svg"), "<svg/>");
  return dir;
}

describe("computeUiVersion", () => {
  test("gleiche Dateien, gleiche Version; auch in einem anderen Ordner (keine absoluten Pfade)", async () => {
    const a = await makePublic();
    const b = await makePublic();
    const va = await computeUiVersion(a);
    expect(isUiVersion(va)).toBe(true);
    expect(await computeUiVersion(a)).toBe(va);
    expect(await computeUiVersion(b)).toBe(va);
  });

  test("Zeitstempel zählen nicht: neu geschriebener gleicher Inhalt ändert nichts", async () => {
    const dir = await makePublic();
    const before = await computeUiVersion(dir);
    await Bun.sleep(15);
    await writeFile(join(dir, "app.js"), "console.log('a');\n");
    expect(await computeUiVersion(dir)).toBe(before);
  });

  test("geänderte, neue, gelöschte und umbenannte Datei: jeweils neue Version", async () => {
    const dir = await makePublic();
    const seen = new Set([await computeUiVersion(dir)]);
    await writeFile(join(dir, "app.js"), "console.log('b');\n");
    seen.add(await computeUiVersion(dir));
    await writeFile(join(dir, "icons", "b.svg"), "<svg/>");
    seen.add(await computeUiVersion(dir));
    await rm(join(dir, "icons", "a.svg"));
    seen.add(await computeUiVersion(dir));
    await rm(join(dir, "icons", "b.svg"));
    await writeFile(join(dir, "icons", "c.svg"), "<svg/>");
    seen.add(await computeUiVersion(dir));
    expect(seen.size).toBe(5);
  });

  test("Grenzen zwischen Pfad und Inhalt sind eindeutig", async () => {
    const a = join(root, `grenze-a-${++counter}`);
    const b = join(root, `grenze-b-${counter}`);
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, "x"), "yz");
    await writeFile(join(b, "xy"), "z");
    expect(await computeUiVersion(a)).not.toBe(await computeUiVersion(b));
  });

  test("Markenangaben gehören dazu (HTML-Platzhalter und /brand.js)", async () => {
    const dir = await makePublic();
    const normal = await computeUiVersion(dir);
    expect(await computeUiVersion(dir, { brand: { ...BRAND } })).toBe(normal);
    expect(await computeUiVersion(dir, { brand: { ...BRAND, name: "anders" } })).not.toBe(normal);
    expect(await computeUiVersion(dir, { brand: { ...BRAND, domain: "anders.example" } })).not.toBe(normal);
  });

  test("versteckte Dateien und symbolische Links bleiben draußen, auch Ziele außerhalb", async () => {
    const dir = await makePublic();
    const before = await computeUiVersion(dir);
    const outside = join(root, `aussen-${++counter}.txt`);
    await writeFile(outside, "geheim");
    await symlink(outside, join(dir, "link.txt"));
    await writeFile(join(dir, ".DS_Store"), "x");
    expect(await computeUiVersion(dir)).toBe(before);
    await writeFile(outside, "anders");
    expect(await computeUiVersion(dir)).toBe(before);
  });

  test("die echte Oberfläche hat eine Version", async () => {
    expect(isUiVersion(await computeUiVersion(DEFAULT_PUBLIC_DIR))).toBe(true);
  });
});

describe("renderBrandHtml mit Version", () => {
  test("setzt die Version ein, ohne Version leer", () => {
    expect(renderBrandHtml('<meta content="{{ui.version}}">', "0123456789abcdef")).toBe('<meta content="0123456789abcdef">');
    expect(renderBrandHtml('<meta content="{{ui.version}}">')).toBe('<meta content="">');
  });
});

interface Started {
  url: string;
  server: WebServer;
}

async function start(publicDir: string, options: { tunnel?: boolean; sessionFile?: string } = {}): Promise<Started> {
  const dir = join(root, `server-${++counter}`);
  const server = await createWebServer(
    {
      host: "127.0.0.1",
      port: 0,
      password: PASSWORD,
      allowedHosts: [],
      publicOrigin: options.tunnel ? PUBLIC : null,
      access: options.tunnel ? ACCESS : null,
    },
    {
      publicDir,
      sessionFile: options.sessionFile ?? join(dir, "sessions.json"),
      dataDir: join(dir, "web"),
      keepaliveMs: 60_000,
      accessCerts: new FakeCerts().fetch,
      log: () => {},
    }
  );
  servers.push(server);
  return { url: `http://127.0.0.1:${new URL(server.url).port}`, server };
}

async function login(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: url, ...headers },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

async function versionOf(url: string, cookie: string, headers: Record<string, string> = {}): Promise<string | null> {
  const res = await fetch(`${url}${UI_VERSION_PATH}`, { headers: { cookie, ...headers } });
  expect(res.status).toBe(200);
  return (await res.json()).version;
}

async function pageVersion(url: string, cookie: string): Promise<string | null> {
  const html = await (await fetch(`${url}/`, { headers: { cookie } })).text();
  return /id="ui-version" content="([^"]*)"/.exec(html)?.[1] ?? null;
}

describe("Auslieferung", () => {
  test("index.html trägt dieselbe Version wie /api/version, nur die Prüfsumme", async () => {
    const dir = await makePublic();
    const { url } = await start(dir);
    const cookie = await login(url);
    const res = await fetch(`${url}${UI_VERSION_PATH}`, { headers: { cookie } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["version"]);
    expect(body.version).toBe(await computeUiVersion(dir));
    expect(await pageVersion(url, cookie)).toBe(body.version);
  });

  test("Neustart ohne Änderung: gleiche Version; geänderte Datei: neue Version erst nach dem Neustart", async () => {
    const dir = await makePublic();
    const sessionFile = join(root, `sessions-${++counter}.json`);
    const first = await start(dir, { sessionFile });
    const cookie = await login(first.url);
    const loaded = await pageVersion(first.url, cookie);
    await first.server.stop();

    const second = await start(dir, { sessionFile });
    expect(await versionOf(second.url, cookie)).toBe(loaded);

    // Übernahme vor dem Neustart: der laufende Server bleibt bei seiner Version
    await writeFile(join(dir, "app.js"), "console.log('neu');\n");
    expect(await versionOf(second.url, cookie)).toBe(loaded);
    expect(await pageVersion(second.url, cookie)).toBe(loaded);
    await second.server.stop();

    const third = await start(dir, { sessionFile });
    const next = await versionOf(third.url, cookie);
    expect(next).not.toBe(loaded);
    expect(isUiVersion(next)).toBe(true);
  });

  test("echte Oberfläche: Meta-Tag in index.html", async () => {
    const { url } = await start(DEFAULT_PUBLIC_DIR);
    const cookie = await login(url);
    expect(isUiVersion(await pageVersion(url, cookie))).toBe(true);
    // Die Anmeldeseite braucht keine Version und zeigt keinen Platzhalter
    const loginHtml = await (await fetch(`${url}/login`)).text();
    expect(loginHtml).not.toContain("{{");
  });

  test("ohne lesbares publicDir: keine Version statt Absturz", async () => {
    const { url } = await start(join(root, "gibt-es-nicht"));
    const cookie = await login(url);
    expect(await versionOf(url, cookie)).toBeNull();
  });
});

describe("Zugriff auf /api/version", () => {
  test("ohne Anmeldung 401, mit ungültigem Cookie 401, nur GET", async () => {
    const { url } = await start(await makePublic());
    expect((await fetch(`${url}${UI_VERSION_PATH}`)).status).toBe(401);
    expect((await fetch(`${url}${UI_VERSION_PATH}`, { headers: { cookie: "tybo_web=falsch" } })).status).toBe(401);
    const cookie = await login(url);
    const post = await fetch(`${url}${UI_VERSION_PATH}`, { method: "POST", headers: { cookie, origin: url } });
    expect(post.status).toBe(405);
  });

  test("über den Tunnel: ohne Access-Nachweis 403, mit Nachweis ohne Cookie 401, mit beidem 200", async () => {
    const { url } = await start(await makePublic(), { tunnel: true });
    const tunnel = (jwt: string | null) => {
      const h: Record<string, string> = { host: "app.tybo.ai", origin: PUBLIC, "cf-connecting-ip": "203.0.113.7" };
      if (jwt !== null) h["cf-access-jwt-assertion"] = jwt;
      return h;
    };
    const cookie = await login(url, tunnel(validJwt()));
    const without = await fetch(`${url}${UI_VERSION_PATH}`, { headers: { ...tunnel(null), cookie } });
    expect(without.status).toBe(403);
    expect(JSON.stringify(await without.json())).not.toMatch(/[0-9a-f]{16}/);
    expect((await fetch(`${url}${UI_VERSION_PATH}`, { headers: tunnel(validJwt()) })).status).toBe(401);
    const ok = await fetch(`${url}${UI_VERSION_PATH}`, { headers: { ...tunnel(validJwt()), cookie } });
    expect(ok.status).toBe(200);
    expect(isUiVersion((await ok.json()).version)).toBe(true);
  });
});
