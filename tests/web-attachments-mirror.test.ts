// Spiegelung von Anhängen nach Telegram (Issue #72, Schritt 3): der Haupt-Bot
// schickt jeden Anhang als Foto bzw. Dokument ins selbe Gespräch, der erste
// trägt „Du (Web): <Text>". Telegram ist eine Attrappe.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { abortAllExecutions } from "../src/lib/execution-context";
import {
  MIRROR_FAILED_TEXT,
  MIRROR_PARTIAL_TEXT,
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_PHOTO_MAX_BYTES,
  attachmentMirrorPlan,
  mirrorChunks,
} from "../src/web/bot-turn";
import type { WebServer } from "../src/web/server";
import { GROUP, TOPIC, USER, fakeTelegramChat, listen, makeRoot, startAttachmentServer, waitUntil, type AttachmentCtx } from "./attachments-fixture";
import { OGG_OPUS, PDF, PNG } from "./media-fixture";

const root = await makeRoot("tybo-web-attach-mirror-");
afterAll(() => root.cleanup());
const servers: WebServer[] = [];
afterEach(async () => {
  abortAllExecutions();
  for (const s of servers.splice(0)) await s.stop();
});

async function start() {
  const dir = root.next();
  const { rec, factory } = fakeTelegramChat(join(dir, "media"));
  const ctx = await startAttachmentServer({ dir, servers, telegramChat: factory });
  return { ctx, rec };
}

async function upload(ctx: AttachmentCtx, conversationId: string, body: Uint8Array, name: string): Promise<string> {
  const res = await ctx.upload(conversationId, body, { "x-file-name": encodeURIComponent(name) });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

function send(ctx: AttachmentCtx, conversationId: string, body: unknown) {
  return ctx.api(`/api/conversations/${conversationId}/messages`, { method: "POST", body });
}

async function idle(ctx: AttachmentCtx, conversationId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (!(await (await ctx.api(`/api/conversations/${conversationId}`)).json()).running) return;
    await Bun.sleep(5);
  }
  throw new Error("Turn läuft noch");
}

const png = (size = 100) => ({ kind: "image" as const, mime: "image/png", size });

describe("attachmentMirrorPlan", () => {
  test("erster Anhang trägt den Text, weitere nur die Herkunft; ohne Text nur die Herkunft", () => {
    expect(attachmentMirrorPlan("Schau mal", "web", [png(), { kind: "document", mime: "application/pdf", size: 10 }])).toEqual({
      files: [
        { as: "photo", caption: "Du (Web): Schau mal" },
        { as: "document", caption: "Du (Web)" },
      ],
      textChunks: [],
    });
    expect(attachmentMirrorPlan("  ", "web", [png()]).files[0].caption).toBe("Du (Web)");
    expect(attachmentMirrorPlan("hi", "terminal", [png(), png()]).files.map(f => f.caption)).toEqual(["Du (Terminal): hi", "Du (Terminal)"]);
  });

  test("Beschriftung höchstens 1024 Zeichen: sonst alle nur Herkunft, Text folgt in Teilen", () => {
    const prefix = "Du (Web): ";
    const exact = "x".repeat(TELEGRAM_CAPTION_MAX - prefix.length);
    expect(attachmentMirrorPlan(exact, "web", [png()])).toEqual({ files: [{ as: "photo", caption: prefix + exact }], textChunks: [] });
    const long = "y".repeat(TELEGRAM_CAPTION_MAX);
    const plan = attachmentMirrorPlan(long, "web", [png(), png()]);
    expect(plan.files.map(f => f.caption)).toEqual(["Du (Web)", "Du (Web)"]);
    expect(plan.textChunks).toEqual(mirrorChunks(long, "web"));
    // Emoji zählen in Telegram doppelt (UTF-16)
    const emoji = "😀".repeat(510);
    expect(attachmentMirrorPlan(emoji, "web", [png()]).textChunks.length).toBeGreaterThan(0);
  });

  test("Foto nur für PNG, JPEG und WebP bis 10 MB; GIF, große Bilder, PDF und Sprache als Dokument", () => {
    const plan = attachmentMirrorPlan("", "web", [
      { kind: "image", mime: "image/jpeg", size: 5 },
      { kind: "image", mime: "image/webp", size: TELEGRAM_PHOTO_MAX_BYTES },
      { kind: "image", mime: "image/gif", size: 5 },
      { kind: "image", mime: "image/png", size: TELEGRAM_PHOTO_MAX_BYTES + 1 },
      { kind: "document", mime: "application/pdf", size: 5 },
      { kind: "audio", mime: "audio/ogg", size: 5 },
    ]);
    expect(plan.files.map(f => f.as)).toEqual(["photo", "photo", "document", "document", "document", "document"]);
  });
});

describe("Spiegel im Turn", () => {
  test("Topic: Foto mit Beschriftung „Du (Web): …“ ins selbe Topic, vor dem Claude-Aufruf; Datei unverändert", async () => {
    const { ctx, rec } = await start();
    let filesBeforeClaude = -1;
    rec.core = async () => {
      filesBeforeClaude = rec.files.length;
      return "ok";
    };
    const id = await upload(ctx, TOPIC, PNG, "Screenshot.png");
    expect((await send(ctx, TOPIC, { text: "Was siehst du?", attachments: [id] })).status).toBe(202);
    await idle(ctx, TOPIC);
    expect(rec.files).toEqual([
      { chatId: GROUP, name: "Screenshot.png", mime: "image/png", size: PNG.length, as: "photo", caption: "Du (Web): Was siehst du?", threadId: 443, ok: true },
    ]);
    expect(filesBeforeClaude).toBe(1);
    // Kein zusätzlicher Text-Spiegel: der Text steht in der Beschriftung
    expect(rec.plain).toEqual([]);
    expect(rec.agentSends).toHaveLength(1);
  });

  test("Direktchat: Dokument und Sprachdatei ohne Thread; zweiter Anhang nur mit Herkunft", async () => {
    const { ctx, rec } = await start();
    const ids = [await upload(ctx, "dm", PDF, "Rechnung.pdf"), await upload(ctx, "dm", OGG_OPUS, "Notiz.ogg")];
    await send(ctx, "dm", { text: "", attachments: ids });
    await idle(ctx, "dm");
    expect(rec.files.map(f => [f.chatId, f.name, f.as, f.caption, f.threadId])).toEqual([
      [USER, "Rechnung.pdf", "document", "Du (Web)", undefined],
      [USER, "Notiz.ogg", "document", "Du (Web)", undefined],
    ]);
  });

  test("langer Text: Anhänge mit Herkunft, der ganze Text danach als Klartext in Teilen", async () => {
    const { ctx, rec } = await start();
    const text = "Absatz ".repeat(700).trim();
    const id = await upload(ctx, TOPIC, PNG, "a.png");
    await send(ctx, TOPIC, { text, attachments: [id] });
    await idle(ctx, TOPIC);
    expect(rec.files.map(f => f.caption)).toEqual(["Du (Web)"]);
    expect(rec.plain.length).toBeGreaterThan(1);
    expect(rec.plain.map(p => p.threadId)).toEqual(rec.plain.map(() => 443));
    expect(rec.plain.map(p => p.text)).toEqual(mirrorChunks(text, "web"));
  });

  test("Foto abgelehnt: als Dokument nachgeschickt, der Turn läuft weiter", async () => {
    const { ctx, rec } = await start();
    rec.sendFile = async (_file, as) => {
      if (as === "photo") throw new Error("PHOTO_INVALID_DIMENSIONS");
    };
    const id = await upload(ctx, TOPIC, PNG, "breit.png");
    await send(ctx, TOPIC, { text: "hi", attachments: [id] });
    await idle(ctx, TOPIC);
    expect(rec.files.map(f => [f.as, f.caption, f.ok])).toEqual([
      ["photo", "Du (Web): hi", false],
      ["document", "Du (Web): hi", true],
    ]);
    expect(rec.turns).toHaveLength(1);
  });

  test("Spiegelung scheitert: Fehlermeldung, kein Claude-Aufruf, nichts gespeichert, Anhang wieder frei, Sprachdatei gelöscht", async () => {
    const { ctx, rec } = await start();
    rec.sendFile = async () => {
      throw new Error("Telegram weg");
    };
    const events = await listen(ctx, TOPIC);
    const id = await upload(ctx, TOPIC, OGG_OPUS, "n.ogg");
    await send(ctx, TOPIC, { text: "hallo", attachments: [id] });
    await waitUntil(() => events.events.some(e => e.event === "error"));
    expect(events.events.find(e => e.event === "error")!.data.text).toBe(MIRROR_FAILED_TEXT);
    await idle(ctx, TOPIC);
    await events.close();
    expect(rec.turns).toEqual([]);
    expect(rec.saved).toEqual([]);
    expect(rec.unlinked).toEqual(rec.written);
    expect((await ctx.uploads.find(TOPIC, id))?.state).toBe("pending");
  });

  test("teilweise gespiegelt: eigene Meldung, Anhänge wieder frei", async () => {
    const { ctx, rec } = await start();
    rec.sendFile = async file => {
      if (file.mime === "application/pdf") throw new Error("zu groß");
    };
    const events = await listen(ctx, TOPIC);
    const ids = [await upload(ctx, TOPIC, PNG, "a.png"), await upload(ctx, TOPIC, PDF, "b.pdf")];
    await send(ctx, TOPIC, { attachments: ids });
    await waitUntil(() => events.events.some(e => e.event === "error"));
    expect(events.events.find(e => e.event === "error")!.data.text).toBe(MIRROR_PARTIAL_TEXT);
    await idle(ctx, TOPIC);
    await events.close();
    expect(rec.turns).toEqual([]);
    for (const id of ids) expect((await ctx.uploads.find(TOPIC, id))?.state).toBe("pending");
  });

  test("Stopp während der Spiegelung: kein weiterer Anhang, kein Claude-Aufruf, Anhänge wieder frei", async () => {
    const { ctx, rec } = await start();
    let release!: () => void;
    rec.sendFile = () => new Promise<void>(resolve => (release = resolve));
    const ids = [await upload(ctx, TOPIC, PNG, "a.png"), await upload(ctx, TOPIC, PNG, "b.png")];
    await send(ctx, TOPIC, { attachments: ids });
    await waitUntil(() => rec.files.length === 1);
    const stop = await ctx.api(`/api/conversations/${TOPIC}/stop`, { method: "POST" });
    expect((await stop.json()).stopping).toBe(true);
    release();
    await idle(ctx, TOPIC);
    expect(rec.files).toHaveLength(1);
    expect(rec.turns).toEqual([]);
    for (const id of ids) expect((await ctx.uploads.find(TOPIC, id))?.state).toBe("pending");
  });
});
