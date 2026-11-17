/**
 * Issue #565: Fehlt die Claude CLI, wird der gescheiterte Start in allen drei
 * Aufrufwegen zu einem festen Ergebnis. Unter Linux wirft der Start (die
 * Attrappe wirft ENOENT wie Bun), unter macOS startet caffeinate und endet mit
 * 127 ohne Ausgabe. Beide Plattformen laufen als Parameter über
 * setRuntimeForTests({ os }); kein Test startet claude wirklich.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  callClaude,
  callClaudeStreaming,
  runClaudeWithTimeout,
  setRuntimeForTests,
  setSpawnForTests,
  type ClaudeResult,
} from "../src/lib/claude";
import {
  CLAUDE_NOT_INSTALLED_NOTICE,
  classifyExit,
  classifySpawnError,
  safeErrorCode,
  startFailureLogText,
} from "../src/lib/claude/start-failure";
import { registeredEngineCallCount, trackedEngineProcCount } from "../src/lib/engines/calls";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { isolateShellEnv } from "./shell-env";

isolateShellEnv({ CLAUDE_EFFORT: undefined, CLAUDE_AUTH: undefined, ANTHROPIC_API_KEY: undefined, CLAUDE_PATH: undefined });

/** Wie Bun.spawn, wenn das Programm nicht im PATH liegt */
function enoent(message = 'Executable not found in $PATH: "claude"') {
  return Object.assign(new Error(message), { code: "ENOENT", errno: -2 });
}

/** Prozessattrappe: Ausgabe, stderr und Exit-Code fest */
function finishedProcess(opts: { stdout?: string; stderr?: string; exitCode: number }) {
  const enc = new TextEncoder();
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (text) c.enqueue(enc.encode(text));
        c.close();
      },
    });
  return {
    pid: 0,
    stdin: { write() {}, end() {} },
    stdout: stream(opts.stdout ?? ""),
    stderr: stream(opts.stderr ?? ""),
    exited: Promise.resolve(opts.exitCode),
    exitCode: opts.exitCode,
    kill() {},
  };
}

let spawned: string[][];
let timersStarted: number;
let terminated: number;

/** Laufzeit für eine Plattform; Zeitlimits zählen mit, damit ein gescheiterter Start keine anlegt */
function useRuntime(os: NodeJS.Platform) {
  setRuntimeForTests({
    os,
    setTimeout: (fn, ms) => {
      timersStarted++;
      return setTimeout(fn, ms);
    },
    setInterval: (fn, ms) => {
      timersStarted++;
      return setInterval(fn, ms);
    },
    terminate: () => void terminated++,
  });
}

/**
 * Was die Plattform bei fehlendem claude tut: Linux wirft beim Start, macOS
 * startet caffeinate, das mit 127 endet (Wortlaut wie auf einem echten Mac)
 */
function missingClaude(os: NodeJS.Platform) {
  setSpawnForTests(((o: { cmd: string[] }) => {
    spawned.push(o.cmd);
    if (o.cmd[0] !== "/usr/bin/caffeinate") throw enoent();
    return finishedProcess({ stderr: "claude: No such file or directory\n", exitCode: 127 });
  }) as any);
  useRuntime(os);
}

beforeAll(() => setMcpReaderForTests(() => new Set()));
afterAll(() => {
  setSpawnForTests(null);
  setRuntimeForTests(null);
  setMcpReaderForTests(null);
});
beforeEach(() => {
  spawned = [];
  timersStarted = 0;
  terminated = 0;
});
afterEach(() => {
  setSpawnForTests(null);
  setRuntimeForTests(null);
});

const WAYS: [string, () => Promise<ClaudeResult>][] = [
  ["callClaude Text", () => callClaude({ prompt: "p", model: "m" })],
  ["callClaude JSON", () => callClaude({ prompt: "p", outputFormat: "json", model: "m" })],
  ["callClaudeStreaming", () => callClaudeStreaming({ prompt: "p", model: "m", idleTimeoutMs: 60_000 })],
];

describe.each(["linux", "darwin"] as const)("Claude CLI fehlt auf %s", (os) => {
  test.each(WAYS)("%s: Fehlerergebnis not_installed, kein Wurf", async (_name, run) => {
    missingClaude(os);
    // Andere Testdateien im selben Lauf können Einträge hinterlassen: nur die Änderung zählt
    const registeredBefore = registeredEngineCallCount();
    const trackedBefore = trackedEngineProcCount();
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await run();
      expect(result.isError).toBe(true);
      expect(result.errorKind).toBe("not_installed");
      expect(result.aborted).toBeUndefined();
      expect(result.timedOut).toBeUndefined();
      expect(result.sessionId).toBeUndefined();
      expect(result.text).toContain("Claude Code konnte nicht gestartet werden");
      // Gleiches Verhalten, verschiedener Weg: Linux ruft claude, macOS caffeinate
      if (os === "darwin") expect(spawned[0]!.slice(0, 2)).toEqual(["/usr/bin/caffeinate", "-i"]);
      else expect(spawned[0]![0]).toMatch(/claude$/);
      expect(error.mock.calls.some((c) => String(c[0]).includes("Start fehlgeschlagen"))).toBe(true);
    } finally {
      error.mockRestore();
    }
    expect(registeredEngineCallCount()).toBe(registeredBefore);
    expect(trackedEngineProcCount()).toBe(trackedBefore);
    expect(terminated).toBe(0);
  });

  test("runClaudeWithTimeout: Rohtext-Vertrag bleibt (Linux wirft den Startfehler, macOS liefert die leere Ausgabe)", async () => {
    missingClaude(os);
    const registeredBefore = registeredEngineCallCount();
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      if (os === "linux") {
        await expect(runClaudeWithTimeout("p", 60_000)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await runClaudeWithTimeout("p", 60_000)).toBe("");
      }
    } finally {
      error.mockRestore();
    }
    expect(registeredEngineCallCount()).toBe(registeredBefore);
  });

  test("eine echte Antwort mit Exit-Code 0 bleibt eine Antwort", async () => {
    setSpawnForTests(((o: { cmd: string[] }) => (spawned.push(o.cmd), finishedProcess({ stdout: "Hallo", exitCode: 0 }))) as any);
    useRuntime(os);
    const result = await callClaude({ prompt: "p", model: "m" });
    expect(result).toEqual({ text: "Hallo", isError: false });
    expect(await runClaudeWithTimeout("p", 60_000)).toBe("Hallo");
  });
});

test("Linux: ein gescheiterter Start legt weder Zeitlimit noch Register-Eintrag an", async () => {
  missingClaude("linux");
  const registeredBefore = registeredEngineCallCount();
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const [, run] of WAYS) await run();
  } finally {
    error.mockRestore();
  }
  expect(timersStarted).toBe(0);
  expect(registeredEngineCallCount()).toBe(registeredBefore);
});

test("macOS: Exit 127 mit Ausgabe ist kein fehlendes Programm", () => {
  expect(classifyExit(127, "Teilantwort", { customPath: false })).toBeUndefined();
  expect(classifyExit(1, "", { customPath: false })).toBeUndefined();
  expect(classifyExit(null, "", { customPath: false })).toBeUndefined();
  expect(classifyExit(127, "  \n", { customPath: false })?.kind).toBe("not_installed");
});

describe("Einordnung der Startfehler", () => {
  const ctx = { cwd: "/projekt", customPath: false, isDirectory: () => true };

  test("ENOENT bei vorhandenem Arbeitsverzeichnis: nicht installiert", () => {
    expect(classifySpawnError(enoent(), ctx)).toEqual({ kind: "not_installed", code: "ENOENT", reason: "claude nicht im PATH des Dienstes" });
  });

  test("ENOENT bei fehlendem Arbeitsverzeichnis: kein fehlendes Programm", () => {
    const err = Object.assign(new Error("ENOENT: no such file or directory, posix_spawn 'claude'"), { code: "ENOENT", syscall: "posix_spawn" });
    expect(classifySpawnError(err, { ...ctx, isDirectory: () => false })).toEqual({
      kind: "other",
      code: "ENOENT",
      syscall: "posix_spawn",
      reason: "Arbeitsverzeichnis des Laufs fehlt oder ist kein Verzeichnis",
    });
  });

  test("ENOTDIR, weil das Arbeitsverzeichnis eine vorhandene Datei ist: kein fehlendes Programm", () => {
    // Echte Prüfung im Dateisystem: diese Testdatei gibt es, ein Verzeichnis ist sie nicht
    const err = Object.assign(new Error("ENOTDIR: not a directory, posix_spawn 'claude'"), { code: "ENOTDIR", syscall: "posix_spawn" });
    expect(classifySpawnError(err, { cwd: import.meta.path, customPath: false })).toEqual({
      kind: "other",
      code: "ENOTDIR",
      syscall: "posix_spawn",
      reason: "Arbeitsverzeichnis des Laufs fehlt oder ist kein Verzeichnis",
    });
    // Ein echtes Verzeichnis bleibt beim fehlenden Programm
    expect(classifySpawnError(enoent(), { cwd: import.meta.dir, customPath: false }).kind).toBe("not_installed");
  });

  test("callClaude mit einer Datei als cwd: Startfehler other, nicht not_installed", async () => {
    // Attrappe wirft wie Bun.spawn mit einer Datei als cwd; kein Modellaufruf
    setSpawnForTests(((o: { cmd: string[] }) => {
      spawned.push(o.cmd);
      throw Object.assign(new Error("ENOTDIR: not a directory, posix_spawn 'claude'"), { code: "ENOTDIR", syscall: "posix_spawn" });
    }) as any);
    useRuntime("linux");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await callClaude({ prompt: "p", model: "m", cwd: import.meta.path });
      expect(result.isError).toBe(true);
      expect(result.errorKind).toBe("other");
      expect(result.text).toContain("Arbeitsverzeichnis des Laufs fehlt oder ist kein Verzeichnis");
      expect(result.text).toContain("code=ENOTDIR");
      expect(result.text).not.toContain(import.meta.path);
    } finally {
      error.mockRestore();
    }
  });

  test("EACCES: nicht ausführbar, nicht als fehlend gemeldet", () => {
    const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
    expect(classifySpawnError(err, ctx).kind).toBe("other");
    expect(classifySpawnError(err, { ...ctx, customPath: true }).reason).toBe("CLAUDE_PATH ist nicht ausführbar");
  });

  test("CLAUDE_PATH zeigt ins Leere: im Grund benannt", () => {
    expect(classifySpawnError(enoent(), { ...ctx, customPath: true }).reason).toBe("Programm aus CLAUDE_PATH nicht gefunden");
  });

  test("Fehler ohne Code: anderer Startfehler", () => {
    expect(classifySpawnError(new Error("kaputt"), ctx)).toEqual({ kind: "other", reason: "Start der Claude CLI fehlgeschlagen" });
    expect(classifySpawnError("kaputt", ctx).kind).toBe("other");
  });

});

describe("Geheimnisschutz der Diagnose", () => {
  const SECRET = "sk-ant-api03-GEHEIM1234567890";

  test("weder Meldung noch fremde Felder gelangen in Text oder Log", async () => {
    setSpawnForTests(((o: { cmd: string[] }) => {
      spawned.push(o.cmd);
      throw Object.assign(new Error(`Executable not found: ANTHROPIC_API_KEY=${SECRET}`), {
        code: "ENOENT",
        syscall: `spawn ${SECRET}`,
        path: `/home/${SECRET}/claude`,
      });
    }) as any);
    useRuntime("linux");
    const error = spyOn(console, "error").mockImplementation(() => {});
    let result: ClaudeResult;
    let logged: string;
    try {
      result = await callClaudeStreaming({ prompt: "p", model: "m" });
      logged = error.mock.calls.flat().map(String).join("\n");
    } finally {
      error.mockRestore();
    }
    expect(result.errorKind).toBe("not_installed");
    expect(result.text).not.toContain(SECRET);
    expect(logged).not.toContain(SECRET);
    expect(logged).toContain("code=ENOENT");
  });

  test("nur Codes in der Form E… werden übernommen", () => {
    expect(safeErrorCode({ code: "ENOENT" })).toBe("ENOENT");
    expect(safeErrorCode({ code: `ENOENT ${SECRET}` })).toBeUndefined();
    expect(safeErrorCode({ code: 2 })).toBeUndefined();
    expect(safeErrorCode(null)).toBeUndefined();
    expect(startFailureLogText({ kind: "other", reason: "x", code: "EACCES", exitCode: 1 })).toBe("x, code=EACCES, exit=1");
  });

  test("der Hinweis an den Nutzer ist fest und nennt den nächsten Schritt", () => {
    expect(CLAUDE_NOT_INSTALLED_NOTICE).toBe(
      "Claude Code ist auf diesem Rechner nicht installiert oder nicht im Suchpfad des Dienstes. Prüfen mit: tybo pruefen"
    );
  });
});
