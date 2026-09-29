/**
 * Issue #165, Checkbox 2: Dienst ai.tybo.supabase (launchd) bzw.
 * tybo-supabase (PM2) im Schritt Autostart, in der Deinstallation und in der
 * Gesamtprüfung. launchctl, PM2 und docker sind zustandsbehaftete Attrappen;
 * es läuft nie ein echter launchctl- oder PM2-Aufruf. Dateien nur im
 * Temp-Ordner.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { configureService, SERVICES as LAUNCHD_SERVICES, SUPABASE_UNLOAD_TIMEOUT_MS } from "../setup/configure-launchd";
import { ONCE_WRAPPER, SERVICES as PM2_SERVICES, SUPABASE_DELETE_TIMEOUT_MS } from "../setup/configure-services";
import { SUPABASE_LEFT_RUNNING, uninstallLaunchd, uninstallNames, uninstallPM2 } from "../setup/uninstall";
import { checkSupabaseService } from "../setup/verify";
import type { OnceState } from "../scripts/run-once-and-stay";
import type { CommandResult, CommandRunner } from "../src/setup/context";
import { PROJECT_ROOT } from "../src/setup/context";
import { LAUNCHD_EXIT_TIMEOUT_S, LOCAL_SUPABASE_URL, PM2_KILL_TIMEOUT_MS } from "../src/setup/local-supabase";
import { autostartStep, launchdDeps } from "../src/setup/steps/autostart";
import { ABORT_WORST_CASE_MS } from "./abort-worst-case";
import { launchdLabel, pm2Name, SUPABASE_SERVICE } from "../src/lib/service-names";
import { cleanup, FAKE, makeCtx } from "./setup-fixture";

afterAll(cleanup);

const BOT = "ai.tybo.telegram-relay";
const SUPA = "ai.tybo.supabase";
const LOCAL_ENV = `TELEGRAM_BOT_TOKEN=${FAKE.token}\nSUPABASE_URL=${LOCAL_SUPABASE_URL}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\n`;
const CLOUD_ENV = `TELEGRAM_BOT_TOKEN=${FAKE.token}\nSUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\n`;

const TEMPLATE = await readFile(join(PROJECT_ROOT, "launchd", `${SUPA}.plist.template`), "utf8");

// ---------------------------------------------------------------------------
// Vorlage
// ---------------------------------------------------------------------------

describe("Vorlage ai.tybo.supabase", () => {
  test("RunAtLoad, kein KeepAlive, Aufruf tybo datenbank start mit Bun, Log logs/supabase.log", () => {
    expect(TEMPLATE).toContain(`<string>${SUPA}</string>`);
    expect(TEMPLATE).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(TEMPLATE).not.toContain("KeepAlive");
    const args = [...TEMPLATE.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)![1].matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]);
    expect(args).toEqual(["{{BUN_PATH}}", "--no-env-file", "{{PROJECT_ROOT}}/scripts/tybo.ts", "datenbank", "start"]);
    expect(TEMPLATE).toContain("<string>{{PROJECT_ROOT}}/logs/supabase.log</string>");
    expect(TEMPLATE).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>\{\{EXIT_TIMEOUT\}\}<\/integer>/);
  });

  test("ExitTimeOut deckt den kontrollierten Abbruch im ungünstigsten Fall, launchctl unload wartet länger", () => {
    // launchd rechnet in ganzen Sekunden; ohne den Schlüssel 20 Sekunden
    expect(Number.isInteger(LAUNCHD_EXIT_TIMEOUT_S)).toBe(true);
    expect(LAUNCHD_EXIT_TIMEOUT_S * 1000).toBeGreaterThan(ABORT_WORST_CASE_MS);
    expect(LAUNCHD_EXIT_TIMEOUT_S * 1000).toBe(PM2_KILL_TIMEOUT_MS);
    expect(SUPABASE_UNLOAD_TIMEOUT_MS).toBeGreaterThan(LAUNCHD_EXIT_TIMEOUT_S * 1000);
  });

  test("PATH mit ~/.local/bin, ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin, ~/.orbstack/bin und Systempfaden", () => {
    const path = TEMPLATE.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)![1].split(":");
    for (const p of ["{{HOME}}/.local/bin", "{{HOME}}/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin", "{{HOME}}/.orbstack/bin", "/usr/bin", "/bin"]) expect(path).toContain(p);
    // launchd erweitert ~ nicht
    expect(path.some(p => p.includes("~"))).toBe(false);
  });

  test("in SERVICES beider Skripte und in service-names", () => {
    expect(SUPABASE_SERVICE).toBe("supabase");
    expect(launchdLabel(SUPABASE_SERVICE)).toBe(SUPA);
    expect(pm2Name(SUPABASE_SERVICE)).toBe("tybo-supabase");
    expect(LAUNCHD_SERVICES).toContain("supabase");
    expect(PM2_SERVICES).toContain("supabase");
  });
});

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

function launchctl(loaded: Set<string>, options: { failList?: boolean; failLoad?: Set<string> } = {}) {
  const calls: string[][] = [];
  const timeouts: Array<number | undefined> = [];
  const run = (async (cmd: string[], opts?: { timeoutMs?: number }): Promise<CommandResult> => {
    calls.push(cmd);
    timeouts.push(opts?.timeoutMs);
    if (cmd[0] === "which") return { code: 0, stdout: `/opt/tools/bin/${cmd[1]}`, stderr: "" };
    if (cmd[0] !== "launchctl") return { code: -1, stdout: "", stderr: "Befehl nicht gefunden" };
    if (cmd[1] === "list") {
      if (options.failList) return { code: 1, stdout: "", stderr: "x" };
      return { code: 0, stdout: [...loaded].map(l => `-\t0\t${l}`).join("\n"), stderr: "" };
    }
    const label = basename(cmd[2], ".plist");
    if (cmd[1] === "load") {
      if (options.failLoad?.has(label) || loaded.has(label)) return { code: 1, stdout: "", stderr: "x" };
      loaded.add(label);
    }
    if (cmd[1] === "unload") loaded.delete(label);
    return { code: 0, stdout: "", stderr: "" };
  }) as CommandRunner & { calls: string[][]; timeouts: Array<number | undefined> };
  run.calls = calls;
  run.timeouts = timeouts;
  return run;
}

async function macCtx(env: string, loaded = new Set<string>(), options: Parameters<typeof launchctl>[1] = {}) {
  const run = launchctl(loaded, options);
  const ctx = await makeCtx({ env, overrides: { run } });
  for (const label of [BOT, SUPA]) await copyFile(join(PROJECT_ROOT, "launchd", `${label}.plist.template`), join(ctx.root, "launchd", `${label}.plist.template`));
  await mkdir(ctx.launchAgentsDir, { recursive: true });
  return { ctx, run, loaded };
}

const changes = (run: { calls: string[][] }) => run.calls.filter(c => c[0] === "launchctl" && c[1] !== "list").map(c => `${c[1]} ${basename(c[2])}`);

describe("tybo setup autostart mit Supabase auf diesem Rechner (macOS)", () => {
  test("legt ai.tybo.supabase an: absolute Pfade, RunAtLoad, kein KeepAlive; eigene Statuszeile; Wiederholung ändert nichts", async () => {
    const { ctx, run } = await macCtx(LOCAL_ENV);
    const before = await autostartStep.status(ctx);
    expect(before.state).toBe("fehlt");
    expect(before.items?.map(i => i.label)).toEqual(["tybo-Autostart", "Supabase-Autostart"]);

    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Autostart eingerichtet: tybo läuft jetzt");
    expect(r.message).toContain("Supabase-Autostart eingerichtet");
    expect(r.changed).toEqual([join(ctx.launchAgentsDir, `${BOT}.plist`), join(ctx.launchAgentsDir, `${SUPA}.plist`)]);
    expect(changes(run)).toEqual([`load ${BOT}.plist`, `load ${SUPA}.plist`]);

    const plist = await readFile(join(ctx.launchAgentsDir, `${SUPA}.plist`), "utf8");
    expect(plist).not.toContain("{{");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).toContain(`<string>/opt/tools/bin/bun</string>`);
    expect(plist).toContain(`<string>${ctx.root}/scripts/tybo.ts</string>`);
    const path = plist.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)![1].split(":");
    expect(path).toContain(`${ctx.home}/.local/bin`);
    expect(path).toContain(`${ctx.home}/.orbstack/bin`);
    expect(path.every(p => p.startsWith("/"))).toBe(true);
    // Frist beim Entladen in Sekunden, gerendert aus LAUNCHD_EXIT_TIMEOUT_S
    expect(plist).toMatch(new RegExp(`<key>ExitTimeOut</key>\\s*<integer>${LAUNCHD_EXIT_TIMEOUT_S}</integer>`));
    // launchd legt den Log-Ordner nicht an
    expect((await readdir(ctx.root)).includes("logs")).toBe(true);

    const after = await autostartStep.status(ctx);
    expect(after.state).toBe("erledigt");
    expect(after.items?.every(i => i.ok)).toBe(true);
    const again = await autostartStep.apply!({}, ctx);
    expect(again.message).toBe("Autostart ist schon eingerichtet, nichts geändert. Supabase-Autostart ist schon eingerichtet, nichts geändert.");
    expect(changes(run)).toEqual([`load ${BOT}.plist`, `load ${SUPA}.plist`]);
  });

  test("Bot schon eingerichtet: Supabase-Dienst wird trotzdem angelegt, der Bot bleibt unberührt", async () => {
    const loaded = new Set<string>();
    const first = await macCtx(CLOUD_ENV, loaded);
    expect((await autostartStep.apply!({}, first.ctx)).ok).toBe(true);
    const botPlist = await readFile(join(first.ctx.launchAgentsDir, `${BOT}.plist`), "utf8");
    // Jetzt auf Supabase lokal umgestellt
    await writeFile(first.ctx.envPath, LOCAL_ENV);
    first.run.calls.length = 0;
    expect((await autostartStep.status(first.ctx)).state).toBe("teilweise");
    const r = await autostartStep.apply!({}, first.ctx);
    expect(r.ok).toBe(true);
    expect(changes(first.run)).toEqual([`load ${SUPA}.plist`]);
    expect(await readFile(join(first.ctx.launchAgentsDir, `${BOT}.plist`), "utf8")).toBe(botPlist);
    expect(r.changed).toEqual([join(first.ctx.launchAgentsDir, `${SUPA}.plist`)]);
  });

  test("Cloud-Adresse: kein Supabase-Dienst, Meldung und Status wie bisher", async () => {
    const { ctx, run } = await macCtx(CLOUD_ENV);
    const status = await autostartStep.status(ctx);
    expect(status.items).toBeUndefined();
    const r = await autostartStep.apply!({}, ctx);
    expect(r).toEqual({ ok: true, message: "Autostart eingerichtet: tybo läuft jetzt und startet mit dem Rechner.", changed: [join(ctx.launchAgentsDir, `${BOT}.plist`)] });
    expect(changes(run)).toEqual([`load ${BOT}.plist`]);
    expect(await readdir(ctx.launchAgentsDir)).toEqual([`${BOT}.plist`]);
  });

  test("Convex aktiv (trotz lokaler SUPABASE_URL): kein Supabase-Dienst", async () => {
    const { ctx } = await macCtx(`${LOCAL_ENV}CONVEX_URL=${FAKE.convexUrl}\n`);
    await autostartStep.apply!({}, ctx);
    expect(await readdir(ctx.launchAgentsDir)).toEqual([`${BOT}.plist`]);
  });

  test("geänderte Plist: launchctl unload ai.tybo.supabase mit Zeitgrenze über ExitTimeOut, danach neu geladen", async () => {
    const loaded = new Set([SUPA]);
    const { ctx, run } = await macCtx(LOCAL_ENV, loaded);
    // alte Fassung ohne ExitTimeOut, geladen
    await writeFile(join(ctx.launchAgentsDir, `${SUPA}.plist`), "<plist/>");
    const log: string[] = [];
    expect(await configureService("supabase", launchdDeps(ctx, log))).toBe(true);
    const i = run.calls.findIndex(c => c[1] === "unload");
    expect(basename(run.calls[i][2])).toBe(`${SUPA}.plist`);
    expect(run.timeouts[i]).toBe(SUPABASE_UNLOAD_TIMEOUT_MS);
    expect(changes(run)).toEqual([`unload ${SUPA}.plist`, `load ${SUPA}.plist`]);
    expect(await readFile(join(ctx.launchAgentsDir, `${SUPA}.plist`), "utf8")).toContain("<key>ExitTimeOut</key>");
  });

  test("Laden des Supabase-Diensts scheitert: ehrlich, Bot trotzdem eingerichtet, Wiederholung lädt nur Supabase", async () => {
    const loaded = new Set<string>();
    const failLoad = new Set([SUPA]);
    const { ctx, run } = await macCtx(LOCAL_ENV, loaded, { failLoad });
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Supabase-Autostart ließ sich nicht einrichten: launchctl konnte den Dienst nicht laden.");
    expect(loaded.has(BOT)).toBe(true);
    expect((await autostartStep.status(ctx)).state).toBe("teilweise");
    failLoad.clear();
    run.calls.length = 0;
    expect((await autostartStep.apply!({}, ctx)).ok).toBe(true);
    expect(changes(run)).toEqual([`load ${SUPA}.plist`]);
  });
});

// ---------------------------------------------------------------------------
// PM2
// ---------------------------------------------------------------------------

type Proc = { status: string; args?: string[] };

/**
 * PM2-Attrappe mit den Regeln aus PM2 (geprüft mit echtem PM2 in
 * scripts/pm2-autostart-proof.ts): ein Prozess ohne die Hülle, gestartet mit
 * --no-autorestart, läuft einmal und steht danach auf „stopped“; mit der
 * Hülle bleibt er nach dem einen Lauf „online“. pm2 save sichert Name, Status
 * und Argumente in dump.pm2. boot() stellt das Hochfahren nach (pm2 resurrect):
 * nur gespeicherte „online“-Einträge laufen, „stopped“ wird nur eingetragen.
 * starts zählt die Läufe von tybo datenbank start, deleteTimeouts die
 * Zeitgrenzen der pm2-delete-Aufrufe.
 */
function pm2(procs: Map<string, Proc>, dumpPath: () => string) {
  const calls: string[][] = [];
  const starts = new Map<string, number>();
  const deleteTimeouts: Array<number | undefined> = [];
  const launch = (name: string, args: string[], autorestart: boolean): Proc => {
    const once = args.includes("datenbank");
    if (once) starts.set(name, (starts.get(name) ?? 0) + 1);
    // Einmalaufruf ohne Hülle endet nach dem Lauf; die Hülle bleibt stehen
    const ends = once && !autorestart && !args.some(a => a.endsWith(ONCE_WRAPPER));
    return { status: ends ? "stopped" : "online", args };
  };
  const run = (async (cmd: string[], options?: { timeoutMs?: number }): Promise<CommandResult> => {
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (cmd[0] !== "pm2") return { code: -1, stdout: "", stderr: "Befehl nicht gefunden" };
    calls.push(cmd);
    if (cmd[1] === "--version") return ok("7.0.4");
    if (cmd[1] === "jlist") return ok(JSON.stringify([...procs].map(([name, env]) => ({ name, pm2_env: env }))));
    if (cmd[1] === "start") {
      const name = cmd[cmd.indexOf("--name") + 1];
      const args = cmd.slice(cmd.indexOf("--") + 1);
      procs.set(name, launch(name, args, !cmd.includes("--no-autorestart")));
      return ok();
    }
    if (cmd[1] === "delete") deleteTimeouts.push(options?.timeoutMs);
    if (cmd[1] === "delete") return procs.delete(cmd[2]) ? ok() : { code: 1, stdout: "", stderr: "not found" };
    if (cmd[1] === "save") {
      await mkdir(dirname(dumpPath()), { recursive: true });
      await writeFile(dumpPath(), JSON.stringify([...procs].map(([name, env]) => ({ name, status: env.status, args: env.args, autorestart: false }))));
      return ok();
    }
    return { code: -1, stdout: "", stderr: "?" };
  }) as CommandRunner;
  /** Hochfahren: Prozesse weg, dann pm2 resurrect aus dump.pm2 */
  const boot = async () => {
    const dump = JSON.parse(await readFile(dumpPath(), "utf8")) as Array<{ name: string; status: string; args?: string[] }>;
    procs.clear();
    for (const e of dump) procs.set(e.name, e.status === "online" ? launch(e.name, e.args ?? [], false) : { status: e.status, args: e.args });
  };
  return { run, calls, starts, boot, deleteTimeouts };
}

async function linuxCtx(env: string, procs = new Map<string, Proc>()) {
  let dump = "";
  const fake = pm2(procs, () => dump);
  const ctx = await makeCtx({ env, overrides: { platform: "linux", run: fake.run } });
  dump = ctx.pm2DumpPath;
  return { ctx, calls: fake.calls, procs, starts: fake.starts, boot: fake.boot, deleteTimeouts: fake.deleteTimeouts };
}

const WRAPPED = (root: string) => ["--no-env-file", join(root, ONCE_WRAPPER), "--state", join(root, "data", "supabase-start.json"), join(root, "scripts", "tybo.ts"), "datenbank", "start"];

describe("tybo setup autostart mit Supabase auf diesem Rechner (PM2)", () => {
  test("Frist beim Beenden deckt den kontrollierten Abbruch im ungünstigsten Fall, pm2 delete wartet länger", () => {
    expect(PM2_KILL_TIMEOUT_MS).toBeGreaterThan(ABORT_WORST_CASE_MS);
    expect(SUPABASE_DELETE_TIMEOUT_MS).toBeGreaterThan(PM2_KILL_TIMEOUT_MS);
  });


  test("tybo-supabase: PM2-Optionen samt --no-autorestart vor „--“, danach Hülle und tybo datenbank start; pm2 save", async () => {
    const { ctx, calls, procs } = await linuxCtx(LOCAL_ENV);
    const r = await autostartStep.apply!({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual(["pm2:tybo-telegram-relay", "pm2:tybo-supabase"]);
    const start = calls.find(c => c[1] === "start" && c.includes("tybo-supabase"))!;
    const sep = start.indexOf("--");
    expect(start.slice(0, sep)).toEqual([
      "pm2", "start", "bun", "--name", "tybo-supabase", "--no-autorestart", "--kill-timeout", String(PM2_KILL_TIMEOUT_MS),
      "--output", join(ctx.root, "logs", "supabase.log"), "--error", join(ctx.root, "logs", "supabase.log"), "--merge-logs",
    ]);
    expect(start.slice(sep + 1)).toEqual(WRAPPED(ctx.root));
    const dump = JSON.parse(await readFile(ctx.pm2DumpPath, "utf8"));
    expect(dump.map((p: any) => `${p.name}=${p.status}`).sort()).toEqual(["tybo-supabase=online", "tybo-telegram-relay=online"]);
    expect(procs.get("tybo-supabase")?.status).toBe("online");
    // Hinweis auf pm2 startup nur einmal
    expect(r.message.split("pm2 startup").length - 1).toBe(1);
    expect((await autostartStep.status(ctx)).state).toBe("erledigt");
    calls.length = 0;
    expect((await autostartStep.apply!({}, ctx)).ok).toBe(true);
    expect(calls.filter(c => c[1] === "start" || c[1] === "delete")).toEqual([]);
  });

  test("pm2 save nach Ende des Supabase-Starts, dann Hochfahren: genau ein Start, keine Wiederholung", async () => {
    const { ctx, starts, boot, procs, calls } = await linuxCtx(LOCAL_ENV);
    expect((await autostartStep.apply!({}, ctx)).ok).toBe(true);
    expect(starts.get("tybo-supabase")).toBe(1);
    // später, nach dem Ende von tybo datenbank start, speichert jemand erneut
    await ctx.run(["pm2", "save"]);
    await boot();
    expect(starts.get("tybo-supabase")).toBe(2);
    expect(procs.get("tybo-supabase")?.status).toBe("online");
    // noch ein save und ein Hochfahren: wieder genau einer
    await ctx.run(["pm2", "save"]);
    await boot();
    expect(starts.get("tybo-supabase")).toBe(3);
    // der Bot läuft nach dem Hochfahren wie gewohnt, ohne Supabase-Lauf
    expect(procs.get("tybo-telegram-relay")?.status).toBe("online");
    expect(starts.has("tybo-telegram-relay")).toBe(false);
  });

  test("Gegenprobe der Attrappe: ein als „stopped“ gespeicherter Einmalaufruf startet beim Hochfahren nicht", async () => {
    const { ctx, starts, boot, procs } = await linuxCtx(LOCAL_ENV);
    await ctx.run(["pm2", "start", "bun", "--name", "tybo-supabase", "--no-autorestart", "--", "--no-env-file", join(ctx.root, "scripts", "tybo.ts"), "datenbank", "start"]);
    expect(procs.get("tybo-supabase")?.status).toBe("stopped");
    await ctx.run(["pm2", "save"]);
    await boot();
    expect(starts.get("tybo-supabase")).toBe(1);
    expect(procs.get("tybo-supabase")?.status).toBe("stopped");
  });

  const OLD_ARGS = ["--no-env-file", "/alt/scripts/tybo.ts", "datenbank", "start"];
  for (const [label, proc, dumpStatus, args] of [
    ["gestoppt (pm2 stop) und so gespeichert", { status: "stopped" }, "stopped", OLD_ARGS],
    ["in alter Form ohne Hülle eingetragen", { status: "stopped" }, "online", OLD_ARGS],
    ["läuft ohne Hülle (alte Form, Start noch nicht zu Ende)", { status: "online" }, "online", OLD_ARGS],
    ["läuft mit Hülle, aber ohne --state (Ergebnis des Starts nicht lesbar)", { status: "online" }, "online", ["--no-env-file", `/alt/${ONCE_WRAPPER}`, "/alt/scripts/tybo.ts", "datenbank", "start"]],
  ] as const) {
    test(`tybo-supabase ${label}: Status „teilweise“, Einrichten trägt die Hülle neu ein, Hochfahren startet genau einmal`, async () => {
      const procs = new Map<string, Proc>([
        ["tybo-telegram-relay", { status: "online", args: ["run", "src/bot.ts"] }],
        ["tybo-supabase", { ...proc, args: [...args] }],
      ]);
      const { ctx, starts, boot, calls, deleteTimeouts } = await linuxCtx(LOCAL_ENV, procs);
      await mkdir(dirname(ctx.pm2DumpPath), { recursive: true });
      await writeFile(ctx.pm2DumpPath, JSON.stringify([...procs].map(([name, env]) => ({ name, status: name === "tybo-supabase" ? dumpStatus : env.status, args: env.args }))));
      const status = await autostartStep.status(ctx);
      const item = status.items?.find(i => i.label === "Supabase-Autostart")!;
      expect(item.ok).toBe(false);
      expect(status.state).not.toBe("erledigt");
      const r = await autostartStep.apply!({}, ctx);
      expect(r.ok).toBe(true);
      expect(r.changed).toEqual(["pm2:tybo-supabase"]);
      // der Bot bleibt unberührt
      expect(calls.filter(c => c[1] === "delete").map(c => c[2])).toEqual(["tybo-supabase"]);
      // pm2 delete wartet, bis ein laufender Start kontrolliert beendet ist
      expect(deleteTimeouts).toEqual([SUPABASE_DELETE_TIMEOUT_MS]);
      expect(calls.filter(c => c[1] === "start").map(c => c.slice(c.indexOf("--") + 1))).toEqual([WRAPPED(ctx.root)]);
      expect((await autostartStep.status(ctx)).state).toBe("erledigt");
      const before = starts.get("tybo-supabase") ?? 0;
      await ctx.run(["pm2", "save"]);
      await boot();
      expect(starts.get("tybo-supabase")).toBe(before + 1);
    });
  }

  test("läuft mit Hülle, in dump.pm2 aber als „stopped“: nur speichern, kein Neustart", async () => {
    const { ctx, calls, procs } = await linuxCtx(LOCAL_ENV);
    expect((await autostartStep.apply!({}, ctx)).ok).toBe(true);
    const dump = JSON.parse(await readFile(ctx.pm2DumpPath, "utf8"));
    await writeFile(ctx.pm2DumpPath, JSON.stringify(dump.map((p: any) => (p.name === "tybo-supabase" ? { ...p, status: "stopped" } : p))));
    expect((await autostartStep.status(ctx)).state).not.toBe("erledigt");
    calls.length = 0;
    expect((await autostartStep.apply!({}, ctx)).ok).toBe(true);
    expect(calls.filter(c => c[1] === "start" || c[1] === "delete")).toEqual([]);
    expect(calls.some(c => c[1] === "save")).toBe(true);
    expect(procs.get("tybo-supabase")?.status).toBe("online");
    expect((await autostartStep.status(ctx)).state).toBe("erledigt");
  });

  test("Bot schon gespeichert: nur tybo-supabase wird gestartet und gespeichert", async () => {
    const first = await linuxCtx(CLOUD_ENV);
    expect((await autostartStep.apply!({}, first.ctx)).ok).toBe(true);
    await writeFile(first.ctx.envPath, LOCAL_ENV);
    first.calls.length = 0;
    const r = await autostartStep.apply!({}, first.ctx);
    expect(r.ok).toBe(true);
    const starts = first.calls.filter(c => c[1] === "start").map(c => c[c.indexOf("--name") + 1]);
    expect(starts).toEqual(["tybo-supabase"]);
    expect(first.calls.some(c => c[1] === "delete")).toBe(false);
    expect(first.procs.get("tybo-telegram-relay")?.status).toBe("online");
  });

  test("Cloud: kein tybo-supabase", async () => {
    const { ctx, procs } = await linuxCtx(CLOUD_ENV);
    await autostartStep.apply!({}, ctx);
    expect([...procs.keys()]).toEqual(["tybo-telegram-relay"]);
  });
});

// ---------------------------------------------------------------------------
// Deinstallation
// ---------------------------------------------------------------------------

describe("Deinstallation", () => {
  async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      return { value: await fn(), lines };
    } finally {
      console.log = log;
    }
  }

  test("launchd: entlädt und löscht ai.tybo.supabase mit, nennt tybo datenbank stop, fremde Dienste bleiben", async () => {
    const ctx = await makeCtx();
    await mkdir(ctx.launchAgentsDir, { recursive: true });
    for (const f of [`${BOT}.plist`, `${SUPA}.plist`, "com.example.other.plist"]) await writeFile(join(ctx.launchAgentsDir, f), "<plist/>");
    const calls: string[][] = [];
    const { lines } = await quiet(() =>
      uninstallLaunchd(ctx.launchAgentsDir, async cmd => {
        calls.push(cmd);
        return { ok: true, stdout: "", stderr: "" };
      })
    );
    expect(calls.map(c => `${c[1]} ${basename(c[2])}`).sort()).toEqual([`unload ${BOT}.plist`, `unload ${SUPA}.plist`].sort());
    expect(await readdir(ctx.launchAgentsDir)).toEqual(["com.example.other.plist"]);
    expect(lines.join("\n")).toContain(SUPABASE_LEFT_RUNNING);
    expect(SUPABASE_LEFT_RUNNING).toContain("tybo datenbank stop");
    // Nie docker oder supabase stop: die Daten bleiben
    expect(calls.every(c => c[0] === "launchctl")).toBe(true);
  });

  test("PM2: tybo-supabase wird mit entfernt", async () => {
    expect(uninstallNames()).toContain("tybo-supabase");
    const calls: string[][] = [];
    const { lines } = await quiet(() =>
      uninstallPM2(async cmd => {
        calls.push(cmd);
        return { ok: true, stdout: "[]", stderr: "" };
      })
    );
    expect(calls).toContainEqual(["npx", "pm2", "delete", "tybo-supabase"]);
    expect(lines.join("\n")).toContain(SUPABASE_LEFT_RUNNING);
  });
});

// ---------------------------------------------------------------------------
// Gesamtprüfung
// ---------------------------------------------------------------------------

describe("verify: Supabase-Dienst und Datenbank", () => {
  type Rec = { name: string; status: string; message: string };
  async function verify(platform: NodeJS.Platform, answers: Record<string, { ok: boolean; stdout: string }>, url = LOCAL_SUPABASE_URL, state: string | null = null) {
    const records: Rec[] = [];
    const calls: string[][] = [];
    await checkSupabaseService(
      platform,
      { SUPABASE_URL: url },
      async cmd => {
        calls.push(cmd);
        const key = cmd[0] === "npx" ? "pm2" : cmd[0];
        const a = answers[key] ?? { ok: false, stdout: "" };
        return { ...a, stderr: "" };
      },
      (name, status, message) => records.push({ name, status, message }),
      () => state
    );
    return { records, calls };
  }
  const DB_UP = { ok: true, stdout: "supabase_kong_tybo\nsupabase_db_tybo" };

  test("launchd: beendeter Einmalaufruf (Exit 0) ist Erfolg, Datenbank läuft", async () => {
    const { records } = await verify("darwin", { launchctl: { ok: true, stdout: `-\t0\t${SUPA}\n123\t0\t${BOT}` }, docker: DB_UP });
    expect(records.map(r => r.status)).toEqual(["pass", "pass"]);
    expect(records[0].message).toContain("Exit 0");
  });

  test("launchd: Einmalaufruf erfolgreich, aber Container läuft nicht: Fehler bei der Datenbank", async () => {
    const { records } = await verify("darwin", { launchctl: { ok: true, stdout: `-\t0\t${SUPA}` }, docker: { ok: true, stdout: "" } });
    expect(records.map(r => r.status)).toEqual(["pass", "fail"]);
    expect(records[1].message).toContain("tybo datenbank start");
  });

  test("launchd: letzter Aufruf mit Exit 1: Warnung mit Log", async () => {
    const { records } = await verify("darwin", { launchctl: { ok: true, stdout: `-\t1\t${SUPA}` }, docker: DB_UP });
    expect(records[0]).toMatchObject({ status: "warn" });
    expect(records[0].message).toContain("logs/supabase.log");
  });

  test("launchd: nicht eingerichtet: Warnung", async () => {
    const { records } = await verify("darwin", { launchctl: { ok: true, stdout: `123\t0\t${BOT}` }, docker: DB_UP });
    expect(records[0]).toMatchObject({ status: "warn" });
  });

  const ONLINE = { pm2: { ok: true, stdout: JSON.stringify([{ name: "tybo-supabase", pid: 4242, pm2_env: { status: "online" } }]) }, docker: DB_UP };
  const stateOf = (s: OnceState) => JSON.stringify(s);

  test("PM2: online (Hülle steht) und Start mit Exit 0 ist Erfolg; stopped, auch mit Exit 0, und errored sind Warnungen", async () => {
    const ok = await verify("linux", ONLINE, LOCAL_SUPABASE_URL, stateOf({ pid: 4242, state: "beendet", exitCode: 0 }));
    expect(ok.records.map(r => r.status)).toEqual(["pass", "pass"]);
    expect(ok.records[0].message).toContain("Exit 0");
    const running = await verify("linux", ONLINE, LOCAL_SUPABASE_URL, stateOf({ pid: 4242, state: "läuft" }));
    expect(running.records[0]).toMatchObject({ status: "pass" });
    expect(running.records[0].message).toContain("startet gerade");
    for (const env of [{ status: "stopped", exit_code: 0 }, { status: "errored", exit_code: 1 }]) {
      const bad = await verify("linux", { pm2: { ok: true, stdout: JSON.stringify([{ name: "tybo-supabase", pm2_env: env }]) }, docker: DB_UP });
      expect(bad.records[0].status).toBe("warn");
      expect(bad.records[0].message).toContain("tybo setup autostart");
    }
  });

  test("PM2: Start gescheitert (Exit 1, etwa Edge Runtime fehlt und Neustart-Stopp scheitert), Datenbank-Container läuft weiter: Warnung statt Erfolg", async () => {
    const { records } = await verify("linux", ONLINE, LOCAL_SUPABASE_URL, stateOf({ pid: 4242, state: "beendet", exitCode: 1 }));
    expect(records.map(r => `${r.name}=${r.status}`)).toEqual(["supabase (Autostart)=warn", "supabase (Datenbank)=pass"]);
    expect(records[0].message).toContain("Letzter Start fehlgeschlagen (Exit 1)");
    expect(records[0].message).toContain("logs/supabase.log");
    expect(records[0].message).toContain("tybo datenbank start");
  });

  test("PM2: online, aber keine, unlesbare oder fremde Zustandsdatei (andere PID, etwa vom letzten Hochfahren): Warnung, kein Erfolg", async () => {
    for (const state of [null, "{kaputt", stateOf({ pid: 1, state: "beendet", exitCode: 0 })]) {
      const { records } = await verify("linux", ONLINE, LOCAL_SUPABASE_URL, state);
      expect(records[0]).toMatchObject({ status: "warn" });
      expect(records[0].message).toContain("tybo setup autostart");
    }
  });

  test("Cloud-Adresse: keine Prüfung, kein Befehl", async () => {
    const { records, calls } = await verify("darwin", {}, FAKE.supabaseUrl);
    expect(records).toEqual([]);
    expect(calls).toEqual([]);
  });
});
