/**
 * Issue #518: Ziele gegen das echte db/schema.sql. Der echte supabase-js-Client
 * und der echte Gedächtnis-Dienst laufen über postgrestFetch (tests/pg-harness.ts)
 * gegen echtes PostgreSQL; keine nachgebaute Tabelle. Alle Daten sind erfunden.
 *
 * Geprüft wird jeder Weg: anlegen (/track, [GOAL:], Übernahme eines
 * Vorschlags), /goals, [DONE:], [CANCEL:], Briefing und Check-in, dazu die
 * Fehlerfälle: eine Datenbank, die wirklich scheitert, nicht ein false aus
 * einer Attrappe.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN; ohne beide übersprungen, in der CI
 * ein Fehler (wie tests/schema-basis-pg.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "bun";
import { commandRegistry } from "../src/lib/commands/builtin";
import { MEMORY_COMMAND_TEXT } from "../src/lib/commands/memory";
import { decideReview, describeApplied, gateTurnIntents } from "../src/lib/intent-gate";
import * as memoryService from "../src/lib/memory";
import { createMemoryChoices } from "../src/lib/memory/choices";
import type { SendAndRecordInput } from "../src/lib/outbox";
import { goalsSource } from "../src/lib/sources/goals";
import { runSource } from "../src/lib/sources/run";
import { getStore, resetStore } from "../src/lib/store";
import { fileMemory, memoryFilePath } from "../src/lib/store/file/memory";
import { readOpenGoals } from "../src/lib/store/supabase/memory";
import { getSupabase, resetSupabaseClient } from "../src/lib/supabase";
import { createBotCommands } from "../src/web/bot-commands";
import { setPendingReviewsFileForTests, stageMemoryReview, setReviewNotifier } from "../src/lib/session-distill";
import { pgAvailable, respondViaPg, startPg, type PgServer } from "./pg-harness";
import { FAKE_SUPABASE_URL, useFakeSupabase } from "./supabase-fixture";

const available = pgAvailable();

if (!available.ok && process.env.CI) {
  test("PostgreSQL für die Ziel-Tests ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

const {
  addGoal,
  cancelGoal,
  completeGoal,
  applyToEntry,
  listGoals,
  openGoals,
  processIntents,
  reportMemoryFailures,
  setMemoryFailureNotice,
} = memoryService;

describe.skipIf(!available.ok)("Ziele gegen das echte Schema", () => {
  let pg: PgServer;
  let service: SQL;
  let fake: ReturnType<typeof useFakeSupabase>;
  let dir: string;
  const spies: { mockRestore(): void }[] = [];
  let logged: string[] = [];

  beforeAll(async () => {
    pg = await startPg();
    await pg.applySchema();
    // Wie der Bot: mit dem Service-Role-Key, also dieser Rolle
    service = await pg.connect("service_role");
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(async () => {
    await pg.admin.unsafe("TRUNCATE public.memory RESTART IDENTITY");
    dir = mkdtempSync(join(tmpdir(), "tybo-ziele-"));
    setPendingReviewsFileForTests(join(dir, "pending-reviews.json"));
    fake = useFakeSupabase({ respond: respondViaPg(service, FAKE_SUPABASE_URL) });
    logged = [];
    const keep = (...parts: unknown[]) => void logged.push(parts.map(String).join(" "));
    spies.push(spyOn(console, "log").mockImplementation(keep), spyOn(console, "warn").mockImplementation(keep), spyOn(console, "error").mockImplementation(keep));
  });

  afterEach(async () => {
    while (spies.length) spies.pop()!.mockRestore();
    setMemoryFailureNotice(null);
    setReviewNotifier(null);
    setPendingReviewsFileForTests(null);
    fake.restore();
    resetStore();
    resetSupabaseClient();
    rmSync(dir, { recursive: true, force: true });
    await pg.admin.unsafe("ALTER TABLE IF EXISTS public.memory_weg RENAME TO memory");
  });

  /** Echte Störung: die Tabelle ist weg, jede Abfrage scheitert in PostgreSQL */
  const breakTable = () => pg.admin.unsafe("ALTER TABLE public.memory RENAME TO memory_weg");
  const rows = () => pg.admin.unsafe("SELECT id, type, content, deadline, completed_at FROM public.memory ORDER BY id") as unknown as Promise<
    { id: string; type: string; content: string; deadline: Date | null; completed_at: Date | null }[]
  >;
  const seedGoal = (content: string, type = "goal") => pg.admin.unsafe("INSERT INTO public.memory (type, content) VALUES ($1, $2)", [type, content]);

  /** Befehl über die gemeinsame Befehls-Schicht, Dienste wie in src/app/command-services.ts */
  async function command(text: string): Promise<string[]> {
    const replies: string[] = [];
    const unused = () => {
      throw new Error("nicht erwartet");
    };
    const commands = createBotCommands({
      registry: commandRegistry,
      services: { listGoals, memory: { addGoal, completeGoal, cancelGoal } } as never,
      userId: "web",
      groupId: () => null,
      agentForTopic: () => "research",
      sendPlain: async () => {},
      sendAndRecord: async input => {
        replies.push(input.text ?? "");
        return { sent: false, recorded: true };
      },
      saveMessage: async () => true,
      resetConversation: unused,
      runStreamingTurn: unused,
      processIntents: unused,
      sendAsAgent: unused,
      log: () => {},
    } as never);
    await commands.run({
      conversationId: "dm",
      agent: "general",
      text,
      source: "web",
      messageId: "m1",
      receivedAt: new Date().toISOString(),
      signal: new AbortController().signal,
      sink: {} as never,
      notice: async (answer: string) => void replies.push(answer),
      answer: async () => {},
      ask: async () => {},
      endAsk: () => {},
      commit: () => {},
    } as never);
    return replies;
  }

  test("das Schema kennt keine Spalte completed, offen und erledigt stehen in type", async () => {
    const columns = await pg.admin.unsafe("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'memory'");
    const names = columns.map((c: { column_name: string }) => c.column_name);
    expect(names).not.toContain("completed");
    expect(names).toContain("completed_at");
  });

  test("anlegen mit und ohne Frist, lesen über alle Lesewege", async () => {
    const memory = getStore().memory;
    expect(await memory.addGoal("Fahrrad reparieren")).toBe(true);
    expect(await memory.addGoal("Steuer abgeben", new Date("2030-11-30T12:00:00.000Z"))).toBe(true);
    const stored = await rows();
    expect(stored.map(r => [r.type, r.content])).toEqual([
      ["goal", "Fahrrad reparieren"],
      ["goal", "Steuer abgeben"],
    ]);
    expect(stored[1].deadline?.toISOString()).toBe("2030-11-30T12:00:00.000Z");
    expect((await memory.activeGoals()).map(g => g.content)).toEqual(["Fahrrad reparieren", "Steuer abgeben"]);
    expect((await readOpenGoals(getSupabase)).map(g => g.content)).toEqual(["Fahrrad reparieren", "Steuer abgeben"]);
    expect((await memory.matchingGoals("RAD", 5)).map(g => g.content)).toEqual(["Fahrrad reparieren"]);
    expect((await memory.changedSince(new Date(0))).map(g => g.content)).toEqual(["Fahrrad reparieren", "Steuer abgeben"]);
  });

  test("/goals zeigt die offenen Ziele, ohne erledigte", async () => {
    await seedGoal("Keller aufräumen");
    await seedGoal("Altes Ziel", "completed_goal");
    const [reply] = await command("/goals");
    expect(reply).toContain("1. Keller aufräumen");
    expect(reply).not.toContain("Altes Ziel");
  });

  test("/track legt an, /done erledigt, /cancel streicht", async () => {
    expect(await command("/track Garten umgraben")).toEqual([MEMORY_COMMAND_TEXT.tracked("Garten umgraben")]);
    expect(await command("/track Zaun streichen")).toEqual([MEMORY_COMMAND_TEXT.tracked("Zaun streichen")]);
    expect(await command("/done Garten")).toEqual([MEMORY_COMMAND_TEXT.completed]);
    expect(await command("/done Garten")).toEqual([MEMORY_COMMAND_TEXT.noGoal("Garten")]);
    expect(await command("/cancel Zaun")).toEqual([MEMORY_COMMAND_TEXT.cancelled]);
    expect(await command("/cancel Zaun")).toEqual([MEMORY_COMMAND_TEXT.noGoal("Zaun")]);
    const stored = await rows();
    expect(stored.map(r => [r.type, r.content])).toEqual([["completed_goal", "Garten umgraben"]]);
    expect(stored[0].completed_at).toBeInstanceOf(Date);
  });

  test("[GOAL:] in einer Antwort legt an, [DONE:] setzt completed_goal samt Zeitpunkt", async () => {
    const added = await processIntents("Mache ich. [GOAL: Bericht schreiben | DEADLINE: 2030-01-15T10:00:00Z]");
    expect(added.goalsAdded).toEqual(["Bericht schreiben"]);
    expect(added.goalsFailed).toBeUndefined();
    const done = await processIntents("Fertig! [DONE: Bericht schreiben]");
    expect(done.goalsCompleted).toEqual(["Bericht schreiben"]);
    const [row] = await rows();
    expect(row.type).toBe("completed_goal");
    expect(row.completed_at).toBeInstanceOf(Date);
    expect(await listGoals()).toBe("No active goals.");
  });

  test("[CANCEL:] löscht nur offene Ziele, erledigte und Fakten bleiben", async () => {
    await seedGoal("Reise buchen", "completed_goal");
    await seedGoal("Reise planen");
    await pg.admin.unsafe("INSERT INTO public.memory (type, content) VALUES ('fact', 'Reise ist teuer')");
    const result = await processIntents("[CANCEL: Reise planen]");
    expect(result.goalsCancelled).toEqual(["Reise planen"]);
    expect((await rows()).map(r => r.content)).toEqual(["Reise buchen", "Reise ist teuer"]);
    expect((await processIntents("[CANCEL: Reise buchen]")).goalsCancelled).toEqual([]);
    expect((await rows()).map(r => r.content)).toEqual(["Reise buchen", "Reise ist teuer"]);
  });

  test("ById-Wege prüfen die getroffene Zeile, auch bei konkurrierenden Aufrufen", async () => {
    await seedGoal("Dach prüfen");
    await seedGoal("Dach decken");
    const [first, second] = await rows();
    const races = await Promise.all([1, 2, 3, 4].map(() => getStore().memory.completeGoalById(String(first.id))));
    expect(races.filter(Boolean)).toHaveLength(1);
    expect(await applyToEntry("cancel", String(first.id))).toBe(false);
    const cancels = await Promise.all([1, 2, 3].map(() => getStore().memory.cancelGoalById(String(second.id))));
    expect(cancels.filter(Boolean)).toHaveLength(1);
    expect((await rows()).map(r => [r.type, r.content])).toEqual([["completed_goal", "Dach prüfen"]]);
    expect(await getStore().memory.completeGoalById("999999")).toBe(false);
  });

  test("Sonderzeichen im Suchtext gelten wörtlich", async () => {
    await seedGoal("Quote 100% erreichen");
    await seedGoal("Quote 1000 erreichen");
    expect(await getStore().memory.completeGoal("0%")).toBe(true);
    expect((await rows()).map(r => [r.type, r.content])).toEqual([
      ["completed_goal", "Quote 100% erreichen"],
      ["goal", "Quote 1000 erreichen"],
    ]);
  });

  test("Briefing und Check-in lesen die offenen Ziele", async () => {
    await seedGoal("Offenes Ziel");
    await seedGoal("Erledigtes Ziel", "completed_goal");
    const context = { env: {}, now: new Date("2030-01-01T08:00:00.000Z") };
    const briefing = await runSource(goalsSource(), context);
    expect(briefing.status).toBe("ok");
    expect(briefing.status === "ok" && briefing.section.items.map(i => i.text)).toEqual(["Offenes Ziel"]);
    const checkin = await runSource(goalsSource(() => openGoals({ localFallback: false })), context);
    expect(checkin.status).toBe("ok");
    expect(checkin.status === "ok" && checkin.section.items.map(i => i.text)).toEqual(["Offenes Ziel"]);
  });

  test("Übernahme eines Vorschlags legt das Ziel an, Verwerfen und zweiter Klick nicht", async () => {
    const tags = "[GOAL: Vorschlag annehmen]";
    const id = (await stageMemoryReview({ chatId: "web", tags, header: "Vorschlag" }))!;
    const applied = await decideReview("ok", id);
    expect(applied.kind).toBe("applied");
    expect(applied.kind === "applied" && applied.text).toContain("1 Ziel(e)");
    expect((await decideReview("ok", id)).kind).toBe("expired");
    const other = (await stageMemoryReview({ chatId: "web", tags: "[GOAL: Vorschlag ablehnen]", header: "Vorschlag" }))!;
    expect((await decideReview("no", other)).kind).toBe("discarded");
    expect((await rows()).map(r => r.content)).toEqual(["Vorschlag annehmen"]);
  });

  describe("wenn die Datenbank scheitert", () => {
    test("Anlegen über [GOAL:]: kein Abbruch, Ziel als gescheitert gemeldet, Log ohne Zieltext", async () => {
      await breakTable();
      const result = await processIntents("[GOAL: Geheimer Zieltext] [REMEMBER: bleibt versucht]");
      expect(result.goalsAdded).toEqual([]);
      expect(result.goalsFailed).toEqual(["Geheimer Zieltext"]);
      expect(logged.some(line => line.includes("[Gedächtnis]") && line.includes("Ziel anlegen"))).toBe(true);
      expect(logged.join("\n")).not.toContain("Geheimer Zieltext");
    });

    test("der Nutzer erfährt es im Gespräch des Turns", async () => {
      await breakTable();
      const notices: { where: unknown; text: string }[] = [];
      setMemoryFailureNotice(async (where, text) => void notices.push({ where, text }));
      const where = { conversation: { type: "telegram" as const, chatId: "1234" } };
      const result = await processIntents("[GOAL: Sprachkurs buchen]", where);
      await reportMemoryFailures(result, where);
      expect(notices).toHaveLength(1);
      expect(notices[0].where).toEqual(where);
      expect(notices[0].text).toContain("Sprachkurs buchen");
      expect(notices[0].text).toContain("nicht gespeichert");
    });

    test("über das Tor, wie jeder Turn: Telegram-Topic, Web-Gespräch, ohne Telegram", async () => {
      await breakTable();
      const records: SendAndRecordInput[] = [];
      const posts: { conversationId: string; text: string }[] = [];
      const choices = createMemoryChoices({
        sendAndRecord: async input => (records.push(input), { sent: true, recorded: true }),
        postWeb: async (conversationId, post) => (posts.push({ conversationId, text: post.text }), true),
        dmChatId: () => "4711",
      });
      setMemoryFailureNotice(choices.failureNotice);
      const tags = "[GOAL: Sprachkurs buchen]";
      const gate = { dmChatId: () => "4711", log: () => {} };
      const webId = "0c1a2b3c-0000-4000-8000-000000000333";

      const topic = await gateTurnIntents(tags, { uses: [] }, { chatId: "-100123", topicId: 7, origin: "Telegram" }, gate);
      expect(topic.outcome).toBe("applied");
      expect(topic.processed?.goalsFailed).toEqual(["Sprachkurs buchen"]);
      expect(records.at(-1)).toMatchObject({ chatId: "-100123", topicId: 7, source: "gedaechtnis" });
      expect(records.at(-1)?.text).toContain("nicht gespeichert");

      await gateTurnIntents(tags, { uses: [] }, { chatId: `web:${webId}`, origin: "Web-Gespräch" }, gate);
      expect(posts.at(-1)?.conversationId).toBe(webId);
      expect(records.at(-1)?.chatId).toBe("4711");

      records.length = 0;
      await gateTurnIntents(tags, { uses: [] }, { chatId: "-100123", origin: "Telefonhörer", noTelegram: { conversationId: webId } }, gate);
      expect(records).toEqual([]);
      expect(posts.at(-1)?.conversationId).toBe(webId);
    });

    test("Vorschlag aus fremden Inhalten: nichts gescheitert, nichts gemeldet", async () => {
      await breakTable();
      const notices: string[] = [];
      setMemoryFailureNotice(async (_where, text) => void notices.push(text));
      const outcome = await gateTurnIntents("[GOAL: Sprachkurs buchen]", undefined, { chatId: "4711", origin: "Telegram", foreignInput: "Datei" }, { dmChatId: () => "4711", log: () => {} });
      expect(outcome.outcome).toBe("staged");
      expect(notices).toEqual([]);
    });

    test("eine scheiternde Meldung wirft nicht in den Turn", async () => {
      await breakTable();
      setMemoryFailureNotice(async () => {
        throw new Error("kein Versand");
      });
      const where = { conversation: { type: "telegram" as const, chatId: "1234" } };
      await reportMemoryFailures(await processIntents("[GOAL: Sprachkurs buchen]", where), where);
      expect(logged.some(line => line.includes("nicht zugestellt"))).toBe(true);
      expect(logged.join("\n")).not.toContain("Sprachkurs buchen");
    });

    test("/track, /done und /cancel melden den Fehler, nicht „kein Treffer“", async () => {
      await breakTable();
      expect(await command("/track Sprachkurs buchen")).toEqual([MEMORY_COMMAND_TEXT.failed]);
      expect(await command("/done Sprachkurs")).toEqual([MEMORY_COMMAND_TEXT.failed]);
      expect(await command("/cancel Sprachkurs")).toEqual([MEMORY_COMMAND_TEXT.failed]);
    });

    test("/goals sagt, dass nichts lesbar war, nicht „keine Ziele“", async () => {
      await breakTable();
      const [reply] = await command("/goals");
      expect(reply).toBe(MEMORY_COMMAND_TEXT.goalsUnreadable);
    });

    test("[DONE:] und [CANCEL:]: nichts geändert, gescheitert statt „kein Treffer“", async () => {
      await breakTable();
      const result = await processIntents("[DONE: Sprachkurs buchen] [CANCEL: Sprachkurs buchen]");
      expect(result.goalsCompleted).toEqual([]);
      expect(result.goalsCancelled).toEqual([]);
      expect(result.goalChangesFailed).toEqual(["Sprachkurs buchen", "Sprachkurs buchen"]);
    });

    test("Übernahme eines Vorschlags nennt das nicht gespeicherte Ziel", async () => {
      const id = (await stageMemoryReview({ chatId: "web", tags: "[GOAL: Sprachkurs buchen]", header: "Vorschlag" }))!;
      await breakTable();
      const decision = await decideReview("ok", id);
      expect(decision.kind === "applied" && decision.text).toContain("Sprachkurs buchen");
      expect(decision.kind === "applied" && decision.text).toContain("nicht gespeichert");
      expect(decision.kind === "applied" && decision.text).not.toContain("✅");
    });

    test("describeApplied: gespeicherte Teile bleiben genannt", () => {
      const text = describeApplied({ goalsAdded: [], goalsCompleted: [], goalsCancelled: [], factsAdded: ["a"], factsRemoved: [], goalsFailed: ["Sprachkurs buchen"] });
      expect(text).toContain("1 Fakt(en)");
      expect(text).toContain("Sprachkurs buchen");
    });

    test("Lesen für den Prompt bleibt leer statt zu werfen, steht aber im Log", async () => {
      await breakTable();
      expect(await getStore().memory.activeGoals()).toEqual([]);
      expect(logged.some(line => line.includes("[Gedächtnis]") && line.includes("Ziele lesen"))).toBe(true);
    });

    test("Check-in scheitert sichtbar, Log ohne ungefilterte Datenbankdetails", async () => {
      await breakTable();
      const checkin = await runSource(goalsSource(() => openGoals({ localFallback: false })), { env: {}, now: new Date("2030-01-01T08:00:00.000Z") });
      expect(checkin.status).not.toBe("ok");
      await expect(readOpenGoals(getSupabase)).rejects.toThrow(/42P01/);
      await expect(readOpenGoals(getSupabase)).rejects.not.toThrow(/memory_weg|relation/);
    });

    test("Briefing fällt auf die lokale Ablage zurück, ohne sie scheitert es", async () => {
      await breakTable();
      const context = { env: {}, now: new Date("2030-01-01T08:00:00.000Z") };
      const file = memoryFilePath();
      for (const path of [file, `${file}.sqlite`]) rmSync(path, { force: true });
      expect((await runSource(goalsSource(), context)).status).toBe("failed");
      await fileMemory(() => file).addGoal("Lokales Ziel");
      const local = await runSource(goalsSource(), context);
      expect(local.status === "ok" && local.section.items.map(i => i.text)).toEqual(["Lokales Ziel"]);
      for (const path of [file, `${file}.sqlite`]) rmSync(path, { force: true });
    });
  });
});
