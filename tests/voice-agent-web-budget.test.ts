/**
 * Issue #494, Minutenbudget je Rezept: Reservierung von maxMinuten vor dem
 * Anbieteraufruf, Buchung der tatsächlichen Zeit nach dem Ende, Monatswechsel,
 * dauerhafte Ablage. Dazu: ohne Login 401, auch für die Gesprächsseite.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attach, monthStart, nextMonthStart, readWebSessions, reserve, settle, usedMinutes, WEB_SESSION_SLACK_MS, WEB_SESSION_TOKEN_MS, type WebSessionFile } from "../src/lib/voice-agents/web-sessions";
import type { WebServer } from "../src/web/server";
import { readyAgent, removeSessionWorlds, sessionServer, sessionWorld, START } from "./voice-agent-session-fixture";

const root = await mkdtemp(join(tmpdir(), "voice-agent-budget-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  removeSessionWorlds();
});
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

const empty = (): WebSessionFile => ({ sitzungen: [], versuche: [] });
/** Ablauf eines bei START ausgegebenen Tokens, wie ElevenLabs ihn nennt (exp nach 15 Minuten) */
const TOKEN_BIS = START + WEB_SESSION_TOKEN_MS;

describe("Minutenbudget: reine Regeln", () => {
  test("Reservierung bucht maxMinuten, bestätigtes Ende die angefangenen Minuten laut Anbieter", () => {
    const r = reserve(empty(), { now: START, id: "a", maxMinuten: 12, minutenMonat: 30 });
    if (r.status !== "ok") throw new Error(r.status);
    expect(usedMinutes(r.data, START)).toBe(12);
    // Harte Grenze: Tokenablauf plus maxMinuten plus Zuschlag
    expect(r.session.tokenBis).toBe(START + WEB_SESSION_TOKEN_MS);
    expect(r.session.bis).toBe(START + WEB_SESSION_TOKEN_MS + 12 * 60_000 + WEB_SESSION_SLACK_MS);
    // Die Dauer zählt, nicht der Zeitpunkt der Meldung
    const done = settle(attach(r.data, "a", "conv_1", TOKEN_BIS), START + 9 * 60_000, "conv_1", { status: "beendet", dauerSek: 181 });
    if (done.status !== "beendet") throw new Error(done.status);
    expect(done.session.minuten).toBe(4);
    expect(usedMinutes(done.data, START)).toBe(4);
  });

  test("bestätigtes Ende: mindestens eine Minute, höchstens die reservierten, ohne Dauer die reservierten", () => {
    const r = reserve(empty(), { now: START, id: "a", maxMinuten: 12, minutenMonat: 30 });
    if (r.status !== "ok") throw new Error(r.status);
    const data = attach(r.data, "a", "conv_1", TOKEN_BIS);
    const quick = settle(data, START, "conv_1", { status: "beendet", dauerSek: 0 });
    expect(quick.status === "beendet" && quick.session.minuten).toBe(1);
    const long = settle(data, START + 16 * 60_000, "conv_1", { status: "beendet", dauerSek: 20 * 60 });
    expect(long.status === "beendet" && long.session.minuten).toBe(12);
    const unknown = settle(data, START, "conv_1", { status: "beendet", dauerSek: null });
    expect(unknown.status === "beendet" && unknown.session.minuten).toBe(12);
  });

  test("ohne Nachweis bleibt alles offen: aktiv, unklar, unbekannt vor Tokenablauf; unbekannt danach: nie zustande gekommen, null Minuten", () => {
    const r = reserve(empty(), { now: START, id: "a", maxMinuten: 12, minutenMonat: 30 });
    if (r.status !== "ok") throw new Error(r.status);
    const data = attach(r.data, "a", "conv_1", TOKEN_BIS);
    for (const provider of [{ status: "aktiv" }, { status: "unklar" }, { status: "unbekannt" }] as const) {
      expect(settle(data, START + 5 * 60_000, "conv_1", provider).status).toBe("offen");
    }
    const tokenGone = START + WEB_SESSION_TOKEN_MS + WEB_SESSION_SLACK_MS;
    expect(settle(data, tokenGone - 1, "conv_1", { status: "unbekannt" }).status).toBe("offen");
    const never = settle(data, tokenGone, "conv_1", { status: "unbekannt" });
    expect(never.status === "beendet" && never.session.minuten).toBe(0);
    // Aktiv nach Tokenablauf: weiter offen, bis zur harten Grenze
    expect(settle(data, tokenGone, "conv_1", { status: "aktiv" }).status).toBe("offen");
  });

  test("ohne bestätigtes Ende bleiben die reservierten Minuten gebucht, auch nach der harten Grenze", () => {
    const r = reserve(empty(), { now: START, id: "a", maxMinuten: 12, minutenMonat: 30 });
    if (r.status !== "ok") throw new Error(r.status);
    const later = START + 60 * 60_000;
    expect(settle(attach(r.data, "a", "conv_1", TOKEN_BIS), later, "conv_1", { status: "beendet", dauerSek: 60 }).status).toBe("kein_gespraech");
    expect(usedMinutes(r.data, later)).toBe(12);
  });

  test("Ablauf aus dem Token: die harte Grenze folgt exp, nie verkürzt; unlesbar, abgelaufen oder über 60 Minuten: kein Ablauf (null), nie ein Ersatzwert", async () => {
    const { tokenExpiry, WEB_SESSION_TOKEN_MAX_MS } = await import("../src/lib/voice-agents/web-sessions");
    const jwt = (payload: unknown) => `kopf.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signatur`;
    const startSec = Math.floor(START / 1000);
    const exp = startSec + 30 * 60;
    expect(tokenExpiry(jwt({ exp }), START)).toBe(exp * 1000);
    // Genau an der Obergrenze noch übernommen, wie es ist
    expect(tokenExpiry(jwt({ exp: startSec + 60 * 60 }), START)).toBe(START + WEB_SESSION_TOKEN_MAX_MS);
    const unusable = [
      "gespraechstoken-1",
      jwt({}),
      jwt({ exp: "morgen" }),
      jwt({ exp: 1.5e9 + 0.5 }),
      jwt({ exp: startSec }),
      jwt({ exp: startSec - 1 }),
      jwt({ exp: startSec + 60 * 60 + 1 }),
      jwt({ exp: startSec + 120 * 60 }),
      "a.%%%.b",
      "a.b",
    ];
    for (const token of unusable) expect(tokenExpiry(token, START)).toBeNull();
    const r = reserve(empty(), { now: START, id: "a", maxMinuten: 12, minutenMonat: 30 });
    if (r.status !== "ok") throw new Error(r.status);
    const [session] = attach(r.data, "a", "conv_1", exp * 1000).sitzungen;
    expect(session).toMatchObject({ gespraech: "conv_1", tokenBis: exp * 1000, bis: exp * 1000 + 12 * 60_000 + WEB_SESSION_SLACK_MS });
  });

  test("Budget reicht nicht für maxMinuten: abgelehnt bis zum Monatsanfang", () => {
    let data = empty();
    let now = START;
    for (const id of ["a", "b"]) {
      const r = reserve(data, { now, id, maxMinuten: 12, minutenMonat: 30 });
      if (r.status !== "ok") throw new Error(r.status);
      data = r.data;
      // Nach der harten Grenze (Token 15 + 12 + 1 Minuten) ist der Platz frei, die Minuten bleiben
      now += 30 * 60_000;
    }
    const blocked = reserve(data, { now, id: "c", maxMinuten: 12, minutenMonat: 30 });
    expect(blocked.status).toBe("budget");
    if (blocked.status === "budget") {
      expect(blocked.verbraucht).toBe(24);
      expect(blocked.retryAfterSec).toBe(Math.ceil((nextMonthStart(now) - now) / 1000));
    }
  });

  test("Monatswechsel: neuer Monat beginnt bei null, alte Gespräche fallen heraus", () => {
    const r = reserve(empty(), { now: START, id: "a", maxMinuten: 30, minutenMonat: 30 });
    if (r.status !== "ok") throw new Error(r.status);
    expect(reserve(r.data, { now: START + 60 * 60_000, id: "b", maxMinuten: 30, minutenMonat: 30 }).status).toBe("budget");
    const nextMonth = nextMonthStart(START) + 14 * 24 * 3_600_000;
    expect(monthStart(nextMonth)).toBe(nextMonthStart(START));
    expect(usedMinutes(r.data, nextMonth)).toBe(0);
    const again = reserve(r.data, { now: nextMonth, id: "b", maxMinuten: 30, minutenMonat: 30 });
    expect(again.status).toBe("ok");
    if (again.status === "ok") expect(again.data.sitzungen.map((s) => s.id)).toEqual(["b"]);
  });

  test("Ende mit fremder Gesprächs-ID trifft nichts", () => {
    const r = reserve(empty(), { now: START, id: "a", maxMinuten: 12, minutenMonat: 30 });
    if (r.status !== "ok") throw new Error(r.status);
    const data = { ...r.data, sitzungen: r.data.sitzungen.map((s) => ({ ...s, gespraech: "conv_1" })) };
    const ended = { status: "beendet", dauerSek: 60 } as const;
    expect(settle(data, START + 60_000, "conv_2", ended).status).toBe("kein_gespraech");
    expect(settle(data, START + 60_000, "conv_1", ended).status).toBe("beendet");
  });
});

describe("Minutenbudget über den Server", () => {
  test("aufgebraucht: 429 budget mit Retry-After, kein Aufruf beim Anbieter; neuer Monat geht wieder", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte", (raw) => {
      raw.zugang.maxMinuten = 10;
      raw.zugang.budget.minutenMonat = 25;
    });
    const ctx = await sessionServer(root, servers, w);
    const start = () => ctx.api("/api/voice-agents/experte/session", "POST", {});
    expect((await start()).status).toBe(200);
    w.clock.now += 9 * 60_000 + 30_000;
    w.hangUp("conv_1");
    const ended = await ctx.api("/api/voice-agents/experte/session/end", "POST", { conversationId: "conv_1" });
    expect(await ended.json()).toEqual({ ok: true, minuten: 10 });
    // Zweites Gespräch ohne bestätigtes Ende: bleibt mit 10 Minuten gebucht, auch
    // nach der harten Grenze (Token 15 + 10 Minuten + Zuschlag)
    expect((await start()).status).toBe(200);
    w.clock.now += 27 * 60_000;
    const info = await (await ctx.api("/api/voice-agents/experte")).json();
    expect(info.minuten).toEqual({ verbraucht: 20, limit: 25 });
    // 20 + 10 > 25: abgelehnt, ohne Anbieteraufruf
    const blocked = await start();
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ reason: "budget" });
    expect(Number(blocked.headers.get("retry-after"))).toBe(Math.ceil((nextMonthStart(w.clock.now) - w.clock.now) / 1000));
    expect(w.calls).toHaveLength(2);
    // Nächster Monat
    w.clock.now = nextMonthStart(w.clock.now) + 10 * 24 * 3_600_000;
    expect((await start()).status).toBe(200);
  });

  test("Verbrauch steht in der Datei und übersteht einen Neustart", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    const first = await sessionServer(root, servers, w);
    expect((await first.api("/api/voice-agents/experte/session", "POST", {})).status).toBe(200);
    w.clock.now += 4 * 60_000;
    w.hangUp("conv_1");
    expect((await first.api("/api/voice-agents/experte/session/end", "POST", { conversationId: "conv_1" })).status).toBe(200);
    expect(usedMinutes(await readWebSessions("experte", w.paths), w.clock.now)).toBe(4);
    const restarted = await sessionServer(root, servers, w);
    const info = await (await restarted.api("/api/voice-agents/experte")).json();
    expect(info.minuten).toEqual({ verbraucht: 4, limit: 300 });
  });

  test("Ende ohne laufendes Gespräch: 404, ungültige Gesprächs-ID: 400", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    const ctx = await sessionServer(root, servers, w);
    expect((await ctx.api("/api/voice-agents/experte/session/end", "POST", { conversationId: "conv_1" })).status).toBe(404);
    expect((await ctx.api("/api/voice-agents/experte/session/end", "POST", { conversationId: "../x y" })).status).toBe(400);
    expect((await ctx.api("/api/voice-agents/experte/session/end", "POST", "kein json")).status).toBe(400);
  });

  test("Ende nimmt die Web-Freigabe der Brücke zurück", async () => {
    const { verifyWebCall } = await import("../src/lib/voice-agents/web-calls");
    const { bridge, BRIDGE_TOKEN } = await import("./voice-agent-session-fixture");
    const w = sessionWorld();
    await readyAgent(w, "jarvis", bridge);
    const ctx = await sessionServer(root, servers, w);
    const { conversationId } = await (await ctx.api("/api/voice-agents/jarvis/session", "POST", {})).json();
    const options = { ...w.paths, token: BRIDGE_TOKEN, now: () => w.clock.now };
    expect(await verifyWebCall({ kennung: "jarvis", conversationId }, options)).toBe(true);
    w.hangUp(conversationId);
    expect((await ctx.api("/api/voice-agents/jarvis/session/end", "POST", { conversationId })).status).toBe(200);
    expect(await verifyWebCall({ kennung: "jarvis", conversationId }, options)).toBe(false);
  });
});

describe("ohne Login: 401", () => {
  test("Gesprächsseite, Zustand, Start und Ende antworten 401; die Seite nennt den Weg zur Anmeldung", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    const ctx = await sessionServer(root, servers, w);
    const page = await fetch(`${ctx.origin}/sa/experte`, { redirect: "manual" });
    expect(page.status).toBe(401);
    expect(page.headers.get("location")).toBeNull();
    expect(await page.text()).toContain('href="/login"');
    expect((await fetch(`${ctx.origin}/api/voice-agents/experte`)).status).toBe(401);
    for (const sub of ["session", "session/end"]) {
      const res = await fetch(`${ctx.origin}/api/voice-agents/experte/${sub}`, { method: "POST", headers: { origin: ctx.origin }, body: "{}" });
      expect(res.status).toBe(401);
    }
    // Auch für unbekannte Kennungen verrät die Seite ohne Login nichts
    expect((await fetch(`${ctx.origin}/sa/gibtsnicht`, { redirect: "manual" })).status).toBe(401);
    expect(w.calls).toEqual([]);
  });

  test("angemeldet: Seite für Rezepte mit Web-Zugang, 404 für unbekannte und ohne Web-Zugang", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    await readyAgent(w, "intern", (raw) => {
      raw.zugang.web = { link: false };
    });
    const ctx = await sessionServer(root, servers, w);
    const ok = await ctx.api("/sa/experte");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("/sprachagent.js");
    expect((await ctx.api("/sa/intern")).status).toBe(404);
    expect((await ctx.api("/sa/gibtsnicht")).status).toBe(404);
    expect((await ctx.api("/sa/experte", "POST", {})).status).toBe(405);
  });

  test("Zustand: bereit mit Name und Grenzen, gesperrt mit Grund", async () => {
    const w = sessionWorld();
    await readyAgent(w, "experte");
    await readyAgent(w, "neu");
    await rm(join(w.paths.dataDir, "neu", "freischaltung.json"));
    const ctx = await sessionServer(root, servers, w);
    expect(await (await ctx.api("/api/voice-agents/experte")).json()).toEqual({
      kennung: "experte",
      name: "Experte",
      gehirn: "anbieter",
      maxMinuten: 12,
      minuten: { verbraucht: 0, limit: 300 },
      laufend: null,
      bereit: true,
    });
    expect(await (await ctx.api("/api/voice-agents/neu")).json()).toMatchObject({ bereit: false, reason: "gesperrt" });
    expect((await ctx.api("/api/voice-agents/gibtsnicht")).status).toBe(404);
    expect((await ctx.api("/api/voice-agents/experte", "POST", {})).status).toBe(405);
  });

  test("ohne Port: Seite und Routen 503", async () => {
    const { topicServer } = await import("./topic-fixture");
    const ctx = await topicServer(root, servers, null);
    expect((await ctx.api("/sa/experte")).status).toBe(503);
    expect((await ctx.api("/api/voice-agents/experte/session", "POST", {})).status).toBe(503);
  });
});

describe("Adresse für /sprachagent link (Issue #494)", () => {
  test("WEB_PUBLIC_ORIGIN vor LAN-Adresse vor Host; WebUI aus: keine Adresse", async () => {
    const { webUiBaseUrl } = await import("../src/web/startup");
    const base = { WEB_ENABLED: "true", WEB_PASSWORD: "ein-langes-passwort" };
    const lan = () => ["192.168.1.5"];
    expect(webUiBaseUrl({ ...base, WEB_PUBLIC_ORIGIN: "https://rechner.tailnet.ts.net" }, lan)).toBe("https://rechner.tailnet.ts.net");
    expect(webUiBaseUrl({ ...base, WEB_HOST: "0.0.0.0" }, lan)).toBe("http://192.168.1.5:3100");
    expect(webUiBaseUrl({ ...base, WEB_HOST: "0.0.0.0" }, () => [])).toBe("http://localhost:3100");
    expect(webUiBaseUrl({ ...base, WEB_PORT: "3199" }, lan)).toBe("http://127.0.0.1:3199");
    expect(webUiBaseUrl({ WEB_ENABLED: "false" }, lan)).toBeNull();
    expect(webUiBaseUrl({ WEB_ENABLED: "true" }, lan)).toBeNull();
  });
});
