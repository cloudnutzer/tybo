/**
 * Einmalige Bereinigung der Fakten per Knopf (Issue #520). `tybo gedaechtnis
 * bereinigen --datei <pfad>` liest eine lokale Liste, prüft sie und legt sie
 * über das Rückfragen-Register (Art "cleanup") vor: klare Fälle als ein Paket,
 * umzuschreibende in Gruppen von höchstens REWRITE_GROUP_MAX. Ohne Bestätigung
 * ändert sich nichts.
 *
 * Eine Liste ist ein JSON-Feld mit Einträgen:
 *   kennung      ID des Fakts in memory
 *   einstufung   doppelt, ueberholt (beide: archivieren) oder umschreiben
 *   begruendung  warum, steht in der Frage
 *   originaltext oder originalhash (SHA-256 des Texts, hex): der erwartete Stand
 *   neuer_text   Pflicht bei umschreiben, sonst verboten
 * Eine fehlerhafte Liste wird ganz abgelehnt; die Meldungen nennen nur Stelle
 * und Feld, nie Inhalte. Ein neuer Text mit Geheimnis gilt als Fehler (Issue #524).
 *
 * Vermerk data/gedaechtnis-bereinigung.json (unter Sperre, Bot und Befehl sind
 * eigene Prozesse): die Einträge mit Text und Stand, dazu die Gruppen. Je Fakt
 * und Text höchstens einmal: Ein wiederholter Aufruf fragt nichts doppelt, nur
 * eine Gruppe, deren Frage abgelaufen ist, und gescheiterte Einträge kommen
 * wieder. Verworfenes kommt nicht wieder.
 *
 * Ablauf: Offen ist immer nur eine Gruppe, die nächste kommt nach der
 * Entscheidung, damit ihre Frist erst dann beginnt. Ein Klick entscheidet genau
 * eine Frage (decideChoice). „Liste zeigen“ und Ausnahmen wählen führen zu einer
 * neuen Frage derselben Gruppe, nur „Alle …“ und „Verwerfen“ schließen sie ab.
 * Die Gruppe wählen und ihre Frage anlegen ist ein Schritt unter der Sperre des
 * Vermerks, so entsteht auch bei gleichzeitigen Aufrufen genau eine aktuelle
 * Frage. Versendet wird außerhalb der Sperre; ein Versandfehler nimmt nur die
 * Frage zurück, die noch die aktuelle ist.
 * Der Handler einer entschiedenen Frage hält beim Start einen Anspruch an der
 * Gruppe (Token und PID, unter der Sperre). Solange sein Prozess lebt, gilt die
 * Gruppe als besetzt, egal wie lange er braucht; erneut vorgelegt wird sie erst,
 * wenn er seinen Anspruch aufgegeben hat oder sein Prozess tot ist. Ein Handler
 * ohne gültigen Anspruch bearbeitet keinen weiteren Eintrag und ändert keine Gruppe.
 * Geändert wird nach den IDs im Vermerk, je Fakt in einem Schritt gegen den
 * erwarteten Text (MemoryStore); ein Konflikt ändert nichts. Der Stand wird je
 * Eintrag festgehalten, ein Teilerfolg bleibt also richtig vermerkt.
 *
 * Grenzen: Eine laufende Session behält, was sie schon geladen hat, bis /new;
 * Umgeschriebenes und Zurückgeholtes bekommt sie über changedSince, Archiviertes
 * lässt sich dort nicht zurücknehmen. Ein laufendes Gespräch am Telefonhörer
 * behält seinen Prompt bis zum Auflegen. Alte Nachrichten im Verlauf bleiben, wie
 * sie sind.
 *
 * Ins Log kommen nur IDs und Zahlen, nie Texte von Fakten. Die Fragen zeigen
 * Geheimnisse maskiert (Issue #524), der Vermerk behält den Originaltext, gegen den
 * geändert wird.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../atomic-file";
import {
  CHOICE_MAX_AGE_MS,
  createChoice as realCreateChoice,
  expireChoice as realExpireChoice,
  getChoice as realGetChoice,
  type Choice,
  type ChoiceConversation,
  type ChoiceHandler,
  type ChoiceOption,
  type CreateChoiceInput,
} from "../choices";
import { acquireFileLock, pidAlive, releaseFileLock } from "../file-lock";
import { containsSecret, maskSecrets, secretRefusedText } from "./secrets";
import type { MemoryStore } from "../store/ports";
import type { FactChange } from "../store/types";

export const REWRITE_GROUP_MAX = 10;
/** So lange darf der Handler einer entschiedenen Frage brauchen, um seinen Anspruch anzumelden; danach zählt er nicht mehr */
const HANDLER_GRACE_MS = 10 * 60_000;
const SHOWN_PROBLEMS = 20;

export const CLEANUP_KEYS = { apply: "alle", list: "liste", exceptions: "ausnahmen", done: "fertig", discard: "verwerfen" } as const;
const TOGGLE_KEY = /^x(\d{1,4})$/;

const CLASSES = ["doppelt", "ueberholt", "umschreiben"] as const;
export type CleanupClass = (typeof CLASSES)[number];

export interface CleanupEntry {
  id: string;
  klass: CleanupClass;
  reason: string;
  /** Erwarteter Text oder seine Prüfsumme, mindestens eins von beiden */
  original?: string;
  originalHash?: string;
  /** Nur bei umschreiben */
  proposed?: string;
}

export type ItemState = "offen" | "ausnahme" | "erledigt" | "konflikt" | "fehler" | "verworfen" | "zurueckgeholt";

export interface LedgerItem {
  id: string;
  klass: CleanupClass;
  reason: string;
  /** Text bei der Vorlage: dagegen wird geprüft, damit lässt sich Umgeschriebenes zurückholen */
  original: string;
  proposed?: string;
  state: ItemState;
  /** Fortlaufend je erledigter Änderung: Zurückholen nimmt die jeweils letzte zurück */
  changeOrder?: number;
}

export interface LedgerGroup {
  id: string;
  type: "paket" | "umschreiben";
  conversation: ChoiceConversation;
  items: string[];
  state: "wartet" | "offen" | "fertig";
  choiceId?: string;
  /** Anspruch des Handlers, der gerade die Frage choiceId ausführt */
  handler?: { token: string; pid: number };
}

export interface Ledger {
  version: 1;
  items: Record<string, LedgerItem>;
  groups: LedgerGroup[];
}

export const factCleanupFile = (root: string) => join(root, "data", "gedaechtnis-bereinigung.json");

export const textHash = (text: string) => createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------------------
// Liste lesen
// ---------------------------------------------------------------------------

const filled = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Prüft die ganze Liste; bei Fehlern kein einziger Eintrag */
export function parseCleanupList(raw: string): { entries: CleanupEntry[] } | { problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { problems: ["Die Datei ist kein gültiges JSON."] };
  }
  if (!Array.isArray(parsed)) return { problems: ["Die Datei muss ein JSON-Feld mit Einträgen sein."] };
  const problems: string[] = [];
  const entries: CleanupEntry[] = [];
  const seen = new Set<string>();
  parsed.forEach((value: unknown, index) => {
    const where = `Eintrag ${index + 1}`;
    const before = problems.length;
    const e = (value ?? {}) as Record<string, unknown>;
    const id = typeof e.kennung === "number" && Number.isSafeInteger(e.kennung) ? String(e.kennung) : e.kennung;
    if (!filled(id)) problems.push(`${where}: kennung fehlt`);
    else if (seen.has(id)) problems.push(`${where}: kennung steht doppelt in der Liste`);
    if (!CLASSES.includes(e.einstufung as CleanupClass)) problems.push(`${where}: einstufung muss ${CLASSES.join(", ")} sein`);
    if (!filled(e.begruendung)) problems.push(`${where}: begruendung fehlt`);
    if (!filled(e.originaltext) && !filled(e.originalhash)) problems.push(`${where}: originaltext oder originalhash fehlt`);
    if (filled(e.originalhash) && !/^[0-9a-f]{64}$/.test(e.originalhash)) problems.push(`${where}: originalhash muss SHA-256 in Hex sein`);
    if (e.einstufung === "umschreiben") {
      if (!filled(e.neuer_text)) problems.push(`${where}: neuer_text ist bei umschreiben Pflicht`);
      else if (e.neuer_text === e.originaltext) problems.push(`${where}: neuer_text gleicht dem Originaltext`);
      else if (containsSecret(e.neuer_text)) problems.push(`${where}: neuer_text sieht nach einem Geheimnis aus, das gehört in die .env`);
    } else if (e.neuer_text !== undefined) {
      problems.push(`${where}: neuer_text gibt es nur bei umschreiben`);
    }
    if (problems.length > before) return;
    seen.add(id as string);
    entries.push({
      id: id as string,
      klass: e.einstufung as CleanupClass,
      reason: (e.begruendung as string).trim(),
      ...(filled(e.originaltext) ? { original: e.originaltext } : {}),
      ...(filled(e.originalhash) ? { originalHash: e.originalhash } : {}),
      ...(filled(e.neuer_text) ? { proposed: e.neuer_text } : {}),
    });
  });
  if (problems.length > SHOWN_PROBLEMS) return { problems: [...problems.slice(0, SHOWN_PROBLEMS), `… und ${problems.length - SHOWN_PROBLEMS} weitere`] };
  return problems.length > 0 ? { problems } : { entries };
}

// ---------------------------------------------------------------------------
// Vermerk
// ---------------------------------------------------------------------------

const emptyLedger = (): Ledger => ({ version: 1, items: {}, groups: [] });

/** Wirft, wenn der Vermerk nicht lesbar ist; überschrieben wird er dann nie */
export async function readLedger(file: string): Promise<Ledger> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return emptyLedger();
    throw e;
  }
  const parsed = JSON.parse(raw) as Partial<Ledger> | null;
  if (parsed?.version !== 1 || !parsed.items || !Array.isArray(parsed.groups)) throw new Error("Vermerk nicht lesbar");
  return parsed as Ledger;
}

async function updateLedger<T>(file: string, change: (ledger: Ledger) => T | Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  const lock = await acquireFileLock(lockFile);
  try {
    const ledger = await readLedger(file);
    const result = await change(ledger);
    await atomicWriteFile(file, JSON.stringify(ledger, null, 2));
    return result;
  } finally {
    await releaseFileLock(lockFile, lock).catch(() => {});
  }
}

const itemsOf = (ledger: Ledger, group: LedgerGroup) => group.items.map(key => ledger.items[key]).filter(Boolean);

// ---------------------------------------------------------------------------
// Fragen
// ---------------------------------------------------------------------------

export const CLEANUP_TEXT = {
  untouched: "Nichts ändert sich, bis du bestätigst.",
  stale: "Diese Frage gilt nicht mehr, nichts geändert.",
  discarded: "Verworfen, nichts geändert. Diese Vorschläge kommen nicht wieder.",
  undo: "Zurückholen: tybo gedaechtnis zurueckholen <Kennung>",
  session: "Laufende Sessions behalten bereits geladene Fakten bis /new.",
  nextFailed: "Die nächste Gruppe kam nicht an. Derselbe Befehl legt sie erneut vor: tybo gedaechtnis bereinigen --datei <Pfad>",
} as const;

const CLASS_LABEL: Record<CleanupClass, string> = { doppelt: "doppelt", ueberholt: "überholt", umschreiben: "teilweise überholt" };

const openCount = (items: LedgerItem[]) => items.filter(item => item.state === "offen").length;

function exceptionNote(items: LedgerItem[]): string[] {
  const numbers = items.flatMap((item, i) => (item.state === "ausnahme" ? [i + 1] : []));
  return numbers.length > 0 ? [`Ausnahmen, die unverändert bleiben: ${numbers.join(", ")}.`] : [];
}

/** Vollständig, ungekürzt: lange Listen verteilt der Versand auf mehrere Nachrichten */
function itemBlock(item: LedgerItem, position: number): string {
  const mark = item.state === "ausnahme" ? " (bleibt)" : "";
  const original = maskSecrets(item.original);
  const reason = maskSecrets(item.reason);
  if (item.klass !== "umschreiben") return `${position}. [Kennung ${item.id}]${mark} ${original}\n   Warum ${CLASS_LABEL[item.klass]}: ${reason}`;
  return `${position}. [Kennung ${item.id}]${mark}\n   Bisher: ${original}\n   Neu: ${maskSecrets(item.proposed ?? "")}\n   Warum: ${reason}`;
}

function applyLabel(group: LedgerGroup, count: number): string {
  return group.type === "paket" ? `Alle ${count} archivieren` : `Alle ${count} übernehmen`;
}

/** Stelle einer Umschreib-Gruppe unter allen Umschreib-Gruppen des Vermerks */
function groupTitle(ledger: Ledger, group: LedgerGroup, count: number): string {
  if (group.type === "paket") return `🧹 Gedächtnis aufräumen: ${count} Fakten sind doppelt oder überholt.`;
  const rewrites = ledger.groups.filter(g => g.type === "umschreiben");
  return `✏️ Gedächtnis aufräumen: ${count} Fakten umschreiben (Gruppe ${rewrites.indexOf(group) + 1} von ${rewrites.length}).`;
}

export type CleanupStep = "uebersicht" | "liste" | "ausnahmen" | "ausnahmen-weiter";

/** Frage einer Gruppe in einem Schritt: Text und Knöpfe entstehen allein aus dem Vermerk */
export function cleanupQuestion(ledger: Ledger, group: LedgerGroup, step: CleanupStep, now: number): CreateChoiceInput {
  const items = itemsOf(ledger, group);
  const count = openCount(items);
  const discard: ChoiceOption = { key: CLEANUP_KEYS.discard, label: "Verwerfen" };
  const apply: ChoiceOption[] = count > 0 ? [{ key: CLEANUP_KEYS.apply, label: applyLabel(group, count) }] : [];
  const pick: ChoiceOption = { key: CLEANUP_KEYS.exceptions, label: "Ausnahme wählen" };
  const blocks = items.map((item, i) => itemBlock(item, i + 1));
  const title = groupTitle(ledger, group, items.length);
  let lines: string[];
  let options: ChoiceOption[];
  if (step === "ausnahmen" || step === "ausnahmen-weiter") {
    const head = step === "ausnahmen" ? [title, ...blocks] : [];
    lines = [...head, "Welche sollen unverändert bleiben? Nummer tippen, erneut tippen hebt es auf.", ...exceptionNote(items)];
    options = [
      ...items.map((item, i) => ({ key: `x${i}`, label: item.state === "ausnahme" ? `${i + 1} ✓ bleibt` : `${i + 1} behalten` })),
      { key: CLEANUP_KEYS.done, label: "Fertig" },
    ];
  } else {
    const showAll = group.type === "umschreiben" || step === "liste";
    const effect =
      group.type === "paket"
        ? "Archivierte Fakten kommen in keinen Prompt und keine Suche mehr und lassen sich zurückholen."
        : "Der neue Text ersetzt den bisherigen, der bisherige lässt sich zurückholen.";
    lines = [title, ...(showAll ? blocks : []), effect, ...exceptionNote(items), CLEANUP_TEXT.untouched];
    options = [...apply, ...(showAll ? [] : [{ key: CLEANUP_KEYS.list, label: "Liste zeigen" }]), pick, discard];
  }
  return {
    kind: "cleanup",
    conversation: group.conversation,
    text: lines.join("\n"),
    options,
    expiresAt: now + CHOICE_MAX_AGE_MS,
    ref: group.id,
    action: step,
  };
}

// ---------------------------------------------------------------------------
// Vorlegen
// ---------------------------------------------------------------------------

export interface CleanupDeps {
  file: string;
  memory(): Pick<MemoryStore, "facts" | "archivedFacts" | "archiveFact" | "restoreFact" | "rewriteFact">;
  sendChoice(choice: Choice): Promise<{ sent: boolean }>;
  createChoice?(input: CreateChoiceInput): Promise<Choice>;
  expireChoice?(id: string): Promise<unknown>;
  getChoice?(id: string): Promise<Choice | undefined>;
  /** Lebt der Prozess eines Handlers noch? Standard: pidAlive */
  isAlive?(pid: number): boolean;
  now?(): number;
  log?(line: string): void;
}

const logOf = (deps: Pick<CleanupDeps, "log">) => deps.log ?? ((line: string) => console.log(line));
const nowOf = (deps: CleanupDeps) => deps.now?.() ?? Date.now();
const handlerRuns = (deps: CleanupDeps, group: LedgerGroup) => !!group.handler && (deps.isAlive ?? pidAlive)(group.handler.pid);

/**
 * Nur unter der Sperre des Vermerks: legt die Frage an und hängt sie an die
 * Gruppe. Vor dem Senden vermerkt, ein schneller Klick findet sie schon dort.
 */
async function attachQuestion(deps: CleanupDeps, ledger: Ledger, group: LedgerGroup, step: CleanupStep): Promise<Choice> {
  const create = deps.createChoice ?? realCreateChoice;
  const choice = await create(cleanupQuestion(ledger, group, step, nowOf(deps)));
  group.state = "offen";
  group.choiceId = choice.id;
  return choice;
}

type Delivery = "gesendet" | "nicht_zugestellt" | "ueberholt";

/**
 * Sendet eine angehängte Frage. Kommt sie nicht an, wartet die Gruppe wieder,
 * aber nur, wenn die Frage noch ihre aktuelle ist. Wurde sie inzwischen
 * beantwortet oder ersetzt, bleibt der Vermerk, wie er ist ("ueberholt").
 */
async function deliver(deps: CleanupDeps, groupId: string, choice: Choice): Promise<Delivery> {
  const expire = deps.expireChoice ?? realExpireChoice;
  const getChoice = deps.getChoice ?? realGetChoice;
  let sent = false;
  try {
    sent = (await deps.sendChoice(choice)).sent;
  } catch (e) {
    logOf(deps)(`[Gedächtnis] Bereinigung: Frage ${choice.id} nicht gesendet (${e instanceof Error ? e.name : "Fehler"})`);
  }
  if (sent) return "gesendet";
  await Promise.resolve(expire(choice.id)).catch(() => {});
  const answered = (await getChoice(choice.id))?.state === "done";
  return updateLedger<Delivery>(deps.file, current => {
    const group = current.groups.find(candidate => candidate.id === groupId);
    if (answered || group?.state !== "offen" || group.choiceId !== choice.id) return "ueberholt";
    group.state = "wartet";
    delete group.choiceId;
    return "nicht_zugestellt";
  });
}

export type PresentResult = "vorgelegt" | "besetzt" | "nichts" | "nicht_zugestellt";

/** Legt die nächste wartende Gruppe vor, solange keine offen ist */
export async function presentNextGroup(deps: CleanupDeps): Promise<PresentResult> {
  const reserved = await updateLedger(deps.file, async ledger => {
    if (ledger.groups.some(g => g.state === "offen")) return "besetzt" as const;
    const next = ledger.groups.find(g => g.state === "wartet");
    if (!next) return "nichts" as const;
    return { groupId: next.id, choice: await attachQuestion(deps, ledger, next, "uebersicht") };
  });
  if (typeof reserved === "string") return reserved;
  const delivery = await deliver(deps, reserved.groupId, reserved.choice);
  if (delivery === "gesendet") return "vorgelegt";
  return delivery === "ueberholt" ? "besetzt" : "nicht_zugestellt";
}

export interface CleanupReport {
  /** Einträge der Liste */
  entries: number;
  /** Neu aufgenommen */
  added: number;
  /** Fakt nicht (mehr) da: gelöscht, archiviert oder kein Fakt */
  missing: number;
  /** Text stimmt nicht mehr, übersprungen */
  changed: number;
  /** Schon früher aufgenommen */
  known: number;
  /** Davon bei der Vorlage noch nicht entschieden */
  waitingGroups: number;
  present: PresentResult;
}

/**
 * Gleicht die Liste mit dem Stand der Fakten ab und legt die erste Gruppe vor.
 * Wirft, wenn Fakten oder Vermerk nicht lesbar sind; dann ist nichts vorgelegt.
 */
export async function prepareCleanup(entries: CleanupEntry[], conversation: ChoiceConversation, deps: CleanupDeps): Promise<CleanupReport> {
  const getChoice = deps.getChoice ?? realGetChoice;
  const facts = await deps.memory().facts({ strict: true });
  const byId = new Map(facts.map(fact => [String(fact.id), fact.content]));

  const before = await readLedger(deps.file);
  // Gruppe und abgelaufene Frage: Hat die Gruppe unter der Sperre schon eine andere, gilt die
  const lapsed = new Map<string, string>();
  for (const group of before.groups) {
    if (group.state !== "offen" || !group.choiceId || handlerRuns(deps, group)) continue;
    const choice = await getChoice(group.choiceId);
    const stuck = !!group.handler || (choice?.state === "done" && (choice.result?.at ?? 0) < nowOf(deps) - HANDLER_GRACE_MS);
    if (!choice || choice.state === "expired" || stuck) lapsed.set(group.id, group.choiceId);
  }

  const report = await updateLedger(deps.file, ledger => {
    const counts = { added: 0, missing: 0, changed: 0, known: 0 };
    for (const group of ledger.groups) {
      if (group.state !== "offen" || !group.choiceId || lapsed.get(group.id) !== group.choiceId || handlerRuns(deps, group)) continue;
      group.state = "wartet";
      delete group.choiceId;
      delete group.handler;
    }
    const inGroup = (key: string) => ledger.groups.some(g => g.state !== "fertig" && g.items.includes(key));
    const fresh: string[] = [];
    for (const entry of entries) {
      const text = byId.get(entry.id);
      if (text === undefined) {
        counts.missing++;
        continue;
      }
      if (entry.original !== undefined ? entry.original !== text : entry.originalHash !== textHash(text)) {
        counts.changed++;
        continue;
      }
      const key = `${entry.id}:${textHash(text).slice(0, 16)}`;
      const known = ledger.items[key];
      if (known && !(known.state === "fehler" || (known.state === "offen" && !inGroup(key)))) {
        counts.known++;
        continue;
      }
      ledger.items[key] = {
        id: entry.id,
        klass: entry.klass,
        reason: entry.reason,
        original: text,
        ...(entry.proposed !== undefined ? { proposed: entry.proposed } : {}),
        state: "offen",
      };
      fresh.push(key);
      counts.added++;
    }
    const group = (type: LedgerGroup["type"], items: string[]) => ledger.groups.push({ id: randomUUID(), type, conversation, items, state: "wartet" });
    const clear = fresh.filter(key => ledger.items[key].klass !== "umschreiben");
    if (clear.length > 0) group("paket", clear);
    const rewrites = fresh.filter(key => ledger.items[key].klass === "umschreiben");
    for (let i = 0; i < rewrites.length; i += REWRITE_GROUP_MAX) group("umschreiben", rewrites.slice(i, i + REWRITE_GROUP_MAX));
    return counts;
  });

  const present = await presentNextGroup(deps);
  const after = await readLedger(deps.file);
  return { entries: entries.length, ...report, waitingGroups: after.groups.filter(g => g.state !== "fertig").length, present };
}

// ---------------------------------------------------------------------------
// Entscheidung
// ---------------------------------------------------------------------------

export interface CleanupChoicesDeps extends CleanupDeps {
  /** Meldung im Gespräch der Frage; darf werfen */
  notify(conversation: ChoiceConversation, text: string): Promise<void>;
}

const isDone = (change: FactChange) => change === "changed" || change === "changed_without_vector";

const STATE_OF_CHANGE: Record<FactChange, ItemState> = { changed: "erledigt", changed_without_vector: "erledigt", conflict: "konflikt", failed: "fehler", secret: "fehler" };

/** Ausführung einer entschiedenen Frage, belegt durch den Anspruch an der Gruppe */
interface HandlerRun {
  groupId: string;
  choiceId: string;
  token: string;
}

/** Die Gruppe, solange dieser Handler noch für sie zuständig ist */
function ownedGroup(ledger: Ledger, run: HandlerRun): LedgerGroup | undefined {
  const group = ledger.groups.find(candidate => candidate.id === run.groupId);
  return group?.state === "offen" && group.choiceId === run.choiceId && group.handler?.token === run.token ? group : undefined;
}

function resultText(group: LedgerGroup, tally: Record<FactChange, number>, kept: number): string {
  const done = tally.changed + tally.changed_without_vector;
  const lines = [`✅ ${done} ${group.type === "paket" ? "archiviert" : "umgeschrieben"}.`];
  if (kept > 0) lines.push(`${kept} bleiben unverändert (Ausnahmen).`);
  if (tally.conflict > 0) lines.push(`${tally.conflict} übersprungen: Der Text hat sich inzwischen geändert oder der Fakt ist weg, nichts geändert.`);
  if (tally.failed > 0) lines.push(`${tally.failed} gescheitert, unverändert. Derselbe Befehl legt sie erneut vor: tybo gedaechtnis bereinigen --datei <Pfad>`);
  if (tally.secret > 0) lines.push(secretRefusedText(tally.secret));
  if (tally.changed_without_vector > 0) lines.push(`${tally.changed_without_vector} ohne Suchvektor: Der Text gilt, gefunden wird er bis zur nächsten Berechnung nur über Wörter.`);
  if (done > 0) lines.push(CLEANUP_TEXT.undo, CLEANUP_TEXT.session);
  return lines.join("\n");
}

/** Handler der Art "cleanup": läuft nur im Gewinnerprozess von decideChoice, also je Frage genau einmal */
export function createCleanupChoices(deps: CleanupChoicesDeps): { handler: ChoiceHandler } {
  const log = logOf(deps);

  async function say(conversation: ChoiceConversation, text: string, choiceId: string): Promise<void> {
    try {
      await deps.notify(conversation, text);
    } catch (e) {
      log(`[Gedächtnis] Bereinigung: Meldung zu ${choiceId} nicht zugestellt (${e instanceof Error ? e.name : "Fehler"})`);
    }
  }

  /**
   * Nächster Schritt derselben Gruppe, nur solange die beantwortete Frage ihre
   * aktuelle ist; prepare ändert dabei den Vermerk, im selben Schritt. Kommt er
   * nicht an, wartet die Gruppe auf den nächsten Aufruf des Befehls.
   */
  async function next(group: LedgerGroup, step: CleanupStep, run: HandlerRun, prepare?: (ledger: Ledger) => void): Promise<void> {
    const { choiceId } = run;
    const reserved = await updateLedger(deps.file, async current => {
      const g = ownedGroup(current, run);
      if (!g) return null;
      prepare?.(current);
      const question = await attachQuestion(deps, current, g, step);
      delete g.handler;
      return question;
    });
    if (!reserved) {
      await say(group.conversation, CLEANUP_TEXT.stale, choiceId);
      return;
    }
    if ((await deliver(deps, group.id, reserved)) === "nicht_zugestellt") await say(group.conversation, CLEANUP_TEXT.nextFailed, choiceId);
  }

  async function advance(group: LedgerGroup, choiceId: string): Promise<void> {
    if ((await presentNextGroup(deps)) === "nicht_zugestellt") await say(group.conversation, CLEANUP_TEXT.nextFailed, choiceId);
  }

  /** Überholt: keine Gruppe ändern, nicht weiterschalten, nur sagen, was wirklich geschehen ist */
  async function overtaken(group: LedgerGroup, tally: Record<FactChange, number>, kept: number, choiceId: string): Promise<void> {
    log(`[Gedächtnis] Bereinigung ${choiceId}: überholt, Handler hört auf`);
    await say(group.conversation, tally.changed + tally.changed_without_vector > 0 ? resultText(group, tally, kept) : CLEANUP_TEXT.stale, choiceId);
  }

  async function apply(group: LedgerGroup, run: HandlerRun): Promise<void> {
    const { choiceId } = run;
    const memory = deps.memory();
    const tally: Record<FactChange, number> = { changed: 0, changed_without_vector: 0, conflict: 0, failed: 0, secret: 0 };
    let kept = 0;
    for (const key of group.items) {
      const ledger = await readLedger(deps.file);
      if (!ownedGroup(ledger, run)) return overtaken(group, tally, kept, choiceId);
      const item = ledger.items[key];
      if (item?.state === "ausnahme") kept++;
      if (item?.state !== "offen") continue;
      let change: FactChange = "failed";
      try {
        change = item.klass === "umschreiben" ? await memory.rewriteFact(item.id, item.original, item.proposed as string) : await memory.archiveFact(item.id, item.original);
      } catch (e) {
        log(`[Gedächtnis] Bereinigung: Fakt ${item.id} nicht geändert (${e instanceof Error ? e.name : "Fehler"})`);
      }
      tally[change]++;
      // Je Eintrag: ein Abbruch mittendrin lässt den Stand der übrigen richtig. Eine
      // wirklich gemachte Änderung steht immer im Vermerk, sonst ließe sie sich nicht zurückholen
      await updateLedger(deps.file, current => {
        const target = current.items[key];
        if (!isDone(change) && !ownedGroup(current, run)) return;
        target.state = STATE_OF_CHANGE[change];
        if (isDone(change)) target.changeOrder = Math.max(0, ...Object.values(current.items).map(other => other.changeOrder ?? 0)) + 1;
      });
    }
    const finished = await updateLedger(deps.file, current => {
      const g = ownedGroup(current, run);
      if (!g) return false;
      g.state = "fertig";
      delete g.handler;
      return true;
    });
    if (!finished) return overtaken(group, tally, kept, choiceId);
    log(`[Gedächtnis] Bereinigung ${choiceId}: ${tally.changed + tally.changed_without_vector} geändert, ${tally.conflict} Konflikte, ${tally.failed} gescheitert`);
    await say(group.conversation, resultText(group, tally, kept), choiceId);
    await advance(group, choiceId);
  }

  async function discard(group: LedgerGroup, run: HandlerRun): Promise<void> {
    const { choiceId } = run;
    const finished = await updateLedger(deps.file, current => {
      const g = ownedGroup(current, run);
      if (!g) return false;
      g.state = "fertig";
      delete g.handler;
      for (const item of itemsOf(current, g)) if (item.state === "offen" || item.state === "ausnahme") item.state = "verworfen";
      return true;
    });
    if (!finished) {
      await say(group.conversation, CLEANUP_TEXT.stale, choiceId);
      return;
    }
    await say(group.conversation, CLEANUP_TEXT.discarded, choiceId);
    await advance(group, choiceId);
  }

  /** Handler zu Ende, auch nach einem Fehler: Sein Prozess lebt weiter, der Anspruch darf die Gruppe nicht blockieren */
  async function release(run: HandlerRun): Promise<void> {
    try {
      const held = (await readLedger(deps.file)).groups.some(g => g.handler?.token === run.token);
      if (!held) return;
      await updateLedger(deps.file, current => {
        for (const g of current.groups) if (g.handler?.token === run.token) delete g.handler;
      });
    } catch (e) {
      log(`[Gedächtnis] Bereinigung ${run.choiceId}: Anspruch nicht aufgegeben (${e instanceof Error ? e.name : "Fehler"})`);
    }
  }

  const handler: ChoiceHandler = async choice => {
    const key = choice.result?.key;
    if (!key || !choice.ref) throw new Error("Bereinigung: Frage ohne Gruppe oder Auswahl");
    const run: HandlerRun = { groupId: choice.ref, choiceId: choice.id, token: randomUUID() };
    // Nur die aktuelle Frage der Gruppe wirkt; eine ältere ändert nichts
    const group = await updateLedger(deps.file, current => {
      const g = current.groups.find(candidate => candidate.id === run.groupId);
      if (g?.state !== "offen" || g.choiceId !== run.choiceId) return null;
      g.handler = { token: run.token, pid: process.pid };
      return g;
    });
    if (!group) {
      await say(choice.conversation, CLEANUP_TEXT.stale, choice.id);
      return;
    }
    try {
      if (key === CLEANUP_KEYS.apply) return await apply(group, run);
      if (key === CLEANUP_KEYS.discard) return await discard(group, run);
      if (key === CLEANUP_KEYS.list) return await next(group, "liste", run);
      if (key === CLEANUP_KEYS.exceptions) return await next(group, "ausnahmen", run);
      if (key === CLEANUP_KEYS.done) return await next(group, "uebersicht", run);
      const toggle = TOGGLE_KEY.exec(key);
      const itemKey = toggle ? group.items[Number(toggle[1])] : undefined;
      if (!itemKey) throw new Error("Bereinigung: unbekannte Auswahl");
      return await next(group, "ausnahmen-weiter", run, current => {
        const item = current.items[itemKey];
        if (item.state === "offen") item.state = "ausnahme";
        else if (item.state === "ausnahme") item.state = "offen";
      });
    } finally {
      await release(run);
    }
  };

  return { handler };
}

// ---------------------------------------------------------------------------
// Zurückholen
// ---------------------------------------------------------------------------

export type RestoreOutcome = "aus_dem_archiv" | "alter_text" | "nicht_gefunden" | "gescheitert" | "geheimnis";

/** Letzte erledigte Änderung dieser Art an einem Fakt */
function lastChange(ledger: Ledger, id: string, archived: boolean): [string, LedgerItem] | undefined {
  return Object.entries(ledger.items)
    .filter(([, item]) => item.id === id && item.state === "erledigt" && (item.klass !== "umschreiben") === archived)
    .sort(([, a], [, b]) => (b.changeOrder ?? 0) - (a.changeOrder ?? 0))[0];
}

/**
 * Nimmt die letzte Änderung an einem Fakt zurück, je Aufruf genau eine. Liegt der
 * Fakt im Archiv, war das Archivieren die letzte Änderung, denn Archiviertes lässt
 * sich nicht umschreiben; das geht auch ohne Vermerk. Sonst bekommt er den Text
 * vor der letzten Umschreibung zurück, aber nur, wenn sein Text noch deren
 * Ergebnis ist. Vermerkt wird genau die zurückgenommene Änderung.
 */
export async function restoreCleanupFact(id: string, deps: Pick<CleanupDeps, "file" | "memory">): Promise<RestoreOutcome> {
  const memory = deps.memory();
  const ledger = await readLedger(deps.file);
  const fromArchive = await memory.restoreFact(id);
  if (fromArchive === "failed") return "gescheitert";
  const archived = isDone(fromArchive);
  const entry = lastChange(ledger, id, archived);
  if (!archived) {
    if (!entry) return "nicht_gefunden";
    const change = await memory.rewriteFact(id, entry[1].proposed as string, entry[1].original);
    if (change === "conflict") return "nicht_gefunden";
    if (change === "failed") return "gescheitert";
    if (change === "secret") return "geheimnis";
  }
  if (entry) {
    await updateLedger(deps.file, current => {
      current.items[entry[0]].state = "zurueckgeholt";
    });
  }
  return archived ? "aus_dem_archiv" : "alter_text";
}
