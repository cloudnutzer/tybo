/**
 * Wann tybo von selbst pusht (Issue #226, Entscheidung 0021). Ein
 * Benachrichtiger, den server.ts an den Stellen aufruft, an denen er ohnehin
 * veröffentlicht; keine zweite Ereigniskette.
 *
 * - Antwort fertig (reply): Antworten auf Nachrichten aus Browser oder
 *   Terminal. Antworten auf Nachrichten aus Telegram meldet Telegram selbst,
 *   die pushen nicht.
 * - Rückfrage neu (choice): einmal je Frage, Urgency high. Nicht die Arten
 *   thread (Erinnerung an offene Fäden, Issue #292) und reminder (Issue #322): die meldet der
 *   Meldungsweg, erst wenn die Erinnerung zugestellt bzw. festgehalten ist.
 *   Angelegte, aber nie gesendete Rückfragen (verwaist, von einem zweiten
 *   Durchgang verdrängt, sicher abgelehnt) pushen so nie.
 * - Meldung (notice): mit Absender; Ergebnisse von Rückfragen und Befehlen
 *   (freigabe, review, topic, befehl) nicht, die hat der Nutzer selbst ausgelöst.
 *   Meldungen mit Rückfrage-Knöpfen (choiceId) meldet der Rückfrage-Weg, außer
 *   Erinnerungen an offene Fäden (source faeden) und Erinnerungen aus der
 *   Ablage (source erinnerung, Issue #322).
 *
 * Für ein Gespräch, das irgendwo sichtbar offen ist (./presence), geht nie ein
 * Push raus. Je Gerät zählen seine Einstellungen (Kategorie an/aus, Inhalt
 * zeigen). Ohne „Inhalt zeigen" steht in der Nutzlast nur Gesprächstitel,
 * Agent bzw. Absender, nie Antwort-, Meldungstext oder Dateiname.
 *
 * Bündeln: je Gespräch ein tag (neue Benachrichtigung ersetzt die alte), je
 * Gerät und Gespräch höchstens eine Antwort-Benachrichtigung pro 30 Sekunden.
 * Die Sperre gilt pro Gerät, damit ein Gerät die anderen nicht ausschließt.
 *
 * Log je Push: eine Zeile mit Kategorie, Gerät und Ergebnis schreibt der
 * Versand (./push-api, deliveryText), auch für Fehler und abgelaufene Abos.
 * Nie Inhalt oder Endpunkt. Wirft nie; Fehler beim Versand bremsen weder Chat
 * noch Ereignisverteilung.
 */

import { BRAND } from "../brand";
import { agentLabel } from "./agents";
import type { ChoiceKindName } from "./choices";
import { stripControlTags } from "./markdown";
import type { PushMessage, PushUrgency } from "./push";
import type { DeliveryResult, SendPushOptions } from "./push-api";
import type { PushDevice, PushDeviceSettings } from "./push-store";

export type PushCategory = "reply" | "choice" | "notice";
/** Woher die Nachricht kam, auf die ein Turn antwortet */
export type TurnOrigin = "telegram" | "web" | "terminal";

export const PREVIEW_MAX_CHARS = 120;
export const REPLY_THROTTLE_MS = 30_000;
/** Benachrichtigungen je Gespräch ersetzen einander */
export const CONVERSATION_TAG_PREFIX = "c-";

export const PUSH_TRIGGER_TEXT = {
  replyFrom: (agent: string) => `Antwort von ${agent}`,
  choiceTitle: `${BRAND.name} fragt nach`,
  noticeBody: "Neue Meldung",
  fileBody: "Neue Datei",
  file: (name: string) => `Datei: ${name}`,
  categories: { reply: "Antwort", choice: "Rückfrage", notice: "Meldung" } as Record<PushCategory, string>,
} as const;

export const CHOICE_KIND_LABELS: Record<ChoiceKindName, string> = {
  tool: "Werkzeug-Freigabe",
  review: "Merk-Vorschlag",
  goal: "Weiter?",
  topicmap: "Topic-Zuordnung",
  routine: "Routine",
  thread: "Offener Faden",
  memory: "Gedächtnis",
  reminder: "Erinnerung",
  proactive: "Meldung",
  ask: "Rückfrage",
  call: "Anruf",
  cleanup: "Gedächtnis aufräumen",
  core: "Kern",
  secret: "Geheimnis im Gedächtnis",
  sprachagent: "Sprachagent",
  job: "Job fortsetzen",
};

/** Anzeigenamen der Absender wie NOTICE_SOURCES in public/app.js; unbekannte groß geschrieben */
export const NOTICE_SOURCE_LABELS: Record<string, string> = {
  pipeline: "Pipeline",
  job: "Job",
  briefing: "Briefing",
  checkin: "Check-in",
  watchdog: "Watchdog",
  watcher: "Watcher",
  datei: "Datei",
  ziel: "Ziel",
  system: "System",
  telefonhoerer: "Telefonhörer",
  faeden: "Fäden",
  gedaechtnis: "Gedächtnis",
  erinnerung: "Erinnerung",
  rueckfrage: "Rückfrage",
  anruf: "Anruf",
  sprachagent: "Sprachagent",
};

/**
 * Folgen eigener Entscheidungen oder Befehle: kein Push. Dazu der
 * Telefonhörer (Issue #260): Ende des Gesprächs und was gemerkt wurde, der
 * Nutzer hat gerade selbst telefoniert. Rückfragen des Modells (Issue #335)
 * pushen über den Rückfragen-Weg (choice), ihre Ergebnisse nicht
 */
const QUIET_NOTICE_SOURCES = new Set(["befehl", "freigabe", "review", "topic", "telefonhoerer", "rueckfrage"]);

/** Erinnerungen an offene Fäden (wie THREAD_SOURCE in src/lib/thread-choices.ts): pushen als Meldung, auch mit choiceId */
export const THREAD_NOTICE_SOURCE = "faeden";
/** Erinnerungen aus der Ablage (wie REMINDER_SOURCE in src/lib/reminder-choices.ts, Issue #322): ebenso */
export const REMINDER_NOTICE_SOURCE = "erinnerung";
/** Meldungen, die trotz choiceId als Meldung pushen; ihre Rückfrage pusht dafür nicht */
const NOTICE_SOURCES_WITH_CHOICE = new Set([THREAD_NOTICE_SOURCE, REMINDER_NOTICE_SOURCE]);

export interface ReplyEvent {
  conversationId: string;
  text: string;
  agent?: string;
  origin: TurnOrigin;
}

export interface ChoiceEvent {
  conversationId: string;
  choiceId: string;
  kind?: ChoiceKindName;
}

export interface NoticeEvent {
  conversationId: string;
  text: string;
  source?: string;
  file?: { name: string };
  /** Meldung mit Rückfrage-Knöpfen: die meldet der Rückfrage-Weg */
  choiceId?: string;
}

/** Was im Service Worker zu einer Benachrichtigung bekannt ist (Issue #226) */
export interface TriggerMessage extends PushMessage {
  category: PushCategory;
  conversationId: string;
  choiceId?: string;
}

export interface PushNotifierDeps {
  devices(): PushDevice[];
  /** Versand samt Log-Zeile (Kategorie in label, Gerät, Ergebnis) */
  send(device: PushDevice, message: TriggerMessage, options: SendPushOptions): Promise<DeliveryResult>;
  /** Ist das Gespräch gerade auf einem Tab sichtbar offen? */
  isVisible(conversationId: string): boolean;
  /** Titel des Gesprächs für die Benachrichtigung */
  title(conversationId: string): Promise<string>;
  now?: () => number;
  log?: (message: string) => void;
}

export interface PushNotifier {
  reply(event: ReplyEvent): Promise<void>;
  choice(event: ChoiceEvent): Promise<void>;
  notice(event: NoticeEvent): Promise<void>;
}

/** Adresse, die das Gespräch öffnet (Direktlink, Issue #226) */
export function conversationUrl(conversationId: string): string {
  return `/#/gespraech/${encodeURIComponent(conversationId)}`;
}

/**
 * Klartext für die Vorschau: ohne Steuer-Tags, Markdown und HTML, Leerraum
 * zusammengezogen, höchstens 120 Zeichen (mit … gekürzt)
 */
export function plainPreview(text: string, max = PREVIEW_MAX_CHARS): string {
  let s = stripControlTags(String(text ?? ""));
  s = s
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max - 1).join("").trimEnd() + "…" : s;
}

export function noticeSourceLabel(source: string | undefined): string {
  if (!source) return BRAND.name;
  return NOTICE_SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

const SETTING_OF: Record<PushCategory, keyof PushDeviceSettings> = { reply: "replies", choice: "choices", notice: "notices" };

export function createPushNotifier(deps: PushNotifierDeps): PushNotifier {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  /** Letzte Antwort-Benachrichtigung je Gerät und Gespräch */
  const lastReply = new Map<string, number>();

  async function titleOf(conversationId: string): Promise<string> {
    try {
      const t = await deps.title(conversationId);
      return plainPreview(t, 60) || BRAND.name;
    } catch {
      return BRAND.name;
    }
  }

  /** Versand an alle Geräte mit dieser Kategorie; build baut die Nachricht je Gerät (Vorschau an/aus) */
  async function deliver(
    category: PushCategory,
    conversationId: string,
    build: (settings: PushDeviceSettings) => TriggerMessage,
    options: { urgency?: PushUrgency; throttle?: boolean } = {}
  ): Promise<void> {
    if (deps.isVisible(conversationId)) return;
    const devices = deps.devices().filter(d => d.settings[SETTING_OF[category]]);
    const t = now();
    const targets = devices.filter(d => {
      if (!options.throttle) return true;
      const last = lastReply.get(`${d.id} ${conversationId}`);
      return last === undefined || t - last >= REPLY_THROTTLE_MS;
    });
    if (options.throttle) {
      for (const d of targets) lastReply.set(`${d.id} ${conversationId}`, t);
      if (lastReply.size > 1000) {
        for (const [key, at] of lastReply) if (t - at >= REPLY_THROTTLE_MS) lastReply.delete(key);
      }
    }
    await Promise.all(
      targets.map(async device => {
        const label = PUSH_TRIGGER_TEXT.categories[category];
        try {
          await deps.send(device, build(device.settings), { urgency: options.urgency ?? "normal", label });
        } catch (e) {
          // Der Versand selbst ist abgebrochen, er hat also nichts geloggt
          log(`Push (${label}) an „${device.name}": Fehler (${e instanceof Error ? e.name : typeof e})`);
        }
      })
    );
  }

  function guard(fn: () => Promise<void>): Promise<void> {
    return fn().catch(e => log(`Push nicht verschickt (${e instanceof Error ? e.name : typeof e})`));
  }

  return {
    reply(event) {
      return guard(async () => {
        if (event.origin === "telegram") return;
        if (deps.isVisible(event.conversationId) || !deps.devices().some(d => d.settings.replies)) return;
        const title = await titleOf(event.conversationId);
        const agent = event.agent ? agentLabel(event.agent) : BRAND.name;
        await deliver(
          "reply",
          event.conversationId,
          settings => ({
            category: "reply",
            conversationId: event.conversationId,
            title,
            body: (settings.preview && plainPreview(event.text)) || PUSH_TRIGGER_TEXT.replyFrom(agent),
            tag: CONVERSATION_TAG_PREFIX + event.conversationId,
            url: conversationUrl(event.conversationId),
          }),
          { throttle: true }
        );
      });
    },

    choice(event) {
      return guard(async () => {
        // Erinnerungen und proaktive Meldungen pushen über den Meldungsweg (notice)
        if (event.kind === "thread" || event.kind === "reminder" || event.kind === "proactive") return;
        if (deps.isVisible(event.conversationId) || !deps.devices().some(d => d.settings.choices)) return;
        const title = await titleOf(event.conversationId);
        const kind = event.kind ? CHOICE_KIND_LABELS[event.kind] : null;
        await deliver(
          "choice",
          event.conversationId,
          () => ({
            category: "choice",
            conversationId: event.conversationId,
            choiceId: event.choiceId,
            title: PUSH_TRIGGER_TEXT.choiceTitle,
            body: kind ? `${kind} · ${title}` : title,
            tag: CONVERSATION_TAG_PREFIX + event.conversationId,
            url: conversationUrl(event.conversationId),
          }),
          { urgency: "high" }
        );
      });
    },

    notice(event) {
      return guard(async () => {
        if (event.choiceId && !NOTICE_SOURCES_WITH_CHOICE.has(event.source ?? "")) return;
        if (event.source && QUIET_NOTICE_SOURCES.has(event.source)) return;
        if (deps.isVisible(event.conversationId) || !deps.devices().some(d => d.settings.notices)) return;
        const sender = event.file && !event.source ? NOTICE_SOURCE_LABELS.datei : noticeSourceLabel(event.source);
        await deliver("notice", event.conversationId, settings => {
          let body: string;
          if (event.file) body = settings.preview ? PUSH_TRIGGER_TEXT.file(plainPreview(event.file.name, 80)) : PUSH_TRIGGER_TEXT.fileBody;
          else body = (settings.preview && plainPreview(event.text)) || PUSH_TRIGGER_TEXT.noticeBody;
          return {
            category: "notice",
            conversationId: event.conversationId,
            title: sender,
            body,
            tag: CONVERSATION_TAG_PREFIX + event.conversationId,
            url: conversationUrl(event.conversationId),
          };
        });
      });
    },
  };
}
