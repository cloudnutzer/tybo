/**
 * Telegram-Antworten der umgestellten Befehle (Issue #74): wortgleich mit
 * der früheren if-Kette in src/bot.ts. Die erwarteten Texte stehen hier fest
 * (aus dem Stand vor der Umstellung kopiert), die Abhängigkeiten sind
 * Attrappen; src/bot.ts wird nie gelesen oder importiert.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commandRegistry } from "../src/lib/commands/builtin";
import { createTelegramTextInbox } from "../src/channels/telegram/text-inbox";
import { runsImmediately } from "../src/channels/telegram/update-scope";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices, RoutineSession, SessionResetOutcome } from "../src/lib/commands/types";
import { markdownToTelegramHTML } from "../src/lib/telegram";
import { runFallbackChain } from "../src/lib/fallback/chain";
import { setSettingsPath } from "../src/lib/settings";
import { tmpdir } from "node:os";

type Sent = { text: string; other?: Record<string, unknown> };

function fakeServices(over: Partial<CommandServices> = {}): CommandServices & { log: string[] } {
  const log: string[] = [];
  const overrides: Record<string, string[]> = { research: ["antworte kuerzer"] };
  return {
    log,
    isSessionModeEnabled: () => true,
    getGoal: async () => undefined,
    pauseGoal: async (key, reason) => log.push(`pause ${key} ${reason}`),
    abortEngineCalls: key => (log.push(`abort ${key}`), 0),
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
    formatCredit: async () => "💳 **Claude-Abo**\n1,00 $ von 20 $ (5 %)",
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

describe("Telegram: /credit und /plan (Issue #346)", () => {
  test("/credit und credit ohne Schrägstrich zeigen den Verbrauch als HTML, Rückfall Klartext", async () => {
    const expected = html("💳 **Claude-Abo**\n1,00 $ von 20 $ (5 %)");
    expect(await run("/credit")).toEqual([expected]);
    expect(await run("credit")).toEqual([expected]);
    expect(await run("Credit")).toEqual([expected]);
    expect(await run("/credit", { htmlFails: true })).toEqual([{ text: "💳 **Claude-Abo**\n1,00 $ von 20 $ (5 %)" }]);
  });

  test("/plan zeigt den Text der Dienste", async () => {
    expect(await run("/plan")).toEqual([html("**Plan:** Max")]);
  });
});

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
      { engineSessionId: "alt", lastActivity: 1 },
      { engineSessionId: "neu", lastActivity: 5 },
      { engineSessionId: null, lastActivity: 9 },
    ];
    const services = fakeServices({
      sessionsForKey: async () => sessions,
      createRoutine: async (s, hint) => (hints.push(`${s.engineSessionId}|${hint}`), { text: "Routine **fertig**" }),
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
/routinen - zeitgesteuerte Dienste: Zeitplan, Status, letzter und naechster Lauf
/routinen <name> - letzte 20 Laeufe mit Knoepfen: Jetzt testen, Pausieren, Fortsetzen
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
    // /jobs (Issue #103), /motor (Issue #125), /faeden (Issue #290, #291) und /erinnerungen (Issue #323) kamen dazu
    const expected = before
      .replace(" · /k3 <frage> - Kimi K3 direkt", "")
      .replace(
        "/new - Gespraech in diesem Topic frisch starten\n",
        "/new - Gespraech in diesem Topic frisch starten\n/motor - Motor und Stand dieses Gespraechs · /motor werkzeuge · /motor codex · /motor opencode · /motor claude · /motor api · /motor standard\n/motor pruefen - neu messen · /motor auto an · /motor auto aus\n"
      )
      .replace("/voice <text> - Antwort", "/jobs - Hintergrund-Jobs: laufende und zuletzt beendete\n/voice <text> - Antwort")
      .replace("recall <frage> - alte", "/faeden - offene Faeden: meine Fragen, auf die noch eine Antwort fehlt\n/faeden zu <nr> - Faden schliessen · /faeden alle - auch die geschlossenen der letzten 7 Tage\n/erinnerungen - offene Erinnerungen aller Gespraeche · /erinnerungen absagen <kennung>\nrecall <frage> - alte")
      // Gedächtnis-Befehle in allen Kanälen (Issue #333)
      .replace(
        "goals · memory · /tasks - gespeicherte Ziele, Fakten, offene Fragen\n",
        "goals · memory · /tasks - gespeicherte Ziele, Fakten, offene Fragen\n/remember <fakt> · /forget <text> - Fakt merken bzw. vergessen\n/kern - fester Kern: steht bei jedem Start einer Session im Prompt · /kern entwurf · /kern setzen <text> · /kern loeschen\n/track <ziel> [| deadline: <frist>] · /done <text> · /cancel <text> - gespeichertes Ziel anlegen, erledigen, streichen\n"
      )
      .replace("recall <frage> - alte Gespraeche durchsuchen", "/recall <frage> - alte Gespraeche durchsuchen (auch /search, /find)")
      // /anruf statt "call me" (Issue #367)
      .replace('"call me ..." - Anruf', "/anruf [anlass] - ich rufe dich an")
      // /sprachagent (Issue #492)
      .replace("/anruf [anlass] - ich rufe dich an\n", "/anruf [anlass] - ich rufe dich an\n/sprachagent - Sprachagenten aus Rezepten: liste (auch /sprachagenten) · testen <kennung> · loeschen <kennung> · link <kennung>\n")
      // /credit in allen Kanälen, /plan mit eigenem Hinweis (Issue #346)
      .replace("/credit · /plan - Verbrauch", "/credit - Verbrauch (Claude-Abo, Motoren) · /plan - Limit und Reset-Tag");
    expect(await run("/help")).toEqual([html(expected)]);
    expect(await run("/hilfe")).toEqual([html(expected)]);
    expect((await run("/help"))[0].text).not.toContain("k3");
  });

  test("/stop und /abbruch", async () => {
    const services = fakeServices();
    expect(await run("/stop", { services })).toEqual([{ text: "Hier laeuft gerade nichts, das ich abbrechen koennte." }]);
    expect(services.log).toEqual(["abort group:-1001"]);

    const busy = fakeServices({ abortEngineCalls: () => 2, getGoal: async () => ({ status: "active" }) });
    expect(await run("/abbruch", { services: busy, topicId: 4 })).toEqual([
      { text: "⏹️ 2 laufende Verarbeitungen abgebrochen, Ziel pausiert (/goal weiter setzt fort)." },
    ]);
    expect(busy.log).toEqual(["pause topic:-1001:4 Vom User gestoppt (/stop)"]);
    const one = fakeServices({ abortEngineCalls: () => 1 });
    expect(await run("/stop", { services: one })).toEqual([{ text: "⏹️ 1 laufende Verarbeitung abgebrochen." }]);
  });

  test("/stop während einer Board-Sitzung: endet nach dem laufenden Beitrag, kein harter Abbruch; zweites /stop bricht hart ab", async () => {
    let calls = 0;
    const services = fakeServices({
      requestBoardStop: key => (services.log.push(`board ${key}`), ++calls === 1 ? "requested" : "again"),
      abortEngineCalls: key => (services.log.push(`abort ${key}`), 1),
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

describe("Telegram nutzt das Register (Issue #344: Verhalten des Text-Eingangs)", () => {
  // /voice in Telegram: Verhalten in tests/telegram-commands.test.ts („/voice")
  /** Text-Eingang mit dem echten Register; zählt Befehle und Agenten-Antworten */
  async function route(text: string) {
    const seen = { commands: [] as string[], replies: 0, credit: 0 };
    const inbox = createTelegramTextInbox({
      captureTopicName: async () => {},
      saveMessage: async () => {},
      matchCommand: t => commandRegistry.match(t, "telegram"),
      runCommand: async (_ctx, _c, _t, _text, match) => void seen.commands.push(match.command.name),
      agentForMention: () => null,
      isActiveAgent: () => true,
      topicAgent: () => undefined,
      claimTopicQuestion: async () => false,
      askTopicAgent: async () => true,
      agentNames: () => [],
      reply: async () => void seen.replies++,
    });
    await inbox({ chat: { id: 1 }, message: { text }, reply: async () => ({}) });
    return seen;
  }

  test("die umgestellten Befehle laufen über das Register, keine Agenten-Antwort", async () => {
    for (const text of ["/topics", "/new", "/routine", "/plan", "/help", "/stop", "/agent", "/learn https://example.org", "/critic Plan", "/voice hallo", "/goals", "/goal status", "/board Thema", "/memory", "tasks"]) {
      const seen = await route(text);
      expect(seen.commands).toHaveLength(1);
      expect(seen.replies).toBe(0);
    }
  });

  test("/k3 ist als Befehl entfernt, Kimi K3 bleibt erste Stufe der Fallback-Kette", async () => {
    expect(commandRegistry.match("/k3", "telegram")).toBeFalsy();
    // Verhalten statt Quelltext (Issue #331): mit Schlüssel fragt die Kette zuerst K3
    const savedKey = process.env.OPENROUTER_API_KEY;
    const savedK3 = process.env.FALLBACK_K3;
    process.env.OPENROUTER_API_KEY = "test-schluessel-nicht-echt";
    delete process.env.FALLBACK_K3;
    const models: string[] = [];
    // eine Einstellungsdatei des Rechners (etwa „nur offline") darf nicht mitspielen
    setSettingsPath(join(tmpdir(), `tybo-k3-${process.pid}-keine-datei.json`));
    try {
      const result = await runFallbackChain(
        { question: "Frage", context: "## MEMORY\nTest" },
        {
          tools: () => undefined,
          callClaude: async () => ({ text: "", isError: true }),
          loop: {
            fetch: (async (_url: unknown, init?: RequestInit) => {
              models.push(JSON.parse(String(init?.body)).model);
              return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "von k3" } }] }));
            }) as typeof fetch,
            callTool: async () => ({ content: "", isError: false }),
            reserve: () => "r",
            settle: () => {},
          },
        }
      );
      expect(result).toEqual({ text: "von k3", source: "kimi-k3", model: "moonshotai/kimi-k3" });
      expect(models).toEqual(["moonshotai/kimi-k3"]);
    } finally {
      setSettingsPath();
      if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedKey;
      if (savedK3 !== undefined) process.env.FALLBACK_K3 = savedK3;
    }
  });

  test("/credit und credit (Issue #346), /board (Issue #75), /goal (Issue #76), /memory (Issue #333) und /tasks (Issue #337) kommen aus dem Register", async () => {
    expect(commandRegistry.match("/memory", "telegram")?.command.name).toBe("memory");
    expect(commandRegistry.match("tasks", "telegram")?.command.name).toBe("tasks");
    for (const text of ["/credit", "credit", "/plan"]) {
      const seen = await route(text);
      expect(seen.commands).toEqual([text === "/plan" ? "plan" : "credit"]);
      expect(seen.replies).toBe(0);
    }
    // /goal pause und /goal stop laufen in Telegram ohne Update-Bereich
    expect(runsImmediately("/goal pause")).toBe(true);
    expect(runsImmediately("/goal stop")).toBe(true);
  });
});
