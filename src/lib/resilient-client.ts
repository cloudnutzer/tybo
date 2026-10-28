/**
 * Anfragen an die Anthropic-API mit Ausweichweg über OpenRouter. Genutzt von
 * der Bildbeschreibung (src/lib/assets/describe.ts).
 *
 * Scheitert Anthropic an Guthaben, Schlüssel oder Überlast und ist
 * OPENROUTER_API_KEY gesetzt, geht dieselbe Anfrage an den
 * Anthropic-kompatiblen Endpunkt von OpenRouter: Modell mit Präfix
 * anthropic/, ohne das Suchwerkzeug, das nur Anthropic kennt. Ab dann laufen
 * alle Anfragen dieses Prozesses über OpenRouter. Ohne OPENROUTER_API_KEY
 * bleibt es bei Anthropic, und der Fehler kommt beim Aufrufer an.
 *
 * Jede Anfrage endet mit der laufenden Ausführung (/stop, Neustart) oder
 * nach fünf Minuten. Tests: tests/resilient-client.test.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import { OPENROUTER_APP_HEADERS } from "../brand";
import { checkAborted, executionSignal } from "./execution-context";

type MessageParams = Anthropic.MessageCreateParamsNonStreaming;

const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
const OPENROUTER_MODEL_PREFIX = "anthropic/";
/** Server-Werkzeug von Anthropic, das OpenRouter nicht annimmt */
const ANTHROPIC_ONLY_TOOL = "web_search_20250305";
const REQUEST_LIMIT_MS = 5 * 60_000;

/** Status, die auf Guthaben, Schlüssel oder Überlast deuten */
const OUTAGE_STATUSES: ReadonlySet<number> = new Set([400, 401, 402, 429, 529]);
/** Meldungen mit derselben Bedeutung, auch bei anderem Status */
const OUTAGE_WORDING = /credit balance is too low|insufficient_quota|rate_limit|overloaded|authentication|invalid.*api.*key|billing/i;

/** Einmal angelegte SDK-Clients, je Ziel einer */
const sdkClients: { direct?: Anthropic; openRouter?: Anthropic } = {};
/** Seit dem ersten Ausfall gehen Anfragen gleich an OpenRouter */
let anthropicFailed = false;

function directClient(): Anthropic {
  if (!sdkClients.direct) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY not set");
    sdkClients.direct = new Anthropic({ apiKey: key });
  }
  return sdkClients.direct;
}

function openRouterClient(apiKey: string): Anthropic {
  sdkClients.openRouter ??= new Anthropic({ apiKey, baseURL: OPENROUTER_BASE_URL, defaultHeaders: { ...OPENROUTER_APP_HEADERS } });
  return sdkClients.openRouter;
}

function errorText(err: unknown): string {
  const shaped = err as { message?: unknown; error?: { message?: unknown } } | null | undefined;
  return String(shaped?.message || shaped?.error?.message || err);
}

/** Fehler, nach dem ein Versuch über OpenRouter lohnt */
function isOutage(err: unknown): boolean {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (typeof status === "number" && OUTAGE_STATUSES.has(status)) return true;
  return OUTAGE_WORDING.test(errorText(err));
}

/** Dieselbe Anfrage im Format, das OpenRouter annimmt */
function forOpenRouter(params: MessageParams): MessageParams {
  const model = params.model.startsWith(OPENROUTER_MODEL_PREFIX) ? params.model : OPENROUTER_MODEL_PREFIX + params.model;
  const tools = params.tools?.filter(tool => (tool as { type?: string }).type !== ANTHROPIC_ONLY_TOOL);
  return tools ? { ...params, model, tools } : { ...params, model };
}

function send(client: Anthropic, params: MessageParams): Promise<Anthropic.Message> {
  return client.messages.create(params, { signal: executionSignal(REQUEST_LIMIT_MS) });
}

/** Schickt die Nachricht an Anthropic, bei einem Ausfall über OpenRouter */
export async function createResilientMessage(params: MessageParams): Promise<Anthropic.Message> {
  checkAborted();
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (anthropicFailed && openRouterKey) return send(openRouterClient(openRouterKey), forOpenRouter(params));
  return send(directClient(), params).catch((err: unknown) => {
    if (!openRouterKey || !isOutage(err)) throw err;
    if (!anthropicFailed) console.log("[Resilient] Anthropic gestört, ab jetzt über OpenRouter");
    anthropicFailed = true;
    console.log(`[Resilient] Anthropic-Fehler (${(err as { status?: number }).status ?? errorText(err)}), neuer Versuch über OpenRouter`);
    return send(openRouterClient(openRouterKey), forOpenRouter(params));
  });
}
