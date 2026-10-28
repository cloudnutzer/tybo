/**
 * Eigener Prozess für tests/resilient-client.test.ts (Issue #382): das
 * Anthropic-SDK merkt sich fetch beim ersten Laden, deshalb ersetzt dieser
 * Prozess fetch, bevor src/lib/resilient-client geladen wird. Ins Netz geht
 * nichts. Die Schritte laufen nacheinander mit gemeinsamem Zustand (nach
 * einem Ausfall gilt Anthropic als gestört); am Ende steht je Schritt als
 * JSON, welche Anfragen rausgingen und was herauskam.
 *
 * Erwartet ANTHROPIC_API_KEY (Attrappen-Wert). Mit OPENROUTER_API_KEY läuft
 * der Ausfall über OpenRouter, ohne bleibt es bei Anthropic. Den Status des
 * Ausfalls wählt TYBO_FIXTURE_OUTAGE_STATUS; TYBO_FIXTURE_OUTAGE_MESSAGE
 * setzt stattdessen eine Meldung zu Status 404.
 */
import { abortExecutions, runExecution } from "../src/lib/execution-context";

interface Seen {
  url: string;
  model: string;
  tools: string[];
  apiKey: string | null;
  referer: string | null;
  title: string | null;
}

/** Antwort der Anthropic-Attrappe je Aufruf: ok oder Status samt Meldung */
let anthropicReply: { status: number; message?: string } = { status: 200 };
let seen: Seen[] = [];

function messageBody(model: string, text: string) {
  return {
    id: "msg_t382",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const headers = new Headers(init?.headers);
  const body = JSON.parse(String(init?.body ?? "{}"));
  seen.push({
    url,
    model: body.model,
    tools: (body.tools ?? []).map((t: { name?: string; type?: string }) => t.type ?? t.name),
    apiKey: headers.get("x-api-key"),
    referer: headers.get("http-referer"),
    title: headers.get("x-title"),
  });
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  if (url.startsWith("https://openrouter.ai/")) return json(200, messageBody(body.model, "von OpenRouter"));
  if (anthropicReply.status === 200) return json(200, messageBody(body.model, "von Anthropic"));
  return json(anthropicReply.status, { type: "error", error: { type: "api_error", message: anthropicReply.message ?? "Fehler" } });
}) as typeof fetch;

let clock = Date.parse("2026-10-24T12:00:00Z");
Date.now = () => clock;

const { createResilientMessage } = await import("../src/lib/resilient-client");

const params = {
  model: "claude-test-1",
  max_tokens: 10,
  messages: [{ role: "user" as const, content: "Hallo" }],
  tools: [
    { type: "web_search_20250305", name: "web_search" },
    { name: "eigenes_werkzeug", description: "bleibt", input_schema: { type: "object" as const, properties: {} } },
  ],
};

async function step(name: string, run: () => Promise<unknown>) {
  seen = [];
  let answer: string | null = null;
  let error: string | null = null;
  try {
    const message = (await run()) as { content: { type: string; text?: string }[] };
    answer = message.content.find(b => b.type === "text")?.text ?? null;
  } catch (err) {
    error = err instanceof Error ? `${err.name}:${(err as { status?: number }).status ?? ""}` : String(err);
  }
  return { name, answer, error, requests: seen };
}

const steps = [];
const call = () => createResilientMessage(params as never);

/** Status, mit dem Anthropic beim Ausfall antwortet (TYBO_FIXTURE_OUTAGE_STATUS, Standard 402) */
const outageStatus = Number(process.env.TYBO_FIXTURE_OUTAGE_STATUS || "402");

anthropicReply = { status: 200 };
steps.push(await step("ok", call));

anthropicReply = { status: 404, message: "not found" };
steps.push(await step("anderer-fehler", call));

const outageMessage = process.env.TYBO_FIXTURE_OUTAGE_MESSAGE;
anthropicReply = outageMessage ? { status: 404, message: outageMessage } : { status: outageStatus, message: "kaputt" };
steps.push(await step("ausfall", call));

anthropicReply = { status: 200 };
steps.push(await step("gestoert", call));

clock += 16 * 60_000;
steps.push(await step("nach-16-minuten", call));

const openRouterKey = process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_API_KEY;
anthropicReply = { status: 200 };
steps.push(await step("gestoert-ohne-openrouter", call));
process.env.OPENROUTER_API_KEY = openRouterKey;

anthropicReply = { status: 200 };
steps.push(
  await step("abgebrochen", () =>
    runExecution("t382", "general", async () => {
      abortExecutions("t382");
      return call();
    }),
  ),
);

console.log(JSON.stringify(steps));
