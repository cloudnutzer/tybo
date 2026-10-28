/**
 * Issue #53, Schritt 2: Einstufung „fremde Inhalte“. Symlinks und Pfade
 * liegen in einem Temp-Ordner, nie im echten Projekt.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { classifyTurnTools, foreignReason, isInsideProject, toolUseFromBlock, type ToolUse } from "../src/lib/turn-tools";

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

const classify = (uses: ToolUse[], cwd?: string) => classifyTurnTools({ uses, cwd: cwd ?? root }, root);

describe("isInsideProject", () => {
  test("Pfade im Projekt, relativ und absolut", () => {
    expect(isInsideProject(join(root, "src", "a.ts"), root, root)).toBe(true);
    expect(isInsideProject("src/a.ts", root, root)).toBe(true);
    expect(isInsideProject("src/neu/gibt-es-nicht.ts", root, root)).toBe(true);
    expect(isInsideProject(root, root, root)).toBe(true);
  });

  test("Pfade außerhalb, auch über .. und Namensähnlichkeit", () => {
    expect(isInsideProject(join(outside, "mail.txt"), root, root)).toBe(false);
    expect(isInsideProject("../fremd/mail.txt", root, root)).toBe(false);
    expect(isInsideProject(`${root}-kopie/a.ts`, root, root)).toBe(false);
    expect(isInsideProject("/etc/hosts", root, root)).toBe(false);
  });

  test("Symlinks werden aufgelöst", () => {
    expect(isInsideProject(join(root, "link-nach-aussen", "mail.txt"), root, root)).toBe(false);
    expect(isInsideProject(join(base, "link-ins-projekt", "src", "a.ts"), root, root)).toBe(true);
    // Projektwurzel selbst über einen Symlink angegeben
    expect(isInsideProject(join(root, "src", "a.ts"), root, join(base, "link-ins-projekt"))).toBe(true);
  });
});

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
    expect(foreignReason({ name: "mcp__claude_ai_Gmail__search_threads" }, root, root)).toContain("Mail");
    expect(foreignReason({ name: "mcp__firecrawl__firecrawl_scrape" }, root, root)).toContain("Web");
  });

  test("unbekannte MCP-Werkzeuge gelten vorsichtshalber als fremd", () => {
    expect(classify([{ name: "mcp__irgendwas__tu_was" }]).status).toBe("foreign");
  });

  test("Read außerhalb des Projekts ist fremd, innerhalb nicht", () => {
    expect(classify([{ name: "Read", path: join(outside, "mail.txt") }])).toEqual({
      status: "foreign",
      reasons: ["Read außerhalb des Projekts"],
    });
    expect(classify([{ name: "Read", path: join(root, "link-nach-aussen", "mail.txt") }]).status).toBe("foreign");
    expect(classify([{ name: "Read", path: "src/a.ts" }]).status).toBe("own");
  });

  test("Grep/Glob ohne Pfad gelten im Arbeitsverzeichnis", () => {
    expect(classify([{ name: "Grep" }], outside).status).toBe("foreign");
    expect(classify([{ name: "Grep" }], root).status).toBe("own");
  });

  test("Bash nur mit Netzabruf fremd", () => {
    expect(classify([{ name: "Bash", command: "curl -s https://example.com" }]).status).toBe("foreign");
    expect(classify([{ name: "Bash", command: "gh api repos/x/y/issues" }]).status).toBe("foreign");
    expect(classify([{ name: "Bash", command: "git status && bun test" }]).status).toBe("own");
  });

  test("externe Werkzeuge der Sprach-Brücke: Systemwerkzeuge harmlos, andere fremd", () => {
    expect(classify([{ name: "end_call", external: true }]).status).toBe("own");
    expect(classify([{ name: "webhook_wetter", external: true }]).status).toBe("foreign");
  });

  test("Gründe ohne Doppel, alle fremden Werkzeuge aufgeführt", () => {
    const v = classify([{ name: "WebFetch" }, { name: "WebFetch" }, { name: "Read", path: "/etc/hosts" }, { name: "Edit" }]);
    expect(v).toEqual({ status: "foreign", reasons: ["WebFetch", "Read außerhalb des Projekts"] });
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
