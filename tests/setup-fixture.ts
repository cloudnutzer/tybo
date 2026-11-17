/**
 * Hilfen für die Einrichtungstests (Issue #64): jeder Fall bekommt einen
 * eigenen temporären Projektordner mit .env, config/, data/backups und
 * LaunchAgents und dump.pm2. Befehle und Anbieter sind Attrappen; nichts geht ins Netz,
 * nichts startet launchctl oder PM2, die echte .env bleibt unberührt.
 */

import type { CallProbeResult } from "../src/web/call-probe";
import { DeviceProbeError, type CallSetupDeps, type DeviceStage } from "../src/setup/speech-call";
import { callWays, type CallWay } from "../src/lib/voice-brain/call-model";
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
  /** Convex-Werte aus früheren Versionen: zählen seit Issue #324 nicht, dürfen aber nie auftauchen */
  legacyDbUrl: "https://happy-otter-123.convex.cloud",
  legacyDbToken: "convex-test-token-geheim-9876",
  supabaseUrl: "https://abcdefgh.supabase.co",
  serviceKey: "sb-service-test-key-geheim-5555",
  anonKey: "sb-anon-test-key-geheim-6666",
  openrouterKey: "sk-or-test-key-geheim-7777",
  webPassword: "sehr-geheimes-passwort-1",
};

/** Selbst eingetragenes Supabase (Weg „supabase“, nicht *.supabase.co) */
export const SELF_DB_URL = "https://db.example.org";

export const FULL_ENV = [
  "# Kommentar bleibt",
  `TELEGRAM_BOT_TOKEN=${FAKE.token}`,
  `TELEGRAM_USER_ID=${FAKE.userId}`,
  `TELEGRAM_GROUP_ID=${FAKE.groupId}`,
  `SUPABASE_URL=${FAKE.supabaseUrl}`,
  `SUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}`,
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
    supabaseWriteProbe: make("supabaseWriteProbe", { ok: true, message: "Schreibprobe bestanden." }),
    claudeVersion: make("claudeVersion", { ok: true, message: "Claude CLI 2.1.300" }),
    claudeProbe: make("claudeProbe", { ok: true, message: "Claude CLI ist angemeldet und antwortet." }),
    engineCheck: make("engineCheck", { ok: true, message: "Codex 0.155.1 ist angemeldet." }),
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
    if (!key) return { code: -1, stdout: "", stderr: "Befehl nicht gefunden", spawnError: "ENOENT" };
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
    // systemd nur im Testordner; ohne diesen Ordner gilt: kein systemd (Issue #207)
    systemdUserDir: join(dir, "home", ".config", "systemd", "user"),
    systemdRunDir: join(dir, "run", "systemd", "system"),
    user: "alex",
    run,
    // Kein Netz in Tests (Issue #163): wer fetch braucht, setzt eine Attrappe
    fetch: async () => {
      throw new Error("Kein Netz in Tests");
    },
    providers,
    now: () => new Date("2026-09-25T10:00:00Z"),
    // Nichts wartet echt (Issue #161); Tests mit Abbruch setzen eine eigene Attrappe
    sleep: async () => {},
    // Telefonhörer (Issue #260): Wege nur aus .env und Einstellungen, nie Claude Code, Ollama oder ein Modell
    callSetup: testCallSetup(),
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

export const SECRETS = [FAKE.token, FAKE.legacyDbToken, FAKE.serviceKey, FAKE.anonKey, FAKE.openrouterKey, FAKE.webPassword];

/** Geheimnisse, die im Ergebnis auftauchen; erwartet wird immer [] */
export function leakedSecrets(value: unknown): string[] {
  const text = allText(value);
  return SECRETS.filter(s => text.includes(s));
}

/** Geräteprobe in Tests: Stufenzeiten auf einer Attrappen-Uhr, wahlweise Fehler in einer Stufe */
export interface TestDevice {
  prepareMs?: number;
  recognizeMs?: number;
  answerMs?: number;
  toneMs?: number;
  /** Erkannter Text der Probe-Aufnahme */
  heard?: string;
  /** Erster Abschnitt der Antwort */
  first?: string;
  /** Diese Stufe wirft */
  fail?: DeviceStage;
  /** Diese Stufe hängt, bis das Signal abbricht */
  hang?: DeviceStage;
}

/** Was die Geräteprobe-Attrappe gesehen hat: Aufrufe in Reihenfolge mit Eingaben */
export interface DeviceLog {
  setups: Array<{ way: string; stt: string; pocket: boolean }>;
  steps: Array<[string, string?]>;
  closed: number;
}

/**
 * Telefonhörer in der Einrichtung (Issue #260): echte Auflösung der Wege mit
 * Attrappen für Claude Code (nicht installiert, außer cli: true) und Ollama
 * (läuft nicht); die Probe ruft nie ein Modell, sondern liefert probe. Die
 * Geräteprobe durchläuft die echten Stufen (runDeviceProbe) mit Attrappen
 * für Erkenner, Gehirn und Stimme und einer Attrappen-Uhr.
 */
export function testCallSetup(
  o: { cli?: boolean; ollama?: boolean; probe?: CallProbeResult | ((way: CallWay) => CallProbeResult); device?: TestDevice } = {},
): CallSetupDeps & { probes: CallWay[]; deviceLog: DeviceLog } {
  const probes: CallWay[] = [];
  const log: DeviceLog = { setups: [], steps: [], closed: 0 };
  const d = o.device ?? {};
  let clock = 0;
  const stage = async (name: DeviceStage, ms: number, signal: AbortSignal) => {
    if (d.hang === name) {
      await new Promise<void>(resolve => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
      throw new Error("abgebrochen");
    }
    clock += ms;
    if (d.fail === name) throw new DeviceProbeError(`Attrappe ${name} gescheitert`);
  };
  return {
    probes,
    deviceLog: log,
    now: () => clock,
    ways: ({ env, settings }) =>
      callWays({
        env,
        settings,
        inspectClaude: async () =>
          o.cli
            ? { engine: "claude", checked: true, installed: true, loggedIn: true }
            : { engine: "claude", checked: true, installed: false, loggedIn: false, message: "Claude Code ist nicht installiert" },
        cliFlags: async () => ({ missing: [] }),
        ollamaCheck: async () => (o.ollama ? null : "Ollama läuft nicht (ollama serve starten)"),
      }),
    probe: async ({ way }) => {
      probes.push(way);
      if (!o.probe) return { ok: false, reason: "In Tests gibt es keine Probe." };
      return typeof o.probe === "function" ? o.probe(way) : o.probe;
    },
    device: ({ way, stt, pocket }) => {
      log.setups.push({ way: way.id, stt, pocket });
      return {
        prepare: async signal => {
          log.steps.push(["laden"]);
          await stage("laden", d.prepareMs ?? 2_000, signal);
        },
        recognize: async signal => {
          log.steps.push(["erkennen"]);
          await stage("erkennen", d.recognizeMs ?? 300, signal);
          return d.heard ?? "Wie wird das Wetter morgen?";
        },
        answer: async (text, signal) => {
          log.steps.push(["antwort", text]);
          await stage("antwort", d.answerMs ?? 1_400, signal);
          return d.first ?? "Morgen wird es sonnig.";
        },
        ...(pocket
          ? {
              speak: async (text: string, signal: AbortSignal) => {
                log.steps.push(["stimme", text]);
                await stage("stimme", d.toneMs ?? 120, signal);
              },
            }
          : {}),
        close: () => void log.closed++,
      };
    },
  };
}
