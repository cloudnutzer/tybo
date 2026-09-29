// Verarbeitung der Anhänge in reinen Web-Gesprächen (Issue #112, Schritt 3):
// echter Web-Turn (createBotChat) hinter dem echten Web-Server. Bild, PDF
// und Sprachaufnahme gehen durch prepareMedia wie in Telegram-Gesprächen;
// Claude, Gedächtnis, Asset-Speicher und Transkription sind Attrappen. Es
// gibt keinen Weg nach Telegram: der Turn kennt weder sendPlain noch sendFile.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TurnOptions } from "../src/lib/chat-turn";
import { abortAllExecutions, abortExecutions } from "../src/lib/execution-context";
import {
  WEB_ATTACHMENT_FAILED_TEXT,
  createBotChat,
  webMediaDir,
  type IntentTurn,
  type WebSavedMessage,
} from "../src/web/bot-turn";
import type { WebServer } from "../src/web/server";
import { makeRoot, startAttachmentServer, waitUntil, type AttachmentCtx } from "./attachments-fixture";
import { OGG_OPUS, PDF, PNG } from "./media-fixture";

const root = await makeRoot("tybo-web-attach-webturn-");
afterAll(() => root.cleanup());
const servers: WebServer[] = [];
afterEach(async () => {
  abortAllExecutions();
  for (const s of servers.splice(0)) await s.stop();
});

interface Rec {
  turns: TurnOptions[];
  saved: WebSavedMessage[];
  intents: { text: string; turn: IntentTurn }[];
  assets: { path: string; options: Record<string, unknown> }[];
  descriptions: { assetId: string; description: string; tags?: string[] }[];
  transcribed: string[];
  unlinked: string[];
  core: (opts: TurnOptions) => Promise<string>;
  transcribe: (path: string) => Promise<string>;
}

async function start() {
  const dir = root.next();
  // Wie in bot.ts: der Medien-Kern schreibt unter <uploads>/web/<Gespräch>, die Ablage kennt denselben Ordner
  const mediaRoot = join(dir, "uploads-media");
  const mediaDir = webMediaDir(mediaRoot);
  const rec: Rec = {
    turns: [],
    saved: [],
    intents: [],
    assets: [],
    descriptions: [],
    transcribed: [],
    unlinked: [],
    core: async () => "Antwort",
    transcribe: async () => "Bitte morgen um neun erinnern",
  };
  let assetCounter = 0;
  const ctx = await startAttachmentServer({
    dir,
    servers,
    mediaDir,
    webChat: uploads =>
      createBotChat({
        runStreamingTurn: async opts => {
          rec.turns.push(opts);
          return rec.core(opts);
        },
        saveMessage: async m => {
          rec.saved.push(m);
          return true;
        },
        processIntents: async (text, turn) => {
          rec.intents.push({ text, turn });
        },
        abortEngineCalls: key => abortExecutions(key),
        isShuttingDown: () => false,
        scheduleRestartCheck: () => {},
        uploads,
        media: {
          uploadsDir: mediaRoot,
          // Echte Dateien (mkdir, writeFile), damit das Löschen des Gesprächs sie vorfindet
          unlink: async path => {
            rec.unlinked.push(path);
          },
          uploadAssetQuick: async (path, options) => {
            rec.assets.push({ path, options });
            return { id: `asset-${++assetCounter}` } as any;
          },
          updateAssetDescription: async (assetId, description, tags) => {
            rec.descriptions.push({ assetId, description, ...(tags ? { tags } : {}) });
            return true;
          },
          transcribeAudio: async path => {
            rec.transcribed.push(path);
            return rec.transcribe(path);
          },
          logError: () => {},
        },
        log: () => {},
      }),
  });
  return { ctx, rec, mediaDir };
}

async function upload(ctx: AttachmentCtx, conversationId: string, body: Uint8Array, name: string): Promise<string> {
  const res = await ctx.upload(conversationId, body, { "x-file-name": encodeURIComponent(name) });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

async function sendAndWait(ctx: AttachmentCtx, id: string, body: unknown) {
  const res = await ctx.api(`/api/conversations/${id}/messages`, { method: "POST", body });
  expect(res.status).toBe(202);
  for (let i = 0; i < 400; i++) {
    const status = await (await ctx.api(`/api/conversations/${id}`)).json();
    if (!status.running) break;
    await Bun.sleep(5);
  }
  const { messages } = await (await ctx.api(`/api/conversations/${id}/messages`)).json();
  return messages as any[];
}

async function exists(path: string): Promise<boolean> {
  return !!(await stat(path).catch(() => null));
}

describe("Web-Turn mit Anhängen", () => {
  test("Bild: Pfad und Asset im Prompt, Beschreibung nachgetragen, Tag entfernt, foreignInput Foto", async () => {
    const { ctx, rec, mediaDir } = await start();
    const id = ctx.webConversationId;
    rec.core = async () => "Ein Diagramm mit drei Säulen.\n[ASSET_DESC: Balkendiagramm | diagramm, zahlen]\n[REMEMBER: Umsatz steigt]";
    const image = await upload(ctx, id, PNG, "Umsatz.png");
    const messages = await sendAndWait(ctx, id, { text: "Was siehst du?", attachments: [image] });

    expect(rec.turns).toHaveLength(1);
    const prompt = rec.turns[0].userMessage;
    expect(prompt).toContain(`[Image attached: ${join(mediaDir, id)}/photo_`);
    expect(prompt).toContain("(asset: asset-1)");
    expect(prompt).toContain("User says: Was siehst du?");
    expect(rec.turns[0].chatId).toBe(`web:${id}`);
    // Asset aus dem Web-Kanal mit erkanntem Typ, Arbeitskopie im Ordner des Gesprächs
    expect(rec.assets[0].options).toMatchObject({ channel: "web", originalFilename: "Umsatz.png", mimeType: "image/png" });
    expect(await readdir(join(mediaDir, id))).toHaveLength(1);
    expect(rec.descriptions).toEqual([{ assetId: "asset-1", description: "Balkendiagramm", tags: ["diagramm", "zahlen"] }]);

    // Gedächtnis: Text plus Zeile je Anhang, Anhänge mit Asset in metadata
    const user = rec.saved.find(m => m.role === "user")!;
    expect(user.content).toBe("Was siehst du?\n[Photo: Umsatz.png]");
    expect(user.metadata).toMatchObject({ channel: "web", webText: "Was siehst du?" });
    expect((user.metadata as any).attachments).toEqual([
      { id: image, name: "Umsatz.png", size: PNG.length, mime: "image/png", kind: "image", assetId: "asset-1" },
    ]);
    const reply = rec.saved.find(m => m.role === "assistant")!;
    expect(reply.content).not.toContain("[ASSET_DESC");
    // Merk-Tags aus diesem Turn nur als Vorschlag: foreignInput gesetzt
    expect(rec.intents).toHaveLength(1);
    expect(rec.intents[0].turn).toMatchObject({ chatId: `web:${id}`, origin: "Web-Gespräch", foreignInput: "Foto" });
    // Verlauf im Browser: Antwort ohne Tag, eigene Nachricht mit Anhang
    const answer = messages.find(m => m.role === "assistant");
    expect(answer.text).not.toContain("[ASSET_DESC");
    expect(messages.find(m => m.role === "user").attachments[0].id).toBe(image);
    expect(rec.unlinked).toEqual([]);
  });

  test("PDF: Dateipfad und Name im Prompt, foreignInput hochgeladene Datei", async () => {
    const { ctx, rec, mediaDir } = await start();
    const id = ctx.webConversationId;
    const pdf = await upload(ctx, id, PDF, "Vertrag.pdf");
    await sendAndWait(ctx, id, { text: "", attachments: [pdf] });
    const prompt = rec.turns[0].userMessage;
    expect(prompt).toContain(`[User sent a document saved at: ${join(mediaDir, id)}/`);
    expect(prompt).toContain("filename: Vertrag.pdf");
    expect(rec.saved.find(m => m.role === "user")!.content).toBe("[Document: Vertrag.pdf]");
    expect(rec.intents[0].turn.foreignInput).toBe("hochgeladene Datei");
    expect(rec.assets).toEqual([]);
  });

  test("Sprachaufnahme: Transkript im Prompt und im Gedächtnis, kein foreignInput, Datei danach gelöscht", async () => {
    const { ctx, rec, mediaDir } = await start();
    const id = ctx.webConversationId;
    const voice = await upload(ctx, id, OGG_OPUS, "aufnahme.ogg");
    await sendAndWait(ctx, id, { text: "", attachments: [voice] });
    expect(rec.transcribed).toHaveLength(1);
    expect(rec.transcribed[0].startsWith(join(mediaDir, id) + "/voice_")).toBe(true);
    expect(rec.turns[0].userMessage).toBe("[Voice message transcription]: Bitte morgen um neun erinnern");
    expect(rec.saved.find(m => m.role === "user")!.content).toBe("[Voice message: aufnahme.ogg] Bitte morgen um neun erinnern");
    expect(rec.intents[0].turn.foreignInput).toBeUndefined();
    expect(rec.unlinked).toEqual(rec.transcribed);
  });

  test("Bild, PDF und Sprache zusammen: ein gemeinsamer Prompt, foreignInput aus Bild und PDF", async () => {
    const { ctx, rec } = await start();
    const id = ctx.webConversationId;
    const ids = [
      await upload(ctx, id, PNG, "a.png"),
      await upload(ctx, id, PDF, "b.pdf"),
      await upload(ctx, id, OGG_OPUS, "c.ogg"),
    ];
    await sendAndWait(ctx, id, { text: "Alles zusammen", attachments: ids });
    const prompt = rec.turns[0].userMessage;
    expect(prompt).toContain("[Image 1 of 3 attached:");
    expect(prompt).toContain("filename: b.pdf");
    expect(prompt).toContain("[Voice message transcription]: Bitte morgen um neun erinnern");
    expect(prompt.endsWith("User says: Alles zusammen")).toBe(true);
    expect(rec.intents[0].turn.foreignInput).toBe("Foto, hochgeladene Datei");
  });

  test("Verarbeitung scheitert: Fehlermeldung im Verlauf, kein Claude-Aufruf, Anhang bleibt bei der gespeicherten Nachricht", async () => {
    const { ctx, rec } = await start();
    const id = ctx.webConversationId;
    rec.transcribe = async () => {
      throw new Error("Dienst weg");
    };
    const voice = await upload(ctx, id, OGG_OPUS, "aufnahme.ogg");
    const messages = await sendAndWait(ctx, id, { text: "", attachments: [voice] });
    expect(rec.turns).toEqual([]);
    expect(rec.saved).toEqual([]);
    expect(messages.at(-1)).toMatchObject({ role: "error", text: WEB_ATTACHMENT_FAILED_TEXT });
    // Nicht wieder freigegeben: die Nutzernachricht mit diesem Anhang steht schon im Verlauf
    expect((await ctx.uploads.find(id, voice))?.state).toBe("sent");
    expect(messages.find(m => m.role === "user").attachments[0].id).toBe(voice);
    const again = await ctx.api(`/api/conversations/${id}/messages`, { method: "POST", body: { attachments: [voice] } });
    expect(again.status).toBe(400);
    // Die Sprachdatei ist trotzdem weg
    expect(rec.unlinked).toEqual(rec.transcribed);
  });

  test("Stopp während der Antwort: Anhang bleibt abgeschickt, Sprachdatei gelöscht, keine Merk-Tags", async () => {
    const { ctx, rec } = await start();
    const id = ctx.webConversationId;
    let started = false;
    rec.core = opts =>
      new Promise(resolve => {
        started = true;
        opts.sink.start?.();
        setTimeout(() => resolve("zu spät"), 2000);
      });
    const voice = await upload(ctx, id, OGG_OPUS, "aufnahme.ogg");
    expect((await ctx.api(`/api/conversations/${id}/messages`, { method: "POST", body: { attachments: [voice] } })).status).toBe(202);
    await waitUntil(() => started);
    expect((await ctx.api(`/api/conversations/${id}/stop`, { method: "POST" })).status).toBe(200);
    for (let i = 0; i < 400; i++) {
      if (!(await (await ctx.api(`/api/conversations/${id}`)).json()).running) break;
      await Bun.sleep(5);
    }
    expect(rec.intents).toEqual([]);
    expect((await ctx.uploads.find(id, voice))?.state).toBe("sent");
    expect(rec.unlinked).toEqual(rec.transcribed);
  });

  test("Löschen des Gesprächs entfernt auch die Arbeitskopien des Medien-Kerns", async () => {
    const { ctx, mediaDir } = await start();
    const id = ctx.webConversationId;
    const image = await upload(ctx, id, PNG, "a.png");
    await sendAndWait(ctx, id, { attachments: [image] });
    expect(await exists(join(mediaDir, id))).toBe(true);
    expect((await ctx.api(`/api/conversations/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await exists(join(mediaDir, id))).toBe(false);
    expect(await exists(join(ctx.uploadsDir, id))).toBe(false);
  });
});

describe("src/bot.ts (nur als Text)", () => {
  test("Web-Turn bekommt die Ablage, die Ablage kennt die Arbeitskopien", async () => {
    const bot = await Bun.file(join(import.meta.dir, "..", "src", "bot.ts")).text();
    expect(bot).toContain('new UploadStore({ dir: join(PROJECT_ROOT, "data", "uploads"), mediaDir: webMediaDir() })');
    expect(bot).toContain("createBotChat({ ...webTurnDeps, uploads: webUploads, approvals: approvalTurns })");
    // Die Ablage steht vor dem Web-Turn, der sie benutzt
    expect(bot.indexOf("const webUploads")).toBeLessThan(bot.indexOf("const webChat"));
  });
});
