/**
 * Issue #190, Checkbox 3: data/topics-asked.json in derselben Schreibkette
 * wie config/topics.json, und eindeutige Namen für Telegram-Uploads.
 * Eigene Dateien im Temp-Verzeichnis; src/bot.ts wird nie geladen.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { claimTopicMappingQuestion, setTopicsAskedFileForTests, shouldAskTopicMapping } from "../src/lib/topic-setup";
import { cleanupMedia, prepareMedia, uploadName, type MediaDeps } from "../src/lib/media-turn";
import { bytes, OGG_OPUS, PNG } from "./media-fixture";

const root = await mkdtemp(join(tmpdir(), "tybo-issue-190-"));
afterAll(() => rm(root, { recursive: true, force: true }));
afterEach(() => setTopicsAskedFileForTests(null));

let n = 0;
function askedFile(): string {
  const file = join(root, `topics-asked-${++n}.json`);
  setTopicsAskedFileForTests(file);
  return file;
}

describe("topics-asked.json serialisiert", () => {
  test("zwei gleichzeitige neue Topics behalten beide ihren Eintrag", async () => {
    const file = askedFile();
    const results = await Promise.all([claimTopicMappingQuestion("-1001", 7), claimTopicMappingQuestion("-1001", 8)]);
    expect(results).toEqual([true, true]);
    const asked = JSON.parse(await readFile(file, "utf8"));
    expect(Object.keys(asked).sort()).toEqual(["-1001:7", "-1001:8"]);
    expect(await shouldAskTopicMapping("-1001", 7)).toBe(false);
    expect(await shouldAskTopicMapping("-1001", 8)).toBe(false);
  });

  test("viele gleichzeitige Topics: kein Eintrag geht verloren", async () => {
    const file = askedFile();
    const ids = Array.from({ length: 20 }, (_, i) => i + 100);
    expect(await Promise.all(ids.map(id => claimTopicMappingQuestion("-1001", id)))).toEqual(ids.map(() => true));
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")))).toHaveLength(20);
  });

  test("zwei gleichzeitige Nachrichten im selben Topic: genau eine stellt die Frage", async () => {
    askedFile();
    const results = await Promise.all([
      claimTopicMappingQuestion("-1001", 9),
      claimTopicMappingQuestion("-1001", 9),
      claimTopicMappingQuestion("-1001", 9),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claimTopicMappingQuestion("-1001", 9)).toBe(false);
  });

  test("bestehende Einträge bleiben, schon gefragte Topics werden nicht erneut gefragt", async () => {
    const file = askedFile();
    await writeFile(file, JSON.stringify({ "-1001:5": 1 }));
    expect(await claimTopicMappingQuestion("-1001", 5)).toBe(false);
    expect(await claimTopicMappingQuestion("-1001", 6)).toBe(true);
    expect(Object.keys(JSON.parse(await readFile(file, "utf8"))).sort()).toEqual(["-1001:5", "-1001:6"]);
  });
});

describe("Upload-Namen eindeutig", () => {
  const TS = 1_700_000_000_000;

  test("zwei Bilder und zwei Sprachnachrichten in derselben Millisekunde: verschiedene Namen, eigene Inhalte, Aufräumen nur der eigenen", async () => {
    const uploadsDir = join(root, "uploads");
    const deps: Partial<MediaDeps> = {
      uploadsDir,
      now: () => TS,
      uploadAssetQuick: async () => null,
      transcribeAudio: async () => "Transkript",
      logError: () => {},
    };
    const tg = { channel: "telegram" as const };
    const [img1, img2, voice1, voice2] = await Promise.all([
      prepareMedia({ kind: "image", bytes: bytes(PNG, "bild-1"), ext: "png", chatId: "1", source: tg }, deps),
      prepareMedia({ kind: "image", bytes: bytes(PNG, "bild-2"), ext: "png", chatId: "1", source: tg }, deps),
      prepareMedia({ kind: "audio", bytes: bytes(OGG_OPUS, "sprache-1"), ext: "ogg", chatId: "1", source: tg }, deps),
      prepareMedia({ kind: "audio", bytes: bytes(OGG_OPUS, "sprache-2"), ext: "ogg", chatId: "1", source: tg }, deps),
    ]);
    const paths = [img1, img2, voice1, voice2].map(p => p.localPath);
    expect(new Set(paths).size).toBe(4);
    for (const p of paths.slice(0, 2)) expect(basename(p)).toMatch(new RegExp(`^photo_${TS}_[0-9a-f-]{36}\\.png$`));
    for (const p of paths.slice(2)) expect(basename(p)).toMatch(new RegExp(`^voice_${TS}_[0-9a-f-]{36}\\.ogg$`));

    expect(new Uint8Array(await readFile(img1.localPath))).toEqual(bytes(PNG, "bild-1"));
    expect(new Uint8Array(await readFile(img2.localPath))).toEqual(bytes(PNG, "bild-2"));
    expect(new Uint8Array(await readFile(voice1.localPath))).toEqual(bytes(OGG_OPUS, "sprache-1"));
    expect(new Uint8Array(await readFile(voice2.localPath))).toEqual(bytes(OGG_OPUS, "sprache-2"));

    // Die erste Sprachdatei aufräumen: die zweite und die Bilder bleiben
    await cleanupMedia(voice1, deps);
    expect(existsSync(voice1.localPath)).toBe(false);
    expect(new Uint8Array(await readFile(voice2.localPath))).toEqual(bytes(OGG_OPUS, "sprache-2"));
    expect(existsSync(img1.localPath)).toBe(true);
    expect(existsSync(img2.localPath)).toBe(true);
  });

  test("Fotopfad von /process und Videos: gleicher Zeitpunkt, verschiedene Namen", () => {
    const a = uploadName("photo", TS, crypto.randomUUID(), ".jpg");
    const b = uploadName("photo", TS, crypto.randomUUID(), ".jpg");
    expect(a).not.toBe(b);
    expect(a).toMatch(new RegExp(`^photo_${TS}_[0-9a-f-]{36}\\.jpg$`));
  });
});
