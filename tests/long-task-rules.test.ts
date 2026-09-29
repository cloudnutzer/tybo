/**
 * Issue #180: Arbeitsregel LONG TASKS im Basis-Prompt. Jeder Agent bekommt
 * sie (mitgeliefert, eigen, mit geändertem Prompt aus config/agents.json),
 * der Text nennt Job-Befehl, Grenzen aus src/lib/turn-limits.ts, Warteverbot
 * und Notify-Aufruf. Der Katalog liegt in einem temporären Ordner, die echte
 * config/agents.json bleibt unberührt.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BASE_CONTEXT,
  DEFAULT_LONG_TASK_LIMITS,
  LONG_TASK_MAX_WAIT_MIN,
  LONG_TASK_JOB_THRESHOLD_MIN,
  LONG_TASK_RULES,
  LONG_TASKS_HEADING,
  formatLongTaskRules,
  getAgentConfig,
} from "../src/agents/base";
import { createAgent, setAgentCatalogPaths, setPrompt } from "../src/agents/catalog";
import { AGENT_NAMES } from "../src/agents/names";
import * as chatTurn from "../src/lib/chat-turn";
import * as turnLimits from "../src/lib/turn-limits";

const root = resolve(import.meta.dir, "..");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-long-task-rules-"));
  setAgentCatalogPaths({ file: join(dir, "agents.json"), backupDir: join(dir, "backups"), topicsFile: join(dir, "topics.json") });
});
afterEach(() => {
  setAgentCatalogPaths();
  rmSync(dir, { recursive: true, force: true });
});

/** Wie oft der Block im Prompt steht */
function count(prompt: string): number {
  return prompt.split(LONG_TASKS_HEADING).length - 1;
}

describe("Block LONG TASKS im Basis-Prompt", () => {
  test("steht direkt nach CROSS-AGENT NORMS, die bisherigen Blöcke bleiben unverändert", () => {
    const norms =
      "CROSS-AGENT NORMS:\n" +
      "- Only respond with substance. Acknowledgment-only replies (\"noted\", \"thanks\",\n" +
      "  \"will do\") are noise — silence is a valid outcome.\n" +
      "- Never invoke another agent just to confirm or thank them.\n";
    expect(BASE_CONTEXT.endsWith(`${norms}\n${LONG_TASK_RULES}\n`)).toBe(true);
    expect(BASE_CONTEXT.indexOf("COMMUNICATION:")).toBeLessThan(BASE_CONTEXT.indexOf(LONG_TASKS_HEADING));
  });

  test("nennt Job-Befehl, Leerlaufgrenze, Obergrenze, Warteverbot, Hilfs-Agenten und Notify-Aufruf", () => {
    const { idleMin, maxMin, jsonMin } = DEFAULT_LONG_TASK_LIMITS;
    expect(LONG_TASK_RULES.startsWith(LONG_TASKS_HEADING)).toBe(true);
    expect(LONG_TASK_RULES).toContain('`bun run job start --title "<title>" --brief <file>`');
    expect(LONG_TASK_RULES).toContain(`stopped after ${idleMin} minutes\n  without visible activity`);
    expect(LONG_TASK_RULES).toContain(`after ${maxMin} minutes at the latest`);
    expect(LONG_TASK_RULES).toContain(`${jsonMin} minutes in total for non-streaming turns`);
    expect(LONG_TASK_RULES).toContain(`longer than ${LONG_TASK_JOB_THRESHOLD_MIN} minutes`);
    expect(LONG_TASK_RULES).toContain(
      `Never wait with sleep loops or polling for longer than ${LONG_TASK_MAX_WAIT_MIN} minutes in one command.`
    );
    expect(LONG_TASK_RULES).toContain("run them in the foreground and use their result\n  directly");
    expect(LONG_TASK_RULES).toContain('`bun run notify --source agent --text "<plan>"`');
    expect(LONG_TASK_RULES).toContain("printed a job ID");
    expect(LONG_TASK_RULES).toContain("--full-access");
  });

  test("Standardwerte: 15 und 90 Minuten Streaming, 30 Minuten JSON, eigene Schwellen 15 und 2 Minuten", () => {
    expect(DEFAULT_LONG_TASK_LIMITS).toEqual({ idleMin: 15, maxMin: 90, jsonMin: 30 });
    expect(LONG_TASK_JOB_THRESHOLD_MIN).toBe(15);
    expect(LONG_TASK_MAX_WAIT_MIN).toBe(2);
  });

  test("Werte stammen aus denselben Konstanten wie chat-turn.ts", () => {
    expect(chatTurn.CLAUDE_IDLE_TIMEOUT_MS).toBe(turnLimits.CLAUDE_IDLE_TIMEOUT_MS);
    expect(chatTurn.CLAUDE_CALL_TIMEOUT_MS).toBe(turnLimits.CLAUDE_CALL_TIMEOUT_MS);
    expect(chatTurn.JSON_CALL_TIMEOUT_MS).toBe(turnLimits.JSON_CALL_TIMEOUT_MS);
    expect(chatTurn.resolveStreamingLimits).toBe(turnLimits.resolveStreamingLimits);
    expect(DEFAULT_LONG_TASK_LIMITS).toEqual({
      idleMin: turnLimits.CLAUDE_IDLE_TIMEOUT_MS / 60_000,
      maxMin: turnLimits.CLAUDE_CALL_TIMEOUT_MS / 60_000,
      jsonMin: turnLimits.JSON_CALL_TIMEOUT_MS / 60_000,
    });
  });

  test("andere Grenzen ergeben anderen Text, keine festen Minuten", () => {
    const text = formatLongTaskRules({ idleMin: 7, maxMin: 120, jsonMin: 45 });
    expect(text).toContain("stopped after 7 minutes");
    expect(text).toContain("after 120 minutes at the latest");
    expect(text).toContain("45 minutes in total");
    expect(text).not.toContain(" 90 minutes");
    expect(text).not.toContain(" 30 minutes");
  });

  test("keine Gedankenstriche im neuen Block", () => {
    expect(LONG_TASK_RULES).not.toContain("—");
  });
});

describe("jeder Agent bekommt den Block", () => {
  test("mitgelieferte Agenten mit Standard-Prompt", () => {
    for (const name of AGENT_NAMES) {
      const prompt = getAgentConfig(name)!.systemPrompt;
      expect(prompt).toContain(LONG_TASK_RULES);
      expect(count(prompt)).toBe(1);
    }
  });

  test("eigener Agent", async () => {
    await createAgent({ name: "projekt-planer", description: "Plant Projekte", systemPrompt: "Du planst Projekte." });
    const prompt = getAgentConfig("projekt-planer")!.systemPrompt;
    expect(prompt).toContain(LONG_TASK_RULES);
    expect(count(prompt)).toBe(1);
  });

  test("geänderter Prompt ohne Block: Block wird angehängt, gespeicherter Text bleibt unverändert", async () => {
    await setPrompt("research", "Eigener Research-Prompt ohne Basis-Teil");
    await setPrompt("general", "Eigener General-Prompt");
    await createAgent({ name: "projekt-planer", description: "Plant Projekte", systemPrompt: "Du planst." });
    for (const name of ["research", "general"]) {
      const prompt = getAgentConfig(name)!.systemPrompt;
      expect(prompt).toContain(LONG_TASK_RULES);
      expect(count(prompt)).toBe(1);
    }
    // General: Block vor dem Hinweis auf eigene Agenten
    const general = getAgentConfig("general")!.systemPrompt;
    expect(general.indexOf(LONG_TASKS_HEADING)).toBeLessThan(general.indexOf("## ADDITIONAL AGENTS"));
    const stored = JSON.parse(readFileSync(join(dir, "agents.json"), "utf8"));
    expect(stored.prompts.research).toBe("Eigener Research-Prompt ohne Basis-Teil");
    expect(stored.prompts.general).toBe("Eigener General-Prompt");
  });

  test("geänderter Prompt mit Block (aus dem Code übernommen): nicht doppelt", async () => {
    const code = getAgentConfig("finance")!.systemPrompt;
    await setPrompt("finance", `${code}\nZusatz vom Nutzer.`);
    const prompt = getAgentConfig("finance")!.systemPrompt;
    expect(prompt).toBe(`${code}\nZusatz vom Nutzer.`);
    expect(count(prompt)).toBe(1);
  });

  test("vom Nutzer umformulierter Block: Text bleibt, aktueller Block kommt dazu", async () => {
    const own = `Mein Prompt.\n\n${LONG_TASKS_HEADING}\n- Jobs erst ab 60 Minuten.`;
    await setPrompt("coo", own);
    expect(getAgentConfig("coo")!.systemPrompt).toBe(`${own}\n\n${LONG_TASK_RULES}\n`);
    const stored = JSON.parse(readFileSync(join(dir, "agents.json"), "utf8"));
    expect(stored.prompts.coo).toBe(own);
  });

  test("bloße Überschrift unterdrückt den Block nicht", async () => {
    const own = `Mein Prompt.\n\n${LONG_TASKS_HEADING}`;
    await setPrompt("cto", own);
    const prompt = getAgentConfig("cto")!.systemPrompt;
    expect(prompt).toBe(`${own}\n\n${LONG_TASK_RULES}\n`);
    const stored = JSON.parse(readFileSync(join(dir, "agents.json"), "utf8"));
    expect(stored.prompts.cto).toBe(own);
  });

  test("gespeicherter Code-Prompt mit alten Zeitwerten bekommt die aktuellen", async () => {
    const code = getAgentConfig("strategy")!.systemPrompt;
    const old = formatLongTaskRules({ idleMin: 5, maxMin: 30, jsonMin: 10 });
    expect(old).not.toBe(LONG_TASK_RULES);
    const saved = `${code.replace(LONG_TASK_RULES, old)}\nZusatz vom Nutzer.`;
    expect(saved).toContain(old);
    await setPrompt("strategy", saved);
    const prompt = getAgentConfig("strategy")!.systemPrompt;
    expect(prompt).toBe(`${code}\nZusatz vom Nutzer.`);
    expect(prompt).not.toContain(old);
    expect(count(prompt)).toBe(1);
    const stored = JSON.parse(readFileSync(join(dir, "agents.json"), "utf8"));
    expect(stored.prompts.strategy).toBe(saved);
  });
});

describe("geänderte Konstanten ändern den Prompt (Kindprozess)", () => {
  test("andere Werte in turn-limits.ts erscheinen im Block und in chat-turn.ts", async () => {
    // Die Datei wird nur im Kindprozess beim Laden umgeschrieben, nie auf der Platte.
    const code = `
      import { plugin } from "bun";
      import { readFileSync } from "fs";
      plugin({ name: "limits", setup(b) {
        b.onLoad({ filter: /src\\/lib\\/turn-limits\\.ts$/ }, (a) => {
          let src = readFileSync(a.path, "utf8");
          for (const [from, to] of [
            ["CLAUDE_IDLE_TIMEOUT_MS = 900_000", "CLAUDE_IDLE_TIMEOUT_MS = 420_000"],
            ["CLAUDE_CALL_TIMEOUT_MS = 5_400_000", "CLAUDE_CALL_TIMEOUT_MS = 7_200_000"],
            ["JSON_CALL_TIMEOUT_MS = 1_800_000", "JSON_CALL_TIMEOUT_MS = 2_700_000"],
          ]) {
            if (!src.includes(from)) throw new Error("Ersetzung fehlgeschlagen: " + from);
            src = src.replace(from, to);
          }
          return { loader: "ts", contents: src };
        });
      }});
      const base = await import(${JSON.stringify(join(root, "src/agents/base.ts"))});
      const turn = await import(${JSON.stringify(join(root, "src/lib/chat-turn.ts"))});
      console.log(JSON.stringify({
        rules: base.LONG_TASK_RULES,
        inBase: base.BASE_CONTEXT.includes(base.LONG_TASK_RULES),
        idle: turn.CLAUDE_IDLE_TIMEOUT_MS,
        max: turn.CLAUDE_CALL_TIMEOUT_MS,
      }));`;
    const child = Bun.spawn([process.execPath, "-e", code], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(err).not.toContain("Ersetzung fehlgeschlagen");
    expect(await child.exited).toBe(0);
    const res = JSON.parse(out.trim().split("\n").at(-1)!) as { rules: string; inBase: boolean; idle: number; max: number };
    expect(res.idle).toBe(420_000);
    expect(res.max).toBe(7_200_000);
    expect(res.inBase).toBe(true);
    expect(res.rules).toContain("stopped after 7 minutes");
    expect(res.rules).toContain("after 120 minutes at the latest");
    expect(res.rules).toContain("45 minutes in total");
    expect(res.rules).not.toBe(LONG_TASK_RULES);
  }, 30_000);
});
