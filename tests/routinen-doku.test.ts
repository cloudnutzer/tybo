/**
 * Issue #289: docs/routinen.md hält, was sie verspricht. Die Regel „keine
 * alten Daten" steht wörtlich darin, das Plist-Muster ruft den Wrapper wie
 * die Vorlage, und das TypeScript-Beispiel endet bei fehlender und
 * veralteter Datei mit 1, bei frischer mit 0. Ruft nie launchctl auf.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWrapperArgs } from "../src/routine-run";
import { serviceDefinition } from "../src/lib/services/catalog";
import { servicePlist } from "../src/lib/services/plist";

const ROOT = join(import.meta.dir, "..");
const DOC = readFileSync(join(ROOT, "docs", "routinen.md"), "utf8");

const RULE =
  "Fehlen die Quelldaten oder sind sie veraltet, schreibt die Routine eine Zeile, was fehlt, und endet mit Exit-Code 1; nie mit alten Daten weitermachen.";

/** Inhalt des ersten Code-Blocks der Sprache lang, der needle enthält */
function codeBlock(lang: string, needle: string): string {
  for (const match of DOC.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))) {
    if (match[1]!.includes(needle)) return match[1]!;
  }
  throw new Error(`Kein ${lang}-Block mit ${needle} in docs/routinen.md`);
}

/** Werte der <string>-Einträge im Array nach <key>name</key> */
function plistArray(xml: string, key: string): string[] {
  const block = xml.match(new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`))?.[1] ?? "";
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]!);
}

describe("docs/routinen.md", () => {
  test("enthält die Regel „keine alten Daten\" wörtlich", () => {
    const quoted = DOC.split("\n")
      .filter(l => l.startsWith("> "))
      .map(l => l.slice(2))
      .join(" ");
    expect(quoted).toContain(RULE);
    expect(DOC).toContain("## Neue Routine anlegen");
  });

  test("Plist-Muster ruft den Wrapper wie die Vorlage, --id gleich Label", () => {
    const xml = codeBlock("xml", "src/routine-run.ts");
    const label = xml.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    expect(label).toBe("ai.tybo.preise-holen");
    const args = plistArray(xml, "ProgramArguments");
    expect(args[1]).toBe("--no-env-file");
    expect(args[2]).toBe("src/routine-run.ts");
    const parsed = parseWrapperArgs(args.slice(3));
    expect(parsed).toEqual({ id: label!, command: [args[0]!, "run", "src/preise-holen.ts"] });

    // Vergleich mit der Plist, die der Generator für den Nachtcheck erzeugt (Issue #368)
    const machine = { bun: "/b/bun", claudeDir: "/c", home: "/h", projectRoot: "/p", exitTimeoutS: 1 };
    const schedule = { morning_briefing: { hour: 9, minute: 0, enabled: true }, check_in_intervals: [] };
    const generated = servicePlist(serviceDefinition("health-check"), machine, schedule);
    const templateArgs = plistArray(generated, "ProgramArguments");
    expect(templateArgs.slice(1, 4)).toEqual(args.slice(1, 4));
    expect(templateArgs[5]).toBe(args[5]!);

    expect(xml).toContain("<key>WorkingDirectory</key>");
    const path = xml.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "";
    // PATH-Regel aus CLAUDE.md: ~/.local/bin als absoluter Pfad
    expect(path.split(":")).toContain("/Users/NAME/.local/bin");
    expect(path).not.toContain("~");
  });

  test("keine Gedankenstriche und keine Zeilennummern", () => {
    expect(DOC).not.toContain("—");
    expect(DOC).not.toMatch(/\.(ts|md|json|plist|template):\d+/);
  });
});

describe("Beispiel „Alter einer Datei prüfen\"", () => {
  const source = codeBlock("ts", "Quelldaten veraltet");

  async function run(script: string, file: string): Promise<{ code: number; stderr: string; stdout: string }> {
    const proc = Bun.spawn([process.execPath, "run", script, file], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stderr, stdout };
  }

  test("fehlende Datei: 1, veraltete: 1, frische: 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "routinen-doku-"));
    try {
      const script = join(dir, "beispiel.ts");
      writeFileSync(script, source);
      const data = join(dir, "preise.json");

      const missing = await run(script, data);
      expect(missing.code).toBe(1);
      expect(missing.stderr.trim()).toBe(`Quelldaten fehlen: ${data} gibt es nicht.`);

      writeFileSync(data, "{}");
      const old = (Date.now() - 30 * 3_600_000) / 1000;
      utimesSync(data, old, old);
      const stale = await run(script, data);
      expect(stale.code).toBe(1);
      expect(stale.stderr).toContain(`Quelldaten veraltet: ${data} ist 30 Stunden alt, erlaubt sind 26.`);
      expect(stale.stdout).toBe("");

      writeFileSync(data, "{}");
      const fresh = await run(script, data);
      expect(fresh.code).toBe(0);
      expect(fresh.stderr).toBe("");
      expect(fresh.stdout).toContain("Fertig mit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
