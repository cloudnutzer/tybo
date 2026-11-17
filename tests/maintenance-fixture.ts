/**
 * Attrappen für die Wartung (Issue #485): ein Home- und ein Projektordner
 * unter tmp, ein nachgebautes `xcrun simctl` mit veränderlichem Bestand,
 * feste Uhr, Meldung und freier Platz als Aufzeichnung. Nichts davon ruft
 * das echte xcrun oder bun run notify.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, MaintenanceDeps } from "../src/lib/maintenance/items";

/** Uhr der Attrappen: echte Zeit, damit frisch angelegte Dateien „gerade eben“ geändert sind */
export const NOW = Date.now();
export const HOUR = 3600_000;

export interface FakeDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  runtime: string;
  /** Alter des Geräteordners in Stunden (für mtime) */
  ageHours: number;
  /** ohne dataPath in der Ausgabe von simctl */
  noDataPath?: boolean;
  /** Größe von data/disk.img in Bytes */
  size?: number;
  /** lastBootedAt in der Ausgabe von simctl */
  lastBootedAt?: string;
}

export interface FakeRuntime {
  identifier: string;
  runtimeIdentifier: string;
  version: string;
  sizeBytes: number;
  deletable: boolean;
}

let counter = 0;
export function udid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export interface Fixture {
  home: string;
  root: string;
  devices: FakeDevice[];
  runtimes: FakeRuntime[];
  calls: string[][];
  notified: string[];
  /** Befehle, die scheitern (Wörter mit Leerzeichen verbunden, Präfix genügt) */
  failing: string[];
  /** Ohne Xcode: xcrun --find simctl scheitert */
  noSimctl: boolean;
  notifyFails: boolean;
  free: (number | null)[];
  /** wird vor jedem Aufruf von simctl list devices ausgeführt (Bestand ändern) */
  beforeList?: (n: number) => void;
  deps: MaintenanceDeps;
  devicesDir: string;
  cleanup(): void;
}

function devicesJson(f: Fixture): string {
  const byRuntime: Record<string, unknown[]> = {};
  for (const rt of f.runtimes) byRuntime[rt.runtimeIdentifier] ??= [];
  for (const d of f.devices) {
    (byRuntime[d.runtime] ??= []).push({
      udid: d.udid,
      name: d.name,
      state: d.state,
      isAvailable: d.isAvailable,
      ...(!d.noDataPath && { dataPath: join(f.devicesDir, d.udid, "data") }),
      ...(d.lastBootedAt !== undefined && { lastBootedAt: d.lastBootedAt }),
    });
  }
  return JSON.stringify({ devices: byRuntime });
}

function runtimesJson(f: Fixture): string {
  return JSON.stringify(
    Object.fromEntries(
      f.runtimes.map(rt => [rt.identifier, { identifier: rt.identifier, runtimeIdentifier: rt.runtimeIdentifier, version: rt.version, platformIdentifier: "com.apple.platform.iphonesimulator", sizeBytes: rt.sizeBytes, deletable: rt.deletable }]),
    ),
  );
}

/** Legt den Geräteordner wie CoreSimulator an, mit mtime entsprechend ageHours */
export function writeDevice(f: Fixture, d: FakeDevice): void {
  const dir = join(f.devicesDir, d.udid);
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "device.plist"), "<plist/>");
  writeFileSync(join(dir, "data", "disk.img"), Buffer.alloc(d.size ?? 4096, 1));
  const t = (NOW - d.ageHours * HOUR) / 1000;
  for (const p of [join(dir, "data", "disk.img"), join(dir, "data"), join(dir, "device.plist"), dir]) utimesSync(p, t, t);
}

export function makeFixture(platform: NodeJS.Platform = "darwin"): Fixture {
  const base = mkdtempSync(join(tmpdir(), `wartung-${process.pid}-${counter++}-`));
  const home = join(base, "home");
  const root = join(base, "home", "tybo");
  mkdirSync(join(root, "config"), { recursive: true });
  const devicesDir = join(home, "Library", "Developer", "CoreSimulator", "Devices");
  mkdirSync(devicesDir, { recursive: true });
  let listCount = 0;
  const f: Fixture = {
    home,
    root,
    devices: [],
    runtimes: [],
    calls: [],
    notified: [],
    failing: [],
    noSimctl: false,
    notifyFails: false,
    free: [1000, 5000],
    devicesDir,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
    deps: undefined as unknown as MaintenanceDeps,
  };
  const ok = (stdout = ""): CommandResult => ({ ok: true, code: 0, stdout, stderr: "" });
  const fail: CommandResult = { ok: false, code: 1, stdout: "", stderr: "Fehler" };
  f.deps = {
    platform,
    home,
    root,
    now: () => NOW,
    async run(cmd) {
      f.calls.push(cmd);
      const line = cmd.join(" ");
      if (f.failing.some(prefix => line.startsWith(prefix))) return fail;
      if (line === "xcrun --find simctl") return f.noSimctl ? fail : ok("/usr/bin/simctl");
      if (line === "xcrun simctl list devices --json") {
        f.beforeList?.(listCount++);
        return ok(devicesJson(f));
      }
      if (line === "xcrun simctl runtime list -j") return ok(runtimesJson(f));
      if (line === "xcrun simctl delete unavailable") {
        f.devices = f.devices.filter(d => d.isAvailable);
        return ok();
      }
      if (cmd[0] === "xcrun" && cmd[2] === "delete" && cmd.length === 4) {
        f.devices = f.devices.filter(d => d.udid !== cmd[3]);
        rmSync(join(devicesDir, cmd[3]), { recursive: true, force: true });
        return ok();
      }
      if (line.startsWith("xcrun simctl runtime delete ")) {
        f.runtimes = f.runtimes.filter(rt => rt.identifier !== cmd[4]);
        return ok();
      }
      return fail;
    },
    async freeBytes() {
      return f.free.length > 1 ? f.free.shift()! : (f.free[0] ?? null);
    },
    async notify(text) {
      if (f.notifyFails) throw new Error("notify: Exit 1");
      f.notified.push(text);
    },
  };
  return f;
}

/** Fügt ein Gerät hinzu und legt seinen Ordner an */
export function addDevice(f: Fixture, d: Partial<FakeDevice> & { name: string }): FakeDevice {
  const device: FakeDevice = { udid: udid(f.devices.length + 1), state: "Shutdown", isAvailable: true, runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0", ageHours: 48, ...d };
  f.devices.push(device);
  writeDevice(f, device);
  return device;
}

/** Datei mit Inhalt und altem Zeitstempel */
export function oldFile(path: string, size: number, ageHours = 48): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(size, 7));
  const t = (NOW - ageHours * HOUR) / 1000;
  utimesSync(path, t, t);
}

/** Ordner und alle Eltern bis base auf einen alten Zeitstempel setzen */
export function ageDir(path: string, ageHours = 48): void {
  const t = (NOW - ageHours * HOUR) / 1000;
  utimesSync(path, t, t);
}
