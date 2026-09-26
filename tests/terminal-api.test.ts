/**
 * Issue #60, Schritt 1: API-Client von tybo (src/terminal/api.ts) gegen einen
 * echten Web-Server nur im Test, angemeldet mit dem lokalen Schlüssel.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { ApiClient, ApiError, tokenFromFile } from "../src/terminal/api";
import { startTyboServer, type TerminalTestServer } from "./terminal-fixture";

let current: TerminalTestServer[] = [];
afterEach(async () => {
  for (const s of current.splice(0)) await s.stop();
});
async function start() {
  const s = await startTyboServer();
  current.push(s);
  return s;
}

describe("Anmeldung mit Bearer-Schlüssel", () => {
  test("gültiger Schlüssel: me() ist true, Anfrage trägt Authorization: Bearer", async () => {
    const s = await start();
    const seen: string[] = [];
    const client = new ApiClient({
      base: s.base,
      getToken: tokenFromFile(s.tokenFile),
      fetch: ((url: string, init: RequestInit) => {
        seen.push(String((init.headers as Record<string, string>).authorization ?? ""));
        return fetch(url, init);
      }) as typeof fetch,
    });
    expect(await client.me()).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toStartWith("Bearer ");
  });

  test("ohne oder mit falschem Schlüssel: me() false, andere Aufrufe werfen ApiError 401", async () => {
    const s = await start();
    const none = new ApiClient({ base: s.base, getToken: async () => null });
    expect(await none.me()).toBe(false);
    const wrong = new ApiClient({ base: s.base, getToken: async () => "A".repeat(43) });
    expect(await wrong.me()).toBe(false);
    const error = await wrong.listConversations().catch(e => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.message).not.toContain("A".repeat(43));
  });

  test("nach 401 wird der Schlüssel einmal neu gelesen (Bot mit neuem Schlüssel)", async () => {
    const s = await start();
    const real = (await Bun.file(s.tokenFile).text()).trim();
    await writeFile(s.tokenFile, "B".repeat(43));
    const getToken = tokenFromFile(s.tokenFile);
    // Zwischengespeichert ist der veraltete Schlüssel
    expect(await getToken(false)).toBe("B".repeat(43));
    await writeFile(s.tokenFile, real);
    const client = new ApiClient({ base: s.base, getToken });
    expect(await client.me()).toBe(true);
  });

  test("Server nicht erreichbar: ApiError mit Status 0", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = probe.port;
    probe.stop(true);
    const client = new ApiClient({ base: `http://127.0.0.1:${port}`, getToken: async () => "x", timeoutMs: 1000 });
    const error = await client.listConversations().catch(e => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
  });
});

describe("Gespräche und Verlauf", () => {
  test("listConversations: Direktchat, Topics mit Agent und geschlossene gekennzeichnet", async () => {
    const s = await start();
    const list = await s.client().listConversations();
    expect(list[0]).toMatchObject({ id: "dm", title: "Direktchat", agent: "general", kind: "dm" });
    const research = list.find(c => c.id === "topic-443")!;
    expect(research).toMatchObject({ title: "Recherche", agent: "research", kind: "topic" });
    // Issue #61: letzte Aktivität bleibt erhalten (für /topics)
    expect(typeof research.lastActivity).toBe("string");
    expect(Number.isNaN(new Date(research.lastActivity!).getTime())).toBe(false);
    expect(list.some(c => c.id === "topic-1" && c.title === "General")).toBe(true);
    expect(list.every(c => typeof c.title === "string" && typeof c.agent === "string")).toBe(true);
  });

  test("messages: chronologisch, Antworten mit copyText, Zustand running", async () => {
    const s = await start();
    const page = await s.client().messages("topic-443");
    expect(page.running).toBe(false);
    expect(page.messages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(page.messages[1].copyText).toContain("**4 Euro**");
  });

  test("unbekanntes Gespräch: ApiError 404 mit der Meldung des Servers", async () => {
    const s = await start();
    const error = await s.client().messages("topic-99999").catch(e => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.message).toBe("Gespräch nicht gefunden");
  });
});

describe("Rückfragen (Issue #120)", () => {
  async function withChoices() {
    const s = await startTyboServer({ choices: true });
    current.push(s);
    return s;
  }

  test("decideChoice: 200 entschieden mit Kanal terminal aus der Anmeldung", async () => {
    const s = await withChoices();
    const id = s.ask("topic-443", "Freigabe?");
    const result = await s.client().decideChoice("topic-443", id, "ok");
    expect(result).toMatchObject({ status: "decided", choice: { id, state: "done", options: [], result: { key: "ok", label: "Erlauben", via: "terminal" } } });
    expect(s.choices!.decisions).toEqual([{ id, key: "ok", via: "terminal" }]);
  });

  test("decideChoice: 409 schon entschieden bzw. abgelaufen liefert den Stand des Servers", async () => {
    const s = await withChoices();
    const a = s.ask("topic-443", "A");
    await s.choices!.decideIn("telegram", a, "no");
    expect(await s.client().decideChoice("topic-443", a, "ok")).toMatchObject({
      status: "already",
      error: "Diese Rückfrage ist schon entschieden.",
      choice: { state: "done", result: { key: "no", via: "telegram" } },
    });
    const b = s.ask("topic-443", "B");
    s.choices!.expireSilently(b);
    expect(await s.client().decideChoice("topic-443", b, "ok")).toMatchObject({ status: "expired", choice: { id: b, state: "expired" } });
  });

  test("decideChoice: fremdes Gespräch 404, unbekannte Option 400, beides entscheidet nichts", async () => {
    const s = await withChoices();
    const id = s.ask("topic-31", "Frage in Strategie");
    expect(await s.client().decideChoice("topic-443", id, "ok")).toEqual({ status: "not_found", error: "Diese Rückfrage gibt es in diesem Gespräch nicht." });
    expect(await s.client().decideChoice("topic-31", id, "gibtsnicht")).toEqual({ status: "invalid", error: "Ungültige Auswahl" });
    expect(s.choices!.get(id)!.state).toBe("open");
  });

  test("decideChoice ohne Register: 503 wirft ApiError", async () => {
    const s = await start();
    await expect(s.client().decideChoice("topic-443", "Frage000001", "ok")).rejects.toBeInstanceOf(ApiError);
  });

  test("choices(): Stand mehrerer Fragen aus Sicht des Gesprächs, unbekannte gelten als abgelaufen", async () => {
    const s = await withChoices();
    const a = s.ask("topic-443", "A");
    const b = s.ask("topic-443", "B");
    await s.choices!.decideIn("web", b, "ok");
    const list = await s.client().choices("topic-443", [a, b, "Unbekannt01"]);
    expect(list.map(c => [c.id, c.state, c.options.length, c.result?.via])).toEqual([
      [a, "open", 2, undefined],
      [b, "done", 0, "web"],
      ["Unbekannt01", "expired", 0, undefined],
    ]);
  });
});

describe("toChoice (Issue #120)", () => {
  test("nur vollständige Rückfragen; Knöpfe nur offen, Ergebnis nur bei bekanntem Kanal", async () => {
    const { toChoice } = await import("../src/terminal/api");
    expect(toChoice(null)).toBeNull();
    expect(toChoice({ id: "a", state: "offen" })).toBeNull();
    expect(toChoice({ id: "a", state: "open", options: [{ key: "ok", label: "Ja" }, { key: 1, label: "x" }, { key: "no" }] })).toEqual({ id: "a", state: "open", options: [{ key: "ok", label: "Ja" }] });
    expect(toChoice({ id: "a", state: "done", options: [{ key: "ok", label: "Ja" }], result: { key: "ok", label: "Ja", via: "fax", at: "" } })).toEqual({ id: "a", state: "done", options: [] });
    expect(toChoice({ id: "a", state: "open", options: [], elsewhere: "dm" })).toEqual({ id: "a", state: "open", options: [], elsewhere: "dm" });
  });
});
