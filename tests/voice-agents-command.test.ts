/**
 * Issue #492, Checkbox 1: /sprachagent und /sprachagenten über die gemeinsame
 * Befehls-Schicht in Telegram, Browser (auch reines Web-Gespräch ohne Telegram)
 * und Terminal. Die Sprachschicht ist eine Attrappe hinter services.voiceAgents;
 * kein Anbieteraufruf. src/bot.ts wird weder gestartet noch importiert.
 */

import { describe, expect, test } from "bun:test";
import { commandRegistry, HELP_TEXT } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices } from "../src/lib/commands/types";
import { formatVoiceAgentOverview, VOICE_AGENT_COMMAND_TEXT as TEXT } from "../src/lib/commands/voice-agents";
import type { ChoiceConversation } from "../src/lib/choices";
import type { LinkOutcome, OfferDeleteOutcome, StartTestOutcome, VoiceAgentEntry, VoiceAgentOverview } from "../src/lib/voice-agents/manage";
import type { StartDraftOutcome } from "../src/lib/voice-agents/drafts";
import { createBotCommands } from "../src/web/bot-commands";

const USER = "4711";
const GROUP = "-1001234567890";
const WEB_ID = "0c1a2b3c-0000-4000-8000-000000000000";

function entry(over: Partial<VoiceAgentEntry> = {}): VoiceAgentEntry {
  return {
    kennung: "jarvis",
    name: "Jarvis",
    vorlage: "jarvis",
    gehirn: { art: "bruecke", modell: "claude-opus-5-5", denkauftrag: true },
    gedaechtnis: "voll",
    web: true,
    telefon: { nummer: "kennung-der-nummer", anrufer: "freigegeben" },
    angelegt: true,
    letzterTest: null,
    laufenderTest: null,
    minuten: { limit: 600, verbraucht: null },
    ...over,
  };
}

/** Attrappe des Dienstes: merkt sich Aufrufe samt Gespräch */
function fakeService(options: { overview?: VoiceAgentOverview; start?: StartTestOutcome; offer?: OfferDeleteOutcome; link?: LinkOutcome; throws?: boolean } = {}) {
  const calls: { what: string; kennung?: string; conversation?: ChoiceConversation }[] = [];
  const service: NonNullable<CommandServices["voiceAgents"]> = {
    overview: async () => {
      calls.push({ what: "overview" });
      if (options.throws) throw new Error("kaputt");
      return options.overview ?? { agents: [entry()], fehler: [] };
    },
    startTest: async (kennung, conversation) => {
      calls.push({ what: "testen", kennung, conversation });
      return options.start ?? { status: "gestartet", name: "Jarvis" };
    },
    offerDelete: async (kennung, conversation) => {
      calls.push({ what: "loeschen", kennung, conversation });
      return options.offer ?? { status: "gefragt", name: "Jarvis" };
    },
    link: async kennung => {
      calls.push({ what: "link", kennung });
      return options.link ?? { status: "link", name: "Jarvis", url: "https://tybo.example.org/sa/jarvis" };
    },
  };
  return { calls, services: { voiceAgents: service } as unknown as CommandServices };
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

describe("/sprachagent erkennen", () => {
  test("beide Befehle in allen Kanälen, mit und ohne Argument; /agent bleibt eigener Befehl", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      expect(commandRegistry.match("/sprachagent", channel)?.command.name).toBe("sprachagent");
      expect(commandRegistry.match("/sprachagent testen jarvis", channel)?.args).toBe("testen jarvis");
      expect(commandRegistry.match("/sprachagenten", channel)?.command.name).toBe("sprachagenten");
      expect(commandRegistry.match("/sprachagentx", channel)).toBeNull();
      expect(commandRegistry.match("/agent", channel)?.command.name).toBe("agent");
      const names = commandRegistry.list(channel).map(c => c.name);
      expect(names).toContain("sprachagent");
      expect(names).toContain("sprachagenten");
    }
  });

  test("/help nennt den Befehl", () => {
    expect(HELP_TEXT).toContain("/sprachagent");
    expect(HELP_TEXT).toContain("/sprachagenten");
  });
});

describe("Hilfe und Liste", () => {
  test("/sprachagent ohne Unterbefehl: Hilfe, /sprachagenten ohne Argument: Liste", async () => {
    const help = fakeService();
    expect(await telegram("/sprachagent", help.services)).toEqual([TEXT.help]);
    expect(help.calls).toEqual([]);

    const list = fakeService();
    const replies = await telegram("/sprachagenten", list.services);
    expect(list.calls).toEqual([{ what: "overview" }]);
    expect(replies.join("\n")).toContain("Jarvis (jarvis)");
    expect(replies.join("\n")).not.toBe(TEXT.help);
  });

  test("/sprachagent liste und /sprachagenten liefern dieselbe Liste, in allen Kanälen", async () => {
    for (const run of [
      (t: string, s: CommandServices) => telegram(t, s),
      (t: string, s: CommandServices) => telegram(t, s, 7),
      (t: string, s: CommandServices) => webOrTerminal("web", t, s),
      (t: string, s: CommandServices) => webOrTerminal("terminal", t, s),
      // Direktchat ohne Telegram
      (t: string, s: CommandServices) => webOrTerminal("web", t, s, "dm", "web"),
    ]) {
      const a = fakeService();
      const b = fakeService();
      const viaSub = (await run("/sprachagent liste", a.services)).join("\n");
      const viaList = (await run("/sprachagenten", b.services)).join("\n");
      expect(viaSub).toContain("Jarvis (jarvis)");
      expect(viaList).toContain("Jarvis (jarvis)");
    }
  });

  test("unbekannter Unterbefehl und zu viele Wörter: Hilfe, kein Dienstaufruf", async () => {
    const svc = fakeService();
    expect(await telegram("/sprachagent machen jarvis", svc.services)).toEqual([TEXT.help]);
    expect(await telegram("/sprachagent testen jarvis jetzt", svc.services)).toEqual([TEXT.help]);
    expect(svc.calls).toEqual([]);
  });

  test("Unterbefehl ohne Kennung fragt nach", async () => {
    const svc = fakeService();
    expect(await telegram("/sprachagent testen", svc.services)).toEqual([TEXT.needKennung("testen")]);
    expect(await telegram("/sprachagent löschen", svc.services)).toEqual([TEXT.needKennung("loeschen")]);
    expect(await telegram("/sprachagent link", svc.services)).toEqual([TEXT.needKennung("link")]);
    expect(svc.calls).toEqual([]);
  });

  test("ohne Dienst (web:dev, Demo): klare Meldung statt Fehler", async () => {
    const none = {} as unknown as CommandServices;
    expect(await telegram("/sprachagent liste", none)).toEqual([TEXT.unavailable]);
    expect(await webOrTerminal("web", "/sprachagenten", none)).toEqual([TEXT.unavailable]);
    expect(await webOrTerminal("terminal", "/sprachagent testen jarvis", none)).toEqual([TEXT.unavailable]);
  });

  test("Fehler im Dienst: kurze Meldung, kein Absturz", async () => {
    const svc = fakeService({ throws: true });
    expect(await telegram("/sprachagent liste", svc.services)).toEqual([TEXT.failed]);
  });
});

describe("Liste formatieren", () => {
  test("Name, Vorlage, Gehirn, Gedächtnis, Zugang, letzter Test, Minuten mit unbekanntem Verbrauch", () => {
    const text = formatVoiceAgentOverview({
      agents: [
        entry({
          letzterTest: {
            gestartetAm: "2026-11-07T09:00:00Z",
            beendetAm: "2026-11-07T09:03:00Z",
            ergebnis: "durchgefallen",
            tests: [
              { name: "A", status: "bestanden" },
              { name: "B", status: "durchgefallen", kriterium: "nennt Termine" },
            ],
          },
        }),
        entry({ kennung: "empfang", name: "Empfang", vorlage: "anrufannahme", gehirn: { art: "anbieter", modell: "claude-sonnet-5-5", denkauftrag: false }, gedaechtnis: "keins", web: false, telefon: { nummer: "nr-1", anrufer: "alle" }, angelegt: false, minuten: { limit: 300, verbraucht: null } }),
      ],
      fehler: [{ datei: "kaputt.json", fehler: ["name: Pflichtfeld fehlt"] }],
    });
    expect(text).toContain("Sprachagenten (2)");
    expect(text).toContain("Jarvis (jarvis)");
    expect(text).toContain("Vorlage: jarvis · Gehirn: Brücke, claude-opus-5-5 · Gedächtnis: voll");
    expect(text).toContain("Zugang: Web-Link, Telefon (Nummer beim Anbieter: kennung-der-nummer, Anrufer: freigegeben)");
    expect(text).toContain("Letzter Testlauf: bestanden 1 von 2");
    expect(text).toContain("Minuten im Monat: Verbrauch unbekannt, Limit 600");
    expect(text).not.toMatch(/Minuten im Monat: 0/);
    expect(text).toContain("Empfang (empfang)");
    expect(text).toContain("Gehirn: Anbieter, claude-sonnet-5-5");
    expect(text).toContain("Beim Anbieter: noch nicht angelegt");
    expect(text).toContain("Letzter Testlauf: noch keiner");
    expect(text).toContain("kaputt.json: name: Pflichtfeld fehlt");
  });

  test("ohne Rezepte: Hinweis auf config/voice-agents/", () => {
    expect(formatVoiceAgentOverview({ agents: [], fehler: [] })).toBe(TEXT.empty);
  });

  test("laufender und nicht abgeholter Lauf, Zeitüberschreitung, Fehler, kein Zugang", () => {
    const run = (ergebnis: "zeitueberschreitung" | "fehler") => ({ gestartetAm: "2026-11-07T09:00:00Z", beendetAm: "2026-11-07T09:15:00Z", ergebnis, tests: [] });
    expect(formatVoiceAgentOverview({ agents: [entry({ laufenderTest: { gestartetAm: "2026-11-07T09:00:00Z", verfolgt: true } })], fehler: [] })).toContain("läuft gerade seit");
    expect(formatVoiceAgentOverview({ agents: [entry({ laufenderTest: { gestartetAm: "2026-11-07T09:00:00Z", verfolgt: false } })], fehler: [] })).toContain("nicht abgeholt");
    expect(formatVoiceAgentOverview({ agents: [entry({ letzterTest: run("zeitueberschreitung") })], fehler: [] })).toContain("kein Ergebnis in der Frist");
    expect(formatVoiceAgentOverview({ agents: [entry({ letzterTest: run("fehler") })], fehler: [] })).toContain("Abfrage gescheitert");
    expect(formatVoiceAgentOverview({ agents: [entry({ web: false, telefon: undefined })], fehler: [] })).toContain("Zugang: keiner");
    expect(formatVoiceAgentOverview({ agents: [entry({ problem: "Zustand nicht lesbar" })], fehler: [] })).toContain("⚠️ Zustand nicht lesbar");
  });
});

describe("testen", () => {
  test("startet mit dem Gespräch des Befehls, je Kanal", async () => {
    const cases: [() => Promise<string[]>, ChoiceConversation, ReturnType<typeof fakeService>][] = [];
    const dm = fakeService();
    cases.push([() => telegram("/sprachagent testen Jarvis", dm.services), { type: "telegram", chatId: USER }, dm]);
    const topic = fakeService();
    cases.push([() => telegram("/sprachagent testen jarvis", topic.services, 7), { type: "telegram", chatId: GROUP, topicId: 7 }, topic]);
    const web = fakeService();
    cases.push([() => webOrTerminal("web", "/sprachagent testen jarvis", web.services), { type: "web", conversationId: WEB_ID }, web]);
    const terminal = fakeService();
    cases.push([() => webOrTerminal("terminal", "/sprachagent testen jarvis", terminal.services), { type: "web", conversationId: WEB_ID }, terminal]);
    // Direktchat ohne Telegram: Chat "web"
    const noTelegram = fakeService();
    cases.push([() => webOrTerminal("web", "/sprachagent testen jarvis", noTelegram.services, "dm", "web"), { type: "telegram", chatId: "web" }, noTelegram]);
    for (const [run, conversation, svc] of cases) {
      expect(await run()).toEqual([TEXT.testStarted("Jarvis")]);
      expect(svc.calls).toEqual([{ what: "testen", kennung: "jarvis", conversation }]);
    }
  });

  test("Ausgänge: unbekannt, kein Anbieter, nicht angelegt, läuft schon, Fehler", async () => {
    const reply = async (start: StartTestOutcome) => (await telegram("/sprachagent testen jarvis", fakeService({ start }).services))[0];
    expect(await reply({ status: "unbekannt" })).toBe(TEXT.unknown("jarvis"));
    expect(await reply({ status: "kein_anbieter" })).toBe(TEXT.noProvider);
    expect(await reply({ status: "nicht_angelegt", name: "Jarvis" })).toBe(TEXT.notDeployed("Jarvis"));
    expect(await reply({ status: "laeuft", name: "Jarvis", seit: "2026-11-07T09:00:00Z" })).toContain("läuft schon ein Testlauf");
    expect(await reply({ status: "fehler", name: "Jarvis", fehler: "HTTP 500" })).toBe(TEXT.testFailed("Jarvis", "HTTP 500"));
  });
});

describe("loeschen und link", () => {
  test("loeschen stellt nur die Rückfrage, im Gespräch des Befehls; löschen mit Umlaut geht auch", async () => {
    const svc = fakeService();
    expect(await webOrTerminal("web", "/sprachagent loeschen jarvis", svc.services)).toEqual([TEXT.deleteAsked("Jarvis")]);
    expect(await telegram("/sprachagent löschen jarvis", svc.services, 7)).toEqual([TEXT.deleteAsked("Jarvis")]);
    expect(svc.calls).toEqual([
      { what: "loeschen", kennung: "jarvis", conversation: { type: "web", conversationId: WEB_ID } },
      { what: "loeschen", kennung: "jarvis", conversation: { type: "telegram", chatId: GROUP, topicId: 7 } },
    ]);
  });

  test("loeschen: unbekannte Kennung und nicht zugestellte Rückfrage", async () => {
    expect(await telegram("/sprachagent loeschen gibtsnicht", fakeService({ offer: { status: "unbekannt" } }).services)).toEqual([TEXT.unknown("gibtsnicht")]);
    expect(await telegram("/sprachagent loeschen jarvis", fakeService({ offer: { status: "nicht_zugestellt" } }).services)).toEqual([TEXT.deleteNotDelivered]);
  });

  test("link (Issue #494): Adresse der Gesprächsseite, sonst der Grund; unbekannte Kennung", async () => {
    const [reply] = await telegram("/sprachagent link jarvis", fakeService().services);
    expect(reply).toBe(TEXT.link("Jarvis", "https://tybo.example.org/sa/jarvis"));
    expect(reply).toContain("https://tybo.example.org/sa/jarvis");
    expect(reply).toContain("Anmeldung");
    expect(await webOrTerminal("terminal", "/sprachagent link jarvis", fakeService({ link: { status: "kein_web", name: "Jarvis" } }).services)).toEqual([TEXT.noWeb("Jarvis")]);
    expect(await telegram("/sprachagent link jarvis", fakeService({ link: { status: "gesperrt", name: "Jarvis" } }).services)).toEqual([TEXT.linkLocked("Jarvis")]);
    expect(await telegram("/sprachagent link jarvis", fakeService({ link: { status: "keine_webui", name: "Jarvis" } }).services)).toEqual([TEXT.noWebUi("Jarvis")]);
    expect(await telegram("/sprachagent link jarvis", fakeService({ link: { status: "kaputt", name: "Jarvis" } }).services)).toEqual([TEXT.linkBroken("Jarvis")]);
    expect(await telegram("/sprachagent link x", fakeService({ link: { status: "unbekannt" } }).services)).toEqual([TEXT.unknown("x")]);
  });

  test("/sprachagenten nimmt dieselben Unterbefehle", async () => {
    const svc = fakeService();
    expect(await telegram("/sprachagenten testen jarvis", svc.services)).toEqual([TEXT.testStarted("Jarvis")]);
  });
});

/** Attrappe der Entwürfe (Issue #493): merkt sich Beschreibung bzw. Kennung und Wunsch samt Gespräch */
function fakeDrafts(outcome: StartDraftOutcome = { status: "gestartet", id: "20261107-090001-a1b2c3", jobId: "j" }) {
  const calls: { what: string; kennung?: string; text: string; conversation: ChoiceConversation }[] = [];
  const services = {
    voiceDrafts: {
      startNew: async (text: string, conversation: ChoiceConversation) => (calls.push({ what: "neu", text, conversation }), outcome),
      startChange: async (kennung: string, text: string, conversation: ChoiceConversation) => (calls.push({ what: "aendern", kennung, text, conversation }), outcome),
    },
  } as unknown as CommandServices;
  return { calls, services };
}

describe("/sprachagent neu und aendern (Issue #493)", () => {
  const RUNS = [
    ["Telegram Direktchat", (t: string, s: CommandServices) => telegram(t, s), { type: "telegram", chatId: USER }],
    ["Telegram Topic", (t: string, s: CommandServices) => telegram(t, s, 7), { type: "telegram", chatId: GROUP, topicId: 7 }],
    ["Browser", (t: string, s: CommandServices) => webOrTerminal("web", t, s), { type: "web", conversationId: WEB_ID }],
    ["Terminal", (t: string, s: CommandServices) => webOrTerminal("terminal", t, s), { type: "web", conversationId: WEB_ID }],
  ] as const;

  for (const [label, run, conversation] of RUNS) {
    test(`${label}: mehrwortige Beschreibung und Wunsch kommen vollständig an, mit dem Gespräch des Befehls`, async () => {
      const svc = fakeDrafts();
      expect(await run("/sprachagent neu Ein Segel-Trainer, der streng prüft und duzt", svc.services)).toEqual([TEXT.draftStarted("neu")]);
      expect(await run("/sprachagent aendern Segel-Trainer Antworte kürzer und frag öfter nach", svc.services)).toEqual([TEXT.draftStarted("aendern", "segel-trainer")]);
      expect(await run("/sprachagent ändern jarvis bitte siezen", svc.services)).toEqual([TEXT.draftStarted("aendern", "jarvis")]);
      expect(svc.calls).toEqual([
        { what: "neu", text: "Ein Segel-Trainer, der streng prüft und duzt", conversation },
        { what: "aendern", kennung: "segel-trainer", text: "Antworte kürzer und frag öfter nach", conversation },
        { what: "aendern", kennung: "jarvis", text: "bitte siezen", conversation },
      ] as any);
    });
  }

  test("ohne Beschreibung, Kennung oder Wunsch: Rückfrage, kein Dienstaufruf", async () => {
    const svc = fakeDrafts();
    expect(await telegram("/sprachagent neu", svc.services)).toEqual([TEXT.needDescription]);
    expect(await telegram("/sprachagent aendern", svc.services)).toEqual([TEXT.needKennung("aendern")]);
    expect(await telegram("/sprachagent aendern jarvis", svc.services)).toEqual([TEXT.needWish("jarvis")]);
    expect(svc.calls).toEqual([]);
  });

  test("Ausgänge des Dienstes in Klartext", async () => {
    const cases: [StartDraftOutcome, string][] = [
      [{ status: "unbekannt" }, TEXT.unknown("jarvis")],
      [{ status: "zu_lang" }, TEXT.draftTooLong],
      [{ status: "zu_viele" }, TEXT.draftTooMany],
      [{ status: "kaputt", fehler: "Rezept jarvis: x" }, TEXT.draftBroken("jarvis", "Rezept jarvis: x")],
      [{ status: "fehler", fehler: "Job-Ordner nicht anlegbar" }, TEXT.draftFailed("Job-Ordner nicht anlegbar")],
    ];
    for (const [outcome, text] of cases) expect(await telegram("/sprachagent aendern jarvis lauter", fakeDrafts(outcome).services)).toEqual([text]);
  });

  test("ohne Dienst (web:dev, Demo): klare Meldung; die Hilfe nennt beide Unterbefehle", async () => {
    expect(await webOrTerminal("web", "/sprachagent neu Kochhilfe", {} as CommandServices)).toEqual([TEXT.draftsUnavailable]);
    expect(TEXT.help).toContain("/sprachagent neu <beschreibung>");
    expect(TEXT.help).toContain("/sprachagent aendern <kennung> <wunsch>");
  });
});

