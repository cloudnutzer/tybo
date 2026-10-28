/**
 * Echte Probe der Verhörer-Regel im Telefonhörer (Issue #278), von Hand
 * gestartet, kein automatischer Test. Startet und importiert nie src/bot.ts.
 * Schickt erkannten Text direkt an das echte Gesprächsmodell (ohne Erkenner,
 * damit der Verhörer genau so ankommt), mit Agent-Prompt des General-Agenten
 * und Sprechstil "call" wie im Anschluss. Je Lauf ein neuer Weg und leerer
 * Verlauf, damit kein Lauf den nächsten beeinflusst.
 *
 * Aufruf (Beispiel):
 *   bun run scripts/call-mishearing-probe.ts --via cli --runs 3 [--env-file <.env>] [--model claude:claude-sonnet-5-5] [--effort low] [--ohne-regel]
 *
 * - --via cli: Claude-Code-Sitzung (Abo, wenn ANTHROPIC_API_KEY fehlt)
 * - --via api: VOICE_ANTHROPIC_API_KEY aus --env-file (nie ausgegeben)
 * - Werkzeuge wie mit bereiter Suche und Chat-Kern: Suche als Attrappe ohne
 *   Treffer, ein Denkauftrag wird nur gemeldet, nicht gestartet.
 * - --ohne-regel: Vergleich, Sprechstil ohne die Verhörer-Regel (Stand vor #278)
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import generalAgent from "../src/agents/general";
import { CALL_DEFAULT_CLAUDE, CALL_DEFAULT_EFFORT, createCallBackend, resolveCallModel } from "../src/lib/voice-brain/call-model";
import { CALL_MISHEARING_HINT, voiceStyle } from "../src/lib/voice-brain/style";
import { runVoiceTurn } from "../src/lib/voice-brain/turn";

const { values } = parseArgs({
  options: {
    via: { type: "string", default: "cli" },
    runs: { type: "string", default: "3" },
    "env-file": { type: "string" },
    model: { type: "string", default: CALL_DEFAULT_CLAUDE },
    effort: { type: "string", default: CALL_DEFAULT_EFFORT },
    "ohne-regel": { type: "boolean", default: false },
  },
});

const QUESTIONS = [
  "Wenn ich Schokoi selber machen will, was muss ich da reinmachen?",
  "Wie wird das Wetter morgen in Berlin?",
];

const via = values.via === "api" ? "api" : "cli";
const env: Record<string, string | undefined> = { ...process.env };
if (via === "api") {
  if (!values["env-file"]) throw new Error("--via api braucht --env-file");
  const line = (await readFile(values["env-file"], "utf8")).split("\n").find((l) => l.startsWith("VOICE_ANTHROPIC_API_KEY="));
  env.VOICE_ANTHROPIC_API_KEY = line?.slice("VOICE_ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
  process.env.VOICE_ANTHROPIC_API_KEY = env.VOICE_ANTHROPIC_API_KEY;
}

const resolution = await resolveCallModel({
  env,
  settings: { speech: { call: { model: values.model, claudeVia: via, effort: values.effort as typeof CALL_DEFAULT_EFFORT } } } as never,
});
if (!resolution.ready) throw new Error(resolution.reason ?? "Weg nicht bereit");
console.log(`Weg: ${resolution.via}, Modell: ${resolution.model}, Effort: ${resolution.effort}, Abrechnung: ${resolution.billing}`);

let style = voiceStyle({ agentName: "Mia", channel: "call", tools: { search: true, deepTask: true } });
if (values["ohne-regel"]) style = style.replace(`${CALL_MISHEARING_HINT} `, "");
console.log(`Verhörer-Regel: ${style.includes(CALL_MISHEARING_HINT) ? "an" : "aus"}`);
const system = [generalAgent.systemPrompt, style].join("\n\n");
const runs = Math.max(1, Number(values.runs) || 1);

for (const question of QUESTIONS) {
  console.log(`\n### ${question}`);
  for (let run = 1; run <= runs; run++) {
    const backend = createCallBackend(resolution, { reserveRequest: () => () => {}, env });
    const tools: string[] = [];
    let raw = "";
    try {
      for await (const event of runVoiceTurn({
        backend,
        system,
        history: [],
        userText: question,
        tools: { search: async () => "Keine Treffer im Verlauf.", deepTask: true },
      })) {
        if (event.type === "tool") tools.push(event.phase === "call" ? `denkauftrag(${event.task})` : event.name);
        if (event.type === "done") raw = event.rawText;
        if (event.type === "error") raw = `FEHLER ${event.reason}: ${event.message} | ${event.rawText}`;
      }
    } finally {
      backend.close?.();
    }
    console.log(`Lauf ${run}: ${raw.replace(/\s+/g, " ").trim()}${tools.length ? `  [Werkzeuge: ${tools.join(", ")}]` : ""}`);
  }
}
