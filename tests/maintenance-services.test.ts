/**
 * Dienst-Versionen (Issue #486, src/lib/maintenance/services.ts): nur mit
 * Attrappen für launchctl, systemctl, pm2, Metrik, Prozess und Uhr. Kein
 * echter Dienstbefehl, kein restart:request, kein src/bot.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MaintenanceConfigError, parseMaintenanceConfig, parseServices, type WatchedService } from "../src/lib/maintenance/config";
import {
  checkConfiguredServices,
  checkServices,
  isBotTarget,
  parseMetricVersion,
  serviceLine,
  serviceReportLines,
} from "../src/lib/maintenance/services";
import { cleanupServiceDirs, CLOUDFLARED_METRICS, fake, tmp, TUNNEL } from "./maintenance-services-fixture";

afterEach(cleanupServiceDirs);

describe("Konfiguration", () => {
  const ok = { launchd: "ai.tybo.cloudflare-tunnel", versionBefehl: ["cloudflared", "--version"], metrik: { url: "http://127.0.0.1:20241/metrics" } };

  test("Vorlage: cloudflared als erster Eintrag mit Metrik", () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, "..", "config", "wartung.example.json"), "utf8"));
    const c = parseMaintenanceConfig(raw);
    expect(c.services[0]).toEqual({ ...TUNNEL, waitMs: 60_000 });
  });

  test("fehlende Liste: keine Dienste", () => {
    expect(parseMaintenanceConfig({}).services).toEqual([]);
  });

  test("Standards: Metrikname build_info, Label version, Name = Ziel", () => {
    expect(parseServices([ok])[0]).toMatchObject({ name: "ai.tybo.cloudflare-tunnel", running: { metric: "build_info", label: "version" }, waitMs: 60_000 });
  });

  test("ungültige Einträge werden abgewiesen", () => {
    const bad: unknown[] = [
      "kein Objekt",
      [{ ...ok, befehl: "x" }],
      [{ ...ok, systemd: "tybo-x.service" }],
      [{ versionBefehl: ["a"], metrik: ok.metrik }],
      [{ ...ok, launchd: "com.fremd.dienst" }],
      [{ ...ok, launchd: "ai.tybo.x; rm -rf ~" }],
      [{ ...ok, launchd: undefined, systemd: "tybo-x" }],
      [{ ...ok, launchd: undefined, pm2: "fremd" }],
      [{ ...ok, versionBefehl: "cloudflared --version" }],
      [{ ...ok, versionBefehl: [] }],
      [{ ...ok, metrik: { url: "https://example.com/metrics" } }],
      [{ ...ok, metrik: { url: "http://10.0.0.5:20241/metrics" } }],
      [{ ...ok, metrik: { url: "http://user:pw@127.0.0.1/metrics" } }],
      [{ ...ok, metrik: { url: "http://127.0.0.1/metrics", name: "a b" } }],
      [{ ...ok, binaer: "/opt/homebrew/bin/cloudflared" }],
      [{ ...ok, metrik: undefined, binaer: "relativ/cloudflared" }],
      [{ ...ok, wartezeitSek: 1 }],
      [ok, ok],
    ];
    for (const b of bad) expect(() => parseServices(b)).toThrow(MaintenanceConfigError);
    expect(() => parseMaintenanceConfig({ dienste: [{ ...ok, extra: 1 }] })).toThrow(MaintenanceConfigError);
  });

  test("systemd, PM2 und Zeitstempel-Ersatz", () => {
    const s = parseServices([
      { systemd: "tybo-cloudflare-tunnel.service", versionBefehl: ["cloudflared", "--version"], binaer: "/usr/bin/cloudflared", wartezeitSek: 20 },
      { pm2: "tybo-voice-bridge", name: "Sprach-Brücke", versionBefehl: ["bun", "--version"], binaer: "/home/a/.bun/bin/bun" },
    ]);
    expect(s[0]).toMatchObject({ manager: "systemd", target: "tybo-cloudflare-tunnel.service", running: { kind: "binary" }, waitMs: 20_000 });
    expect(s[1]).toMatchObject({ manager: "pm2", name: "Sprach-Brücke" });
  });

  test("ohne config/wartung.json: kein Lauf, kein Befehl", async () => {
    const root = tmp();
    const f = fake(root);
    expect(await checkConfiguredServices(root, f.deps, "neustart")).toBeNull();
    expect(f.calls).toEqual([]);
  });

  test("ungültige config/wartung.json: Fehler, kein Dienst angefasst", async () => {
    const root = tmp();
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "wartung.json"), JSON.stringify({ dienste: [{ launchd: "com.fremd", versionBefehl: ["x"], binaer: "/x" }] }));
    const f = fake(root);
    const run = await checkConfiguredServices(root, f.deps, "neustart");
    expect(run?.status).toBe("fehler");
    expect(run?.error).toContain("config/wartung.json ungültig");
    expect(f.calls).toEqual([]);
  });
});

describe("Metrik", () => {
  test("liest version aus build_info", () => {
    expect(parseMetricVersion(CLOUDFLARED_METRICS, "build_info", "version")).toBe("2026.10.0");
  });
  test("fehlende Metrik oder fehlendes Label: null", () => {
    expect(parseMetricVersion("cloudflared_tunnel_ha_connections 4", "build_info", "version")).toBeNull();
    expect(parseMetricVersion('build_info{goversion="go1.24"} 1', "build_info", "version")).toBeNull();
    // ähnlicher Name zählt nicht
    expect(parseMetricVersion('build_info_total{version="1.0.0"} 1', "build_info", "version")).toBeNull();
  });
});

describe("Vergleich ohne Neustart (prüfen)", () => {
  test("ältere Version: veraltet, würde neu gestartet, nichts gestartet", async () => {
    const f = fake();
    const run = await checkServices([TUNNEL], f.deps, "pruefen");
    expect(run.services[0]).toMatchObject({ outcome: "veraltet", installed: "2026.10.3", running: "2026.10.0" });
    expect(run.status).toBe("warn");
    expect(f.restarts).toEqual([]);
    expect(serviceReportLines(run)).toEqual(["Dienst-Versionen:", "- Cloudflare-Tunnel: läuft 2026.10.0, installiert 2026.10.3, würde neu gestartet"]);
  });

  test("gleiche Version: aktuell", async () => {
    const f = fake();
    f.services["ai.tybo.cloudflare-tunnel"].version = "2026.10.3";
    const run = await checkServices([TUNNEL], f.deps, "neustart");
    expect(run.services[0]).toMatchObject({ outcome: "aktuell", running: "2026.10.3" });
    expect(run.status).toBe("ok");
    expect(f.restarts).toEqual([]);
  });

  test("neuere Version als installiert: abweichend, kein Neustart", async () => {
    const f = fake();
    f.services["ai.tybo.cloudflare-tunnel"].version = "2026.11.0";
    const run = await checkServices([TUNNEL], f.deps, "neustart");
    expect(run.services[0].outcome).toBe("abweichend");
    expect(run.status).toBe("warn");
    expect(f.restarts).toEqual([]);
  });

  test("Metrik nicht erreichbar: unbekannt, kein Neustart", async () => {
    const f = fake();
    f.metricDown = true;
    const run = await checkServices([TUNNEL], f.deps, "neustart");
    expect(run.services[0]).toMatchObject({ outcome: "unbekannt" });
    expect(run.services[0].detail).toContain("Metrik nicht erreichbar");
    expect(f.restarts).toEqual([]);
  });

  test("installierte Version unbekannt: kein Neustart", async () => {
    for (const out of [null, "keine Nummer"]) {
      const f = fake();
      f.installed.cloudflared = out;
      const run = await checkServices([TUNNEL], f.deps, "neustart");
      expect(run.services[0].outcome).toBe("unbekannt");
      expect(f.restarts).toEqual([]);
    }
  });

  test("gestoppter oder nicht geladener Dienst: kein Neustart", async () => {
    for (const state of ["stopped", "missing"] as const) {
      const f = fake();
      f.services["ai.tybo.cloudflare-tunnel"].state = state;
      const run = await checkServices([TUNNEL], f.deps, "neustart");
      expect(run.services[0].outcome).toBe("gestoppt");
      expect(f.restarts).toEqual([]);
      expect(f.calls.some(c => c.startsWith("GET "))).toBe(false);
    }
  });

  test("leere Liste: kein Befehl", async () => {
    const f = fake();
    expect((await checkServices([], f.deps, "neustart")).services).toEqual([]);
    expect(f.calls).toEqual([]);
  });
});

describe("Neustart mit Nachprüfung", () => {
  test("launchd: kickstart -k gui/<uid>/<label>, danach neue PID und neue Version", async () => {
    const f = fake();
    const run = await checkServices([TUNNEL], f.deps, "neustart");
    expect(f.restarts).toEqual(["launchctl kickstart -k gui/501/ai.tybo.cloudflare-tunnel"]);
    expect(run.services[0]).toMatchObject({ outcome: "neu-gestartet", previous: "2026.10.0", running: "2026.10.3" });
    expect(run.status).toBe("ok");
    expect(serviceReportLines(run)[1]).toBe("- Cloudflare-Tunnel: neu gestartet, 2026.10.0 → 2026.10.3");
    // nach dem Neustart frisch gemessen
    expect(f.calls.filter(c => c.startsWith("GET ")).length).toBe(2);
  });

  test("systemd und PM2: eigene Neustartbefehle", async () => {
    for (const [manager, target, expected] of [
      ["systemd", "tybo-cloudflare-tunnel.service", "systemctl --user restart tybo-cloudflare-tunnel.service"],
      ["pm2", "tybo-cloudflare-tunnel", "pm2 restart tybo-cloudflare-tunnel"],
    ] as const) {
      const f = fake();
      f.services = { [target]: { state: "running", pid: 100, version: "2026.10.0" } };
      f.deps.platform = "linux";
      const run = await checkServices([{ ...TUNNEL, manager, target }], f.deps, "neustart");
      expect(f.restarts).toEqual([expected]);
      expect(run.services[0].outcome).toBe("neu-gestartet");
    }
  });

  test("verzögerter Start: wartet, bis die neue Version gemeldet wird", async () => {
    const f = fake();
    let polls = 0;
    const realFetch = f.deps.fetchText;
    f.afterRestart = svc => {
      svc.state = "stopped";
    };
    f.deps.fetchText = async (url, t) => {
      const s = f.services["ai.tybo.cloudflare-tunnel"];
      if (f.restarts.length && ++polls === 2) Object.assign(s, { state: "running", pid: 200, version: "2026.10.3" });
      return realFetch(url, t);
    };
    // erste Messungen nach dem Neustart: Dienst noch nicht da; ab der zweiten Metrik-Abfrage läuft er
    const origRun = f.deps.run;
    f.deps.run = async (cmd, t) => {
      const r = await origRun(cmd, t);
      const s = f.services["ai.tybo.cloudflare-tunnel"];
      if (f.restarts.length && cmd[1] === "list" && s.state === "stopped") Object.assign(s, { state: "running", pid: 200, version: "2026.10.0" });
      return r;
    };
    const start = f.clock.now;
    const run = await checkServices([TUNNEL], f.deps, "neustart");
    expect(run.services[0].outcome).toBe("neu-gestartet");
    expect(f.clock.now - start).toBeGreaterThan(2_000);
    expect(f.clock.now - start).toBeLessThanOrEqual(TUNNEL.waitMs);
  });

  test("nach dem Neustart weiter alt: Fehler nach begrenzter Wartezeit", async () => {
    const f = fake();
    f.afterRestart = svc => {
      svc.pid += 1;
    };
    const start = f.clock.now;
    const run = await checkServices([TUNNEL], f.deps, "neustart");
    expect(run.services[0]).toMatchObject({ outcome: "fehler", running: "2026.10.0" });
    expect(run.services[0].detail).toContain("meldet danach 2026.10.0");
    expect(run.status).toBe("fehler");
    expect(f.clock.now - start).toBeGreaterThanOrEqual(TUNNEL.waitMs);
    expect(f.clock.now - start).toBeLessThan(TUNNEL.waitMs + 5_000);
    expect(f.restarts.length).toBe(1);
  });

  test("ohne Prozesswechsel: Fehler", async () => {
    const f = fake();
    f.afterRestart = svc => {
      svc.version = "2026.10.3";
    };
    const run = await checkServices([TUNNEL], f.deps, "neustart");
    expect(run.services[0].outcome).toBe("fehler");
    expect(run.services[0].detail).toContain("kein Prozesswechsel");
  });

  test("läuft nach dem Neustart nicht: Fehler", async () => {
    const f = fake();
    f.afterRestart = svc => {
      svc.state = "stopped";
    };
    const run = await checkServices([TUNNEL], f.deps, "neustart");
    expect(run.services[0].outcome).toBe("fehler");
    expect(run.services[0].detail).toContain("läuft nach dem Neustart nicht");
  });

  test("Neustartbefehl scheitert: Fehler mit Grund", async () => {
    const f = fake();
    f.restartFails = true;
    const run = await checkServices([TUNNEL], f.deps, "neustart");
    expect(run.services[0]).toMatchObject({ outcome: "fehler" });
    expect(run.services[0].detail).toContain("Neustart gescheitert: Boot-out failed");
    expect(serviceReportLines(run)[1]).toContain("FEHLER");
  });

  test("ein Fehler hält die übrigen Dienste nicht auf", async () => {
    const f = fake();
    f.services["ai.tybo.zweiter"] = { state: "running", pid: 300, version: "x" };
    const second: WatchedService = { ...TUNNEL, name: "Zweiter", target: "ai.tybo.zweiter", versionCommand: ["zweiter"] };
    const run = await checkServices([second, TUNNEL], f.deps, "neustart");
    expect(run.services.map(s => s.outcome)).toEqual(["unbekannt", "neu-gestartet"]);
  });
});

describe("Bot-Schutz", () => {
  test("erkennt den Bot bei allen Dienstmanagern", () => {
    expect(isBotTarget("launchd", "ai.tybo.telegram-relay", {})).toBe(true);
    expect(isBotTarget("launchd", "ai.tybo.mein-bot", { TYBO_LAUNCHD_LABEL: "ai.tybo.mein-bot" })).toBe(true);
    expect(isBotTarget("launchd", "ai.tybo.cloudflare-tunnel", {})).toBe(false);
    expect(isBotTarget("systemd", "tybo-telegram-relay.service", {})).toBe(true);
    expect(isBotTarget("systemd", "tybo-anderer-bot.service", { TYBO_SYSTEMD_UNIT: "tybo-anderer-bot.service" })).toBe(true);
    expect(isBotTarget("systemd", "tybo-cloudflare-tunnel.service", {})).toBe(false);
    expect(isBotTarget("pm2", "tybo-telegram-relay", {})).toBe(true);
    expect(isBotTarget("pm2", "tybo-cloudflare-tunnel", {})).toBe(false);
  });

  for (const [manager, target, env] of [
    ["launchd", "ai.tybo.telegram-relay", {}],
    ["launchd", "ai.tybo.mein-bot", { TYBO_LAUNCHD_LABEL: "ai.tybo.mein-bot" }],
    ["systemd", "tybo-telegram-relay.service", {}],
    ["systemd", "tybo-mein-bot.service", { TYBO_SYSTEMD_UNIT: "tybo-mein-bot.service" }],
    ["pm2", "tybo-telegram-relay", {}],
  ] as const) {
    test(`${manager} ${target}: nur Anfrage, nie der Dienstmanager`, async () => {
      const f = fake();
      f.services = { [target]: { state: "running", pid: 100, version: "2026.10.0" } };
      f.deps.env = { ...env };
      const run = await checkServices([{ ...TUNNEL, manager, target }], f.deps, "neustart");
      expect(f.restarts).toEqual([]);
      expect(f.botRequests.length).toBe(1);
      expect(run.services[0].outcome).toBe("neustart-angefordert");
      expect(f.calls.some(c => /kickstart|restart/.test(c))).toBe(false);
    });
  }

  test("prüfen fordert auch beim Bot nichts an", async () => {
    const f = fake();
    f.services = { "ai.tybo.telegram-relay": { state: "running", pid: 100, version: "2026.10.0" } };
    await checkServices([{ ...TUNNEL, target: "ai.tybo.telegram-relay" }], f.deps, "pruefen");
    expect(f.botRequests).toEqual([]);
    expect(f.restarts).toEqual([]);
  });
});

describe("Zeitstempel-Ersatz", () => {
  const BIN: WatchedService = { ...TUNNEL, running: { kind: "binary", path: "/opt/homebrew/bin/cloudflared" } };
  const OLD = "/opt/homebrew/Cellar/cloudflared/2026.10.0/bin/cloudflared";
  const NEW = "/opt/homebrew/Cellar/cloudflared/2026.10.3/bin/cloudflared";

  function binFake() {
    const f = fake();
    const t0 = f.clock.now - 3 * 86400_000;
    Object.assign(f.services["ai.tybo.cloudflare-tunnel"], { startedMs: t0, exe: OLD });
    f.files["/opt/homebrew/bin/cloudflared"] = { realPath: NEW, changedMs: t0 + 86400_000 };
    f.files[OLD] = { realPath: OLD, changedMs: t0 - 86400_000 };
    f.files[NEW] = { realPath: NEW, changedMs: t0 + 86400_000 };
    f.afterRestart = svc => {
      Object.assign(svc, { pid: svc.pid + 1, startedMs: f.clock.now, exe: NEW });
    };
    return f;
  }

  test("Prozess aus altem Cellar-Pfad: veraltet, Neustart, danach aus dem neuen Pfad", async () => {
    const f = binFake();
    const run = await checkServices([BIN], f.deps, "neustart");
    expect(f.restarts.length).toBe(1);
    expect(run.services[0]).toMatchObject({ outcome: "neu-gestartet", installed: "2026.10.3" });
    expect(run.services[0].detail).toContain(`läuft aus ${OLD}`);
    expect(f.calls.some(c => c.startsWith("GET "))).toBe(false);
  });

  test("nach dem Neustart: Prozess- und Dateiprüfung genannt, keine gemessene Version vorgetäuscht", async () => {
    const f = binFake();
    const run = await checkServices([BIN], f.deps, "neustart");
    const r = run.services[0];
    expect(r.outcome).toBe("neu-gestartet");
    expect(r.running).toBeUndefined();
    expect(r.previous).toBeUndefined();
    expect(r.detail).toBe(`vorher: läuft aus ${OLD}, installiert ist ${NEW}, danach: Prozess jünger als die Datei (keine Versionsnummer gemessen)`);
    expect(serviceLine(r, "neustart")).toBe(`Cloudflare-Tunnel: neu gestartet, installiert 2026.10.3, ${r.detail}`);
  });

  test("gleicher Pfad, Datei nach dem Start geändert: veraltet", async () => {
    const f = binFake();
    f.services["ai.tybo.cloudflare-tunnel"].exe = "/opt/homebrew/bin/cloudflared";
    const run = await checkServices([BIN], f.deps, "pruefen");
    expect(run.services[0].outcome).toBe("veraltet");
    expect(run.services[0].detail).toContain("nach dem Start geändert");
  });

  test("Prozess jünger als die Datei: aktuell", async () => {
    const f = binFake();
    Object.assign(f.services["ai.tybo.cloudflare-tunnel"], { exe: NEW, startedMs: f.clock.now - 1000 });
    const run = await checkServices([BIN], f.deps, "neustart");
    expect(run.services[0].outcome).toBe("aktuell");
    expect(f.restarts).toEqual([]);
  });

  test("Prozess eines anderen Programms: unbekannt, kein Neustart", async () => {
    const f = binFake();
    f.services["ai.tybo.cloudflare-tunnel"].exe = "/usr/local/bin/bun";
    const run = await checkServices([BIN], f.deps, "neustart");
    expect(run.services[0].outcome).toBe("unbekannt");
    expect(f.restarts).toEqual([]);
  });

  test("Prozess nicht lesbar oder Binärdatei fehlt: unbekannt, kein Neustart", async () => {
    const a = binFake();
    delete a.services["ai.tybo.cloudflare-tunnel"].exe;
    expect((await checkServices([BIN], a.deps, "neustart")).services[0].outcome).toBe("unbekannt");
    expect(a.restarts).toEqual([]);
    const b = binFake();
    delete b.files["/opt/homebrew/bin/cloudflared"];
    expect((await checkServices([BIN], b.deps, "neustart")).services[0].outcome).toBe("unbekannt");
    expect(b.restarts).toEqual([]);
  });

  test("nach dem Neustart weiter alter Pfad: Fehler", async () => {
    const f = binFake();
    f.afterRestart = svc => {
      Object.assign(svc, { pid: svc.pid + 1, startedMs: f.clock.now });
    };
    const run = await checkServices([BIN], f.deps, "neustart");
    expect(run.services[0].outcome).toBe("fehler");
  });
});

describe("Sperre", () => {
  test("belegte Sperre: nichts geprüft, nichts gestartet", async () => {
    const f = fake();
    // lebender Besitzer: dieser Prozess
    writeFileSync(f.deps.lockPath, JSON.stringify({ token: "fremd", pid: process.pid }));
    const run = await checkServices([TUNNEL], f.deps, "neustart");
    expect(run.error).toContain("läuft schon");
    expect(run.status).toBe("fehler");
    expect(f.calls).toEqual([]);
    expect(serviceReportLines(run)[0]).toContain("läuft schon");
  });

  test("parallele Läufe: genau einer startet neu", async () => {
    const root = tmp();
    const a = fake(root);
    const b = fake(root);
    b.services = a.services;
    // Läufe überlappen: der erste wartet in der Nachprüfung, der zweite startet dann
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let reached!: () => void;
    const verifying = new Promise<void>(r => (reached = r));
    const sleep = a.deps.sleep;
    a.deps.sleep = async ms => {
      reached();
      await gate;
      await sleep(ms);
    };
    const first = checkServices([TUNNEL], a.deps, "neustart");
    // Signal statt Pause: der erste hält die Sperre und steht in der Nachprüfung
    await verifying;
    const second = await checkServices([TUNNEL], b.deps, "neustart");
    release();
    const one = await first;
    expect(one.services[0].outcome).toBe("neu-gestartet");
    expect(second.error).toContain("läuft schon");
    expect(a.restarts.length + b.restarts.length).toBe(1);
    expect(existsSync(a.deps.lockPath)).toBe(false);
  });

  test("prüfen nimmt keine Sperre", async () => {
    const f = fake();
    writeFileSync(f.deps.lockPath, JSON.stringify({ token: "fremd", pid: process.pid }));
    const run = await checkServices([TUNNEL], f.deps, "pruefen");
    expect(run.services[0].outcome).toBe("veraltet");
  });
});

describe("Nachprüfung in der Wartezeit", () => {
  // wartezeitSek=5: Schlafen und jede Messung höchstens bis zur Frist
  const SHORT: WatchedService = { ...TUNNEL, waitMs: 5_000 };

  /** Zeitpunkt des Neustarts in der Uhr der Attrappe; ab da läuft die Frist */
  function restartClock(f: ReturnType<typeof fake>): { at: number | null } {
    const r = { at: null as number | null };
    const after = f.afterRestart;
    f.afterRestart = (svc, target) => {
      r.at = f.clock.now;
      after(svc, target);
    };
    return r;
  }

  test("langsame Statusabfrage hält das Zeitlimit ein: Frist wird nicht überschritten", async () => {
    const f = fake();
    const restart = restartClock(f);
    const limits: Array<{ timeout: number; left: number }> = [];
    const run = f.deps.run;
    f.deps.run = async (cmd, timeout) => {
      if (restart.at === null || cmd[1] !== "list") return run(cmd, timeout);
      limits.push({ timeout, left: restart.at + SHORT.waitMs - f.clock.now });
      // braucht 15 s, bricht aber nach dem übergebenen Zeitlimit ab
      f.clock.now += Math.min(15_000, timeout);
      return { code: -1, stdout: "", stderr: "Zeitlimit überschritten" };
    };
    const result = await checkServices([SHORT], f.deps, "neustart");
    expect(result.services[0].outcome).toBe("fehler");
    expect(limits.length).toBeGreaterThan(0);
    for (const l of limits) expect(l.timeout).toBeLessThanOrEqual(l.left);
    expect(f.clock.now - restart.at!).toBeLessThanOrEqual(SHORT.waitMs);
  });

  test("Statusabfrage nach der Frist: Ergebnis zählt nicht", async () => {
    const f = fake();
    const restart = restartClock(f);
    const run = f.deps.run;
    f.deps.run = async (cmd, timeout) => {
      const r = await run(cmd, timeout);
      // hält das Zeitlimit nicht ein und meldet erst nach 15 s den neuen Prozess
      if (restart.at !== null && cmd[1] === "list") f.clock.now += 15_000;
      return r;
    };
    const result = await checkServices([SHORT], f.deps, "neustart");
    expect(result.services[0].outcome).toBe("fehler");
    expect(result.services[0].detail).toContain("Zustand kam erst nach Ablauf der Wartezeit");
    expect(f.calls.filter(c => c.startsWith("GET ")).length).toBe(1);
  });

  test("langsame Metrik: Zeitlimit höchstens die restliche Wartezeit, verspätete neue Version zählt nicht", async () => {
    const f = fake();
    const restart = restartClock(f);
    const limits: Array<{ timeout: number; left: number }> = [];
    const fetchText = f.deps.fetchText;
    f.deps.fetchText = async (url, timeout) => {
      if (restart.at === null) return fetchText(url, timeout);
      limits.push({ timeout, left: restart.at + SHORT.waitMs - f.clock.now });
      f.clock.now += 10_000;
      return fetchText(url, timeout);
    };
    const result = await checkServices([SHORT], f.deps, "neustart");
    expect(limits.length).toBe(1);
    expect(limits[0].timeout).toBeLessThanOrEqual(limits[0].left);
    expect(result.services[0]).toMatchObject({ outcome: "fehler" });
    expect(result.services[0].detail).toContain("Messung kam erst nach Ablauf der Wartezeit");
  });

  test("Metrik hält das Zeitlimit ein: Fehler innerhalb der Frist", async () => {
    const f = fake();
    const restart = restartClock(f);
    const fetchText = f.deps.fetchText;
    f.deps.fetchText = async (url, timeout) => {
      if (restart.at === null) return fetchText(url, timeout);
      f.clock.now += Math.min(8_000, timeout);
      throw new Error("Zeitlimit überschritten");
    };
    const result = await checkServices([SHORT], f.deps, "neustart");
    expect(result.services[0].outcome).toBe("fehler");
    expect(f.clock.now - restart.at!).toBeLessThanOrEqual(SHORT.waitMs);
  });

  test("Zeitstempel-Ersatz: langsame Prozess- und Dateiabfragen bekommen die restliche Wartezeit, verspätet zählt nicht", async () => {
    const BIN: WatchedService = { ...SHORT, running: { kind: "binary", path: "/opt/homebrew/bin/cloudflared" } };
    const OLD = "/opt/homebrew/Cellar/cloudflared/2026.10.0/bin/cloudflared";
    const NEW = "/opt/homebrew/Cellar/cloudflared/2026.10.3/bin/cloudflared";
    const f = fake();
    const t0 = f.clock.now - 3 * 86400_000;
    Object.assign(f.services["ai.tybo.cloudflare-tunnel"], { startedMs: t0, exe: OLD });
    f.files["/opt/homebrew/bin/cloudflared"] = { realPath: NEW, changedMs: t0 + 86400_000 };
    f.files[OLD] = { realPath: OLD, changedMs: t0 - 86400_000 };
    f.files[NEW] = { realPath: NEW, changedMs: t0 + 86400_000 };
    f.afterRestart = svc => Object.assign(svc, { pid: svc.pid + 1, startedMs: f.clock.now, exe: NEW });
    const restart = restartClock(f);
    const limits: Array<{ op: string; timeout: number; left: number }> = [];
    const processInfo = f.deps.processInfo;
    const fileTimes = f.deps.fileTimes;
    f.deps.processInfo = async (pid, timeout) => {
      if (restart.at !== null) {
        limits.push({ op: "prozess", timeout, left: restart.at + BIN.waitMs - f.clock.now });
        f.clock.now += 1_000;
      }
      return processInfo(pid, timeout);
    };
    f.deps.fileTimes = async (path, timeout) => {
      if (restart.at !== null) {
        limits.push({ op: "datei", timeout, left: restart.at + BIN.waitMs - f.clock.now });
        f.clock.now += 1_500;
      }
      return fileTimes(path, timeout);
    };
    const result = await checkServices([BIN], f.deps, "neustart");
    expect(limits.map(l => l.op)).toEqual(["prozess", "datei", "datei"]);
    for (const l of limits) expect(l.timeout).toBeLessThanOrEqual(l.left);
    // 2 s schlafen + 1 s Prozess + 2 × 1,5 s Dateien = 6 s > 5 s: der passende Prozess kam zu spät
    expect(result.services[0].outcome).toBe("fehler");
    expect(result.services[0].detail).toContain("Messung kam erst nach Ablauf der Wartezeit");
  });

  test("schnelle Messungen: Erfolg wie bisher", async () => {
    const f = fake();
    const result = await checkServices([SHORT], f.deps, "neustart");
    expect(result.services[0].outcome).toBe("neu-gestartet");
  });
});

describe("Geheimnisse in Fehlertexten", () => {
  const ARG_SECRET = "arg-geheim-7f3k9q";
  const ENV_SECRET = "env-geheim-2m8x4w";
  const WITH_ARGS: WatchedService = { ...TUNNEL, versionCommand: ["cloudflared", `--token=${ARG_SECRET}`, "--password", "pw-geheim-5r1z", "--version"] };

  test("Versionsbefehl scheitert: weder Argumente noch Geheimnisse aus Ausgabe und Fehlermeldung im Ergebnis", async () => {
    const f = fake();
    f.deps.env = { TYBO_TEST_TOKEN: ENV_SECRET };
    const run = f.deps.run;
    f.deps.run = async (cmd, timeout) => {
      if (cmd[0] !== "cloudflared") return run(cmd, timeout);
      return { code: 1, stdout: "", stderr: `login failed for ${ARG_SECRET} (key ${ENV_SECRET}, pw pw-geheim-5r1z) via https://nutzer:url-geheim-9@example.invalid api_key=muster-geheim-1` };
    };
    const result = await checkServices([WITH_ARGS], f.deps, "neustart");
    const text = JSON.stringify(result) + serviceReportLines(result).join("\n");
    for (const secret of [ARG_SECRET, ENV_SECRET, "pw-geheim-5r1z", "url-geheim-9", "muster-geheim-1"]) expect(text).not.toContain(secret);
    expect(result.services[0].detail).toContain("cloudflared:");
    expect(result.services[0].detail).toContain("[verborgen]");
    expect(result.services[0].detail).not.toContain("--token");
  });

  test("Neustart scheitert mit Geheimnis in der Fehlermeldung: maskiert", async () => {
    const f = fake();
    f.deps.env = { TYBO_TEST_SECRET: ENV_SECRET };
    const run = f.deps.run;
    f.deps.run = async (cmd, timeout) => {
      if (cmd[1] === "kickstart") throw new Error(`spawn kaputt, Umgebung ${ENV_SECRET}`);
      return run(cmd, timeout);
    };
    const result = await checkServices([TUNNEL], f.deps, "neustart");
    expect(result.services[0].outcome).toBe("fehler");
    expect(result.services[0].detail).toContain("Neustart gescheitert: spawn kaputt");
    expect(JSON.stringify(result)).not.toContain(ENV_SECRET);
  });
});
