/**
 * Issue #253, Checkbox 2: Klon-Engine im Schritt „sprache". Pocket TTS mit
 * Klon-Gewichten (gated, Hugging-Face-Token nur für diesen Lauf) und
 * Qwen3-TTS Base (Mac). Alles mit Prozess-Attrappen: kein Python, kein pip,
 * kein Modell, kein Netz, kein echter Token.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setSettingsPath } from "../src/lib/settings";
import { QWEN_CLONE_REPO, QWEN_CLONE_REVISION, qwenClonePaths } from "../src/lib/speech/clone";
import { speechDir } from "../src/lib/speech/parakeet";
import { POCKET_CLONE_FILE, POCKET_CLONE_REPO, POCKET_CLONE_REVISION, pocketClonePaths, pocketPaths, type PocketServerDeps } from "../src/lib/speech/pocket";
import type { SetupContext } from "../src/setup/context";
import {
  CLONE_FIELD,
  CLONE_TERMS_FIELD,
  CLONE_TOKEN_FIELD,
  clonePlan,
  cloneInventory,
  runClone,
  runPocketClone,
  runQwenClone,
} from "../src/setup/speech-clone";
import { SPEECH_FIELDS, speechPlan, speechPathValues } from "../src/setup/steps/speech";
import { cleanup } from "./setup-fixture";
import { readJson, speechCtx, type SpeechCtxOptions } from "./parakeet-fixture";
import { recordingWav } from "./voice-clone-fixture";

afterEach(() => setSettingsPath());
afterAll(async () => {
  await cleanup();
});

/** Kein echter Token: nur das Format stimmt */
const FAKE_TOKEN = "hf_" + "x".repeat(30);

type FetchMode = "ok" | "gated" | "token" | "net" | "abort";

interface World extends SpeechCtxOptions {
  pocketInstalled?: boolean;
  fetch?: FetchMode;
  /** Pocket-Prozess der Probe endet sofort (Klon-Gewichte fehlen: Exit 3 im Wächter) */
  probeDies?: boolean;
  qwenRun?: "ok" | "fail";
}

async function world(o: World = {}) {
  const ctx = await speechCtx({ ...o, programs: ["ffmpeg", "python3"] });
  let clock = Date.parse("2026-10-01T08:00:00.000Z");
  ctx.now = () => new Date(clock);
  const dir = speechDir(ctx.root);
  const pp = pocketPaths(dir);
  const cp = pocketClonePaths(dir);
  const qp = qwenClonePaths(dir);
  if (o.pocketInstalled !== false) {
    await mkdir(join(pp.venv, "bin"), { recursive: true });
    await writeFile(pp.program, "#!/bin/sh\n");
    await writeFile(pp.python, "py");
    await mkdir(pp.modelCache, { recursive: true });
  }
  const calls: { cmd: string[]; env?: Record<string, string> }[] = [];
  const controller = new AbortController();

  ctx.run = (async (cmd: string[], opts: { env?: Record<string, string>; cwd?: string } = {}) => {
    calls.push({ cmd, ...(opts.env ? { env: opts.env } : {}) });
    const ok = { code: 0, stdout: "", stderr: "" };
    if (cmd[0] === "python3" && cmd[1] === "-c") return { ...ok, stdout: "3.12\n" };
    if (cmd[0] === "python3" && cmd[1] === "-m" && cmd[2] === "venv") {
      await mkdir(join(cmd[3], "bin"), { recursive: true });
      await writeFile(join(cmd[3], "bin", "python"), "py");
      return ok;
    }
    if (cmd[1] === "-m" && cmd[2] === "pip") return ok;
    if (cmd[0] === pp.python && cmd[2] === "-c") {
      const mode = o.fetch ?? "ok";
      if (mode === "gated") return { code: 3, stdout: "", stderr: "STDERR-MARKER" };
      if (mode === "token") return { code: 4, stdout: "", stderr: "STDERR-MARKER" };
      if (mode === "net") return { code: 5, stdout: "", stderr: "STDERR-MARKER" };
      if (mode === "abort") {
        controller.abort();
        return { code: -1, stdout: "", stderr: "", aborted: true };
      }
      const file = join(cp.cloneCache, "snapshots", POCKET_CLONE_REVISION, POCKET_CLONE_FILE);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "gewichte");
      return ok;
    }
    if (cmd[0] === qp.python && cmd[2] === "-c") {
      await mkdir(qp.snapshot, { recursive: true });
      return ok;
    }
    if (cmd[0] === qp.python && cmd.includes("mlx_audio.tts.generate")) {
      if (o.qwenRun === "fail") return { code: 1, stdout: "", stderr: "STDERR-MARKER" };
      clock += 2600;
      const prefix = cmd[cmd.indexOf("--file_prefix") + 1];
      await writeFile(join(opts.cwd!, `${prefix}_000.wav`), recordingWav(2));
      return ok;
    }
    throw new Error(`unerwarteter Befehl ${cmd.join(" ")}`);
  }) as SetupContext["run"];

  const spawned: string[][] = [];
  const pocketServer: PocketServerDeps = {
    spawn(cmd) {
      spawned.push(cmd);
      return { exited: o.probeDies ? Promise.resolve() : new Promise(() => {}), kill: () => {} };
    },
    async fetch(url) {
      if (o.probeDies) throw new Error("weg");
      if (url.endsWith("/health")) {
        clock += 1000;
        return new Response("{}");
      }
      clock += 300;
      return new Response(new Uint8Array(recordingWav(3)));
    },
    freePort: async () => 41000,
    now: () => clock,
    sleep: async () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  };
  ctx.speechVoice = { pocketServer };
  const step: string[] = [];
  return { ctx, dir, pp, cp, qp, calls, spawned, controller, step, steps: (l: string) => void step.push(l), settings: () => readJson(ctx.settingsPath).catch(() => null) };
}

const pocketValues = (extra: Record<string, string> = {}) => ({ [CLONE_FIELD]: "pocket", [CLONE_TERMS_FIELD]: "true", [CLONE_TOKEN_FIELD]: FAKE_TOKEN, ...extra });

describe("Pocket TTS mit Klon-Gewichten: Download nur nach Zustimmung", () => {
  test("ohne Ja zu Kyutais Bedingungen: kein Prozess, nichts geladen", async () => {
    for (const terms of ["false", "", "ja"]) {
      const w = await world();
      const r = await runPocketClone(pocketValues({ [CLONE_TERMS_FIELD]: terms }), w.ctx, w.controller.signal, w.steps, w.ctx.speechVoice);
      expect(r.ok).toBe(false);
      expect(r.message).toContain("Kyutais Bedingungen");
      expect(w.calls).toEqual([]);
      expect(existsSync(w.cp.cloneReady)).toBe(false);
    }
  });

  test("ohne Token oder ohne Pocket TTS: nichts geladen", async () => {
    const a = await world();
    expect((await runPocketClone(pocketValues({ [CLONE_TOKEN_FIELD]: "" }), a.ctx, a.controller.signal, a.steps, a.ctx.speechVoice)).message).toContain("Ohne Hugging-Face-Token");
    expect(a.calls).toEqual([]);
    const b = await world({ pocketInstalled: false });
    expect((await runPocketClone(pocketValues(), b.ctx, b.controller.signal, b.steps, b.ctx.speechVoice)).message).toContain("Zuerst die lokale Stimme Pocket TTS");
    expect(b.calls).toEqual([]);
  });

  test("Token nur als HF_TOKEN in der Umgebung des Download-Prozesses, nie als Argument, nie gespeichert", async () => {
    const w = await world();
    const r = await runPocketClone(pocketValues(), w.ctx, w.controller.signal, w.steps, w.ctx.speechVoice);
    expect(r.ok).toBe(true);
    const fetch = w.calls.find(c => c.cmd[2] === "-c")!;
    expect(fetch.cmd.slice(-3)).toEqual([POCKET_CLONE_REPO, POCKET_CLONE_FILE, POCKET_CLONE_REVISION]);
    expect(fetch.cmd.join(" ")).not.toContain(FAKE_TOKEN);
    expect(fetch.env?.HF_TOKEN).toBe(FAKE_TOKEN);
    expect(fetch.env?.HF_HOME).toBe(w.pp.hfHome);
    expect(fetch.env?.HF_HUB_OFFLINE).toBeUndefined();
    // Probe-Prozess ohne Token, offline, mit eigener Stimme statt Katalogstimme
    expect(w.spawned).toHaveLength(1);
    expect(w.spawned[0]).toContain("--clone-id");
    expect(w.spawned[0]).not.toContain("--voice");
    // Nirgends abgelegt: weder .env noch Nachweise noch Einstellungen
    for (const path of [w.ctx.envPath, w.cp.cloneReady, w.cp.cloneProof, w.ctx.settingsPath]) {
      const text = existsSync(path) ? await readFile(path, "utf8") : "";
      expect(text).not.toContain(FAKE_TOKEN);
    }
    expect(r.changed.join(" ")).not.toContain(FAKE_TOKEN);
    expect(r.message).not.toContain(FAKE_TOKEN);
    expect((await w.settings())?.speech?.cloneEngine).toBe("pocket");
    expect(JSON.parse(await readFile(w.cp.cloneProof, "utf8"))).toMatchObject({ version: 1, revision: POCKET_CLONE_REVISION });
    // Probe-Referenz wieder weg
    expect(existsSync(join(w.pp.dir))).toBe(true);
    expect((await import("node:fs")).readdirSync(w.pp.dir).filter(n => n.startsWith(".tmp"))).toEqual([]);
  });

  test("fehlende Freischaltung bei Hugging Face (gated): klare Meldung, kein Nachweis", async () => {
    const w = await world({ fetch: "gated" });
    const r = await runPocketClone(pocketValues(), w.ctx, w.controller.signal, w.steps, w.ctx.speechVoice);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("die Bedingungen akzeptieren");
    expect(r.message).not.toContain("STDERR-MARKER");
    expect(existsSync(w.cp.cloneReady)).toBe(false);
    expect(existsSync(w.cp.cloneProof)).toBe(false);
    expect(w.spawned).toEqual([]);
  });

  test("abgelehnter Token und Netzfehler: Meldung ohne Ausgabe des Prozesses", async () => {
    const t = await world({ fetch: "token" });
    expect((await runPocketClone(pocketValues(), t.ctx, t.controller.signal, t.steps, t.ctx.speechVoice)).message).toContain("Token wurde abgelehnt");
    const n = await world({ fetch: "net" });
    const r = await runPocketClone(pocketValues(), n.ctx, n.controller.signal, n.steps, n.ctx.speechVoice);
    expect(r.message).toContain("Exit-Code 5");
    expect(existsSync(n.cp.cloneProof)).toBe(false);
  });

  test("Abbruch während des Downloads: kein Nachweis, keine Einstellung", async () => {
    const w = await world({ fetch: "abort" });
    const r = await runPocketClone(pocketValues(), w.ctx, w.controller.signal, w.steps, w.ctx.speechVoice);
    expect(r.ok).toBe(false);
    expect(r.message).toStartWith("Abgebrochen.");
    expect(existsSync(w.cp.cloneReady)).toBe(false);
    expect((await w.settings())?.speech?.cloneEngine).toBeUndefined();
  });

  test("Modell ohne Klon-Gewichte (Wächter endet beim Start): Probe nicht bestanden, kein Nachweis", async () => {
    const w = await world({ probeDies: true });
    const r = await runPocketClone(pocketValues(), w.ctx, w.controller.signal, w.steps, w.ctx.speechVoice);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Probe nicht bestanden");
    expect(existsSync(w.cp.cloneProof)).toBe(false);
    expect((await w.settings())?.speech?.cloneEngine).toBeUndefined();
  });

  test("schon geladen: kein Download, nur die Probe", async () => {
    const w = await world();
    expect((await runPocketClone(pocketValues(), w.ctx, w.controller.signal, w.steps, w.ctx.speechVoice)).ok).toBe(true);
    w.calls.length = 0;
    const r = await runPocketClone(pocketValues({ [CLONE_TOKEN_FIELD]: "" }), w.ctx, w.controller.signal, w.steps, w.ctx.speechVoice);
    expect(r.ok).toBe(true);
    expect(w.calls).toEqual([]);
  });
});

describe("Qwen3-TTS Base (Mac)", () => {
  test("nur Mac mit Apple Silicon: sonst kein Prozess", async () => {
    const w = await world({ platform: "linux", arch: "x64" });
    const r = await runQwenClone(w.ctx, w.controller.signal, w.steps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("nur auf einem Mac mit Apple Silicon");
    expect(w.calls).toEqual([]);
  });

  test("venv, Modell an fester Revision, Probe mit Prozess-Attrappe, Nachweis und Engine", async () => {
    const w = await world();
    const r = await runQwenClone(w.ctx, w.controller.signal, w.steps);
    expect(r.ok).toBe(true);
    const pip = w.calls.find(c => c.cmd[2] === "pip")!;
    expect(pip.cmd).toContain("mlx-audio==0.5.7");
    const fetch = w.calls.find(c => c.cmd[0] === w.qp.python && c.cmd[2] === "-c")!;
    expect(fetch.cmd.slice(-2)).toEqual([QWEN_CLONE_REPO, QWEN_CLONE_REVISION]);
    expect(fetch.env?.HF_HOME).toBe(w.qp.hfHome);
    expect(fetch.env?.HF_TOKEN).toBeUndefined();
    const gen = w.calls.find(c => c.cmd.includes("mlx_audio.tts.generate"))!;
    expect(gen.cmd[gen.cmd.indexOf("--model") + 1]).toBe(w.qp.snapshot);
    expect(gen.env?.HF_HUB_OFFLINE).toBe("1");
    expect(gen.cmd.some(c => c.startsWith("--ref_text="))).toBe(true);
    expect(existsSync(w.qp.proof)).toBe(true);
    expect((await w.settings())?.speech?.cloneEngine).toBe("qwen3-base");
    expect(r.message).toContain("langsamer als Echtzeit");
  });

  test("Probe scheitert: kein Nachweis, Engine nicht gewählt", async () => {
    const w = await world({ qwenRun: "fail" });
    const r = await runQwenClone(w.ctx, w.controller.signal, w.steps);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain("STDERR-MARKER");
    expect(existsSync(w.qp.proof)).toBe(false);
    expect((await w.settings())?.speech?.cloneEngine).toBeUndefined();
  });
});

describe("Plan und Felder", () => {
  test("Plan nennt Größen, Zustimmung und dass der Token nicht gespeichert wird", async () => {
    const w = await world();
    const inv = cloneInventory(w.ctx);
    const pocket = clonePlan(inv, "pocket", pocketValues(), false).join(" ");
    expect(pocket).toContain("219 MB");
    expect(pocket).toContain("bewusste Zustimmung zu Kyutais Bedingungen");
    expect(pocket).toContain("Token wird nicht gespeichert");
    expect(pocket).toContain("erst nach deinem Ja");
    const qwen = clonePlan(inv, "qwen", {}, false).join(" ");
    expect(qwen).toContain("4,5 GB");
    expect(qwen).toContain("langsamer als Echtzeit");
    expect(clonePlan(inv, "nein", {}, false)).toEqual([]);
    const noTerms = clonePlan(inv, "pocket", pocketValues({ [CLONE_TERMS_FIELD]: "false" }), false).join(" ");
    expect(noTerms).toContain("lädt tybo die Klon-Gewichte nicht");
  });

  test("Plan des Schritts enthält den Teil, Felder nur bei Pocket sichtbar, Token nur für diesen Lauf", async () => {
    const w = await world();
    const values = { ...(await speechPathValues(w.ctx)), ...pocketValues() };
    expect(speechPlan(values).join(" ")).toContain("Klon-Gewichte von Kyutai");
    const token = SPEECH_FIELDS.find(f => f.name === CLONE_TOKEN_FIELD)!;
    expect(token.kind).toBe("secret");
    expect(token.transient).toBe(true);
    expect(token.visible?.({ [CLONE_FIELD]: "pocket" })).toBe(true);
    expect(token.visible?.({ [CLONE_FIELD]: "qwen" })).toBe(false);
    expect(token.validate?.("abc", {})).not.toBeNull();
    expect(token.validate?.(FAKE_TOKEN, {})).toBeNull();
    expect(SPEECH_FIELDS.find(f => f.name === CLONE_FIELD)?.default).toBe("nein");
  });

  test("runClone: nein heißt nichts, Meldung verweist auf die WebUI", async () => {
    const w = await world();
    expect(await runClone({ [CLONE_FIELD]: "nein" }, w.ctx, w.controller.signal, w.steps)).toBeNull();
    const r = await runClone(pocketValues(), w.ctx, w.controller.signal, w.steps, w.ctx.speechVoice);
    expect(r?.ok).toBe(true);
    expect(r?.message).toContain("Eigene Stimme");
  });
});
