/**
 * Issue #489: Rezept-Format der Sprachagenten. Je Leitplanke ein gültiges und
 * ein ungültiges Rezept, dazu Hash, Stimme und Dateizugriffe im temporären Ordner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceAgentError } from "../src/lib/voice-agents/base";
import { listVersions, readVersion } from "../src/lib/voice-agents/state";
import { loadRecipe, loadRecipes, parseRecipe, recipeHash, resolveVoice, saveRecipe } from "../src/lib/voice-agents/recipe";

const TESTS = [
  { name: "Erster", szenario: "Jemand fragt nach", kriterien: ["antwortet"], maxZuege: 4 },
  { name: "Zweiter", szenario: "Jemand drängelt", kriterien: ["bleibt ruhig"], maxZuege: 6 },
];

function jarvis(): any {
  return {
    schema: 1,
    kennung: "beispiel",
    name: "Beispiel",
    vorlage: "jarvis",
    zweck: "Hilft dem Nutzer im Alltag.",
    persona: { rolle: "Ruhiger Assistent", anrede: "du", sprachen: ["de"], ersterSatz: "Was liegt an?" },
    stimme: { art: "bibliothek", voiceId: "stimme-1" },
    gehirn: { art: "bruecke", modell: "claude-opus-5-5" },
    gedaechtnis: "voll",
    zugang: { web: { link: true }, maxMinuten: 30, budget: { minutenMonat: 300, anrufeJeNummerTag: 0 } },
    nachlauf: { zusammenfassung: true, faden: false, kalendervorschlag: false, anruferMerken: false, training: false, ziel: "direktchat" },
    tests: structuredClone(TESTS),
  };
}

function reception(): any {
  const recipe = jarvis();
  recipe.vorlage = "anrufannahme";
  recipe.gedaechtnis = "keins";
  recipe.persona.kiHinweis = "Sie sprechen mit einem KI-Assistenten.";
  recipe.gehirn = { art: "anbieter", modell: "claude-haiku-5-5" };
  recipe.zugang = { telefon: { nummer: "nummer-1", anrufer: "alle", pin: false }, maxMinuten: 5, budget: { minutenMonat: 200, anrufeJeNummerTag: 3 } };
  return recipe;
}

function expert(): any {
  const recipe = jarvis();
  recipe.vorlage = "experte";
  recipe.gedaechtnis = "thema";
  recipe.gehirn = { art: "anbieter", modell: "claude-sonnet-5-5" };
  recipe.wissen = { datei: "data/voice-agents/beispiel/wissen.md" };
  recipe.training = { rollen: ["Einkauf"], einwaende: ["Kein Budget"], kriterien: ["a", "b", "c"], selbsteinschaetzung: true, abschlussfrage: "Was änderst du?" };
  recipe.nachlauf.training = true;
  return recipe;
}

function errors(recipe: unknown): string[] {
  const result = parseRecipe(recipe);
  return result.ok ? [] : result.fehler;
}

function expectError(recipe: unknown, part: string) {
  const list = errors(recipe);
  expect(list.some((line) => line.includes(part))).toBe(true);
}

describe("parseRecipe: Form", () => {
  test("gültige Rezepte aller drei Vorlagen, mit Standardwerten", () => {
    for (const recipe of [jarvis(), reception(), expert()]) expect(errors(recipe)).toEqual([]);
    const parsed = parseRecipe(jarvis());
    if (!parsed.ok) throw new Error("erwartet gültig");
    expect(parsed.recipe.persona.regeln).toEqual([]);
    expect(parsed.recipe.werkzeuge).toEqual([]);
    expect(parsed.recipe.stimme).toEqual({ art: "bibliothek", voiceId: "stimme-1", modell: "eleven_v3_conversational", tempo: 1 });
    expect(parsed.recipe.gehirn.denkauftrag).toBe(false);
  });

  test("nimmt JSON-Text an und meldet kaputtes JSON in Klartext", () => {
    expect(parseRecipe(JSON.stringify(jarvis())).ok).toBe(true);
    expectError("{ kaputt", "Kein gültiges JSON");
    expectError([], "JSON-Objekt");
    expectError(null, "JSON-Objekt");
  });

  test("schema muss 1 sein", () => {
    expectError({ ...jarvis(), schema: 2 }, "schema");
  });

  test("Fehlerliste nennt alle Pflichtfelder auf einmal, auch verschachtelte", () => {
    const list = errors({ schema: 1 });
    for (const field of ["kennung", "name", "vorlage", "zweck", "persona", "stimme", "gehirn", "gedaechtnis", "zugang", "nachlauf", "tests"]) {
      expect(list.some((line) => line.startsWith(`${field}`))).toBe(true);
    }
    const nested = jarvis();
    delete nested.persona.ersterSatz;
    delete nested.nachlauf.faden;
    delete nested.gehirn.modell;
    delete nested.tests[0].maxZuege;
    const missing = errors(nested);
    expect(missing).toContain("persona.ersterSatz: Pflichtfeld fehlt");
    expect(missing).toContain("nachlauf.faden: Pflichtfeld fehlt");
    expect(missing).toContain("gehirn.modell: Pflichtfeld fehlt");
    expect(missing).toContain("tests[0].maxZuege: Pflichtfeld fehlt");
  });

  test("Kennung: gültig und ungültig", () => {
    for (const good of ["a", "segel-trainer", "agent-2"]) expect(errors({ ...jarvis(), kennung: good })).toEqual([]);
    for (const bad of ["Gross", "a_b", "../x", "a/b", "-a", "a-", "a--b", "", "x".repeat(65), "entwuerfe"]) expectError({ ...jarvis(), kennung: bad }, "kennung:");
  });

  test("unbekannte Felder sind Fehler, auch verschachtelt", () => {
    const recipe = jarvis();
    recipe.zugang.telefonn = {};
    expect(errors(recipe)).toContain("zugang.telefonn: unbekanntes Feld");
  });

  test("gaeste wird ausdrücklich abgelehnt, nicht still entfernt, an jeder Stelle", () => {
    const top = { ...jarvis(), gaeste: [] };
    expectError(top, "gaeste: Gäste gibt es nicht");
    const nested = jarvis();
    nested.zugang.web.gaeste = true;
    const list = errors(nested);
    expect(list.filter((line) => line.includes("gaeste"))).toEqual(["zugang.web.gaeste: Gäste gibt es nicht, der Web-Zugang liegt immer hinter dem Login"]);
  });

  test("maxMinuten und budget sind Pflicht, Zahlenbereiche gelten", () => {
    const noMax = jarvis();
    delete noMax.zugang.maxMinuten;
    expect(errors(noMax)).toContain("zugang.maxMinuten: Pflichtfeld fehlt");
    const noBudget = jarvis();
    delete noBudget.zugang.budget;
    expect(errors(noBudget)).toContain("zugang.budget: Pflichtfeld fehlt");
    for (const [field, value] of [["maxMinuten", 0], ["maxMinuten", 121], ["maxMinuten", 1.5]] as const) {
      const recipe = jarvis();
      recipe.zugang[field] = value;
      expectError(recipe, "zugang.maxMinuten");
    }
    const budget = jarvis();
    budget.zugang.budget = { minutenMonat: 0, anrufeJeNummerTag: -1 };
    expectError(budget, "zugang.budget.minutenMonat");
    expectError(budget, "zugang.budget.anrufeJeNummerTag");
    const tempo = jarvis();
    tempo.stimme.tempo = 2;
    expectError(tempo, "stimme.tempo");
  });

  test("anrufeJeNummerTag: 0 geht nur ohne Telefon", () => {
    expect(errors(jarvis())).toEqual([]);
    const recipe = reception();
    recipe.zugang.budget.anrufeJeNummerTag = 0;
    expectError(recipe, "anrufeJeNummerTag: mit Telefonzugang");
  });

  test("Platzhalter in Kennungen fallen auf", () => {
    const recipe = jarvis();
    recipe.stimme.voiceId = "<voice_id>";
    recipe.gehirn.modell = "<schnelles Modell>";
    expectError(recipe, "stimme.voiceId");
    expectError(recipe, "gehirn.modell");
  });
});

describe("parseRecipe: Leitplanken", () => {
  test("voll: gültig mit PIN und ohne Telefon, ungültig am Telefon ohne PIN", () => {
    expect(errors(jarvis())).toEqual([]);
    const withPin = jarvis();
    withPin.zugang.telefon = { nummer: "n1", anrufer: "freigegeben", pin: true };
    withPin.zugang.budget.anrufeJeNummerTag = 5;
    expect(errors(withPin)).toEqual([]);
    const noPin = structuredClone(withPin);
    noPin.zugang.telefon.pin = false;
    expectError(noPin, "voll am Telefon verlangt");
  });

  test("anrufer alle: verlangt kiHinweis und keins", () => {
    expect(errors(reception())).toEqual([]);
    const noHint = reception();
    delete noHint.persona.kiHinweis;
    expectError(noHint, "persona.kiHinweis: Pflicht");
    const blankHint = reception();
    blankHint.persona.kiHinweis = "   ";
    expectError(blankHint, "persona.kiHinweis");
    const withMemory = reception();
    withMemory.gedaechtnis = "voll";
    withMemory.zugang.telefon.pin = true;
    expectError(withMemory, "verlangt keins");
    const otherTemplate = jarvis();
    otherTemplate.gedaechtnis = "thema";
    otherTemplate.wissen = { datei: "data/voice-agents/beispiel/wissen.md" };
    otherTemplate.zugang.telefon = { nummer: "n1", anrufer: "alle", pin: false };
    otherTemplate.zugang.budget.anrufeJeNummerTag = 1;
    otherTemplate.persona.kiHinweis = "Hier spricht eine KI.";
    expectError(otherTemplate, "verlangt keins");
  });

  test("Anrufannahme ist immer für Fremde, auch ohne Telefon", () => {
    const recipe = reception();
    delete recipe.zugang.telefon;
    recipe.zugang.web = { link: true };
    expect(errors(recipe)).toEqual([]);
    delete recipe.persona.kiHinweis;
    expectError(recipe, "vorlage: anrufannahme");
  });

  test("mindestens zwei Tests mit eindeutigen Namen", () => {
    const one = jarvis();
    one.tests.pop();
    expectError(one, "mindestens 2 Tests");
    const same = jarvis();
    same.tests[1].name = same.tests[0].name;
    expectError(same, "Name doppelt");
  });

  test("Testnamen zählen so, wie das Schema sie zurückgibt", () => {
    for (const other of [" Test ", "Test ", " Test", "\tTest\n"]) {
      const same = jarvis();
      same.tests[0].name = "Test";
      same.tests[1].name = other;
      expect(errors(same)).toEqual(["tests: Name doppelt: Test"]);
    }
    const bothPadded = jarvis();
    bothPadded.tests[0].name = "  Test";
    bothPadded.tests[1].name = "Test  ";
    expect(errors(bothPadded)).toEqual(["tests: Name doppelt: Test"]);

    const different = jarvis();
    different.tests[0].name = " Erster ";
    different.tests[1].name = "Zweiter";
    const parsed = parseRecipe(different);
    expect(parsed.ok && parsed.recipe.tests.map((item) => item.name)).toEqual(["Erster", "Zweiter"]);
  });

  test("Testnamen, die das Schema ablehnt, melden nur den Schemafehler", () => {
    const blank = jarvis();
    blank.tests[0].name = "  ";
    blank.tests[1].name = "";
    expect(errors(blank)).toEqual(["tests[0].name: darf nicht leer sein", "tests[1].name: darf nicht leer sein"]);
    const blankTwice = jarvis();
    blankTwice.tests[0].name = "  ";
    blankTwice.tests[1].name = "  ";
    expect(errors(blankTwice)).toEqual(["tests[0].name: darf nicht leer sein", "tests[1].name: darf nicht leer sein"]);
  });

  test("Werkzeuge nur aus der festen Liste", () => {
    const good = jarvis();
    good.werkzeuge = ["rueckruf_notieren", "freie_termine", "notiz", "wissen_suchen", "wissensluecke_melden", "pin_pruefen"].map((name) => ({ name }));
    expect(errors(good)).toEqual([]);
    const bad = jarvis();
    bad.werkzeuge = [{ name: "shell_ausfuehren" }];
    expectError(bad, "werkzeuge[0].name: erlaubt sind");
    const twice = jarvis();
    twice.werkzeuge = [{ name: "notiz" }, { name: "notiz", freigabe: "ohne" }];
    expectError(twice, "werkzeuge: doppelt");
  });

  test("Stufe thema verlangt eine Wissensdatei im Ordner des Agenten", () => {
    expect(errors(expert())).toEqual([]);
    const none = expert();
    delete none.wissen;
    expectError(none, "wissen.datei: Pflicht");
    for (const path of ["../wissen.md", "data/voice-agents/beispiel/../../geheim.md", "data/voice-agents/anderer/wissen.md", "/etc/passwd.md", "data/voice-agents/beispiel/wissen.txt", "data/voice-agents/beispiel/unter/wissen.md"]) {
      const recipe = expert();
      recipe.wissen.datei = path;
      expectError(recipe, "wissen.datei: muss direkt unter");
    }
    const wrongLevel = jarvis();
    wrongLevel.wissen = { datei: "data/voice-agents/beispiel/wissen.md" };
    expectError(wrongLevel, "wissen: nur bei");
  });

  test("Experte: training Pflicht und nur dort, Stufe voll gesperrt, Standard und Rückfall gültig", () => {
    const noTraining = expert();
    delete noTraining.training;
    expectError(noTraining, "training: Pflicht");
    expectError(noTraining, "nachlauf.training");
    const elsewhere = jarvis();
    elsewhere.training = expert().training;
    expectError(elsewhere, "training: nur bei");
    const fullMemory = expert();
    delete fullMemory.wissen;
    fullMemory.gedaechtnis = "voll";
    expectError(fullMemory, "experte erlaubt");
    const fallback = expert();
    fallback.gehirn = { art: "bruecke", modell: "claude-sonnet-5-5" };
    expect(errors(fallback)).toEqual([]);
    const twoCriteria = expert();
    twoCriteria.training.kriterien.pop();
    expectError(twoCriteria, "genau drei Kriterien");
  });

  test("design und eigene brauchen eine Stimmen-Kennung, bibliothek nicht", () => {
    const library = jarvis();
    delete library.stimme.voiceId;
    expect(errors(library)).toEqual([]);
    for (const art of ["design", "eigene"]) {
      const recipe = jarvis();
      recipe.stimme = { art };
      expectError(recipe, `stimme.art: ${art}`);
    }
  });
});

describe("recipeHash", () => {
  test("Schlüsselreihenfolge zählt auf jeder Ebene nicht", () => {
    expect(recipeHash({ a: 1, b: { c: 2, d: [{ e: 3, f: 4 }] } })).toBe(recipeHash({ b: { d: [{ f: 4, e: 3 }], c: 2 }, a: 1 }));
  });

  test("Reihenfolge in Listen und Werte zählen", () => {
    expect(recipeHash({ a: [1, 2] })).not.toBe(recipeHash({ a: [2, 1] }));
    expect(recipeHash({ a: 1 })).not.toBe(recipeHash({ a: 2 }));
    expect(recipeHash({ a: "1" })).not.toBe(recipeHash({ a: 1 }));
  });

  test("Felder ohne Wert zählen wie fehlende, ein Rezept hat nach dem Parsen einen stabilen Hash", () => {
    expect(recipeHash({ a: 1, b: undefined })).toBe(recipeHash({ a: 1 }));
    const first = parseRecipe(jarvis());
    const reordered = jarvis();
    reordered.persona = { ersterSatz: reordered.persona.ersterSatz, sprachen: reordered.persona.sprachen, anrede: reordered.persona.anrede, rolle: reordered.persona.rolle };
    const second = parseRecipe(reordered);
    if (!first.ok || !second.ok) throw new Error("erwartet gültig");
    expect(recipeHash(first.recipe)).toBe(recipeHash(second.recipe));
  });
});

describe("resolveVoice", () => {
  const none = { stimme: { art: "bibliothek" as const, modell: "m", tempo: 1 } };
  const own = { stimme: { ...none.stimme, voiceId: "aus-rezept" } };

  test("Rezept vor Einstellung vor .env", () => {
    expect(resolveVoice(own, { setting: "s", env: "e" })).toEqual({ voiceId: "aus-rezept", quelle: "rezept" });
    expect(resolveVoice(none, { setting: "s", env: "e" })).toEqual({ voiceId: "s", quelle: "einstellung" });
    expect(resolveVoice(none, { env: "e" })).toEqual({ voiceId: "e", quelle: "umgebung" });
  });

  test("ohne Stimme ein Fehler in Klartext, kein stiller Rückfall", () => {
    const result = resolveVoice(none, {});
    expect("fehler" in result && result.fehler).toContain("keine Stimme festgelegt");
    expect("fehler" in resolveVoice(none, { env: "ungültig wegen leerzeichen" })).toBe(true);
  });
});

describe("Laden und Speichern", () => {
  let root: string;
  let paths: { configDir: string; dataDir: string };
  const noVoices = { voices: {} };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tybo-rezepte-"));
    paths = { configDir: join(root, "config"), dataDir: join(root, "data") };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("ohne Ordner: keine Rezepte, kein Fehler", async () => {
    expect(await loadRecipes(paths)).toEqual({ recipes: [], fehler: [] });
    expect(await loadRecipe("beispiel", paths)).toBeNull();
  });

  test("speichert ins Rezept und liest wieder gleich", async () => {
    const saved = await saveRecipe(jarvis(), { ...paths, ...noVoices });
    expect(saved.version).toBe(1);
    expect(saved.neueVersion).toBe(true);
    expect(await loadRecipe("beispiel", paths)).toEqual(saved.recipe);
    expect((await loadRecipes(paths)).recipes).toEqual([saved.recipe]);
    expect(recipeHash(await loadRecipe("beispiel", paths))).toBe(saved.hash);
  });

  test("übernimmt die Standardstimme beim Speichern fest ins Rezept", async () => {
    const recipe = jarvis();
    delete recipe.stimme.voiceId;
    const first = await saveRecipe(recipe, { ...paths, voices: { setting: "aus-einstellung", env: "aus-env" } });
    expect(first.recipe.stimme.voiceId).toBe("aus-einstellung");
    expect(JSON.parse(readFileSync(join(paths.configDir, "beispiel.json"), "utf8")).stimme.voiceId).toBe("aus-einstellung");
    // Eine spätere Änderung der Einstellung verstellt den Agenten nicht
    const again = await saveRecipe(first.recipe, { ...paths, voices: { setting: "neue-stimme" } });
    expect(again.recipe.stimme.voiceId).toBe("aus-einstellung");
    expect(again.neueVersion).toBe(false);
  });

  test("ohne Stimme nirgends: Speichern scheitert, nichts wird geschrieben", async () => {
    const recipe = jarvis();
    delete recipe.stimme.voiceId;
    await expect(saveRecipe(recipe, { ...paths, ...noVoices })).rejects.toThrow("keine Stimme festgelegt");
    expect(existsSync(join(paths.configDir, "beispiel.json"))).toBe(false);
  });

  test("ungültiges Rezept: Fehlerliste, nichts geschrieben", async () => {
    const error = await saveRecipe({ ...jarvis(), kennung: "../boese" }, { ...paths, ...noVoices }).catch((e) => e);
    expect(error).toBeInstanceOf(VoiceAgentError);
    expect(error.fehler.some((line: string) => line.startsWith("kennung:"))).toBe(true);
    expect(existsSync(paths.configDir)).toBe(false);
    expect(existsSync(join(root, "boese.json"))).toBe(false);
  });

  test("ungültige Kennung beim Laden verlässt den Ordner nicht", async () => {
    await expect(loadRecipe("../../etc/passwd", paths)).rejects.toThrow("Ungültige Kennung");
    await expect(loadRecipe("a/b", paths)).rejects.toThrow("Ungültige Kennung");
  });

  test("Kennung und Dateiname müssen zusammenpassen", async () => {
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(join(paths.configDir, "anders.json"), JSON.stringify(jarvis()));
    const loaded = await loadRecipes(paths);
    expect(loaded.recipes).toEqual([]);
    expect(loaded.fehler[0]?.datei).toBe("anders.json");
    expect(loaded.fehler[0]?.fehler[0]).toContain("passt nicht zum Dateinamen");
    await expect(loadRecipe("anders", paths)).rejects.toBeInstanceOf(VoiceAgentError);
  });

  test("beschädigte Dateien verstecken die anderen nicht und werden genannt", async () => {
    await saveRecipe(jarvis(), { ...paths, ...noVoices });
    writeFileSync(join(paths.configDir, "kaputt.json"), "{ nicht json");
    writeFileSync(join(paths.configDir, "Falscher_Name.json"), JSON.stringify(jarvis()));
    writeFileSync(join(paths.configDir, "ignoriert.txt"), "kein Rezept");
    const outside = join(root, "aussen.json");
    writeFileSync(outside, JSON.stringify({ ...jarvis(), kennung: "link" }));
    symlinkSync(outside, join(paths.configDir, "link.json"));
    const loaded = await loadRecipes(paths);
    expect(loaded.recipes.map((recipe) => recipe.kennung)).toEqual(["beispiel"]);
    expect(loaded.fehler.map((entry) => entry.datei).sort()).toEqual(["Falscher_Name.json", "kaputt.json", "link.json"]);
    await expect(loadRecipe("kaputt", paths)).rejects.toThrow("Kein gültiges JSON");
  });

  test("Speichern hält Versionen fest, unverändert keine neue", async () => {
    await saveRecipe(jarvis(), { ...paths, ...noVoices });
    const same = await saveRecipe(jarvis(), { ...paths, ...noVoices });
    expect(same).toMatchObject({ version: 1, neueVersion: false });
    const changed = await saveRecipe({ ...jarvis(), name: "Neu" }, { ...paths, ...noVoices });
    expect(changed).toMatchObject({ version: 2, neueVersion: true });
    expect(await listVersions("beispiel", paths)).toEqual([1, 2]);
  });

  describe("Speichern bleibt konsistent", () => {
    const options = () => ({ ...paths, ...noVoices });
    const activeFile = () => join(paths.configDir, "beispiel.json");
    const versionsDir = () => join(paths.dataDir, "beispiel", "versionen");
    const named = (name: string) => ({ ...jarvis(), name });

    async function expectActiveMatchesLastVersion() {
      const last = (await listVersions("beispiel", paths)).at(-1);
      expect(last).toBeDefined();
      expect(recipeHash(await readVersion("beispiel", last!, paths))).toBe(recipeHash(await loadRecipe("beispiel", paths)));
    }

    test("beschädigte letzte Version: Fehler, das aktive Rezept bleibt, nach dem Wegräumen geht es weiter", async () => {
      await saveRecipe(jarvis(), options());
      const active = readFileSync(activeFile(), "utf8");
      writeFileSync(join(versionsDir(), "1.json"), "{ kaputt");
      await expect(saveRecipe(named("Neu"), options())).rejects.toThrow(/bleibt unverändert.*beschädigt/);
      expect(readFileSync(activeFile(), "utf8")).toBe(active);
      expect(await listVersions("beispiel", paths)).toEqual([1]);
      expect(readdirSync(paths.configDir)).toEqual(["beispiel.json"]);
      rmSync(join(versionsDir(), "1.json"));
      expect(await saveRecipe(named("Neu"), options())).toMatchObject({ version: 1, neueVersion: true });
      await expectActiveMatchesLastVersion();
    });

    test("beschädigte Version ohne aktives Rezept: es entsteht keins", async () => {
      mkdirSync(versionsDir(), { recursive: true });
      writeFileSync(join(versionsDir(), "1.json"), "null");
      await expect(saveRecipe(jarvis(), options())).rejects.toThrow("beschädigt");
      expect(await loadRecipe("beispiel", paths)).toBeNull();
    });

    test("Testnamen, die erst normalisiert gleich sind: Klartextfehler, aktives Rezept und Versionen bleiben", async () => {
      await saveRecipe(jarvis(), options());
      const active = readFileSync(activeFile(), "utf8");
      const version = readFileSync(join(versionsDir(), "1.json"), "utf8");
      const clash = named("Neu");
      clash.tests[0].name = "Test";
      clash.tests[1].name = " Test ";

      const error = await saveRecipe(clash, options()).catch((e) => e);
      expect(error).toBeInstanceOf(VoiceAgentError);
      expect(error.message).toContain("tests: Name doppelt: Test");
      expect(error.fehler).toEqual(["tests: Name doppelt: Test"]);

      expect(readFileSync(activeFile(), "utf8")).toBe(active);
      expect(readdirSync(versionsDir())).toEqual(["1.json"]);
      expect(readFileSync(join(versionsDir(), "1.json"), "utf8")).toBe(version);
      expect((await loadRecipe("beispiel", paths))?.name).toBe("Beispiel");
      await expectActiveMatchesLastVersion();
    });

    test("Testnamen, die erst normalisiert gleich sind: ohne aktives Rezept entsteht nichts", async () => {
      const clash = jarvis();
      clash.tests[0].name = "Test";
      clash.tests[1].name = " Test ";
      await expect(saveRecipe(clash, options())).rejects.toThrow("tests: Name doppelt: Test");
      expect(existsSync(activeFile())).toBe(false);
      expect(existsSync(versionsDir())).toBe(false);
    });

    test("gespeicherte Rezepte mit Leerzeichen um die Testnamen lassen sich wieder laden", async () => {
      for (const build of [jarvis, reception, expert]) {
        const recipe = build();
        recipe.tests[0].name = " Erster ";
        recipe.tests[1].name = "\tZweiter\n";
        const saved = await saveRecipe(recipe, options());
        expect(saved.recipe.tests.map((item) => item.name)).toEqual(["Erster", "Zweiter"]);
        expect(await loadRecipe("beispiel", paths)).toEqual(saved.recipe);
        expect((await loadRecipes(paths)).fehler).toEqual([]);
        await expectActiveMatchesLastVersion();
        // Dieselbe Fassung noch einmal ist keine Änderung, auch nicht über die geladene Datei
        expect(await saveRecipe(await loadRecipe("beispiel", paths), options())).toMatchObject({ version: saved.version, neueVersion: false });
      }
    });

    test("Rezept nicht schreibbar: neue Version wird zurückgenommen, altes Rezept bleibt", async () => {
      if (process.getuid?.() === 0) return; // root schreibt auch in schreibgeschützte Ordner
      await saveRecipe(jarvis(), options());
      const active = readFileSync(activeFile(), "utf8");
      chmodSync(paths.configDir, 0o555);
      try {
        await expect(saveRecipe(named("Neu"), options())).rejects.toThrow("bleibt unverändert");
      } finally {
        chmodSync(paths.configDir, 0o755);
      }
      expect(readFileSync(activeFile(), "utf8")).toBe(active);
      expect(await listVersions("beispiel", paths)).toEqual([1]);
      await expectActiveMatchesLastVersion();
    });

    test("Version liegt nach einem Absturz vor dem Rezept: erneutes Speichern gleicht aus, ohne doppelte Version", async () => {
      const first = await saveRecipe(jarvis(), options());
      const ahead = { ...first.recipe, name: "Neu" };
      writeFileSync(join(versionsDir(), "2.json"), JSON.stringify(ahead));
      expect(await saveRecipe(ahead, options())).toMatchObject({ version: 2, neueVersion: false });
      await expectActiveMatchesLastVersion();
      expect((await loadRecipe("beispiel", paths))?.name).toBe("Neu");
    });

    test("parallele Aufrufe: jede Änderung eine Version, aktives Rezept gleich der letzten", async () => {
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => saveRecipe(named(`Name ${i}`), options())));
      expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      await expectActiveMatchesLastVersion();
      const winner = results.find((r) => r.version === 12)!;
      expect(await loadRecipe("beispiel", paths)).toEqual(winner.recipe);
      for (const result of results) expect(recipeHash(await readVersion("beispiel", result.version, paths))).toBe(result.hash);
      expect(readdirSync(join(paths.dataDir, "beispiel"))).toEqual(["versionen"]);
      expect(readdirSync(paths.configDir)).toEqual(["beispiel.json"]);
    });

    test("parallele Aufrufe mit gleichem Inhalt: eine Version", async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => saveRecipe(jarvis(), options())));
      expect(results.filter((r) => r.neueVersion).length).toBe(1);
      expect(await listVersions("beispiel", paths)).toEqual([1]);
      await expectActiveMatchesLastVersion();
    });

    test("mehrere Prozesse: die Sperre gilt auch über Prozessgrenzen", async () => {
      const script = `import { saveRecipe } from ${JSON.stringify(join(import.meta.dir, "../src/lib/voice-agents/recipe"))};
        const [recipe, options] = JSON.parse(process.argv.at(-1)!);
        for (let i = 0; i < 4; i++) await saveRecipe({ ...recipe, name: recipe.name + " " + i }, options);`;
      const runs = ["A", "B", "C"].map((who) =>
        Bun.spawn([process.execPath, "--eval", script, JSON.stringify([named(who), options()])], { stdout: "ignore", stderr: "pipe" }),
      );
      for (const run of runs) expect([await run.exited, await new Response(run.stderr).text()]).toEqual([0, ""]);
      expect(await listVersions("beispiel", paths)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      await expectActiveMatchesLastVersion();
    }, 60_000);

    test("Sperre eines toten Prozesses hält das Speichern nicht auf", async () => {
      const dead = Bun.spawnSync(["true"]).pid;
      mkdirSync(join(paths.dataDir, "beispiel"), { recursive: true });
      writeFileSync(join(paths.dataDir, "beispiel", "speichern.lock"), JSON.stringify({ token: "alt", pid: dead }));
      expect(await saveRecipe(jarvis(), options())).toMatchObject({ version: 1, neueVersion: true });
      expect(existsSync(join(paths.dataDir, "beispiel", "speichern.lock"))).toBe(false);
    });
  });

  describe("symbolische Links", () => {
    let outside: string;
    const options = () => ({ ...paths, ...noVoices });
    const foreign = () => JSON.stringify(jarvis());

    beforeEach(() => {
      outside = join(root, "fremd");
      mkdirSync(join(outside, "versionen"), { recursive: true });
      writeFileSync(join(outside, "beispiel.json"), foreign());
      writeFileSync(join(outside, "versionen", "1.json"), foreign());
    });

    function expectOutsideUntouched() {
      expect(readdirSync(outside).sort()).toEqual(["beispiel.json", "versionen"]);
      expect(readdirSync(join(outside, "versionen"))).toEqual(["1.json"]);
      expect(readFileSync(join(outside, "beispiel.json"), "utf8")).toBe(foreign());
      expect(readFileSync(join(outside, "versionen", "1.json"), "utf8")).toBe(foreign());
    }

    test("Rezeptordner ist ein Link: nichts gelesen, nichts geschrieben", async () => {
      symlinkSync(outside, paths.configDir);
      await expect(loadRecipes(paths)).rejects.toThrow("symbolischer Link");
      await expect(loadRecipe("beispiel", paths)).rejects.toThrow("symbolischer Link");
      await expect(saveRecipe({ ...jarvis(), name: "Neu" }, options())).rejects.toThrow("symbolischer Link");
      expectOutsideUntouched();
    });

    test("Rezeptdatei ist ein Link: nicht geladen, nicht ersetzt, keine Version", async () => {
      mkdirSync(paths.configDir, { recursive: true });
      symlinkSync(join(outside, "beispiel.json"), join(paths.configDir, "beispiel.json"));
      await expect(loadRecipe("beispiel", paths)).rejects.toThrow("symbolischer Link");
      await expect(saveRecipe({ ...jarvis(), name: "Neu" }, options())).rejects.toThrow("symbolischer Link");
      expect(lstatSync(join(paths.configDir, "beispiel.json")).isSymbolicLink()).toBe(true);
      expect(await listVersions("beispiel", paths)).toEqual([]);
      expectOutsideUntouched();
    });

    test("Link ins Leere gilt nicht als fehlendes Rezept", async () => {
      mkdirSync(paths.configDir, { recursive: true });
      symlinkSync(join(root, "gibt-es-nicht"), join(paths.configDir, "beispiel.json"));
      await expect(loadRecipe("beispiel", paths)).rejects.toThrow("symbolischer Link");
    });

    test("Agentenordner ist ein Link: das aktive Rezept bleibt, dort entsteht nichts", async () => {
      await saveRecipe(jarvis(), options());
      const active = readFileSync(join(paths.configDir, "beispiel.json"), "utf8");
      rmSync(join(paths.dataDir, "beispiel"), { recursive: true });
      symlinkSync(outside, join(paths.dataDir, "beispiel"));
      await expect(saveRecipe({ ...jarvis(), name: "Neu" }, options())).rejects.toThrow("symbolischer Link");
      expect(readFileSync(join(paths.configDir, "beispiel.json"), "utf8")).toBe(active);
      expectOutsideUntouched();
    });

    test("versionen ist ein Link: das aktive Rezept bleibt, dort entsteht nichts", async () => {
      await saveRecipe(jarvis(), options());
      const active = readFileSync(join(paths.configDir, "beispiel.json"), "utf8");
      rmSync(join(paths.dataDir, "beispiel", "versionen"), { recursive: true });
      symlinkSync(join(outside, "versionen"), join(paths.dataDir, "beispiel", "versionen"));
      await expect(saveRecipe({ ...jarvis(), name: "Neu" }, options())).rejects.toThrow("symbolischer Link");
      expect(readFileSync(join(paths.configDir, "beispiel.json"), "utf8")).toBe(active);
      expectOutsideUntouched();
    });

    test("Sperrdatei ist ein Link: wird nicht gelesen, Ziel bleibt", async () => {
      mkdirSync(join(paths.dataDir, "beispiel"), { recursive: true });
      symlinkSync(join(outside, "beispiel.json"), join(paths.dataDir, "beispiel", "speichern.lock"));
      await expect(saveRecipe(jarvis(), options())).rejects.toThrow("symbolischer Link");
      expect(existsSync(join(paths.configDir, "beispiel.json"))).toBe(false);
      expectOutsideUntouched();
    });
  });
});

describe("Beispieldateien", () => {
  const dir = join(import.meta.dir, "..", "config", "voice-agents.example");
  const files = ["anrufannahme", "jarvis", "verhandlungstrainer"];

  test("alle drei bestehen die Prüfung und tragen ihren Dateinamen als Kennung", async () => {
    const loaded = await loadRecipes({ configDir: dir });
    expect(loaded.fehler).toEqual([]);
    expect(loaded.recipes.map((recipe) => recipe.kennung)).toEqual(files);
    expect(loaded.recipes.map((recipe) => recipe.vorlage)).toEqual(["anrufannahme", "jarvis", "experte"]);
  });

  test("keine Stimmen-Kennung im Repo: die Standardstimme kommt beim Speichern dazu", async () => {
    const { recipes } = await loadRecipes({ configDir: dir });
    for (const recipe of recipes) expect(recipe.stimme.voiceId).toBeUndefined();
  });

  test("Experte nutzt den Standard der Vorlage", async () => {
    const recipe = await loadRecipe("verhandlungstrainer", { configDir: dir });
    expect(recipe?.gehirn).toMatchObject({ art: "anbieter", modell: "claude-sonnet-5-5" });
    expect(recipe?.gedaechtnis).toBe("thema");
  });
});
