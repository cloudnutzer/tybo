/**
 * Rückfrage-Knöpfe im Browser (Issue #115, Entscheidung 0017).
 *
 * Der Web-Server kennt nur den ChoicePort: Zustand einer Frage für eine
 * Nachricht lesen, eine Frage aus ihrem Gespräch entscheiden, Änderungen
 * abonnieren. createChoicePort baut ihn aus einem ChoiceRegister; in
 * src/bot.ts ist das das echte Rückfragen-Register (src/lib/choices.ts über
 * ./bot-choices), in Demo und Tests ein Register im Speicher bzw. das
 * echte mit eigener Datei.
 *
 * Zuordnung zum Gespräch der WebUI: Telegram-Chat des Nutzers ohne Topic ist
 * der Direktchat (dm), die Forum-Gruppe ohne Topic oder mit Topic 1 ist
 * General (topic-1), sonst topic-<n>; Fragen aus reinen Web-Gesprächen
 * gehören zu deren UUID. Fragen fremder Chats gehören zu keinem Gespräch.
 *
 * Eine Frage ist nur aus ihrem eigenen Gespräch entscheidbar. Steht sie
 * woanders im Verlauf (die Kopie einer Web-Frage im Direktchat, #114), zeigt
 * der Browser dort keine Knöpfe, sondern einen Verweis auf ihr Gespräch
 * (elsewhere).
 *
 * Änderungen kommen auf zwei Wegen: sofort über onChange, wenn dieser Prozess
 * sie macht, und über einen Abgleich alle 15 Sekunden, wenn ein anderer
 * Prozess (Sprach-Brücke) entschieden hat oder eine Frist abgelaufen ist.
 *
 * Nur Typen und reine Funktionen, nichts aus src/lib.
 */

import { CHOICE_ID_PATTERN, isChoiceId, isConversationId } from "./store";
import { parseTelegramConversationId, telegramTopicConversationId } from "./telegram";

export type ChoiceState = "open" | "done" | "expired";
export type ChoiceVia = "telegram" | "web" | "terminal";

/** Wie Choice in src/lib/choices.ts, nur die Felder, die die WebUI braucht */
export interface RegisterChoice {
  id: string;
  conversation: { type: "telegram"; chatId: string; topicId?: number } | { type: "web"; conversationId: string };
  options: { key: string; label: string }[];
  state: ChoiceState;
  result?: { key: string; label: string; via: ChoiceVia; at: number };
}

/** Wie DecideOutcome in src/lib/choices.ts */
export type RegisterDecideOutcome =
  | { status: "decided"; choice: RegisterChoice }
  | { status: "already"; choice: RegisterChoice }
  | { status: "expired" }
  | { status: "unknown" }
  | { status: "invalid_key"; choice: RegisterChoice };

/** Der Teil des Registers, den die WebUI braucht (src/lib/choices.ts passt) */
export interface ChoiceRegister {
  /** abgelaufene erscheinen als expired, undefined: unbekannt; wirft, wenn nicht lesbar */
  get(id: string): Promise<RegisterChoice | undefined>;
  /** alle Fragen, abgelaufene als expired; wirft, wenn nicht lesbar (nie leer statt Fehler) */
  list(): Promise<RegisterChoice[]>;
  decide(id: string, key: string, via: ChoiceVia): Promise<RegisterDecideOutcome>;
  /** Änderungen dieses Prozesses; gibt die Abmeldung zurück */
  onChange(listener: (change: { type: string; choice: RegisterChoice }) => void | Promise<void>): () => void;
}

/** Rückfrage im API-Format einer Nachricht (Feld choice) */
export interface ApiChoice {
  id: string;
  /** Knöpfe; leer, wenn die Frage in einem anderen Gespräch entschieden wird */
  options: { key: string; label: string }[];
  state: ChoiceState;
  /** nur bei done: gewählter Knopf, Kanal, Zeitpunkt (ISO) */
  result?: { key: string; label: string; via: ChoiceVia; at: string };
  /** Gespräch, in dem die Frage entschieden wird, wenn es nicht dieses ist */
  elsewhere?: string;
}

/** Änderung einer Frage: Gespräch, zu dem sie gehört (null: fremder Chat), und neuer Zustand dort */
export interface ChoiceChange {
  conversationId: string | null;
  choice: ApiChoice;
  /** Frage aus einem reinen Web-Gespräch: ihre Kopie steht im Direktchat (#114) */
  copyInDm: boolean;
}

export type ChoiceDecideResult =
  | { status: "decided"; choice: ApiChoice }
  | { status: "already"; choice: ApiChoice }
  | { status: "expired"; choice: ApiChoice }
  /** unbekannt oder aus einem anderen Gespräch */
  | { status: "not_found" }
  | { status: "invalid_option" };

export interface ChoicePort {
  /**
   * Zustand der Frage für eine Nachricht in diesem Gespräch; eine unbekannte
   * gilt als abgelaufen. Wirft, wenn das Register nicht lesbar ist.
   */
  view(choiceId: string, conversationId: string): Promise<ApiChoice>;
  /** Entscheidet die Frage, wenn sie zu diesem Gespräch gehört */
  decide(conversationId: string, choiceId: string, option: string, via: ChoiceVia): Promise<ChoiceDecideResult>;
  /** Jede Änderung (dieser Prozess sofort, andere Prozesse und Fristen per Abgleich); gibt die Abmeldung zurück */
  subscribe(listener: (change: ChoiceChange) => void): () => void;
}

export const CHOICE_TEXT = {
  notConfigured: "Rückfragen sind hier nicht eingerichtet.",
  notFound: "Diese Rückfrage gibt es in diesem Gespräch nicht.",
  invalid: "Ungültige Auswahl",
  already: "Diese Rückfrage ist schon entschieden.",
  expired: "Diese Rückfrage ist abgelaufen.",
  failed: "Die Auswahl ist fehlgeschlagen.",
} as const;

export { CHOICE_ID_PATTERN, isChoiceId };
/** Wie KEY_RE in src/lib/choices.ts */
export const CHOICE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const CHOICE_SYNC_MS = 15_000;
const CHANNELS: readonly ChoiceVia[] = ["telegram", "web", "terminal"];
const USER_ID_PATTERN = /^\d{1,20}$/;
const GROUP_ID_PATTERN = /^-\d{1,20}$/;

/** API-Format im eigenen Gespräch: Knöpfe, Zustand, Ergebnis */
export function toApiChoice(c: RegisterChoice): ApiChoice {
  const choice: ApiChoice = {
    id: c.id,
    options: c.state === "open" ? c.options.map(o => ({ key: o.key, label: o.label })) : [],
    state: c.state === "done" || c.state === "expired" ? c.state : "open",
  };
  if (c.state === "done" && c.result && CHANNELS.includes(c.result.via) && Number.isFinite(c.result.at)) {
    choice.result = { key: c.result.key, label: c.result.label, via: c.result.via, at: new Date(c.result.at).toISOString() };
  }
  return choice;
}

/** Frage ohne Register-Eintrag: gilt als abgelaufen */
export function expiredChoice(id: string): ApiChoice {
  return { id, options: [], state: "expired" };
}

/** Sicht aus einem anderen Gespräch: keine Knöpfe, Verweis auf das eigene (falls bekannt) */
export function choiceViewFor(choice: ApiChoice, owner: string | null, viewer: string): ApiChoice {
  if (owner === viewer) return choice;
  const { elsewhere: _old, ...rest } = choice;
  return { ...rest, options: [], ...(owner ? { elsewhere: owner } : {}) };
}

export interface ChoicePortDeps {
  register: ChoiceRegister;
  /** TELEGRAM_USER_ID */
  userId?: string;
  /** Chat-ID der Forum-Gruppe, bei jedem Aufruf neu; null ohne Gruppe */
  groupId(): string | null;
  /** Abstand des Abgleichs, Standard 15 Sekunden */
  intervalMs?: number;
  /** Zeitgeber wie in DisplayOnlyPollDeps: ruft fn alle ms, gibt das Anhalten zurück */
  every?(ms: number, fn: () => Promise<void>): () => void;
  /** Nie Fragetexte oder Beschriftungen übergeben */
  log?(message: string): void;
}

/** Fingerabdruck eines Zustands für den Abgleich */
function signature(c: RegisterChoice | undefined): string {
  if (!c) return "gone";
  return c.state === "done" ? `done:${c.result?.key}:${c.result?.via}:${c.result?.at}` : c.state;
}

export function createChoicePort(deps: ChoicePortDeps): ChoicePort {
  const log = deps.log ?? ((m: string) => console.log(`[web] ${m}`));
  const userId = deps.userId && USER_ID_PATTERN.test(deps.userId.trim()) ? deps.userId.trim() : null;

  function groupId(): string | null {
    try {
      const id = deps.groupId();
      return id && GROUP_ID_PATTERN.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  /** Gespräch der WebUI, zu dem die Frage gehört; null bei fremden Chats */
  function ownerOf(c: RegisterChoice): string | null {
    const conv = c.conversation;
    if (conv.type === "web") return isConversationId(conv.conversationId) ? conv.conversationId : null;
    const topicId = conv.topicId;
    if (userId && conv.chatId === userId) return topicId === undefined ? "dm" : null;
    const group = groupId();
    if (group && conv.chatId === group) {
      const id = telegramTopicConversationId(topicId ?? 1);
      return parseTelegramConversationId(id) ? id : null;
    }
    return null;
  }

  function change(c: RegisterChoice): ChoiceChange {
    return { conversationId: ownerOf(c), choice: toApiChoice(c), copyInDm: c.conversation.type === "web" };
  }

  async function view(choiceId: string, conversationId: string): Promise<ApiChoice> {
    if (!isChoiceId(choiceId)) return expiredChoice(String(choiceId).slice(0, 12));
    const c = await deps.register.get(choiceId);
    if (!c) return expiredChoice(choiceId);
    return choiceViewFor(toApiChoice(c), ownerOf(c), conversationId);
  }

  async function decide(conversationId: string, choiceId: string, option: string, via: ChoiceVia): Promise<ChoiceDecideResult> {
    if (!isChoiceId(choiceId)) return { status: "not_found" };
    const before = await deps.register.get(choiceId);
    // Unbekannt oder aus einem anderen Gespräch: nie entscheiden, auch nicht die Kopie im Direktchat
    if (!before || ownerOf(before) !== conversationId) return { status: "not_found" };
    if (!CHOICE_KEY_PATTERN.test(option)) return { status: "invalid_option" };
    const outcome = await deps.register.decide(choiceId, option, via);
    switch (outcome.status) {
      case "decided":
        log(`Rückfrage ${choiceId} in ${conversationId} entschieden (${via})`);
        return { status: "decided", choice: toApiChoice(outcome.choice) };
      case "already":
        return { status: "already", choice: toApiChoice(outcome.choice) };
      case "expired":
        return { status: "expired", choice: expiredChoice(choiceId) };
      case "invalid_key":
        return { status: "invalid_option" };
      default:
        // Zwischen Lesen und Entscheiden aufgeräumt
        return { status: "not_found" };
    }
  }

  const listeners = new Set<(change: ChoiceChange) => void>();
  /**
   * Letzter verlässlicher Zustand je Frage (für den Abgleich); undefined: noch
   * kein Stand. Scheitert das Lesen, bleibt er unverändert, der nächste
   * gelungene Durchlauf gleicht gegen ihn ab.
   */
  let known: Map<string, { sig: string; last: RegisterChoice }> | undefined;
  let stopHook: (() => void) | null = null;
  let stopTimer: (() => void) | null = null;
  let running: Promise<void> | null = null;
  let failing = false;

  function broadcast(c: ChoiceChange): void {
    for (const listener of [...listeners]) {
      try {
        listener(c);
      } catch (e) {
        log(`Rückfrage-Zuhörer fehlgeschlagen (${e instanceof Error ? e.name : typeof e})`);
      }
    }
  }

  /** Stand dieses Prozesses merken, damit der Abgleich ihn nicht noch einmal meldet */
  function remember(c: RegisterChoice): void {
    known?.set(c.id, { sig: signature(c), last: c });
  }

  async function pass(): Promise<void> {
    const list = await deps.register.list();
    const next = new Map<string, { sig: string; last: RegisterChoice }>();
    for (const c of list) if (isChoiceId(c.id)) next.set(c.id, { sig: signature(c), last: c });
    const before = known;
    known = next;
    // Erster Durchlauf: nur Startstand, was die Browser schon geladen haben, stimmt.
    // Scheiterte das Lesen bisher, gibt es keinen verlässlichen Startstand:
    // dann alle Endzustände melden, Browser übernehmen nur, was bei ihnen offen steht
    if (!before) {
      if (!failing) return;
      for (const entry of next.values()) if (entry.last.state !== "open") broadcast(change(entry.last));
      return;
    }
    for (const [id, entry] of next) {
      const old = before.get(id);
      if (old?.sig === entry.sig) continue;
      // Neu und offen: die Nachricht dazu bringt die Knöpfe selbst
      if (!old && entry.last.state === "open") continue;
      broadcast(change(entry.last));
    }
    // Aus dem Register verschwunden, vorher offen: gilt jetzt als abgelaufen
    for (const [id, old] of before) {
      if (next.has(id) || old.last.state !== "open") continue;
      broadcast({ conversationId: ownerOf(old.last), choice: expiredChoice(id), copyInDm: old.last.conversation.type === "web" });
    }
  }

  function tick(): Promise<void> {
    if (running) return running;
    running = pass()
      .then(
        () => {
          if (failing) log("Rückfragen werden wieder abgeglichen");
          failing = false;
        },
        e => {
          if (!failing) log(`Rückfragen nicht abgleichbar (${e instanceof Error ? e.name : typeof e})`);
          failing = true;
        }
      )
      .finally(() => {
        running = null;
      });
    return running;
  }

  function start(): void {
    stopHook = deps.register.onChange(({ type, choice }) => {
      if (type !== "decided" && type !== "expired") return;
      remember(choice);
      broadcast(change(choice));
    });
    const every =
      deps.every ??
      ((ms: number, fn: () => Promise<void>) => {
        const timer = setInterval(() => void fn(), ms);
        (timer as { unref?: () => void }).unref?.();
        return () => clearInterval(timer);
      });
    stopTimer = every(deps.intervalMs ?? CHOICE_SYNC_MS, tick);
    void tick();
  }

  function stop(): void {
    stopHook?.();
    stopHook = null;
    stopTimer?.();
    stopTimer = null;
    known = undefined;
    failing = false;
  }

  function subscribe(listener: (change: ChoiceChange) => void): () => void {
    listeners.add(listener);
    if (listeners.size === 1) {
      try {
        start();
      } catch (e) {
        listeners.delete(listener);
        stop();
        throw e;
      }
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) stop();
    };
  }

  return { view, decide, subscribe };
}
