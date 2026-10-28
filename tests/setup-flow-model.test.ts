/**
 * Issue #161, Checkbox 1: Erweiterungen im Einrichtungsmodell. Standardwerte
 * (nur ohne vorhandenen Wert), geladene Auswahlen (choicesFrom), transiente
 * Felder und die Entscheidung Ablauf oder Felder.
 */

import { describe, expect, test } from "bun:test";
import {
  choicesKey,
  fieldDefinitionProblems,
  fieldStates,
  isTransientName,
  containsValue,
  maskStandalone,
  maskValues,
  registerTransientFields,
  resolveValues,
  runsAsFlow,
  validateValues,
  valuesBefore,
  type SetupField,
} from "../src/setup/model";
import { SETUP_STEPS } from "../src/setup/steps";
import { makeFlowStep, FLOW_FIELDS } from "./setup-flow-fixture";

const fields: SetupField[] = [
  { name: "MODE", label: "Art", kind: "choice", help: "", required: true, default: "neu", choices: [{ value: "neu", label: "Neu" }, { value: "alt", label: "Alt" }] },
  { name: "NAME", label: "Name", kind: "text", help: "", default: "tybo", visible: v => v.MODE === "neu" },
  { name: "TOKEN", label: "Token", kind: "secret", help: "", required: true },
  { name: "ORG", label: "Organisation", kind: "choice", help: "", required: true, choicesFrom: async () => ({ choices: [] }) },
  { name: "PASS", label: "Passwort", kind: "secret", help: "", transient: true },
];

describe("Standardwerte", () => {
  test("greifen nur ohne Eingabe und ohne vorhandenen Wert", () => {
    expect(resolveValues(fields, {}, {})).toEqual({ MODE: "neu", NAME: "tybo" });
    expect(resolveValues(fields, { NAME: "eigen" }, {})).toEqual({ MODE: "neu", NAME: "eigen" });
    // Vorhandener Wert hat Vorrang vor dem Standard
    expect(resolveValues(fields, {}, { NAME: "gespeichert", MODE: "neu" })).toEqual({});
    expect(resolveValues(fields, { NAME: "  " }, { NAME: "gespeichert" })).toEqual({ MODE: "neu" });
  });

  test("bestimmen die Sichtbarkeit späterer Felder mit", () => {
    // MODE vorhanden als „alt“: NAME unsichtbar, kein Standard
    expect(resolveValues(fields, {}, { MODE: "alt" })).toEqual({});
    expect(resolveValues(fields, { MODE: "alt" }, {})).toEqual({ MODE: "alt" });
  });

  test("erfüllen Pflichtfelder in validateValues", () => {
    const errors = validateValues(fields, { TOKEN: "abc-token" }, {}, { ORG: [{ value: "o1", label: "Org 1" }] });
    expect(errors.MODE).toBeUndefined();
    expect(errors.ORG).toBe("Organisation fehlt");
  });

  test("Standard einer Auswahl muss eine der Auswahlen sein", () => {
    expect(fieldDefinitionProblems(fields)).toEqual([]);
    expect(fieldDefinitionProblems([{ ...fields[0], default: "gibtsnicht" }])).toEqual(["MODE: Standard ist keine der Auswahlen"]);
    expect(fieldDefinitionProblems([{ ...fields[4], default: "x" }])).toHaveLength(1);
    // Alle echten Schritte und der Test-Schritt halten die Regel ein
    for (const step of [...SETUP_STEPS, makeFlowStep()]) expect(fieldDefinitionProblems(step.fields)).toEqual([]);
  });
});

describe("Geladene Auswahlen", () => {
  test("Eingabe außerhalb der Liste wird abgelehnt, ohne Liste ebenso", () => {
    const loaded = { ORG: [{ value: "o1", label: "Org 1" }] };
    expect(validateValues(fields, { TOKEN: "t", ORG: "o1" }, {}, loaded)).toEqual({});
    expect(validateValues(fields, { TOKEN: "t", ORG: "o2" }, {}, loaded).ORG).toBe("Organisation: keine gültige Auswahl");
    expect(validateValues(fields, { TOKEN: "t", ORG: "o1" }, {}, {}).ORG).toBe("Organisation: Auswahl bitte erst laden");
    // Im Schritt selbst (ohne loaded) nur die Form
    expect(validateValues(fields, { TOKEN: "t", ORG: "o9" }, {})).toEqual({});
  });

  test("gespeicherte Auswahl: ohne Liste, außerhalb der Liste und in der Liste", () => {
    const existing = { TOKEN: "t", ORG: "alt-org" };
    expect(validateValues(fields, {}, existing, {}).ORG).toBe("Organisation: Auswahl bitte erst laden");
    expect(validateValues(fields, {}, existing, { ORG: [{ value: "neu-org", label: "Neu" }] }).ORG).toBe("Organisation: keine gültige Auswahl");
    expect(validateValues(fields, {}, existing, { ORG: [{ value: "alt-org", label: "Alt" }] })).toEqual({});
    // Im Schritt selbst (ohne loaded) wie bisher
    expect(validateValues(fields, {}, existing)).toEqual({});
  });

  test("choicesKey über die wirksamen Werte: auch ein gespeicherter Tokenwechsel macht die Liste ungültig", () => {
    const before = choicesKey(fields, "ORG", { TOKEN: "gespeichert-alt" });
    expect(choicesKey(fields, "ORG", { TOKEN: "gespeichert-neu" })).not.toBe(before);
    expect(choicesKey(fields, "ORG", { TOKEN: "gespeichert-alt", ORG: "egal" })).toBe(before);
  });

  test("choicesKey hängt nur von den Eingaben davor ab", () => {
    const a = choicesKey(fields, "ORG", { TOKEN: "eins", NAME: "x" });
    expect(choicesKey(fields, "ORG", { TOKEN: "eins", NAME: "x", PASS: "egal" })).toBe(a);
    expect(choicesKey(fields, "ORG", { TOKEN: "zwei", NAME: "x" })).not.toBe(a);
    expect(a).not.toContain("eins");
    expect(valuesBefore(fields, "ORG", { TOKEN: "eins", PASS: "p", MODE: "neu" })).toEqual({ MODE: "neu", TOKEN: "eins" });
  });
});

describe("Transiente Felder", () => {
  test("gelten nie als gesetzt und sind nach dem Anmelden bekannt", () => {
    expect(fieldStates(fields, { PASS: "steht-zufaellig-da", TOKEN: "t" })).toEqual([
      { name: "MODE", set: false },
      { name: "NAME", set: false },
      { name: "TOKEN", set: true },
      { name: "ORG", set: false },
      { name: "PASS", set: false },
    ]);
    expect(isTransientName("PASS")).toBe(false);
    registerTransientFields([{ fields }]);
    expect(isTransientName("PASS")).toBe(true);
    expect(isTransientName("TOKEN")).toBe(false);
    expect(FLOW_FIELDS.some(f => f.transient)).toBe(true);
  });
});

describe("Ablauf oder Felder", () => {
  test("runWhen entscheidet, ohne runWhen immer Ablauf, ohne run nie", () => {
    const step = makeFlowStep();
    expect(runsAsFlow(step, { FLOW_MODE: "neu" })).toBe(true);
    expect(runsAsFlow(step, { FLOW_MODE: "vorhanden" })).toBe(false);
    expect(runsAsFlow({ run: step.run }, {})).toBe(true);
    expect(runsAsFlow({}, {})).toBe(false);
  });
});

describe("maskValues", () => {
  test("lange, kurze und URL-kodierte Werte, Einrückung bleibt", () => {
    expect(maskValues("    Token abcdef und abcdef", ["abcdef"])).toBe("    Token *** und ***");
    expect(maskValues("x=a%20b%2Fc", ["a b/c"])).toBe("x=***");
  });

  test("kurze Werte auch mitten in anderen Zeichen", () => {
    expect(maskValues("Passwort=xq7x", ["q7"])).toBe("Passwort=x***x");
    expect(maskValues("  [1/3] ab, Graphik", ["ab", "phi"])).toBe("  [1/3] ***, Gra***k");
    expect(maskValues("config/transient-q7.json", ["q7"])).toBe("config/transient-***.json");
    // URL-kodiert, kurz und eingebettet
    expect(maskValues("x/a%2Fb/y", ["a/b"])).toBe("x/***/y");
    expect(containsValue(maskValues("abq7q7cd q7", ["q7"]), ["q7"])).toBe(false);
  });

  test("maskStandalone lässt Eingebettetes stehen, containsValue findet es", () => {
    expect(maskStandalone("Passwort=xq7x", ["q7"])).toBe("Passwort=xq7x");
    expect(containsValue("Passwort=xq7x", ["q7"])).toBe(true);
    expect(containsValue("Passwort=x", ["q7"])).toBe(false);
  });
});
