/**
 * Issue #61: Session eines Gesprächs frisch starten wie /new in Telegram,
 * POST /api/conversations/<id>/reset. Route gegen den Test-Server,
 * createConversationSessionReset mit Attrappen und die Schlüssel wie beim
 * Schreiben (conversationSessionKey). src/bot.ts wird nie geladen.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { blockExecutions, isExecutionActive, isExecutionBlocked, runCancelable, runExecution } from "../src/lib/execution-context";
import { conversationSessionKey } from "../src/web/bot-turn";
import { createConversationSessionReset, SESSION_RESET_TEXT, sessionResetNote } from "../src/web/session-reset";
import { startTyboServer, type TyboServerOptions, type TerminalTestServer } from "./terminal-fixture";

let servers: TerminalTestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

async function start(options: TyboServerOptions = { manage: true }) {
  const s = await startTyboServer(options);
  servers.push(s);
  return s;
}

async function reset(s: TerminalTestServer, id: string, method = "POST") {
  const res = await s.client().request(method, `/api/conversations/${encodeURIComponent(id)}/reset`);
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe("POST /api/conversations/<id>/reset", () => {
  test("Topic: setzt zurück, Hinweis wie in Telegram, Verlauf bleibt", async () => {
    const s = await start();
    const before = await s.client().messages("topic-443");
    const r = await reset(s, "topic-443");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ reset: 1, sessionMode: true, note: SESSION_RESET_TEXT.done });
    expect(s.resets).toEqual(["topic-443"]);
    const after = await s.client().messages("topic-443");
    expect(after.messages.map(m => m.id)).toEqual(before.messages.map(m => m.id));
  });

  test("Direktchat, General und älteres Web-Gespräch gehen auch", async () => {
    const s = await start();
    for (const id of ["dm", "topic-1", s.webConversationId!]) expect((await reset(s, id)).status).toBe(200);
    expect(s.resets).toEqual(["dm", "topic-1", s.webConversationId!]);
  });

  test("während einer laufenden Antwort: 409, nichts zurückgesetzt", async () => {
    const s = await start();
    const sent = await s.client().send("topic-443", "Frage");
    expect(sent.status).toBe("accepted");
    await s.telegramChat.turn("topic-443");
    const r = await reset(s, "topic-443");
    expect(r.status).toBe(409);
    expect(r.body?.error).toBe(SESSION_RESET_TEXT.busy);
    expect(s.resets).toEqual([]);
    s.telegramChat.finish("topic-443", "fertig");
  });

  test("laufende Antwort aus Telegram (Port meldet busy): 409", async () => {
    const s = await start({ manage: true, resetResult: () => ({ status: "busy" }) });
    const r = await reset(s, "topic-12");
    expect(r.status).toBe(409);
  });

  test("Session-Modus aus und nichts zurückzusetzen: eigene Hinweise", async () => {
    const off = await start({ manage: true, resetResult: () => ({ status: "done", reset: 0, sessionMode: false }) });
    expect((await reset(off, "dm")).body?.note).toBe(SESSION_RESET_TEXT.off);
    const none = await start({ manage: true, resetResult: () => ({ status: "done", reset: 0, sessionMode: true }) });
    expect((await reset(none, "dm")).body?.note).toBe(SESSION_RESET_TEXT.none);
  });

  test("unbekanntes Gespräch: 404; GET: 405", async () => {
    const s = await start();
    expect((await reset(s, "topic-99999")).status).toBe(404);
    expect((await reset(s, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await reset(s, "topic-443", "GET")).status).toBe(405);
    expect(s.resets).toEqual([]);
  });

  test("ohne Anbindung: 503", async () => {
    const s = await start({});
    const r = await reset(s, "dm");
    expect(r.status).toBe(503);
    expect(r.body?.error).toBe(SESSION_RESET_TEXT.notConfigured);
  });

  test("Fehler beim Zurücksetzen: 500 ohne Details", async () => {
    const s = await start({
      manage: true,
      resetResult: () => {
        throw new Error("geheimer Pfad /Users/x");
      },
    });
    const r = await reset(s, "dm");
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: SESSION_RESET_TEXT.failed });
  });
});

describe("createConversationSessionReset", () => {
  function setup(overrides: Partial<Parameters<typeof createConversationSessionReset<{ id: string; turns: number }>>[0]> = {}) {
    const calls: string[] = [];
    const reset = createConversationSessionReset<{ id: string; turns: number }>({
      sessionKey: id => (id === "kaputt" ? null : `key:${id}`),
      isActive: () => false,
      block: () => () => {},
      sessionsForKey: async key => [
        { id: `${key}:general`, turns: 5 },
        { id: `${key}:research`, turns: 1 },
      ],
      shouldDistill: s => s.turns >= 3,
      distill: async s => {
        calls.push(`distill ${s.id}`);
      },
      reset: async key => {
        calls.push(`reset ${key}`);
        return 2;
      },
      sessionModeEnabled: () => true,
      log: () => {},
      ...overrides,
    });
    return { reset, calls };
  }

  test("destilliert Sessions mit genug Inhalt, dann Reset", async () => {
    const { reset, calls } = setup();
    expect(await reset("topic-5")).toEqual({ status: "done", reset: 2, sessionMode: true });
    expect(calls).toEqual(["distill key:topic-5:general", "reset key:topic-5"]);
  });

  test("laufende Ausführung: busy, weder Destillat noch Reset", async () => {
    const { reset, calls } = setup({ isActive: () => true });
    expect(await reset("topic-5")).toEqual({ status: "busy" });
    expect(calls).toEqual([]);
  });

  test("whileBlocked (/motor) läuft nach dem Reset, noch unter der Sperre; bei busy gar nicht", async () => {
    let blocked = false;
    const { reset, calls } = setup({
      block: () => {
        blocked = true;
        return () => {
          blocked = false;
        };
      },
    });
    const whileBlocked = async () => void calls.push(`schreiben gesperrt=${blocked}`);
    expect((await reset("topic-5", whileBlocked)).status).toBe("done");
    expect(calls).toEqual(["distill key:topic-5:general", "reset key:topic-5", "schreiben gesperrt=true"]);
    expect(blocked).toBe(false);

    const busy = setup({ isActive: () => true });
    expect(await busy.reset("topic-5", async () => void busy.calls.push("schreiben"))).toEqual({ status: "busy" });
    expect(busy.calls).toEqual([]);
  });

  test("ohne Schlüssel: unavailable", async () => {
    const { reset } = setup();
    expect(await reset("kaputt")).toEqual({ status: "unavailable" });
  });

  test("scheiterndes Destillat hält den Reset nicht auf", async () => {
    const { reset, calls } = setup({
      distill: async () => {
        throw new Error("aux weg");
      },
    });
    expect((await reset("dm")).status).toBe("done");
    expect(calls).toEqual(["reset key:dm"]);
  });

  test("scheiternder Reset gibt die Sperre wieder frei", async () => {
    const key = "reset-test:fehler";
    const reset = createConversationSessionReset<never>({
      sessionKey: () => key,
      isActive: isExecutionActive,
      block: blockExecutions,
      sessionsForKey: async () => [],
      shouldDistill: () => false,
      distill: async () => {},
      reset: async () => {
        expect(isExecutionBlocked(key)).toBe(true);
        throw new Error("Platte voll");
      },
      sessionModeEnabled: () => true,
      log: () => {},
    });
    await expect(reset("dm")).rejects.toThrow("Platte voll");
    expect(isExecutionBlocked(key)).toBe(false);
  });

  test("Hinweistexte", () => {
    expect(sessionResetNote({ reset: 1, sessionMode: true })).toBe(SESSION_RESET_TEXT.done);
    expect(sessionResetNote({ reset: 0, sessionMode: true })).toBe(SESSION_RESET_TEXT.none);
    expect(sessionResetNote({ reset: 3, sessionMode: false })).toBe(SESSION_RESET_TEXT.off);
  });
});

describe("Reset und Telegram-Ausführungen sichern sich gegenseitig ab (echte execution-context)", () => {
  test("Telegram-Ausführung, die während des Session-Lesens startet, läuft nicht; danach wieder frei", async () => {
    const key = "reset-test:topic-443";
    let sessionsRead!: () => void;
    let releaseRead!: (sessions: string[]) => void;
    const reading = new Promise<void>(resolve => (sessionsRead = resolve));
    const calls: string[] = [];
    const reset = createConversationSessionReset<string>({
      sessionKey: () => key,
      isActive: isExecutionActive,
      block: blockExecutions,
      sessionsForKey: () =>
        new Promise<string[]>(resolve => {
          releaseRead = resolve;
          sessionsRead();
        }),
      shouldDistill: () => false,
      distill: async () => {},
      reset: async () => {
        calls.push("reset");
        return 1;
      },
      sessionModeEnabled: () => true,
      log: () => {},
    });

    const pending = reset("topic-443");
    await reading;
    // Reset hängt im Session-Lesen: jetzt kommt eine Telegram-Nachricht
    const agent = runExecution(key, "general", async () => {
      calls.push("agent");
    });
    const update = runCancelable(key, async () => {
      calls.push("update");
    });
    await expect(agent).rejects.toMatchObject({ name: "AbortError" });
    await expect(update).rejects.toMatchObject({ name: "AbortError" });
    releaseRead([]);
    expect(await pending).toEqual({ status: "done", reset: 1, sessionMode: true });
    expect(calls).toEqual(["reset"]);

    // Nach dem Reset ist der Schlüssel frei
    expect(isExecutionBlocked(key)).toBe(false);
    await runExecution(key, "general", async () => {
      calls.push("agent danach");
    });
    expect(calls).toEqual(["reset", "agent danach"]);
  });

  test("laufende Telegram-Ausführung: Reset meldet busy und liest nichts", async () => {
    const key = "reset-test:dm";
    let finish!: () => void;
    let started!: () => void;
    const running = new Promise<void>(resolve => (started = resolve));
    const agent = runExecution(key, "general", () => {
      started();
      return new Promise<void>(resolve => (finish = resolve));
    });
    await running;
    let read = false;
    const reset = createConversationSessionReset<string>({
      sessionKey: () => key,
      isActive: isExecutionActive,
      block: blockExecutions,
      sessionsForKey: async () => {
        read = true;
        return [];
      },
      shouldDistill: () => false,
      distill: async () => {},
      reset: async () => 1,
      sessionModeEnabled: () => true,
      log: () => {},
    });
    expect(await reset("dm")).toEqual({ status: "busy" });
    expect(read).toBe(false);
    expect(isExecutionBlocked(key)).toBe(false);
    finish();
    await agent;
  });
});

describe("conversationSessionKey: gleicher Schlüssel wie beim Schreiben", () => {
  const deps = {
    userId: "123456",
    groupId: () => "-1001234567890",
    agentForTopic: () => "research",
  };

  test("Direktchat, General, Topic, Web-Gespräch", () => {
    expect(conversationSessionKey("dm", deps)).toBe("dm:123456");
    expect(conversationSessionKey("topic-1", deps)).toBe("group:-1001234567890");
    expect(conversationSessionKey("topic-443", deps)).toBe("topic:-1001234567890:443");
    expect(conversationSessionKey("0b0f4c9e-1111-4222-8333-944455556666", deps)).toBe("web:0b0f4c9e-1111-4222-8333-944455556666");
  });

  test("ohne Gruppe oder Nutzer: null", () => {
    expect(conversationSessionKey("topic-443", { ...deps, groupId: () => null })).toBeNull();
    expect(conversationSessionKey("dm", { ...deps, userId: undefined })).toBeNull();
  });
});
