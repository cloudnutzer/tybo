/**
 * Attrappen für die Dienst-Versionen (Issue #486): launchctl, systemctl,
 * pm2, Metrik, Prozess, Dateien und Uhr. Nichts davon ruft einen echten
 * Dienstbefehl, restart:request oder src/bot.ts.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatchedService } from "../src/lib/maintenance/config";
import type { ServiceCommandResult, ServiceDeps } from "../src/lib/maintenance/services";

/** Metrik-Beispiel nach dem Muster von cloudflared (Prometheus-Text) */
export const CLOUDFLARED_METRICS = [
  "# HELP build_info Build and version information",
  "# TYPE build_info gauge",
  'build_info{goversion="go1.24.4",revision="2026-10-01T10:00:00Z",type="",version="2026.10.0"} 1',
  "# HELP cloudflared_tunnel_ha_connections Number of active ha connections",
  "cloudflared_tunnel_ha_connections 4",
].join("\n");

export const metrics = (version: string) => CLOUDFLARED_METRICS.replace('version="2026.10.0"', `version="${version}"`);

const dirs: string[] = [];
export function cleanupServiceDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
export function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tybo-dienste-"));
  dirs.push(d);
  return d;
}

export const TUNNEL: WatchedService = {
  name: "Cloudflare-Tunnel",
  manager: "launchd",
  target: "ai.tybo.cloudflare-tunnel",
  versionCommand: ["cloudflared", "--version"],
  running: { kind: "metric", url: "http://127.0.0.1:20241/metrics", metric: "build_info", label: "version" },
  waitMs: 10_000,
};

export interface Service {
  /** running, stopped, missing */
  state: "running" | "stopped" | "missing";
  pid: number;
  /** gemeldete Version (Metrik) */
  version: string;
  /** Prozessstart und Programmpfad (Zeitstempel-Ersatz) */
  startedMs?: number;
  exe?: string;
}

export interface Fake {
  deps: ServiceDeps;
  calls: string[];
  restarts: string[];
  botRequests: string[];
  clock: { now: number };
  services: Record<string, Service>;
  installed: Record<string, string | null>;
  /** Metrik nicht erreichbar */
  metricDown: boolean;
  /** Neustart scheitert */
  restartFails: boolean;
  /** was ein Neustart bewirkt: neue PID, neue Version, ab wann (Messungen nach dem Neustart) */
  afterRestart: (svc: Service, target: string) => void;
  files: Record<string, { realPath: string; changedMs: number }>;
}

export function fake(root = tmp()): Fake {
  const f: Fake = {
    calls: [],
    restarts: [],
    botRequests: [],
    clock: { now: Date.parse("2026-10-29T03:15:00Z") },
    services: { "ai.tybo.cloudflare-tunnel": { state: "running", pid: 100, version: "2026.10.0" } },
    installed: { cloudflared: "cloudflared version 2026.10.3 (built 2026-10-20-1200 UTC)" },
    metricDown: false,
    restartFails: false,
    afterRestart: svc => {
      svc.pid += 1;
      svc.version = "2026.10.3";
    },
    files: {},
    deps: undefined as unknown as ServiceDeps,
  };
  const answer = (code: number, stdout = "", stderr = ""): ServiceCommandResult => ({ code, stdout, stderr });
  const run = async (cmd: string[]): Promise<ServiceCommandResult> => {
    const key = cmd.join(" ");
    f.calls.push(key);
    if (cmd[0] === "launchctl" && cmd[1] === "list") {
      const s = f.services[cmd[2]];
      if (!s || s.state === "missing") return answer(113, "", `Could not find service "${cmd[2]}" in domain for port`);
      return answer(0, `{\n\t"Label" = "${cmd[2]}";\n\t"LastExitStatus" = 0;\n${s.state === "running" ? `\t"PID" = ${s.pid};\n` : ""}};`);
    }
    if (cmd[0] === "systemctl" && cmd[2] === "show") {
      const s = f.services[cmd[3]];
      if (!s || s.state === "missing") return answer(0, "LoadState=not-found\nActiveState=inactive\nMainPID=0\n");
      return answer(0, `LoadState=loaded\nActiveState=${s.state === "running" ? "active" : "inactive"}\nMainPID=${s.state === "running" ? s.pid : 0}\n`);
    }
    if (cmd[0] === "pm2" && cmd[1] === "jlist") {
      const list = Object.entries(f.services)
        .filter(([, s]) => s.state !== "missing")
        .map(([name, s]) => ({ name, pid: s.state === "running" ? s.pid : 0, pm2_env: { status: s.state === "running" ? "online" : "stopped" } }));
      return answer(0, JSON.stringify(list));
    }
    const restart =
      (cmd[0] === "launchctl" && cmd[1] === "kickstart" && cmd[3].split("/").pop()) ||
      (cmd[0] === "systemctl" && cmd[2] === "restart" && cmd[3]) ||
      (cmd[0] === "pm2" && cmd[1] === "restart" && cmd[2]);
    if (restart) {
      f.restarts.push(key);
      if (f.restartFails) return answer(1, "", "Boot-out failed: 5: Input/output error");
      const s = f.services[restart];
      if (s) f.afterRestart(s, restart);
      return answer(0);
    }
    const out = f.installed[cmd[0]];
    if (out === undefined) return answer(127, "", "not found");
    if (out === null) return answer(1, "", "kaputt");
    return answer(0, out);
  };
  f.deps = {
    platform: "darwin",
    uid: 501,
    env: {},
    now: () => f.clock.now,
    sleep: async ms => {
      f.clock.now += ms;
    },
    run,
    async fetchText(url) {
      f.calls.push(`GET ${url}`);
      if (f.metricDown) throw new Error("Unable to connect");
      const s = Object.values(f.services)[0];
      if (!s || s.state !== "running") throw new Error("Unable to connect");
      return metrics(s.version);
    },
    async processInfo(pid) {
      const s = Object.values(f.services).find(x => x.pid === pid && x.state === "running");
      return s?.startedMs !== undefined && s.exe ? { startedMs: s.startedMs, exe: s.exe } : null;
    },
    async fileTimes(path) {
      return f.files[path] ?? null;
    },
    async requestBotRestart(note) {
      f.botRequests.push(note);
    },
    lockPath: join(root, "data", "dienste.lock"),
  };
  mkdirSync(join(root, "data"), { recursive: true });
  return f;
}

