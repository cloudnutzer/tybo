/**
 * Issue #284, Checkbox 2: launchd-Quelle und Katalog der Routinen-Zentrale,
 * nur mit Attrappen (tests/routines-fixture.ts).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listRoutines } from "../src/lib/routines/catalog";
import { parseRoutinesConfig } from "../src/lib/routines/config";
import { type Fact, LAUNCHD_TEXT, launchdState, parseLaunchctlList, parsePrintDisabled } from "../src/lib/routines/sources/launchd";
import {
  daemonPlist,
  fakeRoutinesDeps,
  HOME,
  launchctlListOutput,
  printDisabledOutput,
  ROOT,
  scheduledPlist,
} from "./routines-fixture";

const BASE_PLISTS = {
  "ai.tybo.health-check.plist": scheduledPlist("ai.tybo.health-check"),
  "ai.tybo.telegram-relay.plist": daemonPlist("ai.tybo.telegram-relay"),
  "com.example.backup.plist": scheduledPlist("com.example.backup", { StartInterval: 600, StartCalendarInterval: undefined }),
  "com.example.watch.one.plist": scheduledPlist("com.example.watch.one"),
  "com.other.app.plist": scheduledPlist("com.other.app"),
};

const LIST = launchctlListOutput([
  ["-", "0", "ai.tybo.health-check"],
  ["4242", "0", "ai.tybo.telegram-relay"],
  ["-", "1", "com.example.backup"],
  ["-", "0", "com.example.watch.one"],
  ["-", "0", "com.other.app"],
]);

function ids(list: { routines: { id: string }[] }) {
  return list.routines.map(r => r.id);
}

describe("Auswahl der Dienste", () => {
  test("ai.tybo.* erscheint immer, com.example.backup nur über config/routines.json", async () => {
    const without = await listRoutines(fakeRoutinesDeps({ plists: BASE_PLISTS, launchctlList: LIST }));
    expect(ids(without)).toEqual(["ai.tybo.health-check", "ai.tybo.telegram-relay"]);

    const withConfig = await listRoutines(
      fakeRoutinesDeps({ plists: BASE_PLISTS, launchctlList: LIST, config: JSON.stringify({ labels: ["com.example.backup"] }) })
    );
    expect(ids(withConfig)).toContain("com.example.backup");
    expect(ids(withConfig)).not.toContain("com.other.app");
    const backup = withConfig.routines.find(r => r.id === "com.example.backup")!;
    expect(backup).toMatchObject({ name: "com.example.backup", own: false, scheduleText: "alle 10 Minuten", state: "active", lastExit: 1 });
  });

  test("Präfix-Treffer aus config/routines.json", async () => {
    const list = await listRoutines(
      fakeRoutinesDeps({ plists: BASE_PLISTS, launchctlList: LIST, config: JSON.stringify({ prefixes: ["com.example.watch."] }) })
    );
    expect(ids(list)).toEqual(["com.example.watch.one", "ai.tybo.health-check", "ai.tybo.telegram-relay"]);
  });

  test("leere Präfixe und ungültige Einträge nehmen nicht jeden Dienst auf", async () => {
    const list = await listRoutines(
      fakeRoutinesDeps({ plists: BASE_PLISTS, launchctlList: LIST, config: JSON.stringify({ labels: [3, ""], prefixes: ["", "  "] }) })
    );
    expect(ids(list)).toEqual(["ai.tybo.health-check", "ai.tybo.telegram-relay"]);
  });

  test("ungültige Konfiguration: nur tybo-Dienste und ein Hinweis", async () => {
    const list = await listRoutines(fakeRoutinesDeps({ plists: BASE_PLISTS, launchctlList: LIST, config: "{ kaputt" }));
    expect(ids(list)).toEqual(["ai.tybo.health-check", "ai.tybo.telegram-relay"]);
    expect(list.notes[0]).toContain("config/routines.json");
    expect(parseRoutinesConfig("[]").config).toEqual({ labels: [], prefixes: [] });
  });

  test("Konfiguration wird bei jedem Aufruf neu gelesen", async () => {
    const deps = fakeRoutinesDeps({ plists: BASE_PLISTS, launchctlList: LIST });
    expect(ids(await listRoutines(deps))).not.toContain("com.example.backup");
    deps.readFile = path => (path === `${ROOT}/config/routines.json` ? JSON.stringify({ labels: ["com.example.backup"] }) : null);
    expect(ids(await listRoutines(deps))).toContain("com.example.backup");
  });

  test("Label entscheidet, nicht der Dateiname", async () => {
    const list = await listRoutines(
      fakeRoutinesDeps({ plists: { "irgendwas.plist": scheduledPlist("ai.tybo.morning-briefing"), "ai.tybo.fremd.plist": scheduledPlist("com.other.app") } })
    );
    expect(ids(list)).toEqual(["ai.tybo.morning-briefing"]);
  });

  test("ein genanntes Label ohne Plist steht als Hinweis da", async () => {
    const list = await listRoutines(fakeRoutinesDeps({ plists: BASE_PLISTS, config: JSON.stringify({ labels: ["com.example.fehlt"] }) }));
    expect(list.notes.join("\n")).toContain("com.example.fehlt");
  });
});

describe("Zustand und Fehler", () => {
  test("Felder einer tybo-Routine", async () => {
    const list = await listRoutines(fakeRoutinesDeps({ plists: BASE_PLISTS, launchctlList: LIST }));
    expect(list).toMatchObject({ available: true, source: "launchd", notes: [] });
    expect(list.routines[0]).toEqual({
      id: "ai.tybo.health-check",
      name: "health-check",
      kind: "scheduled",
      schedule: { type: "launchd", StartCalendarInterval: { Hour: 3, Minute: 30 }, otherTriggers: [] },
      scheduleText: "täglich 03:30",
      state: "active",
      lastExit: 0,
      logPath: `${ROOT}/logs/ai.tybo.health-check.log`,
      errorLogPath: `${ROOT}/logs/ai.tybo.health-check.error.log`,
      source: "launchd",
      own: true,
      // Issue #285: ohne Wrapper kein Verlauf; nächster Lauf ab 15.10.2026 10:00 Berlin
      wrapped: false,
      lastRun: null,
      nextRun: "2026-10-16T01:30:00.000Z",
      // Issue #288: tatsächlicher Plist, PID und Rohangaben für die Aktionen
      plistPath: `${HOME}/Library/LaunchAgents/ai.tybo.health-check.plist`,
      pid: null,
      facts: { loaded: true, running: false, disabled: false },
    });
  });

  test("Dauerdienst mit PID läuft, ohne PID läuft er nicht", async () => {
    const running = await listRoutines(fakeRoutinesDeps({ plists: BASE_PLISTS, launchctlList: LIST }));
    expect(running.routines.find(r => r.id === "ai.tybo.telegram-relay")).toMatchObject({ kind: "daemon", scheduleText: "Dauerdienst", state: "running" });
    const stopped = await listRoutines(fakeRoutinesDeps({ plists: BASE_PLISTS, launchctlList: launchctlListOutput([["-", "-9", "ai.tybo.telegram-relay"]]) }));
    expect(stopped.routines.find(r => r.id === "ai.tybo.telegram-relay")).toMatchObject({ state: "stopped", lastExit: -9 });
  });

  test("Dauerdienste stehen nach den zeitgesteuerten", async () => {
    const list = await listRoutines(
      fakeRoutinesDeps({ plists: { "a.plist": daemonPlist("ai.tybo.aaa"), "z.plist": scheduledPlist("ai.tybo.zzz") }, launchctlList: LIST })
    );
    expect(ids(list)).toEqual(["ai.tybo.zzz", "ai.tybo.aaa"]);
  });

  test("pausierter Dienst (print-disabled) und nicht geladener Dienst", async () => {
    const list = await listRoutines(
      fakeRoutinesDeps({
        plists: { ...BASE_PLISTS, "ai.tybo.watchdog.plist": scheduledPlist("ai.tybo.watchdog") },
        launchctlList: launchctlListOutput([["4242", "0", "ai.tybo.telegram-relay"]]),
        printDisabled: printDisabledOutput({ "ai.tybo.health-check": true, "ai.tybo.watchdog": false }),
      })
    );
    expect(list.routines.find(r => r.id === "ai.tybo.health-check")).toMatchObject({ state: "paused", lastExit: null });
    expect(list.routines.find(r => r.id === "ai.tybo.watchdog")).toMatchObject({ state: "not-loaded", lastExit: null });
  });

  test("ein kaputter Plist macht nur seine Zeile unbekannt", async () => {
    const list = await listRoutines(fakeRoutinesDeps({ plists: { ...BASE_PLISTS, "ai.tybo.kaputt.plist": null }, launchctlList: LIST }));
    expect(ids(list)).toEqual(["ai.tybo.health-check", "ai.tybo.kaputt", "ai.tybo.telegram-relay"]);
    expect(list.routines.find(r => r.id === "ai.tybo.kaputt")).toEqual({
      id: "ai.tybo.kaputt",
      name: "kaputt",
      kind: "scheduled",
      schedule: null,
      scheduleText: LAUNCHD_TEXT.unreadablePlist,
      state: "unknown",
      lastExit: null,
      logPath: null,
      errorLogPath: null,
      source: "launchd",
      own: true,
      wrapped: false,
      lastRun: null,
      nextRun: null,
      plistPath: null,
      pid: null,
    });
    expect(list.routines.find(r => r.id === "ai.tybo.health-check")?.state).toBe("active");
  });

  test("kaputter fremder Plist ohne Treffer im Dateinamen bleibt draußen", async () => {
    const list = await listRoutines(fakeRoutinesDeps({ plists: { ...BASE_PLISTS, "com.other.kaputt.plist": null }, launchctlList: LIST }));
    expect(ids(list)).not.toContain("com.other.kaputt");
  });

  test("launchctl list scheitert: Liste bleibt, geladen und Exit-Code unbekannt", async () => {
    const list = await listRoutines(
      fakeRoutinesDeps({ plists: BASE_PLISTS, launchctlList: null, printDisabled: printDisabledOutput({ "ai.tybo.health-check": false }) })
    );
    expect(ids(list)).toEqual(["ai.tybo.health-check", "ai.tybo.telegram-relay"]);
    expect(list.routines.map(r => [r.state, r.lastExit])).toEqual([
      ["unknown", null],
      ["unknown", null],
    ]);
    expect(list.routines[0].scheduleText).toBe("täglich 03:30");
    expect(list.notes).toContain(LAUNCHD_TEXT.listFailed);
  });

  test("launchctl list scheitert, print-disabled kennt den Dienst als pausiert", async () => {
    const list = await listRoutines(fakeRoutinesDeps({ plists: BASE_PLISTS, launchctlList: null, printDisabled: printDisabledOutput({ "ai.tybo.health-check": true }) }));
    expect(list.routines[0].state).toBe("paused");
  });

  // Regression aus der Prüfung, Runde 1: Ohne print-disabled galt ein
  // geladener Dienst als sicher aktiv, obwohl er pausiert sein kann.
  test("print-disabled scheitert: zeitgesteuerte Dienste unbekannt, Exit-Codes und Dauerdienste bleiben", async () => {
    const list = await listRoutines(
      fakeRoutinesDeps({
        plists: { ...BASE_PLISTS, "ai.tybo.watchdog.plist": scheduledPlist("ai.tybo.watchdog") },
        launchctlList: LIST,
        printDisabled: null,
      })
    );
    expect(list.routines.find(r => r.id === "ai.tybo.health-check")).toMatchObject({ state: "unknown", lastExit: 0 });
    expect(list.routines.find(r => r.id === "ai.tybo.watchdog")?.state).toBe("unknown");
    expect(list.routines.find(r => r.id === "ai.tybo.telegram-relay")).toMatchObject({ state: "running", lastExit: 0 });
    expect(list.notes).toContain(LAUNCHD_TEXT.disabledFailed);
  });

  // Regression aus der Prüfung, Runde 1: disabled beweist nicht, dass ein
  // Dauerdienst gestoppt ist (ein geladener Prozess läuft weiter).
  test("launchctl list scheitert: deaktivierter Dauerdienst ist unbekannt, nicht gestoppt", async () => {
    const list = await listRoutines(
      fakeRoutinesDeps({ plists: BASE_PLISTS, launchctlList: null, printDisabled: printDisabledOutput({ "ai.tybo.telegram-relay": true }) })
    );
    expect(list.routines.find(r => r.id === "ai.tybo.telegram-relay")).toMatchObject({ state: "unknown", lastExit: null });
  });

  // Die Klasse dahinter: Ein Zustand erscheint nur, wenn alle Angaben, die ihn
  // belegen, bekannt sind. Geprüft über alle Kombinationen der drei Angaben.
  test("Zustandstabelle: jeder Zustand nur mit bekannten Belegen", () => {
    const facts: Fact[] = [true, false, null];
    const needs: Record<string, (f: { loaded: Fact; running: Fact; disabled: Fact }) => boolean> = {
      paused: f => f.disabled === true,
      active: f => f.disabled === false && f.loaded === true,
      "not-loaded": f => f.disabled === false && f.loaded === false,
      running: f => f.loaded === true && f.running === true,
      stopped: f => f.loaded === false || (f.loaded === true && f.running === false),
    };
    for (const loaded of facts) {
      for (const running of loaded === true ? facts : [loaded === false ? false : null]) {
        for (const disabled of facts) {
          const f = { loaded, running, disabled };
          for (const kind of ["scheduled", "daemon"] as const) {
            const state = launchdState(kind, f);
            if (state !== "unknown") expect({ kind, f, state, belegt: needs[state](f) }).toEqual({ kind, f, state, belegt: true });
            // Und umgekehrt: Sind die Belege da, wird der Zustand auch genannt
            const allowed = kind === "daemon" ? ["running", "stopped"] : ["paused", "active", "not-loaded"];
            const proven = allowed.filter(s => needs[s](f));
            if (proven.length) expect({ kind, f, state }).toEqual({ kind, f, state: proven[0] as typeof state });
          }
        }
      }
    }
  });

  test("LaunchAgents nicht lesbar: leere Liste mit Hinweis", async () => {
    const list = await listRoutines(fakeRoutinesDeps({ listDirThrows: true }));
    expect(list).toEqual({ available: true, source: "launchd", routines: [], notes: [LAUNCHD_TEXT.dirUnreadable] });
  });

  test("nur lesende Befehle: plutil, launchctl list und print-disabled", async () => {
    const deps = fakeRoutinesDeps({ plists: BASE_PLISTS, launchctlList: LIST });
    await listRoutines(deps);
    const kinds = new Set(deps.calls.map(c => (c[0] === "plutil" ? c.slice(0, 5).join(" ") : c.join(" "))));
    expect([...kinds].sort()).toEqual(["launchctl list", "launchctl print-disabled gui/501", "plutil -convert json -o -"]);
  });
});

describe("Parser", () => {
  test("launchctl list mit Kopfzeile, Strich und negativem Status", () => {
    const map = parseLaunchctlList("PID\tStatus\tLabel\n123\t0\tai.tybo.a\n-\t-15\tai.tybo.b\n-\t-\tai.tybo.c\n");
    expect(map.get("ai.tybo.a")).toEqual({ pid: 123, lastExit: 0 });
    expect(map.get("ai.tybo.b")).toEqual({ pid: null, lastExit: -15 });
    expect(map.get("ai.tybo.c")).toEqual({ pid: null, lastExit: null });
    expect(map.has("Label")).toBe(false);
  });

  test("print-disabled in alter und neuer Schreibweise", () => {
    const map = parsePrintDisabled('disabled services = {\n\t"a" => disabled\n\t"b" => enabled\n\t"c" => true\n\t"d" => false\n}');
    expect([...map]).toEqual([["a", true], ["b", false], ["c", true], ["d", false]]);
  });
});

describe("Code und Vorlage", () => {
  test("config/routines.example.json nennt nur erfundene Labels, config/routines.json ist ignoriert", () => {
    const repo = join(import.meta.dir, "..");
    const example = JSON.parse(readFileSync(join(repo, "config", "routines.example.json"), "utf-8"));
    for (const label of [...example.labels, ...example.prefixes]) expect(label).toStartWith("com.example.");
    expect(readFileSync(join(repo, ".gitignore"), "utf-8").split("\n")).toContain("config/routines.json");
  });

  test("im Modul steht kein Label außer ai.tybo.* und erfundenen Beispielen", () => {
    const glob = new Bun.Glob("**/*.ts");
    const dir = join(import.meta.dir, "..", "src", "lib", "routines");
    for (const file of glob.scanSync(dir)) {
      const src = readFileSync(join(dir, file), "utf-8");
      const labels = src.match(/\b(?:com|org|net|io|de)\.[a-z0-9-]+\.[a-z0-9.-]+/g) ?? [];
      for (const label of labels) expect({ file, label, ok: label.startsWith("com.example.") }).toEqual({ file, label, ok: true });
    }
  });
});
