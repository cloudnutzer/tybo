/**
 * Befehle der gemeinsamen Schicht (Issue #74). Die Texte sind wortgleich
 * mit der früheren if-Kette in src/bot.ts (tests/commands-telegram.test.ts
 * hält sie fest); nur /k3 ist entfallen (24.09.2026).
 *
 * /goal (Issue #76) steht seit dem Umzug auch hier, Texte wortgleich.
 * Noch in src/bot.ts und nur in Telegram: /memory, /tasks, /credit, recall,
 * remember: und Co.
 */

import { BRAND } from "../../brand";
import { BOARD_TEXT } from "../board-meeting";
import { chunkForTelegram } from "../telegram";
import { createCommandRegistry } from "./registry";
import { ALL_CHANNELS, type CommandContext, type CommandDefinition } from "./types";

export const SESSION_MODE_OFF_TEXT =
  "Session-Modus ist aus (SESSION_MODE=resume nicht gesetzt). Jede Nachricht startet ohnehin frisch.";

export const COMMAND_TEXT = {
  resetDone: "Session zurueckgesetzt. Die naechste Nachricht startet mit frischem Kontext.",
  resetNone: "Keine aktive Session in diesem Topic. Die naechste Nachricht startet ohnehin frisch.",
  resetOff: SESSION_MODE_OFF_TEXT,
  // Nur Browser und Terminal (Telegram setzt ohne Sperre zurück)
  resetBusy: "In diesem Gespräch läuft gerade eine Antwort. Erst /stop, dann /new.",
  resetUnavailable: "Für dieses Gespräch lässt sich keine Session ermitteln.",
  nothingToStop: "Hier laeuft gerade nichts, das ich abbrechen koennte.",
  // /voice aus Browser und Terminal (Issue #78); Telegram behält seine eigenen Texte
  voiceNotConfigured: "Sprachausgabe ist nicht eingerichtet (lokales TTS, ElevenLabs oder Gemini).",
  voiceMirroredOnly: "Sprachnachrichten gibt es nur in Gesprächen, die mit Telegram gespiegelt sind.",
  voiceSent: "Sprachnachricht in Telegram gesendet.",
  voiceFailed: "Sprachnachricht konnte nicht erzeugt werden, die Antwort steht oben als Text.",
  voiceAborted: "Sprachnachricht abgebrochen.",
} as const;

export const HELP_TEXT = `🤖 **${BRAND.name} Spickzettel**

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
/jobs - Hintergrund-Jobs: laufende und zuletzt beendete
/voice <text> - Antwort als Sprachnachricht · "call me ..." - Anruf
/credit · /plan - Verbrauch`;

const markdown = { format: "markdown" } as const;

async function runGoals(ctx: CommandContext): Promise<void> {
  const goals = await ctx.services.listGoals();
  await ctx.reply(`**Active Goals:**\n${goals}`, { format: "markdown", plainFallback: `Active Goals:\n${goals}` });
}

async function runTopics(ctx: CommandContext): Promise<void> {
  const { chatId, topicId } = ctx;
  const mapping = ctx.services.topicMapping(chatId);
  const names = await ctx.services.topicNames();
  const label = (id: string | number) => (names[String(id)] ? `${names[String(id)]} (${id})` : `Topic ${id}`);
  const lines = Object.entries(mapping)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, agent]) => `- ${label(id)} → ${agent}`);
  const here =
    topicId !== undefined
      ? `Dieses Topic: **${label(topicId)}**${mapping[String(topicId)] ? ` (Agent: ${mapping[String(topicId)]})` : " (kein Mapping, Agent: general)"}.`
      : "Dieser Chat hat keine Topics (DM/Gruppe ohne Foren-Modus).";
  const reply = `**Topic-Mapping fuer diesen Chat:**\n${lines.join("\n") || "- (keins)"}\n\n${here}\n\nAnpassen: \`config/topics.json\` (greift ohne Neustart), Format siehe \`config/topics.example.json\`.`;
  await ctx.reply(reply, markdown);
}

async function runNew(ctx: CommandContext): Promise<void> {
  const result = await ctx.resetSession();
  if (result.status === "busy") return ctx.reply(COMMAND_TEXT.resetBusy);
  if (result.status === "unavailable") return ctx.reply(COMMAND_TEXT.resetUnavailable);
  const reply = result.sessionMode ? (result.reset > 0 ? COMMAND_TEXT.resetDone : COMMAND_TEXT.resetNone) : COMMAND_TEXT.resetOff;
  await ctx.reply(reply);
}

async function runRoutine(ctx: CommandContext): Promise<void> {
  const hint = ctx.args;
  if (!ctx.services.isSessionModeEnabled()) {
    await ctx.reply(
      "Session-Modus ist aus (SESSION_MODE=resume nicht gesetzt). Ohne Session-Kontext kann ich keinen Ablauf einfrieren."
    );
    return;
  }
  const session = (await ctx.services.sessionsForKey(ctx.sessionKey))
    .filter(s => s.claudeSessionId)
    .sort((a, b) => b.lastActivity - a.lastActivity)[0];
  if (!session) {
    await ctx.reply("Keine aktive Session in diesem Topic. Erst den Ablauf einmal im Chat durchspielen, dann /routine.");
    return;
  }
  await ctx.notice("Ich friere den Ablauf dieser Session als Routine ein. Das kann ein paar Minuten dauern...");
  const stop = ctx.working();
  try {
    const result = await ctx.services.createRoutine(session, hint);
    const reply =
      result.isError || !result.text ? "Die Routine-Destillation ist fehlgeschlagen. Details: logs/telegram-relay.error.log" : result.text;
    await ctx.reply(reply, markdown);
  } finally {
    stop();
  }
}

async function runPlan(ctx: CommandContext): Promise<void> {
  await ctx.reply(await ctx.services.formatPlan(), markdown);
}

/** Übersicht aus data/jobs im Projektordner des Bots (Titel ohne Werte aus .env) */
async function defaultJobsOverview(): Promise<string> {
  const [{ PROJECT_ROOT }, { formatJobList }, { projectSecrets }] = await Promise.all([
    import("../env"),
    import("../jobs/control"),
    import("../jobs/mask"),
  ]);
  return formatJobList({ root: PROJECT_ROOT, now: () => new Date(), secrets: () => projectSecrets(PROJECT_ROOT) });
}

async function runJobs(ctx: CommandContext): Promise<void> {
  const overview = ctx.services.jobsOverview ? await ctx.services.jobsOverview() : await defaultJobsOverview();
  // Telegram nimmt höchstens 4096 Zeichen je Nachricht, die Liste kann länger sein
  // (alle laufenden Jobs plus 20 beendete); geteilt wird an Zeilengrenzen
  const parts = ctx.channel === "telegram" ? chunkForTelegram(overview) : [overview];
  for (const part of parts) await ctx.reply(part);
}

async function runHelp(ctx: CommandContext): Promise<void> {
  await ctx.reply(HELP_TEXT, markdown);
}

async function runStop(ctx: CommandContext): Promise<void> {
  const { sessionKey, services } = ctx;
  const activeGoal = await services.getGoal(sessionKey);
  if (activeGoal?.status === "active") {
    await services.pauseGoal(sessionKey, "Vom User gestoppt (/stop)");
  }
  // Board-Sitzung (Issue #75): der laufende Beitrag wird fertig, danach Schluss;
  // erst ein zweites /stop bricht hart ab
  if (services.requestBoardStop?.(sessionKey) === "requested") {
    await ctx.reply(
      activeGoal?.status === "active" ? `${BOARD_TEXT.stopRequested} Ziel pausiert (/goal weiter setzt fort).` : BOARD_TEXT.stopRequested
    );
    return;
  }
  const killed = services.abortClaudeCalls(sessionKey);
  const parts: string[] = [];
  if (killed > 0) parts.push(`${killed} laufende Verarbeitung${killed > 1 ? "en" : ""} abgebrochen`);
  if (activeGoal?.status === "active") parts.push("Ziel pausiert (/goal weiter setzt fort)");
  await ctx.reply(parts.length > 0 ? `⏹️ ${parts.join(", ")}.` : COMMAND_TEXT.nothingToStop);
}

export const GOAL_TEXT = {
  unavailable: "Ziele sind hier nicht eingerichtet.",
  webOnly: "Ziele gehen nur im Direktchat und in Telegram-Topics, nicht in älteren Web-Gesprächen.",
  paused: "⏸️ Ziel pausiert. /goal weiter setzt fort.",
  noActive: "Kein aktives Ziel in diesem Topic.",
  resumed: "▶️ Weiter geht's, ich arbeite am Ziel.",
  noGoalSet: "Kein Ziel in diesem Topic. Neu setzen: /goal <text>",
  stopped: (goal: string | undefined) => `🛑 Ziel beendet: "${goal?.substring(0, 120)}"`,
  noGoal: "Kein Ziel in diesem Topic.",
  gateFirst: "Erst ein Ziel setzen (/goal <text>), dann Gates hinzufuegen.",
  noGates: "Keine Gates gesetzt. Hinzufuegen: /goal gate add <shell-kommando>",
  gatesCleared: "Alle Gates entfernt.",
  gateUsageAdd: "Nutzung: /goal gate add <shell-kommando>",
  gateAdded: (cmd: string) => `Gate hinzugefuegt: \`${cmd}\`\nEs muss mit Exit 0 durchlaufen, bevor der Judge "fertig" sagen darf.`,
  gateUsage: "Nutzung: /goal gate add <cmd> · /goal gate list · /goal gate clear",
  maxUsage: "Nutzung: /goal max <1-100>",
  maxSet: (n: number) => `Turn-Budget: ${n}.`,
  set: (agent: string, maxTurns: number, goal: string) =>
    `🎯 Ziel gesetzt (Agent: ${agent}, Budget: ${maxTurns} Turns):\n"${goal}"\n\nIch lege los und arbeite selbststaendig weiter, bis es erreicht ist. Nach jedem Schritt prueft ein Judge den Stand. Bei Budget-Ende frage ich nach.\n\n/stop bricht ab · /goal pause pausiert · /goal gate add <cmd> ergaenzt einen harten Check.`,
} as const;

const GOAL_STOP_WORDS = ["stop", "cancel", "done", "abbrechen"];
const GOAL_RESUME_WORDS = ["weiter", "resume", "continue"];

/** /goal pause und /goal stop (samt Aliasen): ohne Bereich wie in Telegram handleUpdateScope */
function goalUnscoped(args: string): boolean {
  const sub = args.trim().toLowerCase();
  return sub === "pause" || GOAL_STOP_WORDS.includes(sub);
}

async function runGoal(ctx: CommandContext): Promise<void> {
  const goals = ctx.services.goals;
  if (!goals) return ctx.reply(GOAL_TEXT.unavailable);
  // Ältere reine Web-Gespräche haben keinen Telegram-Chat für Statusmeldungen und Agenten-Antworten
  if (ctx.chatId.startsWith("web:")) return ctx.reply(GOAL_TEXT.webOnly);
  const rest = ctx.args;
  const sessionKey = ctx.sessionKey;
  const sub = rest.toLowerCase();

  if (!rest || sub === "status") {
    await ctx.reply(goals.formatStatus(await goals.get(sessionKey)), markdown);
    return;
  }

  if (sub === "pause") {
    const result = await goals.action(sessionKey, "pause");
    await ctx.reply(result.status === "ok" ? GOAL_TEXT.paused : GOAL_TEXT.noActive);
    return;
  }

  if (GOAL_RESUME_WORDS.includes(sub)) {
    const result = await goals.action(sessionKey, "resume");
    await ctx.reply(result.status === "ok" ? GOAL_TEXT.resumed : GOAL_TEXT.noGoalSet);
    return;
  }

  if (GOAL_STOP_WORDS.includes(sub)) {
    const result = await goals.action(sessionKey, "stop");
    // Wie bisher: auch ohne Ziel laufende Aufrufe des Gesprächs abbrechen
    if (result.status !== "ok") ctx.services.abortClaudeCalls(sessionKey);
    await ctx.reply(result.status === "ok" ? GOAL_TEXT.stopped(result.goal.goal) : GOAL_TEXT.noGoal);
    return;
  }

  if (sub.startsWith("gate ")) {
    const g = await goals.get(sessionKey);
    if (!g) {
      await ctx.reply(GOAL_TEXT.gateFirst);
      return;
    }
    const gateArg = rest.slice(5).trim();
    if (gateArg.toLowerCase() === "list") {
      await ctx.reply(g.gates.length > 0 ? `Gates:\n${g.gates.map((c, i) => `${i + 1}. ${c}`).join("\n")}` : GOAL_TEXT.noGates);
      return;
    }
    if (gateArg.toLowerCase() === "clear") {
      await goals.update(sessionKey, { gates: [] });
      await ctx.reply(GOAL_TEXT.gatesCleared);
      return;
    }
    if (gateArg.toLowerCase().startsWith("add ")) {
      const cmd = gateArg.slice(4).trim();
      if (!cmd) {
        await ctx.reply(GOAL_TEXT.gateUsageAdd);
        return;
      }
      await goals.update(sessionKey, { gates: [...g.gates, cmd] });
      await ctx.reply(GOAL_TEXT.gateAdded(cmd));
      return;
    }
    await ctx.reply(GOAL_TEXT.gateUsage);
    return;
  }

  if (sub.startsWith("max ")) {
    const n = parseInt(rest.slice(4).trim(), 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      await ctx.reply(GOAL_TEXT.maxUsage);
      return;
    }
    const g = await goals.update(sessionKey, { maxTurns: n });
    await ctx.reply(g ? GOAL_TEXT.maxSet(n) : GOAL_TEXT.noGoalSet);
    return;
  }

  // Neues Ziel setzen und sofort loslegen
  const g = await goals.set({
    sessionKey,
    chatId: ctx.chatId,
    ...(ctx.topicId !== undefined ? { topicId: ctx.topicId } : {}),
    agentName: ctx.agent,
    goal: rest,
  });
  await ctx.reply(GOAL_TEXT.set(ctx.agent, g.maxTurns, rest));
  goals.start(sessionKey);
}

async function runBoard(ctx: CommandContext): Promise<void> {
  await ctx.boardMeeting(ctx.args);
}

async function runAgent(ctx: CommandContext): Promise<void> {
  const { services } = ctx;
  const rest = ctx.args;

  if (!rest) {
    // Geloeschte Agenten (Issue #49) erscheinen nicht unter "Aktive Anpassungen"
    const all = services.listAllOverrides();
    const lines = Object.entries(all).map(
      ([agent, list]) => `**${agent}** (${list.length}):\n${list.map(o => `  - ${o}`).join("\n")}`
    );
    const reply = `**Agenten anpassen**, Beispiele:
\`/agent research: antworte kuerzer\` - Anweisung hinzufuegen
\`/agent research\` - Anweisungen anzeigen
\`/agent research undo\` - letzte entfernen · \`/agent research reset\` - alle loeschen

Agenten: ${services.listAgentNames().join(", ")}

${lines.length > 0 ? `**Aktive Anpassungen:**\n${lines.join("\n\n")}` : "_Noch keine Anpassungen gespeichert._"}`;
    await ctx.reply(reply, markdown);
    return;
  }

  const match = rest.match(/^([\p{L}-]+)\s*:?\s*([\s\S]*)$/u);
  const rawName = match?.[1] || "";
  const payload = (match?.[2] || "").trim();
  const agent = services.resolveAgentName(rawName);

  if (!agent) {
    await ctx.reply(`Unbekannter Agent "${rawName}". Verfuegbar: ${services.listAgentNames().join(", ")}`);
    return;
  }

  if (!payload) {
    const overrides = services.getAgentOverrides(agent);
    const reply =
      overrides.length > 0
        ? `**Anpassungen fuer ${agent}:**\n${overrides.map((o, i) => `${i + 1}. ${o}`).join("\n")}\n\nEntfernen: \`/agent ${agent} undo\` (letzte) oder \`/agent ${agent} reset\` (alle)`
        : `Keine Anpassungen fuer ${agent}. Hinzufuegen: \`/agent ${agent}: <anweisung>\``;
    await ctx.reply(reply, markdown);
    return;
  }

  if (payload.toLowerCase() === "reset") {
    const count = await services.clearAgentOverrides(agent, ctx.beginWrite);
    await ctx.reply(count > 0 ? `Alle ${count} Anpassungen fuer ${agent} geloescht.` : `Fuer ${agent} war nichts gespeichert.`);
    return;
  }

  if (payload.toLowerCase() === "undo") {
    const removed = await services.removeLastAgentOverride(agent, ctx.beginWrite);
    await ctx.reply(removed ? `Entfernt: "${removed}"` : `Fuer ${agent} war nichts gespeichert.`);
    return;
  }

  const count = await services.addAgentOverride(agent, payload, ctx.beginWrite);
  await ctx.reply(
    `Gespeichert. Der ${agent}-Agent haelt sich ab jetzt an: "${payload}" (${count} Anweisung${count > 1 ? "en" : ""} aktiv).\n\nGilt ab der naechsten frischen Session, /new im betroffenen Topic erzwingt es sofort.`
  );
}

async function runLearn(ctx: CommandContext): Promise<void> {
  const input = ctx.args;
  if (!input) {
    await ctx.reply(
      "Nutzung: /learn <URL> oder /learn <laengerer Text>\nIch destilliere die Quelle in die Knowledge Base, die jeder Agent im Kontext hat."
    );
    return;
  }
  await ctx.notice("📚 Ich lese die Quelle und destilliere sie in die Knowledge Base...");
  const stop = ctx.working();
  try {
    const result = await ctx.services.learn(input, ctx.beginWrite);
    await ctx.reply(result.message, markdown);
  } finally {
    stop();
  }
}

async function runCritic(ctx: CommandContext): Promise<void> {
  await ctx.agentTurn("critic", ctx.args);
}

const VOICE_RESULT_TEXT = {
  sent: COMMAND_TEXT.voiceSent,
  failed: COMMAND_TEXT.voiceFailed,
  aborted: COMMAND_TEXT.voiceAborted,
} as const;

async function runVoice(ctx: CommandContext): Promise<void> {
  // Telegram: unverändert voiceReplyTelegram in src/bot.ts
  if (ctx.services.voiceReply) {
    await ctx.services.voiceReply(ctx, ctx.args);
    return;
  }
  // Browser und Terminal (Issue #78): Antwort als Text wie /critic, dazu die
  // Sprachnachricht ins gespiegelte Telegram-Gespräch; ohne Ziel oder Stimme kein Turn
  const voice = ctx.voiceMessage;
  if (!voice) {
    await ctx.reply(COMMAND_TEXT.voiceMirroredOnly);
    return;
  }
  if (!voice.enabled()) {
    await ctx.reply(COMMAND_TEXT.voiceNotConfigured);
    return;
  }
  const answer = await ctx.agentTurn(ctx.agent, ctx.args, { replyType: "voice_reply" });
  if (answer === undefined) return;
  await ctx.reply(VOICE_RESULT_TEXT[await voice.send(answer)]);
}

export const BUILTIN_COMMANDS: readonly CommandDefinition[] = [
  { name: "help", aliases: ["hilfe"], description: "Spickzettel aller Befehle", args: "none", channels: ALL_CHANNELS, run: runHelp },
  {
    name: "stop",
    aliases: ["abbruch"],
    description: "Laufende Antwort oder Ziel-Arbeit sofort abbrechen",
    args: "none",
    channels: ALL_CHANNELS,
    whileBusy: true,
    run: runStop,
  },
  { name: "new", aliases: ["reset"], description: "Gespräch frisch starten, der Verlauf bleibt", args: "none", channels: ALL_CHANNELS, run: runNew },
  { name: "topics", aliases: [], description: "Welches Topic welchem Agenten gehört", args: "none", channels: ALL_CHANNELS, run: runTopics },
  {
    name: "agent",
    aliases: [],
    description: "Agenten anpassen, z.B. /agent research: antworte kuerzer",
    args: "optional",
    argsHint: "[<agent>[: <anweisung>|undo|reset]]",
    channels: ALL_CHANNELS,
    run: runAgent,
  },
  {
    name: "goal",
    aliases: [],
    description: "Stehendes Ziel: ich arbeite selbstständig weiter, bis es erreicht ist",
    args: "optional",
    argsHint: "[<ziel>|status|pause|weiter|stop|max <n>|gate add <cmd>|gate list|gate clear]",
    channels: ALL_CHANNELS,
    unscoped: goalUnscoped,
    run: runGoal,
  },
  { name: "goals", aliases: [], bareWords: ["goals"], description: "Gespeicherte Ziele", args: "none", channels: ALL_CHANNELS, run: runGoals },
  {
    name: "learn",
    aliases: [],
    description: "Quelle in die Knowledge Base destillieren",
    args: "optional",
    argsHint: "<URL oder Text>",
    channels: ALL_CHANNELS,
    run: runLearn,
  },
  { name: "plan", aliases: [], description: "Plan-Obergrenze für das Guthaben anzeigen", args: "optional", channels: ALL_CHANNELS, run: runPlan },
  {
    name: "critic",
    aliases: [],
    description: "Stress-Test einer Idee durch den Critic",
    args: "required",
    telegramArgSeparators: [" ", "\n"],
    argsHint: "<idee>",
    channels: ALL_CHANNELS,
    run: runCritic,
  },
  {
    name: "board",
    aliases: [],
    // Wie bisher in Telegram auch ohne Schrägstrich
    bareWords: ["board meeting"],
    description: "Board-Sitzung: alle Board-Agenten nacheinander, dann die Zusammenfassung",
    args: "optional",
    argsHint: "[thema]",
    channels: ALL_CHANNELS,
    run: runBoard,
  },
  {
    name: "routine",
    aliases: [],
    description: "Den hier gezeigten Ablauf als Routine einfrieren",
    args: "optional",
    argsHint: "[Hinweis]",
    channels: ALL_CHANNELS,
    run: runRoutine,
  },
  { name: "jobs", aliases: [], description: "Hintergrund-Jobs: laufende und zuletzt beendete", args: "none", channels: ALL_CHANNELS, run: runJobs },
  {
    name: "voice",
    aliases: [],
    // Aus Browser und Terminal kommt die Sprachnachricht in Telegram an (Issue #78)
    description: "Antwort als Sprachnachricht",
    args: "required",
    telegramArgSeparators: [" ", "\n"],
    argsHint: "<text>",
    channels: ALL_CHANNELS,
    run: runVoice,
  },
];

export const commandRegistry = createCommandRegistry(BUILTIN_COMMANDS);
