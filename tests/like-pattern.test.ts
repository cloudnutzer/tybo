/**
 * Issue #310: Maskierung des Suchtexts für LIKE/ILIKE
 * (supabase/functions/_shared/like-pattern.ts) und ihr Einsatz im
 * Textrückfall der Edge Function search-memory. Die Function läuft in Bun
 * mit nachgebildetem Deno (env, serve) und einer createClient-Attrappe statt
 * esm.sh, die jede Abfrage mitschreibt.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "path";
import { containsPattern, escapeLikePattern } from "../supabase/functions/_shared/like-pattern";
import { clearRegistryCache } from "../supabase/functions/_shared/embedding";

describe("escapeLikePattern", () => {
  test("Text ohne Sonderzeichen bleibt unverändert", () => {
    for (const text of ["", "Urlaub im Herbst", "Ärger über *Sterne* und $Preise", "a.b-c(d)"]) {
      expect(escapeLikePattern(text)).toBe(text);
    }
  });

  test("Prozent, Unterstrich und Backslash bekommen je einen Backslash davor", () => {
    expect(escapeLikePattern("50%")).toBe("50\\%");
    expect(escapeLikePattern("mein_datei")).toBe("mein\\_datei");
    expect(escapeLikePattern("C:\\tmp")).toBe("C:\\\\tmp");
  });

  test("Kombinationen: jedes Zeichen genau einmal maskiert, Backslash vor Prozent nicht doppelt", () => {
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
    expect(escapeLikePattern("%_\\")).toBe("\\%\\_\\\\");
    expect(escapeLikePattern("__%%")).toBe("\\_\\_\\%\\%");
    expect(escapeLikePattern("a\\_b%c")).toBe("a\\\\\\_b\\%c");
  });

  test("containsPattern: Platzhalter nur außen", () => {
    expect(containsPattern("Issue")).toBe("%Issue%");
    expect(containsPattern("10%_x\\")).toBe("%10\\%\\_x\\\\%");
  });
});

// --- search-memory mit Attrappen ---------------------------------------------

const SERVICE_KEY = "attrappe-service-key";
const FUNCTION_FILE = join(import.meta.dir, "..", "supabase", "functions", "search-memory", "index.ts");

/** Jeder Aufruf an der Abfrage der Attrappe, mit Argumenten */
const calls: { method: string; args: unknown[] }[] = [];
function recordingQuery(): unknown {
  const query: unknown = new Proxy(() => {}, {
    get: (_, prop) =>
      prop === "then"
        ? (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
        : (...args: unknown[]) => {
            calls.push({ method: String(prop), args });
            return query;
          },
  });
  return query;
}
mock.module("https://esm.sh/@supabase/supabase-js@2.116.0", () => ({
  createClient: () => recordingQuery(),
}));

const g = globalThis as { Deno?: unknown };
let savedDeno: unknown;
let handler: (req: Request) => Promise<Response>;
let fetchSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  savedDeno = g.Deno;
  // Ohne Schlüssel eines Anbieters scheitert der Suchvektor, die Function sucht nach Text
  const env: Record<string, string> = { SUPABASE_URL: "https://attrappe.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
  g.Deno = {
    env: { get: (name: string) => env[name] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handler = h;
    },
  };
  // Kein Netz: ein Aufruf nach draußen scheitert
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new TypeError("kein Netz im Test");
  }) as unknown as typeof fetch);
  clearRegistryCache();
  // Eigene Instanz über die Abfrage im Pfad, unabhängig davon, ob ein anderer Test die Function schon geladen hat
  await import(`${FUNCTION_FILE}?like-pattern-test`);
});

afterAll(() => {
  fetchSpy.mockRestore();
  if (savedDeno === undefined) delete g.Deno;
  else g.Deno = savedDeno;
});

describe("search-memory, Textrückfall", () => {
  test("maskiert den Suchtext mit derselben Funktion und filtert Meldungen vor order und limit", async () => {
    calls.length = 0;
    const query = "50%_Rabatt\\Aktion";
    const response = await handler(
      new Request("http://edge.test/functions/v1/search-memory", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ chat_id: "4711", query, limit: 4 }),
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    const ilike = calls.filter(c => c.method === "ilike");
    expect(ilike).toEqual([{ method: "ilike", args: ["content", containsPattern(query)] }]);
    expect(ilike[0].args[1]).toBe("%50\\%\\_Rabatt\\\\Aktion%");
    const order = calls.map(c => c.method);
    expect(order.indexOf("or")).toBeLessThan(order.indexOf("order"));
    expect(order.indexOf("order")).toBeLessThan(order.indexOf("limit"));
    expect(calls.find(c => c.method === "limit")?.args).toEqual([4]);
  });
});
