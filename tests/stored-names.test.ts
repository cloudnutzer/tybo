/**
 * Issue #141: gespeicherte Namen heißen nach tybo. Muster-Datei des
 * Feedback-Loops, Schwerpunkt einer Session im Projektordner, Name bei
 * MCP-Servern, Erwähnung in WhatsApp-Gruppen und .gitignore.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PATTERNS_PATH, sessionFocusFor } from "../src/lib/feedback-loop";
import { mcpClientName } from "../src/lib/mcp-client";
import { shouldBotRespond } from "../src/lib/whatsapp-groups";

const root = join(import.meta.dir, "..");

describe("Feedback-Loop", () => {
  test("Muster-Datei liegt in config/patterns.md des Projekts", () => {
    expect(PATTERNS_PATH).toBe(join(root, "config", "patterns.md"));
  });

  test(".gitignore schützt config/patterns.md", () => {
    const lines = readFileSync(join(root, ".gitignore"), "utf8").split("\n").map(l => l.trim());
    expect(lines).toContain("config/patterns.md");
  });

  test("Projektordner von tybo ergibt tybo-development, sonst die übrigen Regeln", () => {
    expect(sessionFocusFor("/Users/alex/git-projects/tybo", "")).toBe("tybo-development");
    expect(sessionFocusFor("/home/mia/tybo-webui/src", "research")).toBe("tybo-development");
    expect(sessionFocusFor("/srv/services/x", "")).toBe("pai-services");
    expect(sessionFocusFor("/home/mia/development/app", "")).toBe("development");
    expect(sessionFocusFor("/tmp", "Bitte Research zu X")).toBe("research");
    expect(sessionFocusFor("/tmp", "neues Video")).toBe("content-creation");
    expect(sessionFocusFor("/tmp", "hallo")).toBe("general");
  });
});

test("MCP-Client meldet sich als tybo-<server>", () => {
  expect(mcpClientName("notion")).toBe("tybo-notion");
});

describe("WhatsApp-Gruppen", () => {
  test("@tybo und @bot rufen den Bot auf", () => {
    expect(shouldBotRespond("@tybo wie spät ist es?")).toEqual({ question: "wie spät ist es?" });
    expect(shouldBotRespond("@Tybo hallo")).toEqual({ question: "hallo" });
    expect(shouldBotRespond("@bot hallo")).toEqual({ question: "hallo" });
  });

  test("andere Erwähnungen nicht", () => {
    expect(shouldBotRespond("@alex hallo")).toBeNull();
  });
});
