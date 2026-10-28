/**
 * Prüfhilfe für Telegram-HTML (Issue #327): erlaubte Tags, sauber
 * geschachtelt und geschlossen, kein rohes <, > oder & außerhalb von Tags und
 * Entities. Wird von den Golden-Tests und den Sendeweg-Tests benutzt.
 */

const ALLOWED_TAGS = new Set(["b", "i", "s", "u", "code", "pre", "a", "blockquote"]);
const ENTITY = /^&(?:amp|lt|gt|quot|#\d+|#x[0-9a-f]+);/i;
const TAG = /^<(\/?)([a-z]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*>/i;

/** Liefert null, wenn html gültiges Telegram-HTML ist, sonst den ersten Fehler */
export function telegramHtmlError(html: string): string | null {
  const open: string[] = [];
  for (let i = 0; i < html.length; ) {
    const rest = html.slice(i);
    if (rest[0] === "<") {
      const m = TAG.exec(rest);
      if (!m) return `rohes < an Stelle ${i}`;
      const [whole, closing, rawName, attrs] = m;
      const name = rawName.toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return `Tag <${name}> nicht erlaubt`;
      if (closing) {
        if (attrs) return `schließender Tag </${name}> mit Attributen`;
        const top = open.pop();
        if (top !== name) return `</${name}> schließt ${top ? `<${top}>` : "nichts"} (Stelle ${i})`;
      } else {
        if (attrs && name !== "a" && name !== "code") return `<${name}> mit Attributen`;
        if (name === "a" && !/^\s+href="[^"]*"$/.test(attrs)) return "<a> ohne href";
        if (name === "code" && attrs && !/^\s+class="language-[\w+-]+"$/.test(attrs)) return "<code> mit fremdem Attribut";
        open.push(name);
      }
      i += whole.length;
      continue;
    }
    if (rest[0] === ">") return `rohes > an Stelle ${i}`;
    if (rest[0] === "&") {
      const m = ENTITY.exec(rest);
      if (!m) return `rohes & an Stelle ${i}`;
      i += m[0].length;
      continue;
    }
    i++;
  }
  return open.length ? `offen geblieben: ${open.map(t => `<${t}>`).join("")}` : null;
}

/** Klartext eines Telegram-HTML-Stücks (Tags weg, Entities zurück) */
export function htmlText(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&(lt|gt|amp|quot);/g, (_m, e: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"' })[e] ?? "");
}

const STYLED_TOKEN = /<(\/?)([a-z]+)[^>]*>|&(lt|gt|amp|quot);|[^]/giu;

/**
 * Jedes Zeichen außer Leerraum mit den Tags, in denen es steht, etwa
 * '<a href="x"><b>W'. Gleiche Folge für die Teile und die Einzelumwandlung
 * heißt: Beim Teilen ging weder Text noch Formatierung verloren, und keine
 * kam dazu.
 */
export function styledChars(html: string): string[] {
  const open: Array<{ name: string; text: string }> = [];
  let prefix = "";
  const out: string[] = [];
  for (const m of html.matchAll(STYLED_TOKEN)) {
    if (m[2]) {
      const name = m[2].toLowerCase();
      if (!m[1]) open.push({ name, text: m[0] });
      else open.splice(open.map(o => o.name).lastIndexOf(name), 1);
      prefix = open.map(o => o.text).join("");
      continue;
    }
    const char = m[3] ? htmlText(m[0]) : m[0];
    if (!/\s/u.test(char)) out.push(prefix + char);
  }
  return out;
}

/** Erste Stelle, an der zwei Folgen aus styledChars abweichen, oder null */
export function styleDifference(parts: string[], whole: string): string | null {
  const got = parts.flatMap(styledChars);
  const want = styledChars(whole);
  for (let k = 0; k < Math.max(got.length, want.length); k++) {
    if (got[k] !== want[k]) return `Zeichen ${k}: ${JSON.stringify(got[k]?.slice(-80))} statt ${JSON.stringify(want[k]?.slice(-80))}`;
  }
  return null;
}

/**
 * Prüft, dass die Klartexte der Teile zusammen den Klartext der
 * Einzelumwandlung ergeben, bis auf Leerraum an den Teilgrenzen (Leerraum im
 * Inneren wird auf ein Zeichen zusammengefasst). Liefert null oder den Fehler.
 */
export function sameTextExceptBoundaries(parts: string[], whole: string): string | null {
  const squash = (s: string) => s.replace(/\s+/g, " ");
  const all = squash(htmlText(whole));
  let pos = 0;
  for (const [n, part] of parts.entries()) {
    const text = squash(htmlText(part)).trim();
    while (all[pos] === " ") pos++;
    if (!all.startsWith(text, pos)) return `Teil ${n + 1} passt nicht an Stelle ${pos}: ${JSON.stringify(text.slice(0, 60))} statt ${JSON.stringify(all.slice(pos, pos + 60))}`;
    pos += text.length;
  }
  return all.slice(pos).trim() === "" ? null : `Rest fehlt: ${JSON.stringify(all.slice(pos, pos + 60))}`;
}
