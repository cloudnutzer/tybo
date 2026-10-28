/**
 * Issue #259: Werkzeug-Tags im Telefonhörer ([SUCHE:], [RECHNE:],
 * [DENKAUFTRAG:]), Rechner und Werkzeug-Schleife in runVoiceTurn.
 * Nur Modell-Attrappen, kein echtes Modell, keine Datenbank.
 */
import { describe, expect, test } from "bun:test";
import { evaluateExpression } from "../src/lib/voice-brain/calc";
import { SentenceStream } from "../src/lib/voice-brain/sentences";
import { stripTags, TagFilter } from "../src/lib/voice-brain/tags";
import { TOOL_TAG_NAMES, TOOL_TEXT, ToolTagScanner, type ToolScanEvent } from "../src/lib/voice-brain/tools";
import { runVoiceTurn, type VoiceTurnEvent } from "../src/lib/voice-brain/turn";
import type { BrainBackend, BrainCall } from "../src/lib/voice-brain/types";

// ---------------------------------------------------------------------------
// Rechner
// ---------------------------------------------------------------------------

describe("evaluateExpression", () => {
  test("18 % von 2.450 ist 441", () => {
    expect(evaluateExpression("18 % von 2.450")).toEqual({ ok: true, value: 441, text: "441" });
    expect(evaluateExpression("18% von 2.450 €")).toMatchObject({ ok: true, value: 441 });
    expect(evaluateExpression("2.450 * 18 %")).toMatchObject({ ok: true, value: 441 });
  });

  test("deutsches Komma, Tausenderpunkt und Dezimalpunkt", () => {
    expect(evaluateExpression("18,5 + 1,5")).toMatchObject({ ok: true, value: 20, text: "20" });
    expect(evaluateExpression("1.250.000,75 - 0,75")).toMatchObject({ ok: true, value: 1_250_000, text: "1.250.000" });
    expect(evaluateExpression("2.5 * 2")).toMatchObject({ ok: true, value: 5 });
    expect(evaluateExpression("10 / 4")).toMatchObject({ ok: true, value: 2.5, text: "2,5" });
    expect(evaluateExpression("1 / 3")).toMatchObject({ ok: true, text: "0,333333" });
  });

  test("Klammern, Vorrang und Vorzeichen", () => {
    expect(evaluateExpression("(2 + 3) * 4")).toMatchObject({ ok: true, value: 20 });
    expect(evaluateExpression("2 + 3 * 4")).toMatchObject({ ok: true, value: 14 });
    expect(evaluateExpression("-(4 - 10) / 2")).toMatchObject({ ok: true, value: 3 });
    expect(evaluateExpression("((1.200 + 800) * 19 %)")).toMatchObject({ ok: true, value: 380 });
  });

  test("Division durch null, Fremdzeichen, Funktionen und kaputte Ausdrücke: kein Ergebnis", () => {
    for (const bad of ["5 / 0", "5 / (3 - 3)", "2 ^ 8", "Math.sqrt(4)", "x + 1", "alert(1)", "2 +", "(2 + 3", "2 3", "", "von 2", "5 von 10", "1e400", "process.exit()"]) {
      expect(evaluateExpression(bad)).toEqual({ ok: false });
    }
  });

  test("Grenzen: zu lang, zu tief verschachtelt, nicht endlich", () => {
    expect(evaluateExpression("1+".repeat(150) + "1")).toEqual({ ok: false });
    expect(evaluateExpression("(".repeat(25) + "1" + ")".repeat(25))).toEqual({ ok: false });
    expect(evaluateExpression("(".repeat(5) + "1" + ")".repeat(5))).toMatchObject({ ok: true, value: 1 });
    expect(evaluateExpression("999999999999999999999 * 999999999999999999999 * 999999999999999999999 * 999999999999999999999 * 999999999999999999999 * 999999999999999999999 * 999999999999999999999 * 999999999999999999999")).toMatchObject({ ok: true });
    expect(evaluateExpression("1" + "0".repeat(200))).toEqual({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Tag-Erkennung
// ---------------------------------------------------------------------------

function scanAll(chunks: string[]): ToolScanEvent[] {
  const s = new ToolTagScanner();
  const out: ToolScanEvent[] = [];
  // Text aus mehreren Aufrufen zusammenfassen, wie ihn der Satz-Strom sieht
  for (const ev of [...chunks.flatMap((c) => s.push(c)), ...s.flush()]) {
    const last = out[out.length - 1];
    if (ev.type === "text" && last?.type === "text") last.text += ev.text;
    else out.push({ ...ev });
  }
  return out;
}

describe("ToolTagScanner", () => {
  test("Tag über mehrere Textstücke: start beim Beginn (Name plus Doppelpunkt), tag mit der schließenden Klammer", () => {
    const s = new ToolTagScanner();
    expect(s.push("[SU")).toEqual([]);
    expect(s.push("CHE")).toEqual([]);
    expect(s.push(": Küchen")).toEqual([{ type: "start", name: "suche" }]);
    expect(s.push("front Farbe")).toEqual([]);
    expect(s.push("] Danach")).toEqual([
      { type: "tag", name: "suche", arg: "Küchenfront Farbe", raw: "[SUCHE: Küchenfront Farbe]" },
      { type: "text", text: " Danach" },
    ]);
  });

  test("Groß- und Kleinschreibung, Leerraum, innere Klammern", () => {
    expect(scanAll(["[ rechne : (2 + 3) * [4] ]"])).toEqual([
      { type: "start", name: "rechne" },
      { type: "tag", name: "rechne", arg: "(2 + 3) * [4]", raw: "[ rechne : (2 + 3) * [4] ]" },
    ]);
  });

  test("kein Werkzeug-Tag: Klammern im Text, Merk-Tags und ähnliche Namen gehen als Text weiter", () => {
    const events = scanAll(["Das ist [laut] gut. [REMEMBER: Alex mag Tee] [Suche nach Hilfe] [SUCHEN: x]"]);
    expect(events).toEqual([{ type: "text", text: "Das ist [laut] gut. [REMEMBER: Alex mag Tee] [Suche nach Hilfe] [SUCHEN: x]" }]);
  });

  test("unvollständiges Tag am Ende: incomplete, nie Text", () => {
    expect(scanAll(["Gleich. [DENKAUFTRAG: Plane die Reise"])).toEqual([
      { type: "text", text: "Gleich. " },
      { type: "start", name: "denkauftrag" },
      { type: "incomplete", name: "denkauftrag" },
    ]);
    // Nur der Anfang eines möglichen Namens am Ende: bleibt Text (es ist nie ein Tag geworden)
    expect(scanAll(["Ok [SU"])).toEqual([{ type: "text", text: "Ok [SU" }]);
  });

  test("mehrere Tags in einer Antwort", () => {
    const events = scanAll(["[RECHNE: 1+1] und [SUCHE: Tee]"]);
    expect(events.filter((e) => e.type === "tag").map((e) => (e as { arg: string }).arg)).toEqual(["1+1", "Tee"]);
  });
});

describe("Tag-Filter mit Werkzeug-Tags", () => {
  test("die Brücke bleibt unverändert: ohne extraTags wird [SUCHE:] nicht gefiltert", () => {
    expect(stripTags("Ja. [SUCHE: Tee] Gut.")).toBe("Ja. [SUCHE: Tee] Gut.");
    const strict = new TagFilter({ strict: true });
    expect(strict.push("[SUCHE: x] ok") + strict.flush()).toBe("[SUCHE: x] ok");
  });

  test("Satz-Strom des Telefonhörers liest Werkzeug-Tags nie vor, auch angefangen nicht", () => {
    const stream = new SentenceStream({ extraTags: TOOL_TAG_NAMES });
    const out = [...stream.push("Das passt wirklich gut. [RECHNE: 2 + 2] Das ist richtig schön. [DENKAUFTRAG: Plane"), ...stream.flush()];
    expect(out).toEqual(["Das passt wirklich gut.", "Das ist richtig schön."]);
  });
});

// ---------------------------------------------------------------------------
// Werkzeug-Schleife
// ---------------------------------------------------------------------------

/** Modell-Attrappe: je Runde ein Strom, den der Test füllt oder vorgibt */
function scriptedBackend(rounds: (string[] | "manual")[]) {
  const calls: BrainCall[] = [];
  const returned: number[] = [];
  const manual: { push(t: string): void; end(): void }[] = [];
  const backend: BrainBackend = {
    id: "attrappe",
    label: "Attrappe",
    async *stream(call: BrainCall) {
      const index = calls.length;
      calls.push({ ...call, messages: call.messages.map((m) => ({ ...m })) });
      const script = rounds[index] ?? [];
      try {
        if (script === "manual") {
          const queue: (string | null)[] = [];
          let wake: (() => void) | null = null;
          manual.push({
            push: (t) => {
              queue.push(t);
              wake?.();
            },
            end: () => {
              queue.push(null);
              wake?.();
            },
          });
          while (true) {
            if (!queue.length) await new Promise<void>((r) => (wake = r));
            wake = null;
            const t = queue.shift();
            if (t === null || t === undefined) return;
            yield { text: t };
          }
        }
        for (const text of script) yield { text };
      } finally {
        returned.push(index);
      }
    },
  };
  return { backend, calls, returned, manual };
}

async function collect(gen: AsyncGenerator<VoiceTurnEvent>): Promise<VoiceTurnEvent[]> {
  const out: VoiceTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const segments = (events: VoiceTurnEvent[]) => events.filter((e) => e.type === "segment").map((e) => (e as { text: string }).text);
const TOOL_TAG = /\[\s*(SUCHE|RECHNE|DENKAUFTRAG)/i;
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("runVoiceTurn mit Werkzeugen", () => {
  test("[SUCHE:]: start beim Beginn des Tags, genau ein Aufruf, Text danach verworfen, Ergebnis als gekennzeichnete Nachricht", async () => {
    const m = scriptedBackend(["manual", ["Die Küchenfront ist ", "salbeigrün."]]);
    const searches: string[] = [];
    const turn = runVoiceTurn({
      backend: m.backend,
      system: "S",
      history: [{ role: "assistant", content: "Hallo." }],
      userText: "Welche Farbe hatte die Küchenfront?",
      tools: { search: async (q) => (searches.push(q), "Gespräch vom 3.9.: Küchenfront salbeigrün") },
    });
    const first = turn.next();
    await tick();
    m.manual[0].push("[SUCHE: Küchen");
    expect((await first).value).toEqual({ type: "tool", name: "suche", phase: "start" });
    // Noch kein Aufruf: das Tag ist nicht vollständig
    expect(searches).toEqual([]);
    m.manual[0].push("front Farbe] Ich glaube, sie war blau. [REMEMBER: Küche ist blau]");
    const rest = await collect(turn);
    expect(searches).toEqual(["Küchenfront Farbe"]);
    // Runde 1 wurde beendet, sobald das Tag vollständig war
    expect(m.returned).toContain(0);
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: "[SUCHE: Küchenfront Farbe]" },
      { role: "user", content: `${TOOL_TEXT.searchLabel}\nGespräch vom 3.9.: Küchenfront salbeigrün` },
    ]);
    expect(segments(rest)).toEqual(["Die Küchenfront ist salbeigrün."]);
    const done = rest[rest.length - 1];
    expect(done).toMatchObject({ type: "done", aborted: false });
    // Verworfener Rest samt Merk-Tag ist nicht im rawText
    expect((done as { rawText: string }).rawText).toBe("[SUCHE: Küchenfront Farbe]Die Küchenfront ist salbeigrün.");
    expect((done as { rawText: string }).rawText).not.toContain("REMEMBER");
    // Tag und Ergebnis für den Verlauf der Folgeturns
    expect((done as { toolMessages?: unknown }).toolMessages).toEqual([
      { role: "assistant", content: "[SUCHE: Küchenfront Farbe]" },
      { role: "user", content: `${TOOL_TEXT.searchLabel}\nGespräch vom 3.9.: Küchenfront salbeigrün` },
    ]);
  });

  test("[RECHNE:]: Ergebnis aus dem eigenen Rechner zurück, kein Sprechen des Tags", async () => {
    const m = scriptedBackend([["[RECHNE: 18 % ", "von 2.450]"], ["Das sind 441 Euro."]]);
    const events = await collect(runVoiceTurn({ backend: m.backend, system: "S", history: [], userText: "Wie viel sind 18 Prozent von 2.450 Euro?", tools: {} }));
    expect(events[0]).toEqual({ type: "tool", name: "rechne", phase: "start" });
    expect(m.calls[1].messages[m.calls[1].messages.length - 1]).toEqual({ role: "user", content: `${TOOL_TEXT.calcLabel}\n18 % von 2.450 = 441` });
    expect(segments(events)).toEqual(["Das sind 441 Euro."]);
  });

  test("[RECHNE:] mit ungültigem Ausdruck: Rechenfehler als Ergebnis", async () => {
    const m = scriptedBackend([["[RECHNE: 5 / 0]"], ["Das kann ich so nicht rechnen."]]);
    await collect(runVoiceTurn({ backend: m.backend, system: "S", history: [], userText: "Fünf durch null?", tools: {} }));
    expect(m.calls[1].messages.at(-1)!.content).toBe(`${TOOL_TEXT.calcLabel}\n${TOOL_TEXT.calcError}`);
  });

  test("dritte Werkzeug-Runde wird nicht mehr ausgeführt, das Modell antwortet mit dem, was es hat", async () => {
    const m = scriptedBackend([["[RECHNE: 1 + 1]"], ["[RECHNE: 2 + 2]"], ["[RECHNE: 3 + 3] Das sind sechs, glaube ich."]]);
    const events = await collect(runVoiceTurn({ backend: m.backend, system: "S", history: [], userText: "Rechne bitte.", tools: {} }));
    expect(m.calls).toHaveLength(3);
    expect(events.filter((e) => e.type === "tool")).toHaveLength(2);
    // Nach der zweiten Runde: Hinweis, keine Werkzeuge mehr
    expect(m.calls[2].messages.at(-1)!.content).toContain(TOOL_TEXT.lastRound);
    expect(segments(events)).toEqual(["Das sind sechs, glaube ich."]);
  });

  test("[SUCHE:] ohne Ergebnis binnen Zeitlimit: fester Satz, keine weitere Runde, spätes Ergebnis wirkt nicht", async () => {
    const m = scriptedBackend([["[SUCHE: Urlaub]"]]);
    let release!: (v: string) => void;
    let searchSignal: AbortSignal | undefined;
    const events = await collect(
      runVoiceTurn({
        backend: m.backend,
        system: "S",
        history: [],
        userText: "Wohin ging der Urlaub?",
        tools: {
          searchTimeoutMs: 20,
          search: (_q, signal) => {
            searchSignal = signal;
            return new Promise((r) => (release = r));
          },
        },
      })
    );
    expect(segments(events)).toEqual([TOOL_TEXT.searchNothing]);
    expect(m.calls).toHaveLength(1);
    expect(searchSignal?.aborted).toBe(true);
    release("zu spät");
    await tick();
    expect(m.calls).toHaveLength(1);
  });

  test("[SUCHE:] mit Fehler: fester Satz", async () => {
    const m = scriptedBackend([["[SUCHE: x]"]]);
    const events = await collect(
      runVoiceTurn({ backend: m.backend, system: "S", history: [], userText: "Frage", tools: { search: async () => Promise.reject(new Error("weg")) } })
    );
    expect(segments(events)).toEqual([TOOL_TEXT.searchNothing]);
  });

  test("[SUCHE:] ohne bereitstehende Suche: nicht ausgeführt, nicht gesprochen", async () => {
    const m = scriptedBackend([["[SUCHE: x] Das weiß ich leider nicht."]]);
    const events = await collect(runVoiceTurn({ backend: m.backend, system: "S", history: [], userText: "Frage", tools: {} }));
    expect(events.some((e) => e.type === "tool")).toBe(false);
    expect(segments(events)).toEqual(["Das weiß ich leider nicht."]);
    expect(m.calls).toHaveLength(1);
  });

  test("[DENKAUFTRAG:]: start, dann call mit der Aufgabe, danach endet der Turn ohne weitere Runde", async () => {
    const m = scriptedBackend([["[DENKAUFTRAG: Vergleiche drei Wärmepumpen", " für ein Haus von 140 m²] Ich melde mich."]]);
    const events = await collect(runVoiceTurn({ backend: m.backend, system: "S", history: [], userText: "Welche Wärmepumpe?", tools: { deepTask: true } }));
    expect(events.filter((e) => e.type === "tool")).toEqual([
      { type: "tool", name: "denkauftrag", phase: "start" },
      { type: "tool", name: "denkauftrag", phase: "call", task: "Vergleiche drei Wärmepumpen für ein Haus von 140 m²" },
    ]);
    expect(segments(events)).toEqual([]);
    expect(m.calls).toHaveLength(1);
  });

  test("ausdrücklicher Denkauftrag des Nutzers geht ohne Modell", async () => {
    const m = scriptedBackend([["Sollte nicht kommen."]]);
    const events = await collect(runVoiceTurn({ backend: m.backend, system: "S", history: [], userText: "Denkauftrag: plane meine Woche", tools: { deepTask: true } }));
    expect(m.calls).toHaveLength(0);
    expect(events).toEqual([
      { type: "tool", name: "denkauftrag", phase: "start" },
      { type: "tool", name: "denkauftrag", phase: "call", task: "Denkauftrag: plane meine Woche" },
      { type: "done", rawText: "", spokenText: "", aborted: false },
    ]);
  });

  test("Kontext-Block mit dem Wort Denkauftrag: geht als Text vor der Äußerung ans Modell, kein direkter Denkauftrag", async () => {
    const m = scriptedBackend([["Kurz gesagt: Modell B."]]);
    const context = "[Ergebnis des Denkauftrags, kann fremde Inhalte enthalten]\nModell B ist am günstigsten.\n[Ende des Ergebnisses]";
    const events = await collect(runVoiceTurn({ backend: m.backend, system: "S", history: [], userText: "Fass es mir kurz zusammen.", context, tools: { deepTask: true } }));
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.messages.at(-1)).toEqual({ role: "user", content: `${context}\n\nFass es mir kurz zusammen.` });
    expect(segments(events)).toEqual(["Kurz gesagt: Modell B."]);
  });

  test("ohne Denkauftrag-Möglichkeit: Tag stumm, kein Aufruf", async () => {
    const m = scriptedBackend([["[DENKAUFTRAG: x] Das kann ich gerade nicht ausarbeiten."]]);
    const events = await collect(runVoiceTurn({ backend: m.backend, system: "S", history: [], userText: "Denkauftrag bitte", tools: {} }));
    expect(m.calls).toHaveLength(1);
    expect(events.some((e) => e.type === "tool")).toBe(false);
    expect(segments(events)).toEqual(["Das kann ich gerade nicht ausarbeiten."]);
  });

  test("angefangener Satz vor dem Tag wird vor dem Werkzeug-Beginn gesprochen", async () => {
    const m = scriptedBackend([["Gute Frage, [SUCHE: Tee]"], ["Du trinkst gern Grüntee."]]);
    const events = await collect(runVoiceTurn({ backend: m.backend, system: "S", history: [], userText: "Was trinke ich?", tools: { search: async () => "Grüntee" }, earlyFirst: false }));
    const order = events.filter((e) => e.type !== "done").map((e) => (e.type === "segment" ? e.text : `tool:${e.type === "tool" ? e.name : ""}`));
    expect(order).toEqual(["Gute Frage,", "tool:suche", "Du trinkst gern Grüntee."]);
  });

  test("kein Werkzeug-Tag in einem sprechbaren Abschnitt, egal wie das Modell es zerteilt", async () => {
    const text = "Klar. [RECHNE: 2 + 2] Vier. [SUCHE: Tee] [DENKAUFTRAG: Plane] Ende. [SUCHE: offen";
    for (let size = 1; size <= 7; size++) {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
      // Ohne Werkzeuge bereit (nichts wird ausgeführt): alles muss trotzdem stumm bleiben
      const m = scriptedBackend([chunks]);
      const events = await collect(runVoiceTurn({ backend: m.backend, system: "S", history: [], userText: "x", tools: { maxRounds: 0 } }));
      for (const s of segments(events)) expect(s).not.toMatch(TOOL_TAG);
      expect(segments(events).join(" ")).toBe("Klar. Vier. Ende.");
    }
  });

  test("Abbruch während der Suche: kein weiterer Abschnitt, aborted", async () => {
    const m = scriptedBackend([["[SUCHE: Tee]"], ["Sollte nicht kommen."]]);
    const ctrl = new AbortController();
    const turn = runVoiceTurn({
      backend: m.backend,
      system: "S",
      history: [],
      userText: "Frage",
      signal: ctrl.signal,
      tools: { search: () => new Promise(() => {}) },
    });
    expect((await turn.next()).value).toEqual({ type: "tool", name: "suche", phase: "start" });
    const pending = collect(turn);
    await tick();
    ctrl.abort();
    const rest = await pending;
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ type: "done", aborted: true });
    expect(m.calls).toHaveLength(1);
  });
});
