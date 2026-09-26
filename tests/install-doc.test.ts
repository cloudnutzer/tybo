/**
 * Issue #146: Doku zum Installer (install.sh, Issues #144 und #145).
 *
 * - docs/einrichtung.md und README.md zeigen den Einzeiler wörtlich.
 * - Jede Option und Umgebungsvariable aus `sh install.sh --help` steht im
 *   Abschnitt „Schnellweg: ein Befehl“ (nur dort gesucht). Die Liste kommt aus
 *   der echten Hilfe, eine neue Option ohne Doku fällt also auf.
 * - Im Abschnitt „Installation mit einem Befehl“ in docs/troubleshooting.md
 *   gelten nur Zeilen mit **Meldung:** als Zitat aus install.sh. Jeder
 *   Code-Abschnitt dort ohne das Präfix `tybo: ` muss, an „…“ zerlegt,
 *   Stück für Stück wörtlich in install.sh stehen; „…“ steht für Ordner und
 *   Programmnamen. Shell-Meldungen wie `tybo: command not found` stehen unter
 *   **Symptom:** und werden nicht abgeglichen.
 *
 * `sh install.sh --help` gibt nur die Hilfe aus und prüft oder ändert nichts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BRAND } from "../src/brand";

const ROOT = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const SCRIPT = join(ROOT, "install.sh");
const INSTALL_SH = read("install.sh");
const ONE_LINER = `curl -fsSL https://${BRAND.domain}/install | sh`;

/** Text ab der Überschrift bis zur nächsten Überschrift derselben oder höheren Ebene */
function section(doc: string, heading: string): string {
  const level = heading.match(/^#+/)![0].length;
  const lines = doc.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** Optionen (--x) und Umgebungsvariablen aus den Abschnitten der Hilfe */
function helpEntries(help: string): string[] {
  const entries: string[] = [];
  let block: "options" | "env" | null = null;
  for (const line of help.split("\n")) {
    if (/^Optionen:/.test(line)) block = "options";
    else if (/^Umgebungsvariablen/.test(line)) block = "env";
    else if (line.trim() === "") block = null;
    else if (block) {
      const first = line.trim().split(/\s+/)[0];
      if (block === "options" ? first.startsWith("--") : /^[A-Z][A-Z0-9_]*$/.test(first)) entries.push(first);
    }
  }
  return entries;
}

/**
 * Einträge der Hilfe, die im Text fehlen. Gesucht wird der ganze Name nach
 * einem Backtick mit Namensgrenze danach: `--no-setup` zählt nicht für `--no`.
 */
function missingEntries(help: string, text: string): string[] {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return helpEntries(help).filter(e => !new RegExp(`\`${escape(e)}(?![A-Za-z0-9_-])`).test(text));
}

/** Zitierte Meldungsteile aus **Meldung:**-Zeilen */
function quotedMessageParts(text: string): string[] {
  return text
    .split("\n")
    .filter(l => l.startsWith("**Meldung:**"))
    .flatMap(l => [...l.matchAll(/`([^`]+)`/g)].map(m => m[1]))
    .flatMap(q => q.replace(/^tybo: /, "").split("…"))
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

function missingMessageParts(text: string, source: string): string[] {
  return quotedMessageParts(text).filter(p => !source.includes(p));
}

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "tybo-install-doc-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function help(script: string): string {
  const r = Bun.spawnSync(["sh", script, "--help"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmp },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString();
}

const EINRICHTUNG = read("docs/einrichtung.md");
const README = read("README.md");
const QUICK = section(EINRICHTUNG, "## Schnellweg: ein Befehl");
const TROUBLE = section(read("docs/troubleshooting.md"), "### Installation mit einem Befehl");

describe("Einzeiler", () => {
  test("docs/einrichtung.md und README.md enthalten ihn wörtlich, einrichtung.md im Schnellweg", () => {
    expect(EINRICHTUNG).toContain(ONE_LINER);
    expect(README).toContain(ONE_LINER);
    expect(QUICK).toContain(ONE_LINER);
  });

  test("Schnellweg steht vor dem Weg von Hand, README zeigt den Einzeiler vor git clone", () => {
    expect(EINRICHTUNG.indexOf("## Schnellweg: ein Befehl")).toBeGreaterThan(-1);
    expect(EINRICHTUNG.indexOf("## Schnellweg: ein Befehl")).toBeLessThan(EINRICHTUNG.indexOf("## Von Hand einrichten"));
    expect(README.indexOf(ONE_LINER)).toBeLessThan(README.indexOf("git clone"));
    expect(README).not.toContain("<!--");
  });

  test("CLAUDE.md Phase 0 nennt ihn als ersten Weg", () => {
    const claude = read("CLAUDE.md");
    const phase0 = section(claude, "## Phase 0: Environment Scan (Automatic, ~1 min)");
    expect(phase0).toContain(ONE_LINER);
    expect(phase0.indexOf(ONE_LINER)).toBeLessThan(phase0.indexOf("tybo setup`."));
  });
});

describe("Optionen aus install.sh --help", () => {
  const realHelp = help(SCRIPT);

  test("die Hilfe liefert Optionen und Umgebungsvariablen", () => {
    expect(helpEntries(realHelp)).toEqual(expect.arrayContaining(["--dir", "--yes", "--no-setup", "--help", "TYBO_DIR"]));
  });

  test("jede steht im Schnellweg", () => {
    expect(missingEntries(realHelp, QUICK)).toEqual([]);
  });

  test("TYBO_DIR steht im Beispiel auf der sh-Seite der Pipe", () => {
    expect(QUICK).toContain(`curl -fsSL https://${BRAND.domain}/install | TYBO_DIR=`);
    expect(QUICK).toContain(`sh -s -- --dir ~/apps/tybo`);
  });

  test("Gegenprobe: eine neue Option in einer Kopie von install.sh fehlt im Schnellweg", () => {
    const copy = join(tmp, "install.sh");
    const extended = INSTALL_SH.replace(
      "  --help         diese Hilfe\n",
      "  --help         diese Hilfe\n  --turbo        neue Option\n",
    ).replace("  BUN_INSTALL ", "  TYBO_NEU      neue Variable\n  BUN_INSTALL ");
    expect(extended).not.toBe(INSTALL_SH);
    writeFileSync(copy, extended);
    expect(missingEntries(help(copy), QUICK)).toEqual(["--turbo", "TYBO_NEU"]);
  });

  test("Gegenprobe: --no fehlt, obwohl --no-setup dokumentiert ist", () => {
    const copy = join(tmp, "install-no.sh");
    const extended = INSTALL_SH.replace(
      "  --help         diese Hilfe\n",
      "  --help         diese Hilfe\n  --no           neue Option\n",
    );
    expect(extended).not.toBe(INSTALL_SH);
    expect(QUICK).toContain("`--no-setup`");
    writeFileSync(copy, extended);
    expect(missingEntries(help(copy), QUICK)).toEqual(["--no"]);
  });

  test("nur der Schnellweg zählt, nicht der Rest der Anleitung", () => {
    expect(missingEntries("Optionen:\n  --dir <pfad>   x\n", "Irgendwo `--dir`")).toEqual([]);
    expect(missingEntries("Optionen:\n  --dir <pfad>   x\n", section("## A\n`--dir`\n## Schnellweg\nnichts", "## Schnellweg"))).toEqual(["--dir"]);
  });
});

describe("docs/troubleshooting.md, Installation mit einem Befehl", () => {
  test("der Abschnitt behandelt die typischen Fehler", () => {
    for (const topic of ["tybo: command not found", "lokale Änderungen", "gehört nicht zu tybo", "Kein Terminal", "unzip", "Proxy", "curl -fsSL https://tybo.ai/install -o install.sh", "sh install.sh"]) {
      expect(TROUBLE).toContain(topic.replace("tybo.ai", BRAND.domain));
    }
  });

  test("jede zitierte Meldung steht wörtlich in install.sh", () => {
    expect(quotedMessageParts(TROUBLE).length).toBeGreaterThanOrEqual(10);
    expect(missingMessageParts(TROUBLE, INSTALL_SH)).toEqual([]);
  });

  test("Shell-Meldungen unter **Symptom:** werden nicht abgeglichen", () => {
    expect(TROUBLE).toContain("**Symptom:** `tybo: command not found`");
    expect(INSTALL_SH).not.toContain("command not found");
  });

  test("Gegenprobe: eine erfundene Meldung fällt auf, Platzhalter und Präfix nicht", () => {
    const doc = [
      "**Meldung:** `tybo: … gehört nicht zu tybo, nichts geändert.`",
      "**Meldung:** `tybo: das sagt der Installer nie`",
      "**Symptom:** `bash: foo: command not found`",
    ].join("\n");
    expect(missingMessageParts(doc, INSTALL_SH)).toEqual(["das sagt der Installer nie"]);
  });
});

describe("Texte", () => {
  test("keine Gedankenstriche in den neuen Abschnitten und der README", () => {
    for (const text of [QUICK, TROUBLE, README]) expect(text.includes("—")).toBe(false);
  });
});
