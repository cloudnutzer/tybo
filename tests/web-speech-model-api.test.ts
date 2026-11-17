/**
 * Issue #249, Nachtrag „Modell für gesprochene Fragen": speech.model und
 * speech.effort in der Einstellungen-API, über die echte, temporäre
 * Einstellungsdatei (setSettingsPath) und botSettings. Kein Modell.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSettingsPath } from "../src/lib/settings";
import { speechTurnOptions } from "../src/lib/speech/spoken-turn";
import { botSettings } from "../src/web/bot-settings";
import { createDemoSettings } from "../src/web/demo";
import type { WebServer } from "../src/web/server";
import { applySettingsPatch } from "../src/web/settings";
import { isolateAgentCatalog } from "./catalog-fixture";
import { topicServer } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "web-speech-model-api-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
let file: string;
let counter = 0;
isolateAgentCatalog();

beforeEach(() => {
  file = join(root, `settings-${++counter}.json`);
  setSettingsPath(file);
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  setSettingsPath();
});

const readFileJson = async () => JSON.parse(await readFile(file, "utf-8").catch(() => "null"));
const server = () => topicServer(root, servers, null, { settings: botSettings });

describe("speech.model und speech.effort in /api/settings", () => {
  test("PATCH setzt beide, GET liefert sie, der nächste Sprech-Turn nutzt sie ohne Neustart", async () => {
    const ctx = await server();
    const res = await ctx.api("/api/settings", "PATCH", { speech: { model: " claude-haiku-5-5 ", effort: "low" } });
    expect(res.status).toBe(200);
    expect((await res.json()).settings.speech).toEqual({ model: "claude-haiku-5-5", effort: "low" });
    expect(await readFileJson()).toEqual({ speech: { model: "claude-haiku-5-5", effort: "low" } });
    expect((await (await ctx.api("/api/settings")).json()).settings.speech).toEqual({ model: "claude-haiku-5-5", effort: "low" });
    expect(speechTurnOptions().turnModel).toEqual({ model: "claude-haiku-5-5", effort: "low" });
    // Nur Feldnamen im Log, nie der Wert
    expect(ctx.logs.some(l => l.includes("speech.model"))).toBe(true);
    expect(ctx.logs.join("\n")).not.toContain("haiku");
  });

  test("null oder leer entfernt ein Feld: ohne Modell wie das Gespräch, ohne Effort medium", async () => {
    await writeFile(file, JSON.stringify({ speech: { stt: "gemini", model: "claude-sonnet-5", effort: "high" } }));
    const ctx = await server();
    await ctx.api("/api/settings", "PATCH", { speech: { effort: null } });
    expect(await readFileJson()).toEqual({ speech: { stt: "gemini", model: "claude-sonnet-5" } });
    expect(speechTurnOptions().turnModel).toEqual({ model: "claude-sonnet-5", effort: "medium" });
    await ctx.api("/api/settings", "PATCH", { speech: { model: "" } });
    expect(await readFileJson()).toEqual({ speech: { stt: "gemini" } });
    expect(speechTurnOptions().turnModel).toBeUndefined();
    // Andere Felder des Abschnitts ändern lässt das Modell stehen
    await ctx.api("/api/settings", "PATCH", { speech: { model: "gpt-5.6-sol" } });
    await ctx.api("/api/settings", "PATCH", { speech: { stt: null } });
    expect(await readFileJson()).toEqual({ speech: { model: "gpt-5.6-sol" } });
  });

  test("Modellnamen aller Motoren sind erlaubt; Ungültiges ergibt 400 ohne den Wert, nichts wird gespeichert", async () => {
    const ctx = await server();
    for (const model of ["claude-opus-5-5[1m]", "gpt-5.6-sol", "openrouter/anthropic/claude-opus-5.5"]) {
      expect((await ctx.api("/api/settings", "PATCH", { speech: { model } })).status).toBe(200);
    }
    const before = await readFileJson();
    let res = await ctx.api("/api/settings", "PATCH", { speech: { model: "zwei worte geheim" } });
    expect(res.status).toBe(400);
    let body = await res.json();
    expect(body.issues[0]).toEqual({ path: "speech.model", message: "ungültiger Modellname" });
    expect(JSON.stringify(body)).not.toContain("geheim");
    res = await ctx.api("/api/settings", "PATCH", { speech: { model: "-rf" } });
    expect(res.status).toBe(400);
    res = await ctx.api("/api/settings", "PATCH", { speech: { effort: "ultra" } });
    expect(res.status).toBe(400);
    body = await res.json();
    expect(body.issues[0].path).toBe("speech.effort");
    res = await ctx.api("/api/settings", "PATCH", { speech: { model: 5 } });
    expect(res.status).toBe(400);
    expect(await readFileJson()).toEqual(before);
  });

  test("applySettingsPatch und Demo-Einstellungen kennen beide Felder", () => {
    expect(applySettingsPatch({ speech: { stt: "gemini" } }, { speech: { model: " sonnet ", effort: "low" } }, [])).toEqual({
      ok: true,
      value: { speech: { stt: "gemini", model: "sonnet", effort: "low" } },
      changed: ["speech.model", "speech.effort"],
    });
    const demo = createDemoSettings({});
    expect(demo.validate({ speech: { model: "claude-sonnet-5", effort: "medium" } }).ok).toBe(true);
    expect(demo.validate({ speech: { model: "zwei worte" } }).ok).toBe(false);
    expect(demo.validate({ speech: { effort: "ultra" } }).ok).toBe(false);
  });
});
