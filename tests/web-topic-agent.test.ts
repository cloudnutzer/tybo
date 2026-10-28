/**
 * Issue #36, Checkbox 3: Agent eines Telegram-Topics ändern über
 * PATCH /api/conversations/topic-<n> mit { agent } oder { title, agent }.
 * Zuordnung über das echte setTopicMapping in einer temporären
 * config/topics.json, Telegram als Attrappe.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTopicMapping } from "../src/lib/topic-setup";
import type { WebServer } from "../src/web/server";
import { TEXT } from "../src/web/topics";
import { GROUP, readMapping, telegramError, topicEnv, topicServer, type TopicEnv } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "tybo-topic-agent-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

/** Topic 7 „Sieben" mit Agent research */
async function withTopic(overrides: Parameters<typeof topicEnv>[1] = {}): Promise<TopicEnv> {
  const env = await topicEnv(root, overrides);
  await env.names.saveTopicName(7, "Sieben");
  await setTopicMapping(GROUP, 7, "research", env.mappingFile);
  return env;
}

const PATH = "/api/conversations/topic-7";

describe("Agent ändern", () => {
  test("{ agent } schreibt die Zuordnung, ohne Telegram-Aufruf; Liste zeigt den neuen Agenten", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api(PATH, "PATCH", { agent: "finance" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversation).toEqual({ id: "topic-7", title: "Sieben", agent: "finance", lastActivity: null });
    expect(body.note).toBe(TEXT.agentChanged);
    expect((await readMapping(env))[GROUP]["7"]).toBe("finance");
    expect(env.api.calls).toEqual([]);
    const list = await (await ctx.api("/api/conversations")).json();
    expect(list.telegram.topics.find((t: any) => t.id === "topic-7").agent).toBe("finance");
    expect(ctx.logs.concat(env.logs)).toContain("Topic 7: Agent finance");
  });

  test("{ title, agent }: erst Telegram umbenennen, dann Zuordnung", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api(PATH, "PATCH", { title: "  Zahlen  ", agent: "finance" });
    expect(res.status).toBe(200);
    expect((await res.json()).conversation).toEqual({ id: "topic-7", title: "Zahlen", agent: "finance", lastActivity: null });
    expect(env.api.callsOf("editForumTopic")).toEqual([["editForumTopic", GROUP, 7, "Zahlen"]]);
    expect((await readMapping(env))[GROUP]["7"]).toBe("finance");
  });

  test("Umbenennen mit { title } allein bleibt wie bisher", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api(PATH, "PATCH", { title: "Neu" });
    expect(res.status).toBe(200);
    expect((await res.json()).conversation).toEqual({ id: "topic-7", title: "Neu", agent: "research", lastActivity: null });
    expect((await readMapping(env))[GROUP]["7"]).toBe("research");
  });

  test("ungültiger Agent oder Titel: 400 vor jeder Änderung", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    for (const agent of ["nobody", "cfo", "Finance", "", 5, null, ["finance"]]) {
      for (const extra of [{}, { title: "Gültig" }]) {
        const res = await ctx.api(PATH, "PATCH", { ...extra, agent });
        expect({ agent, extra, status: res.status }).toEqual({ agent, extra, status: 400 });
      }
    }
    for (const title of ["", "a".repeat(129), "Zeile\nzwei", 5]) {
      const res = await ctx.api(PATH, "PATCH", { title, agent: "finance" });
      expect({ title, status: res.status }).toEqual({ title, status: 400 });
    }
    expect(env.api.calls).toEqual([]);
    expect((await readMapping(env))[GROUP]["7"]).toBe("research");
  });

  test("Umbenennen scheitert: Agent bleibt unverändert", async () => {
    const env = await withTopic();
    env.api.fail.editForumTopic = telegramError("Bad Request: not enough rights to manage topics");
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api(PATH, "PATCH", { title: "Neu", agent: "finance" });
    expect(res.status).toBe(403);
    expect((await readMapping(env))[GROUP]["7"]).toBe("research");
  });

  test("Zuordnung nicht schreibbar: 500, mit Titel eigene Meldung", async () => {
    const env = await withTopic({
      setMapping: async () => {
        throw new Error("EACCES /geheim/topics.json");
      },
    });
    const ctx = await topicServer(root, servers, env);
    let res = await ctx.api(PATH, "PATCH", { agent: "finance" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: TEXT.agentNotSaved });
    res = await ctx.api(PATH, "PATCH", { title: "Neu", agent: "finance" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe(TEXT.renamedAgentNotSaved);
    expect(body.conversation.title).toBe("Neu");
    expect(env.logs.join("\n")).not.toContain("/geheim");
  });

  test("dm und General 405, unbekanntes und gelöschtes Topic 404", async () => {
    const env = await withTopic();
    await setTopicMapping(GROUP, 9, "critic", env.mappingFile);
    await env.names.saveTopicName(9, "Neun");
    await env.state.setFlag(GROUP, 9, "deleted", true);
    const ctx = await topicServer(root, servers, env);
    for (const id of ["dm", "topic-1"]) {
      const res = await ctx.api(`/api/conversations/${id}`, "PATCH", { agent: "finance" });
      expect({ id, status: res.status }).toEqual({ id, status: 405 });
    }
    expect((await ctx.api("/api/conversations/topic-12345", "PATCH", { agent: "finance" })).status).toBe(404);
    expect((await ctx.api("/api/conversations/topic-9", "PATCH", { agent: "finance" })).status).toBe(404);
    const mapping = (await readMapping(env))[GROUP];
    expect(mapping).toEqual({ "7": "research", "9": "critic" });
  });

  test("gleichzeitig mit Löschen: nach dem Löschen 404, keine Zuordnung kommt zurück", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    let open!: () => void;
    env.api.gate.deleteForumTopic = new Promise<void>(resolve => (open = resolve));
    const deleting = ctx.api(PATH, "DELETE", { confirm: "Sieben" });
    await waitUntil(() => env.api.callsOf("deleteForumTopic").length === 1);
    const changing = ctx.api(PATH, "PATCH", { agent: "finance" });
    await Bun.sleep(20);
    open();
    expect((await deleting).status).toBe(200);
    expect((await changing).status).toBe(404);
    expect((await readMapping(env))[GROUP]?.["7"]).toBeUndefined();
  });

  test("ohne Anmeldung 401, fremder Origin 403, ohne Topic-Verwaltung 503", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    const noCookie = await fetch(`${ctx.origin}${PATH}`, { method: "PATCH", headers: { origin: ctx.origin }, body: JSON.stringify({ agent: "finance" }) });
    expect(noCookie.status).toBe(401);
    const foreign = await ctx.api(PATH, "PATCH", { agent: "finance" }, { origin: "http://evil.example" });
    expect(foreign.status).toBe(403);
    expect((await readMapping(env))[GROUP]["7"]).toBe("research");

    const bare = await topicServer(root, servers, env, { topics: undefined });
    expect((await bare.api(PATH, "PATCH", { agent: "finance" })).status).toBe(503);
  });
});
