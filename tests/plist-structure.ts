/**
 * Strukturprüfung für XML-Plists ohne plutil (aus Issue #286, seit Issue #368
 * geteilt): Kopf, ein plist-Wurzelelement, erlaubte Elemente richtig
 * verschachtelt, in dict abwechselnd key und Wert, keine nackten & oder <,
 * Kommentare ohne --. Dazu ein kleiner Leser, der Texte wieder dekodiert.
 */

/**
 * Prüft eine XML-Plist ohne plutil: Kopf, ein plist-Wurzelelement, erlaubte
 * Elemente richtig verschachtelt, in dict abwechselnd key und Wert, keine
 * nackten & oder <, Kommentare ohne --. Gibt den ersten Fehler zurück, sonst null.
 */
export function plistProblem(xml: string): string | null {
  const head = /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*(<!DOCTYPE plist [^>]*>\s*)?/.exec(xml);
  if (!head) return "Kopf fehlt";
  const body = xml.slice(head[0].length).trimEnd();
  const containers = new Set(["plist", "dict", "array"]);
  const scalars = new Set(["key", "string", "integer", "real", "date", "data"]);
  const empties = new Set(["true", "false"]);
  const tag = /<(\/?)([a-z]+)((?:\s+[a-z]+="[^"]*")*)\s*(\/?)>/y;
  // Je offenem Behälter: Name und in dict, ob als Nächstes ein key kommen muss
  const stack: Array<{ name: string; wantKey: boolean }> = [];
  let pos = 0;
  let rootDone = false;
  const value = (name: string): string | null => {
    const top = stack[stack.length - 1];
    if (!top) return rootDone || name !== "plist" ? `${name} außerhalb von plist` : null;
    if (top.name === "plist" && name === "key") return "key direkt in plist";
    if (top.name === "dict") {
      if (top.wantKey !== (name === "key")) return top.wantKey ? `${name} statt key in dict` : "zwei key hintereinander";
      top.wantKey = !top.wantKey;
    } else if (name === "key") return "key außerhalb von dict";
    return null;
  };
  while (pos < body.length) {
    const ws = /\s*/y;
    ws.lastIndex = pos;
    ws.exec(body);
    pos = ws.lastIndex;
    if (pos >= body.length) break;
    if (body.startsWith("<!--", pos)) {
      const end = body.indexOf("-->", pos + 4);
      if (end < 0 || body.slice(pos + 4, end).includes("--")) return "Kommentar kaputt";
      pos = end + 3;
      continue;
    }
    tag.lastIndex = pos;
    const m = tag.exec(body);
    if (!m) return `unerwartetes Zeichen an Stelle ${pos}`;
    const [, closing, name, attrs, selfClosing] = m;
    pos = tag.lastIndex;
    if (closing) {
      const top = stack.pop();
      if (!top || top.name !== name) return `</${name}> passt nicht`;
      if (top.name === "dict" && !top.wantKey) return "key ohne Wert";
      if (name === "plist") rootDone = true;
      continue;
    }
    if (name === "plist" && !/version="1\.0"/.test(attrs)) return "plist ohne version";
    const problem = value(name);
    if (problem) return problem;
    if (empties.has(name) || selfClosing) {
      if (!empties.has(name) && !scalars.has(name) && !containers.has(name)) return `unbekanntes Element ${name}`;
      continue;
    }
    if (containers.has(name)) {
      if (name === "plist" && stack.length) return "plist verschachtelt";
      stack.push({ name, wantKey: name === "dict" });
      continue;
    }
    if (!scalars.has(name)) return `unbekanntes Element ${name}`;
    const end = body.indexOf(`</${name}>`, pos);
    if (end < 0) return `</${name}> fehlt`;
    const text = body.slice(pos, end);
    if (/<|&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) return `ungültiger Text in ${name}`;
    pos = end + name.length + 3;
  }
  if (stack.length) return `<${stack[stack.length - 1].name}> nicht geschlossen`;
  return rootDone ? null : "plist fehlt";
}

/** Dekodiert die fünf XML-Maskierungen und Zeichenreferenzen */
export function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, ref: string) => {
    if (ref.startsWith("#x")) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[ref]!;
  });
}

/** Dekodierte Werte von <string> nach einem Schlüssel; Liste bei <array> */
export function plistStrings(xml: string, key: string): string[] {
  const block = new RegExp(`<key>${key}</key>\\s*(<string>[^<]*</string>|<array>[\\s\\S]*?</array>)`).exec(xml);
  if (!block) throw new Error(`${key} fehlt`);
  return [...block[1].matchAll(/<string>([^<]*)<\/string>/g)].map(m => decodeXml(m[1]));
}
