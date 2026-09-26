/**
 * Issue #134, Schritt 3: OpenRouter-Aufrufe kennzeichnen die App mit der
 * eigenen Domain, an allen Stellen über eine gemeinsame Konstante. Die
 * Aufrufer werden nur als Text gelesen.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPENROUTER_APP_HEADERS } from "../src/brand";

const root = join(import.meta.dir, "..");

test("Referer ist https://tybo.ai, Titel der Produktname", () => {
  expect(OPENROUTER_APP_HEADERS).toEqual({ "HTTP-Referer": "https://tybo.ai", "X-Title": "tybo" });
});

test("alle OpenRouter-Aufrufer nutzen die Konstante, kein fester Referer außerhalb von src/brand.ts", () => {
  const callers = ["src/lib/aux-model.ts", "src/lib/fallback-llm.ts", "src/lib/resilient-client.ts"];
  const uses = callers.map(f => (readFileSync(join(root, f), "utf8").match(/OPENROUTER_APP_HEADERS/g) ?? []).length - 1);
  // je ein Import plus die Aufrufe: aux-model 1, fallback-llm 2, resilient-client 1
  expect(uses).toEqual([1, 2, 1]);
  const grep = Bun.spawnSync(["git", "grep", "-l", "HTTP-Referer", "--", "src", "vps-convex-client.ts"], { cwd: root, stdout: "pipe" });
  expect(grep.stdout.toString().trim().split("\n")).toEqual(["src/brand.ts"]);
});
