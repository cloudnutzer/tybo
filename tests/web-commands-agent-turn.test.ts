/**
 * Issue #78, Checkbox 1: agentTurn der Befehls-Schicht gibt in Browser und
 * Terminal die gespeicherte Antwort zurück (undefined bei Stopp, Abbruch oder
 * leerer Antwort) und markiert sie auf Wunsch mit metadata.type. Direkt über
 * createBotCommands mit einem Test-Befehl, ohne Web-Server; src/bot.ts wird
 * nie geladen.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ABORT_REPLY } from "../src/lib/chat-turn";
import { createCommandRegistry } from "../src/lib/commands/registry";
import type { CommandServices } from "../src/lib/commands/types";
import { abortAllExecutions } from "../src/lib/execution-context";
import type { CommandRequest } from "../src/web/commands";
import { createBotCommands } from "../src/web/bot-commands";
import type { WebSavedMessage } from "../src/web/bot-turn";

const GROUP = "-1001234567890";
const USER = "4711";

afterEach(() => abortAllExecutions());

function setup(core: (signal: AbortSignal) => Promise<string>) {
  const saved: WebSavedMessage[] = [];
  const results: (string | undefined)[] = [];
  const registry = createCommandRegistry([
    {
      name: "probe",
      aliases: [],
      description: "Test",
      args: "required",
      channels: ["web", "terminal"],
      async run(ctx) {
        results.push(await ctx.agentTurn("critic", ctx.args, ctx.args === "typ" ? { replyType: "voice_reply" } : undefined));
      },
    },
  ]);
  const controller = new AbortController();
  const commands = createBotCommands({
    registry,
    services: {} as CommandServices,
    userId: USER,
    groupId: () => GROUP,
    agentForTopic: () => "finance",
    sendPlain: async () => {},
    sendAndRecord: async () => ({ sent: true, recorded: true }),
    saveMessage: async m => (saved.push(m), true),
    resetConversation: async () => ({ status: "unavailable" }),
    runStreamingTurn: () => core(controller.signal),
    processIntents: async () => {},
    sendAsAgent: async () => {},
    log: () => {},
  });
  const request = (text: string): CommandRequest => ({
    conversationId: "topic-443",
    agent: "finance",
    text,
    source: "web",
    messageId: "m-1",
    receivedAt: new Date().toISOString(),
    signal: controller.signal,
    sink: { progress: () => {}, notice: () => {} },
    notice: async () => {},
    answer: async () => {},
    ask: async () => {},
    endAsk: () => {},
    commit: () => {},
  });
  return { commands, request, saved, results, controller };
}

describe("agentTurn in Browser und Terminal", () => {
  test("Erfolg: Rückgabe ist die gespeicherte Antwort", async () => {
    const t = setup(async () => "Drei Risiken [REMEMBER: x]");
    expect(await t.commands.run(t.request("/probe Idee"))).toEqual({});
    expect(t.results).toEqual(["Drei Risiken [REMEMBER: x]"]);
    const reply = t.saved.find(m => m.role === "assistant")!;
    expect(reply.content).toBe("Drei Risiken [REMEMBER: x]");
    expect((reply.metadata as any).type).toBeUndefined();
  });

  test("replyType landet als metadata.type an der gespeicherten Antwort", async () => {
    const t = setup(async () => "Antwort");
    await t.commands.run(t.request("/probe typ"));
    expect(t.results).toEqual(["Antwort"]);
    expect((t.saved.find(m => m.role === "assistant")!.metadata as any).type).toBe("voice_reply");
  });

  test("Stopp während des Turns: undefined, nichts gespeichert außer der Nutzernachricht", async () => {
    const t = setup(
      signal =>
        new Promise(resolve => {
          signal.addEventListener("abort", () => resolve(ABORT_REPLY), { once: true });
        })
    );
    const running = t.commands.run(t.request("/probe Idee"));
    await Bun.sleep(10);
    t.controller.abort();
    expect(await running).toEqual({ aborted: true });
    expect(t.results).toEqual([undefined]);
    expect(t.saved.map(m => m.role)).toEqual(["user"]);
  });

  test("Abbruch des Chat-Kerns (ABORT_REPLY) und leere Antwort: undefined", async () => {
    const aborted = setup(async () => ABORT_REPLY);
    await aborted.commands.run(aborted.request("/probe Idee"));
    expect(aborted.results).toEqual([undefined]);
    const empty = setup(async () => "   ");
    await empty.commands.run(empty.request("/probe Idee"));
    expect(empty.results).toEqual([undefined]);
    expect(empty.saved.map(m => m.role)).toEqual(["user"]);
  });
});
