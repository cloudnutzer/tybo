/**
 * Issue #135: config/topics.json ist nicht mehr im Repo. Ohne die Datei
 * startet die Topic-Zuordnung mit den Standards. Der Pfad wird beim Import
 * von src/agents/base.ts aus dem Arbeitsverzeichnis festgelegt, deshalb läuft
 * die Prüfung in einem eigenen Prozess mit temporärem Arbeitsverzeichnis; die
 * echte config/topics.json wird nie angefasst.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BASE = resolve(import.meta.dir, "..", "src", "agents", "base.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-topics-missing-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Im Kindprozess wird ausdrücklich auf === undefined geprüft (JSON kennt kein
// undefined); isUndefined trägt dieses Ergebnis zurück.
function lookup(): { isUndefined: boolean; agent: string | null; chats: string[] } {
  const code = `
    const { getAgentByTopicId, getTopicConfigChatIds } = await import(${JSON.stringify(BASE)});
    const agent = getAgentByTopicId(3, "-1001234567890");
    console.log(JSON.stringify({ isUndefined: agent === undefined, agent: agent === undefined ? null : agent, chats: getTopicConfigChatIds() }));
  `;
  const r = Bun.spawnSync([process.execPath, "-e", code], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  const lines = r.stdout.toString().trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

test("ohne config/topics.json: getAgentByTopicId liefert undefined statt einer Ausnahme", () => {
  expect(lookup()).toStrictEqual({ isUndefined: true, agent: null, chats: [] });
});

test("Gegenprobe: mit config/topics.json im selben Arbeitsverzeichnis greift die Zuordnung", () => {
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "topics.json"), JSON.stringify({ "-1001234567890": { "3": "research" } }));
  expect(lookup()).toStrictEqual({ isUndefined: false, agent: "research", chats: ["-1001234567890"] });
});
