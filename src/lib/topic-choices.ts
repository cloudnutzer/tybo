/**
 * Topic-Zuordnung „Welcher Agent?" über das Rückfragen-Register (Issue #119,
 * Entscheidung 0017).
 *
 * Kommt eine Telegram-Nachricht in einem Topic ohne Agenten an, fragt der Bot
 * (weiter genau einmal, data/topics-asked.json in bot.ts) nicht mehr mit
 * eigenen topicmap:-Knöpfen, sondern mit einer Rückfrage kind "topicmap":
 * - Gespräch der Frage ist Chat und Topic, ref die Topic-ID.
 * - Eine Option je aktivem Agenten aus dem Katalog: Schlüssel = Agenten-ID,
 *   Beschriftung = Anzeigename. Nichts wird abgeschnitten: mehr als 100
 *   Agenten (Grenze von Telegram je Nachricht) verteilt sendChoice auf
 *   Folge-Nachrichten, im Browser stehen alle Knöpfe an der Frage. Die
 *   Schutzgrenze CHOICE_OPTIONS_MAX des Registers gilt für diese Art nicht,
 *   jeder aktive Agent bleibt auch im Browser auswählbar.
 * - Ohne eigene Frist. Das Register räumt offene Fragen trotzdem nach
 *   CHOICE_MAX_AGE_MS (7 Tage) ab; die Telegram-Nachricht zeigt dann
 *   „Abgelaufen", zuordnen geht weiter über die Einstellungen.
 * - Zugestellt über sendChoice: in Telegram mit "ch|"-Knöpfen, im Browser mit
 *   Knöpfen im Verlauf des Topics. Klappt das nicht (Register nicht
 *   schreibbar, Topic außerhalb der Forum-Gruppe der WebUI), fragt bot.ts wie
 *   früher mit topicmap:-Knöpfen (legacyButtonPages, ebenfalls höchstens 100
 *   Knöpfe je Nachricht).
 *
 * Entscheidung: Der Handler der Art "topicmap" läuft nur im Gewinnerprozess
 * von decideChoice. Er schreibt über setTopicMappingIfUnmapped, also nur,
 * solange das Topic noch keinen Agenten hat und der Agent noch aktiv ist,
 * beides in der Schreibkette von config/topics.json geprüft. Geht das nicht
 * (Agent gelöscht, inzwischen anders zugeordnet, Schreibfehler), steht eine
 * Meldung im Topic, in Telegram und im Browser, und der Handler wirft, damit
 * das Register den Fehler an der Frage vermerkt.
 *
 * Ablauf: Jede geschriebene Zuordnung (onTopicMappingSet: Einstellungen,
 * Anlegen im Browser, alte Knöpfe, die Rückfrage selbst) lässt offene
 * Zuordnungsfragen desselben Topics ablaufen und meldet die Änderung an die
 * WebUI (topicChanged), damit Kopfzeilen-Chip und Seitenleiste ohne Neuladen
 * wechseln.
 *
 * Alte Knöpfe topicmap:<topicId>:<agent> (legacy) wirken wie bisher: sie
 * setzen die Zuordnung, auch über eine bestehende hinweg.
 *
 * Ins Log kommen nur IDs, nie Fragetexte.
 */

import { isActiveAgent, listAgents } from "../agents/catalog";
import {
  createChoice,
  expireChoice,
  listChoices,
  type Choice,
  type ChoiceHandler,
  type ChoiceOption,
  type CreateChoiceInput,
  type ExpireOutcome,
} from "./choices";
import type { InlineButton, SendAndRecordInput, SendAndRecordResult } from "./outbox";
import {
  getMappedAgent,
  setTopicMapping,
  setTopicMappingIfUnmapped,
  TopicAgentInactive,
  TOPICS_CONFIG_PATH,
  type SetIfUnmappedResult,
  type TopicMappingChange,
} from "./topic-setup";

/** source der Meldungen, wie CHOICE_SOURCES.topicmap */
export const TOPIC_MAP_SOURCE = "topic";

export const TOPIC_MAP_TEXT = {
  question: (topicId: number) =>
    `Dieses Topic (ID ${topicId}) ist noch keinem Agent zugeordnet. Wer soll hier antworten? Bis zur Auswahl übernimmt general.`,
  gone: (label: string) =>
    `Den Agent „${label}" gibt es nicht mehr, das Topic bleibt ohne Zuordnung. Zuordnen geht in den Einstellungen, /topics zeigt die Zuordnung.`,
  mapped: (agent: string) => `Dieses Topic gehört inzwischen dem Agent „${agent}", nichts geändert.`,
  failed: "Die Zuordnung ist nicht gespeichert (Fehler beim Schreiben von config/topics.json, siehe Logs).",
  legacyGone: (agent: string) => `Den Agent "${agent}" gibt es nicht mehr. /topics zeigt die Zuordnung.`,
  legacyDone: (topicId: string, agent: string) =>
    `Topic ${topicId} gehoert jetzt dem Agent "${agent}" (gespeichert in config/topics.json, gilt ab sofort).`,
  legacyFailed: "Speichern fehlgeschlagen, siehe Logs.",
  legacyMore: (page: number, pages: number) => `Weitere Agenten zur Frage oben (${page} von ${pages})`,
} as const;

/** Knöpfe je Zeile bei der Frage ohne Register (wie früher) */
const LEGACY_PER_ROW = 4;
/** Grenze von Telegram: Knöpfe an einer Nachricht */
const LEGACY_PER_MESSAGE = 100;
const TELEGRAM_CHAT = /^-?\d{1,20}$/;

type Log = (line: string) => void;
const defaultLog: Log = line => console.log(line);

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "Fehler";
}

export interface AgentOption {
  name: string;
  displayName: string;
}

/** Eine Option je Agent: Schlüssel = ID, Beschriftung = Anzeigename (sonst die ID) */
export function topicMapOptions(agents: AgentOption[]): ChoiceOption[] {
  return agents.map(a => ({ key: a.name, label: a.displayName.trim() || a.name }));
}

/** Knöpfe der alten Frage: topicmap:<topicId>:<agent>, vier je Zeile */
export function legacyButtons(topicId: number, agents: string[]): InlineButton[][] {
  const rows: InlineButton[][] = [];
  agents.forEach((agent, i) => {
    if (i % LEGACY_PER_ROW === 0) rows.push([]);
    rows[rows.length - 1].push({ text: agent, callback_data: `topicmap:${topicId}:${agent}` });
  });
  return rows;
}

/** Wie legacyButtons, aufgeteilt auf Nachrichten mit höchstens 100 Knöpfen */
export function legacyButtonPages(topicId: number, agents: string[]): InlineButton[][][] {
  const pages: InlineButton[][][] = [];
  for (let i = 0; i < agents.length; i += LEGACY_PER_MESSAGE) {
    pages.push(legacyButtons(topicId, agents.slice(i, i + LEGACY_PER_MESSAGE)));
  }
  return pages;
}

export interface TopicChoicesDeps {
  /** Frage in Telegram zeigen und festhalten (createTelegramChoices().sendChoice) */
  sendChoice(choice: Choice): Promise<{ sent: boolean }>;
  /** Meldung im Topic mit Festhalten (Telegram und Browser), sendAndRecord aus outbox.ts */
  notify(input: SendAndRecordInput): Promise<SendAndRecordResult>;
  /** Topic hat einen neuen Agenten: an die WebUI (topicChanges.emit) */
  topicChanged(change: { chatId: string; topicId: number }): void;
  /** Standard: aktive Agenten aus dem Katalog */
  agents?(): AgentOption[];
  isActiveAgent?(name: string): boolean;
  /** Standard config/topics.json; Tests reichen eine Kopie herein */
  topicsFile?: string;
  createChoice?(input: CreateChoiceInput): Promise<Choice>;
  listChoices?(): Promise<Choice[]>;
  expireChoice?(id: string): Promise<ExpireOutcome>;
  log?: Log;
}

export interface TopicChoices {
  /**
   * Frage anlegen und zeigen. true: gefragt (oder inzwischen zugeordnet,
   * dann nicht mehr nötig); false: nicht im Register, bot.ts fragt mit legacyButtons.
   */
  ask(chatId: string, topicId: number): Promise<boolean>;
  /** Handler der Art "topicmap" (onChoiceDecided) */
  handler: ChoiceHandler;
  /** Zuhörer für onTopicMappingSet */
  listener(change: TopicMappingChange): void;
  /** Alter Knopf topicmap:<topicId>:<agent>; gibt den Text für die Nachricht zurück */
  legacy(chatId: string, topicIdRaw: string, agent: string): Promise<string>;
  /** Für Tests: bis alle angestoßenen Abläufe fertig sind */
  settled(): Promise<void>;
}

export function createTopicChoices(deps: TopicChoicesDeps): TopicChoices {
  const log = deps.log ?? defaultLog;
  const agents = deps.agents ?? (() => listAgents().map(a => ({ name: a.name, displayName: a.displayName })));
  const active = deps.isActiveAgent ?? isActiveAgent;
  const file = deps.topicsFile ?? TOPICS_CONFIG_PATH;
  const create = deps.createChoice ?? createChoice;
  const list = deps.listChoices ?? listChoices;
  const expire = deps.expireChoice ?? expireChoice;

  function isTopicOf(c: Choice, chatId: string, topicId: number): boolean {
    return c.kind === "topicmap" && c.conversation.type === "telegram" &&
      c.conversation.chatId === chatId && c.conversation.topicId === topicId;
  }

  async function expireOpen(chatId: string, topicId: number): Promise<void> {
    let open: Choice[];
    try {
      open = (await list()).filter(c => c.state === "open" && isTopicOf(c, chatId, topicId));
    } catch (e) {
      log(`[Topic] Register nicht lesbar, Zuordnungsfragen von Topic ${topicId} nicht geprüft (${errorName(e)})`);
      return;
    }
    for (const c of open) {
      await expire(c.id).catch(e => log(`[Topic] Zuordnungsfrage ${c.id} nicht abgelaufen (${errorName(e)})`));
    }
  }

  // Abläufe je Topic nacheinander
  const tails = new Map<string, Promise<void>>();
  function queue(key: string, work: () => Promise<void>): Promise<void> {
    const next = (tails.get(key) ?? Promise.resolve()).then(work, work);
    const tail = next.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  }

  async function ask(chatId: string, topicId: number): Promise<boolean> {
    if (!TELEGRAM_CHAT.test(chatId) || !Number.isSafeInteger(topicId) || topicId <= 0) return false;
    const options = topicMapOptions(agents());
    if (options.length === 0) {
      log(`[Topic] keine aktiven Agenten, Topic ${topicId} ohne Register`);
      return false;
    }
    let choice: Choice;
    try {
      choice = await create({
        kind: "topicmap",
        conversation: { type: "telegram", chatId, topicId },
        text: TOPIC_MAP_TEXT.question(topicId),
        options,
        ref: String(topicId),
      });
    } catch (e) {
      log(`[Topic] Zuordnungsfrage für Topic ${topicId} nicht angelegt (${errorName(e)})`);
      return false;
    }
    // Während des Anlegens anderweitig zugeordnet: der Zuhörer fand die Frage
    // vielleicht noch nicht, also hier nachsehen
    try {
      if (await getMappedAgent(chatId, topicId, file)) {
        await expire(choice.id).catch(() => {});
        return true;
      }
    } catch (e) {
      log(`[Topic] Zuordnung von Topic ${topicId} nicht lesbar (${errorName(e)})`);
    }
    try {
      if ((await deps.sendChoice(choice)).sent) return true;
    } catch (e) {
      log(`[Topic] Zuordnungsfrage ${choice.id} nicht gesendet (${errorName(e)})`);
    }
    // Nirgends gezeigt: Frage zurückziehen, bot.ts fragt mit den alten Knöpfen
    await expire(choice.id).catch(() => {});
    return false;
  }

  async function report(chatId: string, topicId: number, text: string, choiceId: string): Promise<void> {
    try {
      const result = await deps.notify({ chatId, topicId, text, format: "plain", source: TOPIC_MAP_SOURCE });
      if (!result.sent) log(`[Topic] Meldung zu Frage ${choiceId} nicht gesendet`);
    } catch (e) {
      log(`[Topic] Meldung zu Frage ${choiceId} nicht gesendet (${errorName(e)})`);
    }
  }

  const handler: ChoiceHandler = async choice => {
    const conv = choice.conversation;
    const agent = choice.result?.key;
    const label = choice.result?.label ?? agent ?? "";
    if (conv.type !== "telegram" || conv.topicId === undefined || !agent) {
      throw new Error("Zuordnungsfrage ohne Topic oder Ergebnis");
    }
    const { chatId, topicId } = conv;
    let result: SetIfUnmappedResult;
    try {
      result = await setTopicMappingIfUnmapped(chatId, topicId, agent, file, active);
    } catch (e) {
      if (e instanceof TopicAgentInactive) {
        await report(chatId, topicId, TOPIC_MAP_TEXT.gone(label), choice.id);
        throw new Error("Agent inzwischen gelöscht, nicht zugeordnet");
      }
      log(`[Topic] Zuordnung aus Frage ${choice.id} nicht gespeichert (${errorName(e)})`);
      await report(chatId, topicId, TOPIC_MAP_TEXT.failed, choice.id);
      throw e;
    }
    if (result.status === "mapped") {
      await report(chatId, topicId, TOPIC_MAP_TEXT.mapped(result.agent), choice.id);
      throw new Error("Topic inzwischen anders zugeordnet, nichts geändert");
    }
    log(`[Topic] Topic ${topicId}: Agent ${agent} (Frage ${choice.id}, ${choice.result?.via})`);
  };

  const listener = (change: TopicMappingChange): void => {
    try {
      deps.topicChanged({ chatId: change.chatId, topicId: change.topicId });
    } catch (e) {
      log(`[Topic] Änderung von Topic ${change.topicId} nicht gemeldet (${errorName(e)})`);
    }
    void queue(`${change.chatId}:${change.topicId}`, () => expireOpen(change.chatId, change.topicId));
  };

  async function legacy(chatId: string, topicIdRaw: string, agent: string): Promise<string> {
    // Knopf aus einer alten Rückfrage für einen inzwischen gelöschten Agenten
    if (!active(agent)) return TOPIC_MAP_TEXT.legacyGone(agent);
    const topicId = Number(topicIdRaw);
    if (!/^\d{1,10}$/.test(topicIdRaw) || !Number.isSafeInteger(topicId) || topicId <= 0) return TOPIC_MAP_TEXT.legacyFailed;
    try {
      await setTopicMapping(chatId, topicId, agent, file, active);
      return TOPIC_MAP_TEXT.legacyDone(topicIdRaw, agent);
    } catch (e) {
      if (e instanceof TopicAgentInactive) return TOPIC_MAP_TEXT.legacyGone(agent);
      console.error("topicmap callback failed:", e);
      return TOPIC_MAP_TEXT.legacyFailed;
    }
  }

  async function settled(): Promise<void> {
    while (tails.size > 0) await Promise.all([...tails.values()]);
  }

  return { ask, handler, listener, legacy, settled };
}
