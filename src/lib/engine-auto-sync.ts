/** Ein-/Ausgabe um die reine Wechselregel, gemeinsam für WebUI und spätere Chat-Turns. */
import { syncAuto, type SwitchAuto, type SwitchState, type SwitchUsage } from "./engine-switch";
import { readSwitchState, updateSwitchState } from "./engine-switch-state";
import { readUsage } from "./engines/usage";
import { engineAuto, getSettings, type Settings } from "./settings";

export interface EngineAutoDeps {
  readSettings(): Settings;
  readState(): SwitchState;
  updateState: typeof updateSwitchState;
  readUsage(now: number): Promise<SwitchUsage>;
  now(): number;
}

export const engineAutoDeps: EngineAutoDeps = {
  readSettings: getSettings, readState: readSwitchState, updateState: updateSwitchState,
  readUsage: now => readUsage(now, { quietMissing: true }), now: Date.now,
};

function sameAuto(left: SwitchAuto | undefined, right: SwitchAuto): boolean {
  return left?.enabled === right.enabled && left.threshold === right.threshold && left.returnBelow === right.returnBelow;
}

/** Erstlauf merkt auto einmal; danach ohne wirksame Änderung kein Schreibversuch. */
export async function syncEngineAuto(deps: Partial<EngineAutoDeps> = {}): Promise<SwitchState> {
  const d = { ...engineAutoDeps, ...deps };
  const auto = engineAuto(d.readSettings());
  const state = d.readState();
  if (sameAuto(state.auto, auto)) return state;
  const now = d.now();
  const usage = await d.readUsage(now);
  // Die Mutation bleibt synchron und rein, auch wenn die Ablage sie wiederholt.
  return (await d.updateState(current => sameAuto(current.auto, auto) ? current : syncAuto(current, auto, usage, now))).state;
}
