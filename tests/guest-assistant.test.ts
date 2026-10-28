/**
 * Issue #345: Direkte Tests des Gäste-Assistenten (answerGuest), der durch
 * den Umbau des WhatsApp-Besitzers unverändert bleibt. Gäste bekommen nur
 * ihren eigenen Verlauf und keinen Zugang zu Werkzeugen oder Daten des
 * Besitzers. Arbeitsordner und Budget-Datei liegen im Temp-Ordner,
 * OpenRouter ist eine fetch-Attrappe.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerGuest, isWhatsAppOwner, saveGuestMessage } from "../src/lib/guest-assistant";

const KEYS = ["OPENROUTER_API_KEY", "WHATSAPP_GUEST_MODEL", "OPENROUTER_MODEL", "BUDGET_DB_PATH", "WHATSAPP_OWNER_NUMBER", "WHATSAPP_USER_NUMBER"] as const;

let dir: string;
let savedCwd: string;
let savedEnv: Record<string, string | undefined>;
let realFetch: typeof fetch;
let bodies: { model: string; messages: { role: string; content: string }[] }[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "guest-assistant-"));
  savedCwd = process.cwd();
  savedEnv = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.BUDGET_DB_PATH = join(dir, "budget.sqlite");
  process.chdir(dir);
  realFetch = globalThis.fetch;
  bodies = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ choices: [{ message: { content: "Hallo Gast" } }], usage: { cost: 0.001 } });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  process.chdir(savedCwd);
  for (const k of KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await rm(dir, { recursive: true, force: true });
});

describe("answerGuest", () => {
  test("ohne OpenRouter-Schlüssel: fester Hinweis, kein Aufruf", async () => {
    expect(await answerGuest("wa:+491", "Hallo")).toBe("Der Gäste-Assistent ist derzeit nicht verfügbar.");
    expect(bodies).toEqual([]);
  });

  test("nur eigener Verlauf, Systemprompt ohne Werkzeuge und Betreiberdaten", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.WHATSAPP_GUEST_MODEL = "test/gast-modell";
    saveGuestMessage("wa:+491", "user", "Frage eins");
    saveGuestMessage("wa:+491", "assistant", "Antwort eins");
    saveGuestMessage("wa:+492", "user", "fremder Verlauf");
    saveGuestMessage("wa:+491", "user", "Frage zwei");
    expect(await answerGuest("wa:+491", "Frage zwei")).toBe("Hallo Gast");
    const [body] = bodies;
    expect(body.model).toBe("test/gast-modell");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("keine Werkzeuge oder persönlichen Daten des Betreibers");
    // Bereits gespeicherte Nachricht nicht doppelt, fremder Verlauf nie
    expect(body.messages.slice(1)).toEqual([
      { role: "user", content: "Frage eins" },
      { role: "assistant", content: "Antwort eins" },
      { role: "user", content: "Frage zwei" },
    ]);
  });

  test("noch nicht gespeicherte Nachricht wird angehängt", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    await answerGuest("wa:group:fam", "neu");
    expect(bodies[0].messages.slice(1)).toEqual([{ role: "user", content: "neu" }]);
  });

  test("Verlauf je Gespräch auf 20 Einträge gekürzt, im Prompt höchstens 10", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    for (let i = 0; i < 25; i++) saveGuestMessage("wa:+491", "user", `n${i}`);
    await answerGuest("wa:+491", "n24");
    expect(bodies[0].messages.slice(1).map(m => m.content)).toEqual(Array.from({ length: 10 }, (_, i) => `n${15 + i}`));
  });

  test("Fehler des Anbieters wirft", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = (async () => new Response("nein", { status: 500 })) as unknown as typeof fetch;
    await expect(answerGuest("wa:+491", "x")).rejects.toThrow("Guest provider: 500");
  });
});

describe("isWhatsAppOwner", () => {
  test("WHATSAPP_OWNER_NUMBER vor WHATSAPP_USER_NUMBER, Präfix und Leerraum egal", () => {
    expect(isWhatsAppOwner("+491")).toBe(false);
    process.env.WHATSAPP_USER_NUMBER = "+49 1";
    expect(isWhatsAppOwner("whatsapp:+491")).toBe(true);
    process.env.WHATSAPP_OWNER_NUMBER = "+492";
    expect(isWhatsAppOwner("+491")).toBe(false);
    expect(isWhatsAppOwner("+492")).toBe(true);
  });
});
