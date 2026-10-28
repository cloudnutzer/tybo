import { describe, expect, test } from "bun:test";
import { parseBeforeCursor, parseTelegramConversationId, telegramTopicConversationId } from "../src/web/telegram";
import { isConversationId } from "../src/web/store";

describe("parseTelegramConversationId", () => {
  test("erkennt Direktchat und Topics", () => {
    expect(parseTelegramConversationId("dm")).toEqual({ kind: "dm" });
    expect(parseTelegramConversationId("topic-443")).toEqual({ kind: "topic", topicId: 443 });
    expect(parseTelegramConversationId("topic-1")).toEqual({ kind: "topic", topicId: 1 });
    expect(parseTelegramConversationId("topic-9999999999")).toEqual({ kind: "topic", topicId: 9999999999 });
  });

  test("lehnt alles andere ab", () => {
    for (const id of [
      "topic-abc",
      "topic-",
      "../x",
      "topic-0",
      "topic-01",
      "topic--1",
      "topic-1.5",
      "topic-1/",
      "topic-12345678901",
      "Topic-1",
      "DM",
      "dm ",
      "",
      "topic-1%2F",
      "0e8f6f7a-5b1e-4c2a-9d3f-1a2b3c4d5e6f",
    ]) {
      expect(parseTelegramConversationId(id)).toBeNull();
    }
    expect(parseTelegramConversationId(undefined)).toBeNull();
    expect(parseTelegramConversationId(443)).toBeNull();
  });

  test("getrennt von den UUIDs der Web-Gespräche", () => {
    expect(isConversationId("dm")).toBe(false);
    expect(isConversationId("topic-443")).toBe(false);
  });

  test("telegramTopicConversationId ist die Umkehrung", () => {
    expect(telegramTopicConversationId(443)).toBe("topic-443");
    expect(parseTelegramConversationId(telegramTopicConversationId(7))).toEqual({ kind: "topic", topicId: 7 });
  });
});

describe("parseBeforeCursor", () => {
  test("gültige Zeitpunkte werden normalisiert", () => {
    expect(parseBeforeCursor("2026-09-23T10:00:00.000Z")).toBe("2026-09-23T10:00:00.000Z");
    expect(parseBeforeCursor("2026-09-23T12:00:00+02:00")).toBe("2026-09-23T10:00:00.000Z");
    expect(parseBeforeCursor("2026-09-23T10:00:00.123000+00:00")).toBe("2026-09-23T10:00:00.123Z");
  });

  test("Mikrosekunden bleiben erhalten, auch bei Zeitzonen-Umrechnung", () => {
    expect(parseBeforeCursor("2026-09-23T10:00:00.123456+00:00")).toBe("2026-09-23T10:00:00.123456Z");
    expect(parseBeforeCursor("2026-09-23T12:00:00.000001+02:00")).toBe("2026-09-23T10:00:00.000001Z");
    expect(parseBeforeCursor("2026-09-23T10:00:00.1234Z")).toBe("2026-09-23T10:00:00.123400Z");
  });

  test("ungültige werden abgelehnt", () => {
    for (const v of ["", "gestern", "2026-09-23", "2026-13-40T99:00:00Z", "1695463200000", "2026-09-23T10:00:00Z,x"]) {
      expect(parseBeforeCursor(v)).toBeNull();
    }
  });
});
