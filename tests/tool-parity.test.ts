/** M14-15: ausschließlich temporäre Quellen, keine Programme und kein Bot-Import. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { claudeNotesDir } from "../src/lib/engines/claude-notes";
import { currentCodexMcpPlan, safeMcpName, setCodexMcpInputsForTests, type CodexMcpPlan } from "../src/lib/engines/codex-mcp";
import { syncCodexSkillLinks } from "../src/lib/engines/codex-skills";
import { createToolParitySnapshot, MCP_GAP_REASONS, SKILL_GAP_REASONS, TOOL_GAP_IDS, TOOL_GAP_TEXT, TOOL_HINT_REASONS,
  safeSkillName, setToolParityReadersForTests, toolGaps, toolInventory, type ToolParityInput } from "../src/lib/engines/tool-parity";
import type { CodexMcpSettings, CodexSandbox } from "../src/lib/settings";
import { ENGINE_IDS } from "../src/lib/engines/types";
import { motorToolsText, toolSummary } from "../src/lib/engines/tool-display";
import { commandRegistry } from "../src/lib/commands/builtin";
import { createEngineCommandServices } from "../src/lib/engine-choice";
import type { CommandContext } from "../src/lib/commands/types";
import { engineToolFindings } from "../src/setup/checks/engine-tools";
import { createSetupContext } from "../src/setup/context";

let base: string, root: string, home: string, input: ToolParityInput, settings: CodexMcpSettings, sandbox: CodexSandbox;
let captured: CodexMcpPlan;
let reads: string[];
let logs: ReturnType<typeof spyOn>[];
const head = (name: string) => `---\nname: ${name}\ndescription: Erfundenes Beispiel.\n---\nInhalt bleibt privat.\n`;
const local = { command: "bun", args: ["run", "beispiel.ts"] };
const remote = { type: "http", url: "https://beispiel.invalid/mcp" };
const item = (name: string, origin: "engine" | "tybo" = "engine") => ({ name, origin });
function file(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}
function skill(name: string, where = home, content = head(name), folder = ".claude") {
  const path = join(where, folder, "skills", name);
  file(join(path, "SKILL.md"), content);
  return path;
}
function claude(user: Record<string, unknown> = {}, project: Record<string, unknown> = {}, extra = {}) {
  file(join(home, ".claude.json"), { mcpServers: user, projects: { [root]: { mcpServers: project, ...extra } } });
}
const gaps = () => toolGaps("codex", input);
const inventory = () => toolInventory("codex", input);
beforeEach(() => {
  base = resolve(mkdtempSync(join(tmpdir(), "tybo-parity-")));
  root = join(base, "projekt"); home = join(base, "heim");
  mkdirSync(root); mkdirSync(home);
  settings = {}; sandbox = "full"; reads = [];
  input = {
    skills: { root, home, codexHome: join(base, "codex-eigen"), enabled: true },
    opencodeConfig: join(base, "opencode-eigen"), extraFile: join(base, "extra.json"),
    claudeNotes: true, opencodeClaudeSkills: true,
    mcpInput: () => ({ cwd: root, sandbox, baseEnv: { HOME: home, BEISPIEL_KONFLIKT: "alt" } }),
  };
  setCodexMcpInputsForTests({ parentEnv: () => ({ HOME: home, CODEX_HOME: input.skills.codexHome, MCP_CONFIG_PATH: input.extraFile }),
    projectRoot: () => root, settings: () => settings, lookup: () => undefined, secrets: () => [] });
  setToolParityReadersForTests({
    text: path => {
      // Der Codex-Leser prüft auch Elternordner; dort niemals echte Dateien lesen.
      if (!path.startsWith(base + sep)) throw Object.assign(new Error("fehlt"), { code: "ENOENT" });
      reads.push(path);
      return readFileSync(path, "utf8");
    },
    plan: (options, readers) => { captured = currentCodexMcpPlan(options, readers); return captured; },
  });
  logs = [spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})];
});
afterEach(() => {
  setCodexMcpInputsForTests(null); setToolParityReadersForTests(null);
  logs.forEach(log => log.mockRestore());
  rmSync(base, { recursive: true, force: true });
});

test("Claude: drei unabhängige Quellen, Zustimmung und Abschaltung, trotz Namensvetter bei tybo", () => {
  claude({ benutzer: local, aus: local, gemeinsam: remote }, { projekt: local },
    { disabledMcpServers: ["aus"], enabledMcpjsonServers: ["geteilt", "widerrufen"], disabledMcpjsonServers: ["widerrufen"] });
  file(join(root, ".mcp.json"), { mcpServers: { geteilt: local, unbestaetigt: local, widerrufen: local } });
  file(join(root, "config", "mcp-servers.json"), { servers: { gemeinsam: remote, nurtybo: local } });
  file(join(root, ".claude", "settings.json"), { mcpServers: { einstellung: local } });
  skill("projekt-skill", root); skill("heim-skill");
  expect(toolInventory("claude", input)).toEqual({
    mcp: ["benutzer", "gemeinsam", "geteilt", "projekt"].map(n => item(n)),
    skills: [item("heim-skill"), item("projekt-skill")], notes: "none", state: "ok",
  });
  file(join(home, ".claude", "plugins", "installed_plugins.json"), { version: 2, plugins: { "paket@quelle": [{}] } });
  expect(toolGaps("claude", input)).toEqual({ mcp: [], hints: [], skills: [], notes: false, plugins: null, fixed: [] });
  file(join(home, ".claude.json"), "kaputt");
  expect(toolGaps("claude", input)).toEqual({ mcp: [], hints: [], skills: [], notes: false, plugins: null, fixed: [] });
});

test("Codex: mitgegebene und eigene Server, verlinkte, fremde und native Skills", () => {
  claude({ weiter: local });
  file(join(input.skills.codexHome!, "config.toml"), '[mcp_servers.eigen]\ncommand="bun"');
  skill("verlinkt"); skill("fremd");
  skill("fremd", root, head("anderer-kopf"), ".agents");
  skill("projekt-nativ", root, head("projekt-nativ"), ".codex");
  file(join(input.skills.codexHome!, "skills", "konfiguration", "SKILL.md"), head("konfiguration"));
  file(join(input.skills.codexHome!, "skills", ".system", "intern", "SKILL.md"), head("intern"));
  skill("heim-agents", home, head("heim-agents"), ".agents");
  skill("unabhaengig", root, head("unabhaengig"), ".agents");
  syncCodexSkillLinks(input.skills);
  expect(inventory()).toEqual({
    mcp: [item("eigen"), item("weiter", "tybo")],
    skills: [item("fremd"), item("heim-agents"), item("konfiguration"), item("projekt-nativ"), item("unabhaengig"), item("verlinkt", "tybo")],
    notes: "none", state: "ok",
  });
  expect(gaps().skills).toEqual([]);
});

test("Notizen: Claude selbst, Codex mitgegeben, leer oder abgeschaltet; Inhalte bleiben intern", () => {
  const path = join(claudeNotesDir(root, home), "MEMORY.md");
  expect(inventory().notes).toBe("none");
  file(path, "  \n"); expect(inventory().notes).toBe("none");
  file(path, "ERFUNDENE_NOTIZ_MARKIERUNG");
  expect(toolInventory("claude", input).notes).toBe("self");
  expect(inventory().notes).toBe("passed"); expect(gaps().notes).toBe(false);
  input.claudeNotes = false;
  expect(inventory().notes).toBe("off"); expect(gaps().notes).toBe(true);
  for (const engine of ["api", "opencode"] as const) {
    expect(toolInventory(engine, input).notes).toBe("off"); expect(toolGaps(engine, input).notes).toBe(true);
  }
  file(path, ""); expect(gaps().notes).toBe(false);
});

test("OpenCode: JSON und JSONC in Konfiguration und Projekt, abgeschaltete Server fehlen, beide Claude-Skillquellen", () => {
  claude({ gemeinsam: local, fehlt: local });
  file(join(input.opencodeConfig, "opencode.json"), '{ // Auch .json erlaubt Kommentare\n"mcp": {"gemeinsam": {"type": "local"}, "aus": {"enabled": false}, "ueberstimmt": {}}}');
  file(join(root, "opencode.jsonc"), '{ // Beispiel\n"mcp": {"projekt": {}, "ueberstimmt": {"enabled": false}, "mein server": {}}}');
  skill("projekt-skill", root); skill("heim-skill");
  expect(toolInventory("opencode", input)).toEqual({
    mcp: ["gemeinsam", "projekt", safeMcpName("mein server")].sort().map(n => item(n)),
    skills: [item("heim-skill"), item("projekt-skill")], notes: "off", state: "ok",
  });
  expect(toolGaps("opencode", input).mcp).toEqual([{ name: "fehlt", reason: "not_in_engine" }]);
  expect(toolGaps("opencode", input).skills).toEqual([]);
  input.opencodeClaudeSkills = false;
  expect(toolInventory("opencode", input).skills).toEqual([]);
  expect(toolGaps("opencode", input).skills).toEqual(["heim-skill", "projekt-skill"].map(name => ({ name, reason: "not_in_engine" })));
});

test("API: Server nach loadServerSpecs, keine Skills und eine feste Skill-Lücke", () => {
  claude({ bun: local, npx: { command: "npx" }, http: remote });
  file(join(root, "config", "mcp-servers.json"), { servers: { tybo: local, "mein server": local } });
  file(input.extraFile!, { mcpServers: { extra: local } });
  skill("beispiel");
  expect(toolInventory("api", input)).toEqual({ mcp: ["bun", "extra", "http", "tybo", safeMcpName("mein server")].sort().map(n => item(n, "tybo")), skills: [], notes: "off", state: "ok" });
  const result = toolGaps("api", input);
  expect(result.mcp).toEqual([{ name: "npx", reason: "not_in_engine" }]);
  expect(result.skills).toEqual([]); expect(result.hints).toEqual([]); expect(result.fixed).toContain("skills");
  expect(logs.every(log => log.mock.calls.length === 0)).toBe(true);
});

for (const mode of ["normal", "disabled", "sandbox", "codex_config_unreadable"] as const) test(`Lücken und Hinweise genau einmal; verborgene Claude-Einträge fehlen bei ${mode}`, () => {
  claude({ gemeinsam: remote, fehlt: remote, aus: local, eigen: local }, {}, { disabledMcpServers: ["aus"] });
  file(join(root, ".mcp.json"), { mcpServers: { unbestaetigt: local } });
  file(join(root, "config", "mcp-servers.json"), { servers: { gemeinsam: { ...remote, url: "https://beispiel.invalid/?api_key=erfunden" },
    nurtybo: { ...remote, url: "https://beispiel.invalid/?api_key=erfunden" } } });
  file(input.extraFile!, { servers: { nurextra: { ...remote, type: "sse" } } });
  file(join(root, ".claude", "settings.local.json"), { mcpServers: { einstellung: local } });
  file(join(input.skills.codexHome!, "config.toml"), '[mcp_servers.eigen]\ncommand="bun"');
  if (mode === "disabled") settings.enabled = false;
  if (mode === "sandbox") sandbox = "read-only";
  if (mode === "codex_config_unreadable") file(join(root, ".codex", "config.toml"), "kaputt = [");
  const result = gaps();
  expect(result.mcp).toEqual([
    { name: "fehlt", reason: mode === "normal" ? "auth_unknown" : mode },
    { name: "gemeinsam", reason: mode === "normal" ? "secret_in_url" : mode },
  ]);
  expect(result.hints).toEqual([
    { name: "einstellung", reason: mode === "normal" ? "unsupported_source" : mode },
    { name: "nurextra", reason: mode === "normal" ? "transport" : mode },
    { name: "nurtybo", reason: mode === "normal" ? "secret_in_url" : mode },
  ]);
  const visible = [...result.mcp, ...result.hints];
  for (const skip of captured.skipped) {
    const expected = ["aus", "unbestaetigt", "eigen"].includes(skip.name) ? 0 : 1;
    expect(visible.filter(item => item.name === skip.name)).toHaveLength(expected);
  }
  expect(inventory().mcp).toContainEqual(item("eigen"));
});

test("Alle serverbezogenen Plan-Gründe bleiben als Kennungen erhalten", () => {
  claude({ ausnahme: local, alt: { ...remote, type: "sse" }, kaputt: {}, befehl: { command: "bun", args: ["--token", "erfunden"] },
    adresse: { ...remote, url: "https://beispiel.invalid/?api_key=erfunden" },
    platzhalter: { ...local, env: { BEISPIEL_UNBEKANNT: "${UNBEKANNT}" } },
    geschuetzt: { ...local, env: { HOME: "/fremd" } }, konflikt: { ...local, env: { BEISPIEL_KONFLIKT: "neu" } },
    anmeldung: remote, "mein server": local });
  settings.skip = ["ausnahme"];
  const result = gaps();
  for (const [name, reason] of Object.entries({ ausnahme: "user_skip", alt: "transport", kaputt: "invalid_value", befehl: "secret_in_command",
    adresse: "secret_in_url", platzhalter: "placeholder_unresolved", geschuetzt: "reserved_env", konflikt: "env_conflict", anmeldung: "auth_unknown",
    [safeMcpName("mein server")]: "invalid_name" })) expect(result.mcp).toContainEqual({ name, reason });
  expect(result.mcp).toHaveLength(10);
  settings.skip = ["aus"];
  claude({ aus: local }, {}, { disabledMcpServers: ["aus"] });
  expect(gaps().mcp).toEqual([]); expect(gaps().hints).toEqual([]);
});

for (const source of ["claude", "tybo"] as const) test(`Ersatzname für ungültigen MCP-Namen aus ${source}`, () => {
  if (source === "claude") claude({ "mein server": local });
  else file(join(root, "config", "mcp-servers.json"), { servers: { "mein server": local } });
  const result = gaps();
  const list = source === "claude" ? "mcp" : "hints";
  expect(result[list]).toEqual([{ name: safeMcpName("mein server"), reason: "invalid_name" }]);
  expect(result[list === "mcp" ? "hints" : "mcp"]).toEqual([]);
  if (source === "claude") expect(toolInventory("claude", input).mcp).toEqual([item(safeMcpName("mein server"))]);
  expect(JSON.stringify([result, toolInventory("claude", input), inventory()])).not.toContain("mein server");
});

test("Skill-Gründe: gelöschter Link, Abschaltung, Kopf, Ersatzname und Kopf-Kollision", () => {
  skill("verloren"); syncCodexSkillLinks(input.skills);
  unlinkSync(join(root, ".agents", "skills", "verloren"));
  skill("ohne-kopf", home, "# Kein Kopf"); skill("mit leerzeichen"); skill(".versteckt"); skill(".system");
  skill("kollision", home, head("doppelt"));
  file(join(input.skills.codexHome!, "skills", "eigen", "SKILL.md"), head("doppelt"));
  const source = skill("fremd");
  symlinkSync(source, join(root, ".agents", "skills", "Fremd"), "dir");
  for (const enabled of [true, false]) {
    input.skills.enabled = enabled;
    const result = gaps();
    expect(result.skills).toContainEqual({ name: "verloren", reason: enabled ? "link_missing" : "skills_off" });
    expect(result.skills).toContainEqual({ name: "ohne-kopf", reason: "head" });
    expect(result.skills).toContainEqual({ name: "kollision", reason: "name" });
    for (const name of ["mit leerzeichen", ".versteckt", ".system"]) expect(result.skills).toContainEqual({ name: safeSkillName(name), reason: "name" });
    expect(result.skills).toHaveLength(6);
    expect(JSON.stringify(result)).not.toContain('"error"');
    expect(JSON.stringify(result)).not.toContain("mit leerzeichen");
  }
});

test("Plugins: Schlüssel zählen, nicht Installationen; unbekannt bei fehlender oder defekter Datei", () => {
  expect(gaps().plugins).toBeNull(); expect(gaps().fixed).toContain("plugins");
  const path = join(home, ".claude", "plugins", "installed_plugins.json");
  file(path, { version: 2, plugins: { "eins@quelle": [{ installPath: "/privat/eins" }, {}], "zwei@quelle": [] } });
  expect(gaps().plugins).toBe(2); expect(gaps().fixed).toContain("plugins");
  file(path, { version: 2, plugins: {} });
  expect(gaps().plugins).toBe(0); expect(gaps().fixed).not.toContain("plugins");
  for (const value of ["{kaputt", { plugins: [] }]) { file(path, value); expect(gaps().plugins).toBeNull(); }
});

for (const engine of ENGINE_IDS) test(`Unlesbare Konfiguration ergibt unknown für ${engine}, fehlende Datei bleibt ok`, () => {
  expect(toolInventory(engine, input).state).toBe("ok");
  const path = engine === "claude" ? join(home, ".claude.json") : engine === "codex" ? join(input.skills.codexHome!, "config.toml")
    : engine === "opencode" ? join(root, "opencode.json") : join(root, "config", "mcp-servers.json");
  file(path, "kaputt = [");
  expect(toolInventory(engine, input).state).toBe("unknown");
  expect(() => toolGaps(engine, input)).not.toThrow();
  expect(logs.every(log => log.mock.calls.length === 0)).toBe(true);
});

test("Ein Snapshot liest Claude-JSON einmal; Bestandsaufnahme und Lücken schreiben und loggen nichts", () => {
  claude({ beispiel: local }); skill("beispiel");
  const before = [root, home].map(p => statSync(p).mtimeMs);
  const snapshot = createToolParitySnapshot(input);
  for (const engine of ENGINE_IDS) { snapshot.inventory(engine); snapshot.gaps(engine); }
  expect(reads.filter(path => path === join(home, ".claude.json"))).toHaveLength(1);
  expect([root, home].map(p => statSync(p).mtimeMs)).toEqual(before);
  expect(existsSync(join(root, ".agents"))).toBe(false);
  expect(existsSync(join(root, "data", "codex-skill-links.json"))).toBe(false);
  expect(logs.every(log => log.mock.calls.length === 0)).toBe(true);
});

test("Datenschutz: Werte, Kopfzeilen, Adressen, Argumente, Variablennamen, Pfade und Skill-Inhalte verlassen keine Quelle", async () => {
  const markers = ["ERFUNDEN_ENV_001", "ERFUNDEN_HEADER_002", "ERFUNDEN_URL_003", "ERFUNDEN_ARG_004", "ERFUNDENE_VARIABLE_005", "ERFUNDENER_KOPF_006"];
  const secret = { command: "bun", args: ["--token", markers[3]], env: { [markers[4]]: markers[0] },
    headers: { "X-Beispiel": markers[1] }, url: `https://beispiel.invalid/${markers[2]}` };
  claude({ benutzer: secret }, { projekt: secret }, { enabledMcpjsonServers: ["geteilt"] });
  file(join(root, ".mcp.json"), { mcpServers: { geteilt: secret } });
  file(join(root, "config", "mcp-servers.json"), { servers: { tybo: secret } });
  file(input.extraFile!, { servers: { extra: secret } });
  file(join(root, ".claude", "settings.json"), { mcpServers: { einstellung: secret } });
  file(join(input.opencodeConfig, "opencode.json"), { mcp: { offen: secret } });
  file(join(input.skills.codexHome!, "config.toml"), `[mcp_servers.eigen]\ncommand="bun"\nargs=["${markers[3]}"]\n[mcp_servers.eigen.env]\n${markers[4]}="${markers[0]}"`);
  skill("fertigkeit", home, head(markers[5]));
  file(join(claudeNotesDir(root, home), "MEMORY.md"), markers.join(" "));
  file(join(home, ".claude", "plugins", "installed_plugins.json"), { plugins: { [markers[5]]: [{ installPath: base }] } });
  const snapshot = createToolParitySnapshot(input);
  const data = ENGINE_IDS.map(engine => ({ engine, label: engine, tools: { inventory: snapshot.inventory(engine), gaps: snapshot.gaps(engine) } }));
  const out = [JSON.stringify(data), motorToolsText(data), ...data.map(entry => toolSummary(entry.tools))];
  const engines = createEngineCommandServices({ getSettings: () => ({}), env: () => ({}), toolSnapshot: () => snapshot,
    checkEngine: async engine => ({ engine, checked: true, installed: true, loggedIn: true }) });
  for (const text of ["/motor", "/motor werkzeuge"]) {
    const match = commandRegistry.match(text, "web")!;
    await match.command.run({ args: match.args, agent: "general", sessionKey: "web:test", services: { engines }, reply: async text => { out.push(text); } } as CommandContext);
  }
  const ctx = createSetupContext({ root, home, run: async () => { throw new Error("kein Programm"); } });
  out.push(JSON.stringify(await engineToolFindings(ctx, "codex", { ready: async () => true, snapshot: () => snapshot,
    plan: () => ({ ...captured, passed: [] }), inspectSkills: () => ({ expected: [], linked: [], foreign: [], skipped: [] }) })));
  out.push(JSON.stringify(logs.map(log => log.mock.calls)));
  const result = out.join("\n");
  for (const forbidden of [...markers, "https://", "beispiel.invalid", base, "X-Beispiel", "-c mcp_servers", "TYBO_MCP_"]) expect(result).not.toContain(forbidden);
});

test("Alle festen Mengen haben einen deutschen Text; intern bleiben feste Lücken Kennungen", () => {
  for (const reason of [...MCP_GAP_REASONS, ...TOOL_HINT_REASONS, ...SKILL_GAP_REASONS, ...TOOL_GAP_IDS]) {
    expect(typeof TOOL_GAP_TEXT[reason]).toBe("string"); expect(TOOL_GAP_TEXT[reason].length).toBeGreaterThan(10);
  }
  expect(gaps().fixed.every(id => typeof id === "string" && TOOL_GAP_IDS.includes(id))).toBe(true);
});
