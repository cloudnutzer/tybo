/**
 * Sprach-Brücke liest den Anlass ausgehender Anrufe (Issue #366): über den
 * testbaren Brückenkern (handleBridge) mit der echten Anrufliste und dem
 * Hook aus src/lib/phone/bridge-note.ts, wie ihn src/voice-bridge.ts setzt.
 * Anthropic ist per fetch-Attrappe ersetzt.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { callNote, CALL_REF_HEADER, CONVERSATION_ID_HEADER } from "../src/lib/phone/bridge-note";
import { createPhoneLedger, type PhoneLedger } from "../src/lib/phone/ledger";
import { handleBridge, type BridgeEnv, type BridgeHooks } from "../src/lib/voice-bridge/bridge";

const env: BridgeEnv = {
  VOICE_ANTHROPIC_API_KEY: "sk-test",
  VOICE_BRIDGE_TOKEN: "bridge-token",
  VOICE_MODEL: "claude-opus-5",
  VOICE_DEFAULT_EFFORT: "medium",
  VOICE_AGENT_NAME: "Mia",
  VOICE_ALLOWED_CALLERS: "+49 151 0000000",
};

/** Ausgehender Anruf: angerufen wird die freigeschaltete Nummer */
const OUTBOUND = { "x-voice-caller-id": "+4930111111", "x-voice-called-number": "+491510000000", "x-voice-channel": "sip_trunk" };

const STREAM = [
  { type: "message_start", message: { id: "m1" } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ja, es geht um die Folien." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
]
  .map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  .join("");

let dir: string;
let ledger: PhoneLedger;
const realFetch = globalThis.fetch;
let modelCalls: { system: string }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phone-bridge-"));
  ledger = createPhoneLedger(join(dir, "data", "phone-calls.json"));
  ledger.add({
    ref: "ref-abc",
    reason: "Die Folien für Freitag sind noch offen",
    conversation: { type: "telegram", chatId: "4711" },
    userName: "Alex",
    createdAt: Date.now(),
    deadline: Date.now() + 60_000,
    stage: "dialing",
    updatedAt: Date.now(),
  });
  modelCalls = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input).includes("api.anthropic.com")) {
      modelCalls.push(JSON.parse(init.body));
      return new Response(STREAM, { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`unerwarteter Aufruf ${String(input)}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

async function turn(headers: Record<string, string>, hooks: BridgeHooks): Promise<string> {
  const req = new Request("https://bridge.test/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer bridge-token", "content-type": "application/json", ...headers },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "Hallo, worum geht's?" }] }),
  });
  const res = await handleBridge(req, env, hooks, () => {});
  return res.text();
}

describe("Sprach-Brücke und Anlass", () => {
  test("Anlass erreicht den ersten Modellaufruf, über die eigene Kennung", async () => {
    await turn({ ...OUTBOUND, [CALL_REF_HEADER]: "ref-abc" }, { callNote: ids => callNote(ledger, ids) });
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0].system).toContain("Die Folien für Freitag sind noch offen");
  });

  test("über die Kennung beim Anbieter, je Turn frisch gelesen (kein Kontext-Cache)", async () => {
    const hooks: BridgeHooks = { callNote: ids => callNote(ledger, ids), loadContext: async () => "## MEMORY" };
    const headers = { ...OUTBOUND, [CALL_REF_HEADER]: "{{tybo_call_ref}}", [CONVERSATION_ID_HEADER]: "conv-9" };
    await turn(headers, hooks);
    expect(modelCalls[0].system).not.toContain("Anlass dieses Gesprächs");
    ledger.advance("ref-abc", ["dialing"], "waiting", { conversationId: "conv-9" });
    await turn(headers, hooks);
    expect(modelCalls[1].system).toContain("Die Folien für Freitag sind noch offen");
  });

  test("fremde Rufnummer: abgewiesen, der Anlass wird nicht einmal gelesen", async () => {
    let reads = 0;
    const text = await turn(
      { "x-voice-caller-id": "+4930999999", [CALL_REF_HEADER]: "ref-abc" },
      { callNote: ids => { reads++; return callNote(ledger, ids); } },
    );
    expect(text).toContain("Dieser Anschluss ist privat");
    expect(reads).toBe(0);
    expect(modelCalls).toHaveLength(0);
  });

  test("falsches Token: 401 vor allem anderen", async () => {
    const req = new Request("https://bridge.test/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer falsch", [CALL_REF_HEADER]: "ref-abc" }, body: "{}" });
    let reads = 0;
    const res = await handleBridge(req, env, { callNote: () => { reads++; return null; } }, () => {});
    expect(res.status).toBe(401);
    expect(reads).toBe(0);
  });

  test("Hook scheitert: Turn läuft ohne Anlass weiter", async () => {
    const text = await turn({ ...OUTBOUND, [CALL_REF_HEADER]: "ref-abc" }, { callNote: () => { throw new Error("Liste weg"); } });
    expect(text).toContain("Folien");
    expect(modelCalls).toHaveLength(1);
  });
});
