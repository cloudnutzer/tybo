import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createWebServer, type WebServer } from "../src/web/server";
import { TYBO_BRAND } from "./brand-fixture";

const root = resolve(import.meta.dir, "..");
const dir = await mkdtemp(join(tmpdir(), "tybo-web-public-"));
let server: WebServer;

beforeAll(async () => {
  // echte Dateien aus src/web/public, Sessions nur im temporären Verzeichnis
  server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: "test-passwort-lang", allowedHosts: [] },
    { sessionFile: join(dir, "web-sessions.json"), dataDir: join(dir, "web"), log: () => {} }
  );
});
afterAll(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

const publicDir = join(root, "src", "web", "public");

test("keine HTML-Datei in src/web/public hat Inline-Skripte, on...-Attribute oder Inline-Styles", async () => {
  const files = (await readdir(publicDir)).filter(f => f.endsWith(".html"));
  expect(files.sort()).toEqual(["index.html", "login.html"]);
  for (const f of files) {
    const html = await readFile(join(publicDir, f), "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=|<style/i);
    expect(html).not.toMatch(/https?:\/\//i); // kein CDN, keine fremden Quellen
  }
});

test("Login-Seite wird ausgeliefert", async () => {
  const res = await fetch(`${server.url}/login`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('type="password"');
  expect(html).toContain('<script src="/login.js"');
  expect((await fetch(`${server.url}/login.js`)).headers.get("content-type")).toContain("javascript");
  expect((await fetch(`${server.url}/style.css`)).status).toBe(200);
  expect(html).toContain('<link rel="icon" href="/favicon.svg"');
  const icon = await fetch(`${server.url}/favicon.svg`);
  expect(icon.status).toBe(200);
  expect(icon.headers.get("content-type")).toContain("image/svg+xml");
  expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png"');
  const touch = await fetch(`${server.url}/apple-touch-icon.png`);
  expect(touch.status).toBe(200);
  expect(touch.headers.get("content-type")).toContain("image/png");
});

test("Chat-Seite und app.js nach dem Login, vorher Umleitung", async () => {
  const origin = server.url;
  const anonymous = await fetch(`${origin}/`, { redirect: "manual" });
  expect(anonymous.status).toBe(302);
  expect((await fetch(`${origin}/app.js`, { redirect: "manual" })).status).toBe(302);

  const login = await fetch(`${origin}/api/login`, {
    method: "POST", headers: { origin }, body: JSON.stringify({ password: "test-passwort-lang" }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const page = await fetch(`${origin}/`, { headers: { cookie } });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('<script src="/app.js" defer></script>');
  // Einstellungen (Issue #38): vor app.js geladen, nur nach dem Login
  expect(html.indexOf('<script src="/settings.js" defer></script>')).toBeGreaterThan(-1);
  expect(html.indexOf('<script src="/settings.js"')).toBeLessThan(html.indexOf('<script src="/app.js"'));
  expect((await fetch(`${origin}/settings.js`, { redirect: "manual" })).status).toBe(302);
  const settingsJs = await fetch(`${origin}/settings.js`, { headers: { cookie } });
  expect(settingsJs.status).toBe(200);
  expect(settingsJs.headers.get("content-type")).toContain("javascript");
  for (const id of ["chat-log", "messages", "activity", "progress", "stop", "composer", "input", "send", "agent-name", "new-chat", "logout"]) {
    expect(html).toContain(`id="${id}"`);
  }
  const js = await fetch(`${origin}/app.js`, { headers: { cookie } });
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toContain("javascript");
});

// ---------------------------------------------------------------------------
// app.js ohne Browser: kleine Attrappe für document, nur was der Renderer braucht
// ---------------------------------------------------------------------------

interface FakeNode {
  tagName: string;
  className: string;
  children: FakeNode[];
  attributes: Record<string, string>;
  textContent: string;
  innerHTMLWrites: string[];
  innerHTML: string;
  appendChild(child: FakeNode): FakeNode;
  setAttribute(name: string, value: string): void;
}

function fakeDocument() {
  return {
    getElementById: () => null,
    createElement(tag: string): FakeNode {
      const node: FakeNode = {
        tagName: tag.toUpperCase(),
        className: "",
        children: [],
        attributes: {},
        textContent: "",
        innerHTMLWrites: [],
        set innerHTML(v: string) { this.innerHTMLWrites.push(v); },
        get innerHTML() { return this.innerHTMLWrites.at(-1) ?? ""; },
        appendChild(child) { this.children.push(child); return child; },
        setAttribute(name, value) { this.attributes[name] = value; },
      };
      return node;
    },
  };
}

async function loadApp() {
  const source = await readFile(join(publicDir, "app.js"), "utf8");
  // Klassisches Skript: Funktionsdeklarationen sind im Funktionsrumpf sichtbar
  const factory = new Function("document", "window", `${source}\nreturn { messageElement, progressItem, toolLabel, agentLabel };`);
  return factory(fakeDocument(), { TYBO_BRAND }) as {
    messageElement(m: object): FakeNode;
    progressItem(kind: string, text: string): FakeNode;
    toolLabel(name: string): string;
    agentLabel(agent: string): string;
  };
}

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

test("Nutzernachrichten landen als Text in der Seite, nie als HTML", async () => {
  const app = await loadApp();
  // auch mit html-Feld: bei Nutzernachrichten wird es ignoriert
  const node = app.messageElement({ id: "u1", role: "user", text: HOSTILE, html: HOSTILE });
  expect(node.className).toBe("msg msg-user");
  const body = node.children[0];
  expect(body.textContent).toBe(HOSTILE);
  expect(body.innerHTMLWrites).toEqual([]);
  expect(node.innerHTMLWrites).toEqual([]);
});

test("Fehler, Fortschritt und Hinweise ebenfalls nur als Text", async () => {
  const app = await loadApp();
  const error = app.messageElement({ id: "e1", role: "error", text: HOSTILE });
  expect(error.className).toBe("msg msg-error");
  expect(error.children[0].textContent).toBe(HOSTILE);
  expect(error.children[0].innerHTMLWrites).toEqual([]);

  // Unbekannte Rolle gilt als Nutzertext
  const odd = app.messageElement({ id: "x", role: "system", text: HOSTILE, html: HOSTILE });
  expect(odd.children[0].innerHTMLWrites).toEqual([]);

  const tool = app.progressItem("tool", "WebSearch");
  expect(tool.textContent).toBe("Websuche");
  const snippet = app.progressItem("snippet", HOSTILE);
  expect(snippet.className).toContain("step-snippet");
  expect(snippet.children[0].tagName).toBe("EM");
  expect(snippet.children[0].textContent).toBe(HOSTILE);
  const notice = app.progressItem("notice", HOSTILE);
  expect(notice.className).toContain("step-notice");
  expect(notice.textContent).toBe(HOSTILE);
  for (const n of [tool, snippet, notice, ...snippet.children]) expect(n.innerHTMLWrites).toEqual([]);
});

test("Antworten zeigen das HTML des Servers", async () => {
  const app = await loadApp();
  const node = app.messageElement({ id: "a1", role: "assistant", text: "**fett**", html: "<p><strong>fett</strong></p>" });
  expect(node.className).toBe("msg msg-assistant");
  expect(node.children[0].innerHTMLWrites).toEqual(["<p><strong>fett</strong></p>"]);
});

test("innerHTML kommt in app.js genau einmal vor, nur für message.html", async () => {
  const source = await readFile(join(publicDir, "app.js"), "utf8");
  const code = source.replace(/^\s*\/\/.*$/gm, "");
  const uses = code.match(/\.innerHTML\b|outerHTML|insertAdjacentHTML|document\.write/g) ?? [];
  expect(uses).toEqual([".innerHTML"]);
  expect(code).toMatch(/body\.innerHTML = message\.html;/);
});

test("settings.js setzt nie HTML: Modellnamen, Anweisungen und Meldungen nur als Text (Issue #38)", async () => {
  const source = await readFile(join(publicDir, "settings.js"), "utf8");
  const code = source.replace(/^\s*\/\/.*$/gm, "");
  expect(code.match(/\.innerHTML\b|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/g) ?? []).toEqual([]);
});

test("Werkzeugnamen auf Deutsch, auch die Anzeigenamen aus src/lib/claude.ts", async () => {
  const app = await loadApp();
  expect(app.toolLabel("Read")).toBe("Datei lesen");
  expect(app.toolLabel("Reading file")).toBe("Datei lesen");
  expect(app.toolLabel("Searching the web")).toBe("Websuche");
  expect(app.toolLabel("Using notion")).toBe("Werkzeug: notion");
  expect(app.toolLabel("mcp__google-calendar__list")).toBe("Werkzeug: google calendar");
  expect(app.agentLabel("general")).toBe("General");
});

/**
 * Alle zur Laufzeit lokal importierten Dateien ab einem Einstieg, rekursiv.
 * Reine Typimporte ("import type ... from", "export type ... from") entfernt
 * TypeScript vollständig, sie laden nichts und werden übersprungen. Gemischte
 * Importe ("import { type A, b }") zählen weiter.
 */
async function localImports(entry: string, seen = new Set<string>()): Promise<Set<string>> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = await readFile(entry, "utf8");
  // Statische Importe nur am Zeilenanfang, damit Wörter wie "importiert" in Kommentaren nicht zählen
  for (const m of source.matchAll(/^[ \t]*(?:import|export)\b[^'"]*?from\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|^[ \t]*import\s*["']([^"']+)["']/gm)) {
    if (/^\s*(?:import|export)\s+type\s/.test(m[0])) continue;
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec.startsWith(".")) continue;
    const target = resolve(dirname(entry), spec);
    await localImports(target.endsWith(".ts") ? target : `${target}.ts`, seen);
  }
  return seen;
}

test("web:dev importiert src/bot.ts nicht, auch nicht über Umwege", async () => {
  const files = [...(await localImports(join(root, "scripts", "web-dev.ts")))].map(f => f.slice(root.length + 1));
  expect(files).not.toContain("src/bot.ts");
  // Ausnahme src/brand.ts (Issue #100): nur der Name, ohne eigene Importe
  expect(files.every(f => f === "scripts/web-dev.ts" || f === "src/brand.ts" || f.startsWith("src/web/"))).toBe(true);
});

test("Importprüfung überspringt nur reine Typimporte", async () => {
  const fixture = join(dir, "imports");
  await mkdir(fixture, { recursive: true });
  await writeFile(join(fixture, "entry.ts"), [
    'import type { A } from "./nur-typ";',
    'export type { B } from "./nur-typ-export";',
    'import { type C, d } from "./gemischt";',
    'import e from "./laufzeit";',
    'import "./seiteneffekt";',
    '// importiert nichts: from "./kommentar"',
  ].join("\n"));
  for (const f of ["nur-typ", "nur-typ-export", "gemischt", "laufzeit", "seiteneffekt", "kommentar"]) await writeFile(join(fixture, `${f}.ts`), "");
  const found = [...(await localImports(join(fixture, "entry.ts")))].map(f => f.slice(fixture.length + 1)).sort();
  expect(found).toEqual(["entry.ts", "gemischt.ts", "laufzeit.ts", "seiteneffekt.ts"]);
});

test("Web-Server lädt zur Laufzeit nichts außerhalb von src/web", async () => {
  const files = [...(await localImports(join(root, "src", "web", "server.ts")))].map(f => f.slice(root.length + 1));
  // Ausnahme src/brand.ts (Issue #100): Name für /brand.js und die HTML-Seiten
  expect(files.every(f => f === "src/brand.ts" || f.startsWith("src/web/"))).toBe(true);
  expect(files).toContain("src/web/chat.ts");
  expect(files).toContain("src/brand.ts");
  expect([...(await localImports(join(root, "src", "brand.ts")))]).toEqual([join(root, "src", "brand.ts")]);
});
