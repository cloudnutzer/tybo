// Issue #71: Medien-Kern (src/lib/media-turn.ts). Die Erwartungen unten sind
// aus den Telegram-Handlern in src/bot.ts abgeschrieben (Stand vor dem Umbau)
// und muessen zeichengleich bleiben. src/bot.ts wird nie importiert.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "../src/lib/asset-store";
import {
  checkMediaUpload,
  cleanupMedia,
  defaultMediaDeps,
  detectMedia,
  finishMedia,
  MEDIA_LIMITS,
  MediaRejectedError,
  prepareMedia,
  type MediaDeps,
  type MediaKind,
} from "../src/lib/media-turn";
import * as F from "./media-fixture";

/** handlePhotoMessage: Texte und Metadaten wie vor dem Umbau */
export const PHOTO = {
  defaultCaption: "User sent a photo. Describe and respond to it.",
  prompt: (localPath: string, caption: string, assetId?: string) =>
    `[Image attached: ${localPath}]${assetId ? `\n(asset: ${assetId})` : ""}\n\nUser says: ${caption}`,
  userContent: (caption: string) => `[Photo] ${caption}`,
  userMetadata: (topicId: number | undefined, localPath: string, assetId?: string) =>
    ({ topicId, type: "photo", filePath: localPath, assetId }),
  replyMetadata: (topicId: number | undefined, assetId?: string) => ({ topicId, type: "photo_reply", assetId }),
  foreignInput: "Foto",
  upload: (caption: string, telegramFileId: string, originalFilename: string) =>
    ({ userCaption: caption, channel: "telegram", telegramFileId, originalFilename }),
};

/** handleDocumentMessage */
export const DOCUMENT = {
  defaultCaption: (fileName: string) => `User sent a document: ${fileName}`,
  prompt: (localPath: string, fileName: string, caption: string) =>
    `[User sent a document saved at: ${localPath}, filename: ${fileName}]\n\n${caption}`,
  userContent: (fileName: string, caption: string) => `[Document: ${fileName}] ${caption}`,
  userMetadata: (topicId: number | undefined, localPath: string, fileName: string) =>
    ({ topicId, type: "document", filePath: localPath, fileName }),
  replyMetadata: (topicId: number | undefined) => ({ topicId, type: "document_reply" }),
  foreignInput: "hochgeladene Datei",
};

/** handleVoiceMessage */
export const VOICE = {
  prompt: (transcript: string) => `[Voice message transcription]: ${transcript}`,
  userContent: (transcript: string) => `[Voice message] ${transcript}`,
  userMetadata: (topicId: number | undefined, localPath: string) => ({ topicId, type: "voice", originalFile: localPath }),
  replyMetadata: (topicId: number | undefined) => ({ topicId, type: "voice_reply" }),
};

// ---------------------------------------------------------------------------
// Attrappen: echtes Dateisystem in einem temporären Verzeichnis, Aufrufe mitgeschrieben
// ---------------------------------------------------------------------------

type Calls = {
  mkdir: string[];
  writeFile: string[];
  unlink: string[];
  upload: [string, Record<string, unknown>][];
  describe: [string, string, string[] | undefined][];
  transcribe: string[];
  errors: string[];
};

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-turn-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeDeps(opts: { asset?: string | null; transcript?: string; describeResult?: () => Promise<unknown> } = {}) {
  const calls: Calls = { mkdir: [], writeFile: [], unlink: [], upload: [], describe: [], transcribe: [], errors: [] };
  const uploadsDir = join(dir, "uploads");
  const deps: Partial<MediaDeps> = {
    mkdir: async (p, o) => { calls.mkdir.push(p); return mkdir(p, o); },
    writeFile: async (p, data) => { calls.writeFile.push(p); await writeFile(p, data); },
    unlink: async (p) => { calls.unlink.push(p); await unlink(p); },
    uploadAssetQuick: async (p, o) => {
      calls.upload.push([p, o as Record<string, unknown>]);
      return opts.asset === null ? null : ({ id: opts.asset ?? "asset-1" } as Asset);
    },
    updateAssetDescription: (id, desc, tags) => {
      calls.describe.push([id, desc, tags]);
      return opts.describeResult ? opts.describeResult() : Promise.resolve(null);
    },
    transcribeAudio: async (p) => {
      // Die Datei muss zu diesem Zeitpunkt mit passender Endung liegen
      expect(existsSync(p)).toBe(true);
      calls.transcribe.push(p);
      return opts.transcript ?? "Hallo Welt";
    },
    uploadsDir,
    now: () => 1_700_000_000_000,
    uuid: () => "0000-uuid",
    logError: (m) => { calls.errors.push(m); },
  };
  return { deps, calls, uploadsDir };
}

const TS = 1_700_000_000_000;

describe("Regressionserwartungen (Ist-Zustand): Bild", () => {
  test("Telegram mit Caption und Asset", async () => {
    const { deps, calls, uploadsDir } = fakeDeps({ asset: "a-42" });
    const p = await prepareMedia(
      { kind: "image", bytes: F.JPEG, ext: "jpg", chatId: "1", topicId: 7, caption: "Was ist das?", source: { channel: "telegram", telegramFileId: "tg-file" } },
      deps,
    );
    const path = join(uploadsDir, `photo_${TS}.jpg`);
    expect(p.localPath).toBe(path);
    expect(p.assetId).toBe("a-42");
    expect(p.prompt).toBe(PHOTO.prompt(path, "Was ist das?", "a-42"));
    expect(p.prompt).toBe(`[Image attached: ${path}]\n(asset: a-42)\n\nUser says: Was ist das?`);
    expect(p.classifyText).toBe("Was ist das?");
    expect(p.userContent).toBe("[Photo] Was ist das?");
    expect(p.userMetadata).toEqual(PHOTO.userMetadata(7, path, "a-42"));
    expect(p.replyMetadata).toEqual(PHOTO.replyMetadata(7, "a-42"));
    expect(p.foreignInput).toBe(PHOTO.foreignInput);
    expect(calls.upload).toEqual([[path, PHOTO.upload("Was ist das?", "tg-file", `photo_${TS}.jpg`)]]);
    expect(Object.keys(calls.upload[0][1])).toEqual(["userCaption", "channel", "telegramFileId", "originalFilename"]);
    expect(await readFile(path)).toEqual(Buffer.from(F.JPEG));
  });

  test("Telegram ohne Caption und ohne Asset (Speicher liefert null)", async () => {
    const { deps, calls, uploadsDir } = fakeDeps({ asset: null });
    const p = await prepareMedia(
      { kind: "image", bytes: F.PNG, ext: "png", chatId: "1", caption: "", source: { channel: "telegram", telegramFileId: "tg" } },
      deps,
    );
    const path = join(uploadsDir, `photo_${TS}.png`);
    expect("assetId" in p).toBe(false);
    expect(p.prompt).toBe(PHOTO.prompt(path, PHOTO.defaultCaption));
    expect(p.prompt).toBe(`[Image attached: ${path}]\n\nUser says: User sent a photo. Describe and respond to it.`);
    expect(p.classifyText).toBe(PHOTO.defaultCaption);
    expect(p.userContent).toBe(`[Photo] ${PHOTO.defaultCaption}`);
    expect(p.userMetadata).toEqual({ topicId: undefined, type: "photo", filePath: path, assetId: undefined });
    expect(p.replyMetadata).toEqual({ topicId: undefined, type: "photo_reply", assetId: undefined });
    expect(p.foreignInput).toBe(PHOTO.foreignInput);
    expect(p.foreignInput).toBe("Foto");
    expect(calls.upload[0][1]).toEqual(PHOTO.upload(PHOTO.defaultCaption, "tg", `photo_${TS}.png`));
  });

  test("unsichere Endung fällt auf jpg zurück", async () => {
    const { deps, uploadsDir } = fakeDeps();
    const p = await prepareMedia({ kind: "image", bytes: F.JPEG, ext: "photos/file_1", chatId: "1", source: { channel: "telegram" } }, deps);
    expect(p.localPath).toBe(join(uploadsDir, `photo_${TS}.jpg`));
  });
});

describe("Regressionserwartungen (Ist-Zustand): Dokument", () => {
  test("Telegram mit Caption, Endung aus dem Namen", async () => {
    const { deps, calls, uploadsDir } = fakeDeps();
    const p = await prepareMedia(
      { kind: "document", bytes: F.PDF, ext: "pdf", chatId: "1", topicId: 3, caption: "Fass zusammen", fileName: "Bericht.pdf", source: { channel: "telegram", telegramFileId: "x" } },
      deps,
    );
    const path = join(uploadsDir, "0000-uuid.pdf");
    expect(p.localPath).toBe(path);
    expect(p.prompt).toBe(DOCUMENT.prompt(path, "Bericht.pdf", "Fass zusammen"));
    expect(p.prompt).toBe(`[User sent a document saved at: ${path}, filename: Bericht.pdf]\n\nFass zusammen`);
    expect(p.classifyText).toBe("Fass zusammen");
    expect(p.userContent).toBe("[Document: Bericht.pdf] Fass zusammen");
    expect(p.userMetadata).toEqual(DOCUMENT.userMetadata(3, path, "Bericht.pdf"));
    expect(p.replyMetadata).toEqual(DOCUMENT.replyMetadata(3));
    expect(p.foreignInput).toBe("hochgeladene Datei");
    expect(calls.upload).toEqual([]);
    expect(calls.transcribe).toEqual([]);
  });

  test("Telegram ohne Caption: Vorgabetext mit Dateinamen", async () => {
    const { deps, uploadsDir } = fakeDeps();
    const p = await prepareMedia({ kind: "document", bytes: F.SVG, ext: "svg", chatId: "1", fileName: "logo.svg", source: { channel: "telegram" } }, deps);
    const path = join(uploadsDir, "0000-uuid.svg");
    expect(p.localPath).toBe(path);
    expect(p.prompt).toBe(DOCUMENT.prompt(path, "logo.svg", DOCUMENT.defaultCaption("logo.svg")));
    expect(p.prompt).toBe(`[User sent a document saved at: ${path}, filename: logo.svg]\n\nUser sent a document: logo.svg`);
    expect(p.classifyText).toBe("User sent a document: logo.svg");
    expect(p.userContent).toBe("[Document: logo.svg] User sent a document: logo.svg");
    expect(p.userMetadata).toEqual(DOCUMENT.userMetadata(undefined, path, "logo.svg"));
    expect(p.userMetadata).toEqual({ topicId: undefined, type: "document", filePath: path, fileName: "logo.svg" });
    expect(p.replyMetadata).toEqual(DOCUMENT.replyMetadata(undefined));
    expect(p.replyMetadata).toEqual({ topicId: undefined, type: "document_reply" });
    expect(p.foreignInput).toBe(DOCUMENT.foreignInput);
    expect(p.foreignInput).toBe("hochgeladene Datei");
  });

  test("ohne Dateinamen: document_<ts>, Datei ohne Endung", async () => {
    const { deps, uploadsDir } = fakeDeps();
    const p = await prepareMedia({ kind: "document", bytes: F.bytes("abc"), ext: "", chatId: "1", caption: "", source: { channel: "telegram" } }, deps);
    const path = join(uploadsDir, "0000-uuid");
    expect(p.localPath).toBe(path);
    expect(p.userContent).toBe(`[Document: document_${TS}] User sent a document: document_${TS}`);
    expect(p.userMetadata).toEqual(DOCUMENT.userMetadata(undefined, path, `document_${TS}`));
  });
});

describe("Regressionserwartungen (Ist-Zustand): Sprache", () => {
  test("Telegram: Transkript, Prompt und Einstufung nach dem Prompt", async () => {
    const { deps, calls, uploadsDir } = fakeDeps({ transcript: "Erinnere mich morgen" });
    const p = await prepareMedia({ kind: "audio", bytes: F.OGG_OPUS, ext: "ogg", chatId: "1", topicId: 9, source: { channel: "telegram" } }, deps);
    const path = join(uploadsDir, `voice_${TS}.ogg`);
    expect(p.localPath).toBe(path);
    expect(calls.transcribe).toEqual([path]);
    expect(p.transcript).toBe("Erinnere mich morgen");
    expect(p.prompt).toBe(VOICE.prompt("Erinnere mich morgen"));
    expect(p.prompt).toBe("[Voice message transcription]: Erinnere mich morgen");
    expect(p.classifyText).toBe(p.prompt);
    expect(p.userContent).toBe(VOICE.userContent("Erinnere mich morgen"));
    expect(p.userMetadata).toEqual(VOICE.userMetadata(9, path));
    expect(p.replyMetadata).toEqual(VOICE.replyMetadata(9));
    expect("foreignInput" in p).toBe(false);
    expect(calls.upload).toEqual([]);
  });

  test("Web mit Caption hängt User says an, Endung aus den Bytes", async () => {
    const { deps, calls, uploadsDir } = fakeDeps({ transcript: "Hallo" });
    const p = await prepareMedia(
      { kind: "audio", bytes: F.ftyp("M4A ", "isom"), ext: "ogg", chatId: "1", topicId: 5, caption: "bitte kurz", fileName: "memo.ogg", source: { channel: "web" } },
      deps,
    );
    const path = join(uploadsDir, `voice_${TS}.m4a`);
    expect(p.localPath).toBe(path);
    expect(calls.transcribe).toEqual([path]);
    expect(p.transcript).toBe("Hallo");
    expect(p.prompt).toBe(`${VOICE.prompt("Hallo")}\n\nUser says: bitte kurz`);
    expect(p.prompt).toBe("[Voice message transcription]: Hallo\n\nUser says: bitte kurz");
    expect(p.classifyText).toBe(p.prompt);
    expect(p.classifyText).toBe("[Voice message transcription]: Hallo\n\nUser says: bitte kurz");
    expect(p.userContent).toBe(VOICE.userContent("Hallo"));
    expect(p.userContent).toBe("[Voice message] Hallo");
    expect(p.userMetadata).toEqual(VOICE.userMetadata(5, path));
    expect(p.userMetadata).toEqual({ topicId: 5, type: "voice", originalFile: path });
    expect(p.replyMetadata).toEqual(VOICE.replyMetadata(5));
    expect(p.replyMetadata).toEqual({ topicId: 5, type: "voice_reply" });
    expect("foreignInput" in p).toBe(false);
    expect(calls.upload).toEqual([]);
  });

  test("Transkriptions-Attrappe bekommt je Audioart die passende Endung", async () => {
    const cases: [Uint8Array, string][] = [
      [F.OGG_OPUS, "ogg"], [F.MP3_ID3, "mp3"], [F.ftyp("M4A "), "m4a"], [F.webm([2]), "webm"], [F.WAV, "wav"],
    ];
    for (const [data, ext] of cases) {
      const { deps, calls } = fakeDeps();
      await prepareMedia({ kind: "audio", bytes: data, ext: "bin", chatId: "1", source: { channel: "web" } }, deps);
      expect(calls.transcribe[0].endsWith(`voice_${TS}.${ext}`)).toBe(true);
      await rm(join(dir, "uploads"), { recursive: true, force: true });
    }
  });
});

describe("prepareMedia: Web-Pfad", () => {
  test("PNG mit Namen bild.jpg: Datei .png, Asset-Speicher mit image/png und fileType image", async () => {
    const { deps, calls, uploadsDir } = fakeDeps({ asset: "a-1" });
    const p = await prepareMedia(
      { kind: "image", bytes: F.PNG, ext: "jpg", chatId: "1", caption: "", fileName: "bild.jpg", source: { channel: "web" } },
      deps,
    );
    const path = join(uploadsDir, `photo_${TS}.png`);
    expect(p.localPath).toBe(path);
    expect(calls.upload).toEqual([[path, {
      userCaption: PHOTO.defaultCaption, channel: "web", originalFilename: "bild.jpg", fileType: "image", mimeType: "image/png",
    }]]);
  });

  test("Bild ohne Namen: originalFilename ist der Speichername", async () => {
    const { deps, calls } = fakeDeps();
    await prepareMedia({ kind: "image", bytes: F.WEBP, ext: "", chatId: "1", source: { channel: "web" } }, deps);
    expect(calls.upload[0][1].originalFilename).toBe(`photo_${TS}.webp`);
  });

  test("fileName ../../etc/x.png landet nicht im Speicherpfad", async () => {
    for (const kind of ["image", "document"] as const) {
      const { deps, calls, uploadsDir } = fakeDeps();
      const data = kind === "image" ? F.PNG : F.PDF;
      const p = await prepareMedia({ kind, bytes: data, ext: "png", chatId: "1", fileName: "../../etc/x.png", source: { channel: "web" } }, deps);
      expect(p.localPath.startsWith(uploadsDir + "/")).toBe(true);
      expect(p.localPath).not.toContain("etc");
      expect(p.localPath).not.toContain("x.png");
      expect(calls.writeFile).toEqual([p.localPath]);
      await rm(uploadsDir, { recursive: true, force: true });
    }
  });

  test("Anzeigename aus dem Web bleibt zeichengleich (Textvertrag wie Telegram)", async () => {
    const { deps, calls, uploadsDir } = fakeDeps();
    const name = " a\n]b.pdf ";
    const p = await prepareMedia({ kind: "document", bytes: F.PDF, ext: "pdf", chatId: "1", fileName: name, source: { channel: "web" } }, deps);
    const path = join(uploadsDir, "0000-uuid.pdf");
    expect(p.prompt).toBe(DOCUMENT.prompt(path, name, DOCUMENT.defaultCaption(name)));
    expect(p.userContent).toBe(DOCUMENT.userContent(name, DOCUMENT.defaultCaption(name)));
    expect(p.userMetadata).toEqual(DOCUMENT.userMetadata(undefined, path, name));

    await prepareMedia({ kind: "image", bytes: F.PNG, ext: "png", chatId: "1", fileName: " x\ty.png ", source: { channel: "web" } }, deps);
    expect(calls.upload[0][1].originalFilename).toBe(" x\ty.png ");
  });

  const rejections: [string, MediaKind, Uint8Array][] = [
    ["PDF als Bild angekündigt", "image", F.PDF],
    ["Bild als Sprachdatei angekündigt", "audio", F.PNG],
    ["SVG als Bild", "image", F.SVG],
    ["leere Datei", "document", new Uint8Array(0)],
    ["Bild ein Byte über dem Limit", "image", F.padTo(F.PNG, 20_971_521)],
    ["PDF ein Byte über dem Limit", "document", F.padTo(F.PDF, 20_971_521)],
    ["Audio ein Byte über dem Limit", "audio", F.padTo(F.MP3_ID3, 26_214_401)],
    ["WebM mit Videospur", "audio", F.webm([2, 1])],
    ["WebM mit zweiter Tracks-Liste samt Video", "audio", F.webmTwoTrackLists()],
    ["WebM mit widersprüchlichem TrackType", "audio", F.webmTrackTypes([1, 2])],
    ["WebM mit Tracks über die Segmentgrenze", "audio", F.webmKnownSegment(18)],
    ["WebM: Video nach leerem Cluster, Segment bekannter Größe", "audio", F.webmVideoAfterEmptyCluster({ knownSegment: true, knownCluster: true })],
    ["WebM: Video nach leerem Cluster, Segment unbekannter Größe", "audio", F.webmVideoAfterEmptyCluster({ knownSegment: false, knownCluster: true })],
    ["WebM: Video nach leerem Cluster unbekannter Größe", "audio", F.webmVideoAfterEmptyCluster({ knownSegment: false, knownCluster: false })],
    ["OGG mit OpusHead über zwei Pakete verteilt", "audio", F.oggPageLacing([4, 4], "OpusHead")],
    ["MP4 mit isom", "audio", F.ftyp("isom", "mp41")],
  ];
  for (const [name, kind, data] of rejections) {
    test(`abgelehnt: ${name}, ohne Schreiben, Upload oder Transkription`, async () => {
      const { deps, calls } = fakeDeps();
      const err = await prepareMedia({ kind, bytes: data, ext: "png", chatId: "1", source: { channel: "web" } }, deps).catch(e => e);
      expect(err).toBeInstanceOf(MediaRejectedError);
      expect((err as MediaRejectedError).reason.length).toBeGreaterThan(0);
      expect(calls.mkdir).toEqual([]);
      expect(calls.writeFile).toEqual([]);
      expect(calls.upload).toEqual([]);
      expect(calls.transcribe).toEqual([]);
    });
  }

  test("PDF als Bild: Grund nennt beide Arten", async () => {
    const { deps } = fakeDeps();
    const err = await prepareMedia({ kind: "image", bytes: F.PDF, ext: "jpg", chatId: "1", source: { channel: "web" } }, deps).catch(e => e);
    expect(err.reason).toBe("Die Datei passt nicht zur angegebenen Art: erwartet Bild, erkannt PDF.");
  });

  test("genau am Limit angenommen", async () => {
    const { deps, calls } = fakeDeps();
    await prepareMedia({ kind: "image", bytes: F.padTo(F.PNG, 20_971_520), ext: "", chatId: "1", source: { channel: "web" } }, deps);
    expect(calls.writeFile).toHaveLength(1);
  });
});

describe("prepareMedia: Telegram-Pfad lehnt nichts neu ab", () => {
  test("Datei über dem Limit und unbekannter Typ werden verarbeitet", async () => {
    const big = F.padTo(F.bytes("unbekannt"), 26_214_401);
    for (const kind of ["image", "document", "audio"] as const) {
      const { deps, calls } = fakeDeps();
      const p = await prepareMedia({ kind, bytes: big, ext: "bin", chatId: "1", source: { channel: "telegram" } }, deps);
      expect(calls.writeFile).toEqual([p.localPath]);
      await rm(join(dir, "uploads"), { recursive: true, force: true });
    }
  });

  test("als Dokument gesendetes Bild bleibt Dokument", async () => {
    const { deps, calls, uploadsDir } = fakeDeps();
    const p = await prepareMedia({ kind: "document", bytes: F.PNG, ext: "png", chatId: "1", fileName: "shot.png", source: { channel: "telegram" } }, deps);
    expect(p.localPath).toBe(join(uploadsDir, "0000-uuid.png"));
    expect(p.userMetadata.type).toBe("document");
    expect(calls.upload).toEqual([]);
  });
});

describe("prepareMedia: uploads/ wird rekursiv angelegt", () => {
  test("mkdir mit recursive vor dem Schreiben, auch wenn Zwischenordner fehlen", async () => {
    const { deps, calls } = fakeDeps();
    const deep = join(dir, "a", "b", "uploads");
    const p = await prepareMedia({ kind: "document", bytes: F.PDF, ext: "pdf", chatId: "1", source: { channel: "telegram" } }, { ...deps, uploadsDir: deep });
    expect(calls.mkdir).toEqual([deep]);
    expect(existsSync(p.localPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schritt 2: detectMedia und checkMediaUpload
// ---------------------------------------------------------------------------

describe("detectMedia: erlaubte Arten nur aus den Bytes", () => {
  const cases: [string, Uint8Array, string, string, string][] = [
    ["PNG", F.PNG, "image", "image/png", "png"],
    ["JPEG", F.JPEG, "image", "image/jpeg", "jpg"],
    ["GIF87a", F.GIF87, "image", "image/gif", "gif"],
    ["GIF89a", F.GIF89, "image", "image/gif", "gif"],
    ["WebP", F.WEBP, "image", "image/webp", "webp"],
    ["PDF", F.PDF, "document", "application/pdf", "pdf"],
    ["OGG/Opus", F.OGG_OPUS, "audio", "audio/ogg", "ogg"],
    ["MP3 mit ID3", F.MP3_ID3, "audio", "audio/mpeg", "mp3"],
    ["MP3 Frame-Sync FF Fx", F.MP3_SYNC, "audio", "audio/mpeg", "mp3"],
    ["MP3 Frame-Sync FF Ex", F.MP3_SYNC_E, "audio", "audio/mpeg", "mp3"],
    ["M4A Hauptmarke", F.ftyp("M4A ", "isom"), "audio", "audio/mp4", "m4a"],
    ["M4B Nebenmarke", F.ftyp("isom", "mp42", "M4B "), "audio", "audio/mp4", "m4a"],
    ["WebM nur Audio", F.webm([2]), "audio", "audio/webm", "webm"],
    ["WebM Audio und Untertitel", F.webm([2, 0x11]), "audio", "audio/webm", "webm"],
    ["WebM mit Void vor den Spuren", F.webm([2], { before: F.el(F.ID.Void, F.bytes([0, 0])) }), "audio", "audio/webm", "webm"],
    ["WebM mit bekannter Segmentgröße", F.webmKnownSegment(), "audio", "audio/webm", "webm"],
    ["WebM mit mehreren Clustern bekannter Größe", F.webmAudioClusters({ knownCluster: true }), "audio", "audio/webm", "webm"],
    ["WebM mit mehreren Clustern unbekannter Größe", F.webmAudioClusters({ knownCluster: false }), "audio", "audio/webm", "webm"],
    ["OGG mit OpusHead im ersten von zwei Paketen", F.oggPageLacing([19, 4], F.bytes("OpusHead", new Array(11).fill(0), "Tags")), "audio", "audio/ogg", "ogg"],
    ["WAV", F.WAV, "audio", "audio/wav", "wav"],
  ];
  for (const [name, data, kind, mime, ext] of cases) {
    test(name, () => {
      expect(detectMedia(data)).toEqual({ kind: kind as any, mime, ext });
    });
  }

  test("PNG mit Namen .jpg und angegebenem image/jpeg bleibt PNG (Name und MIME fließen nicht ein)", () => {
    // detectMedia bekommt gar keinen Namen oder MIME-Typ: nur Bytes zählen
    expect(detectMedia.length).toBe(1);
    expect(checkMediaUpload(F.PNG)).toEqual({ ok: true, kind: "image", mime: "image/png", ext: "png" });
  });
});

describe("detectMedia: abgelehnt", () => {
  const rejected: [string, Uint8Array][] = [
    ["SVG", F.SVG],
    ["leere Datei", new Uint8Array(0)],
    ["PNG abgeschnitten", F.PNG.subarray(0, 7)],
    ["JPEG abgeschnitten", F.JPEG.subarray(0, 2)],
    ["GIF abgeschnitten", F.GIF89.subarray(0, 5)],
    ["WebP abgeschnitten", F.WEBP.subarray(0, 11)],
    ["PDF abgeschnitten", F.PDF.subarray(0, 4)],
    ["MP3-Sync mit weniger als 4 Bytes", F.MP3_SYNC.subarray(0, 3)],
    ["ID3 abgeschnitten", F.MP3_ID3.subarray(0, 2)],
    ["RIFF ohne WEBP/WAVE", F.bytes("RIFF", [4, 0, 0, 0], "AVI ")],
    ["MP4 mit Marke isom", F.ftyp("isom", "iso2", "avc1", "mp41")],
    ["MP4 mit Marke mp42", F.ftyp("mp42", "isom")],
    ["ftyp-Box länger als die Datei", F.ftyp("M4A ", "isom").subarray(0, 18)],
    ["M4A nur als Text hinter der ftyp-Box", F.bytes(F.ftyp("isom"), "M4A ")],
    ["OGG ohne OpusHead (Vorbis)", F.oggPage(F.bytes([1], "vorbis", [0, 0, 0, 0]))],
    ["OGG abgeschnitten", F.OGG_OPUS.subarray(0, 30)],
    ["OpusHead nur irgendwo im Text", F.bytes("OggS", [0, 2], "xxxxxxxxxxxxxxxxxxxxOpusHead")],
    ["OGG mit Lacing [4, 4]: Pakete 'Opus' und 'Head'", F.oggPageLacing([4, 4], "OpusHead")],
    ["WebM mit Videospur", F.webm([1])],
    ["WebM mit Audio- und Videospur", F.webm([2, 1])],
    ["WebM ohne Spurtyp", F.webm([null])],
    ["WebM mit zweiter Tracks-Liste samt Video", F.webmTwoTrackLists()],
    ["WebM mit TrackType erst Video, dann Audio", F.webmTrackTypes([1, 2])],
    ["WebM mit TrackType erst Audio, dann Video", F.webmTrackTypes([2, 1])],
    ["WebM mit doppeltem Audio-TrackType", F.webmTrackTypes([2, 2])],
    ["WebM-Audiospur mit Video-Element", F.webmAudioWithVideoElement()],
    ["WebM mit Tracks über die Segmentgrenze", F.webmKnownSegment(18)],
    ["WebM mit Tracks hinter dem Segmentende", F.webmKnownSegment(12)],
    ["WebM: Video nach leerem Cluster, Segment bekannter Größe", F.webmVideoAfterEmptyCluster({ knownSegment: true, knownCluster: true })],
    ["WebM: Video nach leerem Cluster, Segment unbekannter Größe", F.webmVideoAfterEmptyCluster({ knownSegment: false, knownCluster: true })],
    ["WebM: Video nach leerem Cluster unbekannter Größe, Segment bekannter Größe", F.webmVideoAfterEmptyCluster({ knownSegment: true, knownCluster: false })],
    ["WebM: Video nach leerem Cluster unbekannter Größe, Segment unbekannter Größe", F.webmVideoAfterEmptyCluster({ knownSegment: false, knownCluster: false })],
    ["WebM ohne Spuren", F.webm([])],
    ["Matroska statt WebM", F.webm([2], { docType: "matroska" })],
    ["WebM ohne Tracks, Cluster zuerst", F.bytes(F.ebmlHeader(), F.elUnknown(F.ID.Segment, F.elUnknown(F.ID.Cluster)))],
    ["WebM mit Tracks hinter 64 KiB", F.webm([2], { before: F.el(F.ID.Void, new Uint8Array(70_000)) })],
    ["WebM abgeschnitten in den Spuren", F.webm([2]).subarray(0, 40)],
    ["Text mit 'webm' und TrackType-Bytes", F.bytes([0x1a, 0x45, 0xdf, 0xa3], "webm", [0x83, 0x81, 0x02])],
  ];
  for (const [name, data] of rejected) {
    test(name, () => {
      expect(detectMedia(data)).toBeNull();
      const check = checkMediaUpload(data);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason.length).toBeGreaterThan(0);
    });
  }
});

describe("checkMediaUpload: Größengrenzen genau am Limit", () => {
  const MB = 1_048_576;
  const limits: [string, Uint8Array, number][] = [
    ["Bild", F.PNG, 20 * MB],
    ["PDF", F.PDF, 20 * MB],
    ["Audio", F.MP3_ID3, 25 * MB],
  ];
  for (const [name, head, limit] of limits) {
    test(`${name}: ${limit} Bytes angenommen, ${limit + 1} abgelehnt`, () => {
      expect(checkMediaUpload(F.padTo(head, limit)).ok).toBe(true);
      const over = checkMediaUpload(F.padTo(head, limit + 1));
      expect(over.ok).toBe(false);
      if (!over.ok) expect(over.reason).toContain("zu groß");
    });
  }

  test("Grenzen in Bytes wie im Issue", () => {
    expect(MEDIA_LIMITS).toEqual({ image: 20_971_520, document: 20_971_520, audio: 26_214_400 });
  });

  test("leere Datei mit deutschem Grund", () => {
    expect(checkMediaUpload(new Uint8Array(0))).toEqual({ ok: false, reason: "Die Datei ist leer." });
  });
});

// ---------------------------------------------------------------------------
// Schritt 4: finishMedia und cleanupMedia
// ---------------------------------------------------------------------------

async function preparedImage(asset: string | null, deps: Partial<MediaDeps>) {
  return prepareMedia({ kind: "image", bytes: F.JPEG, ext: "jpg", chatId: "1", source: { channel: "telegram" } }, { ...deps, uploadAssetQuick: async () => (asset ? ({ id: asset } as Asset) : null) });
}

describe("finishMedia: Bild", () => {
  test("Nachtrag aus [ASSET_DESC] mit Tags, Tag aus der Antwort entfernt", async () => {
    const { deps, calls } = fakeDeps();
    const p = await preparedImage("a-7", deps);
    const out = finishMedia(p, "Ein Hund am Strand. Schön!\n\n[ASSET_DESC: Hund am Strand | hund, strand]", deps);
    expect(out).toBe("Ein Hund am Strand. Schön!");
    expect(calls.describe).toEqual([["a-7", "Hund am Strand", ["hund", "strand"]]]);
  });

  test("ohne Tag: die ersten zwei Sätze, genau wie bisher zusammengesetzt", async () => {
    const { deps, calls } = fakeDeps();
    const p = await preparedImage("a-8", deps);
    const response = "Ein roter Bus. Er steht vor dem Bahnhof! Dahinter Regen? Noch mehr.";
    expect(finishMedia(p, response, deps)).toBe(response);
    expect(calls.describe).toEqual([["a-8", "Ein roter Bus.  Er steht vor dem Bahnhof!", undefined]]);
    // Bisherige Formel aus handlePhotoMessage
    const expected = response.match(/[^.!?]+[.!?]+/g)!.slice(0, 2).join(" ").trim();
    expect(calls.describe[0][1]).toBe(expected);
  });

  test("ohne Tag und ohne Satzzeichen: kein Nachtrag", async () => {
    const { deps, calls } = fakeDeps();
    const p = await preparedImage("a-9", deps);
    expect(finishMedia(p, "nur ein Wort", deps)).toBe("nur ein Wort");
    expect(calls.describe).toEqual([]);
  });

  test("ohne Asset: kein Nachtrag, Tag trotzdem entfernt", async () => {
    const { deps, calls } = fakeDeps();
    const p = await preparedImage(null, deps);
    expect(finishMedia(p, "Katze. [ASSET_DESC: Katze | tier]", deps)).toBe("Katze.");
    expect(calls.describe).toEqual([]);
  });

  test("ausstehender Nachtrag verzögert die Antwort nicht", async () => {
    const { deps, calls } = fakeDeps({ describeResult: () => new Promise(() => {}) });
    const p = await preparedImage("a-10", deps);
    // finishMedia ist synchron: die Antwort steht sofort, obwohl der Nachtrag nie fertig wird
    const out = finishMedia(p, "Fertig. [ASSET_DESC: x]", deps);
    expect(out).toBe("Fertig.");
    expect(calls.describe).toHaveLength(1);
  });

  test("Fehler beim Nachtrag wird nur geloggt", async () => {
    const { deps, calls } = fakeDeps({ describeResult: () => Promise.reject(new Error("kaputt")) });
    const p = await preparedImage("a-11", deps);
    expect(finishMedia(p, "Gut. Sehr gut.", deps)).toBe("Gut. Sehr gut.");
    await new Promise(r => setTimeout(r, 0));
    expect(calls.errors).toEqual(["Asset desc update error:"]);
  });

  test("synchron werfender Nachtrag wird ebenfalls nur geloggt", async () => {
    const { deps, calls } = fakeDeps();
    const p = await preparedImage("a-12", deps);
    const out = finishMedia(p, "[ASSET_DESC: y] Ok.", { ...deps, updateAssetDescription: () => { throw new Error("sync"); } });
    expect(out).toBe("Ok.");
    expect(calls.errors).toEqual(["Asset desc update error:"]);
  });
});

describe("finishMedia: Dokument und Sprache unverändert", () => {
  test("Antwort bleibt zeichengleich, auch mit Tag", async () => {
    const { deps, calls } = fakeDeps();
    const doc = await prepareMedia({ kind: "document", bytes: F.PDF, ext: "pdf", chatId: "1", source: { channel: "telegram" } }, deps);
    const voice = await prepareMedia({ kind: "audio", bytes: F.OGG_OPUS, ext: "ogg", chatId: "1", source: { channel: "telegram" } }, deps);
    const response = "  Antwort. [ASSET_DESC: z]  ";
    expect(finishMedia(doc, response, deps)).toBe(response);
    expect(finishMedia(voice, response, deps)).toBe(response);
    expect(calls.describe).toEqual([]);
  });
});

describe("cleanupMedia", () => {
  test("löscht die Sprachdatei, Bild und Dokument bleiben liegen", async () => {
    const { deps, calls } = fakeDeps();
    const image = await prepareMedia({ kind: "image", bytes: F.PNG, ext: "png", chatId: "1", source: { channel: "telegram" } }, deps);
    const doc = await prepareMedia({ kind: "document", bytes: F.PDF, ext: "pdf", chatId: "1", source: { channel: "telegram" } }, deps);
    const voice = await prepareMedia({ kind: "audio", bytes: F.OGG_OPUS, ext: "ogg", chatId: "1", source: { channel: "telegram" } }, deps);
    for (const p of [image, doc, voice]) await cleanupMedia(p, deps);
    expect(calls.unlink).toEqual([voice.localPath]);
    expect(existsSync(voice.localPath)).toBe(false);
    expect(existsSync(image.localPath)).toBe(true);
    expect(existsSync(doc.localPath)).toBe(true);
  });

  test("Löschfehler werden verschluckt (asynchron und synchron)", async () => {
    const { deps } = fakeDeps();
    const voice = await prepareMedia({ kind: "audio", bytes: F.OGG_OPUS, ext: "ogg", chatId: "1", source: { channel: "telegram" } }, deps);
    await cleanupMedia(voice, deps);
    // Datei ist schon weg: echtes unlink schlägt fehl
    await expect(cleanupMedia(voice, deps)).resolves.toBeUndefined();
    await expect(cleanupMedia(voice, { ...deps, unlink: () => { throw new Error("sync"); } })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Schritt 5: echte Abhängigkeiten als Default
// ---------------------------------------------------------------------------

describe("Standard-Abhängigkeiten", () => {
  test("Asset-Speicher, Transkription und uploads/ unter process.cwd()", async () => {
    const assetStore = await import("../src/lib/asset-store");
    const transcribe = await import("../src/lib/transcribe");
    expect(defaultMediaDeps.uploadAssetQuick).toBe(assetStore.uploadAssetQuick);
    expect(defaultMediaDeps.updateAssetDescription).toBe(assetStore.updateAssetDescription);
    expect(defaultMediaDeps.transcribeAudio).toBe(transcribe.transcribeAudio);
    expect(defaultMediaDeps.uploadsDir).toBe(join(process.cwd(), "uploads"));
  });

  test("Dateisystem: mkdir, writeFile und unlink wirken wirklich", async () => {
    const target = join(dir, "x", "uploads");
    await defaultMediaDeps.mkdir(target, { recursive: true });
    const file = join(target, "f.bin");
    await defaultMediaDeps.writeFile(file, F.PDF);
    expect(await readFile(file)).toEqual(Buffer.from(F.PDF));
    await defaultMediaDeps.unlink(file);
    expect(existsSync(file)).toBe(false);
  });

  test("uuid und now liefern frische Werte", () => {
    expect(defaultMediaDeps.uuid()).toMatch(/^[0-9a-f-]{36}$/);
    expect(Math.abs(defaultMediaDeps.now() - Date.now())).toBeLessThan(1000);
  });

  test("Teil-Abhängigkeiten ergänzen die Standards (nur uploadsDir und Attrappen ersetzt)", async () => {
    const uploadsDir = join(dir, "u");
    const p = await prepareMedia(
      { kind: "document", bytes: F.PDF, ext: "pdf", chatId: "1", source: { channel: "telegram" } },
      { uploadsDir },
    );
    expect(p.localPath.startsWith(uploadsDir + "/")).toBe(true);
    expect(existsSync(p.localPath)).toBe(true);
  });
});
