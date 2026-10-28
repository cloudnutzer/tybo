/**
 * Name des Sprachagenten (Issue #138): Begrüßung am Telefon, Sprechstil und
 * Denkauftrag der Sprach-Brücke nennen ihn. Aus VOICE_AGENT_NAME, leer oder
 * nicht gesetzt heißt BRAND.name. Gelesen wird bei jedem Aufruf, nicht beim
 * Laden des Moduls.
 */
import { BRAND } from "../brand";

export function voiceAgentName(env: { VOICE_AGENT_NAME?: string } = { VOICE_AGENT_NAME: process.env.VOICE_AGENT_NAME }): string {
  return env.VOICE_AGENT_NAME?.trim() || BRAND.name;
}
