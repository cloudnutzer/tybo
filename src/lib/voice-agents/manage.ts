/**
 * Sprachagenten verwalten (Issue #492, Entscheidung 0026): was /sprachagent
 * braucht, ohne Sprachmodell. Übersicht der Rezepte, Testlauf beim Anbieter mit
 * Ergebnis ins Gespräch, Löschen über eine Rückfrage (Art "sprachagent") und der
 * Web-Link auf die Gesprächsseite /sa/<kennung> (Issue #494), nur mit
 * eingeschaltetem Web-Zugang und Freischaltung.
 *
 * - Testläufe: data/voice-agents/<kennung>/testlauf.json, der letzte unter
 *   „letzter“, die davor (neueste zuerst, zusammen höchstens
 *   VOICE_AGENT_TEST_HISTORY) unter „frueher“. Ältere Dateien ohne „frueher“
 *   bleiben gültig. Ein Lauf, den dieser Prozess nicht mehr verfolgt
 *   (Neustart), gilt als „nicht abgeholt“.
 * - Verbrauch im Monat: tybo erfasst ihn noch nicht. Die Übersicht nennt ihn
 *   unbekannt, nie 0; bekannt ist nur das Limit aus zugang.budget.minutenMonat.
 * - Löschen: Erst die Sprachschicht (remove, mit eigener Sperre), dann unter der
 *   Sperre der Kennung das Rezept nach data/voice-agents/<kennung>/geloescht/.
 *   Scheitert der Anbieter, bleibt das Rezept. Ein Archiv wird nie überschrieben,
 *   jeder Versuch bekommt eine eigene Datei. Einem symbolischen Link folgt nichts.
 *
 * Die Rückfrage trägt ihren Schritt dauerhaft in Choice.action ("loeschen"),
 * damit spätere Schritte (SA1-5, SA2-4, SA4) dieselbe Art nutzen können.
 * Ins Log kommen nur Kennung, Schritt und Fehlerklasse.
 */
import { randomUUID } from "node:crypto";
import { link as linkFile, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { atomicWriteFile } from "../atomic-file";
import {
  createChoice as realCreateChoice,
  expireChoice as realExpireChoice,
  type Choice,
  type ChoiceConversation,
  type ChoiceHandler,
  type CreateChoiceInput,
  type CreateChoiceOptions,
  type ExpireOutcome,
} from "../choices";
import type { PostWeb } from "../review-choices";
import {
  agentDataDir,
  agentsDataRoot,
  assertFileOrMissing,
  ensureRealDirs,
  isValidKennung,
  readRegularFile,
  realDirsExist,
  recipePath,
  recipesDir,
  VoiceAgentError,
  type VoiceAgentPaths,
} from "./base";
import { parseLayerState, type TestOutcome, type TestRunResult, type VoiceLayer, type VoiceLayerState } from "./layer";
import { loadRecipe, loadRecipes, type Recipe } from "./recipe";
import { readState, withAgentLock } from "./state";
import { isUnlocked } from "./unlock";

/** source der Fragen und Meldungen, wie CHOICE_SOURCES.sprachagent */
export const VOICE_AGENT_SOURCE = "sprachagent";
export const VOICE_AGENT_STEP_DELETE = "loeschen";
export const VOICE_AGENT_YES = "ja";
export const VOICE_AGENT_NO = "nein";
/** Die Rückfrage zum Löschen gilt einen Tag */
export const VOICE_AGENT_CONFIRM_TTL_MS = 24 * 3_600_000;
const ARCHIVE_ATTEMPTS = 20;

export type StoredTestStatus = "bestanden" | "durchgefallen" | "abgebrochen" | "zeitueberschreitung" | "fehler";

/** Ein abgeschlossener Testlauf, wie er in testlauf.json steht */
export interface StoredTestRun {
  runId?: string;
  gestartetAm: string;
  beendetAm: string;
  ergebnis: StoredTestStatus;
  tests: Pick<TestOutcome, "name" | "status" | "kriterium">[];
  /** Fehler oder letzter Grund bei Zeitüberschreitung, ohne Schlüssel (die Sprachschicht filtert) */
  grund?: string;
}

interface TestFile {
  laufend?: { runId: string; gestartetAm: string };
  letzter?: StoredTestRun;
  /** Abgeschlossene Läufe vor dem letzten, neueste zuerst (Issue #495) */
  frueher?: StoredTestRun[];
}

/** So viele abgeschlossene Testläufe behält testlauf.json, den letzten mitgezählt */
export const VOICE_AGENT_TEST_HISTORY = 5;

/** Neuer letzter Lauf; der bisherige rückt nach „frueher“, die ältesten fallen weg */
function withNewRun(previous: TestFile, run: StoredTestRun): TestFile {
  const older = [previous.letzter, ...(previous.frueher ?? [])].filter((r): r is StoredTestRun => Boolean(r)).slice(0, VOICE_AGENT_TEST_HISTORY - 1);
  return older.length > 0 ? { letzter: run, frueher: older } : { letzter: run };
}

export interface VoiceAgentEntry {
  kennung: string;
  name: string;
  vorlage: Recipe["vorlage"];
  gehirn: Recipe["gehirn"];
  gedaechtnis: Recipe["gedaechtnis"];
  web: boolean;
  /** nummer ist die Kennung der Nummer beim Anbieter, keine Rufnummer */
  telefon?: { nummer: string; anrufer: "alle" | "freigegeben" };
  /** true: beim Anbieter angelegt (state.agentId) */
  angelegt: boolean;
  letzterTest: StoredTestRun | null;
  /** Abgeschlossene Läufe vor dem letzten, neueste zuerst; fehlt bei Einträgen ohne Historie */
  fruehereTests?: StoredTestRun[];
  /** Läuft in diesem Prozess gerade (seit), oder wurde nicht abgeholt */
  laufenderTest: { gestartetAm: string; verfolgt: boolean } | null;
  /** verbraucht ist null: tybo erfasst den Verbrauch noch nicht */
  minuten: { limit: number; verbraucht: number | null };
  /** Zustand oder Testlauf nicht lesbar; die übrigen Angaben stammen aus dem Rezept */
  problem?: string;
}

export interface VoiceAgentOverview {
  agents: VoiceAgentEntry[];
  /** Rezepte, die die Prüfung nicht bestehen */
  fehler: { datei: string; fehler: string[] }[];
}

export type StartTestOutcome =
  | { status: "gestartet"; name: string }
  | { status: "unbekannt" }
  /** Anbieter nicht eingerichtet (ELEVENLABS_API_KEY fehlt) */
  | { status: "kein_anbieter" }
  | { status: "nicht_angelegt"; name: string }
  | { status: "laeuft"; name: string; seit: string }
  | { status: "fehler"; name: string; fehler: string };

export type OfferDeleteOutcome = { status: "gefragt"; name: string } | { status: "unbekannt" } | { status: "nicht_zugestellt" };

export type LinkOutcome =
  | { status: "unbekannt" }
  /** zugang.web.link ist aus */
  | { status: "kein_web"; name: string }
  /** Rezept beschädigt: kein Link */
  | { status: "kaputt"; name: string }
  /** Nicht freigeschaltet (Tests nicht bestanden, Rezept oder Wissen geändert) */
  | { status: "gesperrt"; name: string }
  /** WebUI aus: keine Adresse */
  | { status: "keine_webui"; name: string }
  | { status: "link"; name: string; url: string };

/** Pfad der Gesprächsseite in der WebUI (src/web/voice-agent-page.ts) */
export function voiceAgentPagePath(kennung: string): string {
  return `/sa/${kennung}`;
}

export type DeleteOutcome =
  | { status: "geloescht"; archiv: string }
  /** Rezept schon weg (gelöscht oder von Hand entfernt) */
  | { status: "weg" }
  | { status: "kein_anbieter" }
  | { status: "anbieter_fehler"; fehler: string }
  /** Zwischen Anbieter und Archiv wurde der Agent wieder angelegt */
  | { status: "neu_angelegt" }
  | { status: "archiv_fehler"; fehler: string };

export const VOICE_AGENT_TEXT = {
  confirmDelete: (name: string, kennung: string) =>
    `🗑️ Sprachagent ${name} (${kennung}) löschen? Agent und Tests beim Anbieter werden gelöscht, das Rezept kommt ins Archiv data/voice-agents/${kennung}/geloescht/.`,
  yes: "Ja, löschen",
  no: "Abbrechen",
  cancelled: (kennung: string) => `Abgebrochen, ${kennung} bleibt, wie er ist.`,
  retry: (kennung: string) => `Erneut versuchen: /sprachagent loeschen ${kennung}`,
  deleted: (kennung: string, archiv: string) => `🗑️ ${kennung} gelöscht: Agent und Tests beim Anbieter sind weg, das Rezept liegt in ${archiv}.`,
  gone: (kennung: string) => `${kennung} gibt es nicht mehr, nichts gelöscht.`,
  noProvider: (kennung: string) => `${kennung} nicht gelöscht: Der Anbieter ist nicht eingerichtet (ELEVENLABS_API_KEY fehlt). Das Rezept bleibt.`,
  providerFailed: (kennung: string, fehler: string) => `${kennung} nicht gelöscht, der Anbieter meldet: ${fehler}. Das Rezept bleibt; was schon gelöscht war, bleibt gelöscht.`,
  redeployed: (kennung: string) => `${kennung} wurde inzwischen beim Anbieter neu angelegt. Das Rezept bleibt.`,
  archiveFailed: (kennung: string, fehler: string) => `${kennung}: beim Anbieter gelöscht, das Rezept ließ sich aber nicht archivieren (${fehler}). Es steht noch in config/voice-agents/.`,
  failed: (kennung: string) => `Das Löschen von ${kennung} ist fehlgeschlagen, Details im Log. Das Rezept bleibt.`,
} as const;

const STATUS_MARK: Record<TestOutcome["status"], string> = { bestanden: "✅", durchgefallen: "❌", abgebrochen: "⏹️", offen: "⏳" };
const STATUS_WORD: Record<TestOutcome["status"], string> = { bestanden: "bestanden", durchgefallen: "durchgefallen", abgebrochen: "abgebrochen", offen: "noch offen" };

/** Kurzform „bestanden x von y“ für Übersicht und Meldung */
export function passedSummary(run: Pick<StoredTestRun, "tests">): string {
  const passed = run.tests.filter((t) => t.status === "bestanden").length;
  return `bestanden ${passed} von ${run.tests.length}`;
}

function testLines(tests: StoredTestRun["tests"]): string[] {
  return tests.map((test) => {
    if (test.status !== "durchgefallen") return `${STATUS_MARK[test.status]} ${test.name}: ${STATUS_WORD[test.status]}`;
    return `${STATUS_MARK.durchgefallen} ${test.name}: durchgefallen, ${test.kriterium ? `verfehlt: ${test.kriterium}` : "der Anbieter nennt keine Begründung"}`;
  });
}

/** Meldung nach einem Testlauf, auch bei Fehler und Zeitüberschreitung */
export function formatTestRun(name: string, kennung: string, run: StoredTestRun): string {
  const head = `🧪 Testlauf ${name} (${kennung})`;
  switch (run.ergebnis) {
    case "fehler":
      return `${head}: Abfrage gescheitert${run.grund ? `: ${run.grund}` : ""}. Kein Ergebnis.`;
    case "zeitueberschreitung":
      return [
        `${head}: kein Ergebnis innerhalb der Frist. Die Tests können beim Anbieter weiterlaufen.${run.grund ? ` Letzter Fehler: ${run.grund}` : ""}`,
        ...(run.tests.length > 0 ? ["Stand bis dahin:", ...testLines(run.tests)] : []),
      ].join("\n");
    default:
      return [`${head}: ${run.ergebnis}, ${passedSummary(run)}.`, ...testLines(run.tests)].join("\n");
  }
}

type Log = (line: string) => void;
const defaultLog: Log = (line) => console.log(line);
const errorName = (e: unknown) => (e instanceof Error ? e.name : "Fehler");
const errorText = (e: unknown) => (e instanceof VoiceAgentError ? e.message : errorName(e));

export interface VoiceAgentManagerDeps {
  /** Sprachschicht; null, wenn der Anbieter nicht eingerichtet ist */
  layer(): VoiceLayer | null;
  paths?: VoiceAgentPaths;
  /** Frage zeigen: in Telegram mit Knöpfen bzw. ohne Telegram für die WebUI festgehalten */
  sendChoice(choice: Choice): Promise<{ sent: boolean }>;
  /** Frage in ein reines Web-Gespräch legen */
  postWeb?: PostWeb;
  /** Meldung ins Gespräch (Ergebnis eines Testlaufs, Ausgang des Löschens); darf werfen, geloggt wird hier */
  notify(conversation: ChoiceConversation, text: string): Promise<void>;
  createChoice?(input: CreateChoiceInput, options?: CreateChoiceOptions): Promise<Choice>;
  expireChoice?(id: string): Promise<ExpireOutcome>;
  now?(): number;
  log?: Log;
  /**
   * Adresse der WebUI ohne Pfad (WEB_PUBLIC_ORIGIN oder http://<rechner>:<port>);
   * null, wenn die WebUI aus ist. Fehlt sie, gibt es keinen Link.
   */
  webBase?(): string | null;
  /** Für Tests: Freischaltung prüfen; Standard isUnlocked aus ./unlock */
  isUnlocked?(kennung: string): Promise<boolean>;
}

export interface VoiceAgentManager {
  overview(): Promise<VoiceAgentOverview>;
  /** Startet den Testlauf und meldet das Ergebnis später ins Gespräch */
  startTest(kennung: string, conversation: ChoiceConversation): Promise<StartTestOutcome>;
  /** Rückfrage zum Löschen ins Gespräch; gelöscht wird erst mit „Ja“ */
  offerDelete(kennung: string, conversation: ChoiceConversation): Promise<OfferDeleteOutcome>;
  link(kennung: string): Promise<LinkOutcome>;
  /** Löscht beim Anbieter und archiviert das Rezept (der Handler ruft das nach „Ja“) */
  deleteAgent(kennung: string): Promise<DeleteOutcome>;
  /** Handler der Art "sprachagent" (onChoiceDecided) */
  handler: ChoiceHandler;
  /** Für Tests: bis alle Testläufe gemeldet sind */
  settled(): Promise<void>;
}

export function createVoiceAgentManager(deps: VoiceAgentManagerDeps): VoiceAgentManager {
  const paths = deps.paths ?? {};
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? (() => Date.now());
  const create = deps.createChoice ?? realCreateChoice;
  const expire = deps.expireChoice ?? realExpireChoice;
  /** Testläufe, die dieser Prozess gerade verfolgt, je Kennung */
  const active = new Map<string, { gestartetAm: string; done: Promise<void> }>();
  const starting = new Set<string>();

  const testFile = (kennung: string) => join(agentDataDir(kennung, paths), "testlauf.json");
  const agentDirs = (kennung: string) => [agentsDataRoot(paths), agentDataDir(kennung, paths)];

  async function readTestFile(kennung: string): Promise<TestFile> {
    if (!(await realDirsExist(agentDirs(kennung)))) return {};
    const content = await readRegularFile(testFile(kennung));
    if (content === null) return {};
    let parsed: TestFile | null = null;
    try {
      parsed = parseTestFile(JSON.parse(content));
    } catch {
      // unten
    }
    if (parsed) return parsed;
    throw new VoiceAgentError(`Testlauf von ${kennung} ist beschädigt: ${testFile(kennung)}`);
  }

  async function writeTestFile(kennung: string, data: TestFile): Promise<void> {
    await ensureRealDirs(agentDirs(kennung));
    await assertFileOrMissing(testFile(kennung));
    await atomicWriteFile(testFile(kennung), JSON.stringify(data, null, 2) + "\n");
  }

  /** Rezept vorhanden (auch ein beschädigtes)? Ungültige Kennungen gibt es nie. */
  async function recipeExists(kennung: string): Promise<boolean> {
    if (!isValidKennung(kennung)) return false;
    if (!(await realDirsExist([recipesDir(paths)]))) return false;
    return (await readRegularFile(recipePath(kennung, paths))) !== null;
  }

  async function recipeName(kennung: string): Promise<string> {
    try {
      return (await loadRecipe(kennung, paths))?.name ?? kennung;
    } catch {
      return kennung;
    }
  }

  async function readLayerState(kennung: string): Promise<VoiceLayerState | null> {
    const state = await readState(kennung, paths);
    return state ? parseLayerState(state) : null;
  }

  async function entryFor(recipe: Recipe): Promise<VoiceAgentEntry> {
    const entry: VoiceAgentEntry = {
      kennung: recipe.kennung,
      name: recipe.name,
      vorlage: recipe.vorlage,
      gehirn: recipe.gehirn,
      gedaechtnis: recipe.gedaechtnis,
      web: recipe.zugang.web?.link === true,
      ...(recipe.zugang.telefon ? { telefon: { nummer: recipe.zugang.telefon.nummer, anrufer: recipe.zugang.telefon.anrufer } } : {}),
      angelegt: false,
      letzterTest: null,
      laufenderTest: null,
      minuten: { limit: recipe.zugang.budget.minutenMonat, verbraucht: null },
    };
    const problems: string[] = [];
    try {
      entry.angelegt = Boolean((await readLayerState(recipe.kennung))?.agentId);
    } catch (e) {
      problems.push(`Zustand nicht lesbar (${errorText(e)})`);
    }
    try {
      const file = await readTestFile(recipe.kennung);
      entry.letzterTest = file.letzter ?? null;
      entry.fruehereTests = file.frueher ?? [];
      const tracked = active.get(recipe.kennung);
      if (tracked) entry.laufenderTest = { gestartetAm: tracked.gestartetAm, verfolgt: true };
      else if (file.laufend) entry.laufenderTest = { gestartetAm: file.laufend.gestartetAm, verfolgt: false };
    } catch (e) {
      problems.push(`Testlauf nicht lesbar (${errorText(e)})`);
    }
    if (problems.length > 0) entry.problem = problems.join("; ");
    return entry;
  }

  async function overview(): Promise<VoiceAgentOverview> {
    const loaded = await loadRecipes(paths);
    const agents: VoiceAgentEntry[] = [];
    for (const recipe of loaded.recipes) agents.push(await entryFor(recipe));
    return { agents, fehler: loaded.fehler };
  }

  async function say(conversation: ChoiceConversation, text: string, what: string): Promise<void> {
    try {
      await deps.notify(conversation, text);
    } catch (e) {
      log(`[sprachagent] Meldung ${what} nicht zugestellt (${errorName(e)})`);
    }
  }

  async function follow(kennung: string, name: string, runId: string, gestartetAm: string, layer: VoiceLayer, conversation: ChoiceConversation): Promise<void> {
    let result: TestRunResult;
    try {
      result = await layer.testResult(runId);
    } catch (e) {
      log(`[sprachagent] ${kennung} testen: Abfrage geworfen (${errorName(e)})`);
      result = { status: "fehler", fehler: "Interner Fehler bei der Abfrage", vorlaeufig: false };
    }
    const beendetAm = new Date(now()).toISOString();
    const run = toStoredRun(runId, gestartetAm, beendetAm, result);
    try {
      // Eine unlesbare Datei ersetzt der neue Lauf wie bisher, dann ohne Historie
      const previous = await readTestFile(kennung).catch(() => ({}) as TestFile);
      await writeTestFile(kennung, withNewRun(previous, run));
    } catch (e) {
      log(`[sprachagent] ${kennung} testen: Ergebnis nicht gespeichert (${errorName(e)})`);
    }
    log(`[sprachagent] ${kennung} testen: ${run.ergebnis}`);
    await say(conversation, formatTestRun(name, kennung, run), `zu ${kennung}`);
  }

  async function startTest(kennung: string, conversation: ChoiceConversation): Promise<StartTestOutcome> {
    if (!(await recipeExists(kennung))) return { status: "unbekannt" };
    const name = await recipeName(kennung);
    const layer = deps.layer();
    if (!layer) return { status: "kein_anbieter" };
    const running = active.get(kennung);
    if (running) return { status: "laeuft", name, seit: running.gestartetAm };
    if (starting.has(kennung)) return { status: "laeuft", name, seit: new Date(now()).toISOString() };
    starting.add(kennung);
    try {
      let state: VoiceLayerState | null;
      try {
        state = await readLayerState(kennung);
      } catch (e) {
        return { status: "fehler", name, fehler: errorText(e) };
      }
      if (!state?.agentId) return { status: "nicht_angelegt", name };
      const started = await layer.runTests({ ...state, kennung });
      if (started.status !== "gestartet") return { status: "fehler", name, fehler: started.fehler };
      const gestartetAm = new Date(now()).toISOString();
      try {
        const previous = await readTestFile(kennung).catch(() => ({}) as TestFile);
        await writeTestFile(kennung, { ...previous, laufend: { runId: started.runId, gestartetAm } });
      } catch (e) {
        log(`[sprachagent] ${kennung} testen: Lauf nicht vermerkt (${errorName(e)})`);
      }
      log(`[sprachagent] ${kennung} testen: gestartet`);
      const done = follow(kennung, name, started.runId, gestartetAm, layer, conversation).finally(() => active.delete(kennung));
      active.set(kennung, { gestartetAm, done });
      return { status: "gestartet", name };
    } finally {
      starting.delete(kennung);
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

  async function offerDelete(kennung: string, conversation: ChoiceConversation): Promise<OfferDeleteOutcome> {
    if (!(await recipeExists(kennung))) return { status: "unbekannt" };
    const name = await recipeName(kennung);
    const choice = await create(
      {
        kind: "sprachagent",
        conversation,
        text: VOICE_AGENT_TEXT.confirmDelete(name, kennung),
        options: [
          { key: VOICE_AGENT_YES, label: VOICE_AGENT_TEXT.yes },
          { key: VOICE_AGENT_NO, label: VOICE_AGENT_TEXT.no },
        ],
        ref: kennung,
        action: VOICE_AGENT_STEP_DELETE,
        expiresAt: now() + VOICE_AGENT_CONFIRM_TTL_MS,
      },
      // Höchstens eine offene Rückfrage je Kennung: eine ältere läuft ab
      { replace: (c) => c.kind === "sprachagent" && c.action === VOICE_AGENT_STEP_DELETE && c.ref === kennung },
    );
    if (await deliver(choice)) return { status: "gefragt", name };
    log(`[sprachagent] Frage ${choice.id} nirgends zugestellt, abgelaufen`);
    await Promise.resolve(expire(choice.id)).catch(() => {});
    return { status: "nicht_zugestellt" };
  }

  async function link(kennung: string): Promise<LinkOutcome> {
    if (!(await recipeExists(kennung))) return { status: "unbekannt" };
    let recipe: Recipe | null = null;
    try {
      recipe = await loadRecipe(kennung, paths);
    } catch {
      // Ein beschädigtes Rezept hat keinen Link, aus dem sich etwas ablesen ließe
    }
    const name = recipe?.name ?? kennung;
    if (!recipe) return { status: "kaputt", name };
    if (recipe.zugang.web?.link !== true) return { status: "kein_web", name };
    if (!(await (deps.isUnlocked ?? ((k: string) => isUnlocked(k, paths)))(kennung))) return { status: "gesperrt", name };
    const base = deps.webBase?.() ?? null;
    if (!base) return { status: "keine_webui", name };
    return { status: "link", name, url: `${base.replace(/\/+$/, "")}${voiceAgentPagePath(kennung)}` };
  }

  /** Noch etwas beim Anbieter? */
  function atProvider(state: VoiceLayerState | null): boolean {
    if (!state) return false;
    return Boolean(state.agentId || state.ersetzterAgentId || state.brueckenGeheimnisId || Object.keys(state.tests ?? {}).length > 0);
  }

  /** Verschiebt das Rezept ins Archiv, ohne ein vorhandenes zu überschreiben; null, wenn es kein Rezept mehr gibt */
  async function archiveRecipe(kennung: string): Promise<string | null> {
    if (!(await realDirsExist([recipesDir(paths)]))) return null;
    const source = recipePath(kennung, paths);
    const content = await readRegularFile(source);
    if (content === null) return null;
    const dir = join(agentDataDir(kennung, paths), "geloescht");
    await ensureRealDirs([...agentDirs(kennung), dir]);
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
    const temp = join(dir, `.${randomUUID()}.tmp`);
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    try {
      for (let attempt = 0; attempt < ARCHIVE_ATTEMPTS; attempt++) {
        const target = join(dir, attempt === 0 ? `${stamp}.json` : `${stamp}-${attempt + 1}.json`);
        try {
          // link legt nur neu an: Ein vorhandenes Archiv bleibt unberührt
          await linkFile(temp, target);
        } catch (e: any) {
          if (e?.code === "EEXIST") continue;
          throw e;
        }
        await unlink(source);
        return target;
      }
      throw new VoiceAgentError(`Kein freier Name im Archiv ${dir}`);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  function shownPath(path: string): string {
    const root = join(agentsDataRoot(paths), "..", "..");
    const rel = relative(root, path);
    return rel.startsWith("..") ? path : rel;
  }

  async function deleteAgent(kennung: string): Promise<DeleteOutcome> {
    if (!(await recipeExists(kennung))) return { status: "weg" };
    const state = await readLayerState(kennung);
    if (atProvider(state)) {
      const layer = deps.layer();
      if (!layer) return { status: "kein_anbieter" };
      // remove sperrt selbst; eine äußere Sperre gleicher Art würde sich blockieren
      const removed = await layer.remove({ ...state!, kennung });
      if (removed.status !== "ok") return { status: "anbieter_fehler", fehler: removed.fehler };
    }
    try {
      return await withAgentLock(kennung, paths, async (): Promise<DeleteOutcome> => {
        // Unter der Sperre: Ein Abgleich dazwischen hätte den Agenten wieder angelegt
        if (atProvider(await readLayerState(kennung))) return { status: "neu_angelegt" };
        const archived = await archiveRecipe(kennung);
        return archived ? { status: "geloescht", archiv: shownPath(archived) } : { status: "weg" };
      });
    } catch (e) {
      log(`[sprachagent] ${kennung} loeschen: Archiv gescheitert (${errorName(e)})`);
      return { status: "archiv_fehler", fehler: errorText(e) };
    }
  }

  function deleteText(kennung: string, outcome: DeleteOutcome): string {
    const retry = `\n${VOICE_AGENT_TEXT.retry(kennung)}`;
    switch (outcome.status) {
      case "geloescht":
        return VOICE_AGENT_TEXT.deleted(kennung, outcome.archiv);
      case "weg":
        return VOICE_AGENT_TEXT.gone(kennung);
      case "kein_anbieter":
        return VOICE_AGENT_TEXT.noProvider(kennung);
      case "anbieter_fehler":
        return VOICE_AGENT_TEXT.providerFailed(kennung, outcome.fehler) + retry;
      case "neu_angelegt":
        return VOICE_AGENT_TEXT.redeployed(kennung) + retry;
      case "archiv_fehler":
        return VOICE_AGENT_TEXT.archiveFailed(kennung, outcome.fehler) + retry;
    }
  }

  const handler: ChoiceHandler = async (choice) => {
    const kennung = choice.ref;
    const key = choice.result?.key;
    if (!kennung || !isValidKennung(kennung) || !key) throw new Error("Sprachagent-Frage ohne Kennung oder Ergebnis");
    if (choice.action !== VOICE_AGENT_STEP_DELETE) throw new Error("unbekannter Schritt");
    if (key === VOICE_AGENT_NO) {
      await say(choice.conversation, VOICE_AGENT_TEXT.cancelled(kennung), `zu ${choice.id}`);
      return;
    }
    if (key !== VOICE_AGENT_YES) throw new Error("unbekannte Antwort");
    let outcome: DeleteOutcome;
    try {
      outcome = await deleteAgent(kennung);
    } catch (e) {
      log(`[sprachagent] ${kennung} loeschen: gescheitert (${errorName(e)})`);
      await say(choice.conversation, VOICE_AGENT_TEXT.failed(kennung) + `\n${VOICE_AGENT_TEXT.retry(kennung)}`, `zu ${choice.id}`);
      throw e;
    }
    log(`[sprachagent] ${kennung} loeschen: ${outcome.status}`);
    await say(choice.conversation, deleteText(kennung, outcome), `zu ${choice.id}`);
  };

  return {
    overview,
    startTest,
    offerDelete,
    link,
    deleteAgent,
    handler,
    settled: async () => {
      await Promise.all([...active.values()].map((run) => run.done));
    },
  };
}

/**
 * Ergebnis eines Testlaufs ablegen, den nicht der Manager gestartet hat (Anlegen
 * eines Entwurfs, Issue #493), damit /sprachagent liste es zeigt.
 */
export async function storeTestRun(kennung: string, run: StoredTestRun, paths: VoiceAgentPaths = {}): Promise<void> {
  const dirs = [agentsDataRoot(paths), agentDataDir(kennung, paths)];
  const file = join(agentDataDir(kennung, paths), "testlauf.json");
  await ensureRealDirs(dirs);
  await assertFileOrMissing(file);
  let previous: TestFile = {};
  try {
    const content = await readRegularFile(file);
    previous = (content !== null && parseTestFile(JSON.parse(content))) || {};
  } catch {
    previous = {};
  }
  await atomicWriteFile(file, JSON.stringify(withNewRun(previous, run), null, 2) + "\n");
}

/**
 * Ein abgeschlossener Lauf aus testlauf.json, gesucht über seine runId im
 * letzten und in den früheren Läufen (Issue #515, Fortschritt des Wizards).
 * laufend: Der Lauf hat begonnen und ist noch nicht abgelegt. null: Es gibt
 * ihn nicht (mehr), die Datei fehlt oder ist beschädigt.
 */
export async function readTestRun(kennung: string, runId: string, paths: VoiceAgentPaths = {}): Promise<StoredTestRun | "laufend" | null> {
  try {
    if (!(await realDirsExist([agentsDataRoot(paths), agentDataDir(kennung, paths)]))) return null;
    const content = await readRegularFile(join(agentDataDir(kennung, paths), "testlauf.json"));
    const file = content === null ? null : parseTestFile(JSON.parse(content));
    if (!file) return null;
    const found = [file.letzter, ...(file.frueher ?? [])].find((r) => r?.runId === runId);
    if (found) return found;
    return file.laufend?.runId === runId ? "laufend" : null;
  } catch {
    return null;
  }
}

/** Wie der Manager einen Testlauf ablegt: Ergebnis des Anbieters in die gespeicherte Form */
export function toStoredRun(runId: string, gestartetAm: string, beendetAm: string, result: TestRunResult): StoredTestRun {
  return result.status === "fertig"
    ? { runId, gestartetAm, beendetAm, ergebnis: result.gesamt, tests: result.tests.map(strip) }
    : result.status === "zeitueberschreitung"
      ? { runId, gestartetAm, beendetAm, ergebnis: "zeitueberschreitung", tests: result.tests.map(strip), ...(result.grund ? { grund: result.grund } : {}) }
      : { runId, gestartetAm, beendetAm, ergebnis: "fehler", tests: [], grund: result.fehler };
}

const STORED_STATUSES: readonly string[] = ["bestanden", "durchgefallen", "abgebrochen", "zeitueberschreitung", "fehler"] satisfies StoredTestStatus[];
const OUTCOME_STATUSES: readonly string[] = Object.keys(STATUS_MARK);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isOptionalString = (value: unknown) => value === undefined || typeof value === "string";

function isStoredTest(value: unknown): value is StoredTestRun["tests"][number] {
  return isObject(value) && typeof value.name === "string" && OUTCOME_STATUSES.includes(value.status as string) && isOptionalString(value.kriterium);
}

function isStoredRun(value: unknown): value is StoredTestRun {
  return (
    isObject(value) &&
    isOptionalString(value.runId) &&
    typeof value.gestartetAm === "string" &&
    typeof value.beendetAm === "string" &&
    STORED_STATUSES.includes(value.ergebnis as string) &&
    Array.isArray(value.tests) &&
    value.tests.every(isStoredTest) &&
    isOptionalString(value.grund)
  );
}

/**
 * testlauf.json prüfen, bevor etwas daraus gelesen wird: Eine syntaktisch gültige,
 * aber anders gebaute Datei ergibt null (beschädigt), nie einen halben Eintrag.
 */
function parseTestFile(raw: unknown): TestFile | null {
  if (!isObject(raw)) return null;
  const { laufend, letzter, frueher } = raw;
  if (laufend !== undefined && !(isObject(laufend) && typeof laufend.runId === "string" && typeof laufend.gestartetAm === "string")) return null;
  if (letzter !== undefined && !isStoredRun(letzter)) return null;
  if (frueher !== undefined && !(Array.isArray(frueher) && frueher.every(isStoredRun))) return null;
  return {
    ...(laufend !== undefined ? { laufend: { runId: laufend.runId as string, gestartetAm: laufend.gestartetAm as string } } : {}),
    ...(letzter !== undefined ? { letzter } : {}),
    ...(frueher !== undefined ? { frueher: (frueher as StoredTestRun[]).slice(0, VOICE_AGENT_TEST_HISTORY - 1) } : {}),
  };
}

function strip(test: TestOutcome): StoredTestRun["tests"][number] {
  return { name: test.name, status: test.status, ...(test.kriterium ? { kriterium: test.kriterium } : {}) };
}
