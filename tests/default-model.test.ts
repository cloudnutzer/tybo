/**
 * Issue #304: Das Standardmodell steht als Literal fest. Seit dem 22.9.2026
 * gibt es kein Routing nach Komplexität mehr; das Restmodul model-router.ts
 * ist mit Gateway und Agent-SDK-Session in Issue #352 entfallen.
 *
 * Issue #559: Nur hier stehen die festen Namen für das Standardmodell und für
 * das Modell der Bildbeschreibung, als Sperre gegen versehentliches Umstellen.
 * Alle anderen Tests vergleichen gegen DEFAULT_CLAUDE_MODEL bzw. VISION_MODEL.
 * Ein Wechsel des Standardmodells kostet im Testordner damit genau die Zeile
 * EXPECTED_DEFAULT_MODEL. Die Bildbeschreibung ist eine eigene Konstante und
 * hat deshalb einen eigenen Sollwert.
 */
import { describe, expect, test } from "bun:test";
import { VISION_MODEL } from "../src/lib/assets/describe";
import { DEFAULT_CLAUDE_MODEL } from "../src/lib/default-model";

const EXPECTED_DEFAULT_MODEL = "claude-opus-5-5";
const EXPECTED_VISION_MODEL = "claude-opus-5-5";

describe("Standardmodell", () => {
  test(`DEFAULT_CLAUDE_MODEL ist ${EXPECTED_DEFAULT_MODEL}`, () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe(EXPECTED_DEFAULT_MODEL);
  });

  test(`VISION_MODEL ist ${EXPECTED_VISION_MODEL}`, () => {
    expect(VISION_MODEL).toBe(EXPECTED_VISION_MODEL);
  });
});
