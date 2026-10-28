/**
 * Issue #382: Verhalten des .env-Laders (src/lib/env.ts), festgehalten vor
 * dem Neuschreiben. Werte aus der Datei überschreiben, was schon in der
 * Umgebung steht; eine fehlende oder unlesbare Datei ändert still nichts;
 * PROJECT_ROOT kommt beim Import aus GO_PROJECT_ROOT, sonst aus dem
 * Arbeitsverzeichnis, und ohne Pfad liest loadEnv die .env dort.
 * Alle Dateien liegen in einem temporären Ordner, nie die echte .env.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadEnv } from "../src/lib/env";

const root = await realpath(await mkdtemp(join(tmpdir(), "tybo-env-loader-")));
afterAll(() => rm(root, { recursive: true, force: true }));

const NAMES = ["TYBO_T382_A", "TYBO_T382_B", "TYBO_T382_C"];
afterEach(() => {
  for (const name of NAMES) delete process.env[name];
});

const ENV_MODULE = resolve(import.meta.dir, "..", "src", "lib", "env.ts");

/** Startet bun in cwd, importiert den Lader und gibt PROJECT_ROOT und einen geladenen Wert aus */
function probe(cwd: string, extraEnv: Record<string, string>): { root: string; value: string | null } {
  const script = [
    `const m = await import(${JSON.stringify(ENV_MODULE)});`,
    "await m.loadEnv();",
    "console.log(JSON.stringify({ root: m.PROJECT_ROOT, value: process.env.TYBO_T382_A ?? null }));",
  ].join("\n");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== "GO_PROJECT_ROOT") env[key] = value;
  const run = Bun.spawnSync({ cmd: [process.execPath, "-e", script], cwd, env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString().trim());
}

describe("loadEnv mit Pfad", () => {
  test("setzt die Werte der Datei und überschreibt vorhandene", async () => {
    const path = join(root, "a.env");
    await writeFile(path, 'TYBO_T382_A=aus-datei\nTYBO_T382_B="mit Leerzeichen"\n');
    process.env.TYBO_T382_A = "vorher";
    process.env.TYBO_T382_C = "bleibt";
    await loadEnv(path);
    expect(process.env.TYBO_T382_A).toBe("aus-datei");
    expect(process.env.TYBO_T382_B).toBe("mit Leerzeichen");
    expect(process.env.TYBO_T382_C).toBe("bleibt");
  });

  test("fehlende Datei: kein Fehler, Umgebung unverändert", async () => {
    process.env.TYBO_T382_A = "vorher";
    await expect(loadEnv(join(root, "gibt-es-nicht.env"))).resolves.toBeUndefined();
    expect(process.env.TYBO_T382_A).toBe("vorher");
  });

  test("unlesbarer Pfad (ein Ordner): kein Fehler, Umgebung unverändert", async () => {
    const dir = join(root, "ordner.env");
    await mkdir(dir, { recursive: true });
    process.env.TYBO_T382_A = "vorher";
    await expect(loadEnv(dir)).resolves.toBeUndefined();
    expect(process.env.TYBO_T382_A).toBe("vorher");
  });
});

describe("PROJECT_ROOT und loadEnv ohne Pfad", () => {
  test("mit GO_PROJECT_ROOT: Wurzel von dort, .env von dort", async () => {
    const project = join(root, "projekt");
    const elsewhere = join(root, "anderswo");
    await mkdir(project, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(project, ".env"), "TYBO_T382_A=aus-projekt\n");
    await writeFile(join(elsewhere, ".env"), "TYBO_T382_A=aus-arbeitsordner\n");
    expect(probe(elsewhere, { GO_PROJECT_ROOT: project })).toEqual({ root: project, value: "aus-projekt" });
  });

  test("ohne GO_PROJECT_ROOT: Arbeitsverzeichnis", async () => {
    const cwd = join(root, "nur-cwd");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, ".env"), "TYBO_T382_A=aus-cwd\n");
    expect(probe(cwd, {})).toEqual({ root: cwd, value: "aus-cwd" });
  });

  test("leeres GO_PROJECT_ROOT zählt wie keins", async () => {
    const cwd = join(root, "leer");
    await mkdir(cwd, { recursive: true });
    expect(probe(cwd, { GO_PROJECT_ROOT: "" })).toEqual({ root: cwd, value: null });
  });
});
