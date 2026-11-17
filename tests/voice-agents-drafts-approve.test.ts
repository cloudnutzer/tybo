/**
 * Issue #493, Checkbox 2: Freigabe als Rückfrage der Art "sprachagent" und die
 * Handler „Anlegen“, „Verwerfen“, „Trotzdem freischalten“ und „Erneut
 * versuchen“. Echtes Rückfragen-Register mit eigener Datei, Jobs und
 * Sprachschicht als Attrappen (tests/voice-agents-drafts-fixture.ts); kein
 * Anbieteraufruf, kein echter Job.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideChoice, listChoices, onChoiceDecided, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { recipeHash } from "../src/lib/voice-agents/base";
import { DEFAULT_PRICE_BASIS } from "../src/lib/voice-agents/cost";
import { coversRequested, DRAFT_TEXT, voiceAgentChoiceHandler } from "../src/lib/voice-agents/drafts";
import { createElevenLabsLayer } from "../src/lib/voice-agents/elevenlabs";
import { saveRecipe, SaveRefused } from "../src/lib/voice-agents/recipe";
import { updateState } from "../src/lib/voice-agents/state";
import { readUnlock, isUnlocked, writeUnlock } from "../src/lib/voice-agents/unlock";
import { ablageDir, DM, draftHarness, draftRecipe, expertRecipe, GOOD_KNOWLEDGE, patchRecord, readRecord, removeDraftDirs, writeActive, writeOutput, type DraftHarness } from "./voice-agents-drafts-fixture";
import { BRIDGE_ENV, ENV, FakeElevenLabs, fakeClock, jsonResponse } from "./voice-agents-elevenlabs-fixture";

const ID = "20261107-090001-a1b2c3";
let counter = 0;
let off: (() => void)[] = [];
let logSpy: ReturnType<typeof spyOn>;
let managerCalls: Choice[] = [];

beforeEach(() => {
  const h = draftHarness();
  setChoicesFileForTests(join(h.root, `choices-${++counter}.json`));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  managerCalls = [];
});
afterEach(() => {
  for (const stop of off.splice(0)) stop();
  logSpy.mockRestore();
});
afterAll(() => {
  setChoicesFileForTests(null);
  removeDraftDirs();
});

/** Harness mit einem Handler im Register: Entwurfsschritte an den Dienst, der Rest an eine Attrappe des Managers */
function wired(options: Parameters<typeof draftHarness>[0] = {}): DraftHarness {
  const h = draftHarness(options);
  off.push(onChoiceDecided("sprachagent", (choice) => voiceAgentChoiceHandler(async (c) => void managerCalls.push(c), h.service)(choice)));
  return h;
}

/** Entwurf bis zur Freigabe bringen */
async function toApproval(h: DraftHarness, files: Parameters<typeof writeOutput>[2] = { recipe: draftRecipe() }): Promise<Choice> {
  await h.service.startNew("Eine Kochhilfe", DM);
  writeOutput(h, ID, files);
  h.jobs.finish(h.jobs.last().id);
  await h.service.tick();
  return h.sent.at(-1)!;
}

async function click(h: DraftHarness, choice: Choice, key: string) {
  const outcome = await decideChoice(choice.id, key, "telegram");
  await h.service.settled();
  return outcome;
}

/** Ein Testlauf, wie ElevenLabs ihn meldet */
const providerRun = (testId: string, status: string, extra: object = {}) => ({ test_run_id: `r-${testId}`, test_invocation_id: "lauf_1", agent_id: "a", test_id: testId, test_name: `Test ${testId}`, status, ...extra });
const failedRun = (testId: string) => providerRun(testId, "failed", { condition_result: { result: "failure", rationale: { messages: ["nein"], summary: "" } } });

/**
 * Antwort der Anbieter-Attrappe auf die Testabfrage, gebaut aus den Test-IDs,
 * die das letzte run-tests angefordert hat. shape lässt sich zwischen zwei
 * Versuchen tauschen; null heißt HTTP 400 (Abfrage gescheitert).
 */
function answerRuns(fake: FakeElevenLabs): { shape: ((ids: string[]) => unknown[]) | null } {
  const control: { shape: ((ids: string[]) => unknown[]) | null } = { shape: (ids) => ids.map((id) => providerRun(id, "passed")) };
  fake.override(
    (call) => call.method === "GET" && call.path.startsWith("/test-invocations/"),
    () => {
      if (!control.shape) return jsonResponse({ detail: "kaputt" }, 400);
      const ids: string[] = fake.of("POST", /\/run-tests$/).at(-1)!.body.tests.map((t: { test_id: string }) => t.test_id);
      return jsonResponse({ id: "lauf_1", test_runs: control.shape(ids) });
    },
    10_000,
  );
  return control;
}

/** Harness mit der echten Sprachschicht über der Anbieter-Attrappe */
function withProvider(env: Record<string, string> = ENV): { h: DraftHarness; fake: FakeElevenLabs; runs: ReturnType<typeof answerRuns> } {
  const fake = new FakeElevenLabs();
  const runs = answerRuns(fake);
  let h!: DraftHarness;
  h = wired({ deps: { layer: () => createElevenLabsLayer({ env, fetch: fake.fetch, paths: h.paths, clock: fakeClock() }) } });
  return { h, fake, runs };
}

const recipeFile = (h: DraftHarness, kennung = "kochhilfe") => join(h.paths.configDir, `${kennung}.json`);
const methods = (h: DraftHarness) => h.layer.calls.map((c) => c.method);

describe("Freigabe", () => {
  test("Kurzfassung mit Zweck, Vorlage, Stimme, Gehirn, Gedächtnis, Zugang, Tests und Kosten; Knöpfe Anlegen und Verwerfen", async () => {
    const h = wired();
    const choice = await toApproval(h);
    expect(choice).toMatchObject({ kind: "sprachagent", action: "freigabe", ref: ID });
    expect(choice.options).toEqual([
      { key: "anlegen", label: "Anlegen" },
      { key: "verwerfen", label: "Verwerfen" },
    ]);
    const text = choice.text;
    expect(text).toContain("Entwurf: Kochhilfe (kochhilfe)");
    expect(text).toContain("Zweck: Hilft im Alltag.");
    expect(text).toContain("Vorlage: jarvis · Stimme: Standardstimme · Gehirn: Anbieter, claude-sonnet-5-5");
    expect(text).toContain("Gedächtnis: keins");
    expect(text).toContain("Zugang: Web-Link; höchstens 12 Minuten je Gespräch, 300 im Monat");
    expect(text).toMatch(/Tests \(\d+\): .*Erster, Zweiter/);
    // Eingebaute Preisgrundlage: Anbieter 0,08 je Minute, Sonnet 5.5 mit 3 Zügen zu je 6.700 + 150 Token
    expect(text).toContain("Kosten je Minute: etwa 0,129 USD (Anbieter 0,08 USD, Gehirn claude-sonnet-5-5 0,049 USD), ein Gespräch von höchstens 12 Minuten bis 1,55 USD.");
    expect(text).toContain("Annahmen: 3 Züge je Minute mit je 6.700 Eingabe- und 150 Ausgabe-Token");
    expect(text).toContain("Preisstand 2026-11-07");
    expect(text).toContain("https://elevenlabs.io/pricing/agents");
    expect(text).toContain("https://elevenlabs.io/scale-tier#llm-prices");
    expect(text).toContain("/sprachagent aendern kochhilfe");
    // Nichts angelegt, nichts beim Anbieter
    expect(existsSync(recipeFile(h))).toBe(false);
    expect(h.layer.calls).toEqual([]);
    expect(readRecord(h, ID).choiceId).toBe(choice.id);
  });

  test("eigene Preisdatei: Summe je Minute und Höchstbetrag je Gespräch, Stand und Quelle genannt", async () => {
    const basis = {
      ...DEFAULT_PRICE_BASIS,
      stand: "2026-11-01",
      anbieter: { jeMinute: 0.1, quelle: "https://example.com/preise" },
      gehirn: { quelle: "https://example.com/modelle", jeMillionToken: { "claude-sonnet-5-5": { eingabe: 1, ausgabe: 0 } } },
      annahmen: { ...DEFAULT_PRICE_BASIS.annahmen, zuegeJeMinute: 2, eingabeTokenJeZug: 10_000 },
    };
    const h = wired({ deps: { prices: async () => ({ status: "ok", basis, eigene: true }) } });
    const choice = await toApproval(h);
    expect(choice.text).toContain("Kosten je Minute: etwa 0,12 USD (Anbieter 0,10 USD, Gehirn claude-sonnet-5-5 0,02 USD), ein Gespräch von höchstens 12 Minuten bis 1,44 USD.");
    expect(choice.text).toContain("Preisstand 2026-11-01 aus config/voice-agent-preise.json");
    expect(choice.text).toContain("Quellen https://example.com/preise, https://example.com/modelle");
  });

  test("Brücke: nur der Anteil des Anbieters, ausdrücklich ohne Gehirn und ohne Obergrenze je Gespräch", async () => {
    const h = wired();
    const choice = await toApproval(h, { recipe: draftRecipe("kochhilfe", (r) => (r.gehirn = { art: "bruecke", modell: "claude-opus-5-5" })) });
    expect(choice.text).toContain("Kosten je Minute: Anbieter etwa 0,08 USD, ohne das Gehirn");
    expect(choice.text).toContain("Eine Obergrenze je Gespräch nennt tybo deshalb nicht");
    expect(choice.text).not.toMatch(/Gespräch von höchstens \d+ Minuten bis/);
  });

  test("Modell ohne Preis und Telefon ohne Preis des Telefonanbieters: nichts erfunden", async () => {
    const h = wired();
    const unknown = await toApproval(h, { recipe: draftRecipe("kochhilfe", (r) => (r.gehirn = { art: "anbieter", modell: "ein-anderes-modell" })) });
    expect(unknown.text).toContain("Kosten je Minute: unbekannt, für das Modell ein-anderes-modell steht kein Preis in der Preisgrundlage");
  });
});

describe("Anlegen", () => {
  test("Rezept nach config/voice-agents, deploy, Tests anlegen und ausführen; bestanden: freigeschaltet an diese Fassung gebunden", async () => {
    const h = wired();
    const choice = await toApproval(h);
    expect((await click(h, choice, "anlegen")).status).toBe("decided");
    // Vor dem Freischalten liest tybo den Stand beim Anbieter und vergleicht mit dem getesteten
    expect(methods(h)).toEqual(["deploy", "syncTests", "runTests", "testResult", "compareStand"]);
    expect(h.layer.calls.at(-1)!.arg).toEqual({ agentId: "agent-kochhilfe", stand: { ersterSatz: "stand-1" } });
    const saved = JSON.parse(readFileSync(recipeFile(h), "utf8"));
    expect(saved.stimme.voiceId).toBe("standard-stimme");
    expect(readdirSync(join(h.paths.dataDir, "kochhilfe", "versionen"))).toEqual(["1.json"]);
    const unlock = (await readUnlock("kochhilfe", h.paths))!;
    expect(unlock).toMatchObject({ hash: recipeHash(saved), version: 1, grund: "tests", testlauf: "lauf-1" });
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
    expect(readRecord(h, ID).phase).toBe("fertig");
    const texts = h.notes.map((n) => n.text);
    expect(texts[0]).toBe(DRAFT_TEXT.creating("kochhilfe"));
    expect(texts.some((t) => t.startsWith("🧪 Testlauf Kochhilfe (kochhilfe): bestanden"))).toBe(true);
    expect(texts.at(-1)).toBe(DRAFT_TEXT.passed("kochhilfe", 1));
    // Der Testlauf steht auch für /sprachagent liste bereit
    expect(JSON.parse(readFileSync(join(h.paths.dataDir, "kochhilfe", "testlauf.json"), "utf8")).letzter.ergebnis).toBe("bestanden");
  });

  test("Doppelklick: der zweite Klick ändert nichts, genau ein Anlegen", async () => {
    const h = wired();
    const choice = await toApproval(h);
    const [a, b] = await Promise.all([decideChoice(choice.id, "anlegen", "telegram"), decideChoice(choice.id, "anlegen", "web")]);
    await h.service.settled();
    expect([a.status, b.status].sort()).toEqual(["already", "decided"]);
    expect(methods(h).filter((m) => m === "deploy")).toHaveLength(1);
  });

  test("veraltete Freigabe: eine ältere Rückfrage desselben Entwurfs tut nichts", async () => {
    const h = wired();
    const choice = await toApproval(h);
    // Dieselbe Frage noch einmal stellen lassen (etwa nach Neustart des Takts): die alte läuft ab
    const record = readRecord(h, ID);
    await h.service.handler({ ...choice, id: "AlteFrage01", state: "done", result: { key: "anlegen", label: "Anlegen", via: "telegram", at: Date.now() } });
    expect(h.layer.calls).toEqual([]);
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.notOpen);
    expect(readRecord(h, ID).phase).toBe(record.phase);
  });

  test("veränderter Entwurf nach der Prüfung (Steuerdaten): nichts angelegt", async () => {
    const h = wired();
    const choice = await toApproval(h);
    patchRecord(h, ID, (record) => (record.rezept.zweck = "Untergeschoben"));
    await click(h, choice, "anlegen");
    expect(existsSync(recipeFile(h))).toBe(false);
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.changedDraft);
    expect(readRecord(h, ID).phase).toBe("abgebrochen");
  });

  test("veränderter Entwurf nach der Prüfung (Ablage unter entwuerfe/<kennung>): nichts angelegt", async () => {
    const h = wired();
    const choice = await toApproval(h);
    const file = join(ablageDir(h, "kochhilfe"), "rezept.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), zweck: "Untergeschoben" }));
    await click(h, choice, "anlegen");
    expect(existsSync(recipeFile(h))).toBe(false);
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.changedDraft);
    expect(h.layer.calls).toEqual([]);
  });

  test("Kennung inzwischen vergeben: nichts überschrieben", async () => {
    const h = wired();
    const choice = await toApproval(h);
    writeActive(h, draftRecipe("kochhilfe", (r) => ((r.stimme.voiceId = "stimme-1"), (r.zweck = "Schon da"))));
    await click(h, choice, "anlegen");
    expect(JSON.parse(readFileSync(recipeFile(h), "utf8")).zweck).toBe("Schon da");
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.taken("kochhilfe"));
    expect(h.layer.calls).toEqual([]);
  });

  test("Verwerfen: keine aktive Änderung, weder Rezept noch Ordner des Agenten, kein Anbieteraufruf", async () => {
    const h = wired();
    const choice = await toApproval(h);
    await click(h, choice, "verwerfen");
    expect(existsSync(recipeFile(h))).toBe(false);
    expect(existsSync(join(h.paths.dataDir, "kochhilfe"))).toBe(false);
    expect(h.layer.calls).toEqual([]);
    expect(readRecord(h, ID).phase).toBe("verworfen");
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.discarded);
  });

  test("Experte: Wissensdatei unter ihrem Hash, Prompt beim Anbieter enthält sie vor den festen Regeln", async () => {
    const h = wired();
    const choice = await toApproval(h, { recipe: expertRecipe(), knowledge: GOOD_KNOWLEDGE });
    await click(h, choice, "anlegen");
    const saved = JSON.parse(readFileSync(recipeFile(h, "segel-trainer"), "utf8"));
    const name = saved.wissen.datei.split("/").at(-1);
    expect(name).toMatch(/^wissen-[0-9a-f]{12}\.md$/);
    expect(readFileSync(join(h.paths.dataDir, "segel-trainer", name), "utf8")).toBe(GOOD_KNOWLEDGE);
    const prompt = h.layer.prompts[0];
    expect(prompt).toContain("# Themenwissen");
    expect(prompt).toContain("Wind kommt von vorn.");
    expect(prompt.indexOf("# Themenwissen")).toBeLessThan(prompt.indexOf("# Feste Regeln"));
  });

  test("ohne Anbieter: Rezept gespeichert, nicht freigeschaltet, Erneut versuchen angeboten", async () => {
    const h = wired({ withLayer: false });
    const choice = await toApproval(h);
    await click(h, choice, "anlegen");
    expect(existsSync(recipeFile(h))).toBe(true);
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
    expect(h.sent.at(-1)).toMatchObject({ action: "fortsetzen", options: [{ key: "weiter" }, { key: "verwerfen" }] });
  });
});

describe("Tests nicht bestanden", () => {
  test("durchgefallen: Agent bleibt gesperrt, Knopf Trotzdem freischalten schaltet genau diese Fassung frei", async () => {
    const h = wired();
    h.layer.result = { status: "fertig", gesamt: "durchgefallen", tests: [{ testId: "t1", name: "Erster", status: "durchgefallen", kriterium: "antwortet" }] };
    const choice = await toApproval(h);
    await click(h, choice, "anlegen");
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(readRecord(h, ID).phase).toBe("durchgefallen");
    const ask = h.sent.at(-1)!;
    expect(ask).toMatchObject({ action: "freischalten", text: DRAFT_TEXT.failedTests("kochhilfe") });
    expect(ask.options.map((o) => o.label)).toEqual(["Trotzdem freischalten", "Gesperrt lassen"]);
    expect(h.notes.some((n) => n.text.includes("❌ Erster: durchgefallen, verfehlt: antwortet"))).toBe(true);
    await click(h, ask, "freischalten");
    expect(await readUnlock("kochhilfe", h.paths)).toMatchObject({ grund: "trotzdem", version: 1 });
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.unlocked("kochhilfe"));
  });

  test("Gesperrt lassen: keine Freischaltung", async () => {
    const h = wired();
    h.layer.result = { status: "fertig", gesamt: "durchgefallen", tests: [{ testId: "t1", name: "Erster", status: "durchgefallen" }] };
    await click(h, await toApproval(h), "anlegen");
    await click(h, h.sent.at(-1)!, "gesperrt");
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.keptLocked("kochhilfe"));
  });

  test("Trotzdem freischalten nach einer Änderung am Rezept: veraltet, nichts freigeschaltet", async () => {
    const h = wired();
    h.layer.result = { status: "fertig", gesamt: "durchgefallen", tests: [{ testId: "t1", name: "Erster", status: "durchgefallen" }] };
    await click(h, await toApproval(h), "anlegen");
    const saved = JSON.parse(readFileSync(recipeFile(h), "utf8"));
    writeActive(h, { ...saved, zweck: "Inzwischen anders" });
    await click(h, h.sent.at(-1)!, "freischalten");
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.unlockStale("kochhilfe"));
  });

  for (const [label, result] of [
    ["Fehler der Abfrage", { status: "fehler", fehler: "Zeitablauf", vorlaeufig: true }],
    ["Zeitüberschreitung", { status: "zeitueberschreitung", tests: [] }],
    ["Abbruch", { status: "fertig", gesamt: "abgebrochen", tests: [] }],
  ] as const) {
    test(`${label}: nie freigeschaltet, kein Trotzdem-Knopf, Erneut versuchen schaltet nach bestandenem Lauf frei`, async () => {
      const h = wired();
      h.layer.result = result as any;
      await click(h, await toApproval(h), "anlegen");
      expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
      expect(readRecord(h, ID).phase).toBe("unterbrochen");
      const retry = h.sent.at(-1)!;
      expect(retry.action).toBe("fortsetzen");
      expect(h.sent.some((c) => c.action === "freischalten")).toBe(false);
      h.layer.result = { status: "fertig", gesamt: "bestanden", tests: [{ testId: "t1", name: "Erster", status: "bestanden" }] };
      await click(h, retry, "weiter");
      expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
      // Kein zweites Speichern einer neuen Version
      expect(readdirSync(join(h.paths.dataDir, "kochhilfe", "versionen"))).toEqual(["1.json"]);
    });
  }

  test("gemischt: ein Test durchgefallen, einer abgebrochen: kein Trotzdem-Knopf, nicht freigeschaltet", async () => {
    const h = wired();
    h.layer.result = {
      status: "fertig",
      gesamt: "durchgefallen",
      tests: [
        { testId: "t1", name: "Erster", status: "durchgefallen", kriterium: "antwortet" },
        { testId: "t2", name: "Zweiter", status: "abgebrochen" },
      ],
    };
    await click(h, await toApproval(h), "anlegen");
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
    expect(h.sent.some((c) => c.action === "freischalten")).toBe(false);
    expect(h.sent.at(-1)!.action).toBe("fortsetzen");
    expect(h.notes.some((n) => n.text === DRAFT_TEXT.interrupted("kochhilfe", DRAFT_TEXT.incompleteRun))).toBe(true);
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
  });

  test("gemischt, mit der echten Sprachschicht und der Anbieter-Attrappe: durchgefallen plus abgebrochen bis zur Freischaltungsentscheidung", async () => {
    const { h, runs } = withProvider();
    runs.shape = ([first, second, ...rest]) => [failedRun(first!), providerRun(second!, "cancelled"), ...rest.map((id) => providerRun(id, "passed"))];
    await click(h, await toApproval(h), "anlegen");
    // Die Schicht selbst meldet gesamt durchgefallen
    expect(JSON.parse(readFileSync(join(h.paths.dataDir, "kochhilfe", "testlauf.json"), "utf8")).letzter).toMatchObject({ ergebnis: "durchgefallen" });
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
    expect(h.sent.some((c) => c.action === "freischalten")).toBe(false);
    expect((await listChoices()).filter((c) => c.ref === ID && c.state === "open").map((c) => c.action)).toEqual(["fortsetzen"]);
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(false);
    // Ein vollständiger Lauf mit einem durchgefallenen Test bietet den Knopf danach schon
    runs.shape = ([first, ...rest]) => [failedRun(first!), ...rest.map((id) => providerRun(id, "passed"))];
    await click(h, h.sent.at(-1)!, "weiter");
    expect(readRecord(h, ID).phase).toBe("durchgefallen");
    expect(h.sent.at(-1)!.action).toBe("freischalten");
  });

  test("Neustart nach dem Speichern, bevor die Übernahme vermerkt war: Erneut versuchen erkennt die eigene Fassung", async () => {
    const h = wired();
    await toApproval(h);
    // Zustand nach einem Absturz direkt nach saveRecipe: Rezept gespeichert, uebernommen fehlt
    const record = readRecord(h, ID);
    await saveRecipe(record.rezept, { ...h.paths, voices: {} });
    patchRecord(h, ID, (r) => ((r.phase = "anlegen"), delete r.choiceId));
    off.splice(0).forEach((stop) => stop());
    const after = h.restart();
    off.push(onChoiceDecided("sprachagent", after.handler));
    await after.resume();
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
    await click(h, h.sent.at(-1)!, "weiter");
    await after.settled();
    expect(h.notes.some((n) => n.text === DRAFT_TEXT.taken("kochhilfe") || n.text === DRAFT_TEXT.stale("kochhilfe"))).toBe(false);
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
    expect(readRecord(h, ID)).toMatchObject({ phase: "fertig", uebernommen: { version: 1 } });
    expect(readdirSync(join(h.paths.dataDir, "kochhilfe", "versionen"))).toEqual(["1.json"]);
    expect(methods(h).filter((m) => m === "deploy")).toHaveLength(1);
  });

  test("Neustart nach dem Speichern einer Änderung: die eigene Fassung gilt nicht als veraltet", async () => {
    const h = wired();
    const active = draftRecipe("kochhilfe", (r) => (r.stimme.voiceId = "stimme-1"));
    await saveRecipe(active, { ...h.paths, voices: {} });
    await h.service.startChange("kochhilfe", "kürzer", DM);
    writeOutput(h, ID, { recipe: draftRecipe("kochhilfe", (r) => ((r.stimme.voiceId = "stimme-1"), (r.zweck = "Kürzer"))) });
    h.jobs.finish(h.jobs.last().id);
    await h.service.tick();
    await saveRecipe(readRecord(h, ID).rezept, { ...h.paths, voices: {} });
    patchRecord(h, ID, (r) => ((r.phase = "anlegen"), delete r.choiceId));
    off.splice(0).forEach((stop) => stop());
    const after = h.restart();
    off.push(onChoiceDecided("sprachagent", after.handler));
    await after.resume();
    await click(h, h.sent.at(-1)!, "weiter");
    await after.settled();
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
    expect(readdirSync(join(h.paths.dataDir, "kochhilfe", "versionen")).sort()).toEqual(["1.json", "2.json"]);
  });

  test("Anbieter scheitert beim Anlegen: unterbrochen, Erneut versuchen setzt mit derselben Fassung fort", async () => {
    const h = wired();
    h.layer.deployResult = () => ({ status: "fehler", fehler: "Anbieter nicht erreichbar", vorlaeufig: true, state: null });
    await click(h, await toApproval(h), "anlegen");
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.interrupted("kochhilfe", "Rezept gespeichert, der Anbieter meldet: Anbieter nicht erreichbar"));
    h.layer.deployResult = null;
    await click(h, h.sent.at(-1)!, "weiter");
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
  });

  test("Neustart mitten im Anlegen: unterbrochen gemeldet, nie freigeschaltet, Erneut versuchen angeboten", async () => {
    const h = wired();
    await toApproval(h);
    patchRecord(h, ID, (record) => ((record.phase = "anlegen"), delete record.choiceId));
    off.splice(0).forEach((stop) => stop());
    const after = h.restart();
    off.push(onChoiceDecided("sprachagent", after.handler));
    await after.resume();
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.interrupted("kochhilfe", DRAFT_TEXT.restartInterrupted));
    expect(h.sent.at(-1)!.action).toBe("fortsetzen");
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
  });
});

describe("Vorbedingung und Speichern in einem Schritt", () => {
  test("zwei gleichzeitige Übernahmen derselben neuen Kennung: genau eine speichert, die andere ändert nichts", async () => {
    const h = wired();
    const rezept = { ...draftRecipe(), stimme: { art: "bibliothek", modell: "eleven_flash_v2_5", tempo: 1, voiceId: "stimme-1" } };
    const absent = (active: { recipe: unknown; broken: boolean }) => (active.recipe || active.broken ? { text: "vergeben", grund: "Kennung vergeben" } : null);
    const results = await Promise.allSettled([
      saveRecipe(rezept, { ...h.paths, voices: {}, guard: absent }),
      saveRecipe({ ...rezept, zweck: "Andere Fassung" }, { ...h.paths, voices: {}, guard: absent }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(SaveRefused);
    expect(readdirSync(join(h.paths.dataDir, "kochhilfe", "versionen"))).toEqual(["1.json"]);
  });

  test("Bestätigung und gleichzeitige Übernahme derselben Kennung: genau eine gewinnt, Deploy, Tests und Freischaltung gehören zur gespeicherten Fassung", async () => {
    const h = wired();
    const choice = await toApproval(h);
    const other = { ...draftRecipe(), zweck: "Andere Übernahme", stimme: { art: "bibliothek", modell: "eleven_flash_v2_5", tempo: 1, voiceId: "stimme-9" } };
    const absent = (active: { recipe: unknown; broken: boolean }) => (active.recipe || active.broken ? { text: "vergeben", grund: "Kennung vergeben" } : null);
    const [, competing] = await Promise.allSettled([click(h, choice, "anlegen"), saveRecipe(other, { ...h.paths, voices: {}, guard: absent })]);
    await h.service.settled();
    const active = JSON.parse(readFileSync(recipeFile(h), "utf8"));
    expect(readdirSync(join(h.paths.dataDir, "kochhilfe", "versionen"))).toEqual(["1.json"]);
    if (competing.status === "fulfilled") {
      // Die andere Übernahme war zuerst: der Entwurf ändert nichts, kein Deploy
      expect(active.zweck).toBe("Andere Übernahme");
      expect(readRecord(h, ID).phase).toBe("abgebrochen");
      expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.taken("kochhilfe"));
      expect(h.layer.calls).toEqual([]);
    } else {
      expect(competing.reason).toBeInstanceOf(SaveRefused);
      expect(recipeHash(active)).toBe(readRecord(h, ID).rezeptHash);
      expect((await readUnlock("kochhilfe", h.paths))!.hash).toBe(recipeHash(active));
      expect(methods(h).filter((m) => m === "deploy")).toHaveLength(1);
    }
  });

  test("zwei Entwürfe derselben Kennung, beide bestätigt: der zweite bekommt nie eine Freigabe, genau eine Übernahme mit einem Deploy", async () => {
    const h = wired();
    await h.service.startNew("Kochhilfe eins", DM);
    await h.service.startNew("Kochhilfe zwei", DM);
    const [a, b] = ["20261107-090001-a1b2c3", "20261107-090002-a1b2c3"];
    writeOutput(h, a, { recipe: draftRecipe() });
    writeOutput(h, b, { recipe: draftRecipe() });
    for (const job of [...h.jobs.starts]) h.jobs.finish(job.id);
    await Promise.all([h.service.tick(), h.service.tick()]);
    const approvals = h.sent.filter((c) => c.action === "freigabe");
    expect(approvals).toHaveLength(1);
    // Beide Nutzer bestätigen: der eine die Freigabe, der andere eine nachgemachte Frage für den zweiten Entwurf
    const winner = approvals[0]!.ref!;
    const loser = winner === a ? b : a;
    await Promise.all([
      click(h, approvals[0]!, "anlegen"),
      h.service.handler({ ...approvals[0]!, id: "NachgemachteFrage", ref: loser, state: "done", result: { key: "anlegen", label: "Anlegen", via: "web", at: Date.now() } }),
    ]);
    await h.service.settled();
    expect(methods(h).filter((m) => m === "deploy")).toHaveLength(1);
    expect(readRecord(h, winner).phase).toBe("fertig");
    expect(readRecord(h, loser).phase).toBe("job");
    expect(readdirSync(join(h.paths.dataDir, "kochhilfe", "versionen"))).toEqual(["1.json"]);
  });
});

describe("Erreichbarkeit beim Anbieter", () => {
  async function changeToApproval(h: DraftHarness): Promise<Choice> {
    const active = draftRecipe("kochhilfe", (r) => (r.stimme.voiceId = "stimme-1"));
    await saveRecipe(active, { ...h.paths, voices: {} });
    await updateState("kochhilfe", { kennung: "kochhilfe", anbieter: "elevenlabs", agentId: "agent-kochhilfe" } as any, h.paths);
    await h.service.startChange("kochhilfe", "kürzer", DM);
    writeOutput(h, ID, { recipe: draftRecipe("kochhilfe", (r) => ((r.stimme.voiceId = "stimme-1"), (r.zweck = "Kürzer"))) });
    h.jobs.finish(h.jobs.last().id);
    await h.service.tick();
    return h.sent.at(-1)!;
  }

  test("aendern eines Agenten mit Telefonnummer beim Anbieter: nichts gespeichert, nichts beim Anbieter geändert, Meldung sagt es", async () => {
    const h = wired();
    const choice = await changeToApproval(h);
    expect(choice.text).toContain(DRAFT_TEXT.changeReach("kochhilfe"));
    expect(choice.text).not.toContain("Link und Nummer sind gesperrt");
    h.layer.reachableResult = { status: "ok", erreichbar: true };
    await click(h, choice, "anlegen");
    expect(JSON.parse(readFileSync(recipeFile(h), "utf8")).zweck).not.toBe("Kürzer");
    expect(readdirSync(join(h.paths.dataDir, "kochhilfe", "versionen"))).toEqual(["1.json"]);
    expect(methods(h)).toEqual(["reachable"]);
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.reachable("kochhilfe"));
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
    // Nach dem Lösen der Zuordnung geht es weiter, mit dem Schutz auch beim Schreiben
    h.layer.reachableResult = { status: "ok", erreichbar: false };
    await click(h, h.sent.at(-1)!, "weiter");
    expect(JSON.parse(readFileSync(recipeFile(h), "utf8")).zweck).toBe("Kürzer");
    expect(h.layer.deployOptions.at(-1)).toEqual({ nurOhneZuordnung: true, standPruefen: true });
  });

  test("Erreichbarkeit nicht prüfbar: nichts übernommen", async () => {
    const h = wired();
    const choice = await changeToApproval(h);
    h.layer.reachableResult = { status: "fehler", fehler: "Zeitablauf", vorlaeufig: true };
    await click(h, choice, "anlegen");
    expect(readdirSync(join(h.paths.dataDir, "kochhilfe", "versionen"))).toEqual(["1.json"]);
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.reachUnknown("kochhilfe", "Zeitablauf"));
  });

  test("echte Sprachschicht: Nummer am Agenten verhindert jeden Schreibaufruf beim Anbieter", async () => {
    const { h, fake } = withProvider();
    // Agent anlegen wie /sprachagent nach einer früheren Übernahme, Tests bestanden
    const choice0 = await toApproval(h);
    await click(h, choice0, "anlegen");
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
    const agentId = [...fake.agents.keys()][0]!;
    Object.assign(fake.agents.get(agentId), { phone_numbers: [{ phone_number_id: "nummer_1" }] });
    await h.service.startChange("kochhilfe", "kürzer", DM);
    const id = "20261107-090002-a1b2c3";
    const saved = JSON.parse(readFileSync(recipeFile(h), "utf8"));
    writeOutput(h, id, { recipe: { ...saved, zweck: "Kürzer" } });
    h.jobs.finish(h.jobs.last().id);
    await h.service.tick();
    fake.calls = [];
    await click(h, h.sent.at(-1)!, "anlegen");
    expect(fake.writes()).toEqual([]);
    expect(JSON.parse(readFileSync(recipeFile(h), "utf8")).zweck).not.toBe("Kürzer");
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
  });
});

describe("Vollständigkeit des Testlaufs (Prüferpunkt Runde 2)", () => {
  test("coversRequested: jede angeforderte Test-ID genau einmal, keine fremde", () => {
    expect(coversRequested(["a", "b", "c"], [{ testId: "c" }, { testId: "a" }, { testId: "b" }])).toBe(true);
    expect(coversRequested(["a", "b", "c"], [{ testId: "a" }])).toBe(false);
    expect(coversRequested(["a", "b", "c"], [{ testId: "a" }, { testId: "a" }, { testId: "b" }])).toBe(false);
    expect(coversRequested(["a", "b", "c"], [{ testId: "a" }, { testId: "b" }, { testId: "x" }])).toBe(false);
    expect(coversRequested(["a", "b"], [{ testId: "a" }, { testId: "b" }, { testId: "b" }])).toBe(false);
    expect(coversRequested([], [])).toBe(false);
  });

  const t = (testId: string, status: "bestanden" | "durchgefallen") => ({ testId, name: testId, status });
  const cases = [
    ["fehlende", [t("t1", "bestanden")], [t("t1", "durchgefallen")]],
    ["doppelte", [t("t1", "bestanden"), t("t1", "bestanden"), t("t2", "bestanden")], [t("t1", "durchgefallen"), t("t1", "durchgefallen"), t("t2", "bestanden")]],
    ["fremde", [t("t1", "bestanden"), t("t2", "bestanden"), t("t9", "bestanden")], [t("t1", "durchgefallen"), t("t2", "bestanden"), t("t9", "bestanden")]],
  ] as const;

  for (const [label, passed, failed] of cases) {
    test(`${label} Test-IDs, alle Ergebnisse bestanden: nicht freigeschaltet, Erneut versuchen`, async () => {
      const h = wired();
      h.layer.testIds = ["t1", "t2", "t3"];
      h.layer.result = { status: "fertig", gesamt: "bestanden", tests: [...passed] };
      await click(h, await toApproval(h), "anlegen");
      expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
      expect(readRecord(h, ID).phase).toBe("unterbrochen");
      expect(h.notes.some((n) => n.text === DRAFT_TEXT.interrupted("kochhilfe", DRAFT_TEXT.incompleteRun))).toBe(true);
      expect(h.sent.at(-1)!.action).toBe("fortsetzen");
    });

    test(`${label} Test-IDs mit durchgefallenem Test: kein Trotzdem-Knopf, nicht freigeschaltet`, async () => {
      const h = wired();
      h.layer.testIds = ["t1", "t2", "t3"];
      h.layer.result = { status: "fertig", gesamt: "durchgefallen", tests: [...failed] };
      await click(h, await toApproval(h), "anlegen");
      expect(readRecord(h, ID)).toMatchObject({ phase: "unterbrochen" });
      expect(readRecord(h, ID).testlauf).toBeUndefined();
      expect(h.sent.some((c) => c.action === "freischalten")).toBe(false);
      expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    });
  }

  test("alle drei angeforderten Tests in anderer Reihenfolge bestanden: freigeschaltet", async () => {
    const h = wired();
    h.layer.testIds = ["t1", "t2", "t3"];
    h.layer.result = { status: "fertig", gesamt: "bestanden", tests: [t("t3", "bestanden"), t("t1", "bestanden"), t("t2", "bestanden")] };
    await click(h, await toApproval(h), "anlegen");
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
  });

  test("echte Sprachschicht: alle Tests angefordert, nur ein bestandenes Ergebnis zurück, nicht freigeschaltet", async () => {
    const { h, fake, runs } = withProvider();
    runs.shape = ([first]) => [providerRun(first!, "passed")];
    await click(h, await toApproval(h), "anlegen");
    expect(fake.of("POST", /\/run-tests$/).at(-1)!.body.tests.length).toBeGreaterThan(1);
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(false);
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
    expect(h.sent.some((c) => c.action === "freischalten")).toBe(false);
  });

  test("echte Sprachschicht: durchgefallener Test, ein angeforderter fehlt: kein Trotzdem-Knopf", async () => {
    const { h, runs } = withProvider();
    runs.shape = ([first]) => [failedRun(first!)];
    await click(h, await toApproval(h), "anlegen");
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
    expect(h.sent.some((c) => c.action === "freischalten")).toBe(false);
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
  });
});

describe("ohne Sprachschicht (Prüferpunkt Runde 2)", () => {
  test("aendern eines bestehenden Brückenagenten ohne Schlüssel: Rezept, Versionen und Freischaltung unverändert, Erneut versuchen angeboten", async () => {
    const h = wired({ withLayer: false });
    const bridge = (change: (r: any) => void = () => {}) =>
      draftRecipe("kochhilfe", (r) => ((r.gehirn = { art: "bruecke", modell: "claude-opus-5-5" }), (r.stimme.voiceId = "stimme-1"), change(r)));
    const saved = await saveRecipe(bridge(), { ...h.paths, voices: {} });
    await updateState("kochhilfe", { kennung: "kochhilfe", anbieter: "elevenlabs", agentId: "agent-kochhilfe" } as any, h.paths);
    await writeUnlock("kochhilfe", { hash: saved.hash, version: 1, wissenHash: null, grund: "tests" }, h.paths);
    const before = { recipe: readFileSync(recipeFile(h), "utf8"), unlock: await readUnlock("kochhilfe", h.paths) };
    await h.service.startChange("kochhilfe", "kürzer", DM);
    writeOutput(h, ID, { recipe: bridge((r) => (r.zweck = "Kürzer")) });
    h.jobs.finish(h.jobs.last().id);
    await h.service.tick();
    await click(h, h.sent.at(-1)!, "anlegen");
    expect(readFileSync(recipeFile(h), "utf8")).toBe(before.recipe);
    expect(readdirSync(join(h.paths.dataDir, "kochhilfe", "versionen"))).toEqual(["1.json"]);
    expect(await readUnlock("kochhilfe", h.paths)).toEqual(before.unlock);
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
    expect(readRecord(h, ID)).toMatchObject({ phase: "unterbrochen" });
    expect(readRecord(h, ID).uebernommen).toBeUndefined();
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.reachUnknown("kochhilfe", DRAFT_TEXT.noLayer));
    expect(h.sent.at(-1)).toMatchObject({ action: "fortsetzen", options: [{ key: "weiter" }, { key: "verwerfen" }] });
    // Weiterhin ohne Schlüssel: auch Erneut versuchen übernimmt nichts
    await click(h, h.sent.at(-1)!, "weiter");
    expect(readFileSync(recipeFile(h), "utf8")).toBe(before.recipe);
    expect(readdirSync(join(h.paths.dataDir, "kochhilfe", "versionen"))).toEqual(["1.json"]);
  });
});

describe("Handänderung beim Anbieter zwischen zwei Versuchen (Prüferpunkt Runde 2)", () => {
  test("echte Sprachschicht: Deploy gelingt, Testabfrage scheitert, erster Satz von Hand geändert: Erneut versuchen schaltet nicht frei und meldet die Abweichung", async () => {
    const { h, fake, runs } = withProvider();
    runs.shape = null;
    await click(h, await toApproval(h), "anlegen");
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(false);
    const agentId = [...fake.agents.keys()][0]!;
    fake.agents.get(agentId).conversation_config.agent.first_message = "Von Hand geändert";
    runs.shape = (ids) => ids.map((id) => providerRun(id, "passed"));
    fake.calls = [];
    await click(h, h.sent.at(-1)!, "weiter");
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(false);
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
    const note = h.notes.find((n) => n.text.includes("beim Anbieter nicht übernommen"))!;
    expect(note.text).toContain("Agent kochhilfe wurde beim Anbieter geändert (erster Satz)");
    expect(h.sent.at(-1)!.action).toBe("fortsetzen");
    // Nichts überschrieben, kein Testlauf
    expect(fake.writes()).toEqual([]);
    expect(fake.agents.get(agentId).conversation_config.agent.first_message).toBe("Von Hand geändert");
    // Nach dem Zurücknehmen beim Anbieter geht es weiter
    fake.agents.get(agentId).conversation_config.agent.first_message = "Was liegt an?";
    await click(h, h.sent.at(-1)!, "weiter");
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
  });

  test("echte Sprachschicht: ohne Handänderung setzt Erneut versuchen mit unverändertem Agenten fort", async () => {
    const { h, fake, runs } = withProvider();
    runs.shape = null;
    await click(h, await toApproval(h), "anlegen");
    runs.shape = (ids) => ids.map((id) => providerRun(id, "passed"));
    fake.calls = [];
    await click(h, h.sent.at(-1)!, "weiter");
    expect(fake.of("PATCH", /^\/agents\//)).toEqual([]);
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
  });
});

describe("unlesbare Erreichbarkeit beim Brückenagenten (Prüferpunkt Runde 3)", () => {
  const bridgeDraft = (change: (r: any) => void = () => {}) => draftRecipe("kochhilfe", (r) => ((r.gehirn = { art: "bruecke", modell: "claude-opus-5-5" }), change(r)));
  const strip = (agent: any, key: string) => Object.fromEntries(Object.entries(agent).filter(([k]) => k !== key));
  const answers: [string, (agent: any) => Response][] = [
    ["ungültiges JSON", () => new Response("{kaputt", { status: 200 })],
    ["leere Antwort", () => new Response("", { status: 200 })],
    ["{}", () => jsonResponse({})],
    ["Telefonnummern als Text", (agent) => jsonResponse({ ...agent, phone_numbers: "nummer_1" })],
    ["WhatsApp-Konten als Objekt", (agent) => jsonResponse({ ...agent, whatsapp_accounts: { wa_1: true } })],
    ["Telefonnummern fehlen", (agent) => jsonResponse(strip(agent, "phone_numbers"))],
  ];

  for (const [label, answer] of answers) {
    test(`echte Sprachschicht, ${label}: Rezept, Versionen und bisherige Freischaltung unverändert, nichts beim Anbieter geschrieben`, async () => {
      const { h, fake } = withProvider(BRIDGE_ENV);
      await click(h, await toApproval(h, { recipe: bridgeDraft() }), "anlegen");
      expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
      const agentId = [...fake.agents.keys()][0]!;
      const before = { recipe: readFileSync(recipeFile(h), "utf8"), unlock: await readUnlock("kochhilfe", h.paths), agent: structuredClone(fake.agents.get(agentId)) };
      await h.service.startChange("kochhilfe", "kürzer", DM);
      const id = "20261107-090002-a1b2c3";
      writeOutput(h, id, { recipe: { ...JSON.parse(before.recipe), zweck: "Kürzer" } });
      h.jobs.finish(h.jobs.last().id);
      await h.service.tick();
      fake.calls = [];
      fake.override((call) => call.method === "GET" && call.path === `/agents/${agentId}`, () => answer({ agent_id: agentId, ...fake.agents.get(agentId) }), 10);
      await click(h, h.sent.at(-1)!, "anlegen");
      expect(readFileSync(recipeFile(h), "utf8")).toBe(before.recipe);
      expect(readdirSync(join(h.paths.dataDir, "kochhilfe", "versionen"))).toEqual(["1.json"]);
      expect(await readUnlock("kochhilfe", h.paths)).toEqual(before.unlock);
      expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
      expect(readRecord(h, id)).toMatchObject({ phase: "unterbrochen" });
      expect(readRecord(h, id).uebernommen).toBeUndefined();
      expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.reachUnknown("kochhilfe", "Antwort des Anbieters unlesbar: Zuordnungen des Agenten"));
      expect(h.sent.at(-1)!.action).toBe("fortsetzen");
      expect(fake.writes()).toEqual([]);
      expect(fake.agents.get(agentId)).toEqual(before.agent);
    });
  }

  test("echte Sprachschicht, lesbare leere Zuordnungen: die Änderung geht durch", async () => {
    const { h, fake } = withProvider(BRIDGE_ENV);
    await click(h, await toApproval(h, { recipe: bridgeDraft() }), "anlegen");
    await h.service.startChange("kochhilfe", "kürzer", DM);
    writeOutput(h, "20261107-090002-a1b2c3", { recipe: { ...JSON.parse(readFileSync(recipeFile(h), "utf8")), zweck: "Kürzer" } });
    h.jobs.finish(h.jobs.last().id);
    await h.service.tick();
    await click(h, h.sent.at(-1)!, "anlegen");
    expect(JSON.parse(readFileSync(recipeFile(h), "utf8")).zweck).toBe("Kürzer");
    expect(fake.of("PATCH", /^\/agents\//)).toHaveLength(1);
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
  });
});

describe("Freischaltung nur im getesteten Stand beim Anbieter (Prüferpunkt Runde 3)", () => {
  const agentOf = (fake: FakeElevenLabs) => fake.agents.get([...fake.agents.keys()][0]!);

  test("echte Sprachschicht: vollständiger Lauf durchgefallen, erster Satz von Hand geändert, Trotzdem freischalten: nicht freigeschaltet, ohne Schreibaufruf, Meldung", async () => {
    const { h, fake, runs } = withProvider();
    runs.shape = (ids) => ids.map(failedRun);
    await click(h, await toApproval(h), "anlegen");
    expect(readRecord(h, ID).phase).toBe("durchgefallen");
    const ask = h.sent.at(-1)!;
    expect(ask.action).toBe("freischalten");
    agentOf(fake).conversation_config.agent.first_message = "Von Hand geändert";
    fake.calls = [];
    await click(h, ask, "freischalten");
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(false);
    expect(readRecord(h, ID).phase).toBe("fertig");
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.unlockRefused("kochhilfe", DRAFT_TEXT.standChanged(["erster Satz"])));
    // Nur gelesen, nichts geschrieben, kein weiterer Testlauf
    expect(fake.of("GET", /^\/agents\//)).toHaveLength(1);
    expect(fake.writes()).toEqual([]);
    expect(agentOf(fake).conversation_config.agent.first_message).toBe("Von Hand geändert");
  });

  test("echte Sprachschicht: Trotzdem freischalten ohne Handänderung schaltet frei", async () => {
    const { h, runs } = withProvider();
    runs.shape = (ids) => ids.map(failedRun);
    await click(h, await toApproval(h), "anlegen");
    await click(h, h.sent.at(-1)!, "freischalten");
    expect(await readUnlock("kochhilfe", h.paths)).toMatchObject({ grund: "trotzdem", version: 1 });
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.unlocked("kochhilfe"));
  });

  test("echte Sprachschicht: Trotzdem freischalten, Stand beim Anbieter nicht lesbar: nicht freigeschaltet, Meldung", async () => {
    const { h, fake, runs } = withProvider();
    runs.shape = (ids) => ids.map(failedRun);
    await click(h, await toApproval(h), "anlegen");
    fake.override((call) => call.method === "GET" && /^\/agents\/[^/]+$/.test(call.path), () => jsonResponse({ detail: "kaputt" }, 500), 10);
    await click(h, h.sent.at(-1)!, "freischalten");
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(readRecord(h, ID).phase).toBe("fertig");
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.unlockRefused("kochhilfe", DRAFT_TEXT.standUnknown('HTTP 500: {"detail":"kaputt"}')));
  });

  test("Trotzdem freischalten ohne festgehaltenen Stand (Entwurf von vorher): nicht freigeschaltet", async () => {
    const h = wired();
    h.layer.result = { status: "fertig", gesamt: "durchgefallen", tests: [{ testId: "t1", name: "Notfall", status: "durchgefallen" }] };
    await click(h, await toApproval(h), "anlegen");
    patchRecord(h, ID, (record) => {
      delete record.testlauf.stand;
    });
    await click(h, h.sent.at(-1)!, "freischalten");
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.unlockRefused("kochhilfe", DRAFT_TEXT.standUnknown("vom Testlauf ist kein Stand festgehalten")));
    expect(methods(h)).not.toContain("compareStand");
  });

  test("echte Sprachschicht: erster Satz während des Testlaufs geändert, alle Tests bestanden: nicht freigeschaltet, Erneut versuchen meldet die Handänderung", async () => {
    const { h, fake, runs } = withProvider();
    runs.shape = (ids) => {
      agentOf(fake).conversation_config.agent.first_message = "Während des Laufs geändert";
      return ids.map((id) => providerRun(id, "passed"));
    };
    await click(h, await toApproval(h), "anlegen");
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(false);
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.interrupted("kochhilfe", DRAFT_TEXT.standChanged(["erster Satz"])));
    expect(h.sent.at(-1)!.action).toBe("fortsetzen");
    expect(agentOf(fake).conversation_config.agent.first_message).toBe("Während des Laufs geändert");
    // Erneut versuchen überschreibt nichts und schaltet nicht frei
    runs.shape = (ids) => ids.map((id) => providerRun(id, "passed"));
    fake.calls = [];
    await click(h, h.sent.at(-1)!, "weiter");
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(fake.writes()).toEqual([]);
  });

  test("echte Sprachschicht: Stand nach bestandenem Lauf nicht lesbar: nicht freigeschaltet", async () => {
    const { h, fake, runs } = withProvider();
    runs.shape = (ids) => {
      fake.override((call) => call.method === "GET" && /^\/agents\/[^/]+$/.test(call.path), () => new Response("{kaputt", { status: 200 }), 10);
      return ids.map((id) => providerRun(id, "passed"));
    };
    await click(h, await toApproval(h), "anlegen");
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.interrupted("kochhilfe", DRAFT_TEXT.standUnknown("Antwort des Anbieters unlesbar: Agent")));
  });

  test("deploy ohne bestätigten Stand: kein Testlauf, nicht freigeschaltet", async () => {
    const h = wired();
    h.layer.deployResult = (recipe) => ({ status: "unveraendert", state: { kennung: recipe.kennung, anbieter: "elevenlabs", agentId: "agent-kochhilfe" } as any, hinweise: [] });
    await click(h, await toApproval(h), "anlegen");
    expect(methods(h)).toEqual(["deploy"]);
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
  });
});

describe("Freischaltung an den Inhalt der Wissensdatei gebunden (Prüferpunkt Runde 4)", () => {
  const bridgeExpert = () => expertRecipe("segel-trainer", (r) => (r.gehirn = { art: "bruecke", modell: "claude-opus-5-5" }));
  const knowledgeSha = (text: string) => createHash("sha256").update(text).digest("hex");
  /** Die aktive Wissensdatei, auf die das gespeicherte Rezept zeigt */
  const activeKnowledge = (h: DraftHarness) => {
    const saved = JSON.parse(readFileSync(recipeFile(h, "segel-trainer"), "utf8"));
    return join(h.paths.dataDir, "segel-trainer", saved.wissen.datei.split("/").at(-1));
  };
  const failed = { status: "fertig", gesamt: "durchgefallen", tests: [{ testId: "t1", name: "Notfall", status: "durchgefallen" }] } as const;

  test("Brücken-Experte, unverändertes Wissen: bestandener Lauf schaltet frei, mit dem Hash des Wissens", async () => {
    const h = wired();
    await click(h, await toApproval(h, { recipe: bridgeExpert(), knowledge: GOOD_KNOWLEDGE }), "anlegen");
    expect(await readUnlock("segel-trainer", h.paths)).toMatchObject({ grund: "tests", wissenHash: knowledgeSha(GOOD_KNOWLEDGE) });
    expect(await isUnlocked("segel-trainer", h.paths)).toBe(true);
  });

  test("Brücken-Experte: Wissensdatei während des Laufs geändert, alle Tests bestanden: nicht freigeschaltet", async () => {
    const h = wired();
    h.layer.result = async () => {
      writeFileSync(activeKnowledge(h), GOOD_KNOWLEDGE + "\nUngeprüfter Zusatz.\n");
      return { status: "fertig", gesamt: "bestanden", tests: [{ testId: "t1", name: "Notfall", status: "bestanden" }] };
    };
    await click(h, await toApproval(h, { recipe: bridgeExpert(), knowledge: GOOD_KNOWLEDGE }), "anlegen");
    expect(await readUnlock("segel-trainer", h.paths)).toBeNull();
    expect(await isUnlocked("segel-trainer", h.paths)).toBe(false);
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
  });

  test("Brücken-Experte: Wissensdatei während des Laufs gelöscht: nicht freigeschaltet", async () => {
    const h = wired();
    h.layer.result = async () => {
      unlinkSync(activeKnowledge(h));
      return { status: "fertig", gesamt: "bestanden", tests: [{ testId: "t1", name: "Notfall", status: "bestanden" }] };
    };
    await click(h, await toApproval(h, { recipe: bridgeExpert(), knowledge: GOOD_KNOWLEDGE }), "anlegen");
    expect(await readUnlock("segel-trainer", h.paths)).toBeNull();
    expect(readRecord(h, ID).phase).toBe("unterbrochen");
  });

  test("Brücken-Experte: Wissensdatei vor dem Klick auf Trotzdem freischalten geändert: nicht freigeschaltet, Meldung", async () => {
    const h = wired();
    h.layer.result = failed;
    await click(h, await toApproval(h, { recipe: bridgeExpert(), knowledge: GOOD_KNOWLEDGE }), "anlegen");
    expect(readRecord(h, ID).testlauf).toMatchObject({ wissenHash: knowledgeSha(GOOD_KNOWLEDGE) });
    writeFileSync(activeKnowledge(h), GOOD_KNOWLEDGE.replace("Wind kommt von vorn.", "Wind kommt von hinten."));
    await click(h, h.sent.at(-1)!, "freischalten");
    expect(await readUnlock("segel-trainer", h.paths)).toBeNull();
    expect(await isUnlocked("segel-trainer", h.paths)).toBe(false);
    expect(readRecord(h, ID).phase).toBe("fertig");
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.unlockStale("segel-trainer"));
  });

  test("Brücken-Experte: Wissensdatei vor dem Klick auf Trotzdem freischalten gelöscht: nicht freigeschaltet", async () => {
    const h = wired();
    h.layer.result = failed;
    await click(h, await toApproval(h, { recipe: bridgeExpert(), knowledge: GOOD_KNOWLEDGE }), "anlegen");
    unlinkSync(activeKnowledge(h));
    await click(h, h.sent.at(-1)!, "freischalten");
    expect(await readUnlock("segel-trainer", h.paths)).toBeNull();
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.unlockStale("segel-trainer"));
  });

  test("Brücken-Experte: Trotzdem freischalten mit unverändertem Wissen schaltet frei", async () => {
    const h = wired();
    h.layer.result = failed;
    await click(h, await toApproval(h, { recipe: bridgeExpert(), knowledge: GOOD_KNOWLEDGE }), "anlegen");
    await click(h, h.sent.at(-1)!, "freischalten");
    expect(await readUnlock("segel-trainer", h.paths)).toMatchObject({ grund: "trotzdem", wissenHash: knowledgeSha(GOOD_KNOWLEDGE) });
    expect(await isUnlocked("segel-trainer", h.paths)).toBe(true);
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.unlocked("segel-trainer"));
  });

  test("Trotzdem freischalten ohne festgehaltenen Wissenshash (Entwurf von vorher): nicht freigeschaltet", async () => {
    const h = wired();
    h.layer.result = failed;
    await click(h, await toApproval(h), "anlegen");
    patchRecord(h, ID, (record) => {
      delete record.testlauf.wissenHash;
    });
    await click(h, h.sent.at(-1)!, "freischalten");
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.unlockStale("kochhilfe"));
  });

  test("Brücken-Experte: Wissensdatei nach erfolgreicher Freischaltung geändert, gelöscht oder unlesbar: nicht mehr freigeschaltet; zurück im geprüften Inhalt wieder gültig", async () => {
    const h = wired();
    await click(h, await toApproval(h, { recipe: bridgeExpert(), knowledge: GOOD_KNOWLEDGE }), "anlegen");
    const path = activeKnowledge(h);
    expect(await isUnlocked("segel-trainer", h.paths)).toBe(true);
    writeFileSync(path, GOOD_KNOWLEDGE + "\nNachträglich ergänzt.\n");
    expect(await isUnlocked("segel-trainer", h.paths)).toBe(false);
    unlinkSync(path);
    expect(await isUnlocked("segel-trainer", h.paths)).toBe(false);
    // Unlesbar: ein Verzeichnis statt der Datei, dann ein Symlink auf eine Datei mit gleichem Inhalt
    mkdirSync(path);
    expect(await isUnlocked("segel-trainer", h.paths)).toBe(false);
    rmdirSync(path);
    const elsewhere = join(h.root, "fremd.md");
    writeFileSync(elsewhere, GOOD_KNOWLEDGE);
    symlinkSync(elsewhere, path);
    expect(await isUnlocked("segel-trainer", h.paths)).toBe(false);
    unlinkSync(path);
    writeFileSync(path, GOOD_KNOWLEDGE);
    expect(await isUnlocked("segel-trainer", h.paths)).toBe(true);
  });

  test("writeUnlock: anderer erwarteter Wissenshash, fehlende Datei oder Wissenshash bei einem Rezept ohne Wissen: veraltet", async () => {
    const h = wired();
    await click(h, await toApproval(h, { recipe: bridgeExpert(), knowledge: GOOD_KNOWLEDGE }), "anlegen");
    const { hash, version } = (await readUnlock("segel-trainer", h.paths))!;
    expect(await writeUnlock("segel-trainer", { hash, version, wissenHash: "0".repeat(64), grund: "trotzdem" }, h.paths)).toEqual({ status: "veraltet" });
    expect(await writeUnlock("segel-trainer", { hash, version, wissenHash: null, grund: "trotzdem" }, h.paths)).toEqual({ status: "veraltet" });
    unlinkSync(activeKnowledge(h));
    expect(await writeUnlock("segel-trainer", { hash, version, wissenHash: knowledgeSha(GOOD_KNOWLEDGE), grund: "trotzdem" }, h.paths)).toEqual({ status: "veraltet" });
    const plain = await saveRecipe(draftRecipe("ohne-wissen", (r) => (r.stimme.voiceId = "stimme-1")), { ...h.paths, voices: {} });
    expect(await writeUnlock("ohne-wissen", { hash: plain.hash, version: plain.version, wissenHash: knowledgeSha(GOOD_KNOWLEDGE), grund: "tests" }, h.paths)).toEqual({ status: "veraltet" });
    expect(await writeUnlock("ohne-wissen", { hash: plain.hash, version: plain.version, wissenHash: null, grund: "tests" }, h.paths)).toMatchObject({ status: "freigeschaltet" });
    expect(await isUnlocked("ohne-wissen", h.paths)).toBe(true);
  });
});

describe("ein Handler für die Art sprachagent", () => {
  test("Löschen bleibt beim Manager, Entwurfsschritte gehen an den Entwurfsdienst", async () => {
    const h = wired();
    const choice = await toApproval(h);
    const deleteChoice = { ...choice, id: "Loeschen001", action: "loeschen", ref: "jarvis", state: "done" as const, result: { key: "ja", label: "Ja", via: "telegram" as const, at: Date.now() } };
    await voiceAgentChoiceHandler(async (c) => void managerCalls.push(c), h.service)(deleteChoice);
    expect(managerCalls.map((c) => c.id)).toEqual(["Loeschen001"]);
    await click(h, choice, "verwerfen");
    expect(managerCalls).toHaveLength(1);
  });
});
