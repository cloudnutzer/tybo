// Issue #342: Reihenfolge und Robustheit der Closer des Bots
// (src/app/bot-shutdown.ts) zusammen mit dem Lebenszyklus, ohne src/bot.ts.
// Ersetzt die Quelltext-Prüfungen von shutdown() in routine-watch.test.ts und
// threads-reminder-wiring.test.ts.
import { describe, expect, test } from "bun:test";
import { createLifecycle } from "../src/app/lifecycle";
import { registerBotShutdown, WEB_STOP_GRACE_MS, type BotShutdownParts } from "../src/app/bot-shutdown";
import { SHUTDOWN_ABORT_REPLY } from "../src/lib/chat-turn";

function rig(overrides: Partial<BotShutdownParts> = {}) {
  const events: string[] = [];
  const exits: number[] = [];
  let flagAtAbort: boolean | undefined;
  const lifecycle = createLifecycle({
    lock: { touch: async () => {}, release: async () => void events.push("sperre frei") },
    exit: code => void exits.push(code),
    sleep: async () => void events.push("schonfrist"),
    log: () => {},
    warn: line => void events.push(`warn ${line}`),
  });
  const parts: BotShutdownParts = {
    abortRunning: () => {
      flagAtAbort = lifecycle.isShuttingDown();
      events.push("abbrechen");
    },
    routineWatch: () => ({ stop: () => void events.push("routinen") }),
    threadReminders: () => ({ stop: () => void events.push("fäden") }),
    stopReminders: () => {
      events.push("planer anhalten");
      return Promise.resolve(true);
    },
    telegram: { stop: () => void events.push("telegram") },
    web: () => ({ stop: async (options) => void events.push(`web ${options.graceMs} ${options.abortText}`) }),
    webAbortText: SHUTDOWN_ABORT_REPLY,
    mcp: { shutdown: async () => void events.push("mcp") },
    saveSession: async () => void events.push("session"),
    log: line => void events.push(`log ${line}`),
    ...overrides,
  };
  registerBotShutdown(lifecycle, parts);
  return { lifecycle, events, exits, flagAtAbort: () => flagAtAbort };
}

describe("Beenden des Bots", () => {
  test("feste Reihenfolge, Flag schon vor dem Abbruch gesetzt", async () => {
    const r = rig();
    await r.lifecycle.shutdown("SIGTERM");
    expect(r.flagAtAbort()).toBe(true);
    expect(r.events).toEqual([
      "abbrechen",
      "routinen",
      "fäden",
      "planer anhalten",
      "telegram",
      `web ${WEB_STOP_GRACE_MS} ${SHUTDOWN_ABORT_REPLY}`,
      "mcp",
      "session",
      "schonfrist",
      "sperre frei",
    ]);
    expect(r.exits).toEqual([0]);
  });

  test("Erinnerungsplaner: Versand läuft parallel weiter, abgewartet nach dem Speichern der Session", async () => {
    let settle!: (done: boolean) => void;
    const r = rig({
      stopReminders: () => new Promise<boolean>(done => (settle = done)),
    });
    const done = r.lifecycle.shutdown("SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(r.events).toEqual(["abbrechen", "routinen", "fäden", "telegram", `web ${WEB_STOP_GRACE_MS} ${SHUTDOWN_ABORT_REPLY}`, "mcp", "session"]);
    settle(false);
    await done;
    expect(r.events.slice(-3)).toEqual([
      "log [erinnerung] Versand beim Beenden nicht abgeschlossen, Ausgang beim nächsten Start unbekannt",
      "schonfrist",
      "sperre frei",
    ]);
  });

  test("Teilinitialisierung (Absturz beim Start): nichts gestartet, trotzdem sauber beendet", async () => {
    const r = rig({ routineWatch: () => null, threadReminders: () => null, stopReminders: () => null, web: () => null });
    await r.lifecycle.shutdown("uncaughtException");
    expect(r.events).toEqual(["abbrechen", "telegram", "mcp", "session", "schonfrist", "sperre frei"]);
    expect(r.exits).toEqual([0]);
  });

  test("noch nicht angelegter Teil (Zugriff wirft): Rest läuft weiter", async () => {
    const r = rig({
      routineWatch: () => {
        throw new ReferenceError("vor der Initialisierung");
      },
    });
    await r.lifecycle.shutdown("uncaughtException");
    expect(r.events).toContain("warn [shutdown] Routinen-Prüfung gescheitert (ReferenceError)");
    expect(r.events.slice(-2)).toEqual(["schonfrist", "sperre frei"]);
    expect(r.events).toContain("fäden");
  });

  test("ohne Telegram: Stopp ohne Wirkung, WebUI und Rest wie sonst", async () => {
    const r = rig({ telegram: { stop: () => {} } });
    await r.lifecycle.shutdown("SIGTERM");
    expect(r.events).not.toContain("telegram");
    expect(r.events).toContain(`web ${WEB_STOP_GRACE_MS} ${SHUTDOWN_ABORT_REPLY}`);
    expect(r.exits).toEqual([0]);
  });

  test("Fehler in Telegram, WebUI, MCP und Session: alle Schritte versucht, Sperre frei", async () => {
    const boom = (name: string) => () => {
      throw new Error(name);
    };
    const r = rig({
      telegram: { stop: boom("telegram") },
      web: () => ({ stop: () => Promise.reject(new TypeError("web")) }),
      mcp: { shutdown: () => Promise.reject(new Error("mcp")) },
      saveSession: () => Promise.reject(new Error("session")),
    });
    await r.lifecycle.shutdown("SIGTERM");
    expect(r.events.filter(e => e.startsWith("warn"))).toEqual([
      "warn [shutdown] Telegram gescheitert (Error)",
      "warn [shutdown] WebUI gescheitert (TypeError)",
      "warn [shutdown] MCP gescheitert (Error)",
      "warn [shutdown] letzte Session gescheitert (Error)",
    ]);
    expect(r.events.slice(-2)).toEqual(["schonfrist", "sperre frei"]);
    expect(r.exits).toEqual([0]);
  });
});
