/**
 * Warnung zum Claude-Guthaben (Issue #346, src/lib/spend/credit.ts): ab
 * CREDIT_WARN_PCT (Standard 0,8) des wirksamen Limits (gelernt vor
 * CREDIT_CEILING_USD) genau einmal je Zyklus, auch bei parallelen
 * Buchungen, im nächsten Zyklus wieder. Ohne Limit, ohne aktive Messung und
 * bei Codex/OpenCode keine Warnung. Speicher- und Versandfehler halten den
 * Aufrufer nicht auf. Versand über user-notify (createBotNotices wie im Bot):
 * ohne Telegram landet die Meldung nur in der WebUI.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotNotices } from "../src/lib/bot-notices";
import { WEB_DM_CHAT_ID } from "../src/lib/channels";
import type { SendAndRecordInput } from "../src/lib/outbox";
import { bookEngineRun, setCreditNotifier, type FinishedRun } from "../src/lib/spend/credit";
import { addCycleSpend, readCycle, resetSubscriptionStateForTests } from "../src/lib/spend/subscription";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "BUDGET_DB_PATH",
  "CREDIT_CEILING_USD",
  "CREDIT_GUARD",
  "CREDIT_PLAN",
  "CREDIT_RESET_DAY",
  "CREDIT_WARN_PCT",
  "GO_PROJECT_ROOT",
] as const;
let saved: Record<string, string | undefined> = {};
let dir = "";
let sent: string[] = [];
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), "tybo-346-warn-"));
  process.env.BUDGET_DB_PATH = join(dir, "data", "api-budget.sqlite");
  process.env.GO_PROJECT_ROOT = dir;
  process.env.CREDIT_RESET_DAY = "15";
  process.env.CREDIT_CEILING_USD = "20";
  resetSubscriptionStateForTests();
  setSystemTime(new Date("2026-05-20T12:00:00Z"));
  sent = [];
  setCreditNotifier((text) => void sent.push(text));
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setCreditNotifier(null);
  setSystemTime();
  warnSpy.mockRestore();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

const claude = (costUsd: number, extra: Partial<FinishedRun> = {}): FinishedRun => ({
  engine: "claude",
  origin: "chat",
  costUsd,
  isError: false,
  text: "ok",
  ...extra,
});

describe("Schwelle", () => {
  test("unter der Schwelle keine Warnung", async () => {
    await bookEngineRun(claude(15.99));
    expect(sent).toEqual([]);
  });

  test("genau bei der Schwelle (80 %): eine Warnung auf Deutsch ohne Modellwechsel-Versprechen", async () => {
    await bookEngineRun(claude(16));
    expect(sent).toEqual(["💳 Du hast 80 % deines Claude-Guthabens verbraucht (16,00 $ von 20 $ in diesem Zyklus). Mehr mit /credit."]);
  });

  test("über der Schwelle: Prozent und Betrag, danach im selben Zyklus keine zweite", async () => {
    await bookEngineRun(claude(10));
    await bookEngineRun(claude(6.4));
    expect(sent).toEqual(["💳 Du hast 82 % deines Claude-Guthabens verbraucht (16,40 $ von 20 $ in diesem Zyklus). Mehr mit /credit."]);
    await bookEngineRun(claude(1));
    await bookEngineRun(claude(5));
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(/Modell|model/i);
  });

  test("CREDIT_WARN_PCT verschiebt die Schwelle", async () => {
    process.env.CREDIT_WARN_PCT = "0.5";
    await bookEngineRun(claude(9.99));
    expect(sent).toEqual([]);
    await bookEngineRun(claude(0.01));
    expect(sent[0]).toContain("50 %");
  });

  test("parallele Buchungen über die Schwelle: genau eine Meldung", async () => {
    await Promise.all([bookEngineRun(claude(9)), bookEngineRun(claude(9)), bookEngineRun(claude(1)), bookEngineRun(claude(0.5))]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toStartWith("💳 Du hast ");
    await Promise.all([bookEngineRun(claude(1)), bookEngineRun(claude(1))]);
    expect(sent).toHaveLength(1);
  });

  test("nächster Zyklus: wieder ab 0, wieder eine Warnung", async () => {
    await bookEngineRun(claude(17));
    expect(sent).toHaveLength(1);
    setSystemTime(new Date("2026-06-16T09:00:00Z"));
    await bookEngineRun(claude(15));
    expect(sent).toHaveLength(1);
    await bookEngineRun(claude(1));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("(16,00 $ von 20 $ in diesem Zyklus)");
  });

  test("gelerntes Limit hat Vorrang vor CREDIT_CEILING_USD", async () => {
    process.env.CREDIT_CEILING_USD = "100";
    await bookEngineRun(claude(9));
    await bookEngineRun(claude(1, { isError: true, text: "Claude AI usage limit reached" }));
    // Limit gelernt bei 10 $: 100 % davon, Planhinweis und Warnung
    expect(readCycle(15)?.observedCeilingUsd).toBe(10);
    expect(sent).toEqual([
      "💳 Dein Claude-Guthaben war bei etwa 10,00 $ aufgebraucht, unter den eingestellten 100 $. Dein Plan hat sich offenbar geändert; tybo rechnet in diesem Zyklus mit dem gemessenen Wert. Mehr mit /plan.",
      "💳 Du hast 100 % deines Claude-Guthabens verbraucht (10,00 $ von 10 $ in diesem Zyklus). Mehr mit /credit.",
    ]);
  });

  test("parallele Limit-Läufe: der Planhinweis kommt nur einmal", async () => {
    process.env.CREDIT_CEILING_USD = "100";
    addCycleSpend(10, 15);
    const limit = { isError: true, text: "You've hit your limit" };
    await Promise.all([bookEngineRun(claude(0.5, limit)), bookEngineRun(claude(0.5, limit)), bookEngineRun(claude(0.5, limit))]);
    expect(sent.filter((t) => t.includes("Plan hat sich offenbar geändert"))).toHaveLength(1);
  });
});

describe("Keine Warnung", () => {
  test("ohne Limit (weder eingestellt noch gelernt)", async () => {
    delete process.env.CREDIT_CEILING_USD;
    await bookEngineRun(claude(500));
    expect(sent).toEqual([]);
  });

  test("Codex und OpenCode lösen keine Warnung aus und zählen nicht", async () => {
    await bookEngineRun({ engine: "codex", origin: "chat", usage: { inputTokens: 100 } });
    await bookEngineRun({ engine: "opencode", origin: "chat", costUsd: 50 });
    expect(sent).toEqual([]);
    expect(readCycle(15)?.cycleSpendUsd).toBe(0);
  });

  test("mit API-Schlüssel oder CREDIT_GUARD=off", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-nur-attrappe";
    await bookEngineRun(claude(19));
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CREDIT_GUARD = "off";
    await bookEngineRun(claude(19));
    expect(sent).toEqual([]);
  });

  test("CREDIT_RESET_DAY ohne Zahl: kein Zyklus, nichts im Abo-Zähler, keine Warnung, keine Ausnahme", async () => {
    process.env.CREDIT_RESET_DAY = "abc";
    await bookEngineRun(claude(19));
    await bookEngineRun(claude(19, { isError: true, text: "usage limit reached" }));
    expect(sent).toEqual([]);
  });

  test("CREDIT_RESET_DAY=Infinity: Zyklus beginnt am 28.", async () => {
    process.env.CREDIT_RESET_DAY = "Infinity";
    setSystemTime(new Date("2026-05-27T12:00:00Z"));
    await bookEngineRun(claude(17));
    expect(sent).toHaveLength(1);
    setSystemTime(new Date("2026-05-28T00:00:00Z"));
    expect(readCycle(Number.POSITIVE_INFINITY)?.cycleSpendUsd).toBe(0);
  });
});

describe("Fehler halten den Turn nicht auf", () => {
  test("Speicherfehler: keine Ausnahme, keine Meldung", async () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "keine Ablage");
    process.env.BUDGET_DB_PATH = join(blocker, "api-budget.sqlite");
    process.env.GO_PROJECT_ROOT = join(blocker, "projekt");
    await expect(bookEngineRun(claude(19))).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  test("Versandfehler (wirft oder lehnt ab): keine Ausnahme, Warnstatus bleibt, kein zweiter Versuch im Zyklus", async () => {
    let attempts = 0;
    setCreditNotifier(() => {
      attempts++;
      throw new Error("Telegram weg");
    });
    await expect(bookEngineRun(claude(17))).resolves.toBeUndefined();
    expect(attempts).toBe(1);
    expect(readCycle(15)?.warnedThisCycle).toBe(true);
    setCreditNotifier(async () => {
      attempts++;
      throw new Error("abgelehnt");
    });
    await expect(bookEngineRun(claude(1))).resolves.toBeUndefined();
    expect(attempts).toBe(1);
  });

  test("abgelehntes Versand-Promise: keine Ausnahme", async () => {
    setCreditNotifier(() => Promise.reject(new Error("abgelehnt")));
    await expect(bookEngineRun(claude(17))).resolves.toBeUndefined();
  });
});

test("ohne Telegram: die Warnung geht über user-notify nur in die WebUI (Direktchat, Klartext)", async () => {
  const outbox: SendAndRecordInput[] = [];
  const notices = createBotNotices({
    telegram: () => false,
    send: async (input) => {
      outbox.push(input);
      return { ok: true } as never;
    },
    sendStatusMessage: async () => {
      throw new Error("Telegram darf nicht benutzt werden");
    },
    dmChatId: () => "",
  });
  // So verdrahtet es src/bot.ts
  setCreditNotifier(notices.plain);
  await bookEngineRun(claude(17));
  await Bun.sleep(5);
  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({ chatId: WEB_DM_CHAT_ID, format: "plain", source: "system" });
  expect(outbox[0].text).toStartWith("💳 Du hast 85 % deines Claude-Guthabens verbraucht");
});
