/**
 * Issue #492, Checkbox 1: Übersicht und Testlauf hinter /sprachagent
 * (src/lib/voice-agents/manage.ts). Sprachschicht als Attrappe
 * (tests/voice-agents-manage-fixture.ts), Rezepte und Zustand in eigenen Ordnern.
 */
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChoiceConversation } from "../src/lib/choices";
import type { TestRunResult } from "../src/lib/voice-agents/layer";
import { formatVoiceAgentOverview } from "../src/lib/commands/voice-agents";
import { createVoiceAgentManager, formatTestRun, storeTestRun, VOICE_AGENT_TEST_HISTORY } from "../src/lib/voice-agents/manage";
import { recipeHash } from "../src/lib/voice-agents/base";
import { loadRecipe } from "../src/lib/voice-agents/recipe";
import { writeUnlock } from "../src/lib/voice-agents/unlock";
import { deployed, FIXED_NOW, manageHarness, removeHarnessDirs, writeRecipe } from "./voice-agents-manage-fixture";

// Manager und Register lesen dieselbe Uhr; hier steht sie fest
beforeEach(() => setSystemTime(new Date(FIXED_NOW)));
afterEach(() => setSystemTime());
afterAll(removeHarnessDirs);

const TOPIC: ChoiceConversation = { type: "telegram", chatId: "-100200", topicId: 9 };
const WEB: ChoiceConversation = { type: "web", conversationId: "0c1a2b3c-0000-4000-8000-000000000000" };

const testFile = (h: { paths: { dataDir: string } }, kennung: string) => join(h.paths.dataDir, kennung, "testlauf.json");

describe("Übersicht", () => {
  test("ohne Ordner: leer, keine Fehler", async () => {
    const h = manageHarness();
    expect(await h.manager.overview()).toEqual({ agents: [], fehler: [] });
  });

  test("je Rezept die Angaben aus dem Rezept, angelegt aus dem Zustand, Verbrauch unbekannt (null, nie 0)", async () => {
    const h = manageHarness();
    writeRecipe(h, "jarvis");
    writeRecipe(h, "empfang", raw => {
      raw.vorlage = "anrufannahme";
      raw.gedaechtnis = "keins";
      raw.persona.kiHinweis = "Hier spricht eine KI.";
      raw.zugang = { telefon: { nummer: "nr-1", anrufer: "alle", pin: false }, maxMinuten: 5, budget: { minutenMonat: 120, anrufeJeNummerTag: 3 } };
    });
    await deployed(h, "jarvis");
    const { agents, fehler } = await h.manager.overview();
    expect(fehler).toEqual([]);
    expect(agents.map(a => a.kennung)).toEqual(["empfang", "jarvis"]);
    const [empfang, jarvis] = agents;
    expect(jarvis).toMatchObject({ name: "Jarvis", vorlage: "jarvis", gedaechtnis: "voll", web: true, angelegt: true, letzterTest: null, laufenderTest: null, minuten: { limit: 300, verbraucht: null } });
    expect(jarvis!.telefon).toBeUndefined();
    expect(empfang).toMatchObject({ web: false, telefon: { nummer: "nr-1", anrufer: "alle" }, angelegt: false, minuten: { limit: 120, verbraucht: null } });
  });

  test("kaputtes Rezept steht unter fehler, die anderen bleiben sichtbar", async () => {
    const h = manageHarness();
    writeRecipe(h, "jarvis");
    writeFileSync(join(h.paths.configDir, "kaputt.json"), "{");
    const { agents, fehler } = await h.manager.overview();
    expect(agents.map(a => a.kennung)).toEqual(["jarvis"]);
    expect(fehler[0]!.datei).toBe("kaputt.json");
  });

  test("beschädigter Zustand oder Testlauf: Eintrag bleibt mit Hinweis", async () => {
    const h = manageHarness();
    writeRecipe(h, "jarvis");
    mkdirSync(join(h.paths.dataDir, "jarvis"), { recursive: true });
    writeFileSync(join(h.paths.dataDir, "jarvis", "state.json"), "null");
    writeFileSync(testFile(h, "jarvis"), "kaputt");
    const [entry] = (await h.manager.overview()).agents;
    expect(entry!.problem).toContain("Zustand nicht lesbar");
    expect(entry!.problem).toContain("Testlauf nicht lesbar");
  });

  test("testlauf.json gültiges JSON, aber falsch gebaut: Hinweis am Agenten, die anderen bleiben sichtbar", async () => {
    const run = { gestartetAm: "2026-11-07T09:00:00Z", beendetAm: "2026-11-07T09:03:00Z", ergebnis: "bestanden", tests: [] };
    const broken: unknown[] = [
      { letzter: {} },
      { letzter: { ...run, tests: [null] } },
      { letzter: { ...run, tests: [{ name: "Erster", status: "unbekannt" }] } },
      { letzter: { ...run, tests: "keine Liste" } },
      { letzter: { ...run, ergebnis: "irgendwas" } },
      { letzter: { ...run, beendetAm: 5 } },
      { letzter: null },
      { laufend: {} },
      { laufend: { runId: 1, gestartetAm: "2026-11-07T09:00:00Z" } },
      null,
      [],
      "text",
    ];
    for (const content of broken) {
      const h = manageHarness();
      writeRecipe(h, "jarvis");
      writeRecipe(h, "empfang");
      mkdirSync(join(h.paths.dataDir, "jarvis"), { recursive: true });
      writeFileSync(testFile(h, "jarvis"), JSON.stringify(content));
      const { agents } = await h.manager.overview();
      expect(agents.map(a => a.kennung)).toEqual(["empfang", "jarvis"]);
      const [empfang, jarvis] = agents;
      expect(jarvis!.letzterTest).toBeNull();
      expect(jarvis!.laufenderTest).toBeNull();
      expect(jarvis!.problem).toContain("Testlauf nicht lesbar");
      expect(empfang!.problem).toBeUndefined();
      // Die Liste lässt sich ohne Fehler darstellen
      expect(formatVoiceAgentOverview({ agents, fehler: [] })).toContain("Testlauf nicht lesbar");
    }
  });

  test("gültiger Testlauf mit allen Angaben wird gelesen", async () => {
    const h = manageHarness();
    writeRecipe(h, "jarvis");
    mkdirSync(join(h.paths.dataDir, "jarvis"), { recursive: true });
    const letzter = {
      runId: "lauf-0",
      gestartetAm: "2026-11-07T09:00:00Z",
      beendetAm: "2026-11-07T09:03:00Z",
      ergebnis: "durchgefallen",
      tests: [{ name: "Erster", status: "durchgefallen", kriterium: "zu laut" }],
      grund: "Grund",
    };
    writeFileSync(testFile(h, "jarvis"), JSON.stringify({ laufend: { runId: "lauf-1", gestartetAm: "2026-11-07T09:10:00Z" }, letzter }));
    const [entry] = (await h.manager.overview()).agents;
    expect(entry!.problem).toBeUndefined();
    expect(entry!.letzterTest).toEqual(letzter as any);
    expect(entry!.laufenderTest).toEqual({ gestartetAm: "2026-11-07T09:10:00Z", verfolgt: false });
    // Ältere Datei ohne Historie: keine früheren Läufe
    expect(entry!.fruehereTests).toEqual([]);
  });

  test("Historie (Issue #495): storeTestRun schiebt den letzten Lauf nach „frueher“, höchstens fünf zusammen; kaputte Historie gilt als beschädigt", async () => {
    const h = manageHarness();
    writeRecipe(h, "jarvis");
    const run = (n: number) => ({ runId: `lauf-${n}`, gestartetAm: "2026-11-07T09:00:00Z", beendetAm: `2026-11-07T09:0${n}:00Z`, ergebnis: "bestanden" as const, tests: [] });
    for (let n = 1; n <= 7; n++) await storeTestRun("jarvis", run(n), h.paths);
    const file = JSON.parse(readFileSync(testFile(h, "jarvis"), "utf8"));
    expect(file.letzter.runId).toBe("lauf-7");
    expect(file.frueher.map((r: any) => r.runId)).toEqual(["lauf-6", "lauf-5", "lauf-4", "lauf-3"]);
    expect(VOICE_AGENT_TEST_HISTORY).toBe(5);
    const [entry] = (await h.manager.overview()).agents;
    expect(entry!.letzterTest?.runId).toBe("lauf-7");
    expect(entry!.fruehereTests!.map((r) => r.runId)).toEqual(["lauf-6", "lauf-5", "lauf-4", "lauf-3"]);
    writeFileSync(testFile(h, "jarvis"), JSON.stringify({ letzter: run(1), frueher: [{ runId: 3 }] }));
    const [broken] = (await h.manager.overview()).agents;
    expect(broken!.problem).toContain("Testlauf nicht lesbar");
  });

  test("testlauf.json als symbolischer Link wird nicht gelesen", async () => {
    const h = manageHarness();
    writeRecipe(h, "jarvis");
    mkdirSync(join(h.paths.dataDir, "jarvis"), { recursive: true });
    const elsewhere = join(h.paths.dataDir, "..", "fremd.json");
    writeFileSync(elsewhere, JSON.stringify({ letzter: { ergebnis: "bestanden", tests: [] } }));
    symlinkSync(elsewhere, testFile(h, "jarvis"));
    const [entry] = (await h.manager.overview()).agents;
    expect(entry!.letzterTest).toBeNull();
    expect(entry!.problem).toContain("Testlauf nicht lesbar");
  });
});

describe("Testlauf", () => {
  test("bestanden x von y: Start, Ergebnis ins Ursprungsgespräch, dauerhaft gespeichert, in der Übersicht", async () => {
    const h = manageHarness();
    writeRecipe(h, "jarvis");
    await deployed(h, "jarvis");
    h.layer.result = {
      status: "fertig",
      gesamt: "durchgefallen",
      tests: [
        { testId: "t1", name: "Erster", status: "bestanden" },
        { testId: "t2", name: "Zweiter", status: "durchgefallen", kriterium: "bleibt nicht ruhig" },
        { testId: "t3", name: "Dritter", status: "durchgefallen" },
      ],
    };
    expect(await h.manager.startTest("jarvis", TOPIC)).toEqual({ status: "gestartet", name: "Jarvis" });
    await h.manager.settled();
    expect(h.layer.calls).toEqual([
      { method: "runTests", arg: "agent-jarvis" },
      { method: "testResult", arg: "lauf-1" },
    ]);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.conversation).toEqual(TOPIC);
    const text = h.notes[0]!.text;
    expect(text).toContain("Testlauf Jarvis (jarvis): durchgefallen, bestanden 1 von 3");
    expect(text).toContain("✅ Erster: bestanden");
    expect(text).toContain("❌ Zweiter: durchgefallen, verfehlt: bleibt nicht ruhig");
    // Ohne Begründung des Anbieters: ehrlich sagen, nichts erfinden
    expect(text).toContain("❌ Dritter: durchgefallen, der Anbieter nennt keine Begründung");

    const stored = JSON.parse(readFileSync(testFile(h, "jarvis"), "utf8"));
    expect(stored.laufend).toBeUndefined();
    expect(stored.letzter).toMatchObject({ runId: "lauf-1", ergebnis: "durchgefallen" });
    const [entry] = (await h.manager.overview()).agents;
    expect(entry!.letzterTest?.tests).toHaveLength(3);
    expect(entry!.laufenderTest).toBeNull();
  });

  test("Ergebnis gilt auch nach neuem Manager (Neustart): letzter Lauf bleibt, ein offener heißt nicht abgeholt", async () => {
    const h = manageHarness();
    writeRecipe(h, "jarvis");
    await deployed(h, "jarvis");
    let release!: () => void;
    h.layer.result = () => new Promise<TestRunResult>(resolve => (release = () => resolve({ status: "fertig", gesamt: "bestanden", tests: [] })));
    await h.manager.startTest("jarvis", WEB);
    // Während der Lauf verfolgt wird
    expect((await h.manager.overview()).agents[0]!.laufenderTest).toEqual({ gestartetAm: "2026-11-07T10:00:00.000Z", verfolgt: true });
    expect(await h.manager.startTest("jarvis", WEB)).toMatchObject({ status: "laeuft" });
    expect(h.layer.calls.filter(c => c.method === "runTests")).toHaveLength(1);
    // Ein zweiter Prozess sieht den Lauf nur in der Datei
    const restarted = createVoiceAgentManager({
      layer: () => null,
      paths: h.paths,
      sendChoice: async () => ({ sent: true }),
      notify: async () => {},
    });
    expect((await restarted.overview()).agents[0]!.laufenderTest).toEqual({ gestartetAm: "2026-11-07T10:00:00.000Z", verfolgt: false });
    release();
    await h.manager.settled();
    expect((await restarted.overview()).agents[0]!.letzterTest?.ergebnis).toBe("bestanden");
  });

  test("Zeitüberschreitung, Fehler und geworfene Abfrage werden gemeldet und gespeichert", async () => {
    const cases: [TestRunResult | (() => Promise<TestRunResult>), string, string][] = [
      [{ status: "zeitueberschreitung", tests: [{ testId: "t1", name: "Erster", status: "offen" }], grund: "HTTP 503" }, "kein Ergebnis innerhalb der Frist", "zeitueberschreitung"],
      [{ status: "fehler", fehler: "HTTP 401", vorlaeufig: false }, "Abfrage gescheitert: HTTP 401", "fehler"],
      [async () => { throw new Error("weg"); }, "Abfrage gescheitert: Interner Fehler", "fehler"],
      [{ status: "fertig", gesamt: "abgebrochen", tests: [{ testId: "t1", name: "Erster", status: "abgebrochen" }] }, "abgebrochen, bestanden 0 von 1", "abgebrochen"],
    ];
    for (const [result, text, ergebnis] of cases) {
      const h = manageHarness();
      writeRecipe(h, "jarvis");
      await deployed(h, "jarvis");
      h.layer.result = result;
      await h.manager.startTest("jarvis", TOPIC);
      await h.manager.settled();
      expect(h.notes[0]!.text).toContain(text);
      expect(JSON.parse(readFileSync(testFile(h, "jarvis"), "utf8")).letzter.ergebnis).toBe(ergebnis);
    }
  });

  test("Zeitüberschreitung zeigt den Stand bis dahin", () => {
    const text = formatTestRun("Jarvis", "jarvis", { gestartetAm: "", beendetAm: "", ergebnis: "zeitueberschreitung", tests: [{ name: "Erster", status: "offen" }] });
    expect(text).toContain("Stand bis dahin");
    expect(text).toContain("⏳ Erster: noch offen");
  });

  test("Start scheitert beim Anbieter: Fehler zurück, nichts gespeichert, keine Meldung", async () => {
    const h = manageHarness();
    writeRecipe(h, "jarvis");
    await deployed(h, "jarvis");
    h.layer.runResult = { status: "fehler", fehler: "HTTP 429", vorlaeufig: true };
    expect(await h.manager.startTest("jarvis", TOPIC)).toEqual({ status: "fehler", name: "Jarvis", fehler: "HTTP 429" });
    await h.manager.settled();
    expect(existsSync(testFile(h, "jarvis"))).toBe(false);
    expect(h.notes).toEqual([]);
  });

  test("unbekannte oder ungültige Kennung, kein Anbieter, nicht angelegt: kein Aufruf", async () => {
    const h = manageHarness();
    writeRecipe(h, "jarvis");
    expect(await h.manager.startTest("gibtsnicht", TOPIC)).toEqual({ status: "unbekannt" });
    expect(await h.manager.startTest("../jarvis", TOPIC)).toEqual({ status: "unbekannt" });
    expect(await h.manager.startTest("entwuerfe", TOPIC)).toEqual({ status: "unbekannt" });
    expect(await h.manager.startTest("jarvis", TOPIC)).toEqual({ status: "nicht_angelegt", name: "Jarvis" });
    const none = manageHarness({ withLayer: false });
    writeRecipe(none, "jarvis");
    await deployed(none, "jarvis");
    expect(await none.manager.startTest("jarvis", TOPIC)).toEqual({ status: "kein_anbieter" });
    expect(h.layer.calls).toEqual([]);
    expect(none.layer.calls).toEqual([]);
  });

  test("Meldung scheitert: geloggt, Ergebnis trotzdem gespeichert", async () => {
    const h = manageHarness({ deps: { notify: async () => { throw new Error("offline"); } } });
    writeRecipe(h, "jarvis");
    await deployed(h, "jarvis");
    await h.manager.startTest("jarvis", TOPIC);
    await h.manager.settled();
    expect(h.logs.some(l => l.includes("nicht zugestellt"))).toBe(true);
    expect(JSON.parse(readFileSync(testFile(h, "jarvis"), "utf8")).letzter.ergebnis).toBe("bestanden");
  });
});

describe("link (Issue #494)", () => {
  async function unlocked(h: ReturnType<typeof manageHarness>, kennung: string): Promise<void> {
    const recipe = (await loadRecipe(kennung, h.paths))!;
    const outcome = await writeUnlock(kennung, { hash: recipeHash(recipe), version: 1, wissenHash: null, grund: "tests" }, h.paths);
    expect(outcome.status).toBe("freigeschaltet");
  }

  test("freigeschaltet mit Web-Zugang: Adresse /sa/<kennung> unter der Adresse der WebUI", async () => {
    const h = manageHarness({ deps: { webBase: () => "https://tybo.example.org/" } });
    writeRecipe(h, "jarvis");
    await unlocked(h, "jarvis");
    expect(await h.manager.link("jarvis")).toEqual({ status: "link", name: "Jarvis", url: "https://tybo.example.org/sa/jarvis" });
  });

  test("ohne Freischaltung oder nach einer Änderung: gesperrt", async () => {
    const h = manageHarness({ deps: { webBase: () => "http://192.168.1.5:3100" } });
    writeRecipe(h, "jarvis");
    expect(await h.manager.link("jarvis")).toEqual({ status: "gesperrt", name: "Jarvis" });
    await unlocked(h, "jarvis");
    writeRecipe(h, "jarvis", raw => void (raw.zweck = "Etwas anderes"));
    expect(await h.manager.link("jarvis")).toEqual({ status: "gesperrt", name: "Jarvis" });
  });

  test("ohne Web-Zugang, ohne WebUI, beschädigt, unbekannt", async () => {
    const h = manageHarness({ deps: { webBase: () => null } });
    writeRecipe(h, "jarvis");
    await unlocked(h, "jarvis");
    writeRecipe(h, "empfang", raw => void (raw.zugang.web = { link: false }));
    writeRecipe(h, "kaputt", raw => void (raw.unbekannt = 1));
    expect(await h.manager.link("jarvis")).toEqual({ status: "keine_webui", name: "Jarvis" });
    expect(await h.manager.link("empfang")).toEqual({ status: "kein_web", name: "Empfang" });
    expect(await h.manager.link("kaputt")).toEqual({ status: "kaputt", name: "kaputt" });
    expect(await h.manager.link("nix")).toEqual({ status: "unbekannt" });
  });
});
