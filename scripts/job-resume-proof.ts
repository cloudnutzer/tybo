#!/usr/bin/env -S bun --no-env-file
/**
 * Echter Absturz-Nachweis zu #623, ohne Bot und ohne Telegram.
 * Aufruf: bun --no-env-file scripts/job-resume-proof.ts --real
 * Verbraucht zwei kurze Claude-Turns (bestehende CLI-Anmeldung erforderlich).
 * Eigener temporärer Projektordner, lokale Nachrichtenannahme statt Supabase,
 * keine persönlichen Hooks/MCP-Server. Nur der eigene Testwächter wird getötet.
 * Der Vordergrund wartet auf Wiederherstellung, Fortsetzung und Bericht.
 */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.argv.slice(2).join(" ") !== "--real") {
  console.error("Aufruf: bun --no-env-file scripts/job-resume-proof.ts --real (echte Claude-Turns)");
  process.exit(2);
}
const repo = resolve(import.meta.dir, "..");
const claude = Bun.which("claude");
assert(claude, "Claude CLI fehlt");
const root = await realpath(await mkdtemp(join(tmpdir(), "job-resume-proof-")));
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
await writeFile(wrapper, `#!/bin/sh\nexec ${quote(claude)} --strict-mcp-config --setting-sources '' --settings '{"disableAllHooks":true}' --tools Read,Write,Bash "$@"\n`);
await chmod(wrapper, 0o700);
const env: Record<string, string> = {
  HOME: homedir(), PATH: process.env.PATH ?? "", TYBO_ROOT: root, GO_PROJECT_ROOT: root,
  CLAUDE_PATH: wrapper, CLAUDE_AUTH: "subscription", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  SUPABASE_URL: `http://127.0.0.1:${server.port}`, SUPABASE_SERVICE_ROLE_KEY: "local-proof-only",
};
// Die CLI findet die Anmeldung im macOS-Schlüsselbund über den Benutzernamen.
for (const key of ["USER", "LOGNAME", "SHELL", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key]!;
// Alle dynamisch geladenen Module und Kinder sehen ausschließlich den Testordner.
process.env = env;
process.chdir(root);
const { createJobDeps } = await import("../src/lib/jobs/default-deps");
const { recoverJobs } = await import("../src/lib/jobs/control");
const { readStatus, readAllStatuses, jobFile } = await import("../src/lib/jobs/store");
const { checkProcess, processGone, terminateGroup } = await import("../src/lib/jobs/process");
const { jobSessionPresent } = await import("../src/lib/jobs/session");
const deps = createJobDeps({ root, env });
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function until(label: string, check: () => Promise<boolean>, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(200);
  }
  throw new Error(`Zeitlimit: ${label}`);
}
async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "--no-env-file", "--cwd", repo, "job", ...args], {
    cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (out.trim()) console.log(out.trim());
  assert.equal(code, 0, `CLI fehlgeschlagen: ${err}`);
  return out;
}
let id: string | undefined;
try {
  const marker = `BELEG_${randomBytes(5).toString("hex")}`;
  const brief = join(root, "auftrag.md");
  await writeFile(brief, `Kleiner Test der Session-Fortsetzung. Merke dir ${marker} im Gespräch.
Beim ersten Turn: Schreibe mit Write genau BEREIT nach bereit.txt. Führe danach mit Bash sleep 45 im Vordergrund aus; timeout 60000. Schreibe bis dahin keinen Bericht.
Wenn eine spätere Nachricht sagt, dass du unterbrochen wurdest: Warte nicht erneut und wiederhole keinen Befehl. Schreibe sofort den angeforderten Bericht mit FORTSETZUNG_OK und dem gemerkten Belegwort. Führe keine anderen Arbeiten aus.`);
  console.log("$ bun run job start --title Fortsetzungsnachweis --brief <Testauftrag> --model haiku --full-access --max-hours 0.05");
  const out = await cli(["start", "--title", "Fortsetzungsnachweis", "--brief", brief, "--model", "haiku", "--full-access", "--max-hours", "0.05"]);
  id = out.match(/Job (\d{8}-\d{6}-[0-9a-f]+)/)?.[1];
  assert(id, "Job-ID fehlt");
  const jobId = id;
  await until("Claude bereit mit gespeicherter Session", async () => {
    const status = await readStatus(root, jobId);
    assert(status?.phase !== "ended", `Claude endete vor dem Abbruch (${status?.outcome}); Testdaten: ${root}`);
    return Boolean(status?.startedAt && await Bun.file(join(root, "bereit.txt")).exists() && await jobSessionPresent(root, status, deps.claudeEnv(status)));
  });
  const first = (await readStatus(root, id))!;
  assert.equal(first.phase, "running");
  assert(first.watcher && checkProcess(first.watcher, deps.proc) === "same");
  process.kill(first.watcher.pid, "SIGKILL");
  await until("eigener Wächter beendet", async () => processGone(first.watcher, deps.proc), 10_000);
  console.log("Eigener Testwächter mit SIGKILL beendet; Session-Datei vorhanden.");
  console.log("$ recoverJobs(createJobDeps({ root: Testordner, env: isolierteUmgebung }))");
  assert.deepEqual((await recoverJobs(deps)).aborted, [id]);
  const aborted = (await readStatus(root, id))!;
  assert.equal(aborted.outcome, "aborted");
  assert.equal(aborted.termination?.result, "gone");
  assert.equal(aborted.notice?.state, "sent");
  console.log("Lauf 1: aborted, Prozessgruppe gone, Meldung sent; Fortsetzen-Frage festgehalten.");
  console.log(`$ bun run job resume ${id}`);
  await cli(["resume", id]);
  await until("Lauf 2 mit abgeschlossener Meldung", async () => {
    const status = await readStatus(root, jobId);
    return status?.run === 2 && status.phase === "ended" && ["sent", "failed"].includes(status.notice?.state ?? "");
  }, 120_000);
  const done = (await readStatus(root, id))!;
  assert.equal(done.sessionId, first.sessionId);
  assert.equal(done.outcome, "success");
  assert.equal(done.notice?.state, "sent");
  const report = await readFile(jobFile(root, id, "report"), "utf8");
  assert(report.includes("FORTSETZUNG_OK") && report.includes(marker), "Bericht erinnert sich nicht an den ersten Turn");
  assert.equal(messages.filter(m => !m.metadata.choiceId).length, 2, "genau eine Abschlussmeldung je Lauf");
  assert.equal(messages.filter(m => m.metadata.choiceId).length, 1, "eine separate Fortsetzen-Frage");
  assert(messages.some(m => m.content.includes("FORTSETZUNG_OK") && m.content.includes(marker)));
  assert(!JSON.stringify(messages).includes(first.sessionId!));
  console.log("Lauf 2: success, dieselbe Session, Bericht FORTSETZUNG_OK mit gemerktem Belegwort, Meldung sent.");
  console.log("Nachweis: genau zwei Abschlussmeldungen (eine je Lauf) und eine separate Fortsetzen-Frage; keine Session-ID in Meldungen.");
  console.log(`Testdaten: ${root}`);
} finally {
  // Auch nach einem fehlgeschlagenen Nachweis ausschließlich die eigenen Testprozesse räumen.
  for (const status of await readAllStatuses(root)) {
    if (status.watcher && checkProcess(status.watcher, deps.proc) === "same") process.kill(status.watcher.pid, "SIGKILL");
    if (status.claude) await terminateGroup(status.claude, deps.proc);
  }
  server.stop(true);
}
