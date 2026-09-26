// Nachricht mit Anhängen (Issue #72, Schritt 2): POST .../messages nimmt
// attachments (höchstens 5 IDs aus diesem Gespräch), der Telegram-Turn
// schickt jede Datei durch prepareMedia, baut einen gemeinsamen Prompt,
// trägt Bildbeschreibungen nach und räumt auf. Verlauf und Live-Ereignisse
// zeigen die Anhänge der eigenen Nachricht.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { abortAllExecutions } from "../src/lib/execution-context";
import type { CommandPort } from "../src/web/commands";
import { ATTACHMENT_FAILED_TEXT } from "../src/web/bot-turn";
import type { WebServer } from "../src/web/server";
import {
  TOPIC,
  fakeTelegramChat,
  listen,
  makeRoot,
  startAttachmentServer,
  waitUntil,
  type AttachmentCtx,
} from "./attachments-fixture";
import { JPEG, OGG_OPUS, PDF, PNG } from "./media-fixture";

const root = await makeRoot("tybo-web-attach-msg-");
afterAll(() => root.cleanup());
const servers: WebServer[] = [];
afterEach(async () => {
  abortAllExecutions();
  for (const s of servers.splice(0)) await s.stop();
});

const commands: CommandPort = {
  list: () => [],
  match: text => (text.startsWith("/new") ? { name: "new", whileBusy: false } : null),
  run: async () => ({}),
};

async function start() {
  const dir = root.next();
  const mediaDir = join(dir, "media");
  const { rec, factory } = fakeTelegramChat(mediaDir);
  const ctx = await startAttachmentServer({ dir, servers, telegramChat: factory, commands });
  return { ctx, rec, mediaDir };
}

async function upload(ctx: AttachmentCtx, conversationId: string, body: Uint8Array, name?: string): Promise<string> {
  const res = await ctx.upload(conversationId, body, name ? { "x-file-name": encodeURIComponent(name) } : {});
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

function send(ctx: AttachmentCtx, conversationId: string, body: unknown) {
  return ctx.api(`/api/conversations/${conversationId}/messages`, { method: "POST", body });
}

async function idle(ctx: AttachmentCtx, conversationId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const status = await (await ctx.api(`/api/conversations/${conversationId}`)).json();
    if (!status.running) return;
    await Bun.sleep(5);
  }
  throw new Error("Turn läuft noch");
}

async function state(ctx: AttachmentCtx, conversationId: string, id: string) {
  return (await ctx.uploads.find(conversationId, id))?.state;
}

describe("Nachricht mit Anhang", () => {
  test("leerer Text mit Bild: PNG geht durch prepareMedia, Bildpfad und Asset erreichen den Prompt, Beschreibung wird nachgetragen", async () => {
    const { ctx, rec, mediaDir } = await start();
    rec.core = async () => "Ein Balkendiagramm mit drei Säulen.\n[ASSET_DESC: Balkendiagramm mit drei Säulen | diagramm, zahlen]";
    const id = await upload(ctx, TOPIC, PNG, "Umsatz.png");
    const res = await send(ctx, TOPIC, { text: "", attachments: [id] });
    expect(res.status).toBe(202);
    const { message } = await res.json();
    expect(message.text).toBe("");
    expect(message.attachments).toEqual([
      {
        id,
        name: "Umsatz.png",
        size: PNG.length,
        mime: "image/png",
        kind: "image",
        url: `/api/conversations/${TOPIC}/attachments/${id}`,
        previewUrl: `/api/conversations/${TOPIC}/attachments/${id}?inline=1`,
      },
    ]);
    await idle(ctx, TOPIC);

    // prepareMedia: Datei im Web-Unterordner abgelegt, Asset mit erkanntem Typ und Anzeigenamen
    expect(rec.written).toHaveLength(1);
    expect(rec.written[0].startsWith(join(mediaDir, "web", "photo_"))).toBe(true);
    expect(rec.written[0].endsWith(".png")).toBe(true);
    expect(rec.assets[0].options).toMatchObject({ channel: "web", originalFilename: "Umsatz.png", fileType: "image", mimeType: "image/png" });
    // Prompt wie in Telegram: Bildpfad, Asset-ID, Standardfrage ohne Text
    expect(rec.turns[0].userMessage).toBe(
      `[Image attached: ${rec.written[0]}]\n(asset: asset-1)\n\nUser says: User sent a photo. Describe and respond to it.`
    );
    // Danach die Beschreibung aus dem Tag, in Telegram und Speicher ohne Tag
    expect(rec.descriptions).toEqual([{ assetId: "asset-1", description: "Balkendiagramm mit drei Säulen", tags: ["diagramm", "zahlen"] }]);
    const answer = rec.saved.find(m => m.role === "assistant")!;
    expect(answer.content).toBe("Ein Balkendiagramm mit drei Säulen.");
    expect(rec.agentSends[0].text).toBe("Ein Balkendiagramm mit drei Säulen.");

    // Gespeicherte Nutzernachricht: Zeile je Anhang, geschriebener Text und Anhänge in metadata
    const user = rec.saved.find(m => m.role === "user")!;
    expect(user.content).toBe("[Photo: Umsatz.png]");
    expect(user.metadata).toMatchObject({
      webText: "",
      attachments: [{ id, name: "Umsatz.png", size: PNG.length, mime: "image/png", kind: "image", assetId: "asset-1" }],
      msgId: message.id,
    });
    expect(await state(ctx, TOPIC, id)).toBe("sent");

    // Nach dem Neuladen: dieselbe ID, leerer Text, Anhang mit Vorschau
    const history = await (await ctx.api(`/api/conversations/${TOPIC}/messages`)).json();
    const reloaded = history.messages.find((m: any) => m.id === message.id);
    expect(reloaded.text).toBe("");
    expect(reloaded.attachments).toEqual(message.attachments);
    // Die Vorschau lässt sich laden
    const preview = await ctx.api(message.attachments[0].previewUrl);
    expect(preview.headers.get("content-type")).toBe("image/png");
  });

  test("Text mit Anhang: Text als Frage im Prompt, im Verlauf der geschriebene Text", async () => {
    const { ctx, rec } = await start();
    const id = await upload(ctx, TOPIC, PDF, "Vertrag.pdf");
    const res = await send(ctx, TOPIC, { text: "Fass das zusammen", attachments: [id] });
    const { message } = await res.json();
    await idle(ctx, TOPIC);
    expect(rec.turns[0].userMessage).toBe(`[User sent a document saved at: ${rec.written[0]}, filename: Vertrag.pdf]\n\nFass das zusammen`);
    expect(rec.saved.find(m => m.role === "user")!.content).toBe("Fass das zusammen\n[Document: Vertrag.pdf]");
    const history = await (await ctx.api(`/api/conversations/${TOPIC}/messages`)).json();
    const reloaded = history.messages.find((m: any) => m.id === message.id);
    expect(reloaded.text).toBe("Fass das zusammen");
    expect(reloaded.attachments[0]).toMatchObject({ name: "Vertrag.pdf", kind: "document", mime: "application/pdf" });
    expect(reloaded.attachments[0].previewUrl).toBeUndefined();
  });

  test("fünf Anhänge (Bilder, PDF, Sprache): eigene Dateien, nummerierter Prompt, Beschreibung je Bild in Reihenfolge", async () => {
    const { ctx, rec } = await start();
    const ids = [
      await upload(ctx, TOPIC, PNG, "a.png"),
      await upload(ctx, TOPIC, PDF, "b.pdf"),
      await upload(ctx, TOPIC, JPEG, "c.jpg"),
      await upload(ctx, TOPIC, OGG_OPUS, "d.ogg"),
      await upload(ctx, TOPIC, PNG, "e.png"),
    ];
    rec.core = async () => "Drei Bilder.\n[ASSET_DESC: Erstes Bild | eins]\n[ASSET_DESC: Zweites Bild]";
    const res = await send(ctx, TOPIC, { text: "Was ist das alles?", attachments: ids });
    expect(res.status).toBe(202);
    const { message } = await res.json();
    expect(message.attachments.map((a: any) => a.name)).toEqual(["a.png", "b.pdf", "c.jpg", "d.ogg", "e.png"]);
    await idle(ctx, TOPIC);

    // Mehrere Anhänge derselben Millisekunde überschreiben sich nicht
    expect(new Set(rec.written).size).toBe(5);
    const prompt = rec.turns[0].userMessage;
    expect(prompt).toContain(`[Image 1 of 5 attached: ${rec.written[0]}]\n(asset: asset-1)`);
    expect(prompt).toContain(`[User sent a document saved at: ${rec.written[1]}, filename: b.pdf]`);
    expect(prompt).toContain(`[Image 3 of 5 attached: ${rec.written[2]}]\n(asset: asset-2)`);
    expect(prompt).toContain("[Voice message transcription]: Hallo aus der Sprachdatei");
    expect(prompt).toContain("There are 3 images.");
    expect(prompt.endsWith("User says: Was ist das alles?")).toBe(true);
    // Zwei Tags für drei Bilder: das dritte behält seinen Platzhalter
    expect(rec.descriptions).toEqual([
      { assetId: "asset-1", description: "Erstes Bild", tags: ["eins"] },
      { assetId: "asset-2", description: "Zweites Bild", tags: [] },
    ]);
    expect(rec.saved.find(m => m.role === "assistant")!.content).toBe("Drei Bilder.");
    // Sprachdatei nach dem Turn gelöscht, Bilder und PDF bleiben
    expect(rec.unlinked).toEqual([rec.written[3]]);
    // Fremde Inhalte: Merk-Tags nur als Vorschlag
    expect(rec.intents[0].turn.foreignInput).toBe("Foto, hochgeladene Datei");
    const history = await (await ctx.api(`/api/conversations/${TOPIC}/messages`)).json();
    expect(history.messages.find((m: any) => m.id === message.id).attachments).toEqual(message.attachments);
  });

  test("nur Sprachdatei: Transkript im Prompt, kein fremder Inhalt; Datei auch nach Fehler von Claude gelöscht", async () => {
    const { ctx, rec } = await start();
    const id = await upload(ctx, "dm", OGG_OPUS);
    rec.core = async () => "[REMEMBER: Test]";
    await send(ctx, "dm", { attachments: [id] });
    await idle(ctx, "dm");
    expect(rec.turns[0].userMessage).toBe("[Voice message transcription]: Hallo aus der Sprachdatei");
    expect(rec.intents[0].turn.foreignInput).toBeUndefined();
    expect(rec.saved[0].content).toBe("[Voice message: sprachdatei.ogg] Hallo aus der Sprachdatei");

    const second = await upload(ctx, "dm", OGG_OPUS);
    rec.core = async () => {
      throw new Error("kaputt");
    };
    await send(ctx, "dm", { text: "", attachments: [second] });
    await idle(ctx, "dm");
    expect(rec.unlinked).toHaveLength(2);
    // Gescheitert, nicht abgebrochen: Nachricht gespeichert wie bisher, Anhang bleibt verschickt
    expect(await state(ctx, "dm", second)).toBe("sent");
  });

  test("Live-Ereignis: andere Browser sehen die Nachricht mit Anhängen sofort", async () => {
    const { ctx } = await start();
    const events = await listen(ctx, TOPIC);
    const id = await upload(ctx, TOPIC, PNG);
    const { message } = await (await send(ctx, TOPIC, { text: "Schau", attachments: [id] })).json();
    await waitUntil(() => events.events.some(e => e.event === "message" && e.data.id === message.id));
    const live = events.events.find(e => e.event === "message" && e.data.id === message.id)!;
    expect(live.data.attachments).toEqual(message.attachments);
    expect(live.data.text).toBe("Schau");
    await idle(ctx, TOPIC);
    await events.close();
  });

  test("Verarbeitung scheitert (Transkription): Fehlermeldung, nichts nach Telegram, Arbeitsdatei gelöscht, Anhang wieder frei", async () => {
    const { ctx, rec } = await start();
    rec.transcribe = async () => {
      throw new Error("Gemini weg");
    };
    const events = await listen(ctx, TOPIC);
    const id = await upload(ctx, TOPIC, OGG_OPUS);
    await send(ctx, TOPIC, { attachments: [id] });
    await waitUntil(() => events.events.some(e => e.event === "error"));
    expect(events.events.find(e => e.event === "error")!.data.text).toBe(ATTACHMENT_FAILED_TEXT);
    await idle(ctx, TOPIC);
    await events.close();
    expect(rec.plain).toEqual([]);
    expect(rec.turns).toEqual([]);
    expect(rec.saved).toEqual([]);
    // Die geschriebene Sprachdatei ist wieder weg, obwohl es kein PreparedMedia gibt
    expect(rec.written).toHaveLength(1);
    expect(rec.transcribed).toEqual(rec.written);
    expect(rec.unlinked).toEqual(rec.written);
    expect(await state(ctx, TOPIC, id)).toBe("pending");
    // Erneut schicken geht
    rec.transcribe = async () => "zweiter Versuch";
    expect((await send(ctx, TOPIC, { attachments: [id] })).status).toBe(202);
    await idle(ctx, TOPIC);
    expect(rec.turns[0].userMessage).toBe("[Voice message transcription]: zweiter Versuch");
  });
});

describe("Prüfung der Anhang-IDs", () => {
  test("fremde, unbekannte, ungültige, doppelte, zu viele und schon verschickte IDs: 400, nichts gestartet", async () => {
    const { ctx, rec } = await start();
    const inDm = await upload(ctx, "dm", PNG);
    const mine = await upload(ctx, TOPIC, PNG);
    const cases: [unknown, string][] = [
      [[inDm], "Anhang unbekannt"],
      [[crypto.randomUUID()], "Anhang unbekannt"],
      [["../meta.json"], "Anhang unbekannt"],
      [[42], "Anhang unbekannt"],
      [[mine, mine], "doppelt"],
      [Array.from({ length: 6 }, () => crypto.randomUUID()), "Höchstens 5"],
      ["nicht-liste", "Liste"],
      [{ id: mine }, "Liste"],
    ];
    for (const [attachments, error] of cases) {
      const res = await send(ctx, TOPIC, { text: "x", attachments });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(error);
    }
    expect(rec.turns).toEqual([]);
    expect(await state(ctx, TOPIC, mine)).toBe("pending");
    expect(await state(ctx, "dm", inDm)).toBe("pending");

    expect((await send(ctx, TOPIC, { attachments: [mine] })).status).toBe(202);
    await idle(ctx, TOPIC);
    const again = await send(ctx, TOPIC, { text: "nochmal", attachments: [mine] });
    expect(again.status).toBe(400);
    expect(rec.turns).toHaveLength(1);
  });

  test("leere Liste zählt als keine Anhänge: leerer Text bleibt verboten", async () => {
    const { ctx } = await start();
    const res = await send(ctx, TOPIC, { text: "", attachments: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Nachricht ist leer");
    const ohne = await send(ctx, TOPIC, { text: "" });
    expect(ohne.status).toBe(400);
  });

  test("Anhänge gehen nicht still verloren: mit Befehl, mit Rückfrage-Antwort und aus einem anderen Gespräch 400", async () => {
    const { ctx, rec } = await start();
    const id = await upload(ctx, TOPIC, PNG);
    const command = await send(ctx, TOPIC, { text: "/new", attachments: [id] });
    expect(command.status).toBe(400);
    expect((await command.json()).error).toContain("Befehle nehmen keine Anhänge");
    const answer = await send(ctx, TOPIC, { text: "ja", approvalId: "frage-1", attachments: [id] });
    expect(answer.status).toBe(400);
    expect((await answer.json()).error).toContain("Rückfrage");
    const other = await send(ctx, "dm", { text: "x", attachments: [id] });
    expect(other.status).toBe(400);
    expect((await other.json()).error).toContain("aus einem anderen Gespräch");
    expect(rec.turns).toEqual([]);
    expect(await state(ctx, TOPIC, id)).toBe("pending");
  });

  test("Text über 20.000 Zeichen bleibt verboten, auch mit Anhang", async () => {
    const { ctx } = await start();
    const id = await upload(ctx, TOPIC, PNG);
    const res = await send(ctx, TOPIC, { text: "a".repeat(20_001), attachments: [id] });
    expect(res.status).toBe(400);
    expect(await state(ctx, TOPIC, id)).toBe("pending");
  });

  test("während einer laufenden Antwort 409, Anhang bleibt frei; gleichzeitiges Senden derselben ID: nur einer", async () => {
    const { ctx, rec } = await start();
    let release!: () => void;
    rec.core = () => new Promise(resolve => (release = () => resolve("fertig")));
    const first = await upload(ctx, TOPIC, PNG);
    const second = await upload(ctx, TOPIC, PNG);
    expect((await send(ctx, TOPIC, { attachments: [first] })).status).toBe(202);
    await waitUntil(() => rec.turns.length === 1);
    const busy = await send(ctx, TOPIC, { attachments: [second] });
    expect(busy.status).toBe(409);
    expect(await state(ctx, TOPIC, second)).toBe("pending");
    release();
    await idle(ctx, TOPIC);

    // Zwei Gespräche, dieselbe ID aus dm: höchstens eine Annahme
    const shared = await upload(ctx, "dm", PNG);
    rec.core = async () => "ok";
    const results = await Promise.all([
      send(ctx, "dm", { text: "a", attachments: [shared] }),
      send(ctx, "dm", { text: "b", attachments: [shared] }),
    ]);
    const statuses = results.map(r => r.status).sort();
    expect(statuses[0]).toBe(202);
    expect([400, 409]).toContain(statuses[1]);
    await idle(ctx, "dm");
  });
});
