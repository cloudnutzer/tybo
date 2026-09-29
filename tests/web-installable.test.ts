/**
 * Installierbare Web-App (Issue #224): Manifest aus BRAND, Symbole aus
 * scripts/web-icons.ts, Metas in index.html und login.html, CSP und die
 * öffentlichen Pfade. Vor dem WebUI-Login erreichbar, über den Tunnel nur mit
 * gültigem Access-Nachweis (kein Bypass). Nur lokale Testserver, Access-
 * Schlüssel als Attrappe.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BRAND } from "../src/brand";
import { MANIFEST_CONTENT_TYPE, MANIFEST_ICONS, webManifest } from "../src/web/manifest";
import { ACCESS_DENIED_TEXT, createWebServer, SECURITY_HEADERS, type WebServer } from "../src/web/server";
import { ICON_FILES, maskableScale, MASKABLE_SAFE_DIAMETER, renderIcon } from "../scripts/web-icons";
import { ACCESS, FakeCerts, validJwt } from "./access-fixture";

const PASSWORD = "test-passwort-lang";
const PUBLIC = "https://app.example.org";
const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const root = await mkdtemp(join(tmpdir(), "tybo-installable-"));
const servers: WebServer[] = [];
let counter = 0;

afterAll(async () => {
  for (const s of servers.splice(0)) await s.stop();
  await rm(root, { recursive: true, force: true });
});

async function start(tunnel = false): Promise<string> {
  const dir = join(root, `case-${++counter}`);
  const server = await createWebServer(
    {
      host: "127.0.0.1",
      port: 0,
      password: PASSWORD,
      allowedHosts: [],
      ...(tunnel ? { publicOrigin: PUBLIC, access: ACCESS } : {}),
    },
    { sessionFile: join(dir, "sessions.json"), dataDir: join(dir, "web"), accessCerts: new FakeCerts().fetch, log: () => {} }
  );
  servers.push(server);
  return server.url;
}

function tunnelHeaders(jwt: string | null): Record<string, string> {
  const headers: Record<string, string> = { host: new URL(PUBLIC).host, origin: PUBLIC, "cf-connecting-ip": "203.0.113.7" };
  if (jwt !== null) headers["cf-access-jwt-assertion"] = jwt;
  return headers;
}

/** Breite und Höhe aus dem IHDR-Block eines PNG */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe("IHDR");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Pfade dieses Issues, die ohne WebUI-Sitzung erreichbar sind */
const INSTALL_PATHS = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];

describe("Manifest", () => {
  test("Felder aus BRAND, Standalone, Symbole 192/512/maskable und favicon.svg", () => {
    const m = webManifest();
    expect(m.name).toBe(BRAND.name);
    expect(m.short_name).toBe(BRAND.name);
    expect(m).toMatchObject({ id: "/", start_url: "/", scope: "/", display: "standalone", lang: "de", background_color: "#ffffff", theme_color: "#ffffff" });
    expect(m.icons).toEqual([
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ]);
    // Name kommt aus der Übergabe, keine feste Zeichenkette
    expect(webManifest({ name: "Beispiel" })).toMatchObject({ name: "Beispiel", short_name: "Beispiel" });
  });

  test("GET /manifest.webmanifest liefert application/manifest+json ohne Sitzung", async () => {
    const url = await start();
    const res = await fetch(`${url}/manifest.webmanifest`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(MANIFEST_CONTENT_TYPE);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(webManifest())));
    // Nichts über den Nutzer, kein Gespräch, kein Agent
    expect(Object.keys(webManifest()).sort()).toEqual(
      ["background_color", "display", "icons", "id", "lang", "name", "scope", "share_target", "short_name", "start_url", "theme_color"]
    );
    const head = await fetch(`${url}/manifest.webmanifest`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await fetch(`${url}/manifest.webmanifest`, { method: "POST", headers: { origin: url } })).status).not.toBe(200);
  });
});

describe("Symbole", () => {
  test("Dateien im Repo haben die richtige Größe und sind die frische Berechnung", async () => {
    expect(ICON_FILES.map(f => f.name)).toEqual(MANIFEST_ICONS.filter(i => i.type === "image/png").map(i => i.src.slice(1)));
    for (const file of ICON_FILES) {
      const bytes = new Uint8Array(await readFile(join(publicDir, file.name)));
      expect({ name: file.name, ...pngSize(bytes) }).toEqual({ name: file.name, width: file.size, height: file.size });
      // Reproduzierbar: scripts/web-icons.ts ergibt genau diese Bytes
      expect(Buffer.from(bytes).equals(renderIcon(file))).toBe(true);
    }
  });

  test("maskierbar: Zeichen liegt in der sicheren Zone (80 %)", () => {
    const s = maskableScale();
    expect(s).toBeLessThan(1);
    // äußerster Punkt ist der Rand des orangen Punkts: Abstand zur Mitte plus Radius
    const far = (Math.hypot(23.5 - 16, 8.5 - 16) + 3.6) * s;
    expect(far).toBeCloseTo(MASKABLE_SAFE_DIAMETER * 16, 6);
  });

  test("Symbole ohne Sitzung erreichbar, als image/png", async () => {
    const url = await start();
    for (const file of ICON_FILES) {
      const res = await fetch(`${url}/${file.name}`, { redirect: "manual" });
      expect({ path: file.name, status: res.status }).toEqual({ path: file.name, status: 200 });
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(pngSize(new Uint8Array(await res.arrayBuffer())).width).toBe(file.size);
    }
  });
});

describe("Kopf der Seiten", () => {
  test("index.html und login.html verlinken das Manifest mit Anmeldedaten und tragen die App-Metas", async () => {
    const url = await start();
    const login = await (await fetch(`${url}/login`)).text();
    const cookie = (await fetch(`${url}/api/login`, { method: "POST", headers: { origin: url }, body: JSON.stringify({ password: PASSWORD }) }))
      .headers.get("set-cookie")!.split(";")[0];
    const index = await (await fetch(`${url}/`, { headers: { cookie } })).text();
    for (const html of [login, index]) {
      expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">');
      expect(html).toContain('<meta name="mobile-web-app-capable" content="yes">');
      expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
      expect(html).toContain(`<meta name="apple-mobile-web-app-title" content="${BRAND.name}">`);
      expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default">');
      expect(html).not.toContain("{{brand.");
    }
  });
});

describe("CSP", () => {
  test("worker-src und manifest-src ausdrücklich 'self', script-src unverändert", async () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"]!;
    const directives = new Map(csp.split(";").map(d => d.trim()).filter(Boolean).map(d => {
      const [name, ...values] = d.split(/\s+/);
      return [name, values.join(" ")] as const;
    }));
    expect(directives.get("worker-src")).toBe("'self'");
    expect(directives.get("manifest-src")).toBe("'self'");
    expect(directives.get("script-src")).toBe("'self'");
    expect(directives.get("default-src")).toBe("'self'");
    const url = await start();
    expect((await fetch(`${url}/manifest.webmanifest`)).headers.get("content-security-policy")).toBe(csp);
  });
});

describe("Tunnel", () => {
  test("ohne gültigen Access-Nachweis 403, mit Nachweis erreichbar (kein Bypass)", async () => {
    const url = await start(true);
    for (const path of INSTALL_PATHS) {
      for (const jwt of [null, "", "kein.jwt"]) {
        const res = await fetch(`${url}${path}`, { headers: tunnelHeaders(jwt), redirect: "manual" });
        expect({ path, jwt, status: res.status }).toEqual({ path, jwt, status: 403 });
        expect(await res.text()).toBe(ACCESS_DENIED_TEXT);
      }
      const ok = await fetch(`${url}${path}`, { headers: tunnelHeaders(validJwt()), redirect: "manual" });
      expect({ path, status: ok.status }).toEqual({ path, status: 200 });
      await ok.arrayBuffer();
    }
  });
});
