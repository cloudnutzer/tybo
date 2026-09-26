/**
 * Issue #62, Checkbox 1: .env sicher schreiben (src/lib/env-file.ts).
 * Alle Dateien liegen in einem temporären Ordner, nie die echte .env.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnvFile } from "../scripts/tybo";
import { loadEnv } from "../src/lib/env";
import {
  applyEnvChange,
  deleteEnvValue,
  encodeEnvValue,
  EnvFileError,
  envValueProblem,
  parseEnvContent,
  readEnvFile,
  setEnvValue,
} from "../src/lib/env-file";

const root = await mkdtemp(join(tmpdir(), "tybo-env-file-"));
afterAll(() => rm(root, { recursive: true, force: true }));

let counter = 0;
/** Eigener Ordner pro Fall mit .env */
async function envDir(content?: string, mode = 0o600): Promise<string> {
  const dir = join(root, `case-${++counter}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, ".env");
  if (content !== undefined) await writeFile(path, content, { mode });
  return path;
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function backups(envPath: string): Promise<string[]> {
  return (await readdir(join(dirname(envPath), "data", "backups")).catch(() => [])).sort();
}

async function leftovers(envPath: string): Promise<string[]> {
  return (await readdir(dirname(envPath))).filter(f => f.endsWith(".tmp") || f.endsWith(".lock"));
}

const SAMPLE = [
  "# ============",
  "# tybo",
  "# ============",
  "",
  "# --- REQUIRED ---",
  "TELEGRAM_BOT_TOKEN=bot-token-platzhalter",
  "TELEGRAM_USER_ID=12345",
  "",
  "# OpenRouter (cloud fallback)",
  "# OPENROUTER_API_KEY=sk-or-v1-your_key_here",
  "OPENROUTER_MODEL=minimax/minimax-m2.7 # inline, gehört für den Lader zum Wert",
  "",
  "ANTHROPIC_API_KEY=alter-wert-1234",
  "",
  "# Ende",
  "",
].join("\n");

describe("Werte kodieren und wieder laden", () => {
  const tricky = [
    "einfach-123",
    "mit leerzeichen",
    "wert#mit#raute",
    "wert # kommentar-ähnlich",
    "it's",
    'sagt "hallo"',
    "beides ' und \"",
    "back\\slash\\",
    "\\\"",
    "dollar $HOME und ${PATH}",
    "  führende und folgende Leerzeichen  ",
    "a=b=c",
    "'schon in einfachen'",
    '"schon in doppelten"',
    "`backtick`",
    "ümlaut ß €",
  ];

  test.each(tricky)("%p: Schreiben und Laden ergeben denselben Wert (env.ts, tybo, parseEnvContent)", async value => {
    const path = await envDir("# Kopf\n");
    await setEnvValue(path, "ROUNDTRIP_TEST_VALUE", value);
    expect((await readEnvFile(path)).ROUNDTRIP_TEST_VALUE).toBe(value);
    expect(parseEnvFile(await readFile(path, "utf8")).ROUNDTRIP_TEST_VALUE).toBe(value);
    const before = process.env.ROUNDTRIP_TEST_VALUE;
    try {
      await loadEnv(path);
      expect(process.env.ROUNDTRIP_TEST_VALUE).toBe(value);
    } finally {
      if (before === undefined) delete process.env.ROUNDTRIP_TEST_VALUE;
      else process.env.ROUNDTRIP_TEST_VALUE = before;
    }
  });

  test("einfache Werte ohne Anführungszeichen, Leerzeichen und # mit", () => {
    expect(encodeEnvValue("sk-or-v1-abc_DEF.123")).toBe("sk-or-v1-abc_DEF.123");
    expect(encodeEnvValue("https://x.supabase.co/path?a")).toBe("'https://x.supabase.co/path?a'");
    expect(encodeEnvValue("a b")).toBe("'a b'");
    expect(encodeEnvValue("a#b")).toBe("'a#b'");
    expect(encodeEnvValue("$X")).toBe("'$X'");
    expect(encodeEnvValue("it's")).toBe('"it\'s"');
    expect(encodeEnvValue('it\'s "x" \\')).toBe('"it\'s \\"x\\" \\\\"');
  });

  test("bisherige Lesart bleibt: unquotierte Werte wörtlich, # im Wert gehört dazu, letzte Zeile gewinnt", () => {
    expect(parseEnvContent("# x\nA=1\n B = zwei=drei \nleer\nC=x # y\nA=2\n")).toEqual({ A: "2", B: "zwei=drei", C: "x # y" });
    expect(parseEnvContent("A='x'\nB=\"y\"\nC='\nD=\"\"")).toEqual({ A: "x", B: "y", C: "'", D: "" });
  });

  test("Zeilenumbrüche, Steuerzeichen, leer und zu lang werden abgelehnt, ohne den Wert zu nennen", () => {
    for (const bad of ["a\nb", "a\rb", "a\r\nb", "\n", "tab\tx", "nul\u0000", "del\u007f", "", "x".repeat(8193)]) {
      expect(envValueProblem(bad)).not.toBeNull();
      expect(() => encodeEnvValue(bad)).toThrow(EnvFileError);
    }
    expect(envValueProblem(123)).not.toBeNull();
    try {
      encodeEnvValue("geheim-9876\nX=1");
    } catch (e) {
      expect((e as Error).message).not.toContain("geheim");
    }
  });
});

describe("Inhalt ändern", () => {
  test("Setzen einer vorhandenen Variable ändert nur ihre Zeile", () => {
    const { content, changed } = applyEnvChange(SAMPLE, "ANTHROPIC_API_KEY", "neu wert");
    expect(changed).toBe(true);
    const before = SAMPLE.split("\n");
    const after = content.split("\n");
    expect(after.length).toBe(before.length);
    const diff = after.map((l, i) => (l === before[i] ? null : i)).filter(i => i !== null);
    expect(diff).toEqual([before.indexOf("ANTHROPIC_API_KEY=alter-wert-1234")]);
    expect(after[diff[0]!]).toBe("ANTHROPIC_API_KEY='neu wert'");
  });

  test("Löschen entfernt nur die Zeile, Kommentare und Leerzeilen bleiben", () => {
    const { content } = applyEnvChange(SAMPLE, "ANTHROPIC_API_KEY", null);
    expect(content).toBe(SAMPLE.replace("ANTHROPIC_API_KEY=alter-wert-1234\n", ""));
  });

  test("Zeile mit Inline-Kommentar: andere bleiben unverändert, die ersetzte behält ihren Kommentar", () => {
    const set = applyEnvChange(SAMPLE, "ANTHROPIC_API_KEY", "x").content;
    expect(set).toContain("OPENROUTER_MODEL=minimax/minimax-m2.7 # inline, gehört für den Lader zum Wert\n");
    const replaced = applyEnvChange(SAMPLE, "OPENROUTER_MODEL", "other/model").content;
    expect(replaced).toContain("\nOPENROUTER_MODEL='other/model' # inline, gehört für den Lader zum Wert\n");
    expect(parseEnvContent(replaced).OPENROUTER_MODEL).toBe("other/model");
    // Erneutes Ersetzen: Kommentar bleibt, nicht doppelt
    const again = applyEnvChange(replaced, "OPENROUTER_MODEL", "dritt/model").content;
    expect(again).toContain("\nOPENROUTER_MODEL='dritt/model' # inline, gehört für den Lader zum Wert\n");
    expect(again.match(/# inline/g)?.length).toBe(1);
  });

  test("Raute ohne Leerraum davor ist kein Inline-Kommentar", () => {
    const replaced = applyEnvChange("AB=wert#mit#raute\n", "AB", "neu").content;
    expect(replaced).toBe("AB=neu\n");
  });

  test.each([
    ["einfacher Wert", "other/model"],
    ["Raute im Wert", "wert # mit raute"],
    ["Raute ohne Leerraum", "wert#raute"],
    ["einfaches Anführungszeichen und Raute", "it's # x"],
    ["doppeltes Anführungszeichen", 'sagt "hallo" # x'],
  ])("Inline-Kommentar bleibt, neuer Wert lädt richtig (%s): env.ts, tybo, parseEnvContent", async (_, value) => {
    const path = await envDir("# Kopf\nINLINE_TEST_VALUE=alt # mein Kommentar\nNACH=1\n");
    await setEnvValue(path, "INLINE_TEST_VALUE", value);
    const content = await readFile(path, "utf8");
    expect(content).toMatch(/^INLINE_TEST_VALUE=.* # mein Kommentar$/m);
    expect(content.startsWith("# Kopf\n")).toBe(true);
    expect(content.endsWith("\nNACH=1\n")).toBe(true);
    expect((await readEnvFile(path)).INLINE_TEST_VALUE).toBe(value);
    expect(parseEnvFile(content).INLINE_TEST_VALUE).toBe(value);
    const before = process.env.INLINE_TEST_VALUE;
    try {
      await loadEnv(path);
      expect(process.env.INLINE_TEST_VALUE).toBe(value);
    } finally {
      if (before === undefined) delete process.env.INLINE_TEST_VALUE;
      else process.env.INLINE_TEST_VALUE = before;
    }
  });

  test("auskommentierte Zeilen zählen nicht als gesetzt und bleiben", () => {
    const { content } = applyEnvChange(SAMPLE, "OPENROUTER_API_KEY", "sk-or-neu");
    expect(content).toContain("# OPENROUTER_API_KEY=sk-or-v1-your_key_here\n");
    expect(content.endsWith("# Ende\nOPENROUTER_API_KEY=sk-or-neu\n")).toBe(true);
    expect(applyEnvChange(SAMPLE, "OPENROUTER_API_KEY", null)).toEqual({ content: SAMPLE, changed: false });
  });

  test("neue Variable hinter der letzten derselben Gruppe, ohne Gruppe am Dateiende", () => {
    const groupOf = (n: string) => ({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_USER_ID: "t", TELEGRAM_BOT_TOKEN_RESEARCH: "t", ANTHROPIC_API_KEY: "l", OPENAI_API_KEY: "l" } as Record<string, string>)[n];
    const grouped = applyEnvChange(SAMPLE, "TELEGRAM_BOT_TOKEN_RESEARCH", "abc", { groupOf }).content;
    expect(grouped).toContain("TELEGRAM_USER_ID=12345\nTELEGRAM_BOT_TOKEN_RESEARCH=abc\n\n# OpenRouter");
    const llm = applyEnvChange(SAMPLE, "OPENAI_API_KEY", "abc", { groupOf }).content;
    expect(llm).toContain("ANTHROPIC_API_KEY=alter-wert-1234\nOPENAI_API_KEY=abc\n");
    const unknown = applyEnvChange(SAMPLE, "EIGENER_WERT", "abc", { groupOf }).content;
    expect(unknown).toBe(`${SAMPLE}EIGENER_WERT=abc\n`);
    // Gruppe bekannt, aber keine Variable davon in der Datei: Dateiende
    const none = applyEnvChange("# nur Kommentar\n", "OPENAI_API_KEY", "abc", { groupOf }).content;
    expect(none).toBe("# nur Kommentar\nOPENAI_API_KEY=abc\n");
  });

  test("CRLF bleibt erhalten, neue Zeilen bekommen CRLF", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    const set = applyEnvChange(crlf, "ANTHROPIC_API_KEY", "neu").content;
    expect(set).toBe(crlf.replace("ANTHROPIC_API_KEY=alter-wert-1234", "ANTHROPIC_API_KEY=neu"));
    const added = applyEnvChange(crlf, "NEU_VAR", "x").content;
    expect(added).toBe(`${crlf}NEU_VAR=x\r\n`);
    expect(applyEnvChange(crlf, "ANTHROPIC_API_KEY", null).content).toBe(crlf.replace("ANTHROPIC_API_KEY=alter-wert-1234\r\n", ""));
    expect(parseEnvContent(set).ANTHROPIC_API_KEY).toBe("neu");
  });

  test("fehlender Schlussumbruch bleibt fehlend", () => {
    const noEol = "# k\nA_VAR=1\nB_VAR=2";
    expect(applyEnvChange(noEol, "B_VAR", "3").content).toBe("# k\nA_VAR=1\nB_VAR=3");
    expect(applyEnvChange(noEol, "C_VAR", "4").content).toBe("# k\nA_VAR=1\nB_VAR=2\nC_VAR=4");
    expect(applyEnvChange(noEol, "B_VAR", null).content).toBe("# k\nA_VAR=1");
    expect(applyEnvChange(noEol, "A_VAR", null).content).toBe("# k\nB_VAR=2");
  });

  test("doppelte Namen: die letzte (wirksame) Zeile wird ersetzt, die übrigen entfernt; Löschen entfernt alle", () => {
    const dup = "A_VAR=erst\n# zwischen\nA_VAR=zweit\nB_VAR=b\n";
    expect(applyEnvChange(dup, "A_VAR", "neu").content).toBe("# zwischen\nA_VAR=neu\nB_VAR=b\n");
    expect(applyEnvChange(dup, "A_VAR", null).content).toBe("# zwischen\nB_VAR=b\n");
  });

  test("gleicher Wert: keine Änderung", () => {
    expect(applyEnvChange(SAMPLE, "TELEGRAM_USER_ID", "12345")).toEqual({ content: SAMPLE, changed: false });
  });

  test("ungültige Namen werden abgelehnt", () => {
    for (const name of ["", "a", "lower_case", "1ABC", "A-B", "A B", "ABC\n", `A${"B".repeat(64)}`, "A", "Ä_KEY"]) {
      expect(() => applyEnvChange(SAMPLE, name, "x")).toThrow(EnvFileError);
    }
  });
});

describe("Datei schreiben", () => {
  test("Setzen: Sicherung mit altem Inhalt (0600), Ergebnis 0600, sonst identisch", async () => {
    const path = await envDir(SAMPLE, 0o644);
    const result = await setEnvValue(path, "ANTHROPIC_API_KEY", "sk-ant-neu", { now: () => new Date("2026-09-24T21:05:57.123Z") });
    expect(result.changed).toBe(true);
    expect(result.backup).toBe(join(dirname(path), "data", "backups", "env-2026-09-24T21-05-57-123Z"));
    expect(await readFile(result.backup!, "utf8")).toBe(SAMPLE);
    expect(await mode(result.backup!)).toBe(0o600);
    expect(await mode(path)).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe(SAMPLE.replace("alter-wert-1234", "sk-ant-neu"));
    expect(await leftovers(path)).toEqual([]);
  });

  test("Löschen mit Sicherung; nicht gesetzte Variable: nichts geschrieben, keine Sicherung", async () => {
    const path = await envDir(SAMPLE);
    const result = await deleteEnvValue(path, "ANTHROPIC_API_KEY");
    expect(result.changed).toBe(true);
    expect(await readFile(path, "utf8")).toBe(SAMPLE.replace("ANTHROPIC_API_KEY=alter-wert-1234\n", ""));
    expect((await backups(path)).length).toBe(1);
    expect(await deleteEnvValue(path, "ANTHROPIC_API_KEY")).toEqual({ changed: false, backup: null });
    expect((await backups(path)).length).toBe(1);
  });

  test("unveränderter Wert: kein Schreiben, keine Sicherung", async () => {
    const path = await envDir(SAMPLE);
    expect(await setEnvValue(path, "TELEGRAM_USER_ID", "12345")).toEqual({ changed: false, backup: null });
    expect(await backups(path)).toEqual([]);
  });

  test("fehlende .env: Setzen legt sie mit 0600 ohne Sicherung an, Löschen legt nichts an", async () => {
    const path = await envDir();
    expect(await deleteEnvValue(path, "X_VAR")).toEqual({ changed: false, backup: null });
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await setEnvValue(path, "X_VAR", "wert")).toEqual({ changed: true, backup: null });
    expect(await readFile(path, "utf8")).toBe("X_VAR=wert\n");
    expect(await mode(path)).toBe(0o600);
  });

  test("Sicherungen haben eindeutige Namen, auch zur selben Zeit", async () => {
    const path = await envDir(SAMPLE);
    const now = () => new Date("2026-09-24T10:00:00.000Z");
    const a = await setEnvValue(path, "A_VAR", "1", { now });
    const b = await setEnvValue(path, "A_VAR", "2", { now });
    const c = await setEnvValue(path, "A_VAR", "3", { now });
    expect(new Set([a.backup, b.backup, c.backup]).size).toBe(3);
    expect(await readFile(c.backup!, "utf8")).toContain("A_VAR=2");
    expect((await backups(path)).length).toBe(3);
  });

  test("temporäre Datei liegt im Zielordner und ist von Anfang an 0600", async () => {
    const path = await envDir(SAMPLE);
    const seen: { dir: string; mode: number }[] = [];
    await setEnvValue(path, "A_VAR", "1", {
      io: {
        writeFile: async (p, data, options) => {
          await writeFile(p, data, options);
          if (p.endsWith(".tmp")) seen.push({ dir: dirname(p), mode: await mode(p) });
        },
      },
    });
    expect(seen).toEqual([{ dir: dirname(path), mode: 0o600 }]);
  });

  test("Sicherung scheitert: .env unverändert, nichts liegen gelassen", async () => {
    const path = await envDir(SAMPLE);
    const blocker = join(dirname(path), "kein-ordner");
    await writeFile(blocker, "x");
    await expect(setEnvValue(path, "ANTHROPIC_API_KEY", "neu", { backupDir: join(blocker, "sub") })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(SAMPLE);
    expect(await leftovers(path)).toEqual([]);
  });

  test("Schreiben der temporären Datei scheitert: .env unverändert", async () => {
    const path = await envDir(SAMPLE);
    const io = {
      writeFile: async (p: string, data: string, options: { mode: number; flag: string }) => {
        if (p.endsWith(".tmp")) {
          await writeFile(p, data.slice(0, 5), options);
          throw new Error("Platte voll");
        }
        await writeFile(p, data, options);
      },
    };
    await expect(setEnvValue(path, "ANTHROPIC_API_KEY", "neu", { io })).rejects.toThrow("Platte voll");
    expect(await readFile(path, "utf8")).toBe(SAMPLE);
    expect(await leftovers(path)).toEqual([]);
  });

  test("Umbenennen scheitert: .env unverändert, temporäre Datei entfernt", async () => {
    const path = await envDir(SAMPLE);
    await expect(
      setEnvValue(path, "ANTHROPIC_API_KEY", "neu", { io: { rename: async () => { throw new Error("EXDEV"); } } })
    ).rejects.toThrow("EXDEV");
    expect(await readFile(path, "utf8")).toBe(SAMPLE);
    expect(await mode(path)).toBe(0o600);
    expect(await leftovers(path)).toEqual([]);
  });

  test("ungültiger Wert: kein Schreiben, keine Sicherung", async () => {
    const path = await envDir(SAMPLE);
    await expect(setEnvValue(path, "ANTHROPIC_API_KEY", "a\nTELEGRAM_USER_ID=1")).rejects.toThrow(EnvFileError);
    expect(await readFile(path, "utf8")).toBe(SAMPLE);
    expect(await backups(path)).toEqual([]);
  });

  test("parallele Änderungen gehen nicht verloren", async () => {
    const path = await envDir(SAMPLE);
    const names = Array.from({ length: 12 }, (_, i) => `PARALLEL_${i}`);
    await Promise.all(names.map((n, i) => setEnvValue(path, n, `wert-${i}`)));
    const env = await readEnvFile(path);
    for (const [i, n] of names.entries()) expect(env[n]).toBe(`wert-${i}`);
    expect(env.ANTHROPIC_API_KEY).toBe("alter-wert-1234");
    expect((await backups(path)).length).toBe(12);
    expect(await leftovers(path)).toEqual([]);
  });

  test("Sperre eines anderen Prozesses wird abgewartet", async () => {
    const path = await envDir(SAMPLE);
    // Sperre wie von einem lebenden anderen Prozess (eigene PID lebt)
    await writeFile(`${path}.lock`, JSON.stringify({ token: "fremd", pid: process.pid }));
    await expect(setEnvValue(path, "A_VAR", "1", { lockWaitMs: 100 })).rejects.toThrow("belegt");
    expect(await readFile(path, "utf8")).toBe(SAMPLE);
    await rm(`${path}.lock`);
    await setEnvValue(path, "A_VAR", "1");
    expect((await readEnvFile(path)).A_VAR).toBe("1");
  });

  test(".env als Verweis wird nicht verändert", async () => {
    const path = await envDir();
    const target = join(dirname(path), "echte-env");
    await writeFile(target, SAMPLE);
    await symlink(target, path);
    await expect(setEnvValue(path, "A_VAR", "1")).rejects.toThrow(EnvFileError);
    expect(await readFile(target, "utf8")).toBe(SAMPLE);
  });
});
