/**
 * Rezept eines Sprachagenten (Entscheidung 0026): die Datei
 * config/voice-agents/<kennung>.json beschreibt den Agenten vollständig.
 * Dieses Modul prüft ohne Sprachmodell und spricht mit keinem Anbieter.
 *
 * Zwei Stufen: das Schema (Form, Pflichtfelder, Zahlenbereiche; unbekannte
 * Felder sind Fehler, damit ein Tippfehler keine Leitplanke aushebelt) und
 * die Leitplanken (Beziehungen zwischen Feldern). Beide laufen immer, die
 * Fehlerliste ist also auf einmal vollständig.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../atomic-file";
import { getSettings } from "../settings";
import { ELEVENLABS_MODELS } from "../speech/ids";
import { VOICE_PATTERN } from "../speech/types";
import {
  assertFileOrMissing,
  ensureRealDirs,
  isValidKennung,
  KENNUNG_MAX,
  readRegularFile,
  realDirsExist,
  recipeHash,
  recipePath,
  recipesDir,
  VoiceAgentError,
  type VoiceAgentPaths,
} from "./base";
import { discardVersion, recordVersion, withAgentLock } from "./state";

export { recipeHash } from "./base";

export const RECIPE_SCHEMA_VERSION = 1;
export const TEMPLATE_IDS = ["anrufannahme", "jarvis", "experte"] as const;
export const VOICE_TOOLS = ["rueckruf_notieren", "freie_termine", "notiz", "wissen_suchen", "wissensluecke_melden", "pin_pruefen"] as const;
export const MEMORY_LEVELS = ["keins", "thema", "voll"] as const;
export const MAX_MINUTES_PER_CALL = 120;
export const MAX_MINUTES_PER_MONTH = 100_000;
export const MAX_CALLS_PER_NUMBER_DAY = 1_000;
export const MAX_TURNS_PER_TEST = 50;
export const MIN_TESTS = 2;
export const TEMPO_MIN = 0.7;
export const TEMPO_MAX = 1.2;

const text = (max: number) => z.string().trim().min(1, "darf nicht leer sein").max(max, `höchstens ${max} Zeichen`);
const wholeNumber = (min: number, max: number) =>
  z.number().int("muss eine ganze Zahl sein").min(min, `mindestens ${min}`).max(max, `höchstens ${max}`);
const providerModel = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/, "ungültiger Modellname");

const testSchema = z
  .object({
    name: text(100),
    szenario: text(2000),
    kriterien: z.array(text(500)).min(1, "mindestens ein Kriterium"),
    maxZuege: wholeNumber(1, MAX_TURNS_PER_TEST),
  })
  .strict();

const recipeSchema = z
  .object({
    schema: z.literal(RECIPE_SCHEMA_VERSION),
    kennung: z.string(),
    name: text(100),
    vorlage: z.enum(TEMPLATE_IDS),
    zweck: text(1000),
    persona: z
      .object({
        rolle: text(2000),
        anrede: z.enum(["du", "sie"]),
        sprachen: z.array(z.string().regex(/^[a-z]{2}$/, "Sprachkürzel aus zwei Kleinbuchstaben")).min(1, "mindestens eine Sprache"),
        ersterSatz: text(500),
        kiHinweis: text(500).optional(),
        regeln: z.array(text(500)).default([]),
      })
      .strict(),
    stimme: z
      .object({
        art: z.enum(["bibliothek", "design", "eigene"]),
        // Fehlt sie bei „bibliothek“, gilt die Standardstimme (resolveVoice)
        voiceId: z.string().regex(VOICE_PATTERN, "ungültige Stimmen-Kennung").optional(),
        modell: providerModel.default(ELEVENLABS_MODELS[0]),
        tempo: z.number().min(TEMPO_MIN, `mindestens ${TEMPO_MIN}`).max(TEMPO_MAX, `höchstens ${TEMPO_MAX}`).default(1),
      })
      .strict(),
    gehirn: z
      .object({
        art: z.enum(["anbieter", "bruecke"]),
        modell: providerModel,
        denkauftrag: z.boolean().default(false),
      })
      .strict(),
    gedaechtnis: z.enum(MEMORY_LEVELS),
    wissen: z.object({ datei: z.string() }).strict().optional(),
    werkzeuge: z
      .array(
        z
          .object({
            name: z.enum(VOICE_TOOLS),
            freigabe: z.enum(["ohne", "nachher"]).optional(),
          })
          .strict(),
      )
      .default([]),
    zugang: z
      .object({
        web: z.object({ link: z.boolean() }).strict().optional(),
        telefon: z
          .object({
            nummer: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "ungültige Kennung der Nummer"),
            anrufer: z.enum(["alle", "freigegeben"]),
            pin: z.boolean(),
          })
          .strict()
          .optional(),
        maxMinuten: wholeNumber(1, MAX_MINUTES_PER_CALL),
        budget: z
          .object({
            minutenMonat: wholeNumber(1, MAX_MINUTES_PER_MONTH),
            // 0 passt zu reinem Web-Zugang; mit Telefon prüft die Leitplanke
            anrufeJeNummerTag: wholeNumber(0, MAX_CALLS_PER_NUMBER_DAY),
          })
          .strict(),
      })
      .strict(),
    nachlauf: z
      .object({
        zusammenfassung: z.boolean(),
        faden: z.boolean(),
        kalendervorschlag: z.boolean(),
        anruferMerken: z.boolean(),
        training: z.boolean(),
        ziel: z.string().regex(/^(direktchat|topic:[1-9][0-9]*)$/, "direktchat oder topic:<nummer>"),
      })
      .strict(),
    training: z
      .object({
        rollen: z.array(text(200)).min(1, "mindestens eine Rolle"),
        einwaende: z.array(text(500)).min(1, "mindestens ein Einwand"),
        kriterien: z.array(text(500)).length(3, "genau drei Kriterien"),
        selbsteinschaetzung: z.boolean(),
        abschlussfrage: text(500),
      })
      .strict()
      .optional(),
    tests: z.array(testSchema).min(MIN_TESTS, `mindestens ${MIN_TESTS} Tests`),
  })
  .strict();

export type Recipe = z.infer<typeof recipeSchema>;
export type RecipeTest = z.infer<typeof testSchema>;
export type RecipeTemplateId = (typeof TEMPLATE_IDS)[number];

export type ParseResult = { ok: true; recipe: Recipe } | { ok: false; fehler: string[] };

function label(path: readonly (string | number)[]): string {
  return path.reduce<string>((out, part) => (typeof part === "number" ? `${out}[${part}]` : out ? `${out}.${part}` : part), "");
}

function describeIssue(issue: z.ZodIssue): string[] {
  const where = label(issue.path);
  switch (issue.code) {
    case "invalid_type":
      return [issue.received === "undefined" ? `${where}: Pflichtfeld fehlt` : `${where}: erwartet ${issue.expected}, gefunden ${issue.received}`];
    case "unrecognized_keys":
      // gaeste bekommt von der Leitplanke einen eigenen Satz
      return issue.keys.filter((key) => key !== "gaeste").map((key) => `${where ? `${where}.` : ""}${key}: unbekanntes Feld`);
    case "invalid_enum_value":
      return [`${where}: erlaubt sind ${issue.options.join(", ")}`];
    case "invalid_literal":
      return [`${where}: muss ${JSON.stringify(issue.expected)} sein`];
    default:
      return [`${where}: ${issue.message}`];
  }
}

function findKey(value: unknown, key: string, path: (string | number)[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => findKey(item, key, [...path, index]));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, item]) => (name === key ? [label([...path, name])] : findKey(item, key, [...path, name])));
}

function filled(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function duplicates(values: unknown[]): string[] {
  const seen = new Set<unknown>();
  const twice = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) twice.add(String(value));
    seen.add(value);
  }
  return [...twice];
}

/**
 * Beziehungen zwischen Feldern. Läuft auf den Rohdaten, auch wenn das Schema
 * schon Fehler fand, und nimmt deshalb nichts über die Form an.
 */
function guardrails(raw: any): string[] {
  const fehler: string[] = [];
  const phone = raw.zugang?.telefon;
  const memory = raw.gedaechtnis;
  const isExpert = raw.vorlage === "experte";

  if (!isValidKennung(raw.kennung)) {
    fehler.push(`kennung: nur Kleinbuchstaben, Ziffern und einzelne Bindestriche, höchstens ${KENNUNG_MAX} Zeichen, nicht „entwuerfe“`);
  }
  for (const path of findKey(raw, "gaeste")) {
    fehler.push(`${path}: Gäste gibt es nicht, der Web-Zugang liegt immer hinter dem Login`);
  }
  if (memory === "voll" && phone && phone.pin !== true) {
    fehler.push("gedaechtnis: voll am Telefon verlangt zugang.telefon.pin: true");
  }
  // Fremde: wer jeden anrufen lässt, und die Anrufannahme, die dafür da ist
  if (phone?.anrufer === "alle" || raw.vorlage === "anrufannahme") {
    const why = phone?.anrufer === "alle" ? "zugang.telefon.anrufer: alle" : "vorlage: anrufannahme";
    if (!filled(raw.persona?.kiHinweis)) fehler.push(`persona.kiHinweis: Pflicht bei ${why}`);
    if (memory !== "keins") fehler.push(`gedaechtnis: ${why} verlangt keins`);
  }
  if (phone && raw.zugang?.budget?.anrufeJeNummerTag === 0) {
    fehler.push("zugang.budget.anrufeJeNummerTag: mit Telefonzugang mindestens 1");
  }
  const art = raw.stimme?.art;
  if ((art === "design" || art === "eigene") && !raw.stimme?.voiceId) {
    fehler.push(`stimme.voiceId: Pflicht bei stimme.art: ${art}, die Standardstimme gilt nur für bibliothek`);
  }

  if (memory === "thema" && !filled(raw.wissen?.datei)) fehler.push("wissen.datei: Pflicht bei gedaechtnis: thema");
  if (memory !== "thema" && raw.wissen !== undefined) fehler.push("wissen: nur bei gedaechtnis: thema");
  if (filled(raw.wissen?.datei) && isValidKennung(raw.kennung)) {
    const name = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/;
    const prefix = `data/voice-agents/${raw.kennung}/`;
    if (!raw.wissen.datei.startsWith(prefix) || !name.test(raw.wissen.datei.slice(prefix.length))) {
      fehler.push(`wissen.datei: muss direkt unter ${prefix} liegen und auf .md enden`);
    }
  }

  if (isExpert && raw.training === undefined) fehler.push("training: Pflicht bei vorlage: experte");
  if (!isExpert && raw.training !== undefined) fehler.push("training: nur bei vorlage: experte");
  if (isExpert && memory === "voll") fehler.push("gedaechtnis: vorlage: experte erlaubt thema oder keins");
  if (raw.nachlauf?.training === true && raw.training === undefined) fehler.push("nachlauf.training: verlangt den Abschnitt training");

  const names = (list: unknown, get: (item: any) => unknown) => (Array.isArray(list) ? list.map(get) : []);
  // Verglichen wird, was das Schema zurückgibt: „Test“ und „ Test “ sind danach
  // derselbe Name, und die Datei ließe sich nicht wieder laden. Was es ablehnt,
  // meldet es selbst.
  const testNames = names(raw.tests, (t) => testSchema.shape.name.safeParse(t?.name)).flatMap((name: any) => (name.success ? [name.data] : []));
  for (const name of duplicates(testNames)) fehler.push(`tests: Name doppelt: ${name}`);
  for (const name of duplicates(names(raw.werkzeuge, (w) => w?.name))) fehler.push(`werkzeuge: doppelt: ${name}`);
  for (const code of duplicates(names(raw.persona?.sprachen, (s) => s))) fehler.push(`persona.sprachen: doppelt: ${code}`);
  return fehler;
}

/** Prüft ein Rezept (Objekt oder JSON-Text) und liefert es mit Standardwerten oder alle Fehler in Klartext. */
export function parseRecipe(input: unknown): ParseResult {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      return { ok: false, fehler: [`Kein gültiges JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, fehler: ["Ein Rezept ist ein JSON-Objekt."] };

  const result = recipeSchema.safeParse(raw);
  const fehler = [...(result.success ? [] : result.error.issues.flatMap(describeIssue)), ...guardrails(raw)];
  if (!result.success || fehler.length > 0) return { ok: false, fehler };
  return { ok: true, recipe: result.data };
}

/** Woher die Standardstimme kommt, wenn ein Rezept keine nennt */
export interface VoiceSources {
  /** Einstellung speech.call.elevenlabsVoice */
  setting?: string;
  /** ELEVENLABS_VOICE_ID aus der .env */
  env?: string;
}

export function defaultVoiceSources(): VoiceSources {
  return { setting: getSettings().speech?.call?.elevenlabsVoice, env: process.env.ELEVENLABS_VOICE_ID };
}

export type VoiceResolution = { voiceId: string; quelle: "rezept" | "einstellung" | "umgebung" } | { fehler: string };

/**
 * Vorrang: Rezept, dann Einstellung, dann .env. Ohne alle drei gibt es einen
 * Fehler und keinen stillen Rückfall auf eine fremde Stimme. saveRecipe
 * schreibt das Ergebnis ins Rezept: Es bleibt die einzige Quelle, und eine
 * spätere Änderung der Einstellung verstellt keinen bestehenden Agenten.
 */
export function resolveVoice(recipe: Pick<Recipe, "stimme">, sources: VoiceSources): VoiceResolution {
  if (recipe.stimme.voiceId) return { voiceId: recipe.stimme.voiceId, quelle: "rezept" };
  for (const [value, quelle] of [[sources.setting, "einstellung"], [sources.env, "umgebung"]] as const) {
    if (value && VOICE_PATTERN.test(value)) return { voiceId: value, quelle };
  }
  return { fehler: "stimme.voiceId: keine Stimme festgelegt. Im Rezept setzen, in den Einstellungen unter Sprache wählen oder ELEVENLABS_VOICE_ID in der .env eintragen." };
}

/** null: Es gibt die Datei nicht. */
async function readRecipeFile(path: string, kennung: string): Promise<ParseResult | null> {
  try {
    const content = await readRegularFile(path);
    if (content === null) return null;
    const parsed = parseRecipe(content);
    if (parsed.ok && parsed.recipe.kennung !== kennung) {
      return { ok: false, fehler: [`kennung: „${parsed.recipe.kennung}“ passt nicht zum Dateinamen „${kennung}.json“`] };
    }
    return parsed;
  } catch (error) {
    return { ok: false, fehler: [`Nicht lesbar: ${errorText(error)}`] };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface LoadedRecipes {
  recipes: Recipe[];
  /** Dateien, die die Prüfung nicht bestehen; sie gelten nicht als Agenten */
  fehler: { datei: string; fehler: string[] }[];
}

/** Alle Rezepte aus dem Ordner, nach Kennung sortiert. Eine kaputte Datei versteckt die anderen nicht. */
export async function loadRecipes(paths: VoiceAgentPaths = {}): Promise<LoadedRecipes> {
  const dir = recipesDir(paths);
  if (!(await realDirsExist([dir]))) return { recipes: [], fehler: [] };
  const files = await readdir(dir);
  const out: LoadedRecipes = { recipes: [], fehler: [] };
  for (const datei of files.filter((name) => name.endsWith(".json")).sort()) {
    const kennung = datei.slice(0, -".json".length);
    if (!isValidKennung(kennung)) {
      out.fehler.push({ datei, fehler: ["Der Dateiname ist keine gültige Kennung."] });
      continue;
    }
    const parsed = await readRecipeFile(join(dir, datei), kennung);
    if (parsed === null) continue;
    if (parsed.ok) out.recipes.push(parsed.recipe);
    else out.fehler.push({ datei, fehler: parsed.fehler });
  }
  return out;
}

/** Ein Rezept nach Kennung; null, wenn es die Datei nicht gibt. Eine beschädigte Datei ist ein Fehler. */
export async function loadRecipe(kennung: string, paths: VoiceAgentPaths = {}): Promise<Recipe | null> {
  const path = recipePath(kennung, paths);
  if (!(await realDirsExist([recipesDir(paths)]))) return null;
  const parsed = await readRecipeFile(path, kennung);
  if (parsed === null) return null;
  if (!parsed.ok) throw new VoiceAgentError(`Rezept ${kennung}: ${parsed.fehler.join("; ")}`, parsed.fehler);
  return parsed.recipe;
}

export interface SavedRecipe {
  recipe: Recipe;
  hash: string;
  /** Nummer der Version, die jetzt gilt */
  version: number;
  /** false: Inhalt unverändert, keine neue Version */
  neueVersion: boolean;
}

/** Was guard vom aktiven Rezept sieht: das Rezept, null ohne Datei, broken bei einer unlesbaren Datei */
export interface ActiveRecipe {
  recipe: Recipe | null;
  broken: boolean;
}

/** Ein guard lehnt mit Klartext und Grund (für das Log, ohne Inhalte) ab */
export class SaveRefused extends VoiceAgentError {
  constructor(message: string, readonly grund: string) {
    super(message);
    this.name = "SaveRefused";
  }
}

export interface SaveOptions extends VoiceAgentPaths {
  /** Standard: Einstellung und .env (defaultVoiceSources) */
  voices?: VoiceSources;
  /**
   * Vorbedingung unter der Sperre der Kennung (Issue #493): sieht das aktive
   * Rezept, bevor etwas geschrieben wird. Liefert sie eine Ablehnung, wirft
   * saveRecipe SaveRefused und ändert nichts. Prüfung und Speichern sind so ein
   * Schritt. Der guard darf die Sperre der Kennung nicht selbst nehmen.
   */
  guard?: (active: ActiveRecipe) => Promise<{ text: string; grund: string } | null> | { text: string; grund: string } | null;
}

/**
 * Prüft, übernimmt die Standardstimme und speichert unter der Sperre der
 * Kennung, damit aktives Rezept und letzte Version zusammenpassen, auch wenn
 * mehrere Aufrufe zugleich laufen. Eine neue Version entsteht, wenn sich der
 * Inhalt gegenüber der letzten Version geändert hat. Verglichen wird mit der
 * letzten Rezeptversion, nicht mit dem letzten Abgleich beim Anbieter (der
 * steht in state.json).
 *
 * Die Version kommt zuerst, das Rezept danach (Entscheidung 0026): Scheitert
 * die Version, etwa an einer beschädigten letzten Version, bleibt das aktive
 * Rezept unberührt. Scheitert das Rezept, wird die neue Version zurückgenommen.
 */
export async function saveRecipe(input: unknown, options: SaveOptions = {}): Promise<SavedRecipe> {
  const parsed = parseRecipe(input);
  if (!parsed.ok) throw new VoiceAgentError(`Rezept ungültig: ${parsed.fehler.join("; ")}`, parsed.fehler);
  const voice = resolveVoice(parsed.recipe, options.voices ?? defaultVoiceSources());
  if ("fehler" in voice) throw new VoiceAgentError(voice.fehler);
  const recipe: Recipe = { ...parsed.recipe, stimme: { ...parsed.recipe.stimme, voiceId: voice.voiceId } };
  const { kennung } = recipe;
  const path = recipePath(kennung, options);
  const kept = `Rezept ${kennung} nicht gespeichert, das aktive Rezept bleibt unverändert`;

  return withAgentLock(kennung, options, async () => {
    if (options.guard) {
      const current = await readRecipeFile(path, kennung);
      const refusal = await options.guard(current === null ? { recipe: null, broken: false } : current.ok ? { recipe: current.recipe, broken: false } : { recipe: null, broken: true });
      if (refusal) throw new SaveRefused(refusal.text, refusal.grund);
    }
    let saved: Awaited<ReturnType<typeof recordVersion>>;
    try {
      await ensureRealDirs([recipesDir(options)]);
      await assertFileOrMissing(path);
      saved = await recordVersion(kennung, recipe, options);
    } catch (error) {
      throw new VoiceAgentError(`${kept}: ${errorText(error)}`);
    }
    try {
      await atomicWriteFile(path, JSON.stringify(recipe, null, 2) + "\n");
    } catch (error) {
      if (!saved.neu) throw new VoiceAgentError(`${kept}: ${errorText(error)}`);
      try {
        await discardVersion(kennung, saved.version, options);
      } catch (undo) {
        throw new VoiceAgentError(`Rezept ${kennung} nicht gespeichert: ${errorText(error)}. Version ${saved.version} ließ sich nicht zurücknehmen (${errorText(undo)}) und ist neuer als das aktive Rezept; erneutes Speichern gleicht das aus.`);
      }
      throw new VoiceAgentError(`${kept}: ${errorText(error)}`);
    }
    return { recipe, hash: recipeHash(recipe), version: saved.version, neueVersion: saved.neu };
  });
}
