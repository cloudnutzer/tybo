/**
 * Werkzeuge für Fallback-Modelle (Issue #332): verbindet die MCP-Server aus
 * config.ts, sammelt ihre Werkzeuge und bietet sie zusammen mit den
 * Built-ins (src/lib/tools/) im Anthropic- und im OpenAI-Format an.
 *
 * Regeln:
 * - Lokale Built-ins gehen vor: Meldet ein Server ein Werkzeug mit dem Namen
 *   eines Built-ins, wird es nicht angeboten, und ein Aufruf läuft über das
 *   Built-in mit dessen Freigaberegel. Ein entfernter Server kann so keine
 *   lokale Freigabe umgehen.
 * - Jeder Aufruf eines MCP-Werkzeugs braucht die Freigabe des Nutzers
 *   (authorizeTool), außer es steht als "server/werkzeug" in
 *   MCP_READ_ONLY_TOOLS.
 * - Melden zwei Server dasselbe Werkzeug, gilt der in der Konfiguration
 *   frühere.
 * - Keine eigenen Prozess-Handler: Wer den Manager startet, ruft beim Beenden
 *   shutdown() auf und wartet darauf (bot.ts in shutdown()).
 *
 * Verbindungen entstehen über eine Transport-Fabrik; Tests geben eine
 * Attrappe herein und kommen ohne Prozesse und Netz aus.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type Anthropic from "@anthropic-ai/sdk";
import { checkAborted, currentExecution } from "../execution-context";
import {
  authorizeTool,
  callBuiltinTool,
  getAvailableBuiltinTools,
  getBuiltinTool,
  type BuiltinTool,
} from "../tools";
import { loadServerSpecs, resolveSpec, type ServerSpec, type ServerSpecs } from "./config";

/** Name, unter dem sich tybo bei einem MCP-Server meldet */
export function mcpClientName(server: string): string {
  return `tybo-${server}`;
}

/** Werkzeug im OpenAI-Format (function calling) */
export type OpenAITool = { type: "function"; function: { name: string; description: string; parameters: Record<string, any> } };

export interface ToolCallResult {
  content: string;
  isError: boolean;
  /**
   * Nur bei MCP-Werkzeugen, wenn der Server das Ergebnis nicht geliefert hat:
   * Freigabe verweigert, Server nicht verbunden, Zeitlimit, Abbruch (/stop)
   * oder anderer Fehler auf dem Weg. Fehlt es bei isError, meldet der Server selbst den Fehler:
   * als Werkzeugfehler im Ergebnis oder als JSON-RPC-Fehlerantwort (etwa -32602).
   */
  failure?: "denied" | "not_connected" | "timeout" | "aborted" | "error";
}

/** Baut zu einer aufgelösten Beschreibung den passenden Transport */
export type TransportFactory = (spec: ServerSpec) => Transport;

/** Echte Transporte: Kindprozess über stdio oder Streamable HTTP */
export const realTransportFactory: TransportFactory = (spec) => {
  if (spec.kind === "http") {
    return new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers } });
  }
  return new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...(process.env as Record<string, string>), ...spec.env },
  });
};

export interface McpManagerOptions {
  /** Liefert die Server; Standard: loadServerSpecs() */
  specs?: () => ServerSpecs;
  /** Löst Platzhalter auf; Standard: Credential Registry */
  resolve?: (spec: ServerSpec) => ServerSpec;
  transports?: TransportFactory;
  /** Höchstdauer für Verbinden und Werkzeugliste je Server */
  startTimeoutMs?: number;
  /** Höchstdauer eines Werkzeugaufrufs */
  callTimeoutMs?: number;
}

/** Gemeinsame Form für beide Ausgabeformate */
type OfferedTool = { name: string; description: string; inputSchema: Record<string, any> };

/** Werkzeug eines MCP-Servers */
type RemoteTool = OfferedTool & { server: string };

interface Connection {
  client: Client;
  toolCount: number;
  replies: ServerErrorLog;
}

/** Client im Aufbau; der Transport entsteht erst nach dem Auflösen */
interface Connecting {
  client: Client;
  transport?: Transport;
}

/**
 * Merkt sich die JSON-RPC-Fehlerantworten, die vom Server ankommen. Das SDK
 * wirft für sie denselben McpError wie für lokale Fehler (Zeitlimit,
 * Verbindung zu); nur ein hier vermerkter Fehler belegt, dass der Server
 * geantwortet hat.
 */
class ServerErrorLog {
  private static readonly LIMIT = 50;
  private readonly seen: string[] = [];

  /** Hängt sich nach client.connect() vor die Nachrichten des Transports */
  watch(transport: Transport): void {
    const onmessage = transport.onmessage;
    transport.onmessage = (message, extra) => {
      const error = (message as { id?: unknown; error?: { code: number; message: string } }).error;
      if (error && "id" in message) {
        this.seen.push(new McpError(error.code, error.message).message);
        if (this.seen.length > ServerErrorLog.LIMIT) this.seen.shift();
      }
      onmessage?.(message, extra);
    };
  }

  /** War err eine Fehlerantwort des Servers? Verbraucht den Eintrag. */
  take(err: unknown): boolean {
    if (!(err instanceof McpError)) return false;
    const index = this.seen.indexOf(err.message);
    if (index < 0) return false;
    this.seen.splice(index, 1);
    return true;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorResult(message: string): ToolCallResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

/** Inhaltsblöcke eines Ergebnisses als ein Text */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) return "OK";
  return content
    .map((block: any) => (typeof block?.text === "string" && block.text ? block.text : JSON.stringify(block)))
    .join("\n");
}

function readOnlyList(): Set<string> {
  return new Set((process.env.MCP_READ_ONLY_TOOLS || "").split(",").map((s) => s.trim()).filter(Boolean));
}

export class McpManager {
  private readonly specs: () => ServerSpecs;
  private readonly resolve: (spec: ServerSpec) => ServerSpec;
  private readonly transports: TransportFactory;
  private readonly startTimeoutMs: number;
  private readonly callTimeoutMs: number;

  private connections = new Map<string, Connection>();
  /** Werkzeugname zu Werkzeug, in Konfigurationsreihenfolge */
  private remote = new Map<string, RemoteTool>();
  /** Clients, die gerade verbinden; shutdown() schließt sie sofort */
  private connecting = new Set<Connecting>();
  /** Laufende Schließvorgänge aller Transporte, auch die vom SDK selbst gestarteten */
  private closing = new Set<Promise<void>>();
  private starting: Promise<void> | null = null;
  /** Laufender shutdown(); ein weiterer Aufruf wartet mit darauf */
  private stopping: Promise<void> | null = null;
  private ready = false;
  /** Zählt Starts und Shutdowns; ein überholter Start übernimmt nichts */
  private generation = 0;

  constructor(options: McpManagerOptions = {}) {
    this.specs = options.specs ?? (() => loadServerSpecs());
    this.resolve = options.resolve ?? ((spec) => resolveSpec(spec));
    this.transports = options.transports ?? realTransportFactory;
    this.startTimeoutMs = options.startTimeoutMs ?? 10_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 60_000;
  }

  /**
   * Verbindet alle Server. Mehrfache und gleichzeitige Aufrufe teilen sich
   * einen Start; nach shutdown() startet init() neu. Wirft nie wegen eines
   * einzelnen Servers.
   */
  init(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (!this.starting) {
      const generation = ++this.generation;
      this.starting = this.start(generation).finally(() => {
        if (this.generation === generation) this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(generation: number): Promise<void> {
    const specs = [...this.specs()];
    if (specs.length === 0) console.log("[MCP] Keine Server eingerichtet");
    else console.log(`[MCP] Verbinde ${specs.length} Server ...`);

    const outcomes = await Promise.allSettled(specs.map(([name, spec]) => this.connect(name, spec)));
    if (generation !== this.generation) {
      // shutdown() kam dazwischen: was doch noch verbunden hat, wieder schließen
      await Promise.all(outcomes.map((o) => (o.status === "fulfilled" ? o.value.client.close().catch(() => {}) : undefined)));
      return;
    }

    outcomes.forEach((outcome, index) => {
      const name = specs[index][0];
      if (outcome.status === "rejected") {
        console.error(`[MCP] ❌ ${name}: ${errorText(outcome.reason)}`);
        return;
      }
      const { client, tools, replies } = outcome.value;
      let taken = 0;
      for (const tool of tools) {
        if (this.remote.has(tool.name)) {
          console.warn(`[MCP] ${name}: Werkzeug ${tool.name} gibt es schon, übersprungen`);
          continue;
        }
        this.remote.set(tool.name, tool);
        taken++;
      }
      this.connections.set(name, { client, toolCount: taken, replies });
      console.log(`[MCP] ✅ ${name}: ${taken} Werkzeuge`);
    });
    if (specs.length > 0) {
      console.log(`[MCP] ${this.connections.size}/${specs.length} Server verbunden, ${this.remote.size} Werkzeuge`);
    }
    this.ready = true;
    this.logBuiltins();
  }

  /** Ein Server: verbinden, Werkzeuge holen, alles in startTimeoutMs */
  private async connect(name: string, spec: ServerSpec): Promise<{ client: Client; tools: RemoteTool[]; replies: ServerErrorLog }> {
    const client = new Client({ name: mcpClientName(name), version: "1.0.0" });
    const replies = new ServerErrorLog();
    const entry: Connecting = { client };
    this.connecting.add(entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`keine Antwort nach ${this.startTimeoutMs} ms`)), this.startTimeoutMs);
    });
    try {
      const listed = await Promise.race([
        (async () => {
          entry.transport = this.track(this.transports(this.resolve(spec)));
          await client.connect(entry.transport);
          replies.watch(entry.transport);
          return client.listTools();
        })(),
        deadline,
      ]);
      const tools = listed.tools.map((t) => ({
        server: name,
        name: t.name,
        description: t.description || "",
        inputSchema: (t.inputSchema ?? {}) as Record<string, any>,
      }));
      return { client, tools, replies };
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
      this.connecting.delete(entry);
    }
  }

  /**
   * Macht close() des Transports einmalig und verfolgbar: Jeder Aufruf, auch
   * das nicht abgewartete close() des SDK nach einem initialize-Fehler,
   * bekommt denselben Vorgang, und shutdown() wartet auf alle. Ein zweiter
   * close() beim stdio-Transport wartet sonst nicht auf den ersten.
   */
  private track(transport: Transport): Transport {
    const close = transport.close.bind(transport);
    let pending: Promise<void> | undefined;
    transport.close = () => {
      if (!pending) {
        const run: Promise<void> = close()
          .catch(() => {})
          .finally(() => this.closing.delete(run));
        pending = run;
        this.closing.add(run);
      }
      return pending;
    };
    return transport;
  }

  private logBuiltins(): void {
    const available = getAvailableBuiltinTools();
    const overridden = available.filter((t) => this.remote.has(t.name)).map((t) => t.name);
    if (overridden.length > 0) {
      console.log(`[MCP] Gleichnamige Server-Werkzeuge verdeckt, das Built-in gilt: ${overridden.join(", ")}`);
    }
    if (available.length > 0) {
      console.log(`[MCP] ✅ ${available.length} Built-in-Werkzeuge: ${available.map((t) => t.name).join(", ")}`);
    }
  }

  /** Server-Werkzeuge, die kein Built-in verdeckt */
  private offeredRemote(): RemoteTool[] {
    return [...this.remote.values()].filter((t) => !getBuiltinTool(t.name));
  }

  private offered(): OfferedTool[] {
    const builtins: BuiltinTool[] = getAvailableBuiltinTools();
    return [...this.offeredRemote(), ...builtins];
  }

  /**
   * Führt ein Werkzeug aus. Fehler kommen als Ergebnis mit isError zurück;
   * ein Abbruch (/stop) vor dem Aufruf wirft, während des Aufrufs bricht
   * das Signal der Ausführung die Anfrage ab.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    checkAborted();
    const tool = this.remote.get(name);
    if (getBuiltinTool(name) || !tool) return callBuiltinTool(name, args);

    const connection = this.connections.get(tool.server);
    if (!connection) return { ...errorResult(`Server ${tool.server} not connected`), failure: "not_connected" };

    const gate: BuiltinTool = {
      name,
      description: `MCP ${tool.server}: ${tool.description || name}`,
      inputSchema: { type: "object", properties: {} },
      requiresApproval: !readOnlyList().has(`${tool.server}/${name}`),
      isAvailable: () => true,
      handler: async () => "",
    };
    const denied = await authorizeTool(gate, args);
    if (denied) return { ...denied, failure: "denied" };
    checkAborted();

    console.log(`[MCP] Aufruf ${tool.server}/${name}`);
    try {
      const result = await connection.client.callTool({ name, arguments: args }, undefined, {
        signal: currentExecution()?.controller.signal,
        timeout: this.callTimeoutMs,
      });
      return { content: flattenContent(result.content), isError: result.isError === true };
    } catch (err) {
      console.error(`[MCP] ${tool.server}/${name} fehlgeschlagen: ${errorText(err)}`);
      // Ein Abbruch kommt vom SDK mit demselben Code wie ein Zeitlimit
      const aborted = currentExecution()?.controller.signal.aborted === true;
      // Fehlerantwort des Servers (etwa ungültige Argumente): der Server hat geantwortet
      if (!aborted && connection.replies.take(err)) return errorResult(errorText(err));
      const timeout = !aborted && err instanceof McpError && err.code === ErrorCode.RequestTimeout;
      return { ...errorResult(errorText(err)), failure: aborted ? "aborted" : timeout ? "timeout" : "error" };
    }
  }

  /** Alle angebotenen Werkzeuge im Anthropic-Format */
  getAnthropicTools(): Anthropic.Tool[] {
    return this.offered().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: "object" as const, ...t.inputSchema },
    }));
  }

  /** Alle angebotenen Werkzeuge im OpenAI-Format */
  getOpenAITools(): OpenAITool[] {
    return this.offered().map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: { type: "object", ...t.inputSchema } },
    }));
  }

  /** Server eines angebotenen MCP-Werkzeugs; undefined bei Built-ins und Unbekanntem */
  serverOf(name: string): string | undefined {
    return getBuiltinTool(name) ? undefined : this.remote.get(name)?.server;
  }

  /** Kennt der Manager das Werkzeug (Server oder verfügbares Built-in)? */
  hasTool(name: string): boolean {
    return this.remote.has(name) || getAvailableBuiltinTools().some((t) => t.name === name);
  }

  /** Zahl der angebotenen Werkzeuge, wie in getOpenAITools() */
  get toolCount(): number {
    return this.offered().length;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Kurzer Stand für Startausgabe und Diagnose */
  getStatus(): string {
    if (!this.ready) return "not initialized";
    const builtins = getAvailableBuiltinTools().length;
    if (this.connections.size === 0) return builtins > 0 ? `no servers, ${builtins} built-in tools` : "no servers";
    const list = [...this.connections].map(([name, c]) => `${name}(${c.toolCount})`).join(", ");
    return `${this.connections.size} servers, ${this.remote.size} MCP tools + ${builtins} built-ins: ${list}`;
  }

  /**
   * Schließt alle Verbindungen (lokale Server enden mit ihrem Transport) und
   * wartet darauf; ein laufender Start wird abgebrochen. Wirft nie.
   */
  shutdown(): Promise<void> {
    this.generation++;
    const pending = this.starting;
    this.starting = null;
    const open = [...this.connections.values()].map((c) => c.client);
    const half = [...this.connecting];
    this.connections.clear();
    this.remote.clear();
    this.ready = false;
    if (open.length > 0) console.log(`[MCP] Schließe ${open.length} Server`);
    const closed = Promise.all([
      ...open.map((client) => client.close().catch(() => {})),
      ...half.map((c) => Promise.all([c.client.close().catch(() => {}), c.transport?.close().catch(() => {})])),
    ]);

    const previous = this.stopping;
    const run: Promise<void> = (async () => {
      await closed;
      await pending?.catch(() => {});
      await previous;
      // Auch Schließvorgänge, die der abgebrochene Start oder das SDK angestoßen hat
      while (this.closing.size > 0) await Promise.all([...this.closing]);
    })().finally(() => {
      if (this.stopping === run) this.stopping = null;
    });
    this.stopping = run;
    return run;
  }
}

/** Der Manager des Prozesses */
export const mcpManager = new McpManager();
