/**
 * Issue #45: Dateiablage in data/outbox/<id>/<Name>. Der Name wird
 * bereinigt, Pfadanteile (../, absolute Pfade, Backslashes) landen nie
 * außerhalb des Ablageordners.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve, sep } from "path";
import { outboxPath, sanitizeFileName, sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import type { Message } from "../src/lib/supabase";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ATTACKS = [
  "../../etc/passwd",
  "../geheim.txt",
  "/etc/passwd",
  "/Users/alex/.env",
  "..\\..\\windows\\system32\\x.dll",
  "C:\\temp\\a.txt",
  "..",
  ".",
  "...",
  ".env",
  "a/../../b.txt",
  "",
  "   ",
  "\u0000\u0001",
];

describe("sanitizeFileName", () => {
  test("behält nur den letzten Namensteil, ohne Pfad", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("/etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("..\\..\\windows\\x.dll")).toBe("x.dll");
    expect(sanitizeFileName("C:\\temp\\a.txt")).toBe("a.txt");
    expect(sanitizeFileName("a/../../b.txt")).toBe("b.txt");
  });

  test("führende Punkte weg, leere Namen werden zu datei", () => {
    expect(sanitizeFileName(".env")).toBe("env");
    expect(sanitizeFileName("..")).toBe("datei");
    expect(sanitizeFileName(".")).toBe("datei");
    expect(sanitizeFileName("")).toBe("datei");
    expect(sanitizeFileName("   ")).toBe("datei");
    expect(sanitizeFileName("\u0000\u0001")).toBe("datei");
    expect(sanitizeFileName("ordner/")).toBe("datei");
  });

  test("Umlaute und übliche Zeichen bleiben, Sonderzeichen werden _", () => {
    expect(sanitizeFileName("Bericht Übersicht (v2).pdf")).toBe("Bericht Übersicht (v2).pdf");
    expect(sanitizeFileName('a<b>:c"|?*.txt')).toBe("a_b__c____.txt");
    expect(sanitizeFileName("zeile\numbruch.txt")).toBe("zeileumbruch.txt");
  });

  test("lange Namen werden gekürzt, die Endung bleibt", () => {
    const name = sanitizeFileName("x".repeat(300) + ".html");
    expect(name.length).toBe(120);
    expect(name.endsWith(".html")).toBe(true);
  });
});

describe("outboxPath", () => {
  test("jeder Angriffsname landet direkt in <Ablage>/<id>/", () => {
    const root = "/tmp/outbox-root";
    for (const raw of ATTACKS) {
      const path = outboxPath(root, ID, raw);
      expect(dirname(path)).toBe(resolve(root, ID));
      expect(path.startsWith(resolve(root, ID) + sep)).toBe(true);
    }
  });

  test("ungültige Ablage-ID wird abgelehnt", () => {
    for (const id of ["../x", "", "/etc", "0f8fad5b-d9cb-469f-a165-70867728950e/.."]) {
      expect(() => outboxPath("/tmp/outbox-root", id, "a.txt")).toThrow();
    }
  });
});

describe("sendAndRecord mit Angriffsnamen", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "outbox-files-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("fileName mit ../ oder absolutem Pfad schreibt nur in data/outbox/<id>/", async () => {
    const outboxDir = join(dir, "data", "outbox");
    const source = join(dir, "quelle.txt");
    writeFileSync(source, "Inhalt");
    const recorded: Message[] = [];
    const deps: OutboxDeps = {
      botToken: "123:t",
      userId: "4711",
      groupId: null,
      outboxDir,
      fetch: async () => new Response("{}", { status: 200 }),
      record: async m => {
        recorded.push(m);
        return true;
      },
      log: () => {},
      newId: () => crypto.randomUUID(),
    };

    for (const fileName of ATTACKS) {
      const result = await sendAndRecord({ file: source, fileName, source: "datei" }, deps);
      expect(result.sent).toBe(true);
      const stored = result.file!;
      expect(dirname(stored.path)).toBe(resolve(outboxDir, stored.id));
      expect(stored.name).not.toContain("/");
      expect(stored.name).not.toContain("\\");
      expect(stored.name.startsWith(".")).toBe(false);
    }

    // Außerhalb der Ablage ist nichts entstanden
    expect(readdirSync(dir).sort()).toEqual(["data", "quelle.txt"]);
    expect(readdirSync(join(dir, "data"))).toEqual(["outbox"]);
    expect(existsSync(join(dir, "geheim.txt"))).toBe(false);
    expect(readdirSync(outboxDir)).toHaveLength(ATTACKS.length);
    for (const id of readdirSync(outboxDir)) expect(readdirSync(join(outboxDir, id))).toHaveLength(1);
    // Festgehalten wird der bereinigte Name
    expect(recorded.map(m => (m.metadata!.file as { name: string }).name)).toContain("passwd");
  });

  test("ohne fileName zählt nur der Name der Quelldatei, nicht ihr Ordner", async () => {
    const outboxDir = join(dir, "outbox");
    const nested = join(dir, "tief", "ordner");
    const { mkdirSync } = await import("fs");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "bericht.pdf"), "%PDF");
    const deps: OutboxDeps = {
      botToken: "123:t",
      userId: "4711",
      groupId: null,
      outboxDir,
      fetch: async () => new Response("{}", { status: 200 }),
      record: async () => true,
      log: () => {},
      newId: () => ID,
    };
    const result = await sendAndRecord({ file: join(nested, "..", "ordner", "bericht.pdf"), source: "datei" }, deps);
    expect(result.file?.path).toBe(join(resolve(outboxDir), ID, "bericht.pdf"));
    expect(result.file?.id).toBe(ID);
  });
});
