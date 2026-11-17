/**
 * Tag-Filter: Intent-Tags ([REMEMBER: ...] usw.) werden nicht vorgelesen.
 * Aus der Sprach-Brücke herausgelöst (Issue #255), gemeinsam für Telefon und
 * Telefonhörer.
 */

const TAG_NAMES = ["REMEMBER", "GOAL", "DONE", "CANCEL", "FORGET", "KNOWLEDGE", "REMIND", "INVOKE", "ASSET_DESC"];
const TAG_RE = /^\[(REMEMBER|GOAL|DONE|CANCEL|FORGET|KNOWLEDGE|REMIND|INVOKE|ASSET_DESC)\b/i;

function tagRegex(names: string[]): RegExp {
  return new RegExp(`^\\[(${names.join("|")})\\b`, "i");
}

/**
 * Kann aus diesem offenen "[..." (ohne "]") noch ein Intent-Tag werden?
 * "[REM" ja, "[REMEMBER:" ja, "[laut" nein, "[" ja.
 */
function mayBeTag(open: string, names: string[] = TAG_NAMES): boolean {
  const name = /^\[([A-Za-z_]*)/.exec(open)?.[1].toUpperCase() ?? "";
  const rest = open.slice(1 + name.length);
  if (!rest) return names.some((n) => n.startsWith(name));
  return names.includes(name) && !/^\d/.test(rest);
}

/** Index der "]", die das "[" am Anfang schließt (innere Klammern mitgezählt), sonst -1 */
function closingBracket(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return i;
  }
  return -1;
}

export interface TagFilterOptions {
  /**
   * Streng (Telefonhörer): ein angefangenes Tag wird nie ausgegeben, auch
   * nicht nach 400 Zeichen ohne "]" und nicht als Rest beim flush ("[REMEM").
   * Ein "[", aus dem kein Tag werden kann, geht dafür sofort weiter.
   * Ohne die Option verhält sich der Filter wie bisher in der Brücke.
   */
  strict?: boolean;
  /**
   * Weitere Tag-Namen, die nie vorgelesen werden (Telefonhörer, Issue #259:
   * Werkzeug-Tags SUCHE, RECHNE, DENKAUFTRAG). Ohne die Option gelten nur die
   * Intent-Tags, wie bisher in der Brücke.
   */
  extraTags?: string[];
}

/** Haelt "[..." zurueck, bis klar ist, ob es ein Intent-Tag ist. */
export class TagFilter {
  private buf = "";
  private readonly strict: boolean;
  private readonly names: string[];
  private readonly re: RegExp;
  constructor(options: TagFilterOptions = {}) {
    this.strict = options.strict ?? false;
    const extra = (options.extraTags ?? []).map((n) => n.toUpperCase()).filter((n) => /^[A-Z_]+$/.test(n));
    this.names = extra.length ? [...TAG_NAMES, ...extra] : TAG_NAMES;
    this.re = extra.length ? tagRegex(this.names) : TAG_RE;
  }
  push(t: string): string {
    this.buf += t;
    let out = "";
    while (this.buf) {
      const i = this.buf.indexOf("[");
      if (i < 0) {
        out += this.buf;
        this.buf = "";
        break;
      }
      out += this.buf.slice(0, i);
      this.buf = this.buf.slice(i);
      if (this.strict) {
        // Kein Tag möglich: die Klammer gehört zum Text, dahinter weitersuchen,
        // so fallen auch Tags in gewöhnlichen Klammern ("[laut [REMEMBER: x] ok]")
        if (!mayBeTag(this.buf, this.names)) {
          out += "[";
          this.buf = this.buf.slice(1);
          continue;
        }
        // Tag samt innerer Klammern ("[REMEMBER: mag [grünen] Tee]") erst mit seiner "]" verwerfen
        const end = this.re.test(this.buf) ? closingBracket(this.buf) : -1;
        if (end < 0) break;
        this.buf = this.buf.slice(end + 1);
        continue;
      }
      const j = this.buf.indexOf("]");
      if (j < 0) {
        if (this.buf.length > 400) {
          out += this.buf;
          this.buf = "";
        }
        break;
      }
      const tag = this.buf.slice(0, j + 1);
      this.buf = this.buf.slice(j + 1);
      if (!this.re.test(tag)) out += tag;
    }
    return out;
  }
  flush(): string {
    const rest = this.buf;
    this.buf = "";
    if (this.re.test(rest)) return "";
    if (this.strict && mayBeTag(rest, this.names)) return "";
    return rest;
  }
}

export function stripTags(text: string): string {
  const f = new TagFilter();
  return (f.push(text) + f.flush()).replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * Was wirklich gesprochen wurde, für einen Verlauf: ohne Intent-Tags und ohne
 * v3-Audio-Tags wie [excited] oder [thoughtful], die ElevenLabs dem LLM für
 * eleven_v3 nahelegt; die gehören in den Ton, nicht in die Historie.
 */
export function spokenText(raw: string): string {
  return stripTags(raw)
    .replace(/\[[a-z][a-z ,'-]{1,30}\]/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
