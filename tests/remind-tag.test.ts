/**
 * Issue #322: der Tag `[REMIND: wann | Text]`. Belegt: Zeitangaben in
 * USER_TIMEZONE (Uhrzeit, Dauer, Tag mit und ohne Uhrzeit, Sommerzeit,
 * unlesbar); direkt angewendet legt er genau eine Erinnerung im Gespräch des
 * Turns an (Telegram-Topic, Web-Gespräch, Turn ohne Telegram, ohne Gespräch
 * der Direktchat); Turns ohne Telegram im Direktchat, im Topic und im
 * Web-Gespräch, direkt und nach Zustimmung, bis zur Zustellung nur in der
 * WebUI; aus fremden Inhalten nur als Vorschlag mit festem
 * Zeitpunkt und Vorschau, angelegt erst nach Zustimmung, verworfen nie;
 * unlesbare Zeiten legen nichts an. Dazu Anzeige-Filter und Prompt.
 *
 * Ablage: die Datei unter einem Temp-Ordner (GO_PROJECT_ROOT), Vorschläge in
 * einer Temp-Datei; feste Uhr.
 */
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideReview, processTurnIntents, type IntentGateDeps } from "../src/lib/intent-gate";
import { processIntents } from "../src/lib/memory";
import { createReminderSender } from "../src/lib/reminder-choices";
import { listChoices, setChoicesFileForTests } from "../src/lib/choices";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import type { WebPost } from "../src/lib/review-choices";
import { createReminderPlanner } from "../src/lib/schedule/planner";
import { describeReminder, fixReminderTimes, parseReminderTime, webOnlyChatId } from "../src/lib/schedule/remind";
import type { Message } from "../src/lib/store/types";
import { createUserDelivery } from "../src/lib/user-notify";
import { getScheduleStore, resetScheduleStore } from "../src/lib/schedule/store";
import { describeTags, setPendingReviewsFileForTests, setReviewNotifier, type ReviewProposal } from "../src/lib/session-distill";
import { stripControlTags } from "../src/web/markdown";
import { buildPromptContext } from "../src/lib/prompt-builder";
import { isolateAgentCatalog } from "./catalog-fixture";

isolateAgentCatalog();

const ZONE = "Europe/Berlin";
// Sonntag, 18.10.2026 12:00 in Berlin (UTC+2)
const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const MIN = 60_000;
const WEB_ID = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";

const base = mkdtempSync(join(tmpdir(), "tybo-remind-tag-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const iso = (input: string, now = NOW, timeZone = ZONE) => parseReminderTime(input, { now: new Date(now), timeZone })?.toISOString();

describe("Zeitangaben", () => {
  test("Uhrzeit, Dauer und ISO wie parseWhen", () => {
    expect(iso("in 2 Minuten")).toBe("2026-10-18T10:02:00.000Z");
    expect(iso("in 3 Stunden")).toBe("2026-10-18T13:00:00.000Z");
    expect(iso("17:30")).toBe("2026-10-18T15:30:00.000Z");
    expect(iso("9 Uhr")).toBe("2026-10-19T07:00:00.000Z");
    expect(iso("um 9")).toBe("2026-10-19T07:00:00.000Z");
    expect(iso("5pm")).toBe("2026-10-18T15:00:00.000Z");
    expect(iso("2026-10-20T18:00:00Z")).toBe("2026-10-20T18:00:00.000Z");
  });

  test("Tag mit Uhrzeit", () => {
    expect(iso("morgen 9 Uhr")).toBe("2026-10-19T07:00:00.000Z");
    expect(iso("Morgen um 14:30")).toBe("2026-10-19T12:30:00.000Z");
    expect(iso("morgen um 9")).toBe("2026-10-19T07:00:00.000Z");
    expect(iso("morgen 9.30 Uhr")).toBe("2026-10-19T07:30:00.000Z");
    expect(iso("Freitag 8:15")).toBe("2026-10-23T06:15:00.000Z");
    expect(iso("tomorrow at 7pm")).toBe("2026-10-19T17:00:00.000Z");
    expect(iso("2026-10-20 18 Uhr")).toBe("2026-10-20T16:00:00.000Z");
  });

  test("nur ein Tag: 9 Uhr an diesem Tag", () => {
    expect(iso("morgen")).toBe("2026-10-19T07:00:00.000Z");
    expect(iso("in 3 Tagen")).toBe("2026-10-21T07:00:00.000Z");
    expect(iso("Montag")).toBe("2026-10-19T07:00:00.000Z");
  });

  test("über das Ende der Sommerzeit: Ortszeit bleibt", () => {
    // Samstag 24.10. 12:00, Sonntag 25.10. gilt wieder UTC+1
    const saturday = Date.parse("2026-10-24T10:00:00.000Z");
    expect(iso("morgen 9 Uhr", saturday)).toBe("2026-10-25T08:00:00.000Z");
    expect(iso("morgen 9 Uhr", saturday, "UTC")).toBe("2026-10-25T09:00:00.000Z");
  });

  test("unlesbar: undefined", () => {
    for (const bad of ["", "irgendwann", "morgen 25 Uhr", "morgen 9", "morgen 9.30", "13pm", "2026-02-30", "in drei Tagen"]) expect(iso(bad)).toBeUndefined();
  });

  test("Vorschlag: feste Zeitpunkte, unlesbare Tags fallen weg, andere bleiben", () => {
    const tags = "[REMEMBER: a]\n[REMIND: in 2 Stunden | Test]\n[REMIND: irgendwann | weg]\n[REMIND: morgen | ]";
    expect(fixReminderTimes(tags, { now: new Date(NOW), timeZone: ZONE })).toBe("[REMEMBER: a]\n[REMIND: 2026-10-18T12:00:00.000Z | Test]");
    expect(describeReminder("2026-10-18T12:00:00.000Z | Test", { timeZone: ZONE })).toBe("Test (18.10. 14:00)");
    expect(describeReminder("irgendwann | Test", { timeZone: ZONE })).toBeNull();
  });
});

describe("Anwenden", () => {
  const saved = { ...process.env };
  let dir: string;
  let proposals: ReviewProposal[];
  let logs: string[];
  const gate: Partial<IntentGateDeps> = { log: line => logs.push(line), projectRoot: join(base, "projekt"), dmChatId: () => "4711" };
  const WEBFETCH = { uses: [{ name: "WebFetch" }], cwd: join(base, "projekt") };

  beforeEach(() => {
    setSystemTime(new Date(NOW));
    dir = mkdtempSync(join(base, "run-"));
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.GO_PROJECT_ROOT = dir;
    process.env.USER_TIMEZONE = ZONE;
    process.env.TELEGRAM_BOT_TOKEN = "123:t";
    process.env.TELEGRAM_USER_ID = "4711";
    resetScheduleStore();
    setPendingReviewsFileForTests(join(dir, "pending-reviews.json"));
    proposals = [];
    logs = [];
    setReviewNotifier(async p => void proposals.push(p));
  });
  afterEach(() => {
    setSystemTime();
    setReviewNotifier(null);
    setPendingReviewsFileForTests(null);
    resetScheduleStore();
    for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GO_PROJECT_ROOT", "USER_TIMEZONE", "TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const tasks = () => getScheduleStore().list();

  test("direkt aus einem Telegram-Topic: genau eine Erinnerung dort", async () => {
    const outcome = await processTurnIntents("Mach ich. [REMIND: in 2 Minuten | den Test]", { uses: [] }, { chatId: "-1001234567890", topicId: 7, origin: "Telegram" }, gate);
    expect(outcome).toBe("applied");
    const all = await tasks();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ chatId: "-1001234567890", topicId: 7, kind: "reminder", text: "den Test", dueAt: "2026-10-18T10:02:00.000Z", status: "pending" });
  });

  test("Web-Gespräch, Turn ohne Telegram und ohne Gespräch", async () => {
    await processIntents("[REMIND: 17:30 | a]", { conversation: { type: "web", conversationId: WEB_ID } });
    await processIntents("[REMIND: 17:30 | b]", { conversation: { type: "telegram", chatId: "4711" }, noTelegram: { conversationId: WEB_ID } });
    await processIntents("[REMIND: 17:30 | c]");
    const chats = Object.fromEntries((await tasks()).map(t => [t.text, [t.chatId, t.topicId]]));
    expect(chats).toEqual({ a: [`web:${WEB_ID}`, null], b: [`web:${WEB_ID}`, null], c: ["4711", null] });
  });

  for (const confirmed of [false, true]) {
    test(`Turn ohne Telegram (${confirmed ? "nach Zustimmung" : "direkt"}): Direktchat, Topic und Web-Gespräch, zugestellt nur in der WebUI`, async () => {
      const GROUP = "-1001234567890";
      const turns = [
        { text: "dm", target: { chatId: "4711", noTelegram: { conversationId: "dm" } } },
        { text: "topic", target: { chatId: GROUP, topicId: 9, noTelegram: { conversationId: "topic-9" } } },
        { text: "web", target: { chatId: `web:${WEB_ID}`, noTelegram: { conversationId: WEB_ID } } },
      ];
      for (const turn of turns) {
        const outcome = await processTurnIntents(`[REMIND: in 2 Minuten | ${turn.text}]`, confirmed ? WEBFETCH : { uses: [] }, { ...turn.target, origin: "Sprach-Bruecke" }, gate);
        expect(outcome).toBe(confirmed ? "staged" : "applied");
      }
      if (confirmed) {
        expect(await tasks()).toEqual([]);
        expect(proposals).toHaveLength(3);
        for (const p of proposals) expect((await decideReview("ok", p.reviewId)).kind).toBe("applied");
      }
      const stored = Object.fromEntries((await tasks()).map(t => [t.text, [t.chatId, t.topicId]]));
      expect(stored).toEqual({ dm: [webOnlyChatId("4711"), null], topic: [webOnlyChatId(GROUP), 9], web: [`web:${WEB_ID}`, null] });

      // Zustellung: mit Telegram eingerichtet, trotzdem kein Aufruf an Telegram
      setChoicesFileForTests(join(dir, "choices.json"));
      try {
        const calls: unknown[] = [];
        const recorded: Message[] = [];
        const outbox: OutboxDeps = {
          botToken: "123:t",
          userId: "4711",
          groupId: GROUP,
          outboxDir: join(dir, "outbox"),
          fetch: async (_url, init) => (calls.push(init.body), Response.json({ ok: true, result: { message_id: 1 } })),
          record: async m => (recorded.push(m), true),
          log: () => {},
          newId: () => crypto.randomUUID(),
        };
        const posts: [string, WebPost][] = [];
        const planner = createReminderPlanner({
          store: () => getScheduleStore(),
          now: () => Date.now(),
          timeZone: () => ZONE,
          log: () => {},
          send: createReminderSender({
            deliver: createUserDelivery({ telegram: () => true, send: input => sendAndRecord(input, outbox), log: () => {} }),
            postWeb: async (conversationId, post) => (posts.push([conversationId, post]), true),
            telegram: () => true,
            log: () => {},
          }),
        });
        setSystemTime(new Date(NOW + 3 * MIN));
        expect(await planner.tick()).toMatchObject({ sent: 3, retry: 0, failed: 0 });
        expect(calls).toEqual([]);
        expect(posts.map(([id, post]) => [id, post.text])).toEqual([
          ["dm", "⏰ Erinnerung: dm"],
          ["topic-9", "⏰ Erinnerung: topic"],
        ]);
        expect(recorded.map(m => [m.chat_id, m.content])).toEqual([[`web:${WEB_ID}`, "⏰ Erinnerung: web"]]);
        const choices = await listChoices();
        expect(choices.map(c => c.noTelegram?.conversationId ?? c.conversation).sort()).toEqual(["dm", "topic-9", { type: "web", conversationId: WEB_ID }].sort() as never);
        expect((await tasks()).map(t => t.status)).toEqual(["done", "done", "done"]);
      } finally {
        setChoicesFileForTests(null);
      }
    });
  }

  test("Ergebnis nennt die Erinnerung, unlesbare Zeit legt nichts an", async () => {
    const result = await processIntents("[REMIND: irgendwann | x] [REMIND: morgen 9 Uhr | Arzt]");
    expect(result.remindersAdded).toEqual([{ text: "Arzt", dueAt: "2026-10-19T07:00:00.000Z" }]);
    expect((await tasks()).map(t => t.text)).toEqual(["Arzt"]);
  });

  test("aus fremden Inhalten nur als Vorschlag mit festem Zeitpunkt; erst die Zustimmung legt an", async () => {
    const outcome = await processTurnIntents("Laut Seite: [REMIND: in 2 Stunden | Paket abholen]", WEBFETCH, { chatId: "4711", origin: "Telegram" }, gate);
    expect(outcome).toBe("staged");
    expect(await tasks()).toEqual([]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].text).toContain("• Erinnerung: Paket abholen (18.10. 14:00)");
    // Zustimmung eine Stunde später: der Zeitpunkt zählt von der Antwort aus
    setSystemTime(new Date(NOW + 60 * MIN));
    const decision = await decideReview("ok", proposals[0].reviewId);
    expect(decision.kind).toBe("applied");
    if (decision.kind === "applied") expect(decision.text).toContain("1 Erinnerung(en)");
    const all = await tasks();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ chatId: "4711", text: "Paket abholen", dueAt: "2026-10-18T12:00:00.000Z" });
    // Zweiter Klick: abgelaufen, keine zweite Erinnerung
    expect((await decideReview("ok", proposals[0].reviewId)).kind).toBe("expired");
    expect(await tasks()).toHaveLength(1);
  });

  test("Vorschlag abgelehnt: nichts angelegt", async () => {
    await processTurnIntents("[REMIND: morgen | Rechnung zahlen]", WEBFETCH, { chatId: "4711", origin: "Telegram" }, gate);
    expect((await decideReview("no", proposals[0].reviewId)).kind).toBe("discarded");
    expect(await tasks()).toEqual([]);
  });

  test("aus fremden Inhalten mit unlesbarer Zeit: kein Vorschlag, nichts angelegt", async () => {
    expect(await processTurnIntents("[REMIND: irgendwann | x]", WEBFETCH, { chatId: "4711", origin: "Telegram" }, gate)).toBe("staged");
    expect(proposals).toEqual([]);
    expect(await tasks()).toEqual([]);
    expect(logs.some(l => l.includes("verworfen"))).toBe(true);
  });

  test("Vorschau zeigt die Erinnerung, auch neben anderen Tags", () => {
    process.env.USER_TIMEZONE = ZONE;
    expect(describeTags("[REMEMBER: a]\n[REMIND: 2026-10-19T07:00:00.000Z | Arzt]")).toBe("• Fakt merken: a\n• Erinnerung: Arzt (19.10. 09:00)");
  });
});

describe("Anzeige und Prompt", () => {
  test("WebUI zeigt den Tag nicht", () => {
    expect(stripControlTags("Mach ich.\n[REMIND: in 2 Minuten | Test]")).toBe("Mach ich.");
  });

  test("Prompt beschreibt den Tag mit Zeit vor dem Text", async () => {
    const { fullPrompt } = await buildPromptContext({ userMessage: "erinnere mich in 2 Minuten an den Test", chatId: "4711", agentName: "general" });
    expect(fullPrompt).toContain("[REMIND: when | text]");
    expect(fullPrompt).toContain("in 20 Minuten");
  });
});
