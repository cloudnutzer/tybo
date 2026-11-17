/**
 * Issue #568: Nachtcheck-Zeilen „Bot-Prozess“ (launchd, systemd, PM2) und
 * „Bot antwortet“ (Health-Port). systemctl, launchctl, der PM2-Daemon und
 * fetch sind Attrappen; kein Test ruft einen echten Dienstverwalter oder
 * den Health-Port des laufenden Bots auf.
 */

import { describe, expect, test } from "bun:test";
import { checkBotProcess, checkHealthPort, healthPort, parseSystemctlShow, type BotAliveDeps, type CommandResult } from "../src/lib/health/bot-alive";
import type { Pm2Query } from "../src/lib/routines/sources/pm2-rpc";
import { HEALTH_SERVICE } from "../src/app/health-server";
import { HEALTH_SERVICE_ID } from "../src/lib/service-names";

/** Ausgabe von `systemctl --user show tybo-telegram-relay.service` */
const SHOW = {
  running: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\nExecMainStatus=0\n",
  failed: "LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nExecMainStatus=1\n",
  inactive: "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nExecMainStatus=0\n",
  activating: "LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nMainPID=0\nExecMainStatus=1\n",
  notFound: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nExecMainStatus=0\n",
};

/** Eintrag aus der Prozessliste des PM2-Daemons (getMonitorData, wie pm2 jlist) */
const pm2Proc = (name: string, status: string, pid: number) => ({ name, pid, pm2_env: { status, restart_time: 3, cron_restart: undefined } });

function deps(options: { platform?: NodeJS.Platform; systemd?: boolean; show?: CommandResult; pm2?: Pm2Query; launchctl?: string } = {}) {
  const calls: string[] = [];
  const d: BotAliveDeps = {
    platform: options.platform ?? "linux",
    async launchctlList() {
      calls.push("launchctl list");
      return options.launchctl ?? "";
    },
    systemdBooted: () => options.systemd ?? true,
    async systemctlShow(unit, props) {
      calls.push(`systemctl show ${unit} ${props.join(",")}`);
      return options.show ?? { ok: true, stdout: SHOW.notFound };
    },
    async pm2Query() {
      calls.push("pm2 query");
      return options.pm2 ?? { status: "not-running" };
    },
    async fetch() {
      throw new Error("kein Netz im Test");
    },
  };
  return { d, calls };
}

describe("Bot-Prozess unter Linux: systemd", () => {
  test("läuft: ✅ mit PID, PM2 wird nicht gefragt", async () => {
    const { d, calls } = deps({ show: { ok: true, stdout: SHOW.running } });
    expect(await checkBotProcess(d)).toEqual({ name: "Bot-Prozess", status: "ok", detail: "läuft unter systemd (PID 4242)" });
    expect(calls).toEqual(["systemctl show tybo-telegram-relay.service LoadState,ActiveState,SubState,MainPID,ExecMainStatus"]);
  });

  test("gestoppt oder abgestürzt: ❌ mit Zustand, Exit-Code und Befehl zum Nachsehen", async () => {
    const failed = await checkBotProcess(deps({ show: { ok: true, stdout: SHOW.failed } }).d);
    expect(failed.status).toBe("fail");
    expect(failed.detail).toBe("systemd-Dienst tybo-telegram-relay.service läuft nicht (failed/failed, letzter Exit 1)");
    expect(failed.hint).toContain("systemctl --user status tybo-telegram-relay.service");
    const stopped = await checkBotProcess(deps({ show: { ok: true, stdout: SHOW.inactive } }).d);
    expect(stopped.status).toBe("fail");
    expect(stopped.detail).toBe("systemd-Dienst tybo-telegram-relay.service läuft nicht (inactive/dead)");
  });

  test("startet gerade neu: ⚠️, nicht ❌", async () => {
    const r = await checkBotProcess(deps({ show: { ok: true, stdout: SHOW.activating } }).d);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("auto-restart");
  });
});

describe("Bot-Prozess unter Linux: PM2", () => {
  test("systemd kennt den Bot nicht, PM2 online: ✅ mit PID", async () => {
    const { d, calls } = deps({ pm2: { status: "ok", processes: [pm2Proc("tybo-supabase", "online", 7), pm2Proc("tybo-telegram-relay", "online", 99)] } });
    expect(await checkBotProcess(d)).toEqual({ name: "Bot-Prozess", status: "ok", detail: "läuft unter PM2 (PID 99)" });
    expect(calls).toContain("pm2 query");
  });

  test("ohne systemd auf dem Rechner: systemctl wird nicht gefragt", async () => {
    const { d, calls } = deps({ systemd: false, pm2: { status: "ok", processes: [pm2Proc("tybo-telegram-relay", "online", 99)] } });
    expect((await checkBotProcess(d)).status).toBe("ok");
    expect(calls).toEqual(["pm2 query"]);
  });

  test("gestoppter oder abgestürzter Prozess: ❌ mit Status und pm2 logs", async () => {
    for (const status of ["stopped", "errored"]) {
      const r = await checkBotProcess(deps({ pm2: { status: "ok", processes: [pm2Proc("tybo-telegram-relay", status, 0)] } }).d);
      expect(r.status).toBe("fail");
      expect(r.detail).toBe(`PM2-Prozess tybo-telegram-relay läuft nicht (Status ${status})`);
      expect(r.hint).toBe("pm2 logs tybo-telegram-relay ansehen");
    }
  });

  test("fremde Prozesse ähnlichen Namens zählen nicht", async () => {
    const r = await checkBotProcess(deps({ pm2: { status: "ok", processes: [pm2Proc("tybo-telegram-relay-alt", "online", 5), pm2Proc("go-telegram-relay", "online", 6)] } }).d);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("kein Dienst für den Bot");
  });
});

describe("Bot-Prozess unter Linux: fehlend und nicht prüfbar getrennt", () => {
  test("Dienst fehlt (systemd kennt ihn nicht, PM2 läuft nicht): ❌ mit tybo setup autostart", async () => {
    const r = await checkBotProcess(deps().d);
    expect(r.status).toBe("fail");
    expect(r.detail).toBe("kein Dienst für den Bot (weder systemd tybo-telegram-relay.service noch PM2 tybo-telegram-relay)");
    expect(r.hint).toBe("tybo setup autostart");
  });

  test("Dienst fehlt auch in einer lesbaren PM2-Liste: ❌", async () => {
    const r = await checkBotProcess(deps({ pm2: { status: "ok", processes: [] } }).d);
    expect(r.status).toBe("fail");
  });

  test("systemctl --user antwortet nicht und PM2 kennt den Bot nicht: ⚠️ nicht prüfbar, nie ✅", async () => {
    const r = await checkBotProcess(deps({ show: { ok: false, stdout: "" } }).d);
    expect(r.status).toBe("warn");
    expect(r.detail).toBe("nicht prüfbar: systemctl --user antwortet nicht");
  });

  test("PM2-Liste nicht lesbar: ⚠️ nicht prüfbar", async () => {
    const r = await checkBotProcess(deps({ pm2: { status: "failed" } }).d);
    expect(r.status).toBe("warn");
    expect(r.detail).toBe("nicht prüfbar: PM2 liefert keine lesbare Prozessliste");
  });

  test("beide nicht prüfbar: beide Gründe", async () => {
    const r = await checkBotProcess(deps({ show: { ok: false, stdout: "" }, pm2: { status: "failed" } }).d);
    expect(r.detail).toBe("nicht prüfbar: systemctl --user antwortet nicht, PM2 liefert keine lesbare Prozessliste");
  });

  test("systemctl nicht nicht prüfbar, aber PM2 kennt den Bot: dessen Urteil", async () => {
    const r = await checkBotProcess(deps({ show: { ok: false, stdout: "" }, pm2: { status: "ok", processes: [pm2Proc("tybo-telegram-relay", "online", 12)] } }).d);
    expect(r.status).toBe("ok");
  });

  test("systemctl fehlt ganz: wie kein systemd", async () => {
    const r = await checkBotProcess(deps({ show: { ok: false, stdout: "", missing: true } }).d);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("kein Dienst");
  });

  test("Abfragen, die werfen, zählen als nicht prüfbar", async () => {
    const { d } = deps();
    d.systemctlShow = async () => {
      throw new Error("x");
    };
    d.pm2Query = async () => {
      throw new Error("y");
    };
    expect((await checkBotProcess(d)).status).toBe("warn");
  });
});

describe("Bot-Prozess unter macOS und anderswo", () => {
  test("launchd wie bisher: läuft, steht, nicht geladen", async () => {
    expect((await checkBotProcess(deps({ platform: "darwin", launchctl: "123\t0\tai.tybo.telegram-relay" }).d)).detail).toBe("läuft (PID 123)");
    const stopped = await checkBotProcess(deps({ platform: "darwin", launchctl: "-\t78\tai.tybo.telegram-relay" }).d);
    expect(stopped.status).toBe("fail");
    expect(stopped.detail).toBe("geladen, läuft aber nicht (letzter Exit 78)");
    const missing = await checkBotProcess(deps({ platform: "darwin", launchctl: "5\t0\tai.tybo.health-check" }).d);
    expect(missing.status).toBe("fail");
    expect(missing.detail).toBe("ai.tybo.telegram-relay nicht geladen");
  });

  test("Windows: –", async () => {
    expect((await checkBotProcess(deps({ platform: "win32" }).d)).status).toBe("na");
  });

  test("parseSystemctlShow liest Name=Wert, auch mit = im Wert", () => {
    expect(parseSystemctlShow("A=1\nB=x=y\n\nkaputt")).toEqual({ A: "1", B: "x=y" });
  });
});

// ---------------------------------------------------------------------------
// Health-Port
// ---------------------------------------------------------------------------

function fetchDeps(reply: (url: string, init: RequestInit) => Promise<Response>) {
  const seen: { url: string; init: RequestInit }[] = [];
  return {
    seen,
    deps: {
      fetch: (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return reply(url, init);
      },
    },
  };
}

const healthBody = (extra: Record<string, unknown> = {}) => JSON.stringify({ status: "ok", service: HEALTH_SERVICE_ID, uptime: 7200, pid: 1, ...extra });

describe("Bot antwortet (Health-Port)", () => {
  test("Kennung im Bot und im Nachtcheck dieselbe", () => {
    expect(HEALTH_SERVICE).toBe(HEALTH_SERVICE_ID);
  });

  test("nur 127.0.0.1 mit HEALTH_PORT, ohne Weiterleitungen, mit Zeitlimit; ✅ mit Laufzeit", async () => {
    const f = fetchDeps(async () => new Response(healthBody(), { status: 200 }));
    const r = await checkHealthPort({ HEALTH_PORT: "3456" }, f.deps);
    expect(r).toEqual({ name: "Bot antwortet", status: "ok", detail: "Port 3456, läuft seit 2 Std" });
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0].url).toBe("http://127.0.0.1:3456/health");
    expect(f.seen[0].init.redirect).toBe("manual");
    expect(f.seen[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test("Standardport 3000 wie der Health-Server", async () => {
    const f = fetchDeps(async () => new Response(healthBody(), { status: 200 }));
    await checkHealthPort({}, f.deps);
    expect(f.seen[0].url).toBe("http://127.0.0.1:3000/health");
    expect(healthPort({ HEALTH_PORT: "abc" })).toBeNull();
    expect(healthPort({ HEALTH_PORT: "70000" })).toBeNull();
  });

  test("Verbindungsfehler: ❌ der Bot läuft nicht", async () => {
    const f = fetchDeps(async () => {
      throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
    });
    const r = await checkHealthPort({}, f.deps);
    expect(r.status).toBe("fail");
    expect(r.detail).toBe("Port 3000: keine Verbindung, der Bot läuft nicht");
  });

  test("Zeitüberschreitung: ❌ keine Antwort", async () => {
    const f = fetchDeps(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const r = await checkHealthPort({}, f.deps);
    expect(r.status).toBe("fail");
    expect(r.detail).toBe("Port 3000: keine Antwort nach 5 s");
  });

  test("fremde Antwort: ❌ nicht der Health-Server (andere Kennung, kein JSON, anderer Status, Weiterleitung)", async () => {
    const replies = [
      new Response(JSON.stringify({ status: "ok", service: "anderer-dienst" }), { status: 200 }),
      new Response("<html>Hallo</html>", { status: 200 }),
      new Response(healthBody(), { status: 500 }),
      new Response(null, { status: 302, headers: { location: "http://example.com/" } }),
    ];
    const details: string[] = [];
    for (const reply of replies) {
      const r = await checkHealthPort({}, fetchDeps(async () => reply).deps);
      expect(r.status).toBe("fail");
      details.push(r.detail!);
    }
    expect(details).toEqual([
      "Port 3000: unbekannte Antwort, nicht der Health-Server von tybo",
      "Port 3000: unbekannte Antwort, nicht der Health-Server von tybo",
      "Port 3000: HTTP 500, nicht der Health-Server von tybo",
      "Port 3000: HTTP 302, nicht der Health-Server von tybo",
    ]);
  });

  test("ungültiger HEALTH_PORT: ❌ ohne Abfrage", async () => {
    const f = fetchDeps(async () => new Response(healthBody()));
    const r = await checkHealthPort({ HEALTH_PORT: "drei" }, f.deps);
    expect(r.status).toBe("fail");
    expect(f.seen).toHaveLength(0);
  });

  test("HEALTH_HOST nicht auf 127.0.0.1: – ohne Abfrage", async () => {
    const f = fetchDeps(async () => new Response(healthBody()));
    expect((await checkHealthPort({ HEALTH_HOST: "10.0.0.5" }, f.deps)).status).toBe("na");
    expect(f.seen).toHaveLength(0);
    for (const host of ["127.0.0.1", "localhost", "0.0.0.0"]) {
      expect((await checkHealthPort({ HEALTH_HOST: host }, fetchDeps(async () => new Response(healthBody())).deps)).status).toBe("ok");
    }
  });
});
