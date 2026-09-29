/**
 * Issue #207, Checkbox 1 und 3: systemd-Erkennung, Dienstdatei,
 * Deinstallation und setup:verify. systemctl, loginctl und which sind
 * Attrappen; Dateien landen im Speicher oder in einem Temp-Ordner.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureLinger,
  installSystemdService,
  lingerCommand,
  lingerState,
  parseShow,
  renderSystemdUnit,
  systemdBooted,
  systemdUnitPath,
  systemdUnitState,
  unitPathOk,
  type SystemdDeps,
} from "../setup/configure-systemd";
import { LINGER_LEFT_ON, runUninstall, uninstallPM2, uninstallSystemd } from "../setup/uninstall";
import { checkSystemdService } from "../setup/verify";

type Answer = { ok?: boolean; stdout?: string; stderr?: string };

function fakeSystemd(answers: Record<string, Answer> = {}, files = new Map<string, string>()) {
  const calls: string[] = [];
  const dirs: string[] = [];
  const deps: SystemdDeps = {
    projectRoot: "/home/alex/tybo",
    home: "/home/alex",
    unitDir: "/home/alex/.config/systemd/user",
    runDir: "/run/systemd/system",
    user: "alex",
    run: async cmd => {
      const line = cmd.join(" ");
      calls.push(line);
      const key = Object.keys(answers)
        .sort((a, b) => b.length - a.length)
        .find(k => line.startsWith(k));
      if (!key) return { ok: false, stdout: "", stderr: "Befehl nicht gefunden" };
      return { ok: true, stdout: "", stderr: "", ...answers[key] };
    },
    exists: path => files.has(path) || dirs.includes(path),
    writeFile: (path, content) => void files.set(path, content),
    mkdir: path => void dirs.push(path),
  };
  return { deps, calls, files, dirs };
}

const WHICH = { "which bun": { stdout: "/home/alex/.bun/bin/bun" }, "which claude": { stdout: "/home/alex/.local/bin/claude" } };
const SHOW = "systemctl --user show tybo-telegram-relay.service";
const show = (load: string, active: string, file: string) => ({ stdout: `LoadState=${load}\nActiveState=${active}\nUnitFileState=${file}` });

describe("Dienstdatei", () => {
  test("Restart=always, Arbeitsordner, Bun und Claude im PATH, Protokoll in logs/", () => {
    const unit = renderSystemdUnit({ projectRoot: "/home/alex/tybo", home: "/home/alex", bunPath: "/home/alex/.bun/bin/bun", claudeDir: "/opt/claude/bin" })!;
    expect(unit).toContain("\nRestart=always\n");
    expect(unit).toContain("\nWorkingDirectory=/home/alex/tybo\n");
    expect(unit).toContain("\nExecStart=/home/alex/.bun/bin/bun run src/bot.ts\n");
    expect(unit).toContain("\nEnvironment=PATH=/home/alex/.bun/bin:/opt/claude/bin:/home/alex/.local/bin:/usr/local/bin:/usr/bin:/bin\n");
    expect(unit).toContain("\nEnvironment=TYBO_SYSTEMD_UNIT=tybo-telegram-relay.service\n");
    expect(unit).toContain("\nStandardOutput=append:/home/alex/tybo/logs/telegram-relay.log\n");
    expect(unit).toContain("\nStandardError=append:/home/alex/tybo/logs/telegram-relay.error.log\n");
    expect(unit).toContain("\nWantedBy=default.target\n");
    expect(unit).toContain("\nStartLimitIntervalSec=0\n");
    // Kein fest eingebautes %h/tybo aus dem VM-Beispiel
    expect(unit).not.toContain("%h");
  });

  test("Projektordner woanders: der tatsächliche Ordner steht drin", () => {
    const unit = renderSystemdUnit({ projectRoot: "/srv/bots/tybo-2", home: "/home/mia", bunPath: "/usr/local/bin/bun" })!;
    expect(unit).toContain("WorkingDirectory=/srv/bots/tybo-2\n");
    expect(unit).toContain("Environment=PATH=/usr/local/bin:/home/mia/.bun/bin:/home/mia/.local/bin:/usr/bin:/bin\n");
  });

  test("Pfade mit Leerzeichen, %, $, Anführungszeichen oder : werden abgelehnt", () => {
    for (const bad of ["/home/alex/mein tybo", "/home/alex/100%", "/home/$USER/tybo", '/home/alex/"x"', "/home/alex/a:b", "relativ/tybo"]) {
      expect(unitPathOk(bad)).toBe(false);
      expect(renderSystemdUnit({ projectRoot: bad, home: "/home/alex", bunPath: "/usr/bin/bun" })).toBeNull();
    }
    expect(unitPathOk("/home/jörg/tybo")).toBe(true);
  });
});

describe("Erkennung", () => {
  test("systemd nur mit /run/systemd/system", () => {
    const { deps, dirs } = fakeSystemd();
    expect(systemdBooted(deps)).toBe(false);
    dirs.push("/run/systemd/system");
    expect(systemdBooted(deps)).toBe(true);
  });

  test("parseShow liest Name=Wert", () => {
    expect(parseShow("LoadState=loaded\nActiveState=active\nX=a=b")).toEqual({ LoadState: "loaded", ActiveState: "active", X: "a=b" });
  });

  test("Benutzer-Manager nicht erreichbar", async () => {
    const { deps } = fakeSystemd({ [SHOW]: { ok: false, stderr: "Failed to connect to bus: No medium found" } });
    expect(await systemdUnitState(deps)).toEqual({ reachable: false, fileExists: false });
  });

  test("Zustände: fehlt, läuft und aktiviert, läuft ohne Aktivierung, wartet auf Neustart", async () => {
    const cases: Array<[Answer, { loaded: boolean; active: boolean; enabled: boolean }]> = [
      [show("not-found", "inactive", ""), { loaded: false, active: false, enabled: false }],
      [show("loaded", "active", "enabled"), { loaded: true, active: true, enabled: true }],
      [show("loaded", "active", "disabled"), { loaded: true, active: true, enabled: false }],
      [show("loaded", "activating", "enabled"), { loaded: true, active: true, enabled: true }],
      [show("loaded", "failed", "enabled"), { loaded: true, active: false, enabled: true }],
    ];
    for (const [answer, expected] of cases) {
      const { deps } = fakeSystemd({ [SHOW]: answer });
      expect(await systemdUnitState(deps)).toEqual({ reachable: true, fileExists: false, ...expected });
    }
  });
});

describe("Einrichten", () => {
  test("schreibt die Datei, legt logs/ an, daemon-reload, enable --now", async () => {
    const { deps, calls, files, dirs } = fakeSystemd({ ...WHICH, "systemctl --user daemon-reload": {}, "systemctl --user enable --now": {} });
    expect(await installSystemdService(deps)).toEqual({ ok: true });
    expect(dirs).toContain("/home/alex/tybo/logs");
    const unit = files.get(systemdUnitPath(deps.unitDir))!;
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("/home/alex/.local/bin");
    expect(calls).toEqual(["which bun", "which claude", "systemctl --user daemon-reload", "systemctl --user enable --now tybo-telegram-relay"]);
  });

  test("CLAUDE_PATH mit festem Pfad: dessen Ordner im PATH, kein which claude", async () => {
    const { deps, calls, files } = fakeSystemd({ ...WHICH, "systemctl --user": {} });
    await installSystemdService(deps, "/opt/claude/bin/claude");
    expect(files.get(systemdUnitPath(deps.unitDir))).toContain(":/opt/claude/bin:");
    expect(calls).not.toContain("which claude");
  });

  test("ohne Bun: nichts geschrieben, nichts gestartet", async () => {
    const { deps, calls, files } = fakeSystemd({ "systemctl --user": {} });
    expect(await installSystemdService(deps)).toEqual({ ok: false, reason: "no-bun" });
    expect(files.size).toBe(0);
    expect(calls.some(c => c.startsWith("systemctl"))).toBe(false);
  });

  test("enable scheitert: ehrlicher Grund", async () => {
    const { deps } = fakeSystemd({ ...WHICH, "systemctl --user daemon-reload": {}, "systemctl --user enable": { ok: false } });
    expect(await installSystemdService(deps)).toEqual({ ok: false, reason: "enable" });
  });
});

describe("Linger", () => {
  const STATE = "loginctl show-user alex --property=Linger --value";

  test("schon an: kein enable-linger", async () => {
    const { deps, calls } = fakeSystemd({ [STATE]: { stdout: "yes" } });
    expect(await ensureLinger(deps)).toBe("already");
    expect(calls).toEqual([STATE]);
  });

  test("ohne sudo eingeschaltet und nachgeprüft", async () => {
    let on = false;
    const { deps, calls } = fakeSystemd();
    deps.run = async cmd => {
      calls.push(cmd.join(" "));
      if (cmd[1] === "enable-linger") {
        on = true;
        return { ok: true, stdout: "", stderr: "" };
      }
      return { ok: true, stdout: on ? "yes" : "no", stderr: "" };
    };
    expect(await ensureLinger(deps)).toBe("enabled");
    expect(calls).toEqual([STATE, "loginctl enable-linger alex", STATE]);
    expect(calls.some(c => c.includes("sudo"))).toBe(false);
  });

  test("Berechtigung fehlt: needs-sudo, kein sudo-Aufruf", async () => {
    const { deps, calls } = fakeSystemd({ [STATE]: { stdout: "no" }, "loginctl enable-linger": { ok: false, stderr: "Access denied" } });
    expect(await ensureLinger(deps)).toBe("needs-sudo");
    expect(calls.some(c => c.includes("sudo"))).toBe(false);
  });

  test("andere Fehler als fehlende Berechtigung: failed, nicht needs-sudo", async () => {
    for (const stderr of ["Failed to connect to bus: No such file or directory", "Failed to look up user alex: No such process", ""]) {
      const { deps } = fakeSystemd({ [STATE]: { stdout: "no" }, "loginctl enable-linger": { ok: false, stderr } });
      expect(await ensureLinger(deps)).toBe("failed");
    }
    for (const stderr of ["Could not enable linger: Access denied", "Interactive authentication required.", "Failed: Permission denied"]) {
      const { deps } = fakeSystemd({ [STATE]: { stdout: "no" }, "loginctl enable-linger": { ok: false, stderr } });
      expect(await ensureLinger(deps)).toBe("needs-sudo");
    }
  });

  test("lief durch, Nachprüfung sagt nicht yes: unverified", async () => {
    const { deps } = fakeSystemd({ [STATE]: { ok: false }, "loginctl enable-linger": {} });
    expect(await lingerState(deps)).toBe("unknown");
    expect(await ensureLinger(deps)).toBe("unverified");
  });

  test("sudo-Befehl mit Anmeldename, bei seltsamen Namen $USER", () => {
    expect(lingerCommand("alex")).toBe("sudo loginctl enable-linger alex");
    expect(lingerCommand("a; rm -rf /")).toBe("sudo loginctl enable-linger $USER");
    expect(lingerCommand("")).toBe("sudo loginctl enable-linger $USER");
  });
});

// ---------------------------------------------------------------------------
// Checkbox 3: Deinstallation und setup:verify
// ---------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "tybo-systemd-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  return fn()
    .then(result => ({ result, out: lines.join("\n") }))
    .finally(() => (console.log = log));
}

describe("Deinstallation", () => {
  test("Dienst da: disable --now, Datei weg, daemon-reload; Linger bleibt, kein sudo", async () => {
    const dir = join(tmp, "unit-da");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "tybo-telegram-relay.service");
    writeFileSync(file, "[Service]\n");
    const calls: string[] = [];
    const { result, out } = await quiet(() =>
      uninstallSystemd(dir, async cmd => {
        calls.push(cmd.join(" "));
        return { ok: true, stdout: "", stderr: "" };
      }),
    );
    expect(result).toBe("removed");
    expect(existsSync(file)).toBe(false);
    expect(calls).toEqual(["systemctl --user disable --now tybo-telegram-relay", "systemctl --user daemon-reload"]);
    expect(calls.some(c => c.includes("linger") || c.includes("sudo"))).toBe(false);
    expect(out).toContain(LINGER_LEFT_ON);
  });

  test("kein Dienst: nichts aufgerufen", async () => {
    const calls: string[] = [];
    const { result } = await quiet(() =>
      uninstallSystemd(join(tmp, "leer"), async cmd => {
        calls.push(cmd.join(" "));
        return { ok: true, stdout: "", stderr: "" };
      }),
    );
    expect(result).toBe("none");
    expect(calls).toEqual([]);
  });

  /** Dienstdatei im Temp-Ordner; systemctl antwortet nach answers, Löschen über eine Attrappe */
  function unitWith(name: string) {
    const dir = join(tmp, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "tybo-telegram-relay.service");
    writeFileSync(file, "[Service]\n");
    return { dir, file };
  }
  const answering = (calls: string[], failing: string[]) => async (cmd: string[]) => {
    const line = cmd.join(" ");
    calls.push(line);
    return failing.some(f => line.startsWith(f)) ? { ok: false, stdout: "", stderr: "Fehler" } : { ok: true, stdout: "", stderr: "" };
  };

  test("Stoppen scheitert: Dienstdatei bleibt, kein Löschen, kein daemon-reload, Ergebnis failed", async () => {
    const { dir, file } = unitWith("stop-scheitert");
    const calls: string[] = [];
    const removed: string[] = [];
    const { result, out } = await quiet(() => uninstallSystemd(dir, answering(calls, ["systemctl --user disable"]), path => void removed.push(path)));
    expect(result).toBe("failed");
    expect(existsSync(file)).toBe(true);
    expect(removed).toEqual([]);
    expect(calls).toEqual(["systemctl --user disable --now tybo-telegram-relay"]);
    expect(out).toContain("service file kept");
  });

  test("Löschen scheitert: failed, kein daemon-reload", async () => {
    const { dir } = unitWith("loeschen-scheitert");
    const calls: string[] = [];
    const { result, out } = await quiet(() =>
      uninstallSystemd(dir, answering(calls, []), () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }),
    );
    expect(result).toBe("failed");
    expect(calls).toEqual(["systemctl --user disable --now tybo-telegram-relay"]);
    expect(out).toContain("Delete failed");
  });

  test("daemon-reload scheitert: failed", async () => {
    const { dir, file } = unitWith("reload-scheitert");
    const calls: string[] = [];
    const { result } = await quiet(() => uninstallSystemd(dir, answering(calls, ["systemctl --user daemon-reload"])));
    expect(result).toBe("failed");
    expect(existsSync(file)).toBe(false);
    expect(calls).toEqual(["systemctl --user disable --now tybo-telegram-relay", "systemctl --user daemon-reload"]);
  });

  test("CLI: Fehler auf dem systemd-Weg ergeben Exit-Code 1, Erfolg 0; PM2 ohne npx", async () => {
    const cases: Array<{ name: string; failing: string[]; remove?: (p: string) => void; code: number }> = [
      { name: "cli-stop", failing: ["systemctl --user disable"], code: 1 },
      { name: "cli-delete", failing: [], remove: () => { throw new Error("EBUSY"); }, code: 1 },
      { name: "cli-reload", failing: ["systemctl --user daemon-reload"], code: 1 },
      { name: "cli-ok", failing: [], code: 0 },
    ];
    for (const c of cases) {
      const { dir } = unitWith(c.name);
      const calls: string[] = [];
      const { result, out } = await quiet(() =>
        runUninstall({ platform: "linux", run: answering(calls, [...c.failing, "pm2 --version"]), unitDir: dir, remove: c.remove ?? (p => rmSync(p)) }),
      );
      expect(result).toBe(c.code);
      expect(out.includes("was not fully removed")).toBe(c.code === 1);
      expect(calls.some(x => x.startsWith("npx"))).toBe(false);
    }
  });

  test("PM2 auf dem systemd-Weg ohne npx", async () => {
    const calls: string[][] = [];
    await quiet(() =>
      uninstallPM2(async cmd => {
        calls.push(cmd);
        return { ok: true, stdout: "", stderr: "" };
      }, ["pm2"]),
    );
    expect(calls.every(c => c[0] === "pm2")).toBe(true);
    expect(calls[0]).toEqual(["pm2", "jlist"]);
  });
});

describe("setup:verify", () => {
  const unitDir = join(tmp, "verify");
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, "tybo-telegram-relay.service"), "[Service]\n");

  async function verify(answers: Record<string, Answer>, dir = unitDir) {
    const records: Array<{ name: string; status: string; message: string }> = [];
    const calls: string[] = [];
    const found = await checkSystemdService(
      dir,
      async cmd => {
        const line = cmd.join(" ");
        calls.push(line);
        const key = Object.keys(answers).find(k => line.startsWith(k));
        return key ? { ok: true, stdout: "", stderr: "", ...answers[key] } : { ok: false, stdout: "", stderr: "" };
      },
      (name, status, message) => void records.push({ name, status, message }),
      "alex",
    );
    return { found, records, calls };
  }

  test("läuft, aktiviert, Linger an: alles grün, kein npx", async () => {
    const r = await verify({ "systemctl --user show": { stdout: "ActiveState=active\nUnitFileState=enabled\nMainPID=42" }, "loginctl show-user": { stdout: "yes" } });
    expect(r.found).toBe(true);
    expect(r.records.map(x => x.status)).toEqual(["pass", "pass"]);
    expect(r.records[0].message).toContain("PID: 42");
    expect(r.calls.some(c => c.startsWith("npx") || c.startsWith("pm2"))).toBe(false);
  });

  test("nicht aktiviert und ohne Linger: Warnungen mit Befehl", async () => {
    const r = await verify({ "systemctl --user show": { stdout: "ActiveState=active\nUnitFileState=disabled\nMainPID=42" }, "loginctl show-user": { stdout: "no" } });
    expect(r.records.map(x => x.status)).toEqual(["pass", "warn", "warn"]);
    expect(r.records[2].message).toContain("sudo loginctl enable-linger alex");
  });

  test("gestoppt: Fehler; Manager nicht erreichbar: Fehler mit Hinweis auf sudo", async () => {
    expect((await verify({ "systemctl --user show": { stdout: "ActiveState=failed\nUnitFileState=enabled" }, "loginctl show-user": { stdout: "yes" } })).records[0].status).toBe("fail");
    const down = await verify({});
    expect(down.records).toEqual([{ name: "telegram-relay", status: "fail", message: expect.stringContaining("nicht über sudo") }]);
  });

  test("loginctl scheitert: Prüfhinweis ohne sudo", async () => {
    const r = await verify({ "systemctl --user show": { stdout: "ActiveState=active\nUnitFileState=enabled\nMainPID=42" } });
    expect(r.records[1].status).toBe("warn");
    expect(r.records[1].message).toContain("loginctl show-user alex -p Linger");
    expect(r.records[1].message).not.toContain("sudo");
  });

  test("ohne Dienstdatei: false, der Aufrufer prüft PM2 wie bisher", async () => {
    const r = await verify({}, join(tmp, "nichts"));
    expect(r).toEqual({ found: false, records: [], calls: [] });
  });
});
