/**
 * Fester Kern (Issue #522): eine vom Nutzer bestätigte kurze Übersicht, die in
 * jedem frischen Prompt steht, zusätzlich zum Budget der Ähnlichkeitssuche.
 *
 * Bestätigt ist genau, was in config/kern.md steht. Dorthin kommt Text nur, wenn
 * der Nutzer ihn selbst schreibt (/kern setzen, die Datei von Hand) oder einen
 * Entwurf per Knopf übernimmt. Entwürfe liegen getrennt in data/kern-entwurf.json
 * und wirken nie auf einen Prompt. Der Kern steht neben config/profile.md, nicht
 * darin: Das Profil gehört `tybo setup profil` und bleibt unberührt.
 *
 * Gelesen wird bei jedem frischen Prompt, ohne Cache: Eine Änderung gilt ab der
 * nächsten frischen Session ohne Neustart. Laufende Sessions behalten ihren
 * Stand, /new erzwingt den neuen. Ohne Datei ist der Abschnitt leer, und tybo
 * verhält sich wie ohne dieses Modul.
 *
 * Geheimnisse (Issue #524): Der Kern steht in jedem frischen Prompt. /kern setzen
 * lehnt einen Text mit Geheimnis ab, eine Datei von Hand steht im Prompt und bei
 * /kern maskiert; maskiert wird vor dem Kürzen. Die Datei selbst bleibt, wie sie ist.
 *
 * Ins Log kommen nie Texte des Kerns oder eines Entwurfs.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../atomic-file";
import { acquireFileLock, releaseFileLock } from "../file-lock";
import { containsSecret, maskSecrets } from "./secrets";

/** Zielgröße für Entwürfe und Hinweise: „etwa 1.500 Zeichen" */
export const CORE_TARGET_CHARS = 1500;
/** Harte Grenze: /kern setzen lehnt darüber ab, der Prompt nimmt nicht mehr als das */
export const CORE_MAX_CHARS = 2000;

export function coreFile(root: string = process.cwd()): string {
  return join(root, "config", "kern.md");
}

/** Der zuletzt ersetzte Kern, eine Fassung */
export function coreBackupFile(root: string = process.cwd()): string {
  return `${coreFile(root)}.vorher`;
}

export function coreDraftFile(root: string = process.cwd()): string {
  return join(root, "data", "kern-entwurf.json");
}

/** Ohne Kommentare der Vorlage und ohne Leerraum außen; nur Kommentare zählen als kein Kern */
export function normalizeCore(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "").trim();
}

export type CoreRead = { ok: true; text: string } | { ok: false };

/** Kein Kern ist text "", ein Lesefehler ok: false; die beiden dürfen nie gleich aussehen */
export async function readCore(root?: string): Promise<CoreRead> {
  try {
    return { ok: true, text: normalizeCore(await readFile(coreFile(root), "utf-8")) };
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { ok: true, text: "" };
    return { ok: false };
  }
}

/** Kürzt an einer Zeilengrenze auf höchstens max Zeichen; eine einzige lange Zeile wird hart geschnitten */
export function fitCore(text: string, max: number = CORE_MAX_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  if (cut > 0) return text.slice(0, cut).trimEnd();
  const hard = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(hard) ? hard.slice(0, -1) : hard;
}

/** Kern für den Prompt: Ein Lesefehler kostet nur den Abschnitt, eine zu große Handänderung wird begrenzt */
export async function coreForPrompt(root?: string): Promise<string> {
  const read = await readCore(root);
  if (!read.ok) {
    console.log("[kern] config/kern.md nicht lesbar, Prompt ohne Kern");
    return "";
  }
  if (read.text.length > CORE_MAX_CHARS) console.log(`[kern] config/kern.md hat ${read.text.length} Zeichen, im Prompt gekürzt auf ${CORE_MAX_CHARS}`);
  return fitCore(maskSecrets(read.text));
}

/** Fingerabdruck eines Kerns: Ein Entwurf merkt sich, auf welchem Stand er beruht */
export function coreFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function underLock<T>(lockFile: string, work: () => Promise<T>, waitMs?: number): Promise<T> {
  await mkdir(dirname(lockFile), { recursive: true });
  const lock = await acquireFileLock(lockFile, waitMs === undefined ? {} : { waitMs });
  try {
    return await work();
  } finally {
    await releaseFileLock(lockFile, lock).catch(() => {});
  }
}

function underCoreLock<T>(root: string | undefined, work: () => Promise<T>): Promise<T> {
  return underLock(`${coreFile(root)}.lock`, work);
}

/** Sichert den bisherigen Kern, wenn es einen gibt; ohne geglückte Sicherung geht es nicht weiter */
async function backupCore(previous: string, root?: string): Promise<void> {
  if (previous) await atomicWriteFile(coreBackupFile(root), `${previous}\n`);
}

export type SetCoreOutcome = "saved" | "unchanged" | "empty" | "too_long" | "secret" | "unreadable";

/** Schreibt einen vom Nutzer selbst formulierten Kern; zu langer Text wird abgelehnt, nie gekürzt */
export async function setCore(input: string, root?: string): Promise<SetCoreOutcome> {
  const text = normalizeCore(input);
  if (!text) return "empty";
  if (text.length > CORE_MAX_CHARS) return "too_long";
  if (containsSecret(text)) return "secret";
  return underCoreLock(root, async () => {
    const read = await readCore(root);
    if (!read.ok) return "unreadable";
    if (read.text === text) return "unchanged";
    await backupCore(read.text, root);
    await atomicWriteFile(coreFile(root), `${text}\n`);
    return "saved";
  });
}

export type DeleteCoreOutcome = "deleted" | "none" | "unreadable";

/** Entfernt den Kern; die letzte Fassung bleibt als config/kern.md.vorher */
export async function deleteCore(root?: string): Promise<DeleteCoreOutcome> {
  return underCoreLock(root, async () => {
    const read = await readCore(root);
    if (!read.ok) return "unreadable";
    if (!read.text) {
      // Auch eine Datei nur mit Kommentaren darf bleiben: Sie ist kein Kern
      return "none";
    }
    await backupCore(read.text, root);
    await rm(coreFile(root), { force: true });
    return "deleted";
  });
}

export interface CoreDraft {
  id: string;
  /** Fingerabdruck des Kerns, bevor der Entwurf entstand */
  base: string;
  text: string;
  createdAt: number;
}

function isDraft(value: unknown): value is CoreDraft {
  const d = value as Partial<CoreDraft> | null;
  return !!d && typeof d === "object" && typeof d.id === "string" && typeof d.base === "string" && typeof d.text === "string" && typeof d.createdAt === "number";
}

async function readDraft(root?: string): Promise<CoreDraft | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(coreDraftFile(root), "utf-8"));
    return isDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Legt den einzigen aktuellen Entwurf ab; ein älterer ist damit überholt */
export async function storeCoreDraft(text: string, base: string, root?: string): Promise<CoreDraft> {
  const draft: CoreDraft = { id: randomUUID().replaceAll("-", "").slice(0, 16), base, text, createdAt: Date.now() };
  await underCoreLock(root, () => atomicWriteFile(coreDraftFile(root), JSON.stringify(draft, null, 2)));
  return draft;
}

/** Die Frage kann Telegram-Nachrichten ändern, das Warten darf also dauern; danach bleibt der offene Stand gültig */
const DRAFT_OFFER_WAIT_MS = 60_000;

/**
 * Hält Ablage und Frage eines Entwurfs als einen Schritt zusammen: Sonst gewinnt
 * bei zwei gleichzeitigen Entwürfen die Ablage des einen und die Frage des
 * anderen, und keiner lässt sich mehr übernehmen. Eigene Sperre, damit /kern
 * setzen und der Klick nicht auf das Register warten; darin nimmt der Schritt
 * die Sperren von Kern und Register, nie umgekehrt.
 */
export function underCoreDraftOffer<T>(work: () => Promise<T>, root?: string): Promise<T> {
  return underLock(`${coreDraftFile(root)}.lock`, work, DRAFT_OFFER_WAIT_MS);
}

/** Entfernt genau diesen Entwurf, damit ein alter Klick oder das Aufräumen keinen neueren trifft */
export async function dropCoreDraft(id: string, root?: string): Promise<void> {
  await underCoreLock(root, async () => {
    if ((await readDraft(root))?.id !== id) return;
    await rm(coreDraftFile(root), { force: true });
  });
}

export type AdoptDraftOutcome =
  | "adopted"
  /** Es gibt ihn nicht mehr oder ein neuerer hat ihn abgelöst */
  | "overtaken"
  /** Der Kern hat sich geändert, seit der Entwurf entstand */
  | "stale"
  | "unreadable";

/** Übernimmt genau diesen Entwurf, solange der Kern noch auf seinem Stand ist; sonst bleibt der Kern, wie er ist */
export async function adoptCoreDraft(id: string, root?: string): Promise<AdoptDraftOutcome> {
  return underCoreLock(root, async () => {
    const draft = await readDraft(root);
    if (!draft || draft.id !== id) return "overtaken";
    const read = await readCore(root);
    if (!read.ok) return "unreadable";
    if (coreFingerprint(read.text) !== draft.base) {
      await rm(coreDraftFile(root), { force: true });
      return "stale";
    }
    await backupCore(read.text, root);
    await atomicWriteFile(coreFile(root), `${draft.text}\n`);
    await rm(coreDraftFile(root), { force: true });
    return "adopted";
  });
}
