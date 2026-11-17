// Issue #342: Lebenszyklus des Bot-Prozesses (src/app/lifecycle.ts). Sperrdatei,
// Herzschlag, geordnetes Beenden und Signale, alles mit austauschbarem
// Dateisystem, Zeitgeber, Prozessprüfung und Exit; ohne src/bot.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  acquireLockOrExit,
  botCommandFor,
  botLockHeld,
  breakMarkerKey,
  breakMarkerPath,
  createLifecycle,
  createProcessLock,
  describeLockCommand,
  formatLockContent,
  formatLockStart,
  installSignalHandlers,
  lockRejectionMessage,
  parseLockContent,
  probePid,
  type LockFs,
  type LockInspector,
  type PidState,
  type RealPath,
} from "../src/app/lifecycle";

const basenameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Sperrdatei im Speicher; create schlägt wie "wx" mit EEXIST fehl */
function memoryFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set("/x/bot.lock", initial);
  const calls: string[] = [];
  const fs: LockFs = {
    async create(path, content) {
      calls.push(`create ${path}`);
      if (files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(path, content);
    },
    async read(path) {
      return files.get(path) ?? null;
    },
    async overwrite(path, content) {
      calls.push(`overwrite ${path}`);
      files.set(path, content);
    },
    async remove(path) {
      calls.push(`remove ${path}`);
      files.delete(path);
    },
  };
  return { fs, files, calls };
}

interface FakeProc {
  started: string;
  command: string;
  cwd?: string | null;
  /** ps antwortet nicht */
  noInfo?: boolean;
  state?: PidState;
}

const T_OLD = "Mon Jan  1 00:00:00 2001";
const T_ME = "Thu Nov 12 20:17:33 2026";
const T_BOT = "Wed Nov 11 08:00:00 2026";

/** Vorhandene Dateien und Ordner der Attrappe; alles andere fehlt */
const EXISTING = new Set(["/", "/x", "/x/src/bot.ts", "/anderer/x/src/bot.ts", "/anderer/checkout/src/bot.ts", "/mein ordner", "/mein ordner/src/bot.ts"]);

/** Dateisystem der Attrappe: vorhanden heißt in EXISTING */
const fakeRealpath = (path: string): RealPath => (EXISTING.has(path) ? { path } : "missing");

/**
 * Prozesstabelle als Attrappe: kein Test fragt oder signalisiert einen
 * echten fremden Prozess. Fehlt eine PID, ist sie "gone".
 */
function fakeInspector(procs: Record<number, FakeProc>, seen: string[] = []): LockInspector {
  return {
    probe: pid => (seen.push(`probe ${pid}`), procs[pid] ? (procs[pid].state ?? "alive") : "gone"),
    info: pid => (seen.push(`info ${pid}`), procs[pid] && !procs[pid].noInfo ? { started: procs[pid].started, command: procs[pid].command } : null),
    cwd: pid => (seen.push(`cwd ${pid}`), procs[pid]?.cwd ?? null),
    realpath: fakeRealpath,
  };
}

const lockJson = (pid: number, started: string | null) => formatLockContent({ pid, started });
const ME = 4242;
const MINE = lockJson(ME, T_ME);

const lockAt = (fs: LockFs, procs: Record<number, FakeProc>, pid = ME, seen?: string[]) =>
  createProcessLock({ path: "/x/bot.lock", pid, root: "/x", fs, inspector: fakeInspector({ [ME]: { started: T_ME, command: "bun run src/bot.ts", cwd: "/x" }, ...procs }, seen) });

const BOT_HERE = { started: T_BOT, command: "/usr/local/bin/bun run /x/src/bot.ts", cwd: "/" };

/** Form von lstart, aber unmöglich: Uhrzeit, Namen, Tag im Monat, Wochentag */
const IMPOSSIBLE_STARTS = [
  "Thu Nov 12 99:17:33 2026",
  "Foo Bar 99 99:99:99 2026",
  "Thu Nov 12 24:00:00 2026",
  "Thu Nov 12 20:60:33 2026",
  "Thu Nov 12 20:17:60 2026",
  "Thu Nov  0 20:17:33 2026",
  "Mon Feb 30 20:17:33 2026",
  "Sun Feb 29 20:17:33 2026",
  "Fri Nov 12 20:17:33 2026",
  "Thu Xyz 12 20:17:33 2026",
];

describe("Sperrdatei: Inhalt", () => {
  test("neues Format mit PID und Startzeit, altes nur mit PID, alles andere beschädigt", () => {
    expect(parseLockContent(lockJson(77, T_OLD))).toEqual({ pid: 77, started: T_OLD });
    expect(parseLockContent("77\n")).toEqual({ pid: 77, started: null });
    expect(parseLockContent(lockJson(77, null))).toEqual({ pid: 77, started: null });
    for (const bad of ["", "abc", "-5", "0", "1.5", "99999999999999999999", "{\"pid\":7", "{\"pid\":7}", "{\"pid\":0,\"started\":\"x\"}", "{\"pid\":7,\"started\":\"\"}", "{\"pid\":7,\"started\":\"kaputt\"}", "{\"pid\":7,\"started\":\"2026-11-12T20:17:33Z\"}", "{\"pid\":7,\"started\":\" Thu Nov 12 20:17:33 2026\"}", "{\"pid\":7,\"started\":42}", "[1]"]) {
      expect(parseLockContent(bad)).toBeNull();
    }
  });

  test("Startzeit in der Form von lstart, aber kein wirklicher Zeitpunkt: beschädigt", () => {
    for (const started of IMPOSSIBLE_STARTS) expect(parseLockContent(lockJson(77, started))).toBeNull();
    // Gültige Grenzfälle bleiben gültig
    for (const started of ["Mon Feb 29 23:59:59 2016", "Wed Dec 31 00:00:00 2025", "Thu Oct  1 06:35:20 2026"]) {
      expect(parseLockContent(lockJson(77, started))).toEqual({ pid: 77, started });
    }
  });
  test("Startzeit mit Tag als 01 oder mit Leerzeichen: derselbe Zeitpunkt, eine Schreibweise", () => {
    expect(parseLockContent(lockJson(77, "Thu Oct 01 06:35:20 2026"))).toEqual({ pid: 77, started: "Thu Oct  1 06:35:20 2026" });
    expect(parseLockContent(lockJson(77, "Thu Oct  1 06:35:20 2026"))).toEqual({ pid: 77, started: "Thu Oct  1 06:35:20 2026" });
    expect(parseLockContent(lockJson(77, "Mon Oct 12 06:35:20 2026"))).toEqual({ pid: 77, started: "Mon Oct 12 06:35:20 2026" });
  });
});

describe("Sperrdatei: Schreibweise der Startzeit", () => {
  const ZERO = "Thu Oct 01 06:35:20 2026";
  const SPACE = "Thu Oct  1 06:35:20 2026";

  test("tryAcquire: lebender Besitzer behält seine unveränderte Sperre, in beiden Richtungen", async () => {
    for (const [inLock, fromPs] of [[ZERO, SPACE], [SPACE, ZERO]]) {
      const content = lockJson(111, inLock);
      const m = memoryFs(content);
      const result = await lockAt(m.fs, { 111: { started: fromPs, command: "bun run src/bot.ts", cwd: "/x" } }).tryAcquire();
      expect(result).toMatchObject({ ok: false, rejection: { state: "held", why: "same-start", pid: 111 } });
      expect(m.files.get("/x/bot.lock")).toBe(content);
      expect([...m.files.keys()]).toEqual(["/x/bot.lock"]);
      expect(m.calls.filter(c => !c.startsWith("create "))).toEqual([]);
    }
  });

  test("botLockHeld: lebender Besitzer zählt, auch wenn ps den Tag anders schreibt", async () => {
    for (const [inLock, fromPs] of [[ZERO, SPACE], [SPACE, ZERO]]) {
      const read = { read: async () => lockJson(111, inLock) };
      expect(await botLockHeld("/x", fakeInspector({ 111: { started: fromPs, command: "bun run src/bot.ts", cwd: "/x" } }), read)).toBe(true);
    }
  });

  test("eigene Startzeit mit 01: die Sperre steht in der Schreibweise von ps und gilt als eigene", async () => {
    const m = memoryFs();
    const lock = createProcessLock({ path: "/x/bot.lock", pid: ME, root: "/x", started: ZERO, fs: m.fs, inspector: fakeInspector({}) });
    expect(await lock.tryAcquire()).toEqual({ ok: true });
    expect(m.files.get("/x/bot.lock")).toBe(lockJson(ME, SPACE));
    await lock.release();
    expect(m.files.has("/x/bot.lock")).toBe(false);
  });

  test("ps liefert keinen wirklichen Zeitpunkt: belegt, nichts gelöscht", async () => {
    const content = lockJson(111, SPACE);
    const m = memoryFs(content);
    const result = await lockAt(m.fs, { 111: { started: "Fri Oct  1 06:35:20 2026", command: "bun run src/bot.ts", cwd: "/x" } }).tryAcquire();
    expect(result).toMatchObject({ ok: false, rejection: { state: "held", why: "unverifiable", pid: 111 } });
    expect(m.files.get("/x/bot.lock")).toBe(content);
  });
});

describe("Sperrdatei: Übernahme", () => {
  test("frei: angelegt mit eigener PID und Startzeit", async () => {
    const m = memoryFs();
    expect(await lockAt(m.fs, {}).tryAcquire()).toEqual({ ok: true });
    expect(m.files.get("/x/bot.lock")).toBe(MINE);
  });

  test("toter Besitzer: alte Sperre weg, eigene angelegt, Aufbruch-Sperre aufgeräumt", async () => {
    const m = memoryFs(lockJson(111, T_OLD));
    expect(await lockAt(m.fs, {}).tryAcquire()).toEqual({ ok: true });
    expect(m.files.get("/x/bot.lock")).toBe(MINE);
    expect([...m.files.keys()]).toEqual(["/x/bot.lock"]);
  });

  test("fremder Prozess mit gleicher PID (andere Startzeit): Sperre gilt als verwaist und wird ersetzt", async () => {
    // Nach einem harten Neustart hält etwa launchd die PID 1
    const m = memoryFs(lockJson(1, T_OLD));
    expect(await lockAt(m.fs, { 1: { started: "Thu Nov 12 06:00:00 2026", command: "/sbin/launchd" } }).tryAcquire()).toEqual({ ok: true });
    expect(m.files.get("/x/bot.lock")).toBe(MINE);
  });

  test("lebender Bot (gleiche Startzeit): nicht übernommen, Datei bleibt, Grund mit Befehl und Zeit", async () => {
    const m = memoryFs(lockJson(111, T_BOT));
    const result = await lockAt(m.fs, { 111: BOT_HERE }).tryAcquire();
    expect(result).toEqual({ ok: false, rejection: { state: "held", pid: 111, why: "same-start", command: BOT_HERE.command, started: T_BOT, entry: "/x/src/bot.ts" } });
    expect(m.files.get("/x/bot.lock")).toBe(lockJson(111, T_BOT));
    expect(m.calls.some(c => c.startsWith("remove"))).toBe(false);
  });

  test("Startzeit nicht abfragbar (ps scheitert), PID lebt: belegt, nichts gelöscht", async () => {
    const m = memoryFs(lockJson(111, T_BOT));
    const result = await lockAt(m.fs, { 111: { ...BOT_HERE, noInfo: true } }).tryAcquire();
    expect(result).toMatchObject({ ok: false, rejection: { state: "held", why: "unverifiable", pid: 111 } });
    expect(m.calls.some(c => c.startsWith("remove"))).toBe(false);
  });

  test("Besitzer nicht prüfbar (EPERM) mit gleicher Startzeit: belegt; mit anderer: verwaist", async () => {
    const held = memoryFs(lockJson(111, T_BOT));
    expect((await lockAt(held.fs, { 111: { ...BOT_HERE, state: "unknown" } }).tryAcquire()).ok).toBe(false);
    const other = memoryFs(lockJson(111, T_OLD));
    expect((await lockAt(other.fs, { 111: { ...BOT_HERE, state: "unknown" } }).tryAcquire()).ok).toBe(true);
  });

  test("beschädigter Inhalt: nicht übernommen, nichts gelöscht, keine Prozessabfrage", async () => {
    for (const content of ["", "abc", "-5", "{\"pid\":111", "{\"pid\":111}"]) {
      const m = memoryFs(content);
      const seen: string[] = [];
      expect(await lockAt(m.fs, {}, ME, seen).tryAcquire()).toEqual({ ok: false, rejection: { state: "held", pid: null, why: "unreadable", command: null, started: null } });
      expect(seen).toEqual([`info ${ME}`]);
      expect(m.files.get("/x/bot.lock")).toBe(content);
    }
  });

  test("ungültige Startzeit bei lebendem Bot: beschädigt, nicht übernommen, botLockHeld true", async () => {
    const content = "{\"pid\":111,\"started\":\"kaputt\"}";
    const m = memoryFs(content);
    expect(await lockAt(m.fs, { 111: BOT_HERE }).tryAcquire()).toEqual({ ok: false, rejection: { state: "held", pid: null, why: "unreadable", command: null, started: null } });
    expect(m.files.get("/x/bot.lock")).toBe(content);
    expect(m.calls.some(c => c.startsWith("remove"))).toBe(false);
    expect(await botLockHeld("/x", fakeInspector({ 111: BOT_HERE }), m.fs)).toBe(true);
  });

  test("unmögliche Startzeit in lstart-Form bei lebendem Besitzer: beschädigt, Sperre unverändert, botLockHeld true", async () => {
    for (const started of IMPOSSIBLE_STARTS) {
      const content = lockJson(111, started);
      const m = memoryFs(content);
      // Der Besitzer lebt mit einer anderen, gültigen Startzeit: wäre die Sperre lesbar, gälte sie als verwaist
      expect(await lockAt(m.fs, { 111: BOT_HERE }).tryAcquire()).toEqual({ ok: false, rejection: { state: "held", pid: null, why: "unreadable", command: null, started: null } });
      expect(m.files.get("/x/bot.lock")).toBe(content);
      expect(m.calls.some(c => c.startsWith("remove") || c.startsWith("overwrite"))).toBe(false);
      expect(await botLockHeld("/x", fakeInspector({ 111: BOT_HERE }), m.fs)).toBe(true);
    }
  });

  test("Sperre wechselt zwischen Lesen und Löschen den Besitzer: die neue bleibt", async () => {
    const m = memoryFs(lockJson(111, T_OLD));
    const newOwner = lockJson(222, T_BOT);
    const inspector = fakeInspector({ 222: BOT_HERE });
    // Während der Prüfung der alten Sperre legt ein anderer Bot eine eigene an
    const lock = createProcessLock({
      path: "/x/bot.lock",
      pid: ME,
      root: "/x",
      started: T_ME,
      fs: m.fs,
      inspector: {
        ...inspector,
        probe: pid => {
          if (pid === 111) m.files.set("/x/bot.lock", newOwner);
          return inspector.probe(pid);
        },
      },
    });
    expect((await lock.tryAcquire()).ok).toBe(false);
    expect(m.files.get("/x/bot.lock")).toBe(newOwner);
    expect(m.calls).not.toContain("remove /x/bot.lock");
  });

  test("immer wieder tote Besitzer: nach drei Versuchen aufgegeben", async () => {
    const m = memoryFs(lockJson(111, T_OLD));
    // Jede Löschung kommt zu spät: ein neuer, ebenfalls toter Besitzer steht schon da
    const fs: LockFs = { ...m.fs, remove: async path => void (path === "/x/bot.lock" ? m.files.set(path, lockJson(111, T_OLD)) : m.files.delete(path)) };
    expect(await lockAt(fs, {}).tryAcquire()).toEqual({ ok: false, rejection: { state: "busy" } });
    expect(m.calls.filter(c => c === "create /x/bot.lock")).toHaveLength(3);
  });

  test("Sperre da, aber nicht lesbar (EACCES): belegt, nichts gelöscht", async () => {
    const m = memoryFs(lockJson(111, T_OLD));
    const fs: LockFs = { ...m.fs, read: async () => { throw Object.assign(new Error("kein Zugriff"), { code: "EACCES" }); } };
    expect(await lockAt(fs, {}).tryAcquire()).toEqual({ ok: false, rejection: { state: "held", pid: null, why: "unreadable", command: null, started: null } });
    expect(m.calls.some(c => c.startsWith("remove"))).toBe(false);
  });

  test("anderer Fehler beim Anlegen: wird geworfen", async () => {
    const m = memoryFs();
    const fs: LockFs = { ...m.fs, create: async () => { throw Object.assign(new Error("kein Platz"), { code: "ENOSPC" }); } };
    await expect(lockAt(fs, {}).tryAcquire()).rejects.toThrow("kein Platz");
  });
});

describe("Sperrdatei: alte Sperre nur mit PID", () => {
  const legacy = async (procs: Record<number, FakeProc>, root = "/x") => {
    const m = memoryFs("111");
    const lock = createProcessLock({ path: "/x/bot.lock", pid: ME, root, started: T_ME, fs: m.fs, inspector: fakeInspector(procs) });
    return { result: await lock.tryAcquire(), m };
  };

  test("toter Besitzer: übernommen", async () => {
    expect((await legacy({})).result.ok).toBe(true);
  });

  test("lebender Prozess ohne src/bot.ts: verwaist, übernommen", async () => {
    const { result, m } = await legacy({ 111: { started: T_OLD, command: "/usr/sbin/cupsd -l" } });
    expect(result.ok).toBe(true);
    expect(m.files.get("/x/bot.lock")).toBe(MINE);
  });

  test("Bot aus diesem Ordner, absoluter Pfad: belegt", async () => {
    expect((await legacy({ 111: BOT_HERE })).result).toMatchObject({ ok: false, rejection: { why: "bot-command", pid: 111 } });
  });

  test("Ordner mit Leerzeichen: absoluter Pfad wird erkannt", async () => {
    const r = await legacy({ 111: { started: T_BOT, command: "bun run /mein ordner/src/bot.ts" } }, "/mein ordner");
    expect(r.result.ok).toBe(false);
  });

  test("relativer Aufruf aus diesem Ordner: belegt; aus einem anderen Checkout: verwaist, mit run unklar", async () => {
    const here = await legacy({ 111: { started: T_BOT, command: "bun run src/bot.ts", cwd: "/x" } });
    expect(here.result).toMatchObject({ ok: false, rejection: { why: "bot-command" } });
    const elsewhere = await legacy({ 111: { started: T_BOT, command: "node src/bot.ts", cwd: "/anderer/checkout" } });
    expect(elsewhere.result.ok).toBe(true);
    // "run src/bot.ts" kann selbst der Pfad sein (Ordner "run src"), und den gibt es dort nicht: unklar
    const viaRun = await legacy({ 111: { started: T_BOT, command: "bun run src/bot.ts", cwd: "/anderer/checkout" } });
    expect(viaRun.result).toMatchObject({ ok: false, rejection: { why: "unverifiable", pid: 111 } });
    expect(viaRun.m.files.get("/x/bot.lock")).toBe("111");
    const dotted = await legacy({ 111: { started: T_BOT, command: "bun ./src/bot.ts --profile server", cwd: "/x" } });
    expect(dotted.result.ok).toBe(false);
  });

  test("absoluter Pfad eines anderen Checkouts: verwaist; mit Wörtern davor, die zum Pfad gehören können, unklar", async () => {
    const r = await legacy({ 111: { started: T_BOT, command: "bun /anderer/x/src/bot.ts", cwd: "/x" } });
    expect(r.result.ok).toBe(true);
    for (const command of ["bun run /anderer/x/src/bot.ts", "bun --watch /anderer/x/src/bot.ts"]) {
      const before = await legacy({ 111: { started: T_BOT, command, cwd: "/x" } });
      expect(before.result).toMatchObject({ ok: false, rejection: { why: "unverifiable" } });
      expect(before.m.files.get("/x/bot.lock")).toBe("111");
    }
  });

  test("Symlink 'run alias' entfernt, fremde Datei unter alias/src/bot.ts: unklar, Sperre bleibt, botLockHeld true", async () => {
    // Bot in /x über den relativen Symlink "run alias/src/bot.ts" gestartet; der Symlink ist weg,
    // /x/alias/src/bot.ts gibt es als fremde Datei
    const real = (p: string): RealPath => (["/", "/x", "/x/src/bot.ts", "/x/alias/src/bot.ts"].includes(p) ? { path: p } : "missing");
    const command = "bun run run alias/src/bot.ts";
    expect(botCommandFor(command, 111, "/x", { cwd: () => "/x", realpath: real })).toBe("unclear");
    for (const other of ["bun run -alias/src/bot.ts", "bun --watch run alias/src/bot.ts"]) {
      expect(botCommandFor(other, 111, "/x", { cwd: () => "/x", realpath: p => (p === "/x/-alias/src/bot.ts" ? { path: p } : real(p)) })).toBe("unclear");
    }
    const m = memoryFs("111");
    const procs = { 111: { started: T_BOT, command, cwd: "/x" } };
    const lock = createProcessLock({ path: "/x/bot.lock", pid: ME, root: "/x", started: T_ME, fs: m.fs, inspector: { ...fakeInspector(procs), realpath: real } });
    expect(await lock.tryAcquire()).toMatchObject({ ok: false, rejection: { state: "held", why: "unverifiable", pid: 111 } });
    expect(m.files.get("/x/bot.lock")).toBe("111");
    expect(m.calls.some(c => c.startsWith("remove") || c.startsWith("overwrite"))).toBe(false);
    expect(await botLockHeld("/x", { ...fakeInspector(procs), realpath: real }, m.fs)).toBe(true);
  });

  test("relativer Aufruf, Arbeitsordner nicht abfragbar: belegt (unklar)", async () => {
    const r = await legacy({ 111: { started: T_BOT, command: "bun run src/bot.ts", cwd: null } });
    expect(r.result).toMatchObject({ ok: false, rejection: { why: "unverifiable", pid: 111, started: T_BOT } });
    expect(r.m.files.get("/x/bot.lock")).toBe("111");
  });

  test("Befehl nicht abfragbar: belegt (unklar)", async () => {
    const r = await legacy({ 111: { ...BOT_HERE, noInfo: true } });
    expect(r.result).toMatchObject({ ok: false, rejection: { why: "unverifiable" } });
  });

  test("Symlink auf den Projektordner zählt wie der Ordner selbst", () => {
    const real = (p: string): RealPath => {
      const mapped = p.replace(/^\/link/, "/echt");
      return ["/echt/x", "/echt/x/src/bot.ts"].includes(mapped) ? { path: mapped } : "missing";
    };
    const inspector = { cwd: () => "/echt/x", realpath: real };
    expect(botCommandFor("bun run src/bot.ts", 1, "/link/x", inspector)).toBe("yes");
    expect(botCommandFor("bun run /link/x/src/bot.ts", 1, "/echt/x", inspector)).toBe("yes");
  });

  test("Symlink mit Leerzeichen auf einen Ordner mit Leerzeichen: derselbe Bot, auch ohne Arbeitsordner", () => {
    // /alias dir zeigt auf /real dir; ps zeigt die Argumente ohne Anführungszeichen
    const real = (p: string): RealPath => {
      const mapped = p.replace(/^\/alias dir/, "/real dir");
      return ["/real dir", "/real dir/src/bot.ts"].includes(mapped) ? { path: mapped } : "missing";
    };
    expect(botCommandFor("bun run /alias dir/src/bot.ts", 1, "/real dir", { cwd: () => "/", realpath: real })).toBe("yes");
    expect(botCommandFor("bun run /alias dir/src/bot.ts", 1, "/real dir", { cwd: () => null, realpath: real })).toBe("yes");
    expect(botCommandFor("bun /alias dir/src/bot.ts --profile server", 1, "/real dir", { cwd: () => "/", realpath: real })).toBe("yes");
  });

  test("leere Befehlszeile: unklar, Sperre bleibt belegt", async () => {
    expect(botCommandFor("", 111, "/x", { cwd: () => "/x", realpath: fakeRealpath })).toBe("unclear");
    expect(botCommandFor("   ", 111, "/x", { cwd: () => "/x", realpath: fakeRealpath })).toBe("unclear");
    const r = await legacy({ 111: { started: T_BOT, command: "", cwd: "/x" } });
    expect(r.result).toMatchObject({ ok: false, rejection: { state: "held", why: "unverifiable", pid: 111 } });
    expect(r.m.files.get("/x/bot.lock")).toBe("111");
  });

  test("Pfad zu src/bot.ts nicht feststellbar (realpath scheitert) oder nicht mehr vorhanden: unklar", () => {
    const unknown = (p: string): RealPath => (p === "/x" ? { path: "/x" } : "unknown");
    expect(botCommandFor("bun run /y/src/bot.ts", 1, "/x", { cwd: () => "/", realpath: unknown })).toBe("unclear");
    // Ordner umbenannt, während der Bot lief: der alte Pfad fehlt, das beweist nichts
    expect(botCommandFor("bun run /alt/x/src/bot.ts", 1, "/x", { cwd: () => "/", realpath: fakeRealpath })).toBe("unclear");
    // Projektordner selbst nicht feststellbar: nur ein wörtlicher Treffer zählt
    const rootUnknown = (p: string): RealPath => (p === "/x" ? "unknown" : fakeRealpath(p));
    expect(botCommandFor("bun run /x/src/bot.ts", 1, "/x", { cwd: () => "/", realpath: rootUnknown })).toBe("yes");
    expect(botCommandFor("bun run /anderer/x/src/bot.ts", 1, "/x", { cwd: () => "/", realpath: rootUnknown })).toBe("unclear");
  });

  test("Ordner umbenannt, fremder Suffixpfad vorhanden: unklar, lebender Besitzer behält die Sperre", async () => {
    // '/old dir' wurde zu '/x'; zufällig gibt es auch '/x/dir/src/bot.ts'
    const real = (p: string): RealPath => (["/", "/x", "/x/src/bot.ts", "/x/dir/src/bot.ts"].includes(p) ? { path: p } : "missing");
    const command = "bun /old dir/src/bot.ts";
    expect(botCommandFor(command, 111, "/x", { cwd: () => "/x", realpath: real })).toBe("unclear");
    const m = memoryFs("111");
    const procs = { 111: { started: T_BOT, command, cwd: "/x" } };
    const lock = createProcessLock({ path: "/x/bot.lock", pid: ME, root: "/x", started: T_ME, fs: m.fs, inspector: { ...fakeInspector(procs), realpath: real } });
    expect(await lock.tryAcquire()).toMatchObject({ ok: false, rejection: { state: "held", why: "unverifiable", pid: 111 } });
    expect(m.files.get("/x/bot.lock")).toBe("111");
    expect(m.calls.some(c => c.startsWith("remove"))).toBe(false);
    expect(await botLockHeld("/x", { ...fakeInspector(procs), realpath: real }, m.fs)).toBe(true);
    // Nur das Programm selbst gehört nie zum Pfad; Optionen und run können Anfang eines Ordnernamens sein
    expect(botCommandFor("bun --watch run src/bot.ts", 111, "/x", { cwd: () => "/anderer/checkout", realpath: fakeRealpath })).toBe("unclear");
    expect(botCommandFor("bun src/bot.ts", 111, "/x", { cwd: () => "/anderer/checkout", realpath: fakeRealpath })).toBe("no");
  });

  test("ohne src/bot.ts in der Befehlszeile oder nur ähnliche Namen: kein Bot", () => {
    const inspector = { cwd: () => "/x", realpath: fakeRealpath };
    expect(botCommandFor("/usr/sbin/cupsd -l", 1, "/x", inspector)).toBe("no");
    expect(botCommandFor("bun run mysrc/bot.ts", 1, "/x", inspector)).toBe("no");
    expect(botCommandFor("bun run src/bot.tsx", 1, "/x", inspector)).toBe("no");
  });
});

describe("Sperrdatei: Freigeben und Herzschlag", () => {
  test("Freigeben löscht nur die eigene Sperre (PID und Startzeit)", async () => {
    const own = memoryFs(MINE);
    await lockAt(own.fs, {}).release();
    expect(own.files.has("/x/bot.lock")).toBe(false);

    // Gleiche PID, andere Startzeit: ein früherer Prozess mit dieser Nummer
    for (const content of [lockJson(111, T_BOT), lockJson(ME, T_OLD), String(ME)]) {
      const foreign = memoryFs(content);
      await lockAt(foreign.fs, {}).release();
      expect(foreign.files.get("/x/bot.lock")).toBe(content);
      expect(foreign.calls).toEqual([]);
    }
  });

  test("Herzschlag schreibt nur die eigene Sperre neu", async () => {
    const own = memoryFs(MINE);
    await lockAt(own.fs, {}).touch();
    expect(own.calls).toEqual(["overwrite /x/bot.lock"]);
    expect(own.files.get("/x/bot.lock")).toBe(MINE);

    for (const content of [lockJson(111, T_BOT), lockJson(ME, T_OLD), String(ME), "{\"pid\":4242"]) {
      const foreign = memoryFs(content);
      await lockAt(foreign.fs, {}).touch();
      expect(foreign.calls).toEqual([]);
    }

    const missing = memoryFs();
    await lockAt(missing.fs, {}).touch();
    expect(missing.calls).toEqual([]);
  });

  test("Herzschlag läuft noch, während freigegeben wird: Freigabe wartet, kein Nachfolger wird überschrieben", async () => {
    // Reihenfolge aus der Prüfung: A liest im Herzschlag seine Sperre, hängt
    // vor dem Schreiben; A gibt frei; B übernimmt; A schreibt mit alter
    // Identität und endet; C hielte die Sperre dann für verwaist
    const m = memoryFs(MINE);
    let openGate: () => void = () => {};
    const gate = new Promise<void>(r => (openGate = r));
    const order: string[] = [];
    const gated: LockFs = {
      ...m.fs,
      async overwrite(path, content) {
        order.push("overwrite beginnt");
        await gate;
        await m.fs.overwrite(path, content);
        order.push("overwrite fertig");
      },
      async remove(path) {
        order.push(`remove ${path}`);
        await m.fs.remove(path);
      },
    };
    const procs: Record<number, FakeProc> = { 2002: { started: T_BOT, command: "bun run /x/src/bot.ts" } };
    const a = lockAt(gated, procs);
    const beat = a.touch();
    await new Promise(r => setTimeout(r, 0));
    expect(order).toEqual(["overwrite beginnt"]);

    let released = false;
    const release = a.release().then(() => void (released = true));
    await new Promise(r => setTimeout(r, 5));
    // Die Freigabe wartet auf den laufenden Herzschlag
    expect(released).toBe(false);
    expect(m.files.get("/x/bot.lock")).toBe(MINE);

    openGate();
    await Promise.all([beat, release]);
    expect(order).toEqual(["overwrite beginnt", "overwrite fertig", "remove /x/bot.lock"]);
    expect(m.files.has("/x/bot.lock")).toBe(false);

    // B übernimmt; ein später Herzschlag von A schreibt nichts mehr
    const b = createProcessLock({ path: "/x/bot.lock", pid: 2002, root: "/x", started: T_BOT, fs: m.fs, inspector: fakeInspector(procs) });
    expect(await b.tryAcquire()).toEqual({ ok: true });
    await a.touch();
    expect(m.files.get("/x/bot.lock")).toBe(lockJson(2002, T_BOT));

    // A ist weg, B lebt: C bekommt die Sperre nicht
    const c = createProcessLock({ path: "/x/bot.lock", pid: 3003, root: "/x", started: T_ME, fs: m.fs, inspector: fakeInspector(procs) });
    expect(await c.tryAcquire()).toMatchObject({ ok: false, rejection: { state: "held", why: "same-start", pid: 2002 } });
    expect(m.files.get("/x/bot.lock")).toBe(lockJson(2002, T_BOT));
  });

  test("Herzschläge nach der Freigabe und gestaute Herzschläge schreiben nichts", async () => {
    const m = memoryFs(MINE);
    const a = lockAt(m.fs, {});
    const queued = [a.touch(), a.touch()];
    const release = a.release();
    await Promise.all([...queued, release, a.touch()]);
    // Höchstens der erste, schon laufende Herzschlag schrieb vor dem Löschen
    expect(m.calls.filter(c => c.startsWith("overwrite")).length).toBeLessThanOrEqual(1);
    expect(m.calls.at(-1)).toBe("remove /x/bot.lock");
    expect(m.files.has("/x/bot.lock")).toBe(false);
  });

  test("Herzschlag: Schreibfehler wird geschluckt", async () => {
    const m = memoryFs(MINE);
    const fs: LockFs = { ...m.fs, overwrite: async () => { throw new Error("schreibgeschützt"); } };
    await expect(lockAt(fs, {}).touch()).resolves.toBeUndefined();
  });
});

describe("Sperrdatei: abgelehnter Start", () => {
  test("Zeile wie im Issue: Prozess, Befehl ohne Argumente, Startzeit in UTC", () => {
    const held = { state: "held", pid: 111, why: "same-start", command: "/opt/bun/bin/bun run /x/src/bot.ts --token geheim123", started: "Thu Oct  1 06:35:20 2026" } as const;
    const line = lockRejectionMessage({ ...held, entry: "/x/src/bot.ts" }, "/x/bot.lock");
    expect(line).toBe("Start abgelehnt: bot.lock gehört Prozess 111 (bun /x/src/bot.ts …), gestartet 2026-10-01 06:35:20 UTC.");
    expect(line).not.toContain("geheim123");
    // Ohne nachgewiesenen Pfad kein Stück aus der Befehlszeile
    expect(lockRejectionMessage({ ...held, entry: null }, "/x/bot.lock")).toBe("Start abgelehnt: bot.lock gehört Prozess 111 (bun …), gestartet 2026-10-01 06:35:20 UTC.");
  });

  test("ehrliche Ersatzmeldungen: unbekannter Befehl und Zeit, unklar, beschädigt, Übernahme läuft, Fehler", () => {
    expect(lockRejectionMessage({ state: "held", pid: 111, why: "unverifiable", command: null, started: null }, "/x/bot.lock")).toBe(
      "Start abgelehnt: bot.lock gehört Prozess 111 (Befehl unbekannt), gestartet zu unbekannter Zeit. Ob er ein Bot aus diesem Ordner ist, ließ sich nicht prüfen.",
    );
    expect(lockRejectionMessage({ state: "held", pid: null, why: "unreadable", command: null, started: null }, "/x/bot.lock")).toBe(
      "Start abgelehnt: bot.lock ist unlesbar oder beschädigt (/x/bot.lock). Läuft kein Bot, darf die Datei weg.",
    );
    expect(lockRejectionMessage({ state: "busy" }, "/x/bot.lock")).toBe("Start abgelehnt: bot.lock wird gerade von einem anderen Start übernommen.");
    expect(lockRejectionMessage({ state: "error", code: "EACCES" }, "/x/bot.lock")).toBe("Start abgelehnt: bot.lock ließ sich nicht anlegen (EACCES).");
  });

  test("Befehl fürs Log: nur Programmname und nachgewiesener Pfad zu src/bot.ts", () => {
    expect(describeLockCommand("bun run src/bot.ts")).toBe("bun …");
    expect(describeLockCommand("/usr/bin/bun src/bot.ts")).toBe("bun …");
    expect(describeLockCommand("bun run src/bot.ts", "/x/src/bot.ts")).toBe("bun /x/src/bot.ts …");
    // Nachgewiesen, aber kein reiner Dateipfad: ausgelassen
    expect(describeLockCommand("bun run src/bot.ts", "/mein ordner/src/bot.ts")).toBe("bun …");
    expect(describeLockCommand("/sbin/launchd")).toBe("launchd");
    expect(describeLockCommand("curl -H Authorization:geheim https://x")).toBe("curl …");
    expect(describeLockCommand("  ")).toBe("Befehl unbekannt");
  });

  test("Zugangsdaten in einem Argument, das auf src/bot.ts endet, erscheinen nicht im Log", async () => {
    // Erfundene Zugangsdaten
    const command = "curl https://nutzer:BEISPIELGEHEIMNIS@example.invalid/src/bot.ts";
    expect(describeLockCommand(command)).toBe("curl …");
    expect(describeLockCommand("bun --config=BEISPIELGEHEIMNIS/src/bot.ts")).toBe("bun …");
    expect(describeLockCommand("curl --oauth2-bearer /BEISPIELGEHEIMNIS/src/bot.ts https://example.invalid")).toBe("curl …");
    expect(describeLockCommand("nutzer:BEISPIELGEHEIMNIS@host /x/src/bot.ts")).toBe("Befehl ausgeblendet");
    // Der volle Ablehnungsweg: Sperre mit lebendem Besitzer, Zeile fürs Log
    const m = memoryFs(lockJson(111, T_BOT));
    const lines: string[] = [];
    const ok = await acquireLockOrExit(lockAt(m.fs, { 111: { ...BOT_HERE, command } }), { path: "/x/bot.lock", exit: () => {}, error: line => void lines.push(line) });
    expect(ok).toBe(false);
    expect(lines).toEqual(["Start abgelehnt: bot.lock gehört Prozess 111 (curl …), gestartet 2026-11-11 08:00:00 UTC."]);
    expect(lines.join("\n")).not.toContain("BEISPIELGEHEIMNIS");
  });

  test("alte Sperre, Besitzer mit Zugangswert als scheinbarem Pfad: voller Ablehnungsweg ohne den Wert", async () => {
    // Erfundener Zugangswert; das Argument sieht aus wie ein absoluter Pfad zu src/bot.ts
    const command = "curl --oauth2-bearer /BEISPIELGEHEIMNIS/src/bot.ts https://example.invalid";
    const m = memoryFs("111");
    const lines: string[] = [];
    const exits: number[] = [];
    const lock = createProcessLock({ path: "/x/bot.lock", pid: ME, root: "/x", started: T_ME, fs: m.fs, inspector: fakeInspector({ 111: { started: T_BOT, command, cwd: "/x" } }) });
    const ok = await acquireLockOrExit(lock, { path: "/x/bot.lock", exit: code => void exits.push(code), error: line => void lines.push(line) });
    expect(ok).toBe(false);
    expect(exits).toEqual([1]);
    expect(lines).toEqual(["Start abgelehnt: bot.lock gehört Prozess 111 (curl …), gestartet 2026-11-11 08:00:00 UTC. Ob er ein Bot aus diesem Ordner ist, ließ sich nicht prüfen."]);
    expect(lines.join("\n")).not.toContain("BEISPIELGEHEIMNIS");
    expect(m.files.get("/x/bot.lock")).toBe("111");

    // Neue Sperre mit derselben Startzeit: auch hier nur Programmname und Auslassung
    const same = memoryFs(lockJson(111, T_BOT));
    lines.length = 0;
    const sameLock = createProcessLock({ path: "/x/bot.lock", pid: ME, root: "/x", started: T_ME, fs: same.fs, inspector: fakeInspector({ 111: { started: T_BOT, command, cwd: "/x" } }) });
    expect(await acquireLockOrExit(sameLock, { path: "/x/bot.lock", exit: () => {}, error: line => void lines.push(line) })).toBe(false);
    expect(lines).toEqual(["Start abgelehnt: bot.lock gehört Prozess 111 (curl …), gestartet 2026-11-11 08:00:00 UTC."]);
  });

  test("Startzeit: feste Darstellung, Unlesbares bleibt erkennbar", () => {
    expect(formatLockStart("Thu Nov 12 20:17:33 2026")).toBe("2026-11-12 20:17:33 UTC");
    expect(formatLockStart("irgendwas")).toBe("irgendwas UTC");
  });

  test("acquireLockOrExit: erst die Zeile, dann Exit 1; Fehler beim Anlegen ebenso", async () => {
    const events: string[] = [];
    const held = memoryFs(lockJson(111, T_BOT));
    const ok = await acquireLockOrExit(lockAt(held.fs, { 111: BOT_HERE }), { path: "/x/bot.lock", exit: code => void events.push(`exit ${code}`), error: line => void events.push(line) });
    expect(ok).toBe(false);
    expect(events).toEqual(["Start abgelehnt: bot.lock gehört Prozess 111 (bun /x/src/bot.ts …), gestartet 2026-11-11 08:00:00 UTC.", "exit 1"]);

    events.length = 0;
    const broken: LockFs = { ...memoryFs().fs, create: async () => { throw Object.assign(new Error("x"), { code: "EROFS" }); } };
    expect(await acquireLockOrExit(lockAt(broken, {}), { path: "/x/bot.lock", exit: code => void events.push(`exit ${code}`), error: line => void events.push(line) })).toBe(false);
    expect(events).toEqual(["Start abgelehnt: bot.lock ließ sich nicht anlegen (EROFS).", "exit 1"]);

    events.length = 0;
    expect(await acquireLockOrExit(lockAt(memoryFs().fs, {}), { path: "/x/bot.lock", exit: code => void events.push(`exit ${code}`), error: line => void events.push(line) })).toBe(true);
    expect(events).toEqual([]);
  });
});

describe("Sperrdatei auf der Platte", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  /** Zwei Bots 1001 und 1002 laut Attrappe; 77 ist tot */
  const procs: Record<number, FakeProc> = {
    1001: { started: "Thu Nov 12 10:00:01 2026", command: "bun run src/bot.ts", cwd: "/" },
    1002: { started: "Thu Nov 12 10:00:02 2026", command: "bun run src/bot.ts", cwd: "/" },
  };
  const diskLock = (path: string, pid: number) => createProcessLock({ path, pid, inspector: fakeInspector(procs) });

  test("zwei gleichzeitige Versuche: genau einer bekommt die Sperre, Rechte 600, vollständiger Inhalt", async () => {
    dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    const path = join(dir, "bot.lock");
    const results = await Promise.all([diskLock(path, 1001).tryAcquire(), diskLock(path, 1002).tryAcquire()]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect([lockJson(1001, procs[1001].started), lockJson(1002, procs[1002].started)]).toContain(await readFile(path, "utf8"));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["bot.lock"]);
  });

  test("zwei gleichzeitige Übernahmen derselben verwaisten Sperre: genau ein Besitzer, immer wieder", async () => {
    for (let round = 0; round < 25; round++) {
      dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
      const path = join(dir, "bot.lock");
      await writeFile(path, round % 2 ? lockJson(77, T_OLD) : "77");
      const a = diskLock(path, 1001);
      const b = diskLock(path, 1002);
      const results = await Promise.all([a.tryAcquire(), b.tryAcquire()]);
      expect(results.filter(r => r.ok)).toHaveLength(1);
      const winner = results[0].ok ? 1001 : 1002;
      expect(await readFile(path, "utf8")).toBe(lockJson(winner, procs[winner].started));
      // Keine Aufbruch- oder Zwischendatei bleibt liegen
      expect(await readdir(dir)).toEqual(["bot.lock"]);
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  test("Übernahme im ungünstigsten Takt: der Zweite löscht nie die neue Sperre des Ersten", async () => {
    // Beide lesen dieselbe verwaiste Sperre; der Erste bricht auf und legt an,
    // erst danach kommt der Zweite zum Löschen
    const m = memoryFs("77");
    let release: () => void = () => {};
    const gate = new Promise<void>(r => (release = r));
    let reads = 0;
    const slow: LockFs = {
      ...m.fs,
      async read(path) {
        const value = await m.fs.read(path);
        if (path === "/x/bot.lock" && ++reads === 1) await gate;
        return value;
      },
    };
    const inspector = fakeInspector(procs);
    const b = createProcessLock({ path: "/x/bot.lock", pid: 1002, root: "/x", fs: slow, inspector });
    const a = createProcessLock({ path: "/x/bot.lock", pid: 1001, root: "/x", fs: m.fs, inspector });
    const pendingB = b.tryAcquire();
    expect((await a.tryAcquire()).ok).toBe(true);
    release();
    expect((await pendingB).ok).toBe(false);
    expect(m.files.get("/x/bot.lock")).toBe(lockJson(1001, procs[1001].started));
  });

  test("Pause zwischen erneutem Lesen und Löschen: der Andere wartet auf die Aufbruch-Sperre, genau ein Besitzer", async () => {
    // Früher konnte genau hier ein zweiter Start die frisch angelegte Sperre
    // des ersten löschen (Rennen zwischen erneutem Lesen und Löschen)
    const m = memoryFs("77");
    let release: () => void = () => {};
    const gate = new Promise<void>(r => (release = r));
    let reads = 0;
    const slow: LockFs = {
      ...m.fs,
      async read(path) {
        const value = await m.fs.read(path);
        // zweites Lesen von bot.lock: die Prüfung vor dem Löschen
        if (path === "/x/bot.lock" && ++reads === 2) await gate;
        return value;
      },
    };
    const inspector = fakeInspector(procs);
    const b = createProcessLock({ path: "/x/bot.lock", pid: 1002, root: "/x", fs: slow, inspector });
    const a = createProcessLock({ path: "/x/bot.lock", pid: 1001, root: "/x", fs: m.fs, inspector });
    const pendingB = b.tryAcquire();
    await new Promise(r => setTimeout(r, 5));
    const resultA = await a.tryAcquire();
    release();
    const resultB = await pendingB;
    expect(resultA).toEqual({ ok: false, rejection: { state: "busy" } });
    expect(resultB).toEqual({ ok: true });
    expect(m.files.get("/x/bot.lock")).toBe(lockJson(1002, procs[1002].started));
    expect([...m.files.keys()]).toEqual(["/x/bot.lock"]);
  });

  test("dieselbe Sperre über einen Symlink auf den Ordner: dieselbe Aufbruch-Sperre, genau ein Besitzer", async () => {
    // A pausiert nach dem erneuten Lesen der verwaisten Sperre; B kommt über
    // den Symlink. Früher nahm B eine eigene Aufbruch-Sperre, und A löschte
    // danach Bs lebende Sperre.
    dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    const realDir = join(dir, "x");
    const aliasDir = join(dir, "alias");
    await mkdir(realDir);
    await symlink(realDir, aliasDir);
    const realPath = join(realDir, "bot.lock");
    const aliasPath = join(aliasDir, "bot.lock");
    await writeFile(realPath, "77");
    const disk: LockFs = {
      create: async (path, content) => writeFile(path, content, { flag: "wx", mode: 0o600 }),
      read: async path => {
        try {
          return await readFile(path, "utf8");
        } catch (err) {
          if ((err as { code?: unknown }).code === "ENOENT") return null;
          throw err;
        }
      },
      overwrite: (path, content) => writeFile(path, content),
      remove: path => rm(path, { force: true }),
    };
    let release: () => void = () => {};
    const gate = new Promise<void>(r => (release = r));
    let paused: () => void = () => {};
    const pausedAt = new Promise<void>(r => (paused = r));
    let reads = 0;
    const slow: LockFs = {
      ...disk,
      async read(path) {
        const value = await disk.read(path);
        // zweites Lesen von bot.lock: die Prüfung vor dem Löschen
        if (path === realPath && ++reads === 2) {
          paused();
          await gate;
        }
        return value;
      },
    };
    const inspector = fakeInspector(procs);
    const a = createProcessLock({ path: realPath, pid: 1001, root: realDir, fs: slow, inspector });
    const b = createProcessLock({ path: aliasPath, pid: 1002, root: aliasDir, fs: disk, inspector });
    const pendingA = a.tryAcquire();
    await pausedAt;
    const resultB = await b.tryAcquire();
    release();
    const resultA = await pendingA;
    expect(resultA).toEqual({ ok: true });
    expect(resultB).toEqual({ ok: false, rejection: { state: "busy" } });
    expect(await readFile(realPath, "utf8")).toBe(lockJson(1001, procs[1001].started));
    expect(await readdir(realDir)).toEqual(["bot.lock"]);
  });

  test("Aufbruch-Sperre eines abgestürzten Starts blockiert nicht für immer", async () => {
    dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    const path = join(dir, "bot.lock");
    const stale = lockJson(77, T_OLD);
    await writeFile(path, stale);
    // Ein Start mit PID 78 starb mitten im Aufbrechen
    await writeFile(breakMarkerPath(path, breakMarkerKey("", stale)), lockJson(78, T_OLD));
    expect((await diskLock(path, 1001).tryAcquire()).ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe(lockJson(1001, procs[1001].started));
    expect(await readdir(dir)).toEqual(["bot.lock"]);
  });

  test("verschachtelte Aufbruch-Sperren nach mehreren Abstürzen, alle Besitzer tot: Start klappt, alles aufgeräumt", async () => {
    for (const levels of [2, 3, 6]) {
      dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
      const path = join(dir, "bot.lock");
      // bot.lock von 77; dann starb je ein Start beim Aufbrechen der vorigen Datei
      let key = "";
      let content = lockJson(77, T_OLD);
      await writeFile(path, content);
      for (let level = 1; level <= levels; level++) {
        key = breakMarkerKey(key, content);
        content = lockJson(77 + level, T_OLD);
        await writeFile(breakMarkerPath(path, key), content);
      }
      expect(await readdir(dir)).toHaveLength(levels + 1);
      expect(await diskLock(path, 1001).tryAcquire()).toEqual({ ok: true });
      expect(await readFile(path, "utf8")).toBe(lockJson(1001, procs[1001].started));
      expect(await readdir(dir)).toEqual(["bot.lock"]);
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  test("verschachtelte Aufbruch-Sperre mit lebendem Besitzer: kein Aufbrechen, nichts gelöscht", async () => {
    dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    const path = join(dir, "bot.lock");
    const stale = lockJson(77, T_OLD);
    await writeFile(path, stale);
    const firstKey = breakMarkerKey("", stale);
    const first = breakMarkerPath(path, firstKey);
    await writeFile(first, lockJson(78, T_OLD));
    // Gerade bricht Bot 1002 die erste Aufbruch-Sperre auf
    const second = breakMarkerPath(path, breakMarkerKey(firstKey, lockJson(78, T_OLD)));
    await writeFile(second, lockJson(1002, procs[1002].started));
    expect((await diskLock(path, 1001).tryAcquire()).ok).toBe(false);
    expect((await readdir(dir)).sort()).toEqual([basenameOf(path), basenameOf(first), basenameOf(second)].sort());
    expect(await readFile(path, "utf8")).toBe(stale);
  });

  test("Aufbruch-Sperren haben auf jeder Ebene gleich lange Namen", () => {
    const oneKey = breakMarkerKey("", "77");
    const one = breakMarkerPath("/x/bot.lock", oneKey);
    const two = breakMarkerPath("/x/bot.lock", breakMarkerKey(oneKey, "78"));
    expect(two.length).toBe(one.length);
    expect(two).not.toBe(one);
  });

  test("bot.lock ist ein Ordner (EISDIR) oder ohne Leserecht: belegt, kein Start, botLockHeld true", async () => {
    dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    const path = join(dir, "bot.lock");
    await mkdir(path);
    expect(await diskLock(path, 1001).tryAcquire()).toMatchObject({ ok: false, rejection: { state: "held", why: "unreadable" } });
    expect(await botLockHeld(dir)).toBe(true);
    await rm(path, { recursive: true });

    // Ohne Datei: frei
    expect(await botLockHeld(dir)).toBe(false);

    // Ohne Leserecht; als root gilt das Recht nicht, dann bleibt der Ordner-Fall
    if (process.getuid?.() !== 0) {
      await writeFile(path, lockJson(77, T_OLD));
      await chmod(path, 0o000);
      try {
        expect(await botLockHeld(dir)).toBe(true);
        expect(await diskLock(path, 1001).tryAcquire()).toMatchObject({ ok: false, rejection: { state: "held", why: "unreadable" } });
      } finally {
        await chmod(path, 0o600);
      }
      expect(await readFile(path, "utf8")).toBe(lockJson(77, T_OLD));
    }
  });

  test("botLockHeld: nur ENOENT ist frei, jeder andere Lesefehler belegt", async () => {
    const fail = (code: string) => ({ read: async () => { throw Object.assign(new Error(code), { code }); } });
    for (const code of ["EACCES", "EPERM", "EISDIR", "EIO"]) expect(await botLockHeld("/x", {}, fail(code))).toBe(true);
    expect(await botLockHeld("/x", {}, { read: async () => null })).toBe(false);
  });

  test("echte Prozessabfrage: Symlink mit Leerzeichen auf den Projektordner, alte Sperre, Bot läuft über den Symlink", async () => {
    dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    const realDir = join(dir, "real dir");
    const aliasDir = join(dir, "alias dir");
    await mkdir(join(realDir, "src"), { recursive: true });
    await symlink(realDir, aliasDir);
    const { spawnFakeBot } = await import("./bot-lock-fixture");
    const bot = await spawnFakeBot(aliasDir, "absolute", dir);
    try {
      await writeFile(join(realDir, "bot.lock"), String(bot.pid));
      expect(await botLockHeld(realDir)).toBe(true);
      const result = await createProcessLock({ path: join(realDir, "bot.lock"), pid: process.pid, root: realDir, started: T_ME }).tryAcquire();
      expect(result).toMatchObject({ ok: false, rejection: { state: "held", why: "bot-command", pid: bot.pid } });
      expect(await readFile(join(realDir, "bot.lock"), "utf8")).toBe(String(bot.pid));
    } finally {
      await bot.stop();
    }
  });

  test("echte Prozessabfrage: Sperre mit PID dieses Testprozesses, aber anderer Startzeit, wird übernommen", async () => {
    // Nur ps auf den eigenen Prozess und Signal 0 an sich selbst, kein fremder Prozess
    dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    const path = join(dir, "bot.lock");
    await writeFile(path, lockJson(process.pid, T_OLD));
    const lock = createProcessLock({ path, pid: process.pid, started: T_ME });
    expect((await lock.tryAcquire()).ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe(lockJson(process.pid, T_ME));
  });

  test("echte Prozessabfrage: alte Sperre mit PID dieses Testprozesses (kein src/bot.ts) wird übernommen", async () => {
    dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    const path = join(dir, "bot.lock");
    await writeFile(path, String(process.pid));
    expect((await createProcessLock({ path, pid: process.pid, started: T_ME }).tryAcquire()).ok).toBe(true);
  });

  test("echte Prozessabfrage: eigene Startzeit ist stabil und wird als lebender Besitzer erkannt", async () => {
    dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    const path = join(dir, "bot.lock");
    const first = createProcessLock({ path, pid: process.pid });
    expect((await first.tryAcquire()).ok).toBe(true);
    const content = parseLockContent(await readFile(path, "utf8"));
    expect(content?.pid).toBe(process.pid);
    expect(content?.started).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
    // Ein zweiter Start sieht denselben lebenden Prozess mit derselben Startzeit
    const second = await createProcessLock({ path, pid: 999_999_999, started: T_ME }).tryAcquire();
    expect(second).toMatchObject({ ok: false, rejection: { state: "held", why: "same-start", pid: process.pid } });
    expect(await botLockHeld(dir)).toBe(true);
    await first.release();
    expect(existsSync(path)).toBe(false);
    expect(await botLockHeld(dir)).toBe(false);
  });

  test("Herzschlag ersetzt die Datei vollständig (rename), Rechte bleiben 600", async () => {
    dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    const path = join(dir, "bot.lock");
    const lock = diskLock(path, 1001);
    expect((await lock.tryAcquire()).ok).toBe(true);
    await lock.touch();
    expect(await readFile(path, "utf8")).toBe(lockJson(1001, procs[1001].started));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["bot.lock"]);
  });
});

describe("probePid", () => {
  test("eigener Prozess lebt, unbelegte PID ist weg", () => {
    expect(probePid(process.pid)).toBe("alive");
    expect(probePid(2 ** 30)).toBe("gone");
  });

  test("EPERM und andere Fehler: unbekannt", () => {
    const kill = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
    expect(probePid(1, kill("EPERM"))).toBe("unknown");
    expect(probePid(1, kill("EINVAL"))).toBe("unknown");
    expect(probePid(1, kill("ESRCH"))).toBe("gone");
    expect(probePid(1, () => true)).toBe("alive");
  });
});

/** Zeitgeber zum Weiterdrehen per Hand */
function manualTimers() {
  let next = 1;
  const active = new Map<number, { ms: number; fn: () => unknown }>();
  return {
    timers: {
      setInterval: (fn: () => unknown, ms: number) => {
        const id = next++;
        active.set(id, { ms, fn });
        return id;
      },
      clearInterval: (id: unknown) => void active.delete(id as number),
    },
    /** alle Zeitgeber mit diesem Abstand einmal auslösen */
    fire(ms: number) {
      for (const t of [...active.values()]) if (t.ms === ms) t.fn();
    },
    count: () => active.size,
  };
}

function rig(opts: { release?: () => Promise<void> } = {}) {
  const events: string[] = [];
  const clock = manualTimers();
  const exits: number[] = [];
  const lifecycle = createLifecycle({
    lock: {
      touch: async () => void events.push("touch"),
      release: opts.release ?? (async () => void events.push("release")),
    },
    exit: code => void exits.push(code),
    timers: clock.timers,
    sleep: async ms => void events.push(`sleep ${ms}`),
    log: line => void events.push(`log ${line.trim()}`),
    warn: line => void events.push(`warn ${line}`),
    afterRelease: async reason => void events.push(`after ${reason}`),
  });
  return { lifecycle, events, clock, exits };
}

describe("Lebenszyklus", () => {
  test("Herzschlag alle 60 Sekunden, nach dem Beenden nicht mehr", async () => {
    const r = rig();
    r.lifecycle.startHeartbeat();
    r.clock.fire(60_000);
    expect(r.events).toEqual(["touch"]);
    await r.lifecycle.shutdown("SIGTERM");
    expect(r.clock.count()).toBe(0);
    r.events.length = 0;
    r.clock.fire(60_000);
    expect(r.events).toEqual([]);
  });

  test("Herzschlag, der nach dem Beginn des Beendens noch feuert, schreibt nichts", async () => {
    const events: string[] = [];
    let tick: (() => unknown) | undefined;
    const lifecycle = createLifecycle({
      lock: { touch: async () => void events.push("touch"), release: async () => {} },
      exit: () => {},
      timers: { setInterval: fn => ((tick = fn), 1), clearInterval: () => {} },
      sleep: async () => {},
      log: () => {},
    });
    lifecycle.startHeartbeat();
    void lifecycle.shutdown("SIGINT");
    tick!();
    expect(events).toEqual([]);
  });

  test("Reihenfolge: Flag, Zeitgeber aus, Closer der Reihe nach, Schonfrist, Sperre frei, Protokoll, Exit 0", async () => {
    const r = rig();
    const seen: boolean[] = [];
    r.lifecycle.every(30_000, () => void r.events.push("tick"));
    r.lifecycle.onShutdown("eins", () => {
      seen.push(r.lifecycle.isShuttingDown());
      r.events.push(`eins (zeitgeber ${r.clock.count()})`);
    });
    r.lifecycle.onShutdown("zwei", async () => {
      await Promise.resolve();
      r.events.push("zwei");
    });
    expect(r.lifecycle.isShuttingDown()).toBe(false);
    await r.lifecycle.shutdown("SIGTERM");
    expect(seen).toEqual([true]);
    expect(r.events).toEqual([
      "log Received SIGTERM. Shutting down gracefully...",
      "eins (zeitgeber 0)",
      "zwei",
      "sleep 1600",
      "release",
      "after SIGTERM",
      "log Shutdown complete.",
    ]);
    expect(r.exits).toEqual([0]);
  });

  test("mehrfaches Beenden: Closer laufen einmal, ein Exit", async () => {
    const r = rig();
    let runs = 0;
    r.lifecycle.onShutdown("zaehler", async () => void runs++);
    await Promise.all([r.lifecycle.shutdown("SIGTERM"), r.lifecycle.shutdown("SIGINT"), r.lifecycle.shutdown("restart-requested")]);
    await r.lifecycle.shutdown("SIGHUP");
    expect(runs).toBe(1);
    expect(r.exits).toEqual([0]);
    expect(r.events.filter(e => e.startsWith("log Received"))).toEqual(["log Received SIGTERM. Shutting down gracefully..."]);
  });

  test("fehlerhafter Closer (wirft, lehnt ab, nicht initialisiert): Rest läuft, Sperre wird frei", async () => {
    const r = rig();
    r.lifecycle.onShutdown("wirft", () => {
      throw new TypeError("kaputt");
    });
    r.lifecycle.onShutdown("lehnt-ab", () => Promise.reject(new RangeError("weg")));
    r.lifecycle.onShutdown("danach", () => void r.events.push("danach"));
    await r.lifecycle.shutdown("uncaughtException");
    expect(r.events).toContain("warn [shutdown] wirft gescheitert (TypeError)");
    expect(r.events).toContain("warn [shutdown] lehnt-ab gescheitert (RangeError)");
    // Fehlermeldungen kommen nicht ins Log, sie könnten Geheimnisse tragen
    expect(r.events.join("\n")).not.toContain("kaputt");
    expect(r.events.indexOf("danach")).toBeLessThan(r.events.indexOf("release"));
    expect(r.exits).toEqual([0]);
  });

  test("Freigeben oder Protokoll scheitern: trotzdem Exit 0", async () => {
    const r = rig({ release: async () => { throw new Error("nein"); } });
    await r.lifecycle.shutdown("SIGTERM");
    expect(r.events).toContain("warn [shutdown] Sperre freigeben gescheitert (Error)");
    expect(r.exits).toEqual([0]);

    const exits: number[] = [];
    const life = createLifecycle({
      lock: { touch: async () => {}, release: async () => {} },
      exit: code => void exits.push(code),
      sleep: async () => {},
      log: () => {},
      afterRelease: () => Promise.reject(new Error("Datenbank weg")),
    });
    await life.shutdown("SIGTERM");
    expect(exits).toEqual([0]);
  });

  test("Import ohne Nebenwirkungen: kein Zeitgeber, keine Signale, keine Datei", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    try {
      const before = process.listenerCount("SIGTERM");
      await import(`../src/app/lifecycle?fresh=${Date.now()}`);
      const lock = createProcessLock({ path: join(dir, "bot.lock"), pid: 1 });
      createLifecycle({ lock, exit: () => {} });
      expect(process.listenerCount("SIGTERM")).toBe(before);
      expect(existsSync(join(dir, "bot.lock"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("echter Prozess", () => {
  test("SIGTERM: Closer laufen, Sperre weg, Exit 0; ein zweiter Prozess bekommt die Sperre solange nicht", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    try {
      const child = join(import.meta.dir, "lifecycle-child.ts");
      const first = Bun.spawn(["bun", child, dir], { stdout: "pipe", stderr: "pipe" });
      const reader = first.stdout.getReader();
      let out = "";
      while (!out.includes("bereit")) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      expect(parseLockContent(await readFile(join(dir, "bot.lock"), "utf8"))?.pid).toBe(first.pid);

      // Zweiter Start: Grund auf stderr, dann Exit 1, ohne Datenbank (Issue #564)
      const second = Bun.spawn(["bun", child, dir], { stdout: "pipe", stderr: "pipe" });
      expect(await second.exited).toBe(1);
      expect(await new Response(second.stdout).text()).toContain("gesperrt");
      expect(await new Response(second.stderr).text()).toMatch(
        new RegExp(`^Start abgelehnt: bot\\.lock gehört Prozess ${first.pid} \\(bun …\\), gestartet \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d UTC\\.\\n`),
      );

      first.kill("SIGTERM");
      expect(await first.exited).toBe(0);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      expect(out).toContain("closer");
      expect(out).toContain("Shutdown complete.");
      expect(existsSync(join(dir, "bot.lock"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Signale", () => {
  function signalRig() {
    const handlers = new Map<string, (arg?: unknown) => unknown>();
    const reasons: string[] = [];
    const reported: unknown[] = [];
    const logged: unknown[][] = [];
    installSignalHandlers(
      { shutdown: async reason => void reasons.push(reason) },
      {
        on: (event, handler) => void handlers.set(event, handler),
        report: async error => void reported.push(error),
        logError: (...args) => void logged.push(args),
      }
    );
    return { handlers, reasons, reported, logged };
  }

  test("SIGINT, SIGTERM und SIGHUP beenden mit dem Namen des Signals", async () => {
    const s = signalRig();
    expect([...s.handlers.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"]);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) await s.handlers.get(sig)!();
    expect(s.reasons).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  });

  test("uncaughtException: erst ins Log und melden, dann beenden", async () => {
    const s = signalRig();
    const error = new Error("ups");
    await s.handlers.get("uncaughtException")!(error);
    expect(s.logged).toEqual([["Uncaught exception:", error]]);
    expect(s.reported).toEqual([error]);
    expect(s.reasons).toEqual(["uncaughtException"]);
  });

  test("unhandledRejection: ins Log und melden, dann beenden mit Code 1 (Issue #526)", async () => {
    const handlers = new Map<string, (arg?: unknown) => unknown>();
    const calls: [string, number | undefined][] = [];
    const logged: unknown[][] = [];
    const reported: Error[] = [];
    installSignalHandlers(
      { shutdown: async (reason, code) => void calls.push([reason, code]) },
      {
        on: (event, handler) => void handlers.set(event, handler),
        report: async error => void reported.push(error),
        logError: (...args) => void logged.push(args),
      }
    );
    await handlers.get("unhandledRejection")!("kein Error-Objekt");
    expect(logged).toEqual([["Unhandled rejection:", "kein Error-Objekt"]]);
    expect(reported.map(e => e.message)).toEqual(["kein Error-Objekt"]);
    expect(calls).toEqual([["unhandledRejection", 1]]);
  });

  test("Entscheidung Issue #563: auch ein AbortError endet geordnet mit Code 1, wenn das Melden scheitert", async () => {
    // Die Ziel-Schleife fängt Abbrüche selbst (tests/goal-stop-abbruch.test.ts);
    // was trotzdem bis hier durchkommt, ist ein unbekannter Zustand: beenden, nicht weiterlaufen
    const handlers = new Map<string, (arg?: unknown) => unknown>();
    const calls: [string, number | undefined][] = [];
    const logged: unknown[][] = [];
    installSignalHandlers(
      { shutdown: async (reason, code) => void calls.push([reason, code]) },
      {
        on: (event, handler) => void handlers.set(event, handler),
        report: async () => {
          throw new Error("Datenbank weg");
        },
        logError: (...args) => void logged.push(args),
      }
    );
    const abort = new DOMException("Ausführung abgebrochen", "AbortError");
    await handlers.get("unhandledRejection")!(abort);
    expect(logged).toEqual([["Unhandled rejection:", abort]]);
    expect(calls).toEqual([["unhandledRejection", 1]]);
  });

  test("shutdown beendet mit dem übergebenen Code, sonst mit 0", async () => {
    for (const [code, expected] of [[undefined, 0], [1, 1]] as const) {
      const exits: number[] = [];
      const lifecycle = createLifecycle({
        lock: { touch: async () => {}, release: async () => {} },
        exit: c => void exits.push(c),
        sleep: async () => {},
        log: () => {},
      });
      await lifecycle.shutdown("Probe", code);
      expect(exits).toEqual([expected]);
    }
  });

  test("uncaughtException: scheitert die Meldung, wird trotzdem beendet", async () => {
    const handlers = new Map<string, (arg?: unknown) => unknown>();
    const reasons: string[] = [];
    installSignalHandlers(
      { shutdown: async reason => void reasons.push(reason) },
      { on: (event, handler) => void handlers.set(event, handler), report: () => Promise.reject(new Error("weg")), logError: () => {} }
    );
    await handlers.get("uncaughtException")!(new Error("ups"));
    expect(reasons).toEqual(["uncaughtException"]);
  });
});
