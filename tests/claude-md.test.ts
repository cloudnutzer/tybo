/**
 * CLAUDE.md, neu geschrieben in #375 (U3-1, Einrichtung) und #376 (U3-2,
 * Regeln, Befehle, Projektstruktur). Geprüft wird die ganze Datei:
 * - Größe: höchstens 250 Zeilen und 15.000 Bytes (UTF-8); der Einrichtungsteil
 *   (alles vor `## Regeln im Betrieb`) bleibt bei höchstens 150 Zeilen und
 *   9.000 Bytes
 * - kein Phasen-Gerüst mehr: keine Überschrift, die mit „Phase“ beginnt
 * - der Einzeiler des Installers steht vor dem ersten `tybo setup`
 * - jede Kennung aus SETUP_STEPS außer `pruefung` ist genannt, ein neuer
 *   Schritt ohne Doku fällt also auf
 * - die Liste unter WHAT_SETUP_SKIPS hat mindestens fünf Punkte, jeder mit
 *   Link auf einen vorhandenen Anker in docs/erweiterungen.md
 * - die Regeln für den Betrieb nennen Neustart, notify, job, Hooks und
 *   Geheimnisse; die Arbeit am Code ist davon abgegrenzt
 * - genannte Pfade gibt es, Anker in Links auf docs/*.md auch
 * - jedes `bun run <name>` ist ein Skript aus package.json, jedes
 *   `tybo <befehl>` steht in `tybo help`, und die Optionen und Unterbefehle
 *   der Befehlstabelle kennt das jeweilige Programm
 *
 * Dazu, für docs/erweiterungen.md: jeder Name in Backticks, der wie eine
 * Umgebungsvariable aussieht und auf _KEY, _TOKEN, _ID oder _MODEL endet,
 * steht in .env.example (Ausnahmen in ENV_NOT_IN_EXAMPLE, je mit Grund).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRAND } from "../src/brand";
import { SETUP_STEPS } from "../src/setup/steps";

const ROOT = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const CLAUDE = read("CLAUDE.md");
const RULES = "## Regeln im Betrieb";
const CODE_WORK = "## Arbeit am Code";
const COMMANDS = "## Befehle";
/** der Einrichtungsteil aus #375: alles vor den Regeln */
const SETUP_PART = CLAUDE.slice(0, Math.max(0, CLAUDE.indexOf(`\n${RULES}\n`) + 1));

const WHAT_SETUP_SKIPS = "## Was `tybo setup` nicht macht";
const EXTENSIONS = "docs/erweiterungen.md";
const ONE_LINER = `curl -fsSL https://${BRAND.domain}/install | sh`;

/** Variablen, die docs/erweiterungen.md nennt, obwohl .env.example sie nicht führt */
const ENV_NOT_IN_EXAMPLE: Record<string, string> = {};

/** Zeilen unter einer Überschrift bis zur nächsten Überschrift derselben oder höheren Ebene */
function sectionLines(doc: string, heading: string): string[] {
  const level = heading.match(/^#+/)![0].length;
  const lines = doc.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** Anker wie bei GitHub: klein, ohne Satzzeichen außer - und _, Leerzeichen zu -, Dubletten mit -1, -2 … */
function githubAnchors(doc: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fence = false;
  for (const line of doc.split("\n")) {
    if (/^(`{3,}|~{3,})/.test(line.trim())) fence = !fence;
    const m = !fence && line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const base = m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/** Inhalte aller Code-Spannen (`…`) */
function codeSpans(doc: string): string[] {
  return [...doc.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
}

/** Zeilen der Befehlstabelle als [Befehl, Beschreibung] */
function commandRows(): [string, string][] {
  return sectionLines(CLAUDE, COMMANDS)
    .filter(l => l.startsWith("| `"))
    .map(l => l.split("|").map(c => c.trim()))
    .map(cells => [cells[1], cells[2]]);
}

/** Quelltexte, die die Optionen eines package.json-Skripts auswerten */
function scriptSources(name: string): string {
  const scripts: Record<string, string> = JSON.parse(read("package.json")).scripts;
  const file = scripts[name]?.match(/\S+\.ts/)?.[0];
  const files = [file, ...(DELEGATES[name] ?? [])].filter((f): f is string => !!f);
  return files.map(read).join("\n");
}

/** Skripte, die ihre Optionen in einem anderen Modul auswerten */
const DELEGATES: Record<string, string[]> = { job: ["src/lib/jobs/cli.ts"] };

function tyboHelp(...args: string[]): string {
  const r = Bun.spawnSync([process.execPath, "--no-env-file", join(ROOT, "scripts/tybo.ts"), ...args, "help"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return r.stdout.toString() + r.stderr.toString();
}

describe("CLAUDE.md, Einrichtung", () => {
  test("ganze Datei höchstens 250 Zeilen und 15.000 Bytes, Einrichtung höchstens 150 Zeilen und 9.000 Bytes", () => {
    expect(CLAUDE.split("\n").length - 1).toBeLessThanOrEqual(250);
    expect(Buffer.byteLength(CLAUDE, "utf8")).toBeLessThanOrEqual(15000);
    expect(SETUP_PART.length).toBeGreaterThan(0);
    expect(SETUP_PART.split("\n").length - 1).toBeLessThanOrEqual(150);
    expect(Buffer.byteLength(SETUP_PART, "utf8")).toBeLessThanOrEqual(9000);
  });

  test("keine Überschrift beginnt mit Phase", () => {
    expect(CLAUDE.split("\n").filter(l => /^#+\s+Phase/i.test(l))).toEqual([]);
  });

  test("der Einzeiler steht vor dem ersten tybo setup", () => {
    expect(CLAUDE).toContain(ONE_LINER);
    expect(CLAUDE.indexOf("tybo setup")).toBeGreaterThan(-1);
    expect(CLAUDE.indexOf(ONE_LINER)).toBeLessThan(CLAUDE.indexOf("tybo setup"));
  });

  test("jede Kennung aus SETUP_STEPS außer pruefung ist genannt", () => {
    const ids = SETUP_STEPS.map(s => s.id).filter(id => id !== "pruefung");
    expect(ids.length).toBeGreaterThan(5);
    expect(ids.filter(id => !CLAUDE.includes(`\`${id}\``))).toEqual([]);
  });

  test("Liste „Was tybo setup nicht macht“: mindestens fünf Punkte, je mit gültigem Anker in docs/erweiterungen.md", () => {
    // ein Punkt beginnt mit "- ", eingerückte Folgezeilen gehören dazu
    const items = sectionLines(CLAUDE, WHAT_SETUP_SKIPS)
      .join("\n")
      .split(/\n(?=- )/)
      .map(item => item.replace(/\n\s+/g, " ").trim())
      .filter(item => item.startsWith("- "));
    expect(items.length).toBeGreaterThanOrEqual(5);
    const anchors = githubAnchors(read(EXTENSIONS));
    for (const item of items) {
      const links = [...item.matchAll(/\]\(docs\/erweiterungen\.md#([^)]+)\)/g)].map(m => m[1]);
      expect({ item, linked: links.length > 0 }).toEqual({ item, linked: true });
      for (const anchor of links) expect({ anchor, exists: anchors.has(anchor) }).toEqual({ anchor, exists: true });
    }
  });
});

describe("CLAUDE.md, Regeln, Befehle, Projektstruktur", () => {
  test("die Abschnitte stehen in dieser Reihenfolge hinter der Einrichtung", () => {
    const headings = ["## Erinnerungen", RULES, CODE_WORK, COMMANDS, "## Wo was steht", "## Projektstruktur"];
    const lines = CLAUDE.split("\n");
    const at = headings.map(h => lines.indexOf(h));
    expect(at.filter(i => i < 0)).toEqual([]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("Regeln im Betrieb: Neustart, notify mit Gesprächsziel und Outbox, job, Hooks, Geheimnisse, PATH, Routinen", () => {
    const rules = sectionLines(CLAUDE, RULES).join("\n");
    const needed = [
      "bun run restart:request",
      "launchctl kickstart",
      "bun run notify",
      "TYBO_CONVERSATION_ID",
      "TYBO_TOPIC_ID",
      "TYBO_CHAT_ID",
      "src/lib/outbox.ts",
      "bun run job start",
      "--full-access",
      "TYBO_SUBPROCESS=1",
      '[ -n "$TYBO_SUBPROCESS" ] ||',
      "TYBO_SUBPROCESS_ENV_ALLOW",
      "ANTHROPIC_API_KEY",
      "CLAUDE_AUTH",
      "src/lib/subprocess-env.ts",
      "~/.local/bin",
      "src/routine-run.ts",
    ];
    expect(needed.filter(n => !rules.includes(n))).toEqual([]);
  });

  test("Arbeit am Code: bot.ts nie starten, kein Neustart, web:dev und check", () => {
    const work = sectionLines(CLAUDE, CODE_WORK).join(" ");
    for (const n of ["`src/bot.ts` nie", "`restart:request`", "`launchctl`", "`bun run web:dev`", "`bun run check`"]) {
      expect({ n, found: work.includes(n) }).toEqual({ n, found: true });
    }
  });

  test("genannte Pfade unter src/, docs/, scripts/, tests/, db/, supabase/ und setup/ gibt es", () => {
    const links = [...CLAUDE.matchAll(/\]\(([^)#\s]+)/g)].map(m => m[1]);
    const paths = [...codeSpans(CLAUDE), ...links].filter(p => /^(src|docs|scripts|tests|db|supabase|setup)\/[\w./-]*$/.test(p));
    expect(paths.length).toBeGreaterThan(20);
    expect([...new Set(paths)].filter(p => !existsSync(join(ROOT, p)))).toEqual([]);
  });

  test("Anker in Links auf docs/*.md gibt es", () => {
    const links = [...CLAUDE.matchAll(/\]\((docs\/[^)#\s]+\.md)#([^)\s]+)\)/g)];
    expect(links.length).toBeGreaterThan(5);
    const missing = links.filter(([, file, anchor]) => !githubAnchors(read(file)).has(anchor)).map(m => `${m[1]}#${m[2]}`);
    expect(missing).toEqual([]);
  });

  test("jedes bun run <name> ist ein Skript aus package.json", () => {
    const scripts = Object.keys(JSON.parse(read("package.json")).scripts);
    const names = [...new Set([...CLAUDE.matchAll(/\bbun run ([^\s`"]+)/g)].map(m => m[1]))];
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter(n => !scripts.includes(n))).toEqual([]);
  });

  test("jedes tybo <befehl> steht in tybo help", () => {
    const help = tyboHelp();
    const commands = [...new Set(codeSpans(CLAUDE).flatMap(s => [...s.matchAll(/(?:^|\s)tybo ([a-z][a-z-]*)/g)].map(m => m[1])))];
    expect(commands).toContain("setup");
    expect(commands.filter(c => !help.includes(`  ${BRAND.cli} ${c}`))).toEqual([]);
  });

  test("Befehlstabelle: Optionen und Unterbefehle kennt das jeweilige Programm", () => {
    const rows = commandRows();
    expect(rows.length).toBeGreaterThan(10);
    const problems: string[] = [];
    for (const [command, text] of rows) {
      const bun = command.match(/^`bun run ([^\s`]+)/);
      const tybo = command.match(/^`tybo(?: ([a-z-]+))?`/);
      if (bun) {
        const source = scriptSources(bun[1]);
        for (const [flag] of text.matchAll(/--[a-z][a-z-]*/g)) if (!source.includes(flag)) problems.push(`${bun[1]}: ${flag}`);
        // Unterbefehle: Code-Spannen, die mit einem Wort ohne Option davor beginnen, etwa `stop <id>`
        if (DELEGATES[bun[1]]) {
          for (const span of codeSpans(text)) {
            const word = span.match(/^([a-z]+)(?:\s|$)/)?.[1];
            if (word && !source.includes(`case "${word}"`)) problems.push(`${bun[1]}: ${word}`);
          }
        }
      } else if (tybo) {
        // Wörter in Code-Spannen der Beschreibung stehen in der Hilfe des Unterbefehls
        const help = tybo[1] ? tyboHelp(tybo[1]) : tyboHelp();
        for (const span of codeSpans(text)) {
          const word = span.match(/^([a-z][a-z-]*)$/)?.[1];
          if (word && !help.includes(word)) problems.push(`tybo ${tybo[1] ?? ""}: ${word}`);
        }
      } else problems.push(`unbekannte Zeile: ${command}`);
    }
    expect(problems).toEqual([]);
  });

  test("keine Pfade, die es nicht mehr gibt", () => {
    for (const gone of ["vps-gateway.ts", "agent-session.ts", "model-router.ts", "anthropic-processor.ts", "setup/verify.ts"]) {
      expect({ gone, found: CLAUDE.includes(gone) }).toEqual({ gone, found: false });
    }
  });
});

describe("Anker nach GitHub-Regel", () => {
  test("Backticks, Satzzeichen und Dubletten", () => {
    const anchors = githubAnchors("# Was `tybo setup` nicht macht\n## Linux: Dienste nach dem Abmelden\n## A\n## A\n```\n# kein Titel\n```\n");
    expect([...anchors]).toEqual(["was-tybo-setup-nicht-macht", "linux-dienste-nach-dem-abmelden", "a", "a-1"]);
  });
});

describe("keine Verweise auf Phasen der CLAUDE.md", () => {
  // absatzweise und ohne Großschreibung: „Phase 0 der\n`CLAUDE.md`“ und „in ihren Phasen“ zählen auch
  test("README.md und docs/*.md (ohne webui, reviews, werkstatt)", () => {
    const files = ["README.md", ...readdirSync(join(ROOT, "docs")).filter(f => f.endsWith(".md")).map(f => `docs/${f}`)];
    const hits = files.flatMap(file =>
      read(file)
        .split(/\n\s*\n/)
        .filter(par => par.includes("CLAUDE.md") && /\bphase(n)?\b/i.test(par))
        .map(par => `${file}: ${par.slice(0, 120)}`),
    );
    expect(files).toContain("docs/einrichtung.md");
    expect(hits).toEqual([]);
  });
});

describe("docs/erweiterungen.md", () => {
  test("Schlüssel-, Token-, ID- und Modellnamen stehen in .env.example", () => {
    const doc = read(EXTENSIONS);
    const example = read(".env.example");
    const names = new Set(
      [...doc.matchAll(/`([^`\s]+)`/g)].map(m => m[1].replace(/=.*$/, "")).filter(n => /^[A-Z][A-Z0-9_]+$/.test(n) && /_(KEY|TOKEN|ID|MODEL)$/.test(n)),
    );
    const missing = [...names].filter(n => !(n in ENV_NOT_IN_EXAMPLE) && !new RegExp(`\\b${n}=`).test(example));
    expect(missing).toEqual([]);
  });
});
