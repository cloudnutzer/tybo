/** Job-Knöpfe über das echte Register, mit Attrappen für Prozesse und Outbox. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachChoiceTelegram, decideChoice, getChoice, listChoices, onChoiceDecided, setChoicesFileForTests } from "../src/lib/choices";
import { claudeProjectDir } from "../src/lib/engines/claude-notes";
import { expireJobChoices, jobChoiceHandler, jobChoiceStaleText, offerJobResume } from "../src/lib/jobs/choices";
import { recoverJobs } from "../src/lib/jobs/control";
import { createJobDeps } from "../src/lib/jobs/default-deps";
import { deliverNotice } from "../src/lib/jobs/notice";
import { resumeJob } from "../src/lib/jobs/resume";
import { runWatcher } from "../src/lib/jobs/runner";
import { jobFile, readStatus, writeStatus, type JobStatus } from "../src/lib/jobs/store";
import type { SendAndRecordInput } from "../src/lib/outbox";
import { createTelegramChoices } from "../src/lib/telegram-choices";
import { createChoicePort, type ChoiceChange } from "../src/web/choices";
import { register } from "./choices-fixture";
import { fakeChild, fakeDeps, tempRoot, type FakeDeps } from "./jobs-fixture";

const id = "20261118-140000-000623";
const sessionId = "12345678-1234-4234-8234-123456789abc";
const web = "0b8f2a3c-1d2e-4f50-8a6b-7c8d9e0f1a2b";
const target = { userId: "4711", groupId: "-100200", telegram: true };
let root: string, cleanup: () => void, deps: FakeDeps, unregister: (() => void) | undefined;
beforeEach(() => {
  ({ root, cleanup } = tempRoot("jobs-choices-"));
  setChoicesFileForTests(join(root, "data", "choices.json"));
  deps = fakeDeps(root);
  deps.claudeEnv = () => ({ HOME: root });
  deps.offerResume = status => offerJobResume(status, deps, target);
  deps.expireResumeChoices = expireJobChoices;
  unregister = onChoiceDecided("job", jobChoiceHandler(deps));
});
afterEach(() => { unregister?.(); setChoicesFileForTests(null); cleanup(); });
async function prepare(over: Partial<JobStatus> = {}) {
  const status: JobStatus = { version: 1, id, title: "Job für Test", createdAt: "2026-11-17T00:00:00Z", run: 1,
    phase: "ended", outcome: "aborted", maxHours: 1, engine: "claude", model: "claude-test", fullAccess: false,
    sessionId, startedAt: "2026-11-17T00:00:01Z", claude: { pid: 60001, identity: "start-60001" },
    watcher: { pid: 60002, identity: "start-60002" }, termination: { state: "done", result: "gone" },
    notice: { state: "sent", attempts: 1 }, target: { chatId: "-100200", topicId: 443 }, ...over };
  await writeStatus(root, status);
  await Bun.write(jobFile(root, id, "brief"), "Testauftrag");
  await Bun.write(jobFile(root, id, "log"), "Log ohne Geheimnisse");
  mkdirSync(claudeProjectDir(root, root), { recursive: true });
  writeFileSync(join(claudeProjectDir(root, root), `${sessionId}.jsonl`), "{}\n");
  return status;
}
function waitingWatcher() {
  let starts = 0;
  deps.startConfirmMs = 0;
  deps.spawnWatcher = () => { starts++; return { pid: deps.procs.spawn(60003) }; };
  return () => starts;
}
async function question() {
  const choices = (await listChoices()).filter(c => c.kind === "job");
  expect(choices).toHaveLength(1);
  return choices[0];
}

test("Abbruch: Markdown-Meldung bleibt, eigene Frage hat Fortsetzen-Knopf und gespeichertes Ziel", async () => {
  await prepare({ phase: "running", outcome: undefined, termination: undefined, notice: undefined });
  deps.procs.spawn(60001);
  expect((await recoverJobs(deps)).aborted).toEqual([id]);
  expect(deps.sent).toHaveLength(2);
  expect(deps.sent[0]).toMatchObject({ text: expect.stringContaining("**Job abgebrochen"), topicId: 443 });
  expect(deps.sent[0]).not.toHaveProperty("buttons");
  const choice = await question();
  expect(choice).toMatchObject({ kind: "job", ref: id, action: "resume-1", conversation: { type: "telegram", chatId: "-100200", topicId: 443 }, options: [{ key: "resume", label: "Fortsetzen" }] });
  expect(deps.sent[1]).toMatchObject({ source: "job", format: "plain", choiceId: choice.id, buttons: [[{ text: "Fortsetzen", callback_data: `ch|${choice.id}|resume` }]] });
  expect(choice.text).toContain("\nLauf 2");
  expect(choice.text).not.toContain("Log ohne Geheimnisse");
  await recoverJobs(deps);
  await deps.offerResume!((await readStatus(root, id))!);
  expect(deps.sent).toHaveLength(2);
});

test("Zeitüberschreitung im Wächter bietet denselben Knopf nach beendeter Prozessgruppe", async () => {
  await prepare({ phase: "starting", outcome: undefined, watcher: undefined, claude: undefined, startedAt: undefined, notice: undefined, termination: undefined });
  let end!: (exit: { code: number | null; signal: string | null }) => void;
  deps.spawnClaude = () => fakeChild(deps.procs.spawn(60001), new Promise(resolve => { end = resolve; }));
  const signal = deps.procs.signalGroup.bind(deps.procs);
  deps.procs.signalGroup = (pid, sig) => { const result = signal(pid, sig); end({ code: null, signal: sig }); return result; };
  deps.timeoutMsFor = () => 5;
  expect(await runWatcher(id, deps, 1)).toBe(0);
  expect(await readStatus(root, id)).toMatchObject({ outcome: "timeout", termination: { state: "done", result: "gone" }, notice: { state: "sent" } });
  expect(deps.sent).toHaveLength(2);
  expect(deps.sent[0].text).toContain("Zeit überschritten");
  expect((await question()).options[0].label).toBe("Fortsetzen");
});

test.each([
  { outcome: "stopped" }, { engine: "codex" }, { workDir: "/entwurf" }, { sessionId: undefined },
  { claude: undefined, startedAt: undefined }, { termination: { state: "done", result: "survived" } },
  { notice: { state: "sending", attempts: 1 } },
] as Partial<JobStatus>[])("kein Knopf für %j", async over => {
  const status = await prepare(over);
  await deps.offerResume!(status);
  expect(await listChoices()).toEqual([]);
  expect(deps.sent).toEqual([]);
});

test("Frage maskiert Titel einschließlich Markdown-Geheimnissen und Session-ID vor dem Speichern", async () => {
  deps.secrets = () => ["geheimwert"];
  const status = await prepare({ title: `geheim**wert** ${sessionId}` });
  await deps.offerResume!(status);
  const choice = await question();
  expect(choice.text).toContain("[verborgen]");
  const stored = readFileSync(join(root, "data", "choices.json"), "utf8");
  expect(stored).not.toContain("geheim");
  expect(stored).not.toContain(sessionId);
});

test("Fehler beim Frageversand wiederholt die Abschlussmeldung nicht und lässt die Frage ablaufen", async () => {
  await prepare({ phase: "running", outcome: undefined, termination: undefined, notice: undefined });
  const notify = deps.notify;
  let questions = 0;
  deps.notify = input => {
    if (input.choiceId) { questions++; throw new Error("nicht zustellbar"); }
    return notify(input);
  };
  await recoverJobs(deps);
  const status = (await readStatus(root, id))!;
  expect(status.notice?.state).toBe("sent");
  expect((await question()).state).toBe("expired");
  await deliverNotice(id, status.notice!.owner!.token, deps);
  expect(deps.sent).toHaveLength(1);
  expect(questions).toBe(1);
});

test.each([true, false])("reines Web-Gespräch über Outbox, auch im Wächter; Telegram eingerichtet=%s", async telegram => {
  const real = createJobDeps({ root, env: { HOME: root, CLAUDE_AUTH: "subscription", ...(telegram ? { TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_USER_ID: "4711" } : {}) } });
  const requests: SendAndRecordInput[] = [];
  real.notify = async input => { requests.push(input); return { sent: false, recorded: true }; };
  // Die Produktions-Abhängigkeit muss selbst den richtigen Register-Pfad wählen.
  setChoicesFileForTests(join(root, "falsche-choices.json"));
  const status = await prepare({ target: { chatId: `web:${web}` } });
  await real.offerResume!(status);
  expect(requests).toHaveLength(1);
  const choice = await question();
  expect(choice.conversation).toEqual({ type: "web", conversationId: web });
  expect(requests[0]).toMatchObject({ chatId: `web:${web}`, format: "plain", source: "job", choiceId: choice.id });
  expect(requests[0]).not.toHaveProperty("buttons");
  expect(choice.state).toBe("open");
});

test.each([{ target: {}, chatId: "4711" }, { target: { topicId: 443 }, chatId: "-100200" }])("Ziel ohne chatId: %j", async given => {
  await deps.offerResume!(await prepare({ target: given.target }));
  expect((await question()).conversation).toMatchObject({ type: "telegram", chatId: given.chatId });
});

test("Art job in der Web-Schnittstelle, nur eigenes Gespräch, konkurrierender Klick startet einmal", async () => {
  const port = createChoicePort({ register, userId: "4711", groupId: () => "-100200", every: () => () => {}, log: () => {} });
  const changes: ChoiceChange[] = [];
  const stop = port.subscribe(c => changes.push(c));
  try {
    await deps.offerResume!(await prepare());
    const choice = await question();
    expect(changes.some(c => c.created && c.kind === "job")).toBe(true);
    expect(await port.pending!("topic-443", "job")).toHaveLength(1);
    expect(await port.decide("dm", choice.id, "resume", "web")).toEqual({ status: "not_found" });
    const starts = waitingWatcher();
    const results = await Promise.all([port.decide("topic-443", choice.id, "resume", "web"), decideChoice(choice.id, "resume", "telegram")]);
    expect(results.filter(r => r.status === "decided")).toHaveLength(1);
    expect(starts()).toBe(1);
    expect((await getChoice(choice.id))?.handlerError).toBeUndefined();
    expect((await port.view(choice.id, "topic-443")).state).toBe("done");
    expect(deps.sent.at(-1)?.text).toContain("Lauf 2 startet");
  } finally { stop(); }
});

test("CLI-Fortsetzen lässt offene Frage ablaufen, ein verspäteter Handler sagt läuft schon", async () => {
  await deps.offerResume!(await prepare());
  const choice = await question();
  const starts = waitingWatcher();
  expect((await resumeJob(id, deps)).ok).toBe(true);
  expect((await getChoice(choice.id))?.state).toBe("expired");
  await jobChoiceHandler(deps)({ ...choice, state: "done", result: { key: "resume", label: "Fortsetzen", via: "telegram", at: Date.now() } });
  expect(starts()).toBe(1);
  expect(deps.sent.at(-1)?.text).toContain("läuft schon");
});

test("echter Klick auf einen per CLI abgelaufenen Knopf meldet läuft schon, in Web und Telegram", async () => {
  await deps.offerResume!(await prepare());
  const choice = await question();
  await attachChoiceTelegram(choice.id, [{ chatId: "-100200", messageId: 42 }]);
  const starts = waitingWatcher();
  expect((await resumeJob(id, deps)).ok).toBe(true);
  const staleText = (c: { kind?: string; ref?: string }) => jobChoiceStaleText(root, c);
  const port = createChoicePort({ register, staleText, userId: "4711", groupId: () => "-100200", log: () => {} });
  expect(await port.decide("topic-443", choice.id, "resume", "web")).toMatchObject({ status: "expired", message: `Job ${id} läuft schon.` });
  const answers: string[] = [];
  const telegram = createTelegramChoices({ owner: "4711", staleText, api: { editMessageReplyMarkup: async () => true } as any });
  await telegram.middleware({
    from: { id: 4711 }, callbackQuery: { data: `ch|${choice.id}|resume`, message: { chat: { id: -100200 }, message_id: 42 } },
    answerCallbackQuery: async ({ text }: { text: string }) => { answers.push(text); },
  } as any, async () => {});
  expect(answers).toEqual([`Job ${id} läuft schon.`]);
  expect(starts()).toBe(1);
  await prepare({ run: 2 });
  expect(await jobChoiceStaleText(root, choice)).toBeUndefined();
});

test("alter Knopf darf auch nach erneutem Abbruch keinen späteren Lauf starten", async () => {
  await deps.offerResume!(await prepare());
  const choice = await question();
  await prepare({ run: 2 });
  const starts = waitingWatcher();
  await decideChoice(choice.id, "resume", "web");
  expect(starts()).toBe(0);
  expect(deps.sent.at(-1)?.text).toContain("älteren Lauf");
});
