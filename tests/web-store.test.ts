import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore, DEFAULT_TITLE, isConversationId, titleFrom } from "../src/web/store";

const root = await mkdtemp(join(tmpdir(), "tybo-web-store-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));

function freshDir(): string {
  return join(root, `case-${++counter}`, "web");
}

test("Gespräch anlegen, auflisten und nach Neustart wieder laden", async () => {
  const dir = freshDir();
  let now = 1_800_000_000_000;
  const store = new ConversationStore({ dir, now: () => now });
  const a = await store.createConversation("general");
  now += 1000;
  const b = await store.createConversation("research");
  expect(isConversationId(a.id)).toBe(true);
  expect(a).toMatchObject({ title: DEFAULT_TITLE, agent: "general" });
  expect(a.createdAt).toBe(new Date(1_800_000_000_000).toISOString());

  // neueste zuerst
  expect((await store.listConversations()).map(c => c.id)).toEqual([b.id, a.id]);

  now += 1000;
  await store.appendMessage(a.id, { role: "user", text: "Hallo" });
  await store.appendMessage(a.id, { role: "assistant", text: "Hi **du**" });
  expect((await store.listConversations()).map(c => c.id)).toEqual([a.id, b.id]);

  const reloaded = new ConversationStore({ dir });
  await reloaded.load();
  expect(await reloaded.getConversation(a.id)).toMatchObject({ id: a.id, title: "Hallo", agent: "general" });
  const messages = await reloaded.getMessages(a.id);
  expect(messages.map(m => [m.role, m.text])).toEqual([["user", "Hallo"], ["assistant", "Hi **du**"]]);
  expect(isConversationId(messages[0].id)).toBe(true);

  const lines = (await readFile(join(dir, `${a.id}.jsonl`), "utf8")).trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(Object.keys(JSON.parse(lines[0])).sort()).toEqual(["createdAt", "id", "role", "text"]);
  // Dateien nur für den Besitzer lesbar
  expect((await stat(join(dir, "conversations.json"))).mode & 0o777).toBe(0o600);
});

test("Titel: erste Nutzernachricht, höchstens 60 Zeichen an einer Wortgrenze, sonst Standard", async () => {
  expect(titleFrom("  a\n\nb  ")).toBe("a b");
  expect(titleFrom("   ")).toBe(DEFAULT_TITLE);
  expect(titleFrom("😀".repeat(70))).toBe("😀".repeat(59) + "…");
  expect(titleFrom("x".repeat(60))).toBe("x".repeat(60));
  // Lange Sätze enden an einer Wortgrenze, nicht mitten im Wort
  const long = "Wie betreibe ich tybo am besten? Bitte mit Tabelle und Beispiel.";
  expect(titleFrom(long)).toBe("Wie betreibe ich tybo am besten? Bitte mit Tabelle und…");
  expect([...titleFrom(long)].length).toBeLessThanOrEqual(60);

  const store = new ConversationStore({ dir: freshDir() });
  const c = await store.createConversation("general");
  await store.appendMessage(c.id, { role: "assistant", text: "Antwort zuerst" });
  expect((await store.getConversation(c.id))!.title).toBe(DEFAULT_TITLE);
  await store.appendMessage(c.id, { role: "user", text: "x".repeat(80) });
  expect((await store.getConversation(c.id))!.title).toBe("x".repeat(59) + "…");
  await store.appendMessage(c.id, { role: "user", text: "Zweite Frage" });
  expect((await store.getConversation(c.id))!.title).toBe("x".repeat(59) + "…");

  // Erste Nachricht lautet selbst wie der Standardtitel: die zweite ändert ihn nicht
  const d = await store.createConversation("general");
  await store.appendMessage(d.id, { role: "user", text: DEFAULT_TITLE });
  await store.appendMessage(d.id, { role: "user", text: "später" });
  expect((await store.getConversation(d.id))!.title).toBe(DEFAULT_TITLE);
});

test("ID ../x und andere Nicht-UUIDs werden abgelehnt, keine Datei außerhalb", async () => {
  const dir = freshDir();
  const store = new ConversationStore({ dir });
  await store.createConversation("general");
  for (const id of ["../x", "..%2Fx", "x", "", "../../etc/passwd", "00000000-0000-0000-0000-000000000000"]) {
    expect(isConversationId(id)).toBe(false);
    expect(await store.getConversation(id)).toBeNull();
    await expect(store.appendMessage(id, { role: "user", text: "a" })).rejects.toThrow();
    await expect(store.getMessages(id)).rejects.toThrow();
  }
  // Gültiges Format, aber unbekannt
  const unknown = crypto.randomUUID();
  expect(await store.getConversation(unknown)).toBeNull();
  await expect(store.appendMessage(unknown, { role: "user", text: "a" })).rejects.toThrow();
  expect(await store.getMessages(unknown)).toEqual([]);

  expect((await readdir(dir)).filter(f => f !== "conversations.json")).toEqual([]);
  expect(await readdir(join(dir, ".."))).toEqual(["web"]);
});

test("Gleichzeitige Schreibvorgänge gehen nicht verloren", async () => {
  const dir = freshDir();
  const store = new ConversationStore({ dir });
  const created = await Promise.all(Array.from({ length: 20 }, () => store.createConversation("general")));
  await Promise.all(
    created.flatMap(c => [
      store.appendMessage(c.id, { role: "user", text: `Frage ${c.id}` }),
      store.appendMessage(c.id, { role: "assistant", text: "Antwort" }),
    ])
  );
  const reloaded = new ConversationStore({ dir });
  await reloaded.load();
  const list = await reloaded.listConversations();
  expect(list).toHaveLength(20);
  for (const c of list) {
    expect(c.title).toBe(`Frage ${c.id}`);
    expect((await reloaded.getMessages(c.id)).map(m => m.role)).toEqual(["user", "assistant"]);
  }
  // keine temporären Dateien übrig
  expect((await readdir(dir)).some(f => f.endsWith(".tmp"))).toBe(false);
});

test("Kaputte Liste wird nicht überschrieben, abgeschnittene Zeile übersprungen", async () => {
  const dir = freshDir();
  const store = new ConversationStore({ dir });
  const c = await store.createConversation("general");
  await store.appendMessage(c.id, { role: "user", text: "ganz" });
  await writeFile(join(dir, `${c.id}.jsonl`), (await readFile(join(dir, `${c.id}.jsonl`), "utf8")) + '{"id":"hal');
  expect((await store.getMessages(c.id)).map(m => m.text)).toEqual(["ganz"]);

  await writeFile(join(dir, "conversations.json"), "{kaputt");
  const broken = new ConversationStore({ dir });
  await expect(broken.load()).rejects.toThrow();
  await expect(broken.createConversation("general")).rejects.toThrow();
  expect(await readFile(join(dir, "conversations.json"), "utf8")).toBe("{kaputt");
});

test("Nach abgeschnittener Endzeile gehen weder alte noch neue Nachricht verloren", async () => {
  const dir = freshDir();
  const store = new ConversationStore({ dir });
  const c = await store.createConversation("general");
  await store.appendMessage(c.id, { role: "user", text: "alt" });
  const file = join(dir, `${c.id}.jsonl`);
  await writeFile(file, (await readFile(file, "utf8")) + '{"id":"hal');

  const reopened = new ConversationStore({ dir });
  await reopened.load();
  await reopened.appendMessage(c.id, { role: "assistant", text: "neu" });

  const again = new ConversationStore({ dir });
  await again.load();
  expect((await again.getMessages(c.id)).map(m => [m.role, m.text])).toEqual([
    ["user", "alt"],
    ["assistant", "neu"],
  ]);
});
