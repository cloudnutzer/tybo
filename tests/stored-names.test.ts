/**
 * Issue #141: gespeicherte Namen heißen nach tybo. Name bei MCP-Servern,
 * Erwähnung in WhatsApp-Gruppen und .gitignore. Den Feedback-Loop samt
 * Muster-Datei und Session-Schwerpunkt gibt es seit Issue #374 nicht mehr (E7).
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mcpClientName } from "../src/lib/mcp/manager";
import { shouldBotRespond } from "../src/lib/whatsapp-groups";

const root = join(import.meta.dir, "..");

describe("Feedback-Loop entfernt (E7)", () => {
  test("Module und Skript feedback gibt es nicht mehr", async () => {
    expect(existsSync(join(root, "src", "feedback.ts"))).toBe(false);
    expect(existsSync(join(root, "src", "lib", "feedback-loop.ts"))).toBe(false);
    const pkg = await Bun.file(join(root, "package.json")).json();
    expect(Object.keys(pkg.scripts)).not.toContain("feedback");
  });

  test(".gitignore schützt eine alte config/patterns.md weiter", () => {
    // Bestehende Installationen können die Datei noch haben; sie soll nie ins Repo
    const check = Bun.spawnSync(["git", "check-ignore", "-q", "--no-index", "config/patterns.md"], { cwd: root });
    expect(check.exitCode).toBe(0);
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
