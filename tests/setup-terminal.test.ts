/**
 * Issue #65, Checkbox 1: Ablauf und Übersicht von `tybo setup` mit
 * simulierten Eingaben. Jeder Fall hat seinen eigenen temporären
 * Projektordner (tests/setup-fixture.ts); Anbieter, launchctl und PM2 sind
 * Attrappen.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseEnvContent } from "../src/lib/env-file";
import { parseAnswer, parseSelection } from "../src/setup/terminal";
import { DATABASE_FIELDS } from "../src/setup/steps/database";
import { cleanup, FAKE, FULL_ENV, leakedSecrets } from "./setup-fixture";
import { linuxCtx, runWith, scripted } from "./setup-terminal-fixture";

afterAll(cleanup);

/** Antworten für einen vollständigen Durchlauf auf leerer Konfiguration */
const FULL_RUN = [
  "", // Auswahl nach der Übersicht: nur offene Schritte
  // Telegram (optional seit Issue #228)
  "j",
  FAKE.token,
  FAKE.userId,
  "", // Speichern? (Standard Ja)
  // Forum-Gruppe (optional)
  "n",
  // Datenbank
  "4", // Convex (seit Issue #164 an vierter Stelle)
  FAKE.convexUrl,
  FAKE.convexToken,
  "j",
  // Semantische Suche (optional, Issue #166)
  "n",
  // Profil
  "Testperson",
  "Europe/Berlin",
  "", // Beruf leer
  "",
  // Modelle (optional)
  "n",
  // WebUI (optional)
  "j",
  "j", // einschalten
  FAKE.webPassword,
  "2", // Heimnetz
  "", // Port Standard
  "",
  // Zugang vom Handy (optional, Issue #231)
  "n",
  // Autostart
  "j",
];

describe("tybo setup: Durchlauf", () => {
  test("leere Konfiguration bis zur fertigen .env im temporären Ordner", async () => {
    const ctx = await linuxCtx();
    expect(existsSync(ctx.envPath)).toBe(false);
    const prompter = scripted(FULL_RUN);
    const r = await runWith({ mode: "all" }, ctx, prompter);

    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    const env = parseEnvContent(await readFile(ctx.envPath, "utf8"));
    expect(env).toMatchObject({
      TELEGRAM_BOT_TOKEN: FAKE.token,
      TELEGRAM_USER_ID: FAKE.userId,
      CONVEX_URL: FAKE.convexUrl,
      CONVEX_AUTH_TOKEN: FAKE.convexToken,
      USER_NAME: "Testperson",
      USER_TIMEZONE: "Europe/Berlin",
      WEB_ENABLED: "true",
      WEB_PASSWORD: FAKE.webPassword,
      WEB_HOST: "0.0.0.0",
    });
    expect(env.TELEGRAM_GROUP_ID).toBeUndefined();
    expect(existsSync(ctx.profilePath)).toBe(true);
    // Autostart nur nach Bestätigung, über die PM2-Attrappe, nie echt
    expect(ctx.run.calls.some(c => c.join(" ").startsWith("pm2 start bun"))).toBe(true);

    // Übersicht vor den Schritten, mit Status
    expect(r.out).toMatch(/1\. Voraussetzungen\s+erledigt/);
    expect(r.out).toMatch(/2\. Telegram \(optional\)\s+fehlt/);
    expect(r.out).toMatch(/3\. Forum-Gruppe \(optional\)\s+fehlt/);
    expect(r.out).toContain("11. Gesamtprüfung");
    expect(r.out.indexOf("11. Gesamtprüfung")).toBeLessThan(r.out.indexOf("Schritt 1 von"));

    // Verbindungstests mit Ergebnis, Gesamtprüfung am Ende
    expect(r.out).toContain("Verbindungstest: bestanden. Verbunden mit @test_bot");
    expect(r.out).toContain("Verbindungstest: bestanden. Convex erreichbar.");
    expect(r.out).toContain("Alles eingerichtet und erreichbar.");

    // Ende: Zusammenfassung, nächster Schritt, tybo und WebUI-Adresse
    expect(r.out).toContain("Gespeichert: Telegram, Datenbank, Profil, WebUI, Autostart");
    expect(r.out).toContain("Übersprungen: Forum-Gruppe, Semantische Suche, Modelle und Fallback");
    expect(r.out).toContain("Alle Pflichtschritte sind erledigt.");
    expect(r.out).toContain("tybo läuft über den Autostart");
    expect(r.out).toContain("Chat im Terminal mit tybo");
    expect(r.out).toContain("http://127.0.0.1:3100");
    expect(r.out).toContain("http://192.168.1.50:3100");

    // Geheime Felder verdeckt gefragt, nie in der Ausgabe
    const secretQuestions = prompter.asked.filter(a => a.secret).map(a => a.question);
    expect(secretQuestions).toEqual(["Bot-Token: ", "Convex-Zugangstoken: ", "Passwort der WebUI: "]);
    expect(leakedSecrets(r.out)).toEqual([]);
  });

  test("erneuter Lauf überspringt Erledigtes und ändert nichts", async () => {
    const ctx = await linuxCtx();
    await runWith({ mode: "all" }, ctx, scripted(FULL_RUN));
    const before = await readFile(ctx.envPath, "utf8");

    // Nur noch die offenen optionalen Schritte werden angeboten
    const prompter = scripted(["", "n", "n", "n", "n"]);
    const r = await runWith({ mode: "all" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(prompter.asked.map(a => a.question)).toEqual([
      expect.stringContaining("Erledigte trotzdem bearbeiten?"),
      "Jetzt einrichten? [J/n] ",
      "Jetzt einrichten? [J/n] ",
      "Jetzt einrichten? [J/n] ",
      "Jetzt einrichten? [J/n] ",
    ]);
    expect(r.out).toContain("Schritt 1 von 4: Forum-Gruppe (optional)");
    expect(r.out).toContain("Schritt 2 von 4: Semantische Suche (optional)");
    expect(r.out).toContain("Schritt 3 von 4: Modelle und Fallback (optional)");
    expect(r.out).toContain("Schritt 4 von 4: Zugang vom Handy (optional)");
    expect(r.out).not.toContain("Bot-Token");
    expect(await readFile(ctx.envPath, "utf8")).toBe(before);
    // Gesamtprüfung läuft trotzdem mit den gespeicherten Werten
    expect(r.out).toContain("Alles eingerichtet und erreichbar.");
  });

  test("erledigten Schritt auswählen: wird gezeigt, leere Eingaben behalten die Werte", async () => {
    const ctx = await linuxCtx({ env: FULL_ENV, profile: "# Testperson\n" });
    const before = await readFile(ctx.envPath, "utf8");
    // Auswahl 2 = Telegram; Enter behält Token und Nutzer-ID; offen sind noch Semantische Suche, Zugang vom Handy und Autostart (alle abgelehnt)
    const prompter = scripted(["2", "", "", "n", "n", "n"]);
    const r = await runWith({ mode: "all" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(r.out).toContain("Schritt 1 von 4: Telegram");
    expect(r.out).toContain("Ist gesetzt. Enter behält den bisherigen Wert.");
    expect(r.out).toContain("Keine neuen Eingaben, alles bleibt, wie es ist.");
    // Gesetzte Werte werden nie angezeigt
    expect(r.out).not.toContain(FAKE.userId);
    expect(leakedSecrets(r.out)).toEqual([]);
    expect(await readFile(ctx.envPath, "utf8")).toBe(before);
  });

  test("übersprungener Pflichtschritt bleibt als offen gemeldet", async () => {
    const ctx = await linuxCtx();
    const answers = [...FULL_RUN];
    answers[answers.length - 1] = "n"; // Autostart ablehnen
    const r = await runWith({ mode: "all" }, ctx, scripted(answers));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Nicht gespeichert.");
    expect(r.out).toContain("Noch offen (Pflicht): Autostart");
    expect(r.out).toContain(`Zum Ausprobieren starten: cd ${ctx.root} && bun run start`);
    expect(r.out).toContain("tybo setup autostart");
    expect(ctx.run.calls.some(c => c[1] === "start")).toBe(false);
  });

  test("WebUI aus: kein Versprechen von Terminal-Chat oder Adresse", async () => {
    const ctx = await linuxCtx();
    const answers = [...FULL_RUN];
    const at = answers.indexOf(FAKE.webPassword);
    // WebUI-Schritt überspringen: statt "j", "j", Passwort, "2", "", "" nur "n"; ohne WebUI kommt der Zugang vom Handy ohne Frage
    answers.splice(at - 2, 7, "n");
    const r = await runWith({ mode: "all" }, ctx, scripted(answers));
    expect(r.code).toBe(0);
    expect(r.out).toContain("WebUI ist aus.");
    expect(r.out).toContain("Ohne WebUI gibt es keinen Zugang vom Handy: übersprungen.");
    expect(r.out).not.toContain("http://127.0.0.1");
    expect(r.out).not.toContain("Chat im Terminal mit tybo");
  });
});

/** Issue #228: Durchlauf ohne Telegram, nur mit WebUI */
const WEB_ONLY_RUN = [
  "", // Auswahl: nur offene Schritte
  "n", // Telegram: Jetzt einrichten? nein
  // WebUI kommt als nächster Schritt
  "j",
  "j", // einschalten
  FAKE.webPassword,
  "1", // Nur dieser Rechner
  "", // Port Standard
  "", // Speichern
  // Forum-Gruppe: ohne Telegram ohne Frage übersprungen
  // Datenbank
  "4",
  FAKE.convexUrl,
  FAKE.convexToken,
  "j",
  "n", // Semantische Suche
  "Testperson",
  "Europe/Berlin",
  "",
  "",
  "n", // Modelle
  "n", // Zugang vom Handy (Issue #231)
  "j", // Autostart
];

describe("Issue #228: tybo setup ohne Telegram", () => {
  test("Telegram übersprungen, WebUI eingerichtet: fertig, WebUI als nächster Schritt, Gruppe ohne Frage übersprungen", async () => {
    const ctx = await linuxCtx();
    const prompter = scripted(WEB_ONLY_RUN);
    const r = await runWith({ mode: "all" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    const env = parseEnvContent(await readFile(ctx.envPath, "utf8"));
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.WEB_ENABLED).toBe("true");
    // Die WebUI kommt direkt nach Telegram, vor Forum-Gruppe und Datenbank
    expect(r.out).toContain("Ohne Telegram brauchst du die WebUI, sonst erreicht dich tybo nirgends. Sie kommt als nächster Schritt.");
    expect(r.out).toContain("Schritt 2 von 9: WebUI (optional)");
    expect(r.out).toContain("Ohne Telegram gibt es keine Forum-Gruppe: übersprungen.");
    expect(r.out.indexOf("WebUI (optional)")).toBeLessThan(r.out.indexOf("Forum-Gruppe (optional)\n"));
    expect(r.out).toContain("Alle Pflichtschritte sind erledigt.");
    expect(r.out).not.toContain("Noch offen");
    // Endtext passend zum Kanal: WebUI, kein Telegram-Satz
    expect(r.out).toContain("tybo läuft über den Autostart. Öffne die WebUI unter http://127.0.0.1:3100.");
    expect(r.out).not.toContain("Schreib deinem Bot in Telegram");
    expect(ctx.providers.calls.filter(c => c.method.startsWith("telegram"))).toEqual([]);
    expect(leakedSecrets(r.out)).toEqual([]);
  });

  test("Telegram und WebUI übersprungen: WebUI nur nach Rückfrage mit dem Kanal-Satz, danach offen", async () => {
    const ctx = await linuxCtx();
    const answers = [...WEB_ONLY_RUN];
    // WebUI: nein, dann „Trotzdem überspringen?“ ja
    answers.splice(2, 6, "n", "j");
    answers.splice(answers.length - 2, 1); // ohne WebUI kommt der Zugang vom Handy ohne Frage
    answers[answers.length - 1] = "n"; // Autostart ablehnen
    const prompter = scripted(answers);
    const r = await runWith({ mode: "all" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(prompter.asked.map(a => a.question)).toContain("Trotzdem überspringen? [j/N] ");
    expect(r.out).toContain("Noch offen: Richte Telegram oder die WebUI ein, sonst erreicht dich tybo nirgends.");
    expect(r.out).not.toContain("Noch offen (Pflicht): Telegram");
    expect(r.out).not.toContain("Alle Pflichtschritte sind erledigt.");
    expect(r.out).toContain("Erst fertig einrichten: tybo setup (oder einzeln: tybo setup telegram, tybo setup webui)");
  });

  test("Rückfrage verneint: die WebUI wird doch eingerichtet", async () => {
    const ctx = await linuxCtx();
    const answers = [...WEB_ONLY_RUN];
    // WebUI: nein, dann „Trotzdem überspringen?“ Enter (nein), danach die Felder wie sonst
    answers.splice(2, 1, "n", "");
    const prompter = scripted(answers);
    const r = await runWith({ mode: "all" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(parseEnvContent(await readFile(ctx.envPath, "utf8")).WEB_ENABLED).toBe("true");
    expect(r.out).toContain("Alle Pflichtschritte sind erledigt.");
  });

  test("Telegram halb eingerichtet und übersprungen: offen, auch mit WebUI", async () => {
    const env = FULL_ENV.split("\n").filter(l => !l.startsWith("TELEGRAM_USER_ID=")).join("\n");
    const ctx = await linuxCtx({ env, profile: "# Testperson\n" });
    // Auswahl Enter, Telegram nein, Semantische Suche nein, Zugang vom Handy nein, Autostart nein
    const prompter = scripted(["", "n", "n", "n", "n"]);
    const r = await runWith({ mode: "all" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(r.out).toMatch(/2\. Telegram \(optional\)\s+teilweise/);
    expect(r.out).toContain("Noch offen: Telegram halb eingerichtet: TELEGRAM_BOT_TOKEN ist gesetzt, TELEGRAM_USER_ID fehlt. Beide Werte setzen oder beide entfernen.");
    // Mit gültiger WebUI kein Zwang zur WebUI, aber auch kein „fertig“
    expect(r.out).not.toContain("Sie kommt als nächster Schritt.");
    expect(r.out).not.toContain("Alle Pflichtschritte sind erledigt.");
  });

  test("Endtext mit Telegram und WebUI: beides", async () => {
    const ctx = await linuxCtx();
    const r = await runWith({ mode: "all" }, ctx, scripted(FULL_RUN));
    expect(r.out).toContain("tybo läuft über den Autostart. Schreib deinem Bot in Telegram oder öffne die WebUI unter http://127.0.0.1:3100.");
  });
});

describe("Gesamtprüfung schlägt fehl", () => {
  /** Anderes, gültig aussehendes Token; das aus FULL_ENV lehnt Telegram ab */
  const NEW_TOKEN = "987654321:AANeuesTokenFuerTestsOnly_abcdefghijk";

  async function staleTokenCtx() {
    const ctx = await linuxCtx({ env: FULL_ENV, profile: "# Testperson\n" });
    const getMe = ctx.providers.telegramGetMe;
    ctx.providers.telegramGetMe = async token =>
      token === FAKE.token ? { ok: false, message: "Telegram kennt dieses Token nicht." } : getMe(token);
    return ctx;
  }

  test("Durchlauf: gespeichertes Token ungültig, erneut eingeben, danach bestanden", async () => {
    const ctx = await staleTokenCtx();
    // Auswahl Enter, Semantische Suche, Zugang vom Handy und Autostart ablehnen, dann Telegram erneut: neues Token, Nutzer-ID behalten, speichern
    const prompter = scripted(["", "n", "n", "n", "e", NEW_TOKEN, "", ""]);
    const r = await runWith({ mode: "all" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(r.out).toContain("Fehlgeschlagen: Telegram.");
    expect(r.out).toContain("Telegram: Prüfung mit den gespeicherten Werten fehlgeschlagen.");
    expect(prompter.asked.map(a => a.question)).toContain("Telegram erneut eingeben [E] oder überspringen [ü]? ");
    expect(parseEnvContent(await readFile(ctx.envPath, "utf8")).TELEGRAM_BOT_TOKEN).toBe(NEW_TOKEN);
    // Zweite Prüfung bestanden: keine Fehlermeldung in der Zusammenfassung
    expect(r.out).toContain("Gespeichert: Telegram");
    expect(r.out).not.toContain("Gesamtprüfung fehlgeschlagen");
    expect(leakedSecrets(r.out)).toEqual([]);
  });

  test("Durchlauf: ungültiges Token übersprungen, Fehler steht in der Zusammenfassung", async () => {
    const ctx = await staleTokenCtx();
    const before = await readFile(ctx.envPath, "utf8");
    const prompter = scripted(["", "n", "n", "n", "ü"]);
    const r = await runWith({ mode: "all" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    const summary = r.out.slice(r.out.lastIndexOf("Zusammenfassung"));
    expect(summary).toContain("Gesamtprüfung fehlgeschlagen: Telegram");
    expect(summary).toContain("Erst die fehlgeschlagene Prüfung beheben: tybo setup telegram");
    expect(summary).not.toContain("Schreib deinem Bot");
    expect(await readFile(ctx.envPath, "utf8")).toBe(before);
    expect(leakedSecrets(r.out)).toEqual([]);
  });

  test("setup pruefung: fehlgeschlagener Schritt wird angeboten und bleibt gemeldet, wenn übersprungen", async () => {
    const ctx = await staleTokenCtx();
    const prompter = scripted(["ü"]);
    const r = await runWith({ mode: "step", step: "pruefung" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(prompter.asked[0].question).toBe("Telegram erneut eingeben [E] oder überspringen [ü]? ");
    expect(r.out).toContain("Gesamtprüfung fehlgeschlagen: Telegram. Beheben mit: tybo setup telegram");
  });

  test("setup pruefung: erneut eingeben repariert und prüft nochmal", async () => {
    const ctx = await staleTokenCtx();
    const prompter = scripted(["e", NEW_TOKEN, "", ""]);
    const r = await runWith({ mode: "step", step: "pruefung" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(parseEnvContent(await readFile(ctx.envPath, "utf8")).TELEGRAM_BOT_TOKEN).toBe(NEW_TOKEN);
    expect(r.out.match(/Prüfe alle eingerichteten Schritte/g)).toHaveLength(2);
    expect(r.out).not.toContain("Gesamtprüfung fehlgeschlagen");
  });
});

describe("Eingaben deuten", () => {
  test("Auswahl nach Nummer oder Wert, ungültig ist undefined", () => {
    const backend = DATABASE_FIELDS.find(f => f.name === "DB_BACKEND")!;
    expect(parseAnswer(backend, "1")).toBe("supabase-cloud");
    expect(parseAnswer(backend, "2")).toBe("supabase-lokal");
    expect(parseAnswer(backend, "3")).toBe("supabase");
    expect(parseAnswer(backend, "Convex")).toBe("convex");
    expect(parseAnswer(backend, "4")).toBe("convex");
    expect(parseAnswer(backend, "5")).toBeUndefined();
    expect(parseAnswer(backend, " ")).toBe("");
  });

  test("Schrittauswahl: Nummern und Namen, Unbekanntes ist null", () => {
    expect(parseSelection("")).toEqual([]);
    expect(parseSelection("2, 6 telegram")).toEqual(["telegram", "profil"]);
    expect(parseSelection("5 suche")).toEqual(["suche"]);
    expect(parseSelection("12")).toBeNull();
    expect(parseSelection("quatsch")).toBeNull();
  });
});
