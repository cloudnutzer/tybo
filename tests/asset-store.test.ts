/**
 * Issue #318: Bilder und Dateien über getStore().assets (Supabase-Adapter
 * src/lib/store/supabase/assets.ts) und die Schicht src/lib/asset-store.ts.
 *
 * Hält fest: Speicherpfad und Zeile beim Hochladen, public_url wird nie
 * gespeichert, jeder Link wird beim Lesen frisch signiert und gilt 900
 * Sekunden, ein Signierfehler ergibt null statt eines alten Links;
 * Beschreibung mit Vektor samt embedding_model, Rückfall ohne die Spalte,
 * Speichern auch ohne Vektor; Suche mit Sonderzeichen im Suchtext; ohne
 * Datenbank bleibt alles still (null bzw. leer). Kein Netz: supabase-js
 * spricht mit einer lokalen Attrappe.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAssetById, updateAssetDescription, uploadAssetFromBuffer, uploadAssetQuick } from "../src/lib/asset-store";
import { LINK_LIFETIME_SECONDS } from "../src/lib/assets/bucket";
import { getStore, resetStore } from "../src/lib/store";
import { assetEmbeddingText, assetSearchFilter, supabaseAssets } from "../src/lib/store/supabase/assets";
import { getSupabase, resetSupabaseClient } from "../src/lib/supabase";

const VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ASSETS_BUCKET", "OPENAI_API_KEY", "GEMINI_API_KEY", "EMBEDDING_PROVIDER", "EMBEDDING_MODEL"];

interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: unknown;
}

/** Wie die Attrappe auf einzelne Anfragen antwortet */
interface Behaviour {
  uploadFails?: boolean;
  insertFails?: boolean;
  signFails?: boolean;
  selectFails?: boolean;
  /** Erstes PATCH scheitert mit diesem Code */
  patchCode?: string;
  rows: Record<string, unknown>[];
}

let server: ReturnType<typeof Bun.serve>;
let calls: Call[];
let behaviour: Behaviour;
let saved: Record<string, string | undefined>;
let patches = 0;

function row(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    created_at: "2026-10-17T10:00:00.000Z",
    storage_path: `images/2026-10-17/${id}.png`,
    public_url: "https://alt.example/abgelaufen",
    original_filename: `${id}.png`,
    file_type: "image",
    mime_type: "image/png",
    file_size_bytes: 3,
    description: "Bild",
    user_caption: null,
    conversation_context: null,
    related_project: null,
    tags: [],
    channel: "telegram",
    metadata: {},
    ...extra,
  };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      calls.push({ method: req.method, path: decodeURIComponent(url.pathname), params: url.searchParams, body });
      const path = url.pathname;
      if (path.startsWith("/storage/v1/object/sign/")) {
        if (behaviour.signFails) return Response.json({ statusCode: "500", error: "kaputt", message: "kaputt" }, { status: 500 });
        return Response.json({ signedURL: `${path.replace("/storage/v1", "")}?token=frisch` });
      }
      if (path.startsWith("/storage/v1/object/")) {
        if (behaviour.uploadFails) return Response.json({ statusCode: "400", error: "voll", message: "voll" }, { status: 400 });
        return Response.json({ Key: path, Id: "k1" });
      }
      if (path === "/rest/v1/assets") {
        const single = (req.headers.get("accept") ?? "").includes("vnd.pgrst.object");
        if (req.method === "POST") {
          if (behaviour.insertFails) return Response.json({ code: "23502", message: "fehlt" }, { status: 400 });
          const inserted = { ...row("neu"), ...(body as Record<string, unknown>), id: "neu" };
          return Response.json(single ? inserted : [inserted], { status: 201 });
        }
        if (req.method === "PATCH") {
          patches++;
          if (behaviour.patchCode && patches === 1) return Response.json({ code: behaviour.patchCode, message: "Spalte fehlt" }, { status: 400 });
          return new Response(null, { status: 204 });
        }
        if (behaviour.selectFails) return Response.json({ code: "XX000", message: "kaputt" }, { status: 500 });
        let found = [...behaviour.rows];
        const id = url.searchParams.get("id");
        if (id?.startsWith("eq.")) found = found.filter(r => r.id === id.slice(3));
        const kind = url.searchParams.get("file_type");
        if (kind?.startsWith("eq.")) found = found.filter(r => r.file_type === kind.slice(3));
        found = found.slice(0, Number(url.searchParams.get("limit") ?? 1000));
        if (single) return found[0] ? Response.json(found[0]) : Response.json({ code: "PGRST116", message: "keine Zeile" }, { status: 406 });
        return Response.json(found);
      }
      return new Response("unbekannt", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

beforeEach(() => {
  saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "attrappe-schluessel";
  calls = [];
  patches = 0;
  behaviour = { rows: [] };
  resetSupabaseClient();
  resetStore();
});
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetSupabaseClient();
  resetStore();
});

const VECTOR = { vector: [0.1, 0.2], config: { provider: "openai" as const, model: "text-embedding-3-small" } };

function adapter(embed: (text: string) => Promise<typeof VECTOR | null> = async () => null) {
  return supabaseAssets(getSupabase, {
    embed,
    now: () => new Date("2026-10-17T12:00:00.000Z"),
    uuid: () => "u-1",
  });
}

const signCalls = () => calls.filter(c => c.path.startsWith("/storage/v1/object/sign/"));
const restCalls = (method: string) => calls.filter(c => c.path === "/rest/v1/assets" && c.method === method);

describe("Hochladen", () => {
  test("Pfad <art>s/<Tag>/<UUID><Endung>, Zeile ohne gespeicherten Link, Antwort mit frischem Link", async () => {
    const asset = await adapter().upload({
      data: new Uint8Array([1, 2, 3]),
      filename: "Urlaub am Meer.PNG",
      description: "Strand",
      userCaption: "schau mal",
      metadata: { telegramFileId: "f-1" },
    });
    const upload = calls.find(c => c.path.startsWith("/storage/v1/object/") && !c.path.includes("/sign/"));
    expect(upload?.path).toBe("/storage/v1/object/tybo-assets/images/2026-10-17/u-1.PNG");
    const [insert] = restCalls("POST");
    expect(insert.body).toMatchObject({
      storage_path: "images/2026-10-17/u-1.PNG",
      public_url: null,
      original_filename: "Urlaub am Meer.PNG",
      file_type: "image",
      mime_type: "image/png",
      file_size_bytes: 3,
      description: "Strand",
      user_caption: "schau mal",
      conversation_context: null,
      related_project: null,
      tags: [],
      channel: "telegram",
      metadata: { telegramFileId: "f-1" },
    });
    expect(signCalls()).toHaveLength(1);
    expect(signCalls()[0].body).toEqual({ expiresIn: 900 });
    expect(asset?.public_url).toContain("/object/sign/tybo-assets/images/2026-10-17/u-1.PNG?token=frisch");
  });

  test("Art und MIME-Typ: Angabe gewinnt, sonst aus der Endung, sonst document", async () => {
    await adapter().upload({ data: new Uint8Array([1]), filename: "notiz.ogg", description: "x" });
    await adapter().upload({ data: new Uint8Array([1]), filename: "plan.pdf", description: "x" });
    await adapter().upload({ data: new Uint8Array([1]), filename: "ohne-endung", description: "x" });
    await adapter().upload({ data: new Uint8Array([1]), filename: "x.bin", description: "x", fileType: "image", mimeType: "image/webp", channel: "web" });
    const rows = restCalls("POST").map(c => c.body as Record<string, unknown>);
    expect(rows.map(r => [r.file_type, r.mime_type, r.storage_path, r.channel])).toEqual([
      ["audio", "audio/ogg", "audios/2026-10-17/u-1.ogg", "telegram"],
      ["document", "application/pdf", "documents/2026-10-17/u-1.pdf", "telegram"],
      ["document", "application/octet-stream", "documents/2026-10-17/u-1", "telegram"],
      ["image", "image/webp", "images/2026-10-17/u-1.bin", "web"],
    ]);
  });

  test("Endung im Pfad nur aus Buchstaben und Ziffern", async () => {
    await adapter().upload({ data: new Uint8Array([1]), filename: "../geheim.d/n g", description: "x" });
    await adapter().upload({ data: new Uint8Array([1]), filename: "böse bild.p n g", description: "x" });
    await adapter().upload({ data: new Uint8Array([1]), filename: "a.j$p%g", description: "x" });
    expect(restCalls("POST").map(c => (c.body as Record<string, unknown>).storage_path)).toEqual([
      "documents/2026-10-17/u-1",
      "documents/2026-10-17/u-1.png",
      "documents/2026-10-17/u-1.jpg",
    ]);
  });

  test("Speicherordner aus SUPABASE_ASSETS_BUCKET, bei jedem Zugriff neu gelesen", async () => {
    const store = adapter();
    process.env.SUPABASE_ASSETS_BUCKET = "eigene-bilder";
    await store.upload({ data: new Uint8Array([1]), filename: "a.png", description: "x" });
    expect(calls.filter(c => c.path.startsWith("/storage/")).every(c => c.path.includes("/eigene-bilder/"))).toBe(true);
  });

  test("Hochladen scheitert: null, keine Zeile", async () => {
    behaviour.uploadFails = true;
    expect(await adapter().upload({ data: new Uint8Array([1]), filename: "a.png", description: "x" })).toBeNull();
    expect(restCalls("POST")).toEqual([]);
  });

  test("Zeile scheitert: null, kein Link", async () => {
    behaviour.insertFails = true;
    expect(await adapter().upload({ data: new Uint8Array([1]), filename: "a.png", description: "x" })).toBeNull();
    expect(signCalls()).toEqual([]);
  });
});

describe("Links beim Lesen frisch signiert (900 Sekunden)", () => {
  test("Laufzeit ist 900 Sekunden", () => {
    expect(LINK_LIFETIME_SECONDS).toBe(900);
  });

  test("byId, recent und search signieren je Bild neu, der gespeicherte Link zählt nie", async () => {
    behaviour.rows = [row("a1", { description: "Hund am Strand" }), row("a2", { description: "Hund im Schnee" })];
    const store = adapter();
    const one = await store.byId("a1");
    const recent = await store.recent(5);
    const found = await store.search("Hund", 5);
    for (const asset of [one, ...recent, ...found]) {
      expect(asset?.public_url).toContain("?token=frisch");
      expect(asset?.public_url).not.toContain("alt.example");
    }
    expect(signCalls()).toHaveLength(5);
    expect(signCalls().every(c => (c.body as { expiresIn: number }).expiresIn === 900)).toBe(true);
  });

  test("Signieren scheitert: public_url null statt alter Link", async () => {
    behaviour.rows = [row("a1")];
    behaviour.signFails = true;
    const store = adapter();
    expect((await store.byId("a1"))?.public_url).toBeNull();
    expect((await store.recent(5))[0].public_url).toBeNull();
    const uploaded = await store.upload({ data: new Uint8Array([1]), filename: "a.png", description: "x" });
    expect(uploaded?.id).toBe("neu");
    expect(uploaded?.public_url).toBeNull();
  });

  test("byId ohne Treffer: null", async () => {
    expect(await adapter().byId("fehlt")).toBeNull();
  });

  test("Lesen holt den Vektor nicht mit", async () => {
    behaviour.rows = [row("a1")];
    await adapter().recent(1);
    const select = restCalls("GET")[0].params.get("select") ?? "";
    expect(select).toContain("storage_path");
    expect(select).not.toContain("embedding");
  });
});

describe("Letzte Bilder", () => {
  test("neueste zuerst, Grenze und Art als Filter", async () => {
    behaviour.rows = [row("a1"), row("d1", { file_type: "document" })];
    const images = await adapter().recent(3, "image");
    expect(images.map(a => a.id)).toEqual(["a1"]);
    const [get] = restCalls("GET");
    expect(get.params.get("order")).toBe("created_at.desc");
    expect(get.params.get("limit")).toBe("3");
    expect(get.params.get("file_type")).toBe("eq.image");
  });
});

describe("Suche", () => {
  test("Wörter in Beschreibung oder Schlagwörtern, neueste zuerst, Grenze", async () => {
    behaviour.rows = [row("a1")];
    await adapter().search("Hund am Strand", 4);
    const [get] = restCalls("GET");
    expect(get.params.get("or")).toBe("(description.ilike.%Hund%,tags.cs.{Hund},description.ilike.%am%,tags.cs.{am},description.ilike.%Strand%,tags.cs.{Strand})");
    expect(get.params.get("order")).toBe("created_at.desc");
    expect(get.params.get("limit")).toBe("4");
  });

  test("Sonderzeichen im Suchtext landen nie im Filter", async () => {
    const nasty = 'Heiz,kessel (rot) "alt" 50%_off a\\b ä*';
    const filter = assetSearchFilter(["Heiz", "kessel"]);
    expect(filter).toBe("description.ilike.%Heiz%,tags.cs.{Heiz},description.ilike.%kessel%,tags.cs.{kessel}");
    await adapter().search(nasty, 5);
    const or = restCalls("GET")[0].params.get("or") ?? "";
    const inner = or.slice(1, -1);
    for (const part of inner.split(",")) expect(part).toMatch(/^(description\.ilike\.%[\p{L}\p{M}\p{N}]+%|tags\.cs\.\{[\p{L}\p{M}\p{N}]+\})$/u);
    expect(inner).toContain("description.ilike.%Heiz%");
    expect(inner).toContain("description.ilike.%rot%");
    expect(inner).not.toMatch(/["()\\*]/);
  });

  test("ohne Suchwort keine Anfrage und leer", async () => {
    expect(await adapter().search(' ,()"%_\\ x ', 5)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("Fehler der Datenbank: leer", async () => {
    behaviour.rows = [row("a1", { description: "Hund" })];
    behaviour.selectFails = true;
    expect(await adapter().search("Hund", 5)).toEqual([]);
    expect(await adapter().recent(5)).toEqual([]);
    expect(await adapter().byId("a1")).toBeNull();
    expect(signCalls()).toEqual([]);
  });
});

describe("Beschreibung setzen", () => {
  test("mit Vektor: Beschreibung, Schlagwörter, Projekt, embedding und embedding_model", async () => {
    const texts: string[] = [];
    await adapter(async text => {
      texts.push(text);
      return VECTOR;
    }).setDescription("a1", "Hund am Strand", ["hund", "strand"], "Urlaub");
    expect(texts).toEqual(["Hund am Strand hund strand"]);
    const [patch] = restCalls("PATCH");
    expect(patch.params.get("id")).toBe("eq.a1");
    expect(patch.body).toEqual({
      description: "Hund am Strand",
      tags: ["hund", "strand"],
      related_project: "Urlaub",
      embedding: [0.1, 0.2],
      embedding_model: "openai:text-embedding-3-small",
    });
  });

  test("Text für den Vektor wie in der Neuberechnung", () => {
    expect(assetEmbeddingText("Bild", [])).toBe("Bild ");
    expect(assetEmbeddingText("Bild")).toBe("Bild ");
    expect(assetEmbeddingText("Bild", ["a", "b"])).toBe("Bild a b");
  });

  test("ohne Vektor: nur die Beschreibung, leere Schlagwörter ändern nichts", async () => {
    await adapter(async () => null).setDescription("a1", "Nur Text", []);
    expect(restCalls("PATCH").map(c => c.body)).toEqual([{ description: "Nur Text" }]);
  });

  test("Vektor scheitert mit Ausnahme: Beschreibung trotzdem gespeichert", async () => {
    await adapter(async () => {
      throw new Error("Anbieter weg");
    }).setDescription("a1", "Trotzdem");
    expect(restCalls("PATCH").map(c => c.body)).toEqual([{ description: "Trotzdem" }]);
  });

  test("Datenbank ohne Spalte embedding_model: zweiter Versuch ohne sie", async () => {
    behaviour.patchCode = "PGRST204";
    await adapter(async () => VECTOR).setDescription("a1", "Alt", ["x"]);
    const bodies = restCalls("PATCH").map(c => c.body as Record<string, unknown>);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].embedding_model).toBe("openai:text-embedding-3-small");
    expect(bodies[1]).toEqual({ description: "Alt", tags: ["x"], embedding: [0.1, 0.2] });
  });

  test("anderer Fehler: kein zweiter Versuch, keine Ausnahme", async () => {
    behaviour.patchCode = "42501";
    await expect(adapter(async () => VECTOR).setDescription("a1", "x")).resolves.toBeUndefined();
    expect(restCalls("PATCH")).toHaveLength(1);
  });
});

describe("ohne Client", () => {
  test("null bzw. leer, keine Anfrage", async () => {
    const store = supabaseAssets(() => null);
    expect(await store.upload({ data: new Uint8Array([1]), filename: "a.png", description: "x" })).toBeNull();
    expect(await store.byId("a1")).toBeNull();
    expect(await store.recent(5)).toEqual([]);
    expect(await store.search("Hund", 5)).toEqual([]);
    await expect(store.setDescription("a1", "x")).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("Schicht asset-store.ts über getStore().assets", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tybo-assets-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("unter Supabase ist der Store-Teil gebaut", async () => {
    behaviour.rows = [row("a1")];
    expect(getStore().backend).toBe("supabase");
    expect((await getStore().assets.byId("a1"))?.id).toBe("a1");
    expect((await getAssetById("a1"))?.public_url).toContain("?token=frisch");
  });

  test("uploadAssetFromBuffer: vorgeschlagenes Projekt vor relatedProject, Telegram-Datei-ID in metadata", async () => {
    await uploadAssetFromBuffer(Buffer.from("png"), "bild.png", {
      description: "Bild",
      tags: ["a"],
      suggestedProject: "Haus",
      relatedProject: "Garten",
      telegramFileId: "f-9",
      channel: "telegram",
    });
    expect(restCalls("POST")[0].body).toMatchObject({ related_project: "Haus", tags: ["a"], metadata: { telegramFileId: "f-9" }, description: "Bild" });
  });

  test("uploadAssetQuick: Datei von der Platte, Beschreibung erst Bildtext, sonst Platzhalter", async () => {
    const file = join(dir, "photo_1.jpg");
    await writeFile(file, new Uint8Array([9, 9]));
    await uploadAssetQuick(file, { userCaption: "Mein Garten", channel: "web", originalFilename: "Garten.jpg", fileType: "image", mimeType: "image/jpeg" });
    await uploadAssetQuick(file, { channel: "telegram" });
    const rows = restCalls("POST").map(c => c.body as Record<string, unknown>);
    expect(rows[0]).toMatchObject({ description: "Mein Garten", original_filename: "Garten.jpg", channel: "web", file_size_bytes: 2, tags: [], related_project: null });
    expect(rows[1]).toMatchObject({ description: "Image (pending description)", original_filename: "photo_1.jpg" });
    expect(await uploadAssetQuick(join(dir, "fehlt.jpg"), {})).toBeNull();
  });

  test("updateAssetDescription geht an setDescription", async () => {
    await updateAssetDescription("a7", "Neu", ["t"]);
    expect(restCalls("PATCH")[0].body).toMatchObject({ description: "Neu", tags: ["t"] });
  });

  test("ohne Datenbank: still null, kein Wurf, keine Anfrage (Medien-Turn läuft weiter)", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetSupabaseClient();
    resetStore();
    expect(getStore().backend).toBe("file");
    expect(await uploadAssetFromBuffer(Buffer.from("x"), "a.png", { description: "x" })).toBeNull();
    expect(await getAssetById("a1")).toBeNull();
    await expect(updateAssetDescription("a1", "x")).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});
