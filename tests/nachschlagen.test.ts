/**
 * Issue #523: history_search sucht auch in Fakten, und Claude Code kommt über
 * bun run nachschlagen zum selben Ergebnis. Der Prompt erklärt den Weg. Die
 * Tests hier setzen Quellen ein; den echten Prozess startet einer ohne Datenbank,
 * mit leerer Umgebung wie ein Subprozess und einer .env im Arbeitsordner. Gegen
 * echtes PostgreSQL, auch mit ausgefallenen Quellen: tests/fact-followup-pg.test.ts.
 * Alle Daten sind erfunden.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { factLookupSection } from "../src/agents/prompt-parts";
import { buildPromptContext, type PromptSources } from "../src/lib/prompt-builder";
import { fileMemory } from "../src/lib/store/file/memory";
import type { MemoryItem } from "../src/lib/store/types";
import { createHistorySearchHandler, type HistorySearchDeps } from "../src/lib/tools/history-search";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, parseArgs, runLookup } from "../scripts/nachschlagen";

const REPO = resolve(import.meta.dir, "..");

const fact = (id: string, content: string, created_at = "2026-03-15T12:00:00.000Z"): MemoryItem => ({ id, type: "fact", content, created_at });

const emptyDeps = (over: Partial<HistorySearchDeps> = {}): HistorySearchDeps => ({
  chatIds: () => ["1"],
  searchMessages: async () => [],
  knowledgeContext: async () => "",
  searchImages: async () => [],
  searchFacts: async () => [],
  ...over,
});

describe("history_search: Fakten", () => {
  test("Treffer stehen mit Datum und Vorbehalt im Ergebnis, die Suche fragt nach Bedeutung", async () => {
    const asked: unknown[] = [];
    const handler = createHistorySearchHandler(emptyDeps({
      searchFacts: async (query, limit) => {
        asked.push({ query, limit });
        return [fact("7", "Der Hund von Mia heißt Bruno")];
      },
    }));
    const out = JSON.parse(await handler({ query: "Hund von Mia", limit: 3 }));
    expect(asked).toEqual([{ query: "Hund von Mia", limit: 3 }]);
    expect(out.facts).toEqual([{ date: "2026-03-15", text: "Der Hund von Mia heißt Bruno" }]);
    expect(out.facts_note).toContain("Anlagedatum");
    expect(out.hint).toBeUndefined();
    expect(out.unavailable).toBeUndefined();
  });

  test("Nulltreffer: Hinweis auf andere Begriffe, keine Quelle gilt als gescheitert", async () => {
    const out = JSON.parse(await createHistorySearchHandler(emptyDeps())({ query: "Unbekanntes" }));
    expect(out.facts).toBeUndefined();
    expect(out.unavailable).toBeUndefined();
    expect(out.hint).toContain("Keine Treffer");
  });

  test("Suchfehler: von Nulltreffern unterscheidbar, die übrigen Quellen liefern weiter", async () => {
    const failing = emptyDeps({ searchFacts: async () => { throw new Error("Datenbank weg"); } });
    const none = JSON.parse(await createHistorySearchHandler(failing)({ query: "Hund" }));
    expect(none.unavailable).toEqual(["facts"]);
    expect(none.hint).toContain("gescheitert");
    expect(none.hint).not.toContain("Datenbank weg");

    const partial = JSON.parse(
      await createHistorySearchHandler({ ...failing, knowledgeContext: async () => "- Wissen zum Hund" })({ query: "Hund" }),
    );
    expect(partial.unavailable).toEqual(["facts"]);
    expect(partial.knowledge_base).toContain("Wissen zum Hund");
    expect(partial.hint).toBeUndefined();
  });

  test("ein unlesbares Datum wird nicht zum heutigen", async () => {
    const handler = createHistorySearchHandler(emptyDeps({ searchFacts: async () => [{ id: "1", type: "fact", content: "Ohne Datum" }] }));
    expect(JSON.parse(await handler({ query: "Datum" })).facts[0].date).toBe("Anlagedatum unbekannt");
  });
});

describe("bun run nachschlagen", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, print: (t: string) => void out.push(t), printError: (t: string) => void err.push(t) };
  };

  test("Argumente", () => {
    expect(parseArgs(["Hund", "von", "Mia"])).toEqual({ query: "Hund von Mia" });
    expect(parseArgs(["--limit", "3", "Hund"])).toEqual({ query: "Hund", limit: 3 });
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(["--limit", "viele", "Hund"])).toBeNull();
    expect(parseArgs(["--was", "Hund"])).toBeNull();
  });

  test("Exit-Codes: Treffer und Nulltreffer 0, Fehler ohne Treffer 1, falsche Eingabe 2", async () => {
    const hit = io();
    expect(await runLookup(["Hund"], { ...hit, search: async () => JSON.stringify({ query: "Hund", facts: [{ text: "x" }] }) })).toBe(EXIT_OK);
    expect(hit.out).toHaveLength(1);
    const nothing = io();
    expect(await runLookup(["Hund"], { ...nothing, search: async () => JSON.stringify({ query: "Hund", hint: "Keine Treffer" }) })).toBe(EXIT_OK);
    const broken = io();
    expect(await runLookup(["Hund"], { ...broken, search: async () => JSON.stringify({ query: "Hund", unavailable: ["facts"], hint: "gescheitert" }) })).toBe(EXIT_FAILED);
    expect(broken.out).toHaveLength(1);
    const partial = io();
    expect(await runLookup(["Hund"], { ...partial, search: async () => JSON.stringify({ query: "Hund", unavailable: ["facts"], messages: [{}] }) })).toBe(EXIT_OK);
    const thrown = io();
    expect(await runLookup(["Hund"], { ...thrown, search: async () => { throw new Error("geheim"); } })).toBe(EXIT_FAILED);
    expect(thrown.err.join()).not.toContain("geheim");
    const usage = io();
    expect(await runLookup([], { ...usage, search: async () => "{}" })).toBe(EXIT_USAGE);
    expect(usage.err.join()).toContain("bun run nachschlagen");
  });

  describe("als eigener Prozess", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "tybo-nachschlagen-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test("findet einen Fakt der Ablage, ohne Geheimnisse in der Umgebung, die .env reicht", async () => {
      const path = join(dir, "memory.json");
      await fileMemory(() => path).addFact("Der Hund von Mia heißt Bruno");
      writeFileSync(join(dir, ".env"), `MEMORY_FILE_PATH=${path}\n`);

      const run = Bun.spawnSync([process.execPath, "--no-env-file", join(REPO, "scripts", "nachschlagen.ts"), "Hund von Mia"], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", HOME: dir, TYBO_SUBPROCESS: "1" },
      });

      expect(run.exitCode).toBe(EXIT_OK);
      const out = JSON.parse(run.stdout.toString());
      expect(out.facts.map((f: { text: string }) => f.text)).toEqual(["Der Hund von Mia heißt Bruno"]);
    }, 30_000);
  });
});

describe("Anweisung im Prompt", () => {
  const QUIET: Partial<PromptSources> = {
    overrides: () => "",
    consultation: () => "",
    profile: async () => "",
    core: async () => "",
    memory: async () => "",
    knowledge: async () => "",
    recent: async () => [],
    similar: async () => [],
    now: () => new Date("2026-10-31T09:00:00.000Z"),
    timeZone: () => "UTC",
  };
  const agentWith = (allowedTools?: string[]): Partial<PromptSources> => ({
    agent: () => ({ name: "Test", systemPrompt: "SYSTEM", model: "m", ...(allowedTools ? { allowedTools } : {}) }) as never,
  });
  const promptFor = async (allowedTools?: string[]) =>
    (await buildPromptContext({ userMessage: "q", chatId: "1", agentName: "general" }, { ...QUIET, ...agentWith(allowedTools) })).fullPrompt;

  test("nennt Werkzeug und Befehl: erst nachschlagen, dann antworten oder sagen, dass nichts gefunden wurde", async () => {
    const prompt = await promptFor();
    expect(prompt).toContain("## LOOKING UP EARLIER INFORMATION");
    expect(prompt).toContain("history_search");
    expect(prompt).toContain('bun run nachschlagen "<search text>"');
    expect(prompt).toContain("look it up before you answer");
    expect(prompt).toContain("say that nothing was found");
    expect(prompt).toContain('"unavailable"');
  });

  test("Der Befehl ist in package.json eingetragen und zeigt auf das Skript", async () => {
    const pkg = await Bun.file(join(REPO, "package.json")).json();
    expect(pkg.scripts.nachschlagen).toBe("bun run scripts/nachschlagen.ts");
  });

  test("Werkzeugrechte: Der Agent bekommt nur den Weg, den er gehen darf", async () => {
    expect(factLookupSection(["Bash"])).toContain("bun run nachschlagen");
    expect(factLookupSection(["Bash"])).not.toContain("history_search");
    expect(factLookupSection(["Bash(bun run nachschlagen:*)"])).toContain("bun run nachschlagen");
    expect(factLookupSection(["history_search"])).toContain("history_search");
    expect(factLookupSection(["history_search"])).not.toContain("bun run nachschlagen");
    expect(factLookupSection(["Read", "WebSearch"])).toBe("");
    for (const allowed of ["Bash(bun:*)", "Bash(bun run:*)", "Bash(bun run nachschlagen *)", "Bash(*)"]) {
      expect(factLookupSection([allowed])).toContain("bun run nachschlagen");
    }
  });

  test("Werkzeugrechte: Eine Bash-Freigabe zählt nur, wenn sie den Befehl erlaubt", async () => {
    for (const allowed of ["Bash(git status:*)", "Bash(bun test:*)", "Bash(bun run nachschlagen)", "Bash(bun run nachschlagen-alt:*)"]) {
      expect(factLookupSection([allowed])).toBe("");
    }
    expect(await promptFor(["Bash(git status:*)"])).not.toContain("## LOOKING UP EARLIER INFORMATION");

    const onlyTool = factLookupSection(["Bash(git status:*)", "history_search"]);
    expect(onlyTool).toContain("use the tool history_search");
    expect(onlyTool).not.toContain("bun run nachschlagen");
    expect(await promptFor(["Read", "WebSearch"])).not.toContain("## LOOKING UP EARLIER INFORMATION");
  });
});
