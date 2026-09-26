/**
 * Issue #59, Schritt 4: Einstieg `tybo` (scripts/tybo.ts). Läuft als
 * eigener Prozess aus einem fremden Arbeitsverzeichnis gegen isolierte
 * Attrappen: Projektordner per TYBO_ROOT in einem temporären Ordner, ein
 * echter Web-Server nur hier im Test. src/bot.ts wird nie gestartet.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDemoTelegram } from "../src/web/demo";
import { createWebServer, type WebServer } from "../src/web/server";
import { parseEnvFile, runTybo, startHint } from "../scripts/tybo";
import { oldLaunchdLabel } from "./old-names";

const PASSWORD = "test-passwort-lang";
const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "tybo.ts");
const base = await mkdtemp(join(tmpdir(), "tybo-"));
/** Fremdes Arbeitsverzeichnis mit eigener .env, die tybo nicht lesen darf */
const foreign = join(base, "anderswo");
await mkdir(foreign, { recursive: true });
await writeFile(join(foreign, ".env"), "WEB_ENABLED=true\nWEB_PASSWORD=falsches-passwort-123\nWEB_PORT=1\n");
const home = join(base, "home");
await mkdir(home, { recursive: true });
let counter = 0;
const servers: WebServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});
afterAll(() => rm(base, { recursive: true, force: true }));

/** Ein Port, auf dem gerade niemand lauscht */
function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function fakeRoot(env: string): Promise<string> {
  const root = join(base, `projekt-${++counter}`);
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, ".env"), env);
  return root;
}

function enabledEnv(port: number, extra = ""): string {
  return `WEB_ENABLED=true\nWEB_PASSWORD=${PASSWORD}\nWEB_PORT=${port}\n${extra}`;
}

async function run(args: string[], root: string | null, cmd: string[] = ["bun", "--no-env-file", SCRIPT]) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home };
  if (root) env.TYBO_ROOT = root;
  const proc = Bun.spawn([...cmd, ...args], { cwd: foreign, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

async function startServer(root: string, withToken = true): Promise<WebServer> {
  const dir = join(base, `server-${++counter}`);
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "sessions.json"),
      dataDir: join(dir, "web"),
      cliTokenFile: withToken ? join(root, "data", "cli-token") : undefined,
      telegram: createDemoTelegram(Date.now(), { seed: true }),
      log: () => {},
    }
  );
  servers.push(server);
  return server;
}

describe("tybo ohne laufenden Bot", () => {
  test("Exit-Code ≠ 0 und „tybo läuft nicht. Starten mit …“ mit dem Projektordner", async () => {
    const root = await fakeRoot(enabledEnv(freePort()));
    const r = await run([], root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`tybo läuft nicht. Starten mit: cd ${root} && bun run start`);
    expect(r.stdout).toBe("");
  });

  test("macOS mit eingerichtetem Dienst: Startbefehl ist launchctl load", async () => {
    const svcHome = join(base, `home-${++counter}`);
    await mkdir(join(svcHome, "Library", "LaunchAgents"), { recursive: true });
    // Issue #142: eine Plist unter dem früheren Namen zählt nicht
    await writeFile(join(svcHome, "Library", "LaunchAgents", `${oldLaunchdLabel("telegram-relay")}.plist`), "<plist/>");
    expect(startHint("/projekt", "darwin", svcHome)).toBe("cd /projekt && bun run start");
    const plist = join(svcHome, "Library", "LaunchAgents", "ai.tybo.telegram-relay.plist");
    await writeFile(plist, "<plist/>");
    expect(startHint("/projekt", "darwin", svcHome)).toBe(`launchctl load ${plist}`);
    expect(startHint("/projekt", "linux", svcHome)).toBe("cd /projekt && bun run start");
    expect(startHint("/projekt", "darwin", home)).toBe("cd /projekt && bun run start");
  });

  test("Bot-Prozess läuft (bot.lock), WebUI antwortet nicht: kein „läuft nicht“", async () => {
    const root = await fakeRoot(enabledEnv(freePort()));
    await writeFile(join(root, "bot.lock"), String(process.pid));
    const r = await run([], root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Der Bot läuft, aber die WebUI antwortet nicht");
    expect(r.stderr).not.toContain("läuft nicht. Starten");
  });

  test("WebUI aus: eigene Meldung statt „läuft nicht“", async () => {
    const root = await fakeRoot("TELEGRAM_USER_ID=1\n");
    const r = await run([], root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("WEB_ENABLED ist nicht true");
    expect(r.stderr).not.toContain("läuft nicht");
  });

  test("WEB_HOST auf fester Heimnetz-Adresse: Hinweis, dass tybo 127.0.0.1 braucht", async () => {
    const root = await fakeRoot(enabledEnv(freePort(), "WEB_HOST=192.168.1.20\n"));
    const r = await run([], root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("lauscht nur auf 192.168.1.20");
  });
});

describe("tybo mit laufendem Server", () => {
  test("gültiger Schlüssel: Chat im Direktchat, ohne Eingabe Exit 0 (Issue #60)", async () => {
    const root = await fakeRoot("");
    const server = await startServer(root);
    await writeFile(join(root, ".env"), enabledEnv(Number(new URL(server.url).port)));
    const r = await run([], root);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe("tybo · Direktchat · Agent General");
  });

  test("Schlüsseldatei fehlt: eigene Meldung, nicht „läuft nicht“", async () => {
    const root = await fakeRoot("");
    const server = await startServer(root, false);
    await writeFile(join(root, ".env"), enabledEnv(Number(new URL(server.url).port)));
    const r = await run([], root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("es gibt keinen lokalen Schlüssel");
    expect(r.stderr).not.toContain("läuft nicht");
  });

  test("veralteter Schlüssel: eigene Meldung, nicht „läuft nicht“", async () => {
    const root = await fakeRoot("");
    const server = await startServer(root, false);
    await writeFile(join(root, ".env"), enabledEnv(Number(new URL(server.url).port)));
    await writeFile(join(root, "data", "cli-token"), "A".repeat(43));
    const r = await run([], root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("gilt nicht (mehr)");
    expect(r.stderr).not.toContain("A".repeat(43));
  });
});

describe("Unterbefehle und Einstieg", () => {
  test("help: Exit 0; setup mit unbekanntem Schritt: Exit 2 (Issue #65); unbekannt: Exit 2", async () => {
    const root = await fakeRoot("");
    const help = await run(["help"], root);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("tybo setup");
    // Scheitert an den Argumenten, bevor irgendein Befehl oder Anbieter läuft
    const setup = await run(["setup", "quatsch"], root);
    expect(setup.code).toBe(2);
    expect(setup.stderr).toContain("Unbekannter Aufruf: tybo setup quatsch");
    expect(setup.stderr).toContain("tybo setup --liste");
    const unknown = await run(["quatsch"], root);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Unbekannter Befehl: quatsch");
  });

  test("ausführbar mit Bun-Shebang ohne .env des Arbeitsverzeichnisses, direkt aufrufbar", async () => {
    expect((await Bun.file(SCRIPT).text()).startsWith("#!/usr/bin/env -S bun --no-env-file\n")).toBe(true);
    expect((await stat(SCRIPT)).mode & 0o111).not.toBe(0);
    const r = await run(["help"], await fakeRoot(""), [SCRIPT]);
    expect(r.code).toBe(0);
  });

  test("package.json: nur bin tybo, bun run tybo und bun run setup (Issue #100, #142)", async () => {
    const pkg = await Bun.file(join(REPO, "package.json")).json();
    expect(pkg.name).toBe("tybo");
    expect(pkg.bin).toEqual({ tybo: "scripts/tybo.ts" });
    expect(pkg.scripts.tybo).toBe("bun --no-env-file scripts/tybo.ts");
    // Issue #65: bun run setup ist tybo setup; das alte Prüfskript bleibt für sich aufrufbar
    expect(pkg.scripts.setup).toBe("bun --no-env-file scripts/tybo.ts setup");
    // bun.lock trägt denselben Paketnamen
    expect(await Bun.file(join(REPO, "bun.lock")).text()).toContain('"": {\n      "name": "tybo",');
    expect(pkg.scripts["setup:install"]).toBe("bun run setup/install.ts");
  });

  test.skipIf(existsSync(join(REPO, ".env")))("über einen Link (wie bun link): Projektordner ist der des Skripts, nicht das Arbeitsverzeichnis", async () => {
    const bin = join(base, `bin-${++counter}`);
    await mkdir(bin, { recursive: true });
    await symlink(SCRIPT, join(bin, "tybo"));
    const r = await run([], null, [join(bin, "tybo")]);
    // Ohne .env im Projekt ist die WebUI aus; die Meldung nennt die .env des Projekts, nicht die fremde
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(join(REPO, ".env"));
    expect(r.stderr).not.toContain(foreign);
  });

  test("parseEnvFile wie der Bot: Kommentare, Gleichheitszeichen im Wert", () => {
    expect(parseEnvFile("# x\nA=1\n B = zwei=drei \nleer\n")).toEqual({ A: "1", B: "zwei=drei" });
  });

  test("runTybo: .env des Projekts geht vor der Umgebung", async () => {
    const root = await fakeRoot("WEB_ENABLED=false\n");
    const err: string[] = [];
    const code = await runTybo({ args: [], env: { WEB_ENABLED: "true", WEB_PASSWORD: PASSWORD }, root, err: l => err.push(l), out: () => {} });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("WEB_ENABLED ist nicht true");
  });
});
