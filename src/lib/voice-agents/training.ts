/**
 * Trainingsauswertung des Experten (Issue #496, Entscheidung 0026): Ein
 * Übungsgespräch wird gegen die drei Kriterien des Rezepts geprüft, mit der
 * Selbsteinschätzung im Gespräch verglichen, und die Antwort auf die
 * Abschlussfrage wird übernommen. Das Modell läuft über den Aux-Zweck
 * "voice-training"; dieses Modul baut nur Prompt, prüft die Antwort und hält
 * den Verlauf in data/voice-agents/<kennung>/training.jsonl fest.
 *
 * Prüfbar heißt: genau drei Bewertungen, jede einem Kriterium zugeordnet
 * (nr 1 bis 3, je einmal), nur erfüllt/teilweise/nicht, und jedes Zitat steht
 * wörtlich (bis auf Groß- und Kleinschreibung, Satzzeichen und Leerraum) in
 * einem zusammenhängenden Beitrag des Übenden, nie über eine Trainer-Äußerung
 * hinweg. Eine genannte Selbsteinschätzung hat einen Vergleich. Kurze
 * Antworten wie „Ja.“ zählen bei Selbsteinschätzung und Abschluss, wenn sie
 * ein ganzer Beitrag sind, bei Kriterien nie. Sonst gilt die Antwort als
 * unbrauchbar und der Aufrufer versucht es später erneut.
 *
 * Das Protokoll wird nicht wie bei call-summary nach 6000 Zeichen gekürzt:
 * Selbsteinschätzung und Abschlussantwort stehen am Ende. Erst über
 * PROMPT_TRANSCRIPT_CHARS fällt der Anfang weg, nie das Ende.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { parseAuxJSON } from "../aux-model";
import type { TranscriptLine } from "../phone/provider";
import { agentDataDir, agentsDataRoot, ensureRealDirs, readRegularFile, realDirsExist, type VoiceAgentPaths } from "./base";
import type { Recipe } from "./recipe";

export const RATINGS = ["erfuellt", "teilweise", "nicht"] as const;
export type Rating = (typeof RATINGS)[number];
export const RATING_TEXT: Record<Rating, string> = { erfuellt: "erfüllt", teilweise: "teilweise", nicht: "nicht erfüllt" };

/** Mehr Protokoll geht nicht in den Prompt; darüber fällt der Anfang weg */
export const PROMPT_TRANSCRIPT_CHARS = 60_000;
/** Kürzere Zitate (nach der Normalisierung) belegen nichts */
const MIN_QUOTE_CHARS = 3;
/** So viele Übungen zeigt der Verlauf je Kriterium */
export const HISTORY_SIZE = 5;

export type TrainingConfig = NonNullable<Recipe["training"]>;

export interface CriterionResult {
  /** Text des Kriteriums, wie er im Rezept stand */
  text: string;
  bewertung: Rating;
  /** Wörtlich aus den Beiträgen des Übenden; bei „nicht“ darf es fehlen */
  zitat: string | null;
  begruendung: string;
}

export interface TrainingResult {
  kriterien: CriterionResult[];
  /** undefined: im Rezept nicht verlangt; null: nicht genannt */
  selbsteinschaetzung?: { zitat: string; vergleich: string } | null;
  /** null: keine Antwort auf die Abschlussfrage */
  abschluss: string | null;
}

/** Zeile in training.jsonl */
export interface TrainingEntry extends TrainingResult {
  gespraech: string;
  /** Zeitpunkt des Gesprächs (ms), nicht der Auswertung */
  zeit: number;
  ausgewertetAm: string;
  /** Rezeptstand, gegen den ausgewertet wurde */
  rezeptHash: string;
  abschlussfrage: string;
}

/** Nur Buchstaben und Ziffern, klein, einfacher Leerraum: so zählt ein Zitat auch mit anderen Anführungszeichen */
export function normalizeQuote(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function userLines(lines: readonly TranscriptLine[]): TranscriptLine[] {
  return lines.filter((line) => line.speaker === "user" && line.text.trim() !== "");
}

/** Belegstellen des Übenden, normalisiert: einzelne Zeilen und zusammenhängende Beiträge */
interface Evidence {
  /** Je ein Eintrag für aufeinanderfolgende Zeilen des Übenden, ohne Trainer dazwischen */
  segments: string[];
  lines: string[];
}

export function traineeEvidence(lines: readonly TranscriptLine[]): Evidence {
  const segments: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.text.trim() === "") continue;
    if (line.speaker !== "user") {
      current = null;
      continue;
    }
    if (!current) segments.push((current = []));
    current.push(line.text);
  }
  const normalized = (texts: string[]) => texts.map(normalizeQuote).filter((text) => text !== "");
  return { segments: normalized(segments.map((segment) => segment.join(" "))), lines: normalized(userLines(lines).map((line) => line.text)) };
}

/**
 * Ein Zitat muss in einem zusammenhängenden Beitrag stehen, nie über eine
 * Trainer-Äußerung hinweg. Kürzer als MIN_QUOTE_CHARS zählt es nur mit
 * allowShort und nur als ganze Zeile oder ganzer Beitrag („Ja.“, „OK.“).
 */
function quoteFound(quote: string, evidence: Evidence, allowShort = false): boolean {
  const needle = normalizeQuote(quote);
  if (needle === "") return false;
  if (needle.length < MIN_QUOTE_CHARS) return allowShort && (evidence.lines.includes(needle) || evidence.segments.includes(needle));
  return evidence.segments.some((segment) => ` ${segment} `.includes(` ${needle} `));
}

/** Protokoll für den Prompt: vollständig, über der Grenze ohne den Anfang */
export function promptTranscript(lines: readonly TranscriptLine[]): string {
  const rendered = lines.map((line) => `${line.speaker === "agent" ? "TRAINER" : "TRAINEE"}: ${line.text}`);
  let total = rendered.reduce((sum, line) => sum + line.length + 1, 0);
  let start = 0;
  while (total > PROMPT_TRANSCRIPT_CHARS && start < rendered.length - 1) total -= rendered[start++]!.length + 1;
  return (start > 0 ? "[beginning of the conversation omitted]\n" : "") + rendered.slice(start).join("\n");
}

export function trainingPrompt(training: TrainingConfig, lines: readonly TranscriptLine[]): string {
  const criteria = training.kriterien.map((text, index) => `${index + 1}. ${text}`).join("\n");
  const selfAssessment = training.selbsteinschaetzung
    ? [
        "",
        "Self-assessment: somewhere in the conversation the TRAINEE may say how well they think they did.",
        'Return "selbsteinschaetzung": {"zitat": <verbatim words of the TRAINEE>, "vergleich": <one or two German sentences comparing it with your ratings>} or null if the TRAINEE never assessed themselves.',
      ]
    : ['Return "selbsteinschaetzung": null.'];
  return [
    "You evaluate a sales or communication training conversation between a TRAINER (voice agent) and a TRAINEE.",
    "Rate the TRAINEE against exactly these three criteria:",
    criteria,
    "",
    'For each criterion return {"nr": <1-3>, "bewertung": "erfuellt" | "teilweise" | "nicht", "zitat": <verbatim words of the TRAINEE that support the rating, or null when the rating is "nicht" and there is nothing to quote>, "begruendung": <one short German sentence>}.',
    "Quotes must be copied word for word from TRAINEE lines. Never quote the TRAINER, never paraphrase, never join words across a TRAINER line.",
    ...selfAssessment,
    "",
    `Closing question the TRAINER asks at the end: "${training.abschlussfrage}"`,
    'Return "abschluss": <verbatim answer of the TRAINEE to that question> or null if there is no answer.',
    "",
    'Answer with nothing but one JSON object: {"kriterien": [three objects], "selbsteinschaetzung": ..., "abschluss": ...}',
    "",
    "TRANSCRIPT:",
    promptTranscript(lines),
  ].join("\n");
}

export type ParsedTraining = { ok: true; result: TrainingResult } | { ok: false; fehler: string };

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Prüft die Antwort des Modells gegen Rezept und Protokoll (siehe oben) */
export function parseTrainingAnswer(answer: string, training: TrainingConfig, lines: readonly TranscriptLine[]): ParsedTraining {
  const raw = parseAuxJSON(answer);
  if (!raw || typeof raw !== "object") return { ok: false, fehler: "kein JSON-Objekt" };
  const evidence = traineeEvidence(lines);
  if (!Array.isArray(raw.kriterien) || raw.kriterien.length !== training.kriterien.length) return { ok: false, fehler: "nicht genau drei Bewertungen" };
  const byNumber = new Map<number, CriterionResult>();
  for (const item of raw.kriterien) {
    const nr = item?.nr;
    if (!Number.isInteger(nr) || nr < 1 || nr > training.kriterien.length || byNumber.has(nr)) return { ok: false, fehler: "Bewertungen keinem Kriterium eindeutig zugeordnet" };
    if (!RATINGS.includes(item.bewertung)) return { ok: false, fehler: `Bewertung ${nr} nicht erlaubt` };
    const zitat = isText(item.zitat) ? item.zitat.trim() : null;
    if (item.bewertung !== "nicht" && !zitat) return { ok: false, fehler: `Bewertung ${nr} ohne Zitat` };
    if (zitat && !quoteFound(zitat, evidence)) return { ok: false, fehler: `Zitat zu Kriterium ${nr} steht nicht im Protokoll` };
    byNumber.set(nr, { text: training.kriterien[nr - 1]!, bewertung: item.bewertung, zitat, begruendung: isText(item.begruendung) ? item.begruendung.trim() : "" });
  }
  const result: TrainingResult = { kriterien: training.kriterien.map((_, index) => byNumber.get(index + 1)!), abschluss: null };

  if (training.selbsteinschaetzung) {
    const self = raw.selbsteinschaetzung;
    if (self === null || self === undefined) result.selbsteinschaetzung = null;
    else if (!isText(self?.zitat) || !quoteFound(self.zitat, evidence, true)) return { ok: false, fehler: "Selbsteinschätzung steht nicht im Protokoll" };
    else if (!isText(self.vergleich)) return { ok: false, fehler: "Selbsteinschätzung ohne Vergleich" };
    else result.selbsteinschaetzung = { zitat: self.zitat.trim(), vergleich: self.vergleich.trim() };
  }

  if (raw.abschluss !== null && raw.abschluss !== undefined) {
    if (!isText(raw.abschluss) || !quoteFound(raw.abschluss, evidence, true)) return { ok: false, fehler: "Abschlussantwort steht nicht im Protokoll" };
    result.abschluss = raw.abschluss.trim();
  }
  return { ok: true, result };
}

export function trainingLogPath(kennung: string, paths: VoiceAgentPaths = {}): string {
  return join(agentDataDir(kennung, paths), "training.jsonl");
}

function isEntry(value: any): value is TrainingEntry {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.gespraech === "string" &&
    Number.isFinite(value.zeit) &&
    Array.isArray(value.kriterien) &&
    value.kriterien.every((k: any) => typeof k?.text === "string" && RATINGS.includes(k.bewertung))
  );
}

/** Alle Einträge; unlesbare Zeilen (etwa eine halb geschriebene nach einem Absturz) zählen nicht */
export async function readTrainingLog(kennung: string, paths: VoiceAgentPaths = {}): Promise<TrainingEntry[]> {
  if (!(await realDirsExist([agentsDataRoot(paths), agentDataDir(kennung, paths)]))) return [];
  const content = await readRegularFile(trainingLogPath(kennung, paths));
  if (content === null) return [];
  const entries: TrainingEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isEntry(parsed)) entries.push(parsed);
    } catch {
      // siehe oben
    }
  }
  return entries;
}

/** Hängt den Eintrag an, wenn es für das Gespräch noch keinen gibt (doppelte Bearbeitung, Absturz vor dem Statuswechsel) */
export async function appendTrainingEntry(kennung: string, entry: TrainingEntry, paths: VoiceAgentPaths = {}): Promise<boolean> {
  if ((await readTrainingLog(kennung, paths)).some((known) => known.gespraech === entry.gespraech)) return false;
  await ensureRealDirs([agentsDataRoot(paths), agentDataDir(kennung, paths)]);
  const handle = await open(trainingLogPath(kennung, paths), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    // Eine halb geschriebene letzte Zeile ohne Umbruch bekommt erst einen, sonst klebte der neue Eintrag daran
    const size = (await handle.stat()).size;
    let gap = "";
    if (size > 0) {
      const tail = (await readRegularFile(trainingLogPath(kennung, paths))) ?? "";
      if (!tail.endsWith("\n")) gap = "\n";
    }
    await handle.appendFile(gap + JSON.stringify(entry) + "\n");
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Verlauf je Kriterium des aktuellen Rezepts: die letzten fünf Übungen bis
 * einschließlich der gemeldeten, nach Gesprächszeit (eine verspätet
 * ausgewertete Übung rückt also an ihren Platz). Gezählt wird nur, wo dasselbe
 * Kriterium wörtlich bewertet wurde; nach einer Änderung beginnt es neu.
 */
export function criterionHistory(entries: readonly TrainingEntry[], current: TrainingEntry): Rating[][] {
  const ordered = [...entries.filter((entry) => entry.gespraech !== current.gespraech), current]
    .filter((entry) => entry.zeit <= current.zeit)
    .sort((a, b) => a.zeit - b.zeit || (a.gespraech === current.gespraech ? 1 : b.gespraech === current.gespraech ? -1 : a.gespraech.localeCompare(b.gespraech)));
  return current.kriterien.map((criterion) =>
    ordered
      .flatMap((entry) => entry.kriterien.filter((k) => k.text === criterion.text).map((k) => k.bewertung))
      .slice(-HISTORY_SIZE),
  );
}

function clock(zeit: number, timeZone: string | undefined): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
  try {
    return new Intl.DateTimeFormat("de-DE", { ...options, ...(timeZone ? { timeZone } : {}) }).format(zeit);
  } catch {
    return new Intl.DateTimeFormat("de-DE", options).format(zeit);
  }
}

export const TRAINING_TEXT = {
  head: (name: string, zeit: number, timeZone?: string) => `Übung mit ${name} vom ${clock(zeit, timeZone)}`,
  empty: (name: string, zeit: number, timeZone?: string) => `${TRAINING_TEXT.head(name, zeit, timeZone)}: Im Protokoll steht kein Beitrag von dir, es gibt keine Auswertung.`,
  failed: (name: string, zeit: number, kennung: string, timeZone?: string) =>
    `${TRAINING_TEXT.head(name, zeit, timeZone)}: Die Auswertung ist mehrmals gescheitert, ich versuche es nicht weiter. Das Protokoll liegt unter data/voice-agents/${kennung}/gespraeche/.`,
  /** Auswertung abgeschaltet (Issue #566): Claude fehlt, kein anderes Nebenmodell */
  disabled: (name: string, zeit: number, kennung: string, timeZone?: string) =>
    `${TRAINING_TEXT.head(name, zeit, timeZone)}: Keine Auswertung, weil sie über Claude liefe und Claude hier nicht installiert oder nicht angemeldet ist. Abhilfe: Claude anmelden oder ein anderes Nebenmodell einstellen (AUX_MODEL_VOICE_TRAINING oder WebUI, Modelle). Das Protokoll liegt unter data/voice-agents/${kennung}/gespraeche/.`,
  noSelf: "Selbsteinschätzung: nicht genannt.",
  noClosing: "keine Antwort",
} as const;

/** Meldung nach der Auswertung, Klartext ohne Markdown */
export function trainingMessage(name: string, entry: TrainingEntry, history: Rating[][], timeZone?: string): string {
  const parts = [`${TRAINING_TEXT.head(name, entry.zeit, timeZone)}`];
  entry.kriterien.forEach((criterion, index) => {
    const lines = [`${index + 1}. ${criterion.text}: ${RATING_TEXT[criterion.bewertung]}`];
    if (criterion.zitat) lines.push(`   „${criterion.zitat}“`);
    if (criterion.begruendung) lines.push(`   ${criterion.begruendung}`);
    const past = history[index] ?? [];
    if (past.length > 1) lines.push(`   Letzte ${past.length} Übungen, älteste zuerst: ${past.map((rating) => RATING_TEXT[rating]).join(", ")}`);
    parts.push(lines.join("\n"));
  });
  if (entry.selbsteinschaetzung === null) parts.push(TRAINING_TEXT.noSelf);
  else if (entry.selbsteinschaetzung) {
    parts.push([`Selbsteinschätzung: „${entry.selbsteinschaetzung.zitat}“`, ...(entry.selbsteinschaetzung.vergleich ? [`Vergleich: ${entry.selbsteinschaetzung.vergleich}`] : [])].join("\n"));
  }
  parts.push(`${entry.abschlussfrage}\n${entry.abschluss ? `„${entry.abschluss}“` : TRAINING_TEXT.noClosing}`);
  return parts.join("\n\n");
}
