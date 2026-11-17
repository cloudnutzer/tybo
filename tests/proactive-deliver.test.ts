/**
 * Versand proaktiver Meldungen mit Exit-Code (Issue #361). Der Exit-Code
 * wird an einem eigenen Testprozess geprüft (tests/fixtures/proactive/run.ts),
 * der Ablauf zusätzlich im Prozess.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as fileLock from "../src/lib/file-lock";
import { proactiveExitCode, runProactive, type ProactiveDeps } from "../src/lib/proactive/deliver";
import type { SendAndRecordInput } from "../src/lib/outbox";
import { CLAIM_MAX_MS, readProactiveState } from "../src/lib/proactive/state";

const FIXTURE = join(import.meta.dir, "fixtures", "proactive", "run.ts");
// 12:00 UTC: im Zeitfenster des Check-ins, außerhalb der Ruhezeit
const NOON = "2026-10-19T12:00:00.000Z";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-proactive-run-"));
  mkdirSync(join(dir, "config"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function spawnRun(env: Record<string, string>) {
  return Bun.spawn(["bun", FIXTURE], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PROACTIVE_DIR: dir, PROACTIVE_NOW: NOON, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}
async function run(env: Record<string, string> = {}) {
  const proc = spawnRun(env);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, log: out + err };
}
const sentLines = () => (existsSync(join(dir, "sent.log")) ? readFileSync(join(dir, "sent.log"), "utf-8").trim().split("\n").filter(Boolean) : []);
const state = () => readProactiveState(join(dir, "data", "proactive-state.json"));

describe("Exit-Code im eigenen Prozess", () => {
  test("Telegram zugestellt: Exit 0, Versandzeit gesetzt", async () => {
    const r = await run({ PROACTIVE_SEND: "telegram" });
    expect(r.code).toBe(0);
    expect(r.log).toContain("[proactive] checkin: sent");
    expect((await state()).checkin.lastSentAt).toBe(NOON);
  });

  test("Sendefehler: Exit 1, keine Versandzeit", async () => {
    const r = await run({ PROACTIVE_SEND: "fail" });
    expect(r.code).toBe(1);
    expect(r.log).toContain("failed (undelivered)");
    expect((await state()).checkin.lastSentAt).toBeUndefined();
  });

  test("Ausnahme beim Senden: Exit 1", async () => {
    const r = await run({ PROACTIVE_SEND: "throw" });
    expect(r.code).toBe(1);
    expect(r.log).toContain("failed (send)");
    expect(r.log).not.toContain("Netz weg");
  });

  test("Ausnahme beim Bauen des Texts: Exit 1, nichts gesendet", async () => {
    const r = await run({ PROACTIVE_COMPOSE: "throw" });
    expect(r.code).toBe(1);
    expect(r.log).toContain("failed (compose)");
    expect(sentLines()).toEqual([]);
  });

  test("nur WebUI (ohne Telegram festgehalten): Erfolg, Exit 0", async () => {
    const r = await run({ PROACTIVE_SEND: "web-only" });
    expect(r.code).toBe(0);
    expect((await state()).checkin.lastSentAt).toBe(NOON);
  });

  test("Telegram angenommen, Festhalten gescheitert: bleibt Erfolg", async () => {
    const r = await run({ PROACTIVE_SEND: "telegram-unrecorded" });
    expect(r.code).toBe(0);
  });

  test("Überspringen nach Regeln: Exit 0, nichts gesendet", async () => {
    // 23:00 UTC liegt in der Ruhezeit
    const quiet = await run({ PROACTIVE_NOW: "2026-10-19T23:00:00.000Z" });
    expect(quiet.code).toBe(0);
    expect(quiet.log).toContain("skipped (quiet)");
    // Nach einer Zustellung gilt der Mindestabstand
    expect((await run()).code).toBe(0);
    const gap = await run({ PROACTIVE_NOW: "2026-10-19T12:30:00.000Z" });
    expect(gap.code).toBe(0);
    expect(gap.log).toContain("skipped (gap)");
    expect(sentLines()).toEqual(["checkin"]);
  });

  test("Fenster schließt während des Bauens: Exit 0, nichts gesendet, keine Versandmarkierung", async () => {
    // compose beginnt 18:59 UTC (im Fenster bis 19:00) und endet 19:01
    const r = await run({ PROACTIVE_NOW: "2026-10-19T18:59:00.000Z", PROACTIVE_NOW_AFTER: "2026-10-19T19:01:00.000Z" });
    expect(r.code).toBe(0);
    expect(r.log).toContain("skipped (window)");
    expect(sentLines()).toEqual([]);
    const s = await state();
    expect(s.checkin.lastSentAt).toBeUndefined();
    expect(s.checkin.lastDate).toBeUndefined();
    expect(s.checkin.claim).toBeUndefined();
  });

  for (const [mode, reason, extra] of [
    ["window", "window", { PROACTIVE_NOW: "2026-10-19T18:58:00.000Z", PROACTIVE_NOW_LOCKED: "2026-10-19T19:01:00.000Z" }],
    ["disabled", "disabled", {}],
  ] as const) {
    test(`${mode === "window" ? "Fensterende" : "Abschalten"} beim Warten auf die Sperre: Exit 0, nichts gesendet, keine Versandmarkierung`, async () => {
      const r = await run({ PROACTIVE_LOCK_WAIT: mode, ...extra });
      expect(r.code).toBe(0);
      expect(r.log).toContain(`skipped (${reason})`);
      expect(sentLines()).toEqual([]);
      const s = await state();
      expect(s.checkin.lastSentAt).toBeUndefined();
      expect(s.checkin.lastDate).toBeUndefined();
      expect(s.checkin.claim).toBeUndefined();
    });
  }

  test("Snooze während des Bauens: Exit 0, nichts gesendet, keine Versandmarkierung", async () => {
    const r = await run({ PROACTIVE_COMPOSE: "snooze" });
    expect(r.code).toBe(0);
    expect(r.log).toContain("skipped (snoozed)");
    expect(sentLines()).toEqual([]);
    const s = await state();
    expect(s.checkin.snoozedUntil).toBe("2026-10-19T13:00:00.000Z");
    expect(s.checkin.lastSentAt).toBeUndefined();
    expect(s.checkin.lastDate).toBeUndefined();
    expect(s.checkin.claim).toBeUndefined();
  });

  test("nichts zu sagen: Exit 0, nichts gesendet", async () => {
    const r = await run({ PROACTIVE_COMPOSE: "null" });
    expect(r.code).toBe(0);
    expect(r.log).toContain("skipped (nothing)");
    expect(sentLines()).toEqual([]);
  });

  test("kaputter Zustand: Exit 1, Datei bleibt", async () => {
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "proactive-state.json"), "{kaputt");
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.log).toContain("failed (state)");
    expect(readFileSync(join(dir, "data", "proactive-state.json"), "utf-8")).toBe("{kaputt");
  });

  test("Briefing einmal am Tag, Tagesmarke erst nach Zustellung", async () => {
    const at = "2026-10-19T09:30:00.000Z";
    expect((await run({ PROACTIVE_KIND: "briefing", PROACTIVE_NOW: at, PROACTIVE_SEND: "fail" })).code).toBe(1);
    expect((await state()).briefing.lastDate).toBeUndefined();
    expect((await run({ PROACTIVE_KIND: "briefing", PROACTIVE_NOW: at })).code).toBe(0);
    expect((await state()).briefing.lastDate).toBe("2026-10-19");
    const again = await run({ PROACTIVE_KIND: "briefing", PROACTIVE_NOW: "2026-10-19T10:00:00.000Z" });
    expect(again.code).toBe(0);
    expect(again.log).toContain("skipped (done-today)");
    expect(sentLines()).toEqual(["briefing", "briefing"]);
  });

  test("gleichzeitige Prozesse senden genau einmal", async () => {
    const procs = Array.from({ length: 3 }, () => spawnRun({ PROACTIVE_DELAY_MS: "400" }));
    const codes = await Promise.all(procs.map(p => p.exited));
    expect(codes).toEqual([0, 0, 0]);
    expect(sentLines()).toEqual(["checkin"]);
    const s = await state();
    expect(s.checkin.lastSentAt).toBe(NOON);
    expect(s.checkin.claim).toBeUndefined();
  });

  test("Übernahme im Lauf: alter Check-in-Zustand zählt für den Mindestabstand", async () => {
    writeFileSync(join(dir, "checkin-state.json"), JSON.stringify({ lastCheckinTime: "2026-10-19T11:00:00.000Z", pendingItems: [] }));
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.log).toContain("skipped (gap)");
    expect((await state()).imported.checkinState).toBe(NOON);
  });
});

describe("Ablauf im Prozess", () => {
  let err: ReturnType<typeof spyOn>;
  beforeEach(() => { err = spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => err.mockRestore());

  function deps(extra: Partial<ProactiveDeps> = {}): ProactiveDeps {
    return { now: () => new Date(NOON), env: { USER_TIMEZONE: "Europe/Berlin" }, settings: {}, statePath: join(dir, "state.json"), legacy: null, ...extra };
  }

  test("Quelle wie die Art, Knöpfe und Format gehen mit, Kontext mit Zone und Einstellungen", async () => {
    const calls: SendAndRecordInput[] = [];
    let seen: any;
    const outcome = await runProactive(
      "checkin",
      async ctx => {
        seen = ctx;
        return { text: "Hallo", format: "plain", buttons: [[{ text: "Erledigt", callback_data: "dismiss" }]] };
      },
      deps({ send: async input => { calls.push(input); return { sent: true, recorded: true }; } }),
    );
    expect(outcome).toEqual({ status: "sent" });
    expect(calls).toEqual([{ text: "Hallo", source: "checkin", format: "plain", buttons: [[{ text: "Erledigt", callback_data: "dismiss" }]] }]);
    expect(seen.zone).toBe("Europe/Berlin");
    expect(seen.kind).toBe("checkin");
    expect(seen.config.checkin.minGapMinutes).toBe(90);
  });

  test("Regel greift: compose wird gar nicht aufgerufen", async () => {
    let called = false;
    const outcome = await runProactive("briefing", async () => { called = true; return { text: "x" }; }, deps());
    // 12:00 UTC ist 14:00 in Berlin, außerhalb des Briefing-Fensters
    expect(outcome).toEqual({ status: "skipped", reason: "window" });
    expect(called).toBe(false);
  });

  test("Regel greift erst nach compose: nicht gesendet, Reservierung frei, keine Versandzeit", async () => {
    let clock = new Date("2026-10-19T16:59:00.000Z").getTime();
    const sends: string[] = [];
    // 16:59 UTC ist 18:59 in Berlin, compose endet nach dem Fensterende 19:00
    const outcome = await runProactive("checkin", async () => { clock += 2 * 60_000; return { text: "x" }; }, deps({
      now: () => new Date(clock),
      send: async input => { sends.push(input.text); return { sent: true, recorded: true }; },
    }));
    expect(outcome).toEqual({ status: "skipped", reason: "window" });
    expect(proactiveExitCode(outcome)).toBe(0);
    expect(sends).toEqual([]);
    const s = await readProactiveState(join(dir, "state.json"));
    expect(s.checkin.claim).toBeUndefined();
    expect(s.checkin.lastSentAt).toBeUndefined();
  });

  test("Einstellungen wirken: abgeschaltet", async () => {
    const outcome = await runProactive("checkin", async () => ({ text: "x" }), deps({ settings: { proactive: { checkin: { enabled: false } } } }));
    expect(outcome).toEqual({ status: "skipped", reason: "disabled" });
  });

  describe("Reservierung über CLAIM_MAX_MS hinweg", () => {
    // Uhr-Attrappe: A beginnt um 12:00, compose hängt, bis der Test es freigibt.
    // Die Testphasen hängen an Signalen (compose bzw. Versand erreicht), nicht an Wartezeiten.
    function setup() {
      let clock = new Date(NOON).getTime();
      const sends: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      let entered!: () => void;
      const composing = new Promise<void>(r => { entered = r; });
      const base = deps({
        now: () => new Date(clock),
        send: async input => { sends.push(input.text); return { sent: true, recorded: true }; },
      });
      return {
        base,
        sends,
        release,
        composing,
        compose: async () => { entered(); await gate; return { text: "A" }; },
        advance: (ms: number) => { clock += ms; },
        now: () => new Date(clock),
      };
    }
    const past = CLAIM_MAX_MS + 60_000;

    /** Wartet, bis check zutrifft; schlägt nach fünf Sekunden fehl */
    async function until(check: () => Promise<boolean>): Promise<void> {
      const deadline = Date.now() + 5_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error("Testphase nicht erreicht");
        await Bun.sleep(5);
      }
    }

    test("lebender Lauf A behält die Reservierung, B sendet nicht, gesendet wird einmal", async () => {
      const t = setup();
      const a = runProactive("checkin", t.compose, { ...t.base, renewMs: 5 });
      try {
        await t.composing;
        t.advance(past);
        // A erneuert weiter, auch nach CLAIM_MAX_MS: die Erneuerung trägt die vorgestellte Uhrzeit
        const renewed = t.now().toISOString();
        await until(async () => (await readProactiveState(join(dir, "state.json"))).checkin.claim?.renewedAt === renewed);
        const b = await runProactive("checkin", async () => ({ text: "B" }), { ...t.base, renewMs: 0 });
        expect(b).toEqual({ status: "skipped", reason: "busy" });
      } finally {
        // Auch wenn eine Erwartung scheitert: A freigeben, sonst hinge der Lauf
        // samt Erneuerung bis zum Ende des Testprozesses und bremste spätere Dateien
        t.release();
      }
      expect(await a).toEqual({ status: "sent" });
      expect(t.sends).toEqual(["A"]);
      const s = await readProactiveState(join(dir, "state.json"));
      expect(s.checkin.claim).toBeUndefined();
      expect(s.checkin.lastSentAt).toBe(new Date(new Date(NOON).getTime() + past).toISOString());
    });

    // Nachstellung aus PR #510: Dauert ein Sperrdurchlauf länger als renewMs, stauten sich die
    // Erneuerungen vor der Sperre (bis zu 1304), und B bekam nach 10 s failed/state statt busy.
    // Das Tor ersetzt die langsame Sperre, die Takte eine Wartezeit: mehr Zeit ändert das Ergebnis nicht.
    test("langsame Sperre: Erneuerungen stauen sich nicht, B bekommt busy, nach dem Lauf keine weitere", async () => {
      const t = setup();
      const ticks = async (n: number) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 1)); };
      const realAcquire = fileLock.acquireFileLock;
      let slow = false;
      let waiting = 0;
      let most = 0;
      let opened!: () => void;
      const lockGate = new Promise<void>(r => { opened = r; });
      let reached!: () => void;
      const blocked = new Promise<void>(r => { reached = r; });
      const spy = spyOn(fileLock, "acquireFileLock").mockImplementation(async (path, opts) => {
        if (slow) {
          most = Math.max(most, ++waiting);
          reached();
          await lockGate;
          waiting--;
        }
        return realAcquire(path, opts);
      });
      try {
        const a = runProactive("checkin", t.compose, { ...t.base, renewMs: 1 });
        try {
          await t.composing;
          slow = true;
          await blocked;
          // setInterval hätte hier bei jedem Takt eine weitere Erneuerung vor die Sperre gestellt
          await ticks(50);
          expect(most).toBe(1);
          slow = false;
          opened();
          const b = await runProactive("checkin", async () => ({ text: "B" }), { ...t.base, renewMs: 0 });
          expect(b).toEqual({ status: "skipped", reason: "busy" });
        } finally {
          slow = false;
          opened();
          t.release();
        }
        expect(await a).toEqual({ status: "sent" });
        expect(t.sends).toEqual(["A"]);
        const calls = spy.mock.calls.length;
        await ticks(20);
        expect(spy.mock.calls.length).toBe(calls);
      } finally {
        spy.mockRestore();
      }
    });

    test("hängender Lauf A wird übernommen und sendet danach nicht mehr", async () => {
      const t = setup();
      // A erneuert nicht (hängt)
      const a = runProactive("checkin", t.compose, { ...t.base, renewMs: 0 });
      try {
        await t.composing;
        t.advance(past);
        const b = await runProactive("checkin", async () => ({ text: "B" }), { ...t.base, renewMs: 0 });
        expect(b).toEqual({ status: "sent" });
      } finally {
        t.release();
      }
      expect(await a).toEqual({ status: "skipped", reason: "overtaken" });
      expect(t.sends).toEqual(["B"]);
      const s = await readProactiveState(join(dir, "state.json"));
      expect(s.checkin.claim).toBeUndefined();
      expect(s.checkin.lastSentAt).toBe(new Date(new Date(NOON).getTime() + past).toISOString());
    });

    test("laufender Versand: B wartet auch nach CLAIM_MAX_MS", async () => {
      let clock = new Date(NOON).getTime();
      const sends: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      let entered!: () => void;
      const sending = new Promise<void>(r => { entered = r; });
      const base = deps({ now: () => new Date(clock), renewMs: 0 });
      const a = runProactive("checkin", async () => ({ text: "A" }), {
        ...base,
        send: async input => { sends.push(input.text); entered(); await gate; return { sent: true, recorded: true }; },
      });
      try {
        await sending;
        clock += past;
        const b = await runProactive("checkin", async () => ({ text: "B" }), {
          ...base,
          send: async input => { sends.push(input.text); return { sent: true, recorded: true }; },
        });
        expect(b).toEqual({ status: "skipped", reason: "busy" });
      } finally {
        release();
      }
      expect(await a).toEqual({ status: "sent" });
      expect(sends).toEqual(["A"]);
    });
  });

  test("Exit-Code je Ergebnis", () => {
    expect(proactiveExitCode({ status: "sent" })).toBe(0);
    expect(proactiveExitCode({ status: "skipped", reason: "quiet" })).toBe(0);
    expect(proactiveExitCode({ status: "skipped", reason: "busy" })).toBe(0);
    expect(proactiveExitCode({ status: "failed", reason: "send" })).toBe(1);
  });
});
