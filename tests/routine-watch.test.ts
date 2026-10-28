/**
 * Issue #287, Checkbox 2: ausgebliebene Läufe (src/lib/routines/watch.ts)
 * mit fester Uhr. Routinen als Objekte, Zustand im Speicher bzw. in einem
 * Temp-Ordner, Versand über eine Attrappe. Kein launchctl, kein echter
 * Versand, kein Import von src/bot.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alertAfterRun, alertsFile, fileAlertsStore, markRunStart, parseAlerts, type AlertSendResult, type AlertsState, type AlertsStore } from "../src/lib/routines/alerts";
import type { RoutineRun } from "../src/lib/routines/runs";
import type { LaunchdSchedule } from "../src/lib/routines/schedule";
import type { Routine, RoutineState } from "../src/lib/routines/types";
import { MASK } from "../src/lib/jobs/mask";
import { ALERT_TEXT } from "../src/lib/routines/alerts";
import { CALENDAR_GRACE_MS, defaultWatchDeps, pidAlive, startRoutineWatch, watchTick, type WatchDeps } from "../src/lib/routines/watch";
import { mkdir, writeFile } from "node:fs/promises";

const TZ = "Europe/Berlin";
const HOME = "/Users/alex";
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Wanduhrzeit in Berlin (Oktober: UTC+2) */
const at = (s: string) => Date.parse(`${s}+02:00`);

const tmp = await mkdtemp(join(tmpdir(), "routine-watch-"));
afterAll(() => rm(tmp, { recursive: true, force: true }));

function memoryStore(initial: AlertsState = { routines: {} }): AlertsStore & { state(): AlertsState; writes: number } {
  let json = JSON.stringify(initial);
  const store = {
    writes: 0,
    read: async () => parseAlerts(json),
    async update<T>(fn: (s: AlertsState) => T): Promise<T> {
      const s = parseAlerts(json);
      const r = fn(s);
      json = JSON.stringify(s);
      store.writes++;
      return r;
    },
    state: () => parseAlerts(json),
  };
  return store;
}

function routine(id: string, schedule: Partial<LaunchdSchedule>, extra: Partial<Routine> = {}): Routine {
  return {
    id,
    name: id.replace(/^ai\.tybo\./, ""),
    kind: "scheduled",
    schedule: { type: "launchd", otherTriggers: [], ...schedule },
    scheduleText: "x",
    state: "active",
    lastExit: 0,
    logPath: `${HOME}/tybo/logs/${id}.log`,
    errorLogPath: `${HOME}/tybo/logs/${id}.error.log`,
    source: "launchd",
    own: true,
    wrapped: true,
    lastRun: null,
    nextRun: null,
    ...extra,
  };
}

function lastRun(startedAt: number, extra: Partial<RoutineRun> = {}): RoutineRun {
  return { startedAt: new Date(startedAt).toISOString(), endedAt: new Date(startedAt + 1000).toISOString(), durationMs: 1000, exitCode: 0, tail: [], ...extra };
}

const DAILY = "ai.tybo.daily";
const daily = (extra: Partial<Routine> = {}) => routine(DAILY, { StartCalendarInterval: { Hour: 6, Minute: 30 } }, extra);

interface Harness {
  deps: WatchDeps;
  store: ReturnType<typeof memoryStore>;
  sent: string[];
  logs: string[];
  clock: { now: number };
  routines: Routine[];
  /** Prüfungen alle 10 Minuten von jetzt bis to (einschließlich, wenn es auf das Raster fällt); liefert gemeldete IDs */
  tickUntil(to: number, step?: number): Promise<string[]>;
  tick(now: number, reset?: boolean): Promise<string[]>;
}

function harness(
  routines: Routine[],
  o: { store?: AlertsStore; reply?: () => Promise<AlertSendResult>; enabled?: () => boolean; secrets?: () => readonly string[] | null; alive?: (pid: number) => boolean } = {},
): Harness {
  const store = (o.store as ReturnType<typeof memoryStore>) ?? memoryStore();
  const sent: string[] = [];
  const logs: string[] = [];
  const clock = { now: 0 };
  const h: Harness = {
    store,
    sent,
    logs,
    clock,
    routines,
    deps: {
      store,
      list: async () => ({ available: true, source: "launchd", routines: h.routines, notes: [] }),
      send: async text => {
        sent.push(text);
        return o.reply ? o.reply() : { sent: true, recorded: true };
      },
      now: () => clock.now,
      pid: process.pid,
      home: HOME,
      timeZone: TZ,
      enabled: o.enabled ?? (() => true),
      secrets: o.secrets ?? (() => []),
      alive: o.alive ?? pidAlive,
      log: line => logs.push(line),
    },
    async tick(now, reset = false) {
      clock.now = now;
      return watchTick(h.deps, { reset });
    },
    async tickUntil(to, step = 10 * MIN) {
      const out: string[] = [];
      for (let t = clock.now + step; t <= to; t += step) out.push(...(await h.tick(t)));
      return out;
    },
  };
  return h;
}

/** Bot startet um start, prüft alle 10 Minuten bis to */
async function botRuns(h: Harness, start: number, to: number): Promise<string[]> {
  const out = await h.tick(start, true);
  return [...out, ...(await h.tickUntil(to))];
}

describe("Kalender-Routine (StartCalendarInterval)", () => {
  test("täglich 06:30: 2 h 1 min nach Fälligkeit ohne Lauf meldet, genau einmal", async () => {
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00")) })]);
    // Bot läuft seit 04:31 durchgehend; Prüfung um 08:30 ist genau 2 h nach 06:30
    expect(await botRuns(h, at("2026-10-15T04:31:00"), at("2026-10-15T08:21:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-15T08:30:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-15T08:31:00"))).toEqual([DAILY]);
    expect(h.sent).toEqual(["⏰ Routine daily ist nicht gelaufen (fällig heute 06:30)\nLog: ~/tybo/logs/ai.tybo.daily.error.log\nVerlauf: /routinen daily"]);
    // Weitere Prüfungen, auch über den nächsten Termin hinweg: keine zweite Meldung
    expect(await h.tickUntil(at("2026-10-16T12:00:00"))).toEqual([]);
    expect(h.sent).toHaveLength(1);
    expect(h.logs).toEqual([`[routinen] ${DAILY} ausgeblieben, gemeldet`]);
  });

  test("Meldung trägt Routine und Art (Issue #288, für die Knöpfe)", async () => {
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00")) })]);
    const metas: unknown[] = [];
    h.deps.send = async (text, meta) => {
      h.sent.push(text);
      metas.push(meta);
      return { sent: true, recorded: true };
    };
    await botRuns(h, at("2026-10-15T04:31:00"), at("2026-10-15T08:40:00"));
    expect(metas).toEqual([{ id: DAILY, kind: "missed" }]);
  });

  test("mit Lauf heute: keine Meldung", async () => {
    const h = harness([daily({ lastRun: lastRun(at("2026-10-15T06:30:00")) })]);
    expect(await botRuns(h, at("2026-10-15T04:31:00"), at("2026-10-15T23:50:00"))).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  test("begonnener, noch nicht beendeter Lauf (nur in alerts.json) zählt als Lauf", async () => {
    const store = memoryStore();
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00")) })], { store });
    await h.tick(at("2026-10-15T04:31:00"), true);
    await markRunStart(store, DAILY, at("2026-10-15T06:30:00"), process.pid);
    expect(await h.tickUntil(at("2026-10-15T12:00:00"))).toEqual([]);
  });

  test("Herzschlag-Lücke von 3 Stunden (Schlaf): nicht sofort, erst nach der vollen Frist ab dem Aufwachen", async () => {
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00")) })]);
    expect(await botRuns(h, at("2026-10-15T05:00:00"), at("2026-10-15T06:00:00"))).toEqual([]);
    // Rechner schläft von 06:00 bis 09:00; die Fälligkeit 06:30 liegt dann 2,5 h zurück
    expect(await h.tick(at("2026-10-15T09:00:00"))).toEqual([]);
    expect(await h.tickUntil(at("2026-10-15T11:00:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-15T11:01:00"))).toEqual([DAILY]);
  });

  test("Neustart des Bots nach wenigen Minuten setzt den Herzschlag zurück", async () => {
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00")) })]);
    expect(await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T08:20:00"))).toEqual([]);
    // Neustart um 08:25 (Lücke 5 Minuten): die Frist läuft ab 08:25 neu
    expect(await h.tick(at("2026-10-15T08:25:00"), true)).toEqual([]);
    expect(await h.tickUntil(at("2026-10-15T10:25:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-15T10:26:00"))).toEqual([DAILY]);
  });

  test("Erstlauf ohne Historie: Frist ab dem ersten Sehen, nie für Termine davor", async () => {
    const h = harness([daily()]);
    // Erstmals gesehen um 09:00: der Termin 06:30 von heute zählt nicht
    expect(await botRuns(h, at("2026-10-15T09:00:00"), at("2026-10-16T08:30:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-16T08:31:00"))).toEqual([DAILY]);
    expect(h.sent[0]).toContain("(fällig heute 06:30)");
  });

  test("stündliche Routine: der verpasste Termin bleibt offen und wird gemeldet", async () => {
    const id = "ai.tybo.hourly";
    const h = harness([routine(id, { StartCalendarInterval: { Minute: 0 } }, { lastRun: lastRun(at("2026-10-15T05:00:00")) })]);
    expect(await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T08:00:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-15T08:01:00"))).toEqual([id]);
    expect(h.sent[0]).toContain("(fällig heute 06:00)");
  });

  test("Kalenderliste: der erste Termin nach dem letzten Lauf zählt", async () => {
    const id = "ai.tybo.twice";
    const h = harness([routine(id, { StartCalendarInterval: [{ Hour: 18, Minute: 30 }, { Hour: 9, Minute: 0 }] }, { lastRun: lastRun(at("2026-10-15T09:00:00")) })]);
    expect(await botRuns(h, at("2026-10-15T08:00:00"), at("2026-10-15T20:30:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-15T20:31:00"))).toEqual([id]);
    expect(h.sent[0]).toContain("(fällig heute 18:30)");
  });

  test("Zeitumstellung: 02:30 am Tag der Sommerzeit ist 03:30, Frist von dort", async () => {
    const id = "ai.tybo.night";
    const h = harness([routine(id, { StartCalendarInterval: { Hour: 2, Minute: 30 } }, { lastRun: lastRun(Date.parse("2026-03-28T01:30:00Z")) })]);
    const due = Date.parse("2026-03-29T01:30:00Z"); // 03:30 Sommerzeit
    expect(await botRuns(h, Date.parse("2026-03-28T22:00:00Z"), due + CALENDAR_GRACE_MS)).toEqual([]);
    expect(await h.tick(due + CALENDAR_GRACE_MS + MIN)).toEqual([id]);
    expect(h.sent[0]).toContain("03:30)");
  });
});

describe("Intervall-Routine (StartInterval)", () => {
  test("alle 10 Minuten: überfällig erst nach dreimal Intervall plus 10 Minuten", async () => {
    const id = "ai.tybo.often";
    const h = harness([routine(id, { StartInterval: 600 }, { lastRun: lastRun(at("2026-10-15T07:00:00")) })]);
    expect(await botRuns(h, at("2026-10-15T06:00:00"), at("2026-10-15T07:40:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-15T07:41:00"))).toEqual([id]);
    expect(h.sent[0]).toContain("(fällig heute 07:10)");
    expect(await h.tickUntil(at("2026-10-15T12:00:00"))).toEqual([]);
  });

  test("Schlaf-Regel: Frist ab dem Aufwachen", async () => {
    const id = "ai.tybo.often";
    const h = harness([routine(id, { StartInterval: 600 }, { lastRun: lastRun(at("2026-10-15T07:00:00")) })]);
    await botRuns(h, at("2026-10-15T06:00:00"), at("2026-10-15T07:10:00"));
    expect(await h.tick(at("2026-10-15T09:00:00"))).toEqual([]);
    expect(await h.tickUntil(at("2026-10-15T09:40:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-15T09:41:00"))).toEqual([id]);
  });
});

describe("Schlaf während einer laufenden Prüfung", () => {
  /** Zwei überfällige Routinen; während der Sendung für A schläft der Rechner sleepMs lang */
  function sleepsDuringA(schedule: Partial<LaunchdSchedule>, last: number, sleepMs: number) {
    const A = "ai.tybo.a";
    const B = "ai.tybo.b";
    const h = harness([routine(A, schedule, { lastRun: lastRun(last) }), routine(B, schedule, { lastRun: lastRun(last) })]);
    const send = h.deps.send;
    h.deps.send = async text => {
      const out = await send(text);
      if (text.startsWith("⏰ Routine a ")) h.clock.now += sleepMs;
      return out;
    };
    return { h, A, B };
  }

  test("Kalender: Termin 00:10, Prüfung 02:11, drei Stunden Schlaf während A: B erst nach der vollen neuen Frist, genau einmal", async () => {
    const { h, A, B } = sleepsDuringA({ StartCalendarInterval: { Hour: 0, Minute: 10 } }, at("2026-10-14T00:10:00"), 3 * HOUR);
    expect(await botRuns(h, at("2026-10-14T22:01:00"), at("2026-10-15T02:01:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-15T02:11:00"))).toEqual([A]);
    // Aufgewacht um 05:11: B ist nicht gesendet, sondern zurückgestellt
    expect(h.clock.now).toBe(at("2026-10-15T05:11:00"));
    expect(h.sent).toHaveLength(1);
    expect(h.logs).toContain(`[routinen] ${B} ausgeblieben, Meldung zurückgestellt (Rechner schlief während der Prüfung)`);
    expect(h.store.state().routines[B].series?.claim).toBeUndefined();
    expect(await h.tickUntil(at("2026-10-15T07:11:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-15T07:12:00"))).toEqual([B]);
    expect(await h.tickUntil(at("2026-10-15T12:00:00"))).toEqual([]);
    expect(h.sent.filter(t => t.startsWith("⏰ Routine b "))).toHaveLength(1);
    expect(h.sent).toHaveLength(2);
  });

  test("Intervall 600: 40-Minuten-Frist, drei Stunden Schlaf während A: B erst 40 Minuten nach dem Aufwachen, genau einmal", async () => {
    const { h, A, B } = sleepsDuringA({ StartInterval: 600 }, at("2026-10-15T07:00:00"), 3 * HOUR);
    expect(await botRuns(h, at("2026-10-15T06:00:00"), at("2026-10-15T07:40:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-15T07:41:00"))).toEqual([A]);
    expect(h.clock.now).toBe(at("2026-10-15T10:41:00"));
    expect(h.sent).toHaveLength(1);
    expect(h.logs).toContain(`[routinen] ${B} ausgeblieben, Meldung zurückgestellt (Rechner schlief während der Prüfung)`);
    expect(await h.tickUntil(at("2026-10-15T11:21:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-15T11:22:00"))).toEqual([B]);
    expect(await h.tickUntil(at("2026-10-15T14:00:00"))).toEqual([]);
    expect(h.sent.filter(t => t.startsWith("⏰ Routine b "))).toHaveLength(1);
    expect(h.sent).toHaveLength(2);
  });
});

describe("laufender Lauf (Wrapper-Prozess lebt)", () => {
  test("Intervall-Lauf über dreimal Intervall plus 10 Minuten: keine Meldung, erst nach seinem Ende", async () => {
    const id = "ai.tybo.often";
    const store = memoryStore();
    let alive = true;
    const h = harness([routine(id, { StartInterval: 600 }, { lastRun: lastRun(at("2026-10-15T06:50:00")) })], { store, alive: () => alive });
    await h.tick(at("2026-10-15T06:00:00"), true);
    await markRunStart(store, id, at("2026-10-15T07:00:00"), 4242);
    // Frist 40 Minuten; der Lauf dauert bis 10:00
    expect(await h.tickUntil(at("2026-10-15T10:00:00"))).toEqual([]);
    expect(h.sent).toEqual([]);
    // Der Prozess ist weg, ohne dass ein Lauf endete (Absturz): die Frist zählt wieder
    alive = false;
    expect(await h.tick(at("2026-10-15T10:01:00"))).toEqual([id]);
  });

  test("Kalender-Lauf über weitere Termine hinweg: keine Meldung", async () => {
    const store = memoryStore();
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00")) })], { store, alive: pid => pid === 4242 });
    await h.tick(at("2026-10-15T04:00:00"), true);
    await markRunStart(store, DAILY, at("2026-10-15T06:30:00"), 4242);
    expect(await h.tickUntil(at("2026-10-17T12:00:00"))).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  test("der Wrapper trägt den Lauf ein und nach dem Ende wieder aus", async () => {
    const store = memoryStore();
    await markRunStart(store, DAILY, at("2026-10-15T06:30:00"), 4242);
    expect(store.state().routines[DAILY].running).toEqual([{ pid: 4242, startedAt: new Date(at("2026-10-15T06:30:00")).toISOString() }]);
    await alertAfterRun({ id: DAILY, run: lastRun(at("2026-10-15T06:30:00")), stderrTail: [], secrets: [] }, {
      store,
      send: async () => ({ sent: true }),
      now: () => at("2026-10-15T06:31:00"),
      pid: 4242,
      home: HOME,
      logPath: async () => null,
    });
    expect(store.state().routines[DAILY].running).toBeUndefined();
  });
  test("zwei Wrapper derselben Routine: das Ende des kurzen Laufs B lässt den langen Lauf A eingetragen", async () => {
    const id = "ai.tybo.often";
    const store = memoryStore();
    let aAlive = true;
    const h = harness([routine(id, { StartInterval: 600 }, { lastRun: lastRun(at("2026-10-15T06:50:00")) })], { store, alive: pid => pid === 4242 && aAlive });
    await h.tick(at("2026-10-15T06:00:00"), true);
    await markRunStart(store, id, at("2026-10-15T07:00:00"), 4242);
    const b = at("2026-10-15T07:10:00");
    await markRunStart(store, id, b, 4343);
    expect(store.state().routines[id].running?.map(x => x.pid)).toEqual([4242, 4343]);
    expect(
      await alertAfterRun({ id, run: lastRun(b), stderrTail: [], secrets: [] }, { store, send: async () => ({ sent: true }), now: () => b + 1000, pid: 4343, home: HOME, logPath: async () => null }),
    ).toBe("silent");
    expect(store.state().routines[id].running?.map(x => x.pid)).toEqual([4242]);
    h.routines = [routine(id, { StartInterval: 600 }, { lastRun: lastRun(b) })];
    // A läuft bis 10:00 weiter, weit über die Frist von 40 Minuten nach B
    expect(await h.tickUntil(at("2026-10-15T10:00:00"))).toEqual([]);
    expect(h.sent).toEqual([]);
    aAlive = false;
    expect(await h.tick(at("2026-10-15T10:01:00"))).toEqual([id]);
  });
});

describe("nie überfällig", () => {
  const states: RoutineState[] = ["paused", "not-loaded", "unknown"];
  for (const state of states) {
    test(`Zustand ${state}`, async () => {
      const h = harness([daily({ state, lastRun: lastRun(at("2026-10-10T06:30:00")) })]);
      expect(await botRuns(h, at("2026-10-15T00:00:00"), at("2026-10-16T12:00:00"))).toEqual([]);
    });
  }

  test("nicht eingebunden, Dauerdienst, PM2, ohne Zeitplan", async () => {
    const old = lastRun(at("2026-10-10T06:30:00"));
    const h = harness([
      daily({ id: "ai.tybo.a", wrapped: false, lastRun: old }),
      daily({ id: "ai.tybo.b", kind: "daemon", lastRun: old }),
      daily({ id: "tybo-c", source: "pm2", schedule: { type: "cron", cron: "30 6 * * *" }, lastRun: old }),
      routine("ai.tybo.d", { RunAtLoad: true }, { lastRun: old }),
    ]);
    expect(await botRuns(h, at("2026-10-15T00:00:00"), at("2026-10-16T12:00:00"))).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  test("eben fortgesetzt: die Frist beginnt mit dem Fortsetzen", async () => {
    const h = harness([daily({ state: "paused", lastRun: lastRun(at("2026-10-10T06:30:00")) })]);
    await botRuns(h, at("2026-10-15T00:00:00"), at("2026-10-15T09:00:00"));
    h.routines = [daily({ lastRun: lastRun(at("2026-10-10T06:30:00")) })];
    expect(await h.tickUntil(at("2026-10-16T08:30:00"))).toEqual([]);
    expect(await h.tick(at("2026-10-16T08:31:00"))).toEqual([DAILY]);
  });

  test("während einer gemeldeten Fehlerserie keine zweite Meldung", async () => {
    const store = memoryStore();
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00"), { exitCode: 1 }) })], { store });
    await alertAfterRun({ id: DAILY, run: lastRun(at("2026-10-14T06:30:00"), { exitCode: 1 }), stderrTail: [], secrets: [] }, {
      store,
      send: async () => ({ sent: true }),
      now: () => at("2026-10-14T06:31:00"),
      pid: process.pid,
      home: HOME,
      logPath: async () => null,
    });
    expect(await botRuns(h, at("2026-10-15T00:00:00"), at("2026-10-16T12:00:00"))).toEqual([]);
  });
});

describe("Serie und Zustellung", () => {
  test("Meldung, Entwarnung nach erfolgreichem Lauf, dann neue Serie", async () => {
    const store = memoryStore();
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00")) })], { store });
    expect(await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T08:40:00"))).toEqual([DAILY]);
    // Der Lauf kommt nach (etwa von Hand), erfolgreich: Entwarnung
    const sent: string[] = [];
    const started = at("2026-10-15T09:00:00");
    await markRunStart(store, DAILY, started, process.pid);
    const outcome = await alertAfterRun({ id: DAILY, run: lastRun(started), stderrTail: [], secrets: [] }, {
      store,
      send: async t => (sent.push(t), { sent: true }),
      now: () => started + 1000,
      pid: process.pid,
      home: HOME,
      logPath: async () => null,
    });
    expect(outcome).toBe("recovered");
    expect(sent).toEqual(["✅ Routine daily läuft wieder"]);
    h.routines = [daily({ lastRun: lastRun(started) })];
    // Nächster Termin 16.10. 06:30 bleibt aus: neue Meldung
    expect(await h.tickUntil(at("2026-10-16T08:40:00"))).toEqual([DAILY]);
    expect(h.sent).toHaveLength(2);
  });

  test("nicht zugestellt: die nächste Prüfung versucht es noch einmal", async () => {
    let ok = false;
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00")) })], {
      reply: async () => (ok ? { sent: true } : { sent: false, recorded: false, error: { kind: "send" } }),
    });
    expect(await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T08:40:00"))).toEqual([]);
    expect(h.sent).toHaveLength(1);
    expect(h.logs).toContain(`[routinen] ${DAILY} ausgeblieben, Meldung nicht zugestellt`);
    ok = true;
    expect(await h.tickUntil(at("2026-10-15T08:50:00"))).toEqual([DAILY]);
    expect(await h.tickUntil(at("2026-10-15T12:00:00"))).toEqual([]);
    expect(h.sent).toHaveLength(2);
  });

  test("ausgeblieben gemeldet, dann zweimal Fehlschlag, dann Erfolg: genau eine Warnung und eine Entwarnung", async () => {
    const store = memoryStore();
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00")) })], { store });
    expect(await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T08:40:00"))).toEqual([DAILY]);
    const sent: string[] = [];
    const wrapper = (t: number) => ({
      store,
      send: async (text: string) => (sent.push(text), { sent: true }),
      now: () => t + 1000,
      pid: process.pid,
      home: HOME,
      logPath: async () => null,
    });
    const t1 = at("2026-10-15T09:00:00");
    expect(await alertAfterRun({ id: DAILY, run: lastRun(t1, { exitCode: 1 }), stderrTail: ["kaputt"], secrets: [] }, wrapper(t1))).toBe("silent");
    expect(store.state().routines[DAILY].series?.kind).toBe("failed");
    const t2 = at("2026-10-15T10:00:00");
    expect(await alertAfterRun({ id: DAILY, run: lastRun(t2, { exitCode: 1 }), stderrTail: ["kaputt"], secrets: [] }, wrapper(t2))).toBe("silent");
    h.routines = [daily({ lastRun: lastRun(t2, { exitCode: 1 }) })];
    expect(await h.tickUntil(at("2026-10-16T12:00:00"))).toEqual([]);
    const t3 = at("2026-10-16T13:00:00");
    expect(await alertAfterRun({ id: DAILY, run: lastRun(t3), stderrTail: [], secrets: [] }, wrapper(t3))).toBe("recovered");
    expect(h.sent).toHaveLength(1);
    expect(sent).toEqual(["✅ Routine daily läuft wieder"]);
  });

  test("Erfolg, während die Ausgeblieben-Meldung unterwegs ist: der Bot entwarnt danach genau einmal", async () => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let gated = true;
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00")) })], {
      store,
      reply: async () => {
        if (gated) {
          gated = false;
          await gate;
        }
        return { sent: true };
      },
    });
    await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T08:30:00"));
    const pending = h.tick(at("2026-10-15T08:40:00"));
    while (h.sent.length === 0) await new Promise(r => setTimeout(r, 5));
    const started = at("2026-10-15T08:41:00");
    const outcome = await alertAfterRun({ id: DAILY, run: lastRun(started), stderrTail: [], secrets: [] }, {
      store,
      send: async () => {
        throw new Error("der Wrapper darf hier nicht senden");
      },
      now: () => started + 1000,
      pid: process.pid,
      home: HOME,
      logPath: async () => null,
    });
    expect(outcome).toBe("silent");
    release();
    expect(await pending).toEqual([DAILY]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toBe("✅ Routine daily läuft wieder");
    expect(store.state().routines[DAILY].series).toBeUndefined();
    expect(h.logs).toContain(`[routinen] ${DAILY} läuft wieder, entwarnt`);
  });

  test("Ausgeblieben-Meldung unterwegs, Erfolg, Fehlschlag: Entwarnung vom Bot und genau eine Warnung zur neuen Serie", async () => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let gated = true;
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00")) })], {
      store,
      reply: async () => {
        if (gated) {
          gated = false;
          await gate;
        }
        return { sent: true };
      },
    });
    await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T08:30:00"));
    const pending = h.tick(at("2026-10-15T08:40:00"));
    while (h.sent.length === 0) await new Promise(r => setTimeout(r, 5));
    const sent: string[] = [];
    const wrapper = (t: number) => ({ store, send: async (text: string) => (sent.push(text), { sent: true }), now: () => t + 1000, pid: 4242, home: HOME, logPath: async () => null });
    const t1 = at("2026-10-15T08:41:00");
    expect(await alertAfterRun({ id: DAILY, run: lastRun(t1), stderrTail: [], secrets: [] }, wrapper(t1))).toBe("silent");
    const t2 = at("2026-10-15T08:45:00");
    expect(await alertAfterRun({ id: DAILY, run: lastRun(t2, { exitCode: 1 }), stderrTail: ["kaputt"], secrets: [] }, wrapper(t2))).toBe("alerted");
    release();
    expect(await pending).toEqual([DAILY]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toBe("✅ Routine daily läuft wieder");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toStartWith("⚠️ Routine daily fehlgeschlagen");
    expect(store.state().routines[DAILY].series).toMatchObject({ kind: "failed" });
    expect(store.state().routines[DAILY].series?.alertedAt).toBeString();
    expect(store.state().routines[DAILY].closing).toBeUndefined();
    // Weitere Fehlschläge und Prüfungen: keine zweite Warnung
    h.routines = [daily({ lastRun: lastRun(t2, { exitCode: 1 }) })];
    const t3 = at("2026-10-15T09:00:00");
    expect(await alertAfterRun({ id: DAILY, run: lastRun(t3, { exitCode: 1 }), stderrTail: ["kaputt"], secrets: [] }, wrapper(t3))).toBe("silent");
    expect(await h.tickUntil(at("2026-10-16T12:00:00"))).toEqual([]);
    expect(h.sent).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });

  test("Erfolg bei abgeschalteten Meldungen, während die Ausgeblieben-Meldung unterwegs ist: der Bot entwarnt nicht", async () => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let gated = true;
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00")) })], {
      store,
      reply: async () => {
        if (gated) {
          gated = false;
          await gate;
        }
        return { sent: true };
      },
    });
    await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T08:30:00"));
    const pending = h.tick(at("2026-10-15T08:40:00"));
    while (h.sent.length === 0) await new Promise(r => setTimeout(r, 5));
    const started = at("2026-10-15T08:41:00");
    const outcome = await alertAfterRun({ id: DAILY, run: lastRun(started), stderrTail: [], secrets: [] }, {
      store,
      send: async () => {
        throw new Error("der Wrapper darf hier nicht senden");
      },
      now: () => started + 1000,
      pid: 4242,
      home: HOME,
      logPath: async () => null,
      enabled: false,
    });
    expect(outcome).toBe("silent");
    release();
    expect(await pending).toEqual([DAILY]);
    expect(h.sent).toHaveLength(1);
    expect(h.logs.join("\n")).not.toContain("entwarnt");
    expect(store.state().routines[DAILY].series).toBeUndefined();
    expect(store.state().routines[DAILY].closing).toBeUndefined();
  });

  test("verzögerter Versand: verfällt der Anspruch einer späteren Routine und meldet ein Wrapper ihren Fehler, schickt der Bot keine alte Ausgeblieben-Warnung", async () => {
    const store = memoryStore();
    const ids = ["ai.tybo.r1", "ai.tybo.r2", "ai.tybo.r3", "ai.tybo.r4"];
    const yesterday = lastRun(at("2026-10-14T06:30:00"));
    const wrapperSent: string[] = [];
    let sends = 0;
    let wrapperOutcome: string | null = null;
    const h: Harness = harness(
      ids.map(id => routine(id, { StartCalendarInterval: { Hour: 6, Minute: 30 } }, { lastRun: yesterday })),
      {
        store,
        reply: async () => {
          sends++;
          if (sends <= 3) h.clock.now += 110_000;
          // Nach der dritten Sendung ist der gemeinsame Anspruch älter als 5 Minuten
          if (sends === 3) {
            const t = h.clock.now;
            wrapperOutcome = await alertAfterRun({ id: ids[3], run: lastRun(t - 2000, { exitCode: 1 }), stderrTail: ["kaputt"], secrets: [] }, {
              store,
              send: async text => (wrapperSent.push(text), { sent: true }),
              now: () => t,
              pid: 4242,
              home: HOME,
              logPath: async () => null,
            });
          }
          return { sent: true };
        },
      },
    );
    expect(await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T08:30:00"))).toEqual([]);
    const alerted = await h.tick(at("2026-10-15T08:40:00"));
    expect(wrapperOutcome).toBe("alerted");
    expect(wrapperSent).toHaveLength(1);
    expect(wrapperSent[0]).toStartWith("⚠️ Routine r4 fehlgeschlagen");
    expect(alerted).toEqual(ids.slice(0, 3));
    expect(h.sent).toHaveLength(3);
    expect(h.sent.some(t => t.includes("r4"))).toBe(false);
    expect(h.logs).toContain("[routinen] ai.tybo.r4 ausgeblieben, Meldung entfällt (Anspruch nicht mehr beim Bot)");
    const st = store.state().routines[ids[3]];
    expect(st.series).toMatchObject({ kind: "failed" });
    expect(st.series?.alertedAt).toBeString();
    expect(st.series?.claim).toBeUndefined();
  });

  /** Zwei überfällige Routinen A und B; der Versand für A hängt, bis release */
  async function heldForA() {
    const store = memoryStore();
    const A = "ai.tybo.a";
    const B = "ai.tybo.b";
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let gated = true;
    let wrapperAlive = true;
    const yesterday = lastRun(at("2026-10-14T06:30:00"));
    const h = harness(
      [A, B].map(id => routine(id, { StartCalendarInterval: { Hour: 6, Minute: 30 } }, { lastRun: yesterday })),
      {
        store,
        reply: async () => {
          if (gated) {
            gated = false;
            await gate;
          }
          return { sent: true };
        },
        alive: pid => pid === 4242 && wrapperAlive,
      },
    );
    await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T08:30:00"));
    const pending = h.tick(at("2026-10-15T08:40:00"));
    while (h.sent.length === 0) await new Promise(r => setTimeout(r, 5));
    expect(h.sent[0]).toStartWith("⏰ Routine a ");
    return { store, h, A, B, pending, release, end: () => (wrapperAlive = false) };
  }

  test("Versand für A hängt, B beginnt und läuft weiter: keine Ausgeblieben-Meldung für B", async () => {
    const { store, h, A, B, pending, release } = await heldForA();
    await markRunStart(store, B, at("2026-10-15T08:41:00"), 4242);
    release();
    expect(await pending).toEqual([A]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent.some(t => t.includes("Routine b "))).toBe(false);
    expect(h.logs).toContain(`[routinen] ${B} ausgeblieben, Meldung entfällt (Anspruch nicht mehr beim Bot)`);
    expect(store.state().routines[B].series).toBeUndefined();
    // B läuft noch lange: weitere Prüfungen melden nichts
    expect(await h.tickUntil(at("2026-10-15T14:00:00"))).toEqual([]);
    expect(h.sent).toHaveLength(1);
  });

  test("Versand für A hängt, B beginnt und scheitert vorher: genau eine Fehlermeldung mit Fehlerzeile und Exit-Code", async () => {
    const { store, h, A, B, pending, release, end } = await heldForA();
    const started = at("2026-10-15T08:41:00");
    await markRunStart(store, B, started, 4242);
    const wrapperSent: string[] = [];
    const outcome = await alertAfterRun({ id: B, run: lastRun(started, { exitCode: 3 }), stderrTail: ["Verbindung abgelehnt"], secrets: [] }, {
      store,
      send: async text => (wrapperSent.push(text), { sent: true }),
      now: () => started + 1000,
      pid: 4242,
      home: HOME,
      logPath: async () => null,
    });
    end();
    expect(outcome).toBe("alerted");
    release();
    expect(await pending).toEqual([A]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent.some(t => t.includes("Routine b "))).toBe(false);
    expect(wrapperSent).toHaveLength(1);
    expect(wrapperSent[0]).toStartWith("⚠️ Routine b fehlgeschlagen (Exit 3,");
    expect(wrapperSent[0].split("\n")[1]).toBe("Verbindung abgelehnt");
    const st = store.state().routines[B];
    expect(st.series).toMatchObject({ kind: "failed" });
    expect(st.series?.alertedAt).toBeString();
    // Weitere Prüfungen: keine Ausgeblieben-Meldung während der Fehlerserie
    h.routines = h.routines.map(r => (r.id === B ? { ...r, lastRun: lastRun(started, { exitCode: 3 }) } : r));
    expect(await h.tickUntil(at("2026-10-15T14:00:00"))).toEqual([]);
    expect(h.sent).toHaveLength(1);
  });

  test("ROUTINE_ALERTS=off: keine Meldung, alerts.json unberührt", async () => {
    const h = harness([daily({ lastRun: lastRun(at("2026-10-10T06:30:00")) })], { enabled: () => false });
    expect(await botRuns(h, at("2026-10-15T00:00:00"), at("2026-10-16T12:00:00"))).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.store.writes).toBe(0);
  });

  test("ins Log kommen nur Routinen-IDs, nie Ausgaben", async () => {
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00"), { tail: ["token=geheim-123"] }) })]);
    await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T09:00:00"));
    expect(h.logs.join("\n")).not.toContain("geheim");
    for (const line of h.logs) expect(line).toMatch(/^\[routinen\] ai\.tybo\.daily /);
  });

  test("mit alerts.json auf der Platte (Sperre, atomar): Zustand bleibt über Prüfungen erhalten", async () => {
    const root = join(tmp, "root-file");
    const store = fileAlertsStore(root);
    const h = harness([daily({ lastRun: lastRun(at("2026-10-14T06:30:00")) })], { store });
    expect(await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T08:40:00"))).toEqual([DAILY]);
    const state = parseAlerts(await readFile(alertsFile(root), "utf-8"));
    expect(state.routines[DAILY].series).toMatchObject({ kind: "missed", due: new Date(at("2026-10-15T06:30:00")).toISOString() });
    expect(state.routines[DAILY].series?.alertedAt).toBeString();
    expect(state.heartbeat?.awakeSince).toBe(new Date(at("2026-10-15T04:00:00")).toISOString());
  });
});

describe("Geheimnisse in der Ausgeblieben-Meldung", () => {
  const SECRET = "geheim-0123456789-abcdef";
  const leaky = () => daily({ id: `ai.tybo.x-${SECRET}`, errorLogPath: `/tmp/${SECRET}/err.log`, lastRun: lastRun(at("2026-10-14T06:30:00")) });

  test("Name und Log-Pfad werden mit den Werten aus der .env maskiert", async () => {
    const h = harness([leaky()], { secrets: () => [SECRET] });
    await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T08:40:00"));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).not.toContain(SECRET);
    expect(h.sent[0]).toContain(`Log: /tmp/${MASK}/err.log`);
  });

  test(".env nicht lesbar: weder Name noch Log-Pfad", async () => {
    const h = harness([leaky()], { secrets: () => null });
    await botRuns(h, at("2026-10-15T04:00:00"), at("2026-10-15T08:40:00"));
    expect(h.sent).toEqual([`⏰ Routine ${ALERT_TEXT.hiddenName} ist nicht gelaufen (fällig heute 06:30)\n${ALERT_TEXT.hiddenLog}\n${ALERT_TEXT.historyAll}`]);
  });

  test("defaultWatchDeps liest die Masken aus der .env des Projektordners, unlesbar heißt null", async () => {
    const root = join(tmp, "root-secrets");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ".env"), `EIN_WERT=${SECRET}\n`);
    expect(defaultWatchDeps(root, {}).secrets()).toContain(SECRET);
    const broken = join(tmp, "root-secrets-broken");
    await mkdir(join(broken, ".env"), { recursive: true });
    expect(defaultWatchDeps(broken, {}).secrets()).toBeNull();
  });
});

describe("Zeitgeber", () => {
  test("startet mit zurückgesetztem Herzschlag, prüft im Takt, stop hält an", async () => {
    const store = memoryStore({ routines: {}, heartbeat: { awakeSince: "2026-10-01T00:00:00.000Z", lastBeat: new Date(at("2026-10-15T08:55:00")).toISOString() } });
    const h = harness([], { store });
    h.clock.now = at("2026-10-15T09:00:00");
    let fire: (() => void) | null = null;
    let cleared = false;
    const watch = startRoutineWatch(h.deps, {
      setInterval: ((fn: () => void) => ((fire = fn), 1)) as unknown as typeof setInterval,
      clearInterval: (() => (cleared = true)) as unknown as typeof clearInterval,
    });
    await watch.idle();
    expect(store.state().heartbeat?.awakeSince).toBe(new Date(at("2026-10-15T09:00:00")).toISOString());
    h.clock.now = at("2026-10-15T09:10:00");
    fire!();
    await watch.idle();
    expect(store.state().heartbeat?.lastBeat).toBe(new Date(at("2026-10-15T09:10:00")).toISOString());
    expect(store.state().heartbeat?.awakeSince).toBe(new Date(at("2026-10-15T09:00:00")).toISOString());
    watch.stop();
    expect(cleared).toBe(true);
    const writes = store.writes;
    fire!();
    await watch.idle();
    expect(store.writes).toBe(writes);
  });
});

describe("Anbindung im Bot (nur als Text gelesen, nie importiert)", () => {
  // Anhalten beim Beenden als Verhalten: tests/app-bot-shutdown.test.ts (Issue #342)
  // Start der Wache: tests/app-bot-background.test.ts, Handler der Art routine:
  // tests/app-bot-choices.test.ts, Anhalten beim Beenden: tests/app-bot-shutdown.test.ts (Issue #344)
});
