/**
 * HTTP-Client von tybo für die API der WebUI (Issue #60, Entscheidung 0010).
 *
 * Anmeldung mit dem lokalen Schlüssel als Authorization: Bearer. Die Quelle
 * "terminal" setzt der Server anhand dieser Anmeldung, nicht der Client. Der
 * Schlüssel wird bei jeder Anfrage über getToken geholt; nach einem 401 liest
 * der Client ihn einmal neu (der Bot legt bei jedem Start einen neuen an) und
 * wiederholt die Anfrage. Importiert nichts aus src/lib oder src/bot.ts.
 */

import type { ApiMessage } from "../web/chat";
import type { ApiChoice, ChoiceState, ChoiceVia } from "../web/choices";
import { readCliToken } from "../web/cli-token";

export type { ApiChoice };

export type ConversationKind = "dm" | "topic" | "web";

export interface ConversationSummary {
  id: string;
  title: string;
  agent: string;
  kind: ConversationKind;
  closed?: boolean;
  /** Letzte Aktivität (Telegram lastActivity, Web updatedAt); null ohne Aktivität (Issue #61) */
  lastActivity?: string | null;
}

export interface AgentSummary {
  name: string;
  label: string;
}

/** Befehl des Bots aus GET /api/commands (Issue #74) */
export interface CommandEntry {
  name: string;
  aliases: string[];
  description: string;
  argsHint?: string;
}

export interface AgentList {
  agents: AgentSummary[];
  defaultAgent: string | null;
}

/** Ergebnis einer Änderung: warning, wenn nur ein Teil geklappt hat */
export interface CreateResult {
  conversation: ConversationSummary;
  /** Topic angelegt, aber etwas danach nicht gespeichert */
  warning?: string;
}

export interface InstructionsResult {
  agent: string;
  instructions: string[];
  note?: string;
}

export interface ResetResult {
  reset: number;
  sessionMode: boolean;
  note: string;
}

export type Message = ApiMessage & { agent?: string };

export interface TurnState {
  running: boolean;
  awaiting?: boolean;
  approvalId?: string;
}

export interface MessagesPage extends TurnState {
  messages: Message[];
  /** Telegram: es gibt ältere Nachrichten vor dieser Seite (Seitengröße 50) */
  hasMore: boolean;
}

export type SendResult =
  /** running: false, wenn nach einem Befehl (z.B. /stop) nichts mehr läuft */
  | { status: "accepted"; message: Message; running?: boolean }
  | { status: "busy"; error: string }
  | { status: "stale"; error: string }
  | { status: "closed"; error: string };

export class ApiError extends Error {
  /** HTTP-Status; 0, wenn der Server nicht erreichbar war */
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  /** z. B. http://127.0.0.1:3100 */
  base: string;
  /** Liefert den Schlüssel; fresh: nach einem 401 neu von der Platte lesen */
  getToken(fresh: boolean): Promise<string | null>;
  fetch?: typeof fetch;
  /** Zeitlimit für normale Anfragen, Standard 15 Sekunden */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function summary(value: unknown, kind: ConversationKind): ConversationSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  return {
    id: value.id,
    title: typeof value.title === "string" ? value.title : value.id,
    agent: typeof value.agent === "string" ? value.agent : "",
    kind,
    ...(value.closed === true ? { closed: true } : {}),
    lastActivity: activityOf(value),
  };
}

/** lastActivity (Telegram) oder updatedAt (Web-Gespräch) */
function activityOf(value: Record<string, unknown>): string | null {
  const raw = typeof value.lastActivity === "string" ? value.lastActivity : typeof value.updatedAt === "string" ? value.updatedAt : null;
  return raw && !Number.isNaN(new Date(raw).getTime()) ? raw : null;
}

function turnState(value: Record<string, unknown>): TurnState {
  const state: TurnState = { running: value.running === true };
  if (value.awaiting === true && typeof value.approvalId === "string") {
    state.awaiting = true;
    state.approvalId = value.approvalId;
  }
  return state;
}

/** Schlüssel aus der Datei, zwischengespeichert; fresh liest neu (Bot neu gestartet) */
export function tokenFromFile(file: string): ApiClientOptions["getToken"] {
  let cached: string | null | undefined;
  return async fresh => {
    if (fresh || cached === undefined) cached = await readCliToken(file);
    return cached;
  };
}

export function isMessage(value: unknown): value is Message {
  return isRecord(value) && typeof value.id === "string" && typeof value.text === "string" && typeof value.role === "string";
}

const CHOICE_STATES: readonly ChoiceState[] = ["open", "done", "expired"];
const CHOICE_CHANNELS: readonly ChoiceVia[] = ["telegram", "web", "terminal"];

/**
 * Rückfrage vom Server (Issue #120) geprüft wie choiceOrNull im Browser;
 * null, wenn etwas fehlt. Knöpfe nur bei offenen Fragen, Ergebnis nur bei
 * erledigten mit bekanntem Kanal. Texte bleiben ungefiltert, die Anzeige
 * schickt sie durch sanitizeLine.
 */
export function toChoice(value: unknown): ApiChoice | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  const state = CHOICE_STATES.find(s => s === value.state);
  if (!state) return null;
  const options =
    state === "open" && Array.isArray(value.options)
      ? value.options
          .filter((o): o is { key: string; label: string } => isRecord(o) && typeof o.key === "string" && !!o.key && typeof o.label === "string" && !!o.label)
          .map(o => ({ key: o.key, label: o.label }))
      : [];
  const choice: ApiChoice = { id: value.id, options, state };
  const r = value.result;
  if (state === "done" && isRecord(r) && typeof r.label === "string" && CHOICE_CHANNELS.includes(r.via as ChoiceVia)) {
    choice.result = { key: typeof r.key === "string" ? r.key : "", label: r.label, via: r.via as ChoiceVia, at: typeof r.at === "string" ? r.at : "" };
  }
  if (typeof value.elsewhere === "string" && value.elsewhere) choice.elsewhere = value.elsewhere;
  return choice;
}

/** Ergebnis einer Auswahl (POST …/choices/<choiceId>) */
export type DecideResult =
  | { status: "decided"; choice: ApiChoice }
  /** 409: schon entschieden bzw. abgelaufen, choice ist der Stand des Servers */
  | { status: "already" | "expired"; choice: ApiChoice; error: string }
  /** 404: hier nicht (mehr) entscheidbar */
  | { status: "not_found"; error: string }
  /** 400: Option unbekannt */
  | { status: "invalid"; error: string };

export class ApiClient {
  readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly getToken: ApiClientOptions["getToken"];

  constructor(options: ApiClientOptions) {
    this.base = options.base.replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.getToken = options.getToken;
  }

  /**
   * Anfrage mit Bearer-Schlüssel. Nach 401 einmal mit frisch gelesenem
   * Schlüssel wiederholen. signal: eigener Abbruch (Live-Ereignisse ohne Zeitlimit).
   */
  async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    let fresh = false;
    for (;;) {
      const token = await this.getToken(fresh);
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      let res: Response;
      try {
        res = await this.fetchFn(`${this.base}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal ?? AbortSignal.timeout(this.timeoutMs),
          redirect: "manual",
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new ApiError(0, `Keine Verbindung zu ${this.base}`);
      }
      if (res.status === 401 && !fresh) {
        await res.body?.cancel().catch(() => {});
        fresh = true;
        continue;
      }
      return res;
    }
  }

  private async json(method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await this.request(method, path, body);
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const record = isRecord(data) ? data : {};
    if (res.status === 401) throw new ApiError(401, "Der lokale Schlüssel gilt nicht (mehr).");
    return { status: res.status, data: record };
  }

  private fail(status: number, data: Record<string, unknown>): never {
    const text = typeof data.error === "string" && data.error ? data.error : `Status ${status}`;
    throw new ApiError(status, text);
  }

  /** true, wenn die Anmeldung mit dem Schlüssel klappt */
  async me(): Promise<boolean> {
    const res = await this.request("GET", "/api/me");
    await res.body?.cancel().catch(() => {});
    return res.status === 200;
  }

  /** Direktchat, Topics (Telegram) und ältere Web-Gespräche */
  async listConversations(): Promise<ConversationSummary[]> {
    const { status, data } = await this.json("GET", "/api/conversations");
    if (status !== 200) this.fail(status, data);
    const list: ConversationSummary[] = [];
    const telegram = isRecord(data.telegram) ? data.telegram : {};
    const dm = summary(telegram.dm, "dm");
    if (dm) list.push(dm);
    for (const t of Array.isArray(telegram.topics) ? telegram.topics : []) {
      const topic = summary(t, "topic");
      if (topic) list.push(topic);
    }
    for (const c of Array.isArray(data.conversations) ? data.conversations : []) {
      const web = summary(c, "web");
      if (web) list.push(web);
    }
    return list;
  }

  /**
   * Verlauf, chronologisch, samt Zustand eines laufenden Turns. before:
   * createdAt der ältesten bekannten Nachricht, unverändert (samt
   * Mikrosekunden), liefert die Seite davor.
   */
  async messages(id: string, before?: string): Promise<MessagesPage> {
    const query = before === undefined ? "" : `?before=${encodeURIComponent(before)}`;
    const { status, data } = await this.json("GET", `/api/conversations/${encodeURIComponent(id)}/messages${query}`);
    if (status !== 200) this.fail(status, data);
    const messages = (Array.isArray(data.messages) ? data.messages : []).filter(isMessage);
    return { messages, hasMore: data.hasMore === true, ...turnState(data) };
  }

  /** Neue Nachricht; approvalId nur als Antwort auf eine offene Rückfrage */
  async send(id: string, text: string, approvalId?: string): Promise<SendResult> {
    const body = approvalId ? { text, approvalId } : { text };
    const { status, data } = await this.json("POST", `/api/conversations/${encodeURIComponent(id)}/messages`, body);
    const error = typeof data.error === "string" ? data.error : "";
    if (status === 202 && isMessage(data.message)) {
      return { status: "accepted", message: data.message, ...(data.running === false ? { running: false } : {}) };
    }
    if (status === 409 && data.closed === true) return { status: "closed", error };
    if (status === 409 && data.stale === true) return { status: "stale", error };
    if (status === 409) return { status: "busy", error };
    this.fail(status, data);
  }

  /**
   * Rückfrage entscheiden wie ein Knopf (Issue #120): POST
   * /api/conversations/<id>/choices/<choiceId> mit { option }. Den Kanal
   * „terminal" setzt der Server aus der Anmeldung. Andere Fehler (503, 500,
   * keine Verbindung) werfen ApiError.
   */
  async decideChoice(id: string, choiceId: string, option: string): Promise<DecideResult> {
    const { status, data } = await this.json("POST", `/api/conversations/${encodeURIComponent(id)}/choices/${encodeURIComponent(choiceId)}`, { option });
    const error = typeof data.error === "string" ? data.error : "";
    const choice = toChoice(data.choice);
    if (status === 200 && choice) return { status: "decided", choice };
    if (status === 409 && choice) return { status: data.expired === true ? "expired" : "already", choice, error };
    if (status === 404) return { status: "not_found", error };
    if (status === 400) return { status: "invalid", error };
    this.fail(status, data);
  }

  /**
   * Stand dieser Rückfragen aus Sicht des Gesprächs (GET
   * /api/conversations/<id>/choices?ids=a,b), für den Abgleich nach einer
   * Wiederverbindung. Wirft bei jedem Fehler, dann bleibt der bisherige Stand.
   */
  async choices(id: string, ids: readonly string[]): Promise<ApiChoice[]> {
    const { status, data } = await this.json("GET", `/api/conversations/${encodeURIComponent(id)}/choices?ids=${ids.map(encodeURIComponent).join(",")}`);
    if (status !== 200) this.fail(status, data);
    return (Array.isArray(data.choices) ? data.choices : []).map(toChoice).filter((c): c is ApiChoice => !!c);
  }

  /** Stopp wie der Knopf in der WebUI; false, wenn nichts mehr abzubrechen ist */
  async stop(id: string): Promise<boolean> {
    const { status, data } = await this.json("POST", `/api/conversations/${encodeURIComponent(id)}/stop`);
    if (status !== 200) this.fail(status, data);
    return data.stopping === true;
  }

  /** Befehle des Bots für Tab und /tasten (GET /api/commands); ohne Befehls-Schicht eine leere Liste */
  async listCommands(): Promise<CommandEntry[]> {
    const { status, data } = await this.json("GET", "/api/commands");
    if (status === 503 || status === 404) return [];
    if (status !== 200) this.fail(status, data);
    const out: CommandEntry[] = [];
    for (const c of Array.isArray(data.commands) ? data.commands : []) {
      if (!isRecord(c) || typeof c.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(c.name)) continue;
      const aliases = Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(a)) : [];
      out.push({
        name: c.name,
        aliases,
        description: typeof c.description === "string" ? c.description : "",
        ...(typeof c.argsHint === "string" && c.argsHint ? { argsHint: c.argsHint } : {}),
      });
    }
    return out;
  }

  /** Agenten für /neu und /zuordnen (GET /api/agents) */
  async listAgents(): Promise<AgentList> {
    const { status, data } = await this.json("GET", "/api/agents");
    if (status !== 200) this.fail(status, data);
    const agents: AgentSummary[] = [];
    for (const a of Array.isArray(data.agents) ? data.agents : []) {
      if (!isRecord(a) || typeof a.name !== "string" || !a.name) continue;
      agents.push({ name: a.name, label: typeof a.label === "string" && a.label ? a.label : a.name });
    }
    return { agents, defaultAgent: typeof data.defaultAgent === "string" ? data.defaultAgent : null };
  }

  /**
   * Neues Gespräch als Telegram-Topic wie „Neues Gespräch" im Browser
   * (POST /api/conversations). Ist das Topic angelegt, aber die Zuordnung
   * nicht gespeichert, kommt es mit warning zurück statt als Fehler; so legt
   * niemand es ein zweites Mal an.
   */
  async createConversation(agent: string): Promise<CreateResult> {
    const { status, data } = await this.json("POST", "/api/conversations", { agent });
    const conversation = summary(data.conversation, "topic");
    if (status === 201 && conversation) return { conversation };
    if (conversation) return { conversation, warning: typeof data.error === "string" ? data.error : `Status ${status}` };
    this.fail(status, data);
  }

  /**
   * Topic umbenennen und/oder Agent ändern (PATCH). Bei Teilerfolg (etwa
   * umbenannt, Agent nicht gespeichert) kommt das Gespräch mit warning zurück.
   */
  async updateTopic(id: string, change: { title?: string; agent?: string }): Promise<CreateResult & { note?: string }> {
    const { status, data } = await this.json("PATCH", `/api/conversations/${encodeURIComponent(id)}`, change);
    const conversation = summary(data.conversation, "topic");
    const note = typeof data.note === "string" ? data.note : undefined;
    if (status === 200 && conversation) return { conversation, ...(note ? { note } : {}) };
    if (conversation) return { conversation, warning: typeof data.error === "string" ? data.error : `Status ${status}` };
    this.fail(status, data);
  }

  /** Anweisungen eines Agenten (wie /agent in Telegram) */
  async instructions(agent: string): Promise<InstructionsResult> {
    const { status, data } = await this.json("GET", `/api/agents/${encodeURIComponent(agent)}/instructions`);
    if (status !== 200) this.fail(status, data);
    return instructionsOf(agent, data);
  }

  /** Eine Anweisung hinzufügen (wie /agent <name>: <text> in Telegram) */
  async addInstruction(agent: string, text: string): Promise<InstructionsResult> {
    const { status, data } = await this.json("POST", `/api/agents/${encodeURIComponent(agent)}/instructions`, { text });
    if (status !== 201) this.fail(status, data);
    return instructionsOf(agent, data);
  }

  /** Session frisch starten wie /new in Telegram; der Verlauf bleibt */
  async resetSession(id: string): Promise<ResetResult> {
    const { status, data } = await this.json("POST", `/api/conversations/${encodeURIComponent(id)}/reset`);
    if (status !== 200) this.fail(status, data);
    return {
      reset: typeof data.reset === "number" ? data.reset : 0,
      sessionMode: data.sessionMode === true,
      note: typeof data.note === "string" ? data.note : "",
    };
  }

  /** Öffnet den Ereignisstrom; der Aufrufer liest den Body und bricht über signal ab */
  async events(id: string, signal: AbortSignal): Promise<Response> {
    const res = await this.request("GET", `/api/conversations/${encodeURIComponent(id)}/events`, undefined, signal);
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new ApiError(res.status, res.status === 401 ? "Der lokale Schlüssel gilt nicht (mehr)." : `Status ${res.status}`);
    }
    return res;
  }
}

function instructionsOf(agent: string, data: Record<string, unknown>): InstructionsResult {
  const list = Array.isArray(data.instructions) ? data.instructions.filter((x): x is string => typeof x === "string") : [];
  return { agent, instructions: list, ...(typeof data.note === "string" ? { note: data.note } : {}) };
}
