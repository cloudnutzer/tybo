/**
 * Issue #65, Checkbox 3: `tybo setup <schritt>` und `tybo setup --liste`
 * über den Einstieg scripts/tybo.ts (runTybo), mit Attrappen für Befehle
 * und Anbieter. Geprüft wird stdout und stderr auf Geheimnisse.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runTybo } from "../scripts/tybo";
import type { SetupContext } from "../src/setup/context";
import type { Prompter } from "../src/setup/prompt";
import { parseSetupArgs } from "../src/setup/terminal";
import { backupsOf, cleanup, FAKE, FULL_ENV, leakedSecrets, makeCtx } from "./setup-fixture";
import { linuxCtx, scripted } from "./setup-terminal-fixture";

afterAll(cleanup);

async function tyboSetup(args: string[], ctx: SetupContext, prompter: Prompter) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runTybo({
    args: ["setup", ...args],
    env: {},
    root: ctx.root,
    out: l => out.push(l),
    err: l => err.push(l),
    setup: { ctx, prompter, onInterrupt: () => () => {} },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("tybo setup --liste", () => {
  test("nur die Übersicht: kein Schreiben, kein Verbindungstest, keine Frage", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const before = await readFile(ctx.envPath, "utf8");
    const prompter = scripted([]);
    const r = await tyboSetup(["--liste"], ctx, prompter);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(prompter.asked).toEqual([]);
    expect(r.out).toMatch(/2\. Telegram \(optional\)\s+erledigt\s+Token und Nutzer-ID sind gesetzt\./);
    expect(r.out).toMatch(/9\. Zugang vom Handy \(optional\)\s+fehlt/);
    expect(r.out).toMatch(/10\. Autostart\s+fehlt/);
    // Keine Verbindungstests: weder Telegram noch Datenbank noch Claude-Probeaufruf
    const probes = ctx.providers.calls.map(c => c.method);
    expect(probes).not.toContain("telegramGetMe");
    expect(probes).not.toContain("telegramSendTest");
    expect(probes).not.toContain("convexQuery");
    expect(probes).not.toContain("claudeProbe");
    // Nur lesende Befehle, alle über die Attrappe
    for (const cmd of ctx.run.calls) expect(["git --version", "launchctl list"]).toContain(cmd.join(" "));
    expect(await readFile(ctx.envPath, "utf8")).toBe(before);
    expect(await backupsOf(ctx)).toEqual([]);
    expect(leakedSecrets(r.out + r.err)).toEqual([]);
  });

  test("fehlende Voraussetzung: Übersicht nennt den Befehl zum Nachholen", async () => {
    const ctx = await makeCtx({ env: "" });
    ctx.providers.results.claudeVersion = { ok: false, message: "Claude CLI nicht gefunden." };
    const r = await tyboSetup(["--liste"], ctx, scripted([]));
    expect(r.out).toMatch(/1\. Voraussetzungen\s+teilweise/);
    expect(r.out).toContain("Claude CLI: curl -fsSL https://claude.ai/install.sh | bash");
  });
});

describe("tybo setup <schritt>", () => {
  test("nur dieser Schritt, andere werden nicht angefasst", async () => {
    const ctx = await linuxCtx({ env: "" });
    const prompter = scripted(["Testperson", "Europe/Berlin", "Autorin", ""]);
    const r = await tyboSetup(["profil"], ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(r.out).toContain("Für diesen Schritt gibt es keinen Verbindungstest.");
    expect(r.out).toContain("Profil: gespeichert.");
    expect(r.out).not.toContain("Telegram");
    expect(await readFile(ctx.profilePath, "utf8")).toContain("- Beruf: Autorin");
    expect(ctx.run.calls.some(c => c[0] === "pm2")).toBe(false);
  });

  test("erledigter Schritt: wird trotzdem gezeigt; optionaler ohne Rückfrage „Jetzt einrichten?“", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const before = await readFile(ctx.envPath, "utf8");
    const prompter = scripted([""]);
    const r = await tyboSetup(["gruppe"], ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.asked.map(a => a.question)).toEqual(["Gruppen-ID der Forum-Gruppe: "]);
    expect(r.out).toContain("Stand: Forum-Gruppe ist eingetragen.");
    expect(r.out).toContain("Verbindungstest: bestanden.");
    expect(r.out).toContain("Keine neuen Eingaben, alles bleibt, wie es ist.");
    expect(r.out).toContain("Forum-Gruppe: unverändert.");
    expect(await readFile(ctx.envPath, "utf8")).toBe(before);
  });

  test("neuen Wert in erledigtem Schritt setzen: nur dieser Name ändert sich", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    const r = await tyboSetup(["telegram"], ctx, scripted(["", "777", ""]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Geändert: TELEGRAM_USER_ID");
    const after = await readFile(ctx.envPath, "utf8");
    expect(after).toContain("TELEGRAM_USER_ID=777");
    expect(after).toContain(`TELEGRAM_BOT_TOKEN=${FAKE.token}`);
    expect(after).toContain("# Kommentar bleibt");
    expect(leakedSecrets(r.out + r.err)).toEqual([]);
  });

  test("Voraussetzungen: nur prüfen, nichts schreiben", async () => {
    const ctx = await makeCtx({ env: "" });
    const r = await tyboSetup(["voraussetzungen"], ctx, scripted([]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Alles da, Claude CLI ist angemeldet.");
    expect(r.out).toContain("Voraussetzungen: geprüft.");
    expect(await readFile(ctx.envPath, "utf8")).toBe("");
  });

  test("pruefung: Gesamtprüfung allein, auch Tests für schon erledigte Schritte", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    ctx.providers.results.telegramGetMe = { ok: false, message: "Telegram kennt dieses Token nicht." };
    // Fehlgeschlagener Schritt wird angeboten; hier übersprungen
    const r = await tyboSetup(["pruefung"], ctx, scripted(["ü"]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("!!  Telegram: Telegram kennt dieses Token nicht.");
    expect(r.out).toContain("Fehlgeschlagen: Telegram");
    expect(r.out).toContain("Gesamtprüfung fehlgeschlagen: Telegram");
    expect(leakedSecrets(r.out + r.err)).toEqual([]);
  });

  test("Geheimnisse, die ein Anbieter doch zurückgibt, werden in der Ausgabe ersetzt", async () => {
    const ctx = await makeCtx({ env: FULL_ENV });
    ctx.providers.results.telegramGetMe = { ok: false, message: `Fehler bei ${FAKE.token} und ${FAKE.webPassword}` };
    const r = await tyboSetup(["telegram"], ctx, scripted(["", "", "ü"]));
    expect(r.out).toContain("Fehler bei *** und ***");
    expect(leakedSecrets(r.out + r.err)).toEqual([]);
  });
});

describe("Argumente", () => {
  test("unbekannter Schritt, zu viele Argumente, unbekannte Option: Exit 2, nichts läuft", async () => {
    for (const args of [["quatsch"], ["telegram", "profil"], ["--list"], ["--web", "telegram"]]) {
      const ctx = await makeCtx({ env: FULL_ENV });
      const r = await tyboSetup(args, ctx, scripted([]));
      expect(r.code).toBe(2);
      expect(r.err).toContain(`Unbekannter Aufruf: tybo setup ${args.join(" ")}`);
      expect(r.err).toContain("tybo setup --liste");
      expect(ctx.run.calls).toEqual([]);
      expect(ctx.providers.calls).toEqual([]);
    }
  });

  test("parseSetupArgs", () => {
    expect(parseSetupArgs([])).toEqual({ mode: "all" });
    expect(parseSetupArgs(["--liste"])).toEqual({ mode: "list" });
    expect(parseSetupArgs(["--web"])).toEqual({ mode: "web" });
    expect(parseSetupArgs(["Telegram"])).toEqual({ mode: "step", step: "telegram" });
    expect(parseSetupArgs(["pruefung"])).toEqual({ mode: "step", step: "pruefung" });
    expect(parseSetupArgs(["x"])).toBeNull();
  });
});
