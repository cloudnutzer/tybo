/**
 * Issue #304: Topic-Zuordnung allein aus config/topics.json. Der Chat-Eintrag
 * geht vor "*", ohne Eintrag gibt es keinen Agenten. base.ts legt den Pfad
 * beim Import aus dem Arbeitsverzeichnis fest und merkt sich die Datei nach
 * mtime, deshalb läuft jeder Fall in einem eigenen Prozess mit frischem
 * temporärem Arbeitsverzeichnis.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BASE = resolve(import.meta.dir, "..", "src", "agents", "base.ts");
const CHAT = "-1001234567890";
const OTHER = "-1009999999999";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-topic-mapping-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Probe {
  /** Agent je Abfrage "<topic>@<chat>"; null steht für undefined */
  agents: Record<string, string | null>;
  mapping: Record<string, Record<string, string>>;
}

function probe(config?: unknown): Probe {
  if (config !== undefined) {
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "topics.json"), JSON.stringify(config));
  }
  const code = `
    const { getAgentByTopicId, getTopicMappingForChat } = await import(${JSON.stringify(BASE)});
    const agents = {};
    for (const [topic, chat] of [[3, ${JSON.stringify(CHAT)}], [5, ${JSON.stringify(CHAT)}], [3, ${JSON.stringify(OTHER)}], [3, undefined], [7, ${JSON.stringify(CHAT)}]]) {
      const agent = getAgentByTopicId(topic, chat);
      if (agent !== undefined && typeof agent !== "string") throw new Error("kein String: " + typeof agent);
      agents[topic + "@" + (chat ?? "-")] = agent === undefined ? null : agent;
    }
    const mapping = {
      chat: getTopicMappingForChat(${JSON.stringify(CHAT)}),
      other: getTopicMappingForChat(${JSON.stringify(OTHER)}),
    };
    console.log(JSON.stringify({ agents, mapping }));
  `;
  const r = Bun.spawnSync([process.execPath, "-e", code], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  const lines = r.stdout.toString().trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

const NONE = { [`3@${CHAT}`]: null, [`5@${CHAT}`]: null, [`3@${OTHER}`]: null, "3@-": null, [`7@${CHAT}`]: null };

test("ohne Datei: kein Agent, leere Zuordnung", () => {
  expect(probe()).toStrictEqual({ agents: NONE, mapping: { chat: {}, other: {} } });
});

test("ungültige Datei: wie ohne Datei", () => {
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "topics.json"), "{ kaputt");
  expect(probe()).toStrictEqual({ agents: NONE, mapping: { chat: {}, other: {} } });
});

test('nur "*": gilt für jeden Chat und ohne Chat', () => {
  expect(probe({ "*": { "3": "finance" } })).toStrictEqual({
    agents: { ...NONE, [`3@${CHAT}`]: "finance", [`3@${OTHER}`]: "finance", "3@-": "finance" },
    mapping: { chat: { "3": "finance" }, other: { "3": "finance" } },
  });
});

test('Chat-Eintrag geht vor "*", gleiche Topic-ID, andere Chats behalten "*"', () => {
  const config = { "*": { "3": "finance", "5": "critic" }, [CHAT]: { "3": "research", "7": "cto" } };
  expect(probe(config)).toStrictEqual({
    agents: {
      [`3@${CHAT}`]: "research",
      [`5@${CHAT}`]: "critic",
      [`3@${OTHER}`]: "finance",
      "3@-": "finance",
      [`7@${CHAT}`]: "cto",
    },
    mapping: {
      chat: { "3": "research", "5": "critic", "7": "cto" },
      other: { "3": "finance", "5": "critic" },
    },
  });
});

test('leere und falsche Werte in "*": kein Agent, gültiger Chat-Eintrag geht weiter vor', () => {
  for (const value of ["", null, 0, false]) {
    const { agents } = probe({ "*": { "3": value, "5": value }, [CHAT]: { "3": "research" } });
    expect(agents).toStrictEqual({ ...NONE, [`3@${CHAT}`]: "research" });
    rmSync(join(dir, "config"), { recursive: true, force: true });
  }
});
