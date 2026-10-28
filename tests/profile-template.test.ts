/**
 * Issue #381: die Vorlage config/profile.example.md und der Schritt „profil“.
 *
 * Geprüft wird die echte Vorlage, nicht ein Beispieltext: Wer sie nach
 * config/profile.md kopiert und danach `tybo setup profil` laufen lässt,
 * bekommt keinen Platzhalter als Beruf, und Name, Zeitzone und Beruf stehen
 * danach je genau einmal in der Datei, auch nach einem zweiten Lauf.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { profileStep, updateProfile } from "../src/setup/steps/profile";
import { cleanup, makeCtx } from "./setup-fixture";

afterAll(cleanup);

const TEMPLATE = readFileSync(join(import.meta.dir, "..", "config", "profile.example.md"), "utf8");
const ENTERED = { USER_NAME: "Mia", USER_TIMEZONE: "Europe/Vienna", PROFESSION: "Tischlerin" };

/** Zeilen, die der Schritt als Beruf bzw. Zeitzone erkennt (wie PROFESSION_LINE und TIMEZONE_LINE) */
const professionLines = (text: string) => text.split("\n").filter(l => /^- (Beruf|Profession):/.test(l));
const timezoneLines = (text: string) => text.split("\n").filter(l => /^- (Zeitzone|Timezone):/.test(l));

describe("Vorlage config/profile.example.md", () => {
  test("hat genau eine Überschrift erster Ebene und je eine Zeile für Beruf und Zeitzone", () => {
    expect(TEMPLATE.split("\n").filter(l => /^# /.test(l))).toHaveLength(1);
    expect(professionLines(TEMPLATE)).toHaveLength(1);
    expect(timezoneLines(TEMPLATE)).toHaveLength(1);
  });

  test("Platzhalter der Vorlage zählen nicht als Beruf", async () => {
    expect(professionLines(TEMPLATE)[0]).toMatch(/:\s*\[/);
    const status = await profileStep.status(await makeCtx({ profile: TEMPLATE }));
    expect(status.fields.find(f => f.name === "PROFESSION")?.set).toBe(false);
  });

  test("Aktualisieren ersetzt die Platzhalter, ohne Zeilen zu verdoppeln, und lässt den Rest stehen", () => {
    const once = updateProfile(TEMPLATE, ENTERED);
    expect(once.split("\n")[0]).toBe("# Mia");
    expect(professionLines(once)).toHaveLength(1);
    expect(professionLines(once)[0]).toEndWith(": Tischlerin");
    expect(timezoneLines(once)).toHaveLength(1);
    expect(timezoneLines(once)[0]).toEndWith(": Europe/Vienna");
    expect(once.split("\n")).toHaveLength(TEMPLATE.split("\n").length);
    expect(updateProfile(once, ENTERED)).toBe(once);
  });

  test("Schritt profil auf der kopierten Vorlage: danach erledigt, Beruf erkannt, zweiter Lauf ändert nichts", async () => {
    const ctx = await makeCtx({ profile: TEMPLATE });
    const first = await profileStep.apply!(ENTERED, ctx);
    expect(first.ok).toBe(true);
    const after = await Bun.file(ctx.profilePath).text();
    expect(professionLines(after)).toHaveLength(1);
    expect(timezoneLines(after)).toHaveLength(1);
    const status = await profileStep.status(ctx);
    expect(status.state).toBe("erledigt");
    expect(status.fields.find(f => f.name === "PROFESSION")?.set).toBe(true);
    const second = await profileStep.apply!(ENTERED, ctx);
    expect(second.ok).toBe(true);
    expect(await Bun.file(ctx.profilePath).text()).toBe(after);
  });
});
