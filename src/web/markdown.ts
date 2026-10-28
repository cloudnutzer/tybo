/**
 * Markdown der Antworten sicher als HTML für den Browser.
 *
 * Rohes HTML wird escaped, Links nur mit http:, https: oder mailto:,
 * Bilder werden zu Links (nichts wird nachgeladen). Läuft auf dem Server,
 * der Browser zeigt nur das fertige HTML an (siehe decisions/0002).
 */

import { Marked, type Tokens } from "marked";
import { questionTagSpans } from "./question-tags";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Normalisierte URL, wenn das Protokoll erlaubt ist; sonst null. */
function safeUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  let url: URL;
  try {
    // ohne Basis-URL scheitern relative und protokollrelative Adressen
    url = new URL(href.trim());
  } catch {
    return null;
  }
  return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : null;
}

function anchor(href: string, title: string | null | undefined, inner: string): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(href)}"${titleAttr} rel="noopener noreferrer" target="_blank">${inner}</a>`;
}

const marked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      // "=" als Zeichenreferenz: auch der Quelltext enthält dann kein "onerror="
      return escapeHtml(text).replace(/=/g, "&#61;");
    },
    link({ href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      const url = safeUrl(href);
      return url ? anchor(url, title, inner) : inner;
    },
    image({ href, title, text }: Tokens.Image) {
      const label = escapeHtml(text || href || "Bild");
      const url = safeUrl(href);
      return url ? anchor(url, title, label) : label;
    },
    code({ text, lang }: Tokens.Code) {
      // nur der harmlose Anfang des ersten Worts, z.B. "ts" aus "ts title=x"
      const language = /^[\w+-]*/.exec((lang ?? "").trim())![0];
      const cls = language ? ` class="language-${language}"` : "";
      return `<pre><code${cls}>${escapeHtml(text.replace(/\n$/, ""))}</code></pre>\n`;
    },
  },
});

// Dieselben Muster wie die Merk-Tags (src/lib/memory/intents.ts), stripConsultTags
// (src/lib/agent-consult.ts) und stripAssetDescTag (src/lib/asset-store.ts).
// Bewusst kopiert statt importiert: processIntents schreibt ins Gedächtnis,
// stripAssetDescTag klebt Wörter zusammen ("A [ASSET_DESC: x] B" wird "AB"),
// und der Importbaum von web:dev bleibt in src/web.
const CONTROL_TAGS = [
  /[ \t]*\[(?:GOAL|DONE|CANCEL|REMEMBER|FORGET|KNOWLEDGE|REMIND):\s*[^\]]+?\s*\]/gi,
  /[ \t]*\[INVOKE:[\w-]+\|[^\]]+\]/g,
  /[ \t]*\[ASSET_DESC:[^\]]+\]/g,
];

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// Rückfrage-Tag (Issue #336, src/lib/turn-questions.ts): wird nicht entfernt,
// sondern lesbar, damit Frage und Antworten auch ohne Knöpfe dastehen.
// Der Chat-Kern macht das schon vor dem Speichern; hier für Texte, die den
// Tag noch enthalten. Welche Tags zählen, entscheidet dieselbe Erkennung wie
// im Chat-Kern (question-tags.ts): in Code, Zitaten und Anführungszeichen
// bleibt er stehen wie geschrieben.
function readableQuestion(question: string, answers: string[]): string {
  const lines = [question, ...answers.map(a => `- ${a}`)].filter(Boolean);
  return lines.length ? `\n\n${lines.join("\n")}\n\n` : ` ${REMOVED}`;
}

const isBlank = (c: string | undefined) => c === " " || c === "\t";

function readableQuestions(text: string): string {
  let out = "";
  let from = 0;
  for (const span of questionTagSpans(text)) {
    // Leerraum davor und danach auf derselben Zeile gehört zum Tag
    let start = span.start;
    while (start > from && isBlank(text[start - 1])) start--;
    let end = span.end;
    while (isBlank(text[end])) end++;
    out += text.slice(from, start) + readableQuestion(span.question, span.options);
    from = end;
  }
  return out + text.slice(from);
}

// markiert die Stelle eines entfernten Tags, bis die Zeilen aufgeräumt sind
const REMOVED = "\u0000";

/**
 * Zeilen, die nur aus Tags bestanden, fallen ganz weg; mehrere Leerzeilen
 * werden zu einer. Codeblöcke bleiben bis auf die Tags selbst unverändert.
 */
function cleanupLines(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of text.split("\n")) {
    if (raw.includes(REMOVED) && raw.replaceAll(REMOVED, "").trim() === "") continue;
    const line = raw.replaceAll(REMOVED, "");
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (marker) fence = marker;
    if (line.trim() === "") {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * Entfernt die Steuer-Tags ([GOAL:], [DONE:], [CANCEL:], [REMEMBER:],
 * [FORGET:], [KNOWLEDGE:], [REMIND:], [INVOKE:...|...], [ASSET_DESC:]) aus einer Antwort.
 * [FRAGE:] wird zu Frage und Antwortliste (außerhalb von Codeblöcken).
 * Nur für die Anzeige: verarbeitet nichts, die Gedächtnisverarbeitung
 * bekommt weiter den unveränderten Text.
 */
export function stripControlTags(text: string): string {
  let clean = readableQuestions(text.replaceAll(REMOVED, ""));
  for (const re of CONTROL_TAGS) clean = clean.replace(re, REMOVED);
  return cleanupLines(clean);
}

/** Antwort als sicheres HTML: erst Steuer-Tags entfernen, dann Markdown (GFM) rendern. */
export function renderMarkdown(text: string): string {
  return marked.parse(stripControlTags(text), { async: false }) as string;
}
