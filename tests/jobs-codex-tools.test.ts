import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_JOB_TOOL_ARGS, parseCodexMcpNames, readCodexMcpServers } from "../src/lib/jobs/codex-tools";
import { createJobDeps } from "../src/lib/jobs/default-deps";
import { tempRoot } from "./jobs-fixture";

const { root, cleanup } = tempRoot();
afterAll(cleanup);

describe("Codex-MCP-Vorprüfung ohne echte CLI", () => {
  test("nur Namen übernehmen, auch bereits deaktivierte Server", () => {
    expect(parseCodexMcpNames({ mcp_servers: {
      aktiv: { enabled: true, env: { TOKEN: "nicht-ins-Log" } },
      inaktiv: { enabled: false },
    } })).toEqual(["aktiv", "inaktiv"]);
    expect(parseCodexMcpNames({ mcp_servers: {} })).toEqual([]);
    for (const bad of [null, {}, [], "kaputt", { mcp_servers: [] }, { mcp_servers: null }, { mcp_servers: { "": {} } }, { mcp_servers: { mail: null } }]) {
      expect(() => parseCodexMcpNames(bad)).toThrow();
    }
  });

  test("dieselbe Umgebung und Projekt-cwd, nur config/read; fehlerhafte Ausgabe und Exit verhindern Freigabe", async () => {
    const cli = join(root, "codex-attrappe");
    const capture = join(root, "aufruf.json");
    writeFileSync(cli, `#!${process.execPath}\n` + [
      'import { writeFileSync } from "node:fs";',
      'import { createInterface } from "node:readline";',
      'const requests = [];',
      'for await (const line of createInterface({ input: process.stdin })) {',
      '  const request = JSON.parse(line); requests.push(request);',
      '  if (request.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));',
      '  if (request.id !== 2) continue;',
      `  writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.CODEX_HOME, job: process.env.TYBO_JOB_ID, requests }));`,
      '  if (process.env.PROBE_EXIT) process.exit(Number(process.env.PROBE_EXIT));',
      '  if (process.env.PROBE_HANG) continue;',
      '  if (process.env.PROBE_RPC_ERROR) { console.log(JSON.stringify({ id: 2, error: { message: "nicht-ins-Log" } })); continue; }',
      '  console.log(`{"id":2,"result":{"config":${process.env.PROBE_OUTPUT}}}`);',
      '}',
    ].join("\n"));
    chmodSync(cli, 0o700);
    const logs: string[] = [];
    const deps = createJobDeps({ root, env: { CODEX_PATH: cli }, log: line => logs.push(line) });
    const env = { HOME: root, CODEX_HOME: join(root, "codex-home"), TYBO_JOB_ID: "test-job", PROBE_OUTPUT: '{"mcp_servers":{"mail":{"token":"nicht-ins-Log"}}}' };
    expect(await deps.codexMcpServers(env)).toEqual(["mail"]);
    const call = JSON.parse(readFileSync(capture, "utf8"));
    expect(call).toMatchObject({ cwd: realpathSync(root), home: env.CODEX_HOME, job: "test-job" });
    expect(call.args.slice(0, 3)).toEqual(["app-server", "--listen", "stdio://"]);
    expect(call.args.slice(3)).toEqual([...CODEX_JOB_TOOL_ARGS]);
    expect(call.requests.map((request: { method: string }) => request.method)).toEqual(["initialize", "initialized", "config/read"]);
    expect(call.requests[2].params).toEqual({ cwd: root, includeLayers: false });
    expect(call.args).toContain("apps");
    expect(call.args).toContain("plugins");
    expect(call.args).toContain("hooks");
    // Der Prüfbericht darf genau seine Planargumente einsetzen; Jobs behalten
    // ohne diesen Parameter unverändert ihre Abschaltungen.
    const args = ["-c", 'mcp_servers.probe.command="bun"'];
    expect(await readCodexMcpServers({ codexPath: cli, root, env, args })).toEqual(["mail"]);
    expect(JSON.parse(readFileSync(capture, "utf8")).args).toEqual(["app-server", "--listen", "stdio://", ...args]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(readCodexMcpServers({ codexPath: cli, root, env: { ...env, PROBE_HANG: "1" }, args, signal: controller.signal })).rejects.toThrow("nicht prüfbar");
    } finally { clearTimeout(timer); }
    for (const extra of [{ PROBE_OUTPUT: "ungültig" }, { PROBE_OUTPUT: "{}" }, { PROBE_EXIT: "1" }, { PROBE_RPC_ERROR: "1" }, { PROBE_HANG: "1" }]) {
      await expect(deps.codexMcpServers({ ...env, ...extra })).rejects.toThrow("eingeschränkter Job wird nicht gestartet");
    }
    expect(logs).toEqual([]);
  });
});
