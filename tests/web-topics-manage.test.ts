/**
 * Issue #29, Checkbox 6: Umbenennen, Schließen und Öffnen von Topics,
 * 409 beim Schreiben in geschlossene Topics, geschützte IDs (dm, General),
 * unbekannte Topics, Anmeldung und Origin. Ältere Web-Gespräche (UUID)
 * lassen sich weiter umbenennen und löschen.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTopicMapping } from "../src/lib/topic-setup";
import type { WebServer } from "../src/web/server";
import { BOT_TOKEN, GROUP, HoldChat, readNames, telegramError, topicEnv, topicServer, topicSource, type TopicEnv } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "bot-topics-manage-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

/** Topic 7 „Sieben" mit Agent research */
async function withTopic(): Promise<TopicEnv> {
  const env = await topicEnv(root);
  await env.names.saveTopicName(7, "Sieben");
  await setTopicMapping(GROUP, 7, "research", env.mappingFile);
  return env;
}

describe("Umbenennen (PATCH topic-<n>)", () => {
  test("erfolgreich: Telegram-Aufruf, Name gespeichert, Liste zeigt den neuen Titel, autoTitle weg", async () => {
    const env = await withTopic();
    await env.state.setFlag(GROUP, 7, "autoTitle", true);
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api("/api/conversations/topic-7", "PATCH", { title: "  Reise nach Rom  " });
    expect(res.status).toBe(200);
    expect((await res.json()).conversation).toEqual({ id: "topic-7", title: "Reise nach Rom", agent: "research", lastActivity: null });
    expect(env.api.callsOf("editForumTopic")).toEqual([["editForumTopic", GROUP, 7, "Reise nach Rom"]]);
    expect((await readNames(env))["7"]).toBe("Reise nach Rom");
    expect(await env.state.get(GROUP, 7)).toEqual({});
    const list = await (await ctx.api("/api/conversations")).json();
    expect(list.telegram.topics.find((t: any) => t.id === "topic-7").title).toBe("Reise nach Rom");
  });

  test("Grenzen: 0 und 129 Zeichen 400, 128 Zeichen ok, Steuerzeichen 400, typfalsch 400", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    for (const title of ["", "   ", "a".repeat(129), "Zeile\nzwei", "Tab\tdrin", "nul\u0000", 5, null, undefined]) {
      const res = await ctx.api("/api/conversations/topic-7", "PATCH", { title });
      expect({ title, status: res.status }).toEqual({ title, status: 400 });
    }
    for (const body of ["{kaputt", "[1]", '"x"']) expect((await ctx.api("/api/conversations/topic-7", "PATCH", body)).status).toBe(400);
    expect(env.api.callsOf("editForumTopic")).toEqual([]);
    const max = "ä".repeat(127) + "😀";
    const ok = await ctx.api("/api/conversations/topic-7", "PATCH", { title: max });
    expect(ok.status).toBe(200);
    expect((await ok.json()).conversation.title).toBe(max);
  });

  test("TOPIC_NOT_MODIFIED gilt als Erfolg", async () => {
    const env = await withTopic();
    env.api.fail.editForumTopic = telegramError("Bad Request: TOPIC_NOT_MODIFIED", 400, "editForumTopic");
    const ctx = await topicServer(root, servers, env);
    expect((await ctx.api("/api/conversations/topic-7", "PATCH", { title: "Sieben" })).status).toBe(200);
  });

  test("Telegram-Fehler: not enough rights 403, sonst 502; Name bleibt", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    env.api.fail.editForumTopic = telegramError("Bad Request: not enough rights to manage topics", 400, "editForumTopic");
    const denied = await ctx.api("/api/conversations/topic-7", "PATCH", { title: "Neu" });
    expect(denied.status).toBe(403);
    expect((await denied.json()).reason).toBe("no_manage_topics");
    env.api.fail.editForumTopic = telegramError(`Bad Request: kaputt ${BOT_TOKEN}`, 400, "editForumTopic");
    const failed = await ctx.api("/api/conversations/topic-7", "PATCH", { title: "Neu" });
    expect(failed.status).toBe(502);
    const text = await failed.text();
    expect(text).not.toContain(BOT_TOKEN);
    expect(env.logs.join("\n")).not.toContain(BOT_TOKEN);
    expect((await readNames(env))["7"]).toBe("Sieben");
  });

  test("lokaler Fehler nach erfolgreichem Umbenennen: 500 mit Meldung und neuem Titel", async () => {
    const env = await topicEnv(root, {
      saveName: async () => {
        throw new Error("EACCES");
      },
    });
    await setTopicMapping(GROUP, 7, "research", env.mappingFile);
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api("/api/conversations/topic-7", "PATCH", { title: "Neu" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "In Telegram umbenannt, Name in der WebUI nicht gespeichert",
      conversation: { id: "topic-7", title: "Neu", agent: "research", lastActivity: null },
    });
  });
});

describe("Schließen und Öffnen", () => {
  test("Liste zeigt closed, Zustand übersteht einen Neustart, reopen entfernt es", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    const closed = await ctx.api("/api/conversations/topic-7/close", "POST");
    expect(closed.status).toBe(200);
    expect((await closed.json()).conversation).toMatchObject({ id: "topic-7", closed: true });
    expect(env.api.callsOf("closeForumTopic")).toEqual([["closeForumTopic", GROUP, 7]]);
    const list = await (await ctx.api("/api/conversations")).json();
    expect(list.telegram.topics.find((t: any) => t.id === "topic-7").closed).toBe(true);
    expect((await (await ctx.api("/api/conversations/topic-7")).json()).conversation.closed).toBe(true);
    // Neustart: neue Instanzen lesen die Datei
    expect((await topicSource(env, true).getConversation("topic-7"))?.closed).toBe(true);

    const reopened = await ctx.api("/api/conversations/topic-7/reopen", "POST");
    expect(reopened.status).toBe(200);
    expect("closed" in (await reopened.json()).conversation).toBe(false);
    expect(env.api.callsOf("reopenForumTopic")).toEqual([["reopenForumTopic", GROUP, 7]]);
    expect((await topicSource(env, true).getConversation("topic-7"))?.closed).toBeUndefined();
  });

  test("TOPIC_NOT_MODIFIED gilt bei Schließen und Öffnen als Erfolg", async () => {
    const env = await withTopic();
    env.api.fail.closeForumTopic = telegramError("Bad Request: TOPIC_NOT_MODIFIED", 400, "closeForumTopic");
    env.api.fail.reopenForumTopic = telegramError("Bad Request: TOPIC_NOT_MODIFIED", 400, "reopenForumTopic");
    const ctx = await topicServer(root, servers, env);
    expect((await ctx.api("/api/conversations/topic-7/close", "POST")).status).toBe(200);
    expect(await env.state.get(GROUP, 7)).toEqual({ closed: true });
    expect((await ctx.api("/api/conversations/topic-7/reopen", "POST")).status).toBe(200);
    expect(await env.state.get(GROUP, 7)).toEqual({});
  });

  test("Telegram-Fehler beim Schließen: 502, Zustand bleibt offen; lokaler Fehler danach 500", async () => {
    const env = await withTopic();
    env.api.fail.closeForumTopic = telegramError("Bad Request: TOPIC_ID_INVALID", 400, "closeForumTopic");
    const ctx = await topicServer(root, servers, env);
    expect((await ctx.api("/api/conversations/topic-7/close", "POST")).status).toBe(502);
    expect(await env.state.get(GROUP, 7)).toEqual({});

    const broken = await topicEnv(root, {
      state: {
        ...env.state,
        forChat: c => env.state.forChat(c),
        get: (c, t) => env.state.get(c, t),
        claimAutoTitle: (c, t) => env.state.claimAutoTitle(c, t),
        setFlag: async () => {
          throw new Error("EACCES");
        },
      },
    });
    await setTopicMapping(GROUP, 7, "research", broken.mappingFile);
    const ctx2 = await topicServer(root, servers, broken);
    const res = await ctx2.api("/api/conversations/topic-7/close", "POST");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("In Telegram geändert, Zustand in der WebUI nicht gespeichert");
  });

  test("Schreiben ins geschlossene Topic: 409 mit closed, kein Turn; nach Öffnen 202", async () => {
    const env = await withTopic();
    const chat = new HoldChat();
    const ctx = await topicServer(root, servers, env, { telegramChat: chat });
    await ctx.api("/api/conversations/topic-7/close", "POST");
    const res = await ctx.api("/api/conversations/topic-7/messages", "POST", { text: "Hallo" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Das Topic ist geschlossen. Erst wieder öffnen.", closed: true });
    expect(chat.turns).toEqual([]);
    await ctx.api("/api/conversations/topic-7/reopen", "POST");
    expect((await ctx.api("/api/conversations/topic-7/messages", "POST", { text: "Hallo" })).status).toBe(202);
  });

  test("nur POST", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    expect((await ctx.api("/api/conversations/topic-7/close")).status).toBe(405);
    expect((await ctx.api("/api/conversations/topic-7/reopen", "PATCH", {})).status).toBe(405);
  });
});

describe("geschützte und unbekannte IDs", () => {
  test("dm und topic-1: 405 für PATCH, close, reopen und DELETE, kein Telegram-Aufruf", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    for (const id of ["dm", "topic-1"]) {
      for (const [path, method, body] of [
        [`/api/conversations/${id}`, "PATCH", { title: "X" }],
        [`/api/conversations/${id}/close`, "POST"],
        [`/api/conversations/${id}/reopen`, "POST"],
        [`/api/conversations/${id}`, "DELETE", { confirm: id === "dm" ? "Direktchat" : "General" }],
      ] as [string, string, unknown?][]) {
        expect({ path, method, status: (await ctx.api(path, method, body)).status }).toEqual({ path, method, status: 405 });
      }
    }
    expect(env.api.calls.filter(c => c[0] !== "getMyRights")).toEqual([]);
  });

  test("unbekanntes topic-<n>: 404 für PATCH, close, reopen und DELETE", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    for (const [path, method, body] of [
      ["/api/conversations/topic-999", "PATCH", { title: "X" }],
      ["/api/conversations/topic-999/close", "POST"],
      ["/api/conversations/topic-999/reopen", "POST"],
      ["/api/conversations/topic-999", "DELETE", { confirm: "Topic 999" }],
    ] as [string, string, unknown?][]) {
      expect({ path, method, status: (await ctx.api(path, method, body)).status }).toEqual({ path, method, status: 404 });
    }
    expect(env.api.calls).toEqual([]);
  });

  test("ohne Topic-Verwaltung: 503 statt Aktion", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env, { topics: undefined });
    expect((await ctx.api("/api/conversations/topic-7", "PATCH", { title: "X" })).status).toBe(503);
    expect((await ctx.api("/api/conversations/topic-7/close", "POST")).status).toBe(503);
  });

  test("ohne Anmeldung 401, fremder Origin 403", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    for (const [path, method] of [
      ["/api/conversations/topic-7", "PATCH"],
      ["/api/conversations/topic-7/close", "POST"],
      ["/api/conversations/topic-7/reopen", "POST"],
      ["/api/conversations/topic-7", "DELETE"],
    ]) {
      const anon = await fetch(`${ctx.origin}${path}`, { method, headers: { origin: ctx.origin }, body: JSON.stringify({ title: "X", confirm: "Sieben" }) });
      expect({ path, method, status: anon.status }).toEqual({ path, method, status: 401 });
      const foreign = await ctx.api(path, method, { title: "X", confirm: "Sieben" }, { origin: "http://evil.example" });
      expect({ path, method, status: foreign.status }).toEqual({ path, method, status: 403 });
    }
    expect(env.api.calls).toEqual([]);
  });
});

describe("ältere Web-Gespräche (UUID) daneben", () => {
  test("umbenennen und löschen wie bisher; close gibt es dort nicht", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    const old = await ctx.store.createConversation("finance");
    const renamed = await ctx.api(`/api/conversations/${old.id}`, "PATCH", { title: "Altes Gespräch" });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).conversation.title).toBe("Altes Gespräch");
    expect((await ctx.api(`/api/conversations/${old.id}/close`, "POST")).status).toBe(404);
    expect((await ctx.api(`/api/conversations/${old.id}`, "DELETE")).status).toBe(200);
    expect((await ctx.api(`/api/conversations/${old.id}`)).status).toBe(404);
    expect(env.api.calls).toEqual([]);
  });
});
