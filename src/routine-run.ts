/**
 * Wrapper für zeitgesteuerte Routinen (Issue #285, Entscheidung 0025).
 *
 *   bun run src/routine-run.ts --id <label> -- <befehl> [args…]
 *
 * Startet den Befehl im aktuellen Arbeitsordner mit unveränderter Umgebung,
 * reicht stdout und stderr unverändert durch (die Log-Dateien aus dem Plist
 * bleiben, wie sie sind) und hält danach Beginn, Dauer, Exit-Code und die
 * letzten Zeilen der Ausgabe (maskiert) in data/routines/<id>.json fest.
 *
 * Exit-Code: immer der des Befehls. Endet der Befehl durch ein Signal, endet
 * der Wrapper durch dasselbe Signal (launchd sieht dasselbe wie ohne
 * Wrapper); konnte er nicht starten, 127. SIGTERM, SIGINT und SIGHUP gibt
 * der Wrapper an den Befehl weiter und hält den Lauf als abgebrochen fest,
 * auch wenn der Befehl das Signal abfängt und mit 0 endet (dann endet auch
 * der Wrapper mit 0). Ein Fehler beim Schreiben des Protokolls ändert den
 * Exit-Code nie, er steht nur auf stderr.
 *
 * Ist die .env da, aber nicht lesbar, wären die Masken unvollständig: der
 * Befehl läuft trotzdem unverändert, im Protokoll steht statt der Ausgabe
 * nur TAIL_WITHHELD.
 *
 * Ungültige Aufrufe (keine id, id passt zu keiner Routine, kein Befehl)
 * enden mit 2, bevor etwas startet. Zugelassen sind ai.tybo.<name> und
 * Labels bzw. Präfixe aus config/routines.json.
 *
 * Projektordner (config/routines.json, .env für die Masken, data/routines/)
 * ist der Ordner über src/, nie der Arbeitsordner des Befehls;
 * TYBO_ROUTINES_ROOT ersetzt ihn (für Tests).
 *
 * Meldungen (Issue #287, lib/routines/alerts.ts): vor dem Start hält der
 * Wrapper den Beginn in data/routines/alerts.json fest, nach dem Ende meldet
 * er den ersten Fehlschlag einer Serie bzw. die Entwarnung über die Outbox
 * (Absender routine). Versandkonfiguration und ROUTINE_ALERTS kommen aus der
 * .env des Projektordners (die Plists starten mit --no-env-file); sie wird
 * erst nach dem Ende des Befehls in die eigene Umgebung übernommen, der
 * Befehl sieht seine Umgebung unverändert. Ein Fehler beim Melden ändert den
 * Exit-Code nie. Mit ROUTINE_ALERTS=off sendet er nichts, gleicht
 * alerts.json aber weiter mit dem Lauf ab.
 */

import { existsSync, readFileSync } from "node:fs";
import { constants, homedir } from "node:os";
import { dirname } from "node:path";
import { parseEnvContent } from "./lib/env-file";
import { projectSecretsOrThrow, type SecretValue } from "./lib/jobs/mask";
import {
  ALERT_SOURCE,
  alertAfterRun,
  alertsEnabled,
  fileAlertsStore,
  markRunStart,
  plistLogPath,
  type AlertSender,
  type AlertsStore,
  type RunAlertDeps,
  type RunAlertOutcome,
} from "./lib/routines/alerts";
import { parseRoutinesConfig, ROUTINES_CONFIG_FILE } from "./lib/routines/config";
import { menuAlertSender, routineChannel, routineConversation, type OfferOutcome } from "./lib/routine-choices";
import type { Choice } from "./lib/choices";
import { dmChatId } from "./lib/channels";
import type { RoutinesDeps } from "./lib/routines/catalog";
import type { SendAndRecordInput, SendAndRecordResult } from "./lib/outbox";
import { appendRun, routineIdAllowed, TailCollector, TAIL_WITHHELD, type RoutineRun } from "./lib/routines/runs";
import { join } from "node:path";

export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 127;
const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export const ROUTINE_RUN_USAGE = "Aufruf: bun run src/routine-run.ts --id <label> -- <befehl> [args…]";

export function parseWrapperArgs(argv: string[]): { id: string; command: string[] } | { error: string } {
  if (argv[0] !== "--id" || !argv[1] || argv[1] === "--") return { error: `routine-run: --id fehlt. ${ROUTINE_RUN_USAGE}` };
  if (argv[2] !== "--") return { error: `routine-run: „--" vor dem Befehl fehlt. ${ROUTINE_RUN_USAGE}` };
  const command = argv.slice(3);
  if (!command.length || !command[0]) return { error: `routine-run: kein Befehl angegeben. ${ROUTINE_RUN_USAGE}` };
  return { id: argv[1], command };
}

export function wrapperRoot(env: Record<string, string | undefined> = process.env): string {
  return env.TYBO_ROUTINES_ROOT || dirname(import.meta.dir);
}

/** Ist die id für diesen Projektordner zugelassen? Liest config/routines.json frisch */
export function idAllowedInRoot(id: string, root: string): boolean {
  const path = join(root, ROUTINES_CONFIG_FILE);
  let content: string | null = null;
  try {
    content = existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    content = null;
  }
  return routineIdAllowed(id, parseRoutinesConfig(content).config);
}

export interface WrapOptions {
  id: string;
  command: string[];
  root: string;
  /** Masken für die Ausgabe; null: .env nicht lesbar, die Ausgabe bleibt aus dem Protokoll */
  secrets?: readonly SecretValue[] | null;
  /** Ziel für stdout bzw. stderr des Befehls; Standard: die eigenen */
  stdout?: (chunk: Uint8Array) => void;
  stderr?: (chunk: Uint8Array) => void;
  /** Meldungen des Wrappers selbst (nur stderr) */
  note?: (line: string) => void;
  /** Signale an den Befehl weitergeben (CLI: ja) */
  forwardSignals?: boolean;
  now?: () => number;
  append?: typeof appendRun;
  /** Meldungen (Issue #287); fehlt oder null: keine, alerts.json bleibt unberührt */
  alerts?: (RunAlertDeps & { store: AlertsStore }) | null;
}

export interface WrapResult {
  /** Exit-Code, mit dem der Wrapper endet */
  exitCode: number;
  /** Signal, an dem der Befehl endete; der Wrapper endet dann ebenso */
  childSignal: NodeJS.Signals | null;
  run: RoutineRun;
  /** Was die Meldung ergab; fehlt ohne Meldungen oder wenn alerts.json scheiterte */
  alert?: RunAlertOutcome;
}

function writeTo(stream: NodeJS.WriteStream): (chunk: Uint8Array) => void {
  return chunk => {
    try {
      stream.write(chunk);
    } catch {
      // Ausgabe nicht schreibbar (geschlossene Pipe): der Lauf geht weiter
    }
  };
}

async function pump(stream: ReadableStream<Uint8Array>, name: string, write: (chunk: Uint8Array) => void, tails: (TailCollector | null)[]): Promise<void> {
  for await (const chunk of stream) {
    write(chunk);
    for (const tail of tails) tail?.push(name, chunk);
  }
}

function signalNumber(signal: string): number {
  return (constants.signals as Record<string, number>)[signal] ?? 0;
}

export async function runWrapped(o: WrapOptions): Promise<WrapResult> {
  const now = o.now ?? Date.now;
  const note = o.note ?? (line => process.stderr.write(`${line}\n`));
  const tail = o.secrets === null ? null : new TailCollector(o.secrets ?? []);
  // Nur stderr, für die Fehlerzeile der Meldung (tail mischt beide Ströme)
  const errTail = o.secrets === null || !o.alerts ? null : new TailCollector(o.secrets ?? []);
  const started = now();
  if (o.alerts) {
    try {
      await markRunStart(o.alerts.store, o.id, started, o.alerts.pid);
    } catch (e) {
      note(`routine-run: Beginn für ${o.id} nicht festgehalten: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let forwarded: string | null = null;
  let exitCode: number;
  let childSignal: NodeJS.Signals | null = null;
  const handlers: Array<[string, () => void]> = [];

  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    proc = Bun.spawn(o.command, { cwd: process.cwd(), env: process.env, stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    const message = `routine-run: Befehl konnte nicht starten: ${o.command[0]} (${e instanceof Error ? e.message : String(e)})`;
    note(message);
    tail?.note(message);
    exitCode = EXIT_NOT_FOUND;
  }

  if (proc) {
    const child = proc;
    if (o.forwardSignals) {
      for (const sig of FORWARDED) {
        const handler = () => {
          forwarded ??= sig;
          try {
            child.kill(sig);
          } catch {
            // schon beendet
          }
        };
        process.on(sig, handler);
        handlers.push([sig, handler]);
      }
    }
    await Promise.all([
      pump(child.stdout as ReadableStream<Uint8Array>, "stdout", o.stdout ?? writeTo(process.stdout), [tail]),
      pump(child.stderr as ReadableStream<Uint8Array>, "stderr", o.stderr ?? writeTo(process.stderr), [tail, errTail]),
      child.exited,
    ]).catch(e => note(`routine-run: Ausgabe nicht vollständig gelesen: ${e instanceof Error ? e.message : String(e)}`));
    await child.exited;
    for (const [sig, handler] of handlers) process.off(sig, handler);
    childSignal = (child.signalCode as NodeJS.Signals | null) ?? null;
    exitCode = child.exitCode ?? (childSignal ? 128 + signalNumber(childSignal) : 1);
  }

  const ended = now();
  const run: RoutineRun = {
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(ended).toISOString(),
    durationMs: Math.max(0, ended - started),
    exitCode: exitCode!,
    tail: tail ? tail.finish() : [TAIL_WITHHELD],
  };
  const signal = forwarded ?? childSignal;
  if (signal) run.signal = signal;

  try {
    await (o.append ?? appendRun)(o.root, o.id, run);
  } catch (e) {
    note(`routine-run: Protokoll für ${o.id} nicht geschrieben: ${e instanceof Error ? e.message : String(e)}`);
  }
  const result: WrapResult = { exitCode: exitCode!, childSignal, run };
  if (o.alerts) {
    try {
      result.alert = await alertAfterRun({ id: o.id, run, stderrTail: errTail ? errTail.finish() : [], secrets: o.secrets === undefined ? [] : o.secrets }, o.alerts);
      if (result.alert === "undelivered") note(`routine-run: Meldung für ${o.id} nicht zugestellt`);
    } catch (e) {
      note(`routine-run: Meldung für ${o.id} gescheitert: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

/** .env des Projektordners; readable false, wenn sie da, aber nicht lesbar ist */
export function readProjectDotenv(root: string): { env: Record<string, string>; readable: boolean } {
  try {
    return { env: parseEnvContent(readFileSync(join(root, ".env"), "utf8")), readable: true };
  } catch (e) {
    return { env: {}, readable: (e as NodeJS.ErrnoException).code === "ENOENT" };
  }
}

/** Längste Wartezeit auf den Versand, danach gilt die Meldung als nicht zugestellt */
const SEND_LIMIT_MS = 150_000;

/**
 * Sender über die Outbox. Übernimmt die .env erst beim Versand, also nach dem
 * Ende des Befehls, in die eigene Umgebung (Telegram, Datenbank für die WebUI).
 */
export function outboxAlertSender(root: string, dotenv: Record<string, string>): AlertSender {
  return async text => {
    for (const [key, value] of Object.entries(dotenv)) process.env[key] = value;
    process.env.GO_PROJECT_ROOT ??= root;
    const { defaultOutboxDeps, sendAndRecord } = await import("./lib/outbox");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Zeitlimit")), SEND_LIMIT_MS);
    });
    try {
      return await Promise.race([sendAndRecord({ source: ALERT_SOURCE, text, format: "plain" }, defaultOutboxDeps(process.env)), limit]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Nachfrist, wenn beim Zeitlimit der Menü-Versand schon unterwegs ist: so
 * lange wartet der Wrapper noch auf dessen Ergebnis, danach läuft das Menü ab
 */
const MENU_GRACE_MS = 30_000;

/** Austauschbare Teile von wrapperMenuOffer (Tests reichen Attrappen herein) */
export interface WrapperMenuDeps {
  /** Katalog; Standard defaultRoutinesDeps(root, process.env) mit echten, nur lesenden Befehlen */
  routines?: RoutinesDeps;
  /** Versand; Standard sendAndRecord mit defaultOutboxDeps(process.env) */
  send?: (input: SendAndRecordInput) => Promise<SendAndRecordResult>;
  /** Zeitgeber für Zeitlimit (SEND_LIMIT_MS) und Nachfrist (MENU_GRACE_MS); Standard setTimeout und clearTimeout */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * Fehler- und Ausgeblieben-Meldungen mit Knöpfen (Issue #288): legt im
 * Rückfragen-Register des Projektordners ein Menü an und schickt es in den
 * Direktchat (mit Telegram mit Knöpfen, sonst für die WebUI festgehalten).
 * Entschieden und gehandelt wird nur im Bot; der Wrapper ändert nie eine
 * Routine. Übernimmt die .env wie outboxAlertSender erst beim Versand.
 *
 * Zeitlimit: offerMenu wird abgebrochen (AbortSignal). Hat der Versand noch
 * nicht begonnen (Katalog oder Register hängen), legt offerMenu danach nichts
 * mehr an und sendet nichts, schon Angelegtes läuft ab; Ergebnis "failed",
 * die Meldung geht ohne Knöpfe. Ist der Versand schon unterwegs, wartet der
 * Wrapper die Nachfrist auf dessen Ergebnis; kommt keins, läuft das Menü ab
 * (seine Knöpfe gelten nicht mehr, keine verwaiste offene Frage) und das
 * Ergebnis ist "unknown": kein zweiter Versand ohne Knöpfe hinterher.
 */
export function wrapperMenuOffer(root: string, dotenv: Record<string, string>, overrides: WrapperMenuDeps = {}): (id: string, text: string) => Promise<OfferOutcome> {
  return async (id, text) => {
    for (const [key, value] of Object.entries(dotenv)) process.env[key] = value;
    process.env.GO_PROJECT_ROOT ??= root;
    const [{ expireChoice, useChoicesFileIn }, { createRoutineChoices }, { sendChoice }, { defaultOutboxDeps, sendAndRecord }, { dmChatId, telegramConfigured }, { defaultRoutinesDeps }] =
      await Promise.all([
        import("./lib/choices"),
        import("./lib/routine-choices"),
        import("./lib/telegram-choices"),
        import("./lib/outbox"),
        import("./lib/channels"),
        import("./lib/routines/catalog"),
      ]);
    useChoicesFileIn(root);
    const conversation = routineConversation(dmChatId(process.env));
    if (!conversation) return { status: "none" };
    const send = overrides.send ?? (input => sendAndRecord(input, defaultOutboxDeps(process.env)));
    const choices = createRoutineChoices({
      routines: overrides.routines ?? defaultRoutinesDeps(root, process.env),
      sendChoice: choice =>
        sendChoice(choice, {
          send,
          telegram: () => telegramConfigured(process.env),
          // Wird die Frage entschieden, bevor die Nachricht gemerkt ist, zieht der Callback-Handler
          // des Bots die Knöpfe beim nächsten Klick nach; der Wrapper hat keinen Bot dafür
          refresh: async () => {},
        }),
      // Ergebnisse meldet nur der Bot (Handler), der Wrapper handelt nie
      notify: async () => {},
    });
    const setTimer = overrides.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = overrides.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>));
    const TIMEOUT = Symbol("Zeitlimit");
    const within = async <T>(work: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> => {
      let timer: unknown;
      const limit = new Promise<typeof TIMEOUT>(resolve => {
        timer = setTimer(() => resolve(TIMEOUT), ms);
      });
      try {
        return await Promise.race([work, limit]);
      } finally {
        clearTimer(timer);
      }
    };
    const controller = new AbortController();
    const flight: { choice?: Choice } = {};
    const offer = choices.offerMenu(conversation, id, text, { signal: controller.signal, onDeliver: c => void (flight.choice = c) });
    const first = await within(offer, SEND_LIMIT_MS);
    if (first !== TIMEOUT) return first;
    controller.abort();
    // Noch nicht unterwegs: offerMenu hört am nächsten Prüfpunkt auf, nichts bleibt offen
    if (!flight.choice) {
      offer.catch(() => {});
      return { status: "failed" };
    }
    const second = await within(offer, MENU_GRACE_MS);
    if (second !== TIMEOUT) return second;
    offer.catch(() => {});
    await expireChoice(flight.choice.id).catch(() => {});
    return { status: "unknown" };
  };
}

async function runCommandQuiet(cmd: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { ok: code === 0, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Meldungen für den echten Aufruf. ROUTINE_ALERTS=off (Umgebung oder .env):
 * enabled false, es wird nichts gesendet, alerts.json aber weiter mit dem
 * Lauf abgeglichen (alerts.ts).
 */
export function cliAlerts(root: string, processEnv: Record<string, string | undefined> = process.env): RunAlertDeps & { store: AlertsStore } {
  const dotenv = readProjectDotenv(root);
  const home = processEnv.HOME || homedir();
  return {
    enabled: alertsEnabled(processEnv) && alertsEnabled(dotenv.env),
    store: fileAlertsStore(root),
    // Fehler und Ausgeblieben mit Knöpfen (Issue #288), sonst wie bisher
    send: menuAlertSender(outboxAlertSender(root, dotenv.env), wrapperMenuOffer(root, dotenv.env), undefined, () =>
      routineChannel(routineConversation(dmChatId({ ...process.env, ...dotenv.env })))
    ),
    now: () => Date.now(),
    pid: process.pid,
    home,
    logPath: id => plistLogPath(id, { home, platform: process.platform, run: runCommandQuiet }),
  };
}

async function main(): Promise<void> {
  const parsed = parseWrapperArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(EXIT_USAGE);
  }
  const root = wrapperRoot();
  if (!idAllowedInRoot(parsed.id, root)) {
    process.stderr.write(`routine-run: „${parsed.id}" ist keine Routine (erlaubt: ai.tybo.<name> oder ein Eintrag aus config/routines.json). Nichts gestartet.\n`);
    process.exit(EXIT_USAGE);
  }
  let secrets: SecretValue[] | null;
  try {
    secrets = projectSecretsOrThrow(root, process.env);
  } catch (e) {
    process.stderr.write(`routine-run: .env nicht lesbar, Ausgabe wird nicht festgehalten: ${e instanceof Error ? e.message : String(e)}\n`);
    secrets = null;
  }
  const result = await runWrapped({ id: parsed.id, command: parsed.command, root, secrets, forwardSignals: true, alerts: cliAlerts(root) });
  if (result.childSignal) {
    // Wie der Befehl enden: dasselbe Signal mit der Standard-Behandlung
    process.removeAllListeners(result.childSignal);
    process.kill(process.pid, result.childSignal);
    setTimeout(() => process.exit(result.exitCode), 1_000);
    return;
  }
  process.exitCode = result.exitCode;
}

if (import.meta.main) await main();
