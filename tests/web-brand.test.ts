/**
 * Issue #100, Schritt 2: Name aus src/brand.ts in den Browser-Seiten ohne
 * Build-Schritt. /brand.js und die HTML-Seiten mit ersetzten Platzhaltern,
 * vom Web-Server der WebUI und vom Einrichtungs-Server, jeweils auch ohne
 * Anmeldung dort, wo Login und Code-Seite sie brauchen. CSP bleibt.
 * Speicher-Schlüssel und Cookies behalten ihre alten Namen (Bestandsschutz).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BRAND } from "../src/brand";
import { brandScript, renderBrandHtml } from "../src/web/brand-asset";
import { createWebServer, SECURITY_HEADERS, type WebServer } from "../src/web/server";
import { cleanup } from "./setup-fixture";
import { get, startSetup, type Started } from "./setup-web-fixture";
import { OLD_CLI, OLD_NAME } from "./old-names";

/** Frühere Namen, die in Oberfläche und Browser-Skripten nicht vorkommen dürfen */
const OLD_NAMES = new RegExp(`${OLD_NAME}|${OLD_CLI}`, "i");

const root = resolve(import.meta.dir, "..");
const webPublic = join(root, "src", "web", "public");
const setupPublic = join(root, "src", "setup", "public");
const dir = await mkdtemp(join(tmpdir(), "tybo-web-brand-"));
const PASSWORD = "test-passwort-lang";
let web: WebServer;
let setup: Started;

beforeAll(async () => {
  web = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    { sessionFile: join(dir, "web-sessions.json"), dataDir: join(dir, "web"), log: () => {} }
  );
  setup = await startSetup();
});
afterAll(async () => {
  await web.stop();
  await setup.server.stop();
  await cleanup();
  await rm(dir, { recursive: true, force: true });
});

async function webLogin(): Promise<string> {
  const res = await fetch(`${web.url}/api/login`, { method: "POST", headers: { origin: web.url }, body: JSON.stringify({ password: PASSWORD }) });
  return res.headers.get("set-cookie")!.split(";")[0];
}

/** Führt /brand.js wie der Browser aus und gibt window.TYBO_BRAND zurück */
function runBrandScript(code: string): unknown {
  const window: Record<string, unknown> = {};
  new Function("window", code)(window);
  return window.TYBO_BRAND;
}

describe("brand-asset", () => {
  test("brand.js setzt window.TYBO_BRAND genau auf BRAND, unveränderlich", () => {
    const value = runBrandScript(brandScript()) as Record<string, string>;
    expect(value).toEqual({ ...BRAND });
    expect(Object.isFrozen(value)).toBe(true);
  });

  test("Platzhalter werden ersetzt und maskiert, anderes bleibt", () => {
    expect(renderBrandHtml("<title>{{brand.name}} Anmeldung</title>{{brand.cli}} {{brand.domain}} {{brand.x}}")).toBe(
      `<title>${BRAND.name} Anmeldung</title>${BRAND.cli} ${BRAND.domain} {{brand.x}}`
    );
  });
});

describe("HTML-Dateien", () => {
  const pages = [
    [webPublic, "login.html", "login.js"],
    [webPublic, "index.html", "settings.js"],
    [setupPublic, "setup.html", "setup.js"],
    [setupPublic, "setup-code.html", "setup-code.js"],
  ] as const;

  test.each(pages)("%s/%s: Titel und Wortmarke aus BRAND, /brand.js vor den Skripten, kein fester Name", async (folder, file, firstScript) => {
    const html = await readFile(join(folder, file), "utf8");
    expect(html).toMatch(/<title>\{\{brand\.name\}\}[^<]*<\/title>/);
    expect(html).toMatch(/class="wordmark[^"]*">\{\{brand\.name\}\}</);
    const brandAt = html.indexOf('<script src="/brand.js"></script>');
    expect(brandAt).toBeGreaterThan(0);
    expect(brandAt).toBeLessThan(html.indexOf(`<script src="/${firstScript}" defer>`));
    expect(html).not.toMatch(OLD_NAMES);
  });

  test("Browser-Skripte nennen keinen alten Namen; Speicher-Schlüssel heißen tybo-* (Issue #141)", async () => {
    const files = [
      ...(await readdir(webPublic)).filter(f => f.endsWith(".js")).map(f => join(webPublic, f)),
      ...(await readdir(setupPublic)).filter(f => f.endsWith(".js")).map(f => join(setupPublic, f)),
    ];
    const keys: string[] = [];
    for (const file of files) {
      const code = await readFile(file, "utf8");
      expect(code).not.toMatch(OLD_NAMES);
      for (const m of code.matchAll(/"(tybo-[a-z-]+)"/g)) keys.push(m[1]);
    }
    // tybo-push-device, tybo-push-off-pending: Gerät und ausstehendes Ausschalten für Web Push (Issue #225)
    expect(keys.sort()).toEqual(["tybo-last-conversation", "tybo-push-device", "tybo-push-off-pending", "tybo-reload-drafts", "tybo-theme", "tybo-unread"]);
  });
});

describe("Web-Server der WebUI", () => {
  test("/brand.js ohne Anmeldung, als JavaScript, mit unveränderter CSP", async () => {
    const res = await fetch(`${web.url}/brand.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("content-security-policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]);
    expect(runBrandScript(await res.text())).toEqual({ ...BRAND });
  });

  test("Login-Seite ohne Anmeldung: Titel und Wortmarke mit dem Namen", async () => {
    const html = await (await fetch(`${web.url}/login`)).text();
    expect(html).toContain(`<title>${BRAND.name} Anmeldung</title>`);
    expect(html).toContain(`<h1 class="wordmark wordmark-large">${BRAND.name}</h1>`);
    expect(html).not.toContain("{{brand");
  });

  test("Chat-Seite nach dem Login: Titel, Wortmarke, Kopfzeile, Platzhalter", async () => {
    const html = await (await fetch(`${web.url}/`, { headers: { cookie: await webLogin() } })).text();
    expect(html).toContain(`<title>${BRAND.name}</title>`);
    expect(html).toContain(`<span class="wordmark">${BRAND.name}</span>`);
    expect(html).toContain(`disabled>${BRAND.name}</button>`);
    expect(html).toContain(`placeholder="Nachricht an ${BRAND.name}"`);
    expect(html).toContain(`${BRAND.name} denkt nach</span>`);
    expect(html).not.toContain("{{brand");
  });

  test("/index.html direkt: auch ersetzt", async () => {
    const html = await (await fetch(`${web.url}/index.html`, { headers: { cookie: await webLogin() } })).text();
    expect(html).toContain(`<title>${BRAND.name}</title>`);
  });
});

describe("Einrichtungs-Server", () => {
  test("/brand.js und Code-Seite ohne Anmeldung", async () => {
    const script = await get(setup, "/brand.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(runBrandScript(await script.text())).toEqual({ ...BRAND });
    const code = await get(setup, "/code");
    const html = await code.text();
    expect(html).toContain(`<title>${BRAND.name} Einrichtung</title>`);
    expect(html).toContain(`in dem ${BRAND.name} gestartet wurde.`);
    expect(html).not.toContain("{{brand");
  });

  test("Assistent nach der Anmeldung: Titel und Wortmarke; Cookie heißt tybo_setup", async () => {
    const res = await fetch(`${setup.base}/api/setup/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: setup.origin },
      body: JSON.stringify({ code: "K7MP2QXR" }),
    });
    expect(res.headers.get("set-cookie")).toStartWith("tybo_setup=");
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    const html = await (await get(setup, "/", cookie)).text();
    expect(html).toContain(`<title>${BRAND.name} Einrichtung</title>`);
    expect(html).toContain(`<span class="wordmark">${BRAND.name}</span>`);
    expect(html).not.toContain("{{brand");
  });
});
