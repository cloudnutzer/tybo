/**
 * Attrappe der Sprachschicht für /sprachagent (Issue #492): kein Anbieteraufruf,
 * jede Methode zeichnet auf und lässt sich steuern. Rezepte und Zustand liegen in
 * einem eigenen Ordner je Test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Choice, ChoiceConversation } from "../src/lib/choices";
import type { RemoveResult, RunResult, TestRunResult, VoiceLayer, VoiceLayerState } from "../src/lib/voice-agents/layer";
import { createVoiceAgentManager, type VoiceAgentManagerDeps } from "../src/lib/voice-agents/manage";
import { updateState } from "../src/lib/voice-agents/state";
import { baseRecipe } from "./voice-agents-elevenlabs-fixture";

export class FakeLayer implements VoiceLayer {
  calls: { method: string; arg?: unknown }[] = [];
  runResult: RunResult = { status: "gestartet", runId: "lauf-1" };
  /** Ergebnis von testResult; eine Funktion darf warten oder werfen */
  result: TestRunResult | (() => Promise<TestRunResult>) = { status: "fertig", gesamt: "bestanden", tests: [] };
  /** Ergebnis von remove; ohne Angabe räumt die Attrappe den Zustand wie die echte Schicht */
  removeResult: ((state: VoiceLayerState) => Promise<RemoveResult>) | null = null;
  constructor(private readonly paths: { configDir: string; dataDir: string }) {}

  async deploy(): Promise<never> {
    throw new Error("nicht erwartet");
  }
  async syncTests(): Promise<never> {
    throw new Error("nicht erwartet");
  }
  async reachable(): Promise<never> {
    throw new Error("nicht erwartet");
  }
  async compareStand(): Promise<never> {
    throw new Error("nicht erwartet");
  }
  async remove(state: VoiceLayerState): Promise<RemoveResult> {
    this.calls.push({ method: "remove", arg: state.kennung });
    if (this.removeResult) return this.removeResult(state);
    const next = await updateState(state.kennung!, { agentId: undefined, tests: {}, letzterHash: undefined }, this.paths);
    return { status: "ok", state: next as VoiceLayerState };
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

export interface ManageHarness {
  paths: { configDir: string; dataDir: string };
  layer: FakeLayer;
  notes: { conversation: ChoiceConversation; text: string }[];
  sent: Choice[];
  logs: string[];
  manager: ReturnType<typeof createVoiceAgentManager>;
}

/** Feste Uhrzeit der Tests; setSystemTime(new Date(FIXED_NOW)) gilt für Manager und Register */
export const FIXED_NOW = Date.parse("2026-11-07T10:00:00Z");

const roots: string[] = [];

/** Ordner aller Harnesse entfernen (afterAll) */
export function removeHarnessDirs(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function manageHarness(options: { withLayer?: boolean; deps?: Partial<VoiceAgentManagerDeps>; sendFails?: boolean } = {}): ManageHarness {
  const root = mkdtempSync(join(tmpdir(), "sprachagent-"));
  roots.push(root);
  const paths = { configDir: join(root, "config", "voice-agents"), dataDir: join(root, "data", "voice-agents") };
  const layer = new FakeLayer(paths);
  const notes: ManageHarness["notes"] = [];
  const sent: Choice[] = [];
  const logs: string[] = [];
  const manager = createVoiceAgentManager({
    layer: () => (options.withLayer === false ? null : layer),
    paths,
    sendChoice: async choice => {
      sent.push(choice);
      return { sent: !options.sendFails };
    },
    notify: async (conversation, text) => void notes.push({ conversation, text }),
    // Dieselbe Uhr wie das Rückfragen-Register (Date.now): Tests stellen sie mit setSystemTime
    now: () => Date.now(),
    log: line => void logs.push(line),
    ...options.deps,
  });
  return { paths, layer, notes, sent, logs, manager };
}

/** Rezept als Datei, wie saveRecipe es ablegt (ohne Version) */
export function writeRecipe(h: Pick<ManageHarness, "paths">, kennung: string, change: (raw: any) => void = () => {}): any {
  const raw = baseRecipe();
  raw.kennung = kennung;
  raw.name = kennung.charAt(0).toUpperCase() + kennung.slice(1);
  change(raw);
  mkdirSync(h.paths.configDir, { recursive: true });
  writeFileSync(join(h.paths.configDir, `${kennung}.json`), JSON.stringify(raw, null, 2) + "\n");
  return raw;
}

/** Zustand wie nach einem Abgleich: Agent und zwei Tests beim Anbieter */
export async function deployed(h: Pick<ManageHarness, "paths">, kennung: string): Promise<void> {
  await updateState(kennung, { kennung, anbieter: "elevenlabs", agentId: `agent-${kennung}`, tests: { Erster: { id: "t1", hash: "h1" }, Zweiter: { id: "t2", hash: "h2" } } } as any, h.paths);
}
