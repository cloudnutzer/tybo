/**
 * Quelle Nachrichten (Issue #354): die wichtigsten KI-Nachrichten der
 * letzten 24 Stunden, gesucht von einem Sprachmodell mit Websuche.
 *
 * Anbieter über NEWS_PROVIDER:
 * - `xai` (Standard): xAI Responses API mit den Werkzeugen web_search und
 *   x_search, Schlüssel XAI_API_KEY, Modell NEWS_MODEL oder DEFAULT_XAI_MODEL
 * - `openrouter`: OpenRouter mit dem Web-Plugin, Schlüssel
 *   OPENROUTER_API_KEY, Modell NEWS_MODEL, sonst OPENROUTER_MODEL, sonst
 *   DEFAULT_OPENROUTER_MODEL
 * Ein unbekannter Anbieter oder ein fehlender Schlüssel: die Quelle ist
 * nicht bereit und wird übersprungen; newsSetup sagt, warum.
 *
 * Nur belegte Nachrichten: Eine Zeile zählt, wenn ihre Adresse selbst unter
 * den Belegen der Suche (Zitate des Anbieters) steht. Verglichen wird die
 * ganze Adresse; gleich gelten nur Groß- und Kleinschreibung des Hosts, ein
 * führendes www., ein Schrägstrich am Ende, der Anker (#) und
 * Kampagnen-Parameter (utm_*). Ein anderer Artikel oder ein anderer
 * X-Beitrag auf demselben Host zählt nicht. Ohne Belege bleibt der
 * Abschnitt leer, mit Hinweis.
 */
import type { Env, Section, SectionItem, Source, SourceContext } from "./types";

export const NEWS_PROVIDERS = ["xai", "openrouter"] as const;
export type NewsProvider = (typeof NEWS_PROVIDERS)[number];

export const DEFAULT_XAI_MODEL = "grok-4.7";
export const DEFAULT_OPENROUTER_MODEL = "minimax/minimax-m2.7";
export const MAX_NEWS = 5;

export type NewsSetup =
  | { ok: true; provider: NewsProvider; apiKey: string; model: string }
  | { ok: false; provider: string; problem: "unknown-provider" | "missing-key" };

const value = (text: string | undefined) => text?.trim() || "";

/** Anbieter, Schlüssel und Modell aus der Umgebung */
export function newsSetup(env: Env): NewsSetup {
  const provider = value(env.NEWS_PROVIDER).toLowerCase() || "xai";
  if (provider === "xai") {
    const apiKey = value(env.XAI_API_KEY);
    if (!apiKey) return { ok: false, provider, problem: "missing-key" };
    return { ok: true, provider, apiKey, model: value(env.NEWS_MODEL) || DEFAULT_XAI_MODEL };
  }
  if (provider === "openrouter") {
    const apiKey = value(env.OPENROUTER_API_KEY);
    if (!apiKey) return { ok: false, provider, problem: "missing-key" };
    const model = value(env.NEWS_MODEL) || value(env.OPENROUTER_MODEL) || DEFAULT_OPENROUTER_MODEL;
    return { ok: true, provider, apiKey, model };
  }
  return { ok: false, provider, problem: "unknown-provider" };
}

const INSTRUCTION =
  "Search the web for the most important AI news of the last 24 hours. " +
  `Answer with at most ${MAX_NEWS} lines, one news item per line: one sentence, then the source URL in parentheses. ` +
  "Only items you found in this search, never invented ones. No headings, no introduction.";

/** Antwort des Anbieters: Text und Beleg-Adressen */
interface Answer {
  text: string;
  citations: string[];
}

type JsonObject = Record<string, unknown>;
const asObject = (x: unknown): JsonObject => (x && typeof x === "object" ? (x as JsonObject) : {});
const asArray = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** Adresse aus einem Zitat: als Text oder als { url } bzw. { url_citation: { url } } */
function citationUrl(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  const obj = asObject(entry);
  const url = obj.url ?? asObject(obj.url_citation).url;
  return typeof url === "string" ? url : null;
}

async function failOn(response: Response, provider: string): Promise<void> {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${provider} lehnt den Schlüssel ab (HTTP ${response.status})`);
  }
  throw new Error(`${provider} antwortet mit HTTP ${response.status}`);
}

async function askXai(ctx: SourceContext, apiKey: string, model: string): Promise<Answer> {
  const response = await ctx.fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    signal: ctx.signal,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: INSTRUCTION }],
      tools: [{ type: "web_search" }, { type: "x_search" }],
    }),
  });
  await failOn(response, "xAI");
  const data = asObject(await response.json());
  const texts: string[] = [];
  const citations = asArray(data.citations).map(citationUrl);
  for (const output of asArray(data.output)) {
    for (const part of asArray(asObject(output).content)) {
      const piece = asObject(part);
      if (piece.type === "output_text" && typeof piece.text === "string") texts.push(piece.text);
      citations.push(...asArray(piece.annotations).map(citationUrl));
    }
  }
  if (typeof data.output_text === "string" && texts.length === 0) texts.push(data.output_text);
  return { text: texts.join("\n"), citations: citations.filter((c): c is string => !!c) };
}

async function askOpenRouter(ctx: SourceContext, apiKey: string, model: string): Promise<Answer> {
  const response = await ctx.fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: ctx.signal,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: INSTRUCTION }],
      plugins: [{ id: "web" }],
    }),
  });
  await failOn(response, "OpenRouter");
  const message = asObject(asObject(asArray(asObject(await response.json()).choices)[0]).message);
  const citations = asArray(message.annotations).map(citationUrl);
  return {
    text: typeof message.content === "string" ? message.content : "",
    citations: citations.filter((c): c is string => !!c),
  };
}

/** Adresse in Vergleichsform, null wenn sie keine http(s)-Adresse ist */
export function comparableUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "");
  const params = [...parsed.searchParams].filter(([name]) => !name.toLowerCase().startsWith("utm_"));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  return `${host}${parsed.port ? `:${parsed.port}` : ""}${path}${query}`;
}

const URL_IN_TEXT = /https?:\/\/[^\s)\]>]+/;

/** Zeilen mit belegter Adresse als Einträge, höchstens MAX_NEWS */
export function verifiedItems(answer: Answer): SectionItem[] {
  const cited = new Set(answer.citations.map(comparableUrl).filter((c): c is string => !!c));
  const items: SectionItem[] = [];
  for (const raw of answer.text.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
    const url = URL_IN_TEXT.exec(line)?.[0].replace(/[.,;]+$/, "");
    const key = url ? comparableUrl(url) : null;
    if (!url || !key || !cited.has(key)) continue;
    const text = line
      .replace(URL_IN_TEXT, "")
      .replace(/\(\s*\)|\[\s*\]/g, "")
      .replace(/\s+([.,;:])/g, "$1")
      .trim();
    if (text) items.push({ text, link: url });
    if (items.length === MAX_NEWS) break;
  }
  return items;
}

export const newsSource: Source = {
  id: "news",
  label: "AI News",
  timeoutMs: 60_000,
  ready: (env: Env) => newsSetup(env).ok,
  async collect(ctx: SourceContext): Promise<Section> {
    const setup = newsSetup(ctx.env);
    if (!setup.ok) throw new Error(`Nachrichten nicht eingerichtet (${setup.provider}: ${setup.problem})`);
    const answer =
      setup.provider === "xai"
        ? await askXai(ctx, setup.apiKey, setup.model)
        : await askOpenRouter(ctx, setup.apiKey, setup.model);
    const items = verifiedItems(answer);
    if (items.length === 0) return { items, note: "Keine belegten Nachrichten aus der Suche." };
    return { items };
  },
};
