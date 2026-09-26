// Arbeitsdateien aus Web und Telegram (Issue #72, Prüfung von PR #96): beide
// legen Bilder als photo_<Zeit> und Sprache als voice_<Zeit> ab. Web nutzt
// einen eigenen Unterordner, damit gleiche Zeitpunkte sich nicht treffen:
// Pfade und Inhalte bleiben getrennt, das Löschen der Sprachdatei trifft nur
// die eigene.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { cleanupMedia, prepareMedia, type MediaDeps, type PreparedMedia } from "../src/lib/media-turn";
import { createTelegramChat, webMediaDir } from "../src/web/bot-turn";
import { UploadStore } from "../src/web/uploads";
import { bytes, OGG_OPUS, PNG } from "./media-fixture";

const root = await mkdtemp(join(tmpdir(), "tybo-web-media-collision-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const TG_PNG = bytes(PNG, "telegram-bild");
const TG_OGG = bytes(OGG_OPUS, "telegram-sprache");

/** Zeitpunkt aus photo_<Zeit>.<Endung> bzw. voice_<Zeit>.<Endung> */
function stamp(path: string): number {
  return Number(/_(\d+)\./.exec(basename(path))![1]);
}

describe("Web- und Telegram-Arbeitsdateien", () => {
  test("gleicher Zeitpunkt: Bild und Sprache aus Web und Telegram an getrennten Pfaden, Inhalte unverändert, Löschen nur der eigenen Sprachdatei", async () => {
    const mediaDir = join(root, "uploads");
    const uploads = new UploadStore({ dir: join(root, "data-uploads"), log: () => {} });
    const image = await uploads.save("dm", PNG, "web.png");
    const voice = await uploads.save("dm", OGG_OPUS, "web.ogg");
    if (!image.ok || !voice.ok) throw new Error("Ablegen gescheitert");
    const claimed = await uploads.claim("dm", [image.attachment.id, voice.attachment.id]);
    if (!claimed.ok) throw new Error("Annehmen gescheitert");

    const webWritten: string[] = [];
    const tgWritten: string[] = [];
    const common: Partial<MediaDeps> = {
      uploadsDir: mediaDir,
      uploadAssetQuick: async () => null,
      transcribeAudio: async () => "Transkript",
      logError: () => {},
    };
    let telegram: PreparedMedia[] = [];

    const chat = createTelegramChat({
      userId: "4711",
      groupId: () => null,
      agentForTopic: () => undefined,
      runStreamingTurn: async () => {
        // Während der Web-Turn läuft: Telegram bereitet eigene Dateien mit genau
        // den Zeitpunkten der Web-Dateien vor
        const [webImage, webVoice] = webWritten;
        telegram = [
          await prepareMedia(
            { kind: "image", bytes: TG_PNG, ext: "png", chatId: "4711", source: { channel: "telegram" } },
            { ...common, now: () => stamp(webImage), writeFile: async (p, d) => { tgWritten.push(p); await writeFile(p, d); } }
          ),
          await prepareMedia(
            { kind: "audio", bytes: TG_OGG, ext: "ogg", chatId: "4711", source: { channel: "telegram" } },
            { ...common, now: () => stamp(webVoice), writeFile: async (p, d) => { tgWritten.push(p); await writeFile(p, d); } }
          ),
        ];
        // Gleiche Namen, verschiedene Ordner
        expect(tgWritten.map(p => basename(p))).toEqual(webWritten.map(p => basename(p)));
        for (const p of tgWritten) expect(webWritten).not.toContain(p);
        expect(new Set(webWritten.map(p => dirname(p)))).toEqual(new Set([webMediaDir(mediaDir)]));
        expect(new Set(tgWritten.map(p => dirname(p)))).toEqual(new Set([mediaDir]));
        // Keine Seite hat die Datei der anderen überschrieben
        expect(new Uint8Array(await readFile(webImage))).toEqual(PNG);
        expect(new Uint8Array(await readFile(webVoice))).toEqual(OGG_OPUS);
        expect(new Uint8Array(await readFile(tgWritten[0]))).toEqual(TG_PNG);
        expect(new Uint8Array(await readFile(tgWritten[1]))).toEqual(TG_OGG);
        return "Antwort";
      },
      saveMessage: async () => true,
      processIntents: async () => {},
      abortClaudeCalls: () => 0,
      isShuttingDown: () => false,
      scheduleRestartCheck: () => {},
      sendPlain: async () => {},
      sendFile: async () => {},
      sendAsAgent: async () => {},
      uploads,
      media: {
        ...common,
        mkdir: (p, o) => mkdir(p, o),
        writeFile: async (p, d) => {
          webWritten.push(p);
          await writeFile(p, d);
        },
      },
      log: () => {},
    });

    const result = await chat.runTurn({
      conversationId: "dm",
      agent: "general",
      text: "",
      attachments: claimed.attachments,
      sink: { progress: () => {}, notice: () => {} },
    });
    expect(result.failed).toBeUndefined();
    expect(result.text).toBe("Antwort");
    expect(webWritten).toHaveLength(2);
    expect(tgWritten).toHaveLength(2);

    // Nach dem Web-Turn: nur die Web-Sprachdatei ist weg
    expect(existsSync(webWritten[1])).toBe(false);
    expect(existsSync(webWritten[0])).toBe(true);
    expect(new Uint8Array(await readFile(tgWritten[1]))).toEqual(TG_OGG);
    expect(new Uint8Array(await readFile(tgWritten[0]))).toEqual(TG_PNG);

    // Telegram räumt seine Sprachdatei auf: das Web-Bild bleibt
    for (const p of telegram) await cleanupMedia(p, common);
    expect(existsSync(tgWritten[1])).toBe(false);
    expect(new Uint8Array(await readFile(webWritten[0]))).toEqual(PNG);
    expect(new Uint8Array(await readFile(tgWritten[0]))).toEqual(TG_PNG);
  });
});
