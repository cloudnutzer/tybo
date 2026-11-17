/**
 * Issue #518: tybo gedaechtnis ziele-nachholen über runTybo gegen das echte
 * db/schema.sql (tests/pg-harness.ts), mit echtem Rückfragen-Register, echter
 * Vorschlags-Ablage und echtem Handler wie im Bot. Ersetzt sind nur Telegram
 * und der Ablageort. Alle Daten sind erfunden.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN; ohne beide übersprungen, in der CI
 * ein Fehler (wie tests/schema-basis-pg.test.ts). Was keine Datenbank braucht,
 * läuft immer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "bun";
import { decideChoice, listChoices, onChoiceDecided, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { decideReview } from "../src/lib/intent-gate";
import { goalCandidates, goalKey, goalTag, readRepliesWithGoals, runGoalBackfill } from "../src/lib/memory/goal-backfill";
import { createReviewResults, REVIEW_APPLY, REVIEW_DISCARD } from "../src/lib/review-choices";
import { setPendingReviewsFileForTests } from "../src/lib/session-distill";
import { resetStore } from "../src/lib/store";
import { getSupabase, resetSupabaseClient } from "../src/lib/supabase";
import type { SendAndRecordInput, SendAndRecordResult } from "../src/lib/outbox";
import { runTybo } from "../scripts/tybo";
import { pgAvailable, respondViaPg, startPg, type PgServer } from "./pg-harness";
import { FAKE_SUPABASE_URL, useFakeSupabase } from "./supabase-fixture";

const available = pgAvailable();

if (!available.ok && process.env.CI) {
  test("PostgreSQL für das Nachholen von Zielen ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

const ZONE = "Europe/Berlin";

describe("Ziele in alten Antworten erkennen", () => {
  const reply = (id: number, content: string, created_at = "2026-03-10T10:00:00.000Z") => ({ id, content, created_at });

  test("relative Frist gilt ab der alten Antwort, nicht ab heute", () => {
    const [goal] = goalCandidates([reply(1, "[GOAL: Antrag abgeben | DEADLINE: morgen]")], ZONE);
    expect(goal.deadline?.slice(0, 10)).toBe("2026-03-11");
    expect(goalTag(goal)).toBe(`[GOAL: Antrag abgeben | DEADLINE: ${goal.deadline}]`);
  });

  test("englische relative Frist ebenso", () => {
    const [goal] = goalCandidates([reply(1, "[GOAL: Antrag abgeben | DEADLINE: in 3 days]")], ZONE);
    expect(goal.deadline?.slice(0, 10)).toBe("2026-03-13");
  });

  test("unlesbare Frist: Ziel ohne Frist; übergroße Frist wirft nicht", () => {
    const goals = goalCandidates([reply(1, "[GOAL: Ziel eins | DEADLINE: irgendwann bald]"), reply(2, "[GOAL: Ziel zwei | DEADLINE: in 99999999999999 days]")], ZONE);
    expect(goals.map(g => g.deadline)).toEqual([undefined, undefined]);
  });

  test("gleiche Ziele nur einmal, die jüngste Nennung zählt, Groß- und Kleinschreibung egal", () => {
    const goals = goalCandidates(
      [reply(1, "[GOAL: Rad  putzen | DEADLINE: 2030-01-01T00:00:00Z]", "2026-01-01T10:00:00.000Z"), reply(2, "[goal: RAD putzen | DEADLINE: 2031-01-01T00:00:00Z]", "2026-02-01T10:00:00.000Z")],
      ZONE,
    );
    expect(goals).toHaveLength(1);
    expect(goals[0].text).toBe("RAD putzen");
    expect(goals[0].deadline).toBe("2031-01-01T00:00:00.000Z");
    expect(goals[0].key).toBe(goalKey("rad putzen"));
  });

  test("andere Tags und ungültige Zeitpunkte bleiben draußen", () => {
    expect(goalCandidates([reply(1, "[REMEMBER: kein Ziel] [DONE: auch keins]"), reply(2, "[GOAL: ohne Zeit]", "kein Datum")], ZONE)).toEqual([]);
  });
});

describe.skipIf(!available.ok)("tybo gedaechtnis ziele-nachholen gegen das echte Schema", () => {
  let pg: PgServer;
  let service: SQL;
  let fake: ReturnType<typeof useFakeSupabase>;
  let root: string;
  let out: string[];
  let errs: string[];
  const undo: (() => void)[] = [];
  const savedZone = process.env.USER_TIMEZONE;

  beforeAll(async () => {
    pg = await startPg();
    await pg.applySchema();
    service = await pg.connect("service_role");
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(async () => {
    await pg.admin.unsafe("TRUNCATE public.memory, public.messages RESTART IDENTITY CASCADE");
    root = mkdtempSync(join(tmpdir(), "tybo-nachholen-"));
    setChoicesFileForTests(join(root, "data", "choices.json"));
    setPendingReviewsFileForTests(join(root, "data", "pending-reviews.json"));
    process.env.USER_TIMEZONE = ZONE;
    fake = useFakeSupabase({ respond: respondViaPg(service, FAKE_SUPABASE_URL) });
    out = [];
    errs = [];
    for (const method of ["log", "warn", "error"] as const) {
      const spy = spyOn(console, method).mockImplementation(() => {});
      undo.push(() => spy.mockRestore());
    }
    // Wie der Bot: der Handler der Art "review" (bot-choices.ts) wendet an
    const results = createReviewResults({
      decideReview,
      createRoutine: async () => ({ isError: true }),
      sendAndRecord: async () => ({ sent: false, recorded: true }),
      sendTelegram: async () => {},
      saveMessage: async () => true,
      dmChatId: () => undefined,
    });
    undo.push(onChoiceDecided("review", results.handler));
  });

  afterEach(async () => {
    while (undo.length) undo.pop()!();
    setChoicesFileForTests(null);
    setPendingReviewsFileForTests(null);
    fake.restore();
    resetStore();
    resetSupabaseClient();
    rmSync(root, { recursive: true, force: true });
    if (savedZone === undefined) delete process.env.USER_TIMEZONE;
    else process.env.USER_TIMEZONE = savedZone;
    await pg.admin.unsafe("ALTER TABLE IF EXISTS public.messages_weg RENAME TO messages");
  });

  const say = (content: string, created_at = "2026-03-10T10:00:00.000Z", role = "assistant", metadata: Record<string, unknown> = {}) =>
    pg.admin.unsafe("INSERT INTO public.messages (chat_id, role, content, created_at, metadata) VALUES ('4711', $1, $2, $3::timestamptz, $4::text::jsonb)", [role, content, created_at, JSON.stringify(metadata)]);
  const memoryRows = () => pg.admin.unsafe("SELECT type, content, deadline FROM public.memory ORDER BY id") as unknown as Promise<{ type: string; content: string; deadline: Date | null }[]>;
  const reviews = async (): Promise<Choice[]> => (await listChoices()).filter(c => c.kind === "review");
  const nachholen = (extra: Partial<Parameters<typeof runTybo>[0]> = {}) =>
    runTybo({ args: ["gedaechtnis", "ziele-nachholen"], env: process.env, root, out: line => void out.push(line), err: line => void errs.push(line), ...extra });
  const ledger = () => join(root, "data", "goal-backfill.json");

  /** Telegram eingerichtet, Versand als Attrappe */
  function telegram(result: SendAndRecordResult = { sent: true, recorded: true }) {
    const sent: SendAndRecordInput[] = [];
    const send = async (input: SendAndRecordInput) => (sent.push(input), result);
    const options = {
      env: { ...process.env, TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_USER_ID: "4711" },
      goalBackfill: { send, createApi: () => ({ editMessageText: async () => {}, editMessageReplyMarkup: async () => {} }) },
    };
    return { sent, options };
  }

  test("ohne Telegram: Vorschläge im Web-Direktchat, nichts gespeichert", async () => {
    await say("Mache ich. [GOAL: Keller aufräumen]");
    await say("[GOAL: Antrag abgeben | DEADLINE: morgen]", "2026-03-20T10:00:00.000Z");
    expect(await nachholen()).toBe(0);
    expect(out[0]).toContain("Gefunden: 2");
    expect(out[0]).toContain("jetzt vorgeschlagen: 2");
    expect(await memoryRows()).toEqual([]);
    const open = await reviews();
    expect(open.map(c => c.conversation)).toEqual([{ type: "telegram", chatId: "web" }, { type: "telegram", chatId: "web" }]);
    expect(open[0].text).toContain("Keller aufräumen");
    expect(open[0].text).toContain("10.03.2026");
    expect(open[0].options.map(o => o.key)).toEqual([REVIEW_APPLY, REVIEW_DISCARD]);
    // Die Frage ist für die WebUI festgehalten, als Meldung mit Bezug zur Rückfrage
    const notices = await pg.admin.unsafe("SELECT chat_id, metadata FROM public.messages WHERE metadata->>'choiceId' IS NOT NULL ORDER BY id");
    expect(notices.map((n: { chat_id: string }) => n.chat_id)).toEqual(["web", "web"]);
    expect(notices.every((n: { metadata: Record<string, unknown> }) => n.metadata.display_only === true)).toBe(true);
    expect(notices.map((n: { metadata: { choiceId: string } }) => n.metadata.choiceId)).toEqual(open.map(c => c.id));
  });

  test("nur Antworten: keine Nutzernachrichten, keine Meldungen", async () => {
    await say("[GOAL: Vom Nutzer]", undefined, "user");
    await say("[GOAL: Nur Meldung]", undefined, "assistant", { display_only: true });
    await say("[GOAL: Echte Antwort]", undefined, "assistant", { display_only: false });
    expect(await nachholen()).toBe(0);
    expect((await reviews()).map(c => c.text.includes("Echte Antwort"))).toEqual([true]);
  });

  test("Übernehmen speichert genau einmal, die Frist ab der alten Antwort; Verwerfen speichert nichts", async () => {
    await say("[GOAL: Antrag abgeben | DEADLINE: morgen]");
    await say("[GOAL: Reifen wechseln]", "2026-03-11T10:00:00.000Z");
    await nachholen();
    const [first, second] = await reviews();
    const decided = await decideChoice(first.id, REVIEW_APPLY, "web");
    expect(decided.status).toBe("decided");
    const again = await decideChoice(first.id, REVIEW_APPLY, "web");
    expect(again.status).toBe("already");
    const stored = await memoryRows();
    expect(stored.map(r => [r.type, r.content])).toEqual([["goal", "Antrag abgeben"]]);
    expect(stored[0].deadline?.toISOString().slice(0, 10)).toBe("2026-03-11");
    expect((await decideChoice(second.id, REVIEW_DISCARD, "web")).status).toBe("decided");
    expect(await decideChoice(second.id, REVIEW_APPLY, "web")).toMatchObject({ status: "already" });
    expect((await memoryRows()).map(r => r.content)).toEqual(["Antrag abgeben"]);
  });

  test("gleichzeitige Klicks: nur einer gewinnt", async () => {
    await say("[GOAL: Antrag abgeben]");
    await nachholen();
    const [choice] = await reviews();
    const results = await Promise.all([1, 2, 3].map(() => decideChoice(choice.id, REVIEW_APPLY, "web")));
    expect(results.filter(r => r.status === "decided")).toHaveLength(1);
    expect(await memoryRows()).toHaveLength(1);
  });

  test("Wiederholung fragt nichts doppelt: übernommen, verworfen und offen bleiben draußen", async () => {
    await say("[GOAL: Übernommen]");
    await say("[GOAL: Verworfen]");
    await say("[GOAL: Noch offen]");
    await nachholen();
    const list = await reviews();
    await decideChoice(list.find(c => c.text.includes("Übernommen"))!.id, REVIEW_APPLY, "web");
    await decideChoice(list.find(c => c.text.includes("Verworfen"))!.id, REVIEW_DISCARD, "web");
    out = [];
    await say("[GOAL: Ganz neu]");
    expect(await nachholen()).toBe(0);
    expect(out[0]).toContain("Gefunden: 4");
    expect(out[0]).toContain("schon gespeichert: 1");
    expect(out[0]).toContain("schon vorgeschlagen: 2");
    expect(out[0]).toContain("jetzt vorgeschlagen: 1");
    expect((await reviews()).filter(c => c.text.includes("Noch offen"))).toHaveLength(1);
    expect((await memoryRows()).map(r => r.content)).toEqual(["Übernommen"]);
  });

  test("schon gespeicherte Ziele kommen nicht, auch erledigte nicht", async () => {
    await pg.admin.unsafe("INSERT INTO public.memory (type, content) VALUES ('goal', 'Offen da'), ('completed_goal', 'Erledigt da')");
    await say("[GOAL: offen  DA] [GOAL: Erledigt da]");
    expect(await nachholen()).toBe(0);
    expect(out[0]).toContain("schon gespeichert: 2");
    expect(await reviews()).toEqual([]);
  });

  test("zwei gleichzeitige Läufe schlagen jedes Ziel nur einmal vor (Sperre am Vermerk)", async () => {
    let proposed = 0;
    const deps = {
      readReplies: async () => [{ id: 1, content: "[GOAL: Einmal fragen]", created_at: "2026-03-10T10:00:00.000Z" }],
      readStoredGoals: async () => [],
      file: ledger(),
      timeZone: ZONE,
      propose: async () => (proposed++, true),
    };
    const reports = await Promise.all([runGoalBackfill(deps), runGoalBackfill(deps)]);
    expect(proposed).toBe(1);
    expect(reports.map(r => r.offered).sort()).toEqual([0, 1]);
    expect(reports.map(r => r.offeredBefore).sort()).toEqual([0, 1]);
  });

  test("mit Telegram: Frage mit Knöpfen im Direktchat", async () => {
    await say("[GOAL: Antrag abgeben]");
    const { sent, options } = telegram({ sent: true, recorded: true, messageIds: [55] } as SendAndRecordResult);
    expect(await nachholen(options)).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("4711");
    expect(sent[0].text).toContain("Antrag abgeben");
    expect(sent[0].buttons?.flat().map(b => b.text)).toEqual(["Übernehmen", "Verwerfen"]);
  });

  test("nicht zugestellt: Exit-Code 1, kein Vermerk, nichts gespeichert, Wiederholung klappt", async () => {
    await say("[GOAL: Antrag abgeben]");
    const failing = telegram({ sent: false, recorded: false, error: { message: "kein Netz" } } as SendAndRecordResult);
    expect(await nachholen(failing.options)).toBe(1);
    expect(out[0]).toContain("nicht zugestellt: 1");
    expect(errs.join("\n")).toContain("gefahrlos wiederholt");
    expect(JSON.parse(readFileSync(join(root, "data", "pending-reviews.json"), "utf8"))).toEqual({});
    expect(await memoryRows()).toEqual([]);
    out = [];
    const working = telegram({ sent: true, recorded: true, messageIds: [55] } as SendAndRecordResult);
    expect(await nachholen(working.options)).toBe(0);
    expect(out[0]).toContain("jetzt vorgeschlagen: 1");
  });

  test("unlesbare Antworten: Exit-Code 1, nichts vorgeschlagen, kein Vermerk", async () => {
    await say("[GOAL: Antrag abgeben]");
    await pg.admin.unsafe("ALTER TABLE public.messages RENAME TO messages_weg");
    expect(await nachholen()).toBe(1);
    expect(errs.join("\n")).toContain("nichts vorgeschlagen");
    expect(await reviews()).toEqual([]);
    expect(existsSync(ledger())).toBe(false);
  });

  test("Ausgabe und Vermerk nennen keine Zieltexte", async () => {
    await say("[GOAL: Streng geheimes Ziel]");
    await nachholen();
    expect(out.join("\n")).not.toContain("geheimes");
    expect(readFileSync(ledger(), "utf8")).not.toContain("geheimes");
  });

  test("liest über mehrere Seiten alle Antworten", async () => {
    await pg.admin.unsafe(
      "INSERT INTO public.messages (chat_id, role, content) SELECT '4711', 'assistant', '[GOAL: Ziel ' || n || ']' FROM generate_series(1, 1203) AS n",
    );
    const replies = await readRepliesWithGoals(getSupabase()!);
    expect(replies).toHaveLength(1203);
    expect(new Set(replies.map(r => r.id)).size).toBe(1203);
  });

  test("ohne Supabase nichts zu tun, falscher Aufruf Exit-Code 2, Hilfe", async () => {
    const { SUPABASE_URL: _url, SUPABASE_SERVICE_ROLE_KEY: _key, ...rest } = process.env;
    expect(await nachholen({ env: rest })).toBe(0);
    expect(out[0]).toContain("nichts nachzuholen");
    expect(await runTybo({ args: ["gedaechtnis", "was"], env: process.env, root, out: () => {}, err: line => void errs.push(line) })).toBe(2);
    out = [];
    expect(await runTybo({ args: ["gedaechtnis", "help"], env: process.env, root, out: line => void out.push(line), err: () => {} })).toBe(0);
    expect(out[0]).toContain("ziele-nachholen");
  });
});
