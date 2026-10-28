/**
 * Issue #100, Schritt 3: Telegram-, Terminal- und Einrichtungs-Texte und die
 * Agenten-Prompts nennen tybo (aus src/brand.ts) statt des früheren Namens. Agenten mit
 * den Standard-Prompts aus src/agents, Katalog nur in einem temporären Ordner
 * (config/agents.json des Nutzers bleibt unberührt). Dazu eine Quelltext-
 * Prüfung: kein fester alter Name mehr in Texten außerhalb von Kommentaren,
 * mit begründeten Ausnahmen. src/bot.ts wird dabei nur als Text gelesen.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { BRAND } from "../src/brand";
import { BASE_CONTEXT, getAgentConfig } from "../src/agents/base";
import { setAgentCatalogPaths } from "../src/agents/catalog";
import { AGENT_NAMES } from "../src/agents/names";
import { HELP_TEXT } from "../src/lib/commands/builtin";
import { STATUS_TEXT } from "../src/web/status";
import { KEYS_TEXT } from "../src/web/keys";
import { OLD_CLI, OLD_NAME } from "./old-names";

const root = resolve(import.meta.dir, "..");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-brand-texts-"));
  setAgentCatalogPaths({ file: join(dir, "agents.json"), backupDir: join(dir, "backups"), topicsFile: join(dir, "topics.json") });
});
afterEach(() => {
  setAgentCatalogPaths();
  rmSync(dir, { recursive: true, force: true });
});

describe("Agenten-Prompts (Standard, frische Session)", () => {
  test("gemeinsamer Teil nennt den Assistenten tybo", () => {
    expect(BASE_CONTEXT).toContain(`You are ${BRAND.name}, a personal assistant`);
  });

  test("jeder mitgelieferte Agent beginnt mit dem gemeinsamen Teil und nennt keinen alten Namen", () => {
    for (const name of AGENT_NAMES) {
      const prompt = getAgentConfig(name)!.systemPrompt;
      expect(prompt).toContain(`You are ${BRAND.name}, a personal assistant`);
      expect(prompt).not.toMatch(new RegExp(`${OLD_NAME}|\\bYou are Go\\b`, "i"));
    }
  });

  test("Tech-Agent (cto) ist auch für tybo selbst zuständig", () => {
    expect(getAgentConfig("cto")!.systemPrompt).toContain(`- ${BRAND.name} itself: how this assistant works and how to extend it.`);
  });
});

describe("Texte in Telegram, WebUI-Server und Terminal", () => {
  test("/help-Spickzettel", () => {
    expect(HELP_TEXT.split("\n")[0]).toBe(`🤖 **${BRAND.name} Spickzettel**`);
  });

  test("Neustart- und Schlüssel-Meldungen", () => {
    expect(STATUS_TEXT.noSupervisor).toStartWith(`${BRAND.name} läuft nicht unter launchd, PM2 oder systemd.`);
    expect(STATUS_TEXT.requested).toContain(`${BRAND.name} startet nach der laufenden Antwort neu`);
    expect(KEYS_TEXT.readOnly).toContain(`${BRAND.name} neu starten`);
  });
});

/** Alle .ts-Dateien unter einem Ordner */
async function tsFiles(folder: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

/** Begründete Resttreffer außerhalb von Kommentaren (seit Issue #142 keine) */
const ALLOWED: RegExp[] = [];

/**
 * Alte Namen: der frühere Produktname (OLD_NAME) und der frühere Befehl
 * (OLD_CLI), egal wie geschrieben und auch als Teil technischer Namen
 * (seit Issue #143 ohne Ausnahmen)
 */
const OLD_NAME_RE = new RegExp(`${OLD_NAME}|${OLD_CLI}`, "i");

/** Zeilen mit altem Namen außerhalb von Kommentaren */
function oldNameHits(text: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
    if (!OLD_NAME_RE.test(line)) return;
    if (ALLOWED.some(re => re.test(line))) return;
    hits.push({ line: i + 1, text: line.trim() });
  });
  return hits;
}

describe("Quelltext ohne festen alten Namen", () => {
  test("Prüfung erkennt den alten Namen unabhängig von der Schreibweise, auch in technischen Namen", () => {
    const low = OLD_NAME.toLowerCase();
    const oldHeader = `║          Google OAuth Setup for ${OLD_NAME}                       ║`;
    expect(oldNameHits(oldHeader)).toEqual([{ line: 1, text: oldHeader }]);
    for (const line of [
      `log("${OLD_NAME.toUpperCase()} läuft")`,
      `log("${low} läuft")`,
      `log("${OLD_NAME}-Bericht")`,
      `log("${OLD_CLI} hilft")`,
      `import { x } from "./web/${low}-turn";`,
      `const QUEUE = "${low}-whatsapp";`,
      `const n = d.github.${low}.openPRs;`,
      `const name = "${low}_bot";`,
    ])
      expect(oldNameHits(line)).toHaveLength(1);
    for (const line of ['import { x } from "./web/bot-turn";', `// ${OLD_NAME} im Kommentar`, 'log("tybo läuft")'])
      expect(oldNameHits(line)).toEqual([]);
  });

  // Ersatz für die Prüfung von setup/setup-google-oauth.ts (Issue #356: jetzt Schritt google)
  test("Schritt google: Beschreibung und Seiten nach der Anmeldung nennen den Namen aus BRAND", async () => {
    const { googleStep } = await import("../src/setup/steps/google");
    const { waitForSignIn } = await import("../src/setup/google-oauth");
    expect(googleStep.description).toContain(BRAND.name);
    let page = "";
    let handler: ((req: Request) => Response) | undefined;
    await waitForSignIn({
      clientId: "1-test.apps.googleusercontent.com",
      deps: { serve: (_port, h) => ((handler = h), { close() {} }), openBrowser: async () => true, port: 8976, timeoutMs: 1_000 },
      signal: new AbortController().signal,
      onReady: () => {
        const state = new URL(handler!(new Request("http://127.0.0.1:8976/")).headers.get("Location")!).searchParams.get("state");
        handler!(new Request(`http://127.0.0.1:8976/callback?code=x&state=${state}`))
          .text()
          .then(t => (page = t));
      },
    });
    await Bun.sleep(0);
    expect(page).toContain(`${BRAND.name}: Verbunden`);
    for (const file of ["src/setup/steps/google.ts", "src/setup/google-oauth.ts"]) {
      expect(oldNameHits(await readFile(join(root, file), "utf8"))).toEqual([]);
    }
  });

  test("src, setup und scripts/tybo.ts: alter Name nur in Kommentaren oder begründeten Ausnahmen", async () => {
    const files = [...(await tsFiles(join(root, "src"))), ...(await tsFiles(join(root, "setup"))), join(root, "scripts", "tybo.ts")];
    const found: string[] = [];
    for (const file of files) {
      for (const hit of oldNameHits(await readFile(file, "utf8"))) found.push(`${relative(root, file)}:${hit.line}: ${hit.text}`);
    }
    expect(found).toEqual([]);
  });
});
