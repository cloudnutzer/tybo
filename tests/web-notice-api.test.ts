// Meldungen und Dateien in Verlauf und Live-Ereignissen (Issue #47, Schritt 1):
// kind "notice", source und file nur aus display_only === true und nur mit
// geprüften Feldern; lokale Pfade gelangen nie in die API.
import { describe, expect, test } from "bun:test";
import type { MessageSavedListener } from "../src/lib/convex";
import { toApiMessage } from "../src/web/chat";
import { createTelegramLiveFeed, toTelegramApiMessage } from "../src/web/bot-telegram";
import { pickNotice, pickNoticeFile } from "../src/web/notice";
import type { TelegramLiveEvent } from "../src/web/telegram";

const USER = "4711";
const GROUP = "-1001234567890";
const FILE_ID = "3f2b8c1e-7d4a-4b6e-9c21-5a0d8e7f6b13";
const MSG_ID = "0b7c2f7e-5a52-4c38-9d11-2f5e0c7b9a10";
const AT = "2026-09-24T10:00:00.123456+00:00";
const FILE = { id: FILE_ID, name: "Bericht März.html", size: 2048, mime: "text/html" };

function row(metadata: Record<string, unknown> | null, content = "**Pipeline** fertig") {
  return { id: "17", created_at: AT, role: "assistant", content, metadata };
}

describe("toApiMessage", () => {
  test("Meldung: kind, source, file und HTML, keine Agent- oder Kopierangaben", () => {
    const m = toApiMessage({
      id: "n1",
      role: "assistant",
      text: "**Pipeline** fertig",
      createdAt: AT,
      kind: "notice",
      source: "pipeline",
      file: { ...FILE, path: "/Users/x/data/outbox/geheim" },
      agent: "general",
      model: "claude-opus-5-5",
    });
    expect(Object.keys(m).sort()).toEqual(["createdAt", "file", "html", "id", "kind", "role", "source", "text"]);
    expect(m.kind).toBe("notice");
    expect(m.source).toBe("pipeline");
    expect(m.file).toEqual(FILE);
    expect(m.html).toContain("<strong>Pipeline</strong>");
    expect(JSON.stringify(m)).not.toContain("/Users");
  });

  test("gewöhnliche Antwort bleibt ohne kind", () => {
    const m = toApiMessage({ id: "a", role: "assistant", text: "hi", createdAt: AT });
    expect(m.kind).toBeUndefined();
    expect(m.copyText).toBe("hi");
  });
});

describe("pickNotice", () => {
  test("nur display_only === true (JSON-Boolean)", () => {
    expect(pickNotice({ display_only: true })).toEqual({ kind: "notice" });
    for (const v of ["true", 1, "1", false, null, undefined]) expect(pickNotice({ display_only: v })).toBeNull();
    expect(pickNotice(null)).toBeNull();
    expect(pickNotice("display_only")).toBeNull();
  });

  test("ungültige source fällt weg, Meldung bleibt", () => {
    expect(pickNotice({ display_only: true, source: "Pipeline<script>" })).toEqual({ kind: "notice" });
    expect(pickNotice({ display_only: true, source: 5 })).toEqual({ kind: "notice" });
    expect(pickNotice({ display_only: true, source: "neuer-dienst" })).toEqual({ kind: "notice", source: "neuer-dienst" });
  });

  test("file: nur id, name, size, mime; manipulierte Werte ergeben keine Datei", () => {
    expect(pickNoticeFile({ ...FILE, path: "/tmp/x", extra: 1 })).toEqual(FILE);
    expect(pickNoticeFile({ ...FILE, id: "../../etc" })).toBeNull();
    expect(pickNoticeFile({ ...FILE, name: "../geheim.txt" })).toBeNull();
    expect(pickNoticeFile({ ...FILE, name: "a/b.txt" })).toBeNull();
    expect(pickNoticeFile({ ...FILE, name: ".env" })).toBeNull();
    expect(pickNoticeFile({ ...FILE, name: "a\u0000b" })).toBeNull();
    expect(pickNoticeFile({ ...FILE, name: "" })).toBeNull();
    expect(pickNoticeFile({ ...FILE, size: -1 })).toBeNull();
    expect(pickNoticeFile({ ...FILE, size: 0 })).toBeNull();
    expect(pickNoticeFile({ ...FILE, size: "2048" })).toBeNull();
    expect(pickNoticeFile({ ...FILE, size: 51 * 1024 * 1024 })).toBeNull();
    expect(pickNoticeFile([FILE])).toBeNull();
    // Unbrauchbarer MIME-Typ wird neutral
    expect(pickNoticeFile({ ...FILE, mime: "text/html; charset=\"x\"\r\n" })!.mime).toBe("application/octet-stream");
  });
});

describe("toTelegramApiMessage (Verlauf)", () => {
  test("Meldung mit Datei: kind, source, file, keine lokalen Pfade", () => {
    const m = toTelegramApiMessage(
      row({ display_only: true, source: "datei", msgId: MSG_ID, file: { ...FILE, path: "/Users/x/data/outbox" }, filePath: "/Users/x" })
    )!;
    expect(m.id).toBe(MSG_ID);
    expect(m.kind).toBe("notice");
    expect(m.source).toBe("datei");
    expect(m.file).toEqual(FILE);
    expect(m.role).toBe("assistant");
    expect(JSON.stringify(m)).not.toContain("/Users");
  });

  test("display_only als Text \"true\" ist keine Meldung", () => {
    const m = toTelegramApiMessage(row({ display_only: "true", source: "pipeline", file: FILE, msgId: MSG_ID }))!;
    expect(m.kind).toBeUndefined();
    expect(m.source).toBeUndefined();
    expect(m.file).toBeUndefined();
  });

  test("gewöhnliche Antwort unverändert", () => {
    const m = toTelegramApiMessage(row({ msgId: MSG_ID, agent: "finance" }))!;
    expect(m.kind).toBeUndefined();
    expect(m.agent).toBe("finance");
  });
});

describe("Live-Ereignis aus dem Bot-Prozess", () => {
  test("Meldung im Topic: gleiche Felder wie im Verlauf", () => {
    let hook: MessageSavedListener | null = null;
    const feed = createTelegramLiveFeed({
      userId: USER,
      groupId: () => GROUP,
      onMessageSaved: l => {
        hook = l;
        return () => {};
      },
      log: () => {},
    });
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    hook!({
      chatId: GROUP,
      role: "assistant",
      content: "Datei gebaut",
      metadata: { display_only: true, source: "datei", msgId: MSG_ID, topicId: 443, file: FILE },
      createdAt: "2026-09-24T10:00:00.200Z",
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.conversationId).toBe("topic-443");
    const m = events[0]!.message!;
    expect(m.kind).toBe("notice");
    expect(m.source).toBe("datei");
    expect(m.file).toEqual(FILE);
    expect(m.id).toBe(MSG_ID);
  });
});
