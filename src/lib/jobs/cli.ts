/**
 * Befehlszeile für Hintergrund-Jobs (Issue #103): `bun run job …` und
 * `tybo job …`, beide über scripts/job.ts.
 *
 *   job start --title <t> (--brief <datei> | --text <auftrag>) [--topic <id>]
 *             [--max-hours <n>] [--model <m>] [--effort <e>] [--full-access]
 *   job list
 *   job stop <id>
 *   job log <id>
 *
 * Exit-Codes: 0 erledigt, 1 gescheitert, 2 falscher Aufruf.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyEnvTarget } from "../../../scripts/notify";
import { checkOutboxTarget, type OutboxDeps } from "../outbox";
import { formatJobList, jobLog, stopJob, type ControlDeps } from "./control";
import { maskSecrets } from "./mask";
import { DEFAULT_MAX_HOURS, EFFORTS, MAX_MAX_HOURS, MODEL_PATTERN, runWatcher, startJob, type JobDeps } from "./runner";
import { isValidJobId, type JobTarget } from "./store";

type Env = Record<string, string | undefined>;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const JOB_USAGE = `Aufruf:
  job start --title <Titel> (--brief <datei> | --text <Auftrag>) [--topic <id>]
            [--max-hours <n>] [--model <modell>] [--effort <stufe>] [--full-access]
  job list             laufende und die letzten 20 beendeten Jobs
  job stop <id>        Job beenden (ganzer Prozessbaum), Meldung „gestoppt"
  job log <id>         Log des Jobs (Werte aus .env verborgen)

  --topic        Topic der Forum-Gruppe für die Rückmeldung (1 = General); ohne:
                 Gespräch aus TYBO_TOPIC_ID/TYBO_CHAT_ID, sonst Direktchat
  --max-hours    Zeitlimit in Stunden, Standard ${DEFAULT_MAX_HOURS}, höchstens ${MAX_MAX_HOURS}
  --effort       ${EFFORTS.join(", ")}
  --full-access  Claude ohne Rückfragen mit allen Werkzeugen (bypassPermissions).
                 Nur für Aufträge, die tybo selbst formuliert hat, nie für
                 übernommene fremde Inhalte (Mail, Web, Dateien). Ohne: Dateien
                 bearbeiten ja, Befehle ausführen nein (acceptEdits).
Werte, die mit -- beginnen, als --text=<wert> übergeben.`;

const VALUE_FLAGS = new Set(["title", "brief", "text", "topic", "max-hours", "model", "effort"]);
const SWITCHES = new Set(["full-access"]);
const TITLE_MAX = 200;
const BRIEF_MAX_BYTES = 1_000_000;

export interface StartArgs {
  title: string;
  briefFile?: string;
  text?: string;
  topicId?: number;
  maxHours: number;
  model?: string;
  effort?: string;
  fullAccess: boolean;
}

export function parseStartArgs(argv: string[]): StartArgs | { error: string } {
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) return { error: `Unbekanntes Argument: ${arg}` };
    const eq = arg.indexOf("=");
    const flag = arg.slice(2, eq === -1 ? undefined : eq);
    if (SWITCHES.has(flag)) {
      if (eq !== -1) return { error: `--${flag} hat keinen Wert` };
      switches.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) return { error: `Unbekannte Option: --${flag}` };
    if (flag in values) return { error: `--${flag} doppelt angegeben` };
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `--${flag} braucht einen Wert` };
      i++;
    }
    values[flag] = value;
  }
  const title = (values.title ?? "").replace(/\s+/g, " ").trim();
  if (!title) return { error: "--title fehlt" };
  if (title.length > TITLE_MAX) return { error: `--title länger als ${TITLE_MAX} Zeichen` };
  if ((values.brief === undefined) === (values.text === undefined)) return { error: "Genau eins von --brief oder --text angeben" };
  if (values.text !== undefined && !values.text.trim()) return { error: "--text ist leer" };
  const result: StartArgs = { title, maxHours: DEFAULT_MAX_HOURS, fullAccess: switches.has("full-access") };
  if (values.brief !== undefined) result.briefFile = values.brief;
  if (values.text !== undefined) result.text = values.text;
  if (values.topic !== undefined) {
    if (!/^[1-9]\d{0,9}$/.test(values.topic)) return { error: "--topic muss eine positive ganze Zahl sein" };
    result.topicId = Number(values.topic);
  }
  if (values["max-hours"] !== undefined) {
    const raw = values["max-hours"];
    const hours = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || !(hours > 0) || hours > MAX_MAX_HOURS) {
      return { error: `--max-hours muss eine Zahl über 0 und höchstens ${MAX_MAX_HOURS} sein` };
    }
    result.maxHours = hours;
  }
  if (values.model !== undefined) {
    if (!MODEL_PATTERN.test(values.model)) return { error: "--model ist kein gültiger Modellname" };
    result.model = values.model;
  }
  if (values.effort !== undefined) {
    if (!(EFFORTS as readonly string[]).includes(values.effort)) return { error: `--effort muss eins von ${EFFORTS.join(", ")} sein` };
    result.effort = values.effort;
  }
  return result;
}

/**
 * Rückmeldeziel wie bei `bun run notify`: --topic geht vor, sonst
 * TYBO_TOPIC_ID/TYBO_CHAT_ID aus der Umgebung, sonst Direktchat. Ungültige
 * Umgebung ist ein Fehler, nie der Direktchat.
 */
export function resolveJobTarget(topicId: number | undefined, env: Env): JobTarget | { error: string } {
  const targeted = applyEnvTarget({ source: "job", ...(topicId !== undefined ? { topicId } : {}) }, env);
  if ("error" in targeted) return { error: targeted.error };
  const target: JobTarget = {};
  if (targeted.input.topicId !== undefined) target.topicId = targeted.input.topicId;
  if (targeted.input.chatId !== undefined) target.chatId = targeted.input.chatId;
  return target;
}

export interface JobCliOptions {
  /** Arbeitsverzeichnis des Aufrufers, für --brief */
  cwd: string;
  /** Umgebung des Aufrufers (TYBO_CHAT_ID/TYBO_TOPIC_ID), vor dem Laden der .env */
  callerEnv: Env;
  out(line: string): void;
  err(line: string): void;
  deps: JobDeps & ControlDeps;
  /** Ziel gegen Gruppe und Direktchat prüfen (checkOutboxTarget) */
  outbox: Pick<OutboxDeps, "groupId" | "userId">;
  defaultModel: string;
  defaultEffort(model: string): string | undefined;
}

async function start(argv: string[], o: JobCliOptions): Promise<number> {
  const parsed = parseStartArgs(argv);
  if ("error" in parsed) {
    o.err(`${parsed.error}\n\n${JOB_USAGE}`);
    return EXIT_USAGE;
  }
  const target = resolveJobTarget(parsed.topicId, o.callerEnv);
  if ("error" in target) {
    o.err(`Nicht gestartet: ${target.error}`);
    return EXIT_USAGE;
  }
  const targetError = checkOutboxTarget(target, o.outbox);
  if (targetError) {
    o.err(`Nicht gestartet, Rückmeldung wäre unzustellbar: ${targetError}`);
    return EXIT_USAGE;
  }
  let brief: string;
  if (parsed.briefFile !== undefined) {
    try {
      const buf = await readFile(resolve(o.cwd, parsed.briefFile));
      if (buf.byteLength > BRIEF_MAX_BYTES) {
        o.err("Nicht gestartet: Auftragsdatei größer als 1 MB");
        return EXIT_USAGE;
      }
      brief = buf.toString("utf8");
    } catch {
      o.err("Nicht gestartet: Auftragsdatei nicht lesbar");
      return EXIT_USAGE;
    }
  } else brief = parsed.text!;
  if (!brief.trim()) {
    o.err("Nicht gestartet: Auftrag ist leer");
    return EXIT_USAGE;
  }
  const model = parsed.model ?? o.defaultModel;
  const effort = parsed.effort ?? o.defaultEffort(model);
  const result = await startJob(
    { title: parsed.title, brief, target, maxHours: parsed.maxHours, model, ...(effort ? { effort } : {}), fullAccess: parsed.fullAccess },
    o.deps,
  );
  if (!result.ok) {
    o.err(`Job nicht gestartet: ${maskSecrets(result.error, o.deps.secrets())}`);
    return EXIT_FAILED;
  }
  o.out(`Job ${result.id} ${result.confirmed ? "läuft" : "startet"}: ${maskSecrets(parsed.title, o.deps.secrets())}`);
  o.out(`Rückmeldung kommt automatisch. Stoppen: job stop ${result.id} · Log: job log ${result.id}`);
  return EXIT_OK;
}

function idArg(argv: string[], o: JobCliOptions, command: string): string | null {
  if (argv.length !== 1 || !isValidJobId(argv[0])) {
    o.err(`Aufruf: job ${command} <id> (IDs zeigt job list)`);
    return null;
  }
  return argv[0];
}

export async function runJobCli(argv: string[], o: JobCliOptions): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "start":
      return start(rest, o);
    case "list": {
      if (rest.length) break;
      o.out(await formatJobList(o.deps));
      return EXIT_OK;
    }
    case "stop": {
      const id = idArg(rest, o, "stop");
      if (!id) return EXIT_USAGE;
      const result = await stopJob(id, o.deps);
      (result.ok ? o.out : o.err)(result.message);
      return result.ok ? EXIT_OK : EXIT_FAILED;
    }
    case "log": {
      const id = idArg(rest, o, "log");
      if (!id) return EXIT_USAGE;
      const log = await jobLog(id, o.deps);
      if (log === null) {
        o.err(`Job ${id} gibt es nicht`);
        return EXIT_FAILED;
      }
      o.out(log);
      return EXIT_OK;
    }
    case "__watch": {
      // Nur für den Starter: der Wächter selbst
      const id = rest.length === 1 && isValidJobId(rest[0]) ? rest[0] : null;
      if (!id) return EXIT_USAGE;
      return runWatcher(id, o.deps);
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      o.out(JOB_USAGE);
      return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  o.err(`Unbekannter Aufruf: job ${argv.join(" ")}\n\n${JOB_USAGE}`);
  return EXIT_USAGE;
}
