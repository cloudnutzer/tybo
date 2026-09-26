/**
 * Telegram-Antworten der umgestellten Befehle (Issue #74): wortgleich mit
 * der früheren if-Kette in src/bot.ts. Die erwarteten Texte stehen hier fest
 * (aus dem Stand vor der Umstellung kopiert), die Abhängigkeiten sind
 * Attrappen; src/bot.ts wird nur als Text gelesen, nie importiert.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commandRegistry } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices, RoutineSession, SessionResetOutcome } from "../src/lib/commands/types";
import { markdownToTelegramHTML } from "../src/lib/telegram";

type Sent = { text: string; other?: Record<string, unknown> };

function fakeServices(over: Partial<CommandServices> = {}): CommandServices & { log: string[] } {
  const log: string[] = [];
  const overrides: Record<string, string[]> = { research: ["antworte kuerzer"] };
  return {
    log,
    isSessionModeEnabled: () => true,
    getGoal: async () => undefined,
    pauseGoal: async (key, reason) => log.push(`pause ${key} ${reason}`),
    abortClaudeCalls: key => (log.push(`abort ${key}`), 0),
    listAllOverrides: () => overrides,
    listAgentNames: () => ["general", "research", "critic"],
    resolveAgentName: raw => (["general", "research", "critic"].includes(raw.toLowerCase()) ? raw.toLowerCase() : raw.toLowerCase() === "cfo" ? "finance" : undefined),
    getAgentOverrides: agent => overrides[agent] ?? [],
    clearAgentOverrides: async agent => (overrides[agent]?.length ?? 0),
    removeLastAgentOverride: async agent => overrides[agent]?.at(-1),
    addAgentOverride: async (agent, text) => (log.push(`add ${agent} ${text}`), (overrides[agent]?.length ?? 0) + 1),
    topicMapping: () => ({ "12": "research", "3": "finance" }),
    topicNames: async () => ({ "3": "Geld" }),
    listGoals: async () => "- Buch fertig",
    learn: async input => ({ message: `**Gelernt:** ${input}` }),
    formatPlan: async () => "**Plan:** Max",
    sessionsForKey: async () => [],
    createRoutine: async () => ({ text: "Routine **fertig**" }),
    ...over,
  };
}

async function run(
  text: string,
  opts: {
    services?: CommandServices;
    topicId?: number;
    reset?: SessionResetOutcome;
    htmlFails?: boolean;
    agentTurns?: string[];
    boards?: string[];
  } = {}
): Promise<Sent[]> {
  const sent: Sent[] = [];
  const match = commandRegistry.match(text, "telegram");
  if (!match) throw new Error(`kein Befehl: ${text}`);
  await runTelegramCommand({
    chat: {
      async reply(t, other) {
        if (opts.htmlFails && other?.parse_mode === "HTML") throw new Error("400");
        sent.push(other ? { text: t, other } : { text: t });
      },
    },
    chatId: "-1001",
    topicId: opts.topicId,
    sessionKey: opts.topicId ? `topic:-1001:${opts.topicId}` : "group:-1001",
    agent: "general",
    text,
    match,
    services: opts.services ?? fakeServices(),
    working: () => () => {},
    resetSession: async () => opts.reset ?? { status: "done", reset: 1, sessionMode: true },
    agentTurn: async (agent, prompt) => {
      opts.agentTurns?.push(`${agent}:${prompt}`);
    },
    boardMeeting: async extra => {
      opts.boards?.push(extra);
    },
  });
  return sent;
}

const html = (markdown: string): Sent => ({ text: markdownToTelegramHTML(markdown), other: { parse_mode: "HTML" } });

describe("Telegram: Texte wie vor der Umstellung", () => {
  test("/goals und goals", async () => {
    expect(await run("/goals")).toEqual([html("**Active Goals:**\n- Buch fertig")]);
    expect(await run("goals")).toEqual([html("**Active Goals:**\n- Buch fertig")]);
    expect(await run("goals", { htmlFails: true })).toEqual([{ text: "Active Goals:\n- Buch fertig" }]);
  });

  test("/topics mit und ohne Topic", async () => {
    const inTopic = await run("/topics", { topicId: 3 });
    const expected =
      "**Topic-Mapping fuer diesen Chat:**\n- Geld (3) → finance\n- Topic 12 → research\n\nDieses Topic: **Geld (3)** (Agent: finance).\n\nAnpassen: `config/topics.json` (greift ohne Neustart), Format siehe `config/topics.example.json`.";
    expect(inTopic).toEqual([html(expected)]);
    const noMap = await run("/topics", { topicId: 99 });
    expect(noMap[0].text).toBe(markdownToTelegramHTML(expected.replace("Dieses Topic: **Geld (3)** (Agent: finance).", "Dieses Topic: **Topic 99** (kein Mapping, Agent: general).")));
    const dm = await run("/topics");
    expect(dm[0].text).toContain("Dieser Chat hat keine Topics (DM/Gruppe ohne Foren-Modus).");
  });

  test("/new und /reset", async () => {
    expect(await run("/new")).toEqual([{ text: "Session zurueckgesetzt. Die naechste Nachricht startet mit frischem Kontext." }]);
    expect(await run("/reset", { reset: { status: "done", reset: 0, sessionMode: true } })).toEqual([
      { text: "Keine aktive Session in diesem Topic. Die naechste Nachricht startet ohnehin frisch." },
    ]);
    expect(await run("/new", { reset: { status: "done", reset: 2, sessionMode: false } })).toEqual([
      { text: "Session-Modus ist aus (SESSION_MODE=resume nicht gesetzt). Jede Nachricht startet ohnehin frisch." },
    ]);
  });

  test("/routine", async () => {
    expect(await run("/routine", { services: fakeServices({ isSessionModeEnabled: () => false }) })).toEqual([
      { text: "Session-Modus ist aus (SESSION_MODE=resume nicht gesetzt). Ohne Session-Kontext kann ich keinen Ablauf einfrieren." },
    ]);
    expect(await run("/routine")).toEqual([
      { text: "Keine aktive Session in diesem Topic. Erst den Ablauf einmal im Chat durchspielen, dann /routine." },
    ]);
    const hints: string[] = [];
    const sessions: RoutineSession[] = [
      { claudeSessionId: "alt", lastActivity: 1 },
      { claudeSessionId: "neu", lastActivity: 5 },
      { claudeSessionId: null, lastActivity: 9 },
    ];
    const services = fakeServices({
      sessionsForKey: async () => sessions,
      createRoutine: async (s, hint) => (hints.push(`${s.claudeSessionId}|${hint}`), { text: "Routine **fertig**" }),
    });
    expect(await run("/routine jeden Montag", { services })).toEqual([
      { text: "Ich friere den Ablauf dieser Session als Routine ein. Das kann ein paar Minuten dauern..." },
      html("Routine **fertig**"),
    ]);
    expect(hints).toEqual(["neu|jeden Montag"]);
    const failing = fakeServices({ sessionsForKey: async () => sessions, createRoutine: async () => ({ isError: true, text: "x" }) });
    expect((await run("/routine", { services: failing }))[1]).toEqual(
      html("Die Routine-Destillation ist fehlgeschlagen. Details: logs/telegram-relay.error.log")
    );
  });

  test("/plan", async () => {
    expect(await run("/plan")).toEqual([html("**Plan:** Max")]);
    expect(await run("/plan max20")).toEqual([html("**Plan:** Max")]);
  });

  test("/help und /hilfe: Spickzettel wie bisher, ohne /k3", async () => {
    const before = `🤖 **tybo Spickzettel**

**Einfach schreiben.** Normale Sprache reicht, der Agent dieses Topics antwortet. "Merk dir: ..." speichert einen Fakt, Ziele erkenne ich im Gespraech.

**Ziele (ich arbeite selbststaendig weiter):**
/goal <text> - Ziel setzen, ich arbeite dran bis fertig (und frage bei Budget-Ende nach)
/goal - Status · /goal pause · /goal weiter · /goal stop
/goal gate add <cmd> - Pruef-Kommando: muss gruen sein, bevor "fertig" zaehlt
/stop - laufende Antwort oder Ziel-Arbeit sofort abbrechen

**Sessions & Routinen:**
/new - Gespraech in diesem Topic frisch starten
/routine [Hinweis] - den hier gezeigten Ablauf als Routine einfrieren
Beim Session-Ende schlage ich Merk-Eintraege und Routinen selbst per Buttons vor.

**Agenten:**
/topics - welches Topic welchem Agenten gehoert
/agent - Agenten anpassen, z.B. /agent research: antworte kuerzer
@agentbot erwaehnen - holt diesen Agenten in ein beliebiges Topic
/board <thema> - alle Agenten diskutieren · /critic <idee> - Stress-Test

**Wissen:**
goals · memory · /tasks - gespeicherte Ziele, Fakten, offene Fragen
recall <frage> - alte Gespraeche durchsuchen
/learn <URL oder Text> - Quelle in die Knowledge Base destillieren

**Sonstiges:**
/voice <text> - Antwort als Sprachnachricht · "call me ..." - Anruf
/credit · /plan - Verbrauch · /k3 <frage> - Kimi K3 direkt`;
    // Einzige gewollte Änderung: der /k3-Hinweis ist weg (24.09.2026)
    // /jobs (Issue #103) kam dazu
    const expected = before
      .replace(" · /k3 <frage> - Kimi K3 direkt", "")
      .replace("/voice <text> - Antwort", "/jobs - Hintergrund-Jobs: laufende und zuletzt beendete\n/voice <text> - Antwort");
    expect(await run("/help")).toEqual([html(expected)]);
    expect(await run("/hilfe")).toEqual([html(expected)]);
    expect((await run("/help"))[0].text).not.toContain("k3");
  });

  test("/stop und /abbruch", async () => {
    const services = fakeServices();
    expect(await run("/stop", { services })).toEqual([{ text: "Hier laeuft gerade nichts, das ich abbrechen koennte." }]);
    expect(services.log).toEqual(["abort group:-1001"]);

    const busy = fakeServices({ abortClaudeCalls: () => 2, getGoal: async () => ({ status: "active" }) });
    expect(await run("/abbruch", { services: busy, topicId: 4 })).toEqual([
      { text: "⏹️ 2 laufende Verarbeitungen abgebrochen, Ziel pausiert (/goal weiter setzt fort)." },
    ]);
    expect(busy.log).toEqual(["pause topic:-1001:4 Vom User gestoppt (/stop)"]);
    const one = fakeServices({ abortClaudeCalls: () => 1 });
    expect(await run("/stop", { services: one })).toEqual([{ text: "⏹️ 1 laufende Verarbeitung abgebrochen." }]);
  });

  test("/stop während einer Board-Sitzung: endet nach dem laufenden Beitrag, kein harter Abbruch; zweites /stop bricht hart ab", async () => {
    let calls = 0;
    const services = fakeServices({
      requestBoardStop: key => (services.log.push(`board ${key}`), ++calls === 1 ? "requested" : "again"),
      abortClaudeCalls: key => (services.log.push(`abort ${key}`), 1),
    });
    expect(await run("/stop", { services, topicId: 4 })).toEqual([{ text: "⏹️ Board-Sitzung endet nach dem laufenden Beitrag." }]);
    expect(services.log).toEqual(["board topic:-1001:4"]);
    expect(await run("/stop", { services, topicId: 4 })).toEqual([{ text: "⏹️ 1 laufende Verarbeitung abgebrochen." }]);
    expect(services.log).toEqual(["board topic:-1001:4", "board topic:-1001:4", "abort topic:-1001:4"]);

    const withGoal = fakeServices({ requestBoardStop: () => "requested", getGoal: async () => ({ status: "active" }) });
    expect(await run("/stop", { services: withGoal })).toEqual([
      { text: "⏹️ Board-Sitzung endet nach dem laufenden Beitrag. Ziel pausiert (/goal weiter setzt fort)." },
    ]);
    expect(withGoal.log).toEqual(["pause group:-1001 Vom User gestoppt (/stop)"]);
  });

  test("/board, /board <thema> und „board meeting“ starten die Sitzung mit dem Thema", async () => {
    const boards: string[] = [];
    expect(await run("/board", { boards })).toEqual([]);
    await run("/board Newsletter starten?", { boards });
    await run("board meeting", { boards });
    await run("Board Meeting", { boards });
    await run("/BOARD Preis", { boards });
    expect(boards).toEqual(["", "Newsletter starten?", "", "", "Preis"]);
  });

  test("/agent: Übersicht, Anzeigen, undo, reset, hinzufügen, unbekannt", async () => {
    expect(await run("/agent")).toEqual([
      html(`**Agenten anpassen**, Beispiele:
\`/agent research: antworte kuerzer\` - Anweisung hinzufuegen
\`/agent research\` - Anweisungen anzeigen
\`/agent research undo\` - letzte entfernen · \`/agent research reset\` - alle loeschen

Agenten: general, research, critic

**Aktive Anpassungen:**
**research** (1):
  - antworte kuerzer`),
    ]);
    const empty = fakeServices({ listAllOverrides: () => ({}) });
    expect((await run("/agent", { services: empty }))[0].text).toContain("_Noch keine Anpassungen gespeichert._");

    expect(await run("/agent research")).toEqual([
      html("**Anpassungen fuer research:**\n1. antworte kuerzer\n\nEntfernen: `/agent research undo` (letzte) oder `/agent research reset` (alle)"),
    ]);
    expect(await run("/agent critic")).toEqual([html("Keine Anpassungen fuer critic. Hinzufuegen: `/agent critic: <anweisung>`")]);
    expect(await run("/agent research reset")).toEqual([{ text: "Alle 1 Anpassungen fuer research geloescht." }]);
    expect(await run("/agent critic reset")).toEqual([{ text: "Fuer critic war nichts gespeichert." }]);
    expect(await run("/agent research undo")).toEqual([{ text: 'Entfernt: "antworte kuerzer"' }]);
    expect(await run("/agent critic undo")).toEqual([{ text: "Fuer critic war nichts gespeichert." }]);
    expect(await run("/agent nobody: x")).toEqual([{ text: 'Unbekannter Agent "nobody". Verfuegbar: general, research, critic' }]);

    const services = fakeServices();
    expect(await run("/agent research: kürzer", { services })).toEqual([
      {
        text: 'Gespeichert. Der research-Agent haelt sich ab jetzt an: "kürzer" (2 Anweisungen aktiv).\n\nGilt ab der naechsten frischen Session, /new im betroffenen Topic erzwingt es sofort.',
      },
    ]);
    expect(services.log).toEqual(["add research kürzer"]);
    const first = fakeServices({ addAgentOverride: async () => 1 });
    expect((await run("/agent CFO: Zahlen zuerst", { services: first }))[0].text).toBe(
      'Gespeichert. Der finance-Agent haelt sich ab jetzt an: "Zahlen zuerst" (1 Anweisung aktiv).\n\nGilt ab der naechsten frischen Session, /new im betroffenen Topic erzwingt es sofort.'
    );
  });

  test("/learn", async () => {
    expect(await run("/learn")).toEqual([
      {
        text: "Nutzung: /learn <URL> oder /learn <laengerer Text>\nIch destilliere die Quelle in die Knowledge Base, die jeder Agent im Kontext hat.",
      },
    ]);
    expect(await run("/learn https://example.org")).toEqual([
      { text: "📚 Ich lese die Quelle und destilliere sie in die Knowledge Base..." },
      html("**Gelernt:** https://example.org"),
    ]);
  });

  test("/critic geht als Turn an den Critic, ohne eigene Antwort", async () => {
    const turns: string[] = [];
    expect(await run("/critic Wir starten einen Newsletter", { agentTurns: turns })).toEqual([]);
    expect(turns).toEqual(["critic:Wir starten einen Newsletter"]);
  });

  test("/voice ruft die Telegram-Sprachantwort", async () => {
    const calls: string[] = [];
    const services = fakeServices({ voiceReply: async (ctx, t) => void calls.push(`${ctx.channel}:${t}`) });
    expect(await run("/voice Hallo du", { services })).toEqual([]);
    expect(calls).toEqual(["telegram:Hallo du"]);
  });

  test("/voice (Issue #78): Telegram nimmt weiter voiceReply, kein zweiter Turn, kein Sprachweg der WebUI", async () => {
    const turns: string[] = [];
    const seen: unknown[] = [];
    const services = fakeServices({ voiceReply: async ctx => void seen.push(ctx.voiceMessage) });
    expect(await run("/voice Hallo", { services, agentTurns: turns })).toEqual([]);
    expect(turns).toEqual([]);
    expect(seen).toEqual([undefined]);
  });
});

describe("src/bot.ts nutzt das Register (als Text gelesen)", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "bot.ts"), "utf8");

  test("/voice in Telegram wie vorher (Issue #78): Hinweis vor dem Turn, Sprachnachricht, Text nur ohne Audio", () => {
    const start = source.indexOf("async function voiceReplyTelegram(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(0);
    // Ohne Stimme: nur der Hinweis, vor jedem Claude-Aufruf
    expect(body.indexOf("if (!isVoiceEnabled())")).toBeLessThan(body.indexOf("callClaude"));
    expect(body).toContain('type: "voice_reply"');
    expect(body).toContain("const audioBuffer = await textToSpeech(claudeResponse);");
    expect(body).toContain('await ctx.replyWithVoice(new InputFile(audioBuffer, "response.mp3"));');
    expect(body).toContain("Could not generate voice. Here's the text response:");
    expect(source).toContain("voiceReply: (_cmd, voiceText) => voiceReplyTelegram(ctx, chatId, topicId, voiceText)");
  });

  test("keine eigene Kette mehr für die umgestellten Befehle", () => {
    for (const old of ['"/topics"', '"/new"', '"/routine"', '"/plan"', '"/help"', '"/stop"', '"/agent"', '"/learn"', '"/critic ', '"/voice ', '"/goals"', '"/goal"', '"/goal "']) {
      expect(source).not.toContain(`lowerText === ${old}`);
      expect(source).not.toContain(`lowerText.startsWith(${old}`);
    }
    expect(source).toContain('commandRegistry.match(text, "telegram")');
  });

  test("/k3 ist als Befehl entfernt, Kimi K3 bleibt in der Fallback-Kette", () => {
    expect(source).not.toMatch(/\/k3/);
    expect(source).not.toContain("callK3");
    const fallback = readFileSync(join(import.meta.dir, "..", "src", "lib", "fallback-llm.ts"), "utf8");
    expect(fallback).toContain("callK3");
  });

  test("/memory, /tasks, /credit bleiben in Telegram; /board (Issue #75) und /goal (Issue #76) kommen aus dem Register", () => {
    expect(source).not.toContain('lowerText === "/goal"');
    // /goal pause und /goal stop laufen in Telegram weiter ohne Update-Bereich
    expect(source).toContain("/^\\/(stop|new|goal\\s+(pause|stop))\\b/i");
    expect(source).not.toContain('lowerText.startsWith("/board ")');
    expect(source).not.toContain('lowerText === "board meeting"');
    expect(source).toContain('lowerText === "/memory"');
    expect(source).toContain('lowerText === "/tasks"');
    expect(source).toContain('lowerText === "/credit"');
  });
});
