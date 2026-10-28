/**
 * Wartehinweis (Issue #188): wartet ein Turn länger als ein paar Sekunden
 * auf einen freien Platz (MAX_AGENT_PROCESSES, src/lib/execution-context.ts),
 * sagt tybo das im Gespräch. Nur Anzeige: der Hinweis geht nie in den
 * Nachrichtenspeicher und damit nie ins Modellgedächtnis.
 */
import type { QueueWaitInfo } from "./execution-context";

/** Anzeigename eines Session-Schlüssels (Format aus sessionKeyFor) */
export function queueLabel(key: string, topicNames: Record<string, string> = {}): string {
  if (key.startsWith("dm:")) return "Direktchat";
  if (key.startsWith("web:")) return "Web-Gespräch";
  if (key.startsWith("group:")) return "General";
  const topic = /^topic:-?\d+:(\d+)$/.exec(key);
  if (topic) {
    const name = topicNames[topic[1]]?.trim();
    return name ? `„${name}“` : `Topic ${topic[1]}`;
  }
  return "Hintergrundaufgabe";
}

export function queueNoticeText(info: QueueWaitInfo, topicNames: Record<string, string> = {}): string {
  const labels = [...new Set(info.keys.map(k => queueLabel(k, topicNames)))];
  const n = info.running;
  const running = n === 1 ? "läuft 1 anderer Auftrag" : `laufen ${n} andere Aufträge`;
  return `⏳ Warte auf einen freien Platz, gerade ${running}${labels.length ? ` (${labels.join(", ")})` : ""}. Sobald einer fertig ist, geht es los.`;
}

/**
 * Hinweis-Funktion für runCancelable({ onQueueWait }). send zeigt den Text
 * im Gespräch (Telegram: ctx.reply, Browser: notice des Turns); topicNames ist
 * fail-open, ohne Namen steht „Topic <id>". Hat der Turn inzwischen einen
 * Platz bekommen oder wurde abgebrochen (stillWaiting), geht nichts raus.
 */
export function createQueueNotifier(
  send: (text: string) => unknown,
  topicNames?: () => Promise<Record<string, string>>
): (info: QueueWaitInfo, stillWaiting?: () => boolean) => Promise<void> {
  return async (info, stillWaiting) => {
    let names: Record<string, string> = {};
    try {
      names = (await topicNames?.()) ?? {};
    } catch {
      // Namen sind nur Beiwerk
    }
    // Während der Namenssuche gestartet oder abgebrochen: kein verspäteter Hinweis
    if (stillWaiting && !stillWaiting()) return;
    try {
      await send(queueNoticeText(info, names));
    } catch {
      // Ein nicht zugestellter Hinweis darf den Turn nicht stören
    }
  };
}
