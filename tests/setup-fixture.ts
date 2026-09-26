/**
 * Hilfen für die Einrichtungstests (Issue #64): jeder Fall bekommt einen
 * eigenen temporären Projektordner mit .env, config/, data/backups und
 * LaunchAgents und dump.pm2. Befehle und Anbieter sind Attrappen; nichts geht ins Netz,
 * nichts startet launchctl oder PM2, die echte .env bleibt unberührt.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunner, SetupContext } from "../src/setup/context";
import type { ProbeResult, Providers } from "../src/setup/providers";

export const root = await mkdtemp(join(tmpdir(), "tybo-setup-"));
export const cleanup = () => rm(root, { recursive: true, force: true });

/** Gültig aussehende Testwerte, keine echten Zugangsdaten */
export const FAKE = {
  token: "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn",
  userId: "424242",
  groupId: "-1001234567890",
  convexUrl: "https://happy-otter-123.convex.cloud",
  convexToken: "convex-test-token-geheim-9876",
  supabaseUrl: "https://abcdefgh.supabase.co",
  serviceKey: "sb-service-test-key-geheim-5555",
  anonKey: "sb-anon-test-key-geheim-6666",
  openrouterKey: "sk-or-test-key-geheim-7777",
  webPassword: "sehr-geheimes-passwort-1",
};

export const FULL_ENV = [
  "# Kommentar bleibt",
  `TELEGRAM_BOT_TOKEN=${FAKE.token}`,
  `TELEGRAM_USER_ID=${FAKE.userId}`,
  `TELEGRAM_GROUP_ID=${FAKE.groupId}`,
  `CONVEX_URL=${FAKE.convexUrl}`,
  `CONVEX_AUTH_TOKEN=${FAKE.convexToken}`,
  "USER_NAME=Testperson",
  "USER_TIMEZONE=Europe/Berlin",
  `OPENROUTER_API_KEY=${FAKE.openrouterKey}`,
  "WEB_ENABLED=true",
  `WEB_PASSWORD=${FAKE.webPassword}`,
  "",
].join("\n");

export interface Call {
  method: string;
  args: unknown[];
}

export type FakeProviders = Providers & { calls: Call[]; results: Partial<Record<keyof Providers, ProbeResult & Record<string, unknown>>> };

/** Anbieter-Attrappe: standardmäßig alles ok, einzelne Ergebnisse überschreibbar */
export function fakeProviders(results: FakeProviders["results"] = {}): FakeProviders {
  const calls: Call[] = [];
  const make =
    (method: keyof Providers, fallback: ProbeResult & Record<string, unknown>) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return (results[method] ?? fallback) as any;
    };
  return {
    calls,
    results,
    telegramGetMe: make("telegramGetMe", { ok: true, message: "Verbunden mit @test_bot", username: "test_bot" }),
    telegramSendTest: make("telegramSendTest", { ok: true, message: "Testnachricht verschickt." }),
    telegramCheckGroup: make("telegramCheckGroup", { ok: true, message: "Forum-Gruppe gefunden, der Bot ist Admin." }),
    supabaseQuery: make("supabaseQuery", { ok: true, message: "Supabase erreichbar." }),
    convexQuery: make("convexQuery", { ok: true, message: "Convex erreichbar." }),
    claudeVersion: make("claudeVersion", { ok: true, message: "Claude CLI 2.1.300" }),
    claudeProbe: make("claudeProbe", { ok: true, message: "Claude CLI ist angemeldet und antwortet." }),
    openrouterKey: make("openrouterKey", { ok: true, message: "OpenRouter nimmt den Schlüssel an." }),
    ollamaTags: make("ollamaTags", { ok: true, message: "Ollama läuft.", models: ["qwen3:8b"] }),
  };
}

export type FakeRun = CommandRunner & { calls: string[][] };

/** Befehls-Attrappe: Antwort nach dem Befehlsanfang, sonst Fehler (nicht gefunden) */
export function fakeRun(answers: Record<string, Partial<CommandResult>> = {}): FakeRun {
  const calls: string[][] = [];
  const run = (async (cmd: string[]) => {
    calls.push(cmd);
    const key = Object.keys(answers)
      .sort((a, b) => b.length - a.length)
      .find(k => cmd.join(" ").startsWith(k));
    if (!key) return { code: -1, stdout: "", stderr: "Befehl nicht gefunden" };
    return { code: 0, stdout: "", stderr: "", ...answers[key] };
  }) as FakeRun;
  run.calls = calls;
  return run;
}

let counter = 0;

/** Kontext in einem frischen Ordner; env: Inhalt der .env (undefined: keine Datei) */
export async function makeCtx(
  options: { env?: string; profile?: string; settings?: string; overrides?: Partial<SetupContext> } = {},
): Promise<SetupContext & { providers: FakeProviders; run: FakeRun }> {
  const dir = join(root, `case-${++counter}`);
  await mkdir(join(dir, "config"), { recursive: true });
  await mkdir(join(dir, "launchd"), { recursive: true });
  const envPath = join(dir, ".env");
  if (options.env !== undefined) await writeFile(envPath, options.env, { mode: 0o600 });
  const profilePath = join(dir, "config", "profile.md");
  if (options.profile !== undefined) await writeFile(profilePath, options.profile);
  const settingsPath = join(dir, "config", "settings.json");
  if (options.settings !== undefined) await writeFile(settingsPath, options.settings);
  const providers = fakeProviders();
  const run = fakeRun({ "git --version": { stdout: "git version 2.50.0" } });
  const ctx = {
    root: dir,
    envPath,
    backupDir: join(dir, "data", "backups"),
    profilePath,
    settingsPath,
    home: join(dir, "home"),
    platform: "darwin" as NodeJS.Platform,
    bunVersion: "1.3.12",
    launchAgentsDir: join(dir, "home", "Library", "LaunchAgents"),
    // Ausdrücklich im Testordner, nie PM2_HOME oder ~/.pm2 des Rechners
    pm2DumpPath: join(dir, "home", ".pm2", "dump.pm2"),
    run,
    // Kein Netz in Tests (Issue #163): wer fetch braucht, setzt eine Attrappe
    fetch: async () => {
      throw new Error("Kein Netz in Tests");
    },
    providers,
    now: () => new Date("2026-09-25T10:00:00Z"),
    // Nichts wartet echt (Issue #161); Tests mit Abbruch setzen eine eigene Attrappe
    sleep: async () => {},
    ...options.overrides,
  };
  return ctx as SetupContext & { providers: FakeProviders; run: FakeRun };
}

export async function backupsOf(ctx: SetupContext): Promise<string[]> {
  try {
    return (await readdir(ctx.backupDir)).sort();
  } catch {
    return [];
  }
}

/** Alle Texte eines Ergebnisses, um auf durchgerutschte Geheimnisse zu prüfen */
export function allText(value: unknown): string {
  return JSON.stringify(value);
}

export const SECRETS = [FAKE.token, FAKE.convexToken, FAKE.serviceKey, FAKE.anonKey, FAKE.openrouterKey, FAKE.webPassword];

/** Geheimnisse, die im Ergebnis auftauchen; erwartet wird immer [] */
export function leakedSecrets(value: unknown): string[] {
  const text = allText(value);
  return SECRETS.filter(s => text.includes(s));
}
