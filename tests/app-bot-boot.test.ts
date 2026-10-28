// Issue #344: erster Schritt des Bots als Verhalten (ersetzt die
// Quelltext-Prüfungen zur Reihenfolge in src/bot.ts: .env, Log-Hinweise,
// Einrichtungsmodus). bot.ts wird nie importiert.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { bootBot, profileFromArgs, type BootDeps } from "../src/app/bot-boot";
import { resolveRuntimeProfile } from "../src/lib/runtime-profile";
import { chooseStartMode } from "../src/setup/start-mode";
import { defaultEnvPath } from "../src/web/bot-keys";

function setup(env: Record<string, string | undefined>, overrides: Partial<BootDeps> = {}) {
  const calls: string[] = [];
  const deps: BootDeps = {
    root: "/srv/tybo",
    env,
    loadEnv: async path => void calls.push(`loadEnv ${path}`),
    logCapacity: () => void calls.push("capacity"),
    logSubprocessEnv: () => void calls.push("subprocess"),
    logLegacyDatabase: () => void calls.push("legacy"),
    chooseStartMode: e => (calls.push("mode"), chooseStartMode(e)),
    runSetup: async mode => (calls.push(`setup ${mode.reason}`), 3),
    exit: code => void calls.push(`exit ${code}`),
    ...overrides,
  };
  return { deps, calls };
}

const WEB_ONLY = { WEB_ENABLED: "true", WEB_PASSWORD: "passwort-fuer-den-test" };

describe("bootBot", () => {
  test("lädt .env aus dem Projektordner, dann je einmal Grenze, Subprozess-Filter, alte Datenbank, dann der Modus", async () => {
    const s = setup(WEB_ONLY);
    expect(await bootBot(s.deps)).toBe(true);
    expect(s.calls).toEqual([`loadEnv ${join("/srv/tybo", ".env")}`, "capacity", "subprocess", "legacy", "mode"]);
  });

  test("der Modus sieht die geladene .env", async () => {
    const env: Record<string, string | undefined> = {};
    const s = setup(env, { loadEnv: async () => void Object.assign(env, WEB_ONLY) });
    expect(await bootBot(s.deps)).toBe(true);
    expect(s.calls).not.toContain("setup missing");
  });

  test("ohne Kanal: Einrichtungsmodus, dann exit mit seinem Code; kein FATAL je Schlüssel", async () => {
    const s = setup({});
    expect(await bootBot(s.deps)).toBe(false);
    expect(s.calls.slice(-2)).toEqual(["setup missing", "exit 3"]);
  });

  test("halbes Telegram startet ebenfalls nur den Einrichtungsmodus", async () => {
    const s = setup({ TELEGRAM_BOT_TOKEN: "123:abc" });
    expect(await bootBot(s.deps)).toBe(false);
  });

  test("Schreibpfad der Schlüssel-Seite = Ladepfad des Bots", () => {
    // bot.ts übergibt process.cwd() als root
    expect(defaultEnvPath()).toBe(join(process.cwd(), ".env"));
  });
});

// Issue #352: bun run vps startet bot.ts im Server-Profil. Die .env
// überschreibt Prozessvariablen, deshalb kommt das Profil über die Befehlszeile
describe("Profil aus der Befehlszeile", () => {
  const SECRET = "webhook-secret-fuer-tests_0123456789";
  const SERVER_ENV = { ...WEB_ONLY, TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_USER_ID: "4242", TELEGRAM_WEBHOOK_SECRET: SECRET };

  test("profileFromArgs: beide Schreibweisen, ohne Option null, ohne Wert leer", () => {
    expect(profileFromArgs([])).toBeNull();
    expect(profileFromArgs(["--verbose"])).toBeNull();
    expect(profileFromArgs(["--profile", "server"])).toBe("server");
    expect(profileFromArgs(["--profile=server"])).toBe("server");
    expect(profileFromArgs(["--profile", "local", "--profile=server"])).toBe("server");
    expect(profileFromArgs(["--profile"])).toBe("");
    expect(profileFromArgs(["--profile", "--weiter"])).toBe("");
    expect(profileFromArgs(["--profile="])).toBe("");
  });

  test("--profile server schlägt TYBO_PROFILE=local aus der .env, mit Logzeile", async () => {
    const env: Record<string, string | undefined> = { TYBO_PROFILE: "server" };
    const logs: string[] = [];
    const s = setup(env, {
      // .env lädt nach dem Start und überschreibt, was vorher im Prozess stand
      loadEnv: async () => void Object.assign(env, SERVER_ENV, { TYBO_PROFILE: "local" }),
      args: ["--profile", "server"],
      log: message => void logs.push(message),
    });
    expect(await bootBot(s.deps)).toBe(true);
    expect(env.TYBO_PROFILE).toBe("server");
    expect(logs).toEqual(["[start] Profil server aus der Befehlszeile, TYBO_PROFILE=local aus der .env gilt nicht"]);
    const profile = resolveRuntimeProfile(env);
    expect(profile.ok && profile.profile.telegram.mode).toBe("webhook");
  });

  test("ohne Option bleibt TYBO_PROFILE aus der .env, keine Logzeile", async () => {
    const env: Record<string, string | undefined> = {};
    const logs: string[] = [];
    const s = setup(env, { loadEnv: async () => void Object.assign(env, WEB_ONLY, { TYBO_PROFILE: "local" }), log: m => void logs.push(m) });
    expect(await bootBot(s.deps)).toBe(true);
    expect(env.TYBO_PROFILE).toBe("local");
    expect(logs).toEqual([]);
  });

  test("--profile ohne Wert: Abbruch mit exit 1 vor allem anderen, nie stillschweigend local", async () => {
    const logs: string[] = [];
    const s = setup({ ...WEB_ONLY }, { args: ["--profile"], log: m => void logs.push(m) });
    expect(await bootBot(s.deps)).toBe(false);
    expect(s.calls).toEqual([`loadEnv ${join("/srv/tybo", ".env")}`, "exit 1"]);
    expect(logs[0]).toContain("--profile ohne Wert");
  });

  test("Server-Profil ohne Secret: kein Telegram-Eingang, kein Polling", async () => {
    const env: Record<string, string | undefined> = {};
    const s = setup(env, { loadEnv: async () => void Object.assign(env, WEB_ONLY), args: ["--profile", "server"], log: () => {} });
    expect(await bootBot(s.deps)).toBe(true);
    expect(resolveRuntimeProfile(env)).toMatchObject({ ok: false, name: "server" });
  });

  test("bun run vps startet bot.ts mit --profile server", () => {
    const scripts = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).scripts;
    expect(scripts.vps).toBe("bun run src/bot.ts --profile server");
    const args = scripts.vps.split(" ").slice(3);
    expect(profileFromArgs(args)).toBe("server");
  });
});
