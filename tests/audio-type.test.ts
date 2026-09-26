/**
 * Issue #78, Checkbox 2: detectAudioType erkennt das Format an den Bytes
 * (src/lib/audio-type.ts). Nur Ogg/Opus, WAV und MP3 gelten als Audio;
 * HTML, SVG, leere und zu kurze Daten nie, auch nicht mit Audio-Endung.
 */
import { describe, expect, test } from "bun:test";
import { detectAudioType, MIN_AUDIO_BYTES } from "../src/lib/audio-type";
import { htmlFixture, mp3FrameFixture, mp3Id3Fixture, oggOpusFixture, oggVorbisFixture, svgFixture, wavFixture } from "./audio-fixture";

describe("detectAudioType", () => {
  test("MP3 mit ID3-Kopf", () => {
    expect(detectAudioType(mp3Id3Fixture())).toEqual({ mime: "audio/mpeg", ext: ".mp3" });
  });

  test("MP3 mit Frame-Sync ohne ID3", () => {
    expect(detectAudioType(mp3FrameFixture())).toEqual({ mime: "audio/mpeg", ext: ".mp3" });
  });

  test("WAV (RIFF…WAVE)", () => {
    expect(detectAudioType(wavFixture())).toEqual({ mime: "audio/wav", ext: ".wav" });
  });

  test("Ogg mit Opus", () => {
    expect(detectAudioType(oggOpusFixture())).toEqual({ mime: "audio/ogg", ext: ".ogg" });
  });

  test("Ogg ohne Opus (Vorbis): kein Sprachnachrichten-Format", () => {
    expect(detectAudioType(oggVorbisFixture())).toBeNull();
  });

  test("HTML und SVG werden abgelehnt, egal welcher Name gemeint war", () => {
    for (const data of [htmlFixture(), svgFixture()]) expect(detectAudioType(data)).toBeNull();
    // Der Name spielt keine Rolle: die Funktion sieht nur die Bytes
    const named = { "antwort.mp3": htmlFixture(), "antwort.ogg": svgFixture(), "antwort.wav": htmlFixture() };
    for (const data of Object.values(named)) expect(detectAudioType(data)).toBeNull();
  });

  test("leere, fehlende und zu kurze Daten werden abgelehnt", () => {
    expect(detectAudioType(new Uint8Array(0))).toBeNull();
    expect(detectAudioType(null)).toBeNull();
    expect(detectAudioType(undefined)).toBeNull();
    for (const full of [mp3Id3Fixture(), mp3FrameFixture(), wavFixture(), oggOpusFixture()]) {
      expect(detectAudioType(full.subarray(0, MIN_AUDIO_BYTES - 1))).toBeNull();
    }
    // Nur ein Kopf ohne Inhalt
    expect(detectAudioType(Buffer.from("RIFF\0\0\0\0WAVE"))).toBeNull();
  });

  test("ungültige MPEG-Köpfe und kaputtes ID3 gelten nicht als MP3", () => {
    const pad = new Uint8Array(100);
    // reservierte Version, reservierter Layer, ungültige Bitrate, reservierte Abtastrate
    for (const head of [[0xff, 0xeb, 0x90, 0], [0xff, 0xf9, 0x90, 0], [0xff, 0xfb, 0xf0, 0], [0xff, 0xfb, 0x9c, 0]]) {
      expect(detectAudioType(Buffer.concat([Buffer.from(head), pad]))).toBeNull();
    }
    expect(detectAudioType(Buffer.concat([Buffer.from("ID3"), Buffer.from([9, 0, 0, 0, 0, 0, 0]), pad]))).toBeNull();
    expect(detectAudioType(Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0, 0x80, 0, 0, 0]), pad]))).toBeNull();
    // Zufälliger Text
    expect(detectAudioType(Buffer.from("x".repeat(200)))).toBeNull();
  });
});
