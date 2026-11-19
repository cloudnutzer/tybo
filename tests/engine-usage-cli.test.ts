import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUsageCli, type UsageCliOptions } from "../src/lib/engines/usage-cli";
import { parseExternalUsageArgs, validateExternalUsage } from "../src/lib/engines/usage-input";
import { FUTURE_TOLERANCE_MS, readUsage, recordUsage, setUsageFileForTests } from "../src/lib/engines/usage";
import { readSwitchState, setSwitchStateFileForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import { formatSwitchTime, type SwitchBlock } from "../src/lib/engine-switch";
import { setSettingsPath } from "../src/lib/settings";

let directory: string;
let usageFile: string;
let stateFile: string;
let now: number;
let warnings: ReturnType<typeof spyOn>;
const iso = (time: number) => new Date(time).toISOString();
const window = (changes: Record<string, unknown> = {}) => ({
  id: "weekly_all", percent: 62, measuredAt: iso(now), resetsAt: iso(now + 3_600_000), ...changes,
});
const input = (changes: Record<string, unknown> = {}) => ({ engine: "claude", windows: [window()], ...changes });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "engine-usage-cli-"));
  usageFile = join(directory, "engine-usage.json");
  stateFile = join(directory, "engine-switch.json");
  now = Date.now() - 1_000;
  setUsageFileForTests(usageFile, 20);
  setSwitchStateFileForTests(stateFile, 20);
  setSettingsPath(join(directory, "settings.json"));
  warnings = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setUsageFileForTests(null);
  setSwitchStateFileForTests(null);
  setSettingsPath();
  warnings.mockRestore();
  rmSync(directory, { recursive: true, force: true });
});

async function run(args: string[], stdin?: string, options: UsageCliOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runUsageCli(args, {
    now: () => now, stdin: async () => stdin ?? "", out: line => out.push(line), err: line => err.push(line), timeZone: "UTC", ...options,
  });
  return { code, out, err };
}
const set = (value = input(), options?: UsageCliOptions) => run(["set", "--stdin"], JSON.stringify(value), options);
function snapshot() {
  return Object.fromEntries(readdirSync(directory, { recursive: true }).map(String).sort()
    .map(name => [name, readFileSync(join(directory, name), "utf8")]));
}
async function seed() {
  await set();
  writeFileSync(stateFile, JSON.stringify({ version: 1, blocks: [], counters: [], future: { keep: true } }));
}

describe("externe Messwerte: reine Prüfung", () => {
  test("zulässige Motoren, Fenster und Grenzen; Quelle wird fest extern", () => {
    for (const [engine, ids] of [
      ["claude", ["weekly_all", "session", "weekly_scoped:fable", "weekly_scoped:opus", "weekly_scoped:a-1", `weekly_scoped:${"a".repeat(40)}`]],
      ["codex", ["weekly_all", "session", "window_1", "window_1440", "window_525600"]],
    ] as const) {
      for (const id of ids) for (const percent of [0, 62.125, 100]) {
        const value = input({ engine, windows: [window({ id, percent })] });
        expect(validateExternalUsage(value, now)).toEqual({ ...value, windows: [{ ...value.windows[0], source: "extern" }] });
      }
    }
  });

  test("60 Sekunden Zukunftstoleranz, ISO-Zeit mit Offset, keine Änderung der Eingabe", () => {
    const value = input({ windows: [window({ measuredAt: iso(now + FUTURE_TOLERANCE_MS), resetsAt: "2099-01-01T12:00:00+01:00" })] });
    const before = structuredClone(value);
    expect(validateExternalUsage(value, now).windows[0].measuredAt).toBe(iso(now + 60_000));
    expect(value).toEqual(before);
    expect(() => validateExternalUsage(input({ windows: [window({ measuredAt: iso(now + 60_001) })] }), now)).toThrow("measuredAt");
    expect(() => validateExternalUsage(input({ windows: [window({ percent: NaN })] }), now)).toThrow("percent");
    expect(() => validateExternalUsage(input({ windows: [window({ percent: Infinity })] }), now)).toThrow("percent");
  });

  test("Schalter: Messzeit standardmäßig jetzt, Dezimalzahl unverändert", () => {
    expect(parseExternalUsageArgs(["--engine", "claude", "--window", "session", "--percent", "62.125"], undefined, now))
      .toEqual({ engine: "claude", windows: [{ id: "session", percent: 62.125, measuredAt: iso(now), source: "extern" }] });
  });
});

describe("limits set und show", () => {
  test("Schalter schreiben extern, eine Zeile je Fenster; show liefert readUsage", async () => {
    const result = await run(["set", "--engine", "claude", "--window", "session", "--percent", "62.125",
      "--resets-at", iso(now + 3_600_000)]);
    expect(result).toEqual({ code: 0, out: ["claude session: 62.125 %, übernommen"], err: [] });
    expect(JSON.parse(readFileSync(usageFile, "utf8")).engines.claude.windows).toEqual([
      { id: "session", percent: 62.125, measuredAt: iso(now), resetsAt: iso(now + 3_600_000), source: "extern" },
    ]);
    const before = snapshot();
    const shown = await run(["show"]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.out[0])).toEqual(await readUsage(now));
    expect(snapshot()).toEqual(before);
  });

  test("JSON mit mehreren Fenstern wird vollständig gespeichert", async () => {
    const value = input({ windows: [window(), window({ id: "weekly_scoped:fable", percent: 90 })] });
    expect((await set(value)).out).toEqual(["claude weekly_all: 62 %, übernommen", "claude weekly_scoped:fable: 90 %, übernommen"]);
    expect((await readUsage(now)).claude).toEqual(value.windows.map(w => ({ ...w, source: "extern", state: "known" })));
  });

  test("show ohne Datei bleibt still und legt auch keinen Ordner an", async () => {
    setUsageFileForTests(join(directory, "fehlt", "usage.json"));
    const shown = await run(["show"]);
    expect(shown.code).toBe(0);
    expect(shown.err).toEqual([]);
    expect(JSON.parse(shown.out[0])).toEqual({ claude: [], codex: [], opencode: [], api: [] });
    expect(warnings).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual([]);
  });

  test("ältere Messung bleibt zurück, jüngere andere Quelle ersetzt extern", async () => {
    await set();
    const before = readFileSync(usageFile, "utf8");
    expect((await set(input({ windows: [window({ percent: 10, measuredAt: iso(now - 1_000) })] }))).out)
      .toEqual(["claude weekly_all: 10 %, nicht übernommen, es gibt eine jüngere Messung"]);
    expect(readFileSync(usageFile, "utf8")).toBe(before);
    const newer = { id: "weekly_all" as const, percent: 45, measuredAt: iso(now + 1_000), source: "report" as const };
    expect((await recordUsage("claude", [newer])).accepted).toEqual(["weekly_all"]);
    expect((await readUsage(now)).claude).toEqual([{ ...newer, state: "known" }]);
  });

  test("vergangene Reset-Zeit und genau jetzt: vorhandene Messung und Zustand unverändert", async () => {
    await seed();
    const before = snapshot();
    for (const resetsAt of [iso(now - 1_000), iso(now)]) {
      const result = await set(input({ windows: [window({ percent: 96, measuredAt: iso(now + 1_000), resetsAt })] }));
      expect(result).toEqual({ code: 0, out: ["claude weekly_all: 96 %, nicht übernommen, die Reset-Zeit ist vorbei"], err: [] });
      expect(snapshot()).toEqual(before);
    }
  });

  test("gemischter Aufruf: abgelaufenes Fenster bleibt, anderes wird übernommen", async () => {
    await set();
    const result = await set(input({ windows: [window({ resetsAt: iso(now - 1), percent: 99 }), window({ id: "session", percent: 5 })] }));
    expect(result.out).toEqual(["claude weekly_all: 99 %, nicht übernommen, die Reset-Zeit ist vorbei", "claude session: 5 %, übernommen"]);
    expect((await readUsage(now)).claude.map(w => w.state === "known" && w.percent)).toEqual([62, 5]);
  });

  test("belegte Messwert-Sperre: Exit 1, nicht gespeichert, Zustand unverändert", async () => {
    await seed();
    writeFileSync(`${usageFile}.lock`, JSON.stringify({ pid: process.pid, token: "test" }));
    const before = snapshot();
    let updates = 0;
    expect(await set(input({ windows: [window({ percent: 96 })] }), {
      updateState: async mutate => { updates++; return updateSwitchState(mutate); },
    }))
      .toEqual({ code: 1, out: ["claude weekly_all: 96 %, nicht gespeichert"], err: [] });
    expect(updates).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  test("Schreibfehler der Messwerte: Exit 1, kein Zustand angelegt", async () => {
    mkdirSync(usageFile);
    expect((await set()).code).toBe(1);
    expect(existsSync(stateFile)).toBe(false);
    expect(readdirSync(directory)).toEqual(["engine-usage.json"]);
  });
});

function configureAuto(enabled = true, backups = true) {
  writeFileSync(join(directory, "settings.json"), JSON.stringify({
    engine: { backups: backups ? [{ engine: "codex" }] : [], auto: { enabled, threshold: 95, returnBelow: 80 } },
  }));
}
const block = (changes: Partial<SwitchBlock> = {}): SwitchBlock => ({
  engine: "claude", window: "weekly_all", cause: "threshold", since: iso(now - 1_000),
  until: iso(now + 3_600_000), percent: 96, resetKnown: true, ...changes,
});

describe("Sperrzustand über die gemeinsame Regel", () => {
  test("96 Prozent: threshold bis Reset, danach hebt 70 Prozent die ältere Sperre auf", async () => {
    configureAuto();
    expect(await set(input({ windows: [window({ percent: 96 })] }))).toEqual({
      code: 0, err: [], out: ["claude weekly_all: 96 %, übernommen", `Sperre bis ${formatSwitchTime(iso(now + 3_600_000), "UTC")}`],
    });
    expect(JSON.parse(readFileSync(stateFile, "utf8")).blocks).toEqual([block({ since: iso(now) })]);
    now += 1_000;
    expect(await set(input({ windows: [window({ percent: 70 })] }))).toEqual({
      code: 0, err: [], out: ["claude weekly_all: 70 %, übernommen", "Sperre aufgehoben"],
    });
    expect(JSON.parse(readFileSync(stateFile, "utf8")).blocks).toEqual([]);
  });

  test("ohne Reset: 60 Minuten ab Messzeit, unbekannter Reset in Datei und Ausgabe", async () => {
    configureAuto();
    const measuredAt = iso(now - 600_000);
    const until = iso(now + 3_000_000);
    expect(await set(input({ windows: [window({ percent: 96, measuredAt, resetsAt: undefined })] }))).toEqual({
      code: 0, err: [], out: ["claude weekly_all: 96 %, übernommen",
        `Sperre bis ${formatSwitchTime(until, "UTC")} (60 Minuten ab der Messung, Reset-Zeit unbekannt)`],
    });
    expect(JSON.parse(readFileSync(stateFile, "utf8")).blocks).toEqual([block({ since: iso(now), until, resetKnown: false })]);
    expect((await readUsage(now)).claude[0]).toMatchObject({ percent: 96, measuredAt, source: "extern" });
    expect((await readUsage(now)).claude[0]).not.toHaveProperty("resetsAt");
  });

  test("90 Minuten alte Messung ohne Reset bleibt gespeichert und sperrt nicht", async () => {
    configureAuto();
    const measuredAt = iso(now - 90 * 60_000);
    expect((await set(input({ windows: [window({ percent: 96, measuredAt, resetsAt: undefined })] }))).out)
      .toEqual(["claude weekly_all: 96 %, übernommen"]);
    expect(readSwitchState().blocks).toEqual([]);
    expect((await readUsage(now)).claude[0]).toMatchObject({ percent: 96, measuredAt, source: "extern" });
  });

  for (const [enabled, backups] of [[false, true], [true, false]]) {
    test(`Automatik enabled=${enabled}, Ersatzstufen=${backups}: keine neue Sperre, Aufheben bleibt`, async () => {
      configureAuto(enabled, backups);
      expect((await set(input({ windows: [window({ percent: 96 })] }))).out).toEqual(["claude weekly_all: 96 %, übernommen"]);
      expect(readSwitchState().blocks).toEqual([]);
      writeFileSync(stateFile, JSON.stringify({ version: 1, blocks: [block()], counters: [] }));
      expect((await set(input({ windows: [window({ percent: 70 })] }))).out)
        .toEqual(["claude weekly_all: 70 %, übernommen", "Sperre aufgehoben"]);
      expect(readSwitchState().blocks).toEqual([]);
    });
  }

  test("nur blocks ändern sich: unbekannte Felder, Zähler, released, auto und Meldungen bleiben", async () => {
    configureAuto();
    const state = {
      version: 1, blocks: [block({ engine: "codex", window: "session", cause: "limit" })],
      counters: [{ engine: "claude", kind: "limit", scope: "fable", count: 3, lastAt: iso(now - 10_000) }],
      released: { claude: iso(now - 2_000) }, auto: { enabled: false, threshold: 90, returnBelow: 75 },
      future: { nested: ["bleibt", 42] },
      notices: { announced: "codex", pending: [{ id: "offen", text: "Vorhandene Meldung", createdAt: iso(now), attempts: 0, nextAt: iso(now) }] },
    };
    writeFileSync(stateFile, JSON.stringify(state));
    const settingsBefore = readFileSync(join(directory, "settings.json"), "utf8");
    await set(input({ windows: [window({ percent: 96 })] }));
    expect(JSON.parse(readFileSync(stateFile, "utf8")))
      .toEqual({ ...state, blocks: [...state.blocks, block({ since: iso(now) })] });
    expect(readFileSync(join(directory, "settings.json"), "utf8")).toBe(settingsBefore);
  });

  test("Dateisperre: drei Versuche mit je 1000 ms Abstand, Exit 0 und ehrlicher Hinweis", async () => {
    configureAuto();
    await seed();
    const before = readFileSync(stateFile, "utf8");
    writeFileSync(`${stateFile}.lock`, JSON.stringify({ pid: process.pid, token: "test" }));
    const events: string[] = [];
    const result = await set(input({ windows: [window({ percent: 96 })] }), {
      wait: async ms => { events.push(`wait ${ms}`); },
      updateState: async mutate => { events.push("update"); return updateSwitchState(mutate); },
    });
    expect(events).toEqual(["update", "wait 1000", "update", "wait 1000", "update"]);
    expect(result).toEqual({ code: 0, err: [], out: ["claude weekly_all: 96 %, übernommen",
      "Messwert gespeichert. Der Sperrzustand ließ sich gerade nicht schreiben; der Bot wertet den Messwert mit der nächsten Nachricht aus."] });
    expect(readFileSync(stateFile, "utf8")).toBe(before);
    expect((await readUsage(now)).claude[0]).toMatchObject({ percent: 96, source: "extern" });
  });

  test("dritter Versuch gelingt: Mutation bleibt wiederholbar und erhält fremde Änderungen", async () => {
    configureAuto();
    await seed();
    writeFileSync(`${stateFile}.lock`, JSON.stringify({ pid: process.pid, token: "test" }));
    let waits = 0;
    let attempts = 0;
    const result = await set(input({ windows: [window({ percent: 96 })] }), {
      wait: async () => {
        waits++;
        if (waits === 2) {
          rmSync(`${stateFile}.lock`);
          writeFileSync(stateFile, JSON.stringify({ version: 1, blocks: [], counters: [], foreign: "während des Wartens" }));
        }
      },
      updateState: async mutate => { attempts++; return updateSwitchState(mutate); },
    });
    expect(attempts).toBe(3);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["claude weekly_all: 96 %, übernommen", `Sperre bis ${formatSwitchTime(iso(now + 3_600_000), "UTC")}`]);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({
      version: 1, counters: [], blocks: [block({ since: iso(now) })], foreign: "während des Wartens",
    });
  });

  test("readUsage vollständig anwenden, aber nur eingelieferte Fenster ausgeben", async () => {
    configureAuto();
    await recordUsage("codex", [{ id: "session", percent: 99, measuredAt: iso(now), source: "session-file", resetsAt: iso(now + 60_000) }]);
    const result = await set(input({ windows: [window({ id: "weekly_scoped:fable", percent: 96 })] }));
    expect(readSwitchState().blocks).toHaveLength(2);
    expect(result.out).toEqual(["claude weekly_scoped:fable: 96 %, übernommen", `Sperre bis ${formatSwitchTime(iso(now + 3_600_000), "UTC")}`]);
  });

  test("unveränderte Sperre gibt keine zusätzliche Zeile; ältere Lieferung hebt sie nicht auf", async () => {
    configureAuto();
    await set(input({ windows: [window({ percent: 96 })] }));
    expect((await set(input({ windows: [window({ percent: 96 })] }))).out).toEqual(["claude weekly_all: 96 %, übernommen"]);
    expect((await set(input({ windows: [window({ percent: 10, measuredAt: iso(now - 1_000) })] }))).out)
      .toEqual(["claude weekly_all: 10 %, nicht übernommen, es gibt eine jüngere Messung"]);
    expect(readSwitchState().blocks).toEqual([block({ since: iso(now) })]);
  });

  test("Aufheben braucht eine Messzeit echt nach since, released verhindert alte neue Sperren", async () => {
    configureAuto();
    await set(input({ windows: [window({ percent: 96 })] }));
    expect((await set(input({ windows: [window({ percent: 70 })] }))).out).toEqual(["claude weekly_all: 70 %, übernommen"]);
    expect(readSwitchState().blocks).toHaveLength(1);
    writeFileSync(stateFile, JSON.stringify({ version: 1, blocks: [], counters: [], released: { claude: iso(now + 1_000) } }));
    expect((await set(input({ windows: [window({ percent: 96 })] }))).out).toEqual(["claude weekly_all: 96 %, übernommen"]);
    expect(readSwitchState().blocks).toEqual([]);
  });

  test("reale engineAuto-Einstellungen verwenden; Schwelle selbst sperrt, returnBelow selbst hebt nicht auf", async () => {
    configureAuto();
    await set(input({ windows: [window({ percent: 95 })] }));
    expect(readSwitchState().blocks[0].percent).toBe(95);
    now += 1_000;
    await set(input({ windows: [window({ percent: 80 })] }));
    expect(readSwitchState().blocks).toHaveLength(1);
  });
});

test("Befehl und Kern importieren keinen Meldeweg, starten keine Prozesse und lesen keine Geheimnisse", () => {
  const allowed: Record<string, string[]> = {
    "scripts/engine-usage.ts": ["../src/lib/engines/usage-cli"],
    "src/lib/engines/usage-cli.ts": ["./usage", "./usage-input", "../engine-switch", "../engine-switch-state", "../settings"],
    "src/lib/engines/usage-input.ts": ["zod", "./usage"],
  };
  for (const [file, imports] of Object.entries(allowed)) {
    const source = readFileSync(join(import.meta.dir, "..", file), "utf8");
    expect(new Bun.Transpiler({ loader: "ts" }).scan(source).imports.map(entry => entry.path).sort()).toEqual(imports.sort());
    expect(source).not.toMatch(/outbox|notify|channels\/|bot\.ts|engine-choice|claude-usage|\bfetch\s*\(|\bspawn(?:Sync)?\s*\(|readFile|process\.env|Bun\.env|Bun\.file|dotenv/);
  }
});

describe("Ablehnung vor jedem Schreiben", () => {
  const invalid: [string, () => unknown, string][] = [
    ["unbekannter Motor", () => input({ engine: "fremd" }), "engine"],
    ["OpenCode", () => input({ engine: "opencode" }), "engine"],
    ["API", () => input({ engine: "api" }), "engine"],
    ...["unbekannt", "window_5", "weekly_scoped:Opus", "weekly_scoped:a_b", "weekly_scoped:a b", "weekly_scoped:a.b",
      `weekly_scoped:${"a".repeat(41)}`].map(id => [id, () => input({ windows: [window({ id })] }), "id"] as [string, () => unknown, string]),
    ...["weekly_scoped:fable", "window_0", "window_01", "window_1.5", "window_525601", "window_300", "window_10080"]
      .map(id => [`Codex ${id}`, () => input({ engine: "codex", windows: [window({ id })] }), "id"] as [string, () => unknown, string]),
    ...[101, -1, "96", null].map(percent => [`percent ${percent}`, () => input({ windows: [window({ percent })] }), "percent"] as [string, () => unknown, string]),
    ...["kaputt", "2026-02-30T12:00:00Z", "2026-11-17T12:00:00", "2026-11-17"].flatMap(value =>
      ["measuredAt", "resetsAt"].map(field => [`${field} ${value}`, () => input({ windows: [window({ [field]: value })] }), field] as [string, () => unknown, string])),
    ["zwei Minuten voraus", () => input({ windows: [window({ measuredAt: iso(now + 120_000) })] }), "measuredAt"],
    ["Messzeit fehlt", () => input({ windows: [window({ measuredAt: undefined })] }), "measuredAt"],
    ["elf Fenster", () => input({ engine: "codex", windows: Array.from({ length: 11 }, (_, i) => window({ id: `window_${i + 1}` })) }), "windows"],
    ["leere Liste", () => input({ windows: [] }), "windows"],
    ["Kennung doppelt", () => input({ windows: [window(), window()] }), "id"],
    ["unbekanntes Wurzelfeld", () => input({ fremd: true }), "fremd"],
    ["unbekanntes Fensterfeld", () => input({ windows: [window({ fremd: true })] }), "fremd"],
    ["eigene Quelle", () => input({ windows: [window({ source: "report" })] }), "source"],
    ["späteres Fenster falsch", () => input({ windows: [window({ percent: 96 }), window({ id: "session", percent: 101 })] }), "percent"],
    ["Wurzel null", () => null, "JSON"],
  ];
  for (const [name, value, field] of invalid) test(name, async () => {
    await seed();
    const before = snapshot();
    const result = await run(["set", "--stdin"], JSON.stringify(value()));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain(field);
    expect(result.out).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  test("kaputtes JSON legt keine Dateien an; mit Altbestand ändert sich nichts", async () => {
    for (const existing of [false, true]) {
      if (existing) await seed();
      const before = snapshot();
      expect(await run(["set", "--stdin"], "{kaputt"))
        .toEqual({ code: 1, out: [], err: ["Fehler: JSON: ungültiges JSON in der Standardeingabe"] });
      expect(snapshot()).toEqual(before);
    }
  });

  test("strenge Schalter, keine stillen Zahlenumwandlungen, keine gemischte Standardeingabe", async () => {
    await seed();
    const before = snapshot();
    const base = ["set", "--engine", "claude", "--window", "weekly_all", "--percent"];
    for (const args of [
      ...["", " ", " 96", "96\n", "1e2", "0x10", "96%", "NaN", "Infinity", "101"].map(value => [...base, value]),
      base, [...base, "96", "--fremd", "x"], [...base, "96", "--percent", "96"],
      [...base, "96", "--stdin"], ["set", "--stdin", "--stdin"], ["show", "--engine", "claude"], [], ["fremd"],
    ]) {
      const result = await run(args, undefined, { stdin: async () => { throw new Error("DARF NICHT LESEN"); } });
      expect(result.code).toBe(1);
      expect(result.err.join("\n")).not.toContain("DARF NICHT LESEN");
      expect(snapshot()).toEqual(before);
    }
  });
});
