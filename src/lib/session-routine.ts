import { runExecution } from "./execution-context";
/**
 * /routine — Session in eine wiederholbare Routine einfrieren ("Teach a Task").
 *
 * Resumes the current topic's session once, über den Motor der Session
 * (Issue #122, mit dem Modell der Session), and asks it to
 * crystallize the workflow just performed into a durable artifact:
 * either a Claude Code skill (.claude/skills/<name>/SKILL.md) for flows
 * that still need judgment, or a deterministic script (src/<name>.ts,
 * direct REST calls, no Claude subprocess) following the existing watcher
 * pattern — optionally with a launchd schedule when the user named one.
 *
 * The subprocess runs with the project's tool permissions and writes the
 * files itself; its report goes back to the user. Unlike distillation this
 * turn continues the session: the caller records the returned session ID.
 */

import { log as sbLog } from "./convex";
import { getEngine } from "./engines";
import { recordSessionTurn, getSessionsForKey, sessionEpoch, normalizeSession, type BotSession, type LegacyBotSession } from "./session-manager";

const ROUTINE_TIMEOUT_MS = 900_000; // 15 min — Claude writes real files here

export function buildRoutinePrompt(hint: string): string {
  return `Der User moechte den in dieser Session erarbeiteten Ablauf als wiederholbare Routine einfrieren (Kommando /routine).
${hint ? `\nHinweis des Users, welcher Ablauf gemeint ist und ggf. Zeitplan: "${hint}"\n` : ""}
Identifiziere den Workflow, der in dieser Session vorgemacht oder erarbeitet wurde, und friere ihn ein:

1. Waehle die passende Form:
   - Claude Code Skill (.claude/skills/<kebab-name>/SKILL.md) fuer Ablaeufe, die weiterhin Urteilsvermoegen brauchen (Recherche, Texte, Analysen). Frontmatter mit name und description; die description so formulieren, dass der Skill bei passenden Anfragen automatisch triggert. Danach die Schritte als praezise Anleitung mit allen in der Session gelernten Details: konkrete URLs, Datenquellen, Formate, Schwellwerte und vor allem die Korrekturen, die der User unterwegs gegeben hat.
   - Deterministisches Script (src/<kebab-name>.ts, Bun/TypeScript) fuer mechanische Ablaeufe (Checks, Abrufe, Reports): Datenabrufe per direkten REST-Calls statt Claude-Subprozess. Telegram-Meldungen nie per direktem REST-Call an die Bot-API, sondern ueber \`bun run notify --source watcher --text "<Meldung>"\` (Datei: \`--file <pfad> [--caption <text>]\`, Topic: \`--topic <id>\`), im Script z.B. per Bun.spawn im Projektordner; so landet die Meldung auch in der WebUI. Exit-Code 0 heisst gesendet. Dateinamen nach dem Muster src/preis-watch.ts (nur ein Namensbeispiel, keine vorhandene Datei).

2. Zeitplan nur, wenn der User einen genannt hat (im Hinweis oben oder in der Session): dann eine launchd-Plist mit Label ai.tybo.<name> nach dem Muster der bestehenden Watcher erzeugen und laden; PATH-Regel aus CLAUDE.md beachten. Ohne genannten Zeitplan kein launchd — stattdessen im Bericht erklaeren, wie man das Script manuell startet ("bun run src/<name>.ts") und dass ein Zeitplan per Nachricht nachruestbar ist.

3. Schreibe die Dateien jetzt wirklich (Write/Edit/Bash sind erlaubt). Erfinde nichts, was in der Session nicht vorkam. Fehlt ein Detail (URL, Schwellwert, Empfaenger), triff die konservative Wahl und markiere sie im Bericht ausdruecklich als Annahme.

Antworte zum Schluss mit einem kurzen Bericht fuer Telegram: was erstellt wurde (Dateipfade), wie man es ausloest, welche Annahmen du getroffen hast. Keine Codebloecke im Bericht. Falls diese Session keinen einfrierbaren Ablauf enthaelt, erstelle nichts und sage klar, was dir als Ablauf fehlt.`;
}

/**
 * Resume the session with the routine prompt. Returns Claude's report plus
 * the new session ID so the caller can keep the topic session alive.
 */
async function createRoutineUnlocked(
  session: BotSession,
  hint: string,
  d: RoutineDeps
): Promise<{ text: string; sessionId?: string; isError: boolean }> {
  try {
    // Eine fremde Session-ID geht nie an Claude: ohne verfügbaren Motor wirft getEngine
    const engine = d.getEngine(session.engine);
    const run = await engine.run({
      prompt: buildRoutinePrompt(hint),
      streaming: false,
      ...(session.engineSessionId ? { resumeSessionId: session.engineSessionId } : {}),
      model: session.model,
      timeoutMs: ROUTINE_TIMEOUT_MS,
      cwd: process.cwd(),
    });
    const result = { text: run.text, sessionId: run.sessionId, isError: run.isError || !!run.aborted || !!run.timedOut };

    if (!result.isError && result.text) {
      await d.log("info", "bot", "Session frozen into routine", {
        sessionKey: session.key,
        hint: hint || undefined,
      });
    }
    return result;
  } catch (err) {
    console.error(`[Routine] ${session.key} failed:`, err);
    return { text: "", isError: true };
  }
}

/** Austauschbar für Tests (Issue #189), sonst die echten Funktionen */
export interface RoutineDeps {
  getEngine: typeof getEngine;
  log: typeof sbLog;
}

export async function createRoutineFromSession(
  stored: BotSession | LegacyBotSession,
  hint: string,
  deps: Partial<RoutineDeps> = {},
  // Epoche von der Session-Auswahl (/routine); fehlt sie, gilt die jetzige:
  // ein /new ab hier verwirft die Session der Routine
  epoch = sessionEpoch(stored.key.slice(0, -(stored.agentName.length + 1)))
) {
  // Snapshot aus pending-reviews.json kann noch das alte Format haben
  const session = normalizeSession(stored);
  const d: RoutineDeps = { getEngine, log: sbLog, ...deps };
  return runExecution(session.key.slice(0, -(session.agentName.length + 1)), session.agentName,
    async () => {
      const key = session.key.slice(0, -(session.agentName.length + 1));
      const current = (await getSessionsForKey(key)).find(s => s.agentName === session.agentName);
      const result = await createRoutineUnlocked(session, hint, d);
      const sameSession = !current || (current.engine === session.engine && current.engineSessionId === session.engineSessionId);
      if (result.sessionId && !result.isError && sameSession) await recordSessionTurn(key, session.agentName, session.model, session.engine, result.sessionId, session.memoryWatermark, epoch);
      return result;
    });
}
