/**
 * Issue #495, Aufgabe 3: Verwaltung der Sprachagenten für die WebUI. Echter
 * Manager (manage.ts) mit Attrappe der Sprachschicht, echte Routen des
 * Web-Servers; kein Anbieter, kein src/bot.ts.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVoiceAgentManager } from "../src/lib/voice-agents/manage";
import { recordVersion } from "../src/lib/voice-agents/state";
import { createVoiceAgentAdmin } from "../src/web/bot-voice-agent-admin";
import { createDemoVoiceAgents } from "../src/web/demo-voice-agents";
import type { WebServer } from "../src/web/server";
import { parseVersionParam, VOICE_AGENT_ADMIN_TEXT } from "../src/web/voice-agent-admin";
import { topicServer } from "./topic-fixture";
import { deployed, manageHarness, removeHarnessDirs, writeRecipe } from "./voice-agents-manage-fixture";

const root = await mkdtemp(join(tmpdir(), "voice-agent-admin-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  removeHarnessDirs();
});
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

async function setup(options: { withLayer?: boolean } = {}) {
  const h = manageHarness({ withLayer: options.withLayer, deps: { webBase: () => "http://tybo.local:3100", isUnlocked: async () => true } });
  const admin = createVoiceAgentAdmin({
    manager: h.manager,
    paths: h.paths,
    testResults: () => ({ type: "telegram", chatId: "web" }),
    log: (line) => void h.logs.push(line),
  });
  const ctx = await topicServer(root, servers, null, { voiceAgentAdmin: admin });
  return { h, admin, ctx };
}

describe("Liste und Detail", () => {
  test("Liste wie /sprachagent liste, beschädigte Rezepte nur mit Dateinamen", async () => {
    const { h, ctx } = await setup();
    writeRecipe(h, "jarvis");
    await deployed(h, "jarvis");
    writeFileSync(join(h.paths.configDir, "kaputt.json"), "{}\n");
    const res = await ctx.api("/api/voice-agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents.map((a: any) => [a.kennung, a.name, a.angelegt, a.web, a.minutenMonat])).toEqual([["jarvis", "Jarvis", true, true, 300]]);
    expect(body.kaputt).toHaveLength(1);
    expect(body.kaputt[0].datei).toBe("kaputt.json");
    // Kein Pfad und keine Kennung beim Anbieter im Browser
    expect(JSON.stringify(body)).not.toContain(h.paths.configDir);
    expect(JSON.stringify(body)).not.toContain("agent-jarvis");
  });

  test("leere Liste ohne Rezepte", async () => {
    const { ctx } = await setup();
    const body = await (await ctx.api("/api/voice-agents")).json();
    expect(body).toEqual({ agents: [], kaputt: [] });
  });

  test("Detail: Rezept in Klartext, Versionen mit der aktuellen markiert, ältere Version lesbar", async () => {
    const { h, ctx } = await setup();
    const first = writeRecipe(h, "jarvis");
    await recordVersion("jarvis", first, h.paths);
    const second = writeRecipe(h, "jarvis", (raw) => (raw.zweck = "Neuer Zweck."));
    await recordVersion("jarvis", second, h.paths);
    const res = await ctx.api("/api/voice-agents/jarvis/rezept");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rezept[0].titel).toBe("Allgemein");
    expect(body.rezept[0].zeilen).toContainEqual({ feld: "Zweck", wert: "Neuer Zweck." });
    // Klartext, nicht das JSON des Rezepts
    expect(JSON.stringify(body.rezept)).not.toContain("\"persona\"");
    expect(body.versionen).toEqual([
      { version: 2, aktuell: true, lesbar: true },
      { version: 1, aktuell: false, lesbar: true },
    ]);
    expect(body.minutenWeb).toBeNull();
    expect(body.maxMinuten).toBe(12);
    const old = await (await ctx.api("/api/voice-agents/jarvis/rezept?version=1")).json();
    expect(old.version).toBe(1);
    expect(old.rezept[0].zeilen).toContainEqual({ feld: "Zweck", wert: "Hilft im Alltag." });
    expect((await ctx.api("/api/voice-agents/jarvis/rezept?version=7")).status).toBe(404);
    expect((await ctx.api("/api/voice-agents/jarvis/rezept?version=abc")).status).toBe(404);
  });

  test("Detail: unbekannt 404, beschädigt 422, ungültige Kennung 404", async () => {
    const { h, ctx } = await setup();
    writeRecipe(h, "jarvis");
    writeFileSync(join(h.paths.configDir, "kaputt.json"), "{}\n");
    expect((await ctx.api("/api/voice-agents/gibtsnicht/rezept")).status).toBe(404);
    const broken = await ctx.api("/api/voice-agents/kaputt/rezept");
    expect(broken.status).toBe(422);
    expect((await broken.json()).error).toBe(VOICE_AGENT_ADMIN_TEXT.broken);
    expect((await ctx.api("/api/voice-agents/..%2F..%2Fetc/rezept")).status).toBe(404);
  });

  test("[P2] Detail bei langsamem Anbieter: Antwort nach mehr als Buns zehn Sekunden Ruhezeit, mit Minuten", async () => {
    const h = manageHarness();
    writeRecipe(h, "jarvis");
    const demo = createDemoVoiceAgents();
    // Wie die Gesprächsroute mit einem offenen Gespräch: Statusabruf mit voller Zeitgrenze und mehr.
    // Ohne keepOpen() schließt Bun die Verbindung nach zehn Sekunden Ruhe (der Abruf käme ein zweites Mal oder gar nicht an)
    let infoCalls = 0;
    const sessions = { ...demo.sessions, info: async (kennung: string) => (infoCalls++, await Bun.sleep(12_500), demo.sessions.info(kennung)) };
    const admin = createVoiceAgentAdmin({ manager: h.manager, paths: h.paths, sessions, minutesTimeoutMs: 20_000, testResults: () => ({ type: "telegram", chatId: "web" }), log: () => {} });
    const ctx = await topicServer(root, servers, null, { voiceAgentAdmin: admin });
    const res = await ctx.api("/api/voice-agents/jarvis/rezept");
    expect(res.status).toBe(200);
    expect((await res.json()).minutenWeb).toEqual({ limit: 300, verbraucht: 14 });
    expect(infoCalls).toBe(1);
  }, 40_000);

  test("[P2] Detail bei ausfallendem Anbieter: ohne Minuten nach der Frist, Fehler ebenso", async () => {
    const h = manageHarness();
    writeRecipe(h, "jarvis");
    const logs: string[] = [];
    const hanging = { ...createDemoVoiceAgents().sessions, info: () => new Promise<never>(() => {}) };
    const admin = createVoiceAgentAdmin({ manager: h.manager, paths: h.paths, sessions: hanging, minutesTimeoutMs: 50, testResults: () => ({ type: "telegram", chatId: "web" }), log: (l) => void logs.push(l) });
    const ctx = await topicServer(root, servers, null, { voiceAgentAdmin: admin });
    const res = await ctx.api("/api/voice-agents/jarvis/rezept");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.minutenWeb).toBeNull();
    expect(body.rezept[0].titel).toBe("Allgemein");
    expect(logs.some((l) => l.includes("Minuten: keine Antwort"))).toBe(true);
    const failing = { ...createDemoVoiceAgents().sessions, info: () => Promise.reject(new Error("Anbieter weg")) };
    const admin2 = createVoiceAgentAdmin({ manager: h.manager, paths: h.paths, sessions: failing, testResults: () => ({ type: "telegram", chatId: "web" }), log: () => {} });
    expect((await admin2.detail("jarvis", null)).body.minutenWeb).toBeNull();
  });

  test("Minuten im Browser aus der Gesprächsroute, nur mit Web-Zugang", async () => {
    const h = manageHarness();
    writeRecipe(h, "jarvis");
    const demo = createDemoVoiceAgents();
    const admin = createVoiceAgentAdmin({ manager: h.manager, paths: h.paths, sessions: demo.sessions, testResults: () => ({ type: "telegram", chatId: "web" }), log: () => {} });
    const detail = await admin.detail("jarvis", null);
    expect(detail.body.minutenWeb).toEqual({ limit: 300, verbraucht: 14 });
  });
});

describe("Testen, Link, Löschen", () => {
  test("Testen startet den Lauf, meldet in den Direktchat und zeigt danach den letzten Lauf", async () => {
    const { h, ctx } = await setup();
    writeRecipe(h, "jarvis");
    await deployed(h, "jarvis");
    const res = await ctx.api("/api/voice-agents/jarvis/test", "POST", {});
    expect(res.status).toBe(202);
    await h.manager.settled();
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0].conversation).toEqual({ type: "telegram", chatId: "web" });
    const body = await (await ctx.api("/api/voice-agents/jarvis/rezept")).json();
    expect(body.letzterTest.ergebnis).toBe("bestanden");
    expect(body.laufenderTest).toBeNull();
  });

  test("[P2] letzte Testläufe: mehrere Ergebnisse, auch nach Neuladen (neuer Prozess); höchstens fünf", async () => {
    const { h, ctx } = await setup();
    writeRecipe(h, "jarvis");
    await deployed(h, "jarvis");
    const outcomes = ["bestanden", "durchgefallen", "bestanden", "bestanden", "durchgefallen", "bestanden"] as const;
    for (const [i, gesamt] of outcomes.entries()) {
      h.layer.runResult = { status: "gestartet", runId: `lauf-${i + 1}` };
      h.layer.result = { status: "fertig", gesamt, tests: [{ testId: "t1", name: "Erster", status: gesamt === "bestanden" ? "bestanden" : "durchgefallen" }] } as any;
      expect((await ctx.api("/api/voice-agents/jarvis/test", "POST", {})).status).toBe(202);
      await h.manager.settled();
    }
    // Neu geladen: ein frischer Manager über dieselbe Ablage, wie nach einem Neustart des Bots
    const manager = createVoiceAgentManager({ layer: () => null, paths: h.paths, sendChoice: async () => ({ sent: false }), notify: async () => {}, log: () => {} });
    const admin = createVoiceAgentAdmin({ manager, paths: h.paths, testResults: () => ({ type: "telegram", chatId: "web" }), log: () => {} });
    const fresh = await topicServer(root, servers, null, { voiceAgentAdmin: admin });
    const body = await (await fresh.api("/api/voice-agents/jarvis/rezept")).json();
    expect(body.letzterTest.runId).toBe("lauf-6");
    expect(body.fruehereTests.map((r: any) => [r.runId, r.ergebnis])).toEqual([
      ["lauf-5", "durchgefallen"],
      ["lauf-4", "bestanden"],
      ["lauf-3", "bestanden"],
      ["lauf-2", "durchgefallen"],
    ]);
    // Die Liste bleibt schlank, /sprachagent liste unverändert
    const list = await (await fresh.api("/api/voice-agents")).json();
    expect(list.agents[0].fruehereTests).toBeUndefined();
    expect(list.agents[0].letzterTest.runId).toBe("lauf-6");
  });

  test("Testen: nicht angelegt 409, ohne Anbieter 503, unbekannt 404", async () => {
    const { h, ctx } = await setup();
    writeRecipe(h, "jarvis");
    expect((await ctx.api("/api/voice-agents/jarvis/test", "POST", {})).status).toBe(409);
    expect((await ctx.api("/api/voice-agents/gibtsnicht/test", "POST", {})).status).toBe(404);
    const without = await setup({ withLayer: false });
    writeRecipe(without.h, "jarvis");
    const res = await without.ctx.api("/api/voice-agents/jarvis/test", "POST", {});
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe("kein_anbieter");
  });

  test("Link wie /sprachagent link; ohne Web-Zugang 409", async () => {
    const { h, ctx } = await setup();
    writeRecipe(h, "jarvis");
    writeRecipe(h, "empfang", (raw) => (raw.zugang.web = { link: false }));
    const res = await ctx.api("/api/voice-agents/jarvis/link", "POST", {});
    expect(await res.json()).toEqual({ url: "http://tybo.local:3100/sa/jarvis" });
    const none = await ctx.api("/api/voice-agents/empfang/link", "POST", {});
    expect(none.status).toBe(409);
    expect((await none.json()).reason).toBe("kein_web");
  });

  test("Löschen nur mit Bestätigung; danach archiviert und aus der Liste", async () => {
    const { h, ctx } = await setup();
    writeRecipe(h, "jarvis");
    await deployed(h, "jarvis");
    const refused = await ctx.api("/api/voice-agents/jarvis/loeschen", "POST", {});
    expect(refused.status).toBe(400);
    expect((await refused.json()).reason).toBe("bestaetigung");
    expect(existsSync(join(h.paths.configDir, "jarvis.json"))).toBe(true);
    expect(h.layer.calls).toEqual([]);
    const res = await ctx.api("/api/voice-agents/jarvis/loeschen", "POST", { bestaetigt: true });
    expect(res.status).toBe(200);
    expect((await res.json()).archiv).toContain("geloescht");
    expect(existsSync(join(h.paths.configDir, "jarvis.json"))).toBe(false);
    expect(h.layer.calls.map((c) => c.method)).toEqual(["remove"]);
    expect((await (await ctx.api("/api/voice-agents")).json()).agents).toEqual([]);
    // Noch einmal: nichts mehr da
    expect((await ctx.api("/api/voice-agents/jarvis/loeschen", "POST", { bestaetigt: true })).status).toBe(404);
  });

  test("Löschen: Anbieter scheitert, Rezept bleibt (502)", async () => {
    const { h, ctx } = await setup();
    writeRecipe(h, "jarvis");
    await deployed(h, "jarvis");
    h.layer.removeResult = async () => ({ status: "fehler", fehler: "HTTP 500" }) as any;
    const res = await ctx.api("/api/voice-agents/jarvis/loeschen", "POST", { bestaetigt: true });
    expect(res.status).toBe(502);
    expect(existsSync(join(h.paths.configDir, "jarvis.json"))).toBe(true);
  });
});

describe("Routen", () => {
  test("Methoden, ohne Login, ohne Verwaltung, nur im Browser", async () => {
    const { h, ctx } = await setup();
    writeRecipe(h, "jarvis");
    expect((await ctx.api("/api/voice-agents", "POST", {})).status).toBe(405);
    expect((await ctx.api("/api/voice-agents/jarvis/test")).status).toBe(405);
    expect((await ctx.api("/api/voice-agents/jarvis/rezept", "POST", {})).status).toBe(405);
    const anonymous = await fetch(`${ctx.origin}/api/voice-agents`);
    expect(anonymous.status).toBe(401);
    const page = await fetch(`${ctx.origin}/sprachagenten`, { redirect: "manual" });
    expect(page.status).toBe(302);
    const html = await fetch(`${ctx.origin}/sprachagenten`, { headers: { cookie: ctx.cookie } });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("/sprachagenten.js");
    const bare = await topicServer(root, servers, null, {});
    expect((await bare.api("/api/voice-agents")).status).toBe(503);
    // Gesprächsrouten bleiben, wie sie waren
    expect((await bare.api("/api/voice-agents/jarvis")).status).toBe(503);
  });

  test("parseVersionParam", () => {
    expect(parseVersionParam(null)).toBeNull();
    expect(parseVersionParam("")).toBeNull();
    expect(parseVersionParam("3")).toBe(3);
    expect(parseVersionParam("0")).toBeNaN();
    expect(parseVersionParam("-1")).toBeNaN();
    expect(parseVersionParam("1e3")).toBeNaN();
  });
});

describe("Attrappe für web:dev", () => {
  test("Liste, Testen, Löschen und Gespräch ohne Anbieter", async () => {
    const demo = createDemoVoiceAgents({ testMs: 5 });
    const list = await demo.admin.list();
    expect((list.body.agents as any[]).map((a) => a.kennung)).toEqual(["jarvis", "empfang"]);
    expect((await demo.admin.test("jarvis")).status).toBe(202);
    expect((await demo.admin.test("jarvis")).status).toBe(409);
    await Bun.sleep(20);
    expect(((await demo.admin.detail("jarvis", null)).body.laufenderTest as unknown) ?? null).toBeNull();
    expect(await demo.sessions.page("empfang")).toBe("kein_web");
    const started = await demo.sessions.start("jarvis");
    expect(started.status).toBe(200);
    expect((await demo.sessions.info("jarvis")).body.bereit).toBe(false);
    const ended = await demo.sessions.end("jarvis", JSON.stringify({ conversationId: started.body.conversationId }));
    expect(ended.body.minuten).toBe(1);
    expect((await demo.admin.remove("empfang")).status).toBe(200);
    expect((await demo.admin.detail("empfang", null)).status).toBe(404);
  });
});
