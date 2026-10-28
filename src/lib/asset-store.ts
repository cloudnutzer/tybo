/**
 * Bilder und Dateien für die Kanäle (Issue #318): dünne Schicht über
 * getStore().assets, mit den Namen, die bot.ts, vps-gateway.ts und
 * media-turn.ts aufrufen. Ohne Datenbank ist der Store-Teil ein Platzhalter;
 * dann wird nichts gespeichert (null) und der Medien-Turn läuft weiter.
 *
 * Mac-Weg: Bild hochladen mit Platzhalter-Beschreibung (uploadAssetQuick),
 * Claude liest die Datei selbst, die Beschreibung aus [ASSET_DESC] kommt
 * danach über updateAssetDescription. VPS-Weg: Beschreibung vorher per
 * Vision-Modell (describeImageFromBuffer), dann uploadAssetFromBuffer.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { storeOr } from "./store";
import type { Asset, AssetUpload } from "./store/types";

export { DEFAULT_ASSETS_BUCKET, assetsBucket } from "./assets/bucket";
export { parseAssetDescTag, stripAssetDescTag } from "./assets/tags";
export {
  describeImageBytes as describeImageFromBuffer,
  describeImageFile as describeImage,
  type VisionResult,
} from "./assets/describe";
export type { Asset } from "./store/types";

/** Was die Kanäle zu einer Datei mitgeben (Bildtext, Kanal, Telegram-Datei-ID ...) */
export type AssetMetadata = Partial<Record<"userCaption" | "conversationContext" | "relatedProject" | "channel" | "telegramFileId", string>>;

/** Hochladen aus dem Speicher: mit fertiger Beschreibung, optional Schlagwörtern und Projektvorschlag */
type PreparedUpload = AssetMetadata &
  Pick<AssetUpload, "description" | "tags" | "fileType" | "mimeType"> & { suggestedProject?: string | null };

/** Hochladen von der Platte: Name und Typ dürfen vom Pfad abweichen */
type FileUpload = AssetMetadata & Partial<Record<"originalFilename" | "fileType" | "mimeType", string>>;

/** Was ohne Beschreibung im Feld steht, bis [ASSET_DESC] sie nachträgt */
const PENDING_DESCRIPTION = "Image (pending description)";

/**
 * Datei aus dem Speicher hochladen. Die Telegram-Datei-ID landet in metadata,
 * das vorgeschlagene Projekt gewinnt vor relatedProject.
 */
export const uploadAssetFromBuffer = (bytes: Uint8Array, name: string, info: PreparedUpload): Promise<Asset | null> => {
  const upload: AssetUpload = {
    data: bytes,
    filename: name,
    description: info.description,
    tags: info.tags,
    fileType: info.fileType,
    mimeType: info.mimeType,
    userCaption: info.userCaption,
    conversationContext: info.conversationContext,
    relatedProject: info.suggestedProject || info.relatedProject || null,
    channel: info.channel,
    metadata: { telegramFileId: info.telegramFileId },
  };
  return storeOr(null, store => store.assets.upload(upload));
};

/** Datei von der Platte hochladen; Beschreibung erst einmal der Bildtext oder ein Platzhalter */
export const uploadAssetQuick = async (path: string, info: FileUpload): Promise<Asset | null> => {
  const bytes = await readFile(path).catch((err: unknown) => {
    console.error("[Bilder] Datei nicht lesbar:", err instanceof Error ? err.message : "Fehler");
    return null;
  });
  if (!bytes) return null;
  const { originalFilename, ...rest } = info;
  const description = info.userCaption || PENDING_DESCRIPTION;
  return uploadAssetFromBuffer(bytes, originalFilename || basename(path), { ...rest, description, tags: [], suggestedProject: null });
};

/** Beschreibung (samt Vektor) nachtragen; ohne Datenbank nichts */
export const updateAssetDescription = async (id: string, text: string, keywords?: string[], project?: string | null): Promise<void> => {
  await storeOr(undefined, store => store.assets.setDescription(id, text, keywords, project));
};

/** Ein gespeichertes Bild mit frisch signiertem Link; ohne Datenbank null */
export const getAssetById = (id: string): Promise<Asset | null> => storeOr(null, store => store.assets.byId(id));
