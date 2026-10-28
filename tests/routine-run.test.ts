/**
 * Issue #285, Checkbox 1: Wrapper src/routine-run.ts mit echtem
 * Unterprozess. Befehle sind kleine Shell-Skripte unter
 * tests/fixtures/routine-run/, das Protokoll liegt in einem Temp-Ordner
 * (TYBO_ROUTINES_ROOT). Kein launchctl.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MASK } from "../src/lib/jobs/mask";
import { appendRun, MAX_RUNS, parseRuns, routineIdAllowed, runsFile, safeRoutineId, TailCollector, TAIL_MAX_BYTES, TAIL_MAX_LINES, TAIL_WITHHELD, type RoutineRun } from "../src/lib/routines/runs";
import { EXIT_NOT_FOUND, EXIT_USAGE, parseWrapperArgs, runWrapped } from "../src/routine-run";

const REPO = join(import.meta.dir, "..");
const WRAPPER = join(REPO, "src", "routine-run.ts");
const FIX = join(import.meta.dir, "fixtures", "routine-run");
const ID = "ai.tybo.health-check";
const SECRET = "geheim-0123456789-abcdef";

const tmp = await mkdtemp(join(tmpdir(), "routine-run-"));
afterAll(() => rm(tmp, { recursive: true, force: true }));
let n = 0;

async function freshRoot(): Promise<string> {
  const root = join(tmp, `root-${++n}`);
  await mkdir(join(root, "config"), { recursive: true });
  return root;
}

interface CliResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

function startCli(root: string, args: string[], env: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, "--no-env-file", WRAPPER, ...args], {
    cwd: root,
    // Meldungen aus (Issue #287): kein Test sendet echt; sie prüft routine-alerts.test.ts mit Attrappe
    env: { ...process.env, TYBO_ROUTINES_ROOT: root, ROUTINE_ALERTS: "off", ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
}

async function cli(root: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const proc = startCli(root, args, env);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode, signal: proc.signalCode ?? null, stdout, stderr };
}

async function runs(root: string, id = ID): Promise<RoutineRun[]> {
  return parseRuns(await readFile(runsFile(root, id), "utf-8"));
}

describe("Wrapper als Befehl", () => {
  test("Erfolg: Exit 0, stdout und stderr getrennt und unverändert, ein Eintrag", async () => {
    const root = await freshRoot();
    const r = await cli(root, ["--id", ID, "--", "/bin/sh", join(FIX, "exit.sh"), "0"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("aus-stdout\n");
    expect(r.stderr).toBe("aus-stderr\n");
    const [run, ...more] = await runs(root);
    expect(more).toEqual([]);
    expect(run.exitCode).toBe(0);
    expect(run.signal).toBeUndefined();
    expect(run.tail.sort()).toEqual(["aus-stderr", "aus-stdout"]);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(run.endedAt) - Date.parse(run.startedAt)).toBe(run.durationMs);
  });

  test("Exit 3 bleibt Exit 3 und steht im Protokoll", async () => {
    const root = await freshRoot();
    const r = await cli(root, ["--id", ID, "--", "/bin/sh", join(FIX, "exit.sh"), "3"]);
    expect(r.code).toBe(3);
    expect((await runs(root))[0].exitCode).toBe(3);
  });

  test("Befehl fehlt: Exit 127, Fehlerzeile als tail", async () => {
    const root = await freshRoot();
    const r = await cli(root, ["--id", ID, "--", "/gibt/es/nicht/befehl", "x"]);
    expect(r.code).toBe(EXIT_NOT_FOUND);
    expect(r.stderr).toContain("Befehl konnte nicht starten: /gibt/es/nicht/befehl");
    const [run] = await runs(root);
    expect(run.exitCode).toBe(127);
    expect(run.tail).toHaveLength(1);
    expect(run.tail[0]).toContain("Befehl konnte nicht starten");
  });

  test("50 Zeilen Ausgabe ergeben 20 Zeilen tail, Rest ohne Umbruch zählt mit, Leerzeilen nicht", async () => {
    const root = await freshRoot();
    const r = await cli(root, ["--id", ID, "--", "/bin/sh", join(FIX, "lines.sh")]);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toHaveLength(51);
    const [run] = await runs(root);
    expect(run.tail).toHaveLength(TAIL_MAX_LINES);
    expect(run.tail[0]).toBe("zeile 32");
    expect(run.tail[18]).toBe("zeile 50");
    expect(run.tail[19]).toBe("rest-ohne-umbruch");
  });

  test("ein Geheimnis aus der .env erscheint maskiert, auch über zwei Ausgabestücke; die Ausgabe selbst bleibt unverändert", async () => {
    const root = await freshRoot();
    await writeFile(join(root, ".env"), `ROUTINE_TEST_SECRET=${SECRET}\n`);
    const r = await cli(root, ["--id", ID, "--", "/bin/sh", join(FIX, "secret.sh")], { ROUTINE_TEST_SECRET: SECRET });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`schluessel=${SECRET} ende\n`);
    const raw = await readFile(runsFile(root, ID), "utf-8");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(SECRET.slice(0, 8) + SECRET.slice(8, 12));
    expect((await runs(root))[0].tail).toEqual([`schluessel=${MASK} ende`]);
  });

  test(".env nicht lesbar: Befehl läuft unverändert mit seinem Exit-Code, die Ausgabe bleibt aus dem Protokoll", async () => {
    const root = await freshRoot();
    // Ordner statt Datei: Lesefehler, der nicht „fehlt" heißt (auch als root)
    await mkdir(join(root, ".env"));
    const env = { ROUTINE_TEST_SECRET: SECRET };
    const ok = await cli(root, ["--id", ID, "--", "/bin/sh", join(FIX, "secret.sh")], env);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe(`schluessel=${SECRET} ende\n`);
    expect(ok.stderr).toContain(".env nicht lesbar");
    const fail = await cli(root, ["--id", ID, "--", "/bin/sh", join(FIX, "exit.sh"), "3"], env);
    expect(fail.code).toBe(3);
    expect(fail.stdout).toBe("aus-stdout\n");
    expect(fail.stderr).toContain("aus-stderr\n");
    const raw = await readFile(runsFile(root, ID), "utf-8");
    expect(raw).not.toContain(SECRET.slice(0, 8));
    expect(raw).not.toContain("aus-stdout");
    const list = await runs(root);
    expect(list.map(r => r.exitCode)).toEqual([0, 3]);
    for (const run of list) expect(run.tail).toEqual([TAIL_WITHHELD]);
  });

  test("UTF-8 bleibt ganz, eine überlange Zeile wird auf 4 KB gekürzt (auch unter LC_ALL=C)", async () => {
    const root = await freshRoot();
    const r = await cli(root, ["--id", ID, "--", "/bin/sh", join(FIX, "wide.sh")], { LC_ALL: "C" });
    expect(r.code).toBe(0);
    const [run] = await runs(root);
    expect(run.tail.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.byteLength(run.tail.join("\n"), "utf-8")).toBeLessThanOrEqual(TAIL_MAX_BYTES);
    const last = run.tail[run.tail.length - 1];
    expect(last.startsWith("ää")).toBe(true);
    expect(last.endsWith("…")).toBe(true);
    expect(last).not.toContain("�");
  });

  test("ungültige id startet nichts: Exit 2, kein Protokoll", async () => {
    const root = await freshRoot();
    const marker = join(root, "gestartet");
    for (const id of ["../ausbruch", "com.fremd.dienst", "ai.tybo.", "ai.tybo.a/b", "ai.tybo..x", ""]) {
      const r = await cli(root, ["--id", id, "--", "/usr/bin/touch", marker]);
      expect(r.code).toBe(EXIT_USAGE);
      expect(existsSync(marker)).toBe(false);
    }
    expect(existsSync(join(root, "data"))).toBe(false);
    // Ohne „--" oder ohne Befehl ebenso
    expect((await cli(root, ["--id", ID, "/usr/bin/touch", marker])).code).toBe(EXIT_USAGE);
    expect((await cli(root, ["--id", ID, "--"])).code).toBe(EXIT_USAGE);
    expect(existsSync(marker)).toBe(false);
  });

  test("Label aus config/routines.json ist zugelassen (Labels und Präfixe)", async () => {
    const root = await freshRoot();
    await writeFile(join(root, "config", "routines.json"), JSON.stringify({ labels: ["com.example.backup"], prefixes: ["org.beispiel."] }));
    expect((await cli(root, ["--id", "com.example.backup", "--", "/usr/bin/true"])).code).toBe(0);
    expect((await cli(root, ["--id", "org.beispiel.sync", "--", "/usr/bin/true"])).code).toBe(0);
    expect((await cli(root, ["--id", "com.example.other", "--", "/usr/bin/true"])).code).toBe(EXIT_USAGE);
    expect(await runs(root, "com.example.backup")).toHaveLength(1);
    expect(await runs(root, "org.beispiel.sync")).toHaveLength(1);
  });

  test("Protokoll nicht schreibbar: Exit-Code bleibt, Meldung nur auf stderr", async () => {
    const root = await freshRoot();
    // data/routines ist eine Datei, kein Ordner
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(join(root, "data", "routines"), "kein Ordner");
    const ok = await cli(root, ["--id", ID, "--", "/bin/sh", join(FIX, "exit.sh"), "0"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe("aus-stdout\n");
    expect(ok.stderr).toContain("Protokoll für ai.tybo.health-check nicht geschrieben");
    const fail = await cli(root, ["--id", ID, "--", "/bin/sh", join(FIX, "exit.sh"), "5"]);
    expect(fail.code).toBe(5);
  });

  test("parallele Läufe verlieren keinen Eintrag", async () => {
    const root = await freshRoot();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => cli(root, ["--id", ID, "--", "/bin/sh", join(FIX, "exit.sh"), String(i)])));
    expect(results.map(r => r.code)).toEqual([0, 1, 2, 3, 4, 5]);
    expect((await runs(root)).map(r => r.exitCode).sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  async function startAndWaitReady(root: string, script: string) {
    const proc = startCli(root, ["--id", ID, "--", "/bin/sh", join(FIX, script)]);
    const reader = proc.stdout.getReader();
    let seen = "";
    while (!seen.includes("bereit")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    const stderr = new Response(proc.stderr).text();
    return { proc, stderr, rest: (async () => { while (!(await reader.read()).done); })() };
  }

  test("SIGTERM wird weitergegeben: Befehl fängt es ab und endet mit 0, Lauf gilt als abgebrochen", async () => {
    const root = await freshRoot();
    const { proc, stderr, rest } = await startAndWaitReady(root, "trap-term.sh");
    proc.kill("SIGTERM");
    await proc.exited;
    await rest;
    expect(await stderr).toContain("SIGTERM erhalten");
    expect(proc.exitCode).toBe(0);
    const [run] = await runs(root);
    expect(run.signal).toBe("SIGTERM");
    expect(run.exitCode).toBe(0);
    expect(run.tail).toContain("SIGTERM erhalten");
    expect(run.endedAt >= run.startedAt).toBe(true);
  }, 15_000);

  test("SIGTERM ohne eigene Behandlung: Befehl endet am Signal, der Wrapper ebenso, Exit 143 im Protokoll", async () => {
    const root = await freshRoot();
    const { proc, rest } = await startAndWaitReady(root, "default-term.sh");
    proc.kill("SIGTERM");
    await proc.exited;
    await rest;
    expect(proc.signalCode).toBe("SIGTERM");
    const [run] = await runs(root);
    expect(run.signal).toBe("SIGTERM");
    expect(run.exitCode).toBe(143);
  }, 15_000);
});

describe("Wrapper im Prozess", () => {
  test("25 Läufe ergeben 20 Einträge, die ältesten fallen weg", async () => {
    const root = await freshRoot();
    const sink = () => {};
    for (let i = 0; i < 25; i++) {
      const r = await runWrapped({ id: ID, command: ["/bin/sh", "-c", `echo lauf-${i}`], root, stdout: sink, stderr: sink });
      expect(r.exitCode).toBe(0);
    }
    const list = await runs(root);
    expect(list).toHaveLength(MAX_RUNS);
    expect(list[0].tail).toEqual(["lauf-5"]);
    expect(list[19].tail).toEqual(["lauf-24"]);
  });

  test("Schreibfehler und Sperrfehler ändern den Exit-Code nie", async () => {
    const root = await freshRoot();
    const notes: string[] = [];
    const sink = () => {};
    const broken = await runWrapped({
      id: ID,
      command: ["/bin/sh", "-c", "exit 4"],
      root,
      stdout: sink,
      stderr: sink,
      note: l => notes.push(l),
      append: async () => {
        throw new Error("Platte voll");
      },
    });
    expect(broken.exitCode).toBe(4);
    expect(notes.join("\n")).toContain("Platte voll");
    // Sperre gehört einem lebenden Prozess: Warten endet mit Fehler, Exit bleibt 0
    const file = runsFile(root, ID);
    await mkdir(join(root, "data", "routines"), { recursive: true });
    await writeFile(`${file}.lock`, JSON.stringify({ token: "fremd", pid: process.pid }));
    const locked = await runWrapped({
      id: ID,
      command: ["/bin/sh", "-c", "exit 0"],
      root,
      stdout: sink,
      stderr: sink,
      note: l => notes.push(l),
      append: (r, i, run) => appendRun(r, i, run, { lock: { waitMs: 50 } }),
    });
    expect(locked.exitCode).toBe(0);
    expect(notes.join("\n")).toContain("belegt");
  });
});

describe("Bausteine", () => {
  test("parseWrapperArgs", () => {
    expect(parseWrapperArgs(["--id", ID, "--", "bun", "run", "x.ts"])).toEqual({ id: ID, command: ["bun", "run", "x.ts"] });
    expect("error" in parseWrapperArgs([])).toBe(true);
    expect("error" in parseWrapperArgs(["--id", "--", "x"])).toBe(true);
  });

  test("ids: nur sichere Dateinamen, nur Routinen", () => {
    const config = { labels: ["com.example.backup"], prefixes: ["org.beispiel."] };
    for (const id of [ID, "ai.tybo.x_1-2", "com.example.backup", "org.beispiel.a"]) expect(routineIdAllowed(id, config)).toBe(true);
    for (const id of ["../x", "ai.tybo./x", "ai.tybo.", "ai.tybo..", "ai.tybo.a\\b", "/etc/passwd", "com.example.backupx", "ai.tybo.x\n", ".hidden"]) {
      expect(routineIdAllowed(id, config)).toBe(false);
    }
    expect(safeRoutineId("a".repeat(201))).toBe(false);
    expect(() => runsFile("/r", "../x")).toThrow();
  });

  test("TailCollector: UTF-8 über Stückgrenzen, Geheimnis über Stückgrenzen, getrennte Ströme", () => {
    const t = new TailCollector([SECRET]);
    const bytes = new TextEncoder().encode(`Grüße ${SECRET}\n`);
    // mitten im „ü" und mitten im Geheimnis teilen
    const cut1 = 3;
    const cut2 = bytes.length - 6;
    t.push("stdout", bytes.slice(0, cut1));
    t.push("stderr", new TextEncoder().encode("fehler"));
    t.push("stdout", bytes.slice(cut1, cut2));
    t.push("stdout", bytes.slice(cut2));
    expect(t.finish()).toEqual([`Grüße ${MASK}`, "fehler"]);
  });

  test("TailCollector: höchstens 20 Zeilen und 4 KB zusammen", () => {
    const t = new TailCollector([]);
    for (let i = 0; i < 30; i++) t.push("stdout", new TextEncoder().encode(`${"x".repeat(500)}-${i}\n`));
    const tail = t.finish();
    expect(tail.length).toBeLessThanOrEqual(TAIL_MAX_LINES);
    expect(Buffer.byteLength(tail.join("\n"))).toBeLessThanOrEqual(TAIL_MAX_BYTES);
    expect(tail[tail.length - 1].endsWith("-29")).toBe(true);
  });

  test("TailCollector: Reihenfolge der Ströme bleibt, auch wenn die Maske eine Zeile zurückhält", () => {
    const t = new TailCollector(["m".repeat(40)]);
    const enc = new TextEncoder();
    t.push("stdout", enc.encode("frueher\n"));
    for (let i = 1; i <= 25; i++) t.push("stderr", enc.encode(`spaeter-${i}\n`));
    const tail = t.finish();
    expect(tail).toEqual(Array.from({ length: 20 }, (_, i) => `spaeter-${i + 6}`));
  });

  test("TailCollector: Reihenfolge stimmt auch, wenn die frühere Zeile noch gebraucht wird", () => {
    const t = new TailCollector(["m".repeat(40)]);
    const enc = new TextEncoder();
    t.push("stdout", enc.encode("frueher\n"));
    t.push("stderr", enc.encode("spaeter-1\nspaeter-2\n"));
    t.push("stdout", enc.encode("rest"));
    t.push("stderr", enc.encode("zuletzt\n"));
    // „rest" hat keinen Umbruch, er endet erst mit dem Strom
    expect(t.finish()).toEqual(["frueher", "spaeter-1", "spaeter-2", "zuletzt", "rest"]);
  });

  test("TailCollector: die 4-KB-Grenze gilt schon beim Sammeln, nicht erst bei finish()", () => {
    const t = new TailCollector([SECRET]);
    const enc = new TextEncoder();
    for (let i = 0; i < 200; i++) {
      t.push(i % 2 ? "stdout" : "stderr", enc.encode(`${"x".repeat(1_000)}-${i}\n`));
      const now = t.buffered();
      expect(now.lines + now.partial).toBeLessThanOrEqual(TAIL_MAX_BYTES);
      expect(now.total).toBeLessThanOrEqual(TAIL_MAX_BYTES);
    }
    // eine Zeile ohne Umbruch, viel länger als die Grenze
    for (let i = 0; i < 100; i++) {
      t.push("stdout", enc.encode("y".repeat(1_000)));
      const now = t.buffered();
      expect(now.lines + now.partial).toBeLessThanOrEqual(TAIL_MAX_BYTES);
      expect(now.total).toBeLessThanOrEqual(TAIL_MAX_BYTES);
    }
    const tail = t.finish();
    expect(Buffer.byteLength(tail.join("\n"))).toBeLessThanOrEqual(TAIL_MAX_BYTES);
    expect(tail[tail.length - 1].startsWith("yyy")).toBe(true);
  });

  test("TailCollector: fertige und angefangene Zeilen beider Ströme teilen sich die 4 KB", () => {
    const t = new TailCollector([]);
    const enc = new TextEncoder();
    t.push("stdout", enc.encode(`${"x".repeat(4096)}\n`));
    t.push("stdout", enc.encode("y".repeat(4096)));
    t.push("stderr", enc.encode("z".repeat(4096)));
    const now = t.buffered();
    expect(now.lines + now.partial).toBeLessThanOrEqual(TAIL_MAX_BYTES);
    expect(now.total).toBeLessThanOrEqual(TAIL_MAX_BYTES);
    const tail = t.finish();
    expect(Buffer.byteLength(tail.join("\n"))).toBeLessThanOrEqual(TAIL_MAX_BYTES);
    // die neuere angefangene Zeile bleibt, die ältere macht Platz
    expect(tail[tail.length - 1].startsWith("zzz")).toBe(true);
  });

  for (const [alt, neu] of [["stdout", "stderr"], ["stderr", "stdout"]]) {
    for (const ende of ["", "\n"]) {
      test(`TailCollector: volle Teilzeile auf ${alt} verdrängt neuere Ausgabe auf ${neu} nicht (${ende ? "mit" : "ohne"} Umbruch)`, () => {
        const t = new TailCollector([]);
        const enc = new TextEncoder();
        t.push(alt, enc.encode("y".repeat(TAIL_MAX_BYTES)));
        t.push(neu, enc.encode(`NEUESTER-FEHLER${ende}`));
        const now = t.buffered();
        expect(now.total).toBeLessThanOrEqual(TAIL_MAX_BYTES);
        expect(now.lines + now.partial).toBeLessThanOrEqual(TAIL_MAX_BYTES);
        const tail = t.finish();
        expect(tail).toContain("NEUESTER-FEHLER");
        expect(Buffer.byteLength(tail.join("\n"))).toBeLessThanOrEqual(TAIL_MAX_BYTES);
        // die ältere Zeile ist gekürzt, nicht ganz verloren
        expect(tail.some((line) => line.startsWith("yyy"))).toBe(true);
      });
    }
  }

  test("TailCollector: Geheimnis mit Umbruch verdrängt die neueste Zeile nicht", () => {
    const t = new TailCollector(["alpha\nbeta"]);
    const enc = new TextEncoder();
    for (let i = 0; i < 30; i++) t.push("stdout", enc.encode("alpha\nbeta\n"));
    for (let i = 1; i <= 25; i++) t.push("stderr", enc.encode(`spaeter-${i}\n`));
    t.push("stdout", enc.encode("NEUESTE-ZEILE\n"));
    expect(t.finish()).toEqual([...Array.from({ length: 19 }, (_, i) => `spaeter-${i + 7}`), "NEUESTE-ZEILE"]);
  });

  test("TailCollector: Umbrüche aus Geheimnissen stauen sich nicht in der Warteschlange", () => {
    const t = new TailCollector(["alpha\nbeta"]);
    const enc = new TextEncoder();
    for (let i = 0; i < 1_000; i++) {
      t.push("stdout", enc.encode(`alpha\nbeta\nzeile-${i}\n`));
      // zurückgehalten wird höchstens so viel, wie das längste Geheimnis braucht
      expect(t.buffered().queued).toBeLessThanOrEqual(2);
    }
    t.push("stderr", enc.encode("fehler\n"));
    const tail = t.finish();
    expect(tail[tail.length - 1]).toBe("fehler");
    expect(tail[tail.length - 2]).toBe("zeile-999");
  });
});
