/**
 * Issue #354: Quelle Ziele. Erreichte Ziele erscheinen nicht, weder in der
 * Quelle noch im Morgenbriefing (draftBriefing aus src/routines/briefing.ts).
 * Geprüft mit einer Gedächtnis-Attrappe, mit dem Datei-Store und mit
 * Supabase ohne Netz (memory-fixture.ts, Service-Schlüssel im Kopf).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetStore, type Backend } from "../src/lib/store";
import type { MemoryItem } from "../src/lib/store/types";
import { goalsSource, MAX_GOALS } from "../src/lib/sources/goals";
import { runSource } from "../src/lib/sources/run";
import { draftBriefing } from "../src/routines/briefing";
import { useMemoryTable } from "./memory-fixture";
import { useFakeSupabase } from "./supabase-fixture";

const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MEMORY_FILE_PATH", "GO_PROJECT_ROOT", "USER_TIMEZONE", "CONVEX_URL"];
const cleanups: (() => void)[] = [];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetStore();
});

const NOW = new Date("2026-10-18T22:30:00Z"); // in Berlin schon der 19.10.

async function collect(read: () => Promise<MemoryItem[]>, env: Record<string, string> = {}, backend: Backend = "file") {
  const outcome = await runSource(goalsSource(async () => ({ goals: await read(), from: backend })), { env, now: NOW });
  if (outcome.status !== "ok") throw new Error(`unerwartet: ${outcome.status}`);
  return outcome.section;
}

/** Abschnitt Ziele des Briefings; ok: false, wenn statt des Abschnitts ein Fehlerhinweis steht */
async function briefingGoals() {
  const part = (await draftBriefing({ name: "Alex" })).parts.find(p => p.id === "goals");
  return { part: part?.status === "ok" ? part : undefined, failed: part !== undefined && part.status !== "ok" };
}

const goal = (content: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({ type: "goal", content, ...extra });

describe("goalsSource mit Attrappe", () => {
  test("immer bereit, Abschnitt mit Einträgen statt Markdown", async () => {
    expect(goalsSource(async () => ({ goals: [], from: "file" })).ready({})).toBe(true);
    const section = await collect(async () => [goal("Bericht schreiben")]);
    expect(section).toEqual({ items: [{ text: "Bericht schreiben" }] });
  });

  test("erreichte Ziele fehlen, auch wenn der Leser sie liefert", async () => {
    const section = await collect(async () => [goal("offen"), goal("erledigt", { completed: true })]);
    expect(section.items.map(i => i.text)).toEqual(["offen"]);
  });

  test("leere Liste: leerer Abschnitt", async () => {
    expect(await collect(async () => [])).toEqual({ items: [] });
  });

  const sevenGoals = () => [goal("ohne Zeit"), ...Array.from({ length: 7 }, (_, i) => goal(`Ziel ${i}`, { created_at: `2026-10-0${i + 1}T08:00:00Z` }))];

  test(`Supabase: höchstens ${MAX_GOALS}, zuletzt angelegte zuerst, ohne Anlagezeit hinten`, async () => {
    const section = await collect(async () => sevenGoals(), {}, "supabase");
    expect(section.items.map(i => i.text)).toEqual(["Ziel 6", "Ziel 5", "Ziel 4", "Ziel 3", "Ziel 2"]);
  });

  test("Datei: alle offenen Ziele in der Reihenfolge des Lesers", async () => {
    const section = await collect(async () => sevenGoals(), {}, "file");
    expect(section.items.map(i => i.text)).toEqual(["ohne Zeit", "Ziel 0", "Ziel 1", "Ziel 2", "Ziel 3", "Ziel 4", "Ziel 5", "Ziel 6"]);
  });

  test("Frist aus deadline als Tag in USER_TIMEZONE, verstrichen markiert", async () => {
    const section = await collect(
      async () => [
        goal("bald", { deadline: "2026-10-19T21:59:59.000Z" }),
        goal("vorbei", { deadline: "2026-10-17T12:00:00.000Z" }),
        goal("unlesbar", { deadline: "irgendwann" }),
      ],
      { USER_TIMEZONE: "Europe/Berlin" },
    );
    expect(section.items).toEqual([
      { text: "bald", due: "2026-10-19" },
      { text: "vorbei", due: "2026-10-17", overdue: true },
      { text: "unlesbar" },
    ]);
  });

  test("Fehler des Lesers wird zum Ausgang failed", async () => {
    const outcome = await runSource(
      goalsSource(async () => {
        throw new Error("Store weg");
      }),
      { env: {} },
    );
    expect(outcome).toMatchObject({ status: "failed", error: "Store weg" });
  });
});

/** Legt eine lokale Ablage an und setzt MEMORY_FILE_PATH darauf */
function useLocalFile(content: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "tybo-goals-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "memory.json");
  writeFileSync(file, JSON.stringify(content));
  process.env.MEMORY_FILE_PATH = file;
}

function useFileStore(content: unknown) {
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CONVEX_URL"]) delete process.env[k];
  useLocalFile(content);
  resetStore();
}

const FILE_MEMORY = {
  facts: [],
  goals: [
    { text: "Steuer abgeben", deadline: "2026-11-30T22:59:59.000Z", createdAt: "2026-10-02T08:00:00.000Z" },
    { text: "Bericht schreiben", createdAt: "2026-10-01T08:00:00.000Z" },
  ],
  completedGoals: [{ text: "Umzug erledigt", completedAt: "2026-09-01T08:00:00.000Z" }],
};

describe("goalsSource über den Gedächtnis-Dienst", () => {
  test("Datei-Store: offene Ziele, erledigte fehlen", async () => {
    useFileStore(FILE_MEMORY);
    const outcome = await runSource(goalsSource(), { env: { USER_TIMEZONE: "Europe/Berlin" }, now: NOW });
    expect(outcome.status === "ok" && outcome.section.items).toEqual([
      { text: "Steuer abgeben", due: "2026-11-30" },
      { text: "Bericht schreiben" },
    ]);
  });

  test("Supabase: completed=true fehlt, Abfrage mit dem Service-Schlüssel", async () => {
    const fake = useMemoryTable({
      rows: [
        { type: "goal", content: "Laufen lernen", completed: false, deadline: null },
        { type: "goal", content: "Alter Erfolg", completed: true, completed_at: "2026-10-05T08:00:00Z" },
        { type: "fact", content: "Alex trinkt Tee" },
      ],
    });
    cleanups.push(() => fake.restore());
    const outcome = await runSource(goalsSource(), { env: {}, now: NOW });
    expect(outcome.status === "ok" && outcome.section.items).toEqual([{ text: "Laufen lernen" }]);
    const reads = fake.requests.filter(r => r.url.pathname === "/rest/v1/memory");
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.headers.get("apikey")).toBe("test-service-key");
  });
});

describe("Morgenbriefing (draftBriefing)", () => {
  test("Abschnitt goals ohne erledigte Ziele, mit Anzahl", async () => {
    useFileStore(FILE_MEMORY);
    process.env.USER_TIMEZONE = "Europe/Berlin";
    const { part } = await briefingGoals();
    expect(part?.symbol).toBe("🎯");
    expect(part?.lines.join("\n")).not.toContain("Umzug");
    expect(part?.lines).toEqual(["• Steuer abgeben (bis 2026-11-30)", "• Bericht schreiben"]);
    expect(part?.count).toBe(2);
  });

  test("Datei mit mehr als fünf Zielen: alle offenen in Datei-Reihenfolge, ohne Überfällig-Markierung", async () => {
    const goals = Array.from({ length: 7 }, (_, i) => ({ text: `Ziel ${i + 1}`, createdAt: `2026-10-0${7 - i}T08:00:00.000Z` }));
    goals.splice(3, 0, { text: "Frist vorbei", deadline: "2026-10-01T10:00:00.000Z", createdAt: "2026-09-01T08:00:00.000Z" } as never);
    useFileStore({ facts: [], goals, completedGoals: [{ text: "Erledigt", completedAt: "2026-09-01T08:00:00.000Z" }] });
    process.env.USER_TIMEZONE = "Europe/Berlin";
    const { part } = await briefingGoals();
    expect(part?.lines).toEqual([
      "• Ziel 1",
      "• Ziel 2",
      "• Ziel 3",
      "• Frist vorbei (bis 2026-10-01)",
      "• Ziel 4",
      "• Ziel 5",
      "• Ziel 6",
      "• Ziel 7",
    ]);
    expect(part?.count).toBe(8);
  });

  test("ohne Ziele: Hinweiszeile", async () => {
    useFileStore({ facts: [], goals: [], completedGoals: [{ text: "Fertig", completedAt: "2026-09-01T08:00:00.000Z" }] });
    expect((await briefingGoals()).part?.lines).toEqual(["Keine offenen Ziele"]);
  });
});

describe("Supabase scheitert: Rückfall auf lokale Ziele (draftBriefing)", () => {
  /** Supabase-Attrappe, deren Tabelle memory mit answer antwortet */
  function useFailingSupabase(answer: () => Response | Promise<Response>) {
    const fake = useFakeSupabase({ respond: r => (r.url.pathname === "/rest/v1/memory" ? answer() : undefined) });
    cleanups.push(() => fake.restore());
    process.env.USER_TIMEZONE = "Europe/Berlin";
    return fake;
  }
  const unauthorized = () => new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401, headers: { "Content-Type": "application/json" } });
  const offline = () => Promise.reject(new TypeError("fetch failed"));

  for (const [name, answer] of [
    ["401", unauthorized],
    ["Netzfehler", offline],
  ] as const) {
    test(`${name}: offene lokale Ziele in Datei-Reihenfolge, kein Fehler`, async () => {
      const fake = useFailingSupabase(answer);
      useLocalFile(FILE_MEMORY);
      const { part, failed } = await briefingGoals();
      expect(fake.requests.some(r => r.url.pathname === "/rest/v1/memory")).toBe(true);
      expect(failed).toBe(false);
      expect(part?.lines).toEqual(["• Steuer abgeben (bis 2026-11-30)", "• Bericht schreiben"]);
      expect(part?.count).toBe(2);
    });

    test(`${name} ohne lokale Ziele: Fehlerhinweis statt „Keine offenen Ziele"`, async () => {
      useFailingSupabase(answer);
      useLocalFile({ facts: [], goals: [], completedGoals: [{ text: "Fertig", completedAt: "2026-09-01T08:00:00.000Z" }] });
      const { part, failed } = await briefingGoals();
      expect(part).toBeUndefined();
      expect(failed).toBe(true);
      const outcome = await runSource(goalsSource(), { now: NOW });
      expect(outcome.status === "failed" && outcome.error).toContain("Supabase");
    });
  }

  test("ohne lokale Ablage: Fehler, und es entsteht keine", async () => {
    useFailingSupabase(unauthorized);
    const dir = mkdtempSync(join(tmpdir(), "tybo-goals-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    process.env.MEMORY_FILE_PATH = join(dir, "memory.json");
    expect((await briefingGoals()).failed).toBe(true);
    expect(existsSync(join(dir, "memory.json.sqlite"))).toBe(false);
  });

  test("leere Supabase-Liste bleibt leer, lokale Ziele zählen dann nicht", async () => {
    const fake = useMemoryTable({ rows: [{ type: "fact", content: "Alex trinkt Tee" }] });
    cleanups.push(() => fake.restore());
    useLocalFile(FILE_MEMORY);
    const { part, failed } = await briefingGoals();
    expect(failed).toBe(false);
    expect(part?.lines).toEqual(["Keine offenen Ziele"]);
    expect(part?.count).toBe(0);
  });
});
