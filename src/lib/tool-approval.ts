/**
 * Werkzeug-Freigaben über das Rückfragen-Register (Issue #116, Entscheidung 0017).
 *
 * Ein Handler für alle Kanäle: Ein Werkzeug mit requiresApproval legt eine
 * Rückfrage kind "tool" an (Erlauben/Ablehnen, Frist 10 Minuten) und wartet,
 * bis sie entschieden ist. Die Frage gehört zum Gespräch des Turns, abgeleitet
 * aus dem Ausführungsschlüssel:
 * - web:<id>: reines Web-Gespräch (Kopie mit Hinweis im Telegram-Direktchat)
 * - dm:<chatId>: Direktchat
 * - topic:<chatId>:<topicId>: Forum-Topic
 * - group:<chatId>: Forum-Gruppe ohne Thread (General)
 * Unbekannte Schlüssel oder ein Aufruf ohne Ausführung lehnen ab, damit nie
 * eine Freigabe im falschen Gespräch entsteht.
 *
 * Gezeigt wird die Frage in Telegram über sendChoice (Topic, Direktchat bzw.
 * Kopie) und, wenn ein Browser- oder Terminal-Turn unter demselben Schlüssel
 * läuft, über dessen Presenter (Nachricht mit choiceId, Status awaiting).
 *
 * Entschieden wird ausschließlich im Register (decideChoice aus Telegram,
 * Browser oder Terminal): der Handler für "tool" wird einmal installiert und
 * ordnet die Entscheidung der wartenden Freigabe über die Register-ID zu.
 * Ablauf der Frist und Abbruch der Ausführung (/stop) setzen die Frage auf
 * expired und lehnen ab; ein Ablauf aus einem anderen Weg (expireLapsedChoices)
 * kommt über onChoiceChange an.
 *
 * Freigaben einer Ausführung laufen nacheinander, nie zwei Fragen zugleich.
 */

import {
  createChoice,
  expireChoice,
  listChoices,
  onChoiceChange,
  onChoiceDecided,
  type Choice,
  type ChoiceConversation,
  type ChoiceOption,
} from "./choices";
import { currentExecution } from "./execution-context";
import { sanitizeModelOutput } from "./telegram";
import { toolApprovalPreview, type BuiltinTool, type ToolApprovalHandler } from "./tools/registry";

/** Ohne Entscheidung gilt eine Freigabe nach 10 Minuten als abgelehnt */
export const TOOL_APPROVAL_TIMEOUT_MS = 600_000;
export const TOOL_ALLOW = "allow";
export const TOOL_DENY = "deny";
export const TOOL_APPROVAL_OPTIONS: ChoiceOption[] = [
  { key: TOOL_ALLOW, label: "Erlauben" },
  { key: TOOL_DENY, label: "Ablehnen" },
];

/** Nur diese Text-Antworten erteilen eine Freigabe; alles andere lehnt ab. */
export function isApprovalAnswer(text: string): boolean {
  return /^(ja|j|yes|y|ok|okay|erlauben|erlaube|freigeben)[.!]?$/i.test(text.trim());
}

/** Optionsschlüssel für eine eingetippte Antwort */
export function approvalKeyForText(text: string): string {
  return isApprovalAnswer(text) ? TOOL_ALLOW : TOOL_DENY;
}

/**
 * Argumente vom Modell: jeder Text vor dem Kürzen der Vorschau bereinigt
 * (Issue #52), sonst verlöre ein abgeschnittenes Bild seine Klammer.
 */
export function sanitizeToolArgs(value: unknown): unknown {
  if (typeof value === "string") return sanitizeModelOutput(value);
  if (Array.isArray(value)) return value.map(sanitizeToolArgs);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeToolArgs(v)]));
  }
  return value;
}

/** Fragetext: Werkzeugname, Beschreibung, geschwärzte und gekürzte Vorschau */
export function toolApprovalText(tool: BuiltinTool, args: Record<string, unknown>): string {
  return [
    `Freigabe nötig: Werkzeug ${tool.name}`,
    "",
    tool.description.slice(0, 150),
    "",
    toolApprovalPreview(sanitizeToolArgs(args) as Record<string, unknown>),
    "",
    "Ohne Entscheidung wird es nach 10 Minuten abgelehnt.",
  ].join("\n");
}

/** Zusatz im Browser und Terminal: dort geht auch eine Text-Antwort */
export const TEXT_ANSWER_HINT = "Knopf wählen oder mit „ja“ antworten; jede andere Antwort lehnt ab.";

/** Hinweis vor der Kopie einer Frage aus einem reinen Web-Gespräch im Direktchat */
export function webCopyNote(title: string | undefined): string {
  const clean = (title ?? "").replace(/[\p{Cc}"„“]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return clean ? `(Web-Gespräch „${clean}“)` : "(Web-Gespräch)";
}

const TELEGRAM_USER = /^\d{1,20}$/;
const TELEGRAM_GROUP = /^-\d{1,20}$/;
const WEB_CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Gespräch der Frage aus dem Ausführungsschlüssel; null: unbekannt, dann keine Freigabe */
export function conversationForExecution(key: string | undefined): ChoiceConversation | null {
  if (!key) return null;
  const parts = key.split(":");
  const [kind] = parts;
  if (kind === "web" && parts.length === 2 && WEB_CONVERSATION.test(parts[1])) {
    return { type: "web", conversationId: parts[1] };
  }
  if (kind === "dm" && parts.length === 2 && TELEGRAM_USER.test(parts[1])) {
    return { type: "telegram", chatId: parts[1] };
  }
  if (kind === "group" && parts.length === 2 && TELEGRAM_GROUP.test(parts[1])) {
    return { type: "telegram", chatId: parts[1] };
  }
  if (kind === "topic" && parts.length === 3 && TELEGRAM_GROUP.test(parts[1]) && /^[1-9]\d{0,9}$/.test(parts[2])) {
    return { type: "telegram", chatId: parts[1], topicId: Number(parts[2]) };
  }
  return null;
}

/**
 * Browser- oder Terminal-Turn unter einem Ausführungsschlüssel: zeigt die
 * Frage im Verlauf bzw. setzt den Status und nimmt eine Text-Antwort an.
 */
export interface ToolApprovalPresenter {
  /** Titel eines reinen Web-Gesprächs für den Hinweis an der Kopie im Direktchat */
  title?: string;
  /** Frage zeigen; question ist der Text für Browser und Terminal */
  ask(choice: Choice, question: string): Promise<void>;
  /** Frage erledigt (entschieden, abgelaufen, abgebrochen) */
  end(choiceId: string): void;
}

export interface ChoiceToolApprovalDeps {
  /** Frage in Telegram zeigen (createTelegramChoices().sendChoice); false/Wurf: nicht gesendet */
  sendChoice(choice: Choice): Promise<{ sent: boolean } | unknown>;
  /** Laufender Browser- oder Terminal-Turn unter diesem Schlüssel */
  presenter?(executionKey: string): ToolApprovalPresenter | undefined;
  timeoutMs?: number;
  /** Uhr und Zeitgeber, in Tests steuerbar; schedule gibt das Abbrechen zurück */
  now?(): number;
  schedule?(fn: () => void, ms: number): () => void;
  /** Nur IDs und Werkzeugnamen, nie Argumente */
  log?(message: string): void;
}

export interface ChoiceToolApproval {
  handler: ToolApprovalHandler;
  /** Wartende Freigaben (für Tests) */
  pendingCount(): number;
  /** Handler und Zuhörer abmelden, wartende lehnen ab */
  dispose(): void;
}

/**
 * Beim Start: offene Freigaben aus einem früheren Lauf ablaufen lassen. Auf
 * sie wartet kein Werkzeug mehr, ein Klick dürfte nichts freigeben; der
 * Zuhörer der Telegram-Rückfragen zieht ihre Nachrichten nach.
 */
export async function expireOrphanedToolChoices(deps: { list(): Promise<Choice[]>; expire(id: string): Promise<unknown> } = { list: listChoices, expire: expireChoice }): Promise<number> {
  const open = (await deps.list()).filter(c => c.kind === "tool" && c.state === "open");
  for (const c of open) await deps.expire(c.id);
  return open.length;
}

export function createChoiceToolApproval(deps: ChoiceToolApprovalDeps): ChoiceToolApproval {
  const log = deps.log ?? ((m: string) => console.log(`[freigabe] ${m}`));
  const timeoutMs = deps.timeoutMs ?? TOOL_APPROVAL_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  const waiting = new Map<string, (approved: boolean) => void>();
  const queues = new Map<string, Promise<unknown>>();

  const offDecided = onChoiceDecided("tool", choice => {
    const finish = waiting.get(choice.id);
    if (!finish) {
      log(`Freigabe ${choice.id} entschieden, aber hier wartet nichts mehr darauf`);
      return;
    }
    finish(choice.result?.key === TOOL_ALLOW);
  });
  const offChange = onChoiceChange(({ type, choice }) => {
    if (type === "expired" && choice.kind === "tool") waiting.get(choice.id)?.(false);
  });

  async function ask(key: string, conversation: ChoiceConversation, tool: BuiltinTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const presenter = deps.presenter?.(key);
    const question = toolApprovalText(tool, args);
    const text = conversation.type === "web" ? `${webCopyNote(presenter?.title)}\n${question}` : question;
    let choice: Choice;
    try {
      choice = await createChoice({
        kind: "tool",
        conversation,
        text,
        options: TOOL_APPROVAL_OPTIONS,
        expiresAt: now() + timeoutMs,
        ref: tool.name,
      });
    } catch (e) {
      log(`Freigabe für ${tool.name} nicht angelegt (${e instanceof Error ? e.name : typeof e})`);
      return false;
    }
    const id = choice.id;

    return new Promise<boolean>(resolve => {
      let done = false;
      let cancelTimer = () => {};
      const finish = (approved: boolean) => {
        if (done) return;
        done = true;
        waiting.delete(id);
        cancelTimer();
        signal?.removeEventListener("abort", abort);
        try {
          presenter?.end(id);
        } catch {
          // Anzeige ist Beiwerk, die Entscheidung gilt
        }
        resolve(approved);
      };
      // Frist oder Abbruch: im Register ablaufen lassen; war sie schon entschieden, gilt das Ergebnis
      const expire = (why: string) => {
        if (done) return;
        expireChoice(id).then(
          outcome => {
            if (outcome.status === "already" && outcome.choice.state === "done" && why === "frist") {
              finish(outcome.choice.result?.key === TOOL_ALLOW);
              return;
            }
            if (outcome.status === "expired") log(`Freigabe ${id} (${tool.name}) abgelaufen: ${why}`);
            finish(false);
          },
          e => {
            log(`Ablauf von ${id} nicht gespeichert (${e instanceof Error ? e.name : typeof e})`);
            finish(false);
          }
        );
      };
      const abort = () => expire("abgebrochen");
      waiting.set(id, finish);
      cancelTimer = schedule(() => expire("frist"), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }

      void (async () => {
        let shown = false;
        if (presenter) {
          try {
            await presenter.ask(choice, `${question}\n${TEXT_ANSWER_HINT}`);
            shown = true;
          } catch (e) {
            log(`Freigabe ${id} nicht im Browser gezeigt (${e instanceof Error ? e.name : typeof e})`);
          }
        }
        let sent = false;
        try {
          const result = await deps.sendChoice(choice);
          sent = !!(result && typeof result === "object" && (result as { sent?: unknown }).sent);
        } catch (e) {
          log(`Freigabe ${id} nicht nach Telegram gesendet (${e instanceof Error ? e.name : typeof e})`);
        }
        // Nirgends zu sehen: niemand kann entscheiden, also sofort ablehnen
        if (!shown && !sent) expire("nicht zustellbar");
      })();
    });
  }

  const handler: ToolApprovalHandler = (tool, args) => {
    const execution = currentExecution();
    const key = execution?.key;
    const conversation = conversationForExecution(key);
    if (!key || !conversation) {
      log(`Freigabe für ${tool.name} abgelehnt: kein bekanntes Gespräch`);
      return Promise.resolve(false);
    }
    const signal = execution.controller.signal;
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => ask(key, conversation, tool, args, signal));
    const tail = result.catch(() => {});
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return result;
  };

  return {
    handler,
    pendingCount: () => waiting.size,
    dispose() {
      offDecided();
      offChange();
      for (const finish of [...waiting.values()]) finish(false);
    },
  };
}
