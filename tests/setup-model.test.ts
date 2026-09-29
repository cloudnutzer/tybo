/**
 * Issue #64, Checkbox 1: Schritt-Modell und Status (src/setup/model.ts,
 * src/setup/steps.ts). Alle Dateien in temporären Ordnern, nie die echte .env.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { updateEnvValues } from "../src/lib/env-file";
import {
  fieldStates,
  isPlaceholder,
  mergeValues,
  overallStatus,
  redact,
  STEP_IDS,
  validateValues,
  type SetupField,
} from "../src/setup/model";
import { checkStep, getStep, SETUP_STEPS, setupOverview } from "../src/setup/steps";
import { backupsOf, cleanup, FAKE, FULL_ENV, fakeRun, leakedSecrets, makeCtx } from "./setup-fixture";

afterAll(cleanup);

const FULL_PROFILE = "# Testperson\n\n- Zeitzone: Europe/Berlin\n";

async function fullCtx() {
  // Autostart gilt nur mit geladenem Dienst als erledigt
  const run = fakeRun({ "git --version": { stdout: "git version 2.50.0" }, "launchctl list": { stdout: "1\t0\tai.tybo.telegram-relay" } });
  const ctx = await makeCtx({ env: FULL_ENV, profile: FULL_PROFILE, overrides: { run } });
  await mkdir(ctx.launchAgentsDir, { recursive: true });
  await writeFile(`${ctx.launchAgentsDir}/ai.tybo.telegram-relay.plist`, "<plist/>");
  return ctx;
}

describe("Schrittliste", () => {
  test("Reihenfolge und Kennungen wie im Issue", () => {
    expect(SETUP_STEPS.map(s => s.id)).toEqual([...STEP_IDS]);
    expect(STEP_IDS).toEqual([
      "voraussetzungen",
      "telegram",
      "gruppe",
      "datenbank",
      "suche",
      "profil",
      "modelle",
      "webui",
      "autostart",
      "pruefung",
    ]);
  });

  test("optional sind genau gruppe, suche, modelle und webui", () => {
    expect(SETUP_STEPS.filter(s => s.optional).map(s => s.id)).toEqual(["gruppe", "suche", "modelle", "webui"]);
  });

  test("jeder Schritt hat Titel, Beschreibung und Felder mit Hilfetext", () => {
    for (const step of SETUP_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.description.length).toBeGreaterThan(0);
      for (const f of step.fields) {
        expect(f.help.length).toBeGreaterThan(0);
        expect(["text", "secret", "choice", "yesno"]).toContain(f.kind);
        if (f.kind === "choice" && !f.choicesFrom) expect(f.choices?.length).toBeGreaterThan(0);
      }
    }
  });

  test("Schritte ohne Schreiben und ohne Test sind die erwarteten", () => {
    expect(SETUP_STEPS.filter(s => !s.apply).map(s => s.id)).toEqual(["voraussetzungen", "suche", "pruefung"]);
    expect(SETUP_STEPS.filter(s => !s.test).map(s => s.id)).toEqual(["profil", "webui"]);
  });

  test("getStep findet Schritte, unbekannte nicht", () => {
    expect(getStep("telegram")?.id).toBe("telegram");
    expect(getStep("gibtsnicht")).toBeUndefined();
  });

  test("keine Texte mit Gedankenstrich", () => {
    const texts = SETUP_STEPS.flatMap(s => [s.title, s.description, ...s.fields.flatMap(f => [f.label, f.help])]);
    for (const t of texts) expect(t).not.toContain("—");
  });
});

describe("Werte und Prüfregeln", () => {
  const fields: SetupField[] = [
    { name: "A", label: "Feld A", kind: "text", required: true, help: "h", validate: v => (v.length > 3 ? null : "A zu kurz") },
    { name: "S", label: "Geheim", kind: "secret", required: true, help: "h" },
    { name: "C", label: "Wahl", kind: "choice", help: "h", choices: [{ value: "x", label: "X" }] },
    { name: "Y", label: "Ja/Nein", kind: "yesno", help: "h" },
    { name: "V", label: "Nur bei C=x", kind: "text", required: true, help: "h", visible: v => v.C === "x" },
  ];

  test("Pflichtfelder fehlen auf leerer Konfiguration", () => {
    expect(validateValues(fields, {}, {})).toEqual({ A: "Feld A fehlt", S: "Geheim fehlt" });
  });

  test("vorhandener Wert erfüllt ein Pflichtfeld, leere Eingabe behält ihn", () => {
    expect(validateValues(fields, { A: "abcd", S: "" }, { S: "alt" })).toEqual({});
    expect(mergeValues({ S: "alt" }, { S: "  ", A: " neu " })).toEqual({ S: "alt", A: "neu" });
  });

  test("Prüfregel, Auswahl, Ja/Nein und Zeilenumbruch", () => {
    const errors = validateValues(fields, { A: "ab", S: "x\ny", C: "z", Y: "vielleicht" }, {});
    expect(errors.A).toBe("A zu kurz");
    expect(errors.S).toContain("Zeilenumbrüche");
    expect(errors.C).toContain("keine gültige Auswahl");
    expect(errors.Y).toContain("ja oder nein");
  });

  test("unsichtbare Felder werden nicht geprüft, sichtbare schon", () => {
    expect(validateValues(fields, { A: "abcd", S: "s" }, {}).V).toBeUndefined();
    expect(validateValues(fields, { A: "abcd", S: "s", C: "x" }, {}).V).toBe("Nur bei C=x fehlt");
  });

  test("Fehlertexte enthalten nie den eingegebenen Wert", () => {
    const secret = "geheimerwert123";
    const errors = validateValues(fields, { A: secret.slice(0, 2), S: `${secret}\n` }, {});
    expect(JSON.stringify(errors)).not.toContain(secret);
  });

  test("fieldStates zeigt nur gesetzt oder nicht, nie Werte (Entscheidung 0011)", () => {
    expect(fieldStates(fields, { A: "wert", S: "geheim" })).toEqual([
      { name: "A", set: true },
      { name: "S", set: true },
      { name: "C", set: false },
      { name: "Y", set: false },
      { name: "V", set: false },
    ]);
    const text = JSON.stringify(fieldStates(fields, { A: "wert", S: "geheim" }));
    expect(text).not.toContain("geheim");
    expect(text).not.toContain("wert");
  });

  test("Platzhalter aus .env.example zählen nicht", () => {
    expect(isPlaceholder("your_bot_token_here")).toBe(true);
    expect(isPlaceholder("Your Name")).toBe(true);
    expect(isPlaceholder("Alex")).toBe(false);
  });

  test("redact ersetzt Geheimnisse, auch URL-kodiert, und kürzt", () => {
    const text = `fetch failed https://api.telegram.org/bot${FAKE.token}/getMe ${encodeURIComponent("a b+c/geheim")}`;
    const out = redact(text, [FAKE.token, "a b+c/geheim"]);
    expect(out).not.toContain(FAKE.token);
    expect(out).toContain("***");
    expect(out).not.toContain(encodeURIComponent("a b+c/geheim"));
    expect(redact("x".repeat(500), []).length).toBeLessThanOrEqual(201);
  });
});

describe("Gesamtstatus", () => {
  const steps = SETUP_STEPS;

  test("leer: alle Pflichtschritte fehlen, optionale offen", () => {
    const o = overallStatus(steps, {});
    expect(o.complete).toBe(false);
    expect(o.missing).toEqual(["voraussetzungen", "telegram", "datenbank", "profil", "autostart"]);
    expect(o.open).toEqual(["gruppe", "suche", "modelle", "webui"]);
  });

  test("Pflicht erledigt, optionale übersprungen: fertig", () => {
    const o = overallStatus(
      steps,
      { voraussetzungen: "erledigt", telegram: "erledigt", datenbank: "erledigt", profil: "erledigt", autostart: "erledigt" },
      ["gruppe", "suche", "modelle", "webui"],
    );
    expect(o).toEqual({ complete: true, missing: [], open: [], skipped: ["gruppe", "suche", "modelle", "webui"] });
  });

  test("Pflichtschritt lässt sich nicht überspringen, teilweise zählt nicht", () => {
    const o = overallStatus(steps, { voraussetzungen: "erledigt", telegram: "teilweise" }, ["telegram", "datenbank"]);
    expect(o.missing).toContain("telegram");
    expect(o.missing).toContain("datenbank");
    expect(o.skipped).toEqual([]);
  });

  test("pruefung zählt nicht mit", () => {
    const o = overallStatus(steps, {});
    expect([...o.missing, ...o.open]).not.toContain("pruefung");
  });
});

describe("Status auf leerer und fertiger Konfiguration", () => {
  test("leer: Pflichtschritte fehlen, nichts wird angelegt", async () => {
    const ctx = await makeCtx();
    const overview = await setupOverview(ctx);
    expect(overview.complete).toBe(false);
    expect(overview.missing).toEqual(["telegram", "datenbank", "profil", "autostart"]);
    const status = await checkStep.status(ctx);
    expect(status.state).toBe("fehlt");
    expect(status.detail).toContain("Telegram");
    expect(await Bun.file(ctx.envPath).exists()).toBe(false);
    expect(await backupsOf(ctx)).toEqual([]);
  });

  test("fertig: alles erledigt, Gesamtprüfung erledigt, keine Geheimnisse im Status", async () => {
    const ctx = await fullCtx();
    const states: Record<string, string> = {};
    const statuses = [];
    for (const step of SETUP_STEPS) {
      const s = await step.status(ctx);
      states[step.id] = s.state;
      statuses.push(s);
    }
    expect(states).toEqual({
      voraussetzungen: "erledigt",
      telegram: "erledigt",
      gruppe: "erledigt",
      datenbank: "erledigt",
      // Convex: die semantische Suche dieses Schritts gilt nur für Supabase (Issue #166)
      suche: "fehlt",
      profil: "erledigt",
      modelle: "erledigt",
      webui: "erledigt",
      autostart: "erledigt",
      pruefung: "erledigt",
    });
    expect(leakedSecrets(statuses)).toEqual([]);
    expect((await setupOverview(ctx)).complete).toBe(true);
    // Lesen verändert nichts
    expect(await readFile(ctx.envPath, "utf8")).toBe(FULL_ENV);
    expect(await backupsOf(ctx)).toEqual([]);
  });

  test("teilweise: nur Token gesetzt", async () => {
    const ctx = await makeCtx({ env: `TELEGRAM_BOT_TOKEN=${FAKE.token}\n` });
    const s = await getStep("telegram")!.status(ctx);
    expect(s.state).toBe("teilweise");
    expect(s.detail).toBe("Token gesetzt, Nutzer-ID fehlt.");
    expect(s.fields).toEqual([
      { name: "TELEGRAM_BOT_TOKEN", set: true },
      { name: "TELEGRAM_USER_ID", set: false },
    ]);
  });
});

describe("updateEnvValues", () => {
  test("mehrere Werte, eine Sicherung, Kommentare bleiben", async () => {
    const ctx = await makeCtx({ env: "# oben\nA_ONE=1\n" });
    const r = await updateEnvValues(ctx.envPath, [["A_ONE", "2"], ["B_TWO", "x y"], ["C_GONE", null]], { backupDir: ctx.backupDir });
    expect(r.changed).toBe(true);
    expect(await readFile(ctx.envPath, "utf8")).toBe("# oben\nA_ONE=2\nB_TWO='x y'\n");
    expect((await backupsOf(ctx)).length).toBe(1);
  });

  test("ungültiger Wert: nichts geschrieben", async () => {
    const ctx = await makeCtx({ env: "A_ONE=1\n" });
    await expect(updateEnvValues(ctx.envPath, [["A_ONE", "2"], ["B_TWO", "a\nb"]], { backupDir: ctx.backupDir })).rejects.toThrow();
    expect(await readFile(ctx.envPath, "utf8")).toBe("A_ONE=1\n");
    expect(await backupsOf(ctx)).toEqual([]);
  });

  test("ohne Änderung: keine Sicherung", async () => {
    const ctx = await makeCtx({ env: "A_ONE=1\n" });
    const r = await updateEnvValues(ctx.envPath, [["A_ONE", "1"]], { backupDir: ctx.backupDir });
    expect(r).toEqual({ changed: false, backup: null });
    expect(await backupsOf(ctx)).toEqual([]);
  });
});

describe("createSetupContext", () => {
  test("Standardpfade im Projekt, Teile ersetzbar, liest und schreibt beim Anlegen nichts", async () => {
    const { createSetupContext, PROJECT_ROOT } = await import("../src/setup/context");
    const { fakeProviders, fakeRun } = await import("./setup-fixture");
    const ctx = createSetupContext({ home: "/tmp/nirgendwo", run: fakeRun(), providers: fakeProviders() });
    expect(ctx.root).toBe(PROJECT_ROOT);
    expect(ctx.envPath).toBe(`${PROJECT_ROOT}/.env`);
    expect(ctx.profilePath).toBe(`${PROJECT_ROOT}/config/profile.md`);
    expect(ctx.settingsPath).toBe(`${PROJECT_ROOT}/config/settings.json`);
    expect(ctx.backupDir).toBe(`${PROJECT_ROOT}/data/backups`);
    expect(ctx.launchAgentsDir).toBe("/tmp/nirgendwo/Library/LaunchAgents");
    const pm2Home = process.env.PM2_HOME;
    try {
      delete process.env.PM2_HOME;
      expect(createSetupContext({ home: "/tmp/nirgendwo", run: fakeRun() }).pm2DumpPath).toBe("/tmp/nirgendwo/.pm2/dump.pm2");
      process.env.PM2_HOME = "/tmp/pm2-anders";
      expect(createSetupContext({ home: "/tmp/nirgendwo", run: fakeRun() }).pm2DumpPath).toBe("/tmp/pm2-anders/dump.pm2");
      expect(createSetupContext({ run: fakeRun(), pm2DumpPath: "/tmp/test/dump.pm2" }).pm2DumpPath).toBe("/tmp/test/dump.pm2");
    } finally {
      if (pm2Home === undefined) delete process.env.PM2_HOME;
      else process.env.PM2_HOME = pm2Home;
    }
    const other = createSetupContext({ root: "/tmp/anders", run: fakeRun() });
    expect(other.envPath).toBe("/tmp/anders/.env");
    expect(typeof other.providers.telegramGetMe).toBe("function");
  });
});
