/**
 * Geheimnisse im Altbestand einzeln entscheiden (Issue #524). `tybo gedaechtnis
 * geheimnisse` legt jeden Fakt, in dem die Prüfung (secrets.ts) ein Geheimnis
 * findet, als eigene Frage im Direktchat vor: Behalten oder Archivieren. Fremde
 * Klicks kommen nie durch (telegram-choices.ts, WebUI mit Anmeldung), ein Klick
 * wirkt genau einmal (choices.ts).
 *
 * Behalten heißt: Der Fakt bleibt gespeichert und steht in Prompts und Ausgaben
 * weiter maskiert. Die Entscheidung liegt dauerhaft in
 * data/gedaechtnis-geheimnisse.json, gebunden an Kennung und Inhaltsstand: Ändert
 * sich der Text, wird neu gefragt. Archivieren geht über archiveFact gegen den
 * erwarteten Text, zurück mit `tybo gedaechtnis zurueckholen <Kennung>`.
 *
 * Die Frage trägt Kennung und Stand im Bezug. Passt der Stand beim Klick nicht mehr,
 * ändert sich nichts. Fragetexte, Meldungen und Ausgaben des Befehls nennen den Wert
 * nie, ins Log kommen nur Kennungen.
 *
 * Grenzen: Eine laufende Session behält, was sie schon geladen hat, bis /new.
 * Alte Nachrichten im Verlauf bleiben, wie sie sind.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../atomic-file";
import { BRAND } from "../../brand";
import {
  CHOICE_MAX_AGE_MS,
  createChoice as realCreateChoice,
  expireChoice as realExpireChoice,
  listChoices as realListChoices,
  type Choice,
  type ChoiceConversation,
  type ChoiceHandler,
  type CreateChoiceInput,
} from "../choices";
import { acquireFileLock, releaseFileLock } from "../file-lock";
import type { MemoryStore } from "../store/ports";
import type { MemoryItem } from "../store/types";
import { textHash } from "./fact-cleanup";
import { containsSecret, maskSecrets } from "./secrets";

export const SECRET_KEYS = { keep: "behalten", archive: "archivieren" } as const;
/** So viele Fragen stehen höchstens gleichzeitig offen; den Rest legt der nächste Aufruf vor */
export const SECRET_QUESTIONS_MAX = 20;
const LINE_MAX = 500;

const RESTORE = (id: string) => `${BRAND.cli} gedaechtnis zurueckholen ${id}`;
const COMMAND = `${BRAND.cli} gedaechtnis geheimnisse`;

export const SECRET_TEXT = {
  question: (id: string, masked: string) =>
    `🔐 Fakt ${id} enthält vermutlich ein Geheimnis:\n${masked}\n\n` +
    "Behalten: Er bleibt gespeichert, der Wert steht in Prompts und Ausgaben weiter maskiert.\n" +
    `Archivieren: Er kommt in keinen Prompt und keine Suche mehr, zurück mit ${RESTORE(id)}.\n` +
    "Echte Zugangsdaten gehören in die .env im Projektordner.",
  kept: (id: string) => `Behalten: Fakt ${id} bleibt gespeichert, der Wert steht in Prompts und Ausgaben weiter maskiert.`,
  archived: (id: string) => `Archiviert: Fakt ${id} kommt in keinen Prompt und keine Suche mehr. Zurückholen: ${RESTORE(id)}. Laufende Sessions behalten bereits Geladenes bis /new.`,
  changed: (id: string) => `Fakt ${id} hat sich inzwischen geändert, die Antwort gilt nicht mehr, nichts geändert. Neu vorlegen: ${COMMAND}`,
  gone: (id: string) => `Fakt ${id} gibt es so nicht mehr, nichts geändert.`,
  failed: (id: string) => `Zu Fakt ${id} hat das nicht geklappt, nichts geändert. Neu vorlegen: ${COMMAND}`,
} as const;

export const secretDecisionsFile = (root: string) => join(root, "data", "gedaechtnis-geheimnisse.json");

/** Inhaltsstand eines Fakts; der Text selbst steht nicht im Register und nicht im Vermerk */
export const factStamp = (content: string) => textHash(content).slice(0, 16);

interface Decisions {
  version: 1;
  kept: Record<string, { stamp: string; at: string }>;
}

/** Wirft, wenn der Vermerk nicht lesbar ist; überschrieben wird er dann nie */
export async function readSecretDecisions(file: string): Promise<Decisions> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { version: 1, kept: {} };
    throw e;
  }
  const parsed = JSON.parse(raw) as Partial<Decisions> | null;
  if (parsed?.version !== 1 || !parsed.kept || typeof parsed.kept !== "object") throw new Error("Vermerk nicht lesbar");
  return parsed as Decisions;
}

async function rememberKept(file: string, id: string, stamp: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  const lock = await acquireFileLock(lockFile);
  try {
    const decisions = await readSecretDecisions(file);
    decisions.kept[id] = { stamp, at: new Date().toISOString() };
    await atomicWriteFile(file, JSON.stringify(decisions, null, 2));
  } finally {
    await releaseFileLock(lockFile, lock).catch(() => {});
  }
}

const maskedLine = (content: string) => {
  const line = maskSecrets(content).replace(/\s+/g, " ").trim();
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
};

const refOf = (fact: MemoryItem) => `${fact.id}:${factStamp(fact.content)}`;

function parseRef(ref: string | undefined): { id: string; stamp: string } | null {
  const cut = ref?.lastIndexOf(":") ?? -1;
  if (!ref || cut <= 0 || cut === ref.length - 1) return null;
  return { id: ref.slice(0, cut), stamp: ref.slice(cut + 1) };
}

export function secretQuestion(fact: MemoryItem, conversation: ChoiceConversation, now: number): CreateChoiceInput {
  return {
    kind: "secret",
    conversation,
    text: SECRET_TEXT.question(String(fact.id), maskedLine(fact.content)),
    options: [
      { key: SECRET_KEYS.keep, label: "Behalten" },
      { key: SECRET_KEYS.archive, label: "Archivieren" },
    ],
    expiresAt: now + CHOICE_MAX_AGE_MS,
    ref: refOf(fact),
  };
}

export interface SecretOfferDeps {
  file: string;
  memory(): Pick<MemoryStore, "facts">;
  sendChoice(choice: Choice): Promise<{ sent: boolean }>;
  createChoice?(input: CreateChoiceInput): Promise<Choice>;
  expireChoice?(id: string): Promise<unknown>;
  listChoices?(): Promise<Choice[]>;
  now?(): number;
  log?(line: string): void;
}

export interface SecretOfferReport {
  /** Fakten mit Geheimnis insgesamt */
  found: number;
  /** Davon behalten, Stand unverändert; nicht vorgelegt */
  kept: number;
  /** Davon mit offener Frage */
  waiting: number;
  /** Jetzt neu vorgelegt */
  offered: number;
  /** Frage kam nirgends an */
  notDelivered: number;
  /** Warten auf einen späteren Aufruf */
  later: number;
  /** Kennung und maskierter Text aller noch nicht entschiedenen Fakten */
  open: { id: string; masked: string }[];
}

/**
 * Legt alle noch nicht entschiedenen Fakten mit Geheimnis vor, jeden einzeln.
 * Wirft, wenn Fakten, Vermerk oder Register nicht lesbar sind; dann ist nichts
 * vorgelegt. all: auch Fakten, die schon behalten wurden.
 */
export async function offerSecretFacts(conversation: ChoiceConversation, deps: SecretOfferDeps, options: { all?: boolean } = {}): Promise<SecretOfferReport> {
  const create = deps.createChoice ?? realCreateChoice;
  const expire = deps.expireChoice ?? realExpireChoice;
  const list = deps.listChoices ?? realListChoices;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now?.() ?? Date.now();

  const facts = (await deps.memory().facts({ strict: true })).filter(fact => fact.id !== undefined && fact.id !== null && containsSecret(fact.content));
  const decisions = await readSecretDecisions(deps.file);
  const openRefs = new Set((await list()).filter(choice => choice.kind === "secret" && choice.state === "open").map(choice => choice.ref));

  const isKept = (fact: MemoryItem) => !options.all && decisions.kept[String(fact.id)]?.stamp === factStamp(fact.content);
  const undecided = facts.filter(fact => !isKept(fact));
  const fresh = undecided.filter(fact => !openRefs.has(refOf(fact)));
  const waiting = undecided.length - fresh.length;
  const batch = fresh.slice(0, Math.max(0, SECRET_QUESTIONS_MAX - waiting));

  let offered = 0;
  let notDelivered = 0;
  for (const fact of batch) {
    const choice = await create(secretQuestion(fact, conversation, now));
    let sent = false;
    try {
      sent = (await deps.sendChoice(choice)).sent;
    } catch (e) {
      log(`[Gedächtnis] Geheimnisse: Frage ${choice.id} nicht gesendet (${e instanceof Error ? e.name : "Fehler"})`);
    }
    if (sent) {
      offered++;
      continue;
    }
    notDelivered++;
    await Promise.resolve(expire(choice.id)).catch(() => {});
  }
  return {
    found: facts.length,
    kept: facts.length - undecided.length,
    waiting,
    offered,
    notDelivered,
    later: fresh.length - batch.length,
    open: undecided.map(fact => ({ id: String(fact.id), masked: maskedLine(fact.content) })),
  };
}

export interface SecretChoicesDeps {
  file: string;
  memory(): Pick<MemoryStore, "facts" | "archiveFact">;
  /** Meldung im Gespräch der Frage; darf werfen */
  notify(conversation: ChoiceConversation, text: string): Promise<void>;
  log?(line: string): void;
}

/** Handler der Art "secret": läuft nur im Gewinnerprozess von decideChoice, also je Frage genau einmal */
export function createSecretChoices(deps: SecretChoicesDeps): { handler: ChoiceHandler } {
  const log = deps.log ?? ((line: string) => console.log(line));

  async function decide(choice: Choice, id: string, stamp: string): Promise<string> {
    const fact = (await deps.memory().facts({ strict: true })).find(candidate => String(candidate.id) === id);
    if (!fact) return SECRET_TEXT.gone(id);
    if (factStamp(fact.content) !== stamp) return SECRET_TEXT.changed(id);
    if (choice.result?.key === SECRET_KEYS.keep) {
      await rememberKept(deps.file, id, stamp);
      return SECRET_TEXT.kept(id);
    }
    if (choice.result?.key !== SECRET_KEYS.archive) throw new Error("Geheimnisse: unbekannte Auswahl");
    const change = await deps.memory().archiveFact(id, fact.content);
    if (change === "changed" || change === "changed_without_vector") return SECRET_TEXT.archived(id);
    return change === "conflict" ? SECRET_TEXT.changed(id) : SECRET_TEXT.failed(id);
  }

  const handler: ChoiceHandler = async choice => {
    const ref = parseRef(choice.ref);
    if (!ref) throw new Error("Geheimnisse: Frage ohne Bezug");
    let text: string;
    try {
      text = await decide(choice, ref.id, ref.stamp);
    } catch (e) {
      log(`[Gedächtnis] Geheimnisse: Fakt ${ref.id} nicht entschieden (${e instanceof Error ? e.name : "Fehler"})`);
      text = SECRET_TEXT.failed(ref.id);
    }
    try {
      await deps.notify(choice.conversation, text);
    } catch (e) {
      log(`[Gedächtnis] Geheimnisse: Meldung zu ${choice.id} nicht zugestellt (${e instanceof Error ? e.name : "Fehler"})`);
    }
  };

  return { handler };
}
