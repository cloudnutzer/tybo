/**
 * Codex-Motor, Parser (Issue #123): Zeilen aus `codex exec --json` werden zu
 * Ereignissen, CodexTurn leitet Antwort, Session, Werkzeuge und Nutzung ab.
 * Grundlage ist tests/fixtures/codex-stream.jsonl (Aufbau wie die Beispiele
 * der Codex-Doku). Kein Prozess, kein echtes codex.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { codexErrorKind, CodexTurn, createLineReader, parseCodexEvent, type CodexEvent } from "../src/lib/engines/codex";
import { classifyTurnTools } from "../src/lib/turn-tools";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures/codex-stream.jsonl"), "utf8");
const PROJECT = "/tmp/tybo-projekt";

function turnFrom(lines: string[] | string, callbacks?: ConstructorParameters<typeof CodexTurn>[0]): CodexTurn {
  const turn = new CodexTurn(callbacks);
  const list = typeof lines === "string" ? lines.split("\n") : lines;
  for (const line of list) {
    const e = parseCodexEvent(line);
    if (e) turn.apply(e);
  }
  return turn;
}

const line = (o: object) => JSON.stringify(o);
const started = { type: "thread.started", thread_id: "t-1" };
const completed = { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } };
const message = (id: string, text: string) => ({ type: "item.completed", item: { id, type: "agent_message", text } });
const command = (id: string, cmd: string) => ({ type: "item.started", item: { id, type: "command_execution", command: cmd, status: "in_progress" } });

describe("parseCodexEvent", () => {
  test("leere, kaputte und fremde Zeilen ergeben null", () => {
    for (const l of ["", "   ", "{kaputt", "42", '"text"', "null", '{"kein":"typ"}']) expect(parseCodexEvent(l)).toBeNull();
  });

  test("thread.started liefert die Session-ID", () => {
    expect(parseCodexEvent(line(started))).toEqual({ type: "thread.started", sessionId: "t-1" });
  });

  test("turn.completed liefert die Nutzung in camelCase", () => {
    expect(parseCodexEvent(line(completed))).toEqual({
      type: "turn.completed",
      usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
    });
  });

  test("turn.failed und error liefern die Meldung", () => {
    expect(parseCodexEvent(line({ type: "turn.failed", error: { message: "kaputt" } }))).toEqual({ type: "turn.failed", message: "kaputt" });
    expect(parseCodexEvent(line({ type: "error", message: "weg" }))).toEqual({ type: "error", message: "weg" });
  });

  test("unbekannte Typen zählen als Ereignis, ohne Wirkung", () => {
    expect(parseCodexEvent(line({ type: "turn.neu" }))).toEqual({ type: "unknown" });
    expect(parseCodexEvent(line({ type: "item.started", item: { type: "agent_message" } }))).toEqual({ type: "unknown" });
  });
});

describe("Fixture aus der Doku", () => {
  const turn = turnFrom(FIXTURE);
  const r = turn.result({ exitCode: 0, cwd: PROJECT });

  test("Session-ID, kein Fehler, Nutzung", () => {
    expect(r.sessionId).toBe("0199a213-81c0-7800-8aa1-bbab2a035a53");
    expect(r.isError).toBe(false);
    expect(r.errorKind).toBeUndefined();
    expect(r.usage).toEqual({ inputTokens: 24763, cachedInputTokens: 24448, outputTokens: 122, reasoningOutputTokens: 64 });
  });

  test("Antwort: finale Nachrichten nach dem letzten Werkzeug, mit Leerzeile verbunden; keine Zwischenmeldung", () => {
    expect(r.text).toBe("Das Stadtfest ist am 12. Juli.\n\nIch habe den Termin in notizen/termin.md eingetragen.");
    expect(r.text).not.toContain("Ich schaue zuerst");
    expect(r.lastText).toBe("Ich habe den Termin in notizen/termin.md eingetragen.");
  });

  test("Werkzeuge mit Claude-Namen, je Item einmal, file_change mit allen Pfaden", () => {
    expect(r.tools.uses).toEqual([
      { name: "mcp__gmail__search_threads" },
      { name: "WebSearch" },
      { name: "Bash", command: "bash -lc ls" },
      { name: "Edit", path: "notizen/termin.md" },
      { name: "Edit", path: "notizen/index.md" },
    ]);
    expect(r.tools.cwd).toBe(PROJECT);
  });

  test("Mail-Server über MCP: classifyTurnTools meldet foreign", () => {
    const verdict = classifyTurnTools(r.tools, PROJECT);
    expect(verdict.status).toBe("foreign");
    if (verdict.status === "foreign") expect(verdict.reasons).toContain("mcp__gmail__search_threads (Mail)");
  });

  test("Schritte für den Timeout-Bericht: Suchanfrage aus dem Abschluss, Pfade verbunden", () => {
    expect(r.steps).toEqual([
      { name: "mcp__gmail__search_threads" },
      { name: "WebSearch", input: "Stadtfest 2026 Termin" },
      { name: "Bash", input: "bash -lc ls" },
      { name: "Edit", input: "notizen/termin.md, notizen/index.md" },
    ]);
  });
});

describe("Antworttext", () => {
  test("nur eine Nachricht nach Werkzeug", () => {
    const t = turnFrom([line(started), line(message("a", "Moment")), line(command("b", "ls")), line(message("c", "Fertig")), line(completed)]);
    expect(t.result({ exitCode: 0, cwd: PROJECT }).text).toBe("Fertig");
  });

  test("item.updated und item.completed desselben Items: nur der letzte Stand, nicht doppelt", () => {
    const t = turnFrom([
      line({ type: "item.updated", item: { id: "m", type: "agent_message", text: "Halb" } }),
      line({ type: "item.completed", item: { id: "m", type: "agent_message", text: "Halb fertig und ganz" } }),
      line(completed),
    ]);
    expect(t.result({ exitCode: 0, cwd: PROJECT }).text).toBe("Halb fertig und ganz");
  });

  test("keine Nachricht nach dem letzten Werkzeug: letzte Nachricht", () => {
    const t = turnFrom([line(message("a", "Ich prüfe das")), line(command("b", "ls")), line(completed)]);
    expect(t.result({ exitCode: 0, cwd: PROJECT }).text).toBe("Ich prüfe das");
  });

  test("zitierter Fehlertext in einer erfolgreichen Antwort ist kein Fehler", () => {
    const t = turnFrom([line(message("a", "Die Meldung „You’ve hit your usage limit“ heißt: Kontingent aufgebraucht.")), line(completed)]);
    const r = t.result({ exitCode: 0, cwd: PROJECT });
    expect(r.isError).toBe(false);
    expect(r.errorKind).toBeUndefined();
  });

  test("Werkzeugliste unabhängig von Rückrufen: auch nur abgeschlossene Items zählen", () => {
    const t = turnFrom([line({ type: "item.completed", item: { id: "f", type: "file_change", changes: [{ path: "a.md", kind: "add" }], status: "completed" } })]);
    expect(t.toolUses()).toEqual([{ name: "Edit", path: "a.md" }]);
  });

  test("collab_tool_call wird Task (Unter-Agent, fremd)", () => {
    const t = turnFrom([line({ type: "item.started", item: { id: "c", type: "collab_tool_call", tool: "spawn_agent", prompt: "such", status: "in_progress" } })]);
    expect(t.toolUses()).toEqual([{ name: "Task" }]);
    expect(classifyTurnTools({ uses: t.toolUses() }, PROJECT).status).toBe("foreign");
  });
});

describe("Rückrufe", () => {
  test("Werkzeug einmal je Item mit Anzeigename, erster Text über 30 Zeichen einmal", () => {
    const tools: string[] = [];
    const texts: [string, string][] = [];
    turnFrom(FIXTURE, { onTool: (n) => tools.push(n), onFirstText: (s, f) => texts.push([s, f]) });
    expect(tools).toEqual(["Using gmail", "Searching the web", "Running command", "Editing file"]);
    expect(texts).toHaveLength(1);
    expect(texts[0]![1]).toBe("Ich schaue zuerst in die Mails und suche dann im Netz nach dem Termin.");
    expect(texts[0]![0]).toBe("Ich schaue zuerst in die Mails und suche dann im Netz nach dem Termin.");
  });

  test("kurze Nachricht löst onFirstText nicht aus", () => {
    const texts: string[] = [];
    turnFrom([line(message("a", "Kurz."))], { onFirstText: (s) => texts.push(s) });
    expect(texts).toEqual([]);
  });
});

describe("Fehler", () => {
  test("turn.failed: isError mit Meldung und Art", () => {
    const t = turnFrom([line(started), line({ type: "turn.failed", error: { message: "You’ve hit your usage limit. Upgrade to Pro or try again later." } })]);
    const r = t.result({ exitCode: 1, cwd: PROJECT });
    expect(r).toMatchObject({ isError: true, errorKind: "usage_limit", sessionId: "t-1" });
    expect(r.text).toContain("usage limit");
  });

  test("error-Ereignis ohne Abschluss ist ein Fehler, mit Abschluss nicht", () => {
    const failing = turnFrom([line(started), line({ type: "error", message: "rate limit exceeded" })]);
    expect(failing.result({ exitCode: 1, cwd: PROJECT })).toMatchObject({ isError: true, errorKind: "rate_limit" });
    const retried = turnFrom([line(started), line({ type: "error", message: "Reconnecting... 1/5" }), line(message("a", "Da bin ich")), line(completed)]);
    expect(retried.result({ exitCode: 0, cwd: PROJECT })).toMatchObject({ isError: false, text: "Da bin ich" });
  });

  test("ohne turn.completed und mit Exit 1: Fehler, auch wenn schon Text da ist", () => {
    const t = turnFrom([line(started), line(message("a", "Zwischenstand, gleich mehr dazu"))]);
    const r = t.result({ exitCode: 1, cwd: PROJECT });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("ohne Abschluss");
    expect(r.lastText).toBe("Zwischenstand, gleich mehr dazu");
  });

  test("turn.completed, aber Exit-Code ungleich 0: Fehler", () => {
    const t = turnFrom([line(message("a", "Antwort")), line(completed)]);
    expect(t.result({ exitCode: 1, cwd: PROJECT })).toMatchObject({ isError: true, text: "Codex endete mit Exit-Code 1" });
  });

  test("nur stderr (Startfehler): Meldung aus stderr, Art erkannt", () => {
    const loggedOut = new CodexTurn().result({ exitCode: 1, stderr: "Error: Not logged in. Run `codex login`.\n", cwd: PROJECT });
    expect(loggedOut).toMatchObject({ isError: true, errorKind: "auth", text: "Error: Not logged in. Run `codex login`." });
    const missing = new CodexTurn().result({ exitCode: 1, stderr: "caffeinate: codex: No such file or directory", cwd: PROJECT });
    expect(missing).toMatchObject({ isError: true, errorKind: "not_installed" });
    expect(new CodexTurn().result({ exitCode: null, cwd: PROJECT })).toMatchObject({ isError: true, errorKind: "other" });
  });

  test("codexErrorKind: alle Arten, tolerant gegen ’ und '", () => {
    expect(codexErrorKind("You’ve hit your usage limit. Try again at 5 PM.")).toBe("usage_limit");
    expect(codexErrorKind("You've hit your usage limit.")).toBe("usage_limit");
    expect(codexErrorKind("exceeded retry limit, last status: 429 Too Many Requests")).toBe("rate_limit");
    expect(codexErrorKind("stream error: rate limit exceeded")).toBe("rate_limit");
    expect(codexErrorKind("Quota exceeded. Check your plan and billing details.")).toBe("quota");
    expect(codexErrorKind("Selected model is at capacity. Please try a different model.")).toBe("capacity");
    expect(codexErrorKind("Codex ran out of room in the model’s context window.")).toBe("context");
    expect(codexErrorKind("Not logged in")).toBe("auth");
    expect(codexErrorKind("unexpected status 401 Unauthorized")).toBe("auth");
    expect(codexErrorKind("irgendwas anderes")).toBe("other");
  });
});

describe("Zeilenleser", () => {
  const enc = new TextEncoder();

  test("Zeilen über Chunks verteilt, geteiltes UTF-8-Zeichen, letzte Zeile ohne Umbruch", () => {
    const events: CodexEvent[] = [];
    const reader = createLineReader((l) => {
      const e = parseCodexEvent(l);
      if (e) events.push(e);
    });
    const bytes = enc.encode(
      [line(started), line(message("a", "Grüße aus Köln, schön dass du da bist")), line(completed)].join("\n")
    );
    // In Stücke zu 7 Bytes: trennt JSON mitten im Wort und die Umlaute mitten im Zeichen
    for (let i = 0; i < bytes.length; i += 7) reader.push(bytes.slice(i, i + 7));
    expect(events.map((e) => e.type)).toEqual(["thread.started", "item"]);
    reader.end();
    expect(events.map((e) => e.type)).toEqual(["thread.started", "item", "turn.completed"]);
    const item = events[1] as Extract<CodexEvent, { type: "item" }>;
    expect(item.item.text).toBe("Grüße aus Köln, schön dass du da bist");
  });

  test("ganze Fixture Byte für Byte ergibt dasselbe wie zeilenweise", () => {
    const whole = turnFrom(FIXTURE).result({ exitCode: 0, cwd: PROJECT });
    const turn = new CodexTurn();
    const reader = createLineReader((l) => {
      const e = parseCodexEvent(l);
      if (e) turn.apply(e);
    });
    for (const b of enc.encode(FIXTURE)) reader.push(new Uint8Array([b]));
    reader.end();
    expect(turn.result({ exitCode: 0, cwd: PROJECT })).toEqual(whole);
  });
});
