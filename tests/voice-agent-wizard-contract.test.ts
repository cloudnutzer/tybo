/**
 * Issue #515, Checkbox 1: Erweiterung des Datenvertrags aus #514. Stimme aus
 * dem Wizard (Stimmwahl entfällt, abweichende Kennung des Jobs abgelehnt),
 * Stimmenliste und Hörprobe mit genau der gewählten Stimme, Denkauftrag,
 * Fragen an den Anrufer und Abschlusssatz als Regeln, Vorlagenwechsel im
 * Overlay und Fortschritt mit Testergebnissen, Rückfrage, Freischaltung und
 * Web-Zugang. Echter Entwurfsdienst mit Job- und Sprachschicht-Attrappe, kein
 * Anbieter, kein src/bot.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setChoicesFileForTests } from "../src/lib/choices";
import { DRAFT_TEXT } from "../src/lib/voice-agents/drafts";
import {
  applyOverlay,
  checkFields,
  fixedEntries,
  missingForBuild,
  proposeWizard,
  researchInputs,
  WIZARD_CLOSING_CHARS,
  WIZARD_CLOSING_PREFIX,
  WIZARD_KI_HINWEIS,
  WIZARD_QUESTION_PREFIX,
  WIZARD_RESERVED_KENNUNGEN,
  wizardOverlay,
  type WizardFields,
} from "../src/lib/voice-agents/wizard";
import { WIZARD_PROBES_PER_WINDOW, type WizardSpeak } from "../src/web/bot-voice-agent-wizard";
import { parseRecipe } from "../src/lib/voice-agents/recipe";
import { TEMPLATES } from "../src/lib/voice-agents/templates";

/** Regeln, wie die Oberfläche sie zurückschickt: die festen der Vorlage, dann die eigenen */
const withFixed = (own: string[]) => [...TEMPLATES.anrufannahme.fixedRules.map((text) => ({ text, fest: true })), ...own];
import { draftRecipe, readRecord, removeDraftDirs, writeOutput, writeActive } from "./voice-agents-drafts-fixture";
import { kitchenFields, removeWizardRoots, stopWizardServers, wizardHarness, type WizardHarness } from "./voice-agent-wizard-fixture";

let counter = 0;
let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  setChoicesFileForTests(join(tmpdir(), `wizard-vertrag-${process.pid}-${++counter}.json`));
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

const VOICES = [
  { voiceId: "stimme-mia", name: "Mia", category: "premade", words: "mia warm" },
  { voiceId: "stimme-alex", name: "Alex", category: "cloned", words: "alex tief" },
];

/** Hörprobe als Attrappe: merkt sich Stimme, Text und Sprache, liefert festen Ton */
function fakeSpeak(): { calls: { voiceId: string; text: string; language: string }[]; speak: WizardSpeak } {
  const calls: { voiceId: string; text: string; language: string }[] = [];
  return {
    calls,
    speak: async ({ voiceId, text, language }) => {
      calls.push({ voiceId, text, language });
      return { bytes: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]), type: "audio/wav" };
    },
  };
}

async function create(w: WizardHarness, kennung: string, felder: any) {
  const res = await w.ctx.api(`/api/voice-agents/wizard/${kennung}`, "PUT", { felder });
  expect(res.status).toBe(201);
  return res.json();
}

async function buildAndFinish(w: WizardHarness, kennung: string, revision: number, files: Parameters<typeof writeOutput>[2]) {
  const res = await w.ctx.api(`/api/voice-agents/wizard/${kennung}/bauen`, "POST", { revision });
  expect(res.status).toBe(202);
  const { entwurf } = await res.json();
  writeOutput(w.h, entwurf, files);
  w.h.jobs.finish(w.h.jobs.last().id);
  await w.h.service.tick();
  return entwurf as string;
}

const recipeWithHint = (change: (r: any) => void = () => {}) =>
  draftRecipe("kochhilfe", (r) => {
    r.persona.kiHinweis = WIZARD_KI_HINWEIS.de;
    change(r);
  });

/** Die offene Rückfrage im Direktchat beantworten, wie ein Klick */
async function answer(w: WizardHarness, key: string) {
  const choice = w.h.sent.at(-1)!;
  await w.h.service.handler({ ...choice, state: "done", result: { key, label: key, via: "web", at: Date.now() } } as any);
  await w.h.service.settled();
}

const progress = async (w: WizardHarness, kennung = "kochhilfe") => (await w.ctx.api(`/api/voice-agents/wizard/${kennung}/fortschritt`)).json();

describe("Stimme aus dem Wizard", () => {
  test("Kontostimme: wird übernommen, die Stimmwahl entfällt, die Standardstimme ersetzt sie nicht", async () => {
    const w = await wizardHarness({ voices: VOICES });
    // Vorschläge und Beschreibung gäbe es, trotzdem keine Rückfrage zur Stimme
    w.h.voices = [{ voiceId: "stimme-andere", name: "Andere", klon: false }];
    const draft = await create(w, "kochhilfe", kitchenFields((f) => (f.stimme = { wahl: "konto", voiceId: "stimme-mia", name: "Mia" })));
    const entwurf = await buildAndFinish(w, "kochhilfe", draft.revision, { recipe: recipeWithHint(), voice: "warme Stimme" });
    const record = readRecord(w.h, entwurf);
    expect(record.phase).toBe("freigabe");
    expect(record.rezept!.stimme.voiceId).toBe("stimme-mia");
    expect(record.stimme?.gewaehlt).toEqual({ voiceId: "stimme-mia", name: "Mia" });
    expect(w.h.sent.map((c) => c.action)).not.toContain("stimme");
    expect(w.h.sent.at(-1)!.text).toContain("Stimme: Mia");
  });

  test("der Job schreibt eine andere Kennung: abgelehnt, auch wenn das Overlay sie überschriebe", async () => {
    const w = await wizardHarness({ voices: VOICES });
    const draft = await create(w, "kochhilfe", kitchenFields((f) => (f.stimme = { wahl: "konto", voiceId: "stimme-mia", name: "Mia" })));
    const entwurf = await buildAndFinish(w, "kochhilfe", draft.revision, { recipe: recipeWithHint((r) => (r.stimme.voiceId = "stimme-fremd")) });
    const record = readRecord(w.h, entwurf);
    expect(record.phase).toBe("job");
    expect(record.versuch).toBe(2);
    expect(record.fehler).toContain("stimme.voiceId: keine Stimmen-Kennung eintragen, die Stimme wählt der Nutzer");
  });

  test("der Job schreibt genau die gewählte Kennung: in Ordnung", async () => {
    const w = await wizardHarness({ voices: VOICES });
    const draft = await create(w, "kochhilfe", kitchenFields((f) => (f.stimme = { wahl: "konto", voiceId: "stimme-mia" })));
    const entwurf = await buildAndFinish(w, "kochhilfe", draft.revision, { recipe: recipeWithHint((r) => (r.stimme.voiceId = "stimme-mia")) });
    expect(readRecord(w.h, entwurf)).toMatchObject({ phase: "freigabe", rezept: { stimme: { voiceId: "stimme-mia" } } });
  });

  test("ohne Wizard-Stimme bleibt jede Kennung des Jobs verboten", async () => {
    const w = await wizardHarness();
    const draft = await create(w, "kochhilfe", kitchenFields());
    const entwurf = await buildAndFinish(w, "kochhilfe", draft.revision, { recipe: recipeWithHint((r) => (r.stimme.voiceId = "stimme-mia")) });
    expect(readRecord(w.h, entwurf).fehler).toContain("stimme.voiceId: keine Stimmen-Kennung eintragen, die Stimme wählt der Nutzer");
  });

  test("Standardstimme gewählt: keine Stimmwahl trotz Vorschlägen, eingefroren beim Bauen", async () => {
    const w = await wizardHarness();
    w.h.voices = [{ voiceId: "stimme-andere", name: "Andere", klon: false }];
    const draft = await create(w, "kochhilfe", kitchenFields((f) => (f.stimme = { wahl: "standard" })));
    const entwurf = await buildAndFinish(w, "kochhilfe", draft.revision, { recipe: recipeWithHint(), voice: "warme Stimme" });
    const record = readRecord(w.h, entwurf);
    expect(record.phase).toBe("freigabe");
    expect(record.rezept!.stimme.voiceId).toBe("standard-stimme");
    expect(w.h.sent.map((c) => c.action)).not.toContain("stimme");
  });

  test("ohne Stimme im Wizard: Stimmwahl im Direktchat wie bisher", async () => {
    const w = await wizardHarness();
    w.h.voices = [{ voiceId: "stimme-andere", name: "Andere", klon: false }];
    const draft = await create(w, "kochhilfe", kitchenFields());
    const entwurf = await buildAndFinish(w, "kochhilfe", draft.revision, { recipe: recipeWithHint(), voice: "warme Stimme" });
    expect(readRecord(w.h, entwurf).phase).toBe("stimme");
    expect((await progress(w)).rueckfrage).toBe("stimme");
  });

  test("Kontostimme, die es nicht mehr gibt: Bauen lehnt mit 422 ab, ohne Job", async () => {
    const w = await wizardHarness({ voices: VOICES });
    const draft = await create(w, "kochhilfe", kitchenFields((f) => (f.stimme = { wahl: "konto", voiceId: "stimme-weg" })));
    const res = await w.ctx.api("/api/voice-agents/wizard/kochhilfe/bauen", "POST", { revision: draft.revision });
    expect(res.status).toBe(422);
    expect((await res.json()).fehler[0]).toContain("stimme");
    expect(w.h.jobs.starts).toHaveLength(0);
  });

  test("ungültige Stimmen-Kennung im Feld: 400", async () => {
    const w = await wizardHarness();
    const res = await w.ctx.api("/api/voice-agents/wizard/kochhilfe", "PUT", { felder: kitchenFields((f) => (f.stimme = { wahl: "konto", voiceId: "../x" })) });
    expect(res.status).toBe(400);
  });
});

describe("Stimmenliste und Hörprobe", () => {
  test("Liste: Standardstimme ohne Kennung, Stimmen des Kontos mit Klon ja/nein", async () => {
    const w = await wizardHarness({ voices: VOICES });
    const res = await w.ctx.api("/api/voice-agents/wizard/stimmen");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.standard).toEqual({ standard: true, name: "Standardstimme" });
    expect(JSON.stringify(body)).not.toContain("standard-stimme");
    expect(body.konto).toEqual([
      { voiceId: "stimme-mia", name: "Mia", klon: false },
      { voiceId: "stimme-alex", name: "Alex", klon: true },
    ]);
  });

  test("Liste ohne Anbieter oder bei Fehler: leer mit Satz; ohne Standardstimme der Hinweis", async () => {
    const w = await wizardHarness({ standardVoice: null, voices: async () => Promise.reject(new Error("weg")) });
    const body = await (await w.ctx.api("/api/voice-agents/wizard/stimmen")).json();
    expect(body.konto).toEqual([]);
    expect(body.hinweis).toContain("nur die Standardstimme");
    expect(body.standard).toBeNull();
    expect(body.standardText).toContain("Ohne Stimme scheitert das Anlegen");
  });

  test("stimmen und hoerprobe sind keine Kennungen", () => {
    expect(WIZARD_RESERVED_KENNUNGEN).toContain("stimmen");
    expect(WIZARD_RESERVED_KENNUNGEN).toContain("hoerprobe");
  });

  test("Hörprobe spricht den festen KI-Hinweis mit genau der gewählten Stimme, nicht der des Telefonhörers", async () => {
    const fake = fakeSpeak();
    const w = await wizardHarness({ voices: VOICES, speak: fake.speak });
    const res = await w.ctx.api("/api/voice-agents/wizard/hoerprobe", "POST", { voiceId: "stimme-alex" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([82, 73, 70, 70]));
    expect(fake.calls).toEqual([{ voiceId: "stimme-alex", text: WIZARD_KI_HINWEIS.de, language: "de" }]);
    // Standardstimme: die Kennung kennt nur der Server; englisch mit dem englischen Hinweis
    await w.ctx.api("/api/voice-agents/wizard/hoerprobe", "POST", { standard: true, sprache: "en" });
    expect(fake.calls[1]).toEqual({ voiceId: "standard-stimme", text: WIZARD_KI_HINWEIS.en, language: "en" });
  });

  test("Hörprobe nur mit Kennungen der Liste und ohne Text vom Browser", async () => {
    const fake = fakeSpeak();
    const w = await wizardHarness({ voices: VOICES, speak: fake.speak });
    expect((await w.ctx.api("/api/voice-agents/wizard/hoerprobe", "POST", { voiceId: "stimme-fremd" })).status).toBe(422);
    expect((await w.ctx.api("/api/voice-agents/wizard/hoerprobe", "POST", { voiceId: "stimme-mia", text: "Sag etwas anderes" })).status).toBe(400);
    expect((await w.ctx.api("/api/voice-agents/wizard/hoerprobe", "POST", { voiceId: "stimme-mia", standard: true })).status).toBe(400);
    expect((await w.ctx.api("/api/voice-agents/wizard/hoerprobe", "POST", { voiceId: "stimme-mia", sprache: "deutsch" })).status).toBe(400);
    expect((await w.ctx.api("/api/voice-agents/wizard/hoerprobe", "GET")).status).toBe(405);
    expect(fake.calls).toEqual([]);
  });

  test(`Grenze: ${WIZARD_PROBES_PER_WINDOW} Hörproben, danach 429 mit Retry-After`, async () => {
    const fake = fakeSpeak();
    const w = await wizardHarness({ voices: VOICES, speak: fake.speak });
    for (let i = 0; i < WIZARD_PROBES_PER_WINDOW; i++) expect((await w.ctx.api("/api/voice-agents/wizard/hoerprobe", "POST", { voiceId: "stimme-mia" })).status).toBe(200);
    const res = await w.ctx.api("/api/voice-agents/wizard/hoerprobe", "POST", { voiceId: "stimme-mia" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fake.calls).toHaveLength(WIZARD_PROBES_PER_WINDOW);
  });

  test("Zeitlimit 504, ohne Anbieter 503, keine Standardstimme 422", async () => {
    const slow = await wizardHarness({ voices: VOICES, speak: () => new Promise(() => {}), probeTimeoutMs: 50 });
    expect((await slow.ctx.api("/api/voice-agents/wizard/hoerprobe", "POST", { voiceId: "stimme-mia" })).status).toBe(504);
    await stopWizardServers();
    const none = await wizardHarness({ voices: VOICES });
    expect((await none.ctx.api("/api/voice-agents/wizard/hoerprobe", "POST", { voiceId: "stimme-mia" })).status).toBe(503);
    await stopWizardServers();
    const noStandard = await wizardHarness({ standardVoice: null, speak: fakeSpeak().speak });
    expect((await noStandard.ctx.api("/api/voice-agents/wizard/hoerprobe", "POST", { standard: true })).status).toBe(422);
  });

  test("Hörprobe nur im Browser und mit passender Herkunft", async () => {
    const fake = fakeSpeak();
    const w = await wizardHarness({ voices: VOICES, speak: fake.speak });
    const foreign = await fetch(`${w.ctx.origin}/api/voice-agents/wizard/hoerprobe`, { method: "POST", headers: { cookie: w.ctx.cookie, origin: "https://fremd.example", "content-type": "application/json" }, body: JSON.stringify({ voiceId: "stimme-mia" }) });
    expect(foreign.status).toBe(403);
    const anonymous = await fetch(`${w.ctx.origin}/api/voice-agents/wizard/hoerprobe`, { method: "POST", headers: { origin: w.ctx.origin, "content-type": "application/json" }, body: JSON.stringify({ voiceId: "stimme-mia" }) });
    expect(anonymous.status).toBe(401);
    expect(fake.calls).toEqual([]);
  });
});

describe("Overlay je Vorlage und Vorlagenwechsel", () => {
  const fields = (f: any): WizardFields => {
    const r = checkFields(f);
    if (!r.ok) throw new Error(r.fehler.join("; "));
    return r.felder;
  };
  const expertTraining = { rollen: ["Kunde"], einwaende: ["Zu teuer"], kriterien: ["eins", "zwei", "drei"] };

  test("Experte: Training, Thema und Links; Denkauftrag und Anruferfragen bleiben draußen", () => {
    const f = fields({ vorlage: "experte", name: "Trainer", zweck: "Üben", training: expertTraining, thema: "Segeln", links: ["https://example.org/a"], gehirn: { denkauftrag: true }, anrufannahme: { fragen: ["Name?"] } });
    const o = wizardOverlay(f, "trainer") as any;
    expect(o.training.kriterien).toEqual(["eins", "zwei", "drei"]);
    expect(o.gehirn).toBeUndefined();
    expect(o.persona.regeln).toEqual([]);
    expect(o.gedaechtnis).toBe("thema");
    expect(researchInputs(f)).toEqual({ thema: "Segeln", links: ["https://example.org/a"] });
  });

  test("Anrufannahme: Fragen und Abschlusssatz als Regeln, kein Training, keine Recherche", () => {
    const f = fields({ vorlage: "anrufannahme", name: "Empfang", zweck: "Nimmt an", regeln: withFixed(["Sei freundlich"]), training: expertTraining, thema: "Segeln", anrufannahme: { fragen: ["Name", "Rückrufnummer"], abschlusssatz: "Danke für Ihren Anruf." } });
    const o = wizardOverlay(f, "empfang") as any;
    expect(o.persona.regeln).toEqual(["Sei freundlich", `${WIZARD_QUESTION_PREFIX}Name`, `${WIZARD_QUESTION_PREFIX}Rückrufnummer`, `${WIZARD_CLOSING_PREFIX}Danke für Ihren Anruf.`]);
    expect(o.training).toBeNull();
    expect(o.gedaechtnis).toBe("keins");
    expect(researchInputs(f)).toEqual({ links: [] });
    // Der Job schreibt ein Training: das Overlay entfernt es, das Rezept bleibt gültig
    const base = { ...draftRecipe("empfang"), vorlage: "anrufannahme", training: { rollen: ["x"], einwaende: [], kriterien: ["a"], selbsteinschaetzung: false } };
    const merged = applyOverlay(base, o) as any;
    expect(merged.training).toBeUndefined();
    const parsed = parseRecipe(merged);
    expect(parsed.ok).toBe(true);
  });

  test("Anruferregeln zählen nicht gegen die Höchstzahl eigener Regeln", () => {
    const own = Array.from({ length: 20 }, (_, i) => `Regel ${i}`);
    const r = checkFields({ vorlage: "anrufannahme", regeln: withFixed(own), anrufannahme: { fragen: Array.from({ length: 8 }, (_, i) => `Frage ${i}`), abschlusssatz: "Tschüss." } });
    expect(r.ok).toBe(true);
    if (r.ok) expect((wizardOverlay(r.felder, "x") as any).persona.regeln).toHaveLength(29);
  });

  test("Grenzen: höchstens 8 Fragen zu 200 Zeichen, Abschlusssatz so lang, dass die Regel 500 Zeichen nicht übersteigt", () => {
    expect(WIZARD_CLOSING_PREFIX.length + WIZARD_CLOSING_CHARS).toBe(500);
    expect(WIZARD_CLOSING_CHARS).toBe(466);
    expect(checkFields({ vorlage: "anrufannahme", anrufannahme: { abschlusssatz: "x".repeat(466) } }).ok).toBe(true);
    const tooLong = checkFields({ vorlage: "anrufannahme", anrufannahme: { abschlusssatz: "x".repeat(467) } });
    expect(tooLong).toMatchObject({ ok: false, status: "ungueltig" });
    expect(checkFields({ vorlage: "anrufannahme", anrufannahme: { fragen: Array.from({ length: 9 }, () => "f") } }).ok).toBe(false);
    expect(checkFields({ vorlage: "anrufannahme", anrufannahme: { fragen: ["x".repeat(201)] } }).ok).toBe(false);
    // Die längste Regel besteht die Prüfung des Rezepts
    const r = checkFields({ vorlage: "anrufannahme", name: "Empfang", zweck: "Nimmt an", anrufannahme: { abschlusssatz: "x".repeat(466) } });
    if (!r.ok) throw new Error("ungültig");
    const merged = applyOverlay({ ...draftRecipe("empfang"), vorlage: "anrufannahme", persona: { ...draftRecipe().persona, kiHinweis: WIZARD_KI_HINWEIS.de } }, wizardOverlay(r.felder, "empfang"));
    expect(parseRecipe(merged).ok).toBe(true);
  });

  test("Jarvis: Denkauftrag geht ins Rezept, Training und Anruferfragen nicht", () => {
    const f = fields({ vorlage: "jarvis", gehirn: { denkauftrag: true }, training: expertTraining, anrufannahme: { fragen: ["Name"] } });
    const o = wizardOverlay(f, "jarvis") as any;
    expect(o.gehirn).toEqual({ art: undefined, modell: undefined, denkauftrag: true });
    expect(o.training).toBeNull();
    expect(o.persona.regeln).toEqual([]);
    expect(fields({ vorlage: "jarvis", gehirn: { denkauftrag: false } }).gehirn?.denkauftrag).toBe(false);
  });

  test("Wechsel Experte → Anrufannahme → Experte: Kriterien bleiben gespeichert, Gedächtnis folgt der Vorlage", () => {
    const expert = fields({ vorlage: "experte", training: expertTraining, thema: "Segeln" });
    expect(expert.gedaechtnis).toBe("thema");
    const reception = fields({ ...expert, gedaechtnis: undefined, vorlage: "anrufannahme" });
    expect(reception.training?.kriterien).toEqual(["eins", "zwei", "drei"]);
    expect(reception.thema).toBe("Segeln");
    expect(reception.gedaechtnis).toBe("keins");
    expect(fixedEntries(reception)).toContainEqual(expect.objectContaining({ feld: "gedaechtnis", wert: "keins" }));
    expect(fixedEntries(reception).map((e) => e.wert)).toContain(WIZARD_KI_HINWEIS.de);
    // Zurück: das „keins“ der Anrufannahme bleibt nicht beim Experten, auch wenn es mitgeschickt wird
    const back = fields({ ...reception, vorlage: "experte" });
    expect(back.gedaechtnis).toBe("thema");
    expect(back.training?.kriterien).toEqual(["eins", "zwei", "drei"]);
    expect((wizardOverlay(back, "x") as any).training.kriterien).toEqual(["eins", "zwei", "drei"]);
    // Jarvis ohne Wahl: das Gedächtnis der Vorlage, am Telefon mit fester PIN
    const jarvis = fields({ vorlage: "jarvis", zugang: { telefon: { nummer: "nummer-1", anrufer: "freigegeben" } } });
    expect(jarvis.gedaechtnis).toBe("voll");
    expect(jarvis.zugang?.telefon?.pin).toBe(true);
    expect(fixedEntries(jarvis)).toContainEqual(expect.objectContaining({ feld: "zugang.telefon.pin", wert: true }));
  });

  test("Anrufer alle: Jarvis ohne Gedächtnis, beim Experten verständlich abgelehnt", () => {
    const jarvis = fields({ vorlage: "jarvis", zugang: { telefon: { nummer: "nummer-1", anrufer: "alle" } } });
    expect(jarvis.gedaechtnis).toBe("keins");
    const expert = fields({ vorlage: "experte", name: "T", zweck: "Z", zugang: { telefon: { nummer: "nummer-1", anrufer: "alle" } } });
    expect(missingForBuild(expert).join(" ")).toContain("freigegebene Anrufer");
  });

  test("Vorschlag füllt Fragen und Abschlusssatz der Anrufannahme vor", async () => {
    const answer = {
      vorlage: "anrufannahme",
      name: "Empfang",
      zweck: "Nimmt Anrufe an.",
      persona: { rolle: "Empfang", anrede: "sie", sprachen: ["de"], ersterSatz: "Guten Tag." },
      anrufannahme: { fragen: ["Name", "Anliegen"], abschlusssatz: "Vielen Dank." },
    };
    const p = await proposeWizard("Eine Anrufannahme", async () => ({ text: JSON.stringify(answer), isError: false }));
    expect(p.quelle).toBe("modell");
    expect(p.felder.anrufannahme).toEqual({ fragen: ["Name", "Anliegen"], abschlusssatz: "Vielen Dank." });
  });
});

describe("Fortschritt nach dem Bauen", () => {
  test("bestanden: Tests je Name, freigeschaltet, Web-Zugang; der Entwurfsdienst meldet sich im Direktchat", async () => {
    const w = await wizardHarness({ voices: VOICES });
    const draft = await create(w, "kochhilfe", kitchenFields((f) => (f.stimme = { wahl: "konto", voiceId: "stimme-mia", name: "Mia" })));
    await buildAndFinish(w, "kochhilfe", draft.revision, { recipe: recipeWithHint((r) => (r.zugang.web = { link: true })) });
    expect(await progress(w)).toMatchObject({ phase: "freigabe", rueckfrage: "freigabe", freigeschaltet: false, web: false });
    await answer(w, "anlegen");
    const after = await progress(w);
    expect(after).toMatchObject({ phase: "fertig", freigeschaltet: true, web: true, tests: { status: "bestanden", liste: [{ name: "Notfall", status: "bestanden" }] } });
    expect(after.rueckfrage).toBeUndefined();
    expect(w.h.notes.map((n) => n.text)).toContain(DRAFT_TEXT.passed("kochhilfe", 1));
    // Beendet: nicht mehr unter den offenen, aber unter den beendeten der Liste, mit Schritt 5
    const list = await (await w.ctx.api("/api/voice-agents/wizard/entwuerfe")).json();
    expect(list.entwuerfe).toEqual([]);
    expect(list.beendet[0]).toMatchObject({ kennung: "kochhilfe", phase: "fertig", schritt: 5 });
  });

  test("durchgefallen: Grund je Test in einem Satz, Rückfrage „freischalten“, nicht freigeschaltet", async () => {
    const w = await wizardHarness();
    w.h.layer.testIds = ["t1", "t2"];
    w.h.layer.result = {
      status: "fertig",
      gesamt: "durchgefallen",
      tests: [
        { testId: "t1", name: "Notfall", status: "bestanden" },
        { testId: "t2", name: "Begrüßung", status: "durchgefallen", kriterium: "Nennt den KI-Hinweis nicht. Danach mehr Text\nüber zwei Zeilen." },
      ],
    };
    const draft = await create(w, "kochhilfe", kitchenFields((f) => (f.stimme = { wahl: "standard" })));
    await buildAndFinish(w, "kochhilfe", draft.revision, { recipe: recipeWithHint((r) => (r.zugang.web = { link: true })) });
    await answer(w, "anlegen");
    const p = await progress(w);
    expect(p).toMatchObject({ phase: "durchgefallen", rueckfrage: "freischalten", freigeschaltet: false, web: true });
    expect(p.tests.liste).toEqual([
      { name: "Notfall", status: "bestanden" },
      { name: "Begrüßung", status: "durchgefallen", grund: "Nennt den KI-Hinweis nicht." },
    ]);
    expect(JSON.stringify(p)).not.toContain("transcript");
  });

  test("unterbrochen (kein Ergebnis in der Frist): runId festgehalten, fehlende Ergebnisse kenntlich, Rückfrage „fortsetzen“", async () => {
    const w = await wizardHarness();
    w.h.layer.result = { status: "zeitueberschreitung", tests: [], grund: "Abfrage lief ab" };
    const draft = await create(w, "kochhilfe", kitchenFields((f) => (f.stimme = { wahl: "standard" })));
    const entwurf = await buildAndFinish(w, "kochhilfe", draft.revision, { recipe: recipeWithHint() });
    await answer(w, "anlegen");
    expect(readRecord(w.h, entwurf).testRunId).toBe("lauf-1");
    const p = await progress(w);
    expect(p).toMatchObject({ phase: "unterbrochen", rueckfrage: "fortsetzen", tests: { status: "zeitueberschreitung", liste: [], grund: "Abfrage lief ab" } });
  });

  test("Testlauf nicht mehr in testlauf.json: als fehlend gemeldet statt still leer", async () => {
    const w = await wizardHarness();
    const draft = await create(w, "kochhilfe", kitchenFields((f) => (f.stimme = { wahl: "standard" })));
    await buildAndFinish(w, "kochhilfe", draft.revision, { recipe: recipeWithHint() });
    await answer(w, "anlegen");
    require("node:fs").rmSync(join(w.h.paths.dataDir, "kochhilfe", "testlauf.json"));
    expect((await progress(w)).tests).toMatchObject({ status: "fehlt", liste: [] });
  });

  test("vor dem Bauen: weder Tests noch Freischaltung, Schritt im Entwurf gespeichert", async () => {
    const w = await wizardHarness();
    const res = await w.ctx.api("/api/voice-agents/wizard/kochhilfe", "PUT", { felder: kitchenFields(), schritt: 3 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schritt).toBe(3);
    const saved = await (await w.ctx.api("/api/voice-agents/wizard/kochhilfe", "PUT", { felder: kitchenFields(), revision: body.revision })).json();
    expect(saved.schritt).toBe(3);
    expect((await (await w.ctx.api("/api/voice-agents/wizard/entwuerfe")).json()).entwuerfe[0].schritt).toBe(3);
    const p = await progress(w);
    expect(p).toMatchObject({ phase: "wizard", freigeschaltet: false, web: false });
    expect(p.tests).toBeUndefined();
    expect((await w.ctx.api("/api/voice-agents/wizard/kochhilfe", "PUT", { felder: kitchenFields(), revision: saved.revision, schritt: 6 })).status).toBe(400);
  });
});

describe("Kennung nach dem ersten Speichern ändern", () => {
  const upload = (w: WizardHarness, kennung: string, name: string, text: string) =>
    fetch(`${w.ctx.origin}/api/voice-agents/wizard/${kennung}/anhaenge`, { method: "POST", headers: { cookie: w.ctx.cookie, origin: w.ctx.origin, "x-file-name": encodeURIComponent(name) }, body: text });
  const rename = (w: WizardHarness, kennung: string, body: unknown) => w.ctx.api(`/api/voice-agents/wizard/${kennung}/umbenennen`, "POST", body);
  const expertFields = () => ({ vorlage: "experte", name: "Segeltrainer", zweck: "Übt Manöver.", thema: "Segeln", training: { kriterien: ["eins", "zwei", "drei"] } });

  test("Felder, Satz, Schritt und Anhänge ziehen mit um; die alte Kennung ist wieder frei", async () => {
    const w = await wizardHarness();
    const created = await (await w.ctx.api("/api/voice-agents/wizard/segel-alt", "PUT", { felder: expertFields(), satz: "Ein Segeltrainer", schritt: 3 })).json();
    const up = await (await upload(w, "segel-alt", "notizen.md", "# Wind von vorn")).json();
    const res = await rename(w, "segel-alt", { revision: up.revision, kennung: "segel-neu" });
    expect(res.status).toBe(200);
    const moved = await res.json();
    expect(moved).toMatchObject({ kennung: "segel-neu", phase: "wizard", satz: "Ein Segeltrainer", schritt: 3, revision: up.revision + 1 });
    expect(moved.felder).toMatchObject({ name: "Segeltrainer", thema: "Segeln", training: { kriterien: ["eins", "zwei", "drei"] } });
    expect(moved.anhaenge).toEqual([{ datei: up.anhang.datei, name: "notizen.md", mime: "text/markdown", bytes: 15 }]);
    const drafts = join(w.h.paths.dataDir, "entwuerfe");
    expect(readFileSync(join(drafts, "segel-neu", "anhaenge", up.anhang.datei), "utf8")).toBe("# Wind von vorn");
    expect(existsSync(join(drafts, "segel-alt", "anhaenge"))).toBe(false);
    expect((await w.ctx.api("/api/voice-agents/wizard/segel-alt")).status).toBe(404);
    expect((await (await w.ctx.api("/api/voice-agents/wizard/entwuerfe")).json()).entwuerfe.map((e: any) => e.kennung)).toEqual(["segel-neu"]);
    // Der alte Entwurf ist verworfen, die alte Kennung lässt sich wieder nehmen
    expect((await w.ctx.api("/api/voice-agents/wizard/segel-alt", "PUT", { felder: expertFields() })).status).toBe(201);
    expect(created.revision).toBe(1);
    // Gebaut wird unter der neuen Kennung, mit dem Anhang als Recherche-Material
    expect((await w.ctx.api("/api/voice-agents/wizard/segel-neu/bauen", "POST", { revision: moved.revision })).status).toBe(202);
  });

  test("Konflikt: vergeben, schon ein Wizard oder ungültig; der Entwurf bleibt unter der alten Kennung mit Feldern und Anhang", async () => {
    const w = await wizardHarness();
    writeActive(w.h, draftRecipe("jarvis"));
    await w.ctx.api("/api/voice-agents/wizard/anderer", "PUT", { felder: kitchenFields() });
    await w.ctx.api("/api/voice-agents/wizard/segel-alt", "PUT", { felder: expertFields(), schritt: 3 });
    const up = await (await upload(w, "segel-alt", "notizen.md", "# Wind von vorn")).json();
    const taken = await rename(w, "segel-alt", { revision: up.revision, kennung: "jarvis" });
    expect(taken.status).toBe(409);
    expect((await taken.json()).reason).toBe("vergeben");
    const exists = await rename(w, "segel-alt", { revision: up.revision, kennung: "anderer" });
    expect(exists.status).toBe(409);
    expect((await exists.json()).reason).toBe("existiert");
    for (const bad of ["Segel Neu", "stimmen", "../x"]) {
      const res = await rename(w, "segel-alt", { revision: up.revision, kennung: bad });
      expect(res.status).toBe(422);
      expect((await res.json()).reason).toBe("kennung");
    }
    expect((await rename(w, "segel-alt", { revision: up.revision + 5, kennung: "segel-neu" })).status).toBe(409);
    expect((await rename(w, "segel-alt", { kennung: "segel-neu" })).status).toBe(400);
    const still = await (await w.ctx.api("/api/voice-agents/wizard/segel-alt")).json();
    expect(still).toMatchObject({ kennung: "segel-alt", revision: up.revision, schritt: 3 });
    expect(still.felder.training.kriterien).toEqual(["eins", "zwei", "drei"]);
    expect(still.anhaenge).toHaveLength(1);
    expect(existsSync(join(w.h.paths.dataDir, "entwuerfe", "segel-alt", "anhaenge", up.anhang.datei))).toBe(true);
    // Der andere Wizard ist unberührt
    expect((await (await w.ctx.api("/api/voice-agents/wizard/anderer")).json()).felder.name).toBe("Kochhilfe");
  });

  test("nach dem Bauen: 409 gebaut; nur im Browser und nur per POST", async () => {
    const w = await wizardHarness();
    const created = await (await w.ctx.api("/api/voice-agents/wizard/kochhilfe", "PUT", { felder: kitchenFields() })).json();
    expect((await rename(w, "kochhilfe", { revision: created.revision, kennung: "kochhilfe" })).status).toBe(200);
    expect((await w.ctx.api("/api/voice-agents/wizard/kochhilfe/umbenennen")).status).toBe(405);
    expect((await w.ctx.api("/api/voice-agents/wizard/kochhilfe/umbenennen/x", "POST", {})).status).toBe(404);
    expect((await w.ctx.api("/api/voice-agents/wizard/kochhilfe/bauen", "POST", { revision: created.revision })).status).toBe(202);
    const res = await rename(w, "kochhilfe", { revision: created.revision, kennung: "kochhilfe-2" });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("gebaut");
  });
});

describe("Zustandsmodul der Oberfläche gegen den echten Dienst", () => {
  const SOURCE = readFileSync(resolve(import.meta.dir, "..", "src", "web", "public", "sprachagent-wizard-state.js"), "utf8");
  const ui = new Function(`${SOURCE}\nreturn { vaWizardCreate, vaWizardSaver, vaWizardFromServer, vaWizardFromView, vaWizardSet, vaWizardSwitchTemplate, vaWizardPutBody };`)() as any;
  const requestOf = (w: WizardHarness) => async (method: string, path: string, body?: unknown) => {
    const res = await w.ctx.api(path, method, body);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  test("eigene Regeln, Vorlagenwechsel, Telefon und Links: jedes Speichern kommt an, keine feste Regel gilt als abgeschaltet", async () => {
    const w = await wizardHarness();
    const request = requestOf(w);
    const created = await ui.vaWizardCreate(request, "trainer", { schritt: 2, felder: { vorlage: "experte", name: "Trainer", zweck: "Üben" } });
    expect(created.ok).toBe(true);
    expect(created.view.festeRegeln.experte).toEqual([...TEMPLATES.experte.fixedRules]);
    expect(created.view.festeRegeln.anrufannahme).toEqual([...TEMPLATES.anrufannahme.fixedRules]);
    let felder = ui.vaWizardFromServer(created.view.felder);
    let view = created.view;
    const states: { text: string; error: boolean }[] = [];
    const saver = ui.vaWizardSaver({
      kennung: "trainer",
      revision: view.revision,
      request,
      upload: async () => ({ status: 500, body: null }),
      fields: () => felder,
      fixedRules: () => view.festeRegeln,
      dirty: () => [],
      schritt: () => 3,
      debounceMs: 1,
      onSaved: (saved: any) => (view = saved),
      onState: (text: string, error: boolean) => states.push({ text, error }),
    });
    // Eigene Regel beim Experten
    felder = ui.vaWizardSet(felder, "regeln", ["Sei knapp"]);
    expect(await saver.flush()).toEqual({ ok: true });
    expect(view.felder.regeln.filter((r: any) => !r.fest).map((r: any) => r.text)).toEqual(["Sei knapp"]);
    // Wechsel zur Anrufannahme: andere feste Regeln, die eigene bleibt, Gedächtnis keins
    felder = ui.vaWizardSwitchTemplate(felder, "anrufannahme");
    expect(await saver.flush()).toEqual({ ok: true });
    expect(view.felder.vorlage).toBe("anrufannahme");
    expect(view.felder.gedaechtnis).toBe("keins");
    expect(view.felder.regeln.filter((r: any) => r.fest).map((r: any) => r.text)).toEqual([...TEMPLATES.anrufannahme.fixedRules]);
    expect(view.felder.regeln.filter((r: any) => !r.fest).map((r: any) => r.text)).toEqual(["Sei knapp"]);
    // Telefon angehakt, Kennung der Nummer noch leer, ein Link halb getippt: Speichern geht trotzdem
    felder = ui.vaWizardSet(ui.vaWizardSet(felder, "zugang", { web: true, telefon: { nummer: "", anrufer: "freigegeben", pin: false } }), "links", ["https://"]);
    expect(await saver.flush()).toEqual({ ok: true });
    expect(view.felder.zugang).toEqual({ web: true });
    felder = ui.vaWizardSet(felder, "zugang.telefon.nummer", "nr_1");
    expect(await saver.flush()).toEqual({ ok: true });
    expect(view.felder.zugang.telefon).toMatchObject({ nummer: "nr_1", anrufer: "freigegeben" });
    expect(states.filter((x) => x.error)).toEqual([]);
  });

  // Prüfung von PR #558: Was die Seite als aus zeigt, ist im Rezept aus, auch wenn der Job es anschaltet
  test("unberührte Schalter Browser-Zugang und Denkauftrag: false gespeichert, das Rezept des Jobs mit true wird überschrieben", async () => {
    const w = await wizardHarness();
    const request = requestOf(w);
    // Wie die Seite: Jarvis, weder „Im Browser sprechen“ noch „Denkauftrag“ je angefasst
    const felder = { vorlage: "jarvis", name: "Kochhilfe", zweck: "Liest Rezepte vor.", stimme: { wahl: "standard" } };
    const created = await ui.vaWizardCreate(request, "kochhilfe", { schritt: 5, felder });
    expect(created.ok).toBe(true);
    expect(created.view.felder.zugang).toEqual({ web: false });
    expect(created.view.felder.gehirn).toEqual({ denkauftrag: false });
    const entwurf = await buildAndFinish(w, "kochhilfe", created.view.revision, {
      recipe: recipeWithHint((r) => {
        r.zugang.web = { link: true };
        r.gehirn = { ...r.gehirn, denkauftrag: true };
      }),
    });
    const record = readRecord(w.h, entwurf);
    expect(record.phase).toBe("freigabe");
    expect(record.rezept!.zugang.web).toEqual({ link: false });
    expect(record.rezept!.gehirn.denkauftrag).toBe(false);
    expect(await progress(w)).toMatchObject({ web: false });
  });

  test("angehakte Schalter bleiben an: true geht als true ins Rezept", async () => {
    const w = await wizardHarness();
    const felder = { vorlage: "jarvis", name: "Kochhilfe", zweck: "Liest Rezepte vor.", stimme: { wahl: "standard" }, zugang: { web: true }, gehirn: { denkauftrag: true } };
    const created = await ui.vaWizardCreate(requestOf(w), "kochhilfe", { schritt: 5, felder });
    const entwurf = await buildAndFinish(w, "kochhilfe", created.view.revision, { recipe: recipeWithHint((r) => (r.zugang.web = { link: false })) });
    const record = readRecord(w.h, entwurf);
    expect(record.rezept!.zugang.web).toEqual({ link: true });
    expect(record.rezept!.gehirn.denkauftrag).toBe(true);
  });

  test("unfertige Eingaben: halber Link und Telefon ohne Nummer bleiben nach dem Neuladen, Bauen lehnt ab, bis sie fertig sind", async () => {
    const w = await wizardHarness();
    const request = requestOf(w);
    const start = { vorlage: "experte", name: "Trainer", zweck: "Üben", training: { kriterien: ["eins", "zwei", "drei"] }, links: ["https://example.org/a", "https://"], zugang: { web: true, telefon: { nummer: "", anrufer: "freigegeben", pin: false } } };
    const created = await ui.vaWizardCreate(request, "trainer", { schritt: 4, felder: start });
    expect(created.ok).toBe(true);
    // Gültige Vorgaben und unfertige Eingaben getrennt
    expect(created.view.felder.links).toEqual(["https://example.org/a"]);
    expect(created.view.felder.zugang.telefon).toBeUndefined();
    expect(created.view.offen).toEqual({ links: ["https://example.org/a", "https://"], telefon: { nummer: "", anrufer: "freigegeben", pin: false } });
    // Neu geladen: alles wieder auf der Seite
    const loaded = await (await w.ctx.api("/api/voice-agents/wizard/trainer")).json();
    const felder = ui.vaWizardFromView(loaded);
    expect(felder.links).toEqual(["https://example.org/a", "https://"]);
    expect(felder.zugang.telefon).toEqual({ nummer: "", anrufer: "freigegeben", pin: false });
    // Bauen lehnt ab, solange etwas offen ist; ins Rezept käme es ohnehin nie
    const refused = await w.ctx.api("/api/voice-agents/wizard/trainer/bauen", "POST", { revision: loaded.revision });
    expect(refused.status).toBe(422);
    expect((await refused.json()).fehler).toEqual(["zugang.telefon.nummer: ungültige Kennung der Nummer", "links: nur https-Adressen ohne Zugangsdaten"]);
    // Fertig getippt: nichts mehr offen
    const done = ui.vaWizardSet(ui.vaWizardSet(felder, "links", ["https://example.org/a", "https://example.org/b"]), "zugang.telefon.nummer", "nr_1");
    const saved = await w.ctx.api("/api/voice-agents/wizard/trainer", "PUT", ui.vaWizardPutBody(done, loaded.festeRegeln, { revision: loaded.revision }));
    expect(saved.status).toBe(200);
    const view = await saved.json();
    expect(view.offen).toBeUndefined();
    expect(view.felder.links).toEqual(["https://example.org/a", "https://example.org/b"]);
    expect(view.felder.zugang.telefon).toMatchObject({ nummer: "nr_1" });
    // Falsche Form der unfertigen Eingaben: 400
    expect((await w.ctx.api("/api/voice-agents/wizard/trainer", "PUT", { revision: view.revision, felder: {}, offen: { anderes: 1 } })).status).toBe(400);
  });

  test("Satz nach dem ersten Speichern ändern und leeren: jedes Speichern nimmt ihn mit", async () => {
    const w = await wizardHarness();
    const request = requestOf(w);
    const created = await ui.vaWizardCreate(request, "kochhilfe", { satz: "Ein Koch", schritt: 1, felder: { vorlage: "jarvis", name: "Kochhilfe", zweck: "Kocht." } });
    let satz = "Ein Koch, der Rezepte vorliest";
    let view = created.view;
    const saver = ui.vaWizardSaver({
      kennung: "kochhilfe",
      revision: view.revision,
      request,
      upload: async () => ({ status: 500, body: null }),
      fields: () => ui.vaWizardFromView(view),
      satz: () => satz,
      fixedRules: () => view.festeRegeln,
      dirty: () => [],
      schritt: () => 1,
      onSaved: (saved: any) => (view = saved),
    });
    expect(await saver.flush()).toEqual({ ok: true });
    expect((await (await w.ctx.api("/api/voice-agents/wizard/kochhilfe")).json()).satz).toBe("Ein Koch, der Rezepte vorliest");
    satz = "";
    expect(await saver.flush()).toEqual({ ok: true });
    expect((await (await w.ctx.api("/api/voice-agents/wizard/kochhilfe")).json()).satz).toBeUndefined();
  });
});
