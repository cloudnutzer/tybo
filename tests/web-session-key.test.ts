import { expect, test } from "bun:test";
import { sessionKeyFor } from "../src/lib/convex";

test("Web-Gespräche: Chat-ID web:<id> ist zugleich der Session-Schlüssel", () => {
  expect(sessionKeyFor("web:abc")).toBe("web:abc");
  expect(sessionKeyFor("web:abc", null)).toBe("web:abc");
});

test("Telegram-Schlüssel bleiben unverändert", () => {
  expect(sessionKeyFor("12345")).toBe("dm:12345");
  expect(sessionKeyFor("-100777", null)).toBe("group:-100777");
  expect(sessionKeyFor("-100777", 42)).toBe("topic:-100777:42");
});
