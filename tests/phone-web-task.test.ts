/**
 * Issue #367, Checkbox 2: Auftrag aus einem Anruf in einem reinen
 * Web-Gespräch. Der ganze Weg von der Rückfrage bis zur Meldung läuft mit dem
 * echten Dienst, der echten Zustellung (phoneDelivery) und dem echten
 * Rückfragen-Register in einem Testordner; Anbieter (fetch), Aux-Modell und
 * Outbox sind Attrappen. Belegt: Zusammenfassung und Rückfrage im
 * Web-Gespräch, nach „Ja, erledigen“ eine Meldung mit dem Auftrag statt eines
 * Fehlers, keine Zusage „Ich erledige jetzt“, kein Turn. Telegram bleibt wie
 * bisher (Zusage, dann Turn im Chat samt Topic).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { decideChoice, listChoices, onChoiceDecided, setChoicesFileForTests, type ChoiceConversation } from "../src/lib/choices";
import type { SendAndRecordInput } from "../src/lib/outbox";
import { phoneDelivery, PHONE_SOURCE } from "../src/lib/phone";
import { createPhoneLedger } from "../src/lib/phone/ledger";
import { createElevenLabsCaller } from "../src/lib/phone/provider";
import { createPhoneService, PHONE_TEXT } from "../src/lib/phone/service";
import { webConversationChatId } from "../src/lib/channels";

const ENV = {
  ELEVENLABS_API_KEY: "test-key",
  ELEVENLABS_AGENT_ID: "agent-1",
  ELEVENLABS_PHONE_NUMBER_ID: "number-1",
  USER_PHONE_NUMBER: "+49 151 0000000",
};
const WEB_ID = "0c1a2b3c-0000-4000-8000-000000000000";
const TASK = "Folien für Freitag vorbereiten";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phone-web-"));
  setChoicesFileForTests(join(dir, "data", "choices.json"));
});
afterEach(() => {
  setChoicesFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function rig() {
  const sent: SendAndRecordInput[] = [];
  const turns: unknown[][] = [];
  const logs: string[] = [];
  const fetch = async (url: string) =>
    url.endsWith("/twilio/outbound-call")
      ? json({ success: true, conversation_id: "conv-1" })
      : json({ status: "done", transcript: [{ role: "user", message: "Bitte bereite die Folien vor." }] });
  let clock = 1_000_000;
  const service = createPhoneService({
    caller: createElevenLabsCaller({ env: ENV, fetch }),
    ledger: createPhoneLedger(join(dir, "data", "phone-calls.json"), () => clock),
    summarize: async () => "Folien besprochen.",
    findTask: async () => TASK,
    ...phoneDelivery(
      {
        send: async input => {
          sent.push(input);
          return { sent: true, recorded: true };
        },
        // Ohne Telegram: die Rückfrage steht nur im Register (WebUI)
        sendChoice: async () => ({ sent: false, error: "kein Telegram" }),
        runTask: async (...args) => void turns.push(args),
      },
      line => logs.push(line),
    ),
    now: () => clock,
    sleep: async ms => void (clock += ms),
    log: line => logs.push(line),
  });
  return { service, sent, turns, logs };
}

async function confirm(conversation: ChoiceConversation) {
  const r = rig();
  const off = onChoiceDecided("call", r.service.handler);
  try {
    const started = await r.service.startCall({ reason: "Folien", conversation });
    expect(started.ok).toBe(true);
    await r.service.idle();
    const [choice] = await listChoices();
    expect(choice.conversation).toEqual(conversation);
    expect(choice.text).toBe(PHONE_TEXT.question(TASK));
    const before = r.sent.length;
    const decided = await decideChoice(choice.id, "run", "web");
    expect(decided.status).toBe("decided");
    return { ...r, after: r.sent.slice(before) };
  } finally {
    off();
  }
}

describe("Auftrag aus einem Anruf im reinen Web-Gespräch", () => {
  test("Zusammenfassung im Web-Gespräch, nach Zustimmung Meldung mit dem Auftrag, keine Zusage, kein Turn, kein Fehler", async () => {
    const web: ChoiceConversation = { type: "web", conversationId: WEB_ID };
    const { sent, after, turns, logs } = await confirm(web);
    const chatId = webConversationChatId(WEB_ID);
    expect(sent[0]).toMatchObject({ chatId, text: PHONE_TEXT.summary("Folien besprochen."), source: PHONE_SOURCE });
    expect(after).toEqual([{ chatId, text: PHONE_TEXT.webTask(TASK), source: PHONE_SOURCE, format: "plain" }]);
    expect(after.some(m => m.text === PHONE_TEXT.starting(TASK))).toBe(false);
    expect(turns).toEqual([]);
    expect(logs.some(l => l.includes("unterbrochen") || l.includes(TASK))).toBe(false);
  });

  test("Telegram-Topic unverändert: erst die Zusage, dann der Turn im Chat samt Topic", async () => {
    const topic: ChoiceConversation = { type: "telegram", chatId: "-1001234567890", topicId: 42 };
    const { after, turns } = await confirm(topic);
    expect(after.map(m => m.text)).toEqual([PHONE_TEXT.starting(TASK)]);
    expect(turns).toEqual([["-1001234567890", TASK, 42]]);
  });
});
