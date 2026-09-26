/**
 * Abschlussmeldung eines Hintergrund-Jobs (Issue #103).
 *
 * Genau eine logische Meldung pro Job: Nur wer den Übergang nach ended
 * gewonnen hat (claimOutcome in ./store), ist Besitzer der Meldung und ruft
 * deliverNotice (bzw. settleAndDeliver, wenn vorher noch Claudes
 * Prozessgruppe zu beenden ist). Die Meldung ist ein einziger
 * sendAndRecord-Aufruf; Bericht und Log-Auszug sind so gekürzt, dass die
 * gesendete Darstellung (Markdown als HTML, mit &amp; und Co.) in eine
 * Telegram-Nachricht passt. So zerfällt sie nie in Stücke, und eine
 * Wiederholung kann kein schon gesendetes Stück doppelt schicken.
 *
 * Zustellung:
 * - Telegram nimmt an (sent): erledigt. Scheitert nur das Festhalten für die
 *   WebUI (recorded false), wird nicht wiederholt, sonst käme die Meldung in
 *   Telegram doppelt; ins Wächter-Log kommt ein Hinweis.
 * - Versandfehler (error.kind "send"): bis zu drei Versuche mit Pause.
 * - Abgelehnt (error.kind "invalid", etwa fehlendes Topic): keine
 *   Wiederholung, Zustand failed.
 * - Stirbt der Besitzer mitten drin (Zustand pending oder sending), übernimmt
 *   recoverJobs beim nächsten Bot-Start und sendet. Bei sending ist offen, ob
 *   Telegram die Meldung schon hatte; dann lieber doppelt als gar nicht.
 *
 * Alles, was gesendet wird, geht vorher durch maskSecrets, ebenso jede
 * Zeile fürs Log (logSafe) und jeder festgehaltene Fehlertext. Weil jede
 * spätere Darstellung Zeichen entfernt (Markdown-Zeichen, Steuer-Tags wie
 * [REMEMBER:], Link-Adressen, unsichtbare Zeichen, Zeichenreferenzen), prüft
 * composeNotice zusätzlich den sichtbaren Text der fertigen Meldung in allen
 * Darstellungen (noticeViews): Telegram, WebUI (HTML und Kopiertext) und
 * tybo im Terminal.
 */

import { readFile } from "node:fs/promises";
import { Parser } from "htmlparser2";
import type { SendAndRecordInput, SendAndRecordResult } from "../outbox";
import { markdownToTelegramHTML, sanitizeTelegramText, stripHtmlTags } from "../telegram";
import { createStyle, renderTerminalMarkdown } from "../../terminal/render";
import { renderMarkdown, stripControlTags } from "../../web/markdown";
import { MASK, maskSecrets, type SecretValue } from "./mask";
import { processGone, terminateGroup, type ProcessOps, type TerminateResult } from "./process";
import { jobFile, readStatus, recordTermination, updateStatus, type JobStatus, type ProcRef } from "./store";

export const NOTICE_SOURCE = "job";
export const REPORT_MAX_CHARS = 2_500;
export const LOG_TAIL_LINES = 20;
const LOG_TAIL_MAX_CHARS = 1_800;
const LOG_LINE_MAX_CHARS = 300;
const TITLE_MAX_CHARS = 200;
const DETAIL_MAX_CHARS = 500;
/** Länge der gesendeten Darstellung, ab der sendAndRecord aufteilt (chunkForTelegram) */
export const NOTICE_MAX_RENDERED = 4_000;
/** Pausen vor dem 2. und 3. Versuch */
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000];

export interface NoticeDeps {
  root: string;
  proc: ProcessOps;
  notify(input: SendAndRecordInput): Promise<SendAndRecordResult>;
  /** Werte, die nie in einer Meldung oder einem Log stehen dürfen (./mask secretValues) */
  secrets(): readonly SecretValue[];
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  retryDelaysMs?: readonly number[];
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "unter 1 Min";
  if (minutes < 60) return `${minutes} Min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} Std ${rest} Min` : `${hours} Std`;
}

/** Log-Zeile ohne Werte aus .env (Fehlertexte können sie enthalten) */
export function logSafe(deps: Pick<NoticeDeps, "log" | "secrets">, line: string): void {
  deps.log(maskSecrets(line, deps.secrets()));
}

/** Dauer von Start (oder Anlage) bis Ende (oder jetzt) */
export function jobDuration(status: JobStatus, now: Date): string {
  const from = Date.parse(status.startedAt ?? status.createdAt);
  const to = status.endedAt ? Date.parse(status.endedAt) : now.getTime();
  return formatDuration(to - from);
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Letzte Log-Zeilen, erst maskiert, dann gekürzt (sonst bliebe ein abgeschnittenes Geheimnis stehen) */
export function logTail(log: string, secrets: readonly SecretValue[], lines = LOG_TAIL_LINES, maxChars = LOG_TAIL_MAX_CHARS): string {
  const masked = maskSecrets(log, secrets);
  const all = masked.replace(/\r\n?/g, "\n").split("\n");
  while (all.length && all[all.length - 1].trim() === "") all.pop();
  let tail = all
    .slice(-lines)
    .map(l => (l.length > LOG_LINE_MAX_CHARS ? `${l.slice(0, LOG_LINE_MAX_CHARS - 1)}…` : l))
    .join("\n");
  if (tail.length > maxChars) tail = maxChars > 1 ? `…${tail.slice(-(maxChars - 1))}` : "";
  // Kein Ausbruch aus dem Code-Block
  return tail.replace(/```/g, "'''");
}

function codeBlock(text: string): string {
  // Sprache „log": kein Tabellen-Umbau (asciiTableToList), der Inhalt bleibt wörtlich
  return text ? `\`\`\`log\n${text}\n\`\`\`` : "_(Log ist leer)_";
}

const EXIT_TEXT = (status: JobStatus) =>
  status.signal ? `beendet durch Signal ${status.signal}` : `Exit-Code ${status.exitCode ?? "unbekannt"}`;

/** Passt die gesendete Darstellung (HTML) in eine Telegram-Nachricht? */
export function noticeFits(text: string): boolean {
  return markdownToTelegramHTML(text).length <= NOTICE_MAX_RENDERED;
}

function terminationWarning(status: JobStatus): string {
  const result = status.termination?.result;
  if (result !== "survived" && result !== "unverified") return "";
  return `\n\nAchtung: Claudes Prozessgruppe (PID ${status.claude?.pid ?? "unbekannt"}) ließ sich nicht sicher beenden, bitte prüfen.`;
}

/** Inhaltsteile einer Meldung, die aus dem Job stammen */
type Part = "title" | "detail" | "report" | "log";
const PARTS: readonly Part[] = ["title", "detail", "report", "log"];
/** Markierungen aus dem Privatbereich von Unicode, je Teil (bzw. Wert) Anfang und Ende */
const markStartAt = (i: number) => String.fromCharCode(0xe000 + 2 * i);
const markEndAt = (i: number) => String.fromCharCode(0xe001 + 2 * i);
const markStart = (part: Part) => markStartAt(PARTS.indexOf(part));
const markEnd = (part: Part) => markEndAt(PARTS.indexOf(part));
const MARKS = /[-]/g;
const SEPARATOR = "";
/** So viele Werte lassen sich mit eigenen Markierungen prüfen (SEPARATOR ausgenommen) */
const MAX_MARKED = (0xf8ff - 0xe000) >> 1;

/** Was Telegram von einer Markdown-Meldung zeigt (wie sendAndRecord und der Rückfall ohne HTML) */
export function visibleNoticeText(markdown: string): string {
  return stripHtmlTags(sanitizeTelegramText(markdownToTelegramHTML(markdown), true));
}

/**
 * Was ein Browser aus dem HTML macht: sichtbarer Text und Text mit den
 * Attributwerten an Stelle der Tags. Der HTML-Parser dekodiert alle
 * Zeichenreferenzen wie der Browser (auch &plus; oder &sol;).
 */
function browserViews(html: string): [string, string] {
  let text = "";
  let withAttributes = "";
  const parser = new Parser({
    ontext: t => {
      text += t;
      withAttributes += t;
    },
    onopentag: (_name, attributes) => {
      withAttributes += Object.values(attributes).join(SEPARATOR);
    },
  });
  parser.write(html);
  parser.end();
  return [text, withAttributes];
}

const TERMINAL_STYLE = createStyle(false);

/**
 * Sichtbarer Text der Meldung in jeder Darstellung, die sie später bekommt:
 * Telegram; WebUI als HTML (renderMarkdown, Text und Attributwerte wie
 * Link-Adressen); Kopiertext der WebUI (stripControlTags); tybo im
 * Terminal (ohne Farben, die zerteilten dort nichts Sichtbares).
 */
export function noticeViews(markdown: string): string[] {
  const copy = stripControlTags(markdown);
  return [visibleNoticeText(markdown), ...browserViews(renderMarkdown(markdown)), copy, renderTerminalMarkdown(copy, TERMINAL_STYLE)];
}

/** Wie oft Werte im Text stehen; [verborgen] zählt als Trenner */
function secretHits(text: string, secrets: readonly SecretValue[]): number {
  const clean = text.replace(MARKS, SEPARATOR).split(MASK).join(SEPARATOR);
  let hits = 0;
  for (const v of secrets) if (v !== "") hits += clean.split(v).length - 1;
  return hits;
}

/**
 * Teile, die nach einer späteren Darstellung einen Wert zeigen würden. Jeder
 * Teil steht zwischen zwei Markierungen; fehlt eine in einer Darstellung
 * (etwa weil sie in einer Link-Adresse oder einem Steuer-Tag landete), gilt
 * der Teil ebenfalls als unsicher.
 */
function hiddenParts(marked: string, used: readonly Part[], secrets: readonly SecretValue[]): Part[] {
  const views = noticeViews(marked);
  return used.filter(part => views.some(visible => leaksBetween(visible, markStart(part), markEnd(part), secrets)));
}

/** Zeigt der Text zwischen den Markierungen einen Wert, oder fehlt bzw. verdoppelt sich eine Markierung? */
function leaksBetween(visible: string, start: string, end: string, secrets: readonly SecretValue[]): boolean {
  const a = visible.indexOf(start);
  const b = visible.indexOf(end);
  if (a < 0 || b < a || visible.indexOf(start, a + 1) >= 0 || visible.indexOf(end, b + 1) >= 0) return true;
  return secretHits(visible.slice(a + 1, b), secrets) > 0;
}

/**
 * Werte aus einem Job (etwa die Titel in /jobs), eingesetzt in einen Text,
 * den später Telegram, die WebUI oder tybo darstellen: jeder Wert maskiert,
 * und ganz verborgen ([verborgen]), wenn eine Darstellung des fertigen
 * Textes (noticeViews) trotzdem einen Wert zeigen würde, etwa weil die WebUI
 * einen Steuer-Tag oder Markdown-Zeichen entfernt. render baut den Text aus
 * den Werten; das Ergebnis sind die Werte, die render bekommen darf.
 */
export function safeValues(raw: readonly string[], render: (values: readonly string[]) => string, secrets: readonly SecretValue[]): string[] {
  const values = raw.map(v => maskSecrets(v.replace(MARKS, ""), secrets));
  // Ohne eigene Markierung nicht prüfbar, also verborgen
  const hidden = new Set<number>(values.map((_, i) => i).filter(i => i >= MAX_MARKED));
  const shown = (fill: (v: string, i: number) => string) => values.map((v, i) => (hidden.has(i) ? MASK : fill(v, i)));
  for (;;) {
    const views = noticeViews(render(shown((v, i) => `${markStartAt(i)}${v}${markEndAt(i)}`)));
    const leaks = values.map((_, i) => i).filter(i => !hidden.has(i) && views.some(view => leaksBetween(view, markStartAt(i), markEndAt(i), secrets)));
    for (const i of leaks) hidden.add(i);
    if (leaks.length) continue;
    // Gegenprobe ohne Markierungen, wie in composeNotice: zeigt eine Darstellung
    // mehr Werte als derselbe Text ohne Inhalt, erst die Verursacher einzeln
    // suchen, sonst alles verbergen
    const baseViews = noticeViews(render(shown(() => "")));
    const more = (only?: number) =>
      noticeViews(render(shown((v, i) => (only === undefined || i === only ? v : "")))).some(
        (view, k) => secretHits(view, secrets) > secretHits(baseViews[k], secrets),
      );
    if (!more()) return shown(v => v);
    const culprits = values.map((_, i) => i).filter(i => !hidden.has(i) && more(i));
    for (const i of culprits.length ? culprits : values.keys()) hidden.add(i);
  }
}

/**
 * Meldungstext, schon maskiert. Bericht bzw. Log-Auszug werden so weit
 * gekürzt, bis die gesendete Darstellung in eine Nachricht passt. Würde ein
 * Teil erst nach der Umwandlung für Telegram einen Wert zeigen (etwa
 * „ab**cd**" mit dem Wert abcd), wird er ganz verborgen.
 */
export async function composeNotice(root: string, status: JobStatus, secrets: readonly SecretValue[], now: Date): Promise<string> {
  // Markierungen im Inhalt entfernen, bevor maskiert wird (danach entfernte Zeichen könnten Werte zusammensetzen)
  const content = (text: string) => maskSecrets(text.replace(MARKS, ""), secrets);
  const title = oneLine(content(status.title), TITLE_MAX_CHARS);
  const duration = jobDuration(status, now);
  const detail = status.detail ? oneLine(content(status.detail), DETAIL_MAX_CHARS) : "";
  const warning = terminationWarning(status);
  const needsLog = ["no_report", "failed", "timeout", "aborted"].includes(status.outcome ?? "");
  const log = needsLog ? (await readFile(jobFile(root, status.id, "log"), "utf8").catch(() => "")).replace(MARKS, "") : "";
  const report = status.outcome === "success" ? content((await readFile(jobFile(root, status.id, "report"), "utf8").catch(() => "")).trim()) : "";
  const reportPath = `data/jobs/${status.id}/report.md`;
  const hiddenText: Record<Part, string> = {
    title: MASK,
    detail: MASK,
    report: `_Bericht verborgen: er hätte in Telegram oder der WebUI einen Wert aus .env gezeigt. Ganzer Bericht: ${reportPath}_`,
    log: "_Log-Auszug verborgen: er hätte in Telegram oder der WebUI einen Wert aus .env gezeigt, siehe job log_",
  };

  // marked: Teile mit Markierungen (nur zur Prüfung); empty: Teile ohne Inhalt (Vergleichsgrundlage)
  const build = (budget: number, hidden: ReadonlySet<Part>, marked: boolean, empty = false): { text: string; used: Part[] } => {
    const used: Part[] = [];
    // Teil mit Markierungen (nur zur Prüfung) oder, wenn verborgen, durch einen Hinweis ersetzt
    const part = (name: Part, text: string, lead = ""): string => {
      if (hidden.has(name)) return `${lead}${hiddenText[name]}`;
      if (empty) return (used.push(name), lead);
      if (!marked) return `${lead}${text}`;
      used.push(name);
      // Anfang vor dem Absatz: Markdown am Zeilenanfang (# Titel, > Zitat) wirkt wie ohne Markierung
      return `${markStart(name)}${lead}${text}${lead ? "\n" : ""}${markEnd(name)}`;
    };
    const head = (label: string) => `**${label}: ${part("title", title)}** (${duration}, Job ${status.id})`;
    const why = (fallback: string) => (detail ? part("detail", detail, "\n\n") : `\n\n${fallback}`);
    const tail = () => {
      if (budget <= 0) return "_(Log-Auszug zu lang, siehe job log)_";
      const text = logTail(log, secrets, LOG_TAIL_LINES, Math.min(budget, LOG_TAIL_MAX_CHARS));
      if (!text) return codeBlock("");
      if (hidden.has("log")) return hiddenText.log;
      if (empty) return (used.push("log"), codeBlock(" "));
      // Im Code-Block wirkt nichts am Zeilenanfang, die Markierungen stehen direkt am Inhalt
      return codeBlock(marked ? (used.push("log"), `${markStart("log")}${text}${markEnd("log")}`) : text);
    };
    let text: string;
    switch (status.outcome) {
      case "success": {
        let body = part("report", report, "\n\n");
        if (report.length > budget) {
          body =
            budget > 0
              ? `${part("report", report.slice(0, budget), "\n\n")}…\n\n_Gekürzt, ganzer Bericht: ${reportPath}_`
              : `\n\n_Bericht zu lang, ganzer Bericht: ${reportPath}_`;
        }
        text = `${head("Job fertig")}${body}`;
        break;
      }
      case "no_report":
        text = `${head("Job ohne Bericht")}\n\nClaude endete mit Exit-Code 0, hat aber keinen Bericht geschrieben. Letzte Log-Zeilen:\n\n${tail()}`;
        break;
      case "failed":
        text = `${head("Job fehlgeschlagen")}\n\n${EXIT_TEXT(status)}. Letzte Log-Zeilen:\n\n${tail()}`;
        break;
      case "timeout":
        text = `${head("Job abgebrochen, Zeit überschritten")}\n\nNach ${status.maxHours} Std beendet.${warning} Letzte Log-Zeilen:\n\n${tail()}`;
        break;
      case "stopped":
        text = `${head("Job gestoppt")}\n\nAuf Anfrage beendet (job stop).${warning}`;
        break;
      case "aborted":
        text = `${head("Job abgebrochen")}${why("Der Wächter lief nicht mehr.")}${warning} Letzte Log-Zeilen:\n\n${tail()}`;
        break;
      case "start_failed":
        text = `${head("Job nicht gestartet")}${why("Der Start ist gescheitert.")}`;
        break;
      default:
        text = head("Job beendet");
    }
    return { text, used };
  };

  // Stark maskierter Inhalt (&, <, >) wird beim Umwandeln bis zu fünfmal so lang
  const hidden = new Set<Part>();
  for (;;) {
    let budget = REPORT_MAX_CHARS;
    while (budget > 0 && !noticeFits(build(budget, hidden, false).text)) budget = Math.floor(budget * 0.6);
    const check = build(budget, hidden, true);
    const leaks = hiddenParts(check.text, check.used, secrets);
    for (const part of leaks) hidden.add(part);
    if (leaks.length) continue;
    // Gegenprobe ohne Markierungen: sie können Markdown anders wirken lassen
    // (etwa __ neben einer Markierung). Zeigt eine Darstellung mehr Werte als
    // dieselbe Meldung ohne Inhalt der Teile, werden alle Teile verborgen.
    const text = build(budget, hidden, false).text;
    const base = build(budget, hidden, false, true);
    const baseViews = noticeViews(base.text);
    const more = noticeViews(text).some((view, i) => secretHits(view, secrets) > secretHits(baseViews[i], secrets));
    if (!more || !base.used.length) return text;
    for (const part of base.used) hidden.add(part);
  }
}

function targetInput(status: JobStatus, text: string): SendAndRecordInput {
  const input: SendAndRecordInput = { source: NOTICE_SOURCE, text };
  if (status.target.topicId !== undefined) input.topicId = status.target.topicId;
  if (status.target.chatId !== undefined) input.chatId = status.target.chatId;
  return input;
}

export type DeliverResult = "sent" | "failed" | "not_owner";

/**
 * Schickt die Meldung, wenn owner (Token aus claimOutcome oder takeOverNotice)
 * noch ihr Besitzer ist. Jeder Versuch wird vorher als sending vermerkt.
 */
export async function deliverNotice(id: string, token: string, deps: NoticeDeps): Promise<DeliverResult> {
  const { root } = deps;
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const maxAttempts = delays.length + 1;
  const status = await readStatus(root, id);
  if (!status || status.notice?.owner?.token !== token) return "not_owner";
  const secrets = deps.secrets();
  const text = await composeNotice(root, status, secrets, deps.now());

  for (;;) {
    const begin = await updateStatus(root, id, s => {
      const n = s.notice;
      if (!n || n.owner?.token !== token || (n.state !== "pending" && n.state !== "sending")) return null;
      n.state = "sending";
      n.attempts += 1;
      return s;
    });
    if (!begin.changed) return "not_owner";
    const attempt = begin.status!.notice!.attempts;

    let result: SendAndRecordResult;
    try {
      result = await deps.notify(targetInput(status, text));
    } catch (e) {
      result = { sent: false, recorded: false, error: { kind: "send", message: e instanceof Error ? e.name : "Fehler" } };
    }

    const retry = !result.sent && result.error?.kind !== "invalid" && attempt < maxAttempts;
    await updateStatus(root, id, s => {
      const n = s.notice;
      if (!n || n.owner?.token !== token) return null;
      n.at = deps.now().toISOString();
      if (result.sent) {
        n.state = "sent";
        n.recorded = result.recorded;
        delete n.error;
      } else {
        n.state = retry ? "pending" : "failed";
        n.error = maskSecrets(result.error?.message ?? "unbekannt", secrets);
      }
      return s;
    });
    if (result.sent) {
      if (!result.recorded) logSafe(deps, `[job] ${id}: Meldung gesendet, aber nicht für die WebUI festgehalten`);
      return "sent";
    }
    logSafe(deps, `[job] ${id}: Meldung nicht zugestellt (Versuch ${attempt}/${maxAttempts}: ${result.error?.message ?? "unbekannt"})`);
    if (!retry) return "failed";
    await deps.sleep(delays[attempt - 1] ?? 0);
  }
}

/**
 * Übernimmt eine liegengebliebene Meldung (pending oder sending), deren
 * Besitzer sicher nicht mehr lebt. Lebt seine PID und ist nur die Startzeit
 * gerade nicht prüfbar, bleibt die Meldung bei ihm (sonst käme sie doppelt).
 * Gibt das neue Token zurück oder null.
 */
export async function takeOverNotice(id: string, me: ProcRef, deps: Pick<NoticeDeps, "root" | "proc">): Promise<string | null> {
  const token = crypto.randomUUID();
  const result = await updateStatus(deps.root, id, s => {
    const n = s.notice;
    if (s.phase !== "ended" || !n || (n.state !== "pending" && n.state !== "sending")) return null;
    if (!processGone(n.owner, deps.proc)) return null;
    // Ein unterbrochener Versuch zählt; weiter geht es mit einem frischen Durchlauf
    n.state = "pending";
    n.attempts = 0;
    n.owner = { ...me, token };
    return s;
  });
  return result.changed ? token : null;
}

/**
 * Für den Besitzer der Meldung (token): erst eine noch ausstehende
 * Beendigung von Claudes Prozessgruppe erledigen und festhalten, dann
 * melden. So meldet niemand „gestoppt", solange der Prozess womöglich noch
 * läuft, auch nicht recoverJobs nach dem Tod des ursprünglichen Gewinners.
 */
export async function settleAndDeliver(
  id: string,
  token: string,
  deps: NoticeDeps,
): Promise<{ tree?: TerminateResult; delivered: DeliverResult }> {
  const status = await readStatus(deps.root, id);
  if (!status || status.notice?.owner?.token !== token) return { delivered: "not_owner" };
  let tree = status.termination?.result;
  if (status.termination?.state === "pending" && status.claude) {
    tree = await terminateGroup(status.claude, deps.proc);
    if (tree !== "gone") logSafe(deps, `[job] ${id}: Prozessgruppe beim Beenden: ${tree}`);
    if (!(await recordTermination(deps.root, id, token, tree))) return { tree, delivered: "not_owner" };
  }
  return { tree, delivered: await deliverNotice(id, token, deps) };
}
