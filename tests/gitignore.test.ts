/**
 * Issue #381: was .gitignore schützt. Geheimnisse, eigene Einstellungen und
 * Zustände des Bots kommen nie ins Repo, auch Dateien älterer Versionen, die
 * eine bestehende Installation noch haben kann. Vorlagen bleiben sichtbar.
 *
 * Geprüft mit `git check-ignore --no-index`: so zählt allein .gitignore,
 * nicht, ob eine Datei schon im Index steht.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** Pfade, die .gitignore ausblendet, aus der Liste */
function ignored(paths: string[]): string[] {
  const run = Bun.spawnSync(["git", "check-ignore", "--no-index", "--stdin"], {
    cwd: root,
    stdin: new TextEncoder().encode(paths.join("\n") + "\n"),
  });
  // Exit 1 heißt: keiner der Pfade ist ausgeblendet
  expect([0, 1]).toContain(run.exitCode);
  return run.stdout.toString().split("\n").filter(Boolean);
}

const SECRETS = [".env", ".env.local", ".env.server", "data/.env", "src/.env.test", "config/.google-tokens.json", ".elevenlabs-agent.json"];

const OWN_SETTINGS = [
  "config/profile.md",
  "config/kern.md",
  "config/kern.md.vorher",
  "config/kern.md.lock",
  "config/kern.md.0f3c.tmp",
  "data/kern-entwurf.json",
  "data/kern-entwurf.json.lock",
  "config/schedule.json",
  "config/agent-overrides.json",
  "config/settings.json",
  "config/settings.json.lock",
  "config/topics.json",
  "config/agents.json",
  "config/routines.json",
  "config/whatsapp-groups.json",
  "config/reminders.json",
  "config/checkin-state.json",
  "config/irgendwas-state.json",
  "config/voice-agents/jarvis.json",
];

const STATE = [
  "bot.lock",
  "bot.lock.0f3c.tmp",
  "bot.lock.break-0123456789abcdef",
  "session-state.json",
  "memory.json",
  "memory.json.sqlite",
  "memory.json.sqlite-wal",
  "memory.json.sqlite-shm",
  "credit-tally.json",
  "checkin-state.json",
  "CLAUDE.local.md",
  "data/restart-requested",
  "data/jobs/x/status.json",
  "data/voice-agents/jarvis/state.json",
  "logs/telegram-relay.log",
  "uploads/bild.jpg",
  "temp/x.txt",
  "tmp/notiz.md",
  "models/parakeet.bin",
  "knowledge-base/notiz.md",
  ".releases/deploy-1.log",
  ".wrangler/state.json",
];

/** Dateien früherer Versionen, die tybo nicht mehr schreibt, eine alte Installation aber haben kann */
const LEGACY = ["config/patterns.md", "news-history.json", "last-processed-call.json", "meeting-actions-state.json"];

const BUILD = ["node_modules/x/index.js", "web/node_modules/x/index.js", "dist/bot.js", "src/web/dist/app.js"];

// Die beiden übrigen Zeilen dieses Abschnitts nennen private Projekte; sie
// sind nur in .gitignore erlaubt, das prüft der Wächter für den öffentlichen Teil
const PRIVATE_WEB = ["docs/foto-fit-worker.js", "docs/voice-bridge-reference/pages-password-worker.js"];

const VISIBLE = [
  ".env.example",
  "config/profile.example.md",
  "config/kern.example.md",
  "config/topics.example.json",
  "config/routines.example.json",
  "config/voice-agents.example/anrufannahme.json",
  "config/voice-agents.example/jarvis.json",
  "config/voice-agents.example/verhandlungstrainer.json",
  "config/mcp-servers.json",
  "src/bot.ts",
  "tests/gitignore.test.ts",
  "docs/einrichtung.md",
  "tsconfig.json",
  "package.json",
  "bun.lock",
];

describe(".gitignore", () => {
  for (const [name, list] of [
    ["Geheimnisse", SECRETS],
    ["eigene Einstellungen unter config/", OWN_SETTINGS],
    ["Zustände und Laufzeitdaten", STATE],
    ["Dateien älterer Versionen", LEGACY],
    ["Abhängigkeiten und Build", BUILD],
    ["private Webprojekte", PRIVATE_WEB],
  ] as const) {
    test(`blendet aus: ${name}`, () => {
      expect(ignored([...list])).toEqual([...list]);
    });
  }

  test("Vorlagen und Quelltext bleiben sichtbar", () => {
    expect(ignored(VISIBLE)).toEqual([]);
  });
});
