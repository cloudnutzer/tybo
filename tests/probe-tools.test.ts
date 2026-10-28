/**
 * Issue #332: netzfreie Teile der Werkzeugprobe setup/probe-tools.ts
 * (Optionen, lokale Telegram-Prüfung, Bewertung der Werkzeugaufrufe samt
 * Exitcode, Grenze auf lesende Werkzeuge bei --fallback) und der Eintrag
 * test:tools.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FORMAT_SAMPLES,
  formatProblems,
  mcpCallVerdict,
  parseProbeArgs,
  pickProbeTool,
  probeExitCode,
  probeFallbackTool,
  probeMcpTool,
} from "../setup/probe-tools";
import { McpManager, type OpenAITool } from "../src/lib/mcp/manager";
import { setToolApprovalHandler } from "../src/lib/tools";
import { fakeFactory, localSpecs, type FakeServer } from "./mcp-fixture";

const root = join(import.meta.dir, "..");

const previousReadOnly = process.env.MCP_READ_ONLY_TOOLS;
afterEach(() => {
  setToolApprovalHandler(null);
  if (previousReadOnly === undefined) delete process.env.MCP_READ_ONLY_TOOLS;
  else process.env.MCP_READ_ONLY_TOOLS = previousReadOnly;
});

describe("Optionen", () => {
  test("ohne Optionen nichts Kostenpflichtiges oder Sendendes", () => {
    expect(parseProbeArgs([])).toEqual({ options: new Set(), unknown: [] });
  });

  test("einzelne Optionen und --alles", () => {
    expect([...parseProbeArgs(["--fallback", "--send"]).options].sort()).toEqual(["fallback", "send"]);
    expect([...parseProbeArgs(["--alles"]).options].sort()).toEqual(["apify", "fallback", "send", "telegram"]);
  });

  test("unbekannte Option wird gemeldet", () => {
    expect(parseProbeArgs(["--apify", "--gibtsnicht"]).unknown).toEqual(["--gibtsnicht"]);
  });
});

describe("lokale Telegram-Prüfung", () => {
  test("alle Beispiele bestehen, die lange Nachricht wird geteilt", () => {
    for (const sample of FORMAT_SAMPLES) expect(formatProblems(sample)).toEqual([]);
    expect(FORMAT_SAMPLES.some((s) => s.markdown.length > 4000)).toBe(true);
  });

  test("kurze Nachricht mit Sonderzeichen besteht", () => {
    expect(formatProblems({ name: "kurz", markdown: "a < b" })).toEqual([]);
  });
});

test("bun run test:tools startet die Probe", () => {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  expect(scripts["test:tools"]).toBe("bun run setup/probe-tools.ts");
});

describe("MCP-Aufruf über den Manager", () => {
  const entries = ["s/mcp_p_lesen"];
  function manager(servers: Record<string, FakeServer>, callTimeoutMs = 2000) {
    const fake = fakeFactory(servers);
    return { ...fake, manager: new McpManager({ specs: localSpecs(...Object.keys(servers)), resolve: (s) => s, transports: fake.factory, callTimeoutMs }) };
  }

  test("Antwort des Servers besteht, auch als Werkzeugfehler", async () => {
    process.env.MCP_READ_ONLY_TOOLS = "s/mcp_p_lesen";
    const { manager: m } = manager({ s: { tools: [{ name: "mcp_p_lesen" }], answer: () => ({ content: [{ type: "text", text: "leer" }], isError: true }) } });
    await m.init();
    const verdict = await probeMcpTool(m, entries);
    expect(verdict.name).toBe("MCP-Werkzeug s/mcp_p_lesen über den Manager");
    expect(verdict.outcome).toBe("ok");
    await m.shutdown();
  });

  test("JSON-RPC-Validierungsfehler (-32602) belegt den Serverkontakt, Exit 0", async () => {
    process.env.MCP_READ_ONLY_TOOLS = "s/mcp_p_lesen";
    const { manager: m, transports } = manager({ s: { tools: [{ name: "mcp_p_lesen" }], callError: "Invalid arguments", callErrorCode: -32602 } });
    await m.init();
    const verdict = await probeMcpTool(m, entries);
    expect(verdict.outcome).toBe("ok");
    expect(verdict.detail).toContain("-32602");
    expect(transports.s[0].calls.length).toBe(1);
    expect(probeExitCode([verdict.outcome])).toBe(0);
    await m.shutdown();
  });

  test("Verbindungsfehler beim Aufruf ist ein Fehler, Exit 1", async () => {
    process.env.MCP_READ_ONLY_TOOLS = "s/mcp_p_lesen";
    const { manager: m } = manager({ s: { tools: [{ name: "mcp_p_lesen" }], dropOnCall: true } });
    await m.init();
    const verdict = await probeMcpTool(m, entries);
    expect(verdict.outcome).toBe("fehler");
    expect(verdict.detail).toStartWith("Fehler auf dem Weg zum Server");
    expect(probeExitCode([verdict.outcome])).toBe(1);
    await m.shutdown();
  });

  test("verweigerte Freigabe ist ein Fehler, Exit 1, Server nicht aufgerufen", async () => {
    delete process.env.MCP_READ_ONLY_TOOLS;
    setToolApprovalHandler(async () => false);
    const { manager: m, transports } = manager({ s: { tools: [{ name: "mcp_p_lesen" }] } });
    await m.init();
    const verdict = await probeMcpTool(m, entries);
    expect(verdict.outcome).toBe("fehler");
    expect(verdict.detail).toStartWith("Freigabe verweigert");
    expect(transports.s[0].calls.length).toBe(0);
    expect(probeExitCode(["ok", verdict.outcome])).toBe(1);
    await m.shutdown();
  });

  test("Zeitlimit ist ein Fehler, Exit 1", async () => {
    process.env.MCP_READ_ONLY_TOOLS = "s/mcp_p_lesen";
    const { manager: m } = manager({ s: { tools: [{ name: "mcp_p_lesen" }], hang: "tools/call" } }, 30);
    await m.init();
    const verdict = await probeMcpTool(m, entries);
    expect(verdict.outcome).toBe("fehler");
    expect(verdict.detail).toStartWith("Zeitlimit");
    expect(probeExitCode([verdict.outcome])).toBe(1);
    await m.shutdown();
  });

  test("Serveranteil zählt: dasselbe Werkzeug bei einem anderen Server wird nicht genommen", async () => {
    process.env.MCP_READ_ONLY_TOOLS = "andere/mcp_p_lesen";
    const { manager: m, transports } = manager({ s: { tools: [{ name: "mcp_p_lesen" }] } });
    await m.init();
    const verdict = await probeMcpTool(m, ["andere/mcp_p_lesen", "ohne-schraegstrich", "/mcp_p_lesen"]);
    expect(verdict.outcome).toBe("übersprungen");
    expect(transports.s[0].calls.length).toBe(0);
    await m.shutdown();
  });

  test("Fehlerarten bleiben unterscheidbar", () => {
    expect(mcpCallVerdict({ content: "x", isError: true, failure: "not_connected" }).detail).toStartWith("Server nicht verbunden");
    expect(mcpCallVerdict({ content: "x", isError: true, failure: "error" }).outcome).toBe("fehler");
    expect(mcpCallVerdict({ content: "x", isError: false }).outcome).toBe("ok");
  });
});

describe("--fallback: nur lesende Werkzeuge", () => {
  const tool = (name: string): OpenAITool => ({ type: "function", function: { name, description: name, parameters: { type: "object" } } });
  const okCall = async () => ({ content: "treffer", isError: false });

  test("Apify und Telegram-Versand werden nie angeboten, ohne lesendes Werkzeug Fehler mit Exit 1", async () => {
    expect(pickProbeTool(["apify_run_actor", "telegram_send_document", "elevenlabs_tts"])).toBeUndefined();
    let ran = false;
    const verdict = await probeFallbackTool([tool("apify_run_actor"), tool("telegram_send_document")], okCall, async () => ((ran = true), "x"));
    expect(ran).toBe(false);
    expect(verdict.outcome).toBe("fehler");
    expect(probeExitCode([verdict.outcome])).toBe(1);
  });

  test("history_search geht vor, angeboten wird genau ein Werkzeug", async () => {
    let offered: string[] = [];
    const verdict = await probeFallbackTool([tool("apify_run_actor"), tool("firecrawl_search"), tool("history_search")], okCall, async (t, call) => {
      offered = [t.function.name];
      await call(t.function.name, { query: "test" });
      return "Es kam ein Treffer.";
    });
    expect(offered).toEqual(["history_search"]);
    expect(verdict.outcome).toBe("ok");
    expect(probeExitCode([verdict.outcome])).toBe(0);
  });

  test("ein vom Modell genannter anderer Name wird abgelehnt und nicht ausgeführt", async () => {
    const executed: string[] = [];
    const verdict = await probeFallbackTool([tool("history_search"), tool("apify_run_actor")], async (name) => (executed.push(name), { content: "ok", isError: false }), async (t, call) => {
      const refused = await call("apify_run_actor", {});
      expect(refused.isError).toBe(true);
      await call(t.function.name, {});
      return "fertig";
    });
    expect(executed).toEqual(["history_search"]);
    expect(verdict.outcome).toBe("fehler");
    expect(verdict.detail).toContain("apify_run_actor → abgelehnt");
    expect(probeExitCode([verdict.outcome])).toBe(1);
  });

  test("fehlgeschlagenes Werkzeug (isError) ist kein Erfolg, Exit 1", async () => {
    const verdict = await probeFallbackTool([tool("history_search")], async () => ({ content: "kaputt", isError: true }), async (t, call) => {
      await call(t.function.name, {});
      return "Leider ein Fehler.";
    });
    expect(verdict.outcome).toBe("fehler");
    expect(verdict.detail).toContain("history_search → Fehler");
    expect(probeExitCode([verdict.outcome])).toBe(1);
  });

  test("ohne Aufruf oder ohne Antwort Fehler", async () => {
    expect((await probeFallbackTool([tool("history_search")], okCall, async () => "ohne Werkzeug")).outcome).toBe("fehler");
    expect((await probeFallbackTool([tool("history_search")], okCall, async (t, call) => (await call(t.function.name, {}), ""))).outcome).toBe("fehler");
  });

  test("Ausnahme im Tool-Loop ist ein Fehler", async () => {
    const verdict = await probeFallbackTool([tool("history_search")], okCall, async () => {
      throw new Error("HTTP 500");
    });
    expect(verdict).toEqual({ outcome: "fehler", detail: "HTTP 500" });
  });
});
