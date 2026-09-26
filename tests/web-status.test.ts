import { test, expect, describe, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countResumableSessions,
  createStatusApi,
  keyStatus,
  storageBackend,
  STATUS_KEY_GROUPS,
  type StatusPort,
  type StoredSession,
} from "../src/web/status";
import { createBotStatus, processStartedAt, readGitCommit, readPackageVersion } from "../src/web/bot-status";

// Attrappen für alles, was den laufenden Bot berühren könnte: kein launchctl,
// kein git im Bot-Checkout, kein Marker unter data/.

const dir = await mkdtemp(join(tmpdir(), "bot-status-"));
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

function fakePort(overrides: Partial<StatusPort> = {}): StatusPort & { restarts: string[] } {
  const restarts: string[] = [];
  return {
    restarts,
    version: () => "2.12.0",
    commit: async () => "0fe4c19",
    startedAt: () => NOW - 90 * 60_000 - 500,
    supervisor: async () => "launchd",
    storage: () => "supabase",
    sessions: async () => ({ mode: "resume", stored: 3, resumable: 2 }),
    activeExecutions: () => 2,
    activeClaudeCalls: () => 1,
    restartRequested: async () => false,
    requestRestart: async note => {
      restarts.push(note);
    },
    keys: () => keyStatus({}),
    now: () => NOW,
    ...overrides,
  };
}

describe("fortsetzbare Sessions", () => {
  const base = { sessionMode: true, idleMs: 18 * HOUR, modelFor: () => "claude-opus-5-5", now: NOW };
  const session = (s: Partial<StoredSession>): StoredSession => ({
    agentName: "general",
    claudeSessionId: "abc",
    model: "claude-opus-5-5",
    lastActivity: NOW - HOUR,
    ...s,
  });

  test("zählt nur Einträge mit Session-ID, in der Frist und mit aktuellem Modell", () => {
    const list = [
      session({}),
      session({ claudeSessionId: undefined }),
      session({ lastActivity: NOW - 19 * HOUR }),
      session({ model: "claude-sonnet-5" }),
      session({ lastActivity: NOW - 18 * HOUR }), // Grenze eingeschlossen wie getResumableSession
    ];
    expect(countResumableSessions(list, base)).toBe(2);
  });

  test("Modell pro Agent", () => {
    const modelFor = (a: string) => (a === "research" ? "claude-sonnet-5" : "claude-opus-5-5");
    const list = [session({ agentName: "research", model: "claude-sonnet-5" }), session({ agentName: "research" })];
    expect(countResumableSessions(list, { ...base, modelFor })).toBe(1);
  });

  test("ohne SESSION_MODE=resume ist nichts fortsetzbar", () => {
    expect(countResumableSessions([session({})], { ...base, sessionMode: false })).toBe(0);
  });
});

test("Speicher: Convex vor Supabase, sonst keiner, leere Werte zählen nicht", () => {
  expect(storageBackend({ CONVEX_URL: "https://x.convex.cloud", SUPABASE_URL: "https://y" })).toBe("convex");
  expect(storageBackend({ SUPABASE_URL: "https://y" })).toBe("supabase");
  expect(storageBackend({ CONVEX_URL: "", SUPABASE_URL: "" })).toBe("none");
  expect(storageBackend({})).toBe("none");
});

test("Speicher: URL nur aus Leerzeichen wählt wie getBackend() das Backend", () => {
  // getBackend() in src/lib/convex.ts prüft nur auf nicht leer, ohne trim()
  expect(storageBackend({ CONVEX_URL: " ", SUPABASE_URL: "https://y" })).toBe("convex");
  expect(storageBackend({ CONVEX_URL: "  \t" })).toBe("convex");
  expect(storageBackend({ CONVEX_URL: "", SUPABASE_URL: "   " })).toBe("supabase");
});

describe("GET-Daten", () => {
  test("alle Felder vorhanden, Zeitformat ISO, Laufzeit in ganzen Sekunden", async () => {
    const api = createStatusApi(fakePort(), () => {});
    const { status, body } = await api.get();
    expect(status).toBe(200);
    expect(body.version).toEqual({ app: "2.12.0", commit: "0fe4c19" });
    expect(body.startedAt).toBe(new Date(NOW - 90 * 60_000 - 500).toISOString());
    expect(body.uptimeSeconds).toBe(5400);
    expect(body.supervisor).toBe("launchd");
    expect(body.storage).toBe("supabase");
    expect(body.sessions).toEqual({ mode: "resume", stored: 3, resumable: 2 });
    expect(body.running).toEqual({ executions: 2, claudeCalls: 1 });
    expect(body.restartRequested).toBe(false);
    expect(Array.isArray(body.keys)).toBe(true);
  });

  test("einzelne Fehler ergeben null und eine Log-Zeile ohne Meldungstext", async () => {
    const logs: string[] = [];
    const boom = async () => {
      throw new Error("geheim-123");
    };
    const api = createStatusApi(
      fakePort({ commit: boom, supervisor: boom, sessions: boom, restartRequested: boom }),
      m => logs.push(m)
    );
    const { status, body } = await api.get();
    expect(status).toBe(200);
    expect(body.version).toEqual({ app: "2.12.0", commit: null });
    expect(body.supervisor).toBeNull();
    expect(body.sessions).toBeNull();
    expect(body.restartRequested).toBeNull();
    expect(logs.length).toBe(4);
    expect(logs.join("\n")).not.toContain("geheim-123");
  });

  test("Laufzeit nie negativ", async () => {
    const api = createStatusApi(fakePort({ startedAt: () => NOW + 5000 }), () => {});
    expect((await api.get()).body.uptimeSeconds).toBe(0);
  });
});

describe("echte Quellen mit Attrappen", () => {
  const quiet = {
    gitHead: async () => "0fe4c19\n",
    readPackageJson: () => JSON.stringify({ version: "2.12.0" }),
    startedAt: NOW - 60_000,
    detectSupervisor: async () => "launchd" as const,
    listSessions: async () => [],
    sessionMode: () => true,
    idleMs: 18 * HOUR,
    modelFor: () => "claude-opus-5-5",
    activeExecutions: () => 0,
    activeClaudeCalls: () => 0,
    restartMarker: join(dir, "kein-marker"),
    requestRestart: async () => {},
    now: () => NOW,
  };

  test("Prozessstart aus process.uptime", () => {
    expect(processStartedAt(NOW, 120.5)).toBe(NOW - 120_500);
    // Ohne Angaben: vor jetzt, nicht erst beim Abruf
    expect(processStartedAt()).toBeLessThan(Date.now());
  });

  test("Git-Hash: kurz und hex, sonst null", async () => {
    expect(await readGitCommit(async () => "0fe4c19\n")).toBe("0fe4c19");
    expect(await readGitCommit(async () => "fatal: not a git repository")).toBeNull();
    expect(
      await readGitCommit(async () => {
        throw new Error("git fehlt");
      })
    ).toBeNull();
  });

  test("Version aus package.json, sonst unbekannt", () => {
    expect(readPackageVersion(() => '{"version":"2.12.0"}')).toBe("2.12.0");
    expect(readPackageVersion(() => "{kaputt")).toBe("unbekannt");
    expect(readPackageVersion(() => "{}")).toBe("unbekannt");
    expect(
      readPackageVersion(() => {
        throw new Error("fehlt");
      })
    ).toBe("unbekannt");
  });

  test("Version und Hash werden beim Anlegen festgehalten, nicht pro Abruf", async () => {
    let calls = 0;
    const port = createBotStatus({}, { ...quiet, gitHead: async () => (++calls, "abcdef1") });
    expect(await port.commit()).toBe("abcdef1");
    expect(await port.commit()).toBe("abcdef1");
    expect(calls).toBe(1);
  });

  test("Sessions: gespeichert und fortsetzbar, Modus aus SESSION_MODE", async () => {
    const list: StoredSession[] = [
      { agentName: "general", claudeSessionId: "a", model: "claude-opus-5-5", lastActivity: NOW - HOUR },
      { agentName: "general", claudeSessionId: "b", model: "alt", lastActivity: NOW - HOUR },
    ];
    const port = createBotStatus({}, { ...quiet, listSessions: async () => list });
    expect(await port.sessions()).toEqual({ mode: "resume", stored: 2, resumable: 1 });
    const off = createBotStatus({}, { ...quiet, listSessions: async () => list, sessionMode: () => false });
    expect(await off.sessions()).toEqual({ mode: "off", stored: 2, resumable: 0 });
  });

  test("Supervisor: erkannter bleibt, 'keiner' wird neu geprüft", async () => {
    const answers: Array<"launchd" | null> = [null, "launchd", null];
    let calls = 0;
    const port = createBotStatus({}, { ...quiet, detectSupervisor: async () => answers[calls++] ?? null });
    expect(await port.supervisor()).toBeNull();
    expect(await port.supervisor()).toBe("launchd");
    expect(await port.supervisor()).toBe("launchd");
    expect(calls).toBe(2);
  });

  test("Neustart-Marker: auch ein leerer zählt, Inhalt wird nicht weitergegeben", async () => {
    const marker = join(dir, "restart-requested");
    const port = createBotStatus({}, { ...quiet, restartMarker: marker });
    expect(await port.restartRequested()).toBe(false);
    await writeFile(marker, "");
    expect(await port.restartRequested()).toBe(true);
    await writeFile(marker, "Notiz mit Inhalt\n");
    const body = (await createStatusApi(port, () => {}).get()).body;
    expect(body.restartRequested).toBe(true);
    expect(JSON.stringify(body)).not.toContain("Notiz mit Inhalt");
  });

  test("Neustart-Marker: fehlender Ordner heißt false, andere Lesefehler null statt false", async () => {
    const missing = createBotStatus({}, { ...quiet, restartMarker: join(dir, "fehlt", "data", "restart-requested") });
    expect(await missing.restartRequested()).toBe(false);

    // Ordner statt Datei (EISDIR) und Datei als Elternordner (ENOTDIR): Zustand unbekannt
    const asDir = join(dir, "marker-als-ordner");
    await mkdir(asDir);
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "");
    for (const marker of [asDir, join(blocker, "restart-requested")]) {
      const port = createBotStatus({}, { ...quiet, restartMarker: marker });
      await expect(port.restartRequested()).rejects.toThrow();
      const logs: string[] = [];
      const body = (await createStatusApi(port, l => logs.push(l)).get()).body;
      expect(body.restartRequested).toBeNull();
      expect(logs.some(l => l.includes("Neustart-Marker nicht ermittelbar"))).toBe(true);
    }
  });

  test("Speicher und Zähler aus den übergebenen Quellen", () => {
    const port = createBotStatus(
      { CONVEX_URL: "https://x.convex.cloud" },
      { ...quiet, activeExecutions: () => 3, activeClaudeCalls: () => 2 }
    );
    expect(port.storage()).toBe("convex");
    expect(port.activeExecutions()).toBe(3);
    expect(port.activeClaudeCalls()).toBe(2);
  });
});

test("Schlüssel-Liste deckt die verlangten Anbieter ab", () => {
  const groups = STATUS_KEY_GROUPS.map(g => g.group);
  for (const g of ["Anthropic", "OpenRouter", "OpenAI", "Gemini", "ElevenLabs", "xAI", "Google", "Notion", "Supabase", "Telegram-Agentenbots"]) {
    expect(groups).toContain(g);
  }
});
