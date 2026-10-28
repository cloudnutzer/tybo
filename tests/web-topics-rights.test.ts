/**
 * Issue #29, Checkbox 2: TelegramTopicApi, Rechteprüfung, Fehlerabbildung
 * und GET /api/telegram/rights. Telegram ist eine Attrappe.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebServer } from "../src/web/server";
import { isNotEnoughRights, isTopicNotModified, rightsFromChatMember, RIGHTS_CACHE_MS } from "../src/web/topics";
import { BOT_TOKEN, GROUP, telegramError, topicEnv, topicServer } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "bot-topics-rights-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

describe("rightsFromChatMember", () => {
  test("creator hat alle Rechte", () => {
    expect(rightsFromChatMember({ status: "creator" })).toEqual({ manageTopics: true, deleteMessages: true });
  });
  test("Administrator nach can_manage_topics und can_delete_messages", () => {
    expect(rightsFromChatMember({ status: "administrator", can_manage_topics: true, can_delete_messages: false })).toEqual({
      manageTopics: true,
      deleteMessages: false,
    });
    expect(rightsFromChatMember({ status: "administrator", can_manage_topics: true, can_delete_messages: true })).toEqual({
      manageTopics: true,
      deleteMessages: true,
    });
    expect(rightsFromChatMember({ status: "administrator" })).toEqual({ manageTopics: false, deleteMessages: false });
    // Nur echtes true zählt
    expect(rightsFromChatMember({ status: "administrator", can_manage_topics: "true" })).toEqual({ manageTopics: false, deleteMessages: false });
  });
  test("einfaches Mitglied, eingeschränkt, ausgetreten, Unsinn: keine Rechte", () => {
    for (const member of [{ status: "member" }, { status: "restricted", can_manage_topics: true }, { status: "left" }, null, "x", {}]) {
      expect(rightsFromChatMember(member)).toEqual({ manageTopics: false, deleteMessages: false });
    }
  });
});

describe("Fehlerabbildung", () => {
  test("TOPIC_NOT_MODIFIED und not enough rights werden erkannt", () => {
    expect(isTopicNotModified(telegramError("Bad Request: TOPIC_NOT_MODIFIED"))).toBe(true);
    expect(isTopicNotModified(telegramError("Bad Request: message thread not found"))).toBe(false);
    expect(isNotEnoughRights(telegramError("Bad Request: not enough rights to manage topics"))).toBe(true);
    expect(isNotEnoughRights(telegramError("Forbidden: bot was kicked"))).toBe(false);
    expect(isNotEnoughRights(null)).toBe(false);
  });
});

describe("GET /api/telegram/rights", () => {
  test("Issue #228: ohne Topic-Verwaltung (kein Telegram) keine Gruppe, keine Rechte, 200", async () => {
    const ctx = await topicServer(root, servers, null);
    const res = await ctx.api("/api/telegram/rights");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ manageTopics: false, deleteMessages: false, group: false });
  });

  test("Administrator mit beiden Rechten", async () => {
    const env = await topicEnv(root);
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api("/api/telegram/rights");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ manageTopics: true, deleteMessages: true, group: true });
    expect(env.api.callsOf("getMyRights")).toEqual([["getMyRights", GROUP]]);
  });

  test("Administrator ohne Recht Nachrichten löschen (Stand 24.9.)", async () => {
    const env = await topicEnv(root);
    env.api.rights = { manageTopics: true, deleteMessages: false };
    const ctx = await topicServer(root, servers, env);
    expect(await (await ctx.api("/api/telegram/rights")).json()).toEqual({ manageTopics: true, deleteMessages: false, group: true });
  });

  test("einfaches Mitglied: keine Rechte", async () => {
    const env = await topicEnv(root);
    env.api.rights = rightsFromChatMember({ status: "member" });
    const ctx = await topicServer(root, servers, env);
    expect(await (await ctx.api("/api/telegram/rights")).json()).toEqual({ manageTopics: false, deleteMessages: false, group: true });
  });

  test("creator: alle Rechte", async () => {
    const env = await topicEnv(root);
    env.api.rights = rightsFromChatMember({ status: "creator" });
    const ctx = await topicServer(root, servers, env);
    expect(await (await ctx.api("/api/telegram/rights")).json()).toEqual({ manageTopics: true, deleteMessages: true, group: true });
  });

  test("keine Forum-Gruppe: alles false, keine Abfrage", async () => {
    const env = await topicEnv(root);
    env.group.id = null;
    const ctx = await topicServer(root, servers, env);
    expect(await (await ctx.api("/api/telegram/rights")).json()).toEqual({ manageTopics: false, deleteMessages: false, group: false });
    expect(env.api.callsOf("getMyRights")).toEqual([]);
  });

  test("Abfragefehler: 502 ohne Token oder Rohtext, gilt nie als fehlendes Recht, wird nicht gespeichert", async () => {
    const env = await topicEnv(root);
    env.api.rightsError = telegramError("Bad Request: chat not found", 400, "getChatMember");
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api("/api/telegram/rights");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(BOT_TOKEN);
    expect(text).not.toContain("chat not found");
    expect(text).not.toContain("api.telegram.org");
    expect(JSON.parse(text).manageTopics).toBeUndefined();
    const logs = env.logs.join("\n") + ctx.logs.join("\n");
    expect(logs).not.toContain(BOT_TOKEN);
    expect(logs).not.toContain("chat not found");
    expect(logs).toContain("getChatMember");
    expect(logs).toContain("400");
    // Fehler nicht zwischengespeichert: der nächste Aufruf fragt neu
    env.api.rightsError = null;
    expect((await ctx.api("/api/telegram/rights")).status).toBe(200);
    expect(env.api.callsOf("getMyRights")).toHaveLength(2);
  });

  test("Rechte höchstens 60 s zwischengespeichert, getrennt nach Gruppe", async () => {
    const env = await topicEnv(root);
    const ctx = await topicServer(root, servers, env);
    await ctx.api("/api/telegram/rights");
    env.api.rights = { manageTopics: true, deleteMessages: false };
    env.now.t += RIGHTS_CACHE_MS - 1;
    expect((await (await ctx.api("/api/telegram/rights")).json()).deleteMessages).toBe(true);
    expect(env.api.callsOf("getMyRights")).toHaveLength(1);
    // Andere Gruppe: eigene Abfrage
    env.group.id = "-100555";
    expect((await (await ctx.api("/api/telegram/rights")).json()).deleteMessages).toBe(false);
    expect(env.api.calls.at(-1)).toEqual(["getMyRights", "-100555"]);
    env.group.id = GROUP;
    env.now.t += 1;
    expect((await (await ctx.api("/api/telegram/rights")).json()).deleteMessages).toBe(false);
    expect(env.api.callsOf("getMyRights")).toHaveLength(3);
  });

  test("nur GET; ohne Anmeldung 401", async () => {
    const env = await topicEnv(root);
    const ctx = await topicServer(root, servers, env);
    expect((await ctx.api("/api/telegram/rights", "POST", {})).status).toBe(405);
    expect((await fetch(`${ctx.origin}/api/telegram/rights`)).status).toBe(401);
    // Fremder Origin: lesende Anfragen prüft der Server wie bisher nicht (nur schreibende, siehe Löschen/Anlegen)
    expect(env.api.callsOf("getMyRights")).toEqual([]);
  });
});
