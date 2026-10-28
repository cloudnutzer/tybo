/**
 * Service Worker, Teil Web Push (Issue #225), ohne Browser mit Attrappen für
 * self, registration und clients: push zeigt immer eine Benachrichtigung
 * (auch bei leerer oder kaputter Nutzlast) und wartet per waitUntil;
 * notificationclick öffnet nur Adressen der eigenen Seite und führt ein
 * offenes Fenster dorthin; pushsubscriptionchange meldet das neue Abo mit
 * dem alten Endpunkt, Fehler bleiben still.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BRAND } from "../src/brand";
import { renderServiceWorker } from "../src/web/service-worker";

const template = await readFile(join(resolve(import.meta.dir, "..", "src", "web", "public"), "sw.js"), "utf8");
const ORIGIN = "https://app.example.org";

interface FakeClient {
  url: string;
  focused: boolean;
  focusCalls: number;
  navigated: string[];
  messages: unknown[];
  postMessage(message: unknown): void;
  focus(): Promise<FakeClient>;
  navigate(url: string): Promise<FakeClient>;
}

/** ack: antwortet wie die Chat-App auf dem Kanal; ohne ack schweigt das Fenster (Offline-Seite, Login) */
function client(url: string, focused = false, ack = false): FakeClient {
  return {
    url,
    focused,
    focusCalls: 0,
    navigated: [],
    messages: [],
    postMessage(message: unknown, ports?: MessagePort[]) {
      this.messages.push(message);
      if (ack) ports?.[0]?.postMessage({ type: "open-conversation-ack" });
    },
    async focus() { this.focusCalls++; return this; },
    async navigate(u: string) { this.navigated.push(u); this.url = u; return this; },
  };
}

function load(options: { windows?: FakeClient[]; fetch?: (url: string, init: any) => Promise<Response>; openWindow?: (url: string) => Promise<unknown> } = {}) {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const shown: { title: string; options: any }[] = [];
  const opened: string[] = [];
  const fetched: { url: string; init: any }[] = [];
  const subscribed: any[] = [];
  const windows = options.windows ?? [];
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener(type: string, fn: (e: any) => void) { (listeners[type] ??= []).push(fn); },
    skipWaiting() { return Promise.resolve(); },
    registration: {
      async showNotification(title: string, opts: any) { shown.push({ title, options: opts }); },
      pushManager: {
        async subscribe(opts: any) {
          subscribed.push(opts);
          return { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/neu", keys: { p256dh: "p", auth: "a" } }) };
        },
      },
    },
    clients: {
      async matchAll() { return windows; },
      async openWindow(url: string) { opened.push(url); return options.openWindow ? options.openWindow(url) : client(url); },
    },
  };
  const fetchFake = async (url: string, init: any) => {
    fetched.push({ url, init });
    return options.fetch ? options.fetch(url, init) : new Response("{}", { status: 200 });
  };
  new Function("self", "caches", "fetch", renderServiceWorker(template, "0123456789abcdef"))(self, {}, fetchFake);

  async function dispatch(type: string, event: any) {
    const waits: Promise<unknown>[] = [];
    let waited = 0;
    for (const fn of listeners[type] ?? []) fn({ ...event, waitUntil: (p: Promise<unknown>) => { waited++; waits.push(p); } });
    await Promise.all(waits);
    return waited;
  }
  return { dispatch, shown, opened, fetched, subscribed };
}

function data(value: unknown) {
  return { json: () => (typeof value === "string" ? JSON.parse(value) : value) };
}

describe("push", () => {
  test("zeigt Titel, Text, Symbol, tag und Ziel, mit waitUntil", async () => {
    const sw = load();
    const waited = await sw.dispatch("push", { data: data({ title: "Recherche", body: "Fertig", tag: "c-1", url: "/#/c/1" }) });
    expect(waited).toBe(1);
    expect(sw.shown).toEqual([{
      title: "Recherche",
      options: { body: "Fertig", icon: "/icon-192.png", badge: "/icon-192.png", data: { url: `${ORIGIN}/#/c/1` }, tag: "c-1", renotify: true },
    }]);
  });

  test.each([
    ["ohne Nutzlast", null],
    ["kaputtes JSON", "{kaputt"],
    ["kein Objekt", "42"],
    ["falsche Typen", { title: 5, body: ["x"], url: 7 }],
  ])("%s: trotzdem eine Benachrichtigung mit Namen und allgemeinem Text", async (_label, payload) => {
    const sw = load();
    await sw.dispatch("push", { data: payload === null ? null : data(payload) });
    expect(sw.shown.length).toBe(1);
    expect(sw.shown[0].title).toBe(BRAND.name);
    expect(sw.shown[0].options.body).toBe("Neue Nachricht");
    expect(sw.shown[0].options.data.url).toBe(`${ORIGIN}/`);
    expect(sw.shown[0].options.tag).toBeUndefined();
  });

  test.each([
    "https://evil.example/x",
    "//evil.example/x",
    "/\\evil.example",
    "javascript:alert(1)",
  ])("fremdes Ziel %s wird zur Startseite", async url => {
    const sw = load();
    await sw.dispatch("push", { data: data({ title: "x", url }) });
    expect(sw.shown[0].options.data.url).toBe(`${ORIGIN}/`);
  });

  test("lange Texte werden gekürzt, Steuerzeichen entfernt", async () => {
    const sw = load();
    await sw.dispatch("push", { data: data({ title: "a\u0000b" + "t".repeat(300), body: "x".repeat(900) }) });
    expect(sw.shown[0].title.length).toBe(120);
    expect(sw.shown[0].title.startsWith("a b")).toBe(true);
    expect(sw.shown[0].options.body.length).toBe(500);
  });
});

describe("notificationclick", () => {
  function click(url: unknown) {
    let closed = 0;
    return { event: { notification: { data: { url }, close() { closed++; } } }, closed: () => closed };
  }

  test("kein Fenster offen: öffnet das Ziel", async () => {
    const sw = load();
    const c = click(`${ORIGIN}/#/einstellungen/benachrichtigungen`);
    await sw.dispatch("notificationclick", c.event);
    expect(c.closed()).toBe(1);
    expect(sw.opened).toEqual([`${ORIGIN}/#/einstellungen/benachrichtigungen`]);
  });

  test("offenes Fenster wird zum Ziel geführt und nach vorn geholt, kein neues", async () => {
    const win = client(`${ORIGIN}/#/c/alt`);
    const sw = load({ windows: [client("https://andere.example/"), win] });
    await sw.dispatch("notificationclick", click(`${ORIGIN}/#/c/neu`).event);
    expect(win.navigated).toEqual([`${ORIGIN}/#/c/neu`]);
    expect(win.focusCalls).toBe(1);
    expect(sw.opened).toEqual([]);
  });

  test("fremde Adresse in den Daten: nur die eigene Startseite", async () => {
    const sw = load();
    await sw.dispatch("notificationclick", click("https://evil.example/phish").event);
    expect(sw.opened).toEqual([`${ORIGIN}/`]);
  });
});

describe("Push von selbst (Issue #226)", () => {
  const WEB_ID = "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e";

  test("Kategorie, Gespräch und Frage-Kennung landen geprüft in data", async () => {
    const sw = load();
    await sw.dispatch("push", { data: data({ title: "tybo fragt nach", body: "Werkzeug-Freigabe", tag: `c-${WEB_ID}`, url: `/#/gespraech/${WEB_ID}`, category: "choice", conversationId: WEB_ID, choiceId: "q1" }) });
    expect(sw.shown[0].options.data).toEqual({ url: `${ORIGIN}/#/gespraech/${WEB_ID}`, category: "choice", conversationId: WEB_ID, choiceId: "q1" });
    await sw.dispatch("push", { data: data({ title: "x", category: "anders", conversationId: "../x", choiceId: "q1" }) });
    expect(sw.shown[1].options.data).toEqual({ url: `${ORIGIN}/` });
    // Frage-Kennung nur bei Rückfragen
    await sw.dispatch("push", { data: data({ title: "x", category: "reply", conversationId: "dm", choiceId: "q1" }) });
    expect(sw.shown[2].options.data).toEqual({ url: `${ORIGIN}/`, category: "reply", conversationId: "dm" });
  });

  function click(conversationId: string) {
    return { notification: { data: { url: `${ORIGIN}/#/gespraech/${conversationId}`, conversationId, category: "reply" }, close() {} } };
  }

  test("offenes App-Fenster: Gespräch per Nachricht wechseln und nach vorn holen, nicht neu laden", async () => {
    const win = client(`${ORIGIN}/`, false, true);
    const sw = load({ windows: [win] });
    await sw.dispatch("notificationclick", click("topic-5"));
    expect(win.messages).toEqual([{ type: "open-conversation", conversationId: "topic-5" }]);
    expect(win.navigated).toEqual([]);
    expect(win.focusCalls).toBe(1);
    expect(sw.opened).toEqual([]);
  });

  test("Offline-Seite unter / (keine Bestätigung): Fenster lädt ganz neu mit dem Gesprächslink, kein reiner Hash-Wechsel", async () => {
    const offline = client(`${ORIGIN}/`);
    const sw = load({ windows: [offline] });
    await sw.dispatch("notificationclick", click("topic-5"));
    expect(offline.messages).toEqual([{ type: "open-conversation", conversationId: "topic-5" }]);
    expect(offline.navigated).toEqual([`${ORIGIN}/?#/gespraech/topic-5`]);
    expect(offline.focusCalls).toBeGreaterThanOrEqual(1);
    expect(sw.opened).toEqual([]);
    // Schon unter /? (etwa nach dem letzten Versuch): dann wieder /
    const again = client(`${ORIGIN}/?#/gespraech/topic-5`);
    await load({ windows: [again] }).dispatch("notificationclick", click("dm"));
    expect(again.navigated).toEqual([`${ORIGIN}/#/gespraech/dm`]);
  });

  test("ohne Bestätigung und ohne navigate (nicht gesteuert): neues Fenster mit dem Gesprächslink", async () => {
    const offline = client(`${ORIGIN}/`);
    offline.navigate = async () => { throw new TypeError("not controlled"); };
    const sw = load({ windows: [offline] });
    await sw.dispatch("notificationclick", click(WEB_ID));
    expect(sw.opened).toEqual([`${ORIGIN}/#/gespraech/${WEB_ID}`]);
  });

  test("kein Fenster: öffnet /#/gespraech/<id>; nur die Login-Seite offen: dorthin führen (die Adresse übersteht die Anmeldung)", async () => {
    const none = load();
    await none.dispatch("notificationclick", click(WEB_ID));
    expect(none.opened).toEqual([`${ORIGIN}/#/gespraech/${WEB_ID}`]);
    const login = client(`${ORIGIN}/login`);
    const sw = load({ windows: [login] });
    await sw.dispatch("notificationclick", click("dm"));
    expect(login.messages).toEqual([]);
    expect(login.navigated).toEqual([`${ORIGIN}/#/gespraech/dm`]);
  });
});

describe("pushsubscriptionchange", () => {
  test("meldet das neue Abo mit altem Endpunkt an den Server", async () => {
    const sw = load();
    const newSubscription = { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/b", keys: { p256dh: "p", auth: "a" } }) };
    const waited = await sw.dispatch("pushsubscriptionchange", {
      oldSubscription: { endpoint: "https://fcm.googleapis.com/fcm/send/a" },
      newSubscription,
    });
    expect(waited).toBe(1);
    expect(sw.fetched.length).toBe(1);
    expect(sw.fetched[0].url).toBe("/api/push/subscriptions");
    expect(sw.fetched[0].init.method).toBe("POST");
    expect(sw.fetched[0].init.credentials).toBe("same-origin");
    expect(JSON.parse(sw.fetched[0].init.body)).toEqual({
      subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/b", keys: { p256dh: "p", auth: "a" } },
      previousEndpoint: "https://fcm.googleapis.com/fcm/send/a",
    });
  });

  test("ohne neues Abo: selbst neu abonnieren mit den alten Optionen", async () => {
    const sw = load();
    const options = { userVisibleOnly: true, applicationServerKey: new Uint8Array([4]) };
    await sw.dispatch("pushsubscriptionchange", { oldSubscription: { endpoint: "https://fcm.googleapis.com/fcm/send/a", options } });
    expect(sw.subscribed).toEqual([options]);
    expect(JSON.parse(sw.fetched[0].init.body).subscription.endpoint).toBe("https://fcm.googleapis.com/fcm/send/neu");
  });

  test("Netzfehler oder abgelaufene Anmeldung bleiben still (die Seite gleicht später ab)", async () => {
    const sw = load({ fetch: async () => { throw new TypeError("offline"); } });
    const newSubscription = { toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/b", keys: {} }) };
    await expect(sw.dispatch("pushsubscriptionchange", { newSubscription })).resolves.toBe(1);
  });
});

test("Name im Worker kommt aus src/brand.ts, unsichere Namen fallen auf den Befehl zurück", () => {
  expect(renderServiceWorker('"{{brand.name}}"', "", "tybo", "tybo")).toBe('"tybo"');
  expect(renderServiceWorker('"{{brand.name}}"', "", "tybo", 'x"; alert(1); "')).toBe('"tybo"');
});
