/**
 * Issue #188, Checkbox 3: Wartehinweis, wenn ein Turn auf einen freien Platz
 * wartet. Echtes execution-context, Telegram und WebUI mit Attrappen.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  QUEUE_NOTICE_DELAY_MS,
  abortExecutions,
  runCancelable,
  runExecution,
  type QueueWaitInfo,
} from "../src/lib/execution-context";
import { useAgentCapacity } from "./agent-capacity-fixture";
import { createQueueNotifier, queueLabel, queueNoticeText } from "../src/lib/queue-notice";
import { createBotChat, createTelegramChat, type BotChatDeps, type WebSavedMessage } from "../src/web/bot-turn";
import type { TurnOptions, TurnSink } from "../src/lib/chat-turn";
import { createCommandRegistry } from "../src/lib/commands/registry";
import type { CommandServices } from "../src/lib/commands/types";
import { createBotCommands } from "../src/web/bot-commands";
import type { CommandRequest } from "../src/web/commands";

function held() {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  return { gate, release };
}

/** Belegt alle drei Plätze; Schlüssel frei wählbar */
function fillSlots(keys: string[]) {
  const blockers = keys.map(() => held());
  const busy = blockers.map((h, i) => runExecution(keys[i], "general", () => h.gate));
  return async () => {
    for (const h of blockers) h.release();
    await Promise.all(busy);
  };
}

// Die Tests füllen genau drei Plätze, egal was Umgebung oder Rechner vorgeben
useAgentCapacity(3);

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe("Hinweistext", () => {
  test("Ersatzbezeichnungen für Direktchat, Web-Gespräch, General, unbekannte Topics und Hintergrund", () => {
    expect(queueLabel("dm:4711")).toBe("Direktchat");
    expect(queueLabel("web:0c1a2b3c-0000-4000-8000-000000000000")).toBe("Web-Gespräch");
    expect(queueLabel("group:-1001")).toBe("General");
    expect(queueLabel("topic:-1001:443", { "443": "Finanzen" })).toBe("„Finanzen“");
    expect(queueLabel("topic:-1001:444", { "443": "Finanzen" })).toBe("Topic 444");
    expect(queueLabel("background")).toBe("Hintergrundaufgabe");
  });

  test("Anzahl und Topics, gleiche Topics nur einmal genannt", () => {
    expect(queueNoticeText({ running: 3, keys: ["dm:1", "topic:-1:5", "topic:-1:5"] }, { "5": "Recherche" })).toBe(
      "⏳ Warte auf einen freien Platz, gerade laufen 3 andere Aufträge (Direktchat, „Recherche“). Sobald einer fertig ist, geht es los."
    );
    expect(queueNoticeText({ running: 1, keys: ["web:x"] })).toBe(
      "⏳ Warte auf einen freien Platz, gerade läuft 1 anderer Auftrag (Web-Gespräch). Sobald einer fertig ist, geht es los."
    );
  });
});

describe("Wartehinweis im execution-context", () => {
  test("Standard: vor 3 Sekunden keiner, danach genau einer, nach dem Start keiner mehr", async () => {
    expect(QUEUE_NOTICE_DELAY_MS).toBe(3000);
    const release = fillSlots(["dm:1", "topic:-1:2", "web:3"]);
    cleanup.push(release);
    const seen: QueueWaitInfo[] = [];
    const turn = runCancelable("topic:-1:9", () => runExecution("topic:-1:9", "general", async () => "fertig"), {
      onQueueWait: info => void seen.push(info),
    });
    await Bun.sleep(2700);
    expect(seen).toHaveLength(0);
    await Bun.sleep(500);
    expect(seen).toHaveLength(1);
    // N zählt belegte Plätze: nicht den Wartenden, nicht seinen Update-Bereich
    expect(seen[0]).toEqual({ running: 3, keys: ["dm:1", "topic:-1:2", "web:3"] });
    cleanup = [];
    await release();
    expect(await turn).toBe("fertig");
    await Bun.sleep(20);
    expect(seen).toHaveLength(1);
  }, 10_000);

  test("Start vor Ablauf der Frist: kein Hinweis", async () => {
    const release = fillSlots(["q-n-1", "q-n-2", "q-n-3"]);
    const seen: QueueWaitInfo[] = [];
    const turn = runCancelable("topic:-1:10", () => runExecution("topic:-1:10", "general", async () => {}), {
      onQueueWait: info => void seen.push(info),
      queueNoticeMs: 40,
    });
    await Bun.sleep(10);
    await release();
    await turn;
    await Bun.sleep(60);
    expect(seen).toHaveLength(0);
  });

  test("Abbruch vor Ablauf der Frist: kein Hinweis, auch später nicht", async () => {
    const release = fillSlots(["q-n-4", "q-n-5", "q-n-6"]);
    cleanup.push(release);
    const seen: QueueWaitInfo[] = [];
    const turn = runCancelable("topic:-1:11", () => runExecution("topic:-1:11", "general", async () => {}), {
      onQueueWait: info => void seen.push(info),
      queueNoticeMs: 40,
    }).catch(e => e);
    await Bun.sleep(10);
    abortExecutions("topic:-1:11");
    expect(((await turn) as Error).name).toBe("AbortError");
    await Bun.sleep(60);
    expect(seen).toHaveLength(0);
  });

  test("genau einmal pro Turn, auch wenn der Turn zweimal wartet", async () => {
    const keys = ["q-n-7", "q-n-8", "q-n-9"];
    let release = fillSlots(keys);
    const seen: QueueWaitInfo[] = [];
    let secondWait!: () => void;
    const secondStarted = new Promise<void>(r => (secondWait = r));
    const turn = runCancelable(
      "topic:-1:12",
      async () => {
        await runExecution("topic:-1:12", "general", async () => {});
        // Zweiter Aufruf (etwa eine Rückfrage an einen anderen Agenten) wartet wieder
        const again = runExecution("topic:-1:12", "research", async () => {});
        secondWait();
        await again;
      },
      { onQueueWait: info => void seen.push(info), queueNoticeMs: 20 }
    );
    await Bun.sleep(40);
    expect(seen).toHaveLength(1);
    // Plätze kurz frei, der erste Aufruf läuft; dann sofort wieder belegen
    const firstDone = release();
    await firstDone;
    release = fillSlots(keys);
    await secondStarted;
    await Bun.sleep(40);
    await release();
    await turn;
    expect(seen).toHaveLength(1);
  });

  test("ohne Hinweis-Funktion (Hintergrund, Goal) bleibt alles still", async () => {
    const release = fillSlots(["q-n-10", "q-n-11", "q-n-12"]);
    const turn = runExecution("goal:x", "general", async () => "ok");
    await Bun.sleep(10);
    await release();
    expect(await turn).toBe("ok");
  });
});

describe("Telegram: Hinweis per ctx.reply im Update-Bereich (wie handleUpdateScope)", () => {
  test("genau eine Antwort mit Topic-Namen; scheitern die Namen, steht Topic <id>", async () => {
    const release = fillSlots(["topic:-1001:5", "dm:4711", "q-tg-1"]);
    cleanup.push(release);
    const replies: string[] = [];
    const turn = runCancelable(
      "topic:-1001:6",
      () => runExecution("topic:-1001:6", "general", async () => "ok"),
      { onQueueWait: createQueueNotifier(text => replies.push(text), async () => ({ "5": "Finanzen" })), queueNoticeMs: 20 }
    );
    await Bun.sleep(50);
    expect(replies).toEqual([
      "⏳ Warte auf einen freien Platz, gerade laufen 3 andere Aufträge („Finanzen“, Direktchat, Hintergrundaufgabe). Sobald einer fertig ist, geht es los.",
    ]);
    cleanup = [];
    await release();
    expect(await turn).toBe("ok");

    const release2 = fillSlots(["topic:-1001:5", "q-tg-2", "q-tg-3"]);
    const replies2: string[] = [];
    const failing = createQueueNotifier(
      text => replies2.push(text),
      async () => {
        throw new Error("Datei kaputt");
      }
    );
    const turn2 = runCancelable("dm:4711", () => runExecution("dm:4711", "general", async () => {}), { onQueueWait: failing, queueNoticeMs: 20 });
    await Bun.sleep(50);
    expect(replies2[0]).toContain("(Topic 5, Hintergrundaufgabe)");
    await release2();
    await turn2;
    expect(replies2).toHaveLength(1);
  });

  test("verzögerte Namen, Platz inzwischen frei: kein verspäteter Hinweis", async () => {
    const release = fillSlots(["topic:-1001:5", "q-late-1", "q-late-2"]);
    cleanup.push(release);
    const names = held();
    const replies: string[] = [];
    const turn = runCancelable(
      "dm:4711",
      () => runExecution("dm:4711", "general", async () => "ok"),
      {
        onQueueWait: createQueueNotifier(
          text => replies.push(text),
          async () => (await names.gate, { "5": "Finanzen" })
        ),
        queueNoticeMs: 20,
      }
    );
    // Frist abgelaufen, der Hinweis hängt in der Namenssuche
    await Bun.sleep(40);
    cleanup = [];
    await release();
    expect(await turn).toBe("ok");
    names.release();
    await Bun.sleep(20);
    expect(replies).toEqual([]);
  });

  test("verzögerte Namen, Turn inzwischen abgebrochen: kein verspäteter Hinweis", async () => {
    const release = fillSlots(["topic:-1001:5", "q-late-3", "q-late-4"]);
    cleanup.push(release);
    const names = held();
    const replies: string[] = [];
    const turn = runCancelable(
      "dm:4712",
      () => runExecution("dm:4712", "general", async () => "ok"),
      {
        onQueueWait: createQueueNotifier(
          text => replies.push(text),
          async () => (await names.gate, { "5": "Finanzen" })
        ),
        queueNoticeMs: 20,
      }
    ).catch(e => e);
    await Bun.sleep(40);
    abortExecutions("dm:4712");
    expect(((await turn) as Error).name).toBe("AbortError");
    names.release();
    await Bun.sleep(20);
    expect(replies).toEqual([]);
  });

  test("ein scheiternder Versand stört den Turn nicht", async () => {
    const release = fillSlots(["q-tg-4", "q-tg-5", "q-tg-6"]);
    const notify = createQueueNotifier(() => {
      throw new Error("Telegram weg");
    });
    const turn = runCancelable("dm:1", () => runExecution("dm:1", "general", async () => "ok"), { onQueueWait: notify, queueNoticeMs: 10 });
    await Bun.sleep(30);
    await release();
    expect(await turn).toBe("ok");
  });
});

interface Recorded {
  events: string[];
  saved: WebSavedMessage[];
  sink: TurnSink;
}

function recordingSink(): Recorded {
  const events: string[] = [];
  return {
    events,
    saved: [],
    sink: {
      progress: p => void events.push(`progress ${p.text}`),
      notice: t => void events.push(`notice ${t}`),
    },
  };
}

function webDeps(rec: Recorded, extra: Partial<BotChatDeps> = {}): BotChatDeps {
  return {
    runStreamingTurn: async (opts: TurnOptions) => {
      await opts.sink.progress({ kind: "tool", text: "Werkzeug läuft" } as never);
      return "Antwort";
    },
    saveMessage: async m => {
      rec.saved.push(m);
      return true;
    },
    processIntents: async () => {},
    abortEngineCalls: abortExecutions,
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
    queueNoticeMs: 20,
    topicNames: async () => ({ "7": "Recherche" }),
    ...extra,
  };
}

describe("WebUI: Hinweis als notice im Browser", () => {
  test("reines Web-Gespräch: genau ein Hinweis vor dem normalen Fortschritt, nie im Gedächtnis", async () => {
    const release = fillSlots(["topic:-1001:7", "q-web-1", "q-web-2"]);
    cleanup.push(release);
    const rec = recordingSink();
    const chat = createBotChat(webDeps(rec));
    const turn = chat.runTurn({ conversationId: "0c1a2b3c-0000-4000-8000-000000000189", agent: "general", text: "Frage", sink: rec.sink });
    await Bun.sleep(60);
    expect(rec.events).toEqual([
      "notice ⏳ Warte auf einen freien Platz, gerade laufen 3 andere Aufträge („Recherche“, Hintergrundaufgabe). Sobald einer fertig ist, geht es los.",
    ]);
    cleanup = [];
    await release();
    const result = await turn;
    expect(result.text).toBe("Antwort");
    expect(rec.events).toHaveLength(2);
    expect(rec.events[1]).toBe("progress Werkzeug läuft");
    expect(rec.saved.map(m => m.content)).toEqual(["Frage", "Antwort"]);
  });

  test("Telegram-Topic im Browser: Hinweis nur im Browser, nicht nach Telegram, nicht im Gedächtnis", async () => {
    const release = fillSlots(["dm:4711", "q-web-3", "q-web-4"]);
    cleanup.push(release);
    const rec = recordingSink();
    const telegram: string[] = [];
    const chat = createTelegramChat({
      ...webDeps(rec),
      groupId: () => "-1001",
      agentForTopic: () => "research",
      sendPlain: async (_c, text) => void telegram.push(text),
      sendAsAgent: async (_a, _c, text) => void telegram.push(text),
    });
    const turn = chat.runTurn({ conversationId: "topic-8", agent: "research", text: "Frage", sink: rec.sink });
    await Bun.sleep(60);
    expect(rec.events.filter(e => e.startsWith("notice"))).toHaveLength(1);
    expect(rec.events[0]).toContain("Direktchat");
    cleanup = [];
    await release();
    expect((await turn).text).toBe("Antwort");
    expect(rec.events.filter(e => e.startsWith("notice"))).toHaveLength(1);
    expect(rec.events.at(-1)).toBe("progress Werkzeug läuft");
    expect(telegram).toEqual(["Du (Web): Frage", "Antwort"]);
    expect(rec.saved.map(m => m.content)).toEqual(["Frage", "Antwort"]);
  });

  test("Web-Turn ohne Warten: kein Hinweis", async () => {
    const rec = recordingSink();
    const chat = createBotChat(webDeps(rec));
    await chat.runTurn({ conversationId: "0c1a2b3c-0000-4000-8000-000000000190", agent: "general", text: "Frage", sink: rec.sink });
    await Bun.sleep(40);
    expect(rec.events).toEqual(["progress Werkzeug läuft"]);
  });
});

describe("WebUI: Hinweis bei Modellbefehlen (/critic, /board über createBotCommands)", () => {
  function setupCommand(topicNames: () => Promise<Record<string, string>> = async () => ({ "7": "Recherche" })) {
    const rec = recordingSink();
    const registry = createCommandRegistry([
      {
        name: "probe",
        aliases: [],
        description: "Test",
        args: "required",
        channels: ["web", "terminal"],
        async run(ctx) {
          await ctx.agentTurn("critic", ctx.args);
        },
      },
    ]);
    const controller = new AbortController();
    const commands = createBotCommands({
      registry,
      services: {} as CommandServices,
      userId: "4711",
      groupId: () => "-1001",
      agentForTopic: () => "finance",
      sendPlain: async () => {},
      sendAndRecord: async () => ({ sent: true, recorded: true }),
      saveMessage: async m => (rec.saved.push(m), true),
      resetConversation: async () => ({ status: "unavailable" }),
      runStreamingTurn: async (opts: TurnOptions) => {
        await opts.sink.progress({ kind: "tool", text: "Werkzeug läuft" } as never);
        return "Antwort";
      },
      processIntents: async () => {},
      sendAsAgent: async () => {},
      log: () => {},
      queueNoticeMs: 20,
      topicNames,
    });
    const request: CommandRequest = {
      conversationId: "topic-443",
      agent: "finance",
      text: "/probe Idee",
      source: "web",
      messageId: "m-1",
      receivedAt: new Date().toISOString(),
      signal: controller.signal,
      sink: rec.sink,
      notice: async () => {},
      answer: async () => {},
      ask: async () => {},
      endAsk: () => {},
      commit: () => {},
    };
    return { rec, commands, request, controller };
  }

  test("belegte Plätze: genau ein Hinweis, danach normaler Fortschritt", async () => {
    const release = fillSlots(["topic:-1001:7", "q-cmd-1", "q-cmd-2"]);
    cleanup.push(release);
    const t = setupCommand();
    const running = t.commands.run(t.request);
    await Bun.sleep(60);
    expect(t.rec.events).toEqual([
      "notice ⏳ Warte auf einen freien Platz, gerade laufen 3 andere Aufträge („Recherche“, Hintergrundaufgabe). Sobald einer fertig ist, geht es los.",
    ]);
    cleanup = [];
    await release();
    expect(await running).toEqual({});
    expect(t.rec.events).toHaveLength(2);
    expect(t.rec.events[1]).toBe("progress Werkzeug läuft");
    // Hinweis nie im Gedächtnis
    expect(t.rec.saved.map(m => m.content)).toEqual(["/probe Idee", "Antwort"]);
  });

  test("Stopp vor Ablauf der Frist: kein Hinweis, auch später nicht", async () => {
    const release = fillSlots(["q-cmd-3", "q-cmd-4", "q-cmd-5"]);
    cleanup.push(release);
    const t = setupCommand();
    const running = t.commands.run(t.request);
    await Bun.sleep(5);
    t.controller.abort();
    expect(await running).toEqual({ aborted: true });
    await Bun.sleep(60);
    expect(t.rec.events).toEqual([]);
  });

  test("Stopp während der Namenssuche: kein verspäteter Hinweis", async () => {
    const release = fillSlots(["topic:-1001:7", "q-cmd-6", "q-cmd-7"]);
    cleanup.push(release);
    const names = held();
    const t = setupCommand(async () => (await names.gate, { "7": "Recherche" }));
    const running = t.commands.run(t.request);
    await Bun.sleep(40);
    t.controller.abort();
    expect(await running).toEqual({ aborted: true });
    names.release();
    await Bun.sleep(20);
    expect(t.rec.events).toEqual([]);
  });
});
