/**
 * Issue #59, Schritt 1: brand.ts und die Schlüsseldatei für den
 * Terminal-Zugang (Rechte 0600, atomarer Austausch, Lebenszyklus mit dem
 * Web-Server). Alles in einem temporären Ordner, nie data/cli-token.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/brand";
import { createCliToken, defaultCliTokenFile, readCliToken } from "../src/web/cli-token";
import { createWebServer } from "../src/web/server";

const PASSWORD = "test-passwort-lang";
const root = await mkdtemp(join(tmpdir(), "tybo-cli-token-"));
let counter = 0;

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function mode(info: { mode: number }): number {
  return info.mode & 0o777;
}

function startServer(cliTokenFile: string, port = 0, logs: string[] = []) {
  const n = ++counter;
  return createWebServer(
    { host: "127.0.0.1", port, password: PASSWORD, allowedHosts: [] },
    { sessionFile: join(root, `sessions-${n}.json`), dataDir: join(root, `web-${n}`), cliTokenFile, log: m => logs.push(m) }
  );
}

describe("brand.ts", () => {
  test("Name, Befehl und Domain an einer Stelle", () => {
    expect(BRAND).toEqual({ name: "tybo", cli: "tybo", domain: "tybo.ai", repo: "cloudnutzer/tybo" });
  });
});

describe("Schlüsseldatei", () => {
  test("neu angelegt: 32 Byte zufällig (base64url), Rechte 0600, Ordner 0700", async () => {
    const file = join(root, `neu-${++counter}`, "data", "cli-token");
    const token = await createCliToken(file);
    const value = await readFile(file, "utf8");
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(value, "base64url").length).toBe(32);
    expect(mode(await stat(file))).toBe(0o600);
    expect(mode(await stat(join(file, "..")))).toBe(0o700);
    expect(token.matches(value)).toBe(true);
    expect(token.matches(value.slice(0, -1) + (value.endsWith("A") ? "B" : "A"))).toBe(false);
    expect(token.matches("")).toBe(false);
    expect(token.matches(undefined)).toBe(false);
    // Die Kennung für Live-Verbindungen verrät den Schlüssel nicht
    expect(token.sessionId).not.toContain(value);
  });

  test("ersetzt eine vorhandene Datei mit weiten Rechten atomar durch 0600, ohne Reste", async () => {
    const dir = join(root, `ersetzen-${++counter}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "cli-token");
    await writeFile(file, "alter-schluessel");
    await chmod(file, 0o644);
    await createCliToken(file);
    expect(mode(await stat(file))).toBe(0o600);
    expect(await readFile(file, "utf8")).not.toBe("alter-schluessel");
    expect(await readdir(dir)).toEqual(["cli-token"]);
  });

  test("jeder Aufruf erzeugt einen anderen Schlüssel; remove macht ihn ungültig", async () => {
    const file = join(root, `rotation-${++counter}`, "cli-token");
    const first = await createCliToken(file);
    const firstValue = (await readCliToken(file))!;
    await first.remove();
    expect(first.isActive()).toBe(false);
    expect(first.matches(firstValue)).toBe(false);
    expect(await readCliToken(file)).toBeNull();
    const second = await createCliToken(file);
    const secondValue = (await readCliToken(file))!;
    expect(secondValue).not.toBe(firstValue);
    expect(second.matches(firstValue)).toBe(false);
    expect(second.matches(secondValue)).toBe(true);
  });

  test("remove löscht nicht den Schlüssel eines neueren Servers", async () => {
    const file = join(root, `fremd-${++counter}`, "cli-token");
    const older = await createCliToken(file);
    await createCliToken(file);
    const newer = await readCliToken(file);
    await older.remove();
    expect(await readCliToken(file)).toBe(newer);
  });

  test("Standardpfad: data/cli-token im Projekt", () => {
    expect(defaultCliTokenFile("/projekt")).toBe(join("/projekt", "data", "cli-token"));
  });
});

describe("Lebenszyklus mit dem Web-Server", () => {
  test("Start legt die Datei an (0600), Stopp löscht sie, Neustart erzeugt einen neuen Schlüssel", async () => {
    const file = join(root, `server-${++counter}`, "cli-token");
    const first = await startServer(file);
    const firstValue = await readCliToken(file);
    expect(firstValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mode(await stat(file))).toBe(0o600);
    await first.stop();
    expect(await readCliToken(file)).toBeNull();

    const second = await startServer(file);
    try {
      const secondValue = await readCliToken(file);
      expect(secondValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(secondValue).not.toBe(firstValue);
    } finally {
      await second.stop();
    }
  });

  test("ohne cliTokenFile: keine Datei (bestehende Aufrufer und Tests)", async () => {
    const dir = join(root, `ohne-${++counter}`);
    await mkdir(dir, { recursive: true });
    const n = ++counter;
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      { sessionFile: join(dir, `sessions-${n}.json`), dataDir: join(dir, "web"), log: () => {} }
    );
    await server.stop();
    expect(await readdir(dir)).not.toContain("cli-token");
  });

  test("Startfehler (Port belegt): der Schlüssel des laufenden Servers bleibt unverändert", async () => {
    const file = join(root, `belegt-${++counter}`, "cli-token");
    const first = await startServer(file);
    try {
      const before = await readCliToken(file);
      const port = Number(new URL(first.url).port);
      await expect(startServer(file, port)).rejects.toThrow();
      expect(await readCliToken(file)).toBe(before);
    } finally {
      await first.stop();
    }
  });

  test("Datei nicht schreibbar: Server läuft trotzdem, Log ohne Schlüssel", async () => {
    const blocker = join(root, `blockiert-${++counter}`);
    await writeFile(blocker, "keine Verzeichnis");
    const logs: string[] = [];
    const server = await startServer(join(blocker, "cli-token"), 0, logs);
    try {
      expect((await fetch(`${server.url}/login`)).status).toBe(200);
      expect(logs.join("\n")).toContain("Terminal-Zugang nicht verfügbar");
    } finally {
      await server.stop();
    }
  });
});
