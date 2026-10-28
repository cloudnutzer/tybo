#!/usr/bin/env bun
/**
 * Software-Updates (`bun run updates`) in zwei Stufen:
 *
 * - Nachts (ohne Argument): Claude CLI (`claude update`) und Codex
 *   (`codex update`) werden aktualisiert. Bun und Homebrew werden nur
 *   geprüft: neue Versionen landen als „verfügbar“ im Ergebnis. Sonntags
 *   kommt dazu eine Meldung mit der Frage, ob sie eingespielt werden sollen.
 * - Auf Zuruf (`--apply`): `bun upgrade` und `brew upgrade`. Ohne
 *   `brew cleanup` und mit HOMEBREW_NO_INSTALL_CLEANUP, damit die alten
 *   Versionen für ein Zurückwechseln bleiben.
 *
 * Grund für die Trennung: Am 11.10.2026 brachen nach einem Lauf die
 * Spracherkennung (neues Bun) und ein Website-Refresh (python3 nach brew-Update auf
 * System-Python 3.9) still. Bun und Homebrew tragen tybo und die Skripte,
 * ein Versionssprung dort trifft viel auf einmal.
 *
 * Nach jedem Lauf, der etwas aktualisiert hat, folgt eine Prüfung
 * (`--smoke`, als eigener Prozess, also mit dem neuen Bun): Claude CLI,
 * Bun mit einigen Selbsttests, Spracherkennung, Python für die
 * Seiten-Generatoren, ffmpeg, Sprach-Brücke. Scheitert etwas, kommt sofort
 * eine Meldung (`bun run notify --source software-update`).
 *
 * Läuft auf Wunsch täglich um 03:00 als launchd-Dienst ai.tybo.software-update
 * (`bun run setup:launchd -- --service software-update`; nicht in „all“, weil
 * es fremde Software verändert). Das Ergebnis landet in
 * data/software-update.json, der Nachtcheck um 03:30 zeigt es als Zeile
 * „Software-Updates“.
 *
 *   bun run updates             nachts: Claude/Codex aktualisieren, Bun/brew prüfen
 *   bun run updates --apply     Bun und Homebrew einspielen, danach prüfen
 *   bun run updates --smoke     nur die Prüfung
 *   bun run updates --dry-run   nur zeigen, was laufen würde
 *
 * Exit-Code: immer 0, auch wenn einzelne Schritte scheitern (stehen im
 * Ergebnis); 1 nur, wenn das Ergebnis nicht gespeichert werden konnte.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "./lib/env";
import { atomicWriteFile } from "./lib/atomic-file";
import { parakeetAvailability } from "./lib/speech/parakeet";

export const UPDATE_STATE_FILE = join(PROJECT_ROOT, "data", "software-update.json");

export type StepStatus = "updated" | "current" | "available" | "fail" | "skip";

export interface StepResult {
  name: string;
  status: StepStatus;
  before?: string;
  /** Bei available: die verfügbare Version */
  after?: string;
  /** Kurzer Befund, bei fail der Grund */
  detail?: string;
}

export interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
}

export type UpdateMode = "nightly" | "apply";

export interface UpdateState {
  version: 1;
  mode?: UpdateMode;
  startedAt: string;
  finishedAt: string;
  steps: StepResult[];
  /** Prüfung nach dem Update; fehlt, wenn nichts aktualisiert wurde */
  smoke?: SmokeResult[];
}

type Env = Record<string, string | undefined>;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string[], options?: { timeoutMs?: number; env?: Env }) => Promise<RunResult>;

const MIN = 60_000;

async function run(cmd: string[], options: { timeoutMs?: number; env?: Env } = {}): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...options.env } as Record<string, string>,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
  const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 5 * MIN);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { code: proc.signalCode ? null : code, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
  }
}

/** Letzte nicht leere Zeile der Ausgabe, gekürzt: der Grund bei einem Fehler */
export function failReason(r: RunResult): string {
  if (r.code === null) return "Zeitlimit überschritten";
  const lines = `${r.stderr}\n${r.stdout}`.split("\n").map(l => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? `Exit ${r.code}`).slice(0, 120);
}

/** Erste Versionsnummer in einer Ausgabe wie „2.1.293 (Claude Code)“ oder „codex-cli 0.159.2“ */
export function parseVersion(text: string): string | undefined {
  return text.match(/\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.-]+)?/)?.[0];
}

/** Ist a neuer als b? Nur die Zahlen vor einem Zusatz zählen */
export function isNewer(a: string, b: string): boolean {
  const n = (v: string) => v.split(/[-+]/)[0].split(".").map(Number);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

export interface VersionTool {
  name: string;
  bin: string;
  update: string[];
  timeoutMs?: number;
}

/** Werkzeug mit eigener Update-Funktion: Version vorher, Update, Version nachher */
export async function updateVersionTool(tool: VersionTool, runner: Runner): Promise<StepResult> {
  const v1 = await runner([tool.bin, "--version"], { timeoutMs: 30_000 });
  if (v1.code !== 0) return { name: tool.name, status: "skip", detail: "nicht installiert" };
  const before = parseVersion(v1.stdout);
  const r = await runner([tool.bin, ...tool.update], { timeoutMs: tool.timeoutMs ?? 5 * MIN });
  if (r.code !== 0) return { name: tool.name, status: "fail", before, detail: failReason(r) };
  const after = parseVersion((await runner([tool.bin, "--version"], { timeoutMs: 30_000 })).stdout) ?? before;
  return { name: tool.name, status: before && after && before !== after ? "updated" : "current", before, after };
}

/** Neueste Bun-Version laut GitHub („bun-v1.4.3“ → „1.4.3“); null, wenn nicht abrufbar */
export async function latestBunVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetcher("https://api.github.com/repos/oven-sh/bun/releases/latest", {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const tag = String(((await res.json()) as { tag_name?: string }).tag_name ?? "");
    return parseVersion(tag) ?? null;
  } catch {
    return null;
  }
}

/** Bun nur prüfen: installierte gegen neueste Version */
export async function checkBun(runner: Runner, latest: () => Promise<string | null>): Promise<StepResult> {
  const name = "Bun";
  const v = await runner(["bun", "--version"], { timeoutMs: 30_000 });
  if (v.code !== 0) return { name, status: "skip", detail: "nicht installiert" };
  const before = parseVersion(v.stdout);
  const newest = await latest();
  if (!before || !newest) return { name, status: "skip", before, detail: "neueste Version nicht abrufbar" };
  return isNewer(newest, before) ? { name, status: "available", before, after: newest } : { name, status: "current", before, after: before };
}

const BREW_UPDATE_ENV: Env = { HOMEBREW_NO_ENV_HINTS: "1", NONINTERACTIVE: "1" };
/** Nach dem ausdrücklichen `brew update` nicht bei jedem Befehl erneut; alte Versionen behalten */
const BREW_ENV: Env = { ...BREW_UPDATE_ENV, HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1" };

function outdatedList(stdout: string): string[] {
  return stdout.split("\n").map(l => l.trim()).filter(Boolean);
}

/** Homebrew nur prüfen: `brew update` (nur die Paketliste), dann `brew outdated` */
export async function checkBrew(runner: Runner, bin = "brew"): Promise<StepResult> {
  const name = "brew";
  const v = await runner([bin, "--version"], { timeoutMs: 30_000 });
  if (v.code !== 0) return { name, status: "skip", detail: "nicht installiert" };
  const upd = await runner([bin, "update", "--quiet"], { timeoutMs: 10 * MIN, env: BREW_UPDATE_ENV });
  if (upd.code !== 0) return { name, status: "fail", detail: `brew update: ${failReason(upd)}` };
  const pending = outdatedList((await runner([bin, "outdated", "--quiet"], { timeoutMs: 2 * MIN, env: BREW_ENV })).stdout);
  if (pending.length === 0) return { name, status: "current", detail: "alle Pakete aktuell" };
  return { name, status: "available", detail: `${pending.length} Pakete (${shortList(pending)})` };
}

/** Homebrew einspielen: update, upgrade; gezählt über `brew outdated` vorher und nachher, kein cleanup */
export async function updateBrew(runner: Runner, bin = "brew"): Promise<StepResult> {
  const name = "brew";
  const v = await runner([bin, "--version"], { timeoutMs: 30_000 });
  if (v.code !== 0) return { name, status: "skip", detail: "nicht installiert" };
  const upd = await runner([bin, "update", "--quiet"], { timeoutMs: 10 * MIN, env: BREW_UPDATE_ENV });
  if (upd.code !== 0) return { name, status: "fail", detail: `brew update: ${failReason(upd)}` };
  const pending = outdatedList((await runner([bin, "outdated", "--quiet"], { timeoutMs: 2 * MIN, env: BREW_ENV })).stdout);
  if (pending.length === 0) return { name, status: "current", detail: "alle Pakete aktuell" };
  const up = await runner([bin, "upgrade"], { timeoutMs: 60 * MIN, env: BREW_ENV });
  const left = outdatedList((await runner([bin, "outdated", "--quiet"], { timeoutMs: 2 * MIN, env: BREW_ENV })).stdout);
  const done = pending.filter(p => !left.includes(p));
  const doneText = done.length ? `${done.length} aktualisiert (${shortList(done)})` : "";
  if (up.code !== 0 || left.length) {
    const rest = left.length ? `${left.length} offen (${shortList(left)})` : failReason(up);
    return { name, status: "fail", detail: [doneText, rest].filter(Boolean).join(", ") };
  }
  return { name, status: "updated", detail: doneText };
}

function shortList(items: string[], max = 4): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} und ${items.length - max} weitere`;
}

/** Nachts automatisch: nur die beiden Agenten-CLIs */
export function versionTools(env: Env): VersionTool[] {
  return [
    { name: "Claude CLI", bin: env.CLAUDE_PATH || "claude", update: ["update"] },
    { name: "Codex", bin: "codex", update: ["update"] },
  ];
}

export const BUN_TOOL: VersionTool = { name: "Bun", bin: "bun", update: ["upgrade"] };

export interface UpdateDeps {
  runner?: Runner;
  env?: Env;
  now?: () => Date;
  latestBun?: () => Promise<string | null>;
  /** Prüfung als eigener Prozess; Standard: `bun run src/software-update.ts --smoke` */
  smoke?: () => Promise<SmokeResult[]>;
}

const failStep = (name: string) => (err: unknown): StepResult => ({ name, status: "fail", detail: String(err).slice(0, 120) });

export async function runUpdates(mode: UpdateMode = "nightly", deps: UpdateDeps = {}): Promise<UpdateState> {
  const runner = deps.runner ?? run;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const steps: StepResult[] = [];
  // nacheinander: brew und die Installer sollen sich nicht ins Gehege kommen
  if (mode === "nightly") {
    for (const tool of versionTools(env)) steps.push(await updateVersionTool(tool, runner).catch(failStep(tool.name)));
    steps.push(await checkBun(runner, deps.latestBun ?? (() => latestBunVersion())).catch(failStep("Bun")));
    steps.push(await checkBrew(runner).catch(failStep("brew")));
  } else {
    steps.push(await updateVersionTool(BUN_TOOL, runner).catch(failStep("Bun")));
    steps.push(await updateBrew(runner).catch(failStep("brew")));
  }
  const changed = steps.some(s => s.status === "updated" || (s.status === "fail" && mode === "apply"));
  const smoke = changed ? await (deps.smoke ?? (() => smokeInChild(runner)))().catch(err => [{ name: "Prüfung", ok: false, detail: String(err).slice(0, 120) }]) : undefined;
  return { version: 1, mode, startedAt, finishedAt: now().toISOString(), steps, ...(smoke ? { smoke } : {}) };
}

// ---------------------------------------------------------------------------
// Prüfung nach dem Update
// ---------------------------------------------------------------------------

/** Selbsttests, die schnell laufen und Laufzeit-Brüche von Bun zeigen */
export const SMOKE_TESTS = ["tests/software-update.test.ts", "tests/setup-speech-flow.test.ts", "tests/voice-brain-turn.test.ts"];
/** Ab dieser Version laufen die Seiten-Generatoren (f-Strings mit Backslash) */
const MIN_PYTHON = "3.12";

/** Seiten-Generatoren unter tmp/<projekt>/build.py */
export function pythonScripts(root: string): string[] {
  const tmp = join(root, "tmp");
  if (!existsSync(tmp)) return [];
  return readdirSync(tmp)
    .map(d => join(tmp, d, "build.py"))
    .filter(f => existsSync(f));
}

export interface SmokeDeps {
  runner: Runner;
  root: string;
  env: Env;
  fetcher?: typeof fetch;
}

async function smokeCommand(name: string, cmd: string[], runner: Runner, timeoutMs = 60_000): Promise<SmokeResult> {
  const r = await runner(cmd, { timeoutMs });
  return r.code === 0 ? { name, ok: true, detail: parseVersion(r.stdout) ?? "ok" } : { name, ok: false, detail: failReason(r) };
}

/** Alle Prüfungen im laufenden Prozess; über --smoke mit dem neuen Bun aufgerufen */
export async function runSmoke(d: SmokeDeps): Promise<SmokeResult[]> {
  const out: SmokeResult[] = [];
  out.push(await smokeCommand("Claude CLI", [d.env.CLAUDE_PATH || "claude", "--version"], d.runner));

  const tests = SMOKE_TESTS.filter(t => existsSync(join(d.root, t)));
  if (tests.length) {
    const r = await d.runner(["bun", "test", ...tests], { timeoutMs: 5 * MIN });
    const summary = `${r.stdout}\n${r.stderr}`.match(/(\d+) pass[\s\S]*?(\d+) fail/);
    out.push(r.code === 0 ? { name: "Selbsttests", ok: true, detail: summary ? `${summary[1]} bestanden` : "ok" } : { name: "Selbsttests", ok: false, detail: summary ? `${summary[2]} fehlgeschlagen` : failReason(r) });
  }

  const speech = join(d.root, "models", "speech");
  if (existsSync(join(speech, "parakeet.ok.json"))) {
    const stat = (p: string) => {
      try {
        const s = statSync(p);
        return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
      } catch {
        return null;
      }
    };
    const read = (p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    };
    const a = parakeetAvailability(speech, process.platform, process.arch, stat, read);
    out.push({ name: "Spracherkennung (Parakeet)", ok: a.ok, detail: a.ok ? "ok" : a.reason ?? "nicht verfügbar" });
  }

  const scripts = pythonScripts(d.root);
  if (scripts.length) {
    const v = await d.runner(["python3", "--version"], { timeoutMs: 30_000 });
    const version = parseVersion(v.stdout || v.stderr);
    if (v.code !== 0 || !version) out.push({ name: "Python", ok: false, detail: "python3 fehlt" });
    else if (isNewer(MIN_PYTHON, version)) out.push({ name: "Python", ok: false, detail: `python3 ist ${version}, die Generatoren brauchen ${MIN_PYTHON}+` });
    else {
      // nur parsen, nichts ausführen und nichts schreiben
      const p = await d.runner(["python3", "-c", "import ast,sys\nfor f in sys.argv[1:]: ast.parse(open(f).read(), f)", ...scripts], { timeoutMs: 60_000 });
      out.push(p.code === 0 ? { name: "Python", ok: true, detail: `${version}, ${scripts.length} Generatoren lesbar` } : { name: "Python", ok: false, detail: failReason(p) });
    }
  }

  const ff = await d.runner(["ffmpeg", "-version"], { timeoutMs: 30_000 });
  if (ff.code !== 127 && ff.code !== -1) out.push(ff.code === 0 ? { name: "ffmpeg", ok: true, detail: parseVersion(ff.stdout) ?? "ok" } : { name: "ffmpeg", ok: false, detail: failReason(ff) });

  if (d.env.VOICE_BRIDGE_TOKEN) {
    const port = d.env.VOICE_BRIDGE_PORT || "8013";
    try {
      const res = await (d.fetcher ?? fetch)(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(10_000) });
      out.push({ name: "Sprach-Brücke", ok: res.ok, detail: res.ok ? "erreichbar" : `HTTP ${res.status}` });
    } catch {
      out.push({ name: "Sprach-Brücke", ok: false, detail: "nicht erreichbar" });
    }
  }
  return out;
}

/** Prüfung als eigener Prozess, damit sie mit dem gerade eingespielten Bun läuft */
async function smokeInChild(runner: Runner): Promise<SmokeResult[]> {
  const r = await runner(["bun", "run", join(PROJECT_ROOT, "src", "software-update.ts"), "--smoke", "--json"], { timeoutMs: 10 * MIN });
  const line = r.stdout.split("\n").reverse().find(l => l.startsWith("["));
  if (r.code !== 0 || !line) return [{ name: "Prüfung", ok: false, detail: `ließ sich nicht starten: ${failReason(r)}` }];
  return JSON.parse(line) as SmokeResult[];
}

// ---------------------------------------------------------------------------
// Meldungen
// ---------------------------------------------------------------------------

/** Sonntag: Erinnerung an Bun/brew, falls etwas verfügbar ist */
export const REMINDER_WEEKDAY = 0;

/** Text der Meldung oder null: Prüfung gescheitert sofort, verfügbare Updates nur sonntags */
export function notificationText(state: UpdateState, weekday: number): string | null {
  const broken = (state.smoke ?? []).filter(s => !s.ok);
  const updated = state.steps.filter(s => s.status === "updated").map(stepVersions);
  if (broken.length) {
    return [
      "⚠️ Nach dem Software-Update ist etwas kaputt",
      updated.length ? `Aktualisiert: ${updated.join(", ")}` : "",
      ...broken.map(b => `❌ ${b.name}: ${b.detail}`),
      "Die alten Versionen sind noch da (kein brew cleanup). Sag mir Bescheid, dann schaue ich es mir an.",
    ].filter(Boolean).join("\n");
  }
  if (state.mode === "apply") {
    const ok = (state.smoke ?? []).map(s => s.name).join(", ");
    return [`✅ Software-Update eingespielt: ${updated.join(", ") || "nichts zu tun"}`, ok ? `Geprüft: ${ok}` : ""].filter(Boolean).join("\n");
  }
  const available = state.steps.filter(s => s.status === "available");
  if (weekday === REMINDER_WEEKDAY && available.length) {
    return [
      "🔄 Updates warten auf dein Okay",
      ...available.map(s => `- ${s.name}: ${s.before && s.after ? `${s.before} → ${s.after}` : s.detail ?? ""}`),
      "Bun und Homebrew tragen tybo und deine Skripte, deshalb spiele ich sie nicht mehr nachts von selbst ein.",
      "Antworte „Updates einspielen“, dann installiere ich sie und prüfe danach Spracherkennung, Sprach-Brücke, Python und Selbsttests.",
    ].join("\n");
  }
  return null;
}

function stepVersions(s: StepResult): string {
  return s.before && s.after && s.before !== s.after ? `${s.name} ${s.before} → ${s.after}` : `${s.name} ${s.detail ?? ""}`.trim();
}

/** Eine Zeile pro Schritt für das Log und --dry-run */
export function describeStep(s: StepResult): string {
  const versions = s.before && s.after && s.before !== s.after ? `${s.before} → ${s.after}` : s.after ?? s.before ?? "";
  const label = { updated: "aktualisiert", current: "aktuell", available: "verfügbar", fail: "FEHLER", skip: "übersprungen" }[s.status];
  return [`${s.name}: ${label}`, versions, s.detail].filter(Boolean).join(", ");
}

async function main(argv: string[]): Promise<number> {
  const { loadEnv } = await import("./lib/env");
  await loadEnv();
  if (argv.includes("--dry-run")) {
    console.log("nachts:");
    for (const t of versionTools(process.env)) console.log(`  ${t.name}: ${t.bin} ${t.update.join(" ")}`);
    console.log("  Bun: nur prüfen (GitHub-Release)");
    console.log("  brew: brew update, brew outdated (nur prüfen)");
    console.log("--apply: bun upgrade, brew update, brew upgrade (ohne cleanup)");
    console.log("danach, wenn etwas aktualisiert wurde: --smoke");
    return 0;
  }
  if (argv.includes("--smoke")) {
    const results = await runSmoke({ runner: run, root: PROJECT_ROOT, env: process.env });
    if (argv.includes("--json")) console.log(JSON.stringify(results));
    else for (const s of results) console.log(`${s.ok ? "✅" : "❌"} ${s.name}: ${s.detail}`);
    return 0;
  }
  const mode: UpdateMode = argv.includes("--apply") ? "apply" : "nightly";
  const state = await runUpdates(mode);
  console.log(`[${state.finishedAt}] Software-Updates (${mode === "apply" ? "einspielen" : "nachts"})`);
  for (const s of state.steps) console.log(describeStep(s));
  for (const s of state.smoke ?? []) console.log(`${s.ok ? "✅" : "❌"} ${s.name}: ${s.detail}`);
  // Der Bot läuft noch mit dem alten Bun: Neustart nach der laufenden Antwort
  if (state.steps.some(s => s.name === "Bun" && s.status === "updated")) {
    await run(["bun", "run", "restart:request", "Bun-Update eingespielt"], { timeoutMs: 30_000 });
  }
  const text = notificationText(state, new Date().getDay());
  if (text && !argv.includes("--no-notify")) {
    const r = await run(["bun", "run", "notify", "--source", "software-update", "--plain", "--text", text], { timeoutMs: 60_000 });
    console.log(r.code === 0 ? "Meldung gesendet" : `Meldung nicht gesendet: ${failReason(r)}`);
  }
  try {
    await atomicWriteFile(UPDATE_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[updates] Ergebnis nicht gespeichert: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
