/**
 * Push-Schlüssel beim Start (Issue #225, src/web/bot-push.ts) mit einer
 * temporären .env, ohne src/bot.ts: fehlen beide, stehen danach beide in der
 * .env (gültiges Paar), Log nur „Push-Schlüssel erzeugt"; vorhandene bleiben;
 * unvollständige oder ungültige Paare werden nicht ersetzt; gleichzeitiger
 * Start ergibt genau ein Paar; Schreibfehler schaltet Push aus. Dazu:
 * WEB_PUSH_PRIVATE_KEY erbt kein Subprozess, auch nicht über Freigabeliste
 * oder MCP-Verweis.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvContent } from "../src/lib/env-file";
import { filterSubprocessEnv, setMcpReaderForTests, setSubprocessEnvLoggerForTests, subprocessEnv } from "../src/lib/subprocess-env";
import { ensurePushKeys, prepareBotPush, pushSubject } from "../src/web/bot-push";
import { DEFAULT_PUSH_SUBJECT, generateVapidKeys, validateVapidKeys } from "../src/web/push";

const root = await mkdtemp(join(tmpdir(), "tybo-push-keys-"));
let counter = 0;
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function envFile(content: string): Promise<{ envPath: string; backupDir: string; dir: string }> {
  const dir = join(root, `case-${++counter}`);
  await Bun.write(join(dir, ".keep"), "");
  const envPath = join(dir, ".env");
  if (content !== "") await writeFile(envPath, content, { mode: 0o600 });
  return { envPath, backupDir: join(dir, "data", "backups"), dir };
}

async function read(path: string): Promise<Record<string, string>> {
  return parseEnvContent(await readFile(path, "utf8"));
}

describe("ensurePushKeys", () => {
  test("fehlen beide: danach beide als gültiges Paar in der .env, Log ohne Wert, Rest unverändert", async () => {
    const { envPath, backupDir } = await envFile("WEB_ENABLED=true\nWEB_PASSWORD=test-passwort-lang\n");
    const logs: string[] = [];
    const result = await ensurePushKeys({ envPath, backupDir, log: m => logs.push(m) });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.created).toBe(true);
    const env = await read(envPath);
    expect(env.WEB_PUSH_PUBLIC_KEY).toBe(result.keys.publicKey);
    expect(env.WEB_PUSH_PRIVATE_KEY).toBe(result.keys.privateKey);
    expect(env.WEB_PASSWORD).toBe("test-passwort-lang");
    expect(await validateVapidKeys(result.keys)).toBe(true);
    expect(logs).toEqual(["Push-Schlüssel erzeugt"]);
    // Sicherung der alten .env (ohne Schlüssel) nur unter dem angegebenen Ordner
    const backups = await readdir(backupDir);
    expect(backups.length).toBe(1);
    expect(await readFile(join(backupDir, backups[0]), "utf8")).not.toContain("WEB_PUSH_PRIVATE_KEY");
  });

  test("ohne .env: legt sie mit beiden Schlüsseln an", async () => {
    const { envPath, backupDir } = await envFile("");
    const result = await ensurePushKeys({ envPath, backupDir });
    expect(result.status).toBe("ok");
    expect(Object.keys(await read(envPath)).sort()).toEqual(["WEB_PUSH_PRIVATE_KEY", "WEB_PUSH_PUBLIC_KEY"]);
  });

  test("vorhandenes gültiges Paar bleibt, nichts geschrieben", async () => {
    const keys = await generateVapidKeys();
    const content = `WEB_PUSH_PUBLIC_KEY=${keys.publicKey}\nWEB_PUSH_PRIVATE_KEY=${keys.privateKey}\n`;
    const { envPath, backupDir } = await envFile(content);
    const result = await ensurePushKeys({ envPath, backupDir });
    expect(result).toEqual({ status: "ok", keys, created: false });
    expect(await readFile(envPath, "utf8")).toBe(content);
  });

  test("nur einer da oder ungültiges Paar: nicht ersetzen, Push aus", async () => {
    const a = await generateVapidKeys();
    const b = await generateVapidKeys();
    for (const content of [
      `WEB_PUSH_PUBLIC_KEY=${a.publicKey}\n`,
      `WEB_PUSH_PRIVATE_KEY=${a.privateKey}\n`,
      `WEB_PUSH_PUBLIC_KEY=${a.publicKey}\nWEB_PUSH_PRIVATE_KEY=${b.privateKey}\n`,
      `WEB_PUSH_PUBLIC_KEY=kaputt\nWEB_PUSH_PRIVATE_KEY=auch-kaputt\n`,
    ]) {
      const { envPath, backupDir } = await envFile(content);
      const result = await ensurePushKeys({ envPath, backupDir });
      expect(result.status).toBe("invalid");
      expect(await readFile(envPath, "utf8")).toBe(content);
      expect(JSON.stringify(result)).not.toContain(a.privateKey);
    }
  });

  test("gleichzeitiger Start (Bot und Einrichtung): genau ein Paar, beide bekommen dasselbe", async () => {
    const { envPath, backupDir } = await envFile("WEB_ENABLED=true\n");
    const results = await Promise.all([1, 2, 3].map(() => ensurePushKeys({ envPath, backupDir })));
    const pairs = results.map(r => (r.status === "ok" ? r.keys.publicKey : r.status));
    expect(new Set(pairs).size).toBe(1);
    expect(results.filter(r => r.status === "ok" && r.created).length).toBe(1);
    const content = await readFile(envPath, "utf8");
    expect(content.match(/^WEB_PUSH_PUBLIC_KEY=/gm)!.length).toBe(1);
    expect(content.match(/^WEB_PUSH_PRIVATE_KEY=/gm)!.length).toBe(1);
  });

  test("Schreibfehler: Push aus, .env unverändert, kein Wert im Grund", async () => {
    const { envPath, backupDir } = await envFile("WEB_ENABLED=true\n");
    const keys = await generateVapidKeys();
    const result = await ensurePushKeys({
      envPath, backupDir, generate: async () => keys,
      io: { rename: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } },
    });
    expect(result.status).toBe("error");
    expect(await readFile(envPath, "utf8")).toBe("WEB_ENABLED=true\n");
    expect(JSON.stringify(result)).not.toContain(keys.privateKey);
  });
});

describe("prepareBotPush", () => {
  test("WebUI aus: nichts erzeugt, keine .env angelegt", async () => {
    const { envPath } = await envFile("");
    expect(await prepareBotPush({ WEB_ENABLED: "false" }, { envPath, log: () => {} })).toBeNull();
    expect(await Bun.file(envPath).exists()).toBe(false);
  });

  test("WebUI an, Schlüssel fehlen: erzeugt, Kontakt Standard, Log ohne Wert", async () => {
    const { envPath, backupDir } = await envFile("WEB_ENABLED=true\n");
    const logs: string[] = [];
    const push = await prepareBotPush({ WEB_ENABLED: "true" }, { envPath, backupDir, log: m => logs.push(m) });
    expect(push).not.toBeNull();
    expect(push!.subject).toBe(DEFAULT_PUSH_SUBJECT);
    expect((await read(envPath)).WEB_PUSH_PRIVATE_KEY).toBe(push!.keys.privateKey);
    expect(logs.join("\n")).not.toContain(push!.keys.privateKey);
    expect(logs.join("\n")).not.toContain(push!.keys.publicKey);
  });

  test("ungültiges Paar: null mit Hinweis im Log, nichts ersetzt", async () => {
    const a = await generateVapidKeys();
    const content = `WEB_ENABLED=true\nWEB_PUSH_PUBLIC_KEY=${a.publicKey}\n`;
    const { envPath } = await envFile(content);
    const logs: string[] = [];
    expect(await prepareBotPush({ WEB_ENABLED: "true", WEB_PUSH_PUBLIC_KEY: a.publicKey }, { envPath, log: m => logs.push(m) })).toBeNull();
    expect(logs.join("\n")).toContain("Push aus");
    expect(await readFile(envPath, "utf8")).toBe(content);
  });

  test("Kontakt: mailto:/https: gilt, anderes fällt mit Log auf den Standard", () => {
    const logs: string[] = [];
    expect(pushSubject({ WEB_PUSH_SUBJECT: "mailto:alex@example.org" })).toBe("mailto:alex@example.org");
    expect(pushSubject({ WEB_PUSH_SUBJECT: "alex@example.org" }, m => logs.push(m))).toBe(DEFAULT_PUSH_SUBJECT);
    expect(logs.length).toBe(1);
    expect(DEFAULT_PUSH_SUBJECT).toStartWith("https://");
  });
});

describe("Subprozesse", () => {
  afterEach(() => {
    setMcpReaderForTests(null);
    setSubprocessEnvLoggerForTests(null);
  });

  test("WEB_PUSH_PRIVATE_KEY fehlt in subprocessEnv(), auch mit Freigabeliste und MCP-Verweis, bei jedem Motor", async () => {
    const keys = await generateVapidKeys();
    const lines: string[] = [];
    setSubprocessEnvLoggerForTests(l => lines.push(l));
    setMcpReaderForTests(() => new Set(["WEB_PUSH_PRIVATE_KEY"]));
    const env = {
      HOME: "/tmp/niemand",
      PATH: "/usr/bin",
      WEB_PUSH_PUBLIC_KEY: keys.publicKey,
      WEB_PUSH_PRIVATE_KEY: keys.privateKey,
      TYBO_SUBPROCESS_ENV_ALLOW: "WEB_PUSH_PRIVATE_KEY",
    };
    for (const engine of ["claude", "codex", "opencode"] as const) {
      const out = subprocessEnv({ env, engine, cwd: root, home: "/tmp/niemand" });
      expect(out.WEB_PUSH_PRIVATE_KEY).toBeUndefined();
      expect(Object.values(out).join("\n")).not.toContain(keys.privateKey);
      expect(filterSubprocessEnv({ env, engine, cwd: root, home: "/tmp/niemand" }).removed).toContain("WEB_PUSH_PRIVATE_KEY");
    }
    // Nur Namen im Log, nie Werte
    expect(lines.join("\n")).toContain("WEB_PUSH_PRIVATE_KEY");
    expect(lines.join("\n")).not.toContain(keys.privateKey);
  });
});

describe("Verdrahtung", () => {
  test("startWebUi reicht push an createServer weiter", async () => {
    const { startWebUi } = await import("../src/web/startup");
    const push = { keys: await generateVapidKeys(), subject: DEFAULT_PUSH_SUBJECT };
    let received: { push?: unknown } | null = null;
    await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: "test-passwort-lang" },
      chat: { runTurn: async () => ({ text: "" }), stop() {} },
      push,
      createServer: async (_config, deps) => {
        received = deps;
        return { url: "http://127.0.0.1:3100", eventStreamCount: () => 0, stop: async () => {} } as never;
      },
      log: () => {},
      lanAddresses: () => [],
    });
    expect(received!.push).toBe(push);
  });

  test("src/bot.ts (nur als Text) übergibt prepareBotPush(process.env) an startWebUi", async () => {
    const bot = await Bun.file(join(import.meta.dir, "..", "src", "bot.ts")).text();
    expect(bot).toContain('import { prepareBotPush } from "./web/bot-push";');
    const start = bot.indexOf("webServer = await startWebUi({");
    const end = bot.indexOf("\n});", start);
    expect(bot.slice(start, end)).toContain("push: (await prepareBotPush(process.env)) ?? undefined,");
  });
});
