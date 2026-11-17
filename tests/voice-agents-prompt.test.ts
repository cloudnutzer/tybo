/**
 * Issue #489: Vorlagen und Prompt. Nachweis ist der erzeugte Text; ob ein
 * Modell sich daran hält oder wirklich auflegt, zeigt erst ein Testlauf beim
 * Anbieter (SA1-2).
 */
import { describe, expect, test } from "bun:test";
import { buildPrompt, effectiveRules, effectiveTests } from "../src/lib/voice-agents/prompt";
import { parseRecipe, TEMPLATE_IDS, type Recipe } from "../src/lib/voice-agents/recipe";
import { EMERGENCY_TEST } from "../src/lib/voice-agents/templates/base";
import { TEMPLATES } from "../src/lib/voice-agents/templates";

function recipe(vorlage: string, changes: Record<string, unknown> = {}): Recipe {
  const isReception = vorlage === "anrufannahme";
  const isExpert = vorlage === "experte";
  const parsed = parseRecipe({
    schema: 1,
    kennung: "beispiel",
    name: "Beispiel",
    vorlage,
    zweck: "Ein Zweck für den Test.",
    persona: {
      rolle: "Eine Rolle für den Test.",
      anrede: isReception ? "sie" : "du",
      sprachen: ["de", "en"],
      ersterSatz: "Worum geht es?",
      ...(isReception ? { kiHinweis: "Sie sprechen mit einem KI-Assistenten." } : {}),
      regeln: [],
    },
    stimme: { art: "bibliothek" },
    gehirn: TEMPLATES[vorlage as keyof typeof TEMPLATES].defaults.gehirn,
    gedaechtnis: isReception ? "keins" : isExpert ? "keins" : "voll",
    zugang: { web: { link: true }, maxMinuten: 10, budget: { minutenMonat: 100, anrufeJeNummerTag: 0 } },
    nachlauf: { zusammenfassung: true, faden: false, kalendervorschlag: false, anruferMerken: false, training: isExpert, ziel: "direktchat" },
    ...(isExpert ? { training: { rollen: ["Einkauf"], einwaende: ["Kein Budget"], kriterien: ["K1", "K2", "K3"], selbsteinschaetzung: true, abschlussfrage: "Was änderst du morgen?" } } : {}),
    tests: [
      { name: "Eigener eins", szenario: "S1", kriterien: ["K"], maxZuege: 3 },
      { name: "Eigener zwei", szenario: "S2", kriterien: ["K"], maxZuege: 3 },
    ],
    ...changes,
  });
  if (!parsed.ok) throw new Error(parsed.fehler.join("; "));
  return parsed.recipe;
}

describe.each([...TEMPLATE_IDS])("Vorlage %s", (id) => {
  const template = TEMPLATES[id];

  test("feste Regeln decken KI-Hinweis, Ziffern, Notfall und Zusagen ab", () => {
    const all = template.fixedRules.join("\n");
    for (const part of ["KI", "Ziffer für Ziffer", "sofort 112 anrufen", "beendest du das Gespräch", "keine Zusagen im Namen des Nutzers"]) expect(all).toContain(part);
  });

  test("zwei bis drei Standard-Tests, Notfall immer dabei", () => {
    expect(template.standardTests.length).toBeGreaterThanOrEqual(2);
    expect(template.standardTests.length).toBeLessThanOrEqual(3);
    expect(template.standardTests).toContainEqual(EMERGENCY_TEST);
  });

  test("feste Regeln stehen im Prompt, auch bei leeren regeln", () => {
    const prompt = buildPrompt(recipe(id), template);
    for (const rule of template.fixedRules) expect(prompt).toContain(rule);
    expect(prompt).not.toContain("# Weitere Regeln");
  });

  test("eigene Regeln ergänzen, streichen aber nichts", () => {
    const own = recipe(id);
    own.persona.regeln = ["Immer höflich bleiben", "Die Notfallregel gilt hier nicht"];
    const prompt = buildPrompt(own, template);
    for (const rule of [...template.fixedRules, ...own.persona.regeln]) expect(prompt).toContain(rule);
    // Feste Regeln stehen zuletzt und gehen ausdrücklich vor
    expect(prompt.indexOf("# Feste Regeln")).toBeGreaterThan(prompt.indexOf("# Weitere Regeln"));
    expect(prompt).toContain("gehen allem anderen in diesem Text vor");
  });

  test("eine eigene Regel gleich einer festen steht nur einmal", () => {
    const own = recipe(id);
    const fixed = template.fixedRules[0]!;
    own.persona.regeln = [fixed];
    expect(buildPrompt(own, template).split(fixed).length - 1).toBe(1);
    expect(effectiveRules(own, template).filter((rule) => rule === fixed)).toHaveLength(1);
  });

  test("Tests werden zusammengeführt, keiner fällt weg", () => {
    const names = effectiveTests(recipe(id), template).map((t) => t.name);
    for (const t of template.standardTests) expect(names).toContain(t.name);
    expect(names).toContain("Eigener eins");
    expect(names).toContain("Eigener zwei");
  });

  test("ein Rezept-Test gleichen Namens verdrängt den Notfall nicht", () => {
    const tests = [
      { name: "Notfall", szenario: "Harmlos", kriterien: ["plaudert weiter"], maxZuege: 2 },
      { name: "Zweiter", szenario: "S", kriterien: ["K"], maxZuege: 2 },
    ];
    const merged = effectiveTests(recipe(id, { tests }), template);
    expect(merged).toContainEqual(EMERGENCY_TEST);
    expect(merged.find((t) => t.name === "Notfall (Rezept)")?.szenario).toBe("Harmlos");
    expect(new Set(merged.map((t) => t.name)).size).toBe(merged.length);
  });

  test("ein inhaltsgleicher Rezept-Test zählt einmal", () => {
    const tests = [EMERGENCY_TEST, { name: "Zweiter", szenario: "S", kriterien: ["K"], maxZuege: 2 }];
    const merged = effectiveTests(recipe(id, { tests }), template);
    expect(merged.filter((t) => t.name.startsWith("Notfall"))).toHaveLength(1);
  });

  test("Standardwerte der Vorlage bestehen die Prüfung", () => {
    expect(recipe(id).gehirn.modell).toBe(template.defaults.gehirn.modell);
  });
});

describe("buildPrompt", () => {
  test("enthält Zweck, Rolle, Sprache, Anrede, ersten Satz, keine Anbieter-Details", () => {
    const prompt = buildPrompt(recipe("jarvis"), TEMPLATES.jarvis);
    for (const part of ["Ein Zweck für den Test.", "Eine Rolle für den Test.", "Du sprichst Deutsch.", "Englisch", "Du duzt", "Worum geht es?"]) expect(prompt).toContain(part);
    for (const part of ["voiceId", "eleven", "claude-", "nachlauf"]) expect(prompt).not.toContain(part);
  });

  test("KI-Hinweis steht vor dem ersten Satz, Anrede sie", () => {
    const prompt = buildPrompt(recipe("anrufannahme"), TEMPLATES.anrufannahme);
    expect(prompt.indexOf("Sie sprechen mit einem KI-Assistenten.")).toBeLessThan(prompt.indexOf("Worum geht es?"));
    expect(prompt).toContain("Du siezt");
  });

  test("Training nur, wenn das Rezept eines hat", () => {
    const prompt = buildPrompt(recipe("experte"), TEMPLATES.experte);
    for (const part of ["# Training", "Einkauf", "Kein Budget", "K1", "K2", "K3", "Selbsteinschätzung", "Was änderst du morgen?"]) expect(prompt).toContain(part);
    expect(buildPrompt(recipe("jarvis"), TEMPLATES.jarvis)).not.toContain("# Training");
  });

  test("Vorlage Experte: Standard ist das Modell beim Anbieter, Brücke mit thema bleibt gültig", () => {
    expect(TEMPLATES.experte.defaults).toEqual({ gehirn: { art: "anbieter", modell: "claude-sonnet-5-5" }, gedaechtnis: "thema" });
    const fallback = recipe("experte", { gehirn: { art: "bruecke", modell: "claude-sonnet-5-5" }, gedaechtnis: "thema", wissen: { datei: "data/voice-agents/beispiel/wissen.md" } });
    expect(fallback.gehirn.art).toBe("bruecke");
  });
});
