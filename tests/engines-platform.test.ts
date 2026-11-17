/**
 * Issue #325: Plattform-Details der Motor-Prozesse (src/lib/engines/platform.ts)
 * für macOS, Linux und Windows. Betriebssystem, Signalversand, taskkill und
 * Timer sind Attrappen: es startet kein Prozess und kein echtes Signal geht raus.
 */
import { describe, expect, test } from "bun:test";
import {
  CLAUDE_STOP_PLAN,
  homeDirectory,
  keepAwakeCommand,
  signalTree,
  startsOwnGroup,
  stopTree,
  type ProcessPlatform,
  type TreeSignal,
} from "../src/lib/engines/platform";
import { CODEX_KILL_GRACE_MS, signalProcessGroup, terminateCodexProcess, type CodexRuntime } from "../src/lib/engines/codex";
import { OPENCODE_KILL_GRACE_MS, terminateOpenCodeProcess } from "../src/lib/engines/opencode";
import { abortAllEngineCalls, terminatingEngineProcCount } from "../src/lib/engines/calls";

const OSES = ["darwin", "linux", "win32"] as const;

/**
 * Attrappe einer Plattform: zeichnet alles auf, Timer laufen erst mit advance
 * auf einer eigenen Uhr. state.members zählt die Mitglieder der Gruppe 4242
 * (der Prozess selbst eingeschlossen); jede Prüfung steht als "check" im Log,
 * damit die Reihenfolge Prüfung, Signal sichtbar ist. exitLeader beendet den
 * Prozess selbst, seine Kinder bleiben in der Gruppe.
 */
function fakePlatform(os: NodeJS.Platform, opts: { groupFails?: boolean } = {}) {
  const log: string[] = [];
  const clock = { now: 0 };
  const timers: { fn: () => void; ms: number; at: number; unrefed: boolean; cleared: boolean; unref(): void }[] = [];
  const state = { members: 3 };
  const platform: ProcessPlatform = {
    os,
    groupAlive: (pgid) => {
      log.push(`check -${pgid}`);
      return pgid === 4242 && state.members > 0;
    },
    signalGroup: (pgid, signal) => {
      if (opts.groupFails) throw new Error("ESRCH");
      log.push(`group -${pgid} ${signal}`);
    },
    taskkill: (pid) => void log.push(`taskkill ${pid}`),
    setTimeout: (fn, ms) => {
      const t = { fn, ms, at: clock.now + ms, unrefed: false, cleared: false, unref: () => void (t.unrefed = true) };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => void ((h as { cleared: boolean }).cleared = true),
  };
  const proc: { pid: number; kill: (sig?: number) => void; exitCode: number | null } = {
    pid: 4242,
    kill: (sig?: number) => void log.push(`kill ${sig}`),
    exitCode: null,
  };
  /** Uhr vorstellen und fällige, nicht entfernte Timer in Reihenfolge ausführen */
  const advance = (ms: number) => {
    const until = clock.now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.cleared && t.at <= until).sort((x, y) => x.at - y.at)[0];
      if (!due) break;
      due.cleared = true;
      clock.now = due.at;
      due.fn();
    }
    clock.now = until;
  };
  /** Prozess selbst beendet und abgeräumt; seine Kinder bleiben in der Gruppe */
  const exitLeader = () => {
    proc.exitCode = 0;
    state.members = Math.max(0, state.members - 1);
  };
  return { platform, log, timers, proc, state, advance, exitLeader, clock };
}

/** Nur die Signale, ohne die Prüfungen */
const signals = (log: string[]) => log.filter((l) => !l.startsWith("check"));

describe("Befehlszeile und Prozessgruppe", () => {
  test("Wachhalten nur auf macOS", () => {
    expect(keepAwakeCommand(["claude", "-p"], "darwin")).toEqual(["/usr/bin/caffeinate", "-i", "claude", "-p"]);
    expect(keepAwakeCommand(["claude", "-p"], "linux")).toEqual(["claude", "-p"]);
    expect(keepAwakeCommand(["claude", "-p"], "win32")).toEqual(["claude", "-p"]);
  });

  test("eigene Prozessgruppe außer unter Windows", () => {
    expect(OSES.map((os) => startsOwnGroup(os))).toEqual([true, true, false]);
  });

  test("Heimatverzeichnis: HOME, sonst USERPROFILE, sonst leer", () => {
    expect(homeDirectory({ HOME: "/home/alex", USERPROFILE: "C:\\Users\\alex" })).toBe("/home/alex");
    expect(homeDirectory({ USERPROFILE: "C:\\Users\\mia" })).toBe("C:\\Users\\mia");
    expect(homeDirectory({})).toBe("");
  });
});

describe("signalTree", () => {
  for (const os of ["darwin", "linux"] as const) {
    test(`${os}: Signal an die Prozessgruppe, jeweils direkt nach der Prüfung`, () => {
      const f = fakePlatform(os);
      for (const s of ["SIGINT", "SIGTERM", "SIGKILL"] as TreeSignal[]) signalTree(f.proc, s, f.platform);
      expect(f.log).toEqual([
        "check -4242",
        "group -4242 SIGINT",
        "check -4242",
        "group -4242 SIGTERM",
        "check -4242",
        "group -4242 SIGKILL",
      ]);
    });

    test(`${os}: Gruppensignal scheitert, Prozess läuft: der Prozess selbst mit Signalnummer`, () => {
      const f = fakePlatform(os, { groupFails: true });
      for (const s of ["SIGINT", "SIGTERM", "SIGKILL"] as TreeSignal[]) signalTree(f.proc, s, f.platform);
      expect(signals(f.log)).toEqual(["kill 2", "kill 15", "kill 9"]);
    });

    test(`${os}: Gruppe leer, Prozess läuft (keine eigene Gruppe): der Prozess selbst`, () => {
      const f = fakePlatform(os);
      f.state.members = 0;
      signalTree(f.proc, "SIGTERM", f.platform);
      expect(f.log).toEqual(["check -4242", "kill 15"]);
    });

    test(`${os}: Prozess beendet, Kinder in der Gruppe: Signal an die Gruppe`, () => {
      const f = fakePlatform(os);
      f.exitLeader();
      signalTree(f.proc, "SIGKILL", f.platform);
      expect(f.log).toEqual(["check -4242", "group -4242 SIGKILL"]);
    });

    test(`${os}: Prozess beendet, Gruppe leer: gar kein Signal, auch nicht an den Prozess`, () => {
      const f = fakePlatform(os);
      f.exitLeader();
      f.state.members = 0;
      for (const s of ["SIGINT", "SIGTERM", "SIGKILL"] as TreeSignal[]) signalTree(f.proc, s, f.platform);
      expect(signals(f.log)).toEqual([]);
    });

    test(`${os}: Prozess beendet, Gruppensignal scheitert: kein Signal an den Prozess`, () => {
      const f = fakePlatform(os, { groupFails: true });
      f.exitLeader();
      signalTree(f.proc, "SIGTERM", f.platform);
      expect(signals(f.log)).toEqual([]);
    });

    test(`${os}: Prüfung wirft: wie leere Gruppe`, () => {
      const f = fakePlatform(os);
      f.platform.groupAlive = () => {
        throw new Error("kaputt");
      };
      signalTree(f.proc, "SIGTERM", f.platform);
      f.exitLeader();
      signalTree(f.proc, "SIGKILL", f.platform);
      expect(f.log).toEqual(["kill 15"]);
    });
  }

  test("win32: jedes Signal wird zu taskkill /T /F, nie ein Gruppensignal, keine Gruppenprüfung", () => {
    const f = fakePlatform("win32");
    signalTree(f.proc, "SIGINT", f.platform);
    signalTree(f.proc, "SIGKILL", f.platform);
    expect(f.log).toEqual(["taskkill 4242", "taskkill 4242"]);
  });

  test("win32: Prozess beendet: kein taskkill an eine womöglich neu vergebene PID", () => {
    const f = fakePlatform("win32");
    f.exitLeader();
    signalTree(f.proc, "SIGTERM", f.platform);
    expect(f.log).toEqual([]);
  });

  test("PID 0 und 1 bekommen auf keiner Plattform etwas, auch keine Prüfung", () => {
    for (const os of OSES) {
      const f = fakePlatform(os);
      signalTree({ pid: 0, kill: () => f.log.push("kill") }, "SIGTERM", f.platform);
      signalTree({ pid: 1, kill: () => f.log.push("kill") }, "SIGKILL", f.platform);
      stopTree({ pid: 0, kill: () => f.log.push("kill") }, CLAUDE_STOP_PLAN, f.platform);
      expect(f.log).toEqual([]);
      expect(f.timers).toEqual([]);
    }
  });

  test("Fehler beim Fallback bleiben folgenlos", () => {
    const f = fakePlatform("linux", { groupFails: true });
    expect(() =>
      signalTree({ pid: 77, kill: () => { throw new Error("weg"); } }, "SIGTERM", f.platform)
    ).not.toThrow();
  });
});

describe("stopTree (Entscheidung A, Issue #325)", () => {
  test("Claude: SIGTERM, nach 1,5 s SIGKILL, Nachlauf hält den Prozess nicht am Leben", () => {
    expect(CLAUDE_STOP_PLAN).toEqual({ first: "SIGTERM", killAfterMs: 1_500 });
    const f = fakePlatform("linux");
    stopTree(f.proc, CLAUDE_STOP_PLAN, f.platform);
    expect(signals(f.log)).toEqual(["group -4242 SIGTERM"]);
    expect(f.timers.map((t) => [t.ms, t.unrefed])).toEqual([[1_500, true]]);
    f.advance(1_499);
    expect(signals(f.log)).toEqual(["group -4242 SIGTERM"]);
    f.advance(1);
    expect(f.log).toEqual(["check -4242", "group -4242 SIGTERM", "check -4242", "group -4242 SIGKILL"]);
  });

  test("macOS wie Linux, mit dem Plan von Codex und OpenCode", () => {
    const f = fakePlatform("darwin");
    stopTree(f.proc, { first: "SIGINT", killAfterMs: 3_000 }, f.platform);
    f.advance(2_999);
    expect(signals(f.log)).toEqual(["group -4242 SIGINT"]);
    f.advance(1);
    expect(signals(f.log)).toEqual(["group -4242 SIGINT", "group -4242 SIGKILL"]);
  });

  for (const os of ["darwin", "linux"] as const) {
    test(`${os}: Prozess endet nach SIGTERM, Kind ignoriert es: SIGKILL an die Gruppe`, () => {
      const f = fakePlatform(os);
      stopTree(f.proc, CLAUDE_STOP_PLAN, f.platform);
      f.exitLeader();
      f.advance(1_500);
      expect(signals(f.log)).toEqual(["group -4242 SIGTERM", "group -4242 SIGKILL"]);
    });

    test(`${os}: Prozess schon vor stopTree beendet, Kinder (auch später entstandene Enkel) leben: beide Signale an die Gruppe`, () => {
      const f = fakePlatform(os);
      f.exitLeader();
      stopTree(f.proc, CLAUDE_STOP_PLAN, f.platform);
      f.state.members = 4;
      f.advance(1_500);
      expect(signals(f.log)).toEqual(["group -4242 SIGTERM", "group -4242 SIGKILL"]);
    });

    test(`${os}: Gruppe nach SIGTERM leer: kein SIGKILL`, () => {
      const f = fakePlatform(os);
      stopTree(f.proc, CLAUDE_STOP_PLAN, f.platform);
      f.exitLeader();
      f.state.members = 0;
      f.advance(1_500);
      expect(f.log).toEqual(["check -4242", "group -4242 SIGTERM", "check -4242"]);
    });

    test(`${os}: Prozess beendet, Gruppe schon leer: gar kein Signal`, () => {
      const f = fakePlatform(os);
      f.exitLeader();
      f.state.members = 0;
      stopTree(f.proc, CLAUDE_STOP_PLAN, f.platform);
      f.advance(1_500);
      expect(signals(f.log)).toEqual([]);
    });
  }

  test("Windows: taskkill sofort und nach der Wartezeit", () => {
    const f = fakePlatform("win32");
    stopTree(f.proc, CLAUDE_STOP_PLAN, f.platform);
    f.advance(1_500);
    expect(f.log).toEqual(["taskkill 4242", "taskkill 4242"]);
  });

  test("Windows: Prozess schon beendet: kein taskkill an eine womöglich neu vergebene PID", () => {
    const f = fakePlatform("win32");
    f.exitLeader();
    stopTree(f.proc, CLAUDE_STOP_PLAN, f.platform);
    f.advance(1_500);
    expect(f.log).toEqual([]);
  });

  test("Windows: Prozess beendet: kein zweites taskkill an eine womöglich neu vergebene PID", () => {
    const f = fakePlatform("win32");
    stopTree(f.proc, CLAUDE_STOP_PLAN, f.platform);
    f.exitLeader();
    f.advance(1_500);
    expect(f.log).toEqual(["taskkill 4242"]);
  });
});

describe("Codex und OpenCode behalten SIGINT vor SIGKILL", () => {
  function fakeRuntime() {
    const sent: string[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const rt = {
      signal: (_p: unknown, s: string) => void sent.push(s),
      setTimeout: (fn: () => void, ms: number) => (timers.push({ fn, ms }), undefined),
    } as unknown as CodexRuntime;
    return { rt, sent, timers };
  }

  for (const [name, stop, grace] of [
    ["Codex", terminateCodexProcess, CODEX_KILL_GRACE_MS],
    ["OpenCode", terminateOpenCodeProcess, OPENCODE_KILL_GRACE_MS],
  ] as const) {
    test(`${name}: SIGINT, nach ${grace} ms SIGKILL, zweiter Aufruf sendet nichts`, () => {
      expect(grace).toBe(3_000);
      const f = fakeRuntime();
      const proc = { pid: 0, kill() {} };
      stop(proc, f.rt);
      stop(proc, f.rt);
      expect(f.sent).toEqual(["SIGINT"]);
      expect(f.timers.map((t) => t.ms)).toEqual([grace]);
      f.timers[0]!.fn();
      expect(f.sent).toEqual(["SIGINT", "SIGKILL"]);
    });
  }
});

describe("Abbruch-Nachlauf bleibt bis zum SIGKILL verfolgt (Issue #561)", () => {
  test("stopTree: afterKill erst nach dem SIGKILL", () => {
    const f = fakePlatform("linux");
    let done = 0;
    stopTree(f.proc, CLAUDE_STOP_PLAN, f.platform, () => void done++);
    f.advance(1_499);
    expect(done).toBe(0);
    f.advance(1);
    expect(signals(f.log)).toEqual(["group -4242 SIGTERM", "group -4242 SIGKILL"]);
    expect(done).toBe(1);
  });

  for (const [name, stop, grace] of [
    ["Codex", terminateCodexProcess, CODEX_KILL_GRACE_MS],
    ["OpenCode", terminateOpenCodeProcess, OPENCODE_KILL_GRACE_MS],
  ] as const) {
    test(`${name}: Prozess steht bis zum SIGKILL in abortAllEngineCalls, danach nicht mehr; Attrappe mit PID 0 nie`, () => {
      const f = fakePlatform("linux");
      const rt = {
        signal: (p: { pid: number; kill: () => void }, s: "SIGINT" | "SIGKILL") => signalProcessGroup(p, s, f.platform),
        setTimeout: f.platform.setTimeout,
      } as unknown as CodexRuntime;
      const before = terminatingEngineProcCount();
      stop(f.proc, rt);
      stop({ pid: 0, kill() {} }, rt);
      f.exitLeader();
      expect(terminatingEngineProcCount()).toBe(before + 1);
      expect(abortAllEngineCalls()).toContain(f.proc);
      f.advance(grace);
      expect(signals(f.log)).toEqual(["group -4242 SIGINT", "group -4242 SIGKILL"]);
      expect(terminatingEngineProcCount()).toBe(before);
      expect(abortAllEngineCalls()).not.toContain(f.proc);
    });
  }
});

describe("Motor-Beendigung unter Windows (Codex, OpenCode)", () => {
  for (const [name, stop, grace] of [
    ["Codex", terminateCodexProcess, CODEX_KILL_GRACE_MS],
    ["OpenCode", terminateOpenCodeProcess, OPENCODE_KILL_GRACE_MS],
  ] as const) {
    test(`${name}: taskkill sofort und nach 1,5 s, danach nichts mehr`, () => {
      const f = fakePlatform("win32");
      // Motor-Timer und Plattform-Timer laufen auf derselben Uhr
      const rt = {
        signal: (p: { pid: number; kill: () => void }, s: "SIGINT" | "SIGKILL") => signalProcessGroup(p, s, f.platform),
        setTimeout: f.platform.setTimeout,
      } as unknown as CodexRuntime;
      stop(f.proc, rt);
      expect(f.log).toEqual(["taskkill 4242"]);
      f.advance(1_499);
      expect(f.log).toEqual(["taskkill 4242"]);
      f.advance(1);
      expect(f.log).toEqual(["taskkill 4242", "taskkill 4242"]);
      f.advance(grace);
      expect(f.log).toEqual(["taskkill 4242", "taskkill 4242"]);
    });
  }
});

describe("Motor-Beendigung unter macOS und Linux (Codex, OpenCode, Entscheidung A)", () => {
  for (const os of ["darwin", "linux"] as const) {
    for (const [name, stop, grace] of [
      ["Codex", terminateCodexProcess, CODEX_KILL_GRACE_MS],
      ["OpenCode", terminateOpenCodeProcess, OPENCODE_KILL_GRACE_MS],
    ] as const) {
      test(`${os}, ${name}: SIGINT an die Gruppe, Prozess endet, Kind lebt: nach 3 s SIGKILL an die Gruppe, je nach Prüfung`, () => {
        const f = fakePlatform(os);
        const rt = {
          signal: (p: { pid: number; kill: () => void }, s: "SIGINT" | "SIGKILL") => signalProcessGroup(p, s, f.platform),
          setTimeout: f.platform.setTimeout,
        } as unknown as CodexRuntime;
        stop(f.proc, rt);
        f.exitLeader();
        f.advance(grace - 1);
        expect(f.log).toEqual(["check -4242", "group -4242 SIGINT"]);
        f.advance(1);
        expect(f.log).toEqual(["check -4242", "group -4242 SIGINT", "check -4242", "group -4242 SIGKILL"]);
      });

      test(`${os}, ${name}: Gruppe bis zum SIGKILL leer: nur die Prüfung, kein Signal`, () => {
        const f = fakePlatform(os);
        const rt = {
          signal: (p: { pid: number; kill: () => void }, s: "SIGINT" | "SIGKILL") => signalProcessGroup(p, s, f.platform),
          setTimeout: f.platform.setTimeout,
        } as unknown as CodexRuntime;
        stop(f.proc, rt);
        f.exitLeader();
        f.state.members = 0;
        f.advance(grace);
        expect(f.log).toEqual(["check -4242", "group -4242 SIGINT", "check -4242"]);
      });
    }
  }
});
