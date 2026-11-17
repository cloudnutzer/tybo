/**
 * Issue #496, Aufgabe 2: Trainingsauswertung mit Aux-Attrappe. Gültige Antwort,
 * unbrauchbare Antworten, Modellfehler mit späterem Versuch, Sonderfälle
 * (leeres Protokoll, keine Selbsteinschätzung, selbsteinschaetzung false,
 * keine Abschlussantwort, langes Protokoll) und Absturz zwischen Eintrag und
 * Statuswechsel.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeAux, resolveAux } from "../src/lib/aux-model";
import { settingsSchema } from "../src/lib/settings";
import type { TranscriptLine } from "../src/lib/phone";
import { EVAL_RETRY_MS, MAX_EVAL_ATTEMPTS, readConversation } from "../src/lib/voice-agents/aftercall";
import { normalizeQuote, parseTrainingAnswer, PROMPT_TRANSCRIPT_CHARS, promptTranscript, readTrainingLog, trainingPrompt } from "../src/lib/voice-agents/training";
import { CLOSING, CRITERIA, expertRecipe, goodAnswer, harness, PRACTICE, tempPaths, writeRecipe, writeState } from "./voice-agents-aftercall-fixture";

let root: string;
let paths: ReturnType<typeof tempPaths>["paths"];
const TRAINING = { rollen: ["Einkauf"], einwaende: ["Kein Budget"], kriterien: [...CRITERIA], selbsteinschaetzung: true, abschlussfrage: CLOSING };

beforeEach(() => {
  ({ root, paths } = tempPaths());
  writeRecipe(paths, expertRecipe());
  writeState(paths, "trainer", { agentId: "agent_trainer" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const receive = (h: ReturnType<typeof harness>, id = "conv_1", lines: TranscriptLine[] = PRACTICE) =>
  h.aftercall.receiveTranscript(id, lines, { agentId: "agent_trainer" }).then(() => h.aftercall.idle());

describe("Aux-Zweck voice-training", () => {
  test("registriert mit Standard wie review, in den Einstellungen setzbar", () => {
    expect(resolveAux("voice-training")).toEqual(resolveAux("review"));
    expect(settingsSchema.parse({ aux: { "voice-training": "openrouter:anbieter/modell" } }).aux?.["voice-training"]).toBe("openrouter:anbieter/modell");
    expect(describeAux("voice-training", { aux: { "voice-training": "ollama:qwen3:8b" } }).target).toEqual({ kind: "ollama", model: "qwen3:8b" });
  });
});

describe("Prompt", () => {
  test("nennt die drei Kriterien, Abschlussfrage und das ganze Protokoll samt Ende", () => {
    const prompt = trainingPrompt(TRAINING, PRACTICE);
    for (const [index, criterion] of CRITERIA.entries()) expect(prompt).toContain(`${index + 1}. ${criterion}`);
    expect(prompt).toContain(CLOSING);
    expect(prompt).toContain("TRAINEE: Ich frage früher nach einem Termin für den nächsten Schritt.");
    expect(prompt).toContain("Self-assessment");
  });

  test("ohne verlangte Selbsteinschätzung fragt er nicht danach", () => {
    expect(trainingPrompt({ ...TRAINING, selbsteinschaetzung: false }, PRACTICE)).not.toContain("Self-assessment");
  });

  test("langes Protokoll: der Anfang fällt weg, nie das Ende", () => {
    const long: TranscriptLine[] = [
      ...Array.from({ length: 2000 }, (_, i) => ({ speaker: "agent" as const, text: `Füllsatz Nummer ${i} mit etwas mehr Text darin` })),
      { speaker: "user", text: "Das ist mein letzter Satz." },
    ];
    const text = promptTranscript(long);
    expect(text.length).toBeLessThanOrEqual(PROMPT_TRANSCRIPT_CHARS + 100);
    expect(text).toStartWith("[beginning of the conversation omitted]");
    expect(text).toEndWith("TRAINEE: Das ist mein letzter Satz.");
    expect(text).not.toContain("Füllsatz Nummer 0 ");
  });
});

describe("Antwort prüfen", () => {
  test("gültige Antwort: drei Kriterien in Rezeptreihenfolge, Zitate, Selbsteinschätzung, Abschluss", () => {
    const shuffled = JSON.parse(goodAnswer());
    shuffled.kriterien.reverse();
    const parsed = parseTrainingAnswer("```json\n" + JSON.stringify(shuffled) + "\n```", TRAINING, PRACTICE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.kriterien.map((k) => [k.text, k.bewertung])).toEqual([
      [CRITERIA[0], "erfuellt"],
      [CRITERIA[1], "teilweise"],
      [CRITERIA[2], "nicht"],
    ]);
    expect(parsed.result.kriterien[2]!.zitat).toBeNull();
    expect(parsed.result.selbsteinschaetzung?.zitat).toBe("den Schmerz hab ich gut getroffen, den Rest eher nicht");
    expect(parsed.result.abschluss).toBe("Ich frage früher nach einem Termin für den nächsten Schritt.");
  });

  test("Zitate zählen ohne Rücksicht auf Groß- und Kleinschreibung, Satzzeichen und Anführungszeichen", () => {
    expect(normalizeQuote("„Wer AUSSER Ihnen?“")).toBe("wer ausser ihnen");
    const answer = JSON.parse(goodAnswer());
    answer.kriterien[1].zitat = "wer außer ihnen ist an der entscheidung beteiligt";
    expect(parseTrainingAnswer(JSON.stringify(answer), TRAINING, PRACTICE).ok).toBe(true);
  });

  const broken: [string, (a: any) => unknown][] = [
    ["kein JSON", () => "Leider kann ich das nicht."],
    ["zwei statt drei Bewertungen", (a) => ((a.kriterien = a.kriterien.slice(0, 2)), a)],
    ["vier Bewertungen", (a) => ((a.kriterien = [...a.kriterien, a.kriterien[0]]), a)],
    ["Kriterium doppelt", (a) => ((a.kriterien[1].nr = 1), a)],
    ["Nummer außerhalb", (a) => ((a.kriterien[2].nr = 4), a)],
    ["Bewertung nicht erlaubt", (a) => ((a.kriterien[0].bewertung = "gut"), a)],
    ["erfüllt ohne Zitat", (a) => ((a.kriterien[0].zitat = null), a)],
    ["erfundenes Zitat", (a) => ((a.kriterien[0].zitat = "Wir sparen eine Million im Jahr"), a)],
    ["Zitat des Trainers", (a) => ((a.kriterien[0].zitat = "Und wer entscheidet bei uns?"), a)],
    ["zu kurzes Zitat", (a) => ((a.kriterien[0].zitat = "Ja"), a)],
    ["erfundene Selbsteinschätzung", (a) => ((a.selbsteinschaetzung.zitat = "Ich war perfekt"), a)],
    ["erfundene Abschlussantwort", (a) => ((a.abschluss = "Ich sage gar nichts anders"), a)],
    ["Selbsteinschätzung ohne Vergleich", (a) => (delete a.selbsteinschaetzung.vergleich, a)],
    ["leerer Vergleich", (a) => ((a.selbsteinschaetzung.vergleich = "  "), a)],
    ["Vergleich keine Zeichenkette", (a) => ((a.selbsteinschaetzung.vergleich = 3), a)],
    ["Vergleich null", (a) => ((a.selbsteinschaetzung.vergleich = null), a)],
    // Zwei Beiträge des Übenden, dazwischen der Trainer: zusammengefügt kein echtes Zitat
    ["Zitat über eine Trainer-Äußerung hinweg", (a) => ((a.kriterien[1].zitat = "Wer außer Ihnen ist an der Entscheidung beteiligt? Ich würde sagen"), a)],
    ["Selbsteinschätzung über eine Trainer-Äußerung hinweg", (a) => ((a.selbsteinschaetzung.zitat = "den Rest eher nicht. Ich frage früher"), a)],
    ["Abschluss nur Satzzeichen", (a) => ((a.abschluss = "..."), a)],
  ];
  for (const [name, change] of broken) {
    test(`unbrauchbar: ${name}`, () => {
      const raw = change(JSON.parse(goodAnswer()));
      expect(parseTrainingAnswer(typeof raw === "string" ? raw : JSON.stringify(raw), TRAINING, PRACTICE).ok).toBe(false);
    });
  }

  test("keine Selbsteinschätzung genannt: null; im Rezept nicht verlangt: fehlt ganz, auch wenn das Modell eine liefert", () => {
    const none = parseTrainingAnswer(goodAnswer({ selbsteinschaetzung: null }), TRAINING, PRACTICE);
    expect(none.ok && none.result.selbsteinschaetzung).toBeNull();
    const off = parseTrainingAnswer(goodAnswer(), { ...TRAINING, selbsteinschaetzung: false }, PRACTICE);
    expect(off.ok).toBe(true);
    expect(off.ok && "selbsteinschaetzung" in off.result).toBe(false);
  });

  test("keine Abschlussantwort: null", () => {
    const parsed = parseTrainingAnswer(goodAnswer({ abschluss: null }), TRAINING, PRACTICE);
    expect(parsed.ok && parsed.result.abschluss).toBeNull();
  });

  test("aufeinanderfolgende Zeilen des Übenden ohne Trainer dazwischen zählen als ein Beitrag", () => {
    const split: TranscriptLine[] = [
      { speaker: "agent", text: "Leg los." },
      { speaker: "user", text: "Sie verlieren jede Woche zwei Tage" },
      { speaker: "user", text: "durch manuelle Prüfungen, oder?" },
    ];
    const answer = JSON.parse(goodAnswer({ selbsteinschaetzung: null, abschluss: null }));
    answer.kriterien[1] = { nr: 2, bewertung: "nicht", zitat: null, begruendung: "Nicht gefragt." };
    expect(parseTrainingAnswer(JSON.stringify(answer), TRAINING, split).ok).toBe(true);
  });

  describe("kurze wörtliche Antworten", () => {
    const short = (self: string, closing: string): TranscriptLine[] => [
      { speaker: "agent", text: "Willst du üben oder Fragen stellen?" },
      { speaker: "user", text: "Üben. Sie verlieren jede Woche zwei Tage durch manuelle Prüfungen, oder?" },
      { speaker: "agent", text: "Stopp. Wie schätzt du dich ein?" },
      { speaker: "user", text: self },
      { speaker: "agent", text: CLOSING },
      { speaker: "user", text: closing },
    ];
    const answer = (self: string, closing: string) =>
      JSON.stringify({
        kriterien: [
          { nr: 1, bewertung: "erfuellt", zitat: "Sie verlieren jede Woche zwei Tage durch manuelle Prüfungen", begruendung: "Beziffert." },
          { nr: 2, bewertung: "nicht", zitat: null, begruendung: "Nicht gefragt." },
          { nr: 3, bewertung: "nicht", zitat: null, begruendung: "Kein Termin." },
        ],
        selbsteinschaetzung: { zitat: self, vergleich: "Zu optimistisch." },
        abschluss: closing,
      });

    for (const [self, closing] of [["Gut.", "Ja."], ["Ok", "OK."], ["Na ja.", "Ja"]] as const) {
      test(`Selbsteinschätzung „${self}“ und Abschluss „${closing}“ als ganzer Beitrag`, () => {
        const parsed = parseTrainingAnswer(answer(self, closing), TRAINING, short(self, closing));
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.result.abschluss).toBe(closing);
        expect(parsed.result.selbsteinschaetzung?.zitat).toBe(self);
      });
    }

    test("kurzes Bruchstück eines längeren Beitrags zählt nicht", () => {
      expect(parseTrainingAnswer(answer("Gut.", "Ja"), TRAINING, short("Gut.", "Ja, ich frage früher nach einem Termin.")).ok).toBe(false);
      expect(parseTrainingAnswer(answer("Ok", "Ja."), TRAINING, short("Ok, aber nicht sehr.", "Ja.")).ok).toBe(false);
    });

    test("als Beleg für ein Kriterium bleibt ein ganzer kurzer Beitrag zu kurz", () => {
      const raw = JSON.parse(answer("Gut.", "Ja."));
      raw.kriterien[1] = { nr: 2, bewertung: "teilweise", zitat: "Ja.", begruendung: "Zugestimmt." };
      expect(parseTrainingAnswer(JSON.stringify(raw), TRAINING, short("Gut.", "Ja.")).ok).toBe(false);
    });

    test("Ablauf: die ganze Auswertung gelingt und meldet die kurze Antwort", async () => {
      const h = harness(paths, { answers: [{ text: answer("Gut.", "Ja."), isError: false }] });
      await receive(h, "conv_kurz", short("Gut.", "Ja."));
      expect((await readConversation("trainer", "conv_kurz", paths))?.status).toBe("fertig");
      expect(h.prompts).toHaveLength(1);
      expect(h.notes).toHaveLength(1);
      expect(h.notes[0]!.text).toContain(`${CLOSING}\n„Ja.“`);
      expect(h.notes[0]!.text).toContain("Selbsteinschätzung: „Gut.“");
    });
  });
});

describe("Ablauf", () => {
  test("gültige Antwort: Auswertung mit Rezeptstand, Eintrag in training.jsonl, fertig", async () => {
    const h = harness(paths);
    await receive(h);
    const record = await readConversation("trainer", "conv_1", paths);
    expect(record?.status).toBe("fertig");
    expect(record?.nachlauf).toBe("training");
    expect(record?.auswertung?.rezeptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.auswertung?.kriterien.map((k) => k.text)).toEqual(CRITERIA);
    const [entry] = await readTrainingLog("trainer", paths);
    expect(entry?.gespraech).toBe("conv_1");
    expect(entry?.rezeptHash).toBe(record!.auswertung!.rezeptHash);
    expect(entry?.kriterien.map((k) => k.bewertung)).toEqual(["erfuellt", "teilweise", "nicht"]);
    expect(entry?.abschlussfrage).toBe(CLOSING);
  });

  test("unbrauchbare Antwort, dann gültige: später neuer Versuch, ein Eintrag", async () => {
    const h = harness(paths, { answers: [{ text: "Das Gespräch war gut.", isError: false }] });
    await receive(h);
    let record = await readConversation("trainer", "conv_1", paths);
    expect(record?.status).toBe("offen");
    expect(record?.versuche).toBe(1);
    expect(record?.naechsterVersuch).toBe(h.clock.now + EVAL_RETRY_MS);
    expect(h.notes).toEqual([]);
    await h.advance(EVAL_RETRY_MS);
    record = await readConversation("trainer", "conv_1", paths);
    expect(record?.status).toBe("fertig");
    expect(h.prompts).toHaveLength(2);
    expect(await readTrainingLog("trainer", paths)).toHaveLength(1);
  });

  test("Selbsteinschätzung ohne Vergleich: unbrauchbar, später neuer Versuch; erst die vollständige Auswertung wird gespeichert und gemeldet", async () => {
    const incomplete = goodAnswer({ selbsteinschaetzung: { zitat: "den Schmerz hab ich gut getroffen, den Rest eher nicht" } });
    const h = harness(paths, { answers: [{ text: incomplete, isError: false }] });
    await receive(h);
    let record = await readConversation("trainer", "conv_1", paths);
    expect(record?.status).toBe("offen");
    expect(record?.versuche).toBe(1);
    expect(record?.auswertung).toBeUndefined();
    expect(h.notes).toEqual([]);
    expect(await readTrainingLog("trainer", paths)).toEqual([]);
    await h.advance(EVAL_RETRY_MS);
    record = await readConversation("trainer", "conv_1", paths);
    expect(record?.status).toBe("fertig");
    expect(h.prompts).toHaveLength(2);
    const entries = await readTrainingLog("trainer", paths);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.selbsteinschaetzung?.vergleich).toBe("Die Einschätzung passt zur Bewertung.");
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.text).toContain("Vergleich: Die Einschätzung passt zur Bewertung.");
  });

  test("Modellfehler, dann Neustart: der neue Prozess holt den Versuch nach", async () => {
    const first = harness(paths, { answers: [{ text: "", isError: true }] });
    await receive(first);
    expect((await readConversation("trainer", "conv_1", paths))?.versuche).toBe(1);
    first.aftercall.stop();
    const second = harness(paths, {}, first);
    await second.aftercall.resume();
    await second.advance(0);
    // Noch nicht fällig
    expect(second.prompts).toEqual([]);
    await second.advance(EVAL_RETRY_MS);
    expect(second.prompts).toHaveLength(1);
    expect((await readConversation("trainer", "conv_1", paths))?.status).toBe("fertig");
  });

  test("geworfener Modellfehler zählt wie ein Fehler; Abstände verdoppeln sich, nach MAX_EVAL_ATTEMPTS eine Meldung ohne Auswertung", async () => {
    const h = harness(paths, { answers: Array.from({ length: MAX_EVAL_ATTEMPTS }, () => new Error("weg")) });
    await receive(h);
    for (let attempt = 1; attempt < MAX_EVAL_ATTEMPTS; attempt++) {
      const record = await readConversation("trainer", "conv_1", paths);
      expect(record?.versuche).toBe(attempt);
      await h.advance(record!.naechsterVersuch! - h.clock.now);
    }
    expect(h.prompts).toHaveLength(MAX_EVAL_ATTEMPTS);
    const record = await readConversation("trainer", "conv_1", paths);
    expect(record?.status).toBe("gescheitert");
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.text).toContain("Auswertung ist mehrmals gescheitert");
    expect(h.notes[0]!.text).not.toContain("zwei Tage");
    expect(await readTrainingLog("trainer", paths)).toEqual([]);
  });

  test("Issue #566: abgeschaltet (Claude fehlt) heißt ein Aufruf, sofort eine Meldung mit Grund, auch mit vorgespulter Uhr keine Wiederholung", async () => {
    const h = harness(paths, { answers: [{ text: "", isError: true, disabled: true }] });
    await receive(h);
    const record = await readConversation("trainer", "conv_1", paths);
    expect(record?.status).toBe("gescheitert");
    expect(record?.versuche).toBe(0);
    expect(record?.naechsterVersuch).toBeNull();
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.text).toContain("Keine Auswertung, weil sie über Claude liefe und Claude hier nicht installiert oder nicht angemeldet ist");
    expect(h.notes[0]!.text).toContain("AUX_MODEL_VOICE_TRAINING");
    expect(h.notes[0]!.text).not.toContain("mehrmals gescheitert");
    // Über alle Wiederholungsabstände hinaus vorspulen: kein zweiter Aufruf, keine zweite Meldung
    for (let attempt = 0; attempt < MAX_EVAL_ATTEMPTS + 1; attempt++) await h.advance(EVAL_RETRY_MS * 2 ** attempt);
    expect(h.prompts).toHaveLength(1);
    expect(h.notes).toHaveLength(1);
    expect(h.timers.filter((t) => !t.done)).toEqual([]);
    expect(h.logs.filter((l) => /später|aufgegeben|Versuch/.test(l))).toEqual([]);
    expect(h.logs.some((l) => l.includes("Auswertung von conv_1 abgeschaltet (Claude fehlt), keine Wiederholung"))).toBe(true);
    expect(await readTrainingLog("trainer", paths)).toEqual([]);
    // Nach einem Neustart bleibt es dabei
    h.aftercall.stop();
    const second = harness(paths, {}, h);
    await second.aftercall.resume();
    await second.advance(EVAL_RETRY_MS * 2 ** MAX_EVAL_ATTEMPTS);
    expect(second.prompts).toEqual([]);
    expect(second.notes).toEqual([]);
  });

  test("leeres Protokoll und nur Trainer-Beiträge: kein Modell, kein Eintrag, kurze Meldung", async () => {
    const h = harness(paths);
    await receive(h, "conv_leer", []);
    await receive(h, "conv_stumm", [{ speaker: "agent", text: "Hallo?" }]);
    expect(h.prompts).toEqual([]);
    expect(await readTrainingLog("trainer", paths)).toEqual([]);
    expect(h.notes.map((n) => n.text.includes("kein Beitrag von dir"))).toEqual([true, true]);
    expect((await readConversation("trainer", "conv_leer", paths))?.nachlauf).toBe("leer");
  });

  test("Absturz zwischen Eintrag in training.jsonl und Statuswechsel: kein zweiter Eintrag", async () => {
    const h = harness(paths);
    await receive(h);
    const file = join(paths.dataDir, "trainer", "gespraeche", "conv_1.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    // Stand wie nach dem Schreiben des Eintrags, vor eingetragen und Meldung
    delete record.eingetragen;
    delete record.meldung;
    record.status = "offen";
    writeFileSync(file, JSON.stringify(record));
    h.aftercall.stop();
    const second = harness(paths, {}, h);
    await second.aftercall.resume();
    await second.advance(0);
    expect(second.prompts).toEqual([]);
    expect(await readTrainingLog("trainer", paths)).toHaveLength(1);
    expect(second.notes).toHaveLength(1);
  });

  test("halb geschriebene letzte Zeile in training.jsonl: wird übergangen, der neue Eintrag steht in eigener Zeile", async () => {
    writeFileSync(join(paths.dataDir, "trainer", "training.jsonl"), '{"gespraech":"conv_alt","zeit":1,');
    const h = harness(paths);
    await receive(h);
    const entries = await readTrainingLog("trainer", paths);
    expect(entries.map((e) => e.gespraech)).toEqual(["conv_1"]);
  });
});
