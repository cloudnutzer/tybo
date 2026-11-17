/**
 * Issue #568: Ein stehender Bot ergibt im Nachtcheck genau eine Meldung, den
 * Bericht dieses Laufs, mit ❌ für Prozess und Health-Port. Kein eigener
 * Telegram-Versand: der Bericht geht über die Outbox, ohne Telegram nur in
 * die Ablage der WebUI. Prozessabfrage, Health-Port, Telegram und Ablage
 * sind Attrappen; es wird nichts echt gesendet und nicht der Health-Port des
 * laufenden Bots gefragt.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plannedChecks, runCheck, runNightly, type CheckResult, type HealthState, type MaintenanceCheckDeps, type NightlyDeps } from "../src/health-check";
import type { BotAliveDeps } from "../src/lib/health/bot-alive";
import { sendAndRecord, type OutboxDeps, type SendAndRecordInput } from "../src/lib/outbox";

const NOW = new Date("2026-11-14T02:30:00Z");

/** Bot steht: systemd meldet failed, PM2 läuft nicht, der Health-Port verweigert die Verbindung */
function stoppedBot(): BotAliveDeps {
  return {
    platform: "linux",
    launchctlList: async () => "",
    systemdBooted: () => true,
    systemctlShow: async () => ({ ok: true, stdout: "LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nExecMainStatus=1\n" }),
    pm2Query: async () => ({ status: "not-running" }),
    fetch: async () => {
      throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
    },
  };
}

function runningBot(): BotAliveDeps {
  return {
    ...stoppedBot(),
    systemctlShow: async () => ({ ok: true, stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=321\nExecMainStatus=0\n" }),
    fetch: async () => new Response(JSON.stringify({ status: "ok", service: "tybo-telegram-bot", uptime: 60 }), { status: 200 }),
  };
}

/** Nur die beiden Zeilen zum Bot, über plannedChecks und runCheck wie im echten Lauf */
async function botLines(alive: BotAliveDeps): Promise<CheckResult[]> {
  const checks = plannedChecks({ withModel: false, env: { HEALTH_PORT: "3999" }, now: NOW.getTime(), state: { logs: {} }, nextState: { logs: {} }, maintenance: {} as MaintenanceCheckDeps, alive });
  const mine = checks.filter(c => c.name === "Bot-Prozess" || c.name === "Bot antwortet");
  expect(mine.map(c => c.name)).toEqual(["Bot-Prozess", "Bot antwortet"]);
  return (await Promise.all(mine.map(c => runCheck(c.name, c.fn, c.timeoutMs)))).flat();
}

function nightly(results: CheckResult[], send: NightlyDeps["send"]) {
  const out: string[] = [];
  const err: string[] = [];
  const saved: HealthState[] = [];
  const deps: NightlyDeps = {
    runChecks: async () => ({ results, state: { logs: {} } }),
    saveState: async state => void saved.push(state),
    send,
    timeZone: "Europe/Berlin",
    out: l => out.push(l),
    err: l => err.push(l),
  };
  return { deps, out, err, saved };
}

/** Outbox mit Attrappen: Telegram (fetch) und Ablage (record) zählen mit */
function outbox(options: { telegram: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "tybo-nachtcheck-outbox-"));
  const fetched: string[] = [];
  const recorded: unknown[] = [];
  const deps: OutboxDeps = {
    botToken: options.telegram ? "123456:test-token-nicht-echt" : "",
    userId: options.telegram ? "4242" : "",
    groupId: null,
    outboxDir: dir,
    fetch: async url => {
      fetched.push(url.replace(/bot[^/]+\//, "bot***/"));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    },
    record: async message => {
      recorded.push(message);
      return true;
    },
    log: () => {},
    newId: () => "00000000-0000-4000-8000-000000000001",
  };
  return { deps, fetched, recorded, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("stehender Bot im Nachtcheck", () => {
  test("Prozess und Health-Port scheitern gemeinsam: genau eine Meldung mit beiden ❌", async () => {
    const results = await botLines(stoppedBot());
    expect(results.map(r => r.status)).toEqual(["fail", "fail"]);
    const sent: SendAndRecordInput[] = [];
    const n = nightly(results, async input => {
      sent.push(input);
      return { sent: true, recorded: true };
    });
    expect(await runNightly([], n.deps, NOW)).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].source).toBe("nachtcheck");
    const lines = sent[0].text!.split("\n");
    expect(lines[0]).toBe("tybo Nachtcheck 14.11.: 2 Probleme");
    expect(lines[1]).toStartWith("❌ Bot-Prozess: systemd-Dienst tybo-telegram-relay.service läuft nicht");
    expect(lines[2]).toStartWith("❌ Bot antwortet: Port 3999: keine Verbindung, der Bot läuft nicht");
    expect(n.saved).toHaveLength(1);
  });

  test("ohne Telegram: Bericht einmal in der Ablage der WebUI, kein Telegram-Aufruf, Exit 0", async () => {
    const results = await botLines(stoppedBot());
    const box = outbox({ telegram: false });
    try {
      let calls = 0;
      const n = nightly(results, input => {
        calls++;
        return sendAndRecord(input, box.deps);
      });
      expect(await runNightly([], n.deps, NOW)).toBe(0);
      expect(calls).toBe(1);
      expect(box.fetched).toEqual([]);
      expect(box.recorded).toHaveLength(1);
      expect(JSON.stringify(box.recorded[0])).toContain("Bot antwortet");
      expect(n.out).toContain("[health] Report gesendet");
    } finally {
      box.cleanup();
    }
  });

  test("mit Telegram: genau ein sendMessage und ein Eintrag in der Ablage", async () => {
    const results = await botLines(stoppedBot());
    const box = outbox({ telegram: true });
    try {
      const n = nightly(results, input => sendAndRecord(input, box.deps));
      expect(await runNightly([], n.deps, NOW)).toBe(0);
      expect(box.fetched.filter(u => u.endsWith("/sendMessage"))).toHaveLength(1);
      expect(box.fetched).toHaveLength(1);
      expect(box.recorded).toHaveLength(1);
    } finally {
      box.cleanup();
    }
  });

  test("laufender Bot: beide Zeilen ✅, der Bericht geht wie jede Nacht einmal", async () => {
    const results = await botLines(runningBot());
    expect(results.map(r => r.status)).toEqual(["ok", "ok"]);
    const sent: SendAndRecordInput[] = [];
    const n = nightly(results, async input => {
      sent.push(input);
      return { sent: true, recorded: true };
    });
    await runNightly([], n.deps, NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0].text!.split("\n")[0]).toBe("tybo Nachtcheck 14.11.: alles grün");
  });

  test("--no-send: keine Meldung; Zustellung gescheitert: Exit 1", async () => {
    const results = await botLines(stoppedBot());
    let calls = 0;
    const quiet = nightly(results, async () => {
      calls++;
      return { sent: true, recorded: true };
    });
    expect(await runNightly(["--no-send"], quiet.deps, NOW)).toBe(0);
    expect(calls).toBe(0);
    const failing = nightly(results, async () => ({ sent: false, recorded: false, error: { kind: "send" as const, message: "Telegram nicht erreichbar" } }));
    expect(await runNightly([], failing.deps, NOW)).toBe(1);
    expect(failing.err.join("\n")).toContain("Report nicht zugestellt");
  });
});
