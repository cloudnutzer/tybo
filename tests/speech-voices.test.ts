/**
 * Issue #253, Checkbox 1: Ablage eigener Stimmen (src/lib/speech/voices.ts)
 * und Kennzeichnung geklonter Ausgaben (src/lib/speech/wav.ts). Ohne
 * Einwilligung kein Speichern; Löschen entfernt Referenz, Text, Einwilligung
 * und alles Abgeleitete.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/brand";
import {
  checkReferenceWav,
  cleanVoiceName,
  createVoiceStore,
  deviceLabel,
  MAX_VOICES,
  VOICE_CONSENT_TEXT,
  VOICE_READING_TEXT,
} from "../src/lib/speech/voices";
import { AI_CLONED_NOTE, AI_GENERATED_NOTE, CLONED_VOICE_NOTE, readWavInfo, tagWavAiGenerated } from "../src/lib/speech/wav";
import { infoChunk, recordingWav } from "./voice-clone-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function store(ids: string[] = ["0123456789abcdef", "fedcba9876543210", "1111222233334444"]) {
  const root = mkdtempSync(join(tmpdir(), "voices-"));
  roots.push(root);
  const dir = join(root, "data", "speech", "voices");
  let n = 0;
  return { dir, root, s: createVoiceStore({ dir, now: () => new Date("2026-10-01T10:00:00Z"), newId: () => ids[n++] ?? `${String(n).padStart(16, "0")}` }) };
}

const valid = (extra: Partial<{ name: unknown; consent: unknown; device: string; audio: Buffer }> = {}) => ({
  name: "Alex",
  consent: true,
  device: "Chrome auf macOS",
  audio: recordingWav(8),
  ...extra,
});

describe("Ablage: ohne Einwilligung kein Speichern", () => {
  for (const consent of [false, undefined, null, "true", "ja", 1, {}]) {
    test(`consent ${JSON.stringify(consent) ?? "undefined"}: abgelehnt, kein Ordner angelegt`, async () => {
      const { s, dir, root } = store();
      const r = await s.create(valid({ consent }));
      expect(r).toEqual({ ok: false, reason: "einwilligung" });
      expect(existsSync(dir)).toBe(false);
      expect(readdirSync(root)).toEqual([]);
    });
  }

  test("Einwilligung wird vor allem anderen geprüft: auch mit ungültiger Aufnahme kein Ordner", async () => {
    const { s, dir } = store();
    expect(await s.create(valid({ consent: false, audio: Buffer.from("kein wav") }))).toEqual({ ok: false, reason: "einwilligung" });
    expect(existsSync(dir)).toBe(false);
  });
});

describe("Ablage: Anlegen", () => {
  test("legt Referenz, Text, Einwilligung und Metadaten mit engen Rechten ab", async () => {
    const { s, dir } = store();
    const r = await s.create(valid());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.voice.id).toBe("0123456789abcdef");
    expect(r.voice.label).toBe("Alex (KI-Stimme)");
    expect(r.voice.seconds).toBe(8);
    const vdir = join(dir, r.voice.id);
    expect(readdirSync(vdir).sort()).toEqual(["consent.json", "meta.json", "reference.wav", "text.txt"]);
    expect(statSync(vdir).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(vdir)) expect(statSync(join(vdir, f)).mode & 0o777).toBe(0o600);
    const consent = JSON.parse(readFileSync(join(vdir, "consent.json"), "utf8"));
    expect(consent).toEqual({ version: 1, text: VOICE_CONSENT_TEXT, confirmedAt: "2026-10-01T10:00:00.000Z", device: "Chrome auf macOS" });
    expect(readFileSync(join(vdir, "text.txt"), "utf8").trim()).toBe(VOICE_READING_TEXT);
    // Keine Temp-Reste
    expect(readdirSync(dir)).toEqual([r.voice.id]);
  });

  test("Referenz neu geschrieben: nur Kopf und Abtastwerte, keine Metadaten aus der Aufnahme", async () => {
    const { s } = store();
    const audio = recordingWav(6, { extra: infoChunk("aus dem Browser") });
    const r = await s.create(valid({ audio }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ref = readFileSync(r.voice.referencePath);
    expect(readWavInfo(ref)).toEqual({});
    expect(ref.length).toBe(44 + 6 * 24_000 * 2);
    expect(ref.subarray(44).equals(audio.subarray(audio.length - 6 * 24_000 * 2))).toBe(true);
  });

  test("Aufnahme prüfen: Format, Dauer, Größe", async () => {
    const { s, dir } = store();
    const cases: [Buffer, string][] = [
      [Buffer.alloc(0), "leer"],
      [Buffer.from("1A45DFA3", "hex"), "format"],
      [recordingWav(8, { channels: 2 }), "format"],
      [recordingWav(8, { bits: 8 }), "format"],
      [recordingWav(8, { format: 3, bits: 32 }), "format"],
      [recordingWav(8, { rate: 8_000 }), "format"],
      [recordingWav(4), "zu-kurz"],
      [recordingWav(31, { rate: 16_000 }), "zu-lang"],
      [recordingWav(33, { rate: 48_000 }), "zu-gross"],
    ];
    for (const [audio, reason] of cases) expect(await s.create(valid({ audio }))).toEqual({ ok: false, reason: reason as never });
    expect(existsSync(dir)).toBe(false);
    expect(checkReferenceWav(recordingWav(5)).ok).toBe(true);
    expect(checkReferenceWav(recordingWav(30, { rate: 16_000 })).ok).toBe(true);
  });

  test("Name: Pflicht, höchstens 40 Zeichen, nur einfache Zeichen", async () => {
    const { s, dir } = store();
    for (const name of ["", "   ", 7, "a".repeat(41), "<script>", "Alex/../x", "\u0000x"]) {
      expect(await s.create(valid({ name }))).toEqual({ ok: false, reason: "name" });
    }
    expect(existsSync(dir)).toBe(false);
    expect(cleanVoiceName("  Mia   Müller-Lang  ")).toBe("Mia Müller-Lang");
    expect(cleanVoiceName("O'Neil Jr.")).toBe("O'Neil Jr.");
  });

  test(`höchstens ${MAX_VOICES} Stimmen`, async () => {
    const ids = Array.from({ length: MAX_VOICES + 1 }, (_, i) => i.toString(16).padStart(16, "a"));
    const { s } = store(ids);
    for (let i = 0; i < MAX_VOICES; i++) expect((await s.create(valid())).ok).toBe(true);
    expect(await s.create(valid())).toEqual({ ok: false, reason: "zu-viele" });
    expect((await s.list()).length).toBe(MAX_VOICES);
  });

  test("Gerät nur grob aus dem User-Agent", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari auf iPhone");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36")).toBe("Chrome auf macOS");
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox auf Linux");
    expect(deviceLabel("")).toBe("unbekanntes Gerät");
  });
});

describe("Ablage: Lesen nur mit gültiger Einwilligung", () => {
  test("fehlt consent.json oder ist sie verändert, gibt es die Stimme nicht", async () => {
    const { s, dir } = store();
    const r = await s.create(valid());
    if (!r.ok) throw new Error("angelegt erwartet");
    const consentPath = join(dir, r.voice.id, "consent.json");
    const original = readFileSync(consentPath, "utf8");
    writeFileSync(consentPath, original.replace(VOICE_CONSENT_TEXT, "anderer Text"));
    expect(await s.get(r.voice.id)).toBeNull();
    unlinkSync(consentPath);
    expect(await s.get(r.voice.id)).toBeNull();
    expect(await s.list()).toEqual([]);
    writeFileSync(consentPath, original);
    expect((await s.get(r.voice.id))?.name).toBe("Alex");
  });

  test("Kennungen nur nach Muster: keine Pfade", async () => {
    const { s } = store();
    for (const id of ["../x", "0123456789ABCDEF", "", "0123456789abcde"]) {
      expect(await s.get(id)).toBeNull();
      expect(await s.remove(id)).toBe(false);
    }
  });
});

describe("Ablage: Löschen entfernt alles", () => {
  test("Referenz, Text, Einwilligung, Metadaten und abgeleitete Dateien sind weg", async () => {
    const { s, dir } = store();
    const a = await s.create(valid());
    const b = await s.create(valid({ name: "Mia" }));
    if (!a.ok || !b.ok) throw new Error("angelegt erwartet");
    // Abgeleiteter Zustand eines Anbieters im Ordner der Stimme
    writeFileSync(join(dir, a.voice.id, "state.safetensors"), "x");
    expect(await s.remove(a.voice.id)).toBe(true);
    expect(existsSync(join(dir, a.voice.id))).toBe(false);
    expect(await s.get(a.voice.id)).toBeNull();
    expect((await s.list()).map(v => v.name)).toEqual(["Mia"]);
    expect(await s.remove(a.voice.id)).toBe(false);
  });
});

describe("Kennzeichnung geklonter Ausgaben", () => {
  test("ICMT trägt beide Hinweise in einem Kommentar", () => {
    expect(AI_CLONED_NOTE).toBe(`KI-generiert (${BRAND.name}), ${CLONED_VOICE_NOTE}`);
    const tagged = tagWavAiGenerated(recordingWav(1), { cloned: true });
    expect(readWavInfo(tagged)).toEqual({ ICMT: AI_CLONED_NOTE, ISFT: BRAND.name });
  });

  test("wiederholtes Markieren ändert nichts", () => {
    const once = tagWavAiGenerated(recordingWav(1), { cloned: true });
    expect(tagWavAiGenerated(once, { cloned: true }).equals(once)).toBe(true);
  });

  test("schon mit Grundhinweis markiert: genau ein Block mit beiden Hinweisen, Ton unverändert", () => {
    const wav = recordingWav(1);
    const base = tagWavAiGenerated(wav);
    expect(readWavInfo(base).ICMT).toBe(AI_GENERATED_NOTE);
    const cloned = tagWavAiGenerated(base, { cloned: true });
    expect(readWavInfo(cloned).ICMT).toBe(AI_CLONED_NOTE);
    expect(cloned.toString("latin1").split("LIST").length - 1).toBe(1);
    expect(cloned.readUInt32LE(4)).toBe(cloned.length - 8);
    expect(cloned.subarray(0, wav.length).subarray(12).equals(wav.subarray(12))).toBe(true);
  });

  test("Grundhinweis allein bleibt wie bisher", () => {
    const tagged = tagWavAiGenerated(recordingWav(1));
    expect(readWavInfo(tagged).ICMT).toBe(AI_GENERATED_NOTE);
    expect(tagWavAiGenerated(tagged).equals(tagged)).toBe(true);
  });
});
