import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDemoServer, DEMO_REPLY } from "../src/web/demo";
import { createFakeChat } from "../src/web/fake-chat";
import { createWebServer } from "../src/web/server";

const PASSWORD = "test-passwort-lang";
const root = resolve(import.meta.dir, "..");
const dir = await mkdtemp(join(tmpdir(), "tybo-web-demo-test-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const config = (host: string) => ({ host, port: 0, password: PASSWORD, allowedHosts: [] });

test("Demo-Option verweigert den Start ohne 127.0.0.1", async () => {
  for (const host of ["0.0.0.0", "192.168.1.20", "localhost", "::1", "::"]) {
    const sessionFile = join(dir, `sessions-${host.replace(/[:.]/g, "_")}.json`);
    await expect(
      createWebServer(config(host), { demo: true, sessionFile, dataDir: join(dir, "nie"), log: () => {} })
    ).rejects.toThrow(/nur auf 127\.0\.0\.1/);
    await expect(startDemoServer(config(host), { log: () => {} })).rejects.toThrow(/nur auf 127\.0\.0\.1/);
    // Abgelehnt, bevor irgendetwas angelegt wurde
    await expect(readFile(sessionFile)).rejects.toThrow();
  }
});

test("Normalbetrieb bleibt geschützt: ohne Session Umleitung und 401", async () => {
  const server = await createWebServer(config("127.0.0.1"), {
    sessionFile: join(dir, "normal-sessions.json"), dataDir: join(dir, "normal"), log: () => {},
  });
  try {
    const page = await fetch(`${server.url}/`, { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login");
    expect((await fetch(`${server.url}/api/conversations`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/me`)).status).toBe(401);
    expect((await fetch(`${server.url}/login`, { redirect: "manual" })).status).toBe(200);
  } finally {
    await server.stop();
  }
});

test("Demo: ohne Anmeldung nutzbar, nur die Beispiel-Unterhaltung, SSE läuft", async () => {
  // Vorhandene Gespräche in einem anderen Verzeichnis dürfen nie auftauchen
  const otherData = join(dir, "vorhanden");
  await mkdir(otherData, { recursive: true });
  await writeFile(join(otherData, "conversations.json"), "[]");

  const demo = await startDemoServer(config("127.0.0.1"), { chat: createFakeChat({ delayMs: 20, stepMs: 5 }), log: () => {} });
  const origin = demo.server.url;
  try {
    expect(demo.dir.startsWith(tmpdir())).toBe(true);
    expect(demo.dir).not.toContain(join(root, "data"));

    const page = await fetch(`${origin}/`, { redirect: "manual" });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="chat-log"');

    const list = await (await fetch(`${origin}/api/conversations`)).json();
    expect(list.conversations).toHaveLength(2);
    const id = list.conversations[0].id;
    const { messages } = await (await fetch(`${origin}/api/conversations/${id}/messages`)).json();
    expect(messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "error"]);
    const html = messages[1].html as string;
    expect(html).toContain("<table>");
    expect(html).toContain("<pre><code");
    expect(html).toContain("<ol>");
    expect(html).not.toContain("REMEMBER");
    expect(DEMO_REPLY).toContain("[REMEMBER:");

    // SSE ist an die Demo-Session gebunden und liefert Daten
    const controller = new AbortController();
    const events = await fetch(`${origin}/api/conversations/${id}/events`, { signal: controller.signal });
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: status");
    controller.abort();

    // Schreiben nur mit passendem Origin, auch im Demo-Modus
    const foreign = await fetch(`${origin}/api/conversations`, { method: "POST", headers: { origin: "http://evil.example" }, body: "{}" });
    expect(foreign.status).toBe(403);
    const noOrigin = await fetch(`${origin}/api/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ text: "hi" }) });
    expect(noOrigin.status).toBe(403);
    // Host-Prüfung bleibt
    const rebinding = await fetch(`${origin}/`, { headers: { host: `evil.example:${new URL(origin).port}` } });
    expect(rebinding.status).toBe(421);

    // Abmelden beendet die Demo-Session nicht
    const logout = await fetch(`${origin}/api/logout`, { method: "POST", headers: { origin } });
    expect(logout.status).toBe(200);
    expect((await fetch(`${origin}/api/me`)).status).toBe(200);

    // Senden läuft gegen die Attrappe
    const sent = await fetch(`${origin}/api/conversations/${id}/messages`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: "hallo" }),
    });
    expect(sent.status).toBe(202);
    // Auf die Antwort warten, damit nach dem Stoppen nichts mehr schreibt
    for (let i = 0; i < 100; i++) {
      const r = await (await fetch(`${origin}/api/conversations/${id}/messages`)).json();
      if (!r.running) break;
      await Bun.sleep(10);
    }
  } finally {
    await demo.stop();
  }
  // Temporäres Verzeichnis ist weg, das andere unangetastet
  await expect(readdir(demo.dir)).rejects.toThrow();
  expect(await readFile(join(otherData, "conversations.json"), "utf8")).toBe("[]");
});

test("src/bot.ts setzt die Demo-Option nie", async () => {
  const bot = await readFile(join(root, "src", "bot.ts"), "utf8");
  expect(bot).not.toMatch(/\bdemo\s*:/);
  expect(bot).not.toContain("WEB_DEV_DEMO");
  expect(bot).not.toContain("startDemoServer");
});

test("Demo: Direktchat und Topics aus der Attrappe, Verlauf seitenweise mit before=", async () => {
  const demo = await startDemoServer(config("127.0.0.1"), { log: () => {} });
  const origin = demo.server.url;
  try {
    const list = await (await fetch(`${origin}/api/conversations`)).json();
    expect(list.telegram.dm.id).toBe("dm");
    const topics = list.telegram.topics as { id: string; title: string; lastActivity: string | null }[];
    expect(topics.map(t => t.id)).toEqual(["topic-443", "topic-60", "topic-12", "topic-31", "topic-7", "topic-1"]);
    // aktuelle (unter 30 Tagen) und ältere Topics, eines ohne Aktivität, eines mit HTML-Sonderzeichen
    const age = (t: { lastActivity: string | null }) => (t.lastActivity ? (Date.now() - Date.parse(t.lastActivity.replace(/(\.\d{3})\d+/, "$1"))) / 86_400_000 : null);
    expect(age(topics[0])!).toBeLessThan(1);
    expect(age(topics[4])!).toBeGreaterThan(30);
    expect(topics[5].lastActivity).toBeNull();
    expect(topics[4].title).toBe("Archiv <alt> & Co");

    // Direktchat: 120 Nachrichten in Seiten zu 50, Cursor mit Mikrosekunden
    const seen: string[] = [];
    let url = `${origin}/api/conversations/dm/messages`;
    const pages: number[] = [];
    for (;;) {
      const page = await (await fetch(url)).json();
      pages.push(page.messages.length);
      seen.unshift(...page.messages.map((m: { id: string }) => m.id));
      if (!page.hasMore) break;
      expect(page.messages[0].createdAt).toMatch(/\.\d{6}Z$/);
      url = `${origin}/api/conversations/dm/messages?before=${encodeURIComponent(page.messages[0].createdAt)}`;
    }
    expect(pages).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
    expect(seen[0]).toBe("dm-0");
    expect(seen.at(-1)).toBe("dm-119");

    // Antworten mit Sprecher und gerendertem HTML; ohne Telegram-Turn kein Schreiben
    const topic = await (await fetch(`${origin}/api/conversations/topic-443/messages`)).json();
    expect(topic.messages.at(-1)).toMatchObject({ role: "assistant", agent: "research" });
    expect(topic.messages[1].html).toContain("<strong>4 Euro</strong>");
    const write = await fetch(`${origin}/api/conversations/topic-443/messages`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }),
    });
    expect(write.status).toBe(503);
  } finally {
    await demo.stop();
  }
});

test("Demo mit Telegram-Attrappe (web:dev): Schreiben in ein Topic antwortet die Attrappe", async () => {
  const demo = await startDemoServer(config("127.0.0.1"), {
    log: () => {},
    telegramChat: { runTurn: async () => ({ text: "Attrappe" }), stop: () => false },
  });
  const origin = demo.server.url;
  try {
    const write = await fetch(`${origin}/api/conversations/topic-443/messages`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }),
    });
    expect(write.status).toBe(202);
    expect((await write.json()).message.id).toMatch(/^web-/);
  } finally {
    await demo.stop();
  }
});

test("web:dev gibt der Demo eine Telegram-Attrappe, nie einen echten Turn", async () => {
  const script = await readFile(join(root, "scripts", "web-dev.ts"), "utf8");
  expect(script).toContain("startDemoServer(result.config, { chat: createFakeChat(), telegramChat: createFakeChat() })");
  expect(script).not.toContain("createTelegramChat");
});

test("Demo mit Anhängen (Issue #73): Upload im Topic, Nachricht mit ID, nach dem Neuladen im Verlauf mit Vorschau", async () => {
  const demo = await startDemoServer(config("127.0.0.1"), {
    chat: createFakeChat({ delayMs: 5, stepMs: 1 }),
    telegramChat: createFakeChat({ delayMs: 5, stepMs: 1 }),
    log: () => {},
  });
  const origin = demo.server.url;
  try {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    const up = await fetch(`${origin}/api/conversations/topic-443/attachments`, {
      method: "POST",
      headers: { origin, "x-file-name": encodeURIComponent("Bildschirmfoto 1.png") },
      body: png,
    });
    expect(up.status).toBe(201);
    const attachment = await up.json();
    expect(attachment).toMatchObject({ name: "Bildschirmfoto 1.png", mime: "image/png", kind: "image" });
    const sent = await fetch(`${origin}/api/conversations/topic-443/messages`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ text: "", attachments: [attachment.id] }),
    });
    expect(sent.status).toBe(202);
    const { message } = await sent.json();
    expect(message.attachments[0].previewUrl).toBe(`/api/conversations/topic-443/attachments/${attachment.id}?inline=1`);
    // Verlauf wie nach dem Neuladen
    let found: any;
    for (let i = 0; i < 50 && !found; i++) {
      const { messages } = await (await fetch(`${origin}/api/conversations/topic-443/messages`)).json();
      found = messages.find((m: any) => m.id === message.id);
      if (!found) await Bun.sleep(10);
    }
    expect(found.attachments.map((a: any) => a.id)).toEqual([attachment.id]);
    const preview = await fetch(`${origin}${found.attachments[0].previewUrl}`);
    expect(preview.status).toBe(200);
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(png);
    // Reine Web-Gespräche nehmen seit Issue #112 auch Anhänge, der Verlauf behält sie
    const webId = (await (await fetch(`${origin}/api/conversations`)).json()).conversations[0].id;
    const web = await fetch(`${origin}/api/conversations/${webId}/attachments`, { method: "POST", headers: { origin }, body: png });
    expect(web.status).toBe(201);
    const webAttachment = await web.json();
    const webSent = await fetch(`${origin}/api/conversations/${webId}/messages`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ text: "Bild im Web-Gespräch", attachments: [webAttachment.id] }),
    });
    expect(webSent.status).toBe(202);
    const webMessage = (await webSent.json()).message;
    const { messages: webMessages } = await (await fetch(`${origin}/api/conversations/${webId}/messages`)).json();
    const webFound = webMessages.find((m: any) => m.id === webMessage.id);
    expect(webFound.attachments[0].previewUrl).toBe(`/api/conversations/${webId}/attachments/${webAttachment.id}?inline=1`);
  } finally {
    await demo.stop();
  }
});
