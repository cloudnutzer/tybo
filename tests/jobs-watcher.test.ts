/**
 * Issue #103, Checkbox 2: der Wächter meldet jeden Ausgang genau einmal im
 * gespeicherten Gespräch. Claude ist eine Attrappe (Status-Attrappe oder
 * ein echtes `sh`), Versand eine Liste. Nie echtes claude, nie Telegram.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createJobDeps } from "../src/lib/jobs/default-deps";
import { realProcessOps } from "../src/lib/jobs/process";
import { runWatcher, type ClaudeSpawnSpec, type SpawnedClaude } from "../src/lib/jobs/runner";
import { sendAndRecord, type OutboxDeps, type SendAndRecordInput } from "../src/lib/outbox";
import { jobFile, readStatus, writeStatus, type JobStatus, type JobTarget } from "../src/lib/jobs/store";
import { fakeChild, fakeDeps, tempRoot, type FakeChild, type FakeDeps, type FakeOptions } from "./jobs-fixture";

const repo = resolve(import.meta.dir, "..");
const { root, cleanup } = tempRoot();
afterAll(cleanup);

let counter = 0;

/** Job im Zustand „startet“, wie ihn startJob hinterlässt */
async function prepareJob(over: Partial<JobStatus> = {}, target: JobTarget = { chatId: "-100200", topicId: 443 }): Promise<string> {
  const id = `20260925-130000-${(counter++).toString(16).padStart(6, "0")}`;
  const status: JobStatus = {
    version: 1,
    id,
    title: "Anbieter vergleichen",
    createdAt: new Date(Date.now() - 125 * 60_000).toISOString(),
    phase: "starting",
    maxHours: 6,
    model: "claude-test",
    fullAccess: false,
    target,
    ...over,
  };
  await Bun.write(jobFile(root, id, "brief"), "Vergleiche drei Anbieter.");
  await Bun.write(jobFile(root, id, "log"), "");
  await writeStatus(root, status);
  return id;
}

interface ClaudeBehavior {
  code: number | null;
  signal?: string;
  report?: string;
  logLines?: string[];
}

/** Claude-Attrappe: schreibt Log und ggf. Bericht und endet sofort */
function fakeClaude(behavior: ClaudeBehavior): NonNullable<FakeOptions["spawnClaude"]> {
  return spec => {
    if (behavior.logLines) appendFileSync(spec.logPath, behavior.logLines.join("\n") + "\n");
    if (behavior.report !== undefined) writeFileSync(jobFile(root, spec.id, "report"), behavior.report);
    return fakeChild(55_555, Promise.resolve({ code: behavior.code, signal: behavior.signal ?? null }));
  };
}

async function watch(id: string, o: FakeOptions = {}): Promise<{ deps: FakeDeps; status: JobStatus }> {
  const deps = fakeDeps(root, o);
  expect(await runWatcher(id, deps)).toBe(0);
  return { deps, status: (await readStatus(root, id))! };
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `Zeile ${i + 1}`);

describe("Wächter: Ausgänge", () => {
  test("Erfolg: Exit 0 und Bericht, eine Meldung mit Titel und Bericht im gespeicherten Gespräch", async () => {
    const id = await prepareJob();
    const { deps, status } = await watch(id, { spawnClaude: fakeClaude({ code: 0, report: "## Ergebnis\nAnbieter A ist am günstigsten." }) });
    expect(status).toMatchObject({ phase: "ended", outcome: "success", exitCode: 0, notice: { state: "sent", attempts: 1, recorded: true } });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]).toMatchObject({ source: "job", chatId: "-100200", topicId: 443 });
    expect(deps.sent[0].text).toContain("Job fertig: Anbieter vergleichen");
    expect(deps.sent[0].text).toContain("Anbieter A ist am günstigsten.");
    // Claude bekam den Auftrag samt Berichtsanweisung über stdin, im Projektordner
    expect(deps.spawned[0].prompt).toContain("Vergleiche drei Anbieter.");
    expect(deps.spawned[0].prompt).toContain(`data/jobs/${id}/report.md`);
    expect(deps.spawned[0].cwd).toBe(root);
    expect(deps.spawned[0].cmd).toContain("acceptEdits");
  });

  test("Absturz ohne Bericht: Exit-Code und genau die letzten 20 Log-Zeilen", async () => {
    const id = await prepareJob({}, { topicId: 7 });
    const { deps, status } = await watch(id, { spawnClaude: fakeClaude({ code: 3, logLines: lines(30) }) });
    expect(status).toMatchObject({ outcome: "failed", exitCode: 3 });
    expect(deps.sent).toHaveLength(1);
    const text = deps.sent[0].text!;
    expect(deps.sent[0].topicId).toBe(7);
    expect(deps.sent[0].chatId).toBeUndefined();
    expect(text).toContain("Job fehlgeschlagen");
    expect(text).toContain("Exit-Code 3");
    for (let i = 11; i <= 30; i++) expect(text).toContain(`Zeile ${i}\n`);
    expect(text).not.toContain("Zeile 10\n");
  });

  test("Absturz trotz Bericht (Exit ungleich 0) gilt als Fehlschlag", async () => {
    const id = await prepareJob();
    const { status, deps } = await watch(id, { spawnClaude: fakeClaude({ code: 1, report: "halb fertig", logLines: ["Fehler"] }) });
    expect(status.outcome).toBe("failed");
    expect(deps.sent).toHaveLength(1);
  });

  test("durch Signal beendet: Signal statt Exit-Code", async () => {
    const id = await prepareJob();
    const { status, deps } = await watch(id, { spawnClaude: fakeClaude({ code: null, signal: "SIGKILL", logLines: ["weg"] }) });
    expect(status).toMatchObject({ outcome: "failed", exitCode: null, signal: "SIGKILL" });
    expect(deps.sent[0].text).toContain("beendet durch Signal SIGKILL");
  });

  test("fehlender Bericht: Exit 0, aber kein (oder leerer) report.md", async () => {
    for (const report of [undefined, "  \n"]) {
      const id = await prepareJob();
      const { status, deps } = await watch(id, { spawnClaude: fakeClaude({ code: 0, report, logLines: ["fertig ohne Bericht"] }) });
      expect(status.outcome).toBe("no_report");
      expect(deps.sent).toHaveLength(1);
      expect(deps.sent[0].text).toContain("Job ohne Bericht");
      expect(deps.sent[0].text).toContain("fertig ohne Bericht");
    }
  });

  test("Direktchat, wenn kein Ziel gespeichert ist", async () => {
    const id = await prepareJob({}, {});
    const { deps } = await watch(id, { spawnClaude: fakeClaude({ code: 0, report: "ok" }) });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0].chatId).toBeUndefined();
    expect(deps.sent[0].topicId).toBeUndefined();
  });

  test("langer Bericht wird gekürzt, damit die Meldung eine Nachricht bleibt", async () => {
    const id = await prepareJob();
    const { deps } = await watch(id, { spawnClaude: fakeClaude({ code: 0, report: "x".repeat(10_000) }) });
    expect(deps.sent[0].text!.length).toBeLessThan(3_200);
    expect(deps.sent[0].text).toContain(`data/jobs/${id}/report.md`);
  });

  test("Claude lässt sich nicht starten: Meldung „nicht gestartet“", async () => {
    const id = await prepareJob();
    const { status, deps } = await watch(id, {
      spawnClaude: () => {
        throw new Error("spawn claude ENOENT");
      },
    });
    expect(status).toMatchObject({ outcome: "start_failed" });
    expect(status.detail).toContain("Claude ließ sich nicht starten");
    expect(deps.sent).toHaveLength(1);
  });

  test("schon beendet (vor dem Start gestoppt): Wächter startet nichts und meldet nichts", async () => {
    const id = await prepareJob({ phase: "ended", outcome: "stopped", notice: { state: "sent", attempts: 1 } });
    const { deps } = await watch(id);
    expect(deps.spawned).toEqual([]);
    expect(deps.sent).toEqual([]);
  });

  test("Stopp zwischen Claude-Start und Eintrag: Claude wird gleich beendet, keine zweite Meldung", async () => {
    const id = await prepareJob();
    let killed: number[] = [];
    let child!: FakeChild;
    const deps = fakeDeps(root, {
      spawnClaude: spec => {
        // stop gewinnt, während Claude gerade startet
        const current = JSON.parse(require("node:fs").readFileSync(jobFile(root, spec.id, "status"), "utf8"));
        writeFileSync(jobFile(root, spec.id, "status"), JSON.stringify({ ...current, phase: "ended", outcome: "stopped", notice: { state: "sent", attempts: 1 } }));
        const pid = deps.procs.spawn(56_000);
        child = fakeChild(pid, new Promise(r => setTimeout(() => r({ code: null, signal: "SIGTERM" }), 5)));
        return child;
      },
    });
    expect(await runWatcher(id, deps)).toBe(0);
    killed = deps.procs.signals.map(s => s.pgid);
    expect(killed).toContain(56_000);
    // Startsperre bleibt zu: Claude selbst startet gar nicht erst
    expect(child.cancelled).toBe(true);
    expect(child.released).toBe(false);
    expect(deps.sent).toEqual([]);
    expect((await readStatus(root, id))!.outcome).toBe("stopped");
  });
});

describe("Wächter: Startsperre und Prozessidentität", () => {
  test("Claude startet erst, wenn PID und Startzeit im Status stehen", async () => {
    const id = await prepareJob();
    let seen: JobStatus | null = null;
    let child!: FakeChild;
    const { status } = await watch(id, {
      spawnClaude: () => {
        child = fakeChild(57_000, Promise.resolve({ code: 0, signal: null }), () => {
          seen = JSON.parse(readFileSync(jobFile(root, id, "status"), "utf8"));
        });
        return child;
      },
    });
    expect(child.released).toBe(true);
    expect(seen).toMatchObject({ phase: "running", claude: { pid: 57_000, identity: "start-57000" } });
    expect(status.outcome).toBe("no_report");
  });

  test("Startzeit von Claude nicht ermittelbar: Claude startet nicht, Meldung „nicht gestartet“, kein Signal", async () => {
    const id = await prepareJob();
    let child!: FakeChild;
    const deps = fakeDeps(root, {
      spawnClaude: () => (child = fakeChild(57_100, Promise.resolve({ code: 0, signal: null }))),
    });
    const identity = deps.procs.identity.bind(deps.procs);
    deps.procs.identity = pid => (pid === 57_100 ? null : identity(pid));
    expect(await runWatcher(id, deps)).toBe(0);
    const status = (await readStatus(root, id))!;
    expect(status).toMatchObject({ outcome: "start_failed", detail: expect.stringContaining("Prozessidentität") });
    expect(status.claude).toBeUndefined();
    expect(child.cancelled).toBe(true);
    expect(child.released).toBe(false);
    expect(deps.procs.signals).toEqual([]);
    expect(deps.sent).toHaveLength(1);
  });

  test("Wächter stirbt nach dem Start des Startprozesses, vor dem Eintrag: Claude startet nie (echter sh-Prozess)", async () => {
    const marker = join(root, "gestartet.txt");
    const id = await prepareJob();
    const script = join(root, "absturz-waechter.ts");
    writeFileSync(
      script,
      [
        `import { createJobDeps } from ${JSON.stringify(join(repo, "src/lib/jobs/default-deps.ts"))};`,
        `const deps = createJobDeps({ root: ${JSON.stringify(root)}, env: { PATH: process.env.PATH }, log: () => {} });`,
        `const child = deps.spawnClaude({ id: ${JSON.stringify(id)}, cmd: ["sh", "-c", "echo ja > ${marker}; sleep 30"], cwd: ${JSON.stringify(root)}, env: { PATH: process.env.PATH ?? "" }, prompt: "Auftrag", logPath: ${JSON.stringify(jobFile(root, id, "log"))} });`,
        // Absturz genau hier: weder Status-Eintrag noch release
        `console.log(child.pid);`,
        `process.exit(0);`,
      ].join("\n"),
    );
    const p = Bun.spawn({ cmd: [process.execPath, "--no-env-file", script], cwd: root, stdout: "pipe", stderr: "inherit" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(1);
    for (let i = 0; i < 100 && realProcessOps.groupAlive(pid); i++) await Bun.sleep(50);
    expect(realProcessOps.groupAlive(pid)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    // Der Status kennt keinen Claude, es gibt auch keinen
    expect((await readStatus(root, id))!.claude).toBeUndefined();
  }, 20_000);
});

describe("Wächter: Zeitüberschreitung mit echtem Prozessbaum (sh statt claude)", () => {
  test("beendet die ganze Prozessgruppe und meldet genau einmal", async () => {
    const id = await prepareJob({ maxHours: 0.001 });
    const real = createJobDeps({ root, env: { PATH: process.env.PATH } });
    const pids: number[] = [];
    const deps = fakeDeps(root);
    deps.proc = realProcessOps;
    deps.timeoutMsFor = () => 300;
    deps.spawnClaude = (spec: ClaudeSpawnSpec): SpawnedClaude => {
      // Kind im Hintergrund plus Vordergrund, beide müssen sterben
      const child = real.spawnClaude({ ...spec, cmd: ["sh", "-c", "echo gestartet; sleep 30 & echo $! > kind.pid; sleep 30; wait"], cwd: root, env: { PATH: process.env.PATH ?? "" } });
      pids.push(child.pid);
      return child;
    };
    const started = Date.now();
    expect(await runWatcher(id, deps)).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    const status = (await readStatus(root, id))!;
    expect(status).toMatchObject({ outcome: "timeout", notice: { state: "sent" } });
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0].text).toContain("Zeit überschritten");
    expect(deps.sent[0].text).toContain("gestartet");
    const childPid = Number(await Bun.file(`${root}/kind.pid`).text());
    for (const pid of [pids[0], childPid]) expect(realProcessOps.alive(pid)).toBe(false);
    expect(realProcessOps.groupAlive(pids[0])).toBe(false);
  }, 20_000);
});

describe("Zustellung", () => {
  /** Echtes sendAndRecord, HTTP abgefangen: jede sendMessage mit Text und Antwortstatus */
  function realOutbox(statuses: number[]) {
    const calls: { method: string; text: string; status: number }[] = [];
    const deps: OutboxDeps = {
      botToken: "synth-bot-token",
      userId: "4242",
      groupId: "-100200",
      outboxDir: join(root, "outbox"),
      fetch: async (url, init) => {
        const method = url.split("/").pop()!;
        const status = statuses[calls.length] ?? 200;
        calls.push({ method, text: JSON.parse(String(init.body)).text, status });
        return new Response(JSON.stringify({ ok: status === 200 }), { status });
      },
      record: async () => true,
      log: () => {},
      newId: () => crypto.randomUUID(),
    };
    return { calls, notify: (input: SendAndRecordInput) => sendAndRecord(input, deps) };
  }

  const heavy = "&<>".repeat(1_000);

  for (const [name, behavior] of [
    ["Bericht", { code: 0, report: `Ergebnis\n${heavy}` }],
    ["Log-Auszug", { code: 1, logLines: Array.from({ length: 20 }, () => "&".repeat(299)) }],
  ] as const) {
    test(`stark maskierender ${name} (&, <, >): genau ein erfolgreicher sendMessage-Aufruf, innerhalb des Limits`, async () => {
      const id = await prepareJob();
      const outbox = realOutbox([]);
      const { status } = await watch(id, { spawnClaude: fakeClaude(behavior), notify: outbox.notify });
      expect(status.notice).toMatchObject({ state: "sent", attempts: 1 });
      expect(outbox.calls).toHaveLength(1);
      expect(outbox.calls[0]).toMatchObject({ method: "sendMessage", status: 200 });
      expect(outbox.calls[0].text.length).toBeLessThanOrEqual(4_096);
      expect(outbox.calls[0].text).toContain("&amp;");
    });
  }

  test("Versandfehler und Wiederholung: jeder Versuch ist die ganze Meldung in einem Stück, am Ende genau eine erfolgreiche", async () => {
    const id = await prepareJob();
    const outbox = realOutbox([500, 502, 200]);
    const { status } = await watch(id, { spawnClaude: fakeClaude({ code: 0, report: heavy }), notify: outbox.notify });
    expect(status.notice).toMatchObject({ state: "sent", attempts: 3 });
    expect(outbox.calls.map(c => c.status)).toEqual([500, 502, 200]);
    expect(outbox.calls.every(c => c.method === "sendMessage" && c.text.length <= 4_096)).toBe(true);
    // Kein Teilversand: alle Versuche schicken denselben vollständigen Text
    expect(new Set(outbox.calls.map(c => c.text)).size).toBe(1);
    expect(outbox.calls.filter(c => c.status === 200)).toHaveLength(1);
  });

  test("Versandfehler: Wiederholung, am Ende genau eine Meldung", async () => {
    const id = await prepareJob();
    const { deps, status } = await watch(id, {
      spawnClaude: fakeClaude({ code: 0, report: "ok" }),
      notify: async (_input, attempt) => (attempt < 3 ? { sent: false, recorded: false, error: { kind: "send", message: "Telegram hat den Text nicht angenommen" } } : { sent: true, recorded: true }),
    });
    expect(deps.sent).toHaveLength(1);
    expect(status.notice).toMatchObject({ state: "sent", attempts: 3 });
  });

  test("Versand scheitert dreimal: Zustand „Meldung nicht zugestellt“, keine weitere", async () => {
    const id = await prepareJob();
    let calls = 0;
    const { deps, status } = await watch(id, {
      spawnClaude: fakeClaude({ code: 0, report: "ok" }),
      notify: async () => {
        calls++;
        return { sent: false, recorded: false, error: { kind: "send", message: "Netz weg" } };
      },
    });
    expect(calls).toBe(3);
    expect(deps.sent).toEqual([]);
    expect(status.notice).toMatchObject({ state: "failed", attempts: 3, error: "Netz weg" });
  });

  test("abgelehnt (invalid): keine Wiederholung", async () => {
    const id = await prepareJob();
    let calls = 0;
    const { status } = await watch(id, {
      spawnClaude: fakeClaude({ code: 0, report: "ok" }),
      notify: async () => {
        calls++;
        return { sent: false, recorded: false, error: { kind: "invalid", message: "Keine Forum-Gruppe eingerichtet" } };
      },
    });
    expect(calls).toBe(1);
    expect(status.notice?.state).toBe("failed");
  });

  test("gesendet, aber nicht festgehalten: nicht wiederholen (sonst doppelt in Telegram), Hinweis im Log", async () => {
    const id = await prepareJob();
    let calls = 0;
    const { deps, status } = await watch(id, {
      spawnClaude: fakeClaude({ code: 0, report: "ok" }),
      notify: async () => {
        calls++;
        return { sent: true, recorded: false };
      },
    });
    expect(calls).toBe(1);
    expect(status.notice).toMatchObject({ state: "sent", recorded: false });
    expect(deps.logs.join("\n")).toContain("nicht für die WebUI festgehalten");
  });

  test("Versand wirft: zählt wie ein Versandfehler", async () => {
    const id = await prepareJob();
    const { deps, status } = await watch(id, {
      spawnClaude: fakeClaude({ code: 0, report: "ok" }),
      notify: async (_i, attempt) => {
        if (attempt === 1) throw new TypeError("fetch failed");
        return { sent: true, recorded: true };
      },
    });
    expect(deps.sent).toHaveLength(1);
    expect(status.notice?.attempts).toBe(2);
  });
});
