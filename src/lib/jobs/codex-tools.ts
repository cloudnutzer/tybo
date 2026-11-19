/**
 * Werkzeuggrenze eingeschränkter Codex-Jobs, geprüft mit CLI 0.169.0.
 * Die Shell-Sandbox begrenzt weder Apps noch native Netzwerkwerkzeuge.
 * Sie brauchen eigene Abschaltungen, ebenso Hooks und der Code-Modus-Host.
 */
export const CODEX_JOB_DISABLED_FEATURES = [
  // unified_exec bleibt in 0.169.0 intern true; shell_tool=false entfernt
  // die Shell-Werkzeuge trotzdem und weist auch erfundene Aufrufe zurück.
  "shell_tool", "unified_exec", "code_mode_host", "code_mode_only",
  "apps", "plugins", "remote_plugin", "skill_mcp_dependency_install", "tool_suggest",
  "browser_use", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser", "computer_use",
  "image_generation", "view_image",
  "multi_agent", "multi_agent_v2", "agent_message_board", "agent_message_board_mcp",
  "hooks", "shell_snapshot", "goals", "sleep_tool",
] as const;

/** Auch für die MCP-Vorprüfung, damit diese dieselbe Konfiguration sieht. */
export const CODEX_JOB_TOOL_ARGS = [
  ...CODEX_JOB_DISABLED_FEATURES.flatMap(feature => ["--disable", feature]),
  "-c", 'web_search="disabled"',
  "-c", "agents.enabled=false",
  "-c", "notify=[]",
  "-c", "tools.experimental_request_user_input.enabled=false",
  "-c", "tools.update_plan.enabled=false",
  // 0.169.0 bietet exec/wait trotz enabled=false an. Ohne Host scheitern
  // Aufrufe mit einem Fehler. apply_patch muss deshalb direkt angeboten werden.
  "-c", "features.code_mode.enabled=false",
  "-c", 'features.code_mode.direct_only_tool_namespaces=["functions"]',
  "-c", 'features.code_mode.excluded_tool_namespaces=["clock"]',
] as const;

/**
 * Eine leere Tabelle (mcp_servers={}) löscht geerbte Server NICHT.
 * Jeder Name aus `config/read` bekommt daher enabled=false.
 * Namen gehören in den TOML-Wert: Der -c-Schlüsselpfad versteht weder
 * quotierte Namen noch Punkte innerhalb eines Namens. JSON-Strings sind
 * hier TOML-Strings in argv, keine Shell-Befehle.
 */
export function codexMcpDisableArgs(names: readonly string[]): string[] {
  if (!names.length) return [];
  const entries = [...new Set(names)].map(name => `${JSON.stringify(name)}={enabled=false}`);
  return ["-c", `mcp_servers={${entries.join(",")}}`];
}

/** Ungültige oder unvollständige CLI-Ausgabe darf nie als leere Liste gelten. */
export function parseCodexMcpNames(config: unknown): string[] {
  const servers = config && typeof config === "object" && "mcp_servers" in config ? config.mcp_servers : undefined;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)
    || Object.entries(servers).some(([name, server]) => !name || !server || typeof server !== "object" || Array.isArray(server))) {
    throw new Error("Codex-MCP-Konfiguration ist nicht prüfbar.");
  }
  return Object.keys(servers);
}

/**
 * Nur initialize und config/read, niemals thread/start oder turn/start.
 * `codex mcp list` wäre ungeeignet: Es kontaktiert HTTP-Server für OAuth.
 * config/read berücksichtigt auch Projekt-Konfigurationen, ohne Serverkontakt.
 * Die Antwort kann Zugangsdaten enthalten und darf nie ins Log gelangen.
 */
export async function readCodexMcpServers(o: { codexPath: string; root: string; env: Record<string, string>; args?: readonly string[]; signal?: AbortSignal }): Promise<string[]> {
  if (o.signal?.aborted) throw new Error("Codex-MCP-Konfiguration ist nicht prüfbar.");
  const proc = Bun.spawn({
    cmd: [o.codexPath, "app-server", "--listen", "stdio://", ...(o.args ?? CODEX_JOB_TOOL_ARGS)],
    cwd: o.root,
    env: o.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    detached: process.platform !== "win32",
  });
  const stop = () => {
    // Auch bei Abbruch darf kein Kindprozess des Lesers zurückbleiben.
    if (process.platform !== "win32") {
      try { process.kill(-proc.pid, "SIGKILL"); return; } catch { /* schon beendet */ }
    }
    try { proc.kill("SIGKILL"); } catch { /* schon beendet */ }
  };
  const timer = setTimeout(stop, 5_000);
  o.signal?.addEventListener("abort", stop, { once: true });
  if (o.signal?.aborted) stop();
  const send = async (message: object) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    await proc.stdin.flush();
  };
  try {
    await send({ id: 1, method: "initialize", params: { clientInfo: { name: "tybo_job_config", version: "1" } } });
    let initialized = false;
    let pending = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      bytes += chunk.byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error();
      pending += decoder.decode(chunk, { stream: true });
      for (let end; (end = pending.indexOf("\n")) >= 0;) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === 1) {
          if (initialized || !message.result || message.error) throw new Error();
          initialized = true;
          await send({ method: "initialized", params: {} });
          await send({ id: 2, method: "config/read", params: { cwd: o.root, includeLayers: false } });
        } else if (message.id === 2) {
          if (!initialized || message.error) throw new Error();
          return parseCodexMcpNames(message.result?.config);
        }
      }
    }
    throw new Error();
  } catch {
    throw new Error("Codex-MCP-Konfiguration ist nicht prüfbar; eingeschränkter Job wird nicht gestartet.");
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", stop);
    try { proc.stdin.end(); } catch { /* Prozess kann bereits beendet sein. */ }
    stop();
    await proc.exited;
  }
}
