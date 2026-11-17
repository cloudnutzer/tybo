/**
 * Issue #485, Schritt 2: tybo wartung (src/lib/maintenance/run.ts) mit
 * --dry-run, Meldung und data/wartung.json. Alles gegen Attrappen: Home und
 * Projekt unter tmp, nachgebautes xcrun, aufgezeichnete Meldung.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTybo } from "../scripts/tybo";
import { readLockOwner } from "../src/lib/file-lock";
import { DEFAULT_CONFIG } from "../src/lib/maintenance/config";
import { MAINTENANCE_ITEMS, type MaintenanceItem } from "../src/lib/maintenance/items";
import { acquireLock, formatBytes, readMaintenanceState, reportText, runMaintenance, runMaintenanceCommand, type MaintenanceState } from "../src/lib/maintenance/run";
import { addDevice, ageDir, makeFixture, oldFile, type Fixture } from "./maintenance-fixture";

const fixtures: Fixture[] = [];
afterEach(() => {
  while (fixtures.length) fixtures.pop()!.cleanup();
});

const MB = 1024 * 1024;

/** Gerät, Cache und großes Log, damit jeder Posten etwas zu tun hat */
function busyFixture(platform: NodeJS.Platform = "darwin"): Fixture {
  const f = makeFixture(platform);
  fixtures.push(f);
  writeFileSync(join(f.root, "config", "wartung.json"), JSON.stringify({ simulatorMuster: ["Test-UI-*"], logs: { abMb: 1, behaltenMb: 0 } }));
  addDevice(f, { name: "Test-UI-1", size: 20_000 });
  addDevice(f, { name: "Test-UI-2", state: "Booted" });
  addDevice(f, { name: "Alt", isAvailable: false });
  const brew = join(f.home, platform === "darwin" ? "Library/Caches" : ".cache", "Homebrew", "downloads");
  oldFile(join(brew, "paket.tar.gz"), 50_000);
  ageDir(brew);
  mkdirSync(join(f.root, "logs"));
  writeFileSync(join(f.root, "logs", "bot.log"), Buffer.alloc(2 * MB));
  return f;
}

async function command(f: Fixture, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMaintenanceCommand(args, { deps: f.deps, out: l => out.push(l), err: l => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const state = (f: Fixture) => JSON.parse(readFileSync(join(f.root, "data", "wartung.json"), "utf8")) as MaintenanceState;

describe("Probelauf", () => {
  test("zeigt Posten mit Größen; löscht, kürzt, sendet und schreibt nichts", async () => {
    const f = busyFixture();
    mkdirSync(join(f.root, "data"));
    const previous = JSON.stringify({ version: 1, lastRun: { startedAt: "vorher" } });
    writeFileSync(join(f.root, "data", "wartung.json"), previous);
    const r = await command(f, ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Probelauf");
    expect(r.out).toContain("Test-UI-1:");
    expect(r.out).toContain("würde gelöscht");
    expect(r.out).toContain("Homebrew-Downloads");
    expect(r.out).toContain("bot.log");
    expect(r.out).not.toContain("Test-UI-2");
    // keine Nebenwirkungen
    expect(f.calls.filter(c => c.includes("delete"))).toEqual([]);
    expect(f.devices).toHaveLength(3);
    expect(existsSync(join(f.home, "Library/Caches/Homebrew/downloads/paket.tar.gz"))).toBe(true);
    expect(statSync(join(f.root, "logs", "bot.log")).size).toBe(2 * MB);
    expect(existsSync(join(f.root, "logs", "bot.log.1"))).toBe(false);
    expect(f.notified).toEqual([]);
    expect(readFileSync(join(f.root, "data", "wartung.json"), "utf8")).toBe(previous);
    expect(existsSync(join(f.root, "data", "wartung.lock"))).toBe(false);
  });
});

describe("Echter Lauf", () => {
  test("räumt ab, meldet frei vorher/nachher und je Posten, schreibt den Zustand", async () => {
    const f = busyFixture();
    f.free = [10 * MB, 30 * MB];
    const r = await command(f, []);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(f.devices.map(d => d.name)).toEqual(["Test-UI-2"]);
    expect(existsSync(join(f.home, "Library/Caches/Homebrew/downloads/paket.tar.gz"))).toBe(false);
    expect(statSync(join(f.root, "logs", "bot.log")).size).toBe(0);
    expect(f.notified).toHaveLength(1);
    const text = f.notified[0];
    expect(text).toContain("Frei vorher: 10 MB, nachher: 30 MB");
    expect(text).toMatch(/- Test-Simulatoren: 1 gelöscht, \d/);
    expect(text).toContain("- Nicht verfügbare Simulatoren: 1 gelöscht");
    expect(text).toContain("- Caches: 1 gelöscht");
    expect(text).toContain("- Logs: 1 gelöscht, 2 MB");
    const s = state(f);
    expect(s.version).toBe(1);
    expect(s.lastRun.status).toBe("ok");
    expect(s.lastRun.dryRun).toBe(false);
    expect(s.lastRun.freeBefore).toBe(10 * MB);
    expect(s.lastRun.freeAfter).toBe(30 * MB);
    expect(s.lastRun.notify).toEqual({ status: "gesendet" });
    expect(s.lastRun.items.map(i => [i.id, i.status, i.count])).toEqual([
      ["test-simulatoren", "ok", 1],
      ["nicht-verfuegbare-simulatoren", "ok", 1],
      ["simulator-laufzeiten", "nichts", 0],
      ["caches", "ok", 1],
      ["logs", "ok", 1],
    ]);
    expect(await readMaintenanceState(f.root)).toEqual(s);
    expect(existsSync(join(f.root, "data", "wartung.lock"))).toBe(false);
  });

  test("Fehler eines Postens stoppt die anderen nicht; Fehler in Meldung und Zustand, Exit 1", async () => {
    const f = busyFixture();
    f.failing.push("xcrun simctl list devices");
    const r = await command(f, []);
    expect(r.code).toBe(1);
    // Caches und Logs trotzdem abgeräumt
    expect(existsSync(join(f.home, "Library/Caches/Homebrew/downloads/paket.tar.gz"))).toBe(false);
    expect(statSync(join(f.root, "logs", "bot.log")).size).toBe(0);
    expect(f.devices).toHaveLength(3);
    expect(f.notified[0]).toContain("mit Fehlern");
    expect(f.notified[0]).toContain("- Test-Simulatoren: Fehler: Gerätebestand nicht abrufbar");
    const s = state(f);
    expect(s.lastRun.status).toBe("fehler");
    expect(s.lastRun.items.find(i => i.id === "caches")!.status).toBe("ok");
  });

  test("Löschen eines Ziels scheitert: nächstes Ziel und nächste Posten laufen weiter", async () => {
    const f = busyFixture();
    addDevice(f, { name: "Test-UI-3" });
    const first = f.devices[0].udid;
    f.failing.push(`xcrun simctl delete ${first}`);
    const r = await command(f, []);
    expect(r.code).toBe(1);
    expect(f.devices.map(d => d.name)).toEqual(["Test-UI-1", "Test-UI-2"]);
    const sims = state(f).lastRun.items[0];
    expect(sims.status).toBe("fehler");
    expect(sims.count).toBe(1);
    expect(sims.errors).toEqual(["Test-UI-1: simctl delete scheiterte (Exit 1)"]);
    expect(statSync(join(f.root, "logs", "bot.log")).size).toBe(0);
  });

  test("ein unlesbarer Cache hält die übrigen Caches nicht auf", async () => {
    const f = busyFixture();
    const pip = join(f.home, "Library/Caches/pip");
    oldFile(join(pip, "sub", "x"), 100);
    ageDir(join(pip, "sub"));
    ageDir(pip);
    chmodSync(join(pip, "sub"), 0o000);
    try {
      const r = await command(f, []);
      expect(r.code).toBe(1);
      const caches = state(f).lastRun.items.find(i => i.id === "caches")!;
      expect(caches.status).toBe("fehler");
      expect(caches.errors.join()).toContain("pip: nicht lesbar");
      expect(caches.count).toBe(1);
      expect(existsSync(join(f.home, "Library/Caches/Homebrew/downloads/paket.tar.gz"))).toBe(false);
    } finally {
      chmodSync(join(pip, "sub"), 0o755);
    }
  });

  test("Zugriffsfehler am Cache-Ordner: Fehler in Meldung und Zustand, Exit 1, Logs laufen weiter", async () => {
    const f = busyFixture();
    const parent = join(f.home, "Library/Caches/Homebrew");
    chmodSync(parent, 0o000);
    try {
      const r = await command(f, []);
      expect(r.code).toBe(1);
    } finally {
      chmodSync(parent, 0o755);
    }
    expect(existsSync(join(parent, "downloads", "paket.tar.gz"))).toBe(true);
    expect(f.notified[0]).toContain("mit Fehlern");
    expect(f.notified[0]).toContain("- Caches: Fehler: Homebrew-Downloads: nicht lesbar (EACCES)");
    const s = state(f);
    expect(s.lastRun.status).toBe("fehler");
    const caches = s.lastRun.items.find(i => i.id === "caches")!;
    expect(caches.status).toBe("fehler");
    expect(caches.errors.join()).toContain("EACCES");
    expect(s.lastRun.items.find(i => i.id === "logs")!.status).toBe("ok");
    expect(statSync(join(f.root, "logs", "bot.log")).size).toBe(0);
  });

  test("Zugriffsfehler an logs/: Fehler in Meldung und Zustand, Exit 1, andere Posten laufen weiter", async () => {
    const f = busyFixture();
    const logs = join(f.root, "logs");
    chmodSync(logs, 0o000);
    try {
      const r = await command(f, []);
      expect(r.code).toBe(1);
    } finally {
      chmodSync(logs, 0o755);
    }
    expect(statSync(join(logs, "bot.log")).size).toBe(2 * MB);
    expect(f.notified[0]).toContain("mit Fehlern");
    expect(f.notified[0]).toMatch(/- Logs: Fehler: .*EACCES/);
    const s = state(f);
    expect(s.lastRun.items.find(i => i.id === "logs")!.status).toBe("fehler");
    expect(s.lastRun.items.find(i => i.id === "caches")!.status).toBe("ok");
    expect(existsSync(join(f.home, "Library/Caches/Homebrew/downloads/paket.tar.gz"))).toBe(false);
  });

  test("Cache nach dem Planen benutzt: in der Meldung als übersprungen genannt", async () => {
    const f = busyFixture();
    const brew = join(f.home, "Library/Caches/Homebrew/downloads");
    // Ein Build schreibt zwischen Planung und Löschen in den Cache
    const cachesItem = MAINTENANCE_ITEMS.find(i => i.id === "caches")!;
    const wrapped: MaintenanceItem = {
      ...cachesItem,
      async plan(ctx) {
        const p = await cachesItem.plan(ctx);
        writeFileSync(join(brew, "frisch.tar.gz"), "neu");
        return p;
      },
    };
    const run = await runMaintenance(f.deps, DEFAULT_CONFIG, false, [wrapped]);
    expect(existsSync(join(brew, "paket.tar.gz"))).toBe(true);
    expect(existsSync(join(brew, "frisch.tar.gz"))).toBe(true);
    const text = reportText(run);
    expect(text).toContain("- Caches: 1 übersprungen");
    expect(text).toContain("Homebrew-Downloads: übersprungen, inzwischen benutzt, bleibt diesmal");
  });

  test("Meldung scheitert: Zustand hält es fest, Exit 1", async () => {
    const f = busyFixture();
    f.notifyFails = true;
    const r = await command(f, []);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Meldung nicht gesendet");
    const s = state(f);
    expect(s.lastRun.notify).toEqual({ status: "fehlgeschlagen", detail: "notify: Exit 1" });
    expect(s.lastRun.status).toBe("fehler");
  });

  test("ungültige config/wartung.json: nichts angefasst, Abbruch gemeldet und festgehalten", async () => {
    const f = busyFixture();
    writeFileSync(join(f.root, "config", "wartung.json"), JSON.stringify({ caches: ["/Users"] }));
    const r = await command(f, []);
    expect(r.code).toBe(1);
    expect(f.calls).toEqual([]);
    expect(existsSync(join(f.home, "Library/Caches/Homebrew/downloads/paket.tar.gz"))).toBe(true);
    expect(f.notified[0]).toContain("abgebrochen");
    expect(state(f).lastRun.error).toContain("caches");
  });

  test("Linux: ohne Xcode-Posten, kein xcrun-Aufruf", async () => {
    const f = busyFixture("linux");
    const r = await command(f, []);
    expect(r.code).toBe(0);
    expect(f.calls).toEqual([]);
    expect(state(f).lastRun.items.map(i => i.id)).toEqual(["caches", "logs"]);
    expect(existsSync(join(f.home, ".cache/Homebrew/downloads/paket.tar.gz"))).toBe(false);
  });
});

describe("Sperre", () => {
  const lockPath = (f: Fixture) => join(f.root, "data", "wartung.lock");
  const DEAD = 999_999_999;
  const isAlive = (pid: number) => pid !== DEAD;

  test("läuft schon eine Wartung: nichts gestartet, Exit 1, kein Zustand", async () => {
    const f = busyFixture();
    const lock = await acquireLock(f.root);
    expect(lock).not.toBeNull();
    const r = await command(f, []);
    expect(r.code).toBe(1);
    expect(r.err).toContain("läuft schon");
    expect(f.calls).toEqual([]);
    expect(existsSync(join(f.root, "data", "wartung.json"))).toBe(false);
    await lock!.release();
  });

  test("Sperre eines beendeten Prozesses wird übernommen", async () => {
    const f = busyFixture();
    mkdirSync(join(f.root, "data"));
    const dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(lockPath(f), JSON.stringify({ token: "alt", pid: dead }));
    expect((await command(f, [])).code).toBe(0);
    expect(existsSync(lockPath(f))).toBe(false);
  });

  test("gleichzeitiger Erwerb: genau einer bekommt die Sperre, sie ist nie leer", async () => {
    const f = busyFixture();
    const locks = await Promise.all(Array.from({ length: 8 }, () => acquireLock(f.root)));
    const winners = locks.filter(l => l !== null);
    expect(winners).toHaveLength(1);
    // Veröffentlicht wird nur fertiger Inhalt: am Pfad steht sofort der Besitzer
    expect(await readLockOwner(lockPath(f))).toEqual(winners[0]!.owner);
    await winners[0]!.release();
    expect(existsSync(lockPath(f))).toBe(false);
  });

  test("zwei übernehmen dieselbe alte Sperre: der zweite löscht die neue nicht und startet nicht", async () => {
    const f = busyFixture();
    mkdirSync(join(f.root, "data"));
    writeFileSync(lockPath(f), JSON.stringify({ token: "alt", pid: DEAD }));

    // B erkennt die alte Sperre und hält genau vor dem Aufbrechen an
    let bSawStale!: () => void;
    const bStale = new Promise<void>(r => (bSawStale = r));
    let resumeB!: () => void;
    const bResume = new Promise<void>(r => (resumeB = r));
    const b = acquireLock(f.root, {
      isAlive,
      onStale: async (_path, owner) => {
        if (owner.token !== "alt") return;
        bSawStale();
        await bResume;
      },
    });
    await bStale;

    // A bricht dieselbe alte Sperre auf und hält jetzt die neue
    const a = await acquireLock(f.root, { isAlive });
    expect(a).not.toBeNull();
    expect(await readLockOwner(lockPath(f))).toEqual(a!.owner);

    // B macht weiter, findet As Sperre, lässt sie stehen und gibt auf
    resumeB();
    expect(await b).toBeNull();
    expect(await readLockOwner(lockPath(f))).toEqual(a!.owner);

    // Ein Lauf, solange A hält: startet nicht
    const r = await runMaintenanceCommand([], { deps: f.deps, out: () => {}, err: () => {}, lock: { isAlive } });
    expect(r).toBe(1);
    expect(f.calls).toEqual([]);
    await a!.release();
    expect(existsSync(lockPath(f))).toBe(false);
  });

  test("Freigabe entfernt nur die eigene Sperre", async () => {
    const f = busyFixture();
    const a = await acquireLock(f.root);
    const foreign = JSON.stringify({ token: "fremd", pid: process.pid });
    writeFileSync(lockPath(f), foreign);
    await a!.release();
    expect(readFileSync(lockPath(f), "utf8")).toBe(foreign);
  });

  test("ungültige Konfiguration bei belegter Sperre: weder Meldung noch Zustand", async () => {
    const f = busyFixture();
    writeFileSync(join(f.root, "config", "wartung.json"), "{ kaputt");
    const lock = await acquireLock(f.root);
    const r = await command(f, []);
    expect(r.code).toBe(1);
    expect(r.err).toContain("läuft schon");
    expect(f.notified).toEqual([]);
    expect(existsSync(join(f.root, "data", "wartung.json"))).toBe(false);
    await lock!.release();
  });
});

describe("Aufruf", () => {
  test("help, unbekannte Argumente", async () => {
    const f = busyFixture();
    expect((await command(f, ["help"])).out).toContain("--dry-run");
    expect((await command(f, ["--loeschen"])).code).toBe(2);
    expect((await command(f, ["--dry-run", "x"])).code).toBe(2);
  });

  test("tybo wartung nimmt den Projektordner aus TYBO_ROOT, nicht aus dem Arbeitsordner", async () => {
    const f = busyFixture();
    const out: string[] = [];
    const code = await runTybo({
      args: ["wartung", "--dry-run"],
      env: { TYBO_ROOT: f.root, HOME: f.home },
      platform: "darwin",
      out: l => out.push(l),
      err: l => out.push(l),
      maintenance: { run: f.deps.run, notify: f.deps.notify, freeBytes: f.deps.freeBytes, now: f.deps.now },
    });
    expect(process.cwd()).not.toBe(f.root);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("bot.log");
    expect(out.join("\n")).toContain("Test-UI-1");
  });

  test("Größen in deutscher Schreibweise", () => {
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1,5 GB");
    expect(formatBytes(300 * MB)).toBe("300 MB");
    expect(formatBytes(null)).toBe("Größe unbekannt");
  });
});
