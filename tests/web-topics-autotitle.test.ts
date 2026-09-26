/**
 * Issue #29, Checkbox 5: Die erste Nutzernachricht in einem neu angelegten
 * Topic (autoTitle) setzt den Titel, aus dem Browser wie aus Telegram,
 * genau einmal; ein manueller Titel geht immer vor.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunTurnOptions, TurnResult, WebChat } from "../src/web/chat";
import type { WebServer } from "../src/web/server";
import { titleFrom } from "../src/web/store";
import { GROUP, readNames, telegramError, topicEnv, topicServer, type TopicEnv } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "bot-topics-title-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

/** Wie createTelegramChat: speichert die Nutzernachricht (channel web), das löst onMessageSaved aus */
function savingChat(env: TopicEnv): WebChat {
  return {
    async runTurn(opts: RunTurnOptions): Promise<TurnResult> {
      const topicId = Number(opts.conversationId.slice("topic-".length));
      env.feed.emit({ chatId: GROUP, content: opts.text, metadata: { topicId, channel: "web", msgId: opts.messageId } });
      return { text: "Antwort" };
    },
    stop() {},
  };
}

const edits = (env: TopicEnv) => env.api.callsOf("editForumTopic");

async function created(env: TopicEnv, withChat = true) {
  const ctx = await topicServer(root, servers, env, withChat ? { telegramChat: savingChat(env) } : {});
  const res = await ctx.api("/api/conversations", "POST", { agent: "research" });
  expect(res.status).toBe(201);
  return ctx;
}

describe("automatische Titelvergabe", () => {
  test("erste Nutzernachricht aus dem Browser setzt den Titel genau einmal", async () => {
    const env = await topicEnv(root);
    const ctx = await created(env);
    expect((await ctx.api("/api/conversations/topic-500/messages", "POST", { text: "Wie teuer ist ein VPS bei Hetzner?" })).status).toBe(202);
    await Bun.sleep(20);
    await env.manager.idle();
    expect(edits(env)).toEqual([["editForumTopic", GROUP, 500, "Wie teuer ist ein VPS bei Hetzner?"]]);
    expect((await readNames(env))["500"]).toBe("Wie teuer ist ein VPS bei Hetzner?");
    expect(await env.state.get(GROUP, 500)).toEqual({});
    const list = await (await ctx.api("/api/conversations")).json();
    expect(list.telegram.topics.find((t: any) => t.id === "topic-500").title).toBe("Wie teuer ist ein VPS bei Hetzner?");
    // Zweite Nachricht: kein weiterer Titel
    await ctx.api("/api/conversations/topic-500/messages", "POST", { text: "Und bei Netcup?" });
    await Bun.sleep(20);
    await env.manager.idle();
    expect(edits(env)).toHaveLength(1);
  });

  test("erste Nutzernachricht aus Telegram setzt den Titel genau einmal, lange Texte gekürzt", async () => {
    const env = await topicEnv(root);
    await created(env, false);
    const long = "Bitte recherchiere ausführlich die Preise aller deutschen VPS-Anbieter mit mindestens vier Kernen";
    env.feed.emit({ chatId: GROUP, content: long, metadata: { topicId: 500, msgId: 17 } });
    env.feed.emit({ chatId: GROUP, content: "zweite Nachricht", metadata: { topicId: 500, msgId: 18 } });
    await env.manager.idle();
    expect(edits(env)).toEqual([["editForumTopic", GROUP, 500, titleFrom(long)]]);
    expect([...titleFrom(long)].length).toBeLessThanOrEqual(60);
    expect((await readNames(env))["500"]).toBe(titleFrom(long));
  });

  test("Antworten, fremde Chats, General und Topics ohne autoTitle lösen nichts aus", async () => {
    const env = await topicEnv(root);
    await created(env, false);
    env.feed.emit({ chatId: GROUP, role: "assistant", content: "Antwort zuerst", metadata: { topicId: 500 } });
    env.feed.emit({ chatId: "-100999", content: "fremde Gruppe", metadata: { topicId: 500 } });
    env.feed.emit({ chatId: "4242", content: "Direktchat" });
    env.feed.emit({ chatId: GROUP, content: "General", metadata: {} });
    env.feed.emit({ chatId: GROUP, content: "altes Topic", metadata: { topicId: 77 } });
    await env.manager.idle();
    expect(edits(env)).toEqual([]);
    expect(await env.state.get(GROUP, 500)).toEqual({ autoTitle: true });
  });

  test("nach manuellem Umbenennen keine automatische Vergabe", async () => {
    const env = await topicEnv(root);
    await created(env, false);
    const conversation = { id: "topic-500", title: "Neues Gespräch", agent: "research", lastActivity: null };
    expect((await env.manager.rename(conversation, 500, "Mein Titel")).status).toBe(200);
    env.feed.emit({ chatId: GROUP, content: "Erste Frage", metadata: { topicId: 500 } });
    await env.manager.idle();
    expect(edits(env)).toEqual([["editForumTopic", GROUP, 500, "Mein Titel"]]);
    expect((await readNames(env))["500"]).toBe("Mein Titel");
  });

  test("bereits gestartete Automatik überschreibt einen gleichzeitigen manuellen Titel nicht", async () => {
    const env = await topicEnv(root);
    await created(env, false);
    let open!: () => void;
    env.api.gate.editForumTopic = new Promise<void>(resolve => (open = resolve));
    env.feed.emit({ chatId: GROUP, content: "Automatischer Titel", metadata: { topicId: 500 } });
    await Bun.sleep(5);
    const conversation = { id: "topic-500", title: "Neues Gespräch", agent: "research", lastActivity: null };
    const renaming = env.manager.rename(conversation, 500, "Von Hand");
    await Bun.sleep(5);
    delete env.api.gate.editForumTopic;
    open();
    expect((await renaming).status).toBe(200);
    await env.manager.idle();
    expect(edits(env).map(c => c[3])).toEqual(["Automatischer Titel", "Von Hand"]);
    expect((await readNames(env))["500"]).toBe("Von Hand");
  });

  test("Telegram-Fehler: Titel Neues Gespräch bleibt, kein zweiter Versuch", async () => {
    const env = await topicEnv(root);
    await created(env, false);
    env.api.fail.editForumTopic = telegramError("Bad Request: TOPIC_ID_INVALID", 400, "editForumTopic");
    env.feed.emit({ chatId: GROUP, content: "Erste Frage", metadata: { topicId: 500 } });
    await env.manager.idle();
    delete env.api.fail.editForumTopic;
    env.feed.emit({ chatId: GROUP, content: "Zweite Frage", metadata: { topicId: 500 } });
    await env.manager.idle();
    expect(edits(env)).toHaveLength(1);
    expect((await readNames(env))["500"]).toBe("Neues Gespräch");
    expect(env.logs.some(l => l.includes("Automatischer Titel für Topic 500 nicht gesetzt"))).toBe(true);
    expect(env.logs.join("\n")).not.toContain("TOPIC_ID_INVALID");
  });

  test("TOPIC_NOT_MODIFIED gilt als Erfolg", async () => {
    const env = await topicEnv(root);
    await created(env, false);
    env.api.fail.editForumTopic = telegramError("Bad Request: TOPIC_NOT_MODIFIED", 400, "editForumTopic");
    env.feed.emit({ chatId: GROUP, content: "Gleich", metadata: { topicId: 500 } });
    await env.manager.idle();
    expect((await readNames(env))["500"]).toBe("Gleich");
  });

  test("Server-Stopp meldet den Zuhörer ab", async () => {
    const env = await topicEnv(root);
    const ctx = await created(env, false);
    expect(env.feed.listeners.size).toBe(2);
    await ctx.server.stop();
    servers.splice(servers.indexOf(ctx.server), 1);
    expect(env.feed.listeners.size).toBe(0);
  });
});
