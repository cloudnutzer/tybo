/**
 * Issue #511: Zustand der SIP-Vermittlung (SSH-Attrappe) und Meldung bei
 * verlorener Registrierung: Ausfall, Wiederholung, Neustart, Erholung und
 * erneuter Ausfall, jeweils mit gespeichertem Zustand in einem Testordner.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateSipRelay } from "../src/health-check";
import { sipRelayCheck } from "../src/setup/checks/specials";
import { describeStatus, fetchRelayStatus, parseStatusOutput, relayConfig, sshCommand, type CommandRunner, type RunResult } from "../src/lib/sip-relay/status";
import { evaluateWatch, FAILURE_THRESHOLD, INITIAL_STATE, readWatchState, statePath } from "../src/lib/sip-relay/watch";
import { runSipWatch, type SipWatchDeps } from "../src/sip-zustand";

const ENV = { SIP_VERMITTLUNG_SSH: "zustand@sip.example.org", SIP_VERMITTLUNG_SSH_KEY: "/schluessel/tybo-sip" };

const output = (status: string, last = "2026-11-06T09:50:00Z", calls = "0") =>
  `version=1\nzeit=2026-11-06T10:00:00Z\nstatus=${status}\nletzte_registrierung=${last}\ngespraeche=${calls}\n`;

function runner(...replies: (Partial<RunResult> | Error)[]): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (cmd: string[]) => {
    calls.push(cmd);
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    if (reply instanceof Error) throw reply;
    return { code: 0, stdout: "", timedOut: false, ...reply };
  }) as CommandRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

describe("Zustandsabfrage", () => {
  test("ohne SIP_VERMITTLUNG_SSH: nicht eingerichtet, kein Aufruf", async () => {
    const run = runner({ stdout: output("Registered") });
    expect(await fetchRelayStatus({}, run)).toEqual({ state: "nicht-eingerichtet" });
    expect(run.calls).toHaveLength(0);
    expect(relayConfig({ SIP_VERMITTLUNG_SSH: "  " })).toBeNull();
  });

  test("SSH nur mit Schlüssel, ohne Nachfrage, Ziel nach --", () => {
    const cmd = sshCommand(relayConfig(ENV)!);
    expect(cmd).toEqual([
      "ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes",
      "-i", "/schluessel/tybo-sip", "-o", "IdentitiesOnly=yes", "--", "zustand@sip.example.org", "zustand",
    ]);
    expect(relayConfig({ SIP_VERMITTLUNG_SSH: "a@b", SIP_VERMITTLUNG_SSH_KEY: "~/.ssh/k" })!.keyPath).not.toStartWith("~");
  });

  test("registriert, nicht registriert, gestoppt", async () => {
    expect(await fetchRelayStatus(ENV, runner({ stdout: output("Registered", "2026-11-06T10:00:00Z", "1") }))).toEqual({
      state: "registriert", registration: "Registered", lastRegistered: "2026-11-06T10:00:00Z", calls: 1,
    });
    expect((await fetchRelayStatus(ENV, runner({ stdout: output("Rejected") }))).state).toBe("nicht-registriert");
    const stopped = await fetchRelayStatus(ENV, runner({ stdout: output("gestoppt", "", "") }));
    expect(stopped).toEqual({ state: "nicht-registriert", registration: "gestoppt", lastRegistered: null, calls: null });
  });

  test("unerreichbar: Zeitlimit, SSH-Fehler, Startfehler, falsches Format", async () => {
    expect(await fetchRelayStatus(ENV, runner({ timedOut: true, code: -1 }), 15_000)).toEqual({ state: "unerreichbar", reason: "keine Antwort nach 15 s" });
    expect(await fetchRelayStatus(ENV, runner({ code: 255 }))).toEqual({ state: "unerreichbar", reason: "SSH endete mit 255" });
    expect(await fetchRelayStatus(ENV, runner(new Error("ENOENT")))).toEqual({ state: "unerreichbar", reason: "SSH nicht ausführbar" });
    expect(await fetchRelayStatus(ENV, runner({ stdout: "Permission denied" }))).toEqual({ state: "unerreichbar", reason: "Antwort im falschen Format" });
    expect(parseStatusOutput("version=2\nstatus=Registered")).toBeNull();
  });

  test("Beschreibung nennt den letzten Zeitpunkt, nie das Ziel", () => {
    const now = Date.parse("2026-11-06T10:30:00Z");
    expect(describeStatus({ state: "nicht-registriert", registration: "Rejected", lastRegistered: "2026-11-06T10:00:00Z" }, now)).toBe(
      "nicht registriert (Rejected), zuletzt registriert 2026-11-06 10:00 UTC (vor 30 min)"
    );
    expect(describeStatus({ state: "nicht-registriert", registration: "gestoppt", lastRegistered: null }, now)).toContain("noch nie registriert gesehen");
    expect(describeStatus({ state: "registriert", calls: 2 })).toBe("bei easybell registriert, 2 Gespräch(e)");
  });
});

describe("Einmal-Meldung", () => {
  const down = { state: "nicht-registriert" as const, registration: "Rejected", lastRegistered: null };
  const up = { state: "registriert" as const, registration: "Registered", lastRegistered: "2026-11-06T10:00:00Z" };
  const t = new Date("2026-11-06T10:00:00Z");

  test("erst ab der zweiten Fehlabfrage, dann nie wieder bis zur Erholung", () => {
    expect(FAILURE_THRESHOLD).toBe(2);
    const first = evaluateWatch(INITIAL_STATE, down, t);
    expect(first.message).toBeNull();
    expect(first.next).toEqual({ version: 1, failures: 1, alerted: false, since: t.toISOString() });
    const second = evaluateWatch(first.next, down, new Date(t.getTime() + 600_000));
    expect(second.message).toContain("nicht bei easybell registriert");
    expect(second.next.alerted).toBe(true);
    expect(second.next.since).toBe(t.toISOString());
    const third = evaluateWatch(second.next, { state: "unerreichbar", reason: "x" }, t);
    expect(third.message).toBeNull();
    const back = evaluateWatch(third.next, up, t);
    expect(back.message).toContain("wieder bei easybell registriert");
    expect(back.next).toEqual(INITIAL_STATE);
  });

  test("ein einzelner Aussetzer meldet nichts, auch keine Entwarnung", () => {
    const once = evaluateWatch(INITIAL_STATE, { state: "unerreichbar", reason: "x" }, t);
    const ok = evaluateWatch(once.next, up, t);
    expect(once.message).toBeNull();
    expect(ok.message).toBeNull();
    expect(ok.next).toEqual(INITIAL_STATE);
  });

  test("nicht eingerichtet setzt zurück und meldet nichts", () => {
    expect(evaluateWatch({ version: 1, failures: 5, alerted: true, since: null }, { state: "nicht-eingerichtet" }, t)).toEqual({
      next: INITIAL_STATE, ifUndelivered: INITIAL_STATE, message: null,
    });
  });

  test("beschädigter oder fehlender Zustand gilt als Anfang", () => {
    const dir = mkdtempSync(join(tmpdir(), "sipw-"));
    try {
      expect(readWatchState(join(dir, "fehlt.json"))).toEqual(INITIAL_STATE);
      writeFileSync(join(dir, "kaputt.json"), "{");
      expect(readWatchState(join(dir, "kaputt.json"))).toEqual(INITIAL_STATE);
      writeFileSync(join(dir, "null.json"), "null");
      expect(readWatchState(join(dir, "null.json"))).toEqual(INITIAL_STATE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bun run sip-zustand", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sipz-"));
    path = statePath(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function deps(run: CommandRunner, sent: string[], deliver = true): SipWatchDeps {
    let clock = Date.parse("2026-11-06T10:00:00Z");
    return {
      env: ENV,
      now: () => new Date((clock += 600_000)),
      statePath: path,
      run,
      send: async text => {
        if (deliver) sent.push(text);
        return deliver;
      },
      write: async (p, content) => {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
      },
      log: () => {},
    };
  }

  test("Ausfall, Wiederholung, Neustart, Erholung, erneuter Ausfall: je genau eine Meldung", async () => {
    const sent: string[] = [];
    const rejected = runner({ stdout: output("Rejected") });
    const registered = runner({ stdout: output("Registered") });
    // Ausfall: erster Lauf still, zweiter meldet
    await runSipWatch(deps(rejected, sent), { send: true });
    expect(sent).toHaveLength(0);
    await runSipWatch(deps(rejected, sent), { send: true });
    expect(sent).toHaveLength(1);
    // Wiederholung
    await runSipWatch(deps(rejected, sent), { send: true });
    // Neustart: neue Abhängigkeiten, derselbe Zustand auf der Platte
    await runSipWatch(deps(runner({ code: 255 }), sent), { send: true });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8")).alerted).toBe(true);
    // Erholung
    await runSipWatch(deps(registered, sent), { send: true });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("wieder bei easybell registriert");
    await runSipWatch(deps(registered, sent), { send: true });
    expect(sent).toHaveLength(2);
    // erneuter Ausfall
    await runSipWatch(deps(rejected, sent), { send: true });
    await runSipWatch(deps(rejected, sent), { send: true });
    expect(sent).toHaveLength(3);
    expect(sent[2]).toContain("nicht bei easybell registriert");
    for (const text of sent) expect(text).not.toContain("sip.example.org");
  });

  test("nicht zugestellt: Exit 1, der nächste Lauf meldet erneut", async () => {
    const sent: string[] = [];
    const rejected = runner({ stdout: output("Rejected") });
    await runSipWatch(deps(rejected, sent), { send: true });
    const failed = await runSipWatch(deps(rejected, sent, false), { send: true });
    expect(failed.exitCode).toBe(1);
    expect(failed.state.alerted).toBe(false);
    const retried = await runSipWatch(deps(rejected, sent), { send: true });
    expect(retried.sent).not.toBeNull();
    expect(retried.exitCode).toBe(0);
  });

  test("--no-send: nichts senden, nichts speichern", async () => {
    const sent: string[] = [];
    const rejected = runner({ stdout: output("Rejected") });
    writeFileSync(join(dir, "x"), "");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, failures: 1, alerted: false, since: null }));
    const result = await runSipWatch(deps(rejected, sent), { send: false });
    expect(sent).toHaveLength(0);
    expect(JSON.parse(readFileSync(path, "utf8")).failures).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  test("Zustand nicht schreibbar: Exit 1", async () => {
    const d = deps(runner({ stdout: output("Registered") }), []);
    const result = await runSipWatch({ ...d, write: async () => { throw new Error("EACCES"); } }, { send: true });
    expect(result.exitCode).toBe(1);
  });
});

describe("Berichte", () => {
  test("Nachtcheck: – ohne Einrichtung, ✅ registriert, ❌ sonst mit Hinweis", () => {
    const now = Date.parse("2026-11-06T10:30:00Z");
    expect(evaluateSipRelay({ state: "nicht-eingerichtet" }, now)).toEqual({ name: "SIP-Vermittlung", status: "na", detail: "nicht eingerichtet" });
    expect(evaluateSipRelay({ state: "registriert", calls: 0 }, now).status).toBe("ok");
    const down = evaluateSipRelay({ state: "unerreichbar", reason: "SSH endete mit 255" }, now);
    expect(down.status).toBe("fail");
    expect(down.hint).toContain("deploy/sip-vermittlung/README.md");
  });

  test("tybo pruefen: liest nur über ctx.run, übersprungen ohne Einrichtung", async () => {
    const commands: string[][] = [];
    const ctx = {
      run: async (cmd: string[]) => {
        commands.push(cmd);
        return { code: 0, stdout: output("Unregistered"), stderr: "" };
      },
    };
    const skipped = await sipRelayCheck.run({ ctx: ctx as never, env: {}, statuses: new Map(), signal: new AbortController().signal });
    expect(skipped[0].status).toBe("skip");
    expect(commands).toHaveLength(0);
    const found = await sipRelayCheck.run({ ctx: ctx as never, env: ENV, statuses: new Map(), signal: new AbortController().signal });
    expect(found).toEqual([{ label: "SIP-Vermittlung", status: "fail", detail: expect.stringContaining("nicht registriert (Unregistered)") }]);
    expect(commands[0][0]).toBe("ssh");
  });
});
