/**
 * Rezept in Klartext (Issue #495): Abschnitte mit Feld und Wert für die
 * WebUI, nie das JSON selbst. Nur lesend, ohne Sprachmodell. Was im Rezept
 * fehlt, steht nicht da; Pflichtfelder stehen immer da. Die Kennung der
 * Telefonnummer ist die beim Anbieter, keine Rufnummer.
 */
import type { Recipe } from "./recipe";

export interface RecipeLine {
  feld: string;
  wert: string;
}

export interface RecipeSection {
  titel: string;
  zeilen: RecipeLine[];
}

const yesNo = (value: boolean) => (value ? "ja" : "nein");

const TEMPLATE: Record<Recipe["vorlage"], string> = {
  anrufannahme: "Anrufannahme",
  jarvis: "Persönlicher Assistent (Jarvis)",
  experte: "Experte zum Üben",
};

const MEMORY: Record<Recipe["gedaechtnis"], string> = {
  keins: "keins",
  thema: "nur das Thema (Wissensdatei)",
  voll: "voll, mit tybos Gedächtnis",
};

const VOICE_KIND: Record<Recipe["stimme"]["art"], string> = {
  bibliothek: "aus der Bibliothek des Anbieters",
  design: "entworfen",
  eigene: "eigene Stimme",
};

const BRAIN: Record<Recipe["gehirn"]["art"], string> = {
  anbieter: "beim Anbieter",
  bruecke: "über die Sprach-Brücke von tybo",
};

const CALLERS = { alle: "alle", freigegeben: "nur freigegebene Nummern" } as const;

const TOOL_APPROVAL = { ohne: "ohne Freigabe", nachher: "Freigabe nachher" } as const;

function list(values: readonly string[]): string {
  return values.length > 0 ? values.join("; ") : "keine";
}

function minutes(n: number): string {
  return `${n} ${n === 1 ? "Minute" : "Minuten"}`;
}

function target(ziel: string): string {
  if (ziel === "direktchat") return "Direktchat";
  const topic = /^topic:(\d+)$/.exec(ziel);
  return topic ? `Topic ${topic[1]}` : ziel;
}

export function describeRecipe(recipe: Recipe): RecipeSection[] {
  const p = recipe.persona;
  const sections: RecipeSection[] = [
    {
      titel: "Allgemein",
      zeilen: [
        { feld: "Name", wert: recipe.name },
        { feld: "Kennung", wert: recipe.kennung },
        { feld: "Vorlage", wert: TEMPLATE[recipe.vorlage] ?? recipe.vorlage },
        { feld: "Zweck", wert: recipe.zweck },
      ],
    },
    {
      titel: "Persona",
      zeilen: [
        { feld: "Rolle", wert: p.rolle },
        { feld: "Anrede", wert: p.anrede === "du" ? "du" : "Sie" },
        { feld: "Sprachen", wert: p.sprachen.join(", ") },
        { feld: "Erster Satz", wert: p.ersterSatz },
        ...(p.kiHinweis ? [{ feld: "KI-Hinweis", wert: p.kiHinweis }] : []),
        { feld: "Eigene Regeln", wert: list(p.regeln) },
      ],
    },
    {
      titel: "Stimme und Gehirn",
      zeilen: [
        { feld: "Stimme", wert: `${VOICE_KIND[recipe.stimme.art]}${recipe.stimme.voiceId ? `, ${recipe.stimme.voiceId}` : ", Standardstimme"}` },
        { feld: "Sprachmodell der Stimme", wert: recipe.stimme.modell },
        { feld: "Tempo", wert: String(recipe.stimme.tempo).replace(".", ",") },
        { feld: "Gehirn", wert: `${BRAIN[recipe.gehirn.art]}, ${recipe.gehirn.modell}` },
        { feld: "Denkauftrag", wert: yesNo(recipe.gehirn.denkauftrag) },
        { feld: "Gedächtnis", wert: MEMORY[recipe.gedaechtnis] ?? recipe.gedaechtnis },
        ...(recipe.wissen ? [{ feld: "Wissensdatei", wert: recipe.wissen.datei }] : []),
        {
          feld: "Werkzeuge",
          wert: list(recipe.werkzeuge.map((w) => (w.freigabe ? `${w.name} (${TOOL_APPROVAL[w.freigabe]})` : w.name))),
        },
      ],
    },
  ];
  const z = recipe.zugang;
  sections.push({
    titel: "Zugang und Grenzen",
    zeilen: [
      { feld: "Im Browser", wert: z.web?.link === true ? "ja, nach Anmeldung in der WebUI" : "nein" },
      {
        feld: "Telefon",
        wert: z.telefon ? `Nummer beim Anbieter ${z.telefon.nummer}, Anrufer: ${CALLERS[z.telefon.anrufer]}, PIN: ${yesNo(z.telefon.pin)}` : "nein",
      },
      { feld: "Längstes Gespräch", wert: minutes(z.maxMinuten) },
      { feld: "Minuten im Monat", wert: String(z.budget.minutenMonat) },
      ...(z.telefon ? [{ feld: "Anrufe je Nummer und Tag", wert: String(z.budget.anrufeJeNummerTag) }] : []),
    ],
  });
  const n = recipe.nachlauf;
  sections.push({
    titel: "Nach dem Gespräch",
    zeilen: [
      { feld: "Zusammenfassung", wert: yesNo(n.zusammenfassung) },
      { feld: "Offener Faden", wert: yesNo(n.faden) },
      { feld: "Kalendervorschlag", wert: yesNo(n.kalendervorschlag) },
      { feld: "Anrufer merken", wert: yesNo(n.anruferMerken) },
      { feld: "Training", wert: yesNo(n.training) },
      { feld: "Ziel der Meldung", wert: target(n.ziel) },
    ],
  });
  if (recipe.training) {
    const t = recipe.training;
    sections.push({
      titel: "Training",
      zeilen: [
        { feld: "Rollen", wert: list(t.rollen) },
        { feld: "Einwände", wert: list(t.einwaende) },
        { feld: "Kriterien", wert: list(t.kriterien) },
        { feld: "Selbsteinschätzung", wert: yesNo(t.selbsteinschaetzung) },
        { feld: "Abschlussfrage", wert: t.abschlussfrage },
      ],
    });
  }
  sections.push({
    titel: "Tests",
    zeilen: recipe.tests.map((test) => ({
      feld: test.name,
      wert: `${test.szenario} Erwartet: ${list(test.kriterien)}. Höchstens ${test.maxZuege} Züge.`,
    })),
  });
  return sections;
}
