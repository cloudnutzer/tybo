// Upload und Download von Anhängen (Issue #72, Schritt 1):
// POST /api/conversations/<id>/attachments nimmt eine Datei als Rohdaten an,
// prüft Art und Größe allein aus den Bytes (Medien-Kern) und legt sie unter
// data/uploads/<Gespräch>/<ID>/ ab; GET .../attachments/<ID> liefert sie nur
// angemeldet und nur im eigenen Gespräch aus.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_LIMITS } from "../src/web/media-check";
import { parseAttachmentName } from "../src/web/attachments";
import { SECURITY_HEADERS, type WebServer } from "../src/web/server";
import { MAX_PENDING_PER_CONVERSATION } from "../src/web/uploads";
import { CLOSED_TOPIC, TOPIC, makeRoot, startAttachmentServer } from "./attachments-fixture";
import { OGG_OPUS, PDF, PNG, SVG, bytes, padTo } from "./media-fixture";

const root = await makeRoot("tybo-web-attach-up-");
afterAll(() => root.cleanup());
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

const start = (options: { uploads?: false } = {}) => startAttachmentServer({ dir: root.next(), servers, ...options });

describe("Upload", () => {
  test("PNG wird angenommen: Antwort mit id, name, size, mime, kind; Datei und Zustand in der Ablage", async () => {
    const ctx = await start();
    const res = await ctx.upload(TOPIC, PNG, { "x-file-name": encodeURIComponent("Übersicht März.png") });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["id", "kind", "mime", "name", "size"]);
    expect(body).toMatchObject({ name: "Übersicht März.png", size: PNG.length, mime: "image/png", kind: "image" });
    const folder = join(ctx.uploadsDir, TOPIC, body.id);
    expect((await readdir(folder)).sort()).toEqual(["file.png", "meta.json"]);
    expect(new Uint8Array(await readFile(join(folder, "file.png")))).toEqual(PNG);
    const meta = JSON.parse(await readFile(join(folder, "meta.json"), "utf8"));
    expect(meta).toMatchObject({ id: body.id, conversationId: TOPIC, state: "pending", ext: "png" });
    for (const k of Object.keys(SECURITY_HEADERS)) expect(res.headers.get(k)).toBe(SECURITY_HEADERS[k]);
  });

  test("Art und MIME-Typ nur aus den Bytes, nie aus Content-Type oder Name", async () => {
    const ctx = await start();
    const pdf = await (await ctx.upload(TOPIC, PDF, { "content-type": "image/png", "x-file-name": "bild.png" })).json();
    expect(pdf).toMatchObject({ kind: "document", mime: "application/pdf", name: "bild.png" });
    const ogg = await (await ctx.upload("dm", OGG_OPUS, { "content-type": "text/html" })).json();
    expect(ogg).toMatchObject({ kind: "audio", mime: "audio/ogg", name: "sprachdatei.ogg" });
    const png = await (await ctx.upload(TOPIC, PNG)).json();
    expect(png.name).toBe("bild.png");
  });

  test("SVG, HTML und Unbekanntes: 415; leere Datei: 400; nichts abgelegt", async () => {
    const ctx = await start();
    for (const body of [SVG, bytes("<!doctype html><script>alert(1)</script>"), bytes("hallo")]) {
      const res = await ctx.upload(TOPIC, body, { "content-type": "image/svg+xml", "x-file-name": "a.svg" });
      expect(res.status).toBe(415);
      expect((await res.json()).error).toContain("Dateityp nicht erlaubt");
    }
    const empty = await ctx.upload(TOPIC, new Uint8Array(0));
    expect(empty.status).toBe(400);
    expect(await readdir(ctx.uploadsDir).catch(() => [])).toEqual([]);
  });

  test("Grenzen aus dem Medien-Kern: Bild über 20 MB 413, Sprachdatei bis 25 MB erlaubt, über 25 MB 413", async () => {
    const ctx = await start();
    const bigImage = await ctx.upload(TOPIC, padTo(PNG, MEDIA_LIMITS.image + 1));
    expect(bigImage.status).toBe(413);
    expect((await bigImage.json()).error).toBe("Datei zu groß: Bild höchstens 20 MB.");
    const okImage = await ctx.upload(TOPIC, padTo(PNG, MEDIA_LIMITS.image));
    expect(okImage.status).toBe(201);
    const audio = await ctx.upload(TOPIC, padTo(OGG_OPUS, MEDIA_LIMITS.audio));
    expect(audio.status).toBe(201);
    const tooBig = await ctx.upload(TOPIC, padTo(OGG_OPUS, MEDIA_LIMITS.audio + 1));
    expect(tooBig.status).toBe(413);
    // Ohne Content-Length (gestreamt) greift die Grenze beim Lesen
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 26; i++) c.enqueue(new Uint8Array(1_048_576).fill(i === 0 ? 0x25 : 0));
        c.close();
      },
    });
    const streamed = await fetch(`${ctx.origin}/api/conversations/${TOPIC}/attachments`, {
      method: "POST",
      headers: { origin: ctx.origin, cookie: ctx.cookie },
      body: stream,
      // @ts-expect-error Bun/Node: gestreamter Body
      duplex: "half",
    });
    expect(streamed.status).toBe(413);
  });

  test("ohne Anmeldung 401, fremder Origin 403, nichts abgelegt", async () => {
    const ctx = await start();
    const anon = await fetch(`${ctx.origin}/api/conversations/${TOPIC}/attachments`, {
      method: "POST",
      headers: { origin: ctx.origin },
      body: PNG,
    });
    expect(anon.status).toBe(401);
    const foreign = await fetch(`${ctx.origin}/api/conversations/${TOPIC}/attachments`, {
      method: "POST",
      headers: { origin: "http://evil.example", cookie: ctx.cookie },
      body: PNG,
    });
    expect(foreign.status).toBe(403);
    const noOrigin = await fetch(`${ctx.origin}/api/conversations/${TOPIC}/attachments`, {
      method: "POST",
      headers: { cookie: ctx.cookie },
      body: PNG,
    });
    expect(noOrigin.status).toBe(403);
    expect(await readdir(ctx.uploadsDir).catch(() => [])).toEqual([]);
    // Danach geht es mit Anmeldung auf derselben Verbindung weiter
    expect((await ctx.upload(TOPIC, PNG)).status).toBe(201);
  });

  test("unbekanntes Gespräch 404, Web-Gespräch 201 (Issue #112), geschlossenes Topic 409, ohne Ablage 503", async () => {
    const ctx = await start();
    expect((await ctx.upload("topic-999", PNG)).status).toBe(404);
    expect((await ctx.upload("..%2F..%2Fetc", PNG)).status).toBe(404);
    const web = await ctx.upload(ctx.webConversationId, PNG);
    expect(web.status).toBe(201);
    expect((await ctx.upload(crypto.randomUUID(), PNG)).status).toBe(404);
    const closed = await ctx.upload(CLOSED_TOPIC, PNG);
    expect(closed.status).toBe(409);
    const none = await start({ uploads: false });
    expect((await none.upload(TOPIC, PNG)).status).toBe(503);
  });

  test("Dateiname: prozentkodiert, ohne Pfad und Steuerzeichen, höchstens 120 Zeichen; ungültige Kodierung 400", async () => {
    expect(parseAttachmentName(encodeURIComponent("../../etc/passwd.png"))).toBe("passwd.png");
    expect(parseAttachmentName(encodeURIComponent("C:\\Users\\x\\Bild.png"))).toBe("Bild.png");
    expect(parseAttachmentName(encodeURIComponent("a\u0000b\u202Egnp.exe\nc.png"))).toBe("abgnp.exec.png");
    expect(parseAttachmentName(encodeURIComponent("  viel   Platz  .png "))).toBe("viel Platz .png");
    expect([...parseAttachmentName(encodeURIComponent("ä".repeat(200)))!].length).toBe(120);
    expect(parseAttachmentName(encodeURIComponent("/"))).toBeUndefined();
    expect(parseAttachmentName(null)).toBeUndefined();
    expect(parseAttachmentName("%E0%A4%A")).toBeNull();
    const ctx = await start();
    expect((await ctx.upload(TOPIC, PNG, { "x-file-name": "%E0%A4%A" })).status).toBe(400);
    const slash = await (await ctx.upload(TOPIC, PNG, { "x-file-name": encodeURIComponent("/") })).json();
    expect(slash.name).toBe("bild.png");
  });

  test(`höchstens ${MAX_PENDING_PER_CONVERSATION} nicht abgeschickte Anhänge je Gespräch (409), andere Gespräche unberührt`, async () => {
    const ctx = await start();
    for (let i = 0; i < MAX_PENDING_PER_CONVERSATION; i++) expect((await ctx.upload(TOPIC, PNG)).status).toBe(201);
    const over = await ctx.upload(TOPIC, PNG);
    expect(over.status).toBe(409);
    expect((await ctx.upload("dm", PNG)).status).toBe(201);
  });

  test("GET auf die Upload-Adresse: 405", async () => {
    const ctx = await start();
    const res = await ctx.api(`/api/conversations/${TOPIC}/attachments`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("Download", () => {
  test("nur angemeldet: Datei als Anhang mit Namen und nosniff; ohne Anmeldung 401", async () => {
    const ctx = await start();
    const { id } = await (await ctx.upload(TOPIC, PDF, { "x-file-name": encodeURIComponent("Bericht Ä.pdf") })).json();
    const res = await ctx.api(`/api/conversations/${TOPIC}/attachments/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="Bericht A.pdf"; filename*=UTF-8''Bericht%20%C3%84.pdf`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    const anon = await ctx.api(`/api/conversations/${TOPIC}/attachments/${id}`, { cookie: null });
    expect(anon.status).toBe(401);
  });

  test("Vorschau mit ?inline=1 nur für Bilder; PDF bleibt Anhang", async () => {
    const ctx = await start();
    const png = await (await ctx.upload(TOPIC, PNG)).json();
    const pdf = await (await ctx.upload(TOPIC, PDF)).json();
    const img = await ctx.api(`/api/conversations/${TOPIC}/attachments/${png.id}?inline=1`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-disposition")!.startsWith("inline;")).toBe(true);
    const doc = await ctx.api(`/api/conversations/${TOPIC}/attachments/${pdf.id}?inline=1`);
    expect(doc.headers.get("content-type")).toBe("application/octet-stream");
    expect(doc.headers.get("content-disposition")!.startsWith("attachment;")).toBe(true);
  });

  test("anderes Gespräch, unbekannte, ungültige ID und Pfadtricks: 404", async () => {
    const ctx = await start();
    const { id } = await (await ctx.upload(TOPIC, PNG)).json();
    expect((await ctx.api(`/api/conversations/dm/attachments/${id}`)).status).toBe(404);
    expect((await ctx.api(`/api/conversations/${TOPIC}/attachments/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await ctx.api(`/api/conversations/${TOPIC}/attachments/meta.json`)).status).toBe(404);
    expect((await ctx.api(`/api/conversations/${TOPIC}/attachments/..%2F..%2Fweb-sessions.json`)).status).toBe(404);
    expect((await ctx.api(`/api/conversations/topic-999/attachments/${id}`)).status).toBe(404);
    const post = await ctx.api(`/api/conversations/${TOPIC}/attachments/${id}`, { method: "POST", body: {} });
    expect(post.status).toBe(405);
  });
});
