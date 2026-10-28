/**
 * Rückfragen-Register (Issue #113), Schritt 1: Datenmodell, Ablage mit
 * Sperre, Aufräumen, kaputte Dateien. Alles in einem Temp-Ordner, nie data/.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CHOICE_MAX_AGE_MS,
  CHOICE_OPTIONS_MAX,
  createChoice,
  expireChoice,
  getChoice,
  listOpenChoices,
  setChoicesFileForTests,
  type Choice,
  type CreateChoiceInput,
} from "../src/lib/choices";

const base = mkdtempSync(join(tmpdir(), "choices-store-"));
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

let file = "";
let counter = 0;
let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  file = join(base, `choices-${++counter}.json`);
  setChoicesFileForTests(file);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

const onDisk = () => JSON.parse(readFileSync(file, "utf-8"));
const DM = { type: "telegram", chatId: "4242" } as const;

function input(over: Partial<CreateChoiceInput> = {}): CreateChoiceInput {
  return {
    kind: "tool",
    conversation: DM,
    text: "Darf ich die Datei schreiben?",
    options: [{ key: "ok", label: "Erlauben" }, { key: "no", label: "Ablehnen" }],
    ...over,
  };
}

describe("Datenmodell", () => {
  test("createChoice legt eine offene Frage mit kurzer ID an und speichert sie", async () => {
    const c = await createChoice(input({ ref: "freigabe-1", expiresAt: Date.now() + 60_000 }));
    expect(c.id).toMatch(/^[A-Za-z0-9]{1,12}$/);
    expect(c.state).toBe("open");
    expect(c.result).toBeUndefined();
    expect(c.ref).toBe("freigabe-1");
    expect(onDisk()).toEqual({ version: 1, choices: { [c.id]: c } });
    expect(await getChoice(c.id)).toEqual(c);
  });

  test("viele Fragen: IDs eindeutig und höchstens 12 Zeichen", async () => {
    const ids = await Promise.all(Array.from({ length: 50 }, () => createChoice(input()).then(c => c.id)));
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(12);
    expect(Object.keys(onDisk().choices)).toHaveLength(50);
  });

  test("Topic-Zuordnung ohne Höchstzahl der Optionen (Issue #119), andere Arten mit", async () => {
    const many = Array.from({ length: CHOICE_OPTIONS_MAX + 1 }, (_, i) => ({ key: `k${i}`, label: "x" }));
    const topicmap = await createChoice(input({ kind: "topicmap", options: many }));
    expect((await getChoice(topicmap.id))!.options).toHaveLength(CHOICE_OPTIONS_MAX + 1);
    await expect(createChoice(input({ kind: "tool", options: many }))).rejects.toThrow("Optionen");
  });

  test("ungültige Eingaben werden abgelehnt", async () => {
    const opt = (key: string, label = "x") => ({ key, label });
    await expect(createChoice(input({ options: [] }))).rejects.toThrow("Optionen");
    await expect(createChoice(input({ options: Array.from({ length: CHOICE_OPTIONS_MAX + 1 }, (_, i) => opt(`k${i}`)) }))).rejects.toThrow("Optionen");
    await expect(createChoice(input({ options: [opt("a"), opt("a")] }))).rejects.toThrow("doppelt");
    await expect(createChoice(input({ options: [opt("")] }))).rejects.toThrow("Optionsschlüssel");
    await expect(createChoice(input({ options: [opt("a|b")] }))).rejects.toThrow("Optionsschlüssel");
    await expect(createChoice(input({ options: [opt("ä")] }))).rejects.toThrow("Optionsschlüssel");
    await expect(createChoice(input({ options: [opt("a".repeat(33))] }))).rejects.toThrow("Optionsschlüssel");
    await expect(createChoice(input({ options: [opt("a", " ")] }))).rejects.toThrow("Beschriftung");
    await expect(createChoice(input({ kind: "check" as any }))).rejects.toThrow("Art");
    await expect(createChoice(input({ conversation: { type: "telegram", chatId: "" } }))).rejects.toThrow("Gespräch");
    await expect(createChoice(input({ conversation: { type: "web" } as any }))).rejects.toThrow("Gespräch");
    await expect(createChoice(input({ text: "" }))).rejects.toThrow("Fragetext");
    expect(existsSync(file)).toBe(false);
  });

  test("8 Optionen gehen", async () => {
    const c = await createChoice(input({ kind: "topicmap", options: Array.from({ length: 8 }, (_, i) => ({ key: `a${i}`, label: `Agent ${i}` })) }));
    expect(c.options).toHaveLength(8);
  });
});

describe("Gesprächsfilter", () => {
  test("listOpenChoices trennt Direktchat, Topics und Web-Gespräche", async () => {
    const dm = await createChoice(input());
    const topic = await createChoice(input({ conversation: { type: "telegram", chatId: "4242", topicId: 7 } }));
    const otherTopic = await createChoice(input({ conversation: { type: "telegram", chatId: "4242", topicId: 8 } }));
    const web = await createChoice(input({ conversation: { type: "web", conversationId: "abc" } }));
    const webOther = await createChoice(input({ conversation: { type: "web", conversationId: "def" } }));

    expect((await listOpenChoices(DM)).map(c => c.id)).toEqual([dm.id]);
    expect((await listOpenChoices({ type: "telegram", chatId: "4242", topicId: 7 })).map(c => c.id)).toEqual([topic.id]);
    expect((await listOpenChoices({ type: "telegram", chatId: "4242", topicId: 8 })).map(c => c.id)).toEqual([otherTopic.id]);
    expect((await listOpenChoices({ type: "web", conversationId: "abc" })).map(c => c.id)).toEqual([web.id]);
    expect((await listOpenChoices({ type: "web", conversationId: "def" })).map(c => c.id)).toEqual([webOther.id]);
    // Web-Kennung "4242" ist kein Telegram-Chat 4242
    expect(await listOpenChoices({ type: "web", conversationId: "4242" })).toEqual([]);
  });

  test("nur offene Fragen, abgelaufene und entschiedene nicht", async () => {
    const open = await createChoice(input());
    const lapsed = await createChoice(input({ expiresAt: Date.now() - 1 }));
    const expired = await createChoice(input());
    await expireChoice(expired.id);
    expect((await listOpenChoices(DM)).map(c => c.id)).toEqual([open.id]);
    expect((await getChoice(lapsed.id))?.state).toBe("expired");
  });
});

describe("Ablauf", () => {
  test("überschrittenes expiresAt gilt beim Lesen als expired, ohne die Datei zu ändern", async () => {
    const c = await createChoice(input({ expiresAt: Date.now() + 30 }));
    expect((await getChoice(c.id))?.state).toBe("open");
    await Bun.sleep(40);
    expect((await getChoice(c.id))?.state).toBe("expired");
    expect(onDisk().choices[c.id].state).toBe("open");
  });

  test("expireChoice: offen wird expired, zweiter Aufruf already, unbekannt unknown", async () => {
    const c = await createChoice(input());
    const first = await expireChoice(c.id);
    expect(first.status).toBe("expired");
    expect(onDisk().choices[c.id].state).toBe("expired");
    expect((await expireChoice(c.id)).status).toBe("already");
    expect((await expireChoice("gibtsnicht")).status).toBe("unknown");
    expect(await getChoice("gibtsnicht")).toBeUndefined();
  });
});

describe("Aufräumen", () => {
  test("Einträge älter als 7 Tage verschwinden beim nächsten Schreiben, auch offene", async () => {
    const old = (id: string, state: Choice["state"]): Choice => ({
      id, kind: "review", conversation: DM, text: "alt", options: [{ key: "ok", label: "Ja" }], state,
      createdAt: Date.now() - CHOICE_MAX_AGE_MS - 1_000,
      ...(state === "done" ? { result: { key: "ok", label: "Ja", via: "telegram" as const, at: Date.now() } } : {}),
    });
    const young: Choice = { ...old("jung", "open"), createdAt: Date.now() - CHOICE_MAX_AGE_MS + 60_000 };
    writeFileSync(file, JSON.stringify({ version: 1, choices: { altoffen: old("altoffen", "open"), altdone: old("altdone", "done"), jung: young } }));
    // Lesen räumt nicht auf
    expect(await getChoice("altoffen")).toBeDefined();
    const fresh = await createChoice(input());
    expect(Object.keys(onDisk().choices).sort()).toEqual([fresh.id, "jung"].sort());
  });
});

describe("kaputte oder fehlende Datei", () => {
  test("fehlende Datei: leer, kein Absturz", async () => {
    expect(await getChoice("abc")).toBeUndefined();
    expect(await listOpenChoices(DM)).toEqual([]);
    expect((await expireChoice("abc")).status).toBe("unknown");
  });

  for (const [name, content] of [
    ["beschädigtes JSON", "{ nicht json"],
    ["falsche Struktur (Array)", "[]"],
    ["falsche Struktur (ohne version)", JSON.stringify({ choices: {} })],
    ["choices ist kein Objekt", JSON.stringify({ version: 1, choices: 5 })],
  ] as const) {
    test(`${name}: Lesen liefert leer, Schreiben bewahrt die Datei auf statt sie still zu überschreiben`, async () => {
      writeFileSync(file, content);
      expect(await getChoice("abc")).toBeUndefined();
      expect(await listOpenChoices(DM)).toEqual([]);
      expect(readFileSync(file, "utf-8")).toBe(content);

      const c = await createChoice(input());
      expect(Object.keys(onDisk().choices)).toEqual([c.id]);
      const backups = readdirSync(base).filter(f => f.startsWith(`${file.split("/").pop()}.kaputt-`));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(base, backups[0]), "utf-8")).toBe(content);
      expect(logSpy.mock.calls.some(args => String(args[0]).includes("aufbewahrt als"))).toBe(true);
    });
  }

  test("einzelner ungültiger Eintrag wird übersprungen, gültige bleiben", async () => {
    const good: Choice = { id: "gut", kind: "goal", conversation: DM, text: "Weiter?", options: [{ key: "go", label: "Weiter" }], state: "open", createdAt: Date.now() };
    writeFileSync(file, JSON.stringify({ version: 1, choices: {
      gut: good,
      kaputt: { id: "kaputt", kind: "tool" },
      doneohne: { ...good, id: "doneohne", state: "done" },
      openmit: { ...good, id: "openmit", result: { key: "go", label: "Weiter", via: "web", at: 1 } },
    } }));
    expect(await getChoice("gut")).toEqual(good);
    expect(await getChoice("kaputt")).toBeUndefined();
    expect(await getChoice("doneohne")).toBeUndefined();
    expect(await getChoice("openmit")).toBeUndefined();
    expect((await listOpenChoices(DM)).map(c => c.id)).toEqual(["gut"]);
  });
});
