/**
 * Issue #493, Checkbox 3: /sprachagent aendern. Entwurf aus dem aktiven Rezept
 * plus Wunsch, Freigabe mit den geänderten Feldern, Übernahme als neue Version
 * (SA1-1 versionen/). Attrappen für Jobs und Sprachschicht, kein Anbieteraufruf.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideChoice, onChoiceDecided, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { recipeHash } from "../src/lib/voice-agents/base";
import { DRAFT_TEXT, knowledgeFileName } from "../src/lib/voice-agents/drafts";
import { saveRecipe } from "../src/lib/voice-agents/recipe";
import { isUnlocked, readUnlock, writeUnlock } from "../src/lib/voice-agents/unlock";
import { DM, draftDir, draftHarness, draftRecipe, expertRecipe, GOOD_KNOWLEDGE, readRecord, removeDraftDirs, writeOutput, type DraftHarness } from "./voice-agents-drafts-fixture";
import { createHash } from "node:crypto";

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

function wired(): DraftHarness {
  const h = draftHarness();
  off.push(onChoiceDecided("sprachagent", h.service.handler));
  return h;
}

/** Aktives Rezept über saveRecipe: mit Version 1 und fester Stimme */
async function active(h: DraftHarness, raw: any) {
  return saveRecipe(raw, { ...h.paths, voices: { setting: "stimme-alt" } });
}

async function toApproval(h: DraftHarness, kennung: string, wunsch: string, output: Parameters<typeof writeOutput>[2]): Promise<Choice> {
  const started = await h.service.startChange(kennung, wunsch, DM);
  expect(started.status).toBe("gestartet");
  writeOutput(h, ID, output);
  h.jobs.finish(h.jobs.last().id);
  await h.service.tick();
  return h.sent.at(-1)!;
}

async function click(h: DraftHarness, choice: Choice, key: string) {
  await decideChoice(choice.id, key, "telegram");
  await h.service.settled();
}

const versions = (h: DraftHarness, kennung: string) => readdirSync(join(h.paths.dataDir, kennung, "versionen")).sort();

describe("aendern starten", () => {
  test("unbekannte Kennung, leerer Wunsch: kein Job", async () => {
    const h = wired();
    expect(await h.service.startChange("gibtsnicht", "lauter", DM)).toEqual({ status: "unbekannt" });
    expect(await h.service.startChange("../x", "lauter", DM)).toEqual({ status: "unbekannt" });
    await active(h, draftRecipe("kochhilfe"));
    expect(await h.service.startChange("kochhilfe", " ", DM)).toEqual({ status: "leer" });
    expect(h.jobs.starts).toEqual([]);
  });

  test("Auftrag nennt Kennung und Wunsch, Kopie des aktiven Rezepts liegt im Entwurf", async () => {
    const h = wired();
    await active(h, draftRecipe("kochhilfe"));
    await h.service.startChange("kochhilfe", "Antworte kürzer", DM);
    const brief = h.jobs.last().brief;
    expect(brief).toContain("Änderung des Sprachagenten kochhilfe");
    expect(brief).toContain("Antworte kürzer");
    const copy = JSON.parse(readFileSync(join(draftDir(h, ID), "basis.json"), "utf8"));
    expect(copy.kennung).toBe("kochhilfe");
    expect(readRecord(h, ID)).toMatchObject({ art: "aendern", kennung: "kochhilfe", basis: { hash: recipeHash(copy), wissenHash: null } });
  });
});

describe("Freigabe mit Feldvergleich", () => {
  test("zeigt die geänderten Felder, Stimme bleibt wie bisher; Übernahme schreibt Version 2", async () => {
    const h = wired();
    const saved = await active(h, draftRecipe("kochhilfe"));
    const changed = { ...saved.recipe, zweck: "Liest Rezepte langsam vor.", persona: { ...saved.recipe.persona, rolle: "Geduldiger Koch" } };
    const choice = await toApproval(h, "kochhilfe", "langsamer", { recipe: changed });
    expect(choice.action).toBe("freigabe");
    expect(choice.text).toContain("Änderung an Kochhilfe (kochhilfe)");
    expect(choice.text).toContain("Geändert: persona.rolle, zweck");
    expect(choice.text).toContain("Stimme: wie bisher");
    expect(choice.text).toContain(DRAFT_TEXT.changeReach("kochhilfe"));
    await click(h, choice, "anlegen");
    expect(versions(h, "kochhilfe")).toEqual(["1.json", "2.json"]);
    const now = JSON.parse(readFileSync(join(h.paths.configDir, "kochhilfe.json"), "utf8"));
    expect(now.zweck).toBe("Liest Rezepte langsam vor.");
    expect(now.stimme.voiceId).toBe("stimme-alt");
    expect(await readUnlock("kochhilfe", h.paths)).toMatchObject({ version: 2 });
  });

  test("Job darf die Kennung nicht ändern und keine neue Stimmen-Kennung setzen", async () => {
    const h = wired();
    const saved = await active(h, draftRecipe("kochhilfe"));
    await h.service.startChange("kochhilfe", "x", DM);
    writeOutput(h, ID, { recipe: { ...saved.recipe, kennung: "andere", stimme: { ...saved.recipe.stimme, voiceId: "neu-1" } } });
    h.jobs.finish(h.jobs.last().id);
    await h.service.tick();
    expect(h.jobs.last().brief).toContain("kennung: muss kochhilfe bleiben");
    expect(h.jobs.last().brief).toContain("stimme.voiceId: keine neue Stimmen-Kennung");
  });

  test("Ausgangsrezept inzwischen geändert: veraltet, nichts übernommen", async () => {
    const h = wired();
    const saved = await active(h, draftRecipe("kochhilfe"));
    const choice = await toApproval(h, "kochhilfe", "x", { recipe: { ...saved.recipe, zweck: "Neu" } });
    await active(h, { ...saved.recipe, zweck: "Von Hand geändert" });
    await click(h, choice, "anlegen");
    expect(JSON.parse(readFileSync(join(h.paths.configDir, "kochhilfe.json"), "utf8")).zweck).toBe("Von Hand geändert");
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.stale("kochhilfe"));
    expect(h.layer.calls).toEqual([]);
  });

  test("Ausgangsrezept inzwischen gelöscht: veraltet", async () => {
    const h = wired();
    const saved = await active(h, draftRecipe("kochhilfe"));
    const choice = await toApproval(h, "kochhilfe", "x", { recipe: { ...saved.recipe, zweck: "Neu" } });
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(h.paths.configDir, "kochhilfe.json"));
    await click(h, choice, "anlegen");
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.stale("kochhilfe"));
  });

  test("ohne Änderung: Freigabe sagt das, Übernahme legt keine neue Version an", async () => {
    const h = wired();
    const saved = await active(h, draftRecipe("kochhilfe"));
    const choice = await toApproval(h, "kochhilfe", "nichts", { recipe: saved.recipe });
    expect(choice.text).toContain("Geändert: nichts");
    await click(h, choice, "anlegen");
    expect(versions(h, "kochhilfe")).toEqual(["1.json"]);
  });

  test("Freischaltung der alten Fassung gilt nach der Änderung nicht mehr, bis die Tests bestehen", async () => {
    const h = wired();
    const saved = await active(h, draftRecipe("kochhilfe"));
    await writeUnlock("kochhilfe", { hash: saved.hash, version: 1, wissenHash: null, grund: "tests" }, h.paths);
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
    h.layer.result = { status: "fertig", gesamt: "durchgefallen", tests: [] };
    const choice = await toApproval(h, "kochhilfe", "x", { recipe: { ...saved.recipe, zweck: "Neu" } });
    await click(h, choice, "anlegen");
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(false);
    expect(await readUnlock("kochhilfe", h.paths)).toMatchObject({ version: 1 });
  });
});

describe("Wissen ändern", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");

  async function expert(h: DraftHarness) {
    const raw = expertRecipe("segel-trainer");
    raw.wissen = { datei: `data/voice-agents/segel-trainer/${knowledgeFileName(sha(GOOD_KNOWLEDGE))}` };
    mkdirSync(join(h.paths.dataDir, "segel-trainer"), { recursive: true });
    writeFileSync(join(h.paths.dataDir, "segel-trainer", knowledgeFileName(sha(GOOD_KNOWLEDGE))), GOOD_KNOWLEDGE);
    return active(h, raw);
  }

  test("reine Wissensänderung ändert Rezept-Hash und Version; neue Datei, alte bleibt", async () => {
    const h = wired();
    const saved = await expert(h);
    const updated = GOOD_KNOWLEDGE.replace("Wind kommt von vorn.", "Wind kommt von der Seite.");
    // Der Job schreibt das Rezept unverändert zurück, nur wissen.md ist neu
    const choice = await toApproval(h, "segel-trainer", "Wind korrigieren", { recipe: saved.recipe, knowledge: updated });
    expect(choice.text).toContain("Geändert: Wissensdatei");
    expect(choice.text).not.toContain("wissen.datei");
    await click(h, choice, "anlegen");
    const now = JSON.parse(readFileSync(join(h.paths.configDir, "segel-trainer.json"), "utf8"));
    expect(recipeHash(now)).not.toBe(saved.hash);
    expect(now.wissen.datei).toBe(`data/voice-agents/segel-trainer/${knowledgeFileName(sha(updated))}`);
    expect(versions(h, "segel-trainer")).toEqual(["1.json", "2.json"]);
    const files = readdirSync(join(h.paths.dataDir, "segel-trainer")).filter((f) => f.endsWith(".md")).sort();
    expect(files).toEqual([knowledgeFileName(sha(GOOD_KNOWLEDGE)), knowledgeFileName(sha(updated))].sort());
    expect(h.layer.prompts[0]).toContain("Wind kommt von der Seite.");
  });

  test("Wissen unverändert: übernommen, ohne neue Prüfung von Stand und Quellen", async () => {
    const h = wired();
    const saved = await expert(h);
    const choice = await toApproval(h, "segel-trainer", "duzen", { recipe: { ...saved.recipe, persona: { ...saved.recipe.persona, anrede: "sie" } } });
    expect(choice.text).toContain("Geändert: persona.anrede");
    expect(choice.text).toContain("(unverändert)");
    await click(h, choice, "anlegen");
    const now = JSON.parse(readFileSync(join(h.paths.configDir, "segel-trainer.json"), "utf8"));
    expect(now.wissen.datei).toBe(saved.recipe.wissen!.datei);
  });

  test("Wissensdatei inzwischen von Hand geändert: veraltet", async () => {
    const h = wired();
    const saved = await expert(h);
    const choice = await toApproval(h, "segel-trainer", "x", { recipe: { ...saved.recipe, zweck: "Neu" } });
    writeFileSync(join(h.paths.dataDir, "segel-trainer", knowledgeFileName(sha(GOOD_KNOWLEDGE))), GOOD_KNOWLEDGE + "\nNachtrag");
    await click(h, choice, "anlegen");
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.stale("segel-trainer"));
  });
});
