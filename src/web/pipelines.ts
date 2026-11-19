/** Lesende API, mit erneuter Positivliste auch für fremde Statusquellen. */
import {
  PIPELINE_QUESTION_MS, PIPELINE_STALE_MS, sanitizePipelineStatus,
  type PipelineStatus, type PipelineText,
} from "./pipeline-status";
import type { ApiResult } from "./settings";

export interface PipelinesPort {
  read(): Promise<unknown | null>;
  /** Eine frische Maskierliste pro Abruf, nur für Freitext. */
  display(): PipelineText;
}
export type PipelineItem = Omit<PipelineStatus, "ghRepo" | "issue" | "conversation"> & {
  issue: { number: number; title: string; url: string | null } | null;
  conversation: { id: string; name: string } | null;
};
export const PIPELINES_EMPTY = { generatedAt: null, stale: false, pipelines: [], waiting: 0, running: 0 };
export const PIPELINES_FAILED = "Pipeline-Status konnte nicht gelesen werden. Bitte erneut versuchen.";
const ORDER = { waiting: 0, halted: 1, running: 2, resting: 3 };

export function createPipelinesApi(port?: PipelinesPort, title: (id: string) => Promise<string> = async () => "", now: () => number = Date.now) {
  return {
    async get(): Promise<ApiResult> {
      try {
        if (!port) return { status: 200, body: PIPELINES_EMPTY };
        const raw = await port.read();
        if (raw === null) return { status: 200, body: PIPELINES_EMPTY };
        const display = port.display();
        const snapshot = sanitizePipelineStatus(raw, display);
        if (!snapshot) throw new Error("Ungültiger Status");
        const time = now(), timestamp = Date.parse(snapshot.generatedAt);
        const stale = time - timestamp > PIPELINE_STALE_MS || timestamp > time + 60_000;
        const names = new Map<string, Promise<string>>();
        const conversationTitle = (id: string) => {
          if (!names.has(id)) names.set(id, title(id).catch(() => ""));
          return names.get(id)!;
        };
        const pipelines: PipelineItem[] = await Promise.all(snapshot.pipelines.map(async p => {
          const name = p.conversation ? await conversationTitle(p.conversation) : "";
          const questionAge = p.question ? time - Date.parse(p.question.at) : -1;
          // Absichtlich kein Spread des Eingabeobjekts: auch verschachtelt nur die Positivliste.
          return {
            id: p.id, name: p.name, description: p.description, state: p.state, since: p.since,
            lastActivityAt: p.lastActivityAt, restingState: p.restingState, hanging: p.hanging,
            milestone: p.milestone, step: p.step, reason: p.reason, events: p.events,
            issue: p.issue ? { number: p.issue.number, title: p.issue.title,
              url: p.ghRepo ? `https://github.com/${p.ghRepo}/issues/${p.issue.number}` : null } : null,
            question: questionAge >= 0 && questionAge <= PIPELINE_QUESTION_MS ? p.question : null,
            conversation: p.conversation && name ? { id: p.conversation, name: display(name, 120) } : null,
          };
        }));
        pipelines.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name, "de"));
        return { status: 200, body: {
          generatedAt: snapshot.generatedAt, stale, pipelines,
          waiting: pipelines.filter(p => p.state === "waiting").length,
          running: pipelines.filter(p => p.state === "running").length,
          ...(snapshot.supervisors ? { supervisors: snapshot.supervisors } : {}),
        } };
      } catch { return { status: 503, body: { error: PIPELINES_FAILED } }; }
    },
  };
}
