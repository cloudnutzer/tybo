/**
 * Issue #64, Checkbox 2: Schritte telegram, gruppe und datenbank samt
 * Anbieter-Ports (src/setup/providers.ts). Das Netz ist eine Attrappe, alle
 * Dateien liegen in temporären Ordnern. Seit Issue #324 kennt der Schritt
 * datenbank nur noch drei Wege zu Supabase; eine alte CONVEX_URL bleibt
 * unberührt und zählt nicht.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import type { HttpFetch, HttpRequest } from "../src/setup/context";
import { createProviders } from "../src/setup/providers";
import { databaseStep } from "../src/setup/steps/database";
import { groupStep, telegramStep } from "../src/setup/steps/telegram";
import { backupsOf, cleanup, FAKE, fakeRun, leakedSecrets, makeCtx } from "./setup-fixture";

afterAll(cleanup);

// ---------------------------------------------------------------------------
// Netz-Attrappe für die Ports
// ---------------------------------------------------------------------------

interface Hit {
  url: string;
  request?: HttpRequest;
}

function fakeFetch(handler: (url: string, request?: HttpRequest) => Response | Promise<Response>): HttpFetch & { hits: Hit[] } {
  const hits: Hit[] = [];
  const f = (async (url: string, request?: HttpRequest) => {
    hits.push({ url, request });
    return handler(url, request);
  }) as HttpFetch & { hits: Hit[] };
  f.hits = hits;
  return f;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function providersWith(fetch: HttpFetch) {
  return createProviders({ fetch, run: fakeRun(), subprocessEnv: () => ({}) });
}

/** Adresse aus einer früheren Version mit Convex; zählt nicht mehr */
const OLD_DB_URL = "https://happy-otter-123.convex.cloud";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

describe("Telegram-Port", () => {
  test("getMe Erfolg", async () => {
    const fetch = fakeFetch(() => json(200, { ok: true, result: { username: "mein_bot" } }));
    const r = await providersWith(fetch).telegramGetMe(FAKE.token);
    expect(r).toEqual({ ok: true, message: "Verbunden mit @mein_bot", username: "mein_bot" });
    expect(fetch.hits[0].url).toBe(`https://api.telegram.org/bot${FAKE.token}/getMe`);
  });

  test("getMe abgelehnt: verständlich, ohne Token", async () => {
    const r = await providersWith(fakeFetch(() => json(401, { ok: false, description: "Unauthorized" }))).telegramGetMe(FAKE.token);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("lehnt das Token ab");
    expect(leakedSecrets(r)).toEqual([]);
  });

  test("Netzfehler mit Token in der Fehlermeldung wird geschwärzt", async () => {
    const fetch = fakeFetch(url => {
      throw new Error(`Unable to connect: ${url}`);
    });
    const r = await providersWith(fetch).telegramGetMe(FAKE.token);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("nicht erreichbar");
    expect(r.message).not.toContain(FAKE.token);
  });

  test("Testnachricht: Erfolg, unbekannter Chat, blockiert", async () => {
    const ok = await providersWith(fakeFetch(() => json(200, { ok: true, result: { message_id: 1 } }))).telegramSendTest(FAKE.token, FAKE.userId, "hi");
    expect(ok.ok).toBe(true);
    const notFound = await providersWith(fakeFetch(() => json(400, { ok: false, description: "Bad Request: chat not found" }))).telegramSendTest(
      FAKE.token,
      FAKE.userId,
      "hi",
    );
    expect(notFound.ok).toBe(false);
    expect(notFound.message).toContain("Start");
    const blocked = await providersWith(fakeFetch(() => json(403, { ok: false, description: "Forbidden: bot was blocked by the user" }))).telegramSendTest(
      FAKE.token,
      FAKE.userId,
      "hi",
    );
    expect(blocked.message).toContain("blockiert");
  });

  test("Testnachricht geht an die Nutzer-ID", async () => {
    const fetch = fakeFetch(() => json(200, { ok: true }));
    await providersWith(fetch).telegramSendTest(FAKE.token, FAKE.userId, "hallo");
    expect(JSON.parse(fetch.hits[0].request!.body!)).toEqual({ chat_id: FAKE.userId, text: "hallo" });
  });

  test("Gruppe: Forum mit Admin, ohne Themen, Bot kein Admin", async () => {
    const answer = (forum: boolean, role: string) =>
      fakeFetch(url => (url.endsWith("/getChat") ? json(200, { ok: true, result: { is_forum: forum } }) : json(200, { ok: true, result: { status: role } })));
    expect((await providersWith(answer(true, "administrator")).telegramCheckGroup(FAKE.token, FAKE.groupId)).ok).toBe(true);
    const noForum = await providersWith(answer(false, "administrator")).telegramCheckGroup(FAKE.token, FAKE.groupId);
    expect(noForum.message).toContain("keine Themen");
    const noAdmin = await providersWith(answer(true, "member")).telegramCheckGroup(FAKE.token, FAKE.groupId);
    expect(noAdmin.message).toContain("kein Admin");
    const missing = await providersWith(fakeFetch(() => json(400, { ok: false, description: "chat not found" }))).telegramCheckGroup(FAKE.token, FAKE.groupId);
    expect(missing.message).toContain("Gruppe nicht gefunden");
  });
});

describe("Supabase-Port", () => {
  test("liest nur (GET auf messages) und meldet Erfolg", async () => {
    const fetch = fakeFetch(() => json(200, []));
    const r = await providersWith(fetch).supabaseQuery(`${FAKE.supabaseUrl}/`, FAKE.serviceKey);
    expect(r.ok).toBe(true);
    expect(fetch.hits).toHaveLength(1);
    expect(fetch.hits[0].url).toBe(`${FAKE.supabaseUrl}/rest/v1/messages?select=id&limit=1`);
    expect(fetch.hits[0].request?.method ?? "GET").toBe("GET");
  });

  test("Schlüssel abgelehnt, Tabelle fehlt, Netzfehler: Klartext ohne Schlüssel und ohne Rohantwort", async () => {
    const denied = await providersWith(fakeFetch(() => new Response(`{"message":"Invalid API key ${FAKE.serviceKey}"}`, { status: 401 }))).supabaseQuery(
      FAKE.supabaseUrl,
      FAKE.serviceKey,
    );
    expect(denied.message).toContain("service_role");
    expect(leakedSecrets(denied)).toEqual([]);
    const missing = await providersWith(fakeFetch(() => json(404, {}))).supabaseQuery(FAKE.supabaseUrl, FAKE.serviceKey);
    expect(missing.message).toContain("db/schema.sql");
    const down = await providersWith(
      fakeFetch(() => {
        throw new Error(`boom ${FAKE.serviceKey}`);
      }),
    ).supabaseQuery(FAKE.supabaseUrl, FAKE.serviceKey);
    expect(down.message).toContain("nicht erreichbar");
    expect(leakedSecrets(down)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Schritt telegram
// ---------------------------------------------------------------------------

describe("Schritt telegram", () => {
  test("Status leer und fertig", async () => {
    expect((await telegramStep.status(await makeCtx())).state).toBe("fehlt");
    const full = await telegramStep.status(await makeCtx({ env: `TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=${FAKE.userId}\n` }));
    expect(full.state).toBe("erledigt");
    expect(full.fields).toEqual([
      { name: "TELEGRAM_BOT_TOKEN", set: true },
      { name: "TELEGRAM_USER_ID", set: true },
    ]);
    expect(JSON.stringify(full)).not.toContain(FAKE.userId);
  });

  test("Platzhalter aus .env.example gelten als fehlend", async () => {
    const ctx = await makeCtx({ env: "TELEGRAM_BOT_TOKEN=your_bot_token_here\nTELEGRAM_USER_ID=your_telegram_user_id\n" });
    expect((await telegramStep.status(ctx)).state).toBe("fehlt");
  });

  test("Prüfregeln: Token-Format und Nutzer-ID aus Ziffern", async () => {
    const ctx = await makeCtx();
    const r = await telegramStep.test!({ TELEGRAM_BOT_TOKEN: "kein-token", TELEGRAM_USER_ID: "@alex" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Bot-Token hat nicht das erwartete Format");
    expect(r.message).toContain("Nutzer-ID besteht nur aus Ziffern");
    expect(ctx.providers.calls).toEqual([]);
  });

  test("Test nutzt eingegebene, ungespeicherte Werte", async () => {
    const ctx = await makeCtx();
    const r = await telegramStep.test!({ TELEGRAM_BOT_TOKEN: FAKE.token, TELEGRAM_USER_ID: FAKE.userId }, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.providers.calls.map(c => c.method)).toEqual(["telegramGetMe", "telegramSendTest"]);
    expect(ctx.providers.calls[1].args.slice(0, 2)).toEqual([FAKE.token, FAKE.userId]);
    expect(await Bun.file(ctx.envPath).exists()).toBe(false);
    expect(leakedSecrets(r)).toEqual([]);
  });

  test("Test mit vorhandenem Token und neuer Nutzer-ID", async () => {
    const ctx = await makeCtx({ env: `TELEGRAM_BOT_TOKEN=${FAKE.token}\n` });
    await telegramStep.test!({ TELEGRAM_USER_ID: "777" }, ctx);
    expect(ctx.providers.calls[1].args.slice(0, 2)).toEqual([FAKE.token, "777"]);
  });

  test("Test Fehler: Token abgelehnt, keine Testnachricht", async () => {
    const ctx = await makeCtx();
    ctx.providers.results.telegramGetMe = { ok: false, message: "Telegram lehnt das Token ab. Bitte das Token bei @BotFather prüfen oder neu erzeugen." };
    const r = await telegramStep.test!({ TELEGRAM_BOT_TOKEN: FAKE.token, TELEGRAM_USER_ID: FAKE.userId }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("@BotFather");
    expect(ctx.providers.calls.map(c => c.method)).toEqual(["telegramGetMe"]);
  });

  test("Schreiben: temporäre .env, 0600, Kommentare bleiben, Sicherung", async () => {
    const ctx = await makeCtx({ env: "# Mein Kommentar\nUSER_NAME=Test\n" });
    const r = await telegramStep.apply!({ TELEGRAM_BOT_TOKEN: FAKE.token, TELEGRAM_USER_ID: FAKE.userId }, ctx);
    expect(r).toEqual({ ok: true, message: "Gespeichert.", changed: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID"] });
    const content = await readFile(ctx.envPath, "utf8");
    expect(content).toContain("# Mein Kommentar\nUSER_NAME=Test\n");
    expect(content).toContain(`TELEGRAM_BOT_TOKEN=${FAKE.token}`);
    expect((await stat(ctx.envPath)).mode & 0o777).toBe(0o600);
    expect((await backupsOf(ctx)).length).toBe(1);
    expect(leakedSecrets(r)).toEqual([]);
  });

  test("Wiederholen ohne Geheimnis behält das vorhandene Token", async () => {
    const ctx = await makeCtx({ env: `TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=1\n` });
    const r = await telegramStep.apply!({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_USER_ID: "2" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual(["TELEGRAM_USER_ID"]);
    expect(await readFile(ctx.envPath, "utf8")).toBe(`TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=2\n`);
    const again = await telegramStep.apply!({ TELEGRAM_USER_ID: "2" }, ctx);
    expect(again).toEqual({ ok: true, message: "Schon so eingetragen, nichts geändert.", changed: [] });
    expect((await backupsOf(ctx)).length).toBe(1);
  });

  test("Schreibfehler: .env unverändert, verständlicher Text ohne Werte", async () => {
    const ctx = await makeCtx({ env: "USER_NAME=Test\n" });
    ctx.envIo = {
      rename: async () => {
        throw Object.assign(new Error(`EACCES ${FAKE.token}`), { code: "EACCES" });
      },
    };
    const r = await telegramStep.apply!({ TELEGRAM_BOT_TOKEN: FAKE.token, TELEGRAM_USER_ID: FAKE.userId }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(".env konnte nicht geschrieben werden (EACCES). Nichts wurde geändert.");
    expect(await readFile(ctx.envPath, "utf8")).toBe("USER_NAME=Test\n");
  });

  test("ungültige Eingabe schreibt nichts", async () => {
    const ctx = await makeCtx({ env: "USER_NAME=Test\n" });
    const r = await telegramStep.apply!({ TELEGRAM_BOT_TOKEN: "falsch", TELEGRAM_USER_ID: FAKE.userId }, ctx);
    expect(r.ok).toBe(false);
    expect(await readFile(ctx.envPath, "utf8")).toBe("USER_NAME=Test\n");
    expect(await backupsOf(ctx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Schritt gruppe
// ---------------------------------------------------------------------------

describe("Schritt gruppe", () => {
  test("Status leer und fertig", async () => {
    expect((await groupStep.status(await makeCtx())).state).toBe("fehlt");
    expect((await groupStep.status(await makeCtx({ env: `TELEGRAM_GROUP_ID=${FAKE.groupId}\n` }))).state).toBe("erledigt");
  });

  test("Prüfregel: Minus und Ziffern", async () => {
    const ctx = await makeCtx({ env: `TELEGRAM_BOT_TOKEN=${FAKE.token}\n` });
    const r = await groupStep.test!({ TELEGRAM_GROUP_ID: "12345" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("beginnt mit einem Minus");
  });

  test("Test braucht ein gespeichertes Token", async () => {
    const r = await groupStep.test!({ TELEGRAM_GROUP_ID: FAKE.groupId }, await makeCtx());
    expect(r).toEqual({ ok: false, message: "Erst den Schritt Telegram einrichten, dann die Gruppe testen." });
  });

  test("Test Erfolg und Fehler mit eingegebener ID", async () => {
    const ctx = await makeCtx({ env: `TELEGRAM_BOT_TOKEN=${FAKE.token}\n` });
    expect((await groupStep.test!({ TELEGRAM_GROUP_ID: FAKE.groupId }, ctx)).ok).toBe(true);
    expect(ctx.providers.calls[0].args).toEqual([FAKE.token, FAKE.groupId]);
    ctx.providers.results.telegramCheckGroup = { ok: false, message: "Die Gruppe hat keine Themen." };
    expect((await groupStep.test!({ TELEGRAM_GROUP_ID: FAKE.groupId }, ctx)).message).toBe("Die Gruppe hat keine Themen.");
  });

  test("Schreiben und Überspringen", async () => {
    const ctx = await makeCtx({ env: "" });
    const r = await groupStep.apply!({ TELEGRAM_GROUP_ID: FAKE.groupId }, ctx);
    expect(r.changed).toEqual(["TELEGRAM_GROUP_ID"]);
    expect(await readFile(ctx.envPath, "utf8")).toBe(`TELEGRAM_GROUP_ID=${FAKE.groupId}\n`);
    // Überspringen heißt: nicht anwenden. Pflichtfeld ohne Wert wird abgelehnt.
    const skipped = await makeCtx({ env: "" });
    expect((await groupStep.apply!({}, skipped)).ok).toBe(false);
    expect(await readFile(skipped.envPath, "utf8")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Schritt datenbank
// ---------------------------------------------------------------------------

describe("Schritt datenbank", () => {
  test("Auswahl: genau drei Wege, alle zu Supabase", () => {
    const field = databaseStep.fields.find(f => f.name === "DB_BACKEND")!;
    expect(field.choices!.map(c => c.value)).toEqual(["supabase-cloud", "supabase-lokal", "supabase"]);
    expect(databaseStep.fields.map(f => f.name).filter(n => /convex|DB_SWITCH/i.test(n))).toEqual([]);
    expect(JSON.stringify(databaseStep)).not.toMatch(/convex/i);
  });

  test("Status: leer, alte CONVEX_URL allein, Supabase ohne service_role", async () => {
    expect((await databaseStep.status(await makeCtx())).state).toBe("fehlt");
    const old = await databaseStep.status(await makeCtx({ env: `CONVEX_URL=${OLD_DB_URL}\nCONVEX_AUTH_TOKEN=alter-token-1234\n` }));
    expect(old).toMatchObject({ state: "fehlt", detail: "Noch keine Datenbank eingerichtet." });
    expect(old.fields.find(f => f.name === "DB_BACKEND")).toEqual({ name: "DB_BACKEND", set: false });
    expect(JSON.stringify(old)).not.toContain(OLD_DB_URL);
    const anonOnly = await databaseStep.status(await makeCtx({ env: `SUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_ANON_KEY=${FAKE.anonKey}\n` }));
    expect(anonOnly.state).toBe("teilweise");
    expect(anonOnly.detail).toContain("SUPABASE_SERVICE_ROLE_KEY");
    const supa = await databaseStep.status(await makeCtx({ env: `SUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\n` }));
    expect(supa.state).toBe("erledigt");
  });

  test("alte CONVEX_URL verdrängt Supabase nicht", async () => {
    const ctx = await makeCtx({
      env: `SUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\nCONVEX_URL=${OLD_DB_URL}\n`,
    });
    expect(await databaseStep.status(ctx)).toMatchObject({ state: "erledigt", detail: "Supabase in der Cloud ist eingerichtet." });
    const r = await databaseStep.test!({}, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.providers.calls.map(c => c.method)).toEqual(["supabaseQuery", "supabaseWriteProbe"]);
  });

  test("Prüfregeln: Standard Supabase in der Cloud, Pflichtfelder, Auswahl convex abgelehnt", async () => {
    const ctx = await makeCtx();
    // Issue #163: ohne Auswahl gilt der Standard; ohne Einrichtung nennt der Test den Ablauf
    expect((await databaseStep.test!({}, ctx)).message).toContain("Supabase in der Cloud ist noch nicht eingerichtet");
    const convex = await databaseStep.test!({ DB_BACKEND: "convex", CONVEX_URL: OLD_DB_URL, CONVEX_AUTH_TOKEN: "alter-token-1234" }, ctx);
    expect(convex).toEqual({ ok: false, message: "Datenbank: keine gültige Auswahl" });
    const supa = await databaseStep.test!({ DB_BACKEND: "supabase", SUPABASE_URL: FAKE.supabaseUrl }, ctx);
    expect(supa.message).toBe("Supabase service_role- oder Secret-Schlüssel fehlt");
    expect(ctx.providers.calls).toEqual([]);
  });

  test("Test nutzt eingegebene Werte", async () => {
    const ctx = await makeCtx();
    await databaseStep.test!({ DB_BACKEND: "supabase", SUPABASE_URL: FAKE.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: FAKE.serviceKey }, ctx);
    expect(ctx.providers.calls).toEqual([
      { method: "supabaseQuery", args: [FAKE.supabaseUrl, FAKE.serviceKey] },
      { method: "supabaseWriteProbe", args: [FAKE.supabaseUrl, FAKE.serviceKey] },
    ]);
  });

  test("Test Fehler kommt als Klartext zurück", async () => {
    const ctx = await makeCtx({ env: `SUPABASE_URL=https://db.example\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\n` });
    ctx.providers.results.supabaseQuery = { ok: false, message: "Supabase ist nicht erreichbar. Adresse prüfen." };
    const r = await databaseStep.test!({}, ctx);
    expect(r).toEqual({ ok: false, message: "Supabase ist nicht erreichbar. Adresse prüfen." });
  });

  test("Auswahl convex: Speichern abgelehnt, .env unverändert", async () => {
    const ctx = await makeCtx({ env: "" });
    const r = await databaseStep.apply!({ DB_BACKEND: "convex", CONVEX_URL: OLD_DB_URL, CONVEX_AUTH_TOKEN: "alter-token-1234" }, ctx);
    expect(r).toMatchObject({ ok: false, message: "Datenbank: keine gültige Auswahl", changed: [] });
    expect(await readFile(ctx.envPath, "utf8")).toBe("");
  });

  test("Schreiben Supabase mit service_role", async () => {
    const ctx = await makeCtx({ env: "" });
    const r = await databaseStep.apply!(
      { DB_BACKEND: "supabase", SUPABASE_URL: FAKE.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: FAKE.serviceKey },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(await readFile(ctx.envPath, "utf8")).toBe(`SUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\n`);
  });

  test("alte CONVEX_URL: Supabase speichern ohne Bestätigung, alte Zeilen bleiben unberührt", async () => {
    const env = `CONVEX_URL=${OLD_DB_URL}\nCONVEX_AUTH_TOKEN=alter-token-1234\n`;
    const ctx = await makeCtx({ env });
    const done = await databaseStep.apply!({ DB_BACKEND: "supabase", SUPABASE_URL: FAKE.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: FAKE.serviceKey }, ctx);
    expect(done.ok).toBe(true);
    expect(done.changed).toEqual(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
    const content = await readFile(ctx.envPath, "utf8");
    expect(content).toContain(`CONVEX_URL=${OLD_DB_URL}`);
    expect(content).toContain(`SUPABASE_URL=${FAKE.supabaseUrl}`);
    // Adresse auf *.supabase.co: beim erneuten Einrichten als Cloud-Weg angezeigt (Issue #163)
    expect((await databaseStep.status(ctx)).detail).toBe("Supabase in der Cloud ist eingerichtet.");
    // Die alte Fassung liegt in der Sicherung
    const [backup] = await backupsOf(ctx);
    expect(await readFile(`${ctx.backupDir}/${backup}`, "utf8")).toBe(env);
  });

  test("Wiederholen ohne Geheimnisse löscht keine vorhandenen", async () => {
    const env = `SUPABASE_URL=${FAKE.supabaseUrl}\nSUPABASE_SERVICE_ROLE_KEY=${FAKE.serviceKey}\n`;
    const ctx = await makeCtx({ env });
    const r = await databaseStep.apply!({ DB_BACKEND: "supabase", SUPABASE_SERVICE_ROLE_KEY: "" }, ctx);
    expect(r).toEqual({ ok: true, message: "Nichts zu ändern.", changed: [] });
    expect(await readFile(ctx.envPath, "utf8")).toBe(env);
  });
});
