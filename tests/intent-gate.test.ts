/**
 * Issue #53, Schritt 3: Merk-Tags aus Turns mit fremden Inhalten nur nach
 * Freigabe. Die Vorschläge liegen in einer Temp-Datei
 * (setPendingReviewsFileForTests), nie in data/pending-reviews.json; das
 * Gedächtnis ist eine Attrappe, nie Supabase. src/bot.ts wird nur als Text
 * gelesen, nie importiert.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  decideReview,
  extractIntentTags,
  processTurnIntents,
  type IntentGateDeps,
} from "../src/lib/intent-gate";
import type { ProcessedIntents } from "../src/lib/memory";
import {
  describeTags,
  setPendingReviewsFileForTests,
  setReviewNotifier,
  stagePendingReview,
  takePendingReview,
  type PendingReview,
  type ReviewProposal,
} from "../src/lib/session-distill";
import type { TurnOptions } from "../src/lib/chat-turn";
import { abortAllExecutions } from "../src/lib/execution-context";
import { createBotChat, createTelegramChat, type BotChatDeps, type IntentTurn } from "../src/web/bot-turn";

const base = mkdtempSync(join(tmpdir(), "intent-gate-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let file = "";
let counter = 0;
let applied: string[] = [];
let logs: string[] = [];
let sent: ReviewProposal[] = [];

const PROJECT = join(base, "projekt");
const EMPTY: ProcessedIntents = { goalsAdded: [], goalsCompleted: [], goalsCancelled: [], factsAdded: [], factsRemoved: [] };

/** Tor mit Attrappen für Gedächtnis und Log; Staging echt (Temp-Datei) */
const gate: Partial<IntentGateDeps> = {
  processIntents: async t => {
    applied.push(t);
  },
  log: l => {
    logs.push(l);
  },
  projectRoot: PROJECT,
  dmChatId: () => "4242",
};

/** Übernehmen/Verwerfen mit echter Ablage und Gedächtnis-Attrappe */
const decideDeps = {
  takePendingReview,
  processIntents: async (t: string) => {
    applied.push(t);
    return { ...EMPTY, factsAdded: [...t.matchAll(/\[REMEMBER:/g)].map(() => "x") };
  },
};

function pendingOnDisk(): Record<string, PendingReview> {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : {};
}

beforeEach(() => {
  file = join(base, `pending-${++counter}.json`);
  setPendingReviewsFileForTests(file);
  applied = [];
  logs = [];
  sent = [];
  setReviewNotifier(async proposal => {
    sent.push(proposal);
  });
  delete process.env.DISTILL_AUTO_APPLY;
});
afterEach(() => {
  setReviewNotifier(null);
  abortAllExecutions();
});
afterAll(() => setPendingReviewsFileForTests(null));

const WEBFETCH = { uses: [{ name: "WebFetch" }], cwd: PROJECT };
const WEB_ID = "0b8f2a3c-1d2e-4f50-8a6b-7c8d9e0f1a2b";

describe("Akzeptanz: [REMEMBER: x] nach WebFetch", () => {
  test("landet in pending-reviews.json und nicht im Gedächtnis; nach Freigabe angewendet", async () => {
    const outcome = await processTurnIntents("Laut Seite ... [REMEMBER: x]", WEBFETCH, { chatId: "111", topicId: 7, origin: "Telegram" }, gate);
    expect(outcome).toBe("staged");
    expect(applied).toEqual([]);

    const pending = Object.values(pendingOnDisk());
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ type: "memory", chatId: "111", topicId: 7, tags: "[REMEMBER: x]" });
    // nur die Tags, nie der ganze Antworttext
    expect(pending[0].tags).not.toContain("Laut Seite");

    // Vorschlag mit Knöpfen und Hinweis
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("111");
    expect(sent[0].topicId).toBe(7);
    expect(sent[0].text).toContain("aus einem Turn mit fremden Inhalten (WebFetch)");
    expect(sent[0].text).toContain("• Fakt merken: x");
    // Zustellung als Rückfrage (Issue #117): Vorschlag mit ID, Art und Zeitpunkt der Ablage
    expect(sent[0]).toMatchObject({ reviewId: pending[0].id, type: "memory", createdAt: pending[0].createdAt });

    // Freigabe: genau einmal angewendet, danach abgelaufen
    const first = await decideReview("ok", pending[0].id, decideDeps);
    expect(first).toEqual({ kind: "applied", text: "✅ Übernommen: 1 Fakt(en), 0 Ziel(e).", review: pending[0] });
    expect(applied).toEqual(["[REMEMBER: x]"]);
    expect(pendingOnDisk()).toEqual({});
    expect(await decideReview("ok", pending[0].id, decideDeps)).toEqual({ kind: "expired" });
    expect(applied).toEqual(["[REMEMBER: x]"]);
  });

  test("Verwerfen: nichts angewendet, Vorschlag weg", async () => {
    await processTurnIntents("[REMEMBER: x]", WEBFETCH, { chatId: "111", origin: "Telegram" }, gate);
    const [id] = Object.keys(pendingOnDisk());
    expect(await decideReview("no", id, decideDeps)).toMatchObject({ kind: "discarded", review: { id } });
    expect(applied).toEqual([]);
    expect(pendingOnDisk()).toEqual({});
    expect(await decideReview("ok", id, decideDeps)).toEqual({ kind: "expired" });
    expect(applied).toEqual([]);
  });

  test("ohne fremde Werkzeuge: unverändert direkt, nichts abgelegt", async () => {
    const text = "Notiert. [REMEMBER: x]";
    const outcome = await processTurnIntents(text, { uses: [{ name: "Read", path: join(PROJECT, "a.ts") }, { name: "Edit" }], cwd: PROJECT }, { chatId: "111", origin: "Telegram" }, gate);
    expect(outcome).toBe("applied");
    // wie bisher: processIntents bekommt den ganzen Antworttext
    expect(applied).toEqual([text]);
    expect(existsSync(file)).toBe(false);
    expect(sent).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("ohne Tags: weder angewendet noch abgelegt", async () => {
    expect(await processTurnIntents("Nur Text", WEBFETCH, { chatId: "111", origin: "Telegram" }, gate)).toBe("none");
    expect(applied).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });
});

describe("Einstufung im Tor", () => {
  test("unbekannte Werkzeugliste: direkt angewendet, Log-Eintrag", async () => {
    const outcome = await processTurnIntents("[REMEMBER: x]", undefined, { chatId: "111", origin: "Telegram (Anthropic API)" }, gate);
    expect(outcome).toBe("applied");
    expect(applied).toEqual(["[REMEMBER: x]"]);
    expect(logs).toEqual(["[Intents] Telegram (Anthropic API): Werkzeuge des Turns unbekannt, Merk-Tags wie bisher direkt angewendet"]);
  });

  test("Read außerhalb des Projekts: abgelegt; innerhalb: direkt", async () => {
    await processTurnIntents("[REMEMBER: a]", { uses: [{ name: "Read", path: "/etc/hosts" }], cwd: PROJECT }, { chatId: "1", origin: "T" }, gate);
    await processTurnIntents("[REMEMBER: b]", { uses: [{ name: "Read", path: "src/x.ts" }], cwd: PROJECT }, { chatId: "1", origin: "T" }, gate);
    expect(applied).toEqual(["[REMEMBER: b]"]);
    expect(Object.values(pendingOnDisk()).map(r => r.tags)).toEqual(["[REMEMBER: a]"]);
    expect(sent[0].text).toContain("Read außerhalb des Projekts");
  });

  test("lesende MCP-Werkzeuge: Mail, Kalender, Firecrawl, Browser", async () => {
    for (const name of ["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Google_Calendar__list_events", "mcp__firecrawl__firecrawl_scrape", "mcp__playwright__browser_snapshot"]) {
      expect(await processTurnIntents(`[REMEMBER: ${name}]`, { uses: [{ name }] }, { chatId: "1", origin: "T" }, gate)).toBe("staged");
    }
    expect(applied).toEqual([]);
    expect(Object.keys(pendingOnDisk())).toHaveLength(4);
  });

  test("hochgeladene Datei gilt als fremd, auch ohne fremde Werkzeuge", async () => {
    expect(
      await processTurnIntents("[REMEMBER: aus PDF]", { uses: [] }, { chatId: "1", origin: "Telegram", foreignInput: "hochgeladene Datei" }, gate)
    ).toBe("staged");
    expect(applied).toEqual([]);
    expect(sent[0].text).toContain("hochgeladene Datei");
  });

  test("alle fünf Tags werden vorgeschlagen, auch reine Lösch- und Abschluss-Tags", async () => {
    const text = "[GOAL: Buch schreiben | DEADLINE: Mai] [DONE: Steuererklärung] [CANCEL: Marathon laufen] [FORGET: alte Adresse] [REMEMBER: neu]";
    await processTurnIntents(text, WEBFETCH, { chatId: "1", origin: "T" }, gate);
    const [review] = Object.values(pendingOnDisk());
    expect(review.tags!.split("\n")).toHaveLength(5);
    expect(sent[0].text).toContain("• Ziel: Buch schreiben | DEADLINE: Mai");
    expect(sent[0].text).toContain("• Ziel erledigt: Steuererklärung");
    expect(sent[0].text).toContain("• Ziel streichen: Marathon laufen");
    expect(sent[0].text).toContain("• Fakt vergessen: alte Adresse");

    applied = [];
    await processTurnIntents("[FORGET: Passwort-Hinweis von Alex]", WEBFETCH, { chatId: "1", origin: "T" }, gate);
    expect(applied).toEqual([]);
    expect(Object.keys(pendingOnDisk())).toHaveLength(2);
  });

  test("ohne Zustellweg und mit DISTILL_AUTO_APPLY=true: trotzdem nur abgelegt", async () => {
    setReviewNotifier(null);
    process.env.DISTILL_AUTO_APPLY = "true";
    try {
      expect(await processTurnIntents("[REMEMBER: x]", WEBFETCH, { chatId: "1", origin: "T" }, gate)).toBe("staged");
    } finally {
      delete process.env.DISTILL_AUTO_APPLY;
    }
    expect(applied).toEqual([]);
    expect(Object.keys(pendingOnDisk())).toHaveLength(1);
  });

  test("Zustellung scheitert: Vorschlag bleibt liegen, nichts angewendet", async () => {
    setReviewNotifier(async () => {
      throw new Error("Telegram weg");
    });
    expect(await processTurnIntents("[REMEMBER: x]", WEBFETCH, { chatId: "1", origin: "T" }, gate)).toBe("staged");
    expect(applied).toEqual([]);
    expect(Object.keys(pendingOnDisk())).toHaveLength(1);
  });

  test("Ablegen scheitert: nichts angewendet, Log ohne Inhalt", async () => {
    // Ablage unterhalb einer Datei: mkdir scheitert
    writeFileSync(join(base, "keine-ablage"), "x");
    setPendingReviewsFileForTests(join(base, "keine-ablage", "pending.json"));
    expect(await processTurnIntents("[REMEMBER: geheim]", WEBFETCH, { chatId: "1", origin: "T" }, gate)).toBe("staged");
    expect(applied).toEqual([]);
    expect(logs.join("\n")).toContain("Vorschlag nicht abgelegt, Merk-Tags verworfen");
    expect(logs.join("\n")).not.toContain("geheim");
  });

  test("Reines Web-Gespräch (Issue #117): Vorschlag bleibt dem Web-Gespräch zugeordnet, mit Herkunft", async () => {
    await processTurnIntents("[REMEMBER: x]", WEBFETCH, { chatId: `web:${WEB_ID}`, topicId: 5, origin: "Web-Gespräch" }, gate);
    expect(sent[0].chatId).toBe(`web:${WEB_ID}`);
    expect(sent[0].topicId).toBeUndefined();
    expect(sent[0].text).toContain("(Web-Gespräch) aus einem Turn mit fremden Inhalten");
    expect(Object.values(pendingOnDisk())[0].chatId).toBe(`web:${WEB_ID}`);
  });

  test("Chat ohne Telegram-ID und ohne gültige Web-Kennung: Vorschlag in den Direktchat mit Herkunft", async () => {
    await processTurnIntents("[REMEMBER: x]", WEBFETCH, { chatId: "web:abc", topicId: 5, origin: "Web-Gespräch" }, gate);
    expect(sent[0].chatId).toBe("4242");
    expect(sent[0].topicId).toBeUndefined();
    expect(Object.values(pendingOnDisk())[0].chatId).toBe("4242");
  });

  test("Web-Gespräch mit Bild-Anhang (Issue #112): foreignInput allein reicht, Vorschlag im Web-Gespräch", async () => {
    const outcome = await processTurnIntents("[REMEMBER: aus Bild]", { uses: [] }, { chatId: `web:${WEB_ID}`, origin: "Web-Gespräch", foreignInput: "Foto" }, gate);
    expect(outcome).toBe("staged");
    expect(applied).toEqual([]);
    expect(sent[0].chatId).toBe(`web:${WEB_ID}`);
    expect(sent[0].text).toContain("Foto");
    // Reines Sprachtranskript ohne fremde Werkzeuge: kein foreignInput, direkt angewendet
    expect(await processTurnIntents("[REMEMBER: aus Sprache]", { uses: [] }, { chatId: `web:${WEB_ID}`, origin: "Web-Gespräch" }, gate)).toBe("applied");
    expect(applied).toEqual(["[REMEMBER: aus Sprache]"]);
  });
});

describe("Hilfsfunktionen", () => {
  test("extractIntentTags: nur die fünf Tags", () => {
    expect(extractIntentTags("a [REMEMBER: x] b [INVOKE:research|y] [goal: z]")).toBe("[REMEMBER: x]\n[goal: z]");
    expect(extractIntentTags("nichts")).toBe("");
  });

  test("describeTags: leer ohne Tags", () => {
    expect(describeTags("nichts")).toBe("");
  });

  test("Routine-Vorschlag ohne Session wird verworfen statt eingefroren", async () => {
    await stagePendingReview({ id: "r1", type: "routine", chatId: "1", routineDescription: "x", createdAt: Date.now() });
    expect(await decideReview("routine", "r1", decideDeps)).toMatchObject({ kind: "discarded", review: { id: "r1" } });
  });
});

describe("Ablage über Prozessgrenzen", () => {
  test("Eintrag eines anderen Prozesses wird gesehen und nicht überschrieben", async () => {
    await stagePendingReview({ id: "hier", type: "memory", chatId: "1", tags: "[REMEMBER: a]", createdAt: Date.now() });
    // Ein anderer Prozess (Sprach-Brücke) schreibt direkt in die Datei
    const onDisk = pendingOnDisk();
    onDisk.dort = { id: "dort", type: "memory", chatId: "1", tags: "[REMEMBER: b]", createdAt: Date.now() };
    writeFileSync(file, JSON.stringify(onDisk));
    await stagePendingReview({ id: "hier2", type: "memory", chatId: "1", tags: "[REMEMBER: c]", createdAt: Date.now() });
    expect(Object.keys(pendingOnDisk()).sort()).toEqual(["dort", "hier", "hier2"]);
    expect((await takePendingReview("dort"))?.tags).toBe("[REMEMBER: b]");
  });

  test("zwei Prozesse legen gleichzeitig ab: kein Eintrag geht verloren", async () => {
    const script = join(base, "child.ts");
    writeFileSync(
      script,
      `import { setPendingReviewsFileForTests, stagePendingReview } from ${JSON.stringify(join(import.meta.dir, "..", "src", "lib", "session-distill.ts"))};
setPendingReviewsFileForTests(process.argv[2]);
await Promise.all(Array.from({ length: 20 }, (_, i) => stagePendingReview({ id: "kind-" + i, type: "memory", chatId: "1", tags: "[REMEMBER: k]", createdAt: Date.now() })));
`
    );
    const child = Bun.spawn(["bun", script, file], { stdout: "ignore", stderr: "pipe" });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => stagePendingReview({ id: `eltern-${i}`, type: "memory", chatId: "1", tags: "[REMEMBER: e]", createdAt: Date.now() }))
    );
    expect(await child.exited).toBe(0);
    expect(Object.keys(pendingOnDisk())).toHaveLength(40);
  });
});

// ---------------------------------------------------------------------------
// Kanäle: WebUI (Web-Gespräch und Telegram-Topic im Browser) wie in bot.ts verdrahtet
// ---------------------------------------------------------------------------

function webDeps(tools: IntentTurn["tools"] | "nie"): BotChatDeps {
  return {
    runStreamingTurn: async (o: TurnOptions) => {
      if (tools !== "nie") o.onTools?.(tools);
      return "Antwort [REMEMBER: x]";
    },
    saveMessage: async () => true,
    // wie in src/bot.ts: processTurnIntents(text, turn.tools, turn)
    processIntents: (text, turn) => processTurnIntents(text, turn.tools, turn, gate),
    abortClaudeCalls: () => 0,
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
  };
}
const nullSink = { progress() {}, notice() {} };

describe("WebUI", () => {
  test("Web-Gespräch mit WebFetch: Vorschlag im Web-Gespräch (Kopie im Direktchat macht die Zustellung), nicht angewendet", async () => {
    const chat = createBotChat(webDeps(WEBFETCH));
    await chat.runTurn({ conversationId: WEB_ID, agent: "general", text: "lies", sink: nullSink });
    expect(applied).toEqual([]);
    expect(sent[0].chatId).toBe(`web:${WEB_ID}`);
    expect(sent[0].text).toContain("Web-Gespräch");
  });

  test("Web-Gespräch ohne fremde Werkzeuge: direkt", async () => {
    const chat = createBotChat(webDeps({ uses: [] }));
    await chat.runTurn({ conversationId: "abc", agent: "general", text: "hi", sink: nullSink });
    expect(applied).toEqual(["Antwort [REMEMBER: x]"]);
    expect(existsSync(file)).toBe(false);
  });

  test("Web-Gespräch, Fallback ohne Werkzeugangaben: direkt mit Log", async () => {
    const chat = createBotChat(webDeps(undefined));
    await chat.runTurn({ conversationId: "abc", agent: "general", text: "hi", sink: nullSink });
    expect(applied).toEqual(["Antwort [REMEMBER: x]"]);
    expect(logs[0]).toContain("Web-Gespräch: Werkzeuge des Turns unbekannt");
  });

  test("Telegram-Topic im Browser mit WebFetch: Vorschlag im Topic", async () => {
    const chat = createTelegramChat({
      ...webDeps(WEBFETCH),
      userId: "4242",
      groupId: () => "-100123",
      agentForTopic: () => "research",
      sendPlain: async () => {},
      sendAsAgent: async () => {},
    });
    await chat.runTurn({ conversationId: "topic-9", agent: "research", text: "lies", sink: nullSink });
    expect(applied).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("-100123");
    expect(sent[0].topicId).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Telegram und Sprach-Brücke: src/bot.ts und src/voice-bridge.ts nur als Text
// ---------------------------------------------------------------------------

describe("Verdrahtung", async () => {
  const bot = await Bun.file(join(import.meta.dir, "..", "src", "bot.ts")).text();
  const voice = await Bun.file(join(import.meta.dir, "..", "src", "voice-bridge.ts")).text();
  const goal = await Bun.file(join(import.meta.dir, "..", "src", "lib", "goal-engine.ts")).text();
  const mediaTurn = await Bun.file(join(import.meta.dir, "..", "src", "lib", "media-turn.ts")).text();

  test("bot.ts: kein direktes processIntents mehr, jede Antwort läuft durch das Tor", () => {
    expect(bot).not.toMatch(/\bprocessIntents\(/);
    const calls = bot.match(/processTurnIntents\(/g) ?? [];
    // 9 Antwortwege (Text, Sprache 2x, Foto, Dokument, Video, 3x Aufgabe fortsetzen) plus WebUI
    expect(calls.length).toBe(10);
    expect(bot).toContain('processTurnIntents(response, turn.tools(), { chatId, topicId, origin: "Telegram" })');
    // Foto und Dokument: foreignInput kommt aus dem Medien-Kern (Issue #71)
    expect(bot.match(/foreignInput: prepared\.foreignInput \}\)/g)).toHaveLength(3);
    expect(mediaTurn).toContain('foreignInput: "hochgeladene Datei"');
    expect(mediaTurn).toContain('foreignInput: "Foto"');
    expect(bot).toContain("processIntents: (text: string, turn: IntentTurn) => processTurnIntents(text, turn.tools, turn)");
    // bestätigte Vorschläge: decideReview wendet direkt an, über den Handler der Art "review" (Issue #117)
    expect(bot).toContain("decideReview: (action, reviewId) => decideReview(action, reviewId),");
    expect(bot).toContain('onChoiceDecided("review", reviewResults.handler);');
    expect(bot).toContain("const { text } = await reviewResults.legacy(action, reviewId);");
  });

  test("Ziel-Engine reicht die Werkzeuge durch", () => {
    expect(goal).not.toMatch(/\bprocessIntents\(/);
    expect(goal).toContain('processTurnIntents(text, tools, { chatId: g.chatId, topicId: g.topicId, origin: "Ziel-Turn" })');
    expect(bot).toContain("tools: turn.tools(),");
  });

  test("Sprach-Brücke: Tor mit Werkzeugen, Rückfrage im selben Register, Versand über die Bot-API", () => {
    expect(voice).not.toMatch(/\bprocessIntents\(/);
    expect(voice).toContain('processTurnIntents(assistantRaw, tools, { chatId: CHAT_ID, origin: "Sprach-Brücke" })');
    expect(voice).toContain("setReviewNotifier(createReviewNotifier({ sendChoice: (choice) => reviewChoices.sendChoice(choice) }));");
    expect(voice).toContain('createTelegramChoices({ api: new Api(process.env.TELEGRAM_BOT_TOKEN || ""), owner: CHAT_ID })');
  });
});
