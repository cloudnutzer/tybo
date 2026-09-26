/**
 * Issue #29, Checkbox 1: Topic-Zustand (data/topic-state.json), gemeinsame
 * Schreibkette für config/topics.json und forgetTopicName. Nur temporäre
 * Dateien, nichts aus data/ oder config/ des Checkouts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TopicStateStore } from "../src/lib/topic-state";
import { removeTopicMapping, setTopicMapping } from "../src/lib/topic-setup";
import { createTopicNameStore } from "../src/lib/topic-names";

const root = await mkdtemp(join(tmpdir(), "tybo-topic-state-"));
let counter = 0;
const fresh = async () => {
  const dir = join(root, `case-${++counter}`);
  await mkdir(dir, { recursive: true });
  return dir;
};
afterAll(() => rm(root, { recursive: true, force: true }));

const CHAT = "-1001234567890";

describe("TopicStateStore", () => {
  test("fehlende Datei ist ein leerer Anfang", async () => {
    const store = new TopicStateStore({ file: join(await fresh(), "topic-state.json") });
    expect(await store.all()).toEqual({});
    expect(await store.get(CHAT, 5)).toEqual({});
  });

  test("beschädigte oder unlesbare Datei ist ein Fehler, nicht leer", async () => {
    const dir = await fresh();
    const file = join(dir, "topic-state.json");
    await writeFile(file, "{ kaputt");
    const store = new TopicStateStore({ file });
    await expect(store.all()).rejects.toThrow();
    await expect(store.forChat(CHAT)).rejects.toThrow();
    // Schreiben überschreibt die beschädigte Datei nicht
    await expect(store.setFlag(CHAT, 5, "deleted", true)).rejects.toThrow();
    expect(await readFile(file, "utf-8")).toBe("{ kaputt");
    await writeFile(file, "[1,2]");
    await expect(new TopicStateStore({ file }).all()).rejects.toThrow();
  });

  test("Zustand übersteht einen Neustart (neue Instanz liest die Datei)", async () => {
    const file = join(await fresh(), "topic-state.json");
    const store = new TopicStateStore({ file });
    await store.setFlag(CHAT, 5, "closed", true);
    await store.setFlag(CHAT, 6, "deleted", true);
    await store.setFlag(CHAT, 7, "autoTitle", true);
    await store.setFlag(CHAT, 7, "autoTitle", false);
    const again = new TopicStateStore({ file });
    expect(await again.all()).toEqual({ [`${CHAT}:5`]: { closed: true }, [`${CHAT}:6`]: { deleted: true } });
    expect([...(await again.forChat(CHAT)).entries()]).toEqual([[5, { closed: true }], [6, { deleted: true }]]);
    expect((await again.forChat("-100999")).size).toBe(0);
  });

  test("unbekannte Felder und falsche Werte werden ignoriert", async () => {
    const file = join(await fresh(), "topic-state.json");
    await writeFile(file, JSON.stringify({ [`${CHAT}:5`]: { closed: "ja", deleted: true, extra: true }, [`${CHAT}:6`]: { closed: false } }));
    expect(await new TopicStateStore({ file }).all()).toEqual({ [`${CHAT}:5`]: { deleted: true } });
  });

  test("claimAutoTitle gelingt genau einmal, auch parallel", async () => {
    const store = new TopicStateStore({ file: join(await fresh(), "topic-state.json") });
    await store.setFlag(CHAT, 9, "autoTitle", true);
    const results = await Promise.all([store.claimAutoTitle(CHAT, 9), store.claimAutoTitle(CHAT, 9), store.claimAutoTitle(CHAT, 9)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.get(CHAT, 9)).toEqual({});
  });

  test("claimAutoTitle bei gelöschtem Topic: false", async () => {
    const store = new TopicStateStore({ file: join(await fresh(), "topic-state.json") });
    await store.setFlag(CHAT, 9, "autoTitle", true);
    await store.setFlag(CHAT, 9, "deleted", true);
    expect(await store.claimAutoTitle(CHAT, 9)).toBe(false);
  });

  test("parallele Änderungen verlieren nichts", async () => {
    const file = join(await fresh(), "topic-state.json");
    const store = new TopicStateStore({ file });
    await Promise.all(Array.from({ length: 30 }, (_, i) => store.setFlag(CHAT, i + 2, i % 2 ? "closed" : "deleted", true)));
    const all = await new TopicStateStore({ file }).all();
    expect(Object.keys(all)).toHaveLength(30);
  });

  test("verspätetes erstes Lesen überschreibt keinen neueren Stand (deleted/closed bleiben)", async () => {
    const file = join(await fresh(), "topic-state.json");
    await writeFile(file, JSON.stringify({ [`${CHAT}:3`]: { closed: true } }));
    // Das erste Lesen liest den alten Dateistand und wird zurückgehalten,
    // jedes weitere Lesen läuft sofort durch.
    let reads = 0;
    let releaseHeld!: () => void;
    const held = new Promise<void>(resolve => (releaseHeld = resolve));
    const store = new TopicStateStore({
      file,
      readText: async f => {
        const text = await readFile(f, "utf-8");
        if (++reads === 1) await held;
        return text;
      },
    });

    // Zwei erste Lesezugriffe überlappen: ein Lesen der Liste und eine Änderung
    const staleRead = store.all();
    const marks = Promise.all([store.setFlag(CHAT, 5, "deleted", true), store.setFlag(CHAT, 6, "closed", true)]);
    // Der alten Umsetzung Zeit lassen, die Markierungen vor dem Ende des alten Lesens zu speichern
    await Promise.race([marks, new Promise(resolve => setTimeout(resolve, 50))]);
    releaseHeld();
    await staleRead;
    await marks;
    // Eine weitere Änderung danach darf die Markierungen nicht verlieren
    await store.setFlag(CHAT, 7, "autoTitle", true);

    const expected = {
      [`${CHAT}:3`]: { closed: true },
      [`${CHAT}:5`]: { deleted: true },
      [`${CHAT}:6`]: { closed: true },
      [`${CHAT}:7`]: { autoTitle: true },
    };
    expect(await store.all()).toEqual(expected);
    expect(await new TopicStateStore({ file }).all()).toEqual(expected);
    // Gleichzeitige erste Lesezugriffe teilen sich ein Lesen
    expect(reads).toBe(1);
  });

  test("nach einem Lesefehler liest der nächste Zugriff neu", async () => {
    const file = join(await fresh(), "topic-state.json");
    await writeFile(file, "{ kaputt");
    const store = new TopicStateStore({ file });
    await expect(Promise.all([store.all(), store.get(CHAT, 5)])).rejects.toThrow();
    await writeFile(file, JSON.stringify({ [`${CHAT}:5`]: { deleted: true } }));
    expect(await store.get(CHAT, 5)).toEqual({ deleted: true });
  });

  test("Schreibfehler wird geworfen, Speicher bleibt unverändert, Kette danach benutzbar", async () => {
    const dir = await fresh();
    const file = join(dir, "topic-state.json");
    // Ein Verzeichnis an der Stelle der Datei ist unlesbar, aber kein ENOENT: Fehler
    await mkdir(join(file, "block"), { recursive: true });
    await expect(new TopicStateStore({ file }).all()).rejects.toThrow();
    await rm(file, { recursive: true });
    const ok = new TopicStateStore({ file });
    await ok.setFlag(CHAT, 4, "closed", true);
    // Jetzt ein Verzeichnis an der Stelle der Datei: das Umbenennen beim Schreiben schlägt fehl
    await rm(file);
    await mkdir(join(file, "block"), { recursive: true });
    await expect(ok.setFlag(CHAT, 5, "deleted", true)).rejects.toThrow();
    expect(await ok.get(CHAT, 5)).toEqual({});
    await rm(file, { recursive: true });
    await ok.setFlag(CHAT, 6, "deleted", true);
    expect(await new TopicStateStore({ file }).all()).toEqual({ [`${CHAT}:4`]: { closed: true }, [`${CHAT}:6`]: { deleted: true } });
  });
});

describe("config/topics.json: gemeinsame Schreibkette", () => {
  test("paralleles Anlegen und Entfernen verliert keine Einträge", async () => {
    const file = join(await fresh(), "topics.json");
    await writeFile(file, JSON.stringify({ [CHAT]: { "10": "research", "11": "finance" }, "*": { "3": "critic" } }));
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => setTopicMapping(CHAT, 100 + i, "content", file)),
      removeTopicMapping(CHAT, 10, file),
      setTopicMapping("-100777", 4, "cto", file),
      removeTopicMapping(CHAT, 11, file),
    ]);
    const config = JSON.parse(await readFile(file, "utf-8"));
    expect(Object.keys(config[CHAT])).toHaveLength(20);
    expect(config[CHAT]["10"]).toBeUndefined();
    expect(config[CHAT]["11"]).toBeUndefined();
    expect(config["*"]).toEqual({ "3": "critic" });
    expect(config["-100777"]).toEqual({ "4": "cto" });
  });

  test("Entfernen ohne Datei oder Eintrag tut nichts", async () => {
    const dir = await fresh();
    await removeTopicMapping(CHAT, 5, join(dir, "topics.json"));
    await expect(readFile(join(dir, "topics.json"), "utf-8")).rejects.toThrow();
    const file = join(dir, "other.json");
    await writeFile(file, JSON.stringify({ [CHAT]: { "6": "general" } }));
    await removeTopicMapping(CHAT, 5, file);
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({ [CHAT]: { "6": "general" } });
  });

  test("beschädigte Datei wird beim Entfernen nicht überschrieben", async () => {
    const file = join(await fresh(), "topics.json");
    await writeFile(file, "{ kaputt");
    await expect(removeTopicMapping(CHAT, 5, file)).rejects.toThrow();
    expect(await readFile(file, "utf-8")).toBe("{ kaputt");
    // Die Kette bleibt benutzbar
    const ok = join(await fresh(), "topics.json");
    await setTopicMapping(CHAT, 5, "general", ok);
    expect(JSON.parse(await readFile(ok, "utf-8"))).toEqual({ [CHAT]: { "5": "general" } });
  });
});

describe("topic-names: saveTopicName und forgetTopicName", () => {
  test("speichern und vergessen", async () => {
    const file = join(await fresh(), "topic-names.json");
    await writeFile(file, JSON.stringify({ "5": "Alt", "6": "Bleibt" }));
    const names = createTopicNameStore(file);
    await names.saveTopicName(7, "Neu");
    await names.forgetTopicName(5);
    await names.forgetTopicName(99);
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({ "6": "Bleibt", "7": "Neu" });
    expect(await createTopicNameStore(file).getTopicNames()).toEqual({ "6": "Bleibt", "7": "Neu" });
  });

  test("Schreibfehler werden geworfen, der Name bleibt bekannt", async () => {
    const dir = await fresh();
    const file = join(dir, "topic-names.json");
    await writeFile(file, JSON.stringify({ "5": "Alt" }));
    const names = createTopicNameStore(file);
    expect(await names.getTopicName(5)).toBe("Alt");
    await rm(file);
    await mkdir(join(file, "block"), { recursive: true });
    await expect(names.forgetTopicName(5)).rejects.toThrow();
    expect(await names.getTopicName(5)).toBe("Alt");
    await expect(names.saveTopicName(8, "X")).rejects.toThrow();
    expect(await names.getTopicName(8)).toBeUndefined();
  });

  test("beschädigte Datei: forgetTopicName wirft und überschreibt nicht", async () => {
    const file = join(await fresh(), "topic-names.json");
    await writeFile(file, "nicht json");
    await expect(createTopicNameStore(file).forgetTopicName(5)).rejects.toThrow();
    expect(await readFile(file, "utf-8")).toBe("nicht json");
  });

  test("beschädigte Datei nach getTopicNames: saveTopicName wirft und überschreibt nicht", async () => {
    const file = join(await fresh(), "topic-names.json");
    await writeFile(file, "nicht json");
    const names = createTopicNameStore(file);
    expect(await names.getTopicNames()).toEqual({});
    await expect(names.saveTopicName(7, "Neu")).rejects.toThrow();
    expect(await readFile(file, "utf-8")).toBe("nicht json");
  });

  test("beschädigte Datei nach getTopicNames: forgetTopicName wirft statt Erfolg zu melden", async () => {
    const file = join(await fresh(), "topic-names.json");
    await writeFile(file, "nicht json");
    const names = createTopicNameStore(file);
    expect(await names.getTopicNames()).toEqual({});
    await expect(names.forgetTopicName(5)).rejects.toThrow();
    expect(await readFile(file, "utf-8")).toBe("nicht json");
  });

  test("Datei nach tolerantem Lesefehler repariert: saveTopicName liest sie neu und behält ihren Inhalt", async () => {
    const file = join(await fresh(), "topic-names.json");
    await writeFile(file, "nicht json");
    const names = createTopicNameStore(file);
    expect(await names.getTopicNames()).toEqual({});
    await writeFile(file, JSON.stringify({ "5": "Alt" }));
    await names.saveTopicName(7, "Neu");
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({ "5": "Alt", "7": "Neu" });
  });

  test("fehlende Datei nach getTopicNames ist ein gültiger leerer Speicher", async () => {
    const file = join(await fresh(), "topic-names.json");
    const names = createTopicNameStore(file);
    expect(await names.getTopicNames()).toEqual({});
    await names.forgetTopicName(5);
    await names.saveTopicName(7, "Neu");
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({ "7": "Neu" });
  });

  test("parallele saveTopicName-Aufrufe bei kaltem Cache: alle Namen bleiben erhalten", async () => {
    const file = join(await fresh(), "topic-names.json");
    await writeFile(file, JSON.stringify({ "5": "Alt" }));
    const names = createTopicNameStore(file);
    await Promise.all(Array.from({ length: 20 }, (_, i) => names.saveTopicName(100 + i, `Topic ${i}`)));
    const stored = await createTopicNameStore(file).getTopicNames();
    expect(Object.keys(stored)).toHaveLength(21);
    expect(stored["5"]).toBe("Alt");
    expect(stored["119"]).toBe("Topic 19");
  });

  test("saveTopicName und forgetTopicName parallel bei kaltem Cache: beide Änderungen bleiben erhalten", async () => {
    const file = join(await fresh(), "topic-names.json");
    await writeFile(file, JSON.stringify({ "5": "Alt", "6": "Bleibt" }));
    const names = createTopicNameStore(file);
    await Promise.all([names.forgetTopicName(5), names.saveTopicName(7, "Neu"), names.getTopicNames(), names.recordTopicName(8, "Telegram")]);
    expect(await createTopicNameStore(file).getTopicNames()).toEqual({ "6": "Bleibt", "7": "Neu", "8": "Telegram" });

    // Umgekehrte Reihenfolge, wieder kalt
    const again = createTopicNameStore(file);
    await Promise.all([again.saveTopicName(9, "Neun"), again.forgetTopicName(6)]);
    expect(await createTopicNameStore(file).getTopicNames()).toEqual({ "7": "Neu", "8": "Telegram", "9": "Neun" });
  });

  test("ein fehlgeschlagener Aufruf in der Kette verliert die übrigen Änderungen nicht", async () => {
    const dir = await fresh();
    const file = join(dir, "topic-names.json");
    await writeFile(file, JSON.stringify({ "5": "Alt" }));
    const names = createTopicNameStore(file);
    await names.getTopicNames();
    await rm(file);
    await mkdir(join(file, "block"), { recursive: true });
    const failing = names.saveTopicName(6, "Scheitert");
    const unblock = failing.catch(() => rm(file, { recursive: true }));
    await expect(failing).rejects.toThrow();
    await unblock;
    await Promise.all([names.saveTopicName(7, "Neu"), names.forgetTopicName(5)]);
    expect(await createTopicNameStore(file).getTopicNames()).toEqual({ "7": "Neu" });
  });

  test("recordTopicName verschluckt Fehler weiter", async () => {
    const dir = await fresh();
    const file = join(dir, "topic-names.json");
    await mkdir(join(file, "block"), { recursive: true });
    await createTopicNameStore(file).recordTopicName(5, "X");
  });
});
