// Symlinks in der Anhang-Ablage (Issue #72, Prüfung von PR #96): Gesprächs-
// ordner, Anhang-Ordner, meta.json und Datei zählen nur als echte Ordner bzw.
// Dateien unter der Wurzel. Über einen Symlink wird nichts gelesen,
// geschrieben, heruntergeladen, an einen Turn gegeben oder gelöscht.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { abortAllExecutions } from "../src/lib/execution-context";
import type { MessageAttachment } from "../src/web/attachments";
import type { WebChat } from "../src/web/chat";
import { ATTACHMENT_FAILED_TEXT } from "../src/web/bot-turn";
import type { WebServer } from "../src/web/server";
import { UPLOAD_MAX_AGE_MS, UploadStore } from "../src/web/uploads";
import { TOPIC, fakeTelegramChat, listen, makeRoot, startAttachmentServer, waitUntil, type AttachmentCtx } from "./attachments-fixture";
import { PNG } from "./media-fixture";

const root = await makeRoot("tybo-web-uploads-link-");
afterAll(() => root.cleanup());
const servers: WebServer[] = [];
afterEach(async () => {
  abortAllExecutions();
  for (const s of servers.splice(0)) await s.stop();
});

const T0 = Date.parse("2026-09-25T08:00:00.000Z");
const LATER = T0 + UPLOAD_MAX_AGE_MS + 60_000;

async function start() {
  const dir = root.next();
  let now = T0;
  const { rec, factory } = fakeTelegramChat(join(dir, "media"));
  let chat: WebChat | undefined;
  const ctx = await startAttachmentServer({
    dir,
    servers,
    now: () => now,
    telegramChat: (rows, uploads) => (chat = factory(rows, uploads)),
  });
  return { ctx, rec, chat: chat!, dir, later: () => (now = LATER) };
}

/** Gültiger Anhang außerhalb der Ablage: <dir>/<Gespräch>/<ID>/ mit file.png und meta.json */
async function outside(dir: string, conversationId = TOPIC) {
  const store = new UploadStore({ dir, now: () => T0, log: () => {} });
  const result = await store.save(conversationId, PNG, "draussen.png");
  if (!result.ok) throw new Error(result.error);
  const folder = join(dir, conversationId, result.attachment.id);
  return { store, attachment: result.attachment, id: result.attachment.id, folder };
}

async function files(folder: string): Promise<string[]> {
  return (await readdir(folder)).sort();
}

function download(ctx: AttachmentCtx, id: string) {
  return ctx.api(`/api/conversations/${TOPIC}/attachments/${id}`);
}

/** Turn direkt mit einem Anhang, am Annehmen vorbei: nur das Lesen der Ablage entscheidet */
function turnWith(chat: WebChat, attachment: MessageAttachment) {
  return chat.runTurn({ conversationId: TOPIC, agent: "general", text: "", attachments: [attachment], sink: { progress: () => {}, notice: () => {} } });
}

describe("verlinkter Gesprächsordner", () => {
  test("nicht lesbar, nicht annehmbar, kein Download, kein Turn, kein Ablegen, Aufräumen lässt das Ziel stehen", async () => {
    const { ctx, rec, chat, dir, later } = await start();
    const target = await outside(join(dir, "fremd"));
    await mkdir(ctx.uploadsDir, { recursive: true });
    await symlink(join(dir, "fremd", TOPIC), join(ctx.uploadsDir, TOPIC));

    expect(await ctx.uploads.find(TOPIC, target.id)).toBeNull();
    await expect(ctx.uploads.read(TOPIC, target.id)).rejects.toThrow();
    expect(await ctx.uploads.conversationDir(TOPIC)).toBeNull();
    expect((await download(ctx, target.id)).status).toBe(404);
    // Senden über die Schnittstelle: nicht angenommen
    const res = await ctx.api(`/api/conversations/${TOPIC}/messages`, { method: "POST", body: { attachments: [target.id] } });
    expect(res.status).toBe(400);
    // Turn-Lesen am Annehmen vorbei: scheitert, nichts verarbeitet oder gespiegelt
    const result = await turnWith(chat, target.attachment);
    expect(result).toMatchObject({ text: ATTACHMENT_FAILED_TEXT, failed: true });
    expect(rec.written).toEqual([]);
    expect(rec.files).toEqual([]);
    // Freigeben schreibt nicht durch den Link
    await ctx.uploads.unclaim(TOPIC, [target.id]);
    // Ablegen in dieses Gespräch schreibt nicht ins Ziel
    await expect(ctx.uploads.save(TOPIC, PNG, "neu.png")).rejects.toThrow();
    expect(await readdir(join(dir, "fremd", TOPIC))).toEqual([target.id]);
    // Aufräumen nach 24 Stunden: das Ziel bleibt vollständig
    later();
    expect(await ctx.uploads.cleanup()).toBe(0);
    expect(await files(target.folder)).toEqual(["file.png", "meta.json"]);
    expect((await target.store.find(TOPIC, target.id))?.state).toBe("pending");
  });
});

describe("verlinkter Anhang-Ordner", () => {
  test("nicht lesbar, kein Download, kein Turn, Aufräumen lässt das Ziel stehen", async () => {
    const { ctx, rec, chat, dir, later } = await start();
    const target = await outside(join(dir, "fremd"));
    await mkdir(join(ctx.uploadsDir, TOPIC), { recursive: true });
    await symlink(target.folder, join(ctx.uploadsDir, TOPIC, target.id));

    expect(await ctx.uploads.find(TOPIC, target.id)).toBeNull();
    await expect(ctx.uploads.read(TOPIC, target.id)).rejects.toThrow();
    expect((await download(ctx, target.id)).status).toBe(404);
    expect((await ctx.uploads.claim(TOPIC, [target.id])).ok).toBe(false);
    const result = await turnWith(chat, target.attachment);
    expect(result).toMatchObject({ text: ATTACHMENT_FAILED_TEXT, failed: true });
    expect(rec.written).toEqual([]);
    later();
    expect(await ctx.uploads.cleanup()).toBe(0);
    expect(await files(target.folder)).toEqual(["file.png", "meta.json"]);
  });
});

describe("verlinkte Dateien im echten Anhang-Ordner", () => {
  test("meta.json als Link: unbekannt, nicht annehmbar, das Ziel wird nicht überschrieben", async () => {
    const { ctx, dir } = await start();
    const own = await ctx.uploads.save(TOPIC, PNG, "eigen.png");
    if (!own.ok) throw new Error(own.error);
    const target = await outside(join(dir, "fremd"));
    const meta = join(ctx.uploadsDir, TOPIC, own.attachment.id, "meta.json");
    // Ziel mit passenden Angaben (gleiche ID), damit nur der Link den Unterschied macht
    await rename(join(target.folder, "meta.json"), join(dir, "fremd-meta.json"));
    const before = (await readFile(join(dir, "fremd-meta.json"), "utf8")).replace(target.id, own.attachment.id);
    await Bun.write(join(dir, "fremd-meta.json"), before);
    await rename(meta, `${meta}.alt`);
    await symlink(join(dir, "fremd-meta.json"), meta);

    expect(await ctx.uploads.find(TOPIC, own.attachment.id)).toBeNull();
    expect((await ctx.uploads.claim(TOPIC, [own.attachment.id])).ok).toBe(false);
    expect((await download(ctx, own.attachment.id)).status).toBe(404);
    expect(await readFile(join(dir, "fremd-meta.json"), "utf8")).toBe(before);
  });

  test("Nutzdatei als Link: kein Download, Turn scheitert ohne Spiegeln, Aufräumen löscht nur den Link", async () => {
    const { ctx, rec, dir, later } = await start();
    const own = await ctx.uploads.save(TOPIC, PNG, "eigen.png");
    if (!own.ok) throw new Error(own.error);
    const target = await outside(join(dir, "fremd"));
    const file = join(ctx.uploadsDir, TOPIC, own.attachment.id, "file.png");
    await rename(file, `${file}.alt`);
    await symlink(join(target.folder, "file.png"), file);

    await expect(ctx.uploads.read(TOPIC, own.attachment.id)).rejects.toThrow();
    expect((await download(ctx, own.attachment.id)).status).toBe(404);
    expect((await download(ctx, `${own.attachment.id}?inline=1`)).status).toBe(404);
    // Turn über die Schnittstelle: angenommen (meta.json ist echt), das Lesen scheitert
    const events = await listen(ctx, TOPIC);
    const res = await ctx.api(`/api/conversations/${TOPIC}/messages`, { method: "POST", body: { attachments: [own.attachment.id] } });
    expect(res.status).toBe(202);
    await waitUntil(() => events.events.some(e => e.event === "error"));
    expect(events.events.find(e => e.event === "error")!.data.text).toBe(ATTACHMENT_FAILED_TEXT);
    await events.close();
    expect(rec.written).toEqual([]);
    expect(rec.files).toEqual([]);
    expect(rec.turns).toEqual([]);
    // Wieder frei und nach 24 Stunden aufgeräumt: der Link ist weg, das Ziel bleibt
    for (let i = 0; i < 200 && (await ctx.uploads.find(TOPIC, own.attachment.id))?.state !== "pending"; i++) await Bun.sleep(5);
    expect((await ctx.uploads.find(TOPIC, own.attachment.id))?.state).toBe("pending");
    later();
    expect(await ctx.uploads.cleanup()).toBe(1);
    expect(existsSync(join(ctx.uploadsDir, TOPIC, own.attachment.id))).toBe(false);
    expect(await files(target.folder)).toEqual(["file.png", "meta.json"]);
  });
});
