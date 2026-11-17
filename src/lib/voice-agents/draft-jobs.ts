/**
 * Echte Hintergrund-Jobs für Entwürfe von Sprachagenten (Issue #493): startJob
 * wie `bun run job start`, aber nie mit --full-access, in einem eigenen
 * Arbeitsordner mit --restricted (jobs/runner.ts), mit Recherche-Werkzeugen aus
 * brief.ts und einem Zeitlimit von zwei Stunden. Den Status liest der
 * Entwurfsdienst aus data/jobs/<id>/status.json; find sucht einen Job nach
 * seinem Titel, auch einen beendeten (Neustart zwischen Start und Eintrag).
 */
import { defaultEffort } from "../claude";
import { DEFAULT_CLAUDE_MODEL } from "../default-model";
import { createJobDeps } from "../jobs/default-deps";
import { startJob } from "../jobs/runner";
import { readAllStatuses, readStatus } from "../jobs/store";
import type { DraftJobs } from "./drafts";

/** Recherche und Rezept brauchen meist Minuten; zwei Stunden fangen auch eine gründliche Recherche ab */
export const DRAFT_JOB_MAX_HOURS = 2;

export function createDraftJobs(root: string, env: Record<string, string | undefined>): DraftJobs {
  return {
    async start(input) {
      const model = DEFAULT_CLAUDE_MODEL;
      const effort = defaultEffort(model);
      const result = await startJob(
        {
          title: input.title,
          brief: input.brief,
          target: input.target,
          maxHours: DRAFT_JOB_MAX_HOURS,
          model,
          ...(effort ? { effort } : {}),
          fullAccess: false,
          allowedTools: input.allowedTools,
          deniedTools: input.deniedTools,
          workDir: input.workDir,
        },
        createJobDeps({ root, env }),
      );
      if (result.ok) return { ok: true, id: result.id };
      return { ok: false, error: result.error, ...(result.duplicateOf ? { duplicateOf: result.duplicateOf } : {}) };
    },
    status: (id) => readStatus(root, id),
    async find(title) {
      const matches = (await readAllStatuses(root)).filter((s) => s.title === title).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return matches[0]?.id ?? null;
    },
  };
}
