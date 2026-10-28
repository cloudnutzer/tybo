/**
 * Probe der Modellwahl des Telefonhörers (Issue #256): probeCallModel über
 * den eingestellten oder einen angegebenen Weg, gemessen wird die Zeit bis
 * zum ersten sprechbaren Abschnitt.
 *
 *   bun run scripts/call-model-probe.ts [--env <pfad>] [--runs <n>] [--model <auto|kind:modell>] [--via api|cli] [--effort <stufe>]
 *
 * - Ohne --model gilt die Einstellung (config/settings.json, SPEECH_CALL_MODEL,
 *   auto). --model und --via ersetzen speech.call.model und claudeVia nur für
 *   diesen Lauf, die Datei bleibt unverändert.
 * - --runs: Läufe je Testfrage (Standard 1), also 3 × runs Turns in einem
 *   Gespräch (ein Weg, bei der CLI ein Prozess). Der erste Turn ist kalt.
 * - Messbeginn: unmittelbar vor runVoiceTurn, nach dem Laden des Kontexts.
 * - Kontext: echter Kontext wie in der Brücke; ausgegeben werden nur Längen,
 *   Zeiten und Fehlergründe, nie Antworten oder Kontexttext.
 *
 * Startet weder src/bot.ts noch src/voice-bridge.ts.
 */

import { resolve } from "path";
import { loadEnv } from "../src/lib/env";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

await loadEnv(resolve(arg("env") ?? ".env"));

// Erst nach loadEnv laden: die Module lesen process.env beim Import
const { getSettings } = await import("../src/lib/settings");
const { resolveCallModel, probeCallModel } = await import("../src/lib/voice-brain/call-model");
const { inspectEngine } = await import("../src/lib/engines/check");
type Settings = import("../src/lib/settings").Settings;

const base = getSettings();
const call = { ...(base.speech?.call ?? {}) } as NonNullable<NonNullable<Settings["speech"]>["call"]>;
if (arg("model")) call.model = arg("model");
if (arg("via")) call.claudeVia = arg("via") as "api" | "cli";
if (arg("effort")) call.effort = arg("effort") as typeof call.effort;
const settings: Settings = { ...base, speech: { ...(base.speech ?? {}), call } };

const resolution = await resolveCallModel({ settings });
const claude = await inspectEngine("claude");
console.log(`Claude Code ${claude.version ?? "?"}, Bun ${Bun.version}`);
console.log(
  `Einstellung ${resolution.setting} (${arg("model") || arg("via") || arg("effort") ? "für diesen Lauf" : resolution.source}) -> ${resolution.spec ?? "-"} über ${resolution.via ?? "-"}, Effort ${resolution.effort}, Abrechnung ${resolution.billing ?? "-"}${resolution.costsMoney ? " (kostet nach Verbrauch)" : ""}`,
);
if (!resolution.ready) {
  console.log(`Nicht bereit: ${resolution.reason}`);
  process.exit(1);
}
console.log(`Erwartung: ${resolution.expectation}`);

const runs = Math.max(1, Number(arg("runs") ?? "1"));
const result = await probeCallModel({ settings, runs, resolution });
const s = (ms: number | null) => (ms === null ? "-" : `${(ms / 1000).toFixed(2)} s`);
for (const sample of result.samples) {
  console.log(
    `Frage ${sample.question} Lauf ${sample.run}${sample.cold ? " (kalt)" : ""}: erster Abschnitt ${s(sample.firstMs)}, gesamt ${s(sample.totalMs)}${sample.error ? `, FEHLER ${sample.error.slice(0, 120)}` : ""}`,
  );
}
console.log(`\nErster Abschnitt: Median ${s(result.medianMs)}, ${s(result.minMs)} bis ${s(result.maxMs)} (${result.samples.length} Turns), warm ohne Turn 1: Median ${s(result.warmMedianMs)}`);
process.exit(0);
