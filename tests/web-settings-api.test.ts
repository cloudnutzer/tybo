/**
 * Issue #36, Checkbox 1: GET und PATCH /api/settings über den Server mit
 * der echten Einstellungsdatei (temporär, setSettingsPath) und den echten
 * Resolvern. Nie config/settings.json, nie .env.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentConfig, resolveAgentEffort, resolveAgentModel } from "../src/agents/base";
import { AGENT_NAMES } from "../src/agents/names";
import { resolveAux } from "../src/lib/aux-model";
import { defaultEffort } from "../src/lib/claude";
import { FALLBACK_OFFLINE_ONLY, OLLAMA_MODEL, OPENROUTER_MODEL } from "../src/lib/fallback-llm";
import { getSettings, setSettingsPath } from "../src/lib/settings";
import { configuredEngine, setTopicEngine } from "../src/lib/engine-choice";
import { effectiveSettings, botSettings } from "../src/web/bot-settings";
import type { WebServer } from "../src/web/server";
import { createRevisionClock } from "../src/web/revision";
import { applySettingsPatch, AUX_PURPOSES, createSettingsApi, inheritedAgentValues, inheritedGlobalValues, type SettingsData, type SettingsPort } from "../src/web/settings";
import { topicServer } from "./topic-fixture";
import { isolateAgentCatalog } from "./catalog-fixture";

const ENV_KEYS = [
  "CLAUDE_EFFORT",
  "AUX_MODEL_JUDGE",
  "AUX_MODEL_DISTILL",
  "AUX_MODEL_REVIEW",
  "OPENROUTER_MODEL",
  "OLLAMA_MODEL",
  "FALLBACK_OFFLINE_ONLY",
  "TYBO_ENGINE",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

const root = await mkdtemp(join(tmpdir(), "bot-settings-api-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
let file: string;
let counter = 0;
isolateAgentCatalog();

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  file = join(root, `settings-${++counter}.json`);
  setSettingsPath(file);
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setSettingsPath();
});

async function readFileJson(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

/** null: Server ohne Einstellungen */
async function server(settings: SettingsPort | null = botSettings) {
  return topicServer(root, servers, null, { settings: settings ?? undefined });
}

describe("GET /api/settings", () => {
  test("ohne Datei: leere Einstellungen, alles aus dem Code, Agentenliste und Effort-Stufen", async () => {
    const ctx = await server();
    const res = await ctx.api("/api/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual({});
    expect(body.fileInvalid).toBe(false);
    expect(body.agents).toEqual([...AGENT_NAMES]);
    expect(body.effortLevels).toEqual(["low", "medium", "high", "xhigh"]);
    for (const name of AGENT_NAMES) {
      expect(body.effective.agents[name].model).toEqual({ value: getAgentConfig(name)!.model, source: "code" });
      expect(body.effective.agents[name].effort.source).toBe("code");
    }
    expect(body.effective.aux.judge).toEqual({ value: "claude:claude-opus-5", source: "code" });
    expect(body.effective.aux.distill).toEqual({ value: "claude:claude-haiku-4-5-20251001", source: "code" });
    expect(body.effective.fallback).toEqual({
      openrouterModel: { value: "minimax/minimax-m2.7", source: "code" },
      ollamaModel: { value: "qwen3:8b", source: "code" },
      offlineOnly: { value: false, source: "code" },
    });
  });

  test("ungültige Datei: letzte gültige Fassung, fileInvalid true", async () => {
    await writeFile(file, "{kaputt");
    const ctx = await server();
    const body = await (await ctx.api("/api/settings")).json();
    expect(body.fileInvalid).toBe(true);
    expect(body.settings).toEqual({});
  });
});

describe("PATCH /api/settings", () => {
  test("setzt Werte, führt zusammen, restartRequired false, Quelle settings", async () => {
    const ctx = await server();
    let res = await ctx.api("/api/settings", "PATCH", { agents: { research: { model: " claude-sonnet-5 " } } });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.restartRequired).toBe(false);
    expect(body.settings).toEqual({ agents: { research: { model: "claude-sonnet-5" } } });
    expect(body.effective.agents.research.model).toEqual({ value: "claude-sonnet-5", source: "settings" });
    expect(body.effective.agents.finance.model.source).toBe("code");

    // Fehlende Felder bleiben, verschachtelte werden zusammengeführt
    res = await ctx.api("/api/settings", "PATCH", {
      agents: { research: { effort: "medium" }, critic: { effort: "low" } },
      fallback: { offlineOnly: true },
    });
    body = await res.json();
    expect(res.status).toBe(200);
    expect(await readFileJson()).toEqual({
      agents: { research: { model: "claude-sonnet-5", effort: "medium" }, critic: { effort: "low" } },
      fallback: { offlineOnly: true },
    });
    expect(body.effective.agents.research.effort).toEqual({ value: "medium", source: "settings" });
    // Wirkt an den Aufrufstellen (Hot-Reload), ohne Neustart
    expect(resolveAgentModel("research")).toBe("claude-sonnet-5");
    expect(resolveAgentEffort("critic")).toBe("low");
    expect(FALLBACK_OFFLINE_ONLY()).toBe(true);
  });

  test("leerer Wert oder null entfernt; false bei offlineOnly bleibt ein Wert", async () => {
    process.env.FALLBACK_OFFLINE_ONLY = "true";
    await writeFile(
      file,
      JSON.stringify({
        defaults: { model: "claude-opus-5" },
        agents: { research: { model: "claude-sonnet-5", effort: "high" } },
        aux: { judge: "claude:claude-opus-5-5" },
      })
    );
    const ctx = await server();
    let res = await ctx.api("/api/settings", "PATCH", { agents: { research: { model: "" } }, fallback: { offlineOnly: false } });
    let body = await res.json();
    expect(res.status).toBe(200);
    // Agentenwert weg: zuerst der Standard aus der Datei
    expect(body.effective.agents.research.model).toEqual({ value: "claude-opus-5", source: "settings" });
    expect(body.effective.fallback.offlineOnly).toEqual({ value: false, source: "settings" });
    expect(await readFileJson()).toEqual({
      defaults: { model: "claude-opus-5" },
      agents: { research: { effort: "high" } },
      aux: { judge: "claude:claude-opus-5-5" },
      fallback: { offlineOnly: false },
    });

    res = await ctx.api("/api/settings", "PATCH", {
      defaults: { model: "   " },
      agents: { research: null },
      aux: { judge: null },
      fallback: { offlineOnly: null },
    });
    body = await res.json();
    expect(res.status).toBe(200);
    expect(await readFileJson()).toEqual({});
    expect(body.effective.agents.research.model).toEqual({ value: getAgentConfig("research")!.model, source: "code" });
    expect(body.effective.aux.judge.source).toBe("code");
    expect(body.effective.fallback.offlineOnly).toEqual({ value: true, source: "env" });
  });

  test("ganze Abschnitte mit null entfernen", async () => {
    await writeFile(file, JSON.stringify({ agents: { cto: { effort: "low" } }, aux: { review: "ollama:qwen3:8b" } }));
    const ctx = await server();
    const res = await ctx.api("/api/settings", "PATCH", { agents: null, aux: null });
    expect(res.status).toBe(200);
    expect(await readFileJson()).toEqual({});
  });

  test("ungültiger Effort 400, Meldung ohne Wert, nichts gespeichert", async () => {
    const before = { agents: { research: { model: "claude-sonnet-5" } } };
    await writeFile(file, JSON.stringify(before));
    const ctx = await server();
    const res = await ctx.api("/api/settings", "PATCH", { agents: { research: { effort: "ultra" }, finance: { model: "x" } } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("agents.research.effort");
    expect(body.error).toContain("low, medium, high, xhigh");
    expect(JSON.stringify(body)).not.toContain("ultra");
    expect(body.issues).toEqual([{ path: "agents.research.effort", message: "erlaubt: low, medium, high, xhigh" }]);
    expect(await readFileJson()).toEqual(before);
  });

  test("unbekannter Agent 400, auch Aliasse; nichts gespeichert", async () => {
    const ctx = await server();
    for (const name of ["nobody", "cfo", "General", "__proto__"]) {
      const res = await ctx.api("/api/settings", "PATCH", JSON.stringify({ agents: { research: { model: "a" }, [name]: { model: "b" } } }));
      expect({ name, status: res.status }).toEqual({ name, status: 400 });
      expect((await res.json()).error).toContain("Unbekannter Agent");
    }
    expect(await readFileJson()).toBeNull();
  });

  test("Form und Typen: unbekannte Felder, falsche Typen, kaputtes JSON, Aux-Format", async () => {
    const ctx = await server();
    const bad: unknown[] = [
      "{kaputt",
      "[1]",
      '"x"',
      { foo: 1 },
      { defaults: { model: "a", temperature: 1 } },
      { defaults: "a" },
      { agents: [] },
      { agents: { research: "claude-sonnet-5" } },
      { agents: { research: { model: 5 } } },
      { fallback: { offlineOnly: "true" } },
      { fallback: { openrouterModel: false } },
      { aux: { judge: "gpt-5" } },
      { aux: { judge: "claude:" } },
    ];
    for (const body of bad) {
      const res = await ctx.api("/api/settings", "PATCH", typeof body === "string" ? body : JSON.stringify(body));
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect(await readFileJson()).toBeNull();
  });

  test("ungültige Datei: PATCH 409, Datei bleibt unberührt", async () => {
    await writeFile(file, '{"agents":{"research":{"effort":"ultra"}}}');
    const ctx = await server();
    const res = await ctx.api("/api/settings", "PATCH", { fallback: { offlineOnly: true } });
    expect(res.status).toBe(409);
    expect(await readFile(file, "utf-8")).toBe('{"agents":{"research":{"effort":"ultra"}}}');
  });

  test("gleichzeitige Änderungen verlieren nichts", async () => {
    const ctx = await server();
    const results = await Promise.all(
      AGENT_NAMES.map((name, i) => ctx.api("/api/settings", "PATCH", { agents: { [name]: { model: `modell-${i}` } } }))
    );
    expect(results.map(r => r.status)).toEqual(AGENT_NAMES.map(() => 200));
    const saved = (await readFileJson()) as SettingsData;
    expect(Object.keys(saved.agents!).sort()).toEqual([...AGENT_NAMES].sort());
  });

  test("Log nennt nur Feldnamen, nie Werte", async () => {
    const ctx = await server();
    await ctx.api("/api/settings", "PATCH", { fallback: { openrouterModel: "wert-der-nicht-ins-log-darf" } });
    expect(ctx.logs).toContain("Einstellungen geändert: fallback.openrouterModel");
    expect(ctx.logs.join("\n")).not.toContain("wert-der-nicht-ins-log-darf");
  });

  test("Schreibfehler ergibt 500 ohne Details", async () => {
    const failing: SettingsPort = {
      ...botSettings,
      write: async () => {
        throw new Error(`EACCES ${file}`);
      },
    };
    const ctx = await server(failing);
    const res = await ctx.api("/api/settings", "PATCH", { defaults: { effort: "high" } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Einstellungen konnten nicht gespeichert werden" });
    expect(ctx.logs.join("\n")).not.toContain(file);
  });
});

describe("Schutz der Routen", () => {
  test("ohne Anmeldung 401, fremder Origin 403, falsche Methode 405, ohne Port 503", async () => {
    const ctx = await server();
    expect((await fetch(`${ctx.origin}/api/settings`)).status).toBe(401);
    const noCookie = await fetch(`${ctx.origin}/api/settings`, {
      method: "PATCH",
      headers: { origin: ctx.origin },
      body: JSON.stringify({ defaults: { effort: "low" } }),
    });
    expect(noCookie.status).toBe(401);
    const foreign = await ctx.api("/api/settings", "PATCH", { defaults: { effort: "low" } }, { origin: "http://evil.example" });
    expect(foreign.status).toBe(403);
    expect((await ctx.api("/api/settings", "POST", {})).status).toBe(405);
    expect(await readFileJson()).toBeNull();

    const bare = await server(null);
    const res = await bare.api("/api/settings");
    expect(res.status).toBe(503);
  });
});

describe("Quellen je Wert", () => {
  test("CLAUDE_EFFORT, AUX_MODEL_*, OPENROUTER_MODEL, OLLAMA_MODEL aus .env; ungültiges Aux fällt auf Code", () => {
    process.env.CLAUDE_EFFORT = "medium";
    process.env.AUX_MODEL_JUDGE = "openrouter:vendor/judge";
    process.env.AUX_MODEL_REVIEW = "kaputt";
    process.env.OPENROUTER_MODEL = "vendor/env-modell";
    process.env.OLLAMA_MODEL = "llama9";
    process.env.FALLBACK_OFFLINE_ONLY = "false";
    const eff = effectiveSettings({ agents: { cto: { effort: "low" } } });
    expect(eff.agents.research.effort).toEqual({ value: "medium", source: "env" });
    expect(eff.agents.cto.effort).toEqual({ value: "low", source: "settings" });
    expect(eff.aux.judge).toEqual({ value: "openrouter:vendor/judge", source: "env" });
    expect(eff.aux.review).toEqual({ value: "claude:claude-haiku-4-5-20251001", source: "code" });
    expect(eff.fallback.openrouterModel).toEqual({ value: "vendor/env-modell", source: "env" });
    expect(eff.fallback.ollamaModel).toEqual({ value: "llama9", source: "env" });
    expect(eff.fallback.offlineOnly).toEqual({ value: false, source: "env" });
  });

  test("Effort ohne Einstellung und .env: Agenten-Datei, sonst defaultEffort aus claude.ts", () => {
    const eff = effectiveSettings({ agents: { research: { model: "claude-sonnet-5" }, finance: { model: "claude-opus-5-5" } } });
    for (const name of ["research", "finance"] as const) {
      const expected = getAgentConfig(name)!.effort || defaultEffort(eff.agents[name].model.value) || null;
      expect(eff.agents[name].effort).toEqual({ value: expected, source: "code" });
    }
  });

  test("stimmt mit den Resolvern der Aufrufstellen überein", async () => {
    const cases: [Record<string, string>, SettingsData][] = [
      [{}, {}],
      [{ CLAUDE_EFFORT: "low" }, { defaults: { model: "claude-haiku-4-5-20251001" } }],
      [
        { AUX_MODEL_DISTILL: "ollama:qwen3:8b", OPENROUTER_MODEL: "a/b", FALLBACK_OFFLINE_ONLY: "true" },
        { defaults: { effort: "high" }, agents: { critic: { model: "claude-sonnet-5", effort: "xhigh" } }, aux: { review: "openrouter:x/y" }, fallback: { ollamaModel: "m" } },
      ],
      [{ AUX_MODEL_JUDGE: "nonsense" }, { fallback: { offlineOnly: false, openrouterModel: "c/d" } }],
    ];
    for (const [env, settings] of cases) {
      for (const k of ENV_KEYS) delete process.env[k];
      Object.assign(process.env, env);
      await writeFile(file, JSON.stringify(settings));
      expect(getSettings()).toEqual(settings as any);
      const eff = effectiveSettings(settings);
      for (const name of AGENT_NAMES) {
        const model = resolveAgentModel(name);
        expect(eff.agents[name].model.value).toBe(model);
        expect(eff.agents[name].effort.value).toBe(resolveAgentEffort(name) ?? defaultEffort(model) ?? null);
      }
      for (const p of AUX_PURPOSES) {
        const t = resolveAux(p);
        expect(eff.aux[p].value).toBe(`${t.kind}:${t.model}`);
      }
      expect(eff.fallback.openrouterModel.value).toBe(OPENROUTER_MODEL());
      expect(eff.fallback.ollamaModel.value).toBe(OLLAMA_MODEL());
      expect(eff.fallback.offlineOnly.value).toBe(FALLBACK_OFFLINE_ONLY());
    }
  });
});

describe("Geerbte Werte für „Standard (…)\" (Issue #38)", () => {
  test("ohne eigenen Eintrag: gleich den wirksamen Werten", async () => {
    const ctx = await server();
    const body = await (await ctx.api("/api/settings")).json();
    for (const name of AGENT_NAMES) {
      expect(body.inherited[name]).toEqual({ model: body.effective.agents[name].model, effort: body.effective.agents[name].effort });
    }
  });

  test("mit eigenem Eintrag: Wert und Quelle darunter (Standard aus der Datei, .env, Code)", async () => {
    process.env.CLAUDE_EFFORT = "medium";
    await writeFile(file, JSON.stringify({
      defaults: { model: "claude-sonnet-5" },
      agents: { research: { model: "claude-haiku-4-5-20251001", effort: "low" }, critic: { effort: "xhigh" } },
    }));
    const ctx = await server();
    const body = await (await ctx.api("/api/settings")).json();
    expect(body.effective.agents.research.model).toEqual({ value: "claude-haiku-4-5-20251001", source: "settings" });
    expect(body.inherited.research.model).toEqual({ value: "claude-sonnet-5", source: "settings" });
    expect(body.inherited.research.effort).toEqual({ value: "medium", source: "env" });
    expect(body.effective.agents.critic.effort).toEqual({ value: "xhigh", source: "settings" });
    expect(body.inherited.critic.effort).toEqual({ value: "medium", source: "env" });
    // Ohne Standard in der Datei und ohne .env: Code, wie an den Aufrufstellen
    delete process.env.CLAUDE_EFFORT;
    await writeFile(file, JSON.stringify({ agents: { research: { model: "claude-haiku-4-5-20251001", effort: "low" } } }));
    const plain = await (await ctx.api("/api/settings")).json();
    // Modell ohne eigenen Eintrag wie im Code; Effort zum eigenen Modell, das stehen bleibt
    expect(plain.inherited.research.model).toEqual(effectiveSettings({}).agents.research.model);
    expect(plain.inherited.research.model).toEqual({ value: getAgentConfig("research")!.model, source: "code" });
    const keepModel = effectiveSettings({ agents: { research: { model: "claude-haiku-4-5-20251001" } } }).agents.research.effort;
    expect(plain.inherited.research.effort).toEqual(keepModel);
    expect(plain.inherited.research.effort).toEqual({ value: defaultEffort("claude-haiku-4-5-20251001") ?? null, source: "code" });
  });

  test("Effort-Standard gilt für das eigene Modell, das stehen bleibt (Codex-Befund Runde 7 zu PR #43)", async () => {
    // Ohne CLAUDE_EFFORT: Opus im Code hat xhigh, Sonnet keinen Effort (Claude entscheidet)
    await writeFile(file, JSON.stringify({ agents: { research: { model: "claude-sonnet-5", effort: "low" } } }));
    const ctx = await server();
    const before = await (await ctx.api("/api/settings")).json();
    expect(before.inherited.research.effort).toEqual({ value: null, source: "code" });
    expect(before.inherited.research.model).toEqual({ value: getAgentConfig("research")!.model, source: "code" });
    // Genau das sendet „Standard" beim Effort
    const after = await (await ctx.api("/api/settings", "PATCH", { agents: { research: { effort: null } } })).json();
    expect(after.settings).toEqual({ agents: { research: { model: "claude-sonnet-5" } } });
    expect(after.effective.agents.research.effort).toEqual(before.inherited.research.effort);
    // Und „Standard" beim Modell: der Effort bleibt eigener Wert
    await writeFile(file, JSON.stringify({ agents: { research: { model: "claude-sonnet-5", effort: "low" } } }));
    const again = await (await ctx.api("/api/settings")).json();
    const reset = await (await ctx.api("/api/settings", "PATCH", { agents: { research: { model: null } } })).json();
    expect(reset.effective.agents.research.model).toEqual(again.inherited.research.model);
    expect(reset.effective.agents.research.effort).toEqual({ value: "low", source: "settings" });
  });

  test("für jeden Agenten und jedes Feld: „Standard (…)\" ist der Wert, der nach dem Zurücksetzen gilt", () => {
    const states: SettingsData[] = [
      {},
      { agents: { research: { model: "claude-sonnet-5", effort: "low" }, critic: { effort: "xhigh" }, finance: { model: "claude-opus-5-5" } } },
      { defaults: { model: "claude-haiku-4-5-20251001" }, agents: { research: { model: "claude-opus-5-5", effort: "medium" }, general: { model: "vendor/eigen" } } },
      { defaults: { effort: "high" }, agents: { strategy: { model: "claude-sonnet-5", effort: "low" } } },
    ];
    for (const env of [undefined, "medium"]) {
      if (env === undefined) delete process.env.CLAUDE_EFFORT;
      else process.env.CLAUDE_EFFORT = env;
      for (const settings of states) {
        const inherited = inheritedAgentValues(botSettings, settings);
        for (const name of AGENT_NAMES) {
          for (const field of ["model", "effort"] as const) {
            const reset = applySettingsPatch(settings, { agents: { [name]: { [field]: null } } }, AGENT_NAMES);
            if (!reset.ok) throw new Error(reset.error);
            expect({ name, field, value: inherited[name][field] }).toEqual({ name, field, value: effectiveSettings(reset.value).agents[name][field] });
          }
        }
      }
    }
  });

  test("PATCH liefert die geerbten Werte zum neuen Stand; der Ausgangsstand bleibt unverändert", async () => {
    const ctx = await server();
    const res = await ctx.api("/api/settings", "PATCH", { defaults: { model: "claude-sonnet-5" }, agents: { finance: { model: "claude-opus-5" } } });
    const body = await res.json();
    expect(body.inherited.finance.model).toEqual({ value: "claude-sonnet-5", source: "settings" });
    expect(body.settings).toEqual({ defaults: { model: "claude-sonnet-5" }, agents: { finance: { model: "claude-opus-5" } } });
    expect(await readFileJson()).toEqual(body.settings);
  });
});

describe("Versionsnummer des Serverstands (Codex-Befund Runde 6 zu PR #43)", () => {
  test("jeder gespeicherte Stand erhöht seq; boot bleibt im Prozess gleich", async () => {
    const api = createSettingsApi(botSettings, () => {});
    const a = (await api.get()).body.revision as { boot: number; seq: number };
    const p = (await api.patch(JSON.stringify({ defaults: { effort: "high" } }))).body.revision as { boot: number; seq: number };
    const b = (await api.get()).body.revision as { boot: number; seq: number };
    expect(p.boot).toBe(a.boot);
    expect(p.seq).toBe(a.seq + 1);
    expect(b).toEqual(p);
    // abgelehnte Änderung erhöht nicht
    await api.patch(JSON.stringify({ defaults: { effort: "sehr hoch" } }));
    expect(((await api.get()).body.revision as { seq: number }).seq).toBe(p.seq);
  });

  test("GET während eines laufenden Schreibvorgangs wartet und liefert den neuen Stand", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const port: SettingsPort = {
      ...botSettings,
      write: async value => {
        await gate;
        await botSettings.write(value);
      },
    };
    const api = createSettingsApi(port, () => {});
    const patching = api.patch(JSON.stringify({ agents: { research: { model: "claude-opus-5-5" } } }));
    await Bun.sleep(10);
    const reading = api.get();
    let readDone = false;
    void reading.then(() => (readDone = true));
    await Bun.sleep(20);
    expect(readDone).toBe(false);
    release();
    const [p, g] = await Promise.all([patching, reading]);
    expect((g.body.settings as SettingsData).agents?.research?.model).toBe("claude-opus-5-5");
    expect(g.body.revision).toEqual(p.body.revision);
  });
});

describe("Version gehört zum Inhalt (Plan-Session 2 zu PR #43)", () => {
  type Rev = { boot: number; seq: number };
  const rev = (r: { body: Record<string, unknown> }) => r.body.revision as Rev;

  test("Versionsuhr: gleicher Inhalt gleiche Nummer, anderer Inhalt höhere, je Schlüssel für sich", () => {
    const clock = createRevisionClock(7);
    const a = clock.stamp("x", { v: 1 });
    expect(a.boot).toBe(7);
    expect(clock.stamp("x", { v: 1 })).toEqual(a);
    const b = clock.stamp("x", { v: 2 });
    expect(b.seq).toBeGreaterThan(a.seq);
    // Zurück zum alten Inhalt ist ein neuer Stand, keine alte Nummer
    expect(clock.stamp("x", { v: 1 }).seq).toBeGreaterThan(b.seq);
    // Ein anderer Schlüssel ändert die Nummer von x nicht
    const x = clock.stamp("x", { v: 1 });
    clock.stamp("y", { v: 9 });
    expect(clock.stamp("x", { v: 1 })).toEqual(x);
    // Standard-boot ist der Prozessstart
    const before = Date.now();
    expect(createRevisionClock().stamp("x", 1).boot).toBeGreaterThanOrEqual(before);
  });

  test("von Hand geänderte Datei ergibt beim nächsten GET eine höhere Nummer, unveränderte dieselbe", async () => {
    const api = createSettingsApi(botSettings, () => {});
    const a = rev(await api.get());
    await writeFile(file, JSON.stringify({ agents: { research: { model: "claude-haiku-4-5-20251001" } } }));
    const b = rev(await api.get());
    expect(b.boot).toBe(a.boot);
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(rev(await api.get())).toEqual(b);
  });

  test("Datei nach dem Speichern ungültig: GET hat eine höhere Nummer als die Speicherantwort", async () => {
    const api = createSettingsApi(botSettings, () => {});
    const p = await api.patch(JSON.stringify({ agents: { research: { model: "claude-opus-5-5" } } }));
    expect(p.body.fileInvalid).toBe(false);
    await writeFile(file, "{ kaputt");
    const g = await api.get();
    expect(g.body.fileInvalid).toBe(true);
    expect(rev(g).seq).toBeGreaterThan(rev(p).seq);
    // Repariert auf denselben Inhalt wie gespeichert: wieder ein neuer Stand
    await writeFile(file, JSON.stringify({ agents: { research: { model: "claude-opus-5-5" } } }));
    const h = await api.get();
    expect(h.body.fileInvalid).toBe(false);
    expect(rev(h).seq).toBeGreaterThan(rev(g).seq);
  });

  test("boot kommt von der übergebenen Uhr; ein späterer Prozess hat einen größeren boot", async () => {
    const early = createSettingsApi(botSettings, () => {}, createRevisionClock(1000));
    const late = createSettingsApi(botSettings, () => {}, createRevisionClock(2000));
    expect(rev(await early.get()).boot).toBe(1000);
    expect(rev(await late.get()).boot).toBe(2000);
  });
});

describe("applySettingsPatch", () => {
  test("verändert den Ausgangsstand nicht", () => {
    const current: SettingsData = { agents: { research: { model: "a" } } };
    const result = applySettingsPatch(current, { agents: { research: { model: "b" } } }, AGENT_NAMES);
    expect(result.ok).toBe(true);
    expect(current).toEqual({ agents: { research: { model: "a" } } });
  });

  test("createSettingsApi prüft zuletzt mit validate: dessen Ablehnung speichert nichts", async () => {
    let writes = 0;
    const port: SettingsPort = {
      ...botSettings,
      readForWrite: async () => ({}),
      validate: () => ({ ok: false, issues: [{ path: "defaults.model", message: "ungültiger Wert" }] }),
      write: async () => {
        writes++;
      },
    };
    const api = createSettingsApi(port, () => {});
    const res = await api.patch(JSON.stringify({ defaults: { model: "x" } }));
    expect(res.status).toBe(400);
    expect(writes).toBe(0);
  });
});

describe("Geerbte Werte für den Reiter „Modelle\" (Issue #39)", () => {
  test("Aux und Fallback: mit eigenem Wert steht darunter .env bzw. Code, ohne gleich dem wirksamen", async () => {
    process.env.AUX_MODEL_JUDGE = "openrouter:vendor/judge";
    process.env.FALLBACK_OFFLINE_ONLY = "true";
    await writeFile(file, JSON.stringify({
      aux: { judge: "ollama:qwen3:8b", review: "claude:claude-sonnet-5" },
      fallback: { offlineOnly: false, ollamaModel: "llama9:1b" },
    }));
    const ctx = await server();
    const body = await (await ctx.api("/api/settings")).json();
    const inh = body.inheritedModels;
    expect(body.effective.aux.judge).toEqual({ value: "ollama:qwen3:8b", source: "settings" });
    expect(inh.aux.judge).toEqual({ value: "openrouter:vendor/judge", source: "env" });
    expect(inh.aux.distill).toEqual(body.effective.aux.distill);
    expect(inh.aux.review).toEqual(effectiveSettings({}).aux.review);
    expect(inh.aux.review.source).toBe("code");
    // false ist ein eigener Wert; darunter liegt .env
    expect(body.effective.fallback.offlineOnly).toEqual({ value: false, source: "settings" });
    expect(inh.fallback.offlineOnly).toEqual({ value: true, source: "env" });
    expect(inh.fallback.ollamaModel).toEqual(effectiveSettings({}).fallback.ollamaModel);
    expect(inh.fallback.ollamaModel.source).toBe("code");
    expect(inh.fallback.openrouterModel).toEqual(body.effective.fallback.openrouterModel);

    // Genau das sendet „Standard": danach gilt der geerbte Wert
    const reset = await (await ctx.api("/api/settings", "PATCH", { aux: { judge: null }, fallback: { offlineOnly: null } })).json();
    expect(reset.settings).toEqual({ aux: { review: "claude:claude-sonnet-5" }, fallback: { ollamaModel: "llama9:1b" } });
    expect(reset.effective.aux.judge).toEqual(inh.aux.judge);
    expect(reset.effective.fallback.offlineOnly).toEqual(inh.fallback.offlineOnly);
    // offlineOnly=false speichert false, nicht Entfernen
    const off = await (await ctx.api("/api/settings", "PATCH", { fallback: { offlineOnly: false } })).json();
    expect(off.settings.fallback.offlineOnly).toBe(false);
    expect(await readFileJson()).toEqual({ aux: { review: "claude:claude-sonnet-5" }, fallback: { ollamaModel: "llama9:1b", offlineOnly: false } });
  });

  test("Standardmodell und -Effort: was ein Agent ohne eigenen Wert bekäme; je Agent verschieden ergibt null", () => {
    const codeModels = new Set(AGENT_NAMES.map(n => getAgentConfig(n)!.model));
    const inh = inheritedGlobalValues(botSettings, { defaults: { model: "claude-sonnet-5", effort: "low" }, agents: { research: { model: "claude-haiku-4-5-20251001" } } });
    if (codeModels.size === 1) expect(inh.defaults.model).toEqual({ value: [...codeModels][0], source: "code" });
    else expect(inh.defaults.model).toBeNull();
    // Effort zum gespeicherten Standardmodell (Sonnet: kein Effort, Claude entscheidet)
    expect(inh.defaults.effort).toEqual({ value: defaultEffort("claude-sonnet-5") ?? null, source: "code" });
    // Attrappe mit zwei Agenten, deren Voreinstellung sich unterscheidet
    const port = {
      agents: ["a", "b"],
      effective: (s: SettingsData) => ({
        agents: {
          a: { model: s.defaults?.model ? { value: s.defaults.model, source: "settings" as const } : { value: "m1", source: "code" as const }, effort: { value: null, source: "code" as const } },
          b: { model: s.defaults?.model ? { value: s.defaults.model, source: "settings" as const } : { value: "m2", source: "code" as const }, effort: { value: null, source: "code" as const } },
        },
        aux: effectiveSettings({}).aux,
        fallback: effectiveSettings({}).fallback,
      }),
    };
    expect(inheritedGlobalValues(port, { defaults: { model: "x" } }).defaults.model).toBeNull();
    expect(inheritedGlobalValues(port, {}).defaults.effort).toEqual({ value: null, source: "code" });
  });

  test("für jedes Feld: der geerbte Wert ist der nach dem Zurücksetzen wirksame (Aux, Fallback)", () => {
    const states: SettingsData[] = [
      {},
      { aux: { judge: "ollama:qwen3:8b", distill: "openrouter:a/b" }, fallback: { openrouterModel: "x/y", offlineOnly: true } },
      { aux: { review: "claude:claude-sonnet-5" }, fallback: { ollamaModel: "m:1", offlineOnly: false } },
    ];
    for (const env of [undefined, "ollama:env:1"]) {
      if (env === undefined) delete process.env.AUX_MODEL_DISTILL;
      else process.env.AUX_MODEL_DISTILL = env;
      for (const settings of states) {
        const inh = inheritedGlobalValues(botSettings, settings);
        for (const p of AUX_PURPOSES) {
          const reset = applySettingsPatch(settings, { aux: { [p]: null } }, AGENT_NAMES);
          if (!reset.ok) throw new Error(reset.error);
          expect({ p, v: inh.aux[p] }).toEqual({ p, v: effectiveSettings(reset.value).aux[p] });
        }
        for (const k of ["openrouterModel", "ollamaModel", "offlineOnly"] as const) {
          const reset = applySettingsPatch(settings, { fallback: { [k]: null } }, AGENT_NAMES);
          if (!reset.ok) throw new Error(reset.error);
          expect({ k, v: inh.fallback[k] }).toEqual({ k, v: effectiveSettings(reset.value).fallback[k] });
        }
      }
    }
  });
});

describe("Motor in /api/settings (Issue #126)", () => {
  const TOPIC_KEY = "topic:-1001234567890:42";
  const DM_KEY = "dm:4242";

  test("GET: Standard ohne Datei Claude Code aus dem Code, Motoren, Codex-Stufen und Rechte", async () => {
    const ctx = await server();
    const body = await (await ctx.api("/api/settings")).json();
    expect(body.effective.engine).toEqual({ default: { value: "claude", source: "code" } });
    expect(body.inheritedModels.engine).toEqual({ default: { value: "claude", source: "code" } });
    expect(body.engineOptions).toEqual({
      engines: [
        { id: "claude", label: "Claude Code" },
        { id: "codex", label: "Codex" },
        { id: "opencode", label: "OpenCode" },
      ],
      codexEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      codexSandboxLevels: ["read-only", "workspace-write", "full"],
      codexDefaultSandbox: "full",
      opencodePermissionLevels: ["ask-deny", "auto"],
      opencodeDefaultPermission: "auto",
    });
  });

  test("Akzeptanz: Standard „Codex\" speichern schreibt engine.default, Ausnahmen bleiben, wirkt ohne Neustart", async () => {
    await writeFile(file, JSON.stringify({ engine: { topics: { [TOPIC_KEY]: "claude" } } }));
    const ctx = await server();
    const res = await ctx.api("/api/settings", "PATCH", { engine: { default: "codex" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(await readFileJson()).toEqual({ engine: { default: "codex", topics: { [TOPIC_KEY]: "claude" } } });
    expect(body.effective.engine.default).toEqual({ value: "codex", source: "settings" });
    // „Standard (…)" darunter: ohne eigenen Wert gälte Claude Code aus dem Code
    expect(body.inheritedModels.engine.default).toEqual({ value: "claude", source: "code" });
    expect(configuredEngine(DM_KEY)).toEqual({ engine: "codex", source: "settings" });
    expect(configuredEngine(TOPIC_KEY)).toEqual({ engine: "claude", source: "topic" });
    expect(ctx.logs).toContain("Einstellungen geändert: engine.default");
  });

  test("TYBO_ENGINE: Standard aus .env, geerbt nach dem Entfernen des eigenen Werts", async () => {
    process.env.TYBO_ENGINE = "codex";
    await writeFile(file, JSON.stringify({ engine: { default: "claude" } }));
    const ctx = await server();
    let body = await (await ctx.api("/api/settings")).json();
    expect(body.effective.engine.default).toEqual({ value: "claude", source: "settings" });
    expect(body.inheritedModels.engine.default).toEqual({ value: "codex", source: "env" });
    body = await (await ctx.api("/api/settings", "PATCH", { engine: { default: null } })).json();
    expect(body.settings).toEqual({});
    expect(body.effective.engine.default).toEqual({ value: "codex", source: "env" });
  });

  test("Codex: Modell, Effort samt max, Rechte; leere Felder und null entfernen die Überschreibung", async () => {
    await writeFile(file, JSON.stringify({ agents: { research: { model: "claude-sonnet-5" } }, engine: { topics: { [DM_KEY]: "codex" } } }));
    const ctx = await server();
    let res = await ctx.api("/api/settings", "PATCH", { engine: { codex: { model: " gpt-5.6-sol ", effort: "max", sandbox: "workspace-write" } } });
    expect(res.status).toBe(200);
    expect(await readFileJson()).toEqual({
      agents: { research: { model: "claude-sonnet-5" } },
      engine: { topics: { [DM_KEY]: "codex" }, codex: { model: "gpt-5.6-sol", effort: "max", sandbox: "workspace-write" } },
    });
    // Leeres Modell und Effort null: Codex nimmt wieder seine Konfiguration, die Rechte bleiben
    res = await ctx.api("/api/settings", "PATCH", { engine: { codex: { model: "", effort: null } } });
    expect(res.status).toBe(200);
    expect(await readFileJson()).toEqual({
      agents: { research: { model: "claude-sonnet-5" } },
      engine: { topics: { [DM_KEY]: "codex" }, codex: { sandbox: "workspace-write" } },
    });
    // codex null entfernt den Abschnitt, die Ausnahme bleibt
    res = await ctx.api("/api/settings", "PATCH", { engine: { codex: null } });
    expect(await readFileJson()).toEqual({ agents: { research: { model: "claude-sonnet-5" } }, engine: { topics: { [DM_KEY]: "codex" } } });
  });

  test("OpenCode: Standard, Modell, Variante, Rechte; leer und null entfernen, andere Motorwerte und Ausnahmen bleiben (Issue #129)", async () => {
    await writeFile(
      file,
      JSON.stringify({ engine: { default: "codex", topics: { [DM_KEY]: "codex", [TOPIC_KEY]: "opencode" }, codex: { model: "gpt-5.6-sol", sandbox: "read-only" } } })
    );
    const ctx = await server();
    let res = await ctx.api("/api/settings", "PATCH", {
      engine: { default: "opencode", opencode: { model: " openrouter/anthropic/claude-opus-5.5 ", variant: "thinking-8k", permission: "ask-deny" } },
    });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(await readFileJson()).toEqual({
      engine: {
        default: "opencode",
        topics: { [DM_KEY]: "codex", [TOPIC_KEY]: "opencode" },
        codex: { model: "gpt-5.6-sol", sandbox: "read-only" },
        opencode: { model: "openrouter/anthropic/claude-opus-5.5", variant: "thinking-8k", permission: "ask-deny" },
      },
    });
    expect(body.effective.engine.default).toEqual({ value: "opencode", source: "settings" });
    expect(configuredEngine("dm:1")).toEqual({ engine: "opencode", source: "settings" });
    expect(ctx.logs).toContain("Einstellungen geändert: engine.default, engine.opencode.model, engine.opencode.variant, engine.opencode.permission");
    // Werte nie im Log
    expect(ctx.logs.join("\n")).not.toContain("claude-opus-5.5");

    // Variante wie im Issue auch mit Bindestrich vorn und an der Längengrenze
    for (const variant of ["-x", "a".repeat(20)]) {
      res = await ctx.api("/api/settings", "PATCH", { engine: { opencode: { variant } } });
      expect(res.status).toBe(200);
      expect((await readFileJson()).engine.opencode.variant).toBe(variant);
    }

    // Leeres Modell: OpenCode nimmt wieder seine Konfiguration; Variante null; Rechte bleiben
    res = await ctx.api("/api/settings", "PATCH", { engine: { opencode: { model: "", variant: null } } });
    expect(res.status).toBe(200);
    expect((await readFileJson()).engine.opencode).toEqual({ permission: "ask-deny" });

    // Rechte zurück auf Standard: der leere Abschnitt verschwindet, Codex und Ausnahmen bleiben
    res = await ctx.api("/api/settings", "PATCH", { engine: { opencode: { permission: null } } });
    body = await res.json();
    expect(await readFileJson()).toEqual({
      engine: { default: "opencode", topics: { [DM_KEY]: "codex", [TOPIC_KEY]: "opencode" }, codex: { model: "gpt-5.6-sol", sandbox: "read-only" } },
    });
    expect(body.settings.engine.opencode).toBeUndefined();

    // opencode null entfernt den ganzen Abschnitt
    await ctx.api("/api/settings", "PATCH", { engine: { opencode: { variant: "high" } } });
    await ctx.api("/api/settings", "PATCH", { engine: { opencode: null } });
    expect((await readFileJson()).engine.opencode).toBeUndefined();
  });

  test("Akzeptanz: ungültige Rechte-Stufe 400 mit Meldung, Datei unverändert", async () => {
    const before = JSON.stringify({ engine: { default: "codex", codex: { sandbox: "full" }, topics: { [DM_KEY]: "claude" } } });
    await writeFile(file, before);
    const ctx = await server();
    const res = await ctx.api("/api/settings", "PATCH", { engine: { codex: { sandbox: "danger-full-access" } } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Ungültige Einstellungen: engine.codex.sandbox (erlaubt: read-only, workspace-write, full)");
    expect(body.error).not.toContain("danger");
    expect(await readFile(file, "utf-8")).toBe(before);
  });

  test("ungültige Werte und Felder: 400, nichts gespeichert", async () => {
    const before = JSON.stringify({ engine: { topics: { [TOPIC_KEY]: "codex" } } });
    await writeFile(file, before);
    const ctx = await server();
    const cases: [unknown, string][] = [
      [{ engine: { default: "gemini" } }, "Ungültige Einstellungen: engine.default (erlaubt: claude, codex, opencode)"],
      [{ engine: { opencode: { variant: "a".repeat(21) } } }, "Ungültige Einstellungen: engine.opencode.variant (1 bis 20 Zeichen aus a-z, 0-9 und -)"],
      [{ engine: { opencode: { variant: "High" } } }, "Ungültige Einstellungen: engine.opencode.variant (1 bis 20 Zeichen aus a-z, 0-9 und -)"],
      [{ engine: { opencode: { model: "openai/gpt 5" } } }, "Ungültige Einstellungen: engine.opencode.model (ungültiger Modellname)"],
      [{ engine: { opencode: { permission: "full" } } }, "Ungültige Einstellungen: engine.opencode.permission (erlaubt: ask-deny, auto)"],
      [{ engine: { opencode: { sandbox: "full" } } }, "Unbekanntes Feld: engine.opencode.sandbox"],
      [{ engine: { opencode: "auto" } }, "Falscher Typ: engine.opencode"],
      [{ engine: { codex: { effort: "ultra" } } }, "Ungültige Einstellungen: engine.codex.effort (erlaubt: low, medium, high, xhigh, max)"],
      [{ engine: { codex: { model: "gpt 5" } } }, "Ungültige Einstellungen: engine.codex.model (ungültiger Modellname)"],
      [{ engine: { topics: { [TOPIC_KEY]: null } } }, "Unbekanntes Feld: engine.topics"],
      [{ engine: { codex: { fast: true } } }, "Unbekanntes Feld: engine.codex.fast"],
      [{ engine: null }, "Falscher Typ: engine"],
      [{ engine: { default: 1 } }, "Falscher Typ: engine.default"],
    ];
    for (const [patch, error] of cases) {
      const res = await ctx.api("/api/settings", "PATCH", patch);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(error);
    }
    expect(await readFile(file, "utf-8")).toBe(before);
  });

  test("gemeinsame Schreibkette mit /motor: gleichzeitige Änderungen verlieren keinen Eintrag", async () => {
    const ctx = await server();
    await Promise.all([
      ctx.api("/api/settings", "PATCH", { engine: { default: "codex" } }),
      setTopicEngine(TOPIC_KEY, "claude"),
      ctx.api("/api/settings", "PATCH", { engine: { codex: { sandbox: "read-only" } } }),
      setTopicEngine(DM_KEY, "codex"),
      ctx.api("/api/settings", "PATCH", { agents: { critic: { effort: "low" } } }),
    ]);
    expect(await readFileJson()).toEqual({
      agents: { critic: { effort: "low" } },
      engine: { default: "codex", topics: { [TOPIC_KEY]: "claude", [DM_KEY]: "codex" }, codex: { sandbox: "read-only" } },
    });
  });
});
