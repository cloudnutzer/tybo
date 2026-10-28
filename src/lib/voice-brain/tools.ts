/**
 * Werkzeuge im Telefonhörer als Tags im Text (Issue #259, Entscheidung 0024):
 * [SUCHE: <Begriffe>], [RECHNE: <Ausdruck>], [DENKAUFTRAG: <Aufgabe>].
 * Kein Function Calling: Tags gehen mit jedem Weg (Messages API, offene
 * CLI-Sitzung ohne MCP, OpenRouter, Ollama).
 *
 * - Beginn eines Tags: "[" plus Name plus ":" (Groß- und Kleinschreibung
 *   egal, Leerraum nach "[" erlaubt). Ab dann ist es ein Werkzeug-Tag und wird
 *   nie gesprochen.
 * - Vollständig: mit der schließenden "]" (innere Klammern mitgezählt).
 * - Ein Tag ohne "]" am Ende der Antwort bleibt unvollständig: nicht
 *   gesprochen, nicht ausgeführt.
 * - Alles, was nicht zu einem Werkzeug-Tag werden kann, geht sofort weiter
 *   (Merk-Tags filtert danach der Satz-Strom).
 */

import { evaluateExpression } from "./calc";

export type VoiceToolName = "suche" | "rechne" | "denkauftrag";

const TOOL_TAGS: Record<string, VoiceToolName> = { SUCHE: "suche", RECHNE: "rechne", DENKAUFTRAG: "denkauftrag" };
/** Tag-Namen, die der Satz-Strom zusätzlich nie vorliest */
export const TOOL_TAG_NAMES = Object.keys(TOOL_TAGS);

/** Höchstens so viele Werkzeug-Runden je Turn; danach antwortet das Modell mit dem, was es hat */
export const MAX_TOOL_ROUNDS = 2;
/** Suche im Verlauf höchstens so lange */
export const SEARCH_TIMEOUT_MS = 8_000;
/** Suchergebnis höchstens so lang (wie history_search in der Brücke) */
export const SEARCH_RESULT_MAX_CHARS = 6_000;
/** Ohne "]" nach so vielen Zeichen gilt ein Tag als kaputt; es bleibt trotzdem stumm */
const MAX_TAG_CHARS = 2_000;

/** Feste Sätze der Ansagen („Moment, ich schaue nach.“) spricht der Aufrufer: src/web/call-protocol.ts */
export const TOOL_TEXT = {
  searchNothing: "Dazu finde ich gerade nichts.",
  searchLabel: "[Suchergebnis, nicht vom Nutzer gesprochen]",
  calcLabel: "[Rechenergebnis, nicht vom Nutzer gesprochen]",
  calcError: "Rechenfehler",
  lastRound: "Keine weiteren Werkzeuge mehr in dieser Antwort: antworte jetzt mit dem, was du hast.",
} as const;

export type ToolScanEvent =
  | { type: "text"; text: string }
  | { type: "start"; name: VoiceToolName }
  | { type: "tag"; name: VoiceToolName; arg: string; raw: string }
  | { type: "incomplete"; name: VoiceToolName };

/** Index der "]", die das "[" am Anfang schließt (innere Klammern mitgezählt), sonst -1 */
function closingBracket(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Was ist dieses "[..." am Anfang? "maybe": kann noch ein Werkzeug-Tag werden
 * (mehr Text abwarten), "no": sicher keins, sonst der Name samt Länge des
 * Kopfs bis einschließlich ":".
 */
function classifyOpen(text: string): "maybe" | "no" | { name: VoiceToolName; head: number } {
  const m = /^\[(\s*)([A-Za-zÄÖÜäöü_]*)/.exec(text)!;
  const name = m[2].toUpperCase();
  const after = text.slice(m[0].length);
  const names = TOOL_TAG_NAMES;
  if (!after) {
    // Ende des bisherigen Texts: Name noch unvollständig oder ":" fehlt noch
    return names.some((n) => n.startsWith(name)) ? "maybe" : "no";
  }
  if (!names.includes(name)) return "no";
  const colon = /^\s*:/.exec(after);
  if (colon) return { name: TOOL_TAGS[name], head: m[0].length + colon[0].length };
  // Nur Leerraum nach dem Namen: ":" kann noch kommen
  return /^\s*$/.test(after) ? "maybe" : "no";
}

/**
 * Erkennt Werkzeug-Tags in einem laufenden Modell-Strom. push() liefert
 * Text, Beginn ("start", genau einmal je Tag) und vollständige Tags; was nach
 * einem vollständigen Tag kommt, liefert es weiter (der Turn entscheidet, ob
 * er es verwirft). flush() am Ende: Rest als Text oder ein unvollständiges Tag.
 */
export class ToolTagScanner {
  private buf = "";
  /** Laufendes Tag: Name, Beginn schon gemeldet */
  private open: VoiceToolName | null = null;

  push(chunk: string): ToolScanEvent[] {
    this.buf += chunk;
    const out: ToolScanEvent[] = [];
    while (this.buf) {
      if (this.open) {
        const end = closingBracket(this.buf);
        if (end < 0) {
          // Kaputtes Tag ohne "]": weiter schlucken, nie sprechen
          if (this.buf.length > MAX_TAG_CHARS) this.buf = this.buf.slice(-1);
          break;
        }
        const raw = this.buf.slice(0, end + 1);
        const name = this.open;
        const colon = raw.indexOf(":");
        out.push({ type: "tag", name, arg: raw.slice(colon + 1, -1).trim(), raw });
        this.open = null;
        this.buf = this.buf.slice(end + 1);
        continue;
      }
      const i = this.buf.indexOf("[");
      if (i < 0) {
        out.push({ type: "text", text: this.buf });
        this.buf = "";
        break;
      }
      if (i > 0) {
        out.push({ type: "text", text: this.buf.slice(0, i) });
        this.buf = this.buf.slice(i);
      }
      const kind = classifyOpen(this.buf);
      if (kind === "maybe") break;
      if (kind === "no") {
        out.push({ type: "text", text: "[" });
        this.buf = this.buf.slice(1);
        continue;
      }
      this.open = kind.name;
      out.push({ type: "start", name: kind.name });
      // Kopf bleibt im Puffer, damit die Klammerzählung beim "[" beginnt
    }
    return mergeText(out);
  }

  flush(): ToolScanEvent[] {
    const rest = this.buf;
    this.buf = "";
    if (this.open) {
      const name = this.open;
      this.open = null;
      return [{ type: "incomplete", name }];
    }
    return rest ? [{ type: "text", text: rest }] : [];
  }
}

function mergeText(events: ToolScanEvent[]): ToolScanEvent[] {
  const out: ToolScanEvent[] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (ev.type === "text" && last?.type === "text") last.text += ev.text;
    else if (ev.type !== "text" || ev.text) out.push(ev);
  }
  return out;
}

/** Ergebnis von [RECHNE:] als Nachricht an das Modell */
export function calcResultMessage(expr: string): string {
  const r = evaluateExpression(expr);
  return `${TOOL_TEXT.calcLabel}\n${r.ok ? `${expr.trim()} = ${r.text}` : TOOL_TEXT.calcError}`;
}

/** Ergebnis von [SUCHE:] als Nachricht an das Modell, höchstens 6.000 Zeichen Inhalt */
export function searchResultMessage(result: string): string {
  return `${TOOL_TEXT.searchLabel}\n${result.slice(0, SEARCH_RESULT_MAX_CHARS)}`;
}

export interface VoiceToolsStyle {
  search: boolean;
  deepTask: boolean;
}

/** Sprechstil-Zusatz für den Telefonhörer: die Tags in wenigen Sätzen */
export function voiceToolsStyle({ search, deepTask }: VoiceToolsStyle): string {
  const lines = [
    "Werkzeuge schreibst du als Tag ganz an den Anfang deiner Antwort, ohne Satz davor; Tags werden nie vorgelesen.",
    ...(search
      ? ["Fehlt dir Wissen aus früheren Gesprächen, schreib [SUCHE: <Suchbegriffe>] und sonst nichts; das Ergebnis bekommst du gleich als nächste Nachricht."]
      : []),
    "Zum Rechnen schreib [RECHNE: <Ausdruck>] mit Zahlen, + - * /, Klammern und %, etwa [RECHNE: 18 % von 2.450], und sonst nichts; das Ergebnis bekommst du gleich.",
    ...(deepTask
      ? [
          "Braucht eine Aufgabe echte Arbeit (Recherche im Web, Mail, Kalender, Dateien, längere Analyse, etwas ändern oder anlegen), schreib [DENKAUFTRAG: <die Aufgabe vollständig formuliert, mit allem Kontext aus dem Gespräch>]; der volle Bot arbeitet sie aus und schreibt das Ergebnis ins Gespräch.",
        ]
      : []),
    "Höchstens zwei Werkzeuge je Antwort.",
  ];
  return lines.join(" ");
}
