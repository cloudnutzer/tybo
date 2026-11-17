/**
 * Issue #566, Aufgaben 1 und 2: Einrichtung eines Servers nur mit Codex,
 * ohne Claude-Konto. Alles läuft gegen Attrappen (tests/setup-fixture.ts):
 * kein Aufruf von Codex, Claude oder systemctl.
 *
 * - Motor codex ohne Claude: voraussetzungen erledigt, Claude nur Hinweis
 *   mit dem Satz aus dem Issue, Einrichtung endet mit dem Erfolgssatz
 * - Codex fehlt oder ist nicht angemeldet: kein Erfolg
 * - Claude Code bleibt Motor: Claude CLI bleibt Pflicht
 * - frischer Gesamtlauf ohne TYBO_ENGINE: Motor im Schritt Modelle wählen
 * - settings.json (engine.default) hat Vorrang vor TYBO_ENGINE
 * - Nebenaufgaben auf OpenRouter heißen nicht abgeschaltet
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createProviders } from "../src/setup/providers";
import { checkStep } from "../src/setup/steps";
import { modelsStep } from "../src/setup/steps/models";
import { prerequisitesStep } from "../src/setup/steps/prerequisites";
import { setupEngine } from "../src/setup/engine";
import { cleanup, FAKE, FULL_ENV, fakeRun, leakedSecrets, makeCtx } from "./setup-fixture";
import { linuxCtx, runWith, scripted } from "./setup-terminal-fixture";

afterAll(cleanup);

const NOT_FOUND = { ok: false, message: "Claude CLI nicht gefunden.", notFound: true };
const LOGGED_OUT = { ok: false, message: "Claude CLI ist nicht angemeldet. Im Terminal „claude“ starten und /login ausführen." };
const CODEX_OK = { ok: true, message: "Codex 0.155.1 ist angemeldet." };
const WARNING = "Claude ist nicht angemeldet: Hintergrund-Jobs und Nebenaufgaben laufen nicht.";

/** Linux-Server ohne Claude-Konto: claude --version scheitert bzw. Probeaufruf meldet „nicht angemeldet“ */
async function serverCtx(options: { env?: string; settings?: string; claude?: "missing" | "logged-out" } = {}) {
  const ctx = await makeCtx({ env: options.env ?? `${FULL_ENV}TYBO_ENGINE=codex\n`, settings: options.settings, overrides: { platform: "linux" } });
  if (options.claude === "missing") ctx.providers.results.claudeVersion = NOT_FOUND;
  if (options.claude === "logged-out") ctx.providers.results.claudeProbe = LOGGED_OUT;
  ctx.providers.results.engineCheck = CODEX_OK;
  return ctx;
}

describe("Schritt voraussetzungen: Motor codex", () => {
  test("ohne Anmeldung bei Claude: erledigt, die fehlende Anmeldung ist nur ein Hinweis mit dem Satz aus dem Issue", async () => {
    const ctx = await serverCtx({ claude: "logged-out" });
    const s = await prerequisitesStep.status(ctx);
    expect(s.state).toBe("erledigt");
    expect(s.items?.map(i => i.label)).toEqual(["Bun", "Codex", "Claude CLI", "Git"]);

    const r = await prerequisitesStep.test!({}, ctx);
    expect(r.ok).toBe(true);
    const login = r.items?.find(i => i.label === "Claude-Anmeldung");
    expect(login).toMatchObject({ ok: false, optional: true, detail: WARNING });
    expect(r.message).toBe(`Alles da, Codex ist bereit. ${WARNING}`);
    // Codex wurde über die Attrappe geprüft, mit Projektordner
    const codex = ctx.providers.calls.find(c => c.method === "engineCheck");
    expect(codex?.args[0]).toBe("codex");
    expect((codex?.args[1] as { cwd: string }).cwd).toBe(ctx.root);
  });

  test("ohne Claude CLI: erledigt, Hinweis statt Fehler, kein Probeaufruf", async () => {
    const ctx = await serverCtx({ claude: "missing" });
    const s = await prerequisitesStep.status(ctx);
    expect(s.state).toBe("erledigt");
    const claude = s.items?.find(i => i.label === "Claude CLI");
    expect(claude).toMatchObject({ ok: false, optional: true });
    expect(claude?.detail).toStartWith("Claude CLI ist nicht installiert: Hintergrund-Jobs und Nebenaufgaben laufen nicht.");
    expect(s.detail).toStartWith("Bun, Codex und Git sind da.");

    const r = await prerequisitesStep.test!({}, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.providers.calls.map(c => c.method)).not.toContain("claudeProbe");
  });

  test("Codex fehlt oder ist nicht angemeldet: kein Erfolg", async () => {
    const ctx = await serverCtx({ claude: "missing" });
    ctx.providers.results.engineCheck = { ok: false, message: "Codex ist nicht angemeldet. Im Terminal „codex login“ ausführen." };
    const s = await prerequisitesStep.status(ctx);
    expect(s.state).toBe("teilweise");
    expect(s.detail).toBe("Fehlt oder zu alt: Codex.");
    const r = await prerequisitesStep.test!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("codex login");
    expect(r.items?.find(i => i.label === "Codex")?.fix).toContain("codex login");
  });

  test("Claude Code bleibt Motor: Claude CLI ist Pflicht, die Meldung nennt den Weg über einen anderen Motor", async () => {
    const ctx = await serverCtx({ env: FULL_ENV, claude: "logged-out" });
    const r = await prerequisitesStep.test!({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.items?.find(i => i.label === "Claude-Anmeldung")).toMatchObject({ ok: false });
    expect(r.items?.find(i => i.label === "Claude-Anmeldung")?.optional).toBeUndefined();
    expect(r.message).toContain("einen anderen Motor wählen, etwa Codex");
    expect(ctx.providers.calls.map(c => c.method)).not.toContain("engineCheck");

    const missing = await serverCtx({ env: FULL_ENV, claude: "missing" });
    expect((await prerequisitesStep.status(missing)).state).toBe("teilweise");
  });

  test("Nebenaufgaben auf OpenRouter heißen nicht abgeschaltet", async () => {
    const ctx = await serverCtx({ env: `${FULL_ENV}TYBO_ENGINE=codex\nAUX_MODEL_REVIEW=openrouter:anbieter/modell\n`, claude: "logged-out" });
    const r = await prerequisitesStep.test!({}, ctx);
    const login = r.items?.find(i => i.label === "Claude-Anmeldung");
    expect(login?.detail).toStartWith("Claude ist nicht angemeldet: Hintergrund-Jobs und die Nebenaufgaben auf Claude laufen nicht (");
    expect(login?.detail).not.toContain("Review");

    // Alle auf OpenRouter: nur noch die Jobs
    const all = ["JUDGE", "DISTILL", "REVIEW", "THREADS", "CALL_SUMMARY", "CHECKIN", "VOICE_TRAINING", "VOICE_WIZARD"].map(n => `AUX_MODEL_${n}=openrouter:anbieter/modell\n`).join("");
    const ctx2 = await serverCtx({ env: `${FULL_ENV}TYBO_ENGINE=codex\n${all}`, claude: "logged-out" });
    const r2 = await prerequisitesStep.test!({}, ctx2);
    expect(r2.items?.find(i => i.label === "Claude-Anmeldung")?.detail).toBe(
      "Claude ist nicht angemeldet: Hintergrund-Jobs laufen nicht, die Nebenaufgaben laufen über OpenRouter oder Ollama.",
    );
  });

  test("Einrichtung im Browser (kein Modellaufruf): Codex geprüft, Erfolg ohne Claude", async () => {
    const ctx = await serverCtx({ claude: "missing" });
    ctx.noModelCalls = true;
    const r = await prerequisitesStep.test!({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.message).toStartWith("Bun, Codex und Git sind da.");
    expect(r.message).toContain("Hintergrund-Jobs und Nebenaufgaben laufen nicht.");
  });
});

describe("Motor: Vorrang wie zur Laufzeit", () => {
  test("engine.default in settings.json vor TYBO_ENGINE, unbekannter Wert zählt nicht", async () => {
    const both = await makeCtx({ env: "TYBO_ENGINE=claude\n", settings: JSON.stringify({ engine: { default: "codex" } }) });
    expect(await setupEngine(both)).toEqual({ engine: "codex", source: "settings" });
    expect(await setupEngine(await makeCtx({ env: "TYBO_ENGINE=Codex\n" }))).toEqual({ engine: "codex", source: "env" });
    expect(await setupEngine(await makeCtx({ env: "TYBO_ENGINE=gibtsnicht\n" }))).toEqual({ engine: "claude", source: "code" });
    expect(await setupEngine(await makeCtx())).toEqual({ engine: "claude", source: "code" });
  });

  test("settings.json mit claude schlägt TYBO_ENGINE=codex: Claude bleibt Pflicht", async () => {
    const ctx = await serverCtx({ settings: JSON.stringify({ engine: { default: "claude" } }), claude: "missing" });
    expect((await prerequisitesStep.status(ctx)).state).toBe("teilweise");
  });
});

describe("Gesamtprüfung: Codex-Server ohne Claude", () => {
  test("Motor codex, Claude fehlt: Gesamtprüfung bestanden", async () => {
    const ctx = await serverCtx({ claude: "missing" });
    const r = await checkStep.test!({}, ctx);
    const prereq = r.items?.find(i => i.label === "Voraussetzungen");
    expect(prereq?.ok).toBe(true);
  });
});

describe("tybo setup im Terminal: frischer Server, Motor erst im Schritt Modelle", () => {
  /** Antworten auf leerer Konfiguration; Voraussetzungen scheitern zuerst, weil noch Claude Code gilt */
  const FRESH = [
    "", // Auswahl: nur offene Schritte
    "ü", // Voraussetzungen: überspringen (Claude fehlt)
    // Modelle kommen gleich danach (Issue #566)
    "j", // Jetzt einrichten?
    "2", // Motor: Codex
    "", // Standardmodell leer
    "", // Effort leer
    "", // OpenRouter-Schlüssel leer
    "", // OpenRouter-Modell leer
    "", // Ollama-Modell leer
    "", // Nur lokal: leer
    "", // Speichern? Ja
    // Telegram
    "j",
    FAKE.token,
    FAKE.userId,
    "",
    "n", // Forum-Gruppe
    "3", // Datenbank: selbst eintragen
    "https://db.example.org",
    FAKE.serviceKey,
    "",
    "j",
    "n", // Semantische Suche
    "Testperson",
    "Europe/Berlin",
    "",
    "",
    "n", // Sprache
    "n", // WebUI
    "n", // Google
    "j", // Autostart
  ];

  test("ohne TYBO_ENGINE: Modelle kommen nach den Voraussetzungen, mit Codex endet die Einrichtung mit dem Erfolgssatz", async () => {
    const ctx = await linuxCtx();
    ctx.providers.results.claudeVersion = NOT_FOUND;
    ctx.providers.results.engineCheck = CODEX_OK;
    const prompter = scripted(FRESH);
    const r = await runWith({ mode: "all" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(r.out).toContain("Ohne Claude-Konto geht es mit einem anderen Motor, etwa Codex. Der Schritt Modelle kommt als nächster;");
    // Modelle direkt nach den Voraussetzungen, vor Telegram
    expect(r.out.indexOf("Schritt 2 von")).toBe(r.out.indexOf("Schritt 2 von 12: Modelle und Fallback"));
    expect(r.out).toContain("Verbindungstest: bestanden. Codex 0.155.1 ist angemeldet.");
    const settings = JSON.parse(await readFile(ctx.settingsPath, "utf8"));
    expect(settings.engine).toEqual({ default: "codex" });
    // Gesamtprüfung prüft die Voraussetzungen mit Codex neu und besteht
    expect(r.out).toContain("Alles eingerichtet und erreichbar.");
    expect(r.out).toContain("Alle Pflichtschritte sind erledigt.");
    expect(r.out).toContain("tybo läuft über den Autostart");
    expect(r.out).toContain("Hintergrund-Jobs und Nebenaufgaben laufen nicht.");
    expect(r.out).not.toContain("Gesamtprüfung fehlgeschlagen");
    expect(leakedSecrets(r.out)).toEqual([]);
  });

  test("Codex nicht angemeldet: keine Erfolgsmeldung", async () => {
    const ctx = await linuxCtx({ env: "TYBO_ENGINE=codex\n" });
    ctx.providers.results.claudeVersion = NOT_FOUND;
    ctx.providers.results.engineCheck = { ok: false, message: "Codex ist nicht angemeldet. Im Terminal „codex login“ ausführen." };
    const r = await runWith({ mode: "step", step: "pruefung" }, ctx, scripted(["ü"]));
    expect(r.out).toContain("Gesamtprüfung fehlgeschlagen");
    expect(r.out).not.toContain("Alles eingerichtet und erreichbar.");
  });
});

describe("Schritt modelle: Motor", () => {
  test("Motor ist das erste Feld, gespeichert in settings.json, Rest bleibt", async () => {
    expect(modelsStep.fields[0].name).toBe("TYBO_ENGINE");
    expect(modelsStep.fields[0].choices?.map(c => c.value)).toEqual(["claude", "codex", "opencode", "api"]);
    const ctx = await makeCtx({ settings: JSON.stringify({ aux: { review: "ollama:qwen3:8b" } }) });
    const r = await modelsStep.apply!({ TYBO_ENGINE: "codex" }, ctx);
    expect(r.ok).toBe(true);
    const saved = JSON.parse(await readFile(ctx.settingsPath, "utf8"));
    expect(saved).toEqual({ aux: { review: "ollama:qwen3:8b" }, engine: { default: "codex" } });
    expect((await modelsStep.status(ctx)).fields.find(f => f.name === "TYBO_ENGINE")?.set).toBe(true);
  });

  test("Test prüft einen anderen Motor als Claude, Claude Code nicht", async () => {
    const ctx = await makeCtx();
    ctx.providers.results.engineCheck = { ok: false, message: "Codex nicht gefunden." };
    const r = await modelsStep.test!({ TYBO_ENGINE: "codex" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.items?.[0]).toMatchObject({ label: "Motor Codex", ok: false });

    const claude = await makeCtx();
    const r2 = await modelsStep.test!({ TYBO_ENGINE: "claude" }, claude);
    expect(r2.ok).toBe(true);
    expect(claude.providers.calls.map(c => c.method)).not.toContain("engineCheck");
  });

  test("vorhandenes TYBO_ENGINE gilt als gesetzt und wird geprüft", async () => {
    const ctx = await makeCtx({ env: "TYBO_ENGINE=codex\nCODEX_PATH=/opt/codex/bin/codex\n" });
    await modelsStep.test!({}, ctx);
    const call = ctx.providers.calls.find(c => c.method === "engineCheck");
    expect(call?.args[0]).toBe("codex");
    expect((call?.args[1] as { path?: string }).path).toBe("/opt/codex/bin/codex");
  });
});

describe("Anbieter engineCheck: Befehle nur über den Läufer der Einrichtung", () => {
  test("Codex: --version, dann login status; Startfehler heißt nicht installiert", async () => {
    const run = fakeRun({ "/opt/codex --version": { stdout: "codex-cli 0.155.1" }, "/opt/codex login status": { code: 0 } });
    const providers = createProviders({ fetch: async () => new Response(""), run });
    expect(await providers.engineCheck("codex", { path: "/opt/codex", env: {} })).toEqual({ ok: true, message: "Codex 0.155.1 ist angemeldet." });
    expect(run.calls).toEqual([["/opt/codex", "--version"], ["/opt/codex", "login", "status"]]);

    const out = fakeRun({ "codex --version": { stdout: "codex-cli 0.155.1" }, "codex login status": { code: 1 } });
    expect((await createProviders({ fetch: async () => new Response(""), run: out }).engineCheck("codex", { env: {} })).message).toContain("codex login");

    const none = fakeRun();
    const missing = await createProviders({ fetch: async () => new Response(""), run: none }).engineCheck("codex", { env: {} });
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("CODEX_PATH");
    expect(none.calls).toEqual([["codex", "--version"]]);
  });

  test("Anthropic API: nur der Schlüssel in der Umgebung, kein Befehl", async () => {
    const run = fakeRun();
    const providers = createProviders({ fetch: async () => new Response(""), run });
    expect((await providers.engineCheck("api", { env: { ANTHROPIC_API_KEY: "sk-ant-test" } })).ok).toBe(true);
    expect((await providers.engineCheck("api", { env: {} })).ok).toBe(false);
    expect(run.calls).toEqual([]);
  });
});

describe("Einrichtung im Browser: Codex-Server ohne Claude", () => {
  test("Voraussetzungen und Motor im Browser: erledigt, Hinweis ohne Fehler, Motor wählbar", async () => {
    const { startSetup, login, post, get } = await import("./setup-web-fixture");
    const ctx = await serverCtx({ claude: "missing" });
    const s = await startSetup({ ctx });
    try {
      const cookie = await login(s);
      const status = await (await get(s, "/api/setup/steps/voraussetzungen", cookie)).json();
      expect(status.state).toBe("erledigt");
      expect(status.items.find((i: any) => i.label === "Claude CLI")).toMatchObject({ ok: false, optional: true });
      const test = await (await post(s, "/api/setup/steps/voraussetzungen/test", { values: {} }, cookie)).json();
      expect(test.ok).toBe(true);
      expect(test.items.find((i: any) => i.label === "Claude CLI")).toMatchObject({ ok: false, optional: true });
      // Schritt Modelle bietet den Motor an und prüft ihn
      const models = await (await get(s, "/api/setup/steps/modelle", cookie)).json();
      expect(models.fields[0]).toMatchObject({ name: "TYBO_ENGINE", kind: "choice" });
      const mtest = await (await post(s, "/api/setup/steps/modelle/test", { values: { TYBO_ENGINE: "codex" } }, cookie)).json();
      expect(mtest.ok).toBe(true);
      expect(mtest.message).toContain("Codex 0.155.1 ist angemeldet.");
      expect(ctx.providers.calls.map(c => c.method)).not.toContain("claudeProbe");
    } finally {
      await s.server.stop();
    }
  });
});
