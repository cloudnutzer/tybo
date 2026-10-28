/**
 * Issue #188, Checkbox 2: /stop entfernt wartende Turns sofort aus der
 * Schlange, obwohl alle Plätze belegt bleiben. Echtes execution-context,
 * Befehlsweg über das echte /stop, Web-Stopp mit Attrappen.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { abortExecutions, runCancelable, runExecution } from "../src/lib/execution-context";
import { useAgentCapacity } from "./agent-capacity-fixture";
import { commandRegistry } from "../src/lib/commands/builtin";
import type { CommandContext } from "../src/lib/commands/types";
import { createBotChat, createTelegramChat, type BotChatDeps } from "../src/web/bot-turn";
import type { TurnSink } from "../src/lib/chat-turn";

function held() {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  return { gate, release };
}

// Genau drei Plätze, egal was Umgebung oder Rechner vorgeben
useAgentCapacity(3);

/** Belegt alle drei Plätze mit laufenden Blockern */
function fillSlots(prefix: string) {
  const blockers = [held(), held(), held()];
  const busy = blockers.map((h, i) => runExecution(`${prefix}-${i}`, "general", () => h.gate));
  return {
    busy,
    release: async () => {
      for (const h of blockers) h.release();
      await Promise.all(busy);
    },
  };
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

const settle = (p: Promise<unknown>) => p.then(v => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

describe("wartende Turns und /stop", () => {
  test("Abbruch im wartenden Topic endet in < 100 ms, Blocker laufen weiter, der Turn läuft nie", async () => {
    const slots = fillSlots("q-a");
    cleanup.push(slots.release);
    let ran = false;
    const waiting = settle(runExecution("topic:-7:10", "research", async () => void (ran = true)));
    await Bun.sleep(5);
    const t0 = performance.now();
    expect(abortExecutions("topic:-7:10")).toBe(1);
    const result = await waiting;
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(100);
    expect(result.ok).toBe(false);
    expect((result as { e: Error }).e.name).toBe("AbortError");
    // Blocker laufen noch (nichts freigegeben); danach führt der abgebrochene Eintrag nichts aus
    await slots.release();
    cleanup = [];
    await Bun.sleep(5);
    expect(ran).toBe(false);
  });

  test("FIFO bleibt, kein Platz geht verloren", async () => {
    const blockers = [held(), held(), held()];
    const busy = blockers.map((h, i) => runExecution(`q-b-${i}`, "general", () => h.gate));
    const order: string[] = [];
    const hold1 = held();
    const w1 = runExecution("topic:-7:21", "general", async () => {
      order.push("w1");
      await hold1.gate;
    });
    const w2 = settle(runExecution("topic:-7:22", "general", async () => void order.push("w2")));
    const w3 = runExecution("topic:-7:23", "general", async () => void order.push("w3"));
    await Bun.sleep(5);
    abortExecutions("topic:-7:22");
    expect((await w2).ok).toBe(false);
    blockers[0].release();
    await Bun.sleep(5);
    // w1 hat den frei gewordenen Platz, w3 wartet weiter (w2 ist raus)
    expect(order).toEqual(["w1"]);
    blockers[1].release();
    await w3;
    expect(order).toEqual(["w1", "w3"]);
    hold1.release();
    await w1;
    blockers[2].release();
    await Promise.all(busy);

    // Alle drei Plätze wieder frei: drei laufen gleichzeitig, ein vierter wartet
    let concurrent = 0;
    let peak = 0;
    const gates = [held(), held(), held(), held()];
    const runs = gates.map((g, i) =>
      runExecution(`q-b-cap-${i}`, "general", async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await g.gate;
        concurrent--;
      })
    );
    await Bun.sleep(5);
    expect(concurrent).toBe(3);
    for (const g of gates) g.release();
    await Promise.all(runs);
    expect(peak).toBe(3);
  });

  test("Abbruch hinter der Session-Sperre: der Nächste wartet trotzdem auf den laufenden", async () => {
    const lock = "topic:-7:30";
    const first = held();
    const order: string[] = [];
    const running = runExecution(lock, "general", async () => {
      order.push("a start");
      await first.gate;
      order.push("a ende");
    });
    // B und C warten unter eigenen Bereichen hinter A; nur B wird gestoppt
    const b = settle(runCancelable("scope-b", () => runExecution(lock, "general", async () => void order.push("b"))));
    const c = runCancelable("scope-c", () => runExecution(lock, "general", async () => void order.push("c")));
    await Bun.sleep(5);
    const t0 = performance.now();
    abortExecutions("scope-b");
    const rb = await b;
    expect(performance.now() - t0).toBeLessThan(100);
    expect((rb as { e: Error }).e.name).toBe("AbortError");
    await Bun.sleep(5);
    expect(order).toEqual(["a start"]);
    first.release();
    await Promise.all([running, c]);
    expect(order).toEqual(["a start", "a ende", "c"]);
  });
});

function stopContext(sessionKey: string, services: Partial<CommandContext["services"]>) {
  const replies: string[] = [];
  const ctx = {
    channel: "telegram",
    chatId: "-7",
    sessionKey,
    agent: "general",
    name: "stop",
    args: "",
    text: "/stop",
    reply: async (t: string) => void replies.push(t),
    services: { getGoal: async () => undefined, pauseGoal: async () => {}, abortEngineCalls: abortExecutions, ...services },
  } as unknown as CommandContext;
  return { ctx, replies };
}

describe("Befehlsweg /stop", () => {
  test("/stop im wartenden Topic: Turn endet in < 100 ms mit AbortError, Antwort nennt den Abbruch", async () => {
    const slots = fillSlots("q-cmd");
    cleanup.push(slots.release);
    const key = "topic:-7:40";
    const waiting = settle(runCancelable(key, () => runExecution(key, "research", async () => "nie")));
    await Bun.sleep(5);
    const { ctx, replies } = stopContext(key, { requestBoardStop: () => "none" });
    const t0 = performance.now();
    await commandRegistry.get("stop")!.run(ctx);
    const result = await waiting;
    expect(performance.now() - t0).toBeLessThan(100);
    expect((result as { e: Error }).e.name).toBe("AbortError");
    expect(replies).toEqual(["⏹️ 1 laufende Verarbeitung abgebrochen."]);
  });

  test("Board-Sonderregel: das erste /stop bricht nicht hart ab, der wartende Beitrag bleibt", async () => {
    const slots = fillSlots("q-board");
    const key = "topic:-7:41";
    let ran = false;
    const waiting = runExecution(key, "research", async () => void (ran = true));
    await Bun.sleep(5);
    const { ctx, replies } = stopContext(key, { requestBoardStop: () => "requested" });
    await commandRegistry.get("stop")!.run(ctx);
    expect(replies).toEqual(["⏹️ Board-Sitzung endet nach dem laufenden Beitrag."]);
    await slots.release();
    await waiting;
    expect(ran).toBe(true);
  });
});

const SILENT: TurnSink = { progress: () => {}, notice: () => {} };

function chatDeps(calls: string[]): BotChatDeps {
  return {
    runStreamingTurn: async () => {
      calls.push("claude");
      return "Antwort";
    },
    saveMessage: async m => {
      calls.push(`save ${m.role}`);
      return true;
    },
    processIntents: async () => {},
    abortEngineCalls: abortExecutions,
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
  };
}

describe("Web-Stopp auf einen wartenden Turn", () => {
  test("reines Web-Gespräch: stop() beendet den wartenden Turn in < 100 ms, kein Claude-Aufruf, keine Antwort gespeichert", async () => {
    const slots = fillSlots("q-web");
    cleanup.push(slots.release);
    const calls: string[] = [];
    const chat = createBotChat(chatDeps(calls));
    const id = "0c1a2b3c-0000-4000-8000-000000000188";
    const turn = chat.runTurn({ conversationId: id, agent: "general", text: "Frage", sink: SILENT });
    await Bun.sleep(5);
    const t0 = performance.now();
    expect(chat.stop(id)).toBe(true);
    const result = await turn;
    expect(performance.now() - t0).toBeLessThan(100);
    expect(result.aborted).toBe(true);
    expect(calls).toEqual(["save user"]);
  });

  test("Telegram-Topic im Browser: stop() beendet den wartenden Turn in < 100 ms, keine Antwort nach Telegram", async () => {
    const slots = fillSlots("q-tg");
    cleanup.push(slots.release);
    const calls: string[] = [];
    const chat = createTelegramChat({
      ...chatDeps(calls),
      groupId: () => "-1001",
      agentForTopic: () => "research",
      sendPlain: async (_c, text) => void calls.push(`plain ${text}`),
      sendAsAgent: async () => void calls.push("antwort nach Telegram"),
    });
    const turn = chat.runTurn({ conversationId: "topic-50", agent: "research", text: "Frage", sink: SILENT });
    await Bun.sleep(5);
    const t0 = performance.now();
    expect(chat.stop("topic-50")).toBe(true);
    const result = await turn;
    expect(performance.now() - t0).toBeLessThan(100);
    expect(result.aborted).toBe(true);
    expect(calls).toEqual(["plain Du (Web): Frage"]);
  });
});
