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
 * M14-05: auch Sperren (einschließlich Ablauf) und gerundete Messwerte. Der
 * asynchrone Abgleich läuft ohne Überlappung; der erste Stand meldet nichts.
 */

import { inspectEngine, type EngineId, type EngineStatus } from "../lib/engines";
import { agentEngineSetting, configuredEngine, defaultEngineSetting, engineLabel, engineModelAndEffort, generalOrder, prepareEnginePreview, previewEngine, previewEngineChoice, resetEngineNotice, SELECTABLE_ENGINES, type EngineChoiceDeps, type EnginePreview } from "../lib/engine-choice";
import { engineAuto, getSettings, updateSettings } from "../lib/settings";
import { noteHandover } from "../lib/session-manager";
import { conversationSessionKey, resolveTelegramTarget, type TelegramChatDeps } from "./bot-turn";
import { cleanEngineMessage, type ConversationEngineChoice, type ConversationEngineStage, type EngineAvailability, type EnginePort, type EngineStageView } from "./engines";
import { engineAutoDeps, syncEngineAuto, type EngineAutoDeps } from "../lib/engine-auto-sync";
import { createEngineChecker, type EngineCheckNowDeps } from "../lib/engine-check-now";
import { expireBlocks, type Stage, type SwitchReady, type SwitchUsage, type SwitchState } from "../lib/engine-switch";
import { engineStageViews } from "../lib/engine-stage-view";

/** So oft wird auf geänderte Motor-Einstellungen geprüft */
export const ENGINE_WATCH_MS = 2_000;

export interface BotEnginesDeps extends Pick<TelegramChatDeps, "userId" | "groupId" | "agentForTopic">, Partial<Omit<EngineAutoDeps, "readSettings">> {
  inspect?: (id: EngineId) => Promise<EngineStatus>;
  measurements?: EngineCheckNowDeps["measurements"];
  forgetCheck?: EngineCheckNowDeps["forgetCheck"];
  claudeSubscription?: EngineCheckNowDeps["claudeSubscription"];
  modelOf?: (stage: Stage) => string | undefined;
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

/** Explizite Projektion: Vorschau-Daten bleiben intern, Prüfmeldungen werden gefiltert. */
function conversationStage(preview: EnginePreview, statuses: Map<EngineId, EngineStatus>): ConversationEngineStage {
  const { answering, role, reason } = preview;
  const ownModel = answering?.engine === "claude" && answering.id.startsWith("claude:");
  const message = reason?.state === "not_ready" && reason.message
    ? cleanEngineMessage({ ...toAvailability(statuses.get(reason.engine) ?? {
      engine: reason.engine, checked: true, installed: false, loggedIn: false,
    }), message: reason.message }) : undefined;
  return {
    engine: answering?.engine ?? null,
    label: answering ? answering.label + (ownModel && answering.model ? ` (${answering.model})` : "") : null,
    ...(answering?.model ? { model: answering.model } : {}),
    role,
    ...((role === "backup" || role === "none") && reason ? { reason: {
      label: reason.label,
      kind: reason.state === "not_ready" ? "not_ready" as const : reason.cause!,
      ...(reason.state === "blocked" ? { until: reason.blockedUntil, resetKnown: reason.resetKnown,
        ...(reason.window ? { window: reason.window } : {}),
        ...(reason.percent !== undefined ? { percent: reason.percent } : {}),
      } : {}),
      ...(message ? { message } : {}),
    } } : {}),
    ...(role === "none" && preview.earliestFree ? { until: preview.earliestFree } : {}),
  };
}

export function createBotEngines(deps: BotEnginesDeps): EnginePort {
  const inspect = deps.inspect ?? inspectEngine;
  const choice = deps.choice ?? {};
  const readSettings = choice.getSettings ?? getSettings;
  const runtime = { ...engineAutoDeps, ...deps, readSettings };
  const check = createEngineChecker({ ...runtime, checkEngine: inspect });
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopEvery = deps.clearInterval ?? (h => clearInterval(h as ReturnType<typeof setInterval>));
  const standard = () => defaultEngineSetting(choice);
  const overrides = (): Record<string, string> => ({ ...(readSettings().engine?.topics ?? {}) });

  const agentEngines = (): Record<string, string> => Object.fromEntries(
    Object.entries(readSettings().agents ?? {}).filter(([, entry]) => entry.engine !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => [name, entry.engine!])
  );
  const timeZone = () => (choice.env ?? (() => process.env))().USER_TIMEZONE || "UTC";
  const resolvedModels = (): Record<string, string | null> => {
    const settings = readSettings();
    return Object.fromEntries(SELECTABLE_ENGINES.map(engine => [engine,
      (deps.modelOf ? deps.modelOf({ engine }) : engineModelAndEffort(engine, "general", { getSettings: () => settings }).model) ?? null,
    ]));
  };

  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let last: string | undefined;
  let generation = 0;
  const snapshot = (usage: SwitchUsage, now: number) => {
    const settings = readSettings();
    const order = generalOrder({ ...choice, getSettings: () => settings }).map(stage => ({ ...stage,
      model: stage.model ?? (deps.modelOf ? deps.modelOf(stage) : engineModelAndEffort(stage.engine, "general", { getSettings: () => settings }).model),
    }));
    return JSON.stringify({ standard: standard(), overrides: overrides(), agentEngines: agentEngines(), order, resolvedModels: resolvedModels(), timeZone: timeZone(), auto: engineAuto(settings),
      blocks: expireBlocks(runtime.readState(), now).blocks,
      // Messzeit und Quelle ändern die Revision beim GET, aber lösen kein Live-Ereignis aus.
      usage: SELECTABLE_ENGINES.map(engine => [engine, usage[engine].map(window => ({
        id: window.id, state: window.state, resetsAt: window.resetsAt,
        ...(window.state === "known" ? { percent: Math.round(window.percent) } : {}),
      }))]),
    });
  };
  let checking: Promise<void> | undefined;
  const tick = (): Promise<void> => {
    if (checking) return checking;
    if (!listeners.size) return Promise.resolve();
    const activeGeneration = generation;
    checking = (async () => {
      try {
        const now = runtime.now();
        const usage = await runtime.readUsage(now);
        await syncEngineAuto({ ...runtime, now: () => now, readUsage: async () => usage });
        const current = snapshot(usage, now);
        if (!listeners.size || activeGeneration !== generation) return;
        const changed = last !== undefined && current !== last;
        last = current;
        if (!changed) return;
        for (const listener of [...listeners]) {
          try { listener(); } catch { /* Ein Zuhörer hält die übrigen nicht auf. */ }
        }
      } catch {
        // Beim nächsten Takt erneut versuchen, ohne Fehlereignis.
      }
    })().finally(() => { checking = undefined; });
    return checking;
  };

  return {
    noteHandover: sessionKey => noteHandover(sessionKey, "user"),
    engines: SELECTABLE_ENGINES.map(id => ({ id, label: engineLabel(id) })),
    standard,
    resolvedModels,
    timeZone,
    overrides,
    agentEngines,
    sessionKey: id => conversationSessionKey(id, deps),
    conversationSnapshot(conversations) {
      const settings = readSettings();
      const env = (choice.env ?? (() => process.env))();
      const fixed = { ...choice, getSettings: () => settings, env: () => env };
      const now = runtime.now();
      // Memoisieren auch während der Prüfung, nicht erst nach ihrem Abschluss.
      const checked = new Map<EngineId, Promise<EngineStatus>>();
      const statuses = new Map<EngineId, EngineStatus>();
      let usage: ReturnType<EngineChoiceDeps["readUsage"]> | undefined;
      let state: SwitchState | undefined;
      const previewDeps: Partial<EngineChoiceDeps> = { ...fixed, now: () => now,
        readUsage: () => usage ??= runtime.readUsage(now).then(value => ({
          claude: [...value.claude], codex: [...value.codex], opencode: [...value.opencode], api: [...value.api],
        })),
        readSwitchState: () => state ??= structuredClone(runtime.readState()),
        checkEngine(id) {
          if (!checked.has(id)) checked.set(id, Promise.resolve().then(() => inspect(id)).then(status => {
            statuses.set(id, status);
            return status;
          }));
          return checked.get(id)!;
        },
      };
      const targets = conversations.map(c => {
        const telegram = resolveTelegramTarget(c.id, deps);
        return { id: c.id, key: telegram?.sessionKey ?? conversationSessionKey(c.id, deps), agent: telegram?.agent ?? c.agent };
      });
      const base = defaultEngineSetting(fixed, true).engine;
      const previews = prepareEnginePreview(previewDeps).then(snapshot => Promise.all(targets.map(async c => ({ ...c, snapshot,
        preview: c.key ? await previewEngine(c.key, c.agent, previewDeps, snapshot) : undefined,
      }))));
      return { default: base, timeZone: env.USER_TIMEZONE || "UTC",
        engines: Object.fromEntries(targets.map(c => [c.id, c.key ? configuredEngine(c.key, c.agent, fixed, true).engine : agentEngineSetting(c.agent, fixed, true).engine])),
        stages: previews.then(entries => Object.fromEntries(entries.filter(c => c.preview)
          .map(c => [c.id, conversationStage(c.preview!, statuses)]))),
        choices: previews.then(entries => Object.fromEntries(entries.filter(c => c.preview).map(c => [c.id,
          SELECTABLE_ENGINES.map((engine): ConversationEngineChoice => {
            const view = previewEngineChoice({ engine }, c.agent, c.snapshot, c.preview!.answering);
            const base = { engine, label: engineLabel(engine), ...(view.model ? { model: view.model } : {}) };
            if (view.state === "blocked") return { ...base, state: view.state, blockedUntil: view.blockedUntil,
              cause: view.cause, resetKnown: view.resetKnown, ...(view.window ? { window: view.window } : {}) };
            if (view.state === "not_ready") {
              const status = toAvailability(statuses.get(engine) ?? { engine, checked: true, installed: false, loggedIn: false });
              const message = cleanEngineMessage(status);
              return { ...base, state: view.state, installed: status.installed, ...(message ? { message } : {}) };
            }
            return { ...base, state: view.state };
          }),
        ]))),
      };
    },
    check,
    async switchStatus(availability) {
      const now = runtime.now();
      const usage = await runtime.readUsage(now);
      const state = runtime.readState();
      const settings = readSettings();
      const order = generalOrder({ ...choice, getSettings: () => settings });
      const modelOf = deps.modelOf ?? (stage => stage.model ?? engineModelAndEffort(stage.engine, "general", { getSettings: () => settings }).model);
      const ready = Object.fromEntries(SELECTABLE_ENGINES.map(id => {
        const status = availability.find(entry => entry.engine === id);
        return [id, { ready: status?.installed === true && status.loggedIn === true }];
      })) as unknown as SwitchReady;
      const stages: EngineStageView[] = engineStageViews(order, modelOf, state, ready, now).stages
        .map(({ percent: _percent, message: _message, ...stage }) => ({ ...stage, model: stage.model ?? null, label: engineLabel(stage.engine) }));
      return { order: stages, auto: engineAuto(settings), usage, blocks: expireBlocks(state, now).blocks };
    },
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
      const first = !listeners.size;
      listeners.add(listener);
      if (first) {
        generation++;
        last = undefined;
        void tick();
        timer = every(tick, ENGINE_WATCH_MS);
        (timer as { unref?: () => void } | null)?.unref?.();
      }
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
