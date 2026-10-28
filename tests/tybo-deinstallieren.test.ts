/**
 * Issue #373: tybo deinstallieren (src/setup/services/uninstall.ts) und der
 * Alias bun run uninstall. launchctl, systemctl, crontab und PM2 sind
 * Attrappen, Dateien liegen im Speicher; kein Test ruft einen echten
 * Dienstbefehl. Nur `help` läuft als echter Kindprozess (aus fremdem
 * Arbeitsverzeichnis), weil es nichts anfasst.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runTybo } from "../scripts/tybo";
import { LOCAL_SUPABASE_URL } from "../src/setup/local-supabase";
import { SUPABASE_UNLOAD_TIMEOUT_MS } from "../src/setup/services/launchd";
import { SUPABASE_DELETE_TIMEOUT_MS } from "../src/setup/services/pm2";
import { askInTerminal, KEPT_NOTE, LINGER_KEPT, realUninstallDeps, SUPABASE_KEPT, type UninstallDeps } from "../src/setup/services/uninstall";

const REPO = join(import.meta.dir, "..");
const ROOT = "/home/alex/tybo";
const AGENTS = "/home/alex/Library/LaunchAgents";
const UNITS = "/home/alex/.config/systemd/user";
const RUN_DIR = "/run/systemd/system";
const PM2_DUMP = "/home/alex/.pm2/dump.pm2";

type Reply = { ok: boolean; stdout?: string; stderr?: string; missing?: boolean };
type Call = { line: string; timeoutMs?: number; stdin?: string };

/**
 * Zustandsbehaftete Attrappe: Dateien als Map, geladene launchd-Labels,
 * systemd-Zustände je Einheit, crontab und PM2-Liste (dump.pm2 ist eine
 * Datei, pm2 save gibt es nicht). fail: Befehlsanfänge, die scheitern
 * (änderbar über setFail); failRemove bzw. failWrite: Pfade, deren Löschen
 * bzw. Schreiben scheitert (failWrite änderbar über setFailWrite); after: nach einem
 * gelungenen Befehl ändern sich systemd-Zustände bzw. scheitern weitere
 * Befehle (etwa ein Timer, der zwischendurch seinen Dienst startet).
 */
function machine(
  platform: NodeJS.Platform,
  init: {
    files?: Record<string, string>;
    loaded?: string[];
    units?: Record<string, string>;
    crontab?: string | null;
    pm2?: string[] | null;
    fail?: string[];
    failRemove?: string[];
    failWrite?: string[];
    answer?: boolean;
    after?: Record<string, { units?: Record<string, string>; fail?: string[] }>;
  } = {},
) {
  const files = new Map(Object.entries(init.files ?? {}));
  const loaded = new Set(init.loaded ?? []);
  const units = new Map(Object.entries(init.units ?? {}));
  let crontab = init.crontab === undefined ? "" : init.crontab;
  let pm2 = init.pm2 === undefined ? null : init.pm2;
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const removedTrees: string[] = [];
  let fail = [...(init.fail ?? [])];
  let failWrite = [...(init.failWrite ?? [])];
  const written: string[] = [];
  const fails = (line: string) => fail.some(f => line === f || line.startsWith(`${f} `));

  async function run(cmd: string[], options?: { timeoutMs?: number; stdin?: string }): Promise<Reply> {
    const line = cmd.join(" ");
    calls.push({ line, timeoutMs: options?.timeoutMs, stdin: options?.stdin });
    if (fails(line)) return { ok: false, stderr: "Fehler" };
    const reply = answer(cmd, options);
    const then = init.after?.[line];
    if (reply.ok && then) {
      for (const [name, state] of Object.entries(then.units ?? {})) units.set(name, state);
      fail.push(...(then.fail ?? []));
    }
    return reply;
  }

  function answer(cmd: string[], options?: { timeoutMs?: number; stdin?: string }): Reply {
    const line = cmd.join(" ");
    const [prog, ...args] = cmd;
    if (prog === "launchctl") {
      if (args[0] === "list") return { ok: true, stdout: ["PID\tStatus\tLabel", ...[...loaded].map(l => `1\t0\t${l}`)].join("\n") };
      const label = args[1].split("/").pop()!.replace(/\.plist$/, "");
      if (args[0] === "unload") {
        if (!loaded.delete(label)) return { ok: false, stderr: "Could not find specified service" };
        return { ok: true };
      }
    }
    if (prog === "systemctl") {
      if (args[1] === "show") {
        const state = units.get(args[2]) ?? "LoadState=not-found\nActiveState=inactive\nUnitFileState=";
        return { ok: true, stdout: state };
      }
      if (args[1] === "disable" || args[1] === "stop") {
        units.set(args.at(-1)!, "LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled");
        return { ok: true };
      }
      if (args[1] === "daemon-reload") return { ok: true };
    }
    if (prog === "crontab") {
      if (args[0] === "-l") return crontab === null ? { ok: false, stderr: "no crontab for alex" } : { ok: true, stdout: crontab };
      if (args[0] === "-") {
        crontab = (options?.stdin ?? "").replace(/\n$/, "");
        return { ok: true };
      }
    }
    if (prog === "pm2") {
      // Wie runWithTimeout: ein Programm, das sich nicht starten lässt, trägt missing
      if (pm2 === null) return { ok: false, stderr: "Befehl nicht gefunden", missing: true };
      if (args[0] === "--version") return { ok: true, stdout: "6.0.0" };
      if (args[0] === "jlist") return { ok: true, stdout: JSON.stringify(pm2.map(name => ({ name }))) };
      if (args[0] === "delete") {
        pm2 = pm2.filter(n => n !== args[1]);
        return { ok: true };
      }
    }
    throw new Error(`unerwarteter Befehl: ${line}`);
  }

  const deps: UninstallDeps = {
    root: ROOT,
    platform,
    launchAgentsDir: AGENTS,
    unitDir: UNITS,
    runDir: RUN_DIR,
    pm2: ["pm2"],
    pm2Dump: PM2_DUMP,
    run,
    exists: p => files.has(p) || [...files.keys()].some(f => f.startsWith(`${p}/`)),
    listDir: dir => [...files.keys()].filter(f => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes("/")).map(f => f.slice(dir.length + 1)),
    readText: p => files.get(p) ?? null,
    remove: p => {
      if ((init.failRemove ?? []).includes(p)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      files.delete(p);
    },
    writeText: (p, content) => {
      if (failWrite.includes(p)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      written.push(p);
      files.set(p, content);
    },
    removeTree: async p => {
      removedTrees.push(p);
      for (const f of [...files.keys()]) if (f.startsWith(`${p}/`)) files.delete(f);
    },
    ask: async q => (asked.push(q), init.answer ?? false),
    out: line => void out.push(line),
    err: line => void err.push(line),
  };
  return {
    deps,
    files,
    loaded,
    calls,
    lines: () => calls.map(c => c.line),
    out: () => out.join("\n"),
    err: () => err.join("\n"),
    asked,
    removedTrees,
    crontab: () => crontab,
    pm2: () => pm2,
    setFail: (list: string[]) => void (fail = [...list]),
    setFailWrite: (list: string[]) => void (failWrite = [...list]),
    written,
  };
}

async function uninstall(m: ReturnType<typeof machine>, args: string[] = []) {
  return runTybo({ args: ["deinstallieren", ...args], env: {}, root: ROOT, platform: m.deps.platform, out: m.deps.out, err: m.deps.err, uninstall: m.deps });
}

const plist = (label: string) => `${AGENTS}/${label}.plist`;
const unit = (name: string) => `${UNITS}/${name}`;
const ENABLED_ACTIVE = "LoadState=loaded\nActiveState=active\nUnitFileState=enabled";
const ENABLED_IDLE = "LoadState=loaded\nActiveState=inactive\nUnitFileState=enabled";
const STATIC_IDLE = "LoadState=loaded\nActiveState=inactive\nUnitFileState=static";

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

describe("macOS (launchd)", () => {
  test("entfernt jede ai.tybo.*-Plist, auch außerhalb des Katalogs; fremde und übergebene Dienste bleiben", async () => {
    const own = ["ai.tybo.telegram-relay", "ai.tybo.smart-checkin", "ai.tybo.watchdog", "ai.tybo.wetter-report", "ai.tybo.cloudflare-tunnel"];
    const m = machine("darwin", {
      files: {
        ...Object.fromEntries([...own, "ai.tybo.eigener-watcher", "com.example.backup"].map(l => [plist(l), "<plist/>"])),
        [`${ROOT}/config/routines.json`]: JSON.stringify({ labels: ["ai.tybo.eigener-watcher"] }),
        [`${ROOT}/.env`]: "TELEGRAM_BOT_TOKEN=x\n",
      },
      loaded: ["ai.tybo.telegram-relay", "ai.tybo.smart-checkin", "ai.tybo.eigener-watcher", "com.example.backup"],
    });
    expect(await uninstall(m)).toBe(0);
    expect([...m.files.keys()].filter(f => f.startsWith(AGENTS)).sort()).toEqual([plist("ai.tybo.eigener-watcher"), plist("com.example.backup")]);
    expect([...m.loaded].sort()).toEqual(["ai.tybo.eigener-watcher", "com.example.backup"]);
    expect(m.lines().filter(l => l.includes("eigener-watcher") || l.includes("com.example"))).toEqual([]);
    expect(m.out()).toContain("ai.tybo.eigener-watcher bleibt");
    // Kein PM2, kein systemd unter macOS
    expect(m.lines().every(l => l.startsWith("launchctl"))).toBe(true);
    // .env und Konfiguration bleiben
    expect(m.files.has(`${ROOT}/.env`)).toBe(true);
    expect(m.out()).toContain(KEPT_NOTE);
  });

  test("Supabase: längere Frist beim Entladen, Hinweis auf tybo datenbank stop, nie docker", async () => {
    const m = machine("darwin", { files: { [plist("ai.tybo.supabase")]: "<plist/>" }, loaded: ["ai.tybo.supabase"] });
    expect(await uninstall(m)).toBe(0);
    expect(m.calls.find(c => c.line.startsWith("launchctl unload"))?.timeoutMs).toBe(SUPABASE_UNLOAD_TIMEOUT_MS);
    expect(m.out()).toContain(SUPABASE_KEPT);
    expect(SUPABASE_KEPT).toContain("tybo datenbank stop");
    expect(m.lines().some(l => /docker|supabase stop/.test(l))).toBe(false);
  });

  test("lokale Datenbank laut .env ohne Dienst: Hinweis trotzdem", async () => {
    const m = machine("darwin", { files: { [`${ROOT}/.env`]: `SUPABASE_URL=${LOCAL_SUPABASE_URL}\n` } });
    expect(await uninstall(m)).toBe(0);
    expect(m.out()).toContain(SUPABASE_KEPT);
  });

  test("nicht geladene Plist: Entladen scheitert, Liste sagt nicht geladen, Datei wird gelöscht", async () => {
    const m = machine("darwin", { files: { [plist("ai.tybo.health-check")]: "<plist/>" } });
    expect(await uninstall(m)).toBe(0);
    expect(m.files.has(plist("ai.tybo.health-check"))).toBe(false);
    expect(m.lines()).toEqual([`launchctl unload ${plist("ai.tybo.health-check")}`, "launchctl list"]);
  });

  test("Entladen scheitert und der Dienst ist noch geladen: Datei bleibt, Exit 1, die übrigen werden entfernt", async () => {
    const m = machine("darwin", {
      files: { [plist("ai.tybo.telegram-relay")]: "<plist/>", [plist("ai.tybo.smart-checkin")]: "<plist/>" },
      loaded: ["ai.tybo.telegram-relay", "ai.tybo.smart-checkin"],
      fail: [`launchctl unload ${plist("ai.tybo.telegram-relay")}`],
    });
    expect(await uninstall(m)).toBe(1);
    expect(m.files.has(plist("ai.tybo.telegram-relay"))).toBe(true);
    expect(m.files.has(plist("ai.tybo.smart-checkin"))).toBe(false);
    expect(m.err()).toContain("ai.tybo.telegram-relay ließ sich nicht entladen");
  });

  test("Entladen scheitert und launchctl list ist nicht lesbar: Datei bleibt, Exit 1", async () => {
    const m = machine("darwin", { files: { [plist("ai.tybo.telegram-relay")]: "<plist/>" }, loaded: ["ai.tybo.telegram-relay"], fail: ["launchctl"] });
    expect(await uninstall(m)).toBe(1);
    expect(m.files.has(plist("ai.tybo.telegram-relay"))).toBe(true);
  });

  test("Löschen scheitert: Exit 1 mit Pfad", async () => {
    const m = machine("darwin", { files: { [plist("ai.tybo.telegram-relay")]: "<plist/>" }, loaded: ["ai.tybo.telegram-relay"], failRemove: [plist("ai.tybo.telegram-relay")] });
    expect(await uninstall(m)).toBe(1);
    expect(m.err()).toContain("ließ sich nicht löschen");
  });

  test("wiederholte Deinstallation: der zweite Lauf findet nichts, ruft nichts auf, Exit 0", async () => {
    const m = machine("darwin", { files: { [plist("ai.tybo.telegram-relay")]: "<plist/>" }, loaded: ["ai.tybo.telegram-relay"] });
    expect(await uninstall(m)).toBe(0);
    const before = m.calls.length;
    expect(await uninstall(m)).toBe(0);
    expect(m.calls.length).toBe(before);
    expect(m.out()).toContain("es war nichts eingerichtet");
  });

  test("kein LaunchAgents-Ordner: Exit 0", async () => {
    const m = machine("darwin");
    expect(await uninstall(m)).toBe(0);
    expect(m.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Linux: systemd und cron
// ---------------------------------------------------------------------------

describe("Linux (systemd, cron)", () => {
  const systemdFiles = {
    [RUN_DIR]: "",
    [unit("tybo-telegram-relay.service")]: "[Service]\n",
    [unit("tybo-smart-checkin.timer")]: "[Timer]\n",
    [unit("tybo-smart-checkin.service")]: "[Service]\n",
    [unit("tybo-morning-briefing.timer")]: "[Timer]\n",
    [unit("tybo-morning-briefing.service")]: "[Service]\n",
    [unit("anderer.service")]: "[Service]\n",
  };
  const systemdUnits = {
    "tybo-telegram-relay.service": ENABLED_ACTIVE,
    "tybo-smart-checkin.timer": ENABLED_ACTIVE,
    "tybo-smart-checkin.service": STATIC_IDLE,
    "tybo-morning-briefing.timer": ENABLED_ACTIVE,
    // Läuft gerade: Timer stoppen beendet den Dienst nicht
    "tybo-morning-briefing.service": "LoadState=loaded\nActiveState=activating\nUnitFileState=static",
  };

  test("Bot und Timer: stoppen, Dateien löschen, einmal daemon-reload; Linger bleibt, nie sudo", async () => {
    const m = machine("linux", { files: systemdFiles, units: systemdUnits });
    expect(await uninstall(m)).toBe(0);
    const changes = m.lines().filter(l => l.startsWith("systemctl") && !l.includes(" show "));
    expect(changes).toEqual([
      "systemctl --user disable --now tybo-telegram-relay.service",
      "systemctl --user disable --now tybo-smart-checkin.timer",
      "systemctl --user disable --now tybo-morning-briefing.timer",
      "systemctl --user stop tybo-morning-briefing.service",
      "systemctl --user daemon-reload",
    ]);
    expect([...m.files.keys()].filter(f => f.startsWith(UNITS))).toEqual([unit("anderer.service")]);
    expect(m.lines().some(l => /sudo|linger/.test(l))).toBe(false);
    expect(m.out()).toContain(LINGER_KEPT);
  });

  test("Dienst ohne Datei, aber noch geladen und aktiv: wird gestoppt", async () => {
    const m = machine("linux", { files: { [RUN_DIR]: "" }, units: { "tybo-telegram-relay.service": "LoadState=loaded\nActiveState=active\nUnitFileState=" } });
    expect(await uninstall(m)).toBe(0);
    expect(m.lines()).toContain("systemctl --user stop tybo-telegram-relay.service");
    expect(m.lines()).toContain("systemctl --user daemon-reload");
  });

  test("nichts eingerichtet: nur Abfragen, keine Änderung, Exit 0", async () => {
    const m = machine("linux", { files: { [RUN_DIR]: "" } });
    expect(await uninstall(m)).toBe(0);
    expect(m.lines().filter(l => l.startsWith("systemctl") && !l.includes(" show "))).toEqual([]);
    expect(m.lines()).not.toContain("crontab -");
    expect(m.out()).toContain("PM2 ist nicht installiert");
  });

  test("systemctl --user antwortet nicht: an systemd nichts geändert, Dateien bleiben, Exit 1", async () => {
    const m = machine("linux", { files: systemdFiles, units: systemdUnits, fail: ["systemctl --user show tybo-smart-checkin.timer"] });
    expect(await uninstall(m)).toBe(1);
    expect(m.lines().filter(l => l.startsWith("systemctl") && !l.includes(" show "))).toEqual([]);
    expect(m.files.has(unit("tybo-telegram-relay.service"))).toBe(true);
    expect(m.err()).toContain("systemctl --user antwortet nicht");
  });

  test("Stoppen scheitert: Dateien dieses Diensts bleiben, die anderen gehen, Exit 1", async () => {
    const m = machine("linux", { files: systemdFiles, units: systemdUnits, fail: ["systemctl --user disable --now tybo-smart-checkin.timer"] });
    expect(await uninstall(m)).toBe(1);
    expect(m.files.has(unit("tybo-smart-checkin.timer"))).toBe(true);
    expect(m.files.has(unit("tybo-smart-checkin.service"))).toBe(true);
    expect(m.files.has(unit("tybo-telegram-relay.service"))).toBe(false);
    expect(m.files.has(unit("tybo-morning-briefing.timer"))).toBe(false);
  });

  test("Löschen bzw. daemon-reload scheitert: Exit 1", async () => {
    const del = machine("linux", { files: systemdFiles, units: systemdUnits, failRemove: [unit("tybo-telegram-relay.service")] });
    expect(await uninstall(del)).toBe(1);
    expect(del.err()).toContain("tybo-telegram-relay.service ist gestoppt, aber die Datei ließ sich nicht löschen");
    const reload = machine("linux", { files: systemdFiles, units: systemdUnits, fail: ["systemctl --user daemon-reload"] });
    expect(await uninstall(reload)).toBe(1);
    expect(reload.err()).toContain("daemon-reload");
  });

  test("ohne systemd: übrige Einheiten-Dateien nur gelöscht, kein systemctl", async () => {
    const m = machine("linux", { files: { [unit("tybo-telegram-relay.service")]: "[Service]\n" } });
    expect(await uninstall(m)).toBe(0);
    expect(m.files.has(unit("tybo-telegram-relay.service"))).toBe(false);
    expect(m.lines().some(l => l.startsWith("systemctl"))).toBe(false);
  });

  const STATIC_ACTIVE = "LoadState=loaded\nActiveState=active\nUnitFileState=static";
  const changesOf = (m: ReturnType<typeof machine>) => m.lines().filter(l => l.startsWith("systemctl") && !l.includes(" show "));

  test("Timer startet die Routine zwischen Vorabprüfung und Stoppen: sie wird nach frischem Zustand gestoppt, dann gelöscht", async () => {
    const m = machine("linux", {
      files: systemdFiles,
      units: systemdUnits,
      // Während der Bot gestoppt wird, startet der Timer die zuvor inaktive Routine
      after: { "systemctl --user disable --now tybo-telegram-relay.service": { units: { "tybo-smart-checkin.service": STATIC_ACTIVE } } },
    });
    expect(await uninstall(m)).toBe(0);
    expect(changesOf(m)).toContain("systemctl --user stop tybo-smart-checkin.service");
    expect(m.files.has(unit("tybo-smart-checkin.service"))).toBe(false);
    expect(m.files.has(unit("tybo-smart-checkin.timer"))).toBe(false);
  });

  test("Zustand nach dem Abschalten des Timers nicht lesbar: Dateien der Routine bleiben, Exit 1", async () => {
    const m = machine("linux", {
      files: systemdFiles,
      units: systemdUnits,
      after: { "systemctl --user disable --now tybo-smart-checkin.timer": { units: { "tybo-smart-checkin.service": STATIC_ACTIVE }, fail: ["systemctl --user show tybo-smart-checkin.service"] } },
    });
    expect(await uninstall(m)).toBe(1);
    expect(m.files.has(unit("tybo-smart-checkin.service"))).toBe(true);
    expect(m.files.has(unit("tybo-smart-checkin.timer"))).toBe(true);
    expect(changesOf(m)).not.toContain("systemctl --user stop tybo-smart-checkin.service");
    expect(m.err()).toContain("Zustand von tybo-smart-checkin.service ließ sich nicht lesen");
    // Die übrigen Dienste gehen trotzdem
    expect(m.files.has(unit("tybo-telegram-relay.service"))).toBe(false);
  });

  test("Einheit läuft nach dem Stoppen noch: Dateien bleiben, Exit 1", async () => {
    const m = machine("linux", {
      files: systemdFiles,
      units: { ...systemdUnits, "tybo-smart-checkin.service": STATIC_ACTIVE },
      after: { "systemctl --user stop tybo-smart-checkin.service": { units: { "tybo-smart-checkin.service": STATIC_ACTIVE } } },
    });
    expect(await uninstall(m)).toBe(1);
    expect(m.files.has(unit("tybo-smart-checkin.service"))).toBe(true);
    expect(m.err()).toContain("tybo-smart-checkin.service läuft nach dem Stoppen noch");
  });

  const DEACTIVATING = "LoadState=loaded\nActiveState=deactivating\nUnitFileState=static";

  test("Routine stoppt schon (deactivating): eigenes stop wartet auf das Ende, danach gelöscht", async () => {
    const m = machine("linux", { files: systemdFiles, units: { ...systemdUnits, "tybo-smart-checkin.service": DEACTIVATING } });
    expect(await uninstall(m)).toBe(0);
    expect(changesOf(m)).toContain("systemctl --user stop tybo-smart-checkin.service");
    expect(m.files.has(unit("tybo-smart-checkin.service"))).toBe(false);
    expect(m.files.has(unit("tybo-smart-checkin.timer"))).toBe(false);
  });

  test("Routine stoppt schon und bleibt nach dem stop deactivating: Dateien bleiben, Exit 1", async () => {
    const m = machine("linux", {
      files: systemdFiles,
      units: { ...systemdUnits, "tybo-smart-checkin.service": DEACTIVATING },
      after: { "systemctl --user stop tybo-smart-checkin.service": { units: { "tybo-smart-checkin.service": DEACTIVATING } } },
    });
    expect(await uninstall(m)).toBe(1);
    expect(m.files.has(unit("tybo-smart-checkin.service"))).toBe(true);
    expect(m.files.has(unit("tybo-smart-checkin.timer"))).toBe(true);
    expect(m.err()).toContain("tybo-smart-checkin.service stoppt nach dem Stoppen noch");
    expect(m.files.has(unit("tybo-telegram-relay.service"))).toBe(false);
  });

  test("Bot ist nach disable --now noch deactivating: Datei bleibt, Exit 1", async () => {
    const m = machine("linux", {
      files: systemdFiles,
      units: systemdUnits,
      after: { "systemctl --user disable --now tybo-telegram-relay.service": { units: { "tybo-telegram-relay.service": "LoadState=loaded\nActiveState=deactivating\nUnitFileState=disabled" } } },
    });
    expect(await uninstall(m)).toBe(1);
    expect(m.files.has(unit("tybo-telegram-relay.service"))).toBe(true);
    expect(m.err()).toContain("tybo-telegram-relay.service stoppt nach dem Stoppen noch");
    // Die übrigen Dienste gehen trotzdem
    expect(m.files.has(unit("tybo-smart-checkin.timer"))).toBe(false);
  });

  test("Schutzliste: Label (Einheit oder Dienstname) und Präfix aus config/routines.json bleiben unberührt", async () => {
    for (const routines of [{ labels: ["tybo-smart-checkin.service"], prefixes: ["tybo-morning-"] }, { labels: ["tybo-smart-checkin", "tybo-morning-briefing.timer"] }]) {
      const m = machine("linux", { files: { ...systemdFiles, [`${ROOT}/config/routines.json`]: JSON.stringify(routines) }, units: systemdUnits });
      expect(await uninstall(m)).toBe(0);
      for (const name of ["tybo-smart-checkin.timer", "tybo-smart-checkin.service", "tybo-morning-briefing.timer", "tybo-morning-briefing.service"]) {
        expect(m.files.has(unit(name))).toBe(true);
      }
      expect(m.lines().filter(l => /smart-checkin|morning-briefing/.test(l))).toEqual([]);
      expect(m.files.has(unit("tybo-telegram-relay.service"))).toBe(false);
      expect(m.out()).toContain("tybo-smart-checkin bleibt (steht in config/routines.json)");
    }
  });

  test("Schutzliste ohne laufendes systemd: geschützte Dateien bleiben, die übrigen werden gelöscht", async () => {
    const { [RUN_DIR]: _, ...withoutSystemd } = systemdFiles;
    const m = machine("linux", { files: { ...withoutSystemd, [`${ROOT}/config/routines.json`]: JSON.stringify({ labels: ["tybo-smart-checkin.service"], prefixes: ["tybo-morning-"] }) } });
    expect(await uninstall(m)).toBe(0);
    expect([...m.files.keys()].filter(f => f.startsWith(UNITS)).sort()).toEqual(
      [unit("anderer.service"), unit("tybo-morning-briefing.service"), unit("tybo-morning-briefing.timer"), unit("tybo-smart-checkin.service"), unit("tybo-smart-checkin.timer")].sort(),
    );
    expect(m.lines().some(l => l.startsWith("systemctl"))).toBe(false);
  });

  test("cron: eigene Zeilen (# tybo-<dienst> und frühere # go-<dienst>) weg, fremde bleiben", async () => {
    const crontab = [
      "SHELL=/bin/sh",
      "30 10 * * * cd /home/alex/tybo && bun run src/routines/checkin.ts # tybo-smart-checkin",
      "0 9 * * * cd /home/alex/tybo && bun run src/morning-briefing.ts # go-morning-briefing",
      "*/5 * * * * bun run watchdog.ts # go-watchdog",
      "0 2 * * * /usr/local/bin/backup.sh # go-backup",
      "15 3 * * * /usr/bin/true",
    ].join("\n");
    const m = machine("linux", { files: { [RUN_DIR]: "" }, crontab });
    expect(await uninstall(m)).toBe(0);
    expect(m.crontab().split("\n")).toEqual(["SHELL=/bin/sh", "0 2 * * * /usr/local/bin/backup.sh # go-backup", "15 3 * * * /usr/bin/true"]);
    // Zweiter Lauf schreibt die crontab nicht noch einmal
    const writes = m.lines().filter(l => l === "crontab -").length;
    expect(await uninstall(m)).toBe(0);
    expect(m.lines().filter(l => l === "crontab -").length).toBe(writes);
  });

  test("cron mit Schutzliste: geschützte Labels und Präfixe bleiben mit beiden Markierungen, ungeschützte gehen", async () => {
    const crontab = [
      "30 10 * * * cd /home/alex/tybo && bun run src/routines/checkin.ts # tybo-smart-checkin",
      "30 11 * * * cd /home/alex/tybo && bun run src/smart-checkin.ts # go-smart-checkin",
      "0 9 * * * cd /home/alex/tybo && bun run src/routines/briefing.ts # tybo-morning-briefing",
      "0 8 * * * cd /home/alex/tybo && bun run src/morning-briefing.ts # go-morning-briefing",
      "*/5 * * * * bun run watchdog.ts # go-watchdog",
      "30 3 * * * cd /home/alex/tybo && bun run src/health-check.ts # tybo-health-check",
      "15 3 * * * /usr/bin/true",
    ];
    const keptLines = [crontab[0], crontab[1], crontab[2], crontab[3], crontab[6]];
    for (const routines of [
      { labels: ["tybo-smart-checkin"], prefixes: ["tybo-morning-"] },
      { labels: ["go-smart-checkin"], prefixes: ["go-morning-"] },
      { labels: ["tybo-smart-checkin.service", "tybo-morning-briefing.timer"] },
    ]) {
      const m = machine("linux", { files: { [RUN_DIR]: "", [`${ROOT}/config/routines.json`]: JSON.stringify(routines) }, crontab: crontab.join("\n") });
      expect(await uninstall(m)).toBe(0);
      expect(m.crontab().split("\n")).toEqual(keptLines);
      expect(m.out()).toContain("cron-Zeilen von tybo-smart-checkin bleiben");
      expect(m.out()).toContain("cron-Zeilen von tybo-morning-briefing bleiben");
      expect(m.out()).toContain("cron-Zeilen entfernt: 2");
    }
  });

  test("cron: nur geschützte Zeilen da, nichts zu schreiben", async () => {
    const crontab = "30 10 * * * x # tybo-smart-checkin\n30 11 * * * y # go-smart-checkin";
    const m = machine("linux", { files: { [RUN_DIR]: "", [`${ROOT}/config/routines.json`]: JSON.stringify({ labels: ["tybo-smart-checkin"] }) }, crontab });
    expect(await uninstall(m)).toBe(0);
    expect(m.lines()).not.toContain("crontab -");
    expect(m.crontab()).toBe(crontab);
  });

  test("keine crontab: nichts zu tun", async () => {
    const m = machine("linux", { files: { [RUN_DIR]: "" }, crontab: null });
    expect(await uninstall(m)).toBe(0);
    expect(m.lines()).not.toContain("crontab -");
  });

  test("crontab nicht lesbar bzw. nicht schreibbar: Exit 1", async () => {
    const unreadable = machine("linux", { files: { [RUN_DIR]: "" }, fail: ["crontab -l"] });
    expect(await uninstall(unreadable)).toBe(1);
    expect(unreadable.lines()).not.toContain("crontab -");
    const unwritable = machine("linux", { files: { [RUN_DIR]: "" }, crontab: "0 9 * * * x # tybo-morning-briefing", fail: ["crontab -"] });
    expect(await uninstall(unwritable)).toBe(1);
    expect(unwritable.err()).toContain("crontab ließ sich nicht schreiben");
  });
});

// ---------------------------------------------------------------------------
// PM2
// ---------------------------------------------------------------------------

describe("PM2 (Linux, Windows)", () => {
  /** Gespeicherte Liste wie von PM2: Einträge mit mehr Feldern als dem Namen, die erhalten bleiben müssen */
  const entry = (name: string, status = "online") => ({ name, status, pm_exec_path: `/srv/${name}.js`, env: { NODE_ENV: "production" } });
  const dump = (m: ReturnType<typeof machine>) => JSON.parse(m.files.get(PM2_DUMP)!);
  const ROUTINES = { [`${ROOT}/config/routines.json`]: JSON.stringify({ prefixes: ["tybo-mein-"] }) };

  test("entfernt tybo-*, fremde und übergebene bleiben; Supabase mit langer Frist; nie pm2 save", async () => {
    const m = machine("linux", {
      files: { [RUN_DIR]: "", ...ROUTINES },
      pm2: ["tybo-telegram-relay", "tybo-supabase", "tybo-watchdog", "tybo-mein-watcher", "go-telegram-relay", "fremd"],
    });
    expect(await uninstall(m)).toBe(0);
    expect(m.pm2()).toEqual(["tybo-mein-watcher", "go-telegram-relay", "fremd"]);
    expect(m.calls.find(c => c.line === "pm2 delete tybo-supabase")?.timeoutMs).toBe(SUPABASE_DELETE_TIMEOUT_MS);
    expect(m.lines().some(l => l.startsWith("pm2 save"))).toBe(false);
    expect(m.out()).toContain(SUPABASE_KEPT);
    expect(m.lines().some(l => l.startsWith("npx"))).toBe(false);
  });

  test("PM2 nicht installiert: nie über npx, Exit 0", async () => {
    const m = machine("win32");
    expect(await uninstall(m)).toBe(0);
    expect(m.lines()).toEqual(["pm2 --version"]);
    expect(m.out()).toContain("PM2 ist nicht installiert");
  });

  test("pm2 --version scheitert bzw. läuft in die Frist, der Bot läuft noch: Exit 1, PM2 und dump.pm2 unverändert", async () => {
    const saved = JSON.stringify([entry("tybo-telegram-relay")]);
    const failing = machine("win32", { pm2: ["tybo-telegram-relay"], files: { [PM2_DUMP]: saved }, fail: ["pm2 --version"] });
    const expired = machine("linux", { pm2: ["tybo-telegram-relay"], files: { [PM2_DUMP]: saved } });
    const run = expired.deps.run;
    expired.deps.run = async (cmd, options) => (cmd.join(" ") === "pm2 --version" ? { ok: false, stdout: "", stderr: "Frist von 30000 ms abgelaufen" } : run(cmd, options));
    for (const m of [failing, expired]) {
      expect(await uninstall(m)).toBe(1);
      expect(m.lines().filter(l => l.startsWith("pm2"))).toEqual(m === failing ? ["pm2 --version"] : []);
      expect(m.pm2()).toEqual(["tybo-telegram-relay"]);
      expect(m.files.get(PM2_DUMP)).toBe(saved);
      expect(m.written).toEqual([]);
      expect(m.out()).not.toContain("PM2 ist nicht installiert");
      expect(m.err()).toContain("PM2 antwortet nicht");
    }
    expect(expired.err()).toContain("Frist von 30000 ms abgelaufen");
  });

  test("Windows: nur PM2, keine Aufgabenplanung; der Eintrag verschwindet aus dump.pm2", async () => {
    const m = machine("win32", { pm2: ["tybo-telegram-relay"], files: { [PM2_DUMP]: JSON.stringify([entry("tybo-telegram-relay")]) } });
    expect(await uninstall(m)).toBe(0);
    expect(m.lines()).toEqual(["pm2 --version", "pm2 jlist", "pm2 delete tybo-telegram-relay"]);
    expect(dump(m)).toEqual([]);
  });

  test("nichts zu entfernen: dump.pm2 bleibt unberührt", async () => {
    const m = machine("win32", { pm2: ["fremd"], files: { [PM2_DUMP]: JSON.stringify([entry("fremd")]) } });
    expect(await uninstall(m)).toBe(0);
    expect(m.written).toEqual([]);
  });

  test("leere Live-Liste, gespeichert gemischt: nur die eigenen Einträge fallen weg, fremde und geschützte bleiben wörtlich", async () => {
    const saved = [entry("tybo-telegram-relay"), entry("tybo-mein-watcher", "stopped"), entry("fremd-dienst", "stopped"), entry("tybo-supabase"), "kaputt", { ohne: "name" }];
    const m = machine("linux", { files: { [RUN_DIR]: "", [PM2_DUMP]: JSON.stringify(saved), ...ROUTINES }, pm2: [] });
    expect(await uninstall(m)).toBe(0);
    expect(dump(m)).toEqual([entry("tybo-mein-watcher", "stopped"), entry("fremd-dienst", "stopped"), "kaputt", { ohne: "name" }]);
    expect(m.lines().some(l => l.startsWith("pm2 save") || l.startsWith("pm2 delete"))).toBe(false);
    expect(m.out()).toContain("gestrichen: tybo-supabase, tybo-telegram-relay");
  });

  test("Live-Bot noch zu entfernen, geschützter Watcher und fremder Dienst nur gespeichert: beide bleiben im Autostart", async () => {
    const saved = [entry("tybo-telegram-relay"), entry("tybo-mein-watcher", "stopped"), entry("fremd-dienst", "stopped")];
    const m = machine("win32", { files: { [PM2_DUMP]: JSON.stringify(saved), ...ROUTINES }, pm2: ["tybo-telegram-relay"] });
    expect(await uninstall(m)).toBe(0);
    expect(m.pm2()).toEqual([]);
    expect(dump(m)).toEqual([entry("tybo-mein-watcher", "stopped"), entry("fremd-dienst", "stopped")]);
  });

  test("Entfernen scheitert: der Prozess läuft weiter und bleibt gespeichert, die anderen eigenen fallen weg", async () => {
    const saved = [entry("tybo-telegram-relay"), entry("tybo-smart-checkin"), entry("fremd")];
    const m = machine("win32", { files: { [PM2_DUMP]: JSON.stringify(saved) }, pm2: ["tybo-telegram-relay", "tybo-smart-checkin", "fremd"], fail: ["pm2 delete tybo-telegram-relay"] });
    expect(await uninstall(m)).toBe(1);
    expect(dump(m)).toEqual([entry("tybo-telegram-relay"), entry("fremd")]);
  });

  test("Schreiben scheitert, dann Wiederholung: die gespeicherte Liste wird trotz leerer Live-Liste bereinigt, Fremdes bleibt", async () => {
    const saved = JSON.stringify([entry("tybo-telegram-relay"), entry("tybo-mein-watcher", "stopped"), entry("fremd", "stopped")]);
    const m = machine("win32", { pm2: ["tybo-telegram-relay"], files: { [PM2_DUMP]: saved, ...ROUTINES }, failWrite: [PM2_DUMP] });
    expect(await uninstall(m)).toBe(1);
    expect(m.pm2()).toEqual([]);
    expect(m.files.get(PM2_DUMP)).toBe(saved);
    expect(m.err()).toContain("ließ sich nicht schreiben");
    m.setFailWrite([]);
    const before = m.lines().length;
    expect(await uninstall(m)).toBe(0);
    expect(m.lines().slice(before)).toEqual(["pm2 --version", "pm2 jlist"]);
    expect(dump(m)).toEqual([entry("tybo-mein-watcher", "stopped"), entry("fremd", "stopped")]);
    expect(m.out()).toContain("Fertig: 1 entfernt.");
    // Dritter Lauf: nichts Eigenes mehr gespeichert, nichts geschrieben
    const writes = m.written.length;
    expect(await uninstall(m)).toBe(0);
    expect(m.written.length).toBe(writes);
    expect(dump(m)).toEqual([entry("tybo-mein-watcher", "stopped"), entry("fremd", "stopped")]);
  });

  test("gespeicherte Liste nennt nur fremde bzw. übergebene Prozesse: nichts geschrieben", async () => {
    const m = machine("win32", { pm2: ["fremd"], files: { [PM2_DUMP]: JSON.stringify([{ name: "fremd" }, { name: "tybo-mein-watcher" }]), ...ROUTINES } });
    expect(await uninstall(m)).toBe(0);
    expect(m.written).toEqual([]);
  });

  describe("dump.pm2 fehlt, die Sicherung dump.pm2.bak ist da", () => {
    const BACKUP = `${PM2_DUMP}.bak`;
    const saved = [entry("tybo-telegram-relay"), entry("tybo-mein-watcher", "stopped"), entry("fremd", "stopped"), "kaputt"];
    const backup = (m: ReturnType<typeof machine>) => JSON.parse(m.files.get(BACKUP)!);

    for (const [what, live] of [["Live-Bot läuft noch", ["tybo-telegram-relay", "fremd"]], ["Live-Bot schon entfernt", ["fremd"]]] as const) {
      test(`${what}: die Sicherung wird bereinigt, fremde und geschützte bleiben; Wiederholung ändert nichts`, async () => {
        const m = machine("linux", { files: { [RUN_DIR]: "", [BACKUP]: JSON.stringify(saved), ...ROUTINES }, pm2: [...live] });
        expect(await uninstall(m)).toBe(0);
        expect(m.pm2()).toEqual(["fremd"]);
        expect(backup(m)).toEqual([entry("tybo-mein-watcher", "stopped"), entry("fremd", "stopped"), "kaputt"]);
        // dump.pm2 entsteht nicht neu: pm2 resurrect liest weiter die bereinigte Sicherung
        expect(m.files.has(PM2_DUMP)).toBe(false);
        expect(m.written).toEqual([BACKUP]);
        expect(m.out()).toContain("Sicherung dump.pm2.bak, dump.pm2 fehlt");
        expect(m.out()).toContain("gestrichen: tybo-telegram-relay");
        const before = m.lines().length;
        expect(await uninstall(m)).toBe(0);
        expect(m.lines().slice(before).filter(l => l.startsWith("pm2"))).toEqual(["pm2 --version", "pm2 jlist"]);
        expect(m.written).toEqual([BACKUP]);
        expect(m.out()).toContain("Fertig: es war nichts eingerichtet.");
      });
    }

    for (const [what, text] of [["kein JSON", "kein json"], ["kein Array", JSON.stringify({ name: "tybo-telegram-relay" })], ["leer", ""]] as const) {
      test(`Sicherung ${what}: Exit 1, nichts entfernt, nichts geschrieben`, async () => {
        const m = machine("win32", { pm2: ["tybo-telegram-relay"], files: { [BACKUP]: text } });
        expect(await uninstall(m)).toBe(1);
        expect(m.lines()).toEqual(["pm2 --version", "pm2 jlist"]);
        expect(m.pm2()).toEqual(["tybo-telegram-relay"]);
        expect(m.files.get(BACKUP)).toBe(text);
        expect(m.written).toEqual([]);
        expect(m.err()).toContain(`(${BACKUP}) ist nicht lesbar`);
      });
    }

    test("dump.pm2 da: die Sicherung bleibt unberührt", async () => {
      const m = machine("win32", { pm2: ["tybo-telegram-relay"], files: { [PM2_DUMP]: JSON.stringify([entry("tybo-telegram-relay")]), [BACKUP]: "kein json" } });
      expect(await uninstall(m)).toBe(0);
      expect(m.written).toEqual([PM2_DUMP]);
      expect(m.files.get(BACKUP)).toBe("kein json");
    });
  });

  for (const [what, text] of [["kein JSON", "kein json"], ["kein Array", JSON.stringify({ name: "tybo-telegram-relay" })], ["leer", ""]] as const) {
    test(`gespeicherte Liste ${what}: Exit 1, PM2 und dump.pm2 unverändert`, async () => {
      const m = machine("win32", { pm2: ["tybo-telegram-relay"], files: { [PM2_DUMP]: text } });
      expect(await uninstall(m)).toBe(1);
      expect(m.lines()).toEqual(["pm2 --version", "pm2 jlist"]);
      expect(m.pm2()).toEqual(["tybo-telegram-relay"]);
      expect(m.files.get(PM2_DUMP)).toBe(text);
      expect(m.err()).toContain("nicht lesbar; PM2 unverändert");
    });
  }

  test("echtes writeText: ersetzt die Datei über Umbenennen, nur für den Besitzer lesbar, keine Reste", () => {
    const dir = mkdtempSync(join(tmpdir(), "deinstallieren-dump-"));
    try {
      const path = join(dir, "dump.pm2");
      writeFileSync(path, "[1]");
      const deps = realUninstallDeps(dir, dir);
      deps.writeText(path, "[]\n");
      expect(readFileSync(path, "utf8")).toBe("[]\n");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir)).toEqual(["dump.pm2"]);
      expect(() => deps.writeText(join(dir, "fehlt", "dump.pm2"), "[]")).toThrow();
      expect(readdirSync(dir)).toEqual(["dump.pm2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Liste nicht lesbar, Entfernen oder Schreiben scheitert: Exit 1", async () => {
    for (const fail of ["pm2 jlist", "pm2 delete"]) {
      const m = machine("win32", { pm2: ["tybo-telegram-relay"], fail: [fail] });
      expect(await uninstall(m)).toBe(1);
    }
    const m = machine("win32", { pm2: ["tybo-telegram-relay"], files: { [PM2_DUMP]: JSON.stringify([entry("tybo-telegram-relay")]) }, failWrite: [PM2_DUMP] });
    expect(await uninstall(m)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Sprachmodelle, Aufruf, Alias
// ---------------------------------------------------------------------------

describe("models/speech/", () => {
  const speechFiles = {
    [`${ROOT}/models/speech/parakeet/encoder.int8.onnx`]: "x",
    [`${ROOT}/models/ggml-medium.bin`]: "whisper",
    [`${ROOT}/.env`]: "TELEGRAM_BOT_TOKEN=x\n",
    [`${ROOT}/data/memory.json`]: "{}",
  };

  test("Ja löscht nur models/speech/; .env, data/ und andere Modelle bleiben", async () => {
    const m = machine("darwin", { files: speechFiles, answer: true });
    expect(await uninstall(m)).toBe(0);
    expect(m.asked).toEqual([expect.stringContaining("models/speech/")]);
    expect(m.removedTrees).toEqual([`${ROOT}/models/speech`]);
    expect([...m.files.keys()].sort()).toEqual([`${ROOT}/.env`, `${ROOT}/data/memory.json`, `${ROOT}/models/ggml-medium.bin`]);
  });

  test("Nein: nichts gelöscht", async () => {
    const m = machine("darwin", { files: speechFiles, answer: false });
    expect(await uninstall(m)).toBe(0);
    expect(m.removedTrees).toEqual([]);
    expect(m.files.has(`${ROOT}/models/speech/parakeet/encoder.int8.onnx`)).toBe(true);
  });

  test("ohne Ordner keine Frage", async () => {
    const m = machine("darwin", { answer: true });
    expect(await uninstall(m)).toBe(0);
    expect(m.asked).toEqual([]);
  });

  test("Löschen scheitert: Exit 1", async () => {
    const m = machine("darwin", { files: speechFiles, answer: true });
    m.deps.removeTree = async () => {
      throw new Error("EBUSY");
    };
    expect(await uninstall(m)).toBe(1);
  });

  test("ohne Terminal ist die Antwort Nein, ohne zu lesen", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: false });
    expect(await askInTerminal("Löschen? ", input, new PassThrough())).toBe(false);
  });

  test("im Terminal: j heißt Ja, Enter heißt Nein", async () => {
    for (const [answer, want] of [["j\n", true], ["\n", false], ["nein\n", false]] as const) {
      const input = Object.assign(new PassThrough(), { isTTY: true });
      const asking = askInTerminal("Löschen? ", input, new PassThrough());
      input.write(answer);
      expect(await asking).toBe(want);
    }
  });
});

describe("Aufruf", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("help: Exit 0; unbekannte Argumente: Exit 2, nichts aufgerufen", async () => {
    const m = machine("darwin", { files: { [plist("ai.tybo.telegram-relay")]: "<plist/>" } });
    expect(await uninstall(m, ["help"])).toBe(0);
    expect(m.out()).toContain("tybo deinstallieren");
    expect(await uninstall(m, ["--alles"])).toBe(2);
    expect(m.calls).toEqual([]);
    expect(m.files.has(plist("ai.tybo.telegram-relay"))).toBe(true);
  });

  test("führendes -- (bun run uninstall -- …) zählt nicht", async () => {
    const m = machine("darwin");
    expect(await uninstall(m, ["--"])).toBe(0);
  });

  test("Projektordner aus dem Aufrufer, nicht aus dem Arbeitsverzeichnis; kein laufender Bot nötig", async () => {
    const root = mkdtempSync(join(tmpdir(), "tybo-deinst-"));
    dirs.push(root);
    mkdirSync(join(root, "models", "speech"), { recursive: true });
    writeFileSync(join(root, "models", "speech", "x.onnx"), "x");
    const asked: string[] = [];
    const out: string[] = [];
    const code = await runTybo({
      args: ["deinstallieren"],
      env: {},
      root,
      platform: "darwin",
      home: join(root, "home"),
      out: l => void out.push(l),
      err: () => {},
      // Nur die Befehle sind Attrappe; Dateizugriffe echt im Temp-Ordner
      uninstall: { run: async () => ({ ok: true, stdout: "", stderr: "" }), ask: async q => (asked.push(q), false) },
      fetch: (() => {
        throw new Error("kein Netz, kein Bot");
      }) as unknown as typeof fetch,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(`Projektordner: ${root}`);
    expect(asked.length).toBe(1);
    expect(existsSync(join(root, "models", "speech", "x.onnx"))).toBe(true);
  });

  test("Alias bun run uninstall ohne .env des Arbeitsverzeichnisses; setup/uninstall.ts ist entfernt", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(pkg.scripts.uninstall).toBe("bun --no-env-file scripts/tybo.ts deinstallieren");
    expect(existsSync(join(REPO, "setup", "uninstall.ts"))).toBe(false);
  });

  test("echter Aufruf aus fremdem Arbeitsverzeichnis: help, Exit 0", async () => {
    const foreign = mkdtempSync(join(tmpdir(), "tybo-deinst-cwd-"));
    dirs.push(foreign);
    writeFileSync(join(foreign, ".env"), "TYBO_ROOT=/gibt/es/nicht\n");
    const proc = Bun.spawn([process.execPath, "--no-env-file", join(REPO, "scripts", "tybo.ts"), "deinstallieren", "help"], { cwd: foreign, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: foreign } });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout).toContain("deinstallieren");
  });
});
