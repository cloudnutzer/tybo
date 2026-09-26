/**
 * Issue #29, Checkbox 7: Hilfsfunktionen in src/lib/execution-context.ts
 * und Löschen eines Topics mit allen Schutzregeln (Name, Recht, Web-Turn,
 * Telegram-Ausführungen jedes Agenten, Sperre bis zum Aufräumen,
 * Rücknahme bei Telegram-Fehlern, unvollständiges Aufräumen).
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortExecutions,
  blockExecutions,
  isExecutionActive,
  isExecutionBlocked,
  runCancelable,
  runExecution,
  waitForExecutions,
} from "../src/lib/execution-context";
import { setTopicMapping } from "../src/lib/topic-setup";
import { botExecutions } from "../src/web/bot-topics";
import type { WebServer } from "../src/web/server";
import type { ExecutionPort } from "../src/web/topics";
import {
  BOT_TOKEN,
  GROUP,
  HoldChat,
  readMapping,
  readNames,
  telegramError,
  topicEnv,
  topicLive,
  topicServer,
  topicSource,
  type ServerCtx,
  type TopicEnv,
} from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "bot-topics-delete-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

const KEY = `topic:${GROUP}:7`;

/** Hält eine Ausführung offen, bis release() */
function held() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  return { gate, release };
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

describe("execution-context: aktiv, sperren, warten", () => {
  test("isExecutionActive: jeder Agent, Update-Bereich und wartende Ausführung", async () => {
    const key = "topic:-100:11";
    expect(isExecutionActive(key)).toBe(false);
    const a = held();
    const running = runExecution(key, "finance", () => a.gate);
    expect(isExecutionActive(key)).toBe(true);
    expect(isExecutionActive("topic:-100:1")).toBe(false);
    a.release();
    await running;
    expect(isExecutionActive(key)).toBe(false);

    const b = held();
    const update = runCancelable(key, () => b.gate);
    expect(isExecutionActive(key)).toBe(true);
    b.release();
    await update;

    // Wartend: die Kapazität (3) ist mit anderen Schlüsseln belegt
    const blockers = [held(), held(), held()];
    const busy = blockers.map((h, i) => runExecution(`other-${i}`, "general", () => h.gate));
    let ran = false;
    const waiting = runExecution(key, "research", async () => {
      ran = true;
    });
    await Bun.sleep(5);
    expect(ran).toBe(false);
    expect(isExecutionActive(key)).toBe(true);
    for (const h of blockers) h.release();
    await Promise.all([...busy, waiting]);
    expect(ran).toBe(true);
    expect(isExecutionActive(key)).toBe(false);
  });

  test("blockExecutions: neue Ausführungen enden sofort mit AbortError, andere Schlüssel laufen, Freigabe hebt auf", async () => {
    const key = "topic:-100:12";
    const release = blockExecutions(key);
    expect(isExecutionBlocked(key)).toBe(true);
    let called = false;
    await expect(runExecution(key, "general", async () => void (called = true))).rejects.toMatchObject({ name: "AbortError" });
    await expect(runCancelable(key, async () => void (called = true))).rejects.toMatchObject({ name: "AbortError" });
    expect(called).toBe(false);
    expect(await runExecution("topic:-100:13", "general", async () => "ok")).toBe("ok");
    release();
    release();
    expect(isExecutionBlocked(key)).toBe(false);
    expect(await runCancelable(key, async () => "wieder")).toBe("wieder");
  });

  test("waitForExecutions: true sobald frei, false nach Ablauf der Frist", async () => {
    const key = "topic:-100:14";
    expect(await waitForExecutions(key, 10)).toBe(true);
    const h = held();
    const running = runCancelable(key, () => h.gate);
    expect(await waitForExecutions(key, 30, 5)).toBe(false);
    setTimeout(() => h.release(), 20);
    expect(await waitForExecutions(key, 1000, 5)).toBe(true);
    await running;
  });
});

/** Topic 7 „Sieben" (finance) mit Supabase-Verlauf */
async function withTopic(overrides: Parameters<typeof topicEnv>[1] = {}): Promise<TopicEnv> {
  const env = await topicEnv(root, overrides);
  await env.names.saveTopicName(7, "Sieben");
  await setTopicMapping(GROUP, 7, "finance", env.mappingFile);
  await setTopicMapping(GROUP, 8, "research", env.mappingFile);
  env.messages.add(7, "Wie hoch ist das Budget?");
  return env;
}

const del = (ctx: ServerCtx, confirm: unknown = "Sieben", id = "topic-7") => ctx.api(`/api/conversations/${id}`, "DELETE", confirm === undefined ? undefined : { confirm });

describe("DELETE topic-<n>: Prüfungen vor dem Löschen", () => {
  test("falscher oder fehlender Name: 400, nichts passiert", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    expect((await ctx.api("/api/conversations/topic-7", "DELETE")).status).toBe(400);
    expect((await ctx.api("/api/conversations/topic-7", "DELETE", {})).status).toBe(400);
    for (const confirm of ["", "sieben", " Sieben", "Sieben ", 7, null]) {
      expect((await del(ctx, confirm)).status).toBe(400);
    }
    expect((await ctx.api("/api/conversations/topic-7", "DELETE", "{kaputt")).status).toBe(400);
    expect(env.api.calls).toEqual([]);
    expect(await env.state.get(GROUP, 7)).toEqual({});
  });

  test("ohne Recht Nachrichten löschen: 403 no_delete_messages; Rechteabfrage kaputt: 502", async () => {
    const env = await withTopic();
    env.api.rights = { manageTopics: true, deleteMessages: false };
    const ctx = await topicServer(root, servers, env);
    const res = await del(ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Dem Bot fehlt in der Gruppe das Recht ‚Nachrichten löschen'", reason: "no_delete_messages" });

    const env2 = await withTopic();
    env2.api.rightsError = telegramError("Bad Gateway", 502, "getChatMember");
    const ctx2 = await topicServer(root, servers, env2);
    expect((await del(ctx2)).status).toBe(502);
    for (const e of [env, env2]) {
      expect(e.api.callsOf("deleteForumTopic")).toEqual([]);
      expect(await e.state.get(GROUP, 7)).toEqual({});
    }
  });

  test("laufender Web-Turn: 409, danach möglich", async () => {
    const env = await withTopic();
    const chat = new HoldChat();
    chat.hold = true;
    const ctx = await topicServer(root, servers, env, { telegramChat: chat });
    expect((await ctx.api("/api/conversations/topic-7/messages", "POST", { text: "lange Frage" })).status).toBe(202);
    await waitUntil(() => chat.turns.length === 1);
    const busy = await del(ctx);
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toBe("In diesem Topic läuft gerade eine Antwort");
    expect(env.api.callsOf("deleteForumTopic")).toEqual([]);
    chat.release();
    await waitUntil(async () => !(await (await ctx.api("/api/conversations/topic-7")).json()).running);
    expect((await del(ctx)).status).toBe(200);
  });

  test("Umbenennen läuft, DELETE bestätigt den alten Namen: nach dem Umbenennen 400, kein deleteForumTopic", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    const edit = held();
    env.api.gate.editForumTopic = edit.gate;
    const rename = ctx.api("/api/conversations/topic-7", "PATCH", { title: "Acht" });
    await waitUntil(() => env.api.callsOf("editForumTopic").length === 1);
    // Der alte Name passt beim Eingang noch, das Löschen wartet auf die Topic-Sperre
    const deleting = del(ctx, "Sieben");
    await waitUntil(() => env.api.callsOf("getMyRights").length === 1);
    await Bun.sleep(20);
    edit.release();
    expect((await rename).status).toBe(200);
    const res = await deleting;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Zum Löschen den genauen Namen des Topics angeben" });
    expect(env.api.callsOf("deleteForumTopic")).toEqual([]);
    expect(await env.state.get(GROUP, 7)).toEqual({});
    expect((await readNames(env))["7"]).toBe("Acht");
    // Mit dem neuen Namen geht es
    expect((await del(ctx, "Acht")).status).toBe(200);
  });

  test("gespeicherter Name mit Leerraum an den Rändern: nur die exakte Bestätigung löscht", async () => {
    const env = await withTopic();
    await env.names.saveTopicName(7, " Sieben ");
    const ctx = await topicServer(root, servers, env);
    // Die Liste zeigt den getrimmten Titel, bestätigt wird der gespeicherte Name
    const one = (await (await ctx.api("/api/conversations/topic-7")).json()).conversation;
    expect(one.title).toBe("Sieben");
    // Der exakte Name kommt unverändert mit, in der Liste wie im einzelnen Gespräch (Issue #30)
    expect(one.exactTitle).toBe(" Sieben ");
    const list = (await (await ctx.api("/api/conversations")).json()).telegram.topics;
    expect(list.find((t: { id: string }) => t.id === "topic-7").exactTitle).toBe(" Sieben ");
    for (const confirm of ["Sieben", " Sieben", "Sieben "]) {
      expect((await del(ctx, confirm)).status).toBe(400);
    }
    expect(env.api.callsOf("deleteForumTopic")).toEqual([]);
    expect(await env.state.get(GROUP, 7)).toEqual({});
    expect((await del(ctx, one.exactTitle)).status).toBe(200);
    expect(env.api.callsOf("deleteForumTopic")).toHaveLength(1);
  });

  test("exactTitle fehlt bei bereinigten Namen und nach dem Umbenennen", async () => {
    const env = await withTopic();
    await env.names.saveTopicName(7, " Sieben ");
    const ctx = await topicServer(root, servers, env);
    const res = await ctx.api("/api/conversations/topic-7", "PATCH", { title: "Acht" });
    expect(res.status).toBe(200);
    expect((await res.json()).conversation).not.toHaveProperty("exactTitle");
    expect((await (await ctx.api("/api/conversations/topic-7")).json()).conversation).not.toHaveProperty("exactTitle");
  });
});

describe("DELETE topic-<n>: Telegram-Ausführungen (echte execution-context)", () => {
  test("laufende oder wartende Telegram-Ausführung jedes Agenten: 409", async () => {
    const env = await withTopic({ executions: botExecutions });
    const ctx = await topicServer(root, servers, env);
    for (const start of [
      (gate: Promise<void>) => runExecution(KEY, "critic", () => gate),
      (gate: Promise<void>) => runCancelable(KEY, () => gate),
    ]) {
      const h = held();
      const running = start(h.gate);
      const res = await del(ctx);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("In diesem Topic läuft gerade eine Antwort");
      h.release();
      await running;
    }
    // Wartend hinter der vollen Kapazität
    const blockers = [held(), held(), held()];
    const busy = blockers.map((h, i) => runExecution(`del-other-${i}`, "general", () => h.gate));
    const waiting = runExecution(KEY, "research", async () => {});
    expect((await del(ctx)).status).toBe(409);
    for (const h of blockers) h.release();
    await Promise.all([...busy, waiting]);
    expect(env.api.callsOf("deleteForumTopic")).toEqual([]);
    expect(await env.state.get(GROUP, 7)).toEqual({});
  });

  test("während des Löschens gestartete Ausführung wird abgebrochen, bevor die Session zurückgesetzt wird", async () => {
    const order: string[] = [];
    const env = await withTopic({
      executions: botExecutions,
      resetSession: async key => {
        order.push(`reset ${key}`);
      },
    });
    const ctx = await topicServer(root, servers, env);
    let open!: () => void;
    env.api.gate.deleteForumTopic = new Promise<void>(resolve => (open = resolve));
    const deleting = del(ctx);
    await waitUntil(() => env.api.callsOf("deleteForumTopic").length === 1);
    // Aus Telegram kommt jetzt noch etwas herein: beide Wege enden sofort
    let ran = false;
    const late = runCancelable(KEY, async () => {
      ran = true;
    }).catch(e => order.push(`abgebrochen ${e.name}`));
    const lateAgent = runExecution(KEY, "finance", async () => {
      ran = true;
    }).catch(e => order.push(`abgebrochen ${e.name}`));
    await Promise.all([late, lateAgent]);
    open();
    const res = await deleting;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(ran).toBe(false);
    expect(order).toEqual(["abgebrochen AbortError", "abgebrochen AbortError", `reset ${KEY}`]);
    // Nach dem Aufräumen ist der Schlüssel wieder frei
    expect(isExecutionBlocked(KEY)).toBe(false);
  });

  test("Reihenfolge: sperren, Zustand, Telegram, abbrechen, warten, aufräumen, freigeben", async () => {
    const order: string[] = [];
    const port: ExecutionPort = {
      isActive: () => (order.push("isActive"), false),
      block: () => (order.push("block"), () => void order.push("release")),
      abort: () => (order.push("abort"), 0),
      waitIdle: async () => (order.push("waitIdle"), true),
    };
    const env = await withTopic({
      executions: port,
      removeMapping: async () => void order.push("removeMapping"),
      forgetName: async () => void order.push("forgetName"),
      resetSession: async () => void order.push("resetSession"),
    });
    const origSet = env.state.setFlag.bind(env.state);
    env.state.setFlag = async (c, t, f, on) => {
      order.push(`state ${f}=${on}`);
      return origSet(c, t, f, on);
    };
    const origDelete = env.api.deleteForumTopic.bind(env.api);
    env.api.deleteForumTopic = async (c, t) => {
      order.push("deleteForumTopic");
      return origDelete(c, t);
    };
    const ctx = await topicServer(root, servers, env);
    expect((await del(ctx)).status).toBe(200);
    expect(order).toEqual([
      "isActive",
      "block",
      "state deleted=true",
      "deleteForumTopic",
      "abort",
      "waitIdle",
      "removeMapping",
      "forgetName",
      "resetSession",
      "release",
    ]);
  });
});

describe("DELETE topic-<n>: Ergebnis", () => {
  test("Erfolg: deleteForumTopic, Zuordnung und Name weg, Session-Reset, Topic dauerhaft verschwunden", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    // Offene Live-Verbindung zum Topic
    const controller = new AbortController();
    const events = await fetch(`${ctx.origin}/api/conversations/topic-7/events`, { headers: { cookie: ctx.cookie }, signal: controller.signal });
    const reader = events.body!.getReader();
    await reader.read();

    const res = await del(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(env.api.callsOf("deleteForumTopic")).toEqual([["deleteForumTopic", GROUP, 7]]);
    expect((await readMapping(env))[GROUP]).toEqual({ "8": "research" });
    expect((await readNames(env))["7"]).toBeUndefined();
    expect(env.resets).toEqual([KEY]);
    expect(await env.state.get(GROUP, 7)).toEqual({ deleted: true });

    let sse = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sse += new TextDecoder().decode(value);
    }
    expect(sse).toContain("event: deleted");

    // Supabase liefert weiter Aktivität und Verlauf; das Topic bleibt weg
    expect(env.messages.rows.get(KEY)).toHaveLength(1);
    const list = await (await ctx.api("/api/conversations")).json();
    expect(list.telegram.topics.map((t: any) => t.id)).not.toContain("topic-7");
    expect((await ctx.api("/api/conversations/topic-7/messages")).status).toBe(404);
    expect((await ctx.api("/api/conversations/topic-7")).status).toBe(404);
    expect((await del(ctx)).status).toBe(404);
    // Nach Neustart, auch wenn Name und Zuordnung wieder auftauchen (Telegram-Pfad)
    await env.names.saveTopicName(7, "Sieben");
    await setTopicMapping(GROUP, 7, "finance", env.mappingFile);
    expect(await topicSource(env, true).getConversation("topic-7")).toBeNull();
    const live: string[] = [];
    topicLive(env, true).subscribe(e => live.push(e.conversationId));
    env.feed.emit({ chatId: GROUP, content: "spät", metadata: { topicId: 7, msgId: 99 } });
    await Bun.sleep(10);
    expect(live).toEqual([]);
    controller.abort();
  });

  test("deleteForumTopic scheitert: deleted zurückgenommen, 403 bzw. 502 ohne Token, Topic bleibt", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    env.api.fail.deleteForumTopic = telegramError("Bad Request: not enough rights to delete a topic", 400, "deleteForumTopic");
    const denied = await del(ctx);
    expect(denied.status).toBe(403);
    expect((await denied.json()).reason).toBe("no_delete_messages");
    expect(await env.state.get(GROUP, 7)).toEqual({});
    env.api.fail.deleteForumTopic = telegramError(`Bad Request: irgendwas ${BOT_TOKEN}`, 400, "deleteForumTopic");
    const failed = await del(ctx);
    expect(failed.status).toBe(502);
    const text = await failed.text();
    expect(JSON.parse(text)).toEqual({ error: "Telegram hat die Aktion abgelehnt" });
    const all = text + env.logs.join("\n") + ctx.logs.join("\n");
    expect(all).not.toContain(BOT_TOKEN);
    expect(all).not.toContain("irgendwas");
    expect(await env.state.get(GROUP, 7)).toEqual({});
    expect((await ctx.api("/api/conversations/topic-7")).status).toBe(200);
    expect((await readMapping(env))[GROUP]["7"]).toBe("finance");
    expect(env.resets).toEqual([]);
  });

  test("Zustand nicht schreibbar: 500, nichts in Telegram gelöscht, Sperre wieder frei", async () => {
    const env = await withTopic({ executions: botExecutions });
    const ctx = await topicServer(root, servers, env);
    const orig = env.state.setFlag.bind(env.state);
    env.state.setFlag = async (c, t, f, on) => {
      if (f === "deleted") throw new Error("EACCES");
      return orig(c, t, f, on);
    };
    const res = await del(ctx);
    expect(res.status).toBe(500);
    expect(env.api.callsOf("deleteForumTopic")).toEqual([]);
    expect(isExecutionBlocked(KEY)).toBe(false);
  });

  test("Aufräumen unvollständig: trotzdem gelöscht und verschwunden, andere Schritte versucht, SSE geschlossen", async () => {
    const env = await withTopic({
      removeMapping: async () => {
        throw new Error("EACCES /geheim/config/topics.json");
      },
      resetSession: async () => {
        throw new Error("EIO");
      },
    });
    const ctx = await topicServer(root, servers, env);
    const controller = new AbortController();
    const events = await fetch(`${ctx.origin}/api/conversations/topic-7/events`, { headers: { cookie: ctx.cookie }, signal: controller.signal });
    const reader = events.body!.getReader();
    await reader.read();
    const res = await del(ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, cleanup: "unvollständig" });
    expect((await readNames(env))["7"]).toBeUndefined();
    let sse = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sse += new TextDecoder().decode(value);
    }
    expect(sse).toContain("event: deleted");
    expect((await ctx.api("/api/conversations/topic-7")).status).toBe(404);
    const line = env.logs.find(l => l.includes("Aufräumen unvollständig"))!;
    expect(line).toContain("Zuordnung");
    expect(line).toContain("Session");
    expect(line).not.toContain("/geheim");
  });

  test("Ausführung endet nicht in der Frist: Session erst nach ihrem Ende zurückgesetzt, Sperre hält bis dahin", async () => {
    const results = [false, true];
    let releases = 0;
    let resolveIdle!: (v: boolean) => void;
    const port: ExecutionPort = {
      isActive: () => false,
      block: () => () => void releases++,
      abort: () => 1,
      waitIdle: () => {
        const next = results.shift();
        if (next === false) return Promise.resolve(false);
        return new Promise<boolean>(resolve => (resolveIdle = resolve));
      },
    };
    const env = await withTopic({ executions: port });
    const ctx = await topicServer(root, servers, env);
    const res = await del(ctx);
    expect(await res.json()).toEqual({ deleted: true, cleanup: "unvollständig" });
    expect(env.resets).toEqual([]);
    expect(releases).toBe(0);
    resolveIdle(true);
    await env.manager.idle();
    expect(env.resets).toEqual([KEY]);
    expect(releases).toBe(1);
  });

  test("Rücknahme scheitert: Log, Antwort bleibt der Telegram-Fehler", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    env.api.fail.deleteForumTopic = telegramError("Bad Request: TOPIC_ID_INVALID", 400, "deleteForumTopic");
    const orig = env.state.setFlag.bind(env.state);
    env.state.setFlag = async (c, t, f, on) => {
      if (f === "deleted" && !on) throw new Error("EIO");
      return orig(c, t, f, on);
    };
    expect((await del(ctx)).status).toBe(502);
    expect(env.logs.some(l => l.includes("bleibt aber in der WebUI ausgeblendet"))).toBe(true);
  });

  test("abbrechen trifft den Schlüssel des Topics", async () => {
    const env = await withTopic();
    const ctx = await topicServer(root, servers, env);
    await del(ctx);
    expect(env.executions.blocked).toEqual([KEY]);
    expect(env.executions.aborted).toEqual([KEY]);
    expect(env.executions.released).toEqual([KEY]);
    // abortExecutions selbst ist unverändert
    expect(abortExecutions("nichts-aktiv")).toBe(0);
  });
});
