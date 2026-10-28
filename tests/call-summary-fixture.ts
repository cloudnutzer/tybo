/**
 * Eigener Prozess für tests/call-summary.test.ts (Issue #306): ruft die
 * Anruf-Zusammenfassung über src/lib/call-summary auf (seit Issue #367 der
 * Import der Aufrufer, vorher src/lib/voice) und meldet als JSON, was
 * herauskam und ob resilient-client geladen wurde.
 *
 * Erwartet: CLAUDE_PATH auf eine CLI-Attrappe bzw. AUX_MODEL_CALL_SUMMARY auf
 * ollama:<modell>, TYBO_FIXTURE_SETTINGS auf eine nicht vorhandene Datei. Für
 * Ollama ersetzt dieser Prozess fetch durch eine Attrappe; ins Netz geht nichts.
 */
import { setSettingsPath } from "../src/lib/settings";

setSettingsPath(process.env.TYBO_FIXTURE_SETTINGS!);

const ollamaCalls: string[] = [];
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  ollamaCalls.push(String(url));
  const prompt = String(JSON.parse(String(init?.body ?? "{}")).messages?.[0]?.content ?? "");
  const content = prompt.includes("END OF TRANSCRIPT") ? "Book a table for Friday" : "Ollama-Zusammenfassung";
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

const { summarizeTranscript, extractTaskFromTranscript } = await import("../src/lib/call-summary");
const summary = await summarizeTranscript("Alex: Kannst du für Freitag einen Tisch buchen?");
const task = await extractTaskFromTranscript("Alex: Kannst du für Freitag einen Tisch buchen?", summary);

// Gegenprobe: lädt den Client absichtlich, damit der Test sieht, dass die Erkennung greift
if (process.env.TYBO_FIXTURE_CONTROL === "1") await import("../src/lib/resilient-client");

const loaded = Object.keys(require.cache);
console.log(
  JSON.stringify({
    summary,
    task,
    ollamaCalls,
    resilientLoaded: loaded.some(k => k.includes("resilient-client")),
    anthropicSdkLoaded: loaded.some(k => k.includes("@anthropic-ai/sdk")),
  })
);
