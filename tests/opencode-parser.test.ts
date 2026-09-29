/**
 * OpenCode-Motor, Parser (Issue #127): Zeilen aus `opencode run --format json`
 * werden zu Ereignissen, OpenCodeTurn leitet Antwort, Session, Werkzeuge,
 * Nutzung, Kosten und Fehler ab. Grundlage ist
 * tests/fixtures/opencode-stream.jsonl, aufgebaut nach
 * packages/opencode/src/cli/cmd/run.ts (Hülle je Zeile) und
 * packages/schema/src/v1/session.ts (Teile, Fehler) im Stand v1.18.33.
 * Kein Prozess, kein echtes opencode.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { createLineReader } from "../src/lib/engines/codex";
import {
  mcpToolName,
  openCodeErrorKind,
  OPENCODE_NOT_LOGGED_IN,
  OpenCodeTurn,
  parseOpenCodeEvent,
  parseOpenCodeVersion,
} from "../src/lib/engines/opencode";
import { classifyTurnTools } from "../src/lib/turn-tools";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures/opencode-stream.jsonl"), "utf8");
const SESSION = "ses_6b2f1c0e3ffeK9aQm2Lx7Rt4Vw";
const PROJECT = "/tmp/tybo-projekt";

function turnFrom(lines: string[] | string, callbacks?: ConstructorParameters<typeof OpenCodeTurn>[0]): OpenCodeTurn {
  const turn = new OpenCodeTurn(callbacks);
  const list = typeof lines === "string" ? lines.split("\n") : lines;
  for (const line of list) {
    const e = parseOpenCodeEvent(line);
    if (e) turn.apply(e);
  }
  return turn;
}

const line = (o: object) => JSON.stringify(o);
const S = "ses_test1";
const stepStart = () => line({ type: "step_start", timestamp: 1, sessionID: S, part: { id: "p0", type: "step-start" } });
const text = (id: string, t: string) =>
  line({ type: "text", timestamp: 2, sessionID: S, part: { id, type: "text", text: t, time: { start: 1, end: 2 } } });
const tool = (callID: string, name: string, input: object) =>
  line({
    type: "tool_use",
    timestamp: 3,
    sessionID: S,
    part: { id: `p-${callID}`, type: "tool", callID, tool: name, state: { status: "completed", input, output: "", title: "", metadata: {} } },
  });
const stepFinish = (cost = 0.001) =>
  line({
    type: "step_finish",
    timestamp: 4,
    sessionID: S,
    part: { id: "pf", type: "step-finish", reason: "stop", cost, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 1 } } },
  });
const error = (name: string, data: object) => line({ type: "error", timestamp: 5, sessionID: S, error: { name, data } });

describe("parseOpenCodeEvent", () => {
  test("leere, kaputte und fremde Zeilen ergeben null", () => {
    for (const l of ["", "   ", "{kaputt", "42", '"text"', "null", '{"kein":"typ"}']) expect(parseOpenCodeEvent(l)).toBeNull();
  });

  test("unbekannte Typen und unvollständige Teile zählen als Ereignis, ohne Wirkung", () => {
    expect(parseOpenCodeEvent(line({ type: "neu", sessionID: S }))).toEqual({ type: "unknown", sessionId: S });
    expect(parseOpenCodeEvent(line({ type: "tool_use", sessionID: S, part: {} }))).toEqual({ type: "unknown", sessionId: S });
    expect(parseOpenCodeEvent(line({ type: "text", part: { id: "x" } }))).toEqual({ type: "unknown" });
  });

  test("synthetische und verworfene Textteile sind keine Antwort", () => {
    expect(parseOpenCodeEvent(line({ type: "text", sessionID: S, part: { id: "x", text: "intern", synthetic: true } }))?.type).toBe("unknown");
    expect(parseOpenCodeEvent(line({ type: "text", sessionID: S, part: { id: "x", text: "weg", ignored: true } }))?.type).toBe("unknown");
  });

  test("step_finish liefert Nutzung (Cache in der Eingabe enthalten) und Kosten", () => {
    expect(parseOpenCodeEvent(stepFinish(0.25))).toEqual({
      type: "step_finish",
      sessionId: S,
      usage: { inputTokens: 13, cachedInputTokens: 2, outputTokens: 5, reasoningOutputTokens: 0 },
      costUsd: 0.25,
    });
    // Ohne tokens und cost: nichts davon
    expect(parseOpenCodeEvent(line({ type: "step_finish", sessionID: S, part: { type: "step-finish" } }))).toEqual({ type: "step_finish", sessionId: S });
  });

  test("error liefert Name, Meldung und HTTP-Status", () => {
    expect(parseOpenCodeEvent(error("APIError", { message: "Too Many Requests", statusCode: 429, isRetryable: true }))).toEqual({
      type: "error",
      sessionId: S,
      error: { name: "APIError", message: "Too Many Requests", statusCode: 429 },
    });
    expect(parseOpenCodeEvent(line({ type: "error", error: {} }))).toEqual({ type: "error", error: { name: "UnknownError", message: "UnknownError" } });
  });
});

describe("Fixture (mehrere Schritte)", () => {
  const turn = turnFrom(FIXTURE);
  const r = turn.result({ exitCode: 0, cwd: PROJECT });

  test("Session-ID aus der ersten Zeile", () => {
    expect(r.sessionId).toBe(SESSION);
  });

  test("Antwort: nur die Textteile des letzten Schritts, mit Leerzeile verbunden", () => {
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Der Termin ist am Donnerstag um 10 Uhr.\n\nSoll ich ihn eintragen?");
    expect(r.text).not.toContain("Ich schaue zuerst");
  });

  test("Werkzeuge aller Schritte mit Claude-Namen, Pfad und Befehl", () => {
    expect(r.tools.uses).toEqual([
      { name: "mcp__gmail__search_threads" },
      { name: "WebFetch" },
      { name: "Read", path: "/etc/hosts" },
      { name: "Bash", command: "ls kalender" },
    ]);
    expect(r.tools.cwd).toBe(PROJECT);
    expect(r.steps.map((s) => s.name)).toEqual(["mcp__gmail__search_threads", "WebFetch", "Read", "Bash"]);
  });

  test("Nutzung und Kosten über alle Schritte summiert", () => {
    expect(r.usage).toEqual({ inputTokens: 5190, cachedInputTokens: 770, outputTokens: 300, reasoningOutputTokens: 20 });
    expect(r.costUsd).toBeCloseTo(0.025, 10);
  });

  test("webfetch, MCP und Read außerhalb des Projekts gelten als fremd", () => {
    const verdict = classifyTurnTools(r.tools, PROJECT);
    expect(verdict.status).toBe("foreign");
    if (verdict.status !== "foreign") return;
    expect(verdict.reasons).toContain("WebFetch");
    expect(verdict.reasons).toContain("mcp__gmail__search_threads (Mail)");
    expect(verdict.reasons).toContain("Read außerhalb des Projekts");
  });

  test("über Chunks verteilte Zeilen und geteilte UTF-8-Zeichen ergeben dasselbe", () => {
    const bytes = new TextEncoder().encode(FIXTURE.replace("Donnerstag", "Dönnerstäg"));
    const byChunks = new OpenCodeTurn();
    const reader = createLineReader((l) => {
      const e = parseOpenCodeEvent(l);
      if (e) byChunks.apply(e);
    });
    // 7-Byte-Stücke teilen Zeilen und Umlaute; die letzte Zeile ohne Zeilenumbruch
    const trimmed = bytes.at(-1) === 10 ? bytes.slice(0, -1) : bytes;
    for (let i = 0; i < trimmed.length; i += 7) reader.push(trimmed.slice(i, i + 7));
    reader.end();
    const out = byChunks.result({ exitCode: 0, cwd: PROJECT });
    expect(out.text).toBe("Der Termin ist am Dönnerstäg um 10 Uhr.\n\nSoll ich ihn eintragen?");
    expect(out.tools.uses).toHaveLength(4);
    expect(out.usage?.outputTokens).toBe(300);
  });
});

describe("Werkzeug-Abbildung", () => {
  const usesOf = (name: string, input: object) => turnFrom([tool("c1", name, input)]).toolUses();

  test("eingebaute Werkzeuge bekommen Claude-Namen und ihre Angaben", () => {
    expect(usesOf("webfetch", { url: "https://example.org" })).toEqual([{ name: "WebFetch" }]);
    expect(usesOf("websearch", { query: "tybo" })).toEqual([{ name: "WebSearch" }]);
    expect(usesOf("read", { filePath: "/etc/hosts" })).toEqual([{ name: "Read", path: "/etc/hosts" }]);
    expect(usesOf("glob", { pattern: "**/*.ts", path: "/var/log" })).toEqual([{ name: "Glob", path: "/var/log" }]);
    expect(usesOf("grep", { pattern: "x" })).toEqual([{ name: "Grep" }]);
    expect(usesOf("bash", { command: "curl https://example.org" })).toEqual([{ name: "Bash", command: "curl https://example.org" }]);
    expect(usesOf("edit", { filePath: "src/a.ts", oldString: "a", newString: "b" })).toEqual([{ name: "Edit", path: "src/a.ts" }]);
    expect(usesOf("apply_patch", { patchText: "..." })).toEqual([{ name: "Edit" }]);
    expect(usesOf("write", { filePath: "notiz.md", content: "x" })).toEqual([{ name: "Write", path: "notiz.md" }]);
    expect(usesOf("task", { description: "suchen", prompt: "such" })).toEqual([{ name: "Task" }]);
    expect(usesOf("todowrite", { todos: [] })).toEqual([{ name: "todowrite" }]);
  });

  test("MCP-Werkzeuge: mcp__<server>__<werkzeug>, getrennt am ersten Unterstrich", () => {
    expect(mcpToolName("gmail_search_threads")).toBe("mcp__gmail__search_threads");
    expect(mcpToolName("firecrawl")).toBe("mcp__firecrawl__firecrawl");
    expect(mcpToolName("_seltsam")).toBe("mcp___seltsam___seltsam");
  });

  test("Einstufung: Web, MCP, Unter-Agent, Pfade außerhalb fremd; Projekt und Bash ohne Netz eigen", () => {
    const verdict = (name: string, input: object) => classifyTurnTools({ uses: usesOf(name, input), cwd: PROJECT }, PROJECT).status;
    expect(verdict("webfetch", { url: "https://example.org" })).toBe("foreign");
    expect(verdict("websearch", { query: "x" })).toBe("foreign");
    expect(verdict("task", { prompt: "x" })).toBe("foreign");
    expect(verdict("notion_query_database", {})).toBe("foreign");
    expect(verdict("my_server_with_underscores_tool", {})).toBe("foreign");
    expect(verdict("read", { filePath: "/etc/hosts" })).toBe("foreign");
    expect(verdict("grep", { pattern: "x", path: "/var/log" })).toBe("foreign");
    expect(verdict("read", { filePath: `${PROJECT}/README.md` })).toBe("own");
    expect(verdict("glob", { pattern: "*.ts" })).toBe("own");
    expect(verdict("bash", { command: "ls" })).toBe("own");
    expect(verdict("bash", { command: "curl https://example.org" })).toBe("foreign");
    expect(verdict("todowrite", {})).toBe("own");
  });

  test("lsp gilt immer als fremd, auch hover auf eine Datei außerhalb des Projekts", () => {
    const outside = usesOf("lsp", { operation: "hover", filePath: "/etc/hosts", line: 1, character: 1 });
    expect(outside).toEqual([{ name: "lsp", external: true }]);
    expect(classifyTurnTools({ uses: outside, cwd: PROJECT }, PROJECT)).toEqual({ status: "foreign", reasons: ["lsp (externes Werkzeug)"] });
    // Auch im Projekt: Definitionen und Symbole können aus beliebigen Dateien stammen
    const inside = usesOf("lsp", { operation: "workspaceSymbol", filePath: `${PROJECT}/src/a.ts` });
    expect(classifyTurnTools({ uses: inside, cwd: PROJECT }, PROJECT).status).toBe("foreign");
    // Merk-Tags aus so einem Turn laufen über die Freigabe, nicht direkt
    const turn = turnFrom([stepStart(), tool("c1", "lsp", { operation: "hover", filePath: "/etc/hosts" }), text("t1", "[REMEMBER: x]"), stepFinish()]);
    expect(classifyTurnTools(turn.result({ exitCode: 0, cwd: PROJECT }).tools, PROJECT).status).toBe("foreign");
  });

  test("dasselbe Werkzeug zweimal gemeldet zählt einmal", () => {
    const t = turnFrom([tool("c1", "webfetch", { url: "u" }), tool("c1", "webfetch", { url: "u" })]);
    expect(t.toolUses()).toHaveLength(1);
  });
});

describe("Antwort und Rückrufe", () => {
  test("letzter Schritt ohne Text: keine Antwort, ein früherer Textteil wird nicht zur Abschlussantwort", () => {
    const t = turnFrom([stepStart(), text("t1", "Zwischenstand"), text("t2", "Ergebnis"), stepFinish(), stepStart(), stepFinish()]);
    expect(t.answer()).toBe("");
    const r = t.result({ exitCode: 0, cwd: PROJECT });
    expect(r).toMatchObject({ isError: true, text: "OpenCode hat keine Antwort geliefert" });
    // Der Zwischenstand bleibt nur für den Timeout-Bericht
    expect(r.lastText).toBe("Ergebnis");
  });

  test("mehrere Schritte: Zwischenmeldung, danach Werkzeugschritt ohne Abschlussantwort ergibt Fehler", () => {
    const t = turnFrom([
      stepStart(),
      text("t1", "Ich lese erst die Datei und melde mich dann."),
      tool("c1", "read", { filePath: `${PROJECT}/README.md` }),
      stepFinish(),
      stepStart(),
      tool("c2", "bash", { command: "ls" }),
      stepFinish(),
    ]);
    const r = t.result({ exitCode: 0, cwd: PROJECT });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("Ich lese erst");
    expect(r.tools.uses.map((u) => u.name)).toEqual(["Read", "Bash"]);
  });

  test("ein Textteil mit derselben ID ersetzt den früheren Stand", () => {
    const t = turnFrom([stepStart(), text("t1", "Hal"), text("t1", "Hallo"), stepFinish()]);
    expect(t.answer()).toBe("Hallo");
  });

  test("Rückrufe: jedes tool_use mit Anzeigename, erster Text über 30 Zeichen einmal", () => {
    const tools: string[] = [];
    const texts: string[] = [];
    turnFrom(FIXTURE, { onTool: (n) => tools.push(n), onFirstText: (_s, full) => texts.push(full) });
    expect(tools).toEqual(["Using gmail", "Fetching page", "Reading file", "Running command"]);
    expect(texts).toEqual(["Ich schaue zuerst in die Mails und lese dann die Seite zum Termin."]);
  });

  test("kurzer erster Text löst keinen Text-Rückruf aus", () => {
    const texts: string[] = [];
    turnFrom([stepStart(), text("t1", "Kurz."), stepFinish()], { onFirstText: (_s, f) => texts.push(f) });
    expect(texts).toEqual([]);
  });
});

describe("Fehler", () => {
  test("ProviderAuthError: isError, errorKind auth, Anmelde-Hinweis", () => {
    const t = turnFrom([stepStart(), error("ProviderAuthError", { providerID: "openrouter", message: "No API key for openrouter" })]);
    const r = t.result({ exitCode: 1, cwd: PROJECT });
    expect(r).toMatchObject({ isError: true, errorKind: "auth", text: OPENCODE_NOT_LOGGED_IN, sessionId: S });
    expect(r.text).toContain("opencode auth login");
  });

  test("APIError 429: rate_limit", () => {
    const r = turnFrom([error("APIError", { message: "Too Many Requests", statusCode: 429, isRetryable: true })]).result({ exitCode: 1, cwd: PROJECT });
    expect(r).toMatchObject({ isError: true, errorKind: "rate_limit" });
    expect(r.text).toContain("Too Many Requests");
  });

  test("weitere Fehlerarten", () => {
    const kind = (name: string, data: Record<string, unknown>) => openCodeErrorKind({ name, message: String(data.message ?? name), ...data } as any);
    expect(kind("ContextOverflowError", { message: "too long" })).toBe("context");
    expect(kind("APIError", { message: "Unauthorized", statusCode: 401 })).toBe("auth");
    expect(kind("APIError", { message: "Payment Required", statusCode: 402 })).toBe("quota");
    expect(kind("APIError", { message: "Overloaded", statusCode: 529 })).toBe("capacity");
    expect(kind("APIError", { message: "Bad Request", statusCode: 400 })).toBe("other");
    expect(kind("MessageOutputLengthError", {})).toBe("other");
    expect(kind("UnknownError", { message: "rate limit exceeded" })).toBe("rate_limit");
  });

  test("Exit-Code ungleich 0 ist ein Fehler, auch nach Text", () => {
    const t = turnFrom([stepStart(), text("t1", "Halbe Antwort"), stepFinish()]);
    const r = t.result({ exitCode: 1, cwd: PROJECT });
    expect(r).toMatchObject({ isError: true, errorKind: "other", text: "OpenCode endete mit Exit-Code 1" });
    expect(r.lastText).toBe("Halbe Antwort");
  });

  test("error-Ereignis bei Exit 0 und Text ist trotzdem ein Fehler", () => {
    const t = turnFrom([stepStart(), text("t1", "Teil"), error("APIError", { message: "Too Many Requests", statusCode: 429 })]);
    expect(t.result({ exitCode: 0, cwd: PROJECT })).toMatchObject({ isError: true, errorKind: "rate_limit" });
  });

  test("MessageAbortedError nach einem anderen Fehler: der andere zählt", () => {
    const t = turnFrom([error("ProviderAuthError", { message: "x" }), error("MessageAbortedError", { message: "aborted" })]);
    expect(t.result({ exitCode: 1, cwd: PROJECT }).errorKind).toBe("auth");
  });

  test("Exit 0 ohne jeden Text ist ein Fehler", () => {
    const r = turnFrom([stepStart(), stepFinish()]).result({ exitCode: 0, cwd: PROJECT });
    expect(r).toMatchObject({ isError: true, text: "OpenCode hat keine Antwort geliefert" });
  });

  test("ohne Ereignis und mit „command not found“: not_installed", () => {
    const r = new OpenCodeTurn().result({ exitCode: 127, stderr: "opencode: command not found", cwd: PROJECT });
    expect(r).toMatchObject({ isError: true, errorKind: "not_installed" });
  });

  test("Fehlermeldungen und stderr ohne Zugangsdaten", () => {
    const secret = "sk-or-v1-test-0123456789abcdef0123456789ab";
    const r = turnFrom([error("APIError", { message: `Invalid key ${secret}`, statusCode: 400 })]).result({ exitCode: 1, cwd: PROJECT });
    expect(r.text).not.toContain(secret);
    const s = new OpenCodeTurn().result({ exitCode: 1, stderr: `Authorization: Bearer ${secret}`, cwd: PROJECT });
    expect(s.text).not.toContain(secret);
  });
});

describe("parseOpenCodeVersion", () => {
  test("erkennt Versionsnummern in verschiedenen Formen", () => {
    expect(parseOpenCodeVersion("1.18.33\n")).toEqual({ version: "1.18.33", major: 1 });
    expect(parseOpenCodeVersion("opencode v1.18.7")).toEqual({ version: "1.18.7", major: 1 });
    expect(parseOpenCodeVersion("2.0.16")).toEqual({ version: "2.0.16", major: 2 });
    expect(parseOpenCodeVersion("1.19.0-beta.2")).toEqual({ version: "1.19.0", major: 1 });
    expect(parseOpenCodeVersion("")).toBeNull();
    expect(parseOpenCodeVersion("unbekannt")).toBeNull();
  });
});
