import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotPipelines, pipelineText } from "../src/web/bot-pipelines";
import { createDemoPipelines, startDemoServer } from "../src/web/demo";
import { PIPELINE_LIMIT, PIPELINE_QUESTION_MS, PIPELINE_STALE_MS, PIPELINE_STATUS_BYTES } from "../src/web/pipeline-status";
import { maskSecrets } from "../src/lib/jobs/mask";
import { createPipelinesApi, PIPELINES_EMPTY, PIPELINES_FAILED } from "../src/web/pipelines";
import { startWebUi } from "../src/web/startup";
import type { WebServer, WebServerDeps } from "../src/web/server";
import { topicServer } from "./topic-fixture";

let root: string;
const servers: WebServer[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "web-pipelines-")); await mkdir(join(root, "data")); });
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  await rm(root, { recursive: true, force: true });
});
const file = () => join(root, "data/pipeline-status.json");
const port = () => createBotPipelines({ root, home: "/Users/alex" });
const save = (value: unknown) => writeFile(file(), JSON.stringify(value));

test("HTTP hinter Anmeldung, nur GET, no-store, fehlender Port und fehlende Datei leer", async () => {
  const ctx = await topicServer(root, servers, null, { pipelines: port() });
  expect((await fetch(`${ctx.origin}/api/pipelines`)).status).toBe(401);
  expect((await ctx.api("/api/pipelines", "POST", {})).status).toBe(405);
  expect((await ctx.api("/api/pipelines", "DELETE")).status).toBe(405);
  const response = await ctx.api("/api/pipelines");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(PIPELINES_EMPTY);
  expect((await createPipelinesApi().get()).body).toEqual(PIPELINES_EMPTY);
});

test("Positivliste und Maskierung auf jeder Freitextebene, Strukturwerte bleiben erhalten", async () => {
  const secret = "synthetisches-geheimnis-646";
  await writeFile(join(root, ".env"), `BELIEBIG=${secret}\nBOOL=true\nPORT=3100\n`);
  const snapshot: any = await createDemoPipelines().read();
  snapshot.pid = 7348921;
  snapshot.supervisors.pid = 7348921;
  const p = snapshot.pipelines[0];
  const unsafe = `${secret} /Users/alex/privat /Volumes/privat/b.txt C:\\privat\\b.txt file:///tmp/b.txt PID 7348921`;
  Object.assign(p, { name: unsafe, description: unsafe, milestone: unsafe, reason: unsafe, pid: 7348921, root: "/tmp/private", command: "private-command", conversation: "topic-443" });
  p.issue = { number: 3100, title: unsafe, url: "javascript:bad", pid: 7348921 };
  p.question = { at: new Date().toISOString(), text: unsafe, sent: true, pid: 7348921 };
  p.events = [{ at: snapshot.generatedAt, type: "review", round: 2, text: unsafe, pid: 7348921 }];
  p.step = { kind: "review", round: 2, text: unsafe, pid: 7348921 };
  await save(snapshot);
  const result = await createPipelinesApi(port(), async () => unsafe).get();
  expect(result.status).toBe(200);
  const body = result.body as any, raw = JSON.stringify(body), item = body.pipelines[0];
  for (const value of [secret, "/Users/", "/Volumes/", "C:\\", "file://", "7348921", "private-command", "javascript:", '"pid"', '"sent"', '"root"', '"ghRepo"']) expect(raw).not.toContain(value);
  expect(item.issue).toEqual({ number: 3100, title: item.name, url: "https://github.com/beispiel/lesegarten/issues/3100" });
  expect(item.step).toEqual({ kind: "review", round: 2 });
  expect(item.events).toEqual([{ at: snapshot.generatedAt, type: "review", round: 2 }]);
  expect(item.question.at).toBe(p.question.at);
  expect(item.conversation).toEqual({ id: "topic-443", name: item.name });
  expect(raw).toContain("[Pfad verborgen]");
  expect(raw).toContain("[verborgen]");
  expect(body.supervisors).toEqual({ check: false, watch: false, follow: false });
});

test("Zeitstempel statt Datei-mtime: genau fünf Minuten frisch, danach bei jedem Abruf veraltet", async () => {
  const snapshot = (await createDemoPipelines().read())!;
  const base = Date.parse(snapshot.generatedAt);
  let now = base + PIPELINE_STALE_MS;
  await save(snapshot);
  const api = createPipelinesApi(port(), undefined, () => now);
  expect((await api.get()).body).toMatchObject({ stale: false, waiting: 1, running: 1 });
  now++;
  expect((await api.get()).body).toMatchObject({ stale: true, waiting: 1, running: 1 });
  snapshot.generatedAt = new Date(now).toISOString(); await save(snapshot);
  expect((await api.get()).body).toMatchObject({ stale: false });
  snapshot.generatedAt = new Date(now + 60_001).toISOString(); await save(snapshot);
  expect((await api.get()).body).toMatchObject({ stale: true });
});

test("Pfadmaskierung vor Geheimnissen lässt keine Pfadreste stehen und erhält gewöhnliche Schrägstriche", () => {
  const display = pipelineText(text => maskSecrets(text, ["secret646"]), "/Users/alex");
  for (const path of ["/tmp/secret646/private.txt", "/Users/alex/secret646/private.txt", "C:\\secret646\\private.txt", "\\\\server\\secret646\\private.txt"]) {
    expect(display(`Bericht: ${path}`, 500)).toBe("Bericht: [Pfad verborgen]");
    expect(display(`Bericht: [Datei](${path})`, 500)).toBe("Bericht: [Datei]([Pfad verborgen])");
  }
  expect(display("Swift/SwiftUI Europe/Berlin F0/F1 https://example.org/a/b", 500)).toBe("Swift/SwiftUI Europe/Berlin F0/F1 https://example.org/a/b");
  expect(display("secret646", 500)).toBe("[verborgen]");
  expect(display("Bericht: \u200b/tmp/privat P\u200bID 123456", 500)).toBe("Bericht: [Pfad verborgen] [Prozess verborgen]");
});

test("nur vorhandene Gespräche, streng geprüfte GitHub-Quelle, Fragegrenze bei jedem Abruf", async () => {
  const snapshot: any = await createDemoPipelines().read();
  const now = Date.parse(snapshot.generatedAt);
  const p = snapshot.pipelines[0];
  for (const bad of ["https://github.com/a/b", "a/b/../c", "a/b?token=x", "a/b#x", "a/b c", "/a/b", "a/..", "a%2Fb/c"]) {
    p.ghRepo = bad; p.conversation = "topic-443";
    await save(snapshot);
    const item = ((await createPipelinesApi(port(), async () => "").get()).body as any).pipelines[0];
    expect(item.issue.url).toBeNull(); expect(item.conversation).toBeNull();
  }
  for (const bad of ["topic-0", "topic--1", "web-123", "javascript:alert(1)", "dm/other"]) {
    p.conversation = bad; await save(snapshot);
    expect(((await createPipelinesApi(port(), async () => "Titel").get()).body as any).pipelines[0].conversation).toBeNull();
  }
  p.conversation = "dm"; p.ghRepo = "owner/repo";
  for (const age of [PIPELINE_QUESTION_MS, PIPELINE_QUESTION_MS + 1, -1]) {
    p.question.at = new Date(now - age).toISOString(); await save(snapshot);
    const item = ((await createPipelinesApi(port(), async () => "Direktchat", () => now).get()).body as any).pipelines[0];
    expect(item.question !== null).toBe(age === PIPELINE_QUESTION_MS);
    expect(item.conversation).toEqual({ id: "dm", name: "Direktchat" });
  }
});

test("fremde Eingabe: Größen, Typen, Version, Zeitstempel, Symbole, Verzeichnisse, Lesefehler", async () => {
  const snapshot = (await createDemoPipelines().read())!;
  const api = createPipelinesApi(port());
  const bad = async () => expect(await api.get()).toEqual({ status: 503, body: { error: PIPELINES_FAILED } });
  for (const raw of [null, [], {}, { ...snapshot, version: 2 }, { ...snapshot, generatedAt: "kaputt" }, { ...snapshot, pipelines: Array(PIPELINE_LIMIT + 1).fill(snapshot.pipelines[0]) }]) {
    await save(raw); await bad();
  }
  await writeFile(file(), "{"); await bad();
  await writeFile(file(), "x".repeat(PIPELINE_STATUS_BYTES + 1)); await bad();
  await unlink(file()); await symlink(join(root, "private"), file()); await bad();
  await unlink(file()); await mkdir(file()); await bad();
  await rm(file(), { recursive: true }); await save(snapshot);
  await mkdir(join(root, ".env")); await bad();
});

test("unbekannte Zustände und Schritte fallen weg, doppelte IDs nicht zweimal, Text und Ereignisse begrenzt", async () => {
  const snapshot: any = await createDemoPipelines().read();
  const p = snapshot.pipelines[0];
  p.name = "n".repeat(200); p.description = "d".repeat(500); p.reason = "r".repeat(1500); p.question.text = "q".repeat(5000);
  p.issue.number = "42"; p.step = { kind: "unbekannt", pid: 12345 };
  p.events = Array.from({ length: 20 }, (_, i) => ({ at: new Date(Date.now() - i * 1000).toISOString(), type: "ci" }));
  snapshot.pipelines.push(p, { ...p, id: "bad", state: "kaputt" }, { ...p, id: "/tmp/bad" });
  await save(snapshot);
  const body = (await createPipelinesApi(port()).get()).body as any;
  expect(body.pipelines).toHaveLength(4);
  expect(body.pipelines.map((p: any) => p.state)).toEqual(["waiting", "halted", "running", "resting"]);
  const item = body.pipelines[0];
  expect(item.name).toHaveLength(120); expect(item.description).toHaveLength(300);
  expect(item.reason).toHaveLength(1000); expect(item.question.text).toHaveLength(4000);
  expect(item.issue).toBeNull(); expect(item.step).toBeNull(); expect(item.events).toHaveLength(5);
});

test("Demo und Startup: vier Zustände, vorhandenes Zielgespräch und unveränderter Port", async () => {
  const pipelines = createDemoPipelines();
  const demo = await startDemoServer({ host: "127.0.0.1", port: 0, password: "demo-passwort-lang", allowedHosts: [] }, { pipelines, log: () => {} });
  try {
    const body = await (await fetch(`${demo.server.url}/api/pipelines`)).json();
    expect(body.pipelines.map((p: any) => p.state)).toEqual(["waiting", "halted", "running", "resting"]);
    expect(body.pipelines[0].conversation).toEqual({ id: "topic-60", name: "Pipeline" });
    pipelines.setSnapshot(null);
    expect(await (await fetch(`${demo.server.url}/api/pipelines`)).json()).toEqual(PIPELINES_EMPTY);
  } finally { await demo.stop(); }
  let received: WebServerDeps | undefined;
  await startWebUi({ env: { WEB_ENABLED: "true", WEB_PASSWORD: "test-passwort-lang" }, chat: { runTurn: async () => ({ text: "" }), stop() {} }, pipelines,
    createServer: async (_config, deps) => { received = deps; return { url: "http://127.0.0.1:3100", eventStreamCount: () => 0, stop: async () => {} } as WebServer; }, log: () => {}, lanAddresses: () => [] });
  expect(received!.pipelines).toBe(pipelines);
});
