/**
 * Issue #284, Checkbox 5: GET /api/routines über den Server. Quelle ist
 * listRoutines mit Attrappen (tests/routines-fixture.ts) bzw. eine feste
 * Liste; nie launchctl, plutil oder pm2.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRoutines, routineHistory } from "../src/lib/routines/catalog";
import { startWebUi } from "../src/web/startup";
import { createDemoRoutines, DEMO_ROUTINES } from "../src/web/demo";
import { homeRelativePath, LAST_RUN_API_FIELDS, ROUTINE_API_FIELDS, ROUTINES_API_TEXT, routinesApiBody, RUN_API_FIELDS, scrubHome, type RoutineInput, type RoutinesPort } from "../src/web/routines";
import type { WebServer, WebServerDeps } from "../src/web/server";
import { daemonPlist, fakeRoutinesDeps, HOME, launchctlListOutput, ROOT, runFile, scheduledPlist, wrappedPlist } from "./routines-fixture";
import { topicServer } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "routines-api-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

function fixturePort(): RoutinesPort {
  const deps = fakeRoutinesDeps({
    plists: {
      "ai.tybo.health-check.plist": scheduledPlist("ai.tybo.health-check"),
      "ai.tybo.telegram-relay.plist": daemonPlist("ai.tybo.telegram-relay"),
      "com.example.backup.plist": scheduledPlist("com.example.backup", { StandardOutPath: "/var/log/backup.log", StandardErrorPath: `${HOME}/../other/err.log` }),
    },
    config: JSON.stringify({ labels: ["com.example.backup"] }),
    launchctlList: launchctlListOutput([["99", "0", "ai.tybo.telegram-relay"]]),
  });
  return { home: HOME, list: () => listRoutines(deps) };
}

describe("GET /api/routines", () => {
  test("ohne Anmeldung 401", async () => {
    const ctx = await topicServer(root, servers, null, { routines: fixturePort() });
    const res = await fetch(`${ctx.origin}/api/routines`, { headers: { origin: ctx.origin } });
    expect(res.status).toBe(401);
  });

  test("nur erlaubte Felder, Pfade mit ~, keine absoluten Home-Pfade", async () => {
    const ctx = await topicServer(root, servers, null, { routines: fixturePort() });
    const res = await ctx.api("/api/routines");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(HOME);
    expect(raw).not.toContain("/Users/");
    const body = JSON.parse(raw);
    expect(Object.keys(body).sort()).toEqual(["available", "notes", "routines", "source"]);
    expect(body.available).toBe(true);
    expect(body.source).toBe("launchd");
    for (const r of body.routines) expect(Object.keys(r).sort()).toEqual([...ROUTINE_API_FIELDS].sort());
    const health = body.routines.find((r: any) => r.id === "ai.tybo.health-check");
    expect(health).toMatchObject({
      name: "health-check",
      scheduleText: "täglich 03:30",
      logPath: "~/tybo/logs/ai.tybo.health-check.log",
      errorLogPath: "~/tybo/logs/ai.tybo.health-check.error.log",
      own: true,
    });
    // Außerhalb des Home-Ordners und mit „.." heraus: null, nie ein künstliches ~/../
    const backup = body.routines.find((r: any) => r.id === "com.example.backup");
    expect(backup).toMatchObject({ own: false, logPath: null, errorLogPath: null });
    expect(raw).not.toContain("~/..");
    expect(body.routines.find((r: any) => r.id === "ai.tybo.telegram-relay")).toMatchObject({ kind: "daemon", state: "running" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // Regression aus der Prüfung, Runde 1: Ein unbekannter Kalenderschlüssel
  // landet als Rohwert im Zeitplan-Text, und der ging ungefiltert hinaus.
  test("Home-Pfad im Zeitplan-Rohwert: vom Plist über den Katalog bis zur Antwort entfernt", async () => {
    const deps = fakeRoutinesDeps({
      plists: { "ai.tybo.extra.plist": scheduledPlist("ai.tybo.extra", { StartCalendarInterval: { Hour: 6, Minute: 30, Extra: `${HOME}/private/config` } }) },
    });
    const ctx = await topicServer(root, servers, null, { routines: { home: HOME, list: () => listRoutines(deps) } });
    const raw = await (await ctx.api("/api/routines")).text();
    expect(raw).not.toContain(HOME);
    expect(JSON.parse(raw).routines[0].scheduleText).toBe('eigener Zeitplan ({"Hour":6,"Minute":30,"Extra":"~/private/config"})');
  });

  test("nicht verfügbar und leer", async () => {
    const off = await topicServer(root, servers, null, { routines: createDemoRoutines("unavailable") });
    expect(await (await off.api("/api/routines")).json()).toEqual({ available: false, source: null, routines: [], notes: [] });
    const empty = await topicServer(root, servers, null, { routines: createDemoRoutines("empty") });
    expect(await (await empty.api("/api/routines")).json()).toEqual({ available: true, source: "launchd", routines: [], notes: [] });
  });

  test("Fehler der Quelle: 500 mit festem Text, Fehlermeldung nur im Log", async () => {
    const ctx = await topicServer(root, servers, null, {
      routines: { home: HOME, list: async () => { throw new Error(`plutil in ${HOME}/geheim gescheitert`); } },
    });
    const res = await ctx.api("/api/routines");
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({ error: ROUTINES_API_TEXT.failed });
    expect(raw).not.toContain("geheim");
    expect(ctx.logs.some(l => l.includes("Routinen nicht lesbar"))).toBe(true);
  });

  test("ohne Port 503, nur GET", async () => {
    const ctx = await topicServer(root, servers, null);
    expect((await ctx.api("/api/routines")).status).toBe(503);
    const withPort = await topicServer(root, servers, null, { routines: fixturePort() });
    expect((await withPort.api("/api/routines", "POST", {})).status).toBe(405);
  });
});

// --- Issue #285: letzter und nächster Lauf, Verlauf ---------------------------------

const HEALTH = "ai.tybo.health-check";
const SECRET = "GEHEIM-0815-wert";

function historyPort(): RoutinesPort {
  const deps = {
    ...fakeRoutinesDeps({
      plists: {
        "ai.tybo.health-check.plist": wrappedPlist(HEALTH),
        "ai.tybo.telegram-relay.plist": daemonPlist("ai.tybo.telegram-relay"),
      },
      launchctlList: launchctlListOutput([["-", "0", HEALTH]]),
      runFiles: {
        [HEALTH]: runFile(HEALTH, [
          { startedAt: "2026-10-13T01:30:00.000Z", durationMs: 4_000, exitCode: 0, tail: ["erster"] },
          { startedAt: "2026-10-14T01:30:00.000Z", durationMs: 3_000, exitCode: 143, signal: "SIGTERM", tail: ["abgebrochen"] },
          {
            startedAt: "2026-10-15T01:30:00.000Z",
            durationMs: 12_000,
            exitCode: 1,
            tail: [`Fehler in ${HOME}/tybo/src/health-check.ts`, `schluessel=${SECRET}`],
            logPath: `${ROOT}/logs/health-check.error.log`,
          },
        ]),
      },
    }),
    secrets: () => [SECRET],
  };
  return { home: HOME, list: () => listRoutines(deps), runs: id => routineHistory(deps, id, "id") };
}

describe("Issue #285: lastRun und nextRun in GET /api/routines", () => {
  test("letzter Lauf ohne Ausgabe und Pfad, nächster Lauf als ISO, wrapped", async () => {
    const ctx = await topicServer(root, servers, null, { routines: historyPort() });
    const raw = await (await ctx.api("/api/routines")).text();
    expect(raw).not.toContain(SECRET);
    const health = JSON.parse(raw).routines.find((r: any) => r.id === HEALTH);
    expect(health.wrapped).toBe(true);
    expect(Object.keys(health.lastRun).sort()).toEqual([...LAST_RUN_API_FIELDS].sort());
    expect(health.lastRun).toEqual({ startedAt: "2026-10-15T01:30:00.000Z", endedAt: "2026-10-15T01:30:00.000Z", durationMs: 12_000, exitCode: 1, signal: null });
    expect(health.nextRun).toBe("2026-10-16T01:30:00.000Z");
    const relay = JSON.parse(raw).routines.find((r: any) => r.id === "ai.tybo.telegram-relay");
    expect(relay).toMatchObject({ wrapped: false, lastRun: null, nextRun: null });
  });
});

describe("Issue #285: GET /api/routines/<id>/runs", () => {
  test("ohne Anmeldung 401", async () => {
    const ctx = await topicServer(root, servers, null, { routines: historyPort() });
    const res = await fetch(`${ctx.origin}/api/routines/${HEALTH}/runs`, { headers: { origin: ctx.origin } });
    expect(res.status).toBe(401);
  });

  test("Läufe neueste zuerst, nur erlaubte Felder, maskiert, Pfade mit ~", async () => {
    const ctx = await topicServer(root, servers, null, { routines: historyPort() });
    const res = await ctx.api(`/api/routines/${HEALTH}/runs`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const raw = await res.text();
    expect(raw).not.toContain(HOME);
    expect(raw).not.toContain("/Users/");
    expect(raw).not.toContain(SECRET);
    const body = JSON.parse(raw);
    expect(Object.keys(body).sort()).toEqual(["routine", "runs"]);
    expect(Object.keys(body.routine).sort()).toEqual([...ROUTINE_API_FIELDS].sort());
    expect(body.runs.map((r: any) => r.startedAt)).toEqual(["2026-10-15T01:30:00.000Z", "2026-10-14T01:30:00.000Z", "2026-10-13T01:30:00.000Z"]);
    for (const r of body.runs) expect(Object.keys(r).sort()).toEqual([...RUN_API_FIELDS].sort());
    expect(body.runs[0]).toMatchObject({ exitCode: 1, signal: null, tail: ["Fehler in ~/tybo/src/health-check.ts", "schluessel=[verborgen]"], logPath: "~/tybo/logs/health-check.error.log" });
    expect(body.runs[1]).toMatchObject({ exitCode: 143, signal: "SIGTERM" });
    // Ohne eigenen Log-Pfad gilt der Fehler-Log aus dem Plist
    expect(body.runs[2].logPath).toBe(`~/tybo/logs/${HEALTH}.error.log`);
  });

  test("unbekannte Routine 404, Name statt Label 404, ungültige id 400", async () => {
    const ctx = await topicServer(root, servers, null, { routines: historyPort() });
    expect((await ctx.api("/api/routines/ai.tybo.gibt-es-nicht/runs")).status).toBe(404);
    expect(await (await ctx.api("/api/routines/health-check/runs")).json()).toEqual({ error: ROUTINES_API_TEXT.unknown });
    for (const bad of ["ai.tybo..x", "a%2Fb", "..%2F..%2Fetc", "%E0%A4%A", "a%20b", ".versteckt"]) {
      const res = await ctx.api(`/api/routines/${bad}/runs`);
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
    }
  });

  test("Fehler der Quelle 500 mit festem Text; ohne runs im Port 503; nur GET", async () => {
    const failing = await topicServer(root, servers, null, {
      routines: { home: HOME, list: async () => ({ available: true, source: "launchd", routines: [], notes: [] }), runs: async () => { throw new Error(`kaputt in ${HOME}/geheim`); } },
    });
    const res = await failing.api(`/api/routines/${HEALTH}/runs`);
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({ error: ROUTINES_API_TEXT.runsFailed });
    expect(raw).not.toContain("geheim");
    expect(failing.logs.some(l => l.includes("Verlauf der Routine nicht lesbar"))).toBe(true);
    const noRuns = await topicServer(root, servers, null, { routines: fixturePort() });
    expect((await noRuns.api(`/api/routines/${HEALTH}/runs`)).status).toBe(503);
    const noPort = await topicServer(root, servers, null);
    expect((await noPort.api(`/api/routines/${HEALTH}/runs`)).status).toBe(503);
    const ok = await topicServer(root, servers, null, { routines: historyPort() });
    expect((await ok.api(`/api/routines/${HEALTH}/runs`, "POST", {})).status).toBe(405);
  });

  test("Demo-Attrappe: Verlauf für eingebundene, leer für smart-checkin, 404 sonst", async () => {
    const ctx = await topicServer(root, servers, null, { routines: createDemoRoutines() });
    const health = await (await ctx.api("/api/routines/ai.tybo.health-check/runs")).json();
    expect(health.runs.length).toBe(3);
    expect((await (await ctx.api("/api/routines/ai.tybo.smart-checkin/runs")).json()).runs).toEqual([]);
    expect((await ctx.api("/api/routines/ai.tybo.gibt-es-nicht/runs")).status).toBe(404);
  });
});

describe("Felder und Pfade", () => {
  test("zusätzliche Felder der Quelle (Plist, Fehler) gehen nicht heraus", () => {
    const body = routinesApiBody(
      {
        available: true,
        source: "launchd",
        routines: [{ ...DEMO_ROUTINES[0], schedule: { type: "launchd" }, plist: { EnvironmentVariables: { TOKEN: "x" } }, stderr: "boom" } as any],
        notes: [`Ordner ${HOME}/Library/LaunchAgents nicht lesbar`],
      },
      HOME
    );
    expect(Object.keys(body.routines[0]).sort()).toEqual([...ROUTINE_API_FIELDS].sort());
    expect(body.notes).toEqual(["Ordner ~/Library/LaunchAgents nicht lesbar"]);
  });

  // Die Klasse dahinter: Nicht einzelne Felder werden bereinigt, sondern jede
  // Zeichenkette der Antwort. Der Home-Pfad in jedem Feld der Quelle, auch in
  // JSON-Schreibweise eines Windows-Pfads, kommt nie heraus.
  test("Home-Pfad in irgendeinem Feld der Quelle kommt nie heraus", () => {
    for (const home of [HOME, "C:\\Users\\alex"]) {
      const forms = [home, JSON.stringify(home).slice(1, -1)];
      const base: RoutineInput = { ...DEMO_ROUTINES[0] };
      for (const key of Object.keys(base) as (keyof RoutineInput)[]) {
        for (const form of forms) {
          const routine = { ...base, [key]: `vorn ${form}${home.includes("\\") ? "\\" : "/"}x hinten` };
          const body = routinesApiBody({ available: true, source: "launchd", routines: [routine as RoutineInput], notes: [`Hinweis ${form}`] }, home);
          const raw = JSON.stringify(body);
          expect({ home, key, leaked: raw.includes(home) || raw.includes(JSON.stringify(home).slice(1, -1)) }).toEqual({ home, key, leaked: false });
        }
      }
    }
  });

  test("scrubHome ersetzt nur ganze Pfad-Anfänge", () => {
    expect(scrubHome({ a: ["/Users/alex/x", "/Users/alexander/x", "/Users/alex"] }, "/Users/alex/")).toEqual({ a: ["~/x", "/Users/alexander/x", "~"] });
  });

  test("homeRelativePath", () => {
    expect(homeRelativePath("/Users/alex/tybo/logs/a.log", "/Users/alex")).toBe("~/tybo/logs/a.log");
    expect(homeRelativePath("/Users/alex", "/Users/alex/")).toBe("~");
    expect(homeRelativePath("/Users/alexander/a.log", "/Users/alex")).toBeNull();
    expect(homeRelativePath("/var/log/a.log", "/Users/alex")).toBeNull();
    expect(homeRelativePath("/Users/alex/../bob/a.log", "/Users/alex")).toBeNull();
    expect(homeRelativePath("logs/a.log", "/Users/alex")).toBeNull();
    expect(homeRelativePath(null, "/Users/alex")).toBeNull();
    expect(homeRelativePath("C:\\Users\\alex\\.pm2\\logs\\a.log", "C:\\Users\\alex")).toBe("~/.pm2/logs/a.log");
  });

  test("Demo-Attrappe liefert nur Beispieldaten ohne echte Labels", async () => {
    const list = await createDemoRoutines().list();
    for (const r of list.routines) expect(r.id.startsWith("ai.tybo.") || r.id.startsWith("com.example.")).toBe(true);
  });
});

describe("Verdrahtung", () => {
  test("startWebUi reicht routines an createServer weiter", async () => {
    const routines = createDemoRoutines();
    let received: WebServerDeps | null = null;
    await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: "test-passwort-lang" },
      chat: { runTurn: async () => ({ text: "" }), stop() {} },
      routines,
      createServer: async (_config, deps) => {
        received = deps;
        return { url: "http://127.0.0.1:3100", eventStreamCount: () => 0, stop: async () => {} } as WebServer;
      },
      log: () => {},
      lanAddresses: () => [],
    });
    expect(received!.routines).toBe(routines);
  });

  // Übergabe im Bot: tests/app-bot-web.test.ts (Issue #344)
  test("web:dev nutzt die Attrappe", async () => {
    const repo = join(import.meta.dir, "..");
    const dev = await Bun.file(join(repo, "scripts", "web-dev.ts")).text();
    expect(dev).toContain("routines: createDemoRoutines(),");
  });
});
