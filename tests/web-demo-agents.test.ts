// Demo und web:dev mit Agenten-Katalog (Issue #50): Anlegen, Löschen,
// Wiederherstellen, Prompts und Board nur im Speicher, verbunden mit den
// Topics und der Einstellungs-Attrappe. Nie config/agents.json,
// config/topics.json oder config/settings.json des Checkouts.
import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDemoAgents, startDemoServer } from "../src/web/demo";

const root = resolve(import.meta.dir, "..");
const CONFIG_FILES = ["agents.json", "topics.json", "settings.json"].map(f => resolve(root, "config", f));

async function fileOrNull(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
const snapshot = async () => Promise.all(CONFIG_FILES.map(fileOrNull));
const before = await snapshot();

const demo = await startDemoServer({ host: "127.0.0.1", port: 0, password: "test-passwort-lang", allowedHosts: [] }, { log: () => {} });
afterAll(() => demo.stop());
const origin = demo.server.url;

async function api(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { origin, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const topicAgent = async (id: string) => (await api("/api/conversations")).body.telegram.topics.find((t: any) => t.id === id)?.agent;

describe("Demo-Server", () => {
  test("Liste mit Topic-Zahlen aus den Beispiel-Topics", async () => {
    const { status, body } = await api("/api/agents");
    expect(status).toBe(200);
    expect(body.agents[0]).toMatchObject({ name: "general", origin: "builtin", promptSource: "code", board: false });
    expect(body.agents.find((a: any) => a.name === "research").topicCount).toBe(1);
    expect(body.deleted).toEqual([]);
    expect(body.revision.seq).toBeGreaterThan(0);
  });

  test("Anlegen mit Modell: in Liste, Einstellungen und Auswahl für neue Gespräche", async () => {
    const created = await api("/api/agents", "POST", { name: "demo-planer", description: "Plant", systemPrompt: "Du planst.", model: "claude-sonnet-5", effort: "low" });
    expect(created.status).toBe(201);
    expect(created.body.settingsSaved).toBe(true);
    const settings = (await api("/api/settings")).body;
    expect(settings.agents).toContain("demo-planer");
    expect(settings.effective.agents["demo-planer"].model).toEqual({ value: "claude-sonnet-5", source: "settings" });
    expect((await api("/api/conversations", "POST", { agent: "demo-planer" })).status).toBe(201);
    expect((await api("/api/agents", "POST", { name: "cfo", description: "x", systemPrompt: "y" })).status).toBe(409);
  });

  test("Prompt ändern und zurücksetzen", async () => {
    const code = (await api("/api/agents/strategy/prompt")).body;
    expect(code.promptSource).toBe("code");
    expect((await api("/api/agents/strategy/prompt", "PUT", { text: "Demo-Strategie" })).body.promptSource).toBe("custom");
    const reset = await api("/api/agents/strategy/prompt", "DELETE");
    expect(reset.body.systemPrompt).toBe(code.systemPrompt);
  });

  test("Löschen stellt das Beispiel-Topic auf General um; gelöscht fehlt überall, Wiederherstellen holt ihn zurück", async () => {
    expect(await topicAgent("topic-443")).toBe("research");
    expect((await api("/api/agents/research", "DELETE", { confirm: "research" })).body.moved).toEqual([{ chatId: "-1000000000001", topicId: 443 }]);
    expect(await topicAgent("topic-443")).toBe("general");
    const list = (await api("/api/agents")).body;
    expect(list.agents.map((a: any) => a.name)).not.toContain("research");
    expect(list.deleted.map((d: any) => d.name)).toEqual(["research"]);
    expect((await api("/api/settings")).body.agents).not.toContain("research");
    expect((await api("/api/conversations", "POST", { agent: "research" })).status).toBe(400);
    expect((await api("/api/conversations/topic-443", "PATCH", { agent: "research" })).status).toBe(400);
    expect((await api("/api/agents/research/restore", "POST")).status).toBe(200);
    expect((await api("/api/conversations/topic-443", "PATCH", { agent: "research" })).status).toBe(200);
  });

  test("Board-Schalter und General-Schutz", async () => {
    expect((await api("/api/agents/content", "PATCH", { board: false })).body.agents.find((a: any) => a.name === "content").board).toBe(false);
    expect((await api("/api/agents/general", "PATCH", { board: true })).status).toBe(409);
    expect((await api("/api/agents/general", "DELETE", { confirm: "general" })).status).toBe(409);
  });

  test("keine Datei unter config/ angefasst", async () => {
    expect(await snapshot()).toEqual(before);
  });
});

describe("createDemoAgents (web:dev ohne Beispieldaten)", () => {
  test("Topic-Zuordnung zu gelöschtem Agenten wird in der Attrappe abgelehnt", async () => {
    const { catalog, topics } = createDemoAgents({ seed: false });
    const conversation = { id: "topic-1", title: "General", agent: "general", lastActivity: null };
    await catalog.delete("finance");
    const res = await topics.topics.setAgent(conversation, 900, "finance");
    expect(res.status).toBe(409);
  });

  test("scripts/web-dev.ts nutzt dieselbe Attrappe für Katalog, Einstellungen und Topics", async () => {
    const src = await Bun.file(resolve(root, "scripts", "web-dev.ts")).text();
    expect(src).toContain("const demoAgents = createDemoAgents({ seed: false });");
    expect(src).toContain("settings: demoAgents.settings,");
    expect(src).toContain("agentCatalog: demoAgents.catalog,");
    expect(src).not.toContain("createDemoSettings()");
  });
});
