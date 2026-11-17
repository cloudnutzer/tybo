/**
 * Issue #565: Scheitert ein Turn der WebUI mit einem Wurf, nennt die Logzeile
 * Typ, Fehlercode und Systemaufruf, nie die Meldung (sie kann Pfade,
 * Nutzerinhalt oder Zugangsdaten enthalten). Attrappe statt Claude.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatHub, TURN_FAILED_TEXT, type WebChat } from "../src/web/chat";
import { errorLogFields } from "../src/web/error-log";
import { ConversationStore } from "../src/web/store";

const root = await mkdtemp(join(tmpdir(), "tybo-565-web-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const SECRET = "sk-ant-api03-GEHEIM1234567890";

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

describe("Logzeile bei einem geworfenen Startfehler", () => {
  test("ENOENT: Code und Systemaufruf im Log, Meldung und Geheimnis nicht, Nutzer sieht den festen Text", async () => {
    const store = new ConversationStore({ dir: join(root, "hub") });
    await store.load();
    const logs: string[] = [];
    const chat: WebChat = {
      runTurn: async () => {
        throw Object.assign(new Error(`ENOENT: no such file or directory, posix_spawn '/home/${SECRET}/claude'`), {
          code: "ENOENT",
          syscall: "posix_spawn",
          path: `/home/${SECRET}/claude`,
        });
      },
      stop: () => {},
    };
    const hub = new ChatHub({ store, chat, log: (m) => logs.push(m) });
    const conv = await store.createConversation("general");
    await hub.send(conv, `Meine Frage mit ${SECRET}`);
    await waitUntil(() => !hub.isRunning(conv.id));
    expect(logs).toEqual([`Turn in Gespräch ${conv.id} fehlgeschlagen (Error, code=ENOENT, syscall=posix_spawn)`]);
    expect(logs.join("\n")).not.toContain(SECRET);
    expect((await store.getMessages(conv.id)).at(-1)).toMatchObject({ role: "error", text: TURN_FAILED_TEXT });
  });
});

describe("errorLogFields", () => {
  test("nur Felder in der erwarteten Form", () => {
    expect(errorLogFields(new TypeError("x"))).toBe("TypeError");
    expect(errorLogFields(Object.assign(new Error(SECRET), { code: "EACCES" }))).toBe("Error, code=EACCES");
    expect(errorLogFields(Object.assign(new Error("x"), { code: `ENOENT ${SECRET}`, syscall: `spawn ${SECRET}` }))).toBe("Error");
    expect(errorLogFields({ code: "ENOENT" })).toBe("object, code=ENOENT");
    expect(errorLogFields("kaputt")).toBe("string");
    expect(errorLogFields(null)).toBe("object");
  });
});
