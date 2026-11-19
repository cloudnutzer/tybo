import { expect, test } from "bun:test";
import { createEngineCommandServices } from "../src/lib/engine-choice";
import { hasToolGaps, toolSummary } from "../src/lib/engines/tool-display";
import type { EngineTools } from "../src/web/tool-parity-types";

const data = (): EngineTools => ({
  inventory: { mcp: [{ name: "quelle", origin: "tybo" }], skills: [], notes: "passed", state: "ok" },
  gaps: { mcp: [{ name: "andere", reason: "auth_unknown" }], skills: [], hints: [], notes: false, plugins: 0, fixed: ["connectors", "hooks", "builtin"] },
});

test("Kurzfassung zählt nur Bestand und nennt auch die festen Lücken", () => {
  expect(toolSummary(data())).toBe("1 MCP-Server, 0 Skills, Notizen. Fehlt: 1 MCP-Server, Konnektoren des Claude-Kontos, Hooks, eingebaute Werkzeuge.");
  expect(hasToolGaps(data().gaps)).toBe(true);
  const empty = data();
  empty.gaps = { mcp: [], skills: [], hints: [], fixed: [], notes: false, plugins: null };
  expect(hasToolGaps(empty.gaps)).toBe(false);
  empty.inventory.state = "unknown";
  expect(toolSummary(empty)).toContain("Bestand unvollständig lesbar");
});

test("Werkzeugdienst bleibt ohne Leser aus; je Abruf genau ein Snapshot für alle Motoren", async () => {
  const deps = { getSettings: () => ({}), env: () => ({}), checkEngine: async () => ({ engine: "claude" as const, checked: true, installed: true, loggedIn: true }) };
  expect(createEngineCommandServices(deps).tools).toBeUndefined();
  let snapshots = 0;
  const read: string[] = [];
  const service = createEngineCommandServices({ ...deps, toolSnapshot: () => {
    snapshots++;
    return { inventory: id => { read.push(`inventory:${id}`); return data().inventory; }, gaps: id => { read.push(`gaps:${id}`); return data().gaps; } };
  } });
  const request = await service.available();
  const concurrent = await service.available();
  expect(service.tools!("codex", request)).toEqual(data());
  service.tools!("opencode", request);
  expect(snapshots).toBe(1);
  expect(read).toEqual(["inventory:codex", "gaps:codex", "inventory:opencode", "gaps:opencode"]);
  service.tools!("codex", concurrent);
  expect(snapshots).toBe(2);
  service.tools!("api", request);
  expect(snapshots).toBe(2);
});
