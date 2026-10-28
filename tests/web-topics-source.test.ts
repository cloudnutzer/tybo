/**
 * Issue #29, Checkbox 3: createTelegramSource und der Live-Feed kennen den
 * Topic-Zustand. Gelöschte Topics bleiben verschwunden, obwohl die
 * Supabase-Attrappe weiter Aktivität und Verlauf liefert, Name und Zuordnung
 * noch da sind, auch nach einem Neustart. Geschlossene tragen closed.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTopicMapping } from "../src/lib/topic-setup";
import type { WebServer } from "../src/web/server";
import type { TelegramLiveEvent } from "../src/web/telegram";
import { GROUP, topicEnv, topicLive, topicServer, topicSource, type TopicEnv } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "bot-topics-source-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

/** Topic 7 mit allem: Aktivität und Verlauf in Supabase, Name, Zuordnung */
async function seeded(): Promise<TopicEnv> {
  const env = await topicEnv(root);
  env.messages.add(7, "Frage in Sieben", "2026-09-23T10:00:00.000Z");
  env.messages.add(8, "Frage in Acht", "2026-09-23T09:00:00.000Z");
  await env.names.saveTopicName(7, "Sieben");
  await env.names.saveTopicName(8, "Acht");
  await setTopicMapping(GROUP, 7, "research", env.mappingFile);
  return env;
}

const ids = (list: { topics: { id: string }[] }) => list.topics.map(t => t.id).sort();

describe("createTelegramSource mit Topic-Zustand", () => {
  test("gelöschtes Topic fehlt trotz Aktivität, Name und Zuordnung; getConversation und Verlauf null", async () => {
    const env = await seeded();
    expect(ids(await topicSource(env).listConversations())).toEqual(["topic-1", "topic-7", "topic-8"]);
    await env.state.setFlag(GROUP, 7, "deleted", true);
    const source = topicSource(env);
    expect(ids(await source.listConversations())).toEqual(["topic-1", "topic-8"]);
    expect(await source.getConversation("topic-7")).toBeNull();
    expect(await source.history("topic-7")).toBeNull();
    // Nach Neustart (neue Instanzen lesen die Dateien)
    const again = topicSource(env, true);
    expect(ids(await again.listConversations())).toEqual(["topic-1", "topic-8"]);
    expect(await again.getConversation("topic-7")).toBeNull();
  });

  test("geschlossen: closed in Liste und Einzelabruf, offen ohne Feld", async () => {
    const env = await seeded();
    await env.state.setFlag(GROUP, 8, "closed", true);
    const list = await topicSource(env).listConversations();
    expect(list.topics.find(t => t.id === "topic-8")?.closed).toBe(true);
    expect("closed" in list.topics.find(t => t.id === "topic-7")!).toBe(false);
    expect((await topicSource(env).getConversation("topic-8"))?.closed).toBe(true);
    expect((await topicSource(env, true).getConversation("topic-8"))?.closed).toBe(true);
  });

  test("General lässt sich über den Zustand weder ausblenden noch schließen", async () => {
    const env = await seeded();
    await env.state.setFlag(GROUP, 1, "deleted", true);
    await env.state.setFlag(GROUP, 1, "closed", true);
    const general = await topicSource(env).getConversation("topic-1");
    expect(general?.title).toBe("General");
    expect(general?.closed).toBeUndefined();
  });

  test("unlesbarer Zustand: nur Direktchat und General, nichts Gelöschtes kommt zurück", async () => {
    const env = await seeded();
    await writeFile(env.stateFile, "{ kaputt");
    const list = await topicSource(env, true).listConversations();
    expect(list.dm?.id).toBe("dm");
    expect(ids(list)).toEqual(["topic-1"]);
    expect(env.logs.some(l => l.includes("Topic-Zustand nicht lesbar"))).toBe(true);
  });
});

describe("Live-Feed mit Topic-Zustand", () => {
  test("Ereignisse gelöschter Topics werden verworfen, andere kommen an", async () => {
    const env = await seeded();
    await env.state.setFlag(GROUP, 7, "deleted", true);
    const got: TelegramLiveEvent[] = [];
    topicLive(env).subscribe(e => got.push(e));
    env.feed.emit({ chatId: GROUP, content: "in sieben", metadata: { topicId: 7, msgId: 5 } });
    env.feed.emit({ chatId: GROUP, content: "in acht", metadata: { topicId: 8, msgId: 6 } });
    env.feed.emit({ chatId: GROUP, content: "in general", metadata: { msgId: 7 } });
    await Bun.sleep(10);
    expect(got.map(e => e.conversationId).sort()).toEqual(["topic-1", "topic-8"]);
    // Neustart
    const later: TelegramLiveEvent[] = [];
    topicLive(env, true).subscribe(e => later.push(e));
    env.feed.emit({ chatId: GROUP, content: "noch mal sieben", metadata: { topicId: 7, msgId: 8 } });
    await Bun.sleep(10);
    expect(later).toEqual([]);
  });

  test("unlesbarer Zustand: Topic-Ereignisse verworfen, Direktchat kommt an", async () => {
    const env = await seeded();
    await writeFile(env.stateFile, "{ kaputt");
    const got: TelegramLiveEvent[] = [];
    topicLive(env, true).subscribe(e => got.push(e));
    env.feed.emit({ chatId: GROUP, content: "in acht", metadata: { topicId: 8, msgId: 6 } });
    env.feed.emit({ chatId: "4242", content: "im dm", metadata: { msgId: 9 } });
    await Bun.sleep(10);
    expect(got.map(e => e.conversationId)).toEqual(["dm"]);
  });
});

describe("Server: gelöschtes Topic bleibt verschwunden", () => {
  test("Liste, Abruf, Verlauf, Events, Schreiben und Stopp: 404; Supabase liefert weiter", async () => {
    const env = await seeded();
    await env.state.setFlag(GROUP, 7, "deleted", true);
    const ctx = await topicServer(root, servers, env);
    const list = await (await ctx.api("/api/conversations")).json();
    expect(list.telegram.topics.map((t: any) => t.id)).not.toContain("topic-7");
    for (const [path, method, body] of [
      ["/api/conversations/topic-7", "GET"],
      ["/api/conversations/topic-7/messages", "GET"],
      ["/api/conversations/topic-7/events", "GET"],
      ["/api/conversations/topic-7/messages", "POST", { text: "hallo" }],
      ["/api/conversations/topic-7/stop", "POST"],
    ] as [string, string, unknown?][]) {
      expect({ path, method, status: (await ctx.api(path, method, body)).status }).toEqual({ path, method, status: 404 });
    }
    // Die Attrappe hat den Verlauf noch
    expect(env.messages.rows.get(`topic:${GROUP}:7`)).toHaveLength(1);
  });
});
