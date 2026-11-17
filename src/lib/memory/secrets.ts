/**
 * Geheimnisse in Texten erkennen und maskieren (Issue #524). Dieselbe Prüfung
 * gilt beim Merken (der Wert wird nicht gespeichert) und überall, wo ein Fakt
 * einen Prompt oder eine Ausgabe erreicht (der Wert wird ersetzt). Reine Funktionen:
 * kein Speicher, keine Umgebung, kein Log.
 *
 * Die Erkennung hat fünf Stufen, damit jede Schreibweise für jede Bezeichnung und jede
 * Wertform gilt und nicht jedes Muster sie einzeln kennen muss:
 *
 * 1. stripDecoration entfernt Hervorhebungen (**, _, ~~, <b>) an Wortgrenzen. Kein Muster
 *    kennt sie mehr. Mitten im Wort bleiben sie: mein_ghp_…, Wald*geheim42.
 * 2. pathRegions findet Dateipfade, auch mit Leerzeichen in einem Ordnernamen. Eine Bezeichnung
 *    in einem Pfad macht den Rest des Pfads nicht zum Wert (siehe labelInPath).
 * 3. LABEL_RULES ist die einzige Liste der Bezeichnungen. Ihre Muster finden nur die Bezeichnung
 *    und den Trenner, nie den Wert. Aus jedem Eintrag entstehen die Form im Fließtext und die Form
 *    in einer Tabellenzelle. Dazu kommen TOKEN_PATTERNS für Werte, die sich selbst verraten:
 *    private Schlüssel, Schlüssel bekannter Anbieter, Zugangsdaten in Adressen, lange Zufallsketten.
 * 4. readValue ist die einzige Stelle, die einen Wert liest: Anführungszeichen, Klammern, reines
 *    Wort. phraseTail und keyTail lesen weiter, solange der Wert weitergeht, ohne Obergrenze:
 *    Eine Grenze für die Laufzeit darf nie zur Grenze der Maske werden. Der nächste Treffer
 *    beginnt hinter dem gelesenen Wert, das hält die Laufzeit linear.
 *    Steht hinter der Bezeichnung nichts, nur ein Trenner oder ein Blockeinstieg (YAML, HTML-Tag,
 *    Klammer), liest readLineBlock oder readEnclosed den Wert über Zeilen (siehe LineBlock).
 *    Tags und Klammern gelten in zwei Lesarten (Reading): bis zum passenden Gegenstück,
 *    Verschachtelung mitgezählt (pairMatcher), und bis zum ersten schließenden Zeichen. Ergibt
 *    eine der beiden einen Wert, wird maskiert (siehe findSecrets).
 * 5. Das Urteil hängt nur von der Art der Bezeichnung, der Deutlichkeit des Trenners
 *    (Strength) und der Form des Werts ab, nie davon, woher der Wert kam.
 *
 * Die Fundstellen werden auf den Originaltext zurückgerechnet. Hervorhebungen direkt am
 * Wert fallen mit weg, denn ein Stern kann auch zum Passwort gehören.
 *
 * Nicht als Geheimnis gelten Zahlen, Commit-Kennungen und andere Hashes in Hex
 * (auch in gemischter Schreibung), UUIDs, Pfade, Daten und Sätze über Passwörter
 * ohne Wert („Passwort vergessen“).
 *
 * Deutlichkeit des Trenners bei einem reinen Wort: Hinter „:“, „=“, „lautet“ und in einer
 * Tabellenzelle zählt es immer. Hinter einem Strich zählt es, wenn dahinter kein Satz weitergeht,
 * hinter „ist“ nur groß geschrieben („ist abgelaufen“ bleibt frei). Ganz ohne Trenner zählt nur
 * ein Wert mit Ziffer oder Sonderzeichen.
 *
 * Ein Wert in Anführungszeichen, Backticks oder einem Codeblock reicht bis zum passenden
 * schließenden Zeichen, auch über Zeilen (siehe readQuoted). Ohne schließendes Zeichen zählt für
 * das Urteil die erste Zeile, maskiert wird bis zum Ende des Absatzes, bei einem Codeblock bis
 * zum Ende des Texts. Eine Zelle reicht bis zum Zellenrand, alle anderen bis zum nächsten
 * Leerraum. Nur Satzzeichen am Ende bleiben stehen. Eine Kopfzeile Authorization oder
 * Proxy-Authorization gilt mit ihrer Parameterliste bis zum Zeilenende (siehe judgeHeaderLine),
 * das Verfahren bleibt stehen. Hinter einem deutlichen
 * Trenner gehören weitere Wörter zur Passphrase, bis eine Präposition, ein Artikel, ein
 * Satzzeichen oder das Zeilenende kommt (siehe phraseTail), auch eine Liste einzelner Wörter
 * bis zum Zeilenende (siehe listEnd), hinter einer Schlüssel-Bezeichnung weitere Ketten mit
 * Ziffern (siehe keyTail).
 *
 * In einer Tabelle zählt die Zelle neben der Bezeichnung und die Spalte unter ihr, auch ohne
 * äußere Striche, mitten im Text und auf eine Zeile zusammengezogen. Frei bleiben Befehlsketten
 * (cat log | grep Passwort | sort), Kopfzeilen, deren Zellen Spaltennamen sind, und Zellen, die
 * erkennbar etwas beschreiben (siehe describesSomething).
 *
 * Kein Wert ist nur, was erkennbar auf einen Wert verweist oder ihn verbirgt: die
 * Maske, Füllzeichen, Variablen, Pfade, eine .env als Datei und Klammern, die einen
 * Wert nur beschreiben (<dein passwort>, siehe Tresor). Klammern oder „.env“ allein
 * reichen nicht: "(Sommer77)", "[Sommer77]" und "Sommer77.env" sind Werte.
 *
 * Maskiert wird nur der Wert: Die Bezeichnung bleibt, damit der Fakt lesbar und
 * der Nutzer ihn wiedererkennt. Die Maske selbst gilt nicht als Geheimnis, zweimal
 * maskieren ändert nichts.
 *
 * Die Muster bleiben linear: Fakten dürfen lang sein, Web-Nachrichten bis 200.000
 * Zeichen. Kein Muster beginnt mit einer offenen Wiederholung.
 */

export const SECRET_MASK = "[maskiert]";

/** Hinweis, wenn ein Wert nicht gespeichert wurde; für einen oder mehrere Fakten */
export function secretRefusedText(count = 1): string {
  const what = count > 1 ? `${count} Fakten sehen` : "Das sieht";
  const stored = count > 1 ? "sie" : "es";
  return `🔐 ${what} nach einem Passwort oder Schlüssel aus, darum habe ich ${stored} nicht gespeichert. Solche Werte gehören in die .env im Projektordner.`;
}

export type SecretKind = "passwort" | "schluessel";

export interface SecretSpan {
  kind: SecretKind;
  start: number;
  end: number;
}

/** Wie deutlich der Trenner Bezeichnung und Wert verbindet; „cell“ ist die Zelle daneben oder darunter */
type Strength = "explicit" | "cell" | "dash" | "is" | "weak";

interface MatchGroups {
  value?: string;
  sep?: string;
  label?: string;
  scheme?: string;
  /** Trenner zwischen Name und Wert eines Paars: Login: alex / Wert */
  pair?: string;
  /** Bezeichnung, die nur ein Zugang sein kann: Login, Zugang */
  login?: string;
}

interface ValueContext extends MatchGroups {
  quoted: boolean;
  strength: Strength;
  /** Hinter dem Wert endet die Zeile oder die Aufzählung; es folgt kein Satz */
  standsAlone(): boolean;
}

/** Um einen Schlüssel steht kein Zeichen, das ihn zum Teil eines längeren Worts macht: mein_ghp_…, ghp_…_alt */
const WORD_PART = "[A-Za-z0-9_-]";
const TOKEN_START = `(?<!${WORD_PART})`;
const TOKEN_END = `(?!${WORD_PART})`;

/** Anfänge von Schlüsseln bekannter Anbieter, jeweils mit der kürzesten üblichen Länge */
const KNOWN_PREFIXES = [
  "sk-[A-Za-z0-9_-]{20,}",
  "sk_[A-Za-z0-9_]{20,}",
  "rk_(?:live|test)_[A-Za-z0-9]{16,}",
  "whsec_[A-Za-z0-9+/=]{16,}",
  "gh[pousr]_[A-Za-z0-9]{30,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  "glpat-[A-Za-z0-9_-]{16,}",
  "xox[abeoprs]-[A-Za-z0-9-]{10,}",
  "xapp-[A-Za-z0-9-]{10,}",
  "(?:AKIA|ASIA)[0-9A-Z]{16}",
  "AIza[A-Za-z0-9_-]{30,}",
  "sbp_[A-Za-z0-9]{20,}",
  "sb_secret_[A-Za-z0-9_-]{16,}",
  "gsk_[A-Za-z0-9]{20,}",
  "hf_[A-Za-z0-9]{20,}",
  "npm_[A-Za-z0-9]{30,}",
  "pypi-[A-Za-z0-9_-]{30,}",
  "cf[au]t_[A-Za-z0-9_-]{20,}",
  "tskey-[A-Za-z0-9-]{16,}",
  "ntn_[A-Za-z0-9]{20,}",
  "xai-[A-Za-z0-9]{20,}",
  "pplx-[A-Za-z0-9]{20,}",
  "apify_api_[A-Za-z0-9]{16,}",
  "fc-[a-f0-9]{32}",
  // Bot-Token von Telegram und JSON Web Tokens
  "\\d{6,12}:[A-Za-z0-9_-]{35,}",
  "eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",
];

const hasDigit = (value: string) => /\d/.test(value);
const hasLetter = (value: string) => /\p{L}/u.test(value);

/** Echte Schlüssel enthalten Ziffern oder Großbuchstaben, Wörter wie sk-learn-… nicht */
const looksRandom = (value: string) => hasDigit(value) || /[A-Z]/.test(value);

/** Wert in Klammern: <wert>, [maskiert], {{wert}}, (siehe Tresor), ${WERT}; ob er nur Stellvertreter ist, prüft isWrappedPlaceholder */
const WRAPPED = "<[^<>\\n]{0,100}>|\\[[^\\[\\]\\n]{0,100}\\]|\\{\\{?[^{}\\n]{0,100}\\}?\\}|\\([^()\\n]{0,100}\\)|\\$\\{[^{}\\n]{0,100}\\}";
const WHOLE_WRAPPED = new RegExp(`^(?:${WRAPPED})$`, "u");

/** Name einer Variable, groß geschrieben; Ziffern nur mit Unterstrich, SOMMER77 ist eher ein Wert */
const isVariableName = (name: string) => /^[A-Z_][A-Z0-9_]*$/.test(name) && (!hasDigit(name) || name.includes("_"));

/** Pfad in einer Vorlage ohne Ziffern: vault.pw, .Values.db */
const TEMPLATE_PATH = /^\.?[A-Za-z_]+(?:\.[A-Za-z_]+)+$/;

/** Eine .env als Datei, auch in einem Ordner; „Sommer77.env“ ist keine */
const ENV_FILE = /^(?:[\w.~-]+[/\\])*\.env(?:\.[a-z]+)?$/;

/** Datei in einem Ordner, ohne Wurzel: docs/pw.txt, Backup2026/notizen.txt; „Sommer/77“ hat keine Endung */
const RELATIVE_FILE = /^(?:[\p{L}\d_.-]+[/\\])+[\p{L}\d_.-]*\.[A-Za-z][A-Za-z0-9]{0,4}$/u;

/** Klammern, die mit diesen Wörtern beginnen, verweisen auf einen anderen Ort: (siehe Tresor), (im Schrank) */
const REFERENCE_START = new Set(["siehe", "see", "steht", "liegt", "im", "in"]);

/** Wörter, aus denen ein beschreibender Stellvertreter besteht: <dein passwort>, [maskiert], <YOUR_API_KEY> */
const PLACEHOLDER_WORDS = new Set([
  "maskiert", "masked", "redacted", "verborgen", "entfernt", "hidden", "geschwärzt",
  "wert", "value", "platzhalter", "placeholder", "beispiel", "example",
  "passwort", "password", "kennwort", "passphrase", "pass", "pw", "pwd", "pin",
  "token", "key", "api", "schlüssel", "schluessel", "secret", "geheimnis",
  "dein", "deine", "deinem", "deinen", "your", "mein", "meine", "my", "hier", "here", "neu", "neues", "new", "eintragen", "einfügen", "einsetzen",
  "db", "datenbank", "database", "app", "admin", "root", "user", "nutzer", "seite", "site", "server", "konto", "account",
  "der", "die", "das", "des", "dem", "den", "für", "fuer", "for", "the", "of", "von", "nicht", "not", "noch",
]);

/** Text in Klammern beschreibt nur einen Wert: nur bekannte Wörter oder ein Verweis, in keinem eine Ziffer */
function describesValue(inner: string): boolean {
  const words = inner.toLowerCase().split(/[^\p{L}\d]+/u).filter(Boolean);
  if (words.some(hasDigit)) return false;
  if (words.length > 0 && REFERENCE_START.has(words[0])) return true;
  return words.every(word => PLACEHOLDER_WORDS.has(word) || NOT_A_VALUE.has(word));
}

/** Klammern allein machen keinen Stellvertreter: Es zählt, was darin steht */
function isWrappedPlaceholder(value: string): boolean {
  if (!WHOLE_WRAPPED.test(value)) return false;
  const inner = value.replace(/^(?:\$\{|\{\{?|[<[(])/, "").replace(/(?:\}\}?|[>\])])$/, "").trim();
  if (/^(?:\$\{|\{\{)/.test(value) && (isVariableName(inner) || TEMPLATE_PATH.test(inner))) return true;
  return describesValue(inner);
}

/** Satz, der auf einen anderen Ort verweist: „siehe Tresor“, „steht in der .env“; „in der Wiese“ kann eine Passphrase sein */
function refersElsewhere(value: string): boolean {
  if (hasDigit(value)) return false;
  const [first, ...others] = value.toLowerCase().split(/\s+/);
  if (others.length === 0) return false;
  if (first === "siehe" || first === "see") return true;
  return REFERENCE_START.has(first) && ENV_FILE.test(others[others.length - 1]);
}

/**
 * Stellvertreter, Verweise und Pfade sind kein Wert. Geprüft wird der ganze Wert,
 * nicht sein erstes Zeichen: „*Sommer77“ ist ein Passwort, „***“ nicht. Eine
 * Hervorhebung ändert nichts: „**[maskiert]**“ bleibt die Maske.
 */
function isPlaceholder(value: string): boolean {
  return isPlainPlaceholder(value) || isPlainPlaceholder(bareWord(value));
}

function isPlainPlaceholder(value: string): boolean {
  if (isWrappedPlaceholder(value) || refersElsewhere(value)) return true;
  const variable = /^(?:\$(\w+)|%(\w+)%)$/.exec(value);
  if (variable && isVariableName(variable[1] ?? variable[2])) return true;
  // Nur Füll- und Satzzeichen, auch ein leerer Wert
  if (/^[\s*•…·.~_,;:!?)\]}>"'`„“”‚‘’«»-]*$/.test(value)) return true;
  if (/^https?:\/\//i.test(value) || ENV_FILE.test(value) || RELATIVE_FILE.test(value)) return true;
  const envRead = /^(?:process\.env|import\.meta\.env|env)\.(\w+)$/.exec(value);
  if (envRead && isVariableName(envRead[1])) return true;
  // Pfade: ~/…, ./…, ../…, C:\…, /etc/…; ein einzelner Schrägstrich am Anfang macht noch keinen
  if (/^(?:(?:~|\.\.?)[/\\]|[A-Za-z]:[/\\]|\/[^/]+\/)/.test(value)) return true;
  // Füllzeichen, die niemand als Passwort tippt; 1111 oder aaaaaa können echt sein
  return /^([xX#?])\1+$/.test(value);
}

/** „Passwort 12.10.2026 geändert“: ein Datum ohne Anführungszeichen; in Anführungszeichen ist es der Wert */
const DATE = /^\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}$/;

/** Wörter hinter einer Bezeichnung, die keinen Wert meinen */
const NOT_A_VALUE = new Set([
  "string", "null", "none", "true", "false", "undefined", "optional", "required",
  "nein", "keine", "kein", "leer", "gesetzt", "vorhanden", "geändert", "geaendert", "gleich",
  "vergessen", "fehlt", "unbekannt", "unverändert", "abgelaufen", "falsch", "richtig",
  "ändern", "aendern", "zurücksetzen", "zuruecksetzen", "eingeben", "nötig", "noetig", "erforderlich",
  "siehe", "unter", "manager", "reset", "changed", "unknown", "missing", "expired", "needed",
  "pflicht", "standard", "geheim", "wichtig", "mind", "min", "max",
  "n/a", "tbd", "todo", "keins", "egal", "teil", "sache", "grund", "thema",
]);

const isNoWord = (value: string) => NOT_A_VALUE.has(value.toLowerCase());

/** Der Wert ohne Hervorhebung und Satzende: „**gesetzt**“, „vergessen?“ bleiben Wörter */
function bareWord(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && "*_~".includes(value[start])) start++;
  while (end > start && "*_~!?".includes(value[end - 1])) end--;
  return value.slice(start, end);
}

const isStrong = (word: string) => hasDigit(word) || /[!@#$%^&*_+]/.test(word);
const isPinLabel = (label: string | undefined) => /^(?:pin(?:[- ]?(?:code|nummer))?|geheimzahl)$/i.test(label ?? "");

/** Wert hinter einer Schlüssel-Bezeichnung: lang genug und nicht bloß eine Zahl oder ein Wort */
function judgeKey(value: string, { quoted }: ValueContext): boolean {
  if (isPlaceholder(value)) return false;
  if (quoted) return value.length >= 8;
  const word = bareWord(value);
  if (isNoWord(word)) return false;
  if (word.length >= 16 && !/^\d+$/.test(word)) return true;
  return word.length >= 8 && hasDigit(word) && hasLetter(word);
}

const strengthOf = (sep: string | undefined): Strength => {
  if (!sep || !/\S/.test(sep)) return "weak";
  if (/[:=>→：]|lautet|hei(?:ß|ss)t/i.test(sep)) return "explicit";
  return /[-–—]/.test(sep) ? "dash" : "is";
};

/** Ein Wort hinter einer Passwort-Bezeichnung, je nachdem, wie deutlich der Trenner ist */
function judgePassword(value: string, context: ValueContext): boolean {
  if (isPlaceholder(value)) return false;
  if (context.quoted) return true;
  if (DATE.test(value)) return false;
  const word = bareWord(value);
  if (isNoWord(word)) return false;
  const { strength } = context;
  const clear = strength === "explicit" || strength === "cell";
  // „Passwort (2FA)“, „Passwort (mind. 12 Zeichen)“ erklären; „Passwort (Sommer77)“ nennt den Wert
  if (!clear && WHOLE_WRAPPED.test(value)) return !/\s/.test(value) && value.length >= 8 && hasDigit(value) && hasLetter(value);
  // „PW 12,5“ ist eine Zahl; erst hinter „:“ oder „=“ kann sie der Wert sein
  if (!clear && /^\d+[.,]\d+$/.test(word)) return false;
  if (isPinLabel(context.label)) return word.length >= 4 && hasDigit(word);
  if (clear) return word.length >= 3;
  if (word.length < 4) return false;
  if (isStrong(word)) return true;
  // „Passwort - Waldmeister“ nennt einen Wert, „Passwort - das wichtigste Thema“ einen Satz
  if (strength === "dash") return context.standsAlone() && !PLACEHOLDER_WORDS.has(word.toLowerCase());
  // „Das Passwort ist Waldmeister“ nennt einen Wert, „Das Passwort ist abgelaufen“ einen Zustand
  if (strength === "is") return /^\p{Lu}/u.test(word) && !PLACEHOLDER_WORDS.has(word.toLowerCase());
  // „pw wortfolge“ meint fast immer einen Wert, „Passwort vergessen“ nicht
  return /^(?:pw|pwd)$/i.test(context.label ?? "") && /^\p{Ll}{6,}$/u.test(word);
}

const SCHEME = "(?:Basic|Token|Bearer|Digest|Negotiate|NTLM|ApiKey|Key|OAuth|[A-Z0-9]+-HMAC-SHA\\d+)";
const QUOTE_CHARS = "\"'`„“”‘’‚»«";
/** Verfahren vor dem eigentlichen Wert, auch in Anführungszeichen: Bearer "…", "Bearer …" */
const SCHEME_PREFIX = `(?:[${QUOTE_CHARS}]{0,3}(?<scheme>${SCHEME})[${QUOTE_CHARS}]{0,3}\\s+(?=\\S))?`;
const SCHEME_IN_CELL = new RegExp(`^[${QUOTE_CHARS}]{0,3}${SCHEME}[${QUOTE_CHARS}]{0,3}\\s+`, "i");

/** Parameterliste einer Kopfzeile: response="…", Signature=…; ein Verweis oder ein leerer Wert zählt nicht: token=$TOKEN, a="" */
const HEADER_PARAMETER = /(?:^|[\s,;"'`])[\w-]+=["'`]?(?![$<{[\s"'`]|$)/;

/** Authorization: mit Verfahren oder Parameterliste reichen 8 Zeichen, sonst muss es wie ein langes Token aussehen */
function judgeAuthorization(value: string, { scheme, strength }: ValueContext): boolean {
  const inCell = !scheme ? SCHEME_IN_CELL.exec(value) : null;
  const rest = inCell ? locateValue(value.slice(inCell[0].length)).value : value;
  if (isPlaceholder(rest)) return false;
  const named = scheme !== undefined || inCell !== null;
  if ((named || strength === "explicit" || strength === "cell") && HEADER_PARAMETER.test(rest)) return true;
  // Über mehrere Zeilen in Anführungszeichen gehört der Zeilenumbruch nicht zur Länge
  if (named) return /^\S{8,}/.test(rest.includes("\n") ? rest.replace(/\s/g, "") : rest);
  return rest.length >= 16 && hasDigit(rest);
}

/** Kette in der Parameterliste oder hinter einem unbekannten Verfahren: MeinVerfahren ab12cd34 */
function looksLikeCredential(word: string): boolean {
  const bare = word.slice(0, plainValueEnd(word)).replace(/^["'`]+/, "");
  return bare.length >= 8 && hasDigit(bare) && hasLetter(bare) && !isPlaceholder(bare);
}

/** Cookie und Set-Cookie: ein Parameter, dessen Wert wie ein Zugang aussieht; „Cookie: theme=dark“ nicht */
function judgeCookie(value: string): boolean {
  return value.split(/[\s;,]+/).some(part => {
    const at = part.indexOf("=");
    return at > 0 && looksLikeCredential(part.slice(at + 1));
  });
}

/** Bearer ohne Kopfzeile: nur, was lang genug ist und nicht wie ein Wort aussieht */
function judgeBearer(value: string): boolean {
  return !isPlaceholder(value) && value.length >= 16 && looksRandom(value);
}

/** Login: alex / Wert, Zugang alex:Wert. Ein Port oder eine Adresse ist kein Wert: Zugang imker.example:8443, Login https://… */
function judgePair(value: string, { pair, login, quoted }: ValueContext): boolean {
  if (isPlaceholder(value) || value.startsWith("/")) return false;
  if (quoted) return true;
  const separator = pair?.trim();
  if (/^\d+$/.test(value) || !hasLetter(value)) return false;
  if (hasDigit(value) || /[!@#$%^&*_+]/.test(value)) return true;
  return !!login && separator !== ":" && value.length >= 4;
}

const WORD_BEFORE = "(?<![\\p{L}\\d])";
/** Einschub zwischen Bezeichnung und Wert: „Passwort für die Seite …“; Verben trennen stattdessen */
const LINK_WORD = "(?!(?:ist|is|lautet|heißt|heisst|[-–—|])(?:\\s|$))[^\\s:=]{1,40}";
const LINK = `(?:\\s+(?:für|fuer|for|von|of|der|die|des|dem|den|the|zu|zur|zum|bei|beim|auf)(?:\\s+${LINK_WORD}){1,3})?`;
/** Direkt hinter einer Bezeichnung: Anführungszeichen, Backticks oder Klammern, auch zwei: "password": …, [Passwort]: … */
const LABEL_END = "[\"'`)\\]}>]{0,2}";
/** Zuweisung; ein Backtick dahinter schließt die Bezeichnung: `Passwort:` Wert */
const ASSIGN = "\\s*(?:=>|->|→|:=|::|==|[:=：])(?:`(?=\\s))?\\s*";
/** Strich mit Leerraum auf beiden Seiten; Passwort-Manager und Token-Limit bleiben Wörter */
const DASH = "\\s+[-–—]\\s+";
const SEPARATOR = `(?<sep>${ASSIGN}|\\s+(?:ist|is|lautet|heißt|heisst)(?:\\s*[:=])?(?:\`(?=\\s))?\\s+|${DASH}|\\s+)`;

/** Öffnendes Anführungszeichen und was es schließt; das längste zuerst */
const QUOTE_PAIRS: readonly (readonly [string, readonly string[]])[] = [
  ["```", ["```"]],
  ["~~~", ["~~~"]],
  ['"""', ['"""']],
  ["'''", ["'''"]],
  ["``", ["``"]],
  ['"', ['"']],
  ["'", ["'"]],
  ["`", ["`"]],
  ["„", ["“", "”", '"']],
  ["“", ["”", "“"]],
  ["‘", ["’", "‘"]],
  ["‚", ["‘", "’", "'"]],
  ["»", ["«"]],
  ["«", ["»"]],
];

/** Was hinter einem schließenden Zeichen steht; sonst gehört es zum Wert wie in Sommer'wiese77 */
const VALUE_END = "(?=$|[\\s.,;:!?)\\]}>\"'`„“”‘’«»])";

/** Schließendes Zeichen je öffnendem, über alle Zeilen; ein maskiertes Zeichen schließt nicht */
const CLOSER_OF: ReadonlyMap<string, RegExp> = new Map(
  QUOTE_PAIRS.map(([open, closers]) => {
    const close = closers.join("|");
    return [open, new RegExp(`(?<!\\\\)(?:${close})(?!${close})${VALUE_END}`, "gu")] as const;
  }),
);
const LINE_BREAK = /\n/g;
const PARAGRAPH_BREAK = /\r?\n[ \t]*\r?\n/g;
const LEADING_SPACE = /\s*/y;
/** Ein Codeblock ohne Ende läuft in Markdown bis zum Schluss des Texts */
const FENCES = new Set(["```", "~~~"]);

interface Hit {
  at: number;
  length: number;
}

type Search = (pattern: RegExp, from: number) => Hit | null;

/**
 * Suche nach vorn mit Gedächtnis: Wer nach dem nächsten Treffer fragt und noch vor dem letzten
 * steht, bekommt ihn ohne neue Suche, auch die Auskunft „keiner mehr“. So bleibt die Suche nach
 * einem schließenden Zeichen linear, gleich wie viele Bezeichnungen im Text davor stehen.
 */
function forwardSearch(text: string): Search {
  const known = new Map<RegExp, { from: number; hit: Hit | null }>();
  return (pattern, from) => {
    const last = known.get(pattern);
    if (last && last.from <= from && (!last.hit || last.hit.at >= from)) return last.hit;
    pattern.lastIndex = from;
    const match = pattern.exec(text);
    const hit = match && { at: match.index, length: match[0].length };
    known.set(pattern, { from, hit });
    return hit;
  };
}

/** Zu diesen schließenden Zeichen gehört das öffnende im selben Wert */
const OPENER_OF: Readonly<Record<string, string>> = {
  ")": "(", "]": "[", "}": "{", ">": "<", '"': '"', "'": "'", "`": "`", "“": "„", "”": "“", "’": "‘", "«": "»", "»": "«",
};

/** Ende eines Werts ohne Anführungszeichen: Satzzeichen und fremde Klammern am Schluss gehören zum Text */
function plainValueEnd(raw: string): number {
  const firstOpener = new Map<string, number>();
  let end = raw.length;
  while (end > 0) {
    const last = raw[end - 1];
    if (!".,;:|".includes(last)) {
      const opener = OPENER_OF[last];
      if (!opener) break;
      if (!firstOpener.has(opener)) firstOpener.set(opener, raw.indexOf(opener));
      const at = firstOpener.get(opener)!;
      if (at !== -1 && at < end - 1) break;
    }
    end--;
  }
  return end;
}

/** Was im Rohtreffer hinter einer Bezeichnung zu beurteilen (value) und zu ersetzen (start, end) ist */
function locateValue(raw: string): { value: string; start: number; end: number; quoted: boolean } {
  for (const [open, closers] of QUOTE_PAIRS) {
    if (!raw.startsWith(open)) continue;
    const closer = closers.find(close => raw.length >= open.length + close.length && raw.endsWith(close));
    const value = raw.slice(open.length, raw.length - (closer?.length ?? 0));
    return { value, start: open.length, end: open.length + value.length, quoted: true };
  }
  const end = plainValueEnd(raw);
  return { value: raw.slice(0, end), start: 0, end, quoted: false };
}

/** Text ohne Hervorhebungen und der Weg zurück in den Originaltext */
interface PlainText {
  plain: string;
  /** Lage im Originaltext, mit den Hervorhebungen, die direkt am Wert stehen */
  toSource(start: number, end: number): { start: number; end: number };
}

const DECORATION = /\*+|_+|~~|==|<\/?(?:b|strong|em|i|u|mark|code)>/gi;
/** Rest einer Zeile hinter ~~~, die einen Codeblock öffnet oder schließt; ~~~/.env~~ ist eine Durchstreichung */
const TILDE_FENCE_REST = /~[\w-]*[ \t]*(?:\r?\n|$)/y;
const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\d]/u.test(char);
const isBlank = (char: string | undefined) => char === undefined || /\s/.test(char);

/**
 * Hervorhebungen an Wortgrenzen entfernen. Mitten im Wort gehören sie zum Wort
 * (mein_ghp_…, Wald*geheim42), frei stehend sind sie Aufzählung oder Füllzeichen (* Punkt, ***).
 */
function stripDecoration(text: string): PlainText {
  const removed: { start: number; end: number }[] = [];
  const search = forwardSearch(text);
  /** Schließende Tags eines Paars über Zeilen: Es begrenzt einen Wert wie <pre> und bleibt stehen */
  const kept = new Set<number>();
  for (const match of text.matchAll(DECORATION)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (match[0][0] === "<") {
      if (kept.has(start)) continue;
      if (match[0][1] !== "/") {
        const closing = search(htmlCloser(match[0].slice(1, -1)), end);
        const lineBreak = closing && search(LINE_BREAK, end);
        if (closing && lineBreak && lineBreak.at < closing.at) {
          kept.add(closing.at);
          continue;
        }
      }
    }
    if (match[0] === "~~" && text[start - 1] !== "~") {
      TILDE_FENCE_REST.lastIndex = end;
      if (TILDE_FENCE_REST.test(text)) continue;
    }
    if (match[0][0] !== "<") {
      const before = text[start - 1];
      const after = text[end];
      if (isWordChar(before) && isWordChar(after)) continue;
      if (isBlank(before) && isBlank(after)) continue;
    }
    removed.push({ start, end });
  }
  if (removed.length === 0) return { plain: text, toSource: (start, end) => ({ start, end }) };

  const isRemoved = new Uint8Array(text.length + 1);
  let plain = "";
  let at = 0;
  for (const range of removed) {
    plain += text.slice(at, range.start);
    isRemoved.fill(1, range.start, range.end);
    at = range.end;
  }
  plain += text.slice(at);
  const sourceOf = new Int32Array(plain.length + 1);
  for (let source = 0, target = 0; source <= text.length; source++) {
    if (!isRemoved[source]) sourceOf[target++] = source;
  }
  return {
    plain,
    toSource(start, end) {
      let from = sourceOf[start];
      let to = sourceOf[end - 1] + 1;
      while (from > 0 && isRemoved[from - 1]) from--;
      while (to < text.length && isRemoved[to]) to++;
      return { start: from, end: to };
    },
  };
}

/** Dateipfad im Text; rooted: er beginnt an einer Wurzel, nicht bei einem Ordnernamen */
interface PathRegion {
  start: number;
  end: number;
  rooted: boolean;
}

/** Zeichen, die in einem Pfad nicht vorkommen oder ihn beenden: Zuweisung, Tabelle, Aufzählung, Anführungszeichen */
const PATH_STOP = "\\s\\\\/:=|,;\"'`<>";
const PATH_ROOT = /(?<![\p{L}\d_.\-/\\:~])(?:(?<rooted>[A-Za-z]:[\\/]|\\\\|file:\/\/\/?|~[\\/]|\.\.?[\\/]|\/(?=[\p{L}\d_.~-]))|[\p{L}\d_.-]+[\\/])/gu;
/** Ordnername bis zum nächsten Trenner, höchstens fünf Wörter; ein Satz ist länger oder enthält ein Bindewort */
const PATH_FOLDER = new RegExp(`[^${PATH_STOP}]*(?:[ \\t][^${PATH_STOP}]+){0,4}[\\\\/]`, "uy");
const PATH_NAME = new RegExp(`[^${PATH_STOP}]*`, "uy");
/** Ein Pfad ohne Wurzel zählt nur, wenn er wie eine Datei oder ein Ordner endet: docs/a.txt, docs/alt/; „Nutzer/Passwort alex/Wert“ nicht */
const PATH_FILE_END = /(?:[\\/]|\.[A-Za-z][A-Za-z0-9]{0,4})$/;
const HAS_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,4}$/;

/** Ein Ordnername mit Leerzeichen ist kein Satz: „app.conf enthält das …“ und „Sommer und …“ beenden den Pfad */
function isFolderName(folder: string): boolean {
  if (!/[ \t]/.test(folder)) return true;
  const words = folder.slice(0, -1).split(/[ \t]+/);
  return !HAS_EXTENSION.test(words[0]) && !words.some(word => PHRASE_STOPS.has(word.toLowerCase()));
}

/** Dateipfade in Textreihenfolge, auch mit Leerzeichen im Namen eines Ordners; ohne Pfad-Trenner gar nichts */
function pathRegions(text: string): PathRegion[] {
  if (!/[\\/]/.test(text)) return [];
  const regions: PathRegion[] = [];
  PATH_ROOT.lastIndex = 0;
  for (let root = PATH_ROOT.exec(text); root; root = PATH_ROOT.exec(text)) {
    const rooted = root.groups?.rooted !== undefined;
    let at = root.index + root[0].length;
    for (;;) {
      PATH_FOLDER.lastIndex = at;
      const folder = PATH_FOLDER.exec(text);
      if (!folder || !isFolderName(folder[0])) break;
      at += folder[0].length;
    }
    PATH_NAME.lastIndex = at;
    const name = PATH_NAME.exec(text);
    const end = at + (name?.[0].length ?? 0);
    if (rooted || PATH_FILE_END.test(text.slice(Math.max(root.index, end - 8), end))) {
      regions.push({ start: root.index, end, rooted });
    }
    PATH_ROOT.lastIndex = Math.max(end, root.index + root[0].length);
  }
  return regions;
}

function regionAt(regions: readonly PathRegion[], index: number): PathRegion | undefined {
  let low = 0;
  let high = regions.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const region = regions[middle];
    if (index < region.start) high = middle - 1;
    else if (index >= region.end) low = middle + 1;
    else return region;
  }
  return undefined;
}

/**
 * Steht die Bezeichnung in einem Pfad, nennt sie keinen Wert: Der Pfad reicht über den vermeintlichen
 * Wert hinaus (/Users/alex/Passwort Backup2026/notizen.txt), oder ein Pfad mit Wurzel endet mit
 * dem Namen, der ein Leerzeichen enthält (/Users/alex/Passwort Backup2026). Ein deutlicher Trenner
 * beendet jeden Pfad, darum zählt „Nutzer/Passwort: alex/Wert“ weiter.
 */
function labelInPath(regions: readonly PathRegion[], labelStart: number, valueStart: number, strength: Strength, quoted: boolean): boolean {
  const region = regionAt(regions, labelStart);
  if (!region) return false;
  if (region.end > valueStart) return true;
  return region.rooted && !quoted && (strength === "weak" || strength === "dash");
}

/** Verweist schon mit zwei Wörtern anderswohin: „siehe Tresor“, „mindestens zwölf“ */
const REFERENCE_WORDS = new Set(["siehe", "see", "steht", "liegt", "mindestens", "höchstens", "hoechstens"]);

/** So beginnt eine Beschreibung, keine Passphrase: „wird beim Start vergeben“. Bei zwei Wörtern reicht das nicht: „nur Mut“ kann ein Wert sein */
const DESCRIPTION_START = new Set([
  "wird", "werden", "muss", "müssen", "muessen", "soll", "sollte", "kann", "darf", "wie", "identisch",
  "nicht", "kein", "keine", "nur", "seit", "bereits", "bitte", "must", "should", "not",
  "am", "an", "hinter", "neben",
]);

/** So endet eine Beschreibung, neben den Wörtern aus NOT_A_VALUE: „noch nicht hinterlegt“ */
const DESCRIPTION_END = new Set([
  "gültig", "gueltig", "vergeben", "gespeichert", "hinterlegt", "verschlüsselt", "verschluesselt",
  "gehasht", "pflicht", "eintragen", "eingetragen", "offen",
]);

/** Einheit hinter einer Zahl: „mindestens 12 Zeichen“, „90 Tage“; „Sommer 77 Wiese“ hat keine */
const DESCRIPTION_UNITS = new Set([
  "zeichen", "stellen", "ziffern", "buchstaben", "tage", "wochen", "monate",
  "characters", "chars", "digits", "letters", "days", "weeks", "months",
]);

/** Ort hinter einer Präposition: „im Tresor“, „aus der .env“; „in der Wiese“ kann eine Passphrase sein */
const LOCATION_START = new Set(["im", "in", "aus", "auf", "unter"]);
const LOCATIONS = new Set([
  "tresor", "safe", "schrank", "matte", "vault", "wiki", "notizen", "schlüsselbund", "schluesselbund",
  "keychain", "bitwarden", "1password", "env", "manager",
]);

/**
 * Mehrere Wörter beschreiben etwas, statt eine Passphrase zu sein. Fehlende Ziffern allein
 * sagen das nicht: „Sommer Wiese“ ist ein Wert, „noch nicht gesetzt“ keiner. Darum zählen nur
 * Anfang, Ende, Zahl mit Einheit, Ort oder lauter bekannte Wörter; alles andere ist ein Wert,
 * auch wenn so einmal eine Beschreibung maskiert wird.
 */
function describesSomething(value: string): boolean {
  const words = value.toLowerCase().split(/[^\p{L}\d]+/u).filter(Boolean);
  if (words.length === 0) return true;
  const first = words[0];
  const last = words[words.length - 1];
  if (REFERENCE_WORDS.has(first) || NOT_A_VALUE.has(first) || DESCRIPTION_END.has(last) || NOT_A_VALUE.has(last)) return true;
  if (words.length >= 3 && DESCRIPTION_START.has(first)) return true;
  if (LOCATION_START.has(first) && LOCATIONS.has(last)) return true;
  if (words.some((word, index) => /^\d+$/.test(word) && DESCRIPTION_UNITS.has(words[index + 1]))) return true;
  return words.every(word => PLACEHOLDER_WORDS.has(word) || NOT_A_VALUE.has(word));
}

/** Mehrere Wörter als Wert, für jede Bezeichnung gleich. In einer Kopfzeile sind sie ein Spaltenname: „| Passwort | Letzte Änderung |“ */
function acceptsPhrase(value: string, kind: SecretKind, label: string | undefined, header = false): boolean {
  const words = value.split(/[\s,;]+/).filter(Boolean);
  if (words.some(word => hasDigit(word) && hasLetter(word))) return true;
  if (header) return false;
  const numeric = words.every(word => /^\d+$/.test(word));
  if (isPinLabel(label)) return numeric && words.join("").length >= 4;
  // Eine Zahl neben „Token“ ist eine Menge: „| Token | 15 20 |“
  if (numeric) return kind === "passwort";
  return !describesSomething(value);
}

/** Was hinter dem ersten Wort noch zum Wert gehört: Wörter einer Passphrase, weitere Ketten eines Schlüssels */
type TailKind = "words" | "chains";

interface LabelRule {
  kind: SecretKind;
  /** Bezeichnung und Trenner im Fließtext; den Wert dahinter liest readValue */
  regex: RegExp;
  /** Bezeichnung am Ende einer Zelle; davor darf etwas stehen: „Neues Passwort“ */
  cell?: RegExp;
  judge(value: string, context: ValueContext): boolean;
  /** Mehrere Wörter hinter dem Trenner können als Ganzes der Wert sein: „Sommer Wiese“ */
  phrases?: boolean;
  /** Was hinter einem angenommenen ersten Wort noch dazugehört */
  tail?: TailKind;
  /** Die Zelle ist als Ganzes der Wert: „Basic dXNlcjpwYXNz“ */
  wholeCell?: boolean;
  /** Der Wert reicht bis zum Zeilenende: Parameterliste einer Kopfzeile */
  wholeLine?: boolean;
}

interface LabelSpec {
  kind: SecretKind;
  label: string;
  flags: "gu" | "giu";
  /** Steht zwischen Trenner und Wert und gehört nicht zum Wert: das Verfahren einer Kopfzeile */
  prefix?: string;
  judge: LabelRule["judge"];
  phrases?: boolean;
  tail?: TailKind;
  wholeCell?: boolean;
  wholeLine?: boolean;
}

/** Linear auch bei viel Leerraum: Beide Wiederholungen stehen nie direkt hintereinander zur Wahl */
const CELL_END = `${LABEL_END}(?:\\s*(?:=>|->|→|:=|::|==|[:=：])${LABEL_END})?\\s*$`;

function labelRule({ kind, label, flags, prefix = "", judge, phrases, tail, wholeCell, wholeLine }: LabelSpec): LabelRule {
  return {
    kind,
    judge,
    phrases,
    tail,
    wholeCell,
    wholeLine,
    regex: new RegExp(`${label}${LABEL_END}${LINK}${SEPARATOR}${prefix}`, flags),
    cell: new RegExp(`${label}${LABEL_END}${LINK}${CELL_END}`, flags.replace("g", "")),
  };
}

const KEY_LABEL =
  "(?:api[-_ ]?keys?|apikeys?|api[-_ ]?schl(?:ü|ue)ssel|access[-_ ]?keys?|secret[-_ ]?keys?|private[-_ ]?keys?|client[-_ ]?secrets?|" +
  "tokens?|secrets?|geheimnis(?:se)?|schl(?:ü|ue)ssel|credentials?|x-amz-(?:signature|credential|security-token))";

const PASSWORD_LABEL =
  `(?:passw(?:ort|örter|oerter)|kennw(?:ort|örter|oerter)|passwords?|passwd|passphrase|passcode|geheimwort|zugangscode|` +
  `${WORD_BEFORE}pass(?=\\s*=)|${WORD_BEFORE}(?<label>pwd|pw|pin(?:[- ]?(?:code|nummer))?|geheimzahl))`;
/** Name einer Variable: nur groß geschrieben, primary_key und sort_key bleiben frei */
const VARIABLE_START = "(?<![\\p{L}\\d])(?<![\\p{L}\\d]_)[A-Z][A-Z0-9_]*";

/** Die einzige Liste der Bezeichnungen: Jede gilt mit jedem Trenner, im Fließtext und in Tabellen */
const LABEL_RULES: readonly LabelRule[] = [
  labelRule({ kind: "passwort", label: PASSWORD_LABEL, flags: "giu", judge: judgePassword, phrases: true }),
  labelRule({ kind: "passwort", label: `${VARIABLE_START}_PASS`, flags: "gu", judge: judgePassword, phrases: true }),
  labelRule({ kind: "schluessel", label: KEY_LABEL, flags: "giu", judge: judgeKey, tail: "chains" }),
  labelRule({ kind: "schluessel", label: `${VARIABLE_START}_KEYS?`, flags: "gu", judge: judgeKey, tail: "chains" }),
  labelRule({
    kind: "schluessel",
    label: "\\b(?:HTTP_(?:PROXY_)?)?Authorization",
    flags: "giu",
    prefix: SCHEME_PREFIX,
    judge: judgeAuthorization,
    wholeCell: true,
    wholeLine: true,
  }),
  labelRule({ kind: "schluessel", label: "\\bBearer", flags: "giu", judge: judgeBearer, tail: "chains" }),
  labelRule({ kind: "schluessel", label: "\\b(?:Set-)?Cookie", flags: "giu", judge: judgeCookie, wholeCell: true, wholeLine: true }),
  // Nutzer und Passwort als Paar: Hier trennt kein Trenner die Bezeichnung vom Wert, sondern der Name
  {
    kind: "passwort",
    regex: new RegExp(`${WORD_BEFORE}(?:(?<login>login|zugang|zugangsdaten|anmeldung|anmeldedaten)|wlan|wifi|konto|account|nutzer|benutzer|user)(?:\\s*[:=])?\\s+[^\\s:/]{1,100}(?<pair>\\s+/\\s+|:)`, "giu"),
    judge: judgePair,
    tail: "words",
  },
];

interface TokenPattern {
  kind: SecretKind;
  regex: RegExp;
  accept?(value: string): boolean;
}

/** Werte, die sich auch ohne Bezeichnung als Geheimnis verraten */
const TOKEN_PATTERNS: readonly TokenPattern[] = [
  { kind: "schluessel", regex: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { kind: "schluessel", regex: new RegExp(`${TOKEN_START}(?<value>(?:${KNOWN_PREFIXES.join("|")}))${TOKEN_END}`, "g"), accept: looksRandom },
  { kind: "schluessel", regex: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{0,200}:(?<value>[^\s/@]{1,200})(?=@)/gi, accept: value => !isPlaceholder(value) },
  // Lange Zufallskette: Hashes in Hex fallen heraus, gleich in welcher Schreibung, Pfade über ihre Trenner
  {
    kind: "schluessel",
    regex: /(?<![A-Za-z0-9/\\._-])(?<value>[A-Za-z0-9]{32,})(?![A-Za-z0-9/\\_-]|\.[A-Za-z])/g,
    accept: value => hasDigit(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && !/^[0-9a-f]+$/i.test(value),
  },
];

/** Hinter dem Wert endet die Zeile oder es folgt der nächste Abschnitt */
const VALUE_ALONE = /[ \t]*(?:\r?\n|$|[-–—|][ \t])/y;

function endsAlone(text: string, raw: string, end: number): boolean {
  if (/[.,;]$/.test(raw)) return true;
  VALUE_ALONE.lastIndex = end;
  return VALUE_ALONE.test(text);
}

/** Bindewörter und Artikel: Hier endet eine Passphrase ohne Anführungszeichen, hier beginnt der Satz */
const PHRASE_STOPS = new Set([
  "und", "oder", "für", "fuer", "von", "bei", "beim", "auf", "im", "in", "am", "an", "mit", "ohne", "seit", "unter", "über", "aus", "als",
  "ist", "sind", "war", "wird", "hat", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "zum", "zur", "nach", "vor",
  "and", "or", "for", "from", "with", "without", "at", "on", "is", "was", "the", "a", "an", "of", "to", "since",
]);

/** Hinter einem deutlichen Trenner verbinden sie Wörter eines Werts, wenn dahinter noch ein Wort des Werts folgt: „Sommer und Wiese“ */
const PHRASE_LINKS = new Set(["und", "oder", "and", "or"]);

const NEXT_WORD = /[ \t]+(\S+)/y;
const PIN_GROUP = /[ \t]+(\d{1,12})(?=[\s,;.]|$)/y;
/** Hier beginnt etwas Neues: das nächste Feld (Nutzer:alex, a=b) oder ein Zusatz in Klammern oder Anführungszeichen */
const NOT_A_PHRASE_WORD = /[:=：|]|^[(["'`{<„“‘‚»«]/;
/** Nach diesem Zeichen am Wortende beginnt der Satz */
const PHRASE_END = /[.,;!?)\]}>"'`]$/;
/** Bis zum Zeilenende nur noch einzelne Wörter oder Zifferngruppen, durch Kommas getrennt: „Birke, Wolke, Honig“; „, Nutzer alex“ ist keine solche Liste */
const WORD_LIST = /(?:[ \t]*[^\s,;:=：|()"'`[\]{}<>]+[ \t]*(?:[,;]|(?=\r?\n|$)))+/y;
const DIGIT_LIST = /(?:[ \t]*\d+(?:[ \t]+\d+)*[ \t]*(?:[,;]|(?=\r?\n|$)))+/y;
const LINE_END = /[ \t]*(?:\r?\n|$)/y;

/** Ende einer Liste hinter einem Komma, wenn sie bis zum Zeilenende reicht; hinter dem deutlichen Trenner gehört sie zum Wert */
function listEnd(text: string, at: number, pin: boolean): number | null {
  const list = pin ? DIGIT_LIST : WORD_LIST;
  list.lastIndex = at;
  const match = list.exec(text);
  if (!match) return null;
  const end = at + match[0].length;
  LINE_END.lastIndex = end;
  return LINE_END.test(text) ? end : null;
}

/**
 * Wörter, die hinter dem ersten Wort noch zum Wert gehören. Endet das erste Wort mit einem
 * Satzzeichen oder ist es selbst ein Bindewort, beginnt dort der Satz. Eine Obergrenze für die
 * Zahl der Wörter gibt es nicht, sonst bliebe vom Wert ein Rest sichtbar.
 */
function phraseTail(text: string, first: string, end: number, label: string | undefined, strength: Strength): number | null {
  const pin = isPinLabel(label);
  const listAfter = (at: number) => (strength === "explicit" ? listEnd(text, at, pin) : null);
  if (/[,;]$/.test(first) && !/[:|]/.test(first) && (!pin || /^\d+[,;]$/.test(first))) return listAfter(end);
  if (pin ? !/^\d+$/.test(first) : /[:|]/.test(first) || PHRASE_END.test(first) || PHRASE_STOPS.has(first.toLowerCase())) return null;
  const pattern = pin ? PIN_GROUP : NEXT_WORD;
  let tail: number | null = null;
  let at = end;
  for (;;) {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) break;
    const word = match[1];
    if (!pin && NOT_A_PHRASE_WORD.test(word)) break;
    const bare = word.slice(0, plainValueEnd(word)).toLowerCase();
    if (!pin && strength === "explicit" && PHRASE_LINKS.has(bare)) {
      at = pattern.lastIndex;
      continue;
    }
    if (!/[\p{L}\d]/u.test(word) || PHRASE_STOPS.has(bare)) break;
    // Hinter „ist“ geht mit dem ersten klein geschriebenen Wort der Satz weiter
    if (!pin && strength === "is" && !/^\p{Lu}/u.test(word)) break;
    at = pattern.lastIndex;
    tail = at;
    if (/[,;]$/.test(word)) return listAfter(at) ?? tail;
    if (PHRASE_END.test(word)) break;
    if (pin && /[,;]/.test(text[at] ?? "")) return listAfter(at + 1) ?? tail;
  }
  return tail;
}

/** Weitere Ketten hinter einem Schlüssel: „ab12cd34 ef56gh78“; ein Wort ohne Ziffer gehört zum Satz */
function keyTail(text: string, end: number): number {
  let at = end;
  for (;;) {
    NEXT_WORD.lastIndex = at;
    const match = NEXT_WORD.exec(text);
    if (!match) return at;
    const chain = match[1].slice(0, plainValueEnd(match[1]));
    if (chain.length < 8 || !hasDigit(chain) || !hasLetter(chain) || /[:=|]/.test(chain)) return at;
    at = NEXT_WORD.lastIndex;
    if (chain !== match[1]) return at;
  }
}

const startsSentence = (word: string) => {
  const lower = word.toLowerCase();
  return REFERENCE_WORDS.has(lower) || DESCRIPTION_START.has(lower) || PHRASE_STOPS.has(lower);
};

/** Reicht der Wert mit den Wörtern dahinter als Passphrase? Sonst zählt das erste Wort allein */
function acceptsLinePhrase(phrase: string, rule: LabelRule, strength: Strength, label: string | undefined, standsAlone: () => boolean): boolean {
  if (isPinLabel(label) || strength === "explicit") return acceptsPhrase(phrase, rule.kind, label);
  if (strength === "is") return /^\p{Lu}/u.test(phrase) && !describesSomething(phrase);
  return strength === "dash" && standsAlone() && acceptsPhrase(phrase, rule.kind, label);
}

/** Ein Wert ohne Anführungszeichen: Klammern oder ein reines Wort */
const PLAIN_VALUE_AT = new RegExp(`(?:${WRAPPED})${VALUE_END}|\\S+`, "uy");

interface ReadValue {
  /** Der Wert, wie er im Text steht, mit Anführungszeichen und Satzzeichen */
  raw: string;
  start: number;
  end: number;
  located: ReturnType<typeof locateValue>;
  /** Bis hierher reicht, was das Urteil gelesen hat */
  judgedEnd: number;
  /** Das Paar schließt im Text */
  closed?: boolean;
  /** Inhalt eines Werts, der über Zeilen geht */
  block?: string;
}

/**
 * Wert in Anführungszeichen, Backticks oder einem Codeblock, bis zum passenden schließenden
 * Zeichen, auch über Zeilen. Ohne schließendes Zeichen urteilt die erste Zeile mit Inhalt, und
 * maskiert wird der ganze Absatz, damit von einem Wert über Zeilen nichts stehen bleibt.
 */
function readQuoted(text: string, at: number, search: Search): ReadValue | null {
  for (const [open] of QUOTE_PAIRS) {
    if (!text.startsWith(open, at)) continue;
    const from = at + open.length;
    const closing = search(CLOSER_OF.get(open)!, from);
    // Gleich geschlossen: Der Wert ist leer
    if (closing?.at === from) return null;
    const lineBreak = search(LINE_BREAK, from);
    if (closing) {
      const inner = text.slice(from, closing.at);
      const end = closing.at + closing.length;
      const located = { value: inner.length > RESCAN_LIMIT ? inner : inner.trim(), start: open.length, end: closing.at - at, quoted: true };
      const block = lineBreak && lineBreak.at < closing.at ? inner : undefined;
      return { raw: text.slice(at, end), start: at, end, located, judgedEnd: end, closed: true, block };
    }
    LEADING_SPACE.lastIndex = from;
    const content = from + (LEADING_SPACE.exec(text)?.[0].length ?? 0);
    const firstLineEnd = search(LINE_BREAK, content)?.at ?? text.length;
    const end = FENCES.has(open) ? text.length : (search(PARAGRAPH_BREAK, content)?.at ?? text.length);
    const located = { value: text.slice(content, firstLineEnd).trim(), start: open.length, end: end - at, quoted: true };
    const block = lineBreak && lineBreak.at < end ? text.slice(content, end) : undefined;
    return { raw: text.slice(at, end), start: at, end, located, judgedEnd: Math.max(firstLineEnd, from), block };
  }
  return null;
}

/** Ein Wert: Anführungszeichen, Klammern oder ein reines Wort; für jede Bezeichnung dieselbe Stelle */
function readValue(text: string, at: number, search: Search): ReadValue | null {
  const quoted = readQuoted(text, at, search);
  if (quoted) return quoted;
  PLAIN_VALUE_AT.lastIndex = at;
  const match = PLAIN_VALUE_AT.exec(text);
  if (!match) return null;
  const raw = match[0];
  const end = at + raw.length;
  return { raw, start: at, end, located: locateValue(raw), judgedEnd: end };
}

/** Hier endet eine Kopfzeile: am Zeilenende oder an einer Tabellenspalte */
const HEADER_BREAK = /[ \t]\|(?=[ \t]|\r?$)|\r?\n/gm;
/** Die Parameterliste geht auf der nächsten Zeile weiter, wenn die Zeile mit einem Parameter beginnt, mit oder ohne Komma und Einrückung */
const HEADER_NEXT_PARAMETER = /[ \t]*[\w-]+=/y;

function headerLineEnd(text: string, from: number): number {
  HEADER_BREAK.lastIndex = from;
  for (let found = HEADER_BREAK.exec(text); found; found = HEADER_BREAK.exec(text)) {
    if (found[0].includes("|")) return found.index;
    const next = found.index + found[0].length;
    HEADER_NEXT_PARAMETER.lastIndex = next;
    if (!HEADER_NEXT_PARAMETER.test(text)) return found.index;
    HEADER_BREAK.lastIndex = next;
  }
  return text.length;
}

/**
 * Authorization und Proxy-Authorization: Das Verfahren bleibt stehen, der Rest gilt bis zum
 * Zeilenende als Wert, gleich wie die Parameter heißen: Digest, AWS4-HMAC-SHA256, OAuth. Steht
 * dahinter nichts mehr, bleibt die Maske im Anführungszeichen des Werts.
 */
function judgeHeaderLine(text: string, rule: LabelRule, read: ReadValue, groups: MatchGroups, strength: Strength, rejected: Verdict): Verdict {
  const { located } = read;
  const accepted = rule.judge(located.value, { ...groups, quoted: located.quoted, strength, standsAlone: () => true });
  const lineEnd = headerLineEnd(text, read.end);
  const others = lineEnd > read.end ? text.slice(read.end, lineEnd).trim() : "";
  if (!others) return accepted ? { span: { start: read.start + located.start, end: read.start + located.end }, consumed: read.end } : rejected;
  const named = groups.scheme !== undefined || strength === "explicit";
  if (accepted || (named && (HEADER_PARAMETER.test(others) || others.split(/\s+/).some(looksLikeCredential)))) {
    return { span: { start: read.start, end: lineEnd }, consumed: lineEnd };
  }
  // Der Rest ist schon gelesen; steht dort keine Kette, gilt das auch für jede spätere Kopfzeile darin
  return others.length > RESCAN_LIMIT ? { consumed: lineEnd } : rejected;
}

/** Ein zitierter Absatz oder Code statt eines Werts: Satzende, Zeichen aus Code oder mehrere klein geschriebene Wörter */
function readsAsText(block: string): boolean {
  const content = block.trim();
  if (!/\s/.test(content)) return false;
  if (/[.!?:;,]\s*(?:\n|$)|[=(){}<>/\\$]/.test(content)) return true;
  return content.split(/\s+/).filter(word => /^[\p{Ll}-]+$/u.test(word)).length >= 2;
}

/** Ergebnis des Urteils: was zu ersetzen ist und wo die Suche weitergeht */
interface Verdict {
  span?: { start: number; end: number };
  /** Bis hierher ist der Text gelesen; davor beginnt keine neue Bezeichnung */
  consumed: number;
}

/** Bis zu dieser Länge wird ein abgelehnter Wert selbst noch nach Bezeichnungen durchsucht: „Passwort Passwort: Wert“ */
const RESCAN_LIMIT = 200;

/**
 * Das Urteil über den Wert hinter einer Bezeichnung, für jede Bezeichnung derselbe Weg:
 * erst der ganze Rest als Passphrase, dann das erste Wort, dann was noch dazugehört.
 */
function judgeLabeledValue(text: string, rule: LabelRule, read: ReadValue, groups: MatchGroups, strength: Strength, alone: boolean): Verdict {
  const { raw, located } = read;
  const rejected = { consumed: read.judgedEnd - read.start <= RESCAN_LIMIT ? read.start : read.judgedEnd };
  const standsAlone = () => endsAlone(text, raw, read.end);
  if (read.block !== undefined) {
    // Die Bezeichnung steht am Ende einer Zeile, ohne Trenner, darunter ein Absatz oder Code: „Hinweise zum Passwort“. Was darin steht, wird weiter gelesen
    // Steht die Bezeichnung allein auf ihrer Zeile, ist der Block darunter ihr Wert
    if (strength === "weak" && !alone && groups.sep?.includes("\n") && (read.block.length > RESCAN_LIMIT || readsAsText(read.block))) return { consumed: read.start };
    // So lang ist kein Verweis; ein Urteil darüber kostete bei jeder Bezeichnung im Block den ganzen Block
    if (read.block.length > RESCAN_LIMIT) return { span: { start: read.start + located.start, end: read.start + located.end }, consumed: read.end };
  }
  if (rule.wholeLine) return judgeHeaderLine(text, rule, read, groups, strength, rejected);
  if (rule.phrases && !located.quoted && strength !== "weak" || isPinLabel(groups.label) && !located.quoted) {
    const tail = phraseTail(text, raw, read.end, groups.label, strength);
    if (tail !== null) {
      const phrase = text.slice(read.start, tail);
      const phraseAlone = () => endsAlone(text, phrase, tail);
      if (!isPlaceholder(raw) && !isNoWord(bareWord(raw)) && acceptsLinePhrase(phrase, rule, strength, groups.label, phraseAlone)) {
        return { span: { start: read.start, end: read.start + plainValueEnd(phrase) }, consumed: tail };
      }
      // Hinter „:“ beschreibt der ganze Rest etwas: „Passwort: noch nicht gesetzt“; das erste Wort allein ist dann kein Wert
      if (strength === "explicit" && describesSomething(phrase)) return { consumed: tail };
    }
  }
  // „Passwort: steht in der .env“, „Passwort: das alte“: Der Satz beginnt schon beim ersten Wort
  if (strength === "explicit" && !located.quoted && startsSentence(raw) && !standsAlone()) return rejected;
  if (!rule.judge(located.value, { ...groups, quoted: located.quoted, strength, standsAlone })) return rejected;
  if (!located.quoted && rule.tail === "words") {
    const tail = phraseTail(text, raw, read.end, groups.label, "explicit");
    if (tail !== null) return { span: { start: read.start, end: read.start + plainValueEnd(text.slice(read.start, tail)) }, consumed: tail };
  }
  if (!located.quoted && rule.tail === "chains" && located.end === raw.length) {
    const tail = keyTail(text, read.end);
    if (tail !== read.end) return { span: { start: read.start, end: read.start + plainValueEnd(text.slice(read.start, tail)) }, consumed: tail };
  }
  return { span: { start: read.start + located.start, end: read.start + located.end }, consumed: read.end };
}

/** Ohne Satzzeichen zwischen Bezeichnung und Wert: Dateiname oder Ordner statt Wert */
function namesFile(value: string): boolean {
  return /^[^\s/\\]+\.(?:txt|md|pdf|csv|json|ya?ml|xml|log|png|jpe?g|docx?|xlsx?|zip|kdbx|html?|sh|ts|js|py)$/i.test(value) || /^(?:[^\s/\\]+[/\\])+$/.test(value);
}

/**
 * Werte über Zeilen, deren Ende kein Anführungszeichen bestimmt (Issue #524, Runde 8). Die eine Regel:
 * Steht hinter einer eindeutigen Bezeichnung nichts, nur ein Trenner oder nur ein Blockeinstieg, dann
 * gehört, was darunter folgt, zum Wert, bis zum passenden Ende. Das sind:
 *
 * - ein Block unter der Bezeichnung: „Passwort:“ oder „password: |“ (YAML, auch >, |-, >-), darunter
 *   eingerückte Zeilen oder Zitatzeilen bis zum Ende der Einrückung, sonst Zeilen bis zur Leerzeile.
 *   Ohne Trenner zählt das nur, wenn die Bezeichnung allein auf ihrer Zeile steht (siehe labelAlone).
 * - ein HTML-Tag oder eine Klammer als Einstieg: bis zum schließenden Tag oder Zeichen, auch über
 *   Zeilen; fehlt es, bis zur Leerzeile.
 * - eingerückte Zeilen und Zitatzeilen direkt unter einem erkannten Wert (siehe continuationEnd).
 *
 * Maskiert wird der ganze Block, die Bezeichnung bleibt. Geurteilt wird Zeile für Zeile: Ist eine
 * Zeile ein Wert, ist der Block einer (siehe acceptsBlock). So bleiben Verweise, Masken und
 * Beschreibungen frei, gleich in welcher Form sie über Zeilen stehen.
 */
interface LineBlock {
  /** Was zu beurteilen ist, Zeile für Zeile */
  body: string;
  maskStart: number;
  maskEnd: number;
  /** Bis hierher reicht der Block mit seinem schließenden Zeichen */
  end: number;
}

/** Erste Zeichen der Zeilen, erst bei Bedarf berechnet */
interface LineIndex {
  startOf(index: number): number;
}

function lineIndex(text: string): LineIndex {
  let starts: number[] | null = null;
  return {
    startOf(index) {
      if (!starts) {
        starts = [0];
        for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
      }
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= index) low = middle;
        else high = middle - 1;
      }
      return starts[low];
    },
  };
}

/** Blockeinstieg in YAML am Zeilenende: |, >, |-, >+, |2, auch mit Kommentar dahinter („| # optional“) */
const YAML_BLOCK = /[|>][1-9+-]{0,2}(?:[ \t]+#[^\n]*|[ \t]*)(?=\r?\n)/y;
/** Einrückung und Zitatzeichen am Zeilenanfang; mehr davon heißt: die Zeile gehört zur Zeile darüber */
const LINE_PREFIX = /[ \t>]*/y;
const BLANK_RUN = /[ \t\r]*/y;
/** Der Trenner endet mit dem Zeilenende, der Wert beginnt auf der nächsten Zeile */
const BREAK_IN_SEPARATOR = /\n[ \t]*/y;
/** Vor einer Bezeichnung, die allein auf ihrer Zeile steht: Einrückung, Zitat, Aufzählung, Überschrift, höchstens ein „Thema:“ */
const LABEL_ALONE_BEFORE = /[ \t>#*+•\d.)-]*(?:[^\n:|]{1,60}:[ \t]+)?/y;
/** HTML-Tags, die einen Wert umschließen können; <dein passwort> oder <YOUR_API_KEY> sind Stellvertreter */
const HTML_OPEN = /<(pre|code|kbd|samp|tt|var|span|div|p|blockquote|q|td|th|li|textarea|output|data|b|strong|em|i|u|mark|s|del|ins|small|font)(?:[ \t][^<>\n]{0,200})?>/iy;
const BRACKET_CLOSERS: Readonly<Record<string, RegExp>> = { "(": /\)/g, "[": /\]/g, "{": /\}/g };
/** Öffnende und schließende Klammern einer Art, für die Zählung der Verschachtelung */
const BRACKET_EVENTS: Readonly<Record<string, RegExp>> = { "(": /[()]/g, "[": /[[\]]/g, "{": /[{}]/g };
const WRAPPED_AT = new RegExp(`(?:${WRAPPED})`, "uy");
const REST_BLANK = /[ \t]*(?:\r?\n|$)/y;
/** Hinter einem Wert bis zum Zeilenende nur noch Satzzeichen oder das schließende Zeichen */
const REST_CLOSING = /[ \t.,;:!?"'`)\]}>“”’«»]*(?=\r?\n)/y;

const htmlClosers = new Map<string, RegExp>();
function htmlCloser(name: string): RegExp {
  const key = name.toLowerCase();
  let closer = htmlClosers.get(key);
  if (!closer) {
    closer = new RegExp(`</${key}[ \\t]*>`, "gi");
    htmlClosers.set(key, closer);
  }
  return closer;
}

/** Öffnende und schließende Tags eines Namens, für die Zählung der Verschachtelung */
function htmlEvents(name: string): RegExp {
  const key = name.toLowerCase();
  return new RegExp(`<${key}(?:[ \\t][^<>\\n]{0,200})?>|</${key}[ \\t]*>`, "gi");
}

/** Zu einem öffnenden Tag oder einer öffnenden Klammer das passende Gegenstück, null ohne eines */
type Pairs = (kind: string, openAt: number) => Hit | null;

/**
 * Gegenstücke über die Verschachtelung: <div><div>a</div>b</div> endet am zweiten </div>,
 * (a\n(b)\nc) an der letzten Klammer. Je Art einmal über den ganzen Text mit einem Stapel,
 * so bleibt die Suche linear, gleich wie viele Bezeichnungen davor stehen.
 */
function pairMatcher(text: string): Pairs {
  const tables = new Map<string, Map<number, Hit | null>>();
  return (kind, openAt) => {
    let table = tables.get(kind);
    if (!table) {
      table = new Map();
      const events = BRACKET_EVENTS[kind] ?? htmlEvents(kind);
      events.lastIndex = 0;
      const open: number[] = [];
      for (let event = events.exec(text); event; event = events.exec(text)) {
        const closes = BRACKET_EVENTS[kind] ? event[0] !== kind : event[0][1] === "/";
        if (!closes) {
          open.push(event.index);
          table.set(event.index, null);
        } else if (open.length > 0) {
          table.set(open.pop()!, { at: event.index, length: event[0].length });
        }
      }
      tables.set(kind, table);
    }
    return table.get(openAt) ?? null;
  };
}

const prefixLength = (text: string, at: number) => {
  LINE_PREFIX.lastIndex = at;
  return LINE_PREFIX.exec(text)?.[0].length ?? 0;
};

/** Die Bezeichnung steht allein auf ihrer Zeile: „Passwort“, „## Token“, „- Passwort“, „Imkerei: Passwort“ */
function labelAlone(text: string, lineStart: number, labelAt: number): boolean {
  LABEL_ALONE_BEFORE.lastIndex = lineStart;
  const before = LABEL_ALONE_BEFORE.exec(text);
  return lineStart + (before?.[0].length ?? 0) === labelAt;
}

interface BlockOptions {
  /** Länger als das gilt der Block nicht als Wert; für Bezeichnungen ohne Trenner */
  limit: number;
  /** Nur Zeilen, die tiefer stehen als die Zeile der Bezeichnung */
  deeperOnly: boolean;
}

/**
 * Zeilen ab from, die zum Wert gehören. Steht die erste tiefer als die Zeile der Bezeichnung
 * (eingerückt oder mit mehr Zitatzeichen), reicht der Block bis zur ersten Zeile, die das nicht mehr
 * tut, Leerzeilen dazwischen eingeschlossen. Sonst reicht er bis zur nächsten Leerzeile.
 */
function linesBelow(text: string, from: number, labelPrefix: number, search: Search, { limit, deeperOnly }: BlockOptions): LineBlock | null {
  let deeper: boolean | null = null;
  let maskStart = -1;
  let maskEnd = -1;
  for (let at = from; at <= text.length; ) {
    const lineEnd = search(LINE_BREAK, at)?.at ?? text.length;
    BLANK_RUN.lastIndex = at;
    const content = at + (BLANK_RUN.exec(text)?.[0].length ?? 0);
    if (content >= lineEnd) {
      // Eine Leerzeile beendet den Block, außer zwischen tiefer stehenden Zeilen
      if (deeper === false || (deeper === null && deeperOnly)) break;
    } else {
      const prefix = prefixLength(text, at);
      if (deeper === null) {
        deeper = prefix > labelPrefix;
        // Eine Tabelle darunter hat eigene Zellen und Spalten
        if ((deeperOnly && !deeper) || text[content] === "|") return null;
        maskStart = content;
      } else if (deeper && prefix <= labelPrefix) {
        break;
      }
      let end = lineEnd;
      while (end > content && /[ \t\r]/.test(text[end - 1])) end--;
      maskEnd = end;
      if (maskEnd - maskStart > limit) return null;
    }
    if (lineEnd >= text.length) break;
    at = lineEnd + 1;
  }
  return maskStart === -1 ? null : { body: text.slice(maskStart, maskEnd), maskStart, maskEnd, end: maskEnd };
}

/** Block unter der Bezeichnung: hinter ihr nur der Trenner oder ein YAML-Einstieg */
function readLineBlock(text: string, labelAt: number, valueStart: number, strength: Strength, alone: boolean, lines: LineIndex, search: Search): LineBlock | null {
  const lineStart = lines.startOf(labelAt);
  const labelPrefix = prefixLength(text, lineStart);
  YAML_BLOCK.lastIndex = valueStart;
  if (strength === "explicit" && YAML_BLOCK.test(text)) {
    // In einer Tabellenzeile ist der Strich eine Spalte
    if (text.lastIndexOf("|", valueStart - 1) >= lineStart) return null;
    const next = search(LINE_BREAK, valueStart);
    return next ? linesBelow(text, next.at + 1, labelPrefix, search, { limit: Infinity, deeperOnly: false }) : null;
  }
  const lineBreak = search(LINE_BREAK, labelAt);
  if (!lineBreak || lineBreak.at >= valueStart) return null;
  BREAK_IN_SEPARATOR.lastIndex = lineBreak.at;
  if (!BREAK_IN_SEPARATOR.test(text) || BREAK_IN_SEPARATOR.lastIndex !== valueStart) return null;
  if (strength !== "explicit" && !(strength === "weak" && alone)) return null;
  return linesBelow(text, lineBreak.at + 1, labelPrefix, search, { limit: strength === "weak" ? RESCAN_LIMIT : Infinity, deeperOnly: false });
}

/** Ohne schließendes Zeichen, das öffnende am Zeilenende: Der Wert reicht bis zur Leerzeile */
function openToParagraph(text: string, from: number, maskStart: number, search: Search): LineBlock | null {
  REST_BLANK.lastIndex = from;
  if (!REST_BLANK.test(text) || from >= text.length) return null;
  const end = search(PARAGRAPH_BREAK, from)?.at ?? text.length;
  return end > from && /\S/.test(text.slice(from, end)) ? { body: text.slice(from, end), maskStart, maskEnd: end, end } : null;
}

/**
 * Ohne passendes Gegenstück, aber mit einem schließenden Zeichen auf einer späteren Zeile
 * (eine innere Klammer blieb offen): Der Wert reicht bis zur Leerzeile oder zum Textende,
 * mindestens aber bis zu diesem Zeichen, damit nichts stehen bleibt, was früher maskiert war.
 */
function unmatchedToParagraph(text: string, from: number, maskStart: number, firstClose: Hit, search: Search): LineBlock {
  const paragraph = search(PARAGRAPH_BREAK, firstClose.at)?.at ?? text.length;
  const end = Math.max(paragraph, firstClose.at + firstClose.length);
  return { body: text.slice(from, end), maskStart, maskEnd: end, end };
}

/**
 * Wie weit ein Tag oder eine Klammer als Einstieg reicht. "nested": bis zum passenden Gegenstück,
 * so bleibt bei <div><div>a</div>b</div> nichts stehen. "first": bis zum ersten schließenden Zeichen,
 * so gibt ein beschreibender Schluss wie in (4711\n(22)\noptional) den Wert davor nicht frei.
 * findSecrets liest den Text in beiden Lesarten und maskiert, was eine davon als Wert erkennt.
 */
type Reading = "nested" | "first";

/** HTML-Tag oder Klammer als Einstieg: bis zum schließenden Tag oder Zeichen nach der Lesart, auch über Zeilen */
function readEnclosed(text: string, at: number, search: Search, pairs: Pairs, reading: Reading): LineBlock | null {
  HTML_OPEN.lastIndex = at;
  const tag = HTML_OPEN.exec(text);
  if (tag) {
    const from = at + tag[0].length;
    const closing = reading === "nested" ? pairs(tag[1], at) : search(htmlCloser(tag[1]), from);
    if (closing) return { body: text.slice(from, closing.at), maskStart: from, maskEnd: closing.at, end: closing.at + closing.length };
    // Die Maske steht unter dem Tag, so bleibt <pre> am Zeilenende und ein zweites Maskieren ändert nichts
    LEADING_SPACE.lastIndex = from;
    const opened = openToParagraph(text, from, from + (LEADING_SPACE.exec(text)?.[0].length ?? 0), search);
    if (opened || reading === "first") return opened;
    const firstClose = search(htmlCloser(tag[1]), from);
    return firstClose ? unmatchedToParagraph(text, from, from, firstClose, search) : null;
  }
  const closer = BRACKET_CLOSERS[text[at]];
  if (!closer) return null;
  // Klammern auf einer Zeile liest readValue: (siehe Tresor), [Sommer77]
  WRAPPED_AT.lastIndex = at;
  if (WRAPPED_AT.test(text)) return null;
  const from = at + 1;
  const closing = reading === "nested" ? pairs(text[at], at) : search(closer, from);
  const lineBreak = search(LINE_BREAK, from);
  if (closing) return lineBreak && lineBreak.at < closing.at ? { body: text.slice(from, closing.at), maskStart: at, maskEnd: closing.at + 1, end: closing.at + 1 } : null;
  const opened = openToParagraph(text, from, at, search);
  if (opened || reading === "first") return opened;
  const firstClose = search(closer, from);
  return firstClose && lineBreak && lineBreak.at < firstClose.at ? unmatchedToParagraph(text, from, at, firstClose, search) : null;
}

/** Zeichen vor dem Inhalt einer Zeile im Block: Einrückung, Zitat, Aufzählung */
const BLOCK_LINE_MARKERS = /^[ \t]*(?:>[ \t]*)*(?:[-*+•][ \t]+|\d{1,3}[.)][ \t]+)?/;
/** Schlüssel einer Zuordnung im Block: „Bank: …“, "db": …; „Birke=1“ ist ein Wert */
const MAPPING_KEY = /^["']?[\p{L}_][\p{L}\d _.-]{0,40}["']?[ \t]*:(?=[ \t]|$)[ \t]*/u;

/** Eine Zeile im Block, für jede Bezeichnung gleich: ein Wort wie hinter „:“, mehrere wie eine Passphrase */
function acceptsBlockLine(rule: LabelRule, groups: MatchGroups, strength: Strength, line: string): boolean {
  const located = locateValue(line);
  const { value, quoted } = located;
  if (isPlaceholder(value)) return false;
  const context: ValueContext = { ...groups, quoted, strength: "explicit", standsAlone: () => true };
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= 1 || quoted || rule.wholeLine) return rule.judge(value, context);
  if (startsSentence(words[0])) return false;
  // Ohne Trenner ist ein ganzer Satz kein Wert: „Token“, darunter „Die Abrechnung läuft über Tokens.“
  if (strength === "weak" && words.length >= 3 && /[.!?]$/.test(line)) return false;
  return acceptsPhrase(value, rule.kind, groups.label);
}

/** Ist eine Zeile des Blocks ein Wert, ist es der Block; Verweise, Masken und Beschreibungen bleiben frei */
function acceptsBlock(rule: LabelRule, groups: MatchGroups, strength: Strength, body: string): boolean {
  // Über Zeilen verteilt beschreibt der Block als Ganzes etwas: „(mind. 12 Zeichen,“, darunter „Groß- und Kleinbuchstaben)“
  const joined = body.replace(/\s+/g, " ").trim();
  if (!joined.split(" ").some(word => hasDigit(word) && hasLetter(word)) && (isPlaceholder(joined) || describesSomething(joined))) return false;
  for (const raw of body.split("\n")) {
    let line = raw.replace(BLOCK_LINE_MARKERS, "").trim();
    const key = MAPPING_KEY.exec(line);
    if (key) line = line.slice(key[0].length);
    line = line.replace(/[,;]+$/, "").trim();
    if (line && acceptsBlockLine(rule, groups, strength, line)) return true;
  }
  return false;
}

/** Eingerückte Zeilen und Zitatzeilen direkt unter einem Wert ohne Anführungszeichen, der bis zum Zeilenende reicht, gehören dazu */
function continuationEnd(text: string, labelAt: number, spanEnd: number, lines: LineIndex, search: Search): number {
  REST_CLOSING.lastIndex = spanEnd;
  if (!REST_CLOSING.test(text)) return spanEnd;
  const lineBreak = search(LINE_BREAK, REST_CLOSING.lastIndex);
  if (!lineBreak) return spanEnd;
  const labelPrefix = prefixLength(text, lines.startOf(labelAt));
  const below = linesBelow(text, lineBreak.at + 1, labelPrefix, search, { limit: Infinity, deeperOnly: true });
  return below ? below.end : spanEnd;
}

/** Weitere Werte in Anführungszeichen auf derselben Zeile: Passwort: "a" und "b"; ein Schlüssel wie in {"password":"…","user":"alex"} nicht */
const MORE_QUOTED = /(?:[ \t]*(?:[,;/&+]|und|oder|and|or|sowie)[ \t]*(?:"[^"\n]*(?:"|(?=\r?\n|$))|'[^'\n]*(?:'|(?=\r?\n|$))|`[^`\n]*(?:`|(?=\r?\n|$))|„[^“”"\n]*(?:[“”"]|(?=\r?\n|$))|“[^”\n]*(?:”|(?=\r?\n|$))|»[^«\n]*(?:«|(?=\r?\n|$)))(?![ \t]*[:=]))+/iy;

function moreQuotedEnd(text: string, readEnd: number, spanEnd: number): number {
  MORE_QUOTED.lastIndex = readEnd;
  const more = MORE_QUOTED.exec(text);
  if (!more) return spanEnd;
  const end = readEnd + more[0].length;
  return QUOTE_CHARS.includes(text[end - 1]) && !QUOTE_CHARS.includes(text[end - 2] ?? "") ? end - 1 : end;
}

function labeledSpans(text: string, paths: readonly PathRegion[], search: Search, pairs: Pairs, reading: Reading): SecretSpan[] {
  const spans: SecretSpan[] = [];
  const lines = lineIndex(text);
  for (const rule of LABEL_RULES) {
    const { regex } = rule;
    regex.lastIndex = 0;
    for (let anchor = regex.exec(text); anchor; anchor = regex.exec(text)) {
      const groups = (anchor.groups ?? {}) as MatchGroups;
      const valueStart = anchor.index + anchor[0].length;
      const strength = groups.pair ? "explicit" : strengthOf(groups.sep);
      const breaks = groups.sep?.includes("\n") ?? false;
      const alone = strength === "weak" && breaks && labelAlone(text, lines.startOf(anchor.index), anchor.index);
      const quoted = readQuoted(text, valueStart, search);
      if (!quoted && !(strength === "weak" && breaks && !alone)) {
        const enclosed = readEnclosed(text, valueStart, search, pairs, reading);
        const block = enclosed ?? readLineBlock(text, anchor.index, valueStart, strength, alone, lines, search);
        if (block && !labelInPath(paths, anchor.index, valueStart, strength, enclosed !== null)) {
          if (acceptsBlock(rule, groups, strength, block.body)) {
            spans.push({ kind: rule.kind, start: block.maskStart, end: block.maskEnd });
            regex.lastIndex = block.end;
            continue;
          }
          const long = block.end - block.maskStart > RESCAN_LIMIT;
          // Ein Tag oder eine Klammer ohne Wert: weiter im Block suchen; ein langer Block ohne Wert ist gelesen
          if (enclosed || long) {
            regex.lastIndex = long ? block.end : valueStart;
            continue;
          }
        }
      }
      const read = quoted ?? readValue(text, valueStart, search);
      if (!read) continue;
      if (labelInPath(paths, anchor.index, valueStart, strength, read.located.quoted)) continue;
      if (strength !== "explicit" && !read.located.quoted && namesFile(read.located.value)) continue;
      const verdict = judgeLabeledValue(text, rule, read, groups, strength, alone);
      let consumed = verdict.consumed;
      if (verdict.span) {
        let end = verdict.span.end;
        if (read.located.quoted && read.closed && read.block === undefined) end = moreQuotedEnd(text, read.end, end);
        // Ein Wert in Anführungszeichen hat sein Ende schon; sonst gehören eingerückte Zeilen darunter dazu
        const below = read.located.quoted ? end : continuationEnd(text, anchor.index, end, lines, search);
        if (below > end) {
          end = below;
          consumed = Math.max(consumed, below);
        } else if (end > verdict.span.end) {
          consumed = Math.max(consumed, end + 1);
        }
        spans.push({ kind: rule.kind, start: verdict.span.start, end });
      }
      regex.lastIndex = consumed;
    }
  }
  return spans;
}

function tokenSpans(text: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  for (const pattern of TOKEN_PATTERNS) {
    for (const match of text.matchAll(pattern.regex)) {
      const groups = (match.groups ?? {}) as MatchGroups;
      const matchStart = match.index ?? 0;
      const matchEnd = matchStart + match[0].length;
      const raw = groups.value;
      if (raw === undefined) {
        spans.push({ kind: pattern.kind, start: matchStart, end: matchEnd });
        continue;
      }
      if (pattern.accept && !pattern.accept(raw)) continue;
      spans.push({ kind: pattern.kind, start: matchEnd - raw.length, end: matchEnd });
    }
  }
  return spans;
}

/** Zelle einer Tabellenzeile: Text ohne Leerraum am Rand und seine Lage im ganzen Text */
interface Cell {
  text: string;
  start: number;
}

interface FoundLabel {
  rule: LabelRule;
  groups: MatchGroups;
}

/** „grep Passwort“ in einer Befehlskette ist keine Bezeichnung */
const SHELL_COMMAND = /^(?:sudo\s+)?(?:grep|egrep|fgrep|rg|ack|ag|sed|awk|cat|less|more|head|tail|sort|uniq|wc|cut|tr|tee|xargs|find|ls|echo|printf|curl|git|journalctl|ps|docker|kubectl)(?:\s|$)/i;

function findCellLabel(cell: string): FoundLabel | null {
  // Ein Verweis nennt zwar eine Bezeichnung, ist aber selbst der Inhalt: „| Passwort | $DB_PASS | schon da“
  if (!cell || SHELL_COMMAND.test(cell) || isPlaceholder(cell)) return null;
  for (const rule of LABEL_RULES) {
    const match = rule.cell?.exec(cell);
    if (match) return { rule, groups: (match.groups ?? {}) as MatchGroups };
  }
  return null;
}

/** Trennzeile unter einer Kopfzeile: |---|:--:| */
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*\r?$/;
const INLINE_DELIMITER = /\|[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|/;
/** Zeilengrenze einer zusammengezogenen Tabelle: | alex | Wert | | mia | Wert | */
const ROW_BREAK = /\|[ \t]+(?=\|)/g;

const isTableDelimiter = (line: string) => line.includes("|") && TABLE_DELIMITER.test(line);

/** Zeile der Tabelle mit ihrer Lage im ganzen Text */
interface Row {
  line: string;
  offset: number;
}

/** Eine auf eine Zeile zusammengezogene Tabelle sieht aus wie mehrere: „| a | b | |---|---| | c | d |“ */
function logicalRows(line: string, offset: number): Row[] {
  if (isTableDelimiter(line)) return [{ line, offset }];
  const delimiter = INLINE_DELIMITER.exec(line);
  if (!delimiter) return [{ line, offset }];
  const rows: Row[] = [];
  const delimiterEnd = delimiter.index + delimiter[0].length;
  if (delimiter.index > 0) rows.push({ line: line.slice(0, delimiter.index), offset });
  rows.push({ line: delimiter[0], offset: offset + delimiter.index });
  let from = delimiterEnd;
  const rest = line.slice(from);
  for (const row of rest.matchAll(ROW_BREAK)) {
    const end = delimiterEnd + (row.index ?? 0) + 1;
    rows.push({ line: line.slice(from, end), offset: offset + from });
    from = end + row[0].length - 1;
  }
  if (line.slice(from).trim()) rows.push({ line: line.slice(from), offset: offset + from });
  return rows;
}

/**
 * Zellen einer Zeile. Hat die Zeile Striche mit Leerraum auf beiden Seiten, trennen nur solche
 * mit Leerraum und die am Zeilenrand: „| Passwort | Wald|meister77 |“ hat zwei Zellen, nicht drei.
 * Ein Text vor einem äußeren Strich gehört nicht zur Tabelle: „Imkerei: | Passwort | Wert |“.
 */
function tableCells(line: string, offset: number): Cell[] {
  const first = line.length - line.trimStart().length;
  const last = line.trimEnd().length - 1;
  const hasSpaceBeside = (at: number) => /\s/.test(line[at - 1] ?? "") || /\s/.test(line[at + 1] ?? "");
  const hasSpaceAround = (at: number) => /\s/.test(line[at - 1] ?? "") && /\s/.test(line[at + 1] ?? "");
  const pipes: number[] = [];
  let spaced = false;
  for (let at = line.indexOf("|"); at !== -1; at = line.indexOf("|", at + 1)) {
    if (line[at - 1] === "\\") continue;
    pipes.push(at);
    if (at !== first && at !== last && hasSpaceAround(at)) spaced = true;
  }
  const borders = spaced ? pipes.filter(at => at === first || at === last || hasSpaceBeside(at)) : pipes;
  if (borders.length === 0) return [];
  const cells: Cell[] = [];
  let from = 0;
  for (const border of [...borders, line.length]) {
    const raw = line.slice(from, border);
    cells.push({ text: raw.trim(), start: offset + from + raw.length - raw.trimStart().length });
    from = border + 1;
  }
  const closes = borders[borders.length - 1] === last;
  if (borders[0] === first || closes) cells.shift();
  if (closes) cells.pop();
  return cells;
}

/** Fundstelle in einer Zelle, wenn die Bezeichnung ihren Inhalt als Wert gelten lässt */
function cellSecret(text: string, search: Search, cell: Cell, { rule, groups }: FoundLabel, header: boolean): SecretSpan | null {
  if (!cell.text) return null;
  let located = locateValue(cell.text);
  // Schließt das Anführungszeichen nicht in der Zelle, kann es in einer späteren Zeile stehen
  if (located.quoted && located.end === cell.text.length) {
    const across = readQuoted(text, cell.start, search);
    if (across?.closed && across.block !== undefined) located = across.located;
  }
  const { value, start, end, quoted } = located;
  const context: ValueContext = { ...groups, strength: "cell", quoted, standsAlone: () => true };
  const accepted = () => {
    if (quoted) return rule.judge(value, context);
    if (rule.wholeCell) return !header && rule.judge(cell.text, context);
    if (isPlaceholder(value)) return false;
    if (/\s/.test(value)) return acceptsPhrase(value, rule.kind, groups.label, header);
    if (!header) return rule.judge(value, context);
    // In einer Kopfzeile ist ein reines Wort ein Spaltenname
    const word = bareWord(value);
    return word.length >= 4 && isStrong(word) && rule.judge(value, context);
  };
  return accepted() ? { kind: rule.kind, start: cell.start + start, end: cell.start + end } : null;
}

/** Tabellen zeilenweise: Der Wert steht neben seiner Bezeichnung oder in ihrer Spalte */
function tableSpans(text: string, search: Search): SecretSpan[] {
  if (!text.includes("|")) return [];
  const spans: SecretSpan[] = [];
  const rows: (Row | null)[] = [];
  let start = 0;
  for (const line of text.split("\n")) {
    if (line.includes("|")) rows.push(...logicalRows(line, start));
    else rows.push(null);
    start += line.length + 1;
  }
  let columns = new Map<number, FoundLabel>();
  rows.forEach((row, rowIndex) => {
    if (!row) {
      columns = new Map();
      return;
    }
    if (isTableDelimiter(row.line)) return;
    const next = rows[rowIndex + 1];
    const header = !!next && isTableDelimiter(next.line);
    const cells = tableCells(row.line, row.offset);
    const labels = cells.map(cell => findCellLabel(cell.text));
    const nextColumns = new Map<number, FoundLabel>();
    cells.forEach((cell, index) => {
      const beside = index > 0 ? labels[index - 1] : null;
      const found = beside && cellSecret(text, search, cell, beside, header);
      if (found) spans.push(found);
      const column = columns.get(index);
      const below = column && cellSecret(text, search, cell, column, false);
      if (below) spans.push(below);
      // Steht neben der Bezeichnung schon ihr Wert, auch maskiert, ist die Zeile keine Kopfzeile, sondern ein Eintrag
      const neighbor = cells[index + 1];
      const own = labels[index];
      if (own && !(neighbor && (neighbor.text.includes(SECRET_MASK) || cellSecret(text, search, neighbor, own, header)))) nextColumns.set(index, own);
    });
    if (header) columns = nextColumns;
  });
  return spans;
}

/** Ein Tag oder eine Klammer, die einen Wert umschließen kann; ohne sie sind beide Lesarten gleich */
const ENCLOSING = /[<([{]/;

/** Alle Fundstellen in Textreihenfolge, überlappende zusammengefasst */
export function findSecrets(text: string): SecretSpan[] {
  const { plain, toSource } = stripDecoration(text);
  const search = forwardSearch(plain);
  const paths = pathRegions(plain);
  const pairs = pairMatcher(plain);
  // Beide Lesarten von Tags und Klammern, jede für sich linear; maskiert wird, was eine erkennt
  const labeled = labeledSpans(plain, paths, search, pairs, "nested");
  if (ENCLOSING.test(plain)) labeled.push(...labeledSpans(plain, paths, search, pairs, "first"));
  const spans = [...tokenSpans(plain), ...labeled, ...tableSpans(plain, search)]
    .filter(span => span.end > span.start)
    .map(span => ({ kind: span.kind, ...toSource(span.start, span.end) }));
  spans.sort((a, b) => a.start - b.start);
  const merged: SecretSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      if (span.kind === "schluessel") last.kind = "schluessel";
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export const containsSecret = (text: string): boolean => findSecrets(text).length > 0;

/** Text mit SECRET_MASK statt jedes gefundenen Werts; ohne Fund derselbe Text */
export function maskSecrets(text: string): string {
  const spans = findSecrets(text);
  if (spans.length === 0) return text;
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start) + SECRET_MASK;
    at = span.end;
  }
  return out + text.slice(at);
}
