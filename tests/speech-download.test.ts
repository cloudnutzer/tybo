/**
 * Issue #251, Checkbox 3: Download-Baustein für Parakeet mit Fetch-Attrappe
 * (tests/parakeet-fixture.ts) und Dateisystem in einem Temp-Ordner, dazu
 * Spione auf dem Dateisystem. Nichts geht ins Netz, tar ist eine Attrappe.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parakeetPaths, speechDir } from "../src/lib/speech/parakeet";
import type { HttpFetch, SetupContext } from "../src/setup/context";
import {
  downloadArtifact,
  installArtifacts,
  MAX_RESTARTS,
  MAX_RESUMES,
  nodeDownloadFs,
  placeArtifact,
  type DownloadDeps,
  type DownloadFs,
} from "../src/setup/speech-download";
import { runLocalSpeech, speechPathValues, speechPlan } from "../src/setup/steps/speech";
import { cleanup } from "./setup-fixture";
import { runWith, scripted } from "./setup-terminal-fixture";
import { cutResponse, fakeDownloads, fakeProcesses, serveFull, speechCtx, testArtifacts, type TestArtifact } from "./parakeet-fixture";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  await cleanup();
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "parakeet-dl-"));
  dirs.push(d);
  return d;
}

const PATHS = parakeetPaths("/x/models/speech", "osx-arm64");
const ARTS = testArtifacts(PATHS);
const MODEL = ARTS.find(a => a.art.id === "modell")!;
const VAD = ARTS.find(a => a.art.id === "vad")!;

function deps(fetch: HttpFetch, extra: Partial<DownloadDeps> = {}): DownloadDeps {
  return { fetch, fs: nodeDownloadFs, run: fakeProcesses(ARTS).run, signal: new AbortController().signal, ...extra };
}

/** Teildateien und Temp-Ordner im Ordner */
async function leftovers(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith(".part") || n.startsWith(".tmp-"));
}

describe("vor der Bestätigung", () => {
  test("Plan nennt Download und Platz getrennt; „Jetzt ausführen?“ nein ruft fetch nie auf", async () => {
    let fetched = 0;
    const ctx = await speechCtx({ overrides: { fetch: async () => { fetched++; throw new Error("kein Netz"); } } });
    const plan = speechPlan(await speechPathValues(ctx)).join("\n");
    expect(plan).toContain("Download ca. 506 MB (Laufzeit 18 MB für Mac mit Apple Silicon, VAD 0,6 MB, Modell 487 MB)");
    expect(plan).toContain("auf der Platte danach ca. 733 MB");
    expect(plan).toContain("Während des Entpackens braucht es kurz ca. 1,3 GB frei");
    expect(plan).toContain("Der Download beginnt erst nach deinem Ja");
    // Weg, Umstellen, Stimme (Enter: Browser-Stimme, Issue #252), „Jetzt ausführen?“ nein
    const r = await runWith({ mode: "step", step: "sprache" }, ctx, scripted(["", "", "", "", "n"]));
    expect(r.out).toContain("Download ca. 506 MB");
    expect(r.out).toContain("Nicht ausgeführt.");
    expect(fetched).toBe(0);
    expect(existsSync(speechDir(ctx.root))).toBe(false);
  });
});

describe("Wiederaufnahme und Neubeginn", () => {
  test("Netzfehler mitten im Download: weiter per Range, 206 mit richtigem Content-Range", async () => {
    const dir = await tempDir();
    const part = join(dir, "modell.part");
    const { fetch, calls } = fakeDownloads(ARTS, (t, call, n) => (n === 1 ? cutResponse(t.body, 300) : serveFull(t, call, n)));
    const r = await downloadArtifact(MODEL.art, part, deps(fetch));
    expect(r).toEqual({ ok: true });
    expect(calls.map(c => c.range)).toEqual([undefined, "bytes=300-"]);
    expect(await readFile(part)).toEqual(MODEL.body);
  });

  test("Server antwortet auf Range mit 200: die Datei beginnt von vorn (kein doppelter Anfang)", async () => {
    const dir = await tempDir();
    const part = join(dir, "modell.part");
    const { fetch, calls } = fakeDownloads(ARTS, (t, _call, n) => (n === 1 ? cutResponse(t.body, 300) : new Response(t.body, { status: 200 })));
    const r = await downloadArtifact(MODEL.art, part, deps(fetch));
    expect(r).toEqual({ ok: true });
    expect(calls.map(c => c.range)).toEqual([undefined, "bytes=300-"]);
    expect(await readFile(part)).toEqual(MODEL.body);
  });

  test("206 mit falschem Content-Range: verworfen, neuer Abruf ohne Range", async () => {
    const dir = await tempDir();
    const part = join(dir, "modell.part");
    const { fetch, calls } = fakeDownloads(ARTS, (t, call, n) => {
      if (n === 1) return cutResponse(t.body, 300);
      if (n === 2) return new Response(t.body.subarray(100), { status: 206, headers: { "content-range": `bytes 100-${t.body.length - 1}/${t.body.length}` } });
      return serveFull(t, call, n);
    });
    const r = await downloadArtifact(MODEL.art, part, deps(fetch));
    expect(r).toEqual({ ok: true });
    expect(calls.map(c => c.range)).toEqual([undefined, "bytes=300-", undefined]);
    expect(await readFile(part)).toEqual(MODEL.body);
  });

  test(`höchstens ${MAX_RESUMES} Wiederaufnahmen, danach Abbruch ohne Teildatei`, async () => {
    const dir = await tempDir();
    const part = join(dir, "modell.part");
    const { fetch, calls } = fakeDownloads(ARTS, (t, call) => {
      const from = Number(/^bytes=(\d+)-$/.exec(call.range ?? "")?.[1] ?? 0);
      return from
        ? cutResponse(t.body.subarray(from), 10, 206, { "content-range": `bytes ${from}-${t.body.length - 1}/${t.body.length}` })
        : cutResponse(t.body, 10);
    });
    const r = await downloadArtifact(MODEL.art, part, deps(fetch));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("brach mehrfach ab");
    expect(calls.length).toBe(1 + MAX_RESUMES);
    expect(existsSync(part)).toBe(false);
  });

  test(`dauerhaft zu große Antwort: höchstens ${MAX_RESTARTS} Neustarts, Meldung, nichts bleibt liegen`, async () => {
    const dir = await tempDir();
    const part = join(dir, "modell.part");
    const tooBig = (t: TestArtifact) => new Response(new Uint8Array([...t.body, 1, 2, 3]), { status: 200 });
    const { fetch, calls } = fakeDownloads(ARTS, tooBig);
    const r = await downloadArtifact(MODEL.art, part, deps(fetch));
    expect(r).toEqual({ ok: false, aborted: false, message: "modell.tar.bz2: der Server lieferte mehrfach eine unpassende Datei (Größe oder Bereich falsch). Nichts wurde abgelegt." });
    expect(calls.length).toBe(1 + MAX_RESTARTS);
    expect(existsSync(part)).toBe(false);

    // Über den ganzen Ablauf: kein Ziel, keine Teildatei, kein Temp-Ordner
    const dir2 = await tempDir();
    const all = fakeDownloads(ARTS, tooBig);
    const r2 = await installArtifacts(dir2, [MODEL.art], deps(all.fetch));
    expect(r2.ok).toBe(false);
    expect(all.calls.length).toBe(1 + MAX_RESTARTS);
    expect(await readdir(dir2)).toEqual([]);
  });

  test("Abruf scheitert ganz (fetch wirft): zählt als Netzfehler und wird wiederholt", async () => {
    const dir = await tempDir();
    const part = join(dir, "vad.part");
    const { fetch, calls } = fakeDownloads(ARTS, (t, call, n) => (n === 1 ? "netzfehler" : serveFull(t, call, n)));
    expect(await downloadArtifact(VAD.art, part, deps(fetch))).toEqual({ ok: true });
    expect(calls.length).toBe(2);
  });

  test("langsame Übertragung bricht nicht ab; Stillstand gilt als Netzfehler und wird fortgesetzt", async () => {
    const dir = await tempDir();
    const slowPart = join(dir, "langsam.part");
    // Stückweise mit Pausen unter der Stillstandsgrenze, insgesamt deutlich länger als die Grenze
    const slow: HttpFetch = async () => {
      let i = 0;
      const chunks = Array.from({ length: 8 }, (_, k) => MODEL.body.subarray(k * 175, (k + 1) * 175));
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(c) {
            if (i >= chunks.length) return c.close();
            await Bun.sleep(25);
            c.enqueue(new Uint8Array(chunks[i++]));
          },
        }),
        { status: 200 },
      );
    };
    expect(await downloadArtifact(MODEL.art, slowPart, deps(slow, { idleTimeoutMs: 80 }))).toEqual({ ok: true });

    const stallPart = join(dir, "stillstand.part");
    const { fetch, calls } = fakeDownloads(ARTS, (t, call, n) => {
      if (n > 1) return serveFull(t, call, n);
      // 300 Byte, dann nichts mehr: kein Ende, kein Fehler
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({ pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array(t.body.subarray(0, 300))); } return new Promise(() => {}); } }), { status: 200 });
    });
    expect(await downloadArtifact(MODEL.art, stallPart, deps(fetch, { idleTimeoutMs: 40 }))).toEqual({ ok: true });
    expect(calls.map(c => c.range)).toEqual([undefined, "bytes=300-"]);
  });

  test("HTTP-Fehler: Meldung mit Status, keine Teildatei", async () => {
    const dir = await tempDir();
    const part = join(dir, "x.part");
    const { fetch } = fakeDownloads(ARTS, () => new Response("weg", { status: 404 }));
    const r = await downloadArtifact(MODEL.art, part, deps(fetch));
    expect(r).toEqual({ ok: false, aborted: false, message: "modell.tar.bz2: der Server antwortete mit HTTP 404." });
    expect(existsSync(part)).toBe(false);
  });
});

describe("Prüfsumme und Ablage", () => {
  test("Prüfsummenfehler: Teildatei gelöscht, nichts am Zielort", async () => {
    const dir = await tempDir();
    const wrong: TestArtifact = { ...MODEL, art: { ...MODEL.art, sha256: "0".repeat(64) } };
    const { fetch } = fakeDownloads([wrong]);
    const r = await installArtifacts(dir, [wrong.art], deps(fetch));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Prüfsumme stimmt nicht");
    expect(await leftovers(dir)).toEqual([]);
    expect(existsSync(join(dir, wrong.art.target))).toBe(false);
  });

  test("Erfolg: Ziel entsteht per rename erst nach geprüfter Summe, ohne Reste", async () => {
    const dir = await tempDir();
    const ops: string[] = [];
    const spy: DownloadFs = {
      ...nodeDownloadFs,
      sha256: async p => {
        ops.push(`sha256 ${p.slice(dir.length + 1)}`);
        return nodeDownloadFs.sha256(p);
      },
      rename: async (a, b) => {
        ops.push(`rename ${a.slice(dir.length + 1).replace(/-[0-9a-f]{8}/, "-*")} -> ${b.slice(dir.length + 1)}`);
        // Vor dem rename gibt es das Ziel noch nicht
        expect(existsSync(b)).toBe(false);
        return nodeDownloadFs.rename(a, b);
      },
    };
    const { fetch } = fakeDownloads(ARTS);
    const r = await installArtifacts(dir, ARTS.map(a => a.art), deps(fetch, { fs: spy, run: fakeProcesses(ARTS).run }));
    expect(r).toEqual({ ok: true });
    expect(ops).toEqual([
      "sha256 laufzeit.tar.bz2.part",
      "rename .tmp-laufzeit-*/paket-laufzeit -> sherpa-onnx-v1.13.8",
      "sha256 silero_vad.onnx.part",
      "rename silero_vad.onnx.part -> silero_vad.onnx",
      "sha256 modell.tar.bz2.part",
      "rename .tmp-modell-*/paket-modell -> parakeet-tdt-0.6b-v3-int8",
    ]);
    expect(await leftovers(dir)).toEqual([]);
    const paths = parakeetPaths(dir, "osx-arm64");
    for (const f of [paths.program, ...paths.libs, paths.vad, paths.tokens, paths.encoder, paths.decoder, paths.joiner]) expect(existsSync(f)).toBe(true);
  });

  test("Entpacken scheitert: kein Zielordner, kein Temp-Ordner, keine Teildatei", async () => {
    const dir = await tempDir();
    const { fetch } = fakeDownloads(ARTS);
    const r = await installArtifacts(dir, [MODEL.art], deps(fetch, { run: fakeProcesses(ARTS, "gut", "kaputt").run }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Entpacken fehlgeschlagen");
    expect(await readdir(dir)).toEqual([]);
  });

  test("unvollständiges Ziel aus einem früheren Lauf wird ersetzt; scheitert das Ersetzen, bleibt es", async () => {
    const dir = await tempDir();
    const target = join(dir, MODEL.art.target);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "tokens.txt"), "alt");
    const { fetch } = fakeDownloads(ARTS);
    expect(await installArtifacts(dir, [MODEL.art], deps(fetch))).toEqual({ ok: true });
    expect(await readFile(join(target, "tokens.txt"), "utf8")).toBe("modell tokens.txt");
    expect(existsSync(join(target, "encoder.int8.onnx"))).toBe(true);

    // Zweiter Fall: das neue Verzeichnis lässt sich nicht hineinlegen
    const dir2 = await tempDir();
    const target2 = join(dir2, MODEL.art.target);
    await mkdir(target2, { recursive: true });
    await writeFile(join(target2, "tokens.txt"), "alt");
    const failing: DownloadFs = {
      ...nodeDownloadFs,
      rename: async (a, b) => {
        if (b === target2 && a.endsWith("paket-modell")) throw Object.assign(new Error("EXDEV"), { name: "Error" });
        return nodeDownloadFs.rename(a, b);
      },
    };
    const r = await installArtifacts(dir2, [MODEL.art], deps(fakeDownloads(ARTS).fetch, { fs: failing }));
    expect(r.ok).toBe(false);
    expect(await readFile(join(target2, "tokens.txt"), "utf8")).toBe("alt");
    expect(await leftovers(dir2)).toEqual([]);
  });

  test("Reste früherer Läufe (Teildateien, Temp-Ordner) räumt ein neuer Lauf zuerst weg", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "modell.tar.bz2.part"), "halb");
    await mkdir(join(dir, ".tmp-modell-deadbeef", "x"), { recursive: true });
    const { fetch, calls } = fakeDownloads(ARTS);
    expect(await installArtifacts(dir, [VAD.art], deps(fetch))).toEqual({ ok: true });
    expect(await leftovers(dir)).toEqual([]);
    // Neu von vorn: kein Range
    expect(calls.every(c => !c.range)).toBe(true);
  });
});

describe("Platz und Abbruch", () => {
  test("zu wenig Platz: kein Download, Satz mit der fehlenden Menge", async () => {
    let fetched = 0;
    const ctx = await speechCtx({ freeBytes: 400_000_000, overrides: { fetch: async () => { fetched++; throw new Error("kein Netz"); } } });
    const plan = speechPlan(await speechPathValues(ctx)).join(" ");
    expect(plan).toContain("Zu wenig Platz");
    expect(plan).toContain("Es fehlen ca. 889 MB");
    expect(plan).not.toContain("Der Download beginnt erst nach deinem Ja");
    const r = await runLocalSpeech({}, ctx, () => {}, new AbortController().signal);
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Zu wenig Platz: es fehlen ca. 889 MB (nötig ca. 1,3 GB, frei 400 MB). Es wurde nichts heruntergeladen.");
    expect(fetched).toBe(0);
    expect(existsSync(speechDir(ctx.root))).toBe(false);
  });

  test("ausdrücklicher Abbruch mitten im Download: keine Teildatei, kein Temp-Ordner, nichts am Zielort", async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const { fetch } = fakeDownloads(ARTS, t => {
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (!sent) {
              sent = true;
              c.enqueue(new Uint8Array(t.body.subarray(0, 200)));
              // Strg+C nach dem ersten Stück
              setTimeout(() => controller.abort(), 5);
              return;
            }
            return new Promise(() => {});
          },
        }),
        { status: 200 },
      );
    });
    const r = await installArtifacts(dir, ARTS.map(a => a.art), deps(fetch, { signal: controller.signal }));
    expect(r).toEqual({ ok: false, aborted: true, message: "Abgebrochen." });
    expect(await readdir(dir)).toEqual([]);
  });

  test("Abbruch beim Entpacken: kein Temp-Ordner, keine Teildatei", async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const procs = fakeProcesses(ARTS);
    const run: DownloadDeps["run"] = async (cmd, o) => {
      controller.abort();
      return procs.run(cmd, o);
    };
    const r = await placeArtifact(MODEL.art, join(dir, "modell.tar.bz2.part"), dir, deps(fakeDownloads(ARTS).fetch, { run, signal: controller.signal }));
    expect(r.ok).toBe(false);
    expect(await leftovers(dir)).toEqual([]);
    expect(existsSync(join(dir, MODEL.art.target))).toBe(false);
  });

  test("Ablauf im Schritt: Abbruch meldet „Abgebrochen“, löscht halbe Dateien, schreibt keinen Nachweis", async () => {
    const controller = new AbortController();
    let ctx: SetupContext;
    ctx = await speechCtx();
    const arts = testArtifacts(parakeetPaths(speechDir(ctx.root), "osx-arm64"));
    const { fetch } = fakeDownloads(arts, (t, call, n) => {
      if (t.art.id === "modell") {
        controller.abort();
        return "netzfehler";
      }
      return serveFull(t, call, n);
    });
    ctx.fetch = fetch;
    ctx.run = fakeProcesses(arts).run as typeof ctx.run;
    const r = await runLocalSpeech({}, ctx, () => {}, controller.signal, { artifacts: arts.map(a => a.art) });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Abgebrochen. Halbe Dateien sind gelöscht.");
    // Laufzeit und VAD waren vollständig und geprüft; sie bleiben und werden genannt
    expect(r.message).toContain("Vollständig abgelegt und geprüft: Laufzeit sherpa-onnx, VAD (Silero).");
    expect(await leftovers(speechDir(ctx.root))).toEqual([]);
    expect(existsSync(join(speechDir(ctx.root), "parakeet-tdt-0.6b-v3-int8"))).toBe(false);
    expect(existsSync(join(speechDir(ctx.root), "parakeet.ok.json"))).toBe(false);
  });
});
