/**
 * Issue #382: Fehlerformat von callBuiltinTool (src/lib/tools/registry.ts),
 * festgehalten vor dem Umbau. Unbekanntes Werkzeug, nicht verfügbares
 * Werkzeug und ein werfender Handler ergeben isError true mit
 * JSON {"error": "..."} als Inhalt; ein Erfolg den Text des Handlers.
 */
import { describe, expect, test } from "bun:test";
import { callBuiltinTool, registerBuiltinTool } from "../src/lib/tools/registry";

const schema = { type: "object" as const, properties: {} };

registerBuiltinTool({ name: "t382_ok", description: "liest", inputSchema: schema, isAvailable: () => true, handler: async () => "fertig" });
registerBuiltinTool({ name: "t382_weg", description: "ohne Schlüssel", inputSchema: schema, isAvailable: () => false, handler: async () => "nie" });
registerBuiltinTool({
  name: "t382_wirft",
  description: "scheitert",
  inputSchema: schema,
  isAvailable: () => true,
  handler: async () => {
    throw new Error("Dienst antwortet nicht");
  },
});

describe("callBuiltinTool: Ergebnis und Fehlerformat", () => {
  test("Erfolg: Text des Handlers", async () => {
    expect(await callBuiltinTool("t382_ok", {})).toEqual({ content: "fertig", isError: false });
  });

  test("unbekanntes Werkzeug", async () => {
    expect(await callBuiltinTool("t382_gibt_es_nicht", {})).toEqual({
      content: JSON.stringify({ error: "Unknown built-in tool: t382_gibt_es_nicht" }),
      isError: true,
    });
  });

  test("nicht verfügbar", async () => {
    expect(await callBuiltinTool("t382_weg", {})).toEqual({
      content: JSON.stringify({ error: "Tool t382_weg nicht verfuegbar (Credential fehlt?)" }),
      isError: true,
    });
  });

  test("Handler wirft: Meldung des Fehlers als JSON", async () => {
    expect(await callBuiltinTool("t382_wirft", {})).toEqual({
      content: JSON.stringify({ error: "Dienst antwortet nicht" }),
      isError: true,
    });
  });
});
