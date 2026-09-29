/**
 * Motor in der WebUI (Issue #126, Entscheidung 0018): GET /api/engines und
 * POST /api/engines/reset.
 *
 * Diese Datei importiert nichts aus src/lib; src/bot.ts übergibt die echten
 * Quellen als EnginePort (src/web/bot-engines.ts), Tests und Demo reichen
 * Attrappen herein. Die Verfügbarkeit (installiert, angemeldet, Version)
 * kommt nur über den Port, in Tests und Demo nie aus einem echten Befehl.
 *
 * Datenverträge:
 * - Standard wie defaultEngineSetting (Einstellungsdatei, TYBO_ENGINE, Claude Code).
 * - Ausnahmen stehen in engine.topics unter dem Session-Schlüssel
 *   (topic:<chat>:<topic>, dm:<chat>, web:<id>), nicht unter der ID der WebUI.
 *   sessionKey() bildet eine Gesprächs-ID der WebUI darauf ab wie beim
 *   Schreiben; eine Ausnahme ohne passendes Gespräch (Topic gelöscht, andere
 *   Gruppe) steht in der Liste als „nicht mehr zuzuordnen" und lässt sich
 *   trotzdem entfernen.
 * - „Auf Standard" entfernt genau diesen einen Eintrag. Gehört er zu einem
 *   Gespräch der WebUI, läuft das wie /motor standard: unter der Sperre des
 *   Gesprächs, die Session endet, eine laufende Antwort ergibt 409. Ob er
 *   dazugehört, folgt aus dem Schlüssel selbst (Kandidat, bestätigt über
 *   sessionKey()), nie aus der Gesprächsliste: die dient nur den Titeln.
 *   Lässt sich der Schlüssel des Kandidaten nicht bilden (null oder Fehler,
 *   etwa Gruppe gerade nicht lesbar) oder der Session-Reset keine Session
 *   ermitteln, bleibt alles unverändert (503): das beweist nicht, dass keine
 *   Antwort läuft.
 */

import { createRevisionClock, type RevisionClock } from "./revision";
import type { ApiResult } from "./settings";

export type EngineDefaultSource = "settings" | "env" | "code";

/** Verfügbarkeit eines Motors für die Anzeige */
export interface EngineAvailability {
  engine: string;
  label: string;
  installed: boolean;
  /** null: installiert, aber nicht feststellbar, ob angemeldet */
  loggedIn: boolean | null;
  version?: string;
  /** Verständlicher Hinweis, wenn der Motor nicht bereit ist */
  message?: string;
}

export interface EnginePort {
  /** Wählbare Motoren mit Anzeigenamen, Claude Code zuerst */
  engines: readonly { id: string; label: string }[];
  /** Standard-Motor ohne Ausnahme, mit Quelle */
  standard(): { engine: string; source: EngineDefaultSource };
  /** Ausnahmen aus engine.topics: Session-Schlüssel zu Motor */
  overrides(): Record<string, string>;
  /** Session-Schlüssel eines Gesprächs der WebUI wie beim Schreiben; null, wenn keiner ermittelbar */
  sessionKey(conversationId: string): string | null;
  /** Installiert, angemeldet, Version je Motor */
  availability(): Promise<EngineAvailability[]>;
  /**
   * Entfernt die Ausnahme, wenn sie noch besteht, in der Schreibkette der
   * Einstellungen; true, wenn ein Eintrag entfernt wurde. Wirft bei
   * ungültiger Datei oder Schreibfehler.
   */
  removeOverride(sessionKey: string): Promise<boolean>;
  /**
   * Meldet Änderungen an Standard oder Ausnahmen, gleich woher (/motor aus
   * Telegram, Browser, Terminal, Einstellungsseite, Hand). Gibt die
   * Abmeldung zurück.
   */
  subscribe?(listener: () => void): () => void;
}

/** Gespräch der WebUI mit Anzeigename */
export interface EngineConversation {
  id: string;
  title: string;
}

/** Ausnahme eines Gesprächs für die Einstellungsseite */
export interface EngineOverrideView {
  key: string;
  engine: string;
  label: string;
  /** Gesprächs-ID der WebUI; null, wenn keins mehr passt */
  conversationId: string | null;
  title: string | null;
}

/** unavailable: Session des Gesprächs nicht ermittelbar, nichts geschrieben */
export type EngineResetOutcome = "done" | "busy" | "closing" | "unavailable";

export interface EnginesApiDeps {
  /** Alle Gespräche der WebUI (Direktchat, Topics, ältere Web-Gespräche) */
  conversations(): Promise<EngineConversation[]>;
  /**
   * Ausnahme eines Gesprächs der WebUI entfernen wie /motor standard (Sperre,
   * Session-Ende); write schreibt die Einstellung, nur bei done. Fehlt, wird direkt geschrieben.
   */
  resetConversation?(conversationId: string, write: () => Promise<void>): Promise<EngineResetOutcome>;
}

export const ENGINE_TEXT = {
  notConfigured: "Die Motor-Wahl ist nicht eingerichtet",
  invalidRequest: "Ungültige Anfrage",
  gone: "Diese Ausnahme gibt es nicht mehr.",
  busy: "In diesem Gespräch läuft gerade eine Antwort. Erst stoppen, dann auf Standard stellen.",
  closing: "Die WebUI wird gerade beendet",
  notSaved: "Der Motor konnte nicht zurückgesetzt werden",
  unassignable: "Das Gespräch dieser Ausnahme lässt sich gerade nicht zuordnen, nichts geändert. Bitte später noch einmal versuchen.",
  fileInvalid: "config/settings.json ist ungültig, nichts geändert. Bitte die Datei reparieren oder löschen.",
  availabilityFailed: "Verfügbarkeit nicht ermittelbar",
} as const;

/** Wie CONVERSATION_KEY_PATTERN in src/lib/settings.ts */
const SESSION_KEY_PATTERN = /^(topic:-?\d{1,20}:\d{1,12}|group:-\d{1,20}|dm:-?\d{1,20}|web:[A-Za-z0-9-]{1,64})$/;

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

/**
 * Gesprächs-ID der WebUI, zu der ein Session-Schlüssel gehören kann
 * (dm:<chat> zum Direktchat, group:<chat> zu General, topic:<chat>:<n> zum
 * Topic, web:<id> zum Web-Gespräch). Nur ein Kandidat: ob er wirklich passt,
 * entscheidet port.sessionKey.
 */
function candidateConversationId(key: string): string | null {
  if (key.startsWith("dm:")) return "dm";
  if (key.startsWith("group:")) return "topic-1";
  const topic = /^topic:-?\d{1,20}:(\d{1,12})$/.exec(key);
  if (topic) return `topic-${topic[1]}`;
  if (key.startsWith("web:")) return key.slice("web:".length);
  return null;
}

/** Anzeigename eines Motors, sonst die Kennung */
export function engineLabelOf(port: Pick<EnginePort, "engines">, id: string): string {
  return port.engines.find(e => e.id === id)?.label ?? id;
}

/**
 * Eingestellter Motor je Gespräch (Ausnahme, sonst Standard), wie
 * configuredEngine in src/lib/engine-choice.ts; ohne Schlüssel der Standard.
 */
export function conversationEngines(port: Pick<EnginePort, "standard" | "overrides" | "sessionKey">, ids: readonly string[]): Record<string, string> {
  const standard = port.standard().engine;
  const overrides = port.overrides();
  const out: Record<string, string> = {};
  for (const id of ids) {
    let key: string | null = null;
    try {
      key = port.sessionKey(id);
    } catch {
      key = null;
    }
    out[id] = (key && Object.hasOwn(overrides, key) ? overrides[key] : undefined) ?? standard;
  }
  return out;
}

/** Nur die Felder, die die Anzeige braucht, ohne rohe Ausgaben */
function cleanAvailability(list: EngineAvailability[]): EngineAvailability[] {
  return list.map(a => ({
    engine: String(a.engine),
    label: String(a.label),
    installed: a.installed === true,
    loggedIn: a.loggedIn === true ? true : a.loggedIn === false ? false : null,
    ...(typeof a.version === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(a.version) ? { version: a.version } : {}),
    ...(typeof a.message === "string" && a.message ? { message: a.message.slice(0, 300) } : {}),
  }));
}

export interface EnginesApi {
  get(): Promise<ApiResult>;
  reset(body: string): Promise<ApiResult>;
}

export function createEnginesApi(
  port: EnginePort,
  deps: EnginesApiDeps,
  log: (message: string) => void,
  clock: RevisionClock = createRevisionClock()
): EnginesApi {
  async function overrideViews(): Promise<EngineOverrideView[]> {
    let conversations: EngineConversation[] = [];
    try {
      conversations = await deps.conversations();
    } catch (e) {
      log(`Motor: Gespräche nicht lesbar (${errorName(e)})`);
    }
    const byKey = new Map<string, EngineConversation>();
    for (const c of conversations) {
      let key: string | null = null;
      try {
        key = port.sessionKey(c.id);
      } catch {
        key = null;
      }
      if (key && !byKey.has(key)) byKey.set(key, c);
    }
    return Object.entries(port.overrides())
      .map(([key, engine]) => {
        const c = byKey.get(key);
        return { key, engine, label: engineLabelOf(port, engine), conversationId: c?.id ?? null, title: c?.title ?? null };
      })
      .sort((a, b) => Number(a.conversationId === null) - Number(b.conversationId === null) || (a.title ?? a.key).localeCompare(b.title ?? b.key, "de"));
  }

  async function view(): Promise<Record<string, unknown>> {
    const [overrides, availability] = await Promise.all([
      overrideViews(),
      port.availability().then(cleanAvailability, e => {
        log(`Motor: Verfügbarkeit nicht ermittelbar (${errorName(e)})`);
        return null;
      }),
    ]);
    const standard = port.standard();
    return {
      default: { engine: standard.engine, source: standard.source },
      engines: port.engines.map(e => ({ id: e.id, label: e.label })),
      overrides,
      availability,
      revision: clock.stamp("engines", { standard, overrides: port.overrides() }),
    };
  }

  return {
    async get() {
      return { status: 200, body: await view() };
    },

    async reset(body) {
      let key: unknown;
      try {
        key = JSON.parse(body)?.key;
      } catch {
        return { status: 400, body: { error: ENGINE_TEXT.invalidRequest } };
      }
      if (typeof key !== "string" || !SESSION_KEY_PATTERN.test(key)) return { status: 400, body: { error: ENGINE_TEXT.invalidRequest } };
      const sessionKey = key;
      if (!Object.hasOwn(port.overrides(), sessionKey)) return { status: 404, body: { error: ENGINE_TEXT.gone, ...(await view()) } };
      // Zuordnung aus dem Schlüssel selbst, nicht aus der Gesprächsliste: eine
      // fehlende oder unvollständige Liste beweist nicht, dass keine Session läuft.
      // Nicht feststellbar (Schlüssel null oder Fehler beim Bilden): nichts ändern,
      // denn null beweist nicht, dass unter dem Schlüssel keine Antwort läuft
      const candidate = candidateConversationId(sessionKey);
      let conversation: string | null = null;
      if (candidate) {
        let candidateKey: string | null;
        try {
          candidateKey = port.sessionKey(candidate);
        } catch (e) {
          log(`Motor-Ausnahme nicht entfernt, Gespräch nicht zuzuordnen (${errorName(e)})`);
          return { status: 503, body: { error: ENGINE_TEXT.unassignable } };
        }
        if (candidateKey === null) {
          log("Motor-Ausnahme nicht entfernt, Gespräch nicht zuzuordnen (kein Schlüssel)");
          return { status: 503, body: { error: ENGINE_TEXT.unassignable } };
        }
        if (candidateKey === sessionKey) conversation = candidate;
      }
      let removed = false;
      const write = async () => {
        removed = await port.removeOverride(sessionKey);
      };
      try {
        if (conversation && deps.resetConversation) {
          const outcome = await deps.resetConversation(conversation, write);
          if (outcome === "busy") return { status: 409, body: { error: ENGINE_TEXT.busy } };
          if (outcome === "closing") return { status: 503, body: { error: ENGINE_TEXT.closing } };
          if (outcome === "unavailable") {
            log("Motor-Ausnahme nicht entfernt, keine Session des Gesprächs ermittelbar");
            return { status: 503, body: { error: ENGINE_TEXT.unassignable } };
          }
        } else {
          await write();
        }
      } catch (e) {
        log(`Motor-Ausnahme nicht entfernt (${errorName(e)})`);
        if (errorName(e) === "SettingsFileInvalidError") return { status: 409, body: { error: ENGINE_TEXT.fileInvalid } };
        return { status: 500, body: { error: ENGINE_TEXT.notSaved } };
      }
      if (!removed) return { status: 404, body: { error: ENGINE_TEXT.gone, ...(await view()) } };
      // Nur, dass etwas entfernt wurde, nie der Schlüssel
      log(`Motor-Ausnahme eines Gesprächs entfernt (${conversation ? "Gespräch der WebUI" : "nicht zuzuordnen"})`);
      return { status: 200, body: await view() };
    },
  };
}
