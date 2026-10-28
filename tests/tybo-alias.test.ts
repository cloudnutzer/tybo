/**
 * Issue #142: `tybo` ist der einzige Befehl. Den früheren Befehl gibt es
 * nicht mehr, weder als Skript noch in package.json, und die gespeicherte
 * Gesprächswahl liegt unter ~/.config/tybo (Ordnername aus BRAND.cli); ein
 * früherer Ordner wird nicht gelesen. Der Befehl läuft als eigener Prozess
 * aus einem fremden Arbeitsverzeichnis mit eigener .env, die er nicht lesen
 * darf (--no-env-file). src/bot.ts wird nie gestartet.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BRAND } from "../src/brand";
import * as brand from "../src/brand";
import { loadState, saveState, stateFile } from "../src/terminal/state";
import { OLD_CLI } from "./old-names";

const REPO = resolve(import.meta.dir, "..");
const CLI = join(REPO, "scripts", "tybo.ts");
const base = await mkdtemp(join(tmpdir(), "tybo-command-"));
const foreign = join(base, "anderswo");
const home = join(base, "home");
const root = join(base, "projekt");
await mkdir(foreign, { recursive: true });
await mkdir(home, { recursive: true });
await mkdir(join(root, "data"), { recursive: true });
await writeFile(join(foreign, ".env"), "WEB_ENABLED=true\nWEB_PASSWORD=falsches-passwort-123\nWEB_PORT=1\n");
await writeFile(join(root, ".env"), "");

afterAll(() => rm(base, { recursive: true, force: true }));

/** Direkt über den Shebang, wie nach bun link */
async function run(args: string[]) {
  const env = { PATH: process.env.PATH ?? "", HOME: home, TYBO_ROOT: root };
  const proc = Bun.spawn([CLI, ...args], { cwd: foreign, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe("tybo ist der einzige Befehl", () => {
  test("BRAND heißt tybo, kein Eintrag für einen früheren Befehl", () => {
    expect(BRAND).toEqual({ name: "tybo", cli: "tybo", domain: "tybo.ai", repo: "cloudnutzer/tybo" });
    expect(Object.keys(brand).sort()).toEqual(["BRAND", "OPENROUTER_APP_HEADERS"]);
  });

  test("package.json: genau ein Eintrag in bin (tybo), kein Skript für den früheren Befehl", async () => {
    const pkg = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));
    expect(pkg.bin).toEqual({ tybo: "scripts/tybo.ts" });
    expect(Object.keys(pkg.scripts)).not.toContain(OLD_CLI);
    expect(Object.values<string>(pkg.scripts).some(cmd => cmd.includes(OLD_CLI))).toBe(false);
  });

  test("kein Skript für den früheren Befehl", () => {
    expect(existsSync(join(REPO, "scripts", `${OLD_CLI}.ts`))).toBe(false);
  });

  test("tybo ausführbar mit Bun-Shebang ohne .env des Arbeitsverzeichnisses", async () => {
    expect((await Bun.file(CLI).text()).startsWith("#!/usr/bin/env -S bun --no-env-file\n")).toBe(true);
    expect((await stat(CLI)).mode & 0o111).not.toBe(0);
  });

  test("tybo --help: Exit 0, Hilfe mit tybo, kein Hinweis und kein früherer Name", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.split("\n")[0]).toBe("tybo im Terminal");
    expect(r.stdout).toContain("  tybo setup ");
    expect(r.stdout).not.toContain(OLD_CLI);
  });

  test("tybo mit unbekanntem Befehl: Exit 2, ohne WebUI in der Projekt-.env: Exit 1, nicht die fremde .env", async () => {
    expect((await run(["quatsch"])).code).toBe(2);
    const chat = await run([]);
    expect(chat.code).toBe(1);
    expect(chat.stderr).toContain("tybo braucht die WebUI");
    expect(chat.stderr).not.toContain(foreign);
    expect(chat.stderr).not.toContain(OLD_CLI);
  });

  test("Importieren startet den Befehl nicht", async () => {
    // Käme main() zum Zug, hätte process.exit den Testlauf beendet
    expect(typeof (await import("../scripts/tybo")).main).toBe("function");
  });
});

describe("Gespeicherte Gesprächswahl unter ~/.config/tybo", () => {
  test("Datei liegt im Ordner aus BRAND.cli", () => {
    expect(stateFile("/h")).toBe(join("/h", ".config", "tybo", "state.json"));
    expect(stateFile("/h", true)).toBe(join("/h", ".config", "tybo", "state-dev.json"));
    expect(stateFile("/h")).toBe(join("/h", ".config", BRAND.cli, "state.json"));
  });

  test("Speichern und Lesen unter ~/.config/tybo", async () => {
    const h = join(base, "neu");
    expect(await saveState(stateFile(h), { conversationId: "topic-7" })).toBe(true);
    expect(await loadState(stateFile(h))).toEqual({ conversationId: "topic-7" });
    expect(existsSync(join(h, ".config", "tybo", "state.json"))).toBe(true);
  });

  test("eine Wahl im früheren Ordner wird nicht gelesen", async () => {
    const h = join(base, "bestand");
    const old = join(h, ".config", OLD_CLI);
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "state.json"), JSON.stringify({ conversationId: "topic-42" }));
    expect(await loadState(stateFile(h))).toEqual({});
    expect(await loadState(stateFile(h, true))).toEqual({});
  });
});
