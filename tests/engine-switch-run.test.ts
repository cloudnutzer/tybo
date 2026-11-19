import { describe, expect, test } from "bun:test";
import { failedAttemptPrompt, FAILED_ATTEMPT_MAX_TOOLS, FAILED_ATTEMPT_TOOL_CHARS, noteStageRun, stageFailureOf } from "../src/lib/engine-switch-run";
import type { SwitchState } from "../src/lib/engine-switch";
import type { EngineErrorKind, EngineResult } from "../src/lib/engines";

const now = Date.parse("2026-11-17T10:00:00Z");
const auto = { enabled: true, threshold: 95, returnBelow: 80 };
const state: SwitchState = { version: 1, blocks: [], counters: [
  { engine: "claude", kind: "limit", scope: "fable", count: 2, lastAt: new Date(now).toISOString() },
  { engine: "claude", kind: "limit", scope: "opus", count: 3, lastAt: new Date(now).toISOString() },
] };
const result: EngineResult = { engine: "claude", text: "fertig", isError: false, rateLimit: { windows: [
  { id: "weekly_all", percent: 96, source: "stream", measuredAt: new Date(now).toISOString(), resetsAt: new Date(now + 60_000).toISOString() },
] } };

describe("noteStageRun", () => {
  test("Erfolg setzt nur passende Zähler zurück und wendet die Messung an", async () => {
    let changed!: SwitchState;
    await noteStageRun({ engine: "claude" }, "fable", result, auto, now, async mutate => {
      changed = mutate(state);
      expect(mutate(state)).toEqual(changed);
      return { state: changed, persisted: true };
    });
    expect(changed.counters).toEqual([state.counters[1]]);
    expect(changed.blocks).toMatchObject([{ cause: "threshold", window: "weekly_all", percent: 96 }]);
    expect(state.blocks).toEqual([]);
  });
  test("Fehler, Abbruch und Zeitlimit setzen keinen Erfolgszähler zurück", async () => {
    for (const extra of [{ isError: true }, { aborted: true }, { timedOut: true }, { text: "" }]) {
      await noteStageRun({ engine: "claude" }, "fable", { ...result, ...extra }, auto, now, async mutate => {
        const changed = mutate(state);
        expect(changed.counters).toEqual(state.counters);
        return { state: changed, persisted: false };
      }, { abandoned: false });
    }
  });
  test("wirft nie, auch wenn die eingesetzte Ablage wirft", async () => {
    expect(await noteStageRun({ engine: "claude" }, "fable", result, auto, now, async () => { throw new Error("Schreibfehler"); })).toBeUndefined();
  });
  test("Auswertung reiht ohne Warten ein, auch ohne Messwerte beim JSON-Lauf", async () => {
    let enqueued = false;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const write = noteStageRun({ engine: "claude" }, "fable", { ...result, rateLimit: undefined }, auto, now, async mutate => {
      enqueued = true;
      await pending;
      expect(mutate(state).blocks).toEqual([]);
      return { state: mutate(state), persisted: true };
    });
    expect(enqueued).toBe(true);
    finish();
    await write;
  });
});

const failures: [EngineErrorKind | undefined, "limit" | "outage" | undefined][] = [
  ["usage_limit", "limit"], ["quota", "limit"], ["auth", "outage"], ["not_installed", "outage"],
  ["capacity", "outage"], ["other", "outage"], [undefined, "outage"], ["rate_limit", undefined], ["context", undefined],
];
describe("Fehler einer aufgegebenen Stufe", () => {
  for (const [errorKind, kind] of failures) {
    test(`${errorKind ?? "ohne Fehlerart"}: ${kind ?? "kein Einspringen"}`, async () => {
      const failed = { engine: "claude" as const, text: "", isError: true, errorKind };
      expect(stageFailureOf(failed)).toBe(kind);
      for (const extra of [{ isError: false }, { aborted: true }, { timedOut: true }]) {
        expect(stageFailureOf({ ...failed, ...extra })).toBeUndefined();
      }
      let changed!: SwitchState;
      await noteStageRun({ engine: "claude", model: "opus" }, "fable", failed, auto, now, async mutate => {
        const empty: SwitchState = { version: 1, blocks: [], counters: [] };
        changed = mutate(empty);
        expect(mutate(empty)).toEqual(changed);
        return { state: changed, persisted: false };
      }, { readUsage: async () => ({ claude: [], codex: [], opencode: [], api: [] }) });
      if (kind) {
        expect(changed.blocks).toMatchObject([{ engine: "claude", cause: kind, resetKnown: false,
          until: new Date(now + (kind === "limit" ? 60 : 10) * 60_000).toISOString() }]);
        expect(changed.blocks[0].family).toBe(kind === "limit" ? "fable" : undefined);
        expect(changed.counters[0].count).toBe(1);
      } else expect(changed.blocks).toEqual([]);
    });
  }

  test("frisch gelesener voller Messwert belegt das Fenster, Mutation liest nicht erneut", async () => {
    let reads = 0;
    const resetsAt = new Date(now + 86_400_000).toISOString();
    await noteStageRun({ engine: "claude" }, "fable", { engine: "claude", text: "", isError: true, errorKind: "quota" }, auto, now,
      async mutate => {
        for (let n = 0; n < 2; n++) expect(mutate(state).blocks).toMatchObject([
          { cause: "limit", window: "weekly_all", until: resetsAt, resetKnown: true },
        ]);
        return { state: mutate(state), persisted: true };
      }, { readUsage: async () => {
        reads++;
        return { claude: [{ id: "weekly_all", state: "known", percent: 100, measuredAt: new Date(now).toISOString(), resetsAt, source: "extern" }],
          codex: [], opencode: [], api: [] };
      } });
    expect(reads).toBe(1);
  });

  test("rejected belegt Reset auch bei Lesefehler; ohne Beleg gilt nur Familienpause", async () => {
    for (const rejected of [true, false]) {
      const resetsAt = new Date(now + 86_400_000).toISOString();
      await noteStageRun({ engine: "claude" }, "fable", { engine: "claude", text: "", isError: true, errorKind: "usage_limit",
        ...(rejected ? { rateLimit: { status: "rejected", rateLimitType: "seven_day", resetsAt } } : {}) }, auto, now,
        async mutate => {
          const changed = mutate({ version: 1, blocks: [], counters: [] });
          expect(changed.blocks[0]).toMatchObject(rejected
            ? { window: "weekly_all", until: resetsAt, resetKnown: true }
            : { family: "fable", until: new Date(now + 3_600_000).toISOString(), resetKnown: false });
          return { state: changed, persisted: true };
        }, { readUsage: async () => { throw new Error("Lesefehler"); } });
    }
  });
});

describe("Absatz zum abgebrochenen Versuch", () => {
  test("Werkzeugliste mit Namen, Befehl und Pfad, vor der Kürzung maskiert", () => {
    const secret = "erfundener-testwert-".repeat(8);
    const text = failedAttemptPrompt({ engine: "claude", model: "fable" }, "quota", { uses: [
      { name: "Bash", command: `sende --wert=${secret}` }, { name: "Write", path: `/tmp/${secret}/datei.txt` },
    ] }, [secret]);
    expect(text).toBe("Der vorige Versuch mit Claude Code mit fable ist abgebrochen (Kontingent aufgebraucht). "
      + "Er hat bereits diese Werkzeuge benutzt: Bash: sende --wert=[verborgen]; Write: /tmp/[verborgen]/datei.txt. "
      + "Prüfe den Stand, bevor du etwas wiederholst.");
    expect(text).not.toContain("erfundener-testwert");
  });
  test("bekannte leere Liste und unbekannte Liste bleiben unterscheidbar", () => {
    expect(failedAttemptPrompt({ engine: "codex" }, "capacity", { uses: [] }, []))
      .toContain("Er hat noch kein Werkzeug benutzt.");
    expect(failedAttemptPrompt({ engine: "codex" }, undefined, undefined, []))
      .toContain("Welche Werkzeuge er benutzt hat, ist nicht bekannt.");
  });
  test("unlesbare Geheimnisquelle: nur Werkzeugnamen", () => {
    const text = failedAttemptPrompt({ engine: "codex" }, "other", { uses: [
      { name: "Bash", command: "unbekannter-wert", path: "/nicht-weitergeben" },
    ] }, undefined);
    expect(text).toContain("Werkzeuge benutzt: Bash.");
    expect(text).not.toContain("unbekannter-wert");
    expect(text).not.toContain("nicht-weitergeben");
  });
  test("Länge und Anzahl begrenzt, ausgelassene Aufrufe ausdrücklich genannt", () => {
    const text = failedAttemptPrompt({ engine: "codex" }, "auth", { uses: Array.from({ length: 23 }, (_, n) => ({
      name: `Werkzeug${n}`, command: "x".repeat(500),
    })) }, []);
    expect(text).toContain("(nicht angemeldet)");
    expect(text.match(/Werkzeug\d+/g)).toHaveLength(FAILED_ATTEMPT_MAX_TOOLS);
    expect(text).toContain("(3 weitere Aufrufe)");
    expect(text).not.toContain("x".repeat(FAILED_ATTEMPT_TOOL_CHARS));
    expect(text.length).toBeLessThan(FAILED_ATTEMPT_MAX_TOOLS * (FAILED_ATTEMPT_TOOL_CHARS + 2) + 250);
  });
});
