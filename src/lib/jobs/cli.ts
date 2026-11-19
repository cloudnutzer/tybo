/**
 * Befehlszeile für Hintergrund-Jobs (Issue #103): `bun run job …` und
 * `tybo job …`, beide über scripts/job.ts.
 *
 *   job start --title <t> (--brief <datei> | --text <auftrag>) [--topic <id>]
 *             [--engine claude|codex] [--max-hours <n>] [--model <m>] [--effort <e>] [--full-access] [--zurueck]
 *   job list
 *   job stop <id>
 *   job resume <id>
 *   job log <id>
 *
 * Exit-Codes: 0 erledigt, 1 gescheitert, 2 falscher Aufruf.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyEnvTarget } from "../../../scripts/notify";
import { checkOutboxTarget, type OutboxDeps } from "../outbox";
import { CODEX_EFFORT_LEVELS, EFFORT_LEVELS, type Settings } from "../settings";
import { formatJobList, jobLog, stopJob, type ControlDeps } from "./control";
import { maskSecrets } from "./mask";
import { resumeJob, resumeMessage } from "./resume";
import { DEFAULT_MAX_HOURS, MAX_MAX_HOURS, MODEL_PATTERN, runWatcher, startJob, type JobDeps } from "./runner";
import { isValidJobId, jobModelLabel, type JobEngine, type JobTarget } from "./store";

type Env = Record<string, string | undefined>;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const JOB_USAGE = `Aufruf:
  job start --title <Titel> (--brief <datei> | --text <Auftrag>) [--topic <id>]
            [--engine claude|codex] [--max-hours <n>] [--model <modell>]
            [--effort <stufe>] [--full-access]
            [--allow-duplicate] [--zurueck]
  job list             laufende und die letzten 20 beendeten Jobs
  job stop <id>        Job beenden (ganzer Prozessbaum), Meldung „gestoppt"
  job resume <id>      abgebrochenen Claude-Job mit derselben Session fortsetzen
  job log <id>         Log des Jobs (Werte aus .env verborgen)

  resume         Nach Abbruch, Zeitlimit oder unbeantworteter Frage, mit Claude-Session;
                 nach Abbruch/Zeitlimit voller Zeitraum erneut, bei Fragen nur der Rest.
                 Dieselben Rechte und dasselbe Rückmeldeziel.
                 Nicht für Codex, eigene Arbeitsordner oder bewusst gestoppte Jobs.

  --topic        Topic der Forum-Gruppe für die Rückmeldung (1 = General); ohne:
                 Gespräch aus TYBO_TOPIC_ID/TYBO_CHAT_ID, sonst Direktchat
  --max-hours    Zeitlimit in Stunden, Standard ${DEFAULT_MAX_HOURS}, höchstens ${MAX_MAX_HOURS}
  --engine       claude (Standard) oder codex; eigene Arbeitsordner nur mit Claude
  --model        Standard aus config/settings.json: defaults.model (Claude),
                 engine.codex.model (Codex); sonst Claude-Standard bzw. Codex-Konfiguration
  --effort       Claude: ${EFFORT_LEVELS.join(", ")}; Codex: ${CODEX_EFFORT_LEVELS.join(", ")}
                 Standard aus defaults.effort bzw. engine.codex.effort;
                 sonst zum Claude-Modell passend bzw. aus der Codex-Konfiguration
  --full-access  Alle Werkzeuge ohne Rückfragen, Codex ohne Sandbox.
                 Nur für Aufträge, die tybo selbst formuliert hat, nie für
                 übernommene fremde Inhalte (Mail, Web, Dateien).
                 Ohne: Claude mit acceptEdits (Dateien bearbeiten, keine Befehle);
                 Codex mit workspace-write: nur im Projekt schreiben (apply_patch).
                 Codex sieht als Arbeitsmaterial nur den Inhalt des Auftrags;
                 lokale Textdateien kann er ohne --full-access nicht lesen.
                 Dafür Claude nehmen oder, nur bei selbst formulierten Aufträgen,
                 --full-access. Beide Motoren ohne Rückfragen.
                 Bei Codex aus: Shell und Code-Ausführung, Websuche, Apps,
                 Plugins, Browser, Computersteuerung, Bilder, MCP-Server,
                 Unteragenten, Hooks und externe Benachrichtigungsbefehle.
                 CLI 0.169.0 zeigt weiterhin exec/wait und MCP-Ressourcenwerkzeuge:
                 Code-Host gesperrt, MCP ohne aktive Server. unified_exec bleibt
                 intern an, Shell-Aufrufe sind trotzdem gesperrt. Konto-Apps konnten
                 nur ohne Anmeldung geprüft werden. Mehr: docs/hintergrund-jobs.md
  --allow-duplicate  auch starten, wenn ein Job mit gleichem Titel oder
                 Auftrag schon läuft (sonst Abbruch mit Exit 2)
  --zurueck      Bericht zusätzlich als Eingabe an tybo im Zielgespräch;
                 ohne Gesprächskontext im Direktchat. Höchstens drei Jobs
                 je Kette (TYBO_JOB_CHAIN), der vierte wird mit Exit 2 abgelehnt.
Werte, die mit -- beginnen, als --text=<wert> übergeben.`;

const VALUE_FLAGS = new Set(["title", "brief", "text", "topic", "max-hours", "engine", "model", "effort"]);
const SWITCHES = new Set(["full-access", "allow-duplicate", "zurueck"]);
const TITLE_MAX = 200;
const BRIEF_MAX_BYTES = 1_000_000;

export interface StartArgs {
  title: string;
  briefFile?: string;
  text?: string;
  topicId?: number;
  maxHours: number;
  engine: JobEngine;
  model?: string;
  effort?: string;
  fullAccess: boolean;
  allowDuplicate?: boolean;
  returnToChat?: boolean;
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
  const engine = values.engine ?? "claude";
  if (engine !== "claude" && engine !== "codex") return { error: "--engine muss claude oder codex sein" };
  const result: StartArgs = { title, engine, maxHours: DEFAULT_MAX_HOURS, fullAccess: switches.has("full-access") };
  if (switches.has("allow-duplicate")) result.allowDuplicate = true;
  if (switches.has("zurueck")) result.returnToChat = true;
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
    const efforts = engine === "codex" ? CODEX_EFFORT_LEVELS : EFFORT_LEVELS;
    if (!(efforts as readonly string[]).includes(values.effort)) return { error: `--effort muss für ${engine} eins von ${efforts.join(", ")} sein` };
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
  /** Aus dem Projektordner gelesen, nicht aus cwd (Ordner des Aufrufers) */
  settings?: Settings;
}

async function start(argv: string[], o: JobCliOptions): Promise<number> {
  const parsed = parseStartArgs(argv);
  if ("error" in parsed) {
    o.err(`${parsed.error}\n\n${JOB_USAGE}`);
    return EXIT_USAGE;
  }
  const target = resolveJobTarget(parsed.topicId, o.callerEnv);
  const inheritedChain = o.callerEnv.TYBO_JOB_CHAIN;
  if (inheritedChain !== undefined && !/^[0-3]$/.test(inheritedChain)) {
    o.err("Nicht gestartet: TYBO_JOB_CHAIN muss eine ganze Zahl von 0 bis 3 sein.");
    return EXIT_USAGE;
  }
  const jobChain = Number(inheritedChain ?? 0) + (parsed.returnToChat ? 1 : 0);
  if (jobChain > 3) {
    o.err("Nicht gestartet: Höchstens drei Jobs mit --zurueck je Kette. Bitte das Ergebnis im Gespräch prüfen.");
    return EXIT_USAGE;
  }
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
  const codex = parsed.engine === "codex";
  const defaults = codex ? o.settings?.engine?.codex : o.settings?.defaults;
  const model = parsed.model ?? defaults?.model ?? (codex ? undefined : o.defaultModel);
  const effort = parsed.effort ?? defaults?.effort ?? (codex ? undefined : o.defaultEffort(model!));
  const result = await startJob(
    {
      title: parsed.title,
      brief,
      target,
      maxHours: parsed.maxHours,
      engine: parsed.engine,
      model,
      ...(effort ? { effort } : {}),
      fullAccess: parsed.fullAccess,
      ...(parsed.returnToChat ? { returnToChat: true } : {}),
      ...(jobChain ? { jobChain } : {}),
      ...(parsed.allowDuplicate ? { allowDuplicate: true } : {}),
    },
    o.deps,
  );
  if (!result.ok && result.duplicateOf) {
    o.err(`Nicht gestartet: ${result.error}`);
    return EXIT_USAGE;
  }
  if (!result.ok) {
    o.err(`Job nicht gestartet: ${maskSecrets(result.error, o.deps.secrets())}`);
    return EXIT_FAILED;
  }
  o.out(maskSecrets(`Job ${result.id} ${result.confirmed ? "läuft" : "startet"} (${jobModelLabel(result.status)}): ${parsed.title}`, o.deps.secrets()));
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
    case "resume": {
      const id = idArg(rest, o, "resume");
      if (!id) return EXIT_USAGE;
      const result = await resumeJob(id, o.deps);
      (result.ok ? o.out : o.err)(maskSecrets(resumeMessage(result), o.deps.secrets()));
      return result.ok ? EXIT_OK : EXIT_FAILED;
    }
    case "__watch": {
      // Nur für den Starter: der Wächter selbst
      const id = (rest.length === 1 || rest.length === 2) && isValidJobId(rest[0]) ? rest[0] : null;
      if (!id) return EXIT_USAGE;
      const run = rest[1] === undefined ? undefined : Number(rest[1]);
      if (run !== undefined && (!Number.isSafeInteger(run) || run < 1)) return EXIT_USAGE;
      return runWatcher(id, o.deps, run);
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
