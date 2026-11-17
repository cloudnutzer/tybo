/**
 * Befehle der gemeinsamen Schicht (Issue #74). Die Texte sind wortgleich
 * mit der früheren if-Kette in src/bot.ts (tests/commands-telegram.test.ts
 * hält sie fest); nur /k3 ist entfallen (24.09.2026).
 *
 * /goal (Issue #76) steht seit dem Umzug auch hier, Texte wortgleich.
 * Die Gedächtnis-Befehle (/remember, /recall und Co., Issue #333) stehen in
 * ./memory.ts, /kern (Issue #522) in ./core.ts, /tasks (Issue #337) in ./tasks.ts. /credit (in Telegram auch
 * „credit" ohne Schrägstrich) und /plan zeigen seit Issue #346 in allen
 * Kanälen den Stand aus src/lib/spend/credit.ts.
 */

import { BRAND } from "../../brand";
import { BOARD_TEXT } from "../board-meeting";
import { formatRoutineHistory, formatRoutineList } from "../routines/format";
import { routineLogLine } from "../routines/log";
import { cancelReminder, cancelText, formatReminderList, listOpenReminders, parseReminderRef, REMINDERS_TEXT } from "../schedule/overview";
import { getScheduleStore } from "../schedule/store";
import type { RoutineHistory, RoutineList } from "../routines/types";
import { chunkForTelegram } from "../telegram";
import { threadConversation } from "../threads/detect";
import { formatClosedThreads, formatThreadList, THREADS_TEXT, threadPlace } from "../threads/format";
import {
  CLOSED_REASON,
  closeThreads as storeCloseThreads,
  findThread as storeFindThread,
  listOpenThreads,
  listRecentlyClosedThreads,
  sameConversation,
  threadsEnabled,
  type Thread,
} from "../threads/store";
import { MEMORY_COMMAND_TEXT, MEMORY_COMMANDS } from "./memory";
import { TASKS_COMMAND } from "./tasks";
import { CALL_COMMAND } from "./phone";
import { CORE_COMMAND } from "./core";
import { VOICE_AGENT_COMMAND, VOICE_AGENTS_LIST_COMMAND } from "./voice-agents";
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
/motor - Motor dieses Gespraechs zeigen · /motor codex · /motor opencode · /motor claude · /motor standard
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
/remember <fakt> · /forget <text> - Fakt merken bzw. vergessen
/kern - fester Kern: steht bei jedem Start einer Session im Prompt · /kern entwurf · /kern setzen <text> · /kern loeschen
/track <ziel> [| deadline: <frist>] · /done <text> · /cancel <text> - gespeichertes Ziel anlegen, erledigen, streichen
/faeden - offene Faeden: meine Fragen, auf die noch eine Antwort fehlt
/faeden zu <nr> - Faden schliessen · /faeden alle - auch die geschlossenen der letzten 7 Tage
/erinnerungen - offene Erinnerungen aller Gespraeche · /erinnerungen absagen <kennung>
/recall <frage> - alte Gespraeche durchsuchen (auch /search, /find)
/learn <URL oder Text> - Quelle in die Knowledge Base destillieren

**Sonstiges:**
/jobs - Hintergrund-Jobs: laufende und zuletzt beendete
/voice <text> - Antwort als Sprachnachricht · /anruf [anlass] - ich rufe dich an
/sprachagent - Sprachagenten aus Rezepten: liste (auch /sprachagenten) · testen <kennung> · loeschen <kennung> · link <kennung>
/credit - Verbrauch (Claude-Abo, Motoren) · /plan - Limit und Reset-Tag`;

const markdown = { format: "markdown" } as const;

async function runGoals(ctx: CommandContext): Promise<void> {
  let goals: string;
  try {
    goals = await ctx.services.listGoals();
  } catch (e) {
    console.log(`[gedaechtnis] /goals fehlgeschlagen (${e instanceof Error ? e.name : typeof e}, ${ctx.channel})`);
    return ctx.reply(MEMORY_COMMAND_TEXT.goalsUnreadable);
  }
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
  // Vor der Auswahl: ein /new ab hier (auch während der Startmeldung) verwirft
  // die Session der Routine (Issue #189)
  const epoch = ctx.services.sessionEpoch?.(ctx.sessionKey);
  const session = (await ctx.services.sessionsForKey(ctx.sessionKey))
    .filter(s => s.engineSessionId)
    .sort((a, b) => b.lastActivity - a.lastActivity)[0];
  if (!session) {
    await ctx.reply("Keine aktive Session in diesem Topic. Erst den Ablauf einmal im Chat durchspielen, dann /routine.");
    return;
  }
  await ctx.notice("Ich friere den Ablauf dieser Session als Routine ein. Das kann ein paar Minuten dauern...");
  const stop = ctx.working();
  try {
    const result = await ctx.services.createRoutine(session, hint, epoch);
    const reply =
      result.isError || !result.text ? "Die Routine-Destillation ist fehlgeschlagen. Details: logs/telegram-relay.error.log" : result.text;
    await ctx.reply(reply, markdown);
  } finally {
    stop();
  }
}

async function runCredit(ctx: CommandContext): Promise<void> {
  await ctx.reply(await ctx.services.formatCredit(), markdown);
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

/** Routinen-Zentrale (Issue #284): Dienste dieses Rechners, nur lesend */
async function defaultRoutinesList(): Promise<RoutineList> {
  const [{ PROJECT_ROOT }, { defaultRoutinesDeps, listRoutines }] = await Promise.all([import("../env"), import("../routines/catalog")]);
  return listRoutines(defaultRoutinesDeps(PROJECT_ROOT));
}

/** Verlauf einer Routine (Issue #285) nach Name oder Label */
async function defaultRoutineHistory(name: string): Promise<RoutineHistory | null> {
  const [{ PROJECT_ROOT }, { defaultRoutinesDeps, routineHistory }] = await Promise.all([import("../env"), import("../routines/catalog")]);
  return routineHistory(defaultRoutinesDeps(PROJECT_ROOT), name);
}

async function runRoutines(ctx: CommandContext): Promise<void> {
  const name = ctx.args.trim();
  let text: string;
  let history: RoutineHistory | null = null;
  if (name) {
    history = ctx.services.routineHistory ? await ctx.services.routineHistory(name) : await defaultRoutineHistory(name);
    text = formatRoutineHistory(history, name);
  } else {
    text = formatRoutineList(ctx.services.routinesList ? await ctx.services.routinesList() : await defaultRoutinesList());
  }
  const parts = ctx.channel === "telegram" ? chunkForTelegram(text) : [text];
  for (const part of parts) await ctx.reply(part);
  // Knöpfe (Issue #288): eigene Nachricht unter dem Verlauf; Bot-Dienst und Dauerdienste bekommen keine
  if (history && ctx.services.routineMenu) {
    try {
      await ctx.services.routineMenu({ chatId: ctx.chatId, ...(ctx.topicId !== undefined ? { topicId: ctx.topicId } : {}) }, history.routine.id);
    } catch {
      console.log(routineLogLine(history.routine.id, "menu", ctx.channel));
    }
  }
}

/** Topic-Namen, wenn ein Faden in einem Topic liegt; sonst und bei Fehlern leer („Topic <id>") */
async function threadTopicNames(ctx: CommandContext, threads: Thread[]): Promise<Record<string, string>> {
  if (!threads.some(t => t.conversation.type === "telegram" && t.conversation.topicId !== undefined)) return {};
  try {
    return await ctx.services.topicNames();
  } catch {
    return {};
  }
}

async function replyThreadsText(ctx: CommandContext, text: string): Promise<void> {
  // Telegram nimmt höchstens 4096 Zeichen je Nachricht; geteilt wird an Zeilengrenzen
  const parts = ctx.channel === "telegram" ? chunkForTelegram(text) : [text];
  for (const part of parts) await ctx.reply(part);
}

/**
 * /faeden zu <nr> (Issue #291): schließt einen offenen Faden dieses
 * Gesprächs von Hand. Wie beim stillen Auflösen nur im eigenen Gespräch;
 * liegt die Nummer in einem anderen, sagt der Befehl wo.
 */
async function closeThreadByHand(ctx: CommandContext, nr: number): Promise<void> {
  const conversation = threadConversation(ctx.chatId, ctx.topicId);
  if (!conversation) {
    await ctx.reply(THREADS_TEXT.noConversation);
    return;
  }
  const close = ctx.services.closeThreads ?? storeCloseThreads;
  const outcome = await close(conversation, [nr], CLOSED_REASON.manual);
  const done = outcome.closed[0];
  if (done) {
    await ctx.reply(THREADS_TEXT.closed(done.nr, done.topic));
    return;
  }
  const found = await (ctx.services.findThread ?? storeFindThread)(nr).catch(() => null);
  if (found && found.state === "open" && !sameConversation(found.conversation, conversation)) {
    await ctx.reply(THREADS_TEXT.elsewhere(nr, threadPlace(found, await threadTopicNames(ctx, [found]))));
    return;
  }
  await ctx.reply(THREADS_TEXT.unknown(nr));
}

/** Offene Fäden (Issue #290): alle Gespräche, neueste oben; zu <nr> und alle seit Issue #291 */
async function runThreads(ctx: CommandContext): Promise<void> {
  const args = ctx.args.trim().toLowerCase();
  const close = /^(?:zu|erledigt)\s+#?(\d{1,9})$/.exec(args);
  if (args !== "" && args !== "alle" && !close) {
    await ctx.reply(THREADS_TEXT.usage);
    return;
  }
  const enabled = threadsEnabled();
  if (!enabled) {
    await ctx.reply(THREADS_TEXT.off);
    return;
  }
  if (close) {
    await closeThreadByHand(ctx, Number(close[1]));
    return;
  }
  const threads = await (ctx.services.openThreads ? ctx.services.openThreads() : listOpenThreads());
  const closed = args === "alle" ? await (ctx.services.recentlyClosedThreads ? ctx.services.recentlyClosedThreads() : listRecentlyClosedThreads()) : [];
  const topicNames = await threadTopicNames(ctx, [...threads, ...closed]);
  let text = formatThreadList(threads, { enabled, topicNames });
  if (args === "alle") text += `\n\n${formatClosedThreads(closed, { topicNames })}`;
  await replyThreadsText(ctx, text);
}

/**
 * /erinnerungen (Issue #323): offene Erinnerungen aller Gespräche, absagen
 * mit der Kennung aus der Liste (src/lib/schedule/overview.ts)
 */
async function runReminders(ctx: CommandContext): Promise<void> {
  const args = ctx.args.trim();
  const cancel = /^(?:absagen|cancel)\s+(\S+)$/i.exec(args);
  if (args !== "" && !cancel) {
    await ctx.reply(REMINDERS_TEXT.usage);
    return;
  }
  const store = ctx.services.reminders ? ctx.services.reminders() : getScheduleStore();
  if (cancel) {
    const ref = parseReminderRef(cancel[1]);
    if (!ref) {
      await ctx.reply(REMINDERS_TEXT.unknown(cancel[1]));
      return;
    }
    const outcome = await cancelReminder(store, ref);
    console.log(`[erinnerung] /erinnerungen absagen ${ref}: ${outcome.status} (${ctx.channel})`);
    await ctx.reply(cancelText(outcome, ref));
    return;
  }
  const tasks = await listOpenReminders(store);
  if (!tasks) {
    console.log(`[erinnerung] /erinnerungen: Ablage nicht lesbar (${ctx.channel})`);
    await ctx.reply(REMINDERS_TEXT.unreadable);
    return;
  }
  let topicNames: Record<string, string> = {};
  if (tasks.some(t => t.topicId !== null && t.topicId !== 1)) {
    try {
      topicNames = await ctx.services.topicNames();
    } catch {
      topicNames = {};
    }
  }
  const text = formatReminderList(tasks, { now: Date.now(), topicNames });
  await replyThreadsText(ctx, text);
}

async function runHelp(ctx: CommandContext): Promise<void> {
  await ctx.reply(HELP_TEXT, markdown);
}

async function runStop(ctx: CommandContext): Promise<void> {
  const { sessionKey, services } = ctx;
  // Vor dem Pausieren festhalten: getGoal liefert das gespeicherte Objekt,
  // pauseGoal ändert es (sonst fehlte "Ziel pausiert" in der Antwort, Issue #563)
  const goalWasActive = (await services.getGoal(sessionKey))?.status === "active";
  if (goalWasActive) {
    await services.pauseGoal(sessionKey, "Vom User gestoppt (/stop)");
  }
  // Board-Sitzung (Issue #75): der laufende Beitrag wird fertig, danach Schluss;
  // erst ein zweites /stop bricht hart ab
  if (services.requestBoardStop?.(sessionKey) === "requested") {
    await ctx.reply(
      goalWasActive ? `${BOARD_TEXT.stopRequested} Ziel pausiert (/goal weiter setzt fort).` : BOARD_TEXT.stopRequested
    );
    return;
  }
  const killed = services.abortEngineCalls(sessionKey);
  const parts: string[] = [];
  if (killed > 0) parts.push(`${killed} laufende Verarbeitung${killed > 1 ? "en" : ""} abgebrochen`);
  if (goalWasActive) parts.push("Ziel pausiert (/goal weiter setzt fort)");
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

/** /goal pause und /goal stop (samt Aliasen): ohne Bereich wie in Telegram (src/channels/telegram/update-scope.ts) */
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
    if (result.status !== "ok") ctx.services.abortEngineCalls(sessionKey);
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

// ---------------------------------------------------------------------------
// /motor (Issue #125, Entscheidung 0018): Motor pro Gespräch
// ---------------------------------------------------------------------------

export const MOTOR_TEXT = {
  unavailable: "Die Motor-Wahl ist hier nicht verfügbar.",
  usage: "Wechseln: /motor claude · /motor codex · /motor opencode · /motor api · /motor standard",
  busy: "In diesem Gespräch läuft gerade eine Antwort. Erst /stop, dann /motor.",
  fileInvalid: "config/settings.json ist ungültig, der Motor wurde nicht geändert. Bitte die Datei reparieren oder löschen.",
  notSaved: "Der Motor konnte nicht gespeichert werden.",
  newSession: "Das beginnt eine neue Session, das Gedächtnis bleibt.",
  /** Claude Code nicht bereit (Issue #567): wer dann antwortet, entscheidet die Kette der Ersatzmodelle */
  claudeNotReady: `Bis das behoben ist, antworten höchstens Ersatzmodelle, falls eingerichtet. Mehr zeigt ${BRAND.cli} pruefen.`,
} as const;

const MOTOR_SOURCE_TEXT = {
  topic: "mit /motor für dieses Gespräch gesetzt",
  settings: "Standard aus den Einstellungen",
  env: "Standard aus TYBO_ENGINE in .env",
  code: "eingebauter Standard",
} as const;

const MOTOR_STANDARD_WORDS = ["standard", "default"];

function motorLabel(list: { engine: string; label: string }[], engine: string): string {
  return list.find(e => e.engine === engine)?.label ?? engine;
}

async function runMotor(ctx: CommandContext): Promise<void> {
  const engines = ctx.services.engines;
  if (!engines) return ctx.reply(MOTOR_TEXT.unavailable);
  const arg = ctx.args.trim().toLowerCase();
  const list = await engines.available();
  const label = (engine: string) => motorLabel(list, engine);
  const notReadyNote = (engine: string) => {
    const status = list.find(e => e.engine === engine);
    if (!status || status.ready) return "";
    const why = status.message ? ` (${status.message})` : "";
    // Claude Code ist selbst der Rückfallmotor (Issue #567): dann gibt es kein „bis dahin antwortet Claude Code“
    if (engine === "claude") return `\n${status.label} ist gerade nicht bereit${why}. ${MOTOR_TEXT.claudeNotReady}`;
    return `\n${status.label} ist gerade nicht bereit${why}, bis dahin antwortet ${label("claude")}.`;
  };

  if (!arg) {
    const current = engines.configured(ctx.sessionKey);
    const standard = engines.standard();
    const available = list.map(e => (e.ready ? `${e.label} ✓` : `${e.label} (${e.message ?? "nicht bereit"})`)).join(", ");
    await ctx.reply(
      [
        `Motor dieses Gesprächs: ${label(current.engine)} (${MOTOR_SOURCE_TEXT[current.source]})`,
        `Standard: ${label(standard.engine)} (${MOTOR_SOURCE_TEXT[standard.source]})`,
        `Verfügbar: ${available}`,
        MOTOR_TEXT.usage,
      ].join("\n") + notReadyNote(current.engine)
    );
    return;
  }

  const toStandard = MOTOR_STANDARD_WORDS.includes(arg);
  if (!toStandard && !list.some(e => e.engine === arg)) {
    const names = [...list.map(e => e.engine), "standard"].join(", ");
    await ctx.reply(`Unbekannter Motor „${ctx.args.trim().slice(0, 40)}". Möglich: ${names}.`);
    return;
  }

  const before = engines.configured(ctx.sessionKey);
  const after = toStandard ? engines.standard().engine : arg;
  const changes = before.engine !== after;
  let written = false;
  let writeError: unknown;
  const write = async () => {
    written = true;
    try {
      if (toStandard) {
        if (before.source === "topic") await engines.setTopic(ctx.sessionKey, null);
      } else {
        await engines.setTopic(ctx.sessionKey, arg);
      }
    } catch (e) {
      writeError = e ?? new Error("Motor nicht gespeichert");
    }
  };
  // Bei einem Wechsel: Session beenden (alle Agenten des Gesprächs, laufende
  // Turns speichern danach nichts mehr) und die Einstellung schreiben, beides
  // unter der Sperre des Gesprächs. Läuft eine Antwort, ändert sich nichts;
  // ein neuer Turn kann nicht zwischen Reset und Schreiben mit dem alten Motor starten.
  let sessionMode = false;
  if (changes) {
    const reset = await ctx.resetSession({ whileBlocked: write });
    if (reset.status === "busy") return ctx.reply(MOTOR_TEXT.busy);
    sessionMode = reset.status === "done" && reset.sessionMode;
  }
  // Ohne Wechsel oder ohne ermittelbare Session (unavailable): direkt schreiben
  if (!written) await write();
  if (writeError !== undefined) {
    const e = writeError;
    await ctx.reply(e instanceof Error && e.name === "SettingsFileInvalidError" ? MOTOR_TEXT.fileInvalid : MOTOR_TEXT.notSaved);
    return;
  }

  const lines: string[] = [];
  if (toStandard) {
    lines.push(
      before.source === "topic"
        ? `Ausnahme entfernt: dieses Gespräch nimmt wieder den Standard, ${label(after)}.`
        : `Dieses Gespräch nimmt schon den Standard, ${label(after)}.`
    );
  } else {
    lines.push(changes ? `Dieses Gespräch läuft jetzt mit ${label(after)}.` : `Dieses Gespräch läuft schon mit ${label(after)}.`);
  }
  if (changes && sessionMode) lines.push(MOTOR_TEXT.newSession);
  await ctx.reply(lines.join(" ") + notReadyNote(after));
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
  // Telegram: createVoiceReply in src/channels/telegram/commands.ts
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
    name: "motor",
    aliases: ["engine"],
    description: "Motor dieses Gesprächs zeigen oder wechseln (Claude Code, Codex, OpenCode, Anthropic API)",
    args: "optional",
    argsHint: "[claude|codex|opencode|api|standard]",
    channels: ALL_CHANNELS,
    run: runMotor,
  },
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
  // Gedächtnis (Issue #333): /remember, /forget, /memory, /track, /done, /cancel, /recall
  ...MEMORY_COMMANDS,
  // Fester Kern im Prompt (Issue #522)
  CORE_COMMAND,
  {
    name: "learn",
    aliases: [],
    description: "Quelle in die Knowledge Base destillieren",
    args: "optional",
    argsHint: "<URL oder Text>",
    channels: ALL_CHANNELS,
    run: runLearn,
  },
  {
    name: "credit",
    aliases: [],
    bareWords: ["credit"],
    description: "Verbrauch: Claude-Abo und Motoren im laufenden Zyklus",
    args: "none",
    channels: ALL_CHANNELS,
    run: runCredit,
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
  {
    name: "routinen",
    aliases: [],
    description: "Zeitgesteuerte Dienste: Zeitplan, Status, letzter und nächster Lauf",
    args: "optional",
    argsHint: "[name]",
    channels: ALL_CHANNELS,
    run: runRoutines,
  },
  { name: "jobs", aliases: [], description: "Hintergrund-Jobs: laufende und zuletzt beendete", args: "none", channels: ALL_CHANNELS, run: runJobs },
  // Aufträge des Gesprächs (Issue #337), früher ein Sonderfall nur in Telegram
  TASKS_COMMAND,
  {
    name: "faeden",
    aliases: ["threads"],
    description: "Offene Fäden: meine Fragen, auf die noch eine Antwort fehlt",
    args: "optional",
    argsHint: "[alle | zu <nr>]",
    channels: ALL_CHANNELS,
    run: runThreads,
  },
  {
    name: "erinnerungen",
    aliases: ["reminders"],
    description: "Offene Erinnerungen aller Gespräche, absagen mit der Kennung",
    args: "optional",
    argsHint: "[absagen <kennung>]",
    channels: ALL_CHANNELS,
    run: runReminders,
  },
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
  // Anruf übers Telefonnetz (Issue #367)
  CALL_COMMAND,
  // Sprachagenten aus Rezepten (Issue #492); /sprachagenten zeigt ohne Argument die Liste
  VOICE_AGENT_COMMAND,
  VOICE_AGENTS_LIST_COMMAND,
];

export const commandRegistry = createCommandRegistry(BUILTIN_COMMANDS);
