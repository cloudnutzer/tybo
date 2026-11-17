/**
 * Issue #514, Aufgabe 3: feste Regeln des Wizards. Sie liegen auf dem Server,
 * werden als fest: true gemeldet und lassen sich über die API weder ändern
 * noch abschalten (422). Nachweis über PUT, Bauen, die Vorgaben fürs Rezept,
 * den erzeugten Prompt und den ersten Satz beim Anbieter.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setChoicesFileForTests } from "../src/lib/choices";
import { firstMessage } from "../src/lib/voice-agents/elevenlabs";
import { buildPrompt, providerPrompt } from "../src/lib/voice-agents/prompt";
import { parseRecipe } from "../src/lib/voice-agents/recipe";
import { TEMPLATES } from "../src/lib/voice-agents/templates";
import { FIXED_RULES } from "../src/lib/voice-agents/templates/base";
import { applyFixed, applyOverlay, checkFields, wizardOverlay, WIZARD_KI_HINWEIS } from "../src/lib/voice-agents/wizard";
import { ablageDir, draftRecipe, removeDraftDirs } from "./voice-agents-drafts-fixture";
import { kitchenFields, removeWizardRoots, stopWizardServers, wizardHarness } from "./voice-agent-wizard-fixture";

let counter = 0;
let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  setChoicesFileForTests(join(tmpdir(), `wizard-fest-${process.pid}-${++counter}.json`));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  logSpy.mockRestore();
  await stopWizardServers();
});
afterAll(() => {
  setChoicesFileForTests(null);
  removeWizardRoots();
  removeDraftDirs();
});

type W = Awaited<ReturnType<typeof wizardHarness>>;
const put = (w: W, body: unknown) => w.ctx.api("/api/voice-agents/wizard/kochhilfe", "PUT", body);
const NOTFALL = FIXED_RULES.find((r) => r.startsWith("Notfall"))!;

async function created(w: W, felder: unknown = kitchenFields()) {
  const res = await put(w, { felder });
  expect(res.status).toBe(201);
  return res.json();
}

describe("Feste Regeln im Entwurf", () => {
  test("gemeldet mit fest: true: KI-Hinweis, Notfall-Regel 112 und die übrigen der Vorlage", async () => {
    const w = await wizardHarness();
    const body = await created(w);
    expect(body.feste).toContainEqual({ feld: "persona.kiHinweis", wert: WIZARD_KI_HINWEIS.de, fest: true, grund: "KI-Hinweis als erster Satz jedes Gesprächs" });
    expect(body.feste).toContainEqual({ feld: "regeln", wert: NOTFALL, fest: true, grund: "Notfall-Regel 112" });
    expect(body.feste.every((f: any) => f.fest === true)).toBe(true);
    expect(body.felder.regeln.filter((r: any) => r.fest).map((r: any) => r.text)).toEqual([...TEMPLATES.jarvis.fixedRules]);
    expect(body.felder.persona.kiHinweis).toBe(WIZARD_KI_HINWEIS.de);
  });

  test("KI-Hinweis bei jeder Vorlage, auch beim Experten; englisch bei erster Sprache en", async () => {
    for (const vorlage of ["anrufannahme", "jarvis", "experte"] as const) {
      const checked = checkFields({ vorlage });
      expect(checked.ok && checked.felder.persona?.kiHinweis).toBe(WIZARD_KI_HINWEIS.de);
    }
    const en = checkFields({ persona: { sprachen: ["en", "de"] } });
    expect(en.ok && en.felder.persona?.kiHinweis).toBe(WIZARD_KI_HINWEIS.en);
  });

  test("zurückgeschickt, wie GET es liefert: 200, die festen Regeln stehen nicht doppelt in der Datei", async () => {
    const w = await wizardHarness();
    const body = await created(w);
    const echo = { ...body.felder, regeln: [...body.felder.regeln, { text: "Mengen in Gramm", fest: false }] };
    const res = await put(w, { revision: 1, felder: echo });
    expect(res.status).toBe(200);
    const file = JSON.parse(readFileSync(join(ablageDir(w.h, "kochhilfe"), "wizard.json"), "utf8"));
    expect(file.felder.regeln).toEqual(["Mengen in Gramm"]);
  });
});

describe("Abschalten oder Ändern ergibt 422", () => {
  const attempts: [string, (f: any) => void][] = [
    ["KI-Hinweis umformuliert", (f) => (f.persona.kiHinweis = "Hallo!")],
    ["KI-Hinweis geleert", (f) => (f.persona.kiHinweis = "")],
    ["KI-Hinweis null", (f) => (f.persona.kiHinweis = null)],
    ["Notfall-Regel aus der Liste genommen", (f) => (f.regeln = [{ text: "Eigene Regel", fest: false }])],
    ["feste Regel umformuliert", (f) => (f.regeln = [...TEMPLATES.jarvis.fixedRules.map((text) => ({ text, fest: true })), { text: NOTFALL.replace("112", "110"), fest: true }])],
    ["Anrufannahme mit Gedächtnis", (f) => ((f.vorlage = "anrufannahme"), (f.gedaechtnis = "thema"))],
    ["Gedächtnis voll am Telefon ohne PIN", (f) => ((f.gedaechtnis = "voll"), (f.zugang.telefon = { nummer: "nr1", anrufer: "freigegeben", pin: false }))],
  ];
  for (const [what, change] of attempts) {
    test(`${what}: 422, nichts gespeichert`, async () => {
      const w = await wizardHarness();
      await created(w);
      const res = await put(w, { revision: 1, felder: kitchenFields(change) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.reason).toBe("fest");
      expect(body.fehler.length).toBeGreaterThan(0);
      expect((await (await w.ctx.api("/api/voice-agents/wizard/kochhilfe")).json()).revision).toBe(1);
      // Auch beim Anlegen
      expect((await w.ctx.api("/api/voice-agents/wizard/neu", "PUT", { felder: kitchenFields(change) })).status).toBe(422);
    });
  }

  test("fehlen die Werte, setzt der Server sie: Anrufannahme keins, Telefon mit voll bekommt PIN", async () => {
    const w = await wizardHarness();
    const call = await created(w, kitchenFields((f) => ((f.vorlage = "anrufannahme"), delete f.gedaechtnis)));
    expect(call.felder.gedaechtnis).toBe("keins");
    expect(call.feste).toContainEqual(expect.objectContaining({ feld: "gedaechtnis", wert: "keins", fest: true }));
    const res = await put(w, { revision: 1, felder: kitchenFields((f) => ((f.gedaechtnis = "voll"), (f.zugang.telefon = { nummer: "nr1", anrufer: "freigegeben" }))) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.felder.zugang.telefon.pin).toBe(true);
    expect(body.feste).toContainEqual(expect.objectContaining({ feld: "zugang.telefon.pin", wert: true, fest: true }));
  });

  test("Bauen nimmt nur revision: Felder oder anderes im Körper ergibt 422", async () => {
    const w = await wizardHarness();
    await created(w);
    for (const body of [{ revision: 1, felder: kitchenFields((f) => (f.persona.kiHinweis = "x")) }, { revision: 1, gedaechtnis: "voll" }, {}]) {
      const res = await w.ctx.api("/api/voice-agents/wizard/kochhilfe/bauen", "POST", body);
      expect(res.status).toBe(422);
    }
    expect(w.h.jobs.starts).toHaveLength(0);
  });

  test("von Hand geänderte Datei: Entwurf meldet den Verstoß, Bauen ergibt 422", async () => {
    const w = await wizardHarness();
    await created(w);
    const file = join(ablageDir(w.h, "kochhilfe"), "wizard.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.felder.persona.kiHinweis = "Hallo";
    raw.felder.vorlage = "anrufannahme";
    raw.felder.gedaechtnis = "voll";
    writeFileSync(file, JSON.stringify(raw));
    const body = await (await w.ctx.api("/api/voice-agents/wizard/kochhilfe")).json();
    expect(body.festFehler.length).toBe(2);
    const res = await w.ctx.api("/api/voice-agents/wizard/kochhilfe/bauen", "POST", { revision: 1 });
    expect(res.status).toBe(422);
    expect((await res.json()).reason).toBe("fest");
    expect(w.h.jobs.starts).toHaveLength(0);
  });
});

describe("Ins Rezept, in den Prompt, zum Anbieter", () => {
  test("Vorgaben ohne Metadaten; Anrufannahme keins, voll am Telefon mit PIN, im strikten Schema gültig", () => {
    const anruf = applyFixed({ ...kitchenFields((f) => ((f.vorlage = "anrufannahme"), (f.gedaechtnis = undefined))) });
    const overlay = wizardOverlay(anruf, "kochhilfe");
    expect(JSON.stringify(overlay)).not.toContain("fest");
    const job = draftRecipe("kochhilfe", (r) => (r.gedaechtnis = "voll"));
    const recipe = parseRecipe(applyOverlay(job, overlay));
    expect(recipe.ok).toBe(true);
    if (!recipe.ok) return;
    expect(recipe.recipe.gedaechtnis).toBe("keins");
    expect(recipe.recipe.persona.kiHinweis).toBe(WIZARD_KI_HINWEIS.de);

    const voll = applyFixed(kitchenFields((f) => ((f.gedaechtnis = "voll"), (f.gehirn = { art: "bruecke", modell: "claude-opus-5-5" }), (f.zugang.telefon = { nummer: "nr1", anrufer: "freigegeben" }), (f.zugang.anrufeJeNummerTag = 3))));
    const phone = parseRecipe(applyOverlay(draftRecipe("kochhilfe"), wizardOverlay(voll, "kochhilfe")));
    expect(phone.ok && phone.recipe.zugang.telefon).toEqual({ nummer: "nr1", anrufer: "freigegeben", pin: true });
  });

  test("Prompt und erster Satz beim Anbieter beginnen mit dem KI-Hinweis; Notfall-Regel bei den festen Regeln", () => {
    const felder = applyFixed(kitchenFields());
    const parsed = parseRecipe(applyOverlay(draftRecipe("kochhilfe", (r) => delete r.persona.kiHinweis), wizardOverlay(felder, "kochhilfe")));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const recipe = parsed.recipe;
    const prompt = providerPrompt(recipe, TEMPLATES[recipe.vorlage], null);
    expect(prompt).toContain(`# Begrüßung\nDein Gespräch beginnt mit diesem Hinweis: „${WIZARD_KI_HINWEIS.de}“`);
    expect(prompt.slice(prompt.indexOf("# Feste Regeln"))).toContain("112");
    expect(buildPrompt(recipe, TEMPLATES[recipe.vorlage])).toContain(NOTFALL);
    expect(firstMessage(recipe.persona)).toStartWith(WIZARD_KI_HINWEIS.de);
    expect(firstMessage(recipe.persona)).toBe(`${WIZARD_KI_HINWEIS.de} ${recipe.persona.ersterSatz}`);
  });
});
