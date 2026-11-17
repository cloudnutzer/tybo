/**
 * Issue #566, Aufgabe 4: docs/server.md als Wegweiser für Server und Codex.
 * Geprüft wird: die Tabelle „Was mit welchem Motor geht“, alle acht
 * Nebenaufgaben mit ihrer Variable, der Warnsatz und die Logzeile wie im
 * Code, Verweise aus README, FAQ, einrichtung.md, erweiterungen.md und
 * CLAUDE.md, und dass jeder relative Link der Seite auf eine vorhandene Datei
 * und einen vorhandenen Anker zeigt.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AUX_PURPOSE_LABELS, AUX_PURPOSES, auxEnvName } from "../src/lib/aux-targets";
import { auxPlan, claudeMissingLogLine, withoutClaudeSentence } from "../src/lib/claude-availability";
import { modelsStep } from "../src/setup/steps/models";

const ROOT = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const DOC = read("docs/server.md");

/** Anker wie bei GitHub: klein, ohne Satzzeichen, Leerzeichen zu Bindestrichen */
function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const line of markdown.split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    out.add(
      m[1]
        .trim()
        .toLowerCase()
        .replace(/[`*_„“"'()\/.,:;!?]/g, "")
        .replace(/\s+/g, "-"),
    );
  }
  return out;
}

describe("docs/server.md", () => {
  test("Tabelle „Was mit welchem Motor geht“ mit Kopf und den Zeilen zu Jobs, Nebenaufgaben und WhatsApp", () => {
    expect(DOC).toContain("## Was mit welchem Motor geht");
    expect(DOC).toContain("| Was | Claude Code | Codex ohne Claude |");
    for (const row of ["Hintergrund-Jobs", "Nebenaufgaben", "Check-in", "WhatsApp", "Ersatzmodelle", "Chat in Telegram, WebUI und Terminal"]) {
      expect(DOC).toMatch(new RegExp(`^\\| [^\\n]*${row}`, "m"));
    }
  });

  test("alle acht Nebenaufgaben mit Name und Variable", () => {
    for (const purpose of AUX_PURPOSES) {
      const label = AUX_PURPOSE_LABELS[purpose];
      expect(DOC).toMatch(new RegExp(`^\\| ${label.replace(/[/()]/g, m => `\\${m}`)}[^\\n]*\`${auxEnvName(purpose)}\``, "m"));
    }
  });

  test("Warnsatz und Logzeile wie im Code", () => {
    expect(DOC.replace(/\s+/g, " ")).toContain(`„Claude ist nicht angemeldet: ${withoutClaudeSentence(auxPlan({}, {}))}“`);
    const line = claudeMissingLogLine("Claude CLI nicht installiert", auxPlan({}, {}));
    expect(line.startsWith("[Claude] Claude CLI nicht installiert: Hintergrund-Jobs sind abgeschaltet. Abgeschaltet, weil sie über Claude liefen: Richter von /goal,")).toBe(true);
    expect(DOC).toContain("[Claude] Claude CLI nicht installiert: Hintergrund-Jobs sind abgeschaltet. Abgeschaltet, weil sie über Claude liefen: Richter von /goal, …");
  });

  test("nennt Feld und Auswahl aus dem Schritt Modelle", () => {
    const field = modelsStep.fields.find(f => f.name === "TYBO_ENGINE")!;
    expect(DOC).toContain(`**${field.label.replace(" (optional)", "")}**`);
    expect(DOC).toContain(`„${field.choices!.find(c => c.value === "codex")!.label}“ wählen`);
  });

  test("Server ohne Webhook: Polling braucht keine öffentliche Adresse", () => {
    expect(DOC).toContain("**keine öffentliche Adresse**");
    expect(DOC).toContain("`TYBO_PROFILE=local`");
  });

  test("jeder relative Link zeigt auf eine Datei und, wenn genannt, einen Anker darin", () => {
    const links = [...DOC.matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1]).filter(l => !/^https?:/.test(l));
    expect(links.length).toBeGreaterThan(3);
    for (const link of links) {
      const [file, anchor] = link.split("#");
      const path = join(ROOT, "docs", file);
      expect(existsSync(path)).toBe(true);
      if (anchor) expect(anchors(readFileSync(path, "utf8")).has(anchor)).toBe(true);
    }
  });

  test("README, FAQ, einrichtung.md, erweiterungen.md, hintergrund-jobs.md und CLAUDE.md verweisen darauf", () => {
    expect(read("README.md")).toContain("](docs/server.md)");
    expect(read("CLAUDE.md")).toContain("](docs/server.md)");
    for (const doc of ["docs/faq.md", "docs/einrichtung.md", "docs/erweiterungen.md", "docs/hintergrund-jobs.md"]) {
      expect(read(doc)).toContain("](server.md)");
    }
    expect(existsSync(join(dirname(join(ROOT, "docs/faq.md")), "server.md"))).toBe(true);
  });

  test("keine Pflicht mehr: Claude CLI nur ohne anderen Motor, Webhook-Adresse nur für Profil server", () => {
    expect(read("README.md")).toContain("unless Codex does the work");
    const ext = read("docs/erweiterungen.md");
    expect(ext).not.toContain("einen Server mit Bun und Claude CLI, für Claude Code dort");
    expect(ext).toContain("per Polling abholt, braucht keine");
    expect(read("docs/faq.md")).toContain("## Geht tybo ohne Claude-Konto?");
  });
});
