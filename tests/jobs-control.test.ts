/**
 * Issue #103, Checkbox 3: job list, stop, log, /jobs in Telegram, Browser
 * und Terminal, verwaiste Jobs beim Bot-Start, beide Befehlseinstiege.
 * Claude ist eine Attrappe (sh), Versand eine Liste oder mangels
 * TELEGRAM_BOT_TOKEN abgelehnt. src/bot.ts wird nur als Text gelesen.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { commandRegistry, HELP_TEXT } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices } from "../src/lib/commands/types";
import { formatJobList, jobLog, recoverJobs, recoverJobsUntilSettled, stopJob } from "../src/lib/jobs/control";
import { createJobDeps } from "../src/lib/jobs/default-deps";
import { realProcessOps } from "../src/lib/jobs/process";
import { checkProcess, processGone, terminateGroup } from "../src/lib/jobs/process";
import { STARTING_GRACE_MS } from "../src/lib/jobs/runner";
import { runWatcher } from "../src/lib/jobs/runner";
import { claimOutcome, jobFile, readStatus, writeStatus, type JobStatus } from "../src/lib/jobs/store";
import { createBotCommands } from "../src/web/bot-commands";
import { toApiMessage } from "../src/web/chat";
import { createStyle, renderTerminalMarkdown } from "../src/terminal/render";
import { Parser, parseDocument } from "htmlparser2";
import { textContent } from "domutils";
import { fakeChild, fakeDeps, tempRoot } from "./jobs-fixture";

const repo = resolve(import.meta.dir, "..");
const { root, cleanup } = tempRoot();
afterAll(cleanup);

let counter = 0;
async function makeJob(over: Partial<JobStatus> = {}, jobRoot = root): Promise<string> {
  const id = `20260925-140000-${(counter++).toString(16).padStart(6, "0")}`;
  await writeStatus(jobRoot, {
    version: 1,
    id,
    title: `Job ${counter}`,
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    phase: "running",
    maxHours: 6,
    model: "claude-test",
    fullAccess: false,
    target: { topicId: 443 },
    ...over,
  });
  await Bun.write(jobFile(jobRoot, id, "brief"), "Auftrag");
  if (!(await Bun.file(jobFile(jobRoot, id, "log")).exists())) await Bun.write(jobFile(jobRoot, id, "log"), "");
  return id;
}

/** Echter Prozessbaum wie Claude: eigene Gruppe, Kind im Hintergrund, Startsperre gelöst */
function realTree(id: string) {
  const real = createJobDeps({ root, env: { PATH: process.env.PATH } });
  const child = real.spawnClaude({
    id,
    cmd: ["sh", "-c", `sleep 30 & echo $! > kind-${id}.pid; sleep 30; wait`],
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    prompt: "",
    logPath: jobFile(root, id, "log"),
  });
  const release = child.release;
  // runWatcher löst die Sperre selbst; hier für Tests ohne Wächter sofort
  return { ...child, release: () => release(), releaseNow: release };
}

async function childPid(id: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const text = await Bun.file(join(root, `kind-${id}.pid`)).text().catch(() => "");
    if (text.trim()) return Number(text);
    await Bun.sleep(20);
  }
  throw new Error("kein Kind");
}

describe("job list", () => {
  test("laufende Jobs und die letzten 20 beendeten, neueste zuerst, Titel ohne Geheimnisse", async () => {
    const { root: listRoot, cleanup: done } = tempRoot("jobs-list-");
    try {
      const deps = fakeDeps(listRoot, { secrets: ["geheim-123456"] });
      expect(await formatJobList(deps)).toBe("Keine Hintergrund-Jobs.");
      const running = await makeJob({ title: "Läuft mit geheim-123456", startedAt: new Date(Date.now() - 65 * 60_000).toISOString() }, listRoot);
      const ended: string[] = [];
      for (let i = 0; i < 25; i++) {
        ended.push(
          await makeJob(
            { phase: "ended", outcome: i % 2 ? "success" : "failed", title: `Fertig ${i}`, endedAt: new Date(Date.UTC(2026, 8, 25, 10, i)).toISOString(), notice: { state: "sent", attempts: 1 } },
            listRoot,
          ),
        );
      }
      const text = await formatJobList(deps);
      expect(text).toContain(`${running} · Läuft mit [verborgen] · läuft · 1 Std 5 Min`);
      expect(text).not.toContain("geheim-123456");
      expect(text).toContain("Laufend (1):");
      expect(text).toContain("Zuletzt beendet:");
      for (let i = 5; i < 25; i++) expect(text).toContain(`Fertig ${i} ·`);
      for (let i = 0; i < 5; i++) expect(text).not.toContain(`Fertig ${i} ·`);
      expect(text.indexOf("Fertig 24")).toBeLessThan(text.indexOf("Fertig 23"));
      expect(text).toContain("Fertig 24 · fehlgeschlagen");
      expect(text).toContain("Fertig 23 · fertig");
    } finally {
      done();
    }
  });
});

describe("job stop", () => {
  test("beendet den ganzen Prozessbaum und meldet genau einmal „gestoppt“; der Wächter schweigt", async () => {
    const id = await makeJob({ phase: "starting" });
    const deps = fakeDeps(root);
    deps.proc = realProcessOps;
    let treePid = 0;
    deps.spawnClaude = spec => {
      const child = realTree(spec.id);
      treePid = child.pid;
      return child;
    };
    const watcher = runWatcher(id, deps);
    for (let i = 0; i < 100 && (await readStatus(root, id))?.phase !== "running"; i++) await Bun.sleep(20);
    const kid = await childPid(id);
    expect(realProcessOps.alive(kid)).toBe(true);

    const result = await stopJob(id, deps);
    expect(result).toMatchObject({ ok: true, tree: "gone", message: `Job ${id} gestoppt.` });
    expect(await watcher).toBe(0);
    for (const pid of [treePid, kid]) expect(realProcessOps.alive(pid)).toBe(false);
    expect(realProcessOps.groupAlive(treePid)).toBe(false);
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]).toMatchObject({ source: "job", topicId: 443, text: expect.stringContaining("Job gestoppt") });
    expect((await readStatus(root, id))!).toMatchObject({ outcome: "stopped", notice: { state: "sent" } });
  }, 20_000);

  test("zweimal stop, beendeter oder unbekannter Job: keine weitere Meldung", async () => {
    const id = await makeJob();
    const deps = fakeDeps(root);
    expect((await stopJob(id, deps)).ok).toBe(true);
    expect(await stopJob(id, deps)).toMatchObject({ ok: false, message: expect.stringContaining("schon beendet (gestoppt)") });
    expect(await stopJob("20260925-000000-ffffff", deps)).toMatchObject({ ok: false, message: expect.stringContaining("gibt es nicht") });
    expect(deps.sent).toHaveLength(1);
  });

  test("PID inzwischen neu vergeben (andere Startzeit): kein Signal an den fremden Prozess", async () => {
    const deps = fakeDeps(root);
    deps.procs.spawn(77_000);
    deps.procs.identities.set(77_000, "neuer Prozess");
    const id = await makeJob({ claude: { pid: 77_000, identity: "alter Prozess" } });
    const result = await stopJob(id, deps);
    expect(result.tree).toBe("foreign");
    expect(deps.procs.signals).toEqual([]);
    expect(deps.procs.alive(77_000)).toBe(true);
    expect(deps.sent).toHaveLength(1);
  });

  test("ausstehende Beendigung steht im Status, bevor ein Signal geht", async () => {
    const deps = fakeDeps(root);
    deps.procs.spawn(79_000);
    const id = await makeJob({ claude: { pid: 79_000, identity: "start-79000" } });
    const states: (string | undefined)[] = [];
    const signal = deps.procs.signalGroup.bind(deps.procs);
    deps.procs.signalGroup = (pgid, sig) => {
      states.push(JSON.parse(readFileSync(jobFile(root, id, "status"), "utf8")).termination?.state);
      return signal(pgid, sig);
    };
    expect((await stopJob(id, deps)).tree).toBe("gone");
    expect(states).toEqual(["pending"]);
    expect((await readStatus(root, id))!.termination).toEqual({ state: "done", result: "gone" });
  });

  test("Gruppe ignoriert SIGTERM: SIGKILL hinterher", async () => {
    const deps = fakeDeps(root);
    deps.procs.spawn(78_000);
    deps.procs.ignoresTerm.add(78_000);
    const id = await makeJob({ claude: { pid: 78_000, identity: "start-78000" } });
    expect((await stopJob(id, deps)).tree).toBe("gone");
    expect(deps.procs.signals.map(s => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("stop und Prozessende gleichzeitig: genau eine Meldung", async () => {
    for (let round = 0; round < 5; round++) {
      const id = await makeJob({ phase: "starting" });
      const deps = fakeDeps(root);
      let finish!: (v: { code: number | null; signal: string | null }) => void;
      deps.spawnClaude = spec => {
        writeFileSync(jobFile(root, spec.id, "report"), "Bericht");
        return fakeChild(deps.procs.spawn(60_000 + round), new Promise(r => (finish = r)));
      };
      const watcher = runWatcher(id, deps);
      for (let i = 0; i < 100 && (await readStatus(root, id))?.phase !== "running"; i++) await Bun.sleep(5);
      const stop = stopJob(id, deps);
      finish({ code: 0, signal: null });
      await Promise.all([watcher, stop]);
      expect(deps.sent).toHaveLength(1);
    }
  });
});

describe("Prozessidentität: nie blind anhand der PID signalisieren", () => {
  test("identity null: Zustand unbekannt (nicht tot), terminateGroup sendet nichts", async () => {
    const deps = fakeDeps(root);
    deps.procs.spawn(80_000);
    expect(checkProcess({ pid: 80_000, identity: null }, deps.procs)).toBe("unknown");
    expect(processGone({ pid: 80_000, identity: null }, deps.procs)).toBe(false);
    expect(processGone({ pid: 80_001, identity: null }, deps.procs)).toBe(true);
    expect(await terminateGroup({ pid: 80_000, identity: null }, deps.procs)).toBe("unverified");
    expect(deps.procs.signals).toEqual([]);
    expect(deps.procs.alive(80_000)).toBe(true);
  });

  test("Identitätsabfrage scheitert, obwohl der Prozess lebt: kein Signal", async () => {
    const deps = fakeDeps(root);
    deps.procs.spawn(80_100);
    deps.procs.identity = () => null;
    expect(checkProcess({ pid: 80_100, identity: "start-80100" }, deps.procs)).toBe("unknown");
    expect(processGone({ pid: 80_100, identity: "start-80100" }, deps.procs)).toBe(false);
    expect(await terminateGroup({ pid: 80_100, identity: "start-80100" }, deps.procs)).toBe("unverified");
    expect(deps.procs.signals).toEqual([]);
  });

  test("PID und Gruppe während der SIGTERM-Frist neu vergeben: kein SIGKILL an den fremden Prozess", async () => {
    const deps = fakeDeps(root);
    deps.procs.spawn(80_050);
    deps.procs.ignoresTerm.add(80_050);
    const sleep = deps.procs.sleep.bind(deps.procs);
    let swapped = false;
    deps.procs.sleep = async () => {
      // Der alte Prozess endet, ein fremder bekommt PID und Gruppen-ID
      if (!swapped) deps.procs.identities.set(80_050, "fremder Prozess");
      swapped = true;
      await sleep();
    };
    expect(await terminateGroup({ pid: 80_050, identity: "start-80050" }, deps.procs, { graceMs: 100, pollMs: 50 })).toBe("foreign");
    expect(deps.procs.signals).toEqual([{ pgid: 80_050, signal: "SIGTERM" }]);
    expect(deps.procs.alive(80_050)).toBe(true);
  });

  test("Identität während der SIGTERM-Frist nicht mehr prüfbar: kein SIGKILL", async () => {
    const deps = fakeDeps(root);
    deps.procs.spawn(80_060);
    deps.procs.ignoresTerm.add(80_060);
    const sleep = deps.procs.sleep.bind(deps.procs);
    deps.procs.sleep = async () => {
      deps.procs.identity = () => null;
      await sleep();
    };
    expect(await terminateGroup({ pid: 80_060, identity: "start-80060" }, deps.procs, { graceMs: 100, pollMs: 50 })).toBe("unverified");
    expect(deps.procs.signals.map(x => x.signal)).toEqual(["SIGTERM"]);
  });

  test("identity null, PID danach neu vergeben: stop und Aufräumen treffen den fremden Prozess nicht", async () => {
    const deps = fakeDeps(root);
    // Alter Eintrag ohne Startzeit; unter der PID lebt inzwischen ein fremder Prozess
    deps.procs.spawn(80_200);
    deps.procs.identities.set(80_200, "fremder Prozess");
    const stopped = await makeJob({ claude: { pid: 80_200, identity: null } });
    const result = await stopJob(stopped, deps);
    expect(result).toMatchObject({ ok: false, tree: "unverified", message: expect.stringContaining("kein Signal") });
    expect((await readStatus(root, stopped))!.termination).toEqual({ state: "done", result: "unverified" });
    expect(deps.sent[0].text).toContain("nicht sicher beenden");

    const { root: r, cleanup: done } = tempRoot("jobs-identity-");
    try {
      const other = fakeDeps(r);
      other.procs.spawn(80_200);
      other.procs.identities.set(80_200, "fremder Prozess");
      const orphan = await makeJob({ watcher: { pid: 80_201, identity: null }, claude: { pid: 80_200, identity: null } }, r);
      expect((await recoverJobs(other)).aborted).toEqual([orphan]);
      expect(other.procs.signals).toEqual([]);
      expect(other.procs.alive(80_200)).toBe(true);
    } finally {
      done();
    }
  });

  test("Wächter ohne eigene Startzeit: trägt sich nicht ein, startet kein Claude, meldet „nicht gestartet“", async () => {
    const id = await makeJob({ phase: "starting" });
    const deps = fakeDeps(root);
    const identity = deps.procs.identity.bind(deps.procs);
    deps.procs.identity = pid => (pid === process.pid ? null : identity(pid));
    expect(await runWatcher(id, deps)).toBe(0);
    expect(deps.spawned).toEqual([]);
    expect((await readStatus(root, id))!).toMatchObject({ outcome: "start_failed" });
    expect(deps.sent).toHaveLength(1);
  });
});

describe("job log", () => {
  test("ganzes Log, Werte aus .env verborgen; unbekannter Job: null", async () => {
    const id = await makeJob();
    await Bun.write(jobFile(root, id, "log"), "Start\nToken sk-test-abcdef123 benutzt\nEnde\n");
    const deps = fakeDeps(root, { secrets: ["sk-test-abcdef123"] });
    expect(await jobLog(id, deps)).toBe("Start\nToken [verborgen] benutzt\nEnde\n");
    expect(await jobLog("20260925-000000-eeeeee", deps)).toBeNull();
  });
});

describe("Bot-Start: verwaiste Jobs", () => {
  test("Wächter weg, Claude lebt noch: Claude beendet, genau eine Meldung „abgebrochen“; zweiter Lauf meldet nichts", async () => {
    const { root: r, cleanup: done } = tempRoot("jobs-recover-");
    try {
      const deps = fakeDeps(r);
      deps.procs.spawn(90_001);
      const orphan = await makeJob({ watcher: { pid: 90_000, identity: "start-90000" }, claude: { pid: 90_001, identity: "start-90001" } }, r);
      await Bun.write(jobFile(r, orphan, "log"), "letzte Zeile vor dem Absturz\n");
      deps.procs.spawn(91_000);
      const alive = await makeJob({ watcher: { pid: 91_000, identity: "start-91000" } }, r);
      const fresh = await makeJob({ phase: "starting", createdAt: new Date().toISOString() }, r);
      const stale = await makeJob({ phase: "starting" }, r);
      // Wächter-PID neu vergeben: gilt als tot
      deps.procs.spawn(92_000);
      deps.procs.identities.set(92_000, "anderer");
      const reused = await makeJob({ watcher: { pid: 92_000, identity: "start-92000" } }, r);

      const [a, b] = await Promise.all([recoverJobs(deps), recoverJobs(deps)]);
      expect([...a.aborted, ...b.aborted].sort()).toEqual([orphan, stale, reused].sort());
      expect(deps.procs.alive(90_001)).toBe(false);
      expect(deps.sent).toHaveLength(3);
      const orphanText = deps.sent.find(s => s.text!.includes("Job 1"))?.text ?? deps.sent.map(s => s.text).join("\n");
      expect(orphanText).toContain("Job abgebrochen");
      expect(deps.sent.map(s => s.text).join("\n")).toContain("letzte Zeile vor dem Absturz");
      expect((await readStatus(r, alive))!.phase).toBe("running");
      expect((await readStatus(r, fresh))!.phase).toBe("starting");

      const again = await recoverJobs(deps);
      expect(again).toEqual({ aborted: [], resent: [], deferred: [fresh] });
      expect(deps.sent).toHaveLength(3);
    } finally {
      done();
    }
  });

  test("Absturzfenster: Absender starb mitten im Versand, Meldung wird genau einmal nachgeholt", async () => {
    const { root: r, cleanup: done } = tempRoot("jobs-resend-");
    try {
      const deps = fakeDeps(r);
      const base = { phase: "ended" as const, outcome: "success" as const, endedAt: new Date().toISOString() };
      const sending = await makeJob({ ...base, notice: { state: "sending", attempts: 1, owner: { pid: 93_000, identity: "x", token: "t1" } } }, r);
      await Bun.write(jobFile(r, sending, "report"), "Bericht nach Absturz");
      const pending = await makeJob({ ...base, notice: { state: "pending", attempts: 0, owner: { pid: 93_001, identity: null, token: "t2" } } }, r);
      await Bun.write(jobFile(r, pending, "report"), "Bericht");
      deps.procs.spawn(93_002);
      const ownerAlive = await makeJob({ ...base, notice: { state: "sending", attempts: 1, owner: { pid: 93_002, identity: "start-93002", token: "t3" } } }, r);
      const done1 = await makeJob({ ...base, notice: { state: "sent", attempts: 1 } }, r);
      const failed = await makeJob({ ...base, notice: { state: "failed", attempts: 3 } }, r);

      const [a, b] = await Promise.all([recoverJobs(deps), recoverJobs(deps)]);
      expect([...a.resent, ...b.resent].sort()).toEqual([sending, pending].sort());
      expect(deps.sent).toHaveLength(2);
      expect(deps.sent.map(s => s.text).join("\n")).toContain("Bericht nach Absturz");
      expect((await readStatus(r, ownerAlive))!.notice?.state).toBe("sending");
      expect((await readStatus(r, done1))!.notice?.state).toBe("sent");
      expect((await readStatus(r, failed))!.notice?.state).toBe("failed");
      expect(await recoverJobs(deps)).toEqual({ aborted: [], resent: [], deferred: [] });
      expect(deps.sent).toHaveLength(2);
    } finally {
      done();
    }
  });

  test("Absturzfenster: stop starb nach dem gewonnenen Abschluss, vor dem Beenden; Aufräumen beendet erst den Baum (echter sh), dann meldet es", async () => {
    const id = await makeJob({ phase: "running" });
    const tree = realTree(id);
    tree.releaseNow();
    const kid = await childPid(id);
    const identity = realProcessOps.identity(tree.pid);
    expect(identity).not.toBeNull();
    await writeStatus(root, { ...(await readStatus(root, id))!, claude: { pid: tree.pid, identity } });
    // Der stoppende Prozess (hier: gleiche PID, andere Startzeit, gilt also als tot) gewinnt und stirbt
    const claim = await claimOutcome(root, id, "stopped", { pid: process.pid, identity: "toter Stopper" }, { terminate: true });
    expect(claim.claimed).toBe(true);
    expect((await readStatus(root, id))!.termination).toEqual({ state: "pending" });
    expect(realProcessOps.alive(kid)).toBe(true);

    const aliveAtNotice: boolean[] = [];
    const deps = fakeDeps(root, {
      notify: async input => {
        if (input.text!.includes(id)) aliveAtNotice.push(realProcessOps.groupAlive(tree.pid) || realProcessOps.alive(kid));
        return { sent: true, recorded: true };
      },
    });
    deps.proc = realProcessOps;
    const summary = await recoverJobs(deps);
    expect(summary.resent).toContain(id);
    expect(aliveAtNotice).toEqual([false]);
    for (const pid of [tree.pid, kid]) expect(realProcessOps.alive(pid)).toBe(false);
    expect(deps.sent.filter(s => s.text!.includes(id))).toHaveLength(1);
    expect(deps.sent.find(s => s.text!.includes(id))!.text).toContain("Job gestoppt");
    expect((await readStatus(root, id))!).toMatchObject({ termination: { state: "done", result: "gone" }, notice: { state: "sent" } });
    expect(await recoverJobs(deps)).toEqual({ aborted: [], resent: [], deferred: [] });
  }, 20_000);

  test("Absturzfenster mit Attrappe: Zeitüberschreitung gewonnen, Wächter tot; Aufräumen beendet, dann Meldung", async () => {
    const { root: r, cleanup: done } = tempRoot("jobs-timeout-crash-");
    try {
      const deps = fakeDeps(r);
      deps.procs.spawn(81_000);
      const id = await makeJob({ watcher: { pid: 81_999, identity: "start-81999" }, claude: { pid: 81_000, identity: "start-81000" } }, r);
      await claimOutcome(r, id, "timeout", { pid: 81_999, identity: "start-81999" }, { terminate: true, detail: "Nach 6 Std beendet." });
      const order: string[] = [];
      const signal = deps.procs.signalGroup.bind(deps.procs);
      deps.procs.signalGroup = (pgid, sig) => (order.push(`signal ${sig}`), signal(pgid, sig));
      const notify = deps.notify.bind(deps);
      deps.notify = input => (order.push("meldung"), notify(input));
      expect((await recoverJobs(deps)).resent).toEqual([id]);
      expect(order).toEqual(["signal SIGTERM", "meldung"]);
      expect(deps.procs.alive(81_000)).toBe(false);
      expect(deps.sent[0].text).toContain("Zeit überschritten");
    } finally {
      done();
    }
  });

  test("junger Start ohne Wächter-Eintrag (Starter und Wächter tot, Bot startet innerhalb der Schonfrist): nach Ablauf genau eine Abbruchmeldung", async () => {
    const { root: r, cleanup: done } = tempRoot("jobs-young-");
    try {
      let clock = Date.parse("2026-09-25T12:00:00Z");
      const deps = fakeDeps(r, { now: () => new Date(clock) });
      const waits: number[] = [];
      deps.sleep = async ms => {
        waits.push(ms);
        clock += ms;
      };
      const id = await makeJob({ phase: "starting", createdAt: new Date(clock - 10_000).toISOString() }, r);
      expect(await recoverJobsUntilSettled(deps)).toEqual({ aborted: [id], resent: [] });
      expect(waits).toHaveLength(1);
      expect(waits[0]).toBeGreaterThanOrEqual(STARTING_GRACE_MS - 10_000);
      expect(deps.sent).toHaveLength(1);
      expect(deps.sent[0].text).toContain("Job abgebrochen");
      expect(deps.sent[0].topicId).toBe(443);
      expect(await recoverJobsUntilSettled(deps)).toEqual({ aborted: [], resent: [] });
      expect(deps.sent).toHaveLength(1);
    } finally {
      done();
    }
  });

  test("junger Start, dessen Wächter sich in der Schonfrist einträgt: keine Meldung", async () => {
    const { root: r, cleanup: done } = tempRoot("jobs-young-ok-");
    try {
      let clock = Date.parse("2026-09-25T12:00:00Z");
      const deps = fakeDeps(r, { now: () => new Date(clock) });
      const id = await makeJob({ phase: "starting", createdAt: new Date(clock).toISOString() }, r);
      deps.sleep = async ms => {
        clock += ms;
        deps.procs.spawn(95_000);
        await writeStatus(r, { ...(await readStatus(r, id))!, phase: "running", watcher: { pid: 95_000, identity: "start-95000" } });
      };
      expect(await recoverJobsUntilSettled(deps)).toEqual({ aborted: [], resent: [] });
      expect(deps.sent).toEqual([]);
    } finally {
      done();
    }
  });

  test("lebender Wächter, Startzeit gerade nicht abfragbar: gilt nicht als tot, keine Meldung", async () => {
    const { root: r, cleanup: done } = tempRoot("jobs-live-watcher-");
    try {
      const deps = fakeDeps(r);
      deps.procs.spawn(96_000);
      deps.procs.spawn(96_001);
      const id = await makeJob({ watcher: { pid: 96_000, identity: "start-96000" }, claude: { pid: 96_001, identity: "start-96001" } }, r);
      const noStart = await makeJob({ watcher: { pid: 96_001, identity: null } }, r);
      const identity = deps.procs.identity.bind(deps.procs);
      deps.procs.identity = pid => (pid === 96_000 ? null : identity(pid));
      expect(await recoverJobs(deps)).toEqual({ aborted: [], resent: [], deferred: [] });
      expect(deps.sent).toEqual([]);
      expect(deps.procs.signals).toEqual([]);
      for (const job of [id, noStart]) expect((await readStatus(r, job))!.phase).toBe("running");
    } finally {
      done();
    }
  });

  for (const variant of ["identity null", "Abfrage scheitert vorübergehend"] as const) {
    test(`konkurrierende Aufräumläufe während eines laufenden Versands (${variant}): genau eine Meldung`, async () => {
      const { root: r, cleanup: done } = tempRoot("jobs-live-sender-");
      try {
        const deps = fakeDeps(r);
        deps.procs.spawn(94_000);
        const owner = variant === "identity null" ? { pid: 94_000, identity: null } : { pid: 94_000, identity: "start-94000" };
        const id = await makeJob(
          { phase: "ended", outcome: "success", endedAt: new Date().toISOString(), notice: { state: "pending", attempts: 0, owner: { ...owner, token: "live" } } },
          r,
        );
        await Bun.write(jobFile(r, id, "report"), "Bericht");
        let release!: () => void;
        const gate = new Promise<void>(res => (release = res));
        let calls = 0;
        const notify = deps.notify.bind(deps);
        deps.notify = async input => {
          calls++;
          if (calls === 1) await gate;
          return notify(input);
        };
        const sending = (await import("../src/lib/jobs/notice")).deliverNotice(id, "live", deps);
        for (let i = 0; i < 100 && (await readStatus(r, id))?.notice?.state !== "sending"; i++) await Bun.sleep(5);
        expect((await readStatus(r, id))!.notice?.state).toBe("sending");

        const identity = deps.procs.identity.bind(deps.procs);
        if (variant !== "identity null") deps.procs.identity = pid => (pid === 94_000 ? null : identity(pid));
        const [a, b] = await Promise.all([recoverJobs(deps), recoverJobs(deps)]);
        expect([...a.resent, ...b.resent]).toEqual([]);
        deps.procs.identity = identity;

        release();
        expect(await sending).toBe("sent");
        expect(calls).toBe(1);
        expect(deps.sent).toHaveLength(1);
        expect((await readStatus(r, id))!.notice).toMatchObject({ state: "sent", owner: { token: "live" } });
      } finally {
        done();
      }
    });
  }

  test("src/bot.ts ruft recoverJobs beim Start auf (nur als Text geprüft)", () => {
    const bot = readFileSync(join(repo, "src", "bot.ts"), "utf8");
    expect(bot).toContain('import { recoverJobsUntilSettled } from "./lib/jobs/control";');
    expect(bot).toContain("recoverJobsUntilSettled(createJobDeps({ root: PROJECT_ROOT, env: process.env }))");
    // vor dem Polling, nicht erst in einem Handler
    expect(bot.indexOf("recoverJobsUntilSettled(createJobDeps")).toBeLessThan(bot.indexOf("bot.start({"));
  });
});

describe("/jobs in Telegram, Browser und Terminal", () => {
  const overview = "Laufend (1):\n- 20260925-140000-000001 · Recherche · läuft · 5 Min";
  const services = { jobsOverview: async () => overview } as unknown as CommandServices;

  test("im Register für alle drei Kanäle, in der Hilfe", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      expect(commandRegistry.match("/jobs", channel)?.command.name).toBe("jobs");
      expect(commandRegistry.match("/jobs x", channel)).toBeNull();
      expect(commandRegistry.list(channel).some(c => c.name === "jobs")).toBe(true);
    }
    expect(HELP_TEXT).toContain("/jobs");
  });

  test("Telegram: Übersicht als Klartext", async () => {
    const sent: { text: string; other?: unknown }[] = [];
    await runTelegramCommand({
      chat: { reply: async (text, other) => void sent.push({ text, other }) },
      chatId: "-1001",
      topicId: 3,
      sessionKey: "topic:-1001:3",
      agent: "general",
      text: "/jobs",
      match: commandRegistry.match("/jobs", "telegram")!,
      services,
      working: () => () => {},
      resetSession: async () => ({ status: "unavailable" }),
      agentTurn: async () => {},
      boardMeeting: async () => {},
    });
    expect(sent).toEqual([{ text: overview, other: undefined }]);
  });

  test("Telegram: lange Liste (viele laufende, 20 beendete, Titel mit 200 Zeichen) in zulässigen Stücken, kein Eintrag fehlt", async () => {
    const { root: r, cleanup: done } = tempRoot("jobs-list-long-");
    try {
      const ids: string[] = [];
      const longTitle = (i: number) => `${String(i).padStart(3, "0")} ${"Wärmepumpen & Förderung ".repeat(10)}`.slice(0, 200);
      for (let i = 0; i < 45; i++) ids.push(await makeJob({ title: longTitle(i), phase: "running" }, r));
      for (let i = 0; i < 25; i++) {
        const id = await makeJob({ title: longTitle(100 + i), phase: "ended", outcome: "failed", endedAt: new Date(Date.now() - i * 60_000).toISOString() }, r);
        if (i < 20) ids.push(id);
      }
      const jobsOverview = () => formatJobList({ root: r, now: () => new Date(), secrets: () => [] });
      const sent: string[] = [];
      await runTelegramCommand({
        chat: { reply: async text => void sent.push(text) },
        chatId: "-1001",
        sessionKey: "topic:-1001:3",
        agent: "general",
        text: "/jobs",
        match: commandRegistry.match("/jobs", "telegram")!,
        services: { jobsOverview } as unknown as CommandServices,
        working: () => () => {},
        resetSession: async () => ({ status: "unavailable" }),
        agentTurn: async () => {},
        boardMeeting: async () => {},
      });
      expect(sent.length).toBeGreaterThan(1);
      for (const part of sent) expect(part.length).toBeLessThanOrEqual(4096);
      const all = sent.join("\n");
      for (const id of ids) expect(all.split(id).length - 1).toBe(1);
      // Jeder Eintrag bleibt ganz in einem Stück
      const lines = sent.flatMap(part => part.split("\n")).filter(l => l.startsWith("- "));
      expect(lines).toHaveLength(65);
      for (const line of lines) expect(line).toMatch(/^- \d{8}-\d{6}-[0-9a-f]{6} · \d{3} .+ · (läuft|fehlgeschlagen) · .+$/);
      expect(all).toContain("Laufend (45):");
      expect(all).toContain("Zuletzt beendet:");
    } finally {
      done();
    }
  });

  for (const source of ["web", "terminal"] as const) {
    test(`${source}: Übersicht im Gespräch`, async () => {
      const unused = () => {
        throw new Error("nicht erwartet");
      };
      const commands = createBotCommands({
        registry: commandRegistry,
        services,
        groupId: () => null,
        agentForTopic: () => undefined,
        sendPlain: unused,
        sendAndRecord: unused,
        saveMessage: async () => true,
        resetConversation: unused,
        runStreamingTurn: unused,
        processIntents: unused,
        sendAsAgent: unused,
        log: () => {},
      });
      const notices: string[] = [];
      const outcome = await commands.run({
        conversationId: "abc123",
        agent: "general",
        text: "/jobs",
        source,
        messageId: "m1",
        receivedAt: new Date().toISOString(),
        signal: new AbortController().signal,
        sink: {} as any,
        notice: async text => void notices.push(text),
        answer: async () => {},
        ask: async () => {},
        endAsk: () => {},
        commit: () => {},
      });
      expect(outcome).toEqual({});
      expect(notices).toEqual([overview]);
    });
  }
});

describe("/jobs in der WebUI: Titel ohne Werte aus .env", () => {
  const secrets = ["synth-token-123456", "synth+key/123=456"];

  /** /jobs aus dem Browser: Liste aus dem Job-Speicher, Meldung wie chat.ts sie speichert und als HTML ausliefert */
  async function webJobs(jobRoot: string) {
    const unused = () => {
      throw new Error("nicht erwartet");
    };
    const jobsOverview = () => formatJobList({ root: jobRoot, now: () => new Date(), secrets: () => secrets });
    const commands = createBotCommands({
      registry: commandRegistry,
      services: { jobsOverview } as unknown as CommandServices,
      groupId: () => null,
      agentForTopic: () => undefined,
      sendPlain: unused,
      sendAndRecord: unused,
      saveMessage: async () => true,
      resetConversation: unused,
      runStreamingTurn: unused,
      processIntents: unused,
      sendAsAgent: unused,
      log: () => {},
    });
    const notices: string[] = [];
    await commands.run({
      conversationId: "abc123",
      agent: "general",
      text: "/jobs",
      source: "web",
      messageId: "m1",
      receivedAt: new Date().toISOString(),
      signal: new AbortController().signal,
      sink: {} as any,
      notice: async text => void notices.push(text),
      answer: async () => {},
      ask: async () => {},
      endAsk: () => {},
      commit: () => {},
    });
    expect(notices).toHaveLength(1);
    const message = toApiMessage({ id: "n1", role: "assistant", kind: "notice", source: "befehl", text: notices[0], createdAt: new Date().toISOString() });
    const html = message.html!;
    const attributes: string[] = [];
    new Parser({ onattribute: (_name, value) => void attributes.push(value) }).end(html);
    return { text: notices[0], html, visible: textContent(parseDocument(html)), attributes, terminal: renderTerminalMarkdown(notices[0], createStyle(false)) };
  }

  test("Steuer-Tags, Markdown, Links und Zeichenreferenzen im Titel: der Titel wird verborgen, harmlose bleiben", async () => {
    const { root: r, cleanup: done } = tempRoot("jobs-list-web-");
    try {
      const leaking = [
        "synth-token-[REMEMBER:x]123456",
        "synth-token-[GOAL: y]123456",
        "synth-token-**123456**",
        "synth-token-__123456__",
        "[synth-token-](https://example.com)123456",
        "synth-token&#45;123456",
        "synth&plus;key&sol;123&equals;456",
      ];
      for (const title of leaking) await makeJob({ title }, r);
      // Harmlos: in der Link-Adresse schreibt die WebUI & als &amp;, der Browser zeigt die Referenz wörtlich
      await makeJob({ title: "[t](https://example.com/synth&plus;key&sol;123&equals;456)" }, r);
      await makeJob({ title: "Recherche **Wärmepumpen**", phase: "ended", outcome: "success", endedAt: new Date().toISOString() }, r);
      const result = await webJobs(r);
      for (const view of [result.text, result.visible, result.terminal, ...result.attributes]) {
        for (const v of secrets) expect(view).not.toContain(v);
      }
      expect(result.visible.split("[verborgen]").length - 1).toBe(leaking.length);
      expect(result.visible).toContain("Recherche Wärmepumpen · fertig");
      expect(result.attributes).toContain("https://example.com/synth&plus;key&sol;123&equals;456");
    } finally {
      done();
    }
  });
});

describe("Befehlseinstiege: bun run job und tybo job", () => {
  /** Nur PATH und HOME: kein Telegram-Token, kein fremdes Gespräch */
  const env = (jobRoot: string, extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TYBO_ROOT: jobRoot,
    ...extra,
  });

  test("package.json: job-Skript über scripts/job.ts ohne .env des Aufrufers", () => {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    expect(pkg.scripts.job).toBe("bun --no-env-file scripts/job.ts");
  });

  test("bun run job list und tybo job list: leere Liste; falscher Aufruf: Exit 2", async () => {
    const { root: r, cleanup: done } = tempRoot("jobs-cli-");
    try {
      const run = async (cmd: string[]) => {
        const p = Bun.spawn({ cmd, cwd: repo, env: env(r), stdout: "pipe", stderr: "pipe" });
        return { code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
      };
      const viaScript = await run(["bun", "run", "job", "list"]);
      expect(viaScript).toMatchObject({ code: 0, out: expect.stringContaining("Keine Hintergrund-Jobs.") });
      const viaTybo = await run([process.execPath, "--no-env-file", "scripts/tybo.ts", "job", "list"]);
      expect(viaTybo).toMatchObject({ code: 0, out: "Keine Hintergrund-Jobs.\n" });
      expect((await run([process.execPath, "--no-env-file", "scripts/tybo.ts", "job", "stop", "../x"])).code).toBe(2);
      expect((await run([process.execPath, "--no-env-file", "scripts/tybo.ts", "job"])).code).toBe(2);
    } finally {
      done();
    }
  }, 30_000);

  test("Ende zu Ende mit Claude-Attrappe: losgelöster Wächter, Bericht, Meldung ohne Telegram abgelehnt", async () => {
    const { root: r, cleanup: done } = tempRoot("jobs-e2e-");
    try {
      // Direktchat bekannt, aber kein Token: sendAndRecord lehnt ab, bevor irgendetwas ins Netz geht
      writeFileSync(join(r, ".env"), "TELEGRAM_USER_ID=4242\n");
      const fake = join(r, "fake-claude.sh");
      writeFileSync(fake, `#!/bin/sh\ncat > auftrag-gelesen.txt\necho "Attrappe arbeitet"\nprintf 'Alles erledigt.' > "data/jobs/$TYBO_JOB_ID/report.md"\n`);
      chmodSync(fake, 0o755);
      const p = Bun.spawn({
        cmd: [process.execPath, "--no-env-file", "scripts/tybo.ts", "job", "start", "--title", "E2E", "--text", "Tu so als ob."],
        cwd: repo,
        env: env(r, { CLAUDE_PATH: fake }),
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await p.exited;
      const out = await new Response(p.stdout).text();
      expect(code).toBe(0);
      const id = /Job (\S+) (läuft|startet)/.exec(out)![1];
      let status: JobStatus | null = null;
      for (let i = 0; i < 200; i++) {
        status = await readStatus(r, id);
        if (status?.notice?.state === "failed" || status?.notice?.state === "sent") break;
        await Bun.sleep(50);
      }
      expect(status).toMatchObject({ phase: "ended", outcome: "success", exitCode: 0, notice: { state: "failed", error: "TELEGRAM_BOT_TOKEN fehlt" } });
      expect(status!.watcher!.pid).not.toBe(p.pid);
      expect(readFileSync(join(r, "auftrag-gelesen.txt"), "utf8")).toContain(`Tu so als ob.\n\n---\nSchreibe am Ende einen kurzen Bericht nach data/jobs/${id}/report.md`);
      expect(readFileSync(jobFile(r, id, "log"), "utf8")).toContain("Attrappe arbeitet");
    } finally {
      done();
    }
  }, 30_000);
});
