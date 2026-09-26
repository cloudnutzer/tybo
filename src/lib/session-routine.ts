import { runExecution } from "./execution-context";
/**
 * /routine — Session in eine wiederholbare Routine einfrieren ("Teach a Task").
 *
 * Resumes the current topic's Claude session once and asks Claude to
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

import { callClaude } from "./claude";
import { log as sbLog } from "./convex";
import { recordSessionTurn, getSessionsForKey, type BotSession } from "./session-manager";

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
  hint: string
): Promise<{ text: string; sessionId?: string; isError: boolean }> {
  try {
    const result = await callClaude({
      prompt: buildRoutinePrompt(hint),
      resumeSessionId: session.claudeSessionId,
      outputFormat: "json",
      model: session.model,
      timeoutMs: ROUTINE_TIMEOUT_MS,
      cwd: process.cwd(),
    });

    if (!result.isError && result.text) {
      await sbLog("info", "bot", "Session frozen into routine", {
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

export async function createRoutineFromSession(session: BotSession, hint: string) {
  return runExecution(session.key.slice(0, -(session.agentName.length + 1)), session.agentName,
    async () => {
      const key = session.key.slice(0, -(session.agentName.length + 1));
      const current = (await getSessionsForKey(key)).find(s => s.agentName === session.agentName);
      const result = await createRoutineUnlocked(session, hint);
      if (result.sessionId && !result.isError && (!current || current.claudeSessionId === session.claudeSessionId)) await recordSessionTurn(key, session.agentName, session.model, result.sessionId, session.memoryWatermark);
      return result;
    });
}
