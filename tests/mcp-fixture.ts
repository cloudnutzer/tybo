/**
 * Attrappe eines MCP-Servers als Transport (Issue #332): beantwortet
 * initialize, tools/list und tools/call im Speicher, ohne Prozess und Netz.
 * Einzelne Methoden lassen sich anhalten, um Zeitlimit, Shutdown während
 * des Starts und Abbruch zu prüfen.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ServerSpec } from "../src/lib/mcp/config";

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface FakeServer {
  tools?: FakeTool[];
  /** Diese Methode bekommt nie eine Antwort */
  hang?: "initialize" | "tools/list" | "tools/call";
  /** start() des Transports wirft */
  failStart?: string;
  /** Antwort auf tools/call; Standard: Textblock "ok:<name>" */
  answer?: (name: string, args: Record<string, unknown>) => { content: unknown[]; isError?: boolean };
  /** tools/call antwortet mit diesem JSON-RPC-Fehler */
  callError?: string;
  /** Code des Fehlers aus callError; Standard -32000 */
  callErrorCode?: number;
  /** Bei tools/call bricht die Verbindung ab, ohne Antwort */
  dropOnCall?: boolean;
  /** initialize antwortet mit diesem JSON-RPC-Fehler; das SDK schließt dann selbst */
  initError?: string;
  /**
   * close() braucht so lange; wie beim stdio-Transport kehrt ein weiterer
   * Aufruf währenddessen sofort zurück
   */
  closeDelayMs?: number;
}

export class FakeTransport implements Transport {
  onmessage?: (message: any) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  closeCount = 0;
  /** close() ist vollständig durchgelaufen */
  closed = false;
  clientName = "";
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly cancelled: unknown[] = [];

  constructor(private readonly server: FakeServer) {}

  async start(): Promise<void> {
    if (this.server.failStart) throw new Error(this.server.failStart);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const msg = message as any;
    if (msg.method === "notifications/cancelled") this.cancelled.push(msg.params?.requestId);
    if (typeof msg.method !== "string" || msg.id === undefined) return;
    if (msg.method === "tools/call") this.calls.push({ name: msg.params.name, args: msg.params.arguments ?? {} });
    if (this.server.hang === msg.method) return;
    if (msg.method === "tools/call" && this.server.dropOnCall) {
      queueMicrotask(() => this.onclose?.());
      return;
    }

    let reply: Record<string, unknown>;
    if (msg.method === "initialize" && this.server.initError) {
      reply = { error: { code: -32000, message: this.server.initError } };
    } else if (msg.method === "initialize") {
      this.clientName = msg.params.clientInfo?.name ?? "";
      reply = { result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "attrappe", version: "1" } } };
    } else if (msg.method === "tools/list") {
      reply = { result: { tools: (this.server.tools ?? []).map((t) => ({ inputSchema: { type: "object" }, ...t })) } };
    } else if (msg.method === "tools/call") {
      reply = this.server.callError
        ? { error: { code: this.server.callErrorCode ?? -32000, message: this.server.callError } }
        : { result: this.server.answer?.(msg.params.name, msg.params.arguments ?? {}) ?? { content: [{ type: "text", text: `ok:${msg.params.name}` }] } };
    } else {
      reply = { error: { code: -32601, message: "unbekannt" } };
    }
    queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id: msg.id, ...reply }));
  }

  async close(): Promise<void> {
    this.closeCount++;
    if (this.closeCount > 1) return;
    if (this.server.closeDelayMs) await new Promise((r) => setTimeout(r, this.server.closeDelayMs));
    this.closed = true;
    this.onclose?.();
  }
}

/**
 * Transport-Fabrik über benannte Attrappen; ordnet über die URL bzw. den
 * Befehl zu (http://<name> oder Befehl <name>) und merkt sich jede Beschreibung.
 */
export function fakeFactory(servers: Record<string, FakeServer>) {
  const transports: Record<string, FakeTransport[]> = {};
  const specs: ServerSpec[] = [];
  const factory = (spec: ServerSpec) => {
    specs.push(spec);
    const key = spec.kind === "http" ? new URL(spec.url).hostname : spec.command;
    const transport = new FakeTransport(servers[key] ?? {});
    (transports[key] ??= []).push(transport);
    return transport;
  };
  return { factory, transports, specs };
}

/** Beschreibungen in der angegebenen Reihenfolge, je Name ein lokaler Server mit Befehl <name> */
export function localSpecs(...names: string[]): () => Map<string, ServerSpec> {
  return () => new Map(names.map((name) => [name, { kind: "stdio", command: name, args: [], env: {} } as ServerSpec]));
}
