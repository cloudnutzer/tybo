/** Session-Datei am selben Ort suchen, den Claude für Arbeitsordner und HOME nutzt. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { claudeProjectDir } from "../engines/claude-notes";
import type { JobStatus } from "./store";

export async function jobSessionPresent(root: string, status: JobStatus, env: Record<string, string>): Promise<boolean> {
  if (!status.sessionId || !env.HOME) return false;
  if (!/^[0-9a-f-]{36}$/i.test(status.sessionId)) return false;
  const path = join(claudeProjectDir(status.workDir ?? root, env.HOME), `${status.sessionId}.jsonl`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return false;
  try {
    const info = await handle.stat();
    return info.isFile() && info.size > 0;
  } finally {
    await handle.close();
  }
}
