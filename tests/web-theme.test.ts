// Hell/Dunkel-Wahl (Issue #15): theme.js ohne Browser, mit Attrappen für
// document, Meta-Tags und localStorage.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWebServer, type WebServer } from "../src/web/server";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const themeSource = await readFile(join(publicDir, "theme.js"), "utf8");

interface FakeMeta {
  attributes: Record<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

function meta(attributes: Record<string, string>): FakeMeta {
  return {
    attributes: { ...attributes },
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}

/** localStorage-Attrappe; readFails/writeFails lassen get/setItem werfen, blocked schon den Zugriff. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  const store = {
    data,
    readFails: false,
    writeFails: false,
    getItem(key: string) {
      if (store.readFails) throw new DOMException("gesperrt", "SecurityError");
      return key in data ? data[key] : null;
    },
    setItem(key: string, value: string) {
      if (store.writeFails) throw new DOMException("voll", "QuotaExceededError");
      data[key] = String(value);
    },
  };
  return store;
}

/** Lädt theme.js wie der Browser im <head>: Meta-Tags stehen schon im Dokument. */
function loadTheme(storage: ReturnType<typeof fakeStorage> | "blocked" = fakeStorage()) {
  const themeColors = [
    meta({ name: "theme-color", content: "#ffffff", media: "(prefers-color-scheme: light)" }),
    meta({ name: "theme-color", content: "#1f2023", media: "(prefers-color-scheme: dark)" }),
  ];
  const colorScheme = meta({ name: "color-scheme", content: "light dark" });
  const root = { dataset: {} as Record<string, string> };
  const document = {
    documentElement: root,
    querySelectorAll(selector: string) {
      return selector === 'meta[name="theme-color"]' ? themeColors : [];
    },
    querySelector(selector: string) {
      return selector === 'meta[name="color-scheme"]' ? colorScheme : null;
    },
  };
  const window: Record<string, any> = {};
  Object.defineProperty(window, "localStorage", {
    get() {
      if (storage === "blocked") throw new DOMException("Zugriff verweigert", "SecurityError");
      return storage;
    },
  });
  new Function("document", "window", themeSource)(document, window);
  const colors = () => themeColors.map(m => m.attributes.content);
  return { theme: window.WebTheme, root, colors, colorScheme: () => colorScheme.attributes.content, storage };
}

test("fehlender Wert ergibt System: kein data-theme, Meta-Tags unverändert", () => {
  const t = loadTheme();
  expect("theme" in t.root.dataset).toBe(false);
  expect(t.theme.current()).toBe("system");
  expect(t.colors()).toEqual(["#ffffff", "#1f2023"]);
  expect(t.colorScheme()).toBe("light dark");
});

test("ungültige Werte ergeben System", () => {
  for (const value of ["", "blau", "Dark", "LIGHT", " dark", "null", "undefined", "{}"]) {
    const t = loadTheme(fakeStorage({ "tybo-theme": value }));
    expect("theme" in t.root.dataset).toBe(false);
    expect(t.theme.read()).toBe("system");
  }
});

test('"dark" setzt data-theme="dark" und eine feste theme-color schon beim Laden', () => {
  const t = loadTheme(fakeStorage({ "tybo-theme": "dark" }));
  expect(t.root.dataset.theme).toBe("dark");
  expect(t.colors()).toEqual(["#1f2023", "#1f2023"]);
  expect(t.colorScheme()).toBe("dark");
});

test('"light" setzt data-theme="light" und feste helle theme-color', () => {
  const t = loadTheme(fakeStorage({ "tybo-theme": "light" }));
  expect(t.root.dataset.theme).toBe("light");
  expect(t.colors()).toEqual(["#ffffff", "#ffffff"]);
  expect(t.colorScheme()).toBe("light");
});

test('"system" entfernt das Attribut und stellt beide Media-Varianten wieder her', () => {
  const storage = fakeStorage({ "tybo-theme": "dark" });
  const t = loadTheme(storage);
  expect(t.root.dataset.theme).toBe("dark");
  expect(t.theme.choose("system")).toBe("system");
  expect("theme" in t.root.dataset).toBe(false);
  expect(t.colors()).toEqual(["#ffffff", "#1f2023"]);
  expect(t.colorScheme()).toBe("light dark");
  expect(storage.data["tybo-theme"]).toBe("system");
});

test("choose wirkt sofort und speichert; ungültige Wahl wird zu System", () => {
  const storage = fakeStorage();
  const t = loadTheme(storage);
  t.theme.choose("light");
  expect(t.root.dataset.theme).toBe("light");
  expect(storage.data["tybo-theme"]).toBe("light");
  t.theme.choose("<script>");
  expect("theme" in t.root.dataset).toBe(false);
  expect(storage.data["tybo-theme"]).toBe("system");
});

test("Lesefehler (privater Modus, gesperrter Zugriff) ergeben System ohne Ausnahme", () => {
  const failing = fakeStorage({ "tybo-theme": "dark" });
  failing.readFails = true;
  expect(() => loadTheme(failing)).not.toThrow();
  expect("theme" in loadTheme(failing).root.dataset).toBe(false);

  const blocked = loadTheme("blocked");
  expect("theme" in blocked.root.dataset).toBe(false);
  expect(blocked.theme.read()).toBe("system");
});

test("Schreibfehler brechen die Bedienung nicht ab: Wahl wirkt trotzdem", () => {
  const full = fakeStorage();
  full.writeFails = true;
  const t = loadTheme(full);
  expect(() => t.theme.choose("dark")).not.toThrow();
  expect(t.root.dataset.theme).toBe("dark");
  expect(t.theme.save("dark")).toBe(false);
  expect(full.data["tybo-theme"]).toBeUndefined();

  const blocked = loadTheme("blocked");
  expect(() => blocked.theme.choose("light")).not.toThrow();
  expect(blocked.root.dataset.theme).toBe("light");
  expect(blocked.theme.save("light")).toBe(false);
});

test("theme.js schreibt kein HTML", () => {
  const code = themeSource.replace(/^\s*\/\/.*$/gm, "");
  expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\b|new Function/);
});

test("beide Seiten laden theme.js im <head> ohne defer, nach den Meta-Tags und vor dem Stylesheet", async () => {
  for (const f of ["index.html", "login.html"]) {
    const html = await readFile(join(publicDir, f), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain('<script src="/theme.js"></script>');
    const at = head.indexOf("/theme.js");
    expect(head.lastIndexOf('name="theme-color"')).toBeLessThan(at);
    expect(head.indexOf('name="color-scheme"')).toBeLessThan(at);
    expect(head.indexOf("/style.css")).toBeGreaterThan(at);
  }
});

// ---------------------------------------------------------------------------
// Schalter in der Seitenleiste: initThemeSwitch aus app.js mit DOM-Attrappe
// ---------------------------------------------------------------------------

const appSource = await readFile(join(publicDir, "app.js"), "utf8");

interface FakeButton {
  id: string;
  attributes: Record<string, string>;
  listeners: Record<string, ((e: any) => void)[]>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | undefined;
  addEventListener(type: string, fn: (e: any) => void): void;
  focus(): void;
}

/** theme.js wie im <head>, danach app.js; nur die Schalter-Elemente existieren. */
function loadSwitch(saved?: string, storage = fakeStorage(saved === undefined ? {} : { "tybo-theme": saved })) {
  const t = loadTheme(storage);
  const doc = { activeElement: null as FakeButton | null };
  const elements: Record<string, FakeButton | { id: string }> = { "theme-switch": { id: "theme-switch" } };
  for (const id of ["theme-system", "theme-light", "theme-dark"]) {
    const button: FakeButton = {
      id,
      attributes: {},
      listeners: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name]; },
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
      focus() { doc.activeElement = this; },
    };
    elements[id] = button;
  }
  // chat-log fehlt: app.js startet init() nicht von selbst
  const document = { getElementById: (id: string) => elements[id] ?? null };
  const factory = new Function("document", "window", `${appSource}\nreturn { initThemeSwitch };`);
  const app = factory(document, {}) as { initThemeSwitch(theme: unknown): unknown };
  const handle = app.initThemeSwitch(t.theme);
  const button = (choice: string) => elements[`theme-${choice}`] as FakeButton;
  const checked = () => ["system", "light", "dark"].filter(c => button(c).attributes["aria-checked"] === "true");
  const tabStops = () => ["system", "light", "dark"].filter(c => button(c).attributes.tabindex === "0");
  const click = (choice: string) => { for (const fn of button(choice).listeners.click ?? []) fn({}); };
  const key = (choice: string, k: string) => {
    let prevented = false;
    for (const fn of button(choice).listeners.keydown ?? []) fn({ key: k, preventDefault() { prevented = true; } });
    return prevented;
  };
  return { ...t, handle, button, checked, tabStops, click, key, doc };
}

test("Schalter zeigt beim Start die gespeicherte Wahl, genau ein Tab-Stopp", () => {
  for (const [saved, expected] of [[undefined, "system"], ["light", "light"], ["dark", "dark"], ["quatsch", "system"]] as const) {
    const s = loadSwitch(saved);
    expect(s.handle).not.toBeNull();
    expect(s.checked()).toEqual([expected]);
    expect(s.tabStops()).toEqual([expected]);
    for (const c of ["system", "light", "dark"]) expect(["true", "false"]).toContain(s.button(c).attributes["aria-checked"]);
  }
});

test('Klick auf „Hell" setzt aria-checked richtig, speichert "light" und wirkt sofort', () => {
  const s = loadSwitch();
  s.click("light");
  expect(s.button("light").attributes["aria-checked"]).toBe("true");
  expect(s.button("system").attributes["aria-checked"]).toBe("false");
  expect(s.button("dark").attributes["aria-checked"]).toBe("false");
  expect(s.tabStops()).toEqual(["light"]);
  expect(s.storage !== "blocked" && s.storage.data["tybo-theme"]).toBe("light");
  expect(s.root.dataset.theme).toBe("light");
  expect(s.colors()).toEqual(["#ffffff", "#ffffff"]);

  // Zurück zu System: Attribut weg, beide Media-Varianten wieder da
  s.click("system");
  expect(s.checked()).toEqual(["system"]);
  expect("theme" in s.root.dataset).toBe(false);
  expect(s.colors()).toEqual(["#ffffff", "#1f2023"]);
});

test("Pfeiltasten bewegen Fokus und Wahl reihum, Pos1/Ende an den Rand", () => {
  const s = loadSwitch();
  expect(s.key("system", "ArrowRight")).toBe(true);
  expect(s.checked()).toEqual(["light"]);
  expect(s.doc.activeElement?.id).toBe("theme-light");
  s.key("light", "ArrowDown");
  expect(s.checked()).toEqual(["dark"]);
  expect(s.doc.activeElement?.id).toBe("theme-dark");
  // am Ende wieder vorn
  s.key("dark", "ArrowRight");
  expect(s.checked()).toEqual(["system"]);
  expect(s.doc.activeElement?.id).toBe("theme-system");
  // rückwärts vom Anfang ans Ende
  s.key("system", "ArrowLeft");
  expect(s.checked()).toEqual(["dark"]);
  s.key("dark", "ArrowUp");
  expect(s.checked()).toEqual(["light"]);
  s.key("light", "Home");
  expect(s.checked()).toEqual(["system"]);
  s.key("system", "End");
  expect(s.checked()).toEqual(["dark"]);
  expect(s.tabStops()).toEqual(["dark"]);
  expect(s.root.dataset.theme).toBe("dark");
});

test("Leertaste wählt den fokussierten Knopf, andere Tasten bleiben unberührt", () => {
  const s = loadSwitch("dark");
  expect(s.key("light", " ")).toBe(true);
  expect(s.checked()).toEqual(["light"]);
  expect(s.root.dataset.theme).toBe("light");
  // Tab, Enter und Buchstaben fängt der Schalter nicht ab
  for (const k of ["Tab", "a", "Escape"]) expect(s.key("light", k)).toBe(false);
  expect(s.checked()).toEqual(["light"]);
});

test("Schalter funktioniert auch, wenn der Browser nichts speichern lässt", () => {
  const full = fakeStorage();
  full.writeFails = true;
  const s = loadSwitch(undefined, full);
  expect(() => s.click("dark")).not.toThrow();
  expect(s.checked()).toEqual(["dark"]);
  expect(s.root.dataset.theme).toBe("dark");
});

test("ohne theme.js bleibt der Schalter unverbunden, app.js läuft weiter", () => {
  const factory = new Function("document", "window", `${appSource}\nreturn { initThemeSwitch };`);
  const app = factory({ getElementById: (id: string) => (id === "chat-log" ? null : {}) }, {}) as { initThemeSwitch(theme: unknown): unknown };
  expect(app.initThemeSwitch(undefined)).toBeNull();
});

test("app.js verbindet den Schalter beim Start und setzt ihn nur über Attribute", () => {
  const code = appSource.replace(/^\s*\/\/.*$/gm, "");
  expect(code).toContain("initThemeSwitch(window.WebTheme);");
  const fn = code.slice(code.indexOf("function initThemeSwitch"), code.indexOf("function init()"));
  expect(fn).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|textContent/);
});

test("Schalter im HTML: benannte Radiogruppe über Abmelden, drei Radio-Knöpfe mit Symbol und Text", async () => {
  const html = await readFile(join(publicDir, "index.html"), "utf8");
  const foot = html.slice(html.indexOf('class="sidebar-foot"'), html.indexOf('id="logout"'));
  expect(foot).toMatch(/<div id="theme-switch" class="theme-switch" role="radiogroup" aria-label="Darstellung">/);
  const labels: string[] = [];
  for (const m of foot.matchAll(/<button type="button" id="theme-(\w+)"[^>]*role="radio"[^>]*>\s*<svg[^>]*aria-hidden="true">[\s\S]*?<span>([^<]+)<\/span>/g)) {
    labels.push(`${m[1]}:${m[2]}`);
  }
  expect(labels).toEqual(["system:System", "light:Hell", "dark:Dunkel"]);
  expect(foot.match(/aria-checked="true"/g)).toHaveLength(1);
  expect(foot.match(/tabindex="0"/g)).toHaveLength(1);
  // Login-Seite hat keinen Schalter
  expect(await readFile(join(publicDir, "login.html"), "utf8")).not.toContain("theme-switch");
});

// ---------------------------------------------------------------------------
// Auslieferung: theme.js muss vor der Anmeldung erreichbar sein (Login-Seite)
// ---------------------------------------------------------------------------

let dir: string;
let server: WebServer;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tybo-web-theme-"));
  server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: "test-passwort-lang", allowedHosts: [] },
    { sessionFile: join(dir, "web-sessions.json"), dataDir: join(dir, "web"), log: () => {} }
  );
});
afterAll(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

test("theme.js ohne Cookie: HTTP 200, JavaScript, mit Sicherheits-Headern", async () => {
  const res = await fetch(`${server.url}/theme.js`, { redirect: "manual" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("javascript");
  expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(await res.text()).toBe(themeSource);
});
