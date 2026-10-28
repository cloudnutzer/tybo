/**
 * Issue #304: Das Standardmodell steht als Literal fest. Seit dem 22.9.2026
 * gibt es kein Routing nach Komplexität mehr; das Restmodul model-router.ts
 * ist mit Gateway und Agent-SDK-Session in Issue #352 entfallen.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_CLAUDE_MODEL } from "../src/lib/default-model";

const EXPECTED_MODEL = "claude-opus-5-5";

describe("Standardmodell", () => {
  test("DEFAULT_CLAUDE_MODEL ist claude-opus-5-5", () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe(EXPECTED_MODEL);
  });
});
