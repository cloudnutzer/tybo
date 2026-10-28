/**
 * Issue #165: Hülle scripts/run-once-and-stay.ts für tybo-supabase unter PM2.
 * Führt den Befehl genau einmal aus und bleibt danach stehen (egal mit
 * welchem Exit-Code), damit der PM2-Eintrag „online“ bleibt. Signale gehen an
 * den laufenden Befehl. Alles mit Attrappen, kein Prozess wird gestartet.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnceAndStay, writeStateFile, type OnceDeps, type OnceState } from "../scripts/run-once-and-stay";

function fake(exitCode = 0) {
  let finish!: (code: number) => void;
  const exited = new Promise<number>(r => (finish = r));
  const state = {
    spawned: [] as string[][],
    killed: [] as string[],
    logs: [] as string[],
    stayed: 0,
    exits: [] as number[],
    states: [] as Array<[string, OnceState]>,
    signal: null as ((s: NodeJS.Signals) => void) | null,
    finish: (code = exitCode) => finish(code),
  };
  const deps: OnceDeps = {
    spawn: cmd => {
      state.spawned.push(cmd);
      return { exited, kill: s => state.killed.push(s) };
    },
    log: l => state.logs.push(l),
    stay: () => state.stayed++,
    onSignal: h => (state.signal = h),
    exit: c => state.exits.push(c),
    writeState: (file, st) => state.states.push([file, st]),
    pid: 4242,
  };
  return { state, deps };
}

describe("run-once-and-stay", () => {
  test("führt <bun> --no-env-file <skript> … genau einmal aus und bleibt danach stehen", async () => {
    const { state, deps } = fake();
    const done = runOnceAndStay(["/p/scripts/tybo.ts", "datenbank", "start"], "/opt/bun", deps);
    state.finish(0);
    expect(await done).toBe(0);
    expect(state.spawned).toEqual([["/opt/bun", "--no-env-file", "/p/scripts/tybo.ts", "datenbank", "start"]]);
    expect(state.stayed).toBe(1);
    expect(state.exits).toEqual([]);
    expect(state.logs.join(" ")).toContain("Exit 0");
  });

  test("Start scheitert (Exit 1): trotzdem stehen bleiben, keine Wiederholung", async () => {
    const { state, deps } = fake();
    const done = runOnceAndStay(["/p/scripts/tybo.ts", "datenbank", "start"], "/opt/bun", deps);
    state.finish(1);
    expect(await done).toBe(1);
    expect(state.spawned.length).toBe(1);
    expect(state.stayed).toBe(1);
    expect(state.exits).toEqual([]);
    expect(state.logs.join(" ")).toContain("Exit 1");
  });

  test("SIGINT während des Befehls: an den Befehl weiter, nach seinem Ende Exit 130, kein Stehenbleiben", async () => {
    const { state, deps } = fake();
    const done = runOnceAndStay(["/p/scripts/tybo.ts", "datenbank", "start"], "/opt/bun", deps);
    state.signal!("SIGINT");
    state.signal!("SIGINT");
    expect(state.killed).toEqual(["SIGINT"]);
    expect(state.exits).toEqual([]);
    state.finish(130);
    await done;
    expect(state.exits).toEqual([130]);
    expect(state.stayed).toBe(0);
  });

  test("SIGTERM nach dem Befehl (pm2 stop): Ende mit 143, nichts neu gestartet", async () => {
    const { state, deps } = fake();
    const done = runOnceAndStay(["/p/scripts/tybo.ts", "datenbank", "start"], "/opt/bun", deps);
    state.finish(0);
    await done;
    state.signal!("SIGTERM");
    expect(state.exits).toEqual([143]);
    expect(state.spawned.length).toBe(1);
    expect(state.killed).toEqual([]);
  });

  test("--state: erst „läuft“, nach dem Befehl „beendet“ mit Exit-Code; die Hülle bleibt auch bei Exit 1 stehen", async () => {
    for (const code of [0, 1]) {
      const { state, deps } = fake();
      const done = runOnceAndStay(["--state", "/p/data/supabase-start.json", "/p/scripts/tybo.ts", "datenbank", "start"], "/opt/bun", deps);
      expect(state.states).toEqual([["/p/data/supabase-start.json", { pid: 4242, state: "läuft" }]]);
      state.finish(code);
      expect(await done).toBe(code);
      expect(state.spawned).toEqual([["/opt/bun", "--no-env-file", "/p/scripts/tybo.ts", "datenbank", "start"]]);
      expect(state.states[1]).toEqual(["/p/data/supabase-start.json", { pid: 4242, state: "beendet", exitCode: code }]);
      expect(state.stayed).toBe(1);
      expect(state.exits).toEqual([]);
    }
  });

  test("--state ohne Datei oder ohne Skript: Hinweis, Exit 2, nichts gestartet", async () => {
    for (const args of [["--state"], ["--state", "/p/x.json"]]) {
      const { state, deps } = fake();
      expect(await runOnceAndStay(args, "/opt/bun", deps)).toBeNull();
      expect(state.exits).toEqual([2]);
      expect(state.spawned).toEqual([]);
      expect(state.states).toEqual([]);
    }
  });

  test("writeStateFile legt den Ordner an und schreibt lesbares JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tybo-once-"));
    try {
      const file = join(dir, "data", "supabase-start.json");
      writeStateFile(file, { pid: 7, state: "beendet", exitCode: 1 });
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ pid: 7, state: "beendet", exitCode: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ohne Skript: Hinweis, Exit 2, nichts gestartet", async () => {
    const { state, deps } = fake();
    expect(await runOnceAndStay([], "/opt/bun", deps)).toBeNull();
    expect(state.exits).toEqual([2]);
    expect(state.spawned).toEqual([]);
  });
});
