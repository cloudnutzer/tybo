/**
 * Attrappen für Entwürfe von Sprachagenten (Issue #493): Jobs ohne echten
 * Prozess (der Test schreibt die Ausgabe selbst in den Arbeitsordner und setzt
 * das Ende), die Sprachschicht ohne Anbieteraufruf und ein eigener
 * Projektordner je Test.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Choice, ChoiceConversation } from "../src/lib/choices";
import type { JobOutcome, JobStatus } from "../src/lib/jobs/store";
import { createDraftService, type DraftDeps, type DraftJobs, type DraftRecord } from "../src/lib/voice-agents/drafts";
import type { DeployOptions, DeployResult, ReachableResult, RunResult, StandResult, SyncResult, TestRunResult, VoiceLayer, VoiceLayerState } from "../src/lib/voice-agents/layer";
import type { Recipe } from "../src/lib/voice-agents/recipe";
import { updateState } from "../src/lib/voice-agents/state";
import type { VoiceSuggestion } from "../src/lib/voice-agents/voice-catalog";
import { baseRecipe } from "./voice-agents-elevenlabs-fixture";

export const DM: ChoiceConversation = { type: "telegram", chatId: "123456" };

export class FakeJobs implements DraftJobs {
  starts: { id: string; title: string; brief: string; target: unknown; allowedTools: string[]; deniedTools: string[]; workDir: string }[] = [];
  statuses = new Map<string, Partial<JobStatus>>();
  failStart: string | null = null;
  /** Wirft nach dem Anlegen des Jobs, wie ein Fehler zwischen Start und Eintrag */
  throwAfterStart = false;
  private n = 0;

  async start(input: Parameters<DraftJobs["start"]>[0]) {
    if (this.failStart) return { ok: false as const, error: this.failStart };
    const id = this.register(input);
    if (this.throwAfterStart) throw new Error("Absturz nach dem Start");
    return { ok: true as const, id };
  }
  /** Job anlegen wie startJob, ohne Rückgabe an den Dienst */
  register(input: Parameters<DraftJobs["start"]>[0]): string {
    const id = `20261107-1000${String(++this.n).padStart(2, "0")}-abcdef`;
    this.starts.push({ id, ...input });
    this.statuses.set(id, { id, title: input.title, phase: "running" });
    return id;
  }
  async status(id: string): Promise<JobStatus | null> {
    return (this.statuses.get(id) as JobStatus) ?? null;
  }
  async find(title: string): Promise<string | null> {
    return [...this.statuses.values()].reverse().find((s) => s.title === title)?.id ?? null;
  }
  /** Job beenden wie der Wächter */
  finish(id: string, outcome: JobOutcome = "success"): void {
    this.statuses.set(id, { ...this.statuses.get(id), id, phase: "ended", outcome });
  }
  last() {
    return this.starts.at(-1)!;
  }
}

export class FakeLayer implements VoiceLayer {
  calls: { method: string; arg?: unknown }[] = [];
  deployResult: ((recipe: Recipe) => DeployResult) | null = null;
  syncResult: SyncResult | null = null;
  /** Test-IDs beim Anbieter nach syncTests; runTests fordert genau diese an */
  testIds: string[] = ["t1"];
  runResult: RunResult = { status: "gestartet", runId: "lauf-1" };
  result: TestRunResult | (() => Promise<TestRunResult>) = { status: "fertig", gesamt: "bestanden", tests: [{ testId: "t1", name: "Notfall", status: "bestanden" }] };
  /** Antwort auf reachable: Hängt beim Anbieter eine Nummer am Agenten? */
  reachableResult: ReachableResult = { status: "ok", erreichbar: false };
  /** Antwort auf compareStand: Was weicht beim Anbieter vom getesteten Stand ab? */
  standResult: StandResult = { status: "ok", felder: [] };
  prompts: string[] = [];
  deployOptions: (DeployOptions | undefined)[] = [];
  constructor(private readonly paths: { configDir: string; dataDir: string }) {}

  async deploy(recipe: Recipe, prompt: string, options?: DeployOptions): Promise<DeployResult> {
    this.calls.push({ method: "deploy", arg: recipe.kennung });
    this.prompts.push(prompt);
    this.deployOptions.push(options);
    if (this.deployResult) return this.deployResult(recipe);
    const state = (await updateState(recipe.kennung, { kennung: recipe.kennung, anbieter: "elevenlabs", agentId: `agent-${recipe.kennung}`, anbieterStand: { ersterSatz: "stand-1" } } as any, this.paths)) as VoiceLayerState;
    return { status: "angelegt", state, hinweise: [] };
  }
  async compareStand(state: VoiceLayerState, stand: Record<string, string>): Promise<StandResult> {
    this.calls.push({ method: "compareStand", arg: { agentId: state.agentId, stand } });
    return this.standResult;
  }
  async syncTests(recipe: Recipe, state: VoiceLayerState): Promise<SyncResult> {
    this.calls.push({ method: "syncTests", arg: recipe.kennung });
    const tests = Object.fromEntries(this.testIds.map((id, i) => [`Test ${i + 1}`, { id, hash: `hash-${id}` }]));
    return this.syncResult ?? { status: "ok", state: { ...state, tests }, angelegt: ["Notfall"], geaendert: [], entfernt: [], unveraendert: [] };
  }
  async remove(): Promise<never> {
    throw new Error("nicht erwartet");
  }
  async reachable(state: VoiceLayerState): Promise<ReachableResult> {
    this.calls.push({ method: "reachable", arg: state.agentId });
    return this.reachableResult;
  }
  async runTests(state: VoiceLayerState): Promise<RunResult> {
    this.calls.push({ method: "runTests", arg: state.agentId });
    return this.runResult;
  }
  async testResult(runId: string): Promise<TestRunResult> {
    this.calls.push({ method: "testResult", arg: runId });
    return typeof this.result === "function" ? this.result() : this.result;
  }
}

export interface DraftHarness {
  root: string;
  paths: { configDir: string; dataDir: string };
  jobs: FakeJobs;
  layer: FakeLayer;
  notes: { conversation: ChoiceConversation; text: string }[];
  sent: Choice[];
  logs: string[];
  voices: VoiceSuggestion[];
  /** Standardstimme der Einstellungen; Tests dürfen sie zwischendurch ändern */
  standard: string | null;
  service: ReturnType<typeof createDraftService>;
  /** Neuer Dienst auf demselben Ordner, wie nach einem Neustart */
  restart(): ReturnType<typeof createDraftService>;
}

const roots: string[] = [];
export function removeDraftDirs(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export const REPO = join(import.meta.dir, "..");

export function draftHarness(options: { withLayer?: boolean; deps?: Partial<DraftDeps>; standardVoice?: string | null } = {}): DraftHarness {
  const root = mkdtempSync(join(tmpdir(), "sprachagent-entwurf-"));
  roots.push(root);
  const paths = { configDir: join(root, "config", "voice-agents"), dataDir: join(root, "data", "voice-agents") };
  const h = { root, paths, jobs: new FakeJobs(), layer: new FakeLayer(paths), notes: [], sent: [], logs: [], voices: [] } as unknown as DraftHarness;
  const standard = options.standardVoice === undefined ? "standard-stimme" : options.standardVoice;
  h.standard = standard;
  let n = 0;
  const make = () =>
    createDraftService({
      root,
      paths,
      jobs: h.jobs,
      layer: () => (options.withLayer === false ? null : h.layer),
      suggestVoices: async () => h.voices,
      voiceSources: () => (h.standard ? { setting: h.standard } : {}),
      examplesDir: join(REPO, "config", "voice-agents.example"),
      schemaFile: join(REPO, "src", "lib", "voice-agents", "recipe.ts"),
      sendChoice: async (choice) => {
        h.sent.push(choice);
        return { sent: true };
      },
      notify: async (conversation, text) => void h.notes.push({ conversation, text }),
      now: () => Date.now(),
      log: (line) => void h.logs.push(line),
      newId: () => `20261107-0900${String(++n).padStart(2, "0")}-a1b2c3`,
      ...options.deps,
    });
  h.service = make();
  h.restart = () => (h.service = make());
  return h;
}

/** Arbeitsordner des Jobs: entwuerfe/.arbeit/<entwurf> */
export function draftDir(h: DraftHarness, id: string): string {
  return join(h.paths.dataDir, "entwuerfe", ".arbeit", id);
}

/** Steuerdaten: entwuerfe/.steuerung/<entwurf>/entwurf.json */
export function recordPath(h: DraftHarness, id: string): string {
  return join(h.paths.dataDir, "entwuerfe", ".steuerung", id, "entwurf.json");
}

/** Ablage des geprüften Entwurfs: entwuerfe/<kennung> */
export function ablageDir(h: DraftHarness, kennung: string): string {
  return join(h.paths.dataDir, "entwuerfe", kennung);
}

export function readRecord(h: DraftHarness, id: string): DraftRecord {
  return JSON.parse(readFileSync(recordPath(h, id), "utf8"));
}

/** Steuerdaten von Hand setzen, etwa den Zustand nach einem Absturz */
export function patchRecord(h: DraftHarness, id: string, change: (record: any) => void): void {
  const record = readRecord(h, id) as any;
  change(record);
  writeFileSync(recordPath(h, id), JSON.stringify(record, null, 2));
}

/** Rezept, wie der Job es schreiben soll: ohne Stimmen-Kennung */
export function draftRecipe(kennung = "kochhilfe", change: (raw: any) => void = () => {}): any {
  const raw = baseRecipe();
  raw.kennung = kennung;
  raw.name = "Kochhilfe";
  raw.stimme = { art: "bibliothek", modell: "eleven_flash_v2_5", tempo: 1 };
  raw.gedaechtnis = "keins";
  change(raw);
  return raw;
}

export function expertRecipe(kennung = "segel-trainer", change: (raw: any) => void = () => {}): any {
  const raw = JSON.parse(readFileSync(join(import.meta.dir, "..", "config", "voice-agents.example", "verhandlungstrainer.json"), "utf8"));
  raw.kennung = kennung;
  raw.name = "Segel-Trainer";
  raw.wissen = { datei: `data/voice-agents/${kennung}/wissen.md` };
  change(raw);
  return raw;
}

export const GOOD_KNOWLEDGE = "# Segeln\n\nStand: 2026-11-07\n\nWind kommt von vorn.\n\n## Quellen\n\n- Seeschifffahrtsstraßen-Ordnung, https://www.gesetze-im-internet.de/seeschstro_1971/, abgerufen 2026-11-07\n";

/** Was der Job in den Entwurfsordner schreibt */
export function writeOutput(h: DraftHarness, id: string, files: { recipe?: unknown; knowledge?: string; voice?: string }): void {
  const dir = draftDir(h, id);
  mkdirSync(dir, { recursive: true });
  if (files.recipe !== undefined) writeFileSync(join(dir, "rezept.json"), typeof files.recipe === "string" ? files.recipe : JSON.stringify(files.recipe, null, 2));
  if (files.knowledge !== undefined) writeFileSync(join(dir, "wissen.md"), files.knowledge);
  if (files.voice !== undefined) writeFileSync(join(dir, "stimme.txt"), files.voice);
}

/** Aktives Rezept, wie saveRecipe es ablegt (ohne Version) */
export function writeActive(h: DraftHarness, raw: any): void {
  mkdirSync(h.paths.configDir, { recursive: true });
  writeFileSync(join(h.paths.configDir, `${raw.kennung}.json`), JSON.stringify(raw, null, 2) + "\n");
}
