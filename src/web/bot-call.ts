/**
 * Echte Abhängigkeiten des Telefonhörers (Issue #257) für src/bot.ts: Modellweg
 * (src/lib/voice-brain), Erkenner und Stimme (src/lib/speech, nur lokale
 * Anbieter über callChoice), Kontext des Gesprächs, Tagesbudget „voice“ und
 * Neustart. Wie bot-speech.ts bindet nur src/bot.ts diese Datei ein; der
 * Web-Server bekommt nur den CallPort (./call-protocol.ts).
 *
 * - open(): Modellweg auflösen (kein stilles Ausweichen), Erkenner wählen,
 *   Chat-ID und Topic bestimmen, Kontext laden (Agent-Prompt, Profil,
 *   Memory, letzte Nachrichten genau dieses Gesprächs) samt Sprechstil
 *   „call“, dann gleichzeitig: Erkenner laden (warm), Stimme vorwärmen und
 *   bei der CLI die offene Sitzung starten (prepare). Scheitert etwas oder
 *   wird abgebrochen, ist alles schon Geöffnete wieder zu.
 * - Budget: jeder Abruf reserviert CALL_REQUEST_RESERVATION_USD (Standard
 *   0,05 USD, wie in der Brücke wird die ganze Reservierung verbucht) im
 *   Tagesbudget „voice“; ist es erschöpft, geht keine Anfrage hinaus.
 * - Neustart: restartPending() ist wahr, sobald data/restart-requested liegt
 *   (alle 2 s geprüft, solange ein Gespräch offen ist) oder die Annahme
 *   gesperrt ist. Nur laufende Turns zählen als Verarbeitung
 *   (activeCallTurnCount, in bot.ts im busyCount). Bei gesperrter Annahme
 *   gibt turnBegin null zurück: kein neuer Modellabruf. farewellAll() lässt
 *   jedes offene Gespräch den Abschied sprechen und auflegen; die
 *   Neustart-Steuerung wartet darauf vor shutdown (höchstens
 *   CALL_FAREWELL_TIMEOUT_MS).
 * - Ton: PCM16 LE mono in CALL_SAMPLE_RATE (24 kHz). Pocket und ElevenLabs
 *   liefern das gestreamt; Piper als WAV am Stück, umgerechnet. Keine
 *   WAV-Kennzeichnung: der Strom wird nicht gespeichert (src/lib/speech/pcm.ts).
 * - ElevenLabs (Issue #276): Stimme und Modell aus speech.call, beim Öffnen
 *   vorgewärmt (Verbindung und Name der Stimme) zusammen mit Pocket TTS als
 *   Rückfall je Abschnitt (./call-voice.ts). Startet ElevenLabs nicht,
 *   spricht gleich der Rückfall.
 * - ElevenLabs Scribe (Issue #279): erkennt nach speech.call.stt über eine
 *   Realtime-Verbindung je Gespräch (openCallStream, ../lib/speech/scribe.ts),
 *   beim Öffnen aufgebaut. Jedes angenommene Stück der Äußerung geht schon
 *   beim Sprechen hinaus (line.hear), erkannt wird bei utterance_pause bzw.
 *   utterance_end (Zeitlimit CALL_SCRIBE_TIMEOUT_MS). Parakeet ist der
 *   Rückfall je Äußerung (./call-stt.ts) und wird dafür beim Öffnen geladen
 *   und beim Auflegen beendet, wie sonst der lokale Erkenner. Bleibt das
 *   Gespräch bei Parakeet, endet die Verbindung, und kein Ton geht mehr an
 *   ElevenLabs.
 * - Werkzeuge (Issue #259): [SUCHE:] ruft history_search aus der
 *   Built-in-Registry (callBuiltinTool, Ergebnis höchstens 6.000 Zeichen,
 *   Zeitlimit 8 s im Turn), [RECHNE:] rechnet im Turn, [DENKAUFTRAG:] nur,
 *   wenn die Sitzung ihn anbietet (Chat-Kern bereit). Der Sprechstil nennt
 *   nur die Tags, die bereitstehen.
 * - Merk-Tags (Issue #259): Nach jedem Turn geht rawText durch
 *   gateTurnIntents mit der Chat-ID und dem Topic des Gesprächs und der
 *   Herkunft „Telefonhörer“, wie in der Brücke. Die Suche im eigenen Verlauf
 *   ist kein fremder Inhalt (bekannte, leere Werkzeugliste), die Tags gelten
 *   also direkt; nach einem Denkauftrag-Ergebnis setzt die Sitzung
 *   foreignInput, dann werden sie Vorschläge. Ein unterbrochener Turn bringt
 *   nur bestätigten, gesprochenen Text ohne Tags mit. Nach dem Auflegen
 *   (close) wartet der Anschluss auf laufende Merk-Tags und legt eine
 *   Meldung ab, was gemerkt wurde (display_only im Nachrichtenspeicher,
 *   Quelle „telefonhoerer“): im Verlauf des Gesprächs, nie in Telegram.
 * - Verlauf (Issue #260): Nach jedem Turn merkt sich der Anschluss Äußerung
 *   und gesprochene Antwort für den nächsten getippten Turn im selben
 *   Gespräch (src/lib/call-recap.ts, Schlüssel wie der Chat-Kern). Die
 *   Ablage im Verlauf macht der Web-Server (./call-history.ts); fürs
 *   gemeinsame Gedächtnis gibt es createCallMemory: saveMessage mit
 *   metadata.type "voice_call", metadata.call und channel "call",
 *   Web-Gespräche unter web:<id>, Telegram-Gespräche mit Chat-ID und
 *   Topic, nie nach Telegram.
 * - Logs: Stufen und Dauern, nie Inhalte.
 */

import { getAgentConfigOrGeneral, getUserProfile } from "../agents/base";
import { addCallRecap } from "../lib/call-recap";
import { storeOr } from "../lib/store";
import { sessionKeyFor } from "../lib/store/message-rules";
import { describeApplied, extractIntentTags, gateTurnIntents, type IntentGateDeps, type IntentTarget, type TurnIntentResult } from "../lib/intent-gate";
import { shortStamp } from "../lib/schedule/planner";
import { effectiveTimeZone } from "../lib/when";
import type { ProcessedIntents } from "../lib/memory";
import { reserveBudget, settleBudget } from "../lib/daily-budget";
import { isIntakeClosed } from "../lib/execution-context";
import { getMemoryContext } from "../lib/memory";
import { readRestartRequest } from "../lib/restart-request";
import { getSettings, type Settings } from "../lib/settings";
import { getSpeech, type Speech } from "../lib/speech";
import { callBuiltinTool, getBuiltinTool } from "../lib/tools";
import { pcmToWav } from "../lib/speech/pcm";
import { tagWavAiGenerated } from "../lib/speech/wav";
import { POCKET_DEFAULT_VOICE } from "../lib/speech/pocket";
import { ELEVENLABS_MODEL_LABELS, ELEVENLABS_MODELS } from "../lib/speech/elevenlabs";
import { describeSpeechError, SpeechError, type SttProvider, type TtsProvider, type WarmStt } from "../lib/speech/types";
import { voiceAgentName } from "../lib/voice-agent-name";
import { callWays, createCallBackend, probeCallModel, resolveCallModel, type CallBackendOptions, type CallModelDeps, type CallModelResolution, type CallWay, type ProbeOptions, type ProbeResult } from "../lib/voice-brain/call-model";
import { createVoiceContext, type VoiceContextDeps } from "../lib/voice-brain/context";
import { voiceStyle } from "../lib/voice-brain/style";
import { runVoiceTurn } from "../lib/voice-brain/turn";
import type { BrainBackend } from "../lib/voice-brain/types";
import { conversationSessionKey, resolveTelegramTarget, webChatId, type TelegramChatDeps, type WebSavedMessage } from "./bot-turn";
import type { CallMemoryEntry, CallMemoryPort } from "./call-history";
import { CALL_PROBE_RUNS, summarizeProbe, type CallProbeResult } from "./call-probe";

export { summarizeProbe };
import { CALL_INPUT_RATE, CALL_NOTICE_SOURCE, CALL_SAMPLE_RATE, CallOpenError, type CallLine, type CallModeStatus, type CallPort, type CallRecognition } from "./call-protocol";
import { createCallVoice, providerPcm } from "./call-voice";
import { CALL_SCRIBE_TIMEOUT_MS, createCallRecognizer, type CallSttRunner } from "./call-stt";
import { CALL_SCRIBE_LABEL } from "../lib/speech/chain";
import { CALL_VOICE_PROBE_TEXT, CALL_VOICE_PROBE_TEXT_SPOKEN, type CallVoiceProbeResult } from "./call-probe";
import { parseTelegramConversationId } from "./telegram";
import { beginCallTurn } from "./call-turns";

/** Reservierung je Abruf im Tagesbudget „voice“, wenn CALL_REQUEST_RESERVATION_USD fehlt */
export const CALL_RESERVATION_USD = 0.05;
/** Erkennung je Äußerung höchstens so lange (wie im Sprechmodus) */
export const CALL_STT_TIMEOUT_MS = 30_000;
/** Neustart-Marker so oft prüfen, solange ein Gespräch offen ist */
export const RESTART_MARKER_POLL_MS = 2_000;
/** Status des Modellwegs so lange wiederverwenden (claude --help, Anmeldung) */
const STATUS_CACHE_MS = 15_000;
/** Abschiede beim Neustart höchstens so lange abwarten (ein Satz aus der Stimme) */
export const CALL_FAREWELL_TIMEOUT_MS = 15_000;
const GENERAL_TOPIC = 1;

/** Speichert über den Store (msgId, Ereignis, Embedding); ohne Datenbank false */
const saveMessage = (message: WebSavedMessage) => storeOr(false, store => store.messages.save(message));

export { activeCallTurnCount } from "./call-turns";

export interface BotCallDeps extends Pick<TelegramChatDeps, "userId" | "groupId" | "agentForTopic"> {
  speech?: () => Speech;
  resolve?: () => Promise<CallModelResolution>;
  createBackend?: (resolution: CallModelResolution, options: CallBackendOptions) => BrainBackend;
  /** Kontext ohne Sprechstil für Chat-ID und Topic (Standard: createVoiceContext mit Profil, Memory, letzten Nachrichten) */
  loadContext?: (o: { agent: string; chatId: string; topicId: number | null }) => Promise<string>;
  reserveRequest?: () => (actualUsd?: number) => void;
  readRestart?: () => Promise<string | null>;
  isIntakeClosed?: () => boolean;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  now?: () => number;
  /** Suche im eigenen Verlauf (Standard: history_search über callBuiltinTool); wirft bei Fehler */
  searchHistory?: (query: string) => Promise<string>;
  /** Suche bereit (Standard: history_search verfügbar) */
  searchAvailable?: () => boolean;
  /** Merk-Tags eines Turns (Standard: gateTurnIntents mit leerer Werkzeugliste) */
  processIntents?: (text: string, target: IntentTarget) => Promise<TurnIntentResult>;
  /** Meldung nach dem Auflegen ablegen (Standard: saveMessage, also getStore().messages.save) */
  saveMessage?: (message: WebSavedMessage) => Promise<boolean>;
  /** Kontext für den nächsten getippten Turn (Standard: addCallRecap aus src/lib/call-recap.ts) */
  addRecap?: typeof addCallRecap;
  /** Wege zur Auswahl (Standard: callWays aus src/lib/voice-brain/call-model.ts) */
  ways?: () => Promise<CallWay[]>;
  /** Probe über den eingestellten Weg (Standard: probeCallModel) */
  runProbe?: (options: ProbeOptions) => Promise<ProbeResult>;
  /** Wirksame Einstellungen (Standard: getSettings); speech.call bindet den Statuscache */
  settings?: () => Settings;
  /** Prüfungen für den Standard von resolve und ways (Tests: Claude Code, Ollama als Attrappe) */
  callModel?: Pick<CallModelDeps, "inspectClaude" | "cliFlags" | "ollamaCheck">;
}

/** channel der Nachrichten aus dem Telefonhörer im Nachrichtenspeicher (nicht "web": der Live-Feed zeigt sie) */
export const CALL_CHANNEL = "call";
/** metadata.type der Äußerungen und Antworten im Gedächtnis, wie bei der Sprach-Brücke */
export const CALL_MESSAGE_TYPE = "voice_call";

/** Chat-ID und Topic eines Gesprächs im Nachrichtenspeicher; null, wenn das Telegram-Gespräch nicht erreichbar ist */
export function callTarget(
  conversationId: string,
  deps: Pick<TelegramChatDeps, "userId" | "groupId" | "agentForTopic">
): { chatId: string; topicId: number | null } | null {
  const ref = parseTelegramConversationId(conversationId);
  if (!ref) return { chatId: webChatId(conversationId), topicId: null };
  const t = resolveTelegramTarget(conversationId, deps);
  if (!t) return null;
  return { chatId: t.chatId, topicId: ref.kind === "topic" && ref.topicId !== GENERAL_TOPIC ? ref.topicId : null };
}

/**
 * Gedächtnis für den Verlauf des Telefonhörers (Issue #260): wie die
 * Nachrichten eines Web-Turns über saveMessage (Embedding, history_search,
 * semantische Suche), markiert mit metadata.type "voice_call" und
 * metadata.call. Telegram-Gespräche mit topicId; nichts geht nach Telegram. notice legt eine Meldung als
 * Nur-Anzeige-Eintrag ab (Quelle telefonhoerer).
 */
export function createCallMemory(
  deps: Pick<TelegramChatDeps, "userId" | "groupId" | "agentForTopic"> & { saveMessage?: (message: WebSavedMessage) => Promise<boolean> }
): CallMemoryPort {
  const save = deps.saveMessage ?? saveMessage;
  return {
    async save(conversationId: string, entry: CallMemoryEntry) {
      const where = callTarget(conversationId, deps);
      if (!where) return false;
      const topic = parseTelegramConversationId(conversationId) ? { topicId: where.topicId } : {};
      return save({
        chat_id: where.chatId,
        role: entry.role,
        content: entry.text,
        created_at: entry.at,
        metadata: {
          ...topic,
          // Wie die Sprach-Brücke (src/voice-bridge.ts): Art der Nachricht fürs Gedächtnis
          type: CALL_MESSAGE_TYPE,
          channel: CALL_CHANNEL,
          call: true,
          agent: entry.agent,
          ...(entry.role === "assistant" && entry.model ? { model: entry.model } : {}),
        },
      });
    },
    async notice(conversationId: string, o: { text: string; at: string }) {
      const where = callTarget(conversationId, deps);
      if (!where) return false;
      return save({
        chat_id: where.chatId,
        role: "assistant",
        content: o.text,
        created_at: o.at,
        metadata: { display_only: true, source: CALL_NOTICE_SOURCE, ...(where.topicId !== null ? { topicId: where.topicId } : {}) },
      });
    },
  };
}

/** Merk-Tags im Gespräch durch das Tor: Suche im eigenen Verlauf ist kein fremder Inhalt */
export function callIntents(gateDeps?: Partial<IntentGateDeps>) {
  return (text: string, target: IntentTarget): Promise<TurnIntentResult> => gateTurnIntents(text, { uses: [] }, target, gateDeps);
}

/**
 * Meldung nach dem Telefonat (Issue #259): was gemerkt wurde, Zeile für
 * Zeile, damit der Nutzer Verhörer korrigieren kann; dazu die Zahl der
 * Vorschläge. null, wenn nichts gemerkt und nichts vorgeschlagen wurde.
 */
export function callMemoryNotice(applied: ProcessedIntents[], staged: number): string | null {
  const sum: Required<Omit<ProcessedIntents, "asked" | "remindersAdded" | "goalsFailed" | "goalChangesFailed" | "factsRefused">> = { goalsAdded: [], goalsCompleted: [], goalsCancelled: [], factsAdded: [], factsRemoved: [], knowledgeAdded: [] };
  for (const p of applied) for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k].push(...(p[k] ?? []));
  // Erinnerungen aus [REMIND:] (Issue #322), mit Zeitpunkt in USER_TIMEZONE
  const reminders = applied.flatMap(p => p.remindersAdded ?? []);
  const lines = [
    ...sum.factsAdded.map(t => `- Gemerkt: ${t}`),
    ...sum.goalsAdded.map(t => `- Neues Ziel: ${t}`),
    ...sum.goalsCompleted.map(t => `- Ziel erledigt: ${t}`),
    ...sum.goalsCancelled.map(t => `- Ziel gestrichen: ${t}`),
    ...sum.factsRemoved.map(t => `- Vergessen: ${t}`),
    ...sum.knowledgeAdded.map(t => `- Wissen gespeichert: ${t}`),
    ...reminders.map(r => `- Erinnerung: ${r.text} (${shortStamp(Date.parse(r.dueAt), effectiveTimeZone())})`),
  ];
  if (!lines.length && !staged) return null;
  // Markdown im Verlauf: Absätze mit Leerzeile, die Liste Zeile für Zeile
  const parts = ["Aus dem Telefonat:"];
  if (lines.length) {
    parts.push(describeApplied({ ...sum, remindersAdded: reminders }), lines.join("\n"), "Die Spracherkennung kann sich verhören. Stimmt etwas nicht, schreib einfach, was korrigiert werden soll.");
  }
  if (staged) parts.push(staged === 1 ? "Ein Merk-Vorschlag wartet auf deine Entscheidung." : `${staged} Merk-Vorschläge warten auf deine Entscheidung.`);
  return parts.join("\n\n");
}

const realSearchAvailable = () => !!getBuiltinTool("history_search")?.isAvailable();

async function realSearchHistory(query: string): Promise<string> {
  const result = await callBuiltinTool("history_search", { query });
  if (result.isError) throw new Error("history_search fehlgeschlagen");
  return result.content;
}

function reservationAmount(env: Record<string, string | undefined>): number {
  const v = Number(env.CALL_REQUEST_RESERVATION_USD);
  return Number.isFinite(v) && v > 0 ? v : CALL_RESERVATION_USD;
}

const realContextDeps: VoiceContextDeps = {
  getUserProfile,
  getMemoryContext: () => getMemoryContext(),
  // Immer nach Gespräch getrennt (null: Direktchat, General bzw. Web-Gespräch), nie der ganze Chat
  getRecentMessages: (chatId, limit, topicId) => storeOr([], store => store.messages.recent(chatId, limit, topicId ?? null)),
  timeZone: process.env.USER_TIMEZONE,
};

async function realLoadContext(o: { agent: string; chatId: string; topicId: number | null }): Promise<string> {
  const config = getAgentConfigOrGeneral(o.agent);
  const context = createVoiceContext({ agent: { systemPrompt: config?.systemPrompt ?? "" }, deps: realContextDeps });
  return context.load(o.chatId, o.topicId);
}

function settleOnce(id: string): (actualUsd?: number) => void {
  let done = false;
  return (actualUsd?: number) => {
    if (done) return;
    done = true;
    settleBudget(id, actualUsd);
  };
}

/**
 * Stimme für GET /api/voice (modes.call.tts, Issue #276): die tatsächlich
 * sprechende Stimme mit where und stream, dazu Einstellung, Grund, Rückfall,
 * bei ElevenLabs Stimme, Name (sobald bekannt) und Modell, und die Auswahl.
 */
export function callTtsStatus(sp: Speech, choice: ReturnType<Speech["callChoice"]>, env: Record<string, string | undefined>): CallModeStatus["tts"] {
  const t = choice.tts;
  const call = choice.ttsOptions;
  const base: CallModeStatus["tts"] = t ? { id: t.id, where: "server", stream: !!t.synthesizeStream } : { id: "browser", where: "browser", stream: false };
  const name = t && call ? t.voiceName?.(call.voice) : null;
  const fallbackName = t?.id === "elevenlabs" ? choice.ttsFallback?.voiceName?.(env.POCKET_TTS_VOICE || POCKET_DEFAULT_VOICE) : null;
  return {
    ...base,
    setting: choice.ttsSetting,
    ...(choice.ttsReason ? { reason: choice.ttsReason } : {}),
    ...(t?.id === "elevenlabs" ? { fallback: choice.ttsFallback?.id ?? "browser" } : {}),
    ...(call ? { voice: call.voice, model: call.model } : {}),
    ...(name ? { voiceName: name } : {}),
    ...(fallbackName ? { fallbackName } : {}),
    options: sp.callTtsOptions(),
    models: ELEVENLABS_MODELS.map(id => ({ id, label: ELEVENLABS_MODEL_LABELS[id] })),
  };
}

/**
 * Erkenner für GET /api/voice (modes.call.stt, Issue #279): der tatsächlich
 * erkennende samt warm (Cloud-Erkennung zählt als warm), dazu Einstellung,
 * Grund, Rückfall (nur bei ElevenLabs Scribe) und die Auswahl.
 */
export function callSttStatus(sp: Speech, choice: ReturnType<Speech["callChoice"]>): CallModeStatus["stt"] {
  const stt = choice.stt;
  const warm = !!stt && (!stt.local || !!stt.canWarm?.());
  const reason = choice.sttNote ?? (stt ? undefined : choice.sttReason);
  return {
    id: stt?.id ?? null,
    local: stt?.local ?? false,
    warm,
    setting: choice.sttSetting,
    ...(reason ? { reason } : {}),
    ...(stt?.id === "elevenlabs" ? { fallback: choice.sttFallback?.id ?? null } : {}),
    options: sp.callSttOptions(),
  };
}

export interface BotCallPort extends CallPort {
  /** Alle offenen Gespräche verabschieden sich und legen auf (vor shutdown) */
  farewellAll(timeoutMs?: number): Promise<void>;
}

export function createBotCall(deps: BotCallDeps): BotCallPort {
  const speech = deps.speech ?? getSpeech;
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(`[Telefonhörer] ${line}`));
  const now = deps.now ?? Date.now;
  const currentSettings = deps.settings ?? getSettings;
  const resolve = deps.resolve ?? (() => resolveCallModel({ ...deps.callModel, env, settings: currentSettings() }));
  const readRestart = deps.readRestart ?? (() => readRestartRequest());
  const intakeClosed = deps.isIntakeClosed ?? isIntakeClosed;
  const reserveRequest =
    deps.reserveRequest ??
    (() => {
      const id = reserveBudget("voice", reservationAmount(env));
      return settleOnce(id);
    });

  let marker = false;
  const farewells = new Set<() => Promise<void>>();
  let poll: ReturnType<typeof setInterval> | null = null;
  let openLines = 0;
  const refreshMarker = async () => {
    try {
      marker = (await readRestart()) !== null;
    } catch {
      marker = false;
    }
  };
  const lineOpened = () => {
    openLines++;
    if (!poll) {
      poll = setInterval(() => void refreshMarker(), RESTART_MARKER_POLL_MS);
      (poll as { unref?: () => void }).unref?.();
    }
  };
  const lineClosed = () => {
    openLines = Math.max(0, openLines - 1);
    if (!openLines && poll) {
      clearInterval(poll);
      poll = null;
    }
  };

  // Der Cache gilt nur für die Einstellung, mit der er entstand: nach dem
  // Speichern von speech.call stimmen Weg, Bereitschaft, Erwartung und Abrechnung sofort
  const callKey = () => JSON.stringify(currentSettings().speech?.call ?? null);
  const fresh = (c: { at: number; key: string } | null, key: string) => !!c && c.key === key && now() - c.at < STATUS_CACHE_MS;
  let statusCache: { at: number; key: string; value: CallModelResolution } | null = null;
  async function resolution(): Promise<CallModelResolution> {
    const key = callKey();
    if (statusCache && fresh(statusCache, key)) return statusCache.value;
    const value = await resolve();
    statusCache = { at: now(), key, value };
    return value;
  }
  let waysCache: { at: number; key: string; value: CallWay[] } | null = null;
  async function ways(): Promise<CallWay[]> {
    const key = callKey();
    if (waysCache && fresh(waysCache, key)) return waysCache.value;
    let value: CallWay[] = [];
    try {
      value = await (deps.ways ?? (() => callWays({ ...deps.callModel, env, settings: currentSettings() })))();
    } catch (e) {
      log(`Wege nicht prüfbar (${e instanceof Error ? e.name : typeof e})`);
    }
    waysCache = { at: now(), key, value };
    return value;
  }

  /** Chat-ID und Topic des Gesprächs für Kontext und /stop */
  const target = (conversationId: string) => callTarget(conversationId, deps);
  const addRecap = deps.addRecap ?? addCallRecap;

  return {
    async status(): Promise<CallModeStatus> {
      const r = await resolution();
      const sp = speech();
      const choice = sp.callChoice();
      const stt = choice.stt;
      const sttStatus = callSttStatus(sp, choice);
      const warm = sttStatus.warm;
      const reasons = [stt ? null : choice.sttReason ?? "Hören: kein lokaler Erkenner", r.ready ? null : r.reason ?? "Kein Modellweg bereit"].filter(Boolean);
      const ready = !!stt && r.ready;
      const slower = stt && !warm ? " Die Spracherkennung startet je Äußerung neu, das ist langsamer." : "";
      const list = await ways();
      return {
        ready,
        ...(ready ? {} : { reason: reasons.join("; ") }),
        model: r.model,
        via: r.via,
        expectation: `${r.expectation}${slower}`,
        stt: sttStatus,
        tts: callTtsStatus(sp, choice, env),
        billing: r.billing,
        setting: r.setting,
        settingSource: r.source,
        ...(r.claudeVia ? { claudeVia: r.claudeVia } : {}),
        ways: list.map(w => ({
          id: w.id,
          model: w.model,
          ...(w.claudeVia ? { claudeVia: w.claudeVia } : {}),
          label: w.label,
          ready: w.ready,
          ...(w.reason ? { reason: w.reason } : {}),
          expectation: w.expectation,
          billing: w.billing,
        })),
        probe: true,
        voiceProbe: true,
      };
    },

    async voiceProbe(o: { signal?: AbortSignal } = {}): Promise<CallVoiceProbeResult> {
      // Genau die Stimme des Telefonhörers, ohne Rückfall und ohne speech.tts zu ändern
      const sp = speech();
      const choice = sp.callChoice();
      const t = choice.tts;
      // Ausdrücklich gewählt, aber nicht verfügbar: Fehler statt der Ersatzstimme, die callChoice schon gewählt hat
      const setting = choice.ttsSetting;
      if (setting !== "auto" && setting !== "browser" && t?.id !== setting) {
        const option = sp.callTtsOptions().find(x => x.id === setting);
        const label = option?.label ?? setting;
        log(`Hörprobe ${setting}: nicht verfügbar`);
        return { ok: false, reason: `${label} ist nicht verfügbar${option?.reason ? ` (${option.reason})` : ""}.` };
      }
      if (!t) return { ok: false, reason: choice.ttsReason ? `${choice.ttsReason}.` : CALL_VOICE_PROBE_TEXT.browser };
      const language = sp.choice().language.value;
      const signal = o.signal ?? new AbortController().signal;
      const opts = {
        signal,
        ...(language === "auto" ? {} : { language }),
        ...(t.id === "elevenlabs" && choice.ttsOptions ? { voice: choice.ttsOptions.voice, model: choice.ttsOptions.model } : {}),
      };
      const p0 = now();
      let firstMs: number | null = null;
      const parts: Uint8Array[] = [];
      try {
        for await (const chunk of providerPcm(t, CALL_VOICE_PROBE_TEXT_SPOKEN, opts)) {
          if (firstMs === null && chunk.length) firstMs = now() - p0;
          parts.push(chunk);
        }
        if (signal.aborted) return { ok: false, reason: CALL_VOICE_PROBE_TEXT.timeout };
        const pcm = Buffer.concat(parts);
        if (!pcm.length || firstMs === null) return { ok: false, reason: `${t.label}: kein Ton.` };
        log(`Hörprobe ${t.id}: erster Ton nach ${firstMs} ms, ${now() - p0} ms`);
        return { ok: true, audio: tagWavAiGenerated(pcmToWav(pcm, CALL_SAMPLE_RATE)), provider: t.id, firstMs };
      } catch (e) {
        log(`Hörprobe ${t.id}: Fehler (${describeSpeechError(e)}), ${now() - p0} ms`);
        if (signal.aborted) return { ok: false, reason: CALL_VOICE_PROBE_TEXT.timeout };
        return { ok: false, reason: `${t.label}: ${describeSpeechError(e)}.` };
      }
    },

    async probe(o: { signal?: AbortSignal } = {}): Promise<CallProbeResult> {
      // Frisch auflösen: die Einstellung kann sich eben geändert haben
      statusCache = null;
      waysCache = null;
      let r: CallModelResolution;
      try {
        r = await resolution();
      } catch {
        return { ok: false, reason: "Der Weg ließ sich nicht prüfen." };
      }
      if (!r.ready) return { ok: false, reason: r.reason ?? "Kein Weg für den Telefonhörer bereit" };
      const p0 = now();
      try {
        const result = await (deps.runProbe ?? probeCallModel)({
          resolution: r,
          runs: CALL_PROBE_RUNS,
          backendOptions: { reserveRequest, agentName: voiceAgentName(), env },
          ...(o.signal ? { signal: o.signal } : {}),
        });
        const summary = summarizeProbe(result);
        log(`Probe ${r.via}: ${summary.ok ? `Median ${Math.round(summary.medianMs)} ms` : "ohne Messwert"}, ${now() - p0} ms`);
        return summary;
      } catch (e) {
        if (o.signal?.aborted) {
          log(`Probe abgebrochen nach ${now() - p0} ms`);
          return { ok: false, reason: "Die Probe wurde abgebrochen." };
        }
        log(`Probe gescheitert (${e instanceof Error ? e.name : typeof e})`);
        if (e instanceof Error && e.name === "BrainError") return { ok: false, reason: e.message };
        return { ok: false, reason: "Die Probe ist gescheitert." };
      }
    },

    restartPending: () => marker || intakeClosed(),

    turnBegin() {
      // Prüfen und zählen ohne await dazwischen: nach der Sperre beginnt kein Turn mehr
      if (intakeClosed()) return null;
      return beginCallTurn();
    },

    onRestart(farewell) {
      farewells.add(farewell);
      return () => {
        farewells.delete(farewell);
      };
    },

    async farewellAll(timeoutMs = CALL_FAREWELL_TIMEOUT_MS) {
      if (!farewells.size) return;
      log(`Neustart: ${farewells.size} Gespräch(e) verabschieden sich`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>(resolve => {
        timer = setTimeout(() => {
          log("Neustart: Abschied dauert zu lange, weiter");
          resolve();
        }, timeoutMs);
      });
      const all = Promise.allSettled([...farewells].map(f => f())).then(() => {});
      await Promise.race([all, timeout]);
      clearTimeout(timer);
    },

    async open({ conversationId, agent, tts: wanted, signal, deepTask = false }): Promise<CallLine> {
      const t0 = now();
      await refreshMarker();
      if (marker || intakeClosed()) throw new CallOpenError("neustart", "tybo startet gerade neu, bitte gleich noch einmal anrufen.");
      statusCache = null;
      const r = await resolution();
      if (!r.ready || !r.via || !r.model) throw new CallOpenError("nicht-bereit", r.reason ?? "Kein Weg für den Telefonhörer bereit");
      const sp = speech();
      const choice = sp.callChoice();
      const stt: SttProvider | null = choice.stt;
      if (!stt) throw new CallOpenError("kein-erkenner", choice.sttReason ?? "Kein lokaler Erkenner eingerichtet");
      // ElevenLabs Scribe (Issue #279): Parakeet als Rückfall je Äußerung; geladen wird der lokale Erkenner bzw. dieser Rückfall
      const cloudStt = !stt.local && !!stt.openCallStream;
      const sttFallback: SttProvider | null = cloudStt ? (choice.sttFallback ?? null) : null;
      const warmTarget: SttProvider | null = cloudStt ? sttFallback : stt;
      const where = target(conversationId);
      if (!where) throw new CallOpenError("gespraech", "Das Telegram-Gespräch ist nicht erreichbar");
      const language = sp.choice().language.value;
      const langOpt = language === "auto" ? {} : { language };
      let tts: TtsProvider | null = wanted === "server" ? choice.tts : null;
      // ElevenLabs (Issue #276): Stimme und Modell aus speech.call, Pocket TTS als Rückfall je Abschnitt
      const eleven = tts?.id === "elevenlabs" && choice.ttsOptions ? choice.ttsOptions : null;
      let fallbackTts: TtsProvider | null = eleven ? (choice.ttsFallback ?? null) : null;
      const pocketVoice = env.POCKET_TTS_VOICE || POCKET_DEFAULT_VOICE;
      const searchReady = (deps.searchAvailable ?? realSearchAvailable)();
      const intents = deps.processIntents ?? callIntents();
      const save = deps.saveMessage ?? saveMessage;
      const searchHistory = deps.searchHistory ?? realSearchHistory;
      const search = async (query: string): Promise<string> => {
        const s0 = now();
        try {
          const text = await searchHistory(query);
          log(`Suche im Verlauf: ok, ${now() - s0} ms`);
          return text;
        } catch (e) {
          log(`Suche im Verlauf: Fehler (${e instanceof Error ? e.name : typeof e}), ${now() - s0} ms`);
          throw e;
        }
      };

      const backend = (deps.createBackend ?? createCallBackend)(r, {
        abortKey: conversationSessionKey(conversationId, deps) ?? undefined,
        reserveRequest,
        agentName: voiceAgentName(),
        env,
      });
      let warm: WarmStt | null = null;
      // Realtime-Verbindung zu Scribe, schon jetzt aufgebaut (warm)
      const scribe = cloudStt ? stt.openCallStream!(langOpt) : null;
      scribe?.warm();
      let closed = false;
      const closeAll = () => {
        if (closed) return;
        closed = true;
        warm?.close();
        warm = null;
        scribe?.close();
        backend.close?.();
      };
      const onAbort = () => closeAll();
      signal.addEventListener("abort", onAbort, { once: true });
      let system: string;
      try {
        const contextP = (deps.loadContext ?? realLoadContext)({ agent, ...where }).then(text => [text, voiceStyle({ agentName: voiceAgentName(), channel: "call", tools: { search: searchReady, deepTask } })].join("\n\n"));
        const warmP =
          warmTarget?.warm && warmTarget.canWarm?.()
            ? (async () => {
                const w0 = now();
                const what = cloudStt ? "Rückfall-Erkenner" : "Erkenner";
                try {
                  const handle = await warmTarget.warm!();
                  log(`${what} ${warmTarget.id} geladen in ${now() - w0} ms`);
                  return handle;
                } catch (e) {
                  log(`${what} ${warmTarget.id} ließ sich nicht laden (${describeSpeechError(e)}), Erkennung je Äußerung`);
                  return null;
                }
              })()
            : Promise.resolve(null);
        const warmVoice = (p: TtsProvider | null, opts: Record<string, string>, what: string) =>
          p?.warm
            ? (async () => {
                const w0 = now();
                try {
                  await p.warm!({ signal, ...langOpt, ...opts });
                  log(`${what} ${p.id} bereit in ${now() - w0} ms`);
                  return true;
                } catch (e) {
                  log(`${what} ${p.id} ließ sich nicht starten (${describeSpeechError(e)})`);
                  return false;
                }
              })()
            : Promise.resolve(true);
        const ttsP = warmVoice(tts, eleven ? { voice: eleven.voice } : {}, "Stimme");
        const fallbackP = warmVoice(fallbackTts, {}, "Rückfall");
        // Kontext zuerst: die CLI-Sitzung startet mit ihm als System-Prompt
        const prepared = contextP.then(async s => {
          await backend.prepare?.(s);
          return s;
        });
        // Alle drei abwarten: scheitert eins, darf ein noch ladender Erkenner nicht offen bleiben
        const [s, w, ttsOk, fallbackOk] = await Promise.allSettled([prepared, warmP, ttsP, fallbackP]);
        if (w.status === "fulfilled" && w.value) {
          if (closed) w.value.close();
          else warm = w.value;
        }
        if (s.status === "rejected") throw s.reason;
        system = s.value;
        if (fallbackOk.status !== "fulfilled" || !fallbackOk.value) fallbackTts = null;
        if (ttsOk.status !== "fulfilled" || !ttsOk.value) {
          // Stimme nicht startbar: der vorgewärmte Rückfall spricht, sonst der Browser
          tts = fallbackTts;
          fallbackTts = null;
          log(tts ? `Es spricht ${tts.id}` : "Der Browser spricht");
        }
        if (closed || signal.aborted) throw new CallOpenError("abgebrochen", "Abgebrochen");
      } catch (e) {
        signal.removeEventListener("abort", onAbort);
        closeAll();
        if (e instanceof CallOpenError) throw e;
        const name = e instanceof Error ? e.name : typeof e;
        log(`Öffnen gescheitert (${name})`);
        // BrainError setup/ended: der Satz ist ohne Schlüssel und geht an den Browser
        if (e instanceof Error && e.name === "BrainError") throw new CallOpenError("modell", e.message);
        throw new CallOpenError("start", "Der Telefonhörer ließ sich nicht starten.");
      }
      signal.removeEventListener("abort", onAbort);
      lineOpened();
      log(`Gespräch offen nach ${now() - t0} ms (${r.via}, ${r.model})`);

      // Merk-Tags des Gesprächs: laufende Verarbeitung und Ergebnis für die Meldung nach dem Auflegen
      const pendingIntents: Promise<void>[] = [];
      const applied: ProcessedIntents[] = [];
      let staged = 0;
      let reported = false;
      const reportMemory = async () => {
        if (reported) return;
        reported = true;
        await Promise.allSettled(pendingIntents);
        const text = callMemoryNotice(applied, staged);
        if (!text) return;
        try {
          const ok = await save({
            chat_id: where.chatId,
            role: "assistant",
            content: text,
            metadata: { display_only: true, source: CALL_NOTICE_SOURCE, ...(where.topicId !== null ? { topicId: where.topicId } : {}) },
          });
          log(ok ? "Meldung nach dem Telefonat abgelegt" : "Meldung nach dem Telefonat nicht abgelegt");
        } catch (e) {
          log(`Meldung nach dem Telefonat nicht abgelegt (${e instanceof Error ? e.name : typeof e})`);
        }
      };

      /** Lokal erkennen: geladen, sonst je Äußerung als WAV */
      const transcribeLocal = async (p: SttProvider, pcm: Uint8Array, sig: AbortSignal): Promise<string> => {
        const wav = pcmToWav(pcm, CALL_INPUT_RATE);
        if (warm && p === warmTarget) {
          try {
            return await warm.transcribe(wav, "audio/wav", { signal: sig, ...langOpt });
          } catch (e) {
            // Erkennungsprozess weg: ab jetzt je Äußerung, diese Äußerung gleich noch einmal
            if (e instanceof SpeechError && e.kind === "exit" && !sig.aborted) {
              log("Erkennungsprozess beendet, weiter je Äußerung");
              warm.close();
              warm = null;
            } else throw e;
          }
        }
        return p.transcribe(wav, "audio/wav", { signal: sig, ...langOpt });
      };
      const runnerFor = (p: SttProvider): CallSttRunner =>
        scribe && p === stt
          ? { id: p.id, name: CALL_SCRIBE_LABEL, timeoutMs: CALL_SCRIBE_TIMEOUT_MS, run: (_pcm, sig) => scribe.transcribe(sig) }
          : { id: p.id, name: p.label, timeoutMs: CALL_STT_TIMEOUT_MS, logSuffix: () => (warm && p === warmTarget ? " (geladen)" : ""), run: (pcm, sig) => transcribeLocal(p, pcm, sig) };
      // Mit Rückfall nur bei ElevenLabs Scribe (./call-stt.ts); der Zähler gilt für dieses Gespräch
      const recognizer = createCallRecognizer({
        primary: runnerFor(stt),
        ...(cloudStt ? { fallback: sttFallback ? runnerFor(sttFallback) : null } : {}),
        log,
        now,
      });

      // Stimme mit Rückfall je Abschnitt (./call-voice.ts); nur bei ElevenLabs mit Rückfall
      const primary = tts;
      const voice = primary
        ? createCallVoice({
            primary,
            primaryOpts: { ...langOpt, ...(primary.id === "elevenlabs" && eleven ? { voice: eleven.voice, model: eleven.model } : {}) },
            ...(primary.id === "elevenlabs" && eleven
              ? {
                  fallback: {
                    provider: fallbackTts,
                    opts: { ...langOpt },
                    primaryName: () => primary.voiceName?.(eleven.voice) ?? "Die ElevenLabs-Stimme",
                    fallbackName: fallbackTts ? (fallbackTts.voiceName?.(pocketVoice) ?? fallbackTts.label) : "der Browser-Stimme",
                  },
                }
              : {}),
            log,
            now,
          })
        : null;

      const line: CallLine = {
        info: { model: r.model, via: r.via, stt: stt.id, tts: tts ? "server" : "browser", sampleRate: CALL_SAMPLE_RATE, sttWarm: cloudStt || !!warm },
        recognize: (pcm, sig): Promise<CallRecognition> => recognizer.recognize(pcm, sig),
        adopt: r => {
          const notice = recognizer.adopt(r);
          // Gespräch bleibt bei Parakeet: kein Ton mehr an ElevenLabs
          if (recognizer.stuck) scribe?.close();
          return notice;
        },
        ...(scribe
          ? {
              hear: (pcm: Uint8Array) => {
                if (!recognizer.stuck) scribe.push(pcm);
              },
              newUtterance: () => scribe.newUtterance(),
            }
          : {}),
        turn: ({ userText, context, history, signal: sig, deepTask: deepNow }) =>
          runVoiceTurn({
            backend,
            system,
            history,
            userText,
            ...(context ? { context } : {}),
            signal: sig,
            // Denkauftrag nur, wenn er beim Öffnen angeboten wurde (Sprechstil) und die Sitzung ihn jetzt kann
            tools: { ...(searchReady ? { search: (query: string) => search(query) } : {}), deepTask: deepTask && !!deepNow },
          }),
        interrupt: async () => {
          await backend.interrupt?.();
        },
        ...(voice ? { speak: (text: string, sig: AbortSignal) => voice!.speak(text, sig) } : {}),
        onTurn: record => {
          // Kontext für den nächsten getippten Turn (Issue #260): nur Gesprochenes, Schlüssel wie im Chat-Kern
          try {
            const reply = record.spokenText.trim() ? `${record.spokenText.trim()}${record.interrupted ? " (unterbrochen)" : ""}` : "";
            addRecap(sessionKeyFor(where.chatId, where.topicId), { userText: record.userText, replyText: reply, agentLabel: voiceAgentName() });
          } catch (e) {
            log(`Kontext fürs nächste Tippen nicht gemerkt (${e instanceof Error ? e.name : typeof e})`);
          }
          // Merk-Tags (#259)
          if (!extractIntentTags(record.rawText)) return;
          const t: IntentTarget = {
            chatId: where.chatId,
            ...(where.topicId !== null ? { topicId: where.topicId } : {}),
            origin: "Telefonhörer",
            ...(record.foreignInput ? { foreignInput: record.foreignInput } : {}),
          };
          pendingIntents.push(
            intents(record.rawText, t).then(
              r => {
                if (r.outcome === "applied" && r.processed) applied.push(r.processed);
                else if (r.outcome === "staged") staged++;
              },
              e => log(`Merk-Tags nicht verarbeitet (${e instanceof Error ? e.name : typeof e})`)
            )
          );
        },
        close: () => {
          if (closed) return;
          closeAll();
          lineClosed();
          log("Gespräch geschlossen");
          void reportMemory();
        },
      };
      return line;
    },
  };
}
