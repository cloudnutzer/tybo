/**
 * Issue #487: Zeile „Wartung“ im Nachtcheck, Erkennung des Diensts und
 * Einbindung in den Report. Alles gegen Attrappen: kein launchctl, kein
 * systemctl, keine crontab, kein echter Nachtcheck, kein Neustart.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateMaintenance, formatReport, plannedChecks, runCheck, type MaintenanceCheckDeps } from "../src/health-check";
import { loadMaintenanceState, readMaintenanceState, type ItemResult, type MaintenanceRun, type MaintenanceStateRead } from "../src/lib/maintenance/run";
import type { ServiceCheckRun } from "../src/lib/maintenance/services";
import { detectScheduledService, type DetectDeps, type ScheduledServiceState } from "../src/setup/services/detect";
import type { ServiceRun } from "../src/setup/services/run";
import { cleanupServiceDirs, fake } from "./maintenance-services-fixture";

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-30T02:30:00Z");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  cleanupServiceDirs();
});

function root(): string {
  const d = mkdtempSync(join(tmpdir(), "tybo-nachtcheck-"));
  dirs.push(d);
  mkdirSync(join(d, "data"));
  mkdirSync(join(d, "config"));
  return d;
}

function item(over: Partial<ItemResult> = {}): ItemResult {
  return { id: "caches", title: "Caches", status: "ok", count: 1, bytes: 0, reported: 0, reportedBytes: 0, entries: [], notes: [], errors: [], ...over };
}

function lastRun(over: Partial<MaintenanceRun> = {}, ageMs = 2 * DAY): MaintenanceRun {
  const at = new Date(NOW - ageMs).toISOString();
  return { startedAt: at, finishedAt: at, dryRun: false, status: "ok", freeBefore: null, freeAfter: null, items: [], notify: { status: "gesendet" }, ...over };
}

const read = (run: MaintenanceRun): MaintenanceStateRead => ({ status: "ok", state: { version: 1, lastRun: run } });
const evaluate = (r: MaintenanceStateRead, schedule: ScheduledServiceState = "eingerichtet") => evaluateMaintenance(r, schedule, NOW);

const SERVICE_RUN = { mode: "pruefen", startedAt: "", finishedAt: "", status: "ok" };
const SERVICE = { name: "Tunnel", manager: "launchd", target: "ai.tybo.t", outcome: "aktuell" };

/** Verschachtelte Felder, die der Nachtcheck auswertet; je Fall ein kaputter Inhalt */
const BROKEN_NESTED: Record<string, Record<string, unknown>> = {
  "Meldung mit unbekanntem Status": { notify: { status: "kaputt" } },
  "Meldung ohne Status": { notify: {} },
  "Meldung mit Detail als Zahl": { notify: { status: "fehlgeschlagen", detail: 1 } },
  "Fehler eines Postens keine Zeichenkette": { items: [{ title: "Caches", bytes: 1, errors: [1] }] },
  "Fehler eines Postens null": { items: [{ title: "Caches", bytes: 1, errors: [null] }] },
  "Dienstliste mit null": { services: { ...SERVICE_RUN, services: [null] } },
  "Dienstliste mit Text": { services: { ...SERVICE_RUN, services: ["Tunnel"] } },
  "Dienste mit unbekanntem Modus": { services: { ...SERVICE_RUN, mode: "kaputt", services: [] } },
  "Dienste mit Abbruch als Zahl": { services: { ...SERVICE_RUN, error: 1, services: [] } },
  "Dienst ohne Namen": { services: { ...SERVICE_RUN, services: [{ ...SERVICE, name: undefined }] } },
  "Dienst mit unbekanntem Ausgang": { services: { ...SERVICE_RUN, services: [{ ...SERVICE, outcome: "kaputt" }] } },
  "Dienst mit geerbtem Namen als Ausgang": { services: { ...SERVICE_RUN, services: [{ ...SERVICE, outcome: "constructor" }] } },
  "Dienst mit Detail als Zahl": { services: { ...SERVICE_RUN, services: [{ ...SERVICE, detail: 1 }] } },
  "Dienst mit Version als Zahl": { services: { ...SERVICE_RUN, services: [{ ...SERVICE, installed: 1 }] } },
  "Dienst mit laufender Version als Zahl": { services: { ...SERVICE_RUN, services: [{ ...SERVICE, running: 1 }] } },
  "Dienst mit früherer Version als Zahl": { services: { ...SERVICE_RUN, services: [{ ...SERVICE, previous: 1 }] } },
};

describe("evaluateMaintenance", () => {
  test("Dienst fehlt, kein Lauf: – nicht eingerichtet", () => {
    expect(evaluate({ status: "fehlt" }, "fehlt")).toEqual({ name: "Wartung", status: "na", detail: "nicht eingerichtet" });
  });

  test("Dienst fehlt, Lauf von Hand: – mit Angaben zum Lauf, auch nach 30 Tagen", () => {
    const r = evaluate(read(lastRun({ items: [item({ bytes: 2 * GB })] }, 30 * DAY)), "fehlt");
    expect(r.status).toBe("na");
    expect(r.detail).toBe("nicht eingerichtet, letzter Lauf vor 30 Tagen, 2 GB abgeräumt");
  });

  test("Dienst fehlt, Fehler und ungültige Datei: bleibt –, steht aber im Text", () => {
    const failed = evaluate(read(lastRun({ status: "fehler", items: [item({ status: "fehler", errors: ["kaputt"] })] })), "fehlt");
    expect(failed.status).toBe("na");
    expect(failed.detail).toContain("Caches: kaputt");
    const invalid = evaluate({ status: "ungueltig" }, "fehlt");
    expect(invalid.status).toBe("na");
    expect(invalid.detail).toBe("nicht eingerichtet, data/wartung.json ungültig");
  });

  test("eingerichtet, fehlende Datei heißt nicht „nicht eingerichtet“: ⚠️ noch kein Lauf", () => {
    const r = evaluate({ status: "fehlt" });
    expect(r.status).toBe("warn");
    expect(r.detail).toBe("eingerichtet, noch kein Lauf");
    expect(r.hint).toContain("tybo wartung");
  });

  test("ungültige Zustandsdatei: ⚠️", () => {
    const r = evaluate({ status: "ungueltig" });
    expect(r.status).toBe("warn");
    expect(r.detail).toBe("data/wartung.json ungültig");
    expect(r.hint).toContain("tybo wartung");
  });

  test("erfolgreicher Lauf: ✅ mit Alter und Summe der Posten, nicht freeAfter minus freeBefore", () => {
    const r = evaluate(read(lastRun({ freeBefore: 10 * GB, freeAfter: 99 * GB, items: [item({ bytes: GB }), item({ bytes: GB / 2 })] })));
    expect(r).toEqual({ name: "Wartung", status: "ok", detail: "letzter Lauf vor 2 Tagen, 1,5 GB abgeräumt" });
  });

  test("Lauf ohne abgeräumte Posten: „nichts abgeräumt“", () => {
    expect(evaluate(read(lastRun({ items: [item({ status: "nichts" })] }))).detail).toBe("letzter Lauf vor 2 Tagen, nichts abgeräumt");
  });

  test("genau 8 Tage: noch ✅; darüber ⚠️", () => {
    expect(evaluate(read(lastRun({}, 8 * DAY))).status).toBe("ok");
    const old = evaluate(read(lastRun({}, 8 * DAY + 1)));
    expect(old.status).toBe("warn");
    expect(old.detail).toContain("letzter Lauf vor 8 Tagen");
    expect(old.hint).toContain("logs/wartung.error.log");
  });

  test("Fehler bei einem Posten: ⚠️ mit Posten und Text", () => {
    const r = evaluate(read(lastRun({ status: "fehler", items: [item({ bytes: GB }), item({ title: "Logs", status: "fehler", errors: ["nicht lesbar"] })] })));
    expect(r.status).toBe("warn");
    expect(r.detail).toBe("letzter Lauf vor 2 Tagen, 1 GB abgeräumt; Fehler: Logs: nicht lesbar");
  });

  test("Abbruch: ⚠️ mit Grund", () => {
    const r = evaluate(read(lastRun({ status: "fehler", error: "config/wartung.json ungültig: x" })));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("Fehler: abgebrochen: config/wartung.json ungültig: x");
  });

  test("Fehler bei den Diensten: ⚠️, aus dem Abbruch wie aus der Einzelzeile", () => {
    const services: ServiceCheckRun = { mode: "neustart", startedAt: "", finishedAt: "", status: "fehler", services: [{ name: "Tunnel", manager: "launchd", target: "ai.tybo.t", outcome: "fehler", detail: "Neustart gescheitert" }] };
    const single = evaluate(read(lastRun({ status: "fehler", services })));
    expect(single.status).toBe("warn");
    expect(single.detail).toContain("Tunnel: FEHLER");
    expect(single.detail).toContain("Neustart gescheitert");
    const broken = evaluate(read(lastRun({ status: "fehler", services: { ...services, services: [], error: "Sperre belegt" } })));
    expect(broken.detail).toContain("Dienste: Sperre belegt");
  });

  test("Meldung nicht gesendet: ⚠️", () => {
    const r = evaluate(read(lastRun({ status: "fehler", notify: { status: "fehlgeschlagen", detail: "Telegram weg" } })));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("Meldung nicht gesendet: Telegram weg");
  });

  test("Status Fehler ohne Einzelangaben bleibt ⚠️", () => {
    const r = evaluate(read(lastRun({ status: "fehler" })));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("Fehler: siehe logs/wartung.log");
  });

  test("lange Fehlertexte werden gekürzt", () => {
    const r = evaluate(read(lastRun({ status: "fehler", items: [item({ status: "fehler", errors: ["x".repeat(1000)] })] })));
    expect(r.detail!.length).toBeLessThan(320);
    expect(r.detail!.endsWith("…")).toBe(true);
  });

  test("Dienst aus: ⚠️, auch nach einem guten Lauf", () => {
    const r = evaluate(read(lastRun()), "aus");
    expect(r.status).toBe("warn");
    expect(r.detail).toBe("Dienst eingerichtet, aber nicht aktiv, letzter Lauf vor 2 Tagen, nichts abgeräumt");
    expect(r.hint).toContain("tybo dienste wartung");
  });

  test("Dienst nicht feststellbar: ⚠️, nie grün und nie „nicht eingerichtet“", () => {
    const withRun = evaluate(read(lastRun()), "unbekannt");
    expect(withRun.status).toBe("warn");
    expect(withRun.detail).toBe("Dienst nicht prüfbar, letzter Lauf vor 2 Tagen, nichts abgeräumt");
    const without = evaluate({ status: "fehlt" }, "unbekannt");
    expect(without.status).toBe("warn");
    expect(without.detail).toBe("Dienst nicht prüfbar, noch kein Lauf");
  });

  test("System ohne Wartung: –", () => {
    expect(evaluate({ status: "fehlt" }, "nicht-verfuegbar")).toEqual({ name: "Wartung", status: "na", detail: "nur unter macOS und Linux" });
  });
});

describe("loadMaintenanceState", () => {
  const write = (r: string, content: string) => writeFileSync(join(r, "data", "wartung.json"), content);

  test("fehlende Datei und gültige Datei", async () => {
    const r = root();
    expect(await loadMaintenanceState(r)).toEqual({ status: "fehlt" });
    const state = { version: 1, lastRun: lastRun({ items: [item()] }) };
    write(r, JSON.stringify(state));
    expect(await loadMaintenanceState(r)).toEqual({ status: "ok", state: state as never });
    expect(await readMaintenanceState(r)).toEqual(state as never);
  });

  const broken: Record<string, string> = {
    "kein JSON": "{",
    "andere Version": JSON.stringify({ version: 2, lastRun: lastRun() }),
    "ohne lastRun": JSON.stringify({ version: 1 }),
    "Datum unlesbar": JSON.stringify({ version: 1, lastRun: lastRun({ finishedAt: "gestern" }) }),
    "Status unbekannt": JSON.stringify({ version: 1, lastRun: { ...lastRun(), status: "vielleicht" } }),
    "items keine Liste": JSON.stringify({ version: 1, lastRun: { ...lastRun(), items: "x" } }),
    "Posten ohne Bytes": JSON.stringify({ version: 1, lastRun: lastRun({ items: [{ title: "Caches", errors: [] } as unknown as ItemResult] }) }),
    "Posten mit Fehlern als Text": JSON.stringify({ version: 1, lastRun: lastRun({ items: [{ title: "Caches", bytes: 1, errors: "x" } as unknown as ItemResult] }) }),
    "Dienste ohne Liste": JSON.stringify({ version: 1, lastRun: lastRun({ services: {} as ServiceCheckRun }) }),
    ...Object.fromEntries(Object.entries(BROKEN_NESTED).map(([label, over]) => [label, JSON.stringify({ version: 1, lastRun: { ...lastRun(), ...over } })])),
  };
  for (const [label, content] of Object.entries(broken)) {
    test(`ungültig: ${label}`, async () => {
      const r = root();
      write(r, content);
      expect(await loadMaintenanceState(r)).toEqual({ status: "ungueltig" });
      expect(await readMaintenanceState(r)).toBeNull();
    });
  }

  test("gültig: Lauf mit Fehlern, Meldung und allen Angaben zu einem Dienst", async () => {
    const r = root();
    const services: ServiceCheckRun = { mode: "neustart", startedAt: "", finishedAt: "", status: "fehler", services: [{ name: "Tunnel", manager: "launchd", target: "ai.tybo.t", outcome: "fehler", installed: "2", running: "1", previous: "1", detail: "Neustart gescheitert" }] };
    const state = { version: 1, lastRun: lastRun({ status: "fehler", notify: { status: "fehlgeschlagen", detail: "Telegram weg" }, items: [item({ errors: ["kaputt"] })], services }) };
    write(r, JSON.stringify(state));
    expect(await loadMaintenanceState(r)).toEqual({ status: "ok", state: state as never });
  });

  test("nicht lesbar (Ordner statt Datei): ungültig, nicht „fehlt“", async () => {
    const r = root();
    mkdirSync(join(r, "data", "wartung.json"));
    expect(await loadMaintenanceState(r)).toEqual({ status: "ungueltig" });
  });
});

describe("detectScheduledService", () => {
  type Answers = Record<string, Partial<ServiceRun>>;

  function deps(platform: NodeJS.Platform, answers: Answers, files: string[] = []): DetectDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      platform,
      launchAgentsDir: "/home/LaunchAgents",
      unitDir: "/home/units",
      runDir: "/run/systemd/system",
      exists: path => files.includes(path),
      async run(cmd) {
        const key = cmd[0];
        calls.push(cmd.join(" "));
        const answer = answers[key];
        if (!answer) return { ok: false, stdout: "", stderr: "not found", missing: true };
        return { ok: true, stdout: "", stderr: "", ...answer };
      },
    };
  }

  const PLIST = "/home/LaunchAgents/ai.tybo.wartung.plist";
  const LOADED = "-\t0\tai.tybo.wartung\n123\t0\tai.tybo.telegram-relay";
  const OTHER = "-\t0\tai.tybo.wartung-alt";
  const RUN_DIR = "/run/systemd/system";
  const TIMER = "/home/units/tybo-wartung.timer";
  const on = "LoadState=loaded\nActiveState=active\nUnitFileState=enabled";
  const off = "LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled";
  const absent = "LoadState=not-found\nActiveState=inactive\nUnitFileState=";
  const CRON = "15 3 * * 0 cd /x && bun run src/maintenance.ts # tybo-wartung";

  describe("launchd", () => {
    const cases: [string, Answers, string[], ScheduledServiceState][] = [
      ["geladen", { launchctl: { stdout: LOADED } }, [PLIST], "eingerichtet"],
      ["geladen, Plist schon gelöscht", { launchctl: { stdout: LOADED } }, [], "eingerichtet"],
      ["Plist da, nicht geladen", { launchctl: { stdout: OTHER } }, [PLIST], "aus"],
      ["weder geladen noch Plist; ähnlicher Name zählt nicht", { launchctl: { stdout: OTHER } }, [], "fehlt"],
      ["launchctl scheitert, Plist da", { launchctl: { ok: false } }, [PLIST], "unbekannt"],
      ["launchctl scheitert, keine Plist", { launchctl: { ok: false } }, [], "fehlt"],
    ];
    for (const [label, answers, files, expected] of cases) {
      test(`${label}: ${expected}`, async () => {
        expect(await detectScheduledService("wartung", deps("darwin", answers, files))).toBe(expected);
      });
    }
  });

  describe("Linux mit systemd", () => {
    const cases: [string, Answers, string[], ScheduledServiceState][] = [
      ["Timer aktiv und aktiviert", { systemctl: { stdout: on } }, [RUN_DIR, TIMER], "eingerichtet"],
      ["Timer abgeschaltet", { systemctl: { stdout: off } }, [RUN_DIR, TIMER], "aus"],
      ["kein Timer, cron-Zeile noch da", { systemctl: { stdout: absent }, crontab: { stdout: CRON } }, [RUN_DIR], "eingerichtet"],
      ["kein Timer, keine cron-Zeile", { systemctl: { stdout: absent }, crontab: { ok: false, stderr: "no crontab for x" } }, [RUN_DIR], "fehlt"],
      ["Benutzer-Manager antwortet nicht, Einheit da", { systemctl: { ok: false } }, [RUN_DIR, TIMER], "unbekannt"],
      ["Benutzer-Manager antwortet nicht, keine Einheit, crontab lesbar", { systemctl: { ok: false }, crontab: { stdout: "" } }, [RUN_DIR], "fehlt"],
      ["kein Timer, crontab unlesbar", { systemctl: { stdout: absent }, crontab: { ok: false, stderr: "Zugriff verweigert" } }, [RUN_DIR], "unbekannt"],
    ];
    for (const [label, answers, files, expected] of cases) {
      test(`${label}: ${expected}`, async () => {
        expect(await detectScheduledService("wartung", deps("linux", answers, files))).toBe(expected);
      });
    }
  });

  describe("Linux ohne systemd", () => {
    const cases: [string, Answers, ScheduledServiceState][] = [
      ["cron-Zeile", { crontab: { stdout: `0 1 * * * andere\n${CRON}` } }, "eingerichtet"],
      ["auskommentierte Zeile läuft nie", { crontab: { stdout: `# ${CRON}` } }, "fehlt"],
      ["fremde Zeile mit ähnlichem Namen", { crontab: { stdout: "0 1 * * * x # tybo-wartung-alt" } }, "fehlt"],
      ["keine crontab", { crontab: { ok: false, stderr: "no crontab for x" } }, "fehlt"],
      ["crontab nicht installiert", {}, "fehlt"],
      ["crontab unlesbar", { crontab: { ok: false, stderr: "Zugriff verweigert" } }, "unbekannt"],
    ];
    for (const [label, answers, expected] of cases) {
      test(`${label}: ${expected}`, async () => {
        const d = deps("linux", answers);
        expect(await detectScheduledService("wartung", d)).toBe(expected);
        expect(d.calls.some(c => c.startsWith("systemctl"))).toBe(false);
      });
    }
  });

  test("anderes System: nicht verfügbar, kein Befehl", async () => {
    const d = deps("win32", {});
    expect(await detectScheduledService("wartung", d)).toBe("nicht-verfuegbar");
    expect(d.calls).toEqual([]);
  });
});

describe("Einbindung in den Nachtcheck", () => {
  const DIENSTE = [{ name: "Cloudflare-Tunnel", launchd: "ai.tybo.cloudflare-tunnel", versionBefehl: ["cloudflared", "--version"], metrik: { url: "http://127.0.0.1:20241/metrics" }, wartezeitSek: 10 }];

  function checks(maintenance: MaintenanceCheckDeps) {
    return plannedChecks({ withModel: false, env: {}, now: NOW, state: { logs: {} }, nextState: { logs: {} }, maintenance });
  }

  /** Führt nur diese Prüfungen aus; alle anderen griffen nach außen */
  async function report(maintenance: MaintenanceCheckDeps, names: string[]): Promise<string> {
    const selected = checks(maintenance).filter(c => names.includes(c.name));
    const groups = await Promise.all(selected.map(c => runCheck(c.name, c.fn, c.timeoutMs)));
    return formatReport(groups.flat(), new Date(NOW));
  }

  test("beide Prüfungen sind registriert, je einmal", () => {
    const names = checks({ root: "/gibt/es/nicht", schedule: async () => "fehlt", services: fake().deps }).map(c => c.name);
    for (const name of ["Plattenplatz", "Wartung", "Dienst-Versionen"]) expect(names.filter(n => n === name)).toEqual([name]);
  });

  test("Report: Wartung und veralteter Dienst als ⚠️, kein Neustart und keine Neustart-Anfrage", async () => {
    const r = root();
    writeFileSync(join(r, "config", "wartung.json"), JSON.stringify({ dienste: DIENSTE }));
    writeFileSync(join(r, "data", "wartung.json"), JSON.stringify({ version: 1, lastRun: lastRun({ items: [item({ bytes: GB })] }, 9 * DAY) }));
    const s = fake(r);
    const text = await report({ root: r, schedule: async () => "eingerichtet", services: s.deps }, ["Wartung", "Dienst-Versionen"]);
    expect(text).toContain("2 Warnungen");
    expect(text).toContain("⚠️ Wartung: letzter Lauf vor 9 Tagen, 1 GB abgeräumt");
    expect(text).toContain("⚠️ Dienst-Versionen: Cloudflare-Tunnel: läuft 2026.10.0, installiert 2026.10.3");
    expect(s.restarts).toEqual([]);
    expect(s.botRequests).toEqual([]);
    expect(s.calls.some(c => c.includes("kickstart") || c.includes("restart"))).toBe(false);
  });

  test("Report: erfolgreicher Lauf ✅, Dienst fehlt –", async () => {
    const r = root();
    writeFileSync(join(r, "data", "wartung.json"), JSON.stringify({ version: 1, lastRun: lastRun({ items: [item({ bytes: GB })] }) }));
    const s = fake(r);
    const ok = await report({ root: r, schedule: async () => "eingerichtet", services: s.deps }, ["Wartung"]);
    expect(ok).toContain("✅ Wartung: letzter Lauf vor 2 Tagen, 1 GB abgeräumt");
    const none = await report({ root: root(), schedule: async () => "fehlt", services: s.deps }, ["Wartung"]);
    expect(none).toContain("– Wartung: nicht eingerichtet");
    expect(none).toContain("alles grün");
  });

  for (const [label, over] of Object.entries(BROKEN_NESTED)) {
    test(`Report bei eingerichtetem Dienst, ${label}: ⚠️ ungültige Zustandsdatei, nie ✅ oder TypeError`, async () => {
      const r = root();
      writeFileSync(join(r, "data", "wartung.json"), JSON.stringify({ version: 1, lastRun: { ...lastRun(), ...over } }));
      const text = await report({ root: r, schedule: async () => "eingerichtet", services: fake(r).deps }, ["Wartung"]);
      expect(text).toContain("⚠️ Wartung: data/wartung.json ungültig");
      expect(text).toContain("1 Warnung");
      expect(text).not.toContain("✅");
      expect(text).not.toContain("❌");
      expect(text).not.toContain("TypeError");
    });
  }

  test("Erkennung wirft: die Zeile wird ❌ statt den Nachtcheck zu stoppen", async () => {
    const s = fake(root());
    const text = await report({ root: root(), schedule: async () => { throw new Error("kaputt"); }, services: s.deps }, ["Wartung"]);
    expect(text).toContain("❌ Wartung");
  });
});
