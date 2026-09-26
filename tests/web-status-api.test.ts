/**
 * Issue #37: GET /api/status und POST /api/restart über den Server. Der
 * Neustart-Marker liegt immer in einem temporären Ordner, der Supervisor ist
 * eine Attrappe; nie data/restart-requested, nie launchctl.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRestartRequest, requestRestart } from "../src/lib/restart-request";
import { createBotStatus, type BotStatusDeps } from "../src/web/bot-status";
import type { WebServer } from "../src/web/server";
import { RESTART_NOTE, STATUS_TEXT, type Supervisor } from "../src/web/status";
import { topicServer } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "bot-status-api-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

const SECRET = "sk-ant-test-Status-Api-9f8e7d6c";
let counter = 0;

async function setup(supervisor: Supervisor | null | "throws", overrides: Partial<BotStatusDeps> = {}) {
  const marker = join(root, `case-${++counter}`, "data", "restart-requested");
  const status = createBotStatus(
    { ANTHROPIC_API_KEY: SECRET, SUPABASE_URL: "https://test-status-api.supabase.co" },
    {
      gitHead: async () => "0fe4c19",
      readPackageJson: () => '{"version":"2.12.0"}',
      startedAt: Date.now() - 3_000,
      detectSupervisor: async () => {
        if (supervisor === "throws") throw new Error("launchctl hängt");
        return supervisor;
      },
      listSessions: async () => [],
      sessionMode: () => true,
      activeExecutions: () => 1,
      activeClaudeCalls: () => 1,
      restartMarker: marker,
      requestRestart: note => requestRestart(note, marker),
      ...overrides,
    }
  );
  const ctx = await topicServer(root, servers, null, { status });
  return { ...ctx, marker };
}

describe("GET /api/status", () => {
  test("liefert alle Felder, Schlüssel nur als set, kein Wert in der ganzen HTTP-Antwort", async () => {
    const ctx = await setup("launchd");
    const res = await ctx.api("/api/status");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("test-status-api");
    for (const [, v] of res.headers) expect(v).not.toContain(SECRET);
    const body = JSON.parse(raw);
    expect(Object.keys(body).sort()).toEqual(
      ["keys", "restartRequested", "running", "sessions", "startedAt", "storage", "supervisor", "uptimeSeconds", "version"].sort()
    );
    expect(body.version).toEqual({ app: "2.12.0", commit: "0fe4c19" });
    expect(body.supervisor).toBe("launchd");
    expect(body.storage).toBe("supabase");
    expect(body.sessions).toEqual({ mode: "resume", stored: 0, resumable: 0 });
    expect(body.running).toEqual({ executions: 1, claudeCalls: 1 });
    expect(body.restartRequested).toBe(false);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(3);
    expect(body.keys.find((k: any) => k.name === "ANTHROPIC_API_KEY")).toEqual({ name: "ANTHROPIC_API_KEY", group: "Anthropic", set: true });
    expect(body.keys.find((k: any) => k.name === "OPENAI_API_KEY").set).toBe(false);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("ohne Anmeldung 401", async () => {
    const ctx = await setup("launchd");
    const res = await fetch(`${ctx.origin}/api/status`);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SECRET);
  });

  test("falsche Methode 405", async () => {
    const ctx = await setup("launchd");
    const res = await ctx.api("/api/status", "POST", {});
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    expect(await readRestartRequest(ctx.marker)).toBeNull();
  });

  test("ohne Status-Quelle 503", async () => {
    const ctx = await topicServer(root, servers, null, {});
    expect((await ctx.api("/api/status")).status).toBe(503);
    const res = await ctx.api("/api/restart", "POST");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(STATUS_TEXT.notConfigured);
  });
});

describe("POST /api/restart", () => {
  test("mit Supervisor: 202, Marker mit Notiz WebUI, Hinweis auf Neustart nach der Antwort", async () => {
    const ctx = await setup("launchd");
    const res = await ctx.api("/api/restart", "POST");
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ requested: true, supervisor: "launchd", message: STATUS_TEXT.requested });
    expect(body.message).toContain("nach der laufenden Antwort");
    expect(await readRestartRequest(ctx.marker)).toBe(RESTART_NOTE);
    expect((await (await ctx.api("/api/status")).json()).restartRequested).toBe(true);
    expect(ctx.logs.some(l => l.includes("Neustart angefordert"))).toBe(true);
  });

  test("PM2 zählt ebenfalls als Supervisor", async () => {
    const ctx = await setup("pm2");
    expect((await ctx.api("/api/restart", "POST")).status).toBe(202);
    expect(await readRestartRequest(ctx.marker)).toBe("WebUI");
  });

  test("ohne Supervisor: 409 mit Hinweis auf manuellen Neustart, kein Marker", async () => {
    const ctx = await setup(null);
    const res = await ctx.api("/api/restart", "POST");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe(STATUS_TEXT.noSupervisor);
    expect(body.error).toContain("manuell");
    expect(await readRestartRequest(ctx.marker)).toBeNull();
  });

  test("Supervisor-Erkennung scheitert: vorsichtig 409, kein Marker", async () => {
    const ctx = await setup("throws");
    expect((await ctx.api("/api/restart", "POST")).status).toBe(409);
    expect(await readRestartRequest(ctx.marker)).toBeNull();
  });

  test("Schreibfehler: 500, kein Erfolg gemeldet", async () => {
    // Elternordner ist eine Datei: mkdir und writeFile scheitern
    const blocker = join(root, `blocker-${++counter}`);
    await writeFile(blocker, "");
    const marker = join(blocker, "restart-requested");
    const ctx = await setup("launchd", { requestRestart: note => requestRestart(note, marker) });
    const res = await ctx.api("/api/restart", "POST");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.requested).toBeUndefined();
    expect(body.error).toBe(STATUS_TEXT.notSaved);
    expect(await readRestartRequest(marker)).toBeNull();
    expect(ctx.logs.some(l => l.includes("Neustart-Marker nicht geschrieben"))).toBe(true);
  });

  test("ohne Anmeldung 401, kein Marker", async () => {
    const ctx = await setup("launchd");
    const res = await fetch(`${ctx.origin}/api/restart`, { method: "POST", headers: { origin: ctx.origin } });
    expect(res.status).toBe(401);
    expect(await readRestartRequest(ctx.marker)).toBeNull();
  });

  test("ohne Origin oder mit fremdem Origin 403, kein Marker", async () => {
    const ctx = await setup("launchd");
    const none = await fetch(`${ctx.origin}/api/restart`, { method: "POST", headers: { cookie: ctx.cookie } });
    expect(none.status).toBe(403);
    const foreign = await ctx.api("/api/restart", "POST", undefined, { origin: "http://evil.example" });
    expect(foreign.status).toBe(403);
    expect(await readRestartRequest(ctx.marker)).toBeNull();
  });

  test("falsche Methode 405, kein Marker", async () => {
    const ctx = await setup("launchd");
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await ctx.api("/api/restart", method);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
    expect(await readRestartRequest(ctx.marker)).toBeNull();
  });
});
