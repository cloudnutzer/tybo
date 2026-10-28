/**
 * Issue #369: src/setup/services/launchd.ts gegen eine zustandsbehaftete
 * launchctl-Attrappe. Kein Test ruft launchctl; der echte Befehlsläufer wird
 * nur mit sleep und einer SIGTERM ignorierenden sh-Attrappe auf seine Frist
 * geprüft.
 */
import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import {
  COMMAND_TIMEOUT_MS,
  failureMessage,
  plistFile,
  realLaunchdDeps,
  setUpService,
  SUPABASE_UNLOAD_TIMEOUT_MS,
  type LaunchdDeps,
  type LaunchdFailure,
} from "../src/setup/services/launchd";
import { KILL_GRACE_MS } from "../src/setup/context";
import { LAUNCHD_EXIT_TIMEOUT_S } from "../src/setup/local-supabase";
import { oldLaunchdLabel } from "./old-names";

const AGENTS = "/home/test/Library/LaunchAgents";
const BOT = "ai.tybo.telegram-relay";
const SUPA = "ai.tybo.supabase";
const OLD = oldLaunchdLabel("telegram-relay");

interface Mac {
  deps: LaunchdDeps;
  files: Map<string, string>;
  loaded: Set<string>;
  /** launchctl-Aufrufe als „verb datei“ bzw. „list“ */
  calls: string[];
  timeouts: Array<number | undefined>;
  log: string[];
  failList: boolean;
  failUnload: boolean;
  failLoad: boolean;
}

function fakeMac(): Mac {
  const mac = {
    files: new Map<string, string>(),
    loaded: new Set<string>(),
    calls: [] as string[],
    timeouts: [] as Array<number | undefined>,
    log: [] as string[],
    failList: false,
    failUnload: false,
    failLoad: false,
  } as Mac;
  const fine = (stdout = "") => ({ ok: true, stdout, stderr: "" });
  const broken = { ok: false, stdout: "", stderr: "geheim=abc" };
  mac.deps = {
    projectRoot: "/home/test/tybo",
    launchAgentsDir: AGENTS,
    home: "/home/test",
    async run(cmd, options) {
      if (cmd[0] === "which") return fine(`/opt/bin/${cmd[1]}`);
      if (cmd[0] !== "launchctl") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
      if (cmd[1] === "list") {
        mac.calls.push("list");
        return mac.failList ? broken : fine([...mac.loaded].map(l => `42\t0\t${l}`).join("\n"));
      }
      mac.calls.push(`${cmd[1]} ${basename(cmd[2])}`);
      mac.timeouts.push(options?.timeoutMs);
      const label = basename(cmd[2], ".plist");
      if (cmd[1] === "unload") {
        if (mac.failUnload) return broken;
        mac.loaded.delete(label);
        return fine();
      }
      if (mac.failLoad || mac.loaded.has(label) || !mac.files.has(cmd[2])) return broken;
      mac.loaded.add(label);
      return fine();
    },
    exists: path => path === AGENTS || mac.files.has(path),
    readFile: path => {
      const text = mac.files.get(path);
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
    writeFile: (path, content) => void mac.files.set(path, content),
    mkdir: () => {},
    log: line => void mac.log.push(line),
  };
  return mac;
}

const botFile = plistFile("telegram-relay", AGENTS);

describe("setUpService", () => {
  test("frisch: schreibt und lädt; zweiter Aufruf ändert nichts und lädt nicht neu", async () => {
    const mac = fakeMac();
    expect(await setUpService("telegram-relay", mac.deps)).toEqual({ ok: true, service: "telegram-relay", label: BOT, action: "written", running: true });
    expect(mac.calls).toEqual([`load ${BOT}.plist`, "list"]);
    mac.calls.length = 0;
    expect(await setUpService("telegram-relay", mac.deps)).toMatchObject({ ok: true, action: "unchanged" });
    expect(mac.calls).toEqual(["list"]);
  });

  test("gleiche Plist, nicht geladen: unverändert laden", async () => {
    const mac = fakeMac();
    await setUpService("telegram-relay", mac.deps);
    const before = mac.files.get(botFile);
    mac.loaded.clear();
    mac.calls.length = 0;
    expect(await setUpService("telegram-relay", mac.deps)).toMatchObject({ ok: true, action: "reloaded" });
    expect(mac.calls).toEqual(["list", `load ${BOT}.plist`, "list"]);
    expect(mac.files.get(botFile)).toBe(before);
  });

  test("gleiche Plist, Ladezustand unbekannt: Abbruch ohne Laden", async () => {
    const mac = fakeMac();
    await setUpService("telegram-relay", mac.deps);
    mac.failList = true;
    mac.calls.length = 0;
    expect(await setUpService("telegram-relay", mac.deps)).toMatchObject({ ok: false, failure: "state-unknown" });
    expect(mac.calls).toEqual(["list"]);
  });

  test("geänderte Plist: entladen, schreiben, laden", async () => {
    const mac = fakeMac();
    await setUpService("telegram-relay", mac.deps);
    mac.files.set(botFile, "<plist>alt</plist>");
    mac.calls.length = 0;
    expect(await setUpService("telegram-relay", mac.deps)).toMatchObject({ ok: true, action: "written" });
    expect(mac.calls).toEqual([`unload ${BOT}.plist`, `load ${BOT}.plist`, "list"]);
    expect(mac.files.get(botFile)).toContain(`<string>${BOT}</string>`);
  });

  test("geänderte Plist, Entladen scheitert und Dienst noch geladen: nichts überschrieben, nichts geladen", async () => {
    const mac = fakeMac();
    await setUpService("telegram-relay", mac.deps);
    mac.files.set(botFile, "<plist>alt</plist>");
    mac.failUnload = true;
    mac.calls.length = 0;
    expect(await setUpService("telegram-relay", mac.deps)).toMatchObject({ ok: false, failure: "unload-failed" });
    expect(mac.files.get(botFile)).toBe("<plist>alt</plist>");
    expect(mac.calls.some(c => c.startsWith("load"))).toBe(false);
  });

  test("Entladen scheitert und Liste unlesbar: ebenso Abbruch", async () => {
    const mac = fakeMac();
    await setUpService("telegram-relay", mac.deps);
    mac.files.set(botFile, "<plist>alt</plist>");
    mac.failUnload = true;
    mac.failList = true;
    expect(await setUpService("telegram-relay", mac.deps)).toMatchObject({ ok: false, failure: "unload-failed" });
    expect(mac.files.get(botFile)).toBe("<plist>alt</plist>");
  });

  test("Entladen scheitert, Dienst aber sicher nicht geladen: neue Plist und Laden", async () => {
    const mac = fakeMac();
    mac.files.set(botFile, "<plist>alt</plist>");
    mac.failUnload = true;
    expect(await setUpService("telegram-relay", mac.deps)).toMatchObject({ ok: true, action: "written" });
    expect(mac.loaded.has(BOT)).toBe(true);
  });

  test("Ladefehler: Fehlerart load-failed, Wiederholung lädt", async () => {
    const mac = fakeMac();
    mac.failLoad = true;
    expect(await setUpService("telegram-relay", mac.deps)).toMatchObject({ ok: false, failure: "load-failed" });
    mac.failLoad = false;
    expect(await setUpService("telegram-relay", mac.deps)).toMatchObject({ ok: true, action: "reloaded" });
    expect(mac.loaded.has(BOT)).toBe(true);
  });

  test("Supabase: Entladen mit langer Frist, andere Aufrufe ohne", async () => {
    const mac = fakeMac();
    mac.files.set(plistFile("supabase", AGENTS), "<plist>alt</plist>");
    mac.loaded.add(SUPA);
    expect(await setUpService("supabase", mac.deps)).toMatchObject({ ok: true, action: "written" });
    expect(mac.calls.slice(0, 2)).toEqual([`unload ${SUPA}.plist`, `load ${SUPA}.plist`]);
    expect(mac.timeouts).toEqual([SUPABASE_UNLOAD_TIMEOUT_MS, undefined]);
    expect(SUPABASE_UNLOAD_TIMEOUT_MS).toBe(LAUNCHD_EXIT_TIMEOUT_S * 1000 + 60_000);
  });

  test("Supabase-Label ohne PID in der Liste gilt als geladen, nicht als Fehler", async () => {
    const mac = fakeMac();
    await setUpService("supabase", mac.deps);
    const list = mac.deps.run;
    mac.deps.run = async (cmd, o) => (cmd[1] === "list" ? { ok: true, stdout: `-\t0\t${SUPA}`, stderr: "" } : list(cmd, o));
    mac.calls.length = 0;
    expect(await setUpService("supabase", mac.deps)).toMatchObject({ ok: true, action: "unchanged" });
  });

  test("fremde und frühere Dienste bleiben unberührt", async () => {
    const mac = fakeMac();
    mac.files.set(`${AGENTS}/ai.tybo.preis-watch.plist`, "<plist>watcher</plist>");
    mac.files.set(`${AGENTS}/${OLD}.plist`, "<plist>alt</plist>");
    mac.loaded.add("ai.tybo.preis-watch");
    mac.loaded.add(OLD);
    await setUpService("telegram-relay", mac.deps);
    expect(mac.calls.every(c => c === "list" || c.includes(BOT))).toBe(true);
    expect(mac.files.get(`${AGENTS}/ai.tybo.preis-watch.plist`)).toBe("<plist>watcher</plist>");
    expect(mac.loaded.has(OLD)).toBe(true);
  });

  test("external: keine Datei, kein launchctl", async () => {
    for (const name of ["whatsapp-gateway", "cloudflare-tunnel"] as const) {
      const mac = fakeMac();
      expect(await setUpService(name, mac.deps)).toMatchObject({ ok: false, failure: "external" });
      expect(mac.files.size).toBe(0);
      expect(mac.calls).toEqual([]);
    }
  });

  test("Bun fehlt: no-bun, nichts geschrieben", async () => {
    const mac = fakeMac();
    const run = mac.deps.run;
    mac.deps.run = async (cmd, o) => (cmd[0] === "which" && cmd[1] === "bun" ? { ok: false, stdout: "", stderr: "" } : run(cmd, o));
    expect(await setUpService("telegram-relay", mac.deps)).toMatchObject({ ok: false, failure: "no-bun" });
    expect(mac.files.size).toBe(0);
  });

  test("Steuerzeichen im Projektordner: plist-invalid ohne Datei und launchctl", async () => {
    const mac = fakeMac();
    mac.deps.projectRoot = "/tmp/a\u0001b";
    expect(await setUpService("telegram-relay", mac.deps)).toMatchObject({ ok: false, failure: "plist-invalid" });
    expect(mac.files.size).toBe(0);
    expect(mac.calls).toEqual([]);
  });

  test("Meldungen sind fest und enthalten keine Ausgabe von launchctl", async () => {
    const mac = fakeMac();
    mac.failLoad = true;
    await setUpService("telegram-relay", mac.deps);
    expect(mac.log.join("\n")).not.toContain("geheim");
    const kinds: LaunchdFailure[] = ["external", "no-bun", "plist-invalid", "state-unknown", "unload-failed", "load-failed"];
    for (const k of kinds) expect(failureMessage(k, BOT).length).toBeGreaterThan(10);
  });
});

describe("realLaunchdDeps", () => {
  test("Pfade aus Projektordner und Home, nicht aus dem Arbeitsverzeichnis", () => {
    const deps = realLaunchdDeps("/opt/tybo", "/Users/alex");
    expect(deps.projectRoot).toBe("/opt/tybo");
    expect(deps.launchAgentsDir).toBe("/Users/alex/Library/LaunchAgents");
  });

  test("Frist je Aufruf wird eingehalten (sleep statt launchctl)", async () => {
    const deps = realLaunchdDeps(process.cwd(), "/tmp");
    const started = Date.now();
    const r = await deps.run(["sleep", "5"], { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(COMMAND_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("Befehl ignoriert SIGTERM: nach der Schonfrist SIGKILL, Ende begrenzt", async () => {
    // Attrappe: meldet SIGTERM, läuft aber weiter (die Schleife mit sleep
    // hält zusätzlich einen Kindprozess am Leben)
    const deps = realLaunchdDeps(process.cwd(), "/tmp");
    const started = Date.now();
    const r = await deps.run(["sh", "-c", 'trap "echo TERM ignoriert" TERM; echo laeuft; while :; do sleep 0.05; done'], { timeoutMs: 300 });
    const elapsed = Date.now() - started;
    expect(r.ok).toBe(false);
    expect(r.stdout).toContain("laeuft");
    expect(r.stdout).toContain("TERM ignoriert");
    expect(elapsed).toBeGreaterThanOrEqual(300 + KILL_GRACE_MS - 50);
    expect(elapsed).toBeLessThan(300 + KILL_GRACE_MS + 2000);
  });

  test("nicht vorhandener Befehl zählt als gescheitert", async () => {
    const r = await realLaunchdDeps(process.cwd(), "/tmp").run(["tybo-gibt-es-nicht-369"]);
    expect(r.ok).toBe(false);
  });
});
