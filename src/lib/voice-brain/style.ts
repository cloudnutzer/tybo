/**
 * Sprechstil fuer den System-Prompt. Aus der Sprach-Brücke herausgelöst
 * (Issue #255): "phone" ist der Text der Brücke (Telefon ueber ElevenLabs),
 * "call" der Telefonhörer in der WebUI mit kürzeren Antworten.
 */

import { voiceToolsStyle, type VoiceToolsStyle } from "./tools";

export type VoiceChannel = "phone" | "call";

export interface VoiceStyleOptions {
  agentName: string;
  channel: VoiceChannel;
  /**
   * Werkzeug-Tags des Telefonhörers (Issue #259); nur bei channel "call".
   * Rechnen gibt es immer, Suche und Denkauftrag nur, wenn sie bereitstehen.
   */
  tools?: VoiceToolsStyle;
}

const phoneStyle = (agentName: string) =>
  `Du bist gerade im Sprachgespraech (Voice-Agent ${agentName}). Du sprichst, du schreibst nicht: ` +
  "Antworte in ein bis drei gesprochenen Saetzen, ausser der Nutzer will ausdruecklich mehr. " +
  "Keine Aufzaehlungen, keine Markdown-Zeichen, keine URLs vorlesen, keine Emojis. Zahlen so nennen, wie man sie sagt. " +
  "Wenn dir Kontext aus frueheren Gespraechen fehlt, nutze history_search, statt zu raten. " +
  "Wenn eine Frage echte Analyse braucht, die laenger als eine halbe Minute dauert, nutze deep_think, statt den Nutzer warten zu lassen. " +
  "Merk-Tags wie [REMEMBER: ...] oder [GOAL: ...] darfst du ans Ende setzen; sie werden nicht vorgelesen. " +
  "[INVOKE:...]-Tags funktionieren hier nicht, lass sie weg.";

/**
 * Verhörer (Issue #278): Die Äußerung kommt als erkannter Text an. Bei einem
 * unklaren Wort, von dem die Antwort abhängt, kurz mit dem wahrscheinlichsten
 * Wort nachfragen und den Turn damit beenden; bei eindeutigem Sinn direkt
 * antworten.
 */
export const CALL_MISHEARING_HINT =
  "Was der Nutzer sagt, kommt bei dir als Text eines Spracherkenners an und kann Verhörer enthalten: " +
  "verschluckte Laute, falsch getrennte oder zusammengezogene Wörter, ähnlich klingende Wörter. " +
  "Ist ein Wort unklar, unbekannt oder passt es nicht und hängt deine Antwort davon ab, rate nicht: " +
  "Frag in einem kurzen Satz mit dem wahrscheinlichsten Wort nach, etwa „Meinst du Schokoeis?“, und hör danach auf. " +
  "Bis der Nutzer bestätigt, keine Antwort, kein Werkzeug und kein Denkauftrag auf Basis deiner Vermutung. " +
  "Ist der Sinn eindeutig, antworte direkt und erwähne den Verhörer nicht.";

const callStyle =(agentName: string, tools: VoiceToolsStyle) =>
  `Du bist gerade im Sprachgespräch mit dem Nutzer (Telefonhörer in der App, Voice-Agent ${agentName}). Du sprichst, du schreibst nicht. ` +
  "Antworte meist in ein bis zwei kurzen Sätzen, höchstens rund 300 Zeichen. Mehr nur, wenn der Nutzer ausdrücklich darum bittet. " +
  "Keine Aufzählungen, keine Markdown-Zeichen, keine URLs, keine Emojis. " +
  "Zahlen, Daten und Uhrzeiten so, wie man sie spricht, gerundet, wo es der Frage reicht. " +
  "Rechne nichts im Kopf aus, was über ganz einfache Zahlen hinausgeht. " +
  CALL_MISHEARING_HINT +
  " " +
  voiceToolsStyle(tools) +
  " Merk-Tags wie [REMEMBER: ...] oder [GOAL: ...] darfst du ans Ende setzen; sie werden nicht vorgelesen. " +
  (tools.deepTask
    ? "[INVOKE:...]-Tags funktionieren hier nicht, andere Agenten fragst du über einen Denkauftrag."
    : "[INVOKE:...]-Tags funktionieren hier nicht, lass sie weg.");

export function voiceStyle({ agentName, channel, tools }: VoiceStyleOptions): string {
  return channel === "phone" ? phoneStyle(agentName) : callStyle(agentName, tools ?? { search: false, deepTask: false });
}
