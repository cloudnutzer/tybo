/**
 * Issue #30: Demo-Modus für die Topic-Oberfläche. Geschlossenes Beispiel-Topic,
 * einstellbare Rechte des Bots und automatischer Titel aus der ersten
 * Nachricht, alles gegen Attrappen (nichts geht nach Telegram).
 */

import { expect, test } from "bun:test";
import { createDemoTopics, startDemoServer } from "../src/web/demo";
import { createFakeChat } from "../src/web/fake-chat";

const PASSWORD = "test-passwort-lang";
const config = { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] };

async function withDemo(deps: Parameters<typeof startDemoServer>[1], fn: (api: (path: string, method?: string, body?: unknown) => Promise<Response>) => Promise<void>) {
  const demo = await startDemoServer(config, { log: () => {}, ...deps });
  try {
    const origin = demo.server.url;
    await fn((path, method = "GET", body) =>
      fetch(`${origin}${path}`, { method, headers: { origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  } finally {
    await demo.stop();
  }
}

test("Beispieldaten: das ältere Topic „Archiv\" ist geschlossen, die übrigen offen", async () => {
  const { telegram } = createDemoTopics();
  const topics = (await telegram.listConversations()).topics;
  expect(topics.find(t => t.id === "topic-7")?.closed).toBe(true);
  expect(topics.filter(t => t.closed).map(t => t.id)).toEqual(["topic-7"]);
  // Ohne Beispieldaten nichts geschlossen
  const plain = await createDemoTopics({ seed: false }).telegram.listConversations();
  expect(plain.topics.some(t => t.closed)).toBe(false);
});

test("Rechte einstellbar: ohne „Nachrichten löschen\" lehnt DELETE mit 403 ab", async () => {
  await withDemo({ chat: createFakeChat(), telegramChat: createFakeChat(), topicRights: { manageTopics: true, deleteMessages: false } }, async api => {
    expect(await (await api("/api/telegram/rights")).json()).toEqual({ manageTopics: true, deleteMessages: false, group: true });
    const res = await api("/api/conversations/topic-443", "DELETE", { confirm: "Recherche" });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("no_delete_messages");
  });
});

test("automatischer Titel: erste Nachricht in einem neuen Topic setzt den Namen", async () => {
  await withDemo({ chat: createFakeChat(), telegramChat: createFakeChat({ delayMs: 10, stepMs: 10 }) }, async api => {
    const { conversation } = await (await api("/api/conversations", "POST", { agent: "research" })).json();
    expect(conversation.title).toBe("Neues Gespräch");
    expect((await api(`/api/conversations/${conversation.id}/messages`, "POST", { text: "Was kostet ein VPS bei Hetzner?" })).status).toBe(202);
    let title = "";
    for (let i = 0; i < 50 && title !== "Was kostet ein VPS bei Hetzner?"; i++) {
      await Bun.sleep(20);
      title = (await (await api(`/api/conversations/${conversation.id}`)).json()).conversation.title;
    }
    expect(title).toBe("Was kostet ein VPS bei Hetzner?");
    // Ein bestehendes Topic behält seinen Namen
    expect((await api("/api/conversations/topic-443/messages", "POST", { text: "Neue Frage" })).status).toBe(202);
    await Bun.sleep(100);
    expect((await (await api("/api/conversations/topic-443")).json()).conversation.title).toBe("Recherche");
  });
});
