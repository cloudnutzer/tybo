/**
 * Issue #287, Checkbox 1: Meldung nach einem Fehlschlag im Wrapper. Echter
 * Unterprozess (sh), Zustand in einem Temp-Ordner, Versand über eine
 * Attrappe für sendAndRecord. Kein launchctl, kein echter Versand.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MASK } from "../src/lib/jobs/mask";
import {
  ALERT_TEXT,
  alertAfterRun,
  alertsEnabled,
  alertsFile,
  ERROR_LINE_MAX,
  failureText,
  fileAlertsStore,
  missedText,
  parseAlerts,
  pickErrorLine,
  plistLogPath,
  readRoutinesSummary,
  type AlertSendResult,
  type AlertsStore,
  type RunAlertDeps,
} from "../src/lib/routines/alerts";
import type { RoutineRun } from "../src/lib/routines/runs";
import { cliAlerts, readProjectDotenv, runWrapped } from "../src/routine-run";

const ID = "ai.tybo.health-check";
const SECRET = "geheim-0123456789-abcdef";
const HOME = "/Users/alex";
const LOG = `${HOME}/tybo/logs/health-check.error.log`;

const tmp = await mkdtemp(join(tmpdir(), "routine-alerts-"));
afterAll(() => rm(tmp, { recursive: true, force: true }));
let n = 0;

async function freshRoot(): Promise<string> {
  const root = join(tmp, `root-${++n}`);
  await mkdir(join(root, "data", "routines"), { recursive: true });
  return root;
}

interface Fake {
  sent: string[];
  deps: RunAlertDeps & { store: AlertsStore };
}

function fake(root: string, reply: (text: string) => Promise<AlertSendResult> = async () => ({ sent: true, recorded: true })): Fake {
  const sent: string[] = [];
  return {
    sent,
    deps: {
      store: fileAlertsStore(root),
      send: async text => {
        sent.push(text);
        return reply(text);
      },
      now: () => Date.now(),
      pid: process.pid,
      home: HOME,
      logPath: async () => LOG,
    },
  };
}

const sink = () => {};

function wrap(root: string, f: Fake, script: string, secrets: string[] | null = [SECRET]) {
  return runWrapped({ id: ID, command: ["/bin/sh", "-c", script], root, secrets, stdout: sink, stderr: sink, note: sink, alerts: f.deps });
}

function run(extra: Partial<RoutineRun> = {}): RoutineRun {
  const at = new Date().toISOString();
  return { startedAt: at, endedAt: at, durationMs: 1200, exitCode: 1, tail: ["kaputt"], ...extra };
}

describe("Fehlschlag melden, einmal je Serie", () => {
  test("erster Fehler meldet, zweiter nicht, Erfolg entwarnt, weiterer Erfolg schweigt", async () => {
    const root = await freshRoot();
    const f = fake(root);
    const first = await wrap(root, f, "echo Testfehler >&2; exit 1");
    expect(first.exitCode).toBe(1);
    expect(first.alert).toBe("alerted");
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toStartWith("⚠️ Routine health-check fehlgeschlagen (Exit 1, ");
    expect(f.sent[0]).toContain("\nTestfehler\n");
    expect(f.sent[0]).toContain("Log: ~/tybo/logs/health-check.error.log");
    expect(f.sent[0]).toEndWith("Verlauf: /routinen health-check");
    const state = parseAlerts(await readFile(alertsFile(root), "utf-8"));
    expect(state.routines[ID].series?.kind).toBe("failed");
    expect(state.routines[ID].series?.alertedAt).toBeString();
    expect(state.routines[ID].series?.claim).toBeUndefined();

    const second = await wrap(root, f, "echo noch einmal >&2; exit 2");
    expect(second.exitCode).toBe(2);
    expect(second.alert).toBe("silent");
    expect(f.sent).toHaveLength(1);

    const ok = await wrap(root, f, "echo ok");
    expect(ok.exitCode).toBe(0);
    expect(ok.alert).toBe("recovered");
    expect(f.sent).toEqual([f.sent[0], ALERT_TEXT.recovered("health-check")]);
    expect(f.sent[1]).toBe("✅ Routine health-check läuft wieder");

    const again = await wrap(root, f, "echo ok");
    expect(again.alert).toBe("silent");
    expect(f.sent).toHaveLength(2);

    // Neue Serie nach dem Erfolg: wieder genau eine Meldung
    await wrap(root, f, "exit 5");
    await wrap(root, f, "exit 5");
    expect(f.sent).toHaveLength(3);
  });

  test("Erfolg ohne gemeldete Serie schickt keine Entwarnung", async () => {
    const root = await freshRoot();
    const f = fake(root);
    expect((await wrap(root, f, "true")).alert).toBe("silent");
    expect(f.sent).toEqual([]);
  });

  test("Beginn steht in alerts.json, während der Befehl noch läuft", async () => {
    const root = await freshRoot();
    const f = fake(root);
    const out: string[] = [];
    const r = await runWrapped({
      id: ID,
      command: ["/bin/sh", "-c", `cat "${alertsFile(root)}"`],
      root,
      secrets: [],
      stdout: chunk => out.push(new TextDecoder().decode(chunk)),
      stderr: sink,
      note: sink,
      alerts: f.deps,
    });
    expect(r.exitCode).toBe(0);
    const during = parseAlerts(out.join(""));
    expect(during.routines[ID].startedAt).toBe(r.run.startedAt);
  });

  test("Abbruch durch ein Signal gilt als Fehler, auch mit Exit 0 (abgefangenes SIGTERM)", async () => {
    const root = await freshRoot();
    const f = fake(root);
    const outcome = await alertAfterRun({ id: ID, run: run({ exitCode: 0, signal: "SIGTERM", tail: ["SIGTERM erhalten"] }), stderrTail: ["SIGTERM erhalten"], secrets: [] }, f.deps);
    expect(outcome).toBe("alerted");
    expect(f.sent[0]).toStartWith("⚠️ Routine health-check fehlgeschlagen (Exit 0, abgebrochen durch SIGTERM, 1 s)");
  });
});

describe("Routine und Art an jeder Meldung (Issue #288)", () => {
  test("Fehlschlag mit kind failed, Entwarnung mit kind recovered", async () => {
    const root = await freshRoot();
    const f = fake(root);
    const metas: unknown[] = [];
    f.deps.send = async (text, meta) => {
      f.sent.push(text);
      metas.push(meta);
      return { sent: true, recorded: true };
    };
    expect(await alertAfterRun({ id: ID, run: run(), stderrTail: [], secrets: [] }, f.deps)).toBe("alerted");
    expect(await alertAfterRun({ id: ID, run: run({ exitCode: 0 }), stderrTail: [], secrets: [] }, f.deps)).toBe("recovered");
    expect(metas).toEqual([
      { id: ID, kind: "failed" },
      { id: ID, kind: "recovered" },
    ]);
  });
});

describe("Inhalt der Meldung", () => {
  test("Fehlerzeile bevorzugt aus stderr, maskiert und auf 300 Zeichen gekürzt", async () => {
    const root = await freshRoot();
    const f = fake(root);
    const long = "x".repeat(400);
    // Geheimnis an der Kürzungsgrenze: erst maskiert, dann gekürzt, also nie halb sichtbar
    const script = `echo "Fehler ${"y".repeat(280)}${SECRET} ${long}" >&2; echo "danach auf stdout"; exit 1`;
    await wrap(root, f, script);
    const [text] = f.sent;
    const line = text.split("\n")[1];
    expect(line).toStartWith("Fehler ");
    expect([...line]).toHaveLength(ERROR_LINE_MAX);
    expect(line).toEndWith("…");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SECRET.slice(0, 12));
    expect(text).not.toContain("danach auf stdout");
  });

  test("Geheimnis in der Fehlerzeile wird ersetzt, auch über Stücke hinweg", async () => {
    const root = await freshRoot();
    const f = fake(root);
    await runWrapped({
      id: ID,
      command: ["/bin/sh", "-c", `printf 'token=%s' "${SECRET.slice(0, 8)}" >&2; sleep 0.2; printf '%s kaputt\\n' "${SECRET.slice(8)}" >&2; exit 1`],
      root,
      secrets: [SECRET],
      stdout: sink,
      stderr: sink,
      note: sink,
      alerts: f.deps,
    });
    expect(f.sent[0].split("\n")[1]).toBe(`token=${MASK} kaputt`);
    expect(f.sent[0]).not.toContain(SECRET);
  });

  test("ohne stderr die letzte nicht leere Zeile aus der Ausgabe", () => {
    expect(pickErrorLine([], ["erste", "letzte", "  "])).toBe("letzte");
    expect(pickErrorLine(["", "aus stderr"], ["stdout"])).toBe("aus stderr");
    expect(pickErrorLine([], [])).toBeNull();
  });

  test("Geheimnis im Log-Pfad und im Namen der Meldung wird ersetzt", () => {
    const text = failureText({ name: "x", run: { exitCode: 1, durationMs: 0 }, errorLine: "ok", logPath: `/tmp/${SECRET}/log`, home: HOME, secrets: [SECRET] });
    expect(text).not.toContain(SECRET);
    expect(text).toContain(`Log: /tmp/${MASK}/log`);
  });

  test("Geheimnis aus Home-Ordner und vertraulichem Pfadteil: maskiert vor der Umwandlung zu ~", () => {
    const part = "vertraulich-0123456789";
    const secret = `${HOME}/${part}`;
    const logPath = `${secret}/health-check.error.log`;
    const failed = failureText({ name: "x", run: { exitCode: 1, durationMs: 0 }, errorLine: "ok", logPath, home: HOME, secrets: [secret] });
    const missed = missedText({ name: "x", dueText: "heute 06:30", logPath, home: HOME, secrets: [secret] });
    for (const text of [failed, missed]) {
      expect(text).not.toContain(part);
      expect(text).toContain(`Log: ${MASK}/health-check.error.log`);
    }
  });

  test("ohne Ausgabe, ohne Log-Pfad und bei unlesbarer .env", async () => {
    const root = await freshRoot();
    const f = fake(root);
    f.deps.logPath = async () => null;
    await wrap(root, f, "exit 1");
    expect(f.sent[0].split("\n").slice(1)).toEqual([ALERT_TEXT.noOutput, ALERT_TEXT.noLog, "Verlauf: /routinen health-check"]);

    const root2 = await freshRoot();
    const g = fake(root2);
    await wrap(root2, g, `echo "${SECRET}" >&2; exit 1`, null);
    expect(g.sent[0].split("\n")[1]).toBe(ALERT_TEXT.withheld);
    expect(g.sent[0]).not.toContain(SECRET);
  });

  test(".env nicht lesbar: weder Name noch Log-Pfad noch Ausgabe", () => {
    const text = failureText({ name: `x-${SECRET}`, run: { exitCode: 1, durationMs: 0 }, errorLine: SECRET, logPath: `/tmp/${SECRET}/log`, home: HOME, secrets: null });
    expect(text).not.toContain(SECRET);
    expect(text.split("\n")).toEqual([`⚠️ Routine ${ALERT_TEXT.hiddenName} fehlgeschlagen (Exit 1, unter 1 s)`, ALERT_TEXT.withheld, ALERT_TEXT.hiddenLog, ALERT_TEXT.historyAll]);
  });

  test("Entwarnung maskiert den Namen; bei unlesbarer .env ohne Namen", async () => {
    const id = `ai.tybo.x-${SECRET}`;
    for (const secrets of [[SECRET], null]) {
      const root = await freshRoot();
      const since = new Date().toISOString();
      await writeFile(alertsFile(root), JSON.stringify({ routines: { [id]: { series: { kind: "failed", since, alertedAt: since } } } }));
      const f = fake(root);
      expect(await alertAfterRun({ id, run: run({ exitCode: 0 }), stderrTail: [], secrets }, f.deps)).toBe("recovered");
      expect(f.sent[0]).not.toContain(SECRET);
      expect(f.sent[0]).toBe(secrets ? `✅ Routine x-${MASK} läuft wieder` : `✅ Routine ${ALERT_TEXT.hiddenName} läuft wieder`);
    }
  });

  test("Log-Pfad aus dem Plist: StandardErrorPath vor StandardOutPath, sonst null", async () => {
    const home = join(tmp, `home-${++n}`);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(join(home, "Library", "LaunchAgents", `${ID}.plist`), "<plist/>");
    const calls: string[][] = [];
    const reply = (json: object) => async (cmd: string[]) => {
      calls.push(cmd);
      return { ok: true, stdout: JSON.stringify(json), stderr: "" };
    };
    expect(await plistLogPath(ID, { home, platform: "darwin", run: reply({ StandardOutPath: "/a/out.log", StandardErrorPath: "/a/err.log" }) })).toBe("/a/err.log");
    expect(await plistLogPath(ID, { home, platform: "darwin", run: reply({ StandardOutPath: "/a/out.log" }) })).toBe("/a/out.log");
    expect(await plistLogPath(ID, { home, platform: "darwin", run: reply({}) })).toBeNull();
    expect(calls.every(c => c[0] === "plutil")).toBe(true);
    // Kein Plist, anderes System: kein Befehl
    const before = calls.length;
    expect(await plistLogPath("ai.tybo.fehlt", { home, platform: "darwin", run: reply({}) })).toBeNull();
    expect(await plistLogPath(ID, { home, platform: "linux", run: reply({}) })).toBeNull();
    expect(calls).toHaveLength(before);
  });
});

describe("Zustellung", () => {
  test("ein Fehler beim Senden ändert den Exit-Code nicht, der nächste Fehlschlag versucht es noch einmal", async () => {
    const root = await freshRoot();
    let fail = true;
    const f = fake(root, async () => {
      if (fail) throw new Error("Netz weg");
      return { sent: true };
    });
    const r = await wrap(root, f, "exit 3");
    expect(r.exitCode).toBe(3);
    expect(r.alert).toBe("undelivered");
    const state = parseAlerts(await readFile(alertsFile(root), "utf-8"));
    expect(state.routines[ID].series?.alertedAt).toBeUndefined();
    expect(state.routines[ID].series?.claim).toBeUndefined();

    fail = false;
    expect((await wrap(root, f, "exit 3")).alert).toBe("alerted");
    expect((await wrap(root, f, "exit 3")).alert).toBe("silent");
    expect(f.sent).toHaveLength(2);
  });

  test("Telegram lehnt ab (sent false mit Fehler): nicht zugestellt", async () => {
    const root = await freshRoot();
    const f = fake(root, async () => ({ sent: false, recorded: false, error: { kind: "send", message: "x" } }));
    expect((await wrap(root, f, "exit 1")).alert).toBe("undelivered");
  });

  test("ohne Telegram zählt das Festhalten für die WebUI als Zustellung", async () => {
    const root = await freshRoot();
    const f = fake(root, async () => ({ sent: false, recorded: true }));
    expect((await wrap(root, f, "exit 1")).alert).toBe("alerted");
    expect((await wrap(root, f, "exit 1")).alert).toBe("silent");
  });

  test("zwei Wrapper derselben Routine gleichzeitig: genau eine Meldung", async () => {
    const root = await freshRoot();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const f = fake(root, async () => {
      await gate;
      return { sent: true };
    });
    const a = alertAfterRun({ id: ID, run: run(), stderrTail: [], secrets: [] }, f.deps);
    const b = alertAfterRun({ id: ID, run: run(), stderrTail: [], secrets: [] }, f.deps);
    await new Promise(r => setTimeout(r, 100));
    release();
    expect([await a, await b].sort()).toEqual(["alerted", "silent"]);
    expect(f.sent).toHaveLength(1);
  });

  test("Erfolg, während die Fehlermeldung unterwegs ist: danach genau eine Entwarnung", async () => {
    const root = await freshRoot();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let gated = true;
    const f = fake(root, async () => {
      if (gated) {
        gated = false;
        await gate;
      }
      return { sent: true };
    });
    const failing = alertAfterRun({ id: ID, run: run(), stderrTail: [], secrets: [] }, f.deps);
    while (f.sent.length === 0) await new Promise(r => setTimeout(r, 5));
    expect(await alertAfterRun({ id: ID, run: run({ exitCode: 0 }), stderrTail: [], secrets: [] }, f.deps)).toBe("silent");
    expect(f.sent).toHaveLength(1);
    release();
    expect(await failing).toBe("alerted");
    expect(f.sent).toEqual([f.sent[0], ALERT_TEXT.recovered("health-check")]);
    expect(parseAlerts(await readFile(alertsFile(root), "utf-8")).routines[ID].series).toBeUndefined();
    // Die Serie ist zu: der nächste Fehlschlag meldet wieder
    expect(await alertAfterRun({ id: ID, run: run(), stderrTail: [], secrets: [] }, f.deps)).toBe("alerted");
  });

  test("Fehlermeldung unterwegs, Erfolg, neuer Fehlschlag: Entwarnung zur alten und genau eine Warnung zur neuen Serie", async () => {
    const root = await freshRoot();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let gated = true;
    const f = fake(root, async () => {
      if (gated) {
        gated = false;
        await gate;
      }
      return { sent: true };
    });
    const first = alertAfterRun({ id: ID, run: run({ tail: ["alt"] }), stderrTail: ["alt"], secrets: [] }, f.deps);
    while (f.sent.length === 0) await new Promise(r => setTimeout(r, 5));
    expect(await alertAfterRun({ id: ID, run: run({ exitCode: 0 }), stderrTail: [], secrets: [] }, f.deps)).toBe("silent");
    // Neue Serie: eigene Warnung, obwohl die alte Meldung noch unterwegs ist
    expect(await alertAfterRun({ id: ID, run: run({ tail: ["neu"] }), stderrTail: ["neu"], secrets: [] }, f.deps)).toBe("alerted");
    release();
    expect(await first).toBe("alerted");
    expect(f.sent).toHaveLength(3);
    expect(f.sent[0]).toContain("\nalt\n");
    expect(f.sent[1]).toContain("\nneu\n");
    expect(f.sent[2]).toBe(ALERT_TEXT.recovered("health-check"));
    const state = parseAlerts(await readFile(alertsFile(root), "utf-8")).routines[ID];
    expect(state.series?.kind).toBe("failed");
    expect(state.series?.alertedAt).toBeString();
    expect(state.series?.claim).toBeUndefined();
    expect(state.closing).toBeUndefined();
    // Die neue Serie gilt als gemeldet: kein zweites Mal, Erfolg entwarnt sie
    expect(await alertAfterRun({ id: ID, run: run(), stderrTail: [], secrets: [] }, f.deps)).toBe("silent");
    expect(await alertAfterRun({ id: ID, run: run({ exitCode: 0 }), stderrTail: [], secrets: [] }, f.deps)).toBe("recovered");
    expect(f.sent).toHaveLength(4);
  });

  test("Erfolg bei abgeschalteten Meldungen, während die Fehlermeldung unterwegs ist: keine Entwarnung", async () => {
    const root = await freshRoot();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const f = fake(root, async () => {
      await gate;
      return { sent: true };
    });
    const failing = alertAfterRun({ id: ID, run: run(), stderrTail: [], secrets: [] }, f.deps);
    while (f.sent.length === 0) await new Promise(r => setTimeout(r, 5));
    expect(await alertAfterRun({ id: ID, run: run({ exitCode: 0 }), stderrTail: [], secrets: [] }, { ...f.deps, enabled: false })).toBe("silent");
    release();
    expect(await failing).toBe("alerted");
    expect(f.sent).toHaveLength(1);
    const state = parseAlerts(await readFile(alertsFile(root), "utf-8")).routines[ID];
    expect(state.series).toBeUndefined();
    expect(state.closing).toBeUndefined();
  });

  test("Erfolg während des Versands, Meldung nicht zugestellt: keine Entwarnung, Serie zu", async () => {
    const root = await freshRoot();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const f = fake(root, async () => {
      await gate;
      return { sent: false, recorded: false, error: { kind: "send" } };
    });
    const failing = alertAfterRun({ id: ID, run: run(), stderrTail: [], secrets: [] }, f.deps);
    while (f.sent.length === 0) await new Promise(r => setTimeout(r, 5));
    expect(await alertAfterRun({ id: ID, run: run({ exitCode: 0 }), stderrTail: [], secrets: [] }, f.deps)).toBe("silent");
    release();
    expect(await failing).toBe("undelivered");
    expect(f.sent).toHaveLength(1);
    expect(parseAlerts(await readFile(alertsFile(root), "utf-8")).routines[ID].series).toBeUndefined();
  });

  test("verwaister Anspruch (älter als 5 Minuten) blockiert nicht", async () => {
    const root = await freshRoot();
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    await writeFile(alertsFile(root), JSON.stringify({ routines: { [ID]: { series: { kind: "failed", since: old, claim: { pid: 1, at: old } } } } }));
    const f = fake(root);
    expect(await alertAfterRun({ id: ID, run: run(), stderrTail: [], secrets: [] }, f.deps)).toBe("alerted");
  });
});

describe("ROUTINE_ALERTS=off", () => {
  test("aus der Umgebung oder der .env: keine Meldungen", async () => {
    const root = await freshRoot();
    expect(alertsEnabled({})).toBe(true);
    expect(alertsEnabled({ ROUTINE_ALERTS: "on" })).toBe(true);
    expect(alertsEnabled({ ROUTINE_ALERTS: " OFF " })).toBe(false);
    expect(cliAlerts(root, { ROUTINE_ALERTS: "off", HOME }).enabled).toBe(false);
    await writeFile(join(root, ".env"), "ROUTINE_ALERTS=off\nTELEGRAM_BOT_TOKEN=123:abc\n");
    expect(cliAlerts(root, { HOME }).enabled).toBe(false);
    await writeFile(join(root, ".env"), "TELEGRAM_BOT_TOKEN=123:abc\n");
    expect(cliAlerts(root, { HOME }).enabled).toBe(true);
  });

  test("abgeschaltet: weder Fehlermeldung noch Entwarnung; ein Erfolg beendet die alte Serie, nach dem Einschalten meldet der nächste Fehler", async () => {
    const root = await freshRoot();
    const since = new Date().toISOString();
    await writeFile(alertsFile(root), JSON.stringify({ routines: { [ID]: { series: { kind: "failed", since, alertedAt: since } } } }));
    const f = fake(root);
    f.deps.enabled = false;
    expect((await wrap(root, f, "exit 1")).alert).toBe("silent");
    expect(parseAlerts(await readFile(alertsFile(root), "utf-8")).routines[ID].series?.kind).toBe("failed");
    expect((await wrap(root, f, "exit 0")).alert).toBe("silent");
    expect((await wrap(root, f, "exit 1")).alert).toBe("silent");
    expect(f.sent).toEqual([]);
    const state = parseAlerts(await readFile(alertsFile(root), "utf-8")).routines[ID];
    expect(state.series).toBeUndefined();
    expect(state.running).toBeUndefined();
    f.deps.enabled = true;
    expect((await wrap(root, f, "exit 1")).alert).toBe("alerted");
    expect(f.sent).toHaveLength(1);
  });

  test("ohne Meldungs-Abhängigkeiten (Tests): alerts.json bleibt unberührt", async () => {
    const root = await freshRoot();
    const r = await runWrapped({ id: ID, command: ["/bin/sh", "-c", "exit 1"], root, secrets: [], stdout: sink, stderr: sink, note: sink, alerts: null });
    expect(r.alert).toBeUndefined();
    expect(await readFile(alertsFile(root), "utf-8").catch(() => null)).toBeNull();
  });

  test("die .env wird nur gelesen, nicht in die Umgebung übernommen (der Befehl sieht sie nicht)", async () => {
    const root = await freshRoot();
    await writeFile(join(root, ".env"), "ROUTINE_TEST_NUR_ENV=sichtbar\n");
    expect(readProjectDotenv(root)).toEqual({ env: { ROUTINE_TEST_NUR_ENV: "sichtbar" }, readable: true });
    const alerts = cliAlerts(root, { HOME });
    expect(alerts).not.toBeNull();
    expect(process.env.ROUTINE_TEST_NUR_ENV).toBeUndefined();
    const out: string[] = [];
    // Nur Beginn festhalten und Erfolg ohne Serie: kein Versand
    await runWrapped({
      id: ID,
      command: ["/bin/sh", "-c", 'printf "%s" "${ROUTINE_TEST_NUR_ENV:-leer}"'],
      root,
      secrets: [],
      stdout: c => out.push(new TextDecoder().decode(c)),
      stderr: sink,
      note: sink,
      alerts: { ...alerts!, send: async () => ({ sent: true }) },
    });
    expect(out.join("")).toBe("leer");
    expect(process.env.ROUTINE_TEST_NUR_ENV).toBeUndefined();
  });
});

describe("Nachtcheck", () => {
  async function write(root: string, id: string, runs: Partial<RoutineRun>[]) {
    const full = runs.map(r => run({ exitCode: 0, ...r }));
    await writeFile(join(root, "data", "routines", `${id}.json`), JSON.stringify({ id, runs: full }));
  }

  test("eine Zeile: alle ok, mit Fehler, ausgeblieben; nur der letzte Lauf zählt", async () => {
    const { evaluateRoutines, formatReport } = await import("../src/health-check");
    const { readRoutinesSummary } = await import("../src/lib/routines/alerts");
    const root = await freshRoot();
    const line = () => formatReport([evaluateRoutines(readRoutinesSummary(root))], new Date("2026-10-15T01:30:00Z"), "Europe/Berlin").split("\n")[1];
    expect(line()).toBe("– Routinen: kein Verlauf (keine Routine eingebunden)");

    await write(root, "ai.tybo.briefing", [{ exitCode: 1 }, { exitCode: 0 }]);
    await write(root, "com.example.watch", [{ exitCode: 0 }]);
    expect(line()).toBe("✅ Routinen: alle ok");

    await write(root, "ai.tybo.health-check", [{ exitCode: 0 }, { exitCode: 1 }]);
    await write(root, "ai.tybo.duo-refresh", [{ exitCode: 0, signal: "SIGTERM" }]);
    expect(line()).toBe("⚠️ Routinen: 2 mit Fehler (duo-refresh, health-check). /routinen <name> zeigt den Verlauf");

    // Ausgeblieben seit nach dem letzten protokollierten Lauf
    const since = new Date(Date.now() + 60_000).toISOString();
    await writeFile(alertsFile(root), JSON.stringify({ routines: { "com.example.watch": { series: { kind: "missed", since, alertedAt: since } }, "ai.tybo.health-check": { series: { kind: "failed", since } } } }));
    expect(line()).toBe("⚠️ Routinen: 2 mit Fehler (duo-refresh, health-check), 1 ausgeblieben (com.example.watch). /routinen <name> zeigt den Verlauf");
  });

  test("alte Ausgeblieben-Serie zählt nach einem erfolgreichen Lauf nicht mehr", async () => {
    const root = await freshRoot();
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    const seeded = { routines: { [ID]: { series: { kind: "missed", since: old, alertedAt: old } } } };
    // Lauf nach dem Beginn der Serie steht im Protokoll, alerts.json ist aber veraltet (etwa von Hand gestartet ohne Abgleich)
    await writeFile(alertsFile(root), JSON.stringify(seeded));
    await write(root, ID, [{ exitCode: 0 }]);
    expect(readRoutinesSummary(root).missed).toEqual([]);
    expect(readRoutinesSummary(root).failed).toEqual([]);

    // Über den Wrapper bei ROUTINE_ALERTS=off: der Erfolg beendet die Serie in alerts.json
    const root2 = await freshRoot();
    await writeFile(alertsFile(root2), JSON.stringify(seeded));
    await write(root2, ID, [{ exitCode: 0, startedAt: new Date(Date.now() - 4 * 3600_000).toISOString() }]);
    expect(readRoutinesSummary(root2).missed).toEqual(["health-check"]);
    const f = fake(root2);
    f.deps.enabled = false;
    await wrap(root2, f, "exit 0");
    expect(parseAlerts(await readFile(alertsFile(root2), "utf-8")).routines[ID].series).toBeUndefined();
    expect(readRoutinesSummary(root2).missed).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  test("der Nachtcheck schickt keine eigenen Einzelmeldungen über die Routinen", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "health-check.ts"), "utf-8");
    expect(source).not.toContain("alertAfterRun");
    expect(source).not.toContain("watchTick");
    expect(source).toContain('{ name: "Routinen", fn:');
  });
});
