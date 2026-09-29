/**
 * Medien-Kern: Bild, Dokument und Sprache unabhaengig vom Kanal vorbereiten
 * und nachbereiten (Issue #71, Entscheidung 0012).
 *
 * Uebernimmt, was die Telegram-Handler in src/bot.ts heute tun: Datei unter
 * uploads/ ablegen, Bild in den Asset-Speicher, Sprache transkribieren,
 * Prompt und Nachrichten bauen. Nach dem Turn: Bildbeschreibung aus der
 * Antwort nachtragen, Sprachdatei loeschen. Den Claude-Aufruf, das Speichern
 * der Nachrichten und das Zustellen macht der Kanal.
 */

import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseAssetDescTag,
  stripAssetDescTag,
  updateAssetDescription,
  uploadAssetQuick,
  type Asset,
} from "./asset-store";
import { transcribeAudio } from "./transcribe";
import { MEDIA_KIND_LABEL, checkMediaUpload, type MediaKind } from "../web/media-check";

// Typprüfung und Grenzen liegen in src/web/media-check.ts (ohne Abhängigkeiten, auch für den Web-Server)
export {
  MEDIA_LIMITS,
  checkMediaUpload,
  detectMedia,
  type DetectedMedia,
  type MediaCheck,
  type MediaKind,
} from "../web/media-check";

export interface MediaSource {
  channel: "telegram" | "web";
  telegramFileId?: string;
}

export interface MediaInput {
  kind: MediaKind;
  bytes: Uint8Array;
  /** Gewuenschte Endung ohne Punkt; im Web-Pfad durch die erkannte ersetzt */
  ext: string;
  chatId: string;
  topicId?: number;
  /** Nutzertext ohne Vorgabe */
  caption?: string;
  /** Nur Anzeigename, nie Teil des Speicherpfads */
  fileName?: string;
  source: MediaSource;
}

export interface PreparedMedia {
  kind: MediaKind;
  localPath: string;
  assetId?: string;
  transcript?: string;
  prompt: string;
  classifyText: string;
  userContent: string;
  userMetadata: Record<string, unknown>;
  replyMetadata: Record<string, unknown>;
  foreignInput?: string;
}

type AssetUploadOptions = {
  userCaption?: string;
  channel?: string;
  telegramFileId?: string;
  originalFilename?: string;
  fileType?: string;
  mimeType?: string;
};

export interface MediaDeps {
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  uploadAssetQuick: (localPath: string, options: AssetUploadOptions) => Promise<Asset | null>;
  updateAssetDescription: (assetId: string, description: string, tags?: string[]) => Promise<unknown>;
  transcribeAudio: (filePath: string) => Promise<string>;
  uploadsDir: string;
  now: () => number;
  uuid: () => string;
  logError: (message: string, err: unknown) => void;
}

export class MediaRejectedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "MediaRejectedError";
  }
}

const KIND_LABEL = MEDIA_KIND_LABEL;

// ---------------------------------------------------------------------------
// Vorbereitung vor dem Turn
// ---------------------------------------------------------------------------

// Wie PROJECT_ROOT in src/bot.ts: uploads/ unter dem Arbeitsverzeichnis des Bots
const PROJECT_ROOT = process.cwd();

const defaultDeps: MediaDeps = {
  mkdir: (path, options) => mkdir(path, options),
  writeFile: (path, data) => writeFile(path, data),
  unlink: (path) => unlink(path),
  uploadAssetQuick,
  updateAssetDescription,
  transcribeAudio,
  uploadsDir: join(PROJECT_ROOT, "uploads"),
  now: () => Date.now(),
  uuid: () => crypto.randomUUID(),
  logError: (message, err) => console.error(message, err),
};

/** Nur für Tests: die verdrahteten Standard-Abhängigkeiten */
export const defaultMediaDeps: Readonly<MediaDeps> = defaultDeps;

function resolveDeps(deps?: Partial<MediaDeps>): MediaDeps {
  return deps ? { ...defaultDeps, ...deps } : defaultDeps;
}

/** Name einer Arbeitsdatei: Art, Zeitpunkt und UUID, z. B. photo_1700000000000_<uuid>.jpg (Issue #190) */
export function uploadName(prefix: string, ts: number, uuid: string, dot: string): string {
  return `${prefix}_${ts}_${uuid}${dot}`;
}

const SAFE_EXT = /^[a-zA-Z0-9]{1,10}$/;
const FALLBACK_EXT: Record<MediaKind, string> = { image: "jpg", document: "", audio: "ogg" };

/**
 * Datei ablegen und je Art vorbereiten (Bild: Asset-Speicher, Sprache:
 * Transkript). Im Web-Pfad vorher Typ und Größe prüfen; eine Ablehnung wirft
 * MediaRejectedError, bevor irgendetwas geschrieben oder hochgeladen wird.
 * Telegram prüft nicht neu (die Bot API liefert höchstens 20 MB).
 */
export async function prepareMedia(input: MediaInput, deps?: Partial<MediaDeps>): Promise<PreparedMedia> {
  const d = resolveDeps(deps);
  const { kind, topicId } = input;
  const web = input.source.channel === "web";

  let ext = input.ext;
  let mime: string | undefined;
  if (web) {
    const check = checkMediaUpload(input.bytes);
    if (!check.ok) throw new MediaRejectedError(check.reason);
    if (check.kind !== kind) {
      throw new MediaRejectedError(
        `Die Datei passt nicht zur angegebenen Art: erwartet ${KIND_LABEL[kind]}, erkannt ${KIND_LABEL[check.kind]}.`,
      );
    }
    ext = check.ext;
    mime = check.mime;
  }
  if (!SAFE_EXT.test(ext)) ext = FALLBACK_EXT[kind];
  const dot = ext ? `.${ext}` : "";

  // Zeit plus UUID (Issue #190): zwei Uploads in derselben Millisekunde bekommen verschiedene Namen
  const ts = d.now();
  const storedName =
    kind === "image" ? uploadName("photo", ts, d.uuid(), dot) : kind === "audio" ? uploadName("voice", ts, d.uuid(), dot) : `${d.uuid()}${dot}`;
  const localPath = join(d.uploadsDir, storedName);

  await d.mkdir(d.uploadsDir, { recursive: true });
  await d.writeFile(localPath, input.bytes);

  const fileName = input.fileName;

  if (kind === "image") {
    const caption = input.caption || "User sent a photo. Describe and respond to it.";
    const asset = await d.uploadAssetQuick(localPath, {
      userCaption: caption,
      channel: input.source.channel,
      ...(web ? {} : { telegramFileId: input.source.telegramFileId }),
      originalFilename: fileName || storedName,
      // Im Web den erkannten Typ mitgeben: der Asset-Speicher leitet ihn sonst aus dem Namen ab
      ...(web ? { fileType: "image", mimeType: mime } : {}),
    });
    const assetId = asset?.id;
    const assetNote = asset ? `\n(asset: ${asset.id})` : "";
    return {
      kind,
      localPath,
      ...(assetId ? { assetId } : {}),
      prompt: `[Image attached: ${localPath}]${assetNote}\n\nUser says: ${caption}`,
      classifyText: caption,
      userContent: `[Photo] ${caption}`,
      userMetadata: { topicId, type: "photo", filePath: localPath, assetId },
      replyMetadata: { topicId, type: "photo_reply", assetId },
      foreignInput: "Foto",
    };
  }

  if (kind === "document") {
    const name = fileName || `document_${ts}`;
    const caption = input.caption || `User sent a document: ${name}`;
    return {
      kind,
      localPath,
      prompt: `[User sent a document saved at: ${localPath}, filename: ${name}]\n\n${caption}`,
      classifyText: caption,
      userContent: `[Document: ${name}] ${caption}`,
      userMetadata: { topicId, type: "document", filePath: localPath, fileName: name },
      replyMetadata: { topicId, type: "document_reply" },
      foreignInput: "hochgeladene Datei",
    };
  }

  // Scheitert die Transkription (Fehler, Abbruch), gibt es kein PreparedMedia
  // und damit kein cleanupMedia: die Sprachdatei hier löschen
  let transcript: string;
  try {
    transcript = await d.transcribeAudio(localPath);
  } catch (e) {
    await Promise.resolve()
      .then(() => d.unlink(localPath))
      .catch(() => {});
    throw e;
  }
  // Caption bei Sprache gibt es nur aus dem Web
  const prompt = `[Voice message transcription]: ${transcript}${input.caption ? `\n\nUser says: ${input.caption}` : ""}`;
  return {
    kind,
    localPath,
    transcript,
    prompt,
    classifyText: prompt,
    userContent: `[Voice message] ${transcript}`,
    userMetadata: { topicId, type: "voice", originalFile: localPath },
    replyMetadata: { topicId, type: "voice_reply" },
  };
}

// ---------------------------------------------------------------------------
// Nachverarbeitung nach dem Turn
// ---------------------------------------------------------------------------

/**
 * Bereinigte Antwort. Beim Bild mit Asset wird die Beschreibung aus
 * [ASSET_DESC] (sonst aus den ersten zwei Sätzen) nachgetragen, ohne darauf
 * zu warten; Fehler landen nur im Log. Der Tag wird immer entfernt.
 */
export function finishMedia(prepared: PreparedMedia, response: string, deps?: Partial<MediaDeps>): string {
  if (prepared.kind !== "image") return response;
  const d = resolveDeps(deps);
  const assetId = prepared.assetId;
  if (assetId) {
    const logFailure = (err: unknown) => d.logError("Asset desc update error:", err);
    const update = (description: string, tags?: string[]) => {
      try {
        const pending = tags === undefined
          ? d.updateAssetDescription(assetId, description)
          : d.updateAssetDescription(assetId, description, tags);
        Promise.resolve(pending).catch(logFailure);
      } catch (err) {
        logFailure(err);
      }
    };
    const parsed = parseAssetDescTag(response);
    if (parsed) {
      update(parsed.description, parsed.tags);
    } else {
      // Fallback: die ersten zwei Sätze der Antwort
      const sentences = response.match(/[^.!?]+[.!?]+/g);
      if (sentences && sentences.length > 0) update(sentences.slice(0, 2).join(" ").trim());
    }
  }
  return stripAssetDescTag(response);
}

/** Sprachdatei löschen (Fehler verschluckt); Bild und Dokument bleiben liegen. Scheitert prepareMedia bei Sprache, löscht es selbst. */
export async function cleanupMedia(prepared: PreparedMedia, deps?: Partial<MediaDeps>): Promise<void> {
  if (prepared.kind !== "audio") return;
  const d = resolveDeps(deps);
  await Promise.resolve()
    .then(() => d.unlink(prepared.localPath))
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Mehrere Anhänge in einem Turn (Web-Chat, Issue #72)
// ---------------------------------------------------------------------------

/** Ein Anhang ohne Nutzertext: wie im Prompt, ohne „User says" */
function attachmentHeader(p: PreparedMedia, index: number, count: number): string {
  if (p.kind === "image") {
    return `[Image ${index} of ${count} attached: ${p.localPath}]${p.assetId ? `\n(asset: ${p.assetId})` : ""}`;
  }
  if (p.kind === "document") {
    const name = typeof p.userMetadata.fileName === "string" ? p.userMetadata.fileName : "";
    return `[User sent a document saved at: ${p.localPath}, filename: ${name}]`;
  }
  return `[Voice message transcription]: ${p.transcript ?? ""}`;
}

/**
 * Prompt für einen Turn mit allen Anhängen einer Nachricht. Ein Anhang: genau
 * der Prompt aus prepareMedia (wie in Telegram). Mehrere: je Anhang eine
 * nummerierte Zeile, dann einmal der Nutzertext. Bei mehreren Bildern wird
 * je Bild ein [ASSET_DESC]-Tag in Bildreihenfolge verlangt, damit
 * finishMediaTurn jede Beschreibung dem richtigen Bild zuordnet.
 */
export function buildMediaPrompt(prepared: PreparedMedia[], text: string): string {
  if (prepared.length === 1) return prepared[0].prompt;
  const parts = prepared.map((p, i) => attachmentHeader(p, i + 1, prepared.length));
  const images = prepared.filter(p => p.kind === "image").length;
  if (images > 1) {
    parts.push(
      `There are ${images} images. Include one [ASSET_DESC: ...] tag per image at the end, in the order of the images (image 1 first).`,
    );
  }
  parts.push(
    text.trim()
      ? `User says: ${text}`
      : `User sent ${prepared.length} attachments. Describe and respond to them.`,
  );
  return parts.join("\n\n");
}

/**
 * Nachverarbeitung aller Anhänge eines Turns; gibt die bereinigte Antwort
 * zurück. Ein Anhang: finishMedia unverändert. Mehrere: das n-te
 * [ASSET_DESC]-Tag gehört zum n-ten Bild; ein Bild ohne eigenes Tag behält
 * seinen Platzhalter, statt die Beschreibung eines anderen zu bekommen.
 */
export function finishMediaTurn(prepared: PreparedMedia[], response: string, deps?: Partial<MediaDeps>): string {
  if (prepared.length === 0) return response;
  if (prepared.length === 1) return finishMedia(prepared[0], response, deps);
  const tags = response.match(/\[ASSET_DESC:[^\]]+\]/g) ?? [];
  prepared
    .filter(p => p.kind === "image")
    .forEach((p, i) => {
      if (tags[i]) finishMedia(p, tags[i], deps);
    });
  return stripAssetDescTag(response);
}
