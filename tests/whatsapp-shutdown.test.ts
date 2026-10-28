/**
 * Issue #345, Checkbox 2: Das WhatsApp-Gateway beendet sich über den
 * gemeinsamen Lebenszyklus (createLifecycle, installSignalHandlers aus
 * src/app/lifecycle.ts), ohne Prozesssperre des Bots. Geprüft: mehrfaches
 * Signal, ein scheiternder Closer, ein laufender Besitzer-Turn.
 */
import { describe, expect, test } from "bun:test";
import { installSignalHandlers } from "../src/app/lifecycle";
import { createGatewayLifecycle, NO_PROCESS_LOCK, type GatewayShutdownParts } from "../src/channels/whatsapp/shutdown";
import { createWhatsAppInbound } from "../src/channels/whatsapp/inbound";
import { createOwnerTurn } from "../src/channels/whatsapp/owner-turn";
import { ABORT_REPLY, SHUTDOWN_ABORT_REPLY } from "../src/lib/chat-turn";
import { abortAllExecutions, currentExecution, runExecution } from "../src/lib/execution-context";

type Handler = (arg?: unknown) => unknown;

function setup(parts: Partial<GatewayShutdownParts> = {}) {
  const steps: string[] = [];
  const exits: number[] = [];
  const handlers = new Map<string, Handler>();
  const reports: string[] = [];
  const lifecycle = createGatewayLifecycle({
    exit: code => void exits.push(code),
    sleep: async () => void steps.push("warten"),
    log: () => {},
    warn: line => void steps.push(line),
    afterRelease: async reason => void steps.push(`log ${reason}`),
    parts: {
      abortRunning: () => void steps.push("abbrechen"),
      server: () => ({ stop: () => void steps.push("server") }),
      ...parts,
    },
  });
  installSignalHandlers(lifecycle, {
    on: (event, handler) => void handlers.set(event, handler),
    report: async error => void reports.push(error.message),
    logError: () => {},
  });
  return { lifecycle, steps, exits, handlers, reports };
}

describe("Beenden des Gateways", () => {
  test("Reihenfolge: Turns abbrechen, Server schließen, warten, Log, exit(0)", async () => {
    const s = setup();
    await s.handlers.get("SIGTERM")!();
    expect(s.steps).toEqual(["abbrechen", "server", "warten", "log SIGTERM"]);
    expect(s.exits).toEqual([0]);
    expect(s.lifecycle.isShuttingDown()).toBe(true);
  });

  test("mehrfaches Signal: nur das erste wirkt", async () => {
    const s = setup();
    await Promise.all([s.handlers.get("SIGINT")!(), s.handlers.get("SIGTERM")!(), s.handlers.get("SIGHUP")!()]);
    await s.handlers.get("SIGTERM")!();
    expect(s.steps.filter(x => x === "abbrechen")).toHaveLength(1);
    expect(s.exits).toEqual([0]);
    expect(s.steps).toContain("log SIGINT");
  });

  test("scheiternder Closer: die übrigen laufen trotzdem, exit(0)", async () => {
    const s = setup({
      abortRunning: () => {
        throw new Error("kaputt");
      },
    });
    await s.handlers.get("SIGTERM")!();
    expect(s.steps).toEqual(["[shutdown] Motor-Aufrufe gescheitert (Error)", "server", "warten", "log SIGTERM"]);
    expect(s.exits).toEqual([0]);
  });

  test("Server noch nicht gestartet: übersprungen", async () => {
    const s = setup({ server: () => null });
    await s.handlers.get("SIGHUP")!();
    expect(s.steps).toEqual(["abbrechen", "warten", "log SIGHUP"]);
  });

  test("Absturz: gemeldet, dann beendet", async () => {
    const s = setup();
    await s.handlers.get("uncaughtException")!(new Error("boom"));
    expect(s.reports).toEqual(["boom"]);
    expect(s.steps.at(-1)).toBe("log uncaughtException");
    expect(s.exits).toEqual([0]);
  });

  test("ohne Prozesssperre: nichts zu schreiben oder freizugeben", async () => {
    await expect(NO_PROCESS_LOCK.touch()).resolves.toBeUndefined();
    await expect(NO_PROCESS_LOCK.release()).resolves.toBeUndefined();
  });

  test("laufender Besitzer-Turn: wird abgebrochen, nicht gespeichert, Besitzer bekommt die Meldung fürs Beenden", async () => {
    const saved: string[] = [];
    const sent: [string, string][] = [];
    let started!: () => void;
    const running = new Promise<void>(r => (started = r));
    const ownerTurn = createOwnerTurn({
      // Kern-Attrappe: wartet, bis die Ausführung abgebrochen wird, wie ein Motor-Aufruf
      runJsonTurn: () =>
        new Promise(resolve => {
          const signal = currentExecution()!.controller.signal;
          signal.addEventListener("abort", () => resolve(ABORT_REPLY), { once: true });
          started();
        }),
      runExecution,
      saveMessage: async m => void saved.push(m.role),
      processIntents: async () => {
        throw new Error("darf nicht laufen");
      },
      notice: async () => {},
    });
    const s = setup({ abortRunning: () => abortAllExecutions() });
    const inbound = createWhatsAppInbound({
      sender: {
        sendOne: async (to, text) => {
          sent.push([to, text]);
          return true;
        },
        send: async (to, text) => void sent.push([to, text]),
      },
      isOwner: () => true,
      ownerTurn,
      guest: { answer: async () => "", save: () => {} },
      groups: { find: () => null, botQuestion: () => null, directPart: () => null, command: () => "" },
      queue: (_key, fn) => fn(),
      botName: "tybo",
      isShuttingDown: () => s.lifecycle.isShuttingDown(),
      log: () => {},
    });

    const turn = inbound("+4915100000001", "lange Aufgabe");
    await running;
    await s.handlers.get("SIGTERM")!();
    await turn;
    expect(saved).toEqual(["user"]);
    expect(sent).toEqual([["+4915100000001", SHUTDOWN_ABORT_REPLY]]);
    expect(s.exits).toEqual([0]);
  });
});
