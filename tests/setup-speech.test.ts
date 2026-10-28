/**
 * Issue #251: Schritt „sprache“ (tybo setup sprache), Pfad „Sprechmodus
 * lokal“ mit Parakeet über sherpa-onnx. Alles gegen Attrappen
 * (tests/parakeet-fixture.ts): kein Download, kein tar, kein ffmpeg, kein
 * sherpa-onnx.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { STEP_IDS, fieldDefinitionProblems, runsAsFlow } from "../src/setup/model";
import { existingFieldValues, getStep, SETUP_STEPS, setupOverview } from "../src/setup/steps";
import { SPEECH_FIELDS, speechStep, SWITCH_AUTO_FIELD } from "../src/setup/steps/speech";
import { cleanup, FULL_ENV } from "./setup-fixture";
import { CTRL_C, runWith, scripted } from "./setup-terminal-fixture";
import { get, login, startSetup, type Started, type TestCtx } from "./setup-web-fixture";
import { GIB, speechCtx } from "./parakeet-fixture";

const running: Started[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.server.stop();
});
afterAll(cleanup);

async function body(res: Response) {
  return (await res.json()) as any;
}

// ---------------------------------------------------------------------------
// Checkbox 1: Schritt anlegen und registrieren, Kontext
// ---------------------------------------------------------------------------

describe("Schritt sprache: Registrierung", () => {
  test("in STEP_IDS und der Schrittliste direkt nach modelle, optional, als Ablauf", () => {
    const ids = SETUP_STEPS.map(s => s.id);
    expect(STEP_IDS).toContain("sprache");
    expect(ids.indexOf("sprache")).toBe(ids.indexOf("modelle") + 1);
    expect(getStep("sprache")).toBe(speechStep);
    expect(speechStep.optional).toBe(true);
    expect(speechStep.title).toBe("Sprache");
    expect(runsAsFlow(speechStep, { SPRACHE_WEG: "lokal" })).toBe(true);
    // Ohne Eingabe gilt der Standard „lokal“
    expect(runsAsFlow(speechStep, {})).toBe(true);
    expect(fieldDefinitionProblems(SPEECH_FIELDS)).toEqual([]);
  });

  test("zwei Pfade als Auswahl: Sprechmodus lokal und Telefonhörer (Issue #260; #247 stellt später einen weiteren daneben)", () => {
    const path = SPEECH_FIELDS.find(f => f.name === "SPRACHE_WEG")!;
    expect(path.kind).toBe("choice");
    expect(path.choices!.map(c => c.value)).toEqual(["lokal", "telefon"]);
    expect(path.default).toBe("lokal");
  });

  test("Kontext mit Attrappen: Plattform, Architektur, Arbeitsspeicher, freier Platz, Programme", async () => {
    const ctx = await speechCtx({ platform: "linux", arch: "arm64", ramBytes: 2 * GIB, freeBytes: 123_000_000, programs: [] });
    const status = await speechStep.status(ctx);
    const items = Object.fromEntries((status.items ?? []).map(i => [i.label, i.detail]));
    expect(items.Plattform).toBe("Linux arm64 (linux arm64)");
    expect(items.Arbeitsspeicher).toStartWith("2,0 GiB");
    expect(items["Freier Platz"]).toBe("123 MB");
    expect(items.ffmpeg).toStartWith("fehlt");
    expect(items["whisper.cpp"]).toBe("nicht vorhanden");
    expect(items.Parakeet).toBe("nicht vorhanden");
  });

  test("ohne Attrappen im Kontext: echte Werte, nichts wird angelegt", async () => {
    const ctx = await speechCtx();
    delete ctx.totalMem;
    delete ctx.freeDisk;
    delete ctx.which;
    delete ctx.arch;
    const status = await speechStep.status(ctx);
    expect(["fehlt", "teilweise"]).toContain(status.state);
    expect(existsSync(`${ctx.root}/models`)).toBe(false);
  });
});

describe("Schritt sprache: Terminal", () => {
  test("tybo setup, ganzer Lauf: Sprache erscheint nach Modelle und lässt sich überspringen", async () => {
    const ctx = await speechCtx({ env: FULL_ENV });
    // Auswahl Enter, dann je offener optionaler Schritt „Jetzt einrichten?“ nein, am Ende Strg+C
    const prompter = scripted(["", "n", "n", "n", "n", CTRL_C]);
    const r = await runWith({ mode: "all" }, ctx, prompter);
    expect(r.out).toMatch(/8\. Sprache \(optional\)\s+fehlt\s+Lokales Hören \(Parakeet\) ist nicht eingerichtet\./);
    expect(r.out).toContain("Sprache (optional)");
    expect(r.out).toContain("Stand: Lokales Hören (Parakeet) ist nicht eingerichtet.");
    expect(r.out.indexOf("Sprache (optional)\n")).toBeGreaterThan(r.out.indexOf("Modelle und Fallback (optional)\n"));
    // Nichts geladen, nichts angelegt
    expect(existsSync(`${ctx.root}/models`)).toBe(false);
  });

  test("tybo setup sprache: Felder, Plan mit Bestandsaufnahme, „Jetzt ausführen?“ nein lädt nichts", async () => {
    let fetched = 0;
    const ctx = await speechCtx({
      env: FULL_ENV,
      overrides: {
        fetch: async () => {
          fetched++;
          throw new Error("kein Netz");
        },
      },
    });
    const prompter = scripted(["", "", "", "", "n"]);
    const r = await runWith({ mode: "step", step: "sprache" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(prompter.asked.map(a => a.question)).toEqual([
      "Weg für den Sprechmodus [Sprechmodus lokal (empfohlen): Parakeet hört auf diesem Rechner, ohne Cloud-Schlüssel]: ",
      "Hören fest auf Parakeet stellen (statt auto)? [j]: ",
      // Teil Stimme (Issue #252): Enter behält die eingestellte Stimme (hier die Browser-Stimme)
      "Stimme fürs Vorlesen [Beibehalten (die bisherige Einstellung bleibt unverändert)]: ",
      // Teil Eigene Stimme (Issue #253): Enter heißt nein, Bedingungen und Token nur bei Pocket
      "Eigene Stimme klonen (optional)? [Nein, keine eigene Stimme einrichten]: ",
      "Jetzt ausführen? [J/n] ",
    ]);
    expect(r.out).toContain("Das passiert jetzt:");
    expect(r.out).toContain("Bestandsaufnahme: Plattform: Mac mit Apple Silicon (darwin arm64); Arbeitsspeicher: 16,0 GiB;");
    expect(r.out).toContain("Nicht ausgeführt.");
    expect(fetched).toBe(0);
    expect(existsSync(`${ctx.root}/models`)).toBe(false);
  });
});

describe("Schritt sprache: Browser (--web)", () => {
  async function web(ctx: TestCtx) {
    const s = await startSetup({ ctx });
    running.push(s);
    return { s, cookie: await login(s) };
  }

  test("Übersicht und Schritt: optional, mit Plan und Ablauf, ohne Werte", async () => {
    const ctx = (await speechCtx({ env: FULL_ENV })) as TestCtx;
    const { s, cookie } = await web(ctx);
    const overview = await body(await get(s, "/api/setup/overview", cookie));
    const entry = overview.steps.find((x: any) => x.id === "sprache");
    expect(entry).toMatchObject({ id: "sprache", title: "Sprache", optional: true, state: "fehlt" });
    const step = await body(await get(s, "/api/setup/steps/sprache", cookie));
    expect(step.canRun).toBe(true);
    expect(step.mode).toBe("ablauf");
    expect(step.items.map((i: any) => i.label)).toEqual(["Plattform", "Arbeitsspeicher", "Freier Platz", "whisper.cpp", "ffmpeg", "Parakeet", "Stimme"]);
    expect(step.plan.join(" ")).toContain("Download ca. 506 MB");
    expect(step.fields.map((f: any) => [f.name, f.visible])).toEqual([
      ["SPRACHE_WEG", true],
      [SWITCH_AUTO_FIELD, true],
      ["SPRACHE_UMSTELLEN", false],
      // Teil Stimme (Issue #252); Piper als Ausweichweg nur bei der lokalen Stimme
      ["SPRACHE_STIMME", true],
      ["SPRACHE_PIPER_BEI_LANGSAM", false],
      // Teil Eigene Stimme (Issue #253); Zustimmung und Token nur bei Pocket mit Klonen
      ["SPRACHE_KLON", true],
      ["SPRACHE_KLON_BEDINGUNGEN", false],
      ["SPRACHE_HF_TOKEN", false],
      // Pfad Telefonhörer (Issue #260): nur bei diesem Weg
      ["SPRACHE_TELEFON_WEG", false],
    ]);
    // Interne Werte der Bestandsaufnahme gehen nie an die Oberfläche
    expect(JSON.stringify(step)).not.toContain("SPRACHE_BESTAND");
    expect(JSON.stringify(step)).not.toContain("SPRACHE_TELEFON_BESTAND");
  });

  test("überspringbar: Einrichtung gilt ohne den Schritt als fertig", async () => {
    const ctx = (await speechCtx({ env: FULL_ENV })) as TestCtx;
    const overview = await setupOverview(ctx, ["sprache"]);
    expect(overview.skipped).toContain("sprache");
    expect(overview.missing).not.toContain("sprache");
  });
});

describe("existingFieldValues", () => {
  test("liefert aktuelle Wahl und Bestandsaufnahme nur intern", async () => {
    const ctx = await speechCtx({ settings: JSON.stringify({ speech: { stt: "whisper-cpp", tts: "browser" } }) });
    const v = await existingFieldValues(speechStep, ctx);
    expect(v.SPRACHE_STT).toBe("whisper-cpp");
    expect(JSON.parse(v.SPRACHE_BESTAND).sel).toEqual({ ok: true, key: "osx-arm64", label: "Mac mit Apple Silicon" });
    // Nichts angelegt
    expect(await readdir(ctx.root)).not.toContain("models");
    expect(await readFile(ctx.settingsPath, "utf8")).toContain("whisper-cpp");
  });
});
