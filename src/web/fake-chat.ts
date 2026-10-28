/**
 * Attrappe für den Agenten-Turn in web:dev (Issue #4): kein Claude-Aufruf.
 * Wartet, meldet zwei Fortschritte und einen Hinweis und antwortet mit
 * Beispiel-Markdown.
 * stop(id) bricht die Wartezeit ab.
 */

import type { RunTurnOptions, WebChat } from "./chat";

export const FAKE_REPLY = [
  "## Antwort der Attrappe",
  "",
  "Kein echter Claude-Aufruf, nur zum Ausprobieren von `web:dev`.",
  "",
  "- erster Punkt",
  "- zweiter Punkt",
  "",
  "```ts",
  'const gruss = "hallo";',
  "```",
  "",
  "[REMEMBER: test]",
].join("\n");

/** Modellname der Attrappe in der Zeile unter der Antwort; nie ein echtes Modell */
export const FAKE_MODEL = "attrappe";

export interface FakeChatOptions {
  /** Wartezeit vor dem ersten Fortschritt, Standard 3 Sekunden */
  delayMs?: number;
  /** Abstand zwischen Fortschritten und Antwort, Standard 0,5 Sekunden */
  stepMs?: number;
}

export function createFakeChat(options: FakeChatOptions = {}): WebChat {
  const delayMs = options.delayMs ?? 3000;
  const stepMs = options.stepMs ?? 500;
  const running = new Map<string, AbortController>();

  /** true, wenn die Wartezeit abgelaufen ist; false bei Abbruch */
  function wait(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      if (signal.aborted) return resolve(false);
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  return {
    async runTurn({ conversationId, agent, text, sink }: RunTurnOptions) {
      const startedAt = Date.now();
      const controller = new AbortController();
      running.set(conversationId, controller);
      const { signal } = controller;
      try {
        if (!(await wait(delayMs, signal))) return { text: "", aborted: true };
        await sink.progress({ kind: "tool", text: "Read" });
        if (!(await wait(stepMs, signal))) return { text: "", aborted: true };
        await sink.progress({ kind: "snippet", text: `Ich denke über "${text.slice(0, 40)}" nach` });
        await sink.notice("Hinweis der Attrappe: kein echter Claude-Aufruf.");
        if (!(await wait(stepMs, signal))) return { text: "", aborted: true };
        // Angaben unter der Antwort (Issue #22): echte Dauer, als Modell die Attrappe selbst
        return { text: FAKE_REPLY, info: { agent, model: FAKE_MODEL, durationMs: Date.now() - startedAt } };
      } finally {
        if (running.get(conversationId) === controller) running.delete(conversationId);
      }
    },
    stop(conversationId: string) {
      running.get(conversationId)?.abort();
    },
  };
}
