import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSwitchNotices, flushSwitchNotices, startSwitchWatch, SWITCH_WATCH_MS, resetSwitchNotifyForTests, setSwitchNotifier, settleSwitchNoticesForTests, type SwitchNotifyDeps, type SwitchStatuses } from "../src/lib/engine-switch-notify";
import { readSwitchState, resetSwitchStateForTests, setSwitchStateFileForTests, setSwitchStateWriterForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import type { Settings } from "../src/lib/settings";
import type { UserDelivery, UserNotice } from "../src/lib/user-notify";
import { resolveEngine } from "../src/lib/engine-choice";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  limitSwitchNotice, noFreeSwitchNotice, outageSwitchNotice, returnSwitchNotice,
  switchWindowLabel, thresholdSwitchNotice,
} from "../src/lib/engine-switch-notify";
import type { Stage, SwitchBlock } from "../src/lib/engine-switch";
import { CLAUDE_NOT_INSTALLED, CODEX_NOT_INSTALLED } from "../src/lib/engines/check";
import { OPENCODE_NOT_INSTALLED } from "../src/lib/engines/opencode";

const claude: Stage = { engine: "claude" };
const codex: Stage = { engine: "codex" };
const block: SwitchBlock = { engine: "claude", cause: "threshold", window: "weekly_all",
  since: "2026-11-22T14:00:00Z", until: "2026-11-22T15:00:00Z", resetKnown: true, percent: 95.4 };
const zone = "Europe/Berlin";

describe("Wortlaute zum Motorwechsel", () => {
  test("Schwelle, gerundeter Prozentwert und Profilzeitzone", () => {
    expect(thresholdSwitchNotice(claude, codex, block, zone)).toBe("Motorwechsel: Claude Code steht bei 95 % (Woche, alle Modelle). Ab der nächsten Nachricht antwortet Codex. Zurück geht es von selbst nach dem Reset am So, 22.11., 16:00 Uhr. Stand und Wahl: /motor");
  });
  test("Limit mit Fenster und Claude-Ersatzstufe aus stageLabel", () => {
    expect(limitSwitchNotice(claude, { engine: "claude", model: "opus" }, { ...block, cause: "limit" }, zone)).toBe("Motorwechsel: Claude Code hat das Limit erreicht (Woche, alle Modelle). Ab sofort antwortet Claude Code mit opus. Zurück geht es von selbst ab So, 22.11., 16:00 Uhr. Stand und Wahl: /motor");
  });
  test("Familienpause ohne Fenster und unbekannter Reset", () => {
    const pause: SwitchBlock = { engine: "claude", cause: "limit", family: "fable", since: block.since, until: block.until, resetKnown: false };
    expect(limitSwitchNotice(claude, codex, pause, zone)).toBe("Motorwechsel: Claude Code hat das Limit erreicht. Ab sofort antwortet Codex. Ich versuche es um 16:00 Uhr wieder. Stand und Wahl: /motor");
    expect(thresholdSwitchNotice(claude, codex, { ...block, percent: undefined, resetKnown: false }, "UTC")).toBe("Motorwechsel: Claude Code hat die Schwelle erreicht (Woche, alle Modelle). Ab der nächsten Nachricht antwortet Codex. Ich versuche es um 15:00 Uhr wieder. Stand und Wahl: /motor");
  });
  test("Rückwechsel", () => {
    expect(returnSwitchNotice(claude)).toBe("Motorwechsel: Claude Code ist wieder frei. Ab der nächsten Nachricht antwortet wieder Claude Code.");
  });
  test("Ausfall unterscheidet belegte Nichtinstallation, Anmeldung und vorübergehenden Fehler", () => {
    for (const message of [CLAUDE_NOT_INSTALLED, CODEX_NOT_INSTALLED, OPENCODE_NOT_INSTALLED]) {
      expect(outageSwitchNotice(claude, codex, { engine: "claude", checked: true, installed: false, loggedIn: false, message })).toBe("Claude Code antwortet gerade nicht (nicht installiert). Codex springt ein.");
    }
    expect(outageSwitchNotice(claude, codex, { engine: "claude", checked: true, installed: true, loggedIn: false })).toBe("Claude Code antwortet gerade nicht (nicht angemeldet). Codex springt ein.");
    for (const status of [undefined, { engine: "claude" as const, checked: true, installed: false, loggedIn: false, message: "Zeitlimit" }, { engine: "claude" as const, checked: true, installed: true, loggedIn: false, loginUnknown: true }]) {
      expect(outageSwitchNotice(claude, codex, status)).toBe("Claude Code antwortet gerade nicht (Fehler beim letzten Lauf). Codex springt ein.");
    }
  });
  test("Keine Stufe frei, mit und ohne bekannte Freigabe", () => {
    expect(noFreeSwitchNotice(block.until, zone)).toBe("Alle Motoren sind am Limit oder nicht bereit. Bis So, 22.11., 16:00 Uhr antworten Ersatzmodelle mit eingeschränktem Werkzeugumfang.");
    expect(noFreeSwitchNotice(undefined, zone)).toBe("Alle Motoren sind am Limit oder nicht bereit. Es antworten Ersatzmodelle mit eingeschränktem Werkzeugumfang.");
  });
  test("Fensternamen", () => {
    expect(["weekly_all", "weekly_scoped:fable", "session", "window_300", "window_180", "window_90", "window_4320", "window_150", "window_60", "window_1"].map(w => switchWindowLabel(w as "session")))
      .toEqual(["Woche, alle Modelle", "Woche, Fable", "5 Stunden", "Fenster, 5 Stunden", "Fenster, 3 Stunden", "Fenster, 90 Minuten", "Fenster, 3 Tage", "Fenster, 2,5 Stunden", "Fenster, 60 Minuten", "Fenster, 1 Minute"]);
  });
  test("Texte ohne Gedankenstriche, Emojis und falsche Werkzeugaussage", () => {
    const texts = [thresholdSwitchNotice(claude, codex, block, zone), limitSwitchNotice(claude, codex, block, zone),
      returnSwitchNotice(claude), outageSwitchNotice(claude, codex), noFreeSwitchNotice(block.until, zone), noFreeSwitchNotice(undefined, zone)];
    for (const text of texts) expect(text).not.toMatch(/[—–]|\p{Extended_Pictographic}|ohne Werkzeuge/u);
  });
});


let dir: string;
let file: string;
let now: number;
let settings: Settings;
let statuses: SwitchStatuses;
let deps: Partial<SwitchNotifyDeps>;
let timers: Map<number, { run: () => void; at: number }>;
let timerId: number;
let deliveries: { text: string; target?: UserNotice }[];
let outcomes: UserDelivery["outcome"][];
let logs: string[];
const pending = () => readSwitchState().notices?.pending ?? [];
beforeEach(() => {
  resetSwitchNotifyForTests();
  dir = mkdtempSync(join(tmpdir(), "switch-notify-"));
  file = join(dir, "switch.json");
  setSwitchStateFileForTests(file, 0);
  now = Date.parse(block.since);
  timers = new Map(); timerId = 0; deliveries = []; outcomes = []; logs = [];
  settings = { defaults: { model: "fable" }, engine: { backups: [codex] } } as Settings;
  statuses = Object.fromEntries(["claude", "codex", "opencode", "api"].map(engine => [engine, { engine, checked: true, installed: true, loggedIn: true }]));
  deps = { getSettings: () => settings, env: () => ({ USER_TIMEZONE: zone }), now: () => now,
    checkEngine: async engine => statuses[engine]!, log: line => { logs.push(line); },
    setTimer: (run, ms) => { timers.set(++timerId, { run, at: now + ms }); return timerId; },
    clearTimer: id => { timers.delete(id as number); } };
});
afterEach(async () => {
  await settleSwitchNoticesForTests();
  resetSwitchNotifyForTests();
  setSwitchStateFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});
const check = () => checkSwitchNotices(undefined, deps);
const blockClaude = async (cause: SwitchBlock["cause"] = "threshold") => updateSwitchState(state => ({ ...state, blocks: [{ ...block, cause }] }));
const deliver = async (text: string, target?: UserNotice): Promise<UserDelivery> => {
  deliveries.push({ text, target });
  const outcome = outcomes.shift() ?? "delivered";
  return { outcome, delivered: outcome === "delivered", telegram: [] };
};
const connect = () => setSwitchNotifier(deliver, deps);
async function advance(ms: number) {
  now += ms;
  for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
  await settleSwitchNoticesForTests();
}

describe("Wechsel merken", () => {
  test("resolveEngine reicht nur Bereitschaft weiter: Gesprächswunsch, Agenten-Modell und tried ändern announced nicht", async () => {
    settings.agents = { research: { model: "opus" } };
    settings.engine!.topics = { "topic:codex": "codex" };
    const choiceDeps = { ...deps, readUsage: async () => ({ claude: [], codex: [], opencode: [], api: [] }), checkSwitch: checkSwitchNotices };
    await resolveEngine("topic:codex", choiceDeps, { agentName: "research" });
    await settleSwitchNoticesForTests();
    expect(pending()).toHaveLength(0);
    await updateSwitchState(state => ({ ...state, blocks: [{ ...block, window: "weekly_scoped:fable" }] }));
    const ownModel = await resolveEngine("topic:research", choiceDeps, { agentName: "research" });
    expect(ownModel).toMatchObject({ kind: "stage", engine: "claude", model: "opus" });
    await settleSwitchNoticesForTests();
    expect(readSwitchState().notices?.announced).toBe("codex");
    await resolveEngine("topic:codex", choiceDeps, { agentName: "general", tried: [codex] });
    await settleSwitchNoticesForTests();
    expect(readSwitchState().notices?.announced).toBe("codex");
    expect(pending()).toHaveLength(1);
  });
  test("zwei gleichzeitige Prüfungen legen genau eine Meldung ab, Leerlauf schreibt nichts", async () => {
    await blockClaude();
    await Promise.all([check(), check()]);
    expect(pending()).toHaveLength(1);
    expect(pending()[0].text).toBe(thresholdSwitchNotice(claude, codex, block, zone));
    const before = statSync(file);
    await check();
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(file).ino).toBe(before.ino);
  });
  test.each(["threshold", "limit"] as const)("Rückwechsel nach %s, auch aus none", async cause => {
    await blockClaude(cause);
    await check();
    expect(readSwitchState().notices?.left?.claude).toBe(cause);
    await updateSwitchState(state => ({ ...state, blocks: [] }));
    await check();
    expect(pending().map(p => p.text)).toEqual([cause === "threshold" ? thresholdSwitchNotice(claude, codex, block, zone) : limitSwitchNotice(claude, codex, block, zone), returnSwitchNotice(claude)]);
    await blockClaude(cause);
    statuses.codex!.loggedIn = false;
    await check();
    expect(readSwitchState().notices?.announced).toBe("none");
    await updateSwitchState(state => ({ ...state, blocks: [] }));
    await check();
    expect(pending().at(-1)?.text).toBe(returnSwitchNotice(claude));
  });
  test("keine Stufe frei mit und ohne Freigabezeit", async () => {
    await blockClaude();
    statuses.codex!.loggedIn = false;
    await check();
    expect(pending()[0].text).toBe(noFreeSwitchNotice(block.until, zone));
    await updateSwitchState(state => ({ ...state, blocks: [], notices: undefined }));
    statuses.claude!.loggedIn = false;
    await check();
    expect(pending()[0].text).toBe(noFreeSwitchNotice(undefined, zone));
  });
  test("Ausfall, stille Rückkehr und zweiter Ausfall erst nach 60 Minuten", async () => {
    await blockClaude("outage");
    await check();
    now += 10 * 60_000;
    await updateSwitchState(state => ({ ...state, blocks: [] }));
    await check();
    expect(readSwitchState().notices?.announced).toBe("claude");
    await blockClaude("outage");
    await check();
    expect(pending()).toHaveLength(1);
    expect(readSwitchState().notices?.announced).toBe("codex");
    expect(readSwitchState().notices?.left?.claude).toBe("outage");
    await updateSwitchState(state => ({ ...state, blocks: [] }));
    await check();
    now += 50 * 60_000;
    statuses.claude!.installed = false;
    await check();
    expect(pending()).toHaveLength(2);
  });
  test("unbekannte alte Stufe und geänderte Reihenfolge werden still nachgeführt", async () => {
    await updateSwitchState(state => ({ ...state, notices: { announced: "opencode" } }));
    await check();
    expect(readSwitchState().notices?.announced).toBe("claude");
    expect(pending()).toHaveLength(0);
    settings.engine = { default: "codex", backups: [claude] };
    await check();
    expect(readSwitchState().notices?.announced).toBe("codex");
    expect(pending()).toHaveLength(0);
  });
  test("nur allgemeine Reihenfolge und Modell des General-Agenten, Claude loginUnknown ist bereit", async () => {
    settings.engine!.topics = { "topic:1": "codex" };
    statuses.claude = { ...statuses.claude!, loggedIn: false, loginUnknown: true };
    await check();
    expect(readSwitchState().notices).toBeUndefined();
    await updateSwitchState(state => ({ ...state, blocks: [{ ...block, window: "weekly_scoped:fable" }] }));
    await check();
    expect(pending()).toHaveLength(1);
    expect(readSwitchState().notices?.announced).toBe("codex");
  });
  test("werfende Prüfung gilt als nicht bereit, mit vorsichtigem Fehlergrund", async () => {
    deps.checkEngine = async engine => { if (engine === "claude") throw new Error("privater Fehler"); return statuses[engine]!; };
    await check();
    expect(pending()[0].text).toBe(outageSwitchNotice(claude, codex));
  });
  test("Vergleich-und-Setzen überschreibt kein inzwischen geändertes announced", async () => {
    await blockClaude();
    deps.updateSwitchState = async mutate => {
      await updateSwitchState(state => ({ ...state, notices: { announced: "none" } }));
      return updateSwitchState(mutate);
    };
    await check();
    expect(readSwitchState().notices?.announced).toBe("none");
    expect(pending()).toHaveLength(0);
  });
  test("ohne Ersatzstufen keine Datei; reines Einbinden und Sperren schreiben legt keine Meldung ab", async () => {
    settings = {};
    await check();
    expect(readSwitchState()).toEqual({ version: 1, blocks: [], counters: [] });
    settings = { engine: { backups: [{ engine: "codex" }] } };
    await blockClaude();
    expect(readSwitchState().notices).toBeUndefined();
  });
});

describe("Gespeicherte Zustellung", () => {
  test("späte Antwort eines verwaisten Anspruchs überschreibt keinen neueren Versuch", async () => {
    let finishOld!: (result: UserDelivery) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    let calls = 0;
    outcomes = ["rejected"];
    setSwitchNotifier(async (text, target) => {
      if (++calls === 1) return new Promise(resolve => { finishOld = resolve; began(); });
      return deliver(text, target);
    }, deps);
    await blockClaude(); await check();
    await started;
    now += 120_001;
    await flushSwitchNotices(deps);
    expect(calls).toBe(2);
    expect(pending()[0].attempts).toBe(1);
    finishOld({ outcome: "delivered", delivered: true, telegram: [] });
    await updateSwitchState(state => state);
    await settleSwitchNoticesForTests();
    expect(pending()).toHaveLength(1);
    await advance(60_000);
    expect(pending()).toHaveLength(0);
  });
  test("beim Abschalten kein neuer Zeitgeber nach einem späten Zustellergebnis", async () => {
    let finish!: (result: UserDelivery) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    setSwitchNotifier(async () => new Promise(resolve => { finish = resolve; began(); }), deps);
    await blockClaude(); await check(); await started;
    setSwitchNotifier(null);
    finish({ outcome: "rejected", delivered: false, telegram: [] });
    await settleSwitchNoticesForTests();
    expect(pending()).toHaveLength(1);
    expect(timers.size).toBe(0);
  });
  test("zwei gleichzeitige Prüfungen senden einmal als plain und entfernen die Meldung", async () => {
    connect();
    await blockClaude();
    await Promise.all([check(), check()]);
    await settleSwitchNoticesForTests();
    expect(deliveries).toEqual([{ text: thresholdSwitchNotice(claude, codex, block, zone), target: { format: "plain" } }]);
    expect(pending()).toHaveLength(0);
  });
  test.each(["rejected", "unclear"] as const)("%s: bleibt liegen, Zeitgeber wiederholt, delivered entfernt", async outcome => {
    outcomes = [outcome, "delivered"];
    connect(); await blockClaude(); await check(); await settleSwitchNoticesForTests();
    expect(pending()[0].attempts).toBe(1);
    expect(pending()[0].claimedAt).toBeUndefined();
    await advance(59_999);
    expect(deliveries).toHaveLength(1);
    await advance(1);
    expect(deliveries).toHaveLength(2);
    expect(pending()).toHaveLength(0);
    expect(timers.size).toBe(0);
  });
  test("unclear nach drei erfolglosen Wiederholungen: 1, 5, 15 Minuten, Log ohne Text", async () => {
    outcomes = ["unclear", "unclear", "unclear", "unclear"];
    connect(); await blockClaude(); await check(); await settleSwitchNoticesForTests();
    for (const [i, ms] of [60_000, 5 * 60_000, 15 * 60_000].entries()) {
      await advance(ms - 1); expect(deliveries).toHaveLength(i + 1);
      await advance(1); expect(deliveries).toHaveLength(i + 2);
    }
    expect(pending()).toHaveLength(0);
    expect(logs).toEqual(["[Motorwechsel] Meldung verworfen (drei Wiederholungen erfolglos)."]);
    expect(logs.join()).not.toContain(deliveries[0].text);
  });
  test("Neustart zwischen Merken und Senden, danach kein zweites Senden beim Neustart", async () => {
    await blockClaude(); await check(); await settleSwitchNoticesForTests();
    expect(pending()).toHaveLength(1);
    expect(pending()[0].claimedAt).toBeUndefined();
    resetSwitchNotifyForTests(); resetSwitchStateForTests();
    connect(); await settleSwitchNoticesForTests();
    expect(deliveries).toHaveLength(1);
    expect(pending()).toHaveLength(0);
    resetSwitchNotifyForTests(); resetSwitchStateForTests();
    connect(); await settleSwitchNoticesForTests();
    expect(deliveries).toHaveLength(1);
  });
  test.each([0, 120_001])("Anspruch mit Alter %s ms: frisch verhindert Doppel, verwaist wird übernommen", async age => {
    await blockClaude(); await check(); await settleSwitchNoticesForTests();
    await updateSwitchState(state => ({ ...state, notices: { ...state.notices,
      pending: (state.notices?.pending ?? []).map(notice => ({ ...notice, claimedAt: new Date(now - age).toISOString() })) } }));
    connect(); await settleSwitchNoticesForTests();
    expect(deliveries).toHaveLength(age ? 1 : 0);
    if (!age) { await advance(120_001); expect(deliveries).toHaveLength(1); }
  });
  test("sechs Stunden alt verfällt ohne Zustellversuch, auch ohne Meldeweg", async () => {
    await blockClaude(); await check(); await settleSwitchNoticesForTests();
    await advance(6 * 60 * 60_000);
    expect(pending()).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
    expect(logs).toEqual(["[Motorwechsel] Meldung verworfen (6 Stunden abgelaufen)."]);
  });
  test("werfender Meldeweg gilt als unklar", async () => {
    setSwitchNotifier(async () => { throw new Error("privater Text"); }, deps);
    await blockClaude(); await check(); await settleSwitchNoticesForTests();
    expect(pending()[0].attempts).toBe(1);
    expect(logs.join()).not.toContain("privater Text");
  });
  test("hängender Versand verhindert weder weitere Wechsel noch deren Zustellung", async () => {
    setSwitchNotifier(async (text, target) => {
      if (!deliveries.length) { deliveries.push({ text, target }); return new Promise<UserDelivery>(() => {}); }
      return deliver(text, target);
    }, deps);
    await blockClaude(); await check();
    // Wartet nur auf die Zustandskette, nie auf die absichtlich hängende Zustellung.
    await updateSwitchState(state => state);
    await updateSwitchState(state => ({ ...state, blocks: [] }));
    await check();
    await flushSwitchNotices(deps);
    await updateSwitchState(state => state);
    expect(deliveries).toHaveLength(2);
    expect(pending()).toHaveLength(1);
    resetSwitchNotifyForTests();
  });
  test("nicht schreibbare Datei: Meldung wird aus dem Speicher zugestellt", async () => {
    setSwitchStateWriterForTests(async () => { throw new Error("nicht schreibbar"); });
    connect(); await blockClaude(); await check(); await settleSwitchNoticesForTests();
    expect(deliveries).toHaveLength(1);
    expect(pending()).toHaveLength(0);
  });
});

let externalStamp = 1_000;
function externalBlocks(blocks: readonly SwitchBlock[]) {
  writeFileSync(file, JSON.stringify({ ...readSwitchState(), blocks }));
  utimesSync(file, ++externalStamp, externalStamp);
}

describe("Beobachtung ohne Turn, Web-Server oder Browser", () => {
  test("ein Durchgang verwendet denselben Einstellungsstand für Prüfung und Reihenfolge", async () => {
    externalBlocks([block]);
    deps.checkEngine = async engine => {
      settings = { engine: { backups: [{ engine: "opencode" }] } };
      return statuses[engine]!;
    };
    startSwitchWatch(deps); await settleSwitchNoticesForTests();
    expect(readSwitchState().notices?.announced).toBe("codex");
    expect(pending()[0].text).toBe(thresholdSwitchNotice(claude, codex, block, zone));
  });
  test("Sperrende ist Teil des Fingerabdrucks; Reihenfolge der Sperren nicht", async () => {
    let checks = 0;
    deps.checkEngine = async engine => { checks++; return statuses[engine]!; };
    externalBlocks([block, { ...block, engine: "opencode" }]);
    connect(); startSwitchWatch(deps); await settleSwitchNoticesForTests();
    const initial = checks;
    externalBlocks([...readSwitchState().blocks].reverse());
    await advance(SWITCH_WATCH_MS);
    expect(checks).toBe(initial);
    externalBlocks(readSwitchState().blocks.map(b => ({ ...b, until: new Date(now + 1_000).toISOString() })));
    await advance(SWITCH_WATCH_MS);
    expect(checks).toBe(initial + 2);
    expect(deliveries.at(-1)?.text).toBe(returnSwitchNotice(claude));
  });
  test("Stoppen während einer offenen Motorprüfung legt danach nichts ab", async () => {
    const resolvers: (() => void)[] = [];
    deps.checkEngine = engine => new Promise(resolve => resolvers.push(() => resolve(statuses[engine]!)));
    externalBlocks([block]);
    const stop = startSwitchWatch(deps);
    await Promise.resolve(); await Promise.resolve();
    expect(resolvers).toHaveLength(2);
    stop(); for (const resolve of resolvers) resolve();
    await settleSwitchNoticesForTests();
    expect(pending()).toHaveLength(0);
    expect(timers.size).toBe(0);
  });
  test("fremde Sperre und fremdes Entfernen: genau eine Schwellenmeldung und ein Rückwechsel", async () => {
    connect(); const stop = startSwitchWatch(deps);
    await settleSwitchNoticesForTests();
    externalBlocks([block]);
    await advance(SWITCH_WATCH_MS);
    expect(deliveries.map(d => d.text)).toEqual([thresholdSwitchNotice(claude, codex, block, zone)]);
    expect(pending()).toHaveLength(0);
    externalBlocks([]);
    await advance(SWITCH_WATCH_MS);
    expect(deliveries.map(d => d.text)).toEqual([thresholdSwitchNotice(claude, codex, block, zone), returnSwitchNotice(claude)]);
    stop();
  });
  test("unveränderte Datei prüft und schreibt nichts; auch nur percent und since lösen nichts aus", async () => {
    let checks = 0;
    let writes = 0;
    deps.checkEngine = async engine => { checks++; return statuses[engine]!; };
    deps.updateSwitchState = mutate => { writes++; return updateSwitchState(mutate); };
    externalBlocks([block]); connect(); startSwitchWatch(deps);
    await settleSwitchNoticesForTests();
    const baseline = { checks, writes };
    const before = statSync(file);
    for (let i = 0; i < 3; i++) await advance(SWITCH_WATCH_MS);
    expect({ checks, writes }).toEqual(baseline);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(file).ino).toBe(before.ino);
    externalBlocks([{ ...block, percent: 99, since: new Date(now).toISOString() }]);
    await advance(SWITCH_WATCH_MS);
    expect({ checks, writes }).toEqual(baseline);
    expect(deliveries).toHaveLength(1);
  });
  test("eigene Änderung und folgender Durchgang ergeben eine Meldung", async () => {
    connect(); startSwitchWatch(deps); await settleSwitchNoticesForTests();
    await blockClaude(); await settleSwitchNoticesForTests();
    expect(deliveries).toHaveLength(1);
    await advance(SWITCH_WATCH_MS);
    expect(deliveries).toHaveLength(1);
  });
  test.each([false, true])("Sperre vor dem Start, schon gemeldet: %s", async announced => {
    writeFileSync(file, JSON.stringify({ version: 1, blocks: [block], counters: [], ...(announced ? { notices: { announced: "codex" } } : {}) }));
    connect(); startSwitchWatch(deps); await settleSwitchNoticesForTests();
    expect(deliveries).toHaveLength(announced ? 0 : 1);
    await advance(SWITCH_WATCH_MS);
    expect(deliveries).toHaveLength(announced ? 0 : 1);
  });
  test("fällige Meldung von außen wird auch bei unveränderten Sperren gesendet", async () => {
    connect(); startSwitchWatch(deps); await settleSwitchNoticesForTests();
    const at = new Date(now).toISOString();
    writeFileSync(file, JSON.stringify({ version: 1, blocks: [], counters: [], notices: {
      pending: [{ id: "extern", text: "Fällige Meldung", createdAt: at, nextAt: at, attempts: 0 }],
    } }));
    await advance(SWITCH_WATCH_MS);
    expect(deliveries.map(d => d.text)).toEqual(["Fällige Meldung"]);
    expect(pending()).toHaveLength(0);
  });
  test("Ablauf allein löst keinen Rückwechsel aus; erst die Prüfung des nächsten Turns", async () => {
    connect(); externalBlocks([block]); startSwitchWatch(deps); await settleSwitchNoticesForTests();
    await advance(60 * 60_000 + 1);
    expect(deliveries).toHaveLength(1);
    await check(); await settleSwitchNoticesForTests();
    expect(deliveries.at(-1)?.text).toBe(returnSwitchNotice(claude));
  });
  test("kein Ersatz: keine Prüfung, kein Lesen oder Schreiben; kaputte Datei wirft nie", async () => {
    settings = {};
    deps.checkEngine = async () => { throw new Error("darf nicht prüfen"); };
    deps.readSwitchState = () => { throw new Error("darf nicht lesen"); };
    const stop = startSwitchWatch(deps); await settleSwitchNoticesForTests();
    await advance(SWITCH_WATCH_MS);
    expect(logs).toEqual([]);
    stop();
    settings = { engine: { backups: [{ engine: "codex" }] } };
    delete deps.readSwitchState;
    deps.checkEngine = async engine => statuses[engine]!;
    writeFileSync(file, "kaputt");
    connect(); startSwitchWatch(deps); await settleSwitchNoticesForTests();
    expect(deliveries).toHaveLength(0);
  });
  test("Stoppen beendet Durchgänge und Zuhörer; Takt höchstens 30 Sekunden", async () => {
    let checks = 0;
    deps.checkEngine = async engine => { checks++; return statuses[engine]!; };
    connect(); const stop = startSwitchWatch(deps); await settleSwitchNoticesForTests();
    const before = checks;
    stop();
    await blockClaude(); await advance(SWITCH_WATCH_MS * 2);
    expect(checks).toBe(before);
    expect(timers.size).toBe(0);
    expect(SWITCH_WATCH_MS).toBeLessThanOrEqual(30_000);
    expect(deliveries).toHaveLength(0);
  });
  test("Schreibfehler meldet die eigene Sperränderung aus dem Arbeitsspeicher", async () => {
    connect(); startSwitchWatch(deps); await settleSwitchNoticesForTests();
    setSwitchStateWriterForTests(async () => { throw new Error("nicht schreibbar"); });
    await blockClaude(); await settleSwitchNoticesForTests();
    expect(deliveries).toHaveLength(1);
    expect(readSwitchState().notices?.announced).toBe("codex");
    expect(pending()).toHaveLength(0);
    setSwitchStateWriterForTests(null);
    await updateSwitchState(state => state);
    await advance(SWITCH_WATCH_MS);
    expect(deliveries).toHaveLength(1);
  });
});

describe("Prozessgrenzen", () => {
  const stateModule = new URL("../src/lib/engine-switch-state.ts", import.meta.url).pathname;
  const notifyModule = new URL("../src/lib/engine-switch-notify.ts", import.meta.url).pathname;
  async function child(source: string) {
    const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
      cwd: dir, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH },
    });
    const timeout = setTimeout(() => proc.kill(), 5_000);
    try {
      const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      return stdout.trim();
    } finally { clearTimeout(timeout); }
  }
  test("reiner Schreiber importiert das Modul und schreibt Sperren, aber keine Meldung", async () => {
    expect(await child(`
      import ${JSON.stringify(notifyModule)};
      import { updateSwitchState, readSwitchState } from ${JSON.stringify(stateModule)};
      await updateSwitchState(state => ({ ...state, blocks: [${JSON.stringify(block)}] }));
      console.log(JSON.stringify(readSwitchState().notices ?? null));
    `)).toBe("null");
  });
  test("echte Zeitgeber für Beobachtung und Wiederholung halten den Prozess nicht am Leben", async () => {
    expect(await child(`
      import { startSwitchWatch, setSwitchNotifier, settleSwitchNoticesForTests } from ${JSON.stringify(notifyModule)};
      import { updateSwitchState } from ${JSON.stringify(stateModule)};
      const at = new Date().toISOString();
      await updateSwitchState(state => ({ ...state, notices: { pending: [{ id: 'test', text: 'Meldung', createdAt: at, nextAt: at, attempts: 0 }] } }));
      const deps = { getSettings: () => ({ engine: { backups: [{ engine: 'codex' }] } }), checkEngine: async engine => ({ engine, checked: true, installed: true, loggedIn: true }) };
      setSwitchNotifier(async () => ({ outcome: 'rejected', delivered: false, telegram: [] }), deps);
      startSwitchWatch(deps);
      await settleSwitchNoticesForTests();
      console.log('fertig');
    `)).toBe("fertig");
  });
});
