/**
 * Issue #188, Checkbox 1: Abbrüche enden immer mit einem echten AbortError.
 *
 * Im Bot-Log stand einmal „callClaudeAndReply error: undefined": ein Abbruch
 * kam als undefined an, die Prüfungen auf name === "AbortError" (src/bot.ts,
 * src/web/bot-turn.ts) griffen nicht und der Nutzer sah „Something went
 * wrong". Isoliert unter Bun 1.3.10 liefert throwIfAborted einen echten
 * DOMException-AbortError; nachgestellt wird deshalb, was im Log ankam:
 * throwIfAborted wirft undefined, und die Arbeit selbst lehnt nach dem
 * Abbruch mit undefined ab. Geprüft wird das echte Modul.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  abortError,
  abortExecutions,
  checkAborted,
  isAbortError,
  runCancelable,
  runExecution,
} from "../src/lib/execution-context";
import { useAgentCapacity } from "./agent-capacity-fixture";

// Der Test „alle Plätze belegt" füllt genau drei Plätze
useAgentCapacity(3);

const originalThrowIfAborted = AbortSignal.prototype.throwIfAborted;

function held() {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  return { gate, release };
}

/** Wie im Log: throwIfAborted wirft undefined statt eines AbortError */
function emulateUndefinedAbort() {
  AbortSignal.prototype.throwIfAborted = function (this: AbortSignal) {
    if (this.aborted) throw undefined;
  };
}

afterEach(() => {
  AbortSignal.prototype.throwIfAborted = originalThrowIfAborted;
});

describe("AbortError unabhängig von Bun und AsyncLocalStorage", () => {
  beforeEach(emulateUndefinedAbort);

  test("Nachstellung greift: throwIfAborted wirft hier wirklich undefined", () => {
    const c = new AbortController();
    c.abort();
    let thrown: unknown = "nichts";
    try {
      c.signal.throwIfAborted();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeUndefined();
  });

  test("laufender Turn: checkAborted nach /stop liefert name AbortError", async () => {
    const key = "topic:-188:1";
    const h = held();
    let started!: () => void;
    const entered = new Promise<void>(r => (started = r));
    const turn = runExecution(key, "general", async () => {
      started();
      await h.gate;
      checkAborted();
      return "gespeichert";
    });
    const settled = turn.then(() => undefined, (e: unknown) => e);
    await entered;
    expect(abortExecutions(key)).toBe(1);
    h.release();
    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
  });

  test("laufender Turn: Arbeit lehnt nach dem Abbruch mit undefined ab, heraus kommt AbortError", async () => {
    const key = "topic:-188:2";
    const h = held();
    let started!: () => void;
    const entered = new Promise<void>(r => (started = r));
    const turn = runExecution(key, "general", async () => {
      started();
      await h.gate;
      // eslint-disable-next-line no-throw-literal
      throw undefined;
    });
    const settled = turn.then(() => undefined, (e: unknown) => e);
    await entered;
    abortExecutions(key);
    h.release();
    expect(((await settled) as Error).name).toBe("AbortError");
  });

  test("wartender Turn (alle Plätze belegt): Abbruch liefert name AbortError", async () => {
    const blockers = [held(), held(), held()];
    const busy = blockers.map((h, i) => runExecution(`abort-other-${i}`, "general", () => h.gate));
    let ran = false;
    const waiting = runExecution("topic:-188:3", "research", async () => {
      ran = true;
    });
    const settled = waiting.then(() => undefined, (e: unknown) => e);
    await Bun.sleep(5);
    expect(abortExecutions("topic:-188:3")).toBe(1);
    const error = await settled;
    expect((error as Error).name).toBe("AbortError");
    expect(isAbortError(error)).toBe(true);
    for (const h of blockers) h.release();
    await Promise.all(busy);
    expect(ran).toBe(false);
  });

  test("wartender Turn hinter der Session-Sperre: Abbruch liefert name AbortError", async () => {
    const key = "topic:-188:4";
    const first = held();
    const running = runExecution(key, "general", () => first.gate);
    const waiting = runExecution(key, "general", async () => "nie");
    const settled = waiting.then(() => undefined, (e: unknown) => e);
    await Bun.sleep(5);
    // Beide unter dem Schlüssel: der laufende und der wartende
    expect(abortExecutions(key)).toBe(2);
    expect(((await settled) as Error).name).toBe("AbortError");
    first.release();
    await running.catch(() => {});
  });

  test("Update-Bereich: Abbruch mit undefined wird zum AbortError", async () => {
    const key = "topic:-188:5";
    const h = held();
    const scope = runCancelable(key, async () => {
      await h.gate;
      checkAborted();
    });
    const settled = scope.then(() => undefined, (e: unknown) => e);
    await Bun.sleep(1);
    abortExecutions(key);
    h.release();
    expect(((await settled) as Error).name).toBe("AbortError");
  });
});

test("abortError ist ein Error mit name AbortError; andere Fehler bleiben, wenn nicht abgebrochen", async () => {
  expect(abortError()).toBeInstanceOf(Error);
  expect(abortError().name).toBe("AbortError");
  expect(isAbortError(undefined)).toBe(false);
  await expect(runExecution("topic:-188:6", "general", async () => {
    throw new Error("echter Fehler");
  })).rejects.toThrow("echter Fehler");
});
