/**
 * Issue #134, Schritt 2: Klon-URL und Remote-Erkennung aus BRAND.repo,
 * setup/upgrade.ts und setup/install.ts darauf umgestellt. Upgrade läuft in
 * einer temporären Installation; git, bun install und launchctl sind
 * Attrappen, es startet kein echter Befehl.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/brand";
import { githubRepoPath, isBrandRepoUrl, repoCloneUrl } from "../src/lib/repo-remote";
import { runUpgrade, type RunResult } from "../setup/upgrade";
import { checkGitRepo } from "../setup/install";

const URL = "https://github.com/cloudnutzer/tybo.git";

describe("BRAND.repo und Klon-URL", () => {
  test("Repo und HTTPS-Klon-URL", () => {
    expect(BRAND.repo).toBe("cloudnutzer/tybo");
    expect(repoCloneUrl()).toBe(URL);
  });

  test("erkannt: HTTPS und SSH, mit und ohne .git, Schrägstrich am Ende, Groß- und Kleinschreibung", () => {
    for (const url of [
      "https://github.com/cloudnutzer/tybo.git",
      "https://github.com/cloudnutzer/tybo",
      "https://github.com/cloudnutzer/tybo/",
      "https://user@github.com/cloudnutzer/tybo.git",
      "https://github.com/CloudNutzer/Tybo.git",
      "git@github.com:cloudnutzer/tybo.git",
      "git@github.com:cloudnutzer/tybo",
      "ssh://git@github.com/cloudnutzer/tybo.git",
      "ssh://git@github.com/cloudnutzer/tybo",
      "  https://github.com/cloudnutzer/tybo.git\n",
    ])
      expect(isBrandRepoUrl(url)).toBe(true);
  });

  test("nicht erkannt: falscher Host, ähnlich benannter Pfad, anderes Repo", () => {
    for (const url of [
      "https://gitlab.com/cloudnutzer/tybo.git",
      "https://github.com.evil.example/cloudnutzer/tybo.git",
      "https://evil.example/github.com/cloudnutzer/tybo.git",
      "https://evil.example?@github.com/cloudnutzer/tybo.git",
      "https://evil.example#@github.com/cloudnutzer/tybo.git",
      "ssh://git@evil.example?@github.com/cloudnutzer/tybo.git",
      "https://github.com/cloudnutzer/tybo.git?x=1",
      "https://github.com/x/../cloudnutzer/tybo.git",
      "https://github.com:8443/cloudnutzer/tybo.git",
      "git@evil.example:github.com:cloudnutzer/tybo.git",
      "git@gitlab.com:cloudnutzer/tybo.git",
      "https://github.com/cloudnutzer/tybo-fork.git",
      "https://github.com/xcloudnutzer/tybo.git",
      "https://github.com/cloudnutzer/tybo/extra.git",
      "https://github.com/someone/cloudnutzer/tybo.git",
      "git@github.com:cloudnutzer/tybo.git.bak",
      "https://github.com/other/project.git",
      "",
    ])
      expect(isBrandRepoUrl(url)).toBe(false);
  });

  test("README: Klon-Befehl passt zu BRAND.repo", async () => {
    const readme = await Bun.file(join(import.meta.dir, "..", "README.md")).text();
    expect(readme).toContain(`git clone ${repoCloneUrl()}\ncd ${BRAND.repo.split("/")[1]}\n`);
    expect(readme.match(/git clone \S+/g)).toEqual([`git clone ${repoCloneUrl()}`]);
  });

  test("githubRepoPath liefert besitzer/repo", () => {
    expect(githubRepoPath("git@github.com:a/b.git")).toBe("a/b");
    expect(githubRepoPath("https://github.com/a/b")).toBe("a/b");
    expect(githubRepoPath("/lokaler/pfad")).toBeNull();
  });
});

describe("setup/upgrade.ts", () => {
  let root: string;
  let calls: string[][];
  let lines: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tybo-upgrade-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
    calls = [];
    lines = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Attrappe: origin und vorhandene Remotes je Fall, alles andere klappt */
  function fakeRun(opts: { origin?: string; remotes?: string[] } = {}) {
    return async (cmd: string[]): Promise<RunResult> => {
      calls.push(cmd);
      const ok = (stdout = ""): RunResult => ({ ok: true, stdout, stderr: "" });
      const [bin, ...args] = cmd;
      if (bin === "git" && args.join(" ") === "remote get-url origin")
        return opts.origin ? ok(opts.origin) : { ok: false, stdout: "", stderr: "No such remote" };
      if (bin === "git" && args.join(" ") === "remote") return ok((opts.remotes ?? ["origin"]).join("\n"));
      if (bin === "git" && args[0] === "branch" && args[1] === "--show-current") return ok("master");
      if (bin === "git" && args[0] === "pull") return ok("Already up to date.");
      if (bin === "git" || bin === "bun" || bin === "launchctl") return ok();
      throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
    };
  }

  const upgrade = (run: ReturnType<typeof fakeRun>) => runUpgrade({ root, run, platform: "darwin", log: (l = "") => lines.push(l) });
  const has = (cmd: string) => calls.some(c => c.join(" ") === cmd);
  const remoteUrls = () => calls.filter(c => c[0] === "git" && c[1] === "remote" && ["add", "set-url"].includes(c[2])).map(c => c[4]);

  test("ZIP ohne .git: git init, origin = BRAND.repo, bun install und launchctl nur als Attrappe", async () => {
    expect(await upgrade(fakeRun())).toBe(0);
    expect(has("git init")).toBe(true);
    expect(has(`git remote add origin ${URL}`)).toBe(true);
    expect(has("git fetch origin master")).toBe(true);
    expect(has("bun install")).toBe(true);
    expect(has("launchctl list")).toBe(true);
    expect(remoteUrls()).toEqual([URL]);
    expect(lines.join("\n")).toContain(`Connected to ${URL}`);
  });

  for (const origin of [URL, "git@github.com:cloudnutzer/tybo.git", "ssh://git@github.com/cloudnutzer/tybo"]) {
    test(`origin auf BRAND.repo (${origin}): nur pull, kein neues Remote`, async () => {
      mkdirSync(join(root, ".git"));
      expect(await upgrade(fakeRun({ origin }))).toBe(0);
      expect(has("git pull origin master")).toBe(true);
      expect(remoteUrls()).toEqual([]);
    });
  }

  test("fremdes origin: upstream = BRAND.repo kommt dazu, origin bleibt", async () => {
    mkdirSync(join(root, ".git"));
    expect(await upgrade(fakeRun({ origin: "https://github.com/someone/tybo-fork.git" }))).toBe(0);
    expect(has(`git remote add upstream ${URL}`)).toBe(true);
    expect(has("git fetch upstream master")).toBe(true);
    expect(calls.some(c => c.includes("origin") && ["add", "set-url"].includes(c[2]))).toBe(false);
    expect(lines.join("\n")).toContain(`Remote doesn't point to ${BRAND.repo}, adding upstream`);
  });

  for (const origin of ["https://evil.example?@github.com/cloudnutzer/tybo.git", "https://evil.example#@github.com/cloudnutzer/tybo.git"]) {
    test(`origin auf fremdem Host (${origin}): upstream = BRAND.repo statt pull von origin`, async () => {
      mkdirSync(join(root, ".git"));
      expect(await upgrade(fakeRun({ origin }))).toBe(0);
      expect(has(`git remote add upstream ${URL}`)).toBe(true);
      expect(has("git fetch upstream master")).toBe(true);
      expect(has("git pull origin master")).toBe(false);
    });
  }

  test("fremdes origin mit vorhandenem upstream: upstream wird auf BRAND.repo gesetzt", async () => {
    mkdirSync(join(root, ".git"));
    expect(await upgrade(fakeRun({ origin: "https://gitlab.com/x/y.git", remotes: ["origin", "upstream"] }))).toBe(0);
    expect(has(`git remote set-url upstream ${URL}`)).toBe(true);
    expect(has(`git remote add upstream ${URL}`)).toBe(false);
    expect(has("git fetch upstream master")).toBe(true);
  });

  test("ein Remote namens upstream-alt zählt nicht als upstream", async () => {
    mkdirSync(join(root, ".git"));
    expect(await upgrade(fakeRun({ origin: "https://gitlab.com/x/y.git", remotes: ["origin", "upstream-alt"] }))).toBe(0);
    expect(has(`git remote add upstream ${URL}`)).toBe(true);
  });

  test("fehlgeschlagenes Upgrade gibt Exit-Code 1 zurück statt den Prozess zu beenden", async () => {
    const run = async (cmd: string[]): Promise<RunResult> => {
      calls.push(cmd);
      return cmd[0] === "git" && cmd[1] === "init" ? { ok: false, stdout: "", stderr: "kaputt" } : { ok: true, stdout: "", stderr: "" };
    };
    expect(await runUpgrade({ root, run, platform: "linux", log: () => {} })).toBe(1);
  });
});

describe("setup/install.ts", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tybo-install-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const log = console.log;
    console.log = () => {};
    try {
      return await fn();
    } finally {
      console.log = log;
    }
  };
  const origin = (url: string) => async () => ({ ok: true, stdout: url, stderr: "" });

  test("origin auf BRAND.repo (HTTPS und SSH) gilt als verbunden, fremdes nicht", async () => {
    mkdirSync(join(root, ".git"));
    expect(await quiet(() => checkGitRepo(root, origin(URL)))).toBe(true);
    expect(await quiet(() => checkGitRepo(root, origin("git@github.com:cloudnutzer/tybo.git")))).toBe(true);
    expect(await quiet(() => checkGitRepo(root, origin("https://github.com/cloudnutzer/tybo-fork.git")))).toBe(false);
  });

  test("ohne .git kein Aufruf von git", async () => {
    let called = false;
    const run = async () => {
      called = true;
      return { ok: true, stdout: URL, stderr: "" };
    };
    expect(await quiet(() => checkGitRepo(root, run))).toBe(false);
    expect(called).toBe(false);
  });
});
