/**
 * Issue #66, Checkbox 3: API des Einrichtungsmodus über den Kern
 * (src/setup/steps.ts). Werte gehen nie zurück an die Oberfläche; nur Felder
 * des jeweiligen Schritts werden angenommen; TELEGRAM_* und WEB_* lassen sich
 * hier setzen, die normale Schlüssel-API sperrt sie weiter. Kein
 * Claude-Aufruf, Autostart schreibt nicht über „Speichern“.
 * Alles im temporären Projekt über den echten Port, mit Anbieter-Attrappen.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseEnvContent } from "../src/lib/env-file";
import { createKeysApi } from "../src/web/keys";
import { CLAUDE_LOGIN_NOT_CHECKED } from "../src/setup/steps/prerequisites";
import { noModelProviders, REDACTED_MESSAGE, redactKnown } from "../src/setup/web-server";
import { cleanup, FAKE, FULL_ENV, leakedSecrets, makeCtx } from "./setup-fixture";
import { get, login, post, PROFILE, readyOptions, startSetup, type Started } from "./setup-web-fixture";

const running: Started[] = [];
async function start(options: Parameters<typeof startSetup>[0] = {}) {
  const s = await startSetup(options);
  running.push(s);
  return { s, cookie: await login(s) };
}
afterEach(async () => {
  for (const s of running.splice(0)) await s.server.stop();
});
afterAll(cleanup);

async function envOf(s: Started) {
  return parseEnvContent(await readFile(s.ctx.envPath, "utf8").catch(() => ""));
}

async function body(res: Response) {
  const text = await res.text();
  return { text, data: JSON.parse(text) };
}

describe("Übersicht und Schritte", () => {
  test("Übersicht: alle Schritte mit Status, keine Werte", async () => {
    const { s, cookie } = await start(readyOptions());
    const res = await get(s, "/api/setup/overview", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { text, data } = await body(res);
    expect(data.steps.map((x: any) => x.id)).toEqual([
      "voraussetzungen", "telegram", "gruppe", "datenbank", "suche", "profil", "modelle", "webui", "autostart", "pruefung",
    ]);
    expect(data.steps.find((x: any) => x.id === "telegram")).toEqual({
      id: "telegram", title: "Telegram", optional: false, state: "erledigt", detail: "Token und Nutzer-ID sind gesetzt.",
    });
    expect(data.ready).toBe(true);
    expect(data.missing).toEqual([]);
    expect(data.supervisor).toBeNull();
    expect(data.startCommand).toBe(`cd ${s.ctx.root} && bun run start`);
    expect(leakedSecrets(text)).toEqual([]);
    expect(text).not.toContain(FAKE.userId);
  });

  test("Schritt: nur Feld-Metadaten und „gesetzt“, nie Werte, keine Funktionen", async () => {
    const { s, cookie } = await start(readyOptions());
    const { text, data } = await body(await get(s, "/api/setup/steps/telegram", cookie));
    expect(data.fields).toEqual([
      expect.objectContaining({ name: "TELEGRAM_BOT_TOKEN", kind: "secret", required: true, visible: true, set: true, link: "https://t.me/BotFather" }),
      expect.objectContaining({ name: "TELEGRAM_USER_ID", kind: "text", required: true, visible: true, set: true }),
    ]);
    for (const f of data.fields) {
      expect(f).not.toHaveProperty("value");
      expect(f).not.toHaveProperty("validate");
      expect(f).not.toHaveProperty("visible", undefined);
    }
    expect(data).toMatchObject({ canTest: true, canApply: true, applyAtFinish: false });
    expect(leakedSecrets(text)).toEqual([]);
    expect(text).not.toContain(FAKE.userId);

    for (const id of ["voraussetzungen", "gruppe", "datenbank", "suche", "profil", "modelle", "webui", "autostart", "pruefung"]) {
      const step = await body(await get(s, `/api/setup/steps/${id}`, cookie));
      expect(leakedSecrets(step.text)).toEqual([]);
      expect(step.text).not.toContain(FAKE.convexUrl);
    }
    expect((await get(s, "/api/setup/steps/gibtsnicht", cookie)).status).toBe(404);
  });

  test("Sichtbarkeit berechnet der Server, aus Auswahlfeldern; Geheimnisse gehen dafür nie hin", async () => {
    const { s, cookie } = await start({ env: "" });
    const visible = async (values: Record<string, string>) => {
      const { data } = await body(await post(s, "/api/setup/steps/datenbank/view", { values }, cookie));
      return data.fields.filter((f: any) => f.visible).map((f: any) => f.name);
    };
    // Standard (Issue #163): Supabase in der Cloud mit Token, Organisation, Name und Region
    expect(await visible({})).toEqual(["DB_BACKEND", "SUPABASE_SETUP_TOKEN", "SUPABASE_ORG", "SUPABASE_PROJECT_NAME", "SUPABASE_REGION"]);
    expect(await visible({ DB_BACKEND: "convex" })).toEqual(["DB_BACKEND", "CONVEX_URL", "CONVEX_AUTH_TOKEN"]);
    expect(await visible({ DB_BACKEND: "supabase" })).toEqual(["DB_BACKEND", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"]);
    // Mit Convex in der .env erscheint beim Wechsel die Bestätigung
    const withConvex = await start({ env: FULL_ENV });
    const { data } = await body(await post(withConvex.s, "/api/setup/steps/datenbank/view", { values: { DB_BACKEND: "supabase" } }, withConvex.cookie));
    expect(data.fields.find((f: any) => f.name === "DB_SWITCH_CONFIRM").visible).toBe(true);
    const webui = await body(await post(s, "/api/setup/steps/webui/view", { values: { WEB_ENABLED: "true" } }, cookie));
    expect(webui.data.fields.every((f: any) => f.visible)).toBe(true);
  });
});

describe("Telegram über den Port", () => {
  test("schreibt Token und Nutzer-ID in die temporäre .env, testet damit; Antworten ohne Werte", async () => {
    const { s, cookie } = await start({ env: "# Kommentar bleibt\nUSER_NAME=Testperson\n" });
    const values = { TELEGRAM_BOT_TOKEN: FAKE.token, TELEGRAM_USER_ID: FAKE.userId };

    const tested = await post(s, "/api/setup/steps/telegram/test", { values }, cookie);
    expect(tested.status).toBe(200);
    const t = await body(tested);
    expect(t.data.ok).toBe(true);
    expect(s.ctx.providers.calls.map(c => c.method)).toEqual(["telegramGetMe", "telegramSendTest"]);
    expect(s.ctx.providers.calls[0].args).toEqual([FAKE.token]);
    expect(s.ctx.providers.calls[1].args.slice(0, 2)).toEqual([FAKE.token, FAKE.userId]);
    expect(leakedSecrets(t.text)).toEqual([]);
    // Test schreibt nichts
    expect((await envOf(s)).TELEGRAM_BOT_TOKEN).toBeUndefined();

    const saved = await post(s, "/api/setup/steps/telegram/apply", { values }, cookie);
    expect(saved.status).toBe(200);
    const a = await body(saved);
    expect(a.data).toEqual({ ok: true, message: "Gespeichert.", changed: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID"] });
    expect(leakedSecrets(a.text)).toEqual([]);
    const env = await envOf(s);
    expect(env.TELEGRAM_BOT_TOKEN).toBe(FAKE.token);
    expect(env.TELEGRAM_USER_ID).toBe(FAKE.userId);
    expect(await readFile(s.ctx.envPath, "utf8")).toContain("# Kommentar bleibt");

    // Danach: „gesetzt“, Test mit leeren Feldern nutzt die gespeicherten Werte
    const after = await body(await get(s, "/api/setup/steps/telegram", cookie));
    expect(after.data.state).toBe("erledigt");
    expect(after.data.fields.map((f: any) => f.set)).toEqual([true, true]);
    expect(leakedSecrets(after.text)).toEqual([]);
    expect(after.text).not.toContain(FAKE.userId);
    const again = await post(s, "/api/setup/steps/telegram/test", { values: { TELEGRAM_BOT_TOKEN: "", TELEGRAM_USER_ID: "" } }, cookie);
    expect((await again.json()).ok).toBe(true);
    expect(s.ctx.providers.calls.at(-2)!.args).toEqual([FAKE.token]);
    expect(s.logs.join("\n")).toContain("Schritt telegram gespeichert: TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID");
    expect(leakedSecrets(s.logs.join("\n"))).toEqual([]);
  });

  test("Geheimnis, das ein Anbieter doch zurückgibt, erscheint nur als ***", async () => {
    const { s, cookie } = await start({ env: FULL_ENV });
    s.ctx.providers.results.telegramGetMe = { ok: false, message: `Fehler bei ${FAKE.token} und ${FAKE.webPassword}` };
    const { text, data } = await body(await post(s, "/api/setup/steps/telegram/test", { values: {} }, cookie));
    expect(data.message).toBe("Fehler bei *** und ***");
    expect(leakedSecrets(text)).toEqual([]);
  });

  test("eingetragene, nicht geheime Werte (Adresse, Nutzer-ID) kommen über Anbieterfehler nicht zurück", async () => {
    const url = "https://example.convex.site";
    const failing = (s: Started) => {
      s.ctx.providers.results.convexQuery = {
        ok: false,
        message: `Convex ist nicht erreichbar (Unable to connect to ${url}/api/query, Host example.convex.site, ${url}/). Adresse prüfen.`,
      };
      s.ctx.providers.results.telegramGetMe = { ok: false, message: `Nutzer ${FAKE.userId} unbekannt` };
    };
    const expectClean = (text: string) => {
      expect(text).not.toContain("example.convex.site");
      expect(text).not.toContain(encodeURIComponent(url));
      expect(text).not.toContain(FAKE.userId);
      expect(leakedSecrets(text)).toEqual([]);
    };

    // Gespeichert in der .env
    const saved = await start({ env: FULL_ENV.replace(FAKE.convexUrl, url) });
    failing(saved.s);
    const db = await body(await post(saved.s, "/api/setup/steps/datenbank/test", { values: {} }, saved.cookie));
    expect(db.data.ok).toBe(false);
    expect(db.data.message).toContain("Convex ist nicht erreichbar");
    expectClean(db.text);
    const tg = await body(await post(saved.s, "/api/setup/steps/telegram/test", { values: {} }, saved.cookie));
    expect(tg.data.message).toBe("Nutzer *** unbekannt");
    const check = await body(await post(saved.s, "/api/setup/steps/pruefung/test", { values: {} }, saved.cookie));
    expectClean(check.text);

    // Nur eingegeben, noch nicht gespeichert
    const entered = await start({ env: "" });
    failing(entered.s);
    const res = await post(entered.s, "/api/setup/steps/datenbank/test", { values: { DB_BACKEND: "convex", CONVEX_URL: url, CONVEX_AUTH_TOKEN: FAKE.convexToken } }, entered.cookie);
    const e = await body(res);
    expect(entered.s.ctx.providers.calls.at(-1)!.args[0]).toBe(url);
    expect(e.data.ok).toBe(false);
    expectClean(e.text);
  });

  test("ungültige Eingabe: Fehlertext ohne Wert, nichts geschrieben", async () => {
    const { s, cookie } = await start({ env: "" });
    const res = await post(s, "/api/setup/steps/telegram/apply", { values: { TELEGRAM_BOT_TOKEN: "kaputt-geheim-123", TELEGRAM_USER_ID: "abc" } }, cookie);
    expect(res.status).toBe(422);
    const { text, data } = await body(res);
    expect(data.ok).toBe(false);
    expect(text).not.toContain("kaputt-geheim-123");
    expect(await envOf(s)).toEqual({});
  });
});

describe("nur bekannte Felder", () => {
  test("fremde Namen, auch geschützte, werden abgelehnt: 400, .env bleibt", async () => {
    const { s, cookie } = await start({ env: FULL_ENV });
    const before = await readFile(s.ctx.envPath, "utf8");
    const cases: Array<[string, Record<string, unknown>]> = [
      ["telegram", { WEB_PASSWORD: "neues-test-passwort-1" }],
      ["telegram", { TELEGRAM_BOT_TOKEN_RESEARCH: FAKE.token }],
      ["webui", { TELEGRAM_BOT_TOKEN: FAKE.token }],
      ["profil", { ANTHROPIC_API_KEY: "sk-ant-irgendwas" }],
      ["telegram", { TELEGRAM_USER_ID: 42 }],
      ["telegram", { TELEGRAM_USER_ID: "1".repeat(9000) }],
    ];
    for (const [step, values] of cases) {
      for (const action of ["test", "apply", "view"]) {
        const res = await post(s, `/api/setup/steps/${step}/${action}`, { values }, cookie);
        expect(res.status).toBe(400);
        const text = await res.text();
        for (const v of Object.values(values)) expect(text).not.toContain(String(v));
      }
    }
    for (const bad of [[], "text", { values: [] }, { values: "x" }]) {
      expect((await post(s, "/api/setup/steps/telegram/apply", bad, cookie)).status).toBe(400);
    }
    expect(await readFile(s.ctx.envPath, "utf8")).toBe(before);
    expect(s.ctx.providers.calls).toEqual([]);
  });

  test("WEB_* über den Schritt WebUI setzbar (Ausnahme im Einrichtungsmodus)", async () => {
    const { s, cookie } = await start({ env: FULL_ENV });
    const res = await post(s, "/api/setup/steps/webui/apply", { values: { WEB_ENABLED: "true", WEB_PASSWORD: "ganz-neues-test-passwort-2", WEB_PORT: "3155" } }, cookie);
    const { text, data } = await body(res);
    expect(data.ok).toBe(true);
    expect(data.changed).toEqual(["WEB_PASSWORD", "WEB_PORT"]);
    expect(text).not.toContain("ganz-neues-test-passwort-2");
    expect((await envOf(s)).WEB_PASSWORD).toBe("ganz-neues-test-passwort-2");
  });

  test("die normale Schlüssel-API der WebUI sperrt TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID und WEB_* weiter", async () => {
    const file = new Map<string, string>([["WEB_ALLOW_KEY_EDIT", "true"]]);
    const keys = createKeysApi(
      {
        read: async () => Object.fromEntries(file),
        set: async (name, value) => void file.set(name, value),
        remove: async name => file.delete(name),
        running: () => Object.fromEntries(file),
        editEnabledAtStart: () => true,
      },
      () => {},
    );
    for (const name of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID", "WEB_PASSWORD", "WEB_HOST"]) {
      const res = await keys.put(name, JSON.stringify({ value: "irgendein-wert-1234" }));
      expect(res.status).toBe(403);
      expect((res.body as any).locked).toBe(true);
    }
    expect(file.size).toBe(1);
  });
});

describe("kein Claude-Aufruf, kein Autostart über „Speichern“", () => {
  test("Voraussetzungen testen: Claude CLI nur per --version, der Probeaufruf ist ersetzt", async () => {
    const { s, cookie } = await start({ env: FULL_ENV });
    const { data } = await body(await post(s, "/api/setup/steps/voraussetzungen/test", { values: {} }, cookie));
    expect(data.ok).toBe(true);
    expect(data.message).toBe(`Bun, Claude CLI und Git sind da. ${CLAUDE_LOGIN_NOT_CHECKED}`);
    expect(data.message).not.toContain("angemeldet und");
    expect(data.items.map((i: any) => i.label)).toEqual(["Bun", "Claude CLI", "Git"]);
    expect(s.ctx.providers.calls.map(c => c.method)).toEqual(["claudeVersion"]);
  });

  test("käme der Probeaufruf doch, gälte er nie als angemeldet", async () => {
    const { fakeProviders } = await import("./setup-fixture");
    const inner = fakeProviders();
    const r = await noModelProviders(inner).claudeProbe("claude");
    expect(r).toEqual({ ok: false, message: CLAUDE_LOGIN_NOT_CHECKED });
    expect(inner.calls).toEqual([]);
  });

  test("Gesamtprüfung testet alles Eingerichtete, ohne Modellaufruf", async () => {
    const { s, cookie } = await start(readyOptions());
    const res = await post(s, "/api/setup/steps/pruefung/test", { values: {} }, cookie);
    const { text, data } = await body(res);
    expect(data.items.map((i: any) => i.label)).toContain("Telegram");
    expect(data.items.find((i: any) => i.label === "Voraussetzungen").detail).toContain(CLAUDE_LOGIN_NOT_CHECKED);
    // Autostart kommt erst bei „Fertig“: kein Fehler in der Gesamtprüfung
    expect(data.ok).toBe(true);
    expect(data.message).toBe("Alles Eingerichtete ist erreichbar.");
    const summary = (await body(await get(s, "/api/setup/steps/pruefung", cookie))).data;
    expect(summary.state).toBe("erledigt");
    expect(summary.detail).toBe("Alle Pflichtangaben sind da. „Fertig“ schließt die Einrichtung ab.");
    expect(summary.items.find((i: any) => i.label === "Autostart")).toEqual({
      label: "Autostart", ok: false, optional: true, detail: "Noch kein Autostart über launchd. Kann bei „Fertig“ eingerichtet werden.",
    });
    // Convex: Semantische Suche gilt nur für Supabase, optional und offen (Issue #166)
    expect(summary.items.filter((i: any) => !i.ok).map((i: any) => i.label)).toEqual(["Semantische Suche", "Autostart"]);
    expect(summary.items.find((i: any) => i.label === "Semantische Suche")).toMatchObject({ ok: false, optional: true });
    expect(summary.items.find((i: any) => i.label === "Telegram")).toMatchObject({ ok: true, optional: false });
    expect(s.ctx.providers.calls.some(c => c.method === "claudeProbe")).toBe(false);
    expect(leakedSecrets(text)).toEqual([]);
    expect((await post(s, "/api/setup/steps/pruefung/apply", { values: {} }, cookie)).status).toBe(409);
  });

  test("Autostart: Test ja, Speichern 409, kein launchctl load", async () => {
    const { s, cookie } = await start({ env: FULL_ENV, profile: PROFILE });
    const step = (await body(await get(s, "/api/setup/steps/autostart", cookie))).data;
    expect(step).toMatchObject({ canTest: true, canApply: false, applyAtFinish: true });
    expect((await post(s, "/api/setup/steps/autostart/apply", { values: {} }, cookie)).status).toBe(409);
    expect(s.ctx.run.calls.some(c => c[0] === "launchctl" && c[1] === "load")).toBe(false);
  });
});

describe("Antwortfilter: gespeicherte und zwischenzeitlich geänderte Werte", () => {
  const MODEL = "privat-modell-xyz:13b";
  const unfiltered = (text: string, value: string) => [value, "privat-modell-xyz"].filter(v => text.includes(v));

  async function savedModel() {
    const { s, cookie } = await start(readyOptions());
    // Ollama kennt nur qwen3:8b
    const saved = await post(s, "/api/setup/steps/modelle/apply", { values: { OLLAMA_MODEL: MODEL } }, cookie);
    expect(saved.status).toBe(200);
    expect(await readFile(s.ctx.settingsPath, "utf8")).toContain(MODEL);
    return { s, cookie };
  }

  function itemTexts(data: any): string[] {
    return [data.message, ...(data.items ?? []).flatMap((i: any) => [i.detail, i.fix ?? ""])];
  }

  test("Modellschritt mit leeren Feldern: gespeicherter Ollama-Modellname nie in message, detail, fix", async () => {
    const { s, cookie } = await savedModel();
    const { text, data } = await body(await post(s, "/api/setup/steps/modelle/test", { values: {} }, cookie));
    const ollama = data.items.find((i: any) => i.label === "Ollama");
    expect(ollama.ok).toBe(false);
    expect(ollama.fix).toBeDefined();
    for (const t of itemTexts(data)) expect(unfiltered(t, MODEL)).toEqual([]);
    expect(unfiltered(text, MODEL)).toEqual([]);
    expect(s.ctx.providers.calls.some(c => c.method === "ollamaTags")).toBe(true);
  });

  test("Gesamtprüfung: gespeicherter Ollama-Modellname nie in message, detail, fix", async () => {
    const { s, cookie } = await savedModel();
    const { text, data } = await body(await post(s, "/api/setup/steps/pruefung/test", { values: {} }, cookie));
    expect(data.ok).toBe(false);
    expect(data.items.find((i: any) => i.label === "Modelle und Fallback")?.ok).toBe(false);
    for (const t of itemTexts(data)) expect(unfiltered(t, MODEL)).toEqual([]);
    expect(unfiltered(text, MODEL)).toEqual([]);
  });

  test("parallel: neue CONVEX_URL wird gespeichert, während die Warteschlange blockiert ist; der Test dahinter gibt sie nicht zurück", async () => {
    const NEW_URL = "https://brave-lynx-456.convex.cloud";
    const ctx = await makeCtx(readyOptions());
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let blocked!: () => void;
    const inQueue = new Promise<void>(r => (blocked = r));
    // Hält die Warteschlange an, bis die beiden anderen Anfragen dahinter stehen
    ctx.providers.telegramGetMe = async () => {
      blocked();
      await gate;
      return { ok: true, message: "Verbunden mit @test_bot", username: "test_bot" } as any;
    };
    // Anbieter-Attrappe nennt die Adresse im Fehler, wie echte Fehlertexte es tun
    ctx.providers.convexQuery = async (url: string | undefined) => ({ ok: false, message: `Keine Antwort von ${url} (Host ${new URL(url!).host})` });
    const { s, cookie } = await start({ ctx });

    const blocking = post(s, "/api/setup/steps/telegram/test", { values: {} }, cookie);
    await inQueue;
    const saving = post(s, "/api/setup/steps/datenbank/apply", { values: { DB_BACKEND: "convex", CONVEX_URL: NEW_URL } }, cookie);
    while (s.server.queued() < 2) await Bun.sleep(1);
    const testing = post(s, "/api/setup/steps/datenbank/test", { values: {} }, cookie);
    while (s.server.queued() < 3) await Bun.sleep(1);
    release();

    expect((await blocking).status).toBe(200);
    expect((await saving).status).toBe(200);
    expect((await envOf(s)).CONVEX_URL).toBe(NEW_URL);
    const { text, data } = await body(await testing);
    expect(data.ok).toBe(false);
    for (const v of [NEW_URL, "brave-lynx-456.convex.cloud", FAKE.convexUrl]) expect(text).not.toContain(v);
    expect(leakedSecrets(text)).toEqual([]);
  });
});

describe("Antwortfilter: kurze Werte unter vier Zeichen", () => {
  const SHORT = "phi";
  // Als eigenes Wort, wie es in Meldungen steht („Modell phi fehlt“, „ollama pull phi“)
  const leaks = (text: string) => /(?<![\p{L}\p{N}])phi(?![\p{L}\p{N}])/u.test(text);

  function itemTexts(data: any): string[] {
    return [data.message, ...(data.items ?? []).flatMap((i: any) => [i.detail, i.fix ?? ""])];
  }

  async function savedShort() {
    const { s, cookie } = await start(readyOptions());
    const saved = await post(s, "/api/setup/steps/modelle/apply", { values: { OLLAMA_MODEL: SHORT } }, cookie);
    expect(saved.status).toBe(200);
    expect(await readFile(s.ctx.settingsPath, "utf8")).toContain(`"ollamaModel": "${SHORT}"`);
    return { s, cookie };
  }

  test("direkt eingegeben: OLLAMA_MODEL=phi nie in message, detail, fix", async () => {
    const { s, cookie } = await start(readyOptions());
    const { text, data } = await body(await post(s, "/api/setup/steps/modelle/test", { values: { OLLAMA_MODEL: SHORT } }, cookie));
    const ollama = data.items.find((i: any) => i.label === "Ollama");
    expect(ollama.ok).toBe(false);
    expect(ollama.fix).toBe("ollama pull ***");
    for (const t of itemTexts(data)) expect(leaks(t)).toBe(false);
    expect(leaks(text)).toBe(false);
  });

  test("gespeichert, dann mit leeren Feldern getestet: phi nie in message, detail, fix", async () => {
    const { s, cookie } = await savedShort();
    const { text, data } = await body(await post(s, "/api/setup/steps/modelle/test", { values: {} }, cookie));
    const ollama = data.items.find((i: any) => i.label === "Ollama");
    expect(ollama.ok).toBe(false);
    expect(ollama.fix).toBe("ollama pull ***");
    for (const t of itemTexts(data)) expect(leaks(t)).toBe(false);
    expect(leaks(text)).toBe(false);
  });

  test("Gesamtprüfung mit gespeichertem phi: nie in message, detail, fix", async () => {
    const { s, cookie } = await savedShort();
    const { text, data } = await body(await post(s, "/api/setup/steps/pruefung/test", { values: {} }, cookie));
    expect(data.ok).toBe(false);
    expect(data.items.find((i: any) => i.label === "Modelle und Fallback")?.ok).toBe(false);
    for (const t of itemTexts(data)) expect(leaks(t)).toBe(false);
    expect(leaks(text)).toBe(false);
  });

  test("redactKnown: kurzer Wert als Wort ersetzt, mitten in einem Wort ganze Meldung ausgeblendet", () => {
    expect(redactKnown("Modell phi fehlt, ollama pull phi:latest", [SHORT])).toBe("Modell *** fehlt, ollama pull ***:latest");
    expect(redactKnown("Fehler bei xphiy", [SHORT])).toBe(REDACTED_MESSAGE);
    expect(redactKnown("Wert q ist falsch", ["q"])).toBe("Wert *** ist falsch");
    expect(redactKnown("Wert q in quark", ["q"])).toBe(REDACTED_MESSAGE);
    expect(redactKnown("Adresse https://a.example/x?k=a%20b", ["a b"])).toBe("Adresse https://a.example/x?k=***");
    expect(redactKnown("x".repeat(700), []).length).toBe(601);
  });
});
