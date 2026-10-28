/**
 * Issue #483: install.sh, wenn die öffentliche Historie neu aufgebaut wurde
 * (tybo 2.16.0 als Commit ohne Vorgänger, Force-Push). Anders als
 * install-sh.test.ts mit echtem Git: ein Bare-Repo als „öffentliches Repo“,
 * ein Klon mit dem alten Stand 2.15.0, danach ein Orphan-Commit im Bare-Repo.
 * Nur Bun ist eine Attrappe (install und link tun nichts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "..", "install.sh");
const GIT = Bun.which("git");
const SHELLS = ["/bin/sh", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])];
const T = 60_000;

let root: string;
let counter = 0;

const BUN_MOCK = `#!/bin/sh
printf '%s\\n' "$*" >>"$BUN_LOG"
case "$1" in
  --version) echo 1.3.10 ;;
esac
exit 0
`;

const AUTHOR = { GIT_AUTHOR_NAME: "tybo", GIT_AUTHOR_EMAIL: "noreply@tybo.ai", GIT_COMMITTER_NAME: "tybo", GIT_COMMITTER_EMAIL: "noreply@tybo.ai" };

beforeAll(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "tybo-483-install-")));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Fixture {
  dir: string;
  home: string;
  bare: string;
  seed: string;
  clone: string;
  env: Record<string, string>;
  oldHead: string;
  newHead: string;
}

function git(env: Record<string, string>, cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync([GIT!, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

async function writeTree(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

const OLD_FILES: Record<string, string> = {
  ".gitignore": ".env\ndata/\nlogs/\nmodels/\nconfig/settings.json\nnode_modules/\n",
  "README.md": "# tybo 2.15.0\n",
  "src/a.ts": "export const a = 15;\n",
  "config/settings.example.json": "{}\n",
};

/** Bare-Repo mit Stand 2.15.0 (Tag v2.15.0) und ein Klon davon, wie ihn der Installer anlegt */
async function fixture(): Promise<Fixture> {
  const dir = join(root, `fall-${++counter}`);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin);
  await writeFile(join(bin, "bun"), BUN_MOCK);
  await chmod(join(bin, "bun"), 0o755);
  const env: Record<string, string> = {
    PATH: [bin, dirname(GIT!), "/usr/bin", "/bin"].join(":"),
    HOME: home,
    TMPDIR: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    BUN_LOG: join(dir, "bun.log"),
  };
  const bare = join(dir, "public.git");
  git(env, dir, "init", "-q", "--bare", "-b", "master", bare);
  const seed = join(dir, "seed");
  git(env, dir, "init", "-q", "-b", "master", seed);
  await writeTree(seed, OLD_FILES);
  const seedEnv = { ...env, ...AUTHOR };
  git(seedEnv, seed, "add", "-A");
  git(seedEnv, seed, "commit", "-q", "-m", "tybo 2.15.0");
  git(seedEnv, seed, "tag", "-a", "v2.15.0", "-m", "tybo 2.15.0");
  git(seedEnv, seed, "remote", "add", "origin", bare);
  git(seedEnv, seed, "push", "-q", "origin", "master", "v2.15.0");
  const clone = join(home, "tybo");
  git(env, home, "clone", "-q", "--branch", "master", bare, clone);
  return { dir, home, bare, seed, clone, env, oldHead: git(env, clone, "rev-parse", "HEAD"), newHead: "" };
}

/** Neuaufbau im Bare-Repo: Orphan-Commit 2.16.0, Force-Push, alte Tags weg, v2.16.0 neu */
async function rebuild(f: Fixture, extra: Record<string, string> = {}) {
  const env = { ...f.env, ...AUTHOR };
  git(env, f.seed, "checkout", "-q", "--orphan", "neu");
  await writeTree(f.seed, { "README.md": "# tybo 2.16.0\n", "src/a.ts": "export const a = 16;\n", "src/b.ts": "export const b = 1;\n", ...extra });
  // -f: auch Pfade, die die .gitignore des alten Stands ausschließt
  git(env, f.seed, "add", "-A", "-f");
  git(env, f.seed, "commit", "-q", "-m", "tybo 2.16.0");
  git(env, f.seed, "tag", "-a", "v2.16.0", "-m", "tybo 2.16.0");
  const old = git(env, f.seed, "rev-parse", "master");
  git(env, f.seed, "push", "-q", `--force-with-lease=master:${old}`, "origin", "neu:master");
  git(env, f.seed, "push", "-q", "origin", ":refs/tags/v2.15.0", "v2.16.0");
  f.newHead = git(env, f.seed, "rev-parse", "HEAD");
  expect(git(env, f.seed, "rev-list", "--max-parents=0", "HEAD")).toBe(f.newHead);
}

async function install(f: Fixture, shell: string) {
  const p = Bun.spawn([shell, SCRIPT, "--no-setup"], {
    cwd: f.home,
    env: { ...f.env, TYBO_REPO_URL: f.bare, TYBO_DIR: f.clone, TYBO_TTY: join(f.dir, "kein-terminal") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const bun = existsSync(f.env.BUN_LOG) ? (await readFile(f.env.BUN_LOG, "utf8")).split("\n").filter(Boolean) : [];
  return { exit, stdout, stderr, bun };
}

const head = (f: Fixture) => git(f.env, f.clone, "rev-parse", "HEAD");
const status = (f: Fixture) => git(f.env, f.clone, "status", "--porcelain", "--untracked-files=all");
const read = (f: Fixture, path: string) => readFile(join(f.clone, path), "utf8");

for (const shell of SHELLS) {
  describe(`install.sh unter ${shell}: neu aufgebaute Historie (Issue #483)`, () => {
    test("(a) sauberer alter Klon: Neuaufbau erkannt, Stand 2.16.0, danach normales Update", async () => {
      const f = await fixture();
      await rebuild(f);
      const r = await install(f, shell);
      expect(r.stderr).not.toContain("eigene Commits");
      expect(r.exit).toBe(0);
      expect(r.stdout).toContain("die Historie von tybo wurde neu aufgebaut");
      expect(r.stdout).toContain("Aktualisiert auf");
      expect(head(f)).toBe(f.newHead);
      expect(git(f.env, f.clone, "symbolic-ref", "--short", "HEAD")).toBe("master");
      expect(status(f)).toBe("");
      expect(await read(f, "src/a.ts")).toBe("export const a = 16;\n");
      expect(await read(f, "src/b.ts")).toBe("export const b = 1;\n");
      expect(r.bun).toContain("install --frozen-lockfile");

      // zweiter Lauf nach dem Neuaufbau: gewöhnliches Vorspulen
      await writeTree(f.seed, { "src/c.ts": "export const c = 1;\n" });
      git({ ...f.env, ...AUTHOR }, f.seed, "add", "-A");
      git({ ...f.env, ...AUTHOR }, f.seed, "commit", "-q", "-m", "tybo 2.16.1");
      git(f.env, f.seed, "push", "-q", "origin", "neu:master");
      const again = await install(f, shell);
      expect(again.exit).toBe(0);
      expect(again.stdout).not.toContain("neu aufgebaut");
      expect(head(f)).toBe(git(f.env, f.seed, "rev-parse", "HEAD"));
    }, T);

    test("(b) mit .env, config/, data/, logs/ und models/: Nutzerdaten bleiben unverändert", async () => {
      const f = await fixture();
      const userData: Record<string, string> = {
        ".env": "TELEGRAM_BOT_TOKEN=synth-test-token\n",
        "config/settings.json": '{"eigen":true}\n',
        "config/profile.md": "# Profil\n",
        "data/web/gespraech.json": "[]\n",
        "logs/bot.log": "läuft\n",
        "models/parakeet/model.bin": "gewichte\n",
        "notizen.txt": "ungetrackt, nicht ignoriert\n",
      };
      await writeTree(f.clone, userData);
      await rebuild(f);
      const r = await install(f, shell);
      expect(r.exit).toBe(0);
      expect(head(f)).toBe(f.newHead);
      for (const [path, content] of Object.entries(userData)) expect(await read(f, path)).toBe(content);
      expect(status(f)).toBe("?? config/profile.md\n?? notizen.txt");
    }, T);

    test("(c) getrackte lokale Änderung: Abbruch mit Hinweis, nichts überschrieben", async () => {
      const f = await fixture();
      await writeFile(join(f.clone, "src/a.ts"), "export const a = 99; // eigene Änderung\n");
      await rebuild(f);
      const r = await install(f, shell);
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("lokale Änderungen in");
      expect(r.stderr).toContain("git stash");
      expect(head(f)).toBe(f.oldHead);
      expect(await read(f, "src/a.ts")).toBe("export const a = 99; // eigene Änderung\n");
      expect(r.bun).toEqual([]);
    }, T);

    test("(d) eigener Commit auf der alten Historie: Abbruch mit Hinweis, Commit bleibt", async () => {
      const f = await fixture();
      await writeFile(join(f.clone, "src/eigen.ts"), "export const eigen = 1;\n");
      git({ ...f.env, GIT_AUTHOR_NAME: "Nutzer", GIT_AUTHOR_EMAIL: "nutzer@example.invalid", GIT_COMMITTER_NAME: "Nutzer", GIT_COMMITTER_EMAIL: "nutzer@example.invalid" }, f.clone, "add", "-A");
      git({ ...f.env, GIT_AUTHOR_NAME: "Nutzer", GIT_AUTHOR_EMAIL: "nutzer@example.invalid", GIT_COMMITTER_NAME: "Nutzer", GIT_COMMITTER_EMAIL: "nutzer@example.invalid" }, f.clone, "commit", "-q", "-m", "eigene Anpassung");
      const own = head(f);
      await rebuild(f);
      const r = await install(f, shell);
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("eigene Commits auf der alten Historie");
      expect(r.stderr).toContain("git branch meine-sicherung");
      expect(r.stderr).not.toContain("weicht vom Stand");
      expect(head(f)).toBe(own);
      expect(await read(f, "src/eigen.ts")).toBe("export const eigen = 1;\n");
      expect(status(f)).toBe("");
      expect(r.bun).toEqual([]);
    }, T);

    test("eigener Commit auf gemeinsamer Historie: weiter die bisherige Meldung", async () => {
      const f = await fixture();
      await writeFile(join(f.clone, "src/eigen.ts"), "x\n");
      git({ ...f.env, ...AUTHOR }, f.clone, "add", "-A");
      git({ ...f.env, ...AUTHOR }, f.clone, "commit", "-q", "-m", "eigen");
      await writeTree(f.seed, { "src/neu.ts": "y\n" });
      git({ ...f.env, ...AUTHOR }, f.seed, "add", "-A");
      git({ ...f.env, ...AUTHOR }, f.seed, "commit", "-q", "-m", "tybo 2.15.1");
      git(f.env, f.seed, "push", "-q", "origin", "master");
      const r = await install(f, shell);
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("weicht vom Stand auf origin/master ab (eigene Commits)");
    }, T);

    test("ignorierte Datei, die der neue Stand verwalten will: Abbruch, Datei bleibt", async () => {
      const f = await fixture();
      await writeTree(f.clone, { "models/README.md": "eigene Notiz\n" });
      await rebuild(f, { "models/README.md": "# Modelle\n" });
      const r = await install(f, shell);
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("würde Dateien in");
      expect(r.stderr).toContain(" models/README.md.");
      expect(head(f)).toBe(f.oldHead);
      expect(await read(f, "models/README.md")).toBe("eigene Notiz\n");
    }, T);

    test("Reflog von origin/master leer, Versionstag aus dem Klon da: Neuaufbau trotzdem erkannt", async () => {
      const f = await fixture();
      git(f.env, f.clone, "reflog", "expire", "--expire=now", "--all");
      await rebuild(f);
      const r = await install(f, shell);
      expect(r.exit).toBe(0);
      expect(head(f)).toBe(f.newHead);
    }, T);

    test("weder Reflog noch Versionstag: gilt als eigener Stand, Abbruch", async () => {
      const f = await fixture();
      git(f.env, f.clone, "reflog", "expire", "--expire=now", "--all");
      git(f.env, f.clone, "tag", "-d", "v2.15.0");
      await rebuild(f);
      const r = await install(f, shell);
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain("eigene Commits auf der alten Historie");
      expect(head(f)).toBe(f.oldHead);
    }, T);
  });
}
