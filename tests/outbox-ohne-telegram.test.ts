/**
 * Issue #227, Schritt 1: Kanal-Weiche und Outbox ohne Telegram. Ohne
 * TELEGRAM_BOT_TOKEN hält sendAndRecord nur fest (Web-Direktchat "web"),
 * Web-Ziele (web:<uuid>) werden auch mit Telegram nur festgehalten; nie ein
 * Aufruf an api.telegram.org. Dazu conversationEnv, notify, Jobs und die
 * Dienste (Watchdog, Check-in, Briefing).
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dmChatId, isWebChatId, outboxDelivered, telegramConfigured, webConversationOf } from "../src/lib/channels";
import { checkOutboxTarget, sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import { conversationEnv, CONVERSATION_VARS } from "../src/lib/subprocess-env";
import type { Message } from "../src/lib/supabase";
import { applyEnvTarget, EXIT_OK, EXIT_SEND_FAILED, EXIT_USAGE, runNotify } from "../scripts/notify";
import { resolveJobTarget } from "../src/lib/jobs/cli";
import { jobClaudeEnv } from "../src/lib/jobs/default-deps";
import { deliverNotice } from "../src/lib/jobs/notice";
import { readStatus, writeStatus } from "../src/lib/jobs/store";
import { sendAlert } from "../src/watchdog";
import { deliverCheckin } from "../src/smart-checkin";
import { sendBriefing } from "../src/morning-briefing";
import { fakeDeps as fakeJobDeps, tempRoot } from "./jobs-fixture";

const USER = "4711";
const GROUP = "-1001234567890";
const TOKEN = "123:test-token";
const CONV = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outbox-ohne-tg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fake(options: { token?: string; userId?: string; groupId?: string | null; record?: (m: Message) => Promise<boolean> } = {}) {
  const fetched: string[] = [];
  const recorded: Message[] = [];
  const logs: string[] = [];
  const deps: OutboxDeps = {
    botToken: options.token ?? "",
    userId: options.userId ?? "",
    groupId: options.groupId === undefined ? GROUP : options.groupId,
    outboxDir: join(dir, "data", "outbox"),
    fetch: async url => {
      fetched.push(url);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    },
    record:
      options.record ??
      (async m => {
        recorded.push(m);
        return true;
      }),
    log: line => logs.push(line),
    newId: () => crypto.randomUUID(),
  };
  return { deps, fetched, recorded, logs };
}

describe("Kanal-Weiche", () => {
  test("telegramConfigured: Token und gültige Nutzer-ID", () => {
    expect(telegramConfigured({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: USER })).toBe(true);
    expect(telegramConfigured({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_USER_ID: USER })).toBe(false);
    expect(telegramConfigured({ TELEGRAM_BOT_TOKEN: TOKEN })).toBe(false);
    expect(telegramConfigured({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: "abc" })).toBe(false);
    expect(telegramConfigured({})).toBe(false);
  });

  test("dmChatId: Telegram-Nutzer-ID, ohne Telegram web", () => {
    expect(dmChatId({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: USER })).toBe(USER);
    expect(dmChatId({ TELEGRAM_USER_ID: USER })).toBe("web");
  });

  test("Web-Chat-IDs", () => {
    expect(isWebChatId("web")).toBe(true);
    expect(isWebChatId(`web:${CONV}`)).toBe(true);
    expect(isWebChatId("web:abc")).toBe(false);
    expect(isWebChatId(USER)).toBe(false);
    expect(webConversationOf(`web:${CONV}`)).toBe(CONV);
    expect(webConversationOf("web")).toBeNull();
  });

  test("outboxDelivered: gesendet oder ohne Fehler festgehalten", () => {
    expect(outboxDelivered({ sent: true, recorded: false })).toBe(true);
    expect(outboxDelivered({ sent: false, recorded: true })).toBe(true);
    expect(outboxDelivered({ sent: false, recorded: false })).toBe(false);
    expect(outboxDelivered({ sent: false, recorded: true, error: { kind: "record" } })).toBe(false);
    expect(outboxDelivered({ sent: false })).toBe(false);
  });
});

describe("sendAndRecord ohne Telegram", () => {
  test("Text: festgehalten im Web-Direktchat, kein Aufruf an api.telegram.org", async () => {
    const { deps, fetched, recorded } = fake();
    const result = await sendAndRecord({ text: "**Briefing** fertig", source: "briefing" }, deps);
    expect(result).toEqual({ sent: false, recorded: true });
    expect(fetched).toEqual([]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ chat_id: "web", role: "assistant", content: "**Briefing** fertig", metadata: { display_only: true, source: "briefing" } });
  });

  test("Datei: in data/outbox/ abgelegt und mit Dateiangaben festgehalten, nie gesendet", async () => {
    const { deps, fetched, recorded } = fake();
    const path = join(dir, "Bericht.pdf");
    writeFileSync(path, "PDF-Inhalt");
    const result = await sendAndRecord({ text: "Anbei", file: path, caption: "Bericht", source: "datei" }, deps);
    expect(result.sent).toBe(false);
    expect(result.recorded).toBe(true);
    expect(result.error).toBeUndefined();
    expect(fetched).toEqual([]);
    expect(recorded.map(m => m.content)).toEqual(["Anbei", "Bericht"]);
    const file = recorded[1].metadata!.file as { id: string; name: string; size: number };
    expect(file).toMatchObject({ name: "Bericht.pdf", size: 10 });
    expect(existsSync(join(dir, "data", "outbox", file.id, "Bericht.pdf"))).toBe(true);
    expect(result.file?.id).toBe(file.id);
  });

  test("Rückfrage: choiceId bleibt, Knöpfe fallen weg", async () => {
    const { deps, fetched, recorded } = fake();
    const result = await sendAndRecord(
      { text: "Weiter?", format: "plain", source: "goal", choiceId: "Ab12", buttons: [[{ text: "Ja", callback_data: "ch|Ab12|y" }]] },
      deps
    );
    expect(outboxDelivered(result)).toBe(true);
    expect(fetched).toEqual([]);
    expect(recorded[0].metadata).toEqual({ display_only: true, source: "goal", choiceId: "Ab12" });
  });

  test("Festhalten scheitert: Fehler record, nicht zugestellt", async () => {
    const { deps, fetched } = fake({ record: async () => false });
    const result = await sendAndRecord({ text: "x", source: "watchdog" }, deps);
    expect(result).toEqual({ sent: false, recorded: false, error: { kind: "record", message: expect.any(String) } });
    expect(outboxDelivered(result)).toBe(false);
    expect(fetched).toEqual([]);
  });

  test("Datei nicht festgehalten: Fehler record, Kopie wieder entfernt", async () => {
    const { deps } = fake({ record: async m => !(m.metadata && "file" in m.metadata) });
    const path = join(dir, "a.txt");
    writeFileSync(path, "Hallo");
    const result = await sendAndRecord({ file: path, source: "datei" }, deps);
    expect(result.error?.kind).toBe("record");
    const outbox = join(dir, "data", "outbox");
    expect(existsSync(outbox) ? readdirSync(outbox) : []).toEqual([]);
  });

  test("Datei nicht ablegbar: Fehler record", async () => {
    const { deps } = fake();
    const path = join(dir, "a.txt");
    writeFileSync(path, "Hallo");
    // Ablage-ID, die outboxPath ablehnt
    const result = await sendAndRecord({ file: path, source: "datei" }, { ...deps, newId: () => "kaputt" });
    expect(result.error?.kind).toBe("record");
    expect(result.recorded).toBe(false);
  });

  test("Topic oder Telegram-Chat ohne Telegram: klare Ablehnung, auch mit konfigurierter Gruppe", async () => {
    const { deps, fetched, recorded } = fake({ userId: USER, groupId: GROUP });
    const topic = await sendAndRecord({ text: "x", topicId: 443, source: "watcher" }, deps);
    expect(topic.error?.kind).toBe("invalid");
    expect(topic.error?.message).toContain("Telegram ist nicht eingerichtet");
    const chat = await sendAndRecord({ text: "x", chatId: USER, source: "watcher" }, deps);
    expect(chat.error?.kind).toBe("invalid");
    expect(fetched).toEqual([]);
    expect(recorded).toEqual([]);
  });

  test("Nutzer-ID ohne Token zählt nicht als Telegram", async () => {
    const { deps, fetched, recorded } = fake({ userId: USER });
    expect((await sendAndRecord({ text: "x", source: "p" }, deps)).recorded).toBe(true);
    expect(recorded[0].chat_id).toBe("web");
    expect(fetched).toEqual([]);
  });
});

describe("Web-Ziele mit Telegram", () => {
  test("web:<uuid> wird nur festgehalten, nie gesendet", async () => {
    const { deps, fetched, recorded } = fake({ token: TOKEN, userId: USER });
    const result = await sendAndRecord({ text: "Job fertig", chatId: `web:${CONV}`, source: "job" }, deps);
    expect(result).toEqual({ sent: false, recorded: true });
    expect(fetched).toEqual([]);
    expect(recorded[0].chat_id).toBe(`web:${CONV}`);
  });

  test("web mit Topic und ungültige web:-IDs werden abgelehnt", async () => {
    const { deps, fetched } = fake({ token: TOKEN, userId: USER });
    expect((await sendAndRecord({ text: "x", chatId: `web:${CONV}`, topicId: 5, source: "p" }, deps)).error?.kind).toBe("invalid");
    expect((await sendAndRecord({ text: "x", chatId: "web:abc", source: "p" }, deps)).error?.kind).toBe("invalid");
    expect(fetched).toEqual([]);
  });

  test("ohne Angabe bleibt es mit Telegram beim Telegram-Direktchat", async () => {
    const { deps, fetched, recorded } = fake({ token: TOKEN, userId: USER });
    const result = await sendAndRecord({ text: "x", source: "p" }, deps);
    expect(result.sent).toBe(true);
    expect(fetched[0]).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(recorded[0].chat_id).toBe(USER);
  });

  test("checkOutboxTarget kennt die neuen Ziele", () => {
    expect(checkOutboxTarget({ chatId: `web:${CONV}` }, { groupId: GROUP, userId: USER })).toBeNull();
    expect(checkOutboxTarget({ chatId: "web" }, { groupId: null, userId: "", botToken: "" })).toBeNull();
    expect(checkOutboxTarget({}, { groupId: null, userId: "", botToken: "" })).toBeNull();
    expect(checkOutboxTarget({ topicId: 5 }, { groupId: GROUP, userId: USER, botToken: "" })).toContain("Telegram ist nicht eingerichtet");
  });
});

describe("Gesprächs-Umgebung", () => {
  test("dm:web setzt TYBO_CHAT_ID=web, web:<uuid> TYBO_CONVERSATION_ID", () => {
    expect(conversationEnv("dm:web")).toEqual({ TYBO_CHAT_ID: "web" });
    expect(conversationEnv(`web:${CONV}`)).toEqual({ TYBO_CONVERSATION_ID: CONV });
    expect(conversationEnv("web:abc")).toEqual({});
    expect(CONVERSATION_VARS).toContain("TYBO_CONVERSATION_ID");
  });
});

describe("bun run notify", () => {
  function notifyDeps(options: Parameters<typeof fake>[0] = {}) {
    const f = fake(options);
    const out: string[] = [];
    const err: string[] = [];
    return { ...f, io: { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) }, out, err };
  }

  test("mit TYBO_CONVERSATION_ID landet die Meldung im Web-Gespräch, ohne Telegram-Aufruf", async () => {
    const s = notifyDeps({ token: TOKEN, userId: USER });
    const code = await runNotify(["--source", "job", "--text", "Fertig"], () => s.deps, s.io, { TYBO_CONVERSATION_ID: CONV });
    expect(code).toBe(EXIT_OK);
    expect(s.fetched).toEqual([]);
    expect(s.recorded.map(m => m.chat_id)).toEqual([`web:${CONV}`]);
    expect(s.out[0]).toContain("WebUI");
  });

  test("TYBO_CONVERSATION_ID geht vor TYBO_CHAT_ID/TYBO_TOPIC_ID, --topic vor allem", () => {
    const input = { source: "p", text: "x" };
    expect(applyEnvTarget(input, { TYBO_CONVERSATION_ID: CONV, TYBO_CHAT_ID: USER, TYBO_TOPIC_ID: "5" })).toEqual({
      input: { ...input, chatId: `web:${CONV}` },
    });
    expect(applyEnvTarget({ ...input, topicId: 7 }, { TYBO_CONVERSATION_ID: CONV })).toEqual({ input: { ...input, topicId: 7 } });
    expect(applyEnvTarget(input, { TYBO_CHAT_ID: "web" })).toEqual({ input: { ...input, chatId: "web" } });
    expect(applyEnvTarget(input, { TYBO_CONVERSATION_ID: "abc" })).toHaveProperty("error");
    expect(applyEnvTarget(input, { TYBO_CONVERSATION_ID: "" })).toHaveProperty("error");
  });

  test("ohne Telegram: Direktchat der WebUI, Exit 0", async () => {
    const s = notifyDeps();
    expect(await runNotify(["--source", "pipeline", "--text", "Hallo"], () => s.deps, s.io, {})).toBe(EXIT_OK);
    expect(s.recorded.map(m => m.chat_id)).toEqual(["web"]);
    expect(s.fetched).toEqual([]);
  });

  test("ohne Telegram und Festhalten scheitert: Exit 1; --topic: Exit 2", async () => {
    const failing = notifyDeps({ record: async () => false });
    expect(await runNotify(["--source", "pipeline", "--text", "Hallo"], () => failing.deps, failing.io, {})).toBe(EXIT_SEND_FAILED);
    expect(failing.err[0]).toContain("Nicht festgehalten");
    const topic = notifyDeps();
    expect(await runNotify(["--source", "pipeline", "--text", "Hallo", "--topic", "5"], () => topic.deps, topic.io, {})).toBe(EXIT_USAGE);
    expect(topic.err[0]).toContain("Telegram ist nicht eingerichtet");
  });
});

describe("Jobs", () => {
  const { root, cleanup } = tempRoot("jobs-web-");
  afterAll(cleanup);

  test("Ziel aus TYBO_CONVERSATION_ID, gültig auch ohne Telegram", () => {
    const target = resolveJobTarget(undefined, { TYBO_CONVERSATION_ID: CONV });
    expect(target).toEqual({ chatId: `web:${CONV}` });
    expect(checkOutboxTarget(target as { chatId: string }, { groupId: null, userId: "", botToken: "" })).toBeNull();
  });

  test("Claude des Jobs bekommt TYBO_CONVERSATION_ID statt TYBO_CHAT_ID", () => {
    const env = jobClaudeEnv(root, { PATH: "/usr/bin", HOME: root }, {
      id: "20260929-120000-000001",
      target: { chatId: `web:${CONV}` },
    } as never);
    expect(env.TYBO_CONVERSATION_ID).toBe(CONV);
    expect(env.TYBO_CHAT_ID).toBeUndefined();
    const dm = jobClaudeEnv(root, { PATH: "/usr/bin", HOME: root }, { id: "20260929-120000-000002", target: { chatId: "web" } } as never);
    expect(dm.TYBO_CHAT_ID).toBe("web");
  });

  test("Meldung für die WebUI festgehalten gilt als zugestellt: kein zweiter Versuch", async () => {
    const id = "20260929-120000-00000a";
    await writeStatus(root, {
      version: 1, id, title: "Bericht", createdAt: new Date().toISOString(), phase: "ended", outcome: "done", maxHours: 1,
      model: "m", fullAccess: false, target: { chatId: `web:${CONV}` },
      notice: { state: "pending", attempts: 0, owner: { pid: 1, identity: "x", token: "tok" } },
    } as never);
    let attempts = 0;
    const deps = fakeJobDeps(root, {
      notify: async () => {
        attempts++;
        return { sent: false, recorded: true };
      },
    });
    expect(await deliverNotice(id, "tok", deps)).toBe("sent");
    expect(attempts).toBe(1);
    expect((await readStatus(root, id))?.notice).toMatchObject({ state: "sent", recorded: true });
  });

  test("Festhalten gescheitert: wird wiederholt und endet als failed", async () => {
    const id = "20260929-120000-00000b";
    await writeStatus(root, {
      version: 1, id, title: "Bericht", createdAt: new Date().toISOString(), phase: "ended", outcome: "done", maxHours: 1,
      model: "m", fullAccess: false, target: {},
      notice: { state: "pending", attempts: 0, owner: { pid: 1, identity: "x", token: "tok" } },
    } as never);
    let attempts = 0;
    const deps = fakeJobDeps(root, {
      notify: async () => {
        attempts++;
        return { sent: false, recorded: false, error: { kind: "record", message: "nicht festgehalten" } };
      },
    });
    expect(await deliverNotice(id, "tok", deps)).toBe("failed");
    expect(attempts).toBeGreaterThan(1);
  });
});

describe("Dienste zählen WebUI-Zustellung als Erfolg", () => {
  test("Watchdog meldet ohne Telegram über die Outbox", async () => {
    const logs: string[] = [];
    const calls: unknown[] = [];
    const ok = await sendAlert("🚨 Alarm", {
      send: async input => {
        calls.push(input);
        return { sent: false, recorded: true };
      },
      log: l => void logs.push(l),
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([{ text: "🚨 Alarm", source: "watchdog" }]);
    expect(logs[0]).toContain("WebUI");
  });

  test("Check-in speichert den Zustand, Briefing gilt als gesendet", async () => {
    let saved = 0;
    const sent = await deliverCheckin({ action: "text", message: "Wie läuft's?" }, { lastMessageTime: "", lastCheckinTime: "", pendingItems: [] } as never, {
      send: async () => ({ sent: false, recorded: true }),
      saveState: async () => {
        saved++;
      },
      now: () => new Date("2026-09-29T10:00:00Z"),
    });
    expect(sent).toBe(true);
    expect(saved).toBe(1);
    expect(await sendBriefing("☀️", async () => ({ sent: false, recorded: true }))).toBe(true);
    expect(await sendBriefing("☀️", async () => ({ sent: false, recorded: false, error: { kind: "record" as const, message: "x" } }))).toBe(false);
  });
});
