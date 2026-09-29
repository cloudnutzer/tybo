import { test, expect, describe } from "bun:test";
import { createStatusApi, keyStatus, STATUS_KEY_GROUPS } from "../src/web/status";
import { createBotStatus } from "../src/web/bot-status";
import { AGENT_TOKEN_MAP } from "../src/lib/bot-registry";

// Erfundene Werte, keine echten Schlüssel. Jeder ist lang und eindeutig genug,
// dass er zufällig nirgends sonst in der Antwort stehen kann.
const SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-test-A1b2C3d4E5f6G7h8",
  OPENROUTER_API_KEY: "sk-or-test-Z9y8X7w6V5u4",
  GOOGLE_CLIENT_SECRET: "gcs-test-Q1w2E3r4T5y6",
  SUPABASE_URL: "https://testprojekt-qq11.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "eyJ-test-service-role-M1n2B3v4",
  TELEGRAM_BOT_TOKEN_RESEARCH: "111222333:AAtest-research-K9j8H7",
};
const NOT_LISTED: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "444555666:AAtest-main-P0o9I8",
  WEB_PASSWORD: "test-web-passwort-L5k4J3",
  DEPLOY_SECRET: "test-deploy-secret-U7i8O9",
};

const quiet = {
  gitHead: async () => "0fe4c19",
  readPackageJson: () => '{"version":"2.12.0"}',
  startedAt: 0,
  detectSupervisor: async () => null,
  listSessions: async () => [],
  sessionMode: () => false,
  idleMs: 1,
  modelFor: () => "m",
  activeExecutions: () => 0,
  activeClaudeCalls: () => 0,
  restartMarker: "/nicht/vorhanden/restart-requested",
  requestRestart: async () => {},
  // Nie ein echtes claude oder codex (Issue #126)
  inspectEngine: async (id: "claude" | "codex" | "opencode") => ({ engine: id, checked: true, installed: true, loggedIn: true }),
  now: () => 1000,
};

describe("Schlüssel nur als ja/nein", () => {
  test("gesetzte Schlüssel set: true, fehlende set: false, nur Name, Gruppe und set", () => {
    const keys = keyStatus({ ...SECRETS, OPENAI_API_KEY: "   " });
    const byName = Object.fromEntries(keys.map(k => [k.name, k]));
    for (const name of Object.keys(SECRETS)) expect(byName[name].set).toBe(true);
    expect(byName.OPENAI_API_KEY.set).toBe(false); // nur Leerzeichen zählt nicht
    expect(byName.NOTION_TOKEN.set).toBe(false);
    expect(byName.TELEGRAM_BOT_TOKEN_CRITIC.set).toBe(false);
    for (const k of keys) expect(Object.keys(k).sort()).toEqual(["group", "name", "set"]);
  });

  test("nur Namen aus der Liste, nie WEB_*, Haupt-Token oder andere Variablen", () => {
    const names = keyStatus({ ...SECRETS, ...NOT_LISTED }).map(k => k.name);
    for (const name of Object.keys(NOT_LISTED)) expect(names).not.toContain(name);
    expect(names.some(n => n.startsWith("WEB_"))).toBe(false);
  });

  test("Liste enthält Google-OAuth und alle Agentenbots aus bot-registry", () => {
    const names = STATUS_KEY_GROUPS.flatMap(g => g.names);
    for (const n of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) expect(names).toContain(n);
    const agentBots = STATUS_KEY_GROUPS.find(g => g.group === "Telegram-Agentenbots")!.names;
    expect([...agentBots].sort()).toEqual(Object.values(AGENT_TOKEN_MAP).sort());
    expect(new Set(names).size).toBe(names.length);
  });

  test("gesamte Status-Antwort enthält keinen Wert, auch keine Teile davon", async () => {
    const env = { ...SECRETS, ...NOT_LISTED, CONVEX_URL: "https://test-deployment-zz99.convex.cloud" };
    const api = createStatusApi(createBotStatus(env, quiet), () => {});
    const { body } = await api.get();
    const serialized = JSON.stringify(body);
    for (const value of Object.values(env)) {
      expect(serialized).not.toContain(value);
      // Auch kein Wertende (Anzeige der letzten vier Zeichen kommt erst mit M6)
      expect(serialized).not.toContain(value.slice(-6));
    }
    const keys = body.keys as Array<{ name: string; set: boolean }>;
    expect(keys.find(k => k.name === "ANTHROPIC_API_KEY")!.set).toBe(true);
    expect(keys.find(k => k.name === "ELEVENLABS_API_KEY")!.set).toBe(false);
    expect(body.storage).toBe("convex");
  });

  test("ein Port, der Werte mitschickt, kommt trotzdem nur mit name, group und set durch", async () => {
    const leaky = createBotStatus({}, quiet);
    leaky.keys = () => [{ name: "ANTHROPIC_API_KEY", group: "Anthropic", set: true, value: SECRETS.ANTHROPIC_API_KEY } as any];
    const { body } = await createStatusApi(leaky, () => {}).get();
    expect(JSON.stringify(body)).not.toContain(SECRETS.ANTHROPIC_API_KEY);
  });
});
