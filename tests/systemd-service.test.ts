/**
 * Issue #207, Checkbox 1 und 3: systemd-Erkennung, Dienstdatei,
 * Deinstallation (tybo deinstallieren, seit Issue #373) und tybo pruefen (src/setup/checks/services.ts). systemctl, loginctl und which sind
 * Attrappen; Dateien landen im Speicher oder in einem Temp-Ordner.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureKillMode,
  ensureLinger,
  installSystemdService,
  lingerCommand,
  lingerState,
  parseShow,
  renderSystemdUnit,
  replaceFileAtomic,
  systemdBooted,
  systemdUnitPath,
  systemdUnitState,
  unitPathOk,
  type ReplaceFs,
  type SystemdDeps,
} from "../setup/configure-systemd";
import { LINGER_KEPT, realUninstallDeps, runUninstallCommand, type UninstallDeps } from "../src/setup/services/uninstall";
import { systemdFindings } from "../src/setup/checks/services";
import { makeCtx, cleanup as cleanupCtx } from "./setup-fixture";

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
    readFile: path => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error("fehlt"), { code: "ENOENT" });
      return text;
    },
    writeFile: (path, content) => void files.set(path, content),
    replaceFile: (path, content) => {
      if (!files.has(path)) throw Object.assign(new Error("fehlt"), { code: "ENOENT" });
      files.set(path, content);
    },
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
    // Issue #561: Hintergrund-Jobs überleben den Neustart des Bots, genau eine Zeile im Abschnitt [Service]
    expect(unit.match(/^KillMode=.*$/gm)).toEqual(["KillMode=process"]);
    const service = unit.slice(unit.indexOf("[Service]"), unit.indexOf("[Install]"));
    expect(service).toContain("\nKillMode=process\n");
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
    // which codex (Issue #566): ohne Codex bleibt es bei den Standardorten
    expect(calls).toEqual(["which bun", "which claude", "which codex", "systemctl --user daemon-reload", "systemctl --user enable --now tybo-telegram-relay"]);
  });

  test("CLAUDE_PATH mit festem Pfad: dessen Ordner im PATH, kein which claude", async () => {
    const { deps, calls, files } = fakeSystemd({ ...WHICH, "systemctl --user": {} });
    await installSystemdService(deps, "/opt/claude/bin/claude");
    expect(files.get(systemdUnitPath(deps.unitDir))).toContain(":/opt/claude/bin:");
    expect(calls).not.toContain("which claude");
  });

  test("Codex gefunden (Issue #566): dessen Ordner steht im PATH der Unit", async () => {
    const { deps, files } = fakeSystemd({ ...WHICH, "which codex": { stdout: "/home/alex/.npm-global/bin/codex" }, "systemctl --user": {} });
    expect(await installSystemdService(deps)).toEqual({ ok: true });
    const unit = files.get(systemdUnitPath(deps.unitDir))!;
    const path = /^Environment=PATH=(.*)$/m.exec(unit)![1].split(":");
    expect(path).toEqual([
      "/home/alex/.bun/bin",
      "/home/alex/.local/bin",
      "/home/alex/.npm-global/bin",
      "/home/alex/.bun/bin",
      "/home/alex/.local/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].filter((d, i, all) => all.indexOf(d) === i));
  });

  test("eigener CODEX_PATH: dessen Ordner im PATH, kein which codex", async () => {
    const { deps, calls, files } = fakeSystemd({ ...WHICH, "systemctl --user": {} });
    await installSystemdService(deps, undefined, "/opt/codex/bin/codex");
    const path = /^Environment=PATH=(.*)$/m.exec(files.get(systemdUnitPath(deps.unitDir))!)![1].split(":");
    expect(path).toContain("/opt/codex/bin");
    expect(calls).not.toContain("which codex");
  });

  test("CODEX_PATH mit unsicherem Ordner: keine Dienstdatei, nichts gestartet", async () => {
    const { deps, calls, files } = fakeSystemd({ ...WHICH, "systemctl --user": {} });
    expect(await installSystemdService(deps, undefined, "/opt/mein codex/codex")).toEqual({ ok: false, reason: "unsafe-path" });
    expect(files.size).toBe(0);
    expect(calls.some(c => c.startsWith("systemctl"))).toBe(false);
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

describe("KillMode nachziehen (Issue #561)", () => {
  const KILL = `${SHOW} --property=KillMode`;

  test("Benutzer-Manager antwortet nicht: nichts gelesen, nichts geschrieben", async () => {
    const files = new Map([["/home/alex/.config/systemd/user/tybo-telegram-relay.service", "[Service]\n"]]);
    const { deps, calls } = fakeSystemd({}, files);
    expect(await ensureKillMode(deps)).toEqual({ kind: "unreachable" });
    expect(calls).toEqual([KILL]);
    expect(files.get("/home/alex/.config/systemd/user/tybo-telegram-relay.service")).toBe("[Service]\n");
  });

  test("schon wirksam: nur eine Abfrage", async () => {
    const { deps, calls } = fakeSystemd({ [KILL]: { stdout: "KillMode=process" } });
    expect(await ensureKillMode(deps)).toEqual({ kind: "already" });
    expect(calls).toEqual([KILL]);
  });

  test("Schreiben scheitert: Fehlercode, kein daemon-reload", async () => {
    const path = "/home/alex/.config/systemd/user/tybo-telegram-relay.service";
    const { deps, calls } = fakeSystemd({ [KILL]: { stdout: "KillMode=control-group" } }, new Map([[path, "[Service]\n"]]));
    deps.replaceFile = () => {
      throw Object.assign(new Error("nein"), { code: "EACCES" });
    };
    expect(await ensureKillMode(deps)).toEqual({ kind: "write", code: "EACCES" });
    expect(calls.some(c => c.includes("daemon-reload"))).toBe(false);
  });

  test("keine Dienstdatei an der erwarteten Stelle: no-file", async () => {
    const { deps } = fakeSystemd({ [KILL]: { stdout: "KillMode=control-group" } });
    expect(await ensureKillMode(deps)).toEqual({ kind: "no-file" });
  });
});

describe("Dienstdatei atomar ersetzen (Issue #561)", () => {
  const ORIGINAL = "[Unit]\nDescription=tybo\n\n[Service]\n# eigene Anpassung\nEnvironment=EIGENE_VARIABLE=1\nExecStart=/usr/bin/true\n";
  const NEU = ORIGINAL.replace("[Service]\n", "[Service]\nKillMode=process\n");
  const enospc = () => Object.assign(new Error("kein Platz"), { code: "ENOSPC" });
  /** echte Dateizugriffe; write schreibt nur den Anfang und scheitert dann (voller Datenträger) */
  const brokenFs: ReplaceFs = {
    realpath: path => path,
    mode: path => statSync(path).mode & 0o7777,
    write: (path, content, mode) => {
      writeFileSync(path, content.slice(0, 12), { mode, flag: "wx" });
      throw enospc();
    },
    rename: (from, to) => renameSync(from, to),
    unlink: path => unlinkSync(path),
  };
  function unitIn(name: string, mode = 0o640) {
    const dir = join(tmp, name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "tybo-telegram-relay.service");
    writeFileSync(file, ORIGINAL);
    chmodSync(file, mode);
    return { dir, file };
  }

  test("ersetzt vollständig, behält die Rechte, keine temporäre Datei bleibt", () => {
    const { dir, file } = unitIn("atomar-ok");
    replaceFileAtomic(file, NEU);
    expect(readFileSync(file, "utf8")).toBe(NEU);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir)).toEqual(["tybo-telegram-relay.service"]);
  });

  test("Fehler nach begonnenem Schreiben: alte Datei Zeichen für Zeichen erhalten, temporäre entfernt", () => {
    const { dir, file } = unitIn("atomar-abbruch");
    let thrown: unknown;
    try {
      replaceFileAtomic(file, NEU, brokenFs);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as NodeJS.ErrnoException).code).toBe("ENOSPC");
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
    expect(readdirSync(dir)).toEqual(["tybo-telegram-relay.service"]);
  });

  test("Symlink bleibt Symlink, ersetzt wird sein Ziel", () => {
    const { dir, file } = unitIn("atomar-link");
    const link = join(dir, "link.service");
    symlinkSync(file, link);
    replaceFileAtomic(link, NEU);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(NEU);
  });

  test("ensureKillMode mit Schreibfehler mittendrin: Datei samt Anpassungen unverändert, kein daemon-reload; Wiederholung trägt ein", async () => {
    const { dir, file } = unitIn("atomar-ensure", 0o644);
    const KILL = `${SHOW} --property=KillMode`;
    let loaded = "control-group";
    const calls: string[] = [];
    const deps: SystemdDeps = {
      ...fakeSystemd().deps,
      unitDir: dir,
      run: async cmd => {
        const line = cmd.join(" ");
        calls.push(line);
        if (line === KILL) return { ok: true, stdout: `KillMode=${loaded}`, stderr: "" };
        if (line === "systemctl --user daemon-reload") {
          loaded = /^KillMode=process$/m.test(readFileSync(file, "utf8")) ? "process" : loaded;
          return { ok: true, stdout: "", stderr: "" };
        }
        return { ok: false, stdout: "", stderr: "unerwartet" };
      },
      exists: existsSync,
      readFile: path => readFileSync(path, "utf8"),
      replaceFile: (path, content) => replaceFileAtomic(path, content, brokenFs),
    };
    expect(await ensureKillMode(deps)).toEqual({ kind: "write", code: "ENOSPC" });
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
    expect(readdirSync(dir)).toEqual(["tybo-telegram-relay.service"]);
    expect(calls).toEqual([KILL]);

    deps.replaceFile = (path, content) => replaceFileAtomic(path, content);
    expect(await ensureKillMode(deps)).toEqual({ kind: "fixed" });
    const text = readFileSync(file, "utf8");
    expect(text.match(/^KillMode=process$/gm)).toHaveLength(1);
    expect(text).toContain("# eigene Anpassung\nEnvironment=EIGENE_VARIABLE=1\nExecStart=/usr/bin/true\n");
    expect(text.replace(/^#.*\n(?=KillMode=process)/m, "").replace("KillMode=process\n", "")).toBe(ORIGINAL);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(readdirSync(dir)).toEqual(["tybo-telegram-relay.service"]);
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
// Checkbox 3: Deinstallation und tybo pruefen
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

describe("Deinstallation (tybo deinstallieren)", () => {
  /** Dienstdatei des Bots im Temp-Ordner, systemd läuft (runDir im Temp-Ordner) */
  function unitWith(name: string) {
    const dir = join(tmp, name);
    mkdirSync(join(dir, "run"), { recursive: true });
    const file = join(dir, "tybo-telegram-relay.service");
    writeFileSync(file, "[Service]\n");
    return { dir, file };
  }
  const SHOW_ENABLED = "LoadState=loaded\nActiveState=active\nUnitFileState=enabled";
  const SHOW_NONE = "LoadState=not-found\nActiveState=inactive\nUnitFileState=";
  const SHOW_STOPPED = "LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled";
  /** systemctl nach Zustand: der Bot läuft und ist eingeschaltet (bis zum Stoppen), sonst nichts; failing: Befehlsanfänge, die scheitern ("pm2": nicht installiert) */
  const answering = (calls: string[], failing: string[], bot: string) => async (cmd: string[]) => {
    const line = cmd.join(" ");
    calls.push(line);
    if (failing.some(f => line.startsWith(f))) return { ok: false, stdout: "", stderr: "Fehler", missing: cmd[0] === "pm2" };
    if (cmd[2] === "show") return { ok: true, stdout: cmd[3] === "tybo-telegram-relay.service" ? bot : SHOW_NONE, stderr: "" };
    if (cmd[2] === "disable" || cmd[2] === "stop") bot = SHOW_STOPPED;
    if (line === "pm2 jlist") return { ok: true, stdout: "[]", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
  async function uninstall(dir: string, calls: string[], failing: string[], remove?: (p: string) => void, bot = SHOW_ENABLED) {
    const lines: string[] = [];
    const deps: UninstallDeps = {
      ...realUninstallDeps(dir, dir),
      platform: "linux",
      pm2Dump: join(dir, "dump.pm2"),
      unitDir: dir,
      runDir: join(dir, "run"),
      run: answering(calls, failing, bot),
      ask: async () => false,
      out: l => void lines.push(l),
      err: l => void lines.push(l),
      ...(remove ? { remove } : {}),
    };
    return { code: await runUninstallCommand([], deps), out: lines.join("\n"), changes: () => calls.filter(c => c.startsWith("systemctl") && !c.includes(" show ")) };
  }

  test("Dienst da: disable --now, Datei weg, daemon-reload; Linger bleibt, kein sudo", async () => {
    const { dir, file } = unitWith("unit-da");
    const calls: string[] = [];
    const r = await uninstall(dir, calls, ["pm2"]);
    expect(r.code).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(r.changes()).toEqual(["systemctl --user disable --now tybo-telegram-relay.service", "systemctl --user daemon-reload"]);
    expect(calls.some(c => c.includes("linger") || c.includes("sudo"))).toBe(false);
    expect(r.out).toContain(LINGER_KEPT);
  });

  test("kein Dienst: nur Abfragen, keine Änderung", async () => {
    const dir = join(tmp, "leer");
    mkdirSync(join(dir, "run"), { recursive: true });
    const calls: string[] = [];
    const r = await uninstall(dir, calls, ["pm2"], undefined, SHOW_NONE);
    expect(r.code).toBe(0);
    expect(r.changes()).toEqual([]);
  });

  test("Stoppen scheitert: Dienstdatei bleibt, kein daemon-reload, Exit 1", async () => {
    const { dir, file } = unitWith("stop-scheitert");
    const calls: string[] = [];
    const removed: string[] = [];
    const r = await uninstall(dir, calls, ["pm2", "systemctl --user disable"], p => void removed.push(p));
    expect(r.code).toBe(1);
    expect(existsSync(file)).toBe(true);
    expect(removed).toEqual([]);
    expect(r.changes()).toEqual(["systemctl --user disable --now tybo-telegram-relay.service"]);
    expect(r.out).toContain("ließ sich nicht stoppen");
  });

  test("Löschen scheitert: Exit 1", async () => {
    const { dir } = unitWith("loeschen-scheitert");
    const r = await uninstall(dir, [], ["pm2"], () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("ließ sich nicht löschen");
  });

  test("daemon-reload scheitert: Datei weg, Exit 1", async () => {
    const { dir, file } = unitWith("reload-scheitert");
    const calls: string[] = [];
    const r = await uninstall(dir, calls, ["pm2", "systemctl --user daemon-reload"]);
    expect(r.code).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(r.changes()).toEqual(["systemctl --user disable --now tybo-telegram-relay.service", "systemctl --user daemon-reload"]);
  });

  test("PM2 auf dem systemd-Weg nur, wenn installiert, nie über npx", async () => {
    const { dir } = unitWith("pm2-weg");
    const calls: string[] = [];
    const r = await uninstall(dir, calls, []);
    expect(r.code).toBe(0);
    expect(calls).toContain("pm2 --version");
    expect(calls).toContain("pm2 jlist");
    expect(calls.some(c => c.startsWith("npx"))).toBe(false);
  });
});

describe("tybo pruefen", () => {
  afterAll(cleanupCtx);
  const unitDir = join(tmp, "verify");
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, "tybo-telegram-relay.service"), "[Service]\n");

  async function verify(answers: Record<string, Answer>, dir = unitDir) {
    const calls: string[] = [];
    const run = async (cmd: string[]) => {
      const line = cmd.join(" ");
      calls.push(line);
      const key = Object.keys(answers).find(k => line.startsWith(k));
      return key ? { code: 0, stdout: answers[key].stdout ?? "", stderr: "" } : { code: 1, stdout: "", stderr: "" };
    };
    const ctx = await makeCtx({ overrides: { platform: "linux", systemdUserDir: dir, user: "alex", run } });
    const lines = await systemdFindings(ctx);
    const records = (lines ?? []).map(l => ({ name: l.label, status: l.status, message: l.detail }));
    return { found: lines !== null, records, calls };
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

  test("Issue #561: alte Dienstdatei (KillMode=control-group): Warnung mit Befehl; KillMode=process: keine Zeile", async () => {
    const old = await verify({ "systemctl --user show": { stdout: "ActiveState=active\nUnitFileState=enabled\nMainPID=42\nKillMode=control-group" }, "loginctl show-user": { stdout: "yes" } });
    expect(old.records.map(x => [x.name, x.status])).toEqual([["telegram-relay", "pass"], ["telegram-relay (Hintergrund-Jobs)", "warn"], ["telegram-relay (Linger)", "pass"]]);
    expect(old.records[1].message).toContain("tybo setup autostart");
    expect(old.calls.filter(c => c.startsWith("systemctl"))).toEqual(["systemctl --user show tybo-telegram-relay.service --property=ActiveState,SubState,UnitFileState,MainPID,KillMode"]);
    const current = await verify({ "systemctl --user show": { stdout: "ActiveState=active\nUnitFileState=enabled\nMainPID=42\nKillMode=process" }, "loginctl show-user": { stdout: "yes" } });
    expect(current.records.map(x => x.status)).toEqual(["pass", "pass"]);
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
