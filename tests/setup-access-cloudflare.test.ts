/**
 * Issue #231, Checkbox 3: Weg Cloudflare im Schritt „zugang“ mit beliebiger
 * Domain statt app.tybo.ai. Schreibt WEB_PUBLIC_ORIGIN, WEB_ACCESS_TEAM,
 * WEB_ACCESS_AUD und WEB_PORT; der Test prüft Team und Access davor mit
 * einer fetch-Attrappe. Dazu der WebUI-Server mit einer anderen Domain.
 * Kein Netz, kein cloudflared, die echte .env bleibt unberührt.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvContent } from "../src/lib/env-file";
import type { HttpFetch } from "../src/setup/context";
import { existingFieldValues } from "../src/setup/steps";
import { ACCESS_SESSION_HINT, accessStep, domainOrigin } from "../src/setup/steps/access";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import { loadWebConfig, remoteKind } from "../src/web/config";
import { ACCESS_DENIED_TEXT, createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { ACCESS, FakeCerts, signJwt, claims } from "./access-fixture";
import { backupsOf, cleanup, FAKE, leakedSecrets, makeCtx } from "./setup-fixture";
import { linuxCtx, runWith, scripted } from "./setup-terminal-fixture";
import { login, post, startSetup, type Started } from "./setup-web-fixture";

const running: Started[] = [];
const servers: WebServer[] = [];
const root = await mkdtemp(join(tmpdir(), "tybo-cf-domain-"));
afterEach(async () => {
  for (const s of running.splice(0)) await s.server.stop();
});
afterAll(async () => {
  for (const s of servers.splice(0)) await s.stop();
  await rm(root, { recursive: true, force: true });
  await cleanup();
});

const WEB_ON = `WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\n`;
const DOMAIN = "tybo.example.org";
const ORIGIN = `https://${DOMAIN}`;
const TEAM = "meinteam";
const AUD = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const VALUES = { ZUGANG_WEG: "cloudflare", ZUGANG_DOMAIN: DOMAIN, WEB_ACCESS_TEAM: TEAM, WEB_ACCESS_AUD: AUD };

/** Cloudflare-Attrappe: Schlüssel des Teams und Weiterleitung zur Anmeldung */
function cloudflare(options: { certs?: number; keys?: unknown[]; site?: (url: string) => Response | Promise<Response> } = {}): HttpFetch & { calls: Array<{ url: string; redirect?: string }> } {
  const calls: Array<{ url: string; redirect?: string }> = [];
  const f = (async (url: string, req: { redirect?: string } = {}) => {
    calls.push({ url, redirect: req.redirect });
    if (url === `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: options.keys ?? [{ kid: "a" }] }), { status: options.certs ?? 200 });
    }
    if (url.startsWith(ORIGIN)) {
      if (options.site) return options.site(url);
      return new Response(null, { status: 302, headers: { location: `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/login/${DOMAIN}?redirect_url=%2F` } });
    }
    return new Response("", { status: 404 });
  }) as HttpFetch & { calls: Array<{ url: string; redirect?: string }> };
  f.calls = calls;
  return f;
}

async function ctxWith(env: string, fetch: HttpFetch = cloudflare()) {
  return makeCtx({ env, overrides: { fetch } });
}

describe("Domain", () => {
  test("Domain oder https-Adresse wird zur öffentlichen Adresse; Pfad, Port, IP sind ungültig", () => {
    expect(domainOrigin("tybo.example.org")).toBe(ORIGIN);
    expect(domainOrigin(" https://Tybo.Example.org/ ")).toBe(ORIGIN);
    for (const bad of ["tybo.example.org/pfad", "tybo.example.org:8443", "http://tybo.example.org", "203.0.113.7", "localhost", "a b.example.org"]) {
      expect(domainOrigin(bad)).toBeNull();
    }
  });
});

describe("Weg Cloudflare: speichern", () => {
  test("schreibt die vier Werte, WEB_PORT mit Standard 3100; Status danach erledigt, WebUI startfähig", async () => {
    const ctx = await ctxWith(WEB_ON);
    const r = await accessStep.apply!(VALUES, ctx);
    expect(r.ok).toBe(true);
    expect(r.changed.sort()).toEqual(["WEB_ACCESS_AUD", "WEB_ACCESS_TEAM", "WEB_PORT", "WEB_PUBLIC_ORIGIN"]);
    const env = parseEnvContent(await readFile(ctx.envPath, "utf8"));
    expect(env).toMatchObject({ WEB_PUBLIC_ORIGIN: ORIGIN, WEB_ACCESS_TEAM: TEAM, WEB_ACCESS_AUD: AUD, WEB_PORT: "3100" });
    expect(r.message).toContain(`Adresse fürs Handy: ${ORIGIN}`);
    expect(r.message).toContain("Service http://localhost:3100");
    expect(r.message).toContain(ACCESS_SESSION_HINT);
    expect(ACCESS_SESSION_HINT).toContain("30 Tage");
    const web = loadWebConfig(env);
    expect(web.status).toBe("ok");
    if (web.status === "ok") expect(remoteKind(web.config)).toBe("cloudflare");
    expect((await accessStep.status(ctx)).state).toBe("erledigt");
    expect(await backupsOf(ctx)).toHaveLength(1);
  });

  test("vorhandener WEB_PORT bleibt, ganze Team-Adresse und https-Domain werden normalisiert", async () => {
    const ctx = await ctxWith(`${WEB_ON}WEB_PORT=3155\n`);
    const r = await accessStep.apply!({ ...VALUES, ZUGANG_DOMAIN: "https://Tybo.Example.org/", WEB_ACCESS_TEAM: "MeinTeam.cloudflareaccess.com" }, ctx);
    expect(r.ok).toBe(true);
    const env = parseEnvContent(await readFile(ctx.envPath, "utf8"));
    expect(env).toMatchObject({ WEB_PUBLIC_ORIGIN: ORIGIN, WEB_ACCESS_TEAM: TEAM, WEB_PORT: "3155" });
    expect(r.message).toContain("Service http://localhost:3155");
  });

  test("erneut einrichten mit leeren Feldern: vorhandene Werte bleiben, nichts geschrieben", async () => {
    const env = `${WEB_ON}WEB_PUBLIC_ORIGIN=${ORIGIN}\nWEB_ACCESS_TEAM=${TEAM}\nWEB_ACCESS_AUD=${AUD}\nWEB_PORT=3100\n`;
    const ctx = await ctxWith(env);
    const existing = await existingFieldValues(accessStep, ctx);
    expect(existing).toMatchObject({ ZUGANG_WEG: "cloudflare", ZUGANG_DOMAIN: DOMAIN, WEB_ACCESS_TEAM: TEAM, WEB_ACCESS_AUD: AUD });
    const r = await accessStep.apply!({ ZUGANG_WEG: "cloudflare" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual([]);
    expect(await readFile(ctx.envPath, "utf8")).toBe(env);
    expect(await backupsOf(ctx)).toEqual([]);
  });

  test("ungültige Eingaben: Fehler ohne Werte in der Meldung, nichts geschrieben", async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ ZUGANG_DOMAIN: "rechner.tailnet.ts.net" }, "gehört zu Tailscale"],
      [{ ZUGANG_DOMAIN: "tybo.example.org/pfad" }, "nur eine Domain"],
      [{ WEB_ACCESS_TEAM: "mein_team!" }, "Cloudflare-Team-Name"],
      [{ WEB_ACCESS_AUD: "kurz" }, "Application Audience (AUD) Tag"],
    ];
    for (const [change, text] of cases) {
      const ctx = await ctxWith(WEB_ON);
      const r = await accessStep.apply!({ ...VALUES, ...change }, ctx);
      expect(r.ok).toBe(false);
      expect(r.message).toContain(text);
      for (const v of Object.values(change)) expect(r.message).not.toContain(v);
      expect(await readFile(ctx.envPath, "utf8")).toBe(WEB_ON);
    }
    const ctx = await ctxWith(WEB_ON);
    const missing = await accessStep.apply!({ ZUGANG_WEG: "cloudflare" }, ctx);
    expect(missing.message).toContain("Adresse von unterwegs (eigene Domain) fehlt");
  });

  test("WebUI aus: nichts geschrieben", async () => {
    const ctx = await ctxWith("");
    const r = await accessStep.apply!(VALUES, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Die WebUI ist aus.");
    expect(await backupsOf(ctx)).toEqual([]);
  });
});

describe("Weg Cloudflare: Wechsel von Tailscale", () => {
  const TS_ENV = `${WEB_ON}WEB_PUBLIC_ORIGIN=https://rechner.tailnet-beispiel.ts.net\n`;

  test("ohne Bestätigung: nichts geändert", async () => {
    const ctx = await ctxWith(TS_ENV);
    const r = await accessStep.apply!({ ...VALUES, ZUGANG_ERSETZEN: "false" }, ctx);
    expect(r).toEqual({ ok: true, message: "Nichts geändert: der vorhandene Zugang über Tailscale bleibt.", changed: [] });
    expect(await readFile(ctx.envPath, "utf8")).toBe(TS_ENV);
  });

  test("mit Bestätigung: Cloudflare-Werte gesetzt, Hinweis auf die bleibende Tailscale-Weiterleitung, kein tailscale-Aufruf", async () => {
    const ctx = await ctxWith(TS_ENV);
    const r = await accessStep.apply!({ ...VALUES, ZUGANG_ERSETZEN: "true" }, ctx);
    expect(r.ok).toBe(true);
    expect(parseEnvContent(await readFile(ctx.envPath, "utf8")).WEB_PUBLIC_ORIGIN).toBe(ORIGIN);
    expect(r.message).toContain("tailscale serve --https=443 off");
    expect(ctx.run.calls.some(c => c[0] === "tailscale")).toBe(false);
  });
});

describe("Weg Cloudflare: Test", () => {
  test("Team bekannt und Access davor: bestanden; Adresse ohne Weiterleitung folgen abgefragt", async () => {
    const fetch = cloudflare();
    const ctx = await ctxWith(WEB_ON, fetch);
    const r = await accessStep.test!(VALUES, ctx);
    expect(r.ok).toBe(true);
    expect(r.items!.map(i => i.label)).toEqual(["Team", "Access"]);
    expect(fetch.calls.find(c => c.url.startsWith(ORIGIN))!.redirect).toBe("manual");
    // Test schreibt nichts
    expect(await readFile(ctx.envPath, "utf8")).toBe(WEB_ON);
  });

  test("unbekanntes Team, keine Schlüssel, Adresse ohne Access, anderes Team: nicht bestanden", async () => {
    const cases: Array<[Parameters<typeof cloudflare>[0], string]> = [
      [{ certs: 404 }, "kennt diesen Team-Namen nicht"],
      [{ keys: [] }, "kennt diesen Team-Namen nicht"],
      [{ site: () => new Response("ok", { status: 200 }) }, "ohne Cloudflare-Anmeldung erreichbar"],
      [{ site: () => new Response(null, { status: 302, headers: { location: "https://anderesteam.cloudflareaccess.com/cdn-cgi/access/login" } }) }, "anderen Cloudflare-Teams"],
    ];
    for (const [options, text] of cases) {
      const ctx = await ctxWith(WEB_ON, cloudflare(options));
      const r = await accessStep.test!(VALUES, ctx);
      expect(r.ok).toBe(false);
      expect(r.message).toContain(text);
    }
  });

  test("Adresse noch nicht erreichbar (DNS, Tunnel): ausstehend mit curl-Befehl, kein Fehler", async () => {
    const ctx = await ctxWith(WEB_ON, cloudflare({ site: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")) }));
    const r = await accessStep.test!(VALUES, ctx);
    expect(r.ok).toBe(true);
    expect(r.items!.find(i => i.label === "Access")!.detail).toContain(`curl -sI ${ORIGIN}/manifest.webmanifest`);
  });

  test("Cloudflare gar nicht erreichbar: nicht bestanden", async () => {
    const ctx = await ctxWith(WEB_ON, (async () => {
      throw new Error("offline");
    }) as HttpFetch);
    const r = await accessStep.test!(VALUES, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Cloudflare ist gerade nicht erreichbar");
  });
});

describe("Oberflächen", () => {
  test("Terminal: Weg 2, Domain, Team, AUD, Test, Speichern", async () => {
    const ctx = await linuxCtx({ env: WEB_ON });
    ctx.fetch = cloudflare();
    const prompter = scripted(["2", DOMAIN, TEAM, AUD, ""]);
    const r = await runWith({ mode: "step", step: "zugang" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(r.out).toContain("Verbindungstest: bestanden.");
    expect(r.out).toContain("Cloudflare Access schützt die Adresse");
    expect(parseEnvContent(await readFile(ctx.envPath, "utf8"))).toMatchObject({ WEB_PUBLIC_ORIGIN: ORIGIN, WEB_ACCESS_TEAM: TEAM, WEB_ACCESS_AUD: AUD, WEB_PORT: "3100" });
    expect(leakedSecrets(r.out)).toEqual([]);
  });

  test("Browser: Speichern über die API schreibt die vier Werte", async () => {
    const ctx = await makeCtx({ env: `TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=${FAKE.userId}\n${WEB_ON}`, overrides: { fetch: cloudflare() } });
    const s = await startSetup({ ctx });
    running.push(s);
    const cookie = await login(s);
    const test = (await (await post(s, "/api/setup/steps/zugang/test", { values: VALUES }, cookie)).json()) as any;
    expect(test.ok).toBe(true);
    const res = await post(s, "/api/setup/steps/zugang/apply", { values: VALUES }, cookie);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(parseEnvContent(await readFile(ctx.envPath, "utf8"))).toMatchObject({ WEB_PUBLIC_ORIGIN: ORIGIN, WEB_ACCESS_TEAM: TEAM, WEB_ACCESS_AUD: AUD, WEB_PORT: "3100" });
    // Team und AUD sind Freitext: in Antworten geschwärzt
    expect(JSON.stringify(data)).not.toContain(AUD);
  });
});

describe("WebUI-Server mit eigener Domain", () => {
  class Chat implements WebChat {
    async runTurn(_opts: RunTurnOptions) {
      return { text: "Antwort" };
    }
    stop() {}
  }

  async function startWeb() {
    const dir = join(root, `case-${servers.length + 1}`);
    const store = new ConversationStore({ dir: join(dir, "web") });
    await store.load();
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: "test-passwort-lang", allowedHosts: [], publicOrigin: ORIGIN, access: ACCESS },
      {
        sessionFile: join(dir, "sessions.json"),
        conversationStore: store,
        chat: new Chat(),
        cliTokenFile: join(dir, "cli-token"),
        keepaliveMs: 60_000,
        accessCerts: new FakeCerts().fetch,
        log: () => {},
      },
    );
    servers.push(server);
    return server.url;
  }

  const jwt = () => signJwt(claims(Date.now(), { exp: 4_102_444_800 }));
  const loginWith = (url: string, headers: Record<string, string>) =>
    fetch(`${url}/api/login`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ password: "test-passwort-lang" }) });

  test("Login über den Tunnel mit der eigenen Domain und Access-Nachweis; app.tybo.ai passt nicht", async () => {
    const url = await startWeb();
    const tunnel = { host: DOMAIN, origin: ORIGIN, "cf-connecting-ip": "203.0.113.7", "cf-access-jwt-assertion": jwt() };
    const ok = await loginWith(url, tunnel);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("; Secure");
    expect((await loginWith(url, { ...tunnel, host: "app.tybo.ai", origin: "https://app.tybo.ai" })).status).toBe(421);
    const { "cf-access-jwt-assertion": _, ...noJwt } = tunnel;
    const denied = await loginWith(url, noJwt);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: ACCESS_DENIED_TEXT });
  });
});
