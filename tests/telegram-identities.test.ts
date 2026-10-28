/**
 * Issue #330: Agenten-Identitäten (src/channels/telegram/identities.ts).
 *
 * Jeder aktive Agent aus dem Katalog, auch General, kann einen eigenen
 * Absender-Bot haben; das Token steht in TELEGRAM_BOT_TOKEN_<KENNUNG>
 * (Bindestriche werden Unterstriche). Ohne Token, bei gescheiterter Anmeldung
 * und für gelöschte Agenten sendet der Haupt-Bot. Agenten-Bots sind reine
 * Sender: init(), nie start().
 *
 * Bot-Fabrik und Bot-API sind Attrappen, fetch ist gesperrt, der Katalog
 * liegt in einem temporären Ordner. src/bot.ts wird nie importiert.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Api, Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { createAgent, deleteAgent, restoreBuiltin } from "../src/agents/catalog";
import { AGENT_TOKEN_MAP, AgentIdentities, agentTokenEnvName, initFailureCategory } from "../src/channels/telegram/identities";
import { AGENT_TOKEN_MAP as OLD_TOKEN_MAP, BotRegistry } from "../src/lib/bot-registry";
import { isolateAgentCatalog } from "./catalog-fixture";

isolateAgentCatalog();

const MAIN_TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
const MAIN_ME = { id: 1, is_bot: true, first_name: "Haupt", username: "haupt_bot" } as UserFromGetMe;
/** Erkennbar falsches Token je Agent; darf nie in einem Log auftauchen */
const tokenFor = (agent: string) => `55555:AAFakeAgentToken_${agent}`;

let fetchSpy: ReturnType<typeof spyOn>;
let fetched = 0;
let logs: string[] = [];
const quiet: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  fetched = 0;
  logs = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
    fetched++;
    throw new Error("Netz im Test verboten");
  }) as any);
  for (const method of ["log", "error", "warn"] as const) {
    quiet.push(spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); }));
  }
});
afterEach(() => {
  fetchSpy.mockRestore();
  while (quiet.length) quiet.pop()!.mockRestore();
});

interface Sent {
  bot: string;
  method: string;
  payload: Record<string, any>;
}

/**
 * Haupt-Bot und Fabrik als Attrappen: jede Api zeichnet auf, was nach dem
 * Output-Guard ankommt, und antwortet selbst. failInit nennt Agenten, deren
 * Anmeldung scheitert.
 */
function setup(env: Record<string, string>, failInit: string[] = [], initError: (token: string) => unknown = () => new Error("401: Unauthorized")) {
  const sent: Sent[] = [];
  const created: string[] = [];
  const record = (api: Api, name: string) => {
    api.config.use(async (_prev, method, payload) => {
      sent.push({ bot: name, method, payload: { ...(payload as Record<string, any>) } });
      return { ok: true, result: method === "sendChatAction" ? true : { message_id: sent.length, date: 0, chat: { id: 1, type: "private" } } } as any;
    });
  };
  const primary = new Bot(MAIN_TOKEN, { botInfo: MAIN_ME });
  record(primary.api, "haupt");
  const agentOf = (token: string) => token.slice(token.indexOf("_") + 1);
  const identities = new AgentIdentities(primary, {
    env,
    createBot: token => {
      const agent = agentOf(token);
      created.push(agent);
      const bot = new Bot(token, { botInfo: { ...MAIN_ME, id: 100 + created.length, username: `${agent.replace(/-/g, "_")}_Bot` } });
      if (failInit.includes(agent)) bot.init = async () => { throw initError(token); };
      bot.start = async () => { throw new Error("Agenten-Bots pollen nie"); };
      record(bot.api, agent);
      return bot;
    },
  });
  return { identities, sent, created, primary };
}

const envWith = (...agents: string[]) => Object.fromEntries(agents.map(a => [agentTokenEnvName(a), tokenFor(a)]));
const messagesOf = (sent: Sent[], bot: string) => sent.filter(s => s.bot === bot && s.method === "sendMessage");

describe("Token-Namen", () => {
  test("Kennung groß, Bindestriche als Unterstriche", () => {
    expect(agentTokenEnvName("research")).toBe("TELEGRAM_BOT_TOKEN_RESEARCH");
    expect(agentTokenEnvName("projekt-planer")).toBe("TELEGRAM_BOT_TOKEN_PROJEKT_PLANER");
    expect(agentTokenEnvName("a1-b2-c3")).toBe("TELEGRAM_BOT_TOKEN_A1_B2_C3");
  });

  test("AGENT_TOKEN_MAP: abgeleitet, genau die sieben mitgelieferten Agenten ohne General", () => {
    expect(AGENT_TOKEN_MAP).toEqual({
      research: "TELEGRAM_BOT_TOKEN_RESEARCH",
      content: "TELEGRAM_BOT_TOKEN_CONTENT",
      finance: "TELEGRAM_BOT_TOKEN_FINANCE",
      strategy: "TELEGRAM_BOT_TOKEN_STRATEGY",
      critic: "TELEGRAM_BOT_TOKEN_CRITIC",
      cto: "TELEGRAM_BOT_TOKEN_CTO",
      coo: "TELEGRAM_BOT_TOKEN_COO",
    });
    for (const [agent, name] of Object.entries(AGENT_TOKEN_MAP)) expect(agentTokenEnvName(agent)).toBe(name);
  });
});

describe("alter Pfad src/lib/bot-registry.ts", () => {
  test("leitet für phone/task-turn.ts auf die Identitäten weiter", () => {
    expect(BotRegistry).toBe(AgentIdentities);
    expect(OLD_TOKEN_MAP).toBe(AGENT_TOKEN_MAP);
  });
});

describe("Anmelden", () => {
  test("nur Agenten mit Token, je einmal init, nie start, kein Netz", async () => {
    const { identities, created } = setup(envWith("research", "cto"));
    await identities.initialize();
    expect(created.sort()).toEqual(["cto", "research"]);
    expect(fetched).toBe(0);
  });

  test("General mit TELEGRAM_BOT_TOKEN_GENERAL: eigener Absender, Direktchat und Topics", async () => {
    const { identities, created, sent } = setup(envWith("general"));
    await identities.initialize();
    expect(created).toEqual(["general"]);
    await identities.sendAsAgent("general", 1, "Hallo");
    await identities.sendAsAgent("General", 1, "Topic", { threadId: 9 });
    await identities.sendTypingAsAgent("general", 1);
    expect(messagesOf(sent, "general").map(s => s.payload.text)).toEqual(["Hallo", "Topic"]);
    expect(sent.filter(s => s.bot === "general").map(s => s.method)).toEqual(["sendMessage", "sendMessage", "sendChatAction"]);
    expect(sent.filter(s => s.bot === "haupt")).toHaveLength(0);
    expect(identities.agentForMention("@general_bot hallo")).toEqual({ agent: "general", cleanedText: "hallo" });
  });

  test("General ohne eigenes Token: Haupt-Bot wie bisher", async () => {
    const { identities, created, sent } = setup(envWith("research"));
    await identities.initialize();
    expect(created).toEqual(["research"]);
    await identities.sendAsAgent("general", 1, "Hallo");
    await identities.sendTypingAsAgent("general", 1);
    expect(sent.filter(s => s.bot === "haupt").map(s => s.method)).toEqual(["sendMessage", "sendChatAction"]);
    expect(sent.filter(s => s.bot === "research")).toHaveLength(0);
  });

  test("General mit gescheiterter Anmeldung: Haupt-Bot", async () => {
    const { identities, sent } = setup(envWith("general"), ["general"]);
    await identities.initialize();
    await identities.sendAsAgent("general", 1, "Hallo");
    expect(messagesOf(sent, "haupt")).toHaveLength(1);
    expect(sent.filter(s => s.bot === "general")).toHaveLength(0);
  });

  test("leeres Token und nur Leerzeichen zählen nicht", async () => {
    const { identities, created } = setup({ TELEGRAM_BOT_TOKEN_RESEARCH: "", TELEGRAM_BOT_TOKEN_CTO: "   " });
    await identities.initialize();
    expect(created).toEqual([]);
  });

  test("eigener Agent mit Bindestrich: Token unter dem abgeleiteten Namen", async () => {
    await createAgent({ name: "projekt-planer", description: "Plant", systemPrompt: "Du planst." });
    const { identities, created } = setup(envWith("projekt-planer"));
    await identities.initialize();
    expect(created).toEqual(["projekt-planer"]);
  });

  test("beim Start gelöschter Agent: Bot wird nicht gebaut", async () => {
    await deleteAgent("cto");
    const { identities, created } = setup(envWith("cto", "research"));
    await identities.initialize();
    expect(created).toEqual(["research"]);
  });

  /** Fehler, wie grammY sie bei gescheiterter Anmeldung werfen kann, jeweils mit Token */
  const leakyErrors: Record<string, (token: string) => unknown> = {
    "Error mit Token": token => new Error(`Anmeldung mit ${token} gescheitert`),
    "Error mit Telegram-URL": token => new Error(`Network request for 'getMe' failed! https://api.telegram.org/bot${token}/getMe`),
    "HttpError mit URL": token => new HttpError(`Network request for 'getMe' failed! https://api.telegram.org/bot${token}/getMe`, new Error(`fetch https://api.telegram.org/bot${token}/getMe`)),
    "GrammyError mit Token in der Beschreibung": token =>
      new GrammyError(`Call to 'getMe' failed! (401: Unauthorized ${token})`, { ok: false, error_code: 401, description: `Unauthorized ${token}` }, "getMe", {}),
    "Ablehnung als String mit Token": token => `https://api.telegram.org/bot${token}/getMe abgelehnt`,
    "Ablehnung als Objekt": token => ({ token, url: `https://api.telegram.org/bot${token}/getMe` }),
  };

  for (const [name, initError] of Object.entries(leakyErrors)) {
    test(`Anmeldefehler (${name}): Log nennt Agent und Kategorie, nie Token oder URL`, async () => {
      const { identities, sent } = setup(envWith("research", "cto"), ["cto"], initError);
      await identities.initialize();
      const failure = logs.find(l => l.includes("Bot für cto nicht angemeldet"));
      expect(failure).toBeDefined();
      for (const line of logs) {
        expect(line).not.toContain(tokenFor("cto"));
        expect(line).not.toContain("AAFakeAgentToken");
        expect(line).not.toContain("api.telegram.org");
      }
      // Rückfall greift trotzdem
      await identities.sendAsAgent("cto", 1, "a");
      expect(messagesOf(sent, "haupt")).toHaveLength(1);
    });
  }

  test("Fehlerkategorien: nur Art und HTTP-Code", () => {
    const token = tokenFor("cto");
    expect(initFailureCategory(leakyErrors["GrammyError mit Token in der Beschreibung"](token))).toBe("Telegram lehnt ab (401)");
    expect(initFailureCategory(leakyErrors["HttpError mit URL"](token))).toBe("Telegram nicht erreichbar");
    expect(initFailureCategory(leakyErrors["Error mit Telegram-URL"](token))).toBe("unbekannter Fehler");
    expect(initFailureCategory(leakyErrors["Ablehnung als String mit Token"](token))).toBe("unbekannter Fehler");
    expect(initFailureCategory(undefined)).toBe("unbekannter Fehler");
  });
});

describe("Senden", () => {
  test("eigener Agent mit Token sendet über seinen Bot, mit Output-Guard", async () => {
    await createAgent({ name: "projekt-planer", description: "Plant", systemPrompt: "Du planst." });
    const { identities, sent } = setup(envWith("projekt-planer"));
    await identities.initialize();
    await identities.sendAsAgent("projekt-planer", 1, "**Plan** steht", { threadId: 7 });
    const own = messagesOf(sent, "projekt-planer");
    expect(own).toHaveLength(1);
    expect(own[0].payload).toMatchObject({ text: "<b>Plan</b> steht", parse_mode: "HTML", message_thread_id: 7 });
    expect(own[0].payload.link_preview_options).toEqual({ is_disabled: true });
    expect(messagesOf(sent, "haupt")).toHaveLength(0);
  });

  test("Output-Guard auch für direkte Aufrufe am Agenten-Bot", async () => {
    const { identities, sent } = setup(envWith("research"));
    await identities.initialize();
    await identities.botFor("research").api.sendMessage(1, "siehe https://example.org", { parse_mode: "HTML" });
    const own = messagesOf(sent, "research");
    expect(own).toHaveLength(1);
    expect(own[0].payload.link_preview_options).toEqual({ is_disabled: true });
  });

  test("Knöpfe und Tipp-Anzeige über den eigenen Bot", async () => {
    await createAgent({ name: "planer", description: "Plant", systemPrompt: "Du planst." });
    const { identities, sent } = setup(envWith("planer"));
    await identities.initialize();
    const keyboard = new InlineKeyboard().text("Ja", "y");
    await identities.sendWithKeyboardAsAgent("Planer", 1, "Weiter?", keyboard, { threadId: 3 });
    await identities.sendTypingAsAgent("planer", 1, 3);
    const own = sent.filter(s => s.bot === "planer");
    expect(own.map(s => s.method)).toEqual(["sendMessage", "sendChatAction"]);
    expect(own[0].payload.reply_markup).toBe(keyboard);
    expect(own[1].payload).toMatchObject({ action: "typing", message_thread_id: 3 });
    expect(sent.filter(s => s.bot === "haupt")).toHaveLength(0);
  });

  test("Aliasse nur aus names.ts: cfo ist finance, orchestrator und unbekannte Namen der Haupt-Bot", async () => {
    const { identities, sent } = setup(envWith("finance"));
    await identities.initialize();
    await identities.sendAsAgent("CFO", 1, "a");
    await identities.sendAsAgent("orchestrator", 1, "b");
    await identities.sendAsAgent("unbekannt", 1, "c");
    expect(messagesOf(sent, "finance").map(s => s.payload.text)).toEqual(["a"]);
    expect(messagesOf(sent, "haupt").map(s => s.payload.text)).toEqual(["b", "c"]);
  });

  test("ohne Token und bei gescheiterter Anmeldung: Haupt-Bot", async () => {
    const { identities, sent } = setup(envWith("research"), ["research"]);
    await identities.initialize();
    await identities.sendAsAgent("research", 1, "a");
    await identities.sendAsAgent("content", 1, "b");
    expect(messagesOf(sent, "haupt").map(s => s.payload.text)).toEqual(["a", "b"]);
    expect(messagesOf(sent, "research")).toHaveLength(0);
  });

  test("nach dem Start gelöscht: Haupt-Bot; wiederhergestellt: wieder der eigene", async () => {
    const { identities, sent } = setup(envWith("cto"));
    await identities.initialize();
    await deleteAgent("cto");
    await identities.sendAsAgent("cto", 1, "weg");
    expect(messagesOf(sent, "haupt").map(s => s.payload.text)).toEqual(["weg"]);
    await restoreBuiltin("cto");
    await identities.sendAsAgent("cto", 1, "zurück");
    expect(messagesOf(sent, "cto").map(s => s.payload.text)).toEqual(["zurück"]);
  });

  test("nach dem Start angelegter Agent: Token greift erst beim nächsten Start", async () => {
    const env = envWith("spaet");
    const first = setup(env);
    await first.identities.initialize();
    await createAgent({ name: "spaet", description: "Kommt später", systemPrompt: "Du kommst später." });
    await first.identities.sendAsAgent("spaet", 1, "a");
    expect(first.created).toEqual([]);
    expect(messagesOf(first.sent, "haupt")).toHaveLength(1);

    const second = setup(env);
    await second.identities.initialize();
    await second.identities.sendAsAgent("spaet", 1, "b");
    expect(messagesOf(second.sent, "spaet")).toHaveLength(1);
  });
});

describe("Mention-Routing", () => {
  async function ready() {
    await createAgent({ name: "projekt-planer", description: "Plant", systemPrompt: "Du planst." });
    const ctx = setup(envWith("research", "projekt-planer", "cto"), ["cto"]);
    await ctx.identities.initialize();
    return ctx;
  }

  test("mitgelieferter Agent, Groß- und Kleinschreibung egal, Text bereinigt", async () => {
    const { identities } = await ready();
    expect(identities.agentForMention("@research_bot  such mal")).toEqual({ agent: "research", cleanedText: "such mal" });
    expect(identities.agentForMention("bitte @RESEARCH_BOT prüfen")).toEqual({ agent: "research", cleanedText: "bitte prüfen" });
  });

  test("eigener Agent", async () => {
    const { identities } = await ready();
    expect(identities.agentForMention("@projekt_planer_bot plan das")).toEqual({ agent: "projekt-planer", cleanedText: "plan das" });
  });

  test("nur die Mention: der Text bleibt", async () => {
    const { identities } = await ready();
    expect(identities.agentForMention("@research_bot")).toEqual({ agent: "research", cleanedText: "@research_bot" });
  });

  test("Haupt-Bot, längerer Name und fremde Namen zählen nicht", async () => {
    const { identities } = await ready();
    expect(identities.agentForMention("@haupt_bot hallo")).toBeNull();
    expect(identities.agentForMention("@research_botx hallo")).toBeNull();
    expect(identities.agentForMention("research_bot ohne at")).toBeNull();
  });

  test("ohne Token oder bei gescheiterter Anmeldung keine Mention", async () => {
    const { identities } = await ready();
    expect(identities.agentForMention("@content_bot hallo")).toBeNull();
    expect(identities.agentForMention("@cto_bot hallo")).toBeNull();
  });

  test("gelöschter Agent wird nicht mehr geholt", async () => {
    const { identities } = await ready();
    await deleteAgent("projekt-planer");
    expect(identities.agentForMention("@projekt_planer_bot plan das")).toBeNull();
  });
});
