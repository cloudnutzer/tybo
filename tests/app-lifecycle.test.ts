// Issue #342: Lebenszyklus des Bot-Prozesses (src/app/lifecycle.ts). Sperrdatei,
// Herzschlag, geordnetes Beenden und Signale, alles mit austauschbarem
// Dateisystem, Zeitgeber, Prozessprüfung und Exit; ohne src/bot.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createLifecycle,
  createProcessLock,
  installSignalHandlers,
  probePid,
  type LockFs,
  type PidState,
} from "../src/app/lifecycle";

/** Sperrdatei im Speicher; create schlägt wie "wx" mit EEXIST fehl */
function memoryFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set("/x/bot.lock", initial);
  const calls: string[] = [];
  const fs: LockFs = {
    async create(path, content) {
      calls.push(`create ${content}`);
      if (files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(path, content);
    },
    async read(path) {
      return files.get(path) ?? null;
    },
    async overwrite(path, content) {
      calls.push(`overwrite ${content}`);
      files.set(path, content);
    },
    async remove(path) {
      calls.push("remove");
      files.delete(path);
    },
  };
  return { fs, files, calls };
}

const lockAt = (fs: LockFs, probe: (pid: number) => PidState, pid = 4242) =>
  createProcessLock({ path: "/x/bot.lock", pid, fs, probe });

describe("Sperrdatei", () => {
  test("frei: angelegt mit der eigenen PID", async () => {
    const m = memoryFs();
    expect(await lockAt(m.fs, () => "gone").acquire()).toBe(true);
    expect(m.files.get("/x/bot.lock")).toBe("4242");
  });

  test("lebender Besitzer: nicht übernommen, Datei bleibt", async () => {
    const m = memoryFs("111");
    const probed: number[] = [];
    expect(await lockAt(m.fs, pid => (probed.push(pid), "alive")).acquire()).toBe(false);
    expect(probed).toEqual([111]);
    expect(m.files.get("/x/bot.lock")).toBe("111");
  });

  test("toter Besitzer: alte Sperre weg, eigene angelegt", async () => {
    const m = memoryFs("111");
    expect(await lockAt(m.fs, () => "gone").acquire()).toBe(true);
    expect(m.files.get("/x/bot.lock")).toBe("4242");
    expect(m.calls).toEqual(["create 4242", "remove", "create 4242"]);
  });

  test("Besitzer nicht prüfbar (etwa EPERM): wie lebend, nichts gelöscht", async () => {
    const m = memoryFs("111");
    expect(await lockAt(m.fs, () => "unknown").acquire()).toBe(false);
    expect(m.calls).not.toContain("remove");
  });

  test("ungültiger Inhalt: nicht übernommen, nichts gelöscht", async () => {
    for (const content of ["", "abc", "-5", "0", "1.5", "99999999999999999999"]) {
      const m = memoryFs(content);
      let probed = false;
      expect(await lockAt(m.fs, () => ((probed = true), "gone")).acquire()).toBe(false);
      expect(probed).toBe(false);
      expect(m.files.get("/x/bot.lock")).toBe(content);
    }
  });

  test("Sperre wechselt zwischen Lesen und Löschen den Besitzer: die neue bleibt", async () => {
    const m = memoryFs("111");
    // Während der Prüfung legt ein anderer Prozess eine eigene Sperre an
    const probe = () => {
      m.files.set("/x/bot.lock", "222");
      return "gone" as const;
    };
    const lock = createProcessLock({ path: "/x/bot.lock", pid: 4242, fs: m.fs, probe: pid => (pid === 111 ? probe() : "alive") });
    expect(await lock.acquire()).toBe(false);
    expect(m.files.get("/x/bot.lock")).toBe("222");
    expect(m.calls).not.toContain("remove");
  });

  test("immer wieder tote Besitzer: nach drei Versuchen aufgegeben", async () => {
    const m = memoryFs("111");
    // Jede Löschung kommt zu spät: ein neuer, ebenfalls toter Besitzer steht schon da
    const fs: LockFs = { ...m.fs, remove: async () => void m.files.set("/x/bot.lock", "111") };
    expect(await lockAt(fs, () => "gone").acquire()).toBe(false);
    expect(m.calls.filter(c => c.startsWith("create"))).toHaveLength(3);
  });

  test("anderer Fehler beim Anlegen: wird geworfen", async () => {
    const m = memoryFs();
    const fs: LockFs = { ...m.fs, create: async () => { throw Object.assign(new Error("kein Platz"), { code: "ENOSPC" }); } };
    await expect(lockAt(fs, () => "gone").acquire()).rejects.toThrow("kein Platz");
  });

  test("Freigeben löscht nur die eigene Sperre", async () => {
    const own = memoryFs("4242");
    await lockAt(own.fs, () => "alive").release();
    expect(own.files.has("/x/bot.lock")).toBe(false);

    const foreign = memoryFs("111");
    await lockAt(foreign.fs, () => "alive").release();
    expect(foreign.files.get("/x/bot.lock")).toBe("111");
    expect(foreign.calls).not.toContain("remove");
  });

  test("Herzschlag schreibt nur die eigene Sperre neu", async () => {
    const own = memoryFs("4242");
    await lockAt(own.fs, () => "alive").touch();
    expect(own.calls).toEqual(["overwrite 4242"]);

    const foreign = memoryFs("111");
    await lockAt(foreign.fs, () => "alive").touch();
    expect(foreign.calls).toEqual([]);

    const missing = memoryFs();
    await lockAt(missing.fs, () => "alive").touch();
    expect(missing.calls).toEqual([]);
  });

  test("Herzschlag: Schreibfehler wird geschluckt", async () => {
    const m = memoryFs("4242");
    const fs: LockFs = { ...m.fs, overwrite: async () => { throw new Error("schreibgeschützt"); } };
    await expect(lockAt(fs, () => "alive").touch()).resolves.toBeUndefined();
  });

  describe("auf der Platte", () => {
    let dir = "";
    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
      dir = "";
    });

    test("zwei gleichzeitige Versuche: genau einer bekommt die Sperre, Rechte 600", async () => {
      dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
      const path = join(dir, "bot.lock");
      const a = createProcessLock({ path, pid: 1001, probe: () => "alive" });
      const b = createProcessLock({ path, pid: 1002, probe: () => "alive" });
      const results = await Promise.all([a.acquire(), b.acquire()]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(["1001", "1002"]).toContain(await readFile(path, "utf8"));
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    test("Sperre eines beendeten Prozesses wird übernommen, Freigeben räumt auf", async () => {
      dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
      const path = join(dir, "bot.lock");
      await writeFile(path, "77");
      const lock = createProcessLock({ path, pid: 1003, probe: pid => (pid === 77 ? "gone" : "alive") });
      expect(await lock.acquire()).toBe(true);
      expect(await readFile(path, "utf8")).toBe("1003");
      await lock.release();
      expect(existsSync(path)).toBe(false);
    });
  });
});

describe("probePid", () => {
  test("eigener Prozess lebt, unbelegte PID ist weg", () => {
    expect(probePid(process.pid)).toBe("alive");
    expect(probePid(2 ** 30)).toBe("gone");
  });

  test("EPERM und andere Fehler: unbekannt", () => {
    const kill = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
    expect(probePid(1, kill("EPERM"))).toBe("unknown");
    expect(probePid(1, kill("EINVAL"))).toBe("unknown");
    expect(probePid(1, kill("ESRCH"))).toBe("gone");
    expect(probePid(1, () => true)).toBe("alive");
  });
});

/** Zeitgeber zum Weiterdrehen per Hand */
function manualTimers() {
  let next = 1;
  const active = new Map<number, { ms: number; fn: () => unknown }>();
  return {
    timers: {
      setInterval: (fn: () => unknown, ms: number) => {
        const id = next++;
        active.set(id, { ms, fn });
        return id;
      },
      clearInterval: (id: unknown) => void active.delete(id as number),
    },
    /** alle Zeitgeber mit diesem Abstand einmal auslösen */
    fire(ms: number) {
      for (const t of [...active.values()]) if (t.ms === ms) t.fn();
    },
    count: () => active.size,
  };
}

function rig(opts: { release?: () => Promise<void> } = {}) {
  const events: string[] = [];
  const clock = manualTimers();
  const exits: number[] = [];
  const lifecycle = createLifecycle({
    lock: {
      touch: async () => void events.push("touch"),
      release: opts.release ?? (async () => void events.push("release")),
    },
    exit: code => void exits.push(code),
    timers: clock.timers,
    sleep: async ms => void events.push(`sleep ${ms}`),
    log: line => void events.push(`log ${line.trim()}`),
    warn: line => void events.push(`warn ${line}`),
    afterRelease: async reason => void events.push(`after ${reason}`),
  });
  return { lifecycle, events, clock, exits };
}

describe("Lebenszyklus", () => {
  test("Herzschlag alle 60 Sekunden, nach dem Beenden nicht mehr", async () => {
    const r = rig();
    r.lifecycle.startHeartbeat();
    r.clock.fire(60_000);
    expect(r.events).toEqual(["touch"]);
    await r.lifecycle.shutdown("SIGTERM");
    expect(r.clock.count()).toBe(0);
    r.events.length = 0;
    r.clock.fire(60_000);
    expect(r.events).toEqual([]);
  });

  test("Herzschlag, der nach dem Beginn des Beendens noch feuert, schreibt nichts", async () => {
    const events: string[] = [];
    let tick: (() => unknown) | undefined;
    const lifecycle = createLifecycle({
      lock: { touch: async () => void events.push("touch"), release: async () => {} },
      exit: () => {},
      timers: { setInterval: fn => ((tick = fn), 1), clearInterval: () => {} },
      sleep: async () => {},
      log: () => {},
    });
    lifecycle.startHeartbeat();
    void lifecycle.shutdown("SIGINT");
    tick!();
    expect(events).toEqual([]);
  });

  test("Reihenfolge: Flag, Zeitgeber aus, Closer der Reihe nach, Schonfrist, Sperre frei, Protokoll, Exit 0", async () => {
    const r = rig();
    const seen: boolean[] = [];
    r.lifecycle.every(30_000, () => void r.events.push("tick"));
    r.lifecycle.onShutdown("eins", () => {
      seen.push(r.lifecycle.isShuttingDown());
      r.events.push(`eins (zeitgeber ${r.clock.count()})`);
    });
    r.lifecycle.onShutdown("zwei", async () => {
      await Promise.resolve();
      r.events.push("zwei");
    });
    expect(r.lifecycle.isShuttingDown()).toBe(false);
    await r.lifecycle.shutdown("SIGTERM");
    expect(seen).toEqual([true]);
    expect(r.events).toEqual([
      "log Received SIGTERM. Shutting down gracefully...",
      "eins (zeitgeber 0)",
      "zwei",
      "sleep 1600",
      "release",
      "after SIGTERM",
      "log Shutdown complete.",
    ]);
    expect(r.exits).toEqual([0]);
  });

  test("mehrfaches Beenden: Closer laufen einmal, ein Exit", async () => {
    const r = rig();
    let runs = 0;
    r.lifecycle.onShutdown("zaehler", async () => void runs++);
    await Promise.all([r.lifecycle.shutdown("SIGTERM"), r.lifecycle.shutdown("SIGINT"), r.lifecycle.shutdown("restart-requested")]);
    await r.lifecycle.shutdown("SIGHUP");
    expect(runs).toBe(1);
    expect(r.exits).toEqual([0]);
    expect(r.events.filter(e => e.startsWith("log Received"))).toEqual(["log Received SIGTERM. Shutting down gracefully..."]);
  });

  test("fehlerhafter Closer (wirft, lehnt ab, nicht initialisiert): Rest läuft, Sperre wird frei", async () => {
    const r = rig();
    r.lifecycle.onShutdown("wirft", () => {
      throw new TypeError("kaputt");
    });
    r.lifecycle.onShutdown("lehnt-ab", () => Promise.reject(new RangeError("weg")));
    r.lifecycle.onShutdown("danach", () => void r.events.push("danach"));
    await r.lifecycle.shutdown("uncaughtException");
    expect(r.events).toContain("warn [shutdown] wirft gescheitert (TypeError)");
    expect(r.events).toContain("warn [shutdown] lehnt-ab gescheitert (RangeError)");
    // Fehlermeldungen kommen nicht ins Log, sie könnten Geheimnisse tragen
    expect(r.events.join("\n")).not.toContain("kaputt");
    expect(r.events.indexOf("danach")).toBeLessThan(r.events.indexOf("release"));
    expect(r.exits).toEqual([0]);
  });

  test("Freigeben oder Protokoll scheitern: trotzdem Exit 0", async () => {
    const r = rig({ release: async () => { throw new Error("nein"); } });
    await r.lifecycle.shutdown("SIGTERM");
    expect(r.events).toContain("warn [shutdown] Sperre freigeben gescheitert (Error)");
    expect(r.exits).toEqual([0]);

    const exits: number[] = [];
    const life = createLifecycle({
      lock: { touch: async () => {}, release: async () => {} },
      exit: code => void exits.push(code),
      sleep: async () => {},
      log: () => {},
      afterRelease: () => Promise.reject(new Error("Datenbank weg")),
    });
    await life.shutdown("SIGTERM");
    expect(exits).toEqual([0]);
  });

  test("Import ohne Nebenwirkungen: kein Zeitgeber, keine Signale, keine Datei", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    try {
      const before = process.listenerCount("SIGTERM");
      await import(`../src/app/lifecycle?fresh=${Date.now()}`);
      const lock = createProcessLock({ path: join(dir, "bot.lock"), pid: 1 });
      createLifecycle({ lock, exit: () => {} });
      expect(process.listenerCount("SIGTERM")).toBe(before);
      expect(existsSync(join(dir, "bot.lock"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("echter Prozess", () => {
  test("SIGTERM: Closer laufen, Sperre weg, Exit 0; ein zweiter Prozess bekommt die Sperre solange nicht", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tybo-lock-"));
    try {
      const child = join(import.meta.dir, "lifecycle-child.ts");
      const first = Bun.spawn(["bun", child, dir], { stdout: "pipe", stderr: "pipe" });
      const reader = first.stdout.getReader();
      let out = "";
      while (!out.includes("bereit")) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      expect(await readFile(join(dir, "bot.lock"), "utf8")).toBe(String(first.pid));

      const second = Bun.spawn(["bun", child, dir], { stdout: "pipe", stderr: "pipe" });
      expect(await second.exited).toBe(1);
      expect(await new Response(second.stdout).text()).toContain("gesperrt");

      first.kill("SIGTERM");
      expect(await first.exited).toBe(0);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += new TextDecoder().decode(value);
      }
      expect(out).toContain("closer");
      expect(out).toContain("Shutdown complete.");
      expect(existsSync(join(dir, "bot.lock"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Signale", () => {
  function signalRig() {
    const handlers = new Map<string, (arg?: unknown) => unknown>();
    const reasons: string[] = [];
    const reported: unknown[] = [];
    const logged: unknown[][] = [];
    installSignalHandlers(
      { shutdown: async reason => void reasons.push(reason) },
      {
        on: (event, handler) => void handlers.set(event, handler),
        report: async error => void reported.push(error),
        logError: (...args) => void logged.push(args),
      }
    );
    return { handlers, reasons, reported, logged };
  }

  test("SIGINT, SIGTERM und SIGHUP beenden mit dem Namen des Signals", async () => {
    const s = signalRig();
    expect([...s.handlers.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM", "uncaughtException"]);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) await s.handlers.get(sig)!();
    expect(s.reasons).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  });

  test("uncaughtException: erst ins Log und melden, dann beenden", async () => {
    const s = signalRig();
    const error = new Error("ups");
    await s.handlers.get("uncaughtException")!(error);
    expect(s.logged).toEqual([["Uncaught exception:", error]]);
    expect(s.reported).toEqual([error]);
    expect(s.reasons).toEqual(["uncaughtException"]);
  });

  test("uncaughtException: scheitert die Meldung, wird trotzdem beendet", async () => {
    const handlers = new Map<string, (arg?: unknown) => unknown>();
    const reasons: string[] = [];
    installSignalHandlers(
      { shutdown: async reason => void reasons.push(reason) },
      { on: (event, handler) => void handlers.set(event, handler), report: () => Promise.reject(new Error("weg")), logError: () => {} }
    );
    await handlers.get("uncaughtException")!(new Error("ups"));
    expect(reasons).toEqual(["uncaughtException"]);
  });
});
