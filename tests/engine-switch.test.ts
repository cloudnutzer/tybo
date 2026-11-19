import { describe, expect, test } from "bun:test";
import { AUTO_STAGE_ENGINES, SELECTABLE_ENGINES } from "../src/lib/settings";
import {
  applyFailure, applyMeasurement, applySuccess, claudeBlockedFor, expireBlocks, limitEvidence, modelFamily,
  pickStage, recheck, stageBlock, stageId, syncAuto, turnOrder, windowCounts,
  type BlockScope, type Stage, type SwitchAuto, type SwitchBlock, type SwitchReady,
  type SwitchState, type SwitchUsage,
} from "../src/lib/engine-switch";
import type { EngineId, EngineRateLimit } from "../src/lib/engines/types";
import type { UsageReading, UsageWindow } from "../src/lib/engines/usage";
import { LIMIT_AWARE_PURPOSES } from "../src/lib/aux-targets";

const claude: Stage = { engine: "claude" };
const fable: Stage = { engine: "claude", model: "claude-fable-5-2", effort: "high" };
const opus: Stage = { engine: "claude", model: "claude-opus-5-5" };
const codex: Stage = { engine: "codex" };
const opencode: Stage = { engine: "opencode" };
const api: Stage = { engine: "api" };

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();
const auto: SwitchAuto = { enabled: true, threshold: 95, returnBelow: 80 };
const ready: SwitchReady = {
  claude: { ready: true }, codex: { ready: true }, opencode: { ready: true }, api: { ready: true },
};
const modelOf = (stage: Stage) => stage.model ?? (stage.engine === "claude" ? "fable" : undefined);
const state = (changes: Partial<SwitchState> = {}): SwitchState => ({ version: 1, blocks: [], counters: [], ...changes });
const known = (percent: number, changes: Partial<UsageWindow> = {}): UsageReading => ({
  state: "known", id: "weekly_all", percent, measuredAt: at(0), resetsAt: at(1440), source: "extern", ...changes,
});
const expired: UsageReading = { state: "expired", id: "weekly_all", measuredAt: at(-10), resetsAt: at(0), source: "extern" };
const usageFor = (readings: readonly UsageReading[] = [], engine: EngineId = "claude"): SwitchUsage => ({
  claude: [], codex: [], opencode: [], api: [], [engine]: readings,
});
function block(
  cause: SwitchBlock["cause"], scope: BlockScope = { window: "weekly_all" },
  changes: Partial<Pick<SwitchBlock, "engine" | "since" | "until" | "resetKnown" | "percent">> = {},
): SwitchBlock {
  return { engine: "claude", cause, ...scope, since: at(-10), until: at(60), resetKnown: false, ...changes };
}

function failed(previous = state(), stage = fable, now = NOW): SwitchState {
  return applyFailure(previous, { stage, kind: "limit" }, now);
}

describe("Limit-Sperren für Nebenaufgaben", () => {
  test("M14 gilt genau für Richter, Fäden, Review und Destillat", () => {
    expect(LIMIT_AWARE_PURPOSES).toEqual(["judge", "threads", "review", "distill"]);
  });

  test.each(["threshold", "limit"] as const)("%s berücksichtigt alle Reichweiten von stageBlock", cause => {
    const scopes: BlockScope[] = [
      { window: "weekly_all" }, { window: "session" }, { window: "weekly_scoped:opus" },
      { window: "window_300" }, { family: "opus" }, { model: opus.model! }, {},
    ];
    for (const scope of scopes) {
      expect(claudeBlockedFor(state({ blocks: [block(cause, scope)] }), opus.model!, NOW)).toBe(at(60));
    }
  });

  test("fremde Familie, fremdes Modell und anderer Motor sperren den Richter nicht", () => {
    const blocks = [
      block("limit", { window: "weekly_scoped:fable" }), block("limit", { family: "fable" }),
      block("limit", { model: "anderes-modell" }), block("limit", {}, { engine: "codex" }),
    ];
    expect(claudeBlockedFor(state({ blocks }), opus.model!, NOW)).toBeUndefined();
  });

  test("outage zählt auch mit späterem Ende als eine gültige Limit-Sperre nicht", () => {
    const outage = block("outage", {}, { until: at(120) });
    expect(claudeBlockedFor(state({ blocks: [outage] }), opus.model!, NOW)).toBeUndefined();
    expect(claudeBlockedFor(state({ blocks: [outage, block("threshold")] }), opus.model!, NOW)).toBe(at(60));
  });

  test("von mehreren Limits zählt das späteste Ende unabhängig von der Reihenfolge", () => {
    const blocks = [block("threshold"), block("limit", { family: "opus" }, { until: at(120) })];
    expect(claudeBlockedFor(state({ blocks }), opus.model!, NOW)).toBe(at(120));
    expect(claudeBlockedFor(state({ blocks: [...blocks].reverse() }), opus.model!, NOW)).toBe(at(120));
  });

  test("abgelaufene Sperren einschließlich Ende genau jetzt und leerer Zustand sind frei", () => {
    expect(claudeBlockedFor(state(), opus.model!, NOW)).toBeUndefined();
    const blocks = [block("limit", {}, { until: at(-1) }), block("threshold", {}, { until: at(0) })];
    expect(claudeBlockedFor(state({ blocks }), opus.model!, NOW)).toBeUndefined();
  });

  test("nur übergebener Zustand und Zeit entscheiden; Eingabe bleibt unverändert", () => {
    const blocked = state({ blocks: [block("limit")] });
    const snapshot = structuredClone(blocked);
    expect(claudeBlockedFor(blocked, opus.model!, NOW)).toBe(at(60));
    expect(claudeBlockedFor(state(), opus.model!, NOW)).toBeUndefined();
    expect(claudeBlockedFor(blocked, opus.model!, NOW + 60 * MINUTE)).toBeUndefined();
    expect(blocked).toEqual(snapshot);
  });
});

describe("Stufen und Reihenfolge", () => {
  test("AUTO_STAGE_ENGINES enthält nur Claude, Codex und OpenCode; api bleibt von Hand wählbar", () => {
    expect(AUTO_STAGE_ENGINES).toEqual(["claude", "codex", "opencode"]);
    expect(SELECTABLE_ENGINES).toContain("api");
  });

  test("stageId unterscheidet nur bei Claude das Modell, nie den Effort", () => {
    expect([claude, fable, opus, codex, opencode, api].map(stageId))
      .toEqual(["claude", "claude:claude-fable-5-2", "claude:claude-opus-5-5", "codex", "opencode", "api"]);
    expect(stageId({ ...fable, effort: "low" })).toBe(stageId(fable));
    expect(stageId({ ...codex, model: "gpt-test" })).toBe("codex");
  });

  test("Wunsch, Standard, Ersatzstufen ohne Doppelte; erster Effort bleibt", () => {
    expect(turnOrder(codex, claude, [fable, codex, { ...fable, effort: "low" }, opencode, claude]))
      .toEqual([codex, claude, fable, opencode]);
  });

  test("ohne Gesprächswunsch beginnt die Reihenfolge beim Standard", () => {
    expect(turnOrder(undefined, claude, [claude, codex])).toEqual([claude, codex]);
  });

  test("Claude-Ersatz ohne eigenes Modell entfällt hinter einer früheren Claude-Stufe", () => {
    expect(turnOrder(fable, codex, [claude, opus])).toEqual([fable, codex, opus]);
  });

  test("Claude ohne Modell und explizites Opus bleiben getrennte Stufen", () => {
    expect(turnOrder(claude, claude, [opus])).toEqual([claude, opus]);
  });

  test("api als Wunsch bleibt an erster Stelle", () => {
    expect(turnOrder(api, claude, [api, codex])).toEqual([api, claude, codex]);
  });

  test("api als Standard ohne anderen Wunsch bleibt an erster Stelle", () => {
    expect(turnOrder(undefined, api, [codex])).toEqual([api, codex]);
  });

  test("api als Standard hinter einem anderen Wunsch fällt weg", () => {
    expect(turnOrder(codex, api, [opencode])).toEqual([codex, opencode]);
  });

  test("api als Ersatzeintrag fällt auch mit eigenem Modell weg", () => {
    expect(turnOrder(claude, claude, [api, { ...api, model: fable.model }, codex])).toEqual([claude, codex]);
  });

  test("jede Kombination aus Wunsch, Standard und Ersatzmotoren hält api aus den Ersatzstufen heraus", () => {
    const stages = SELECTABLE_ENGINES.map(engine => ({ engine }));
    for (const wish of [undefined, ...stages]) {
      for (const standard of stages) {
        const order = turnOrder(wish, standard, [...stages, fable, opus, ...stages]);
        expect(order[0]).toEqual(wish ?? standard);
        expect(order.slice(1).some(stage => stage.engine === "api")).toBe(false);
        expect(new Set(order.map(stageId)).size).toBe(order.length);
      }
    }
  });
});

describe("Modellfamilien und Fenster", () => {
  test.each([
    ["claude-fable-5-2", "fable"], ["fable", "fable"], ["fable[1m]", "fable"],
    ["CLAUDE-OPUS-5-5[1m]", "opus"], ["claude-opus-5-5-20261101", "opus"],
    ["opus", "opus"], ["sonnet[1m]", "sonnet"], ["haiku", "haiku"],
    ["claude-sonnet-5-5", "sonnet"], ["claude-3-5-haiku-20241022", "haiku"],
    ["unbekannt", undefined], ["fablex", undefined], ["gpt-opus", undefined],
  ])("Modellfamilie von %s", (model, expected) => {
    expect(modelFamily(model)).toBe(expected);
  });

  test("fehlender Modellname hat keine Familie", () => {
    expect(modelFamily(undefined)).toBeUndefined();
  });

  test("weekly_all, session und window_<Minuten> zählen für jede Claude-Stufe", () => {
    for (const stage of [claude, fable, opus]) {
      for (const id of ["weekly_all", "session", "window_300"] as const) {
        expect(windowCounts(stage, undefined, id)).toBe(true);
      }
    }
  });

  test("weekly_scoped:fable 5.2 zählt für Fable, nicht für Opus", () => {
    expect(windowCounts(fable, undefined, "weekly_scoped:fable 5.2")).toBe(true);
    expect(windowCounts(opus, undefined, "weekly_scoped:fable 5.2")).toBe(false);
    expect(windowCounts(claude, "fable[1m]", "weekly_scoped:fable")).toBe(true);
  });

  test("Familienvergleich trennt auch Unterstriche und erkennt keine Teilwörter", () => {
    for (const id of ["weekly_scoped:fable_5.2", "weekly_scoped:all-fable", "weekly_scoped:fable.opus"] as const) {
      expect(windowCounts(fable, undefined, id)).toBe(true);
    }
    for (const id of ["weekly_scoped:unfable", "weekly_scoped:fable2"] as const) {
      expect(windowCounts(fable, undefined, id)).toBe(false);
    }
    expect(windowCounts(claude, "unbekannt", "weekly_scoped:fable")).toBe(false);
  });

  test("eigenes Stufenmodell geht vor dem aufgelösten Standardmodell", () => {
    expect(windowCounts(opus, "fable", "weekly_scoped:opus")).toBe(true);
    expect(windowCounts(opus, "fable", "weekly_scoped:fable")).toBe(false);
  });

  test("Codex zählt jedes gemeldete Fenster, OpenCode und api zählen keines", () => {
    for (const id of ["weekly_all", "session", "weekly_scoped:fable", "window_42"] as const) {
      expect(windowCounts(codex, undefined, id)).toBe(true);
      expect(windowCounts(opencode, "fable", id)).toBe(false);
      expect(windowCounts(api, "fable", id)).toBe(false);
    }
  });
});

describe("Testtabelle: Messungen", () => {
  test("unter der Schwelle: frei", () => {
    const next = applyMeasurement(state(), usageFor([known(94)]), NOW, auto);
    expect(next.blocks).toEqual([]);
    expect(stageBlock(fable, undefined, next, NOW)).toBeUndefined();
  });

  test("genau auf der Schwelle: gesperrt bis zur Reset-Zeit", () => {
    const next = applyMeasurement(state(), usageFor([known(95)]), NOW, auto);
    expect(next.blocks).toEqual([{
      engine: "claude", cause: "threshold", window: "weekly_all", since: at(0),
      until: at(1440), resetKnown: true, percent: 95,
    }]);
    expect(stageBlock(fable, undefined, next, NOW)).toEqual(next.blocks[0]);
  });

  test("Messung ohne Reset-Zeit: 60 Minuten ab Messzeit", () => {
    const next = applyMeasurement(state(), usageFor([known(96, { resetsAt: undefined, measuredAt: at(-5) })]), NOW, auto);
    expect(next.blocks[0]).toMatchObject({ until: at(55), resetKnown: false, since: at(0) });
  });

  test("Teil-Limit Fable voll: Fable gesperrt, Claude Code mit Opus frei", () => {
    const next = applyMeasurement(state(), usageFor([known(100, { id: "weekly_scoped:fable 5.2" })]), NOW, auto);
    expect(stageBlock(fable, undefined, next, NOW)?.window).toBe("weekly_scoped:fable 5.2");
    expect(stageBlock(opus, undefined, next, NOW)).toBeUndefined();
  });

  test("Woche voll: alle Claude-Stufen gesperrt, Codex frei", () => {
    const next = applyMeasurement(state(), usageFor([known(100)]), NOW, auto);
    for (const stage of [claude, fable, opus]) expect(stageBlock(stage, modelOf(stage), next, NOW)?.window).toBe("weekly_all");
    expect(stageBlock(codex, undefined, next, NOW)).toBeUndefined();
  });

  test("Reset-Zeit vorbei: genau ab dem Reset wieder frei", () => {
    const next = applyMeasurement(state(), usageFor([known(95, { resetsAt: at(5) })]), NOW, auto);
    expect(stageBlock(fable, undefined, next, NOW + 5 * MINUTE - 1)).toBeDefined();
    expect(stageBlock(fable, undefined, next, NOW + 5 * MINUTE)).toBeUndefined();
    expect(expireBlocks(next, NOW + 5 * MINUTE).blocks).toEqual([]);
  });

  test("Schwelle 95, Rückkehr 80: neue Messung 85 Prozent bleibt gesperrt", () => {
    const previous = state({ blocks: [block("threshold")] });
    expect(applyMeasurement(previous, usageFor([known(85)]), NOW, auto).blocks).toEqual(previous.blocks);
  });

  test("Schwelle 95, Rückkehr 80: neue Messung 79 Prozent wird frei", () => {
    expect(applyMeasurement(state({ blocks: [block("threshold")] }), usageFor([known(79)]), NOW, auto).blocks).toEqual([]);
  });

  test("Messung älter als die Sperre hebt nichts auf", () => {
    const previous = state({ blocks: [block("threshold")] });
    expect(applyMeasurement(previous, usageFor([known(70, { measuredAt: at(-11) })]), NOW, auto).blocks).toEqual(previous.blocks);
  });

  test("Messung genau bei since hebt nichts auf; genau returnBelow bleibt gesperrt", () => {
    const previous = state({ blocks: [block("threshold")] });
    expect(applyMeasurement(previous, usageFor([known(70, { measuredAt: at(-10) })]), NOW, auto).blocks).toEqual(previous.blocks);
    expect(applyMeasurement(previous, usageFor([known(80)]), NOW, auto).blocks).toEqual(previous.blocks);
  });

  test("Messung fehlt: keine neue Sperre", () => {
    expect(applyMeasurement(state(), usageFor(), NOW, auto).blocks).toEqual([]);
  });

  test("Fenster expired: keine neue Sperre", () => {
    expect(applyMeasurement(state(), usageFor([expired]), NOW, auto).blocks).toEqual([]);
  });

  test("fehlende und expired Messungen heben vorhandene Fenstersperren nicht auf", () => {
    const previous = state({ blocks: [block("threshold"), block("limit")] });
    for (const usage of [usageFor(), usageFor([expired])]) {
      expect(applyMeasurement(previous, usage, NOW, auto).blocks).toEqual(previous.blocks);
    }
  });

  test("known mit inzwischen abgelaufener Reset-Zeit gilt wie expired", () => {
    for (const percent of [70, 96]) {
      const usage = usageFor([known(percent, { resetsAt: at(0) })]);
      expect(applyMeasurement(state(), usage, NOW, auto).blocks).toEqual([]);
      const previous = state({ blocks: [block("limit")] });
      expect(applyMeasurement(previous, usage, NOW, auto).blocks).toEqual(previous.blocks);
    }
  });

  test("96 Prozent ohne Reset vor zwei Stunden: keine bereits abgelaufene Sperre", () => {
    const usage = usageFor([known(96, { measuredAt: at(-120), resetsAt: undefined })]);
    const next = applyMeasurement(state(), usage, NOW, auto);
    expect(next.blocks).toEqual([]);
    expect(applyMeasurement(next, usage, NOW + MINUTE, auto).blocks).toEqual([]);
  });

  test("Pause ohne Reset endet genau bei now: keine neue Sperre", () => {
    expect(applyMeasurement(state(), usageFor([known(96, { measuredAt: at(-60), resetsAt: undefined })]), NOW, auto).blocks).toEqual([]);
  });

  test("Messung vor released sperrt nicht; bei released darf sie wieder sperren", () => {
    const previous = state({ released: { claude: at(0) } });
    expect(applyMeasurement(previous, usageFor([known(96, { measuredAt: at(-1) })]), NOW, auto).blocks).toEqual([]);
    expect(applyMeasurement(previous, usageFor([known(96)]), NOW, auto).blocks).toHaveLength(1);
  });

  test("bestehende threshold-Sperre führt Prozent und Ende nach, behält since und verdoppelt sich nicht", () => {
    const previous = state({ blocks: [block("threshold", { window: "weekly_all" }, { resetKnown: true })] });
    const next = applyMeasurement(previous, usageFor([known(99, { resetsAt: at(120) })]), NOW, auto);
    expect(next.blocks).toEqual([{ ...previous.blocks[0], percent: 99, until: at(120) }]);
    expect(applyMeasurement(next, usageFor([known(99, { resetsAt: at(120) })]), NOW, auto)).toEqual(next);
  });

  test("nachgeführte Endzeit kennzeichnet belegten Reset oder Pause zutreffend", () => {
    const previous = state({ blocks: [block("threshold")] });
    const withReset = applyMeasurement(previous, usageFor([known(96)]), NOW, auto);
    expect(withReset.blocks[0].resetKnown).toBe(true);
    const withoutReset = applyMeasurement(withReset, usageFor([known(97, { resetsAt: undefined })]), NOW, auto);
    expect(withoutReset.blocks[0]).toMatchObject({ resetKnown: false, until: at(60), since: at(-10) });
  });

  test("je Fenster zählt die jüngste Messung; Motoren bleiben getrennt", () => {
    const usage: SwitchUsage = { ...usageFor([known(70), known(96, { measuredAt: at(-5) })]), codex: [known(96)] };
    const next = applyMeasurement(state(), usage, NOW, auto);
    expect(next.blocks).toHaveLength(1);
    expect(next.blocks[0].engine).toBe("codex");
  });

  test("OpenCode und api haben auch bei gelieferten Prozentwerten keine Fenster", () => {
    for (const engine of ["opencode", "api"] as const) {
      expect(applyMeasurement(state(), usageFor([known(100)], engine), NOW, auto).blocks).toEqual([]);
    }
  });
});

describe("Testtabelle: Limit-Belege und Fehlerzähler", () => {
  test("Limit ohne Zuordnung: 60 Minuten Pause für die Familie Fable", () => {
    const next = failed();
    expect(next.blocks).toEqual([block("limit", { family: "fable" }, { since: at(0), until: at(60) })]);
    expect(next.counters).toEqual([{ engine: "claude", kind: "limit", scope: "fable", count: 1, lastAt: at(0) }]);
    expect(stageBlock(opus, undefined, next, NOW)).toBeUndefined();
  });

  test("zweiter Limit-Fehler: 120 Minuten, bestehende Sperre wird ersetzt", () => {
    const next = failed(failed(), fable, NOW + MINUTE);
    expect(next.blocks).toHaveLength(1);
    expect(next.blocks[0]).toMatchObject({ since: at(1), until: at(121) });
    expect(next.counters[0]).toMatchObject({ count: 2, lastAt: at(1) });
  });

  test("Limit-Pausen verdoppeln 60, 120, 240, 360 Minuten, Obergrenze sechs Stunden", () => {
    let next = state();
    for (const minutes of [60, 120, 240, 360, 360]) {
      next = failed(next);
      expect(next.blocks[0].until).toBe(at(minutes));
    }
    expect(next.counters[0].count).toBe(5);
  });

  test("große Fehlerzähler begrenzen den Exponenten vor dem Rechnen", () => {
    for (const kind of ["limit", "outage"] as const) {
      const previous = state({ counters: [{ engine: "claude", kind, scope: kind === "limit" ? "fable" : "claude", count: 1_000_000, lastAt: at(-1) }] });
      const next = applyFailure(previous, { stage: fable, kind }, NOW);
      expect(next.blocks[0].until).toBe(at(kind === "limit" ? 360 : 60));
      expect(next.counters[0].count).toBe(1_000_001);
    }
  });

  test("Zähler überlebt Ablauf und JSON-Neustart: zweiter Fehler ergibt 120 Minuten", () => {
    const expiredState = expireBlocks(failed(), NOW + 60 * MINUTE);
    expect(expiredState.blocks).toEqual([]);
    const restarted: SwitchState = JSON.parse(JSON.stringify(expiredState));
    const next = failed(restarted, fable, NOW + 60 * MINUTE);
    expect(next.blocks[0].until).toBe(at(180));
    expect(next.counters[0].count).toBe(2);
  });

  test("applySuccess derselben Familie setzt Limit-Zähler zurück: nächster Fehler 60 Minuten", () => {
    const previous = failed(failed());
    const success = applySuccess(previous, claude, "fable[1m]");
    expect(success.counters).toEqual([]);
    expect(success.blocks).toEqual(previous.blocks);
    expect(failed(success).blocks[0].until).toBe(at(60));
  });

  test("Erfolg von Claude Code mit Opus lässt den Limit-Zähler für Fable stehen", () => {
    const previous = failed(failed(), opus);
    const success = applySuccess(previous, opus, undefined);
    expect(success.counters).toEqual([{ engine: "claude", kind: "limit", scope: "fable", count: 1, lastAt: at(0) }]);
    expect(failed(success).blocks.find(b => b.family === "fable")?.until).toBe(at(120));
  });

  test("rejected seven_day mit Reset: weekly_all bis Reset, alle Claude-Stufen gesperrt", () => {
    const evidence = limitEvidence({ stage: fable, usage: usageFor([known(48)]), now: NOW,
      rateLimit: { status: "rejected", rateLimitType: "seven_day", resetsAt: at(10080), windows: [] } });
    expect(evidence).toEqual({ window: "weekly_all", resetsAt: at(10080) });
    const next = applyFailure(state(), { stage: fable, kind: "limit", evidence }, NOW);
    expect(next.blocks[0]).toMatchObject({ window: "weekly_all", until: at(10080), resetKnown: true });
    for (const stage of [claude, fable, opus]) expect(stageBlock(stage, modelOf(stage), next, NOW)).toBeDefined();
    expect(next.counters[0].scope).toBe("fable");
  });

  test("Fable ohne rejected, Woche 48 Prozent: keine Zuordnung, Familienpause, Opus frei", () => {
    const evidence = limitEvidence({ stage: fable, usage: usageFor([known(48)]), now: NOW,
      rateLimit: { status: "allowed_warning", rateLimitType: "seven_day", resetsAt: at(10080), windows: [] } });
    expect(evidence).toBeUndefined();
    const next = applyFailure(state(), { stage: fable, kind: "limit", evidence }, NOW);
    expect(next.blocks[0]).toMatchObject({ family: "fable", until: at(60), resetKnown: false });
    expect(stageBlock(opus, undefined, next, NOW)).toBeUndefined();
  });

  test("Woche vor fünf Minuten bei 100 Prozent: weekly_all bis deren Reset", () => {
    const evidence = limitEvidence({ stage: fable, usage: usageFor([known(100, { measuredAt: at(-5) })]), now: NOW });
    expect(evidence).toEqual({ window: "weekly_all", resetsAt: at(1440) });
    expect(applyFailure(state(), { stage: fable, kind: "limit", evidence }, NOW).blocks[0])
      .toMatchObject({ window: "weekly_all", until: at(1440), resetKnown: true });
  });

  test("Woche vor 20 Minuten bei 100 Prozent: keine Zuordnung", () => {
    expect(limitEvidence({ stage: fable, usage: usageFor([known(100, { measuredAt: at(-20) })]), now: NOW })).toBeUndefined();
  });

  test("Beleg ist genau zehn Minuten noch frisch, eine Millisekunde später nicht", () => {
    const input = { stage: fable, usage: usageFor([known(100, { measuredAt: at(-10) })]), now: NOW };
    expect(limitEvidence(input)?.window).toBe("weekly_all");
    expect(limitEvidence({ ...input, now: NOW + 1 })).toBeUndefined();
  });

  test("zwei volle Fenster der Stufe: keine Zuordnung und Familienpause", () => {
    const evidence = limitEvidence({ stage: fable, usage: usageFor([known(100), known(100, { id: "session" })]), now: NOW });
    expect(evidence).toBeUndefined();
    expect(applyFailure(state(), { stage: fable, kind: "limit", evidence }, NOW).blocks[0].family).toBe("fable");
  });

  test("volles Fenster einer anderen Familie zählt nicht als Limit-Beleg", () => {
    expect(limitEvidence({ stage: fable, usage: usageFor([known(100, { id: "weekly_scoped:opus" })]), now: NOW })).toBeUndefined();
  });

  test("rejected mit unbekannter Art fällt auf genau ein volles Messfenster zurück", () => {
    expect(limitEvidence({ stage: fable, usage: usageFor([known(100, { id: "weekly_scoped:fable" })]), now: NOW,
      rateLimit: { status: "rejected", rateLimitType: "seven_day_fable", windows: [] } }))
      .toEqual({ window: "weekly_scoped:fable", resetsAt: at(1440) });
  });

  test("rejected für eine andere Familie liefert keinen unpassenden Beleg", () => {
    expect(limitEvidence({ stage: fable, usage: usageFor(), now: NOW,
      rateLimit: { status: "rejected", rateLimitType: "seven_day_opus", resetsAt: at(1440), windows: [] } })).toBeUndefined();
  });

  test("ausdrücklicher Beleg geht vor zwei vollen Messfenstern", () => {
    expect(limitEvidence({ stage: fable, usage: usageFor([known(100), known(100, { id: "session" })]), now: NOW,
      rateLimit: { status: "rejected", rateLimitType: "five_hour", resetsAt: at(300), windows: [] } }))
      .toEqual({ window: "session", resetsAt: at(300) });
  });

  test("Beleg ohne zukünftigen Reset: Fensterpause, keine Reset-Zeit aus anderen Quellen leihen", () => {
    for (const resetsAt of [undefined, at(-1), at(0)]) {
      const evidence = limitEvidence({ stage: fable, usage: usageFor([known(100)]), now: NOW,
        rateLimit: { status: "rejected", rateLimitType: "seven_day", resetsAt, windows: [] } });
      expect(evidence).toEqual({ window: "weekly_all" });
      const next = applyFailure(failed(), { stage: fable, kind: "limit", evidence }, NOW);
      expect(next.blocks.find(b => b.window)).toMatchObject({ window: "weekly_all", until: at(120), resetKnown: false });
    }
  });

  test("volle Messung ohne Reset belegt das Fenster und ergibt 60 Minuten Pause", () => {
    const evidence = limitEvidence({ stage: fable, usage: usageFor([known(100, { resetsAt: undefined })]), now: NOW });
    expect(evidence).toEqual({ window: "weekly_all" });
    expect(applyFailure(state(), { stage: fable, kind: "limit", evidence }, NOW).blocks[0])
      .toMatchObject({ window: "weekly_all", until: at(60), resetKnown: false });
  });

  test("expired, inzwischen abgelaufene und zukünftige Messungen belegen kein Limit", () => {
    for (const reading of [expired, known(100, { resetsAt: at(0) }), known(100, { measuredAt: at(1) })]) {
      expect(limitEvidence({ stage: fable, usage: usageFor([reading]), now: NOW })).toBeUndefined();
    }
  });

  test("rateLimit.windows liefert den frischen Beleg auch vor der Ablage in usage", () => {
    const evidence = limitEvidence({ stage: fable, usage: usageFor(), now: NOW,
      rateLimit: { windows: [{ id: "weekly_all", percent: 100, measuredAt: at(0), resetsAt: at(1440), source: "stream" }] } });
    expect(evidence).toEqual({ window: "weekly_all", resetsAt: at(1440) });
  });

  test("usage und Lauf-Fenster werden je Kennung nach Messzeit zusammengeführt", () => {
    const rateLimit: EngineRateLimit = { windows: [{ id: "weekly_all", percent: 100, measuredAt: at(-1), resetsAt: at(1440), source: "stream" }] };
    expect(limitEvidence({ stage: fable, usage: usageFor([known(48, { measuredAt: at(-2) })]), rateLimit, now: NOW })?.window).toBe("weekly_all");
    expect(limitEvidence({ stage: fable, usage: usageFor([known(48)]), rateLimit, now: NOW })).toBeUndefined();
    expect(limitEvidence({ stage: fable, usage: usageFor([known(48, { measuredAt: at(-1) })]), rateLimit, now: NOW })?.window).toBe("weekly_all");
  });

  test("volle Fenster aus usage und Lauf zusammen sind mehrdeutig", () => {
    const rateLimit: EngineRateLimit = { windows: [{ id: "session", percent: 100, measuredAt: at(0), source: "stream" }] };
    expect(limitEvidence({ stage: fable, usage: usageFor([known(100)]), rateLimit, now: NOW })).toBeUndefined();
  });

  test("Codex-Limit nutzt sein gemeldetes Fenster und lässt Claude frei", () => {
    const evidence = limitEvidence({ stage: codex, usage: usageFor([known(100, { id: "window_300" })], "codex"), now: NOW });
    expect(evidence).toEqual({ window: "window_300", resetsAt: at(1440) });
    const next = applyFailure(state(), { stage: codex, kind: "limit", evidence }, NOW);
    expect(stageBlock(codex, undefined, next, NOW)?.window).toBe("window_300");
    expect(stageBlock(fable, undefined, next, NOW)).toBeUndefined();
    expect(next.counters[0].scope).toBe("codex");
  });

  test("OpenCode und api bekommen auch durch rejected oder volle Messungen keine Fensterbelege", () => {
    for (const stage of [opencode, api]) {
      expect(limitEvidence({ stage, model: "fable", usage: usageFor([known(100)], stage.engine), now: NOW,
        rateLimit: { status: "rejected", rateLimitType: "seven_day", resetsAt: at(1440), windows: [] } })).toBeUndefined();
    }
  });

  test("bis applyFailure abgelaufener Beleg wird zur Fensterpause", () => {
    const next = applyFailure(state(), { stage: fable, kind: "limit", evidence: { window: "weekly_all", resetsAt: at(0) } }, NOW);
    expect(next.blocks[0]).toMatchObject({ window: "weekly_all", until: at(60), resetKnown: false });
  });

  test("unpassender Beleg wird zur Familienpause statt zu einer wirkungslosen Sperre", () => {
    const next = applyFailure(state(), { stage: fable, kind: "limit", evidence: { window: "weekly_scoped:opus", resetsAt: at(1440) } }, NOW);
    expect(next.blocks[0]).toMatchObject({ family: "fable", until: at(60), resetKnown: false });
    expect(next.blocks[0].window).toBeUndefined();
  });

  test("unbekannte Claude-Familie: Sperre und Zähler nur für genau dieses Modell", () => {
    const next = failed(state(), { engine: "claude", model: "claude-neu-7" });
    expect(next.blocks[0].model).toBe("claude-neu-7");
    expect(next.counters[0].scope).toBe("claude-neu-7");
    expect(stageBlock(claude, "claude-neu-7", next, NOW)).toBeDefined();
    expect(stageBlock(claude, "claude-neu-8", next, NOW)).toBeUndefined();
    expect(applySuccess(next, claude, "claude-neu-7").counters).toEqual([]);
  });

  test("Claude ohne Familie und Modell: Sperre und Zähler für den ganzen Motor", () => {
    const next = failed(state(), claude);
    expect(next.blocks[0]).toEqual(block("limit", {}, { since: at(0) }));
    expect(next.counters[0].scope).toBe("claude");
    expect(stageBlock(opus, undefined, next, NOW)).toBeDefined();
    expect(applySuccess(next, claude, undefined).counters).toEqual([]);
  });

  test("Codex, OpenCode und api: Limit-Pausen und Zähler betreffen den Motor", () => {
    for (const stage of [codex, opencode, { ...api, model: fable.model }]) {
      const next = failed(state(), stage);
      expect(next.blocks[0]).toEqual(block("limit", {}, { engine: stage.engine, since: at(0) }));
      expect(next.counters[0].scope).toBe(stage.engine);
      expect(stageBlock({ ...stage, model: "anderes-modell" }, undefined, next, NOW)).toBeDefined();
      expect(applySuccess(next, stage, undefined).counters).toEqual([]);
    }
  });

  test("Sperren treffen nur ihren Motor: Claude-Fable trifft api-Fable nicht", () => {
    const next = failed();
    expect(stageBlock(api, "fable", next, NOW)).toBeUndefined();
    expect(stageBlock(codex, "fable", next, NOW)).toBeUndefined();
    expect(stageBlock(fable, undefined, failed(state(), api), NOW)).toBeUndefined();
  });

  test("lastAt hat keine Alterungsregel; ein alter Zähler verdoppelt weiter", () => {
    const previous = state({ counters: [{ engine: "claude", kind: "limit", scope: "fable", count: 1, lastAt: "2020-01-01T00:00:00.000Z" }] });
    expect(failed(previous).blocks[0].until).toBe(at(120));
  });
});

describe("Testtabelle: Ausfälle und Stufenauswahl", () => {
  test("Ausfall: zehn Minuten für den ganzen Motor", () => {
    const next = applyFailure(state(), { stage: fable, kind: "outage" }, NOW);
    expect(next.blocks).toEqual([block("outage", {}, { since: at(0), until: at(10) })]);
    expect(next.counters[0]).toEqual({ engine: "claude", kind: "outage", scope: "claude", count: 1, lastAt: at(0) });
    expect(stageBlock(opus, undefined, next, NOW)).toBeDefined();
    expect(stageBlock(codex, undefined, next, NOW)).toBeUndefined();
  });

  test("Ausfall-Pausen verdoppeln 10, 20, 40, 60 Minuten, Obergrenze eine Stunde", () => {
    let next = state();
    for (const minutes of [10, 20, 40, 60, 60]) {
      next = applyFailure(next, { stage: fable, kind: "outage" }, NOW);
      expect(next.blocks).toHaveLength(1);
      expect(next.blocks[0].until).toBe(at(minutes));
    }
  });

  test("gleiche Ursache und Reichweite ersetzt; andere Ursachen und Familien bleiben", () => {
    let next = failed(failed(), opus);
    next = applyFailure(next, { stage: fable, kind: "outage" }, NOW);
    next = failed(next);
    expect(next.blocks).toHaveLength(3);
    expect(next.blocks.filter(b => b.family === "fable")).toHaveLength(1);
    expect(next.blocks.find(b => b.family === "opus")).toBeDefined();
    expect(next.blocks.find(b => b.cause === "outage")).toBeDefined();
  });

  test("stageBlock liefert die treffende Sperre mit spätestem Ende", () => {
    const long = block("limit", { family: "fable" }, { until: at(120) });
    const previous = state({ blocks: [block("threshold"), long, block("outage", {}, { engine: "codex", until: at(180) })] });
    expect(stageBlock(fable, undefined, previous, NOW)).toEqual(long);
    expect(stageBlock(opus, undefined, previous, NOW)?.until).toBe(at(60));
  });

  test("Wunschmotor gesperrt: nächste freie Stufe", () => {
    const previous = failed();
    expect(pickStage([fable, opus, codex], modelOf, previous, ready, NOW)).toEqual({
      kind: "stage", stage: opus, index: 1, skipped: [{ stage: fable, index: 0, reason: "blocked", block: previous.blocks[0] }],
    });
  });

  test("nicht bereite Stufe wird mit Meldung in skipped übersprungen", () => {
    expect(pickStage([codex, opencode], modelOf, state(), { ...ready, codex: { ready: false, message: "Nicht angemeldet" } }, NOW))
      .toEqual({ kind: "stage", stage: opencode, index: 1, skipped: [{ stage: codex, index: 0, reason: "not_ready", message: "Nicht angemeldet" }] });
  });

  test("alle Stufen gesperrt: none mit frühestem Ende unter den Stufen", () => {
    const previous = state({ blocks: [block("outage", {}, { until: at(30) }), block("outage", {}, { engine: "codex", until: at(10) })] });
    const picked = pickStage([fable, codex], modelOf, previous, ready, NOW);
    expect(picked).toMatchObject({ kind: "none", freeAt: at(10) });
    expect(picked.skipped.map(s => s.reason)).toEqual(["blocked", "blocked"]);
  });

  test("freeAt nimmt je Stufe das späteste Sperrende, dann das Minimum der Stufen", () => {
    const previous = state({ blocks: [block("threshold", { window: "session" }, { until: at(10) }),
      block("limit", { family: "fable" }, { until: at(120) }), block("outage", {}, { engine: "codex", until: at(60) })] });
    expect(pickStage([fable, codex], modelOf, previous, ready, NOW)).toMatchObject({ kind: "none", freeAt: at(60) });
  });

  test("Zeitvergleich nutzt Zeitpunkte auch bei unterschiedlichen ISO-Zonen", () => {
    const later = block("limit", { family: "fable" }, { until: "2026-11-17T13:00:00.000Z" });
    const earlier = block("threshold", { window: "weekly_all" }, { until: "2026-11-17T14:30:00.000+02:00" });
    const previous = state({ blocks: [later, earlier] });
    expect(stageBlock(fable, undefined, previous, NOW)).toEqual(later);
    expect(pickStage([fable, opus], modelOf, previous, ready, NOW)).toMatchObject({ kind: "none", freeAt: earlier.until });
  });

  test("alle nicht bereit: none ohne freeAt, selbst bei Sperre und tried", () => {
    const picked = pickStage([fable], modelOf, failed(), { ...ready, claude: { ready: false, message: "Fehlt" } }, NOW, new Set([stageId(fable)]));
    expect(picked).toEqual({ kind: "none", skipped: [{ stage: fable, index: 0, reason: "not_ready", message: "Fehlt" }] });
  });

  test("alle in tried: none ohne freeAt", () => {
    expect(pickStage([fable, codex], modelOf, state(), ready, NOW, new Set([stageId(fable), stageId(codex)])))
      .toEqual({ kind: "none", skipped: [{ stage: fable, index: 0, reason: "tried" }, { stage: codex, index: 1, reason: "tried" }] });
  });

  test("blocked geht vor tried: gesperrte, bereite Stufe liefert weiterhin freeAt", () => {
    const picked = pickStage([fable], modelOf, failed(), ready, NOW, new Set([stageId(fable)]));
    expect(picked).toMatchObject({ kind: "none", freeAt: at(60), skipped: [{ reason: "blocked" }] });
  });

  test("nicht bereite gesperrte Stufen zählen nicht für freeAt", () => {
    const previous = state({ blocks: [block("outage", {}, { until: at(10) }), block("outage", {}, { engine: "codex", until: at(20) })] });
    expect(pickStage([fable, codex], modelOf, previous, { ...ready, claude: { ready: false } }, NOW))
      .toMatchObject({ kind: "none", freeAt: at(20), skipped: [{ reason: "not_ready" }, { reason: "blocked" }] });
  });

  test("leere Reihenfolge: none ohne freeAt", () => {
    expect(pickStage([], modelOf, state(), ready, NOW)).toEqual({ kind: "none", skipped: [] });
  });

  test("api wird auch bei direktem pickStage-Aufruf niemals als Ersatz gewählt", () => {
    expect(pickStage([fable, api], modelOf, failed(), ready, NOW)).toMatchObject({ kind: "none", freeAt: at(60) });
    expect(pickStage([fable, api, codex], modelOf, failed(), ready, NOW)).toMatchObject({ kind: "stage", stage: codex, index: 2 });
    expect(pickStage([api, codex], modelOf, state(), ready, NOW)).toEqual({ kind: "stage", stage: api, index: 0, skipped: [] });
  });
});

describe("Testtabelle: jede Zeile der Übergangstabelle", () => {
  const mixed = () => state({
    blocks: [block("threshold"), block("limit"), block("limit", { family: "fable" }), block("outage", {})],
    counters: [
      { engine: "claude", kind: "limit", scope: "fable", count: 1, lastAt: at(-10) },
      { engine: "claude", kind: "outage", scope: "claude", count: 1, lastAt: at(-10) },
    ],
    auto,
  });

  test("Zeile 1: Reset/Pause abgelaufen gibt alle Ursachen frei, Zähler bleiben", () => {
    const previous = mixed();
    expect(expireBlocks(previous, NOW + 60 * MINUTE)).toEqual({ ...previous, blocks: [] });
  });

  test("Zeile 2: jüngere Messung unter Rückkehr löst threshold und Fenster-limit, Familie und outage bleiben", () => {
    const previous = mixed();
    const next = applyMeasurement(previous, usageFor([known(79)]), NOW, auto);
    expect(next.blocks).toEqual([previous.blocks[2], previous.blocks[3]]);
    expect(next.counters).toEqual(previous.counters);
  });

  test("Zeile 3: Prüfen mit frischer Messung 96 Prozent lässt Fenstersperren stehen", () => {
    const previous = state({ blocks: [block("threshold"), block("limit")] });
    const next = recheck(previous, { usage: usageFor([known(96)]), checkStartedAt: at(0), ready, auto }, NOW);
    expect(next.blocks).toHaveLength(2);
    expect(next.blocks[0]).toMatchObject({ cause: "threshold", window: "weekly_all", since: at(-10), percent: 96 });
    expect(next.blocks[1]).toEqual(previous.blocks[1]);
  });

  test("Zeile 3: Prüfen mit frischer Messung 70 Prozent hebt Fenstersperren auf", () => {
    const previous = state({ blocks: [block("threshold"), block("limit")] });
    expect(recheck(previous, { usage: usageFor([known(70)]), checkStartedAt: at(0), ready, auto }, NOW).blocks).toEqual([]);
  });

  test("Zeile 3: frische Messung genau bei Rückkehr 80 Prozent bleibt gesperrt", () => {
    const previous = state({ blocks: [block("threshold"), block("limit")] });
    expect(recheck(previous, { usage: usageFor([known(80)]), checkStartedAt: at(0), ready, auto }, NOW).blocks).toEqual(previous.blocks);
  });

  test("Zeile 3: frische hohe Messung legt nach Freigabe eines Familien-limits eine neue Fenstersperre an", () => {
    const next = recheck(failed(), { usage: usageFor([known(96)]), checkStartedAt: at(0), ready, auto }, NOW);
    expect(next.blocks).toEqual([block("threshold", { window: "weekly_all" }, { since: at(0), until: at(1440), resetKnown: true, percent: 96 })]);
    expect(next.counters[0].count).toBe(1);
  });

  test("Zeile 4: ohne frische Messung werden threshold und limit frei; alte 96 Prozent sperren nicht erneut", () => {
    const previous = mixed();
    const usage = usageFor([known(96, { measuredAt: at(-1) })]);
    const next = recheck(previous, { usage, checkStartedAt: at(0), ready, auto }, NOW);
    expect(next.blocks).toEqual([]);
    expect(next.counters).toEqual(previous.counters);
    expect(next.released).toEqual({ claude: at(0), codex: at(0), opencode: at(0), api: at(0) });
    expect(applyMeasurement(next, usage, NOW + MINUTE, auto).blocks).toEqual([]);
  });

  test("Zeile 4: Limit-Fehler nach Prüfen ohne frische Messung ergibt verdoppelte Pause", () => {
    const checked = recheck(failed(), { usage: usageFor(), checkStartedAt: at(0), ready, auto }, NOW);
    expect(checked.blocks).toEqual([]);
    expect(failed(checked).blocks[0].until).toBe(at(120));
  });

  test("Zeile 4: outage wird bei bereitem Motor frei, Fehlerzähler bleibt", () => {
    const previous = applyFailure(state(), { stage: fable, kind: "outage" }, NOW);
    const next = recheck(previous, { usage: usageFor(), checkStartedAt: at(0), ready, auto }, NOW);
    expect(next.blocks).toEqual([]);
    expect(next.counters).toEqual(previous.counters);
  });

  test("Zeile 4: outage bleibt bei nicht bereitem Motor, auch mit frischer niedriger Messung", () => {
    const previous = applyFailure(state(), { stage: fable, kind: "outage" }, NOW);
    const next = recheck(previous, { usage: usageFor([known(70)]), checkStartedAt: at(0), ready: { ...ready, claude: { ready: false } }, auto }, NOW);
    expect(next.blocks).toEqual(previous.blocks);
  });

  test("Zeile 4: expired und inzwischen abgelaufene known-Messungen geben bei recheck frei", () => {
    for (const reading of [expired, known(96, { resetsAt: at(0) })]) {
      const previous = state({ blocks: [block("threshold"), block("limit")] });
      expect(recheck(previous, { usage: usageFor([reading]), checkStartedAt: at(-10), ready, auto }, NOW).blocks).toEqual([]);
    }
  });

  test("Zeile 5: Automatik an auf aus hebt threshold auf, limit und outage bleiben", () => {
    const previous = mixed();
    const off = { ...auto, enabled: false };
    const next = syncAuto(previous, off, usageFor([known(96)]), NOW);
    expect(next.blocks).toEqual(previous.blocks.slice(1));
    expect(next.counters).toEqual(previous.counters);
    expect(next.auto).toEqual(off);
  });

  test("Zeile 5: Automatik aus sperrt keine Schwelle, Limit-Fehler sperren weiter", () => {
    const off = { ...auto, enabled: false };
    const next = applyMeasurement(state({ auto: off }), usageFor([known(100)]), NOW, off);
    expect(next.blocks).toEqual([]);
    expect(failed(next).blocks[0]).toMatchObject({ cause: "limit", until: at(60) });
  });

  test("Zeile 5: auch bei Automatik aus hebt eine jüngere niedrige Messung Fenstersperren auf", () => {
    const previous = state({ blocks: [block("threshold"), block("limit")] });
    expect(applyMeasurement(previous, usageFor([known(70)]), NOW, { ...auto, enabled: false }).blocks).toEqual([]);
  });

  test("Zeile 6: Schwelle 60/45 auf 95/80 bei 70 Prozent hebt threshold sofort auf", () => {
    const previous = { ...mixed(), auto: { enabled: true, threshold: 60, returnBelow: 45 } };
    const next = syncAuto(previous, auto, usageFor([known(70)]), NOW);
    expect(next.blocks).toEqual(previous.blocks.slice(1));
    expect(next.counters).toEqual(previous.counters);
  });

  test("Zeile 6: Schwelle 95/80 auf 90/75 bei 96 Prozent lässt threshold stehen", () => {
    const previous = mixed();
    const changed = { ...auto, threshold: 90, returnBelow: 75 };
    const next = syncAuto(previous, changed, usageFor([known(96)]), NOW);
    expect(next.blocks).toEqual(previous.blocks);
    expect(next.auto).toEqual(changed);
  });

  test("Zeile 6: allein geänderte Rückkehrschwelle bewertet die letzte Messung neu, auch vor since", () => {
    const previous = mixed();
    const next = syncAuto(previous, { ...auto, returnBelow: 85 }, usageFor([known(84, { measuredAt: at(-20) })]), NOW);
    expect(next.blocks).toEqual(previous.blocks.slice(1));
  });

  test("Zeile 6: fehlende oder expired Messung gibt nur threshold frei", () => {
    const previous = mixed();
    for (const usage of [usageFor(), usageFor([expired]), usageFor([known(96, { resetsAt: at(0) })])]) {
      expect(syncAuto(previous, { ...auto, threshold: 90 }, usage, NOW).blocks).toEqual(previous.blocks.slice(1));
    }
  });

  test("Zeile 7: Erfolg lässt alle Sperren stehen, setzt eigene Limit- und Motor-Ausfallzähler zurück", () => {
    const previous = mixed();
    const next = applySuccess(previous, fable, undefined);
    expect(next.blocks).toEqual(previous.blocks);
    expect(next.counters).toEqual([]);
  });

  test("Zeile 7: Erfolg einer anderen Familie setzt nur den gemeinsamen Ausfallzähler zurück", () => {
    const previous = mixed();
    const next = applySuccess(previous, opus, undefined);
    expect(next.blocks).toEqual(previous.blocks);
    expect(next.counters).toEqual([previous.counters[0]]);
  });

  test("Zeile 7: Erfolg eines anderen Motors setzt keine fremden Zähler zurück", () => {
    const previous = mixed();
    expect(applySuccess(previous, codex, undefined)).toEqual(previous);
  });

  test("Zeile 7: nächster Ausfall nach erfolgreichem Lauf beginnt wieder bei zehn Minuten", () => {
    const previous = applyFailure(applyFailure(state(), { stage: fable, kind: "outage" }, NOW), { stage: opus, kind: "outage" }, NOW);
    const success = applySuccess(previous, opus, undefined);
    const next = applyFailure(success, { stage: fable, kind: "outage" }, NOW);
    expect(next.blocks[0].until).toBe(at(10));
    expect(next.counters[0].count).toBe(1);
  });

  test("syncAuto ohne Änderung bewertet Sperren nicht neu", () => {
    const previous = mixed();
    expect(syncAuto(previous, { ...auto }, usageFor(), NOW)).toEqual(previous);
  });

  test("syncAuto beim ersten Aufruf merkt Werte, ändert keine Sperren, auch bei aus", () => {
    const previous = { ...mixed(), auto: undefined };
    const off = { ...auto, enabled: false };
    expect(syncAuto(previous, off, usageFor(), NOW)).toEqual({ ...previous, auto: off });
  });

  test("syncAuto beim Einschalten legt selbst keine neue Sperre an", () => {
    const previous = state({ auto: { ...auto, enabled: false } });
    expect(syncAuto(previous, auto, usageFor([known(96)]), NOW)).toEqual({ ...previous, auto });
  });
});

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("Vertrag: reine Funktionen und erweiterbarer Zustand", () => {
  test("jede Funktion akzeptiert tief eingefrorene Eingaben und verändert sie nicht", () => {
    const inputs = deepFreeze({
      previous: state({
        blocks: [block("threshold"), block("limit", { family: "fable" }), block("outage", {})],
        counters: [{ engine: "claude", kind: "limit", scope: "fable", count: 1, lastAt: at(-10) }],
        released: { claude: at(-20) }, auto, futureField: { notifications: ["bleibt"] },
      }),
      usage: usageFor([known(96)]), auto, ready, order: [fable, opus, codex],
      failure: { stage: fable, kind: "limit" as const, evidence: { window: "weekly_all" as const, resetsAt: at(1440) } },
      rateLimit: { status: "rejected", rateLimitType: "seven_day", resetsAt: at(1440),
        windows: [{ id: "weekly_all" as const, percent: 100, measuredAt: at(0), source: "stream" as const }] },
      recheckInput: { usage: usageFor([known(70)]), checkStartedAt: at(0), ready, auto },
    });
    const before = JSON.stringify(inputs);
    const tried = Object.freeze(new Set([stageId(fable)]));
    expect(stageId(inputs.order[0])).toBe("claude:claude-fable-5-2");
    expect(turnOrder(inputs.order[0], inputs.order[1], inputs.order)).toEqual([fable, opus, codex]);
    expect(modelFamily(inputs.order[0].model)).toBe("fable");
    expect(windowCounts(inputs.order[0], undefined, "weekly_all")).toBe(true);
    expect(applyMeasurement(inputs.previous, inputs.usage, NOW, inputs.auto).blocks[0].percent).toBe(96);
    expect(limitEvidence({ stage: inputs.order[0], rateLimit: inputs.rateLimit, usage: inputs.usage, now: NOW })?.window).toBe("weekly_all");
    expect(applyFailure(inputs.previous, inputs.failure, NOW).counters[0].count).toBe(2);
    expect(applySuccess(inputs.previous, inputs.order[0], undefined).counters).toEqual([]);
    expect(expireBlocks(inputs.previous, NOW + 60 * MINUTE).blocks).toEqual([]);
    expect(stageBlock(inputs.order[0], undefined, inputs.previous, NOW)).toBeDefined();
    expect(pickStage(inputs.order, modelOf, inputs.previous, inputs.ready, NOW, tried)).toMatchObject({ kind: "stage", stage: codex });
    expect(recheck(inputs.previous, inputs.recheckInput, NOW).blocks).toEqual([]);
    expect(syncAuto(inputs.previous, deepFreeze({ ...auto, enabled: false }), inputs.usage, NOW).blocks).toHaveLength(2);
    expect(JSON.stringify(inputs)).toBe(before);
    expect([...tried]).toEqual([stageId(fable)]);
  });

  const transformations: [string, (previous: SwitchState) => SwitchState][] = [
    ["applyMeasurement", previous => applyMeasurement(previous, usageFor([known(96)]), NOW, auto)],
    ["applyFailure", previous => failed(previous)],
    ["applySuccess", previous => applySuccess(previous, fable, undefined)],
    ["expireBlocks", previous => expireBlocks(previous, NOW + 60 * MINUTE)],
    ["recheck", previous => recheck(previous, { usage: usageFor(), checkStartedAt: at(0), ready, auto }, NOW)],
    ["syncAuto", previous => syncAuto(previous, { ...auto, enabled: false }, usageFor(), NOW)],
  ];
  test.each(transformations)("unbekanntes Zustandsfeld überlebt %s und JSON-Rundlauf", (_name, transform) => {
    const previous = deepFreeze({ ...failed(), auto, futureField: { pending: ["M14-10"], revision: 7 } });
    const next = transform(previous);
    expect(next).not.toBe(previous);
    expect(JSON.parse(JSON.stringify(next)).futureField).toEqual(previous.futureField);
  });

  test("ungültiger Abstand der Schwellen wird vor Zustandsänderungen abgewiesen", () => {
    for (const invalid of [{ ...auto, returnBelow: 95 }, { ...auto, returnBelow: 96 },
      { ...auto, threshold: Infinity }, { ...auto, returnBelow: NaN }]) {
      const previous = deepFreeze(state({ blocks: [block("threshold")], auto }));
      expect(() => applyMeasurement(previous, usageFor([known(96)]), NOW, invalid)).toThrow(RangeError);
      expect(() => recheck(previous, { usage: usageFor(), checkStartedAt: at(0), ready, auto: invalid }, NOW)).toThrow(RangeError);
      expect(() => syncAuto(previous, invalid, usageFor(), NOW)).toThrow(RangeError);
    }
  });
});

describe("formatSwitchTime", () => {
  test("deutsche Kurzform mit fester Zeitzone, ohne ICU-Wochentagsnamen", async () => {
    const { formatSwitchTime } = await import("../src/lib/engine-switch");
    expect(formatSwitchTime("2026-11-22T15:00:00Z", "Europe/Berlin")).toBe("So, 22.11., 16:00");
    expect(formatSwitchTime("2026-11-22T23:30:00Z", "Europe/Berlin")).toBe("Mo, 23.11., 00:30");
    expect(formatSwitchTime("2026-07-01T15:04:00Z", "Europe/Berlin")).toBe("Mi, 01.07., 17:04");
    expect(formatSwitchTime("2026-11-22T15:00:00Z", "UTC")).toBe("So, 22.11., 15:00");
  });
});
