/**
 * Issue #367, Checkbox 1: /anruf in Telegram, Browser und Terminal über die
 * gemeinsame Befehls-Schicht. Der Anrufdienst ist eine Attrappe hinter dem
 * echten Zugang (phoneAccess); belegt sind Anlass, Gesprächsbezug je Kanal
 * (Telegram mit und ohne Topic, reines Web-Gespräch, Web-Direktchat),
 * fehlende Einstellungen ohne Anruf und dass „call me“ kein Befehl mehr ist.
 * src/bot.ts wird weder gestartet noch importiert.
 */

import { describe, expect, test } from "bun:test";
import { commandRegistry, HELP_TEXT } from "../src/lib/commands/builtin";
import { CALL_COMMAND_TEXT } from "../src/lib/commands/phone";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices } from "../src/lib/commands/types";
import type { ChoiceConversation } from "../src/lib/choices";
import { chatConversation, phoneAccess } from "../src/lib/phone";
import type { StartCallInput } from "../src/lib/phone/service";
import { createBotCommands } from "../src/web/bot-commands";

const ENV = {
  ELEVENLABS_API_KEY: "test-key",
  ELEVENLABS_AGENT_ID: "agent-1",
  ELEVENLABS_PHONE_NUMBER_ID: "number-1",
  USER_PHONE_NUMBER: "+49 151 0000000",
};
const USER = "4711";
const GROUP = "-1001234567890";
const WEB_ID = "0c1a2b3c-0000-4000-8000-000000000000";

/** Attrappe des PhoneService: merkt sich jeden startCall */
function fakePhone(message = "Ich rufe an.") {
  const calls: StartCallInput[] = [];
  return {
    calls,
    startCall: async (input: StartCallInput) => {
      calls.push(input);
      return { ok: true, message };
    },
  };
}

function servicesWith(phone: ReturnType<typeof fakePhone>, env: Record<string, string | undefined> = ENV): CommandServices {
  return { phone: phoneAccess(phone, { env, userName: async () => "Alex" }) } as unknown as CommandServices;
}

async function telegram(text: string, services: CommandServices, topicId?: number): Promise<string[]> {
  const sent: string[] = [];
  const chatId = topicId !== undefined ? GROUP : USER;
  const match = commandRegistry.match(text, "telegram");
  if (!match) throw new Error(`kein Befehl: ${text}`);
  await runTelegramCommand({
    chat: { reply: async t => void sent.push(t) },
    chatId,
    ...(topicId !== undefined ? { topicId } : {}),
    sessionKey: topicId !== undefined ? `topic:${chatId}:${topicId}` : `dm:${chatId}`,
    agent: "general",
    text,
    match,
    services,
    working: () => () => {},
    resetSession: async () => ({ status: "unavailable" }),
    agentTurn: async () => undefined,
    boardMeeting: async () => {},
  });
  return sent;
}

async function webOrTerminal(source: "web" | "terminal", text: string, services: CommandServices, conversationId = WEB_ID, userId = USER): Promise<string[]> {
  const unused = () => {
    throw new Error("nicht erwartet");
  };
  const replies: string[] = [];
  const commands = createBotCommands({
    registry: commandRegistry,
    services,
    userId,
    groupId: () => GROUP,
    agentForTopic: () => undefined,
    // Spiegeln der Befehlszeile nach Telegram (gespiegelte Gespräche)
    sendPlain: async () => {},
    sendAndRecord: async input => {
      replies.push(input.text);
      return { sent: true, recorded: true };
    },
    saveMessage: async () => true,
    resetConversation: unused,
    runStreamingTurn: unused,
    processIntents: unused,
    sendAsAgent: unused,
    log: () => {},
  });
  await commands.run({
    conversationId,
    agent: "general",
    text,
    source,
    messageId: "m1",
    receivedAt: new Date().toISOString(),
    signal: new AbortController().signal,
    sink: {} as any,
    notice: async t => void replies.push(t),
    answer: async () => {},
    ask: async () => {},
    endAsk: () => {},
    commit: () => {},
  });
  return replies;
}

describe("/anruf erkennen", () => {
  test("/anruf mit und ohne Anlass ist ein Befehl, „call me“ nicht", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      expect(commandRegistry.match("/anruf", channel)?.command.name).toBe("anruf");
      expect(commandRegistry.match("/anruf Folien für Freitag", channel)?.args).toBe("Folien für Freitag");
      expect(commandRegistry.match("/anrufen", channel)).toBeNull();
      expect(commandRegistry.match("call me bitte", channel)).toBeNull();
      expect(commandRegistry.match("call me", channel)).toBeNull();
      expect(commandRegistry.list(channel).some(c => c.name === "anruf")).toBe(true);
    }
  });

  test("/help nennt /anruf, nicht mehr „call me“", () => {
    expect(HELP_TEXT).toContain("/anruf [anlass]");
    expect(HELP_TEXT).not.toContain("call me");
  });
});

describe("/anruf in Telegram", () => {
  test("Direktchat ohne Anlass: allgemeiner Anruf, Gespräch ohne Topic, Name aus dem Profil", async () => {
    const phone = fakePhone();
    expect(await telegram("/anruf", servicesWith(phone))).toEqual(["Ich rufe an."]);
    expect(phone.calls).toEqual([{ reason: "", conversation: { type: "telegram", chatId: USER }, userName: "Alex" }]);
  });

  test("Topic mit Anlass: Anlass und Topic kommen an, Antwort ist die Meldung aus startCall", async () => {
    const phone = fakePhone("Anruf hat nicht geklappt: HTTP 400");
    expect(await telegram("/anruf Folien für Freitag", servicesWith(phone), 42)).toEqual(["Anruf hat nicht geklappt: HTTP 400"]);
    expect(phone.calls).toEqual([{ reason: "Folien für Freitag", conversation: { type: "telegram", chatId: GROUP, topicId: 42 }, userName: "Alex" }]);
  });

  test("nicht eingerichtet: Antwort nennt die fehlenden Variablen (nur Namen), kein Anruf", async () => {
    const phone = fakePhone();
    const env = { ...ENV, ELEVENLABS_AGENT_ID: "", USER_PHONE_NUMBER: undefined };
    const [reply] = await telegram("/anruf Test", servicesWith(phone, env));
    expect(reply).toBe(CALL_COMMAND_TEXT.notConfigured(["ELEVENLABS_AGENT_ID", "USER_PHONE_NUMBER"]));
    expect(reply).not.toContain("test-key");
    expect(reply).not.toContain("+49");
    expect(phone.calls).toEqual([]);
  });

  test("ohne Anrufdienst im Prozess: Hinweis statt Fehler", async () => {
    expect(await telegram("/anruf", {} as CommandServices)).toEqual([CALL_COMMAND_TEXT.unavailable]);
  });
});

describe("/anruf im Browser und im Terminal", () => {
  for (const source of ["web", "terminal"] as const) {
    test(`${source}: reines Web-Gespräch wird zu { type: "web" }`, async () => {
      const phone = fakePhone();
      expect(await webOrTerminal(source, "/anruf Steuer", servicesWith(phone))).toEqual(["Ich rufe an."]);
      expect(phone.calls).toEqual([{ reason: "Steuer", conversation: { type: "web", conversationId: WEB_ID }, userName: "Alex" }]);
    });

    test(`${source}: gespiegeltes Topic und Direktchat behalten ihren Telegram-Bezug`, async () => {
      const phone = fakePhone();
      await webOrTerminal(source, "/anruf", servicesWith(phone), "topic-42");
      await webOrTerminal(source, "/anruf kurz", servicesWith(phone), "dm");
      expect(phone.calls.map(c => [c.reason, c.conversation])).toEqual([
        ["", { type: "telegram", chatId: GROUP, topicId: 42 }],
        ["kurz", { type: "telegram", chatId: USER }],
      ]);
    });

    test(`${source}: nicht eingerichtet, kein Anruf`, async () => {
      const phone = fakePhone();
      const [reply] = await webOrTerminal(source, "/anruf", servicesWith(phone, {}));
      expect(reply).toBe(CALL_COMMAND_TEXT.notConfigured(Object.keys(ENV)));
      expect(phone.calls).toEqual([]);
    });
  }

  test("Web-Direktchat ohne Telegram (Chat-ID web) bleibt Telegram-Art wie im Register", async () => {
    const phone = fakePhone();
    await webOrTerminal("web", "/anruf", servicesWith(phone), "dm", "web");
    expect(phone.calls[0].conversation).toEqual({ type: "telegram", chatId: "web" });
  });
});

describe("Gesprächsbezug (chatConversation)", () => {
  test("Telegram mit und ohne Topic, web:<id> als Web-Gespräch, Direktchat web", () => {
    const cases: [string, number | undefined, ChoiceConversation][] = [
      [USER, undefined, { type: "telegram", chatId: USER }],
      [GROUP, 7, { type: "telegram", chatId: GROUP, topicId: 7 }],
      [`web:${WEB_ID}`, undefined, { type: "web", conversationId: WEB_ID }],
      ["web", undefined, { type: "telegram", chatId: "web" }],
    ];
    for (const [chatId, topicId, expected] of cases) expect(chatConversation(chatId, topicId)).toEqual(expected);
  });

  test("Name aus dem Profil: leer oder Fehler heißt ohne Namen (der Dienst nimmt dann seinen Standard)", async () => {
    const phone = fakePhone();
    await phoneAccess(phone, { env: ENV, userName: async () => "  " }).call("", chatConversation(USER));
    await phoneAccess(phone, { env: ENV, userName: async () => { throw new Error("kein Profil"); } }).call("", chatConversation(USER));
    expect(phone.calls.map(c => c.userName)).toEqual([undefined, undefined]);
  });
});
