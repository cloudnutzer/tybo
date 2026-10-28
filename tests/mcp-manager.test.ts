/**
 * Issue #332: MCP-Manager (src/lib/mcp/manager.ts) mit Fake-Transport,
 * ohne Prozesse und Netz.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { McpManager, mcpClientName } from "../src/lib/mcp/manager";
import { mcpManager as legacyManager, McpManager as LegacyClass } from "../src/lib/mcp-client";
import { abortExecutions, isAbortError, runExecution } from "../src/lib/execution-context";
import { getAvailableBuiltinTools, registerBuiltinTool, setToolApprovalHandler } from "../src/lib/tools";
import { fakeFactory, localSpecs, type FakeServer } from "./mcp-fixture";

const builtinCount = () => getAvailableBuiltinTools().length;

function setup(servers: Record<string, FakeServer>, order = Object.keys(servers), startTimeoutMs = 2000) {
  const fake = fakeFactory(servers);
  const manager = new McpManager({ specs: localSpecs(...order), resolve: (s) => s, transports: fake.factory, startTimeoutMs });
  return { manager, ...fake };
}

const previousReadOnly = process.env.MCP_READ_ONLY_TOOLS;
afterEach(() => {
  setToolApprovalHandler(null);
  if (previousReadOnly === undefined) delete process.env.MCP_READ_ONLY_TOOLS;
  else process.env.MCP_READ_ONLY_TOOLS = previousReadOnly;
});

describe("Start", () => {
  test("verbindet, meldet sich als tybo-<server>, sammelt Werkzeuge in beiden Formaten", async () => {
    const { manager, transports } = setup({
      wetter: { tools: [{ name: "mcp_t_wetter", description: "Wetter", inputSchema: { type: "object", properties: { ort: { type: "string" } }, required: ["ort"] } }] },
    });
    expect(manager.isReady).toBe(false);
    expect(manager.getStatus()).toBe("not initialized");
    await manager.init();
    expect(manager.isReady).toBe(true);
    expect(transports.wetter[0].clientName).toBe(mcpClientName("wetter"));
    expect(mcpClientName("wetter")).toBe("tybo-wetter");

    const openai = manager.getOpenAITools().find((t) => t.function.name === "mcp_t_wetter");
    expect(openai).toEqual({
      type: "function",
      function: { name: "mcp_t_wetter", description: "Wetter", parameters: { type: "object", properties: { ort: { type: "string" } }, required: ["ort"] } },
    });
    const anthropic = manager.getAnthropicTools().find((t) => t.name === "mcp_t_wetter");
    expect(anthropic).toEqual({
      name: "mcp_t_wetter",
      description: "Wetter",
      input_schema: { type: "object", properties: { ort: { type: "string" } }, required: ["ort"] },
    });
    expect(manager.getOpenAITools().length).toBe(1 + builtinCount());
    expect(manager.getAnthropicTools().length).toBe(manager.getOpenAITools().length);
    expect(manager.toolCount).toBe(manager.getOpenAITools().length);
    expect(manager.hasTool("mcp_t_wetter")).toBe(true);
    expect(manager.hasTool("mcp_t_gibts_nicht")).toBe(false);
    expect(manager.getStatus()).toBe(`1 servers, 1 MCP tools + ${builtinCount()} built-ins: wetter(1)`);
    await manager.shutdown();
  });

  test("ohne Server: nur Built-ins, Status nennt sie", async () => {
    const { manager } = setup({});
    await manager.init();
    expect(manager.isReady).toBe(true);
    expect(manager.toolCount).toBe(builtinCount());
    expect(manager.getStatus()).toBe(builtinCount() > 0 ? `no servers, ${builtinCount()} built-in tools` : "no servers");
  });

  test("Transport-Fabrik bekommt die aufgelöste Beschreibung", async () => {
    const fake = fakeFactory({ "remote.example": { tools: [{ name: "mcp_t_remote" }] } });
    const manager = new McpManager({
      specs: () => new Map([["r", { kind: "http", url: "https://remote.example/${PFAD}", headers: { A: "${TOKEN}" } }]]),
      resolve: (spec) => (spec.kind === "http" ? { ...spec, url: spec.url.replace("${PFAD}", "mcp"), headers: { A: "wert" } } : spec),
      transports: fake.factory,
    });
    await manager.init();
    expect(fake.specs).toEqual([{ kind: "http", url: "https://remote.example/mcp", headers: { A: "wert" } }]);
    expect(manager.hasTool("mcp_t_remote")).toBe(true);
    await manager.shutdown();
  });

  test("mehrfaches und gleichzeitiges init startet jeden Server nur einmal", async () => {
    const { manager, specs } = setup({ a: { tools: [{ name: "mcp_t_a" }] }, b: { tools: [{ name: "mcp_t_b" }] } });
    await Promise.all([manager.init(), manager.init(), manager.init()]);
    await manager.init();
    expect(specs.length).toBe(2);
    await manager.shutdown();
  });

  test("ein scheiternder Server hält die anderen nicht auf", async () => {
    const { manager, transports } = setup({ kaputt: { failStart: "spawn ENOENT" }, gut: { tools: [{ name: "mcp_t_gut" }] } });
    await manager.init();
    expect(manager.isReady).toBe(true);
    expect(manager.hasTool("mcp_t_gut")).toBe(true);
    expect(manager.getStatus()).toStartWith("1 servers, 1 MCP tools");
    expect(transports.kaputt[0].closeCount).toBeGreaterThan(0);
    await manager.shutdown();
  });

  test("Zeitlimit: hängender Server wird geschlossen, Start endet trotzdem", async () => {
    const { manager, transports } = setup({ haengt: { hang: "initialize" }, liste: { hang: "tools/list" }, gut: { tools: [{ name: "mcp_t_gut2" }] } }, undefined, 50);
    const started = Date.now();
    await manager.init();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(transports.haengt[0].closeCount).toBeGreaterThan(0);
    expect(transports.liste[0].closeCount).toBeGreaterThan(0);
    expect(manager.getStatus()).toStartWith("1 servers, 1 MCP tools");
    await manager.shutdown();
  });

  test("gleiches Werkzeug bei zwei Servern: der frühere in der Konfiguration gilt", async () => {
    let called = "";
    const { manager } = setup({
      erster: { tools: [{ name: "mcp_t_doppelt", description: "eins" }], answer: () => ((called = "erster"), { content: [] }) },
      zweiter: { tools: [{ name: "mcp_t_doppelt", description: "zwei" }, { name: "mcp_t_nur2" }], answer: () => ((called = "zweiter"), { content: [] }) },
    });
    await manager.init();
    expect(manager.getOpenAITools().filter((t) => t.function.name === "mcp_t_doppelt").map((t) => t.function.description)).toEqual(["eins"]);
    expect(manager.getStatus()).toContain("erster(1), zweiter(1)");
    process.env.MCP_READ_ONLY_TOOLS = "erster/mcp_t_doppelt";
    await manager.callTool("mcp_t_doppelt", {});
    expect(called).toBe("erster");
    await manager.shutdown();
  });

  test("keine eigenen Prozess-Handler", async () => {
    const counts = () => ["SIGINT", "SIGTERM", "exit", "beforeExit"].map((e) => process.listenerCount(e));
    const before = counts();
    const { manager } = setup({ a: { tools: [{ name: "mcp_t_sig" }] } });
    await manager.init();
    await manager.shutdown();
    await manager.init();
    expect(counts()).toEqual(before);
    await manager.shutdown();
  });
});

describe("Aufruf", () => {
  test("Ergebnis: Textblöcke verbunden, andere als JSON, leer ergibt OK, isError bleibt", async () => {
    const { manager } = setup({
      s: {
        tools: [{ name: "mcp_t_mix" }, { name: "mcp_t_leer" }, { name: "mcp_t_fehler" }],
        answer: (name) =>
          name === "mcp_t_mix"
            ? { content: [{ type: "text", text: "a" }, { type: "image", data: "eA==", mimeType: "image/png" }, { type: "text", text: "b" }] }
            : name === "mcp_t_leer"
              ? { content: [] }
              : { content: [{ type: "text", text: "kaputt" }], isError: true },
      },
    });
    process.env.MCP_READ_ONLY_TOOLS = "s/mcp_t_mix, s/mcp_t_leer,s/mcp_t_fehler";
    await manager.init();
    expect(await manager.callTool("mcp_t_mix", { x: 1 })).toEqual({
      content: `a\n${JSON.stringify({ type: "image", data: "eA==", mimeType: "image/png" })}\nb`,
      isError: false,
    });
    expect(await manager.callTool("mcp_t_leer", {})).toEqual({ content: "OK", isError: false });
    expect(await manager.callTool("mcp_t_fehler", {})).toEqual({ content: "kaputt", isError: true });
    await manager.shutdown();
  });

  test("Argumente kommen beim Server an; Serverfehler wird zum Ergebnis mit isError", async () => {
    const { manager, transports } = setup({ s: { tools: [{ name: "mcp_t_err" }], callError: "kaputt" } });
    process.env.MCP_READ_ONLY_TOOLS = "s/mcp_t_err";
    await manager.init();
    const result = await manager.callTool("mcp_t_err", { q: "x" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("kaputt");
    expect(transports.s[0].calls).toEqual([{ name: "mcp_t_err", args: { q: "x" } }]);
    await manager.shutdown();
  });

  test("JSON-RPC-Fehlerantwort (-32602) zählt als Antwort des Servers, nicht als Fehler auf dem Weg", async () => {
    const { manager } = setup({ s: { tools: [{ name: "mcp_t_valid" }], callError: "Invalid arguments: q required", callErrorCode: -32602 } });
    process.env.MCP_READ_ONLY_TOOLS = "s/mcp_t_valid";
    await manager.init();
    const result = await manager.callTool("mcp_t_valid", {});
    expect(result.isError).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(JSON.parse(result.content).error).toContain("-32602");
    await manager.shutdown();
  });

  test("abgebrochene Verbindung bleibt ein Fehler auf dem Weg, auch mit demselben Code -32000", async () => {
    const { manager } = setup({ s: { tools: [{ name: "mcp_t_weg" }], dropOnCall: true } });
    process.env.MCP_READ_ONLY_TOOLS = "s/mcp_t_weg";
    await manager.init();
    const result = await manager.callTool("mcp_t_weg", {});
    expect(result.isError).toBe(true);
    expect(result.failure).toBe("error");
    expect(JSON.parse(result.content).error).toContain("-32000");
    await manager.shutdown();
  });

  test("unbekanntes Werkzeug geht an die Built-in-Registry", async () => {
    const { manager } = setup({});
    await manager.init();
    const result = await manager.callTool("mcp_t_unbekannt", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown built-in tool");
  });
});

describe("Freigabe", () => {
  test("ohne Eintrag in MCP_READ_ONLY_TOOLS fragt jeder Aufruf; Ablehnung ruft den Server nicht", async () => {
    const { manager, transports } = setup({ s: { tools: [{ name: "mcp_t_schreib", description: "Behauptet harmlos" }] } });
    const asked: string[] = [];
    let approve = false;
    setToolApprovalHandler(async (tool) => (asked.push(tool.description), approve));
    await manager.init();

    const denied = await manager.callTool("mcp_t_schreib", {});
    expect(denied.isError).toBe(true);
    expect(transports.s[0].calls.length).toBe(0);
    expect(asked).toEqual(["MCP s: Behauptet harmlos"]);

    approve = true;
    expect(await manager.callTool("mcp_t_schreib", {})).toEqual({ content: "ok:mcp_t_schreib", isError: false });
    expect(transports.s[0].calls.length).toBe(1);
    await manager.shutdown();
  });

  test("ohne Freigabe-Handler wird nicht ausgeführt", async () => {
    const { manager, transports } = setup({ s: { tools: [{ name: "mcp_t_ohne" }] } });
    await manager.init();
    const result = await manager.callTool("mcp_t_ohne", {});
    expect(result.isError).toBe(true);
    expect(transports.s[0].calls.length).toBe(0);
    await manager.shutdown();
  });

  test("MCP_READ_ONLY_TOOLS gilt nur für server/werkzeug, nicht für den Werkzeugnamen allein", async () => {
    const { manager, transports } = setup({ s: { tools: [{ name: "mcp_t_lesen" }] } });
    let asked = 0;
    setToolApprovalHandler(async () => (asked++, false));
    await manager.init();
    process.env.MCP_READ_ONLY_TOOLS = "mcp_t_lesen";
    expect((await manager.callTool("mcp_t_lesen", {})).isError).toBe(true);
    expect(asked).toBe(1);
    process.env.MCP_READ_ONLY_TOOLS = "s/mcp_t_lesen";
    expect((await manager.callTool("mcp_t_lesen", {})).isError).toBe(false);
    expect(asked).toBe(1);
    expect(transports.s[0].calls.length).toBe(1);
    await manager.shutdown();
  });

  test("allowedTools der Ausführung sperrt andere Werkzeuge", async () => {
    const { manager, transports } = setup({ s: { tools: [{ name: "mcp_t_erlaubt" }, { name: "mcp_t_gesperrt" }] } });
    process.env.MCP_READ_ONLY_TOOLS = "s/mcp_t_erlaubt,s/mcp_t_gesperrt";
    await manager.init();
    const results = await runExecution("mcp-test-allowed", "general", async () => [
      await manager.callTool("mcp_t_erlaubt", {}),
      await manager.callTool("mcp_t_gesperrt", {}),
    ], ["mcp_t_erlaubt"]);
    expect(results.map((r) => r.isError)).toEqual([false, true]);
    expect(transports.s[0].calls.map((c) => c.name)).toEqual(["mcp_t_erlaubt"]);
    await manager.shutdown();
  });

  test("Built-in gleichen Namens geht vor: nicht doppelt angeboten, Aufruf mit lokaler Freigabe", async () => {
    let local = 0;
    registerBuiltinTool({
      name: "mcp_t_lokal", description: "lokal geschützt", requiresApproval: true,
      inputSchema: { type: "object", properties: {} }, isAvailable: () => true, handler: async () => (local++, "lokal"),
    });
    const { manager, transports } = setup({ s: { tools: [{ name: "mcp_t_lokal", description: "fremd" }] } });
    process.env.MCP_READ_ONLY_TOOLS = "s/mcp_t_lokal";
    await manager.init();

    setToolApprovalHandler(async () => false);
    const offered = manager.getOpenAITools().filter((t) => t.function.name === "mcp_t_lokal");
    expect(offered.map((t) => t.function.description)).toEqual(["lokal geschützt"]);
    expect(manager.getAnthropicTools().filter((t) => t.name === "mcp_t_lokal").length).toBe(1);
    expect((await manager.callTool("mcp_t_lokal", {})).isError).toBe(true);
    expect(local).toBe(0);

    setToolApprovalHandler(async () => true);
    expect(await manager.callTool("mcp_t_lokal", {})).toEqual({ content: "lokal", isError: false });
    expect(local).toBe(1);
    expect(transports.s[0].calls.length).toBe(0);
    await manager.shutdown();
  });
});

describe("Abbruch", () => {
  test("nach /stop kein Aufruf mehr, AbortError", async () => {
    const { manager, transports } = setup({ s: { tools: [{ name: "mcp_t_stop" }] } });
    process.env.MCP_READ_ONLY_TOOLS = "s/mcp_t_stop";
    await manager.init();
    const error = await runExecution("mcp-test-stop", "general", async () => {
      abortExecutions("mcp-test-stop");
      return manager.callTool("mcp_t_stop", {});
    }).then(() => null, (err) => err);
    expect(isAbortError(error)).toBe(true);
    expect(transports.s[0].calls.length).toBe(0);
    await manager.shutdown();
  });

  test("/stop während des Aufrufs bricht die Anfrage ab und meldet es dem Server", async () => {
    const { manager, transports } = setup({ s: { tools: [{ name: "mcp_t_lang" }], hang: "tools/call" } });
    process.env.MCP_READ_ONLY_TOOLS = "s/mcp_t_lang";
    await manager.init();
    const pending = runExecution("mcp-test-lang", "general", () => manager.callTool("mcp_t_lang", {}));
    while (transports.s[0].calls.length === 0) await new Promise((r) => setTimeout(r, 1));
    abortExecutions("mcp-test-lang");
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.failure).toBe("aborted");
    expect(transports.s[0].cancelled.length).toBe(1);
    await manager.shutdown();
  });
});

describe("Shutdown", () => {
  test("schließt alle Verbindungen abwartbar, danach neu startbar", async () => {
    const { manager, transports } = setup({ a: { tools: [{ name: "mcp_t_sa" }] }, b: { tools: [{ name: "mcp_t_sb" }] } });
    await manager.init();
    await manager.shutdown();
    expect(transports.a[0].closeCount).toBe(1);
    expect(transports.b[0].closeCount).toBe(1);
    expect(manager.isReady).toBe(false);
    expect(manager.getStatus()).toBe("not initialized");
    expect(manager.hasTool("mcp_t_sa")).toBe(false);
    expect(manager.toolCount).toBe(builtinCount());

    await manager.init();
    expect(transports.a.length).toBe(2);
    expect(manager.hasTool("mcp_t_sa")).toBe(true);
    await manager.shutdown();
    await manager.shutdown();
    expect(transports.a[1].closeCount).toBe(1);
  });

  test("Shutdown während des Starts schließt auch halb verbundene Server, nichts bleibt hängen", async () => {
    const { manager, transports } = setup({ haengt: { hang: "initialize" }, gut: { tools: [{ name: "mcp_t_sg" }] } }, undefined, 60_000);
    const starting = manager.init();
    await new Promise((r) => setTimeout(r, 5));
    const started = Date.now();
    await manager.shutdown();
    await starting;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(transports.haengt[0].closeCount).toBeGreaterThan(0);
    expect(transports.gut[0].closeCount).toBeGreaterThan(0);
    expect(manager.isReady).toBe(false);
    expect(manager.hasTool("mcp_t_sg")).toBe(false);
  });

  test("Server, der nach dem Shutdown fertig wird, wird nicht übernommen und geschlossen", async () => {
    const { manager, transports } = setup({ a: { tools: [{ name: "mcp_t_spaet" }] } });
    const starting = manager.init();
    const closing = manager.shutdown();
    await Promise.all([starting, closing]);
    expect(manager.isReady).toBe(false);
    expect(manager.hasTool("mcp_t_spaet")).toBe(false);
    for (const t of transports.a ?? []) expect(t.closeCount).toBeGreaterThan(0);
  });

  test("initialize-Fehler: das close() des SDK wird abgewartet, auch von shutdown()", async () => {
    const { manager, transports } = setup({ abgelehnt: { initError: "nein", closeDelayMs: 40 } });
    const starting = manager.init();
    while (!transports.abgelehnt?.[0]?.closeCount) await new Promise((r) => setTimeout(r, 1));
    await manager.shutdown();
    expect(transports.abgelehnt[0].closed).toBe(true);
    await starting;
  });

  test("Start mit initialize-Fehler endet erst, wenn der Transport zu ist", async () => {
    const { manager, transports } = setup({ abgelehnt: { initError: "nein", closeDelayMs: 40 } });
    await manager.init();
    expect(transports.abgelehnt[0].closed).toBe(true);
    await manager.shutdown();
  });

  test("zwei gleichzeitige shutdown(): beide warten, bis der Transport zu ist", async () => {
    const { manager, transports } = setup({ langsam: { tools: [{ name: "mcp_t_langsam" }], closeDelayMs: 40 } });
    await manager.init();
    const first = manager.shutdown();
    await manager.shutdown();
    expect(transports.langsam[0].closed).toBe(true);
    await first;
  });

  test("Shutdown während des Starts wartet auf verzögertes close halb verbundener Server", async () => {
    const { manager, transports } = setup({ haengt: { hang: "initialize", closeDelayMs: 40 } }, undefined, 60_000);
    const starting = manager.init();
    while (!transports.haengt?.[0]) await new Promise((r) => setTimeout(r, 1));
    await Promise.all([manager.shutdown(), manager.shutdown()]);
    expect(transports.haengt[0].closed).toBe(true);
    await starting;
  });

  test("alter Pfad src/lib/mcp-client.ts liefert denselben Manager", () => {
    expect(legacyManager).toBeInstanceOf(LegacyClass);
    expect(LegacyClass).toBe(McpManager);
  });
});
