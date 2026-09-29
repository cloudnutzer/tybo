/**
 * Vertragstest für Motoren (Issue #121), wiederverwendbar: jeder Motor
 * liefert eine Attrappe (EngineContractHarness), die seinen Prozess ersetzt,
 * und muss dieselben Zusagen erfüllen: Antwort, Session-ID, Folgeanfrage mit
 * resumeSessionId, Werkzeug-Rückruf, Fehler, Abbruch über abortEngineCalls,
 * Zeitlimit. Kein echter Motor, keine echten Prozesssignale.
 * Einstieg für Claude: tests/engine-contract-claude.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { abortEngineCalls, activeEngineCallCount, type Engine, type EngineId, type EngineRequest } from "../src/lib/engines";

export interface EngineContractHarness {
  id: EngineId;
  engine(): Engine;
  /** Vor jedem Test: Prozessstart und Prozessbeendigung durch Attrappen ersetzen */
  setup(): void;
  /** Nach jedem Test: alles zurückstellen */
  teardown(): void;
  /** Der nächste Lauf antwortet mit Text und Session, optional nach einem Werkzeugaufruf */
  reply(o: { text: string; sessionId: string; tool?: string }): void;
  /** Der nächste Lauf endet mit einem Fehler des Motors */
  fail(o: { sessionId: string }): void;
  /** Der nächste Lauf hängt, bis er beendet wird; mit sessionId meldet er vorher seine Session */
  hang(o?: { sessionId?: string }): void;
  /** Die Session, die der letzte Lauf beim Motor fortsetzen sollte */
  lastResumeSessionId(): string | undefined;
  /** Wie oft ein Prozess(baum) beendet wurde */
  terminations(): number;
}

const MODES = [
  ["JSON", false],
  ["Streaming", true],
] as const;

/** Kurze Zeitgrenzen: die Attrappe hängt, bis die Grenze greift */
const SHORT_MS = 40;
const LONG_MS = 60_000;

export function runEngineContract(h: EngineContractHarness): void {
  describe(`Motor-Vertrag: ${h.id}`, () => {
    beforeEach(() => h.setup());
    afterEach(() => h.teardown());

    const request = (streaming: boolean, extra: Partial<EngineRequest> = {}): EngineRequest => ({
      prompt: "Hallo",
      streaming,
      timeoutMs: LONG_MS,
      cwd: process.cwd(),
      ...extra,
    });

    test("describe liefert einen Anzeigenamen, id stimmt", () => {
      const engine = h.engine();
      expect(engine.id).toBe(h.id);
      expect(engine.describe().trim().length).toBeGreaterThan(0);
    });

    for (const [label, streaming] of MODES) {
      describe(label, () => {
        test("Antwort mit Session-ID", async () => {
          h.reply({ text: "Hallo zurück", sessionId: "sess-1" });
          const r = await h.engine().run(request(streaming));
          expect(r).toMatchObject({ engine: h.id, text: "Hallo zurück", sessionId: "sess-1", isError: false });
          expect(r.aborted).toBeFalsy();
          expect(r.timedOut).toBeFalsy();
          expect(activeEngineCallCount()).toBe(0);
        });

        test("Folgeanfrage mit resumeSessionId setzt die Session fort", async () => {
          h.reply({ text: "erste", sessionId: "sess-2" });
          const first = await h.engine().run(request(streaming));
          expect(h.lastResumeSessionId()).toBeUndefined();
          h.reply({ text: "zweite", sessionId: "sess-2" });
          const second = await h.engine().run(request(streaming, { resumeSessionId: first.sessionId }));
          expect(h.lastResumeSessionId()).toBe("sess-2");
          expect(second).toMatchObject({ text: "zweite", sessionId: "sess-2", isError: false });
        });

        test("Werkzeuge des Laufs stehen im Ergebnis", async () => {
          h.reply({ text: "gesucht", sessionId: "sess-3", tool: "WebSearch" });
          const r = await h.engine().run(request(streaming));
          expect(r.isError).toBe(false);
          expect(r.tools?.uses.map((u) => u.name)).toContain("WebSearch");
        });

        test("Fehler des Motors: isError, weder Abbruch noch Zeitlimit", async () => {
          h.fail({ sessionId: "sess-4" });
          const r = await h.engine().run(request(streaming));
          expect(r).toMatchObject({ engine: h.id, isError: true });
          expect(r.aborted).toBeFalsy();
          expect(r.timedOut).toBeFalsy();
        });

        test("Abbruch über abortEngineCalls: aborted, Prozess beendet, Zählung zurück auf 0", async () => {
          h.hang();
          const running = h.engine().run(request(streaming, { abortKey: `contract:${h.id}` }));
          await until(() => activeEngineCallCount() === 1);
          expect(abortEngineCalls(`contract:${h.id}`)).toBe(1);
          const r = await running;
          expect(r).toMatchObject({ engine: h.id, aborted: true, isError: true });
          expect(r.timedOut).toBeFalsy();
          expect(h.terminations()).toBe(1);
          expect(activeEngineCallCount()).toBe(0);
        });

        test("Zeitlimit: timedOut, kein Abbruch, Prozess beendet", async () => {
          h.hang({ sessionId: "sess-5" });
          const r = await h.engine().run(request(streaming, { timeoutMs: SHORT_MS }));
          expect(r).toMatchObject({ engine: h.id, timedOut: true, isError: true });
          expect(r.aborted).toBeFalsy();
          expect(h.terminations()).toBe(1);
          expect(activeEngineCallCount()).toBe(0);
          if (streaming) {
            expect(r.timeoutKind).toBe("total");
            // Die Session bleibt fortsetzbar („weiter")
            expect(r.sessionId).toBe("sess-5");
          }
        });
      });
    }

    test("Streaming: Werkzeug- und Text-Rückruf feuern", async () => {
      h.reply({ text: "Ich suche jetzt nach aktuellen Quellen zu diesem Thema.", sessionId: "sess-6", tool: "WebSearch" });
      const tools: string[] = [];
      const texts: [string, string][] = [];
      const r = await h.engine().run(
        request(true, {
          onToolStart: (name) => tools.push(name),
          onFirstText: (snippet, full) => texts.push([snippet, full]),
        })
      );
      expect(r.isError).toBe(false);
      expect(tools).toHaveLength(1);
      expect(tools[0]!.length).toBeGreaterThan(0);
      expect(texts).toHaveLength(1);
      expect(texts[0]![1]).toContain("aktuellen Quellen");
    });

    test("Streaming: Leerlauf-Grenze greift mit timeoutKind idle", async () => {
      h.hang({ sessionId: "sess-7" });
      const r = await h.engine().run(request(true, { timeoutMs: LONG_MS, idleTimeoutMs: SHORT_MS }));
      expect(r).toMatchObject({ timedOut: true, timeoutKind: "idle", sessionId: "sess-7" });
      expect(h.terminations()).toBe(1);
    });
  });
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("Bedingung nicht erreicht");
    await new Promise((r) => setTimeout(r, 1));
  }
}
