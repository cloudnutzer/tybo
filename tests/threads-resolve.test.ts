/**
 * Issue #291: offene Fäden still schließen, wenn der Nutzer antwortet
 * (src/lib/threads/resolve.ts), und die Reihenfolge in noteTurnForThreads.
 * callAux ist immer eine Attrappe, kein echtes Modell.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { AuxPurpose } from "../src/lib/aux-model";
import { noteTurnForThreads, processTurnForThreads, threadsWorkPending, type ThreadDetectDeps } from "../src/lib/threads/detect";
import {
  buildResolvePrompt,
  parseResolveVerdict,
  resolveThreads,
  RESOLVE_REPLY_CHARS,
  RESOLVE_USER_CHARS,
  THREADS_RESOLVE_MAX,
  type ThreadResolveDeps,
} from "../src/lib/threads/resolve";
import { createThread, listAllThreads, listOpenThreads, setThreadsFileForTests } from "../src/lib/threads/store";

const web = { type: "web" as const, conversationId: "0f1e2d3c-4b5a-4c6d-8e7f-001122334455" };
const topic = { type: "telegram" as const, chatId: "-100123", topicId: 7 };
const direct = { type: "telegram" as const, chatId: "4242" };

let dir: string;
let calls: { purpose: AuxPurpose; prompt: string; opts: any }[];
let logs: string[];
let consoleSpies: ReturnType<typeof spyOn>[];

type AuxReply = string | (() => Promise<{ text: string; isError: boolean }>);

function deps(reply: AuxReply, extra: Partial<ThreadResolveDeps & ThreadDetectDeps> = {}): Partial<ThreadResolveDeps & ThreadDetectDeps> {
  return {
    callAux: async (purpose, prompt, opts) => {
      calls.push({ purpose, prompt, opts });
      return typeof reply === "string" ? { text: reply, isError: false } : reply();
    },
    listChoices: async () => [],
    pendingAskUser: async () => [],
    now: () => new Date("2026-10-15T08:00:00Z"),
    timeZone: () => "Europe/Berlin",
    env: {},
    log: m => logs.push(m),
    ...extra,
  };
}

const answered = (...nrs: number[]) => JSON.stringify({ answered: nrs });

async function make(conversation: any, question: string, topicText = "Reiseziel") {
  const r = await createThread({ conversation, topic: topicText, context: "Kontext.", question });
  if (r.status !== "created") throw new Error("nicht angelegt");
  return r.thread;
}

/** Wartet, bis cond gilt (Nacharbeit läuft im Hintergrund); feste Wartezeiten scheitern unter Last */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("Bedingung nicht erreicht");
    await new Promise(r => setTimeout(r, 5));
  }
}

const turn = (userText: string, conversation: any = topic, reply = "Gut, dann plane ich das so.") => ({ conversation, userText, reply });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-threads-resolve-"));
  setThreadsFileForTests(join(dir, "threads.json"));
  calls = [];
  logs = [];
  consoleSpies = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {})];
});

afterEach(() => {
  for (const s of consoleSpies) s.mockRestore();
  setThreadsFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function consoleText(): string {
  return consoleSpies.flatMap(s => s.mock.calls.map((c: unknown[]) => c.map(String).join(" "))).join("\n");
}

describe("Auflösen", () => {
  test("passende Antwort schließt genau den genannten Faden, als beantwortet", async () => {
    const a = await make(topic, "Hamburg oder München?");
    const b = await make(topic, "Zug oder Auto?", "Anreise");
    const out = await resolveThreads(turn("Hamburg, wegen der Elbphilharmonie."), deps(answered(a.nr)));
    expect(out).toEqual({ status: "closed", nrs: [a.nr] });
    expect(calls.length).toBe(1);
    expect(calls[0].purpose).toBe("threads");
    expect(calls[0].opts).toEqual({ timeoutMs: 60_000, quiet: true });
    expect((await listOpenThreads(topic)).map(t => t.id)).toEqual([b.id]);
    const closed = (await listAllThreads()).find(t => t.id === a.id)!;
    expect(closed.state).toBe("closed");
    expect(closed.closedReason).toBe("beantwortet");
    expect(typeof closed.closedAt).toBe("number");
  });

  test("Antwort zu anderem Thema: Modell nennt nichts, nichts wird geschlossen", async () => {
    await make(topic, "Hamburg oder München?");
    const out = await resolveThreads(turn("Wie wird das Wetter morgen?"), deps(answered()));
    expect(out).toEqual({ status: "none" });
    expect((await listOpenThreads(topic)).length).toBe(1);
  });

  test("Fehler schließen nichts: Ausnahme, isError, ungültiges JSON, falsches Schema", async () => {
    const a = await make(topic, "Hamburg oder München?");
    const cases: [AuxReply, string][] = [
      [async () => { throw new Error("weg"); }, "fehler"],
      [async () => ({ text: answered(a.nr), isError: true }), "fehler"],
      ["kein JSON", "ungültige Antwort"],
      [JSON.stringify({ answered: String(a.nr) }), "ungültige Antwort"],
      [JSON.stringify({ answered: [a.nr, "2"] }), "ungültige Antwort"],
      [JSON.stringify({ answered: [1.5] }), "ungültige Antwort"],
      [JSON.stringify({ answered: [0] }), "ungültige Antwort"],
      [JSON.stringify([a.nr]), "ungültige Antwort"],
      [JSON.stringify({ closed: [a.nr] }), "ungültige Antwort"],
      // eingebettete Objekte zählen nicht: Array als Wurzel, abgeschnittenes JSON, Text drumherum
      [`[{"answered":[${a.nr}]}]`, "ungültige Antwort"],
      [`[{"answered":[${a.nr}]}`, "ungültige Antwort"],
      [`Ergebnis: {"answered":[${a.nr}]}`, "ungültige Antwort"],
    ];
    for (const [reply, reason] of cases) {
      expect(await resolveThreads(turn("Hamburg."), deps(reply))).toEqual({ status: "failed", reason: reason as any });
    }
    expect((await listOpenThreads(topic)).map(t => t.id)).toEqual([a.id]);
  });

  test("Zeitüberschreitung: nichts geschlossen, auch nicht durch das verspätete Ergebnis", async () => {
    const a = await make(topic, "Hamburg oder München?");
    let release!: () => void;
    const late = new Promise<void>(r => (release = r));
    const out = await resolveThreads(
      turn("Hamburg."),
      deps(async () => {
        await late;
        return { text: answered(a.nr), isError: false };
      }, { timeoutMs: -4_990 })
    );
    expect(out).toEqual({ status: "failed", reason: "zeitüberschreitung" });
    release();
    await new Promise(r => setTimeout(r, 30));
    expect((await listOpenThreads(topic)).map(t => t.id)).toEqual([a.id]);
  });

  test("Nummer eines Fadens aus einem anderen Gespräch wird ignoriert", async () => {
    const own = await make(topic, "Hamburg oder München?");
    const other = await make(direct, "Soll ich den Widerspruch aufsetzen?", "Versicherung");
    const webThread = await make(web, "Variante A oder B?", "Pipeline");
    const out = await resolveThreads(turn("Ja, mach das. Und B."), deps(answered(other.nr, webThread.nr, 999)));
    expect(out).toEqual({ status: "none" });
    expect((await listOpenThreads()).length).toBe(3);
    // nur die eigene Auswahl liegt dem Modell vor
    expect(calls[0].prompt).toContain(`Nr. ${own.nr}: Thema: Reiseziel | Frage: Hamburg oder München?`);
    expect(calls[0].prompt).not.toContain("Widerspruch");
    expect(calls[0].prompt).not.toContain("Variante A");
  });

  test("ohne offene Fäden im Gespräch kein Aufruf", async () => {
    await make(direct, "Soll ich den Widerspruch aufsetzen?");
    expect(await resolveThreads(turn("Hamburg."), deps(answered(1)))).toEqual({ status: "no-threads" });
    expect(calls.length).toBe(0);
  });

  test("THREADS=off: kein Aufruf", async () => {
    await make(topic, "Hamburg oder München?");
    for (const value of ["off", "OFF", " Off "]) {
      expect(await resolveThreads(turn("Hamburg."), deps(answered(1), { env: { THREADS: value } }))).toEqual({ status: "off" });
    }
    expect(calls.length).toBe(0);
  });

  test("höchstens 10 Fäden, die neuesten; Nummern außerhalb der Auswahl zählen nicht", async () => {
    const all = [];
    for (let i = 0; i < 12; i++) {
      all.push(await make(topic, `Frage ${i}?`, `Thema ${i}`));
      await new Promise(r => setTimeout(r, 2));
    }
    const oldest = all[0];
    const newest = all[11];
    const out = await resolveThreads(turn("Antwort."), deps(answered(oldest.nr, newest.nr)));
    expect(out).toEqual({ status: "closed", nrs: [newest.nr] });
    const prompt = calls[0].prompt;
    expect(prompt.match(/^- Nr\. /gm)?.length).toBe(THREADS_RESOLVE_MAX);
    expect(prompt).not.toContain("Frage 0?");
    expect(prompt).not.toContain("Frage 1?");
    expect(prompt).toContain("Frage 2?");
    expect((await listOpenThreads(topic)).some(t => t.id === oldest.id)).toBe(true);
  });

  test("Eingabegrenzen: Ende der Nutzer-Nachricht, Anfang der Antwort", () => {
    const userText = "§".repeat(50) + "B".repeat(RESOLVE_USER_CHARS);
    const reply = "C".repeat(RESOLVE_REPLY_CHARS) + "¤".repeat(50);
    const prompt = buildResolvePrompt({ userText, reply, threads: [] });
    expect(prompt).toContain("B".repeat(RESOLVE_USER_CHARS));
    expect(prompt).not.toContain("§");
    expect(prompt).toContain("C".repeat(RESOLVE_REPLY_CHARS));
    expect(prompt).not.toContain("¤");
    expect(prompt).toContain("Sei zurückhaltend");
    expect(prompt).toContain("anderen Thema schließt nichts");
  });

  test("Ausgabe streng: Doppelte werden zusammengefasst, nur ein umschließender Code-Block geht", () => {
    expect(parseResolveVerdict('{"answered":[3,3,4]}')).toEqual([3, 4]);
    expect(parseResolveVerdict('```json\n{"answered":[]}\n```')).toEqual([]);
    expect(parseResolveVerdict('{"answered":null}')).toBeNull();
    expect(parseResolveVerdict('[{"answered":[1]}]')).toBeNull();
    expect(parseResolveVerdict('[{"answered":[1]}')).toBeNull();
    expect(parseResolveVerdict('Ergebnis: {"answered":[1]}')).toBeNull();
    expect(parseResolveVerdict('```json\n[{"answered":[1]}]\n```')).toBeNull();
  });

  test("schon geschlossener Faden behält seinen Grund", async () => {
    const a = await make(topic, "Hamburg oder München?");
    const { closeThreads } = await import("../src/lib/threads/store");
    await closeThreads(topic, [a.nr], "von Hand");
    // Liste veraltet (vor dem Schließen gelesen): die Ablage prüft unter der Sperre erneut
    const out = await resolveThreads(turn("Hamburg."), deps(answered(a.nr), { listOpenThreads: async () => [a] }));
    expect(out).toEqual({ status: "none" });
    expect((await listAllThreads())[0].closedReason).toBe("von Hand");
  });

  test("Schreibfehler beim Schließen: Ergebnis fehler, nichts halb geschlossen", async () => {
    const a = await make(topic, "Hamburg oder München?");
    const out = await resolveThreads(turn("Hamburg."), deps(answered(a.nr), { closeThreads: async () => { throw new Error("voll"); } }));
    expect(out).toEqual({ status: "failed", reason: "fehler" });
    expect((await listOpenThreads(topic)).length).toBe(1);
  });

  test("Schreibfehler in der echten Ablage: zwei Fäden gemeinsam, beide bleiben offen", async () => {
    const a = await make(topic, "Hamburg oder München?");
    const b = await make(topic, "Zug oder Auto?", "Anreise");
    const file = join(dir, "threads.json");
    const realRename = fsp.rename;
    const spy = spyOn(fsp, "rename").mockImplementation(async (from: any, to: any) => {
      if (to === file) throw Object.assign(new Error("Platte voll"), { code: "ENOSPC" });
      return realRename(from, to);
    });
    let out;
    try {
      out = await resolveThreads(turn("Hamburg, mit dem Zug."), deps(answered(a.nr, b.nr)));
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(out).toEqual({ status: "failed", reason: "fehler" });
    const stored = JSON.parse(readFileSync(file, "utf-8"));
    for (const t of [a, b]) expect(stored.threads[t.id].state).toBe("open");
    expect((await listOpenThreads(topic)).map(t => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("ausstehendes Aux-Ergebnis nach kaputter Ablage trifft keinen neuen Faden", async () => {
    const a = await make(topic, "Hamburg oder München?");
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let asked!: () => void;
    const started = new Promise<void>(r => { asked = r; });
    const pending = resolveThreads(turn("Hamburg."), deps(async () => {
      asked();
      await gate;
      return { text: answered(a.nr), isError: false };
    }));
    await started;
    // währenddessen geht die Ablage kaputt und im selben Gespräch kommt ein neuer Faden dazu
    writeFileSync(join(dir, "threads.json"), "{kaputt");
    const fresh = await make(topic, "Zug oder Auto?", "Anreise");
    expect(fresh.nr).not.toBe(a.nr);
    release();
    expect(await pending).toEqual({ status: "none" });
    expect((await listOpenThreads(topic)).map(t => t.id)).toEqual([fresh.id]);
  });

  test("Log ohne Inhalte: nur Kennungen und Gründe", async () => {
    const a = await make(topic, "Hamburg oder München?");
    await resolveThreads(turn("Hamburg, wegen der Elbphilharmonie."), deps(answered(a.nr)));
    await resolveThreads(turn("Hamburg, wegen der Elbphilharmonie."), deps("kaputt", { listOpenThreads: async () => [a] }));
    const text = [...logs, consoleText()].join("\n");
    expect(text).toContain(a.id);
    expect(text).toContain("beantwortet");
    for (const secret of ["Hamburg", "München", "Elbphilharmonie", "Reiseziel"]) expect(text).not.toContain(secret);
  });
});

describe("Reihenfolge in noteTurnForThreads", () => {
  const QUESTION_REPLY = "Erledigt, Hamburg ist gebucht. Soll ich auch das Hotel buchen?";
  const openJSON = JSON.stringify({ open: true, topic: "Hotel", context: "Hotel in Hamburg.", question: "Soll ich auch das Hotel buchen?", deadline: null });

  test("erst auflösen, dann erkennen: eine Antwort schließt einen Faden und öffnet einen neuen", async () => {
    const a = await make(topic, "Hamburg oder München?");
    const replies = [answered(a.nr), openJSON];
    await processTurnForThreads(
      { ...turn("Hamburg.", topic, QUESTION_REPLY), turnStartedAt: Date.now() - 1_000 },
      deps(async () => ({ text: replies.shift()!, isError: false }))
    );
    expect(calls.length).toBe(2);
    expect(calls[0].prompt).toContain("offene Fragen beantwortet");
    expect(calls[1].prompt).toContain("echten, offenen Frage");
    const open = await listOpenThreads(topic);
    expect(open.map(t => t.question)).toEqual(["Soll ich auch das Hotel buchen?"]);
    expect((await listAllThreads()).find(t => t.id === a.id)?.closedReason).toBe("beantwortet");
  });

  test("Auflösen läuft auch ohne Frage am Ende der Antwort (kein Vorfilter)", async () => {
    const a = await make(topic, "Hamburg oder München?");
    await processTurnForThreads({ ...turn("Hamburg.", topic, "Alles klar, ich plane Hamburg."), turnStartedAt: Date.now() }, deps(answered(a.nr)));
    expect(calls.length).toBe(1);
    expect((await listOpenThreads(topic)).length).toBe(0);
  });

  test("schnelle Folgenachricht: wartet auf die Erkennung der vorigen, Rückgabe sofort", async () => {
    // Turn 1 erzeugt einen Faden, die Erkennung dauert; Turn 2 beantwortet ihn
    let releaseDetect!: () => void;
    const detectGate = new Promise<void>(r => (releaseDetect = r));
    const seen: string[] = [];
    const d = deps(async () => {
      const last = calls[calls.length - 1].prompt;
      if (last.includes("echten, offenen Frage")) {
        seen.push("erkennen");
        await detectGate;
        return { text: openJSON, isError: false };
      }
      seen.push("auflösen");
      const nr = (await listOpenThreads(topic))[0]?.nr;
      return { text: answered(nr), isError: false };
    });
    const started = Date.now();
    const r1 = noteTurnForThreads({ ...turn("Buch Hamburg.", topic, QUESTION_REPLY), turnStartedAt: started }, d);
    const r2 = noteTurnForThreads({ ...turn("Ja, das Hotel auch.", topic, "Gebucht."), turnStartedAt: started }, d);
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    await until(() => seen.length > 0);
    // Turn 1 hatte keine offenen Fäden (kein Auflösen), seine Erkennung hängt; Turn 2 wartet
    expect(seen).toEqual(["erkennen"]);
    releaseDetect();
    await until(() => !threadsWorkPending());
    expect(seen).toEqual(["erkennen", "auflösen"]);
    expect((await listOpenThreads(topic)).length).toBe(0);
    expect((await listAllThreads())[0].closedReason).toBe("beantwortet");
  });

  test("andere Gespräche warten nicht aufeinander", async () => {
    await make(web, "Variante A oder B?");
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const seen: string[] = [];
    const d = deps(async () => {
      const last = calls[calls.length - 1].prompt;
      if (last.includes("Hängt")) {
        seen.push("topic");
        await gate;
        return { text: openJSON, isError: false };
      }
      seen.push("web");
      return { text: answered(), isError: false };
    });
    noteTurnForThreads({ ...turn("x", topic, "Hängt das? Sag mir Bescheid."), turnStartedAt: Date.now() }, d);
    noteTurnForThreads({ ...turn("B.", web, "Gut."), turnStartedAt: Date.now() }, d);
    // Web läuft durch, obwohl das Topic noch hängt
    await until(() => seen.length === 2);
    expect(seen.sort()).toEqual(["topic", "web"]);
    release();
    await until(() => !threadsWorkPending());
  });

  test("Fehler im Auflösen hält die Erkennung nicht auf", async () => {
    await make(topic, "Hamburg oder München?");
    const replies: AuxReply[] = [async () => { throw new Error("weg"); }, async () => ({ text: openJSON, isError: false })];
    await processTurnForThreads(
      { ...turn("Hm.", topic, QUESTION_REPLY), turnStartedAt: Date.now() },
      deps(() => (replies.shift() as () => Promise<{ text: string; isError: boolean }>)())
    );
    expect((await listOpenThreads(topic)).length).toBe(2);
  });
});
