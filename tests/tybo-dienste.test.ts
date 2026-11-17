/**
 * Issue #369: tybo dienste (und der Alias bun run setup:launchd). Alles
 * Äußere über TyboOptions.services als Attrappe; kein Test ruft launchctl.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runTybo } from "../scripts/tybo";
import { parseServicesArgs } from "../src/setup/services/command";
import type { LaunchdDeps } from "../src/setup/services/launchd";
import type { LinuxDeps } from "../src/setup/services/linux";
import type { Pm2Deps } from "../src/setup/services/pm2";
import { LOCAL_SUPABASE_URL } from "../src/setup/local-supabase";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function projectDir(env = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "tybo-dienste-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".env"), env);
  return dir;
}

const AGENTS = "/home/test/Library/LaunchAgents";

function fakeLaunchd() {
  const files = new Map<string, string>();
  const loaded = new Set<string>();
  const calls: string[] = [];
  const deps: Partial<LaunchdDeps> = {
    launchAgentsDir: AGENTS,
    home: "/home/test",
    async run(cmd) {
      if (cmd[0] === "which") return { ok: true, stdout: `/opt/bin/${cmd[1]}`, stderr: "" };
      if (cmd[0] !== "launchctl") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
      if (cmd[1] === "list") return { ok: true, stdout: [...loaded].map(l => `7\t0\t${l}`).join("\n"), stderr: "" };
      calls.push(`${cmd[1]} ${basename(cmd[2], ".plist")}`);
      const label = basename(cmd[2], ".plist");
      if (cmd[1] === "load") loaded.add(label);
      if (cmd[1] === "unload") loaded.delete(label);
      return { ok: true, stdout: "", stderr: "" };
    },
    exists: p => p === AGENTS || files.has(p),
    readFile: p => {
      const text = files.get(p);
      if (text === undefined) throw new Error(`ENOENT ${p}`);
      return text;
    },
    writeFile: (p, c) => void files.set(p, c),
    mkdir: () => {},
  };
  return { deps, files, loaded, calls };
}

async function dienste(args: string[], options: { root?: string; env?: Record<string, string>; platform?: NodeJS.Platform; fake?: ReturnType<typeof fakeLaunchd> } = {}) {
  const fk = options.fake ?? fakeLaunchd();
  const out: string[] = [];
  const err: string[] = [];
  const code = await runTybo({
    args: ["dienste", ...args],
    env: options.env ?? {},
    root: options.root,
    platform: options.platform ?? "darwin",
    out: l => out.push(l),
    err: l => err.push(l),
    services: fk.deps,
  });
  return { code, out: out.join("\n"), err: err.join("\n"), fk };
}

const ROUTINES_AND_BOT = ["ai.tybo.telegram-relay", "ai.tybo.smart-checkin", "ai.tybo.morning-briefing", "ai.tybo.health-check"];

describe("tybo dienste", () => {
  test("ohne Angabe wie all: Bot und Routinen, external übersprungen, Exit 0", async () => {
    const { code, out, fk } = await dienste([], { root: projectDir() });
    expect(code).toBe(0);
    expect(fk.calls).toEqual(ROUTINES_AND_BOT.map(l => `load ${l}`));
    expect(out).toContain("Übersprungen (nicht von tybo eingerichtet): whatsapp-gateway, cloudflare-tunnel");
    expect(fk.files.has(`${AGENTS}/ai.tybo.software-update.plist`)).toBe(false);
    expect(fk.files.has(`${AGENTS}/ai.tybo.supabase.plist`)).toBe(false);
  });

  test("zweiter identischer Aufruf: nichts entladen, nichts neu geladen", async () => {
    const root = projectDir();
    const fk = fakeLaunchd();
    await dienste(["all"], { root, fake: fk });
    const before = new Map(fk.files);
    fk.calls.length = 0;
    const second = await dienste(["--service", "all"], { root, fake: fk });
    expect(second.code).toBe(0);
    expect(fk.calls).toEqual([]);
    expect(fk.files).toEqual(before);
    expect(second.out).toContain("Eingerichtet: 4 Dienste, davon unverändert: 4");
  });

  test("lokale SUPABASE_URL: supabase gehört zu all", async () => {
    const { code, fk } = await dienste([], { root: projectDir(`SUPABASE_URL=${LOCAL_SUPABASE_URL}\n`) });
    expect(code).toBe(0);
    expect(fk.calls.at(-1)).toBe("load ai.tybo.supabase");
  });

  test("einzelner Dienst, auch als --service; software-update nur so", async () => {
    const root = projectDir();
    const one = await dienste(["health-check"], { root });
    expect(one.code).toBe(0);
    expect(one.fk.calls).toEqual(["load ai.tybo.health-check"]);
    const two = await dienste(["--service", "software-update"], { root });
    expect(two.code).toBe(0);
    expect(two.fk.calls).toEqual(["load ai.tybo.software-update"]);
  });

  test("wartung (Issue #485): nur einzeln, sonntags 03:15 über den Wrapper; all lässt sie weg", async () => {
    const root = projectDir();
    const all = await dienste(["all"], { root });
    expect(all.fk.files.has(`${AGENTS}/ai.tybo.wartung.plist`)).toBe(false);
    const one = await dienste(["wartung"], { root });
    expect(one.code).toBe(0);
    expect(one.fk.calls).toEqual(["load ai.tybo.wartung"]);
    const plist = one.fk.files.get(`${AGENTS}/ai.tybo.wartung.plist`)!;
    expect(plist).toContain("<key>Weekday</key>\n\t\t<integer>0</integer>");
    expect(plist).toContain("<string>src/maintenance.ts</string>");
    expect(plist).toContain(`<string>${root}/logs/wartung.log</string>`);
  });

  test("external einzeln verlangt: Exit 1, kein launchctl", async () => {
    const { code, err, fk } = await dienste(["cloudflare-tunnel"], { root: projectDir() });
    expect(code).toBe(1);
    expect(err).toContain("Nicht eingerichtet: cloudflare-tunnel");
    expect(fk.calls).toEqual([]);
  });

  test("Fehler beim Laden: Exit 1", async () => {
    const fk = fakeLaunchd();
    const run = fk.deps.run!;
    fk.deps.run = async (cmd, o) => (cmd[1] === "load" ? { ok: false, stdout: "", stderr: "x" } : run(cmd, o));
    const { code, err } = await dienste(["telegram-relay"], { root: projectDir(), fake: fk });
    expect(code).toBe(1);
    expect(err).toContain("Nicht eingerichtet: telegram-relay");
  });

  test("unbekannter Dienst und unbekannter Aufruf: Exit 2, kein launchctl", async () => {
    for (const args of [["gibtsnicht"], ["--service"], ["--alles"], ["a", "b"]]) {
      const { code, err, fk } = await dienste(args, { root: projectDir() });
      expect(code).toBe(2);
      expect(err).toContain("Unbekannt");
      expect(fk.calls).toEqual([]);
    }
  });

  test("help: Exit 0 mit Liste der Dienste", async () => {
    const { code, out } = await dienste(["help"], { root: projectDir() });
    expect(code).toBe(0);
    expect(out).toContain("health-check");
    expect(out).toContain("all");
  });

  test("Windows: Exit 1, kein launchctl, keine Aufgabenplanung (E12)", async () => {
    const { code, err, fk } = await dienste([], { root: projectDir(), platform: "win32" });
    expect(code).toBe(1);
    expect(err).toContain("Unter Windows richtet tybo keine Dienste ein");
    expect(fk.calls).toEqual([]);
  });

  test("Projektordner aus TYBO_ROOT, nicht aus dem Arbeitsverzeichnis", async () => {
    const root = projectDir();
    const { code, fk } = await dienste(["telegram-relay"], { env: { TYBO_ROOT: root } });
    expect(code).toBe(0);
    const plist = fk.files.get(`${AGENTS}/ai.tybo.telegram-relay.plist`)!;
    expect(plist).toContain(`<string>${root}</string>`);
    expect(plist).not.toContain(`<string>${process.cwd()}</string>`);
  });

  test("Argumente", () => {
    expect(parseServicesArgs([])).toBe("all");
    expect(parseServicesArgs(["all"])).toBe("all");
    expect(parseServicesArgs(["--service", "supabase"])).toBe("supabase");
    expect(parseServicesArgs(["--service"])).toBeNull();
    expect(parseServicesArgs(["--", "--service", "all"])).toBe("all");
    expect(parseServicesArgs(["--"])).toBe("all");
    expect(parseServicesArgs(["--", "--"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Linux (Issue #370): PM2 für Bot und Supabase, systemd-Timer für Routinen
// ---------------------------------------------------------------------------

const UNITS = "/home/test/.config/systemd/user";
const DUMP = "/home/test/.pm2/dump.pm2";

/**
 * systemdBot: Unit-Datei des Bots liegt da. botUnit: Zustand laut systemctl
 * show, „loaded“ bzw. „running“ auch ohne Datei; „unreachable“: der
 * Benutzer-Manager antwortet nicht.
 */
function fakeLinuxHost(
  options: {
    pm2Missing?: boolean;
    failSave?: boolean;
    systemdBot?: boolean;
    botUnit?: "loaded" | "running" | "unreachable";
    /** Issue #568: kein systemd auf dem Rechner */
    noSystemd?: boolean;
    /** Issue #568: PM2-Prozesse, die schon laufen */
    pm2Procs?: string[];
    /** Issue #568: Antwort des PM2-Daemons auf die Abfrage über den Socket */
    daemon?: "ok" | "not-running" | "failed";
    /** Issue #568: crontab-Zeilen (sonst „no crontab“) */
    crontab?: string[];
    /** Issue #568: Sicherung von PM2 (pm2 save); fehlt: wie pm2Procs */
    dump?: string[];
    /** Issue #568: pm2 delete scheitert */
    failDelete?: boolean;
    /** Issue #568: crontab - (Schreiben) scheitert */
    failCrontabWrite?: boolean;
    /** Issue #568: systemctl --user disable scheitert */
    failDisable?: boolean;
    /** Prüfer-Hinweis zu #568: systemctl --user restart scheitert (enable gelingt) */
    failRestart?: boolean;
    /** Prüfer-Hinweis zu #568: die gesicherte Liste (dump.pm2) ist kein JSON */
    dumpUnreadable?: boolean;
  } = {},
) {
  const files = new Map<string, string>();
  if (options.systemdBot) files.set(`${UNITS}/tybo-telegram-relay.service`, "[Service]");
  const calls: string[] = [];
  const procs = new Set<string>(options.pm2Procs ?? []);
  // Wie PM2: pm2 save überschreibt die Sicherung bei leerer Liste nur mit --force
  let dump: string[] = [...(options.dump ?? options.pm2Procs ?? [])];
  const enabledTimers = new Set<string>();
  const activeTimers = new Set<string>();
  let crontab: string[] | null = options.crontab ? [...options.crontab] : null;
  const pm2Commands: string[][] = [];
  const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
  const timers: Partial<LinuxDeps> = {
    home: "/home/test",
    unitDir: UNITS,
    runDir: "/run/systemd/system",
    user: "alex",
    async run(cmd, opts) {
      if (cmd[0] === "which") return ok(`/opt/bin/${cmd[1]}`);
      if (cmd[0] === "loginctl") return ok("yes");
      if (cmd[0] === "crontab") {
        if (cmd[1] === "-l") return crontab === null ? { ok: false, stdout: "", stderr: "no crontab for alex" } : ok(crontab.join("\n"));
        calls.push("crontab -");
        if (options.failCrontabWrite) return { ok: false, stdout: "", stderr: "x" };
        const input = opts?.stdin ?? "";
        crontab = input === "" ? [] : input.replace(/\n$/, "").split("\n");
        return ok();
      }
      if (cmd[0] !== "systemctl") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
      if (options.botUnit === "unreachable") return { ok: false, stdout: "", stderr: "Failed to connect to bus" };
      if (cmd[2] === "show" && cmd[3] === "tybo-telegram-relay.service") {
        if (options.botUnit === "loaded") return ok("LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled");
        if (options.botUnit === "running") return ok("LoadState=not-found\nActiveState=active\nUnitFileState=");
      }
      if (cmd[2] === "show") return ok("LoadState=not-found\nActiveState=inactive\nUnitFileState=");
      calls.push(`systemctl ${cmd.slice(2).join(" ")}`);
      if (cmd[2] === "enable") enabledTimers.add(cmd[3]);
      if (cmd[2] === "restart") {
        if (options.failRestart) return { ok: false, stdout: "", stderr: "x" };
        activeTimers.add(cmd[3]);
      }
      if (cmd[2] === "disable") {
        if (options.failDisable) return { ok: false, stdout: "", stderr: "x" };
        enabledTimers.delete(cmd[cmd.length - 1]);
        if (cmd.includes("--now")) activeTimers.delete(cmd[cmd.length - 1]);
      }
      return ok();
    },
    // Die Sicherung von PM2 liegt als Datei DUMP vor, getrennt von den Einheiten in files
    exists: p => (p === "/run/systemd/system" ? !options.noSystemd : p === DUMP || files.has(p)),
    readFile: p => (p === DUMP ? (options.dumpUnreadable ? "{kaputt" : JSON.stringify(dump.map(name => ({ name })))) : (files.get(p) ?? "")),
    writeFile: (p, c) => {
      if (p === DUMP) dump = (JSON.parse(c) as { name: string }[]).map(e => e.name);
      else files.set(p, c);
    },
    remove: p => void files.delete(p),
    mkdir: () => {},
  };
  const pm2: Partial<Pm2Deps> = {
    dumpPath: DUMP,
    async run(cmd) {
      if (cmd[0] !== "pm2") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
      if (cmd[1] === "--version") return options.pm2Missing ? { ok: false, stdout: "", stderr: "Befehl nicht gefunden", missing: true } : ok("6.0.0");
      if (cmd[1] === "jlist") return ok(JSON.stringify([...procs].map(name => ({ name }))));
      calls.push(`pm2 ${cmd[1]}${cmd[1] === "start" ? ` ${cmd[cmd.indexOf("--name") + 1]}` : cmd[1] === "delete" ? ` ${cmd[2]}` : ""}${cmd.includes("--force") ? " --force" : ""}`);
      pm2Commands.push(cmd);
      if (cmd[1] === "start") procs.add(cmd[cmd.indexOf("--name") + 1]);
      if (cmd[1] === "delete") {
        if (options.failDelete) return { ok: false, stdout: "", stderr: "x" };
        procs.delete(cmd[2]);
      }
      if (cmd[1] === "save") {
        if (options.failSave) return { ok: false, stdout: "", stderr: "x" };
        // PM2 (lib/API/Startup.js, dump): leere Liste ohne --force überspringt das Schreiben, Exit 0
        if (procs.size > 0 || cmd.includes("--force")) dump = [...procs];
      }
      return ok();
    },
    // Nie der echte Socket: Antwort des Daemons als Attrappe
    async query() {
      const daemon = options.daemon ?? (procs.size ? "ok" : "not-running");
      if (daemon === "ok") return { status: "ok", processes: [...procs].map(name => ({ name })) };
      return { status: daemon };
    },
  };
  /** Neustart des Rechners: PM2 holt die Prozesse aus der Sicherung (pm2 resurrect), systemd startet die aktivierten Timer */
  const reboot = () => {
    procs.clear();
    for (const name of dump) procs.add(name);
    activeTimers.clear();
    for (const unit of enabledTimers) activeTimers.add(unit);
  };
  /** Zustand eines Timers, aktiviert (beim Hochfahren) und aktiv (jetzt) getrennt */
  const timer = (unit: string) => ({ enabled: enabledTimers.has(unit), active: activeTimers.has(unit) });
  /** Aktive Zeitpläne des Nachtchecks: Timer, PM2-Prozess, cron-Zeile */
  const healthSchedules = () => [
    ...(enabledTimers.has("tybo-health-check.timer") ? ["timer"] : []),
    ...(procs.has("tybo-health-check") ? ["pm2"] : []),
    ...((crontab ?? []).some(line => line.includes("# tybo-health-check")) ? ["cron"] : []),
  ];
  return { timers, pm2, files, calls, pm2Commands, crontab: () => crontab, dump: () => dump, procs: () => [...procs], reboot, healthSchedules, timer };
}

async function dienstLinux(args: string[], host = fakeLinuxHost(), env = "") {
  const fk = fakeLaunchd();
  const out: string[] = [];
  const err: string[] = [];
  const root = projectDir(env);
  const code = await runTybo({
    args: ["dienste", ...args],
    env: {},
    root,
    platform: "linux",
    out: l => out.push(l),
    err: l => err.push(l),
    services: fk.deps,
    linuxServices: { timers: host.timers, pm2: host.pm2 },
  });
  return { code, out: out.join("\n"), err: err.join("\n"), host, launchctl: fk.calls, root };
}

describe("tybo dienste unter Linux", () => {
  test("all: Bot unter PM2, Check-in und Briefing als Timer, einmal pm2 save; kein launchctl", async () => {
    const { code, out, err, host, launchctl } = await dienstLinux([]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(launchctl).toEqual([]);
    expect(host.calls).toEqual([
      "pm2 start tybo-telegram-relay",
      "systemctl daemon-reload",
      "systemctl enable tybo-smart-checkin.timer",
      "systemctl restart tybo-smart-checkin.timer",
      "systemctl daemon-reload",
      "systemctl enable tybo-morning-briefing.timer",
      "systemctl restart tybo-morning-briefing.timer",
      "systemctl daemon-reload",
      "systemctl enable tybo-health-check.timer",
      "systemctl restart tybo-health-check.timer",
      "pm2 save",
    ]);
    expect([...host.files.keys()].sort()).toEqual(
      [
        "tybo-health-check.service",
        "tybo-health-check.timer",
        "tybo-morning-briefing.service",
        "tybo-morning-briefing.timer",
        "tybo-smart-checkin.service",
        "tybo-smart-checkin.timer",
      ].map(f => `${UNITS}/${f}`),
    );
    expect(out).toContain("Richte 4 Dienste ein: telegram-relay, smart-checkin, morning-briefing, health-check");
    expect(out).toContain("pm2 startup");
  });

  test("wartung: eigener Timer sonntags, nicht in all", async () => {
    const all = await dienstLinux([]);
    expect([...all.host.files.keys()].some(f => f.includes("wartung"))).toBe(false);
    const { code, host } = await dienstLinux(["wartung"]);
    expect(code).toBe(0);
    expect(host.calls).toEqual(["systemctl daemon-reload", "systemctl enable tybo-wartung.timer", "systemctl restart tybo-wartung.timer"]);
    expect(host.files.get(`${UNITS}/tybo-wartung.timer`)).toContain("OnCalendar=Sun *-*-* 03:15:00");
  });

  test("lokale Datenbank: supabase unter PM2 dabei", async () => {
    const { code, host } = await dienstLinux(["all"], fakeLinuxHost(), `SUPABASE_URL=${LOCAL_SUPABASE_URL}\n`);
    expect(code).toBe(0);
    expect(host.calls.filter(c => c.startsWith("pm2"))).toEqual(["pm2 start tybo-telegram-relay", "pm2 start tybo-supabase", "pm2 save"]);
  });

  test("Bot schon als systemd-Benutzerdienst: bei all übersprungen, einzeln verlangt Exit 1; nie zwei Bots", async () => {
    const all = await dienstLinux([], fakeLinuxHost({ systemdBot: true }));
    expect(all.code).toBe(0);
    expect(all.host.calls.some(c => c.includes("tybo-telegram-relay"))).toBe(false);
    expect(all.out).toContain("Übersprungen: telegram-relay");
    const single = await dienstLinux(["telegram-relay"], fakeLinuxHost({ systemdBot: true }));
    expect(single.code).toBe(1);
    expect(single.err).toContain("PM2 startet keinen zweiten");
    expect(single.host.calls).toEqual([]);
  });

  test("Bot unter systemd und PM2 fehlt: all überspringt den Bot, richtet die Timer ein, Exit 0", async () => {
    const { code, out, err, host } = await dienstLinux([], fakeLinuxHost({ systemdBot: true, pm2Missing: true }));
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("Übersprungen: telegram-relay");
    expect(host.calls.some(c => c.startsWith("pm2"))).toBe(false);
    expect(host.calls).toContain("systemctl enable tybo-smart-checkin.timer");
    expect(host.calls).toContain("systemctl enable tybo-morning-briefing.timer");
  });

  test("Bot-Unit geladen oder laufend ohne Datei: PM2 startet keinen zweiten", async () => {
    for (const botUnit of ["loaded", "running"] as const) {
      const all = await dienstLinux([], fakeLinuxHost({ botUnit }));
      expect(all.code).toBe(0);
      expect(all.host.files.has(`${UNITS}/tybo-telegram-relay.service`)).toBe(false);
      expect(all.host.calls.some(c => c.startsWith("pm2"))).toBe(false);
      expect(all.out).toContain("Übersprungen: telegram-relay");
      const single = await dienstLinux(["telegram-relay"], fakeLinuxHost({ botUnit }));
      expect(single.code).toBe(1);
      expect(single.err).toContain("PM2 startet keinen zweiten");
      expect(single.host.calls).toEqual([]);
    }
  });

  test("systemd-Benutzer-Manager antwortet nicht: kein Bot unter PM2, Exit 1", async () => {
    for (const args of [[], ["telegram-relay"]]) {
      const { code, err, host } = await dienstLinux(args, fakeLinuxHost({ botUnit: "unreachable" }));
      expect(code).toBe(1);
      expect(err).toContain("unklar");
      expect(err).toContain("Nicht eingerichtet: telegram-relay");
      expect(host.calls.some(c => c.startsWith("pm2"))).toBe(false);
    }
  });

  test("PM2 fehlt: Exit 1 mit Installationsbefehl, Timer trotzdem eingerichtet", async () => {
    const { code, err, host } = await dienstLinux([], fakeLinuxHost({ pm2Missing: true }));
    expect(code).toBe(1);
    expect(err).toContain("npm install -g pm2");
    expect(err).toContain("Nicht eingerichtet: telegram-relay");
    expect(host.calls.some(c => c.startsWith("pm2"))).toBe(false);
    expect(host.calls).toContain("systemctl enable tybo-smart-checkin.timer");
  });

  test("pm2 save scheitert: Exit 1, gemeldet", async () => {
    const { code, out, err } = await dienstLinux(["telegram-relay"], fakeLinuxHost({ failSave: true }));
    expect(code).toBe(1);
    expect(out + err).toContain("pm2 save ist gescheitert");
  });

  test("nur unter macOS: software-update und external einzeln verlangt, Exit 1 ohne Änderung", async () => {
    for (const service of ["software-update", "cloudflare-tunnel"]) {
      const { code, err, host } = await dienstLinux([service]);
      expect(code).toBe(1);
      expect(err).toContain(service);
      expect(host.calls).toEqual([]);
    }
  });

  // Issue #568: Nachtcheck unter Linux
  test("health-check mit systemd: Timer mit Zeitzone aus USER_TIMEZONE, kein PM2-Aufruf", async () => {
    const { code, err, host } = await dienstLinux(["health-check"], fakeLinuxHost(), "USER_TIMEZONE=Europe/Berlin\n");
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(host.calls).toEqual(["systemctl daemon-reload", "systemctl enable tybo-health-check.timer", "systemctl restart tybo-health-check.timer"]);
    const timer = host.files.get(`${UNITS}/tybo-health-check.timer`)!;
    expect(timer).toContain("OnCalendar=*-*-* 03:30:00 Europe/Berlin\n");
    expect(host.files.get(`${UNITS}/tybo-health-check.service`)).toContain("--id ai.tybo.health-check");
  });

  test("health-check mit systemd und altem PM2-Zeitplan: Timer zuerst, dann PM2-Eintrag entfernt und gesichert", async () => {
    const { code, err, host } = await dienstLinux(["health-check"], fakeLinuxHost({ pm2Procs: ["tybo-health-check", "tybo-telegram-relay"] }));
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(host.calls).toEqual([
      "systemctl daemon-reload",
      "systemctl enable tybo-health-check.timer",
      "systemctl restart tybo-health-check.timer",
      "pm2 delete tybo-health-check",
      "pm2 save --force",
    ]);
    host.reboot();
    expect(host.healthSchedules()).toEqual(["timer"]);
  });

  test("health-check mit systemd: tybo-health-check war der letzte PM2-Prozess, die leere Liste wird gesichert und er kommt nach dem Neustart nicht zurück", async () => {
    const host = fakeLinuxHost({ pm2Procs: ["tybo-health-check"] });
    // Die Attrappe verhält sich wie PM2: ein einfaches pm2 save ließe die alte Sicherung stehen
    const probe = fakeLinuxHost({ dump: ["tybo-health-check"] });
    expect((await probe.pm2.run!(["pm2", "save"])).ok).toBe(true);
    expect(probe.dump()).toEqual(["tybo-health-check"]);

    const { code, err } = await dienstLinux(["health-check"], host);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(host.calls.at(-1)).toBe("pm2 save --force");
    expect(host.dump()).toEqual([]);
    host.reboot();
    expect(host.healthSchedules()).toEqual(["timer"]);
  });

  test("health-check mit systemd: PM2-Liste nicht lesbar, Exit 1 mit Hinweis, kein Timer, nur der bisherige Zeitplan", async () => {
    const { code, out, err, host } = await dienstLinux(["health-check"], fakeLinuxHost({ daemon: "failed", pm2Procs: ["tybo-health-check"] }));
    expect(code).toBe(1);
    expect(out + err).toContain("ließ sich nicht prüfen");
    expect(out + err).toContain("Kein Timer eingerichtet");
    expect(host.calls).toEqual([]);
    expect(host.files.size).toBe(0);
    expect(host.healthSchedules()).toEqual(["pm2"]);
  });

  test("health-check mit systemd: PM2-Eintrag lässt sich nicht entfernen, Timer wieder abgeschaltet, Exit 1", async () => {
    const host = fakeLinuxHost({ pm2Procs: ["tybo-health-check", "tybo-telegram-relay"], failDelete: true });
    const { code, out, err } = await dienstLinux(["health-check"], host);
    expect(code).toBe(1);
    expect(out + err).toContain("ließ sich nicht entfernen");
    expect(out + err).toContain("wieder abgeschaltet");
    expect(err).toContain("Nicht eingerichtet: health-check");
    expect(host.calls).toEqual([
      "systemctl daemon-reload",
      "systemctl enable tybo-health-check.timer",
      "systemctl restart tybo-health-check.timer",
      "pm2 delete tybo-health-check",
      "systemctl disable --now tybo-health-check.timer",
    ]);
    expect(host.healthSchedules()).toEqual(["pm2"]);
    host.reboot();
    expect(host.healthSchedules()).toEqual(["pm2"]);
  });

  test("health-check mit systemd: auch das Abschalten scheitert, Exit 1 und die Meldung sagt doppelt mit Befehl", async () => {
    const { code, out, err } = await dienstLinux(["health-check"], fakeLinuxHost({ pm2Procs: ["tybo-health-check"], failDelete: true, failDisable: true }));
    expect(code).toBe(1);
    expect(out + err).toContain("startet doppelt");
    expect(out + err).toContain("systemctl --user disable --now tybo-health-check.timer");
  });

  test("health-check ohne systemd mit PM2: Zeitplan unter PM2, alte cron-Zeile weg, einmal pm2 save", async () => {
    const oldCron = "30 3 * * * cd /x && bun run src/health-check.ts # tybo-health-check";
    const foreign = "5 4 * * * /usr/bin/backup.sh";
    const host = fakeLinuxHost({ noSystemd: true, crontab: [foreign, oldCron] });
    const { code, err, root } = await dienstLinux(["health-check"], host, "USER_TIMEZONE=Europe/Berlin\n");
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(host.calls).toEqual(["pm2 start tybo-health-check", "crontab -", "pm2 save"]);
    expect(host.crontab()).toEqual([foreign]);
    const start = host.pm2Commands.find(c => c[1] === "start")!;
    expect(start.slice(0, 3)).toEqual(["pm2", "start", "/opt/bin/bun"]);
    expect(start[start.indexOf("--cron-restart") + 1]).toBe("30 3 * * *");
    expect(start).toContain("--no-autorestart");
    expect(start[start.indexOf("--cwd") + 1]).toBe(root);
    expect(start[start.indexOf("--error") + 1]).toBe(join(root, "logs/health-check.error.log"));
    expect(start.slice(start.indexOf("--") + 1)).toEqual(["--no-env-file", "src/routine-run.ts", "--id", "ai.tybo.health-check", "--", "/opt/bin/bun", "run", "src/health-check.ts"]);
    expect(host.files.size).toBe(0);
  });

  test("health-check ohne systemd mit PM2, schon eingerichtet: alter Eintrag ersetzt, nie zwei", async () => {
    const host = fakeLinuxHost({ noSystemd: true, pm2Procs: ["tybo-health-check"] });
    const { code } = await dienstLinux(["health-check"], host);
    expect(code).toBe(0);
    expect(host.calls).toEqual(["pm2 delete tybo-health-check", "pm2 start tybo-health-check", "pm2 save"]);
  });

  test("health-check ohne systemd mit PM2: cron-Zeilen nicht entfernbar, neuer PM2-Prozess wieder heraus, nur cron bleibt", async () => {
    const oldCron = "30 3 * * * cd /x && bun run src/health-check.ts # tybo-health-check";
    const host = fakeLinuxHost({ noSystemd: true, crontab: [oldCron], failCrontabWrite: true });
    const { code, out, err } = await dienstLinux(["health-check"], host);
    expect(code).toBe(1);
    expect(out + err).toContain("wieder aus PM2 entfernt");
    expect(host.calls).toEqual(["pm2 start tybo-health-check", "crontab -", "pm2 delete tybo-health-check"]);
    expect(host.healthSchedules()).toEqual(["cron"]);
  });

  test("health-check ohne systemd: alter PM2-Prozess ersetzt, cron-Zeilen nicht entfernbar, leere Liste gesichert, nach Neustart nur cron", async () => {
    const oldCron = "30 3 * * * cd /x && bun run src/health-check.ts # tybo-health-check";
    const host = fakeLinuxHost({ noSystemd: true, pm2Procs: ["tybo-health-check"], crontab: [oldCron], failCrontabWrite: true });
    const { code } = await dienstLinux(["health-check"], host);
    expect(code).toBe(1);
    expect(host.calls).toEqual(["pm2 delete tybo-health-check", "pm2 start tybo-health-check", "crontab -", "pm2 delete tybo-health-check", "pm2 save --force"]);
    expect(host.healthSchedules()).toEqual(["cron"]);
    host.reboot();
    expect(host.healthSchedules()).toEqual(["cron"]);
  });

  test("health-check ohne systemd: cron-Zeilen nicht entfernbar und PM2-Prozess nicht herausnehmbar, Meldung sagt doppelt", async () => {
    const oldCron = "30 3 * * * cd /x && bun run src/health-check.ts # tybo-health-check";
    const { code, out, err } = await dienstLinux(["health-check"], fakeLinuxHost({ noSystemd: true, crontab: [oldCron], failCrontabWrite: true, failDelete: true }));
    expect(code).toBe(1);
    expect(out + err).toContain("startet doppelt");
  });

  test("health-check ohne systemd und ohne PM2: cron-Zeile wie bisher, kein PM2-Start", async () => {
    const host = fakeLinuxHost({ noSystemd: true, pm2Missing: true });
    const { code, out } = await dienstLinux(["health-check"], host);
    expect(code).toBe(0);
    expect(out).toContain("PM2 fehlt, darum als cron-Zeile");
    expect(host.calls).toEqual(["crontab -"]);
    expect(host.crontab()!).toHaveLength(1);
    expect(host.crontab()![0]).toContain("# tybo-health-check");
  });

  // Prüfer-Hinweise zu #568 (PR #645): Wechsel der Zeitplaner nie doppelt, auch nach dem Hochfahren
  const OLD_HEALTH_CRON = "30 3 * * * cd /x && bun run src/health-check.ts # tybo-health-check";

  test("health-check mit systemd: alte cron-Zeile nicht entfernbar, Timer wieder abgeschaltet, nur cron, auch nach Neustart", async () => {
    const host = fakeLinuxHost({ crontab: [OLD_HEALTH_CRON], failCrontabWrite: true });
    const { code, out, err } = await dienstLinux(["health-check"], host);
    expect(code).toBe(1);
    expect(out + err).toContain("wieder abgeschaltet, der Dienst läuft weiter über cron");
    expect(host.calls).toEqual([
      "systemctl daemon-reload",
      "systemctl enable tybo-health-check.timer",
      "systemctl restart tybo-health-check.timer",
      "crontab -",
      "systemctl disable --now tybo-health-check.timer",
    ]);
    expect(host.healthSchedules()).toEqual(["cron"]);
    host.reboot();
    expect(host.healthSchedules()).toEqual(["cron"]);
  });

  test("health-check mit systemd: cron-Zeile bleibt und Timer lässt sich nicht abschalten, Meldung sagt doppelt mit Befehl", async () => {
    const { code, out, err } = await dienstLinux(["health-check"], fakeLinuxHost({ crontab: [OLD_HEALTH_CRON], failCrontabWrite: true, failDisable: true }));
    expect(code).toBe(1);
    expect(out + err).toContain("startet doppelt");
    expect(out + err).toContain("systemctl --user disable --now tybo-health-check.timer");
  });

  test("health-check mit systemd: pm2 save nach dem Entfernen scheitert, Timer wieder abgeschaltet, nach Neustart nur PM2", async () => {
    const host = fakeLinuxHost({ pm2Procs: ["tybo-health-check"], failSave: true });
    const { code, out, err } = await dienstLinux(["health-check"], host);
    expect(code).toBe(1);
    expect(out + err).toContain("pm2 save ist gescheitert");
    expect(out + err).toContain("wieder abgeschaltet");
    expect(err).toContain("Nicht eingerichtet: health-check");
    expect(host.calls).toEqual([
      "systemctl daemon-reload",
      "systemctl enable tybo-health-check.timer",
      "systemctl restart tybo-health-check.timer",
      "pm2 delete tybo-health-check",
      "pm2 save --force",
      "systemctl disable --now tybo-health-check.timer",
    ]);
    expect(host.dump()).toEqual(["tybo-health-check"]);
    expect(host.healthSchedules()).toEqual([]);
    host.reboot();
    expect(host.healthSchedules()).toEqual(["pm2"]);
  });

  test("health-check mit systemd und all: nach gescheiterter Sicherung keine zweite, die den Nachtcheck aus der Sicherung nähme", async () => {
    const host = fakeLinuxHost({ pm2Procs: ["tybo-health-check"], failSave: true });
    const { code } = await dienstLinux([], host);
    expect(code).toBe(1);
    expect(host.calls.filter(c => c.startsWith("pm2 save"))).toEqual(["pm2 save --force"]);
    host.reboot();
    expect(host.healthSchedules()).toEqual(["pm2"]);
  });

  test("health-check mit systemd: PM2 läuft nicht, die Sicherung nennt den Nachtcheck; dort gestrichen, nach Neustart nur der Timer", async () => {
    for (const daemon of ["not-running", "ok"] as const) {
      const host = fakeLinuxHost({ daemon, dump: ["tybo-health-check", "fremd-app"] });
      const { code, err } = await dienstLinux(["health-check"], host);
      expect(err).toBe("");
      expect(code).toBe(0);
      // Ohne PM2-CLI: kein Daemon gestartet, kein pm2 save, das die Sicherung durch die leere Liste ersetzte
      expect(host.calls.some(c => c.startsWith("pm2"))).toBe(false);
      expect(host.dump()).toEqual(["fremd-app"]);
      host.reboot();
      expect(host.healthSchedules()).toEqual(["timer"]);
    }
  });

  test("health-check mit systemd: Sicherung von PM2 nicht lesbar, Exit 1, kein Timer", async () => {
    const host = fakeLinuxHost({ dump: ["tybo-health-check"], dumpUnreadable: true });
    const { code, out, err } = await dienstLinux(["health-check"], host);
    expect(code).toBe(1);
    expect(out + err).toContain("ließ sich nicht prüfen");
    expect(out + err).toContain("Kein Timer eingerichtet");
    expect(host.calls).toEqual([]);
    expect(host.files.size).toBe(0);
  });

  test("health-check ohne systemd, pm2-CLI fehlt, Daemon führt den Nachtcheck: keine cron-Zeile dazu, Exit 1", async () => {
    const host = fakeLinuxHost({ noSystemd: true, pm2Missing: true, pm2Procs: ["tybo-health-check"] });
    const { code, out, err } = await dienstLinux(["health-check"], host);
    expect(code).toBe(1);
    expect(out + err).toContain("Keine cron-Zeile eingerichtet");
    expect(err).toContain("Nicht eingerichtet: health-check");
    expect(host.calls).toEqual([]);
    expect(host.healthSchedules()).toEqual(["pm2"]);
    host.reboot();
    expect(host.healthSchedules()).toEqual(["pm2"]);
  });

  test("health-check ohne systemd, pm2-CLI fehlt: Nachtcheck nur gesichert oder PM2-Zustand unklar, keine cron-Zeile, Exit 1", async () => {
    for (const options of [{ dump: ["tybo-health-check"] }, { daemon: "failed" as const }, { dumpUnreadable: true }]) {
      const host = fakeLinuxHost({ noSystemd: true, pm2Missing: true, ...options });
      const { code, out, err } = await dienstLinux(["health-check"], host);
      expect(code).toBe(1);
      expect(out + err).toContain("Keine cron-Zeile eingerichtet");
      expect(host.calls).toEqual([]);
      expect(host.crontab()).toBeNull();
    }
  });

  // Prüfer-Hinweise zu #568 (PR #645, Runde 3): gescheiterte Aktivierung und nur gesicherter PM2-Eintrag
  test("health-check mit systemd: restart des Timers scheitert, Timer dauerhaft zurückgenommen, nur der bisherige Zeitplan, auch nach Neustart", async () => {
    for (const [options, before] of [
      [{ pm2Procs: ["tybo-health-check", "tybo-telegram-relay"] }, "pm2"],
      [{ crontab: [OLD_HEALTH_CRON] }, "cron"],
    ] as const) {
      const host = fakeLinuxHost({ ...options, failRestart: true });
      const { code, out, err } = await dienstLinux(["health-check"], host);
      expect(code).toBe(1);
      expect(out + err).toContain("wieder abgeschaltet");
      expect(err).toContain("Nicht eingerichtet: health-check");
      expect(host.calls).toEqual([
        "systemctl daemon-reload",
        "systemctl enable tybo-health-check.timer",
        "systemctl restart tybo-health-check.timer",
        "systemctl disable --now tybo-health-check.timer",
      ]);
      expect(host.timer("tybo-health-check.timer")).toEqual({ enabled: false, active: false });
      expect(host.healthSchedules()).toEqual([before]);
      host.reboot();
      expect(host.timer("tybo-health-check.timer")).toEqual({ enabled: false, active: false });
      expect(host.healthSchedules()).toEqual([before]);
    }
  });

  test("health-check mit systemd: restart scheitert und Abschalten auch, Exit 1 und die Meldung sagt doppelt mit Befehl", async () => {
    const { code, out, err } = await dienstLinux(["health-check"], fakeLinuxHost({ crontab: [OLD_HEALTH_CRON], failRestart: true, failDisable: true }));
    expect(code).toBe(1);
    expect(out + err).toContain("doppelt");
    expect(out + err).toContain("systemctl --user disable --now tybo-health-check.timer");
  });

  test("health-check ohne systemd: Nachtcheck nur gesichert, cron-Zeilen nicht entfernbar; neuer PM2-Prozess heraus, aus der Sicherung gestrichen, fremde bleiben, nach Neustart nur cron", async () => {
    const host = fakeLinuxHost({ noSystemd: true, dump: ["tybo-health-check", "fremd-app"], crontab: [OLD_HEALTH_CRON], failCrontabWrite: true });
    const { code, out, err } = await dienstLinux(["health-check"], host);
    expect(code).toBe(1);
    expect(out + err).toContain("wieder aus PM2 entfernt");
    expect(out + err).toContain("aus der gesicherten Liste gestrichen");
    expect(host.calls).toEqual(["pm2 start tybo-health-check", "crontab -", "pm2 delete tybo-health-check"]);
    expect(host.dump()).toEqual(["fremd-app"]);
    expect(host.healthSchedules()).toEqual(["cron"]);
    host.reboot();
    expect(host.procs()).toEqual(["fremd-app"]);
    expect(host.healthSchedules()).toEqual(["cron"]);
  });

  test("health-check ohne systemd: Rücknahme bei unlesbarer Sicherung meldet den Doppellauf nach dem Neustart", async () => {
    const host = fakeLinuxHost({ noSystemd: true, dump: ["tybo-health-check"], dumpUnreadable: true, crontab: [OLD_HEALTH_CRON], failCrontabWrite: true });
    const { code, out, err } = await dienstLinux(["health-check"], host);
    expect(code).toBe(1);
    expect(out + err).toContain("liefe der Dienst doppelt");
  });

  test("bun run setup:services ist derselbe Befehl wie tybo dienste", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(pkg.scripts["setup:services"]).toBe("bun --no-env-file scripts/tybo.ts dienste");
  });
});

describe("Alias", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
  const script: string = pkg.scripts["setup:launchd"];

  test("bun run setup:launchd ruft tybo dienste, ohne .env des Arbeitsverzeichnisses", () => {
    expect(script).toBe("bun --no-env-file scripts/tybo.ts dienste");
  });

  // Argumente, die scripts/tybo.ts bei `bun run setup:launchd -- --service all`
  // bekommt: die aus dem Skript hinter scripts/tybo.ts, dann die des Aufrufs,
  // je nach Bun-Version mit oder ohne das trennende „--“
  const scriptArgs = script.split(" ").slice(script.split(" ").indexOf("scripts/tybo.ts") + 1);
  for (const callArgs of [["--", "--service", "all"], ["--service", "all"]]) {
    test(`bun run setup:launchd -- --service all (tybo.ts bekommt ${[...scriptArgs, ...callArgs].join(" ")}): wie tybo dienste all`, async () => {
      const root = projectDir();
      const fk = fakeLaunchd();
      const out: string[] = [];
      const err: string[] = [];
      const code = await runTybo({
        args: [...scriptArgs, ...callArgs],
        env: { TYBO_ROOT: root },
        platform: "darwin",
        out: l => out.push(l),
        err: l => err.push(l),
        services: fk.deps,
      });
      expect(err.join("\n")).toBe("");
      expect(code).toBe(0);
      expect(fk.calls).toEqual(ROUTINES_AND_BOT.map(l => `load ${l}`));
      expect([...fk.files.keys()].sort()).toEqual(ROUTINES_AND_BOT.map(l => `${AGENTS}/${l}.plist`).sort());
      expect(out.join("\n")).toContain("Übersprungen (nicht von tybo eingerichtet): whatsapp-gateway, cloudflare-tunnel");
    });
  }
});
