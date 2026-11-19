/** Jobs-API mit echter Status-/Rückfragenablage, Prozessen und Versand als Attrappen. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChoice, getChoice, onChoiceDecided, setChoicesFileForTests } from "../src/lib/choices";
import { claudeProjectDir } from "../src/lib/engines/claude-notes";
import { projectSecrets } from "../src/lib/jobs/mask";
import { statusLabel } from "../src/lib/jobs/control";
import { jobChoiceHandler } from "../src/lib/jobs/choices";
import { jobFile, readStatus, writeStatus, type JobStatus } from "../src/lib/jobs/store";
import { createBotJobs } from "../src/web/bot-jobs";
import { createDemoChoices, createDemoJobs, DEMO_JOB_CHOICE, DEMO_JOB_IDS, startDemoServer } from "../src/web/demo";
import { createJobsApi, JOB_API_FIELDS } from "../src/web/jobs";
import { startWebUi } from "../src/web/startup";
import type { WebServer, WebServerDeps } from "../src/web/server";
import { fakeDeps, tempRoot, type FakeDeps } from "./jobs-fixture";
import { topicServer } from "./topic-fixture";

let root: string, cleanup: () => void, deps: FakeDeps;
const servers: WebServer[] = [];
const id = "20261118-120000-000626";
const secret = "dummy-env-value-626";
const sessionId = "12345678-1234-4234-8234-123456789abc";
const home = "/Users/alex";
const request = () => crypto.randomUUID();
const port = () => createBotJobs({ deps, userId: "4242", groupId: () => "-1001234567890", home });
beforeEach(() => {
  ({ root, cleanup } = tempRoot("web-jobs-"));
  setChoicesFileForTests(join(root, "choices.json"));
  deps = fakeDeps(root, { secrets: [secret], now: () => new Date("2026-11-18T12:00:00Z") });
  deps.startConfirmMs = 0;
  deps.claudeEnv = () => ({ HOME: root });
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  setChoicesFileForTests(null);
  cleanup();
});
async function prepare(over: Partial<JobStatus> = {}) {
  const s: JobStatus = { version: 1, id, title: `Recherche ${secret}`, createdAt: "2026-11-17T10:00:00Z", run: 1,
    startedAt: "2026-11-18T11:30:00Z", phase: "running", maxHours: 2, fullAccess: false, sessionId,
    target: { chatId: "-1001234567890", topicId: 443 }, claude: { pid: 76626, identity: "start-76626" }, ...over };
  await writeStatus(root, s);
  await Bun.write(jobFile(root, s.id, "brief"), "PRIVATE-BRIEF-626");
  await Bun.write(jobFile(root, s.id, "log"), `Log ${secret} ${sessionId} ${home}/tybo\n`);
  return s;
}
async function ended(over: Partial<JobStatus> = {}) {
  const s = await prepare({ phase: "ended", outcome: "aborted", endedAt: "2026-11-18T11:40:00Z",
    termination: { state: "done", result: "gone" }, notice: { state: "sent", attempts: 1 }, ...over });
  await mkdir(claudeProjectDir(root, root), { recursive: true });
  await writeFile(join(claudeProjectDir(root, root), `${sessionId}.jsonl`), "{}\n");
  return s;
}

test("HTTP: Anmeldung, Origin, Methoden, Port, ungültige IDs und Eingaben vor der Quelle", async () => {
  let calls = 0;
  const p = createDemoJobs();
  const ctx = await topicServer(root, servers, null, { jobs: { ...p, content: async () => { calls++; return null; }, act: async () => { calls++; return "done"; } } });
  expect((await fetch(`${ctx.origin}/api/jobs`)).status).toBe(401);
  expect((await ctx.api("/api/jobs", "POST", {})).status).toBe(405);
  for (const bad of ["x", "a%2Fb", "%E0%A4%A", "..%2F..%2Fetc"]) {
    expect((await ctx.api(`/api/jobs/${bad}/log`)).status).toBe(400);
    expect((await ctx.api(`/api/jobs/${bad}/stop`, "POST", { request: request(), expectedRun: 1, confirm: true })).status).toBe(400);
  }
  for (const body of [{}, { confirm: false }, { confirm: "true" }, { confirm: true, request: "short", expectedRun: 1 }, { confirm: true, request: request() }, { confirm: true, request: request(), expectedRun: 0 }]) {
    expect((await ctx.api(`/api/jobs/${id}/stop`, "POST", body)).status).toBe(400);
  }
  expect((await ctx.api(`/api/jobs/${id}/start`, "POST", {})).status).toBe(400);
  expect((await ctx.api(`/api/jobs/${id}/log?run=NaN`)).status).toBe(400);
  expect((await ctx.api(`/api/jobs/${id}/stop`, "POST", { request: request(), expectedRun: 1, confirm: true }, { origin: "https://fremd.example" })).status).toBe(403);
  expect(calls).toBe(0);
  const missing = await topicServer(root, servers, null);
  expect((await missing.api("/api/jobs")).status).toBe(503);
  expect((await ctx.api("/api/jobs")).headers.get("cache-control")).toBe("no-store");
});

test("Positivliste: keine privaten Statusfelder, Brief, PID, Chat-ID, Session, Pfade oder .env-Werte", async () => {
  await prepare({ title: `${secret} ${sessionId} ${home}/tybo /tmp/private`, watcher: { pid: 876626, identity: "private-process" },
    workDir: "/tmp/private-work", allowedTools: ["private-tool"], deniedTools: ["private-denied"],
    leftovers: [{ pid: 876627, command: "private-command" }], detail: "private-detail", notice: { state: "failed", attempts: 1, error: "private-error" } });
  const ctx = await topicServer(root, servers, null, { jobs: port() });
  const raw = await (await ctx.api("/api/jobs")).text();
  const body = JSON.parse(raw);
  expect(Object.keys(body.jobs[0]).sort()).toEqual([...JOB_API_FIELDS].sort());
  for (const value of [secret, sessionId, home, "/tmp/", "PRIVATE-BRIEF", "76626", "876626", "-1001234567890", "private-process", "private-work", "private-tool", "private-denied", "private-command", "private-detail", "private-error"])
    expect(raw).not.toContain(value);
  expect(body).toMatchObject({ waiting: 0, running: 1, jobs: [{ conversation: { id: "topic-443" }, duration: "30 Min", actions: ["stop", "log"] }] });
  const extra = createDemoJobs();
  const api = createJobsApi({ ...extra, list: async title => (await extra.list(title)).map(j => ({ ...j, pid: 7654321, brief: "private-brief", question: j.question ? { ...j.question, private: "private-question" } : null })) });
  const text = JSON.stringify((await api.get()).body);
  expect(text).not.toContain("7654321"); expect(text).not.toContain("private-");
});

test("Status, Reihenfolge, letzte 20 und Aktionen stammen aus dem Kern; unanswered darf fortsetzen", async () => {
  const waiting = { number: 1, question: { frage: "Frage?", kontext: "Kontext", antworten: ["Ja", "Nein"] }, askedAt: "2026-11-18T11:30:00Z", deadlineAt: "2026-11-20T11:30:00Z", delivery: { state: "sent" as const, attempts: 1 } };
  await prepare({ phase: "waiting", activeMs: 120_000, waiting });
  await prepare({ id: "20261118-130000-000001", phase: "starting" });
  for (let i = 0; i < 24; i++) await ended({ id: `20261117-080000-${i.toString(16).padStart(6, "0")}`, endedAt: `2026-11-${(i + 1).toString().padStart(2, "0")}T12:00:00Z`, outcome: "unanswered" });
  const jobs = await port().list(async () => "Recherche");
  expect(jobs).toHaveLength(22);
  expect(jobs[0]).toMatchObject({ phase: "waiting", status: "wartet auf dich", duration: "2 Min", question: { choice: null } });
  expect(jobs[1]).toMatchObject({ phase: "starting", status: "startet", actions: ["stop", "log"] });
  expect(jobs[2]).toMatchObject({ status: "Frage unbeantwortet", actions: ["resume", "log"] });
  for (const over of [{ engine: "codex" }, { workDir: "/tmp" }, { sessionId: undefined }, { termination: { state: "done", result: "survived" } }, { termination: { state: "done", result: "unverified" } }, { notice: { state: "pending", attempts: 0 } }] as Partial<JobStatus>[]) {
    await ended(over);
    expect((await port().list(async () => "")).find(j => j.id === id)!.actions).not.toContain("resume");
  }
});

test("Log und Markdown-Bericht maskieren Session, .env und Home; Grenzen und fehlende Datei", async () => {
  await prepare();
  await Bun.write(jobFile(root, id, "log"), "alte Zeile\n".repeat(30_000) + Array.from({ length: 250 }, (_, i) => `${i} ${secret} ${sessionId} ${home}/tybo ${"x".repeat(500)}`).join("\n"));
  const api = createJobsApi(port());
  const log = (await api.content(id, "log")).body as any;
  expect(log.text.split("\n").length).toBeLessThanOrEqual(200);
  expect(log.text.length).toBeLessThanOrEqual(60_000);
  expect(log.text.split("\n").every((l: string) => l.length <= 300)).toBe(true);
  for (const value of [secret, sessionId, home, "alte Zeile"]) expect(log.text).not.toContain(value);
  expect((await api.content(id, "report")).status).toBe(404);
  await Bun.write(jobFile(root, id, "report"), `## Bericht\n\n**Ergebnis** ${secret} ${sessionId} ${home}/tybo\n<script>alert(1)</script>`);
  const report = (await api.content(id, "report")).body as any;
  expect(report.html).toContain("<h2>Bericht</h2>");
  expect(report.html).not.toContain("<script>");
  for (const value of [secret, sessionId, home]) expect(JSON.stringify(report)).not.toContain(value);
  await Bun.write(jobFile(root, id, "report"), "dummy-env-**value-626**");
  expect((await api.content(id, "report")).body).toMatchObject({ text: "[verborgen]" });
  await Bun.write(jobFile(root, id, "report"), "x".repeat(140_000));
  expect(JSON.stringify((await api.content(id, "report")).body)).toContain("zu groß");
  expect((await api.content(id, "log", "2")).status).toBe(409);
});

test("Stoppen antwortet trotz blockiertem Versand nach dem Signal; gleiche Kennung handelt einmal", async () => {
  const s = await prepare();
  deps.procs.spawn(s.claude!.pid);
  let release!: () => void;
  let delivered!: () => void;
  const done = new Promise<void>(r => { delivered = r; });
  deps.notify = async () => { await new Promise<void>(r => { release = r; }); delivered(); return { sent: true, recorded: true }; };
  const ctx = await topicServer(root, servers, null, { jobs: port() });
  const body = { request: request(), expectedRun: 1, confirm: true };
  const result = await ctx.api(`/api/jobs/${id}/stop`, "POST", body);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ status: "done" });
  expect(deps.procs.signals).toHaveLength(1);
  expect((await readStatus(root, id))!.termination).toMatchObject({ state: "done" });
  expect(await (await ctx.api(`/api/jobs/${id}/stop`, "POST", body)).json()).toMatchObject({ status: "already" });
  // Die Kennung bleibt auch in einer neu erzeugten Quelle beansprucht.
  expect(await port().act(id, "stop", body.request, 1)).toBe("already");
  while (!release) await Bun.sleep(1);
  release(); await done;
  while ((await readStatus(root, id))!.notice?.state !== "sent") await Bun.sleep(1);
});

test.each(["unverified", "survived"] as const)("Stoppen %s: eigene Texte ohne PID", async tree => {
  const s = await prepare(); deps.procs.spawn(s.claude!.pid);
  if (tree === "unverified") deps.procs.identity = () => null;
  else { deps.procs.signalGroup = () => true; deps.procs.sleep = async () => {}; }
  const result = await createJobsApi(port()).act(id, "stop", JSON.stringify({ request: request(), expectedRun: 1, confirm: true }));
  expect(result.body).toMatchObject({ status: tree });
  expect(JSON.stringify(result.body)).not.toContain(String(s.claude!.pid));
  // Hintergrundversand vor dem Entfernen der Testablage fertigstellen.
  while ((await readStatus(root, id))!.notice?.state !== "sent") await Bun.sleep(1);
});

test("Veralteter Tab darf späteren Lauf weder stoppen noch fortsetzen; Dateien gelten nur aktuell", async () => {
  await ended(); await Bun.write(jobFile(root, id, "report"), "alter Bericht");
  expect(await port().act(id, "resume", request(), 1)).toBe("done");
  expect(await port().act(id, "stop", request(), 1)).toBe("stale");
  expect(await port().act(id, "resume", request(), 1)).toBe("stale");
  expect(deps.procs.signals).toHaveLength(0);
  expect((await readStatus(root, id))!.run).toBe(2);
  expect(await port().content(id, "report", 2)).toBeNull();
  expect((await port().list(async () => ""))[0].actions).not.toContain("report");
});

test("Fortsetzen entscheidet eine offene Registerfrage statt sie nur ablaufen zu lassen", async () => {
  await ended();
  const c = await createChoice({ kind: "job", ref: id, action: "resume-1", conversation: { type: "telegram", chatId: "4242" }, text: "Fortsetzen?", options: [{ key: "resume", label: "Fortsetzen" }] });
  const off = onChoiceDecided("job", jobChoiceHandler(deps));
  try {
    expect(await port().act(id, "resume", request(), 1)).toBe("done");
    expect(await getChoice(c.id)).toMatchObject({ state: "done", result: { via: "web", key: "resume" } });
    expect((await readStatus(root, id))!.run).toBe(2);
  } finally { off(); }
});

test("Demo: dieselbe Frage wie im Gespräch, fremdes Gespräch abgelehnt; Antwort, Stoppen und Fortsetzen", async () => {
  const demo = await startDemoServer({ host: "127.0.0.1", port: 0, password: "demo-passwort-lang", allowedHosts: [] }, { log: () => {} });
  try {
    const get = async () => (await (await fetch(`${demo.server.url}/api/jobs`)).json()).jobs;
    const post = (path: string, body: unknown) => fetch(demo.server.url + path, { method: "POST", headers: { origin: demo.server.url }, body: JSON.stringify(body) });
    expect((await get())[0].question).toMatchObject({ conversationId: "topic-31", choice: { id: DEMO_JOB_CHOICE, state: "open" } });
    expect((await post(`/api/conversations/topic-443/choices/${DEMO_JOB_CHOICE}`, { option: "a1" })).status).toBe(404);
    expect((await post(`/api/conversations/topic-31/choices/${DEMO_JOB_CHOICE}`, { option: "a1" })).status).toBe(200);
    expect((await demo.choices.decideInTelegram(DEMO_JOB_CHOICE, "a2")).status).toBe("already");
    expect((await get()).find((j: any) => j.id === DEMO_JOB_IDS.waiting)).toMatchObject({ phase: "running", run: 2, question: null });
    expect((await post(`/api/jobs/${DEMO_JOB_IDS.running}/stop`, { request: request(), expectedRun: 1, confirm: true })).status).toBe(200);
    expect((await post(`/api/jobs/${DEMO_JOB_IDS.aborted}/resume`, { request: request(), expectedRun: 1 })).status).toBe(200);
    expect((await get()).find((j: any) => j.id === DEMO_JOB_IDS.running).status).toBe("gestoppt");
    expect((await get()).find((j: any) => j.id === DEMO_JOB_IDS.aborted).run).toBe(2);
  } finally { await demo.stop(); }
});

test("Startup reicht Jobs-Port unverändert weiter", async () => {
  const jobs = createDemoJobs(createDemoChoices());
  let received: WebServerDeps | undefined;
  await startWebUi({ env: { WEB_ENABLED: "true", WEB_PASSWORD: "test-passwort-lang" }, chat: { runTurn: async () => ({ text: "" }), stop() {} }, jobs,
    createServer: async (_config, deps) => { received = deps; return { url: "http://127.0.0.1:3100", eventStreamCount: () => 0, stop: async () => {} } as WebServer; }, log: () => {}, lanAddresses: () => [] });
  expect(received!.jobs).toBe(jobs);
});


test("Frage: Auswahl im tatsächlichen Gespräch, alle Texte maskiert, ohne Bezug keine Knöpfe", async () => {
  const c = await createChoice({ kind: "job", ref: id, action: "ask-1-1", conversation: { type: "telegram", chatId: "4242" },
    text: "Frage", options: [{ key: "a1", label: secret }, { key: "a2", label: "dummy-env-**value-626**" }] });
  const waiting = { number: 1, question: { frage: secret, kontext: `${sessionId} ${home}/private`, antworten: [secret, "dummy-env-**value-626**"] },
    askedAt: "2026-11-18T11:30:00Z", deadlineAt: "2026-11-20T11:30:00Z", choiceId: c.id, delivery: { state: "sent" as const, attempts: 1 } };
  await prepare({ phase: "waiting", waiting });
  const api = createJobsApi(port());
  const result = (await api.get()).body as any;
  expect(result.jobs[0].conversation.id).toBe("topic-443");
  expect(result.jobs[0].question).toMatchObject({ conversationId: "dm", choice: { id: c.id, options: [{ key: "a1", label: "[verborgen]" }, { key: "a2", label: "[verborgen]" }] } });
  for (const value of [secret, sessionId, home, "4242", "-1001234567890"]) expect(JSON.stringify(result)).not.toContain(value);
  await prepare({ phase: "waiting", waiting: { ...waiting, choiceId: undefined } });
  expect(((await api.get()).body as any).jobs[0].question).toMatchObject({ text: "[verborgen]", choice: null, conversationId: null });
  const foreign = await createChoice({ kind: "job", ref: id, action: "ask-1-1", conversation: { type: "telegram", chatId: "999999" }, text: "Frage", options: [{ key: "a1", label: "Ja" }] });
  await prepare({ phase: "waiting", waiting: { ...waiting, choiceId: foreign.id } });
  expect(((await api.get()).body as any).jobs[0].question).toMatchObject({ choice: null, conversationId: null });
});

test("Werte aus echter temporärer .env bleiben aus Liste, Log, Markdown und Aktionen", async () => {
  await Bun.write(join(root, ".env"), `ARBITRARY_SETTING=${secret}\n`);
  deps.secrets = () => projectSecrets(root, {});
  await prepare(); await Bun.write(jobFile(root, id, "report"), `# Ergebnis\n${secret}`);
  const api = createJobsApi(port());
  const results = [await api.get(), await api.content(id, "log"), await api.content(id, "report"),
    await api.act(id, "resume", JSON.stringify({ request: request(), expectedRun: 1 }))];
  expect(JSON.stringify(results)).not.toContain(secret);
  expect(JSON.stringify(results)).toContain("[verborgen]");
});

test("Stoppen wartet auch nicht auf Telegram beim Entfernen der Frageknöpfe", async () => {
  const s = await prepare(); deps.procs.spawn(s.claude!.pid);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  deps.expireResumeChoices = () => gate;
  expect(await port().act(id, "stop", request(), 1)).toBe("done");
  expect(deps.procs.signals).toHaveLength(1);
  expect((await readStatus(root, id))!.phase).toBe("ended");
  release();
  while ((await readStatus(root, id))!.notice?.state !== "sent") await Bun.sleep(1);
});

test("Gleichzeitige Kennung über zwei Quellen stoppt genau einmal", async () => {
  const s = await prepare(); deps.procs.spawn(s.claude!.pid);
  const key = request();
  const results = await Promise.all([port().act(id, "stop", key, 1), port().act(id, "stop", key, 1)]);
  expect(results.sort()).toEqual(["already", "done"]);
  expect(deps.procs.signals).toHaveLength(1);
  while ((await readStatus(root, id))!.notice?.state !== "sent") await Bun.sleep(1);
});

test("alle Abschlussbeschriftungen einschließlich fehlgeschlagener Meldung wie statusLabel", async () => {
  for (const outcome of ["success", "failed", "no_report", "timeout", "stopped", "aborted", "start_failed", "unanswered", "question_limit", "question_failed"] as const) {
    const s = await ended({ outcome, notice: { state: "failed", attempts: 6 } });
    expect((await port().list(async () => ""))[0].status).toBe(statusLabel(s));
  }
});

test("Bericht-Symlink wird nicht gelesen und nicht angeboten; Quellenfehler geben keine Details preis", async () => {
  await prepare();
  const report = jobFile(root, id, "report");
  await symlink(jobFile(root, id, "brief"), report);
  expect(await port().content(id, "report")).toBeNull();
  expect((await port().list(async () => ""))[0].actions).not.toContain("report");
  await unlink(report);
  const fail = () => { throw new Error(`${secret} ${home} PID 76626`); };
  const api = createJobsApi({ home, list: fail, content: fail, act: fail });
  for (const result of [await api.get(), await api.content(id, "log"), await api.act(id, "resume", JSON.stringify({ request: request(), expectedRun: 1 }))]) {
    expect(result.status).toBe(500);
    for (const value of [secret, home, "76626"]) expect(JSON.stringify(result.body)).not.toContain(value);
  }
});

test("web:dev ohne Demo nutzt die Frage im vorhandenen General-Topic", async () => {
  const choices = createDemoChoices(Date.now(), 1);
  const jobs = createDemoJobs(choices, { id: "topic-1", name: "General" });
  expect((await jobs.list(async () => ""))[0].question).toMatchObject({ conversationId: "topic-1", choice: { options: [{ key: "a1" }, { key: "a2" }] } });
  expect((await choices.decide("topic-1", DEMO_JOB_CHOICE, "a1", "web")).status).toBe("decided");
  expect((await jobs.list(async () => "")).find(j => j.id === DEMO_JOB_IDS.waiting)).toMatchObject({ phase: "running", run: 2 });
});
