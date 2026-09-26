/**
 * Issue #46, Aufgabe 4: telegram_send_document über sendAndRecord (Quelle
 * datei), mit optionaler topic_id. Telegram und Speicher sind Attrappen.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { OutboxDeps } from "../src/lib/outbox";
import type { Message } from "../src/lib/supabase";
import { sendDocumentTool } from "../src/lib/tools/telegram-document";
import { getBuiltinTool } from "../src/lib/tools/registry";

const USER = "4711";
const GROUP = "-1001234567890";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "doc-tool-"));
  file = join(dir, "bericht.html");
  writeFileSync(file, "<h1>Bericht</h1>");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeDeps(options: { groupId?: string | null; status?: number; recordOk?: boolean } = {}) {
  const forms: FormData[] = [];
  const urls: string[] = [];
  const recorded: Message[] = [];
  const deps: OutboxDeps = {
    botToken: "123:t",
    userId: USER,
    groupId: options.groupId === undefined ? GROUP : options.groupId,
    outboxDir: join(dir, "outbox"),
    fetch: async (url, init) => {
      urls.push(url);
      forms.push(init.body as FormData);
      return new Response("{}", { status: options.status ?? 200 });
    },
    record: async m => {
      recorded.push(m);
      return options.recordOk ?? true;
    },
    log: () => {},
    newId: () => crypto.randomUUID(),
  };
  return { deps, forms, urls, recorded };
}

test("Tool ist registriert und bietet topic_id an", () => {
  const tool = getBuiltinTool("telegram_send_document");
  expect(tool).toBeDefined();
  expect(tool?.inputSchema.properties).toHaveProperty("topic_id");
  expect(tool?.requiresApproval).toBeFalsy();
});

describe("Ziele", () => {
  test("ohne topic_id: Owner-Direktchat, sent_to owner DM, Quelle datei", async () => {
    const f = fakeDeps();
    const out = JSON.parse(await sendDocumentTool({ file_path: file, caption: "Report" }, f.deps));
    expect(out).toEqual({ success: true, file: "bericht.html", bytes: 16, sent_to: "owner DM" });
    expect(f.urls[0]).toEndWith("/sendDocument");
    expect(f.forms[0].get("chat_id")).toBe(USER);
    expect(f.forms[0].get("message_thread_id")).toBeNull();
    expect(f.forms[0].get("caption")).toBe("Report");
    expect(f.recorded).toHaveLength(1);
    expect(f.recorded[0].chat_id).toBe(USER);
    expect(f.recorded[0].metadata).toMatchObject({ display_only: true, source: "datei" });
  });

  test("mit topic_id: Forum-Gruppe mit Thread, sent_to topic <n>", async () => {
    const f = fakeDeps();
    const out = JSON.parse(await sendDocumentTool({ file_path: file, topic_id: 443 }, f.deps));
    expect(out.sent_to).toBe("topic 443");
    expect(f.forms[0].get("chat_id")).toBe(GROUP);
    expect(f.forms[0].get("message_thread_id")).toBe("443");
    expect(f.recorded[0]).toMatchObject({ chat_id: GROUP, metadata: { topicId: 443, source: "datei" } });
  });

  test("topic_id als Ziffernfolge wird akzeptiert", async () => {
    const f = fakeDeps();
    expect(JSON.parse(await sendDocumentTool({ file_path: file, topic_id: "443" }, f.deps)).sent_to).toBe("topic 443");
  });

  test("topic_id 1: General ohne Thread, sent_to General", async () => {
    const f = fakeDeps();
    const out = JSON.parse(await sendDocumentTool({ file_path: file, topic_id: 1 }, f.deps));
    expect(out.sent_to).toBe("General");
    expect(f.forms[0].get("chat_id")).toBe(GROUP);
    expect(f.forms[0].get("message_thread_id")).toBeNull();
  });

  test("ungültige topic_id: Fehler, kein Versand, keine Umleitung", async () => {
    for (const topic_id of [0, -5, 1.5, "abc", "", "0", true, {}, Number.NaN]) {
      const f = fakeDeps();
      const out = JSON.parse(await sendDocumentTool({ file_path: file, topic_id }, f.deps));
      expect(out.error).toContain("topic_id");
      expect(f.urls).toEqual([]);
    }
  });

  test("keine Gruppe eingerichtet: Fehler, kein Versand, nie Direktchat", async () => {
    for (const topic_id of [443, 1]) {
      const f = fakeDeps({ groupId: null });
      const out = JSON.parse(await sendDocumentTool({ file_path: file, topic_id }, f.deps));
      expect(out.error).toContain("Forum-Gruppe");
      expect(out.sent_to).toBeUndefined();
      expect(f.urls).toEqual([]);
    }
  });

  test("ohne topic_id und ohne Gruppe weiter Direktchat", async () => {
    const f = fakeDeps({ groupId: null });
    expect(JSON.parse(await sendDocumentTool({ file_path: file }, f.deps)).sent_to).toBe("owner DM");
  });
});

describe("bestehende Prüfungen und Fehler", () => {
  test("relativer Pfad, fehlende Datei, leere Datei, über 50 MB: Fehler ohne Versand", async () => {
    const f = fakeDeps();
    const empty = join(dir, "leer.txt");
    writeFileSync(empty, "");
    const big = join(dir, "gross.bin");
    writeFileSync(big, "");
    const { truncateSync } = await import("fs");
    truncateSync(big, 50 * 1024 * 1024 + 1);
    expect(JSON.parse(await sendDocumentTool({ file_path: "bericht.html" }, f.deps)).error).toBe("file_path muss absolut sein");
    expect(JSON.parse(await sendDocumentTool({ file_path: join(dir, "fehlt.pdf") }, f.deps)).error).toContain("nicht gefunden");
    expect(JSON.parse(await sendDocumentTool({ file_path: empty }, f.deps)).error).toBe("Datei ist leer");
    expect(JSON.parse(await sendDocumentTool({ file_path: big }, f.deps)).error).toContain("zu gross");
    expect(f.urls).toEqual([]);
  });

  test("Caption wird wie bisher auf 1024 Zeichen gekürzt statt abgelehnt", async () => {
    const f = fakeDeps();
    const out = JSON.parse(await sendDocumentTool({ file_path: file, caption: "x".repeat(2000) }, f.deps));
    expect(out.success).toBe(true);
    expect(String(f.forms[0].get("caption"))).toHaveLength(1024);
  });

  test("Telegram lehnt ab: wirft (Registry meldet isError)", async () => {
    const f = fakeDeps({ status: 500 });
    await expect(sendDocumentTool({ file_path: file }, f.deps)).rejects.toThrow("Telegram");
    expect(f.recorded).toEqual([]);
  });

  test("gesendet, aber nicht festgehalten: trotzdem Erfolg", async () => {
    const f = fakeDeps({ recordOk: false });
    expect(JSON.parse(await sendDocumentTool({ file_path: file }, f.deps)).success).toBe(true);
  });
});
