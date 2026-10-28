/**
 * Sprech-Turns (Issue #249): was der Motor zusätzlich erfährt, wenn der
 * Nutzer spricht und die Antwort vorgelesen bekommt. Der Hinweis hängt nur am
 * Prompt dieses Turns (TurnOptions.turnHint in ../chat-turn.ts), nie an der
 * gespeicherten Nachricht.
 *
 * Modell für gesprochene Fragen: speech.model in config/settings.json, leer
 * = wie das Gespräch. Mit Modell gilt speech.effort, sonst medium (nur beim
 * Motor Claude, siehe TurnOptions.turnModel). Getippte Turns im selben
 * Gespräch bleiben beim Modell des Gesprächs.
 */

import type { TurnOptions } from "../chat-turn";
import { getSettings, type EffortLevel, type Settings } from "../settings";

/** Effort eines Sprech-Turns mit eigenem Modell, wenn speech.effort fehlt */
export const SPEECH_DEFAULT_EFFORT: EffortLevel = "medium";

export const SPEECH_TURN_HINT =
  "Der Nutzer spricht mit dir und hört deine Antwort vorgelesen. Antworte wie im Gespräch: kurz (meist ein bis vier Sätze), " +
  "ohne Markdown, Tabellen, Aufzählungszeichen, Code oder Links. Wenn etwas ausführlich sein muss, sag das in einem Satz " +
  "und biete an, es in den Chat zu schreiben.";

/** Was ein Sprech-Turn dem Chat-Kern mitgibt: Hinweis und, wenn eingestellt, das eigene Modell */
export function speechTurnOptions(settings: Settings = getSettings()): Pick<TurnOptions, "turnHint" | "turnModel"> {
  const model = settings.speech?.model?.trim();
  return {
    turnHint: SPEECH_TURN_HINT,
    ...(model ? { turnModel: { model, effort: settings.speech?.effort ?? SPEECH_DEFAULT_EFFORT } } : {}),
  };
}
