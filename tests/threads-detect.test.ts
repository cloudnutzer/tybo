import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildThreadsPrompt,
  cleanReply,
  detectThread,
  noteTurnForThreads,
  parseVerdict,
  passesPrefilter,
  referenceDate,
  THREADS_TAIL_CHARS,
  type ThreadDetectDeps,
} from "../src/lib/threads/detect";
import { createThread, listOpenThreads, setThreadsFileForTests } from "../src/lib/threads/store";
import type { Choice } from "../src/lib/choices";
import type { AuxPurpose } from "../src/lib/aux-model";
import { setRuntimeForTests, setSpawnForTests } from "../src/lib/claude";
import { setSettingsPath } from "../src/lib/settings";
import { setMcpReaderForTests, setSubprocessEnvLoggerForTests } from "../src/lib/subprocess-env";

// Erkennung offener Fäden (Issue #290): callAux ist immer eine Attrappe, kein echtes Modell.

const QUESTION = "Willst du nach Hamburg oder nach München fahren? Sag mir bitte bis Freitag Bescheid.";
const REPLY = `Beide Städte haben ihren Reiz. Hamburg hat den Hafen, München die Berge in der Nähe.\n\n${QUESTION}`;
// Donnerstag, 15.10.2026, 10:00 in Berlin
const NOW = new Date("2026-10-15T08:00:00Z");
const web = { type: "web" as const, conversationId: "0f1e2d3c-4b5a-4c6d-8e7f-001122334455" };
const topic = { type: "telegram" as const, chatId: "-100123", topicId: 7 };

let dir: string;
let calls: { purpose: AuxPurpose; prompt: string; opts: any }[];
let logs: string[];
let consoleSpies: ReturnType<typeof spyOn>[];

function deps(reply: string | (() => Promise<{ text: string; isError: boolean }>), extra: Partial<ThreadDetectDeps> = {}): Partial<ThreadDetectDeps> {
  return {
    callAux: async (purpose, prompt, opts) => {
      calls.push({ purpose, prompt, opts });
      return typeof reply === "string" ? { text: reply, isError: false } : reply();
    },
    listChoices: async () => [],
    pendingAskUser: async () => [],
    now: () => NOW,
    timeZone: () => "Europe/Berlin",
    env: {},
    log: m => logs.push(m),
    ...extra,
  };
}

const openJSON = (deadline: string | null = "2026-10-16") =>
  JSON.stringify({ open: true, topic: "Reiseziel für nächste Woche", context: "Der Nutzer überlegt, ob er nach Hamburg oder München fährt.", question: "Hamburg oder München?", deadline });

const input = (reply = REPLY, conversation: any = web) => ({ conversation, userText: "Hilf mir bei der Entscheidung.", reply, turnStartedAt: NOW.getTime() - 60_000 });

// Wartet, bis die Bedingung gilt (höchstens 2 Sekunden); unter Last reichen
// feste Pausen von 10 bis 30 ms nicht immer.
async function waitUntil(cond: () => boolean | Promise<boolean>) {
  const until = Date.now() + 2000;
  while (!(await cond()) && Date.now() < until) await Bun.sleep(5);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-threads-detect-"));
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

describe("Vorfilter", () => {
  test("ohne Fragezeichen und ohne Entscheidungs-Formulierung am Ende: kein Aux-Aufruf", async () => {
    const reply = "Tokio ist uns sieben Stunden voraus. Dort ist es jetzt 17 Uhr.";
    expect(passesPrefilter(reply)).toBe(false);
    expect(await detectThread(input(reply), deps(openJSON()))).toEqual({ status: "no-question" });
    expect(calls.length).toBe(0);
  });

  test("Frage weiter vorn, aber nicht im Endstück: kein Aufruf", async () => {
    const reply = `Was ist der Plan? ${"Hier steht viel Text. ".repeat(40)}Fertig.`;
    expect(cleanReply(reply).length).toBeGreaterThan(THREADS_TAIL_CHARS);
    expect(passesPrefilter(reply)).toBe(false);
  });

  test("Fragezeichen nur im Code-Block oder Steuer-Tag zählt nicht", () => {
    expect(passesPrefilter("So geht es:\n```ts\nconst a = b ? 1 : 2;\n```")).toBe(false);
    expect(passesPrefilter("Erledigt. [REMEMBER: Mag Fragen?] [INVOKE:critic|Passt das?]")).toBe(false);
    // ein offener Code-Block am Ende zählt ebenfalls nicht
    expect(passesPrefilter("Ergebnis:\n```\nwarum?")).toBe(false);
  });

  test("Vierer-Block mit inneren Dreier-Backticks: Frage nur im Block, kein Aux-Aufruf", async () => {
    const reply = "Beispiel:\n````md\nSo sieht es aus:\n```\nx\n```\nSoll ich das so lassen?\n````\nFertig.";
    expect(cleanReply(reply)).not.toContain("Soll ich");
    expect(cleanReply(reply)).toContain("Fertig.");
    expect(passesPrefilter(reply)).toBe(false);
    expect(await detectThread(input(reply), deps(openJSON()))).toEqual({ status: "no-question" });
    // Tilden-Block endet nicht an Backticks, ein kürzerer Zaun schließt nicht
    const tilde = "Code:\n~~~~\n```\nWarum?\n~~~\nWirklich?\n~~~~\nErledigt.";
    expect(passesPrefilter(tilde)).toBe(false);
    expect(await detectThread(input(tilde), deps(openJSON()))).toEqual({ status: "no-question" });
    expect(calls.length).toBe(0);
  });

  test("eingerückter Codeblock: Frage nur dort, kein Aux-Aufruf", async () => {
    const reply = "Der Aufruf lautet:\n\n    const ok = confirm(\"Weiter?\");\n\tif (!ok) return \"Abbruch?\";\n\nDas war alles.";
    expect(cleanReply(reply)).not.toContain("Weiter?");
    expect(cleanReply(reply)).not.toContain("Abbruch?");
    expect(passesPrefilter(reply)).toBe(false);
    expect(await detectThread(input(reply), deps(openJSON()))).toEqual({ status: "no-question" });
    expect(calls.length).toBe(0);
  });

  test("Codeblock in Zitat, Liste oder nach Überschrift: Frage nur dort, kein Aux-Aufruf", async () => {
    const replies = [
      "Fertig.\n\n> ```js\n> confirm(\"Weiter?\");\n> ```",
      "1. Beispiel:\n\n    ```js\n    confirm(\"Weiter?\");\n    ```",
      "# Beispiel\n    confirm(\"Weiter?\");",
    ];
    for (const reply of replies) {
      expect(cleanReply(reply)).not.toContain("Weiter?");
      expect(passesPrefilter(reply)).toBe(false);
      expect(await detectThread(input(reply), deps(openJSON()))).toEqual({ status: "no-question" });
    }
    expect(calls.length).toBe(0);
  });

  test("echte Fragen neben solchen Blöcken bleiben erhalten", async () => {
    const replies = [
      "> ```js\n> confirm(\"Weiter?\");\n> ```\n>\n> Soll ich das so einbauen?",
      "1. Beispiel:\n\n    ```js\n    confirm(\"Weiter?\");\n    ```\n\n2. Nimmst du A oder B?",
      "# Beispiel\n    confirm(\"Weiter?\");\n\nPasst dir das so?",
    ];
    for (const reply of replies) {
      expect(cleanReply(reply)).not.toContain("Weiter?");
      expect(passesPrefilter(reply)).toBe(true);
      const before = calls.length;
      expect((await detectThread(input(reply), deps(openJSON()))).status).not.toBe("no-question");
      expect(calls.length).toBe(before + 1);
    }
  });

  test("eingerückte Fortsetzung eines Absatzes oder einer Liste bleibt stehen", () => {
    expect(passesPrefilter("Zwei Wege:\n    Willst du A oder B?")).toBe(true);
    expect(passesPrefilter("- Variante A\n\n    Nimmst du A oder lieber B?")).toBe(true);
  });

  test("Code-Blöcke werden vor dem Kürzen entfernt", () => {
    const reply = `Welche Variante nimmst du, A oder B?\n\`\`\`\n${"x".repeat(THREADS_TAIL_CHARS * 2)}\n\`\`\``;
    expect(passesPrefilter(reply)).toBe(true);
  });

  test("Entscheidungs-Formulierung ohne Fragezeichen", () => {
    expect(passesPrefilter("Variante A ist schneller, B billiger. Gib mir Bescheid, welche es sein soll.")).toBe(true);
    expect(passesPrefilter("Sag mir, welche Variante du willst.")).toBe(true);
  });
});

describe("Erkennung", () => {
  test("echte Frage mit „bis Freitag“ ergibt einen Faden mit Frist; Prompt mit Bezugsdatum und Zeitzone", async () => {
    const r = await detectThread(input(), deps(openJSON("2026-10-16")));
    expect(r.status).toBe("created");
    expect(calls.length).toBe(1);
    expect(calls[0].purpose).toBe("threads");
    expect(calls[0].opts).toMatchObject({ quiet: true });
    expect(calls[0].prompt).toContain("2026-10-15 (Donnerstag)");
    expect(calls[0].prompt).toContain("Europe/Berlin");
    expect(calls[0].prompt).toContain("bis Freitag");
    const [thread] = await listOpenThreads();
    expect(thread).toMatchObject({ conversation: web, topic: "Reiseziel für nächste Woche", question: "Hamburg oder München?", deadline: "2026-10-16", state: "open" });
    // Log nur mit Kennungen
    expect(logs).toEqual([`Faden ${thread.id} angelegt (Gespräch web:${web.conversationId})`]);
  });

  test("Floskel „Soll ich noch etwas tun?“: Attrappe sagt open false, kein Faden", async () => {
    const reply = "Die Datei ist angelegt und getestet. Soll ich noch etwas tun?";
    expect(passesPrefilter(reply)).toBe(true);
    expect(await detectThread(input(reply), deps(JSON.stringify({ open: false, topic: "", context: "", question: "", deadline: null })))).toEqual({ status: "none" });
    expect(calls.length).toBe(1);
    expect(await listOpenThreads()).toEqual([]);
  });

  test("der Prompt schließt Floskeln, rhetorische, selbst beantwortete Fragen und Angebote aus", () => {
    const prompt = buildThreadsPrompt({ reply: REPLY, userText: "x", now: NOW, timeZone: "Europe/Berlin" });
    expect(prompt).toContain("rhetorische Fragen");
    expect(prompt).toContain("Soll ich noch etwas tun?");
    expect(prompt).toContain("Noch Fragen?");
    expect(prompt).toContain("Fragen, die der Assistent selbst beantwortet");
    expect(prompt).toContain("Angebote ohne Entscheidung des Nutzers");
  });

  test("Prompt bekommt höchstens 1.500 Zeichen Antwort und 500 Zeichen Nutzer-Nachricht", () => {
    const prompt = buildThreadsPrompt({ reply: `${"A".repeat(3000)}Ende?`, userText: `${"U".repeat(900)}Schluss`, now: NOW, timeZone: "UTC" });
    expect(prompt).not.toContain("A".repeat(1500));
    expect(prompt).toContain(`${"A".repeat(1495)}Ende?`);
    expect(prompt).toContain(`${"U".repeat(493)}Schluss`);
    expect(prompt).not.toContain("U".repeat(494));
  });

  test("Bezugsdatum in USER_TIMEZONE, ungültige Zone fällt auf UTC", () => {
    const lateUtc = new Date("2026-10-15T23:30:00Z");
    expect(referenceDate(lateUtc, "Europe/Berlin")).toBe("2026-10-16 (Freitag)");
    expect(referenceDate(lateUtc, "UTC")).toBe("2026-10-15 (Donnerstag)");
    expect(referenceDate(lateUtc, "Keine/Zone")).toBe("2026-10-15 (Donnerstag)");
  });

  test("offene Rückfrage im Register seit Turn-Beginn verhindert den Faden, ohne Aux-Aufruf", async () => {
    const choice = { id: "C1", kind: "tool", conversation: web, text: "Erlauben?", options: [{ key: "y", label: "Ja" }], state: "open", createdAt: NOW.getTime() - 1_000 } as Choice;
    expect(await detectThread(input(), deps(openJSON(), { listChoices: async () => [choice] }))).toEqual({ status: "suppressed", by: "choice" });
    expect(calls.length).toBe(0);
    // auch eine während des Turns schon entschiedene zählt
    const decided = { ...choice, state: "done", result: { key: "y", label: "Ja", via: "web", at: NOW.getTime() } } as Choice;
    expect((await detectThread(input(), deps(openJSON(), { listChoices: async () => [decided] }))).status).toBe("suppressed");
  });

  test("Rückfragen aus älteren Turns oder anderen Gesprächen stören nicht", async () => {
    const old = { id: "C1", kind: "tool", conversation: web, text: "?", options: [{ key: "y", label: "Ja" }], state: "open", createdAt: NOW.getTime() - 3_600_000 } as Choice;
    const other = { ...old, id: "C2", createdAt: NOW.getTime(), conversation: { type: "web", conversationId: "aaaaaaaa-4b5a-4c6d-8e7f-001122334455" } } as Choice;
    const sameChatOtherTopic = { ...old, id: "C3", createdAt: NOW.getTime(), conversation: { type: "telegram", chatId: "-100123", topicId: 8 } } as Choice;
    expect((await detectThread(input(REPLY, topic), deps(openJSON(), { listChoices: async () => [old, other, sameChatOtherTopic] }))).status).toBe("created");
  });

  test("wartende ask_user-Aufgabe im selben Topic verhindert den Faden, in anderem Topic nicht", async () => {
    const asked: string[] = [];
    const pendingAskUser = async (chatId: string) => {
      asked.push(chatId);
      return [{ chat_id: chatId, thread_id: 7 }];
    };
    expect(await detectThread(input(REPLY, topic), deps(openJSON(), { pendingAskUser }))).toEqual({ status: "suppressed", by: "ask_user" });
    expect(asked).toEqual(["-100123"]);
    expect(calls.length).toBe(0);
    const otherTopic = { ...topic, topicId: 9 };
    expect((await detectThread(input(REPLY, otherTopic), deps(openJSON(), { pendingAskUser }))).status).toBe("created");
    // Direktchat ohne Topic: nur Aufgaben ohne thread_id zählen
    const dm = { type: "telegram" as const, chatId: "4242" };
    expect((await detectThread(input(REPLY, dm), deps(openJSON(), { pendingAskUser: async () => [{ chat_id: "4242", thread_id: null }] }))).status).toBe("suppressed");
  });

  test("reine Web-Gespräche fragen ask_user unter web:<id>", async () => {
    const asked: string[] = [];
    await detectThread(input(), deps(openJSON(), { pendingAskUser: async chatId => (asked.push(chatId), []) }));
    expect(asked).toEqual([`web:${web.conversationId}`]);
  });

  test("ungültiges JSON ergibt keinen Faden, eine Log-Zeile ohne Inhalt", async () => {
    expect(await detectThread(input(), deps("Das ist eine offene Frage, ja."))).toEqual({ status: "failed", reason: "ungültige Antwort" });
    expect(await listOpenThreads()).toEqual([]);
    expect(logs).toEqual([`keine Erkennung für Gespräch web:${web.conversationId} (ungültige Antwort)`]);
  });

  test("Schema wird geprüft: open muss boolean sein, Felder nicht leer, Frist ein Kalenderdatum", () => {
    expect(parseVerdict('{"open": "true", "topic": "a", "context": "b", "question": "c"}')).toBeNull();
    expect(parseVerdict('{"open": true, "topic": "", "context": "b", "question": "c"}')).toBeNull();
    expect(parseVerdict('{"open": true, "topic": "a", "context": "b", "question": 3}')).toBeNull();
    expect(parseVerdict('{"open": true, "topic": "a", "context": "b", "question": "c", "deadline": "2026-02-30"}')).toBeNull();
    expect(parseVerdict('{"open": true, "topic": "a", "context": "b", "question": "c", "deadline": "Freitag"}')).toBeNull();
    expect(parseVerdict('```json\n{"open": true, "topic": "a", "context": "b", "question": "c", "deadline": null}\n```')).toEqual({ open: true, topic: "a", context: "b", question: "c" });
    expect(parseVerdict('{"open": false}')).toEqual({ open: false });
  });

  test("Fehler des Modells und Ausnahme: kein Faden, je eine Log-Zeile", async () => {
    expect(await detectThread(input(), deps(async () => ({ text: "", isError: true })))).toEqual({ status: "failed", reason: "fehler" });
    expect(await detectThread(input(), deps(async () => { throw new Error(QUESTION); }))).toEqual({ status: "failed", reason: "fehler" });
    expect(logs.length).toBe(2);
    expect(await listOpenThreads()).toEqual([]);
  });

  test("Zeitüberschreitung: kein Faden, eine Log-Zeile", async () => {
    // eigene Grenze = timeoutMs + 5 s, hier also 20 ms
    const r = await detectThread(input(), deps(() => new Promise(() => {}), { timeoutMs: -4_980 }));
    expect(r).toEqual({ status: "failed", reason: "zeitüberschreitung" });
    expect(logs).toEqual([`keine Erkennung für Gespräch web:${web.conversationId} (zeitüberschreitung)`]);
  });

  test("gleiche Frage zweimal im selben Gespräch ergibt einen Faden", async () => {
    const first = await detectThread(input(), deps(openJSON()));
    const second = await detectThread(input(), deps(openJSON()));
    expect(first.status).toBe("created");
    expect(second.status).toBe("duplicate");
    expect((await listOpenThreads()).length).toBe(1);
    // in einem anderen Gespräch ein eigener
    expect((await detectThread(input(REPLY, topic), deps(openJSON()))).status).toBe("created");
    expect((await listOpenThreads()).length).toBe(2);
  });

  test("THREADS=off: kein Aux-Aufruf, auch nicht über noteTurnForThreads", async () => {
    for (const value of ["off", "OFF", " Off "]) {
      expect(await detectThread(input(), deps(openJSON(), { env: { THREADS: value } }))).toEqual({ status: "off" });
      noteTurnForThreads(input(), deps(openJSON(), { env: { THREADS: value } }));
    }
    await Bun.sleep(20);
    expect(calls.length).toBe(0);
    expect(await listOpenThreads()).toEqual([]);
  });

  test("noteTurnForThreads wartet nie auf die Erkennung und fängt Fehler", async () => {
    let release!: (r: { text: string; isError: boolean }) => void;
    const blocked = new Promise<{ text: string; isError: boolean }>(r => (release = r));
    const t0 = performance.now();
    const result = noteTurnForThreads(input(), deps(() => blocked));
    expect(result).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(50);
    await waitUntil(() => calls.length >= 1);
    expect(calls.length).toBe(1);
    expect(await listOpenThreads()).toEqual([]);
    release({ text: openJSON(), isError: false });
    await waitUntil(async () => (await listOpenThreads()).length >= 1);
    expect((await listOpenThreads()).length).toBe(1);
    // ein Fehler im Anlegen landet nur als Log-Zeile
    noteTurnForThreads(input(REPLY, topic), deps(openJSON(), { createThread: async () => { throw new Error("kaputt"); } }));
    await waitUntil(() => logs.at(-1)?.startsWith("keine Erkennung für Gespräch tg:") ?? false);
    expect(logs.at(-1)).toBe("keine Erkennung für Gespräch tg:-100123:7 (fehler)");
  });

  test("im Log steht keine Frage, auch nicht von callAux", async () => {
    await detectThread(input(), deps(openJSON()));
    await detectThread(input(), deps("kaputt"));
    await detectThread(input(), deps(async () => { throw new Error(QUESTION); }));
    const all = [...logs, consoleText()].join("\n");
    expect(all).not.toContain("Hamburg");
    expect(all).not.toContain("München");
    expect(all).not.toContain("Reiseziel");
  });

  test("schon gespeicherter Faden mit derselben Frage: kein zweiter", async () => {
    await createThread({ conversation: web, topic: "t", context: "c", question: "Hamburg oder München?" });
    const r = await detectThread(input(), deps(openJSON()));
    expect(r.status).toBe("duplicate");
  });
});

describe("Zeitüberschreitung über den echten callAux-Weg", () => {
  test("vorgetäuschte CLI hängt: genau eine Log-Zeile ohne Inhalt, mit Gesprächskennung", async () => {
    // Kein echtes claude: der Prozess antwortet nie, erst das Beenden schließt seine Ausgabe
    const spawned: string[][] = [];
    const prompts: string[] = [];
    setMcpReaderForTests(() => new Set());
    // Einmaliger Hinweis des Env-Filters beim ersten Subprozess, hängt von der Umgebung ab, nicht vom Aufruf
    setSubprocessEnvLoggerForTests(() => {});
    setSettingsPath(join(dir, "fehlt.json"));
    const savedAux = process.env.AUX_MODEL_THREADS;
    delete process.env.AUX_MODEL_THREADS;
    setSpawnForTests(((options: { cmd: string[] }) => {
      spawned.push(options.cmd);
      let close!: () => void;
      let exit!: (code: number) => void;
      const stdout = new ReadableStream<Uint8Array>({ start: c => (close = () => c.close()) });
      return {
        pid: 0,
        stdin: { write: (t: string) => prompts.push(t), end() {} },
        stdout,
        stderr: new ReadableStream<Uint8Array>({ start: c => c.close() }),
        // Wie ein echter Prozess: endet erst, wenn er beendet wird
        exited: new Promise<number>(r => (exit = r)),
        kill() {},
        close: () => {
          close();
          exit(143);
        },
      };
    }) as any);
    setRuntimeForTests({ terminate: ((proc: { close(): void }) => proc.close()) as any });
    try {
      const { callAux: _ignored, log: _log, ...rest } = deps(openJSON());
      const r = await detectThread(input(), { ...rest, timeoutMs: 30 });
      expect(r).toEqual({ status: "failed", reason: "fehler" });
      expect(spawned.length).toBe(1);
      expect(spawned[0]).toContain("-p");
      expect(prompts.join("")).toContain("Hamburg");
      // Standard-Log von detectThread geht auf console.log; sonst kein Wort, auch nicht von callClaude
      const lines = consoleText().split("\n").filter(Boolean);
      expect(lines).toEqual([`[threads] keine Erkennung für Gespräch web:${web.conversationId} (fehler)`]);
      expect(consoleText()).not.toContain("Hamburg");
      expect(await listOpenThreads()).toEqual([]);
    } finally {
      setSpawnForTests(null);
      setRuntimeForTests(null);
      setMcpReaderForTests(null);
      setSubprocessEnvLoggerForTests(null);
      setSettingsPath();
      if (savedAux !== undefined) process.env.AUX_MODEL_THREADS = savedAux;
    }
  });
});
