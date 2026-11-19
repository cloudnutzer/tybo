#!/usr/bin/env -S bun --no-env-file
/** #625: echte Job-CLI, Wächter, Abholer und WebUI; Motoren und Nachrichtenspeicher als Attrappen. Kein Bot. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobReportRunner } from "../src/app/job-reports";
import { abortExecutions } from "../src/lib/execution-context";
import { runJobCli } from "../src/lib/jobs/cli";
import { createJobReturnQueue } from "../src/lib/jobs/return";
import { runWatcher } from "../src/lib/jobs/runner";
import { jobFile, readAllStatuses, readStatus } from "../src/lib/jobs/store";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import { createBotChat, type WebSavedMessage } from "../src/web/bot-turn";
import { createWebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import type { WebNoticeRow } from "../src/web/web-notices";
import { fakeChild, fakeDeps, tempRoot } from "../tests/jobs-fixture";

export const PROOF_REPORT = "Die Testzahl ist 42.";
export const PROOF_REPLY = "Ich habe den Job-Bericht geprüft: Die Testzahl ist 42. Der Auftrag ist abgeschlossen.";

/** Derselbe Nachweis dient dem Terminal-Durchlauf und den Browserbildern. */
export async function startJobReturnProof(password: string) {
  const { root, cleanup } = tempRoot("job-return-proof-");
  const store = new ConversationStore({ dir: join(root, "web") });
  await store.load();
  const conversation = await store.createConversation("general");
  await store.renameConversation(conversation.id, "Job-Bericht weiterverarbeiten");
  const notices: WebNoticeRow[] = [], saved: WebSavedMessage[] = [], log: string[] = [];
  let calls = 0;
  const chat = createBotChat({
    runStreamingTurn: async o => {
      calls++;
      assert(o.userMessage.startsWith("<job-bericht "));
      assert(o.userMessage.includes(PROOF_REPORT));
      assert.equal(o.chatId, `web:${conversation.id}`);
      assert.equal(o.jobChain, 1);
      assert(o.turnHint?.includes("Daten aus einem Hintergrund-Job"));
      return PROOF_REPLY;
    },
    saveMessage: async message => { saved.push(message); return true; },
    processIntents: async () => {}, abortEngineCalls: abortExecutions,
    isShuttingDown: () => false, scheduleRestartCheck() {},
  });
  const server = await createWebServer({ host: "127.0.0.1", port: 0, password, allowedHosts: [] }, {
    conversationStore: store, sessionFile: join(root, "sessions.json"), chat, log() {},
    webNotices: { page: async (ids, o) => notices.filter(n => ids.includes(n.chat_id) &&
      (!o.since || n.created_at >= o.since) && (!o.after || n.created_at > o.after.createdAt ||
      (n.created_at === o.after.createdAt && String(n.id) > o.after.id))).slice(0, o.limit) },
  });
  const outbox: OutboxDeps = { botToken: "", userId: "", groupId: null, outboxDir: join(root, "outbox"),
    newId: randomUUID, log() {}, fetch: async () => { throw new Error("Kein Telegram im Nachweis"); },
    record: async m => {
      notices.push({ ...m, id: String(notices.length + 1), created_at: m.created_at ?? new Date().toISOString(), metadata: m.metadata ?? null });
      return true;
    },
  };
  const deps = fakeDeps(root);
  deps.notify = input => sendAndRecord(input, outbox);
  let watching: Promise<number> = Promise.resolve(0);
  deps.spawnWatcher = (id, run) => { watching = runWatcher(id, deps, run); return { pid: process.pid }; };
  deps.spawnClaude = spec => fakeChild(deps.procs.spawn(60625), Promise.resolve({ code: 0, signal: null }), () => {
    const id = spec.env.TYBO_JOB_ID;
    // Der Bericht entsteht erst beim Freigeben des Motors, nicht beim Anlegen des Jobs.
    assert(id);
    writeFileSync(jobFile(root, id, "report"), PROOF_REPORT);
  });
  deps.claudeEnv = status => ({ HOME: root, TYBO_JOB_ID: status.id });
  const runner = createJobReportRunner({ root, secrets: () => [], userId: "web", groupId: null,
    web: () => server, telegramChat: chat, conversationGone: async () => false });

  async function run() {
    log.push('$ job start --title "Rückgabe-Nachweis" --text "Schreibe die Testzahl 42 in den Bericht." --zurueck');
    const exit = await runJobCli(["start", "--title", "Rückgabe-Nachweis", "--text", "Schreibe die Testzahl 42 in den Bericht.", "--zurueck"], {
      deps, outbox, callerEnv: { TYBO_CONVERSATION_ID: conversation.id }, cwd: root,
      defaultModel: "haiku", defaultEffort: () => undefined,
      out: () => {}, err: text => { throw new Error(text); },
    });
    assert.equal(exit, 0);
    assert.equal(await watching, 0);
    const status = (await readAllStatuses(root))[0];
    assert.equal(status.outcome, "success");
    assert.equal(status.notice?.state, "sent");
    assert.equal(status.returnDelivery?.state, "pending");
    assert.equal(calls, 0);
    assert.equal(notices.length, 1);
    log.push("Wächter: success, Abschlussmeldung sent, Rückgabe pending, noch kein Chat-Turn.");
    // Erst nach dem Abschluss einen Abholer erzeugen, wie nach einem Bot-Neustart.
    await createJobReturnQueue(deps, runner).poll();
    await createJobReturnQueue(deps, runner).poll();
    const messages = await store.getMessages(conversation.id);
    assert.equal(calls, 1);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].kind, "notice");
    assert(messages[0].text.includes(PROOF_REPORT));
    assert.equal(messages[1].text, PROOF_REPLY);
    assert(messages.every(m => m.role === "assistant"));
    assert.equal(saved.filter(m => m.metadata?.job_report).length, 1);
    assert.equal((await readStatus(root, status.id))?.returnDelivery?.state, "done");
    const reloaded = new ConversationStore({ dir: join(root, "web") }); await reloaded.load();
    assert.deepEqual(await reloaded.getMessages(conversation.id), messages);
    log.push("Abholer nach Neustart: genau ein Turn im Web-Gespräch, Kettenzähler 1, Herkunft gespeichert, Rückgabe done.");
    log.push("Web-Verlauf: zuerst Job-Bericht, danach tybos Antwort; keine Nutzerblase. Erneutes Abholen und Neuladen: unverändert.");
    return log;
  }
  return { server, conversationId: conversation.id, run, async stop() { await watching; await server.stop(); cleanup(); } };
}

if (import.meta.main) {
  const proof = await startJobReturnProof("isoliertes-testpasswort");
  try { for (const line of await proof.run()) console.log(line); }
  finally { await proof.stop(); }
}
