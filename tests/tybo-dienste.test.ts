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

/**
 * systemdBot: Unit-Datei des Bots liegt da. botUnit: Zustand laut systemctl
 * show, „loaded“ bzw. „running“ auch ohne Datei; „unreachable“: der
 * Benutzer-Manager antwortet nicht.
 */
function fakeLinuxHost(options: { pm2Missing?: boolean; failSave?: boolean; systemdBot?: boolean; botUnit?: "loaded" | "running" | "unreachable" } = {}) {
  const files = new Map<string, string>();
  if (options.systemdBot) files.set(`${UNITS}/tybo-telegram-relay.service`, "[Service]");
  const calls: string[] = [];
  const procs = new Set<string>();
  const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
  const timers: Partial<LinuxDeps> = {
    home: "/home/test",
    unitDir: UNITS,
    runDir: "/run/systemd/system",
    user: "alex",
    async run(cmd) {
      if (cmd[0] === "which") return ok(`/opt/bin/${cmd[1]}`);
      if (cmd[0] === "loginctl") return ok("yes");
      if (cmd[0] === "crontab") return { ok: false, stdout: "", stderr: "no crontab for alex" };
      if (cmd[0] !== "systemctl") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
      if (options.botUnit === "unreachable") return { ok: false, stdout: "", stderr: "Failed to connect to bus" };
      if (cmd[2] === "show" && cmd[3] === "tybo-telegram-relay.service") {
        if (options.botUnit === "loaded") return ok("LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled");
        if (options.botUnit === "running") return ok("LoadState=not-found\nActiveState=active\nUnitFileState=");
      }
      if (cmd[2] === "show") return ok("LoadState=not-found\nActiveState=inactive\nUnitFileState=");
      calls.push(`systemctl ${cmd.slice(2).join(" ")}`);
      return ok();
    },
    exists: p => p === "/run/systemd/system" || files.has(p),
    readFile: p => files.get(p) ?? "",
    writeFile: (p, c) => void files.set(p, c),
    remove: p => void files.delete(p),
    mkdir: () => {},
  };
  const pm2: Partial<Pm2Deps> = {
    async run(cmd) {
      if (cmd[0] !== "pm2") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
      if (cmd[1] === "--version") return options.pm2Missing ? { ok: false, stdout: "", stderr: "Befehl nicht gefunden", missing: true } : ok("6.0.0");
      if (cmd[1] === "jlist") return ok(JSON.stringify([...procs].map(name => ({ name }))));
      calls.push(`pm2 ${cmd[1]}${cmd[1] === "start" ? ` ${cmd[cmd.indexOf("--name") + 1]}` : ""}`);
      if (cmd[1] === "start") procs.add(cmd[cmd.indexOf("--name") + 1]);
      if (cmd[1] === "save" && options.failSave) return { ok: false, stdout: "", stderr: "x" };
      return ok();
    },
  };
  return { timers, pm2, files, calls };
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
      "pm2 save",
    ]);
    expect([...host.files.keys()].sort()).toEqual(
      ["tybo-morning-briefing.service", "tybo-morning-briefing.timer", "tybo-smart-checkin.service", "tybo-smart-checkin.timer"].map(f => `${UNITS}/${f}`),
    );
    expect(out).toContain("Richte 3 Dienste ein: telegram-relay, smart-checkin, morning-briefing");
    expect(out).toContain("pm2 startup");
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

  test("nur unter macOS: health-check und external einzeln verlangt, Exit 1 ohne Änderung", async () => {
    for (const service of ["health-check", "software-update", "cloudflare-tunnel"]) {
      const { code, err, host } = await dienstLinux([service]);
      expect(code).toBe(1);
      expect(err).toContain(service);
      expect(host.calls).toEqual([]);
    }
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
