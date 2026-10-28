/**
 * Issue #50: Agenten-API der WebUI über den Server mit dem echten Katalog
 * (src/agents/catalog.ts) und echten Einstellungen, alles in temporären
 * Dateien (setAgentCatalogPaths, setSettingsPath). Nie config/agents.json,
 * config/topics.json, config/settings.json oder data/backups.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, deleteAgent, setAgentCatalogPaths, setBoard, setPrompt } from "../src/agents/catalog";
import { AGENT_ID_PATTERN, AGENT_NAMES } from "../src/agents/names";
import { setSettingsPath } from "../src/lib/settings";
import { CATALOG_ID_PATTERN, PROMPT_MAX_CHARS } from "../src/web/agent-catalog";
import { botAgentCatalog } from "../src/web/bot-agents";
import { botSettings } from "../src/web/bot-settings";
import type { WebServer, WebServerDeps } from "../src/web/server";
import { chmodSync } from "node:fs";
import { botSetMapping } from "../src/web/bot-topics";
import { SETTINGS_TEXT, type SettingsPort } from "../src/web/settings";
import { GROUP, readMapping, topicEnv, topicServer, type ServerCtx } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "bot-agents-api-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
let dir: string;
let counter = 0;
let paths: { file: string; backupDir: string; topicsFile: string; settings: string };
const savedEffort = process.env.CLAUDE_EFFORT;

beforeEach(() => {
  delete process.env.CLAUDE_EFFORT;
  dir = join(root, `case-${++counter}`);
  mkdirSync(dir, { recursive: true });
  paths = {
    file: join(dir, "agents.json"),
    backupDir: join(dir, "backups"),
    topicsFile: join(dir, "topics.json"),
    settings: join(dir, "settings.json"),
  };
  setAgentCatalogPaths({ file: paths.file, backupDir: paths.backupDir, topicsFile: paths.topicsFile });
  setSettingsPath(paths.settings);
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  setAgentCatalogPaths();
  setSettingsPath();
  if (savedEffort === undefined) delete process.env.CLAUDE_EFFORT;
  else process.env.CLAUDE_EFFORT = savedEffort;
});

function server(deps: Partial<WebServerDeps> = {}): Promise<ServerCtx> {
  return topicServer(root, servers, null, { agentCatalog: botAgentCatalog, settings: botSettings, ...deps });
}

function putTopics(value: unknown) {
  writeFileSync(paths.topicsFile, typeof value === "string" ? value : JSON.stringify(value));
}

function readJson(file: string): any {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : null;
}

const codePrompt = (name: string): string => require(`../src/agents/${name}`).default.systemPrompt;
const planer = { name: "projekt-planer", description: "Plant Projekte in Meilensteinen", systemPrompt: "Du planst Projekte." };

describe("Kennung", () => {
  test("Web-Prüfung entspricht AGENT_ID_PATTERN des Katalogs", () => {
    expect(CATALOG_ID_PATTERN.source).toBe(AGENT_ID_PATTERN.source);
    expect(CATALOG_ID_PATTERN.flags).toBe(AGENT_ID_PATTERN.flags);
  });
});

describe("GET /api/agents", () => {
  test("ohne config/agents.json: mitgelieferte Agenten mit allen Feldern, nichts gelöscht, Revision", async () => {
    const ctx = await server();
    const res = await ctx.api("/api/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents.map((a: any) => a.name)).toEqual([...AGENT_NAMES]);
    expect(body.defaultAgent).toBe("general");
    expect(body.deleted).toEqual([]);
    expect(body.topicsUnreadable).toBe(false);
    expect(body.revision).toEqual({ boot: expect.any(Number), seq: expect.any(Number) });
    const research = body.agents.find((a: any) => a.name === "research");
    expect(research).toEqual({
      name: "research",
      label: "Research",
      description: expect.stringContaining("Research Agent"),
      origin: "builtin",
      promptSource: "code",
      board: true,
      topicCount: 0,
    });
    expect(body.agents.find((a: any) => a.name === "general").board).toBe(false);
    expect(body.agents.find((a: any) => a.name === "cto").label).toBe("CTO");
  });

  test("eigene, geänderte, gelöschte Agenten und Board-Schalter", async () => {
    await createAgent({ ...planer, board: true });
    await setPrompt("research", "Neuer Research-Prompt");
    await setBoard("content", false);
    await deleteAgent("finance");
    const ctx = await server();
    const body = await (await ctx.api("/api/agents")).json();
    const names = body.agents.map((a: any) => a.name);
    expect(names).not.toContain("finance");
    expect(names.at(-1)).toBe("projekt-planer");
    expect(body.deleted).toEqual([{ name: "finance", label: "Finance", description: expect.stringContaining("Finance Agent") }]);
    const byName = (n: string) => body.agents.find((a: any) => a.name === n);
    expect(byName("projekt-planer")).toMatchObject({ label: "Projekt Planer", origin: "custom", promptSource: "custom", board: true, description: planer.description });
    expect(byName("research").promptSource).toBe("custom");
    expect(byName("content").board).toBe(false);
  });

  test("Topic-Zahlen: Aliasse und Schlüssel * zählen mit, alle Chats", async () => {
    putTopics({ "-1001": { "3": "cfo", "4": "finance", "5": "research" }, "*": { "9": "Finance" }, "-1002": { "6": "orchestrator" } });
    const ctx = await server();
    const body = await (await ctx.api("/api/agents")).json();
    const count = (n: string) => body.agents.find((a: any) => a.name === n).topicCount;
    expect(count("finance")).toBe(3);
    expect(count("research")).toBe(1);
    expect(count("general")).toBe(1);
    expect(count("content")).toBe(0);
  });

  test("kaputte topics.json: Liste trotzdem, Topic-Zahlen null", async () => {
    putTopics("{ kaputt");
    const ctx = await server();
    const res = await ctx.api("/api/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topicsUnreadable).toBe(true);
    expect(body.agents.every((a: any) => a.topicCount === null)).toBe(true);
    expect(ctx.logs.some(l => l.startsWith("Topic-Zuordnung nicht lesbar"))).toBe(true);
  });

  test("Revision: gleicher Stand gleiche Nummer; Prompt-Änderung bei gleicher Quelle neue Nummer", async () => {
    const ctx = await server();
    const rev = async () => (await (await ctx.api("/api/agents")).json()).revision;
    const r1 = await rev();
    expect(await rev()).toEqual(r1);
    await setPrompt("research", "Fassung 1");
    const r2 = await rev();
    expect(r2.seq).toBeGreaterThan(r1.seq);
    await setPrompt("research", "Fassung 2");
    const r3 = await rev();
    expect(r3.seq).toBeGreaterThan(r2.seq);
    expect(await rev()).toEqual(r3);
  });

  test("ohne Katalog: bisherige Antwortform, neue Routen 503", async () => {
    const ctx = await server({ agentCatalog: undefined });
    const body = await (await ctx.api("/api/agents")).json();
    expect(Object.keys(body).sort()).toEqual(["agents", "defaultAgent"]);
    expect((await ctx.api("/api/agents/research/prompt")).status).toBe(503);
    expect((await ctx.api("/api/agents", "POST", planer)).status).toBe(503);
    expect((await ctx.api("/api/agents/research", "PATCH", { board: false })).status).toBe(503);
  });
});

describe("GET /api/agents/<name>/prompt", () => {
  test("mitgelieferter Agent: Prompt, Code-Standard und Quelle; nach Änderung custom", async () => {
    const ctx = await server();
    let res = await ctx.api("/api/agents/research/prompt");
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body).toMatchObject({ name: "research", systemPrompt: codePrompt("research"), codePrompt: codePrompt("research"), promptSource: "code" });
    const r1 = body.revision;
    await setPrompt("research", "Geändert");
    body = await (await ctx.api("/api/agents/research/prompt")).json();
    expect(body).toMatchObject({ systemPrompt: "Geändert", codePrompt: codePrompt("research"), promptSource: "custom" });
    expect(body.revision.seq).toBeGreaterThan(r1.seq);
    res = await ctx.api("/api/agents/research/prompt");
    expect((await res.json()).revision).toEqual(body.revision);
  });

  test("General ohne Laufzeit-Zusätze, auch mit eigenen Agenten", async () => {
    await createAgent(planer);
    const ctx = await server();
    const body = await (await ctx.api("/api/agents/general/prompt")).json();
    expect(body.systemPrompt).toBe(codePrompt("general"));
    expect(body.systemPrompt).not.toContain("ADDITIONAL AGENTS");
  });

  test("eigener Agent: kein Code-Standard", async () => {
    await createAgent(planer);
    const ctx = await server();
    const body = await (await ctx.api("/api/agents/projekt-planer/prompt")).json();
    expect(body).toMatchObject({ systemPrompt: planer.systemPrompt, codePrompt: null, promptSource: "custom" });
  });

  test("unbekannt, Alias, gelöscht, ungültige Kennung: 404", async () => {
    await deleteAgent("finance");
    const ctx = await server();
    for (const name of ["gibtsnicht", "cfo", "finance", "Research", "a_b", "%2e%2e"]) {
      expect((await ctx.api(`/api/agents/${name}/prompt`)).status).toBe(404);
    }
  });
});

describe("Sicherheit der Lese-Routen", () => {
  test("ohne Anmeldung 401, falsche Methode 405", async () => {
    const ctx = await server();
    for (const path of ["/api/agents", "/api/agents/research/prompt", "/api/agents/research/usage"]) {
      const res = await fetch(`${ctx.origin}${path}`);
      expect(res.status).toBe(401);
    }
    expect((await ctx.api("/api/agents/research", "GET")).status).toBe(405);
    expect((await ctx.api("/api/agents/research/restore", "GET")).status).toBe(405);
    expect((await ctx.api("/api/agents/research/prompt", "POST", {})).status).toBe(405);
    expect((await ctx.api("/api/agents", "PUT", {})).status).toBe(405);
    expect((await ctx.api("/api/agents/research/usage", "POST", {})).status).toBe(405);
  });
});

describe("PUT und DELETE /api/agents/<name>/prompt", () => {
  test("setzen: Datei, Antwort mit Quelle, Hinweis und neuer Revision; zurücksetzen auf den Code", async () => {
    const ctx = await server();
    const before = (await (await ctx.api("/api/agents/research/prompt")).json()).revision;
    let res = await ctx.api("/api/agents/research/prompt", "PUT", { text: "Zeile 1\r\n\tZeile 2\n" });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body).toMatchObject({ name: "research", systemPrompt: "Zeile 1\n\tZeile 2\n", promptSource: "custom", codePrompt: codePrompt("research") });
    expect(body.note).toContain("nächsten frischen Session");
    expect(body.revision.seq).toBeGreaterThan(before.seq);
    expect(readJson(paths.file)).toEqual({ prompts: { research: "Zeile 1\n\tZeile 2\n" } });
    // Gleicher Inhalt noch einmal: gleiche Revision
    res = await ctx.api("/api/agents/research/prompt", "PUT", { text: "Zeile 1\n\tZeile 2\n" });
    expect((await res.json()).revision).toEqual(body.revision);
    // Zweites Schreiben sichert die vorige Fassung
    expect(readdirSync(paths.backupDir).length).toBeGreaterThan(0);

    res = await ctx.api("/api/agents/research/prompt", "DELETE");
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body).toMatchObject({ systemPrompt: codePrompt("research"), promptSource: "code" });
    expect(readJson(paths.file)).toEqual({});
    const list = await (await ctx.api("/api/agents")).json();
    expect(list.agents.find((a: any) => a.name === "research").promptSource).toBe("code");
  });

  test("eigener Agent: setzen ändert seinen Prompt, zurücksetzen 409", async () => {
    await createAgent(planer);
    const ctx = await server();
    const res = await ctx.api("/api/agents/projekt-planer/prompt", "PUT", { text: "Neu geplant" });
    expect(res.status).toBe(200);
    expect(readJson(paths.file).custom[0].systemPrompt).toBe("Neu geplant");
    const reset = await ctx.api("/api/agents/projekt-planer/prompt", "DELETE");
    expect(reset.status).toBe(409);
    expect((await reset.json()).error).toContain("Eigene Agenten");
    expect(readJson(paths.file).custom[0].systemPrompt).toBe("Neu geplant");
  });

  test("Länge: genau 20.000 UTF-16-Einheiten erlaubt, eine mehr 400", async () => {
    const ctx = await server();
    expect(PROMPT_MAX_CHARS).toBe(20_000);
    const emoji = "😀".repeat(PROMPT_MAX_CHARS / 2);
    expect(emoji.length).toBe(PROMPT_MAX_CHARS);
    expect((await ctx.api("/api/agents/research/prompt", "PUT", { text: emoji })).status).toBe(200);
    const res = await ctx.api("/api/agents/research/prompt", "PUT", { text: "x".repeat(PROMPT_MAX_CHARS + 1) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("20.000");
    expect(readJson(paths.file).prompts.research).toBe(emoji);
  });

  test("Steuerzeichen, leer, falscher Typ, kaputtes JSON: 400, nichts gespeichert", async () => {
    const ctx = await server();
    for (const text of ["a\u0007b", "a\u001b[31m", "a\u0000", "a\u007f", "a\u0085", "", "  \n\t ", 42, null]) {
      const res = await ctx.api("/api/agents/research/prompt", "PUT", { text });
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    expect((await ctx.api("/api/agents/research/prompt", "PUT", "{kaputt")).status).toBe(400);
    expect((await ctx.api("/api/agents/research/prompt", "PUT", [])).status).toBe(400);
    expect(existsSync(paths.file)).toBe(false);
  });

  test("unbekannt, Alias oder gelöscht: 404", async () => {
    await deleteAgent("finance");
    const ctx = await server();
    for (const name of ["gibtsnicht", "cfo", "finance"]) {
      expect((await ctx.api(`/api/agents/${name}/prompt`, "PUT", { text: "x" })).status).toBe(404);
      expect((await ctx.api(`/api/agents/${name}/prompt`, "DELETE")).status).toBe(404);
    }
  });

  test("Body-Limit 64 KiB samt JSON-Escapes: roh passt der längste Prompt, als \\u-Escape 413", async () => {
    const ctx = await server();
    // 3 Bytes UTF-8 je Zeichen: der ungünstigste Fall, den JSON.stringify im Browser erzeugt
    const cjk = "中".repeat(PROMPT_MAX_CHARS);
    const raw = JSON.stringify({ text: cjk });
    expect(Buffer.byteLength(raw)).toBeLessThan(64 * 1024);
    expect((await ctx.api("/api/agents/research/prompt", "PUT", raw)).status).toBe(200);
    // Anführungszeichen und Umbrüche werden zu zwei Bytes
    expect((await ctx.api("/api/agents/research/prompt", "PUT", { text: `"\n\t\\`.repeat(PROMPT_MAX_CHARS / 4) })).status).toBe(200);
    // Derselbe Prompt mit \\u-Escapes ist über 64 KiB
    const escaped = `{"text":"${"\\u4e2d".repeat(PROMPT_MAX_CHARS)}"}`;
    expect(JSON.parse(escaped).text).toBe(cjk);
    const res = await ctx.api("/api/agents/research/prompt", "PUT", escaped);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("Anfrage zu groß");
  });

  test("ohne Anmeldung 401, fehlender oder fremder Origin 403, Übergröße 413", async () => {
    const ctx = await server();
    const url = `${ctx.origin}/api/agents/research/prompt`;
    for (const method of ["PUT", "DELETE"]) {
      expect((await fetch(url, { method, headers: { origin: ctx.origin }, body: JSON.stringify({ text: "x" }) })).status).toBe(401);
      expect((await fetch(url, { method, headers: { cookie: ctx.cookie }, body: JSON.stringify({ text: "x" }) })).status).toBe(403);
      expect((await fetch(url, { method, headers: { cookie: ctx.cookie, origin: "http://evil.example" }, body: JSON.stringify({ text: "x" }) })).status).toBe(403);
      expect((await ctx.api("/api/agents/research/prompt", method, "x".repeat(64 * 1024 + 1))).status).toBe(413);
    }
    expect(existsSync(paths.file)).toBe(false);
  });
});

describe("Log ohne Prompt-Texte", () => {
  const MARKER = "GEHEIMER-PROMPT-MARKER-7f3a";

  test("Erfolg und Fehler der Prompt-Routen: nur Namen im Log", async () => {
    const ctx = await server();
    await ctx.api("/api/agents/research/prompt", "PUT", { text: `Anfang ${MARKER} Ende` });
    await ctx.api("/api/agents/research/prompt", "PUT", { text: `${MARKER}\u0007` });
    await ctx.api("/api/agents/research/prompt", "PUT", { text: MARKER.repeat(2000) });
    await ctx.api("/api/agents/research/prompt", "DELETE");
    expect(ctx.logs.some(l => l.includes("System-Prompt geändert: research"))).toBe(true);
    expect(ctx.logs.some(l => l.includes("System-Prompt zurückgesetzt: research"))).toBe(true);
    expect(ctx.logs.join("\n")).not.toContain(MARKER);
  });

  test("kaputte config/agents.json mit Prompt darin: Katalog-Log ohne Ausschnitt", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      writeFileSync(paths.file, `{"prompts": {"research": "${MARKER}" ${MARKER}}`);
      const ctx = await server();
      expect((await ctx.api("/api/agents")).status).toBe(200);
      writeFileSync(paths.file, JSON.stringify({ prompts: { [`${MARKER} x`]: MARKER } }));
      expect((await ctx.api("/api/agents/research/prompt")).status).toBe(200);
      // Schreiben mit kaputter Datei: 409, nichts überschrieben
      writeFileSync(paths.file, `{ ${MARKER}`);
      const res = await ctx.api("/api/agents/research/prompt", "PUT", { text: "neu" });
      expect(res.status).toBe(409);
      expect(readFileSync(paths.file, "utf-8")).toBe(`{ ${MARKER}`);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join("\n")).not.toContain(MARKER);
      expect(ctx.logs.join("\n")).not.toContain(MARKER);
    } finally {
      console.error = original;
    }
  });

  test("ungültige config/agents.json: Log nur mit festen Meldungen und Strukturpfaden", async () => {
    // Kurz und reines ASCII: ging früher als Pfadteil oder in der Zod-Meldung durch
    const SHORT = "Geheim42x";
    const slug = "geheim-42x";
    const cases: [string, unknown][] = [
      ["unbekanntes Feld oben", { [SHORT]: MARKER, prompts: { research: "ok" } }],
      ["unbekanntes Feld im eigenen Agenten", { custom: [{ name: "planer", description: "d", systemPrompt: "p", [SHORT]: MARKER }] }],
      ["kurzer ASCII-Prompt-Schlüssel", { prompts: { [SHORT]: MARKER } }],
      ["kurzer Prompt-Schlüssel wie eine Kennung", { prompts: { [slug]: MARKER } }],
      ["ungültige deleted-Werte", { deleted: [SHORT, slug, `${MARKER} x`, "general"] }],
      ["deleted mit falschem Typ", { deleted: [{ [SHORT]: MARKER }] }],
      ["doppelte Kennung eigener Agenten", { custom: [1, 2].map(() => ({ name: slug, description: "d", systemPrompt: "p" })) }],
      ["Board mit Prompt-Schlüssel", { board: { [SHORT]: MARKER } }],
    ];
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      const ctx = await server();
      for (const [label, content] of cases) {
        const before = errors.length;
        writeFileSync(paths.file, JSON.stringify(content));
        expect((await ctx.api("/api/agents")).status).toBe(200);
        expect(errors.length, label).toBeGreaterThan(before);
        const text = errors.slice(before).join("\n");
        for (const secret of [MARKER, SHORT, slug]) expect(text, label).not.toContain(secret);
      }
      expect(errors.some(e => e.includes("unbekanntes Feld"))).toBe(true);
      expect(errors.some(e => e.includes("deleted.0: ungültiger Wert"))).toBe(true);
      const all = [...errors, ...ctx.logs].join("\n");
      for (const secret of [MARKER, SHORT, slug]) expect(all).not.toContain(secret);
    } finally {
      console.error = original;
    }
  });

  test("allgemeiner Server-Fehler: Log nur mit Fehlernamen", async () => {
    const failing = {
      ...botAgentCatalog,
      setPrompt: async (_name: string, text: string) => {
        throw new Error(`kaputt: ${text}`);
      },
      list: () => {
        throw new TypeError(`Liste kaputt ${MARKER}`);
      },
    };
    const ctx = await server({ agentCatalog: failing });
    expect((await ctx.api("/api/agents")).status).toBe(500);
    const res = await ctx.api("/api/agents/research/prompt", "PUT", { text: MARKER });
    expect(res.status).toBe(500);
    expect(ctx.logs.some(l => l.startsWith("Fehler bei GET /api/agents (TypeError)"))).toBe(true);
    expect(ctx.logs.join("\n")).not.toContain(MARKER);
  });
});

describe("POST /api/agents", () => {
  test("legt an: 201, Liste mit neuem Agenten und neuer Revision, keine Einstellungsdatei nötig", async () => {
    const ctx = await server();
    const before = (await (await ctx.api("/api/agents")).json()).revision;
    const res = await ctx.api("/api/agents", "POST", { ...planer, description: `  ${planer.description}  ` });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe("projekt-planer");
    expect(body.settingsSaved).toBe(true);
    expect(body.warning).toBeUndefined();
    expect(body.revision.seq).toBeGreaterThan(before.seq);
    expect(body.agents.at(-1)).toMatchObject({ name: "projekt-planer", origin: "custom", promptSource: "custom", board: false, description: planer.description });
    expect(readJson(paths.file).custom).toEqual([{ name: "projekt-planer", description: planer.description, systemPrompt: planer.systemPrompt }]);
    expect(existsSync(paths.settings)).toBe(false);
    expect(ctx.logs).toContain("Agent angelegt: projekt-planer");
  });

  test("mit Modell und Effort: über die Einstellungs-Schreibkette in config/settings.json, wirksam", async () => {
    const ctx = await server();
    const res = await ctx.api("/api/agents", "POST", { ...planer, model: " claude-sonnet-5 ", effort: "low" });
    expect(res.status).toBe(201);
    expect((await res.json()).settingsSaved).toBe(true);
    expect(readJson(paths.settings)).toEqual({ agents: { "projekt-planer": { model: "claude-sonnet-5", effort: "low" } } });
    const settings = await (await ctx.api("/api/settings")).json();
    expect(settings.effective.agents["projekt-planer"].model).toEqual({ value: "claude-sonnet-5", source: "settings" });
    expect(settings.effective.agents["projekt-planer"].effort).toEqual({ value: "low", source: "settings" });
    expect(ctx.logs).toContain("Einstellungen geändert: agents.projekt-planer.model, agents.projekt-planer.effort");
  });

  test("ungültiger Effort oder Modell: 400 vor dem Anlegen", async () => {
    const ctx = await server();
    let res = await ctx.api("/api/agents", "POST", { ...planer, effort: "turbo" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Ungültige Einstellungen: effort (erlaubt: low, medium, high, xhigh)");
    res = await ctx.api("/api/agents", "POST", { ...planer, model: 42 });
    expect(res.status).toBe(400);
    expect(existsSync(paths.file)).toBe(false);
    expect(existsSync(paths.settings)).toBe(false);
    // Leeres Modell heißt „kein eigener Wert"
    res = await ctx.api("/api/agents", "POST", { ...planer, model: "  ", effort: null });
    expect(res.status).toBe(201);
    expect(existsSync(paths.settings)).toBe(false);
  });

  test("ungültige Kennung, Beschreibung, Prompt oder Felder: 400, nichts angelegt", async () => {
    const ctx = await server();
    const cases: Record<string, unknown>[] = [
      ...["A", "a", "ab_c", "Abc", "1abc", "-abc", "a".repeat(31), "ab c", ""].map(name => ({ ...planer, name })),
      { ...planer, name: 5 },
      ...["", "   ", "zwei\nZeilen", "Tab\tdrin", "x".repeat(201)].map(description => ({ ...planer, description })),
      { ...planer, systemPrompt: "" },
      { ...planer, systemPrompt: "a\u0007" },
      { ...planer, systemPrompt: "x".repeat(PROMPT_MAX_CHARS + 1) },
      { ...planer, board: true },
      { name: planer.name },
    ];
    for (const body of cases) {
      const res = await ctx.api("/api/agents", "POST", body);
      expect(res.status).toBe(400);
    }
    expect((await ctx.api("/api/agents", "POST", "{kaputt")).status).toBe(400);
    expect((await ctx.api("/api/agents", "POST", [planer])).status).toBe(400);
    expect(existsSync(paths.file)).toBe(false);
    // Grenzen: 2 und 30 Zeichen, 200 Zeichen Beschreibung
    for (const name of ["ab", "a".repeat(30)]) {
      expect((await ctx.api("/api/agents", "POST", { ...planer, name, description: "d".repeat(200) })).status).toBe(201);
    }
  });

  test("Kollision: Agent, Alias, reservierter Name, gelöschter mitgelieferter, eigener: 409", async () => {
    await createAgent(planer);
    await deleteAgent("finance");
    const ctx = await server();
    for (const name of ["research", "general", "cfo", "orchestrator", "outreach", "tech", "finance", "projekt-planer"]) {
      const res = await ctx.api("/api/agents", "POST", { ...planer, name });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain("vergeben");
    }
    expect(readJson(paths.file).custom).toHaveLength(1);
  });

  test("gleichzeitig zweimal derselbe Name: einmal 201, einmal 409", async () => {
    const ctx = await server();
    const results = await Promise.all([ctx.api("/api/agents", "POST", planer), ctx.api("/api/agents", "POST", planer)]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(readJson(paths.file).custom).toHaveLength(1);
  });

  test("gleichzeitig Anlegen mit Modell und PATCH /api/settings: beide Einträge bleiben", async () => {
    const ctx = await server();
    const [created, patched] = await Promise.all([
      ctx.api("/api/agents", "POST", { ...planer, model: "claude-sonnet-5" }),
      ctx.api("/api/settings", "PATCH", { agents: { research: { effort: "low" } } }),
    ]);
    expect(created.status).toBe(201);
    expect(patched.status).toBe(200);
    expect(readJson(paths.settings)).toEqual({ agents: { research: { effort: "low" }, "projekt-planer": { model: "claude-sonnet-5" } } });
  });

  test("ungültige config/settings.json: mit Modell 409 und nichts angelegt, ohne Modell 201", async () => {
    writeFileSync(paths.settings, "{kaputt");
    const ctx = await server();
    const res = await ctx.api("/api/agents", "POST", { ...planer, model: "claude-sonnet-5" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(SETTINGS_TEXT.fileInvalid);
    expect(existsSync(paths.file)).toBe(false);
    expect((await ctx.api("/api/agents", "POST", planer)).status).toBe(201);
    expect(readFileSync(paths.settings, "utf-8")).toBe("{kaputt");
  });

  test("Reste eines früher gelöschten gleichnamigen Agenten in config/settings.json werden entfernt", async () => {
    writeFileSync(paths.settings, JSON.stringify({ agents: { "projekt-planer": { model: "alt-modell", effort: "xhigh" }, research: { effort: "low" } } }));
    const ctx = await server();
    expect((await ctx.api("/api/agents", "POST", planer)).status).toBe(201);
    expect(readJson(paths.settings)).toEqual({ agents: { research: { effort: "low" } } });
    await ctx.api("/api/agents/projekt-planer", "DELETE", { confirm: "projekt-planer" });
    // Mit Modell: nur die neuen Werte
    writeFileSync(paths.settings, JSON.stringify({ agents: { "projekt-planer": { model: "alt-modell", effort: "xhigh" } } }));
    expect((await ctx.api("/api/agents", "POST", { ...planer, model: "neu-modell" })).status).toBe(201);
    expect(readJson(paths.settings)).toEqual({ agents: { "projekt-planer": { model: "neu-modell" } } });
  });

  test("Speichern von Modell/Effort scheitert nach dem Anlegen: 201 mit Warnung, Agent existiert, Log ohne Werte", async () => {
    const failingSettings: SettingsPort = {
      ...botSettings,
      get agents() {
        return botSettings.agents;
      },
      write: async () => {
        throw new Error("Platte voll");
      },
    };
    const ctx = await server({ settings: failingSettings });
    const res = await ctx.api("/api/agents", "POST", { ...planer, model: "claude-sonnet-5", effort: "low" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.settingsSaved).toBe(false);
    expect(body.warning).toContain("Modell und Effort nicht gespeichert");
    expect(body.agents.some((a: any) => a.name === "projekt-planer")).toBe(true);
    expect(readJson(paths.file).custom).toHaveLength(1);
    expect(ctx.logs).toContain("Agent projekt-planer: Modell und Effort nicht gespeichert (Status 500)");
    expect(ctx.logs.join("\n")).not.toContain("claude-sonnet-5");
    expect(ctx.logs.join("\n")).not.toContain("Platte voll");
  });

  test("ohne Einstellungen: mit Modell 503, ohne Modell 201", async () => {
    const ctx = await server({ settings: undefined });
    expect((await ctx.api("/api/agents", "POST", { ...planer, model: "x" })).status).toBe(503);
    expect(existsSync(paths.file)).toBe(false);
    expect((await ctx.api("/api/agents", "POST", planer)).status).toBe(201);
  });

  test("gelöschter Agent fehlt sofort in /api/agents und in der Auswahl für neue Gespräche", async () => {
    const ctx = await server();
    await ctx.api("/api/agents", "POST", planer);
    let names = (await (await ctx.api("/api/agents")).json()).agents.map((a: any) => a.name);
    expect(names).toContain("projekt-planer");
    expect((await ctx.api("/api/agents/projekt-planer", "DELETE", { confirm: "projekt-planer" })).status).toBe(200);
    const list = await (await ctx.api("/api/agents")).json();
    names = list.agents.map((a: any) => a.name);
    expect(names).not.toContain("projekt-planer");
    // Eigene Agenten sind endgültig weg, nicht wiederherstellbar
    expect(list.deleted).toEqual([]);
    const res = await ctx.api("/api/conversations", "POST", { agent: "projekt-planer" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Ungültiger Agent");
  });
});

describe("DELETE /api/agents/<name>", () => {
  test("mitgelieferter Agent: Topics (auch Alias und *) auf General, Antwort nennt sie, wiederherstellbar", async () => {
    putTopics({ "-1001": { "3": "cfo", "4": "research" }, "*": { "9": "finance" } });
    const ctx = await server();
    const res = await ctx.api("/api/agents/finance", "DELETE", { confirm: "finance" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe("finance");
    expect(body.topicsMoved).toBe(true);
    expect(body.moved).toEqual([
      { chatId: "-1001", topicId: 3 },
      { chatId: "*", topicId: 9 },
    ]);
    expect(body.agents.map((a: any) => a.name)).not.toContain("finance");
    expect(body.deleted.map((d: any) => d.name)).toEqual(["finance"]);
    expect(body.agents.find((a: any) => a.name === "general").topicCount).toBe(2);
    expect(readJson(paths.topicsFile)).toEqual({ "-1001": { "3": "general", "4": "research" }, "*": { "9": "general" } });
    const list = await (await ctx.api("/api/agents")).json();
    expect(list.deleted.map((d: any) => d.name)).toEqual(["finance"]);
    expect(ctx.logs).toContain("Agent gelöscht: finance, 2 Topic(s) auf General umgestellt");
  });

  test("General 409; unbekannt 404; falsche oder fehlende Bestätigung 400; nichts gelöscht", async () => {
    const ctx = await server();
    let res = await ctx.api("/api/agents/general", "DELETE", { confirm: "general" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("General");
    expect((await ctx.api("/api/agents/gibtsnicht", "DELETE", { confirm: "gibtsnicht" })).status).toBe(404);
    expect((await ctx.api("/api/agents/cfo", "DELETE", { confirm: "cfo" })).status).toBe(404);
    for (const body of [undefined, "", "{kaputt", {}, { confirm: "Finance" }, { confirm: "cfo" }, { confirm: " finance" }, { confirm: true }]) {
      res = await ctx.api("/api/agents/finance", "DELETE", body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("genau eingeben");
    }
    expect(existsSync(paths.file)).toBe(false);
  });

  test("kaputte config/topics.json: 409, nichts gelöscht", async () => {
    putTopics("{ kaputt");
    const ctx = await server();
    const res = await ctx.api("/api/agents/finance", "DELETE", { confirm: "finance" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Nichts gelöscht");
    expect(existsSync(paths.file)).toBe(false);
  });

  test("Teilerfolg: Katalog geändert, Topics nicht umgestellt: 500 mit removed, topicsMoved false und neuer Liste", async () => {
    const lockedDir = join(dir, "nur-lesen");
    mkdirSync(lockedDir);
    const lockedTopics = join(lockedDir, "topics.json");
    writeFileSync(lockedTopics, JSON.stringify({ "-1001": { "3": "finance" } }));
    setAgentCatalogPaths({ file: paths.file, backupDir: paths.backupDir, topicsFile: lockedTopics });
    chmodSync(lockedDir, 0o555);
    try {
      const ctx = await server();
      const before = (await (await ctx.api("/api/agents")).json()).revision;
      const res = await ctx.api("/api/agents/finance", "DELETE", { confirm: "finance" });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toMatchObject({ removed: "finance", topicsMoved: false, moved: [] });
      expect(body.error).toContain("über General");
      expect(body.agents.map((a: any) => a.name)).not.toContain("finance");
      expect(body.deleted.map((d: any) => d.name)).toEqual(["finance"]);
      expect(body.revision.seq).toBeGreaterThan(before.seq);
      expect(readJson(lockedTopics)).toEqual({ "-1001": { "3": "finance" } });
      expect(ctx.logs).toContain("Agent gelöscht: finance, Topics nicht umgestellt");
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });

  test("gleichzeitig Agent löschen und Topic zuordnen: nie ein Topic mit gelöschtem Agenten", async () => {
    const env = await topicEnv(root);
    env.deps.setMapping = (chatId, topicId, agent) => botSetMapping(chatId, topicId, agent, env.mappingFile);
    setAgentCatalogPaths({ file: paths.file, backupDir: paths.backupDir, topicsFile: env.mappingFile });
    await env.names.saveTopicName(7, "Sieben");
    const ctx = await topicServer(root, servers, env, { agentCatalog: botAgentCatalog, settings: botSettings });
    for (let i = 0; i < 12; i++) {
      const name = `wegwerf-${i}`;
      await botSetMapping(GROUP, 7, "research", env.mappingFile);
      expect((await ctx.api("/api/agents", "POST", { ...planer, name })).status).toBe(201);
      const assign = (async () => {
        await Bun.sleep(i % 3);
        return ctx.api("/api/conversations/topic-7", "PATCH", { agent: name });
      })();
      const del = (async () => {
        await Bun.sleep((i + 1) % 2);
        return ctx.api(`/api/agents/${name}`, "DELETE", { confirm: name });
      })();
      const [assigned, deleted] = await Promise.all([assign, del]);
      expect(deleted.status).toBe(200);
      const moved = (await deleted.json()).moved;
      const mapping = (await readMapping(env))[GROUP]["7"];
      expect(mapping).not.toBe(name);
      if (assigned.status === 200) {
        // Zuordnung kam vor dem Umstellen: sie wurde mit umgestellt und gemeldet
        expect(moved).toEqual([{ chatId: GROUP, topicId: 7 }]);
        expect(mapping).toBe("general");
      } else {
        expect([400, 409]).toContain(assigned.status);
        expect(mapping).toBe("research");
      }
    }
    // Direkt nach dem Löschen: Zuordnung zum gelöschten Agenten wird abgelehnt
    const last = await ctx.api("/api/conversations/topic-7", "PATCH", { agent: "wegwerf-0" });
    expect(last.status).toBe(400);
  });

  test("Zuordnung geprüft, dann Agent gelöscht, dann geschrieben: 409, Zuordnung unverändert", async () => {
    const env = await topicEnv(root);
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let waiting = false;
    env.deps.setMapping = async (chatId, topicId, agent) => {
      waiting = true;
      await gate;
      return botSetMapping(chatId, topicId, agent, env.mappingFile);
    };
    setAgentCatalogPaths({ file: paths.file, backupDir: paths.backupDir, topicsFile: env.mappingFile });
    await env.names.saveTopicName(7, "Sieben");
    await botSetMapping(GROUP, 7, "research", env.mappingFile);
    const ctx = await topicServer(root, servers, env, { agentCatalog: botAgentCatalog, settings: botSettings });
    await ctx.api("/api/agents", "POST", planer);
    const assign = ctx.api("/api/conversations/topic-7", "PATCH", { agent: "projekt-planer" });
    while (!waiting) await Bun.sleep(1);
    const deleted = await ctx.api("/api/agents/projekt-planer", "DELETE", { confirm: "projekt-planer" });
    expect((await deleted.json()).moved).toEqual([]);
    release();
    const res = await assign;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("inzwischen gelöscht");
    expect((await readMapping(env))[GROUP]["7"]).toBe("research");
  });
});

describe("POST /api/agents/<name>/restore", () => {
  test("gelöschter mitgelieferter Agent kommt mit Code-Prompt zurück", async () => {
    await setPrompt("finance", "Eigener Finanz-Prompt");
    const ctx = await server();
    await ctx.api("/api/agents/finance", "DELETE", { confirm: "finance" });
    const res = await ctx.api("/api/agents/finance/restore", "POST");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.restored).toBe("finance");
    expect(body.deleted).toEqual([]);
    expect(body.agents.find((a: any) => a.name === "finance")).toMatchObject({ promptSource: "code", origin: "builtin" });
    expect(ctx.logs).toContain("Agent wiederhergestellt: finance");
  });

  test("aktiver Agent 409, eigener oder unbekannter 404", async () => {
    await createAgent(planer);
    const ctx = await server();
    expect((await ctx.api("/api/agents/research/restore", "POST")).status).toBe(409);
    expect((await ctx.api("/api/agents/general/restore", "POST")).status).toBe(409);
    await ctx.api("/api/agents/projekt-planer", "DELETE", { confirm: "projekt-planer" });
    expect((await ctx.api("/api/agents/projekt-planer/restore", "POST")).status).toBe(404);
    expect((await ctx.api("/api/agents/gibtsnicht/restore", "POST")).status).toBe(404);
  });
});

describe("PATCH /api/agents/<name> { board }", () => {
  test("schaltet mitgelieferte und eigene; neue Revision", async () => {
    await createAgent(planer);
    const ctx = await server();
    const before = (await (await ctx.api("/api/agents")).json()).revision;
    let res = await ctx.api("/api/agents/research", "PATCH", { board: false });
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.agents.find((a: any) => a.name === "research").board).toBe(false);
    expect(body.revision.seq).toBeGreaterThan(before.seq);
    res = await ctx.api("/api/agents/projekt-planer", "PATCH", { board: true });
    body = await res.json();
    expect(body.agents.find((a: any) => a.name === "projekt-planer").board).toBe(true);
    expect(readJson(paths.file).board).toEqual({ research: false });
    expect(ctx.logs).toContain("Agent research: Board aus");
  });

  test("General 409, unbekannt 404, falscher Body 400", async () => {
    const ctx = await server();
    expect((await ctx.api("/api/agents/general", "PATCH", { board: true })).status).toBe(409);
    expect((await ctx.api("/api/agents/gibtsnicht", "PATCH", { board: true })).status).toBe(404);
    for (const body of [{}, { board: "nein" }, { board: 1 }, { board: true, name: "x" }, "{kaputt", [true]]) {
      expect((await ctx.api("/api/agents/research", "PATCH", body)).status).toBe(400);
    }
    expect(existsSync(paths.file)).toBe(false);
  });
});

describe("GET /api/agents/<name>/usage (Löschvorschau, Issue #51)", () => {
  test("alle Zuordnungen samt Alias und *, über alle Chats, sortiert, mit Revision", async () => {
    putTopics({ "-1002": { "6": "cfo" }, "-1001": { "4": "finance", "3": "research" }, "*": { "9": "Finance" } });
    const ctx = await server();
    const res = await ctx.api("/api/agents/finance/usage");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("finance");
    expect(body.topics).toEqual([
      { chatId: "*", topicId: 9 },
      { chatId: "-1001", topicId: 4 },
      { chatId: "-1002", topicId: 6 },
    ]);
    expect(body.revision).toEqual({ boot: expect.any(Number), seq: expect.any(Number) });
    // Gleicher Stand, gleiche Nummer
    expect((await (await ctx.api("/api/agents/finance/usage")).json()).revision).toEqual(body.revision);
    expect((await (await ctx.api("/api/agents/content/usage")).json()).topics).toEqual([]);
  });

  test("kaputte topics.json 409 statt unvollständiger Liste; unbekannter Agent 404", async () => {
    await deleteAgent("critic");
    putTopics("{ kaputt");
    const ctx = await server();
    const res = await ctx.api("/api/agents/finance/usage");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("topics.json");
    expect((await ctx.api("/api/agents/gibtsnicht/usage")).status).toBe(404);
    expect((await ctx.api("/api/agents/critic/usage")).status).toBe(404);
  });
});

describe("Sicherheit der Schreib-Routen", () => {
  const routes: [string, string, unknown][] = [
    ["POST", "/api/agents", planer],
    ["PATCH", "/api/agents/research", { board: false }],
    ["DELETE", "/api/agents/research", { confirm: "research" }],
    ["POST", "/api/agents/finance/restore", {}],
    ["PUT", "/api/agents/research/prompt", { text: "x" }],
    ["DELETE", "/api/agents/research/prompt", {}],
  ];

  test("ohne Anmeldung 401, fehlender oder fremder Origin 403, Übergröße 413; nichts geändert", async () => {
    await deleteAgent("finance");
    const snapshot = readFileSync(paths.file, "utf-8");
    const ctx = await server();
    for (const [method, path, body] of routes) {
      const payload = JSON.stringify(body);
      expect((await fetch(`${ctx.origin}${path}`, { method, headers: { origin: ctx.origin }, body: payload })).status).toBe(401);
      expect((await fetch(`${ctx.origin}${path}`, { method, headers: { cookie: ctx.cookie }, body: payload })).status).toBe(403);
      for (const origin of ["http://evil.example", "null", ctx.origin.replace("127.0.0.1", "localhost")]) {
        expect((await fetch(`${ctx.origin}${path}`, { method, headers: { cookie: ctx.cookie, origin }, body: payload })).status).toBe(403);
      }
      const big = await ctx.api(path, method, "x".repeat(64 * 1024 + 1));
      expect(big.status).toBe(413);
    }
    expect(readFileSync(paths.file, "utf-8")).toBe(snapshot);
  });

  test("Log beim Anlegen, Löschen und Wiederherstellen ohne Prompt-Text", async () => {
    const MARKER = "PROMPT-MARKER-ANLEGEN-91c2";
    const ctx = await server();
    await ctx.api("/api/agents", "POST", { ...planer, systemPrompt: `Du bist ${MARKER}` });
    await ctx.api("/api/agents", "POST", { ...planer, name: "zweiter", systemPrompt: `${MARKER}\u0001` });
    await ctx.api("/api/agents/projekt-planer", "DELETE", { confirm: "projekt-planer" });
    await ctx.api("/api/agents/research/prompt", "PUT", { text: MARKER });
    await ctx.api("/api/agents/research", "DELETE", { confirm: "research" });
    await ctx.api("/api/agents/research/restore", "POST");
    expect(ctx.logs.length).toBeGreaterThan(3);
    expect(ctx.logs.join("\n")).not.toContain(MARKER);
  });
});
