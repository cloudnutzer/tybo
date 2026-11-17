/**
 * Issue #526: Nachtcheck sucht Bot-Tokens in logs/. Nur in einem
 * Testordner, kein echter Nachtcheck-Lauf (der ruft launchctl und schreibt
 * Zustand). Alle Tokens sind erfunden.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CHUNK_BYTES, evaluateTokenScan, MAX_RUN_BYTES, MAX_UNPACKED_BYTES, scanLogsForTokens as scanWithClock, StreamCounter } from "../src/lib/log-token-scan";
import { TOKEN_MASK } from "../src/lib/telegram-token-mask";
import { checkTokenInLogs, plannedChecks, type MaintenanceCheckDeps } from "../src/health-check";

const MAIN = "123456789:AAFakeHauptTokenNurFuerTests_abcdefgh";
const AGENT = "987654321:AAFakeAgentTokenNurFuerTests-ijklmnop";
// Nicht mehr in der Umgebung, nur am Muster erkennbar
const OLD = "555555555:AAFakeAltesTokenNurFuerTests_qrstuvwx";
// Weicht vom Muster ab, nur als bekannter Wert erkennbar
const ODD = "42:kurzesFakeToken";
const MiB = 1024 * 1024;

// Inhalts- und Größentests haben eine feste Uhr: Rechnerlast darf nicht die
// Zeitgrenze vor der geprüften Bytegrenze auslösen. Der Zeitlimit-Test gibt
// seine fortschreitende Uhr ausdrücklich mit.
const scanLogsForTokens: typeof scanWithClock = (dir, tokens, options) =>
  scanWithClock(dir, tokens, { now: () => 0, ...options });

const dirs: string[] = [];
const locked: string[] = [];
function logsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tybo-token-scan-"));
  dirs.push(dir);
  return dir;
}
function lock(path: string): void {
  chmodSync(path, 0o000);
  locked.push(path);
}
afterEach(() => {
  for (const path of locked.splice(0)) {
    try {
      chmodSync(path, 0o700);
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const leak = (token: string) => `  path: "https://api.telegram.org/bot${token}/sendMessage",\n`;
// Als root wäre alles lesbar; dann lassen sich unlesbare Einträge nicht nachstellen
const isRoot = process.getuid?.() === 0;

describe("scanLogsForTokens", () => {
  test("Treffer ergibt Warnung mit Fundort und Anzahl, nie die Fundzeile", async () => {
    const dir = logsDir();
    writeFileSync(join(dir, "telegram-relay.error.log"), "Fehler\n" + leak(MAIN) + leak(OLD) + "weiter\n");
    writeFileSync(join(dir, "telegram-relay.log"), "alles gut\n");
    const scan = await scanLogsForTokens(dir, [MAIN]);
    expect(scan.hits).toEqual([{ file: "telegram-relay.error.log", count: 2 }]);
    const check = evaluateTokenScan(scan);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("telegram-relay.error.log (2x)");
    expect(JSON.stringify(check)).not.toContain("AAFake");
    expect(JSON.stringify(check)).not.toContain("api.telegram.org");
  });

  test("maskierter Pfad ist kein Treffer", async () => {
    const dir = logsDir();
    writeFileSync(join(dir, "telegram-relay.error.log"), leak(TOKEN_MASK).repeat(11));
    const check = evaluateTokenScan(await scanLogsForTokens(dir, [MAIN]));
    expect(check).toEqual({ status: "ok", detail: "keine Fundstelle in 1 Datei(en)" });
  });

  test("bekannter Wert abseits des Musters, Unterordner und .gz-Archive", async () => {
    const dir = logsDir();
    mkdirSync(join(dir, "routinen"));
    writeFileSync(join(dir, "routinen", "checkin.log"), `bot${encodeURIComponent(ODD)}/getMe\n`);
    writeFileSync(join(dir, "telegram-relay.error.log.1.gz"), gzipSync(leak(OLD)));
    const scan = await scanLogsForTokens(dir, [ODD]);
    expect(scan.hits).toEqual([
      { file: "routinen/checkin.log", count: 1 },
      { file: "telegram-relay.error.log.1.gz", count: 1 },
    ]);
  });

  test("große Datei: Token an einer Stückgrenze wird genau einmal gezählt", async () => {
    const dir = logsDir();
    const filler = "x".repeat(99) + "\n";
    // Das Token liegt über der 1-MiB-Grenze
    const before = filler.repeat(Math.floor((CHUNK_BYTES - 30) / filler.length));
    const pad = "y".repeat(CHUNK_BYTES - 30 - before.length);
    writeFileSync(join(dir, "gross.log"), before + pad + leak(MAIN) + filler.repeat(20_000) + leak(OLD));
    expect((await scanLogsForTokens(dir, [])).hits).toEqual([{ file: "gross.log", count: 2 }]);
  });

  test("lange Zeile ohne Zeilenumbruch: Token kurz vor jeder Schnittstelle wird genau einmal gezählt", async () => {
    const dir = logsDir();
    // Erste Teilung in einem Lauf ohne Trennzeichen: sobald er MAX_RUN_BYTES
    // überschreitet (nach fünf Stücken), 1024 Zeichen vor dem Ende
    const runEnd = MAX_RUN_BYTES + CHUNK_BYTES;
    const starts = {
      // der vom Prüfer nachgestellte Fall: 5 Bytes vor 5 MiB minus 512 Bytes
      "pruefer.log": 5 * MiB - 512 - 5,
      "teilung.log": runEnd - 1024 - 5,
      "stueck.log": 4 * CHUNK_BYTES - 5,
    };
    for (const [name, start] of Object.entries(starts)) {
      writeFileSync(join(dir, name), "x".repeat(start) + MAIN + "/sendMessage" + "x".repeat(2 * CHUNK_BYTES));
    }
    const scan = await scanLogsForTokens(dir, [MAIN]);
    expect(scan.hits).toEqual([
      { file: "pruefer.log", count: 1 },
      { file: "stueck.log", count: 1 },
      { file: "teilung.log", count: 1 },
    ]);
    expect(scan.skipped).toEqual([]);
  });

  test("überlappende Treffer in einer 5-MiB-Zeile: beide Tokens zählen, in 1-MiB-Stücken", async () => {
    // Das Muster reicht vom ersten Token über die x bis in die Kennung des
    // zweiten; die Teilung nach fünf Stücken fällt in das zweite Token
    const line = (first: string, second: string) => first + "x".repeat(5 * MiB - first.length - second.length - 1000) + second + "y".repeat(1000);
    const dir = logsDir();
    for (const [name, first, second] of [
      ["haupt-zuerst.log", MAIN, AGENT],
      ["agent-zuerst.log", AGENT, MAIN],
    ] as const) {
      const text = line(first, second);
      expect(text.length).toBe(5 * MiB);
      writeFileSync(join(dir, name), text + "\n");
      // derselbe Scanner direkt, Stück für Stück
      const counter = new StreamCounter([MAIN, AGENT]);
      const bytes = Buffer.from(text + "\n", "latin1");
      for (let i = 0; i < bytes.length; i += CHUNK_BYTES) counter.push(bytes.subarray(i, i + CHUNK_BYTES));
      expect(counter.end()).toBe(2);
    }
    const scan = await scanLogsForTokens(dir, [MAIN, AGENT]);
    expect(scan.hits).toEqual([
      { file: "agent-zuerst.log", count: 2 },
      { file: "haupt-zuerst.log", count: 2 },
    ]);
    expect(scan.skipped).toEqual([]);
  });

  test("Unterordner jeder Tiefe werden geprüft", async () => {
    const dir = logsDir();
    const deep = join(dir, "a", "b", "c", "d", "e");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "datei.log"), leak(MAIN));
    const deeper = join(dir, ...Array.from({ length: 30 }, (_, i) => `t${i}`));
    mkdirSync(deeper, { recursive: true });
    writeFileSync(join(deeper, "ganz-unten.log"), leak(OLD));
    const scan = await scanLogsForTokens(dir, []);
    expect(scan.hits.map(h => h.file)).toEqual(["a/b/c/d/e/datei.log", join(...Array.from({ length: 30 }, (_, i) => `t${i}`), "ganz-unten.log")]);
    expect(scan.skipped).toEqual([]);
    expect(evaluateTokenScan(scan).status).toBe("warn");
  });

  test("symbolische Links werden nicht verfolgt, aber als nicht geprüft gemeldet", async () => {
    const dir = logsDir();
    const outside = logsDir();
    writeFileSync(join(outside, "fremd.log"), "nichts\n");
    symlinkSync(join(outside, "fremd.log"), join(dir, "link.log"));
    writeFileSync(join(dir, "ok.log"), "nichts\n");
    const check = evaluateTokenScan(await scanLogsForTokens(dir, []));
    expect(check).toEqual({ status: "warn", detail: "keine Fundstelle in 1 Datei(en); nicht geprüft: link.log (symbolischer Link, nicht verfolgt)" });
  });

  test("Logrotation: verschwundene Datei und verschwundener Ordner betreffen nur sich selbst", async () => {
    const dir = logsDir();
    writeFileSync(join(dir, "a-vorher.log"), leak(MAIN));
    writeFileSync(join(dir, "telegram-relay.error.log"), "wird rotiert\n");
    writeFileSync(join(dir, "z-nachher.log"), leak(OLD));
    mkdirSync(join(dir, "alt"));
    writeFileSync(join(dir, "alt", "x.log"), "nichts\n");
    mkdirSync(join(dir, "bleibt"));
    writeFileSync(join(dir, "bleibt", "y.log"), leak(OLD));
    const scan = await scanLogsForTokens(dir, [], {
      beforeRead: path => {
        // die Rotation schlägt zwischen Auflisten und Lesen zu
        if (path.endsWith("telegram-relay.error.log")) rmSync(path);
        if (path.endsWith("alt")) rmSync(path, { recursive: true });
      },
    });
    expect(scan.missing).toBe(false);
    expect(scan.hits).toEqual([
      { file: "a-vorher.log", count: 1 },
      { file: "bleibt/y.log", count: 1 },
      { file: "z-nachher.log", count: 1 },
    ]);
    expect(scan.skipped).toEqual([
      { file: "alt", reason: "während der Prüfung verschwunden (Logrotation?)" },
      { file: "telegram-relay.error.log", reason: "während der Prüfung verschwunden (Logrotation?)" },
    ]);
    expect(scan.scanned).toBe(3);
    const check = evaluateTokenScan(scan);
    expect(check.status).toBe("warn");
    expect(check.detail).toStartWith("3 Fundstelle(n) in a-vorher.log (1x), bleibt/y.log (1x), z-nachher.log (1x); nicht geprüft: alt (");
  });

  test.skipIf(isRoot)("unlesbarer Unterordner: Nachbardateien werden weiter geprüft", async () => {
    const dir = logsDir();
    mkdirSync(join(dir, "gesperrt"));
    writeFileSync(join(dir, "gesperrt", "geheim.log"), leak(MAIN));
    lock(join(dir, "gesperrt"));
    mkdirSync(join(dir, "offen"));
    writeFileSync(join(dir, "offen", "a.log"), leak(OLD));
    writeFileSync(join(dir, "z.log"), "nichts\n");
    const scan = await scanLogsForTokens(dir, []);
    expect(scan.hits).toEqual([{ file: "offen/a.log", count: 1 }]);
    expect(scan.skipped).toEqual([{ file: "gesperrt", reason: "Ordner nicht lesbar" }]);
    expect(scan.scanned).toBe(2);
    expect(evaluateTokenScan(scan).detail).toBe("1 Fundstelle(n) in offen/a.log (1x); nicht geprüft: gesperrt (Ordner nicht lesbar)");
  });

  test("fehlender Ordner und unlesbare Datei werden nachvollziehbar gemeldet", async () => {
    expect(evaluateTokenScan(await scanLogsForTokens(join(tmpdir(), "tybo-gibt-es-nicht-526")))).toEqual({ status: "na", detail: "kein Ordner logs/" });
    if (isRoot) return;
    const dir = logsDir();
    writeFileSync(join(dir, "ok.log"), "nichts\n");
    writeFileSync(join(dir, "gesperrt.log"), leak(MAIN));
    lock(join(dir, "gesperrt.log"));
    const scan = await scanLogsForTokens(dir, []);
    expect(scan.skipped).toEqual([{ file: "gesperrt.log", reason: "Datei nicht lesbar" }]);
    const check = evaluateTokenScan(scan);
    expect(check.status).toBe("warn");
    expect(check.detail).toBe("keine Fundstelle in 1 Datei(en); nicht geprüft: gesperrt.log (Datei nicht lesbar)");
  });

  test("kaputtes .gz-Archiv wird gemeldet", async () => {
    const dir = logsDir();
    writeFileSync(join(dir, "alt.log.gz"), "kein gzip");
    writeFileSync(join(dir, "abgeschnitten.log.gz"), gzipSync(leak(MAIN).repeat(1000)).subarray(0, 200));
    const scan = await scanLogsForTokens(dir, []);
    expect(scan.skipped.map(s => s.file)).toEqual(["abgeschnitten.log.gz", "alt.log.gz"]);
    for (const s of scan.skipped) expect(s.reason).toBe("kein gültiges Archiv");
    expect(scan.scanned).toBe(0);
  });
});

describe("Archive: entpackt begrenzt", () => {
  // Kleines Archiv, großer Inhalt: viele gzip-Glieder hintereinander, je 1 MiB Nullen
  const member = gzipSync(Buffer.alloc(MiB));
  const bomb = (members: number, head = "") => Buffer.concat([gzipSync(head), ...Array.from({ length: members }, () => member)]);

  test("genau an der Grenze wird vollständig geprüft", async () => {
    const dir = logsDir();
    writeFileSync(join(dir, "passt.log.gz"), Buffer.concat([member, member, gzipSync(leak(MAIN))]));
    const limit = 2 * MiB + Buffer.byteLength(leak(MAIN));
    const scan = await scanLogsForTokens(dir, [], { maxUnpackedBytes: limit });
    expect(scan).toEqual({ missing: false, scanned: 1, hits: [{ file: "passt.log.gz", count: 1 }], skipped: [] });
  });

  test("ein Byte darüber: Anfang geprüft, Überschreitung gemeldet", async () => {
    const dir = logsDir();
    writeFileSync(join(dir, "zu-gross.log.gz"), bomb(3, leak(MAIN)));
    const scan = await scanLogsForTokens(dir, [], { maxUnpackedBytes: 3 * MiB + Buffer.byteLength(leak(MAIN)) - 1 });
    expect(scan.hits).toEqual([{ file: "zu-gross.log.gz", count: 1 }]);
    expect(scan.skipped).toEqual([{ file: "zu-gross.log.gz", reason: "entpackt größer als 3 MiB, nur der Anfang geprüft" }]);
    expect(scan.scanned).toBe(0);
    expect(evaluateTokenScan(scan).detail).toBe(
      "1 Fundstelle(n) in zu-gross.log.gz (1x); nicht geprüft: zu-gross.log.gz (entpackt größer als 3 MiB, nur der Anfang geprüft)"
    );
  });

  test("Archiv von unter 1 MB, entpackt über der Standardgrenze: abgebrochen und gemeldet", async () => {
    const dir = logsDir();
    const file = bomb(MAX_UNPACKED_BYTES / MiB + 8);
    expect(file.length).toBeLessThan(1_000_000);
    writeFileSync(join(dir, "bombe.log.gz"), file);
    writeFileSync(join(dir, "daneben.log"), leak(OLD));
    const scan = await scanLogsForTokens(dir, []);
    expect(scan.hits).toEqual([{ file: "daneben.log", count: 1 }]);
    expect(scan.skipped).toEqual([{ file: "bombe.log.gz", reason: "entpackt größer als 512 MiB, nur der Anfang geprüft" }]);
  }, 120_000);

  test("Größenprüfung mit Zeitsprung der Echtzeituhr: Bytegrenze und Nachbardatei werden geprüft", async () => {
    const dir = logsDir();
    writeFileSync(join(dir, "bombe.log.gz"), bomb(2));
    writeFileSync(join(dir, "daneben.log"), leak(OLD));
    // Entspricht langen Wartezeiten auf CPU zwischen zwei Schritten des Scans.
    let clock = 0;
    const wallClock = spyOn(Date, "now").mockImplementation(() => (clock += 60_000));
    try {
      const scan = await scanLogsForTokens(dir, [], { maxUnpackedBytes: MiB });
      expect(scan.hits).toEqual([{ file: "daneben.log", count: 1 }]);
      expect(scan.skipped).toEqual([{ file: "bombe.log.gz", reason: "entpackt größer als 1 MiB, nur der Anfang geprüft" }]);
    } finally {
      wallClock.mockRestore();
    }
  });

  test("Zeitlimit: angefangene Datei und alle übrigen als nicht geprüft gemeldet", async () => {
    const dir = logsDir();
    writeFileSync(join(dir, "a.log"), leak(MAIN));
    writeFileSync(join(dir, "b.log.gz"), bomb(8));
    writeFileSync(join(dir, "c.log"), leak(OLD));
    // Die Uhr springt mit jedem Blick um eine Sekunde, das Limit sind 3 s
    let clock = 0;
    const scan = await scanLogsForTokens(dir, [], { deadlineMs: 3_000, now: () => (clock += 1_000) });
    expect(scan.hits).toEqual([{ file: "a.log", count: 1 }]);
    expect(scan.skipped).toEqual([
      { file: "b.log.gz", reason: "Zeitlimit erreicht, nur der Anfang geprüft" },
      { file: "c.log", reason: "Zeitlimit erreicht" },
    ]);
  });
});

describe("Nachtcheck", () => {
  test("eigene Prüfung mit Tokens aus der Umgebung, Agenten-Bots eingeschlossen", async () => {
    const dir = logsDir();
    writeFileSync(join(dir, "telegram-relay.error.log"), `bot${ODD}/getMe\n`);
    expect(await checkTokenInLogs({ TELEGRAM_BOT_TOKEN_RESEARCH: ODD }, dir)).toEqual({
      name: "Telegram-Token im Log",
      status: "warn",
      detail: "1 Fundstelle(n) in telegram-relay.error.log (1x)",
      hint: "Token in den genannten Dateien maskieren oder die Dateien löschen; im Zweifel das Token bei @BotFather erneuern",
    });
    expect((await checkTokenInLogs({}, dir)).status).toBe("ok");
  });

  test("steht in der Liste der Prüfungen, ohne sie hier auszuführen", () => {
    const names = plannedChecks({ withModel: false, env: {}, now: 0, state: { logs: {} }, nextState: { logs: {} }, maintenance: {} as MaintenanceCheckDeps }).map(c => c.name);
    expect(names).toContain("Telegram-Token im Log");
  });
});
