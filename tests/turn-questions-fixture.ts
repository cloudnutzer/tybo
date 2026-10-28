/**
 * Antworten des Modells mit und ohne Rückfrage, deutsch und englisch
 * (Issue #336). expected ist die erkannte Rückfrage (Frage, Antworten, Weg)
 * oder null: dann darf keine Rückfrage entstehen. Die Fälle mit null sind die
 * Fehlalarm-Proben (rhetorische Fragen, Floskeln, Fragen mitten im Text, in
 * Code, Zitat oder Anführungszeichen, ungültige und angefangene Tags).
 */

export interface QuestionCase {
  name: string;
  reply: string;
  expected: { question: string; options: string[]; via: "tag" | "marker" } | null;
}

/** Rückfragen über den Tag [FRAGE: Text | Option | ...] */
export const TAG_CASES: QuestionCase[] = [
  {
    name: "de: Tag mit zwei Antworten",
    reply: "Der Entwurf liegt bereit.\n\n[FRAGE: Soll ich ihn gleich verschicken? | Ja, verschicken | Nein, erst zeigen]",
    expected: { question: "Soll ich ihn gleich verschicken?", options: ["Ja, verschicken", "Nein, erst zeigen"], via: "tag" },
  },
  {
    name: "de: Tag mitten im Text, Kleinschreibung",
    reply: "Ich habe drei Wege gefunden. [frage: Welchen nehmen wir? | Bahn | Auto | Rad] Sag einfach Bescheid.",
    expected: { question: "Welchen nehmen wir?", options: ["Bahn", "Auto", "Rad"], via: "tag" },
  },
  {
    name: "en: Tag mit Auswahl",
    reply: "Two hosting options fit your budget.\n[FRAGE: Which one should I set up? | Option A (cheaper) | Option B (faster)]",
    expected: { question: "Which one should I set up?", options: ["Option A (cheaper)", "Option B (faster)"], via: "tag" },
  },
  {
    name: "Tag hat Vorrang vor Markern am Ende",
    reply: "[FRAGE: Termin am Montag oder Dienstag? | Montag | Dienstag]\n\nSoll ich danach noch die Agenda schicken?",
    expected: { question: "Termin am Montag oder Dienstag?", options: ["Montag", "Dienstag"], via: "tag" },
  },
  {
    name: "Tag mit einer einzigen Antwort",
    reply: "Alles vorbereitet. [FRAGE: Bereit zum Start? | Starten]",
    expected: { question: "Bereit zum Start?", options: ["Starten"], via: "tag" },
  },
];

/** Ungültige oder mehrdeutige Tags: keine Rückfrage, auch nicht über Marker */
export const INVALID_TAG_CASES: QuestionCase[] = [
  { name: "Tag ohne Antworten", reply: "Fertig.\n[FRAGE: Soll ich weitermachen?]", expected: null },
  { name: "Tag ohne Frage", reply: "Fertig.\n[FRAGE:  | Ja | Nein]", expected: null },
  { name: "Tag mit leeren Antworten", reply: "Fertig.\n[FRAGE: Soll ich? |  | ]", expected: null },
  { name: "Tag mit doppelten Antworten", reply: "[FRAGE: Soll ich? | Ja | ja ]", expected: null },
  {
    name: "Tag mit mehr als acht Antworten",
    reply: "[FRAGE: Welche Zahl? | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9]",
    expected: null,
  },
  {
    name: "zwei Tags in einer Antwort",
    reply: "[FRAGE: Erst A? | Ja | Nein]\n[FRAGE: Dann B? | Ja | Nein]",
    expected: null,
  },
  {
    name: "de: angefangener Tag ohne Schlussklammer, Marker-Frage danach",
    reply: "Entwurf fertig. [FRAGE: Soll ich ihn verschicken | Ja | Nein\n\nSoll ich ihn verschicken?",
    expected: null,
  },
  {
    name: "en: tag without closing bracket, marker question after it",
    reply: "Draft done. [FRAGE: Should I send it | Yes | No\n\nShould I send it?",
    expected: null,
  },
  { name: "de: Tag ohne Schlussklammer am Ende", reply: "Entwurf fertig.\n\n[FRAGE: Soll ich ihn verschicken? | Ja | Nein", expected: null },
  {
    name: "de: mehrzeiliger Tag, Marker-Frage danach",
    reply: "Entwurf fertig.\n[FRAGE: Soll ich ihn verschicken?\n| Ja\n| Nein]\n\nSoll ich ihn verschicken?",
    expected: null,
  },
  {
    name: "en: multi-line tag, marker question after it",
    reply: "Draft done.\n[FRAGE: Should I send it?\n| Yes | No]\n\nShould I send it?",
    expected: null,
  },
];

/**
 * Tags und Marker in geschützten Stellen (Zitat, Anführungszeichen,
 * eingerückter Code, Inline-Code): nur erwähnt, keine Rückfrage. Steht
 * daneben eine echte Marker-Frage, zählt nur die.
 */
export const PROTECTED_CASES: QuestionCase[] = [
  { name: "de: Tag im Blockzitat", reply: "Die Vorlage lautet:\n\n> [FRAGE: Soll ich den Termin absagen? | Ja | Nein]", expected: null },
  { name: "en: tag in a blockquote", reply: "The template reads:\n\n> [FRAGE: Should I cancel the meeting? | Yes | No]", expected: null },
  { name: "de: Tag in Anführungszeichen", reply: "Schreib dann „[FRAGE: Soll ich senden? | Ja | Nein]“ ans Ende.", expected: null },
  { name: "de: Tag in geraden Anführungszeichen am Ende", reply: 'Das Modell setzt den Tag "[FRAGE: Soll ich senden? | Ja | Nein]"', expected: null },
  { name: "en: tag in double quotes", reply: 'Add "[FRAGE: Should I send it? | Yes | No]" at the very end.', expected: null },
  { name: "en: tag inside a longer quotation", reply: "The prompt says “end with [FRAGE: Should I send it? | Yes | No] if unsure”.", expected: null },
  { name: "de: Tag in eingerücktem Code", reply: "Beispiel:\n\n    [FRAGE: Soll ich löschen? | Ja | Nein]", expected: null },
  { name: "en: tag in indented code", reply: "Example:\n\n\t[FRAGE: Should I delete it? | Yes | No]", expected: null },
  { name: "de: Marker-Frage in eingerücktem Code", reply: "So sieht der Prompt aus:\n\n    Soll ich das löschen?", expected: null },
  { name: "en: marker question in indented code", reply: "The prompt looks like this:\n\n    Should I delete it?", expected: null },
  { name: "de: Tag in Inline-Code", reply: "Der Tag sieht so aus: `[FRAGE: Soll ich? | Ja | Nein]`", expected: null },
  { name: "en: tag in inline code", reply: "The tag looks like `[FRAGE: Should I? | Yes | No]`", expected: null },
  { name: "de: angefangener Tag in Anführungszeichen", reply: "Der Tag beginnt mit „[FRAGE:“.\n\nSoll ich ein Beispiel zeigen?", expected: { question: "Soll ich ein Beispiel zeigen?", options: ["Ja", "Nein"], via: "marker" } },
  { name: "en: quoted tag, real marker question after it", reply: 'It starts with "[FRAGE: ... ]".\n\nShould I show an example?', expected: { question: "Should I show an example?", options: ["Yes", "No"], via: "marker" } },
  // Prüfung Runde 2: was der Markdown-Parser als Code oder Zitat liest, ist geschützt
  { name: "de: Tag als Zitat-Fortsetzung ohne >", reply: "> Vorlage:\n[FRAGE: Soll ich löschen? | Ja | Nein]", expected: null },
  { name: "en: tag as blockquote continuation without >", reply: "> Template:\n[FRAGE: Should I delete it? | Yes | No]", expected: null },
  { name: "de: Marker-Frage als Zitat-Fortsetzung", reply: "> Die Vorlage endet mit\nSoll ich das löschen?", expected: null },
  { name: "en: marker question as blockquote continuation", reply: "> The template ends with\nShould I delete it?", expected: null },
  { name: "de: Tag in Inline-Code über zwei Zeilen", reply: "So sieht es aus: `Beispiel\n[FRAGE: Soll ich löschen? | Ja | Nein]`", expected: null },
  { name: "en: tag in inline code across two lines", reply: "It looks like `example\n[FRAGE: Should I delete it? | Yes | No]`", expected: null },
  { name: "de: Tag in doppelten Backticks mit einzelnem Backtick darin", reply: "Der Tag: `` `x` [FRAGE: Soll ich? | Ja | Nein] `` fertig", expected: null },
  { name: "en: tag in double backticks with a single backtick inside", reply: "The tag: `` a ` [FRAGE: Should I? | Yes | No] `` done", expected: null },
  {
    name: "de: Zaun mit Text danach schließt den Codeblock nicht",
    reply: "```\nBeispiel\n``` nicht zu Ende\n[FRAGE: Soll ich löschen? | Ja | Nein]\n```",
    expected: null,
  },
  {
    name: "en: fence followed by text does not close the code block",
    reply: "```\nexample\n``` not closed\nShould I delete it?\n```",
    expected: null,
  },
  { name: "de: Codeblock in einem Listenpunkt", reply: "1. Vorlage:\n   ```\n   [FRAGE: Soll ich löschen? | Ja | Nein]\n   ```", expected: null },
  { name: "en: code block inside a list item", reply: "1. Template:\n   ```\n   [FRAGE: Should I delete it? | Yes | No]\n   ```", expected: null },
  {
    name: "de: eingerückte Zeile direkt nach einem Absatz ist kein Code",
    reply: "Alles vorbereitet,\n    [FRAGE: Bereit zum Start? | Starten]",
    expected: { question: "Bereit zum Start?", options: ["Starten"], via: "tag" },
  },
];

/** Rückfragen ohne Tag, erkannt über deutsche und englische Marker */
export const MARKER_CASES: QuestionCase[] = [
  {
    name: "de: Soll ich ...?",
    reply: "Ich habe die Liste sortiert und doppelte Einträge markiert.\n\nSoll ich die doppelten gleich löschen?",
    expected: { question: "Soll ich die doppelten gleich löschen?", options: ["Ja", "Nein"], via: "marker" },
  },
  {
    name: "de: Möchtest du, dass ich ...?",
    reply: "Die Rechnung ist geprüft. Möchtest du, dass ich sie an die Buchhaltung weiterleite?",
    expected: { question: "Möchtest du, dass ich sie an die Buchhaltung weiterleite?", options: ["Ja", "Nein"], via: "marker" },
  },
  {
    name: "de: Marker nach einem Nebensatz",
    reply: "Der Server läuft wieder. Wenn das für dich passt, soll ich den Neustart auch für morgen einplanen?",
    expected: {
      question: "Wenn das für dich passt, soll ich den Neustart auch für morgen einplanen?",
      options: ["Ja", "Nein"],
      via: "marker",
    },
  },
  {
    name: "de: Sollen wir ...? fett gesetzt",
    reply: "Plan steht.\n\n**Sollen wir mit Schritt 1 anfangen?**",
    expected: { question: "Sollen wir mit Schritt 1 anfangen?", options: ["Ja", "Nein"], via: "marker" },
  },
  {
    name: "de: Auswahl aus nummerierter Liste",
    reply:
      "Für das Wochenende gibt es drei Möglichkeiten:\n\n1. Wanderung am Samstag\n2. **Museum** am Sonntag\n3) Zuhause bleiben\n\nWelche Variante soll ich planen?",
    expected: {
      question: "Welche Variante soll ich planen?",
      options: ["Wanderung am Samstag", "Museum am Sonntag", "Zuhause bleiben"],
      via: "marker",
    },
  },
  {
    name: "de: Soll ich ... oder ...? mit Liste davor",
    reply: "Zwei Entwürfe:\n1. Kurz und sachlich\n2. Ausführlich mit Beispielen\nSoll ich Entwurf 1 oder 2 nehmen?",
    expected: {
      question: "Soll ich Entwurf 1 oder 2 nehmen?",
      options: ["Kurz und sachlich", "Ausführlich mit Beispielen"],
      via: "marker",
    },
  },
  {
    name: "en: Should I ...?",
    reply: "I found 14 unused branches.\n\nShould I delete them?",
    expected: { question: "Should I delete them?", options: ["Yes", "No"], via: "marker" },
  },
  {
    name: "en: Would you like me to ...?",
    reply: "The report is done. Would you like me to send it to the team?",
    expected: { question: "Would you like me to send it to the team?", options: ["Yes", "No"], via: "marker" },
  },
  {
    name: "en: Which option ...? with list",
    reply: "Three plans fit:\n\n1. Basic\n2. Pro\n3. Team\n\nWhich option do you prefer?",
    expected: { question: "Which option do you prefer?", options: ["Basic", "Pro", "Team"], via: "marker" },
  },
  {
    name: "de: Auswahl mit Inline-Code in den Punkten, Antworten wie geschrieben",
    reply: "Zwei Wege:\n\n1. Mit `npm` installieren\n2. **Manuell** in `__init__.py` eintragen\n\nWelche Variante soll ich nehmen?",
    expected: {
      question: "Welche Variante soll ich nehmen?",
      options: ["Mit `npm` installieren", "Manuell in `__init__.py` eintragen"],
      via: "marker",
    },
  },
  {
    name: "en: choice with inline code in the items, answers as written",
    reply: "Two ways:\n\n1. Run `bun install`\n2. Edit `__init__.py` **by hand**\n\nWhich one should I use?",
    expected: { question: "Which one should I use?", options: ["Run `bun install`", "Edit `__init__.py` by hand"], via: "marker" },
  },
];

/** Fehlalarm-Proben: Fragen, auf die keine Rückfrage mit Knöpfen folgen darf */
export const NO_QUESTION_CASES: QuestionCase[] = [
  { name: "de: rhetorische Frage mit Antwort danach", reply: "Warum ist das wichtig? Weil sonst die Daten verloren gehen.", expected: null },
  { name: "de: rhetorische Frage am Ende", reply: "Drei Jahre Arbeit, und am Ende reicht ein Klick. Wer hätte das gedacht?", expected: null },
  { name: "de: Marker-Frage, aber nicht am Ende", reply: "Soll ich ehrlich sein? Das Angebot ist zu teuer.", expected: null },
  { name: "de: Floskel zum Schluss", reply: "Hier ist die Zusammenfassung.\n\nKann ich dir sonst noch helfen?", expected: null },
  { name: "de: Floskel mit Möchtest du", reply: "Das war der Überblick. Möchtest du noch etwas wissen?", expected: null },
  { name: "de: Frage im Zitat", reply: "Sie schrieb:\n\n> Soll ich den Termin absagen?", expected: null },
  { name: "de: Frage im Codeblock", reply: "So sieht der Prompt aus:\n\n```\nSoll ich das löschen?\n```", expected: null },
  { name: "de: Frage in Inline-Code", reply: "Der Text lautet `Soll ich speichern?`", expected: null },
  { name: "de: Entweder-oder ohne Liste", reply: "Das Paket ist fertig. Soll ich es per Mail oder per Link schicken?", expected: null },
  { name: "de: Frage ohne Marker", reply: "Klingt kompliziert? Ist es nicht.", expected: null },
  { name: "de: offene Frage ohne Entscheidung", reply: "Wie war dein Wochenende?", expected: null },
  { name: "de: Frage in Anführungszeichen", reply: "Die Überschrift ist „Soll ich kündigen?“", expected: null },
  { name: "en: rhetorical question then answer", reply: "Why does this matter? Because the cache is shared.", expected: null },
  { name: "en: rhetorical question at the end", reply: "Ten years of logs, gone in a second. Who knew?", expected: null },
  { name: "en: closing pleasantry", reply: "That's the summary.\n\nAnything else I can help with?", expected: null },
  { name: "en: Should I in a quote", reply: "The ticket says:\n> Should I restart the server?", expected: null },
  { name: "en: either-or without list", reply: "Done. Should I use tabs or spaces?", expected: null },
  { name: "Antwort ohne Frage", reply: "Erledigt, die Datei liegt im Ordner.", expected: null },
  { name: "leere Antwort", reply: "", expected: null },
];

export const ALL_CASES: QuestionCase[] = [...TAG_CASES, ...INVALID_TAG_CASES, ...PROTECTED_CASES, ...MARKER_CASES, ...NO_QUESTION_CASES];
