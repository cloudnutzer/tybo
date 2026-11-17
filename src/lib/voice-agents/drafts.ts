/**
 * Entwürfe für Sprachagenten (Issue #493, Entscheidung 0026):
 * /sprachagent neu <beschreibung> und /sprachagent aendern <kennung> <wunsch>.
 *
 * Ablage unter data/voice-agents/entwuerfe/:
 * - .arbeit/<entwurf>/: Arbeitsordner des Jobs. Claude startet dort mit
 *   --restricted (jobs/runner.ts) und kann nur dort schreiben. tybo legt
 *   Kopien von Beispielrezepten, Typen und beim Ändern des aktiven Rezepts
 *   hinein; der Job schreibt rezept.json, stimme.txt und beim Experten
 *   wissen.md.
 * - .steuerung/<entwurf>/: Steuerdaten (entwurf.json, Sperre, Ausgangsrezept
 *   beim Ändern). Außerhalb des Arbeitsordners, wie aktive Rezepte, Versionen,
 *   Wissensdateien, Freischaltungen und Rückfragen.
 * - <kennung>/: der geprüfte Entwurf (rezept.json, wissen.md, stimme.txt) und
 *   entwurf-id. Je Kennung ist höchstens ein Entwurf offen; ein beendeter
 *   (fertig, verworfen, abgebrochen) gibt den Ordner frei.
 *
 * Ablauf:
 * 1. Ein Hintergrund-Job mit festem Auftrag (brief.ts) schreibt den Entwurf
 *    in seinen Arbeitsordner. Nie --full-access; Recherche über WebSearch und
 *    WebFetch, keine Befehle.
 * 2. tybo verfolgt den Job über seinen Status. Nach dem Ende prüft tybo:
 *    parseRecipe, Kennung, Wissensdatei (Länge, Stand, Quellen; Pflicht beim
 *    neuen Experten) und Stimmbeschreibung. Bei Fehlern genau ein
 *    Nachbesserungslauf, danach Abbruch mit Meldung. Stopp, Zeitlimit,
 *    Absturz und Abbruch des Jobs beenden den Entwurf ohne Nachbesserung.
 *    Bestanden: Ablage unter <kennung>/, Stimme eingefroren.
 * 3. Mit Stimmbeschreibung und passenden Stimmen beim Anbieter zuerst die
 *    Stimmwahl, dann die Freigabe mit Kurzfassung. Beide sind Rückfragen der
 *    Art "sprachagent", der Schritt steht in Choice.action.
 * 4. „Anlegen“: Erreichbarkeit beim Anbieter prüfen, saveRecipe mit
 *    Vorbedingung unter der Sperre der Kennung, deploy, syncTests, runTests,
 *    testResult. Erst bestandene Tests schalten frei (unlock.ts); nur ein
 *    vollständiger Lauf mit durchgefallenen Tests bietet „Trotzdem
 *    freischalten“. Vollständig heißt: genau die angeforderten Test-IDs, jede
 *    einmal, keine fremde. Fehler, Abbruch, Zeitüberschreitung und Neustart
 *    schalten nie frei und bieten „Erneut versuchen“. Ohne Sprachschicht hält
 *    eine Änderung vor dem Speichern an. Bei „Erneut versuchen“ prüft deploy
 *    auch bei gleichem Rezept-Hash den Stand beim Anbieter (standPruefen).
 *    Beide Freischaltungen (bestanden und „Trotzdem freischalten“) vergleichen
 *    vorher lesend den Agenten beim Anbieter mit dem Stand, den deploy vor dem
 *    Testlauf bestätigt hat (compareStand). Abweichung oder nicht prüfbarer
 *    Stand: keine Freischaltung, mit Meldung.
 *
 * Bindung: Eine Freigabe gilt genau einem eingefrorenen Entwurf (Hash des
 * Rezepts mit Stimme und Wissensdatei) und genau einer Rückfrage (choiceId).
 *
 * Erreichbarkeit: tybo ordnet keine Nummern zu und gibt den Link erst mit der
 * Freischaltung frei. Hängt an einem bestehenden Agenten beim Anbieter eine
 * Telefonnummer oder ein WhatsApp-Konto, wäre eine ungeprüfte Fassung dort
 * sofort erreichbar; dann übernimmt tybo die Änderung nicht.
 *
 * Neustart: Jeder Übergang schreibt zuerst den Zustand, dann folgt die
 * Wirkung. resume() hängt einen Job ohne eingetragene Kennung über seinen
 * Titel an (kein zweiter Job), stellt eine fehlende Rückfrage neu (die alte
 * desselben Entwurfs läuft ab) und meldet ein unterbrochenes Anlegen mit
 * „Erneut versuchen“. Die Vorbedingung erkennt die eigene, schon gespeicherte
 * Fassung.
 *
 * Ablauf: Rückfragen gelten drei Tage (frist). Danach beendet der Takt den
 * Entwurf als abgebrochen und meldet das; die Kennung ist wieder frei.
 *
 * Ins Log kommen nur Entwurf, Kennung, Schritt und Fehlerklasse, nie Inhalte.
 */
import { createHash, randomBytes } from "node:crypto";
import { readdir, rm, writeFile, link as linkFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../atomic-file";
import {
  createChoice as realCreateChoice,
  getChoice as realGetChoice,
  type Choice,
  type ChoiceConversation,
  type ChoiceHandler,
  type ChoiceOption,
  type CreateChoiceInput,
  type CreateChoiceOptions,
} from "../choices";
import { webConversationChatId } from "../channels";
import { acquireFileLock, releaseFileLock } from "../file-lock";
import type { JobOutcome, JobStatus, JobTarget } from "../jobs/store";
import type { PostWeb } from "../review-choices";
import {
  agentDataDir,
  agentsDataRoot,
  assertFileOrMissing,
  ensureRealDirs,
  isValidKennung,
  readRegularFile,
  realDirsExist,
  recipeHash,
  recipePath,
  recipesDir,
  VoiceAgentError,
  type VoiceAgentPaths,
} from "./base";
import { DRAFT_FILES, DRAFT_JOB_ALLOWED_TOOLS, DRAFT_JOB_DENIED_TOOLS, draftBrief, VOICE_DESCRIPTION_MAX } from "./brief";
import { costLine, DEFAULT_PRICE_BASIS, type PriceLoad } from "./cost";
import { KNOWLEDGE_PROMPT_LIMIT } from "./knowledge";
import { parseLayerState, type VoiceLayer } from "./layer";
import { formatTestRun, storeTestRun, toStoredRun, VOICE_AGENT_SOURCE } from "./manage";
import { effectiveTests, providerPrompt } from "./prompt";
import { defaultVoiceSources, loadRecipe, parseRecipe, resolveVoice, saveRecipe, SaveRefused, type ActiveRecipe, type Recipe, type VoiceSources } from "./recipe";
import { readState } from "./state";
import { TEMPLATES } from "./templates";
import { writeUnlock } from "./unlock";
import type { VoiceSuggestion } from "./voice-catalog";
import { applyOverlay, wizardRecipeProblems } from "./wizard";

export const DRAFT_DIR = "entwuerfe";
/** Arbeitsordner der Jobs unter entwuerfe/ */
export const DRAFT_WORK_DIR = ".arbeit";
/** Steuerdaten der Entwürfe unter entwuerfe/ */
export const DRAFT_CONTROL_DIR = ".steuerung";
/** In entwuerfe/<kennung>/: welcher Entwurf den Ordner hält */
export const DRAFT_OWNER_FILE = "entwurf-id";
export const DRAFT_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
/** Schritte der Rückfragen (Choice.action) */
export const DRAFT_STEP = { voice: "stimme", approve: "freigabe", unlock: "freischalten", retry: "fortsetzen" } as const;
export const DRAFT_KEYS = {
  create: "anlegen",
  discard: "verwerfen",
  unlock: "freischalten",
  keepLocked: "gesperrt",
  retry: "weiter",
  standardVoice: "standard",
} as const;
/** Jede Rückfrage eines Entwurfs gilt drei Tage, danach endet der Entwurf (expire) */
export const DRAFT_CHOICE_TTL_MS = 3 * 24 * 3_600_000;
export const DRAFT_POLL_MS = 15_000;
export const REQUEST_MAX = 2_000;
/** Höchstens so viele Entwürfe gleichzeitig im Job */
export const MAX_RUNNING_DRAFTS = 3;
/** So oft versucht tybo, den Job eines Entwurfs zu starten */
export const MAX_JOB_STARTS = 3;
const LOCK_WAIT_MS = 30_000;

export type DraftPhase =
  /** Wizard (Issue #514): Kennung reserviert, Felder werden noch bearbeitet, kein Job */
  | "wizard"
  /** Job läuft (erster Lauf oder Nachbesserung); ohne jobId steht der Start an */
  | "job"
  /** Stimmwahl offen */
  | "stimme"
  /** Freigabe offen */
  | "freigabe"
  /** „Anlegen“ läuft */
  | "anlegen"
  /** angelegt und freigeschaltet, oder nach durchgefallenen Tests entschieden */
  | "fertig"
  /** angelegt, Tests durchgefallen, „Trotzdem freischalten“ offen */
  | "durchgefallen"
  /** nicht oder nicht ganz angelegt, nicht freigeschaltet; „Erneut versuchen“ offen */
  | "unterbrochen"
  | "verworfen"
  | "abgebrochen";

/** Beendete Entwürfe geben die Ablage ihrer Kennung frei */
export const FINAL_PHASES: readonly DraftPhase[] = ["fertig", "verworfen", "abgebrochen"];
/** Phasen mit einer offenen Rückfrage */
const QUESTION_PHASES: readonly DraftPhase[] = ["stimme", "freigabe", "durchgefallen", "unterbrochen"];

export interface DraftRecord {
  version: 1;
  id: string;
  art: "neu" | "aendern";
  /** Beschreibung (neu) oder Wunsch (aendern) */
  anfrage: string;
  /** aendern: Ziel; neu: nach der Prüfung die vorgeschlagene Kennung */
  kennung?: string;
  conversation: ChoiceConversation;
  erstelltAm: string;
  geaendertAm: string;
  phase: DraftPhase;
  jobId?: string;
  versuch: 1 | 2;
  /** Startversuche des aktuellen Laufs */
  startVersuche?: number;
  /** Fehler der letzten Prüfung */
  fehler?: string[];
  /** aendern: Hash des Ausgangsrezepts und seiner Wissensdatei beim Start */
  basis?: { hash: string; wissenHash: string | null };
  /** Hash je geschützter Datei beim Start des Jobs (config/voice-agents, Versionen, Wissensdateien) */
  schutz: Record<string, string>;
  /** Eingefrorenes Rezept nach der Prüfung, mit Stimme */
  rezept?: Recipe;
  /** Hash von rezept; die Freigabe gilt nur dafür */
  rezeptHash?: string;
  /** Wissensdatei in der Ablage und ihr Hash (null: keine) */
  wissen?: { datei: string; hash: string; zeichen: number; quellen: number; stand: string } | null;
  /** aendern: Wissen unverändert übernommen */
  wissenUnveraendert?: boolean;
  stimme?: { beschreibung?: string; vorschlaege: VoiceSuggestion[]; gewaehlt?: { voiceId: string; name: string } };
  /** Die eine Rückfrage, die gerade für diesen Entwurf gilt */
  choiceId?: string;
  /** choiceId, sobald die Rückfrage zugestellt ist */
  zugestellt?: string;
  /** Ablauf der Rückfrage (ms seit 1970); danach beendet der Takt den Entwurf */
  frist?: number;
  /** Nach saveRecipe: übernommene Fassung */
  uebernommen?: { hash: string; version: number };
  /**
   * Fassung, deren Tests durchfielen (für „Trotzdem freischalten“), mit dem
   * getesteten Agenten und seinem Stand beim Anbieter (anbieterStand nach deploy)
   * sowie dem Hash des getesteten Wissens (null: keins; fehlt bei Entwürfen von
   * vorher, dann wird nicht freigeschaltet)
   */
  testlauf?: { hash: string; version: number; wissenHash?: string | null; runId: string; agentId?: string; stand?: Record<string, string> };
  /** Kennung des letzten Testlaufs beim Anlegen, bei jedem Ergebnis (Issue #515: Fortschritt des Wizards liest ihn aus testlauf.json) */
  testRunId?: string;
  /** Grund des Abbruchs oder der Unterbrechung, ohne Inhalte */
  grund?: string;
  /**
   * Wizard (Issue #514): Vorgaben, die tybo nach dem Job unverändert ins
   * Rezept übernimmt (applyOverlay; undefined ergänzt der Job, null entfernt),
   * Links für die Recherche und Dateien in eingaben/ des Arbeitsordners.
   * Links und Dateien sind fremde Inhalte.
   */
  vorgaben?: DraftPresets;
}

export interface DraftPresets {
  rezept: Record<string, unknown>;
  /** Thema der Recherche, vollständig und getrennt von der Beschreibung */
  thema?: string;
  links: string[];
  anhaenge: { datei: string; name: string }[];
  /**
   * Stimme aus dem Wizard (Issue #515): Mit ihr entfällt die Stimmwahl im
   * Direktchat. konto: genau diese Kennung steht im Rezept (wizardOverlay),
   * eine andere des Jobs wird abgelehnt. standard: die Standardstimme, beim
   * Bauen eingefroren wie bisher.
   */
  stimme?: { wahl: "standard" } | { wahl: "konto"; voiceId: string; name: string };
}

/** Datei für eingaben/ im Arbeitsordner des Jobs */
export interface DraftInputFile {
  datei: string;
  name: string;
  content: Uint8Array;
}

/** Ordner im Arbeitsordner mit den Dateien aus dem Wizard */
export const DRAFT_INPUT_DIR = "eingaben";

export interface DraftJobs {
  start(input: { title: string; brief: string; target: JobTarget; allowedTools: string[]; deniedTools: string[]; workDir: string }): Promise<{ ok: true; id: string } | { ok: false; error: string; duplicateOf?: string }>;
  status(id: string): Promise<JobStatus | null>;
  /** Job mit genau diesem Titel, auch ein beendeter; null ohne */
  find(title: string): Promise<string | null>;
}

type Log = (line: string) => void;

export interface DraftDeps {
  /** Projektordner: Vorlagen und Typen für den Arbeitsordner kommen von dort */
  root: string;
  paths: VoiceAgentPaths;
  jobs: DraftJobs;
  layer(): VoiceLayer | null;
  /** Stimmen des Kontos, passend zur Beschreibung; leer ohne Anbieter */
  suggestVoices?(description: string): Promise<VoiceSuggestion[]>;
  voiceSources?(): VoiceSources;
  prices?(): Promise<PriceLoad>;
  sendChoice(choice: Choice): Promise<{ sent: boolean }>;
  postWeb?: PostWeb;
  notify(conversation: ChoiceConversation, text: string): Promise<void>;
  createChoice?(input: CreateChoiceInput, options?: CreateChoiceOptions): Promise<Choice>;
  getChoice?(id: string): Promise<Choice | undefined>;
  /** Beispielrezepte, Standard config/voice-agents.example */
  examplesDir?: string;
  /** Typen des Rezepts, Standard src/lib/voice-agents/recipe.ts */
  schemaFile?: string;
  now?(): number;
  log?: Log;
  newId?(): string;
}

export type StartDraftOutcome =
  | { status: "gestartet"; id: string; jobId: string }
  | { status: "leer" }
  | { status: "zu_lang" }
  | { status: "unbekannt" }
  | { status: "kaputt"; fehler: string }
  | { status: "zu_viele" }
  /** Für diese Kennung ist schon ein Entwurf offen */
  | { status: "offen" }
  | { status: "fehler"; fehler: string };

export const DRAFT_TEXT = {
  retrying: (n: number) => `🔁 Der Entwurf hatte ${n} Fehler, ein zweiter Lauf bessert nach.`,
  failedTwice: (fehler: string[]) => [`❌ Auch der zweite Entwurf besteht die Prüfung nicht, abgebrochen. Nichts wurde angelegt.`, ...fehler.slice(0, 15).map((f) => `- ${f}`)].join("\n"),
  jobEnded: (why: string) => `❌ Entwurf abgebrochen: ${why}. Nichts wurde angelegt.`,
  tampered: (files: string[]) =>
    `❌ Entwurf abgebrochen: Während des Jobs haben sich aktive Rezepte oder Wissensdateien geändert (${files.slice(0, 5).join(", ")}). Nichts wurde angelegt; bitte die Dateien prüfen.`,
  occupied: (kennung: string) => `kennung: für ${kennung} ist schon ein anderer Entwurf offen, bitte eine andere vorschlagen`,
  occupiedChange: (kennung: string) => `❌ Entwurf abgebrochen: Für ${kennung} ist inzwischen ein anderer Entwurf offen. Nichts wurde angelegt.`,
  voiceQuestion: (name: string, beschreibung: string) => `🎙️ Stimme für ${name}: gewünscht ist „${beschreibung}“. Welche Stimme soll es sein?`,
  standardVoice: "Standardstimme",
  create: "Anlegen",
  discard: "Verwerfen",
  discarded: "Entwurf verworfen, nichts angelegt.",
  creating: (kennung: string) => `⏳ ${kennung} wird angelegt: speichern, beim Anbieter anlegen, Tests ausführen. Das Ergebnis kommt hierher.`,
  taken: (kennung: string) => `${kennung} gibt es inzwischen schon, nichts angelegt. Ändern mit /sprachagent aendern ${kennung} <wunsch>.`,
  stale: (kennung: string) => `${kennung} wurde seit dem Entwurf geändert oder gelöscht, nichts übernommen. Bitte /sprachagent aendern neu anstoßen.`,
  changedDraft: "Die Dateien des Entwurfs haben sich seit der Prüfung geändert, nichts angelegt. Bitte neu anstoßen.",
  noVoice: (kennung: string) => `${kennung}: Es ist keine Stimme festgelegt (weder gewählt noch als Standardstimme unter Einstellungen, Sprache), nichts angelegt. Bitte neu anstoßen.`,
  notOpen: "Dieser Entwurf ist schon entschieden oder nicht mehr aktuell, nichts geändert.",
  passed: (kennung: string, version: number) => `✅ ${kennung} angelegt (Version ${version}), alle Tests bestanden, freigeschaltet.`,
  failedTests: (kennung: string) =>
    `${kennung} bleibt gesperrt: kein Link, bis die Tests bestehen oder du ihn trotzdem freischaltest. Eine Telefonnummer ordnet tybo nicht zu, und beim Anlegen hing beim Anbieter keine an diesem Agenten.`,
  unlock: "Trotzdem freischalten",
  keepLocked: "Gesperrt lassen",
  unlocked: (kennung: string) => `🔓 ${kennung} trotz durchgefallener Tests freigeschaltet.`,
  keptLocked: (kennung: string) => `${kennung} bleibt gesperrt. Neu testen: /sprachagent testen ${kennung}`,
  unlockStale: (kennung: string) => `${kennung} wurde seit dem Testlauf geändert, nichts freigeschaltet.`,
  standChanged: (felder: string[]) => `Der Agent wurde seit dem Testlauf beim Anbieter geändert (${felder.join(", ")})`,
  standUnknown: (fehler: string) => `Ob der Agent beim Anbieter noch dem getesteten Stand entspricht, ließ sich nicht prüfen (${fehler})`,
  unlockRefused: (kennung: string, why: string) => `⚠️ ${kennung}: ${why}. Nichts freigeschaltet. Neu testen: /sprachagent testen ${kennung}`,
  interrupted: (kennung: string, why: string) => `⚠️ ${kennung}: ${why}. Nicht freigeschaltet.`,
  reachable: (kennung: string) =>
    `⚠️ ${kennung}: Beim Anbieter hängt eine Telefonnummer oder ein WhatsApp-Konto an diesem Agenten. Eine ungeprüfte Fassung wäre dort sofort erreichbar, deshalb hat tybo nichts übernommen; es gilt weiter die bisherige Fassung. Die Zuordnung beim Anbieter lösen, dann erneut versuchen.`,
  reachUnknown: (kennung: string, fehler: string) =>
    `⚠️ ${kennung}: Ob beim Anbieter eine Telefonnummer an diesem Agenten hängt, ließ sich nicht prüfen (${fehler}). tybo hat nichts übernommen; es gilt weiter die bisherige Fassung.`,
  incompleteRun: "Testlauf unvollständig: Das Ergebnis deckt nicht genau die angeforderten Tests ab (ein Test fehlt, kam doppelt, ist fremd, wurde abgebrochen oder hat kein Ergebnis)",
  noLayer: "ELEVENLABS_API_KEY fehlt",
  expired: (record: { art: "neu" | "aendern"; kennung: string; uebernommen: boolean }) =>
    record.uebernommen
      ? `⌛ ${record.kennung}: Die Rückfrage ist nach drei Tagen abgelaufen, der Entwurf ist beendet. ${record.kennung} bleibt in der übernommenen Fassung gespeichert, aber gesperrt. Neu testen: /sprachagent testen ${record.kennung}, ändern: /sprachagent aendern ${record.kennung} <wunsch>`
      : `⌛ ${record.kennung}: Die Rückfrage zum Entwurf ist nach drei Tagen abgelaufen, der Entwurf ist beendet. Nichts wurde angelegt. Neu anstoßen: ${record.art === "neu" ? "/sprachagent neu <beschreibung>" : `/sprachagent aendern ${record.kennung} <wunsch>`}`,
  retry: "Erneut versuchen",
  retryQuestion: (kennung: string) => `${kennung}: Anlegen erneut versuchen?`,
  restartInterrupted: "Der Bot wurde während des Anlegens neu gestartet",
  changeReach: (kennung: string) =>
    `Hängt beim Anbieter eine Telefonnummer oder ein WhatsApp-Konto an ${kennung}, übernimmt tybo nichts: Eine ungeprüfte Fassung wäre dort sofort erreichbar. Sonst gilt die neue Fassung mit dem Anlegen beim Anbieter, und der Link bleibt gesperrt, bis die Tests bestehen.`,
} as const;

const OUTCOME_TEXT: Partial<Record<JobOutcome, string>> = {
  stopped: "Der Job wurde gestoppt",
  timeout: "Der Job hat sein Zeitlimit überschritten",
  failed: "Der Job ist gescheitert (Log mit /jobs bzw. bun run job log)",
  aborted: "Der Job wurde abgebrochen (Absturz oder Neustart des Rechners)",
  start_failed: "Der Job ließ sich nicht starten",
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const errorName = (e: unknown) => (e instanceof Error ? e.name : "Fehler");
const errorText = (e: unknown) => (e instanceof VoiceAgentError ? e.message : errorName(e));

export function newDraftId(now: Date = new Date()): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}-${randomBytes(3).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Prüfung der Wissensdatei
// ---------------------------------------------------------------------------

export interface KnowledgeCheck {
  fehler: string[];
  zeichen: number;
  quellen: number;
  stand: string;
}

/**
 * Was parseRecipe nicht prüft: Länge (höchstens 40.000 Zeichen, so viel steht im
 * Prompt), eine Zeile „Stand: JJJJ-MM-TT“ und ein Abschnitt „## Quellen“ mit
 * mindestens einer vollständigen URL.
 */
export function checkKnowledge(text: string): KnowledgeCheck {
  const fehler: string[] = [];
  const zeichen = text.length;
  if (!text.trim()) fehler.push(`${DRAFT_FILES.knowledge}: ist leer`);
  if (zeichen > KNOWLEDGE_PROMPT_LIMIT) fehler.push(`${DRAFT_FILES.knowledge}: ${zeichen} Zeichen, höchstens ${KNOWLEDGE_PROMPT_LIMIT}`);
  const stand = /^Stand:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(text)?.[1] ?? "";
  if (!stand || Number.isNaN(Date.parse(stand))) fehler.push(`${DRAFT_FILES.knowledge}: Zeile „Stand: JJJJ-MM-TT“ fehlt`);
  const at = text.search(/^##\s+Quellen\s*$/m);
  const quellen = at === -1 ? 0 : (text.slice(at).match(/https?:\/\/[^\s)>\]]+/g) ?? []).length;
  if (at === -1) fehler.push(`${DRAFT_FILES.knowledge}: Abschnitt „## Quellen“ fehlt`);
  else if (quellen === 0) fehler.push(`${DRAFT_FILES.knowledge}: unter „## Quellen“ steht keine URL`);
  return { fehler, zeichen, quellen, stand };
}

/**
 * Deckt ein Testergebnis genau die angeforderten Tests ab? Jede angeforderte
 * Test-ID genau einmal, keine fremde, keine doppelte. Nur so ein Lauf darf
 * über die Freischaltung entscheiden.
 */
export function coversRequested(requested: readonly string[], tests: readonly { testId: string }[]): boolean {
  const wanted = new Set(requested);
  if (wanted.size === 0 || wanted.size !== requested.length || tests.length !== wanted.size) return false;
  const seen = new Set<string>();
  for (const test of tests) {
    if (!wanted.has(test.testId) || seen.has(test.testId)) return false;
    seen.add(test.testId);
  }
  return true;
}

/** Name der Wissensdatei mit Hash: Eine reine Wissensänderung ändert so auch den Rezept-Hash */
export function knowledgeFileName(hash: string): string {
  return `wissen-${hash.slice(0, 12)}.md`;
}

// ---------------------------------------------------------------------------
// Feldvergleich für aendern
// ---------------------------------------------------------------------------

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      flatten(item, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out.set(prefix, JSON.stringify(value));
}

/** Geänderte Felder als Pfade (persona.rolle, tests, …); Listen zählen als ein Feld */
export function changedFields(before: unknown, after: unknown): string[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  flatten(before, "", a);
  flatten(after, "", b);
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((key) => a.get(key) !== b.get(key)).sort();
}

// ---------------------------------------------------------------------------
// Dienst
// ---------------------------------------------------------------------------

export type ReserveOutcome = { status: "reserviert"; id: string } | { status: "vergeben" } | { status: "belegt" };

export interface DraftService {
  startNew(beschreibung: string, conversation: ChoiceConversation): Promise<StartDraftOutcome>;
  /**
   * Wizard (Issue #514): reserviert entwuerfe/<kennung>/ für einen Entwurf in
   * der Phase „wizard“, wie ein geprüfter Entwurf mit entwurf-id. vergeben: Es
   * gibt das Rezept schon; belegt: ein anderer offener Entwurf hält die Kennung.
   */
  reserveWizard(kennung: string, conversation: ChoiceConversation): Promise<ReserveOutcome>;
  /**
   * Wizard: startet denselben Ablauf wie startNew mit Vorgaben. Nur aus der
   * Phase „wizard“ (sonst nicht_offen); scheitert der Start, bleibt sie.
   */
  startWizard(id: string, input: { anfrage: string; vorgaben: DraftPresets; files: DraftInputFile[] }): Promise<StartDraftOutcome | { status: "nicht_offen" }>;
  /** Wizard: einen noch nicht gebauten Entwurf verwerfen; false, wenn er nicht in der Phase „wizard“ ist */
  discardWizard(id: string): Promise<boolean>;
  startChange(kennung: string, wunsch: string, conversation: ChoiceConversation): Promise<StartDraftOutcome>;
  /** Einmal alle laufenden Entwürfe prüfen (Takt und Tests) */
  tick(): Promise<void>;
  /** Nach dem Start: Jobs anhängen, fehlende Rückfragen stellen, unterbrochenes Anlegen melden */
  resume(): Promise<void>;
  /** Takt starten; liefert die Funktion zum Anhalten */
  startPolling(intervalMs?: number): () => void;
  handler: ChoiceHandler;
  /** Schritte, die dieser Dienst bedient (Choice.action) */
  steps: readonly string[];
  read(id: string): Promise<DraftRecord | null>;
  /** Arbeitsordner des Jobs eines Entwurfs (absolut) */
  workDir(id: string): string;
  /** Ordner mit den Steuerdaten eines Entwurfs (absolut) */
  controlDir(id: string): string;
  /** Ablage des geprüften Entwurfs einer Kennung (absolut) */
  ablageDir(kennung: string): string;
  /** Für Tests: bis alle Anlege-Läufe fertig sind */
  settled(): Promise<void>;
}

interface Checked {
  rezept: Recipe;
  wissen: DraftRecord["wissen"];
  wissenText: string | null;
  wissenUnveraendert: boolean;
  beschreibung?: string;
}

export function createDraftService(deps: DraftDeps): DraftService {
  const paths = deps.paths;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => Date.now());
  const create = deps.createChoice ?? realCreateChoice;
  const getChoice = deps.getChoice ?? realGetChoice;
  const voiceSources = deps.voiceSources ?? defaultVoiceSources;
  const newId = deps.newId ?? (() => newDraftId(new Date(now())));
  const iso = () => new Date(now()).toISOString();
  const running = new Map<string, Promise<void>>();
  const applying = new Set<Promise<void>>();

  // --- Ordner ------------------------------------------------------------------

  const draftsRoot = () => join(agentsDataRoot(paths), DRAFT_DIR);
  const workRoot = () => join(draftsRoot(), DRAFT_WORK_DIR);
  const controlRoot = () => join(draftsRoot(), DRAFT_CONTROL_DIR);
  const checkedId = (id: string) => {
    if (!DRAFT_ID_PATTERN.test(id)) throw new VoiceAgentError("Ungültige Kennung eines Entwurfs");
    return id;
  };
  const workDir = (id: string) => join(workRoot(), checkedId(id));
  const controlDir = (id: string) => join(controlRoot(), checkedId(id));
  const ablageDir = (kennung: string) => {
    if (!isValidKennung(kennung)) throw new VoiceAgentError(`Ungültige Kennung: ${JSON.stringify(kennung)}`);
    return join(draftsRoot(), kennung);
  };
  const workDirs = (id: string) => [agentsDataRoot(paths), draftsRoot(), workRoot(), workDir(id)];
  const controlDirs = (id: string) => [agentsDataRoot(paths), draftsRoot(), controlRoot(), controlDir(id)];
  const recordFile = (id: string) => join(controlDir(id), "entwurf.json");

  // --- Steuerdaten ------------------------------------------------------------------

  async function read(id: string): Promise<DraftRecord | null> {
    if (!DRAFT_ID_PATTERN.test(id)) return null;
    if (!(await realDirsExist(controlDirs(id)))) return null;
    const content = await readRegularFile(recordFile(id));
    if (content === null) return null;
    try {
      const raw = JSON.parse(content);
      if (raw?.version === 1 && raw.id === id && typeof raw.phase === "string") return raw as DraftRecord;
    } catch {
      // unten
    }
    throw new VoiceAgentError(`Entwurf ${id} ist beschädigt`);
  }

  async function write(record: DraftRecord): Promise<DraftRecord> {
    const next = { ...record, geaendertAm: iso() };
    await ensureRealDirs(controlDirs(record.id));
    await assertFileOrMissing(recordFile(record.id));
    await atomicWriteFile(recordFile(record.id), JSON.stringify(next, null, 2) + "\n");
    return next;
  }

  async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    await assertFileOrMissing(file);
    const owner = await acquireFileLock(file, { waitMs: LOCK_WAIT_MS });
    try {
      return await fn();
    } finally {
      await releaseFileLock(file, owner);
    }
  }

  /** Ein Entwurf zur Zeit: im Prozess der Reihe nach, über Prozesse per Datei-Sperre */
  async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = running.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chain = previous.then(() => mine);
    running.set(id, chain);
    await previous;
    try {
      await ensureRealDirs(controlDirs(id));
      return await withFileLock(join(controlDir(id), "entwurf.lock"), fn);
    } finally {
      release();
      if (running.get(id) === chain) running.delete(id);
    }
  }

  async function listIds(): Promise<string[]> {
    if (!(await realDirsExist([agentsDataRoot(paths), draftsRoot(), controlRoot()]))) return [];
    return (await readdir(controlRoot())).filter((name) => DRAFT_ID_PATTERN.test(name)).sort();
  }

  const readWork = (id: string, name: string) => readRegularFile(join(workDir(id), name));
  const readControl = (id: string, name: string) => readRegularFile(join(controlDir(id), name));

  // --- Ablage je Kennung ----------------------------------------------------------------

  /** Offener Entwurf (nicht beendet), der die Ablage der Kennung hält; null: frei */
  async function ablageOwner(kennung: string): Promise<string | null> {
    if (!(await realDirsExist([agentsDataRoot(paths), draftsRoot(), ablageDir(kennung)]))) return null;
    const owner = (await readRegularFile(join(ablageDir(kennung), DRAFT_OWNER_FILE)))?.trim() ?? "";
    if (!DRAFT_ID_PATTERN.test(owner)) return null;
    let record: DraftRecord | null;
    try {
      record = await read(owner);
    } catch {
      // beschädigt: lieber belegt als überschrieben
      return owner;
    }
    return record && !FINAL_PHASES.includes(record.phase) ? owner : null;
  }

  /**
   * Legt den geprüften Entwurf unter entwuerfe/<kennung>/ ab, wenn kein anderer
   * offener Entwurf die Kennung hält. Unter einer Sperre für alle Ablagen, damit
   * zwei Entwürfe derselben Kennung nicht zugleich durchkommen.
   */
  async function publish(id: string, rezept: Recipe, knowledge: string | null, voice: string | undefined): Promise<boolean> {
    await ensureRealDirs([agentsDataRoot(paths), draftsRoot(), controlRoot()]);
    return withFileLock(join(controlRoot(), "ablage.lock"), async () => {
      const owner = await ablageOwner(rezept.kennung);
      if (owner && owner !== id) return false;
      const dir = ablageDir(rezept.kennung);
      await ensureRealDirs([agentsDataRoot(paths), draftsRoot(), dir]);
      const files = [DRAFT_OWNER_FILE, DRAFT_FILES.recipe, DRAFT_FILES.knowledge, DRAFT_FILES.voice];
      for (const name of files) await assertFileOrMissing(join(dir, name));
      // Erst den Ordner beanspruchen, dann die Dateien: Ein Neustart dazwischen legt neu ab
      await atomicWriteFile(join(dir, DRAFT_OWNER_FILE), `${id}\n`);
      for (const name of files.slice(1)) await rm(join(dir, name), { force: true });
      await atomicWriteFile(join(dir, DRAFT_FILES.recipe), JSON.stringify(rezept, null, 2) + "\n");
      if (knowledge !== null) await atomicWriteFile(join(dir, DRAFT_FILES.knowledge), knowledge);
      if (voice !== undefined) await atomicWriteFile(join(dir, DRAFT_FILES.voice), `${voice}\n`);
      return true;
    });
  }

  async function writeAblageRecipe(rezept: Recipe): Promise<void> {
    const file = join(ablageDir(rezept.kennung), DRAFT_FILES.recipe);
    await assertFileOrMissing(file);
    await atomicWriteFile(file, JSON.stringify(rezept, null, 2) + "\n");
  }

  /** Steht in der Ablage noch genau das, was freigegeben wird? */
  async function ablageIntact(record: DraftRecord): Promise<boolean> {
    const r = record.rezept!;
    if (recipeHash(r) !== record.rezeptHash) return false;
    if (!(await realDirsExist([agentsDataRoot(paths), draftsRoot(), ablageDir(r.kennung)]))) return false;
    const dir = ablageDir(r.kennung);
    if ((await readRegularFile(join(dir, DRAFT_OWNER_FILE)))?.trim() !== record.id) return false;
    const raw = await readRegularFile(join(dir, DRAFT_FILES.recipe));
    const parsed = raw === null ? null : parseRecipe(raw);
    if (!parsed?.ok || recipeHash(parsed.recipe) !== record.rezeptHash) return false;
    if (record.wissen) {
      const knowledge = await readRegularFile(join(dir, DRAFT_FILES.knowledge));
      if (knowledge === null || sha256(knowledge) !== record.wissen.hash) return false;
    }
    return true;
  }

  // --- Schutz der aktiven Ablage ------------------------------------------------

  /** Hash je Datei, die ein Job nie ändern darf: Rezepte, Versionen, Wissensdateien der Agenten */
  async function protectedSnapshot(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const add = async (dir: string, filter: (name: string) => boolean, label: string) => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names.filter(filter).sort()) {
        try {
          const content = await readRegularFile(join(dir, name));
          if (content !== null) out[`${label}/${name}`] = sha256(content);
        } catch {
          out[`${label}/${name}`] = "kein-normale-datei";
        }
      }
    };
    if (await realDirsExist([recipesDir(paths)]).catch(() => false)) await add(recipesDir(paths), (n) => n.endsWith(".json"), "config/voice-agents");
    if (await realDirsExist([agentsDataRoot(paths)]).catch(() => false)) {
      for (const kennung of (await readdir(agentsDataRoot(paths))).filter(isValidKennung).sort()) {
        const dir = agentDataDir(kennung, paths);
        await add(dir, (n) => n.endsWith(".md"), `data/voice-agents/${kennung}`);
        await add(join(dir, "versionen"), (n) => n.endsWith(".json"), `data/voice-agents/${kennung}/versionen`);
      }
    }
    return out;
  }

  function changedProtected(before: Record<string, string>, after: Record<string, string>): string[] {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].filter((key) => before[key] !== after[key]).sort();
  }

  // --- Zustellung -------------------------------------------------------------------

  async function say(conversation: ChoiceConversation, text: string, what: string): Promise<void> {
    try {
      await deps.notify(conversation, text);
    } catch (e) {
      log(`[sprachagent] Meldung ${what} nicht zugestellt (${errorName(e)})`);
    }
  }

  async function deliver(choice: Choice): Promise<boolean> {
    let shown = false;
    if (choice.conversation.type === "web" && deps.postWeb) {
      try {
        shown = await deps.postWeb(choice.conversation.conversationId, { text: choice.text, kind: "notice", source: VOICE_AGENT_SOURCE, choiceId: choice.id });
      } catch (e) {
        log(`[sprachagent] Frage ${choice.id} nicht ins Web-Gespräch gelegt (${errorName(e)})`);
      }
    }
    try {
      return (await deps.sendChoice(choice)).sent || shown;
    } catch (e) {
      log(`[sprachagent] Frage ${choice.id} nicht gesendet (${errorName(e)})`);
      return shown;
    }
  }

  /**
   * Neue Rückfrage für den Entwurf; eine ältere desselben Entwurfs läuft ab.
   * Erst anlegen, dann eintragen, dann zustellen: Fehlt nach einem Neustart
   * die Kennung oder die Zustellung, holt resume() das nach.
   */
  async function ask(record: DraftRecord, step: string, text: string, options: ChoiceOption[]): Promise<DraftRecord> {
    const frist = now() + DRAFT_CHOICE_TTL_MS;
    const choice = await create(
      { kind: "sprachagent", conversation: record.conversation, text, options, ref: record.id, action: step, expiresAt: frist },
      { replace: (c) => c.kind === "sprachagent" && c.ref === record.id },
    );
    let next = await write({ ...record, choiceId: choice.id, zugestellt: undefined, frist });
    if (await deliver(choice)) next = await write({ ...next, zugestellt: choice.id });
    else log(`[sprachagent] Entwurf ${record.id}: Frage ${choice.id} nirgends zugestellt`);
    return next;
  }

  // --- Start ----------------------------------------------------------------------

  function target(conversation: ChoiceConversation): JobTarget {
    if (conversation.type === "web") return { chatId: webConversationChatId(conversation.conversationId) };
    return conversation.topicId !== undefined ? { chatId: conversation.chatId, topicId: conversation.topicId } : { chatId: conversation.chatId };
  }

  /** Eindeutig je Entwurf und Lauf: Darüber findet resume() einen Job ohne eingetragene Kennung */
  const jobTitle = (record: DraftRecord) => `Sprachagent-Entwurf ${record.id} (Versuch ${record.versuch})`;

  /** Kopien für den Job: Beispielrezepte, Typen, beim Ändern das aktive Rezept und seine Wissensdatei */
  async function prepareWork(id: string, base: { recipe: string; knowledge: string | null } | null): Promise<void> {
    await ensureRealDirs(workDirs(id));
    const dir = workDir(id);
    const copy = async (target: string, content: string) => writeFile(join(dir, target), content, { mode: 0o600, flag: "wx" });
    const examples = deps.examplesDir ?? join(deps.root, "config", "voice-agents.example");
    try {
      const names = (await readdir(examples)).filter((name) => name.endsWith(".json")).sort();
      if (names.length) await ensureRealDirs([dir, join(dir, DRAFT_FILES.examples)]);
      for (const name of names) {
        const content = await readRegularFile(join(examples, name)).catch(() => null);
        if (content !== null) await copy(join(DRAFT_FILES.examples, name), content);
      }
    } catch (e) {
      log(`[sprachagent] Entwurf ${id}: Beispielrezepte nicht kopiert (${errorName(e)})`);
    }
    const schema = await readRegularFile(deps.schemaFile ?? join(deps.root, "src", "lib", "voice-agents", "recipe.ts")).catch(() => null);
    if (schema !== null) {
      await ensureRealDirs([dir, join(dir, "schema")]);
      await copy(DRAFT_FILES.schema, schema);
    }
    if (base) {
      await copy(DRAFT_FILES.base, base.recipe);
      if (base.knowledge !== null) await copy(DRAFT_FILES.baseKnowledge, base.knowledge);
    }
  }

  /**
   * Startet den Job des aktuellen Laufs. Der Zustand „Start steht an“ steht vor
   * dem Start in entwurf.json; gibt es schon einen Job mit dem Titel (Neustart
   * zwischen Start und Eintrag), wird er angehängt statt ein zweiter gestartet.
   */
  async function launch(record: DraftRecord): Promise<{ ok: true; record: DraftRecord } | { ok: false; error: string }> {
    const title = jobTitle(record);
    const found = await deps.jobs.find(title);
    if (found) return { ok: true, record: await write({ ...record, phase: "job", jobId: found }) };
    const attempts = (record.startVersuche ?? 0) + 1;
    if (attempts > MAX_JOB_STARTS) return { ok: false, error: `Der Job ließ sich nach ${MAX_JOB_STARTS} Versuchen nicht starten` };
    const pending = await write({ ...record, phase: "job", jobId: undefined, startVersuche: attempts });
    const brief = draftBrief({
      art: pending.art,
      request: pending.anfrage,
      ...(pending.vorgaben ? { vorgaben: pending.vorgaben } : {}),
      ...(pending.kennung && pending.art === "aendern" ? { kennung: pending.kennung } : {}),
      today: iso().slice(0, 10),
      ...(pending.versuch === 2 && pending.fehler ? { fehler: pending.fehler } : {}),
    });
    const started = await deps.jobs.start({
      title,
      brief,
      target: target(pending.conversation),
      allowedTools: [...DRAFT_JOB_ALLOWED_TOOLS],
      deniedTools: [...DRAFT_JOB_DENIED_TOOLS],
      workDir: workDir(pending.id),
    });
    // Läuft schon ein Job mit genau diesem Titel, war es dieser Entwurf
    const jobId = started.ok ? started.id : started.duplicateOf;
    if (!jobId) return { ok: false, error: started.ok ? "keine Job-ID" : started.error };
    return { ok: true, record: await write({ ...pending, jobId }) };
  }

  async function records(): Promise<DraftRecord[]> {
    const out: DraftRecord[] = [];
    for (const id of await listIds()) {
      try {
        const record = await read(id);
        if (record) out.push(record);
      } catch {
        // beschädigt: zählt nicht
      }
    }
    return out;
  }

  async function begin(record: DraftRecord): Promise<StartDraftOutcome> {
    if ((await records()).filter((r) => r.phase === "job").length >= MAX_RUNNING_DRAFTS) return { status: "zu_viele" };
    return locked(record.id, async () => {
      let launched: Awaited<ReturnType<typeof launch>>;
      try {
        launched = await launch(await write(record));
      } catch (e) {
        // Ob der Job lief, weiß nur das Job-Register: dann anhängen, sonst abbrechen
        const found = await deps.jobs.find(jobTitle(record)).catch(() => null);
        if (found) launched = { ok: true, record: await write({ ...record, jobId: found }) };
        else launched = { ok: false, error: errorText(e) };
      }
      if (!launched.ok) {
        await write({ ...record, phase: "abgebrochen", grund: "Job nicht gestartet" });
        log(`[sprachagent] Entwurf ${record.id}: Job nicht gestartet`);
        return { status: "fehler", fehler: launched.error } as const;
      }
      log(`[sprachagent] Entwurf ${record.id} (${record.art}${record.kennung ? ` ${record.kennung}` : ""}): Job ${launched.record.jobId}`);
      return { status: "gestartet", id: record.id, jobId: launched.record.jobId! } as const;
    });
  }

  function cleanRequest(text: string): string | StartDraftOutcome {
    const trimmed = text.replace(/\r\n?/g, "\n").trim();
    if (!trimmed) return { status: "leer" };
    if (trimmed.length > REQUEST_MAX) return { status: "zu_lang" };
    return trimmed;
  }

  async function fresh(art: DraftRecord["art"], anfrage: string, conversation: ChoiceConversation, extra: Partial<DraftRecord> = {}): Promise<DraftRecord> {
    const at = iso();
    return { version: 1, id: newId(), art, anfrage, conversation, erstelltAm: at, geaendertAm: at, phase: "job", versuch: 1, schutz: await protectedSnapshot(), ...extra };
  }

  async function startNew(beschreibung: string, conversation: ChoiceConversation): Promise<StartDraftOutcome> {
    const request = cleanRequest(beschreibung);
    if (typeof request !== "string") return request;
    const record = await fresh("neu", request, conversation);
    await prepareWork(record.id, null);
    return begin(record);
  }

  async function activeKnowledge(recipe: Recipe): Promise<string | null> {
    const datei = recipe.wissen?.datei;
    if (!datei) return null;
    const name = datei.slice(datei.lastIndexOf("/") + 1);
    if (!(await realDirsExist([agentsDataRoot(paths), agentDataDir(recipe.kennung, paths)]))) return null;
    return readRegularFile(join(agentDataDir(recipe.kennung, paths), name));
  }

  async function startChange(kennung: string, wunsch: string, conversation: ChoiceConversation): Promise<StartDraftOutcome> {
    const request = cleanRequest(wunsch);
    if (typeof request !== "string") return request;
    if (!isValidKennung(kennung)) return { status: "unbekannt" };
    let recipe: Recipe | null;
    try {
      recipe = await loadRecipe(kennung, paths);
    } catch (e) {
      return { status: "kaputt", fehler: errorText(e) };
    }
    if (!recipe) return { status: "unbekannt" };
    if ((await ablageOwner(kennung)) || (await records()).some((r) => r.art === "aendern" && r.kennung === kennung && !FINAL_PHASES.includes(r.phase))) return { status: "offen" };
    const knowledge = await activeKnowledge(recipe);
    const record = await fresh("aendern", request, conversation, {
      kennung,
      basis: { hash: recipeHash(recipe), wissenHash: knowledge === null ? null : sha256(knowledge) },
    });
    const baseText = JSON.stringify(recipe, null, 2) + "\n";
    // Maßgeblich ist die Kopie in den Steuerdaten; der Job bekommt eine eigene
    await ensureRealDirs(controlDirs(record.id));
    await writeFile(join(controlDir(record.id), DRAFT_FILES.base), baseText, { mode: 0o600, flag: "wx" });
    if (knowledge !== null) await writeFile(join(controlDir(record.id), DRAFT_FILES.baseKnowledge), knowledge, { mode: 0o600, flag: "wx" });
    await prepareWork(record.id, { recipe: baseText, knowledge });
    return begin(record);
  }

  // --- Wizard (Issue #514) -----------------------------------------------------------

  async function reserveWizard(kennung: string, conversation: ChoiceConversation): Promise<ReserveOutcome> {
    const dir = ablageDir(kennung);
    await ensureRealDirs([agentsDataRoot(paths), draftsRoot(), controlRoot()]);
    return withFileLock(join(controlRoot(), "ablage.lock"), async () => {
      if (await recipeExistsFor(kennung)) return { status: "vergeben" } as const;
      if (await ablageOwner(kennung)) return { status: "belegt" } as const;
      const record: DraftRecord = { ...(await fresh("neu", "", conversation)), phase: "wizard", kennung, schutz: {} };
      // Erst der Entwurf, dann die Reservierung: Ein Neustart dazwischen lässt nur einen unbenutzten Entwurf zurück
      await write(record);
      await ensureRealDirs([agentsDataRoot(paths), draftsRoot(), dir]);
      await assertFileOrMissing(join(dir, DRAFT_OWNER_FILE));
      await atomicWriteFile(join(dir, DRAFT_OWNER_FILE), `${record.id}\n`);
      log(`[sprachagent] Entwurf ${record.id}: Wizard reserviert ${kennung}`);
      return { status: "reserviert", id: record.id } as const;
    });
  }

  async function startWizard(id: string, input: { anfrage: string; vorgaben: DraftPresets; files: DraftInputFile[] }): Promise<StartDraftOutcome | { status: "nicht_offen" }> {
    const request = cleanRequest(input.anfrage);
    if (typeof request !== "string") return request;
    if (!DRAFT_ID_PATTERN.test(id)) return { status: "nicht_offen" };
    const running = (await records()).filter((r) => r.phase === "job").length;
    return locked(id, async () => {
      const record = await read(id);
      if (!record || record.phase !== "wizard") return { status: "nicht_offen" } as const;
      if (running >= MAX_RUNNING_DRAFTS) return { status: "zu_viele" } as const;
      // Ein Arbeitsordner von einem abgebrochenen Start wird ersetzt
      if (await realDirsExist(workDirs(id))) await rm(workDir(id), { recursive: true, force: true });
      await prepareWork(id, null);
      if (input.files.length) {
        await ensureRealDirs([...workDirs(id), join(workDir(id), DRAFT_INPUT_DIR)]);
        for (const file of input.files) await writeFile(join(workDir(id), DRAFT_INPUT_DIR, file.datei), file.content, { mode: 0o600, flag: "wx" });
      }
      const next: DraftRecord = { ...record, anfrage: request, vorgaben: input.vorgaben, schutz: await protectedSnapshot(), phase: "job", versuch: 1, startVersuche: 0, jobId: undefined, grund: undefined };
      let launched: Awaited<ReturnType<typeof launch>>;
      try {
        launched = await launch(next);
      } catch (e) {
        const found = await deps.jobs.find(jobTitle(next)).catch(() => null);
        launched = found ? { ok: true, record: await write({ ...next, jobId: found }) } : { ok: false, error: errorText(e) };
      }
      if (!launched.ok) {
        // Der Wizard bleibt offen: Felder und Kennung gehen nicht verloren
        await write({ ...record, grund: "Job nicht gestartet" });
        log(`[sprachagent] Entwurf ${id}: Wizard, Job nicht gestartet`);
        return { status: "fehler", fehler: launched.error } as const;
      }
      log(`[sprachagent] Entwurf ${id} (Wizard ${record.kennung}): Job ${launched.record.jobId}`);
      return { status: "gestartet", id, jobId: launched.record.jobId! } as const;
    });
  }

  async function discardWizard(id: string): Promise<boolean> {
    if (!DRAFT_ID_PATTERN.test(id)) return false;
    return locked(id, async () => {
      const record = await read(id);
      if (!record || record.phase !== "wizard") return false;
      await write({ ...record, phase: "verworfen" });
      log(`[sprachagent] Entwurf ${id}: Wizard verworfen`);
      return true;
    });
  }

  // --- Prüfung nach dem Job -------------------------------------------------------

  async function baseRecipe(record: DraftRecord): Promise<Recipe | null> {
    if (record.art !== "aendern") return null;
    const raw = await readControl(record.id, DRAFT_FILES.base);
    const parsed = raw === null ? null : parseRecipe(raw);
    return parsed?.ok ? parsed.recipe : null;
  }

  async function checkDraft(record: DraftRecord): Promise<{ ok: true; value: Checked } | { ok: false; fehler: string[] }> {
    const fehler: string[] = [];
    const raw = await readWork(record.id, DRAFT_FILES.recipe);
    if (raw === null) return { ok: false, fehler: [`${DRAFT_FILES.recipe}: fehlt, der Job hat kein Rezept geschrieben`] };
    // Vor dem Overlay: Die Vorgaben würden eine Stimme des Jobs sonst überschreiben, und die Abweichung bliebe unbemerkt
    const jobVoice = rawVoiceId(raw);
    const presetVoice = record.vorgaben?.stimme?.wahl === "konto" ? record.vorgaben.stimme.voiceId : undefined;
    const parsed = parseRecipe(withPresets(record, raw));
    if (!parsed.ok) fehler.push(...parsed.fehler);
    const recipe = parsed.ok ? parsed.recipe : null;
    if (recipe && record.vorgaben) fehler.push(...wizardRecipeProblems(recipe));
    const base = await baseRecipe(record);
    // Wissensdatei: neu aus dem Arbeitsordner, die alte aus den Steuerdaten
    const draftKnowledge = await readWork(record.id, DRAFT_FILES.knowledge);
    const baseKnowledge = record.art === "aendern" ? await readControl(record.id, DRAFT_FILES.baseKnowledge) : null;
    const newExpert = record.art === "neu" && recipe?.vorlage === "experte";
    if (recipe) {
      if (record.art === "neu") {
        if (await recipeExistsFor(recipe.kennung)) fehler.push(`kennung: ${recipe.kennung} gibt es schon, bitte eine andere vorschlagen`);
        // Erlaubt ist nur die Stimme, die der Nutzer im Wizard gewählt hat
        if ((jobVoice !== undefined && jobVoice !== presetVoice) || (recipe.stimme.voiceId && recipe.stimme.voiceId !== presetVoice)) {
          fehler.push("stimme.voiceId: keine Stimmen-Kennung eintragen, die Stimme wählt der Nutzer");
        }
      } else {
        if (recipe.kennung !== record.kennung) fehler.push(`kennung: muss ${record.kennung} bleiben`);
        if (recipe.stimme.voiceId && recipe.stimme.voiceId !== base?.stimme.voiceId) fehler.push("stimme.voiceId: keine neue Stimmen-Kennung eintragen, die Stimme wählt der Nutzer");
      }
      // Ein neuer Experte braucht die Recherche, unabhängig davon, was das Rezept bei gedaechtnis sagt
      if (newExpert && draftKnowledge === null) fehler.push(`${DRAFT_FILES.knowledge}: fehlt, ein neuer Experte braucht eine recherchierte Wissensdatei mit Quellen`);
      if (newExpert && recipe.gedaechtnis !== "thema") fehler.push("gedaechtnis: ein neuer Experte braucht thema, sein Wissen steht in wissen.md");
    }
    let wissen: DraftRecord["wissen"] = null;
    let wissenText: string | null = null;
    let unveraendert = false;
    if (recipe?.gedaechtnis === "thema") {
      const source = draftKnowledge ?? baseKnowledge;
      if (source === null) {
        if (!newExpert) fehler.push(`${DRAFT_FILES.knowledge}: fehlt, gedaechtnis thema braucht eine Wissensdatei`);
      } else {
        unveraendert = draftKnowledge === null || draftKnowledge === baseKnowledge;
        const check = checkKnowledge(source);
        // Übernommenes, unverändertes Wissen prüft nur die Länge: es war vor diesen Regeln da
        if (unveraendert && baseKnowledge !== null) fehler.push(...check.fehler.filter((f) => f.includes("Zeichen") || f.includes("leer")));
        else fehler.push(...check.fehler);
        wissen = { datei: DRAFT_FILES.knowledge, hash: sha256(source), zeichen: check.zeichen, quellen: check.quellen, stand: check.stand };
        wissenText = source;
      }
    } else if (draftKnowledge !== null && recipe && !newExpert) {
      fehler.push(`${DRAFT_FILES.knowledge}: nur bei gedaechtnis thema, sonst weglassen`);
    } else if (newExpert && draftKnowledge !== null) {
      fehler.push(...checkKnowledge(draftKnowledge).fehler);
    }
    // Stimmbeschreibung
    const voiceRaw = await readWork(record.id, DRAFT_FILES.voice);
    let beschreibung: string | undefined;
    if (voiceRaw !== null) {
      const line = voiceRaw.trim();
      if (!line || line.includes("\n")) fehler.push(`${DRAFT_FILES.voice}: genau eine Zeile`);
      else if (line.length > VOICE_DESCRIPTION_MAX) fehler.push(`${DRAFT_FILES.voice}: höchstens ${VOICE_DESCRIPTION_MAX} Zeichen`);
      else beschreibung = line;
    }
    if (fehler.length || !recipe) return { ok: false, fehler };
    // Endgültiger Name der Wissensdatei mit Hash
    let frozen: Recipe = recipe;
    if (wissen) frozen = { ...recipe, wissen: { datei: `data/voice-agents/${recipe.kennung}/${knowledgeFileName(wissen.hash)}` } };
    // Bei aendern bleibt die Stimme, bis der Nutzer eine neue wählt
    if (record.art === "aendern" && base?.stimme.voiceId && !frozen.stimme.voiceId) frozen = { ...frozen, stimme: { ...frozen.stimme, voiceId: base.stimme.voiceId } };
    const again = parseRecipe(frozen);
    if (!again.ok) return { ok: false, fehler: again.fehler };
    return { ok: true, value: { rezept: again.recipe, wissen, wissenText, wissenUnveraendert: unveraendert, ...(beschreibung ? { beschreibung } : {}) } };
  }

  /**
   * Wizard: die Vorgaben über das Rezept des Jobs legen. Ohne Vorgaben oder bei
   * kaputtem JSON bleibt der Text, damit parseRecipe denselben Fehler meldet
   * wie bei /sprachagent neu.
   */
  function withPresets(record: DraftRecord, raw: string): unknown {
    if (!record.vorgaben) return raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    return applyOverlay(parsed, record.vorgaben.rezept);
  }

  /** stimme.voiceId, wie der Job sie geschrieben hat; undefined ohne oder bei kaputtem JSON (das meldet parseRecipe) */
  function rawVoiceId(raw: string): unknown {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed.stimme?.voiceId : undefined;
    } catch {
      return undefined;
    }
  }

  async function recipeExistsFor(kennung: string): Promise<boolean> {
    if (!isValidKennung(kennung)) return false;
    if (!(await realDirsExist([recipesDir(paths)]))) return false;
    return (await readRegularFile(recipePath(kennung, paths))) !== null;
  }

  async function abort(record: DraftRecord, grund: string, text: string): Promise<void> {
    await write({ ...record, phase: "abgebrochen", grund, choiceId: undefined });
    log(`[sprachagent] Entwurf ${record.id}: abgebrochen (${grund})`);
    await say(record.conversation, text, `zu Entwurf ${record.id}`);
  }

  /** Prüfung nicht bestanden: genau ein Nachbesserungslauf, danach Abbruch */
  async function failCheck(record: DraftRecord, fehler: string[]): Promise<void> {
    if (record.versuch === 1) {
      const second: DraftRecord = { ...record, versuch: 2, fehler, jobId: undefined, startVersuche: 0 };
      const launched = await launch(second);
      if (!launched.ok) return abort(second, "Nachbesserung nicht gestartet", DRAFT_TEXT.jobEnded("Der Nachbesserungslauf ließ sich nicht starten"));
      log(`[sprachagent] Entwurf ${record.id}: Nachbesserung, Job ${launched.record.jobId}`);
      return say(record.conversation, DRAFT_TEXT.retrying(fehler.length), `zu Entwurf ${record.id}`);
    }
    return abort({ ...record, fehler }, "Pruefung zweimal gescheitert", DRAFT_TEXT.failedTwice(fehler));
  }

  /** Ein Entwurf im Job: Start nachholen, Ende abwarten, prüfen, nachbessern oder zur Stimmwahl bzw. Freigabe */
  async function advance(id: string): Promise<void> {
    await locked(id, async () => {
      const record = await read(id);
      if (!record || record.phase !== "job") return;
      if (!record.jobId) {
        const launched = await launch(record);
        if (!launched.ok) return abort(record, "Job nicht gestartet", DRAFT_TEXT.jobEnded(launched.error));
        log(`[sprachagent] Entwurf ${id}: Job ${launched.record.jobId} nachgetragen`);
        return;
      }
      const status = await deps.jobs.status(record.jobId);
      if (!status) return abort(record, "Job verschwunden", DRAFT_TEXT.jobEnded("Der Job ist nicht mehr auffindbar"));
      if (status.phase !== "ended") return;
      const outcome = status.outcome ?? "failed";
      if (outcome !== "success" && outcome !== "no_report") {
        return abort(record, `Job ${outcome}`, DRAFT_TEXT.jobEnded(OUTCOME_TEXT[outcome] ?? "Der Job ist gescheitert"));
      }
      const touched = changedProtected(record.schutz, await protectedSnapshot());
      if (touched.length) return abort(record, "geschuetzte Dateien geaendert", DRAFT_TEXT.tampered(touched));
      const checked = await checkDraft(record);
      if (!checked.ok) return failCheck(record, checked.fehler);
      const { wissen, wissenText, wissenUnveraendert, beschreibung } = checked.value;
      let rezept = checked.value.rezept;
      // Stimme aus dem Wizard: keine Stimmwahl im Direktchat
      const preset = record.vorgaben?.stimme;
      const vorschlaege = !preset && beschreibung && deps.suggestVoices ? (await deps.suggestVoices(beschreibung).catch(() => [])).slice(0, 3) : [];
      const voiceStep = Boolean(beschreibung && vorschlaege.length);
      // Ohne Stimmwahl gilt beim neuen Agenten die Standardstimme von jetzt, eingefroren
      let gewaehlt: { voiceId: string; name: string } | undefined;
      if (preset?.wahl === "konto" && record.art === "neu") {
        // Die gewählte Stimme des Kontos bleibt; die Standardstimme ersetzt sie nicht
        rezept = withVoice(rezept, preset.voiceId);
        gewaehlt = { voiceId: preset.voiceId, name: preset.name };
      } else if (!voiceStep && record.art === "neu") {
        const standard = standardVoice();
        if (standard) {
          rezept = withVoice(rezept, standard);
          gewaehlt = { voiceId: standard, name: DRAFT_TEXT.standardVoice };
        }
      }
      if (!(await publish(id, rezept, wissenText, beschreibung))) {
        if (record.art === "aendern") return abort(record, "Ablage belegt", DRAFT_TEXT.occupiedChange(rezept.kennung));
        return failCheck(record, [DRAFT_TEXT.occupied(rezept.kennung)]);
      }
      let next: DraftRecord = await write({
        ...record,
        kennung: rezept.kennung,
        rezept,
        rezeptHash: recipeHash(rezept),
        wissen,
        wissenUnveraendert,
        fehler: [],
        stimme: { ...(beschreibung ? { beschreibung } : {}), vorschlaege, ...(gewaehlt ? { gewaehlt } : {}) },
        phase: voiceStep ? "stimme" : "freigabe",
        choiceId: undefined,
      });
      next = voiceStep ? await offerVoice(next) : await offerApproval(next);
      log(`[sprachagent] Entwurf ${id}: geprüft, ${next.phase}`);
    });
  }

  // --- Stimmwahl und Freigabe -----------------------------------------------------------

  function standardVoice(): string | null {
    const resolved = resolveVoice({ stimme: { art: "bibliothek", modell: "", tempo: 1 } } as Pick<Recipe, "stimme">, voiceSources());
    return "voiceId" in resolved ? resolved.voiceId : null;
  }

  function withVoice(rezept: Recipe, voiceId: string | null): Recipe {
    const { voiceId: _old, ...rest } = rezept.stimme;
    return { ...rezept, stimme: voiceId ? { ...rest, voiceId } : rest };
  }

  async function offerVoice(record: DraftRecord): Promise<DraftRecord> {
    const options: ChoiceOption[] = record.stimme!.vorschlaege.map((v, i) => ({ key: `s${i}`, label: v.klon ? `${v.name} (Klon)` : v.name }));
    if (standardVoice()) options.push({ key: DRAFT_KEYS.standardVoice, label: DRAFT_TEXT.standardVoice });
    return ask(record, DRAFT_STEP.voice, DRAFT_TEXT.voiceQuestion(record.rezept!.name, record.stimme!.beschreibung!), options);
  }

  function voiceText(record: DraftRecord): string {
    const chosen = record.stimme?.gewaehlt;
    if (chosen && record.rezept?.stimme.voiceId === chosen.voiceId) return chosen.name;
    if (record.rezept?.stimme.voiceId) return record.art === "aendern" ? "wie bisher" : "aus dem Rezept";
    return "keine festgelegt, Anlegen scheitert ohne Stimme (Einstellungen, Sprache)";
  }

  async function summary(record: DraftRecord): Promise<string> {
    const r = record.rezept!;
    const template = TEMPLATES[r.vorlage];
    const tests = effectiveTests(r, template);
    const access = [
      ...(r.zugang.web?.link ? ["Web-Link"] : []),
      ...(r.zugang.telefon ? [`Telefon (Nummer beim Anbieter ${r.zugang.telefon.nummer}, Anrufer ${r.zugang.telefon.anrufer})`] : []),
    ];
    const memory = record.wissen
      ? `${r.gedaechtnis}, Wissensdatei ${record.wissen.zeichen.toLocaleString("de-DE")} Zeichen${record.wissenUnveraendert ? " (unverändert)" : `, ${record.wissen.quellen} Quellen, Stand ${record.wissen.stand}`}`
      : r.gedaechtnis;
    const prices: PriceLoad = deps.prices ? await deps.prices().catch(() => ({ status: "ungueltig" }) as PriceLoad) : { status: "ok", basis: DEFAULT_PRICE_BASIS, eigene: false };
    const lines = [
      record.art === "neu" ? `🎙️ Entwurf: ${r.name} (${r.kennung})` : `🎙️ Änderung an ${r.name} (${r.kennung})`,
      `Zweck: ${r.zweck}`,
      `Vorlage: ${r.vorlage} · Stimme: ${voiceText(record)} · Gehirn: ${r.gehirn.art === "anbieter" ? "Anbieter" : "Brücke"}, ${r.gehirn.modell}`,
      `Gedächtnis: ${memory}`,
      `Zugang: ${access.length ? access.join(", ") : "keiner"}; höchstens ${r.zugang.maxMinuten} Minuten je Gespräch, ${r.zugang.budget.minutenMonat} im Monat`,
      `Tests (${tests.length}): ${tests.map((t) => t.name).join(", ")}`,
      costLine(r, prices),
    ];
    if (record.art === "aendern") {
      const fields = await changedSummary(record);
      lines.push(fields.length ? `Geändert: ${fields.join(", ")}` : "Geändert: nichts, der Entwurf gleicht dem aktiven Rezept");
      lines.push(DRAFT_TEXT.changeReach(r.kennung));
    } else {
      lines.push(`Ändern: nach dem Anlegen mit /sprachagent aendern ${r.kennung} <wunsch>, oder verwerfen und genauer beschreiben.`);
    }
    return lines.join("\n");
  }

  async function changedSummary(record: DraftRecord): Promise<string[]> {
    const base = await baseRecipe(record);
    if (!base) return ["(Ausgangsrezept nicht lesbar)"];
    const fields = changedFields(base, record.rezept).filter((f) => f !== "wissen.datei");
    if (record.basis?.wissenHash !== (record.wissen?.hash ?? null)) fields.push("Wissensdatei");
    return fields;
  }

  async function offerApproval(record: DraftRecord): Promise<DraftRecord> {
    return ask(record, DRAFT_STEP.approve, await summary(record), [
      { key: DRAFT_KEYS.create, label: DRAFT_TEXT.create },
      { key: DRAFT_KEYS.discard, label: DRAFT_TEXT.discard },
    ]);
  }

  async function offerUnlock(record: DraftRecord): Promise<DraftRecord> {
    return ask(record, DRAFT_STEP.unlock, DRAFT_TEXT.failedTests(record.rezept!.kennung), [
      { key: DRAFT_KEYS.unlock, label: DRAFT_TEXT.unlock },
      { key: DRAFT_KEYS.keepLocked, label: DRAFT_TEXT.keepLocked },
    ]);
  }

  async function offerRetry(record: DraftRecord): Promise<DraftRecord> {
    return ask(record, DRAFT_STEP.retry, DRAFT_TEXT.retryQuestion(record.rezept!.kennung), [
      { key: DRAFT_KEYS.retry, label: DRAFT_TEXT.retry },
      { key: DRAFT_KEYS.discard, label: DRAFT_TEXT.discard },
    ]);
  }

  /** Die Rückfrage, die zur Phase gehört */
  function offerFor(record: DraftRecord): Promise<DraftRecord> {
    switch (record.phase) {
      case "stimme":
        return offerVoice(record);
      case "freigabe":
        return offerApproval(record);
      case "durchgefallen":
        return offerUnlock(record);
      default:
        return offerRetry(record);
    }
  }

  // --- Anlegen -------------------------------------------------------------------------

  /** Wissensdatei unter ihrem endgültigen Namen; liegt sie schon da, muss sie gleich sein */
  async function placeKnowledge(record: DraftRecord): Promise<void> {
    if (!record.wissen || !record.rezept?.wissen) return;
    const kennung = record.rezept.kennung;
    const content = await readRegularFile(join(ablageDir(kennung), DRAFT_FILES.knowledge));
    if (content === null || sha256(content) !== record.wissen.hash) throw new VoiceAgentError(DRAFT_TEXT.changedDraft);
    const dir = agentDataDir(kennung, paths);
    await ensureRealDirs([agentsDataRoot(paths), dir]);
    const target = join(dir, record.rezept.wissen.datei.slice(record.rezept.wissen.datei.lastIndexOf("/") + 1));
    const existing = await readRegularFile(target);
    if (existing !== null) {
      if (sha256(existing) !== record.wissen.hash) throw new VoiceAgentError(`Wissensdatei ${target} gibt es schon mit anderem Inhalt`);
      return;
    }
    const temp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    try {
      await linkFile(temp, target);
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  /**
   * Vorbedingung, die saveRecipe unter der Sperre der Kennung prüft: Die eigene
   * Fassung (auch schon gespeichert, etwa vor einem Neustart) ist in Ordnung;
   * sonst darf es bei neu kein Rezept geben und bei aendern muss das
   * Ausgangsrezept samt Wissen noch gelten. Danach legt sie die Wissensdatei ab.
   */
  async function guard(record: DraftRecord, active: ActiveRecipe): Promise<{ text: string; grund: string } | null> {
    const r = record.rezept!;
    const own = active.recipe !== null && recipeHash(active.recipe) === record.rezeptHash;
    if (!own) {
      if (record.uebernommen) return { text: DRAFT_TEXT.stale(r.kennung), grund: "veraltet" };
      if (record.art === "neu") {
        if (active.recipe || active.broken) return { text: DRAFT_TEXT.taken(r.kennung), grund: "Kennung vergeben" };
      } else {
        if (!active.recipe || recipeHash(active.recipe) !== record.basis?.hash) return { text: DRAFT_TEXT.stale(r.kennung), grund: "veraltet" };
        const knowledge = await activeKnowledge(active.recipe);
        if ((knowledge === null ? null : sha256(knowledge)) !== record.basis.wissenHash) return { text: DRAFT_TEXT.stale(r.kennung), grund: "veraltet" };
      }
    }
    await placeKnowledge(record);
    return null;
  }

  /** Nicht oder nicht ganz angelegt: „Erneut versuchen“ und „Verwerfen“ */
  async function pause(record: DraftRecord, grund: string, text: string): Promise<void> {
    const next = await write({ ...record, phase: "unterbrochen", grund, choiceId: undefined });
    log(`[sprachagent] Entwurf ${record.id}: unterbrochen (${grund})`);
    await say(record.conversation, text, `zu Entwurf ${record.id}`);
    await offerRetry(next);
  }

  const interrupt = (record: DraftRecord, why: string) => pause(record, "unterbrochen", DRAFT_TEXT.interrupted(record.rezept!.kennung, why));

  /**
   * null: Der Agent ist beim Anbieter nicht über Nummer oder WhatsApp
   * erreichbar (oder es gibt ihn dort nicht). Ohne Sprachschicht ist das bei
   * einer Änderung oder einem schon angelegten Agenten unbekannt: Ein
   * bestehender Agent (auch einer mit Brücke, die das aktive Rezept liest)
   * bekäme sonst die ungeprüfte Fassung.
   */
  async function reachability(layer: VoiceLayer | null, record: DraftRecord): Promise<{ grund: string; text: string } | null> {
    const kennung = record.rezept!.kennung;
    let state;
    try {
      const raw = await readState(kennung, paths);
      if (!layer) return record.art === "aendern" || raw?.agentId ? { grund: "Erreichbarkeit unbekannt", text: DRAFT_TEXT.reachUnknown(kennung, DRAFT_TEXT.noLayer) } : null;
      if (!raw?.agentId) return null;
      state = parseLayerState(raw);
    } catch (e) {
      return { grund: "Zustand unlesbar", text: DRAFT_TEXT.reachUnknown(kennung, errorText(e)) };
    }
    const result = await layer.reachable(state);
    if (result.status !== "ok") return { grund: "Erreichbarkeit unbekannt", text: DRAFT_TEXT.reachUnknown(kennung, result.fehler) };
    return result.erreichbar ? { grund: "erreichbar", text: DRAFT_TEXT.reachable(kennung) } : null;
  }

  /**
   * Vor jeder Freischaltung nach Tests: Ist der Agent beim Anbieter noch der
   * getestete, im getesteten Stand? Nur lesend. null heißt ja; sonst der Grund,
   * ohne Freischaltung zu enden. Ohne Sprachschicht, ohne festgehaltenen Stand
   * oder bei unlesbarer Antwort ist der Stand nicht prüfbar, das zählt wie eine
   * Abweichung.
   */
  async function testedStandProblem(layer: VoiceLayer | null, kennung: string, tested: { agentId?: string; stand?: Record<string, string> }): Promise<string | null> {
    if (!layer) return DRAFT_TEXT.standUnknown(DRAFT_TEXT.noLayer);
    if (!tested.agentId || !tested.stand) return DRAFT_TEXT.standUnknown("vom Testlauf ist kein Stand festgehalten");
    let state;
    try {
      const raw = await readState(kennung, paths);
      state = raw ? parseLayerState(raw) : null;
    } catch (e) {
      return DRAFT_TEXT.standUnknown(errorText(e));
    }
    if (state?.agentId !== tested.agentId) return DRAFT_TEXT.standChanged(["anderer Agent"]);
    let result;
    try {
      result = await layer.compareStand(state, tested.stand);
    } catch (e) {
      return DRAFT_TEXT.standUnknown(errorName(e));
    }
    if (result.status !== "ok") return DRAFT_TEXT.standUnknown(result.fehler);
    return result.felder.length > 0 ? DRAFT_TEXT.standChanged(result.felder) : null;
  }

  /** Speichern, beim Anbieter anlegen, Tests; läuft außerhalb der Sperre des Entwurfs, Zustand vorher als „anlegen“ vermerkt */
  async function apply(start: DraftRecord): Promise<void> {
    let record = start;
    const r = record.rezept!;
    const kennung = r.kennung;
    try {
      if (!(await ablageIntact(record))) return abort(record, "Entwurf geaendert", DRAFT_TEXT.changedDraft);
      if (!r.stimme.voiceId) return abort(record, "keine Stimme", DRAFT_TEXT.noVoice(kennung));
      const layer = deps.layer();
      const blocked = await reachability(layer, record);
      if (blocked) return pause(record, blocked.grund, blocked.text);
      let saved;
      try {
        saved = await saveRecipe(r, { ...paths, voices: voiceSources(), guard: (active) => guard(record, active) });
      } catch (e) {
        if (e instanceof SaveRefused) return abort(record, e.grund, e.message);
        throw e;
      }
      record = await write({ ...record, uebernommen: { hash: saved.hash, version: saved.version } });
      log(`[sprachagent] Entwurf ${record.id}: ${kennung} gespeichert, Version ${saved.version}`);
      if (!layer) return interrupt(record, `Rezept gespeichert (Version ${saved.version}), beim Anbieter nicht angelegt: ${DRAFT_TEXT.noLayer}`);
      const knowledge = record.wissen ? await readRegularFile(join(ablageDir(kennung), DRAFT_FILES.knowledge)) : null;
      // Getestet wird genau das geprüfte Wissen; an seinen Hash ist die Freischaltung gebunden
      const wissenHash = record.wissen?.hash ?? null;
      if (wissenHash !== null && (knowledge === null || sha256(knowledge) !== wissenHash)) return interrupt(record, "Rezept gespeichert, beim Anbieter nicht angelegt: die Wissensdatei des Entwurfs hat sich seit der Prüfung geändert");
      const deployed = await layer.deploy(saved.recipe, providerPrompt(saved.recipe, TEMPLATES[saved.recipe.vorlage], knowledge), { nurOhneZuordnung: true, standPruefen: true });
      if (deployed.status === "handaenderung") return interrupt(record, `Rezept gespeichert, beim Anbieter nicht übernommen: ${deployed.warnung}`);
      if (deployed.status === "fehler") return interrupt(record, `Rezept gespeichert, der Anbieter meldet: ${deployed.fehler}`);
      // Der Stand, den deploy beim Anbieter bestätigt hat, ist der getestete; ohne ihn kann kein Lauf freischalten
      const tested = { agentId: deployed.state.agentId, stand: deployed.state.anbieterStand };
      if (!tested.agentId || !tested.stand) return interrupt(record, `Rezept gespeichert, ${DRAFT_TEXT.standUnknown("vom Abgleich ist kein Stand bekannt")}, kein Testlauf gestartet`);
      const synced = await layer.syncTests(saved.recipe, { ...deployed.state, kennung });
      if (synced.status !== "ok") return interrupt(record, `Agent angelegt, Tests nicht übertragen: ${synced.fehler}`);
      // Angefordert sind alle Tests des Agenten beim Anbieter, wie runTests sie startet
      const requested = Object.values(synced.state.tests ?? {}).map((t) => t.id);
      const started = await layer.runTests({ ...synced.state, kennung });
      if (started.status !== "gestartet") return interrupt(record, `Agent angelegt, Testlauf nicht gestartet: ${started.fehler}`);
      const gestartetAm = iso();
      let result;
      try {
        result = await layer.testResult(started.runId);
      } catch (e) {
        log(`[sprachagent] Entwurf ${record.id}: Testabfrage geworfen (${errorName(e)})`);
        result = { status: "fehler", fehler: "Interner Fehler bei der Abfrage", vorlaeufig: false } as const;
      }
      const run = toStoredRun(started.runId, gestartetAm, iso(), result);
      await storeTestRun(kennung, run, paths).catch((e) => log(`[sprachagent] ${kennung}: Testlauf nicht gespeichert (${errorName(e)})`));
      // Für jedes Ergebnis, auch bestanden und unterbrochen: Der Wizard zeigt genau diesen Lauf
      record = await write({ ...record, testRunId: started.runId });
      await say(record.conversation, formatTestRun(r.name, kennung, run), `zu Entwurf ${record.id}`);
      // Entscheiden darf nur ein vollständiger Lauf: genau die angeforderten Tests, jeder bestanden oder durchgefallen
      const outcomes = result.status === "fertig" ? result.tests : [];
      const complete = result.status === "fertig" && coversRequested(requested, outcomes) && outcomes.every((t) => t.status === "bestanden" || t.status === "durchgefallen");
      const allPassed = complete && outcomes.every((t) => t.status === "bestanden");
      if (allPassed) {
        // Eine Änderung beim Anbieter während des Laufs: Getestet wurde dann nicht, was jetzt erreichbar wäre
        const moved = await testedStandProblem(layer, kennung, tested);
        if (moved) return interrupt(record, moved);
        const unlocked = await writeUnlock(kennung, { hash: saved.hash, version: saved.version, wissenHash, grund: "tests", testlauf: started.runId }, paths, now);
        if (unlocked.status !== "freigeschaltet") return interrupt(record, "Das Rezept oder seine Wissensdatei wurde während der Tests geändert, nicht freigeschaltet");
        await write({ ...record, phase: "fertig", choiceId: undefined });
        log(`[sprachagent] Entwurf ${record.id}: ${kennung} freigeschaltet`);
        return say(record.conversation, DRAFT_TEXT.passed(kennung, saved.version), `zu Entwurf ${record.id}`);
      }
      // „Trotzdem freischalten“ nur bei einem vollständigen Lauf mit durchgefallenen Tests
      if (complete) {
        const next = await write({ ...record, phase: "durchgefallen", choiceId: undefined, testlauf: { hash: saved.hash, version: saved.version, wissenHash, runId: started.runId, ...tested } });
        await offerUnlock(next);
        return;
      }
      return interrupt(
        record,
        result.status === "fertig" ? DRAFT_TEXT.incompleteRun : result.status === "zeitueberschreitung" ? "kein Testergebnis in der Frist" : "Testabfrage gescheitert",
      );
    } catch (e) {
      log(`[sprachagent] Entwurf ${record.id}: Anlegen gescheitert (${errorName(e)})`);
      const why = e instanceof VoiceAgentError ? e.message : "Fehler beim Anlegen, Details im Log";
      if (record.uebernommen) return interrupt(record, why).catch(() => {});
      await write({ ...record, phase: "abgebrochen", grund: "Anlegen gescheitert", choiceId: undefined }).catch(() => {});
      await say(record.conversation, `${kennung} nicht angelegt: ${why}`, `zu Entwurf ${record.id}`);
    }
  }

  function runApply(record: DraftRecord): void {
    const job = apply(record).finally(() => applying.delete(job));
    applying.add(job);
  }

  // --- Handler ----------------------------------------------------------------------------

  const steps = Object.values(DRAFT_STEP) as readonly string[];

  const handler: ChoiceHandler = async (choice) => {
    const id = choice.ref;
    const key = choice.result?.key;
    if (!id || !DRAFT_ID_PATTERN.test(id) || !key || !choice.action || !steps.includes(choice.action)) throw new Error("Entwurfs-Frage ohne Bezug oder Ergebnis");
    let toApply: DraftRecord | null = null;
    await locked(id, async () => {
      const record = await read(id);
      const expectedPhase: Record<string, DraftPhase> = { stimme: "stimme", freigabe: "freigabe", freischalten: "durchgefallen", fortsetzen: "unterbrochen" };
      if (!record || record.choiceId !== choice.id || record.phase !== expectedPhase[choice.action!]) {
        await say(choice.conversation, DRAFT_TEXT.notOpen, `zu ${choice.id}`);
        return;
      }
      const kennung = record.rezept!.kennung;
      switch (choice.action) {
        case DRAFT_STEP.voice: {
          let gewaehlt: { voiceId: string; name: string } | undefined;
          if (key === DRAFT_KEYS.standardVoice) {
            // Die Standardstimme von jetzt, eingefroren: ersetzt auch eine bisherige Stimme
            const standard = standardVoice();
            if (standard) gewaehlt = { voiceId: standard, name: DRAFT_TEXT.standardVoice };
          } else {
            const pick = record.stimme?.vorschlaege[Number(key.slice(1))];
            if (!/^s[0-2]$/.test(key) || !pick) throw new Error("unbekannte Antwort");
            gewaehlt = { voiceId: pick.voiceId, name: pick.name };
          }
          const rezept = withVoice(record.rezept!, gewaehlt?.voiceId ?? null);
          // Erst die Ablage, dann die Steuerdaten: Ein Neustart dazwischen fragt erneut
          await writeAblageRecipe(rezept);
          const { gewaehlt: _old, ...stimme } = record.stimme!;
          const next = await write({ ...record, rezept, rezeptHash: recipeHash(rezept), phase: "freigabe", choiceId: undefined, stimme: { ...stimme, ...(gewaehlt ? { gewaehlt } : {}) } });
          await offerApproval(next);
          return;
        }
        case DRAFT_STEP.approve:
        case DRAFT_STEP.retry: {
          if (key === DRAFT_KEYS.discard) {
            await write({ ...record, phase: "verworfen", choiceId: undefined });
            log(`[sprachagent] Entwurf ${id}: verworfen`);
            await say(choice.conversation, record.uebernommen ? `Entwurf verworfen. ${kennung} bleibt in der übernommenen Fassung gespeichert, aber gesperrt.` : DRAFT_TEXT.discarded, `zu ${choice.id}`);
            return;
          }
          if (key !== (choice.action === DRAFT_STEP.approve ? DRAFT_KEYS.create : DRAFT_KEYS.retry)) throw new Error("unbekannte Antwort");
          toApply = await write({ ...record, phase: "anlegen", choiceId: undefined });
          await say(choice.conversation, DRAFT_TEXT.creating(kennung), `zu ${choice.id}`);
          return;
        }
        case DRAFT_STEP.unlock: {
          if (key === DRAFT_KEYS.keepLocked) {
            await write({ ...record, phase: "fertig", choiceId: undefined });
            await say(choice.conversation, DRAFT_TEXT.keptLocked(kennung), `zu ${choice.id}`);
            return;
          }
          if (key !== DRAFT_KEYS.unlock || !record.testlauf) throw new Error("unbekannte Antwort");
          // Zwischen Testlauf und Klick kann der Agent beim Anbieter von Hand geändert worden sein
          const moved = await testedStandProblem(deps.layer(), kennung, record.testlauf);
          if (moved) {
            await write({ ...record, phase: "fertig", choiceId: undefined });
            log(`[sprachagent] Entwurf ${id}: trotzdem freischalten abgelehnt, Stand beim Anbieter`);
            await say(choice.conversation, DRAFT_TEXT.unlockRefused(kennung, moved), `zu ${choice.id}`);
            return;
          }
          // Ohne festgehaltenes Wissen (Entwurf von vorher) ist unbekannt, was getestet wurde
          const { wissenHash } = record.testlauf;
          const outcome =
            wissenHash === undefined
              ? ({ status: "veraltet" } as const)
              : await writeUnlock(kennung, { hash: record.testlauf.hash, version: record.testlauf.version, wissenHash, grund: "trotzdem", testlauf: record.testlauf.runId }, paths, now);
          await write({ ...record, phase: "fertig", choiceId: undefined });
          log(`[sprachagent] Entwurf ${id}: trotzdem freischalten, ${outcome.status}`);
          await say(choice.conversation, outcome.status === "freigeschaltet" ? DRAFT_TEXT.unlocked(kennung) : DRAFT_TEXT.unlockStale(kennung), `zu ${choice.id}`);
          return;
        }
      }
    });
    if (toApply) runApply(toApply);
  };

  // --- Takt und Neustart --------------------------------------------------------------------

  async function tick(): Promise<void> {
    for (const id of await listIds()) {
      try {
        const record = await read(id);
        if (record?.phase === "job") await advance(id);
        else if (record && (await questionLapsed(record))) {
          await locked(id, async () => {
            const current = await read(id);
            if (current && (await questionLapsed(current))) await expire(current);
          });
        }
      } catch (e) {
        log(`[sprachagent] Entwurf ${id}: Prüfung gescheitert (${errorName(e)})`);
      }
    }
  }

  /** Ist die Rückfrage des Entwurfs abgelaufen? Maßgeblich ist frist, sonst expiresAt der Rückfrage */
  async function questionLapsed(record: DraftRecord): Promise<boolean> {
    if (!QUESTION_PHASES.includes(record.phase)) return false;
    let frist = record.frist;
    if (frist === undefined && record.choiceId) frist = (await getChoice(record.choiceId))?.expiresAt;
    return frist !== undefined && now() >= frist;
  }

  /**
   * Abgelaufene Rückfrage: Die Knöpfe sind unbenutzbar, also endet der Entwurf
   * kontrolliert (abgebrochen). Das gibt die Kennung frei, nichts wird
   * freigeschaltet, und die Meldung nennt den Weg zurück.
   */
  async function expire(record: DraftRecord): Promise<void> {
    await write({ ...record, phase: "abgebrochen", grund: "Rueckfrage abgelaufen", choiceId: undefined });
    log(`[sprachagent] Entwurf ${record.id}: Rückfrage abgelaufen, beendet`);
    const kennung = record.rezept?.kennung ?? record.kennung ?? record.id;
    await say(record.conversation, DRAFT_TEXT.expired({ art: record.art, kennung, uebernommen: Boolean(record.uebernommen) }), `zu Entwurf ${record.id}`);
  }

  /**
   * Offene Rückfrage nach einem Neustart: fehlt sie (Neustart zwischen
   * Phasenwechsel und Eintrag) oder ist sie entschieden, ohne dass der Handler
   * die Phase weitergesetzt hat (Neustart zwischen Klick und Handler; choices.ts
   * ruft ihn nicht erneut auf), neu stellen; die alte desselben Entwurfs läuft
   * dabei ab. Ist sie offen, aber nicht zugestellt, erneut zustellen. Eine
   * abgelaufene beendet den Entwurf (expire), das prüft resume() vorher.
   */
  async function ensureQuestion(record: DraftRecord): Promise<void> {
    const choice = record.choiceId ? await getChoice(record.choiceId) : undefined;
    if (!choice || choice.state === "done") {
      await offerFor(record);
      log(`[sprachagent] Entwurf ${record.id}: Frage nach Neustart neu gestellt`);
      return;
    }
    if (choice.state === "open" && record.zugestellt !== choice.id && (await deliver(choice))) await write({ ...record, zugestellt: choice.id });
  }

  async function resume(): Promise<void> {
    for (const id of await listIds()) {
      try {
        await locked(id, async () => {
          const record = await read(id);
          if (!record) return;
          // Ein Anlegen, das dieser Prozess nicht mehr verfolgt: unterbrochen, nie freigeschaltet
          if (record.phase === "anlegen") return interrupt(record, DRAFT_TEXT.restartInterrupted);
          if (QUESTION_PHASES.includes(record.phase)) return (await questionLapsed(record)) ? expire(record) : ensureQuestion(record);
        });
      } catch (e) {
        log(`[sprachagent] Entwurf ${id}: Wiederaufnahme gescheitert (${errorName(e)})`);
      }
    }
    await tick();
  }

  function startPolling(intervalMs = DRAFT_POLL_MS): () => void {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      tick()
        .catch((e) => log(`[sprachagent] Entwürfe: Takt gescheitert (${errorName(e)})`))
        .finally(() => (busy = false));
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return {
    startNew,
    reserveWizard,
    startWizard,
    discardWizard,
    startChange,
    tick,
    resume,
    startPolling,
    handler,
    steps,
    read,
    workDir,
    controlDir,
    ablageDir,
    settled: async () => {
      while (applying.size) await Promise.all([...applying]);
    },
  };
}

/**
 * Ein Handler für die Art "sprachagent": Schritte der Entwürfe an den
 * Entwurfsdienst, alles andere (Löschen) an den Manager. Eine zweite Anmeldung
 * mit onChoiceDecided ersetzte sonst den Löschhandler.
 */
export function voiceAgentChoiceHandler(manager: ChoiceHandler, drafts: Pick<DraftService, "handler" | "steps">): ChoiceHandler {
  return (choice) => (choice.action && drafts.steps.includes(choice.action) ? drafts.handler(choice) : manager(choice));
}
