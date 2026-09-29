import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "../src/lib/atomic-file";
import { reserveBudget, settleBudget, remainingBudget } from "../src/lib/daily-budget";
import { mcpManager } from "../src/lib/mcp-client";
import { registerBuiltinTool, setToolApprovalHandler } from "../src/lib/tools/registry";
import { handleGroupCommand } from "../src/lib/whatsapp-groups";
import { terminateProcessTree } from "../src/lib/process-tree";

test("unclassified MCP writes use the same denial gate", async () => {
  const manager = mcpManager as any;
  const previous = { servers: manager.servers, allTools: manager.allTools, toolToServer: manager.toolToServer };
  let approvals = 0, executions = 0;
  setToolApprovalHandler(async () => { approvals++; return false; });
  manager.servers = new Map([["synthetic", { client: { callTool: async () => { executions++; return {}; } } }]]);
  manager.allTools = [{ name: "test_remote_write", serverName: "synthetic", description: "Claims to be safe", inputSchema: {} }];
  manager.toolToServer = new Map([["test_remote_write", "synthetic"]]);
  try {
    expect((await mcpManager.callTool("test_remote_write", {})).isError).toBe(true);
    expect(approvals).toBe(1);
    expect(executions).toBe(0);
    registerBuiltinTool({ name: "test_remote_write", description: "local protected", requiresApproval: true,
      inputSchema: { type: "object", properties: {} }, isAvailable: () => true, handler: async () => { executions++; return "wrong"; } });
    expect((await mcpManager.callTool("test_remote_write", {})).isError).toBe(true);
    expect(approvals).toBe(2);
    expect(executions).toBe(0);
  } finally { Object.assign(manager, previous); }
});

test("WhatsApp guest cannot add, remove, rename or create groups", () => {
  const previous = process.env.WHATSAPP_OWNER_NUMBER;
  process.env.WHATSAPP_OWNER_NUMBER = "+490000001";
  try {
    for (const command of ["add +490000003 Person", "remove +490000003", "rename +490000003 Owner", "create test"])
      expect(handleGroupCommand("+490000002", `/group ${command}`)).toContain("Nur der Owner");
  } finally {
    if (previous === undefined) delete process.env.WHATSAPP_OWNER_NUMBER;
    else process.env.WHATSAPP_OWNER_NUMBER = previous;
  }
});

test("budget reservations survive reopen and exclude competing allocations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tybo-budget-"));
  const oldPath = process.env.BUDGET_DB_PATH, oldLimit = process.env.DAILY_API_BUDGET;
  process.env.BUDGET_DB_PATH = join(dir, "budget.sqlite");
  process.env.DAILY_API_BUDGET = "2";
  try {
    const id = reserveBudget("synthetic", 1.5);
    expect(remainingBudget()).toBe(0.5);
    expect(() => reserveBudget("second", 1)).toThrow("budget");
    settleBudget(id, 0.25);
    expect(remainingBudget()).toBe(1.75);
    settleBudget(id);
    expect(remainingBudget()).toBe(1.75);
    settleBudget(reserveBudget("unknown-charge", 1));
    expect(remainingBudget()).toBe(0.75);
  } finally {
    if (oldPath === undefined) delete process.env.BUDGET_DB_PATH; else process.env.BUDGET_DB_PATH = oldPath;
    if (oldLimit === undefined) delete process.env.DAILY_API_BUDGET; else process.env.DAILY_API_BUDGET = oldLimit;
    await rm(dir, { recursive: true });
  }
});

test("atomic writes serialize and leave complete JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tybo-state-"));
  try {
    const file = join(dir, "state.json");
    await Promise.all(Array.from({ length: 40 }, (_, n) => atomicWriteFile(file, JSON.stringify({ n, value: "x".repeat(5000) }))));
    expect(JSON.parse(await readFile(file, "utf8")).n).toBe(39);
  } finally { await rm(dir, { recursive: true }); }
});

test("nondefault model resumes and retains the memory watermark", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tybo-session-"));
  try {
    const module = resolve("src/lib/session-manager.ts");
    const code = `const m = await import(${JSON.stringify(module)});
      await Promise.all([m.recordSessionTurn('topic:a','general','custom-model','claude','session-a',123),m.recordSessionTurn('topic:b','general','custom-model','claude','session-b',456)]);
      const s = await m.getResumableSession('topic:a','general','custom-model','claude');
      if(s?.engineSessionId!=='session-a'||s?.memoryWatermark!==123) process.exit(1);
      if(await m.getResumableSession('topic:a','general','other-model','claude')) process.exit(2);
      if(!(await m.getResumableSession('topic:b','general','custom-model','claude'))) process.exit(3);`;
    const child = Bun.spawn([process.execPath, "-e", code], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(error).toBe("");
  } finally { await rm(dir, { recursive: true }); }
});

test("patched image parsers reject adversarial formats while PNG works", () => {
  const size = require("image-size").imageSize;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ8sAAAAASUVORK5CYII=", "base64");
  expect(size(png).width).toBe(1);
  const icns = Buffer.alloc(16);
  icns.write("icns"); icns.writeUInt32BE(16,4); icns.write("ic07",8); icns.writeUInt32BE(0,12);
  expect(() => size(icns)).toThrow("tybo security policy");
  for (const type of ["heif", "jxl", "jxl-stream"]) {
    const handler = Object.values(require(`image-size/dist/types/${type}.js`))[0] as any;
    expect(() => handler.calculate(Buffer.alloc(32))).toThrow("tybo security policy");
  }
});

test("process cancellation reaches a detached shell and its child", async () => {
  if (process.platform === "win32") return;
  const proc = Bun.spawn(["/bin/sh", "-c", "sleep 60 & wait"], { detached: true, stdout: "pipe", stderr: "pipe" });
  try {
    const group = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(proc.pid)]).stdout.toString().trim();
    expect(Number(group)).toBe(proc.pid);
    terminateProcessTree(proc);
    const exit = await Promise.race([proc.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("process did not exit")), 3000))]);
    expect(exit).not.toBe(0);
  } finally { try { process.kill(-proc.pid, "SIGKILL"); } catch {} }
});

test("knowledge writes work with each backend and propagate failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tybo-knowledge-"));
  try {
    for (const backend of ["supabase", "convex"]) {
      const code = `
        let fail=false; let writes=0;
        globalThis.fetch = async (url, init) => {
          if(String(url).includes('functions/v1')) return Response.json({ok:true});
          writes++;
          if(fail) return Response.json({message:'synthetic failure'}, {status:503});
          return Response.json(${backend === "convex" ? "{status:'success',value:'synthetic-id',logLines:[]}" : "{id:'synthetic-id'}"});
        };
        const m = await import(${JSON.stringify(resolve("src/lib/knowledge-base.ts"))});
        const entry={category:'reference',title:'test',content:'test'};
        if(!(await m.addKnowledge(entry)).ok) process.exit(1);
        fail=true;
        if((await m.addKnowledge(entry)).ok) process.exit(2);
        if(writes<2) process.exit(3);
      `;
      const child = Bun.spawn([process.execPath, "-e", code], { cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir,
          ...(backend === "convex" ? { CONVEX_URL: "https://synthetic.convex.cloud", CONVEX_AUTH_TOKEN: "synthetic" }
            : { SUPABASE_URL: "https://synthetic.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic" }) }, stdout: "pipe", stderr: "pipe" });
      await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
    }
  } finally { await rm(dir, { recursive: true }); }
});
