/**
 * Issue #259, Checkbox 2: Denkauftrag aus dem Telefonhörer über den echten
 * Web-Server (freier Port, WebSocket GET /api/call): der Auftrag landet als
 * Turn im Gespräch des Telefonats (Chat-Kern-Attrappe, nicht Telegram), die
 * fertige Antwort wird im laufenden Gespräch einmal angesagt.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALL_PATH, CALL_TEXT, CALL_TOOL_TEXT, type CallTurnEvent } from "../src/web/call";
import type { RunTurnOptions, TurnResult, WebChat } from "../src/web/chat";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import type { VoicePort } from "../src/web/voice";
import { fakeLine, fakePort } from "./call-fixture";

const PASSWORD = "test-passwort-telefon";
const dirs: string[] = [];
const servers: WebServer[] = [];

afterAll(async () => {
  await Promise.all(servers.map(s => s.stop()));
  for (const d of dirs) await rm(d, { recursive: true, force: true });
}, 30_000);

const voice: VoicePort = {
  localMode: () => ({ ready: true, stt: { id: "parakeet", label: "Parakeet", local: true, available: true }, tts: { id: "browser", label: "Browser-Stimme", where: "browser", available: true } }),
};

async function* deepTurn(): AsyncGenerator<CallTurnEvent> {
  yield { type: "tool", name: "denkauftrag", phase: "start" };
  yield { type: "tool", name: "denkauftrag", phase: "call", task: "Vergleiche drei Wärmepumpen" };
  yield { type: "done", rawText: "[DENKAUFTRAG: Vergleiche drei Wärmepumpen]", spokenText: "", aborted: false };
}

describe("Denkauftrag über den Web-Server", () => {
  test("Turn im Gespräch des Telefonats ohne Telegram, Antwort wird einmal angesagt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tybo-call-tools-"));
    dirs.push(dir);
    const store = new ConversationStore({ dir: join(dir, "web") });
    await store.load();
    const conversation = await store.createConversation("general");
    const other = await store.createConversation("research");
    const turns: RunTurnOptions[] = [];
    const chat: WebChat = {
      async runTurn(opts): Promise<TurnResult> {
        turns.push(opts);
        return { text: "Ausgearbeitet: Modell B ist am günstigsten." };
      },
      stop() {},
    };
    const port = fakePort({ line: () => fakeLine({ speak: null, turn: () => deepTurn() }) });
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      { sessionFile: join(dir, "sessions.json"), conversationStore: store, voice, call: port.port, chat, log: () => {} }
    );
    servers.push(server);
    const url = server.url;
    const login = await fetch(`${url}/api/login`, { method: "POST", headers: { origin: url }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];

    const ws = new WebSocket(url.replace(/^http/, "ws") + CALL_PATH, { headers: { cookie, origin: url } } as any);
    const messages: Array<Record<string, any>> = [];
    ws.addEventListener("message", e => {
      if (typeof e.data === "string") messages.push(JSON.parse(e.data));
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("Verbindung gescheitert")));
    });
    const waitFor = async (pred: () => boolean, ms = 4000) => {
      const deadline = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`Zeit abgelaufen: ${JSON.stringify(messages)}`);
        await Bun.sleep(10);
      }
    };
    ws.send(JSON.stringify({ type: "start", conversationId: conversation.id, tts: "browser" }));
    await waitFor(() => messages.some(m => m.type === "state" && m.state === "hoert-zu"));
    for (let i = 0; i < 25; i++) ws.send(new Uint8Array(640).fill(1));
    ws.send(JSON.stringify({ type: "utterance_end" }));
    await waitFor(() => turns.length === 1);
    expect(turns[0]).toMatchObject({ conversationId: conversation.id, noTelegram: true, text: "Denkauftrag aus dem Telefongespräch: Vergleiche drei Wärmepumpen\n\nAntworte hier im Gespräch." });
    await waitFor(() => messages.filter(m => m.type === "sentence").length >= 1);
    const ack = messages.filter(m => m.type === "sentence");
    expect(ack.map(m => m.text)).toEqual([CALL_TOOL_TEXT.deepAck]);
    for (const m of ack) ws.send(JSON.stringify({ type: "played", id: m.id }));
    await waitFor(() => messages.some(m => m.type === "sentence" && m.text === CALL_TEXT.deepResultReady), 5000);
    // Auftrag und Antwort im Verlauf des Telefonats, nichts im anderen Gespräch; die Äußerung am
    // Telefon und die gesprochene Ansage folgen nach dem Denkauftrag (Issue #260: Ablage nach dessen Ende)
    expect((await store.getMessages(conversation.id)).map(m => [m.role, m.text, m.call ?? false])).toEqual([
      ["user", "Denkauftrag aus dem Telefongespräch: Vergleiche drei Wärmepumpen\n\nAntworte hier im Gespräch.", false],
      ["assistant", "Ausgearbeitet: Modell B ist am günstigsten.", false],
      ["user", "Wie geht es dir heute?", true],
      ["assistant", CALL_TOOL_TEXT.deepAck, true],
    ]);
    expect(await store.getMessages(other.id)).toEqual([]);
    await Bun.sleep(1500);
    expect(messages.filter(m => m.type === "sentence" && m.text === CALL_TEXT.deepResultReady)).toHaveLength(1);
    ws.close();
  }, 15_000);
});
