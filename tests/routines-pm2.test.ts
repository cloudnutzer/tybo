/**
 * Issue #284, Checkbox 3: PM2-Quelle aus einer festen Prozessliste (wie
 * `pm2 jlist` sie zeigt) und Plattformwahl, nur mit Attrappen.
 *
 * Die PM2-CLI startet bei jedem Aufruf einen Daemon, wenn keiner antwortet.
 * Darum fragt die Quelle den laufenden Daemon direkt über seinen RPC-Socket
 * (src/lib/routines/sources/pm2-rpc.ts). Die Tests dafür lassen einen
 * nachgebauten Daemon auf einem Socket im Temp-Ordner antworten; echtes pm2
 * läuft nie.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRoutinesDeps, listRoutines } from "../src/lib/routines/catalog";
import { PM2_TEXT } from "../src/lib/routines/sources/pm2";
import { decodeAmp, encodeAmp, pm2RpcSocketPath, queryPm2Daemon, type Pm2Query } from "../src/lib/routines/sources/pm2-rpc";
import { fakeRoutinesDeps, scheduledPlist } from "./routines-fixture";

/** Gekürzte, feste Prozessliste, wie der Daemon sie für `pm2 jlist` liefert */
const PROCESSES = [
  {
    name: "tybo-telegram-relay",
    pid: 2001,
    pm2_env: {
      status: "online",
      pm_out_log_path: "/home/alex/.pm2/logs/tybo-telegram-relay-out.log",
      pm_err_log_path: "/home/alex/.pm2/logs/tybo-telegram-relay-error.log",
      exit_code: 0,
      env: { TELEGRAM_BOT_TOKEN: "geheim-darf-nicht-raus" },
    },
  },
  { name: "tybo-health-check", pid: 0, pm2_env: { status: "stopped", cron_restart: "30 3 * * *", exit_code: 1 } },
  { name: "tybo-watchdog", pid: 0, pm2_env: { status: "errored" } },
  { name: "fremder-prozess", pid: 3001, pm2_env: { status: "online" } },
];

const isPm2Cli = (cmd: string[]) => /(^|[\\/])pm2(\.cmd|\.exe)?$/.test(cmd[0]) || (cmd[0].endsWith("npx") && cmd[1] === "pm2");

describe("Prozessliste vom PM2-Daemon", () => {
  test("nur tybo-*, Status, cron_restart als Zeitplan, exit_code", async () => {
    const list = await listRoutines(fakeRoutinesDeps({ platform: "linux", pm2Path: "/usr/bin/pm2", pm2: { status: "ok", processes: PROCESSES } }));
    expect(list).toMatchObject({ available: true, source: "pm2", notes: [] });
    expect(list.routines).toEqual([
      {
        id: "tybo-health-check",
        name: "health-check",
        kind: "scheduled",
        schedule: { type: "cron", cron: "30 3 * * *" },
        scheduleText: "täglich 03:30",
        state: "active",
        lastExit: 1,
        logPath: null,
        errorLogPath: null,
        source: "pm2",
        own: true,
        wrapped: false,
        lastRun: null,
        nextRun: null,
      },
      {
        id: "tybo-telegram-relay",
        name: "telegram-relay",
        kind: "daemon",
        schedule: { type: "cron", cron: null },
        scheduleText: "Dauerdienst",
        state: "running",
        lastExit: 0,
        logPath: "/home/alex/.pm2/logs/tybo-telegram-relay-out.log",
        errorLogPath: "/home/alex/.pm2/logs/tybo-telegram-relay-error.log",
        source: "pm2",
        own: true,
        wrapped: false,
        lastRun: null,
        nextRun: null,
      },
      {
        id: "tybo-watchdog",
        name: "watchdog",
        kind: "daemon",
        schedule: { type: "cron", cron: null },
        scheduleText: "Dauerdienst",
        state: "stopped",
        lastExit: null,
        logPath: null,
        errorLogPath: null,
        source: "pm2",
        own: true,
        wrapped: false,
        lastRun: null,
        nextRun: null,
      },
    ]);
    expect(JSON.stringify(list)).not.toContain("geheim");
  });

  // Regression aus der Prüfung, Runde 2: PM2 schaltet den Cron-Neustart mit
  // cron_restart "0" bzw. 0 ab; das ist kein Zeitplan, sondern ein Dauerdienst
  test("cron_restart \"0\" und 0: Dauerdienst mit running/stopped", async () => {
    const processes = [
      { name: "tybo-a", pm2_env: { status: "online", cron_restart: "0" } },
      { name: "tybo-b", pm2_env: { status: "stopped", cron_restart: "0" } },
      { name: "tybo-c", pm2_env: { status: "online", cron_restart: 0 } },
      { name: "tybo-d", pm2_env: { status: "stopped", cron_restart: 0 } },
    ];
    const list = await listRoutines(fakeRoutinesDeps({ platform: "linux", pm2Path: "/usr/bin/pm2", pm2: { status: "ok", processes } }));
    expect(list.routines.map(r => [r.id, r.kind, r.schedule, r.scheduleText, r.state])).toEqual([
      ["tybo-a", "daemon", { type: "cron", cron: null }, "Dauerdienst", "running"],
      ["tybo-b", "daemon", { type: "cron", cron: null }, "Dauerdienst", "stopped"],
      ["tybo-c", "daemon", { type: "cron", cron: null }, "Dauerdienst", "running"],
      ["tybo-d", "daemon", { type: "cron", cron: null }, "Dauerdienst", "stopped"],
    ]);
  });

  test("Daemon läuft nicht oder antwortet nicht: Hinweis, leere Liste", async () => {
    const notRunning = await listRoutines(fakeRoutinesDeps({ platform: "linux", pm2Path: "/usr/bin/pm2", pm2: { status: "not-running" } }));
    expect(notRunning).toEqual({ available: true, source: "pm2", sources: ["pm2"], routines: [], notes: [PM2_TEXT.notRunning] });
    const failed = await listRoutines(fakeRoutinesDeps({ platform: "linux", pm2Path: "/usr/bin/pm2", pm2: { status: "failed" } }));
    expect(failed).toEqual({ available: true, source: "pm2", sources: ["pm2"], routines: [], notes: [PM2_TEXT.listFailed] });
  });

  test("unbrauchbare Einträge in der Liste werden übersprungen", async () => {
    const list = await listRoutines(
      fakeRoutinesDeps({ platform: "linux", pm2Path: "/usr/bin/pm2", pm2: { status: "ok", processes: [null, 3, "x", { name: "tybo-a", pm2_env: null }] } })
    );
    expect(list.routines.map(r => [r.id, r.state])).toEqual([["tybo-a", "unknown"]]);
  });

  // Regression aus der Prüfung, Runde 1: Eine Vorprüfung (pm2.pid) mit
  // anschließendem `pm2 jlist` konnte einen Daemon starten (veraltete PID,
  // Daemon endet zwischen Prüfung und Abfrage). Die Klasse ist ausgeschlossen,
  // weil die PM2-CLI in keinem Fall aufgerufen wird.
  test("PM2-CLI wird in keinem Fall aufgerufen, gleich was der Daemon antwortet", async () => {
    const answers: Pm2Query[] = [{ status: "ok", processes: PROCESSES }, { status: "not-running" }, { status: "failed" }];
    for (const pm2 of answers) {
      const deps = fakeRoutinesDeps({ platform: "linux", pm2Path: "/usr/bin/pm2", pm2 });
      await listRoutines(deps);
      expect(deps.calls).toEqual([["<pm2-daemon>", "getMonitorData"]]);
    }
  });

  test("im Modul startet kein Code die PM2-CLI", () => {
    const glob = new Bun.Glob("**/*.ts");
    const dir = join(import.meta.dir, "..", "src", "lib", "routines");
    for (const file of glob.scanSync(dir)) {
      const src = readFileSync(join(dir, file), "utf-8");
      expect({ file, spawnsPm2: /\[\s*["'`](?:pm2|npx)["'`]/.test(src) }).toEqual({ file, spawnsPm2: false });
    }
  });
});

describe("RPC-Abfrage am Daemon (nachgebauter Daemon, echtes pm2 läuft nie)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm2rpc-"));
  const servers: Server[] = [];
  afterAll(() => {
    for (const s of servers) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Daemon, der auf jede vollständige Anfrage mit answer(anfrage) reagiert */
  async function fakeDaemon(name: string, answer: (sock: Socket, request: unknown[]) => void): Promise<string> {
    const path = join(dir, name);
    const server = createServer(sock => {
      let buf = Buffer.alloc(0);
      sock.on("data", chunk => {
        buf = Buffer.concat([buf, chunk]);
        const msg = decodeAmp(buf);
        if (msg) answer(sock, msg.args);
      });
      sock.on("error", () => {});
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(path, resolve));
    return path;
  }

  test("Anfrage wie pm2 jlist, Antwort in Stücken", async () => {
    let request: unknown[] = [];
    const path = await fakeDaemon("ok.sock", (sock, args) => {
      request = args;
      const reply = encodeAmp([{ args: [PROCESSES] }, args[1]]);
      sock.write(reply.subarray(0, 7));
      setTimeout(() => sock.write(reply.subarray(7)), 20);
    });
    expect(await queryPm2Daemon(path)).toEqual({ status: "ok", processes: PROCESSES });
    expect(request[0]).toEqual({ type: "call", method: "getMonitorData", args: [{}] });
    expect(typeof request[1]).toBe("string");
  });

  test("kein Socket: PM2 läuft nicht", async () => {
    expect(await queryPm2Daemon(join(dir, "fehlt.sock"))).toEqual({ status: "not-running" });
  });

  test("veralteter Socket ohne Daemon dahinter: PM2 läuft nicht", async () => {
    const path = join(dir, "alt.sock");
    writeFileSync(path, "");
    expect(await queryPm2Daemon(path)).toEqual({ status: "not-running" });
  });

  test("Daemon endet zwischen Verbindung und Antwort: gescheitert, nichts gestartet", async () => {
    const path = await fakeDaemon("weg.sock", sock => sock.destroy());
    expect(await queryPm2Daemon(path)).toEqual({ status: "failed" });
  });

  test("Daemon antwortet nicht: gescheitert nach der Zeitgrenze", async () => {
    const path = await fakeDaemon("stumm.sock", () => {});
    expect(await queryPm2Daemon(path, 100)).toEqual({ status: "failed" });
  });

  test("Fehlerantwort und Unsinn: gescheitert", async () => {
    const err = await fakeDaemon("fehler.sock", (sock, args) => sock.write(encodeAmp([{ error: "kaputt" }, args[1]])));
    expect(await queryPm2Daemon(err)).toEqual({ status: "failed" });
    const junk = await fakeDaemon("unsinn.sock", (sock, args) => sock.write(encodeAmp([{ args: [{ a: 1 }] }, args[1]])));
    expect(await queryPm2Daemon(junk)).toEqual({ status: "failed" });
  });

  test.skipIf(process.platform === "win32")("veraltete pm2.pid auf einen lebenden Prozess: echte Verdrahtung sagt „läuft nicht“", async () => {
    const pm2Home = join(dir, "pm2-home");
    mkdirSync(pm2Home);
    writeFileSync(join(pm2Home, "pm2.pid"), String(process.pid));
    const deps = defaultRoutinesDeps(dir, { HOME: dir, PM2_HOME: pm2Home });
    expect(await deps.pm2Query()).toEqual({ status: "not-running" });
  });

  test("AMP-Rahmen wie pm2-axon", () => {
    const buf = encodeAmp([{ a: 1 }, "x:1"]);
    expect([...buf.subarray(0, 5)]).toEqual([0x12, 0, 0, 0, 9]);
    expect(buf.subarray(5, 14).toString()).toBe('j:{"a":1}');
    expect(decodeAmp(buf)).toEqual({ args: [{ a: 1 }, "x:1"], rest: Buffer.alloc(0) });
    expect(decodeAmp(buf.subarray(0, 10))).toBeNull();
  });

  test("Socket-Pfad: PM2_HOME/rpc.sock, Windows feste Named Pipe", () => {
    expect(pm2RpcSocketPath("linux", "/home/alex/.pm2")).toBe("/home/alex/.pm2/rpc.sock");
    expect(pm2RpcSocketPath("win32", "C:\\Users\\alex\\.pm2")).toBe("\\\\.\\pipe\\rpc.sock");
  });
});

describe("Plattformwahl", () => {
  test("macOS: launchd, nie PM2", async () => {
    const deps = fakeRoutinesDeps({ platform: "darwin", pm2Path: "/opt/homebrew/bin/pm2", plists: { "a.plist": scheduledPlist("ai.tybo.a") } });
    const list = await listRoutines(deps);
    expect(list.source).toBe("launchd");
    expect(deps.calls.some(c => c[0] === "<pm2-daemon>" || isPm2Cli(c))).toBe(false);
  });

  test("Linux mit pm2: PM2 über den Daemon", async () => {
    const deps = fakeRoutinesDeps({ platform: "linux", pm2Path: "/usr/bin/pm2" });
    const list = await listRoutines(deps);
    expect(list.source).toBe("pm2");
    expect(deps.calls).toEqual([["<pm2-daemon>", "getMonitorData"]]);
  });

  test("Linux ohne pm2: nicht verfügbar, kein Aufruf", async () => {
    const deps = fakeRoutinesDeps({ platform: "linux", pm2Path: null });
    expect(await listRoutines(deps)).toEqual({ available: false, source: null, routines: [], notes: [] });
    expect(deps.calls).toEqual([]);
  });

  test("Windows mit pm2: PM2", async () => {
    expect((await listRoutines(fakeRoutinesDeps({ platform: "win32", pm2Path: "C:\\pm2.cmd" }))).source).toBe("pm2");
  });
});
