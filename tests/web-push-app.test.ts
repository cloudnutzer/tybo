/**
 * Reiter „Benachrichtigungen" (Issue #225, src/web/public/push.js) ohne
 * Browser: Attrappen für Notification, PushManager, Service Worker,
 * localStorage und api(). Geprüft: alle Zustände mit Erklärung statt totem
 * Schalter (kein sicherer Kontext, iPhone im Browser, blockiert, Server ohne
 * Schlüssel), Berechtigung nur nach dem Tipp auf „An", Einschalten, Test,
 * Ausschalten mit unsubscribe(), Umbenennen, andere Geräte entfernen, und
 * der Abgleich nach dem Laden: ein anderswo entferntes Gerät wird nicht still
 * neu angelegt. Dazu: ein abgelaufenes Abo (410) wird verworfen und frisch
 * abonniert, ein während des Tests erneuertes Abo bleibt, gescheitertes Ausschalten bleibt sichtbar und wird nachgeholt.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TYBO_BRAND } from "./brand-fixture";

const source = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "push.js"), "utf8");
const PUBLIC_KEY = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const THIRD = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

interface El {
  tag: string;
  props: Record<string, any>;
  children: El[];
  listeners: Record<string, (e?: any) => void>;
  addEventListener(type: string, fn: (e?: any) => void): void;
  appendChild(child: El): El;
  value?: string;
}

function h(tag: string, props: Record<string, any> = {}, children: (El | null)[] = []): El {
  const el: El = {
    tag,
    props,
    children: children.filter(Boolean) as El[],
    listeners: {},
    value: props.value,
    addEventListener(type, fn) { this.listeners[type] = fn; },
    appendChild(child) { this.children.push(child); return child; },
  };
  return el;
}

function sectionNode(id: string, title: string, _hints: string[], children: (El | null)[]): El {
  return h("section", { id, title }, children);
}

function all(nodes: El[]): El[] {
  return nodes.flatMap(n => [n, ...all(n.children)]);
}

function texts(nodes: El[]): string {
  return all(nodes).map(n => (n.props.text ?? "") + " " + (n.props.title ?? "")).join("\n");
}

function button(nodes: El[], label: string): El | undefined {
  return all(nodes).find(n => n.tag === "button" && n.props.text === label);
}

function load() {
  const window: any = { TYBO_BRAND };
  const api = new Function("window", "document", "atob", source + "\nreturn { pushEnvironment, pushViewState, createPushSettings, syncPushSubscription, PUSH_DEVICE_KEY, PUSH_OFF_PENDING_KEY, PUSH_TEXT };")(
    window, undefined, atob,
  );
  return { window, api };
}

interface FakeSub {
  endpoint: string;
  /** Versuche, sich abzumelden */
  unsubscribed: number;
  /** false nach erfolgreichem unsubscribe(): der Browser liefert es nicht mehr */
  active: boolean;
  /** unsubscribe() scheitert (wirft) */
  failUnsubscribe: boolean;
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
}

function fakeSubscription(endpoint = "https://fcm.googleapis.com/fcm/send/abc"): FakeSub {
  return {
    endpoint,
    unsubscribed: 0,
    active: true,
    failUnsubscribe: false,
    toJSON() { return { endpoint, keys: { p256dh: "P", auth: "A" }, expirationTime: null }; },
    async unsubscribe() {
      this.unsubscribed++;
      if (this.failUnsubscribe) throw new Error("abgelehnt");
      this.active = false;
      return true;
    },
  };
}

function browser(options: { secure?: boolean; ua?: string; standalone?: boolean; permission?: string; answer?: string; subscription?: FakeSub | null; supported?: boolean; storage?: Record<string, string> } = {}) {
  const store = new Map(Object.entries(options.storage ?? {}));
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  let current: FakeSub | null = options.subscription ?? null;
  const asked: string[] = [];
  const subscribeCalls: any[] = [];
  const Notification = {
    permission: options.permission ?? "default",
    async requestPermission() {
      asked.push("frage");
      Notification.permission = options.answer ?? "granted";
      return Notification.permission;
    },
  };
  const registration = {
    pushManager: {
      async getSubscription() { return current && current.active ? current : null; },
      async subscribe(opts: any) {
        subscribeCalls.push(opts);
        // Ein noch bestehendes Abo gibt der Browser zurück; sonst ein neues
        if (current && current.active) return current;
        current = fakeSubscription(subscribeCalls.length === 1 ? undefined : `https://fcm.googleapis.com/fcm/send/neu-${subscribeCalls.length}`);
        return current;
      },
    },
  };
  const supported = options.supported ?? true;
  const win: any = {
    isSecureContext: options.secure ?? true,
    navigator: {
      userAgent: options.ua ?? CHROME_UA,
      maxTouchPoints: 0,
      standalone: options.standalone ?? false,
      serviceWorker: supported ? { getRegistration: async () => registration, ready: Promise.resolve(registration) } : undefined,
    },
    matchMedia: () => ({ matches: options.standalone ?? false }),
    PushManager: supported ? function PushManager() {} : undefined,
    Notification: supported ? Notification : undefined,
  };
  return { win, storage, store, asked, subscribeCalls, current: () => current, setCurrent: (sub: FakeSub | null) => { current = sub; }, Notification };
}

function fakeApi(handlers: Record<string, (body: any) => { status: number; data: any }>) {
  const calls: { method: string; path: string; body: any }[] = [];
  const api = async (method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    const handler = handlers[`${method} ${path}`] ?? handlers[`${method} *`];
    if (!handler) throw new Error(`unerwartet: ${method} ${path}`);
    const { status, data } = handler(body);
    return { status, ok: status >= 200 && status < 300, data };
  };
  return { api, calls };
}

const DEVICE = { id: ID, name: "Mac · Chrome", createdAt: "2026-09-28T10:00:00.000Z", lastOkAt: null };
const OTHER_DEVICE = { id: OTHER, name: "iPhone · Safari", createdAt: "2026-09-27T10:00:00.000Z", lastOkAt: "2026-09-28T09:00:00.000Z" };

async function settings(b: ReturnType<typeof browser>, server: ReturnType<typeof fakeApi>) {
  const { api } = load();
  let renders = 0;
  const view = api.createPushSettings({ api: server.api, win: b.win, storage: b.storage, render: () => renders++, h, sectionNode });
  view.open();
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  return { view, nodes: () => view.nodes() as El[], renders: () => renders };
}

function getHandler(devices: unknown[], extra: Record<string, unknown> = {}) {
  return () => ({ status: 200, data: { available: true, publicKey: PUBLIC_KEY, devices, max: 20, ...extra } });
}

describe("Zustände", () => {
  test("pushViewState in der Reihenfolge des Browsers", () => {
    const { api } = load();
    const env = { secure: true, supported: true, ios: false, standalone: false, permission: "default" };
    expect(api.pushViewState(env, false, false)).toBe("server-off");
    expect(api.pushViewState({ ...env, secure: false }, true, false)).toBe("insecure");
    expect(api.pushViewState({ ...env, ios: true }, true, false)).toBe("ios-install");
    expect(api.pushViewState({ ...env, ios: true, standalone: true }, true, false)).toBe("off");
    expect(api.pushViewState({ ...env, supported: false }, true, false)).toBe("unsupported");
    expect(api.pushViewState({ ...env, permission: "denied" }, true, true)).toBe("denied");
    expect(api.pushViewState(env, true, true)).toBe("on");
  });

  test("iPad mit Desktop-Kennung zählt als iOS", () => {
    const { api } = load();
    const win = { isSecureContext: true, navigator: { userAgent: CHROME_UA.replace("Chrome/140.0 ", ""), maxTouchPoints: 5 }, matchMedia: () => ({ matches: false }) };
    expect(api.pushEnvironment(win).ios).toBe(true);
  });

  test.each([
    ["kein sicherer Kontext", { secure: false }, "https://"],
    ["iPhone im Browser", { ua: IPHONE_UA }, "Zum Home-Bildschirm"],
    ["Browser ohne Push", { supported: false }, "keine Benachrichtigungen empfangen"],
    ["blockiert", { permission: "denied" }, "blockiert"],
  ] as const)("%s: Erklärung statt Schalter", async (_label, options, expected) => {
    const b = browser(options);
    const s = await settings(b, fakeApi({ "GET /api/push": getHandler([OTHER_DEVICE]) }));
    const nodes = s.nodes();
    expect(texts(nodes)).toContain(expected);
    expect(all(nodes).some(n => n.props.role === "radiogroup")).toBe(false);
    expect(button(nodes, "Test senden")).toBeUndefined();
    // „Andere Geräte" bleibt sichtbar
    expect(texts(nodes)).toContain("iPhone · Safari");
    expect(b.asked).toEqual([]);
  });

  test("blockiert: Schritte für iPhone, Android und Rechner", async () => {
    const s = await settings(browser({ permission: "denied" }), fakeApi({ "GET /api/push": getHandler([]) }));
    const t = texts(s.nodes());
    expect(t).toContain("Einstellungen → Mitteilungen");
    expect(t).toContain("Benachrichtigungen → Zulassen");
    expect(t).toContain("neu laden");
  });

  test("Server ohne Schlüssel: sein Grund, kein Schalter, keine Geräteliste", async () => {
    const s = await settings(browser(), fakeApi({ "GET /api/push": () => ({ status: 200, data: { available: false, reason: "Push ist auf diesem Server nicht eingerichtet.", devices: [] } }) }));
    const nodes = s.nodes();
    expect(texts(nodes)).toContain("nicht eingerichtet");
    expect(all(nodes).some(n => n.props.role === "radiogroup")).toBe(false);
    expect(texts(nodes)).not.toContain("Andere Geräte");
  });
});

describe("Einschalten, Test, Ausschalten", () => {
  test("Laden fragt keine Berechtigung; „An\" fragt, abonniert mit dem Schlüssel und merkt sich das Gerät", async () => {
    const b = browser();
    const server = fakeApi({
      "GET /api/push": getHandler([]),
      "POST /api/push/subscriptions": () => ({ status: 201, data: { device: DEVICE } }),
      "POST /api/push/test": () => ({ status: 200, data: { ok: true } }),
      "DELETE *": () => ({ status: 200, data: { removed: true } }),
    });
    const s = await settings(b, server);
    expect(b.asked).toEqual([]);
    let nodes = s.nodes();
    expect(texts(nodes)).toContain("Aus: Dieses Gerät bekommt keine");
    button(nodes, "An")!.listeners.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(b.asked).toEqual(["frage"]);
    expect(b.subscribeCalls.length).toBe(1);
    expect(b.subscribeCalls[0].userVisibleOnly).toBe(true);
    expect(Buffer.from(b.subscribeCalls[0].applicationServerKey).toString("base64url")).toBe(PUBLIC_KEY);
    const post = server.calls.find(c => c.method === "POST" && c.path === "/api/push/subscriptions")!;
    expect(post.body).toEqual({ subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "P", auth: "A" } } });
    expect(b.store.get("tybo-push-device")).toBe(ID);
    nodes = s.nodes();
    expect(texts(nodes)).toContain("An: Dieses Gerät bekommt Benachrichtigungen.");
    expect(texts(nodes)).toContain("Mac · Chrome");

    button(nodes, "Test senden")!.listeners.click();
    await new Promise(r => setTimeout(r, 0));
    expect(server.calls.at(-1)).toEqual({ method: "POST", path: "/api/push/test", body: { id: ID, endpoint: "https://fcm.googleapis.com/fcm/send/abc" } });
    expect(texts(s.nodes())).toContain("Test gesendet");

    button(s.nodes(), "Aus")!.listeners.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(b.current()!.unsubscribed).toBe(1);
    expect(server.calls.at(-1)).toEqual({ method: "DELETE", path: `/api/push/subscriptions/${ID}`, body: undefined });
    expect(b.store.has("tybo-push-device")).toBe(false);
    expect(texts(s.nodes())).toContain("Aus: Dieses Gerät bekommt keine");
  });

  test("Frage weggeklickt: kein Abo, Hinweis zum erneuten Tippen", async () => {
    const b = browser({ answer: "default" });
    const server = fakeApi({ "GET /api/push": getHandler([]) });
    const s = await settings(b, server);
    await s.view.enable();
    expect(b.subscribeCalls).toEqual([]);
    expect(texts(s.nodes())).toContain("noch einmal „An\" tippen");
    expect(server.calls.filter(c => c.method === "POST")).toEqual([]);
  });

  test("Obergrenze erreicht: Meldung des Servers, Gerät nicht gemerkt", async () => {
    const b = browser();
    const s = await settings(b, fakeApi({
      "GET /api/push": getHandler([]),
      "POST /api/push/subscriptions": () => ({ status: 409, data: { error: "Höchstens 20 Geräte." } }),
    }));
    await s.view.enable();
    expect(texts(s.nodes())).toContain("Höchstens 20 Geräte.");
    expect(b.store.has("tybo-push-device")).toBe(false);
  });

  test("Test mit 410: Gerät weg, Schalter aus", async () => {
    const b = browser({ subscription: fakeSubscription(), storage: { "tybo-push-device": ID } });
    const s = await settings(b, fakeApi({
      "GET /api/push": getHandler([DEVICE]),
      "POST /api/push/test": () => ({ status: 410, data: { error: "Der Push-Dienst kennt dieses Gerät nicht mehr.", removed: true, subscriptionGone: true } }),
    }));
    expect(texts(s.nodes())).toContain("An: Dieses Gerät");
    await s.view.sendTest();
    expect(texts(s.nodes())).toContain("kennt dieses Gerät nicht mehr");
    expect(texts(s.nodes())).toContain("Aus: Dieses Gerät");
    expect(b.store.has("tybo-push-device")).toBe(false);
  });

  // Der Server meldet 404 und 410 des Push-Diensts beide so (tests/web-push-server.test.ts)
  test("Abo-Wechsel während des Tests (Server behält B, 409): Gerät, Kennung und neues Abo bleiben", async () => {
    const a = fakeSubscription("https://fcm.googleapis.com/fcm/send/a");
    const bSub = fakeSubscription("https://fcm.googleapis.com/fcm/send/b");
    const b = browser({ subscription: a, storage: { "tybo-push-device": ID } });
    const server = fakeApi({
      "GET /api/push": getHandler([DEVICE]),
      "POST /api/push/test": () => {
        // Während der Dienst noch an A liefert, erneuert der Browser auf B; der Server hat B schon
        b.setCurrent(bSub);
        return { status: 409, data: { error: "Das Abo dieses Geräts wurde gerade erneuert. Bitte den Test noch einmal senden.", removed: false } };
      },
    });
    const s = await settings(b, server);
    await s.view.sendTest();
    expect(server.calls.at(-1)).toEqual({ method: "POST", path: "/api/push/test", body: { id: ID, endpoint: a.endpoint } });
    expect(bSub.unsubscribed).toBe(0);
    expect(bSub.active).toBe(true);
    expect(b.current()).toBe(bSub);
    expect(b.store.get("tybo-push-device")).toBe(ID);
    expect(texts(s.nodes())).toContain("gerade erneuert");
    expect(texts(s.nodes())).toContain("An: Dieses Gerät");
  });

  test("410 für A, der Browser hat inzwischen B: Gerät weg, B wird nicht abgemeldet", async () => {
    const a = fakeSubscription("https://fcm.googleapis.com/fcm/send/a");
    const bSub = fakeSubscription("https://fcm.googleapis.com/fcm/send/b");
    const b = browser({ subscription: a, storage: { "tybo-push-device": ID } });
    const server = fakeApi({
      "GET /api/push": getHandler([DEVICE]),
      "POST /api/push/test": () => {
        b.setCurrent(bSub);
        return { status: 410, data: { error: "Der Push-Dienst kennt dieses Gerät nicht mehr.", removed: true, subscriptionGone: true } };
      },
    });
    const s = await settings(b, server);
    await s.view.sendTest();
    expect(bSub.unsubscribed).toBe(0);
    expect(bSub.active).toBe(true);
    expect(a.unsubscribed).toBe(0);
    expect(b.store.has("tybo-push-device")).toBe(false);
  });

  test("410 mit subscriptionGone false (Server hat ein anderes Abo entfernt): Browser-Abo bleibt", async () => {
    const current = fakeSubscription("https://fcm.googleapis.com/fcm/send/b");
    const b = browser({ subscription: current, storage: { "tybo-push-device": ID } });
    const s = await settings(b, fakeApi({
      "GET /api/push": getHandler([DEVICE]),
      "POST /api/push/test": () => ({ status: 410, data: { error: "Der Push-Dienst kennt dieses Gerät nicht mehr.", removed: true, subscriptionGone: false } }),
    }));
    await s.view.sendTest();
    expect(current.unsubscribed).toBe(0);
    expect(current.active).toBe(true);
    expect(b.store.has("tybo-push-device")).toBe(false);
    expect(texts(s.nodes())).toContain("Aus: Dieses Gerät");
  });

  test("410, dann „An\", dann Test: abgelaufenes Abo verworfen, frisch abonniert und angemeldet", async () => {
    const old = fakeSubscription("https://fcm.googleapis.com/fcm/send/alt");
    const b = browser({ subscription: old, storage: { "tybo-push-device": ID } });
    const fresh = { ...DEVICE, id: THIRD, createdAt: "2026-09-29T10:00:00.000Z" };
    let testStatus = 410;
    const server = fakeApi({
      "GET /api/push": getHandler([DEVICE]),
      "POST /api/push/test": () => (testStatus === 410
        ? { status: 410, data: { error: "Der Push-Dienst kennt dieses Gerät nicht mehr.", removed: true, subscriptionGone: true } }
        : { status: 200, data: { ok: true } }),
      "POST /api/push/subscriptions": () => ({ status: 201, data: { device: fresh } }),
    });
    const s = await settings(b, server);
    await s.view.sendTest();
    expect(old.unsubscribed).toBe(1);
    expect(old.active).toBe(false);
    expect(texts(s.nodes())).toContain("Aus: Dieses Gerät");

    testStatus = 200;
    await s.view.enable();
    expect(b.subscribeCalls.length).toBe(1);
    const post = server.calls.filter(c => c.method === "POST" && c.path === "/api/push/subscriptions");
    expect(post.length).toBe(1);
    expect(post[0].body.id).toBeUndefined();
    expect(post[0].body.subscription.endpoint).not.toBe(old.endpoint);
    expect(b.store.get("tybo-push-device")).toBe(THIRD);
    expect(texts(s.nodes())).toContain("An: Dieses Gerät bekommt Benachrichtigungen.");

    await s.view.sendTest();
    expect(server.calls.at(-1)).toEqual({ method: "POST", path: "/api/push/test", body: { id: THIRD, endpoint: "https://fcm.googleapis.com/fcm/send/abc" } });
    expect(texts(s.nodes())).toContain("Test gesendet");
  });

  test("410 und der Browser behält das alte Abo: „An\" meldet es nicht wieder an", async () => {
    const old = fakeSubscription("https://fcm.googleapis.com/fcm/send/alt");
    old.failUnsubscribe = true;
    const b = browser({ subscription: old, storage: { "tybo-push-device": ID } });
    const server = fakeApi({
      "GET /api/push": getHandler([DEVICE]),
      "POST /api/push/test": () => ({ status: 410, data: { error: "Der Push-Dienst kennt dieses Gerät nicht mehr.", removed: true, subscriptionGone: true } }),
      "POST /api/push/subscriptions": () => ({ status: 201, data: { device: DEVICE } }),
    });
    const s = await settings(b, server);
    await s.view.sendTest();
    await s.view.enable();
    expect(server.calls.some(c => c.path === "/api/push/subscriptions")).toBe(false);
    expect(texts(s.nodes())).toContain("Einschalten hat nicht geklappt");
    expect(texts(s.nodes())).toContain("Aus: Dieses Gerät");
    old.failUnsubscribe = false;
    await s.view.enable();
    const post = server.calls.find(c => c.path === "/api/push/subscriptions")!;
    expect(post.body.subscription.endpoint).not.toBe(old.endpoint);
    expect(texts(s.nodes())).toContain("An: Dieses Gerät");
  });

  test("Ausschalten scheitert (unsubscribe abgelehnt, DELETE 403): bleibt „An\" mit Fehler, Wiederholung klappt", async () => {
    const sub = fakeSubscription();
    sub.failUnsubscribe = true;
    const b = browser({ subscription: sub, storage: { "tybo-push-device": ID } });
    let deleteStatus = 403;
    const server = fakeApi({
      "GET /api/push": getHandler([DEVICE]),
      "DELETE *": () => (deleteStatus === 403 ? { status: 403, data: { error: "Anfrage abgelehnt." } } : { status: 200, data: { removed: true } }),
    });
    const s = await settings(b, server);
    await s.view.disable();
    let t = texts(s.nodes());
    expect(t).toContain("Ausschalten hat nicht geklappt");
    expect(t).toContain("Anfrage abgelehnt.");
    expect(t).toContain("An: Dieses Gerät bekommt Benachrichtigungen.");
    expect(t).toContain("Mac · Chrome");
    expect(b.store.get("tybo-push-device")).toBe(ID);
    expect(b.store.get("tybo-push-off-pending")).toBe(ID);
    expect(button(s.nodes(), "Aus")!.props.disabled).toBe(false);

    sub.failUnsubscribe = false;
    deleteStatus = 200;
    await s.view.disable();
    t = texts(s.nodes());
    expect(t).toContain("Aus: Dieses Gerät bekommt keine");
    expect(t).not.toContain("Ausschalten hat nicht geklappt");
    expect(sub.active).toBe(false);
    expect(server.calls.filter(c => c.method === "DELETE").length).toBe(2);
    expect(b.store.has("tybo-push-device")).toBe(false);
    expect(b.store.has("tybo-push-off-pending")).toBe(false);
  });

  test.each([
    ["Netzfehler", "offline"],
    // app.js wirft bei 401 und leitet zur Anmeldung
    ["abgelaufene Anmeldung", "Nicht angemeldet"],
  ])("Ausschalten mit %s: bleibt ausstehend, Neuladen zeigt es, der Abgleich holt es nach", async (_label, reason) => {
    const sub = fakeSubscription();
    const b = browser({ subscription: sub, storage: { "tybo-push-device": ID } });
    const failing = fakeApi({
      "GET /api/push": getHandler([DEVICE]),
      "DELETE *": () => { throw new Error(reason); },
    });
    const s = await settings(b, failing);
    await s.view.disable();
    expect(texts(s.nodes())).toContain("Ausschalten hat nicht geklappt");
    expect(b.store.get("tybo-push-device")).toBe(ID);
    expect(b.store.get("tybo-push-off-pending")).toBe(ID);

    // Neuladen: der Server kennt das Gerät noch, also weiter „An" mit Hinweis
    const reloaded = await settings(b, fakeApi({ "GET /api/push": getHandler([DEVICE]) }));
    expect(texts(reloaded.nodes())).toContain("An: Dieses Gerät bekommt Benachrichtigungen.");
    expect(texts(reloaded.nodes())).toContain("Ausschalten hat nicht geklappt");

    // Abgleich nach Neuladen oder Anmeldung: noch einmal scheitern lässt alles stehen
    const { api } = load();
    expect(await api.syncPushSubscription({ api: failing.api, win: b.win, storage: b.storage })).toBe("failed");
    expect(b.store.get("tybo-push-off-pending")).toBe(ID);
    // dann klappt es: nur DELETE, das Abo wird nicht wieder angemeldet
    const ok = fakeApi({ "DELETE *": () => ({ status: 200, data: { removed: true } }) });
    expect(await api.syncPushSubscription({ api: ok.api, win: b.win, storage: b.storage })).toBe("off");
    expect(ok.calls).toEqual([{ method: "DELETE", path: `/api/push/subscriptions/${ID}`, body: undefined }]);
    expect(b.store.has("tybo-push-device")).toBe(false);
    expect(b.store.has("tybo-push-off-pending")).toBe(false);
  });

  test("ausstehendes Ausschalten, das Server und Browser schon erledigt haben: still aus", async () => {
    const b = browser({ storage: { "tybo-push-device": ID, "tybo-push-off-pending": ID } });
    const s = await settings(b, fakeApi({ "GET /api/push": getHandler([OTHER_DEVICE]) }));
    const t = texts(s.nodes());
    expect(t).toContain("Aus: Dieses Gerät bekommt keine");
    expect(t).not.toContain("wurde entfernt");
    expect(b.store.has("tybo-push-device")).toBe(false);
    expect(b.store.has("tybo-push-off-pending")).toBe(false);
  });

  test("Umbenennen: PATCH mit getrimmtem Namen, zu lang wird abgelehnt", async () => {
    const b = browser({ subscription: fakeSubscription(), storage: { "tybo-push-device": ID } });
    const server = fakeApi({
      "GET /api/push": getHandler([DEVICE]),
      "PATCH *": body => ({ status: 200, data: { device: { ...DEVICE, name: body.name } } }),
    });
    const s = await settings(b, server);
    button(s.nodes(), "Umbenennen")!.listeners.click();
    s.view.state.renaming.input = "x".repeat(41);
    await s.view.rename();
    expect(texts(s.nodes())).toContain("1 bis 40 Zeichen");
    s.view.state.renaming.input = "  Laptop  Büro ";
    await s.view.rename();
    expect(server.calls.at(-1)).toEqual({ method: "PATCH", path: `/api/push/subscriptions/${ID}`, body: { name: "Laptop Büro" } });
    expect(texts(s.nodes())).toContain("Laptop Büro");
  });
});

describe("andere Geräte", () => {
  test("Liste ohne dieses Gerät, Entfernen mit Rückfrage", async () => {
    const b = browser({ subscription: fakeSubscription(), storage: { "tybo-push-device": ID } });
    const server = fakeApi({ "GET /api/push": getHandler([DEVICE, OTHER_DEVICE]), "DELETE *": () => ({ status: 200, data: { removed: true } }) });
    const s = await settings(b, server);
    const others = all(s.nodes()).find(n => n.tag === "section" && n.props.id === "push-others")!;
    expect(texts([others])).toContain("iPhone · Safari");
    expect(texts([others])).toContain("zuletzt erreicht");
    expect(texts([others])).not.toContain("Mac · Chrome");
    button([others], "Entfernen")!.listeners.click();
    expect(server.calls.some(c => c.method === "DELETE")).toBe(false);
    expect(texts(s.nodes())).toContain("Entfernen?");
    await s.view.removeOther(OTHER);
    expect(server.calls.at(-1)).toEqual({ method: "DELETE", path: `/api/push/subscriptions/${OTHER}`, body: undefined });
    expect(texts(s.nodes())).toContain("Keine anderen Geräte.");
  });
});

describe("Abgleich", () => {
  test("anderswo entfernt: beim Öffnen des Reiters abmelden statt neu anlegen", async () => {
    const sub = fakeSubscription();
    const b = browser({ subscription: sub, storage: { "tybo-push-device": ID } });
    const server = fakeApi({ "GET /api/push": getHandler([OTHER_DEVICE]) });
    const s = await settings(b, server);
    expect(sub.unsubscribed).toBe(1);
    expect(b.store.has("tybo-push-device")).toBe(false);
    expect(server.calls.filter(c => c.method !== "GET")).toEqual([]);
    expect(texts(s.nodes())).toContain("wurde entfernt");
  });

  test("nach dem Laden der Seite: bekanntes Gerät meldet sein aktuelles Abo mit id", async () => {
    const { api } = load();
    const b = browser({ subscription: fakeSubscription("https://fcm.googleapis.com/fcm/send/neu"), storage: { "tybo-push-device": ID } });
    const server = fakeApi({ "POST /api/push/subscriptions": () => ({ status: 200, data: { device: DEVICE } }) });
    expect(await api.syncPushSubscription({ api: server.api, win: b.win, storage: b.storage })).toBe("synced");
    expect(server.calls).toEqual([{
      method: "POST", path: "/api/push/subscriptions",
      body: { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/neu", keys: { p256dh: "P", auth: "A" } }, id: ID },
    }]);
  });

  test("nach dem Laden der Seite: entferntes Gerät (404 removed) wird auch beim Browser abgemeldet", async () => {
    const { api } = load();
    const sub = fakeSubscription();
    const b = browser({ subscription: sub, storage: { "tybo-push-device": ID } });
    const server = fakeApi({ "POST /api/push/subscriptions": () => ({ status: 404, data: { removed: true } }) });
    expect(await api.syncPushSubscription({ api: server.api, win: b.win, storage: b.storage })).toBe("removed");
    expect(sub.unsubscribed).toBe(1);
    expect(b.store.has("tybo-push-device")).toBe(false);
  });

  test("ohne gemerktes Gerät oder ohne Abo: keine Anfrage", async () => {
    const { api } = load();
    const server = fakeApi({});
    expect(await api.syncPushSubscription({ api: server.api, win: browser({ subscription: fakeSubscription() }).win, storage: browser().storage })).toBe("skipped");
    const b = browser({ storage: { "tybo-push-device": ID } });
    expect(await api.syncPushSubscription({ api: server.api, win: b.win, storage: b.storage })).toBe("skipped");
    expect(server.calls).toEqual([]);
  });

  test("Netzfehler beim Abgleich bleibt still und lässt das Gerät stehen", async () => {
    const { api } = load();
    const b = browser({ subscription: fakeSubscription(), storage: { "tybo-push-device": ID } });
    const failing = async () => { throw new Error("offline"); };
    expect(await api.syncPushSubscription({ api: failing, win: b.win, storage: b.storage })).toBe("failed");
    expect(b.store.get("tybo-push-device")).toBe(ID);
  });
});

describe("Was sich meldet (Issue #226)", () => {
  const SETTINGS = { replies: true, choices: true, notices: false, preview: false };

  function group(nodes: El[], key: string): El {
    const row = all(nodes).find(n => n.props["data-push-setting"] === key);
    if (!row) throw new Error(`Schalter ${key} fehlt`);
    return row;
  }
  const checked = (row: El) => all([row]).filter(n => n.props.role === "radio" && n.props["aria-checked"] === "true").map(n => n.props.text);
  const pick = (row: El, label: string) => all([row]).find(n => n.props.role === "radio" && n.props.text === label)!.listeners.click();

  test("vier Schalter mit dem Stand des Servers, Tipp speichert sofort nur diesen Schalter", async () => {
    const b = browser({ subscription: fakeSubscription(), storage: { "tybo-push-device": ID } });
    const server = fakeApi({
      "GET /api/push": getHandler([{ ...DEVICE, settings: SETTINGS }]),
      "PATCH *": body => ({ status: 200, data: { device: { ...DEVICE, settings: { ...SETTINGS, ...body.settings } } } }),
    });
    const s = await settings(b, server);
    const nodes = s.nodes();
    expect(texts(nodes)).toContain("Was sich meldet");
    expect(texts(nodes)).toContain("Nie für das Gespräch, das gerade offen auf dem Bildschirm ist.");
    expect(["replies", "choices", "notices", "preview"].map(k => checked(group(nodes, k)))).toEqual([["An"], ["An"], ["Aus"], ["Aus"]]);
    expect(texts([group(nodes, "preview")])).toContain("Inhalt in der Benachrichtigung zeigen");
    expect(texts([group(nodes, "preview")])).toContain("Sperrbildschirm");
    pick(group(nodes, "notices"), "An");
    await new Promise(r => setTimeout(r, 0));
    expect(server.calls.at(-1)).toEqual({ method: "PATCH", path: `/api/push/subscriptions/${ID}`, body: { settings: { notices: true } } });
    expect(checked(group(s.nodes(), "notices"))).toEqual(["An"]);
  });

  test("Fehler beim Speichern steht am Schalter, der Stand bleibt", async () => {
    const b = browser({ subscription: fakeSubscription(), storage: { "tybo-push-device": ID } });
    const server = fakeApi({
      "GET /api/push": getHandler([{ ...DEVICE, settings: SETTINGS }]),
      "PATCH *": () => ({ status: 400, data: { error: "Ungültige Einstellungen" } }),
    });
    const s = await settings(b, server);
    await s.view.saveSetting("preview", true);
    const row = group(s.nodes(), "preview");
    expect(texts([row])).toContain("Ungültige Einstellungen");
    expect(checked(row)).toEqual(["Aus"]);
  });

  test("ausgeschaltetes Gerät zeigt keine Schalter", async () => {
    const b = browser();
    const server = fakeApi({ "GET /api/push": getHandler([]) });
    const s = await settings(b, server);
    expect(all(s.nodes()).some(n => n.props["data-push-setting"])).toBe(false);
  });
});
