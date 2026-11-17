/**
 * Issue #493, Prüferpunkt Runde 2: Rückfragen der Entwürfe laufen nach drei
 * Tagen ab. Danach endet der Entwurf kontrolliert (abgebrochen), die Kennung ist
 * wieder frei, nichts wird freigeschaltet, und der Nutzer erfährt den Weg
 * zurück. Vorgestellte Uhr per setSystemTime; Rückfragen-Register mit eigener
 * Datei, Jobs und Sprachschicht als Attrappen, kein Anbieteraufruf.
 */
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { join } from "node:path";
import { decideChoice, onChoiceDecided, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { DRAFT_CHOICE_TTL_MS, DRAFT_TEXT } from "../src/lib/voice-agents/drafts";
import { saveRecipe } from "../src/lib/voice-agents/recipe";
import { isUnlocked, readUnlock } from "../src/lib/voice-agents/unlock";
import { DM, draftHarness, draftRecipe, readRecord, removeDraftDirs, writeOutput, type DraftHarness } from "./voice-agents-drafts-fixture";

const ID = "20261107-090001-a1b2c3";
let counter = 0;
let off: (() => void)[] = [];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  setSystemTime(new Date("2026-11-07T09:00:00Z"));
  const h = draftHarness();
  setChoicesFileForTests(join(h.root, `choices-${++counter}.json`));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const stop of off.splice(0)) stop();
  logSpy.mockRestore();
  setSystemTime();
});
afterAll(() => {
  setChoicesFileForTests(null);
  removeDraftDirs();
});

function wired(options: Parameters<typeof draftHarness>[0] = {}): DraftHarness {
  const h = draftHarness(options);
  off.push(onChoiceDecided("sprachagent", (choice) => h.service.handler(choice)));
  return h;
}

async function click(h: DraftHarness, choice: Choice, key: string) {
  const outcome = await decideChoice(choice.id, key, "telegram");
  await h.service.settled();
  return outcome;
}

/** Uhr über die Frist der Rückfragen stellen */
function lapse(): void {
  setSystemTime(new Date(Date.now() + DRAFT_CHOICE_TTL_MS + 60_000));
}

/** Neustart: neuer Dienst auf demselben Ordner, resume wie beim Start des Bots */
async function restart(h: DraftHarness): Promise<void> {
  off.splice(0).forEach((stop) => stop());
  const after = h.restart();
  off.push(onChoiceDecided("sprachagent", after.handler));
  await after.resume();
}

/** Aktiver Agent kochhilfe und ein aendern-Entwurf bis zur ersten Rückfrage */
async function changeToQuestion(h: DraftHarness, voice?: string): Promise<Choice> {
  await saveRecipe(draftRecipe("kochhilfe", (r) => (r.stimme.voiceId = "stimme-1")), { ...h.paths, voices: {} });
  await h.service.startChange("kochhilfe", "kürzer", DM);
  writeOutput(h, ID, { recipe: draftRecipe("kochhilfe", (r) => ((r.stimme.voiceId = "stimme-1"), (r.zweck = "Kürzer"))), ...(voice ? { voice } : {}) });
  h.jobs.finish(h.jobs.last().id);
  await h.service.tick();
  return h.sent.at(-1)!;
}

/** Neuer Agent bis zur Freigabe */
async function newToApproval(h: DraftHarness): Promise<Choice> {
  await h.service.startNew("Eine Kochhilfe", DM);
  writeOutput(h, ID, { recipe: draftRecipe() });
  h.jobs.finish(h.jobs.last().id);
  await h.service.tick();
  return h.sent.at(-1)!;
}

/** Nach dem Ablauf: beendet, gemeldet, keine neue Rückfrage, alter Knopf wirkungslos, aendern geht wieder */
async function expectClosed(h: DraftHarness, old: Choice, expected: { art: "neu" | "aendern"; uebernommen: boolean }) {
  expect(readRecord(h, ID)).toMatchObject({ phase: "abgebrochen", grund: "Rueckfrage abgelaufen" });
  expect(readRecord(h, ID).choiceId).toBeUndefined();
  expect(h.notes.at(-1)!.text).toBe(DRAFT_TEXT.expired({ art: expected.art, kennung: "kochhilfe", uebernommen: expected.uebernommen }));
  expect(h.sent.filter((c) => c.ref === ID).at(-1)!.id).toBe(old.id);
  expect((await click(h, old, old.options[0]!.key)).status).toBe("expired");
  expect(await h.service.startChange("kochhilfe", "noch kürzer", DM)).toMatchObject({ status: "gestartet" });
}

describe("Ablauf der Rückfragen", () => {
  test("Stimmwahl abgelaufen, dann Neustart: Entwurf beendet, Kennung frei, aendern startet", async () => {
    const h = wired();
    h.voices = [{ voiceId: "v-mia", name: "Mia", klon: false }];
    const question = await changeToQuestion(h, "warm und ruhig");
    expect(question.action).toBe("stimme");
    lapse();
    await restart(h);
    await expectClosed(h, question, { art: "aendern", uebernommen: false });
    expect(readRecord(h, ID).rezept!.stimme.voiceId).toBe("stimme-1");
  });

  test("Freigabe abgelaufen, ohne Neustart: der Takt beendet den Entwurf, nichts übernommen", async () => {
    const h = wired();
    const question = await changeToQuestion(h);
    expect(question.action).toBe("freigabe");
    // Vor der Frist bleibt alles offen
    await h.service.tick();
    expect(readRecord(h, ID).phase).toBe("freigabe");
    expect(await h.service.startChange("kochhilfe", "anders", DM)).toEqual({ status: "offen" });
    lapse();
    await h.service.tick();
    await expectClosed(h, question, { art: "aendern", uebernommen: false });
    expect(h.layer.calls).toEqual([]);
  });

  test("Freigabe eines neuen Agenten abgelaufen, dann Neustart: nichts angelegt, Meldung nennt /sprachagent neu", async () => {
    const h = wired();
    const question = await newToApproval(h);
    lapse();
    await restart(h);
    expect(readRecord(h, ID)).toMatchObject({ phase: "abgebrochen" });
    expect(h.notes.at(-1)!.text).toContain("/sprachagent neu <beschreibung>");
    expect((await click(h, question, "anlegen")).status).toBe("expired");
    expect(h.layer.calls).toEqual([]);
  });

  test("Erneut versuchen abgelaufen, dann Neustart: gespeicherte Fassung bleibt gesperrt, aendern startet", async () => {
    const h = wired();
    h.layer.deployResult = () => ({ status: "fehler", fehler: "Anbieter nicht erreichbar", vorlaeufig: true, state: null });
    await click(h, await newToApproval(h), "anlegen");
    const question = h.sent.at(-1)!;
    expect(question.action).toBe("fortsetzen");
    h.layer.deployResult = null;
    lapse();
    await restart(h);
    await expectClosed(h, question, { art: "neu", uebernommen: true });
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
    expect(h.layer.calls.filter((c) => c.method === "deploy")).toHaveLength(1);
  });

  test("Trotzdem freischalten abgelaufen, dann Neustart: nicht freigeschaltet, alter Knopf wirkungslos, aendern startet", async () => {
    const h = wired();
    h.layer.result = { status: "fertig", gesamt: "durchgefallen", tests: [{ testId: "t1", name: "Erster", status: "durchgefallen" }] };
    await click(h, await newToApproval(h), "anlegen");
    const question = h.sent.at(-1)!;
    expect(question.action).toBe("freischalten");
    lapse();
    await restart(h);
    await expectClosed(h, question, { art: "neu", uebernommen: true });
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(false);
    expect(await readUnlock("kochhilfe", h.paths)).toBeNull();
  });

  test("Klick kurz vor der Frist wirkt noch", async () => {
    const h = wired();
    const question = await newToApproval(h);
    setSystemTime(new Date(Date.now() + DRAFT_CHOICE_TTL_MS - 60_000));
    await h.service.tick();
    expect(readRecord(h, ID).phase).toBe("freigabe");
    await click(h, question, "anlegen");
    expect(await isUnlocked("kochhilfe", h.paths)).toBe(true);
  });
});
