import { checkAborted, currentExecution } from "../execution-context";
/**
 * Built-in Tool Registry (Tool-Gateway Phase 2)
 *
 * tybo-eigene Tools fuer REST-Dienste: laufen in-process in Bun, holen
 * Keys ueber die Credential Registry, keine Subprozesse, keine Zombies.
 * Der MCPManager merged sie in getOpenAITools()/getAnthropicTools() und
 * routet callTool() hierher, wenn kein MCP-Server das Tool kennt.
 *
 * Bei Namenskollisionen bleibt das Built-in mit seiner lokalen Policy maßgeblich.
 *
 * requiresApproval: schreibende/destruktive Tools werden erst nach
 * HITL-Bestaetigung ausgefuehrt (Phase 3). Bis das Gate existiert,
 * werden solche Tools gar nicht erst angeboten.
 */

export interface BuiltinToolResult {
  content: string;
  isError: boolean;
}

export interface BuiltinTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Schreibend/destruktiv: braucht HITL-Bestaetigung (Phase 3). */
  requiresApproval?: boolean;
  /** false = Tool wird nicht angeboten (z.B. Key fehlt). */
  isAvailable: () => boolean;
  handler: (args: Record<string, any>) => Promise<string>;
}

const tools = new Map<string, BuiltinTool>();


// ---------------------------------------------------------------------------
// HITL-Gate (PRD Phase 3): schreibende Tools laufen erst nach Bestaetigung.
// Ein Handler fuer alle Kanaele: bot.ts registriert die Freigabe ueber das
// Rueckfragen-Register (src/lib/tool-approval.ts, Issue #116), die Frage
// erscheint im Gespraech des Turns (Telegram, Browser, Terminal). Der
// VPS-Gateway nutzt weiter installTelegramToolApproval. Ohne Handler bleiben
// requiresApproval-Tools wie bisher verborgen.
// ---------------------------------------------------------------------------

export type ToolApprovalHandler = (
  tool: BuiltinTool,
  args: Record<string, unknown>
) => Promise<boolean>;

let approvalHandler: ToolApprovalHandler | null = null;

export function setToolApprovalHandler(fn: ToolApprovalHandler | null): void {
  approvalHandler = fn;
}

function approvalHandlerForExecution(): ToolApprovalHandler | null {
  return approvalHandler;
}

/** Argumente fuer die Freigabe-Frage: Geheimnisse geschwaerzt, gekuerzt. */
export function toolApprovalPreview(args: Record<string, unknown>): string {
  return JSON.stringify(args, (key, value) => /secret|token|password|authorization|api.?key/i.test(key) ? "[redacted]" : value).slice(0, 800);
}

/** Registriere ein Built-in-Tool. Doppelte Namen werden abgelehnt. */
export function registerBuiltinTool(tool: BuiltinTool): void {
  if (tools.has(tool.name)) {
    console.warn(`[BuiltinTools] Doppelte Registrierung ignoriert: ${tool.name}`);
    return;
  }
  tools.set(tool.name, tool);
}

/**
 * Alle Tools, die jetzt angeboten werden duerfen: Credentials vorhanden,
 * und requiresApproval-Tools nur wenn das Gate offen ist ODER ein
 * HITL-Approval-Handler registriert ist (Phase 3: der Call wartet dann
 * auf die Inline-Button-Bestaetigung des Users).
 */
export function getAvailableBuiltinTools(): BuiltinTool[] {
  return Array.from(tools.values()).filter((t) => {
    if (t.requiresApproval && !approvalHandlerForExecution())
      return false;
    try {
      return t.isAvailable();
    } catch {
      return false;
    }
  });
}

/** Alle registrierten Tools, unabhaengig von Verfuegbarkeit (Diagnose). */
export function getAllBuiltinTools(): BuiltinTool[] {
  return Array.from(tools.values());
}

export function getBuiltinTool(name: string): BuiltinTool | undefined {
  return tools.get(name);
}

/**
 * Fuehre ein Built-in-Tool aus. Fehler werden als Tool-Result gemeldet,
 * nie geworfen (N2: fail-open, Text-Antwort darf nicht scheitern).
 */
export async function callBuiltinTool(
  name: string,
  args: Record<string, unknown>
): Promise<BuiltinToolResult> {
  const tool = tools.get(name);
  if (!tool) {
    return {
      content: JSON.stringify({ error: `Unknown built-in tool: ${name}` }),
      isError: true,
    };
  }
  if (!tool.isAvailable()) {
    return {
      content: JSON.stringify({
        error: `Tool ${name} nicht verfuegbar (Credential fehlt?)`,
      }),
      isError: true,
    };
  }
  const denied = await authorizeTool(tool, args);
  if (denied) return denied;
  try {
    console.log(
      `[BuiltinTools] ${name}`
    );
    const content = await tool.handler(args as Record<string, any>);
    return { content, isError: false };
  } catch (err: any) {
    console.error(`[BuiltinTools] ${name} error:`, err.message);
    return {
      content: JSON.stringify({ error: err.message }),
      isError: true,
    };
  }
}

export async function authorizeTool(tool: BuiltinTool, args: Record<string, unknown>): Promise<BuiltinToolResult | null> {
  checkAborted();
  const allowed = currentExecution()?.allowedTools;
  if (allowed && !allowed.includes(tool.name)) return { content: "Tool is not allowed for this agent", isError: true };
  // HITL-Gate (Phase 3): schreibende Tools brauchen die Bestaetigung des
  // Users, ausser das Gate ist per FALLBACK_ALLOW_WRITE_TOOLS offen.
  if (tool.requiresApproval) {
    const approvalHandler = approvalHandlerForExecution();
    if (!approvalHandler) {
      return {
        content: JSON.stringify({
          error: `Tool ${tool.name} braucht User-Bestaetigung, aber es ist kein Approval-Handler aktiv.`,
        }),
        isError: true,
      };
    }
    let approved = false;
    try {
      approved = await approvalHandler(tool, args);
    } catch (err) {
      console.error(`[BuiltinTools] approval handler error for ${tool.name}:`, err);
    }
    if (!approved) {
      return {
        content: JSON.stringify({
          error: `Der User hat den Aufruf von ${tool.name} abgelehnt (oder nicht rechtzeitig bestaetigt). Nicht erneut versuchen — erklaere stattdessen, was du tun wolltest.`,
        }),
        isError: true,
      };
    }
  }
  checkAborted();
  return null;
}
