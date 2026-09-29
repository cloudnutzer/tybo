/**
 * Issue #190, Checkbox 1: Neustart-Fenster. Die Entscheidung
 * (src/lib/restart-control.ts) mit echtem execution-context, aber ohne
 * launchctl, Telegram oder Prozess-Ende: Supervisor, Versand und Shutdown
 * sind Attrappen. src/bot.ts wird nicht importiert.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  activeExecutionCount,
  closeIntake,
  isIntakeClosed,
  isRestartPendingError,
  RESTART_PENDING_REPLY,
  runCancelable,
  runExecution,
} from "../src/lib/execution-context";
import { createRestartControl, RESTART_TEXT, type RestartControlDeps } from "../src/lib/restart-control";
import { createBotChat, type BotChatDeps } from "../src/web/bot-turn";
import type { Supervisor } from "../src/lib/restart-request";

function held() {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  return { gate, release };
}

/** Freigaben, die ein Test offen gelassen haben könnte (Modulzustand ist prozessweit) */
let reopen: Array<() => void> = [];
afterEach(() => {
  for (const r of reopen) r();
  reopen = [];
  expect(isIntakeClosed()).toBe(false);
});

interface Recorder {
  events: string[];
  marker: string | null;
  deps: RestartControlDeps;
}

function recorder(over: Partial<RestartControlDeps> = {}): Recorder {
  const rec: Recorder = { events: [], marker: "neuer Code", deps: undefined as never };
  rec.deps = {
    readRequest: async () => rec.marker,
    clearRequest: async () => {
      rec.events.push("clear");
      rec.marker = null;
    },
    busyCount: () => activeExecutionCount(),
    detectSupervisor: async () => "launchd" as Supervisor,
    closeIntake: () => {
      rec.events.push("close");
      const r = closeIntake();
      reopen.push(r);
      return r;
    },
    send: async text => void rec.events.push(`send ${text}`),
    shutdown: async reason => void rec.events.push(`shutdown ${reason}`),
    isShuttingDown: () => false,
    log: () => {},
    ...over,
  };
  return rec;
}

describe("Neustart-Entscheidung", () => {
  test("ruhig: sperren, dann Marker löschen, Meldung, shutdown", async () => {
    const rec = recorder();
    expect(await createRestartControl(rec.deps).maybeRestart("idle")).toBe("restarting");
    expect(rec.events).toEqual(["close", "clear", `send ${RESTART_TEXT.restarting("neuer Code")}`, "shutdown restart-requested"]);
    expect(isIntakeClosed()).toBe(true);
  });

  test("systemd (Issue #207): laufende Arbeit hält den Neustart auf, danach Exit; systemd startet neu", async () => {
    const h = held();
    const turn = runCancelable("dm:1", async () => {
      await h.gate;
      return "Antwort";
    });
    const rec = recorder({ detectSupervisor: async () => "systemd" as Supervisor });
    const control = createRestartControl(rec.deps);
    expect(await control.maybeRestart("idle")).toBe("busy");
    expect(rec.events).toEqual([]);
    h.release();
    expect(await turn).toBe("Antwort");
    expect(await control.maybeRestart("nach Antwort")).toBe("restarting");
    expect(rec.events).toEqual(["close", "clear", `send ${RESTART_TEXT.restarting("neuer Code")}`, "shutdown restart-requested"]);
  });

  test("ohne Marker passiert nichts", async () => {
    const rec = recorder();
    rec.marker = null;
    expect(await createRestartControl(rec.deps).maybeRestart("idle")).toBe("none");
    expect(rec.events).toEqual([]);
  });

  test("beschäftigt: Marker bleibt, keine Sperre", async () => {
    const h = held();
    const turn = runCancelable("dm:1", () => h.gate);
    const rec = recorder();
    expect(await createRestartControl(rec.deps).maybeRestart("idle")).toBe("busy");
    expect(rec.marker).toBe("neuer Code");
    expect(rec.events).toEqual([]);
    h.release();
    await turn;
  });

  test("Turn trifft während der Supervisor-Abfrage ein: verschoben, Marker bleibt, Turn läuft normal zu Ende", async () => {
    const h = held();
    let turn: Promise<string> | undefined;
    const rec = recorder({
      detectSupervisor: async () => {
        // Genau im Fenster zwischen erster Prüfung und Entschluss (nur beim ersten Mal)
        if (!turn) turn = runCancelable("dm:1", async () => {
          await h.gate;
          return "Antwort";
        });
        return "launchd";
      },
    });
    expect(await createRestartControl(rec.deps).maybeRestart("idle")).toBe("deferred");
    expect(rec.marker).toBe("neuer Code");
    expect(rec.events).toEqual([]);
    expect(isIntakeClosed()).toBe(false);
    h.release();
    expect(await turn!).toBe("Antwort");

    // Danach ruhig: der nächste Check startet neu
    expect(await createRestartControl(rec.deps).maybeRestart("nach Antwort")).toBe("restarting");
  });

  test("Turn nach dem Entschluss wird abgewiesen (RestartPendingError), nicht abgebrochen", async () => {
    let ran = false;
    let rejected: unknown;
    const rec = recorder({
      send: async () => {
        // Nach der Sperre, noch vor shutdown: Telegram-Update, Web-Turn und /process
        for (const start of [
          () => runCancelable("dm:1", async () => void (ran = true)),
          () => runExecution("topic:-1001:7", "general", async () => void (ran = true)),
        ]) {
          try {
            await start();
          } catch (e) {
            rejected = e;
            expect(isRestartPendingError(e)).toBe(true);
            expect((e as Error).name).not.toBe("AbortError");
          }
        }
      },
    });
    expect(await createRestartControl(rec.deps).maybeRestart("idle")).toBe("restarting");
    expect(ran).toBe(false);
    expect((rejected as Error).message).toBe(RESTART_PENDING_REPLY);
  });

  test("bereits angenommener Turn läuft unter der Sperre aus (verschachtelte Ausführung erlaubt)", async () => {
    const h = held();
    const turn = runCancelable("dm:1", async () => {
      await h.gate;
      return runExecution("dm:1", "general", async () => "fertig");
    });
    const r = closeIntake();
    reopen.push(r);
    h.release();
    expect(await turn).toBe("fertig");
  });

  test("Fehler beim Shutdown hinterlässt keine Sperre", async () => {
    const rec = recorder({
      shutdown: async () => {
        throw new Error("kaputt");
      },
    });
    expect(await createRestartControl(rec.deps).maybeRestart("idle")).toBe("failed");
    expect(isIntakeClosed()).toBe(false);
  });

  test("ohne Supervisor: Marker weg, Hinweis, keine Sperre, kein shutdown", async () => {
    const rec = recorder({ detectSupervisor: async () => null });
    expect(await createRestartControl(rec.deps).maybeRestart("idle", "4711", 7)).toBe("no-supervisor");
    expect(rec.events).toEqual(["clear", `send ${RESTART_TEXT.noSupervisor}`]);
    expect(isIntakeClosed()).toBe(false);
  });

  test("gleichzeitige Prüfungen: nur eine läuft", async () => {
    const h = held();
    const rec = recorder({
      detectSupervisor: async () => {
        await h.gate;
        return "launchd";
      },
    });
    const control = createRestartControl(rec.deps);
    const first = control.maybeRestart("idle");
    expect(await control.maybeRestart("nach Antwort")).toBe("skipped");
    h.release();
    expect(await first).toBe("restarting");
    expect(rec.events.filter(e => e.startsWith("shutdown"))).toHaveLength(1);
  });
});

describe("WebUI während des Neustarts", () => {
  function webDeps(saved: string[]): BotChatDeps {
    return {
      runStreamingTurn: async () => "Antwort",
      saveMessage: async m => {
        saved.push(m.content);
        return true;
      },
      processIntents: async () => {},
      abortEngineCalls: () => 0,
      isShuttingDown: () => false,
      scheduleRestartCheck: () => {},
      log: () => {},
    };
  }

  test("neuer Web-Turn bekommt die Neustart-Meldung, nichts gespeichert", async () => {
    const saved: string[] = [];
    const chat = createBotChat(webDeps(saved));
    const r = closeIntake();
    reopen.push(r);
    const result = await chat.runTurn({
      conversationId: "0c1a2b3c-0000-4000-8000-000000000190",
      agent: "general",
      text: "Frage",
      sink: { progress: () => {}, notice: () => {} },
    });
    expect(result).toEqual({ text: RESTART_PENDING_REPLY, failed: true });
    expect(saved).toEqual([]);
  });
});

describe("Annahmesperre und geerbter Kontext", () => {
  test("verzögerter Aufruf nach Ende der Elternausführung: abgewiesen, auch bei gleicher Session und gleichem Agent", async () => {
    const h = held();
    let delayed: Promise<unknown> | undefined;
    await runExecution("dm:1", "general", async () => {
      // Erbt den Kontext der Elternausführung, läuft aber erst nach ihrem Ende
      delayed = h.gate.then(() => runExecution("dm:1", "general", async () => "TURN AUSGEFÜHRT")).catch(e => e);
    });
    expect(activeExecutionCount()).toBe(0);
    reopen.push(closeIntake());
    h.release();
    const result = await delayed!;
    expect(isRestartPendingError(result)).toBe(true);
  });

  test("innerhalb der noch laufenden Elternausführung bleibt die Ausnahme", async () => {
    const h = held();
    const turn = runExecution("dm:1", "general", async () => {
      await h.gate;
      return runExecution("dm:1", "general", async () => "innen");
    });
    reopen.push(closeIntake());
    h.release();
    expect(await turn).toBe("innen");
  });
});
