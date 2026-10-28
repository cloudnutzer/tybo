/**
 * Codex-Befund zu PR #31: Der Erstellungsname, der in reply_to_message jeder
 * Topic-Nachricht mitreist, darf einen neueren Namen (Umbenennung aus der
 * WebUI oder in Telegram) nicht überschreiben.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTopicMapping } from "../src/lib/topic-setup";
import { captureTopicName, createTopicNameStore, topicNameCapture } from "../src/lib/topic-names";
import type { WebServer } from "../src/web/server";
import { GROUP, readNames, topicEnv, topicServer } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "tybo-topic-capture-"));
const servers: WebServer[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  await rm(root, { recursive: true, force: true });
});

const replyWithCreation = (name: string) => ({ text: "hallo", reply_to_message: { forum_topic_created: { name } } });

test("topicNameCapture: Umbenennen und Anlegen sind aktuell, der mitreisende Erstellungsname nicht", () => {
  expect(topicNameCapture({ forum_topic_edited: { name: "Neu" } })).toEqual({ name: "Neu", current: true });
  expect(topicNameCapture({ forum_topic_created: { name: "Frisch" } })).toEqual({ name: "Frisch", current: true });
  expect(topicNameCapture(replyWithCreation("Alt"))).toEqual({ name: "Alt", current: false });
  expect(topicNameCapture({ text: "ohne Topic-Info" })).toBeUndefined();
});

test("neuer Titel bleibt, wenn danach eine Telegram-Nachricht mit altem Erstellungsnamen kommt", async () => {
  const file = join(root, "names-a.json");
  const store = createTopicNameStore(file);
  await store.saveTopicName(500, "Neuer Titel");
  await captureTopicName(store, 500, replyWithCreation("Neues Gespräch"));
  expect(await store.getTopicName(500)).toBe("Neuer Titel");
  // auch nach Neuladen der Datei
  expect(JSON.parse(await readFile(file, "utf8"))["500"]).toBe("Neuer Titel");
});

test("unbekanntes Topic: Erstellungsname füllt die Lücke; echte Umbenennung überschreibt", async () => {
  const store = createTopicNameStore(join(root, "names-b.json"));
  await captureTopicName(store, 7, replyWithCreation("Sieben"));
  expect(await store.getTopicName(7)).toBe("Sieben");
  await captureTopicName(store, 7, { forum_topic_edited: { name: "Sieben neu" } });
  expect(await store.getTopicName(7)).toBe("Sieben neu");
  await captureTopicName(store, 7, replyWithCreation("Sieben"));
  expect(await store.getTopicName(7)).toBe("Sieben neu");
});

test("nach Umbenennen in der WebUI und alter Telegram-Nachricht: Liste zeigt neuen Titel, DELETE mit altem Namen 400 ohne deleteForumTopic", async () => {
  const env = await topicEnv(root);
  await env.names.saveTopicName(7, "Sieben");
  await setTopicMapping(GROUP, 7, "finance", env.mappingFile);
  env.messages.add(7, "Wie hoch ist das Budget?");
  const ctx = await topicServer(root, servers, env);

  expect((await ctx.api("/api/conversations/topic-7", "PATCH", { title: "Acht" })).status).toBe(200);
  // Telegram-Nachricht im Topic trägt weiter den Erstellungsnamen
  await captureTopicName(env.names, 7, replyWithCreation("Sieben"));

  expect((await readNames(env))["7"]).toBe("Acht");
  const list = await (await ctx.api("/api/conversations")).json();
  expect(list.telegram.topics.find((t: { id: string }) => t.id === "topic-7")?.title).toBe("Acht");

  const res = await ctx.api("/api/conversations/topic-7", "DELETE", { confirm: "Sieben" });
  expect(res.status).toBe(400);
  expect(env.api.callsOf("deleteForumTopic")).toEqual([]);
});
