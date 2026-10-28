/**
 * Issue #209: Anleitung docs/raspberry-pi.md.
 *
 * - Vor jedem Befehlsblock steht ein Prüfstand („in der VM geprüft“ oder
 *   „nicht in der VM geprüft“), damit ein neuer Befehl ohne Beleg auffällt.
 * - Befehle im Fließtext (Absätze, Listenpunkte, Tabellenzeilen) tragen im
 *   selben Absatz bzw. in derselben Zeile einen Prüfstand; jede Zeile der
 *   Fehlerbehebung hat eine Prüfstand-Spalte.
 * - Namen und Zahlen, die aus dem Code kommen (Dienstname, Grenzen für
 *   gleichzeitige Aufträge, Einzeiler), stimmen mit dem Code überein.
 * - README, docs/einrichtung.md und docs/faq.md verweisen auf die Anleitung.
 * - Keine Gedankenstriche.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRAND } from "../src/brand";
import { ONE_SLOT_BELOW_GIB, TWO_SLOTS_BELOW_GIB } from "../src/lib/agent-capacity";
import { BOT_SERVICE, systemdUnit, systemdUnitFile } from "../src/lib/service-names";

const ROOT = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const DOC = read("docs/raspberry-pi.md");

/** Je Befehlsblock (```bash) die letzte nicht leere Zeile davor */
export function lineBeforeEachBlock(markdown: string): { block: string; before: string }[] {
  const lines = markdown.split("\n");
  const out: { block: string; before: string }[] = [];
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].trim().startsWith("```");
    if (!fence) continue;
    if (!inside && /^```(bash|sh)\s*$/.test(lines[i].trim())) {
      let j = i - 1;
      while (j >= 0 && lines[j].trim() === "") j--;
      out.push({ block: lines[i + 1]?.trim() ?? "", before: j >= 0 ? lines[j].trim() : "" });
    }
    inside = !inside;
  }
  return out;
}

const STAND = /^\*Prüfstand: (in der VM geprüft|nicht in der VM geprüft|`[^`]+` in der VM geprüft)/;

/** Befehlswörter, mit denen ein ausführbarer Befehl im Fließtext beginnt */
const COMMAND = /^(?:[A-Z_]+=\S+ )?(?:sudo|tybo|bun|claude|systemctl|loginctl|journalctl|ssh|scp|curl|sh|cd|rm|mkdir|git|npm|pm2|apt|apt-get|tail|free|source|exit) /;

/**
 * Absätze, Listenpunkte und Tabellenzeilen außerhalb von Codeblöcken, die
 * einen Befehl in `…` enthalten, aber keinen Prüfstand („in der VM geprüft“,
 * auch als „nicht in der VM geprüft“).
 */
export function unmarkedInlineCommands(markdown: string): string[] {
  const units: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) units.push(current.join(" "));
    current = [];
  };
  let inside = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      flush();
      inside = !inside;
      continue;
    }
    if (inside) continue;
    if (line === "" || line.startsWith("#")) {
      flush();
      continue;
    }
    if (line.startsWith("|") || /^([-*]|\d+\.) /.test(line)) flush();
    current.push(line);
    if (line.startsWith("|")) flush();
  }
  flush();
  return units.filter(unit => {
    const spans = [...unit.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    return spans.some(span => COMMAND.test(span)) && !unit.includes("in der VM geprüft");
  });
}

/** Datenzeilen der Tabelle unter „## Fehlerbehebung“ als Zellen */
function troubleshootingRows(markdown: string): string[][] {
  const section = markdown.slice(markdown.indexOf("## Fehlerbehebung"));
  return section
    .split("\n")
    .filter(l => l.startsWith("|") && !l.startsWith("|---"))
    .slice(1)
    .map(l => l.slice(1, -1).split(" | ").map(c => c.trim()));
}

describe("lineBeforeEachBlock", () => {
  test("findet die Zeile vor jedem Befehlsblock, überspringt Leerzeilen und andere Blöcke", () => {
    const md = ["*Prüfstand: in der VM geprüft.*", "", "```bash", "ls", "```", "", "```text", "x", "```", "Text", "```sh", "pwd", "```"].join("\n");
    expect(lineBeforeEachBlock(md)).toEqual([
      { block: "ls", before: "*Prüfstand: in der VM geprüft.*" },
      { block: "pwd", before: "Text" },
    ]);
  });
});

describe("unmarkedInlineCommands", () => {
  test("erkennt einen Befehl im Fließtext ohne Prüfstand", () => {
    const md = ["Danach `bun run restart:request \"Update\"` ausführen.", "", "| Fehler | `tybo setup telegram` ausführen. |"].join("\n");
    expect(unmarkedInlineCommands(md)).toEqual([
      "Danach `bun run restart:request \"Update\"` ausführen.",
      "| Fehler | `tybo setup telegram` ausführen. |",
    ]);
  });

  test("erkennt Befehle mit vorangestellter Variable und in Listenpunkten", () => {
    const md = ["- Vorher `ls`.", "- Dann auf dem Pi", "  `WEB_PORT=3177 tybo setup --web`."].join("\n");
    expect(unmarkedInlineCommands(md)).toEqual(["- Dann auf dem Pi `WEB_PORT=3177 tybo setup --web`."]);
  });

  test("lässt markierte Absätze, Codeblöcke und Namen ohne Argumente durch", () => {
    const md = [
      "Dann `tybo setup telegram`. *Prüfstand: nicht in der VM geprüft.*",
      "",
      "```bash",
      "tybo setup telegram",
      "```",
      "",
      "Die Datei `~/.bashrc` und der Befehl `tybo` stehen im `PATH`.",
    ].join("\n");
    expect(unmarkedInlineCommands(md)).toEqual([]);
  });
});

describe("docs/raspberry-pi.md", () => {
  test("vor jedem Befehlsblock steht ein Prüfstand", () => {
    const blocks = lineBeforeEachBlock(DOC);
    expect(blocks.length).toBeGreaterThan(10);
    expect(blocks.filter(b => !STAND.test(b.before)).map(b => b.block)).toEqual([]);
  });

  test("jeder Befehl im Fließtext trägt einen Prüfstand", () => {
    expect(unmarkedInlineCommands(DOC)).toEqual([]);
  });

  test("jede Zeile der Fehlerbehebung hat einen Prüfstand", () => {
    const rows = troubleshootingRows(DOC);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter(r => r.length !== 3 || !r[2].includes("in der VM geprüft")).map(r => r[0])).toEqual([]);
  });

  test("nennt den Einzeiler, den Dienstnamen und die Grenzen aus dem Code", () => {
    expect(DOC).toContain(`curl -fsSL https://${BRAND.domain}/install | sh`);
    expect(DOC).toContain(`systemctl --user restart ${systemdUnit(BOT_SERVICE)}`);
    expect(DOC).toContain(`~/.config/systemd/user/${systemdUnitFile(BOT_SERVICE)}`);
    expect(DOC).toContain(`unter\n${ONE_SLOT_BELOW_GIB} GiB 1, unter ${TWO_SLOTS_BELOW_GIB} GiB 2, sonst 3`);
  });

  test("Stromrechnung in kWh stimmt", () => {
    expect((0.005 * 24 * 365).toFixed(1)).toBe("43.8");
    expect(DOC).toContain("0,005 kW × 24 h × 365 Tage = **43,8 kWh im Jahr**");
  });

  test("empfiehlt den nativen Claude-Installer, nicht npm als Pflicht", () => {
    expect(DOC).toContain("curl -fsSL https://claude.ai/install.sh | bash");
    expect(DOC).not.toMatch(/^npm install -g @anthropic-ai\/claude-code$/m);
  });

  test("keine Gedankenstriche", () => {
    expect(DOC).not.toContain("—");
  });
});

describe("Verweise auf die Anleitung", () => {
  for (const file of ["README.md", "docs/einrichtung.md", "docs/faq.md"]) {
    test(`${file} verlinkt docs/raspberry-pi.md`, () => {
      expect(/\]\((docs\/|\.\/)?raspberry-pi\.md(#[^)]*)?\)/.test(read(file))).toBe(true);
    });
  }
});
