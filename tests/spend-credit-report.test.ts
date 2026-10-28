/**
 * Texte von /credit und /plan (Issue #346, src/lib/spend/credit.ts):
 * Abschnitt Claude-Abo (Stand, Limit, Prozent, Tage bis zum Reset; mit
 * API-Schlüssel bzw. CREDIT_GUARD=off nur ein Hinweis) und Abschnitt Motoren
 * im laufenden Zyklus, der immer erscheint. Gemeldete 0 $ bleiben 0 $,
 * fehlende Kosten erscheinen nie als 0 $. Deutsch, ohne Modellwechsel-
 * Versprechen. Die Dienste des Bots (command-services.ts) nutzen genau diese
 * Texte.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotCommandServices } from "../src/app/command-services";
import { commandRegistry } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import { storeEngineRun } from "../src/lib/spend/engine-runs";
import { creditReport, planReport, subscriptionMetering } from "../src/lib/spend/credit";
import { addCycleSpend, resetSubscriptionStateForTests, setObservedCeiling } from "../src/lib/spend/subscription";

const KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_AUTH", "BUDGET_DB_PATH", "CREDIT_CEILING_USD", "CREDIT_GUARD", "CREDIT_RESET_DAY", "CREDIT_WARN_PCT", "GO_PROJECT_ROOT"] as const;
let saved: Record<string, string | undefined> = {};
let dir = "";

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), "tybo-346-report-"));
  process.env.BUDGET_DB_PATH = join(dir, "api-budget.sqlite");
  process.env.GO_PROJECT_ROOT = dir;
  process.env.CREDIT_RESET_DAY = "15";
  resetSubscriptionStateForTests();
  setSystemTime(new Date("2026-05-20T12:00:00Z"));
});

afterEach(() => {
  setSystemTime();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

const ENGINES_EMPTY = "⚙️ **Motoren seit 15.05.2026**\nNoch keine Läufe in diesem Zyklus.";

describe("/credit: Abschnitt Claude-Abo", () => {
  test("mit eingestelltem Limit: Stand, Limit, Prozent und Tage bis zum Reset", () => {
    process.env.CREDIT_CEILING_USD = "20";
    addCycleSpend(12.4, 15);
    expect(creditReport()).toBe(`💳 **Claude-Abo**\n12,40 $ von 20 $ (62 %). Noch 26 Tage bis zum Reset.\n\n${ENGINES_EMPTY}`);
  });

  test("gemessenes Limit gilt vor dem eingestellten und wird so benannt", () => {
    process.env.CREDIT_CEILING_USD = "100";
    addCycleSpend(10.5, 15);
    setObservedCeiling(15, 10.5);
    expect(creditReport()).toContain("10,50 $ von 10,50 $ (100 %), Limit in diesem Zyklus gemessen. Noch 26 Tage bis zum Reset.");
  });

  test("ohne Limit: Stand und Hinweis auf /plan", () => {
    addCycleSpend(1.25, 15);
    expect(creditReport()).toBe(
      "💳 **Claude-Abo**\n1,25 $ in diesem Zyklus. Noch 26 Tage bis zum Reset.\n" +
        "Kein Limit eingestellt, darum keine Warnung. Wie du es setzt, steht unter /plan; sonst messe ich es, sobald das Guthaben einmal aufgebraucht ist.\n\n" +
        ENGINES_EMPTY,
    );
  });

  test("ein Tag vor dem Reset: Einzahl", () => {
    process.env.CREDIT_CEILING_USD = "20";
    setSystemTime(new Date("2026-06-14T12:00:00Z"));
    expect(creditReport()).toContain("Noch 1 Tag bis zum Reset.");
  });

  test("mit API-Schlüssel: kein Abo-Guthaben, der Abschnitt Motoren bleibt", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-nur-attrappe";
    storeEngineRun({ engine: "claude", origin: "chat", costUsd: 0.5 });
    expect(creditReport()).toBe(
      "💳 **Claude-Abo**\nEigener API-Schlüssel (ANTHROPIC_API_KEY): kein Abo-Guthaben zu beobachten.\n\n" +
        "⚙️ **Motoren seit 15.05.2026**\n- Claude Code: 1 Lauf, Tokens nicht gemeldet, 0,50 $",
    );
  });

  // Issue #349: die Messung folgt CLAUDE_AUTH, nicht der Anwesenheit des Schlüssels
  test("CLAUDE_AUTH=subscription mit gesetztem Schlüssel: Messung an, /credit zeigt das Abo", () => {
    process.env.CLAUDE_AUTH = "subscription";
    process.env.ANTHROPIC_API_KEY = "sk-test-nur-attrappe";
    process.env.CREDIT_CEILING_USD = "20";
    addCycleSpend(12.4, 15);
    expect(subscriptionMetering()).toBe(true);
    expect(creditReport()).toBe(`💳 **Claude-Abo**\n12,40 $ von 20 $ (62 %). Noch 26 Tage bis zum Reset.\n\n${ENGINES_EMPTY}`);
    expect(planReport()).not.toContain("eigenen API-Schlüssel");
    // CREDIT_GUARD=off schaltet auch dann jede Messung aus
    process.env.CREDIT_GUARD = "off";
    expect(subscriptionMetering()).toBe(false);
  });

  test("CLAUDE_AUTH=apiKey: Messung aus, /credit zeigt den eigenen Schlüssel, auch ohne Schlüssel", () => {
    process.env.CLAUDE_AUTH = "apiKey";
    process.env.ANTHROPIC_API_KEY = "sk-test-nur-attrappe";
    expect(subscriptionMetering()).toBe(false);
    expect(creditReport()).toStartWith("💳 **Claude-Abo**\nEigener API-Schlüssel (ANTHROPIC_API_KEY): kein Abo-Guthaben zu beobachten.");
    delete process.env.ANTHROPIC_API_KEY;
    expect(subscriptionMetering()).toBe(false);
    expect(planReport()).toContain("eigenen API-Schlüssel");
  });

  test("mit CREDIT_GUARD=off: Hinweis auf claude.ai, der Abschnitt Motoren bleibt", () => {
    process.env.CREDIT_GUARD = "off";
    storeEngineRun({ engine: "codex", origin: "chat", usage: { inputTokens: 1200, outputTokens: 34 } });
    expect(creditReport()).toBe(
      "💳 **Claude-Abo**\nMessung ist aus (CREDIT_GUARD). Deine echten Limits siehst du auf claude.ai → Settings → Usage.\n\n" +
        "⚙️ **Motoren seit 15.05.2026**\n- Codex: 1 Lauf, 1.234 Tokens (1.200 ein, 34 aus), Kosten nicht gemeldet",
    );
  });

  test("Speicherfehler: kein Wurf, ehrlicher Hinweis", async () => {
    const blocker = join(dir, "blocker");
    await Bun.write(blocker, "keine Ablage");
    process.env.BUDGET_DB_PATH = join(blocker, "api-budget.sqlite");
    process.env.GO_PROJECT_ROOT = join(blocker, "projekt");
    const text = creditReport();
    expect(text).toContain("Stand gerade nicht lesbar.");
    expect(text).toContain("Läufe gerade nicht lesbar.");
  });
});

describe("/credit: Abschnitt Motoren", () => {
  test("gemeldete 0 $, „Kosten nicht gemeldet“ und gemischte Läufe werden unterschieden", () => {
    // Codex: nie Kosten
    storeEngineRun({ engine: "codex", origin: "chat", usage: { inputTokens: 10, outputTokens: 3 } });
    storeEngineRun({ engine: "codex", origin: "routine", usage: { inputTokens: 5, outputTokens: 1 } });
    // OpenCode: gemeldete 0 $
    storeEngineRun({ engine: "opencode", origin: "chat", costUsd: 0, usage: { inputTokens: 14, outputTokens: 3 } });
    // Claude: gemischt (zwei mit Kosten, zwei ohne)
    storeEngineRun({ engine: "claude", origin: "chat", costUsd: 0.25 });
    storeEngineRun({ engine: "claude", origin: "aux", costUsd: 0.05 });
    storeEngineRun({ engine: "claude", origin: "fallback" });
    storeEngineRun({ engine: "claude", origin: "voice" });
    expect(creditReport().split("\n").slice(-4)).toEqual([
      "⚙️ **Motoren seit 15.05.2026**",
      "- Claude Code: 4 Läufe, Tokens nicht gemeldet, 0,30 $ (2 Läufe ohne Kostenmeldung)",
      "- Codex: 2 Läufe, 19 Tokens (15 ein, 4 aus), Kosten nicht gemeldet",
      "- OpenCode: 1 Lauf, 17 Tokens (14 ein, 3 aus), 0,00 $",
    ]);
  });

  test("ein einzelner Lauf ohne Kostenmeldung erscheint nie als 0 $", () => {
    storeEngineRun({ engine: "claude", origin: "fallback" });
    const engines = creditReport().split("⚙️")[1];
    expect(engines).toContain("- Claude Code: 1 Lauf, Tokens nicht gemeldet, Kosten nicht gemeldet");
    expect(engines).not.toContain("$");
  });

  test("nur der laufende Zyklus zählt; OpenRouter (Agent SDK) mit eigenem Namen", () => {
    storeEngineRun({ engine: "claude", origin: "chat", costUsd: 9 }, Date.parse("2026-05-14T23:59:59Z"));
    storeEngineRun({ engine: "openrouter", origin: "agent-sdk", costUsd: 0.2 }, Date.parse("2026-05-15T00:00:00Z"));
    expect(creditReport().split("\n").slice(-2)).toEqual([
      "⚙️ **Motoren seit 15.05.2026**",
      "- OpenRouter (Agent SDK): 1 Lauf, Tokens nicht gemeldet, 0,20 $",
    ]);
  });
});

describe("/plan", () => {
  test("Limit, gemessenes Limit, Reset-Tag und wie man sie setzt; ohne Modellwechsel-Versprechen", () => {
    process.env.CREDIT_CEILING_USD = "100";
    addCycleSpend(20, 15);
    setObservedCeiling(15, 20);
    const text = planReport();
    expect(text).toBe(
      "💳 **Claude-Abo: Limit und Zyklus**\n" +
        "Eingestelltes Limit: 100 $ (CREDIT_CEILING_USD)\n" +
        "Gemessenes Limit in diesem Zyklus: 20,00 $ (gilt vor dem eingestellten)\n" +
        "Reset-Tag: 15. des Monats (CREDIT_RESET_DAY)\n\n" +
        "So stellst du es ein: CREDIT_CEILING_USD (monatliches Guthaben deines Plans in Dollar) und CREDIT_RESET_DAY (Tag 1 bis 28, an dem dein Abrechnungszyklus beginnt) in die .env schreiben, dann tybo neu starten. Richtwerte: Pro 20 $, Max 5x 100 $, Max 20x 200 $.\n" +
        "Ist das Guthaben einmal aufgebraucht, merke ich mir den Stand als Limit für diesen Zyklus. Die Warnung kommt ab 80 %.",
    );
    expect(text).not.toMatch(/CREDIT_MODE|Modell|model|lowcost/i);
  });

  test("ohne Limit, mit CREDIT_GUARD=off und Reset-Tag über 28", () => {
    process.env.CREDIT_GUARD = "off";
    process.env.CREDIT_RESET_DAY = "31";
    const text = planReport();
    expect(text).toContain("Eingestelltes Limit: keins (CREDIT_CEILING_USD nicht gesetzt)\n");
    expect(text).toContain("Reset-Tag: 28. des Monats (CREDIT_RESET_DAY)\n");
    expect(text).toContain("Messung ist aus (CREDIT_GUARD): kein Abo-Zähler, keine Warnung.");
  });

  test("ungültiger Reset-Tag und eigener API-Schlüssel", () => {
    process.env.CREDIT_RESET_DAY = "abc";
    expect(planReport()).toContain("Reset-Tag: ungültig (CREDIT_RESET_DAY), darum kein Zyklus");
    process.env.ANTHROPIC_API_KEY = "sk-test-nur-attrappe";
    expect(planReport()).toBe(
      "💳 **Claude-Abo: Limit und Zyklus**\nDu nutzt einen eigenen API-Schlüssel (ANTHROPIC_API_KEY). Es gibt kein Abo-Guthaben, also nichts einzustellen.",
    );
  });
});

test("Dienste des Bots: /credit und credit in Telegram zeigen den echten Text aus spend/credit.ts", async () => {
  process.env.CREDIT_CEILING_USD = "20";
  addCycleSpend(5, 15);
  const services = createBotCommandServices({ routineMenu: async () => {} });
  expect(await services.formatCredit()).toBe(creditReport());
  expect(await services.formatPlan()).toBe(planReport());
  for (const text of ["/credit", "credit"]) {
    const sent: string[] = [];
    const match = commandRegistry.match(text, "telegram")!;
    await runTelegramCommand({
      chat: { reply: async (t) => void sent.push(t) },
      chatId: "-1001",
      sessionKey: "group:-1001",
      agent: "general",
      text,
      match,
      services,
      working: () => () => {},
      resetSession: async () => ({ status: "done", reset: 0, sessionMode: true }),
      agentTurn: async () => {},
      boardMeeting: async () => {},
    } as any);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("<b>Claude-Abo</b>");
    expect(sent[0]).toContain("5,00 $ von 20 $ (25 %)");
  }
});
