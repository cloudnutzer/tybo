/**
 * Issue #370: Dauerdienste unter PM2 (src/setup/services/pm2.ts). PM2 ist
 * eine zustandsbehaftete Attrappe; es läuft kein echter PM2-Aufruf und kein
 * Bot. Festgehalten ist das Verhalten des Vorgängers
 * setup/configure-services.ts plus die beiden Korrekturen aus der Prüfung:
 * Protokoll-Optionen stehen vor „--“, und die echte Ausführung beachtet
 * die Frist je Aufruf.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  configurePM2Service,
  ONCE_WRAPPER,
  PM2_COMMAND_TIMEOUT_MS,
  pm2FailureMessage,
  pm2ProcessNames,
  pm2StartCommand,
  realPm2Deps,
  savePm2,
  SUPABASE_DELETE_TIMEOUT_MS,
  SUPABASE_PM2_OPTIONS,
  type Pm2Deps,
} from "../src/setup/services/pm2";
import { PM2_KILL_TIMEOUT_MS } from "../src/setup/local-supabase";
import { oldPm2Name } from "./old-names";

const ROOT = "/projekt";
const BOT = "tybo-telegram-relay";
const SUPA = "tybo-supabase";
const FOREIGN = ["andere-app", oldPm2Name("telegram-relay")];

interface FakeOptions {
  jlist?: string;
  jlistFails?: boolean;
  failDelete?: boolean;
  failStart?: boolean;
  failSave?: boolean;
}

function fakePm2(running: string[], options: FakeOptions = {}) {
  const procs = new Set(running);
  const calls: string[][] = [];
  const timeouts: Array<number | undefined> = [];
  const lines: string[] = [];
  let saved: string[] | null = null;
  const deps: Pm2Deps = {
    projectRoot: ROOT,
    pm2: ["pm2"],
    log: line => lines.push(line),
    async run(cmd, opts) {
      if (cmd[0] !== "pm2") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
      calls.push(cmd);
      timeouts.push(opts?.timeoutMs);
      const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
      const bad = { ok: false, stdout: "", stderr: "GEHEIM=xyz" };
      switch (cmd[1]) {
        case "jlist":
          if (options.jlistFails) return bad;
          return ok(options.jlist ?? JSON.stringify([...procs].map(name => ({ name, pm2_env: { status: "online" } }))));
        case "delete":
          if (options.failDelete || !procs.has(cmd[2])) return bad;
          procs.delete(cmd[2]);
          return ok();
        case "start":
          if (options.failStart) return bad;
          procs.add(cmd[cmd.indexOf("--name") + 1]);
          return ok();
        case "save":
          if (options.failSave) return bad;
          saved = [...procs];
          return ok();
      }
      throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
    },
  };
  const verbs = () => calls.map(c => (c[1] === "start" ? `start ${c[c.indexOf("--name") + 1]}` : c.slice(1, 3).join(" ")));
  return { deps, procs, calls, verbs, timeouts, lines, saved: () => saved };
}

describe("pm2StartCommand", () => {
  test("Bot: alle PM2-Optionen vor „--“, dahinter nur bun run <Einstieg>", () => {
    const cmd = pm2StartCommand("telegram-relay", ROOT, ["pm2"]);
    const sep = cmd.indexOf("--");
    const log = join(ROOT, "logs", "telegram-relay.log");
    expect(cmd.slice(0, sep)).toEqual(["pm2", "start", "bun", "--name", BOT, "--output", log, "--error", log, "--merge-logs"]);
    expect(cmd.slice(sep + 1)).toEqual(["run", join(ROOT, "src", "bot.ts")]);
  });

  test("Supabase: --no-autorestart und Frist, Hülle mit --state, dann tybo datenbank start", () => {
    const cmd = pm2StartCommand("supabase", ROOT, ["pm2"]);
    const sep = cmd.indexOf("--");
    const log = join(ROOT, "logs", "supabase.log");
    expect(cmd.slice(0, sep)).toEqual(["pm2", "start", "bun", "--name", SUPA, ...SUPABASE_PM2_OPTIONS, "--output", log, "--error", log, "--merge-logs"]);
    expect(cmd.slice(sep + 1)).toEqual([
      "--no-env-file",
      join(ROOT, ONCE_WRAPPER),
      "--state",
      join(ROOT, "data", "supabase-start.json"),
      join(ROOT, "scripts", "tybo.ts"),
      "datenbank",
      "start",
    ]);
    expect(SUPABASE_PM2_OPTIONS).toEqual(["--no-autorestart", "--kill-timeout", String(PM2_KILL_TIMEOUT_MS)]);
  });

  test("Projektordner mit $& bleibt Zeichen für Zeichen", () => {
    const root = "/a/$&b";
    expect(pm2StartCommand("supabase", root, ["pm2"])).toContain(`${root}/scripts/tybo.ts`);
  });
});

describe("configurePM2Service", () => {
  test("startet tybo-telegram-relay, wenn er fehlt", async () => {
    const pm2 = fakePm2([]);
    expect(await configurePM2Service("telegram-relay", pm2.deps)).toEqual({ ok: true, service: "telegram-relay", name: BOT, replaced: false });
    expect(pm2.verbs()).toEqual(["jlist", `start ${BOT}`]);
    expect([...pm2.procs]).toEqual([BOT]);
  });

  test("vorhandener Eintrag: erst delete, dann start; genau ein Prozess", async () => {
    const pm2 = fakePm2([BOT]);
    const outcome = await configurePM2Service("telegram-relay", pm2.deps);
    expect(outcome.ok && outcome.replaced).toBe(true);
    expect(pm2.verbs()).toEqual(["jlist", `delete ${BOT}`, `start ${BOT}`]);
    expect([...pm2.procs]).toEqual([BOT]);
  });

  test("fremde Namen bleiben unberührt", async () => {
    const pm2 = fakePm2([...FOREIGN]);
    expect((await configurePM2Service("telegram-relay", pm2.deps)).ok).toBe(true);
    expect(pm2.calls.some(c => FOREIGN.some(name => c.includes(name)))).toBe(false);
    expect([...pm2.procs].sort()).toEqual([...FOREIGN, BOT].sort());
  });

  test("Liste unlesbar (kein JSON, keine Liste, Fehlschlag): kein delete, kein start", async () => {
    for (const options of [{ jlist: "kaputt" }, { jlist: '{"name":"x"}' }, { jlistFails: true }]) {
      const pm2 = fakePm2([BOT], options);
      expect(await pm2ProcessNames(pm2.deps)).toBeNull();
      expect(await configurePM2Service("telegram-relay", pm2.deps)).toEqual({ ok: false, service: "telegram-relay", name: BOT, failure: "list-unreadable" });
      expect(pm2.verbs()).toEqual(["jlist", "jlist"]);
      expect([...pm2.procs]).toEqual([BOT]);
    }
  });

  test("delete scheitert: kein start; ein zweiter Versuch gelingt danach", async () => {
    const options: FakeOptions = { failDelete: true };
    const pm2 = fakePm2([BOT], options);
    const outcome = await configurePM2Service("telegram-relay", pm2.deps);
    expect(outcome.ok ? null : outcome.failure).toBe("delete-failed");
    expect(pm2.verbs().some(v => v.startsWith("start"))).toBe(false);
    options.failDelete = false;
    expect((await configurePM2Service("telegram-relay", pm2.deps)).ok).toBe(true);
    expect([...pm2.procs]).toEqual([BOT]);
  });

  test("start scheitert: Fehlerart start-failed, Meldung ohne stderr von PM2", async () => {
    const pm2 = fakePm2([], { failStart: true });
    const outcome = await configurePM2Service("telegram-relay", pm2.deps);
    expect(outcome.ok ? null : outcome.failure).toBe("start-failed");
    expect(pm2.lines.join("\n")).not.toContain("GEHEIM");
    expect(pm2.lines.join("\n")).toContain(pm2FailureMessage("start-failed", "telegram-relay"));
  });

  test("delete von tybo-supabase bekommt die lange Frist, der Bot die normale", async () => {
    const supa = fakePm2([SUPA]);
    expect((await configurePM2Service("supabase", supa.deps)).ok).toBe(true);
    expect(supa.timeouts[supa.verbs().indexOf(`delete ${SUPA}`)]).toBe(SUPABASE_DELETE_TIMEOUT_MS);
    expect(SUPABASE_DELETE_TIMEOUT_MS).toBeGreaterThan(PM2_KILL_TIMEOUT_MS);
    const bot = fakePm2([BOT]);
    await configurePM2Service("telegram-relay", bot.deps);
    expect(bot.timeouts[bot.verbs().indexOf(`delete ${BOT}`)]).toBeUndefined();
  });

  test("Meldungen je Fehlerart", () => {
    expect(pm2FailureMessage("list-unreadable", "supabase")).toBe("Die Liste der PM2-Dienste ließ sich nicht lesen (pm2 jlist). Nichts geändert.");
    expect(pm2FailureMessage("delete-failed", "supabase")).toContain(SUPA);
    expect(pm2FailureMessage("start-failed", "telegram-relay")).toBe(`PM2 konnte den Bot nicht starten. Details mit: pm2 logs ${BOT}`);
  });
});

describe("savePm2", () => {
  test("Erfolg sichert die Liste, Fehlschlag wird gemeldet", async () => {
    const good = fakePm2([BOT]);
    expect(await savePm2(good.deps)).toBe(true);
    expect(good.saved()).toEqual([BOT]);
    expect(good.lines).toEqual([]);
    const bad = fakePm2([BOT], { failSave: true });
    expect(await savePm2(bad.deps)).toBe(false);
    expect(bad.lines.join("\n")).toContain("pm2 save ist gescheitert");
    expect(bad.lines.join("\n")).not.toContain("GEHEIM");
  });
});

describe("realPm2Deps", () => {
  test("beachtet die Frist je Aufruf und meldet fehlende Befehle als missing", async () => {
    const deps = realPm2Deps("/tmp", () => {});
    expect(deps.pm2).toEqual(["pm2"]);
    const slow = await deps.run(["sleep", "5"], { timeoutMs: 200 });
    expect(slow.ok).toBe(false);
    expect(slow.stderr).toContain("200 ms");
    const missing = await deps.run(["tybo-gibt-es-nicht-370"]);
    expect(missing).toMatchObject({ ok: false, missing: true });
    expect(PM2_COMMAND_TIMEOUT_MS).toBe(30_000);
  });
});
