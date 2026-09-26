/**
 * Issue #64, Checkbox 3: Schritte profil (temporäre profile.md), modelle
 * (temporäre settings.json) und webui (Passwort mindestens 12 Zeichen).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { OLLAMA_TAGS_URL, OPENROUTER_KEY_URL, createProviders } from "../src/setup/providers";
import { modelsStep } from "../src/setup/steps/models";
import { isValidTimeZone, profileStep, renderProfile, updateProfile } from "../src/setup/steps/profile";
import { webuiStep } from "../src/setup/steps/webui";
import { backupsOf, cleanup, FAKE, fakeRun, leakedSecrets, makeCtx } from "./setup-fixture";

afterAll(cleanup);

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

const HAND_PROFILE = [
  "# Alter Name",
  "",
  "## About You",
  "- Profession: Tischler",
  "- Timezone: UTC",
  "",
  "## Eigene Notizen",
  "- Nie vor 9 Uhr anrufen",
  "",
].join("\n");

describe("Schritt profil", () => {
  test("Status leer, teilweise und fertig", async () => {
    expect((await profileStep.status(await makeCtx())).state).toBe("fehlt");
    const partial = await profileStep.status(await makeCtx({ env: "USER_NAME=Alex\n" }));
    expect(partial.state).toBe("teilweise");
    expect(partial.detail).toBe("Zeitzone fehlt, config/profile.md fehlt.");
    const full = await profileStep.status(await makeCtx({ env: "USER_NAME=Alex\nUSER_TIMEZONE=Europe/Berlin\n", profile: HAND_PROFILE }));
    expect(full.state).toBe("erledigt");
    expect(full.fields).toEqual([
      { name: "USER_NAME", set: true },
      { name: "USER_TIMEZONE", set: true },
      { name: "PROFESSION", set: true },
    ]);
    expect(JSON.stringify(full)).not.toMatch(/Alex|Europe\/Berlin|Tischler/);
  });

  test("Platzhalter aus .env.example und profile.example.md zählen nicht", async () => {
    const ctx = await makeCtx({ env: "USER_NAME=Your Name\n", profile: "# Your Name\n- Profession: [e.g., Software engineer]\n" });
    const s = await profileStep.status(ctx);
    expect(s.fields.find(f => f.name === "USER_NAME")?.set).toBe(false);
    expect(s.fields.find(f => f.name === "PROFESSION")?.set).toBe(false);
  });

  test("Prüfregeln: Pflicht und Zeitzone", async () => {
    const ctx = await makeCtx();
    const r = await profileStep.apply!({ USER_TIMEZONE: "Mars/Olympus" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Dein Name fehlt");
    expect(r.message).toContain("Zeitzone unbekannt");
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Nirgendwo")).toBe(false);
    expect(await Bun.file(ctx.profilePath).exists()).toBe(false);
  });

  test("Schreiben auf leerer Konfiguration: .env und neue profile.md", async () => {
    const ctx = await makeCtx();
    const r = await profileStep.apply!({ USER_NAME: "Alex", USER_TIMEZONE: "Europe/Berlin", PROFESSION: "Vertrieb" }, ctx);
    expect(r).toEqual({ ok: true, message: "Gespeichert.", changed: ["USER_NAME", "USER_TIMEZONE", ctx.profilePath] });
    expect(await readFile(ctx.envPath, "utf8")).toBe("USER_NAME=Alex\nUSER_TIMEZONE=Europe/Berlin\n");
    const profile = await readFile(ctx.profilePath, "utf8");
    expect(profile).toBe(renderProfile({ USER_NAME: "Alex", USER_TIMEZONE: "Europe/Berlin", PROFESSION: "Vertrieb" }));
    expect(profile).toContain("# Alex");
    expect(profile).toContain("- Zeitzone: Europe/Berlin");
    expect((await stat(ctx.profilePath)).mode & 0o777).toBe(0o600);
    expect((await profileStep.status(ctx)).state).toBe("erledigt");
  });

  test("vorhandene profile.md: nur Überschrift, Zeitzone und Beruf ändern sich, Sicherung liegt da", async () => {
    const ctx = await makeCtx({ env: "USER_NAME=Alter Name\nUSER_TIMEZONE=UTC\n", profile: HAND_PROFILE });
    const r = await profileStep.apply!({ USER_NAME: "Neuer Name", USER_TIMEZONE: "Europe/Berlin" }, ctx);
    expect(r.ok).toBe(true);
    const profile = await readFile(ctx.profilePath, "utf8");
    expect(profile).toBe(HAND_PROFILE.replace("# Alter Name", "# Neuer Name").replace("- Timezone: UTC", "- Timezone: Europe/Berlin"));
    expect(profile).toContain("- Nie vor 9 Uhr anrufen");
    expect(profile).toContain("- Profession: Tischler");
    const files = await backupsOf(ctx);
    const profileBackup = files.find(f => f.startsWith("profile-"))!;
    expect(await readFile(`${ctx.backupDir}/${profileBackup}`, "utf8")).toBe(HAND_PROFILE);
    expect(files.some(f => f.startsWith("env-"))).toBe(true);
  });

  test("updateProfile ohne passende Zeilen lässt den Rest stehen und ergänzt sie", () => {
    expect(updateProfile("Freitext ohne Überschrift\n", { USER_NAME: "A", USER_TIMEZONE: "UTC" })).toBe(
      "# A\n\nFreitext ohne Überschrift\n\n## Über mich\n- Zeitzone: UTC\n",
    );
    expect(updateProfile("Freitext\n", { USER_NAME: "A" })).toBe("# A\n\nFreitext\n");
  });

  test("updateProfile ergänzt fehlenden Beruf im Abschnitt, eigene Notizen bleiben, Wiederholung doppelt nichts", () => {
    const withoutProfession = renderProfile({ USER_NAME: "Alex", USER_TIMEZONE: "Europe/Berlin" }) + "\n## Eigene Notizen\n- Nie vor 9 Uhr anrufen\n";
    expect(withoutProfession).not.toContain("Beruf");
    const once = updateProfile(withoutProfession, { PROFESSION: "Vertrieb" });
    expect(once).toBe(withoutProfession.replace("## Über mich\n", "## Über mich\n- Beruf: Vertrieb\n"));
    expect(updateProfile(once, { PROFESSION: "Vertrieb" })).toBe(once);
    const changed = updateProfile(once, { PROFESSION: "Beratung", USER_TIMEZONE: "UTC" });
    expect(changed.match(/Beruf/g)).toHaveLength(1);
    expect(changed).toContain("- Beruf: Beratung");
    expect(changed).toContain("- Zeitzone: UTC");
    expect(changed).toContain("- Nie vor 9 Uhr anrufen");
  });

  test("updateProfile: Abschnitt der Vorlage mit Kommentar, Zeilen kommen darunter", () => {
    const profile = "# Name\n\n## About You\n<!-- Hinweis -->\n- Location: Berlin\n\n## Notizen\n- x\n";
    expect(updateProfile(profile, { PROFESSION: "Tischler", USER_TIMEZONE: "Europe/Berlin" })).toBe(
      "# Name\n\n## About You\n<!-- Hinweis -->\n- Beruf: Tischler\n- Zeitzone: Europe/Berlin\n- Location: Berlin\n\n## Notizen\n- x\n",
    );
  });

  test("Name mit Dollarzeichen landet wörtlich in Überschrift und .env", async () => {
    const ctx = await makeCtx({ env: "USER_NAME=Alter Name\nUSER_TIMEZONE=UTC\n", profile: HAND_PROFILE });
    const name = "A $& B $1 $$ $`";
    const r = await profileStep.apply!({ USER_NAME: name }, ctx);
    expect(r.ok).toBe(true);
    const profile = await readFile(ctx.profilePath, "utf8");
    expect(profile).toBe(HAND_PROFILE.replace("# Alter Name", () => `# ${name}`));
    expect(profile.split("\n")[0]).toBe(`# ${name}`);
    expect((await profileStep.status(ctx)).state).toBe("erledigt");
    expect(updateProfile("# Alt\n", { USER_NAME: name })).toBe(`# ${name}\n`);
  });

  test("mehrzeiliger Kommentar unter „Über mich“: Zeilen kommen darunter, Notizen bleiben, Wiederholung ändert nichts", async () => {
    const profile = "# Alex\n\n## Über mich\n<!--\nHinweis\n-->\n- Zeitzone: Europe/Berlin\n\n## Eigene Notizen\n- bleibt\n";
    const once = updateProfile(profile, { PROFESSION: "Tischler" });
    expect(once).toBe(profile.replace("-->\n", "-->\n- Beruf: Tischler\n"));
    expect(updateProfile(once, { PROFESSION: "Tischler" })).toBe(once);

    const ctx = await makeCtx({ env: "USER_NAME=Alex\nUSER_TIMEZONE=Europe/Berlin\n", profile });
    expect((await profileStep.apply!({ PROFESSION: "Tischler" }, ctx)).changed).toEqual([ctx.profilePath]);
    expect(await readFile(ctx.profilePath, "utf8")).toBe(once);
    expect((await profileStep.status(ctx)).fields.find(f => f.name === "PROFESSION")?.set).toBe(true);
    const again = await profileStep.apply!({ PROFESSION: "Tischler" }, ctx);
    expect(again).toEqual({ ok: true, message: "Schon so eingetragen, nichts geändert.", changed: [] });
    expect(await readFile(ctx.profilePath, "utf8")).toBe(once);
  });

  test("Beruf später hinzufügen: erst ohne, dann mit Beruf einrichten", async () => {
    const ctx = await makeCtx();
    await profileStep.apply!({ USER_NAME: "Alex", USER_TIMEZONE: "Europe/Berlin" }, ctx);
    await writeFile(ctx.profilePath, (await readFile(ctx.profilePath, "utf8")) + "\n## Eigene Notizen\n- bleibt\n");
    expect((await profileStep.status(ctx)).fields.find(f => f.name === "PROFESSION")?.set).toBe(false);
    const r = await profileStep.apply!({ PROFESSION: "Vertrieb" }, ctx);
    expect(r).toEqual({ ok: true, message: "Gespeichert.", changed: [ctx.profilePath] });
    const profile = await readFile(ctx.profilePath, "utf8");
    expect(profile).toContain("- Beruf: Vertrieb");
    expect(profile).toContain("- bleibt");
    expect((await profileStep.status(ctx)).fields.find(f => f.name === "PROFESSION")?.set).toBe(true);
    const again = await profileStep.apply!({ PROFESSION: "Vertrieb" }, ctx);
    expect(again).toEqual({ ok: true, message: "Schon so eingetragen, nichts geändert.", changed: [] });
    expect((await readFile(ctx.profilePath, "utf8")).match(/Beruf/g)).toHaveLength(1);
  });

  test("Wiederholen ohne Änderung schreibt nichts", async () => {
    const ctx = await makeCtx();
    await profileStep.apply!({ USER_NAME: "Alex", USER_TIMEZONE: "Europe/Berlin" }, ctx);
    const before = await backupsOf(ctx);
    const r = await profileStep.apply!({ USER_NAME: "Alex", USER_TIMEZONE: "Europe/Berlin" }, ctx);
    expect(r).toEqual({ ok: true, message: "Schon so eingetragen, nichts geändert.", changed: [] });
    expect(await backupsOf(ctx)).toEqual(before);
  });

  test("Schreibfehler bei profile.md: verständlicher Text", async () => {
    const ctx = await makeCtx({ env: "USER_NAME=Alex\nUSER_TIMEZONE=UTC\n", profile: HAND_PROFILE });
    const configDir = ctx.profilePath.replace(/\/profile\.md$/, "");
    await chmod(configDir, 0o500);
    try {
      const r = await profileStep.apply!({ USER_TIMEZONE: "Europe/Berlin" }, ctx);
      expect(r).toEqual({
        ok: false,
        message: "config/profile.md konnte nicht geschrieben werden (EACCES). Schon gespeichert und nicht zurückgenommen: .env (USER_TIMEZONE).",
        changed: ["USER_TIMEZONE"],
      });
      expect(r.message).not.toContain("Nichts wurde geändert");
      expect(await readFile(ctx.profilePath, "utf8")).toBe(HAND_PROFILE);
      expect(await readFile(ctx.envPath, "utf8")).toContain("USER_TIMEZONE=Europe/Berlin");
    } finally {
      await chmod(configDir, 0o700);
    }
  });
});

// ---------------------------------------------------------------------------
// Modelle
// ---------------------------------------------------------------------------

const SETTINGS_WITH_AGENTS = JSON.stringify({ agents: { research: { model: "agenten-modell" } }, aux: { judge: "claude:judge-modell" } });

describe("Schritt modelle", () => {
  test("Status leer und fertig", async () => {
    const empty = await modelsStep.status(await makeCtx());
    expect(empty).toMatchObject({ state: "fehlt", detail: "Nichts eingestellt, es gelten die Standardwerte." });
    const full = await modelsStep.status(await makeCtx({ settings: JSON.stringify({ fallback: { ollamaModel: "qwen3:8b" } }) }));
    expect(full.state).toBe("erledigt");
    expect(full.fields.find(f => f.name === "OLLAMA_MODEL")).toEqual({ name: "OLLAMA_MODEL", set: true });
    expect(JSON.stringify(full)).not.toContain("qwen3");
  });

  test("Einstellungsdatei geht vor .env, Schlüssel nur als gesetzt", async () => {
    const ctx = await makeCtx({
      env: `OPENROUTER_MODEL=env-modell\nFALLBACK_OFFLINE_ONLY=true\nOPENROUTER_API_KEY=${FAKE.openrouterKey}\n`,
      settings: JSON.stringify({ fallback: { openrouterModel: "datei-modell", offlineOnly: false } }),
    });
    const s = await modelsStep.status(ctx);
    expect(s.fields.find(f => f.name === "OPENROUTER_MODEL")).toEqual({ name: "OPENROUTER_MODEL", set: true });
    expect(s.fields.find(f => f.name === "FALLBACK_OFFLINE_ONLY")).toEqual({ name: "FALLBACK_OFFLINE_ONLY", set: true });
    expect(JSON.stringify(s)).not.toMatch(/datei-modell|env-modell/);
    expect(s.fields.find(f => f.name === "OPENROUTER_API_KEY")).toEqual({ name: "OPENROUTER_API_KEY", set: true });
    expect(leakedSecrets(s)).toEqual([]);
  });

  test("ungültige settings.json: teilweise, Schreiben lehnt ab und lässt die Datei stehen", async () => {
    const ctx = await makeCtx({ settings: "{kaputt" });
    expect((await modelsStep.status(ctx)).state).toBe("teilweise");
    const r = await modelsStep.apply!({ OLLAMA_MODEL: "qwen3:8b" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("config/settings.json ist ungültig");
    expect(await readFile(ctx.settingsPath, "utf8")).toBe("{kaputt");
  });

  test("Prüfregeln: Modellname und Effort", async () => {
    const ctx = await makeCtx();
    const r = await modelsStep.test!({ DEFAULT_MODEL: "mit leerzeichen", DEFAULT_EFFORT: "maximal" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Standardmodell: ungültiger Modellname");
    expect(r.message).toContain("Standard-Effort (optional): keine gültige Auswahl");
  });

  test("Test ohne Fallback: nichts zu prüfen", async () => {
    const ctx = await makeCtx();
    const r = await modelsStep.test!({}, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.providers.calls).toEqual([]);
  });

  test("Test mit eingegebenem OpenRouter-Schlüssel und Ollama-Modell", async () => {
    const ctx = await makeCtx();
    const r = await modelsStep.test!({ OPENROUTER_API_KEY: FAKE.openrouterKey, OLLAMA_MODEL: "qwen3:8b" }, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.providers.calls.map(c => c.method)).toEqual(["openrouterKey", "ollamaTags"]);
    expect(ctx.providers.calls[0].args).toEqual([FAKE.openrouterKey]);
    expect(leakedSecrets(r)).toEqual([]);
  });

  test("Test Fehler: Schlüssel abgelehnt, Ollama-Modell fehlt mit Befehl", async () => {
    const ctx = await makeCtx();
    ctx.providers.results.openrouterKey = { ok: false, message: "OpenRouter lehnt den Schlüssel ab." };
    const r = await modelsStep.test!({ OPENROUTER_API_KEY: FAKE.openrouterKey, OLLAMA_MODEL: "llama9:1b" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("OpenRouter lehnt den Schlüssel ab.");
    expect(r.message).toContain("ollama pull llama9:1b");
    expect(r.items?.find(i => i.label === "Ollama")?.fix).toBe("ollama pull llama9:1b");
  });

  test("nur offline: OpenRouter wird nicht geprüft", async () => {
    const ctx = await makeCtx({ env: `OPENROUTER_API_KEY=${FAKE.openrouterKey}\n` });
    await modelsStep.test!({ FALLBACK_OFFLINE_ONLY: "true" }, ctx);
    expect(ctx.providers.calls.map(c => c.method)).toEqual(["ollamaTags"]);
  });

  test("Schreiben: settings.json bekommt Standard und Fallback, Vorhandenes bleibt, Schlüssel in .env", async () => {
    const ctx = await makeCtx({ env: "# Kommentar\n", settings: SETTINGS_WITH_AGENTS });
    const r = await modelsStep.apply!(
      { DEFAULT_MODEL: "mein-modell", DEFAULT_EFFORT: "high", OLLAMA_MODEL: "qwen3:8b", FALLBACK_OFFLINE_ONLY: "false", OPENROUTER_API_KEY: FAKE.openrouterKey },
      ctx,
    );
    expect(r).toEqual({ ok: true, message: "Gespeichert.", changed: [ctx.settingsPath, "OPENROUTER_API_KEY"] });
    expect(JSON.parse(await readFile(ctx.settingsPath, "utf8"))).toEqual({
      defaults: { model: "mein-modell", effort: "high" },
      agents: { research: { model: "agenten-modell" } },
      aux: { judge: "claude:judge-modell" },
      fallback: { ollamaModel: "qwen3:8b", offlineOnly: false },
    });
    expect((await stat(ctx.settingsPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(ctx.envPath, "utf8")).toBe(`# Kommentar\nOPENROUTER_API_KEY=${FAKE.openrouterKey}\n`);
    expect(leakedSecrets(r)).toEqual([]);
  });

  test("settings.json lässt sich nicht schreiben: nichts geändert, auch .env nicht", async () => {
    const ctx = await makeCtx({ env: "# Kommentar\n", settings: SETTINGS_WITH_AGENTS });
    const configDir = ctx.settingsPath.replace(/\/settings\.json$/, "");
    await chmod(configDir, 0o500);
    try {
      const r = await modelsStep.apply!({ OLLAMA_MODEL: "qwen3:8b", OPENROUTER_API_KEY: FAKE.openrouterKey }, ctx);
      expect(r).toEqual({ ok: false, message: "config/settings.json konnte nicht geschrieben werden (EACCES). Nichts wurde geändert.", changed: [] });
    } finally {
      await chmod(configDir, 0o700);
    }
    expect(await readFile(ctx.settingsPath, "utf8")).toBe(SETTINGS_WITH_AGENTS);
    expect(await readFile(ctx.envPath, "utf8")).toBe("# Kommentar\n");
  });

  test(".env scheitert nach settings.json: Meldung nennt die gespeicherte settings.json", async () => {
    const ctx = await makeCtx({ env: "# Kommentar\n", settings: SETTINGS_WITH_AGENTS });
    ctx.envIo = {
      rename: async () => {
        throw Object.assign(new Error(`EACCES ${FAKE.openrouterKey}`), { code: "EACCES" });
      },
    };
    const r = await modelsStep.apply!({ OLLAMA_MODEL: "qwen3:8b", OPENROUTER_API_KEY: FAKE.openrouterKey }, ctx);
    expect(r).toEqual({
      ok: false,
      message: ".env konnte nicht geschrieben werden (EACCES). Schon gespeichert und nicht zurückgenommen: config/settings.json.",
      changed: [ctx.settingsPath],
    });
    expect(JSON.parse(await readFile(ctx.settingsPath, "utf8")).fallback).toEqual({ ollamaModel: "qwen3:8b" });
    expect(leakedSecrets(r)).toEqual([]);
  });

  test(".env scheitert ohne Änderung an settings.json: nichts geändert", async () => {
    const ctx = await makeCtx({ env: "# Kommentar\n" });
    ctx.envIo = {
      rename: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    const r = await modelsStep.apply!({ OPENROUTER_API_KEY: FAKE.openrouterKey }, ctx);
    expect(r).toEqual({ ok: false, message: ".env konnte nicht geschrieben werden (EACCES). Nichts wurde geändert.", changed: [] });
  });

  test("Überspringen und leere Eingaben schreiben nichts", async () => {
    const ctx = await makeCtx({ settings: SETTINGS_WITH_AGENTS });
    const r = await modelsStep.apply!({ DEFAULT_MODEL: "", OPENROUTER_API_KEY: "" }, ctx);
    expect(r).toEqual({ ok: true, message: "Nichts zu ändern.", changed: [] });
    expect(await readFile(ctx.settingsPath, "utf8")).toBe(SETTINGS_WITH_AGENTS);
    expect(await Bun.file(ctx.envPath).exists()).toBe(false);
  });
});

describe("OpenRouter- und Ollama-Port", () => {
  const providers = (handler: (url: string) => Response) =>
    createProviders({ fetch: async url => handler(url), run: fakeRun(), convex: async () => {}, subprocessEnv: () => ({}) });

  test("OpenRouter: Erfolg und Ablehnung", async () => {
    const seen: string[] = [];
    const ok = await providers(url => (seen.push(url), new Response("{}", { status: 200 }))).openrouterKey(FAKE.openrouterKey);
    expect(ok.ok).toBe(true);
    expect(seen).toEqual([OPENROUTER_KEY_URL]);
    const denied = await providers(() => new Response(`{"error":"${FAKE.openrouterKey} invalid"}`, { status: 401 })).openrouterKey(FAKE.openrouterKey);
    expect(denied).toEqual({ ok: false, message: "OpenRouter lehnt den Schlüssel ab." });
  });

  test("Ollama: Modelle und nicht erreichbar", async () => {
    const ok = await providers(url => {
      expect(url).toBe(OLLAMA_TAGS_URL);
      return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
    }).ollamaTags();
    expect(ok.models).toEqual(["qwen3:8b"]);
    const down = await providers(() => {
      throw new Error("ECONNREFUSED");
    }).ollamaTags();
    expect(down.ok).toBe(false);
    expect(down.message).toContain("Ollama läuft nicht");
  });
});

// ---------------------------------------------------------------------------
// WebUI
// ---------------------------------------------------------------------------

describe("Schritt webui", () => {
  test("Status: aus, ungültig, an", async () => {
    expect((await webuiStep.status(await makeCtx())).state).toBe("fehlt");
    const invalid = await webuiStep.status(await makeCtx({ env: "WEB_ENABLED=true\nWEB_PASSWORD=kurz\n" }));
    expect(invalid.state).toBe("teilweise");
    expect(invalid.detail).toContain("kürzer als 12 Zeichen");
    expect(invalid.detail).not.toContain("kurz\n");
    const on = await webuiStep.status(await makeCtx({ env: `WEB_ENABLED=true\nWEB_PASSWORD=${FAKE.webPassword}\nWEB_PORT=3200\n` }));
    expect(on).toMatchObject({ state: "erledigt", detail: "WebUI ist an." });
    expect(JSON.stringify(on)).not.toContain("3200");
    expect(on.fields.find(f => f.name === "WEB_PASSWORD")).toEqual({ name: "WEB_PASSWORD", set: true });
    expect(leakedSecrets(on)).toEqual([]);
  });

  test("Passwort mindestens 12 Zeichen, gezählt in Codepoints", async () => {
    const ctx = await makeCtx();
    const short = await webuiStep.apply!({ WEB_ENABLED: "true", WEB_PASSWORD: "elf-zeichen" }, ctx);
    expect(short.ok).toBe(false);
    expect(short.message).toBe("Passwort ist kürzer als 12 Zeichen");
    // 12 Emoji sind 12 Codepoints (24 UTF-16-Einheiten): erlaubt
    const emoji = "🔑".repeat(12);
    expect((await webuiStep.apply!({ WEB_ENABLED: "true", WEB_PASSWORD: emoji }, ctx)).ok).toBe(true);
    // 11 Emoji wären 22 UTF-16-Einheiten, aber nur 11 Codepoints: abgelehnt
    const ctx2 = await makeCtx();
    expect((await webuiStep.apply!({ WEB_ENABLED: "true", WEB_PASSWORD: "🔑".repeat(11) }, ctx2)).ok).toBe(false);
  });

  test("einschalten ohne Passwort wird abgelehnt, ausschalten braucht keins", async () => {
    const ctx = await makeCtx();
    expect((await webuiStep.apply!({ WEB_ENABLED: "true" }, ctx)).message).toBe("Passwort der WebUI fehlt");
    const off = await webuiStep.apply!({ WEB_ENABLED: "false" }, ctx);
    expect(off.changed).toEqual(["WEB_ENABLED"]);
    expect(await readFile(ctx.envPath, "utf8")).toBe("WEB_ENABLED=false\n");
  });

  test("Host als Auswahl, Standard nur dieser Rechner; Port geprüft", async () => {
    const ctx = await makeCtx();
    const bad = await webuiStep.apply!({ WEB_ENABLED: "true", WEB_PASSWORD: FAKE.webPassword, WEB_HOST: "example.com", WEB_PORT: "70000" }, ctx);
    expect(bad.message).toContain("Erreichbar von: keine gültige Auswahl");
    expect(bad.message).toContain("Port muss eine Zahl");
    const field = webuiStep.fields.find(f => f.name === "WEB_HOST")!;
    expect(field.choices?.[0].value).toBe("127.0.0.1");
  });

  test("Schreiben: temporäre .env, Passwort behalten beim Wiederholen", async () => {
    const ctx = await makeCtx({ env: "" });
    const r = await webuiStep.apply!({ WEB_ENABLED: "true", WEB_PASSWORD: FAKE.webPassword, WEB_HOST: "0.0.0.0" }, ctx);
    expect(r.changed).toEqual(["WEB_ENABLED", "WEB_PASSWORD", "WEB_HOST"]);
    expect(leakedSecrets(r)).toEqual([]);
    const again = await webuiStep.apply!({ WEB_ENABLED: "true", WEB_PASSWORD: "", WEB_PORT: "3150" }, ctx);
    expect(again.changed).toEqual(["WEB_PORT"]);
    const content = await readFile(ctx.envPath, "utf8");
    expect(content).toContain(`WEB_PASSWORD=${FAKE.webPassword}`);
    expect(content).toContain("WEB_PORT=3150");
    // Eine Sicherung pro Schreibvorgang
    expect((await readdir(ctx.backupDir)).length).toBe(2);
  });
});
