/**
 * Sprachschicht bei ElevenLabs (Entscheidung 0026): Agent, Token der Brücke und
 * Tests aus einem Rezept. Alles läuft über fetch als Abhängigkeit.
 *
 * Felder laut Doku, abgerufen am 30.10.2026:
 * - Agent: https://elevenlabs.io/docs/api-reference/agents/create und
 *   https://github.com/elevenlabs/plugin/blob/main/skills/general/agents/references/agent-configuration.md
 *   (KI-Hinweis: conversation_config.agent.disable_first_message_interruptions,
 *   Dauer: conversation_config.conversation.max_duration_seconds)
 * - Geheimnisse: https://elevenlabs.io/docs/eleven-agents/api-reference/workspace/secrets/create
 *   (custom_llm.api_key nimmt nur einen Verweis, ElevenLabs schickt daraus
 *   „Authorization: Bearer <token>“)
 * - Tests: https://elevenlabs.io/docs/api-reference/tests/create,
 *   https://elevenlabs.io/docs/eleven-agents/api-reference/tests/run-tests,
 *   https://elevenlabs.io/docs/api-reference/tests/test-invocations/get,
 *   Pflichtfelder eines Testlaufs: https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/types/unit_test_run_response_model.py
 * - Abweichungen im Testlauf: agent_config_override in https://elevenlabs.io/docs/eleven-agents/api-reference/tests/run-tests
 *   nennt keine Regel, ob das Override zusammengeführt wird oder ersetzt. Felder von
 *   custom_llm: https://github.com/elevenlabs/elevenlabs-python/blob/main/src/elevenlabs/types/custom_llm.py
 * - Sprachen: https://elevenlabs.io/docs/eleven-agents/customization/voice/customization/language
 *   beschreibt je zusätzlicher Sprache einen Eintrag in language_presets, nur das
 *   Hinzufügen. https://elevenlabs.io/docs/api-reference/agents/update sagt nicht,
 *   ob PATCH die Karte ersetzt oder zusammenführt (ausdrücklich „replaces“ steht
 *   nur bei procedures), und die Werte der Karte sind nie null. Belegt sind nur
 *   POST /agents/create (der neue Agent hat genau die gesendeten Einträge) und
 *   DELETE /agents/{id}. Deshalb entfernt tybo eine Sprache über einen neuen
 *   Agenten, siehe deployLocked.
 * - Zuordnungen des Agenten: phone_numbers und whatsapp_accounts in
 *   https://elevenlabs.io/docs/eleven-agents/api-reference/agents/get. Das
 *   Python-SDK führt beide als optional; fehlt eines oder ist es keine Liste,
 *   gilt die Zuordnung als unbekannt (bindings).
 *
 * Antworten des Anbieters können gesendete Werte zurückspiegeln. Jeder Text von
 * dort läuft deshalb durch scrub, und vom Agenten wird nur je Feld ein Hash
 * gespeichert. Das Muster aus phone/provider.ts, Antworten ungefiltert in den
 * Fehlertext zu übernehmen, gilt hier bewusst nicht.
 */
import { ELEVENLABS_API, PROVIDER_TIMEOUT_MS } from "../phone/provider";
import { recipeHash, VoiceAgentError, type VoiceAgentPaths } from "./base";
import {
  parseLayerState,
  type DeployOptions,
  type DeployResult,
  type LayerFailure,
  type ReachableResult,
  type RemoveResult,
  type RunResult,
  type StandResult,
  type SyncResult,
  type TestOutcome,
  type TestOverride,
  type TestRunResult,
  type TestStatus,
  type VoiceLayer,
  type VoiceLayerState,
} from "./layer";
import { effectiveTests } from "./prompt";
import type { Recipe, RecipeTest } from "./recipe";
import { readState, updateState, withAgentLock } from "./state";
import { TEMPLATES } from "./templates";

const PROVIDER = "elevenlabs";
const REDACTED = "[entfernt]";
const MAX_ERROR_CHARS = 200;
const MAX_REASON_CHARS = 500;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Abstände zwischen den Abfragen eines Testlaufs; der letzte Wert wiederholt sich */
export const POLL_SCHEDULE_MS = [2_000, 5_000, 10_000, 15_000, 30_000] as const;
/** Frist für einen Testlauf: Simulationen mit vielen Zügen brauchen Minuten */
export const TEST_RUN_TIMEOUT_MS = 15 * 60_000;

/**
 * Köpfe, die die Brücke auswertet (.env.example, Abschnitt Sprach-Brücke). Sie
 * kommen als Verweis auf Variablen; ein Text wie {{system__caller_id}} käme
 * nicht aufgelöst an.
 */
const BRIDGE_VARIABLE_HEADERS: Readonly<Record<string, string>> = {
  "x-voice-caller-id": "system__caller_id",
  "x-voice-called-number": "system__called_number",
  "x-voice-channel": "system__channel",
  "x-voice-conversation-id": "system__conversation_id",
};

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LayerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: LayerClock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

export interface ElevenLabsLayerOptions {
  env?: Env;
  fetch?: Fetch;
  timeoutMs?: number;
  paths?: VoiceAgentPaths;
  clock?: LayerClock;
  pollScheduleMs?: readonly number[];
  testRunTimeoutMs?: number;
}

type ApiResult = { ok: true; data: any } | { ok: false; status: number | null; fehler: string; vorlaeufig: boolean };

function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Name des Felds im Agenten, wie ihn eine Warnung nennt; je Feld nur der Hash wird gespeichert */
const STAND_LABELS: Readonly<Record<string, string>> = {
  name: "Name",
  schlagwoerter: "Schlagwörter",
  ersterSatz: "erster Satz",
  ersterSatzGeschuetzt: "Schutz des ersten Satzes",
  sprache: "Sprache",
  sprachvarianten: "weitere Sprachen",
  prompt: "Prompt",
  modell: "Modell",
  eigenesModell: "Brücke",
  werkzeuge: "eingebaute Werkzeuge",
  stimme: "Stimme",
  stimmModell: "Stimmmodell",
  tempo: "Tempo",
  hoechstdauer: "Höchstdauer",
  anmeldung: "Anmeldepflicht",
};

/** Zuordnungen am Agenten (Kopf der Datei): Telefonnummer oder WhatsApp-Konto */
function isBound(agent: any): boolean {
  return [agent?.phone_numbers, agent?.whatsapp_accounts].some((list) => Array.isArray(list) && list.length > 0);
}

/**
 * Wie isBound, aber nur für eine lesbare Antwort: ein Agent mit Konfiguration
 * und beiden Zuordnungsfeldern als Liste. Sonst null, denn ein fehlendes oder
 * falsch typisiertes Feld kann eine Zuordnung verbergen.
 */
function bindings(agent: any): boolean | null {
  if (!agent || typeof agent !== "object" || Array.isArray(agent) || !normalizeAgent(agent)) return null;
  const lists = [agent.phone_numbers, agent.whatsapp_accounts];
  if (!lists.every((list) => Array.isArray(list))) return null;
  return lists.some((list) => list.length > 0);
}

/** Der Anbieter füllt nicht gesetzte Felder mit null, und eine Variante mit null gibt es nicht. */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, withoutNulls(item)]));
}

/** Die Felder, die aus dem Rezept folgen, mit ihren Werten. Was der Anbieter sonst ergänzt, zählt nicht als Handänderung. */
function normalizeAgent(agent: any): Record<string, unknown> | null {
  const config = agent?.conversation_config;
  if (!config || typeof config !== "object" || !config.agent?.prompt) return null;
  const { agent: voice, tts, conversation } = config;
  const custom = voice.prompt.custom_llm;
  const tools: Record<string, any> = voice.prompt.built_in_tools ?? {};
  return {
    name: agent.name ?? null,
    schlagwoerter: Array.isArray(agent.tags) ? [...agent.tags].sort() : null,
    ersterSatz: voice.first_message ?? null,
    ersterSatzGeschuetzt: voice.disable_first_message_interruptions === true,
    sprache: voice.language ?? null,
    sprachvarianten: withoutNulls(config.language_presets ?? {}),
    prompt: voice.prompt.prompt ?? null,
    modell: voice.prompt.llm ?? null,
    eigenesModell: custom ? { url: custom.url ?? null, model: custom.model_id ?? null, key: custom.api_key ?? null, type: custom.api_type ?? null, headers: custom.request_headers ?? null } : null,
    werkzeuge: Object.fromEntries(
      Object.entries(tools)
        .filter(([, tool]) => tool)
        .map(([name, tool]) => [name, { type: tool.type ?? null, name: tool.name ?? null, description: tool.description ?? null, art: tool.params?.system_tool_type ?? null }]),
    ),
    stimme: tts?.voice_id ?? null,
    stimmModell: tts?.model_id ?? null,
    tempo: tts?.speed ?? null,
    hoechstdauer: conversation?.max_duration_seconds ?? null,
    anmeldung: agent.platform_settings?.auth?.enable_auth === true,
  };
}

function hashFields(fields: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, recipeHash(value)]));
}

function testHash(test: RecipeTest): string {
  return recipeHash(test);
}

function testPayload(kennung: string, test: RecipeTest): Record<string, unknown> {
  return {
    type: "simulation",
    name: `${kennung}: ${test.name}`,
    simulation_scenario: test.szenario,
    success_conditions: test.kriterien,
    simulation_max_turns: test.maxZuege,
  };
}

/** Erlaubt nur, was ElevenLabs aus der Cloud erreicht und die Brücke annimmt; Zugangsdaten gehören nicht in die Adresse. */
function bridgeUrlProblem(value: string): string | null {
  const invalid = "VOICE_BRIDGE_URL: erwartet https://<rechner>/v1/chat/completions, ohne Zugangsdaten, Parameter und Anker";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.pathname.endsWith("/chat/completions")) return invalid;
    return null;
  } catch {
    return invalid;
  }
}

/** Erster Satz beim Anbieter: der KI-Hinweis zuerst, dann die Begrüßung (Issue #514 prüft das für den Wizard) */
export function firstMessage(persona: Pick<Recipe["persona"], "kiHinweis" | "ersterSatz">): string {
  return persona.kiHinweis ? `${persona.kiHinweis} ${persona.ersterSatz}` : persona.ersterSatz;
}

function buildAgent(recipe: Recipe, prompt: string, bridge: { url: string; secretId: string } | null): Record<string, unknown> {
  const { persona, stimme, gehirn, zugang, kennung } = recipe;
  const [language, ...others] = persona.sprachen;
  const tool = (name: string) => ({ type: "system", name, description: "", params: { system_tool_type: name } });
  return {
    name: recipe.name,
    tags: ["tybo", `tybo-rezept-${kennung}`],
    conversation_config: {
      agent: {
        first_message: firstMessage(persona),
        language,
        disable_first_message_interruptions: Boolean(persona.kiHinweis),
        prompt: {
          prompt,
          llm: bridge ? "custom-llm" : gehirn.modell,
          // null entfernt beim Wechsel zu „anbieter“ die alte Brücke samt Verweis
          custom_llm: bridge
            ? {
                url: bridge.url,
                model_id: gehirn.modell,
                api_key: { secret_id: bridge.secretId },
                api_type: "chat_completions",
                request_headers: {
                  "x-tybo-rezept": kennung,
                  ...Object.fromEntries(Object.entries(BRIDGE_VARIABLE_HEADERS).map(([header, variable]) => [header, { variable_name: variable }])),
                },
              }
            : null,
          // Die festen Regeln verlangen, das Gespräch im Notfall zu beenden
          built_in_tools: { end_call: tool("end_call"), language_detection: others.length > 0 ? tool("language_detection") : null },
        },
      },
      language_presets: Object.fromEntries(others.map((code) => [code, { overrides: { agent: { language: code } } }])),
      tts: { voice_id: stimme.voiceId, model_id: stimme.modell, speed: stimme.tempo },
      conversation: { max_duration_seconds: zugang.maxMinuten * 60 },
    },
    // Immer an: Web-Gespräche gehen nur mit Token aus dem Server
    platform_settings: { auth: { enable_auth: true } },
  };
}

/** Vergleicht die Sprachen beim Anbieter mit dem Rezept. stale: Varianten, die dort nicht mehr stehen dürften. */
function languageState(agent: any, recipe: Recipe): { ok: boolean; stale: string[] } {
  const [language, ...others] = recipe.persona.sprachen;
  const presets = withoutNulls(agent?.conversation_config?.language_presets ?? {}) as Record<string, any>;
  const stale = Object.keys(presets).filter((code) => !others.includes(code));
  const complete = others.every((code) => Object.hasOwn(presets, code) && presets[code]?.overrides?.agent?.language === code);
  return { ok: agent?.conversation_config?.agent?.language === language && stale.length === 0 && complete, stale };
}

const EVALUATION_RESULTS: ReadonlySet<unknown> = new Set(["success", "failure", "unknown"]);

/** switch statt Objekt: Ein Objekt fände auch geerbte Namen wie constructor. */
function outcomeStatus(raw: unknown): TestStatus | null {
  switch (raw) {
    case "pending":
      return "offen";
    case "passed":
      return "bestanden";
    case "failed":
      return "durchgefallen";
    case "cancelled":
      return "abgebrochen";
    default:
      return null;
  }
}

export function createElevenLabsLayer(options: ElevenLabsLayerOptions = {}): VoiceLayer {
  const env = options.env ?? process.env;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const paths = options.paths ?? {};
  const clock = options.clock ?? REAL_CLOCK;
  const schedule = options.pollScheduleMs?.length ? options.pollScheduleMs : POLL_SCHEDULE_MS;
  const testRunTimeoutMs = options.testRunTimeoutMs ?? TEST_RUN_TIMEOUT_MS;
  const value = (name: string) => env[name]?.trim() ?? "";

  /** Entfernt Schlüssel und Token auch in den Formen, in denen eine Antwort sie spiegeln kann. */
  function scrub(text: string, limit = MAX_ERROR_CHARS): string {
    const forms = [value("ELEVENLABS_API_KEY"), value("VOICE_BRIDGE_TOKEN")]
      .filter(Boolean)
      .flatMap((secret) => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString("base64")])
      .sort((a, b) => b.length - a.length);
    let out = text;
    for (const form of forms) out = out.split(form).join(REDACTED);
    return out.replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`).replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function providerId(raw: unknown): string | null {
    return typeof raw === "string" && PROVIDER_ID.test(raw) && scrub(raw, Infinity) === raw ? raw : null;
  }

  /** Nie error.message: Sie kann die Adresse oder Teile der Anfrage enthalten */
  function transportFailure(error: unknown): ApiResult {
    const name = error instanceof Error ? error.name : "";
    return { ok: false, status: null, fehler: name === "TimeoutError" || name === "AbortError" ? "Zeitablauf" : "Anbieter nicht erreichbar", vorlaeufig: true };
  }

  async function api(method: string, path: string, body?: unknown, limitMs = timeoutMs): Promise<ApiResult> {
    const key = value("ELEVENLABS_API_KEY");
    if (!key) return { ok: false, status: null, fehler: "ELEVENLABS_API_KEY fehlt", vorlaeufig: false };
    let response: Response;
    try {
      response = await doFetch(`${ELEVENLABS_API}${path}`, {
        method,
        headers: { "xi-api-key": key, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(limitMs),
      });
    } catch (error) {
      return transportFailure(error);
    }
    let text = "";
    try {
      text = await response.text();
    } catch (error) {
      // Abgerissener Text einer Erfolgsmeldung ist keine leere Erfolgsmeldung
      if (response.ok) return transportFailure(error);
    }
    if (!response.ok) {
      const detail = scrub(text);
      return { ok: false, status: response.status, fehler: detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`, vorlaeufig: isTransient(response.status) };
    }
    try {
      return { ok: true, data: text ? JSON.parse(text) : null };
    } catch {
      return { ok: true, data: null };
    }
  }

  const failure = (result: { fehler: string; vorlaeufig: boolean }): LayerFailure => ({ status: "fehler", fehler: result.fehler, vorlaeufig: result.vorlaeufig });
  const unreadable = (what: string): LayerFailure => ({ status: "fehler", fehler: `Antwort des Anbieters unlesbar: ${what}`, vorlaeufig: false });
  const toFailure = (error: unknown): LayerFailure => ({
    status: "fehler",
    fehler: error instanceof VoiceAgentError ? scrub(error.message) : "Interner Fehler beim Abgleich",
    vorlaeufig: false,
  });

  const read = async (kennung: string): Promise<VoiceLayerState | null> => {
    const state = await readState(kennung, paths);
    return state ? parseLayerState(state) : null;
  };
  const write = async (kennung: string, patch: Partial<VoiceLayerState>): Promise<VoiceLayerState> =>
    parseLayerState(await updateState(kennung, { ...patch, kennung, anbieter: PROVIDER }, { ...paths, now: new Date(clock.now()) }));
  const secretName = (kennung: string) => `tybo-bruecke-${kennung}`;

  function bridgeSettings(recipe: Recipe): { url: string; token: string } | { problem: string } | null {
    if (recipe.gehirn.art !== "bruecke") return null;
    const url = value("VOICE_BRIDGE_URL");
    const token = value("VOICE_BRIDGE_TOKEN");
    const absent = [!url && "VOICE_BRIDGE_URL", !token && "VOICE_BRIDGE_TOKEN"].filter(Boolean);
    if (absent.length > 0) return { problem: `Für gehirn.art: bruecke fehlt ${absent.join(", ")}` };
    const problem = bridgeUrlProblem(url);
    return problem ? { problem } : { url, token };
  }

  function inputHash(recipe: Recipe, prompt: string): string {
    return recipeHash(recipe.gehirn.art === "bruecke" ? { prompt, url: value("VOICE_BRIDGE_URL"), token: value("VOICE_BRIDGE_TOKEN") } : { prompt });
  }

  const boundText = (kennung: string) =>
    `An ${kennung} hängt beim Anbieter eine Telefonnummer oder ein WhatsApp-Konto. Eine ungeprüfte Fassung wäre dort sofort erreichbar, deshalb hat tybo nichts geändert.`;
  /** nurOhneZuordnung: Fehler, wenn eine Zuordnung hängt oder sich nicht ausschließen lässt */
  const bindingProblem = (agent: unknown, kennung: string): LayerFailure | null => {
    const bound = bindings(agent);
    if (bound === null) return unreadable("Zuordnungen des Agenten");
    return bound ? failure({ fehler: boundText(kennung), vorlaeufig: false }) : null;
  };
  const agentGone = (state: VoiceLayerState, kennung: string): DeployResult => ({
    status: "handaenderung",
    state,
    felder: ["Agent gelöscht"],
    warnung: `Agent ${kennung} gibt es beim Anbieter nicht mehr. Nichts wurde angelegt. Um ihn neu anzulegen, erst den Agenten entfernen, dann abgleichen.`,
  });
  const standUnknown = (state: VoiceLayerState, kennung: string): DeployResult => ({
    status: "handaenderung",
    state,
    felder: ["Stand unbekannt"],
    warnung: `Vom letzten Abgleich des Agenten ${kennung} ist kein Stand bekannt, Handänderungen lassen sich nicht ausschließen. Nichts wurde überschrieben. Um das Rezept zu übernehmen, den Agenten entfernen und neu anlegen.`,
  });
  const differingFields = (now: Record<string, string>, known: Record<string, string>) =>
    Object.keys(STAND_LABELS).filter((key) => now[key] !== known[key]).map((key) => STAND_LABELS[key]!);
  const handChanged = (state: VoiceLayerState, kennung: string, felder: string[], pending: boolean): DeployResult => {
    const anlass = pending ? "weicht von dem ab, was tybo zuletzt geschrieben, aber nicht bestätigt bekommen hat" : "wurde beim Anbieter geändert";
    return { status: "handaenderung", state, felder, warnung: `Agent ${kennung} ${anlass} (${felder.join(", ")}). Nichts wurde überschrieben. Die Änderung beim Anbieter zurücknehmen oder den Agenten entfernen und neu anlegen.` };
  };

  /**
   * Rezept-Hash unverändert, standPruefen gesetzt: Entspricht der Agent beim
   * Anbieter noch dem letzten Abgleich? null heißt ja; sonst ein Fehler oder
   * handaenderung. Geschrieben wird hier nichts.
   */
  async function providerMatches(state: VoiceLayerState, kennung: string, options: DeployOptions): Promise<DeployResult | null> {
    const current = await api("GET", `/agents/${encodeURIComponent(state.agentId!)}`);
    if (!current.ok) return current.status === 404 ? agentGone(state, kennung) : { ...failure(current), state };
    const blocked = options.nurOhneZuordnung ? bindingProblem(current.data, kennung) : null;
    if (blocked) return { ...blocked, state };
    const fields = normalizeAgent(current.data);
    if (!fields) return { ...unreadable("Agent"), state };
    const known = state.anbieterStand;
    if (!known) return standUnknown(state, kennung);
    const felder = differingFields(hashFields(fields), known);
    return felder.length > 0 ? handChanged(state, kennung, felder, false) : null;
  }

  async function deployLocked(recipe: Recipe, prompt: string, options: DeployOptions = {}): Promise<DeployResult> {
    const { kennung } = recipe;
    let state = await read(kennung);
    const fail = (result: { fehler: string; vorlaeufig: boolean }): DeployResult => ({ ...failure(result), state });
    if (state?.anbieter && state.anbieter !== PROVIDER) return fail({ fehler: `Der Agent liegt bei einem anderen Anbieter: ${scrub(state.anbieter)}`, vorlaeufig: false });

    const hash = recipeHash(recipe);
    if (state?.agentId && state.letzterHash === hash) {
      if (options.standPruefen) {
        const checked = await providerMatches(state, kennung, options);
        if (checked) return checked;
      }
      const hinweise: string[] = [];
      if (state.eingabeHash !== inputHash(recipe, prompt)) hinweise.push("Prompt oder Einstellungen der Brücke haben sich geändert, das Rezept nicht. Beim Anbieter bleibt der alte Stand, bis sich das Rezept ändert oder der Agent entfernt und neu angelegt wird.");
      if (recipe.gehirn.art !== "bruecke" && state.brueckenGeheimnisId) hinweise.push("Das Token der alten Brücke liegt noch beim Anbieter. Der nächste Abgleich mit geändertem Rezept oder das Entfernen des Agenten versucht erneut, es zu löschen.");
      if (state.ersetzterAgentId) hinweise.push("Der ersetzte Agent liegt noch beim Anbieter. Der nächste Abgleich mit geändertem Rezept oder das Entfernen des Agenten versucht erneut, ihn zu löschen.");
      return { status: "unveraendert", state, hinweise };
    }

    if (!value("ELEVENLABS_API_KEY")) return fail({ fehler: "ELEVENLABS_API_KEY fehlt", vorlaeufig: false });
    if (!recipe.stimme.voiceId) return fail({ fehler: "stimme.voiceId fehlt. Das Rezept mit saveRecipe speichern, das trägt die Standardstimme ein.", vorlaeufig: false });
    const settings = bridgeSettings(recipe);
    if (settings && "problem" in settings) return fail({ fehler: settings.problem, vorlaeufig: false });

    const hinweise: string[] = [];
    /** Löscht den Agenten, den ein neuer ersetzt hat. Ergebnis: der Fehlschlag, sonst null. */
    const removeReplaced = async () => {
      const replaced = state?.ersetzterAgentId;
      if (!replaced) return null;
      const removed = await api("DELETE", `/agents/${encodeURIComponent(replaced)}`);
      if (!removed.ok && removed.status !== 404) return removed;
      state = await write(kennung, { ersetzterAgentId: undefined });
      return null;
    };
    const finish = async (status: "angelegt" | "geaendert"): Promise<DeployResult> => {
      // Vor dem Geheimnis: ElevenLabs löscht es nur, wenn es nicht in Gebrauch ist
      const leftover = await removeReplaced();
      if (leftover) hinweise.push(`Der ersetzte Agent ließ sich nicht löschen (${leftover.fehler}). Der nächste Abgleich mit geändertem Rezept oder das Entfernen des Agenten versucht es erneut.`);
      const oldSecret = state!.brueckenGeheimnisId;
      if (recipe.gehirn.art !== "bruecke" && oldSecret) {
        const removed = await api("DELETE", `/secrets/${encodeURIComponent(oldSecret)}`);
        if (removed.ok || removed.status === 404) state = await write(kennung, { brueckenGeheimnisId: undefined });
        else hinweise.push(`Das Token der alten Brücke ließ sich nicht löschen (${removed.fehler}).`);
      }
      return { status, state: state!, hinweise };
    };

    let agentId = state?.agentId;
    let outgoing: string | undefined;
    if (agentId) {
      const current = await api("GET", `/agents/${encodeURIComponent(agentId)}`);
      if (!current.ok) {
        if (current.status !== 404) return fail(current);
        return agentGone(state!, kennung);
      }
      const blocked = options.nurOhneZuordnung ? bindingProblem(current.data, kennung) : null;
      if (blocked) return { ...blocked, state };
      const fields = normalizeAgent(current.data);
      if (!fields) return fail(unreadable("Agent"));
      const pending = state!.ausstehend;
      const known = pending?.stand ?? state!.anbieterStand;
      // Ohne Vergleichsgrundlage ließe sich eine Handänderung nicht ausschließen
      if (!known) return standUnknown(state!, kennung);
      const now = hashFields(fields);
      const felder = differingFields(now, known);
      if (felder.length > 0) return handChanged(state!, kennung, felder, Boolean(pending));
      if (pending) {
        // Beim Anbieter steht genau das Geschriebene: Die Nachfrage ist nachgeholt
        state = await write(kennung, { ausstehend: undefined, letzterHash: pending.hash, anbieterStand: now, eingabeHash: pending.eingabeHash, abgeglichenAm: new Date(clock.now()).toISOString() });
        if (pending.hash === hash) {
          hinweise.push("Der letzte Schreibvorgang ließ sich erst jetzt bestätigen, geschrieben wurde nichts.");
          return finish("geaendert");
        }
      }
      // Eine Sprache entfällt: Das geht nur über einen neuen Agenten (Kopf der Datei). Der alte fällt erst, wenn der neue bestätigt ist.
      if (languageState(current.data, recipe).stale.length > 0) {
        if (isBound(current.data)) return fail({ fehler: `Aus dem Rezept von ${kennung} ist eine Sprache entfallen, dafür braucht es einen neuen Agenten. Am alten hängt eine Telefonnummer oder ein WhatsApp-Konto, die Zuordnung ginge verloren. Nichts wurde geändert. Die Zuordnung beim Anbieter lösen und erneut abgleichen.`, vorlaeufig: false });
        const leftover = await removeReplaced();
        if (leftover) return fail({ fehler: `Der zuvor ersetzte Agent ließ sich nicht löschen (${leftover.fehler}). Nichts wurde geändert.`, vorlaeufig: leftover.vorlaeufig });
        outgoing = agentId;
      }
    }

    let secretId = state?.brueckenGeheimnisId;
    let bridge: { url: string; secretId: string } | null = null;
    if (settings) {
      const secret = { name: secretName(kennung), value: settings.token };
      if (secretId) {
        const updated = await api("PATCH", `/secrets/${encodeURIComponent(secretId)}`, { type: "update", ...secret });
        if (!updated.ok && updated.status !== 404) return fail(updated);
        if (!updated.ok) secretId = undefined;
      }
      if (!secretId) {
        const created = await api("POST", "/secrets", { type: "new", ...secret });
        if (!created.ok) return fail(created);
        secretId = providerId(created.data?.secret_id) ?? undefined;
        if (!secretId) return fail(unreadable("Geheimnis ohne Kennung"));
        state = await write(kennung, { brueckenGeheimnisId: secretId });
      }
      bridge = { url: settings.url, secretId };
    }

    const payload = buildAgent(recipe, prompt, bridge);
    const isNew = !agentId;
    if (agentId && !outgoing) {
      const updated = await api("PATCH", `/agents/${encodeURIComponent(agentId)}`, payload);
      if (!updated.ok) return fail(updated);
    } else {
      const created = await api("POST", "/agents/create", payload);
      if (!created.ok) return fail(created);
      agentId = providerId(created.data?.agent_id) ?? undefined;
      if (!agentId) return fail(unreadable("Agent ohne Kennung"));
      if (outgoing) hinweise.push("Eine Sprache ist aus dem Rezept entfallen, deshalb hat tybo den Agenten neu angelegt. Er hat eine neue Kennung, und Einstellungen beim Anbieter, die nicht aus dem Rezept stammen, hat er nicht mehr.");
    }
    // Ab hier stimmt der alte Stand nicht mehr. Scheitert die Nachfrage, vergleicht der nächste Abgleich mit dem Gesendeten.
    const inputs = inputHash(recipe, prompt);
    state = await write(kennung, { agentId, letzterHash: undefined, anbieterStand: undefined, eingabeHash: undefined, abgeglichenAm: undefined, ausstehend: { stand: hashFields(normalizeAgent(payload)!), hash, eingabeHash: inputs }, ...(outgoing ? { ersetzterAgentId: outgoing } : {}) });

    const written = await api("GET", `/agents/${encodeURIComponent(agentId)}`);
    if (!written.ok) return fail({ fehler: `Agent geschrieben, Nachfrage gescheitert: ${written.fehler}. Der nächste Abgleich holt das nach.`, vorlaeufig: written.vorlaeufig });
    const fields = normalizeAgent(written.data);
    if (!fields) return fail(unreadable("Agent"));
    if (fields.anmeldung !== true) return fail({ fehler: "Der Anbieter hat die Anmeldepflicht nicht übernommen. Der Agent gilt nicht als abgeglichen.", vorlaeufig: false });
    if (!bridge && fields.eigenesModell) return fail({ fehler: "Der Anbieter hat die alte Brücke nicht entfernt. Der Agent gilt nicht als abgeglichen.", vorlaeufig: false });
    if (!languageState(written.data, recipe).ok) return fail({ fehler: "Die Sprachen beim Anbieter stimmen nicht mit dem Rezept überein. Der Agent gilt nicht als abgeglichen.", vorlaeufig: false });

    state = await write(kennung, {
      letzterHash: hash,
      anbieterStand: hashFields(fields),
      eingabeHash: inputs,
      abgeglichenAm: new Date(clock.now()).toISOString(),
      ausstehend: undefined,
    });
    return finish(isNew ? "angelegt" : "geaendert");
  }

  async function syncLocked(recipe: Recipe): Promise<SyncResult> {
    const { kennung } = recipe;
    let state = await read(kennung);
    const fail = (result: { fehler: string; vorlaeufig: boolean }): SyncResult => ({ ...failure(result), state });
    if (!state?.agentId) return fail({ fehler: `Agent ${kennung} ist noch nicht angelegt.`, vorlaeufig: false });

    // Map statt Objekt: Testnamen wie __proto__ oder constructor sind erlaubt
    const known = new Map(Object.entries(state.tests ?? {}));
    const wanted = effectiveTests(recipe, TEMPLATES[recipe.vorlage]);
    const done = { angelegt: [] as string[], geaendert: [] as string[], entfernt: [] as string[], unveraendert: [] as string[] };
    const save = async () => {
      state = await write(kennung, { tests: Object.fromEntries(known) });
    };

    for (const test of wanted) {
      const hash = testHash(test);
      const existing = known.get(test.name);
      if (existing?.hash === hash) {
        done.unveraendert.push(test.name);
        continue;
      }
      const body = testPayload(kennung, test);
      if (existing) {
        const updated = await api("PUT", `/agent-testing/${encodeURIComponent(existing.id)}`, body);
        if (updated.ok) {
          known.set(test.name, { id: existing.id, hash });
          done.geaendert.push(test.name);
          await save();
          continue;
        }
        if (updated.status !== 404) return fail(updated);
      }
      const created = await api("POST", "/agent-testing/create", body);
      if (!created.ok) return fail(created);
      const id = providerId(created.data?.id);
      if (!id) return fail(unreadable("Test ohne Kennung"));
      known.set(test.name, { id, hash });
      done.angelegt.push(test.name);
      await save();
    }

    const names = new Set(wanted.map((test) => test.name));
    for (const [name, existing] of [...known]) {
      if (names.has(name)) continue;
      const removed = await api("DELETE", `/agent-testing/${encodeURIComponent(existing.id)}`);
      if (!removed.ok && removed.status !== 404) return fail(removed);
      known.delete(name);
      done.entfernt.push(name);
      await save();
    }
    return { status: "ok", state: state!, ...done };
  }

  async function removeLocked(kennung: string): Promise<RemoveResult> {
    let state = await read(kennung);
    const fail = (result: { fehler: string; vorlaeufig: boolean }): RemoveResult => ({ ...failure(result), state });
    if (!state) return fail({ fehler: `Zu ${kennung} gibt es keinen Zustand.`, vorlaeufig: false });
    const gone = (result: ApiResult) => result.ok || result.status === 404;

    const known = new Map(Object.entries(state.tests ?? {}));
    for (const [name, test] of [...known]) {
      const removed = await api("DELETE", `/agent-testing/${encodeURIComponent(test.id)}`);
      if (!gone(removed)) return fail(removed as { fehler: string; vorlaeufig: boolean });
      known.delete(name);
      state = await write(kennung, { tests: Object.fromEntries(known) });
    }
    if (state.agentId) {
      const removed = await api("DELETE", `/agents/${encodeURIComponent(state.agentId)}`);
      if (!gone(removed)) return fail(removed as { fehler: string; vorlaeufig: boolean });
      state = await write(kennung, { agentId: undefined, letzterHash: undefined, anbieterStand: undefined, eingabeHash: undefined, abgeglichenAm: undefined, ausstehend: undefined });
    }
    if (state.ersetzterAgentId) {
      const removed = await api("DELETE", `/agents/${encodeURIComponent(state.ersetzterAgentId)}`);
      if (!gone(removed)) return fail(removed as { fehler: string; vorlaeufig: boolean });
      state = await write(kennung, { ersetzterAgentId: undefined });
    }
    // Nach den Agenten: ElevenLabs löscht ein Geheimnis nur, wenn es nicht in Gebrauch ist
    if (state.brueckenGeheimnisId) {
      const removed = await api("DELETE", `/secrets/${encodeURIComponent(state.brueckenGeheimnisId)}`);
      if (!gone(removed)) return fail(removed as { fehler: string; vorlaeufig: boolean });
      state = await write(kennung, { brueckenGeheimnisId: undefined });
    }
    return { status: "ok", state };
  }

  /**
   * Modellwechsel für einen Testlauf, je nach Gehirn des Agenten: Bei der Brücke
   * bleibt llm „custom-llm“ und nur custom_llm.model_id wechselt, sonst liefe der
   * Test am Anbietermodell statt an der Brücke. Maßgeblich ist der Agent beim
   * Anbieter: Der Zustand kann ein altes Geheimnis tragen und die .env neuer sein
   * als der Agent. Weicht er vom letzten Abgleich ab, startet kein Test.
   * custom_llm geht ganz mit, weil die Doku nicht sagt, ob der Anbieter das
   * Override zusammenführt oder ersetzt (Kopf der Datei).
   */
  async function modelFields(state: VoiceLayerState, modell: string): Promise<{ llm: string; custom_llm?: unknown } | LayerFailure> {
    const current = await api("GET", `/agents/${encodeURIComponent(state.agentId!)}`);
    if (!current.ok) return failure(current);
    const fields = normalizeAgent(current.data);
    if (!fields) return unreadable("Agent");
    const known = state.ausstehend?.stand ?? state.anbieterStand;
    const now = hashFields(fields);
    if (!known || now.modell !== known.modell || now.eigenesModell !== known.eigenesModell) {
      return failure({ fehler: "Modell oder Brücke des Agenten weichen vom letzten Abgleich ab oder der Stand ist unbekannt. Kein Test wurde gestartet.", vorlaeufig: false });
    }
    const { llm, custom_llm: custom } = current.data.conversation_config.agent.prompt;
    if (typeof llm !== "string" || !llm) return unreadable("Modell des Agenten");
    if (llm !== "custom-llm") return { llm: modell };
    const headers = custom?.request_headers;
    if (typeof custom?.url !== "string" || !custom.url || !providerId(custom.api_key?.secret_id) || !headers || typeof headers !== "object") return unreadable("Brücke des Agenten");
    return { llm, custom_llm: { ...custom, model_id: modell } };
  }

  function overridePayload(override: TestOverride, model: { llm: string; custom_llm?: unknown } | null): Record<string, unknown> | null {
    const prompt = { ...(override.prompt ? { prompt: override.prompt } : {}), ...model };
    const agent = { ...(override.ersterSatz ? { first_message: override.ersterSatz } : {}), ...(Object.keys(prompt).length > 0 ? { prompt } : {}) };
    // platform_settings ist bei ElevenLabs Pflicht, auch wenn nichts abweicht
    return Object.keys(agent).length > 0 ? { conversation_config: { agent }, platform_settings: {} } : null;
  }

  /** Pflichtfelder laut Schema (Kopf der Datei). Unvollständiges oder falsch Typisiertes ist unlesbar, nie bestanden. */
  function parseRun(run: any, cancelled: boolean): TestOutcome | null {
    if (!run || typeof run !== "object") return null;
    let status = outcomeStatus(run.status);
    const testId = providerId(run.test_id);
    if (!status || !testId) return null;
    if (![run.test_run_id, run.test_invocation_id, run.agent_id].every((field) => typeof field === "string" && field)) return null;
    if (run.test_name != null && typeof run.test_name !== "string") return null;
    const condition = run.condition_result;
    if (condition != null && !EVALUATION_RESULTS.has(condition.result)) return null;
    // Ein abgebrochener Lauf wird nicht mehr fertig
    if (status === "offen" && cancelled) status = "abgebrochen";
    // Bestätigt die Bewertung den Status nicht, zählt der Test nicht als bestanden
    if (status === "bestanden" && condition != null && condition.result !== "success") status = "durchgefallen";
    const rationale = condition?.rationale;
    const reasons = Array.isArray(rationale?.messages) ? rationale.messages.filter((item: unknown) => typeof item === "string") : [];
    const reason = reasons.length > 0 ? reasons.join("; ") : typeof rationale?.summary === "string" ? rationale.summary : "";
    return {
      testId,
      name: scrub(run.test_name || testId),
      status,
      ...(status === "durchgefallen" && reason ? { kriterium: scrub(reason, MAX_REASON_CHARS) } : {}),
    };
  }

  function parseRuns(data: any): { tests: TestOutcome[]; pending: boolean } | null {
    if (!data || !Array.isArray(data.test_runs) || data.test_runs.length === 0) return null;
    const tests: TestOutcome[] = [];
    for (const run of data.test_runs) {
      const outcome = parseRun(run, data.cancelled === true);
      if (!outcome) return null;
      tests.push(outcome);
    }
    return { tests, pending: tests.some((test) => test.status === "offen") };
  }

  return {
    async deploy(recipe, prompt, options) {
      try {
        return await withAgentLock(recipe.kennung, paths, () => deployLocked(recipe, prompt, options));
      } catch (error) {
        return { ...toFailure(error), state: null };
      }
    },

    async reachable(state): Promise<ReachableResult> {
      if (!state.agentId) return { status: "ok", erreichbar: false };
      const current = await api("GET", `/agents/${encodeURIComponent(state.agentId)}`);
      if (!current.ok) return current.status === 404 ? { status: "ok", erreichbar: false } : failure(current);
      // Unlesbares JSON, {} oder falsch typisierte Zuordnungen sind unbekannt, nie „nicht erreichbar“
      const bound = bindings(current.data);
      return bound === null ? unreadable("Zuordnungen des Agenten") : { status: "ok", erreichbar: bound };
    },

    async compareStand(state, stand): Promise<StandResult> {
      if (!state.agentId) return failure({ fehler: "Der Agent ist noch nicht angelegt.", vorlaeufig: false });
      const current = await api("GET", `/agents/${encodeURIComponent(state.agentId)}`);
      if (!current.ok) return current.status === 404 ? { status: "ok", felder: ["Agent gelöscht"] } : failure(current);
      const fields = normalizeAgent(current.data);
      if (!fields) return unreadable("Agent");
      return { status: "ok", felder: differingFields(hashFields(fields), stand) };
    },

    async remove(state) {
      if (!state.kennung) return { ...failure({ fehler: "Dem Zustand fehlt die Kennung des Rezepts.", vorlaeufig: false }), state };
      try {
        return await withAgentLock(state.kennung, paths, () => removeLocked(state.kennung!));
      } catch (error) {
        return { ...toFailure(error), state };
      }
    },

    async syncTests(recipe, state) {
      if (state.kennung !== recipe.kennung) return { ...failure({ fehler: "Zustand und Rezept gehören nicht zusammen.", vorlaeufig: false }), state };
      try {
        return await withAgentLock(recipe.kennung, paths, () => syncLocked(recipe));
      } catch (error) {
        return { ...toFailure(error), state };
      }
    },

    async runTests(state, override): Promise<RunResult> {
      if (!state.agentId) return failure({ fehler: "Der Agent ist noch nicht angelegt.", vorlaeufig: false });
      const tests = Object.values(state.tests ?? {});
      if (tests.length === 0) return failure({ fehler: "Es gibt noch keine Tests beim Anbieter.", vorlaeufig: false });
      const model = override?.modell ? await modelFields(state, override.modell) : null;
      if (model && "status" in model) return model;
      const agentOverride = override ? overridePayload(override, model) : null;
      const started = await api("POST", `/agents/${encodeURIComponent(state.agentId)}/run-tests`, {
        tests: tests.map((test) => ({ test_id: test.id })),
        ...(agentOverride ? { agent_config_override: agentOverride } : {}),
      });
      if (!started.ok) return failure(started);
      const runId = providerId(started.data?.id);
      return runId ? { status: "gestartet", runId } : unreadable("Testlauf ohne Kennung");
    },

    async testResult(runId): Promise<TestRunResult> {
      const deadline = clock.now() + testRunTimeoutMs;
      let tests: TestOutcome[] = [];
      let grund: string | undefined;
      const expired = (): TestRunResult => ({ status: "zeitueberschreitung", tests, ...(grund ? { grund } : {}) });
      for (let step = 0; ; step++) {
        const remaining = deadline - clock.now();
        if (remaining <= 0) return expired();
        const result = await api("GET", `/test-invocations/${encodeURIComponent(runId)}`, undefined, Math.min(timeoutMs, remaining));
        // Was erst nach der Frist ankommt, zählt nicht mehr, auch keine Erfolgsmeldung
        if (clock.now() >= deadline) {
          grund = result.ok ? "Die Antwort kam erst nach der Frist." : result.fehler;
          return expired();
        }
        if (result.ok) {
          const parsed = parseRuns(result.data);
          if (!parsed) return unreadable("Testlauf");
          tests = parsed.tests;
          grund = undefined;
          if (!parsed.pending) {
            const gesamt = tests.some((test) => test.status === "durchgefallen") ? "durchgefallen" : tests.some((test) => test.status === "abgebrochen") ? "abgebrochen" : "bestanden";
            return { status: "fertig", gesamt, tests };
          }
        } else if (!result.vorlaeufig) {
          return failure(result);
        } else {
          grund = result.fehler;
        }
        const wait = schedule[Math.min(step, schedule.length - 1)]!;
        if (clock.now() + wait > deadline) return expired();
        await clock.sleep(wait);
      }
    },
  };
}
