#!/usr/bin/env -S bun --no-env-file
/** Zwei echte Claude-Turns für #624, isoliert und ohne Bot oder Telegram. */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

if (process.argv.slice(2).join(" ") !== "--real") {
  console.error("Aufruf: bun --no-env-file scripts/job-question-proof.ts --real (zwei echte Claude-Turns)");
  process.exit(2);
}
const claude = Bun.which("claude");
assert(claude, "Claude CLI fehlt");
const root = await realpath(await mkdtemp(join(tmpdir(), "job-question-proof-")));
const messages: { content: string; metadata: { choiceId?: string } }[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/rest/v1/messages") return new Response(null, { status: 404 });
    const body = await request.json();
    messages.push(...(Array.isArray(body) ? body : [body]));
    await writeFile(join(root, "messages.json"), JSON.stringify(messages, null, 2));
    return new Response(null, { status: 201 });
  },
});
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const wrapper = join(root, "claude-proof");
const invocations = join(root, "invocations.txt");
await writeFile(wrapper, `#!/bin/sh
case " $* " in
  *' --resume '*) printf 'resume\n' >> ${quote(invocations)} ;;
  *) printf 'new\n' >> ${quote(invocations)} ;;
esac
exec ${quote(claude)} --strict-mcp-config --setting-sources '' --settings '{"disableAllHooks":true}' --tools Read,Write "$@"
`);
await chmod(wrapper, 0o700);
const env: Record<string, string> = {
  HOME: homedir(), PATH: process.env.PATH ?? "", TYBO_ROOT: root, GO_PROJECT_ROOT: root,
  CLAUDE_PATH: wrapper, CLAUDE_AUTH: "subscription", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  SUPABASE_URL: `http://127.0.0.1:${server.port}`, SUPABASE_SERVICE_ROLE_KEY: "local-proof-only",
};
for (const key of ["USER", "LOGNAME", "SHELL", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key]!;
process.env = env;
process.chdir(root);
const { createJobDeps } = await import("../src/lib/jobs/default-deps");
const { startJob } = await import("../src/lib/jobs/runner");
const { recoverJobs, formatJobList } = await import("../src/lib/jobs/control");
const { jobChoiceHandler } = await import("../src/lib/jobs/choices");
const { readStatus, readAllStatuses, jobDir, jobFile } = await import("../src/lib/jobs/store");
const { checkProcess, processGone, terminateGroup } = await import("../src/lib/jobs/process");
const { listChoices, decideChoice, onChoiceDecided, useChoicesFileIn } = await import("../src/lib/choices");
const deps = createJobDeps({ root, env });
useChoicesFileIn(root);
const off = onChoiceDecided("job", jobChoiceHandler(deps));
async function until(label: string, check: () => Promise<boolean>, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Zeitlimit: ${label}; Testdaten: ${root}`);
}
try {
  const marker = `BELEG_${randomBytes(5).toString("hex")}`;
  console.log("$ startJob: Claude haiku, acceptEdits, ohne Befehlsrechte, temporärer Projektordner");
  const start = await startJob({ title: "Rückfragenachweis", target: {}, maxHours: 0.05, model: "haiku", fullAccess: false,
    brief: `Frag mich, ob A oder B, und schreib die Antwort in den Bericht. Merke dir zusätzlich ${marker} in der Session.
Im ersten Turn schreibe ausschließlich die Frage nach den Rückfrage-Regeln als frage.json mit den Optionen genau A und B und beende den Turn ohne Bericht.
Wenn die Antwort des Nutzers kommt, schreibe sofort report.md mit ANTWORT_OK, der gewählten Antwort und dem gemerkten Belegwort. Stelle keine weitere Frage.`,
  }, deps);
  assert(start.ok, start.ok ? "" : start.error);
  const id = start.id;
  await until("Frage zugestellt und Wächter beendet", async () => {
    const s = await readStatus(root, id);
    assert(s?.phase !== "ended", `Job endete vor der Frage (${s?.outcome}); Testdaten: ${root}`);
    return s?.phase === "waiting" && s.waiting?.delivery.state === "sent" && processGone(s.watcher, deps.proc);
  });
  const first = (await readStatus(root, id))!;
  let choices = (await listChoices()).filter(c => c.ref === id);
  assert.equal(choices.length, 1);
  assert.deepEqual(choices[0].options.map(o => o.label), ["A", "B"]);
  assert.equal(messages.length, 1);
  assert(messages[0].metadata.choiceId);
  assert((await formatJobList(deps)).includes("wartet auf dich"));
  console.log("Lauf 1: waiting, Frage 1, genau eine Auswahl A/B, Frist gespeichert, kein Abschluss, Wächter beendet.");
  await recoverJobs(deps);
  assert.equal(messages.length, 1);
  assert.equal((await readStatus(root, id))?.phase, "waiting");
  console.log("recoverJobs: wartet weiter, gleiche Auswahl, kein erneuter Versand.");
  console.log("$ decideChoice: Antwort B über Kanal web, echter Job-Handler im Nachweis-Skript");
  const decision = await decideChoice(choices[0].id, "a2", "web");
  assert.equal(decision.status, "decided");
  if (decision.status === "decided") assert.equal(decision.choice.handlerError, undefined);
  await until("Bericht zugestellt", async () => {
    const s = await readStatus(root, id);
    return s?.run === 2 && s.phase === "ended" && ["sent", "failed"].includes(s.notice?.state ?? "");
  });
  const done = (await readStatus(root, id))!;
  assert.equal(done.outcome, "success");
  assert.equal(done.notice?.state, "sent");
  assert.equal(done.sessionId, first.sessionId);
  assert.equal(done.questionCount, 1);
  assert.equal(done.answer?.text, "B");
  assert.deepEqual((await readFile(invocations, "utf8")).trim().split("\n"), ["new", "resume"]);
  const report = await readFile(jobFile(root, id, "report"), "utf8");
  assert(report.includes("ANTWORT_OK") && /\bB\b/.test(report) && report.includes(marker));
  assert(await Bun.file(join(jobDir(root, id), "fragen", "1.json")).exists());
  assert.equal(await Bun.file(jobFile(root, id, "question")).exists(), false);
  assert.equal(messages.filter(m => m.content.includes("**Job fertig")).length, 1);
  assert.equal(messages.filter(m => m.metadata.choiceId).length, 1);
  assert(!JSON.stringify(messages).includes(first.sessionId!));
  console.log("Lauf 2: --resume, gleiche Session, success, Bericht ANTWORT_OK mit Antwort B und Belegwort, Meldung sent.");
  console.log("Nachweis: eine Frage, eine Antwortbestätigung, eine Abschlussmeldung; Frage archiviert; keine Session-ID in Meldungen.");
  console.log(`Testdaten: ${root}`);
} finally {
  off();
  for (const s of await readAllStatuses(root)) {
    if (s.watcher && checkProcess(s.watcher, deps.proc) === "same") process.kill(s.watcher.pid, "SIGKILL");
    if (s.claude) await terminateGroup(s.claude, deps.proc);
  }
  server.stop(true);
}
