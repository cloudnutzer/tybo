// Issue #344: Bereich eines Telegram-Updates als Verhalten (ersetzt die
// Quelltext-Prüfung von handleUpdateScope in src/bot.ts).
import { describe, expect, test } from "bun:test";
import { createUpdateScope, runsImmediately, type ScopedUpdate } from "../src/channels/telegram/update-scope";
import { sessionKeyFor } from "../src/lib/store/message-rules";

class RestartPending extends Error {}
class Aborted extends Error {}

function ctxFor(text: string | undefined, threadId?: number): ScopedUpdate & { replies: unknown[][] } {
  const replies: unknown[][] = [];
  return {
    chat: { id: -100 },
    message: text === undefined ? undefined : { text },
    msg: { message_thread_id: threadId },
    replies,
    reply: async (...args) => (replies.push(args), {}),
  };
}

function setup(fail?: unknown) {
  const keys: string[] = [];
  const scope = createUpdateScope({
    runCancelable: async (key, run, options) => {
      keys.push(key);
      await options.onQueueWait?.({ key, waiting: 1, running: 1, limit: 1 } as never, () => true);
      if (fail) throw fail;
      await run();
    },
    queueNotice: send => async () => {
      await send("wartet");
    },
    isRestartPending: e => e instanceof RestartPending,
    isAbort: e => e instanceof Aborted,
    restartPendingText: "startet neu",
  });
  return { scope, keys };
}

describe("runsImmediately", () => {
  test("Stopp- und Reset-Befehle laufen sofort", () => {
    for (const text of ["/stop", "/new", "/motor codex", "/engine", "/goal pause", "/GOAL  stop", "/stop@tybo_bot"]) {
      expect(runsImmediately(text)).toBe(true);
    }
    for (const text of ["/goal status", "/goal neu", "/newsletter", "stop", "/help", ""]) {
      expect(runsImmediately(text)).toBe(false);
    }
  });
});

describe("createUpdateScope", () => {
  test("normale Nachricht läuft unter dem Session-Schlüssel des Topics, wie Web-Turns", async () => {
    const s = setup();
    const ctx = ctxFor("hallo", 77);
    let ran = false;
    await s.scope(ctx, async () => void (ran = true));
    expect(ran).toBe(true);
    expect(s.keys).toEqual([sessionKeyFor("-100", 77)]);
    // Wartehinweis geht ins Gespräch
    expect(ctx.replies).toEqual([["wartet"]]);
  });

  test("Direktchat ohne Topic: Schlüssel ohne Topic", async () => {
    const s = setup();
    await s.scope(ctxFor("hallo"), async () => {});
    expect(s.keys).toEqual([sessionKeyFor("-100", null)]);
  });

  test("/stop läuft sofort, ohne Warteschlange", async () => {
    const s = setup();
    let ran = false;
    await s.scope(ctxFor("/stop", 77), async () => void (ran = true));
    expect(ran).toBe(true);
    expect(s.keys).toEqual([]);
  });

  test("Knopf (ohne eingehende Nachricht) läuft im Bereich", async () => {
    const s = setup();
    await s.scope(ctxFor(undefined, 3), async () => {});
    expect(s.keys).toEqual([sessionKeyFor("-100", 3)]);
  });

  test("während des Neustarts: Hinweis im Topic statt Fehler", async () => {
    const s = setup(new RestartPending());
    const ctx = ctxFor("hallo", 77);
    await s.scope(ctx, async () => {});
    expect(ctx.replies.at(-1)).toEqual(["startet neu", { message_thread_id: 77 }]);
  });

  test("Abbruch ist kein Fehler, andere Fehler gehen weiter", async () => {
    await setup(new Aborted()).scope(ctxFor("hallo"), async () => {});
    await expect(setup(new Error("kaputt")).scope(ctxFor("hallo"), async () => {})).rejects.toThrow("kaputt");
  });
});
