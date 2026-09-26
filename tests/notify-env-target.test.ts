/**
 * Issue #46, Aufgabe 6: bun run notify nimmt ohne --topic das Gespräch aus
 * TYBO_TOPIC_ID/TYBO_CHAT_ID; --topic hat Vorrang; ungültige Werte ergeben
 * Exit 2 ohne Versand. In-process mit Attrappen, dazu ein echter Prozess ohne
 * Bot-Token (nie ein echter Telegram-Aufruf).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { OutboxDeps } from "../src/lib/outbox";
import type { Message } from "../src/lib/supabase";
import { EXIT_OK, EXIT_USAGE, applyEnvTarget, runNotify } from "../scripts/notify";

const USER = "4711";
const GROUP = "-1001234567890";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notify-env-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(groupId: string | null = GROUP) {
  const payloads: Record<string, unknown>[] = [];
  const recorded: Message[] = [];
  const err: string[] = [];
  const deps: OutboxDeps = {
    botToken: "123:t",
    userId: USER,
    groupId,
    outboxDir: join(dir, "outbox"),
    fetch: async (_url, init) => {
      payloads.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    },
    record: async m => {
      recorded.push(m);
      return true;
    },
    log: () => {},
    newId: () => crypto.randomUUID(),
  };
  const io = { out: () => {}, err: (l: string) => void err.push(l) };
  const run = (argv: string[], env: Record<string, string | undefined>) => runNotify(argv, () => deps, io, env);
  return { run, payloads, recorded, err };
}

const TEXT = ["--source", "datei", "--text", "Report fertig"];

describe("Ziel aus der Umgebung", () => {
  test("leere Umgebung: Direktchat", async () => {
    const s = setup();
    expect(await s.run(TEXT, {})).toBe(EXIT_OK);
    expect(s.payloads[0]).toMatchObject({ chat_id: USER });
    expect(s.payloads[0].message_thread_id).toBeUndefined();
  });

  test("Topic und Chat aus der Umgebung: dieses Topic", async () => {
    const s = setup();
    expect(await s.run(TEXT, { TYBO_CHAT_ID: GROUP, TYBO_TOPIC_ID: "443" })).toBe(EXIT_OK);
    expect(s.payloads[0]).toMatchObject({ chat_id: GROUP, message_thread_id: 443 });
    expect(s.recorded[0]).toMatchObject({ chat_id: GROUP, metadata: { topicId: 443, source: "datei" } });
  });

  test("nur Topic: Topic der Forum-Gruppe", async () => {
    const s = setup();
    expect(await s.run(TEXT, { TYBO_TOPIC_ID: "443" })).toBe(EXIT_OK);
    expect(s.payloads[0]).toMatchObject({ chat_id: GROUP, message_thread_id: 443 });
  });

  test("nur Chat = Gruppe: General", async () => {
    const s = setup();
    expect(await s.run(TEXT, { TYBO_CHAT_ID: GROUP })).toBe(EXIT_OK);
    expect(s.payloads[0]).toMatchObject({ chat_id: GROUP });
    expect(s.payloads[0].message_thread_id).toBeUndefined();
  });

  test("nur Chat = Direktchat: Direktchat", async () => {
    const s = setup();
    expect(await s.run(TEXT, { TYBO_CHAT_ID: USER })).toBe(EXIT_OK);
    expect(s.payloads[0]).toMatchObject({ chat_id: USER });
  });

  test("--topic hat Vorrang und ignoriert beide Umgebungswerte, auch ungültige", async () => {
    for (const env of [
      { TYBO_CHAT_ID: USER, TYBO_TOPIC_ID: "7" },
      { TYBO_CHAT_ID: "kaputt", TYBO_TOPIC_ID: "abc" },
      { TYBO_CHAT_ID: "-100999", TYBO_TOPIC_ID: "" },
    ]) {
      const s = setup();
      expect(await s.run([...TEXT, "--topic", "443"], env)).toBe(EXIT_OK);
      expect(s.payloads[0]).toMatchObject({ chat_id: GROUP, message_thread_id: 443 });
    }
  });
});

describe("ungültige Umgebung: Exit 2, kein Versand, nie Direktchat", () => {
  const CASES: [string, Record<string, string>][] = [
    ["Topic keine Zahl", { TYBO_TOPIC_ID: "abc" }],
    ["Topic 0", { TYBO_TOPIC_ID: "0" }],
    ["Topic negativ", { TYBO_TOPIC_ID: "-5" }],
    ["Topic leer gesetzt", { TYBO_TOPIC_ID: "" }],
    ["Chat leer gesetzt", { TYBO_CHAT_ID: "" }],
    ["Chat keine Zahl", { TYBO_CHAT_ID: "web:abc" }],
    ["fremder Chat", { TYBO_CHAT_ID: "-100999" }],
    ["fremder Direktchat", { TYBO_CHAT_ID: "999" }],
    ["Topic mit widersprüchlichem Chat", { TYBO_CHAT_ID: "-100999", TYBO_TOPIC_ID: "443" }],
    ["Topic im Direktchat", { TYBO_CHAT_ID: USER, TYBO_TOPIC_ID: "443" }],
  ];
  for (const [label, env] of CASES) {
    test(label, async () => {
      const s = setup();
      expect(await s.run(TEXT, env)).toBe(EXIT_USAGE);
      expect(s.payloads).toEqual([]);
      expect(s.recorded).toEqual([]);
      expect(s.err.join("\n")).toContain("Nicht gesendet");
    });
  }

  test("Topic aus der Umgebung ohne eingerichtete Gruppe", async () => {
    const s = setup(null);
    expect(await s.run(TEXT, { TYBO_TOPIC_ID: "443" })).toBe(EXIT_USAGE);
    expect(s.payloads).toEqual([]);
  });
});

test("applyEnvTarget lässt --topic unberührt", () => {
  expect(applyEnvTarget({ source: "p", text: "x", topicId: 5 }, { TYBO_CHAT_ID: "1", TYBO_TOPIC_ID: "9" })).toEqual({
    input: { source: "p", text: "x", topicId: 5 },
  });
});

test("als Prozess: ungültige Umgebung ergibt 2, bevor irgendetwas gesendet wird", () => {
  const root = mkdtempSync(join(tmpdir(), "notify-env-proc-"));
  try {
    writeFileSync(join(root, ".env"), "TELEGRAM_USER_ID=4711\n");
    const proc = Bun.spawnSync(["bun", "run", resolve(import.meta.dir, "../scripts/notify.ts"), "--source", "datei", "--text", "x"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: root, GO_PROJECT_ROOT: root, TYBO_TOPIC_ID: "abc" },
    });
    expect(proc.exitCode).toBe(EXIT_USAGE);
    expect(proc.stderr.toString()).toContain("TYBO_TOPIC_ID ist ungültig");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
