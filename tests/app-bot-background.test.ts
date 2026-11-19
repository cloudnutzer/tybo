// Issue #344: Hintergrunddienste beim Start als Verhalten von startBackground
// (ersetzt die Quelltext-Prüfungen zu Embedding, Jobs, Routinen-Wache,
// Fäden-Erinnerungen und Ablauf der Rückfragen in bot.ts). Alle Zeitgeber
// und Dienste sind Attrappen.
import { describe, expect, test } from "bun:test";
import { startBackground, type BackgroundServices } from "../src/app/bot-start";
import { createBotNotices, type BotNotices } from "../src/lib/bot-notices";
import type { SendAndRecordInput, SendAndRecordResult } from "../src/lib/outbox";
import type { SchemaProbeResult } from "../src/lib/schema-probe";
import { DRAIN_INTERVAL_MS } from "../src/lib/embedding";
import type { AlertMeta } from "../src/lib/routines/alerts";
import { PROJECT_ROOT } from "../src/lib/env";
import type { CodexSkillLinksInput } from "../src/lib/engines/codex-skills";
import { readCodexUsage } from "../src/lib/engines/codex-usage";
import { recordUsage } from "../src/lib/engines/usage";

interface RoutineMenu {
  offerStatus?: "sent" | "none" | "unknown";
}

function setup(overrides: Partial<BackgroundServices> = {}, env: Record<string, string | undefined> = {}, menu: RoutineMenu = {}, notices?: BotNotices, pollJobReports?: () => Promise<void>) {
  const events: string[] = [];
  const plainAlerts: { text: string; meta: unknown }[] = [];
  const offers: { conversation: unknown; id: string; text: string }[] = [];
  let watchArgs: Parameters<BackgroundServices["startRoutineWatch"]>[0] | undefined;
  const timers: { ms: number; run: () => void }[] = [];
  const lines: string[] = [];
  let threadDeps: Parameters<BackgroundServices["startThreadReminders"]>[0] | undefined;
  const services: Partial<BackgroundServices> = {
    // Nie die echte Claude CLI (Issue #566)
    inspectClaude: async () => ({ engine: "claude", checked: true, installed: true, loggedIn: true }),
    checkCodex: async () => ({ engine: "codex", checked: true, installed: false, loggedIn: false }),
    installCodexSkillSync: () => {},
    installCodexUsageReader: () => {},
    syncCodexSkills: () => ({ linked: [], foreign: [], skipped: [] }),
    getSettings: () => ({}),
    checkEmbedding: async () => (events.push("checkEmbedding"), { ok: false, message: "Anbieter weicht ab" }) as never,
    drainEmbeddings: async () => (events.push("drain"), { state: "fertig", written: 2, rejected: 0 }) as never,
    syncChunks: async () => null,
    rotateLogs: async () => void events.push("rotate"),
    recoverJobs: async (root, e) => (events.push(`jobs ${root} ${e === env}`), { aborted: [], resent: [] }) as never,
    watchDeps: (root => (events.push(`watchDeps ${root}`), { marker: "watch-deps", send: async (text: string, meta: unknown) => (plainAlerts.push({ text, meta }), { sent: true, recorded: true }) })) as never,
    startRoutineWatch: (deps => ((watchArgs = deps), events.push("routineWatch"), { id: "watch" })) as never,
    startThreadReminders: (deps => ((threadDeps = deps), events.push("threadReminders"), { id: "threads" })) as never,
    startReminderPlanner: (() => (events.push("planner"), { id: "planner" })) as never,
    setSwitchNotifier: () => {},
    startSwitchWatch: () => () => {},
    installClaudeUsageMeasurement: () => () => {},
    startClaudeUsageWatch: () => () => {},
    webConversationExists: async id => (events.push(`exists ${id}`), false),
    topicDeleted: async () => false,
    every: (ms, run) => void timers.push({ ms, run }),
    log: line => void lines.push(line),
    warn: line => void lines.push(`WARN ${line}`),
    error: line => void lines.push(`ERROR ${line}`),
    ...overrides,
  };
  let sweeps = 0;
  const background = startBackground({
    root: "/srv/tybo",
    env,
    notices: notices ?? createBotNotices({ telegram: () => false, send: async () => ({ ok: true }) as never, sendStatusMessage: async () => {}, dmChatId: () => "" }),
    choices: { sweep: async () => (sweeps++, events.push("sweep"), [{ id: "x" }]) } as never,
    routineChoices: { offerMenu: async (conversation: unknown, id: string, text: string) => (offers.push({ conversation, id, text }), { status: menu.offerStatus ?? "none" }) } as never,
    postWeb: async () => false,
    refresh: async () => [],
    pollJobReports,
    services,
  });
  return { background, events, timers, lines, thread: () => threadDeps!, sweeps: () => sweeps, watch: () => watchArgs!, plainAlerts, offers };
}

const tick = () => new Promise(r => setTimeout(r, 5));

describe("startBackground", () => {
  test.each(["local", "server"])("Job-Rückgaben im Profil %s beim Start und im Minutenlauf", async profile => {
    let calls = 0;
    const s = setup({}, { TYBO_PROFILE: profile }, {}, undefined, async () => { calls++; });
    await s.background.firstSweep;
    expect(calls).toBe(1);
    s.timers[2].run();
    await tick();
    expect(calls).toBe(2);
  });
  test("Claude-Messung registrieren, Zeitgeber starten und beim Beenden beide entfernen", async () => {
    const events: string[] = [];
    const s = setup({
      installClaudeUsageMeasurement: () => { events.push("Quelle"); return () => { events.push("Quelle entfernt"); }; },
      startClaudeUsageWatch: () => { events.push("Zeitgeber"); return () => { events.push("Zeitgeber beendet"); }; },
    });
    await s.background.firstSweep;
    expect(events).toEqual(["Quelle", "Zeitgeber"]);
    s.background.stopSwitchNotices();
    expect(events).toEqual(["Quelle", "Zeitgeber", "Zeitgeber beendet", "Quelle entfernt"]);
  });
  test("Codex-Messung verdrahtet Sitzungsleser und gemeinsame Ablage beim Start", async () => {
    const installed: unknown[] = [];
    const s = setup({ installCodexUsageReader: (read, record) => { installed.push(read, record); } });
    await s.background.firstSweep;
    expect(installed).toEqual([readCodexUsage, recordUsage]);
  });

  test("Skill-Abgleich: installiert genügt, PROJECT_ROOT statt Dienstordner, Einstellung und Verdrahtung", async () => {
    for (const skills of [undefined, false, true]) {
      const inputs: CodexSkillLinksInput[] = [];
      const syncSkills: BackgroundServices["syncCodexSkills"] = input => (inputs.push(input), { linked: [], foreign: [], skipped: [] });
      let installed: unknown;
      setup({
        checkCodex: async () => ({ engine: "codex", checked: true, installed: true, loggedIn: false }),
        getSettings: () => ({ engine: { codex: { skills } } }),
        syncCodexSkills: syncSkills,
        installCodexSkillSync: sync => { installed = sync; },
      });
      await tick();
      expect(installed).toBe(syncSkills);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ root: PROJECT_ROOT, enabled: skills !== false });
      expect(inputs[0].root).not.toBe("/srv/tybo");
    }
  });

  test("Ohne Codex kein Skill-Abgleich; eine langsame Prüfung hält den Start nicht auf", async () => {
    let finish!: (value: Awaited<ReturnType<BackgroundServices["checkCodex"]>>) => void;
    let calls = 0;
    const s = setup({ checkCodex: () => new Promise(resolve => { finish = resolve; }),
      syncCodexSkills: () => (calls++, { linked: [], foreign: [], skipped: [] }),
    });
    await s.background.firstSweep;
    expect(s.events).toContain("sweep");
    expect(calls).toBe(0);
    finish({ engine: "codex", checked: true, installed: false, loggedIn: false });
    await tick();
    expect(calls).toBe(0);
  });

  test("Fehler der Codex-Prüfung oder des Abgleichs lassen den Start weiterlaufen, ohne Quellpfade im Log", async () => {
    for (const failCheck of [true, false]) {
      const s = setup({ checkCodex: async () => {
        if (failCheck) throw new Error("/privater/quellpfad");
        return { engine: "codex", checked: true, installed: true, loggedIn: true };
      }, syncCodexSkills: () => { throw new Error("/privater/quellpfad"); } });
      await s.background.firstSweep; await tick();
      expect(s.lines.filter(l => l.includes("[Codex]"))).toEqual(["ERROR [Codex] Skill-Abgleich beim Start fehlgeschlagen; Start läuft weiter."]);
    }
  });

  test("Motorwechsel verbindet den gemeinsamen Meldeweg auch ohne WebUI und trennt ihn beim Stoppen", async () => {
    const notices = createBotNotices({ telegram: () => false, send: async () => ({ ok: true }) as never, sendStatusMessage: async () => {}, dmChatId: () => "" });
    const connections: unknown[] = [];
    const s = setup({ setSwitchNotifier: deliver => { connections.push(deliver); },
      startSwitchWatch: () => { connections.push("watch"); return () => { connections.push("stop"); }; },
    }, { WEB_ENABLED: "false" }, {}, notices);
    await s.background.firstSweep;
    expect(connections).toEqual([notices.deliverToUser, "watch"]);
    s.background.stopSwitchNotices();
    expect(connections).toEqual([notices.deliverToUser, "watch", "stop", null]);
  });
  test("Reihenfolge: Embedding, Logs, Jobs, Routinen-Wache, Fäden, Erinnerungen, dann die erste Ablauf-Prüfung", async () => {
    const s = setup();
    await s.background.firstSweep;
    expect(s.events.slice(0, 9)).toEqual(["checkEmbedding", "drain", "rotate", "jobs /srv/tybo true", "watchDeps /srv/tybo", "routineWatch", "threadReminders", "planner", "sweep"]);
    expect(s.background.routineWatch).toEqual({ id: "watch" } as never);
    expect(s.background.threadReminders).toEqual({ id: "threads" } as never);
    expect(s.background.reminderPlanner).toEqual({ id: "planner" } as never);
  });

  test("Abweichung des Embedding-Anbieters als Warnung, nachgezogene Einträge im Log", async () => {
    const s = setup();
    await tick();
    expect(s.lines).toContain("WARN [embedding] ACHTUNG: Anbieter weicht ab");
    expect(s.lines).toContain("[embedding] 2 vorgemerkte Einträge nachgezogen, 0 abgelehnt");
    expect(s.lines).toContain("[choices] 1 Rückfragen abgelaufen");
  });

  test("Abschnitte langer Nachrichten (Issue #479): nach dem Nachziehen, beim Start und mit jedem Embedding-Nachzug", async () => {
    const order: string[] = [];
    const s = setup({
      drainEmbeddings: async () => (order.push("drain"), { state: "fertig", written: 0, rejected: 0 }) as never,
      syncChunks: async () => (order.push("chunks"), { state: "fertig", messages: 2, chunks: 7, failed: 1 }),
    });
    await tick();
    expect(order).toEqual(["drain", "chunks"]);
    expect(s.lines).toContain("[embedding] Abschnitte für 2 lange Nachrichten nachgezogen (7 Abschnitte), 1 gescheitert");
    s.timers.find(t => t.ms === DRAIN_INTERVAL_MS)!.run();
    await tick();
    expect(order).toEqual(["drain", "chunks", "drain", "chunks"]);
  });

  test("Abschnitte: auch nach gescheitertem Nachziehen; still ohne Arbeit, ohne Migration und bei Fehler", async () => {
    let calls = 0;
    const s = setup({
      drainEmbeddings: async () => {
        throw new Error("weg");
      },
      syncChunks: async () => (calls++, { state: "fertig", messages: 0, chunks: 0, failed: 0 }),
    });
    await tick();
    expect(calls).toBe(1);
    for (const result of [{ state: "fehlt" as const }, null]) {
      const quiet = setup({ syncChunks: async () => result });
      await tick();
      expect(quiet.lines.some(l => l.includes("Abschnitte"))).toBe(false);
    }
    const failing = setup({
      syncChunks: async () => {
        throw new Error("kaputt");
      },
    });
    await tick();
    expect(failing.lines.some(l => l.includes("Abschnitte"))).toBe(false);
    expect(s.lines.some(l => l.includes("Abschnitte"))).toBe(false);
  });

  test("regelmäßig: Embedding-Nachzug, Log-Rotation stündlich, Rückfragen jede Minute", async () => {
    const s = setup();
    expect(s.timers.map(t => t.ms)).toEqual([DRAIN_INTERVAL_MS, 3_600_000, 60_000, 60_000]);
    s.timers[3].run();
    await tick();
    expect(s.sweeps()).toBe(2);
  });

  test("Fäden: Telegram aus der Umgebung, gelöschte Web-Gespräche über die Gesprächsliste", async () => {
    const s = setup({}, { TELEGRAM_BOT_TOKEN: "1:a", TELEGRAM_USER_ID: "1" });
    const deps = s.thread();
    expect(deps.telegram()).toBe(true);
    expect(setup().thread().telegram()).toBe(false);
    const gone = await deps.conversationGone({ type: "web", conversationId: "11111111-2222-4333-8444-555555555555" } as never);
    expect(s.events).toContain("exists 11111111-2222-4333-8444-555555555555");
    expect(gone).toBe(true);
  });

  test("Fehler beim Aufräumen der Jobs landen nur im Log", async () => {
    const s = setup({ recoverJobs: async () => { throw new TypeError("weg"); } });
    await tick();
    expect(s.lines).toContain("ERROR [job] Wiederherstellung gescheitert (TypeError)");
  });

  test("Job-Fristen werden jede Minute geprüft, auch wenn ein Versandversuch noch wartet", async () => {
    let runs = 0;
    const finishes: (() => void)[] = [];
    const s = setup({ recoverJobs: async () => {
      runs++;
      await new Promise<void>(resolve => { finishes.push(resolve); });
      return { aborted: [], resent: [] };
    } });
    const timer = s.timers[2];
    expect(timer.ms).toBe(60_000);
    timer.run(); timer.run();
    expect(runs).toBe(3);
    finishes.forEach(finish => finish());
    await tick();
  });
});

describe("startBackground: Versandweg der Routinen-Wache ausgelöst", () => {
  const TELEGRAM_ENV = { TELEGRAM_BOT_TOKEN: "1:a", TELEGRAM_USER_ID: "4242" };
  const missed: AlertMeta = { kind: "missed", id: "ai.tybo.wetter" };

  test("übrige Angaben der Wache unverändert weitergereicht", () => {
    const s = setup();
    expect((s.watch() as unknown as { marker: string }).marker).toBe("watch-deps");
  });

  test("ausgebliebener Lauf mit Telegram: Menü im Direktchat, keine Meldung ohne Knöpfe", async () => {
    const s = setup({}, TELEGRAM_ENV, { offerStatus: "sent" });
    const result = await s.watch().send("Wetter ist ausgeblieben", missed);
    expect(result).toEqual({ sent: true, recorded: true });
    expect(s.offers).toEqual([{ conversation: { type: "telegram", chatId: "4242" }, id: "ai.tybo.wetter", text: "Wetter ist ausgeblieben" }]);
    expect(s.plainAlerts).toEqual([]);
  });

  test("ohne Telegram: Menü für den Web-Direktchat", async () => {
    const s = setup({}, {}, { offerStatus: "sent" });
    await s.watch().send("Wetter ist fehlgeschlagen", { kind: "failed", id: "ai.tybo.wetter" });
    expect(s.offers).toEqual([{ conversation: { type: "telegram", chatId: "web" }, id: "ai.tybo.wetter", text: "Wetter ist fehlgeschlagen" }]);
    expect(s.plainAlerts).toEqual([]);
  });

  test("Menü nicht gezeigt: Meldung über den einfachen Versand der Wache; andere Meldungen gleich dorthin", async () => {
    const s = setup({}, TELEGRAM_ENV, { offerStatus: "none" });
    await s.watch().send("Wetter ist ausgeblieben", missed);
    expect(s.offers).toHaveLength(1);
    expect(s.plainAlerts).toEqual([{ text: "Wetter ist ausgeblieben", meta: missed }]);

    await s.watch().send("Wetter läuft wieder", { kind: "recovered", id: "ai.tybo.wetter" });
    expect(s.offers).toHaveLength(1);
    expect(s.plainAlerts).toHaveLength(2);
  });
});

// Issue #560: Schemaprobe beim Start, genau eine Meldung über den Meldeweg (Outbox)
describe("startBackground: fehlende Migrationen", () => {
  const SUPABASE = { SUPABASE_URL: "https://beispiel.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_attrappe" };

  function withProbe(result: SchemaProbeResult | null, options: { telegram?: boolean; record?: SendAndRecordResult } = {}) {
    const sent: SendAndRecordInput[] = [];
    const direct: string[] = [];
    const probed: unknown[] = [];
    const notices = createBotNotices({
      telegram: () => options.telegram ?? false,
      send: async input => (sent.push(input), options.record ?? (options.telegram ? { sent: true, recorded: true } : { sent: false, recorded: true })),
      sendStatusMessage: async (_chat, text) => void direct.push(text),
      dmChatId: () => (options.telegram ? "4242" : ""),
    });
    const s = setup({ probeSchema: async env => (probed.push(env), result) }, SUPABASE, {}, notices);
    return { ...s, sent, direct, probed };
  }

  test("mehrere fehlende Dateien ergeben genau eine Meldung, ohne Telegram für die WebUI festgehalten", async () => {
    const s = withProbe({ state: "missing", missing: ["db/migrations/20261018_scheduled_tasks_lease.sql", "db/migrations/20261031_memory_archive.sql"], unchecked: [] });
    await tick();
    expect(s.probed).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].text).toContain("20261018_scheduled_tasks_lease.sql");
    expect(s.sent[0].text).toContain("20261031_memory_archive.sql");
    expect(s.sent[0].text).toContain("tybo setup datenbank");
    expect(s.sent[0].source).toBe("system");
    expect(s.sent[0].chatId).toBe("web");
    expect(s.lines.filter(l => l.startsWith("WARN [schema] ACHTUNG"))).toHaveLength(1);
    expect(s.lines.some(l => l.includes("nicht zugestellt"))).toBe(false);
    // Kein Zeitgeber wiederholt die Probe
    for (const t of s.timers) t.run();
    await tick();
    expect(s.probed).toHaveLength(1);
    expect(s.sent.filter(i => i.text?.includes("Migration"))).toHaveLength(1);
  });

  test("mit Telegram: eine Meldung an den Direktchat (die Outbox hält sie auch für die WebUI fest)", async () => {
    const s = withProbe({ state: "missing", missing: ["db/migrations/20261031_memory_facts_search.sql"], unchecked: [] }, { telegram: true });
    await tick();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].text).toContain("eine Migration");
    expect(s.direct).toEqual([]);
  });

  test("vollständiges Schema: keine Meldung, nur eine Logzeile", async () => {
    const s = withProbe({ state: "ok" });
    await tick();
    expect(s.sent).toEqual([]);
    expect(s.lines).toContain("[schema] alle Migrationen eingespielt");
  });

  test("nicht prüfbar: keine Meldung, Warnung im Log", async () => {
    const s = withProbe({ state: "unknown", reason: "Datenbank nicht erreichbar", unchecked: [] });
    await tick();
    expect(s.sent).toEqual([]);
    expect(s.lines).toContain("WARN [schema] nicht prüfbar: Datenbank nicht erreichbar");
  });

  test("ohne Telegram und mit gescheitertem Festhalten: Rückfall ist das Log, ohne Wiederholung", async () => {
    const s = withProbe({ state: "missing", missing: ["db/schema.sql"], unchecked: [] }, { record: { sent: false, recorded: false, error: { kind: "record", message: "messages fehlt" } } });
    await tick();
    expect(s.sent).toHaveLength(1);
    expect(s.lines.filter(l => l.startsWith("WARN [schema] ACHTUNG"))).toHaveLength(1);
    expect(s.lines).toContain("WARN [schema] Meldung an den Nutzer nicht zugestellt, der Hinweis steht nur hier im Log");
  });

  test("ohne Supabase fragt die echte Probe nichts", async () => {
    const { BACKGROUND_SERVICES } = await import("../src/app/bot-start");
    expect(await BACKGROUND_SERVICES.probeSchema({})).toBeNull();
    expect(await BACKGROUND_SERVICES.probeSchema({ SUPABASE_URL: "https://x.supabase.co" })).toBeNull();
  });
});
