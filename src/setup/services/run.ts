/**
 * Befehle der Dienst-Einrichtung mit Frist ausführen (launchd, PM2,
 * systemd, crontab). Ein Befehl, der sich nicht starten lässt, zählt als
 * gescheitert und trägt `missing`, damit Aufrufer „nicht installiert“ von
 * „gescheitert“ trennen können.
 */

import { KILL_GRACE_MS } from "../context";

export interface ServiceRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** true: der Befehl ließ sich gar nicht starten (fehlt im PATH) */
  missing?: boolean;
}

/** Signal an die Prozessgruppe des Befehls, ist sie schon weg an den Prozess allein */
function signalGroup(child: ReturnType<typeof Bun.spawn>, sig: NodeJS.Signals) {
  try {
    process.kill(-child.pid, sig);
    return;
  } catch {
    // Gruppe schon weg
  }
  try {
    child.kill(sig);
  } catch {
    // schon beendet
  }
}

/**
 * Befehl im Ordner cwd ausführen. Nach der Frist SIGTERM an die eigene
 * Prozessgruppe, nach KILL_GRACE_MS SIGKILL (wie defaultRun in
 * src/setup/context.ts), damit auch ein Befehl, der SIGTERM ignoriert, samt
 * Kindprozessen endet. stdin optional (crontab -).
 */
export async function runWithTimeout(cmd: string[], cwd: string, timeoutMs: number, stdin?: string): Promise<ServiceRun> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(cmd, {
      cwd,
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch {
    return { ok: false, stdout: "", stderr: "Befehl nicht gefunden", missing: true };
  }
  let expired = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    expired = true;
    signalGroup(child, "SIGTERM");
    killTimer = setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS);
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    if (expired) return { ok: false, stdout: stdout.trim(), stderr: `Frist von ${timeoutMs} ms abgelaufen` };
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
    if (killTimer) {
      clearTimeout(killTimer);
      // Nichts aus der Gruppe bleibt nach Fristablauf übrig
      signalGroup(child, "SIGKILL");
    }
  }
}
