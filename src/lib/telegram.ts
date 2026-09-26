/**
 * Go - Telegram Helpers
 *
 * Send messages, convert Markdown to Telegram HTML, chunk long messages.
 */

import { Context, InputFile, type Transformer } from "grammy";

// ============================================================
// FORMAT RULES (shared by every system prompt)
// ============================================================

/**
 * Telegram has no table element. Markdown pipe tables arrive as raw "|"
 * characters and the line wraps on a phone screen tear the columns apart.
 * The converter below is the safety net; this rule keeps the models from
 * producing tables in the first place.
 */
export const TELEGRAM_FORMAT_RULES = `FORMATTING (Telegram, read on a phone screen):
- NEVER use tables: no Markdown pipe tables, no ASCII or box-drawn tables in code blocks. Telegram cannot render them and line wraps destroy the columns.
- For comparisons and structured data use lists instead: one bold heading per item (product, option, candidate), then one "Label: value" line per attribute below it. For plain key/value pairs use "- **Key**: value" lines.
- Bold, italic, inline code, code blocks (commands and code only), links and bullet lists render fine.`;

// ============================================================
// TABLE → LIST CONVERTER
// ============================================================

const TABLE_SEPARATOR_CELL = /^:?-+:?$/;
/** Lines made only of border characters: +----+, ┌───┬───┐, ╠═══╬═══╣, |----|. */
const BOX_BORDER_LINE = /^[\s+\-=|│─┼├┤┬┴┌┐└┘╔╗╚╝═║╠╣╦╩╬]+$/;
/** Code fence languages that may carry an ASCII table instead of code. */
const TABLE_CODE_LANGS = new Set(["", "text", "txt", "plain", "plaintext", "md", "markdown"]);

/** Split one table row into trimmed cells. Honours escaped pipes (\|). */
function splitTableRow(line: string): string[] {
  const PIPE_PH = "\x01";
  let s = line.trim().replace(/\\\|/g, PIPE_PH);
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim().split(PIPE_PH).join("|"));
}

function isSeparatorRow(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => TABLE_SEPARATOR_CELL.test(c));
}

/**
 * Render header + rows as a Telegram-friendly list.
 * - Two columns: "- **key**: value" per row.
 * - More columns: bold heading (first cell) per row, then "- Label: value"
 *   for every non-empty remaining cell.
 */
function renderTableAsList(headers: string[], rows: string[][]): string {
  const plain = (c: string) => c.replace(/\*\*/g, "").trim();
  const cols = Math.max(headers.length, ...rows.map((r) => r.length));
  if (rows.length === 0) return headers.map((h) => `- ${plain(h)}`).filter((l) => l !== "- ").join("\n");

  if (cols <= 2) {
    const lines: string[] = [];
    for (const row of rows) {
      const key = plain(row[0] ?? "");
      const val = (row[1] ?? "").trim();
      if (!key && !val) continue;
      lines.push(!val ? `- ${key}` : !key ? `- ${val}` : `- **${key}**: ${val}`);
    }
    return lines.join("\n");
  }

  const blocks: string[] = [];
  for (const row of rows) {
    const heading = plain(row[0] ?? "");
    const lines: string[] = [];
    for (let i = 1; i < cols; i++) {
      const val = (row[i] ?? "").trim();
      if (!val) continue;
      const label = plain(headers[i] ?? "");
      lines.push(label ? `- ${label}: ${val}` : `- ${val}`);
    }
    if (!heading && lines.length === 0) continue;
    blocks.push([heading ? `**${heading}**` : "", ...lines].filter(Boolean).join("\n"));
  }
  return blocks.join("\n\n");
}

/**
 * Replace every Markdown pipe table in `text` with a list (see renderTableAsList).
 * A table is a line containing "|" followed by a separator row (|---|---|);
 * body rows continue until the first line without a pipe or a blank line.
 * Surrounding prose is left untouched.
 */
export function convertTablesToLists(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        if (!isSeparatorRow(lines[j])) rows.push(splitTableRow(lines[j]));
        j++;
      }
      out.push(renderTableAsList(headers, rows));
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

/**
 * Convert an ASCII / box-drawn table inside a plain code fence into a list.
 * Returns null when the block does not look like a table, so real code is
 * never touched. Only called for fences without a programming language tag.
 */
export function asciiTableToList(code: string): string | null {
  const normalized = code.replace(/[│║]/g, "|").replace(/[─═]/g, "-");
  const lines = normalized.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
  const content = lines.filter((l) => !BOX_BORDER_LINE.test(l) && !isSeparatorRow(l));
  if (content.length === lines.length || content.length < 2) return null; // no separator → not a table
  if (!content.every((l) => l.includes("|"))) return null;
  const headers = splitTableRow(content[0]);
  const rows = content.slice(1).map(splitTableRow);
  if (headers.length < 2 || rows.length === 0) return null;
  return renderTableAsList(headers, rows);
}

// ============================================================
// MODEL OUTPUT SANITIZER (Entscheidung 0008, Punkt 1; Issue #52)
// ============================================================

/**
 * Unsichtbare Zeichen, die immer entfernt werden:
 * - U+200B Zero Width Space, U+200C Zero Width Non-Joiner
 * - U+2060 bis U+2064 Word Joiner und unsichtbare Operatoren
 * - U+FEFF Zero Width No-Break Space (BOM), U+180E Mongolian Vowel Separator
 * - U+FE00 bis U+FE0D Variation Selectors (FE0E/FE0F bleiben: Text-/Emoji-Darstellung)
 * - U+E0100 bis U+E01EF Variation Selectors Supplement (beliebter Datenschmuggel)
 */
const INVISIBLE_CHARS = /[​‌⁠-⁤﻿᠎︀-︍]|[\u{E0100}-\u{E01EF}]/gu;

/**
 * Unicode-Tag-Zeichen U+E0000 bis U+E007F. Erhalten bleiben nur die drei
 * RGI-Flaggen, die Tags brauchen (England, Schottland, Wales hinter U+1F3F4).
 */
const TAG_CHARS_OR_FLAG =
  /\u{1F3F4}(?:\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F})|[\u{E0000}-\u{E007F}]/gu;

/**
 * U+200D Zero Width Joiner bleibt nur zwischen Emoji (👨‍👩‍👧, 🏳️‍🌈, 👩🏽‍💻):
 * davor ein Piktogramm, ein Hautton oder U+FE0F, danach ein Piktogramm.
 */
const ZWJ = "‍";
const EMOJI_BEFORE_ZWJ = /^[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️]$/u;
const EMOJI_AFTER_ZWJ = /^\p{Extended_Pictographic}$/u;

/** Entfernt jeden ZWJ, der nicht zwischen zwei Emoji steht (Schleife über Codepunkte) */
function stripStrayZwj(text: string): string {
  if (!text.includes(ZWJ)) return text;
  const chars = Array.from(text);
  return chars
    .filter((c, i) => c !== ZWJ || (EMOJI_BEFORE_ZWJ.test(chars[i - 1] ?? "") && EMOJI_AFTER_ZWJ.test(chars[i + 1] ?? "")))
    .join("");
}

/** Schon umgewandeltes Bild in Telegram-HTML: !<a href="…">alt</a> */
const HTML_IMAGE_LINK = /!<a\s[^>]*>([\s\S]*?)<\/a>/gi;

/** Ersatz für ein Bild ohne Bildtext */
export const IMAGE_PLACEHOLDER = "[Bild]";

// Maßstab ist, was Telegram tatsächlich darstellt, nicht ein Markdown-Parser:
// Telegram kennt kein Markdown, es sieht nur das HTML aus markdownToTelegramHTML
// oder Klartext. Ein Bild kann eine Adresse nur dort verstecken, wo unser
// Umwandler aus ![alt](url) einen Link macht. Genau diese Form wird hier mit
// denselben Mustern wie im Umwandler (Code-Blöcke, Inline-Code, Link-Muster)
// zu ihrem Bildtext. Alles andere (Referenz-Bilder, angeschnittene Syntax nach
// einer Kürzung) zeigt Telegram als sichtbaren Text, und die Adresse wird nie
// abgerufen, weil die Link-Vorschau überall aus ist (Präzisierung zu #52).
// Normaler Text wird nie umgeschrieben.

/** Fenced Code und Inline-Code wie in markdownToTelegramHTML (Schritt 1 und 2) */
// In derselben Reihenfolge wie der Umwandler: erst Fences, dann Inline-Code im Rest
const MD_FENCE = /```\w*\n[\s\S]*?```/g;
const MD_INLINE_CODE = /`[^`\n]+`/g;
/** ![alt](url) mit dem Link-Muster aus markdownToTelegramHTML; Bildtext darf leer sein */
// Obermenge des Link-Musters im Umwandler ([^)]+): zuerst mit einer Ebene
// Klammern in der Adresse (https://a.b/x_(1)/y.png), sonst wie der Umwandler.
const MD_IMAGE = /!\[([^\]]*)\]\((?:(?:[^()]|\([^()]*\))+|[^)]+)\)/g;
/** <pre>/<code> in Telegram-HTML */
const HTML_CODE = /<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Steht vor i eine ungerade Zahl Backslashes (Zeichen an i also maskiert)? */
function isEscaped(text: string, i: number): boolean {
  let n = 0;
  while (text[i - 1 - n] === "\\") n++;
  return n % 2 === 1;
}

/**
 * Wendet replace auf den Text an, in dem Code durch Platzhalter ersetzt ist,
 * genau wie markdownToTelegramHTML es macht (Schritt 1 und 2). So erkennt
 * replace auch ein Bild, dessen Bildtext einen Code-Span enthält, und Code
 * selbst bleibt unberührt.
 */
function outsideCode(text: string, codes: RegExp[], replace: (part: string) => string): string {
  const saved: string[] = [];
  let masked = text.replace(/\x00/g, "");
  for (const code of codes) masked = masked.replace(code, (m) => `\x00C${saved.push(m) - 1}\x00`);
  let out = replace(masked);
  // Platzhalter können in gespeichertem Code stecken (Inline-Code um einen Fence): bis keiner mehr da ist
  for (let i = 0; i < 5 && out.includes("\x00C"); i++) out = out.replace(/\x00C(\d+)\x00/g, (_m, k) => saved[Number(k)]);
  return out;
}

/** Ersatztext so, dass mit dem Text davor und danach keine neue Bildsyntax entsteht */
function safeReplacement(text: string, part: string, start: number, end: number): string {
  text = text.replace(/!(?=\[|<a\s)/gi, "! ");
  if ((text.startsWith("[") || /^<a\s/i.test(text)) && part[start - 1] === "!" && !isEscaped(part, start - 1)) text = " " + text;
  const next = part.slice(end);
  if (text.endsWith("!") && (next.startsWith("[") || /^<a\s/i.test(next))) text += " ";
  return text;
}

/**
 * Ersetzt jeden Treffer von pattern (Gruppe 1 = Bildtext) in einem Durchgang
 * durch den Bildtext (leer: "[Bild]"), ohne neue Bildsyntax (safeReplacement);
 * ein folgender normaler Link bleibt. Maskiertes "\!" bleibt. Ein zweiter
 * Durchgang ändert nichts mehr.
 */
function unwrapImages(part: string, pattern: RegExp): string {
  return part.replace(pattern, (m: string, alt: string, ...rest: unknown[]) => {
    const index = rest.find((x) => typeof x === "number") as number;
    if (isEscaped(part, index)) return m;
    // Markdown-Bildtext: "<Dateiname>" ist Text und zählt (Runde 12)
    const visible = alt.trim() !== "";
    return safeReplacement(visible ? alt : IMAGE_PLACEHOLDER, part, index, index + m.length);
  });
}

/** Rohes <img …> (in HTML oder Klartext) */
const HTML_IMG = /<img\b[^>]*>/gi;

/**
 * Schlussprüfung auf dem Ergebnis (Issue #52, Runde 10): Was nach allen
 * Ersetzungen noch wie ein Bild aussieht, auch wenn es erst durch das
 * Zusammensetzen entstanden ist, wird unschädlich gemacht, ohne dass dabei ein
 * neues entstehen kann: "![…](…)" bekommt ein Leerzeichen nach dem "!" (bleibt
 * ein normaler Link bzw. Text), "!<a" ebenso, "<img" wird "&lt;img" (HTML)
 * bzw. "< img" (Klartext). Jeder Schritt entfernt ein Vorkommen und erzeugt
 * keines, das Ergebnis ist also frei davon.
 */
function neutralizeImages(part: string, html: boolean): string {
  for (let i = 0; i < 1000; i++) {
    let changed = false;
    part = part.replace(MD_IMAGE, (m: string, ...rest: unknown[]) => {
      const index = rest.find((x) => typeof x === "number") as number;
      if (isEscaped(part, index)) return m;
      changed = true;
      return "! " + m.slice(1);
    });
    if (!changed) break;
  }
  part = part.replace(/!(?=<a\s)/gi, (m, index: number, whole: string) => (isEscaped(whole, index) ? m : "! "));
  return part.replace(/<img\b/gi, (m) => (html ? "&lt;" : "< ") + m.slice(1));
}

/**
 * Alle drei Bildformen in einem Durchgang über den Originaltext (Issue #52,
 * Runde 11): !<a …>alt</a>, ![alt](url) und rohes <img …>. Kein Ersatz wird von
 * einem späteren Durchgang erneut gelesen; was Ersatz und Nachbarn zusammen
 * bilden, erledigt danach neutralizeImages, ohne Adressen zu löschen.
 */
const ANY_IMAGE = new RegExp(`${HTML_IMAGE_LINK.source}|${MD_IMAGE.source}|${HTML_IMG.source}`, "gi");
function unwrapAllImages(part: string): string {
  return part.replace(ANY_IMAGE, (m: string, htmlAlt: string | undefined, mdAlt: string | undefined, ...rest: unknown[]) => {
    const index = rest.find((x) => typeof x === "number") as number;
    const end = index + m.length;
    if (m.startsWith("!")) {
      if (isEscaped(part, index)) return m;
      const fromHtml = m[1] === "<";
      const alt = (fromHtml ? htmlAlt : mdAlt) ?? "";
      // Nur bei schon gebautem HTML sind Tags im Bildtext Markup; im Markdown-Bildtext sind sie Text (Runde 12)
      const visible = fromHtml
        ? alt.replace(/<[^>]+>|\x00C\d+\x00/g, "").trim() !== "" || /\x00C\d+\x00/.test(alt)
        : alt.trim() !== "";
      return safeReplacement(visible ? alt : IMAGE_PLACEHOLDER, part, index, end);
    }
    const altAttr = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m);
    const text = (altAttr?.[1] ?? altAttr?.[2] ?? "").replace(/[<>]/g, "").trim();
    return safeReplacement(text || IMAGE_PLACEHOLDER, part, index, end);
  });
}

/** Entfernt unsichtbare Zeichen (siehe INVISIBLE_CHARS, TAG_CHARS_OR_FLAG, stripStrayZwj). */
export function stripInvisibleChars(text: string): string {
  return stripStrayZwj(
    text.replace(INVISIBLE_CHARS, "").replace(TAG_CHARS_OR_FLAG, m => (m.startsWith("\u{1F3F4}") ? m : ""))
  );
}

/**
 * Bereinigt Modelltext (Markdown), bevor er an Telegram geht:
 * - Unsichtbare Zeichen fallen weg (stripInvisibleChars), und zwar zuerst,
 *   damit eingeschobene Zeichen kein Bild tarnen. Zeilenenden werden zu \n.
 * - ![alt](url) außerhalb von Code wird zu alt (leer: "[Bild]"), genau die
 *   Form, die markdownToTelegramHTML sonst zu einem Link machen würde.
 * Sonst bleibt der Text unverändert. Nur für die Telegram-Ausgabe:
 * gespeicherter Text und WebUI bleiben original.
 */
export function sanitizeModelOutput(text: string): string {
  const clean = stripInvisibleChars(text).replace(/\r\n?/g, "\n");
  if (!clean.includes("![")) return clean;
  return outsideCode(clean, [MD_FENCE, MD_INLINE_CODE], (part) => neutralizeImages(unwrapImages(part, MD_IMAGE), false));
}

/**
 * Kürzt Text auf höchstens max Zeichen. Eine Kürzung kann keine versteckte
 * Adresse erzeugen: angeschnittene Bildsyntax zeigt Telegram als sichtbaren
 * Text, und bereinigt wird ohnehin am Sende-Helfer auf dem gekürzten Text
 * (guardTelegramPayload). keep bleibt aus Kompatibilität, wird nicht gebraucht.
 */
export function truncateBeforeSanitize(text: string, max: number, _keep = 0): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Bereinigt Text, der als Telegram-HTML geht (Inhalt von <pre> und <code>
 * bleibt unberührt). Klartext bekommt nur stripInvisibleChars. Im HTML:
 * sanitizeModelOutput plus !<a href="…">alt</a> (ein bereits umgewandeltes
 * Markdown-Bild) und rohes <img …> zu ihrem Text. Maskiertes "\!" bleibt ein
 * normaler Link.
 */
export function sanitizeTelegramText(text: string, html = false): string {
  const clean = stripInvisibleChars(text).replace(/\r\n?/g, "\n");
  // Klartext (ohne parse_mode) zeigt Telegram wörtlich: dort versteckt keine
  // Bildform eine Adresse, und Code-Markierungen fehlen (etwa im Rückfall nach
  // stripHtmlTags). Nur unsichtbare Zeichen weg; Markdown-Bilder entschärft
  // sanitizeModelOutput vorher an der Quelle (Präzisierung, Runde 14).
  if (!html) return clean;
  if (!clean.includes("!") && !/<img\b/i.test(clean)) return clean;
  const all = (part: string) => neutralizeImages(unwrapAllImages(part), html);
  return outsideCode(clean, html ? [HTML_CODE] : [MD_FENCE, MD_INLINE_CODE], all);
}

// ============================================================
// OUTPUT GUARD: Link-Vorschau aus, Text bereinigt (Issue #52)
// ============================================================

/** An jede Textnachricht und jede Text-Bearbeitung: Telegram ruft keine Adresse ab */
export const NO_LINK_PREVIEW = { is_disabled: true } as const;

/** Methoden mit text, die eine Link-Vorschau erzeugen können */
const TEXT_METHODS = new Set(["sendMessage", "editMessageText"]);
/** Methoden mit caption (dort gibt es keine link_preview_options) */
const CAPTION_METHODS = new Set([
  "sendPhoto",
  "sendDocument",
  "sendVideo",
  "sendAnimation",
  "sendAudio",
  "sendVoice",
  "sendPaidMedia",
  "editMessageCaption",
  "copyMessage",
]);

/** Ersatz, wenn nach dem Bereinigen nichts übrig bleibt (Telegram lehnt leeren Text ab) */
export const EMPTY_AFTER_SANITIZE = "(Nachricht enthielt nur unsichtbare Zeichen)";

function sanitizeField(value: unknown, parseMode: unknown): unknown {
  if (typeof value !== "string" || value === "") return value;
  const clean = sanitizeTelegramText(value, parseMode === "HTML");
  return clean.trim() || !value.trim() ? clean : EMPTY_AFTER_SANITIZE;
}

/**
 * Nutzlast eines Bot-API-Aufrufs absichern: text bzw. caption bereinigt
 * (sanitizeTelegramText), bei sendMessage und editMessageText zusätzlich
 * link_preview_options.is_disabled = true (das veraltete
 * disable_web_page_preview fällt weg). Andere Felder (Thread-ID, Buttons,
 * parse_mode) bleiben, andere Methoden unverändert. Liefert eine Kopie.
 */
export function guardTelegramPayload<T>(method: string, payload: T): T {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  if (TEXT_METHODS.has(method)) {
    const { disable_web_page_preview: _old, ...rest } = p;
    const previous = typeof p.link_preview_options === "object" && p.link_preview_options ? p.link_preview_options : {};
    return {
      ...rest,
      ...("text" in p ? { text: sanitizeField(p.text, p.parse_mode) } : {}),
      link_preview_options: { ...previous, ...NO_LINK_PREVIEW },
    } as T;
  }
  if (CAPTION_METHODS.has(method) && typeof p.caption === "string") {
    return { ...p, caption: sanitizeField(p.caption, p.parse_mode) } as T;
  }
  if (method === "sendMediaGroup" && Array.isArray(p.media)) {
    return {
      ...p,
      media: p.media.map(m =>
        m && typeof m === "object" && typeof (m as Record<string, unknown>).caption === "string"
          ? { ...m, caption: sanitizeField((m as Record<string, unknown>).caption, (m as Record<string, unknown>).parse_mode) }
          : m
      ),
    } as T;
  }
  return payload;
}

/** Was installTelegramOutputGuard braucht: api.config.use einer grammY-Api */
interface TransformableApi {
  config: { use(transformer: Transformer): void };
}

const guardedApis = new WeakSet<object>();

/**
 * Hängt guardTelegramPayload als grammY-Transformer an eine Api. Damit sind
 * alle Wege darüber abgesichert: ctx.reply, ctx.editMessageText,
 * bot.api.sendMessage, Fotos und Dokumente mit caption. Mehrfacher Aufruf auf
 * derselben Api installiert nur einmal.
 */
export function installTelegramOutputGuard(api: TransformableApi): void {
  if (guardedApis.has(api)) return;
  guardedApis.add(api);
  api.config.use((prev, method, payload, signal) => prev(method, guardTelegramPayload(method, payload), signal));
}

// ============================================================
// MARKDOWN → TELEGRAM HTML CONVERTER
// ============================================================

/**
 * Convert standard Markdown (as output by Claude) to Telegram-compatible HTML.
 * Runs sanitizeModelOutput first, so chunking and truncation see clean text.
 *
 * Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote>.
 * Only <, >, & need escaping — underscores, asterisks etc. are plain text.
 */
export function markdownToTelegramHTML(text: string): string {
  // Placeholders for protected regions (code blocks, inline code)
  const placeholders: string[] = [];
  const ph = (content: string) => {
    placeholders.push(content);
    return `\x00PH${placeholders.length - 1}\x00`;
  };

  // 0. Markdown-Bilder entschärfen, unsichtbare Zeichen entfernen (Issue #52)
  let result = sanitizeModelOutput(text);

  // 1. Extract fenced code blocks (``` ... ```) — protect from further processing.
  //    Plain fences that only carry an ASCII table become a list instead (tables
  //    do not survive Telegram's line wrapping on a phone).
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    if (TABLE_CODE_LANGS.has(String(lang).toLowerCase())) {
      const list = asciiTableToList(code);
      if (list) return list;
    }
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    const cls = lang ? ` class="language-${lang}"` : "";
    return ph(`<pre><code${cls}>${escaped}</code></pre>`);
  });

  // 2. Extract inline code (`...`) — protect from further processing
  result = result.replace(/`([^`\n]+)`/g, (_m, code) => {
    return ph(`<code>${escapeHtml(code)}</code>`);
  });

  // 2b. Markdown pipe tables → lists (Telegram renders no tables at all)
  result = convertTablesToLists(result);

  // 3. HTML-escape remaining plain text
  result = escapeHtml(result);

  // 4. Convert links: [text](url) → <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 5. Convert bold: **text** → <b>text</b> (before italic, so ** is consumed first)
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 6. Convert italic: *text* → <i>text</i>
  result = result.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");

  // 7. Convert strikethrough: ~~text~~ → <s>text</s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 8. Convert headers: # Text → bold (Telegram has no header element)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // 9. Convert blockquotes: > text → <blockquote>
  // Collect consecutive > lines into one blockquote
  result = result.replace(
    /(?:^&gt; .+$\n?)+/gm,
    (block) => {
      const content = block
        .split("\n")
        .map((line) => line.replace(/^&gt; /, ""))
        .filter((line) => line !== "")
        .join("\n");
      return `<blockquote>${content}</blockquote>`;
    }
  );

  // 10. Convert horizontal rules
  result = result.replace(/^---+$/gm, "");

  // 11. Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  // 12. Restore placeholders
  result = result.replace(/\x00PH(\d+)\x00/g, (_m, idx) => placeholders[Number(idx)]);

  return result.trim();
}

/** Escape the three characters that matter in Telegram HTML. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================
// HTML TAG STRIPPER (fallback when Telegram rejects HTML)
// ============================================================

/**
 * Strip all HTML tags and restore entities. Used as plain-text fallback.
 * Preserves all text content — <b>bold</b> becomes "bold", not "".
 */
export function stripHtmlTags(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// ============================================================
// MESSAGE CHUNKING
// ============================================================

/**
 * Split text into chunks that fit within Telegram's message limit.
 * Cascading split strategy: \n\n → \n → space → hard cut.
 */
export function chunkForTelegram(text: string, maxLength: number = 4000): string[] {
  if (!text) return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try split points in order of preference
    let splitAt = -1;

    // 1. Paragraph boundary (\n\n)
    splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt > maxLength * 0.3) {
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt + 2); // skip \n\n
      continue;
    }

    // 2. Line boundary (\n)
    splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt > maxLength * 0.3) {
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt + 1); // skip \n
      continue;
    }

    // 3. Word boundary (space)
    splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt > maxLength * 0.3) {
      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt + 1); // skip space
      continue;
    }

    // 4. Hard cut (no good split point)
    chunks.push(remaining.substring(0, maxLength));
    remaining = remaining.substring(maxLength);
  }

  return chunks;
}

/**
 * Send a message via Telegram Bot API (direct fetch, no grammy).
 * Converts Markdown to HTML, chunks long messages, retries as plain text on error.
 * Every request goes through guardTelegramPayload (link preview off, text sanitized).
 * Used by services that don't run the bot (check-in, briefing, watchdog).
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  message: string,
  options?: {
    parseMode?: "HTML";
    buttons?: { text: string; callback_data: string }[][];
  }
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const html = options?.parseMode ? markdownToTelegramHTML(message) : sanitizeModelOutput(message);
  const chunks = chunkForTelegram(html);

  let allOk = true;
  for (const chunk of chunks) {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: chunk,
      link_preview_options: NO_LINK_PREVIEW,
    };

    if (options?.parseMode) {
      body.parse_mode = "HTML";
    }

    // Only attach buttons to the last chunk
    if (chunk === chunks[chunks.length - 1] && options?.buttons?.length) {
      body.reply_markup = { inline_keyboard: options.buttons };
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(guardTelegramPayload("sendMessage", body)),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        if (response.status === 400 && options?.parseMode) {
          console.warn(`[Telegram] HTML send failed (400), retrying as plain text. Error: ${errBody.substring(0, 200)}`);
          // Retry as plain text (strip HTML tags, preserve content)
          const fallback = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              guardTelegramPayload("sendMessage", {
                chat_id: chatId,
                text: stripHtmlTags(chunk),
                reply_markup: body.reply_markup,
              })
            ),
          });
          if (!fallback.ok) {
            console.error(`[Telegram] Plain text retry also failed (${fallback.status}) for chunk (${chunk.length} chars)`);
            allOk = false;
          }
        } else {
          console.error(`[Telegram] sendMessage failed (${response.status}) for chunk (${chunk.length} chars): ${errBody.substring(0, 200)}`);
          allOk = false;
        }
      }
    } catch (err) {
      console.error(`[Telegram] sendMessage threw for chunk (${chunk.length} chars):`, err);
      allOk = false;
    }
  }

  return allOk;
}

/** Ausschnitt aus bot.api, den sendChunkedMessage braucht (Tests nutzen eine Attrappe) */
export interface TelegramMessageApi {
  sendMessage(chatId: string, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Markdown-Text vollständig senden, in Teilen bis zum Telegram-Limit. Jeder
 * Teil erst als HTML, bei Fehler als Klartext. Die Knöpfe hängen nur am
 * letzten Teil, also unter der vollständigen Vorschau. Scheitert ein Teil
 * endgültig, bricht die Funktion ab und wirft: keine Knöpfe unter einer
 * unvollständigen Vorschau, und der Aufrufer erfährt vom Fehler.
 */
export async function sendChunkedMessage(
  api: TelegramMessageApi,
  chatId: string,
  text: string,
  opts: { threadId?: number; replyMarkup?: unknown } = {}
): Promise<void> {
  const chunks = chunkForTelegram(markdownToTelegramHTML(text));
  for (const [i, chunk] of chunks.entries()) {
    const other: Record<string, unknown> = { link_preview_options: NO_LINK_PREVIEW };
    if (opts.threadId) other.message_thread_id = opts.threadId;
    if (opts.replyMarkup && i === chunks.length - 1) other.reply_markup = opts.replyMarkup;
    try {
      await api.sendMessage(chatId, chunk, { parse_mode: "HTML", ...other });
    } catch {
      try {
        await api.sendMessage(chatId, stripHtmlTags(chunk), other);
      } catch (err) {
        throw new Error(`Teil ${i + 1} von ${chunks.length} nicht gesendet: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/**
 * Send a long response, splitting into chunks if needed.
 * Converts Markdown to HTML, uses cascading chunk strategy. Link preview off
 * and text sanitized on every chunk, also in the plain-text fallback.
 */
export async function sendResponse(
  ctx: Context,
  text: string,
  wantsVoice?: boolean,
  voiceFn?: (text: string) => Promise<Buffer | null>
): Promise<void> {
  // Send voice if requested and voice function provided
  if (wantsVoice && voiceFn) {
    const audioBuffer = await voiceFn(text);
    if (audioBuffer) {
      await ctx.replyWithVoice(new InputFile(audioBuffer, "response.wav"));
      return;
    }
  }

  // Check for embedded image tags: [IMAGE:/path/to/file.png|Optional caption]
  const imageMatch = text.match(/\[IMAGE:([^\]|]+)(?:\|([^\]]+))?\]/);
  if (imageMatch) {
    const imagePath = imageMatch[1].trim();
    const caption = imageMatch[2]?.trim();
    const cleanText = text.replace(imageMatch[0], "").trim();

    try {
      await ctx.replyWithPhoto(new InputFile(imagePath), {
        caption: caption ? sanitizeModelOutput(caption) || undefined : undefined,
      });
    } catch {
      // Image send failed, continue with text
    }

    if (cleanText) {
      text = cleanText;
    } else {
      return;
    }
  }

  // Convert to HTML and chunk
  const html = markdownToTelegramHTML(text);
  const chunks = chunkForTelegram(html);

  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML", link_preview_options: NO_LINK_PREVIEW });
    } catch (htmlErr) {
      try {
        await ctx.reply(stripHtmlTags(chunk), { link_preview_options: NO_LINK_PREVIEW });
      } catch (plainErr) {
        console.error(`[Telegram] Failed to send chunk (${chunk.length} chars), HTML error:`, htmlErr);
        console.error(`[Telegram] Plain text retry also failed:`, plainErr);
      }
    }
  }
}

/**
 * Manage periodic typing indicator (Telegram expires after ~5s).
 */
export function createTypingIndicator(ctx: Context) {
  let interval: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      ctx.replyWithChatAction("typing").catch(() => {});
      interval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
