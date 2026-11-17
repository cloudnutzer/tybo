/**
 * Issue #352: deploy.sh rollt tybo als bot.ts im Server-Profil aus. Echte
 * Läufe des Skripts mit Attrappen für git, bun (nur install und run), pm2,
 * curl und sleep; das echte bun schreibt die PM2-Einstellungen. Kein Netz,
 * kein PM2, kein Bot.
 *
 * Geprüft: Prüfung vor dem Prozesswechsel, Sperre gegen parallele Deploys,
 * Rückweg bei fehlender oder falscher Revision, Health am Webhook-Port,
 * Wechsel des PM2-Namens, geteilte Pfade aus scripts/deploy-shared.txt über
 * zwei Releases (auch wenn tybo eine Datei atomar ersetzt), Übergang vom
 * bisherigen Layout (config/ als echter Ordner im Release) und die .env als
 * Link: Schlüssel-Seite und Push-Schlüssel schreiben die echte Datei im
 * Projektordner, die den nächsten Deploy übersteht.
 *
 * Die git-Attrappe merkt sich je Revision, was archive geliefert hat, und
 * beantwortet rev-parse REV:PFAD und hash-object mit Prüfsummen daraus.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { profileFromArgs } from "../src/app/bot-boot";
import { BOT_PM2_KILL_TIMEOUT_MS } from "../src/setup/services/pm2";
import { parseEnvContent } from "../src/lib/env-file";
import { createBotKeys, defaultEnvPath } from "../src/web/bot-keys";
import { prepareBotPush } from "../src/web/bot-push";

const SHARED_LIST = readFileSync(resolve("scripts/deploy-shared.txt"), "utf8");

let dir: string;
let bin: string;
let runs = 0;

const STUBS: Record<string, string> = {
  git:
    '#!/bin/sh\n' +
    'case "$3" in\n' +
    '  rev-parse) if [ "$4" = "--verify" ]; then f="$FIXTURE_HISTORY/${6%%:*}/${6#*:}"; [ -f "$f" ] || exit 1; cksum < "$f"; else echo "$FIXTURE_REVISION"; fi;;\n' +
    '  hash-object) cksum < "$5";;\n' +
    '  archive) mkdir -p "$FIXTURE_HISTORY/$4" && cp -R "$FIXTURE_SOURCE/." "$FIXTURE_HISTORY/$4/" && tar -C "$FIXTURE_SOURCE" -cf - .;;\n' +
    'esac\n',
  bun: '#!/bin/sh\nif [ "$1" = "run" ]; then [ "$FAIL_CHECK" != "yes" ]; elif [ "$1" = "install" ]; then exit 0; else exec "$REAL_BUN" "$@"; fi\n',
  pm2:
    '#!/bin/sh\necho "$*" >> "$PM2_LOG"\n' +
    'case "$1" in\n' +
    '  describe) [ "$2" = "$PM2_OLD_NAME" ];;\n' +
    '  jlist) printf \'[{"name":"%s","pm2_env":{"pm_exec_path":"/vorher/app.ts","pm_cwd":"%s","exec_interpreter":"bun","args":[],"kill_timeout":%s,"env":{"A":"1"}}}]\' "$PM2_OLD_NAME" "$PM2_OLD_CWD" "${PM2_OLD_KILL_TIMEOUT:-null}";;\n' +
    "esac\n",
  curl: '#!/bin/sh\nfor a; do url="$a"; done\necho "$url" >> "$CURL_LOG"\nprintf \'{"status":"ok","revision":"%s"}\' "$HEALTH_REVISION"\n',
  sleep: "#!/bin/sh\nexit 0\n",
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-deploy-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, content] of Object.entries(STUBS)) writeFileSync(join(bin, name), content, { mode: 0o700 });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Inhalt des Repos, den git archive liefert */
function source(files: Record<string, string> = {}): string {
  const root = join(dir, `quelle-${++runs}`);
  const all: Record<string, string> = {
    "bun.lock": "x",
    "src/bot.ts": "x",
    "tests/.keep": "x",
    "scripts/deploy-shared.txt": SHARED_LIST,
    "config/topics.example.json": "{}",
    ...files,
  };
  for (const [name, content] of Object.entries(all)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

interface Run {
  exit: number;
  pm2: string[];
  curl: string[];
  releases: string;
  release: string | null;
  log: string;
}

async function deploy(options: {
  project: string;
  revision: string;
  source?: string;
  env?: Record<string, string>;
  oldName?: string;
  oldCwd?: string;
  health?: string;
  failCheck?: boolean;
}): Promise<Run> {
  const n = ++runs;
  const releases = join(options.project, ".releases");
  const pm2Log = join(dir, `pm2-${n}.log`);
  const curlLog = join(dir, `curl-${n}.log`);
  const script = resolve("deploy.sh");
  const child = Bun.spawn(["bash", script], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      REAL_BUN: process.execPath,
      FIXTURE_SOURCE: options.source ?? source(),
      FIXTURE_REVISION: options.revision,
      FIXTURE_HISTORY: join(dir, "history"),
      PM2_LOG: pm2Log,
      CURL_LOG: curlLog,
      PM2_OLD_NAME: options.oldName ?? "tybo",
      PM2_OLD_CWD: options.oldCwd ?? options.project,
      HEALTH_REVISION: options.health ?? options.revision,
      FAIL_CHECK: options.failCheck ? "yes" : "no",
      DEPLOY_DIR: options.project,
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await child.exited;
  const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []);
  const release = existsSync(releases) ? readdirSync(releases).find(name => name.startsWith(`${options.revision}-`)) ?? null : null;
  const logName = existsSync(releases) ? readdirSync(releases).filter(name => name.startsWith("deploy-")).sort().at(-1) : undefined;
  return {
    exit,
    pm2: lines(pm2Log),
    curl: lines(curlLog),
    releases,
    release: release ? join(releases, release) : null,
    log: logName ? readFileSync(join(releases, logName), "utf8") : "",
  };
}

function project(): string {
  const root = join(dir, `projekt-${++runs}`);
  mkdirSync(root);
  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=attrappe\n");
  return root;
}

const app = (file: string) => JSON.parse(readFileSync(file, "utf8")).apps[0];

describe("deploy.sh", () => {
  test("Syntax (bash -n)", () => {
    expect(Bun.spawnSync(["bash", "-n", resolve("deploy.sh")]).exitCode).toBe(0);
  });

  test("gesund: bot.ts im Server-Profil unter tybo, Revision im Prozess, Health am Webhook-Port 3080", async () => {
    const root = project();
    const run = await deploy({ project: root, revision: "abc123" });
    expect(run.exit).toBe(0);
    expect(run.log).toContain("Release abc123 läuft als tybo.");
    expect(run.pm2).toEqual(["describe tybo", "jlist", "delete tybo", `start ${run.release}/release.json`]);
    const next = app(join(run.release!, "release.json"));
    expect(next).toMatchObject({ name: "tybo", script: `${run.release}/src/bot.ts`, cwd: run.release, interpreter: process.execPath });
    expect(profileFromArgs(next.args)).toBe("server");
    expect(next.env).toEqual({ A: "1", DEPLOY_DIR: root, RELEASE_REVISION: "abc123", DEPLOY_PREVIOUS_APP: "tybo" });
    expect(app(join(run.releases, "rollback.json"))).toMatchObject({ name: "tybo", script: "/vorher/app.ts", cwd: root });
    expect(run.curl).toEqual(["http://127.0.0.1:3080/health"]);
    expect(existsSync(join(run.releases, "deploy.lock"))).toBe(false);
    // Frist zum Beenden (Issue #564): neues Release und Rückweg
    expect(next.kill_timeout).toBe(BOT_PM2_KILL_TIMEOUT_MS);
    expect(app(join(run.releases, "rollback.json")).kill_timeout).toBe(BOT_PM2_KILL_TIMEOUT_MS);
  }, 60_000);

  test("Frist zum Beenden: kill_timeout 10000, eine längere des laufenden Prozesses bleibt (Issue #564)", async () => {
    const longer = await deploy({ project: project(), revision: "kt1", env: { PM2_OLD_KILL_TIMEOUT: "45000" } });
    expect(longer.exit).toBe(0);
    expect(app(join(longer.release!, "release.json")).kill_timeout).toBe(45000);
    expect(app(join(longer.releases, "rollback.json")).kill_timeout).toBe(45000);

    const shorter = await deploy({ project: project(), revision: "kt2", env: { PM2_OLD_KILL_TIMEOUT: "1600" } });
    expect(app(join(shorter.release!, "release.json")).kill_timeout).toBe(10000);
    expect(app(join(shorter.releases, "rollback.json")).kill_timeout).toBe(10000);

    // Gescheitertes Release: der Rückweg startet mit derselben Frist
    const bad = await deploy({ project: project(), revision: "kt3", health: "falsch", env: { PM2_OLD_KILL_TIMEOUT: "45000" } });
    expect(bad.pm2.at(-1)).toBe(`start ${bad.releases}/rollback.json`);
    expect(app(join(bad.releases, "rollback.json")).kill_timeout).toBe(45000);
    // Wert in deploy.sh und in src/setup/services/pm2.ts gleich
    expect(readFileSync(resolve("deploy.sh"), "utf8")).toContain(`Math.max(${BOT_PM2_KILL_TIMEOUT_MS},`);
  }, 120_000);

  test("Health folgt TELEGRAM_WEBHOOK_PORT, DEPLOY_HEALTH_URL hat Vorrang", async () => {
    const a = await deploy({ project: project(), revision: "port1", env: { TELEGRAM_WEBHOOK_PORT: "3999" } });
    expect(a.curl).toEqual(["http://127.0.0.1:3999/health"]);
    const b = await deploy({ project: project(), revision: "port2", env: { TELEGRAM_WEBHOOK_PORT: "3999", DEPLOY_HEALTH_URL: "http://127.0.0.1:4111/health" } });
    expect(b.curl).toEqual(["http://127.0.0.1:4111/health"]);
  }, 60_000);

  test("gescheiterte Prüfung: laufender Prozess bleibt unberührt", async () => {
    const run = await deploy({ project: project(), revision: "kaputt1", failCheck: true });
    expect(run.exit).not.toBe(0);
    expect(run.pm2).toEqual(["describe tybo"]);
  }, 60_000);

  test("falsche Revision im Health: Rückweg mit der vorigen Einstellung", async () => {
    const run = await deploy({ project: project(), revision: "neu1", health: "alt" });
    expect(run.exit).not.toBe(0);
    expect(run.curl).toHaveLength(30);
    expect(run.pm2.slice(-3)).toEqual([`start ${run.release}/release.json`, "delete tybo", `start ${run.releases}/rollback.json`]);
    expect(run.log).toContain("Release neu1 nicht gesund");
  }, 60_000);

  test("Sperre: läuft schon ein Deploy, passiert nichts", async () => {
    const root = project();
    mkdirSync(join(root, ".releases", "deploy.lock"), { recursive: true });
    const run = await deploy({ project: root, revision: "sperre1" });
    expect(run.exit).toBe(1);
    expect(run.pm2).toEqual([]);
    expect(run.release).toBeNull();
    expect(run.log).toContain("ein anderer Deploy läuft");
    // Die fremde Sperre bleibt liegen
    expect(existsSync(join(root, ".releases", "deploy.lock"))).toBe(true);
  }, 60_000);

  test("Namenswechsel: alter PM2-Name wird angehalten, neuer startet; Rückweg mit altem Namen", async () => {
    const root = project();
    const ok = await deploy({ project: root, revision: "name1", oldName: "alter-name", env: { DEPLOY_PREVIOUS_APP: "alter-name" } });
    expect(ok.exit).toBe(0);
    expect(ok.pm2).toEqual(["describe alter-name", "jlist", "delete alter-name", `start ${ok.release}/release.json`]);
    expect(app(join(ok.release!, "release.json")).name).toBe("tybo");
    expect(app(join(ok.releases, "rollback.json")).name).toBe("alter-name");

    const bad = await deploy({ project: project(), revision: "name2", oldName: "alter-name", health: "alt", env: { DEPLOY_PREVIOUS_APP: "alter-name" } });
    expect(bad.exit).not.toBe(0);
    expect(bad.pm2.slice(-2)).toEqual(["delete tybo", `start ${bad.releases}/rollback.json`]);
    expect(app(join(bad.releases, "rollback.json")).name).toBe("alter-name");
  }, 60_000);

  test("Namenswechsel, dann zweiter Deploy aus der Umgebung des neuen Bots: beide gelingen", async () => {
    const root = project();
    // Dokumentierter Aufruf: DEPLOY_PREVIOUS_APP=<alter Name> bash deploy.sh
    const cli = { DEPLOY_PREVIOUS_APP: "alter-name" };
    const first = await deploy({ project: root, revision: "wechsel1", oldName: "alter-name", env: cli });
    expect(first.exit).toBe(0);
    const rollback = app(join(first.releases, "rollback.json"));
    expect(rollback.name).toBe("alter-name");
    expect(rollback.env.DEPLOY_PREVIOUS_APP).toBeUndefined();

    // PM2: erst die Umgebung des Aufrufs, darüber env aus release.json. Diese
    // Umgebung erbt der nächste Deploy über POST /deploy (src/app/server-routes.ts)
    const botEnv = { ...cli, ...(app(join(first.release!, "release.json")).env as Record<string, string>) };
    expect(botEnv.DEPLOY_PREVIOUS_APP).toBe("tybo");

    const second = await deploy({ project: root, revision: "wechsel2", oldName: "tybo", oldCwd: first.release!, env: botEnv });
    expect(second.exit).toBe(0);
    expect(second.pm2).toEqual(["describe tybo", "jlist", "delete tybo", `start ${second.release}/release.json`]);
    expect(second.log).toContain("Release wechsel2 läuft als tybo.");
  }, 60_000);

  test("ohne DEPLOY_PREVIOUS_APP und mit anderem laufenden Namen: Abbruch vor allem anderen", async () => {
    const run = await deploy({ project: project(), revision: "name3", oldName: "alter-name" });
    expect(run.exit).toBe(1);
    expect(run.pm2).toEqual(["describe tybo"]);
    expect(run.log).toContain("DEPLOY_PREVIOUS_APP");
  }, 60_000);

  test("ungültiger Eintrag in der Liste der geteilten Pfade: Abbruch vor dem Wechsel", async () => {
    for (const [i, entry] of ["../geheim", "/etc/", "./data/"].entries()) {
      const run = await deploy({
        project: project(),
        revision: `liste${i}`,
        source: source({ "scripts/deploy-shared.txt": `.env\n${entry}\n` }),
      });
      expect(run.exit).toBe(1);
      expect(run.pm2).toEqual(["describe tybo"]);
      expect(run.log).toContain(`ungültiger Eintrag in scripts/deploy-shared.txt: ${entry}`);
    }
  }, 60_000);

  test("Liste der geteilten Pfade: .env, config, data und die Einzeldateien", () => {
    const entries = SHARED_LIST.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    for (const needed of [".env", "config/", "data/", "uploads/", "logs/", "memory.json", "memory.json.sqlite"]) expect(entries).toContain(needed);
  });

  test("geteilte Pfade überstehen zwei Releases, auch atomar ersetzte Dateien", async () => {
    const root = project();
    writeFileSync(join(root, "memory.json"), "alt");
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "settings.json"), '{"eigen":true}');
    const repo = { "config/settings.json": '{"aus-dem-repo":true}' };

    const first = await deploy({ project: root, revision: "eins", source: source(repo) });
    expect(first.exit).toBe(0);
    const r1 = first.release!;
    for (const name of [".env", "config", "data", "uploads", "logs", "memory.json"]) {
      expect({ name, link: lstatSync(join(r1, name)).isSymbolicLink() }).toEqual({ name, link: true });
    }
    expect(readlinkSync(join(r1, "config"))).toBe(join(root, "config"));
    // Eigene Datei bleibt, mitgelieferte Vorlage kommt dazu
    expect(readFileSync(join(root, "config", "settings.json"), "utf8")).toBe('{"eigen":true}');
    expect(existsSync(join(root, "config", "topics.example.json"))).toBe(true);
    // Fehlende Einzeldateien werden nicht angelegt
    expect(existsSync(join(r1, "session-state.json"))).toBe(false);

    // Release 1 läuft: tybo schreibt atomar (temporäre Datei, dann rename)
    const atomic = (path: string, content: string) => {
      writeFileSync(`${path}.tmp`, content);
      renameSync(`${path}.tmp`, path);
    };
    for (const name of ["settings.json", "agents.json", "topics.json"]) atomic(join(r1, "config", name), `{"${name}":2}`);
    writeFileSync(join(r1, "data", "choices.json"), "[]");
    atomic(join(r1, "memory.json"), "neu");
    expect(lstatSync(join(r1, "memory.json")).isSymbolicLink()).toBe(false);

    const second = await deploy({ project: root, revision: "zwei", source: source(repo), oldCwd: r1 });
    expect(second.exit).toBe(0);
    const r2 = second.release!;
    for (const name of ["settings.json", "agents.json", "topics.json"]) {
      expect(readFileSync(join(r2, "config", name), "utf8")).toBe(`{"${name}":2}`);
    }
    expect(readFileSync(join(r2, "data", "choices.json"), "utf8")).toBe("[]");
    // Die ersetzte Datei aus Release 1 ist jetzt der Stand im Projektordner, Release 2 verlinkt sie
    expect(readFileSync(join(root, "memory.json"), "utf8")).toBe("neu");
    expect(readlinkSync(join(r2, "memory.json"))).toBe(join(root, "memory.json"));
    expect(readFileSync(join(r2, ".env"), "utf8")).toBe("TELEGRAM_BOT_TOKEN=attrappe\n");
  }, 60_000);

  test("Einzeldateien kommen nur aus einem früheren Release, nie aus einem fremden Ordner", async () => {
    const root = project();
    writeFileSync(join(root, "memory.json"), "projekt");
    const foreign = join(dir, `fremd-${++runs}`);
    mkdirSync(foreign);
    writeFileSync(join(foreign, "memory.json"), "fremd");
    const run = await deploy({ project: root, revision: "fremd1", oldCwd: foreign });
    expect(run.exit).toBe(0);
    expect(readFileSync(join(root, "memory.json"), "utf8")).toBe("projekt");
  }, 60_000);

  test("Übergang vom bisherigen Layout: eigene Dateien aus config/ des vorigen Release, auch beim zweiten Deploy", async () => {
    const root = project();
    // Projektordner mit älterem Stand
    mkdirSync(join(root, "config"));
    for (const name of ["settings.json", "agents.json", "topics.json"]) writeFileSync(join(root, "config", name), '{"stand":"projekt"}');
    writeFileSync(join(root, "config", "agent-overrides.json"), '{"stand":"projekt"}');
    writeFileSync(join(root, "config", "profile.md"), "Profil");
    writeFileSync(join(root, "config", "topics.example.json"), '{"checkout":true}');

    // Voriges Release wie vom früheren deploy.sh: config/ und data/ echte Ordner,
    // darin Einzeldatei-Links; geliefert hatte die Revision nur topics.example.json
    const oldRevision = "altrev";
    mkdirSync(join(dir, "history", oldRevision, "config"), { recursive: true });
    writeFileSync(join(dir, "history", oldRevision, "config", "topics.example.json"), "{}");
    const old = join(root, ".releases", `${oldRevision}-1700000000`);
    mkdirSync(join(old, "config"), { recursive: true });
    mkdirSync(join(old, "data"));
    writeFileSync(join(old, "config", "topics.example.json"), "{}");
    for (const name of ["settings.json", "agents.json", "topics.json"]) writeFileSync(join(old, "config", name), `{"stand":"release","datei":"${name}"}`);
    // früherer Link, atomar durch eine echte Datei ersetzt
    writeFileSync(join(old, "config", "agent-overrides.json"), '{"stand":"release"}');
    symlinkSync(join(root, "config", "profile.md"), join(old, "config", "profile.md"));
    symlinkSync(join(root, ".env"), join(old, ".env"));
    writeFileSync(join(old, "data", "choices.json"), "[1]");

    const first = await deploy({ project: root, revision: "neu1", oldCwd: old });
    expect(first.exit).toBe(0);
    const r1 = first.release!;
    expect(readlinkSync(join(r1, "config"))).toBe(join(root, "config"));
    for (const name of ["settings.json", "agents.json", "topics.json"]) {
      expect(readFileSync(join(root, "config", name), "utf8")).toBe(`{"stand":"release","datei":"${name}"}`);
    }
    expect(readFileSync(join(root, "config", "agent-overrides.json"), "utf8")).toBe('{"stand":"release"}');
    expect(readFileSync(join(root, "data", "choices.json"), "utf8")).toBe("[1]");
    // Links und unverändert mitgelieferte Dateien bleiben unberührt
    expect(lstatSync(join(root, "config", "profile.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(root, "config", "profile.md"), "utf8")).toBe("Profil");
    expect(readFileSync(join(root, "config", "topics.example.json"), "utf8")).toBe('{"checkout":true}');
    // Das vorige Release bleibt für den Rückweg vollständig
    expect(readFileSync(join(old, "config", "settings.json"), "utf8")).toContain('"release"');
    expect(first.log).toContain("Übernommen aus dem vorigen Release: config/settings.json");
    expect(first.log).not.toContain("config/topics.example.json");

    // Release 1 läuft und ersetzt settings.json atomar; der zweite Deploy holt
    // nichts mehr aus dem alten Release
    writeFileSync(join(r1, "config", "settings.json.tmp"), '{"stand":"r1"}');
    renameSync(join(r1, "config", "settings.json.tmp"), join(r1, "config", "settings.json"));
    const second = await deploy({ project: root, revision: "neu2", oldCwd: r1 });
    expect(second.exit).toBe(0);
    const r2 = second.release!;
    expect(readFileSync(join(r2, "config", "settings.json"), "utf8")).toBe('{"stand":"r1"}');
    expect(readFileSync(join(r2, "config", "agents.json"), "utf8")).toBe('{"stand":"release","datei":"agents.json"}');
    expect(readFileSync(join(r2, "config", "topics.json"), "utf8")).toBe('{"stand":"release","datei":"topics.json"}');
    expect(readFileSync(join(r2, "data", "choices.json"), "utf8")).toBe("[1]");
    expect(second.log).not.toContain("Übernommen aus dem vorigen Release");
  }, 60_000);
});

// Die .env im Release ist ein Link auf DEPLOY_DIR/.env. Schlüssel-Seite und
// Push-Schlüssel schreiben diese echte Datei (src/web/bot-keys.ts,
// defaultEnvPath); jeder andere Link wird weiter abgelehnt
describe("deploy.sh: .env-Schreiber im Release", () => {
  /** Wie bot.ts im Release: Arbeitsverzeichnis ist das Release */
  async function inRelease<T>(release: string, fn: () => Promise<T>): Promise<T> {
    const before = process.cwd();
    process.chdir(release);
    try {
      return await fn();
    } finally {
      process.chdir(before);
    }
  }

  test("Schlüssel-Seite schreibt die .env im Projektordner, der nächste Deploy sieht den Wert", async () => {
    const root = project();
    const first = await deploy({ project: root, revision: "env1" });
    expect(first.exit).toBe(0);
    const r1 = first.release!;
    const env = app(join(r1, "release.json")).env as Record<string, string>;
    expect(env.DEPLOY_DIR).toBe(root);
    expect(defaultEnvPath(r1, env)).toBe(join(root, ".env"));

    await inRelease(r1, () => createBotKeys(env).set("OPENAI_API_KEY", "sk-attrappe-1"));
    expect(lstatSync(join(r1, ".env")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(root, ".env")).isFile()).toBe(true);
    expect(parseEnvContent(readFileSync(join(root, ".env"), "utf8"))).toMatchObject({ TELEGRAM_BOT_TOKEN: "attrappe", OPENAI_API_KEY: "sk-attrappe-1" });
    // Sicherung im geteilten data/, nicht im Release
    expect(readdirSync(join(root, "data", "backups")).length).toBe(1);

    await inRelease(r1, () => createBotKeys(env).remove("OPENAI_API_KEY"));
    await inRelease(r1, () => createBotKeys(env).set("OPENAI_API_KEY", "sk-attrappe-2"));

    const second = await deploy({ project: root, revision: "env2", oldCwd: r1 });
    expect(second.exit).toBe(0);
    expect(parseEnvContent(readFileSync(join(second.release!, ".env"), "utf8")).OPENAI_API_KEY).toBe("sk-attrappe-2");
  }, 60_000);

  test("Push-Schlüssel werden beim ersten Start angelegt und bleiben über den nächsten Deploy", async () => {
    const root = project();
    writeFileSync(join(root, ".env"), "WEB_ENABLED=true\nWEB_PASSWORD=test-passwort-lang\n", { mode: 0o600 });
    const first = await deploy({ project: root, revision: "push1" });
    expect(first.exit).toBe(0);
    const r1 = first.release!;
    const env = { ...(app(join(r1, "release.json")).env as Record<string, string>), WEB_ENABLED: "true" };

    const logs: string[] = [];
    const created = await inRelease(r1, () => prepareBotPush(env, { log: m => logs.push(m) }));
    expect(created).not.toBeNull();
    expect(logs).toEqual(["Push-Schlüssel erzeugt"]);
    const stored = parseEnvContent(readFileSync(join(root, ".env"), "utf8"));
    expect(stored.WEB_PUSH_PUBLIC_KEY).toBe(created!.keys.publicKey);
    expect(stored.WEB_PUSH_PRIVATE_KEY).toBe(created!.keys.privateKey);
    expect(stored.WEB_PASSWORD).toBe("test-passwort-lang");
    expect(lstatSync(join(r1, ".env")).isSymbolicLink()).toBe(true);

    const second = await deploy({ project: root, revision: "push2", oldCwd: r1 });
    expect(second.exit).toBe(0);
    const again: string[] = [];
    const reused = await inRelease(second.release!, () => prepareBotPush(env, { log: m => again.push(m) }));
    expect(reused?.keys).toEqual(created!.keys);
    expect(again).toEqual([]);
  }, 60_000);

  test("Symlink-Schutz bleibt: Link woandershin oder verlinkte Projekt-.env wird nicht beschrieben", async () => {
    const root = project();
    const run = await deploy({ project: root, revision: "schutz1" });
    expect(run.exit).toBe(0);
    const r1 = run.release!;
    const env = app(join(r1, "release.json")).env as Record<string, string>;

    // Link im Release zeigt nicht auf DEPLOY_DIR/.env
    const elsewhere = join(dir, `woanders-${++runs}.env`);
    writeFileSync(elsewhere, "A=1\n");
    rmSync(join(r1, ".env"));
    symlinkSync(elsewhere, join(r1, ".env"));
    expect(defaultEnvPath(r1, env)).toBe(join(r1, ".env"));
    await expect(inRelease(r1, () => createBotKeys(env).set("OPENAI_API_KEY", "sk-x"))).rejects.toThrow(".env ist ein Verweis");
    expect(readFileSync(elsewhere, "utf8")).toBe("A=1\n");

    // DEPLOY_DIR/.env ist selbst ein Link
    rmSync(join(r1, ".env"));
    symlinkSync(join(root, ".env"), join(r1, ".env"));
    const real = join(dir, `echt-${++runs}.env`);
    writeFileSync(real, "B=1\n");
    rmSync(join(root, ".env"));
    symlinkSync(real, join(root, ".env"));
    expect(defaultEnvPath(r1, env)).toBe(join(r1, ".env"));
    await expect(inRelease(r1, () => createBotKeys(env).set("OPENAI_API_KEY", "sk-x"))).rejects.toThrow(".env ist ein Verweis");
    expect(readFileSync(real, "utf8")).toBe("B=1\n");

    // Ohne DEPLOY_DIR (Mac, kein Release): .env im Arbeitsverzeichnis wie bisher
    expect(defaultEnvPath(r1, {})).toBe(join(r1, ".env"));
  }, 60_000);
});
