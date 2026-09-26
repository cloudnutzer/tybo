/**
 * Gesprächsspeicher: umbenennen und löschen (Issue #21).
 */
import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore, CUSTOM_TITLE_MAX_CHARS, DEFAULT_TITLE, normalizeCustomTitle } from "../src/web/store";

const root = await mkdtemp(join(tmpdir(), "tybo-web-store-manage-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));

function freshDir(): string {
  return join(root, `case-${++counter}`, "web");
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

test("Titel: erst Leerraum normalisieren, dann 1 bis 80 Zeichen zählen", () => {
  expect(normalizeCustomTitle("  Reise \n\t nach   Rom  ")).toBe("Reise nach Rom");
  expect(normalizeCustomTitle("a\u0000b")).toBe("a b");
  expect(normalizeCustomTitle("x".repeat(80))).toBe("x".repeat(80));
  // 80 Zeichen erst nach dem Normalisieren
  expect(normalizeCustomTitle("   " + "x".repeat(40) + "\n\n\n" + "y".repeat(39) + "   ")).toBe(
    "x".repeat(40) + " " + "y".repeat(39)
  );
  // Emoji zählen als ein Zeichen (Codepoints), 80 davon sind erlaubt
  expect(normalizeCustomTitle("😀".repeat(80))).toBe("😀".repeat(80));
  expect(normalizeCustomTitle("😀".repeat(81))).toBeNull();
  expect(normalizeCustomTitle("x".repeat(CUSTOM_TITLE_MAX_CHARS + 1))).toBeNull();
  for (const bad of ["", "   ", "\n\t", 5, null, undefined, ["a"], { title: "a" }]) {
    expect(normalizeCustomTitle(bad)).toBeNull();
  }
});

test("Umbenennen bleibt nach Neuladen erhalten und ändert die Reihenfolge nicht", async () => {
  const dir = freshDir();
  let now = 1_800_000_000_000;
  const store = new ConversationStore({ dir, now: () => now });
  const a = await store.createConversation("general");
  now += 1000;
  const b = await store.createConversation("research");
  now += 1000;

  const renamed = await store.renameConversation(a.id, "  Urlaub   planen ");
  expect(renamed).toMatchObject({ id: a.id, title: "Urlaub planen", customTitle: true, updatedAt: a.updatedAt });
  expect((await store.listConversations()).map(c => c.id)).toEqual([b.id, a.id]);

  const reloaded = new ConversationStore({ dir });
  await reloaded.load();
  expect(await reloaded.getConversation(a.id)).toMatchObject({ title: "Urlaub planen", customTitle: true });
  expect(await reloaded.getConversation(b.id)).toMatchObject({ title: DEFAULT_TITLE });
  expect((await reloaded.getConversation(b.id))!.customTitle).toBeUndefined();
});

test("Umbenennen: ungültiger Titel wirft, unbekanntes Gespräch ergibt null", async () => {
  const store = new ConversationStore({ dir: freshDir() });
  const a = await store.createConversation("general");
  await expect(store.renameConversation(a.id, "  ")).rejects.toThrow("Ungültiger Titel");
  await expect(store.renameConversation(a.id, "x".repeat(81))).rejects.toThrow("Ungültiger Titel");
  expect(await store.renameConversation(crypto.randomUUID(), "Titel")).toBeNull();
  expect(await store.renameConversation("../x", "Titel")).toBeNull();
  expect((await store.getConversation(a.id))!.title).toBe(DEFAULT_TITLE);
});

test("Ein von Hand gesetzter Titel wird von der ersten Nachricht nicht überschrieben", async () => {
  const store = new ConversationStore({ dir: freshDir() });
  const a = await store.createConversation("general");
  const b = await store.createConversation("general");
  await store.renameConversation(a.id, "Mein Titel");
  // Auch der Titel „Neues Gespräch" ist, von Hand gesetzt, verbindlich
  await store.renameConversation(b.id, DEFAULT_TITLE);
  await store.appendMessage(a.id, { role: "user", text: "Erste Frage" });
  await store.appendMessage(b.id, { role: "user", text: "Andere Frage" });
  expect((await store.getConversation(a.id))!.title).toBe("Mein Titel");
  expect((await store.getConversation(b.id))!.title).toBe(DEFAULT_TITLE);

  // Die Automatik bleibt für nicht umbenannte Gespräche bei höchstens 60 Zeichen
  const c = await store.createConversation("general");
  await store.appendMessage(c.id, { role: "user", text: "wort ".repeat(30) });
  expect([...(await store.getConversation(c.id))!.title].length).toBeLessThanOrEqual(60);
});

test("Löschen entfernt Eintrag und Verlaufsdatei, auch nach Neuladen", async () => {
  const dir = freshDir();
  const store = new ConversationStore({ dir });
  const a = await store.createConversation("general");
  const b = await store.createConversation("research");
  await store.appendMessage(a.id, { role: "user", text: "Hallo" });
  await store.appendMessage(b.id, { role: "user", text: "Bleibt" });
  expect(await exists(join(dir, `${a.id}.jsonl`))).toBe(true);

  expect(await store.deleteConversation(a.id)).toBe(true);
  expect(await exists(join(dir, `${a.id}.jsonl`))).toBe(false);
  expect(await store.getConversation(a.id)).toBeNull();
  expect(await store.getMessages(a.id)).toEqual([]);
  expect((await store.listConversations()).map(c => c.id)).toEqual([b.id]);
  await expect(store.appendMessage(a.id, { role: "user", text: "zu spät" })).rejects.toThrow("Unbekanntes Gespräch");

  const reloaded = new ConversationStore({ dir });
  await reloaded.load();
  expect(await reloaded.getConversation(a.id)).toBeNull();
  expect((await reloaded.getMessages(b.id)).map(m => m.text)).toEqual(["Bleibt"]);
  const list = JSON.parse(await readFile(join(dir, "conversations.json"), "utf8"));
  expect(list.map((c: any) => c.id)).toEqual([b.id]);
  // Keine Reste (temporäre Dateien) im Verzeichnis
  expect((await readdir(dir)).sort()).toEqual(["conversations.json", `${b.id}.jsonl`].sort());
});

test("Löschen verträgt ein Gespräch ohne Verlaufsdatei; unbekannt ergibt false", async () => {
  const dir = freshDir();
  const store = new ConversationStore({ dir });
  const a = await store.createConversation("general");
  expect(await exists(join(dir, `${a.id}.jsonl`))).toBe(false);
  expect(await store.deleteConversation(a.id)).toBe(true);
  expect(await store.deleteConversation(a.id)).toBe(false);
  expect(await store.deleteConversation(crypto.randomUUID())).toBe(false);
  expect(await store.deleteConversation("../conversations")).toBe(false);
  expect(await store.listConversations()).toEqual([]);
});

test("Löschen läuft über die Schreibkette: eine gleichzeitige Nachricht geht nicht in eine verwaiste Datei", async () => {
  const dir = freshDir();
  const store = new ConversationStore({ dir });
  const a = await store.createConversation("general");
  const append = store.appendMessage(a.id, { role: "user", text: "vorher" });
  const del = store.deleteConversation(a.id);
  const late = store.appendMessage(a.id, { role: "user", text: "danach" });
  await append;
  expect(await del).toBe(true);
  await expect(late).rejects.toThrow("Unbekanntes Gespräch");
  expect(await exists(join(dir, `${a.id}.jsonl`))).toBe(false);
});

test("Scheitert das Löschen der Datei, bleibt das Gespräch vollständig", async () => {
  if (process.getuid?.() === 0) return; // root darf trotz fehlender Rechte schreiben
  const dir = freshDir();
  const store = new ConversationStore({ dir });
  const a = await store.createConversation("general");
  await store.appendMessage(a.id, { role: "user", text: "Hallo" });
  await chmod(dir, 0o500);
  try {
    await expect(store.deleteConversation(a.id)).rejects.toThrow();
  } finally {
    await chmod(dir, 0o700);
  }
  expect(await store.getConversation(a.id)).not.toBeNull();
  expect((await store.getMessages(a.id)).map(m => m.text)).toEqual(["Hallo"]);
});
