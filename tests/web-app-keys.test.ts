// Reiter „Schlüssel" (Issue #63): Liste nach Gruppen, Setzen, Ersetzen und
// Entfernen nach den Schutzregeln aus SPEC.md. Ohne Browser: settings.js
// läuft gegen eine DOM-Attrappe, die API ist die echte createKeysApi aus
// src/web/keys.ts mit einer .env im Speicher. Geprüft wird jeder erzeugte
// Knoten (auch abgehängte): Text, Attribute und value.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createKeysApi, type KeysPort } from "../src/web/keys";
import { TYBO_BRAND } from "./brand-fixture";

const settingsSource = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "settings.js"), "utf8");

// Platzhalter, keine echten Schlüssel
const OLD_ANTHROPIC = "platzhalter-anthropic-alt-Q7x2";
const NEW_OPENROUTER = "platzhalter-openrouter-neu-Z9k4";
const NEW_ANTHROPIC = "platzhalter-anthropic-neu-M3p8";
const SHORT = "kurz12";
const BOT_TOKEN = "000000000:platzhalter-hauptbot-T0k3";
const WEB_PASSWORD = "platzhalter-webpasswort-W3b1";

interface Node {
  tagName: string;
  children: Node[];
  attributes: Record<string, string>;
  [key: string]: any;
}

let htmlWrites: string[] = [];
let created: Node[] = [];

function node(tag = "div"): Node {
  const n: Node = {
    tagName: tag.toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    className: "",
    textContent: "",
    hidden: false,
    disabled: false,
    value: "",
    type: "",
    id: "",
    focused: 0,
    appendChild(child: Node) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...list: Node[]) {
      this.children = list.flatMap(c => (c.fragment ? c.children : [c]));
    },
    setAttribute(name: string, value: string) { this.attributes[name] = String(value); },
    getAttribute(name: string) { return this.attributes[name]; },
    removeAttribute(name: string) { delete this.attributes[name]; },
    listeners: {} as Record<string, ((e: any) => void)[]>,
    addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); },
    dispatch(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) fn(event); },
    focus() { this.focused++; doc.activeElement = this; },
  };
  Object.defineProperty(n, "innerHTML", {
    set(v: string) { htmlWrites.push(v); },
    get() { return ""; },
  });
  created.push(n);
  return n;
}

const elements: Record<string, Node> = {};
const doc: Record<string, any> = {
  activeElement: null,
  getElementById(id: string) { return (elements[id] ??= node()); },
  createElement(tag: string) { return node(tag); },
  createDocumentFragment() { const f = node(); f.fragment = true; return f; },
  querySelector(sel: string) {
    const m = sel.match(/^\[data-focus-key="(.*)"\]$/);
    if (!m) return null;
    const attached = all(elements["settings-panel"]).concat(all(elements["settings-tabs"]));
    return attached.find(n => n.attributes["data-focus-key"] === m[1]) ?? null;
  },
};

function all(root: Node | undefined): Node[] {
  if (!root) return [];
  return [root, ...root.children.flatMap(c => all(c))];
}

interface Options {
  /** WEB_ALLOW_KEY_EDIT beim Start und in der .env */
  editAllowed?: boolean;
  /** Zusätzliche Einträge der .env */
  file?: Record<string, string>;
  /** Werte, mit denen der Prozess läuft; Standard: wie die .env beim Start */
  running?: Record<string, string>;
}

interface Request { method: string; path: string; body: unknown }

function setup(options: Options = {}) {
  htmlWrites = [];
  created = [];
  for (const k of Object.keys(elements)) delete elements[k];
  doc.activeElement = null;
  const editAllowed = options.editAllowed ?? true;
  const file = new Map<string, string>(Object.entries({
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_USER_ID: "123456789",
    TELEGRAM_BOT_TOKEN_RESEARCH: "",
    WEB_PASSWORD,
    ANTHROPIC_API_KEY: OLD_ANTHROPIC,
    XAI_API_KEY: SHORT,
    EIGENER_WERT: "platzhalter-eigener-wert-1234",
    ...(editAllowed ? { WEB_ALLOW_KEY_EDIT: "true" } : {}),
    ...options.file,
  }));
  const atStart = options.running ?? Object.fromEntries(file);
  const port: KeysPort = {
    read: async () => Object.fromEntries(file),
    set: async (name, value) => { file.set(name, value); },
    remove: async name => file.delete(name),
    running: () => atStart,
    editEnabledAtStart: () => editAllowed,
  };
  const keysApi = createKeysApi(port, () => {});
  const server = {
    file,
    requests: [] as Request[],
    /** Antworten dieser Methode zurückhalten, bis release() */
    hold: new Set<string>(),
    /** Anfragen dieser Methode vor der eigentlichen Ausführung anhalten, bis release() */
    holdBefore: new Set<string>(),
    releases: [] as (() => void)[],
    offline: new Set<string>(),
    restart: { status: 202, body: { requested: true, message: "Neustart angefordert." } as any },
    /** Feste Antwort auf PUT statt der echten API */
    putReply: null as null | { status: number; body: any },
    /** Anfragen kommen über den Cloudflare Tunnel (Issue #99) */
    tunneled: false,
  };
  const api = async (method: string, path: string, body?: unknown) => {
    // Wie app.js: der Body geht als JSON über die Leitung
    const raw = body === undefined ? undefined : JSON.stringify(body);
    server.requests.push({ method, path, body: raw === undefined ? undefined : JSON.parse(raw) });
    if (server.offline.has(method)) throw new TypeError("offline");
    if (server.holdBefore.has(method)) await new Promise<void>(r => server.releases.push(r));
    let result: { status: number; body: any };
    const request = { tunneled: server.tunneled };
    if (path === "/api/keys" && method === "GET") result = await keysApi.list(request);
    else if (path === "/api/restart" && method === "POST") result = server.restart;
    else {
      const m = path.match(/^\/api\/keys\/(.+)$/);
      if (!m) result = { status: 404, body: { error: "unbekannt" } };
      else if (method === "PUT" && server.putReply) result = server.putReply;
      else if (method === "PUT") result = await keysApi.put(decodeURIComponent(m[1]), raw ?? "", request);
      else if (method === "DELETE") result = await keysApi.remove(decodeURIComponent(m[1]), request);
      else result = { status: 405, body: { error: "nein" } };
    }
    if (server.hold.has(method)) await new Promise<void>(r => server.releases.push(r));
    const data = JSON.parse(JSON.stringify(result.body));
    return { status: result.status, ok: result.status >= 200 && result.status < 300, data };
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const view = new Function("document", "window", `${settingsSource}\nreturn createSettingsView;`)(doc, { TYBO_BRAND })({
    api,
    agentLabel: (n: string) => n,
    setTimeout: (fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  });

  const panel = () => elements["settings-panel"];
  const nodes = () => all(panel());
  const byKey = (key: string) => nodes().find(n => n.attributes["data-focus-key"] === key);
  const click = (key: string) => {
    const b = byKey(key);
    if (!b) throw new Error(`Knopf ${key} fehlt`);
    b.dispatch("click");
  };
  const row = (name: string) => nodes().find(n => n.tagName === "LI" && n.attributes["data-key"] === name);
  const rowText = (name: string) => all(row(name)).map(n => n.textContent).filter(Boolean);
  const rowButtons = (name: string) => all(row(name)).filter(n => n.tagName === "BUTTON").map(n => n.textContent);
  const input = (name: string) => nodes().find(n => n.tagName === "INPUT" && n.attributes["data-focus-key"] === `key-input:${name}`);
  const requests = (method: string, prefix = "/api/") => server.requests.filter(r => r.method === method && r.path.startsWith(prefix));
  const panelText = () => nodes().map(n => n.textContent).join("\n");
  return { view, server, panel, nodes, byKey, click, row, rowText, rowButtons, input, requests, panelText, timers };
}

async function settle() {
  for (let i = 0; i < 30; i++) await Bun.sleep(0);
}

async function openKeys(options: Options = {}) {
  const app = setup(options);
  app.view.show("schluessel");
  await settle();
  return app;
}

/** Wert irgendwo in erzeugten Knoten (Text, Attribute, value), außer in erlaubten Feldern */
function leaks(secret: string, allowed: Node[] = []): string[] {
  const found: string[] = [];
  for (const n of created) {
    const fields: [string, unknown][] = [["textContent", n.textContent], ["title", n.title], ...Object.entries(n.attributes)];
    if (!allowed.includes(n)) fields.push(["value", n.value]);
    for (const [where, v] of fields) if (typeof v === "string" && v.includes(secret)) found.push(`${n.tagName}.${where}`);
  }
  for (const h of htmlWrites) if (h.includes(secret)) found.push("innerHTML");
  return found;
}

const type = (field: Node, value: string) => {
  field.value = value;
  field.dispatch("input");
};

// --- 1. Reiter und Liste ------------------------------------------------------

describe("Reiter „Schlüssel\": Liste", () => {
  test("Reiter unter #/einstellungen/schluessel, zwischen Modelle und Status", async () => {
    const helpers = new Function("document", "window", `${settingsSource}\nreturn { settingsTabFromHash, SETTINGS_TABS };`)(doc, {});
    expect(helpers.settingsTabFromHash("#/einstellungen/schluessel")).toBe("schluessel");
    expect(helpers.SETTINGS_TABS.map((t: any) => t.label)).toEqual(["Agenten", "Modelle", "Schlüssel", "Status"]);
    const app = await openKeys();
    const tabs = elements["settings-tabs"].children;
    expect(tabs.map(t => t.attributes["aria-selected"])).toEqual(["false", "false", "true", "false"]);
    expect(elements["settings-panel"].attributes["aria-labelledby"]).toBe("settings-tab-schluessel");
    expect(app.requests("GET", "/api/keys")).toHaveLength(1);
  });

  test("Gruppen in der Reihenfolge des Katalogs, je Zeile Name, Beschreibung und Zustand", async () => {
    const app = await openKeys();
    const titles = app.nodes().filter(n => n.tagName === "H3").map(n => n.textContent);
    expect(titles).toEqual(["LLM-Anbieter", "Werkzeuge", "Dienste", "Telegram", "WebUI", "Datenbank", "Weitere"]);
    // Lang und änderbar: letzte 4 Zeichen
    expect(app.rowText("ANTHROPIC_API_KEY")).toContain("ANTHROPIC_API_KEY");
    expect(app.rowText("ANTHROPIC_API_KEY")).toContain("gesetzt ••••" + OLD_ANTHROPIC.slice(-4));
    expect(app.rowText("ANTHROPIC_API_KEY").some(t => t.startsWith("Anthropic-API."))).toBe(true);
    // Kurz: nur „gesetzt" (last4 null)
    expect(app.rowText("XAI_API_KEY")).toContain("gesetzt");
    expect(app.rowText("XAI_API_KEY").join(" ")).not.toContain("••••");
    // Fehlt, auch bei leerem Wert
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("fehlt");
    expect(app.rowText("TELEGRAM_BOT_TOKEN_RESEARCH")).toContain("fehlt");
    // Gesperrt: nur „gesetzt", keine Zeichen
    expect(app.rowText("TELEGRAM_BOT_TOKEN")).toContain("gesetzt");
    expect(app.rowText("WEB_PASSWORD")).toContain("gesetzt");
    expect(app.rowText("WEB_PASSWORD").join(" ")).not.toContain("••••");
    // Unbekannt unter „Weitere", ohne Beschreibung
    expect(app.rowText("EIGENER_WERT")).toEqual(["EIGENER_WERT", "gesetzt ••••1234", "Ersetzen", "Entfernen"]);
  });

  test("kein vollständiger Wert im DOM, kein innerHTML", async () => {
    const app = await openKeys();
    for (const secret of [OLD_ANTHROPIC, SHORT, BOT_TOKEN, WEB_PASSWORD, "platzhalter-eigener-wert-1234", "123456789"]) {
      expect(leaks(secret)).toEqual([]);
    }
    expect(htmlWrites).toEqual([]);
    expect(app.panelText()).not.toContain("platzhalter");
  });

  test("Laden scheitert: Fehler mit Aktualisieren, danach die Liste", async () => {
    const app = setup();
    app.server.offline.add("GET");
    app.view.show("schluessel");
    await settle();
    expect(app.panelText()).toContain("Schlüssel konnten nicht geladen werden.");
    app.server.offline.delete("GET");
    app.click("keys-refresh");
    await settle();
    expect(app.row("ANTHROPIC_API_KEY")).toBeDefined();
  });

  test("Status-Reiter verweist auf den Reiter Schlüssel", () => {
    expect(settingsSource).not.toContain("Ändern lassen sich Schlüssel hier noch nicht");
    expect(settingsSource).toContain("Ändern lassen sich Schlüssel im Reiter „Schlüssel");
  });
});

// --- 3. Schreibgeschützt und gesperrt -----------------------------------------

describe("Reiter „Schlüssel\": Schreibschutz und gesperrte Variablen", () => {
  test("ohne WEB_ALLOW_KEY_EDIT: keine Schreibknöpfe, Hinweis nennt Schalter und Neustart", async () => {
    const app = await openKeys({ editAllowed: false });
    const buttons = app.nodes().filter(n => n.tagName === "BUTTON").map(n => n.attributes["data-focus-key"]);
    expect(buttons).toEqual(["keys-refresh"]);
    expect(app.nodes().filter(n => n.tagName === "INPUT")).toEqual([]);
    const note = app.nodes().find(n => n.className === "settings-keys-readonly")!;
    expect(note.textContent).toContain("WEB_ALLOW_KEY_EDIT=true");
    expect(note.textContent).toContain("neu starten");
    // Die Liste bleibt sichtbar
    expect(app.rowText("ANTHROPIC_API_KEY")).toContain("gesetzt ••••" + OLD_ANTHROPIC.slice(-4));
  });

  test("Schalter nur in der .env, nicht beim Start: weiter schreibgeschützt", async () => {
    const app = setup({ editAllowed: false, file: { WEB_ALLOW_KEY_EDIT: "true" } });
    app.view.show("schluessel");
    await settle();
    expect(app.nodes().filter(n => n.tagName === "BUTTON")).toHaveLength(1);
    expect(app.panelText()).toContain("WEB_ALLOW_KEY_EDIT=true");
  });

  test("mit Opt-in: gesperrte Variablen sichtbar, ohne Knöpfe, mit Hinweis auf die .env", async () => {
    const app = await openKeys();
    for (const name of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID", "WEB_PASSWORD", "WEB_ALLOW_KEY_EDIT", "WEB_ENABLED", "WEB_PORT"]) {
      expect(app.row(name)).toBeDefined();
      expect(app.rowButtons(name)).toEqual([]);
      expect(app.row(name)!.attributes["data-locked"]).toBe("true");
      expect(app.rowText(name).join(" ")).toContain("Nur direkt in der .env");
    }
    // Hinweis in der Gruppe, ohne tybo setup als fertigen Weg zu nennen
    expect(app.panelText()).toContain("nur in der .env oder im Terminal mit „tybo setup\"");
    // Agentenbots und normale Schlüssel sind änderbar
    expect(app.rowButtons("TELEGRAM_BOT_TOKEN_RESEARCH")).toEqual(["Setzen"]);
    expect(app.rowButtons("ANTHROPIC_API_KEY")).toEqual(["Ersetzen", "Entfernen"]);
    expect(app.rowButtons("OPENROUTER_API_KEY")).toEqual(["Setzen"]);
    expect(app.panelText()).not.toContain("Schreibgeschützt");
  });

  test("Opt-in nach dem Laden entzogen: PUT bekommt 403, Feld leer, Schreibknöpfe weg", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    const field = app.input("OPENROUTER_API_KEY")!;
    type(field, NEW_OPENROUTER);
    app.server.file.delete("WEB_ALLOW_KEY_EDIT");
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.requests("PUT")).toHaveLength(1);
    expect(app.server.file.has("OPENROUTER_API_KEY")).toBe(false);
    expect(field.value).toBe("");
    expect(app.input("OPENROUTER_API_KEY")).toBeUndefined();
    // Nur noch Aktualisieren und Neustart (die .env weicht jetzt beim Schalter vom Prozess ab)
    expect(app.nodes().filter(n => n.tagName === "BUTTON").map(n => n.attributes["data-focus-key"])).toEqual(["keys-refresh", "key-restart"]);
    expect(app.panelText()).toContain("WEB_ALLOW_KEY_EDIT=true");
    expect(leaks(NEW_OPENROUTER)).toEqual([]);
  });

  test("über den Tunnel (Issue #99): Liste lesbar, keine Schreibknöpfe, Hinweis „nur im Heimnetz\"", async () => {
    const app = setup();
    app.server.tunneled = true;
    app.view.show("schluessel");
    await settle();
    const buttons = app.nodes().filter(n => n.tagName === "BUTTON").map(n => n.attributes["data-focus-key"]);
    expect(buttons).toEqual(["keys-refresh"]);
    expect(app.nodes().filter(n => n.tagName === "INPUT")).toEqual([]);
    const note = app.nodes().find(n => n.className === "settings-keys-readonly")!;
    expect(note.textContent).toBe("Schlüssel ändern geht nur im Heimnetz. Von unterwegs sind sie nur lesbar.");
    // Kein irreführender Hinweis auf den Schalter, der schon gesetzt ist
    expect(app.panelText()).not.toContain("WEB_ALLOW_KEY_EDIT=true");
    expect(app.rowText("ANTHROPIC_API_KEY")).toContain("gesetzt ••••" + OLD_ANTHROPIC.slice(-4));
  });

  test("Liste im Heimnetz geladen, dann über den Tunnel gespeichert: 403, nichts geändert, Hinweis „nur im Heimnetz\"", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    const field = app.input("OPENROUTER_API_KEY")!;
    type(field, NEW_OPENROUTER);
    app.server.tunneled = true;
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.requests("PUT")).toHaveLength(1);
    expect(app.server.file.has("OPENROUTER_API_KEY")).toBe(false);
    expect(field.value).toBe("");
    expect(app.input("OPENROUTER_API_KEY")).toBeUndefined();
    expect(app.nodes().filter(n => n.tagName === "BUTTON").map(n => n.attributes["data-focus-key"])).toEqual(["keys-refresh"]);
    expect(app.panelText()).toContain("nur im Heimnetz");
    expect(app.panelText()).not.toContain("WEB_ALLOW_KEY_EDIT=true");
    expect(leaks(NEW_OPENROUTER)).toEqual([]);
    // Zurück im Heimnetz: Schreibknöpfe wieder da
    app.server.tunneled = false;
    app.click("keys-refresh");
    await settle();
    expect(app.rowButtons("OPENROUTER_API_KEY")).toEqual(["Setzen"]);
  });

  test("Reiterwechsel während PUT, neues Feld offen, Opt-in entzogen: späte 403 sperrt und leert", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    type(app.input("OPENROUTER_API_KEY")!, NEW_OPENROUTER);
    app.server.holdBefore.add("PUT");
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    app.view.show("modelle");
    app.view.show("schluessel");
    await settle();
    app.click("key-edit:ANTHROPIC_API_KEY");
    const other = app.input("ANTHROPIC_API_KEY")!;
    type(other, NEW_ANTHROPIC);
    app.server.file.delete("WEB_ALLOW_KEY_EDIT");
    app.server.holdBefore.delete("PUT");
    for (const r of app.server.releases.splice(0)) r();
    await settle();
    expect(app.server.file.has("OPENROUTER_API_KEY")).toBe(false);
    expect(other.value).toBe("");
    expect(app.nodes().filter(n => n.tagName === "INPUT")).toEqual([]);
    expect(app.nodes().filter(n => n.tagName === "BUTTON").map(n => n.attributes["data-focus-key"])).toEqual(["keys-refresh", "key-restart"]);
    expect(app.panelText()).toContain("WEB_ALLOW_KEY_EDIT=true");
    expect(leaks(NEW_OPENROUTER)).toEqual([]);
    expect(leaks(NEW_ANTHROPIC)).toEqual([]);
  });

  test("Opt-in entzogen, Löschrückfrage offen: DELETE bekommt 403, nichts gelöscht, Knöpfe weg", async () => {
    const app = await openKeys();
    app.click("key-remove:ANTHROPIC_API_KEY");
    app.server.file.set("WEB_ALLOW_KEY_EDIT", "false");
    app.click("key-remove-yes:ANTHROPIC_API_KEY");
    await settle();
    expect(app.requests("DELETE")).toHaveLength(1);
    expect(app.server.file.get("ANTHROPIC_API_KEY")).toBe(OLD_ANTHROPIC);
    expect(app.rowButtons("ANTHROPIC_API_KEY")).toEqual([]);
  });
});

// --- 2. Setzen, Ersetzen, Entfernen ---------------------------------------------

describe("Reiter „Schlüssel\": Setzen und Ersetzen", () => {
  test("Setzen: Passwortfeld leer und verdeckt, Wert nur im PUT-Body, danach Feld leer", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    const field = app.input("OPENROUTER_API_KEY")!;
    expect(field.type).toBe("password");
    expect(field.attributes["type"]).toBe("password");
    expect(field.attributes["autocomplete"]).toBe("new-password");
    expect(field.attributes["value"]).toBeUndefined();
    expect(field.value).toBe("");
    expect(field.focused).toBe(1);
    type(field, NEW_OPENROUTER);
    // Vor dem Speichern: nur im Feld
    expect(leaks(NEW_OPENROUTER, [field])).toEqual([]);
    expect(app.requests("PUT")).toEqual([]);
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    const puts = app.requests("PUT");
    expect(puts).toEqual([{ method: "PUT", path: "/api/keys/OPENROUTER_API_KEY", body: { value: NEW_OPENROUTER } }]);
    // Außer dem PUT hat keine Anfrage den Wert gesehen
    expect(app.server.requests.filter(r => JSON.stringify(r).includes(NEW_OPENROUTER))).toHaveLength(1);
    expect(app.server.file.get("OPENROUTER_API_KEY")).toBe(NEW_OPENROUTER);
    // Nach dem Speichern: Feld leer und weg, Wert nirgends mehr
    expect(field.value).toBe("");
    expect(app.input("OPENROUTER_API_KEY")).toBeUndefined();
    expect(leaks(NEW_OPENROUTER)).toEqual([]);
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("gesetzt ••••" + NEW_OPENROUTER.slice(-4));
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("Gespeichert. Wirksam nach einem Neustart.");
    expect(app.rowButtons("OPENROUTER_API_KEY")).toEqual(["Ersetzen", "Entfernen"]);
    expect(htmlWrites).toEqual([]);
  });

  test("Ersetzen: Feld nie vorausgefüllt, Enter speichert, alter und neuer Wert nicht im DOM", async () => {
    const app = await openKeys();
    app.click("key-edit:ANTHROPIC_API_KEY");
    const field = app.input("ANTHROPIC_API_KEY")!;
    expect(field.value).toBe("");
    expect(app.rowText("ANTHROPIC_API_KEY")).toContain("Neuer Wert für ANTHROPIC_API_KEY");
    type(field, NEW_ANTHROPIC);
    field.dispatch("keydown", { key: "Enter", preventDefault() {} });
    await settle();
    expect(app.requests("PUT")).toHaveLength(1);
    expect(app.server.file.get("ANTHROPIC_API_KEY")).toBe(NEW_ANTHROPIC);
    expect(field.value).toBe("");
    expect(leaks(NEW_ANTHROPIC)).toEqual([]);
    expect(leaks(OLD_ANTHROPIC)).toEqual([]);
    expect(app.rowText("ANTHROPIC_API_KEY")).toContain("gesetzt ••••" + NEW_ANTHROPIC.slice(-4));
  });

  test("leerer Wert: kein PUT, Hinweis", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    type(app.input("OPENROUTER_API_KEY")!, "   ");
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.requests("PUT")).toEqual([]);
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("Bitte einen Wert eingeben.");
  });

  test("Abbrechen und Escape: kein PUT, Feld leer", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    const field = app.input("OPENROUTER_API_KEY")!;
    type(field, NEW_OPENROUTER);
    app.click("key-cancel:OPENROUTER_API_KEY");
    expect(field.value).toBe("");
    expect(app.input("OPENROUTER_API_KEY")).toBeUndefined();
    app.click("key-edit:OPENROUTER_API_KEY");
    const again = app.input("OPENROUTER_API_KEY")!;
    expect(again).not.toBe(field);
    expect(again.value).toBe("");
    type(again, NEW_OPENROUTER);
    again.dispatch("keydown", { key: "Escape" });
    expect(again.value).toBe("");
    await settle();
    expect(app.requests("PUT")).toEqual([]);
    expect(leaks(NEW_OPENROUTER)).toEqual([]);
  });

  test("Fehler vom Server (400): Meldung ohne Wert, Wert nur im Feld, erneuter Versuch geht", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    const field = app.input("OPENROUTER_API_KEY")!;
    const bad = "platzhalter\u0007mit-steuerzeichen";
    type(field, bad);
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.requests("PUT")).toHaveLength(1);
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("Steuerzeichen sind im Wert nicht erlaubt");
    expect(field.value).toBe(bad);
    expect(field.disabled).toBe(false);
    expect(leaks("mit-steuerzeichen", [field])).toEqual([]);
    type(field, NEW_OPENROUTER);
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.server.file.get("OPENROUTER_API_KEY")).toBe(NEW_OPENROUTER);
    expect(field.value).toBe("");
    expect(leaks(NEW_OPENROUTER)).toEqual([]);
  });

  test("Server nicht erreichbar: Meldung, Wert nur im Feld", async () => {
    const app = await openKeys();
    app.server.offline.add("PUT");
    app.click("key-edit:OPENROUTER_API_KEY");
    const field = app.input("OPENROUTER_API_KEY")!;
    type(field, NEW_OPENROUTER);
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("Server nicht erreichbar, nichts geändert.");
    expect(field.value).toBe(NEW_OPENROUTER);
    expect(leaks(NEW_OPENROUTER, [field])).toEqual([]);
  });

  test("Serverfehler, der den Wert enthielte, wird nicht angezeigt", async () => {
    const app = await openKeys();
    app.server.putReply = { status: 500, body: { error: "kaputt: " + NEW_OPENROUTER } };
    app.click("key-edit:OPENROUTER_API_KEY");
    const field = app.input("OPENROUTER_API_KEY")!;
    type(field, NEW_OPENROUTER);
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("Speichern fehlgeschlagen (Fehler 500).");
    expect(leaks(NEW_OPENROUTER, [field])).toEqual([]);
  });

  test("Doppelklick während des Speicherns: Feld gesperrt, genau ein PUT", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    const field = app.input("OPENROUTER_API_KEY")!;
    type(field, NEW_OPENROUTER);
    app.server.hold.add("PUT");
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(field.disabled).toBe(true);
    expect(app.byKey("key-save:OPENROUTER_API_KEY")!.disabled).toBe(true);
    // Zweiter Klick während des Speicherns: kein zweites PUT
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.requests("PUT")).toHaveLength(1);
    app.server.hold.delete("PUT");
    for (const r of app.server.releases.splice(0)) r();
    await settle();
    expect(field.value).toBe("");
  });

  test("Reiter verlassen während PUT: Feld sofort leer, späte Antwort holt nichts zurück", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    const field = app.input("OPENROUTER_API_KEY")!;
    type(field, NEW_OPENROUTER);
    app.server.hold.add("PUT");
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    app.view.show("modelle");
    expect(field.value).toBe("");
    for (const r of app.server.releases.splice(0)) r();
    await settle();
    expect(field.value).toBe("");
    app.view.show("schluessel");
    await settle();
    expect(app.input("OPENROUTER_API_KEY")).toBeUndefined();
    expect(leaks(NEW_OPENROUTER)).toEqual([]);
    // Frisch geladen: gesetzt, Neustart ausstehend
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("gesetzt ••••" + NEW_OPENROUTER.slice(-4));
  });

  test("Reiterwechsel vor dem Schreiben, alte Liste geladen: PUT-Erfolg zeigt gesetzt und Neustart", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    const field = app.input("OPENROUTER_API_KEY")!;
    type(field, NEW_OPENROUTER);
    // PUT hält vor dem Schreiben in die .env an
    app.server.holdBefore.add("PUT");
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.server.file.has("OPENROUTER_API_KEY")).toBe(false);
    app.view.show("modelle");
    app.view.show("schluessel");
    await settle();
    // Die neu geladene Liste kennt den Wert noch nicht
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("fehlt");
    expect(app.byKey("key-restart")).toBeUndefined();
    app.server.holdBefore.delete("PUT");
    for (const r of app.server.releases.splice(0)) r();
    await settle();
    expect(app.server.file.get("OPENROUTER_API_KEY")).toBe(NEW_OPENROUTER);
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("gesetzt ••••" + NEW_OPENROUTER.slice(-4));
    // Feld bleibt leer und verworfen, der Neustart wird angeboten
    expect(field.value).toBe("");
    expect(app.input("OPENROUTER_API_KEY")).toBeUndefined();
    expect(app.byKey("key-restart")).toBeDefined();
    expect(leaks(NEW_OPENROUTER)).toEqual([]);
  });

  test("erster PUT verzögert, zweiter PUT scheitert (400): erster Erfolg zeigt gesetzt und Neustart", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    type(app.input("OPENROUTER_API_KEY")!, NEW_OPENROUTER);
    app.server.holdBefore.add("PUT");
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    app.view.show("modelle");
    app.view.show("schluessel");
    await settle();
    app.server.holdBefore.delete("PUT");
    // Zweiter Versuch mit ungültigem Wert
    app.click("key-edit:OPENROUTER_API_KEY");
    const second = app.input("OPENROUTER_API_KEY")!;
    const bad = "platzhalter\u0007mit-steuerzeichen";
    type(second, bad);
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.requests("PUT")).toHaveLength(2);
    expect(app.panelText()).toContain("Steuerzeichen sind im Wert nicht erlaubt");
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("fehlt");
    // Erst jetzt schreibt der erste PUT
    for (const r of app.server.releases.splice(0)) r();
    await settle();
    expect(app.server.file.get("OPENROUTER_API_KEY")).toBe(NEW_OPENROUTER);
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("gesetzt ••••" + NEW_OPENROUTER.slice(-4));
    expect(app.byKey("key-restart")).toBeDefined();
    // Die neuere Eingabe bleibt, wie sie ist; der erste Wert kommt nicht zurück
    expect(app.input("OPENROUTER_API_KEY")).toBe(second);
    expect(second.value).toBe(bad);
    expect(leaks(NEW_OPENROUTER)).toEqual([]);
  });

  test("ein älterer Erfolg überschreibt keinen neueren", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    type(app.input("OPENROUTER_API_KEY")!, NEW_OPENROUTER);
    app.server.hold.add("PUT");
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    app.view.show("modelle");
    app.view.show("schluessel");
    await settle();
    app.server.hold.delete("PUT");
    const newer = "platzhalter-neuerer-wert-ab12cd";
    app.click("key-edit:OPENROUTER_API_KEY");
    type(app.input("OPENROUTER_API_KEY")!, newer);
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("gesetzt ••••" + newer.slice(-4));
    // Die späte Antwort des ersten PUT kommt erst jetzt
    for (const r of app.server.releases.splice(0)) r();
    await settle();
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("gesetzt ••••" + newer.slice(-4));
    expect(leaks(newer)).toEqual([]);
  });

  test("zweiter PUT speichert vor dem ersten: Anzeige folgt dem gespeicherten Stand", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    type(app.input("OPENROUTER_API_KEY")!, NEW_OPENROUTER);
    // Erster PUT hält vor dem Schreiben in die .env an
    app.server.holdBefore.add("PUT");
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    app.view.show("modelle");
    app.view.show("schluessel");
    await settle();
    app.server.holdBefore.delete("PUT");
    const newer = "platzhalter-neuerer-wert-ef34gh";
    app.click("key-edit:OPENROUTER_API_KEY");
    type(app.input("OPENROUTER_API_KEY")!, newer);
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.server.file.get("OPENROUTER_API_KEY")).toBe(newer);
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("gesetzt ••••" + newer.slice(-4));
    // Jetzt schreibt der erste PUT, also zuletzt
    for (const r of app.server.releases.splice(0)) r();
    await settle();
    const stored = app.server.file.get("OPENROUTER_API_KEY")!;
    expect(stored).toBe(NEW_OPENROUTER);
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("gesetzt ••••" + stored.slice(-4));
    expect(app.rowText("OPENROUTER_API_KEY")).not.toContain("gesetzt ••••" + newer.slice(-4));
    expect(app.byKey("key-restart")).toBeDefined();
    // Kein Feld wieder geöffnet, kein Wert zurückgeholt
    expect(app.input("OPENROUTER_API_KEY")).toBeUndefined();
    expect(leaks(NEW_OPENROUTER)).toEqual([]);
    expect(leaks(newer)).toEqual([]);
  });

  test("überlappende PUTs, neuere Eingabe offen: Abgleich lässt das Feld unberührt", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    type(app.input("OPENROUTER_API_KEY")!, NEW_OPENROUTER);
    app.server.holdBefore.add("PUT");
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    app.view.show("modelle");
    app.view.show("schluessel");
    await settle();
    app.server.holdBefore.delete("PUT");
    const newer = "platzhalter-neuerer-wert-ij56kl";
    app.click("key-edit:OPENROUTER_API_KEY");
    type(app.input("OPENROUTER_API_KEY")!, newer);
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    // Dritte Eingabe, noch nicht gespeichert
    app.click("key-edit:OPENROUTER_API_KEY");
    const third = app.input("OPENROUTER_API_KEY")!;
    type(third, "platzhalter-dritter-wert-mn78op");
    for (const r of app.server.releases.splice(0)) r();
    await settle();
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("gesetzt ••••" + NEW_OPENROUTER.slice(-4));
    expect(app.input("OPENROUTER_API_KEY")).toBe(third);
    expect(third.value).toBe("platzhalter-dritter-wert-mn78op");
    expect(app.requests("PUT")).toHaveLength(2);
  });

  test("Abgleich nach überlappenden PUTs bleibt fällig, wenn ein anderer Schlüssel ihn überholt", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    type(app.input("OPENROUTER_API_KEY")!, NEW_OPENROUTER);
    app.server.holdBefore.add("PUT");
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    app.view.show("modelle");
    app.view.show("schluessel");
    await settle();
    app.server.holdBefore.delete("PUT");
    const newer = "platzhalter-neuerer-wert-qr90st";
    app.click("key-edit:OPENROUTER_API_KEY");
    type(app.input("OPENROUTER_API_KEY")!, newer);
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("gesetzt ••••" + newer.slice(-4));
    // Offene neuere Eingabe
    app.click("key-edit:OPENROUTER_API_KEY");
    const third = app.input("OPENROUTER_API_KEY")!;
    type(third, "platzhalter-dritter-wert-uv12wx");
    // Erster PUT schreibt zuletzt, die abschließende Liste wird zurückgehalten
    app.server.hold.add("GET");
    for (const r of app.server.releases.splice(0)) r();
    await settle();
    expect(app.server.file.get("OPENROUTER_API_KEY")).toBe(NEW_OPENROUTER);
    app.server.hold.delete("GET");
    const heldGet = app.server.releases.splice(0);
    expect(heldGet).toHaveLength(1);
    // Ein anderer Schlüssel wird erfolgreich gespeichert
    app.click("key-edit:ANTHROPIC_API_KEY");
    type(app.input("ANTHROPIC_API_KEY")!, NEW_ANTHROPIC);
    app.click("key-save:ANTHROPIC_API_KEY");
    await settle();
    expect(app.server.file.get("ANTHROPIC_API_KEY")).toBe(NEW_ANTHROPIC);
    // Jetzt kommt die zurückgehaltene Liste; sie ist überholt, der Abgleich läuft erneut
    for (const r of heldGet) r();
    await settle();
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("gesetzt ••••" + NEW_OPENROUTER.slice(-4));
    expect(app.rowText("OPENROUTER_API_KEY")).not.toContain("gesetzt ••••" + newer.slice(-4));
    expect(app.rowText("ANTHROPIC_API_KEY")).toContain("gesetzt ••••" + NEW_ANTHROPIC.slice(-4));
    expect(app.input("OPENROUTER_API_KEY")).toBe(third);
    expect(third.value).toBe("platzhalter-dritter-wert-uv12wx");
    expect(app.byKey("key-restart")).toBeDefined();
    expect(leaks(NEW_OPENROUTER)).toEqual([]);
    expect(leaks(newer)).toEqual([]);
    expect(leaks(NEW_ANTHROPIC)).toEqual([]);
  });

  test("Einstellungen schließen (hide) und Reiterwechsel leeren offene Felder", async () => {
    const app = await openKeys();
    app.click("key-edit:OPENROUTER_API_KEY");
    const a = app.input("OPENROUTER_API_KEY")!;
    type(a, NEW_OPENROUTER);
    app.view.hide();
    expect(a.value).toBe("");
    app.view.show("schluessel");
    await settle();
    expect(app.input("OPENROUTER_API_KEY")).toBeUndefined();
    app.click("key-edit:ANTHROPIC_API_KEY");
    const b = app.input("ANTHROPIC_API_KEY")!;
    type(b, NEW_ANTHROPIC);
    app.view.show("status");
    await settle();
    expect(b.value).toBe("");
    expect(app.requests("PUT")).toEqual([]);
    expect(leaks(NEW_OPENROUTER)).toEqual([]);
    expect(leaks(NEW_ANTHROPIC)).toEqual([]);
  });

  test("eine spät ankommende Liste setzt den gespeicherten Stand nicht zurück", async () => {
    const app = await openKeys();
    app.server.hold.add("GET");
    app.click("keys-refresh");
    await settle();
    app.server.hold.delete("GET");
    app.click("key-edit:OPENROUTER_API_KEY");
    type(app.input("OPENROUTER_API_KEY")!, NEW_OPENROUTER);
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    for (const r of app.server.releases.splice(0)) r();
    await settle();
    expect(app.rowText("OPENROUTER_API_KEY")).toContain("gesetzt ••••" + NEW_OPENROUTER.slice(-4));
  });
});

describe("Reiter „Schlüssel\": Entfernen", () => {
  test("Rückfrage, Abbrechen ohne DELETE, Bestätigen genau ein DELETE ohne Body", async () => {
    const app = await openKeys();
    app.click("key-remove:ANTHROPIC_API_KEY");
    expect(app.rowText("ANTHROPIC_API_KEY")).toContain("ANTHROPIC_API_KEY aus der .env entfernen?");
    expect(app.byKey("key-remove-no:ANTHROPIC_API_KEY")!.focused).toBe(1);
    app.click("key-remove-no:ANTHROPIC_API_KEY");
    await settle();
    expect(app.requests("DELETE")).toEqual([]);
    expect(app.rowButtons("ANTHROPIC_API_KEY")).toEqual(["Ersetzen", "Entfernen"]);
    app.click("key-remove:ANTHROPIC_API_KEY");
    const yes = app.byKey("key-remove-yes:ANTHROPIC_API_KEY")!;
    yes.dispatch("click");
    yes.dispatch("click");
    await settle();
    expect(app.requests("DELETE")).toEqual([{ method: "DELETE", path: "/api/keys/ANTHROPIC_API_KEY", body: undefined }]);
    expect(app.server.file.has("ANTHROPIC_API_KEY")).toBe(false);
    expect(app.rowText("ANTHROPIC_API_KEY")).toContain("fehlt");
    expect(app.rowText("ANTHROPIC_API_KEY")).toContain("Gelöscht. Wirksam nach einem Neustart.");
    expect(app.rowButtons("ANTHROPIC_API_KEY")).toEqual(["Setzen"]);
    expect(leaks(OLD_ANTHROPIC)).toEqual([]);
  });

  test("Entfernen scheitert (nicht mehr gesetzt, offline): Meldung, Liste neu", async () => {
    const app = await openKeys();
    app.click("key-remove:ANTHROPIC_API_KEY");
    app.server.file.delete("ANTHROPIC_API_KEY");
    app.click("key-remove-yes:ANTHROPIC_API_KEY");
    await settle();
    expect(app.rowText("ANTHROPIC_API_KEY")).toContain("Diese Variable ist nicht gesetzt");
    expect(app.requests("GET", "/api/keys")).toHaveLength(2);
    expect(app.rowText("ANTHROPIC_API_KEY")).toContain("fehlt");
    app.server.offline.add("DELETE");
    app.click("key-remove:EIGENER_WERT");
    app.click("key-remove-yes:EIGENER_WERT");
    await settle();
    expect(app.rowText("EIGENER_WERT")).toContain("Server nicht erreichbar, nichts geändert.");
    expect(app.server.file.has("EIGENER_WERT")).toBe(true);
  });

  test("Rückfrage und Feld schließen sich gegenseitig", async () => {
    const app = await openKeys();
    app.click("key-edit:ANTHROPIC_API_KEY");
    const field = app.input("ANTHROPIC_API_KEY")!;
    type(field, NEW_ANTHROPIC);
    app.click("key-cancel:ANTHROPIC_API_KEY");
    app.click("key-remove:ANTHROPIC_API_KEY");
    expect(app.input("ANTHROPIC_API_KEY")).toBeUndefined();
    app.click("key-remove-no:ANTHROPIC_API_KEY");
    app.click("key-remove:ANTHROPIC_API_KEY");
    app.view.show("status");
    await settle();
    app.view.show("schluessel");
    await settle();
    expect(app.byKey("key-remove-yes:ANTHROPIC_API_KEY")).toBeUndefined();
    expect(app.requests("DELETE")).toEqual([]);
  });
});

describe("Reiter „Schlüssel\": Neustart", () => {
  test("nach PUT Hinweis mit „Jetzt neu starten\"; POST /api/restart erst nach Klick, genau einmal", async () => {
    const app = await openKeys();
    expect(app.byKey("key-restart")).toBeUndefined();
    app.click("key-edit:OPENROUTER_API_KEY");
    type(app.input("OPENROUTER_API_KEY")!, NEW_OPENROUTER);
    app.click("key-save:OPENROUTER_API_KEY");
    await settle();
    expect(app.panelText()).toContain("Geänderte Schlüssel wirken erst nach einem Neustart von tybo.");
    expect(app.rowText("OPENROUTER_API_KEY").join(" ")).toContain("Neustart ausstehend");
    expect(app.requests("POST")).toEqual([]);
    const b = app.byKey("key-restart")!;
    b.dispatch("click");
    b.dispatch("click");
    await settle();
    expect(app.requests("POST")).toEqual([{ method: "POST", path: "/api/restart", body: undefined }]);
    expect(app.panelText()).toContain("Neustart angefordert.");
    expect(app.byKey("key-restart")).toBeUndefined();
  });

  test("nach DELETE ebenso", async () => {
    const app = await openKeys();
    app.click("key-remove:EIGENER_WERT");
    app.click("key-remove-yes:EIGENER_WERT");
    await settle();
    expect(app.byKey("key-restart")).toBeDefined();
    expect(app.requests("POST")).toEqual([]);
  });

  test("restartPending nach Neuladen: Hinweis ohne Änderung, kein automatischer Neustart", async () => {
    const app = await openKeys({ running: { ANTHROPIC_API_KEY: "platzhalter-lief-vorher-0000" } });
    expect(app.byKey("key-restart")).toBeDefined();
    expect(app.rowText("ANTHROPIC_API_KEY").join(" ")).toContain("Neustart ausstehend");
    for (const fn of [...app.timers.values()]) fn();
    await settle();
    expect(app.requests("POST")).toEqual([]);
  });

  test("Neustart abgelehnt: Fehlermeldung, Knopf bleibt", async () => {
    const app = await openKeys({ running: {} });
    app.server.restart = { status: 409, body: { error: "tybo läuft nicht unter launchd oder PM2. Bitte tybo manuell neu starten." } };
    app.click("key-restart");
    await settle();
    expect(app.panelText()).toContain("tybo läuft nicht unter launchd oder PM2.");
    expect(app.byKey("key-restart")).toBeDefined();
  });

  test("ohne Opt-in, aber abweichender .env: Neustart-Hinweis bleibt möglich", async () => {
    const app = await openKeys({ editAllowed: false, running: {} });
    expect(app.byKey("key-restart")).toBeDefined();
  });
});
