/**
 * Echte Abhängigkeiten der Hintergrund-Jobs (Issue #103): Prozesse,
 * Outbox, Umgebung. Tests nutzen stattdessen Attrappen.
 *
 * Die Pfade kommen aus root (Ordner über scripts/), nie aus dem aktuellen
 * Arbeitsverzeichnis: `tybo job` läuft auch aus fremden Ordnern.
 */

import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dmChatId, telegramConfigured, webConversationOf } from "../channels";
import { useChoicesFileIn } from "../choices";
import { defaultOutboxDeps, sendAndRecord, type OutboxDeps } from "../outbox";
import { claudeAuthProblem } from "../engines/claude-auth";
import { checkEngine } from "../engines/check";
import { codexPath } from "../engines/codex";
import { currentCodexMcpPlan } from "../engines/codex-mcp";
import { claudeNotesSection } from "../engines/claude-notes";
import { getSettings } from "../settings";
import { subprocessEnv } from "../subprocess-env";
import { resolveGroupId } from "../../web/bot-telegram";
import type { ControlDeps } from "./control";
import { readCodexMcpServers } from "./codex-tools";
import { createStreamMasker, maskSecrets, mergeSecretValues, projectSecrets, type SecretValue } from "./mask";
export { readDotenv } from "./mask";
import { realProcessOps } from "./process";
import { expireJobChoices, offerJobResume } from "./choices";
import { recoverWaitingQuestion } from "./question-choices";
import type { JobDeps } from "./runner";
import { newJobId, jobFile, type JobEngine, type JobStatus } from "./store";

/** scripts/job.ts dieses Checkouts (der Projektordner kann in Tests ein anderer sein, TYBO_ROOT) */
const JOB_SCRIPT = join(import.meta.dir, "..", "..", "..", "scripts", "job.ts");

type Env = Record<string, string | undefined>;

/**
 * Startsperre: sh wartet auf die Zeile "start" auf stdin und wird erst dann
 * per exec zum Motor (gleiche PID, gleiche Startzeit, gleiche Gruppe). Endet
 * stdin vorher, weil der Wächter starb oder cancel rief, endet sh, ohne
 * den Motor zu starten. Der Rest von stdin nach der Zeile ist der Auftrag.
 */
export const START_GATE = 'IFS= read -r go || exit 0; [ "$go" = start ] || exit 0; exec "$@"';

/**
 * Schreibt stdout und stderr maskiert ins selbe Log. Beide Ströme teilen
 * einen Maskierer, der die Stücke in genau der Reihenfolge sieht, in der sie
 * in der Datei landen: ein Geheimnis, dessen Teile abwechselnd aus beiden
 * Strömen kommen, setzt sich so in der Datei nicht wieder zusammen. Die
 * Dekodierung bleibt pro Strom (UTF-8-Zeichen können über Stücke verteilt sein).
 */
export async function pumpMasked(streams: readonly ReadableStream<Uint8Array>[], fd: number, secrets: readonly SecretValue[]): Promise<void> {
  const masker = createStreamMasker(secrets);
  const write = (text: string) => {
    if (text) writeSync(fd, text);
  };
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    try {
      for await (const bytes of stream) write(masker.push(decoder.decode(bytes, { stream: true })));
    } finally {
      write(masker.push(decoder.decode()));
    }
  };
  // allSettled: auch wenn ein Strom scheitert, erst auf den anderen warten
  await Promise.allSettled(streams.map(pump));
  // Erst wenn beide Ströme zu sind, ist der zurückgehaltene Rest vollständig
  write(masker.end());
}

/** Chat-IDs aus <root>/config/topics.json (ohne "*"), wie getTopicConfigChatIds, aber mit festem Ordner */
function topicChatIds(root: string): string[] {
  try {
    const config = JSON.parse(readFileSync(join(root, "config", "topics.json"), "utf8"));
    return config && typeof config === "object" ? Object.keys(config).filter(id => id !== "*") : [];
  } catch {
    return [];
  }
}

/** Outbox mit Pfaden aus root; env muss die .env enthalten */
export function outboxDepsFor(root: string, env: Env): OutboxDeps {
  return {
    ...defaultOutboxDeps(env),
    groupId: resolveGroupId(env, topicChatIds(root)),
    outboxDir: join(root, "data", "outbox"),
  };
}

/**
 * Obergrenze für einen einzelnen Befehl im Job (Bash-Werkzeug, Standard der
 * CLI 10 Minuten). Ohne Hintergrund-Befehle (NO_BACKGROUND_TASKS) muss ein
 * voller Testlauf oder Build im Vordergrund Platz haben.
 */
export const JOB_BASH_MAX_TIMEOUT_MS = 3_600_000;

/**
 * Umgebung für Claude: ohne Geheimnisse (subprocessEnv, API-Schlüssel nach
 * CLAUDE_AUTH), mit dem Gespräch der Rückmeldung. Bei CLAUDE_AUTH=apiKey ohne
 * Schlüssel wirft sie (Issue #349): der Wächter startet Claude dann nicht und
 * meldet start_failed mit dem Grund.
 */
export function jobClaudeEnv(root: string, env: Env, status: JobStatus): Record<string, string> {
  const problem = claudeAuthProblem(env);
  if (problem) throw new Error(problem);
  const result = jobEnv(root, env, status, "claude");
  result.HOME ??= env.HOME ?? homedir();
  result.BASH_MAX_TIMEOUT_MS ??= String(JOB_BASH_MAX_TIMEOUT_MS);
  return result;
}

/** Codex-Regeln für Geheimnisse und Anmeldung, unabhängig von CLAUDE_AUTH. */
export function jobCodexEnv(root: string, env: Env, status: JobStatus): Record<string, string> {
  return { ...jobEnv(root, env, status, "codex"), HOME: env.HOME ?? homedir(), PATH: env.PATH ?? "" };
}

function jobEnv(root: string, env: Env, status: JobStatus, engine: JobEngine): Record<string, string> {
  const result = subprocessEnv({ env, cwd: root, home: env.HOME ?? homedir(), engine, jobChain: status.jobChain ?? 0 });
  delete result.TYBO_JOB_CHAIN;
  // subprocessEnv hat vererbte Gesprächsvariablen schon entfernt; ein
  // Web-Gespräch (web:<uuid>, Issue #227) geht als TYBO_CONVERSATION_ID mit
  const web = webConversationOf(status.target.chatId);
  if (web) result.TYBO_CONVERSATION_ID = web;
  else if (status.target.chatId) result.TYBO_CHAT_ID = status.target.chatId;
  if (status.target.topicId !== undefined) result.TYBO_TOPIC_ID = String(status.target.topicId);
  result.TYBO_JOB_ID = status.id;
  if (status.jobChain !== undefined) result.TYBO_JOB_CHAIN = String(status.jobChain);
  return result;
}

export interface DefaultDepsOptions {
  root: string;
  /** Umgebung inklusive .env (Wächter und Motor bekommen daraus ihre Werte) */
  env: Env;
  log?(line: string): void;
}

export function createJobDeps(o: DefaultDepsOptions): JobDeps & ControlDeps {
  const { root, env } = o;
  const outbox = outboxDepsFor(root, env);
  const secrets = () => projectSecrets(root, env);
  const sink = o.log ?? (line => console.error(line));
  const deps: JobDeps & ControlDeps = {
    root,
    proc: realProcessOps,
    notify: input => sendAndRecord(input, outbox),
    offerResume: async status => {
      useChoicesFileIn(root);
      await offerJobResume(status, deps, { userId: dmChatId(env), groupId: outbox.groupId ?? undefined, telegram: telegramConfigured(env) });
    },
    recoverWaiting: async status => {
      useChoicesFileIn(root);
      await recoverWaitingQuestion(status, deps, { userId: dmChatId(env), groupId: outbox.groupId ?? undefined, telegram: telegramConfigured(env) });
    },
    expireResumeChoices: async id => {
      useChoicesFileIn(root);
      await expireJobChoices(id);
    },
    secrets,
    now: () => new Date(),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    // Auch hier maskiert, falls ein Aufrufer logSafe umgeht
    log: line => sink(maskSecrets(line, secrets())),
    newId: () => newJobId(),
    claudePath: env.CLAUDE_PATH || "claude",
    codexPath: env.CODEX_PATH || codexPath(),
    platform: process.platform,
    claudeEnv: status => jobClaudeEnv(root, env, status),
    codexEnv: status => jobCodexEnv(root, env, status),
    async checkCodex() {
      const status = await checkEngine("codex");
      if (!status.installed || !status.loggedIn) throw new Error(status.message ?? "Codex ist nicht bereit.");
    },
    codexMcpServers: jobEnv => readCodexMcpServers({ codexPath: env.CODEX_PATH || codexPath(), root, env: jobEnv }),
    // scripts/job.ts setzt GO_PROJECT_ROOT und lädt die .env vor diesem Import.
    // Die Chat-Einstellung engine.codex.sandbox gilt für Jobs ausdrücklich nicht.
    codexMcpPlan: baseEnv => currentCodexMcpPlan({ cwd: root, baseEnv, sandbox: "full" }),
    claudeNotes: options => getSettings().engine?.codex?.claudeNotes === false ? "" : claudeNotesSection(options),
    spawnWatcher(id, run) {
      const fd = openSync(jobFile(root, id, "watcherLog"), "a", 0o600);
      try {
        const proc = Bun.spawn({
          cmd: [process.execPath, "--no-env-file", JOB_SCRIPT, "__watch", id, String(run)],
          cwd: root,
          env: { ...env, TYBO_ROOT: root } as Record<string, string>,
          // Eigene Session: überlebt das Ende des Aufrufers und Neustarts des Bots
          detached: true,
          stdin: "ignore",
          stdout: fd,
          stderr: fd,
        });
        proc.unref();
        return { pid: proc.pid };
      } finally {
        closeSync(fd);
      }
    },
    spawnClaude(spec) {
      const fd = openSync(spec.logPath, "a", 0o600);
      let proc: ReturnType<typeof spawnGated>;
      try {
        proc = spawnGated(spec);
      } catch (e) {
        closeSync(fd);
        throw e;
      }
      // Ausgabe nie ungefiltert ins Log: stdout und stderr laufen durch die Maskierung
      const values = mergeSecretValues(secrets(), spec.secrets ?? []);
      const drained = pumpMasked([proc.stdout, proc.stderr], fd, values)
        .catch(() => {})
        .finally(() => closeSync(fd));
      let gate = false;
      const close = (text?: string) => {
        if (gate) return;
        gate = true;
        try {
          if (text !== undefined) proc.stdin.write(text);
          proc.stdin.end();
        } catch {
          // Startprozess schon weg: nichts mehr zu tun
        }
      };
      return {
        pid: proc.pid,
        exited: proc.exited.then(() => ({ code: proc.signalCode ? null : proc.exitCode, signal: proc.signalCode ?? null })),
        // Auftrag über stdin, wie die übrigen Claude-Aufrufe (keine Längengrenze der Argumente)
        release: () => close(`start\n${spec.prompt}`),
        cancel: () => close(),
        drained,
      };
    },
  };
  return deps;
}

/** Startprozess hinter der Startsperre, in eigener Prozessgruppe (stop trifft nur den Job) */
function spawnGated(spec: { cmd: string[]; cwd: string; env: Record<string, string> }) {
  return Bun.spawn({
    cmd: ["/bin/sh", "-c", START_GATE, "tybo-job", ...spec.cmd],
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}
