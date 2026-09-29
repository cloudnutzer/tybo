/**
 * Issue #231, Checkbox 2: Weg Tailscale im Schritt „zugang“. `tailscale` ist
 * eine Attrappe mit Zustand (Serve-Einstellung ändert sich nach
 * `serve --bg`), HTTPS eine fetch-Attrappe. Nichts startet tailscale, nichts
 * geht ins Netz, die echte .env bleibt unberührt.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseEnvContent } from "../src/lib/env-file";
import type { CommandResult, CommandRunner, HttpFetch, RunOptions } from "../src/setup/context";
import type { RunEvent } from "../src/setup/model";
import { accessStep, ACCESS_NEEDS_WEBUI } from "../src/setup/steps/access";
import { MAC_APP_CLI, originFromStatus, serveStateFromJson, TAILSCALE_TEXT } from "../src/setup/tailscale";
import { webManifest } from "../src/web/manifest";
import { backupsOf, cleanup, FAKE, makeCtx } from "./setup-fixture";
import { linuxCtx, runWith, scripted } from "./setup-terminal-fixture";
import { get, login, post, startSetup, type Started } from "./setup-web-fixture";

const running: Started[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.server.stop();
});
afterAll(cleanup);

const HOST = "rechner.tailnet-beispiel.ts.net";
const ORIGIN = `https://${HOST}`;
const WEB_ON = `WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\n`;
const CF_ENV = "WEB_PUBLIC_ORIGIN=https://tybo.example.org\nWEB_ACCESS_TEAM=meinteam\nWEB_ACCESS_AUD=0123456789abcdef0123456789abcdef\n";

function statusJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: `${HOST}.` },
    CurrentTailnet: { Name: "beispiel", MagicDNSSuffix: "tailnet-beispiel.ts.net", MagicDNSEnabled: true },
    CertDomains: [HOST],
    ...over,
  });
}

function webuiServe(port = 3100) {
  return { TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } };
}

/** Laufendes `tailscale serve` ohne --bg: Einstellung unter Foreground je Sitzung */
function foregroundServe(proxy: string) {
  return { Foreground: { sitzung: { TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: proxy } } } } } } };
}

interface FakeTailscale {
  run: CommandRunner & { calls: string[][] };
  /** Aktuelle Serve-Einstellung (JSON-Objekt) */
  serve: Record<string, unknown>;
}

/**
 * tailscale-Attrappe: bin ist der Befehlsname, unter dem sie antwortet (sonst
 * ENOENT). Einzelne Antworten lassen sich ersetzen; `serve --bg` trägt die
 * Weiterleitung in die Serve-Einstellung ein.
 */
function fakeTailscale(
  options: {
    bin?: string;
    status?: Partial<CommandResult>;
    serveStatus?: Partial<CommandResult>;
    serveBg?: Partial<CommandResult>;
    serve?: Record<string, unknown>;
  } = {},
): FakeTailscale {
  const bin = options.bin ?? "tailscale";
  const state: FakeTailscale = { serve: options.serve ?? {}, run: null as never };
  const calls: string[][] = [];
  const run = (async (cmd: string[], _opts?: RunOptions) => {
    calls.push(cmd);
    if (cmd[0] === "git") return { code: 0, stdout: "git version 2.50.0", stderr: "" };
    if (cmd[0] !== bin) return { code: -1, stdout: "", stderr: "Befehl nicht gefunden", spawnError: "ENOENT" };
    const args = cmd.slice(1).join(" ");
    const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });
    if (args === "version") return ok("1.90.0");
    if (args === "status --json") return { ...ok(statusJson()), ...options.status };
    if (args === "serve status --json") return { ...ok(JSON.stringify(state.serve)), ...options.serveStatus };
    if (args.startsWith("serve --bg --https=443 ")) {
      if (options.serveBg) return { code: 1, stdout: "", stderr: "", ...options.serveBg };
      const target = cmd[cmd.length - 1];
      state.serve = { TCP: { "443": { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: target } } } } };
      return ok("Available within your tailnet");
    }
    return { code: 1, stdout: "", stderr: "unbekannt" };
  }) as CommandRunner & { calls: string[][] };
  run.calls = calls;
  state.run = run;
  return state;
}

/** HTTPS-Attrappe: Antwort je Aufruf, merkt sich die Adressen */
function fakeFetch(respond: (url: string) => Response | Promise<Response>): HttpFetch & { urls: string[] } {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    return respond(url);
  }) as HttpFetch & { urls: string[] };
  f.urls = urls;
  return f;
}

const manifestOk = () => new Response(JSON.stringify(webManifest()), { headers: { "content-type": "application/manifest+json" } });

async function ctxWith(env: string, ts: FakeTailscale, fetch: HttpFetch = fakeFetch(() => new Response("", { status: 421 })), extra: Record<string, unknown> = {}) {
  return makeCtx({ env, overrides: { run: ts.run as never, fetch, platform: "linux", ...extra } });
}

async function runStep(ctx: Awaited<ReturnType<typeof makeCtx>>, values: Record<string, string> = { ZUGANG_WEG: "tailscale" }) {
  const events: RunEvent[] = [];
  const result = await accessStep.run!(values, ctx, e => events.push(e), new AbortController().signal);
  return { result, events };
}

const serveCalls = (ts: FakeTailscale) => ts.run.calls.filter(c => c[1] === "serve" && c[2] === "--bg");

describe("Adresse aus tailscale status --json", () => {
  test("https plus Gerätename ohne Schlusspunkt, klein; ungültig oder nicht ts.net: null", () => {
    expect(originFromStatus(JSON.parse(statusJson()))).toBe(ORIGIN);
    expect(originFromStatus({ Self: { DNSName: "Rechner.Tailnet-Beispiel.TS.NET." } })).toBe(ORIGIN);
    expect(originFromStatus({ Self: { DNSName: "rechner.example.org." } })).toBeNull();
    expect(originFromStatus({ Self: { DNSName: "" } })).toBeNull();
    expect(originFromStatus({ Self: {} })).toBeNull();
    expect(originFromStatus(null)).toBeNull();
    expect(originFromStatus({ Self: { DNSName: "a b.ts.net." } })).toBeNull();
  });

  test("Serve-Einstellung: frei, genau die WebUI, belegt, Funnel, ungültig", () => {
    expect(serveStateFromJson({}, HOST, 3100)).toBe("frei");
    expect(serveStateFromJson(webuiServe(), HOST, 3100)).toBe("webui");
    expect(serveStateFromJson(webuiServe(), HOST, 3155)).toBe("belegt");
    expect(serveStateFromJson({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } }, HOST, 3100)).toBe("belegt");
    const twoPaths = { Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3100" }, "/grafana": { Proxy: "http://127.0.0.1:3000" } } } } };
    expect(serveStateFromJson(twoPaths, HOST, 3100)).toBe("belegt");
    expect(serveStateFromJson({ ...webuiServe(), AllowFunnel: { [`${HOST}:443`]: true } }, HOST, 3100)).toBe("funnel");
    expect(serveStateFromJson([], HOST, 3100)).toBeNull();
    expect(serveStateFromJson({ Foreground: [] }, HOST, 3100)).toBeNull();
    expect(serveStateFromJson({ Foreground: { sitzung: "x" } }, HOST, 3100)).toBeNull();
    expect(serveStateFromJson("x", HOST, 3100)).toBeNull();
  });

  // Vordergrund-Einstellungen (serve/funnel ohne --bg) liegen unter Foreground je Sitzung
  test("Serve-Einstellung im Vordergrund: belegt oder Funnel, nie frei oder WebUI", () => {
    expect(serveStateFromJson(foregroundServe("http://127.0.0.1:3000"), HOST, 3100)).toBe("belegt");
    expect(serveStateFromJson(foregroundServe("http://127.0.0.1:3100"), HOST, 3100)).toBe("belegt");
    expect(serveStateFromJson({ Foreground: { sitzung: { TCP: { "443": { TCPForward: "127.0.0.1:22" } } } } }, HOST, 3100)).toBe("belegt");
    expect(serveStateFromJson({ ...webuiServe(), ...foregroundServe("http://127.0.0.1:3100") }, HOST, 3100)).toBe("belegt");
    expect(serveStateFromJson({ Foreground: { sitzung: { AllowFunnel: { [`${HOST}:443`]: true } } } }, HOST, 3100)).toBe("funnel");
    expect(serveStateFromJson({ ...webuiServe(), Foreground: { sitzung: { AllowFunnel: { [`${HOST}:443`]: true } } } }, HOST, 3100)).toBe("funnel");
    // Leere Vordergrund-Einstellung oder anderer Port: frei
    expect(serveStateFromJson({ Foreground: {} }, HOST, 3100)).toBe("frei");
    expect(serveStateFromJson({ Foreground: null }, HOST, 3100)).toBe("frei");
    expect(serveStateFromJson({ Foreground: { sitzung: { TCP: { "8443": { HTTPS: true } } } } }, HOST, 3100)).toBe("frei");
  });
});

describe("Weg Tailscale: einrichten", () => {
  test("frei: serve mit genau diesen Argumenten, WEB_PUBLIC_ORIGIN aus status --json, Test ausstehend mit Befehl", async () => {
    const ts = fakeTailscale();
    const fetch = fakeFetch(() => new Response("Misdirected Request", { status: 421 }));
    const ctx = await ctxWith(WEB_ON, ts, fetch);
    const { result, events } = await runStep(ctx);
    expect(result.ok).toBe(true);
    expect(serveCalls(ts)).toEqual([["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:3100"]]);
    const env = parseEnvContent(await readFile(ctx.envPath, "utf8"));
    expect(env.WEB_PUBLIC_ORIGIN).toBe(ORIGIN);
    expect(result.changed).toContain("WEB_PUBLIC_ORIGIN");
    expect(result.message).toContain(`Adresse fürs Handy: ${ORIGIN}`);
    expect(result.message).toContain("Test über HTTPS ausstehend");
    expect(result.message).toContain("erst nach einem Neustart");
    expect(result.message).toContain(`curl -s ${ORIGIN}/manifest.webmanifest`);
    expect(fetch.urls).toEqual([`${ORIGIN}/manifest.webmanifest`]);
    expect(events.map(e => e.at)).toEqual([1, 2, 3, 4, 5]);
    // Nichts von Cloudflare
    expect(env.WEB_ACCESS_TEAM).toBeUndefined();
  });

  test("HTTPS antwortet mit dem Manifest: Test bestanden", async () => {
    const ts = fakeTailscale();
    const ctx = await ctxWith(WEB_ON, ts, fakeFetch(manifestOk));
    const { result } = await runStep(ctx);
    expect(result.ok).toBe(true);
    expect(result.message).toContain(`Test über HTTPS bestanden: tybo antwortet unter ${ORIGIN}.`);
  });

  test("irgendeine Antwort reicht nicht: fremde Seite mit 200 ist ein Fehlschlag", async () => {
    const ts = fakeTailscale();
    const ctx = await ctxWith(WEB_ON, ts, fakeFetch(() => new Response(JSON.stringify({ name: "anderes" }), { status: 200 })));
    const { result } = await runStep(ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Test über HTTPS fehlgeschlagen");
  });

  test("WebUI läuft nicht (502) oder noch kein Zertifikat (Netzfehler): ausstehend, kein Fehler", async () => {
    for (const respond of [() => new Response("", { status: 502 }), () => Promise.reject(new Error("TLS"))]) {
      const ts = fakeTailscale();
      const ctx = await ctxWith(WEB_ON, ts, fakeFetch(respond as never));
      const { result } = await runStep(ctx);
      expect(result.ok).toBe(true);
      expect(result.message).toContain("Test über HTTPS ausstehend");
    }
  });

  test("eigener WEB_PORT: Weiterleitung auf genau diesen Port", async () => {
    const ts = fakeTailscale();
    const ctx = await ctxWith(`${WEB_ON}WEB_PORT=3155\n`, ts);
    await runStep(ctx);
    expect(serveCalls(ts)).toEqual([["tailscale", "serve", "--bg", "--https=443", "http://127.0.0.1:3155"]]);
  });

  test("schon auf die WebUI eingerichtet: kein zweites serve, Adresse trotzdem geschrieben", async () => {
    const ts = fakeTailscale({ serve: webuiServe() });
    const ctx = await ctxWith(WEB_ON, ts);
    const { result, events } = await runStep(ctx);
    expect(result.ok).toBe(true);
    expect(serveCalls(ts)).toEqual([]);
    expect(events.find(e => e.at === 3)!.label).toBe("Weiterleitung ist schon eingerichtet");
    expect(parseEnvContent(await readFile(ctx.envPath, "utf8")).WEB_PUBLIC_ORIGIN).toBe(ORIGIN);
  });

  test("macOS ohne tailscale im PATH: nimmt die CLI der App", async () => {
    const ts = fakeTailscale({ bin: MAC_APP_CLI });
    const ctx = await ctxWith(WEB_ON, ts, undefined, { platform: "darwin" });
    const { result } = await runStep(ctx);
    expect(result.ok).toBe(true);
    expect(serveCalls(ts)[0][0]).toBe(MAC_APP_CLI);
  });

  test("Browser-Assistent: kein HTTPS-Test (er belegt den Port), ausstehend mit Begründung", async () => {
    const ts = fakeTailscale();
    const fetch = fakeFetch(manifestOk);
    const ctx = await ctxWith(WEB_ON, ts, fetch, { browserSetup: true });
    const { result } = await runStep(ctx);
    expect(result.ok).toBe(true);
    expect(fetch.urls).toEqual([]);
    expect(result.message).toContain("Der Einrichtungsassistent im Browser belegt gerade den Port der WebUI");
  });
});

describe("Weg Tailscale: Anleitung statt Fehler, nichts geändert", () => {
  const cases: Array<[string, Parameters<typeof fakeTailscale>[0], keyof typeof TAILSCALE_TEXT]> = [
    ["nicht installiert", { bin: "gibt-es-nicht" }, "install"],
    ["nicht angemeldet", { status: { stdout: statusJson({ BackendState: "NeedsLogin", Self: {} }) } }, "login"],
    ["abgemeldet mit Code 1", { status: { code: 1, stdout: statusJson({ BackendState: "NeedsLogin" }) } }, "login"],
    ["Dienst läuft nicht", { status: { code: 1, stdout: "", stderr: "failed to connect to local tailscaled; it doesn't appear to be running" } }, "daemon"],
    ["Zeitüberschreitung", { status: { code: -1, stdout: "", timedOut: true } }, "timeout"],
    ["ungültige Statusdaten", { status: { stdout: "kein json" } }, "invalid"],
    ["Status ohne BackendState", { status: { stdout: "{}" } }, "invalid"],
    ["MagicDNS aus", { status: { stdout: statusJson({ CurrentTailnet: { MagicDNSEnabled: false } }) } }, "magicDns"],
    ["HTTPS-Zertifikate aus", { status: { stdout: statusJson({ CertDomains: undefined }) } }, "https"],
    ["kein ts.net-Name", { status: { stdout: statusJson({ Self: { DNSName: "" } }) } }, "noName"],
    ["Serve-Status ungültig", { serveStatus: { stdout: "[" } }, "invalid"],
    ["Port 443 belegt", { serve: { TCP: { "443": { TCPForward: "127.0.0.1:22" } } } }, "busy"],
    ["Funnel an", { serve: { ...webuiServe(), AllowFunnel: { [`${HOST}:443`]: true } } }, "funnel"],
    ["Port 443 im Vordergrund belegt", { serve: foregroundServe("http://127.0.0.1:3000") }, "busy"],
    ["Funnel im Vordergrund an", { serve: { Foreground: { sitzung: { ...foregroundServe("http://127.0.0.1:3100").Foreground.sitzung, AllowFunnel: { [`${HOST}:443`]: true } } } } }, "funnel"],
    ["keine Berechtigung", { serveBg: { stderr: "Access denied: serve config denied" } }, "permission"],
    ["Freigabe fehlt (Zeitüberschreitung)", { serveBg: { code: -1, timedOut: true } }, "consent"],
    ["Freigabe fehlt (Link)", { serveBg: { stdout: "To enable, visit: https://login.tailscale.com/f/serve?node=abc" } }, "consent"],
  ];

  for (const [name, options, problem] of cases) {
    test(name, async () => {
      const ts = fakeTailscale(options);
      const env = `${WEB_ON}WEB_HOST=0.0.0.0\n`;
      const ctx = await ctxWith(env, ts);
      const { result } = await runStep(ctx);
      expect(result).toEqual({ ok: false, message: TAILSCALE_TEXT[problem], changed: [] });
      expect(await readFile(ctx.envPath, "utf8")).toBe(env);
      expect(await backupsOf(ctx)).toEqual([]);
      if (problem !== "permission" && problem !== "consent") expect(serveCalls(ts)).toEqual([]);
    });
  }

  test("Anleitungen nennen, was zu tun ist, und nie Text von tailscale", () => {
    expect(TAILSCALE_TEXT.install).toContain("Tailscale-App auch auf dem Handy");
    expect(TAILSCALE_TEXT.install).toContain("tybo setup zugang");
    expect(TAILSCALE_TEXT.login).toContain("sudo tailscale up");
    expect(TAILSCALE_TEXT.https).toContain("https://login.tailscale.com/admin/dns");
    expect(TAILSCALE_TEXT.permission).toContain("sudo tailscale set --operator=$USER");
    for (const t of Object.values(TAILSCALE_TEXT)) expect(t).not.toContain("—");
  });

  test("WebUI aus: kein tailscale-Aufruf", async () => {
    const ts = fakeTailscale();
    const ctx = await ctxWith("", ts);
    const { result } = await runStep(ctx);
    expect(result).toEqual({ ok: false, message: ACCESS_NEEDS_WEBUI, changed: [] });
    expect(ts.run.calls.filter(c => c[0] === "tailscale")).toEqual([]);
  });
});

describe("Weg Tailscale: Wechsel von Cloudflare", () => {
  test("ohne Bestätigung: nichts geändert, kein tailscale-Aufruf", async () => {
    const ts = fakeTailscale();
    const env = `${WEB_ON}${CF_ENV}`;
    const ctx = await ctxWith(env, ts);
    const { result } = await runStep(ctx, { ZUGANG_WEG: "tailscale", ZUGANG_ERSETZEN: "false" });
    expect(result).toEqual({ ok: true, message: "Nichts geändert: der vorhandene Zugang über Cloudflare Tunnel bleibt.", changed: [] });
    expect(await readFile(ctx.envPath, "utf8")).toBe(env);
    expect(ts.run.calls.filter(c => c[0] === "tailscale")).toEqual([]);
    expect(accessStep.plan!({ ZUGANG_WEG: "tailscale", ZUGANG_BISHER: "cloudflare", ZUGANG_ERSETZEN: "false" })).toEqual([
      "Nichts ändern: der vorhandene Zugang bleibt, wie er ist.",
    ]);
  });

  test("ohne Antwort auf die Rückfrage: Pflichtfeld, nichts geändert", async () => {
    const ts = fakeTailscale();
    const ctx = await ctxWith(`${WEB_ON}${CF_ENV}`, ts);
    const { result } = await runStep(ctx, { ZUGANG_WEG: "tailscale" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Vorhandenen Zugang ersetzen fehlt");
  });

  test("mit Bestätigung: Adresse ersetzt, Access-Werte entfernt, Tunnel nicht angefasst", async () => {
    const ts = fakeTailscale();
    const ctx = await ctxWith(`${WEB_ON}${CF_ENV}`, ts);
    const { result } = await runStep(ctx, { ZUGANG_WEG: "tailscale", ZUGANG_ERSETZEN: "true" });
    expect(result.ok).toBe(true);
    const env = parseEnvContent(await readFile(ctx.envPath, "utf8"));
    expect(env.WEB_PUBLIC_ORIGIN).toBe(ORIGIN);
    expect(env.WEB_ACCESS_TEAM).toBeUndefined();
    expect(env.WEB_ACCESS_AUD).toBeUndefined();
    expect(result.message).toContain("der Tunnel selbst ist unverändert");
    expect(ts.run.calls.some(c => c[0] === "cloudflared")).toBe(false);
  });
});

describe("Weg Tailscale: Prüfung ohne Änderung (Gesamtprüfung)", () => {
  test("eingerichtet und tybo antwortet: bestanden, ohne serve-Aufruf", async () => {
    const ts = fakeTailscale({ serve: webuiServe() });
    const ctx = await ctxWith(`${WEB_ON}WEB_PUBLIC_ORIGIN=${ORIGIN}\n`, ts, fakeFetch(manifestOk));
    const r = await accessStep.test!({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.message).toBe("Zugang über Tailscale funktioniert.");
    expect(serveCalls(ts)).toEqual([]);
  });

  test("Weiterleitung inzwischen entfernt: nicht bestanden, mit Hinweis zum Neueinrichten", async () => {
    const ts = fakeTailscale();
    const ctx = await ctxWith(`${WEB_ON}WEB_PUBLIC_ORIGIN=${ORIGIN}\n`, ts, fakeFetch(manifestOk));
    const r = await accessStep.test!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("tybo setup zugang");
  });

  test("nicht angemeldet: Anleitung", async () => {
    const ts = fakeTailscale({ status: { stdout: statusJson({ BackendState: "NeedsLogin" }) } });
    const ctx = await ctxWith(`${WEB_ON}WEB_PUBLIC_ORIGIN=${ORIGIN}\n`, ts);
    expect(await accessStep.test!({}, ctx)).toEqual({ ok: false, message: TAILSCALE_TEXT.login });
  });
});

describe("Oberflächen", () => {
  test("Terminal: tybo setup zugang, Enter wählt Tailscale, Plan, Ausführen, Adresse", async () => {
    const ts = fakeTailscale();
    const ctx = await linuxCtx({ env: WEB_ON });
    ctx.run = ts.run as never;
    ctx.fetch = fakeFetch(() => new Response("", { status: 421 }));
    const prompter = scripted(["", ""]);
    const r = await runWith({ mode: "step", step: "zugang" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(prompter.asked.map(a => a.question)).toEqual([expect.stringContaining("Weg vom Handy"), "Jetzt ausführen? [J/n] "]);
    expect(r.out).toContain("Das passiert jetzt:");
    expect(r.out).toContain("tailscale serve --bg --https=443");
    expect(r.out).toContain(`Adresse fürs Handy: ${ORIGIN}`);
    expect(parseEnvContent(await readFile(ctx.envPath, "utf8")).WEB_PUBLIC_ORIGIN).toBe(ORIGIN);
  });

  test("Terminal: nicht angemeldet, Anleitung statt Fehler, überspringen", async () => {
    const ts = fakeTailscale({ status: { stdout: statusJson({ BackendState: "NeedsLogin" }) } });
    const ctx = await linuxCtx({ env: WEB_ON });
    ctx.run = ts.run as never;
    const r = await runWith({ mode: "step", step: "zugang" }, ctx, scripted(["", "", "ü"]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Tailscale ist nicht angemeldet.");
    expect(r.out).not.toContain("Error");
    expect(await readFile(ctx.envPath, "utf8")).toBe(WEB_ON);
  });

  test("Browser: Ablauf über die API, Ergebnis mit Adresse, HTTPS-Test ausstehend", async () => {
    const ts = fakeTailscale();
    const ctx = await makeCtx({ env: `TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=${FAKE.userId}\n${WEB_ON}`, overrides: { run: ts.run as never, platform: "linux" } });
    const s = await startSetup({ ctx });
    running.push(s);
    const cookie = await login(s);
    const view = await (await post(s, "/api/setup/steps/zugang/view", { values: { ZUGANG_WEG: "tailscale" } }, cookie)).json();
    expect((view as any).mode).toBe("ablauf");
    const started = (await (await post(s, "/api/setup/steps/zugang/run", { values: { ZUGANG_WEG: "tailscale" } }, cookie)).json()) as any;
    let res: any = null;
    for (let i = 0; i < 400; i++) {
      res = await (await get(s, `/api/setup/runs/${started.runId}`, cookie)).json();
      if (res.state !== "laeuft") break;
      await Bun.sleep(5);
    }
    expect(res.result.ok).toBe(true);
    expect(res.result.message).toContain(`Adresse fürs Handy: ${ORIGIN}`);
    expect(res.result.message).toContain("Der Einrichtungsassistent im Browser belegt gerade den Port der WebUI");
    expect(serveCalls(ts)).toHaveLength(1);
    expect(parseEnvContent(await readFile(ctx.envPath, "utf8")).WEB_PUBLIC_ORIGIN).toBe(ORIGIN);
  });
});
