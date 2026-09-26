#!/usr/bin/env bun
/**
 * Meldung oder Datei an Telegram schicken und für die WebUI festhalten
 * (Entscheidung 0006, src/lib/outbox.ts).
 *
 *   bun run notify --source pipeline --text "Issue 45 gemergt"
 *   bun run notify --source datei --file tmp/report.html --caption "Report"
 *   bun run notify --source watcher --topic 443 --text "Neue Folge"
 *
 * Mit --topic geht es in dieses Topic der Forum-Gruppe (1 ist General), die
 * Umgebung zählt dann nicht. Ohne --topic gilt das Gespräch aus der Umgebung,
 * die tybo seinen Claude-Subprozessen mitgibt (Issue #46): TYBO_TOPIC_ID
 * als Topic, TYBO_CHAT_ID als Chat; sind beide nicht gesetzt, der Direktchat. Ungültige Werte dort ergeben Exit 2 ohne Versand, nie den
 * Direktchat. Exit-Code: 0 gesendet (auch wenn das Festhalten scheiterte),
 * 1 Telegram hat abgelehnt, 2 falsche Eingabe.
 */

import { loadEnv } from "../src/lib/env";
import { defaultOutboxDeps, sendAndRecord, type OutboxDeps, type SendAndRecordInput } from "../src/lib/outbox";

export const EXIT_OK = 0;
export const EXIT_SEND_FAILED = 1;
export const EXIT_USAGE = 2;

export const USAGE = `Aufruf: bun run notify --source <name> [--text <text>] [--file <pfad>] [--caption <text>] [--topic <thread-id>] [--plain] [--no-preview]
  --source      Absender, z. B. pipeline, briefing, checkin, watchdog, watcher, datei (Pflicht)
  --text        Meldung (Markdown, wird wie gewohnt formatiert)
  --file        Datei, höchstens 50 MB
  --caption     Beschriftung der Datei, höchstens 1024 Zeichen
  --topic       Topic der Forum-Gruppe (1 = General); ohne: Gespräch aus
                TYBO_TOPIC_ID/TYBO_CHAT_ID, sonst Direktchat
  --plain       Text unverändert als Klartext senden, ohne Formatierung
  --no-preview  Keine Link-Vorschau
Werte, die mit -- beginnen, als --text=<wert> übergeben.`;

const FLAGS = new Set(["text", "file", "caption", "topic", "source"]);
/** Schalter ohne Wert */
const SWITCHES = new Set(["plain", "no-preview"]);

/** Liest die Argumente; Fehlertext statt Exception. */
export function parseNotifyArgs(argv: string[]): { input: SendAndRecordInput } | { help: true } | { error: string } {
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!arg.startsWith("--")) return { error: `Unbekanntes Argument: ${arg}` };
    const eq = arg.indexOf("=");
    const flag = arg.slice(2, eq === -1 ? undefined : eq);
    if (SWITCHES.has(flag)) {
      if (eq !== -1) return { error: `--${flag} hat keinen Wert` };
      if (switches.has(flag)) return { error: `--${flag} doppelt angegeben` };
      switches.add(flag);
      continue;
    }
    if (!FLAGS.has(flag)) return { error: `Unbekannte Option: --${flag}` };
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
  if (!values.source) return { error: "--source fehlt" };
  if (values.text === undefined && values.file === undefined) return { error: "--text oder --file angeben" };
  const input: SendAndRecordInput = { source: values.source };
  if (values.text !== undefined) input.text = values.text;
  if (values.file !== undefined) input.file = values.file;
  if (values.caption !== undefined) input.caption = values.caption;
  if (switches.has("plain")) input.format = "plain";
  if (switches.has("no-preview")) input.linkPreview = false;
  if (values.topic !== undefined) {
    if (!/^[1-9]\d{0,9}$/.test(values.topic)) return { error: "--topic muss eine positive ganze Zahl sein" };
    input.topicId = Number(values.topic);
  }
  return { input };
}

const TOPIC_PATTERN = /^[1-9]\d{0,9}$/;
const CHAT_PATTERN = /^-?\d{1,20}$/;

/**
 * Ergänzt das Ziel aus der Umgebung, wenn --topic fehlt. Gesetzte, aber
 * leere oder ungültige Werte sind ein Fehler. Sind Chat und Topic gesetzt,
 * gehen beide an die Zielprüfung von sendAndRecord (ein fremder Chat wird
 * dort abgelehnt, nicht vom Topic überdeckt).
 */
export function applyEnvTarget(
  input: SendAndRecordInput,
  env: Record<string, string | undefined>
): { input: SendAndRecordInput } | { error: string } {
  if (input.topicId !== undefined) return { input };
  const topic = env.TYBO_TOPIC_ID;
  const chat = env.TYBO_CHAT_ID;
  const result: SendAndRecordInput = { ...input };
  if (topic !== undefined) {
    if (!TOPIC_PATTERN.test(topic)) return { error: "TYBO_TOPIC_ID ist ungültig (positive ganze Zahl erwartet)" };
    result.topicId = Number(topic);
  }
  if (chat !== undefined) {
    if (!CHAT_PATTERN.test(chat)) return { error: "TYBO_CHAT_ID ist ungültig (Chat-ID erwartet)" };
    result.chatId = chat;
  }
  return { input: result };
}

export interface NotifyIo {
  out(line: string): void;
  err(line: string): void;
}

const consoleIo: NotifyIo = { out: line => console.log(line), err: line => console.error(line) };

/** Führt den Aufruf aus und gibt den Exit-Code zurück. */
export async function runNotify(
  argv: string[],
  deps: () => OutboxDeps = defaultOutboxDeps,
  io: NotifyIo = consoleIo,
  env: Record<string, string | undefined> = process.env
): Promise<number> {
  const parsed = parseNotifyArgs(argv);
  if ("help" in parsed) {
    io.out(USAGE);
    return EXIT_OK;
  }
  if ("error" in parsed) {
    io.err(`${parsed.error}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const targeted = applyEnvTarget(parsed.input, env);
  if ("error" in targeted) {
    io.err(`Nicht gesendet: ${targeted.error}`);
    return EXIT_USAGE;
  }
  const result = await sendAndRecord(targeted.input, deps());
  if (result.error) {
    io.err(`Nicht gesendet: ${result.error.message}`);
    return result.error.kind === "send" ? EXIT_SEND_FAILED : EXIT_USAGE;
  }
  io.out(result.recorded ? "Gesendet und für die WebUI festgehalten." : "Gesendet, aber nicht festgehalten (siehe Log).");
  return EXIT_OK;
}

if (import.meta.main) {
  await loadEnv();
  process.exit(await runNotify(process.argv.slice(2)));
}
