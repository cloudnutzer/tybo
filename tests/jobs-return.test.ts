/** Rückgabe je Lauf, Absturzgrenze und Konkurrenz ohne Bot oder echten Motor. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { RestartPendingError } from "../src/lib/execution-context";
import { createJobReturnQueue, type RunJobReport } from "../src/lib/jobs/return";
import { claimOutcome, nextRun, readStatus, updateStatus, writeStatus, type JobStatus } from "../src/lib/jobs/store";
import { fakeDeps, tempRoot, type FakeDeps } from "./jobs-fixture";

let root: string, cleanup: () => void, deps: FakeDeps;
const id = "20261118-120000-000625";
beforeEach(() => { ({ root, cleanup } = tempRoot("jobs-return-")); deps = fakeDeps(root); });
afterEach(() => cleanup());
async function prepare(over: Partial<JobStatus> = {}) {
  const status: JobStatus = { version: 1, id, title: "Bericht", createdAt: new Date().toISOString(),
    phase: "ended", outcome: "success", run: 1, maxHours: 1, fullAccess: false,
    returnToChat: true, jobChain: 1, target: { chatId: "-100200", topicId: 443 },
    notice: { state: "sent", attempts: 1 }, returnDelivery: { run: 1, state: "pending" }, ...over };
  await writeStatus(root, status);
  return status;
}
const delivery = async () => (await readStatus(root, id))?.returnDelivery;

test("Neustart zwischen Ablage und Abholung, konkurrierende Abholer: genau ein Turn", async () => {
  await prepare();
  let calls = 0;
  const run: RunJobReport = async (s, claim) => {
    if (await claim()) { calls++; expect(s.target).toEqual({ chatId: "-100200", topicId: 443 }); }
    return "done";
  };
  const first = createJobReturnQueue(deps, run);
  const restarted = createJobReturnQueue(fakeDeps(root), run);
  await Promise.all([first.poll(), first.poll(), restarted.poll()]);
  expect(calls).toBe(1);
  expect(await delivery()).toMatchObject({ run: 1, state: "done" });
  await createJobReturnQueue(fakeDeps(root), run).poll();
  expect(calls).toBe(1);
});

test.each(["pending", "sending", "sent", "failed"] as const)("Abschlussmeldung %s bestimmt Fälligkeit", async state => {
  await prepare({ notice: { state, attempts: 1 } });
  let calls = 0;
  await createJobReturnQueue(deps, async (_, claim) => { if (await claim()) calls++; return "done"; }).poll();
  expect(calls).toBe(state === "sent" || state === "failed" ? 1 : 0);
});

test.each(["failed", "no_report", "timeout", "stopped", "aborted", "start_failed", "unanswered", "question_limit", "question_failed"] as const)("kein Turn bei %s", async outcome => {
  await prepare({ outcome });
  let calls = 0;
  await createJobReturnQueue(deps, async () => { calls++; return "done"; }).poll();
  expect(calls).toBe(0);
});

test("ohne --zurueck, laufend oder waiting: kein Turn", async () => {
  let calls = 0;
  const queue = createJobReturnQueue(deps, async () => { calls++; return "done"; });
  for (const over of [{ returnToChat: undefined }, { phase: "running" as const }, { phase: "starting" as const },
    { phase: "waiting" as const, waiting: { number: 1, question: { question: "Wie?", options: [] }, askedAt: new Date().toISOString(), deadlineAt: new Date().toISOString(), delivery: { state: "sent" as const, attempts: 1 } } }]) {
    await prepare(over); await queue.poll();
  }
  expect(calls).toBe(0);
});

test("claimOutcome legt Rückgabe auch für recoverJobs an; Fortsetzen verwirft nur den alten Laufzustand", async () => {
  await prepare({ phase: "running", outcome: undefined, returnDelivery: undefined });
  await claimOutcome(root, id, "aborted", { pid: process.pid, identity: deps.proc.identity(process.pid) });
  expect(await delivery()).toMatchObject({ run: 1, state: "discarded" });
  await updateStatus(root, id, s => { nextRun(s, new Date()); return s; });
  expect(await readStatus(root, id)).toMatchObject({ returnToChat: true, jobChain: 1, run: 2 });
  expect(await delivery()).toBeUndefined();
  await claimOutcome(root, id, "success", { pid: process.pid, identity: deps.proc.identity(process.pid) });
  expect(await delivery()).toEqual({ run: 2, state: "pending" });
});

test("claimed wird vor der Arbeit gespeichert; lebender Besitzer wird nie wiederholt", async () => {
  await prepare();
  let finish!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(r => entered = r);
  const work = new Promise<void>(r => finish = r);
  const queue = createJobReturnQueue(deps, async (_, claim) => {
    expect(await claim()).toBe(true);
    expect(await delivery()).toMatchObject({ state: "claimed" });
    entered(); await work; return "done";
  });
  const first = queue.poll();
  await enteredPromise;
  await createJobReturnQueue(deps, async () => { throw new Error("Doppelter Turn"); }).poll();
  expect(deps.sent).toHaveLength(0);
  finish(); await first;
  expect(await delivery()).toMatchObject({ state: "done" });
});

test("Absturz mitten im Turn: einmaliger Hinweis, niemals zweiter Modelllauf", async () => {
  await prepare({ returnDelivery: { run: 1, state: "claimed", owner: { pid: 99999, identity: "alter Bot", token: "alt" } } });
  let calls = 0;
  const run: RunJobReport = async () => { calls++; return "done"; };
  await Promise.all([createJobReturnQueue(deps, run).poll(), createJobReturnQueue(deps, run).poll()]);
  await createJobReturnQueue(deps, run).poll();
  expect(calls).toBe(0);
  expect(deps.sent).toHaveLength(1);
  expect(deps.sent[0].text).toContain("unterbrochen");
  expect(await delivery()).toMatchObject({ state: "discarded" });
});

test("busy und angeforderter Neustart bleiben offen, danach einmal verarbeitet", async () => {
  await prepare();
  await createJobReturnQueue(deps, async () => "retry").poll();
  expect(await delivery()).toMatchObject({ state: "pending" });
  await createJobReturnQueue(deps, async () => { throw new RestartPendingError(); }).poll();
  expect(await delivery()).toMatchObject({ state: "pending" });
  await createJobReturnQueue(deps, async (_, claim) => { await claim(); return "done"; }).poll();
  expect(await delivery()).toMatchObject({ state: "done" });
});

test("gelöschtes Ziel wird verworfen, Abbruch nach Übernahme gilt als erledigt", async () => {
  await prepare();
  await createJobReturnQueue(deps, async () => "gone").poll();
  expect(await delivery()).toMatchObject({ state: "discarded" });
  expect(deps.logs.join(" ")).toContain("verworfen");
  await prepare();
  await createJobReturnQueue(deps, async (_, claim) => { await claim(); throw new Error("Abbruch"); }).poll();
  expect(await delivery()).toMatchObject({ state: "done" });
});
