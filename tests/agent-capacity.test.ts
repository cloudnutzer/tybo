/**
 * Issue #208, Checkbox 1 und 2: Standard für gleichzeitige Aufträge nach
 * Arbeitsspeicher, Vorrang von MAX_AGENT_PROCESSES. totalmem als Attrappe
 * (Byte-Zahl), die Umgebung als eigenes Objekt: nichts hängt vom Rechner ab.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  GIB,
  capacityForMemory,
  capacityLogLine,
  parseAgentProcesses,
  resolveAgentCapacity,
} from "../src/lib/agent-capacity";
import { agentCapacity, logAgentCapacity, resetAgentCapacity, runExecution } from "../src/lib/execution-context";
import { TEST_TOTALMEM } from "./preload-env";

describe("Standard nach Arbeitsspeicher (GiB)", () => {
  test("knapp unter, genau auf und über 3 GiB", () => {
    expect(capacityForMemory(3 * GIB - 1)).toBe(1);
    expect(capacityForMemory(3 * GIB)).toBe(2);
    expect(capacityForMemory(3 * GIB + 1)).toBe(2);
  });

  test("knapp unter, genau auf und über 6 GiB", () => {
    expect(capacityForMemory(6 * GIB - 1)).toBe(2);
    expect(capacityForMemory(6 * GIB)).toBe(3);
    expect(capacityForMemory(6 * GIB + 1)).toBe(3);
  });

  test("GiB, nicht GB: 3 GB (dezimal) liegen unter 3 GiB", () => {
    expect(capacityForMemory(3e9)).toBe(1);
    expect(capacityForMemory(6e9)).toBe(2);
  });

  test("Messwerte aus der Debian-VM: 4-GB-Gerät 2, 8-GB-Gerät 3; Mac mit 16 GiB 3", () => {
    expect(capacityForMemory(3.84 * GIB)).toBe(2);
    expect(capacityForMemory(7946 * 1024 ** 2)).toBe(3);
    expect(capacityForMemory(16 * GIB)).toBe(3);
    expect(capacityForMemory(1.9 * GIB)).toBe(1);
  });
});

describe("Grenze und Grund", () => {
  test("drei Stufen ohne Variable, mit Grund für das Log", () => {
    expect(resolveAgentCapacity({}, 2 * GIB)).toEqual({ limit: 1, reason: "2,0 GiB Arbeitsspeicher" });
    expect(resolveAgentCapacity({}, 3.84 * GIB)).toEqual({ limit: 2, reason: "3,8 GiB Arbeitsspeicher" });
    expect(resolveAgentCapacity({}, 16 * GIB)).toEqual({ limit: 3, reason: "Standard" });
  });

  test("gesetzte Variable gewinnt immer, auch über und unter dem Standard", () => {
    expect(resolveAgentCapacity({ MAX_AGENT_PROCESSES: "5" }, 16 * GIB)).toEqual({ limit: 5, reason: "MAX_AGENT_PROCESSES" });
    expect(resolveAgentCapacity({ MAX_AGENT_PROCESSES: "5" }, 1 * GIB)).toEqual({ limit: 5, reason: "MAX_AGENT_PROCESSES" });
    expect(resolveAgentCapacity({ MAX_AGENT_PROCESSES: "1" }, 16 * GIB)).toEqual({ limit: 1, reason: "MAX_AGENT_PROCESSES" });
    expect(resolveAgentCapacity({ MAX_AGENT_PROCESSES: " 4 " }, 2 * GIB).limit).toBe(4);
  });

  test("leer zählt als nicht gesetzt", () => {
    expect(resolveAgentCapacity({ MAX_AGENT_PROCESSES: "" }, 16 * GIB)).toEqual({ limit: 3, reason: "Standard" });
    expect(resolveAgentCapacity({ MAX_AGENT_PROCESSES: "  " }, 3.84 * GIB)).toEqual({ limit: 2, reason: "3,8 GiB Arbeitsspeicher" });
  });

  test("ungültige Werte: Standard nach Arbeitsspeicher, Grund nennt die Variable", () => {
    for (const raw of ["abc", "0", "-2", "2.5", "Infinity", "-Infinity", "NaN", "4x", "1e20"]) {
      expect(parseAgentProcesses(raw)).toBeUndefined();
      expect(resolveAgentCapacity({ MAX_AGENT_PROCESSES: raw }, 16 * GIB)).toEqual({
        limit: 3, reason: "Standard, MAX_AGENT_PROCESSES ungültig",
      });
    }
    expect(resolveAgentCapacity({ MAX_AGENT_PROCESSES: "-2" }, 2 * GIB)).toEqual({
      limit: 1, reason: "2,0 GiB Arbeitsspeicher, MAX_AGENT_PROCESSES ungültig",
    });
  });

  test("Log-Zeile", () => {
    expect(capacityLogLine({ limit: 3, reason: "Standard" })).toBe("[agents] Gleichzeitige Aufträge: 3, Standard");
    expect(capacityLogLine({ limit: 5, reason: "MAX_AGENT_PROCESSES" })).toBe("[agents] Gleichzeitige Aufträge: 5, MAX_AGENT_PROCESSES");
  });
});

describe("Einbindung in execution-context (Issue #208, Checkbox 2)", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.MAX_AGENT_PROCESSES;
    delete process.env.MAX_AGENT_PROCESSES;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MAX_AGENT_PROCESSES;
    else process.env.MAX_AGENT_PROCESSES = savedEnv;
    // Zurück zu dem, womit alle Tests rechnen
    resetAgentCapacity({ totalmem: TEST_TOTALMEM });
  });

  function held() {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    return { gate, release };
  }

  /** Startet tries Ausführungen gleichzeitig; gibt zurück, wie viele sofort liefen */
  async function runningAtOnce(tries: number): Promise<number> {
    const blockers = Array.from({ length: tries }, () => held());
    let started = 0;
    const all = blockers.map((h, i) => runExecution(`cap-208-${i}`, "general", async () => {
      started++;
      await h.gate;
    }));
    await Bun.sleep(10);
    const count = started;
    for (const h of blockers) h.release();
    await Promise.all(all);
    expect(started).toBe(tries);
    return count;
  }

  test("preload rechnet mit 8 GiB: 3 Plätze, Grund Standard", () => {
    resetAgentCapacity();
    expect(agentCapacity()).toEqual({ limit: 3, reason: "Standard" });
  });

  test("Warteschlange hält die Stufen nach Arbeitsspeicher ein", async () => {
    for (const [gib, limit] of [[2, 1], [3.84, 2], [16, 3]] as const) {
      resetAgentCapacity({ totalmem: () => gib * GIB });
      expect(agentCapacity().limit).toBe(limit);
      expect(await runningAtOnce(limit + 1)).toBe(limit);
    }
  });

  test("gesetzte Variable gewinnt in der Warteschlange, auch bei wenig Speicher", async () => {
    process.env.MAX_AGENT_PROCESSES = "5";
    resetAgentCapacity({ totalmem: () => 2 * GIB });
    expect(await runningAtOnce(6)).toBe(5);
  });

  test("Log einmal, mit Grenze und Grund; dieselbe Konfiguration wie die Warteschlange", async () => {
    resetAgentCapacity({ totalmem: () => 3.84 * GIB });
    const lines: string[] = [];
    logAgentCapacity(l => lines.push(l));
    logAgentCapacity(l => lines.push(l));
    expect(lines).toEqual(["[agents] Gleichzeitige Aufträge: 2, 3,8 GiB Arbeitsspeicher"]);
    // Eine spätere Änderung der Umgebung ändert die laufende Grenze nicht mehr
    process.env.MAX_AGENT_PROCESSES = "5";
    expect(await runningAtOnce(3)).toBe(2);
  });

  test("Log mit MAX_AGENT_PROCESSES", () => {
    process.env.MAX_AGENT_PROCESSES = "5";
    resetAgentCapacity();
    const lines: string[] = [];
    logAgentCapacity(l => lines.push(l));
    expect(lines).toEqual(["[agents] Gleichzeitige Aufträge: 5, MAX_AGENT_PROCESSES"]);
  });

  test("Grenze wird erst nach dem Import gelesen (bot.ts: loadEnv nach den Importen)", () => {
    resetAgentCapacity();
    // wie loadEnv nach dem Import von execution-context
    process.env.MAX_AGENT_PROCESSES = "4";
    expect(agentCapacity()).toEqual({ limit: 4, reason: "MAX_AGENT_PROCESSES" });
  });

  test("bot.ts loggt die Grenze direkt nach loadEnv (Quelltext, ohne bot.ts zu importieren)", async () => {
    const src = await Bun.file(join(import.meta.dir, "..", "src", "bot.ts")).text();
    const env = src.indexOf('await loadEnv(join(process.cwd(), ".env"));');
    const log = src.indexOf("logAgentCapacity();");
    expect(env).toBeGreaterThan(0);
    expect(log).toBeGreaterThan(env);
    expect(src.slice(env, log).split("\n").length).toBeLessThanOrEqual(3);
  });
});
