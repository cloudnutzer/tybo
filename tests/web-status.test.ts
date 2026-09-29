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
import { writeRecord } from "../src/setup/search-record";

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
  const base = { sessionMode: true, idleMs: 18 * HOUR, modelFor: () => "claude-opus-5-5", engineFor: () => "claude", now: NOW };
  const session = (s: Partial<StoredSession>): StoredSession => ({
    agentName: "general",
    engine: "claude", engineSessionId: "abc",
    model: "claude-opus-5-5",
    lastActivity: NOW - HOUR,
    ...s,
  });

  test("zählt nur Einträge mit Session-ID, in der Frist und mit aktuellem Modell", () => {
    const list = [
      session({}),
      session({ engineSessionId: undefined }),
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

  test("Session eines anderen Motors zählt nicht als fortsetzbar (Issue #122)", () => {
    const list = [session({}), session({ engine: "codex", engineSessionId: "c1" })];
    expect(countResumableSessions(list, base)).toBe(1);
    expect(countResumableSessions(list, { ...base, engineFor: () => "codex" })).toBe(1);
    expect(countResumableSessions(list, { ...base, engineFor: () => "opencode" })).toBe(0);
  });

  test("Motor und Modell je Gespräch (Issue #125)", () => {
    const list = [
      session({ key: "topic:-1:5:general", engine: "codex", engineSessionId: "c1", model: "" }),
      session({ key: "topic:-1:6:general" }),
      session({ key: "topic:-1:7:general", engine: "codex", engineSessionId: "c2", model: "claude-opus-5-5" }),
    ];
    const engineFor = (_a: string, key?: string) => (key === "topic:-1:6" ? "claude" : "codex");
    const modelFor = (_a: string, engine: string) => (engine === "codex" ? "" : "claude-opus-5-5");
    expect(countResumableSessions(list, { ...base, engineFor, modelFor })).toBe(2);
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
    engineFor: () => "claude",
    activeExecutions: () => 0,
    activeClaudeCalls: () => 0,
    restartMarker: join(dir, "kein-marker"),
    requestRestart: async () => {},
    // Nie ein echtes claude oder codex (Issue #126)
    inspectEngine: async (id: "claude" | "codex" | "opencode") => ({ engine: id, checked: true, installed: true, loggedIn: true }),
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
      { agentName: "general", engine: "claude", engineSessionId: "a", model: "claude-opus-5-5", lastActivity: NOW - HOUR },
      { agentName: "general", engine: "claude", engineSessionId: "b", model: "alt", lastActivity: NOW - HOUR },
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

describe("Semantische Suche im Status (Issue #166)", () => {
  const quiet = {
    gitHead: async () => "0fe4c19\n",
    readPackageJson: () => JSON.stringify({ version: "2.12.0" }),
    startedAt: NOW - 60_000,
    detectSupervisor: async () => "launchd" as const,
    listSessions: async () => [],
    sessionMode: () => true,
    idleMs: 18 * HOUR,
    modelFor: () => "claude-opus-5-5",
    engineFor: () => "claude",
    activeExecutions: () => 0,
    activeClaudeCalls: () => 0,
    restartMarker: join(dir, "kein-marker"),
    requestRestart: async () => {},
    // Nie ein echtes claude oder codex (Issue #126)
    inspectEngine: async (id: "claude" | "codex" | "opencode") => ({ engine: id, checked: true, installed: true, loggedIn: true }),
    now: () => NOW,
  };
  const URL_A = "https://abcdefghijklmnopqrst.supabase.co";

  async function record(root: string, url: string, state: "aktiv" | "textsuche") {
    await writeRecord({ root, now: () => new Date(NOW) }, url, state);
  }

  test("API: nur aktiv/textsuche, sonst null; fehlende Methode und Fehler ergeben null", async () => {
    const body = async (port: StatusPort) => (await createStatusApi(port, () => {}).get()).body as any;
    expect((await body(fakePort({ semanticSearch: async () => "aktiv" }))).semanticSearch).toBe("aktiv");
    expect((await body(fakePort({ semanticSearch: async () => "textsuche" }))).semanticSearch).toBe("textsuche");
    expect((await body(fakePort({ semanticSearch: async () => "komisch" as any }))).semanticSearch).toBeNull();
    expect((await body(fakePort())).semanticSearch).toBeNull();
    const logs: string[] = [];
    const failing = fakePort({
      semanticSearch: async () => {
        throw new Error("kaputt /geheim/pfad");
      },
    });
    const res = await createStatusApi(failing, m => logs.push(m)).get();
    expect(res.status).toBe(200);
    expect((res.body as any).semanticSearch).toBeNull();
    expect(logs.join("\n")).not.toContain("geheim");
  });

  test("echte Quelle: aktiv nur mit Nachweis für genau diese Adresse, Convex und ohne Datenbank null", async () => {
    const root = await mkdtemp(join(dir, "suche-"));
    const port = (env: Record<string, string>) => createBotStatus(env, { ...quiet, projectRoot: root });
    // Kein Nachweis: nur Textsuche
    expect(await port({ SUPABASE_URL: URL_A }).semanticSearch!()).toBe("textsuche");
    await record(root, URL_A, "aktiv");
    expect(await port({ SUPABASE_URL: URL_A }).semanticSearch!()).toBe("aktiv");
    expect(await port({ SUPABASE_URL: `${URL_A}/` }).semanticSearch!()).toBe("aktiv");
    // Andere Datenbank: der Nachweis gilt dort nicht
    expect(await port({ SUPABASE_URL: "http://127.0.0.1:54421" }).semanticSearch!()).toBe("textsuche");
    await record(root, URL_A, "textsuche");
    expect(await port({ SUPABASE_URL: URL_A }).semanticSearch!()).toBe("textsuche");
    expect(await port({ CONVEX_URL: "https://x.convex.cloud", SUPABASE_URL: URL_A }).semanticSearch!()).toBeNull();
    expect(await port({}).semanticSearch!()).toBeNull();
    // Kaputte Datei: nicht aktiv
    await writeFile(join(root, "data", "semantic-search.json"), "{kaputt");
    expect(await port({ SUPABASE_URL: URL_A }).semanticSearch!()).toBe("textsuche");
  });

  test("Datei enthält weder Adresse noch Schlüssel", async () => {
    const root = await mkdtemp(join(dir, "suche-"));
    await record(root, URL_A, "aktiv");
    const text = await Bun.file(join(root, "data", "semantic-search.json")).text();
    expect(text).not.toContain("supabase.co");
    // Seit #167 auch Anbieter und Modell (keine Geheimnisse)
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["checkedAt", "model", "provider", "state", "target"]);
  });
});
