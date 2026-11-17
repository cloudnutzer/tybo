/**
 * Verlauf eines Rezepts (Stufe thema, Issue #491): data/voice-agents/<kennung>/
 * verlauf.jsonl, getrennt vom Verlauf des Nutzers. Nur was gesprochen wurde,
 * ohne Tags. Keinem symbolischen Link wird gefolgt.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { spokenText } from "../voice-brain/tags";
import { agentDataDir, agentsDataRoot, ensureRealDirs, type VoiceAgentPaths } from "./base";

export interface TranscriptTurn {
  conversationId?: string;
  userText: string;
  assistantRaw: string;
}

export function transcriptPath(kennung: string, paths: VoiceAgentPaths = {}): string {
  return join(agentDataDir(kennung, paths), "verlauf.jsonl");
}

export async function appendTranscript(kennung: string, turn: TranscriptTurn, options: VoiceAgentPaths & { now?: () => number } = {}): Promise<void> {
  await ensureRealDirs([agentsDataRoot(options), agentDataDir(kennung, options)]);
  const zeit = new Date((options.now ?? Date.now)()).toISOString();
  const gespraech = turn.conversationId ?? null;
  const spoken = spokenText(turn.assistantRaw);
  const lines = [{ zeit, gespraech, rolle: "nutzer", text: turn.userText }, ...(spoken ? [{ zeit, gespraech, rolle: "agent", text: spoken }] : [])];
  const handle = await open(transcriptPath(kennung, options), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    // Ein Schreibvorgang je Turn: Zwei gleichzeitige Turns mischen ihre Zeilen nicht
    await handle.appendFile(lines.map((line) => JSON.stringify(line) + "\n").join(""));
  } finally {
    await handle.close();
  }
}
