/**
 * Issue #210: LiveConnection.close() gegen einen echten Web-Server nur im
 * Test. Der Abbruch der offenen SSE-Verbindung darf unter keiner Bun-Version
 * als unbehandelter Fehler (AbortError) enden, auch nicht bei doppeltem
 * close() wie beim Beenden von tybo (Aufräumen ohne await, danach mit await).
 * src/bot.ts wird nie gestartet.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { LiveConnection, type LiveHandlers } from "../src/terminal/live";
import { startTyboServer, waitFor, type TerminalTestServer } from "./terminal-fixture";

let servers: TerminalTestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

function recorder() {
  const calls: string[] = [];
  const handlers: LiveHandlers = {
    onConnected: reconnect => calls.push(reconnect ? "reconnected" : "connected"),
    onEvent: () => calls.push("event"),
    onDisconnected: () => calls.push("disconnected"),
    onGone: () => calls.push("gone"),
  };
  return { calls, handlers };
}

/** Sammelt unbehandelte Fehler, solange fn läuft, und eine kurze Zeit danach */
async function collectUnhandled(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  const onException = (error: unknown) => seen.push(error);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  try {
    await fn();
    await new Promise(r => setTimeout(r, 100));
  } finally {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  }
  return seen;
}

describe("LiveConnection.close()", () => {
  test("bei offener Verbindung: kein unbehandelter AbortError, doppeltes close() endet sauber, keine Wiederverbindung", async () => {
    const s = await startTyboServer();
    servers.push(s);
    const { calls, handlers } = recorder();
    const live = new LiveConnection(s.client(), "dm", handlers, { retryMinMs: 20 });
    const unhandled = await collectUnhandled(async () => {
      live.start();
      await waitFor(() => calls.includes("connected"), 3000, "Live-Verbindung");
      // wie app.ts: Aufräumen ohne await, danach nochmals mit await
      void live.close();
      await live.close();
      await waitFor(() => s.server.eventStreamCount() === 0, 3000, "Verbindung am Server geschlossen");
    });
    expect(unhandled).toEqual([]);
    expect(calls).not.toContain("disconnected");
    expect(calls).not.toContain("reconnected");
  });

  test("während der Verbindungsaufbau noch läuft: close() endet sauber ohne unbehandelten Fehler", async () => {
    const s = await startTyboServer();
    servers.push(s);
    const { calls, handlers } = recorder();
    const live = new LiveConnection(s.client(), "dm", handlers, { retryMinMs: 20 });
    const unhandled = await collectUnhandled(async () => {
      live.start();
      await live.close();
    });
    expect(unhandled).toEqual([]);
    expect(calls).not.toContain("disconnected");
  });

  test("in der Wartezeit vor dem nächsten Versuch: close() weckt die Schleife und beendet sie", async () => {
    const s = await startTyboServer();
    servers.push(s);
    const { calls, handlers } = recorder();
    // idleTimeoutMs knapp: die Verbindung gilt schnell als tot, danach wartet die Schleife retryMinMs
    const live = new LiveConnection(s.client(), "dm", handlers, { retryMinMs: 60_000, idleTimeoutMs: 50 });
    const unhandled = await collectUnhandled(async () => {
      live.start();
      await waitFor(() => calls.includes("disconnected"), 3000, "Verbindung als tot erkannt");
      const t = Date.now();
      await live.close();
      expect(Date.now() - t).toBeLessThan(1000);
    });
    expect(unhandled).toEqual([]);
  });
});
