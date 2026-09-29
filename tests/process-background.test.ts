/**
 * Issue #190, Prüfer-Nachtrag: /process-Aufträge (src/lib/process-background.ts)
 * zählen vom Annehmen bis zum Antwortversand als beschäftigt. Ein Neustart
 * während Download oder Versand wird verschoben; bei gesperrter Annahme gibt
 * es sofort die Meldung „startet gerade neu". Download, Claude und Versand
 * sind Attrappen; src/bot.ts wird nicht importiert.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { activeExecutionCount, closeIntake, isIntakeClosed, RESTART_PENDING_REPLY } from "../src/lib/execution-context";
import { processInBackground, type ProcessBackgroundDeps } from "../src/lib/process-background";
import { createRestartControl } from "../src/lib/restart-control";

function held<T = void>() {
  let release!: (v: T) => void;
  const gate = new Promise<T>(r => (release = r));
  return { gate, release };
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(2);
  }
}

let reopen: Array<() => void> = [];
afterEach(() => {
  for (const r of reopen) r();
  reopen = [];
  expect(isIntakeClosed()).toBe(false);
  expect(activeExecutionCount()).toBe(0);
});

function setup(over: Partial<ProcessBackgroundDeps> = {}) {
  const events: string[] = [];
  const sent: string[] = [];
  const deps: ProcessBackgroundDeps = {
    sessionKey: (chatId, threadId) => `topic:${chatId}:${threadId ?? 0}`,
    send: async (_chatId, text) => void sent.push(text),
    typing: async () => {},
    downloadPhoto: async () => {
      events.push("download");
      return "/tmp/photo.jpg";
    },
    uploadAsset: async () => ({ id: "a1" }),
    callClaude: async () => {
      events.push("claude");
      return "Antwort";
    },
    finishAsset: (_id, response) => response,
    log: () => {},
    ...over,
  };
  const shutdowns: string[] = [];
  let marker: string | null = "neuer Code";
  const control = createRestartControl({
    readRequest: async () => marker,
    clearRequest: async () => void (marker = null),
    busyCount: () => activeExecutionCount(),
    detectSupervisor: async () => "launchd",
    closeIntake: () => {
      const r = closeIntake();
      reopen.push(r);
      return r;
    },
    send: async () => {},
    shutdown: async r => void shutdowns.push(r),
    isShuttingDown: () => false,
    log: () => {},
  });
  return { deps, events, sent, shutdowns, control };
}

describe("/process und Neustart", () => {
  test("Neustart während eines langsamen Downloads: verschoben, Antwort kommt an, danach Neustart", async () => {
    const dl = held<string | null>();
    const t = setup({
      downloadPhoto: () => {
        t.events.push("download");
        return dl.gate;
      },
    });
    const job = processInBackground({ chatId: "-100", threadId: 5, photoFileId: "f1", text: "Was ist das?" }, t.deps);
    // Schon vor dem ersten await registriert
    expect(activeExecutionCount()).toBe(1);
    await waitUntil(() => t.events.includes("download"));

    expect(await t.control.maybeRestart("idle")).toBe("busy");
    expect(t.shutdowns).toEqual([]);
    expect(isIntakeClosed()).toBe(false);

    dl.release("/tmp/photo.jpg");
    await job;
    expect(t.events).toEqual(["download", "claude"]);
    expect(t.sent).toEqual(["Antwort"]);
    expect(await t.control.maybeRestart("nach Antwort")).toBe("restarting");
  });

  test("Neustart während des Antwortversands: verschoben, Versand läuft zu Ende", async () => {
    const delivery = held();
    const t = setup();
    t.deps.send = async (_c, text) => {
      t.sent.push(text);
      await delivery.gate;
      t.events.push("zugestellt");
    };
    const job = processInBackground({ chatId: "-100", text: "Hallo" }, t.deps);
    await waitUntil(() => t.sent.length === 1);
    expect(t.events).toEqual(["claude"]);

    expect(await t.control.maybeRestart("nach Claude")).toBe("busy");
    expect(t.shutdowns).toEqual([]);

    delivery.release();
    await job;
    expect(t.events).toEqual(["claude", "zugestellt"]);
    expect(await t.control.maybeRestart("idle")).toBe("restarting");
  });

  test("gesperrte Annahme: sofort die Neustart-Meldung, kein Download, kein Claude", async () => {
    const t = setup();
    reopen.push(closeIntake());
    await processInBackground({ chatId: "-100", photoFileId: "f1" }, t.deps);
    expect(t.events).toEqual([]);
    expect(t.sent).toEqual([RESTART_PENDING_REPLY]);
  });

  test("Foto nicht ladbar: Hinweis, kein Claude-Aufruf", async () => {
    const t = setup({ downloadPhoto: async () => null });
    await processInBackground({ chatId: "-100", photoFileId: "f1" }, t.deps);
    expect(t.events).toEqual([]);
    expect(t.sent).toEqual(["Could not download the photo from Telegram."]);
  });
});
