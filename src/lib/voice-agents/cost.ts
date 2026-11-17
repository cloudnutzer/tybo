/**
 * Geschätzte Kosten je Gesprächsminute für die Freigabe eines Entwurfs
 * (Issue #493). Das Issue verweist auf „Plan Abschnitt 7“; der liegt nicht im
 * Repo. Ersatzgrundlage ist DEFAULT_PRICE_BASIS mit Tarif, Annahmen, Preisstand
 * und Primärquellen (Nachtrag in Entscheidung 0026). Wer andere Preise hat,
 * legt config/voice-agent-preise.json im selben Format an (Vorlage
 * config/voice-agent-preise.example.json); sie geht der eingebauten vor.
 *
 * Rechnung: Minute beim Anbieter (Preis der Zusatzminute), plus beim Gehirn
 * „anbieter“ die Token des Modells nach den Annahmen. Beim Gehirn „bruecke“
 * rechnet tybos eigener Motor ab (Abo oder API); dann nennt die Zeile nur den
 * Anteil des Anbieters und ausdrücklich keine Obergrenze je Gespräch. Gebühren
 * eines Telefonanbieters (SIP-Trunk, Twilio) sind nie enthalten und werden
 * genannt, wenn das Rezept Telefon hat.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Recipe } from "./recipe";

export const PRICE_FILE = "voice-agent-preise.json";

const amount = z.number().nonnegative();
const url = z.string().url();
const priceSchema = z
  .object({
    stand: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    tarif: z.string().min(1).max(300),
    waehrung: z.string().regex(/^[A-Z]{3}$/),
    anbieter: z.object({ jeMinute: amount, quelle: url }).strict(),
    gehirn: z.object({ quelle: url, jeMillionToken: z.record(z.object({ eingabe: amount, ausgabe: amount }).strict()) }).strict(),
    annahmen: z
      .object({
        zuegeJeMinute: z.number().positive().max(60),
        eingabeTokenJeZug: z.number().int().positive(),
        ausgabeTokenJeZug: z.number().int().positive(),
        herkunft: z.string().min(1).max(300),
      })
      .strict(),
    telefon: z.object({ jeMinute: amount.nullable(), quelle: url, hinweis: z.string().min(1).max(300) }).strict(),
    /**
     * Umrechnung in Credits des Anbieters (Issue #514): Credits je Einheit der
     * Währung zum Satz eines Plans. Die eingebaute Grundlage hat sie; fehlt der
     * Eintrag in einer eigenen Preisdatei, zeigt die Schätzung keine Credits.
     */
    credits: z.object({ jeEinheit: z.number().positive(), tarif: z.string().min(1).max(300), quelle: url }).strict().optional(),
  })
  .strict();

export type PriceBasis = z.infer<typeof priceSchema>;

/**
 * Preisstand 7.11.2026, abgerufen von den Primärquellen:
 * - https://elevenlabs.io/pricing/agents: „Additional call minutes cost $0.08 per
 *   minute“ in jedem Plan; Telefonie berechnet ElevenLabs nicht zusätzlich, ein
 *   eigener SIP-Trunk oder Twilio rechnet selbst ab; LLM-Kosten kommen dazu.
 * - https://elevenlabs.io/scale-tier#llm-prices: Preise je Million Token der
 *   Modelle beim Anbieter (USD, Eingabe/Ausgabe).
 * Die Annahmen je Zug stammen aus tybos eigener Messung der Brücke
 * (rund 6.300 bis 7.100 Token Kontext je Zug), ohne Prompt-Cache gerechnet.
 *
 * Credits (abgerufen am 9.11.2026):
 * - https://elevenlabs.io/pricing: Creator „121k credits per month“ für
 *   „$22 per month“, also 121.000 / 22 = 5.500 Credits je USD.
 * - https://elevenlabs.io/docs/overview/administration/pay-as-you-go: „Each
 *   plan has its own credit-to-dollar rate“; ein Guthaben in Dollar wird zum
 *   Satz des aktuellen Plans in Credits umgerechnet.
 * - https://elevenlabs.io/pricing/agents: Gesprächsminuten zählen gegen das
 *   Minutenkontingent, nicht gegen den Credit-Pool; die Gebühren des Modells
 *   zieht der Anbieter von den Credits ab. Die Credits der Schätzung sind
 *   deshalb der Gegenwert des Dollarbetrags zum Satz des Creator-Plans.
 */
export const DEFAULT_CREDITS = {
  jeEinheit: 121_000 / 22,
  tarif: "Gegenwert zum Satz des Creator-Plans (monatlich 121.000 Credits für 22 USD, also 5.500 Credits je USD; Stand 2026-11-09); andere Pläne rechnen anders um",
  quelle: "https://elevenlabs.io/pricing",
} as const;

export const DEFAULT_PRICE_BASIS: PriceBasis = {
  stand: "2026-11-07",
  tarif: "ElevenLabs Agents, jede Minute zum Preis der Zusatzminute (im Plan enthaltene Minuten nicht abgezogen)",
  waehrung: "USD",
  anbieter: { jeMinute: 0.08, quelle: "https://elevenlabs.io/pricing/agents" },
  gehirn: {
    quelle: "https://elevenlabs.io/scale-tier#llm-prices",
    jeMillionToken: {
      "claude-sonnet-5-5": { eingabe: 2.2, ausgabe: 11 },
      "claude-sonnet-5": { eingabe: 2.2, ausgabe: 11 },
      "claude-haiku-5-5": { eingabe: 0.11, ausgabe: 0.55 },
      "gemini-3.8-flash": { eingabe: 0.83, ausgabe: 4.13 },
      "gemini-2.5-flash": { eingabe: 0.3, ausgabe: 2.5 },
      "gemini-2.0-flash": { eingabe: 0.1, ausgabe: 0.4 },
    },
  },
  annahmen: {
    zuegeJeMinute: 3,
    eingabeTokenJeZug: 6_700,
    ausgabeTokenJeZug: 150,
    herkunft: "tybos eigene Messung der Brücke, ohne Prompt-Cache",
  },
  telefon: {
    jeMinute: null,
    quelle: "https://elevenlabs.io/pricing/agents",
    hinweis: "ElevenLabs berechnet Telefonie nicht zusätzlich, der Anbieter der Nummer rechnet selbst ab",
  },
  credits: { ...DEFAULT_CREDITS },
};

export type PriceLoad = { status: "ok"; basis: PriceBasis; eigene: boolean } | { status: "ungueltig" };

/** Eigene Preisdatei, sonst die eingebaute Grundlage. Eine ungültige eigene Datei ersetzt nichts. */
export async function loadPriceBasis(configDir: string): Promise<PriceLoad> {
  let content: string;
  try {
    content = await readFile(join(configDir, PRICE_FILE), "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return { status: "ok", basis: DEFAULT_PRICE_BASIS, eigene: false };
    return { status: "ungueltig" };
  }
  try {
    const parsed = priceSchema.safeParse(JSON.parse(content));
    return parsed.success ? { status: "ok", basis: parsed.data, eigene: true } : { status: "ungueltig" };
  } catch {
    return { status: "ungueltig" };
  }
}

const money = (value: number, currency: string) => `${value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 3 })} ${currency}`;
const count = (value: number) => value.toLocaleString("de-DE");

/** Kosten des Modells je Minute nach den Annahmen; null ohne Preis */
export function brainPerMinute(basis: PriceBasis, modell: string): number | null {
  const price = basis.gehirn.jeMillionToken[modell];
  if (!price) return null;
  const a = basis.annahmen;
  return (a.zuegeJeMinute * (a.eingabeTokenJeZug * price.eingabe + a.ausgabeTokenJeZug * price.ausgabe)) / 1_000_000;
}

/** Eine Zeile für die Freigabe, mit Annahmen, Preisstand und Quellen */
export function costLine(recipe: Pick<Recipe, "gehirn" | "zugang">, load: PriceLoad): string {
  if (load.status === "ungueltig") return `Kosten je Minute: unbekannt, config/${PRICE_FILE} ist ungültig (Vorlage config/voice-agent-preise.example.json)`;
  const { basis } = load;
  const cur = basis.waehrung;
  const provider = basis.anbieter.jeMinute;
  const a = basis.annahmen;
  const sources = [basis.anbieter.quelle, ...(recipe.gehirn.art === "anbieter" ? [basis.gehirn.quelle] : [])];
  const basisNote = `Tarif: ${basis.tarif}; Preisstand ${basis.stand}${load.eigene ? ` aus config/${PRICE_FILE}` : ""}; Quellen ${[...new Set(sources)].join(", ")}`;
  const phone = recipe.zugang.telefon ? (basis.telefon.jeMinute === null ? null : basis.telefon.jeMinute) : 0;
  const phoneNote = recipe.zugang.telefon && phone === null ? `; ohne Gebühren des Telefonanbieters (${basis.telefon.hinweis})` : "";
  if (recipe.gehirn.art === "bruecke") {
    return (
      `Kosten je Minute: Anbieter etwa ${money(provider + (phone ?? 0), cur)}, ohne das Gehirn: Es läuft über die Brücke und rechnet über tybos eigenen Motor ab (Abo oder API). ` +
      `Eine Obergrenze je Gespräch nennt tybo deshalb nicht (${basisNote}${phoneNote})`
    );
  }
  const brain = brainPerMinute(basis, recipe.gehirn.modell);
  if (brain === null) return `Kosten je Minute: unbekannt, für das Modell ${recipe.gehirn.modell} steht kein Preis in der Preisgrundlage (${basisNote})`;
  const total = provider + brain + (phone ?? 0);
  const max = total * recipe.zugang.maxMinuten;
  const parts = [`Anbieter ${money(provider, cur)}`, `Gehirn ${recipe.gehirn.modell} ${money(brain, cur)}`, ...(phone ? [`Telefon ${money(phone, cur)}`] : [])];
  return [
    `Kosten je Minute: etwa ${money(total, cur)} (${parts.join(", ")}), ein Gespräch von höchstens ${recipe.zugang.maxMinuten} Minuten bis ${money(max, cur)}${phoneNote ? " ohne Telefonanbieter" : ""}.`,
    `Annahmen: ${a.zuegeJeMinute} Züge je Minute mit je ${count(a.eingabeTokenJeZug)} Eingabe- und ${count(a.ausgabeTokenJeZug)} Ausgabe-Token (${a.herkunft}); ${basisNote}${phoneNote}`,
  ].join(" ");
}

/** Schätzung als Zahlen für den Wizard (Issue #514); dieselbe Grundlage wie costLine */
export interface CostEstimate {
  status: "ok" | "unbekannt";
  waehrung: string | null;
  /** Je Gesprächsminute; null ohne Preis (unbekanntes Modell, ungültige Preisdatei) */
  jeMinute: number | null;
  /** Ein Gespräch von maxMinuten; null ohne maxMinuten, ohne Preis oder beim Gehirn bruecke */
  jeGespraech: number | null;
  /** In Credits des Anbieters; null ohne Umrechnung in der Preisdatei */
  credits: { jeMinute: number | null; jeGespraech: number | null; tarif: string } | null;
  /** Was fehlt oder nicht enthalten ist, in Klartext */
  hinweise: string[];
  stand: string | null;
  quellen: string[];
}

export const COST_TEXT = {
  invalid: `config/${PRICE_FILE} ist ungültig (Vorlage config/voice-agent-preise.example.json), keine Schätzung`,
  unknownModel: (modell: string) => `Für das Modell ${modell} steht kein Preis in der Preisgrundlage`,
  bridge: "Gehirn über die Brücke: Es rechnet über tybos eigenen Motor ab (Abo oder API) und ist nicht enthalten; eine Obergrenze je Gespräch nennt tybo deshalb nicht",
  noMinutes: "Ohne maxMinuten keine Schätzung je Gespräch",
  phone: (hinweis: string) => `Ohne Gebühren des Telefonanbieters (${hinweis})`,
  noCredits: `Keine Credits: config/${PRICE_FILE} nennt keine Umrechnung (credits.jeEinheit, Credits je Einheit der Währung)`,
  included: "Im Plan enthaltene Minuten sind nicht abgezogen",
} as const;

const round = (value: number) => Math.round(value * 10_000) / 10_000;

export function estimateCost(input: { gehirn: { art: "anbieter" | "bruecke"; modell: string }; maxMinuten?: number; telefon: boolean }, load: PriceLoad): CostEstimate {
  if (load.status === "ungueltig") return { status: "unbekannt", waehrung: null, jeMinute: null, jeGespraech: null, credits: null, hinweise: [COST_TEXT.invalid], stand: null, quellen: [] };
  const { basis } = load;
  const hinweise: string[] = [COST_TEXT.included];
  const phone = input.telefon ? basis.telefon.jeMinute : 0;
  if (input.telefon && phone === null) hinweise.push(COST_TEXT.phone(basis.telefon.hinweis));
  const quellen = [basis.anbieter.quelle];
  let perMinute: number | null;
  if (input.gehirn.art === "bruecke") {
    perMinute = basis.anbieter.jeMinute + (phone ?? 0);
    hinweise.push(COST_TEXT.bridge);
  } else {
    quellen.push(basis.gehirn.quelle);
    const brain = brainPerMinute(basis, input.gehirn.modell);
    if (brain === null) hinweise.push(COST_TEXT.unknownModel(input.gehirn.modell));
    perMinute = brain === null ? null : basis.anbieter.jeMinute + brain + (phone ?? 0);
  }
  if (input.maxMinuten === undefined) hinweise.push(COST_TEXT.noMinutes);
  const perCall = perMinute !== null && input.gehirn.art === "anbieter" && input.maxMinuten !== undefined ? perMinute * input.maxMinuten : null;
  let credits: CostEstimate["credits"] = null;
  if (basis.credits) {
    const c = basis.credits;
    credits = { jeMinute: perMinute === null ? null : Math.ceil(perMinute * c.jeEinheit), jeGespraech: perCall === null ? null : Math.ceil(perCall * c.jeEinheit), tarif: c.tarif };
    quellen.push(c.quelle);
  } else hinweise.push(COST_TEXT.noCredits);
  return {
    status: perMinute === null ? "unbekannt" : "ok",
    waehrung: basis.waehrung,
    jeMinute: perMinute === null ? null : round(perMinute),
    jeGespraech: perCall === null ? null : round(perCall),
    credits,
    hinweise,
    stand: basis.stand,
    quellen: [...new Set(quellen)],
  };
}
