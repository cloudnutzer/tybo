/**
 * Issue #493, Checkbox 4: Stimmwahl per Knopf vor der Freigabe. Der Entwurf
 * nennt eine Beschreibung (stimme.txt), tybo schlägt bis zu drei Stimmen des
 * Kontos beim Anbieter vor, die gewählte Kennung kommt ins Rezept. Abruf der
 * Stimmen mit einer fetch-Attrappe, kein Anbieteraufruf.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideChoice, onChoiceDecided, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { recipeHash } from "../src/lib/voice-agents/base";
import { brainPerMinute, costLine, DEFAULT_PRICE_BASIS, loadPriceBasis } from "../src/lib/voice-agents/cost";
import { DRAFT_TEXT } from "../src/lib/voice-agents/drafts";
import { saveRecipe } from "../src/lib/voice-agents/recipe";
import { updateState } from "../src/lib/voice-agents/state";
import { listProviderVoices, suggestVoices, type ProviderVoice } from "../src/lib/voice-agents/voice-catalog";
import { DM, draftHarness, draftRecipe, readRecord, removeDraftDirs, writeOutput, type DraftHarness } from "./voice-agents-drafts-fixture";

const ID = "20261107-090001-a1b2c3";
let counter = 0;
let off: (() => void)[] = [];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  const h = draftHarness();
  setChoicesFileForTests(join(h.root, `choices-${++counter}.json`));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const stop of off.splice(0)) stop();
  logSpy.mockRestore();
});
afterAll(() => {
  setChoicesFileForTests(null);
  removeDraftDirs();
});

const KATALOG = {
  voices: [
    { voice_id: "v-anna", name: "Anna", category: "premade", labels: { gender: "female", age: "middle aged", accent: "german" }, description: "calm and warm" },
    { voice_id: "v-bert", name: "Bert", category: "premade", labels: { gender: "male", age: "old", accent: "german" }, description: "deep" },
    { voice_id: "v-klon", name: "Meine Stimme", category: "cloned", labels: { gender: "female", accent: "german" }, description: "" },
    { voice_id: "v-cleo", name: "Cleo", category: "professional", labels: { gender: "female", age: "young", accent: "american" }, description: "energetic" },
    { voice_id: "v-dora", name: "Dora", category: "premade", labels: { gender: "female", accent: "german" }, description: "calm" },
    { voice_id: "kaputt id!", name: "Kaputt", category: "premade" },
    { voice_id: "v-leer", name: "   " },
  ],
};

describe("Stimmen des Kontos", () => {
  test("Abruf mit Schlüssel im Kopf; ungültige Einträge fallen weg; ohne Schlüssel kein Abruf", async () => {
    const calls: { url: string; key: string | null }[] = [];
    const voices = await listProviderVoices({ ELEVENLABS_API_KEY: "xi-test" }, async (url, init) => {
      calls.push({ url, key: new Headers(init.headers).get("xi-api-key") });
      return new Response(JSON.stringify(KATALOG), { status: 200 });
    });
    expect(calls).toEqual([{ url: "https://api.elevenlabs.io/v1/voices", key: "xi-test" }]);
    expect(voices.map((v) => v.voiceId)).toEqual(["v-anna", "v-bert", "v-klon", "v-cleo", "v-dora"]);
    let called = false;
    expect(await listProviderVoices({}, async () => ((called = true), new Response("{}")))).toEqual([]);
    expect(called).toBe(false);
  });

  test("Fehler des Anbieters oder kaputte Antwort: leer, kein Wurf", async () => {
    expect(await listProviderVoices({ ELEVENLABS_API_KEY: "k" }, async () => new Response("nein", { status: 500 }))).toEqual([]);
    expect(await listProviderVoices({ ELEVENLABS_API_KEY: "k" }, async () => new Response("{kaputt"))).toEqual([]);
    expect(await listProviderVoices({ ELEVENLABS_API_KEY: "k" }, async () => Promise.reject(new Error("weg")))).toEqual([]);
  });

  test("Vorschläge: höchstens drei, deutsche Beschreibung trifft englische Merkmale, Klon bei Gleichstand zuerst", async () => {
    const voices = await listProviderVoices({ ELEVENLABS_API_KEY: "k" }, async () => new Response(JSON.stringify(KATALOG)));
    const picks = suggestVoices("ruhige weibliche Stimme, deutsch", voices);
    expect(picks).toHaveLength(3);
    expect(picks[0]).toEqual({ voiceId: "v-anna", name: "Anna", klon: false });
    expect(picks.map((p) => p.voiceId)).toEqual(["v-anna", "v-dora", "v-klon"]);
    expect(suggestVoices("weiblich", voices).map((p) => p.voiceId)[0]).toBe("v-klon");
    expect(suggestVoices("Roboter", voices)).toEqual([]);
  });
});

function wired(voices: ProviderVoice[] = []): DraftHarness {
  const h = draftHarness({ deps: { suggestVoices: async (d) => suggestVoices(d, voices) } });
  off.push(onChoiceDecided("sprachagent", h.service.handler));
  return h;
}

const CATALOG: ProviderVoice[] = [
  { voiceId: "v-anna", name: "Anna", category: "premade", words: "anna female middle aged german calm warm" },
  { voiceId: "v-klon", name: "Meine Stimme", category: "cloned", words: "meine stimme female german" },
  { voiceId: "v-bert", name: "Bert", category: "premade", words: "bert male old german deep" },
];

async function toVoice(h: DraftHarness, voice = "ruhige weibliche Stimme"): Promise<Choice> {
  await h.service.startNew("Kochhilfe", DM);
  writeOutput(h, ID, { recipe: draftRecipe(), voice });
  h.jobs.finish(h.jobs.last().id);
  await h.service.tick();
  return h.sent.at(-1)!;
}

describe("Stimmwahl vor der Freigabe", () => {
  test("Rückfrage mit bis zu drei Vorschlägen und der Standardstimme; Wahl kommt ins Rezept, dann die Freigabe", async () => {
    const h = wired(CATALOG);
    const choice = await toVoice(h);
    expect(choice).toMatchObject({ kind: "sprachagent", action: "stimme", ref: ID });
    expect(choice.text).toContain("„ruhige weibliche Stimme“");
    expect(choice.options).toEqual([
      { key: "s0", label: "Anna" },
      { key: "s1", label: "Meine Stimme (Klon)" },
      { key: "standard", label: "Standardstimme" },
    ]);
    expect(readRecord(h, ID).phase).toBe("stimme");
    await decideChoice(choice.id, "s1", "web");
    const record = readRecord(h, ID);
    expect(record.phase).toBe("freigabe");
    expect(record.rezept!.stimme.voiceId).toBe("v-klon");
    expect(record.rezeptHash).toBe(recipeHash(record.rezept));
    const approval = h.sent.at(-1)!;
    expect(approval.action).toBe("freigabe");
    expect(approval.text).toContain("Stimme: Meine Stimme");
    await decideChoice(approval.id, "anlegen", "web");
    await h.service.settled();
    expect(JSON.parse(readFileSync(join(h.paths.configDir, "kochhilfe.json"), "utf8")).stimme.voiceId).toBe("v-klon");
  });

  test("Standardstimme gewählt: eingefroren beim Klick; eine spätere Änderung der Einstellung ändert die freigegebene Stimme nicht", async () => {
    const h = wired(CATALOG);
    await decideChoice((await toVoice(h)).id, "standard", "telegram");
    const record = readRecord(h, ID);
    expect(record.rezept!.stimme.voiceId).toBe("standard-stimme");
    expect(record.rezeptHash).toBe(recipeHash(record.rezept));
    expect(h.sent.at(-1)!.text).toContain("Stimme: Standardstimme");
    // Zwischen Freigabe und Anlegen wird die Einstellung geändert
    h.standard = "neue-standard-stimme";
    await decideChoice(h.sent.at(-1)!.id, "anlegen", "telegram");
    await h.service.settled();
    expect(JSON.parse(readFileSync(join(h.paths.configDir, "kochhilfe.json"), "utf8")).stimme.voiceId).toBe("standard-stimme");
  });

  test("neu ohne Stimmwahl: die Standardstimme der Freigabe gilt, auch wenn die Einstellung danach wechselt", async () => {
    const h = wired([]);
    const approval = await toVoice(h, "eine Stimme, die es nicht gibt");
    expect(approval.action).toBe("freigabe");
    expect(readRecord(h, ID).rezept!.stimme.voiceId).toBe("standard-stimme");
    h.standard = "neue-standard-stimme";
    await decideChoice(approval.id, "anlegen", "telegram");
    await h.service.settled();
    expect(JSON.parse(readFileSync(join(h.paths.configDir, "kochhilfe.json"), "utf8")).stimme.voiceId).toBe("standard-stimme");
  });

  test("Erneut versuchen nach einer Änderung der Einstellung: gespeichert wird die freigegebene Stimme", async () => {
    const h = wired(CATALOG);
    // Ein alter Zustand beim Anbieter lässt die Erreichbarkeitsprüfung vor dem Speichern scheitern
    await updateState("kochhilfe", { kennung: "kochhilfe", anbieter: "elevenlabs", agentId: "agent-alt" } as any, h.paths);
    h.layer.reachableResult = { status: "fehler", fehler: "Zeitablauf", vorlaeufig: true };
    await decideChoice((await toVoice(h)).id, "standard", "telegram");
    await decideChoice(h.sent.at(-1)!.id, "anlegen", "telegram");
    await h.service.settled();
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
    expect(existsSync(join(h.paths.configDir, "kochhilfe.json"))).toBe(false);
    h.standard = "neue-standard-stimme";
    h.layer.reachableResult = { status: "ok", erreichbar: false };
    await decideChoice(h.sent.at(-1)!.id, "weiter", "telegram");
    await h.service.settled();
    expect(JSON.parse(readFileSync(join(h.paths.configDir, "kochhilfe.json"), "utf8")).stimme.voiceId).toBe("standard-stimme");
  });

  test("aendern: der Knopf Standardstimme ersetzt die bisherige Stimme des Agenten", async () => {
    const h = wired(CATALOG);
    await saveRecipe(draftRecipe("kochhilfe", (r) => (r.stimme.voiceId = "alte-stimme")), { ...h.paths, voices: {} });
    await h.service.startChange("kochhilfe", "andere Stimme, ruhig und weiblich", DM);
    writeOutput(h, ID, { recipe: draftRecipe("kochhilfe", (r) => (r.stimme.voiceId = "alte-stimme")), voice: "ruhige weibliche Stimme" });
    h.jobs.finish(h.jobs.last().id);
    await h.service.tick();
    const choice = h.sent.at(-1)!;
    expect(choice.action).toBe("stimme");
    await decideChoice(choice.id, "standard", "telegram");
    const record = readRecord(h, ID);
    expect(record.rezept!.stimme.voiceId).toBe("standard-stimme");
    const approval = h.sent.at(-1)!;
    expect(approval.text).toContain("Stimme: Standardstimme");
    expect(approval.text).toContain("Geändert: stimme.voiceId");
    h.standard = "neue-standard-stimme";
    await decideChoice(approval.id, "anlegen", "telegram");
    await h.service.settled();
    expect(JSON.parse(readFileSync(join(h.paths.configDir, "kochhilfe.json"), "utf8")).stimme.voiceId).toBe("standard-stimme");
  });

  test("keine passende Stimme oder kein Anbieter: gleich die Freigabe mit der Standardstimme", async () => {
    const h = wired([]);
    const choice = await toVoice(h);
    expect(choice.action).toBe("freigabe");
    expect(choice.text).toContain("Stimme: Standardstimme");
  });

  test("ohne Standardstimme sagt die Freigabe, dass das Anlegen scheitern würde; eine später gesetzte Einstellung gilt nicht", async () => {
    const h = draftHarness({ standardVoice: null });
    off.push(onChoiceDecided("sprachagent", h.service.handler));
    const choice = await toVoice(h);
    expect(choice.text).toContain("Stimme: keine festgelegt, Anlegen scheitert ohne Stimme");
    h.standard = "spaeter-gesetzt";
    await decideChoice(choice.id, "anlegen", "telegram");
    await h.service.settled();
    expect(existsSync(join(h.paths.configDir, "kochhilfe.json"))).toBe(false);
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.noVoice("kochhilfe"));
  });

  test("Stimmwahl zweimal oder nach der Freigabe: nichts ändert sich", async () => {
    const h = wired(CATALOG);
    const choice = await toVoice(h);
    await decideChoice(choice.id, "s0", "telegram");
    const before = readRecord(h, ID);
    await h.service.handler({ ...choice, state: "done", result: { key: "s1", label: "x", via: "telegram", at: Date.now() } });
    expect(readRecord(h, ID).rezept!.stimme.voiceId).toBe(before.rezept!.stimme.voiceId);
  });
});

describe("geschätzte Kosten je Minute", () => {
  const recipe = (over: any = {}) => ({ gehirn: { art: "anbieter", modell: "claude-sonnet-5-5", denkauftrag: false }, zugang: { maxMinuten: 10, budget: { minutenMonat: 100, anrufeJeNummerTag: 0 } }, ...over });
  const builtin = { status: "ok", basis: DEFAULT_PRICE_BASIS, eigene: false } as const;

  test("eingebaute Grundlage: Tarif, Annahmen, Preisstand und Primärquellen; Rechnung nachvollziehbar", () => {
    expect(DEFAULT_PRICE_BASIS).toMatchObject({ stand: "2026-11-07", waehrung: "USD", anbieter: { jeMinute: 0.08, quelle: "https://elevenlabs.io/pricing/agents" } });
    expect(DEFAULT_PRICE_BASIS.gehirn.quelle).toBe("https://elevenlabs.io/scale-tier#llm-prices");
    // 3 Züge × (6.700 × 2,20 + 150 × 11) / 1.000.000
    expect(brainPerMinute(DEFAULT_PRICE_BASIS, "claude-sonnet-5-5")).toBeCloseTo(0.04917, 5);
    const line = costLine(recipe() as any, builtin);
    expect(line).toContain("Kosten je Minute: etwa 0,129 USD (Anbieter 0,08 USD, Gehirn claude-sonnet-5-5 0,049 USD), ein Gespräch von höchstens 10 Minuten bis 1,292 USD.");
    expect(line).toContain("Tarif: ElevenLabs Agents, jede Minute zum Preis der Zusatzminute");
    expect(line).toContain("ohne Prompt-Cache");
  });

  test("ohne eigene Datei gilt die eingebaute Grundlage; die Vorlage im Repo ist gültig und gleicht ihr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preise-"));
    expect(await loadPriceBasis(dir)).toEqual(builtin);
    copyFileSync(join(import.meta.dir, "..", "config", "voice-agent-preise.example.json"), join(dir, "voice-agent-preise.json"));
    expect(await loadPriceBasis(dir)).toEqual({ status: "ok", basis: DEFAULT_PRICE_BASIS, eigene: true });
    writeFileSync(join(dir, "voice-agent-preise.json"), JSON.stringify({ ...DEFAULT_PRICE_BASIS, anbieter: { jeMinute: null, quelle: "https://elevenlabs.io/pricing/agents" } }));
    expect(await loadPriceBasis(dir)).toEqual({ status: "ungueltig" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("Telefon: Gebühren des Telefonanbieters nicht enthalten und genannt, auch beim Höchstbetrag", () => {
    const withPhone = recipe({ zugang: { maxMinuten: 10, telefon: { nummer: "n", anrufer: "freigegeben", pin: true }, budget: { minutenMonat: 100, anrufeJeNummerTag: 1 } } });
    const line = costLine(withPhone as any, builtin);
    expect(line).toContain("bis 1,292 USD ohne Telefonanbieter.");
    expect(line).toContain("ohne Gebühren des Telefonanbieters (ElevenLabs berechnet Telefonie nicht zusätzlich");
  });

  test("Brücke: nur der Anteil des Anbieters, ausdrücklich ohne Gehirn und ohne Höchstbetrag je Gespräch", () => {
    const bridge = costLine(recipe({ gehirn: { art: "bruecke", modell: "claude-opus-5-5", denkauftrag: false } }) as any, builtin);
    expect(bridge).toStartWith("Kosten je Minute: Anbieter etwa 0,08 USD, ohne das Gehirn");
    expect(bridge).toContain("Eine Obergrenze je Gespräch nennt tybo deshalb nicht");
    expect(bridge).not.toMatch(/höchstens \d+ Minuten bis/);
  });

  test("ungültige eigene Datei und fehlender Modellpreis: unbekannt, nie eine erfundene Zahl", () => {
    expect(costLine(recipe() as any, { status: "ungueltig" })).toContain("ungültig");
    expect(costLine(recipe({ gehirn: { art: "anbieter", modell: "anderes-modell", denkauftrag: false } }) as any, builtin)).toStartWith("Kosten je Minute: unbekannt, für das Modell anderes-modell steht kein Preis");
  });
});
