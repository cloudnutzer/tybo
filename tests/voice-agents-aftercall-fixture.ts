/**
 * Bausteine für die Tests der Nachlauf-Weiche (Issue #496): Ablage in einem
 * Temp-Ordner, Rezepte und Zustände als Dateien, Anrufdienst, Modell und
 * Zustellung als Attrappen, Zeitgeber von Hand. Kein Netz, kein Modell.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuxResult } from "../src/lib/aux-model";
import type { TranscriptLine } from "../src/lib/phone";
import { createAftercall, type AftercallTarget, type DeliveryOutcome } from "../src/lib/voice-agents/aftercall";
import type { VoiceAgentPaths } from "../src/lib/voice-agents/base";
import { baseRecipe } from "./voice-agents-elevenlabs-fixture";

export const CRITERIA = ["Schmerz mit Zahl belegt", "Entscheidungsweg geklärt", "nächsten Schritt mit Datum vereinbart"];
export const CLOSING = "Welchen Satz sagst du morgen anders?";

export function expertRecipe(kennung = "trainer", overrides: Record<string, unknown> = {}): any {
  return {
    ...baseRecipe(),
    kennung,
    name: "Verkaufstrainer",
    vorlage: "experte",
    gedaechtnis: "keins",
    nachlauf: { zusammenfassung: false, faden: false, kalendervorschlag: false, anruferMerken: false, training: true, ziel: "direktchat" },
    training: { rollen: ["Einkauf"], einwaende: ["Kein Budget"], kriterien: [...CRITERIA], selbsteinschaetzung: true, abschlussfrage: CLOSING },
    ...overrides,
  };
}

export function jarvisRecipe(kennung = "helfer"): any {
  return { ...baseRecipe(), kennung, gedaechtnis: "keins" };
}

/** Übungsgespräch: Übender belegt Kriterium 1, teilweise 2, schätzt sich ein und antwortet auf die Abschlussfrage */
export const PRACTICE: TranscriptLine[] = [
  { speaker: "agent", text: "Willst du üben oder Fragen stellen?" },
  { speaker: "user", text: "Üben. Sie verlieren jede Woche zwei Tage durch manuelle Prüfungen, oder?" },
  { speaker: "agent", text: "Ja, ungefähr. Und wer entscheidet bei uns? Das weiß ich nicht genau." },
  { speaker: "user", text: "Wer außer Ihnen ist an der Entscheidung beteiligt?" },
  { speaker: "agent", text: "Stopp. Wie schätzt du dich ein?" },
  { speaker: "user", text: "Ich würde sagen, den Schmerz hab ich gut getroffen, den Rest eher nicht." },
  { speaker: "agent", text: CLOSING },
  { speaker: "user", text: "Ich frage früher nach einem Termin für den nächsten Schritt." },
];

export function goodAnswer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kriterien: [
      { nr: 1, bewertung: "erfuellt", zitat: "Sie verlieren jede Woche zwei Tage durch manuelle Prüfungen", begruendung: "Der Schmerz ist beziffert." },
      { nr: 2, bewertung: "teilweise", zitat: "Wer außer Ihnen ist an der Entscheidung beteiligt?", begruendung: "Gefragt, aber nicht geklärt." },
      { nr: 3, bewertung: "nicht", zitat: null, begruendung: "Kein Termin vereinbart." },
    ],
    selbsteinschaetzung: { zitat: "den Schmerz hab ich gut getroffen, den Rest eher nicht", vergleich: "Die Einschätzung passt zur Bewertung." },
    abschluss: "Ich frage früher nach einem Termin für den nächsten Schritt.",
    ...overrides,
  });
}

export function tempPaths(): { root: string; paths: Required<VoiceAgentPaths> } {
  const root = mkdtempSync(join(tmpdir(), "aftercall-"));
  const paths = { configDir: join(root, "config", "voice-agents"), dataDir: join(root, "data", "voice-agents") };
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });
  return { root, paths };
}

export function writeRecipe(paths: Required<VoiceAgentPaths>, recipe: any): void {
  writeFileSync(join(paths.configDir, `${recipe.kennung}.json`), typeof recipe === "string" ? recipe : JSON.stringify(recipe, null, 2));
}

export function writeState(paths: Required<VoiceAgentPaths>, kennung: string, state: Record<string, unknown> | string): void {
  mkdirSync(join(paths.dataDir, kennung), { recursive: true });
  const content = typeof state === "string" ? state : JSON.stringify({ erstelltAm: "2026-11-01T00:00:00Z", geaendertAm: "2026-11-01T00:00:00Z", ...state });
  writeFileSync(join(paths.dataDir, kennung, "state.json"), content);
}

export interface Harness {
  aftercall: ReturnType<typeof createAftercall>;
  phoneCalls: { id: string; lines: TranscriptLine[] }[];
  prompts: string[];
  notes: { target: AftercallTarget; text: string }[];
  logs: string[];
  timers: { run: () => void; ms: number; done: boolean }[];
  clock: { now: number };
  /** Fällige Zeitgeber auslösen und warten, bis alles steht */
  advance(ms: number): Promise<void>;
}

export interface HarnessOptions {
  answers?: (AuxResult | Error)[];
  outcomes?: (DeliveryOutcome | Error)[];
  phoneAgentId?: string;
  start?: number;
}

export function harness(paths: VoiceAgentPaths, options: HarnessOptions = {}, shared?: Pick<Harness, "clock">): Harness {
  const h: Harness = {
    phoneCalls: [],
    prompts: [],
    notes: [],
    logs: [],
    timers: [],
    clock: shared?.clock ?? { now: options.start ?? Date.parse("2026-11-08T10:00:00Z") },
    aftercall: null as never,
    async advance(ms) {
      h.clock.now += ms;
      for (const timer of h.timers) {
        if (!timer.done && timer.ms <= h.clock.now) {
          timer.done = true;
          timer.run();
        }
      }
      await h.aftercall.idle();
    },
  };
  const answers = [...(options.answers ?? [])];
  const outcomes = [...(options.outcomes ?? [])];
  h.aftercall = createAftercall({
    paths,
    phone: () => ({
      receiveTranscript: async (id, lines) => {
        h.phoneCalls.push({ id, lines });
        return "accepted";
      },
    }),
    phoneAgentId: () => options.phoneAgentId,
    evaluate: async (prompt) => {
      h.prompts.push(prompt);
      const next = answers.shift() ?? { text: goodAnswer(), isError: false };
      if (next instanceof Error) throw next;
      return next;
    },
    notify: async (target, text) => {
      h.notes.push({ target, text });
      const next = outcomes.shift() ?? "delivered";
      if (next instanceof Error) throw next;
      return next;
    },
    timeZone: "Europe/Berlin",
    now: () => h.clock.now,
    // Zeitpunkt statt Dauer: advance löst aus, was fällig ist
    setTimer: (run, ms) => {
      const timer = { run, ms: h.clock.now + ms, done: false };
      h.timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => void ((handle as { done: boolean }).done = true),
    log: (line) => void h.logs.push(line),
  });
  return h;
}
