import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auxDisabled, callAux } from "../src/lib/aux-model";
import { AUX_PURPOSES, auxEnvName, LIMIT_AWARE_PURPOSES } from "../src/lib/aux-targets";
import * as claudeModule from "../src/lib/claude";
import { setClaudeAvailability } from "../src/lib/claude-availability";
import { setSwitchStateFileForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import type { SwitchBlock } from "../src/lib/engine-switch";
import { setSettingsPath, type Settings } from "../src/lib/settings";
import * as credit from "../src/lib/spend/credit";
import { detectThread } from "../src/lib/threads/detect";
import { resolveThreads } from "../src/lib/threads/resolve";
import { learnFromSource } from "../src/lib/learn";
import { createCoreChoices } from "../src/lib/memory/core-choices";
import * as core from "../src/lib/memory/core";
import { formatSwitchTime } from "../src/lib/engine-switch-text";

// Echte Auflösung und Zustandsablage; CLI, HTTP und Buchung sind Attrappen.
const envNames = [...AUX_PURPOSES.map(auxEnvName), "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "FALLBACK_OFFLINE_ONLY"];
const savedEnv = new Map<string, string | undefined>();
const realFetch = globalThis.fetch;
const backups: Settings["engine"] = { backups: [{ engine: "codex" }] };
let dir: string;
let settingsNo = 0;
let until: string;
let claude: ReturnType<typeof spyOn>;
let booking: ReturnType<typeof spyOn>;
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
let http: ReturnType<typeof mock>;

function settings(value: Settings = {}) {
  const path = join(dir, `settings-${++settingsNo}.json`);
  writeFileSync(path, JSON.stringify(value));
  setSettingsPath(path);
}

async function block(changes: Partial<SwitchBlock> = {}) {
  const value = { engine: "claude", cause: "limit", window: "weekly_all", since: new Date().toISOString(),
    until, resetKnown: true, ...changes } as SwitchBlock;
  await updateSwitchState(state => ({ ...state, blocks: [value] }));
}

beforeEach(async () => {
  for (const name of envNames) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  dir = mkdtempSync(join(tmpdir(), "tybo-aux-limit-"));
  settings({ engine: backups });
  setSwitchStateFileForTests(join(dir, "switch.json"));
  until = new Date(Date.now() + 3_600_000).toISOString();
  await block();
  claude = spyOn(claudeModule, "callClaude").mockResolvedValue({ text: "von Claude", isError: false });
  booking = spyOn(credit, "bookRunOutcome").mockResolvedValue(undefined);
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
  http = mock(async () => Response.json({ choices: [{ message: { content: "vom Ersatz" } }] }));
  globalThis.fetch = http as unknown as typeof fetch;
});

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = realFetch;
  for (const spy of [claude, booking, log, error]) spy.mockRestore();
  setSettingsPath();
  setSwitchStateFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe.each(LIMIT_AWARE_PURPOSES)("%s während der Sperre", purpose => {
  test.each([
    ["settings", "datei/modell"], ["env", "env/modell"], ["code", "minimax/minimax-m2.7"],
  ])("wirksames Ersatzmodell aus %s, auch mit quiet protokolliert", async (source, model) => {
    process.env.OPENROUTER_API_KEY = "test-nicht-echt";
    if (source !== "code") process.env.OPENROUTER_MODEL = "env/modell";
    settings({ engine: backups, ...(source === "settings" ? { fallback: { openrouterModel: model } } : {}) });
    expect(auxDisabled(purpose)).toBe(false);
    expect(await callAux(purpose, "private Eingabe", { quiet: true })).toEqual({ text: "vom Ersatz", isError: false });
    expect(claude).not.toHaveBeenCalled();
    expect(booking).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(init.body)).toMatchObject({ model, messages: [{ role: "user", content: "private Eingabe" }] });
    expect(log.mock.calls).toEqual([[`[AuxModel] ${purpose}: Claude Code gesperrt bis ${until}, Ersatz ${model}`]]);
    expect(error).not.toHaveBeenCalled();
  });

  test.each(["ohne Schlüssel", "offline in Einstellungen", "offline in Umgebung"])("%s: still abgeschaltet mit Ende", async mode => {
    if (mode !== "ohne Schlüssel") process.env.OPENROUTER_API_KEY = "test-nicht-echt";
    if (mode === "offline in Einstellungen") settings({ engine: backups, fallback: { offlineOnly: true } });
    if (mode === "offline in Umgebung") process.env.FALLBACK_OFFLINE_ONLY = "true";
    expect(auxDisabled(purpose)).toBe(true);
    expect(await callAux(purpose, "Frage")).toEqual({ text: "", isError: true, disabled: true, blockedUntil: until });
    expect(claude).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test("ohne Ersatzstufen bleibt eine alte Sperre wirkungslos", async () => {
    process.env.OPENROUTER_API_KEY = "test-nicht-echt";
    for (const engine of [undefined, { backups: [] }]) {
      settings({ engine });
      expect(auxDisabled(purpose)).toBe(false);
      expect(await callAux(purpose, "Frage")).toEqual({ text: "von Claude", isError: false });
    }
    expect(claude).toHaveBeenCalledTimes(2);
    expect(http).not.toHaveBeenCalled();
  });

  test.each(["openrouter", "ollama"] as const)("ausdrückliches %s-Ziel bleibt unverändert", async kind => {
    process.env.OPENROUTER_API_KEY = "test-nicht-echt";
    settings({ engine: backups, aux: { [purpose]: `${kind}:eigenes/modell` }, fallback: { offlineOnly: true } });
    expect(auxDisabled(purpose)).toBe(false);
    await callAux(purpose, "Frage");
    expect(claude).not.toHaveBeenCalled();
    expect(http).toHaveBeenCalledTimes(1);
    expect(JSON.parse(http.mock.calls[0][1].body).model).toBe("eigenes/modell");
    expect(log).not.toHaveBeenCalled();
  });
});

test.each(["call-summary", "checkin", "voice-training", "voice-wizard"] as const)("%s bleibt bei Claude", async purpose => {
  process.env.OPENROUTER_API_KEY = "test-nicht-echt";
  expect(auxDisabled(purpose)).toBe(false);
  await callAux(purpose, "Frage");
  expect(claude).toHaveBeenCalledTimes(1);
  expect(http).not.toHaveBeenCalled();
});

test("Resume ist mit Schlüssel gesperrt, nach Freigabe wieder über Claude", async () => {
  process.env.OPENROUTER_API_KEY = "test-nicht-echt";
  settings({ engine: backups, aux: { distill: "openrouter:anderes/modell" } });
  expect(auxDisabled("distill", true)).toBe(true);
  expect(await callAux("distill", "Frage", { resumeSessionId: "alte-session" }))
    .toEqual({ text: "", isError: true, disabled: true, blockedUntil: until });
  expect(http).not.toHaveBeenCalled();
  expect(claude).not.toHaveBeenCalled();
  await updateSwitchState(state => ({ ...state, blocks: [] }));
  expect(auxDisabled("distill", true)).toBe(false);
  await callAux("distill", "Frage", { resumeSessionId: "alte-session" });
  expect(claude).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: "alte-session", model: "claude-haiku-5-5" }));
});

test("Zustandsänderung und Ablauf wirken beim nächsten Aufruf ohne Neustart", async () => {
  expect(auxDisabled("judge")).toBe(true);
  await block({ until: new Date(Date.now() - 1_000).toISOString() });
  expect(auxDisabled("judge")).toBe(false);
  await callAux("judge", "Frage");
  expect(claude).toHaveBeenCalledTimes(1);
  await block();
  expect(auxDisabled("judge")).toBe(true);
  expect((await callAux("judge", "Frage")).blockedUntil).toBe(until);
  expect(claude).toHaveBeenCalledTimes(1);
  expect(http).not.toHaveBeenCalled();
});

test.each(["outage", "fremde Familie"])("%s lässt den Richter auf Opus weiterlaufen", async mode => {
  process.env.OPENROUTER_API_KEY = "test-nicht-echt";
  if (mode === "outage") await block({ cause: "outage" });
  else await block({ window: "weekly_scoped:fable" });
  expect(auxDisabled("judge")).toBe(false);
  await callAux("judge", "Frage");
  expect(claude).toHaveBeenCalledTimes(1);
  expect(http).not.toHaveBeenCalled();
});

test("fehlendes Claude geht der Sperre vor und behält disabled ohne blockedUntil", async () => {
  process.env.OPENROUTER_API_KEY = "test-nicht-echt";
  setClaudeAvailability({ state: "missing", reason: "nicht installiert" });
  expect(auxDisabled("judge")).toBe(true);
  expect(await callAux("judge", "Frage")).toEqual({ text: "", isError: true, disabled: true });
  expect(claude).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
});

test("Fehler des Ersatzmodells bleibt ein Fehler ohne disabled und ohne zweiten Versuch", async () => {
  process.env.OPENROUTER_API_KEY = "test-nicht-echt";
  http.mockImplementation(async () => new Response("", { status: 402 }));
  expect(await callAux("judge", "Frage")).toEqual({ text: "", isError: true });
  expect(http).toHaveBeenCalledTimes(1);
  expect(claude).not.toHaveBeenCalled();
});

test("Fäden: echte Aufrufer bleiben bei Sperre über mehrere Turns still", async () => {
  const conversation = { type: "web" as const, conversationId: "0f1e2d3c-4b5a-4c6d-8e7f-001122334455" };
  const calls = mock(callAux);
  const threadLog = mock(() => {});
  for (let turn = 0; turn < 3; turn++) {
    expect(await detectThread({ conversation, userText: "Hallo", reply: "Willst du nach Hamburg oder nach München fahren?", turnStartedAt: 0 }, {
      callAux: calls, listChoices: async () => [], pendingAskUser: async () => [], env: {}, log: threadLog,
      timeZone: () => "Europe/Berlin",
    })).toEqual({ status: "disabled" });
    expect(await resolveThreads({ conversation, userText: "München", reply: "Gut." }, {
      callAux: calls,
      listOpenThreads: async () => [{ id: "f1", nr: 1, topic: "Reise", question: "Hamburg oder München?", context: "", createdAt: new Date().toISOString() }] as never,
      env: {}, log: threadLog,
    })).toEqual({ status: "disabled" });
    expect(calls).toHaveBeenCalledTimes((turn + 1) * 2);
  }
  expect(threadLog).not.toHaveBeenCalled();
  expect(claude).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

test("/learn nennt die Sperre und schreibt nichts, ohne Fehlerzeile oder erneuten Aufruf", async () => {
  const write = mock(() => {});
  const result = await learnFromSource("Ein ausreichend langer eingefügter Text über den Garten und die Pflege der Pflanzen im kommenden Frühjahr.", write);
  expect(result.ok).toBe(false);
  expect(result.message).toContain(`Claude Code ist bis ${formatSwitchTime(until, process.env.USER_TIMEZONE || "UTC")} am Limit`);
  expect(result.message).toContain("nach dem Reset /learn erneut senden");
  expect(write).not.toHaveBeenCalled();
  expect(claude).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

test("/kern liefert die Sperrzeit ohne Entwurf, Rückfrage, Fehlerzeile oder Wiederholung", async () => {
  const read = spyOn(core, "readCore").mockResolvedValue({ ok: true, text: "Bisheriger Kern" });
  const calls = mock(callAux);
  const send = mock(async () => ({ sent: true }));
  const notify = mock(async () => {});
  const create = mock(async () => { throw new Error("Keine Rückfrage erwartet"); });
  const choices = createCoreChoices({
    facts: async () => [{ type: "fact", content: "Alex pflegt einen Garten" }],
    callAux: calls, sendChoice: send, notify, createChoice: create,
  });
  try {
    expect(await choices.offerDraft({ type: "telegram", chatId: "123" })).toEqual({ blockedUntil: until });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(claude).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
});
