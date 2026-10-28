/**
 * Terminal-sicherer Text (Issue #60). Alles, was vom Server kommt
 * (Nachrichten, Topic-Namen, Fortschritt, Fehlermeldungen), läuft hier
 * durch, bevor tybo eigene Farben ergänzt: Eine Antwort darf das Terminal
 * nicht steuern (Farben, Cursor, Fenstertitel, Links per OSC 8, Zwischenablage
 * per OSC 52).
 *
 * Entfernt werden vollständige ESC- und C1-Sequenzen (CSI, OSC, DCS, APC,
 * PM, SOS), danach jedes verbliebene Steuerzeichen außer Zeilenumbruch und
 * Tabulator sowie Richtungs-Overrides (Bidi), mit denen sich Text optisch
 * umdrehen ließe. \r\n wird zu \n, ein einzelnes \r fällt weg.
 */

/** CSI: ESC [ oder 0x9b, Parameter, Zwischenbytes, ein Endbyte */
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/g;
/** OSC, DCS, SOS, PM, APC: bis BEL, ST (ESC \ oder 0x9c) oder zum Textende */
const STRING_SEQ = /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
/** Übrige Zwei-Zeichen-Folgen: ESC plus ein Zeichen */
const ESC_PAIR = /\u001b[ -~]?/g;
/** C0 ohne \t und \n, DEL, C1 */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/** Bidi-Einbettungen, -Overrides und -Isolate */
const BIDI = /[‪-‮⁦-⁩]/g;

export function sanitizeTerminal(value: unknown): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text
    .replace(/\r\n/g, "\n")
    .replace(STRING_SEQ, "")
    .replace(CSI, "")
    .replace(ESC_PAIR, "")
    .replace(CONTROL, "")
    .replace(BIDI, "");
}

/** Für einzeilige Angaben (Topic-Name, Statuszeile): Zeilenumbrüche und Tabs werden zu Leerzeichen */
export function sanitizeLine(value: unknown): string {
  return sanitizeTerminal(value).replace(/[\n\t]+/g, " ").trim();
}
