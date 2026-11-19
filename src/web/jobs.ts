/** Jobs-API (Issue #626). Nur Port und Positivliste, keine Abhängigkeit auf src/lib. */
import type { ApiChoice } from "./choices";
import { renderMarkdown } from "./markdown";
import { scrubHome, validRequestKey } from "./routines";
import type { ApiResult } from "./settings";

export const JOB_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
export const JOB_ACTIONS = ["stop", "resume", "log", "report"] as const;
export type JobAction = "stop" | "resume";
export interface JobItem {
  id: string;
  title: string;
  phase: "starting" | "running" | "waiting" | "ended";
  status: string;
  duration: string;
  run: number;
  conversation: { id: string | null; name: string };
  question: { number: number; text: string; context: string; answers: string[]; conversationId: string | null; choice: ApiChoice | null } | null;
  actions: (typeof JOB_ACTIONS)[number][];
}
export type JobActionResult = "done" | "already" | "stale" | "blocked" | "unknown" | "foreign" | "unverified" | "survived" | "failed";
export interface JobsPort {
  home: string;
  list(title: (id: string) => Promise<string>): Promise<JobItem[]>;
  content(id: string, kind: "log" | "report", run?: number): Promise<{ text: string; run: number } | "stale" | null>;
  act(id: string, action: JobAction, request: string, expectedRun: number): Promise<JobActionResult>;
}
export const JOB_API_FIELDS = ["id", "title", "phase", "status", "duration", "run", "conversation", "question", "actions"] as const;
export const JOBS_API_TEXT = {
  notConfigured: "Jobs sind hier nicht eingerichtet.",
  failed: "Jobs konnten nicht gelesen werden. Bitte erneut versuchen.",
  invalid: "Ungültige Job-Anfrage.",
  confirm: "Stoppen nur mit Bestätigung.",
  unknown: "Der Job oder die Datei ist nicht mehr vorhanden.",
  stale: "Der Lauf hat sich geändert. Bitte die aktuelle Ansicht verwenden.",
  already: "Dieser Auftrag wurde bereits angenommen. Der aktuelle Stand wird geladen.",
  blocked: "Diese Aktion ist für den aktuellen Job nicht verfügbar.",
  actFailed: "Die Aktion konnte nicht abgeschlossen werden. Bitte den aktuellen Stand prüfen.",
  unverified: "Als gestoppt vermerkt. Der Prozess ließ sich nicht sicher zuordnen; kein Signal gesendet.",
  survived: "Als gestoppt vermerkt. Ein Prozess läuft noch; bitte den Betrieb prüfen.",
  foreign: "Als gestoppt vermerkt. Der Job-Prozess lief bereits nicht mehr.",
} as const;

function item(j: JobItem): JobItem {
  const q = j.question;
  const c = q?.choice;
  return {
    id: j.id, title: j.title, phase: j.phase, status: j.status, duration: j.duration, run: j.run,
    conversation: { id: j.conversation.id, name: j.conversation.name },
    question: q ? { number: q.number, text: q.text, context: q.context, answers: q.answers.map(String), conversationId: q.conversationId,
      choice: c ? { id: c.id, state: c.state, options: c.state === "open" ? c.options.map(o => ({ key: o.key, label: o.label })) : [] } : null } : null,
    actions: j.actions.filter(a => JOB_ACTIONS.includes(a)),
  };
}
const error = (status: number, message: string): ApiResult => ({ status, body: { error: message } });
export function createJobsApi(port: JobsPort, title: (id: string) => Promise<string> = async () => "") {
  return {
    async get(): Promise<ApiResult> {
      try {
        const jobs = (await port.list(title)).map(item);
        return { status: 200, body: scrubHome({ jobs, waiting: jobs.filter(j => j.phase === "waiting").length,
          running: jobs.filter(j => j.phase === "running" || j.phase === "starting").length }, port.home) };
      } catch { return error(500, JOBS_API_TEXT.failed); }
    },
    async content(id: string, kind: "log" | "report", run?: string | null): Promise<ApiResult> {
      if (!JOB_ID_PATTERN.test(id) || (run != null && (!/^[1-9]\d*$/.test(run) || !Number.isSafeInteger(Number(run))))) return error(400, JOBS_API_TEXT.invalid);
      try {
        const result = await port.content(id, kind, run == null ? undefined : Number(run));
        if (result === "stale") return error(409, JOBS_API_TEXT.stale);
        if (!result) return error(404, JOBS_API_TEXT.unknown);
        const text = scrubHome(result.text, port.home);
        return { status: 200, body: { run: result.run, text, ...(kind === "report" ? { html: renderMarkdown(text) } : {}) } };
      } catch { return error(500, JOBS_API_TEXT.failed); }
    },
    async act(id: string, action: string, body: string): Promise<ApiResult> {
      if (!JOB_ID_PATTERN.test(id) || (action !== "stop" && action !== "resume")) return error(400, JOBS_API_TEXT.invalid);
      let input;
      try { input = JSON.parse(body); } catch { return error(400, JOBS_API_TEXT.invalid); }
      if (action === "stop" && input?.confirm !== true) return error(400, JOBS_API_TEXT.confirm);
      if (!validRequestKey(input?.request) || !Number.isSafeInteger(input?.expectedRun) || input.expectedRun < 1) return error(400, JOBS_API_TEXT.invalid);
      try {
        const result = await port.act(id, action, input.request, input.expectedRun);
        const text = result === "done" ? (action === "stop" ? "Job gestoppt. Die Meldung wird zugestellt." : "Fortsetzen angenommen. Der aktuelle Stand wird geladen.")
          : result === "failed" ? JOBS_API_TEXT.actFailed : JOBS_API_TEXT[result];
        return { status: result === "unknown" ? 404 : ["stale", "blocked"].includes(result) ? 409 : result === "failed" ? 500 : 200,
          body: { status: result, text } };
      } catch { return error(500, JOBS_API_TEXT.actFailed); }
    },
  };
}
