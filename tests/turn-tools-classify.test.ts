/**
 * Issue #53, Schritt 2: Einstufung „fremde Inhalte“. Seit Issue #525 zählen
 * nur noch Inhalte aus dem Netz; Dateien auf diesem Rechner sind nie fremd.
 * Symlinks und Pfade liegen in einem Temp-Ordner, nie im echten Projekt.
 * Die Bash-Fälle im Einzelnen: tests/bash-network.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { classifyTurnTools, foreignReason, toolUseFromBlock, type ToolUse } from "../src/lib/turn-tools";

let base = "";
let root = "";
let outside = "";
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "turn-tools-"));
  root = join(base, "tybo");
  outside = join(base, "fremd");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "x");
  writeFileSync(join(outside, "mail.txt"), "x");
  // Symlink im Projekt, der nach außen zeigt, und einer von außen ins Projekt
  symlinkSync(outside, join(root, "link-nach-aussen"));
  symlinkSync(root, join(base, "link-ins-projekt"));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const OWNERS = ["cloudnutzer"];
const classify = (uses: ToolUse[], cwd?: string) => classifyTurnTools({ uses, cwd: cwd ?? root }, root, { githubOwners: OWNERS });

describe("classifyTurnTools", () => {
  test("ohne Werkzeugliste: unbekannt", () => {
    expect(classifyTurnTools(undefined, root)).toEqual({ status: "unknown" });
  });

  test("bekannte leere Liste und eigene Werkzeuge: own", () => {
    expect(classify([])).toEqual({ status: "own" });
    expect(
      classify([
        { name: "Read", path: join(root, "src", "a.ts") },
        { name: "Grep", path: "src" },
        { name: "Glob" },
        { name: "Edit", path: "/irgendwo/anders.ts" },
        { name: "Write", path: "/tmp/x" },
        { name: "Bash", command: "bun run check" },
        { name: "Skill" },
        { name: "TodoWrite" },
      ])
    ).toEqual({ status: "own" });
  });

  test.each(["WebFetch", "WebSearch", "ReadMcpResourceTool", "ListMcpResourcesTool", "Task", "Agent"])(
    "%s ist fremd",
    name => {
      expect(classify([{ name }]).status).toBe("foreign");
    }
  );

  test("lesende MCP-Werkzeuge: Mail, Kalender, Firecrawl, Browser", () => {
    for (const name of [
      "mcp__claude_ai_Gmail__search_threads",
      "mcp__claude_ai_Google_Calendar__list_events",
      "mcp__firecrawl__firecrawl_scrape",
      "mcp__playwright__browser_navigate",
      "mcp__claude_ai_Google_Drive__read_file",
    ]) {
      const v = classify([{ name }]);
      expect(v.status).toBe("foreign");
    }
    expect(foreignReason({ name: "mcp__claude_ai_Gmail__search_threads" }, OWNERS)).toContain("Mail");
    expect(foreignReason({ name: "mcp__firecrawl__firecrawl_scrape" }, OWNERS)).toContain("Web");
  });

  test("unbekannte MCP-Werkzeuge gelten vorsichtshalber als fremd", () => {
    expect(classify([{ name: "mcp__irgendwas__tu_was" }]).status).toBe("foreign");
  });

  test("Issue #525: lesende Datei-Werkzeuge sind nie fremd, auch außerhalb des Projekts und über Symlinks", () => {
    for (const name of ["Read", "Grep", "Glob", "LS", "NotebookRead"]) {
      expect(classify([{ name, path: join(outside, "mail.txt") }]).status).toBe("own");
      expect(classify([{ name, path: "../fremd/mail.txt" }]).status).toBe("own");
      expect(classify([{ name, path: join(root, "link-nach-aussen", "mail.txt") }]).status).toBe("own");
      expect(classify([{ name, path: join(base, "link-ins-projekt", "src", "a.ts") }]).status).toBe("own");
      expect(classify([{ name, path: "/etc/hosts" }]).status).toBe("own");
      expect(classify([{ name, path: "~/Downloads/rechnung.pdf" }]).status).toBe("own");
    }
  });

  test("Grep/Glob ohne Pfad: eigen, egal in welchem Arbeitsverzeichnis", () => {
    expect(classify([{ name: "Grep" }], outside).status).toBe("own");
    expect(classify([{ name: "Glob" }], "/").status).toBe("own");
    expect(classify([{ name: "Grep" }], root).status).toBe("own");
  });

  test("Bash nur mit Netzabruf fremd, gh gegen eigene Repos nicht", () => {
    expect(classify([{ name: "Bash", command: "curl -s https://example.com" }])).toEqual({ status: "foreign", reasons: ["Bash mit Netzabruf"] });
    expect(classify([{ name: "Bash", command: "gh api repos/x/y/issues" }])).toEqual({
      status: "foreign",
      reasons: ["gh mit fremdem oder unklarem Repo"],
    });
    expect(classify([{ name: "Bash", command: "gh api repos/cloudnutzer/y/issues" }]).status).toBe("own");
    expect(classify([{ name: "Bash", command: "gh issue list -R cloudnutzer/y" }]).status).toBe("own");
    expect(classify([{ name: "Bash", command: "gh api repos/fremd/x; gh issue list -R cloudnutzer/y" }]).status).toBe("foreign");
    expect(classify([{ name: "Bash", command: "git status && bun test" }]).status).toBe("own");
  });

  test("ohne Angabe gelten die Konten aus TYBO_TRUSTED_GITHUB_OWNERS", () => {
    const saved = process.env.TYBO_TRUSTED_GITHUB_OWNERS;
    const tools = { uses: [{ name: "Bash", command: "gh issue list -R cloudnutzer/y" }] };
    try {
      delete process.env.TYBO_TRUSTED_GITHUB_OWNERS;
      expect(classifyTurnTools(tools, root).status).toBe("foreign");
      process.env.TYBO_TRUSTED_GITHUB_OWNERS = "cloudnutzer";
      expect(classifyTurnTools(tools, root).status).toBe("own");
    } finally {
      if (saved === undefined) delete process.env.TYBO_TRUSTED_GITHUB_OWNERS;
      else process.env.TYBO_TRUSTED_GITHUB_OWNERS = saved;
    }
  });

  test("weiter vorsichtshalber fremd: Unter-Agenten, unbekannte MCP-Werkzeuge, externe Werkzeuge", () => {
    expect(classify([{ name: "Task" }, { name: "Read", path: "src/a.ts" }]).status).toBe("foreign");
    expect(classify([{ name: "mcp__eigener_server__tu_was" }]).status).toBe("foreign");
    expect(classify([{ name: "lsp", external: true }]).status).toBe("foreign");
  });

  test("externe Werkzeuge der Sprach-Brücke: Systemwerkzeuge harmlos, andere fremd", () => {
    expect(classify([{ name: "end_call", external: true }]).status).toBe("own");
    expect(classify([{ name: "webhook_wetter", external: true }]).status).toBe("foreign");
  });

  test("Gründe ohne Doppel, alle fremden Werkzeuge aufgeführt", () => {
    const v = classify([{ name: "WebFetch" }, { name: "WebFetch" }, { name: "Read", path: "/etc/hosts" }, { name: "Bash", command: "wget x" }, { name: "Edit" }]);
    expect(v).toEqual({ status: "foreign", reasons: ["WebFetch", "Bash mit Netzabruf"] });
  });
});

describe("toolUseFromBlock", () => {
  test("Pfad und Befehl aus der Eingabe", () => {
    expect(toolUseFromBlock({ type: "tool_use", name: "Read", input: { file_path: "/a" } })).toEqual({ name: "Read", path: "/a" });
    expect(toolUseFromBlock({ type: "tool_use", name: "NotebookEdit", input: { notebook_path: "/n.ipynb" } })).toEqual({
      name: "NotebookEdit",
      path: "/n.ipynb",
    });
    expect(toolUseFromBlock({ type: "tool_use", name: "Bash", input: { command: "ls" } })).toEqual({ name: "Bash", command: "ls" });
  });

  test("keine tool_use-Blöcke oder ohne Namen: null", () => {
    expect(toolUseFromBlock({ type: "text", text: "x" })).toBeNull();
    expect(toolUseFromBlock({ type: "tool_use" })).toBeNull();
    expect(toolUseFromBlock(null)).toBeNull();
  });
});
