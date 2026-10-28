/**
 * Issue #256: Weg "claude-cli" (offene Claude-Code-Sitzung je Gespräch).
 * Nur Spawn-Attrappen, die echte CLI startet nie.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  claudeCliArgs,
  claudeCliEnv,
  createClaudeCliBackend,
  missingCliFlags,
  CLI_REQUIRED_FLAGS,
  type CliProc,
  type CliRuntime,
} from "../src/lib/voice-brain/backends/claude-cli";
import { runVoiceTurn, type VoiceTurnEvent } from "../src/lib/voice-brain/turn";
import { abortAllEngineCalls, abortEngineCalls, activeEngineCallCount, registeredEngineCallCount } from "../src/lib/engines/calls";
import { subprocessEnv } from "../src/lib/subprocess-env";
import type { RunOutcome } from "../src/lib/spend/credit";
import type { BrainMessage } from "../src/lib/voice-brain/types";
import { withFailureLimit } from "../src/lib/voice-brain/call-model";

const HELP = CLI_REQUIRED_FLAGS.map((f) => `  ${f} <x>   Beschreibung`).join("\n");

/**
 * total: total_cost_usd des result-Ereignisses (null: fehlt); ohne Angabe je Turn 0,008 mehr. usage: wie gemeldet, fehlt sonst.
 * fail: ein Fehler-result mit subtype, is_error (fehlt ohne Angabe), result, errors und total_cost_usd (fehlt ohne Angabe)
 */
type Behavior =
  | { kind: "reply"; text: string[]; total?: number | null; usage?: Record<string, number> }
  | { kind: "fail"; subtype: string; isError?: boolean; result?: string; errors?: string[]; total?: number }
  | { kind: "hang"; text?: string[] }
  | { kind: "hang-silent" }
  | { kind: "crash"; after?: string[] };

/** Eine Attrappe der CLI: liest Zeilen auf stdin, antwortet nach Drehbuch */
class FakeProc implements CliProc {
  static nextPid = 1000;
  pid = FakeProc.nextPid++;
  lines: any[] = [];
  killed = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (code: number | null) => void;
  exited = new Promise<number | null>((r) => (this.resolveExit = r));
  stdout = new ReadableStream<Uint8Array>({ start: (c) => void (this.controller = c) });
  stderr = null;
  private cost = 0;
  private closed = false;
  constructor(
    readonly cmd: string[],
    readonly env: Record<string, string>,
    private script: Behavior[],
  ) {}
  stdin = {
    write: (chunk: string) => {
      for (const raw of chunk.split("\n").filter(Boolean)) {
        const msg = JSON.parse(raw);
        this.lines.push(msg);
        queueMicrotask(() => this.onLine(msg));
      }
    },
    flush: () => {},
    end: () => {},
  };
  private emit(ev: unknown) {
    if (!this.closed) this.controller.enqueue(new TextEncoder().encode(JSON.stringify(ev) + "\n"));
  }
  private delta(text: string) {
    this.emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  }
  private result(isError = false, subtype = "success", total?: number | null, usage?: Record<string, number>) {
    this.cost = total === undefined ? this.cost + 0.008 : total ?? this.cost;
    this.emit({ type: "result", subtype, is_error: isError, ...(total === null ? {} : { total_cost_usd: this.cost }), ...(usage ? { usage } : {}), result: "" });
  }
  private onLine(msg: any) {
    if (msg.type === "control_request") {
      if (this.pendingHang === "hang") {
        this.emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
        // Nach dem Unterbrechen noch ein verspätetes Stück, das nie ankommen darf
        this.delta("ALT ");
        this.result(true, "error_during_execution");
        this.pendingHang = null;
      }
      return;
    }
    const step = this.script.shift() ?? { kind: "reply", text: ["Gut."] };
    this.emit({ type: "system", subtype: "init" });
    if (step.kind === "reply") {
      for (const t of step.text) this.delta(t);
      this.emit({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Vordenken" } } });
      this.result(false, "success", step.total, step.usage);
    } else if (step.kind === "fail") {
      if (step.total !== undefined) this.cost = step.total;
      this.emit({
        type: "result",
        subtype: step.subtype,
        ...(step.isError === undefined ? {} : { is_error: step.isError }),
        ...(step.total === undefined ? {} : { total_cost_usd: step.total }),
        result: step.result ?? "",
        ...(step.errors ? { errors: step.errors } : {}),
      });
    } else if (step.kind === "hang" || step.kind === "hang-silent") {
      for (const t of (step.kind === "hang" && step.text) || ["Rom wurde "]) this.delta(t);
      this.pendingHang = step.kind;
    } else {
      for (const t of step.after ?? []) this.delta(t);
      this.exit(1);
    }
  }
  pendingHang: string | null = null;
  exit(code: number | null) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {}
    this.resolveExit(code);
  }
  kill() {
    this.killed = true;
    this.exit(null);
  }
}

function fakeRuntime(scripts: Behavior[][] = [], help: string | null = HELP) {
  const procs: FakeProc[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const runtime: CliRuntime = {
    spawn: (o) => {
      const p = new FakeProc(o.cmd, o.env, scripts.shift() ?? []);
      procs.push(p);
      return p;
    },
    terminate: (p) => (p as FakeProc).kill(),
    help: async () => help,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => void ((h as { cleared: boolean }).cleared = true),
  };
  return { runtime, procs, timers };
}

async function collect(gen: AsyncGenerator<VoiceTurnEvent>) {
  const events: VoiceTurnEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const segments = (events: VoiceTurnEvent[]) => events.filter((e) => e.type === "segment").map((e) => (e as { text: string }).text);
const last = (events: VoiceTurnEvent[]) => events[events.length - 1];
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function budget() {
  const log = { reserved: 0, settled: 0 };
  return { log, reserveRequest: () => (log.reserved++, () => void log.settled++) };
}

afterEach(() => {
  abortAllEngineCalls();
});

describe("Start der Sitzung", () => {
  test("Flags: safe-mode, ohne Werkzeuge, stream-json in beide Richtungen, Modell und Effort", () => {
    const args = claudeCliArgs({ model: "claude-sonnet-5-5", effort: "low", system: "S" });
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--include-partial-messages");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("S");
  });

  test("missingCliFlags findet fehlende Flags, aber nicht Teilstücke (--tools in --allowedTools)", () => {
    expect(missingCliFlags(HELP)).toEqual([]);
    const without = HELP.split("\n").filter((l) => !l.includes("--safe-mode") && !/--tools\b/.test(l)).join("\n") + "\n  --allowedTools <t>  x\n  --safe-mode-x  y";
    expect(missingCliFlags(without)).toEqual(["--safe-mode", "--tools"]);
  });

  test("fehlt ein Flag, startet kein Prozess und der Turn nennt den Grund", async () => {
    const { runtime, procs } = fakeRuntime([], HELP.replace("--safe-mode", "--other"));
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime });
    const events = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hallo" }));
    expect(procs).toHaveLength(0);
    expect(last(events)).toMatchObject({ type: "error", reason: "setup" });
    expect((last(events) as { message: string }).message).toContain("--safe-mode");
  });

  test("Umgebung: TYBO_SUBPROCESS=1, kein Geheimnis, auch nicht über Freigabe; API-Schlüssel nur im API-Modus", () => {
    const base = {
      PATH: "/bin",
      LANG: "de_DE.UTF-8",
      OPENROUTER_API_KEY: "or-geheim",
      TELEGRAM_BOT_TOKEN: "tg-geheim",
      MY_SERVICE_TOKEN: "freigegeben",
      SUPABASE_URL: "https://x",
      ANTHROPIC_API_KEY: "sk-alt",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    };
    const abo = claudeCliEnv("claude-sonnet-5-5", base, { PATH: "/bin" });
    expect(abo.TYBO_SUBPROCESS).toBe("1");
    expect(abo.LANG).toBe("de_DE.UTF-8");
    for (const name of ["OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN", "MY_SERVICE_TOKEN", "SUPABASE_URL", "ANTHROPIC_API_KEY"]) expect(abo[name]).toBeUndefined();
    // Anmeldung der CLI per Freigabe bleibt
    expect(abo.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth");
    expect(abo.MAX_THINKING_TOKENS).toBeUndefined();

    const api = claudeCliEnv("claude-haiku-5-5", base, { PATH: "/bin", ANTHROPIC_API_KEY: "sk-test" });
    expect(api.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(api.MAX_THINKING_TOKENS).toBe("0");
  });

  test("echte subprocessEnv mit Freigabeliste: die Sitzung bekommt die Freigabe trotzdem nicht", () => {
    const saved = { ...process.env };
    try {
      process.env.TYBO_SUBPROCESS_ENV_ALLOW = "MY_SERVICE_TOKEN";
      process.env.MY_SERVICE_TOKEN = "x";
      process.env.WEB_PASSWORD = "pw";
      const base = subprocessEnv({ home: "/nirgends" });
      expect(base.MY_SERVICE_TOKEN).toBe("x");
      const env = claudeCliEnv("claude-sonnet-5-5", base, { PATH: "/bin" });
      expect(env.MY_SERVICE_TOKEN).toBeUndefined();
      expect(env.WEB_PASSWORD).toBeUndefined();
      expect(env.TYBO_SUBPROCESS).toBe("1");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("Gespräch über eine Sitzung", () => {
  test("zwei Turns über denselben Prozess, je eine Zeile auf stdin, Kosten als Zuwachs", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "reply", text: ["Hallo Alex, ", "schön dich zu hören."] }, { kind: "reply", text: ["Morgen wird es sonnig."] }]]);
    const costs: (number | undefined)[] = [];
    const b = budget();
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, recordRun: (o) => costs.push(o.costUsd), reserveRequest: b.reserveRequest });
    const first = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hallo" }));
    expect(segments(first).join(" ")).toBe("Hallo Alex, schön dich zu hören.");
    expect(last(first)).toMatchObject({ type: "done", aborted: false });
    const second = await collect(
      runVoiceTurn({ backend, system: "S", history: [{ role: "user", content: "Hallo" }, { role: "assistant", content: "Hallo Alex, schön dich zu hören." }], userText: "Wetter?" }),
    );
    expect(segments(second)).toEqual(["Morgen wird es sonnig."]);
    expect(procs).toHaveLength(1);
    const users = procs[0].lines.filter((l) => l.type === "user");
    expect(users.map((u) => u.message.content[0].text)).toEqual(["Hallo", "Wetter?"]);
    expect(users[0]).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "Hallo" }] } });
    // total_cost_usd ist kumulativ (0,008 und 0,016): gebucht je 0,008
    expect(costs.map((c) => Math.round(c! * 1000) / 1000)).toEqual([0.008, 0.008]);
    expect(b.log).toEqual({ reserved: 2, settled: 2 });
    backend.close?.();
  });

  test("interrupt(): Steuerzeile, der Turn endet, die Sitzung bleibt, alte Stücke erreichen den nächsten Turn nie", async () => {
    const { runtime, procs, timers } = fakeRuntime([[{ kind: "hang" }, { kind: "reply", text: ["Paris ist die Hauptstadt."] }]]);
    const b = budget();
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, reserveRequest: b.reserveRequest });
    const ctrl = new AbortController();
    const turn = runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl von Rom", signal: ctrl.signal });
    const pending = collect(turn);
    await tick();
    ctrl.abort();
    const events = await pending;
    expect(last(events)).toMatchObject({ type: "done", aborted: true });
    const control = procs[0].lines.find((l) => l.type === "control_request");
    expect(control.request).toEqual({ subtype: "interrupt" });
    expect(typeof control.request_id).toBe("string");
    expect(timers.some((t) => t.ms === 2000)).toBe(true);

    const next = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hauptstadt von Frankreich?" }));
    expect(segments(next)).toEqual(["Paris ist die Hauptstadt."]);
    expect(segments(next).join(" ")).not.toContain("ALT");
    expect(procs).toHaveLength(1);
    expect(procs[0].killed).toBe(false);
    expect(b.log).toEqual({ reserved: 2, settled: 2 });
    backend.close?.();
  });

  test("zweimal interrupt() ohne Signal: kein Fehler, das Gespräch bleibt, der nächste Turn läuft im selben Prozess", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "hang" }, { kind: "hang" }, { kind: "reply", text: ["Paris ist die Hauptstadt."] }]]);
    const b = budget();
    const backend = withFailureLimit(createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, reserveRequest: b.reserveRequest }));
    for (const userText of ["Erzähl von Rom", "Erzähl von Athen"]) {
      const pending = collect(runVoiceTurn({ backend, system: "S", history: [], userText }));
      await tick();
      await backend.interrupt!();
      const events = await pending;
      expect(last(events)).toMatchObject({ type: "done", aborted: true });
    }
    const next = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hauptstadt von Frankreich?" }));
    expect(segments(next)).toEqual(["Paris ist die Hauptstadt."]);
    expect(last(next)).toMatchObject({ type: "done", aborted: false });
    expect(procs).toHaveLength(1);
    expect(procs[0].killed).toBe(false);
    expect(procs[0].lines.filter((l) => l.type === "control_request")).toHaveLength(2);
    expect(b.log).toEqual({ reserved: 3, settled: 3 });
    backend.close?.();
  });

  test("interrupt() ohne Signal nach dem ersten Abschnitt: gepufferte Stücke kommen nicht mehr, der nächste Turn läuft im selben Prozess", async () => {
    const { runtime, procs } = fakeRuntime([
      [{ kind: "hang", text: ["Rom wurde gegründet. ", "Dann kamen die Könige. ", "Später die Republik. "] }, { kind: "reply", text: ["Paris ist die Hauptstadt."] }],
    ]);
    const b = budget();
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, reserveRequest: b.reserveRequest });
    const turn = runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl von Rom", earlyFirst: false });
    const first = await turn.next();
    expect(first.value).toMatchObject({ type: "segment", text: "Rom wurde gegründet." });
    await backend.interrupt!();
    const rest: VoiceTurnEvent[] = [];
    for await (const e of turn) rest.push(e);
    expect(segments(rest)).toEqual([]);
    expect(last(rest)).toMatchObject({ type: "done", aborted: true });

    const next = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hauptstadt von Frankreich?" }));
    expect(segments(next)).toEqual(["Paris ist die Hauptstadt."]);
    expect(last(next)).toMatchObject({ type: "done", aborted: false });
    expect(procs).toHaveLength(1);
    expect(procs[0].killed).toBe(false);
    expect(b.log).toEqual({ reserved: 2, settled: 2 });
    backend.close?.();
  });

  test("interrupt() ohne Signal mitten in einem Textstück: kein weiterer Abschnitt daraus, der nächste Turn läuft im selben Prozess", async () => {
    const { runtime, procs } = fakeRuntime([
      [{ kind: "hang", text: ["Rom wurde gegründet. Dann kamen die Könige. Später die Republik. "] }, { kind: "reply", text: ["Paris ist die Hauptstadt."] }],
    ]);
    const b = budget();
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, reserveRequest: b.reserveRequest });
    const turn = runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl von Rom", earlyFirst: false });
    const first = await turn.next();
    expect(first.value).toMatchObject({ type: "segment", text: "Rom wurde gegründet." });
    await backend.interrupt!();
    const rest: VoiceTurnEvent[] = [];
    for await (const e of turn) rest.push(e);
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ type: "done", aborted: true, spokenText: "Rom wurde gegründet." });

    const next = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hauptstadt von Frankreich?" }));
    expect(segments(next)).toEqual(["Paris ist die Hauptstadt."]);
    expect(last(next)).toMatchObject({ type: "done", aborted: false });
    expect(procs).toHaveLength(1);
    expect(procs[0].killed).toBe(false);
    expect(b.log).toEqual({ reserved: 2, settled: 2 });
    backend.close?.();
  });

  test("Abbruch während der Flag-Prüfung: keine Sitzung, keine Äußerung, kein Budget", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "reply", text: ["Nie."] }]]);
    let releaseHelp!: (text: string) => void;
    runtime.help = () => new Promise<string | null>((r) => (releaseHelp = r));
    const b = budget();
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, reserveRequest: b.reserveRequest });
    const ctrl = new AbortController();
    const iterator = backend.stream({ system: "S", messages: [{ role: "user", content: "Hallo" }], signal: ctrl.signal });
    const first = iterator.next();
    first.catch(() => {});
    await tick();
    ctrl.abort();
    releaseHelp(HELP);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await tick();
    expect(procs).toHaveLength(0);
    expect(b.log).toEqual({ reserved: 0, settled: 0 });
    backend.close?.();
  });

  test("interrupt() während der Flag-Prüfung: keine Sitzung, keine Äußerung, kein Budget, done mit aborted", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "reply", text: ["Nie."] }]]);
    let releaseHelp!: (text: string) => void;
    runtime.help = () => new Promise<string | null>((r) => (releaseHelp = r));
    const b = budget();
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, reserveRequest: b.reserveRequest });
    const pending = collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hallo" }));
    await tick();
    await backend.interrupt!();
    releaseHelp(HELP);
    const events = await pending;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "done", aborted: true });
    await tick();
    expect(procs).toHaveLength(0);
    expect(b.log).toEqual({ reserved: 0, settled: 0 });
    backend.close?.();
  });

  test("interrupt() während der nächste Turn auf das Ende des vorigen Unterbrechens wartet: dieser Turn sendet nichts", async () => {
    const { runtime, procs, timers } = fakeRuntime([[{ kind: "hang-silent" }, { kind: "reply", text: ["Nie."] }]]);
    const b = budget();
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, reserveRequest: b.reserveRequest });
    const ctrl = new AbortController();
    const firstTurn = collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl", signal: ctrl.signal }));
    await tick();
    ctrl.abort();
    await firstTurn;
    const nextTurn = collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Und weiter?" }));
    await tick();
    void backend.interrupt!();
    timers.find((t) => t.ms === 2000 && !t.cleared)!.fn();
    const next = await nextTurn;
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ type: "done", aborted: true });
    expect(procs.flatMap((p) => p.lines.filter((l) => l.type === "user"))).toHaveLength(1);
    expect(b.log).toEqual({ reserved: 1, settled: 1 });
    backend.close?.();
  });

  test("Verbraucher hört nach dem ersten Abschnitt auf: Steuerzeile, Sitzung bleibt, nächster Turn im selben Prozess", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "hang", text: ["Rom wurde gegründet. Dann kamen die Könige. "] }, { kind: "reply", text: ["Paris ist die Hauptstadt."] }]]);
    const b = budget();
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, reserveRequest: b.reserveRequest });
    for await (const e of runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl von Rom", earlyFirst: false })) {
      expect(e).toMatchObject({ type: "segment", text: "Rom wurde gegründet." });
      break;
    }
    expect(procs[0].lines.filter((l) => l.type === "control_request")).toHaveLength(1);
    const next = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hauptstadt von Frankreich?" }));
    expect(segments(next)).toEqual(["Paris ist die Hauptstadt."]);
    expect(procs).toHaveLength(1);
    expect(b.log).toEqual({ reserved: 2, settled: 2 });
    backend.close?.();
  });

  test("kein result binnen 2 s nach dem Unterbrechen: Prozess beendet, nächster Turn startet neu mit Verlauf", async () => {
    const { runtime, procs, timers } = fakeRuntime([[{ kind: "hang-silent" }], [{ kind: "reply", text: ["Weiter geht es."] }]]);
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime });
    const ctrl = new AbortController();
    const pending = collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl", signal: ctrl.signal }));
    await tick();
    ctrl.abort();
    await pending;
    const grace = timers.find((t) => t.ms === 2000 && !t.cleared)!;
    expect(grace).toBeDefined();
    // Der nächste Turn wartet auf das Ende des Unterbrechens
    const history: BrainMessage[] = [{ role: "user", content: "Erzähl" }, { role: "assistant", content: "Rom wurde" }];
    const nextTurn = collect(runVoiceTurn({ backend, system: "S", history, userText: "Und weiter?" }));
    await tick();
    expect(procs).toHaveLength(1);
    grace.fn();
    const next = await nextTurn;
    expect(procs[0].killed).toBe(true);
    expect(procs).toHaveLength(2);
    expect(segments(next)).toEqual(["Weiter geht es."]);
    const system = procs[1].cmd[procs[1].cmd.indexOf("--system-prompt") + 1];
    expect(system).toContain("Nutzer: Erzähl");
    backend.close?.();
  });
});

describe("Absturz und /stop", () => {
  test("Absturz vor dem ersten Text: einmal neu starten, dieselbe Äußerung, Verlauf im System-Prompt", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "reply", text: ["Hallo."] }, { kind: "crash" }], [{ kind: "reply", text: ["Es ist drei Uhr."] }]]);
    const b = budget();
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, reserveRequest: b.reserveRequest });
    await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hi" }));
    const history: BrainMessage[] = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `Satz ${i}` }) as BrainMessage);
    const events = await collect(runVoiceTurn({ backend, system: "S", history, userText: "Wie spät?" }));
    expect(segments(events)).toEqual(["Es ist drei Uhr."]);
    expect(procs).toHaveLength(2);
    const system = procs[1].cmd[procs[1].cmd.indexOf("--system-prompt") + 1];
    expect(system.startsWith("S")).toBe(true);
    // höchstens 12 Äußerungen: Satz 2 bis Satz 13
    expect(system).not.toContain("Satz 1\n");
    expect(system).toContain("Satz 2");
    expect(system).toContain("Satz 13");
    expect(procs[1].lines.find((l) => l.type === "user").message.content[0].text).toBe("Wie spät?");
    expect(b.log).toEqual({ reserved: 3, settled: 3 });
    backend.close?.();
  });

  test("zweiter Absturz in Folge: Fehler an den Aufrufer, danach keine neue Sitzung", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "crash" }], [{ kind: "crash" }], [{ kind: "reply", text: ["nie"] }]]);
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime });
    const events = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hi" }));
    expect(last(events)).toMatchObject({ type: "error", reason: "network" });
    expect(procs).toHaveLength(2);
    const after = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hallo?" }));
    expect(last(after)).toMatchObject({ type: "error", reason: "ended" });
    expect(procs).toHaveLength(2);
  });

  test("Absturz nach gesprochenem Text: Turn endet mit Fehler (nichts doppelt), nächster Turn startet neu", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "crash", after: ["Morgen wird es sonnig. ", "Am Nach"] }], [{ kind: "reply", text: ["Wieder da."] }]]);
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime });
    const events = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Wetter?", earlyFirst: false }));
    expect(segments(events)).toEqual(["Morgen wird es sonnig."]);
    expect(last(events)).toMatchObject({ type: "error", reason: "network" });
    expect(procs).toHaveLength(1);
    const next = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hallo?" }));
    expect(segments(next)).toEqual(["Wieder da."]);
    expect(procs).toHaveLength(2);
    backend.close?.();
  });

  test("im Leerlauf gestorben zählt als Absturz: einmal neu mit Verlauf, beim zweiten Mal Schluss", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "reply", text: ["Hallo."] }], [{ kind: "reply", text: ["Wieder da."] }]]);
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime });
    await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hi" }));
    procs[0].exit(1);
    await tick();
    const history: BrainMessage[] = [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hallo." }];
    const next = await collect(runVoiceTurn({ backend, system: "S", history, userText: "Noch da?" }));
    expect(segments(next)).toEqual(["Wieder da."]);
    expect(procs[1].cmd[procs[1].cmd.indexOf("--system-prompt") + 1]).toContain("Nutzer: Hi");
    procs[1].exit(1);
    await tick();
    const after = await collect(runVoiceTurn({ backend, system: "S", history, userText: "Hallo?" }));
    // Nach dem erfolgreichen Turn begann die Zählung neu: ein Leerlauf-Tod ist erst der erste Absturz
    expect(segments(after)).toEqual(["Gut."]);
    expect(procs).toHaveLength(3);
    backend.close?.();
  });

  test("/stop beendet die Sitzung samt Eintrag in engines/calls.ts, sie startet nicht wieder", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "reply", text: ["Hallo."] }, { kind: "hang" }]]);
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, abortKey: "web:test-256" });
    const before = registeredEngineCallCount();
    await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hi" }));
    // Die offene Sitzung bleibt angemeldet (für /stop); als Verarbeitung zählt sie im Leerlauf nicht (Issue #257)
    expect(registeredEngineCallCount()).toBe(before + 1);
    expect(activeEngineCallCount()).toBe(0);
    const pending = collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl" }));
    await tick();
    expect(abortEngineCalls("web:test-256")).toBe(1);
    const events = await pending;
    expect(last(events)).toMatchObject({ type: "error", reason: "ended" });
    expect(procs[0].killed).toBe(true);
    expect(registeredEngineCallCount()).toBe(before);
    const again = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hallo?" }));
    expect(last(again)).toMatchObject({ type: "error", reason: "ended" });
    expect(procs).toHaveLength(1);
  });

  // Befundklasse aus den Prüfrunden 2 bis 6: Jede Quelle eines Abbruchs (Signal, interrupt(),
  // /stop, close()) setzt denselben Zustand des Turns; danach erscheint kein Abschnitt mehr.
  for (const [name, text] of [
    ["mehrere Sätze in einem Textstück", ["Rom wurde gegründet. Dann kamen die Könige. Später die Republik. "]],
    ["getrennt gepufferte Textstücke", ["Rom wurde gegründet. ", "Dann kamen die Könige. ", "Später die Republik. "]],
  ] as const) {
    for (const wrapped of [false, true]) {
      test(`/stop nach dem ersten Abschnitt (${name}${wrapped ? ", über withFailureLimit" : ""}): kein weiterer Abschnitt, genau ein Abschluss, keine Wiederbelebung`, async () => {
        const { runtime, procs } = fakeRuntime([[{ kind: "hang", text: [...text] }]]);
        const b = budget();
        const inner = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, abortKey: "web:stop-256", reserveRequest: b.reserveRequest });
        const backend = wrapped ? withFailureLimit(inner) : inner;
        const turn = runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl von Rom", earlyFirst: false });
        const first = await turn.next();
        expect(first.value).toMatchObject({ type: "segment", text: "Rom wurde gegründet." });
        expect(abortEngineCalls("web:stop-256")).toBe(1);
        const rest: VoiceTurnEvent[] = [];
        for await (const e of turn) rest.push(e);
        expect(rest).toHaveLength(1);
        expect(rest[0]).toMatchObject({ type: "error", reason: "ended", spokenText: "Rom wurde gegründet." });
        expect(procs[0].killed).toBe(true);
        expect(b.log).toEqual({ reserved: 1, settled: 1 });

        const again = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hallo?" }));
        expect(again).toHaveLength(1);
        expect(again[0]).toMatchObject({ type: "error", reason: "ended" });
        expect(procs).toHaveLength(1);
        expect(procs[0].lines.filter((l) => l.type === "user")).toHaveLength(1);
      });
    }
  }

  test("close() nach dem ersten Abschnitt: kein weiterer Abschnitt, Abschluss ended, keine neue Sitzung", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "hang", text: ["Rom wurde gegründet. Dann kamen die Könige. ", "Später die Republik. "] }]]);
    const backend = withFailureLimit(createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime }));
    const turn = runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl von Rom", earlyFirst: false });
    expect((await turn.next()).value).toMatchObject({ type: "segment", text: "Rom wurde gegründet." });
    backend.close?.();
    const rest: VoiceTurnEvent[] = [];
    for await (const e of turn) rest.push(e);
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ type: "error", reason: "ended" });
    expect(procs[0].killed).toBe(true);
    expect(procs[0].lines.filter((l) => l.type === "control_request")).toHaveLength(0);
    const again = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hallo?" }));
    expect(again[0]).toMatchObject({ type: "error", reason: "ended" });
    expect(procs).toHaveLength(1);
  });

  // Hinweis aus Runde 8, Befund aus Runde 9: result ist schon da, runVoiceTurn spricht noch den Rest aus sentences.flush()
  test("/stop nach dem letzten Abschnitt aus sentences.flush() (über withFailureLimit): Abschluss ended, keine neue Sitzung", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "reply", text: ["Rom wurde gegründet. Dann kamen die Könige."] }]]);
    const backend = withFailureLimit(createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, abortKey: "web:stop-flush-256" }));
    const turn = runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl von Rom", earlyFirst: false });
    expect((await turn.next()).value).toMatchObject({ type: "segment", text: "Rom wurde gegründet." });
    expect((await turn.next()).value).toMatchObject({ type: "segment", text: "Dann kamen die Könige." });
    expect(abortEngineCalls("web:stop-flush-256")).toBe(1);
    const rest: VoiceTurnEvent[] = [];
    for await (const e of turn) rest.push(e);
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ type: "error", reason: "ended", spokenText: "Rom wurde gegründet. Dann kamen die Könige." });
    expect(procs[0].killed).toBe(true);
    const again = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hallo?" }));
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ type: "error", reason: "ended" });
    expect(procs).toHaveLength(1);
  });

  test("interrupt() nach dem letzten Abschnitt aus sentences.flush() (über withFailureLimit): done mit aborted, Sitzung bleibt benutzbar", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "reply", text: ["Rom wurde gegründet. Dann kamen die Könige."] }, { kind: "reply", text: ["Paris ist die Hauptstadt."] }]]);
    const backend = withFailureLimit(createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime }));
    const turn = runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl von Rom", earlyFirst: false });
    expect((await turn.next()).value).toMatchObject({ type: "segment", text: "Rom wurde gegründet." });
    expect((await turn.next()).value).toMatchObject({ type: "segment", text: "Dann kamen die Könige." });
    await backend.interrupt!();
    const rest: VoiceTurnEvent[] = [];
    for await (const e of turn) rest.push(e);
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ type: "done", aborted: true });
    // Der Turn hatte sein result schon: keine Steuerzeile, derselbe Prozess antwortet weiter
    expect(procs[0].lines.filter((l) => l.type === "control_request")).toHaveLength(0);
    const next = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Hauptstadt von Frankreich?" }));
    expect(segments(next)).toEqual(["Paris ist die Hauptstadt."]);
    expect(last(next)).toMatchObject({ type: "done", aborted: false });
    expect(procs).toHaveLength(1);
    expect(procs[0].killed).toBe(false);
    backend.close?.();
  });

  test("/stop während der nächste Turn noch auf das Ende des Unterbrechens wartet: er sendet nichts", async () => {
    const { runtime, procs, timers } = fakeRuntime([[{ kind: "hang-silent" }, { kind: "reply", text: ["Nie."] }]]);
    const b = budget();
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, abortKey: "web:stop-wait-256", reserveRequest: b.reserveRequest });
    const ctrl = new AbortController();
    const firstTurn = collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl", signal: ctrl.signal }));
    await tick();
    ctrl.abort();
    await firstTurn;
    const nextTurn = collect(runVoiceTurn({ backend, system: "S", history: [], userText: "Und weiter?" }));
    await tick();
    expect(abortEngineCalls("web:stop-wait-256")).toBe(1);
    timers.find((t) => t.ms === 2000 && !t.cleared)?.fn();
    const next = await nextTurn;
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ type: "error", reason: "ended" });
    expect(procs).toHaveLength(1);
    expect(procs[0].lines.filter((l) => l.type === "user")).toHaveLength(1);
    expect(b.log).toEqual({ reserved: 1, settled: 1 });
  });

  test("Herunterfahren (abortAllEngineCalls) und close() räumen den Eintrag ab", async () => {
    const a = fakeRuntime([[{ kind: "reply", text: ["Hallo."] }]]);
    const backendA = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime: a.runtime, abortKey: "web:a" });
    const before = activeEngineCallCount();
    await collect(runVoiceTurn({ backend: backendA, system: "S", history: [], userText: "Hi" }));
    abortAllEngineCalls();
    expect(a.procs[0].killed).toBe(true);
    expect(registeredEngineCallCount()).toBe(0);

    const c = fakeRuntime([[{ kind: "reply", text: ["Hallo."] }]]);
    const backendC = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime: c.runtime, abortKey: "web:c" });
    await collect(runVoiceTurn({ backend: backendC, system: "S", history: [], userText: "Hi" }));
    expect(registeredEngineCallCount()).toBe(1);
    backendC.close?.();
    expect(c.procs[0].killed).toBe(true);
    expect(registeredEngineCallCount()).toBe(0);
  });
});

describe("Telefonhörer im Server (Issue #257)", () => {
  test("prepare startet die Sitzung vor dem ersten Turn, der Turn nutzt denselben Prozess", async () => {
    const { runtime, procs } = fakeRuntime([[{ kind: "reply", text: ["Hallo du."] }]]);
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, abortKey: "web:prep" });
    await backend.prepare!("SYSTEM");
    expect(procs).toHaveLength(1);
    expect(procs[0]!.cmd[procs[0]!.cmd.indexOf("--system-prompt") + 1]).toBe("SYSTEM");
    expect(procs[0]!.lines).toEqual([]);
    const events = await collect(runVoiceTurn({ backend, system: "SYSTEM", history: [], userText: "Hi" }));
    expect(segments(events)).toEqual(["Hallo du."]);
    expect(procs).toHaveLength(1);
    backend.close!();
  });

  test("prepare mit fehlendem Flag: BrainError setup, kein Prozess", async () => {
    const { runtime, procs } = fakeRuntime([], HELP.replace("--safe-mode", "--other"));
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime });
    await expect(backend.prepare!("S")).rejects.toMatchObject({ name: "BrainError", reason: "setup" });
    expect(procs).toHaveLength(0);
  });

  test("zwischen den Turns zählt die offene Sitzung nicht als Verarbeitung, während eines Turns schon", async () => {
    const { runtime } = fakeRuntime([[{ kind: "hang", text: ["Das dauert jetzt etwas länger. ", "Und weiter "] }]]);
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, abortKey: "web:busy" });
    const base = activeEngineCallCount();
    await backend.prepare!("S");
    expect(activeEngineCallCount()).toBe(base);
    const controller = new AbortController();
    const gen = runVoiceTurn({ backend, system: "S", history: [], userText: "Erzähl", signal: controller.signal });
    const first = await gen.next();
    expect(first.value).toBeDefined();
    expect(activeEngineCallCount()).toBe(base + 1);
    backend.close!();
    await collect(gen);
    expect(activeEngineCallCount()).toBe(base);
  });
});

describe("Kosten je Turn (Issue #346)", () => {
  test("kumulativ 0,10 / 0,30 / 0,30 und ein result ohne Kosten: gebucht 0,10 / 0,20 / 0 $ / nicht gemeldet, Herkunft voice", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");
    const { readCycle, resetSubscriptionStateForTests } = await import("../src/lib/spend/subscription");
    const folder = mkdtempSync(join(tmpdir(), "tybo-voice-kosten-"));
    const before = { budget: process.env.BUDGET_DB_PATH, root: process.env.GO_PROJECT_ROOT };
    process.env.BUDGET_DB_PATH = join(folder, "api-budget.sqlite");
    process.env.GO_PROJECT_ROOT = folder;
    resetSubscriptionStateForTests();
    try {
      const { runtime } = fakeRuntime([
        [
          { kind: "reply", text: ["Eins."], total: 0.1 },
          { kind: "reply", text: ["Zwei."], total: 0.3 },
          { kind: "reply", text: ["Drei."], total: 0.3 },
          { kind: "reply", text: ["Vier."], total: null },
        ],
      ]);
      // Standard-Buchung: spend/credit.ts mit Herkunft voice
      const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime });
      const history: BrainMessage[] = [];
      for (const userText of ["a", "b", "c", "d"]) await collect(runVoiceTurn({ backend, system: "S", history, userText }));
      backend.close?.();
      const file = new Database(process.env.BUDGET_DB_PATH!);
      const rows = file.query("SELECT engine, model, origin, cost_usd FROM engine_runs ORDER BY id").all() as { cost_usd: number | null }[];
      file.close();
      expect(rows.map((r) => ({ ...r, cost_usd: r.cost_usd === null ? null : Math.round(r.cost_usd * 1000) / 1000 }))).toEqual([
        { engine: "claude", model: "claude-sonnet-5-5", origin: "voice", cost_usd: 0.1 },
        { engine: "claude", model: "claude-sonnet-5-5", origin: "voice", cost_usd: 0.2 },
        { engine: "claude", model: "claude-sonnet-5-5", origin: "voice", cost_usd: 0 },
        { engine: "claude", model: "claude-sonnet-5-5", origin: "voice", cost_usd: null },
      ]);
      expect(Math.round((readCycle(1)?.cycleSpendUsd ?? 0) * 1000) / 1000).toBe(0.3);
    } finally {
      for (const [key, value] of [["BUDGET_DB_PATH", before.budget], ["GO_PROJECT_ROOT", before.root]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("Rücksprung des Zählers (neue Sitzung): der neue Wert zählt ganz", async () => {
    const { runtime } = fakeRuntime([[{ kind: "reply", text: ["Eins."], total: 0.5 }, { kind: "reply", text: ["Zwei."], total: 0.2 }]]);
    const seen: (number | undefined)[] = [];
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, recordRun: (o) => seen.push(o.costUsd) });
    for (const userText of ["a", "b"]) await collect(runVoiceTurn({ backend, system: "S", history: [], userText }));
    backend.close?.();
    expect(seen).toEqual([0.5, 0.2]);
  });

  test("usage aus dem result geht mit: Tokens samt Cache als Eingabe; ohne usage keine Tokens", async () => {
    const { runtime } = fakeRuntime([
      [
        { kind: "reply", text: ["Eins."], usage: { input_tokens: 40, cache_creation_input_tokens: 10, cache_read_input_tokens: 50, output_tokens: 7 } },
        { kind: "reply", text: ["Zwei."] },
      ],
    ]);
    const seen: RunOutcome[] = [];
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime, recordRun: (o) => seen.push(o) });
    for (const userText of ["a", "b"]) await collect(runVoiceTurn({ backend, system: "S", history: [], userText }));
    backend.close?.();
    expect(seen[0].usage).toEqual({ inputTokens: 100, cachedInputTokens: 50, outputTokens: 7 });
    expect(seen[1].usage).toBeUndefined();
  });
});

describe("Limit-Fehler im Voice-Turn über den echten Buchungsweg (Issue #346)", () => {
  /** Ein Voice-Turn mit Abo-Stand 10 $ und Standard-Buchung; zurück: Turn-Ende, Zeilen in engine_runs, Zyklus */
  async function limitTurn(step: Extract<Behavior, { kind: "fail" }>) {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");
    const { addCycleSpend, readCycle, resetSubscriptionStateForTests } = await import("../src/lib/spend/subscription");
    const folder = mkdtempSync(join(tmpdir(), "tybo-voice-limit-"));
    const before = { budget: process.env.BUDGET_DB_PATH, root: process.env.GO_PROJECT_ROOT };
    process.env.BUDGET_DB_PATH = join(folder, "api-budget.sqlite");
    process.env.GO_PROJECT_ROOT = folder;
    resetSubscriptionStateForTests();
    try {
      addCycleSpend(10, 1);
      const { runtime } = fakeRuntime([[step]]);
      const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime });
      const events = await collect(runVoiceTurn({ backend, system: "S", history: [], userText: "a" }));
      backend.close?.();
      const file = new Database(process.env.BUDGET_DB_PATH!);
      const rows = file.query("SELECT origin, cost_usd FROM engine_runs ORDER BY id").all() as { origin: string; cost_usd: number | null }[];
      file.close();
      const cycle = readCycle(1);
      return { last: events.at(-1), rows, ceiling: cycle?.observedCeilingUsd ?? null, spend: cycle?.cycleSpendUsd ?? 0 };
    } finally {
      for (const [key, value] of [["BUDGET_DB_PATH", before.budget], ["GO_PROJECT_ROOT", before.root]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(folder, { recursive: true, force: true });
    }
  }

  test("is_error mit dem Limit-Text nur in errors und 0,50 $ Zuwachs: gelerntes Limit 10,50 $, eine Buchung", async () => {
    const r = await limitTurn({ kind: "fail", subtype: "success", isError: true, errors: ["You've hit your limit"], total: 0.5 });
    expect(r.last?.type).toBe("error");
    expect(r.rows).toEqual([{ origin: "voice", cost_usd: 0.5 }]);
    expect(r.spend).toBe(10.5);
    expect(r.ceiling).toBe(10.5);
  });

  test("Fehler-subtype ohne is_error, Limit-Text im result, 0,50 $ Zuwachs: gelerntes Limit 10,50 $, eine Buchung", async () => {
    const r = await limitTurn({ kind: "fail", subtype: "error_during_execution", result: "Claude AI usage limit reached|1790000000", total: 0.5 });
    expect(r.last?.type).toBe("error");
    expect(r.rows).toEqual([{ origin: "voice", cost_usd: 0.5 }]);
    expect(r.ceiling).toBe(10.5);
  });

  test("Fehler-subtype mit is_error false, Limit-Text in errors, ohne Kostenmeldung: der vorhandene Stand 10 $ wird gelernt", async () => {
    const r = await limitTurn({ kind: "fail", subtype: "error_during_execution", isError: false, errors: ["You've hit your limit"] });
    expect(r.last?.type).toBe("error");
    expect(r.rows).toEqual([{ origin: "voice", cost_usd: null }]);
    expect(r.spend).toBe(10);
    expect(r.ceiling).toBe(10);
  });

  test("Fehler-result ohne Limit-Text lernt kein Limit", async () => {
    const r = await limitTurn({ kind: "fail", subtype: "error_during_execution", errors: ["Netzwerkfehler"], total: 0.5 });
    expect(r.rows).toEqual([{ origin: "voice", cost_usd: 0.5 }]);
    expect(r.ceiling).toBeNull();
  });
});
