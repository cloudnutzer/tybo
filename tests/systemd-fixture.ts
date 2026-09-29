/**
 * Attrappe eines Linux-Rechners mit systemd (Issue #207): systemctl --user,
 * loginctl, which und PM2 merken sich ihren Zustand; nichts startet echt.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandResult, SetupContext } from "../src/setup/context";
import { FAKE, makeCtx } from "./setup-fixture";

export interface World {
  reachable: boolean;
  loaded: boolean;
  active: boolean;
  enabled: boolean;
  linger: "yes" | "no" | "fail";
  /** Antwort auf loginctl enable-linger ohne sudo */
  lingerEnable: "ok" | "denied" | "error" | "noop";
  /**
   * „none“: pm2 nicht im PATH, „noexec“: liegt da, aber nicht ausführbar,
   * „nointerp“: Interpreter fehlt (env meldet 127), „broken“: pm2 --version
   * scheitert, „timeout“: hängt
   */
  pm2: "none" | "noexec" | "nointerp" | "broken" | "timeout" | "absent" | "bot" | "unknown";
}

/** Rechner mit systemd als Attrappe; merkt sich, was gestartet und aktiviert wurde */
export function systemdRun(ctx: { pm2DumpPath: string }, start: Partial<World> = {}) {
  const w: World = { reachable: true, loaded: false, active: false, enabled: false, linger: "yes", lingerEnable: "ok", pm2: "none", ...start };
  const calls: string[] = [];
  const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr = "Fehler"): CommandResult => ({ code: 1, stdout: "", stderr });
  const run = async (cmd: string[]): Promise<CommandResult> => {
    const line = cmd.join(" ");
    calls.push(line);
    if (line === "git --version") return ok("git version 2.50.0");
    if (line === "which bun") return ok("/home/alex/.bun/bin/bun");
    if (line === "which claude") return ok("/home/alex/.local/bin/claude");
    if (line.startsWith("systemctl --user show tybo-telegram-relay.service")) {
      if (!w.reachable) return fail("Failed to connect to bus: No medium found");
      return ok(`LoadState=${w.loaded ? "loaded" : "not-found"}\nActiveState=${w.active ? "active" : "inactive"}\nUnitFileState=${w.enabled ? "enabled" : w.loaded ? "disabled" : ""}`);
    }
    if (line === "systemctl --user daemon-reload") {
      w.loaded = true;
      return ok();
    }
    if (line === "systemctl --user enable --now tybo-telegram-relay") {
      w.active = w.enabled = true;
      return ok();
    }
    if (line === "systemctl --user enable tybo-telegram-relay") {
      w.enabled = true;
      return ok();
    }
    if (line === "loginctl show-user alex --property=Linger --value") return w.linger === "fail" ? fail() : ok(w.linger);
    if (line === "loginctl enable-linger alex") {
      if (w.lingerEnable === "denied") return fail(`Access denied ${FAKE.token}`);
      if (w.lingerEnable === "error") return fail(`Failed to connect to bus: No such file or directory ${FAKE.token}`);
      if (w.lingerEnable === "ok") w.linger = "yes";
      return ok();
    }
    if (line === "pm2 --version") {
      if (w.pm2 === "none") return { code: -1, stdout: "", stderr: "Befehl nicht gefunden", spawnError: "ENOENT" };
      if (w.pm2 === "noexec") return { code: -1, stdout: "", stderr: "Befehl ließ sich nicht starten", spawnError: "EACCES" };
      if (w.pm2 === "nointerp") return { code: 127, stdout: "", stderr: "/usr/bin/env: „node“: Datei oder Verzeichnis nicht gefunden" };
      if (w.pm2 === "timeout") return { code: -1, stdout: "", stderr: "", timedOut: true };
      return w.pm2 === "broken" ? fail(`Error: Cannot find module ${FAKE.token}`) : ok("6.0.0");
    }
    if (line === "pm2 jlist") {
      if (w.pm2 === "unknown") return fail(`EACCES ${FAKE.token}`);
      return ok(JSON.stringify(w.pm2 === "bot" ? [{ name: "tybo-telegram-relay" }] : []));
    }
    if (line.startsWith("pm2 delete")) return { code: 1, stdout: "", stderr: "not found" };
    if (line.startsWith("pm2 start")) {
      if (cmd.includes("tybo-telegram-relay")) w.pm2 = "bot";
      return ok();
    }
    if (line === "pm2 save") {
      await mkdir(dirname(ctx.pm2DumpPath), { recursive: true });
      await writeFile(ctx.pm2DumpPath, JSON.stringify(w.pm2 === "bot" ? [{ name: "tybo-telegram-relay" }] : []));
      return ok();
    }
    return { code: -1, stdout: "", stderr: "Befehl nicht gefunden" };
  };
  return Object.assign(run, { calls, world: w });
}

export type Run = ReturnType<typeof systemdRun>;

/** Linux mit systemd; unit: Dienstdatei liegt schon da */
export async function linuxCtx(start: Partial<World> = {}, options: { env?: string; profile?: string; unit?: boolean } = {}) {
  const ctx = await makeCtx({ env: options.env, profile: options.profile, overrides: { platform: "linux" } });
  await mkdir(ctx.systemdRunDir, { recursive: true });
  if (options.unit) {
    await mkdir(ctx.systemdUserDir, { recursive: true });
    await writeFile(join(ctx.systemdUserDir, "tybo-telegram-relay.service"), "[Service]\n");
  }
  const run = systemdRun(ctx, start);
  ctx.run = run as any;
  return Object.assign(ctx as SetupContext, { run });
}

/** Befehle, die etwas starten, neu starten oder aktivieren */
export const started = (run: Run) => run.calls.filter(c => /^systemctl --user (enable|restart|start|daemon-reload)|^pm2 (start|delete)/.test(c));
