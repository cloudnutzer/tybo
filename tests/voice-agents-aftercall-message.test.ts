/**
 * Issue #496, Aufgabe 3: Meldung mit Verlauf (letzte fünf Übungen je
 * Kriterium) an nachlauf.ziel über die Outbox. Verlauf bei sechs Übungen,
 * verspäteter Auswertung und geänderten Kriterien; Zustellung abgelehnt,
 * unklar und unterbrochen; Meldung nur als display_only, kein Rohprotokoll.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aftercallNotify } from "../src/app/bot-choices";
import type { Message } from "../src/lib/store/types";
import { sendAndRecord, type OutboxDeps, type SendAndRecordInput } from "../src/lib/outbox";
import { MAX_SEND_ATTEMPTS, readConversation, SEND_RETRY_MS, TRAINING_SOURCE } from "../src/lib/voice-agents/aftercall";
import { criterionHistory, type TrainingEntry, trainingMessage } from "../src/lib/voice-agents/training";
import { CLOSING, CRITERIA, expertRecipe, goodAnswer, harness, PRACTICE, tempPaths, writeRecipe, writeState } from "./voice-agents-aftercall-fixture";

let root: string;
let paths: ReturnType<typeof tempPaths>["paths"];

beforeEach(() => {
  ({ root, paths } = tempPaths());
  writeRecipe(paths, expertRecipe());
  writeState(paths, "trainer", { agentId: "agent_trainer" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const HOUR = 60 * 60_000;
const BASE = Date.parse("2026-11-01T09:00:00Z");

function answerWith(ratings: string[]): string {
  const quotes = ["Sie verlieren jede Woche zwei Tage durch manuelle Prüfungen", "Wer außer Ihnen ist an der Entscheidung beteiligt?", "Ich frage früher nach einem Termin"];
  return goodAnswer({ kriterien: ratings.map((bewertung, i) => ({ nr: i + 1, bewertung, zitat: bewertung === "nicht" ? null : quotes[i], begruendung: "" })) });
}

describe("Meldung", () => {
  test("Inhalt: Kopf mit Name und Zeit, Bewertung, Zitat, Begründung, Selbsteinschätzung, Abschluss; Ziel aus dem Rezept", async () => {
    writeRecipe(paths, expertRecipe("trainer", { nachlauf: { zusammenfassung: false, faden: false, kalendervorschlag: false, anruferMerken: false, training: true, ziel: "topic:7" } }));
    const h = harness(paths);
    await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer", startedAt: Date.parse("2026-11-08T09:30:00Z") });
    await h.aftercall.idle();
    expect(h.notes).toHaveLength(1);
    const { target, text } = h.notes[0]!;
    expect(target).toBe("topic:7");
    expect(text).toStartWith("Übung mit Verkaufstrainer vom 08.11.2026, 10:30");
    expect(text).toContain(`1. ${CRITERIA[0]}: erfüllt\n   „Sie verlieren jede Woche zwei Tage durch manuelle Prüfungen“\n   Der Schmerz ist beziffert.`);
    expect(text).toContain(`2. ${CRITERIA[1]}: teilweise`);
    expect(text).toContain(`3. ${CRITERIA[2]}: nicht erfüllt\n   Kein Termin vereinbart.`);
    expect(text).toContain("Selbsteinschätzung: „den Schmerz hab ich gut getroffen, den Rest eher nicht“\nVergleich: Die Einschätzung passt zur Bewertung.");
    expect(text).toContain(`${CLOSING}\n„Ich frage früher nach einem Termin für den nächsten Schritt.“`);
    // Nur Zitate des Übenden, kein Rohprotokoll
    expect(text).not.toContain("Und wer entscheidet bei uns");
    expect(text).not.toContain("Willst du üben");
    // Erste Übung: kein Verlauf
    expect(text).not.toContain("Letzte");
  });

  test("ohne Selbsteinschätzung und Abschlussantwort", async () => {
    const h = harness(paths, { answers: [{ text: goodAnswer({ selbsteinschaetzung: null, abschluss: null }), isError: false }] });
    await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" });
    await h.aftercall.idle();
    expect(h.notes[0]!.text).toContain("Selbsteinschätzung: nicht genannt.");
    expect(h.notes[0]!.text).toContain(`${CLOSING}\nkeine Antwort`);
  });

  test("selbsteinschaetzung false: keine Zeile dazu", async () => {
    writeRecipe(paths, expertRecipe("trainer", { training: { rollen: ["Einkauf"], einwaende: ["Kein Budget"], kriterien: [...CRITERIA], selbsteinschaetzung: false, abschlussfrage: CLOSING } }));
    const h = harness(paths);
    await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" });
    await h.aftercall.idle();
    expect(h.notes[0]!.text).not.toContain("Selbsteinschätzung");
  });
});

describe("Verlauf", () => {
  test("sechs Übungen: die Meldung der sechsten zeigt die letzten fünf, älteste zuerst", async () => {
    const ratings = ["nicht", "teilweise", "erfuellt", "nicht", "teilweise", "erfuellt"];
    const h = harness(paths, { answers: ratings.map((r) => ({ text: answerWith([r, "nicht", "nicht"]), isError: false })) });
    for (const [i] of ratings.entries()) {
      await h.aftercall.receiveTranscript(`conv_${i + 1}`, PRACTICE, { agentId: "agent_trainer", startedAt: BASE + i * HOUR });
      await h.aftercall.idle();
    }
    const last = h.notes.at(-1)!.text;
    expect(last).toContain(`1. ${CRITERIA[0]}: erfüllt`);
    expect(last).toContain("Letzte 5 Übungen, älteste zuerst: teilweise, erfüllt, nicht erfüllt, teilweise, erfüllt");
    expect(last).toContain("Letzte 5 Übungen, älteste zuerst: nicht erfüllt, nicht erfüllt, nicht erfüllt, nicht erfüllt, nicht erfüllt");
  });

  test("verspätete Auswertung: Platz nach Gesprächszeit, nicht nach Auswertungszeit", async () => {
    const h = harness(paths, {
      answers: [
        { text: "", isError: true },
        { text: answerWith(["erfuellt", "nicht", "nicht"]), isError: false },
        { text: answerWith(["teilweise", "nicht", "nicht"]), isError: false },
      ],
    });
    // Gespräch A (früher) scheitert erst, B (später) wird sofort ausgewertet
    await h.aftercall.receiveTranscript("conv_a", PRACTICE, { agentId: "agent_trainer", startedAt: BASE });
    await h.aftercall.idle();
    await h.aftercall.receiveTranscript("conv_b", PRACTICE, { agentId: "agent_trainer", startedAt: BASE + HOUR });
    await h.aftercall.idle();
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.text).not.toContain("Letzte");
    await h.advance(60_000);
    // A kommt nach B an, sein Verlauf endet aber bei A selbst (B liegt später)
    expect(h.notes).toHaveLength(2);
    expect(h.notes[1]!.text).toContain(`1. ${CRITERIA[0]}: teilweise`);
    expect(h.notes[1]!.text).not.toContain("Letzte");
    // Eine dritte Übung sieht A vor B
    const lines = readFileSync(join(paths.dataDir, "trainer", "training.jsonl"), "utf8").split("\n");
    // Eine Zeile je Eintrag, keine Leerzeilen dazwischen
    expect(lines).toHaveLength(3);
    const entries = lines.filter(Boolean).map((line) => JSON.parse(line) as TrainingEntry);
    const third: TrainingEntry = { ...entries[0]!, gespraech: "conv_c", zeit: BASE + 2 * HOUR, kriterien: entries[0]!.kriterien.map((k) => ({ ...k, bewertung: "nicht" })) };
    expect(criterionHistory(entries, third)[0]).toEqual(["teilweise", "erfuellt", "nicht"]);
  });

  test("geänderte Kriterien: alte Bewertungen zählen nur, wo der Wortlaut gleich blieb", async () => {
    const h = harness(paths, { answers: [{ text: answerWith(["nicht", "erfuellt", "nicht"]), isError: false }, { text: answerWith(["erfuellt", "erfuellt", "teilweise"]), isError: false }] });
    await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer", startedAt: BASE });
    await h.aftercall.idle();
    const changed = [CRITERIA[0]!, "Budget und Zeitplan geklärt", CRITERIA[2]!];
    writeRecipe(paths, expertRecipe("trainer", { training: { rollen: ["Einkauf"], einwaende: ["Kein Budget"], kriterien: changed, selbsteinschaetzung: true, abschlussfrage: CLOSING } }));
    await h.aftercall.receiveTranscript("conv_2", PRACTICE, { agentId: "agent_trainer", startedAt: BASE + HOUR });
    await h.aftercall.idle();
    const text = h.notes[1]!.text;
    expect(text).toContain(`1. ${CRITERIA[0]}: erfüllt`);
    expect(text).toContain("2. Budget und Zeitplan geklärt: erfüllt");
    const historyLines = text.split("\n").filter((line) => line.includes("Letzte"));
    // Kriterium 1 und 3 mit zwei Übungen, Kriterium 2 neu ohne Verlauf
    expect(historyLines).toEqual(["   Letzte 2 Übungen, älteste zuerst: nicht erfüllt, erfüllt", "   Letzte 2 Übungen, älteste zuerst: nicht erfüllt, teilweise"]);
    // Gespeichert sind die verwendeten Kriterien samt Rezeptstand
    const record1 = await readConversation("trainer", "conv_1", paths);
    const record2 = await readConversation("trainer", "conv_2", paths);
    expect(record1?.auswertung?.kriterien.map((k) => k.text)).toEqual(CRITERIA);
    expect(record2?.auswertung?.kriterien.map((k) => k.text)).toEqual(changed);
    expect(record1?.auswertung?.rezeptHash).not.toBe(record2?.auswertung?.rezeptHash);
  });

  test("Verlauf eines anderen Rezepts zählt nicht", () => {
    const entry = (gespraech: string, zeit: number): TrainingEntry => ({
      gespraech, zeit, ausgewertetAm: "", rezeptHash: "h", abschlussfrage: CLOSING, abschluss: null,
      kriterien: CRITERIA.map((text) => ({ text, bewertung: "erfuellt" as const, zitat: "x y z", begruendung: "" })),
    });
    // training.jsonl liegt je Rezept; criterionHistory sieht nur, was es bekommt
    expect(criterionHistory([], entry("c1", 1))[0]).toEqual(["erfuellt"]);
    expect(trainingMessage("X", entry("c1", BASE), [["erfuellt"]], "Europe/Berlin")).not.toContain("Letzte");
  });
});

describe("Zustellung", () => {
  test("sicher abgelehnt: später erneut, höchstens MAX_SEND_ATTEMPTS mal, ohne neue Auswertung", async () => {
    const h = harness(paths, { outcomes: Array.from({ length: MAX_SEND_ATTEMPTS }, () => "rejected" as const) });
    await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" });
    await h.aftercall.idle();
    for (let i = 1; i < MAX_SEND_ATTEMPTS; i++) await h.advance(SEND_RETRY_MS);
    await h.advance(SEND_RETRY_MS);
    expect(h.notes).toHaveLength(MAX_SEND_ATTEMPTS);
    expect(new Set(h.notes.map((n) => n.text)).size).toBe(1);
    expect(h.prompts).toHaveLength(1);
    const record = await readConversation("trainer", "conv_1", paths);
    expect(record?.status).toBe("gescheitert");
    expect(record?.meldung?.stand).toBe("abgelehnt");
  });

  test("abgelehnt, dann Neustart, dann zugestellt", async () => {
    const first = harness(paths, { outcomes: ["rejected"] });
    await first.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" });
    await first.aftercall.idle();
    first.aftercall.stop();
    const second = harness(paths, {}, first);
    await second.aftercall.resume();
    await second.advance(SEND_RETRY_MS);
    expect(second.notes).toHaveLength(1);
    expect(second.prompts).toEqual([]);
    expect((await readConversation("trainer", "conv_1", paths))?.meldung?.stand).toBe("zugestellt");
  });

  test("unklar und geworfen: kein zweiter Versand", async () => {
    const h = harness(paths, { outcomes: ["unclear", new Error("Netz")] });
    await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" });
    await h.aftercall.receiveTranscript("conv_2", PRACTICE, { agentId: "agent_trainer" });
    await h.aftercall.idle();
    await h.advance(SEND_RETRY_MS * 10);
    expect(h.notes).toHaveLength(2);
    for (const id of ["conv_1", "conv_2"]) {
      const record = await readConversation("trainer", id, paths);
      expect(record?.status).toBe("fertig");
      expect(record?.meldung?.stand).toBe("unklar");
    }
  });

  test("Neustart mitten im Versand (Stand sendet): kein zweiter Versand", async () => {
    const h = harness(paths);
    await h.aftercall.receiveTranscript("conv_1", PRACTICE, { agentId: "agent_trainer" });
    await h.aftercall.idle();
    const file = join(paths.dataDir, "trainer", "gespraeche", "conv_1.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.status = "offen";
    record.meldung.stand = "sendet";
    writeFileSync(file, JSON.stringify(record));
    h.aftercall.stop();
    const second = harness(paths, {}, h);
    await second.aftercall.resume();
    await second.advance(0);
    expect(second.notes).toEqual([]);
    const after = await readConversation("trainer", "conv_1", paths);
    expect(after?.status).toBe("fertig");
    expect(after?.meldung?.stand).toBe("unklar");
  });
});

describe("Ziel und Outbox (aftercallNotify)", () => {
  const TG = { TELEGRAM_BOT_TOKEN: "123:t", TELEGRAM_USER_ID: "4242" };

  function capture(result: object = { sent: true, recorded: true }) {
    const inputs: SendAndRecordInput[] = [];
    const send = async (input: SendAndRecordInput) => (inputs.push(input), result as never);
    return { inputs, send };
  }

  test("direktchat ohne chatId, topic:<n> mit Telegram als Topic, Absender training, Klartext", async () => {
    const { inputs, send } = capture();
    expect(await aftercallNotify(send, TG)("direktchat", "Text")).toBe("delivered");
    await aftercallNotify(send, TG)("topic:7", "Text");
    expect(inputs).toEqual([
      { text: "Text", source: TRAINING_SOURCE, format: "plain" },
      { topicId: 7, text: "Text", source: TRAINING_SOURCE, format: "plain" },
    ]);
  });

  test("ohne Telegram geht auch topic:<n> in den Web-Direktchat", async () => {
    const { inputs, send } = capture({ sent: false, recorded: true });
    expect(await aftercallNotify(send, {})("topic:7", "Text")).toBe("delivered");
    expect(inputs[0]).toEqual({ text: "Text", source: TRAINING_SOURCE, format: "plain" });
  });

  test("Ausgang: abgelehnt bei ungültiger Eingabe oder 4xx, sonst unklar", async () => {
    expect(await aftercallNotify(capture({ sent: false, recorded: false, error: { kind: "invalid", message: "x" } }).send, TG)("direktchat", "T")).toBe("rejected");
    expect(await aftercallNotify(capture({ sent: false, recorded: false, error: { kind: "send", message: "x", rejected: true } }).send, TG)("direktchat", "T")).toBe("rejected");
    expect(await aftercallNotify(capture({ sent: false, recorded: false, error: { kind: "send", message: "x" } }).send, TG)("direktchat", "T")).toBe("unclear");
  });

  test("echte Outbox ohne Telegram: Meldung landet nur als display_only im Web-Direktchat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aftercall-outbox-"));
    try {
      const recorded: Message[] = [];
      const fetched: string[] = [];
      const deps: OutboxDeps = {
        botToken: "",
        userId: "",
        groupId: null,
        outboxDir: join(dir, "outbox"),
        fetch: async (url) => (fetched.push(url), new Response("{}")),
        record: async (m) => (recorded.push(m), true),
        log: () => {},
        newId: () => crypto.randomUUID(),
      };
      const h = harness(paths);
      // Statt der Attrappe die echte Outbox
      const notify = aftercallNotify((input) => sendAndRecord(input, deps), {});
      expect(await notify("direktchat", "Übung mit Verkaufstrainer")).toBe("delivered");
      expect(fetched).toEqual([]);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.chat_id).toBe("web");
      expect(recorded[0]!.metadata).toMatchObject({ display_only: true, source: TRAINING_SOURCE });
      h.aftercall.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
