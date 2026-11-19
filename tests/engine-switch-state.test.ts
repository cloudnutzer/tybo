import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../src/lib/atomic-file";
import { applyFailure, expireBlocks, syncAuto, type SwitchState } from "../src/lib/engine-switch";
import { ENGINE_IDS } from "../src/lib/engines/types";
import {
  onSwitchStateChanged, readSwitchHint, readSwitchState, rememberSwitchHint, resetSwitchStateForTests, setSwitchStateFileForTests, setSwitchStateWriterForTests, settleSwitchStateForTests, updateSwitchState,
} from "../src/lib/engine-switch-state";

let directory: string;
let file: string;
let warnings: ReturnType<typeof spyOn>;
const since = "2026-01-02T12:00:00.000Z";
const until = "2026-01-02T13:00:00.000Z";
const empty = (): SwitchState => ({ version: 1, blocks: [], counters: [] });
const failed = (state: SwitchState): SwitchState => applyFailure(state, {
  stage: { engine: "claude", model: "fable" }, kind: "limit",
}, Date.parse(since));
const writeState = (state: unknown) => writeFileSync(file, JSON.stringify(state));
const storedState = (): SwitchState => JSON.parse(readFileSync(file, "utf8"));

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "engine-switch-state-"));
  file = join(directory, "state.json");
  setSwitchStateFileForTests(file, 40);
  warnings = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setSwitchStateFileForTests(null);
  warnings.mockRestore();
  rmSync(directory, { recursive: true, force: true });
});

describe("Lesen und Formprüfung", () => {
  test("Meldungsfelder: gültige Teile bleiben, ungültige Einträge fallen einzeln weg", async () => {
    const pending = { id: "eins", text: "Meldung", createdAt: since, attempts: 0, nextAt: until, claimedAt: since };
    writeState({ ...empty(), notices: { announced: "claude:opus", left: { claude: "limit", codex: "falsch", fremd: "outage" },
      outageNoticeAt: { claude: since, codex: "gestern", fremd: since },
      pending: [pending, pending, { ...pending, id: "zwei", attempts: -1 }, { ...pending, id: "drei", claimedAt: "gestern" }],
      hinted: { "topic:1": { stage: "codex", at: since }, "topic:2": { stage: "claude", at: since, agent: "research" }, kaputt: { stage: "fremd", at: since } } } });
    const expected = { ...empty(), notices: { announced: "claude:opus", left: { claude: "limit" },
      outageNoticeAt: { claude: since }, pending: [pending], hinted: { "topic:1": { stage: "codex", at: since }, "topic:2": { stage: "claude", at: since, agent: "research" } } } };
    expect(readSwitchState()).toEqual(expected);
    expect((await updateSwitchState(state => state)).state).toEqual(expected);
    writeState({ ...empty(), notices: { announced: "fremd", left: [], outageNoticeAt: true, pending: false, hinted: null } });
    expect(readSwitchState()).toEqual({ ...empty(), notices: {} });
    writeState({ ...empty(), notices: null });
    expect(readSwitchState()).toEqual(empty());
  });

  test("Hinweise behalten höchstens die 500 jüngsten Gespräche", () => {
    const hinted = Object.fromEntries(Array.from({ length: 502 }, (_, i) => [String(i), { stage: "codex", at: new Date(Date.parse(since) + i).toISOString() }]));
    writeState({ ...empty(), notices: { announced: "none", hinted } });
    const notices = readSwitchState().notices!;
    expect(notices.announced).toBe("none");
    expect(Object.keys(notices.hinted!)).toHaveLength(500);
    expect(notices.hinted!['0']).toBeUndefined();
    expect(notices.hinted!['501']).toEqual(hinted['501']);
  });
  test("fehlende Datei: synchron leer, ohne Wurf, Ordner oder Logzeile", () => {
    setSwitchStateFileForTests(join(directory, "data", "state.json"));
    expect(readSwitchState()).toEqual(empty());
    expect(readdirSync(directory)).toEqual([]);
    expect(warnings).not.toHaveBeenCalled();
  });

  test.each(["", "kein JSON", "null", "[]", "{}", '{"version":2,"blocks":[],"counters":[]}'])
    ("kaputter Inhalt %j: leer, kein Wurf, ersetzt beim nächsten Schreiben", async raw => {
      writeFileSync(file, raw);
      expect(readSwitchState()).toEqual(empty());
      expect(readSwitchState()).toEqual(empty());
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(await updateSwitchState(failed)).toEqual({ state: failed(empty()), persisted: true });
      expect(storedState()).toEqual(failed(empty()));
      expect(existsSync(`${file}.lock`)).toBe(false);
    });

  test("einzelne ungültige Sperren und Zähler fallen weg, Zusatzfelder bleiben", async () => {
    const valid = failed(empty());
    const extensions = { pending: [{ engine: "claude", at: since }], delivered: [] };
    writeState({ ...valid, extensions,
      blocks: [null, { ...valid.blocks[0], engine: "falsch" }, ...valid.blocks],
      counters: [{ ...valid.counters[0], count: -1 }, ...valid.counters],
    });
    expect(readSwitchState()).toEqual({ ...valid, extensions });
    const result = await updateSwitchState(failed);
    expect(result.persisted).toBe(true);
    expect(storedState()).toEqual({ ...failed(valid), extensions });
  });

  test.each(["blocks", "counters"])("falsches Feld %s verwirft keine anderen Felder", field => {
    const valid = { ...failed(empty()), extensions: { pending: true } };
    writeState({ ...valid, [field]: "kaputt" });
    expect(readSwitchState()).toEqual({ ...valid, [field]: [] });
  });

  test("gültige released- und auto-Felder überstehen Lesen und Schreiben", async () => {
    const state = { ...empty(), released: { claude: since }, auto: { enabled: true, threshold: 95, returnBelow: 80 } };
    writeState(state);
    expect(readSwitchState()).toEqual(state);
    expect(await updateSwitchState(failed)).toEqual({ state: failed(state), persisted: true });
    expect(storedState()).toEqual(failed(state));
  });

  test.each([
    { released: "kaputt" }, { released: [] }, { released: { claude: "gestern" } }, { released: { fremd: since } },
    { auto: null }, { auto: { enabled: "ja", threshold: 95, returnBelow: 80 } },
    { auto: { enabled: true, threshold: 80, returnBelow: 80 } },
  ])("ungültige optionale Felder fallen weg: %j", invalid => {
    writeState({ ...empty(), ...invalid });
    expect(readSwitchState()).toEqual(empty());
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  test("auch Ergebnisse von mutate werden vor dem Schreiben geprüft", async () => {
    const valid = failed(empty());
    const result = await updateSwitchState(() => ({ ...valid,
      blocks: [...valid.blocks, { ...valid.blocks[0], until: "kaputt" }],
      counters: [...valid.counters, { ...valid.counters[0], kind: "kaputt" }],
      released: "kaputt", auto: { enabled: true, threshold: Infinity, returnBelow: 80 },
    } as unknown as SwitchState));
    expect(result).toEqual({ state: valid, persisted: true });
    expect(storedState()).toEqual(valid);
  });

  test("Sperren prüfen Motor, Ursache, ISO-Zeiten, Prozent, Fenster und höchstens eine Reichweite", () => {
    const { family: _family, ...base } = failed(empty()).blocks[0];
    const good = [
      ...ENGINE_IDS.map(engine => ({ ...base, engine })),
      ...["threshold", "limit", "outage"].map(cause => ({ ...base, cause })),
      ...["weekly_all", "session", "weekly_scoped:opus 5.5", "window_1440"].map(window => ({ ...base, window })),
      ...["fable", "opus", "sonnet", "haiku"].map(family => ({ ...base, family })),
      { ...base, model: "unbekanntes-modell", percent: 0 }, { ...base, percent: 100 },
      { ...base, since: "2026-01-02T13:00:00+01:00", until: "2026-01-02T14:00:00+01:00" },
    ];
    const bad = [
      null, [], {},
      ...[
        { engine: "falsch" }, { cause: "falsch" }, { resetKnown: 1 }, { resetKnown: null },
        { since: "2026-02-30T00:00:00Z" }, { since: "2026-01-02T12:00:00" }, { since: "2026-01-02" },
        { until: "gestern" }, { until: 1 }, { until: `${until}\n` },
        { percent: -1 }, { percent: 101 }, { percent: "95" }, { percent: null },
        { window: "weekly" }, { window: "window_0" }, { window: "weekly_scoped:" }, { window: null },
        { family: "falsch" }, { model: "" }, { model: "   " },
        { window: "weekly_all", family: "fable" }, { window: "session", model: "fable" },
        { family: "fable", model: "fable" },
      ].map(change => ({ ...base, ...change })),
    ];
    writeState({ ...empty(), blocks: [...bad, ...good] });
    expect(readSwitchState().blocks).toEqual(good);
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  test("Zähler prüfen Motor, Art, Reichweite, ganze nichtnegative Zahl und ISO-Zeit", () => {
    const base = failed(empty()).counters[0];
    const good = [...ENGINE_IDS.map(engine => ({ ...base, engine })),
      { ...base, kind: "outage", count: 0 }, { ...base, count: Number.MAX_SAFE_INTEGER }];
    const bad = [null, {}, ...[
      { engine: "falsch" }, { kind: "threshold" }, { scope: "" }, { scope: "  " },
      { count: -1 }, { count: 1.5 }, { count: "1" }, { count: Number.MAX_SAFE_INTEGER + 1 },
      { lastAt: "2026-02-30T00:00:00Z" }, { lastAt: "gestern" }, { lastAt: 1 },
    ].map(change => ({ ...base, ...change }))];
    writeState({ ...empty(), counters: [...bad, ...good] });
    expect(readSwitchState().counters).toEqual(good);
    expect(warnings).toHaveBeenCalledTimes(1);
  });
});

describe("Zuhörer für Sperränderungen", () => {
  test("Hinweis gilt sofort und bleibt beim Schreiben auf die 500 jüngsten Gespräche begrenzt", async () => {
    for (let i = 0; i < 501; i++) {
      const hint = { stage: "codex" as const, at: new Date(Date.parse(since) + i).toISOString() };
      rememberSwitchHint(`topic:${i}`, hint);
      expect(readSwitchHint(`topic:${i}`)).toEqual(hint);
    }
    await settleSwitchStateForTests();
    expect(Object.keys(readSwitchState().notices?.hinted ?? {})).toHaveLength(500);
    expect(readSwitchHint("topic:0")).toBeUndefined();
    expect(readSwitchHint("topic:500")?.stage).toBe("codex");
    rememberSwitchHint("topic:500", undefined);
    expect(readSwitchHint("topic:500")).toBeUndefined();
    await settleSwitchStateForTests();
    expect(readSwitchState().notices?.hinted?.["topic:500"]).toBeUndefined();
  });
  test("nur blocks, asynchron ohne Warten und abmeldbar", async () => {
    let calls = 0;
    const stop = onSwitchStateChanged(() => { calls++; return new Promise<void>(() => {}); });
    await updateSwitchState(state => ({ ...state, notices: { announced: "codex" } }));
    expect(calls).toBe(0);
    await updateSwitchState(failed);
    expect(calls).toBe(1);
    await updateSwitchState(state => state);
    expect(calls).toBe(1);
    stop();
    await updateSwitchState(failed);
    expect(calls).toBe(1);
  });

  test("auch beim Schreibfehler im Arbeitsspeicher; Zuhörerfehler bleibt im Log", async () => {
    let calls = 0;
    onSwitchStateChanged(() => { calls++; throw new Error("privater Text"); });
    setSwitchStateWriterForTests(async () => { throw new Error("nicht schreibbar"); });
    expect((await updateSwitchState(failed)).persisted).toBe(false);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(warnings).toHaveBeenCalled();
    expect(JSON.stringify(warnings.mock.calls)).not.toContain("privater Text");
  });

  test("Zuhörerfehler nach erfolgreicher Ablage wird protokolliert", async () => {
    onSwitchStateChanged(async () => { throw new Error("privater Text"); });
    await updateSwitchState(failed);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(warnings).toHaveBeenCalledWith("[EngineSwitchState] Zuhörer für Sperränderungen fehlgeschlagen.");
  });
});

describe("Schreiben unter der Sperre", () => {
  test("neuer Ordner entsteht vor der Sperre, atomare Datei hat Rechte 0600", async () => {
    file = join(directory, "data", "state.json");
    setSwitchStateFileForTests(file);
    expect(await updateSwitchState(failed)).toEqual({ state: failed(empty()), persisted: true });
    expect(readdirSync(join(directory, "data"))).toEqual(["state.json"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("gleichzeitige Änderungen im Prozess werden frisch gelesen und verlieren nichts", async () => {
    const results = await Promise.all([updateSwitchState(failed), updateSwitchState(failed)]);
    expect(results).toEqual([
      { state: failed(empty()), persisted: true }, { state: failed(failed(empty())), persisted: true },
    ]);
    expect(storedState()).toEqual(failed(failed(empty())));
  });

  test("Änderung ohne Wirkung lässt Änderungszeit und Inode unberührt", async () => {
    writeState(failed(empty()));
    utimesSync(file, new Date(since), new Date(since));
    const before = statSync(file);
    const result = await updateSwitchState(state => expireBlocks(state, Date.parse(since)));
    expect(result).toEqual({ state: failed(empty()), persisted: true });
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(file).ino).toBe(before.ino);
  });

  test("Änderung ohne Wirkung bei fehlender Datei: persisted wahr, keine Datei", async () => {
    expect(await updateSwitchState(state => ({ ...state }))).toEqual({ state: empty(), persisted: true });
    expect(readdirSync(directory)).toEqual([]);
  });

  test("werfende Regel entfällt, gibt Sperre frei und hält die Kette nicht auf", async () => {
    writeState(failed(empty()));
    const results = await Promise.all([
      updateSwitchState(state => syncAuto(state, { enabled: true, threshold: 80, returnBelow: 80 },
        { claude: [], codex: [], opencode: [], api: [] }, Date.parse(since))),
      updateSwitchState(failed),
    ]);
    expect(results).toEqual([
      { state: failed(empty()), persisted: true }, { state: failed(failed(empty())), persisted: true },
    ]);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  test("Schlüsselreihenfolge und neue Objektkopien allein schreiben nichts", async () => {
    writeState({ ...empty(), extensions: { first: 1, second: 2 } });
    const before = statSync(file);
    expect((await updateSwitchState(state => ({ ...state, extensions: { second: 2, first: 1 } }))).persisted).toBe(true);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(file).ino).toBe(before.ino);
  });

  test("nicht als JSON ablegbare Ergebnisse und Änderung vor einem Wurf verderben den Zustand nicht", async () => {
    writeState(failed(empty()));
    const changes = [
      (state: SwitchState) => ({ ...state, invalid: 1n }),
      (state: SwitchState) => { const cycle: Record<string, unknown> = {}; cycle.self = cycle; return { ...state, cycle }; },
      (state: SwitchState) => { (state.blocks as unknown[]).splice(0); throw new Error("nach Änderung geworfen"); },
    ];
    const before = statSync(file);
    for (const change of changes) {
      expect(await updateSwitchState(change)).toEqual({ state: failed(empty()), persisted: true });
      expect(readSwitchState()).toEqual(failed(empty()));
      expect(existsSync(`${file}.lock`)).toBe(false);
    }
    expect(statSync(file).ino).toBe(before.ino);
  });
});

describe("Zwischenspeicher", () => {
  test("nachgestellter Neustart holt Sperren und Zähler aus der Datei", async () => {
    await updateSwitchState(failed);
    resetSwitchStateForTests();
    expect(readSwitchState()).toEqual(failed(empty()));
  });

  test("externer atomarer Ersatz wird beim nächsten Lesen erkannt", async () => {
    writeState(failed(empty()));
    expect(readSwitchState()).toEqual(failed(empty()));
    await atomicWriteFile(file, JSON.stringify({ ...empty(), extensions: { checkedAt: until } }));
    utimesSync(file, new Date(until), new Date(until));
    expect(readSwitchState()).toEqual({ ...empty(), extensions: { checkedAt: until } });
  });

  test("von außen gelöschte Datei ergibt leer statt altem Cache", () => {
    writeState(failed(empty()));
    expect(readSwitchState()).toEqual(failed(empty()));
    rmSync(file);
    expect(readSwitchState()).toEqual(empty());
  });

  test("Lesefehler behält bekannten Zustand statt ihn als leer zu behandeln", () => {
    writeState(failed(empty()));
    expect(readSwitchState()).toEqual(failed(empty()));
    rmSync(file);
    mkdirSync(file);
    expect(readSwitchState()).toEqual(failed(empty()));
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  test.each(["Änderungszeit", "Größe", "Inode"])("externe Änderung nur über %s erkannt", async criterion => {
    writeState({ ...empty(), value: 1 });
    utimesSync(file, new Date(since), new Date(since));
    expect(readSwitchState().value).toBe(1);
    const before = statSync(file);
    const value = criterion === "Größe" ? 12345 : 2;
    const next = { ...empty(), value };
    if (criterion === "Inode") await atomicWriteFile(file, JSON.stringify(next));
    else writeState(next);
    utimesSync(file, new Date(since), new Date(criterion === "Änderungszeit" ? until : since));
    const after = statSync(file);
    if (criterion !== "Änderungszeit") expect(after.mtimeMs).toBe(before.mtimeMs);
    if (criterion !== "Größe") expect(after.size).toBe(before.size);
    if (criterion !== "Inode") expect(after.ino).toBe(before.ino);
    expect(readSwitchState()).toEqual(next);
  });

  test("Rückgabewerte sind Kopien, auch während eine Änderung offen ist", async () => {
    writeFileSync(`${file}.lock`, "belegt");
    const result = await updateSwitchState(state => ({ ...failed(state), extensions: { text: "ursprünglich" } }));
    const expected = structuredClone(result.state);
    (result.state.blocks as unknown[]).splice(0);
    (result.state.extensions as { text: string }).text = "von außen geändert";
    const read = readSwitchState();
    (read.counters as unknown[]).splice(0);
    expect(readSwitchState()).toEqual(expected);
    rmSync(`${file}.lock`);
    expect(await updateSwitchState(state => state)).toEqual({ state: expected, persisted: true });
  });

  test("Standardpfad folgt dem aktuellen Arbeitsordner und übernimmt keinen fremden Cache", async () => {
    const previous = process.cwd();
    const previousFile = process.env.ENGINE_SWITCH_FILE_PATH;
    const second = join(directory, "zweiter-ordner");
    mkdirSync(second);
    setSwitchStateFileForTests(null);
    try {
      delete process.env.ENGINE_SWITCH_FILE_PATH;
      process.chdir(directory);
      expect(readSwitchState()).toEqual(empty());
      expect(existsSync(join(directory, "data"))).toBe(false);
      await updateSwitchState(failed);
      expect(JSON.parse(readFileSync(join(directory, "data", "engine-switch.json"), "utf8"))).toEqual(failed(empty()));
      process.chdir(second);
      expect(readSwitchState()).toEqual(empty());
      expect(existsSync(join(second, "data"))).toBe(false);
      process.chdir(directory);
      expect(readSwitchState()).toEqual(failed(empty()));
    } finally {
      process.chdir(previous);
      if (previousFile === undefined) delete process.env.ENGINE_SWITCH_FILE_PATH;
      else process.env.ENGINE_SWITCH_FILE_PATH = previousFile;
    }
  });
});

describe("Fehlerfall und Nachholen", () => {
  for (const [label, owner] of [
    ["lebender fremder Besitzer", JSON.stringify({ pid: process.pid, token: "fremder-testbesitzer" })],
    ["unlesbare Sperrdatei", "kein lesbarer Besitzer"],
  ]) {
    test(`Sperre belegt (${label}): begrenztes Warten, Speicher gilt, nach Freigabe beide Änderungen`, async () => {
      writeState(empty());
      writeFileSync(`${file}.lock`, owner);
      const started = performance.now();
      expect(await updateSwitchState(failed)).toEqual({ state: failed(empty()), persisted: false });
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(readSwitchState()).toEqual(failed(empty()));
      expect(storedState()).toEqual(empty());
      expect(readFileSync(`${file}.lock`, "utf8")).toBe(owner);
      rmSync(`${file}.lock`);
      expect(await updateSwitchState(failed)).toEqual({ state: failed(failed(empty())), persisted: true });
      expect(storedState()).toEqual(failed(failed(empty())));
      expect(existsSync(`${file}.lock`)).toBe(false);
      expect(warnings).toHaveBeenCalledTimes(1);
    });
  }

  test("acht gleichzeitige Änderungen warten während der Sperrfrist nur einmal", async () => {
    setSwitchStateFileForTests(file, 200);
    writeFileSync(`${file}.lock`, "unlesbar");
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: 8 }, () => updateSwitchState(failed)));
    // Ohne Sperrfrist wären es mindestens 1.600 ms; Reserve für parallele CI-Last.
    expect(performance.now() - started).toBeLessThan(1_200);
    expect(results.map(result => result.persisted)).toEqual(Array(8).fill(false));
    expect(results.map(result => result.state.counters[0].count)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(readSwitchState().counters[0].count).toBe(8);
    rmSync(`${file}.lock`);
    const result = await updateSwitchState(state => state);
    expect(result.persisted).toBe(true);
    expect(storedState().counters[0].count).toBe(8);
  });

  test("Wartezeit ist auch mit größerem Testwert auf zwei Sekunden gedeckelt", async () => {
    setSwitchStateFileForTests(file, 20_000);
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, token: "fremder-testbesitzer" }));
    const started = performance.now();
    expect((await updateSwitchState(failed)).persisted).toBe(false);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(readSwitchState()).toEqual(failed(empty()));
  });

  test("nach 30 Sekunden darf wieder auf eine bald frei werdende Sperre gewartet werden", async () => {
    setSwitchStateFileForTests(file, 200);
    writeFileSync(`${file}.lock`, "belegt");
    await updateSwitchState(failed);
    const originalNow = Date.now;
    const clock = spyOn(Date, "now").mockImplementation(() => originalNow() + 30_001);
    const released = new Promise<void>(resolve => setTimeout(() => { rmSync(`${file}.lock`); resolve(); }, 50));
    try {
      expect(await updateSwitchState(failed)).toEqual({ state: failed(failed(empty())), persisted: true });
    } finally {
      await released;
      clock.mockRestore();
    }
  });

  test("Speicher bleibt vor externer Änderung geschützt; Nachholen nutzt frische Datei und Reihenfolge", async () => {
    writeState({ ...empty(), value: 2 });
    readSwitchState();
    writeFileSync(`${file}.lock`, "belegt");
    await updateSwitchState(state => ({ ...state, value: Number(state.value) + 1 }));
    await updateSwitchState(state => ({ ...state, value: Number(state.value) * 10 }));
    expect(readSwitchState().value).toBe(30);
    await atomicWriteFile(file, JSON.stringify({ ...empty(), value: 4, extensions: { external: true } }));
    expect(readSwitchState().value).toBe(30);
    expect(readSwitchState()).not.toHaveProperty("extensions");
    rmSync(`${file}.lock`);
    const result = await updateSwitchState(state => ({ ...state, value: Number(state.value) + 100 }));
    expect(result).toEqual({ state: { ...empty(), value: 150, extensions: { external: true } }, persisted: true });
    expect(storedState()).toEqual(result.state);
  });

  test("expireBlocks ohne neue Wirkung holt eine offene Änderung trotzdem nach", async () => {
    writeFileSync(`${file}.lock`, "belegt");
    await updateSwitchState(failed);
    expect(readSwitchState()).toEqual(failed(empty()));
    rmSync(`${file}.lock`);
    const result = await updateSwitchState(state => expireBlocks(state, Date.parse(since)));
    expect(result).toEqual({ state: failed(empty()), persisted: true });
    expect(storedState()).toEqual(failed(empty()));
  });

  test("persisted bei Leerlauf: unter belegter Sperre falsch, nach Abgleich wahr ohne Datei", async () => {
    writeFileSync(`${file}.lock`, "belegt");
    expect(await updateSwitchState(state => state)).toEqual({ state: empty(), persisted: false });
    expect(readSwitchState()).toEqual(empty());
    rmSync(`${file}.lock`);
    expect(await updateSwitchState(state => state)).toEqual({ state: empty(), persisted: true });
    expect(readdirSync(directory)).toEqual([]);
  });

  test("sich aufhebende offene Änderungen brauchen nach Abgleich keinen Schreibzugriff", async () => {
    writeState({ ...empty(), value: 0 });
    readSwitchState();
    const before = statSync(file);
    writeFileSync(`${file}.lock`, "belegt");
    await updateSwitchState(state => ({ ...state, value: Number(state.value) + 1 }));
    await updateSwitchState(state => ({ ...state, value: Number(state.value) - 1 }));
    rmSync(`${file}.lock`);
    setSwitchStateWriterForTests(() => { throw new Error("darf nicht schreiben"); });
    expect(await updateSwitchState(state => state)).toEqual({ state: { ...empty(), value: 0 }, persisted: true });
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(file).ino).toBe(before.ino);
  });

  test("Löschen von außen verwirft offene Änderungen nicht; nach Neustart sind sie verloren", async () => {
    writeState(failed(empty()));
    readSwitchState();
    writeFileSync(`${file}.lock`, "belegt");
    await updateSwitchState(failed);
    rmSync(file);
    expect(readSwitchState()).toEqual(failed(failed(empty())));
    resetSwitchStateForTests();
    expect(readSwitchState()).toEqual(empty());
    rmSync(`${file}.lock`);
    expect(await updateSwitchState(state => state)).toEqual({ state: empty(), persisted: true });
    expect(existsSync(file)).toBe(false);
  });

  test("Sperre nicht anlegbar: Datei als Elternordner, kein Wurf, später nachgeholt", async () => {
    const parent = join(directory, "data");
    writeFileSync(parent, "kein Ordner");
    file = join(parent, "state.json");
    setSwitchStateFileForTests(file, 40);
    expect(await updateSwitchState(failed)).toEqual({ state: failed(empty()), persisted: false });
    expect(readSwitchState()).toEqual(failed(empty()));
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(readdirSync(directory)).toEqual(["data"]);
    expect(warnings).toHaveBeenCalledTimes(1);
    rmSync(parent);
    expect(await updateSwitchState(failed)).toEqual({ state: failed(failed(empty())), persisted: true });
    expect(storedState()).toEqual(failed(failed(empty())));
    expect(readdirSync(parent)).toEqual(["state.json"]);
  });

  test("Schreibfunktion wirft unter erworbener Sperre: Speicher, Log ohne Inhalt, Freigabe und Nachholen", async () => {
    let writes = 0;
    let ownedLock = false;
    setSwitchStateWriterForTests(() => {
      writes++;
      ownedLock = JSON.parse(readFileSync(`${file}.lock`, "utf8")).pid === process.pid;
      throw new Error("privater Fehlerinhalt");
    });
    const change = (state: SwitchState): SwitchState => ({ ...failed(state), extensions: { text: "privater Zustandsinhalt" } });
    expect(await updateSwitchState(change)).toEqual({ state: change(empty()), persisted: false });
    expect(writes).toBe(1);
    expect(ownedLock).toBe(true);
    expect(readSwitchState()).toEqual(change(empty()));
    expect(readdirSync(directory)).toEqual([]);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain("privater");
    setSwitchStateWriterForTests(null);
    expect(await updateSwitchState(failed)).toEqual({ state: failed(change(empty())), persisted: true });
    expect(storedState()).toEqual(failed(change(empty())));
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  test("mehrere Schreibfehler: jede Änderung wird genau einmal auf den fremden Stand nachgeholt", async () => {
    setSwitchStateWriterForTests(async () => { throw new Error("Schreiben fehlgeschlagen"); });
    await updateSwitchState(failed);
    await updateSwitchState(failed);
    expect(readSwitchState()).toEqual(failed(failed(empty())));
    expect(readdirSync(directory)).toEqual([]);
    const external = { ...failed(failed(failed(empty()))), extensions: { external: true } };
    writeState(external);
    expect(readSwitchState()).toEqual(failed(failed(empty())));
    setSwitchStateWriterForTests(null);
    expect(await updateSwitchState(failed)).toEqual({ state: failed(failed(failed(external))), persisted: true });
    expect(storedState()).toEqual(failed(failed(failed(external))));
  });

  test("Lesefehler unter Sperre: letzter Speicherstand gilt, keine Reste, nächste Änderung holt nach", async () => {
    writeState(failed(empty()));
    readSwitchState();
    rmSync(file);
    mkdirSync(file);
    expect(await updateSwitchState(failed)).toEqual({ state: failed(failed(empty())), persisted: false });
    expect(readSwitchState()).toEqual(failed(failed(empty())));
    expect(existsSync(`${file}.lock`)).toBe(false);
    rmSync(file, { recursive: true });
    writeState(failed(empty()));
    expect(await updateSwitchState(failed)).toEqual({ state: failed(failed(failed(empty()))), persisted: true });
    expect(storedState()).toEqual(failed(failed(failed(empty()))));
  });

  test("werfendes mutate beim Rückfall entfällt, vorhandene offene Änderungen bleiben", async () => {
    writeFileSync(`${file}.lock`, "belegt");
    await updateSwitchState(failed);
    expect(await updateSwitchState(() => { throw new RangeError("ungültige Regel"); }))
      .toEqual({ state: failed(empty()), persisted: false });
    rmSync(`${file}.lock`);
    expect(await updateSwitchState(failed)).toEqual({ state: failed(failed(empty())), persisted: true });
    expect(storedState()).toEqual(failed(failed(empty())));
  });

  test("werfende offene Änderung wird beim Nachholen übersprungen, übrige und neue laufen", async () => {
    writeFileSync(`${file}.lock`, "belegt");
    await updateSwitchState(state => {
      if (state.rejectReplay) throw new RangeError("auf diesem Stand ungültig");
      return failed(state);
    });
    await updateSwitchState(failed);
    expect(readSwitchState()).toEqual(failed(failed(empty())));
    writeState({ ...empty(), rejectReplay: true });
    rmSync(`${file}.lock`);
    const expected = { ...failed(failed(empty())), rejectReplay: true };
    expect(await updateSwitchState(failed)).toEqual({ state: expected, persisted: true });
    expect(storedState()).toEqual(expected);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  test("mehr als 128 offene Änderungen werden begrenzt, Speicherstand ersetzt die Datei", async () => {
    setSwitchStateFileForTests(file, 0);
    writeFileSync(`${file}.lock`, "belegt");
    for (let index = 0; index < 130; index++) {
      expect((await updateSwitchState(state => ({ ...state, value: Number(state.value ?? 0) + 1 }))).persisted).toBe(false);
    }
    expect(readSwitchState().value).toBe(130);
    writeState({ ...empty(), value: 1_000, external: true });
    rmSync(`${file}.lock`);
    const result = await updateSwitchState(state => ({ ...state, value: Number(state.value) * 2 }));
    expect(result).toEqual({ state: { ...empty(), value: 260 }, persisted: true });
    expect(storedState()).toEqual(result.state);
  });

  test("Log-Takt gilt gemeinsam für kaputten Inhalt, werfende Änderung und Schreibfehler", async () => {
    const originalNow = Date.now;
    let elapsed = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => originalNow() + elapsed);
    try {
      writeFileSync(file, "kaputt");
      readSwitchState();
      await updateSwitchState(() => { throw new Error("privater Fehlerinhalt"); });
      setSwitchStateWriterForTests(() => { throw new Error("privater Fehlerinhalt"); });
      await updateSwitchState(failed);
      expect(warnings).toHaveBeenCalledTimes(1);
      elapsed = 60_001;
      await updateSwitchState(failed);
      expect(warnings).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warnings.mock.calls)).not.toContain("privater");
      resetSwitchStateForTests();
      readSwitchState();
      expect(warnings).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
    }
  });

  test("selbst eine werfende Logfunktion beendet weder Lesen noch die Schreibkette", async () => {
    warnings.mockImplementation(() => { throw new Error("Log kaputt"); });
    writeFileSync(file, "kaputt");
    expect(readSwitchState()).toEqual(empty());
    expect(await updateSwitchState(failed)).toEqual({ state: failed(empty()), persisted: true });
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
});
