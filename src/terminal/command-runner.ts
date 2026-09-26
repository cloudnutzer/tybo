/**
 * Führt die lokalen Slash-Befehle von tybo aus (Issue #61), ausschließlich
 * über die API der WebUI. Kein Terminal: die Anzeige hängt über
 * CommandContext daran (app.ts), Tests zeichnen auf. Befehle des Bots (/new,
 * /stop, /agent, /topics …) führt seit Issue #74 der Server aus.
 *
 * Regeln wie im Browser: Direktchat und General behalten General, ältere
 * Web-Gespräche ihren festen Agenten.
 */

import { agentLabel } from "../web/agents";
import { normalizeTopicTitle, TOPIC_TITLE_MAX_CHARS } from "../web/topics";
import { ApiError, type AgentList, type ApiClient, type CommandEntry, type ConversationSummary } from "./api";
import { resolveSwitchTarget, splitAgentAndTitle, type Command } from "./commands";
import type { Style } from "./render";
import { sanitizeLine } from "./sanitize";
import { conversationName, formatConversationList, HELP_TEXT } from "./view";

export interface CommandContext {
  client: ApiClient;
  style: Style;
  /** Das offene Gespräch */
  current(): ConversationSummary;
  /** In ein anderes Gespräch wechseln (alte Live-Verbindung zu, Auswahl merken) */
  switchTo(conversation: ConversationSummary, note?: string): Promise<void>;
  /** Das offene Gespräch hat sich geändert (Agent) */
  updateCurrent(conversation: ConversationSummary): void;
  info(text: string): void;
  error(text: string): void;
  quit(): void;
  now?(): number;
}

export const GENERAL_AGENT = "general";

/** true: Direktchat oder General, dort antwortet immer General */
function isGeneralOnly(c: ConversationSummary): boolean {
  return c.kind === "dm" || c.id === "topic-1";
}

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 0) return "Keine Verbindung zum Bot.";
  return sanitizeLine(e instanceof Error ? e.message : String(e)) || "Unbekannter Fehler";
}

export class CommandRunner {
  /** IDs der zuletzt gezeigten /gespraeche-Liste, in Anzeigereihenfolge */
  private shown: string[] | null = null;
  /** Zuletzt geladene Listen, für die Tab-Ergänzung */
  private conversations: ConversationSummary[] = [];
  private agents: AgentList | null = null;
  /** Befehle des Bots (GET /api/commands), für Tab und /tasten */
  private botCommands: CommandEntry[] = [];

  constructor(private readonly ctx: CommandContext) {}

  /** Namen für die Tab-Ergänzung */
  get conversationNames(): string[] {
    return this.conversations.map(c => conversationName(c));
  }

  get agentNames(): string[] {
    return this.agents?.agents.map(a => a.name) ?? [];
  }

  /** Namen der Befehle des Bots samt Aliassen, für die Tab-Ergänzung */
  get commandNames(): string[] {
    return this.botCommands.flatMap(c => [c.name, ...c.aliases]);
  }

  /** Listen für die Tab-Ergänzung vorab laden; Fehler bleiben still */
  async preload(): Promise<void> {
    await Promise.allSettled([this.loadConversations(), this.loadAgents(), this.loadCommands()]);
  }

  private async loadCommands(): Promise<CommandEntry[]> {
    this.botCommands = await this.ctx.client.listCommands();
    return this.botCommands;
  }

  private async loadConversations(): Promise<ConversationSummary[]> {
    this.conversations = await this.ctx.client.listConversations();
    return this.conversations;
  }

  private async loadAgents(): Promise<AgentList> {
    this.agents = await this.ctx.client.listAgents();
    return this.agents;
  }

  private unknownAgent(name: string, list: AgentList): string {
    const names = list.agents.map(a => a.name).join(", ") || "keine";
    return `Unbekannter Agent „${sanitizeLine(name)}". Verfügbar: ${names}.`;
  }

  /** Führt einen Befehl aus; false, wenn er nicht geklappt hat */
  async run(command: Command): Promise<boolean> {
    try {
      return await this.dispatch(command);
    } catch (e) {
      this.ctx.error(errorText(e));
      return false;
    }
  }

  private async dispatch(command: Command): Promise<boolean> {
    const { ctx } = this;
    switch (command.type) {
      case "keys":
        ctx.info(this.helpText());
        return true;
      case "quit":
        ctx.quit();
        return true;
      case "list": {
        const list = await this.loadConversations();
        this.shown = list.map(c => c.id);
        ctx.info(formatConversationList(list, ctx.current().id, ctx.style, ctx.now?.()));
        return true;
      }
      case "switch":
        return this.switchTo(command.target);
      case "create":
        return this.create(command.args);
      case "assign":
        return this.setAgent(command.agent);
    }
  }

  /** Tasten und lokale Befehle, dazu die Befehle des Bots, sofern schon geladen */
  private helpText(): string {
    if (this.botCommands.length === 0) return HELP_TEXT;
    const lines = this.botCommands.map(c => {
      const call = sanitizeLine(`/${c.name}${c.argsHint ? ` ${c.argsHint}` : ""}`);
      return `  ${call.padEnd(24)} ${sanitizeLine(c.description)}`;
    });
    return `${HELP_TEXT}\n\nBefehle des Bots (wie in Telegram):\n${lines.join("\n")}`;
  }

  private async switchTo(target: string): Promise<boolean> {
    const list = await this.loadConversations();
    const found = resolveSwitchTarget(list, this.shown, target);
    if (!found.ok) {
      this.ctx.error(found.error);
      return false;
    }
    if (found.conversation.id === this.ctx.current().id) {
      this.ctx.info(`Du bist schon in ${conversationName(found.conversation)}.`);
      return true;
    }
    await this.ctx.switchTo(found.conversation);
    return true;
  }

  /**
   * /neu [agent] [titel]: erst alles prüfen, dann genau einmal anlegen. Klappt
   * danach etwas nicht (Zuordnung, Titel), meldet tybo das angelegte Topic
   * und wechselt trotzdem hinein, statt ein zweites anzulegen.
   */
  private async create(args: string): Promise<boolean> {
    const { ctx } = this;
    const agents = await this.loadAgents();
    const names = agents.agents.map(a => a.name);
    const split = splitAgentAndTitle(args, names, agents.defaultAgent ?? GENERAL_AGENT);
    if (!names.includes(split.agent)) {
      ctx.error(this.unknownAgent(split.agent, agents));
      return false;
    }
    let title: string | undefined;
    if (split.title !== undefined) {
      title = normalizeTopicTitle(split.title) ?? undefined;
      if (title === undefined) {
        ctx.error(`Der Titel muss 1 bis ${TOPIC_TITLE_MAX_CHARS} Zeichen lang sein, ohne Steuerzeichen. Nichts angelegt.`);
        return false;
      }
    }
    const created = await ctx.client.createConversation(split.agent);
    let conversation = created.conversation;
    const problems: string[] = [];
    if (created.warning) problems.push(sanitizeLine(created.warning));
    if (title !== undefined) {
      try {
        const renamed = await ctx.client.updateTopic(conversation.id, { title });
        conversation = { ...renamed.conversation, agent: conversation.agent };
        if (renamed.warning) problems.push(sanitizeLine(renamed.warning));
      } catch (e) {
        problems.push(`Titel nicht gesetzt: ${errorText(e)}`);
      }
    }
    const label = agentLabel(split.agent);
    if (problems.length) {
      ctx.error(`Topic ${conversationName(conversation)} (${conversation.id}) ist angelegt, aber: ${problems.join("; ")}. Nicht noch einmal anlegen, im Browser nachbessern.`);
    }
    // Das neue Topic auch für die Tab-Ergänzung
    void this.loadConversations().catch(() => {});
    await ctx.switchTo(conversation, `Neues Gespräch mit ${label}, auch als Topic in Telegram.`);
    return problems.length === 0;
  }

  private async setAgent(agent: string): Promise<boolean> {
    const { ctx } = this;
    const current = ctx.current();
    if (isGeneralOnly(current)) {
      ctx.error(`In ${conversationName(current)} antwortet immer General, der Agent lässt sich hier nicht ändern (wie im Browser).`);
      return false;
    }
    if (current.kind === "web") {
      ctx.error("Ältere Web-Gespräche haben einen festen Agenten. /neu <Agent> legt ein neues Gespräch an.");
      return false;
    }
    const agents = await this.loadAgents();
    if (!agents.agents.some(a => a.name === agent)) {
      ctx.error(this.unknownAgent(agent, agents));
      return false;
    }
    if (agent === current.agent) {
      ctx.info(`${agentLabel(agent)} ist hier schon der Agent.`);
      return true;
    }
    const result = await ctx.client.updateTopic(current.id, { agent });
    if (result.warning) {
      ctx.error(sanitizeLine(result.warning));
      return false;
    }
    ctx.updateCurrent({ ...current, agent: result.conversation.agent || agent });
    ctx.info(`Agent in ${conversationName(current)} ist jetzt ${agentLabel(agent)}.${result.note ? ` ${sanitizeLine(result.note)}` : ""}`);
    return true;
  }
}
