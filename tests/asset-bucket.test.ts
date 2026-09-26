/**
 * Supabase-Speicherordner aus SUPABASE_ASSETS_BUCKET, Standard tybo-assets
 * (Issue #141, Teil Speicherordner; nötig für die Kandidatenprüfung in #139).
 * Der Supabase-Client spricht mit einer lokalen Attrappe, die nur die Pfade
 * der Anfragen mitschreibt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_ASSETS_BUCKET, assetsBucket, getAssetById, uploadAssetFromBuffer } from "../src/lib/asset-store";
import { resetSupabaseClient } from "../src/lib/supabase";

const KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ASSETS_BUCKET", "CONVEX_URL"] as const;
let saved: Record<string, string | undefined> = {};
let server: ReturnType<typeof Bun.serve>;
let paths: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      paths.push(`${req.method} ${path}`);
      if (path.startsWith("/storage/v1/object/sign/")) return Response.json({ signedURL: `${path}?token=attrappe` });
      if (path.startsWith("/storage/v1/object/")) return Response.json({ Key: path });
      if (path === "/rest/v1/assets") {
        return Response.json({ id: "a1", storage_path: "x", public_url: null, original_filename: "bild.png", file_type: "image", mime_type: "image/png", file_size_bytes: 3, description: "Bild", user_caption: null, conversation_context: null, related_project: null, tags: [], channel: "telegram", metadata: {}, created_at: new Date().toISOString() });
      }
      return new Response("unbekannt", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "attrappe-schluessel";
  paths = [];
  resetSupabaseClient();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetSupabaseClient();
});

const upload = () => uploadAssetFromBuffer(Buffer.from("png"), "bild.png", { description: "Bild", channel: "telegram" } as any);
const storageBuckets = () => paths.filter(p => p.includes("/storage/v1/object/")).map(p => p.replace(/^POST \/storage\/v1\/object\/(sign\/)?/, "").split("/")[0]);

describe("assetsBucket", () => {
  test("Standard tybo-assets, gesetzter Wert gilt, leer und Leerzeichen fallen auf den Standard", () => {
    expect(DEFAULT_ASSETS_BUCKET).toBe("tybo-assets");
    expect(assetsBucket({})).toBe("tybo-assets");
    expect(assetsBucket({ SUPABASE_ASSETS_BUCKET: "" })).toBe("tybo-assets");
    expect(assetsBucket({ SUPABASE_ASSETS_BUCKET: "   " })).toBe("tybo-assets");
    expect(assetsBucket({ SUPABASE_ASSETS_BUCKET: " eigene-bilder " })).toBe("eigene-bilder");
  });
});

describe("Upload über den Supabase-Client (Attrappe)", () => {
  test("ohne SUPABASE_ASSETS_BUCKET: Upload und Links in tybo-assets", async () => {
    expect(await upload()).not.toBeNull();
    expect(storageBuckets().length).toBeGreaterThanOrEqual(2);
    expect(new Set(storageBuckets())).toEqual(new Set(["tybo-assets"]));
  });

  test("mit SUPABASE_ASSETS_BUCKET: Upload und Links in diesem Ordner", async () => {
    process.env.SUPABASE_ASSETS_BUCKET = "eigene-bilder";
    expect(await upload()).not.toBeNull();
    expect(storageBuckets().length).toBeGreaterThanOrEqual(2);
    expect(new Set(storageBuckets())).toEqual(new Set(["eigene-bilder"]));
  });
});

describe("gespeicherte Assets neu signieren (Attrappe)", () => {
  test("ohne SUPABASE_ASSETS_BUCKET: Link aus tybo-assets", async () => {
    const asset = await getAssetById("a1");
    expect(asset?.public_url).toContain("/storage/v1/object/sign/tybo-assets/x");
    expect(storageBuckets()).toEqual(["tybo-assets"]);
  });

  test("mit SUPABASE_ASSETS_BUCKET: Link aus diesem Ordner", async () => {
    process.env.SUPABASE_ASSETS_BUCKET = "eigene-bilder";
    const asset = await getAssetById("a1");
    expect(asset?.public_url).toContain("/storage/v1/object/sign/eigene-bilder/x");
    expect(storageBuckets()).toEqual(["eigene-bilder"]);
  });
});
