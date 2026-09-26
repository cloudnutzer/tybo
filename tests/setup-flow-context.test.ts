/**
 * Issue #161, Checkbox 2: Abbruch für Befehle und Anfragen, ersetzbares
 * Warten, writeEnv() weist transiente Namen ab. Befehle laufen hier echt
 * (sh und sleep), aber nur kurz und nur im Testordner.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { defaultFetch, defaultRun, defaultSleep, KILL_GRACE_MS } from "../src/setup/context";
import { registerTransientFields } from "../src/setup/model";
import { waitForEnvWrites, writeEnv } from "../src/setup/steps/common";
import { backupsOf, cleanup, FULL_ENV, makeCtx } from "./setup-fixture";
import { FLOW, makeFlowStep } from "./setup-flow-fixture";

afterAll(cleanup);

function alive(pattern: string): boolean {
  return Bun.spawnSync(["pgrep", "-f", pattern]).stdout.toString().trim() !== "";
}

describe("defaultRun mit signal", () => {
  test("ausgelöstes signal beendet den Befehl samt Kindprozess", async () => {
    const marker = `sleep 97.${process.pid}`;
    const controller = new AbortController();
    const started = Date.now();
    const pending = defaultRun(["sh", "-c", `${marker} & ${marker}; wait`], { signal: controller.signal, timeoutMs: 20_000 });
    await Bun.sleep(300);
    expect(alive(marker)).toBe(true);
    controller.abort();
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.code).toBe(-1);
    expect(Date.now() - started).toBeLessThan(5_000);
    await Bun.sleep(200);
    expect(alive(marker)).toBe(false);
  });

  /** Schleife, die SIGTERM ignoriert und in file schreibt, solange sie lebt */
  function stubbornLoop(file: string): string {
    return `trap '' TERM; while :; do echo x >> ${file}; sleep 0.05; done`;
  }

  async function sizeOf(file: string): Promise<number> {
    return (await Bun.file(file).exists()) ? Bun.file(file).size : 0;
  }

  async function expectNoMoreWork(file: string, marker: string) {
    const before = await sizeOf(file);
    await Bun.sleep(400);
    expect(await sizeOf(file)).toBe(before);
    expect(alive(marker)).toBe(false);
  }

  test("Hauptprozess ignoriert SIGTERM: Abbruch endet nach der Schonfrist mit SIGKILL", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const file = `${ctx.root}/stur-haupt-${process.pid}.txt`;
    const controller = new AbortController();
    const pending = defaultRun(["sh", "-c", stubbornLoop(file)], { signal: controller.signal, timeoutMs: 20_000 });
    await Bun.sleep(300);
    expect(await sizeOf(file)).toBeGreaterThan(0);
    const t = Date.now();
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ code: -1, aborted: true });
    expect(Date.now() - t).toBeLessThan(KILL_GRACE_MS + 2_000);
    await expectNoMoreWork(file, file);
  });

  test("Zeitlimit trifft einen SIGTERM ignorierenden Befehl ebenso", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const file = `${ctx.root}/stur-zeit-${process.pid}.txt`;
    const t = Date.now();
    const result = await defaultRun(["sh", "-c", stubbornLoop(file)], { signal: new AbortController().signal, timeoutMs: 200 });
    expect(result).toMatchObject({ code: -1, timedOut: true });
    expect(Date.now() - t).toBeLessThan(KILL_GRACE_MS + 2_000);
    await expectNoMoreWork(file, file);
  });

  test("Kindprozess ignoriert SIGTERM: nach dem Abbruch bleibt nichts übrig", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const file = `${ctx.root}/stur-kind-${process.pid}.txt`;
    const controller = new AbortController();
    // Kind mit umgeleiteter Ausgabe: der Hauptprozess endet auf SIGTERM, die Pipes schließen sofort
    const pending = defaultRun(["sh", "-c", `(${stubbornLoop(file)}) >/dev/null 2>&1 & sleep 30`], {
      signal: controller.signal,
      timeoutMs: 20_000,
    });
    await Bun.sleep(300);
    expect(alive(file)).toBe(true);
    const t = Date.now();
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ code: -1, aborted: true });
    expect(Date.now() - t).toBeLessThan(KILL_GRACE_MS + 2_000);
    await expectNoMoreWork(file, file);
  });

  test("Kindprozess ignoriert SIGTERM und hält die Ausgabe offen: SIGKILL nach der Schonfrist", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const file = `${ctx.root}/stur-pipe-${process.pid}.txt`;
    const controller = new AbortController();
    const pending = defaultRun(["sh", "-c", `(${stubbornLoop(file)}) & wait`], { signal: controller.signal, timeoutMs: 20_000 });
    await Bun.sleep(300);
    const t = Date.now();
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ code: -1, aborted: true });
    expect(Date.now() - t).toBeLessThan(KILL_GRACE_MS + 2_000);
    await expectNoMoreWork(file, file);
  });

  test("schon ausgelöstes signal startet gar nichts", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await defaultRun(["sh", "-c", "echo lief"], { signal: controller.signal });
    expect(result).toMatchObject({ code: -1, aborted: true, stdout: "" });
  });

  test("ohne Abbruch wie bisher: Ausgabe und Exit-Code", async () => {
    const controller = new AbortController();
    expect(await defaultRun(["sh", "-c", "echo hallo; exit 3"], { signal: controller.signal })).toMatchObject({ code: 3, stdout: "hallo" });
    expect(await defaultRun(["sh", "-c", "echo ohne"])).toMatchObject({ code: 0, stdout: "ohne", timedOut: false });
  });
});

describe("defaultSleep", () => {
  test("wartet, endet bei Abbruch sofort und wirft nie", async () => {
    let t = Date.now();
    await defaultSleep(50);
    expect(Date.now() - t).toBeGreaterThanOrEqual(40);
    const controller = new AbortController();
    t = Date.now();
    setTimeout(() => controller.abort(), 20);
    await defaultSleep(10_000, controller.signal);
    expect(Date.now() - t).toBeLessThan(1_000);
    t = Date.now();
    await defaultSleep(10_000, controller.signal);
    expect(Date.now() - t).toBeLessThan(100);
  });
});

describe("defaultFetch mit signal", () => {
  test("Abbruch beendet eine hängende Anfrage, das Zeitlimit gilt weiter", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
    try {
      const controller = new AbortController();
      const t = Date.now();
      setTimeout(() => controller.abort(), 50);
      await expect(defaultFetch(`http://127.0.0.1:${server.port}/`, { signal: controller.signal, timeoutMs: 10_000 })).rejects.toThrow();
      expect(Date.now() - t).toBeLessThan(2_000);
      await expect(defaultFetch(`http://127.0.0.1:${server.port}/`, { signal: new AbortController().signal, timeoutMs: 80 })).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  });
});

describe("writeEnv und transiente Namen", () => {
  registerTransientFields([makeFlowStep()]);

  test("ein transienter Name weist den ganzen Änderungssatz ab, .env unverändert", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const result = await writeEnv(ctx, [
      ["FLOW_TOKEN", FLOW.token],
      ["FLOW_PASSWORD", FLOW.password],
    ]);
    expect(result.ok).toBe(false);
    expect(result.changed).toEqual([]);
    expect(result.message).toContain("FLOW_PASSWORD");
    expect(result.message).toContain("Nichts wurde geändert");
    expect(result.message).not.toContain(FLOW.password);
    expect(await readFile(ctx.envPath, "utf8")).toBe(FULL_ENV);
    expect(await backupsOf(ctx)).toEqual([]);
  });

  test("auch das Entfernen eines transienten Namens wird abgewiesen", async () => {
    const ctx = await makeCtx({ env: `${FULL_ENV}FLOW_PASSWORD=alt\n` });
    const result = await writeEnv(ctx, [["FLOW_PASSWORD", null]]);
    expect(result.ok).toBe(false);
    expect(await readFile(ctx.envPath, "utf8")).toContain("FLOW_PASSWORD=alt");
  });

  test("writeLock umschließt das Schreiben, waitForEnvWrites wartet darauf", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const ctx = await makeCtx({
      env: FULL_ENV,
      overrides: {
        writeLock: async fn => {
          order.push("lock");
          await gate;
          const r = await fn();
          order.push("unlock");
          return r;
        },
      },
    });
    const pending = writeEnv(ctx, [["FLOW_TOKEN", FLOW.token]]);
    let waited = false;
    const waiting = waitForEnvWrites().then(() => (waited = true));
    await Bun.sleep(20);
    expect(waited).toBe(false);
    release();
    expect((await pending).changed).toEqual(["FLOW_TOKEN"]);
    await waiting;
    expect(order).toEqual(["lock", "unlock"]);
    expect(await readFile(ctx.envPath, "utf8")).toContain(`FLOW_TOKEN=${FLOW.token}`);
  });
});
