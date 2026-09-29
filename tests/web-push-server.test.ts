/**
 * Web Push (Issue #225), Routen und Abo-Speicher im Web-Server: Sitzung und
 * Origin nötig (GET ohne Origin), über den Tunnel Access nötig, nur Browser
 * (kein Terminal-Zugang), Obergrenze 20 Geräte, Datei 0600 und nach Neustart
 * wieder da, Gerätevertrag (ID, gleicher Endpunkt, alter Endpunkt, entferntes
 * Gerät nicht still neu), Test-Versand mit fetch-Attrappe (404/410 löschen,
 * 429 nicht; nach Abo-Wechsel während des Versands bleibt das neue Abo). Der private Schlüssel steht nie in Antworten, Datei oder Log,
 * Endpunkt-Pfade nie im Log.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCliToken } from "../src/web/cli-token";
import { generateVapidKeys, type VapidKeys } from "../src/web/push";
import { createWebServer, type WebServer } from "../src/web/server";
import { ACCESS, FakeCerts, validJwt } from "./access-fixture";

const PASSWORD = "test-passwort-lang";
const P256DH = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const keys: VapidKeys = await generateVapidKeys();
const root = await mkdtemp(join(tmpdir(), "tybo-push-server-"));
const servers: WebServer[] = [];
let counter = 0;

afterAll(async () => {
  for (const s of servers.splice(0)) await s.stop();
  await rm(root, { recursive: true, force: true });
});

interface Ctx {
  url: string;
  dir: string;
  logs: string[];
  sent: { url: string; headers: Record<string, string> }[];
  /** Status, mit dem die Attrappe des Push-Diensts antwortet; mit hold erst, wenn das Versprechen erfüllt ist */
  reply: { status: number; hold?: Promise<void> };
  cliToken: string;
}

async function start(options: { push?: boolean; dir?: string; publicOrigin?: string; reply?: Ctx["reply"]; sent?: Ctx["sent"] } = {}): Promise<Ctx> {
  const dir = options.dir ?? join(root, `case-${++counter}`);
  const logs: string[] = [];
  const sent: Ctx["sent"] = options.sent ?? [];
  const reply = options.reply ?? { status: 201 };
  const fakeFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string> });
    if (reply.hold) await reply.hold;
    return new Response(null, { status: reply.status });
  }) as unknown as typeof fetch;
  const tokenFile = join(dir, "cli-token");
  const server = await createWebServer(
    {
      host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [],
      publicOrigin: options.publicOrigin ?? null, access: options.publicOrigin ? ACCESS : null,
    },
    {
      sessionFile: join(dir, "sessions.json"),
      dataDir: join(dir, "web"),
      cliTokenFile: tokenFile,
      accessCerts: new FakeCerts().fetch,
      ...(options.push === false ? {} : { push: { keys, subject: "https://tybo.example", fetch: fakeFetch } }),
      log: m => logs.push(m),
    }
  );
  servers.push(server);
  return { url: server.url, dir, logs, sent, reply, cliToken: (await readCliToken(tokenFile))! };
}

async function login(ctx: Ctx, headers: Record<string, string> = { origin: ctx.url }): Promise<string> {
  const res = await fetch(`${ctx.url}/api/login`, { method: "POST", headers, body: JSON.stringify({ password: PASSWORD }) });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

function endpoint(n: number | string): string {
  return `https://fcm.googleapis.com/fcm/send/geheim-${n}`;
}

function subscription(n: number | string) {
  return { endpoint: endpoint(n), keys: { p256dh: P256DH, auth: AUTH } };
}

function call(ctx: Ctx, cookie: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { origin: ctx.url, "content-type": "application/json", ...extra };
  if (cookie) headers.cookie = cookie;
  return fetch(`${ctx.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function subscribe(ctx: Ctx, cookie: string, body: unknown, extra: Record<string, string> = {}) {
  return call(ctx, cookie, "POST", "/api/push/subscriptions", body, { "user-agent": IPHONE_UA, ...extra });
}

async function allText(ctx: Ctx): Promise<string> {
  const file = await readFile(join(ctx.dir, "web", "push-subscriptions.json"), "utf8").catch(() => "");
  return file + ctx.logs.join("\n");
}

describe("Anmeldung, Origin und Terminal", () => {
  test("ohne Sitzung 401 (mit gültigem Origin), angemeldet mit fremdem Origin 403, GET braucht keinen Origin", async () => {
    const ctx = await start();
    expect((await call(ctx, null, "GET", "/api/push")).status).toBe(401);
    expect((await subscribe(ctx, "", { subscription: subscription(1) })).status).toBe(401);
    expect((await call(ctx, null, "POST", "/api/push/test", { id: crypto.randomUUID() })).status).toBe(401);
    const cookie = await login(ctx);
    for (const origin of ["https://evil.example", "null"]) {
      expect((await subscribe(ctx, cookie, { subscription: subscription(1) }, { origin })).status).toBe(403);
      expect((await call(ctx, cookie, "POST", "/api/push/test", { id: crypto.randomUUID() }, { origin })).status).toBe(403);
      expect((await call(ctx, cookie, "DELETE", `/api/push/subscriptions/${crypto.randomUUID()}`, undefined, { origin })).status).toBe(403);
    }
    const get = await fetch(`${ctx.url}/api/push`, { headers: { cookie } });
    expect(get.status).toBe(200);
  });

  test("Terminal-Zugang (lokaler Schlüssel) bekommt keine Push-Routen", async () => {
    const ctx = await start();
    const res = await fetch(`${ctx.url}/api/push`, { headers: { authorization: `Bearer ${ctx.cliToken}` } });
    expect(res.status).toBe(403);
  });

  test("über den Tunnel nur mit Access-Nachweis, dann wie im Heimnetz", async () => {
    const ctx = await start({ publicOrigin: "https://app.tybo.ai" });
    const tunnel = { host: "app.tybo.ai", origin: "https://app.tybo.ai", "cf-connecting-ip": "203.0.113.7", "cf-ray": "8a1b2c3d4e5f-FRA" };
    const withAccess = { ...tunnel, "cf-access-jwt-assertion": validJwt() };
    const cookie = await login(ctx, withAccess);
    const denied = await fetch(`${ctx.url}/api/push`, { headers: { ...tunnel, cookie } });
    expect(denied.status).toBe(403);
    const denyPost = await fetch(`${ctx.url}/api/push/subscriptions`, {
      method: "POST", headers: { ...tunnel, cookie }, body: JSON.stringify({ subscription: subscription(1) }),
    });
    expect(denyPost.status).toBe(403);
    expect((await fetch(`${ctx.url}/api/push`, { headers: { ...withAccess, cookie } })).status).toBe(200);
    const ok = await fetch(`${ctx.url}/api/push/subscriptions`, {
      method: "POST", headers: { ...withAccess, cookie }, body: JSON.stringify({ subscription: subscription(1) }),
    });
    expect(ok.status).toBe(201);
  });
});

describe("Geräte", () => {
  test("GET: öffentlicher Schlüssel und Geräte ohne Endpunkt, nie der private Schlüssel", async () => {
    const ctx = await start();
    const cookie = await login(ctx);
    const created = await subscribe(ctx, cookie, { subscription: subscription(1) });
    expect(created.status).toBe(201);
    const { device } = await created.json();
    expect(device.name).toBe("iPhone · Safari");
    expect(device.lastOkAt).toBeNull();
    const res = await call(ctx, cookie, "GET", "/api/push");
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.available).toBe(true);
    expect(body.publicKey).toBe(keys.publicKey);
    expect(body.max).toBe(20);
    expect(body.devices).toEqual([device]);
    expect(text).not.toContain(keys.privateKey);
    expect(text).not.toContain("geheim-1");
    expect(text).not.toContain(AUTH);
  });

  test("fremder Host, http, kaputte Schlüssel und kaputtes JSON: 400, nichts gespeichert", async () => {
    const ctx = await start();
    const cookie = await login(ctx);
    for (const bad of [
      { subscription: { ...subscription(1), endpoint: "https://evil.example/push" } },
      { subscription: { ...subscription(1), endpoint: "http://fcm.googleapis.com/fcm/send/x" } },
      { subscription: { ...subscription(1), endpoint: "https://fcm.googleapis.com.evil.example/x" } },
      { subscription: { ...subscription(1), keys: { p256dh: "AAAA", auth: AUTH } } },
      { subscription: { ...subscription(1), keys: { p256dh: P256DH } } },
      // richtige Länge und 0x04, aber kein Punkt auf P-256
      { subscription: { ...subscription(1), keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url"), auth: AUTH } } },
      { subscription: subscription(1), id: "keine-uuid" },
      {},
    ]) {
      expect((await subscribe(ctx, cookie, bad)).status).toBe(400);
    }
    const raw = await fetch(`${ctx.url}/api/push/subscriptions`, { method: "POST", headers: { origin: ctx.url, cookie }, body: "{kaputt" });
    expect(raw.status).toBe(400);
    expect((await (await call(ctx, cookie, "GET", "/api/push")).json()).devices).toEqual([]);
  });

  test("gleicher Endpunkt ersetzt, mit id Endpunktwechsel bei gleichem Gerät, Name bleibt", async () => {
    const ctx = await start();
    const cookie = await login(ctx);
    const first = (await (await subscribe(ctx, cookie, { subscription: subscription(1) })).json()).device;
    const again = await subscribe(ctx, cookie, { subscription: subscription(1) });
    expect(again.status).toBe(200);
    expect((await again.json()).device.id).toBe(first.id);
    await call(ctx, cookie, "PATCH", `/api/push/subscriptions/${first.id}`, { name: "Handy von Alex" });
    const moved = await subscribe(ctx, cookie, { subscription: subscription(2), id: first.id });
    expect(moved.status).toBe(200);
    expect((await moved.json()).device).toMatchObject({ id: first.id, name: "Handy von Alex", createdAt: first.createdAt });
    const file = JSON.parse(await readFile(join(ctx.dir, "web", "push-subscriptions.json"), "utf8"));
    expect(file.map((d: { endpoint: string }) => d.endpoint)).toEqual([endpoint(2)]);
  });

  test("Abo-Wechsel aus dem Service Worker über den alten Endpunkt", async () => {
    const ctx = await start();
    const cookie = await login(ctx);
    const first = (await (await subscribe(ctx, cookie, { subscription: subscription(1) })).json()).device;
    const res = await subscribe(ctx, cookie, { subscription: subscription(3), previousEndpoint: endpoint(1) });
    expect(res.status).toBe(200);
    expect((await res.json()).device.id).toBe(first.id);
    // Unbekannter alter Endpunkt: nicht still ein neues Gerät
    const unknown = await subscribe(ctx, cookie, { subscription: subscription(4), previousEndpoint: endpoint(99) });
    expect(unknown.status).toBe(404);
    expect((await (await call(ctx, cookie, "GET", "/api/push")).json()).devices.length).toBe(1);
  });

  test("entferntes Gerät wird mit seiner id nicht wieder angelegt (404, removed)", async () => {
    const ctx = await start();
    const cookie = await login(ctx);
    const { device } = await (await subscribe(ctx, cookie, { subscription: subscription(1) })).json();
    expect((await call(ctx, cookie, "DELETE", `/api/push/subscriptions/${device.id}`)).status).toBe(200);
    expect((await call(ctx, cookie, "DELETE", `/api/push/subscriptions/${device.id}`)).status).toBe(404);
    const back = await subscribe(ctx, cookie, { subscription: subscription(1), id: device.id });
    expect(back.status).toBe(404);
    expect((await back.json()).removed).toBe(true);
    expect((await (await call(ctx, cookie, "GET", "/api/push")).json()).devices).toEqual([]);
  });

  test("umbenennen: 1 bis 40 Zeichen, keine Steuerzeichen", async () => {
    const ctx = await start();
    const cookie = await login(ctx);
    const { device } = await (await subscribe(ctx, cookie, { subscription: subscription(1) })).json();
    for (const name of ["", "   ", "x".repeat(41), "a\u0000b", 42]) {
      expect((await call(ctx, cookie, "PATCH", `/api/push/subscriptions/${device.id}`, { name })).status).toBe(400);
    }
    const ok = await call(ctx, cookie, "PATCH", `/api/push/subscriptions/${device.id}`, { name: "  Tablet  Küche " });
    expect((await ok.json()).device.name).toBe("Tablet Küche");
    expect((await call(ctx, cookie, "PATCH", `/api/push/subscriptions/${crypto.randomUUID()}`, { name: "x" })).status).toBe(404);
  });

  test("höchstens 20 Geräte, das 21. gibt 409", async () => {
    const ctx = await start();
    const cookie = await login(ctx);
    for (let i = 0; i < 20; i++) expect((await subscribe(ctx, cookie, { subscription: subscription(i) })).status).toBe(201);
    const full = await subscribe(ctx, cookie, { subscription: subscription(20) });
    expect(full.status).toBe(409);
    // Ein bekanntes Gerät darf weiter aktualisieren
    expect((await subscribe(ctx, cookie, { subscription: subscription(5) })).status).toBe(200);
  });

  test("Datei 0600 im Ordner 0700, nach Neustart wieder da, ohne privaten Schlüssel", async () => {
    const ctx = await start();
    const cookie = await login(ctx);
    const { device } = await (await subscribe(ctx, cookie, { subscription: subscription(1) })).json();
    const file = join(ctx.dir, "web", "push-subscriptions.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(ctx.dir, "web"))).mode & 0o777).toBe(0o700);
    const content = await readFile(file, "utf8");
    expect(content).not.toContain(keys.privateKey);
    const restarted = await start({ dir: ctx.dir });
    const cookie2 = await login(restarted);
    expect((await (await call(restarted, cookie2, "GET", "/api/push")).json()).devices).toEqual([device]);
  });
});

describe("Test senden", () => {
  test("an dieses Gerät: Kopfzeilen, lastOkAt gesetzt, Log ohne Endpunkt-Pfad und privaten Schlüssel", async () => {
    const ctx = await start();
    const cookie = await login(ctx);
    const { device } = await (await subscribe(ctx, cookie, { subscription: subscription(1) })).json();
    const res = await call(ctx, cookie, "POST", "/api/push/test", { id: device.id });
    expect(res.status).toBe(200);
    expect(ctx.sent.length).toBe(1);
    expect(ctx.sent[0].url).toBe(endpoint(1));
    expect(ctx.sent[0].headers.Authorization).toStartWith("vapid t=");
    expect(ctx.sent[0].headers.Authorization).toEndWith(`, k=${keys.publicKey}`);
    expect(ctx.sent[0].headers["Content-Encoding"]).toBe("aes128gcm");
    expect(ctx.sent[0].headers.TTL).toBe("60");
    const devices = (await (await call(ctx, cookie, "GET", "/api/push")).json()).devices;
    expect(devices[0].lastOkAt).not.toBeNull();
    const logs = ctx.logs.join("\n");
    expect(logs).not.toContain("geheim-1");
    expect(logs).not.toContain(keys.privateKey);
  });

  test.each([410, 404])("Antwort %d löscht das Abo", async status => {
    const ctx = await start({ reply: { status } });
    const cookie = await login(ctx);
    const { device } = await (await subscribe(ctx, cookie, { subscription: subscription(1) })).json();
    const res = await call(ctx, cookie, "POST", "/api/push/test", { id: device.id, endpoint: endpoint(1) });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ removed: true, subscriptionGone: true });
    expect((await (await call(ctx, cookie, "GET", "/api/push")).json()).devices).toEqual([]);
    expect(JSON.parse(await readFile(join(ctx.dir, "web", "push-subscriptions.json"), "utf8"))).toEqual([]);
    expect(ctx.logs).toContain(`Push (Test) an „${device.name}": abgelaufen (${status}), Gerät entfernt`);
    expect(ctx.logs.join("\n")).not.toContain("geheim-1");
  });

  test.each([410, 404])("Antwort %d nach Abo-Wechsel während des Versands: Gerät bleibt mit neuem Endpunkt (409, removed: false)", async status => {
    let release!: () => void;
    const ctx = await start({ reply: { status, hold: new Promise<void>(r => { release = r; }) } });
    const cookie = await login(ctx);
    const { device } = await (await subscribe(ctx, cookie, { subscription: subscription("a") })).json();
    const pending = call(ctx, cookie, "POST", "/api/push/test", { id: device.id, endpoint: endpoint("a") });
    while (ctx.sent.length === 0) await Bun.sleep(1);
    expect(ctx.sent[0].url).toBe(endpoint("a"));
    // Dasselbe Gerät meldet währenddessen sein neues Abo B
    const renewed = await subscribe(ctx, cookie, { id: device.id, subscription: subscription("b") });
    expect(renewed.status).toBe(200);
    release();
    const res = await pending;
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.removed).toBe(false);
    expect(data.subscriptionGone).toBeUndefined();
    const devices = (await (await call(ctx, cookie, "GET", "/api/push")).json()).devices;
    expect(devices.map((d: { id: string }) => d.id)).toEqual([device.id]);
    const stored = JSON.parse(await readFile(join(ctx.dir, "web", "push-subscriptions.json"), "utf8"));
    expect(stored.map((d: { endpoint: string }) => d.endpoint)).toEqual([endpoint("b")]);
    expect(ctx.logs.join("\n")).toContain("bleibt");
    expect(ctx.logs.join("\n")).not.toContain("geheim-");
  });

  test.each([410, 404])("Antwort %d, aber der Browser hat schon ein anderes Abo: entfernt, subscriptionGone false", async status => {
    const ctx = await start({ reply: { status } });
    const cookie = await login(ctx);
    const { device } = await (await subscribe(ctx, cookie, { subscription: subscription("a") })).json();
    const res = await call(ctx, cookie, "POST", "/api/push/test", { id: device.id, endpoint: endpoint("b") });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ removed: true, subscriptionGone: false });
    expect((await (await call(ctx, cookie, "GET", "/api/push")).json()).devices).toEqual([]);
  });

  test.each([429, 413, 503])("Antwort %d behält das Abo und loggt Kategorie, Gerät und Ergebnis ohne Endpunkt", async status => {
    const ctx = await start({ reply: { status } });
    const cookie = await login(ctx);
    const { device } = await (await subscribe(ctx, cookie, { subscription: subscription(1) })).json();
    expect((await call(ctx, cookie, "POST", "/api/push/test", { id: device.id })).status).toBe(502);
    expect((await (await call(ctx, cookie, "GET", "/api/push")).json()).devices.length).toBe(1);
    expect(ctx.logs).toContain(`Push (Test) an „${device.name}": nicht angenommen (${status}), Abo bleibt`);
    expect(ctx.logs.filter(l => l.startsWith("Push (")).join("\n")).not.toContain("googleapis");
    expect(await allText(ctx)).not.toContain(keys.privateKey);
    expect(ctx.logs.join("\n")).not.toContain("geheim-1");
  });

  test("unbekanntes Gerät 404, ohne id 400", async () => {
    const ctx = await start();
    const cookie = await login(ctx);
    expect((await call(ctx, cookie, "POST", "/api/push/test", { id: crypto.randomUUID() })).status).toBe(404);
    expect((await call(ctx, cookie, "POST", "/api/push/test", {})).status).toBe(400);
    expect((await call(ctx, cookie, "POST", "/api/push/test", { id: crypto.randomUUID(), endpoint: 5 })).status).toBe(400);
    expect(ctx.sent.length).toBe(0);
  });
});

describe("ohne Push-Schlüssel", () => {
  test("GET meldet available: false, Schreiben 503", async () => {
    const ctx = await start({ push: false });
    const cookie = await login(ctx);
    const body = await (await call(ctx, cookie, "GET", "/api/push")).json();
    expect(body.available).toBe(false);
    expect(body.reason).toContain("nicht eingerichtet");
    expect(body.publicKey).toBeUndefined();
    expect((await subscribe(ctx, cookie, { subscription: subscription(1) })).status).toBe(503);
    expect((await call(ctx, cookie, "POST", "/api/push/test", { id: crypto.randomUUID() })).status).toBe(503);
  });
});
