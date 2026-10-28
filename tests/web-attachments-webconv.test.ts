// Anhänge in reinen Web-Gesprächen (Issue #112, Schritt 1): Upload, Nachricht
// mit Anhängen, Verlauf und Download über dieselben Routen wie in
// Telegram-Gesprächen, aber ohne Spiegelung nach Telegram. Anhänge bleiben
// an ihr Gespräch gebunden und gehen beim Löschen des Gesprächs mit.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { abortAllExecutions } from "../src/lib/execution-context";
import type { RunTurnOptions, TurnResult, WebChat } from "../src/web/chat";
import type { WebServer } from "../src/web/server";
import { UploadStore } from "../src/web/uploads";
import { TOPIC, fakeTelegramChat, makeRoot, startAttachmentServer, waitUntil, type AttachmentCtx } from "./attachments-fixture";
import { OGG_OPUS, PDF, PNG } from "./media-fixture";

const root = await makeRoot("tybo-web-attach-webconv-");
afterAll(() => root.cleanup());
const servers: WebServer[] = [];
afterEach(async () => {
  abortAllExecutions();
  for (const s of servers.splice(0)) await s.stop();
});

/** Web-Chat-Attrappe: merkt sich jeden Turn, antwortet sofort oder wenn hold gelöst wird */
function fakeWebChat() {
  const turns: RunTurnOptions[] = [];
  let hold: Promise<void> | null = null;
  let release = () => {};
  const chat: WebChat = {
    async runTurn(opts): Promise<TurnResult> {
      turns.push(opts);
      if (hold) await hold;
      return { text: "Gesehen." };
    },
    stop: () => true,
  };
  return {
    turns,
    chat,
    block() {
      hold = new Promise(r => (release = r));
    },
    unblock() {
      release();
      hold = null;
    },
  };
}

async function start() {
  const dir = root.next();
  const mediaDir = join(dir, "media-web");
  const web = fakeWebChat();
  const telegram = fakeTelegramChat(join(dir, "media"));
  const ctx = await startAttachmentServer({ dir, servers, mediaDir, webChat: () => web.chat, telegramChat: telegram.factory });
  return { ctx, web, telegram: telegram.rec, mediaDir };
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

async function exists(path: string): Promise<boolean> {
  return !!(await stat(path).catch(() => null));
}

describe("Anhänge in reinen Web-Gesprächen", () => {
  test("Upload, Nachricht mit Bild, PDF und Sprachdatei: der Turn bekommt sie, nichts geht nach Telegram", async () => {
    const { ctx, web, telegram } = await start();
    const id = ctx.webConversationId;
    const image = await upload(ctx, id, PNG, "Umsatz.png");
    const pdf = await upload(ctx, id, PDF, "Vertrag.pdf");
    const voice = await upload(ctx, id, OGG_OPUS, "aufnahme.ogg");
    const res = await send(ctx, id, { text: "Schau mal", attachments: [image, pdf, voice] });
    expect(res.status).toBe(202);
    const { message } = await res.json();
    expect(message.text).toBe("Schau mal");
    expect(message.attachments.map((a: any) => [a.name, a.kind, a.url])).toEqual([
      ["Umsatz.png", "image", `/api/conversations/${id}/attachments/${image}`],
      ["Vertrag.pdf", "document", `/api/conversations/${id}/attachments/${pdf}`],
      ["aufnahme.ogg", "audio", `/api/conversations/${id}/attachments/${voice}`],
    ]);
    expect(message.attachments[0].previewUrl).toBe(`/api/conversations/${id}/attachments/${image}?inline=1`);
    expect(message.attachments[1].previewUrl).toBeUndefined();
    await idle(ctx, id);

    expect(web.turns).toHaveLength(1);
    expect(web.turns[0].conversationId).toBe(id);
    expect(web.turns[0].attachments?.map(a => a.id)).toEqual([image, pdf, voice]);
    // Ohne Adressen an den Turn
    expect(web.turns[0].attachments?.every(a => !("url" in a))).toBe(true);
    // Keine Spiegelung: weder Datei noch Text nach Telegram, kein Telegram-Turn
    expect(telegram.files).toEqual([]);
    expect(telegram.plain).toEqual([]);
    expect(telegram.turns).toEqual([]);
    expect(telegram.agentSends).toEqual([]);
    // Angenommen: sent, lassen sich nicht noch einmal schicken
    for (const a of [image, pdf, voice]) expect((await ctx.uploads.find(id, a))?.state).toBe("sent");
    expect((await send(ctx, id, { attachments: [image] })).status).toBe(400);
  });

  test("Verlauf nach Neuladen: Anhänge mit Adressen, Vorschau und Download mit Anmeldung", async () => {
    const { ctx } = await start();
    const id = ctx.webConversationId;
    const image = await upload(ctx, id, PNG, "Bild.png");
    const voice = await upload(ctx, id, OGG_OPUS, "sprache.ogg");
    expect((await send(ctx, id, { text: "", attachments: [image, voice] })).status).toBe(202);
    await idle(ctx, id);

    // Neu geladen: frisch aus der Datei gelesen
    const { messages } = await (await ctx.api(`/api/conversations/${id}/messages`)).json();
    const user = messages.find((m: any) => m.role === "user");
    expect(user.text).toBe("");
    expect(user.attachments.map((a: any) => a.id)).toEqual([image, voice]);
    expect(user.attachments[0].previewUrl).toBe(`/api/conversations/${id}/attachments/${image}?inline=1`);
    // Titel des Gesprächs aus dem ersten Anhang, wenn kein Text da ist
    const { conversation } = await (await ctx.api(`/api/conversations/${id}`)).json();
    expect(conversation.title).toBe("Bild.png");

    const inline = await ctx.api(user.attachments[0].previewUrl);
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await inline.arrayBuffer())).toEqual(PNG);
    const audio = await ctx.api(user.attachments[1].url);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-disposition")).toContain("attachment");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(OGG_OPUS);
    // Ohne Anmeldung weder Download noch Upload
    expect((await ctx.api(user.attachments[0].url, { cookie: null })).status).toBe(401);
    const anonymous = await fetch(`${ctx.origin}/api/conversations/${id}/attachments`, {
      method: "POST",
      headers: { origin: ctx.origin },
      body: PNG,
    });
    expect(anonymous.status).toBe(401);
  });

  test("Trennung: Anhang aus Gespräch A ist in B weder sendbar noch abrufbar, unbekannte Gespräche 404", async () => {
    const { ctx, web } = await start();
    const a = ctx.webConversationId;
    const b = ctx.otherWebConversationId;
    const fromA = await upload(ctx, a, PNG);
    const fromTopic = await upload(ctx, TOPIC, PNG);

    const inB = await send(ctx, b, { text: "x", attachments: [fromA] });
    expect(inB.status).toBe(400);
    expect((await inB.json()).error).toContain("aus einem anderen Gespräch");
    const topicInA = await send(ctx, a, { text: "x", attachments: [fromTopic] });
    expect(topicInA.status).toBe(400);
    const webInTopic = await send(ctx, TOPIC, { text: "x", attachments: [fromA] });
    expect(webInTopic.status).toBe(400);
    expect(web.turns).toEqual([]);
    expect((await ctx.uploads.find(a, fromA))?.state).toBe("pending");

    // Download nur unter dem eigenen Gespräch
    expect((await ctx.api(`/api/conversations/${a}/attachments/${fromA}`)).status).toBe(200);
    expect((await ctx.api(`/api/conversations/${b}/attachments/${fromA}`)).status).toBe(404);
    expect((await ctx.api(`/api/conversations/dm/attachments/${fromA}`)).status).toBe(404);
    expect((await ctx.api(`/api/conversations/${a}/attachments/${fromTopic}`)).status).toBe(404);
    // Unbekanntes Gespräch: weder Upload noch Download
    const unknown = crypto.randomUUID();
    expect((await ctx.upload(unknown, PNG)).status).toBe(404);
    expect((await ctx.api(`/api/conversations/${unknown}/attachments/${fromA}`)).status).toBe(404);
    expect(await readdir(ctx.uploadsDir)).not.toContain(unknown);
  });

  test("Löschen des Gesprächs entfernt abgeschickte und offene Anhänge samt Arbeitskopien, andere bleiben", async () => {
    const { ctx, mediaDir } = await start();
    const id = ctx.webConversationId;
    const other = ctx.otherWebConversationId;
    const sent = await upload(ctx, id, PNG);
    expect((await send(ctx, id, { attachments: [sent] })).status).toBe(202);
    await idle(ctx, id);
    const pending = await upload(ctx, id, PDF);
    const keep = await upload(ctx, other, PNG);
    const keepTopic = await upload(ctx, TOPIC, PNG);
    // Arbeitskopien des Medien-Kerns wie nach prepareMedia
    await mkdir(join(mediaDir, id), { recursive: true });
    await writeFile(join(mediaDir, id, "photo_1.png"), PNG);
    await mkdir(join(mediaDir, other), { recursive: true });
    await writeFile(join(mediaDir, other, "photo_2.png"), PNG);

    const res = await ctx.api(`/api/conversations/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await exists(join(ctx.uploadsDir, id))).toBe(false);
    expect(await exists(join(mediaDir, id))).toBe(false);
    expect(await ctx.uploads.find(id, sent)).toBeNull();
    expect(await ctx.uploads.find(id, pending)).toBeNull();
    // Anderes Web-Gespräch und Topic unberührt
    expect(await ctx.uploads.find(other, keep)).not.toBeNull();
    expect(await ctx.uploads.find(TOPIC, keepTopic)).not.toBeNull();
    expect(await exists(join(mediaDir, other, "photo_2.png"))).toBe(true);
    // Danach kein Upload und kein Download mehr
    expect((await ctx.upload(id, PNG)).status).toBe(404);
    expect((await ctx.api(`/api/conversations/${id}/attachments/${sent}`)).status).toBe(404);
  });

  test("Löschen während einer laufenden Antwort: 409, Anhänge bleiben", async () => {
    const { ctx, web } = await start();
    const id = ctx.webConversationId;
    const a = await upload(ctx, id, PNG);
    web.block();
    expect((await send(ctx, id, { attachments: [a] })).status).toBe(202);
    await waitUntil(() => web.turns.length === 1);
    expect((await ctx.api(`/api/conversations/${id}`, { method: "DELETE" })).status).toBe(409);
    expect(await ctx.uploads.find(id, a)).not.toBeNull();
    web.unblock();
    await idle(ctx, id);
    expect((await ctx.api(`/api/conversations/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await ctx.uploads.find(id, a)).toBeNull();
  });
});

describe("UploadStore.removeConversation", () => {
  test("gleichzeitiges Ablegen: danach bleibt nichts liegen, spätere Uploads und claim lehnen ab", async () => {
    const dir = root.next();
    const uploads = new UploadStore({ dir: join(dir, "uploads"), log: () => {} });
    const id = crypto.randomUUID();
    const first = await uploads.save(id, PNG, "a.png");
    expect(first.ok).toBe(true);
    // Ablegen und Löschen zugleich: das Ablegen läuft zuerst durch, dann wird alles gelöscht
    const racing = uploads.save(id, PNG, "b.png");
    await uploads.removeConversation(id);
    await racing;
    expect(await uploads.conversationDir(id)).toBeNull();
    const late = await uploads.save(id, PNG, "c.png");
    expect(late).toEqual({ ok: false, status: 404, error: "Gespräch nicht gefunden" });
    expect(await uploads.conversationDir(id)).toBeNull();
    const claimed = await uploads.claim(id, [first.ok ? first.attachment.id : ""]);
    expect(claimed.ok).toBe(false);
  });

  test("nur Web-Gespräche; Symlink statt Ordner der Arbeitskopien wird nicht verfolgt", async () => {
    const dir = root.next();
    const mediaDir = join(dir, "media-web");
    const outside = join(dir, "anderswo");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "wichtig.txt"), "bleibt");
    await mkdir(mediaDir, { recursive: true });
    const id = crypto.randomUUID();
    await symlink(outside, join(mediaDir, id));
    const uploads = new UploadStore({ dir: join(dir, "uploads"), mediaDir, log: () => {} });
    await uploads.removeConversation(id);
    expect(await exists(join(outside, "wichtig.txt"))).toBe(true);
    await expect(uploads.removeConversation("dm")).rejects.toThrow();
    await expect(uploads.removeConversation("topic-443")).rejects.toThrow();
  });
});
