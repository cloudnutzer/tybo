/** Öffentliches Austauschformat für eine rein lesende Pipeline-Übersicht. */

export const PIPELINE_STATUS_BYTES = 1024 * 1024;
export const PIPELINE_LIMIT = 100;
export const PIPELINE_STALE_MS = 5 * 60_000;
export const PIPELINE_QUESTION_MS = 14 * 24 * 3_600_000;
export const PIPELINE_STATES = ["running", "waiting", "halted", "resting"] as const;
export const PIPELINE_STEPS = ["plan", "build", "fix", "checks", "ci", "review", "ux", "review-lock", "network", "prerequisite"] as const;
export const PIPELINE_EVENTS = [...PIPELINE_STEPS, "issue", "worker-done", "review-done", "resumed", "halted", "waiting", "merged"] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];
export type PipelineStep = { kind: (typeof PIPELINE_STEPS)[number]; round?: number };
export type PipelineEvent = { at: string; type: (typeof PIPELINE_EVENTS)[number]; round?: number };
export interface PipelineStatus {
  id: string;
  name: string;
  description: string;
  state: PipelineState;
  since: string | null;
  lastActivityAt: string | null;
  restingState: "waiting" | "halted" | null;
  hanging: boolean;
  milestone: string | null;
  ghRepo: string | null;
  issue: { number: number; title: string } | null;
  step: PipelineStep | null;
  reason: string | null;
  events: PipelineEvent[];
  question: { at: string; text: string } | null;
  conversation: string | null;
}
export interface PipelineStatusFile {
  version: 1;
  generatedAt: string;
  /** Nur auf Systemen mit bekanntem Ladezustand, ohne Dienstnamen. */
  supervisors?: { check: boolean; watch: boolean; follow: boolean };
  pipelines: PipelineStatus[];
}

export type PipelineText = (value: string, max: number) => string;


function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function pipelineTime(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 30 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
export function pipelineConversation(value: unknown): string | null {
  return typeof value === "string" && (value === "dm" || /^topic-[1-9]\d{0,14}$/.test(value)) ? value : null;
}
function roundOf(value: unknown): { round?: number } {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 1000 ? { round: value } : {};
}

/** Positive Feldauswahl an beiden Grenzen. Fremde Objekte werden nie durchgereicht. */
export function sanitizePipelineStatus(input: unknown, text: PipelineText): PipelineStatusFile | null {
  const raw = object(input);
  const generatedAt = pipelineTime(raw?.generatedAt);
  if (!raw || raw.version !== 1 || !generatedAt || !Array.isArray(raw.pipelines) || raw.pipelines.length > PIPELINE_LIMIT) return null;
  const field = (v: unknown, max: number) => typeof v === "string" ? text(v, max) : "";
  const pipelines: PipelineStatus[] = [];
  const ids = new Set<string>();
  for (const value of raw.pipelines) {
    const p = object(value);
    if (!p || typeof p.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || ids.has(p.id)
      || !PIPELINE_STATES.includes(p.state as PipelineState)) continue;
    ids.add(p.id);
    const issue = object(p.issue), step = object(p.step), question = object(p.question);
    const questionAt = pipelineTime(question?.at);
    const events: PipelineEvent[] = [];
    for (const value of Array.isArray(p.events) ? p.events.slice(-100) : []) {
      const e = object(value), at = pipelineTime(e?.at);
      if (e && at && PIPELINE_EVENTS.includes(e.type as PipelineEvent["type"])) events.push({ at, type: e.type as PipelineEvent["type"], ...roundOf(e.round) });
    }
    pipelines.push({
      id: p.id, name: field(p.name, 120) || "Pipeline", description: field(p.description, 300),
      state: p.state as PipelineState, since: pipelineTime(p.since), lastActivityAt: pipelineTime(p.lastActivityAt),
      restingState: p.state === "resting" && (p.restingState === "waiting" || p.restingState === "halted") ? p.restingState : null,
      hanging: p.state === "running" && p.hanging === true,
      milestone: field(p.milestone, 200) || null,
      ghRepo: typeof p.ghRepo === "string" && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/.test(p.ghRepo) ? p.ghRepo : null,
      issue: issue && typeof issue.number === "number" && Number.isSafeInteger(issue.number) && issue.number > 0
        ? { number: issue.number, title: field(issue.title, 300) } : null,
      step: step && PIPELINE_STEPS.includes(step.kind as PipelineStep["kind"]) ? { kind: step.kind as PipelineStep["kind"], ...roundOf(step.round) } : null,
      reason: field(p.reason, 1000) || null,
      events: events.sort((a, b) => a.at.localeCompare(b.at)).slice(-5),
      question: questionAt && question && typeof question.text === "string" ? { at: questionAt, text: field(question.text, 4000) } : null,
      conversation: pipelineConversation(p.conversation),
    });
  }
  const s = object(raw.supervisors);
  return {
    version: 1, generatedAt,
    ...(s && typeof s.check === "boolean" && typeof s.watch === "boolean" && typeof s.follow === "boolean"
      ? { supervisors: { check: s.check, watch: s.watch, follow: s.follow } } : {}),
    pipelines,
  };
}
