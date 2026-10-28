/**
 * Dienst-Namen ai.tybo.* / tybo-* (Issue #101) und nur diese (Issue #142):
 * Einrichten und Erkennen mit neuem Namen; Dienste unter dem früheren Namen
 * werden weder entladen noch entfernt noch als Bot erkannt. launchctl und PM2
 * sind zustandsbehaftete Attrappen; es läuft nie ein echter launchctl- oder
 * PM2-Aufruf. Geprüft über beide Einstiegspunkte: src/setup/services/launchd.ts
 * (setUpService) und `tybo setup autostart` (autostartStep).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setUpService, type LaunchdDeps } from "../src/setup/services/launchd";
import { runUninstallCommand, type UninstallDeps } from "../src/setup/services/uninstall";
import { launchdFindings, pm2Findings } from "../src/setup/checks/services";
import { readRestartRequest } from "../src/lib/restart-request";
import type { CommandResult, CommandRunner } from "../src/setup/context";
import { PROJECT_ROOT } from "../src/setup/context";
import { autostartStep } from "../src/setup/steps/autostart";
import * as serviceNames from "../src/lib/service-names";
import { findLaunchctlLine, isServicePlist, labelInLaunchctlList, launchdLabel, pm2Name } from "../src/lib/service-names";
import { SERVICE_CATALOG } from "../src/lib/services/catalog";
import { servicePlist } from "../src/lib/services/plist";
import { cronMarker, isOwnCronLine } from "../src/lib/services/systemd";
import { oldLaunchdLabel, oldPm2Name } from "./old-names";
import { cleanup, fakeRun, makeCtx } from "./setup-fixture";

afterAll(cleanup);

// Eingaben für den Plist-Generator (Issue #368)
const MACHINE = { bun: "/opt/bin/bun", claudeDir: "/opt/bin", home: "/home/test", projectRoot: "/projekt", exitTimeoutS: 330 };
const SCHEDULE = { morning_briefing: { hour: 9, minute: 0, enabled: true }, check_in_intervals: [{ hour: 10, minute: 30 }] };

const NEW = "ai.tybo.telegram-relay";
const OLD = oldLaunchdLabel("telegram-relay");

// ---------------------------------------------------------------------------
// launchctl-Attrappe: Dateien im Speicher, geladene Labels als Menge
// ---------------------------------------------------------------------------

/** Art eines fehlbaren Schritts, für die Fehlerinjektion */
type OpKind = "read" | "write" | "mkdir" | "list" | "load" | "unload";

interface FakeMac {
  deps: LaunchdDeps;
  files: Map<string, string>;
  loaded: Set<string>;
  calls: string[];
  failUnload: Set<string>;
  failLoad: Set<string>;
  dir: string;
  /** Jeder fehlbare Schritt in Reihenfolge; `fault` entscheidet, ob er scheitert */
  ops: OpKind[];
  fault: ((kind: OpKind, index: number) => boolean) | null;
}

function fakeMac(): FakeMac {
  const dir = "/home/test/Library/LaunchAgents";
  const files = new Map<string, string>();
  const loaded = new Set<string>();
  const calls: string[] = [];
  const failUnload = new Set<string>();
  const failLoad = new Set<string>();
  const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
  const mac = { ops: [] as OpKind[], fault: null as FakeMac["fault"] };
  /** true, wenn dieser Schritt laut Fehlerinjektion scheitern soll */
  const faulty = (kind: OpKind) => {
    mac.ops.push(kind);
    return mac.fault?.(kind, mac.ops.length - 1) ?? false;
  };
  const deps: LaunchdDeps = {
    projectRoot: "/projekt",
    launchAgentsDir: dir,
    home: "/home/test",
    async run(cmd) {
      if (cmd[0] === "which") return ok(`/opt/bin/${cmd[1]}`);
      if (cmd[0] !== "launchctl") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
      calls.push(cmd.join(" "));
      if (faulty(cmd[1] as OpKind)) return { ok: false, stdout: "", stderr: "injiziert" };
      if (cmd[1] === "list") return ok([...loaded].map(l => `123\t0\t${l}`).join("\n"));
      const label = basename(cmd[2], ".plist");
      if (cmd[1] === "unload") {
        if (failUnload.has(label)) return { ok: false, stdout: "", stderr: "Unload failed: 5" };
        loaded.delete(label);
        return ok();
      }
      if (cmd[1] === "load") {
        // Wie launchctl: ein schon geladenes Label erneut zu laden ist ein Fehler
        if (failLoad.has(label) || !files.has(cmd[2]) || loaded.has(label)) return { ok: false, stdout: "", stderr: "Load failed: 5" };
        loaded.add(label);
        return ok();
      }
      throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
    },
    exists: path => files.has(path) || path === dir,
    readFile: path => {
      if (faulty("read")) throw new Error("EIO");
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    writeFile: (path, content) => {
      if (faulty("write")) throw new Error("ENOSPC");
      files.set(path, content);
    },
    mkdir: () => {
      if (faulty("mkdir")) throw new Error("ENOSPC");
    },
    log: () => {},
  };
  return Object.assign(mac, { deps, files, loaded, calls, failUnload, failLoad, dir });
}

const count = (calls: string[], prefix: string) => calls.filter(c => c === prefix).length;

/** Dienst unter dem früheren Namen eingerichtet und geladen, wie auf einem Mac vor #101 */
function withOld(mac: FakeMac, loaded = true) {
  mac.files.set(`${mac.dir}/${OLD}.plist`, "<plist>alt</plist>");
  if (loaded) mac.loaded.add(OLD);
}

describe("setUpService (src/setup/services/launchd.ts)", () => {
  test("neuer Dienst wird einmal geladen, zweiter Lauf lädt nicht neu", async () => {
    const mac = fakeMac();
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    expect(count(mac.calls, `launchctl load ${mac.dir}/${NEW}.plist`)).toBe(1);
    expect(mac.calls.some(c => c.includes("unload"))).toBe(false);
    expect([...mac.loaded]).toEqual([NEW]);
    expect(mac.files.get(`${mac.dir}/${NEW}.plist`)).toContain(`<string>${NEW}</string>`);
  });

  test("ein geladener Dienst unter dem früheren Namen wird weder entladen noch entfernt (Issue #142)", async () => {
    const mac = fakeMac();
    withOld(mac);
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    expect(mac.calls.some(c => c.includes(OLD))).toBe(false);
    expect(mac.files.get(`${mac.dir}/${OLD}.plist`)).toBe("<plist>alt</plist>");
    expect([...mac.loaded].sort()).toEqual([NEW, OLD].sort());
    expect([...mac.files.keys()].some(p => p.includes("launchd-backup"))).toBe(false);
  });

  test("andere Dienste bleiben unberührt", async () => {
    const mac = fakeMac();
    mac.files.set(`${mac.dir}/ai.tybo.preis-watch.plist`, "<plist>watcher</plist>");
    mac.loaded.add("ai.tybo.preis-watch");
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    expect(mac.files.get(`${mac.dir}/ai.tybo.preis-watch.plist`)).toBe("<plist>watcher</plist>");
    expect(mac.loaded.has("ai.tybo.preis-watch")).toBe(true);
    expect(mac.calls.some(c => c.includes("preis-watch"))).toBe(false);
  });

  test("geänderte Plist (etwa neuer Bun-Pfad) wird neu geschrieben und geladen", async () => {
    const mac = fakeMac();
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    mac.files.set(`${mac.dir}/${NEW}.plist`, "<plist>veraltet</plist>");
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    expect(count(mac.calls, `launchctl unload ${mac.dir}/${NEW}.plist`)).toBe(1);
    expect(count(mac.calls, `launchctl load ${mac.dir}/${NEW}.plist`)).toBe(2);
    expect(mac.files.get(`${mac.dir}/${NEW}.plist`)).toContain(`<string>${NEW}</string>`);
  });

  test("Plist abweichend, Entladen scheitert: Abbruch, nichts überschrieben, nichts geladen", async () => {
    const mac = fakeMac();
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    mac.files.set(`${mac.dir}/${NEW}.plist`, "<plist>veraltet</plist>");
    mac.failUnload.add(NEW);
    mac.calls.length = 0;
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(false);
    expect(mac.files.get(`${mac.dir}/${NEW}.plist`)).toBe("<plist>veraltet</plist>");
    expect(mac.calls.some(c => c.startsWith("launchctl load"))).toBe(false);
    expect([...mac.loaded]).toEqual([NEW]);
  });

  test("Entladen scheitert und launchctl list unlesbar: ebenfalls Abbruch ohne Laden", async () => {
    const mac = fakeMac();
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    mac.files.set(`${mac.dir}/${NEW}.plist`, "<plist>veraltet</plist>");
    mac.failUnload.add(NEW);
    const run = mac.deps.run;
    mac.deps.run = async cmd => (cmd[1] === "list" ? { ok: false, stdout: "", stderr: "x" } : run(cmd));
    mac.calls.length = 0;
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(false);
    expect(mac.files.get(`${mac.dir}/${NEW}.plist`)).toBe("<plist>veraltet</plist>");
    expect(mac.calls.some(c => c.startsWith("launchctl load"))).toBe(false);
  });

  test("Plist unverändert, Zustand unbekannt (launchctl list scheitert): Abbruch, nichts geladen", async () => {
    const mac = fakeMac();
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    const run = mac.deps.run;
    mac.deps.run = async cmd => (cmd[1] === "list" ? { ok: false, stdout: "", stderr: "x" } : run(cmd));
    mac.calls.length = 0;
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(false);
    expect(mac.calls.filter(c => !c.endsWith(" list"))).toEqual([]);
    expect([...mac.loaded]).toEqual([NEW]);
  });

  test("Plist unverändert, aber nicht geladen: wird erneut geladen", async () => {
    const mac = fakeMac();
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    mac.loaded.clear();
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    expect(count(mac.calls, `launchctl load ${mac.dir}/${NEW}.plist`)).toBe(2);
    expect([...mac.loaded]).toEqual([NEW]);
  });

  test("Ladefehler: false, Wiederholung klappt", async () => {
    const mac = fakeMac();
    mac.failLoad.add(NEW);
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(false);
    expect([...mac.loaded]).toEqual([]);
    mac.failLoad.clear();
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    expect([...mac.loaded]).toEqual([NEW]);
  });

  test("jeder einzelne Schritt scheitert einmal: nie mehr als ein Bot, früherer Name nie angefasst, Wiederholung klappt", async () => {
    const setups: Array<[string, (mac: FakeMac) => Promise<void>]> = [
      ["frisch", async () => {}],
      [
        "Plist veraltet",
        async mac => {
          await setUpService("telegram-relay", mac.deps);
          mac.files.set(`${mac.dir}/${NEW}.plist`, "<plist>veraltet</plist>");
        },
      ],
    ];
    for (const [name, setup] of setups) {
      const probe = fakeMac();
      await setup(probe);
      probe.ops.length = 0;
      await setUpService("telegram-relay", probe.deps);
      const steps = probe.ops.length;
      expect(steps).toBeGreaterThan(0);
      for (let k = 0; k < steps; k++) {
        const mac = fakeMac();
        withOld(mac);
        await setup(mac);
        mac.calls.length = 0;
        mac.ops.length = 0;
        mac.fault = (_, i) => i === k;
        await setUpService("telegram-relay", mac.deps).catch(() => null);
        mac.fault = null;
        const where = `${name}, Schritt ${k}`;
        expect(mac.calls.some(c => c.includes(OLD)), where).toBe(false);
        expect(mac.files.get(`${mac.dir}/${OLD}.plist`), where).toBe("<plist>alt</plist>");
        expect([...mac.loaded].filter(l => l === NEW).length, where).toBeLessThanOrEqual(1);
        expect((await setUpService("telegram-relay", mac.deps)).ok, where).toBe(true);
        expect(mac.loaded.has(NEW), where).toBe(true);
        expect(mac.files.get(`${mac.dir}/${NEW}.plist`), where).toContain(`<string>${NEW}</string>`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// `tybo setup autostart` (macOS): echte Dateien im Temp-Ordner, launchctl-Attrappe
// ---------------------------------------------------------------------------

/** Zustandsbehaftete launchctl-Attrappe für den SetupContext */
function statefulLaunchctl(loaded: Set<string>, options: { failUnload?: Set<string>; failLoad?: Set<string>; failList?: boolean } = {}) {
  const calls: string[][] = [];
  const run = (async (cmd: string[]): Promise<CommandResult> => {
    calls.push(cmd);
    if (cmd[0] === "which") return { code: 0, stdout: `/opt/bin/${cmd[1]}`, stderr: "" };
    if (cmd[0] !== "launchctl") return { code: -1, stdout: "", stderr: "Befehl nicht gefunden" };
    if (cmd[1] === "list") {
      if (options.failList) return { code: 1, stdout: "", stderr: "x" };
      return { code: 0, stdout: [...loaded].map(l => `123\t0\t${l}`).join("\n"), stderr: "" };
    }
    const label = basename(cmd[2], ".plist");
    if (cmd[1] === "unload") {
      if (options.failUnload?.has(label)) return { code: 1, stdout: "", stderr: "x" };
      loaded.delete(label);
    }
    if (cmd[1] === "load") {
      if (options.failLoad?.has(label)) return { code: 1, stdout: "", stderr: "x" };
      loaded.add(label);
    }
    return { code: 0, stdout: "", stderr: "" };
  }) as CommandRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

async function macCtx(loaded: Set<string>, options: Parameters<typeof statefulLaunchctl>[1] = {}) {
  const run = statefulLaunchctl(loaded, options);
  const ctx = await makeCtx({ overrides: { run } });
  await mkdir(ctx.launchAgentsDir, { recursive: true });
  return { ctx, run };
}

const launchctlChanges = (run: { calls: string[][] }) =>
  run.calls.filter(c => c[0] === "launchctl" && c[1] !== "list").map(c => `${c[1]} ${basename(c[2])}`);

describe("tybo setup autostart (macOS)", () => {
  test("Einrichten lädt einmal, Wiederholung nicht", async () => {
    const loaded = new Set<string>();
    const { ctx, run } = await macCtx(loaded);
    expect((await autostartStep.status(ctx)).state).toBe("fehlt");
    const first = await autostartStep.apply!({}, ctx);
    expect(first).toEqual({
      ok: true,
      message: "Autostart eingerichtet: tybo läuft jetzt und startet mit dem Rechner.",
      changed: [join(ctx.launchAgentsDir, `${NEW}.plist`)],
    });
    expect((await autostartStep.status(ctx)).state).toBe("erledigt");
    expect((await autostartStep.apply!({}, ctx)).message).toBe("Autostart ist schon eingerichtet, nichts geändert.");
    expect(launchctlChanges(run)).toEqual([`load ${NEW}.plist`]);
  });

  test("Bot nur unter dem früheren Namen: Status fehlt (nicht teilweise), Einrichten fasst ihn nicht an (Issue #142)", async () => {
    const loaded = new Set([OLD]);
    const { ctx, run } = await macCtx(loaded);
    await writeFile(join(ctx.launchAgentsDir, `${OLD}.plist`), "<plist>alt</plist>");

    const status = await autostartStep.status(ctx);
    expect(status.state).toBe("fehlt");
    expect(status.detail).not.toContain(OLD);
    const check = await autostartStep.test!({}, ctx);
    expect(check.ok).toBe(true);
    expect(JSON.stringify(check)).not.toContain(OLD);

    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain(OLD);
    expect(r.changed).toEqual([join(ctx.launchAgentsDir, `${NEW}.plist`)]);
    expect((await readdir(ctx.launchAgentsDir)).sort()).toEqual([`${NEW}.plist`, `${OLD}.plist`].sort());
    expect(await readFile(join(ctx.launchAgentsDir, `${OLD}.plist`), "utf8")).toBe("<plist>alt</plist>");
    expect(launchctlChanges(run)).toEqual([`load ${NEW}.plist`]);
    expect(loaded.has(OLD)).toBe(true);
  });

  test("Plist liegt da, nicht geladen: teilweise, Einrichten lädt nur erneut", async () => {
    const loaded = new Set<string>();
    const { ctx, run } = await macCtx(loaded);
    expect((await autostartStep.apply!({}, ctx)).ok).toBe(true);
    loaded.clear();
    expect((await autostartStep.status(ctx)).state).toBe("teilweise");
    expect((await autostartStep.apply!({}, ctx)).ok).toBe(true);
    expect(launchctlChanges(run)).toEqual([`load ${NEW}.plist`, `load ${NEW}.plist`]);
  });

  test("Zustand unbekannt (launchctl list scheitert): nichts geändert", async () => {
    const loaded = new Set<string>();
    const { ctx } = await macCtx(loaded);
    expect((await autostartStep.apply!({}, ctx)).ok).toBe(true);
    const bad = await macCtx(loaded, { failList: true });
    await copyFile(join(ctx.launchAgentsDir, `${NEW}.plist`), join(bad.ctx.launchAgentsDir, `${NEW}.plist`));
    const r = await autostartStep.apply!({}, bad.ctx);
    expect(r.ok).toBe(false);
    expect(r.changed).toEqual([]);
    expect(launchctlChanges(bad.run)).toEqual([]);
  });

  test("Ladefehler: feste Meldung ohne Rohausgabe", async () => {
    const loaded = new Set<string>();
    const { ctx } = await macCtx(loaded, { failLoad: new Set([NEW]) });
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(
      "Autostart ließ sich nicht einrichten: launchctl konnte den Dienst nicht laden. Die Dienstdatei liegt da; ein erneuter Versuch lädt sie noch einmal."
    );
    expect([...loaded]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PM2
// ---------------------------------------------------------------------------

// configurePM2Service selbst: tests/services-pm2.test.ts (Issue #370)
const TYBO = "tybo-telegram-relay";
const GO = oldPm2Name("telegram-relay");


describe("tybo setup autostart (Linux, PM2)", () => {
  /** PM2-Attrappe für den SetupContext; save schreibt dump.pm2 wie das echte PM2 */
  function pm2Run(procs: Set<string>, dumpPath: () => string, options: { failSave?: boolean; failDelete?: Set<string> } = {}) {
    const calls: string[] = [];
    const run = (async (cmd: string[]): Promise<CommandResult> => {
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      if (cmd[0] !== "pm2") return { code: -1, stdout: "", stderr: "Befehl nicht gefunden" };
      const name = cmd[1] === "start" ? cmd[cmd.indexOf("--name") + 1] : cmd[2];
      calls.push([cmd[1], name].filter(Boolean).join(" "));
      if (cmd[1] === "--version") return ok("6.0.0");
      if (cmd[1] === "jlist") return ok(JSON.stringify([...procs].map(n => ({ name: n }))));
      if (cmd[1] === "delete") {
        if (options.failDelete?.has(name) || !procs.has(name)) return { code: 1, stdout: "", stderr: "not found" };
        procs.delete(name);
        return ok();
      }
      if (cmd[1] === "start") {
        procs.add(name);
        return ok();
      }
      if (cmd[1] === "save") {
        if (options.failSave) return { code: 1, stdout: "", stderr: "x" };
        await mkdir(dirname(dumpPath()), { recursive: true });
        await writeFile(dumpPath(), JSON.stringify([...procs].map(n => ({ name: n }))));
        return ok();
      }
      return { code: -1, stdout: "", stderr: "?" };
    }) as CommandRunner;
    return { run, calls };
  }

  async function linuxCtx(procs: Set<string>, options: Parameters<typeof pm2Run>[2] = {}) {
    let dump = "";
    const fake = pm2Run(procs, () => dump, options);
    const ctx = await makeCtx({ overrides: { platform: "linux", run: fake.run } });
    dump = ctx.pm2DumpPath;
    return { ctx, calls: fake.calls };
  }

  test("Einrichten mit pm2 save, zweiter Lauf ändert nichts", async () => {
    const procs = new Set<string>();
    const { ctx, calls } = await linuxCtx(procs);
    expect((await autostartStep.status(ctx)).state).toBe("fehlt");
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual([`pm2:${TYBO}`]);
    expect(JSON.parse(await readFile(ctx.pm2DumpPath, "utf8"))).toEqual([{ name: TYBO }]);
    expect((await autostartStep.status(ctx)).state).toBe("erledigt");
    expect((await autostartStep.apply!({}, ctx)).message).toBe("Autostart ist schon eingerichtet, nichts geändert.");
    expect(count(calls, `start ${TYBO}`)).toBe(1);
  });

  test("Bot nur unter dem früheren Namen: Status fehlt, Einrichten lässt ihn stehen (Issue #142)", async () => {
    const procs = new Set([GO]);
    const { ctx, calls } = await linuxCtx(procs);
    const s = await autostartStep.status(ctx);
    expect(s.state).toBe("fehlt");
    expect(s.detail).not.toContain(GO);
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain(GO);
    expect(calls.some(c => c.includes(GO))).toBe(false);
    expect([...procs].sort()).toEqual([GO, TYBO].sort());
  });

  test("pm2 save scheitert: ehrlich; Wiederholung speichert nur, ohne Neustart", async () => {
    const procs = new Set<string>();
    const options = { failSave: true };
    const { ctx, calls } = await linuxCtx(procs, options);
    const first = await autostartStep.apply!({}, ctx);
    expect(first.ok).toBe(false);
    expect(first.message).toContain("„pm2 save“ ist gescheitert");
    expect([...procs]).toEqual([TYBO]);
    expect((await autostartStep.status(ctx)).state).toBe("teilweise");
    options.failSave = false;
    calls.length = 0;
    const second = await autostartStep.apply!({}, ctx);
    expect(second.ok).toBe(true);
    expect(calls).toEqual(["--version", "jlist", "save"]);
    expect((await autostartStep.status(ctx)).state).toBe("erledigt");
  });

  test("läuft, aber nicht gespeichert: Einrichten speichert nur, ohne Neustart", async () => {
    const procs = new Set([TYBO]);
    const { ctx, calls } = await linuxCtx(procs, { failDelete: new Set([TYBO]) });
    expect((await autostartStep.status(ctx)).state).toBe("teilweise");
    calls.length = 0;
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["--version", "jlist", "save"]);
    expect([...procs]).toEqual([TYBO]);
  });
});

// ---------------------------------------------------------------------------
// tybo pruefen: Dienste (src/setup/checks/services.ts, Issue #372)
// ---------------------------------------------------------------------------

type Line = { label: string; status: string; detail: string };

describe("pruefen: launchd-Dienste", () => {
  async function verifyLaunchd(stdout: string, ok = true): Promise<Line[]> {
    const run = fakeRun({ "launchctl list": { code: ok ? 0 : 1, stdout } });
    const ctx = await makeCtx({ overrides: { run } });
    const lines = await launchdFindings(ctx, ["telegram-relay"]);
    expect(run.calls).toEqual([["launchctl", "list"]]);
    return lines;
  }

  test("ai.tybo.telegram-relay läuft", async () => {
    expect(await verifyLaunchd(`PID\tStatus\tLabel\n42\t0\t${NEW}`)).toEqual([{ label: "telegram-relay", status: "pass", detail: "Läuft (PID: 42)" }]);
  });

  test("ein nur unter dem früheren Namen laufender Bot gilt als nicht eingerichtet (Issue #142)", async () => {
    expect(await verifyLaunchd(`PID\tStatus\tLabel\n42\t0\t${OLD}`)).toEqual([{ label: "telegram-relay", status: "skip", detail: "Nicht eingerichtet" }]);
  });

  test("ähnliches Label zählt nicht (exakter Vergleich)", async () => {
    expect((await verifyLaunchd(`42\t0\t${NEW}-alt`))[0].detail).toBe("Nicht eingerichtet");
  });

  test("geladen mit Exit 0 wartet auf den Zeitplan; Exit-Code ungleich 0: Warnung", async () => {
    expect((await verifyLaunchd(`-\t0\t${NEW}`))[0]).toEqual({ label: "telegram-relay", status: "pass", detail: "Geladen, letzter Exit 0 (wartet auf den Zeitplan)" });
    expect((await verifyLaunchd(`-\t1\t${NEW}`))[0]).toEqual({ label: "telegram-relay", status: "warn", detail: "Geladen, letzter Exit-Code 1" });
  });

  test("launchctl list scheitert: Fehler", async () => {
    expect(await verifyLaunchd("", false)).toEqual([{ label: "launchctl", status: "fail", detail: "launchctl list ließ sich nicht abfragen" }]);
  });
});

describe("pruefen: PM2-Dienste", () => {
  async function verifyPm2(list: Array<{ name: string; pid?: number; pm2_env?: { status?: string } }>): Promise<Line[]> {
    const run = fakeRun({ "pm2 jlist": { stdout: JSON.stringify(list) } });
    const ctx = await makeCtx({ overrides: { platform: "linux", run } });
    const lines = await pm2Findings(ctx, ["telegram-relay"]);
    // Nur das installierte PM2, nie npx (das würde es nachinstallieren)
    expect(run.calls).toEqual([["pm2", "jlist"]]);
    return lines;
  }
  const online = { pm2_env: { status: "online" } };

  test("tybo-telegram-relay: läuft", async () => {
    const [r] = await verifyPm2([{ name: TYBO, pid: 7, ...online }]);
    expect(r).toEqual({ label: "telegram-relay", status: "pass", detail: "Läuft über PM2 (PID: 7)" });
  });

  test("nur unter dem früheren Namen: nicht registriert (Issue #142)", async () => {
    const [r] = await verifyPm2([{ name: GO, pid: 8, ...online }]);
    expect(r).toEqual({ label: "telegram-relay", status: "skip", detail: "Nicht in PM2 eingetragen" });
  });

  test("beide Namen: nur tybo-* zählt, keine Warnung", async () => {
    const [r] = await verifyPm2([{ name: GO, pid: 8, ...online }, { name: TYBO, pid: 7, ...online }]);
    expect(r).toEqual({ label: "telegram-relay", status: "pass", detail: "Läuft über PM2 (PID: 7)" });
  });

  test("ähnlicher Name: nicht registriert", async () => {
    const [r] = await verifyPm2([{ name: "tybo-telegram-relay-alt", pid: 9, ...online }]);
    expect(r).toEqual({ label: "telegram-relay", status: "skip", detail: "Nicht in PM2 eingetragen" });
  });

  test("gestoppt: Warnung mit Status; unlesbare Liste: Warnung", async () => {
    const [r] = await verifyPm2([{ name: TYBO, pid: 0, pm2_env: { status: "stopped" } }]);
    expect(r).toEqual({ label: "telegram-relay", status: "warn", detail: "PM2-Status: stopped" });
    const ctx = await makeCtx({ overrides: { platform: "linux", run: fakeRun({ "pm2 jlist": { stdout: "kein json" } }) } });
    expect(await pm2Findings(ctx, ["telegram-relay"])).toEqual([{ label: "PM2", status: "warn", detail: "Ausgabe von PM2 nicht lesbar" }]);
  });
});

// ---------------------------------------------------------------------------
// Wirksamer Neustart nach einem Update (setup/upgrade.ts entfällt mit Issue #374)
// ---------------------------------------------------------------------------

describe("Neustart nach dem Update", () => {
  test("setup:launchd startet einen geladenen Dienst mit unveränderter Plist nicht neu", async () => {
    const mac = fakeMac();
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    mac.calls.length = 0;
    expect((await setUpService("telegram-relay", mac.deps)).ok).toBe(true);
    expect(mac.calls.filter(c => !c.endsWith(" list"))).toEqual([]);
  });

  test("bun run restart:request legt den Marker an, den der Bot liest", async () => {
    const root = await mkdtemp(join(tmpdir(), "tybo-upgrade-"));
    try {
      const proc = Bun.spawn(["bun", join(PROJECT_ROOT, "scripts", "request-restart.ts"), "Update"], {
        cwd: root,
        env: { ...process.env, GO_PROJECT_ROOT: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
      expect(await readRestartRequest(join(root, "data", "restart-requested"))).toBe("Update");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Hilfsfunktionen für pruefen und tybo deinstallieren
// ---------------------------------------------------------------------------

describe("Namen und Erkennung", () => {
  test("Namen; keine Funktionen oder Präfixe für frühere Namen mehr", () => {
    expect(launchdLabel("watchdog")).toBe("ai.tybo.watchdog");
    expect(pm2Name("watchdog")).toBe("tybo-watchdog");
    expect(Object.keys(serviceNames).sort()).toEqual(
      ["BOT_SERVICE", "SUPABASE_SERVICE", "SUPABASE_START_STATE", "LAUNCHD_PREFIX", "PM2_PREFIX", "findLaunchctlLine", "isServicePlist", "labelInLaunchctlList", "launchdLabel", "pm2Name", "systemdUnit", "systemdUnitFile"].sort()
    );
    expect(serviceNames.systemdUnitFile("telegram-relay")).toBe("tybo-telegram-relay.service");
  });

  test("pruefen erkennt nur ai.tybo.*, exakt", () => {
    const both = `PID\tStatus\tLabel\n1\t0\t${OLD}\n2\t0\t${NEW}`;
    expect(findLaunchctlLine(both, "telegram-relay")).toBe(`2\t0\t${NEW}`);
    expect(findLaunchctlLine(`1\t0\t${OLD}`, "telegram-relay")).toBeNull();
    expect(findLaunchctlLine(`1\t0\t${NEW}-alt`, "telegram-relay")).toBeNull();
    expect(labelInLaunchctlList(`1\t0\t${NEW}-alt`, NEW)).toBe(false);
  });

  test("tybo deinstallieren erfasst nur ai.tybo.* und tybo-*", async () => {
    expect(["ai.tybo.watchdog.plist", `${oldLaunchdLabel("watchdog")}.plist`, "com.apple.x.plist", "ai.tybo.x.txt"].filter(isServicePlist)).toEqual([
      "ai.tybo.watchdog.plist",
    ]);
    // PM2 unter Linux: tybo-* geht, der frühere Name bleibt (Issue #142)
    const calls: string[] = [];
    let names = ["tybo-telegram-relay", "tybo-watchdog", oldPm2Name("telegram-relay")];
    await runUninstallCommand([], uninstallDeps("linux", async cmd => {
      calls.push(cmd.join(" "));
      if (cmd[1] === "jlist") return { ok: true, stdout: JSON.stringify(names.map(name => ({ name }))), stderr: "" };
      if (cmd[1] === "delete") names = names.filter(n => n !== cmd[2]);
      return { ok: true, stdout: cmd[0] === "crontab" ? "" : "6.0.0", stderr: "" };
    }));
    expect(names).toEqual([oldPm2Name("telegram-relay")]);
    expect(calls.filter(c => c.startsWith("pm2 delete"))).toEqual(["pm2 delete tybo-telegram-relay", "pm2 delete tybo-watchdog"]);
  });

  test("Einrichtung unter Linux (Issue #370): frühere cron-Markierungen # go-<dienst> werden erkannt und abgelöst", () => {
    // Statt den Quelltext der alten Einrichtung zu lesen: Verhalten des neuen Moduls
    const line = `30 10 * * * cd /projekt && bun run /projekt/src/routines/checkin.ts >> /projekt/logs/smart-checkin.log 2>&1 # go-smart-checkin`;
    expect(isOwnCronLine(line, "smart-checkin")).toBe(true);
    expect(isOwnCronLine(line, "morning-briefing")).toBe(false);
    expect(cronMarker("smart-checkin")).toBe("# tybo-smart-checkin");
    // Windows-Aufgabenplanung entfernt (E12): die alte Einrichtung gibt es nicht mehr
    expect(existsSync(join(PROJECT_ROOT, "setup", "configure-services.ts"))).toBe(false);
  });

  test("Deinstallation unter Windows: nur tybo-*-PM2-Prozesse, keine Aufgabe wird gelöscht, nie npx", async () => {
    const calls: string[][] = [];
    const code = await runUninstallCommand([], uninstallDeps("win32", async cmd => {
      calls.push(cmd);
      if (cmd[1] === "jlist") return { ok: true, stdout: JSON.stringify([{ name: "tybo-telegram-relay" }, { name: "tybo-supabase" }]), stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    }));
    expect(code).toBe(0);
    expect(calls).toEqual([
      ["pm2", "--version"],
      ["pm2", "jlist"],
      ["pm2", "delete", "tybo-supabase"],
      ["pm2", "delete", "tybo-telegram-relay"],
    ]);
    expect(calls.some(cmd => cmd[0] === "schtasks" || cmd[0] === "npx")).toBe(false);
    expect(calls.flat().some(arg => arg.startsWith("Go-"))).toBe(false);
  });

  test("erzeugte Plists tragen das neue Label, nie das alte; keine Vorlagen mehr (Issue #368)", async () => {
    expect(existsSync(join(PROJECT_ROOT, "launchd"))).toBe(false);
    for (const def of SERVICE_CATALOG.filter(d => d.kind !== "external")) {
      const text = servicePlist(def, MACHINE, SCHEDULE);
      expect(text).toContain(`<string>${launchdLabel(def.name)}</string>`);
      expect(text).not.toContain(oldLaunchdLabel(""));
    }
  });

  test("Prüfmodule und Deinstallation sind importsicher; setup/verify.ts, setup/uninstall.ts und setup/upgrade.ts gibt es nicht mehr (Issues #372, #373, #374)", async () => {
    const exit = process.exit;
    let exited = false;
    process.exit = (() => {
      exited = true;
    }) as never;
    try {
      await import("../src/setup/checks/services");
      await import("../src/setup/checks/speech");
      await import("../src/setup/checks/specials");
      await import("../src/setup/services/uninstall");
    } finally {
      process.exit = exit;
    }
    expect(exited).toBe(false);
    expect(existsSync(join(PROJECT_ROOT, "setup", "verify.ts"))).toBe(false);
    expect(existsSync(join(PROJECT_ROOT, "setup", "uninstall.ts"))).toBe(false);
    expect(existsSync(join(PROJECT_ROOT, "setup", "upgrade.ts"))).toBe(false);
  });
});

/** Deinstallation mit Attrappen: nichts auf der Platte, Befehle über run, keine Rückfrage */
function uninstallDeps(platform: NodeJS.Platform, run: UninstallDeps["run"]): UninstallDeps {
  return {
    root: "/projekt",
    platform,
    launchAgentsDir: "/home/test/Library/LaunchAgents",
    unitDir: "/home/test/.config/systemd/user",
    runDir: "/run/systemd/system",
    pm2: ["pm2"],
    pm2Dump: "/home/test/.pm2/dump.pm2",
    run,
    exists: () => false,
    listDir: () => [],
    readText: () => null,
    remove: () => {},
    writeText: () => {},
    removeTree: async () => {},
    ask: async () => false,
    out: () => {},
    err: () => {},
  };
}

test("erzeugte Plists: PATH enthält Homebrew auf Apple Silicon (/opt/homebrew/bin)", () => {
  // Sonst fehlen Bot-Subprozessen gh, ffmpeg, python3 usw.
  for (const def of SERVICE_CATALOG.filter(d => d.kind !== "external")) {
    const path = servicePlist(def, MACHINE, SCHEDULE).match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)?.[1];
    expect(path?.split(":")).toContain("/opt/homebrew/bin");
  }
});
