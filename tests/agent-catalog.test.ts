import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, readdirSync, readFileSync, existsSync, mkdirSync, chmodSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  addMissingBuiltinPrompts,
  BUILTIN_AGENTS,
  AgentCatalogError,
  AgentCatalogFileInvalid,
  createAgent,
  deleteAgent,
  getAgent,
  getAgentCatalogPaths,
  listAgentNames,
  listAgents,
  listDeletedBuiltins,
  resetPrompt,
  restoreBuiltin,
  setAgentCatalogPaths,
  setBoard,
  setPrompt,
  PROMPT_MAX,
} from "../src/agents/catalog";
import { AGENT_NAMES } from "../src/agents/names";

// Nur temporäre Dateien: nie config/agents.json, config/topics.json oder data/backups.

let dir: string;
let file: string;
let backupDir: string;
let topicsFile: string;
let tick = 10_000;

function putCatalog(value: unknown) {
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  tick += 10;
  utimesSync(file, tick, tick);
}

const backups = () => (existsSync(backupDir) ? readdirSync(backupDir).sort() : []);
const readCatalog = () => JSON.parse(readFileSync(file, "utf-8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-agent-catalog-"));
  file = join(dir, "agents.json");
  backupDir = join(dir, "backups");
  topicsFile = join(dir, "topics.json");
  setAgentCatalogPaths({ file, backupDir, topicsFile });
});

afterEach(() => {
  setAgentCatalogPaths();
  rmSync(dir, { recursive: true, force: true });
});

const custom = { name: "projekt-planer", description: "Plant Projekte", systemPrompt: "Du planst Projekte." };

describe("Katalog lesen", () => {
  test("ohne Datei: genau die mitgelieferten Agenten mit Prompt aus dem Code", () => {
    expect(listAgentNames()).toEqual([...AGENT_NAMES]);
    const research = getAgent("research")!;
    expect(research.origin).toBe("builtin");
    expect(research.promptSource).toBe("code");
    expect(research.systemPrompt).toBe(require("../src/agents/research").default.systemPrompt);
    expect(research.board).toBe(true);
    expect(getAgent("general")!.board).toBe(false);
    expect(listDeletedBuiltins()).toEqual([]);
  });

  test("Aliasse lösen auf, unbekannte Namen nicht", () => {
    expect(getAgent("CFO")!.name).toBe("finance");
    expect(getAgent("orchestrator")!.name).toBe("general");
    expect(getAgent("unbekannt")).toBeUndefined();
  });

  test("Datei mit geändertem Prompt, eigenem Agenten, gelöschtem und Board-Schalter", () => {
    putCatalog({
      prompts: { research: "Neuer Research-Prompt" },
      custom: [{ ...custom, board: true }],
      deleted: ["cto"],
      board: { critic: false },
    });
    const agents = listAgents();
    expect(agents.map(a => a.name)).toEqual(["general", "research", "content", "finance", "strategy", "critic", "coo", "projekt-planer"]);
    expect(getAgent("research")).toMatchObject({ promptSource: "custom", systemPrompt: "Neuer Research-Prompt" });
    expect(getAgent("projekt-planer")).toMatchObject({ origin: "custom", promptSource: "custom", board: true, description: "Plant Projekte" });
    expect(getAgent("critic")!.board).toBe(false);
    expect(getAgent("cto")).toBeUndefined();
    expect(getAgent("dev")).toBeUndefined();
    expect(listDeletedBuiltins()).toEqual(["cto"]);
  });

  test("Hot-Reload: Änderung der Datei gilt ohne Neustart", () => {
    putCatalog({});
    expect(getAgent("projekt-planer")).toBeUndefined();
    putCatalog({ custom: [custom] });
    expect(getAgent("projekt-planer")!.name).toBe("projekt-planer");
    rmSync(file);
    expect(getAgent("projekt-planer")).toBeUndefined();
  });

  test("kaputte Datei: letzte gültige Fassung bleibt, mit Log-Zeile", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      putCatalog({ custom: [custom] });
      expect(getAgent("projekt-planer")).toBeDefined();
      putCatalog("{ kein json");
      expect(getAgent("projekt-planer")).toBeDefined();
      putCatalog({ custom: [{ ...custom, name: "research" }] });
      expect(listAgentNames()).toContain("projekt-planer");
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  test("nach dem Schreiben ohne Leseabfrage beschädigt: der zuletzt geschriebene Stand gilt", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      // Agent anlegen, danach kein Lesen; die Datei wird beschädigt
      await createAgent(custom);
      putCatalog("{ kein json");
      expect(getAgent("projekt-planer")).toMatchObject({ origin: "custom", systemPrompt: custom.systemPrompt });

      // Prompt ändern, wieder ohne Lesen dazwischen
      setAgentCatalogPaths({ file, backupDir, topicsFile });
      putCatalog({});
      await setPrompt("finance", "Neuer Finance-Prompt");
      putCatalog("{ kein json");
      expect(getAgent("finance")).toMatchObject({ promptSource: "custom", systemPrompt: "Neuer Finance-Prompt" });
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  test("ungültige Inhalte werden beim Lesen verworfen (Regeln wie beim Schreiben)", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const bad of [
        { deleted: ["general"] },
        { deleted: ["gibtsnicht"] },
        { prompts: { "projekt-planer": "x" } },
        { custom: [{ ...custom, name: "cfo" }] },
        { custom: [custom, custom] },
        { custom: [{ ...custom, description: "" }] },
        { custom: [{ ...custom, systemPrompt: "x".repeat(PROMPT_MAX + 1) }] },
        { unbekannt: true },
      ]) {
        setAgentCatalogPaths({ file, backupDir, topicsFile });
        putCatalog(bad);
        expect(listAgentNames()).toEqual([...AGENT_NAMES]);
      }
    } finally {
      err.mockRestore();
    }
  });

  test("Pfade für Tests setzbar, ohne Argument die echten", () => {
    expect(getAgentCatalogPaths()).toEqual({ file, backupDir, topicsFile });
    setAgentCatalogPaths();
    const real = getAgentCatalogPaths();
    expect(real.file).toBe(join(process.cwd(), "config", "agents.json"));
    expect(real.backupDir).toBe(join(process.cwd(), "data", "backups"));
    expect(real.topicsFile).toBe(join(process.cwd(), "config", "topics.json"));
    setAgentCatalogPaths({ file, backupDir, topicsFile });
  });
});

describe("Katalog schreiben", () => {
  test("setPrompt gilt, resetPrompt stellt den Code-Prompt her", async () => {
    const code = getAgent("finance")!.systemPrompt;
    await setPrompt("finance", "Geänderter Finance-Prompt");
    expect(getAgent("finance")).toMatchObject({ promptSource: "custom", systemPrompt: "Geänderter Finance-Prompt" });
    expect(readCatalog()).toEqual({ prompts: { finance: "Geänderter Finance-Prompt" } });
    await resetPrompt("cfo");
    expect(getAgent("finance")).toMatchObject({ promptSource: "code", systemPrompt: code });
    expect(readCatalog()).toEqual({});
  });

  test("setPrompt bei eigenem Agenten ändert dessen Prompt; resetPrompt dort abgelehnt", async () => {
    await createAgent(custom);
    await setPrompt("projekt-planer", "Neu");
    expect(getAgent("projekt-planer")!.systemPrompt).toBe("Neu");
    await expect(resetPrompt("projekt-planer")).rejects.toThrow(AgentCatalogError);
    expect(getAgent("projekt-planer")!.systemPrompt).toBe("Neu");
  });

  test("Prompt-Grenzen: leer und über 20.000 Zeichen abgelehnt, genau 20.000 erlaubt", async () => {
    await expect(setPrompt("research", "")).rejects.toThrow(AgentCatalogError);
    await expect(setPrompt("research", "   \n ")).rejects.toThrow(AgentCatalogError);
    await expect(setPrompt("research", "x".repeat(PROMPT_MAX + 1))).rejects.toThrow(AgentCatalogError);
    await setPrompt("research", "x".repeat(PROMPT_MAX));
    expect(getAgent("research")!.systemPrompt.length).toBe(PROMPT_MAX);
    await expect(createAgent({ ...custom, systemPrompt: "" })).rejects.toThrow(AgentCatalogError);
    await expect(createAgent({ ...custom, systemPrompt: "x".repeat(PROMPT_MAX + 1) })).rejects.toThrow(AgentCatalogError);
  });

  test("Beschreibung-Grenzen: 1 bis 200 Zeichen, eine Zeile", async () => {
    for (const description of ["", "   ", "x".repeat(201), "zwei\nZeilen"]) {
      await expect(createAgent({ ...custom, description })).rejects.toThrow(AgentCatalogError);
    }
    const agent = await createAgent({ ...custom, description: "x".repeat(200) });
    expect(agent.description.length).toBe(200);
    await createAgent({ ...custom, name: "kurz", description: "k" });
    expect(listAgentNames()).toEqual([...AGENT_NAMES, "projekt-planer", "kurz"]);
  });

  test("createAgent: ungültige Kennungen und Kollisionen abgelehnt", async () => {
    for (const name of ["", "a", "1abc", "Groß", "mit_unterstrich", "mit leer", "-x", "x".repeat(31), "ä-agent"]) {
      await expect(createAgent({ ...custom, name })).rejects.toThrow(/Kennung/);
    }
    // Namen, Aliasse aus names.ts und aus /agent in bot.ts
    for (const name of ["general", "research", "cfo", "orchestrator", "devils-advocate", "development", "outreach", "tech"]) {
      await expect(createAgent({ ...custom, name })).rejects.toThrow(/vergeben/);
    }
    await createAgent(custom);
    await expect(createAgent(custom)).rejects.toThrow(/vergeben/);
    // gelöschte mitgelieferte bleiben reserviert, sonst kollidiert restoreBuiltin
    await deleteAgent("cto");
    await expect(createAgent({ ...custom, name: "cto" })).rejects.toThrow(/vergeben/);
    expect(existsSync(file) && readCatalog().custom).toEqual([custom]);
  });

  test("createAgent: Board aus, wenn nicht eingeschaltet", async () => {
    expect((await createAgent(custom)).board).toBe(false);
    expect((await createAgent({ ...custom, name: "board-agent", board: true })).board).toBe(true);
  });

  test("deleteAgent: general abgelehnt, gelöschter verschwindet, restoreBuiltin holt ihn mit Code-Stand zurück", async () => {
    await expect(deleteAgent("general")).rejects.toThrow(AgentCatalogError);
    await expect(deleteAgent("orchestrator")).rejects.toThrow(AgentCatalogError);
    await setPrompt("critic", "geändert");
    await setBoard("critic", false);
    await deleteAgent("critic");
    expect(listAgentNames()).not.toContain("critic");
    expect(getAgent("critic")).toBeUndefined();
    expect(listDeletedBuiltins()).toEqual(["critic"]);
    await expect(deleteAgent("critic")).rejects.toThrow(AgentCatalogError);
    await expect(setPrompt("critic", "x")).rejects.toThrow(AgentCatalogError);
    const restored = await restoreBuiltin("critic");
    expect(restored).toMatchObject({ name: "critic", promptSource: "code", board: true });
    expect(listAgentNames()).toEqual([...AGENT_NAMES]);
    await expect(restoreBuiltin("critic")).rejects.toThrow(AgentCatalogError);
    await expect(restoreBuiltin("projekt-planer")).rejects.toThrow(AgentCatalogError);
  });

  test("deleteAgent: eigener Agent ist endgültig weg", async () => {
    await createAgent(custom);
    await deleteAgent("projekt-planer");
    expect(getAgent("projekt-planer")).toBeUndefined();
    expect(listDeletedBuiltins()).toEqual([]);
    await expect(restoreBuiltin("projekt-planer")).rejects.toThrow(AgentCatalogError);
  });

  test("setBoard: schaltet mitgelieferte und eigene, General abgelehnt", async () => {
    await setBoard("research", false);
    expect(getAgent("research")!.board).toBe(false);
    await setBoard("research", true);
    expect(getAgent("research")!.board).toBe(true);
    await createAgent(custom);
    await setBoard("projekt-planer", true);
    expect(getAgent("projekt-planer")!.board).toBe(true);
    expect(readCatalog().custom[0].board).toBe(true);
    await expect(setBoard("general", true)).rejects.toThrow(AgentCatalogError);
    await expect(setBoard("gibtsnicht", true)).rejects.toThrow(AgentCatalogError);
  });

  test("board-Schalter hat Vorrang vor custom[].board", () => {
    putCatalog({ custom: [{ ...custom, board: true }], board: { "projekt-planer": false } });
    expect(getAgent("projekt-planer")!.board).toBe(false);
  });

  test("vor jedem Schreiben liegt eine Sicherung der vorigen Fassung vor; erstes Schreiben ohne Vorgänger", async () => {
    await setPrompt("research", "eins");
    expect(backups()).toEqual([]);
    const first = readFileSync(file, "utf-8");
    await setPrompt("research", "zwei");
    expect(backups().length).toBe(1);
    expect(readFileSync(join(backupDir, backups()[0]), "utf-8")).toBe(first);
    expect(backups()[0]).toMatch(/^agents-.+\.json$/);
    const second = readFileSync(file, "utf-8");
    await createAgent(custom);
    await setBoard("projekt-planer", true);
    await deleteAgent("projekt-planer");
    await restoreBuiltin("research").catch(() => {});
    expect(backups().length).toBe(4);
    const contents = backups().map(b => readFileSync(join(backupDir, b), "utf-8"));
    expect(contents).toContain(second);
  });

  test("Sicherung schlägt fehl: nichts geschrieben", async () => {
    await setPrompt("research", "eins");
    const before = readFileSync(file, "utf-8");
    // Sicherungsziel ist eine Datei statt eines Ordners
    writeFileSync(backupDir, "kein ordner");
    await expect(setPrompt("research", "zwei")).rejects.toThrow();
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(getAgent("research")!.systemPrompt).toBe("eins");
  });

  test("gleichzeitige Schreibvorgänge verlieren nichts, eindeutige Sicherungen", async () => {
    const names = Array.from({ length: 8 }, (_, i) => `agent-${i}`);
    await Promise.all([
      ...names.map(name => createAgent({ ...custom, name })),
      setPrompt("research", "parallel"),
      setBoard("critic", false),
    ]);
    expect(listAgentNames()).toEqual(expect.arrayContaining(names));
    expect(getAgent("research")!.systemPrompt).toBe("parallel");
    expect(getAgent("critic")!.board).toBe(false);
    // 10 Schreibvorgänge, der erste ohne Vorgänger
    expect(new Set(backups()).size).toBe(9);
  });

  test("kaputte Datei wird beim Schreiben nicht überschrieben; Lesen bleibt beim letzten gültigen Stand", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await createAgent(custom);
      expect(getAgent("projekt-planer")).toBeDefined();
      putCatalog("{ kaputt");
      expect(getAgent("projekt-planer")).toBeDefined();
      await expect(setPrompt("research", "x")).rejects.toThrow(AgentCatalogFileInvalid);
      await expect(createAgent({ ...custom, name: "zweiter" })).rejects.toThrow(AgentCatalogFileInvalid);
      expect(readFileSync(file, "utf-8")).toBe("{ kaputt");
      putCatalog({ deleted: ["general"] });
      await expect(setBoard("research", false)).rejects.toThrow(AgentCatalogFileInvalid);
      expect(readCatalog()).toEqual({ deleted: ["general"] });
    } finally {
      err.mockRestore();
    }
  });

  test("Schreiben ersetzt atomar mit Rechten 0600", async () => {
    await setPrompt("research", "eins");
    const { statSync } = require("fs");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter(n => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("addMissingBuiltinPrompts (Issue #136)", () => {
  const ALL = Object.keys(BUILTIN_AGENTS);
  const saved = Object.fromEntries(ALL.map(n => [n, `Gesicherter Prompt für ${n}`]));
  const fileState = () => {
    const st = statSync(file);
    return { text: readFileSync(file, "utf-8"), ino: st.ino, mtimeMs: st.mtimeMs };
  };

  test("Datei fehlt: wird mit allen acht angelegt, ohne Sicherung", async () => {
    const result = await addMissingBuiltinPrompts(saved);
    expect(result).toEqual({ added: ALL, skipped: [], written: true, backup: null });
    expect(backups()).toEqual([]);
    expect(readCatalog()).toEqual({ prompts: saved });
    for (const name of ALL) {
      expect(getAgent(name)).toMatchObject({ promptSource: "custom", systemPrompt: saved[name] });
    }
    expect(listAgents().map(a => [a.name, a.promptSource, a.systemPrompt])).toEqual(ALL.map(n => [n, "custom", saved[n]]));
  });

  test("gültiges {}: alle acht ergänzt, vorige Fassung gesichert, Pfad zurückgegeben", async () => {
    putCatalog({});
    const result = await addMissingBuiltinPrompts(saved);
    expect(result.added).toEqual(ALL);
    expect(result.written).toBe(true);
    expect(backups().length).toBe(1);
    expect(result.backup).toBe(join(backupDir, backups()[0]));
    expect(readFileSync(result.backup!, "utf-8")).toBe("{}");
    expect(readCatalog()).toEqual({ prompts: saved });
  });

  test("vorhandener Eintrag bleibt wortgleich, custom/deleted/board (auch leere) bleiben, Gelöschter bleibt gelöscht", async () => {
    const before = {
      prompts: { research: "Mein eigener Research-Prompt\nmit Zeilen" },
      custom: [{ ...custom, board: true }],
      deleted: ["cto"],
      board: { critic: false },
    };
    putCatalog(before);
    const result = await addMissingBuiltinPrompts(saved);
    expect(result.added).toEqual(ALL.filter(n => n !== "research" && n !== "cto"));
    expect(result.skipped).toEqual([
      { name: "research", reason: "eigener Eintrag" },
      { name: "cto", reason: "gelöscht" },
    ]);
    const after = readCatalog();
    expect(after.prompts.research).toBe(before.prompts.research);
    expect(after.prompts.cto).toBeUndefined();
    expect(after.custom).toEqual(before.custom);
    expect(after.deleted).toEqual(["cto"]);
    expect(after.board).toEqual({ critic: false });
    expect(getAgent("research")!.systemPrompt).toBe(before.prompts.research);
    expect(getAgent("cto")).toBeUndefined();
    expect(listDeletedBuiltins()).toEqual(["cto"]);
    expect(getAgent("finance")).toMatchObject({ promptSource: "custom", systemPrompt: saved.finance });

    // Leere Abschnitte werden nicht aufgeräumt
    putCatalog({ custom: [], deleted: [], board: {} });
    await addMissingBuiltinPrompts({ general: "g" });
    expect(readCatalog()).toEqual({ custom: [], deleted: [], board: {}, prompts: { general: "g" } });
  });

  test("ungültige Datei (0 Byte, Null-Bytes, kaputtes JSON, falsches Schema): Abbruch, unverändert, keine Sicherung", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const content of ["", "\u0000\u0000\u0000", "{ kaputt", JSON.stringify({ unbekannt: 1 })]) {
        putCatalog(content);
        for (const dryRun of [false, true]) {
          await expect(addMissingBuiltinPrompts(saved, { dryRun })).rejects.toThrow(AgentCatalogFileInvalid);
          expect(readFileSync(file, "utf-8")).toBe(content);
          expect(backups()).toEqual([]);
        }
      }
    } finally {
      err.mockRestore();
    }
  });

  test("ungültiger Prompt zwischen gültigen oder unbekannter Name: alles abgebrochen, auch bei dryRun", async () => {
    putCatalog({});
    const before = fileState();
    for (const dryRun of [false, true]) {
      for (const bad of [{ research: "   " }, { research: "x".repeat(PROMPT_MAX + 1) }, { "kein-agent": "x" }]) {
        await expect(addMissingBuiltinPrompts({ general: "g", ...bad, finance: "f" }, { dryRun })).rejects.toThrow(AgentCatalogError);
      }
    }
    expect(fileState()).toEqual(before);
    expect(backups()).toEqual([]);
  });

  test("Sicherung schlägt fehl: Abbruch, Zieldatei unverändert", async () => {
    putCatalog({ board: { critic: false } });
    const before = readFileSync(file, "utf-8");
    writeFileSync(backupDir, "kein ordner");
    await expect(addMissingBuiltinPrompts(saved)).rejects.toThrow();
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(getAgent("research")!.promptSource).toBe("code");
  });

  test("zweiter Lauf ergänzt nichts und schreibt nichts (Inhalt, Inode, mtime, keine neue Sicherung)", async () => {
    putCatalog({});
    await addMissingBuiltinPrompts(saved);
    const before = fileState();
    const backupsBefore = backups();
    const again = await addMissingBuiltinPrompts(saved);
    expect(again).toEqual({
      added: [],
      skipped: ALL.map(name => ({ name, reason: "eigener Eintrag" })),
      written: false,
      backup: null,
    });
    expect(fileState()).toEqual(before);
    expect(backups()).toEqual(backupsBefore);
  });

  test("dryRun: nichts geschrieben, keine Sicherung, Rückgabe wie beim echten Lauf", async () => {
    // Ohne Datei: bleibt ohne Datei
    const dryMissing = await addMissingBuiltinPrompts(saved, { dryRun: true });
    expect(dryMissing).toEqual({ added: ALL, skipped: [], written: false, backup: null });
    expect(existsSync(file)).toBe(false);

    putCatalog({ prompts: { research: "eigen" }, deleted: ["coo"] });
    const before = fileState();
    const dry = await addMissingBuiltinPrompts(saved, { dryRun: true });
    expect(fileState()).toEqual(before);
    expect(backups()).toEqual([]);
    const real = await addMissingBuiltinPrompts(saved);
    expect(dry.added).toEqual(real.added);
    expect(dry.skipped).toEqual(real.skipped);
    expect(real.written).toBe(true);
  });
});

describe("Löschen stellt Topics auf General um", () => {
  const putTopics = (value: unknown) => writeFileSync(topicsFile, typeof value === "string" ? value : JSON.stringify(value));
  const readTopics = () => JSON.parse(readFileSync(topicsFile, "utf-8"));

  test("alle Chat-IDs, der Schlüssel * und Aliasse; Rückgabe als Chat-ID/Topic-ID", async () => {
    putTopics({
      "-1001": { "3": "finance", "4": "research", "5": "CFO" },
      "-1002": { "9": "finance" },
      "*": { "7": "cfo", "8": "general" },
    });
    const { topics } = await deleteAgent("finance");
    expect(topics).toEqual([
      { chatId: "-1001", topicId: 3 },
      { chatId: "-1001", topicId: 5 },
      { chatId: "-1002", topicId: 9 },
      { chatId: "*", topicId: 7 },
    ]);
    expect(readTopics()).toEqual({
      "-1001": { "3": "general", "4": "research", "5": "general" },
      "-1002": { "9": "general" },
      "*": { "7": "general", "8": "general" },
    });
  });

  test("eigener Agent: seine Topics zeigen danach auf general", async () => {
    await createAgent(custom);
    putTopics({ "-1001": { "12": "projekt-planer", "13": "research" } });
    expect((await deleteAgent("projekt-planer")).topics).toEqual([{ chatId: "-1001", topicId: 12 }]);
    expect(readTopics()).toEqual({ "-1001": { "12": "general", "13": "research" } });
  });

  test("ohne Treffer oder ohne Datei bleibt topics.json unberührt", async () => {
    expect((await deleteAgent("coo")).topics).toEqual([]);
    expect(existsSync(topicsFile)).toBe(false);
    const content = JSON.stringify({ "-1001": { "3": "research" } });
    putTopics(content);
    expect((await deleteAgent("content")).topics).toEqual([]);
    expect(readFileSync(topicsFile, "utf-8")).toBe(content);
  });

  test("kaputte topics.json: Abbruch vor dem Katalog, nichts geändert", async () => {
    putTopics("{ kaputt");
    await expect(deleteAgent("finance")).rejects.toThrow(/topics\.json/);
    expect(getAgent("finance")).toBeDefined();
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(topicsFile, "utf-8")).toBe("{ kaputt");
    putTopics("[]");
    await expect(deleteAgent("finance")).rejects.toThrow();
    expect(getAgent("finance")).toBeDefined();
  });

  test("Fehler zwischen Katalog- und Topic-Schreiben: Agent gelöscht, Fehler gemeldet, Topics unverändert", async () => {
    // topics.json lesbar, aber ihr Ordner nicht beschreibbar
    const topicsDir = join(dir, "nur-lesen");
    mkdirSync(topicsDir);
    const lockedTopics = join(topicsDir, "topics.json");
    writeFileSync(lockedTopics, JSON.stringify({ "-1001": { "3": "finance" } }));
    chmodSync(topicsDir, 0o555);
    setAgentCatalogPaths({ file, backupDir, topicsFile: lockedTopics });
    try {
      await expect(deleteAgent("finance")).rejects.toThrow();
      expect(getAgent("finance")).toBeUndefined();
      expect(JSON.parse(readFileSync(lockedTopics, "utf-8"))).toEqual({ "-1001": { "3": "finance" } });
    } finally {
      chmodSync(topicsDir, 0o755);
    }
  });

  test("parallele Topic-Zuordnungen gehen nicht verloren", async () => {
    const { setTopicMapping } = await import("../src/lib/topic-setup");
    putTopics({ "-1001": { "1": "finance" } });
    const [, , deleted] = await Promise.all([
      setTopicMapping("-1001", 2, "finance", topicsFile),
      setTopicMapping("-1001", 3, "research", topicsFile),
      deleteAgent("finance"),
      setTopicMapping("-1002", 4, "content", topicsFile),
    ]);
    expect(readTopics()).toEqual({
      "-1001": { "1": "general", "2": "general", "3": "research" },
      "-1002": { "4": "content" },
    });
    expect(deleted.topics).toEqual([
      { chatId: "-1001", topicId: 1 },
      { chatId: "-1001", topicId: 2 },
    ]);
  });
});
