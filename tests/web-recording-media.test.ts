// Aufnahmen aus dem Browser (Issue #109, Schritt 3): echte MediaRecorder-
// Proben (Chrome WebM/Opus und MP4/AAC) und ein Safari-artiges fragmentiertes
// MP4 bestehen die Typprüfung, allein aus den Bytes. MP4 ohne M4A-Marke gilt
// nur, wenn jede Spur eine Tonspur ist; Videos bleiben draußen. Dazu der Weg
// über die echte Upload-Route. Herkunft der Proben: tests/fixtures/recordings/README.md.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkMediaUpload, detectMedia } from "../src/web/media-check";
import { SECURITY_HEADERS, type WebServer } from "../src/web/server";
import { TOPIC, makeRoot, startAttachmentServer } from "./attachments-fixture";

const dir = resolve(import.meta.dir, "fixtures", "recordings");
const sample = async (name: string) => new Uint8Array(await readFile(join(dir, name)));

const CHROME_WEBM = await sample("chrome-opus.webm");
const CHROME_AAC = await sample("chrome-aac.mp4");
const CHROME_OPUS_MP4 = await sample("chrome-opus.mp4");
const SAFARI_LIKE = await sample("fragmented-iso5-aac.mp4");
const MOOV_END = await sample("moov-end-aac.mp4");
const VIDEO = await sample("video-only.mp4");
const AUDIO_VIDEO = await sample("audio-video.mp4");

/** Erste Box einer Datei ab offset mit 4-Zeichen-Typ suchen (für gezielte Fälschungen) */
function findBox(bytes: Uint8Array, type: string, from = 0): number {
  const t = [...type].map(c => c.charCodeAt(0));
  for (let i = from; i + 4 <= bytes.length; i++) if (t.every((b, k) => bytes[i + k] === b)) return i - 4;
  return -1;
}

describe("Typprüfung echter Aufnahmen (Issue #109, Schritt 3)", () => {
  test("Chrome WebM/Opus: Sprachdatei audio/webm", () => {
    expect(checkMediaUpload(CHROME_WEBM)).toEqual({ ok: true, kind: "audio", mime: "audio/webm", ext: "webm" });
  });

  test("Chrome MP4/AAC und MP4/Opus (Marke isom, keine M4A-Marke): Sprachdatei audio/mp4", () => {
    for (const bytes of [CHROME_AAC, CHROME_OPUS_MP4]) {
      expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("isom");
      expect(checkMediaUpload(bytes)).toEqual({ ok: true, kind: "audio", mime: "audio/mp4", ext: "m4a" });
    }
  });

  test("fragmentiertes MP4 wie Safari (Marke iso5) und MP4 mit moov am Ende: Sprachdatei", () => {
    expect(detectMedia(SAFARI_LIKE)).toEqual({ kind: "audio", mime: "audio/mp4", ext: "m4a" });
    expect(detectMedia(MOOV_END)).toEqual({ kind: "audio", mime: "audio/mp4", ext: "m4a" });
  });

  test("MP4 mit Videospur, auch neben einer Tonspur: abgelehnt", () => {
    expect(detectMedia(VIDEO)).toBeNull();
    expect(detectMedia(AUDIO_VIDEO)).toBeNull();
    expect(checkMediaUpload(AUDIO_VIDEO).ok).toBe(false);
  });

  test("Tonspur-Handler zu vide umgeschrieben: abgelehnt, egal was ftyp sagt", () => {
    const forged = CHROME_AAC.slice();
    const hdlr = findBox(forged, "hdlr");
    expect(hdlr).toBeGreaterThan(0);
    expect(String.fromCharCode(...forged.subarray(hdlr + 16, hdlr + 20))).toBe("soun");
    forged.set([..."vide"].map(c => c.charCodeAt(0)), hdlr + 16);
    expect(detectMedia(forged)).toBeNull();
    // Unbekannter Handler (etwa Text) ebenso
    forged.set([..."text"].map(c => c.charCodeAt(0)), hdlr + 16);
    expect(detectMedia(forged)).toBeNull();
  });

  test("abgeschnittene Datei, zweite moov-Box oder moov ohne Spur: abgelehnt", () => {
    expect(detectMedia(CHROME_AAC.subarray(0, CHROME_AAC.length - 3))).toBeNull();
    const moov = findBox(CHROME_AAC, "moov");
    const moovSize = new DataView(CHROME_AAC.buffer, CHROME_AAC.byteOffset).getUint32(moov);
    const twice = new Uint8Array([...CHROME_AAC, ...CHROME_AAC.subarray(moov, moov + moovSize)]);
    expect(detectMedia(twice)).toBeNull();
    const noTrack = CHROME_AAC.slice();
    const trak = findBox(noTrack, "trak");
    noTrack.set([..."free"].map(c => c.charCodeAt(0)), trak + 4);
    expect(detectMedia(noTrack)).toBeNull();
  });
});

const root = await makeRoot("tybo-web-recording-");
afterAll(() => root.cleanup());
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

describe("Upload-Route mit echten Aufnahmen (Issue #109, Schritt 3)", () => {
  test("WebM aus Chrome und MP4 wie aus Safari werden angenommen, Name bleibt, Endung aus den Bytes", async () => {
    const ctx = await startAttachmentServer({ dir: root.next(), servers });
    const webm = await ctx.upload(TOPIC, CHROME_WEBM, { "content-type": "audio/webm", "x-file-name": "aufnahme-20260925-130405.webm" });
    expect(webm.status).toBe(201);
    expect(await webm.json()).toMatchObject({ name: "aufnahme-20260925-130405.webm", size: CHROME_WEBM.length, mime: "audio/webm", kind: "audio" });
    const mp4 = await ctx.upload(TOPIC, SAFARI_LIKE, { "content-type": "audio/mp4", "x-file-name": "aufnahme-20260925-130405.m4a" });
    expect(mp4.status).toBe(201);
    expect(await mp4.json()).toMatchObject({ name: "aufnahme-20260925-130405.m4a", mime: "audio/mp4", kind: "audio" });
    const aac = await ctx.upload(TOPIC, CHROME_AAC, { "content-type": "audio/mp4" });
    expect(await aac.json()).toMatchObject({ mime: "audio/mp4", kind: "audio" });
  });

  test("MP4 mit Video unter Audio-Namen und Audio-Typ: 415", async () => {
    const ctx = await startAttachmentServer({ dir: root.next(), servers });
    const res = await ctx.upload(TOPIC, AUDIO_VIDEO, { "content-type": "audio/mp4", "x-file-name": "aufnahme-20260925-130405.m4a" });
    expect(res.status).toBe(415);
  });
});

describe("CSP für die Wiedergabe (Issue #109)", () => {
  test("media-src erlaubt nur die eigene Seite und blob:, script-src bleibt streng", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"]!;
    expect(csp).toContain("media-src 'self' blob:;");
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toMatch(/script-src[^;]*(blob:|unsafe|data:)/);
    expect(csp).not.toMatch(/img-src[^;]*blob:/);
  });
});
