/**
 * Issue #99, Schritt 3 (Sicherheitstests): keine lokalen Sonderrechte über
 * den Tunnel. Der Terminal-Schlüssel (data/cli-token) gilt getunnelt nie,
 * auch nicht mit gültigem Access-Nachweis. Der Einrichtungsmodus lehnt jede
 * Anfrage mit Tunnel-Kopfzeilen ab, auch mit lokalem Host, gültigem Code
 * oder Cookie, mit und ohne WEB_PUBLIC_ORIGIN. Alles mit Attrappen, kein Netz.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupMode } from "../src/setup/web-mode";
import { SETUP_TUNNEL_TEXT } from "../src/setup/web-server";
import { hasTunnelHeaders, TUNNEL_MARKER_HEADERS } from "../src/web/auth";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import { readCliToken } from "../src/web/cli-token";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { ACCESS, FakeCerts, validJwt } from "./access-fixture";
import { cleanup, makeCtx } from "./setup-fixture";
import { CODE, login as setupLogin, startSetup, type Started } from "./setup-web-fixture";

const PASSWORD = "test-passwort-lang";
const PUBLIC = "https://app.tybo.ai";
const VISITOR = "203.0.113.7";

const root = await mkdtemp(join(tmpdir(), "tybo-access-rights-"));
const servers: WebServer[] = [];
const setups: Started[] = [];

afterEach(async () => {
  for (const s of setups.splice(0)) await s.server.stop();
});
afterAll(async () => {
  for (const s of servers.splice(0)) await s.stop();
  await rm(root, { recursive: true, force: true });
  await cleanup();
});

class RecordingChat implements WebChat {
  turns: RunTurnOptions[] = [];
  async runTurn(opts: RunTurnOptions) {
    this.turns.push(opts);
    return { text: "Antwort" };
  }
  stop() {}
}

let counter = 0;
async function startWeb() {
  const dir = join(root, `case-${++counter}`);
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const conversationId = (await store.createConversation("general")).id;
  const chat = new RecordingChat();
  const logs: string[] = [];
  const tokenFile = join(dir, "cli-token");
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [], publicOrigin: PUBLIC, access: ACCESS },
    {
      sessionFile: join(dir, "sessions.json"),
      conversationStore: store,
      chat,
      cliTokenFile: tokenFile,
      keepaliveMs: 60_000,
      accessCerts: new FakeCerts().fetch,
      log: m => logs.push(m),
    }
  );
  servers.push(server);
  const url = server.url;
  return { url, chat, conversationId, logs, cliToken: (await readCliToken(tokenFile))! };
}

function tunnel(extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: "app.tybo.ai",
    origin: PUBLIC,
    "cf-connecting-ip": VISITOR,
    "cf-access-jwt-assertion": validJwt(),
    ...extra,
  };
}

describe("Terminal-Schlüssel über den Tunnel", () => {
  test("gültiger Schlüssel und gültiger Access-Nachweis, aber getunnelt: 401", async () => {
    const ctx = await startWeb();
    const bearer = { authorization: `Bearer ${ctx.cliToken}` };
    expect((await fetch(`${ctx.url}/api/me`, { headers: { ...tunnel(), ...bearer } })).status).toBe(401);
    const post = await fetch(`${ctx.url}/api/conversations/${ctx.conversationId}/messages`, {
      method: "POST",
      headers: { ...tunnel(), ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ text: "vom Terminal?" }),
    });
    expect(post.status).toBe(401);
    // Auch ohne Origin (wie das Terminal) und mit lokalem Host-Namen
    const { origin: _, ...noOrigin } = tunnel();
    expect((await fetch(`${ctx.url}/api/commands`, { headers: { ...noOrigin, ...bearer } })).status).toBe(401);
    expect(ctx.chat.turns).toEqual([]);
    expect(ctx.logs).toContain(`Terminal-Anmeldung abgelehnt von ${VISITOR} (Tunnel)`);
    // Lokal gilt derselbe Schlüssel
    expect((await fetch(`${ctx.url}/api/me`, { headers: bearer })).status).toBe(200);
  });
});

describe("Einrichtungsmodus über den Tunnel", () => {
  async function start() {
    const s = await startSetup();
    setups.push(s);
    return s;
  }
  const localHost = (s: Started) => `127.0.0.1:${s.server.port}`;

  test("hasTunnelHeaders erkennt jede Tunnel-Kopfzeile, lokale Browser-Anfragen nicht", () => {
    expect(hasTunnelHeaders(new Request("http://127.0.0.1/", { headers: { host: "127.0.0.1", origin: "http://127.0.0.1" } }))).toBe(false);
    for (const h of TUNNEL_MARKER_HEADERS) {
      expect(hasTunnelHeaders(new Request("http://127.0.0.1/", { headers: { [h]: "x" } }))).toBe(true);
      expect(hasTunnelHeaders(new Request("http://127.0.0.1/", { headers: { [h]: "" } }))).toBe(true);
    }
  });

  test("lokaler Host, gültiger Code und Cookie, aber Tunnel-Kopfzeile: 403, jede Kopfzeile einzeln", async () => {
    const s = await start();
    const cookie = await setupLogin(s);
    for (const h of TUNNEL_MARKER_HEADERS) {
      const headers = { host: localHost(s), origin: s.origin, cookie, [h]: h === "cf-connecting-ip" ? VISITOR : "x" };
      const page = await fetch(`${s.base}/`, { headers, redirect: "manual" });
      expect({ h, status: page.status }).toEqual({ h, status: 403 });
      expect(await page.text()).toBe(SETUP_TUNNEL_TEXT);
      const overview = await fetch(`${s.base}/api/setup/overview`, { headers });
      expect(overview.status).toBe(403);
      expect(await overview.json()).toEqual({ error: SETUP_TUNNEL_TEXT });
      const code = await fetch(`${s.base}/api/setup/code`, { method: "POST", headers, body: JSON.stringify({ code: CODE }) });
      expect(code.status).toBe(403);
      expect(code.headers.get("set-cookie")).toBeNull();
      const done = await fetch(`${s.base}/api/setup/finish`, { method: "POST", headers, body: "{}" });
      expect(done.status).toBe(403);
    }
    expect(s.server.isFinished()).toBe(false);
    // Lokal bleibt alles erreichbar
    expect((await fetch(`${s.base}/api/setup/overview`, { headers: { cookie } })).status).toBe(200);
  });

  test("über den Tunnel falsche Codes: keine Sperre für den lokalen Zugang, kein Code-Log", async () => {
    const s = await start();
    for (let i = 0; i < 15; i++) {
      await fetch(`${s.base}/api/setup/code`, {
        method: "POST",
        headers: { host: localHost(s), origin: s.origin, "cf-connecting-ip": VISITOR },
        body: JSON.stringify({ code: "FALSCH99" }),
      });
    }
    expect(s.logs.some(l => l.includes("Falscher Einmal-Code"))).toBe(false);
    expect(s.logs).toContain("Einrichtung über den Tunnel abgelehnt");
    expect(await setupLogin(s)).toContain("tybo_setup=");
  });

  test("über runSetupMode mit WEB_PUBLIC_ORIGIN in der Umgebung und ohne: getunnelt 403", async () => {
    for (const env of [{}, { WEB_PUBLIC_ORIGIN: PUBLIC, WEB_ACCESS_TEAM: ACCESS.team, WEB_ACCESS_AUD: ACCESS.aud }]) {
      const ctx = await makeCtx({ env: "# leer\n" });
      let interrupt: () => void = () => {};
      let ready!: (info: { url: string; code: string }) => void;
      const started = new Promise<{ url: string; code: string }>(r => (ready = r));
      const done = runSetupMode({
        root: ctx.root,
        env,
        startMode: { mode: "setup", reason: "forced", missing: [] },
        supervisor: async () => null,
        ctx,
        code: CODE,
        port: 0,
        graceMs: 10,
        log: () => {},
        onInterrupt: h => ((interrupt = h), () => {}),
        onReady: ready,
      });
      const { url } = await started;
      const host = new URL(url).host;
      // Selbst ein gültiger Access-Nachweis öffnet den Einrichtungsmodus nicht
      const res = await fetch(`${url}/code`, { headers: { host, "cf-connecting-ip": VISITOR, "cf-access-jwt-assertion": validJwt() } });
      expect(res.status).toBe(403);
      expect((await fetch(`${url}/code`)).status).toBe(200);
      interrupt();
      expect(await done).toBe(130);
    }
  });
});
