/**
 * Echte Quellen der Motor-Anzeige (Issue #126) für src/bot.ts: Standard und
 * Ausnahmen aus src/lib/engine-choice.ts, Verfügbarkeit aus inspectEngine
 * (Claude Code wird dabei wirklich geprüft), Session-Schlüssel wie beim
 * Schreiben (conversationSessionKey). Wie bot-settings.ts bindet nur
 * src/bot.ts diese Datei ein; Tests reichen Attrappen für die Prüfung herein.
 *
 * Änderungen erkennt ein leiser Abgleich alle ENGINE_WATCH_MS: gelesen wird
 * über getSettings (neu nur bei geänderter Datei) und TYBO_ENGINE, so zählen
 * /motor aus jedem Kanal, die Einstellungsseite und Änderungen von Hand.
 */

import { inspectEngine, type EngineId, type EngineStatus } from "../lib/engines";
import { defaultEngineSetting, engineLabel, resetEngineNotice, SELECTABLE_ENGINES, type EngineChoiceDeps } from "../lib/engine-choice";
import { getSettings, updateSettings } from "../lib/settings";
import { conversationSessionKey, type TelegramChatDeps } from "./bot-turn";
import type { EngineAvailability, EnginePort } from "./engines";

/** So oft wird auf geänderte Motor-Einstellungen geprüft */
export const ENGINE_WATCH_MS = 2_000;

export interface BotEnginesDeps extends Pick<TelegramChatDeps, "userId" | "groupId" | "agentForTopic"> {
  inspect?: (id: EngineId) => Promise<EngineStatus>;
  choice?: Partial<Pick<EngineChoiceDeps, "getSettings" | "env">>;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function toAvailability(status: EngineStatus): EngineAvailability {
  return {
    engine: status.engine,
    label: engineLabel(status.engine),
    installed: status.installed,
    loggedIn: status.loginUnknown ? null : status.loggedIn,
    ...(status.version ? { version: status.version } : {}),
    ...(status.message ? { message: status.message } : {}),
  };
}

export function createBotEngines(deps: BotEnginesDeps): EnginePort {
  const inspect = deps.inspect ?? inspectEngine;
  const choice = deps.choice ?? {};
  const readSettings = choice.getSettings ?? getSettings;
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopEvery = deps.clearInterval ?? (h => clearInterval(h as ReturnType<typeof setInterval>));
  const standard = () => defaultEngineSetting(choice);
  const overrides = (): Record<string, string> => ({ ...(readSettings().engine?.topics ?? {}) });

  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let last = "";
  const snapshot = () => JSON.stringify({ standard: standard(), overrides: overrides() });
  const tick = () => {
    let now: string;
    try {
      now = snapshot();
    } catch {
      return;
    }
    if (now === last) return;
    last = now;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Ein Zuhörer hält die übrigen nicht auf
      }
    }
  };

  return {
    engines: SELECTABLE_ENGINES.map(id => ({ id, label: engineLabel(id) })),
    standard,
    overrides,
    sessionKey: id => conversationSessionKey(id, deps),
    async availability() {
      return Promise.all(
        SELECTABLE_ENGINES.map(async id => {
          try {
            return toAvailability(await inspect(id));
          } catch {
            return { engine: id, label: engineLabel(id), installed: false, loggedIn: false, message: `${engineLabel(id)} ließ sich nicht prüfen` };
          }
        })
      );
    },
    async removeOverride(sessionKey) {
      // Prüfen und Schreiben am frischen Dateistand, in derselben Kette wie
      // /motor und PATCH /api/settings (updateSettings); nur dieser eine Eintrag
      let removed = false;
      await updateSettings(current => {
        const topics = { ...(current.engine?.topics ?? {}) };
        if (!Object.hasOwn(topics, sessionKey)) return current;
        removed = true;
        delete topics[sessionKey];
        const section = { ...(current.engine ?? {}) };
        if (Object.keys(topics).length) section.topics = topics;
        else delete section.topics;
        const next = { ...current };
        if (Object.keys(section).length) next.engine = section;
        else delete next.engine;
        return next;
      });
      if (removed) resetEngineNotice(sessionKey);
      return removed;
    },
    subscribe(listener) {
      if (!listeners.size) {
        last = snapshot();
        timer = every(tick, ENGINE_WATCH_MS);
        (timer as { unref?: () => void } | null)?.unref?.();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && timer !== null) {
          stopEvery(timer);
          timer = null;
        }
      };
    },
  };
}
