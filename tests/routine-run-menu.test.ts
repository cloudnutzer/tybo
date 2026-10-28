/**
 * Issue #288: Fehler- und Ausgeblieben-Meldungen des Wrappers mit Knöpfen
 * (wrapperMenuOffer in src/routine-run.ts). Der tatsächliche Wrapper-Weg mit
 * Attrappen für Katalog (launchd), Versand und Zeitgeber: kein echtes
 * launchctl, kein Telegram, keine Outbox. Register und Arbeitsordner liegen
 * in eigenen temporären Ordnern.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setChoicesFileForTests, type Choice } from "../src/lib/choices";
import type { SendAndRecordInput, SendAndRecordResult } from "../src/lib/outbox";
import { menuAlertSender } from "../src/lib/routine-choices";
import { wrapperMenuOffer } from "../src/routine-run";
import { standardLaunchd } from "./routine-actions-fixture";

const HC = "ai.tybo.health-check";
const TEXT = "❌ health-check ist fehlgeschlagen (Exit 1).";
const ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID", "GO_PROJECT_ROOT"] as const;

const base = mkdtempSync(join(tmpdir(), "routine-run-menu-"));
let counter = 0;
let root = "";
let cwd = "";
let savedEnv: Record<string, string | undefined> = {};
let savedCwd = "";
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  counter++;
  root = mkdtempSync(join(base, `projekt-${counter}-`));
  // Arbeitsordner des Befehls: woanders als der Projektordner
  cwd = mkdtempSync(join(base, `arbeit-${counter}-`));
  savedCwd = process.cwd();
  process.chdir(cwd);
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  process.chdir(savedCwd);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setChoicesFileForTests(null);
  logSpy.mockRestore();
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const TELEGRAM = { TELEGRAM_BOT_TOKEN: "123:test-token", TELEGRAM_USER_ID: "4242" };

function registerIn(dir: string): Record<string, Choice> {
  const file = join(dir, "data", "choices.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")).choices : {};
}

/** Versand-Attrappe: hält jeden Aufruf fest */
function fakeSend(reply: (input: SendAndRecordInput) => Promise<SendAndRecordResult>) {
  const calls: SendAndRecordInput[] = [];
  return {
    calls,
    send: async (input: SendAndRecordInput) => {
      calls.push(input);
      return reply(input);
    },
  };
}

/** Zeitgeber-Attrappe: läuft erst, wenn der Test fire() ruft (jeder Zeitgeber höchstens einmal) */
function fakeTimer() {
  const timers: { fn: () => void; ms: number; cleared: boolean; fired: boolean }[] = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false, fired: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t: unknown) => {
      (t as { cleared: boolean }).cleared = true;
    },
    fire: () =>
      timers.forEach(t => {
        if (t.cleared || t.fired) return;
        t.fired = true;
        t.fn();
      }),
    /** Zeitgeber, die gesetzt, aber weder gelaufen noch aufgeräumt sind */
    pending: () => timers.filter(t => !t.cleared && !t.fired),
  };
}

/** Versprechen, das der Test von außen auflöst */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(1);
  expect(check()).toBe(true);
}

describe("wrapperMenuOffer", () => {
  test("mit Telegram: Menü im Register des Projektordners, Knöpfe gesendet, Nachrichtenbezug gespeichert", async () => {
    const launchd = standardLaunchd();
    const s = fakeSend(async input => ({
      sent: true,
      recorded: true,
      messages: [{ chatId: input.chatId!, messageId: 77, part: "text", buttons: true }],
    }));
    const t = fakeTimer();
    const offer = wrapperMenuOffer(root, TELEGRAM, { routines: launchd.deps, send: s.send, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const outcome = await offer(HC, TEXT);
    expect(outcome.status).toBe("sent");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ chatId: "4242", text: TEXT, source: "routine" });
    expect(s.calls[0].buttons?.flat().map(b => b.text)).toEqual(["▶️ Jetzt testen", "⏸️ Pausieren"]);
    // Register im Projektordner, nie im Arbeitsordner des Befehls
    expect(existsSync(join(cwd, "data", "choices.json"))).toBe(false);
    const stored = Object.values(registerIn(root));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "routine", ref: HC, action: "menu", state: "open", conversation: { type: "telegram", chatId: "4242" }, telegram: [{ chatId: "4242", messageId: 77 }] });
    expect(s.calls[0].choiceId).toBe(stored[0].id);
    // Zeitlimit gesetzt und nach dem Versand aufgeräumt; der Wrapper hat nichts geändert
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0].cleared).toBe(true);
    expect(launchd.mutations()).toEqual([]);
    expect(process.env.GO_PROJECT_ROOT).toBe(root);
  });

  test("zweite Meldung derselben Routine: das ältere Menü läuft ab, nur eins bleibt offen", async () => {
    const launchd = standardLaunchd();
    const s = fakeSend(async input => ({ sent: true, recorded: true, messages: [{ chatId: input.chatId!, messageId: 70 + s.calls.length, part: "text", buttons: true }] }));
    const offer = wrapperMenuOffer(root, TELEGRAM, { routines: launchd.deps, send: s.send });
    await offer(HC, TEXT);
    await offer(HC, TEXT);
    const open = Object.values(registerIn(root)).filter(c => c.state === "open");
    expect(open).toHaveLength(1);
    expect(open[0].telegram).toEqual([{ chatId: "4242", messageId: 72 }]);
  });

  test("ohne Telegram: Menü für die WebUI festgehalten (Direktchat web), ohne Knöpfe an Telegram", async () => {
    const launchd = standardLaunchd();
    const s = fakeSend(async () => ({ sent: false, recorded: true }));
    const offer = wrapperMenuOffer(root, {}, { routines: launchd.deps, send: s.send });
    const outcome = await offer(HC, TEXT);
    expect(outcome.status).toBe("sent");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({ chatId: "web", text: TEXT, source: "routine" });
    expect(s.calls[0].buttons).toBeUndefined();
    const stored = Object.values(registerIn(root));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ state: "open", conversation: { type: "telegram", chatId: "web" } });
    expect(stored[0].telegram).toBeUndefined();
    expect(s.calls[0].choiceId).toBe(stored[0].id);
  });

  test("Versand wirft: Menü läuft ab, die Meldung geht ohne Knöpfe über den bisherigen Weg", async () => {
    const launchd = standardLaunchd();
    const s = fakeSend(async () => {
      throw new TypeError("Netz weg");
    });
    const plain: string[] = [];
    const sender = menuAlertSender(async text => (plain.push(text), { sent: true, recorded: true }), wrapperMenuOffer(root, TELEGRAM, { routines: launchd.deps, send: s.send }), () => {});
    expect(await sender(TEXT, { id: HC, kind: "failed" })).toEqual({ sent: true, recorded: true });
    expect(plain).toEqual([TEXT]);
    const stored = Object.values(registerIn(root));
    expect(stored.map(c => c.state)).toEqual(["expired"]);
  });

  test("Versand abgelehnt (sent und recorded false): Menü läuft ab, Ergebnis failed", async () => {
    const launchd = standardLaunchd();
    const s = fakeSend(async () => ({ sent: false, recorded: false, error: { kind: "send", message: "Telegram 500" } }));
    const outcome = await wrapperMenuOffer(root, TELEGRAM, { routines: launchd.deps, send: s.send })(HC, TEXT);
    expect(outcome.status).toBe("failed");
    expect(Object.values(registerIn(root)).map(c => c.state)).toEqual(["expired"]);
  });

  test("Versand hängt über Zeitlimit und Nachfrist: Menü läuft ab, kein zweiter Versand ohne Knöpfe", async () => {
    const launchd = standardLaunchd();
    const s = fakeSend(() => new Promise<SendAndRecordResult>(() => {}));
    const t = fakeTimer();
    const plain: string[] = [];
    const logs: string[] = [];
    const offer = wrapperMenuOffer(root, TELEGRAM, { routines: launchd.deps, send: s.send, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const sender = menuAlertSender(async text => (plain.push(text), { sent: true, recorded: true }), offer, line => logs.push(line), () => "telegram");
    const pending = sender(TEXT, { id: HC, kind: "missed" });
    await until(() => s.calls.length === 1);
    expect(t.timers[0].ms).toBe(150_000);
    t.fire();
    // Versand unterwegs: Nachfrist statt sofort ohne Knöpfe hinterher
    await until(() => t.timers.length === 2);
    expect(t.timers[1].ms).toBe(30_000);
    expect(plain).toEqual([]);
    t.fire();
    expect(await pending).toEqual({ sent: false, recorded: false });
    expect(plain).toEqual([]);
    expect(s.calls).toHaveLength(1);
    // Keine verwaiste offene Frage
    expect(Object.values(registerIn(root)).map(c => c.state)).toEqual(["expired"]);
    expect(logs).toEqual([`[routinen] ${HC} menu (telegram)`]);
    expect(t.pending()).toEqual([]);
  });

  test("Versand kommt in der Nachfrist zurück: gilt als gesendet, nichts ohne Knöpfe hinterher, Menü bleibt offen", async () => {
    const launchd = standardLaunchd();
    const reply = deferred<SendAndRecordResult>();
    const s = fakeSend(() => reply.promise);
    const t = fakeTimer();
    const plain: string[] = [];
    const offer = wrapperMenuOffer(root, TELEGRAM, { routines: launchd.deps, send: s.send, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const sender = menuAlertSender(async text => (plain.push(text), { sent: true, recorded: true }), offer, () => {});
    const pending = sender(TEXT, { id: HC, kind: "failed" });
    await until(() => s.calls.length === 1);
    t.fire();
    await until(() => t.timers.length === 2);
    reply.resolve({ sent: true, recorded: true, messages: [{ chatId: "4242", messageId: 91, part: "text", buttons: true }] });
    expect(await pending).toEqual({ sent: true, recorded: true });
    expect(plain).toEqual([]);
    expect(s.calls).toHaveLength(1);
    const stored = Object.values(registerIn(root));
    expect(stored.map(c => c.state)).toEqual(["open"]);
    expect(t.pending()).toEqual([]);
  });

  test("Versand scheitert erst in der Nachfrist: Menü läuft ab, genau ein Versand ohne Knöpfe", async () => {
    const launchd = standardLaunchd();
    const reply = deferred<SendAndRecordResult>();
    const s = fakeSend(() => reply.promise);
    const t = fakeTimer();
    const plain: string[] = [];
    const offer = wrapperMenuOffer(root, TELEGRAM, { routines: launchd.deps, send: s.send, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const sender = menuAlertSender(async text => (plain.push(text), { sent: true, recorded: true }), offer, () => {});
    const pending = sender(TEXT, { id: HC, kind: "failed" });
    await until(() => s.calls.length === 1);
    t.fire();
    await until(() => t.timers.length === 2);
    reply.resolve({ sent: false, recorded: false, error: { kind: "send", message: "Telegram 500" } });
    expect(await pending).toEqual({ sent: true, recorded: true });
    expect(plain).toEqual([TEXT]);
    expect(Object.values(registerIn(root)).map(c => c.state)).toEqual(["expired"]);
  });

  test("Katalog hängt über das Zeitlimit: ohne Knöpfe gemeldet; das spät gelesene Menü wird nie angelegt oder gesendet", async () => {
    const launchd = standardLaunchd();
    const gate = deferred<void>();
    const run = launchd.deps.run;
    let reads = 0;
    launchd.deps.run = async cmd => {
      if (cmd[1] === "list") {
        reads++;
        await gate.promise;
      }
      return run(cmd);
    };
    const s = fakeSend(async () => ({ sent: true, recorded: true }));
    const t = fakeTimer();
    const plain: string[] = [];
    const offer = wrapperMenuOffer(root, TELEGRAM, { routines: launchd.deps, send: s.send, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const sender = menuAlertSender(async text => (plain.push(text), { sent: true, recorded: true }), offer, () => {});
    const pending = sender(TEXT, { id: HC, kind: "failed" });
    await until(() => reads === 1 && t.timers.length === 1);
    t.fire();
    expect(await pending).toEqual({ sent: true, recorded: true });
    expect(plain).toEqual([TEXT]);
    // Keine Nachfrist: der Versand hatte nicht begonnen
    expect(t.timers).toHaveLength(1);
    // Der Katalog antwortet erst jetzt: offerMenu hört auf, ohne anzulegen oder zu senden
    gate.resolve();
    await Bun.sleep(20);
    expect(s.calls).toEqual([]);
    expect(registerIn(root)).toEqual({});
    expect(plain).toEqual([TEXT]);
  });

  test("Register hängt beim Anlegen über das Zeitlimit: das spät angelegte Menü läuft sofort ab und wird nie gesendet", async () => {
    const launchd = standardLaunchd();
    const gate = deferred<void>();
    const choicesModule = await import("../src/lib/choices");
    const realCreate = choicesModule.createChoice;
    const spy = spyOn(choicesModule, "createChoice").mockImplementation(async (input, options) => {
      await gate.promise;
      return realCreate(input, options);
    });
    try {
      const s = fakeSend(async () => ({ sent: true, recorded: true }));
      const t = fakeTimer();
      const plain: string[] = [];
      const offer = wrapperMenuOffer(root, TELEGRAM, { routines: launchd.deps, send: s.send, setTimer: t.setTimer, clearTimer: t.clearTimer });
      const sender = menuAlertSender(async text => (plain.push(text), { sent: true, recorded: true }), offer, () => {});
      const pending = sender(TEXT, { id: HC, kind: "failed" });
      await until(() => spy.mock.calls.length === 1);
      t.fire();
      expect(await pending).toEqual({ sent: true, recorded: true });
      expect(plain).toEqual([TEXT]);
      gate.resolve();
      await until(() => Object.keys(registerIn(root)).length === 1 && Object.values(registerIn(root))[0].state === "expired");
      await Bun.sleep(10);
      expect(s.calls).toEqual([]);
      expect(Object.values(registerIn(root)).map(c => c.state)).toEqual(["expired"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("Dauerdienst, Bot und unbekannte Routine: kein Menü, nichts gesendet, Register unberührt", async () => {
    const launchd = standardLaunchd();
    const s = fakeSend(async () => ({ sent: true, recorded: true }));
    const offer = wrapperMenuOffer(root, TELEGRAM, { routines: launchd.deps, send: s.send });
    for (const id of ["ai.tybo.web-proxy", "ai.tybo.telegram-relay", "ai.tybo.gibts-nicht"]) expect((await offer(id, TEXT)).status).toBe("none");
    expect(s.calls).toEqual([]);
    expect(registerIn(root)).toEqual({});
  });
});
