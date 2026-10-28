/**
 * Issue #260, Checkbox 3: Pfad „Telefonhörer“ im Schritt „sprache“ im
 * Terminal und mit --web: ohne Erkenner ein Verweis statt einer Probe, ohne
 * Modellweg eine klare Absage (der Sprechmodus bleibt), Probe über genau den
 * gewählten Weg mit Einordnung flüssig, geht, zäh nach Messwert, Speichern
 * des Wegs, dazu verify und .env.example. Alles mit Attrappen
 * (tests/setup-fixture.ts testCallSetup): kein Modell, kein Claude Code,
 * kein sherpa-onnx, kein Ollama.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildProof } from "../src/lib/speech/parakeet";
import type { CallWay } from "../src/lib/voice-brain/call-model";
import type { RunEvent, SetupValues } from "../src/setup/model";
import { CALL_HTTPS_HINT, CALL_INVENTORY, CALL_SPEECH_STAYS, CALL_WAY_FIELD, realDevice, runCallSetup, runDeviceProbe, type DeviceBrain, type DeviceProbePorts } from "../src/setup/speech-call";
import { resolveCallModel } from "../src/lib/voice-brain/call-model";
import { existingFieldValues } from "../src/setup/steps";
import { PATH_FIELD, speechPlan, speechStep, statFile } from "../src/setup/steps/speech";
import { probeResult, type CallProbeResult } from "../src/web/call-probe";
import { callFinding } from "../src/setup/checks/speech";
import { cleanup, testCallSetup } from "./setup-fixture";
import { runWith, scripted } from "./setup-terminal-fixture";
import { get, login, post, startSetup } from "./setup-web-fixture";
import { pathsOf, placeFiles, speechCtx, type SpeechCtxOptions } from "./parakeet-fixture";

afterAll(() => cleanup());

const KEY_ENV = "VOICE_ANTHROPIC_API_KEY=sk-test-voice\n";

function measured(medianMs: number, minMs = medianMs - 200, maxMs = medianMs + 300): CallProbeResult {
  return probeResult({ medianMs, minMs, maxMs, measured: 3, count: 3, model: "claude-sonnet-5-5", via: "api" });
}

/** Kontext mit Parakeet (Dateien und gültiger Nachweis) oder ohne Erkenner */
async function world(o: SpeechCtxOptions & { parakeet?: boolean; call?: Parameters<typeof testCallSetup>[0] } = {}) {
  const callSetup = testCallSetup(o.call);
  const ctx = await speechCtx({ ...o, overrides: { ...o.overrides, callSetup } });
  if (o.parakeet !== false) {
    const paths = pathsOf(ctx);
    await placeFiles(paths);
    const proof = buildProof(paths, "osx-arm64", statFile, { wer: 0.05, ms: 900, at: "2026-10-02T09:00:00.000Z" })!;
    await writeFile(paths.proof, JSON.stringify(proof));
  }
  return { ctx, callSetup };
}

async function values(ctx: Awaited<ReturnType<typeof world>>["ctx"], extra: SetupValues = {}): Promise<SetupValues> {
  return { ...(await existingFieldValues(speechStep, ctx)), [PATH_FIELD]: "telefon", ...extra };
}

async function run(ctx: Awaited<ReturnType<typeof world>>["ctx"], extra: SetupValues = {}, signal = new AbortController().signal) {
  const events: RunEvent[] = [];
  const result = await runCallSetup(await values(ctx, extra), ctx, e => events.push(e), signal);
  return { result, events };
}

/** Pocket TTS als eingerichtet melden: Programm, Modellordner und Nachweis (nur Dateien, kein Prozess) */
async function withPocket<T extends { ctx: { root: string } }>(w: T): Promise<T> {
  const { POCKET_LANGUAGE, POCKET_VERSION, pocketPaths } = await import("../src/lib/speech/pocket");
  const { speechDir } = await import("../src/lib/speech/parakeet");
  const pp = pocketPaths(speechDir(w.ctx.root));
  await mkdir(join(pp.program, ".."), { recursive: true });
  await writeFile(pp.program, "");
  await mkdir(pp.modelCache, { recursive: true });
  await mkdir(join(pp.proof, ".."), { recursive: true });
  await writeFile(pp.proof, JSON.stringify({ version: 1, pocket: POCKET_VERSION, language: POCKET_LANGUAGE }));
  return w;
}

const settingsOf = (ctx: { settingsPath: string }) => (existsSync(ctx.settingsPath) ? JSON.parse(readFileSync(ctx.settingsPath, "utf8")) : null);

describe("Voraussetzungen", () => {
  test("ohne lokalen Erkenner: Verweis auf den Sprechmodus lokal, keine Probe, nichts gespeichert", async () => {
    const w = await world({ env: KEY_ENV, parakeet: false, call: { probe: measured(1300) } });
    const plan = speechPlan(await values(w.ctx)).join("\n");
    expect(plan).toContain("Hören: kein lokaler Erkenner. Erst den Weg „Sprechmodus lokal“ in tybo setup sprache ausführen, dann diesen.");
    expect(plan).toContain("Ohne lokalen Erkenner wird nichts gemessen und nichts gespeichert.");
    const { result } = await run(w.ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Der Telefonhörer braucht einen lokalen Erkenner");
    expect(w.callSetup.probes).toEqual([]);
    expect(settingsOf(w.ctx)).toBeNull();
  });

  test("ohne Modellweg: klare Absage, der Sprechmodus bleibt", async () => {
    const w = await world({ env: "", call: { probe: measured(1300) } });
    const plan = speechPlan(await values(w.ctx)).join("\n");
    expect(plan).toContain(`Kein Weg ist bereit. ${CALL_SPEECH_STAYS}`);
    expect(plan).toContain("Nicht bereit: Claude Sonnet 5.5 über deinen API-Schlüssel (VOICE_ANTHROPIC_API_KEY fehlt");
    expect(plan).toContain("Nicht bereit: Claude Sonnet 5.5 über dein Claude-Abo (Claude Code ist nicht installiert)");
    const { result } = await run(w.ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(`Kein Weg für den Telefonhörer ist bereit. ${CALL_SPEECH_STAYS} Nichts wurde gespeichert.`);
    expect(w.callSetup.probes).toEqual([]);
    expect(settingsOf(w.ctx)).toBeNull();
  });

  test("gewählter Weg nicht bereit: Absage mit Grund, auch wenn ein anderer bereit wäre", async () => {
    const w = await world({ env: KEY_ENV, call: { probe: measured(1300) } });
    const { result } = await run(w.ctx, { [CALL_WAY_FIELD]: "openrouter" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("OpenRouter: anthropic/claude-sonnet-5.5 ist nicht bereit (OPENROUTER_API_KEY fehlt)");
    expect(result.message).toContain(CALL_SPEECH_STAYS);
    expect(w.callSetup.probes).toEqual([]);
  });

  test("Plan nennt Stimme, Wege und Kosten; ohne Pocket spricht der Browser", async () => {
    const w = await world({ env: KEY_ENV });
    const plan = speechPlan(await values(w.ctx)).join("\n");
    expect(plan).toContain("Hören: Parakeet ist eingerichtet.");
    expect(plan).toContain("Ohne sie spricht der Browser");
    expect(plan).toContain("Bereit: Claude Sonnet 5.5 über deinen API-Schlüssel.");
    expect(plan).toContain("kostet pro Turn");
    expect(plan).toContain("Gemessen wird Claude Sonnet 5.5 über deinen API-Schlüssel");
    expect(plan).toContain(CALL_HTTPS_HINT);
  });
});

describe("Probe und Einordnung", () => {
  for (const [ms, word] of [
    [1300, "flüssig"],
    [3200, "geht"],
    [5400, "zäh"],
  ] as const) {
    test(`${ms} ms: ${word}`, async () => {
      const w = await world({ env: KEY_ENV, call: { probe: measured(ms) } });
      const { result, events } = await run(w.ctx);
      expect(result.ok).toBe(true);
      expect(result.message).toContain(`, ${word}.`);
      expect(result.message).toContain("Geräteprobe auf diesem Gerät mit der Probe-Aufnahme: Erkennen 0,3 s (Parakeet), Antwort beginnt nach 1,4 s");
      expect(result.message).toContain("Kein Advanced Voice Mode.");
      // Je Stufe eine Fortschrittsmeldung
      expect(events.filter(e => e.type === "progress" || "label" in e).length).toBeGreaterThanOrEqual(3);
    });
  }

  test("Probe genau über den gewählten Weg, danach model und claudeVia gespeichert", async () => {
    const w = await world({ env: KEY_ENV, settings: JSON.stringify({ speech: { stt: "parakeet" } }), call: { cli: true, probe: measured(1500) } });
    const { result } = await run(w.ctx, { [CALL_WAY_FIELD]: "cli" });
    expect(result.ok).toBe(true);
    expect(w.callSetup.probes.map((p: CallWay) => [p.id, p.model, p.claudeVia])).toEqual([["cli", "claude:claude-sonnet-5-5", "cli"]]);
    expect(settingsOf(w.ctx).speech).toEqual({ stt: "parakeet", call: { model: "claude:claude-sonnet-5-5", claudeVia: "cli" } });
    expect(result.message).toContain("Zählt gegen das Agent-SDK-Guthaben deines Abos.");
    expect(result.message).toContain(CALL_HTTPS_HINT);
  });

  test("automatisch: misst den ersten bereiten Weg, ein leerer Wert bleibt leer", async () => {
    const w = await world({ env: KEY_ENV, call: { cli: true, probe: measured(1400) } });
    const { result } = await run(w.ctx, { [CALL_WAY_FIELD]: "auto" });
    expect(result.ok).toBe(true);
    expect(w.callSetup.probes.map((p: CallWay) => p.id)).toEqual(["api"]);
    expect(settingsOf(w.ctx)).toBeNull();
    expect(result.message).toContain("Der Telefonhörer wählt den Weg weiter automatisch.");
  });

  test("automatisch nach einem festen Weg: speichert auto und entfernt claudeVia", async () => {
    const w = await world({ env: KEY_ENV, settings: JSON.stringify({ speech: { call: { model: "claude:claude-sonnet-5-5", claudeVia: "api", effort: "low" } } }), call: { probe: measured(1400) } });
    expect((await values(w.ctx))[CALL_WAY_FIELD]).toBe("api");
    const { result } = await run(w.ctx, { [CALL_WAY_FIELD]: "auto" });
    expect(result.ok).toBe(true);
    expect(settingsOf(w.ctx).speech).toEqual({ call: { model: "auto", effort: "low" } });
  });

  test("Probe ohne Messwert: nichts gespeichert, keine Einordnung", async () => {
    const w = await world({ env: KEY_ENV, call: { probe: { ok: false, reason: "Keine Probe kam an (api)" } } });
    const { result } = await run(w.ctx, { [CALL_WAY_FIELD]: "api" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Keine Probe kam an (api)");
    expect(result.message).not.toMatch(/flüssig|geht,|zäh/);
    expect(settingsOf(w.ctx)).toBeNull();
  });
});

describe("Geräteprobe durch die ganze Kette", () => {
  test("mit Pocket: Probe-Aufnahme erkennen, erkannter Text ans gewählte Modell, erster Abschnitt an die Stimme; Zeit je Stufe", async () => {
    const w = await withPocket(await world({ env: KEY_ENV, call: { probe: measured(1300), device: { recognizeMs: 310, answerMs: 1_450, toneMs: 120 } } }));
    const plan = speechPlan(await values(w.ctx, { [CALL_WAY_FIELD]: "api" })).join("\n");
    expect(plan).toContain("die Probe-Aufnahme geht durch Parakeet, das Modell und Pocket TTS (Zeit je Stufe)");
    const { result } = await run(w.ctx, { [CALL_WAY_FIELD]: "api" });
    expect(result.ok).toBe(true);
    expect(w.callSetup.deviceLog.setups).toEqual([{ way: "api", stt: "parakeet", pocket: true }]);
    expect(w.callSetup.deviceLog.steps).toEqual([["laden"], ["erkennen"], ["antwort", "Wie wird das Wetter morgen?"], ["stimme", "Morgen wird es sonnig."]]);
    expect(w.callSetup.deviceLog.closed).toBe(1);
    expect(result.message).toContain("Erkennen 0,3 s (Parakeet), Antwort beginnt nach 1,5 s, erster Ton nach 0,1 s (Pocket TTS); geladen in 2,0 s wie beim Abheben.");
    // 0,8 s Sprechpause + 0,31 + 1,45 + 0,12 s
    expect(result.message).toContain("Vom Ende deiner Äußerung bis zum ersten Ton: 2,7 s");
    expect(result.message).not.toMatch(/Schätz|geschätzt/);
    // Danach die drei Testfragen über denselben Weg, dann gespeichert
    expect(w.callSetup.probes.map(p => p.id)).toEqual(["api"]);
    expect(settingsOf(w.ctx).speech).toEqual({ call: { model: "claude:claude-sonnet-5-5", claudeVia: "api" } });
  });

  test("ohne Pocket: Erkennen und Modell gemessen, keine Stimme, der Browser spricht", async () => {
    const w = await world({ env: KEY_ENV, call: { probe: measured(1300) } });
    const { result } = await run(w.ctx, { [CALL_WAY_FIELD]: "api" });
    expect(result.ok).toBe(true);
    expect(w.callSetup.deviceLog.steps.map(x => x[0])).toEqual(["laden", "erkennen", "antwort"]);
    expect(result.message).toContain("erster Ton: die Browser-Stimme spricht, auf dem Server nicht messbar");
  });

  for (const [stage, label, steps] of [
    ["laden", "Laden", ["laden"]],
    ["erkennen", "Erkennen", ["laden", "erkennen"]],
    ["antwort", "Antwort", ["laden", "erkennen", "antwort"]],
    ["stimme", "Stimme", ["laden", "erkennen", "antwort", "stimme"]],
  ] as const) {
    test(`Fehler bei ${label}: genannt, spätere Stufen laufen nicht, alles geschlossen`, async () => {
      const w = await withPocket(await world({ env: KEY_ENV, call: { probe: measured(1300), device: { fail: stage } } }));
      const { result } = await run(w.ctx, { [CALL_WAY_FIELD]: "api" });
      expect(w.callSetup.deviceLog.steps.map(x => x[0])).toEqual([...steps]);
      expect(w.callSetup.deviceLog.closed).toBe(1);
      expect(result.message).toContain(`Geräteprobe gescheitert bei „${label}“ (Attrappe ${stage} gescheitert)`);
      if (stage === "stimme") expect(result.message).toContain("gemessen: Erkennen 0,3 s, Antwort beginnt nach 1,4 s");
      // Die Testfragen entscheiden übers Speichern; der Fehler steht im Ergebnis
      expect(result.ok).toBe(true);
    });
  }

  test("nichts erkannt: das Modell bekommt keine Frage", async () => {
    const w = await world({ env: KEY_ENV, call: { probe: measured(1300), device: { heard: "  " } } });
    const { result } = await run(w.ctx, { [CALL_WAY_FIELD]: "api" });
    expect(w.callSetup.deviceLog.steps.map(x => x[0])).toEqual(["laden", "erkennen"]);
    expect(result.message).toContain("Geräteprobe gescheitert bei „Erkennen“ (nichts erkannt)");
  });

  test("Abbruch während der Antwort: Stufe endet, alles geschlossen, keine Testfragen, nichts gespeichert", async () => {
    const w = await withPocket(await world({ env: KEY_ENV, call: { probe: measured(1300), device: { hang: "antwort" } } }));
    const abort = new AbortController();
    const running = run(w.ctx, { [CALL_WAY_FIELD]: "api" }, abort.signal);
    for (let i = 0; i < 50 && w.callSetup.deviceLog.steps.length < 3; i++) await Bun.sleep(2);
    abort.abort();
    const { result } = await running;
    expect(result).toEqual({ ok: false, message: "Abgebrochen. Nichts wurde gespeichert.", changed: [] });
    expect(w.callSetup.deviceLog.steps.map(x => x[0])).toEqual(["laden", "erkennen", "antwort"]);
    expect(w.callSetup.deviceLog.closed).toBe(1);
    expect(w.callSetup.probes).toEqual([]);
    expect(settingsOf(w.ctx)).toBeNull();
  });

  test("Abbruch während resolveCallModel (echte Antwort-Stufe): kein Weg gebaut, kein Modellaufruf, alles geschlossen", async () => {
    const w = await world({ env: KEY_ENV });
    let resolving: (() => void) | null = null;
    const calls = { resolve: 0, built: 0, streams: 0, closed: 0 };
    const brain: DeviceBrain = {
      resolve: async deps => {
        calls.resolve++;
        await new Promise<void>(r => (resolving = r));
        return resolveCallModel({ ...deps, env: { VOICE_ANTHROPIC_API_KEY: "sk-test-voice" } });
      },
      createBackend: () => {
        calls.built++;
        return {
          id: "attrappe",
          stream: async function* () {
            calls.streams++;
            yield { type: "text" as const, text: "Hi." };
          },
          close: () => void calls.closed++,
        } as unknown as ReturnType<DeviceBrain["createBackend"]>;
      },
    };
    const way: CallWay = { id: "api", model: "claude:claude-sonnet-5-5", claudeVia: "api", label: "Claude Sonnet 5.5 über deinen API-Schlüssel", ready: true, expectation: "", billing: "anthropic-api" };
    const real = realDevice({ ctx: w.ctx, way, env: {}, settings: {}, stt: "parakeet", pocket: false }, brain);
    let closed = 0;
    // Echte Antwort-Stufe und echtes close; Laden und Erkennen ohne sherpa-onnx
    const ports: DeviceProbePorts = {
      answer: real.answer,
      recognize: async () => "Wie wird das Wetter morgen?",
      close: () => {
        closed++;
        real.close();
      },
    };
    const abort = new AbortController();
    const running = runDeviceProbe(ports, abort.signal);
    for (let i = 0; i < 50 && !resolving; i++) await Bun.sleep(2);
    expect(calls.resolve).toBe(1);
    abort.abort();
    resolving!();
    const result = await running;
    expect(result).toEqual({ ok: false, stage: "antwort", message: "abgebrochen", recognizeMs: expect.any(Number) });
    expect(calls).toEqual({ resolve: 1, built: 0, streams: 0, closed: 0 });
    expect(closed).toBe(1);
  });

  test("runDeviceProbe: Reihenfolge, Eingaben und Zeiten je Stufe; close auch bei Fehler", async () => {
    let t = 0;
    const seen: string[] = [];
    let closed = 0;
    const ports = (o: { failAnswer?: boolean } = {}): DeviceProbePorts => ({
      prepare: async () => void (t += 1_000),
      recognize: async () => ((t += 250), "Hallo"),
      answer: async text => {
        seen.push(`antwort:${text}`);
        t += 900;
        if (o.failAnswer) throw new Error("Weg weg");
        return "Hi.";
      },
      speak: async text => void (seen.push(`stimme:${text}`), (t += 90)),
      close: () => void closed++,
    });
    const ok = await runDeviceProbe(ports(), new AbortController().signal, () => t);
    expect(ok).toEqual({ ok: true, prepareMs: 1_000, recognizeMs: 250, answerMs: 900, toneMs: 90 });
    expect(seen).toEqual(["antwort:Hallo", "stimme:Hi."]);
    const failed = await runDeviceProbe(ports({ failAnswer: true }), new AbortController().signal, () => t);
    expect(failed).toEqual({ ok: false, stage: "antwort", message: "Error", recognizeMs: 250 });
    expect(closed).toBe(2);
  });
});

describe("Automatisch gegenüber SPEECH_CALL_MODEL", () => {
  const fakes = {
    inspectClaude: async () => ({ engine: "claude" as const, checked: true, installed: false, loggedIn: false, message: "Claude Code ist nicht installiert" }),
    cliFlags: async () => ({ missing: [] }),
    ollamaCheck: async () => null,
  };

  test("leere Einstellungsdatei, SPEECH_CALL_MODEL=ollama:qwen3:8b, API-Schlüssel: auto misst die API und speichert auto ausdrücklich, danach gilt die API", async () => {
    const env = `${KEY_ENV}SPEECH_CALL_MODEL=ollama:qwen3:8b\n`;
    const w = await world({ env, call: { ollama: true, probe: measured(1400) } });
    // Vorauswahl: der wirksame Weg aus der .env
    expect((await values(w.ctx))[CALL_WAY_FIELD]).toBe("ollama");
    const { result } = await run(w.ctx, { [CALL_WAY_FIELD]: "auto" });
    expect(result.ok).toBe(true);
    expect(w.callSetup.probes.map(p => p.id)).toEqual(["api"]);
    expect(settingsOf(w.ctx)).toEqual({ speech: { call: { model: "auto" } } });
    expect(result.message).toContain("SPEECH_CALL_MODEL in der .env gilt damit nicht mehr");
    // Was danach wirkt, ist genau der gemessene Weg
    const after = await resolveCallModel({ ...fakes, env: { VOICE_ANTHROPIC_API_KEY: "sk-test-voice", SPEECH_CALL_MODEL: "ollama:qwen3:8b" }, settings: settingsOf(w.ctx) });
    expect([after.via, after.setting, after.source]).toEqual(["api", "auto", "settings"]);
  });

  test("SPEECH_CALL_MODEL=auto: ein leerer Wert bleibt leer", async () => {
    const w = await world({ env: `${KEY_ENV}SPEECH_CALL_MODEL=auto\n`, call: { probe: measured(1400) } });
    const { result } = await run(w.ctx, { [CALL_WAY_FIELD]: "auto" });
    expect(result.ok).toBe(true);
    expect(settingsOf(w.ctx)).toBeNull();
  });
});

describe("Terminal und --web", () => {
  test("Terminal: Weg Telefonhörer, Enter beim Modellweg, ausführen", async () => {
    const w = await world({ env: KEY_ENV, call: { probe: measured(1300) } });
    // Weg (2 = Telefonhörer), Modellweg (Enter: automatisch), „Jetzt ausführen?"
    const prompter = scripted(["2", "", ""]);
    const r = await runWith({ mode: "step", step: "sprache" }, w.ctx, prompter);
    expect(prompter.left()).toBe(0);
    expect(r.out).toContain("Modellweg für den Telefonhörer");
    expect(r.out).toContain("Antwort beginnt nach 1,3 s (3 Proben: 1,1 bis 1,6 s), flüssig");
    expect(r.code).toBe(0);
  });

  test("--web: Plan mit Wegen, Ablauf mit Ergebnis", async () => {
    const w = await world({ env: KEY_ENV, call: { probe: measured(3200) } });
    const s = await startSetup({ ctx: w.ctx as never });
    try {
      const cookie = await login(s);
      const view = await (await post(s, "/api/setup/steps/sprache/view", { values: { [PATH_FIELD]: "telefon" } }, cookie)).json();
      expect(view.mode).toBe("ablauf");
      expect(view.fields.find((f: { name: string }) => f.name === CALL_WAY_FIELD).visible).toBe(true);
      expect(view.plan.join("\n")).toContain("Bereit: Claude Sonnet 5.5 über deinen API-Schlüssel.");
      const started = await post(s, "/api/setup/steps/sprache/run", { values: { [PATH_FIELD]: "telefon", [CALL_WAY_FIELD]: "api" } }, cookie);
      expect(started.status).toBe(202);
      const { runId } = await started.json();
      let state: { state: string; result?: { ok: boolean; message: string } } = { state: "laeuft" };
      for (let i = 0; i < 100 && state.state === "laeuft"; i++) {
        await Bun.sleep(10);
        state = await (await get(s, `/api/setup/runs/${runId}`, cookie)).json();
      }
      expect(state.result?.ok).toBe(true);
      expect(state.result?.message).toContain("Antwort beginnt nach 3,2 s");
      expect(state.result?.message).toContain(", geht.");
      expect(settingsOf(w.ctx).speech).toEqual({ call: { model: "claude:claude-sonnet-5-5", claudeVia: "api" } });
    } finally {
      await s.server.stop();
    }
  });
});

describe("tybo pruefen und .env.example", () => {
  test("callFinding: bereit mit Weg und Abrechnung; ohne Weg übersprungen mit Hinweis; kein Prozess", async () => {
    const root = (await speechCtx()).root;
    await mkdir(join(root, "config"), { recursive: true });
    const ctx = { settingsPath: join(root, "config", "settings.json") };
    const rec: Array<[string, string, string]> = [];
    const spawn = spyOn(Bun, "spawn");
    const fakes = {
      inspectClaude: async () => ({ engine: "claude" as const, checked: true, installed: true, loggedIn: true }),
      cliFlags: async () => ({ missing: [] }),
      ollamaCheck: async () => "Ollama läuft nicht",
    };
    const push = (f: { label: string; status: string; detail: string }) => rec.push([f.label, f.status, f.detail]);
    try {
      push(await callFinding(ctx, {}, fakes));
      push(await callFinding(ctx, {}, { ...fakes, inspectClaude: async () => ({ engine: "claude" as const, checked: true, installed: false, loggedIn: false }) }));
      await writeFile(ctx.settingsPath, JSON.stringify({ speech: { call: { model: "openrouter:anthropic/claude-sonnet-5.5" } } }));
      push(await callFinding(ctx, {}, fakes));
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
    expect(rec[0]).toEqual(["Telefonhörer", "pass", "bereit über cli mit claude-sonnet-5-5, zählt gegen das Guthaben des Abos"]);
    expect(rec[1]).toEqual(["Telefonhörer", "skip", "kein Modellweg bereit, es bleibt beim Sprechmodus (tybo setup sprache, Weg Telefonhörer)"]);
    expect(rec[2]![1]).toBe("warn");
    expect(rec[2]![2]).toContain("OPENROUTER_API_KEY fehlt");
  });

  test("callFinding: ungültige Einstellungsdatei gilt als fehlend, Ausnahme nur mit Fehlerart", async () => {
    const root = (await speechCtx()).root;
    await mkdir(join(root, "config"), { recursive: true });
    const ctx = { settingsPath: join(root, "config", "settings.json") };
    await writeFile(ctx.settingsPath, "{kaputt");
    const ready = await callFinding(ctx, {}, {
      inspectClaude: async () => ({ engine: "claude" as const, checked: true, installed: true, loggedIn: true }),
      cliFlags: async () => ({ missing: [] }),
      ollamaCheck: async () => "Ollama läuft nicht",
    });
    expect(ready.status).toBe("pass");
    const broken = await callFinding(ctx, {}, {
      inspectClaude: async () => {
        throw new TypeError("geheimer-wert-123");
      },
      ollamaCheck: async () => "Ollama läuft nicht",
    });
    expect(broken).toEqual({ label: "Telefonhörer", status: "warn", detail: "ließ sich nicht prüfen (TypeError)" });
  });

  test(".env.example erklärt SPEECH_CALL_MODEL mit Einrichtung und Beispielen", async () => {
    const text = await readFile(join(import.meta.dir, "..", ".env.example"), "utf8");
    const block = text.slice(text.indexOf("# Telefonhörer"), text.indexOf("# SPEECH_CALL_MODEL=auto"));
    expect(block).toContain("tybo setup sprache");
    expect(block).toContain("claude:claude-sonnet-5-5");
    expect(block).toContain("ollama:qwen3:8b");
    expect(block).toContain("bleibt es beim Sprechmodus");
  });
});

test("existingFieldValues: Bestandsaufnahme des Telefonhörers ohne echten Prozess", async () => {
  const w = await world({ env: "" });
  const existing = await existingFieldValues(speechStep, w.ctx);
  const inv = JSON.parse(existing[CALL_INVENTORY]!);
  expect(inv.stt).toBe("parakeet");
  expect(inv.ways.map((x: CallWay) => x.id)).toEqual(["api", "cli", "openrouter", "ollama"]);
});
