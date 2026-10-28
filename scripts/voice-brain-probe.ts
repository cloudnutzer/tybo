/**
 * Probe für das Sprech-Gehirn (Issue #255): drei feste Fragen über
 * runVoiceTurn mit dem Weg "anthropic", gemessen wird die Zeit bis zum
 * ersten Abschnitt. Zum Vergleich mit der Messung vom 30.09.2026.
 *
 *   bun run scripts/voice-brain-probe.ts [--env <pfad>] [--runs <n>] [--effort <stufe>] [--model <modell>] [--show]
 *
 * - Schlüssel: VOICE_ANTHROPIC_API_KEY aus der .env (Standard: .env im
 *   aktuellen Ordner), wird nie ausgegeben
 * - Kontext: echter Kontext wie in der Brücke (createVoiceContext mit Profil,
 *   Memory und den letzten 20 Nachrichten von TELEGRAM_USER_ID), dazu der
 *   Sprechstil "call"
 * - Messbeginn: unmittelbar vor runVoiceTurn, also vor dem Abruf; der Kontext
 *   ist dann schon geladen
 * - Cache: Lauf 1 je Frage kann den System-Prompt in den Cache schreiben,
 *   weitere lesen; ausgegeben wird, was die API dazu meldet
 * - Ausgegeben werden nur Zeiten, Längen und Cache-Zahlen; die Antworten nur
 *   mit --show (sie können private Angaben aus Profil und Memory enthalten)
 *
 * Ruft nur die Bibliotheksmodule auf, startet weder src/voice-bridge.ts noch
 * src/bot.ts.
 */

import { resolve } from "path";
import { loadEnv } from "../src/lib/env";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUESTIONS = [
  "Wie spät ist es gerade, und welcher Tag ist heute?",
  "Was weißt du über meine aktuellen Ziele?",
  "Gib mir einen kurzen Tipp, wie ich heute Abend besser einschlafe.",
];

await loadEnv(resolve(arg("env") ?? ".env"));
const apiKey = process.env.VOICE_ANTHROPIC_API_KEY || "";
if (!apiKey) {
  console.error("VOICE_ANTHROPIC_API_KEY fehlt (--env <pfad> zur .env)");
  process.exit(1);
}

// Erst nach loadEnv laden: die Module lesen process.env beim Import
const { createVoiceContext } = await import("../src/lib/voice-brain/context");
const { voiceStyle } = await import("../src/lib/voice-brain/style");
const { createAnthropicBackend } = await import("../src/lib/voice-brain/backends/anthropic");
const { runVoiceTurn } = await import("../src/lib/voice-brain/turn");
const { voiceAgentName } = await import("../src/lib/voice-agent-name");
const { getUserProfile } = await import("../src/agents/base");
const { default: generalAgent } = await import("../src/agents/general");
const { getMemoryContext } = await import("../src/lib/memory");
const { storeOr } = await import("../src/lib/store");
const getRecentMessages = (chatId: string, limit: number, topicId?: number | null) =>
  storeOr([], store => store.messages.recent(chatId, limit, topicId));
type Effort = import("../src/lib/voice-brain/plan").Effort;

const model = arg("model") ?? "claude-sonnet-5-5";
const effort = (arg("effort") ?? "medium") as Effort;
const runs = Math.max(1, Number(arg("runs") ?? "2"));
const show = process.argv.includes("--show");

// Cache-Zahlen aus dem Strom mitlesen, ohne den Weg zu verändern
const usage: { write: number; read: number }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const res = await realFetch(input, init);
  if (!res.body || !String(input).includes("api.anthropic.com")) return res;
  const [mine, copy] = res.body.tee();
  const entry = { write: 0, read: 0 };
  usage.push(entry);
  new Response(copy).text().then(
    (text) => {
      for (const m of text.matchAll(/"cache_creation_input_tokens":(\d+)/g)) entry.write = Math.max(entry.write, Number(m[1]));
      for (const m of text.matchAll(/"cache_read_input_tokens":(\d+)/g)) entry.read = Math.max(entry.read, Number(m[1]));
    },
    () => {}
  );
  return new Response(mine, { status: res.status, headers: res.headers });
}) as typeof fetch;

const context = createVoiceContext({
  agent: generalAgent,
  deps: { getUserProfile, getMemoryContext: () => getMemoryContext(), getRecentMessages, timeZone: process.env.USER_TIMEZONE },
});
const contextStarted = performance.now();
const contextText = await context.load(process.env.TELEGRAM_USER_ID || "");
const contextMs = performance.now() - contextStarted;
const system = [contextText, voiceStyle({ agentName: voiceAgentName(), channel: "call" })].join("\n\n");
const backend = createAnthropicBackend({ apiKey, model, effort });

console.log(`Modell ${model}, Effort ${effort}, Weg ${backend.id}, earlyFirst an`);
console.log(`Kontext ${contextText.length} Zeichen (geladen in ${Math.round(contextMs)} ms), System-Prompt ${system.length} Zeichen`);
console.log(`Messbeginn: direkt vor runVoiceTurn; ${runs} Läufe je Frage\n`);

const firstTimes: number[] = [];
for (const [qi, question] of QUESTIONS.entries()) {
  for (let run = 1; run <= runs; run++) {
    const t0 = performance.now();
    let first: number | null = null;
    let segments = 0;
    let line = "";
    for await (const event of runVoiceTurn({ backend, system, history: [], userText: question })) {
      if (event.type === "segment") {
        if (first === null) first = performance.now() - t0;
        segments++;
        if (show) console.log(`    [${segments}] ${event.text}`);
      } else if (event.type === "done") {
        line = `${event.spokenText.length} Zeichen gesprochen, ${segments} Abschnitte`;
      } else if (event.type === "error") {
        line = `FEHLER ${event.reason}`;
      }
    }
    const total = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 50));
    const cache = usage[usage.length - 1];
    if (first !== null) firstTimes.push(first);
    console.log(
      `Frage ${qi + 1} Lauf ${run}: erster Abschnitt ${first === null ? "-" : `${(first / 1000).toFixed(2)} s`}, gesamt ${(total / 1000).toFixed(2)} s, ${line}, Cache geschrieben ${cache?.write ?? 0} / gelesen ${cache?.read ?? 0} Token`
    );
  }
}

const sorted = [...firstTimes].sort((a, b) => a - b);
const median = sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2 : NaN;
console.log(
  `\nErster Abschnitt: Median ${(median / 1000).toFixed(2)} s, ${((sorted[0] ?? NaN) / 1000).toFixed(2)} bis ${((sorted[sorted.length - 1] ?? NaN) / 1000).toFixed(2)} s (${sorted.length} Läufe)`
);
process.exit(0);
