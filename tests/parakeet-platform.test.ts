/**
 * Issue #251, Checkbox 2: Artefakt-Konstanten und Plattform-Auswahl für
 * Parakeet über sherpa-onnx. Drei unterstützte Plattformen, alles andere
 * „nicht unterstützt“ und ohne Download.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  artifactsFor,
  MODEL_ARTIFACT,
  parakeetPaths,
  runtimeArtifact,
  selectPlatform,
  SHERPA_VERSION,
  VAD_ARTIFACT,
} from "../src/lib/speech/parakeet";
import { runLocalSpeech, speechPlan, speechPathValues } from "../src/setup/steps/speech";
import { cleanup } from "./setup-fixture";
import { speechCtx } from "./parakeet-fixture";

afterAll(cleanup);

describe("Plattform-Auswahl", () => {
  test.each([
    ["darwin", "arm64", "osx-arm64", "Mac mit Apple Silicon"],
    ["linux", "x64", "linux-x64", "Linux x64"],
    ["linux", "arm64", "linux-aarch64", "Linux arm64"],
  ])("%s %s → %s", (platform, arch, key, label) => {
    expect(selectPlatform(platform, arch)).toEqual({ ok: true, key: key as any, label });
  });

  test.each([
    ["darwin", "x64", "Intel-Mac"],
    ["win32", "x64", "Windows"],
    ["win32", "arm64", "Windows"],
    ["linux", "ia32", "32-Bit-Linux"],
    ["linux", "arm", "32-Bit-Linux"],
    ["freebsd", "x64", "freebsd x64"],
  ])("%s %s: nicht unterstützt (%s), mit Verweis auf whisper.cpp und Cloud", (platform, arch, label) => {
    const sel = selectPlatform(platform, arch);
    expect(sel.ok).toBe(false);
    expect(sel.label).toBe(label);
    if (!sel.ok) {
      expect(sel.reason).toContain(label);
      expect(sel.reason).toContain("whisper.cpp");
      expect(sel.reason).toContain("Cloud");
    }
  });
});

describe("Artefakte als Konstanten", () => {
  test("Laufzeit je Plattform: Datei, Größe und SHA-256 aus der Release-API (Stand 01.10.2026)", () => {
    expect(SHERPA_VERSION).toBe("1.13.8");
    expect(runtimeArtifact("osx-arm64")).toMatchObject({
      file: "sherpa-onnx-v1.13.8-osx-arm64-shared-no-tts.tar.bz2",
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-osx-arm64-shared-no-tts.tar.bz2",
      bytes: 18_252_168,
      sha256: "91b96512c4fa1960f8a9ed5360a6c8dda53a4b5015d0590244f14086a234557a",
      archiveDir: "sherpa-onnx-v1.13.8-osx-arm64-shared-no-tts",
      target: "sherpa-onnx-v1.13.8",
    });
    expect(runtimeArtifact("linux-x64")).toMatchObject({
      file: "sherpa-onnx-v1.13.8-linux-x64-shared-no-tts.tar.bz2",
      bytes: 24_802_494,
      sha256: "d0f96c8b65c6cd0974fada22737e337de81bc8cd2abbec2e39caf358b1eec5fc",
      target: "sherpa-onnx-v1.13.8",
    });
    // Für Linux arm64 gibt es kein no-tts-Paket
    expect(runtimeArtifact("linux-aarch64")).toMatchObject({
      file: "sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu.tar.bz2",
      bytes: 28_091_778,
      sha256: "4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789",
      target: "sherpa-onnx-v1.13.8",
    });
  });

  test("Modell und VAD aus dem Release asr-models", () => {
    expect(MODEL_ARTIFACT).toMatchObject({
      file: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
      bytes: 487_170_055,
      sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
      unpackedBytes: 671_239_000,
      target: "parakeet-tdt-0.6b-v3-int8",
    });
    expect(VAD_ARTIFACT).toMatchObject({
      file: "silero_vad.onnx",
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
      bytes: 643_854,
      sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
      target: "silero_vad.onnx",
    });
    expect(VAD_ARTIFACT.archiveDir).toBeUndefined();
  });

  test("Download je Plattform zwischen 506 und 516 MB, alle Summen sind 64 Hex-Zeichen", () => {
    for (const key of ["osx-arm64", "linux-x64", "linux-aarch64"] as const) {
      const arts = artifactsFor(key);
      expect(arts.map(a => a.id)).toEqual(["laufzeit", "vad", "modell"]);
      const download = arts.reduce((s, a) => s + a.bytes, 0);
      expect(download).toBeGreaterThan(505_000_000);
      expect(download).toBeLessThan(517_000_000);
      for (const a of arts) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("Programm und Bibliothek je Plattform unter models/speech", () => {
    const mac = parakeetPaths("/p/models/speech", "osx-arm64");
    expect(mac.program).toBe("/p/models/speech/sherpa-onnx-v1.13.8/bin/sherpa-onnx-vad-with-offline-asr");
    expect(mac.libs).toEqual(["/p/models/speech/sherpa-onnx-v1.13.8/lib/libonnxruntime.dylib"]);
    expect(mac.encoder).toBe("/p/models/speech/parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx");
    expect(mac.vad).toBe("/p/models/speech/silero_vad.onnx");
    expect(mac.proof).toBe("/p/models/speech/parakeet.ok.json");
    expect(parakeetPaths("/p/models/speech", "linux-aarch64").libs).toEqual(["/p/models/speech/sherpa-onnx-v1.13.8/lib/libonnxruntime.so"]);
  });
});

describe("Nicht unterstützte Plattform lädt nichts", () => {
  test.each([
    ["darwin", "x64"],
    ["win32", "x64"],
    ["linux", "arm"],
  ])("%s %s: Plan ohne Download, Ablauf ohne Netz und ohne Dateien", async (platform, arch) => {
    let fetched = 0;
    const ctx = await speechCtx({
      platform: platform as NodeJS.Platform,
      arch,
      overrides: {
        fetch: async () => {
          fetched++;
          throw new Error("kein Netz");
        },
      },
    });
    const plan = speechPlan(await speechPathValues(ctx)).join(" ");
    expect(plan).toContain("Es wird nichts heruntergeladen.");
    expect(plan).not.toContain("Download ca.");
    const result = await runLocalSpeech({}, ctx, () => {}, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("nichts heruntergeladen");
    expect(result.changed).toEqual([]);
    expect(fetched).toBe(0);
    expect(ctx.run.calls).toEqual([]);
    expect(existsSync(`${ctx.root}/models`)).toBe(false);
  });
});
