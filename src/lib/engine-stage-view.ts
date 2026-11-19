/** Gemeinsame, reine Stufenzustände für Vorschau und serverseitige Modellanzeige. */
import { pickStage, stageBlock, stageId, type Stage, type StageId, type SwitchBlock, type SwitchReady, type SwitchState } from "./engine-switch";

export interface StageDetails {
  cause?: SwitchBlock["cause"];
  blockedUntil?: string;
  window?: SwitchBlock["window"];
  percent?: number;
  resetKnown?: boolean;
  message?: string;
}

export type StageStatus = StageDetails & (
  | { state: "answering" | "free" | "not_ready" }
  | { state: "blocked"; cause: SwitchBlock["cause"]; blockedUntil: string; resetKnown: boolean }
);

export type StageView = StageStatus & {
  id: StageId;
  engine: Stage["engine"];
  model?: string;
}

export function engineStageViews(order: readonly Stage[], modelOf: (stage: Stage) => string | undefined,
  state: SwitchState, ready: SwitchReady, now: number): { stages: StageView[]; picked: ReturnType<typeof pickStage> } {
  const picked = pickStage(order, modelOf, state, ready, now);
  const stages = order.map((stage, index): StageView => {
    const model = stage.model ?? modelOf(stage);
    const base = { id: stageId(stage), engine: stage.engine, ...(model ? { model } : {}) };
    const status = ready[stage.engine];
    if (!status.ready) return { ...base, state: "not_ready", ...(status.message ? { message: status.message } : {}) };
    const block = stageBlock(stage, model, state, now);
    if (block) return { ...base, state: "blocked", cause: block.cause, blockedUntil: block.until,
      resetKnown: block.resetKnown, ...(block.window ? { window: block.window } : {}),
      ...(block.percent !== undefined ? { percent: block.percent } : {}) };
    return { ...base, state: picked.kind === "stage" && picked.index === index ? "answering" : "free" };
  });
  return { stages, picked };
}
