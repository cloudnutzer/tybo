/**
 * Issue #367, Checkbox 3: Werkzeug phone_call in der Registry und der Knopf
 * „Anrufen“ unter Check-in und Briefing. Das Freigabetor ist das echte
 * (createChoiceToolApproval mit eigenem Rückfragen-Register), die Freigabe
 * bzw. Ablehnung kommt über decideChoice, als hätte der Nutzer geklickt.
 * Der Anrufdienst ist eine Attrappe; dieselbe Attrappe steht hinter /anruf,
 * Werkzeug und Knopf, damit belegt ist, dass alle drei eine Instanz nutzen.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { decideChoice, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { commandRegistry } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices } from "../src/lib/commands/types";
import { runExecution } from "../src/lib/execution-context";
import { phoneAccess, proactiveCall } from "../src/lib/phone";
import type { StartCallInput } from "../src/lib/phone/service";
import { openProactiveChoice, PROACTIVE_OPTION } from "../src/lib/proactive/choices";
import { createChoiceToolApproval, TOOL_ALLOW, TOOL_DENY, type ChoiceToolApproval } from "../src/lib/tool-approval";
import "../src/lib/tools";
import { PHONE_CALL_TOOL, setPhoneCallService } from "../src/lib/tools/phone-call";
import { callBuiltinTool, getAvailableBuiltinTools, getBuiltinTool, setToolApprovalHandler } from "../src/lib/tools/registry";
import { defaultCallAvailable } from "../src/routines/checkin";

const ENV = {
  ELEVENLABS_API_KEY: "test-key",
  ELEVENLABS_AGENT_ID: "agent-1",
  ELEVENLABS_PHONE_NUMBER_ID: "number-1",
  USER_PHONE_NUMBER: "+49 151 0000000",
};
const OWNER = "4711";
const GROUP = "-1001234567890";
const WEB_ID = "0c1a2b3c-0000-4000-8000-000000000000";

const base = mkdtempSync(join(tmpdir(), "phone-tool-"));
let counter = 0;
let saved: Record<string, string | undefined> = {};
let approval: ChoiceToolApproval | null = null;
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

function fakePhone() {
  const calls: StartCallInput[] = [];
  return {
    calls,
    startCall: async (input: StartCallInput) => {
      calls.push(input);
      return { ok: true, message: "Ich rufe an." };
    },
  };
}

function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Echtes Tor; jede Frage wird mit answer entschieden, als hätte der Nutzer geklickt */
function gate(answer: string | null) {
  const asked: Choice[] = [];
  approval = createChoiceToolApproval({
    sendChoice: async choice => {
      asked.push(choice);
      if (answer) setTimeout(() => void decideChoice(choice.id, answer, "telegram"), 0);
      return { sent: true };
    },
    log: () => {},
  });
  setToolApprovalHandler(approval.handler);
  return asked;
}

beforeEach(() => {
  setChoicesFileForTests(join(base, `choices-${++counter}.json`));
  saved = Object.fromEntries(Object.keys(ENV).map(k => [k, process.env[k]]));
  setEnv(ENV);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  approval?.dispose();
  approval = null;
  setToolApprovalHandler(null);
  setPhoneCallService(null);
  setEnv(saved);
  logSpy.mockRestore();
  errSpy.mockRestore();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

const offered = () => getAvailableBuiltinTools().some(t => t.name === PHONE_CALL_TOOL);

describe("Werkzeug phone_call", () => {
  test("registriert, mit Freigabepflicht und optionalem Anlass", () => {
    const tool = getBuiltinTool(PHONE_CALL_TOOL)!;
    expect(tool.requiresApproval).toBe(true);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["reason"]);
    expect(tool.inputSchema.required ?? []).toEqual([]);
  });

  test("verfügbar nur mit Konfiguration und gesetztem Dienst (und Freigabetor)", () => {
    gate(TOOL_ALLOW);
    expect(offered()).toBe(false);
    setPhoneCallService(phoneAccess(fakePhone(), { env: ENV }));
    expect(offered()).toBe(true);
    setEnv({ USER_PHONE_NUMBER: undefined });
    expect(offered()).toBe(false);
    setEnv(ENV);
    setPhoneCallService(null);
    expect(offered()).toBe(false);
  });

  test("ruft erst nach Freigabe an, mit Anlass und dem Gespräch der Ausführung", async () => {
    const asked = gate(TOOL_ALLOW);
    const phone = fakePhone();
    setPhoneCallService(phoneAccess(phone, { env: ENV, userName: async () => "Alex" }));
    const topic = await runExecution(`topic:${GROUP}:7`, "general", () => callBuiltinTool(PHONE_CALL_TOOL, { reason: "Frist heute" }));
    expect(topic).toEqual({ isError: false, content: JSON.stringify({ success: true, message: "Ich rufe an." }) });
    const web = await runExecution(`web:${WEB_ID}`, "general", () => callBuiltinTool(PHONE_CALL_TOOL, {}));
    expect(web.isError).toBe(false);
    expect(asked.map(c => c.conversation)).toEqual([
      { type: "telegram", chatId: GROUP, topicId: 7 },
      { type: "web", conversationId: WEB_ID },
    ]);
    expect(phone.calls).toEqual([
      { reason: "Frist heute", conversation: { type: "telegram", chatId: GROUP, topicId: 7 }, userName: "Alex" },
      { reason: "", conversation: { type: "web", conversationId: WEB_ID }, userName: "Alex" },
    ]);
  });

  test("abgelehnt: kein Anruf, Fehler an das Modell", async () => {
    gate(TOOL_DENY);
    const phone = fakePhone();
    setPhoneCallService(phoneAccess(phone, { env: ENV }));
    const result = await runExecution(`dm:${OWNER}`, "general", () => callBuiltinTool(PHONE_CALL_TOOL, { reason: "x" }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("abgelehnt");
    expect(phone.calls).toEqual([]);
  });

  test("ohne erkennbares Gespräch: das Tor lehnt ab, kein Anruf, auch kein Direktchat-Rückfall", async () => {
    const asked = gate(TOOL_ALLOW);
    const phone = fakePhone();
    setPhoneCallService(phoneAccess(phone, { env: ENV }));
    const result = await runExecution("cli", "general", () => callBuiltinTool(PHONE_CALL_TOOL, { reason: "x" }));
    expect(result.isError).toBe(true);
    expect(asked).toEqual([]);
    // Auch der Handler selbst ruft ohne Gespräch nicht an
    const direct = JSON.parse(await getBuiltinTool(PHONE_CALL_TOOL)!.handler({ reason: "x" }));
    expect(direct.success).toBe(false);
    expect(phone.calls).toEqual([]);
  });
});

describe("Knopf „Anrufen“ unter Check-in und Briefing", () => {
  test("erscheint mit und fehlt ohne Anruf-Konfiguration (phoneConfigured)", async () => {
    const options = async (env: Record<string, string | undefined>) =>
      (
        await openProactiveChoice("checkin", "Frist heute", {
          env: { ...env, TELEGRAM_USER_ID: OWNER },
          callAvailable: await defaultCallAvailable(env),
          create: async input => ({ ...input, id: "c1" }) as unknown as Choice,
        })
      ).options.map(o => o.key);
    expect(await options(ENV)).toContain(PROACTIVE_OPTION.call.key);
    expect(await options({ ...ENV, ELEVENLABS_API_KEY: " " })).not.toContain(PROACTIVE_OPTION.call.key);
    expect(await options({})).not.toContain(PROACTIVE_OPTION.call.key);
  });
});

describe("Eine Instanz für /anruf, Werkzeug und Knopf", () => {
  test("alle drei Wege landen bei derselben Attrappe", async () => {
    gate(TOOL_ALLOW);
    const phone = fakePhone();
    const access = phoneAccess(phone, { env: ENV });
    setPhoneCallService(access);
    const services = { phone: access } as unknown as CommandServices;

    await runTelegramCommand({
      chat: { reply: async () => {} },
      chatId: OWNER,
      sessionKey: `dm:${OWNER}`,
      agent: "general",
      text: "/anruf Befehl",
      match: commandRegistry.match("/anruf Befehl", "telegram")!,
      services,
      working: () => () => {},
      resetSession: async () => ({ status: "unavailable" }),
      agentTurn: async () => undefined,
      boardMeeting: async () => {},
    });
    await runExecution(`dm:${OWNER}`, "general", () => callBuiltinTool(PHONE_CALL_TOOL, { reason: "Werkzeug" }));
    await proactiveCall(phone, { TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_USER_ID: OWNER })("Knopf");

    expect(phone.calls.map(c => c.reason)).toEqual(["Befehl", "Werkzeug", "Knopf"]);
  });
});
