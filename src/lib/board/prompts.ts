/**
 * Prompts der Board-Sitzung (Issue #357): Beitrag eines Agenten und
 * Zusammenfassung von General. runBoardMeeting baut seine Prompts nur hier.
 *
 * Beitrag: Thema (Zusatzkontext nach /board), Datenblock des Agenten,
 * bisherige Beiträge gekürzt, Auftrag mit 2 bis 4 Punkten. Ist der
 * Datenblock leer, verlangt der Auftrag keinen Bezug auf Live-Daten.
 *
 * Zusammenfassung: alle Beiträge vollständig, dazu der gemeinsame Stand
 * (sharedSummary), Auftrag mit Themen, Konflikten und 3 bis 5 Maßnahmen mit
 * Zuständigkeit.
 */

/** Beitrag eines Agenten in der Sitzung; null heißt: kein Beitrag geliefert */
export interface BoardTurn {
  agent: string;
  text: string | null;
}

/** So viele Zeichen eines früheren Beitrags sieht der nächste Agent */
export const EARLIER_EXCERPT_CHARS = 300;

const NO_CONTRIBUTION = "(kein Beitrag)";

function excerpt(text: string | null): string {
  if (text === null) return NO_CONTRIBUTION;
  return text.length > EARLIER_EXCERPT_CHARS ? `${text.slice(0, EARLIER_EXCERPT_CHARS)} …` : text;
}

const paragraphs = (parts: (string | false | undefined)[]) => parts.filter((p): p is string => !!p).join("\n\n");

export interface ContributionPromptInput {
  /** Thema nach /board, leer ohne Thema */
  topic?: string;
  /** Datenblock des Agenten (src/lib/board/briefs.ts), leer ohne Daten */
  dataBlock: string;
  /** Beiträge der Agenten vor diesem, in Reihenfolge */
  earlier: readonly BoardTurn[];
}

export function contributionPrompt({ topic, dataBlock, earlier }: ContributionPromptInput): string {
  const hasData = dataBlock.trim() !== "";
  const task = hasData
    ? "Stütze dich dabei auf die Einträge und Zahlen unter „Live-Daten“ oben und nenne sie konkret."
    : "Für dein Fachgebiet liegen in dieser Sitzung keine Live-Daten vor. Argumentiere aus deinem Fachwissen und dem bisherigen Gespräch und erfinde keine Zahlen.";
  return paragraphs([
    "Du nimmst an einer Board-Sitzung teil und bringst die Sicht deines Fachgebiets ein.",
    topic?.trim() && `Thema der Sitzung: ${topic.trim()}`,
    hasData && dataBlock.trim(),
    earlier.length > 0 && ["## Bisherige Beiträge (gekürzt)", ...earlier.map(turn => `**${turn.agent}**: ${excerpt(turn.text)}`)].join("\n"),
    `Dein Auftrag: Nenne 2 bis 4 Punkte, die aus deiner Sicht jetzt am meisten zählen, knapp und begründet. ${task}`,
  ]);
}

export interface SynthesisPromptInput {
  /** Alle Beiträge der Sitzung in Reihenfolge */
  turns: readonly BoardTurn[];
  /** Gemeinsamer Stand aus den Daten (sharedSummary), leer ohne */
  summary: string;
}

export function synthesisPrompt({ turns, summary }: SynthesisPromptInput): string {
  const hasSummary = summary.trim() !== "";
  const contributions = turns.map(turn => `### ${turn.agent.toUpperCase()}\n${turn.text ?? NO_CONTRIBUTION}`).join("\n\n---\n\n");
  return paragraphs([
    "Die Board-Sitzung ist vorbei. Fasse sie als Leitung zusammen.",
    `## Beiträge\n\n${contributions}`,
    hasSummary && `## Aktueller Stand\n${summary.trim()}`,
    "Dein Auftrag: Nenne die tragenden Themen, zeige, wo sich die Agenten widersprechen oder einig sind, " +
      "und schlage 3 bis 5 konkrete Maßnahmen vor, jede mit einer klaren Zuständigkeit." +
      (hasSummary ? " Beziehe die Maßnahmen auf den aktuellen Stand oben." : ""),
  ]);
}
