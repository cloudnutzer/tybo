/**
 * Issue #357: Board-Daten über die Quellen-Registry (src/lib/board/data.ts,
 * src/lib/board/briefs.ts). Quellen, fetch und Gedächtnis sind Attrappen;
 * jeder Test gibt seine Quellen-Liste und Umgebung selbst vor. Ein Test läuft
 * mit der echten Registry (SOURCES) und dem Datei-Gedächtnis, ohne Netz.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoardMeeting } from "../src/lib/board-meeting";
import { stripConsultTags as stripInvocationTags } from "../src/lib/agent-consult";
import { BLOCK_HEADING, briefFor, isCostMail, mailSubject } from "../src/lib/board/briefs";
import { BOARD_SOURCE_TIMEOUT_MS, gatherBoardData, type BoardData } from "../src/lib/board/data";
import { resetStore } from "../src/lib/store";
import type { MemoryItem } from "../src/lib/store/types";
import { goalsSource } from "../src/lib/sources/goals";
import { senderName } from "../src/lib/sources/gmail";
import { SOURCES } from "../src/lib/sources/list";
import { MAX_TASKS } from "../src/lib/sources/notion";
import type { Section, SectionItem, Source } from "../src/lib/sources/types";

const NOW = new Date("2026-10-19T08:00:00Z");
const ENV = { USER_TIMEZONE: "Europe/Berlin" };
const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "MEMORY_FILE_PATH", "USER_TIMEZONE"];

let savedEnv: Record<string, string | undefined>;
let realFetch: typeof fetch;
/** Jede Adresse, die über das globale fetch oder die übergebene Attrappe ging */
let urls: string[];
const cleanups: (() => void)[] = [];

const urlOf = (input: Parameters<typeof fetch>[0]) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

/** fetch-Attrappe, die aufzeichnet und auf unbekannte Adressen laut scheitert */
function recorder(respond: (url: string, init?: RequestInit) => Response = () => new Response("kein Netz im Test", { status: 599 })): typeof fetch {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = urlOf(input);
      urls.push(url);
      return respond(url, init);
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  realFetch = globalThis.fetch;
  urls = [];
  globalThis.fetch = recorder();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  while (cleanups.length) cleanups.pop()!();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetStore();
});

interface Fake extends Source {
  calls: number;
}

/** Attrappen-Quelle: liefert den Abschnitt, wirft den Fehler oder hängt bis zum Abbruch */
function fake(id: string, result: Section | Error | "hang", options: { ready?: boolean; timeoutMs?: number } = {}): Fake {
  const source: Fake = {
    id,
    label: `Attrappe ${id}`,
    calls: 0,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ready: () => options.ready ?? true,
    collect: async ctx => {
      source.calls++;
      if (result === "hang") return new Promise<Section>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("abgebrochen"))));
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return source;
}

const items = (...texts: string[]): SectionItem[] => texts.map(text => ({ text }));

const gather = (sources: readonly Source[], extra: Parameters<typeof gatherBoardData>[0] = {}) =>
  gatherBoardData({ sources, env: ENV, now: NOW, fetch: recorder(), log: () => {}, ...extra });

describe("Sammeln über die Quellen-Liste", () => {
  test("Rückgabe in der bisherigen Form", async () => {
    const data: BoardData = await gather([]);
    expect(Object.keys(data).sort()).toEqual(["agentData", "errors", "fetchDurationMs", "sharedSummary"]);
    expect(typeof data.fetchDurationMs).toBe("number");
    expect(data.errors).toEqual([]);
    expect(data.sharedSummary).toBe("");
    for (const text of Object.values(data.agentData)) expect(text).toBe("");
  });

  test("eine Attrappen-Quelle erscheint im Block ihres Agenten, eine nicht bereite wird nicht aufgerufen", async () => {
    const news = fake("news", { items: [{ text: "Neues Modell erschienen", link: "https://example.com/a" }] });
    const gmail = fake("gmail", { items: items("Shop: Hallo"), total: 1 }, { ready: false });
    const data = await gather([news, gmail]);
    expect(news.calls).toBe(1);
    expect(gmail.calls).toBe(0);
    expect(data.agentData.research).toBe(`${BLOCK_HEADING}\n\n### KI-Nachrichten der letzten 24 Stunden\n- Neues Modell erschienen (https://example.com/a)`);
    expect(data.errors).toEqual([]);
  });

  test("ohne Optionen nimmt das Board die Registry SOURCES", async () => {
    const seen: string[] = [];
    const spy = SOURCES.map(source => ({ ...source, ready: () => (seen.push(source.id), false) }));
    await gather(spy);
    expect(seen).toEqual(SOURCES.map(s => s.id));
  });
});

describe("Ziele nur über den Gedächtnis-Dienst", () => {
  const goal = (content: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({ type: "goal", content, ...extra });

  test("Leser des Gedächtnis-Dienstes wird aufgerufen; kein Abruf auf /rest/v1/memory, auch mit SUPABASE_ANON_KEY", async () => {
    const env = { ...ENV, SUPABASE_URL: "https://supabase.test", SUPABASE_ANON_KEY: "anon-attrappe" };
    Object.assign(process.env, env);
    let reads = 0;
    const reader = async () => {
      reads++;
      return {
        goals: [
          goal("Buch schreiben", { deadline: "2026-12-01T10:00:00Z", created_at: "2026-10-01T08:00:00Z" }),
          goal("Steuer abgeben", { deadline: "2026-10-10T10:00:00Z", created_at: "2026-10-02T08:00:00Z" }),
          goal("Umzug", { completed: true, created_at: "2026-10-03T08:00:00Z" }),
        ],
        from: "supabase" as const,
      };
    };
    const data = await gather([goalsSource(reader)], { env });
    expect(reads).toBe(1);
    expect(urls.filter(u => u.includes("/rest/v1/"))).toEqual([]);
    expect(urls).toEqual([]);
    expect(data.agentData.strategy).toBe(
      `${BLOCK_HEADING}\n\n### Offene Ziele\n- Steuer abgeben (Frist 2026-10-10, verstrichen)\n- Buch schreiben (Frist 2026-12-01)`,
    );
    expect(data.agentData.strategy).not.toContain("Umzug");
  });

  test("echte Registry mit Datei-Gedächtnis: offene Ziele aus dem Dienst, erreichte fehlen, kein Supabase-Abruf", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-board-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "memory.json");
    writeFileSync(file, JSON.stringify({ facts: [], goals: [{ text: "Marathon laufen" }], completedGoals: [{ text: "Umzug erledigt" }] }));
    // Nur der lesende Schlüssel: früher las das Board damit selbst /rest/v1/memory
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    Object.assign(process.env, { SUPABASE_URL: "https://supabase.test", SUPABASE_ANON_KEY: "anon-attrappe", MEMORY_FILE_PATH: file, USER_TIMEZONE: "Europe/Berlin" });
    resetStore();
    const data = await gatherBoardData({ log: () => {} });
    expect(urls).toEqual([]);
    expect(data.errors).toEqual([]);
    expect(data.agentData.strategy).toBe(`${BLOCK_HEADING}\n\n### Offene Ziele\n- Marathon laufen`);
  });
});

describe("Ausfall und Zeitlimit", () => {
  test("scheiternde und hängende Quelle halten die übrigen nicht auf, stehen in errors und als „nicht verfügbar“, nie als 0", async () => {
    const notion = fake("notion-tasks", "hang", { timeoutMs: 60_000 });
    const gmail = fake("gmail", new Error("Gmail antwortet mit HTTP 500"));
    const news = fake("news", { items: items("Chip vorgestellt") });
    const logs: string[] = [];
    const data = await gather([notion, gmail, news], { limitMs: 30, log: m => void logs.push(m) });
    expect(data.errors).toEqual(["notion-tasks", "gmail"]);
    expect(data.fetchDurationMs).toBeLessThan(5_000);
    // Die Board-Grenze greift über eine Kopie; die Quelle behält ihr eigenes Limit
    expect(notion.timeoutMs).toBe(60_000);
    expect(data.agentData.research).toBe(
      `${BLOCK_HEADING}\n\n### KI-Nachrichten der letzten 24 Stunden\n- Chip vorgestellt\n\n### Ungelesene Mails\nnicht verfügbar`,
    );
    expect(data.agentData.coo).toBe(`${BLOCK_HEADING}\n\n### Aufgaben, fällig bis heute\nnicht verfügbar\n\n### Ungelesene Mails\nnicht verfügbar`);
    expect(data.agentData.critic).toBe(`${BLOCK_HEADING}\n\n### Risiko-Kennzahlen\n- Überfällige Aufgaben: nicht verfügbar\n- Ungelesene Mails: nicht verfügbar`);
    expect(data.agentData.finance).toBe(`${BLOCK_HEADING}\n\n### Mails mit Kostenbezug im Betreff\nnicht verfügbar`);
    expect(data.sharedSummary).toBe("");
    for (const text of Object.values(data.agentData)) expect(text).not.toMatch(/\b0\b/);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toStartWith("Quelle notion-tasks im Zeitlimit nach ");
    expect(logs[1]).toBe("Quelle gmail gescheitert: Gmail antwortet mit HTTP 500");
  });

  test("Quelle mit kürzerem eigenem Limit behält es; Standard-Obergrenze 20 s", async () => {
    expect(BOARD_SOURCE_TIMEOUT_MS).toBe(20_000);
    const quick = fake("news", "hang", { timeoutMs: 20 });
    const data = await gather([quick], { limitMs: 10_000 });
    expect(data.errors).toEqual(["news"]);
    expect(data.fetchDurationMs).toBeLessThan(5_000);
  });

  test("nicht eingerichtet (skipped) gegenüber leerer Antwort", async () => {
    const skipped = await gather([fake("notion-tasks", { items: [] }, { ready: false }), fake("gmail", { items: [] }, { ready: false })]);
    expect(skipped.agentData.coo).toBe("");
    expect(skipped.agentData.critic).toBe("");
    expect(skipped.sharedSummary).toBe("");

    const empty = await gather([fake("notion-tasks", { items: [] }), fake("gmail", { items: [], total: 0 })]);
    expect(empty.agentData.coo).toBe(
      `${BLOCK_HEADING}\n\n### Aufgaben, fällig bis heute\nKeine Aufgaben, die bis heute fällig sind.\n\n### Ungelesene Mails\nKeine ungelesenen Mails.`,
    );
    expect(empty.agentData.critic).toBe(
      `${BLOCK_HEADING}\n\n### Risiko-Kennzahlen\n- Überfällige Aufgaben: 0 (unter 0 gelieferten Aufgaben)\n- Ungelesene Mails: 0`,
    );
    expect(empty.sharedSummary).toBe("Überfällige Aufgaben: 0 (unter 0 gelieferten Aufgaben)");
  });
});

describe("Notion nur über die Quelle notion-tasks", () => {
  test("mit NOTION_CONTENT_PIPELINE_DB und NOTION_TRANSACTIONS_DB gesetzt: nur die Abfrage der Aufgaben-Datenbank", async () => {
    const env = {
      ...ENV,
      NOTION_TOKEN: "notion-attrappe",
      NOTION_DATABASE_ID: "db-tasks",
      NOTION_CONTENT_PIPELINE_DB: "db-content",
      NOTION_TRANSACTIONS_DB: "db-tx",
    };
    const page = (title: string, due: string) => ({ properties: { Name: { type: "title", title: [{ plain_text: title }] }, Due: { date: { start: due } } } });
    const fetchFake = recorder(url =>
      url === "https://api.notion.com/v1/databases/db-tasks/query"
        ? json({ results: [page("Steuer abgeben", "2026-10-01"), page("Bericht", "2026-10-19")] })
        : new Response("kein Netz im Test", { status: 599 }),
    );
    const sources = SOURCES.map(s => (s.id === "goals" ? goalsSource(async () => ({ goals: [], from: "file" })) : s));
    const data = await gatherBoardData({ sources, env, now: NOW, fetch: fetchFake, log: () => {} });
    expect(urls.filter(u => u.includes("notion"))).toEqual(["https://api.notion.com/v1/databases/db-tasks/query"]);
    expect(urls.filter(u => !u.includes("notion"))).toEqual([]);
    expect(data.errors).toEqual([]);
    expect(data.agentData.coo).toBe(
      `${BLOCK_HEADING}\n\n### Aufgaben, fällig bis heute\nÜberfällig: 1 (unter 2 gelieferten Aufgaben)\n- Steuer abgeben (fällig 2026-10-01, überfällig)\n- Bericht (fällig 2026-10-19, heute)`,
    );
    expect(data.agentData.critic).toBe(`${BLOCK_HEADING}\n\n### Risiko-Kennzahlen\n- Überfällige Aufgaben: 1 (unter 2 gelieferten Aufgaben)`);
    expect(data.sharedSummary).toBe("Überfällige Aufgaben: 1 (unter 2 gelieferten Aufgaben)");
    expect(data.agentData.content).toBe("");
    expect(data.agentData.finance).toBe("");
  });

  test(`volle Liste (${MAX_TASKS}): die Zahl ist als begrenzt gekennzeichnet`, async () => {
    const tasks = Array.from({ length: MAX_TASKS }, (_, i) => ({ text: `Aufgabe ${i}`, due: "2026-10-01", overdue: true }));
    const data = await gather([fake("notion-tasks", { items: tasks })]);
    expect(data.sharedSummary).toBe(`Überfällige Aufgaben: ${MAX_TASKS} (unter ${MAX_TASKS} gelieferten Aufgaben, Liste auf ${MAX_TASKS} begrenzt)`);
  });
});

describe("Blöcke je Agent", () => {
  test("critic: ungelesene Mails aus total, nicht aus der Zahl der Einträge", async () => {
    const data = await gather([fake("gmail", { items: items("Alex: Hallo", "Mia: Treffen"), total: 37 })]);
    expect(data.agentData.critic).toBe(`${BLOCK_HEADING}\n\n### Risiko-Kennzahlen\n- Ungelesene Mails: 37`);
    expect(data.agentData.research).toBe(`${BLOCK_HEADING}\n\n### Ungelesene Mails\nUngelesen im Posteingang: 37\n- Alex: Hallo\n- Mia: Treffen`);
  });

  test("cto, general, content und eigene Board-Agenten: leerer Block ohne Fehler", async () => {
    const all = [
      fake("news", { items: items("Nachricht") }),
      fake("gmail", { items: items("Alex: Rechnung"), total: 1 }),
      fake("goals", { items: items("Ziel") }),
      fake("calendar", { items: items("Termin") }),
      fake("notion-tasks", { items: items("Aufgabe") }),
    ];
    const data = await gather(all);
    expect(data.errors).toEqual([]);
    expect(data.agentData.cto).toBe("");
    expect(data.agentData.general).toBe("");
    expect(data.agentData.content).toBe("");
    expect(data.agentData["projekt-planer"]).toBeUndefined();
    const view = { outcome: () => undefined, timeZone: "UTC" };
    expect(briefFor("projekt-planer", view)).toBe("");
    expect(briefFor("constructor", view)).toBe("");
    for (const agent of ["research", "finance", "strategy", "coo", "critic"]) expect(data.agentData[agent]).toStartWith(BLOCK_HEADING);
  });

  test("strategy: Ziele mit Frist, Termine heute mit Uhrzeit in USER_TIMEZONE, nur die ersten drei Nachrichten", async () => {
    const data = await gather([
      fake("goals", { items: [{ text: "Buch", due: "2026-12-01" }, { text: "Steuer", due: "2026-10-10", overdue: true }, { text: "Laufen" }] }),
      fake("calendar", { items: [{ text: "Feiertag", allDay: true }, { text: "Standup", start: "2026-10-19T07:30:00.000Z" }, { text: "Ohne Zeit" }] }),
      fake("news", { items: items("N1", "N2", "N3", "N4", "N5") }),
    ]);
    expect(data.agentData.strategy).toBe(
      [
        BLOCK_HEADING,
        "### Offene Ziele\n- Buch (Frist 2026-12-01)\n- Steuer (Frist 2026-10-10, verstrichen)\n- Laufen",
        "### Termine heute\n- ganztägig: Feiertag\n- 09:30 Uhr: Standup\n- Ohne Zeit",
        "### Wichtigste Nachrichten\n- N1\n- N2\n- N3",
      ].join("\n\n"),
    );
    expect(data.agentData.research).toContain("- N5");
  });

  test("leere Abschnitte nennen das, statt eine Zahl zu erfinden", async () => {
    const data = await gather([fake("goals", { items: [] }), fake("calendar", { items: [] }), fake("news", { items: [], note: "No verified news from the search." })]);
    expect(data.agentData.strategy).toBe(
      `${BLOCK_HEADING}\n\n### Offene Ziele\nKeine offenen Ziele.\n\n### Termine heute\nKeine Termine heute.\n\n### Wichtigste Nachrichten\nKeine belegten Nachrichten gefunden.`,
    );
  });

  test("finance: Kostenwörter nur im Betreff, deutsch und englisch, Doppelpunkte in Absender und Betreff, nie aus dem Absender", async () => {
    const mails = [
      '"Shop": Ihre Rechnung: Oktober',
      "Bank: Re: Zahlungserinnerung",
      "Verlag: Abonnement verlängert",
      "Stadtwerke: Abrechnung 2026",
      "Store: Your receipt",
      "Service: Payment received",
      "Cloud: Billing update",
      "Portal: Beleg hochgeladen",
      "Rechnung GmbH: Hallo",
      "Billing: Team: Newsletter",
      `${senderName('"Team: Billing" <mail@example.test>')}: Hallo`,
      '"Rechnung: Team": Hallo',
      "Händler: Rechnung: Hallo",
      "Alex: Berechnung der Fläche",
      "Mia: above all",
      "Kino: Belegung Saal 2",
      "Rechnung",
    ];
    const data = await gather([fake("gmail", { items: items(...mails), total: 40 })]);
    expect(data.agentData.finance).toBe(
      [
        BLOCK_HEADING,
        "### Mails mit Kostenbezug im Betreff\n- \"Shop\": Ihre Rechnung: Oktober\n- Bank: Re: Zahlungserinnerung\n- Verlag: Abonnement verlängert\n- Stadtwerke: Abrechnung 2026\n- Store: Your receipt\n- Service: Payment received\n- Cloud: Billing update\n- Portal: Beleg hochgeladen",
      ].join("\n\n"),
    );
    expect(mailSubject("Billing: Team: Newsletter")).toBe("Newsletter");
    expect(mailSubject('"Team: Billing": Hallo')).toBe("Hallo");
    expect(mailSubject('"Team: Billing": Re: Rechnung: Oktober')).toBe("Re: Rechnung: Oktober");
    expect(mailSubject('"Ein \\"Team: Billing\\"": Hallo')).toBe("Hallo");
    expect(mailSubject('"Team: Billing" Hallo')).toBeNull();
    expect(mailSubject('"Team: Billing: Hallo')).toBeNull();
    expect(mailSubject("ohne Trenner")).toBeNull();
    for (const text of ['"Team: Billing": Re: Rechnung: Oktober', "Alex: Abo", "Alex: Abos kündigen", "Alex: invoices", "Alex: charged twice", "Alex: Subscription", "Alex: Belege"]) {
      expect(isCostMail({ text })).toBe(true);
    }
    for (const text of ["Alex: Surcharge", "Alex: Abort", "Abo: Hallo"]) expect(isCostMail({ text })).toBe(false);
  });

  test("finance ohne Kostenmails: Hinweis statt leerem Abschnitt", async () => {
    const data = await gather([fake("gmail", { items: items("Alex: Hallo"), total: 1 })]);
    expect(data.agentData.finance).toBe(`${BLOCK_HEADING}\n\n### Mails mit Kostenbezug im Betreff\nKeine unter den gezeigten ungelesenen Mails.`);
  });
});


describe("Aufruf ohne Optionen wie im Bot", () => {
  test("mit SUPABASE_ANON_KEY kein Abruf auf /rest/v1/memory", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    Object.assign(process.env, { SUPABASE_URL: "https://supabase.test", SUPABASE_ANON_KEY: "anon-attrappe" });
    resetStore();
    await gatherBoardData();
    expect(urls.filter(u => u.includes("/rest/v1/memory"))).toEqual([]);
  });
});

describe("/board-Sitzung mit echter Datensammlung", () => {
  test("Datenblöcke landen in den Prompts; cto und eigener Agent ohne Daten und ohne Bezug auf Live-Daten", async () => {
    const prompts = new Map<string, string>();
    let n = 0;
    const result = await runBoardMeeting(
      {
        agents: () => ["critic", "cto", "projekt-planer"],
        gatherData: () => gather([fake("gmail", { items: items("Alex: Hallo"), total: 5 }), fake("notion-tasks", new Error("Notion antwortet mit HTTP 500"))]),
        callAgent: async (prompt, agent) => {
          prompts.set(agent, prompt);
          return { text: agent === "general" ? "Zusammenfassung" : `Beitrag ${agent}` };
        },
        stripInvocationTags,
        save: async () => true,
        newMessageId: () => `id-${++n}`,
        pauseMs: 0,
        log: () => {},
      },
      { sessionKey: "topic:-100:9" },
      { start: async () => {}, thinking: async () => {}, contribution: async () => {}, end: async () => {} },
    );
    expect(result).toEqual({ contributions: 3, synthesis: true, stopped: false, aborted: false, empty: false });
    expect(prompts.get("critic")).toContain(`${BLOCK_HEADING}\n\n### Risiko-Kennzahlen\n- Überfällige Aufgaben: nicht verfügbar\n- Ungelesene Mails: 5`);
    expect(prompts.get("critic")).toContain("Live-Daten“ oben");
    for (const agent of ["cto", "projekt-planer"]) {
      expect(prompts.get(agent)).not.toContain(BLOCK_HEADING);
      expect(prompts.get(agent)).toContain("keine Live-Daten vor");
    }
    expect(prompts.get("general")).not.toContain("Aktueller Stand");
  });
});
