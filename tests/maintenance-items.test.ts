/**
 * Issue #485, Schritt 1: Postenliste der Wartung (src/lib/maintenance/items.ts)
 * und config/wartung.json (src/lib/maintenance/config.ts). Alles gegen
 * Attrappen: Home- und Projektordner unter tmp, nachgebautes xcrun.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_IDS, DEFAULT_CONFIG, loadMaintenanceConfig, matchesPattern, MaintenanceConfigError, parseMaintenanceConfig, type MaintenanceConfig } from "../src/lib/maintenance/config";
import { cacheRelativePath, InventoryError, itemsFor, MAINTENANCE_ITEMS, parseDevices, type ItemPlan } from "../src/lib/maintenance/items";
import { addDevice, ageDir, HOUR, makeFixture, NOW, oldFile, udid, type Fixture } from "./maintenance-fixture";

const fixtures: Fixture[] = [];
afterEach(() => {
  while (fixtures.length) fixtures.pop()!.cleanup();
});
const fixture = (platform: NodeJS.Platform = "darwin") => {
  const f = makeFixture(platform);
  fixtures.push(f);
  return f;
};

const item = (id: string) => MAINTENANCE_ITEMS.find(i => i.id === id)!;
const config = (over: Partial<MaintenanceConfig> = {}): MaintenanceConfig => ({ ...DEFAULT_CONFIG, ...over });
const plan = (f: Fixture, id: string, over: Partial<MaintenanceConfig> = {}): Promise<ItemPlan> => item(id).plan({ deps: f.deps, config: config(over) });
const PATTERN = ["Test-UI-*"];

describe("config/wartung.json", () => {
  test("fehlt die Datei: Standards, Muster leer, Laufzeiten nur melden, alle Caches", async () => {
    const f = fixture();
    const c = await loadMaintenanceConfig(f.root);
    expect(c.simulatorPatterns).toEqual([]);
    expect(c.deleteRuntimes).toBe(false);
    expect(c.caches).toEqual([...CACHE_IDS]);
  });

  test("Vorlage im Repo ist gültig und neutral", () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, "..", "config", "wartung.example.json"), "utf8"));
    const c = parseMaintenanceConfig(raw);
    expect(c.simulatorPatterns).toEqual([]);
    expect(c.deleteRuntimes).toBe(false);
  });

  test("Pfade, Befehle und unbekannte Kennungen werden abgewiesen", () => {
    for (const bad of [
      { caches: ["~/Library/Caches"] },
      { caches: ["/"] },
      { caches: ["Library/Caches"] },
      { befehl: "rm -rf ~" },
      { pfade: ["~/Downloads"] },
      { simulatorMuster: "Test-*" },
      { simulatorMuster: ["*"] },
      { simulatorMuster: ["a*b"] },
      { simulatorMuster: ["$(rm)*"] },
      { runtimesLoeschen: "ja" },
      { logs: { abMb: 5, behaltenMb: 10 } },
      { logs: { pfad: "/var/log" } },
      [],
    ]) {
      expect(() => parseMaintenanceConfig(bad)).toThrow(MaintenanceConfigError);
    }
  });

  test("kaputtes JSON bricht ab statt Standards zu nehmen", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "config", "wartung.json"), "{ kaputt");
    await expect(loadMaintenanceConfig(f.root)).rejects.toThrow(MaintenanceConfigError);
  });

  test("Muster: ganzer Name, * und ?, sonst nichts", () => {
    expect(matchesPattern("Test-UI-123", PATTERN)).toBe(true);
    expect(matchesPattern("Mein Test-UI-1", PATTERN)).toBe(false);
    expect(matchesPattern("Test-UIX", PATTERN)).toBe(false);
    expect(matchesPattern("iPhone 17 (2)", ["iPhone 17 (?)"])).toBe(true);
    expect(matchesPattern("iPhone 17 (2)", [])).toBe(false);
  });
});

describe("Cache-Pfade", () => {
  test("fest je Plattform, nie ~/Library/Caches oder ~/.cache als Ganzes, nie Downloads, Cellar, Modelle", () => {
    for (const platform of ["darwin", "linux"] as const) {
      for (const id of CACHE_IDS) {
        const rel = cacheRelativePath(id, platform);
        expect(rel.split("/").length).toBeGreaterThanOrEqual(2);
        expect(["Library/Caches", ".cache", "Library", ""]).not.toContain(rel);
        expect(rel.startsWith("Downloads")).toBe(false);
        expect(rel).not.toMatch(/Cellar|ollama|models|speech|tmp|Developer/i);
      }
    }
    expect(cacheRelativePath("homebrew-downloads", "darwin")).toBe("Library/Caches/Homebrew/downloads");
    expect(cacheRelativePath("homebrew-downloads", "linux")).toBe(".cache/Homebrew/downloads");
  });
});

describe("Test-Simulatoren", () => {
  test("leeres Muster: kein Gerät, kein simctl-Aufruf", async () => {
    const f = fixture();
    addDevice(f, { name: "Test-UI-1" });
    const p = await plan(f, "test-simulatoren");
    expect(p.targets).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  test("nur Shutdown, nur passender Name, nur älter als 12 Stunden, nur verfügbar", async () => {
    const f = fixture();
    addDevice(f, { name: "Test-UI-alt", ageHours: 13 });
    addDevice(f, { name: "Test-UI-läuft", state: "Booted", ageHours: 48 });
    addDevice(f, { name: "Test-UI-startet", state: "Booting", ageHours: 48 });
    addDevice(f, { name: "Test-UI-jung", ageHours: 11 });
    addDevice(f, { name: "iPhone 17", ageHours: 48 });
    addDevice(f, { name: "Test-UI-kaputt", isAvailable: false, ageHours: 48 });
    const p = await plan(f, "test-simulatoren", { simulatorPatterns: PATTERN });
    expect(p.targets.map(t => t.label)).toEqual(["Test-UI-alt"]);
    expect(p.targets[0].bytes).toBeGreaterThan(0);
  });

  test("12-Stunden-Grenze: 11:59 bleibt, 12:00 geht", async () => {
    const f = fixture();
    addDevice(f, { name: "Test-UI-a", ageHours: 11 + 59 / 60 });
    addDevice(f, { name: "Test-UI-b", ageHours: 12 });
    const p = await plan(f, "test-simulatoren", { simulatorPatterns: PATTERN });
    expect(p.targets.map(t => t.label)).toEqual(["Test-UI-b"]);
  });

  test("unbekanntes Alter (kein dataPath): bleibt, mit Hinweis", async () => {
    const f = fixture();
    addDevice(f, { name: "Test-UI-ohne", noDataPath: true });
    const p = await plan(f, "test-simulatoren", { simulatorPatterns: PATTERN });
    expect(p.targets).toEqual([]);
    expect(p.notes.join()).toContain("Alter unbekannt");
  });

  test("Bestandsabfrage scheitert oder ist unklar: Fehler, nichts gelöscht", async () => {
    const f = fixture();
    addDevice(f, { name: "Test-UI-1" });
    f.failing.push("xcrun simctl list devices");
    await expect(plan(f, "test-simulatoren", { simulatorPatterns: PATTERN })).rejects.toThrow(InventoryError);
    expect(() => parseDevices("{}")).toThrow(InventoryError);
    expect(() => parseDevices(JSON.stringify({ devices: { x: [{ udid: "kein-udid", name: "a", state: "Shutdown", isAvailable: true }] } }))).toThrow(InventoryError);
    expect(f.calls.some(c => c.includes("delete"))).toBe(false);
  });

  test("ohne Xcode: Hinweis statt Fehler", async () => {
    const f = fixture();
    f.noSimctl = true;
    const p = await plan(f, "test-simulatoren", { simulatorPatterns: PATTERN });
    expect(p.targets).toEqual([]);
    expect(p.notes).toEqual(["Xcode-Simulatoren nicht installiert"]);
  });

  test("vor dem Löschen neu geprüft: inzwischen gestartet bleibt", async () => {
    const f = fixture();
    const d = addDevice(f, { name: "Test-UI-1" });
    const p = await plan(f, "test-simulatoren", { simulatorPatterns: PATTERN });
    d.state = "Booted";
    expect(await p.targets[0].remove()).toEqual({ skipped: "inzwischen Booted" });
    expect(f.calls.some(c => c[2] === "delete")).toBe(false);
    expect(f.devices).toHaveLength(1);
  });

  test("vor dem Löschen Alter neu geprüft: zwischendurch benutzt und wieder ausgeschaltet bleibt", async () => {
    // a) lastBootedAt frisch, Zustand wieder Shutdown
    const f = fixture();
    const d = addDevice(f, { name: "Test-UI-1" });
    const p = await plan(f, "test-simulatoren", { simulatorPatterns: PATTERN });
    expect(p.targets).toHaveLength(1);
    d.lastBootedAt = new Date(NOW - 0.5 * HOUR).toISOString();
    expect(await p.targets[0].remove()).toEqual({ skipped: "inzwischen benutzt" });

    // b) Geräteordner frisch geändert (device.plist neu geschrieben)
    const g = fixture();
    const e = addDevice(g, { name: "Test-UI-1" });
    const q = await plan(g, "test-simulatoren", { simulatorPatterns: PATTERN });
    writeFileSync(join(g.devicesDir, e.udid, "device.plist"), "<plist>neu</plist>");
    expect(await q.targets[0].remove()).toEqual({ skipped: "inzwischen benutzt" });

    // c) Alter nicht mehr feststellbar (dataPath fehlt jetzt)
    const h = fixture();
    const k = addDevice(h, { name: "Test-UI-1" });
    const r = await plan(h, "test-simulatoren", { simulatorPatterns: PATTERN });
    k.noDataPath = true;
    expect(await r.targets[0].remove()).toEqual({ skipped: "Alter unbekannt" });

    for (const x of [f, g, h]) {
      expect(x.calls.some(c => c[2] === "delete")).toBe(false);
      expect(x.devices).toHaveLength(1);
    }
  });

  test("löscht genau das Gerät per simctl delete <udid>", async () => {
    const f = fixture();
    const d = addDevice(f, { name: "Test-UI-1" });
    addDevice(f, { name: "iPhone 17" });
    const p = await plan(f, "test-simulatoren", { simulatorPatterns: PATTERN });
    expect(await p.targets[0].remove()).toEqual({ removed: true });
    expect(f.calls.filter(c => c[2] === "delete")).toEqual([["xcrun", "simctl", "delete", d.udid]]);
    expect(f.devices.map(x => x.name)).toEqual(["iPhone 17"]);
  });
});

describe("Nicht verfügbare Simulatoren", () => {
  test("musterunabhängig: auch ohne Muster per simctl delete unavailable", async () => {
    const f = fixture();
    addDevice(f, { name: "Irgendwas", isAvailable: false });
    addDevice(f, { name: "iPhone 17" });
    const p = await plan(f, "nicht-verfuegbare-simulatoren", { simulatorPatterns: [] });
    expect(p.targets.map(t => t.label)).toEqual(["1 Gerät"]);
    expect(await p.targets[0].remove()).toEqual({ removed: true });
    expect(f.calls.at(-1)).toEqual(["xcrun", "simctl", "delete", "unavailable"]);
    expect(f.devices.map(d => d.name)).toEqual(["iPhone 17"]);
  });

  test("keine: kein Ziel", async () => {
    const f = fixture();
    addDevice(f, { name: "iPhone 17" });
    expect((await plan(f, "nicht-verfuegbare-simulatoren")).targets).toEqual([]);
  });
});

describe("Simulator-Laufzeiten", () => {
  const RT = (n: number, used: boolean, f: Fixture) => {
    const rt = { identifier: udid(100 + n), runtimeIdentifier: `com.apple.CoreSimulator.SimRuntime.iOS-${n}-0`, version: `${n}.0`, sizeBytes: n * 1000, deletable: true };
    f.runtimes.push(rt);
    if (used) addDevice(f, { name: `iPhone auf ${n}`, runtime: rt.runtimeIdentifier });
    return rt;
  };

  test("ohne Gerät: nur gemeldet, solange runtimesLoeschen fehlt", async () => {
    const f = fixture();
    RT(18, false, f);
    RT(26, true, f);
    const p = await plan(f, "simulator-laufzeiten");
    expect(p.targets.map(t => [t.label, t.bytes, t.reportOnly])).toEqual([["iphonesimulator 18.0", 18000, true]]);
  });

  test("mit runtimesLoeschen: löschbar, vorher Bestand neu gelesen", async () => {
    const f = fixture();
    const rt = RT(18, false, f);
    const p = await plan(f, "simulator-laufzeiten", { deleteRuntimes: true });
    expect(p.targets[0].reportOnly).toBe(false);
    expect(await p.targets[0].remove()).toEqual({ removed: true });
    expect(f.calls.at(-1)).toEqual(["xcrun", "simctl", "runtime", "delete", rt.identifier]);
  });

  test("inzwischen mit Gerät: bleibt", async () => {
    const f = fixture();
    const rt = RT(18, false, f);
    const p = await plan(f, "simulator-laufzeiten", { deleteRuntimes: true });
    addDevice(f, { name: "neu", runtime: rt.runtimeIdentifier });
    expect(await p.targets[0].remove()).toEqual({ skipped: "inzwischen mit Gerät" });
    expect(f.runtimes).toHaveLength(1);
  });

  test("nicht löschbar laut simctl: nur gemeldet", async () => {
    const f = fixture();
    RT(18, false, f).deletable = false;
    const p = await plan(f, "simulator-laufzeiten", { deleteRuntimes: true });
    expect(p.targets[0].reportOnly).toBe(true);
  });
});

describe("Caches", () => {
  const brew = (f: Fixture) => join(f.home, "Library", "Caches", "Homebrew", "downloads");

  test("leert nur den Inhalt der Positivliste; Nachbarn, Downloads, Cellar und Modelle bleiben", async () => {
    const f = fixture();
    oldFile(join(brew(f), "paket.tar.gz"), 10_000);
    oldFile(join(f.home, "Library", "Caches", "Homebrew", "api", "formula.json"), 100);
    oldFile(join(f.home, "Library", "Caches", "com.apple.Safari", "Cache.db"), 100);
    oldFile(join(f.home, "Downloads", "wichtig.pdf"), 100);
    oldFile(join(f.home, ".ollama", "models", "blob"), 100);
    oldFile(join(f.home, ".npm", "_cacache", "index-v5", "aa"), 2000);
    ageDir(brew(f));
    ageDir(join(f.home, ".npm", "_cacache", "index-v5"));
    ageDir(join(f.home, ".npm", "_cacache"));
    const p = await plan(f, "caches");
    expect(p.targets.map(t => t.label)).toEqual(["Homebrew-Downloads", "npm"]);
    for (const t of p.targets) expect(await t.remove()).toEqual({ removed: true });
    expect(existsSync(join(brew(f), "paket.tar.gz"))).toBe(false);
    expect(existsSync(brew(f))).toBe(true);
    expect(existsSync(join(f.home, ".npm", "_cacache", "index-v5"))).toBe(false);
    for (const kept of [
      join(f.home, "Library", "Caches", "Homebrew", "api", "formula.json"),
      join(f.home, "Library", "Caches", "com.apple.Safari", "Cache.db"),
      join(f.home, "Downloads", "wichtig.pdf"),
      join(f.home, ".ollama", "models", "blob"),
    ]) {
      expect(existsSync(kept)).toBe(true);
    }
  });

  test("nur ausgewählte Kennungen", async () => {
    const f = fixture();
    oldFile(join(brew(f), "paket.tar.gz"), 100);
    ageDir(brew(f));
    expect((await plan(f, "caches", { caches: ["pip"] })).targets).toEqual([]);
  });

  test("Verknüpfung als Cache-Ordner oder unterwegs: abgewiesen, Ziel unberührt", async () => {
    const f = fixture();
    const elsewhere = join(f.home, "Wichtig");
    oldFile(join(elsewhere, "daten.txt"), 100);
    ageDir(elsewhere);
    mkdirSync(join(f.home, "Library", "Caches", "Homebrew"), { recursive: true });
    symlinkSync(elsewhere, brew(f));
    const p = await plan(f, "caches");
    expect(p.targets).toEqual([]);
    expect(p.notes.join()).toContain("Homebrew-Downloads: ist eine Verknüpfung");
    expect(existsSync(join(elsewhere, "daten.txt"))).toBe(true);
  });

  test("Elternordner per Verknüpfung umgeleitet: abgewiesen", async () => {
    const f = fixture();
    const elsewhere = join(f.home, "Anderswo");
    oldFile(join(elsewhere, "go-build", "x"), 100);
    ageDir(join(elsewhere, "go-build"));
    mkdirSync(join(f.home, "Library"), { recursive: true });
    symlinkSync(elsewhere, join(f.home, "Library", "Caches"));
    const p = await plan(f, "caches", { caches: ["go-build"] });
    expect(p.targets).toEqual([]);
    expect(p.notes.join()).toContain("go-build: Pfad führt über eine Verknüpfung");
    expect(existsSync(join(elsewhere, "go-build", "x"))).toBe(true);
  });

  test("in der letzten Stunde benutzt: bleibt diesmal", async () => {
    const f = fixture();
    oldFile(join(brew(f), "alt.tar.gz"), 100);
    oldFile(join(brew(f), "neu.tar.gz"), 100, 0.2);
    const p = await plan(f, "caches", { caches: ["homebrew-downloads"] });
    expect(p.targets).toEqual([]);
    expect(p.notes).toEqual(["Homebrew-Downloads: in der letzten Stunde benutzt, bleibt diesmal"]);
  });

  test("nach dem Planen wieder benutzt: bleibt unverändert, als übersprungen gemeldet", async () => {
    const f = fixture();
    oldFile(join(brew(f), "alt.tar.gz"), 100);
    ageDir(brew(f));
    const p = await plan(f, "caches", { caches: ["homebrew-downloads"] });
    expect(p.targets.map(t => t.label)).toEqual(["Homebrew-Downloads"]);
    // Ein Build schreibt zwischen Planung und Ausführung
    writeFileSync(join(brew(f), "frisch.tar.gz"), "neu");
    const before = readdirSync(brew(f)).sort();
    expect(await p.targets[0].remove()).toEqual({ skipped: "inzwischen benutzt, bleibt diesmal" });
    expect(readdirSync(brew(f)).sort()).toEqual(before);
    expect(readFileSync(join(brew(f), "frisch.tar.gz"), "utf8")).toBe("neu");
    expect(statSync(join(brew(f), "alt.tar.gz")).size).toBe(100);
  });

  test("Cache-Ordner zwischen zwei Löschungen gegen eine Verknüpfung auf Downloads getauscht: gleichnamige Dateien dort bytegleich", async () => {
    const f = fixture();
    oldFile(join(brew(f), "a.tar.gz"), 100);
    oldFile(join(brew(f), "b.tar.gz"), 100);
    ageDir(brew(f));
    const downloads = join(f.home, "Downloads");
    mkdirSync(downloads);
    const content = Buffer.from("WICHTIG");
    for (const name of ["a.tar.gz", "b.tar.gz"]) writeFileSync(join(downloads, name), content);
    const p = await plan(f, "caches", { caches: ["homebrew-downloads"] });
    expect(p.targets.map(t => t.label)).toEqual(["Homebrew-Downloads"]);
    const removedNames: string[] = [];
    f.deps.removeEntry = async (name, recursive) => {
      rmSync(name, { recursive, force: true });
      removedNames.push(name);
      // Nach der ersten Löschung: Cache-Ordner umbenannt, an seiner Stelle eine Verknüpfung auf Downloads
      if (removedNames.length === 1) {
        renameSync(brew(f), `${brew(f)}-alt`);
        symlinkSync(downloads, brew(f));
      }
    };
    const cwd = process.cwd();
    expect(await p.targets[0].remove()).toEqual({ removed: true });
    expect(process.cwd()).toBe(cwd);
    expect(removedNames.sort()).toEqual(["a.tar.gz", "b.tar.gz"]);
    // Beide Löschungen trafen den geprüften Ordner, nichts in Downloads
    expect(readdirSync(`${brew(f)}-alt`)).toEqual([]);
    for (const name of ["a.tar.gz", "b.tar.gz"]) expect(readFileSync(join(downloads, name)).equals(content)).toBe(true);
  });

  test("Zugriffsfehler am Cache-Ordner ist ein Fehler, kein stilles Nichts; andere Caches laufen weiter", async () => {
    const f = fixture();
    oldFile(join(brew(f), "paket.tar.gz"), 100);
    ageDir(brew(f));
    oldFile(join(f.home, ".npm", "_cacache", "x"), 100);
    ageDir(join(f.home, ".npm", "_cacache"));
    const parent = join(f.home, "Library", "Caches", "Homebrew");
    chmodSync(parent, 0o000);
    try {
      const p = await plan(f, "caches", { caches: ["homebrew-downloads", "npm"] });
      expect(p.errors).toEqual(["Homebrew-Downloads: nicht lesbar (EACCES), nichts gelöscht"]);
      expect(p.notes).toEqual([]);
      expect(p.targets.map(t => t.label)).toEqual(["npm"]);
    } finally {
      chmodSync(parent, 0o755);
    }
    expect(existsSync(join(brew(f), "paket.tar.gz"))).toBe(true);
  });

  test("Linux: ~/.cache statt ~/Library/Caches", async () => {
    const f = fixture("linux");
    oldFile(join(f.home, ".cache", "pip", "wheels", "a.whl"), 100);
    ageDir(join(f.home, ".cache", "pip", "wheels"));
    ageDir(join(f.home, ".cache", "pip"));
    const p = await plan(f, "caches", { caches: ["pip"] });
    expect(p.targets.map(t => t.label)).toEqual(["pip"]);
  });
});

describe("Logs", () => {
  const MB = 1024 * 1024;
  test("nur *.log über der Schwelle; Ende als .log.1, Datei auf 0, offene Datei schreibt weiter", async () => {
    const f = fixture();
    const logs = join(f.root, "logs");
    mkdirSync(logs);
    const big = join(logs, "telegram-relay.log");
    writeFileSync(big, Buffer.concat([Buffer.alloc(3 * MB, 65), Buffer.from("ENDE")]));
    writeFileSync(join(logs, "klein.log"), "x");
    writeFileSync(join(logs, "riesig.txt"), Buffer.alloc(3 * MB));
    writeFileSync(join(logs, "alt.log.1"), Buffer.alloc(3 * MB));
    // Ein Dienst hält die Datei im Anhängemodus offen
    const { openSync, writeSync, closeSync } = await import("node:fs");
    const fd = openSync(big, "a");
    const p = await plan(f, "logs", { logMaxBytes: 2 * MB, logKeepBytes: 1024 });
    expect(p.targets.map(t => [t.label, t.bytes])).toEqual([["telegram-relay.log", 3 * MB + 4 - 1024]]);
    expect(await p.targets[0].remove()).toEqual({ removed: true });
    expect(statSync(big).size).toBe(0);
    expect(readFileSync(`${big}.1`, "utf8").endsWith("ENDE")).toBe(true);
    expect(statSync(`${big}.1`).size).toBe(1024);
    writeSync(fd, "weiter\n");
    closeSync(fd);
    expect(readFileSync(big, "utf8")).toBe("weiter\n");
    expect(statSync(join(logs, "riesig.txt")).size).toBe(3 * MB);
  });

  test("Verknüpfung als .log wird nicht angefasst, logs/ als Verknüpfung auch nicht", async () => {
    const f = fixture();
    const outside = join(f.home, "fremd.log");
    writeFileSync(outside, Buffer.alloc(3 * MB));
    mkdirSync(join(f.root, "logs"));
    symlinkSync(outside, join(f.root, "logs", "link.log"));
    expect((await plan(f, "logs", { logMaxBytes: 2 * MB, logKeepBytes: 0 })).targets).toEqual([]);

    const g = fixture();
    mkdirSync(join(g.home, "andere-logs"));
    writeFileSync(join(g.home, "andere-logs", "x.log"), Buffer.alloc(3 * MB));
    symlinkSync(join(g.home, "andere-logs"), join(g.root, "logs"));
    const p = await plan(g, "logs", { logMaxBytes: 2 * MB, logKeepBytes: 0 });
    expect(p.targets).toEqual([]);
    expect(p.notes.join()).toContain("Verknüpfung");
  });

  const LIMITS = { logMaxBytes: 2 * MB, logKeepBytes: 1024 };
  /** Datei in ~/Downloads, die die Wartung nie ändern darf */
  const external = (f: Fixture) => {
    const path = join(f.home, "Downloads", "wichtig.bin");
    mkdirSync(join(f.home, "Downloads"), { recursive: true });
    const content = Buffer.concat([Buffer.alloc(3 * MB, 66), Buffer.from("WICHTIG")]);
    writeFileSync(path, content);
    return { path, content };
  };
  const unchanged = (x: { path: string; content: Buffer }) => expect(readFileSync(x.path).equals(x.content)).toBe(true);

  test("Hardlink auf eine Datei außerhalb von logs/: beim Planen abgewiesen, Datei bytegleich", async () => {
    const f = fixture();
    const x = external(f);
    mkdirSync(join(f.root, "logs"));
    linkSync(x.path, join(f.root, "logs", "x.log"));
    const p = await plan(f, "logs", LIMITS);
    expect(p.targets).toEqual([]);
    expect(p.notes).toEqual(["x.log: hat mehrere Namen (Hardlink), bleibt"]);
    unchanged(x);
  });

  test("Hardlink erst nach dem Planen angelegt: nicht gekürzt, keine Sicherung, Datei bytegleich", async () => {
    const f = fixture();
    mkdirSync(join(f.root, "logs"));
    const log = join(f.root, "logs", "x.log");
    const content = Buffer.concat([Buffer.alloc(3 * MB, 67), Buffer.from("LOG")]);
    writeFileSync(log, content);
    const p = await plan(f, "logs", LIMITS);
    expect(p.targets).toHaveLength(1);
    mkdirSync(join(f.home, "Downloads"));
    const outside = join(f.home, "Downloads", "x.bin");
    linkSync(log, outside);
    expect(await p.targets[0].remove()).toEqual({ skipped: "hat mehrere Namen (Hardlink), bleibt" });
    expect(readFileSync(outside).equals(content)).toBe(true);
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  test("logs/ nach dem Planen durch eine Verknüpfung ersetzt: abgewiesen, Ziel bytegleich", async () => {
    const f = fixture();
    const x = external(f);
    const logs = join(f.root, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "wichtig.log"), Buffer.alloc(3 * MB));
    const p = await plan(f, "logs", LIMITS);
    expect(p.targets).toHaveLength(1);
    // Gleicher Dateiname im Ziel der Verknüpfung
    renameSync(join(f.home, "Downloads", "wichtig.bin"), join(f.home, "Downloads", "wichtig.log"));
    x.path = join(f.home, "Downloads", "wichtig.log");
    rmSync(logs, { recursive: true });
    symlinkSync(join(f.home, "Downloads"), logs);
    expect(await p.targets[0].remove()).toEqual({ skipped: "ist eine Verknüpfung, bleibt" });
    unchanged(x);
    expect(existsSync(join(f.home, "Downloads", "wichtig.log.1"))).toBe(false);
  });

  /** Gleichnamige Dateien in ~/Downloads zu logs/a.log: Log, Sicherung und Zwischendatei */
  const externalTwins = (f: Fixture) => {
    const downloads = join(f.home, "Downloads");
    mkdirSync(downloads, { recursive: true });
    return ["a.log", "a.log.1", "a.log.1.tmp"].map((name, i) => {
      const path = join(downloads, name);
      const content = Buffer.concat([Buffer.alloc(3 * MB, 70 + i), Buffer.from(`FREMD-${name}`)]);
      writeFileSync(path, content);
      return { path, content };
    });
  };
  /** logs/ umbenennen und durch eine Verknüpfung auf ~/Downloads ersetzen */
  const redirectLogs = (f: Fixture) => {
    const logs = join(f.root, "logs");
    renameSync(logs, join(f.root, "logs-alt"));
    symlinkSync(join(f.home, "Downloads"), logs);
  };

  test("logs/ während der Sicherung umgeleitet (vor dem Aufräumen der .tmp): fremde .log, .log.1 und .log.1.tmp bytegleich", async () => {
    const f = fixture();
    const twins = externalTwins(f);
    const logs = join(f.root, "logs");
    mkdirSync(logs);
    const own = Buffer.concat([Buffer.alloc(3 * MB, 65), Buffer.from("EIGEN")]);
    writeFileSync(join(logs, "a.log"), own);
    const p = await plan(f, "logs", LIMITS);
    expect(p.targets).toHaveLength(1);
    const calls: string[] = [];
    f.deps.removeEntry = async (name, recursive) => {
      // Erster Aufruf ist rm(temp) nach dem Lesen des Endes: genau jetzt umleiten
      if (calls.length === 0) redirectLogs(f);
      calls.push(name);
      rmSync(name, { recursive, force: true });
    };
    expect(await p.targets[0].remove()).toEqual({ skipped: "ist eine Verknüpfung, bleibt" });
    // Aufräumen nach der zweiten Prüfung lief ebenfalls im geprüften Ordner
    expect(calls).toEqual(["a.log.1.tmp", "a.log.1.tmp"]);
    for (const x of twins) unchanged(x);
    expect(readFileSync(join(f.root, "logs-alt", "a.log")).equals(own)).toBe(true);
    expect(readdirSync(join(f.root, "logs-alt"))).toEqual(["a.log"]);
  });

  test("logs/ umgeleitet, während die Zwischendatei aufgeräumt wird: fremde Dateien bytegleich, eigene .tmp weg", async () => {
    const f = fixture();
    const twins = externalTwins(f);
    const logs = join(f.root, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "a.log"), Buffer.alloc(3 * MB));
    // Eine alte eigene Zwischendatei liegt noch in logs/
    writeFileSync(join(logs, "a.log.1.tmp"), "alt");
    const p = await plan(f, "logs", LIMITS);
    let n = 0;
    f.deps.removeEntry = async (name, recursive) => {
      rmSync(name, { recursive, force: true });
      // Nach dem ersten rm(temp), vor open(temp) und rename: umleiten
      if (n++ === 0) redirectLogs(f);
    };
    expect(await p.targets[0].remove()).toEqual({ skipped: "ist eine Verknüpfung, bleibt" });
    for (const x of twins) unchanged(x);
    expect(readdirSync(join(f.root, "logs-alt"))).toEqual(["a.log"]);
    expect(statSync(join(f.root, "logs-alt", "a.log")).size).toBe(3 * MB);
  });

  test("logs/ nach dem Planen gegen einen anderen Ordner getauscht: abgewiesen", async () => {
    const f = fixture();
    const logs = join(f.root, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "a.log"), Buffer.alloc(3 * MB));
    const p = await plan(f, "logs", LIMITS);
    renameSync(logs, join(f.root, "logs-alt"));
    mkdirSync(logs);
    const content = Buffer.alloc(3 * MB, 68);
    writeFileSync(join(logs, "a.log"), content);
    expect(await p.targets[0].remove()).toEqual({ skipped: "Ordner inzwischen ausgetauscht, bleibt" });
    expect(readFileSync(join(logs, "a.log")).equals(content)).toBe(true);
    expect(statSync(join(f.root, "logs-alt", "a.log")).size).toBe(3 * MB);
  });

  test("Logdatei nach dem Planen durch eine Verknüpfung ersetzt: Ziel bytegleich", async () => {
    const f = fixture();
    const x = external(f);
    const logs = join(f.root, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "a.log"), Buffer.alloc(3 * MB));
    const p = await plan(f, "logs", LIMITS);
    rmSync(join(logs, "a.log"));
    symlinkSync(x.path, join(logs, "a.log"));
    expect(await p.targets[0].remove()).toEqual({ skipped: "inzwischen eine Verknüpfung, bleibt" });
    unchanged(x);
  });

  test("logs/ nicht lesbar: Fehler statt stillem Nichts", async () => {
    const f = fixture();
    const logs = join(f.root, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "a.log"), Buffer.alloc(3 * MB));
    chmodSync(logs, 0o000);
    try {
      // Je nach System scheitert realpath oder readdir; beides ist ein Fehler
      const outcome = await plan(f, "logs", LIMITS).then(
        p => (p.errors ?? []).join(),
        error => String(error),
      );
      expect(outcome).toContain("EACCES");
    } finally {
      chmodSync(logs, 0o755);
    }
    expect(statSync(join(logs, "a.log")).size).toBe(3 * MB);
  });
});

describe("Plattformen", () => {
  test("Linux ohne Xcode-Posten, macOS mit allen", () => {
    expect(itemsFor("linux").map(i => i.id)).toEqual(["caches", "logs"]);
    expect(itemsFor("darwin").map(i => i.id)).toEqual(["test-simulatoren", "nicht-verfuegbare-simulatoren", "simulator-laufzeiten", "caches", "logs"]);
  });
});
