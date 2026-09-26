/**
 * Ablage der Anhänge aus dem Web-Chat (Issue #72): data/uploads/<Gespräch>/<ID>/
 * mit der Datei (file.<Endung>) und meta.json.
 *
 * - Eine ID gehört genau einem Gespräch; in einem anderen ist sie unbekannt.
 * - Zustand in meta.json: pending (hochgeladen, nicht abgeschickt) oder sent
 *   (mit einer Nachricht angenommen). Er übersteht Neustarts.
 * - claim() reserviert die IDs einer Nachricht ohne await zwischen Prüfen und
 *   Reservieren (gleichzeitiges Senden derselben ID: nur einer gewinnt) und
 *   setzt sie auf sent, bevor der Turn startet. Scheitert das Senden oder
 *   endet der Turn, ohne die Nachricht zu speichern, setzt unclaim() sie
 *   zurück auf pending: sie lassen sich erneut schicken.
 * - cleanup() löscht, was länger als 24 Stunden pending ist. Reservierte und
 *   abgeschickte Anhänge bleiben (laufende Turns, Download im Verlauf).
 * - removeConversation() löscht beim Löschen eines Web-Gesprächs (Issue #112)
 *   alle seine Anhänge (pending und sent) und die Arbeitskopien des
 *   Medien-Kerns; danach nimmt die Ablage für dieses Gespräch nichts mehr an.
 * - Gesprächsordner, Anhang-Ordner, meta.json und Datei müssen echte Ordner
 *   bzw. Dateien unterhalb der Wurzel sein. Ein Symlink an einer dieser
 *   Stellen gilt als fehlend: nichts wird darüber gelesen, geschrieben oder
 *   gelöscht.
 *
 * Nichts aus src/lib; die Typprüfung (./media-check) teilt es mit dem Medien-Kern.
 */

import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { MEDIA_LIMITS, checkMediaUpload, detectMedia, type MediaKind } from "./media-check";
import { parseTelegramConversationId } from "./telegram";
import { isConversationId } from "./store";
import {
  defaultAttachmentName,
  isUploadId,
  MAX_ATTACHMENTS,
  pickAttachment,
  type MessageAttachment,
} from "./attachments";

/** Nicht abgeschickte Anhänge werden nach dieser Zeit gelöscht */
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Abstand der Aufräumläufe */
export const UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** Höchstens so viele nicht abgeschickte Anhänge je Gespräch */
export const MAX_PENDING_PER_CONVERSATION = 20;

export const UPLOAD_TEXT = {
  notConfigured: "Anhänge sind hier nicht eingerichtet",
  empty: "Die Datei ist leer.",
  tooMany: `Höchstens ${MAX_ATTACHMENTS} Anhänge je Nachricht.`,
  invalidList: "Feld attachments muss eine Liste von Anhang-IDs sein.",
  duplicate: "Ein Anhang ist doppelt angegeben.",
  unknown: "Anhang unbekannt, schon abgeschickt oder aus einem anderen Gespräch.",
  pendingLimit: `Zu viele nicht abgeschickte Anhänge in diesem Gespräch (höchstens ${MAX_PENDING_PER_CONVERSATION}).`,
  badName: "Dateiname ist nicht gültig kodiert.",
  gone: "Gespräch nicht gefunden",
  withCommand: "Befehle nehmen keine Anhänge. Bitte den Befehl ohne Anhang schicken.",
  withAnswer: "Eine Antwort auf eine Rückfrage nimmt keine Anhänge.",
};

type State = "pending" | "sent";

export interface UploadMeta extends MessageAttachment {
  conversationId: string;
  /** Endung der abgelegten Datei (aus der Erkennung) */
  ext: string;
  createdAt: string;
  state: State;
}

export type SaveResult =
  | { ok: true; attachment: MessageAttachment }
  | { ok: false; status: 400 | 404 | 409 | 413 | 415; error: string };

export type ClaimResult = { ok: true; attachments: MessageAttachment[] } | { ok: false; error: string };

export interface UploadStoreOptions {
  /** Wurzel der Ablage, im Bot data/uploads */
  dir: string;
  /**
   * Wurzel der Arbeitskopien des Medien-Kerns für Web-Gespräche (im Bot
   * uploads/web, webMediaDir in ./bot-turn); darunter ein Ordner je
   * Gespräch, den removeConversation mitlöscht. Ohne Angabe nur die Ablage.
   */
  mediaDir?: string;
  now?: () => number;
  maxAgeMs?: number;
  /** Nie Dateiinhalte oder Namen übergeben */
  log?: (message: string) => void;
}

const META = "meta.json";
const EXT_PATTERN = /^[a-z0-9]{1,10}$/;

/** Gesprächs-IDs, unter denen abgelegt wird: dm, topic-<n>, UUID der Web-Gespräche */
export function isUploadConversationId(id: unknown): id is string {
  return parseTelegramConversationId(id) !== null || isConversationId(id);
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

export class UploadStore {
  readonly dir: string;
  readonly mediaDir?: string;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly log: (message: string) => void;
  /** Gerade von claim() geprüfte Anhänge (Gespräch/ID) */
  private readonly reserved = new Set<string>();
  /** Gerade von cleanup() gelöschte Anhänge (Gespräch/ID) */
  private readonly deleting = new Set<string>();
  /** Je Gespräch: Ablegen nacheinander, damit die Grenze für pending hält */
  private readonly saving = new Map<string, Promise<unknown>>();
  /** Gelöschte Web-Gespräche: nichts mehr ablegen oder annehmen (UUIDs kommen nicht wieder) */
  private readonly removed = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: UploadStoreOptions) {
    this.dir = options.dir;
    this.mediaDir = options.mediaDir;
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? UPLOAD_MAX_AGE_MS;
    this.log = options.log ?? (m => console.log(`[web] ${m}`));
  }

  /**
   * Ordner der Anhänge eines Gesprächs (für die Auslieferung über ./files):
   * aufgelöster Pfad unter der Wurzel, nur wenn er ein echter Ordner ist,
   * kein Symlink. null, wenn es ihn nicht gibt. create legt ihn an.
   */
  async conversationDir(conversationId: string, create = false): Promise<string | null> {
    if (!isUploadConversationId(conversationId)) throw new Error("Ungültige Gesprächs-ID");
    if (create) await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let root: string;
    try {
      root = await realpath(this.dir);
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
    const folder = join(root, conversationId);
    if (create) {
      await mkdir(folder, { mode: 0o700 }).catch((e: any) => {
        if (e?.code !== "EEXIST") throw e;
      });
    }
    return (await isRealDir(folder)) && folder.startsWith(root + sep) ? folder : null;
  }

  /** Ordner eines Anhangs: echter Ordner im echten Gesprächsordner, sonst null */
  private async itemDir(conversationId: string, id: string): Promise<string | null> {
    if (!isUploadId(id)) return null;
    const conversation = await this.conversationDir(conversationId);
    if (!conversation) return null;
    const folder = join(conversation, id);
    return (await isRealDir(folder)) ? folder : null;
  }

  /** Name der abgelegten Datei im Ordner des Anhangs */
  static storedName(meta: Pick<UploadMeta, "ext">): string {
    return `file.${meta.ext}`;
  }

  /**
   * Prüft Art und Größe allein aus den Bytes und legt die Datei als pending
   * ab. name ist nur Anzeige; ohne Namen ein Standardname nach Art.
   */
  async save(conversationId: string, bytes: Uint8Array, name: string | undefined): Promise<SaveResult> {
    if (!isUploadConversationId(conversationId)) throw new Error("Ungültige Gesprächs-ID");
    if (bytes.length === 0) return { ok: false, status: 400, error: UPLOAD_TEXT.empty };
    const check = checkMediaUpload(bytes);
    // Erkannt, aber abgelehnt heißt: zu groß; nicht erkannt: Typ nicht erlaubt (auch SVG, HTML)
    if (!check.ok) return { ok: false, status: detectMedia(bytes) ? 413 : 415, error: check.reason };
    return this.serial(conversationId, async () => {
      // Erst hier prüfen: ein Ablegen, das vor dem Löschen angenommen wurde, wartet in der Reihe
      if (this.removed.has(conversationId)) return { ok: false, status: 404, error: UPLOAD_TEXT.gone };
      const pending = (await this.list(conversationId)).filter(m => m.state === "pending").length;
      if (pending >= MAX_PENDING_PER_CONVERSATION) return { ok: false, status: 409, error: UPLOAD_TEXT.pendingLimit };
      const meta: UploadMeta = {
        id: crypto.randomUUID(),
        conversationId,
        name: name ?? defaultAttachmentName(check.kind, check.ext),
        size: bytes.length,
        mime: check.mime,
        kind: check.kind,
        ext: check.ext,
        createdAt: new Date(this.now()).toISOString(),
        state: "pending",
      };
      const conversation = await this.conversationDir(conversationId, true);
      if (!conversation) throw new Error("Ablage des Gesprächs ist kein Ordner");
      const folder = join(conversation, meta.id);
      // Nicht rekursiv und exklusiv: nichts Vorhandenes wird übernommen oder überschrieben
      await mkdir(folder, { mode: 0o700 });
      try {
        await writeFile(join(folder, UploadStore.storedName(meta)), bytes, { mode: 0o600, flag: "wx" });
        await this.writeMeta(meta);
      } catch (e) {
        await rm(folder, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      return { ok: true, attachment: toAttachment(meta) };
    });
  }

  /** Angaben eines Anhangs dieses Gesprächs; null, wenn es ihn dort nicht gibt */
  async find(conversationId: string, id: string): Promise<UploadMeta | null> {
    if (!isUploadConversationId(conversationId) || !isUploadId(id)) return null;
    let raw: string;
    try {
      const folder = await this.itemDir(conversationId, id);
      if (!folder) return null;
      const file = join(folder, META);
      if (!(await isRealFile(file))) return null;
      raw = await readFile(file, "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
      throw e;
    }
    return parseMeta(raw, conversationId, id);
  }

  /** Inhalt eines Anhangs; wirft, wenn er fehlt */
  async read(conversationId: string, id: string): Promise<{ attachment: MessageAttachment; bytes: Uint8Array }> {
    const meta = await this.find(conversationId, id);
    const folder = meta && (await this.itemDir(conversationId, id));
    const file = folder && join(folder, UploadStore.storedName(meta));
    if (!meta || !file || !(await isRealFile(file))) throw new Error("Anhang nicht gefunden");
    const bytes = new Uint8Array(await readFile(file));
    return { attachment: toAttachment(meta), bytes };
  }

  /**
   * Nimmt Anhänge für eine Nachricht an: 1 bis 5 gültige, verschiedene IDs,
   * alle pending in genau diesem Gespräch. Danach sind sie sent.
   */
  async claim(conversationId: string, ids: unknown): Promise<ClaimResult> {
    const invalid = validateIds(ids);
    if (invalid) return { ok: false, error: invalid };
    const list = ids as string[];
    if (!isUploadConversationId(conversationId) || this.removed.has(conversationId)) return { ok: false, error: UPLOAD_TEXT.unknown };
    const keys = list.map(id => `${conversationId}/${id}`);
    // Prüfen und Reservieren ohne await dazwischen
    if (keys.some(k => this.reserved.has(k) || this.deleting.has(k))) return { ok: false, error: UPLOAD_TEXT.unknown };
    for (const k of keys) this.reserved.add(k);
    try {
      const metas: UploadMeta[] = [];
      for (const id of list) {
        const meta = await this.find(conversationId, id);
        if (!meta || meta.state !== "pending") return { ok: false, error: UPLOAD_TEXT.unknown };
        metas.push(meta);
      }
      const done: UploadMeta[] = [];
      try {
        for (const meta of metas) {
          await this.writeMeta({ ...meta, state: "sent" });
          done.push(meta);
        }
      } catch (e) {
        for (const meta of done) await this.writeMeta(meta).catch(() => {});
        throw e;
      }
      return { ok: true, attachments: metas.map(toAttachment) };
    } finally {
      for (const k of keys) this.reserved.delete(k);
    }
  }

  /** Abgeschickte Anhänge wieder freigeben (Nachricht nicht angenommen oder nicht gespeichert) */
  async unclaim(conversationId: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        const meta = await this.find(conversationId, id);
        if (meta && meta.state === "sent") await this.writeMeta({ ...meta, state: "pending" });
      } catch (e) {
        this.log(`Anhang nicht freigegeben (${errorName(e)})`);
      }
    }
  }

  /**
   * Löscht Anhänge, die länger als 24 Stunden nicht abgeschickt wurden, und
   * Ordner ohne lesbare Angaben, die ebenso alt sind. Gibt die Zahl zurück.
   */
  async cleanup(): Promise<number> {
    let conversations: string[];
    try {
      conversations = await readdir(this.dir);
    } catch (e: any) {
      if (e?.code === "ENOENT") return 0;
      throw e;
    }
    const limit = this.now() - this.maxAgeMs;
    let removed = 0;
    for (const conversationId of conversations) {
      if (!isUploadConversationId(conversationId)) continue;
      let ids: string[];
      let conversation: string | null;
      try {
        // Verlinkte Gesprächsordner werden übersprungen, nie durchsucht
        conversation = await this.conversationDir(conversationId);
        if (!conversation) continue;
        ids = await readdir(conversation);
      } catch {
        continue;
      }
      for (const id of ids) {
        if (!isUploadId(id)) continue;
        const key = `${conversationId}/${id}`;
        // Prüfen und Sperren ohne await dazwischen, wie claim()
        if (this.reserved.has(key) || this.deleting.has(key)) continue;
        this.deleting.add(key);
        try {
          const folder = join(conversation, id);
          const meta = await this.find(conversationId, id).catch(() => null);
          let expired: boolean;
          if (meta) {
            expired = meta.state === "pending" && Date.parse(meta.createdAt) < limit;
          } else {
            // Ohne lesbare Angaben (abgebrochenes Ablegen): nach Alter des Ordners
            const info = await lstat(folder).catch(() => null);
            expired = !!info && info.isDirectory() && !info.isSymbolicLink() && info.mtimeMs < limit;
          }
          // Direkt vor dem Löschen noch einmal: echter Ordner im echten Gesprächsordner
          // (rm folgt Symlinks im Ordner nicht, nur der Ordner selbst zählt)
          if (expired && (await this.itemDir(conversationId, id)) === folder) {
            await rm(folder, { recursive: true, force: true });
            removed++;
          }
        } catch (e) {
          this.log(`Anhang nicht aufgeräumt (${errorName(e)})`);
        } finally {
          this.deleting.delete(key);
        }
      }
    }
    if (removed > 0) this.log(`${removed} nicht abgeschickte Anhänge gelöscht`);
    return removed;
  }

  /**
   * Löscht alle Anhänge eines Web-Gesprächs (pending und sent) und seinen
   * Ordner der Arbeitskopien unter mediaDir (Issue #112). Läuft in der Reihe
   * des Gesprächs nach einem gerade laufenden Ablegen; danach lehnen save()
   * und claim() für dieses Gespräch ab. Ein Symlink an Stelle eines der
   * beiden Ordner wird nie verfolgt und bleibt stehen. Nur für Web-Gespräche:
   * Direktchat und Topics behalten ihre Ablage.
   */
  async removeConversation(conversationId: string): Promise<void> {
    if (!isConversationId(conversationId)) throw new Error("Ungültige Gesprächs-ID");
    this.removed.add(conversationId);
    await this.serial(conversationId, async () => {
      const folder = await this.conversationDir(conversationId);
      if (folder) await rm(folder, { recursive: true, force: true });
      if (this.mediaDir) {
        let root: string | null = null;
        try {
          root = await realpath(this.mediaDir);
        } catch (e: any) {
          if (e?.code !== "ENOENT") throw e;
        }
        const media = root && join(root, conversationId);
        if (media && (await isRealDir(media))) await rm(media, { recursive: true, force: true });
      }
    });
  }

  /** Aufräumen sofort und dann stündlich; stop() beendet es */
  start(intervalMs = UPLOAD_CLEANUP_INTERVAL_MS): void {
    if (this.timer) return;
    const run = () => {
      this.cleanup().catch(e => this.log(`Aufräumen der Anhänge fehlgeschlagen (${errorName(e)})`));
    };
    this.timer = setInterval(run, intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async list(conversationId: string): Promise<UploadMeta[]> {
    let ids: string[];
    try {
      const conversation = await this.conversationDir(conversationId);
      if (!conversation) return [];
      ids = await readdir(conversation);
    } catch (e: any) {
      if (e?.code === "ENOENT") return [];
      throw e;
    }
    const out: UploadMeta[] = [];
    for (const id of ids) {
      const meta = await this.find(conversationId, id).catch(() => null);
      if (meta) out.push(meta);
    }
    return out;
  }

  /** Neue Datei unter zufälligem Namen, dann umbenannt: ersetzt meta.json (auch einen Symlink), folgt ihm nie */
  private async writeMeta(meta: UploadMeta): Promise<void> {
    const folder = await this.itemDir(meta.conversationId, meta.id);
    if (!folder) throw new Error("Ordner des Anhangs fehlt");
    const file = join(folder, META);
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(meta), { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
  }

  private serial<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.saving.get(conversationId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => {});
    this.saving.set(conversationId, tail);
    void tail.then(() => {
      if (this.saving.get(conversationId) === tail) this.saving.delete(conversationId);
    });
    return next;
  }
}

/** Liste der Anhang-IDs einer Nachricht prüfen; Fehlertext oder null */
export function validateIds(ids: unknown): string | null {
  if (!Array.isArray(ids) || ids.length === 0) return UPLOAD_TEXT.invalidList;
  if (ids.length > MAX_ATTACHMENTS) return UPLOAD_TEXT.tooMany;
  if (!ids.every(isUploadId)) return UPLOAD_TEXT.unknown;
  if (new Set(ids).size !== ids.length) return UPLOAD_TEXT.duplicate;
  return null;
}

/** Echter Ordner, kein Symlink */
async function isRealDir(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return !!info && info.isDirectory() && !info.isSymbolicLink();
}

/** Gewöhnliche Datei, kein Symlink */
async function isRealFile(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  return !!info && info.isFile() && !info.isSymbolicLink();
}

function toAttachment(meta: UploadMeta): MessageAttachment {
  return { id: meta.id, name: meta.name, size: meta.size, mime: meta.mime, kind: meta.kind };
}

function parseMeta(raw: string, conversationId: string, id: string): UploadMeta | null {
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const attachment = pickAttachment(v);
  if (!attachment || attachment.id !== id || v.conversationId !== conversationId) return null;
  if (typeof v.ext !== "string" || !EXT_PATTERN.test(v.ext)) return null;
  if (v.state !== "pending" && v.state !== "sent") return null;
  if (typeof v.createdAt !== "string" || !Number.isFinite(Date.parse(v.createdAt))) return null;
  if (attachment.size > MEDIA_LIMITS[attachment.kind as MediaKind]) return null;
  return { ...attachment, conversationId, ext: v.ext, createdAt: v.createdAt, state: v.state };
}
