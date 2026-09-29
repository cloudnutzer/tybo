/**
 * Kindprozess für tests/search-abort.test.ts (Issue #166, Prüfrunden 1 und 3):
 * echtes `tybo setup pruefung`, `tybo setup suche` bzw. `tybo setup --web`
 * über main() aus scripts/tybo.ts, also mit dem echten SIGINT-Handler und dem
 * echten process.exit am Ende. Der Nachweis der semantischen Suche läuft; die
 * Attrappe speichert die Probe, search-memory hängt bis zum Abbruch, das
 * Löschen dauert CHILD_DELETE_MS. Jeder Schritt landet mit Zeitstempel in
 * <projektordner>/trail.log, die Adresse des Einrichtungsmodus in
 * <projektordner>/url.txt.
 *
 * Umgebung: CHILD_DELETE_MS (Dauer des Löschens), CHILD_DELETE_FAIL=1 (das
 * Löschen der Probe scheitert mit HTTP 500), CHILD_GRACE_MS (Schonfrist nach
 * Strg+C für Abläufe, Terminal und Browser).
 *
 * Aufruf: bun tests/search-abort-child.ts <projektordner> setup pruefung|suche|--web
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../scripts/tybo";
import { createSetupContext, type HttpFetch } from "../src/setup/context";
import { scripted } from "./setup-terminal-fixture";
import { CODE } from "./setup-web-fixture";

const root = process.argv[2];
process.argv.splice(2, 1);
const deleteMs = Number(process.env.CHILD_DELETE_MS) || 300;
const deleteFails = process.env.CHILD_DELETE_FAIL === "1";
const graceMs = Number(process.env.CHILD_GRACE_MS) || 10_000;
const trail = (event: string) => appendFileSync(join(root, "trail.log"), `${Date.now()} ${event}\n`);

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });

const fetch: HttpFetch = async (url, request = {}) => {
  const u = new URL(url);
  // Prüfung des OpenAI-Schlüssels im Ablauf von tybo setup suche
  if (u.host === "api.openai.com") return json({ data: [{ embedding: [0.1, 0.2] }] });
  if (u.host !== "db.example.org") throw new Error("Kein Netz in Tests");
  if (u.pathname === "/functions/v1/store-telegram-message") {
    trail("store");
    return json({ ok: true });
  }
  if (u.pathname === "/functions/v1/search-memory") {
    trail("search");
    await new Promise<void>((_, reject) => {
      const abort = () => {
        trail("search-abgebrochen");
        reject(new DOMException("Abgebrochen", "AbortError"));
      };
      if (request.signal?.aborted) return abort();
      request.signal?.addEventListener("abort", abort, { once: true });
    });
  }
  if (u.pathname === "/rest/v1/messages" && request.method === "DELETE") {
    const kind = (u.searchParams.get("chat_id") ?? "").startsWith("eq.") ? "probe" : "reste";
    trail(`delete-${kind}-anfang`);
    await Bun.sleep(deleteMs);
    trail(`delete-${kind}-ende`);
    if (kind === "probe" && deleteFails) return new Response("boom", { status: 500 });
    return json([]);
  }
  // Anbieterkennung (Issue #167): Migration fehlt, wie PostgREST es meldet; OpenAI wie bisher erlaubt
  if (u.pathname.startsWith("/rest/v1/rpc/")) {
    return new Response(JSON.stringify({ code: "PGRST202" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
  return new Response("not found", { status: 404 });
};

const ctx = createSetupContext({
  root,
  home: join(root, "home"),
  run: async () => ({ code: 1, stdout: "", stderr: "" }),
  fetch,
});

process.on("exit", code => trail(`exit ${code}`));
await main({
  setup: {
    ctx,
    // Gesamtprüfung: jede Rückfrage mit „ü“; tybo setup suche: Schlüssel leer lassen, dann ausführen
    prompter: scripted(process.argv.includes("suche") ? ["", "", "", ""] : ["ü", "ü", "ü", "ü", "ü", "ü", "ü", "ü"]),
    runGraceMs: graceMs,
    web: { code: CODE, port: 0, runGraceMs: graceMs, onReady: ({ url }) => writeFileSync(join(root, "url.txt"), url) },
  },
});
