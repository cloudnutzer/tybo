/**
 * Issue #251, Checkbox 5: Pfad „Sprechmodus lokal“ im Schritt „sprache“:
 * Bestandsaufnahme, Vorschlag, Probe am Kandidaten mit Wortfehler-Grenze und
 * Stille-Probe, Nachweis, Einstellung über updateSettings() mit dem Pfad des
 * Assistenten, dazu die Funktionen für tybo pruefen und tybo deinstallieren. Alles mit
 * Attrappen (tests/parakeet-fixture.ts); kein Download, kein tar, kein
 * sherpa-onnx, kein ffmpeg.
 */

import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettingsPath, setSettingsPath } from "../src/lib/settings";
import { buildProof, checkProof, parakeetPaths, speechDir } from "../src/lib/speech/parakeet";
import { createSttProviders } from "../src/lib/speech/providers";
import type { RunEvent } from "../src/setup/model";
import { MAX_WER, normalizeWords, wordErrorRate } from "../src/setup/parakeet-probe";
import { checkLocalStt, effectiveStt, removeSpeechModels } from "../src/setup/speech-maintenance";
import { existingFieldValues } from "../src/setup/steps";
import {
  AUTO_EXPLANATION,
  runLocalSpeech,
  SPEECH_FIELDS,
  speechPathValues,
  speechPlan,
  speechStep,
  statFile,
  SWITCH_AUTO_FIELD,
  SWITCH_FIELD,
} from "../src/setup/steps/speech";
import { speechFindings } from "../src/setup/checks/speech";
import { realUninstallDeps, runUninstallCommand } from "../src/setup/services/uninstall";
import { cleanup, FULL_ENV } from "./setup-fixture";
import { runWith, scripted } from "./setup-terminal-fixture";
import {
  fakeDownloads,
  fakeProcesses,
  GIB,
  pathsOf,
  placeFiles,
  readJson,
  SOLLTEXT,
  speechCtx,
  STDERR_MARKER,
  testArtifacts,
  type SherpaMode,
  type SpeechCtxOptions,
} from "./parakeet-fixture";

const dirs: string[] = [];
afterEach(() => setSettingsPath());
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  await cleanup();
});

/** Kontext mit Download-Server, tar und sherpa als Attrappen; Artefakte klein und mit eigener Prüfsumme */
async function world(o: SpeechCtxOptions & { sherpa?: SherpaMode } = {}) {
  const ctx = await speechCtx(o);
  const paths = pathsOf(ctx);
  const arts = testArtifacts(paths);
  const downloads = fakeDownloads(arts);
  const procs = fakeProcesses(arts, o.sherpa ?? "gut");
  ctx.fetch = downloads.fetch;
  ctx.run = procs.run as typeof ctx.run;
  ctx.speechArtifacts = arts.map(a => a.art);
  return { ctx, paths, arts, downloads, procs };
}

async function run(ctx: Awaited<ReturnType<typeof world>>["ctx"], values: Record<string, string> = {}, signal = new AbortController().signal) {
  const events: RunEvent[] = [];
  const result = await runLocalSpeech(values, ctx, e => events.push(e), signal);
  return { result, events };
}

function sherpaCalls(procs: { run: { calls: string[][] } }) {
  return procs.run.calls.filter(c => c[0].endsWith("sherpa-onnx-vad-with-offline-asr"));
}

async function writeValidProof(paths: ReturnType<typeof pathsOf>) {
  const proof = buildProof(paths, "osx-arm64", statFile, { wer: 0.05, ms: 400, at: "2026-10-01T00:00:00.000Z" })!;
  await writeFile(paths.proof, JSON.stringify(proof));
}

const readText = (p: string) => readFile(p, "utf8").catch(() => null);

describe("Wortfehlerrate", () => {
  test("Normalisierung: klein, ohne Satzzeichen, Ziffern als deutsche Zahlwörter", () => {
    expect(normalizeWords("Um 3 Uhr, beim Zahnarzt!")).toEqual(["um", "drei", "uhr", "beim", "zahnarzt"]);
    expect(normalizeWords("21 und 100 und 7")).toEqual(["einundzwanzig", "und", "einhundert", "und", "sieben"]);
  });

  test("Probe-Ausgabe von sherpa (ein Wort falsch) liegt unter der Grenze, ein ganz anderer Satz darüber", () => {
    const heard = "Guten Morgen. Bitte erinnere mich heute um 3 Uhr an den Termin beim Tanarzt. Und schreib mir danach eine kurze Einkaufsliste.";
    expect(wordErrorRate(SOLLTEXT, heard)).toBeCloseTo(1 / 21, 5);
    expect(wordErrorRate(SOLLTEXT, "Hallo Welt, das ist etwas ganz anderes.")).toBeGreaterThan(MAX_WER);
    expect(MAX_WER).toBe(0.2);
  });

  test("Solltext liegt neben der Probe-WAV (PCM16, 16 kHz, mono)", async () => {
    const wav = await readFile(join(import.meta.dir, "..", "setup", "assets", "parakeet-probe-de.wav"));
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect((await readFile(join(import.meta.dir, "..", "setup", "assets", "parakeet-probe-de.txt"), "utf8")).trim()).toBe(SOLLTEXT);
  });
});

describe("Bestandsaufnahme und Vorschlag", () => {
  test("unter 4 GiB: deutlicher Hinweis mit vorhandenen Alternativen", async () => {
    const ctx = await speechCtx({ ramBytes: 2 * GIB, programs: ["ffmpeg", "whisper-cli"], env: "ELEVENLABS_API_KEY=el-test-schluessel\n" });
    await mkdir(join(ctx.root, "models"), { recursive: true });
    await writeFile(join(ctx.root, "models", "ggml-medium.bin"), "m");
    const plan = speechPlan(await speechPathValues(ctx)).join("\n");
    expect(plan).toContain("Achtung: Dieser Rechner hat 2,0 GiB Arbeitsspeicher, Parakeet braucht beim Erkennen ca. 2 GB.");
    expect(plan).toContain("Alternative: das vorhandene whisper.cpp oder Spracherkennung in der Cloud mit dem vorhandenen Schlüssel (ElevenLabs).");
    expect(plan).not.toContain("el-test-schluessel");
    const ok = await speechCtx({ ramBytes: 8 * GIB });
    expect(speechPlan(await speechPathValues(ok)).join("\n")).not.toContain("Achtung");
  });

  test("Status: fehlt, teilweise (Dateien ohne Probe, Probe ohne Einstellung), erledigt", async () => {
    const { ctx, paths } = await world();
    expect((await speechStep.status(ctx)).state).toBe("fehlt");
    await placeFiles(paths, ["vad"]);
    expect((await speechStep.status(ctx)).detail).toContain("unvollständig");
    await placeFiles(paths);
    expect(await speechStep.status(ctx)).toMatchObject({ state: "teilweise", detail: expect.stringContaining("die Probe fehlt") });
    await writeValidProof(paths);
    expect(await speechStep.status(ctx)).toMatchObject({ state: "teilweise", detail: expect.stringContaining("Hören steht aber auf auto") });
    await writeFile(ctx.settingsPath, JSON.stringify({ speech: { stt: "parakeet" } }));
    expect((await speechStep.status(ctx)).state).toBe("erledigt");
  });
});

describe("Ablauf: Download, Probe, Nachweis, Einstellung", () => {
  test("Probe bestanden: Nachweis, speech.stt = parakeet, andere Werte unverändert, Namensnennung", async () => {
    const settings = { speech: { tts: "browser", language: "de", effort: "medium" }, fallback: { ollamaModel: "qwen3:8b" } };
    const { ctx, paths, downloads, procs } = await world({ settings: JSON.stringify(settings) });
    // Die globale Einstellungsdatei zeigt woanders hin: der Assistent schreibt trotzdem in ctx.settingsPath
    const other = join(await mkdtemp(join(tmpdir(), "andere-settings-")), "settings.json");
    dirs.push(other);
    setSettingsPath(other);
    const { result, events } = await run(ctx, {});
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Parakeet ist eingerichtet. Probe bestanden. Erkannt in");
    expect(result.message).toContain("Wortfehlerrate 5 %");
    expect(result.message).toContain("Hören steht jetzt fest auf Parakeet");
    expect(result.message).toContain("von NVIDIA, Lizenz CC-BY-4.0");
    expect(result.changed).toEqual([speechDir(ctx.root), ctx.settingsPath]);
    expect(await readJson(ctx.settingsPath)).toEqual({ ...settings, speech: { ...settings.speech, stt: "parakeet" } });
    expect(existsSync(other)).toBe(false);
    expect(getSettingsPath()).toBe(other);
    // Nachweis passt zu den Dateien
    const proof = await readJson(paths.proof);
    expect(proof).toMatchObject({ version: 1, sherpa: "1.13.8", model: "parakeet-tdt-0.6b-v3-int8", platform: "osx-arm64", probe: { wer: 0.048 } });
    expect(checkProof(await readText(paths.proof), paths, "osx-arm64", statFile)).toEqual({ ok: true });
    // Probe: Sprache und Stille, beide am Kandidaten
    const probes = sherpaCalls(procs);
    expect(probes.length).toBe(2);
    expect(probes[1][probes[1].length - 1]).toContain("stille");
    expect(downloads.calls.length).toBe(3);
    // Fortschritt mit festen Sätzen
    expect(events.map(e => e.label)).toEqual(
      expect.arrayContaining(["Lade Laufzeit sherpa-onnx (18 MB)", "Probe mit einer deutschen Aufnahme und mit Stille", "Einstellung fürs Hören"]),
    );
    expect(events.every(e => !JSON.stringify(e).includes(STDERR_MARKER))).toBe(true);
    // Schritt erledigt, Anbieter verfügbar
    expect((await speechStep.status(ctx)).state).toBe("erledigt");
    const provider = createSttProviders({
      env: () => ({}), run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }), fetch: globalThis.fetch,
      exists: existsSync, which: () => null, readFile: async () => Buffer.alloc(0), writeFile: async () => {}, unlink: async () => {},
      mkdir: async () => {}, cwd: () => ctx.root, tmpDir: ctx.root, unique: () => "x", platform: "darwin", arch: "arm64",
    }).find(p => p.id === "parakeet")!;
    expect(provider.available()).toEqual({ ok: true });
    // Keine Reste
    expect((await import("node:fs/promises")).readdir(speechDir(ctx.root)).then(l => l.filter(n => n.endsWith(".part") || n.startsWith(".tmp-")))).resolves.toEqual([]);
  });

  test("Probe über der Grenze: kein Nachweis, speech.stt unverändert", async () => {
    const before = JSON.stringify({ speech: { stt: "auto", tts: "browser" } });
    const { ctx, paths } = await world({ sherpa: "schlecht", settings: before });
    const { result } = await run(ctx, { [SWITCH_AUTO_FIELD]: "true" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Probe nicht bestanden");
    expect(result.message).toContain("Erlaubt sind höchstens 20 %");
    expect(result.message).toContain("Kein Nachweis geschrieben, Hören bleibt unverändert.");
    expect(existsSync(paths.proof)).toBe(false);
    expect(await readFile(ctx.settingsPath, "utf8")).toBe(before);
    expect((await speechStep.status(ctx)).state).toBe("teilweise");
  });

  test("Stille-Probe: erkennt das Programm Text in der Stille, gibt es keinen Nachweis", async () => {
    const { ctx, paths } = await world({ sherpa: "stille-text" });
    const { result } = await run(ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Stille-Probe nicht bestanden");
    expect(existsSync(paths.proof)).toBe(false);
    expect(existsSync(ctx.settingsPath)).toBe(false);
  });

  test("Programm scheitert bei der Probe: Meldung ohne stderr, kein Nachweis", async () => {
    const { ctx, paths } = await world({ sherpa: "exit" });
    const { result } = await run(ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Exit-Code 3");
    expect(result.message).not.toContain(STDERR_MARKER);
    expect(existsSync(paths.proof)).toBe(false);
  });

  test("vorhandenes Modell mit gültigem Nachweis: nichts geladen, keine Probe, nur die Einstellung", async () => {
    const { ctx, paths, downloads, procs } = await world();
    await placeFiles(paths);
    await writeValidProof(paths);
    const plan = speechPlan(await speechPathValues(ctx)).join(" ");
    expect(plan).toContain("Es wird nichts geladen und nichts neu geprüft.");
    expect(plan).not.toContain("Download ca.");
    const { result } = await run(ctx, {});
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Parakeet ist schon eingerichtet, nichts geladen.");
    expect(downloads.calls).toEqual([]);
    expect(procs.run.calls).toEqual([]);
    expect((await readJson(ctx.settingsPath)).speech.stt).toBe("parakeet");
  });

  test("Abbruch bei vorhandener Installation (stt=auto, Signal schon abgebrochen): Einstellung bleibt, Lauf endet abgebrochen", async () => {
    const before = JSON.stringify({ speech: { stt: "auto" } });
    const { ctx, paths, downloads, procs } = await world({ settings: before });
    await placeFiles(paths);
    await writeValidProof(paths);
    const proofBefore = await readText(paths.proof);
    const ac = new AbortController();
    ac.abort();
    const { result } = await run(ctx, { [SWITCH_AUTO_FIELD]: "true" }, ac.signal);
    expect(result).toEqual({ ok: false, message: "Abgebrochen. Nichts wurde geändert.", changed: [] });
    expect(await readFile(ctx.settingsPath, "utf8")).toBe(before);
    expect(await readText(paths.proof)).toBe(proofBefore);
    expect(downloads.calls).toEqual([]);
    expect(procs.run.calls).toEqual([]);
  });

  test("Abbruch unmittelbar vor dem Einstellungswechsel: Nachweis ja, Einstellung unverändert, Lauf endet abgebrochen", async () => {
    const before = JSON.stringify({ speech: { stt: "auto" } });
    const { ctx, paths } = await world({ settings: before });
    await placeFiles(paths);
    const ac = new AbortController();
    const result = await runLocalSpeech({ [SWITCH_AUTO_FIELD]: "true" }, ctx, e => {
      if (e.label === "Einstellung fürs Hören") ac.abort();
    }, ac.signal);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Probe bestanden.");
    expect(result.message).toEndWith("Abgebrochen. Hören ist nicht umgestellt.");
    expect(result.changed).not.toContain(ctx.settingsPath);
    expect(await readFile(ctx.settingsPath, "utf8")).toBe(before);
    expect(existsSync(paths.proof)).toBe(true);
  });

  test("Abbruch nach der Probe, vor dem Schreiben des Nachweises: kein Nachweis, Einstellung unverändert", async () => {
    const before = JSON.stringify({ speech: { stt: "auto" } });
    const { ctx, paths } = await world({ settings: before });
    await placeFiles(paths);
    const ac = new AbortController();
    const now = ctx.now;
    // now() läuft beim Bauen des Nachweises, also nach bestandener Probe
    ctx.now = () => {
      ac.abort();
      return now();
    };
    const { result } = await run(ctx, { [SWITCH_AUTO_FIELD]: "true" }, ac.signal);
    expect(result).toEqual({ ok: false, message: "Abgebrochen. Kein Nachweis geschrieben.", changed: [] });
    expect(existsSync(paths.proof)).toBe(false);
    expect(await readFile(ctx.settingsPath, "utf8")).toBe(before);
  });

  test("Dateien da, Nachweis fehlt: nichts geladen, nur die Probe", async () => {
    const { ctx, paths, downloads, procs } = await world();
    await placeFiles(paths);
    expect(speechPlan(await speechPathValues(ctx)).join(" ")).toContain("Es wird nichts geladen, nur die Probe läuft noch einmal.");
    const { result } = await run(ctx, {});
    expect(result.ok).toBe(true);
    expect(downloads.calls).toEqual([]);
    expect(sherpaCalls(procs).length).toBe(2);
    expect(existsSync(paths.proof)).toBe(true);
  });

  test("Nachweis entwertet (nur Änderungszeit) und Wiederholung scheitert: danach kein gültiger Nachweis", async () => {
    const { ctx, paths, downloads } = await world({ sherpa: "schlecht" });
    await placeFiles(paths);
    await writeValidProof(paths);
    utimesSync(paths.encoder, new Date("2031-01-01"), new Date("2031-01-01"));
    expect((await speechStep.status(ctx)).state).toBe("teilweise");
    const { result } = await run(ctx);
    expect(result.ok).toBe(false);
    expect(downloads.calls).toEqual([]);
    expect(existsSync(paths.proof)).toBe(false);
  });

  test("auto: Frage mit Erklärung des Rückfalls; abgelehnt bleibt die Einstellung", async () => {
    const before = JSON.stringify({ speech: { stt: "auto" } });
    const { ctx } = await world({ settings: before });
    const existing = await existingFieldValues(speechStep, ctx);
    const visible = SPEECH_FIELDS.filter(f => !f.visible || f.visible(existing)).map(f => f.name);
    expect(visible).toEqual(["SPRACHE_WEG", SWITCH_AUTO_FIELD, "SPRACHE_STIMME", "SPRACHE_KLON"]);
    expect(SPEECH_FIELDS.find(f => f.name === SWITCH_AUTO_FIELD)!.help).toContain(AUTO_EXPLANATION);
    expect(AUTO_EXPLANATION).toBe("Mit auto geht eine Aufnahme, die Parakeet nicht versteht oder in der es nichts hört, an ElevenLabs oder Gemini weiter, falls eingerichtet.");
    expect(speechPlan({ ...existing, [SWITCH_AUTO_FIELD]: "false" }).join(" ")).toContain("Hören bleibt auf auto.");
    const { result } = await run(ctx, { [SWITCH_AUTO_FIELD]: "false" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain(`Hören bleibt auf auto (${AUTO_EXPLANATION})`);
    expect(await readFile(ctx.settingsPath, "utf8")).toBe(before);
  });

  test("anderer Anbieter: eigene Frage; abgelehnt bleibt er, zugestimmt wird umgestellt", async () => {
    const before = JSON.stringify({ speech: { stt: "whisper-cpp", language: "de" } });
    const no = await world({ settings: before });
    const existing = await existingFieldValues(speechStep, no.ctx);
    expect(SPEECH_FIELDS.filter(f => !f.visible || f.visible(existing)).map(f => f.name)).toEqual(["SPRACHE_WEG", SWITCH_FIELD, "SPRACHE_STIMME", "SPRACHE_KLON"]);
    expect((await run(no.ctx, { [SWITCH_FIELD]: "false" })).result.message).toContain("Hören bleibt auf whisper-cpp.");
    expect(await readFile(no.ctx.settingsPath, "utf8")).toBe(before);
    const yes = await world({ settings: before });
    expect((await run(yes.ctx, { [SWITCH_FIELD]: "true" })).result.ok).toBe(true);
    expect(await readJson(yes.ctx.settingsPath)).toEqual({ speech: { stt: "parakeet", language: "de" } });
  });

  test("SPEECH_STT aus .env zählt als aktuelle Wahl, die Datei schlägt sie", async () => {
    const env = await speechCtx({ env: "SPEECH_STT=gemini\n" });
    expect((await existingFieldValues(speechStep, env)).SPRACHE_STT).toBe("gemini");
    const file = await speechCtx({ env: "SPEECH_STT=gemini\n", settings: JSON.stringify({ speech: { stt: "parakeet" } }) });
    expect((await existingFieldValues(speechStep, file)).SPRACHE_STT).toBe("parakeet");
  });

  test("ungültige config/settings.json: kein Download, Hinweis", async () => {
    const { ctx, downloads } = await world({ settings: "{kaputt" });
    const { result } = await run(ctx, {});
    expect(result.ok).toBe(false);
    expect(result.message).toContain("config/settings.json ist ungültig");
    expect(downloads.calls).toEqual([]);
  });

  test("Terminal: tybo setup sprache bis zum Ende, kein Neustart, kein Autostart", async () => {
    const { ctx, paths } = await world({ env: FULL_ENV });
    // Weg, Umstellen, Stimme (Enter: Browser-Stimme bleibt), eigene Stimme (Enter: nein, Issue #253), „Jetzt ausführen?“
    const prompter = scripted(["", "", "", "", ""]);
    const r = await runWith({ mode: "step", step: "sprache" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(r.out).toContain("Probe bestanden.");
    expect(r.out).toContain("Sprache: gespeichert");
    expect(existsSync(paths.proof)).toBe(true);
    const commands = ctx.run.calls.map(c => c[0]);
    expect(commands.filter(c => !c.endsWith("sherpa-onnx-vad-with-offline-asr") && c !== "tar")).toEqual([]);
    expect(r.out).not.toContain(STDERR_MARKER);
  });

  test("Gesamtprüfung (test): nur Dateien und Nachweis, kein Prozess", async () => {
    const { ctx, paths, procs } = await world();
    expect((await speechStep.test!({}, ctx)).ok).toBe(false);
    await placeFiles(paths);
    await writeValidProof(paths);
    expect(await speechStep.test!({}, ctx)).toEqual({ ok: true, message: "Parakeet: eingerichtet, Probe bestanden, Hören steht auf auto. Vorlesen: Browser-Stimme." });
    expect(procs.run.calls).toEqual([]);
  });
});

describe("verify: lokales Hören", () => {
  async function project() {
    const root = await mkdtemp(join(tmpdir(), "verify-speech-"));
    dirs.push(root);
    return root;
  }

  test("wirksame Wahl: Datei vor SPEECH_STT vor auto; kaputte Datei wie die Laufzeit", () => {
    expect(effectiveStt(JSON.stringify({ speech: { stt: "parakeet" } }), "gemini")).toBe("parakeet");
    expect(effectiveStt(JSON.stringify({}), "Gemini")).toBe("gemini");
    expect(effectiveStt(null, undefined)).toBe("auto");
    expect(effectiveStt("{kaputt", "unsinn")).toBe("auto");
  });

  test("parakeet: fehlt ergibt Fehler, mit Nachweis bestanden; auto nur mit vorhandenem Parakeet; andere Wahl: keine Prüfung", async () => {
    const root = await project();
    const base = { root, platform: "darwin", arch: "arm64", envStt: undefined };
    const fixed = JSON.stringify({ speech: { stt: "parakeet" } });
    expect(checkLocalStt({ ...base, settingsText: fixed })).toEqual({
      name: "Parakeet (lokales Hören)",
      status: "fail",
      message: "Hören steht fest auf Parakeet, aber nicht eingerichtet, tybo setup sprache ausführen.",
    });
    expect(checkLocalStt({ ...base, settingsText: null })).toBeNull();
    expect(checkLocalStt({ ...base, settingsText: JSON.stringify({ speech: { stt: "gemini" } }) })).toBeNull();
    const paths = (await import("../src/lib/speech/parakeet")).parakeetPaths(speechDir(root), "osx-arm64");
    await placeFiles(paths);
    expect(checkLocalStt({ ...base, settingsText: null })?.status).toBe("warn");
    await writeValidProof(paths);
    expect(checkLocalStt({ ...base, settingsText: fixed })?.status).toBe("pass");
    expect(checkLocalStt({ ...base, settingsText: null })?.status).toBe("pass");
  });

  test("startet keinen Prozess", async () => {
    const root = await project();
    const spawn = spyOn(Bun, "spawn");
    const spawnSync = spyOn(Bun, "spawnSync");
    try {
      checkLocalStt({ root, platform: "darwin", arch: "arm64", envStt: "parakeet", settingsText: null });
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      spawnSync.mockRestore();
    }
  });
});

test("tybo pruefen: speechFindings meldet aus dem Kontext, ohne Prozess", async () => {
  const root = await mkdtemp(join(tmpdir(), "verify-rec-"));
  dirs.push(root);
  await mkdir(join(root, "config"), { recursive: true });
  const settingsPath = join(root, "config", "settings.json");
  await writeFile(settingsPath, JSON.stringify({ speech: { stt: "parakeet" } }));
  const ctx = { root, settingsPath, platform: "darwin" as const, arch: "arm64" };
  const spawn = spyOn(Bun, "spawn");
  let lines: ReturnType<typeof speechFindings>;
  try {
    lines = speechFindings(ctx, {});
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
  expect(lines.length).toBe(1);
  expect(lines[0].label).toBe("Parakeet (lokales Hören)");
  expect(lines[0].status).toBe("fail");
  // Die Einstellungsdatei hat Vorrang vor SPEECH_STT: weiter eine Zeile
  expect(speechFindings(ctx, { SPEECH_STT: "gemini" }).length).toBe(1);
  // Andere Wahl: keine Zeile
  await writeFile(settingsPath, JSON.stringify({ speech: { stt: "gemini" } }));
  expect(speechFindings(ctx, {})).toEqual([]);
  // Einstellungsdatei aus dem Kontext, nicht aus <root>/config: woanders liegt keine
  expect(speechFindings({ ...ctx, settingsPath: join(root, "fehlt.json") }, { SPEECH_STT: "parakeet" })[0]?.status).toBe("fail");
});

describe("tybo deinstallieren: nur models/speech/", () => {
  async function project() {
    const root = await mkdtemp(join(tmpdir(), "uninstall-speech-"));
    dirs.push(root);
    await mkdir(join(root, "models", "speech", "parakeet-tdt-0.6b-v3-int8"), { recursive: true });
    await writeFile(join(root, "models", "speech", "parakeet-tdt-0.6b-v3-int8", "encoder.int8.onnx"), "x");
    await writeFile(join(root, "models", "ggml-medium.bin"), "whisper");
    return root;
  }

  test("Ja löscht nur models/speech/, andere Modelle bleiben", async () => {
    const root = await project();
    const asked: string[] = [];
    const removed: string[] = [];
    const out = await removeSpeechModels(root, async q => (asked.push(q), true), () => {}, async p => {
      removed.push(p);
      await rm(p, { recursive: true, force: true });
    });
    expect(out).toBe("gelöscht");
    expect(asked.length).toBe(1);
    expect(removed).toEqual([join(root, "models", "speech")]);
    expect(existsSync(join(root, "models", "speech"))).toBe(false);
    expect(await readFile(join(root, "models", "ggml-medium.bin"), "utf8")).toBe("whisper");
  });

  test("tybo deinstallieren fragt nach den Diensten und löscht nach Ja nur models/speech/", async () => {
    const root = await project();
    const asked: string[] = [];
    const code = await runUninstallCommand([], {
      ...realUninstallDeps(root, root),
      platform: "win32",
      run: async () => ({ ok: false, stdout: "", stderr: "", missing: true }),
      ask: async q => (asked.push(q), true),
      out: () => {},
      err: () => {},
    });
    expect(code).toBe(0);
    expect(asked).toEqual([expect.stringContaining("models/speech/")]);
    expect(existsSync(join(root, "models", "speech"))).toBe(false);
    expect(existsSync(join(root, "models", "ggml-medium.bin"))).toBe(true);
  });

  test("Nein löscht nichts; ohne Ordner keine Frage", async () => {
    const root = await project();
    expect(await removeSpeechModels(root, async () => false, () => {})).toBe("behalten");
    expect(existsSync(join(root, "models", "speech", "parakeet-tdt-0.6b-v3-int8", "encoder.int8.onnx"))).toBe(true);
    const empty = await mkdtemp(join(tmpdir(), "uninstall-leer-"));
    dirs.push(empty);
    let asked = 0;
    expect(await removeSpeechModels(empty, async () => (asked++, true), () => {})).toBe("fehlt");
    expect(asked).toBe(0);
  });
});

describe("Nachweis mit Bruchteil-Millisekunden", () => {
  test("Bun 1.4 liefert mtimeMs mit Nachkommastellen: alter Nachweis bleibt gültig", () => {
    const paths = parakeetPaths("/m", "osx-arm64");
    const fine = (f: string) => ({ size: f.length, mtimeMs: 1790949039979.497 });
    const coarse = (f: string) => ({ size: f.length, mtimeMs: 1790949039979 });
    const proof = buildProof(paths, "osx-arm64", coarse, { wer: 0.05, ms: 400, at: "2026-10-01T00:00:00.000Z" })!;
    expect(checkProof(JSON.stringify(proof), paths, "osx-arm64", fine)).toEqual({ ok: true });
    const fresh = buildProof(paths, "osx-arm64", fine, { wer: 0.05, ms: 400, at: "2026-10-01T00:00:00.000Z" })!;
    expect(checkProof(JSON.stringify(fresh), paths, "osx-arm64", coarse)).toEqual({ ok: true });
    const later = (f: string) => ({ size: f.length, mtimeMs: 1790949039980.1 });
    expect(checkProof(JSON.stringify(proof), paths, "osx-arm64", later).ok).toBe(false);
  });
});
