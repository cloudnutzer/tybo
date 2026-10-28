/**
 * Software-Updates (src/software-update.ts) und ihre Zeile im Nachtcheck:
 * nur mit Attrappe statt echter Befehle, es wird nichts installiert.
 */
import { describe, expect, test } from "bun:test";
import { evaluateDisk, evaluateSoftwareUpdate, parseDf } from "../src/health-check";
import { selectServices } from "../src/setup/services/launchd";
import { describeStep, isNewer, notificationText, parseVersion, runSmoke, runUpdates, updateBrew, type Runner, type SmokeResult, type UpdateState } from "../src/software-update";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GB = 1024 ** 3;
const H = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-11T01:30:00Z");

/** Attrappe: Antwort je Befehl (Text vor dem ersten Argument-Leerzeichen zählt), Aufrufe mitschreiben */
function fakeRunner(answers: Record<string, Array<{ code?: number | null; stdout?: string; stderr?: string }>>) {
  const calls: string[] = [];
  const runner: Runner = async cmd => {
    const key = cmd.join(" ");
    calls.push(key);
    const queue = answers[key];
    const a = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    if (!a) return { code: 127, stdout: "", stderr: "not found" };
    return { code: a.code === undefined ? 0 : a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { runner, calls };
}

test("parseVersion: Claude, Codex, Bun", () => {
  expect(parseVersion("2.1.293 (Claude Code)")).toBe("2.1.293");
  expect(parseVersion("codex-cli 0.159.2")).toBe("0.159.2");
  expect(parseVersion("1.3.0")).toBe("1.3.0");
  expect(parseVersion("kaputt")).toBeUndefined();
});

describe("runUpdates nachts", () => {
  const noSmoke = async () => [] as SmokeResult[];

  test("Claude und Codex aktualisieren, Bun und brew nur prüfen", async () => {
    const { runner, calls } = fakeRunner({
      "claude --version": [{ stdout: "2.1.293 (Claude Code)" }, { stdout: "2.1.295 (Claude Code)" }],
      "claude update": [{ stdout: "Updated" }],
      "bun --version": [{ stdout: "1.3.10" }],
      "brew --version": [{ stdout: "Homebrew 5.0.1" }],
      "brew update --quiet": [{}],
      "brew outdated --quiet": [{ stdout: "ffmpeg\nyt-dlp\n" }],
    });
    let smoked = 0;
    const state = await runUpdates("nightly", { runner, env: {}, now: () => new Date(NOW), latestBun: async () => "1.4.3", smoke: async () => (smoked++, [{ name: "Claude CLI", ok: true, detail: "2.1.295" }]) });
    expect(state.steps).toEqual([
      { name: "Claude CLI", status: "updated", before: "2.1.293", after: "2.1.295" },
      { name: "Codex", status: "skip", detail: "nicht installiert" },
      { name: "Bun", status: "available", before: "1.3.10", after: "1.4.3" },
      { name: "brew", status: "available", detail: "2 Pakete (ffmpeg, yt-dlp)" },
    ]);
    expect(calls).not.toContain("bun upgrade");
    expect(calls).not.toContain("brew upgrade");
    expect(calls).not.toContain("codex update");
    expect(smoked).toBe(1);
    expect(state.smoke).toEqual([{ name: "Claude CLI", ok: true, detail: "2.1.295" }]);
    expect(describeStep(state.steps[0])).toBe("Claude CLI: aktualisiert, 2.1.293 → 2.1.295");
    expect(describeStep(state.steps[2])).toBe("Bun: verfügbar, 1.3.10 → 1.4.3");
  });

  test("nichts aktualisiert: keine Prüfung", async () => {
    const { runner } = fakeRunner({ "bun --version": [{ stdout: "1.4.3" }] });
    let smoked = 0;
    const state = await runUpdates("nightly", { runner, env: {}, now: () => new Date(NOW), latestBun: async () => "1.4.3", smoke: async () => (smoked++, []) });
    expect(state.steps[2]).toEqual({ name: "Bun", status: "current", before: "1.4.3", after: "1.4.3" });
    expect(smoked).toBe(0);
    expect(state.smoke).toBeUndefined();
  });

  test("Bun-Release nicht abrufbar: übersprungen statt Fehler", async () => {
    const { runner } = fakeRunner({ "bun --version": [{ stdout: "1.4.3" }] });
    const state = await runUpdates("nightly", { runner, env: {}, now: () => new Date(NOW), latestBun: async () => null, smoke: noSmoke });
    expect(state.steps[2]).toMatchObject({ name: "Bun", status: "skip" });
  });

  test("Update scheitert: Grund aus der letzten Zeile, Version bleibt", async () => {
    const { runner } = fakeRunner({
      "codex --version": [{ stdout: "codex-cli 0.159.2" }],
      "codex update": [{ code: 1, stderr: "Fehler\nnetwork unreachable" }],
    });
    const state = await runUpdates("nightly", { runner, env: {}, now: () => new Date(NOW), latestBun: async () => null, smoke: noSmoke });
    expect(state.steps[1]).toEqual({ name: "Codex", status: "fail", before: "0.159.2", detail: "network unreachable" });
  });
});

describe("runUpdates --apply", () => {
  test("bun upgrade und brew upgrade, ohne cleanup, alte Versionen bleiben, danach Prüfung", async () => {
    const { runner, calls } = fakeRunner({
      "bun --version": [{ stdout: "1.3.10" }, { stdout: "1.4.3" }],
      "bun upgrade": [{}],
      "brew --version": [{ stdout: "Homebrew 5.0.1" }],
      "brew update --quiet": [{}],
      "brew outdated --quiet": [{ stdout: "ffmpeg" }, { stdout: "" }],
      "brew upgrade": [{}],
    });
    const envs: Array<Record<string, string | undefined> | undefined> = [];
    const spy: Runner = async (cmd, o) => (cmd.join(" ") === "brew upgrade" && envs.push(o?.env), runner(cmd, o));
    const state = await runUpdates("apply", { runner: spy, env: {}, now: () => new Date(NOW), smoke: async () => [{ name: "Selbsttests", ok: true, detail: "60 bestanden" }] });
    expect(state.mode).toBe("apply");
    expect(state.steps).toEqual([
      { name: "Bun", status: "updated", before: "1.3.10", after: "1.4.3" },
      { name: "brew", status: "updated", detail: "1 aktualisiert (ffmpeg)" },
    ]);
    expect(calls.some(c => c.startsWith("brew cleanup"))).toBe(false);
    expect(envs[0]?.HOMEBREW_NO_INSTALL_CLEANUP).toBe("1");
    expect(state.smoke?.length).toBe(1);
  });

  test("brew: Pakete bleiben offen (z. B. Cask braucht sudo) → fail mit Liste", async () => {
    const { runner } = fakeRunner({
      "brew --version": [{ stdout: "Homebrew 5.0.1" }],
      "brew update --quiet": [{}],
      "brew outdated --quiet": [{ stdout: "ffmpeg\nsome-cask" }, { stdout: "some-cask" }],
      "brew upgrade": [{ code: 1, stderr: "sudo: a terminal is required" }],
    });
    expect(await updateBrew(runner)).toEqual({ name: "brew", status: "fail", detail: "1 aktualisiert (ffmpeg), 1 offen (some-cask)" });
  });

  test("brew: nichts veraltet → kein upgrade", async () => {
    const { runner, calls } = fakeRunner({
      "brew --version": [{ stdout: "Homebrew 5.0.1" }],
      "brew update --quiet": [{}],
      "brew outdated --quiet": [{ stdout: "" }],
    });
    expect((await updateBrew(runner)).status).toBe("current");
    expect(calls).not.toContain("brew upgrade");
  });
});

test("isNewer", () => {
  expect(isNewer("1.4.3", "1.3.10")).toBe(true);
  expect(isNewer("1.3.10", "1.4.3")).toBe(false);
  expect(isNewer("1.4.3", "1.4.3")).toBe(false);
  expect(isNewer("3.12", "3.9.6")).toBe(true);
});

describe("Prüfung nach dem Update", () => {
  test("Python zu alt für die Generatoren → ❌, ohne die Skripte zu lesen", async () => {
    const root = mkdtempSync(join(tmpdir(), "upd-"));
    mkdirSync(join(root, "tmp", "site"), { recursive: true });
    writeFileSync(join(root, "tmp", "site", "build.py"), "print(1)\n");
    const { runner, calls } = fakeRunner({
      "claude --version": [{ stdout: "2.1.296 (Claude Code)" }],
      "python3 --version": [{ stdout: "Python 3.9.6" }],
      "ffmpeg -version": [{ stdout: "ffmpeg version 9.0" }],
    });
    const r = await runSmoke({ runner, root, env: {} });
    expect(r).toContainEqual({ name: "Python", ok: false, detail: "python3 ist 3.9.6, die Generatoren brauchen 3.12+" });
    expect(r).toContainEqual({ name: "Claude CLI", ok: true, detail: "2.1.296" });
    expect(calls.some(c => c.startsWith("python3 -c"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("Python passt: Generatoren werden nur geparst; Sprach-Brücke über /health", async () => {
    const root = mkdtempSync(join(tmpdir(), "upd-"));
    mkdirSync(join(root, "tmp", "site"), { recursive: true });
    writeFileSync(join(root, "tmp", "site", "build.py"), "print(1)\n");
    const { runner } = fakeRunner({
      "claude --version": [{ stdout: "2.1.296" }],
      "python3 --version": [{ stdout: "Python 3.14.8" }],
      [`python3 -c import ast,sys\nfor f in sys.argv[1:]: ast.parse(open(f).read(), f) ${join(root, "tmp", "site", "build.py")}`]: [{}],
    });
    const fetcher = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const r = await runSmoke({ runner, root, env: { VOICE_BRIDGE_TOKEN: "x" }, fetcher });
    expect(r).toContainEqual({ name: "Python", ok: true, detail: "3.14.8, 1 Generatoren lesbar" });
    expect(r).toContainEqual({ name: "Sprach-Brücke", ok: true, detail: "erreichbar" });
    expect(r.some(s => s.name === "ffmpeg")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("Meldungen", () => {
  const base = (steps: UpdateState["steps"], extra: Partial<UpdateState> = {}): UpdateState => ({ version: 1, startedAt: "", finishedAt: "", steps, ...extra });

  test("Prüfung gescheitert: sofort, an jedem Tag", () => {
    const t = notificationText(base([{ name: "Claude CLI", status: "updated", before: "1", after: "2" }], { smoke: [{ name: "Python", ok: false, detail: "python3 ist 3.9.6" }] }), 3);
    expect(t).toContain("❌ Python: python3 ist 3.9.6");
    expect(t).toContain("Claude CLI 1 → 2");
  });

  test("verfügbare Updates: nur sonntags", () => {
    const s = base([{ name: "Bun", status: "available", before: "1.3.10", after: "1.4.3" }]);
    expect(notificationText(s, 3)).toBeNull();
    expect(notificationText(s, 0)).toContain("Bun: 1.3.10 → 1.4.3");
  });

  test("alles still, wenn nichts wartet und nichts kaputt ist", () => {
    expect(notificationText(base([{ name: "Claude CLI", status: "updated", before: "1", after: "2" }], { smoke: [{ name: "Claude CLI", ok: true, detail: "2" }] }), 0)).toBeNull();
  });
});

describe("Nachtcheck-Zeile Software-Updates", () => {
  const state = (steps: UpdateState["steps"], hoursAgo = 0.5): UpdateState => ({
    version: 1,
    startedAt: new Date(NOW - hoursAgo * H - 60_000).toISOString(),
    finishedAt: new Date(NOW - hoursAgo * H).toISOString(),
    steps,
  });

  test("nie gelaufen: – ohne Dienst, ⚠️ mit Dienst", () => {
    expect(evaluateSoftwareUpdate(null, NOW, false).status).toBe("na");
    expect(evaluateSoftwareUpdate(null, NOW, true).status).toBe("warn");
  });

  test("ok: neue Versionen und aktuelle Werkzeuge", () => {
    const r = evaluateSoftwareUpdate(
      state([
        { name: "Claude CLI", status: "updated", before: "2.1.293", after: "2.1.295" },
        { name: "Codex", status: "current", before: "0.159.2", after: "0.159.2" },
        { name: "Bun", status: "skip", detail: "nicht installiert" },
        { name: "brew", status: "updated", detail: "2 aktualisiert (ffmpeg, yt-dlp)" },
      ]),
      NOW,
      true
    );
    expect(r).toEqual({
      name: "Software-Updates",
      status: "ok",
      detail: "vor 30 Min, Claude CLI 2.1.293 → 2.1.295, brew 2 aktualisiert (ffmpeg, yt-dlp), aktuell: Codex",
    });
  });

  test("wartet auf Okay und gescheiterte Prüfung: ❌", () => {
    const r = evaluateSoftwareUpdate(
      { ...state([{ name: "Bun", status: "available", before: "1.3.10", after: "1.4.3" }]), smoke: [{ name: "Python", ok: false, detail: "python3 ist 3.9.6" }] },
      NOW,
      true
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("wartet auf Okay: Bun 1.3.10 → 1.4.3");
    expect(r.detail).toContain("Prüfung danach: Python: python3 ist 3.9.6");
  });

  test("gescheiterter Schritt und veralteter Lauf: ⚠️", () => {
    const failed = evaluateSoftwareUpdate(state([{ name: "brew", status: "fail", detail: "1 offen (x)" }]), NOW, true);
    expect(failed.status).toBe("warn");
    expect(failed.detail).toContain("gescheitert: brew: 1 offen (x)");
    expect(evaluateSoftwareUpdate(state([{ name: "Codex", status: "current" }], 4 * 24), NOW, true).status).toBe("warn");
    expect(evaluateSoftwareUpdate(state([{ name: "Codex", status: "current" }], 4 * 24), NOW, false).status).toBe("ok");
  });
});

describe("Nachtcheck-Zeile Plattenplatz", () => {
  test("df: Größe und frei", () => {
    const out = "Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s5 482344960 300000000 135266304 70% 1 2 0% /System/Volumes/Data";
    expect(parseDf(out)).toEqual({ total: 482344960 * 1024, available: 135266304 * 1024 });
    expect(parseDf("kaputt")).toBeNull();
  });

  test("frei von gesamt mit Prozent; Schwellen 25 GB ⚠️ und 10 GB ❌", () => {
    expect(evaluateDisk(460 * GB, 129 * GB)).toEqual({ name: "Plattenplatz", status: "ok", detail: "129 GB von 460 GB frei (28 %)" });
    expect(evaluateDisk(460 * GB, 20 * GB).status).toBe("warn");
    expect(evaluateDisk(460 * GB, 5 * GB).status).toBe("fail");
    expect(evaluateDisk(0, 129 * GB).detail).toBe("129 GB frei");
  });
});

test("launchd: software-update nur ausdrücklich, nie in „all“", async () => {
  expect(await selectServices("all", "/gibt/es/nicht/.env")).not.toContain("software-update");
  expect(await selectServices("software-update", "/gibt/es/nicht/.env")).toEqual(["software-update"]);
});
