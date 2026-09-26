/**
 * Topic-Zuordnung „Welcher Agent?" über das Rückfragen-Register (Issue #119):
 * Frage mit einer Option je aktivem Agenten, Handler über
 * setTopicMappingIfUnmapped, Ablauf bei anderweitiger Zuordnung, alte
 * topicmap:-Knöpfe. Echtes Register, echter Katalog und echte
 * config/topics.json, alles als Kopie im Temp-Verzeichnis (auch
 * data/topics-asked.json); echte Telegram-Seite der Rückfragen mit Api- und
 * Sende-Attrappe, verdrahtet wie in src/bot.ts. src/bot.ts wird nie geladen.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createAgent, deleteAgent, getAgentCatalogPaths, listAgents } from "../src/agents/catalog";
import {
  decideChoice,
  getChoice,
  onChoiceChange,
  onChoiceDecided,
  setChoicesFileForTests,
  type Choice,
} from "../src/lib/choices";
import type { SendAndRecordInput } from "../src/lib/outbox";
import { createTelegramChoices } from "../src/lib/telegram-choices";
import { createTopicChoices, legacyButtonPages, legacyButtons, TOPIC_MAP_TEXT, type TopicChoices } from "../src/lib/topic-choices";
import {
  markTopicMappingAsked,
  onTopicMappingSet,
  setTopicMapping,
  setTopicsAskedFileForTests,
  shouldAskTopicMapping,
} from "../src/lib/topic-setup";
import { toApiChoice } from "../src/web/choices";
import { botSetMapping } from "../src/web/bot-topics";
import { isolateAgentCatalog } from "./catalog-fixture";

const OWNER = "4711";
const GROUP = "-1001234567890";
const TOPIC = 77;
const LONG_ID = "a" + "b".repeat(28) + "c"; // 30 Zeichen, längste erlaubte Kennung

isolateAgentCatalog();
const dir = mkdtempSync(join(tmpdir(), "tybo-topic-choices-"));
afterAll(() => {
  setChoicesFileForTests(null);
  setTopicsAskedFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

let edits: { chatId: string; messageId: number; text: string }[] = [];
let sends: SendAndRecordInput[] = [];
let notices: SendAndRecordInput[] = [];
let changes: { chatId: string; topicId: number }[] = [];
let mappingEvents: { chatId: string; topicId: number; agent: string }[] = [];
let sendOk = true;
let messageId = 500;
let topics: TopicChoices;
let cleanup: (() => void)[] = [];

const api = {
  editMessageText: async (chatId: string, id: number, text: string) => void edits.push({ chatId, messageId: id, text }),
  editMessageReplyMarkup: async () => {},
};

function topicsFile(): string {
  return getAgentCatalogPaths().topicsFile!;
}

function topicsOnDisk(): Record<string, Record<string, string>> {
  return existsSync(topicsFile()) ? JSON.parse(readFileSync(topicsFile(), "utf8")) : {};
}

beforeEach(() => {
  const run = mkdtempSync(join(dir, "run-"));
  setChoicesFileForTests(join(run, "choices.json"));
  setTopicsAskedFileForTests(join(run, "topics-asked.json"));
  edits = [];
  sends = [];
  notices = [];
  changes = [];
  mappingEvents = [];
  sendOk = true;
  const telegram = createTelegramChoices({
    api,
    owner: OWNER,
    log: () => {},
    send: async input => {
      sends.push(input);
      if (!sendOk) return { sent: false, recorded: false, error: { kind: "send", message: "kaputt" } };
      return { sent: true, recorded: true, messages: [{ chatId: GROUP, messageId: ++messageId, part: "text", buttons: true }] };
    },
  });
  topics = createTopicChoices({
    sendChoice: choice => telegram.sendChoice(choice),
    notify: async input => {
      notices.push(input);
      return { sent: true, recorded: true };
    },
    topicChanged: change => changes.push(change),
    topicsFile: topicsFile(),
    log: () => {},
  });
  cleanup = [
    onChoiceChange(telegram.listener),
    onChoiceDecided("topicmap", topics.handler),
    onTopicMappingSet(topics.listener),
    onTopicMappingSet(change => mappingEvents.push(change)),
  ];
});

afterEach(async () => {
  await topics.settled();
  for (const off of cleanup) off();
});

/** Wie bot.ts: nur fragen, wenn noch nicht gefragt; dann merken und fragen */
async function askLikeBot(): Promise<Choice> {
  expect(await shouldAskTopicMapping(GROUP, TOPIC)).toBe(true);
  await markTopicMappingAsked(GROUP, TOPIC);
  expect(await topics.ask(GROUP, TOPIC)).toBe(true);
  const id = sends.at(-1)?.choiceId;
  expect(id).toBeString();
  return (await getChoice(id!))!;
}

describe("Frage", () => {
  test("Rückfrage topicmap im Topic, eine Option je aktivem Agenten, ohne Frist, einmal gefragt", async () => {
    const choice = await askLikeBot();
    expect(choice.kind).toBe("topicmap");
    expect(choice.conversation).toEqual({ type: "telegram", chatId: GROUP, topicId: TOPIC });
    expect(choice.expiresAt).toBeUndefined();
    expect(choice.ref).toBe(String(TOPIC));
    expect(choice.text).toBe(TOPIC_MAP_TEXT.question(TOPIC));
    const agents = listAgents();
    expect(choice.options).toEqual(agents.map(a => ({ key: a.name, label: a.displayName })));
    expect(choice.options.find(o => o.key === "research")?.label).toBe("Research Agent (Deep Research)");
    // In Telegram mit ch|-Knöpfen im Topic, im Verlauf mit choiceId
    const sent = sends.at(-1)!;
    expect(sent).toMatchObject({ chatId: GROUP, topicId: TOPIC, source: "topic", choiceId: choice.id });
    expect(sent.buttons!.flat().every(b => b.callback_data.startsWith(`ch|${choice.id}|`))).toBe(true);
    expect((await getChoice(choice.id))!.telegram).toHaveLength(1);
    // Zweite Nachricht im Topic: nicht noch einmal gefragt
    expect(await shouldAskTopicMapping(GROUP, TOPIC)).toBe(false);
  });

  test("mehr als 8 Agenten und eine 30-stellige Kennung: nichts abgeschnitten", async () => {
    await createAgent({ name: LONG_ID, description: "Lang", systemPrompt: "Du bist lang." });
    await createAgent({ name: "planer", description: "Plant", systemPrompt: "Du planst." });
    const choice = await askLikeBot();
    expect(choice.options.length).toBeGreaterThanOrEqual(10);
    expect(choice.options.map(o => o.key)).toEqual(listAgents().map(a => a.name));
    expect(choice.options.map(o => o.key)).toContain(LONG_ID);
    for (const row of sends.at(-1)!.buttons!) {
      for (const b of row) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    }
    const outcome = await decideChoice(choice.id, LONG_ID, "telegram");
    expect(outcome.status).toBe("decided");
    expect(topicsOnDisk()[GROUP][String(TOPIC)]).toBe(LONG_ID);
  });

  test("Senden scheitert: Frage zurückgezogen, bot.ts fragt mit den alten Knöpfen", async () => {
    sendOk = false;
    expect(await topics.ask(GROUP, TOPIC)).toBe(false);
    const c = (await getChoice(sends.at(-1)!.choiceId!))!;
    expect(c.state).toBe("expired");
    expect(legacyButtons(TOPIC, ["general", "research"])).toEqual([
      [
        { text: "general", callback_data: `topicmap:${TOPIC}:general` },
        { text: "research", callback_data: `topicmap:${TOPIC}:research` },
      ],
    ]);
  });

  test("101 Agenten: Rückfrage mit allen, Telegram in zwei Nachrichten, Agent Nr. 101 wählbar, genau eine Zuordnung", async () => {
    const names = Array.from({ length: 101 }, (_, i) => `a${i}`);
    const many = createTopicChoices({
      sendChoice: choice => createTelegramChoices({
        api,
        owner: OWNER,
        log: () => {},
        send: async input => {
          sends.push(input);
          return { sent: true, recorded: input.record !== false, messages: [{ chatId: GROUP, messageId: ++messageId, part: "text", buttons: true }] };
        },
      }).sendChoice(choice),
      notify: async input => {
        notices.push(input);
        return { sent: true, recorded: true };
      },
      topicChanged: () => {},
      topicsFile: topicsFile(),
      agents: () => names.map(name => ({ name, displayName: name.toUpperCase() })),
      isActiveAgent: name => names.includes(name),
      log: () => {},
    });
    cleanup.push(onChoiceDecided("topicmap", many.handler), onTopicMappingSet(many.listener));

    expect(await many.ask(GROUP, TOPIC)).toBe(true);
    // Register: alle 101 Optionen (der Browser zeigt sie an der Frage)
    const id = sends[0].choiceId!;
    const choice = (await getChoice(id))!;
    expect(choice.state).toBe("open");
    expect(choice.options.map(o => o.key)).toEqual(names);
    // Telegram: Frage mit 100 Knöpfen, Folge-Nachricht mit dem 101., nicht festgehalten
    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({ text: TOPIC_MAP_TEXT.question(TOPIC), choiceId: id });
    expect(sends[0].record).toBeUndefined();
    expect(sends[0].buttons!.flat()).toHaveLength(100);
    expect(sends[1]).toMatchObject({ chatId: GROUP, topicId: TOPIC, source: "topic", record: false });
    expect(sends[1].choiceId).toBeUndefined();
    expect(sends[1].buttons!.flat()).toEqual([{ text: "A100", callback_data: `ch|${id}|a100` }]);
    expect([...sends[0].buttons!.flat(), ...sends[1].buttons!.flat()].map(b => b.callback_data))
      .toEqual(names.map(n => `ch|${id}|${n}`));
    expect(choice.telegram).toHaveLength(2);

    const outcome = await decideChoice(id, "a100", "telegram");
    expect(outcome.status).toBe("decided");
    await many.settled();
    expect(topicsOnDisk()[GROUP]).toEqual({ [String(TOPIC)]: "a100" });
    expect(mappingEvents).toEqual([{ chatId: GROUP, topicId: TOPIC, agent: "a100" }]);
    expect((await getChoice(id))!.result).toMatchObject({ key: "a100", via: "telegram" });
    // Knöpfe verschwinden an beiden Nachrichten
    expect(edits.map(e => e.messageId).sort()).toEqual(choice.telegram!.map(r => r.messageId).sort());
    // Zweiter Klick ändert nichts mehr
    expect((await decideChoice(id, "a0", "web")).status).not.toBe("decided");
    expect(topicsOnDisk()[GROUP]).toEqual({ [String(TOPIC)]: "a100" });
    expect(notices).toEqual([]);
  });

  test("1001 Agenten: Browser-Rückfrage mit allen, letzter wählbar, Telegram in 11 Nachrichten, genau eine Zuordnung", async () => {
    const names = Array.from({ length: 1001 }, (_, i) => `a${i}`);
    const last = names[names.length - 1];
    const many = createTopicChoices({
      sendChoice: choice => createTelegramChoices({
        api,
        owner: OWNER,
        log: () => {},
        send: async input => {
          sends.push(input);
          return { sent: true, recorded: input.record !== false, messages: [{ chatId: GROUP, messageId: ++messageId, part: "text", buttons: true }] };
        },
      }).sendChoice(choice),
      notify: async input => {
        notices.push(input);
        return { sent: true, recorded: true };
      },
      topicChanged: () => {},
      topicsFile: topicsFile(),
      agents: () => names.map(name => ({ name, displayName: name.toUpperCase() })),
      isActiveAgent: name => names.includes(name),
      log: () => {},
    });
    cleanup.push(onChoiceDecided("topicmap", many.handler), onTopicMappingSet(many.listener));

    expect(await many.ask(GROUP, TOPIC)).toBe(true);
    // Browser-Rückfrage: offene Frage im Register mit allen 1001 Knöpfen (API-Format des Browsers)
    const id = sends[0].choiceId!;
    const choice = (await getChoice(id))!;
    expect(choice.state).toBe("open");
    expect(choice.conversation).toEqual({ type: "telegram", chatId: GROUP, topicId: TOPIC });
    const view = toApiChoice(choice);
    expect(view.state).toBe("open");
    expect(view.options.map(o => o.key)).toEqual(names);
    expect(view.options.at(-1)).toEqual({ key: last, label: last.toUpperCase() });
    // Telegram: 10 Nachrichten mit je 100 Knöpfen, die elfte mit dem letzten; nur die erste festgehalten
    expect(sends.map(s => s.buttons!.flat().length)).toEqual([...Array(10).fill(100), 1]);
    expect(sends[0]).toMatchObject({ text: TOPIC_MAP_TEXT.question(TOPIC), choiceId: id });
    expect(sends[0].record).toBeUndefined();
    for (const s of sends.slice(1)) {
      expect(s).toMatchObject({ chatId: GROUP, topicId: TOPIC, source: "topic", record: false });
      expect(s.choiceId).toBeUndefined();
    }
    expect(sends.flatMap(s => s.buttons!.flat()).map(b => b.callback_data)).toEqual(names.map(n => `ch|${id}|${n}`));
    expect(choice.telegram).toHaveLength(11);

    // Letzter Agent im Browser gewählt
    expect((await decideChoice(id, last, "web")).status).toBe("decided");
    await many.settled();
    expect(topicsOnDisk()[GROUP]).toEqual({ [String(TOPIC)]: last });
    expect(mappingEvents).toEqual([{ chatId: GROUP, topicId: TOPIC, agent: last }]);
    expect((await getChoice(id))!.result).toMatchObject({ key: last, via: "web" });
    // Zweiter Klick aus Telegram ändert nichts mehr
    expect((await decideChoice(id, "a0", "telegram")).status).not.toBe("decided");
    expect(topicsOnDisk()[GROUP]).toEqual({ [String(TOPIC)]: last });
    expect(mappingEvents).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  test("alte Knöpfe ohne Register: höchstens 100 je Nachricht, keiner fehlt", () => {
    const names = Array.from({ length: 205 }, (_, i) => `a${i}`);
    const pages = legacyButtonPages(TOPIC, names);
    expect(pages.map(p => p.flat().length)).toEqual([100, 100, 5]);
    expect(pages.flatMap(p => p.flat()).map(b => b.callback_data)).toEqual(names.map(n => `topicmap:${TOPIC}:${n}`));
  });

  test("während des Anlegens anderweitig zugeordnet: Frage läuft ab, nichts gesendet", async () => {
    writeFileSync(topicsFile(), JSON.stringify({ [GROUP]: { [String(TOPIC)]: "finance" } }));
    const created: Choice[] = [];
    const racy = createTopicChoices({
      sendChoice: async () => {
        throw new Error("darf nicht senden");
      },
      notify: async () => ({ sent: true, recorded: true }),
      topicChanged: () => {},
      topicsFile: topicsFile(),
      log: () => {},
      createChoice: async input => {
        const { createChoice } = await import("../src/lib/choices");
        const c = await createChoice(input);
        created.push(c);
        return c;
      },
    });
    expect(await racy.ask(GROUP, TOPIC)).toBe(true);
    expect((await getChoice(created[0].id))!.state).toBe("expired");
  });
});

describe("Entscheidung", () => {
  test("Klick auf Research im Browser: Zuordnung genau einmal, Telegram zeigt (im Browser), Chip-Ereignis", async () => {
    const choice = await askLikeBot();
    const outcome = await decideChoice(choice.id, "research", "web");
    expect(outcome.status).toBe("decided");
    if (outcome.status !== "decided") return;
    expect(outcome.choice.handlerError).toBeUndefined();
    expect(topicsOnDisk()).toEqual({ [GROUP]: { [String(TOPIC)]: "research" } });
    expect(mappingEvents).toEqual([{ chatId: GROUP, topicId: TOPIC, agent: "research" }]);
    expect(changes).toEqual([{ chatId: GROUP, topicId: TOPIC }]);
    expect(edits).toHaveLength(1);
    expect(edits[0].text.endsWith("✓ Research Agent (Deep Research) (im Browser)")).toBe(true);
    expect(notices).toEqual([]);
    // Zweiter Klick (Telegram) ändert nichts mehr
    expect((await decideChoice(choice.id, "finance", "telegram")).status).toBe("already");
    await topics.settled();
    expect(topicsOnDisk()[GROUP][String(TOPIC)]).toBe("research");
    expect(mappingEvents).toHaveLength(1);
  });

  test("gleichzeitige Klicks aus Browser und Telegram: genau eine Zuordnung", async () => {
    const choice = await askLikeBot();
    const results = await Promise.all([
      decideChoice(choice.id, "research", "web"),
      decideChoice(choice.id, "finance", "telegram"),
    ]);
    expect(results.map(r => r.status).sort()).toEqual(["already", "decided"]);
    const winner = results.find(r => r.status === "decided")!;
    const key = winner.status === "decided" ? winner.choice.result!.key : "";
    expect(mappingEvents).toEqual([{ chatId: GROUP, topicId: TOPIC, agent: key }]);
    expect(topicsOnDisk()[GROUP][String(TOPIC)]).toBe(key);
  });

  test("gelöschter Agent: nichts zugeordnet, Meldung im Topic, Fehler an der Frage", async () => {
    await createAgent({ name: "planer", description: "Plant", systemPrompt: "Du planst." });
    const choice = await askLikeBot();
    await deleteAgent("planer");
    const outcome = await decideChoice(choice.id, "planer", "web");
    expect(outcome.status).toBe("decided");
    if (outcome.status !== "decided") return;
    expect(outcome.choice.handlerError?.message).toContain("gelöscht");
    expect(topicsOnDisk()[GROUP]?.[String(TOPIC)]).toBeUndefined();
    expect(mappingEvents).toEqual([]);
    expect(notices).toEqual([
      { chatId: GROUP, topicId: TOPIC, text: TOPIC_MAP_TEXT.gone("planer"), format: "plain", source: "topic" },
    ]);
  });

  test("Schreibfehler: Meldung im Topic, Fehler an der Frage", async () => {
    const choice = await askLikeBot();
    writeFileSync(topicsFile(), "{kaputt");
    const outcome = await decideChoice(choice.id, "research", "web");
    expect(outcome.status === "decided" && outcome.choice.handlerError).toBeTruthy();
    expect(readFileSync(topicsFile(), "utf8")).toBe("{kaputt");
    expect(notices.map(n => n.text)).toEqual([TOPIC_MAP_TEXT.failed]);
  });
});

describe("Ablauf bei anderweitiger Zuordnung", () => {
  test("Zuordnung über die Einstellungen lässt die Frage ablaufen, später Klick ändert nichts", async () => {
    const choice = await askLikeBot();
    await botSetMapping(GROUP, TOPIC, "finance", topicsFile());
    await topics.settled();
    expect((await getChoice(choice.id))!.state).toBe("expired");
    expect(edits.map(e => e.text.split("\n").at(-1))).toEqual(["Abgelaufen, nichts geändert"]);
    expect(changes).toEqual([{ chatId: GROUP, topicId: TOPIC }]);
    expect((await decideChoice(choice.id, "research", "telegram")).status).toBe("expired");
    expect(topicsOnDisk()[GROUP][String(TOPIC)]).toBe("finance");
  });

  test("verspäteter Klick vor dem Ablauf überschreibt keine inzwischen gesetzte Zuordnung", async () => {
    const choice = await askLikeBot();
    // Wie ein Anlegen, dessen Ereignis noch nicht durch ist: Zuhörer kurz weg
    cleanup[2]();
    await setTopicMapping(GROUP, TOPIC, "finance", topicsFile());
    cleanup[2] = onTopicMappingSet(topics.listener);
    const outcome = await decideChoice(choice.id, "research", "web");
    expect(outcome.status === "decided" && outcome.choice.handlerError?.message).toContain("anders zugeordnet");
    expect(topicsOnDisk()[GROUP][String(TOPIC)]).toBe("finance");
    expect(notices.map(n => n.text)).toEqual([TOPIC_MAP_TEXT.mapped("finance")]);
  });

  test("Zuordnung eines anderen Topics lässt die Frage offen", async () => {
    const choice = await askLikeBot();
    await botSetMapping(GROUP, TOPIC + 1, "finance", topicsFile());
    await topics.settled();
    expect((await getChoice(choice.id))!.state).toBe("open");
  });
});

describe("alte topicmap:-Knöpfe", () => {
  test("wirken wie bisher und lassen eine offene Rückfrage ablaufen", async () => {
    const choice = await askLikeBot();
    const text = await topics.legacy(GROUP, String(TOPIC), "research");
    expect(text).toBe(TOPIC_MAP_TEXT.legacyDone(String(TOPIC), "research"));
    await topics.settled();
    expect(topicsOnDisk()[GROUP][String(TOPIC)]).toBe("research");
    expect((await getChoice(choice.id))!.state).toBe("expired");
    // Wie bisher auch über eine bestehende Zuordnung hinweg
    expect(await topics.legacy(GROUP, String(TOPIC), "finance")).toBe(TOPIC_MAP_TEXT.legacyDone(String(TOPIC), "finance"));
    expect(topicsOnDisk()[GROUP][String(TOPIC)]).toBe("finance");
  });

  test("gelöschter Agent und kaputte Topic-ID: nichts geschrieben", async () => {
    await createAgent({ name: "planer", description: "Plant", systemPrompt: "Du planst." });
    await deleteAgent("planer");
    expect(await topics.legacy(GROUP, String(TOPIC), "planer")).toBe(TOPIC_MAP_TEXT.legacyGone("planer"));
    expect(await topics.legacy(GROUP, "abc", "research")).toBe(TOPIC_MAP_TEXT.legacyFailed);
    expect(topicsOnDisk()).toEqual({});
    expect(mappingEvents).toEqual([]);
  });
});
