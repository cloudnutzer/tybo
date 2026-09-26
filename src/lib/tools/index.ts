/**
 * Built-in Tools — zentraler Einstieg (Tool-Gateway Phase 2).
 *
 * Jedes Tool-Modul registriert sich beim Import selbst in der Registry.
 * Der MCPManager importiert dieses Modul und merged die Built-ins in
 * seine Format-Adapter (getOpenAITools/getAnthropicTools/callTool).
 */

import "./firecrawl-rest";
import "./apify";
import "./telegram-document";
import "./elevenlabs-tts";
import "./cloudflare";
import "./history-search";

export {
  registerBuiltinTool,
  getAvailableBuiltinTools,
  getAllBuiltinTools,
  getBuiltinTool,
  callBuiltinTool,
  authorizeTool,
  setToolApprovalHandler,
  toolApprovalPreview,
  type BuiltinTool,
  type BuiltinToolResult,
  type ToolApprovalHandler,
} from "./registry";
