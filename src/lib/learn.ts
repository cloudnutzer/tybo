/**
 * /learn — Quelle in die Knowledge Base destillieren
 * (nach dem Vorbild von Hermes' /learn).
 *
 * Nimmt eine URL (Scrape via Firecrawl-Built-in, REST-Backup inklusive)
 * oder direkt eingefuegten Text, laesst das Aux-Modell die Essenz als
 * kompakten Knowledge-Eintrag extrahieren und speichert ihn kategorisiert
 * (mit Embedding) in der Knowledge Base — die haengt bereits im Prompt
 * jedes Agenten.
 */

import { BRAND } from "../brand";
import { callBuiltinTool } from "./tools";
import { callAux, parseAuxJSON } from "./aux-model";
import { addKnowledge, type KnowledgeCategory } from "./knowledge-base";
import { checkAborted, executionSignal } from "./execution-context";
import { sanitizeModelOutput } from "./telegram";

const VALID_CATEGORIES: KnowledgeCategory[] = [
  "project",
  "person",
  "preference",
  "learning",
  "process",
  "decision",
  "reference",
  "tool",
];

const MAX_SOURCE_CHARS = 20_000;

function isUrl(input: string): boolean {
  return /^https?:\/\/\S+$/i.test(input.trim());
}

/** Grober HTML-zu-Text-Fallback, wenn Firecrawl nicht verfuegbar ist. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function fetchSource(url: string): Promise<string | null> {
  // 1. Firecrawl-Built-in (faellt intern auf REST zurueck)
  try {
    const result = await callBuiltinTool("firecrawl_scrape", { url });
    if (!result.isError) {
      const parsed = JSON.parse(result.content);
      const md = parsed.markdown || parsed.content;
      if (typeof md === "string" && md.length > 100) return md;
    }
  } catch {}
  // Nach /stop oder Stopp-Knopf keinen Fallback mehr starten
  checkAborted();
  // 2. Direkter Fetch als Fallback
  try {
    const res = await fetch(url, {
      signal: executionSignal(30_000),
      headers: { "User-Agent": `Mozilla/5.0 (${BRAND.name} /learn)` },
    });
    if (!res.ok) return null;
    const body = await res.text();
    const text = stripHtml(body);
    return text.length > 100 ? text : null;
  } catch {
    checkAborted();
    return null;
  }
}

export interface LearnResult {
  ok: boolean;
  message: string;
}

/**
 * onWriteStart (Befehle aus Browser und Terminal, Issue #74): verbindlicher
 * Schreibbeginn direkt vor dem Speichern. Wirft er, wird nichts gespeichert;
 * kehrt er zurueck, laeuft das Speichern zu Ende und sein Ergebnis zaehlt.
 */
export async function learnFromSource(input: string, onWriteStart?: () => void): Promise<LearnResult> {
  const trimmed = input.trim();
  const fromUrl = isUrl(trimmed);

  let source: string | null;
  if (fromUrl) {
    source = await fetchSource(trimmed);
    checkAborted();
    if (!source) {
      return {
        ok: false,
        message: `Ich konnte die Seite nicht laden: ${trimmed}\nFirecrawl und direkter Abruf sind beide gescheitert.`,
      };
    }
  } else {
    source = trimmed;
    if (source.length < 80) {
      return {
        ok: false,
        message:
          "Zu wenig Inhalt zum Lernen. Nutzung: /learn <URL> oder /learn <laengerer Text>.",
      };
    }
  }

  const prompt = `Destilliere die folgende Quelle in EINEN kompakten Knowledge-Base-Eintrag.

${fromUrl ? `QUELLE (URL): ${trimmed}` : "QUELLE: vom User eingefuegter Text"}

INHALT:
${source.substring(0, MAX_SOURCE_CHARS)}

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt:
{
  "title": "praegnanter Titel (max 80 Zeichen)",
  "category": "${VALID_CATEGORIES.join('" | "')}",
  "content": "die Essenz in 5-15 Saetzen: Kernaussagen, konkrete Fakten, Zahlen, Namen. Keine Floskeln, kein Marketing. So geschrieben, dass es in Monaten noch verstaendlich ist.",
  "tags": ["tag1", "tag2", "tag3"]
}`;

  const result = await callAux("review", prompt, { timeoutMs: 180_000 });
  if (result.isError) {
    return { ok: false, message: "Die Destillation ist fehlgeschlagen (Aux-Modell nicht erreichbar)." };
  }
  const parsed = parseAuxJSON(result.text);
  if (!parsed?.title || !parsed?.content) {
    return { ok: false, message: "Die Destillation lieferte kein brauchbares Ergebnis." };
  }

  const category: KnowledgeCategory = VALID_CATEGORIES.includes(parsed.category)
    ? parsed.category
    : "reference";

  // Nach /stop oder Stopp-Knopf nichts mehr in die Knowledge Base schreiben;
  // ab dem Schreibbeginn kein Abbruch mehr, das Speichern startet im selben Schritt
  checkAborted();
  onWriteStart?.();
  try {
    const stored = await addKnowledge({
      category,
      title: String(parsed.title).substring(0, 120),
      content: String(parsed.content).substring(0, 4000),
      source: fromUrl ? trimmed : "telegram /learn",
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 8).map(String) : undefined,
    });
    if (!stored.ok) return { ok: false, message: stored.message };
  } catch (err) {
    console.error("[Learn] addKnowledge failed:", err);
    return { ok: false, message: "Speichern in der Knowledge Base ist fehlgeschlagen (siehe Logs)." };
  }

  // Geht nur an Telegram: vor dem Kürzen bereinigt (Issue #52)
  const shown = sanitizeModelOutput(String(parsed.content));
  return {
    ok: true,
    message: `📚 Gelernt und gespeichert (${category}):\n**${parsed.title}**\n\n${shown.substring(0, 600)}${shown.length > 600 ? "..." : ""}`,
  };
}
