/**
 * Morgenbriefing als Routine (Issue #363): Zusammenbau aus Quellen-Attrappen
 * ohne Modellaufruf, deutsche Texte, Versand über den Kern der proaktiven
 * Meldungen (einmal je Ortstag, Tagesmarke nur bei Zustellung, WebUI allein
 * zählt), Exit-Code bei gescheiterter Quelle, --dry-run ohne Nebenwirkung.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SendAndRecordInput, SendAndRecordResult } from "../src/lib/outbox";
import { readProactiveState } from "../src/lib/proactive/state";
import { resetStore } from "../src/lib/store";
import { SOURCES } from "../src/lib/sources/list";
import type { Section, Source } from "../src/lib/sources/types";
import {
  draftBriefing,
  greetingName,
  parseBriefingArgs,
  renderBriefing,
  runBriefing,
  type BriefingRunDeps,
} from "../src/routines/briefing";

// Donnerstag, 14. Januar 2027, 9:30 in Berlin: im Zeitfenster des Briefings
const MORNING = "2027-01-14T08:30:00.000Z";
const ENV = { USER_TIMEZONE: "Europe/Berlin" };

const fake = (id: string, collect: () => Promise<Section>, extra: Partial<Source> = {}): Source => ({
  id,
  label: `Quelle ${id}`,
  ready: () => true,
  collect,
  ...extra,
});

/** Drei Quellen-Attrappen, die mittlere scheitert */
const THREE = [
  fake("goals", async () => ({ items: [{ text: "Steuer abgeben", due: "2027-01-31" }, { text: "Laufen" }] })),
  fake("notion-tasks", async () => {
    throw new Error("Notion antwortet mit 500");
  }),
  fake("wetter", async () => ({ items: [{ text: "Sonnig, 4 Grad" }] })),
];
const HEALTHY = [THREE[0], THREE[2]];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-briefing-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function recorder(result: SendAndRecordResult = { sent: true, recorded: true }) {
  const calls: SendAndRecordInput[] = [];
  const send = async (input: SendAndRecordInput) => {
    calls.push(input);
    return result;
  };
  return { calls, send };
}

const statePath = () => join(dir, "data", "proactive-state.json");

function deps(extra: Partial<BriefingRunDeps> = {}): BriefingRunDeps {
  return {
    sources: HEALTHY,
    env: { ...ENV, GO_PROJECT_ROOT: dir },
    now: () => new Date(MORNING),
    settings: {},
    statePath: statePath(),
    legacy: null,
    renewMs: 0,
    name: "Alex",
    wait: async () => {},
    ...extra,
  };
}

describe("Zusammenbau", () => {
  test("drei Quellen, eine scheitert: zwei Abschnitte und ein Hinweis in Listen-Reihenfolge", async () => {
    const draft = await draftBriefing({ sources: THREE, env: ENV, now: new Date(MORNING), name: "Alex" });
    expect(draft.parts.map(p => [p.id, p.status])).toEqual([
      ["goals", "ok"],
      ["notion-tasks", "failed"],
      ["wetter", "ok"],
    ]);
    expect(draft.failed).toEqual(["notion-tasks"]);
    expect(draft.text).toBe(
      [
        "☀️ **Guten Morgen, Alex!**\n_Donnerstag, 14. Januar_",
        "🎯 **Ziele** (2)\n• Steuer abgeben (bis 2027-01-31)\n• Laufen",
        "✅ **Aufgaben**\n_⚠️ Konnte nicht abgerufen werden._",
        "🔌 **Quelle wetter** (1)\n• Sonnig, 4 Grad",
        "_Antworte einfach, wenn du etwas davon besprechen willst._",
      ].join("\n\n"),
    );
    // Der Fehlertext der Quelle steht nicht in der Nachricht
    expect(draft.text).not.toContain("500");
  });

  test("Reihenfolge bleibt, auch wenn die erste Quelle zuletzt fertig wird", async () => {
    const slow = fake("a", () => new Promise(r => setTimeout(() => r({ items: [{ text: "spät" }] }), 30)));
    const quick = fake("b", async () => ({ items: [{ text: "früh" }] }));
    const draft = await draftBriefing({ sources: [slow, quick], env: ENV, now: new Date(MORNING), name: "Alex" });
    expect(draft.parts.map(p => p.id)).toEqual(["a", "b"]);
  });

  test("Zeitlimit: Hinweis statt Abschnitt, zählt als gescheitert", async () => {
    const hangs = fake("goals", () => new Promise(() => {}), { timeoutMs: 20 });
    const draft = await draftBriefing({ sources: [hangs], env: ENV, now: new Date(MORNING), name: "Alex" });
    expect(draft.parts).toEqual([{ id: "goals", title: "Ziele", symbol: "🎯", status: "timeout", lines: ["_⚠️ Hat zu lange gebraucht und fehlt deshalb._"] }]);
    expect(draft.failed).toEqual(["goals"]);
  });

  test("nicht eingerichtete Quelle fehlt still und zählt nicht als Fehler", async () => {
    const off = fake("gmail", async () => ({ items: [] }), { ready: () => false });
    const draft = await draftBriefing({ sources: [off, HEALTHY[0]], env: ENV, now: new Date(MORNING), name: "Alex" });
    expect(draft.parts.map(p => p.id)).toEqual(["goals"]);
    expect(draft.failed).toEqual([]);
    expect(draft.text).not.toContain("Mails");
  });

  test("ohne bereite Quelle: Hinweis, keine Abschnitte", () => {
    const draft = renderBriefing([], { now: new Date(MORNING), zone: "Europe/Berlin" });
    expect(draft.text).toBe("☀️ **Guten Morgen!**\n_Donnerstag, 14. Januar_\n\n_Keine Quelle eingerichtet._\n\n_Antworte einfach, wenn du etwas davon besprechen willst._");
  });

  test("deutsche Zeilen der eingebauten Quellen", () => {
    const ok = (id: string, section: Section) => ({ source: fake(id, async () => section), status: "ok" as const, section, ms: 1 });
    const draft = renderBriefing(
      [
        ok("calendar", {
          items: [
            { text: "Urlaub", allDay: true },
            { text: "Standup", start: "2027-01-14T08:00:00Z", end: "2027-01-14T09:30:00Z" },
            { text: "Ohne Ende", start: "2027-01-14T12:00:00Z" },
          ],
        }),
        ok("gmail", { items: [{ text: "Mia: Rechnung" }], total: 4 }),
        ok("notion-tasks", { items: [{ text: "Steuer", due: "2027-01-10", overdue: true }, { text: "Anrufen", due: "2027-01-14" }] }),
        ok("news", { items: [{ text: "Neues Modell", link: "https://example.com/a" }] }),
        ok("goals", { items: [] }),
      ],
      { now: new Date(MORNING), zone: "Europe/Berlin", name: "Mia" },
    );
    expect(draft.parts.map(p => [p.title, p.count, p.lines])).toEqual([
      ["Termine heute", 3, ["• ganztägig: Urlaub", "• 09:00 bis 10:30: Standup", "• 13:00 bis ?: Ohne Ende"]],
      ["Ungelesene Mails", 4, ["• Mia: Rechnung", "_und 3 weitere_"]],
      ["Aufgaben", 2, ["• ⚠️ überfällig: Steuer (fällig 2027-01-10)", "• Anrufen (fällig 2027-01-14)"]],
      ["KI-Nachrichten", undefined, ["• Neues Modell (https://example.com/a)"]],
      ["Ziele", 0, ["Keine offenen Ziele"]],
    ]);
  });

  test("leere Abschnitte: feste deutsche Zeile, Hinweis nur bei eigenen Quellen und unverändert; Mails ohne Details als Zahl", () => {
    const ok = (id: string, section: Section) => ({ source: fake(id, async () => section), status: "ok" as const, section, ms: 1 });
    const draft = renderBriefing(
      [
        ok("calendar", { items: [] }),
        ok("gmail", { items: [], total: 0 }),
        ok("notion-tasks", { items: [] }),
        ok("news", { items: [], note: "No verified news from the search." }),
        ok("wetter", { items: [] }),
        ok("eigene", { items: [], note: "Nothing new today" }),
        ok("eigene-voll", { items: [{ text: "Eintrag" }], note: "Stand: gestern" }),
      ],
      { now: new Date(MORNING), zone: "Europe/Berlin" },
    );
    expect(draft.parts.map(p => p.lines)).toEqual([
      ["Keine Termine, der Tag ist frei"],
      ["Keine ungelesenen Mails"],
      ["Heute ist nichts fällig"],
      ["Keine belegten Nachrichten gefunden"],
      ["Nichts zu melden"],
      ["Nothing new today"],
      ["• Eintrag", "_Stand: gestern_"],
    ]);
    const mails = renderBriefing([ok("gmail", { items: [], total: 7 })], { now: new Date(MORNING), zone: "UTC" });
    expect(mails.parts[0]).toMatchObject({ count: 7, lines: ["7 ungelesene Mails"] });
  });

  test("Anrede: USER_NAME, sonst erste Überschrift des Profils, sonst keine", async () => {
    expect(await greetingName({ USER_NAME: " Alex " }, dir)).toBe("Alex");
    expect(await greetingName({}, dir)).toBeUndefined();
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "profile.md"), "Vorspann\n# Mia\n\n## Über mich\n");
    expect(await greetingName({}, dir)).toBe("Mia");
  });
});

describe("Versand über den Kern", () => {
  test("zugestellt: Quelle briefing, Exit 0, Tagesmarke", async () => {
    const r = recorder();
    expect(await runBriefing(deps({ send: r.send }))).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ source: "briefing" });
    expect(r.calls[0].text).toStartWith("☀️ **Guten Morgen, Alex!**");
    expect((await readProactiveState(statePath())).briefing.lastDate).toBe("2027-01-14");
  });

  test("zweimal am selben Ortstag: höchstens eine Zustellung", async () => {
    const r = recorder();
    expect(await runBriefing(deps({ send: r.send }))).toBe(0);
    expect(await runBriefing(deps({ send: r.send, now: () => new Date("2027-01-14T10:00:00.000Z") }))).toBe(0);
    expect(r.calls).toHaveLength(1);
  });

  test("Sendefehler: Exit 1, keine Tagesmarke, später am Tag neuer Versuch", async () => {
    const failing = recorder({ sent: false, recorded: false, error: { kind: "send", message: "500" } });
    expect(await runBriefing(deps({ send: failing.send }))).toBe(1);
    expect((await readProactiveState(statePath())).briefing.lastDate).toBeUndefined();
    const r = recorder();
    expect(await runBriefing(deps({ send: r.send }))).toBe(0);
    expect(r.calls).toHaveLength(1);
  });

  test("nur WebUI (ohne Telegram festgehalten) zählt als Zustellung", async () => {
    const r = recorder({ sent: false, recorded: true });
    expect(await runBriefing(deps({ send: r.send }))).toBe(0);
    expect((await readProactiveState(statePath())).briefing.lastDate).toBe("2027-01-14");
  });

  test("eine Quelle scheitert: Briefing mit Hinweis zugestellt, Exit 1, Tagesmarke gesetzt", async () => {
    const r = recorder();
    expect(await runBriefing(deps({ send: r.send, sources: THREE }))).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].text).toContain("✅ **Aufgaben**\n_⚠️ Konnte nicht abgerufen werden._");
    expect((await readProactiveState(statePath())).briefing.lastDate).toBe("2027-01-14");
  });

  test("außerhalb des Zeitfensters: nichts gesendet, Exit 0, Quellen nicht abgefragt", async () => {
    let asked = 0;
    const counting = fake("goals", async () => {
      asked++;
      return { items: [] };
    });
    const r = recorder();
    expect(await runBriefing(deps({ send: r.send, sources: [counting], now: () => new Date("2027-01-14T14:00:00.000Z") }))).toBe(0);
    expect(r.calls).toEqual([]);
    expect(asked).toBe(0);
  });

  test("gewartet wird vor dem Lauf", async () => {
    const order: string[] = [];
    const r = recorder();
    await runBriefing(deps({ wait: async () => void order.push("warten"), send: async i => (order.push("senden"), r.send(i)) }));
    expect(order).toEqual(["warten", "senden"]);
  });
});

describe("--dry-run", () => {
  test("zeigt den Text, sendet nichts, schreibt und übernimmt nichts", async () => {
    // Alte Dateien liegen bereit: ein echter Lauf würde sie übernehmen
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "schedule.json"), JSON.stringify({ morning_briefing: { enabled: true, hour: 9, minute: 0 } }));
    writeFileSync(join(dir, "checkin-state.json"), JSON.stringify({ lastBriefingDate: "2027-01-13" }));
    const before = readdirSync(dir).sort();
    const printed: string[] = [];
    const r = recorder();
    let waited = false;
    const code = await runBriefing(
      deps({
        dryRun: true,
        send: r.send,
        print: t => void printed.push(t),
        legacy: undefined,
        settings: undefined,
        wait: async () => void (waited = true),
      }),
    );
    expect(code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(waited).toBe(false);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("🎯 **Ziele** (2)");
    expect(existsSync(statePath())).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(readFileSync(join(dir, "checkin-state.json"), "utf-8")).toBe(JSON.stringify({ lastBriefingDate: "2027-01-13" }));
  });

  test("auch außerhalb des Zeitfensters und nach dem Versand des Tages", async () => {
    const r = recorder();
    await runBriefing(deps({ send: r.send }));
    const printed: string[] = [];
    expect(await runBriefing(deps({ dryRun: true, send: r.send, print: t => void printed.push(t), now: () => new Date("2027-01-14T20:00:00Z") }))).toBe(0);
    expect(printed).toHaveLength(1);
    expect(r.calls).toHaveLength(1);
  });

  test("gescheiterte Quelle: Exit 1", async () => {
    expect(await runBriefing(deps({ dryRun: true, sources: THREE, print: () => {} }))).toBe(1);
  });
});

describe("Aufruf", () => {
  test("nur --dry-run ist erlaubt", () => {
    expect(parseBriefingArgs([])).toEqual({ dryRun: false });
    expect(parseBriefingArgs(["--dry-run"])).toEqual({ dryRun: true });
    expect(parseBriefingArgs(["--dryrun"])).toBeNull();
  });

  test("unbekannte Option im eigenen Prozess: Exit 2, nichts gesendet", async () => {
    const proc = Bun.spawn(["bun", "--no-env-file", join(import.meta.dir, "..", "src", "routines", "briefing.ts"), "--jetzt"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(err).toContain("bun run briefing [--dry-run]");
  });
});

describe("mit der echten Quellen-Liste", () => {
  // SOURCES enthält die Quelle Ziele: Gedächtnis in einer leeren Datei, nie das echte
  const KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MEMORY_FILE_PATH", "NOTION_TOKEN", "NOTION_DATABASE_ID"];
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.MEMORY_FILE_PATH = join(dir, "memory.json");
    resetStore();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetStore();
  });

  test("Kennungen und Reihenfolge der Abschnitte", () => {
    expect(SOURCES.map(s => s.id)).toEqual(["calendar", "gmail", "notion-tasks", "news", "goals"]);
  });

  test("eine Quelle, deren ready() wirft, hält das Briefing nicht auf", async () => {
    const collect = mock(async () => ({ items: [{ text: "nie" }] }));
    const broken = fake("kaputt-ready", collect, {
      ready: () => {
        throw new Error("ready kaputt");
      },
    });
    const draft = await draftBriefing({ sources: [broken, fake("heil", async () => ({ items: [{ text: "da" }] })), ...SOURCES], env: ENV, name: "Alex" });
    expect(draft.parts.find(p => p.id === "heil")?.lines).toEqual(["• da"]);
    expect(draft.parts.some(p => p.id === "goals")).toBe(true);
    expect(draft.parts.some(p => p.id === "kaputt-ready")).toBe(false);
    expect(draft.failed).toEqual([]);
    expect(collect).not.toHaveBeenCalled();
  });

  test("Notion über die echte Quelle: überfällig markiert, Anzahl", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const page = (title: string, due: string) => ({
      url: "https://www.notion.so/seite",
      properties: { Name: { type: "title", title: [{ plain_text: title }] }, Due: { type: "date", date: { start: due } } },
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://api.notion.com/")) return Response.json({ results: [page("Steuer abgeben", "2020-01-02"), page("Anrufen", today)] });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const draft = await draftBriefing({ env: { NOTION_TOKEN: "notion-attrappe", NOTION_DATABASE_ID: "db1", MEMORY_FILE_PATH: process.env.MEMORY_FILE_PATH }, name: "Alex" });
    const notion = draft.parts.find(p => p.id === "notion-tasks");
    expect(notion).toMatchObject({ symbol: "✅", title: "Aufgaben", count: 2 });
    expect(notion?.lines).toEqual(["• ⚠️ überfällig: Steuer abgeben (fällig 2020-01-02)", `• Anrufen (fällig ${today})`]);
  });

  test("Nachrichten über die echte Quelle: ohne Beleg deutsche Zeile, belegte Meldung des Anbieters unverändert", async () => {
    let answer = "";
    let citations: string[] = [];
    const xai = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== "https://api.x.ai/v1/responses") return new Response("{}", { status: 404 });
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: answer, annotations: [] }] }], citations });
    }) as typeof fetch;
    const env = { ...ENV, XAI_API_KEY: "xai-attrappe", MEMORY_FILE_PATH: process.env.MEMORY_FILE_PATH };
    const news = async () => (await draftBriefing({ env, fetch: xai, name: "Alex" })).parts.find(p => p.id === "news");

    answer = "• Lab A releases model B (https://example.com/a)";
    expect(await news()).toMatchObject({ status: "ok", title: "KI-Nachrichten", lines: ["Keine belegten Nachrichten gefunden"] });

    citations = ["https://example.com/a"];
    expect(await news()).toMatchObject({ status: "ok", lines: ["• Lab A releases model B (https://example.com/a)"] });
  });

  test("Attrappen für alle fünf Quellen: Reihenfolge der Liste, Gmail scheitert mit Hinweis", async () => {
    const sections: Record<string, Section> = {
      calendar: { items: [{ text: "Urlaub", allDay: true }, { text: "Standup", start: "2026-01-15T08:00:00.000Z", end: "2026-01-15T08:15:00.000Z" }] },
      "notion-tasks": { items: [{ text: "Steuer", due: "2026-01-10", overdue: true }] },
      news: { items: [{ text: "Meldung", link: "https://example.com/a" }] },
      goals: { items: [{ text: "Laufen" }] },
    };
    // Die Attrappen werden in umgekehrter Reihenfolge fertig, die Ausgabe folgt trotzdem der Liste
    const fakes = SOURCES.map((real, i): Source => ({
      id: real.id,
      label: real.label,
      ready: () => true,
      collect: async () => {
        await new Promise(r => setTimeout(r, (SOURCES.length - i) * 3));
        if (real.id === "gmail") throw new Error("Gmail antwortet mit HTTP 500");
        return sections[real.id];
      },
    }));
    const draft = await draftBriefing({ sources: fakes, env: ENV, name: "Alex" });
    expect(draft.parts.map(p => [p.symbol, p.title, p.count, p.lines])).toEqual([
      ["📅", "Termine heute", 2, ["• ganztägig: Urlaub", "• 09:00 bis 09:15: Standup"]],
      ["📧", "Ungelesene Mails", undefined, ["_⚠️ Konnte nicht abgerufen werden._"]],
      ["✅", "Aufgaben", 1, ["• ⚠️ überfällig: Steuer (fällig 2026-01-10)"]],
      ["📰", "KI-Nachrichten", undefined, ["• Meldung (https://example.com/a)"]],
      ["🎯", "Ziele", 1, ["• Laufen"]],
    ]);
    expect(draft.failed).toEqual(["gmail"]);
  });
});
