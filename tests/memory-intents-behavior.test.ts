/**
 * Issue #316: Verhalten von processIntents, wie es Aufrufer sehen, ohne
 * Attrappen für das Gedächtnis selbst. Geschrieben vor dem Neubau gegen den
 * alten Weg (memory.ts mit lokaler Datei), danach unverändert gegen Dienst
 * und Datei-Adapter. Ohne Datenbank (die Preload-Datei setzt
 * MEMORY_FILE_PATH auf eine Temp-Datei), je Test frisch.
 *
 * Mehrdeutige DONE/CANCEL/FORGET (mehrere Treffer) prüft
 * memory-ambiguity.test.ts; hier nur null und ein Treffer.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { getMemoryContext, listFacts, listGoals, processIntents } from "../src/lib/memory";
import { resetStore } from "../src/lib/store";

const FILE = process.env.MEMORY_FILE_PATH!;
const EMPTY = { goalsAdded: [], goalsCompleted: [], goalsCancelled: [], factsAdded: [], factsRemoved: [] };
let savedZone: string | undefined;
const restores: (() => void)[] = [];

beforeEach(() => {
  rmSync(`${FILE}.sqlite`, { force: true });
  rmSync(FILE, { force: true });
  resetStore();
  savedZone = process.env.USER_TIMEZONE;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const log = spyOn(console, "log").mockImplementation(() => {});
  restores.push(() => warn.mockRestore(), () => log.mockRestore());
});

afterEach(() => {
  setSystemTime();
  while (restores.length) restores.pop()!();
  if (savedZone === undefined) delete process.env.USER_TIMEZONE;
  else process.env.USER_TIMEZONE = savedZone;
  resetStore();
});

/** Ergebnis ohne Felder, die nur mehrdeutige Treffer füllen */
const core = (r: Awaited<ReturnType<typeof processIntents>>) => ({
  goalsAdded: r.goalsAdded,
  goalsCompleted: r.goalsCompleted,
  goalsCancelled: r.goalsCancelled,
  factsAdded: r.factsAdded,
  factsRemoved: r.factsRemoved,
});

describe("processIntents: Anlegen", () => {
  test("ohne Tags: nichts", async () => {
    expect(core(await processIntents("Nur eine Antwort ohne Merk-Tags."))).toEqual(EMPTY);
    expect(await listFacts()).toBe("No stored facts.");
    expect(await listGoals()).toBe("No active goals.");
  });

  test("REMEMBER legt einen Fakt an, Leerraum am Rand fällt weg", async () => {
    const r = await processIntents("Gut. [REMEMBER:   Alex trinkt morgens Tee  ] Weiter.");
    expect(core(r)).toEqual({ ...EMPTY, factsAdded: ["Alex trinkt morgens Tee"] });
    expect(await listFacts()).toBe("- Alex trinkt morgens Tee");
  });

  test("Tag-Namen ohne Rücksicht auf Groß- und Kleinschreibung", async () => {
    const r = await processIntents("[remember: Mia spielt Cello] [Goal: Mehr lesen]");
    expect(r.factsAdded).toEqual(["Mia spielt Cello"]);
    expect(r.goalsAdded).toEqual(["Mehr lesen"]);
  });

  test("mehrere Tags derselben Art in Reihenfolge", async () => {
    const r = await processIntents("[REMEMBER: eins] und [REMEMBER: zwei]");
    expect(r.factsAdded).toEqual(["eins", "zwei"]);
    expect(await listFacts()).toBe("- eins\n- zwei");
  });

  test("gleicher Fakt zweimal: einmal gespeichert, zweimal gemeldet", async () => {
    const r = await processIntents("[REMEMBER: Alex mag Jazz] [REMEMBER: Alex mag Jazz]");
    expect(r.factsAdded).toEqual(["Alex mag Jazz", "Alex mag Jazz"]);
    expect(await listFacts()).toBe("- Alex mag Jazz");
  });

  test("GOAL ohne Frist", async () => {
    const r = await processIntents("[GOAL: Garten umgraben]");
    expect(core(r)).toEqual({ ...EMPTY, goalsAdded: ["Garten umgraben"] });
    expect(await listGoals()).toBe("1. Garten umgraben");
  });

  test("GOAL mit englischer Frist", async () => {
    setSystemTime(new Date("2026-10-16T10:00:00.000Z"));
    const r = await processIntents("[GOAL: Bericht abgeben | DEADLINE: tomorrow]");
    expect(r.goalsAdded).toEqual(["Bericht abgeben"]);
    const due = new Date();
    due.setDate(due.getDate() + 1);
    expect(await listGoals()).toBe(`1. Bericht abgeben (due: ${due.toLocaleDateString()})`);
  });

  test("GOAL mit Pipe, aber ohne DEADLINE: wird nicht angelegt", async () => {
    expect(core(await processIntents("[GOAL: Urlaub | bald]"))).toEqual(EMPTY);
    expect(await listGoals()).toBe("No active goals.");
  });

  test("gleiches Ziel ohne Frist zweimal in einer Antwort: einmal", async () => {
    const r = await processIntents("[GOAL: Mehr lesen] [GOAL: Mehr lesen]");
    expect(r.goalsAdded).toEqual(["Mehr lesen"]);
    expect(await listGoals()).toBe("1. Mehr lesen");
  });

  test("Ziel mit Frist und dasselbe ohne: nur das mit Frist, egal in welcher Reihenfolge", async () => {
    setSystemTime(new Date("2026-10-16T10:00:00.000Z"));
    const r = await processIntents("[GOAL: Steuer] und später [GOAL: Steuer | DEADLINE: tomorrow]");
    expect(r.goalsAdded).toEqual(["Steuer"]);
    expect(await listGoals()).toMatch(/^1\. Steuer \(due: .+\)$/);
  });

  test("Tag über einen Zeilenumbruch", async () => {
    const r = await processIntents("[REMEMBER: Alex wohnt\nin Hamburg]");
    expect(r.factsAdded).toEqual(["Alex wohnt\nin Hamburg"]);
  });
});

describe("processIntents: deutsche Fristen", () => {
  beforeEach(() => {
    process.env.USER_TIMEZONE = "Europe/Berlin";
    setSystemTime(new Date("2026-10-16T10:00:00.000Z"));
  });

  test("morgen: Ende des nächsten Tages in USER_TIMEZONE", async () => {
    await processIntents("[GOAL: Arzt anrufen | DEADLINE: morgen]");
    const context = await getMemoryContext();
    expect(context).toContain(`1. Arzt anrufen (due: ${new Date("2026-10-17T21:59:59.000Z").toLocaleDateString()})`);
  });

  test("in 3 Tagen: Ende des dritten Tages danach", async () => {
    await processIntents("[GOAL: Reifen wechseln | DEADLINE: in 3 Tagen]");
    expect(await listGoals()).toBe(`1. Reifen wechseln (due: ${new Date("2026-10-19T21:59:59.000Z").toLocaleDateString()})`);
  });

  test("unlesbare Frist: Ziel ohne Frist", async () => {
    await processIntents("[GOAL: Irgendwas | DEADLINE: irgendwann mal]");
    expect(await listGoals()).toBe("1. Irgendwas");
  });
});

describe("processIntents: DONE, CANCEL, FORGET mit null oder einem Treffer", () => {
  test("DONE mit einem Treffer: Ziel erledigt, ohne Groß- und Kleinschreibung", async () => {
    await processIntents("[GOAL: Steuererklärung abgeben] [GOAL: Garten umgraben]");
    const r = await processIntents("[DONE: steuererklärung]");
    expect(core(r)).toEqual({ ...EMPTY, goalsCompleted: ["steuererklärung"] });
    expect(await listGoals()).toBe("1. Garten umgraben");
  });

  test("DONE ohne Treffer: nichts", async () => {
    await processIntents("[GOAL: Garten umgraben]");
    expect(core(await processIntents("[DONE: Steuererklärung]"))).toEqual(EMPTY);
    expect(await listGoals()).toBe("1. Garten umgraben");
  });

  test("DONE und CANCEL unter 5 Zeichen: zu vage, nichts", async () => {
    await processIntents("[GOAL: Rad putzen]");
    expect(core(await processIntents("[DONE: Rad] [CANCEL: Rad]"))).toEqual(EMPTY);
    expect(await listGoals()).toBe("1. Rad putzen");
  });

  test("CANCEL mit einem Treffer: Ziel gestrichen", async () => {
    await processIntents("[GOAL: Marathon laufen] [GOAL: Mehr lesen]");
    const r = await processIntents("[CANCEL: Marathon]");
    expect(core(r)).toEqual({ ...EMPTY, goalsCancelled: ["Marathon"] });
    expect(await listGoals()).toBe("1. Mehr lesen");
  });

  test("FORGET mit einem Treffer, auch unter 5 Zeichen", async () => {
    await processIntents("[REMEMBER: Alex trinkt Tee] [REMEMBER: Mia spielt Cello]");
    const r = await processIntents("[FORGET: tee]");
    expect(core(r)).toEqual({ ...EMPTY, factsRemoved: ["tee"] });
    expect(await listFacts()).toBe("- Mia spielt Cello");
  });

  test("FORGET ohne Treffer: nichts", async () => {
    await processIntents("[REMEMBER: Alex trinkt Tee]");
    expect(core(await processIntents("[FORGET: Kaffee]"))).toEqual(EMPTY);
    expect(await listFacts()).toBe("- Alex trinkt Tee");
  });

  test("in einer Antwort: erst Ziele anlegen, dann DONE", async () => {
    const r = await processIntents("[DONE: Bericht schreiben] [GOAL: Bericht schreiben]");
    expect(r.goalsAdded).toEqual(["Bericht schreiben"]);
    expect(r.goalsCompleted).toEqual(["Bericht schreiben"]);
    expect(await listGoals()).toBe("No active goals.");
  });

  test("in einer Antwort: erst Fakten anlegen, dann FORGET", async () => {
    const r = await processIntents("[FORGET: Notiz eins] [REMEMBER: Notiz eins]");
    expect(r.factsRemoved).toEqual(["Notiz eins"]);
    expect(await listFacts()).toBe("No stored facts.");
  });

  test("erledigtes Ziel ist kein Treffer mehr", async () => {
    await processIntents("[GOAL: Bericht schreiben]");
    await processIntents("[DONE: Bericht schreiben]");
    expect(core(await processIntents("[DONE: Bericht schreiben]"))).toEqual(EMPTY);
  });
});

describe("Gedächtnis-Kontext ohne Datenbank", () => {
  test("Fakten und Ziele im Wortlaut des Prompts", async () => {
    await processIntents("[REMEMBER: Alex mag Tee] [GOAL: Mehr lesen]");
    expect(await getMemoryContext("Was mag Alex?")).toMatch(/^\*\*Known Facts:\*\*\n_.+_\n- \[\d{4}-\d{2}-\d{2}\] Alex mag Tee\n\n\*\*Active Goals:\*\*\n1\. Mehr lesen$/);
  });

  test("leer: leerer Text", async () => {
    expect(await getMemoryContext()).toBe("");
  });
});
