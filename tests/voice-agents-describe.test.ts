/**
 * Issue #495: Rezept in Klartext für die WebUI (src/lib/voice-agents/describe.ts).
 * Abschnitte mit Feld und Wert, kein JSON, alle Vorlagen aus
 * config/voice-agents.example/ lassen sich darstellen.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describeRecipe } from "../src/lib/voice-agents/describe";
import { baseRecipe, recipeFrom } from "./voice-agents-elevenlabs-fixture";

const EXAMPLES = resolve(import.meta.dir, "..", "config", "voice-agents.example");

const field = (sections: ReturnType<typeof describeRecipe>, titel: string, feld: string) =>
  sections.find((s) => s.titel === titel)?.zeilen.find((z) => z.feld === feld)?.wert;

describe("describeRecipe", () => {
  test("Grundrezept: Abschnitte in fester Reihenfolge, Werte als Sätze statt JSON", () => {
    const sections = describeRecipe(recipeFrom(baseRecipe()));
    expect(sections.map((s) => s.titel)).toEqual(["Allgemein", "Persona", "Stimme und Gehirn", "Zugang und Grenzen", "Nach dem Gespräch", "Tests"]);
    expect(field(sections, "Allgemein", "Vorlage")).toBe("Persönlicher Assistent (Jarvis)");
    expect(field(sections, "Persona", "Anrede")).toBe("du");
    expect(field(sections, "Persona", "Eigene Regeln")).toBe("keine");
    expect(field(sections, "Stimme und Gehirn", "Gehirn")).toBe("beim Anbieter, claude-sonnet-5-5");
    expect(field(sections, "Stimme und Gehirn", "Tempo")).toBe("1,1");
    expect(field(sections, "Stimme und Gehirn", "Gedächtnis")).toBe("voll, mit tybos Gedächtnis");
    expect(field(sections, "Zugang und Grenzen", "Im Browser")).toBe("ja, nach Anmeldung in der WebUI");
    expect(field(sections, "Zugang und Grenzen", "Telefon")).toBe("nein");
    expect(field(sections, "Zugang und Grenzen", "Längstes Gespräch")).toBe("12 Minuten");
    // Ohne Telefon keine Zeile zu Anrufen je Nummer
    expect(field(sections, "Zugang und Grenzen", "Anrufe je Nummer und Tag")).toBeUndefined();
    expect(field(sections, "Nach dem Gespräch", "Ziel der Meldung")).toBe("Direktchat");
    expect(field(sections, "Tests", "Erster")).toBe("Jemand fragt nach Erwartet: antwortet. Höchstens 4 Züge.");
    for (const s of sections) for (const z of s.zeilen) expect(z.wert).not.toMatch(/^[{[]/);
  });

  test("Telefon, KI-Hinweis, Sie, Werkzeuge mit Freigabe und Topic als Ziel", () => {
    const raw = baseRecipe();
    raw.persona.anrede = "sie";
    raw.persona.kiHinweis = "Sie sprechen mit einer KI.";
    raw.werkzeuge = [{ name: "rueckruf_notieren", freigabe: "nachher" }, { name: "freie_termine" }];
    raw.zugang.telefon = { nummer: "nr-1", anrufer: "freigegeben", pin: true };
    raw.zugang.budget.anrufeJeNummerTag = 3;
    raw.zugang.maxMinuten = 1;
    raw.nachlauf.ziel = "topic:42";
    const sections = describeRecipe(recipeFrom(raw));
    expect(field(sections, "Persona", "Anrede")).toBe("Sie");
    expect(field(sections, "Persona", "KI-Hinweis")).toBe("Sie sprechen mit einer KI.");
    expect(field(sections, "Stimme und Gehirn", "Werkzeuge")).toBe("rueckruf_notieren (Freigabe nachher); freie_termine");
    expect(field(sections, "Zugang und Grenzen", "Telefon")).toBe("Nummer beim Anbieter nr-1, Anrufer: nur freigegebene Nummern, PIN: ja");
    expect(field(sections, "Zugang und Grenzen", "Anrufe je Nummer und Tag")).toBe("3");
    expect(field(sections, "Zugang und Grenzen", "Längstes Gespräch")).toBe("1 Minute");
    expect(field(sections, "Nach dem Gespräch", "Ziel der Meldung")).toBe("Topic 42");
  });

  test("alle Beispielrezepte lassen sich darstellen", () => {
    const files = readdirSync(EXAMPLES).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const sections = describeRecipe(recipeFrom(JSON.parse(readFileSync(join(EXAMPLES, file), "utf8"))));
      expect(sections.find((s) => s.titel === "Tests")!.zeilen.length).toBeGreaterThanOrEqual(2);
      for (const s of sections) for (const z of s.zeilen) expect(typeof z.wert).toBe("string");
    }
    const trainer = recipeFrom(JSON.parse(readFileSync(join(EXAMPLES, "verhandlungstrainer.json"), "utf8")));
    if (trainer.training) expect(describeRecipe(trainer).some((s) => s.titel === "Training")).toBe(true);
  });
});
