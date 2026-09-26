/**
 * Issue #59: der dokumentierte Ablauf aus docs/webui/README.md („bun link" im
 * Projektordner, danach `tybo` in jedem Ordner), automatisiert statt von Hand.
 * Seit Issue #142 legt bun link nur noch `tybo` an, keinen früheren Befehl.
 *
 * Isoliert: `bun link` läuft in einer Kopie des Projekts (package.json, src/,
 * scripts/) in einem temporären Ordner, mit eigenem BUN_INSTALL und HOME.
 * Der Befehl landet so in <tmp>/bun/bin/tybo; ~/.bun/bin und die
 * produktiven Links bleiben unberührt (geprüft). src/bot.ts wird nie gestartet.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDemoTelegram } from "../src/web/demo";
import { createWebServer, type WebServer } from "../src/web/server";
import { OLD_CLI } from "./old-names";

const PASSWORD = "test-passwort-lang";
const REPO = resolve(import.meta.dir, "..");
const base = await mkdtemp(join(tmpdir(), "tybo-link-"));
const project = join(base, "projekt");
const bunInstall = join(base, "bun");
const home = join(base, "home");
const foreign = join(base, "anderswo");
const servers: WebServer[] = [];

afterAll(async () => {
  for (const s of servers.splice(0)) await s.stop();
  await rm(base, { recursive: true, force: true });
});

/** Zustand der echten Links, um zu zeigen, dass der Test sie nicht anfasst */
async function realLinkState(): Promise<string> {
  const states: string[] = [];
  for (const name of ["tybo", OLD_CLI]) {
    const file = join(homedir(), ".bun", "bin", name);
    try {
      const info = await lstat(file);
      states.push(info.isSymbolicLink() ? `link:${await readlink(file)}` : `datei:${info.mtimeMs}`);
    } catch {
      states.push("fehlt");
    }
  }
  return states.join(" ");
}

async function run(cmd: string[], cwd: string) {
  const env = {
    PATH: `${join(bunInstall, "bin")}:${process.env.PATH ?? ""}`,
    HOME: home,
    BUN_INSTALL: bunInstall,
  };
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe("bun link wie in der Anleitung", () => {
  test("bun link im Projekt, dann tybo aus einem fremden Ordner; kein früherer Befehl; ~/.bun/bin bleibt unberührt", async () => {
    const before = await realLinkState();
    await mkdir(join(project, "data"), { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(foreign, { recursive: true });
    // Fremde .env im Arbeitsverzeichnis, die tybo nicht lesen darf
    await writeFile(join(foreign, ".env"), "WEB_ENABLED=true\nWEB_PASSWORD=falsches-passwort-123\nWEB_PORT=1\n");
    await cp(join(REPO, "package.json"), join(project, "package.json"));
    await cp(join(REPO, "src"), join(project, "src"), { recursive: true });
    await cp(join(REPO, "scripts"), join(project, "scripts"), { recursive: true });
    // Pakete wie im echten Projekt (tybo nutzt marked seit Issue #60); ohne sie würde Bun sie nachladen
    await symlink(join(REPO, "node_modules"), join(project, "node_modules"));

    // Schritt 1 der Anleitung: bun link im Projektordner
    const link = await run(["bun", "link"], project);
    expect(link.code).toBe(0);
    expect(await realpath(join(bunInstall, "bin", "tybo"))).toBe(await realpath(join(project, "scripts", "tybo.ts")));
    expect(await Bun.file(join(bunInstall, "bin", OLD_CLI)).exists()).toBe(false);

    // Schritt 2: tybo help in einem anderen Ordner, über den PATH gefunden
    const help = await run(["tybo", "help"], foreign);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("tybo im Terminal");

    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      {
        sessionFile: join(base, "server", "sessions.json"),
        dataDir: join(base, "server", "web"),
        cliTokenFile: join(project, "data", "cli-token"),
        telegram: createDemoTelegram(Date.now(), { seed: true }),
        log: () => {},
      }
    );
    servers.push(server);
    const port = Number(new URL(server.url).port);
    await writeFile(join(project, ".env"), `WEB_ENABLED=true\nWEB_PASSWORD=${PASSWORD}\nWEB_PORT=${port}\n`);

    // Bot läuft (Web-Server mit Schlüssel in <projekt>/data/cli-token): Anmeldung klappt,
    // der Chat öffnet den Direktchat und endet ohne Eingabe (Issue #60)
    const ok = await run(["tybo"], foreign);
    expect(ok.stderr).toBe("");
    expect(ok.code).toBe(0);
    expect(ok.stdout.split("\n")[0]).toBe("tybo · Direktchat · Agent General");

    await server.stop();
    servers.splice(0);
    // Bot läuft nicht: Meldung nennt den Projektordner der Kopie, nicht das Arbeitsverzeichnis
    const stopped = await run(["tybo"], foreign);
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain(`tybo läuft nicht. Starten mit: cd ${await realpath(project)} && bun run start`);
    expect(stopped.stderr).not.toContain(await realpath(foreign));

    expect(await realLinkState()).toBe(before);
  }, 30_000);
});
