/**
 * Phase eines hängenden Claude-Aufrufs (Befund 30.9.2026): der Tracker liest
 * die stream-json-Ereignisse mit --include-partial-messages, wie die CLI sie
 * schickt (Reihenfolge aus einem echten Lauf abgeschrieben).
 */
import { describe, expect, test } from "bun:test";
import { StreamPhaseTracker, stallPhaseLogText, stallPhaseUserText } from "../src/lib/stream-phase";

const se = (event: object, parent: string | null = null) => ({ type: "stream_event", event, parent_tool_use_id: parent });
const INIT = { type: "system", subtype: "init", session_id: "s1" };
const toolUse = (id: string, name: string, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { id: "m-" + id, content: [{ type: "tool_use", id, name, input: {} }] },
});
const toolResult = (id: string) => ({
  type: "user",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});

describe("StreamPhaseTracker", () => {
  test("vor init: Start der CLI", () => {
    const t = new StreamPhaseTracker(1000);
    t.observe({ type: "system", subtype: "hook_started" }, 2000);
    expect(t.snapshot(5000)).toEqual({ kind: "startup", sinceMs: 4000 });
  });

  test("nach init ohne Bytes: wartet auf die API seit init", () => {
    const t = new StreamPhaseTracker(0);
    t.observe(INIT, 3000);
    t.observe({ type: "system", subtype: "status" }, 3500);
    expect(t.snapshot(933_000)).toEqual({ kind: "api", sinceMs: 930_000, afterTool: false });
  });

  test("message_start und Deltas: Modell generiert, letztes Delta zählt", () => {
    const t = new StreamPhaseTracker(0);
    t.observe(INIT, 0);
    t.observe(se({ type: "message_start", message: { id: "m1" } }), 1000);
    t.observe(se({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }), 1100);
    t.observe(se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } }), 4000);
    expect(t.snapshot(10_000)).toEqual({ kind: "generating", sinceMs: 9000, lastDeltaAgoMs: 6000, block: "thinking" });
  });

  test("message_start ohne Delta: generating mit Delta-Alter seit message_start", () => {
    const t = new StreamPhaseTracker(0);
    t.observe(INIT, 0);
    t.observe(se({ type: "message_start" }), 2000);
    expect(t.snapshot(12_000)).toEqual({ kind: "generating", sinceMs: 10_000, lastDeltaAgoMs: 10_000 });
  });

  test("Werkzeugaufruf nach message_stop: Werkzeug läuft seit dem assistant-Ereignis", () => {
    const t = new StreamPhaseTracker(0);
    t.observe(INIT, 0);
    t.observe(se({ type: "message_start" }), 1000);
    t.observe(se({ type: "content_block_start", content_block: { type: "tool_use", name: "Grep" } }), 1100);
    t.observe(se({ type: "content_block_delta", delta: { type: "input_json_delta" } }), 1200);
    t.observe(toolUse("t1", "Grep"), 1500);
    // Noch während der Nachricht: generating hat Vorrang
    expect(t.snapshot(1600).kind).toBe("generating");
    t.observe(se({ type: "content_block_stop" }), 1600);
    t.observe(se({ type: "message_delta" }), 1600);
    t.observe(se({ type: "message_stop" }), 1700);
    expect(t.snapshot(901_500)).toEqual({ kind: "tool", sinceMs: 900_000, name: "Grep", count: 1 });
  });

  test("Ergebnis aller Werkzeuge: wieder API-Wartezeit, afterTool", () => {
    const t = new StreamPhaseTracker(0);
    t.observe(INIT, 0);
    t.observe(toolUse("a", "Read"), 1000);
    t.observe(toolUse("b", "Bash"), 1000);
    t.observe(toolResult("a"), 2000);
    expect(t.snapshot(3000)).toEqual({ kind: "tool", sinceMs: 2000, name: "Bash", count: 1 });
    t.observe(toolResult("b"), 5000);
    expect(t.snapshot(8000)).toEqual({ kind: "api", sinceMs: 3000, afterTool: true });
  });

  test("Unter-Agent: seine Ereignisse ändern die Phase nicht", () => {
    const t = new StreamPhaseTracker(0);
    t.observe(INIT, 0);
    t.observe(toolUse("ag", "Agent"), 1000);
    t.observe(se({ type: "message_start" }, "ag"), 2000);
    t.observe(se({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }, "ag"), 3000);
    t.observe(toolUse("sub1", "Bash", "ag"), 4000);
    t.observe({ type: "user", parent_tool_use_id: "ag", message: { content: [{ type: "tool_result", tool_use_id: "sub1" }] } }, 5000);
    expect(t.snapshot(61_000)).toEqual({ kind: "tool", sinceMs: 60_000, name: "Agent", count: 1 });
  });

  test("letzte Nachricht ohne Werkzeug, kein result: finishing", () => {
    const t = new StreamPhaseTracker(0);
    t.observe(INIT, 0);
    t.observe(se({ type: "message_start" }), 1000);
    t.observe({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "fertig" }] } }, 1500);
    t.observe(se({ type: "message_stop" }), 2000);
    expect(t.snapshot(5000)).toEqual({ kind: "finishing", sinceMs: 3000 });
  });

  test("ohne stream_event (ältere CLI): Werkzeug und API-Wartezeit trotzdem erkannt", () => {
    const t = new StreamPhaseTracker(0);
    t.observe(INIT, 0);
    t.observe(toolUse("t1", "WebFetch"), 1000);
    expect(t.snapshot(2000).kind).toBe("tool");
    t.observe(toolResult("t1"), 3000);
    expect(t.snapshot(4000)).toEqual({ kind: "api", sinceMs: 1000, afterTool: true });
  });
});

describe("Texte", () => {
  test("Log-Zeile", () => {
    expect(stallPhaseLogText({ kind: "api", sinceMs: 930_000, afterTool: false })).toBe(
      "wartet auf API seit 930s (keine Bytes seit Request/init)"
    );
    expect(stallPhaseLogText({ kind: "generating", sinceMs: 940_000, lastDeltaAgoMs: 930_000, block: "text" })).toBe(
      "Modell generiert (letztes Delta vor 930s, Block text, message_start vor 940s)"
    );
    expect(stallPhaseLogText({ kind: "tool", sinceMs: 930_000, name: "Grep", count: 2 })).toBe(
      "Werkzeug Grep läuft seit 930s (2 offen)"
    );
  });

  test("Nutzer-Satz", () => {
    expect(stallPhaseUserText({ kind: "api", sinceMs: 930_000, afterTool: true })).toBe(
      "Hing beim Warten auf die Anthropic-API: seit 16 Minuten kam keine Antwort (nach dem letzten Werkzeug)."
    );
    expect(stallPhaseUserText({ kind: "generating", sinceMs: 1000, lastDeltaAgoMs: 45_000 })).toBe(
      "Hing mitten in einer Antwort des Modells: das letzte Stück kam vor 45 Sekunden."
    );
    expect(stallPhaseUserText({ kind: "generating", sinceMs: 1000, lastDeltaAgoMs: 900_000, block: "thinking" })).toBe(
      "Hing mitten in einer Antwort des Modells beim Nachdenken: das letzte Stück kam vor 15 Minuten."
    );
    expect(stallPhaseUserText({ kind: "tool", sinceMs: 900_000, name: "Grep", count: 1 })).toBe(
      "Hing im Werkzeug Grep: läuft seit 15 Minuten."
    );
    expect(stallPhaseUserText({ kind: "startup", sinceMs: 60_000 })).toBe(
      "Hing beim Start von Claude Code (seit 60 Sekunden nicht bereit)."
    );
  });
});
