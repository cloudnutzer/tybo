/**
 * Stiller Rückfall in saveMessage (30.9.2026): vom 9.9. an lehnte die Edge
 * Function store-telegram-message den Bot mit 401 ab, saveMessage schrieb
 * drei Wochen lang ohne Embedding, niemand merkte es. Jetzt steht jeder
 * Rückfall mit HTTP-Status (ohne Schlüssel) im Fehler-Log, und der Nutzer
 * bekommt höchstens einmal pro Stunde eine Warnung. Kein Netz: supabase-js
 * gegen die Fetch-Attrappe. Seit Issue #309 laufen die Rückfall-Fälle auch
 * gegen getStore().messages.save, mit denselben Erwartungen.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  EDGE_FALLBACK_WARN_INTERVAL_MS,
  reportEdgeFallback,
  resetEdgeFallbackWarning,
  setEdgeFallbackNotifier,
} from "../src/lib/store/supabase/edge-warning";
import type { Message } from "../src/lib/store/types";
import { saveDirect as saveMessage } from "./supabase-direct";
import { getStore, resetStore } from "../src/lib/store";
import { useFakeSupabase, type FakeRequest } from "./supabase-fixture";

const cleanups: (() => void)[] = [];
let errors: string[] = [];
let warnings: string[] = [];

beforeEach(() => {
  resetEdgeFallbackWarning();
  errors = [];
  warnings = [];
  const e = spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
  const w = spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.join(" ")));
  cleanups.push(() => e.mockRestore(), () => w.mockRestore(), () => setEdgeFallbackNotifier(null));
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const message: Message = { chat_id: "12345", role: "user", content: "Hallo" };

function fake(edge: () => Response) {
  const f = useFakeSupabase({ edgeResponse: () => edge() });
  cleanups.push(() => f.restore());
  return f;
}

const directInserts = (requests: FakeRequest[]) =>
  requests.filter(q => q.method === "POST" && q.url.pathname === "/rest/v1/messages").length;

function collectNotices(): string[] {
  const notices: string[] = [];
  setEdgeFallbackNotifier(text => void notices.push(text));
  return notices;
}

/** Einstiege, die dieselbe Rückfall-Logik nehmen; der Store wird je Aufruf neu gewählt (Umgebung der Attrappe) */
const SAVERS: [string, (m: Message) => Promise<boolean>][] = [
  ["saveMessage", saveMessage],
  [
    "getStore().messages.save",
    m => {
      resetStore();
      return getStore().messages.save(m);
    },
  ],
];

for (const [label, saveMessage] of SAVERS) {
  describe(`${label}: Rückfall auf den Direkt-Insert`, () => {
    test("401: Direkt-Insert, Status im Fehler-Log, ohne Schlüssel, eine Warnung", async () => {
      const notices = collectNotices();
      const f = fake(() => new Response("Unauthorized", { status: 401 }));
      expect(await saveMessage(message)).toBe(true);
      expect(await saveMessage(message)).toBe(true);
      expect(directInserts(f.requests)).toBe(2);
      expect(errors.filter(l => l.includes("HTTP 401"))).toHaveLength(2);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("HTTP 401");
      for (const line of [...errors, ...warnings, ...notices]) {
        expect(line).not.toContain("test-service-key");
        expect(line).not.toContain("supabase.test");
      }
    });

    test("Netzfehler: nur der Fehlertyp, keine Adresse", async () => {
      const notices = collectNotices();
      const f = fake(() => {
        throw new TypeError("fetch failed http://supabase.test/functions/v1/store-telegram-message");
      });
      expect(await saveMessage(message)).toBe(true);
      expect(directInserts(f.requests)).toBe(1);
      expect(notices[0]).toContain("nicht erreichbar (TypeError)");
      expect(errors.join("\n")).not.toContain("supabase.test");
    });

    test("404 (Function nicht ausgeliefert): Direkt-Insert, einmal im Log, keine Warnung", async () => {
      const notices = collectNotices();
      const f = fake(() => new Response("Not found", { status: 404 }));
      for (let i = 0; i < 3; i++) expect(await saveMessage(message)).toBe(true);
      expect(directInserts(f.requests)).toBe(3);
      expect(errors.filter(l => l.includes("404"))).toHaveLength(1);
      expect(notices).toHaveLength(0);
    });

    test("200 mit ok: false (Insert in der Function gescheitert): Direkt-Insert statt verlorener Nachricht", async () => {
      const notices = collectNotices();
      const f = fake(() => Response.json({ ok: false, error: "x", embedded: false, embedding_status: "ok" }));
      expect(await saveMessage(message)).toBe(true);
      expect(directInserts(f.requests)).toBe(1);
      expect(notices[0]).toContain("Insert gescheitert");
    });

    test("200 ohne Vektor wegen Störung (abgelehnt): gespeichert, Warnung", async () => {
      const notices = collectNotices();
      const f = fake(() => Response.json({ ok: true, embedded: false, embedding_status: "abgelehnt" }));
      expect(await saveMessage(message)).toBe(true);
      expect(directInserts(f.requests)).toBe(0);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("abgelehnt");
    });

    test("200 ohne Vektor, bewusst (kein-zugang, gesperrt): keine Warnung", async () => {
      const notices = collectNotices();
      for (const status of ["kein-zugang", "gesperrt"]) {
        const f = fake(() => Response.json({ ok: true, embedded: false, embedding_status: status }));
        expect(await saveMessage(message)).toBe(true);
        expect(await saveMessage(message)).toBe(true);
        f.restore();
        cleanups.pop();
      }
      expect(notices).toHaveLength(0);
      expect(warnings.filter(l => l.includes("kein-zugang"))).toHaveLength(1);
    });

    test("200 mit Vektor: still", async () => {
      const notices = collectNotices();
      fake(() => Response.json({ ok: true, embedded: true, embedding_status: "ok" }));
      expect(await saveMessage(message)).toBe(true);
      expect(notices).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });
  });
}

describe("reportEdgeFallback: höchstens eine Warnung pro Stunde", () => {
  test("nach Ablauf der Stunde die nächste, mit Zahl der Rückfälle dazwischen", () => {
    const notices = collectNotices();
    const t0 = 1_000_000;
    reportEdgeFallback(401, undefined, t0);
    reportEdgeFallback(401, undefined, t0 + 1_000);
    reportEdgeFallback(500, undefined, t0 + EDGE_FALLBACK_WARN_INTERVAL_MS - 1);
    expect(notices).toHaveLength(1);
    reportEdgeFallback(401, undefined, t0 + EDGE_FALLBACK_WARN_INTERVAL_MS);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain("3x seit der letzten Warnung");
    expect(errors).toHaveLength(4);
  });

  test("ein werfender Empfänger stört das Speichern nicht", async () => {
    setEdgeFallbackNotifier(() => {
      throw new Error("kaputt");
    });
    fake(() => new Response("", { status: 503 }));
    expect(await saveMessage(message)).toBe(true);
  });
});
