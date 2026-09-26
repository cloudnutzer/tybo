/**
 * Issue #66, Checkbox 4: Oberfläche des Einrichtungsmodus ohne Browser.
 * setup.js und setup-code.js laufen gegen eine DOM-Attrappe; setup.js spricht
 * über HTTP mit dem echten Einrichtungs-Server im temporären Projekt
 * (Anbieter und Befehle sind Attrappen). Geprüft wird jeder erzeugte Knoten:
 * Text, Attribute und value; nie innerHTML.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnvContent } from "../src/lib/env-file";
import { cleanup, FAKE, FULL_ENV, SECRETS } from "./setup-fixture";
import { CODE, login, PROFILE, startSetup, type Started } from "./setup-web-fixture";
import { TYBO_BRAND } from "./brand-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "setup", "public");
const setupSource = await readFile(resolve(publicDir, "setup.js"), "utf8");
const codeSource = await readFile(resolve(publicDir, "setup-code.js"), "utf8");

interface Node {
  tagName: string;
  children: Node[];
  attributes: Record<string, string>;
  [key: string]: any;
}

let htmlWrites: string[] = [];
let created: Node[] = [];
const elements: Record<string, Node> = {};

function node(tag = "div"): Node {
  const n: Node = {
    tagName: tag.toUpperCase(),
    children: [],
    attributes: {},
    className: "",
    textContent: "",
    hidden: false,
    disabled: false,
    checked: false,
    value: "",
    type: "",
    id: "",
    focused: 0,
    appendChild(child: Node) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...list: Node[]) {
      this.children = list;
    },
    setAttribute(name: string, value: string) { this.attributes[name] = String(value); },
    getAttribute(name: string) { return this.attributes[name] ?? null; },
    listeners: {} as Record<string, ((e: any) => unknown)[]>,
    addEventListener(type: string, fn: (e: any) => unknown) { (this.listeners[type] ??= []).push(fn); },
    async dispatch(type: string, event: any = {}) {
      for (const fn of this.listeners[type] ?? []) await fn({ preventDefault() {}, ...event });
    },
    focus() { this.focused++; },
    select() {},
  };
  Object.defineProperty(n, "innerHTML", { set(v: string) { htmlWrites.push(v); }, get() { return ""; } });
  created.push(n);
  return n;
}

const doc = {
  getElementById(id: string) { return (elements[id] ??= node()); },
  createElement(tag: string) { return node(tag); },
  createTextNode(text: string) { const t = node("#text"); t.textContent = text; return t; },
};

function all(root: Node | undefined): Node[] {
  if (!root) return [];
  return [root, ...root.children.flatMap(c => all(c))];
}

function reset() {
  htmlWrites = [];
  created = [];
  for (const k of Object.keys(elements)) delete elements[k];
}

async function settle() {
  for (let i = 0; i < 5; i++) await Bun.sleep(5);
}

const running: Started[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.server.stop();
});
afterAll(cleanup);

interface Sent { method: string; path: string; body: any }

async function openApp(options: { env?: string; profile?: string } = {}) {
  reset();
  const s = await startSetup(options);
  running.push(s);
  const cookie = await login(s);
  const sent: Sent[] = [];
  const navigations: string[] = [];
  let loggedOut = false;
  const api = async (method: string, path: string, body?: unknown) => {
    sent.push({ method, path, body });
    const res = await fetch(`${s.base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Origin: s.origin, Cookie: loggedOut ? "" : cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, ok: res.ok, data: await res.json().catch(() => null) };
  };
  const view = new Function("document", "window", `${setupSource}\nreturn createSetupView;`)(doc, { TYBO_BRAND })({
    api,
    navigate: (path: string) => navigations.push(path),
    scrollTop: () => {},
  });
  await view.start();
  await settle();

  const panel = () => elements["setup-panel"];
  const nav = () => elements["setup-steps"];
  const panelNodes = () => all(panel());
  const stepButtons = () => all(nav()).filter(n => n.tagName === "BUTTON");
  const button = (action: string) => panelNodes().find(n => n.tagName === "BUTTON" && n.attributes["data-action"] === action);
  const field = (name: string) => panelNodes().find(n => n.attributes["data-field"] === name);
  const input = (name: string) => panelNodes().find(n => n.id === `field-${name}`);
  const text = () => panelNodes().map(n => n.textContent).filter(Boolean).join("\n");
  const click = async (action: string) => {
    const b = button(action);
    if (!b) throw new Error(`Knopf ${action} fehlt`);
    await b.dispatch("click");
    await settle();
  };
  const openStep = async (id: string) => {
    await stepButtons().find(b => b.attributes["data-step"] === id)!.dispatch("click");
    await settle();
  };
  return { s, view, sent, navigations, panel, nav, stepButtons, button, field, input, text, click, openStep, logout: () => (loggedOut = true) };
}

/** Geheimnis irgendwo in erzeugten Knoten (Text, Attribute, value), außer in erlaubten Eingabefeldern */
function leaks(allowedInputs: Node[] = []): string[] {
  const found: string[] = [];
  for (const n of created) {
    const values = [n.textContent, ...Object.values(n.attributes)];
    if (!allowedInputs.includes(n)) values.push(n.value);
    for (const secret of [...SECRETS, FAKE.userId]) if (values.some(v => typeof v === "string" && v.includes(secret))) found.push(secret);
  }
  return found;
}

describe("Aufbau", () => {
  test("links alle Schritte mit Status, rechts der erste offene Pflichtschritt", async () => {
    const app = await openApp({ env: "" });
    const buttons = app.stepButtons();
    expect(buttons.map(b => b.attributes["data-step"])).toEqual([
      "voraussetzungen", "telegram", "gruppe", "datenbank", "profil", "modelle", "webui", "autostart", "pruefung",
    ]);
    expect(buttons[0].attributes["data-state"]).toBe("erledigt");
    expect(buttons[1].attributes["data-state"]).toBe("fehlt");
    expect(all(buttons[2]).map(n => n.textContent)).toContain("fehlt, optional");
    expect(buttons.filter(b => b.attributes["aria-current"] === "step").map(b => b.attributes["data-step"])).toEqual(["telegram"]);
    expect(app.view.state().current).toBe("telegram");
    expect(app.text()).toContain("Schritt 2 von 9");
    expect(app.text()).toContain("Noch kein Telegram-Bot eingerichtet.");
    expect(htmlWrites).toEqual([]);
  });

  test("Felder mit Hilfetext und Link; geheime Felder verdeckt, nie vorausgefüllt, auch wenn gesetzt", async () => {
    const app = await openApp({ env: FULL_ENV, profile: PROFILE });
    await app.openStep("telegram");
    const token = app.input("TELEGRAM_BOT_TOKEN")!;
    expect(token.type).toBe("password");
    expect(token.attributes.autocomplete).toBe("new-password");
    expect(token.value).toBe("");
    expect(token.attributes.placeholder).toBe("Gesetzt. Leer lassen, um den Wert zu behalten.");
    const userId = app.input("TELEGRAM_USER_ID")!;
    expect(userId.type).toBe("text");
    expect(userId.value).toBe("");
    expect(app.text()).toContain("@userinfobot anschreiben");
    const link = all(app.field("TELEGRAM_BOT_TOKEN")).find(n => n.tagName === "A")!;
    expect(link.href).toBe("https://t.me/BotFather");
    expect(link.rel).toBe("noopener noreferrer");
    expect(all(app.field("TELEGRAM_BOT_TOKEN")).map(n => n.textContent)).toContain("gesetzt");
    expect(app.button("apply")!.textContent).toBe("Speichern");
    expect(app.button("test")!.textContent).toBe("Testen");
    for (const id of ["voraussetzungen", "gruppe", "datenbank", "profil", "modelle", "webui", "autostart", "pruefung"]) await app.openStep(id);
    expect(leaks()).toEqual([]);
    expect(htmlWrites).toEqual([]);
  });
});

describe("Testen und Speichern", () => {
  test("Telegram: Testen zeigt das Ergebnis, Speichern schreibt die .env und markiert den Schritt", async () => {
    const app = await openApp({ env: "" });
    app.input("TELEGRAM_BOT_TOKEN")!.value = FAKE.token;
    app.input("TELEGRAM_USER_ID")!.value = FAKE.userId;
    const typed = [app.input("TELEGRAM_BOT_TOKEN")!, app.input("TELEGRAM_USER_ID")!];

    await app.click("test");
    expect(app.text()).toContain("Verbunden mit @test_bot. Testnachricht verschickt.");
    expect(app.sent.at(-1)).toEqual({ method: "POST", path: "/api/setup/steps/telegram/test", body: { values: { TELEGRAM_BOT_TOKEN: FAKE.token, TELEGRAM_USER_ID: FAKE.userId } } });

    await app.click("apply");
    const env = parseEnvContent(await readFile(app.s.ctx.envPath, "utf8"));
    expect(env.TELEGRAM_BOT_TOKEN).toBe(FAKE.token);
    expect(app.text()).toContain("Gespeichert.");
    expect(app.text()).toContain("Token und Nutzer-ID sind gesetzt.");
    expect(app.stepButtons().find(b => b.attributes["data-step"] === "telegram")!.attributes["data-state"]).toBe("erledigt");
    // Neu aufgebaut: Felder wieder leer, nur „gesetzt“
    expect(app.input("TELEGRAM_BOT_TOKEN")!.value).toBe("");
    expect(leaks(typed)).toEqual([]);
  });

  test("Fehler beim Speichern: Meldung ohne Wert, Eingaben bleiben stehen", async () => {
    const app = await openApp({ env: "" });
    app.input("TELEGRAM_BOT_TOKEN")!.value = "kein-token-geheim";
    await app.click("apply");
    expect(app.text()).toContain("Bot-Token hat nicht das erwartete Format");
    expect(app.text()).not.toContain("kein-token-geheim");
    expect(app.input("TELEGRAM_BOT_TOKEN")!.value).toBe("kein-token-geheim");
  });

  test("Weiter öffnet den nächsten Schritt", async () => {
    const app = await openApp({ env: "" });
    await app.click("next");
    expect(app.view.state().current).toBe("gruppe");
    expect(app.text()).toContain("optional");
  });

  test("Sichtbarkeit: Auswahl der Datenbank blendet Felder um; geheime Felder gehen nur als Name hin", async () => {
    const app = await openApp({ env: "" });
    await app.openStep("datenbank");
    expect(app.field("CONVEX_URL")!.hidden).toBe(true);
    expect(app.field("SUPABASE_URL")!.hidden).toBe(true);
    const select = app.input("DB_BACKEND")!;
    expect(select.tagName).toBe("SELECT");
    select.value = "supabase";
    app.input("SUPABASE_SERVICE_ROLE_KEY")!.value = FAKE.serviceKey;
    await select.dispatch("change");
    await settle();
    expect(app.field("SUPABASE_URL")!.hidden).toBe(false);
    expect(app.field("SUPABASE_SERVICE_ROLE_KEY")!.hidden).toBe(false);
    expect(app.field("CONVEX_URL")!.hidden).toBe(true);
    const viewCall = app.sent.find(r => r.path.endsWith("/view"))!;
    // Seit Issue #163 hat der Schritt einen Ablauf: Text geht mit, geheime Felder nur als Name in present
    expect(viewCall.body).toEqual({
      values: { DB_BACKEND: "supabase", SUPABASE_PROJECT_NAME: "tybo", SUPABASE_REGION: "eu-central-1" },
      present: ["SUPABASE_SERVICE_ROLE_KEY"],
    });
    expect(JSON.stringify(viewCall.body)).not.toContain(FAKE.serviceKey);
  });

  test("Autostart: kein Speichern, Hinweis auf „Fertig“", async () => {
    const app = await openApp({ env: "" });
    await app.openStep("autostart");
    expect(app.button("apply")).toBeUndefined();
    expect(app.button("test")).toBeDefined();
    expect(app.text()).toContain("Den Autostart richtet tybo erst bei „Fertig“ ein.");
  });
});

describe("Fertig", () => {
  test("fehlen Pflichtschritte, ist „Fertig“ gesperrt und nennt sie", async () => {
    const app = await openApp({ env: "" });
    await app.openStep("pruefung");
    expect(app.button("finish")!.disabled).toBe(true);
    expect(app.text()).toContain("Vor „Fertig“ fehlt noch: Telegram, Datenbank, Profil.");
  });

  test("alles erledigt: Fertig zeigt den Startbefehl, sperrt die Schritte; der Code gilt nicht mehr", async () => {
    const app = await openApp({ env: FULL_ENV, profile: PROFILE });
    expect(app.view.state().current).toBe("autostart");
    await app.openStep("pruefung");
    // Offene optionale Schritte und Autostart: neutral, kein Fehlerzeichen
    const optionalRow = all(app.panel()).find(n => n.tagName === "LI" && n.attributes["data-optional"] === "true")!;
    expect(all(optionalRow).map(n => n.textContent)).toContain("–");
    expect(all(app.panel()).filter(n => n.tagName === "LI" && n.attributes["data-ok"] === "false" && !n.attributes["data-optional"])).toEqual([]);
    const autostart = all(app.panel()).find(n => n.id === "setup-autostart")!;
    expect(autostart.type).toBe("checkbox");
    expect(autostart.checked).toBe(false);
    expect(app.button("finish")!.disabled).toBe(false);
    await app.click("finish");
    expect(app.sent.at(-1)).toEqual({ method: "POST", path: "/api/setup/finish", body: { autostart: false } });
    expect(app.text()).toContain("Einrichtung abgeschlossen");
    expect(app.text()).toContain(`cd ${app.s.ctx.root} && bun run start`);
    expect(app.text()).toContain("Der Einmal-Code gilt jetzt nicht mehr.");
    expect(app.stepButtons().every(b => b.disabled)).toBe(true);
    expect(app.s.server.isFinished()).toBe(true);
    expect(app.navigations).toEqual([]);
    const again = await fetch(`${app.s.base}/api/setup/code`, { method: "POST", headers: { Origin: app.s.origin }, body: JSON.stringify({ code: CODE }) });
    expect(again.status).toBe(401);
  });

  test("abgemeldet (401): zurück zur Code-Seite", async () => {
    const app = await openApp({ env: "" });
    app.logout();
    await app.openStep("gruppe");
    expect(app.navigations).toEqual(["/code"]);
  });
});

describe("Code-Seite", () => {
  function codePage(reply: (body: any) => { status: number; body?: any } | Error) {
    reset();
    const form = doc.getElementById("code-form");
    const input = doc.getElementById("code");
    const errorBox = doc.getElementById("code-error");
    errorBox.hidden = true;
    const location = { href: "/code" };
    const bodies: any[] = [];
    const fetchStub = async (_path: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      const r = reply(JSON.parse(init.body));
      if (r instanceof Error) throw r;
      return { ok: r.status === 200, status: r.status, json: async () => r.body ?? {} };
    };
    new Function("document", "window", "fetch", codeSource)(doc, { TYBO_BRAND, location }, fetchStub);
    const submit = async (value: string) => {
      input.value = value;
      await form.dispatch("submit");
    };
    return { submit, errorBox, location, bodies };
  }

  test("leer, falsch, gesperrt, abgeschlossen, nicht erreichbar: klare Meldungen", async () => {
    const cases: Array<[any, string]> = [
      [{ status: 401 }, "Falscher Code."],
      [{ status: 429 }, "Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen."],
      [{ status: 401, body: { finished: true } }, "Die Einrichtung ist abgeschlossen. Der Code gilt nicht mehr."],
      [new TypeError("offline"), "tybo ist nicht erreichbar. Läuft die Einrichtung noch?"],
    ];
    for (const [reply, message] of cases) {
      const page = codePage(() => reply);
      await page.submit("K7MP-2QXR");
      expect(page.errorBox.textContent).toBe(message);
      expect(page.errorBox.hidden).toBe(false);
      expect(page.location.href).toBe("/code");
    }
    const empty = codePage(() => ({ status: 200 }));
    await empty.submit("   ");
    expect(empty.errorBox.textContent).toBe("Bitte den Code aus dem Terminal eingeben.");
    expect(empty.bodies).toEqual([]);
  });

  test("richtiger Code: weiter zum Assistenten", async () => {
    const page = codePage(() => ({ status: 200 }));
    await page.submit("k7mp-2qxr");
    expect(page.bodies).toEqual([{ code: "k7mp-2qxr" }]);
    expect(page.location.href).toBe("/");
    expect(htmlWrites).toEqual([]);
  });
});

describe("Seiten ohne Inline-Skripte", () => {
  test("setup.html und setup-code.html laden nur Dateien, keine Inline-Skripte oder -Stile", async () => {
    for (const file of ["setup.html", "setup-code.html"]) {
      const html = await readFile(resolve(publicDir, file), "utf8");
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(html).not.toMatch(/\son[a-z]+=/i);
      expect(html).not.toMatch(/<style|style=/);
    }
  });
});
