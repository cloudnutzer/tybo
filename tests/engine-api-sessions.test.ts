/**
 * Issue #348, Checkbox 3: Sitzungen des Motors "api" in data/api-sessions/.
 * Abruf bei Anthropic als Attrappe, Sitzungen in einem Temp-Ordner. Geprüft
 * wird über die Anfragen an die API und die Dateien selbst.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { abortEngineCalls, createApiEngine, type EngineRequest, type EngineResult } from "../src/lib/engines";
import { API_TEXT, apiSessionDir } from "../src/lib/engines/api";
import { fileApiSessionStore, parseSessionRef, SESSION_MAX_IDLE_DAYS, TOOL_RESULT_KEEP } from "../src/lib/engines/api-sessions";
import type { ApiToolHost } from "../src/lib/engines/api-tools";
import { installApiFake, textReply, toolReply, until, type ApiFake } from "./api-fixture";

let fake: ApiFake;
beforeEach(() => {
  fake = installApiFake();
});
afterEach(() => fake.restore());

const request = (extra: Partial<EngineRequest> = {}): EngineRequest => ({
  prompt: "Hallo",
  streaming: false,
  timeoutMs: 60_000,
  cwd: process.cwd(),
  // Wie ein Turn mit Rückfragen-Register (Chat-Kern mit onQuestion)
  questions: true,
  ...extra,
});

const fileOf = (sessionId: string) => join(fake.sessionDir, `${parseSessionRef(sessionId)!.id}.json`);
const readSession = (sessionId: string) => JSON.parse(readFileSync(fileOf(sessionId), "utf8"));

describe("Sitzungen", () => {
  test("sessionId im Ergebnis, Datei mit Modell, Zeitpunkten und Verlauf", async () => {
    fake.respond(textReply("Antwort"));
    const r = await createApiEngine().run(request({ model: "claude-sonnet-5-5" }));
    expect(r.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const stored = readSession(r.sessionId!);
    expect(stored).toMatchObject({ id: r.sessionId, model: "claude-sonnet-5-5" });
    expect(typeof stored.createdAt).toBe("string");
    expect(stored.messages).toEqual([
      { role: "user", content: "Hallo" },
      { role: "assistant", content: [{ type: "text", text: "Antwort" }] },
    ]);
    expect(stored.pause).toBeUndefined();
  });

  test("Folgeturn schickt den gespeicherten Verlauf samt Werkzeugrunden plus neue Nachricht", async () => {
    const host: ApiToolHost = {
      offered: () => [{ name: "t_lesen", description: "lesen", input_schema: { type: "object", properties: {} } }],
      call: async () => ({ content: "Inhalt", isError: false }),
      serverOf: () => undefined,
    };
    fake.use({ tools: host });
    fake.respond(toolReply([{ id: "x1", name: "t_lesen" }]));
    fake.respond(textReply("erste"));
    const first = await createApiEngine().run(request({ prompt: "Eins" }));
    fake.respond(textReply("zweite"));
    const second = await createApiEngine().run(request({ prompt: "Zwei", resumeSessionId: first.sessionId }));
    expect(second).toMatchObject({ isError: false, text: "zweite", sessionId: first.sessionId });
    expect(fake.lastBody().messages).toEqual([
      { role: "user", content: "Eins" },
      { role: "assistant", content: [{ type: "tool_use", id: "x1", name: "t_lesen", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: "Inhalt" }] },
      { role: "assistant", content: [{ type: "text", text: "erste" }] },
      { role: "user", content: "Zwei" },
    ]);
  });

  test("Fortsetzen nach neuem Aufbau von Speicher und Motor (frisch aus dem Ordner geladen)", async () => {
    fake.respond(textReply("gemerkt: blau"));
    const first = await createApiEngine().run(request({ prompt: "Meine Farbe ist blau" }));
    // Neuer Speicher auf denselben Ordner, neuer Motor: nichts im Arbeitsspeicher
    fake.use({ sessions: fileApiSessionStore(() => fake.sessionDir) });
    fake.respond(textReply("blau"));
    const again = await createApiEngine().run(request({ prompt: "Welche Farbe?", resumeSessionId: first.sessionId }));
    expect(again).toMatchObject({ isError: false, text: "blau" });
    expect(fake.lastBody().messages[0]).toEqual({ role: "user", content: "Meine Farbe ist blau" });
    expect(fake.lastBody().messages).toHaveLength(3);
  });

  for (const [label, id] of [
    ["unbekannt", "0f0e0d0c-0b0a-4908-8706-050403020100"],
    ["ungültig (Pfadversuch)", "../../etc/passwd"],
    ["ungültig (Pfad mit gültiger UUID)", "x/0f0e0d0c-0b0a-4908-8706-050403020100"],
  ] as const) {
    test(`Sitzung ${label}: errorKind context, kein Abruf`, async () => {
      const r = await createApiEngine().run(request({ resumeSessionId: id }));
      expect(r).toMatchObject({ engine: "api", isError: true, errorKind: "context", text: API_TEXT.sessionGone });
      expect(fake.calls()).toBe(0);
    });
  }

  test("beschädigte Sitzung: errorKind context, kein Abruf, Datei nicht überschrieben", async () => {
    const id = "1f0e0d0c-0b0a-4908-8706-050403020100";
    mkdirSync(fake.sessionDir, { recursive: true });
    writeFileSync(join(fake.sessionDir, `${id}.json`), "{kaputt");
    const r = await createApiEngine().run(request({ resumeSessionId: id }));
    expect(r).toMatchObject({ isError: true, errorKind: "context" });
    expect(fake.calls()).toBe(0);
    expect(readFileSync(join(fake.sessionDir, `${id}.json`), "utf8")).toBe("{kaputt");
    // Gültiges JSON, aber falscher Inhalt (fremde Kennung)
    writeFileSync(join(fake.sessionDir, `${id}.json`), JSON.stringify({ id: "anders", model: "m", createdAt: "", updatedAt: "", messages: [] }));
    expect(await createApiEngine().run(request({ resumeSessionId: id }))).toMatchObject({ errorKind: "context" });
  });

  describe("Verlauf, den die API ablehnen würde: errorKind context, kein Abruf, Datei unverändert", () => {
    const reader: ApiToolHost = {
      offered: () => [{ name: "t_lesen", description: "lesen", input_schema: { type: "object", properties: {} } }],
      call: async () => ({ content: "Inhalt", isError: false }),
      serverOf: () => undefined,
    };
    /** Sitzung mit abgeschlossener Werkzeugrunde: user, tool_use, tool_result, Text */
    async function roundSession(): Promise<string> {
      fake.use({ tools: reader });
      fake.respond(toolReply([{ id: "x1", name: "t_lesen" }]));
      fake.respond(textReply("fertig"));
      return (await createApiEngine().run(request({ prompt: "Eins" }))).sessionId!;
    }
    /** Sitzung mit offener Pause: tool_use l1 (Ergebnis in der Pause) und ask_user q1 */
    async function pausedSession(): Promise<string> {
      fake.use({ tools: reader });
      fake.respond(toolReply([{ id: "l1", name: "t_lesen" }, { id: "q1", name: "ask_user", input: { question: "Weiter?" } }]));
      return (await createApiEngine().run(request({ prompt: "Eins" }))).sessionId!;
    }
    type Harm = (s: any) => void;
    const round: [string, Harm][] = [
      ["tool_use ohne ID, Name und Eingabe", (s) => (s.messages[1].content = [{ type: "tool_use" }])],
      ["tool_use ohne Eingabe", (s) => delete s.messages[1].content[0].input],
      ["tool_result ohne tool_use_id", (s) => delete s.messages[2].content[0].tool_use_id],
      ["tool_result mit Inhalt als Zahl", (s) => (s.messages[2].content[0].content = 5)],
      ["Textblock ohne Text", (s) => (s.messages[3].content = [{ type: "text" }])],
      ["unbekannter Blocktyp", (s) => (s.messages[3].content = [{ type: "image", source: {} }])],
      ["leerer Inhalt", (s) => (s.messages[3].content = [])],
      ["erste Nachricht vom Modell", (s) => s.messages.shift()],
      ["zwei Nutzernachrichten hintereinander", (s) => s.messages.splice(1, 0, { role: "user", content: "noch was" })],
      ["unbekannte Rolle", (s) => (s.messages[0].role = "system")],
      ["tool_use ohne tool_result", (s) => (s.messages[2].content = [{ type: "text", text: "vergessen" }])],
      ["tool_result zu einer fremden ID", (s) => (s.messages[2].content[0].tool_use_id = "y9")],
      ["tool_result doppelt", (s) => s.messages[2].content.push({ ...s.messages[2].content[0] })],
      ["tool_result im Modell-Turn", (s) => s.messages[3].content.push({ type: "tool_result", tool_use_id: "x1", content: "x" })],
      ["tool_result hinter Text", (s) => s.messages[2].content.unshift({ type: "text", text: "davor" })],
      ["tool_use-Kennung doppelt", (s) => s.messages.push({ role: "user", content: "zwei" }, { role: "assistant", content: [{ type: "tool_use", id: "x1", name: "t_lesen", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: "z" }] })],
      ["letzter Modell-Turn mit offenem tool_use ohne Pause", (s) => (s.messages[3].content = [{ type: "tool_use", id: "x2", name: "t_lesen", input: {} }])],
      ["Pause ohne Frage am Ende", (s) => (s.pause = { toolUseId: "x1", mark: "abcdefabcdef", results: [], uses: [] })],
      ["kein Verlauf", (s) => (s.messages = [])],
      ["Modell leer", (s) => (s.model = "")],
      ["Zeitpunkt unlesbar", (s) => (s.updatedAt = "gestern")],
    ];
    const paused: [string, Harm][] = [
      ["Frage der Pause fehlt im letzten Modell-Turn", (s) => (s.pause.toolUseId = "q9")],
      ["Pause zeigt auf ein anderes Werkzeug", (s) => {
        s.pause.toolUseId = "l1";
        s.pause.results = [{ type: "tool_result", tool_use_id: "q1", content: "x" }];
      }],
      ["Ergebnis der Runde fehlt in der Pause", (s) => (s.pause.results = [])],
      ["Ergebnis der Runde zu einer fremden ID", (s) => (s.pause.results[0].tool_use_id = "z1")],
      ["Ergebnis der Runde ohne Inhalt", (s) => delete s.pause.results[0].content],
      ["Werkzeug der Pause ohne Namen", (s) => (s.pause.uses = [{}])],
      ["Pausenmarke ungültig", (s) => (s.pause.mark = "xyz")],
      ["Pause, aber der Verlauf endet beim Nutzer", (s) => s.messages.push({ role: "user", content: "hallo" })],
    ];
    for (const [kind, make, cases] of [
      ["abgeschlossene Runde", roundSession, round],
      ["offene Pause", pausedSession, paused],
    ] as const) {
      for (const [label, harm] of cases) {
        test(`${kind}: ${label}`, async () => {
          const id = await make();
          const file = fileOf(id);
          const stored = JSON.parse(readFileSync(file, "utf8"));
          harm(stored);
          writeFileSync(file, JSON.stringify(stored));
          const before = readFileSync(file, "utf8");
          const callsBefore = fake.calls();
          // Getippt wie per Knopf: beide Wege enden ohne Abruf
          for (const extra of [{}, { answersQuestion: true }]) {
            const r = await createApiEngine().run(request({ prompt: "Weiter", resumeSessionId: id, ...extra }));
            expect(r).toMatchObject({ engine: "api", isError: true, errorKind: "context", text: API_TEXT.sessionGone });
          }
          expect(fake.calls()).toBe(callsBefore);
          expect(readFileSync(file, "utf8")).toBe(before);
        });
      }
    }

    test("Gegenprobe: unbeschädigt lassen sich beide fortsetzen", async () => {
      const a = await roundSession();
      fake.respond(textReply("ok"));
      expect(await createApiEngine().run(request({ prompt: "Zwei", resumeSessionId: a }))).toMatchObject({ isError: false });
      const b = await pausedSession();
      fake.respond(textReply("ok"));
      expect(await createApiEngine().run(request({ prompt: "Ja", resumeSessionId: b, answersQuestion: true }))).toMatchObject({ isError: false });
    });
  });

  test("gescheiterter Lauf lässt die Sitzung unverändert", async () => {
    fake.respond(textReply("erste"));
    const first = await createApiEngine().run(request({ prompt: "Eins" }));
    const before = readFileSync(fileOf(first.sessionId!), "utf8");
    fake.respondStatus(529, JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } }));
    const failed = await createApiEngine().run(request({ prompt: "Zwei", resumeSessionId: first.sessionId }));
    expect(failed).toMatchObject({ isError: true });
    expect(failed.sessionId).toBeUndefined();
    expect(readFileSync(fileOf(first.sessionId!), "utf8")).toBe(before);
    // Zeitlimit ebenso
    fake.hangConnect();
    const late = await createApiEngine().run(request({ prompt: "Drei", resumeSessionId: first.sessionId, timeoutMs: 30 }));
    expect(late).toMatchObject({ timedOut: true });
    expect(readFileSync(fileOf(first.sessionId!), "utf8")).toBe(before);
  });

  describe("Lauf endet, während die Sitzung geschrieben wird (vor dem Umbenennen)", () => {
    const KEY = "topic:-100200300:77";
    const reader: ApiToolHost = {
      offered: () => [{ name: "t_lesen", description: "lesen", input_schema: { type: "object", properties: {} } }],
      call: async () => ({ content: "Inhalt", isError: false }),
      serverOf: () => undefined,
    };
    const usage1 = { start: { input_tokens: 1000, output_tokens: 1 }, end: { output_tokens: 100 } };
    const usage2 = { start: { input_tokens: 2000 }, end: { output_tokens: 50 } };

    /** Sitzung anlegen, dann einen Speicher einsetzen, der vor dem Umbenennen anhält */
    async function heldSave() {
      fake.respond(textReply("erste"));
      const first = await createApiEngine().run(request({ prompt: "Eins" }));
      const before = readFileSync(fileOf(first.sessionId!), "utf8");
      let reached = false;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      fake.use({
        tools: reader,
        sessions: fileApiSessionStore(() => fake.sessionDir, Date.now, {
          beforeCommit: async () => {
            reached = true;
            await gate;
          },
        }),
      });
      fake.respond(toolReply([{ id: "x1", name: "t_lesen" }], { usage: usage1 }));
      fake.respond(textReply("zweite", [], usage2));
      return { first, before, reached: () => reached, release };
    }

    function expectKept(r: EngineResult, first: EngineResult, before: string) {
      expect(r.sessionId).toBeUndefined();
      expect(r.usage).toEqual({ inputTokens: 3000, outputTokens: 150 });
      expect(r.costUsd).toBeCloseTo(0.015, 10);
      expect(r.tools?.uses).toEqual([{ name: "t_lesen", external: true }]);
      expect(fake.calls()).toBe(3);
      expect(readFileSync(fileOf(first.sessionId!), "utf8")).toBe(before);
      expect(readdirSync(fake.sessionDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    }

    test("/stop: aborted, Verbrauch und Werkzeuge bleiben, bisheriger Stand erhalten", async () => {
      const { first, before, reached, release } = await heldSave();
      const running = createApiEngine().run(request({ prompt: "Zwei", resumeSessionId: first.sessionId, model: "claude-opus-5-5", abortKey: KEY }));
      await until(reached);
      abortEngineCalls(KEY);
      release();
      const r = await running;
      expect(r).toMatchObject({ engine: "api", isError: true, aborted: true });
      expectKept(r, first, before);
    });

    test("timeoutMs: timedOut, Verbrauch und Werkzeuge bleiben, bisheriger Stand erhalten", async () => {
      const { first, before, reached, release } = await heldSave();
      // Uhr der Zeitlimits in der Hand des Tests: das Gesamtlimit feuert genau beim Schreiben
      const timers: { fn: () => void; ms: number }[] = [];
      fake.use({ setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimeout: () => {} });
      const running = createApiEngine().run(request({ prompt: "Zwei", resumeSessionId: first.sessionId, model: "claude-opus-5-5", timeoutMs: 45_000 }));
      await until(reached);
      const total = timers.filter((t) => t.ms === 45_000);
      expect(total).toHaveLength(1);
      total[0].fn();
      release();
      const r = await running;
      expect(r).toMatchObject({ engine: "api", isError: true, timedOut: true });
      expectKept(r, first, before);
    });

    test("Gegenprobe: ohne Abbruch wird nach dem Anhalten gespeichert", async () => {
      const { first, before, reached, release } = await heldSave();
      const running = createApiEngine().run(request({ prompt: "Zwei", resumeSessionId: first.sessionId }));
      await until(reached);
      release();
      expect(await running).toMatchObject({ isError: false, text: "zweite", sessionId: first.sessionId });
      expect(readFileSync(fileOf(first.sessionId!), "utf8")).not.toBe(before);
    });
  });

  test("atomar geschrieben: keine temporären Reste, Datei 0600, Ordner 0700", async () => {
    fake.respond(textReply("ok"));
    const r = await createApiEngine().run(request());
    expect(readdirSync(fake.sessionDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(statSync(fileOf(r.sessionId!)).mode & 0o777).toBe(0o600);
    expect(statSync(fake.sessionDir).mode & 0o777).toBe(0o700);
  });

  test("Werkzeugergebnisse gekürzt gespeichert, an die API im selben Lauf ungekürzt", async () => {
    const long = "x".repeat(TOOL_RESULT_KEEP + 500);
    fake.use({
      tools: {
        offered: () => [{ name: "t_gross", description: "groß", input_schema: { type: "object", properties: {} } }],
        call: async () => ({ content: long, isError: false }),
        serverOf: () => undefined,
      },
    });
    fake.respond(toolReply([{ id: "g1", name: "t_gross" }]));
    fake.respond(textReply("ok"));
    const r = await createApiEngine().run(request());
    expect(fake.lastBody().messages[2].content[0].content).toBe(long);
    const stored = readSession(r.sessionId!).messages[2].content[0].content as string;
    expect(stored.length).toBeLessThan(long.length);
    expect(stored.startsWith("x".repeat(TOOL_RESULT_KEEP))).toBe(true);
  });

  test("Aufräumen: 30 Tage unbenutzte Sitzungen verschwinden beim nächsten Schreiben, frische bleiben", async () => {
    fake.respond(textReply("alt"));
    const old = await createApiEngine().run(request());
    fake.respond(textReply("neu"));
    const fresh = await createApiEngine().run(request());
    const past = (Date.now() - (SESSION_MAX_IDLE_DAYS + 1) * 86_400_000) / 1000;
    utimesSync(fileOf(old.sessionId!), past, past);
    fake.respond(textReply("dritte"));
    await createApiEngine().run(request());
    expect(existsSync(fileOf(old.sessionId!))).toBe(false);
    expect(existsSync(fileOf(fresh.sessionId!))).toBe(true);
  });

  test("zwei Gespräche, zwei getrennte Sitzungen", async () => {
    fake.respond(textReply("A1"));
    const a = await createApiEngine().run(request({ prompt: "Gespräch A" }));
    fake.respond(textReply("B1"));
    const b = await createApiEngine().run(request({ prompt: "Gespräch B" }));
    expect(a.sessionId).not.toBe(b.sessionId);
    fake.respond(textReply("A2"));
    await createApiEngine().run(request({ prompt: "weiter A", resumeSessionId: a.sessionId }));
    const sent = JSON.stringify(fake.lastBody().messages);
    expect(sent).toContain("Gespräch A");
    expect(sent).not.toContain("Gespräch B");
    expect(JSON.stringify(readSession(b.sessionId!).messages)).not.toContain("Gespräch A");
  });

  test("Ordner: data/api-sessions im Projektordner", () => {
    expect(apiSessionDir({ GO_PROJECT_ROOT: "/srv/tybo" })).toBe("/srv/tybo/data/api-sessions");
  });
});
