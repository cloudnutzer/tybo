/**
 * Issue #305, Checkbox 1: Hinweis im Schritt voraussetzungen, ob der
 * Projektordner mit BRAND.repo verbunden ist. Er ist keine Pflicht: Der
 * Git-Eintrag bleibt ok, solange git da ist. git ist eine Attrappe, die
 * origin-URL erscheint nie in der Ausgabe.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTybo } from "../scripts/tybo";
import { BRAND } from "../src/brand";
import type { SetupContext } from "../src/setup/context";
import { prerequisitesStep, REPO_LINK_FIX } from "../src/setup/steps/prerequisites";
import { allText, cleanup, fakeRun, makeCtx } from "./setup-fixture";
import { scripted } from "./setup-terminal-fixture";

afterAll(cleanup);

const HTTPS = `https://github.com/${BRAND.repo}.git`;
const SSH = `git@github.com:${BRAND.repo}.git`;
const FORK = `https://github.com/${BRAND.repo}-fork.git`;
/** origin mit Zugangsdaten: darf nirgends auftauchen */
const WITH_TOKEN = "https://x-access-token:geheim-123@example.org/someone/tybo.git";

type GitDir = "ordner" | "datei" | "keins";

/** Kontext mit git-Attrappe; origin undefined: kein origin (git meldet Fehler) */
async function ctxWith(options: { gitDir: GitDir; origin?: string }) {
  const answers: Record<string, { stdout?: string; code?: number; stderr?: string }> = {
    "git --version": { stdout: "git version 2.50.0" },
    "git remote get-url origin":
      options.origin === undefined ? { code: 2, stderr: "error: No such remote 'origin'" } : { stdout: `${options.origin}\n` },
  };
  const ctx = await makeCtx({ overrides: { run: fakeRun(answers) } });
  if (options.gitDir === "ordner") await mkdir(join(ctx.root, ".git"));
  // Worktree: .git ist eine Datei
  if (options.gitDir === "datei") await writeFile(join(ctx.root, ".git"), "gitdir: /anderswo/.git/worktrees/x\n");
  return ctx;
}

const gitItem = async (ctx: SetupContext) => (await prerequisitesStep.status(ctx)).items!.find(i => i.label === "Git")!;
const originCalls = (ctx: { run: { calls: string[][] } }) => ctx.run.calls.filter(c => c.join(" ") === "git remote get-url origin");

describe("Schritt voraussetzungen: Verbindung mit BRAND.repo", () => {
  test("HTTPS- und SSH-URL von BRAND.repo gilt als verbunden, ohne Abhilfe", async () => {
    for (const origin of [HTTPS, SSH]) {
      const ctx = await ctxWith({ gitDir: "ordner", origin });
      const item = await gitItem(ctx);
      expect(item.ok).toBe(true);
      expect(item.detail).toBe(`Git 2.50.0. Verbunden mit ${BRAND.repo}.`);
      expect(item.fix).toBeUndefined();
    }
  });

  test("Fork gilt nicht als verbunden: Hinweis mit Abhilfe, ok bleibt true, Schritt erledigt", async () => {
    const ctx = await ctxWith({ gitDir: "ordner", origin: FORK });
    const status = await prerequisitesStep.status(ctx);
    const item = status.items!.find(i => i.label === "Git")!;
    expect(item.ok).toBe(true);
    expect(item.detail).toBe(`Git 2.50.0. origin zeigt nicht auf ${BRAND.repo}, Updates von dort kommen so nicht an. Danach .env, config/ und data/ in den neuen Ordner kopieren.`);
    expect(item.fix).toBe(REPO_LINK_FIX);
    expect(status.state).toBe("erledigt");
    expect(allText(status)).not.toContain(FORK);
  });

  test("Issue #374: Abhilfe ist der Installer in einen eigenen Ordner, nicht mehr bun run upgrade", () => {
    expect(REPO_LINK_FIX).toBe(`curl -fsSL https://${BRAND.domain}/install | sh -s -- --dir ~/tybo-neu`);
    expect(REPO_LINK_FIX).not.toContain("upgrade");
  });

  test("ohne .git kein git-Aufruf für die Verbindung; Hinweis auf ZIP-Download, Schritt erledigt", async () => {
    const ctx = await ctxWith({ gitDir: "keins", origin: HTTPS });
    const status = await prerequisitesStep.status(ctx);
    const item = status.items!.find(i => i.label === "Git")!;
    expect(originCalls(ctx)).toEqual([]);
    expect(ctx.run.calls).toEqual([["git", "--version"]]);
    expect(item.ok).toBe(true);
    expect(item.detail).toContain("kein Git-Ordner (etwa ein ZIP-Download)");
    expect(item.fix).toBe(REPO_LINK_FIX);
    expect(status.state).toBe("erledigt");
  });

  test("ohne origin: eigener Hinweis, ok bleibt true", async () => {
    const ctx = await ctxWith({ gitDir: "ordner" });
    const item = await gitItem(ctx);
    expect(originCalls(ctx)).toHaveLength(1);
    expect(item.ok).toBe(true);
    expect(item.detail).toBe(`Git 2.50.0. Der Ordner hat kein origin, mit ${BRAND.repo} ist er nicht verbunden. Danach .env, config/ und data/ in den neuen Ordner kopieren.`);
    expect(item.fix).toBe(REPO_LINK_FIX);
  });

  test(".git als Datei (Worktree) zählt als Git-Ordner", async () => {
    const ctx = await ctxWith({ gitDir: "datei", origin: SSH });
    const item = await gitItem(ctx);
    expect(originCalls(ctx)).toHaveLength(1);
    expect(item.detail).toBe(`Git 2.50.0. Verbunden mit ${BRAND.repo}.`);
  });

  test("git fehlt: keine Verbindungsprüfung, Abhilfe wie bisher", async () => {
    const ctx = await makeCtx({ overrides: { run: fakeRun() } });
    await mkdir(join(ctx.root, ".git"));
    const item = await gitItem(ctx);
    expect(item.ok).toBe(false);
    expect(item.detail).toBe("Git nicht gefunden.");
    expect(item.fix).toBe("xcode-select --install");
    expect(ctx.run.calls).toEqual([["git", "--version"]]);
  });

  test("origin-URL mit Zugangsdaten erscheint weder in status noch in test", async () => {
    const ctx = await ctxWith({ gitDir: "ordner", origin: WITH_TOKEN });
    const status = await prerequisitesStep.status(ctx);
    const result = await prerequisitesStep.test!({}, ctx);
    for (const text of [allText(status), allText(result)]) {
      expect(text).not.toContain("geheim-123");
      expect(text).not.toContain("example.org");
    }
    expect(result.ok).toBe(true);
  });

  test("git läuft im Projektordner", async () => {
    const ctx = await makeCtx();
    await mkdir(join(ctx.root, ".git"));
    const seen: { cmd: string; cwd?: string }[] = [];
    ctx.run = (async (cmd: string[], opts?: { cwd?: string }) => {
      seen.push({ cmd: cmd.join(" "), cwd: opts?.cwd });
      return { code: 0, stdout: cmd[1] === "--version" ? "git version 2.50.0" : HTTPS, stderr: "" };
    }) as any;
    await gitItem(ctx);
    expect(seen.find(s => s.cmd === "git remote get-url origin")?.cwd).toBe(ctx.root);
  });
});

describe("Ausgabe im Terminal", () => {
  async function tyboSetup(args: string[], ctx: SetupContext) {
    const out: string[] = [];
    const code = await runTybo({
      args: ["setup", ...args],
      env: {},
      root: ctx.root,
      out: l => out.push(l),
      err: l => out.push(l),
      setup: { ctx, prompter: scripted([]), onInterrupt: () => () => {} },
    });
    return { code, out: out.join("\n") };
  }

  test("Übersicht (--liste): Schritt erledigt, Hinweis und Abhilfe sichtbar, keine URL", async () => {
    const ctx = await ctxWith({ gitDir: "ordner", origin: WITH_TOKEN });
    await writeFile(ctx.envPath, "");
    const r = await tyboSetup(["--liste"], ctx);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1\. Voraussetzungen\s+erledigt/);
    expect(r.out).toContain(`Hinweis Git: Git 2.50.0. origin zeigt nicht auf ${BRAND.repo}`);
    expect(r.out).toContain(`Git: ${REPO_LINK_FIX}`);
    expect(r.out).not.toContain("geheim-123");
  });

  test("Schritt voraussetzungen: bestanden, Hinweis mit „So geht's“", async () => {
    const ctx = await ctxWith({ gitDir: "keins" });
    await writeFile(ctx.envPath, "");
    const r = await tyboSetup(["voraussetzungen"], ctx);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Verbindungstest: bestanden. Alles da, Claude CLI ist angemeldet.");
    expect(r.out).toContain("ok  Git: Git 2.50.0. Der Ordner ist kein Git-Ordner (etwa ein ZIP-Download)");
    expect(r.out).toContain(`So geht's: ${REPO_LINK_FIX}`);
  });

  test("verbunden: keine Abhilfe in der Übersicht", async () => {
    const ctx = await ctxWith({ gitDir: "ordner", origin: HTTPS });
    await writeFile(ctx.envPath, "");
    const r = await tyboSetup(["--liste"], ctx);
    expect(r.out).not.toContain("Hinweis Git");
    expect(r.out).not.toContain(REPO_LINK_FIX);
  });
});
