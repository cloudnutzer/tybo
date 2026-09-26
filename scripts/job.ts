#!/usr/bin/env -S bun --no-env-file
/**
 * Hintergrund-Jobs (Issue #103, Entscheidung 0016): `bun run job …` und
 * `tybo job …`. Aufruf und Optionen: src/lib/jobs/cli.ts, Doku:
 * docs/hintergrund-jobs.md.
 *
 * Projektordner aus dem Ordner dieses Skripts (oder TYBO_ROOT, für Tests),
 * nie aus dem Arbeitsverzeichnis. --no-env-file: die .env kommt aus dem
 * Projektordner, nicht aus dem Ordner des Aufrufers.
 */

import { resolve } from "node:path";

type Env = Record<string, string | undefined>;

export function jobRoot(env: Env): string {
  return env.TYBO_ROOT?.trim() || resolve(import.meta.dir, "..");
}

export async function main(argv: string[], callerEnv: Env): Promise<number> {
  const root = jobRoot(callerEnv);
  const cwd = process.cwd();
  // Wie der Bot: Module, die Pfade aus dem Arbeitsverzeichnis ableiten, sehen den Projektordner
  process.chdir(root);
  process.env.GO_PROJECT_ROOT = root;
  const { readDotenv, createJobDeps, outboxDepsFor } = await import("../src/lib/jobs/default-deps");
  const dotenv = readDotenv(root);
  // Werte aus <root>/.env gehen vor, wie im Bot (loadEnv); der Nachrichten-Speicher liest process.env
  for (const [key, value] of Object.entries(dotenv)) if (value !== undefined) process.env[key] = value;
  const env: Env = { ...process.env };
  const { runJobCli } = await import("../src/lib/jobs/cli");
  const { MODEL_IDS } = await import("../src/lib/model-router");
  const { defaultEffort } = await import("../src/lib/claude");
  return runJobCli(argv, {
    cwd,
    callerEnv,
    out: line => console.log(line),
    err: line => console.error(line),
    deps: createJobDeps({ root, env }),
    outbox: outboxDepsFor(root, env),
    defaultModel: MODEL_IDS.opus,
    defaultEffort,
  });
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2), { ...process.env }));
}
