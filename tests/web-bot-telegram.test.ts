import { describe, expect, test } from "bun:test";
import type { HistoryOptions, HistoryRow, TopicActivity } from "../src/lib/supabase";
import {
  ACTIVITY_SINCE_DAYS,
  DM_TITLE,
  createTelegramSource,
  resolveGroupId,
  toTelegramApiMessage,
  type BotTelegramDeps,
} from "../src/web/bot-telegram";
import { TELEGRAM_HISTORY_LIMIT, parseBeforeCursor } from "../src/web/telegram";

const GROUP = "-1001234567890";
const USER = "4711";

interface Fake {
  deps: BotTelegramDeps;
  historyCalls: [string, number | null, HistoryOptions][];
  activityCalls: [string, number][];
  logs: string[];
}

function fake(overrides: Partial<BotTelegramDeps> & { rows?: HistoryRow[]; activity?: Record<string, TopicActivity[]> } = {}): Fake {
  const historyCalls: Fake["historyCalls"] = [];
  const activityCalls: Fake["activityCalls"] = [];
  const logs: string[] = [];
  const { rows = [], activity = {}, ...rest } = overrides;
  const deps: BotTelegramDeps = {
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ "1": "General", "8": "Recherche", "443": "Finanzen", "529": "Ausgaben" }),
    topicMapping: () => ({ "8": "research", "443": "finance", "700": "cto" }),
    history: async (chatId, topicId, options) => {
      historyCalls.push([chatId, topicId, options]);
      return rows;
    },
    activity: async (chatId, sinceDays) => {
      activityCalls.push([chatId, sinceDays]);
      return activity[chatId] ?? [];
    },
    log: m => logs.push(m),
    ...rest,
  };
  return { deps, historyCalls, activityCalls, logs };
}

function row(n: number, role: string, content: string, metadata: Record<string, unknown> | null = {}): HistoryRow {
  return { id: `uuid-${n}`, created_at: `2026-09-23T10:${String(n).padStart(2, "0")}:00+00:00`, role, content, metadata };
}

describe("resolveGroupId", () => {
  test("TELEGRAM_GROUP_ID hat Vorrang", () => {
    expect(resolveGroupId({ TELEGRAM_GROUP_ID: "-100999" }, [GROUP])).toBe("-100999");
  });
  test("sonst der erste Schlüssel aus topics.json, der mit - beginnt", () => {
    expect(resolveGroupId({}, ["*", "12345", GROUP, "-100888"])).toBe(GROUP);
  });
  test("ungültiger Umgebungswert wird ignoriert", () => {
    expect(resolveGroupId({ TELEGRAM_GROUP_ID: "abc" }, [GROUP])).toBe(GROUP);
  });
  test("keine Gruppe: null", () => {
    expect(resolveGroupId({}, ["*", "12345"])).toBeNull();
    expect(resolveGroupId({}, [])).toBeNull();
  });
});

describe("listConversations", () => {
  test("Bestand aus Namen, Zuordnung und Aktivität; sortiert nach Aktivität, dann Name", async () => {
    const f = fake({
      activity: {
        [GROUP]: [
          { sessionKey: `topic:${GROUP}:443`, lastActivity: "2026-09-23T11:00:00+00:00" },
          { sessionKey: `group:${GROUP}`, lastActivity: "2026-09-23T10:00:00+00:00" },
          { sessionKey: `topic:${GROUP}:900`, lastActivity: "2026-09-22T09:00:00+00:00" },
          { sessionKey: `topic:${GROUP}:443`, lastActivity: "2026-09-20T09:00:00+00:00" },
          { sessionKey: `topic:-100555:3`, lastActivity: "2026-09-23T12:00:00+00:00" },
        ],
        [USER]: [{ sessionKey: `dm:${USER}`, lastActivity: "2026-09-23T09:30:00Z" }],
      },
    });
    const list = await createTelegramSource(f.deps).listConversations();
    expect(list.dm).toEqual({ id: "dm", title: DM_TITLE, agent: "general", lastActivity: "2026-09-23T09:30:00.000Z" });
    expect(list.topics).toEqual([
      { id: "topic-443", title: "Finanzen", agent: "finance", lastActivity: "2026-09-23T11:00:00.000Z" },
      { id: "topic-1", title: "General", agent: "general", lastActivity: "2026-09-23T10:00:00.000Z" },
      { id: "topic-900", title: "Topic 900", agent: "general", lastActivity: "2026-09-22T09:00:00.000Z" },
      // ohne Aktivität: nach Name
      { id: "topic-529", title: "Ausgaben", agent: "general", lastActivity: null },
      { id: "topic-8", title: "Recherche", agent: "research", lastActivity: null },
      { id: "topic-700", title: "Topic 700", agent: "cto", lastActivity: null },
    ]);
    expect(f.activityCalls).toEqual([
      [GROUP, ACTIVITY_SINCE_DAYS],
      [USER, ACTIVITY_SINCE_DAYS],
    ]);
  });

  test("Mikrosekunden innerhalb derselben Millisekunde bestimmen die Reihenfolge", async () => {
    const f = fake({
      topicNames: async () => ({ "8": "Recherche", "443": "Finanzen" }),
      topicMapping: () => ({}),
      activity: {
        [GROUP]: [
          { sessionKey: `topic:${GROUP}:8`, lastActivity: "2026-09-23T10:00:00.123000+00:00" },
          { sessionKey: `topic:${GROUP}:443`, lastActivity: "2026-09-23T10:00:00.123001+00:00" },
        ],
      },
    });
    const list = await createTelegramSource(f.deps).listConversations();
    expect(list.topics.map(t => [t.id, t.lastActivity])).toEqual([
      ["topic-443", "2026-09-23T10:00:00.123001Z"],
      ["topic-8", "2026-09-23T10:00:00.123Z"],
      ["topic-1", null],
    ]);
  });

  test("General ist bei vorhandener Gruppe immer dabei, auch ohne Namen", async () => {
    const f = fake({ topicNames: async () => ({}), topicMapping: () => ({}) });
    const list = await createTelegramSource(f.deps).listConversations();
    expect(list.topics).toEqual([{ id: "topic-1", title: "General", agent: "general", lastActivity: null }]);
  });

  test("ohne Gruppe: nur Direktchat, keine Abfrage für die Gruppe", async () => {
    const f = fake({ groupId: () => null });
    const list = await createTelegramSource(f.deps).listConversations();
    expect(list.dm?.id).toBe("dm");
    expect(list.topics).toEqual([]);
    expect(f.activityCalls).toEqual([[USER, ACTIVITY_SINCE_DAYS]]);
  });

  test("ohne Benutzer-ID: kein Direktchat", async () => {
    for (const userId of [undefined, "", "abc"]) {
      const f = fake({ userId });
      const list = await createTelegramSource(f.deps).listConversations();
      expect(list.dm).toBeNull();
      expect(f.activityCalls.map(c => c[0])).toEqual([GROUP]);
    }
  });

  test("ungültige Schlüssel und Agenten werden verworfen bzw. ersetzt", async () => {
    const f = fake({
      topicNames: async () => ({ "../x": "böse", "0": "null", "12": "  " }),
      topicMapping: () => ({ "12": "<script>", abc: "research" }),
    });
    const list = await createTelegramSource(f.deps).listConversations();
    expect(list.topics.map(t => t.id).sort()).toEqual(["topic-1", "topic-12"]);
    expect(list.topics.find(t => t.id === "topic-12")).toEqual({ id: "topic-12", title: "Topic 12", agent: "general", lastActivity: null });
  });

  test("Fehler der Quellen ergeben leere Teile und eine Log-Zeile, keinen Wurf", async () => {
    const f = fake({
      topicNames: async () => {
        throw new Error("kaputt");
      },
      activity: async () => {
        throw new Error("kaputt");
      },
    });
    const list = await createTelegramSource(f.deps).listConversations();
    expect(list.dm?.lastActivity).toBeNull();
    expect(list.topics.map(t => t.id)).toContain("topic-1");
    expect(f.logs.length).toBeGreaterThan(0);
  });
});

describe("history", () => {
  test("Topic liest topic:<chatId>:<n>, Standard 50 (+1 für hasMore)", async () => {
    const f = fake({ rows: [row(1, "user", "Hallo"), row(2, "assistant", "Hi", { agent: "finance" })] });
    const h = await createTelegramSource(f.deps).history("topic-443");
    expect(f.historyCalls).toEqual([[GROUP, 443, { limit: TELEGRAM_HISTORY_LIMIT + 1, before: undefined }]]);
    expect(h!.hasMore).toBe(false);
    expect(h!.messages.map(m => m.text)).toEqual(["Hallo", "Hi"]);
  });

  test("Topic 1 liest group:<chatId> (topicId null)", async () => {
    const f = fake();
    await createTelegramSource(f.deps).history("topic-1");
    expect(f.historyCalls[0].slice(0, 2)).toEqual([GROUP, null]);
  });

  test("Direktchat liest die Benutzer-ID ohne Topic", async () => {
    const f = fake();
    await createTelegramSource(f.deps).history("dm");
    expect(f.historyCalls[0].slice(0, 2)).toEqual([USER, null]);
  });

  test("before wird durchgereicht", async () => {
    const f = fake();
    await createTelegramSource(f.deps).history("topic-8", "2026-09-23T10:00:00.000Z");
    expect(f.historyCalls[0][2]).toEqual({ limit: TELEGRAM_HISTORY_LIMIT + 1, before: "2026-09-23T10:00:00.000Z" });
  });

  test("Nachladen über Mikrosekunden derselben Millisekunde lässt keine Nachricht aus", async () => {
    // Wie Postgres: Mikrosekunden-Zeitstempel, created_at < before, jüngste zuerst begrenzt
    const micros = (iso: string) => {
      const m = /^(.{19})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(iso)!;
      return Date.parse(`${m[1]}${m[3]}`) * 1000 + Number((m[2] ?? "").padEnd(6, "0"));
    };
    const rows = Array.from({ length: TELEGRAM_HISTORY_LIMIT + 2 }, (_, i) => ({
      ...row(i, "user", `n${i}`),
      created_at: `2026-09-23T10:00:00.123${String(i).padStart(3, "0")}+00:00`,
    }));
    const f = fake({
      history: async (_chatId, _topicId, { limit, before }) =>
        rows.filter(r => !before || micros(r.created_at) < micros(before)).slice(-limit),
    });
    const source = createTelegramSource(f.deps);

    const first = (await source.history("topic-8"))!;
    expect(first.hasMore).toBe(true);
    expect(first.messages[0].createdAt).toBe("2026-09-23T10:00:00.123002Z");

    const before = parseBeforeCursor(first.messages[0].createdAt)!;
    expect(before).toBe("2026-09-23T10:00:00.123002Z");
    const second = (await source.history("topic-8", before))!;
    expect(second.hasMore).toBe(false);

    const texts = [...second.messages, ...first.messages].map(m => m.text);
    expect(texts).toEqual(rows.map(r => r.content));
  });

  test("mehr als 50: die ältesten fallen weg, hasMore, chronologisch", async () => {
    const rows = Array.from({ length: TELEGRAM_HISTORY_LIMIT + 1 }, (_, i) => row(i, "user", `n${i}`));
    const f = fake({ rows });
    const h = await createTelegramSource(f.deps).history("topic-8");
    expect(h!.hasMore).toBe(true);
    expect(h!.messages).toHaveLength(TELEGRAM_HISTORY_LIMIT);
    expect(h!.messages[0].text).toBe("n1");
    expect(h!.messages.at(-1)!.text).toBe(`n${TELEGRAM_HISTORY_LIMIT}`);
    const times = h!.messages.map(m => m.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  test("leere Historie: leere Liste", async () => {
    const h = await createTelegramSource(fake().deps).history("topic-8");
    expect(h).toEqual({ messages: [], hasMore: false });
  });

  test("unbekannte oder ungültige IDs: null, keine Abfrage", async () => {
    const f = fake();
    const source = createTelegramSource(f.deps);
    for (const id of ["topic-12345", "topic-abc", "../x", "0e8f6f7a-5b1e-4c2a-9d3f-1a2b3c4d5e6f"]) {
      expect(await source.history(id)).toBeNull();
    }
    expect(f.historyCalls).toEqual([]);
    expect(await createTelegramSource(fake({ groupId: () => null }).deps).history("topic-1")).toBeNull();
    expect(await createTelegramSource(fake({ userId: undefined }).deps).history("dm")).toBeNull();
  });

  test("Fehler beim Lesen: wirft weiter statt leerer Liste, die Log-Zeile schreibt der Server (PR #83, Runde 4)", async () => {
    const f = fake({
      history: async () => {
        throw new Error("kaputt");
      },
    });
    await expect(createTelegramSource(f.deps).history("topic-8")).rejects.toThrow("kaputt");
  });
});

describe("toTelegramApiMessage", () => {
  test("ID aus metadata.msgId, sonst db-<id>; immer als Text", () => {
    expect(toTelegramApiMessage(row(1, "user", "a", { msgId: 77 }))!.id).toBe("77");
    expect(toTelegramApiMessage(row(1, "user", "a", { msgId: "513" }))!.id).toBe("513");
    expect(toTelegramApiMessage(row(1, "user", "a", {}))!.id).toBe("db-uuid-1");
    expect(toTelegramApiMessage(row(1, "user", "a", null))!.id).toBe("db-uuid-1");
    expect(toTelegramApiMessage(row(1, "user", "a", { msgId: "x<y" }))!.id).toBe("db-uuid-1");
    // messageId ist nicht Teil des Vertrags
    expect(toTelegramApiMessage(row(1, "user", "a", { messageId: 512 }))!.id).toBe("db-uuid-1");
  });

  test("doppelte Telegram-ID fällt auf db-<id> zurück", () => {
    const seen = new Set<string>();
    expect(toTelegramApiMessage(row(1, "user", "a", { msgId: 5 }), seen)!.id).toBe("5");
    expect(toTelegramApiMessage(row(2, "user", "b", { msgId: 5 }), seen)!.id).toBe("db-uuid-2");
  });

  test("Antworten: html ohne Steuer-Tags, agent aus metadata.agent; nur erlaubte Felder", () => {
    const m = toTelegramApiMessage({
      ...row(3, "assistant", "**Fertig** [REMEMBER: Geheimnis] <b>x</b>", { agent: "finance", topicId: 443, msgId: 9 }),
      embedding: [0.1, 0.2],
    } as HistoryRow)!;
    expect(m.html).toContain("<strong>Fertig</strong>");
    expect(m.html).not.toContain("REMEMBER");
    expect(m.html).not.toContain("<b>");
    expect(m.agent).toBe("finance");
    expect(Object.keys(m).sort()).toEqual(["agent", "copyText", "createdAt", "html", "id", "role", "text"]);
    expect(m.createdAt).toBe("2026-09-23T10:03:00.000Z");
    // Kopiertext: Markdown ohne Steuer-Tags; text bleibt unverändert
    expect(m.copyText).toBe("**Fertig** <b>x</b>");
    expect(m.text).toContain("[REMEMBER: Geheimnis]");
  });

  test("Nachricht des Nutzers ohne html und ohne agent", () => {
    const m = toTelegramApiMessage(row(1, "user", "Hallo", { agent: "finance" }))!;
    expect(m).toEqual({ id: "db-uuid-1", role: "user", text: "Hallo", createdAt: "2026-09-23T10:01:00.000Z" });
  });

  test("unbekannte Rollen und kaputte Zeilen werden übersprungen", () => {
    expect(toTelegramApiMessage(row(1, "system", "x"))).toBeNull();
    expect(toTelegramApiMessage({ ...row(1, "user", "x"), created_at: "kaputt" })).toBeNull();
    expect(toTelegramApiMessage({ ...row(1, "user", "x"), content: null as any })).toBeNull();
    expect(toTelegramApiMessage(row(1, "assistant", "x", { agent: "<script>" }))!.agent).toBeUndefined();
  });
});
