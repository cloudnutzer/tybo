/**
 * Issue #29, Checkbox 4: POST /api/conversations legt ein Telegram-Topic an
 * (Entscheidung 0005), ohne Rückfall auf ein Web-Gespräch.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebServer } from "../src/web/server";
import { BOT_TOKEN, GROUP, readMapping, readNames, telegramError, topicEnv, topicServer, type ServerCtx, type TopicEnv } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "bot-topics-create-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

/** Kein Web-Gespräch: weder in der Liste noch als Datei */
async function noWebConversation(ctx: ServerCtx): Promise<void> {
  expect((await (await ctx.api("/api/conversations")).json()).conversations).toEqual([]);
  expect(await ctx.store.listConversations()).toEqual([]);
}

async function noTopicCreated(env: TopicEnv): Promise<void> {
  expect(env.api.callsOf("createForumTopic")).toEqual([]);
  expect(await readMapping(env)).toEqual({});
  expect(await readNames(env)).toEqual({});
}

describe("POST /api/conversations legt ein Topic an", () => {
  test("mit Agent: createForumTopic, Zuordnung, Name, autoTitle; 201 mit topic-<n>", async () => {
    const env = await topicEnv(root);
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api("/api/conversations", "POST", { agent: "research" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ conversation: { id: "topic-500", title: "Neues Gespräch", agent: "research", lastActivity: null } });
    expect(env.api.callsOf("createForumTopic")).toEqual([["createForumTopic", GROUP, "Neues Gespräch"]]);
    expect((await readMapping(env))[GROUP]).toEqual({ "500": "research" });
    expect(await readNames(env)).toEqual({ "500": "Neues Gespräch" });
    expect(await env.state.get(GROUP, 500)).toEqual({ autoTitle: true });
    // Liste und Einzelabruf kennen das Topic sofort
    const list = await (await ctx.api("/api/conversations")).json();
    expect(list.telegram.topics.find((t: any) => t.id === "topic-500")).toEqual({ id: "topic-500", title: "Neues Gespräch", agent: "research", lastActivity: null });
    expect((await ctx.api("/api/conversations/topic-500")).status).toBe(200);
    await noWebConversation(ctx);
  });

  test("ohne Body und mit leerem Objekt: Agent general", async () => {
    const env = await topicEnv(root);
    const ctx = await topicServer(root, servers, env);
    expect((await (await ctx.api("/api/conversations", "POST")).json()).conversation.agent).toBe("general");
    expect((await (await ctx.api("/api/conversations", "POST", {})).json()).conversation).toMatchObject({ id: "topic-501", agent: "general" });
    expect((await readMapping(env))[GROUP]).toEqual({ "500": "general", "501": "general" });
  });

  test("unbekannter Agent: 400, nichts angelegt", async () => {
    const env = await topicEnv(root);
    const ctx = await topicServer(root, servers, env);
    expect((await ctx.api("/api/conversations", "POST", { agent: "hacker" })).status).toBe(400);
    await noTopicCreated(env);
  });

  test("ohne Forum-Gruppe: 409 no_group", async () => {
    const env = await topicEnv(root);
    env.group.id = null;
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api("/api/conversations", "POST", { agent: "research" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Keine Forum-Gruppe eingerichtet (TELEGRAM_GROUP_ID)", reason: "no_group" });
    await noTopicCreated(env);
    await noWebConversation(ctx);
  });

  test("ohne Recht Topics verwalten: 403 no_manage_topics", async () => {
    const env = await topicEnv(root);
    env.api.rights = { manageTopics: false, deleteMessages: true };
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api("/api/conversations", "POST", {});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Dem Bot fehlt in der Gruppe das Recht ‚Topics verwalten'", reason: "no_manage_topics" });
    await noTopicCreated(env);
    await noWebConversation(ctx);
  });

  test("Rechteabfrage kaputt: 502, nicht als fehlendes Recht", async () => {
    const env = await topicEnv(root);
    env.api.rightsError = telegramError("Internal Server Error", 500, "getChatMember");
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api("/api/conversations", "POST", {});
    expect(res.status).toBe(502);
    expect((await res.json()).reason).toBeUndefined();
    await noTopicCreated(env);
    await noWebConversation(ctx);
  });

  test("ohne Topic-Verwaltung: 503, kein Web-Gespräch", async () => {
    const ctx = await topicServer(root, servers, null);
    const res = await ctx.api("/api/conversations", "POST", { agent: "research" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Topics verwalten ist nicht eingerichtet");
    await noWebConversation(ctx);
  });

  test("Telegram lehnt ab: not enough rights 403, sonst 502; ohne Token und Rohtext", async () => {
    const env = await topicEnv(root);
    const ctx = await topicServer(root, servers, env);
    env.api.fail.createForumTopic = telegramError("Bad Request: not enough rights to create a topic", 400, "createForumTopic");
    const denied = await ctx.api("/api/conversations", "POST", {});
    expect(denied.status).toBe(403);
    expect((await denied.json()).reason).toBe("no_manage_topics");
    env.api.fail.createForumTopic = telegramError("Bad Request: CHAT_NOT_MODIFIED geheim", 400, "createForumTopic");
    const failed = await ctx.api("/api/conversations", "POST", {});
    expect(failed.status).toBe(502);
    const text = await failed.text();
    expect(JSON.parse(text)).toEqual({ error: "Telegram hat die Aktion abgelehnt" });
    const all = text + env.logs.join("\n") + ctx.logs.join("\n");
    expect(all).not.toContain(BOT_TOKEN);
    expect(all).not.toContain("geheim");
    expect(all).not.toContain("api.telegram.org");
    expect(env.logs).toContain("Telegram createForumTopic fehlgeschlagen (Code 400)");
    expect(await readMapping(env)).toEqual({});
    await noWebConversation(ctx);
  });

  test("Teilerfolg: Zuordnung nicht gespeichert ergibt 500 mit conversation, Topic bleibt, Log mit Topic-ID", async () => {
    const env = await topicEnv(root, {
      setMapping: async () => {
        throw new Error("EACCES /Users/x/config/topics.json");
      },
    });
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api("/api/conversations", "POST", { agent: "finance" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: "Topic angelegt, Agent-Zuordnung nicht gespeichert",
      conversation: { id: "topic-500", title: "Neues Gespräch", agent: "finance", lastActivity: null },
    });
    expect(env.api.callsOf("deleteForumTopic")).toEqual([]);
    // Name und Zustand wurden trotzdem versucht und gespeichert
    expect(await readNames(env)).toEqual({ "500": "Neues Gespräch" });
    expect(await env.state.get(GROUP, 500)).toEqual({ autoTitle: true });
    const line = env.logs.find(l => l.includes("Topic 500 angelegt, nicht gespeichert"));
    expect(line).toContain("Zuordnung");
    expect(line).not.toContain("/Users/x");
    await noWebConversation(ctx);
  });

  test("Teilerfolg: Zustand nicht gespeichert ergibt ebenfalls 500", async () => {
    const env = await topicEnv(root);
    const ctx = await topicServer(root, servers, env);
    // Topic-Zustand als Verzeichnis: Schreiben schlägt fehl
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(env.stateFile, "x"), { recursive: true });
    const res = await ctx.api("/api/conversations", "POST", {});
    expect(res.status).toBe(500);
    expect((await res.json()).conversation.id).toBe("topic-500");
    expect((await readMapping(env))[GROUP]).toEqual({ "500": "general" });
  });

  test("ohne Anmeldung 401, fremder Origin 403, nichts angelegt", async () => {
    const env = await topicEnv(root);
    const ctx = await topicServer(root, servers, env);
    expect((await fetch(`${ctx.origin}/api/conversations`, { method: "POST", headers: { origin: ctx.origin }, body: "{}" })).status).toBe(401);
    expect((await ctx.api("/api/conversations", "POST", {}, { origin: "http://evil.example" })).status).toBe(403);
    await noTopicCreated(env);
    expect(await readdir(env.dir)).toEqual([]);
  });
});
