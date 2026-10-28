/**
 * Sprachprüfungen von `tybo pruefen` (Issue #372, vorher in setup/verify.ts).
 *
 * Lokales Hören und lokale Stimme (Issue #251, #252): nur Dateien und
 * Nachweis über src/setup/speech-maintenance.ts, nie ein Prozess (kein
 * sherpa-onnx, kein Pocket TTS). Eine Zeile gibt es nur, wenn die Einstellung
 * darauf zeigt.
 *
 * Telefonhörer (Issue #260): ob ein Modellweg bereit ist, geprüft wie im Bot
 * (callWays, resolveCallModel), aber nie mit einem Modellaufruf.
 *
 * Projektordner, Einstellungsdatei, Plattform und Architektur kommen aus dem
 * Kontext des Berichts, die Umgebung aus der .env des Projekts.
 */

import { readFileSync } from "node:fs";
import { settingsSchema, type Settings } from "../../lib/settings";
import { callWays, resolveCallModel, type CallModelDeps, type CallModelResolution } from "../../lib/voice-brain/call-model";
import type { SetupContext } from "../context";
import { checkLocalStt, checkLocalTts } from "../speech-maintenance";
import type { Finding } from "./report";

type Env = Record<string, string | undefined>;

/** Was die Sprachprüfungen vom Kontext brauchen */
export type SpeechCheckContext = Pick<SetupContext, "root" | "settingsPath" | "platform" | "arch">;

const CALL_LABEL = "Telefonhörer";

function settingsText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Geprüfte Einstellungen; fehlt die Datei oder ist sie ungültig, gelten Umgebung und Standard */
function parsedSettings(path: string): Settings {
  const text = settingsText(path);
  if (text === null) return {};
  try {
    const result = settingsSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}

/** Parakeet und lokale Stimme, je eine Zeile, wenn sie eingestellt sind */
export function speechFindings(ctx: SpeechCheckContext, env: Env): Finding[] {
  const text = settingsText(ctx.settingsPath);
  const hearing = checkLocalStt({ root: ctx.root, platform: ctx.platform, arch: ctx.arch ?? process.arch, settingsText: text, envStt: env.SPEECH_STT });
  const voice = checkLocalTts({ root: ctx.root, settingsText: text, envTts: env.SPEECH_TTS, pocketVoice: env.POCKET_TTS_VOICE });
  return [hearing, voice].filter(r => r !== null).map(r => ({ label: r.name, status: r.status, detail: r.message }));
}

function billingNote(active: Pick<CallModelResolution, "billing" | "costsMoney">): string {
  if (active.billing === "subscription") return ", zählt gegen das Guthaben des Abos";
  return active.costsMoney ? ", kostet pro Turn" : "";
}

/**
 * Eine Zeile zum Telefonhörer: bereit mit Weg, Modell und Abrechnung; ohne
 * bereiten Weg übersprungen (es bleibt beim Sprechmodus); ist der
 * eingestellte Weg nicht bereit, eine Warnung mit den bereiten Wegen.
 * deps ersetzen die Prüfung von Claude Code und Ollama.
 */
export async function callFinding(ctx: Pick<SetupContext, "settingsPath">, env: Env, deps: Partial<CallModelDeps> = {}): Promise<Finding> {
  const input = { ...deps, env, settings: parsedSettings(ctx.settingsPath) };
  try {
    const ready = (await callWays(input)).filter(w => w.ready);
    if (ready.length === 0) {
      return { label: CALL_LABEL, status: "skip", detail: "kein Modellweg bereit, es bleibt beim Sprechmodus (tybo setup sprache, Weg Telefonhörer)" };
    }
    const active = await resolveCallModel(input);
    if (!active.ready) {
      const options = ready.map(w => w.label).join(", ");
      return { label: CALL_LABEL, status: "warn", detail: `eingestellter Weg nicht bereit (${active.reason ?? "unbekannt"}); bereit wären: ${options}` };
    }
    return { label: CALL_LABEL, status: "pass", detail: `bereit über ${active.via} mit ${active.model}${billingNote(active)}` };
  } catch (e) {
    // Nur die Art des Fehlers: der Text könnte Werte aus der Umgebung enthalten
    return { label: CALL_LABEL, status: "warn", detail: `ließ sich nicht prüfen (${e instanceof Error ? e.name : typeof e})` };
  }
}
