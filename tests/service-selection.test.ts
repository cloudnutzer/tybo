/**
 * Issue #165: Auswahl der Dienste für --service in setup/configure-launchd.ts
 * und setup/configure-services.ts. „all“ nimmt den Supabase-Dienst nur bei
 * SUPABASE_URL auf das Supabase dieses Rechners mit; einzelne Namen bleiben
 * wie bisher. Danach laufen die ausgewählten Dienste durch configureService
 * bzw. configurePM2Service mit Attrappen für launchctl und PM2: es startet
 * kein echter Dienst, die .env liegt nur im Testordner.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as launchd from "../setup/configure-launchd";
import * as services from "../setup/configure-services";
import { PROJECT_ROOT } from "../src/setup/context";
import { LOCAL_SUPABASE_URL } from "../src/setup/local-supabase";
import { cleanup, FAKE, makeCtx } from "./setup-fixture";

afterAll(cleanup);

const LAUNCHD_BEFORE = ["telegram-relay", "smart-checkin", "morning-briefing", "watchdog", "whatsapp-gateway", "cloudflare-tunnel"];
const PM2_BEFORE = ["telegram-relay", "smart-checkin", "morning-briefing", "watchdog"];

const ENVS = {
  lokal: `TELEGRAM_BOT_TOKEN=${FAKE.token}\nSUPABASE_URL=${LOCAL_SUPABASE_URL}\n`,
  cloud: `TELEGRAM_BOT_TOKEN=${FAKE.token}\nSUPABASE_URL=${FAKE.supabaseUrl}\n`,
  "ohne Adresse": `TELEGRAM_BOT_TOKEN=${FAKE.token}\n`,
  "anderer lokaler Port": `SUPABASE_URL=http://127.0.0.1:54321\n`,
};

async function envPath(kind: keyof typeof ENVS | "ohne .env"): Promise<string> {
  const ctx = await makeCtx(kind === "ohne .env" ? {} : { env: ENVS[kind] });
  return ctx.envPath;
}

describe("--service all", () => {
  for (const [name, mod, before] of [
    ["configure-launchd", launchd, LAUNCHD_BEFORE],
    ["configure-services", services, PM2_BEFORE],
  ] as const) {
    test(`${name}: lokal mit supabase (am Ende), sonst die Dienste wie bisher`, async () => {
      expect(await mod.selectServices("all", await envPath("lokal"))).toEqual([...before, "supabase"] as any);
      for (const kind of ["cloud", "ohne Adresse", "anderer lokaler Port", "ohne .env"] as const) {
        expect(await mod.selectServices("all", await envPath(kind))).toEqual([...before] as any);
      }
    });

    test(`${name}: einzelne Dienste unverändert, unbekannte null`, async () => {
      const cloud = await envPath("cloud");
      for (const s of before) expect(await mod.selectServices(s, cloud)).toEqual([s] as any);
      // ausdrücklich verlangt: auch ohne lokale Adresse
      expect(await mod.selectServices("supabase", cloud)).toEqual(["supabase"] as any);
      expect(await mod.selectServices("gibtsnicht", cloud)).toBeNull();
      expect(await mod.selectServices("", cloud)).toBeNull();
    });
  }
});

describe("ausgewählte Dienste gegen Attrappen", () => {
  test("launchd: lokal wird ai.tybo.supabase geschrieben und geladen, Cloud nicht", async () => {
    for (const [kind, expectSupabase] of [["lokal", true], ["cloud", false], ["ohne Adresse", false]] as const) {
      const files = new Map<string, string>();
      const loaded: string[] = [];
      const deps: launchd.LaunchdDeps = {
        projectRoot: "/projekt",
        launchAgentsDir: "/home/test/Library/LaunchAgents",
        home: "/home/test",
        async run(cmd) {
          if (cmd[0] === "which") return { ok: true, stdout: `/opt/bin/${cmd[1]}`, stderr: "" };
          if (cmd[0] !== "launchctl") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
          if (cmd[1] === "list") return { ok: true, stdout: "", stderr: "" };
          if (cmd[1] === "load") loaded.push(basename(cmd[2], ".plist"));
          return { ok: true, stdout: "", stderr: "" };
        },
        // Vorlagen aus dem Repo (nur lesen), geschrieben wird nur in die Map
        exists: p => files.has(p) || (p.startsWith("/projekt/launchd/") && existsTemplate(p)),
        readFile: p => files.get(p) ?? readFileSync(join(PROJECT_ROOT, p.slice("/projekt/".length)), "utf8"),
        writeFile: (p, c) => void files.set(p, c),
        mkdir: () => {},
        log: () => {},
      };
      const targets = (await launchd.selectServices("all", await envPath(kind)))!;
      for (const s of targets) await launchd.configureService(s, deps);
      expect(loaded.includes("ai.tybo.supabase")).toBe(expectSupabase);
      expect(files.has("/home/test/Library/LaunchAgents/ai.tybo.supabase.plist")).toBe(expectSupabase);
      expect(loaded).toContain("ai.tybo.telegram-relay");
    }
  });

  test("PM2: lokal startet tybo-supabase (mit Hülle), Cloud nur die Daemons wie bisher", async () => {
    for (const [kind, expected] of [
      ["lokal", ["tybo-telegram-relay", "tybo-watchdog", "tybo-supabase"]],
      ["cloud", ["tybo-telegram-relay", "tybo-watchdog"]],
      ["ohne Adresse", ["tybo-telegram-relay", "tybo-watchdog"]],
    ] as const) {
      const started: string[] = [];
      const deps: services.Pm2Deps = {
        projectRoot: "/projekt",
        pm2: ["pm2"],
        async run(cmd) {
          if (cmd[0] !== "pm2") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
          if (cmd[1] === "jlist") return { ok: true, stdout: "[]", stderr: "" };
          if (cmd[1] === "start") started.push(cmd[cmd.indexOf("--name") + 1]);
          return { ok: true, stdout: "", stderr: "" };
        },
        log: () => {},
      };
      const targets = (await services.selectServices("all", await envPath(kind)))!;
      // wie main(): nur Daemons laufen über PM2, die übrigen über cron bzw. Aufgabenplanung
      for (const s of targets.filter(t => services.DAEMON_SERVICES.includes(t))) {
        expect(await services.configurePM2Service(s, deps)).toBe(true);
      }
      expect(started).toEqual([...expected]);
    }
  });
});

function existsTemplate(p: string): boolean {
  try {
    readFileSync(join(PROJECT_ROOT, p.slice("/projekt/".length)));
    return true;
  } catch {
    return false;
  }
}
