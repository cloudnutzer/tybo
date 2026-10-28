/**
 * Issue #318: Bildsuche in history_search. Der registrierte Handler sucht
 * gegen eine Supabase-Attrappe (Bilder mit frisch signiertem Link, auch
 * ohne Telegram), der Handler aus createHistorySearchHandler mit
 * eingesetzten Quellen prüft Grenze, leere Ergebnisse und dass ein Fehler
 * der Bildsuche die Nachrichten- und Wissenssuche nicht mitreißt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resetCredentialCacheForTests } from "../src/lib/credentials";
import { resetStore } from "../src/lib/store";
import type { Asset, Message } from "../src/lib/store/types";
import { resetSupabaseClient } from "../src/lib/supabase";
import { createHistorySearchHandler, type HistorySearchDeps } from "../src/lib/tools/history-search";
import { getBuiltinTool } from "../src/lib/tools/registry";

const VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ASSETS_BUCKET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID", "OPENAI_API_KEY", "GEMINI_API_KEY", "EMBEDDING_PROVIDER"];

function asset(id: string, description: string, extra: Partial<Asset> = {}): Asset {
  return {
    id,
    created_at: "2026-10-17T09:30:00.000Z",
    storage_path: `images/2026-10-17/${id}.jpg`,
    public_url: null,
    original_filename: `${id}.jpg`,
    file_type: "image",
    mime_type: "image/jpeg",
    file_size_bytes: 10,
    description,
    user_caption: null,
    conversation_context: null,
    related_project: null,
    tags: [],
    channel: "telegram",
    metadata: {},
    ...extra,
  };
}

let server: ReturnType<typeof Bun.serve>;
let saved: Record<string, string | undefined>;
let assetRows: Asset[];
let assetQueries: URLSearchParams[];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/storage/v1/object/sign/")) {
        return Response.json({ signedURL: `${url.pathname.replace("/storage/v1", "")}?token=frisch` });
      }
      if (url.pathname === "/rest/v1/assets") {
        assetQueries.push(url.searchParams);
        return Response.json(assetRows.slice(0, Number(url.searchParams.get("limit") ?? 100)));
      }
      // Nachrichten, Edge Functions und Wissen: nichts gefunden
      if (url.pathname.startsWith("/rest/v1/")) return Response.json([]);
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
  assetRows = [];
  assetQueries = [];
  resetCredentialCacheForTests();
  resetSupabaseClient();
  resetStore();
});
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetCredentialCacheForTests();
  resetSupabaseClient();
  resetStore();
});

describe("registrierter history_search-Handler mit Bildern", () => {
  test("ohne Telegram verfügbar (Entscheidung 0021)", () => {
    const tool = getBuiltinTool("history_search")!;
    expect(tool.isAvailable?.() ?? true).toBe(true);
  });

  test("Bildtreffer mit ID, Beschreibung und frisch signiertem Link; kein Hinweis „Keine Treffer“", async () => {
    assetRows = [asset("bild-1", "Heizkessel im Keller", { tags: ["heizung"], user_caption: "unser Kessel" })];
    const raw = await getBuiltinTool("history_search")!.handler({ query: "Heizkessel", limit: 3 });
    const out = JSON.parse(raw);
    expect(out.messages).toEqual([]);
    expect(out.images).toEqual([
      {
        id: "bild-1",
        date: "2026-10-17T09:30",
        type: "image",
        description: "Heizkessel im Keller",
        tags: ["heizung"],
        caption: "unser Kessel",
        link: expect.stringContaining("/object/sign/tybo-assets/images/2026-10-17/bild-1.jpg?token=frisch"),
      },
    ]);
    expect(out.image_links_valid_minutes).toBe(15);
    expect(out.hint).toBeUndefined();
    expect(assetQueries[0].get("limit")).toBe("3");
    expect(assetQueries[0].get("or")).toContain("description.ilike.%Heizkessel%");
  });

  test("nichts gefunden: Hinweis, keine Bilder", async () => {
    const out = JSON.parse(await getBuiltinTool("history_search")!.handler({ query: "Nichts" }));
    expect(out.images).toBeUndefined();
    expect(out.hint).toContain("Keine Treffer");
  });

  test("Suchtext mit Sonderzeichen: Anfrage nur mit Wörtern", async () => {
    await getBuiltinTool("history_search")!.handler({ query: 'Kessel, (rot) "alt" 50%_x \\ y' });
    const or = assetQueries[0].get("or") ?? "";
    expect(or.slice(1, -1)).not.toMatch(/["()\\]/);
    expect(or).toContain("description.ilike.%Kessel%");
  });
});

describe("createHistorySearchHandler", () => {
  const message = (content: string, created_at: string): Message => ({ chat_id: "1", role: "user", content, created_at });

  function deps(overrides: Partial<HistorySearchDeps> = {}): HistorySearchDeps {
    return {
      chatIds: () => ["web"],
      searchMessages: async () => [],
      knowledgeContext: async () => "",
      searchImages: async () => [],
      ...overrides,
    };
  }

  test("Grenze gilt auch für Bilder, Vorgabe 5, höchstens 15", async () => {
    const limits: number[] = [];
    const many = Array.from({ length: 20 }, (_, i) => asset(`b${i}`, `Bild ${i}`));
    const handler = createHistorySearchHandler(
      deps({
        searchImages: async (_q, limit) => {
          limits.push(limit);
          return many;
        },
      }),
    );
    expect(JSON.parse(await handler({ query: "Bild", limit: 2 })).images).toHaveLength(2);
    expect(JSON.parse(await handler({ query: "Bild" })).images).toHaveLength(5);
    expect(JSON.parse(await handler({ query: "Bild", limit: 99 })).images).toHaveLength(15);
    expect(limits).toEqual([2, 5, 15]);
  });

  test("Bildsuche scheitert: Nachrichten und Wissen kommen trotzdem", async () => {
    const handler = createHistorySearchHandler(
      deps({
        searchMessages: async () => [message("Kessel getauscht", "2026-10-16T08:00:00.000Z")],
        knowledgeContext: async () => "**Knowledge Base:**\n- Heizung",
        searchImages: async () => {
          throw new Error("Speicher weg");
        },
      }),
    );
    const out = JSON.parse(await handler({ query: "Kessel" }));
    expect(out.messages.map((m: { text: string }) => m.text)).toEqual(["Kessel getauscht"]);
    expect(out.knowledge_base).toContain("Heizung");
    expect(out.images).toBeUndefined();
    expect(out.hint).toBeUndefined();
  });

  test("Bildsuche wirft synchron: ebenfalls isoliert", async () => {
    const handler = createHistorySearchHandler(
      deps({
        searchMessages: async () => [message("Hallo", "2026-10-16T08:00:00.000Z")],
        searchImages: () => {
          throw new Error("sofort");
        },
      }),
    );
    expect(JSON.parse(await handler({ query: "Hallo" })).messages).toHaveLength(1);
  });

  test("nur Bildtreffer: kein Hinweis „Keine Treffer“", async () => {
    const handler = createHistorySearchHandler(deps({ searchImages: async () => [asset("b1", "Hund")] }));
    const out = JSON.parse(await handler({ query: "Hund" }));
    expect(out.images.map((i: { id: string }) => i.id)).toEqual(["b1"]);
    expect(out.hint).toBeUndefined();
  });

  test("Bild ohne Link: kein Link, keine Laufzeitangabe", async () => {
    const handler = createHistorySearchHandler(deps({ searchImages: async () => [asset("b1", "Hund")] }));
    const out = JSON.parse(await handler({ query: "Hund" }));
    expect(out.images[0].link).toBeUndefined();
    expect(out.image_links_valid_minutes).toBeUndefined();
  });

  test("leere Anfrage: Fehler, keine Suche", async () => {
    let searched = false;
    const handler = createHistorySearchHandler(
      deps({
        searchImages: async () => {
          searched = true;
          return [];
        },
      }),
    );
    expect(JSON.parse(await handler({ query: "  " }))).toEqual({ error: "query fehlt" });
    expect(searched).toBe(false);
  });
});
