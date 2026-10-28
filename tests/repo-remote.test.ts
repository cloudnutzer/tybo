/**
 * Issue #134, Schritt 2: Klon-URL und Remote-Erkennung aus BRAND.repo (den
 * Git-Hinweis der Einrichtung prüft tests/setup-git-hint.test.ts, Issue #305).
 * setup/upgrade.ts ist seit Issue #374 entfernt (E12), Updates macht der
 * zweite Lauf von install.sh (tests/install-sh.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "../src/brand";
import { githubRepoPath, isBrandRepoUrl, repoCloneUrl } from "../src/lib/repo-remote";

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
    // Nach cd darf ein Kommentar stehen (Issue #381), der Ordner muss der des Klons sein
    const clone = readme.slice(readme.indexOf(`git clone ${repoCloneUrl()}\n`));
    expect(clone.split("\n")[1].replace(/\s+#.*$/, "")).toBe(`cd ${BRAND.repo.split("/")[1]}`);
    expect(readme.match(/git clone \S+/g)).toEqual([`git clone ${repoCloneUrl()}`]);
  });

  test("githubRepoPath liefert besitzer/repo", () => {
    expect(githubRepoPath("git@github.com:a/b.git")).toBe("a/b");
    expect(githubRepoPath("https://github.com/a/b")).toBe("a/b");
    expect(githubRepoPath("/lokaler/pfad")).toBeNull();
  });
});

test("setup/upgrade.ts und das Skript upgrade gibt es nicht mehr (E12, Issue #374)", async () => {
  const root = join(import.meta.dir, "..");
  expect(existsSync(join(root, "setup", "upgrade.ts"))).toBe(false);
  const pkg = await Bun.file(join(root, "package.json")).json();
  expect(Object.keys(pkg.scripts)).not.toContain("upgrade");
});
